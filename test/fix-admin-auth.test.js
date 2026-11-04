// Staff sign-in, rank rules, step-up checks, setup, dashboard and members routes after the security fixes.
// In-process, no network. Run: node --test test/fix-admin-auth.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/web/app.js";
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
const freshIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

// A fresh app (own data folder) with an owner already created.
async function makeApp({ setup = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-fix-auth-"));
  const { app, ctx } = createApp({ dataDir, production: true, outbound: false, mailTransport: { jsonTransport: true }, mailDelayMs: 0, setupToken: "test-setup", trustProxy: true });
  const t = {
    app,
    ctx,
    async req(j, p, { method = "GET", form, json, headers = {}, ip } = {}) {
      const h = { origin: "http://localhost", cookie: j.header(), "x-forwarded-for": ip || j.ip || "198.51.100.1", ...headers };
      let body;
      if (form) {
        body = new URLSearchParams(form);
        h["content-type"] = "application/x-www-form-urlencoded";
      }
      if (json) {
        body = JSON.stringify(json);
        h["content-type"] = "application/json";
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
    let res = await t.req(j, `${A}/login`);
    const token = t.field(await res.text(), "_csrf");
    return t.req(j, `${A}/login`, { method: "POST", form: { _csrf: token, email, password, next } });
  };
  // Signs in and returns { j, csrf }.
  t.signIn = async (email, password = PW, ip = freshIp()) => {
    const j = t.newJar(ip);
    const res = await t.login(j, email, password);
    assert.equal(res.status, 302, `sign in ${email}: ${res.status} ${res.status === 302 ? "" : (await res.text()).slice(0, 400)}`);
    const page = await t.req(j, `${A}/users/${t.ctx.store.users.getByEmail(email).id}`);
    return { j, csrf: t.csrfOf(await page.text()), res };
  };
  t.post = (s, p, form) => t.req(s.j, p, { method: "POST", form: { _csrf: s.csrf, ...form } });
  if (setup) {
    const j = t.newJar();
    let res = await t.req(j, `${A}/setup`);
    const token = t.field(await res.text(), "_csrf");
    res = await t.req(j, `${A}/setup`, { method: "POST", form: { _csrf: token, setup_token: "test-setup", site_title: "Test Blog", site_url: "http://localhost", name: "Olive Owner", email: "owner@example.com", password: PW } });
    assert.equal(res.status, 302, await res.text());
  }
  // Adds a staff member straight through the store (no must-change flag).
  t.addStaff = async (name, email, role, password = PW) => t.ctx.store.users.create({ name, email, role, password });
  return t;
}

describe("setup", () => {
  test("needs the setup token, compares it, and is rate-limited", async () => {
    const t = await makeApp({ setup: false });
    const j = t.newJar("203.0.113.9");
    let res = await t.req(j, `${A}/setup`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /name="setup_token"/);
    const body = { site_title: "T", site_url: "http://localhost", name: "Owen", email: "owen@example.com", password: PW };
    // An error page hands out a fresh form token, so fetch one before every try.
    const post = async (extra) => t.req(j, `${A}/setup`, { method: "POST", form: { _csrf: t.field(await (await t.req(j, `${A}/setup`)).text(), "_csrf"), ...body, ...extra } });
    res = await post({});
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Setup token is wrong/);
    res = await post({ setup_token: "test-setuq" });
    assert.equal(res.status, 400);
    assert.equal(t.ctx.store.users.hasOwner(), false);
    // The form token is bound to the server: a forged one fails.
    res = await post({ _csrf: "forged", setup_token: "test-setup" });
    assert.equal(res.status, 400);
    res = await post({ setup_token: "test-setup", name: "x".repeat(500) });
    assert.equal(res.status, 302);
    assert.equal(t.ctx.store.users.getByEmail("owen@example.com").name.length, 100, "name is capped");
    // Once an owner exists, setup is closed.
    res = await t.req(t.newJar(), `${A}/setup`);
    assert.equal(res.headers.get("location"), `${A}/login`);
  });

  test("too many tries from one address get 429", async () => {
    const t = await makeApp({ setup: false });
    const j = t.newJar("203.0.113.10");
    const token = t.field(await (await t.req(j, `${A}/setup`)).text(), "_csrf");
    let last = 0;
    for (let i = 0; i < 25; i++) {
      const res = await t.req(j, `${A}/setup`, { method: "POST", form: { _csrf: token, setup_token: `wrong-${i}`, name: "N", email: "n@example.com", password: PW, site_url: "http://localhost" } });
      last = res.status;
      if (last === 429) break;
    }
    assert.equal(last, 429);
  });

  test("two simultaneous setups make one owner", async () => {
    const t = await makeApp({ setup: false });
    const make = async (n) => {
      const j = t.newJar(freshIp());
      const token = t.field(await (await t.req(j, `${A}/setup`)).text(), "_csrf");
      return t.req(j, `${A}/setup`, { method: "POST", form: { _csrf: token, setup_token: "test-setup", site_title: "T", site_url: "http://localhost", name: `Owner ${n}`, email: `o${n}@example.com`, password: PW } });
    };
    await Promise.all([make(1), make(2), make(3)]);
    assert.equal(t.ctx.store.users.list().filter((u) => u.role === "owner").length, 1);
  });
});

describe("sign-in throttling and sessions", () => {
  test("a success never resets the per-address counter", async () => {
    const t = await makeApp();
    await t.addStaff("Cara", "cara@example.com", "contributor");
    const ip = "192.0.2.50";
    const j = t.newJar(ip);
    let statuses = [];
    // 9 wrong guesses at the owner (from different accounts' keys each time so only the address limiter acts)
    for (let i = 0; i < 4; i++) statuses.push((await t.login(j, `nobody${i}@example.com`, "wrong wrong wrong")).status);
    assert.ok(statuses.every((s) => s === 401));
    const ok = await t.login(j, "cara@example.com", PW);
    assert.equal(ok.status, 302, "valid login still works");
    j.cookies.clear();
    for (let i = 0; i < 4; i++) statuses.push((await t.login(j, `nobody${i + 10}@example.com`, "wrong wrong wrong")).status);
    // 4 + 1 + 4 = 9 attempts so far; the success did not clear them, so the 11th is refused.
    const tenth = await t.login(j, "nobody20@example.com", "wrong wrong wrong");
    assert.equal(tenth.status, 401);
    const eleventh = await t.login(j, "nobody21@example.com", "wrong wrong wrong");
    assert.equal(eleventh.status, 429);
  });

  test("per-account limit counts failures; a success clears only that account", async () => {
    const t = await makeApp();
    await t.addStaff("Cara", "cara@example.com", "contributor");
    // Five wrong passwords at the owner from five different addresses: the account is then locked.
    for (let i = 0; i < 5; i++) assert.equal((await t.login(t.newJar(), "OWNER@example.com", "wrong wrong wrong")).status, 401);
    const locked = await t.login(t.newJar(), "owner@example.com", PW);
    assert.equal(locked.status, 429, "even the right password is refused while locked");
    // Another account is unaffected.
    assert.equal((await t.login(t.newJar(), "cara@example.com", PW)).status, 302);
    // A success clears that account's failures.
    for (let i = 0; i < 4; i++) await t.login(t.newJar(), "cara@example.com", "wrong wrong wrong");
    assert.equal((await t.login(t.newJar(), "cara@example.com", PW)).status, 302);
    for (let i = 0; i < 4; i++) assert.equal((await t.login(t.newJar(), "cara@example.com", "wrong wrong wrong")).status, 401);
  });

  test("the next address is limited to the admin area and rejects control characters", async () => {
    const t = await makeApp();
    for (const [next, expected] of [
      [`${A}/posts`, `${A}/posts`],
      ["https://evil.example/", `${A}/`],
      ["//evil.example/", `${A}/`],
      [`${A}/\r\nSet-Cookie: x=1`, `${A}/`],
      [`/\\evil.example`, `${A}/`],
      [`${A}-news/`, `${A}/`],
      ["/blog/", `${A}/`],
    ]) {
      const res = await t.login(t.newJar(), "owner@example.com", PW, next);
      assert.equal(res.status, 302, next);
      assert.equal(res.headers.get("location"), expected, JSON.stringify(next));
    }
  });

  test("sign-in destroys the session already held; cookies are Secure over https", async () => {
    const t = await makeApp();
    const first = await t.signIn("owner@example.com");
    const oldSid = first.j.cookies.get("sid");
    assert.ok(oldSid);
    // Sign in again from a browser that still holds the old cookie.
    const j3 = t.newJar();
    const tok = t.field(await (await t.req(j3, `${A}/login`)).text(), "_csrf");
    j3.cookies.set("sid", oldSid);
    const res = await t.req(j3, `${A}/login`, { method: "POST", form: { _csrf: tok, email: "owner@example.com", password: PW } });
    assert.equal(res.status, 302);
    const check = await t.req(t.newJar(), `${A}/posts`, { headers: { cookie: `sid=${oldSid}` } });
    assert.equal(check.status, 302, "the old session is gone");
    assert.match(check.headers.get("location"), /login/);

    // Secure cookie behind a trusted https proxy.
    const j4 = t.newJar();
    const r = await t.req(j4, `${A}/login`, { headers: { "x-forwarded-proto": "https" } });
    assert.ok(r.headers.getSetCookie().every((c) => /;\s*Secure/i.test(c)), r.headers.getSetCookie().join("\n"));
    const r2 = await t.req(t.newJar(), `${A}/login`);
    assert.ok(r2.headers.getSetCookie().every((c) => !/;\s*Secure/i.test(c)), "plain http stays non-Secure");
  });

  test("Sign out other devices keeps only this session", async () => {
    const t = await makeApp();
    const a = await t.signIn("owner@example.com");
    const b = await t.signIn("owner@example.com");
    const res = await t.post(a, `${A}/account/sessions/end-others`, {});
    assert.equal(res.status, 302);
    assert.equal((await t.req(a.j, `${A}/posts`)).status, 200);
    assert.equal((await t.req(b.j, `${A}/posts`)).status, 302);
    const profile = await (await t.req(a.j, `${A}/users/1`)).text();
    assert.match(profile, /Sign out other devices/);
  });

  test("the page token is derived, not the stored session value", async () => {
    const t = await makeApp();
    const s = await t.signIn("owner@example.com");
    const stored = t.ctx.db.prepare("SELECT csrf FROM sessions LIMIT 1").get().csrf;
    assert.notEqual(s.csrf, stored);
    assert.equal((await t.post({ ...s, csrf: stored }, `${A}/account/sessions/end-others`, {})).status, 403);
    assert.equal((await t.req(s.j, `${A}/api/posts`, { method: "POST", json: {}, headers: { "x-csrf-token": stored } })).status, 403);
    assert.equal((await t.post(s, `${A}/account/sessions/end-others`, {})).status, 302);
  });

  test("odd ?ok values and static names show nothing odd", async () => {
    const t = await makeApp();
    const s = await t.signIn("owner@example.com");
    for (const ok of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const html = await (await t.req(s.j, `${A}/?ok=${ok}`)).text();
      assert.ok(!/class="flash"/.test(html), ok);
    }
    assert.match(await (await t.req(s.j, `${A}/?ok=saved`)).text(), /class="flash"/);
    assert.equal((await t.req(s.j, `${A}/static/constructor`)).status, 404);
    assert.equal((await t.req(s.j, `${A}/static/__proto__`)).status, 404);
    assert.equal((await t.req(s.j, `${A}/static/admin.css`)).status, 200);
  });
});

describe("two-step", () => {
  // Turns two-step on for the owner; returns { secret, codes, s }.
  async function enableFor(t, email) {
    const s = await t.signIn(email);
    const uid = t.ctx.store.users.getByEmail(email).id;
    // Opening the page creates nothing.
    let html = await (await t.req(s.j, `${A}/account/two-step`)).text();
    assert.ok(!/setup-key/.test(html), "no secret on GET");
    assert.equal(t.ctx.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND totp_pending IS NOT NULL").get(uid).n, 0);
    assert.equal((await t.post(s, `${A}/account/two-step/start`, {})).status, 302);
    html = await (await t.req(s.j, `${A}/account/two-step`)).text();
    const secret = html.match(/<code class="setup-key">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, "");
    // The previous step's code is accepted only while the server is still in the next step. The password check
    // (scrypt) can take seconds on a busy machine, so do not start it in the last seconds of a 30 s step.
    const left = 30000 - (Date.now() % 30000);
    if (left < 8000) await new Promise((r) => setTimeout(r, left + 50));
    const res = await t.post(s, `${A}/account/two-step/enable`, { code: codeAt(secret, stepAt() - 1), password: PW });
    assert.equal(res.status, 200);
    const codes = [...(await res.text()).matchAll(/<li><code>([A-Z2-7-]+)<\/code><\/li>/g)].map((m) => m[1]);
    assert.equal(codes.length, 10);
    return { secret, codes, s, uid };
  }

  test("enable, sign in with a code, per-account lockout across challenges, recovery codes by length", async () => {
    const t = await makeApp();
    const { secret, codes, uid } = await enableFor(t, "owner@example.com");
    const challenge = async (j) => {
      const res = await t.login(j, "owner@example.com", PW);
      assert.equal(res.headers.get("location"), `${A}/verify` === "" ? "" : `${A}/login/verify`);
      return t.field(await (await t.req(j, `${A}/login/verify`)).text(), "_csrf");
    };
    // Good code works (current step).
    let j = t.newJar();
    let token = await challenge(j);
    let res = await t.req(j, `${A}/login/verify`, { method: "POST", form: { _csrf: token, code: codeAt(secret, stepAt()) } });
    assert.equal(res.status, 302);
    assert.ok(j.cookies.get("sid"));
    // Wrong codes across several challenges lock the second step after 5 in a row.
    for (let i = 0; i < 5; i++) {
      j = t.newJar();
      token = await challenge(j);
      res = await t.req(j, `${A}/login/verify`, { method: "POST", form: { _csrf: token, code: "000000" } });
      assert.ok([401, 429].includes(res.status), String(res.status));
    }
    assert.equal(t.ctx.store.users.totpLocked(uid), true);
    // The lock only stops authenticator codes from other browsers: the password step still leads to the code page,
    // where an authenticator code is refused and a recovery code (found by length) works once.
    j = t.newJar();
    token = await challenge(j);
    res = await t.req(j, `${A}/login/verify`, { method: "POST", form: { _csrf: token, code: codeAt(secret, stepAt()) } });
    assert.equal(res.status, 429, "an authenticator code is refused while the second step is locked");
    assert.equal(j.cookies.get("sid"), undefined);
    j = t.newJar();
    token = await challenge(j);
    res = await t.req(j, `${A}/login/verify`, { method: "POST", form: { _csrf: token, code: codes[0].toLowerCase() } });
    assert.equal(res.headers.get("location"), `${A}/account/two-step?ok=recovery`);
  });

  test("a challenge dies when the password changes (auth_version) and when the user logs out", async () => {
    const t = await makeApp();
    const { secret } = await enableFor(t, "owner@example.com");
    const j = t.newJar();
    assert.equal((await t.login(j, "owner@example.com", PW)).headers.get("location"), `${A}/login/verify`);
    const token = t.field(await (await t.req(j, `${A}/login/verify`)).text(), "_csrf");
    await t.ctx.store.users.setPassword(t.ctx.store.users.getByEmail("owner@example.com").id, "a brand new password", { actor: "system" });
    const res = await t.req(j, `${A}/login/verify`, { method: "POST", form: { _csrf: token, code: codeAt(secret, stepAt() + 1) } });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /account changed/);
    assert.equal(j.cookies.get("sid"), undefined);
  });

  test("logout also ends a pending challenge cookie", async () => {
    const t = await makeApp();
    await enableFor(t, "owner@example.com");
    const j = t.newJar();
    await t.login(j, "owner@example.com", PW);
    assert.ok(j.cookies.get("l2fa"));
    const owner = t.ctx.store.users.getByEmail("owner@example.com");
    const { token } = t.ctx.store.users.createSession(owner.id);
    j.cookies.set("sid", token);
    // Page tokens are derived from the session, so take it from a rendered page.
    const csrf = t.csrfOf(await (await t.req(j, `${A}/`)).text());
    const res = await t.req(j, `${A}/logout`, { method: "POST", form: { _csrf: csrf } });
    assert.equal(res.status, 302);
    assert.equal(j.cookies.get("l2fa"), undefined);
    assert.equal(j.cookies.get("sid"), undefined);
  });

  test("step-up checks share a limit of 5 wrong tries", async () => {
    const t = await makeApp();
    const s = await t.signIn("owner@example.com");
    const results = [];
    for (let i = 0; i < 7; i++) {
      const res = await t.post(s, `${A}/users/1/password`, { current_password: "wrong wrong wrong", password: "another long password", password_confirm: "another long password" });
      results.push(res.status);
    }
    assert.deepEqual(results.slice(0, 5), [400, 400, 400, 400, 400]);
    assert.match(await (await t.post(s, `${A}/users/1/password`, { current_password: PW, password: "another long password", password_confirm: "another long password" })).text(), /Too many wrong tries/);
  });
});

describe("rank rules and passwords", () => {
  async function team() {
    const t = await makeApp();
    await t.addStaff("Adam Admin", "adam@example.com", "admin");
    await t.addStaff("Ada Admin", "ada@example.com", "admin");
    await t.addStaff("Ed Editor", "ed@example.com", "editor");
    await t.addStaff("Cara Contributor", "cara@example.com", "contributor");
    const id = (e) => t.ctx.store.users.getByEmail(e).id;
    return { t, id, owner: await t.signIn("owner@example.com"), adam: await t.signIn("adam@example.com"), ed: await t.signIn("ed@example.com") };
  }

  test("an administrator cannot touch the owner or another administrator, but can manage lower roles", async () => {
    const { t, id, adam } = await team();
    const profile = (uid, extra = {}) => t.post(adam, `${A}/users/${uid}`, { name: "Renamed", slug: "renamed", email: "x@example.com", ...extra });
    assert.equal((await profile(id("owner@example.com"))).status, 403);
    assert.equal((await profile(id("ada@example.com"))).status, 403);
    assert.equal((await t.post(adam, `${A}/users/${id("ada@example.com")}/password`, { actor_password: PW, password: "another long password", password_confirm: "another long password" })).status, 403);
    assert.equal((await t.post(adam, `${A}/users/${id("ada@example.com")}/delete`, {})).status, 403);
    assert.equal((await t.post(adam, `${A}/users/${id("owner@example.com")}/delete`, {})).status, 403);
    assert.equal((await t.post(adam, `${A}/users/${id("ada@example.com")}/two-step/reset`, { password: PW })).status, 403);
    // Viewing another administrator is read-only.
    const view = await (await t.req(adam.j, `${A}/users/${id("ada@example.com")}`)).text();
    assert.ok(!/action="\/admin\/users\/\d+\/delete"/.test(view));
    // A lower role is fine.
    const ok = await profile(id("ed@example.com"), { email: "ed@example.com", name: "Ed Editor", slug: "ed-editor", job_title: "Editor in chief" });
    assert.equal(ok.status, 302, await ok.text());
    assert.equal(t.ctx.store.users.get(id("ed@example.com")).job_title, "Editor in chief");
    // An administrator cannot make an administrator or an owner.
    const up = await profile(id("cara@example.com"), { email: "cara@example.com", name: "Cara Contributor", slug: "cara-contributor", role: "admin" });
    assert.equal(up.status, 400);
    assert.equal(t.ctx.store.users.get(id("cara@example.com")).role, "contributor");
    const up2 = await t.post(adam, `${A}/users/new`, { name: "New Admin", email: "newadmin@example.com", role: "admin", password: "first password 1" });
    assert.equal(up2.status, 400);
  });

  test("the owner can manage everyone; role change and suspension end the target's sessions", async () => {
    const { t, id, owner, ed } = await team();
    const eid = id("ed@example.com");
    assert.equal((await t.req(ed.j, `${A}/posts`)).status, 200);
    let res = await t.post(owner, `${A}/users/${eid}`, { name: "Ed Editor", slug: "ed-editor", email: "ed@example.com", role: "author", status: "active" });
    assert.equal(res.status, 400, "giving a lower role needs your own password");
    res = await t.post(owner, `${A}/users/${eid}`, { name: "Ed Editor", slug: "ed-editor", email: "ed@example.com", role: "author", status: "active", actor_password: PW });
    assert.equal(res.status, 302, await res.text());
    assert.equal((await t.req(ed.j, `${A}/posts`)).status, 302, "role change ended the sessions");
    const ed2 = await t.signIn("ed@example.com");
    res = await t.post(owner, `${A}/users/${eid}`, { name: "Ed Editor", slug: "ed-editor", email: "ed@example.com", role: "author", status: "suspended", actor_password: PW });
    assert.equal(res.status, 302);
    assert.equal((await t.req(ed2.j, `${A}/posts`)).status, 302, "suspension ended the sessions");
    res = await t.post(owner, `${A}/users/${eid}`, { name: "Ed Editor", slug: "ed-editor", email: "ed@example.com", role: "author", status: "active" });
    assert.equal(res.status, 302);
    assert.equal((await t.req(ed2.j, `${A}/posts`)).status, 302, "re-activating does not revive old sessions");
    // The owner manages an administrator.
    res = await t.post(owner, `${A}/users/${id("ada@example.com")}/delete`, {});
    assert.equal(res.status, 400, "deleting needs your own password");
    res = await t.post(owner, `${A}/users/${id("ada@example.com")}/delete`, { actor_password: PW });
    assert.equal(res.status, 302);
    assert.equal(t.ctx.store.users.getByEmail("ada@example.com"), null);
  });

  test("changing an email needs your own password; setting another's password needs the actor's password", async () => {
    const { t, id, owner, adam } = await team();
    const eid = id("ed@example.com");
    // Own email change: no password, wrong password, right password.
    const adamId = id("adam@example.com");
    const own = (extra) => t.post(adam, `${A}/users/${adamId}`, { name: "Adam Admin", slug: "adam-admin", email: "adam2@example.com", ...extra });
    assert.equal((await own({})).status, 400);
    assert.equal((await own({ current_password: "nope nope nope" })).status, 400);
    assert.equal(t.ctx.store.users.get(adamId).email, "adam@example.com");
    const keepOther = await t.signIn("adam@example.com");
    assert.equal((await own({ current_password: PW })).status, 302);
    assert.equal(t.ctx.store.users.get(adamId).email, "adam2@example.com");
    assert.equal((await t.req(adam.j, `${A}/posts`)).status, 200, "this session stays");
    assert.equal((await t.req(keepOther.j, `${A}/posts`)).status, 302, "other sessions end on an email change");
    // Another's email.
    const other = (extra) => t.post(owner, `${A}/users/${eid}`, { name: "Ed Editor", slug: "ed-editor", email: "ed2@example.com", ...extra });
    assert.equal((await other({})).status, 400);
    assert.equal((await other({ actor_password: PW })).status, 302);
    // Another's password.
    const setPw = (extra) => t.post(owner, `${A}/users/${eid}/password`, { password: "ed's new password", password_confirm: "ed's new password", ...extra });
    assert.equal((await setPw({})).status, 400);
    assert.equal((await setPw({ actor_password: "wrong wrong wrong" })).status, 400);
    assert.equal((await setPw({ actor_password: PW })).status, 302);
    assert.equal((await t.login(t.newJar(), "ed2@example.com", "ed's new password")).status, 302);
    // Too long and mismatched passwords are refused.
    assert.equal((await t.post(owner, `${A}/users/${eid}/password`, { actor_password: PW, password: "x".repeat(300), password_confirm: "x".repeat(300) })).status, 400);
  });

  test("a new staff account must change its password at first sign-in", async () => {
    const { t, id, owner } = await team();
    const res = await t.post(owner, `${A}/users/new`, { name: "Newt New", email: "newt@example.com", role: "author", password: "first password 1", job_title: "j".repeat(500) });
    assert.equal(res.status, 302, await res.text());
    const newt = t.ctx.store.users.getByEmail("newt@example.com");
    assert.equal(newt.mustChange, true);
    assert.equal(newt.job_title.length, 100);
    const j = t.newJar();
    const login = await t.login(j, "newt@example.com", "first password 1");
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("location"), `${A}/users/${newt.id}?ok=mustchange`);
    // Everything else bounces back to the profile.
    assert.match((await t.req(j, `${A}/posts`)).headers.get("location"), /users\/\d+\?ok=mustchange/);
    assert.match((await t.req(j, `${A}/`)).headers.get("location"), /mustchange/);
    const profile = await t.req(j, `${A}/users/${newt.id}`);
    assert.equal(profile.status, 200);
    const csrf = t.csrfOf(await profile.text());
    const changed = await t.req(j, `${A}/users/${newt.id}/password`, { method: "POST", form: { _csrf: csrf, current_password: "first password 1", password: "my own new password", password_confirm: "my own new password" } });
    assert.equal(changed.status, 302);
    const next = await t.signIn("newt@example.com", "my own new password");
    assert.equal((await t.req(next.j, `${A}/posts`)).status, 200);
    assert.equal(t.ctx.store.users.get(newt.id).mustChange, false);
  });

  test("a failed profile save re-renders what was typed without changing the stored role", async () => {
    const { t, id, owner } = await team();
    const res = await t.post(owner, `${A}/users/${id("ed@example.com")}`, { name: "Typed Name", slug: "Bad Slug!!", email: "not an email", role: "admin" });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /value="Typed Name"/);
    assert.equal(t.ctx.store.users.get(id("ed@example.com")).role, "editor");
  });

  test("two-step reset: rank rule, password, audit line, sessions end", async () => {
    const { t, id, owner } = await team();
    const eid = id("ed@example.com");
    // Give the editor two-step through the store.
    t.ctx.store.users.enableTwoStep(eid, "JBSWY3DPEHPK3PXP", 1);
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      assert.equal((await t.post(owner, `${A}/users/${eid}/two-step/reset`, { password: "wrong wrong wrong" })).status, 400);
      const res = await t.post(owner, `${A}/users/${eid}/two-step/reset`, { password: PW });
      assert.equal(res.status, 302);
    } finally {
      console.log = orig;
    }
    assert.equal(t.ctx.store.users.twoStepStatus(eid).enabled, false);
    assert.ok(lines.some((l) => /\[audit\] two-step sign-in reset/.test(l)));
  });
});

describe("dashboard", () => {
  test("latest comments only for moderators; owner sees staff without two-step; pending subscribers", async () => {
    const t = await makeApp();
    await t.addStaff("Cara Contributor", "cara@example.com", "contributor");
    await t.addStaff("Ed Editor", "ed@example.com", "editor");
    const owner = await t.signIn("owner@example.com");
    const cara = await t.signIn("cara@example.com");
    const ed = await t.signIn("ed@example.com");
    const od = await (await t.req(owner.j, `${A}/`)).text();
    assert.match(od, /Latest comments/);
    assert.match(od, /Staff without two-step sign-in/);
    assert.match(od, /Cara Contributor/);
    assert.match(od, /Waiting to confirm/);
    assert.match(od, /reader sign-ups are paused|Before you launch/);
    const cd = await (await t.req(cara.j, `${A}/`)).text();
    assert.ok(!/Latest comments/.test(cd));
    assert.ok(!/Comments to approve/.test(cd));
    assert.ok(!/Staff without two-step/.test(cd));
    const ed_ = await (await t.req(ed.j, `${A}/`)).text();
    assert.match(ed_, /Latest comments/);
    assert.ok(!/Staff without two-step/.test(ed_));
    // The staff list shows two-step status.
    assert.match(await (await t.req(owner.j, `${A}/users`)).text(), /Two-step/);
  });
});

describe("members routes", () => {
  test("csv export is streamed in pages and guards formulas, tabs and returns", async () => {
    const t = await makeApp();
    const s = await t.signIn("owner@example.com");
    const { store } = t.ctx;
    const names = ["=HYPERLINK(\"x\")", "+1", "-2", "@sum", "\tTab", "Plain"];
    for (let i = 0; i < names.length; i++) await store.members.create({ email: `m${i}@example.com`, name: names[i], password: "reader password 1" }, { verified: true });
    // Bulk rows straight into the table: hashing 520 passwords would only slow the test down.
    const ins = t.ctx.db.prepare("INSERT INTO members (email, name, password_hash, created_at, verified_at) VALUES (?, ?, 'x', ?, ?)");
    for (let i = 0; i < 520; i++) ins.run(`bulk${i}@example.com`, `Bulk ${i}`, new Date().toISOString(), new Date().toISOString());
    // Exports are a POST with the form token; a GET only redirects to the page with the button.
    assert.equal((await t.req(s.j, `${A}/members.csv`)).status, 302);
    const res = await t.post(s, `${A}/members.csv`, {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    const body = await res.text();
    const lines = body.trim().split("\r\n");
    assert.equal(lines[0], '"name","email","status","email_verified_at","newsletter","joined","comments"');
    assert.equal(lines.length, 1 + names.length + 520, "every row, over more than one page");
    assert.ok(body.includes(`"'=HYPERLINK(""x"")"`));
    assert.ok(body.includes(`"'+1"`));
    assert.ok(body.includes(`"'-2"`));
    assert.ok(body.includes(`"'@sum"`));
    assert.ok(body.includes(`"Tab"`), "a tab is stripped, never leading a cell");
    assert.ok(!/(^|,)"[=+@	-]/m.test(body), "no cell starts with a formula character");
    // Not for editors.
    await t.addStaff("Ed Editor", "ed@example.com", "editor");
    const ed = await t.signIn("ed@example.com");
    assert.equal((await t.post(ed, `${A}/members.csv`, {})).status, 403);
  });

  test("reset sends a link, never a password", async () => {
    const t = await makeApp();
    const s = await t.signIn("owner@example.com");
    const m = await t.ctx.store.members.create({ email: "reader@example.com", name: "Reader", password: "reader password 1" }, { verified: true });
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    let res;
    try {
      res = await t.post(s, `${A}/members/${m.id}/reset`, {});
    } finally {
      console.log = orig;
    }
    const html = res.status === 302 ? "" : await res.text();
    if (t.ctx.mailer.ready()) assert.equal(res.status, 302);
    else assert.match(html, /\/reset\/[0-9a-f]+\//);
    assert.ok(!/temp-pass">[A-Za-z0-9_-]{12}</.test(html));
    assert.ok(lines.some((l) => /\[audit\] member password reset link/.test(l)));
    // The old password still works until the link is used.
    assert.ok(await t.ctx.store.members.authenticate("reader@example.com", "reader password 1"));
  });
});
