// Round 2 fixes for staff sign-in and accounts: known browsers, form tokens, step-up keys, enforcement,
// readers' admin pages and the CSV export. In-process, no network. Run: node --test test/fix2-admin-auth.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/web/app.js";
import { can } from "../src/web/admin.js";
import { codeAt, stepAt } from "../src/web/totp.js";

const A = "/admin";
const PW = "correct horse battery";

function jar() {
  const cookies = new Map();
  return {
    cookies,
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    store(res) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        const k = pair.slice(0, i);
        const v = pair.slice(i + 1);
        if (!v || /max-age=0/i.test(c)) cookies.delete(k);
        else cookies.set(k, v);
      }
    },
  };
}

let ipCounter = 0;
const freshIp = () => `10.2.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function makeApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-fix2-auth-"));
  const { app, ctx } = createApp({ dataDir, production: true, outbound: false, mailTransport: { jsonTransport: true }, mailDelayMs: 0, setupToken: "test-setup", trustProxy: true });
  const t = {
    app,
    ctx,
    dataDir,
    async req(j, p, { method = "GET", form, headers = {} } = {}) {
      const h = { origin: "http://localhost", cookie: j.header(), "x-forwarded-for": j.ip || "198.51.100.1", ...headers };
      let body;
      if (form) {
        body = new URLSearchParams(form);
        h["content-type"] = "application/x-www-form-urlencoded";
      }
      const res = await app.request(`http://localhost${p}`, { method, headers: h, body, redirect: "manual" });
      j.store(res);
      return res;
    },
    newJar(ip = freshIp()) {
      const j = jar();
      j.ip = ip;
      return j;
    },
  };
  t.field = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];
  t.csrfOf = (html) => (html.match(/data-csrf="([^"]+)"/) || [])[1];
  t.login = async (j, email, password, next = "") => {
    const token = t.field(await (await t.req(j, `${A}/login`)).text(), "_csrf");
    return t.req(j, `${A}/login`, { method: "POST", form: { _csrf: token, email, password, next } });
  };
  t.signIn = async (email, password = PW, ip = freshIp()) => {
    const j = t.newJar(ip);
    const res = await t.login(j, email, password);
    assert.equal(res.status, 302, `sign in ${email}: ${res.status}`);
    const page = await t.req(j, `${A}/users/${t.ctx.store.users.getByEmail(email).id}`);
    return { j, csrf: t.csrfOf(await page.text()), res };
  };
  t.post = (s, p, form) => t.req(s.j, p, { method: "POST", form: { _csrf: s.csrf, ...form } });
  const j = t.newJar();
  const token = t.field(await (await t.req(j, `${A}/setup`)).text(), "_csrf");
  const res = await t.req(j, `${A}/setup`, { method: "POST", form: { _csrf: token, setup_token: "test-setup", site_title: "Test Blog", site_url: "http://localhost", name: "Olive Owner", email: "owner@example.com", password: PW } });
  assert.equal(res.status, 302, await res.text());
  t.addStaff = async (name, email, role, password = PW) => t.ctx.store.users.create({ name, email, role, password }, { actor: "system" });
  return t;
}

describe("form tokens and cookies", () => {
  test("the sign-in token is <seconds>.<random>.<hmac>, reused on later page views, and rejected when forged or old", async () => {
    const t = await makeApp();
    const j = t.newJar();
    const first = t.field(await (await t.req(j, `${A}/login`)).text(), "_csrf");
    assert.match(first, /^\d+\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    assert.equal(j.cookies.get("lcsrf"), first, "cookie and form value are the same token");
    const second = t.field(await (await t.req(j, `${A}/login`)).text(), "_csrf");
    assert.equal(second, first, "a second tab doesn't replace the cookie");
    const post = (tok) => t.req(j, `${A}/login`, { method: "POST", form: { _csrf: tok, email: "nobody@example.com", password: "wrong wrong wrong" } });
    assert.equal((await post(first)).status, 401, "a good token gets to the password check");
    // Forged mac.
    const parts = first.split(".");
    const forged = `${parts[0]}.${parts[1]}.${"0".repeat(64)}`;
    j.cookies.set("lcsrf", forged);
    assert.match(await (await post(forged)).text(), /form expired/);
    // Old: three hours ago, with a correct mac for that time.
    const ts = Math.floor(Date.now() / 1000) - 3 * 3600;
    const old = `${ts}.abc.${t.ctx.secrets.hmac(`lcsrf:${ts}.abc`)}`;
    j.cookies.set("lcsrf", old);
    assert.match(await (await post(old)).text(), /form expired/);
    // A cookie that differs from the form value fails too.
    j.cookies.set("lcsrf", first);
    assert.match(await (await post(old)).text(), /form expired/);
  });

  test("the next address is resolved before it is checked", async () => {
    const t = await makeApp();
    for (const [next, expected] of [
      [`${A}/../blog/`, `${A}/`],
      [`${A}/%2e%2e/blog/`, `${A}/`],
      [`${A}/posts?state=draft`, `${A}/posts?state=draft`],
      [`${A}/./posts`, `${A}/posts`],
    ]) {
      const res = await t.login(t.newJar(), "owner@example.com", PW, next);
      assert.equal(res.headers.get("location"), expected, next);
    }
  });

  test("admin addresses can't be loaded as pictures or scripts; static files still can", async () => {
    const t = await makeApp();
    const s = await t.signIn("owner@example.com");
    for (const dest of ["image", "script", "style", "font", "video", "object", "embed", "manifest", "audio", "track"]) {
      const res = await t.req(s.j, `${A}/users/1`, { headers: { "sec-fetch-dest": dest } });
      assert.equal(res.status, 403, dest);
    }
    assert.equal((await t.req(s.j, `${A}/users/1`, { headers: { "sec-fetch-dest": "document" } })).status, 200);
    assert.equal((await t.req(s.j, `${A}/static/admin.css`, { headers: { "sec-fetch-dest": "style" } })).status, 200);
  });

  test("static editor files are private-cached, the sign-in files public", async () => {
    const t = await makeApp();
    const s = await t.signIn("owner@example.com");
    const names = Object.keys(t.ctx.assets.get().files);
    assert.match((await t.req(s.j, `${A}/static/admin.css`)).headers.get("cache-control"), /^public/);
    const other = names.find((n) => !["admin.css", "admin.js", "editor.js"].includes(n));
    if (other) assert.match((await t.req(s.j, `${A}/static/${other}`)).headers.get("cache-control"), /^private/);
  });
});

describe("known browsers and the account lock", () => {
  test("strangers can lock the shared account key, but not a browser that signed in before", async () => {
    const t = await makeApp();
    const owner = await t.signIn("owner@example.com");
    assert.ok(owner.j.cookies.get("kd"), "a known-browser cookie is set after sign-in");
    assert.match(owner.j.cookies.get("kd"), /^1\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    for (let i = 0; i < 5; i++) assert.equal((await t.login(t.newJar(), "owner@example.com", "wrong wrong wrong")).status, 401);
    assert.equal((await t.login(t.newJar(), "owner@example.com", PW)).status, 429, "a new browser is refused while strangers hold the key");
    // Same browser, its own key: signs in.
    owner.j.cookies.delete("sid");
    assert.equal((await t.login(owner.j, "owner@example.com", PW)).status, 302);
  });

  test("a password change voids known-browser cookies", async () => {
    const t = await makeApp();
    const owner = await t.signIn("owner@example.com");
    await t.ctx.store.users.setPassword(1, "a brand new password", { actor: "system" });
    for (let i = 0; i < 5; i++) await t.login(t.newJar(), "owner@example.com", "wrong wrong wrong");
    const res = await t.login(owner.j, "owner@example.com", "a brand new password");
    assert.equal(res.status, 429, "the old cookie no longer counts as a known browser");
  });

  test("second step: recovery codes work during the lock, a known browser's codes too, others' codes don't", async () => {
    const t = await makeApp();
    const known = await t.signIn("owner@example.com");
    const secret = "JBSWY3DPEHPK3PXP";
    t.ctx.store.users.enableTwoStep(1, secret, stepAt() - 3);
    const codes = t.ctx.store.users.newRecoveryCodes(1);
    for (let i = 0; i < 5; i++) t.ctx.store.users.recordTotpFailure(1);
    assert.equal(t.ctx.store.users.totpLocked(1), true);
    const verify = async (j, code) => {
      const r = await t.login(j, "owner@example.com", PW);
      assert.equal(r.headers.get("location"), `${A}/login/verify`, "the password step still reaches the code page");
      const tok = t.field(await (await t.req(j, `${A}/login/verify`)).text(), "_csrf");
      return t.req(j, `${A}/login/verify`, { method: "POST", form: { _csrf: tok, code } });
    };
    // A browser that isn't known: authenticator code refused.
    let j = t.newJar();
    assert.equal((await verify(j, codeAt(secret, stepAt()))).status, 429);
    // The same browser can use a recovery code while locked.
    const rec = await verify(j, codes[0]);
    assert.equal(rec.status, 302);
    assert.equal(rec.headers.get("location"), `${A}/account/two-step?ok=recovery`);
    // The known browser isn't held up by the lock.
    known.j.cookies.delete("sid");
    const ok = await verify(known.j, codeAt(secret, stepAt()));
    assert.equal(ok.status, 302, await ok.text());
    assert.ok(known.j.cookies.get("sid"));
  });

  test("a success closes other waiting challenges, and a person has at most 3", async () => {
    const t = await makeApp();
    const secret = "JBSWY3DPEHPK3PXP";
    t.ctx.store.users.enableTwoStep(1, secret, stepAt() - 3);
    const jars = [];
    for (let i = 0; i < 4; i++) {
      const j = t.newJar();
      assert.equal((await t.login(j, "owner@example.com", PW)).headers.get("location"), `${A}/login/verify`);
      jars.push(j);
    }
    // The first of four challenges was pushed out.
    assert.equal((await t.req(jars[0], `${A}/login/verify`)).headers.get("location"), `${A}/login`);
    assert.equal((await t.req(jars[1], `${A}/login/verify`)).status, 200);
    const tok = t.field(await (await t.req(jars[3], `${A}/login/verify`)).text(), "_csrf");
    const ok = await t.req(jars[3], `${A}/login/verify`, { method: "POST", form: { _csrf: tok, code: codeAt(secret, stepAt()) } });
    assert.equal(ok.status, 302);
    assert.equal((await t.req(jars[1], `${A}/login/verify`)).headers.get("location"), `${A}/login`, "the others are gone");
  });

  test("step-up tries are counted per session, so a stolen session can't block the real person", async () => {
    const t = await makeApp();
    const a = await t.signIn("owner@example.com");
    const b = await t.signIn("owner@example.com");
    for (let i = 0; i < 5; i++) {
      const res = await t.post(a, `${A}/users/1/password`, { current_password: "wrong wrong wrong", password: "another long password", password_confirm: "another long password" });
      assert.equal(res.status, 400);
    }
    assert.match(await (await t.post(a, `${A}/users/1/password`, { current_password: PW, password: "another long password", password_confirm: "another long password" })).text(), /Too many wrong tries/);
    const good = await t.post(b, `${A}/users/1/password`, { current_password: PW, password: "another long password", password_confirm: "another long password" });
    assert.equal(good.status, 302, "the other session is not blocked");
  });
});

describe("staff accounts", () => {
  async function team() {
    const t = await makeApp();
    await t.addStaff("Adam Admin", "adam@example.com", "admin");
    await t.addStaff("Ed Editor", "ed@example.com", "editor");
    await t.addStaff("Cara Contributor", "cara@example.com", "contributor");
    const id = (e) => t.ctx.store.users.getByEmail(e).id;
    return { t, id, owner: await t.signIn("owner@example.com") };
  }

  test("staff passwords follow the reader rule; a new account's first password is checked too", async () => {
    const { t, owner } = await team();
    const weak = await t.post(owner, `${A}/users/new`, { name: "Weak W", email: "weak@example.com", role: "author", password: "password12345" });
    assert.equal(weak.status, 400);
    assert.match(await weak.text(), /too easy to guess/);
    const own = await t.post(owner, `${A}/users/1/password`, { current_password: PW, password: "1234567890", password_confirm: "1234567890" });
    assert.equal(own.status, 400);
    const ok = await t.post(owner, `${A}/users/new`, { name: "Strong S", email: "strong@example.com", role: "author", password: "three quiet green frogs" });
    assert.equal(ok.status, 302);
    assert.match(await (await t.req(owner.j, `${A}/users/new`)).text(), /type="password"/, "the first password box is hidden text with a show button");
  });

  test("status must be exactly active or suspended; suspending and demoting need your own password", async () => {
    const { t, id, owner } = await team();
    const eid = id("ed@example.com");
    const base = { name: "Ed Editor", slug: "ed-editor", email: "ed@example.com", role: "editor" };
    assert.equal((await t.post(owner, `${A}/users/${eid}`, { ...base, status: "banana", actor_password: PW })).status, 400);
    assert.equal(t.ctx.store.users.get(eid).status, "active");
    assert.equal((await t.post(owner, `${A}/users/${eid}`, { ...base, status: "suspended" })).status, 400, "no password, no suspension");
    assert.equal(t.ctx.store.users.get(eid).status, "active");
    assert.equal((await t.post(owner, `${A}/users/${eid}`, { ...base, status: "suspended", actor_password: PW })).status, 302);
    assert.equal(t.ctx.store.users.get(eid).status, "suspended");
    // A stale form that sends garbage can't undo it.
    assert.equal((await t.post(owner, `${A}/users/${eid}`, { ...base, status: "", actor_password: PW })).status, 400);
    assert.equal(t.ctx.store.users.get(eid).status, "suspended");
  });

  test("a temporary password set by an administrator is flagged, and the person is told to choose their own", async () => {
    const { t, id, owner } = await team();
    const eid = id("ed@example.com");
    const res = await t.post(owner, `${A}/users/${eid}/password`, { actor_password: PW, password: "ed's new password", password_confirm: "ed's new password" });
    assert.equal(res.status, 302);
    assert.equal(t.ctx.store.users.get(eid).mustChange, true);
    // An expired temporary password is refused at sign-in.
    t.ctx.db.prepare("UPDATE users SET password_set_at = ? WHERE id = ?").run(new Date(Date.now() - 8 * 86400_000).toISOString(), eid);
    const late = await t.login(t.newJar(), "ed@example.com", "ed's new password");
    assert.equal(late.status, 403);
    assert.match(await late.text(), /temporary password has expired/);
  });

  test("a staff name can't match a reader's name", async () => {
    const { t, id, owner } = await team();
    await t.ctx.store.members.create({ email: "zed@example.com", name: "Zed Writer", password: "reader password 1" }, { verified: true });
    const res = await t.post(owner, `${A}/users/new`, { name: "zed  writer", email: "zed2@example.com", role: "author", password: "three quiet green frogs" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /A reader already uses that name/);
    const rename = await t.post(owner, `${A}/users/${id("ed@example.com")}`, { name: "Zéd Writer", slug: "ed-editor", email: "ed@example.com" });
    assert.equal(rename.status, 400);
  });

  test("a profile picture someone else uploaded and nobody shows publicly isn't yours to use", async () => {
    const { t, id } = await team();
    const owner = id("owner@example.com");
    const pic = t.ctx.store.media.insert({ path: "abc.jpg", original_name: "abc.jpg", mime: "image/jpeg", size: 10, kind: "image" }, owner);
    const cara = await t.signIn("cara@example.com");
    const cid = id("cara@example.com");
    const res = await t.post(cara, `${A}/users/${cid}`, { name: "Cara Contributor", slug: "cara-contributor", email: "cara@example.com", photo_id: String(pic.id) });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /isn’t yours to use/);
    const mine = t.ctx.store.media.insert({ path: "mine.jpg", original_name: "mine.jpg", mime: "image/jpeg", size: 10, kind: "image" }, cid);
    const ok = await t.post(cara, `${A}/users/${cid}`, { name: "Cara Contributor", slug: "cara-contributor", email: "cara@example.com", photo_id: String(mine.id) });
    assert.equal(ok.status, 302);
    assert.equal(t.ctx.store.users.get(cid).photo_id, mine.id);
  });

  test("the owner-only rule has one home: can.owner", () => {
    assert.equal(can.owner({ role: "owner" }), true);
    for (const role of ["admin", "editor", "author", "contributor"]) assert.equal(can.owner({ role }), false);
    // Every permission only the owner holds is listed here: adding another means adding it to this list on purpose.
    const sample = { type: "post", author_id: 99, status: "published", uploaded_by: 99 };
    const ownerOnly = Object.keys(can).filter((k) => can[k]({ id: 1, role: "owner" }, sample) && !can[k]({ id: 2, role: "admin" }, sample));
    assert.deepEqual(ownerOnly, ["owner"]);
  });

  test("an own email change keeps you signed in on a fresh session and the others end", async () => {
    const { t, id } = await team();
    const adam = await t.signIn("adam@example.com");
    const other = await t.signIn("adam@example.com");
    const aid = id("adam@example.com");
    const res = await t.post(adam, `${A}/users/${aid}`, { name: "Adam Admin", slug: "adam-admin", email: "adam2@example.com", current_password: PW });
    assert.equal(res.status, 302);
    assert.equal((await t.req(adam.j, `${A}/posts`)).status, 200);
    assert.equal((await t.req(other.j, `${A}/posts`)).status, 302);
  });

  test("the profile lists your devices and signs one out", async () => {
    const { t } = await team();
    const a = await t.signIn("owner@example.com");
    const b = await t.signIn("owner@example.com");
    const html = await (await t.req(a.j, `${A}/users/1`)).text();
    assert.match(html, /Where you are signed in/);
    const handles = [...html.matchAll(/action="\/admin\/account\/sessions\/([0-9a-f]{24})\/end"/g)].map((m) => m[1]);
    assert.ok(handles.length >= 1);
    for (const h of handles) assert.equal((await t.post(a, `${A}/account/sessions/${h}/end`, {})).status, 302);
    assert.equal((await t.req(b.j, `${A}/posts`)).status, 302, "the other device is signed out");
    assert.equal((await t.req(a.j, `${A}/posts`)).status, 200, "this one isn't");
  });
});

describe("two-step rule", () => {
  test("the owner can only require it after turning it on for themselves; a person without it can only reach the way to turn it on", async () => {
    const t = await makeApp();
    await t.addStaff("Ada Admin", "ada@example.com", "admin");
    await t.addStaff("Cara Contributor", "cara@example.com", "contributor");
    const owner = await t.signIn("owner@example.com");
    const refused = await t.post(owner, `${A}/users/two-step-rule`, { rule: "admins" });
    assert.equal(refused.status, 400);
    assert.equal(t.ctx.store.settings.all().require_two_step, "off");
    assert.equal((await t.post(owner, `${A}/users/two-step-rule`, { rule: "off" })).status, 302);
    assert.match(await (await t.req(owner.j, `${A}/users`)).text(), /Who must use it/);
    t.ctx.store.users.enableTwoStep(1, "JBSWY3DPEHPK3PXP", stepAt() - 3);
    const ada = await t.signIn("ada@example.com");
    const cara = await t.signIn("cara@example.com");
    // The owner now has two-step through the store; a fresh sign-in session is not needed for the rule itself.
    const ownerAgain = { ...owner };
    assert.equal((await t.post(ownerAgain, `${A}/users/two-step-rule`, { rule: "admins" })).status, 302);
    assert.equal(t.ctx.store.settings.all().require_two_step, "admins");
    const blocked = await t.req(ada.j, `${A}/posts`);
    assert.equal(blocked.status, 302);
    assert.equal(blocked.headers.get("location"), `${A}/account/two-step?ok=twostepneeded`);
    assert.equal((await t.req(ada.j, `${A}/account/two-step`)).status, 200);
    assert.equal((await t.req(ada.j, `${A}/users/${t.ctx.store.users.getByEmail("ada@example.com").id}`)).status, 200);
    assert.equal((await t.req(ada.j, `${A}/api/media`)).status, 403);
    // Contributors aren't covered by "admins"; they are by "staff".
    assert.equal((await t.req(cara.j, `${A}/posts`)).status, 200);
    t.ctx.store.settings.set({ require_two_step: "staff" });
    assert.equal((await t.req(cara.j, `${A}/posts`)).status, 302);
    // Sign out always works.
    assert.equal((await t.post(cara, `${A}/logout`, {})).status, 302);
  });

  test("an unfinished setup secret is dropped after 15 minutes", async () => {
    const t = await makeApp();
    const s = await t.signIn("owner@example.com");
    await t.post(s, `${A}/account/two-step/start`, {});
    assert.match(await (await t.req(s.j, `${A}/account/two-step`)).text(), /setup-key/);
    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 60_000;
    try {
      assert.ok(!/setup-key/.test(await (await t.req(s.j, `${A}/account/two-step`)).text()));
    } finally {
      Date.now = realNow;
    }
  });
});

describe("dashboard and readers", () => {
  test("numbers for areas a role can't open are left out; the owner sees set-up warnings, others don't; old recovery codes get a notice", async () => {
    const t = await makeApp();
    await t.addStaff("Cara Contributor", "cara@example.com", "contributor");
    t.ctx.warn?.("The test warning sentence is here.");
    const owner = await t.signIn("owner@example.com");
    const cara = await t.signIn("cara@example.com");
    const od = await (await t.req(owner.j, `${A}/`)).text();
    const cd = await (await t.req(cara.j, `${A}/`)).text();
    if (t.ctx.warn) {
      assert.match(od, /The test warning sentence is here/);
      assert.ok(!/The test warning sentence/.test(cd));
    }
    assert.ok(!/>Members</.test(cd) && !/>Subscribers</.test(cd) && !/Waiting to confirm/.test(cd));
    assert.match(od, />Members</);
    t.ctx.db.prepare("UPDATE users SET recovery_codes_reset = 1 WHERE id = 1").run();
    assert.match(await (await t.req(owner.j, `${A}/`)).text(), /old recovery codes were removed/);
    assert.match(await (await t.req(owner.j, `${A}/account/two-step`)).text(), /old recovery codes were removed/);
  });

  test("the reader CSV is a POST with the form token, logged, limited, consistent and shows real newsletter status", async () => {
    const t = await makeApp();
    const s = await t.signIn("owner@example.com");
    const { store } = t.ctx;
    await store.members.create({ email: "a@example.com", name: "Ann", password: "reader password 1", newsletter: true }, { verified: true });
    await store.members.create({ email: "b@example.com", name: "Bob", password: "reader password 1" }, { verified: false });
    store.subscribers.add("a@example.com", "test");
    const wrong = await t.req(s.j, `${A}/members.csv`, { method: "POST", form: { _csrf: "nope" } });
    assert.equal(wrong.status, 403);
    assert.equal((await t.req(s.j, `${A}/members.csv`)).status, 302);
    const res = await t.post(s, `${A}/members.csv`, {});
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines[0], '"name","email","status","email_verified_at","newsletter","joined","comments"');
    const ann = lines.find((l) => l.includes("a@example.com"));
    const bob = lines.find((l) => l.includes("b@example.com"));
    assert.match(ann, /"(pending|active)"/, "the real subscription status");
    assert.match(bob, /"none"/);
    assert.match(bob, /"","none"/, "an unverified reader has no verified date");
    for (let i = 0; i < 10; i++) await t.post(s, `${A}/members.csv`, {});
    assert.equal((await t.post(s, `${A}/members.csv`, {})).status, 429);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(fs.readFileSync(path.join(t.dataDir, "audit.log"), "utf8"), /reader list exported/);
  });

  test("the readers list shows only named fields; reset links are for verified, active readers only", async () => {
    const t = await makeApp();
    const s = await t.signIn("owner@example.com");
    const { store } = t.ctx;
    const unverified = await store.members.create({ email: "u@example.com", name: "Una", password: "reader password 1" }, { verified: false });
    const banned = await store.members.create({ email: "x@example.com", name: "Xan", password: "reader password 1" }, { verified: true });
    store.members.setStatus(banned.id, "banned");
    const page = await (await t.req(s.j, `${A}/members`)).text();
    assert.ok(!/scrypt\$/.test(page));
    for (const m of [unverified, banned]) {
      const res = await t.post(s, `${A}/members/${m.id}/reset`, {});
      assert.equal(res.status, 400);
      assert.match(await res.text(), /active and has verified/);
    }
    assert.equal(store.members.get(unverified.id).verified_at, null, "the reset link did not verify the address");
  });

  test("blocking, unblocking and deleting a reader are logged", async () => {
    const t = await makeApp();
    const s = await t.signIn("owner@example.com");
    const m = await t.ctx.store.members.create({ email: "r@example.com", name: "Rae", password: "reader password 1" }, { verified: true });
    await t.post(s, `${A}/members/${m.id}/ban`, {});
    await t.post(s, `${A}/members/${m.id}/unban`, {});
    await t.post(s, `${A}/members/${m.id}/delete`, {});
    await new Promise((r) => setTimeout(r, 150));
    const log = fs.readFileSync(path.join(t.dataDir, "audit.log"), "utf8");
    assert.match(log, /reader blocked: member \d+ by staff 1/);
    assert.match(log, /reader unblocked/);
    assert.match(log, /reader deleted/);
  });
});

describe("setup", () => {
  test("a too-short setup token from the environment never opens setup", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-fix2-setup-"));
    const { app } = createApp({ dataDir, production: true, outbound: false, mailTransport: { jsonTransport: true }, setupToken: "short", trustProxy: true });
    const j = jar();
    const get = await app.request("http://localhost/admin/setup", { headers: { cookie: j.header(), "x-forwarded-for": "203.0.113.5" } });
    j.store(get);
    const tok = (await get.text()).match(/name="_csrf" value="([^"]*)"/)[1];
    const res = await app.request("http://localhost/admin/setup", {
      method: "POST",
      headers: { origin: "http://localhost", cookie: j.header(), "x-forwarded-for": "203.0.113.5", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: tok, setup_token: "short", site_title: "T", site_url: "http://localhost", name: "Owen", email: "owen@example.com", password: PW }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Setup token is wrong|too short/, "a short token is never accepted");
  });
});

describe("session rotation", () => {
  test("turning two-step on gives the session a new cookie and form token; the old cookie stops working", async () => {
    const t = await makeApp();
    const s = await t.signIn("owner@example.com");
    const oldSid = s.j.cookies.get("sid");
    await t.post(s, `${A}/account/two-step/start`, {});
    const html = await (await t.req(s.j, `${A}/account/two-step`)).text();
    const secret = html.match(/<code class="setup-key">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, "");
    const left = 30000 - (Date.now() % 30000);
    if (left < 8000) await new Promise((r) => setTimeout(r, left + 50));
    const res = await t.post(s, `${A}/account/two-step/enable`, { code: codeAt(secret, stepAt() - 1), password: PW });
    assert.equal(res.status, 200);
    const newSid = s.j.cookies.get("sid");
    assert.notEqual(newSid, oldSid);
    const body = await res.text();
    assert.ok(t.csrfOf(body) && t.csrfOf(body) !== s.csrf, "the page carries the new form token");
    assert.equal((await t.req(t.newJar(), `${A}/posts`, { headers: { cookie: `sid=${oldSid}` } })).status, 302, "the old cookie is dead");
    assert.equal((await t.req(s.j, `${A}/posts`)).status, 200, "the new one works");
  });
});
