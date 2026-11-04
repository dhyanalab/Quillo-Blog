// Reader accounts, round 2: password chosen at verification, known browsers, form tokens, redirects, limits, names, comments.
// Run: node --test test/fix2-members.test.js
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/web/app.js";
import { nameKey } from "../src/web/members.js";

const dirs = [];
function makeApp(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-members2-"));
  dirs.push(dataDir);
  const made = createApp({ dataDir, basePath: "/blog", siteUrl: "", outbound: false, production: true, mailTransport: { jsonTransport: true }, mailDelayMs: 0, setupToken: "test-setup", trustProxy: true, ...extra });
  const mail = { ready: true, sent: [] };
  made.ctx.mailer.ready = () => mail.ready;
  for (const k of ["sendVerifyMember", "sendAccountExists", "sendPasswordReset", "sendConfirmSubscription"]) {
    made.ctx.mailer[k] = async (...args) => {
      mail.sent.push({ kind: k, args });
      return true;
    };
  }
  return { ...made, mail, dataDir };
}

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

let ipN = 0;
const freshIp = () => `10.2.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

function client(made, ip = freshIp(), defaults = {}, origin = "http://localhost") {
  const j = jar();
  return {
    j,
    ip,
    async req(p, { method = "GET", form, headers = {}, body: raw } = {}) {
      const h = { origin, cookie: j.header(), "x-forwarded-for": ip, ...defaults, ...headers };
      let body = raw;
      if (form) {
        body = new URLSearchParams(form);
        h["content-type"] = "application/x-www-form-urlencoded";
      }
      const res = await made.app.request(`${origin}${p}`, { method, headers: h, body, redirect: "manual" });
      j.store(res);
      return res;
    },
  };
}
const hidden = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];
async function formToken(cl, p) {
  const res = await cl.req(p);
  return hidden(await res.text(), "_csrf");
}

const PASS = "correct horse battery";
const addMember = (made, { email, name = "Reader One", password = PASS, verified = true } = {}) => made.ctx.store.members.create({ email, name, password }, { verified });
async function signIn(cl, email, password = PASS, extra = {}) {
  const t = await formToken(cl, "/blog/signin/");
  return cl.req("/blog/signin/", { method: "POST", form: { _csrf: t, email, password, ...extra } });
}
async function signUp(cl, fields) {
  const t = await formToken(cl, "/blog/signup/");
  return cl.req("/blog/signup/", { method: "POST", form: { _csrf: t, name: "New Reader", ...fields } });
}
const tokenFrom = (made, kind) => made.mail.sent.filter((m) => m.kind === kind).at(-1).args[1].match(/\/(?:verify|reset)\/([^/]+)\//)[1];
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

after(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

describe("password chosen when the email is confirmed", () => {
  const made = makeApp();
  after(() => made.ctx.db.close());

  test("the sign-up form asks for a name and an email only", async () => {
    const res = await client(made).req("/blog/signup/");
    const text = await res.text();
    assert.doesNotMatch(text, /name="password"/);
    assert.match(text, /name="email"/);
  });

  test("the verify page shows the masked address and name, and the password is set by whoever presses the button", async () => {
    made.mail.sent.length = 0;
    const r = await signUp(client(made), { email: "carol@example.com", name: "Carol Reader" });
    assert.equal(r.status, 200);
    const token = tokenFrom(made, "sendVerifyMember");
    const row = made.ctx.store.members.getByEmail("carol@example.com");
    assert.equal(row.verified_at, null);

    const cl = client(made);
    const page = await cl.req(`/blog/verify/${token}/`);
    const text = await page.text();
    assert.equal(page.status, 200);
    assert.match(text, /Choose your password/);
    assert.match(text, /Carol Reader/);
    assert.match(text, /c\*\*\*@example\.com/);
    assert.doesNotMatch(text, /carol@example\.com/);
    assert.equal(page.headers.get("referrer-policy"), "strict-origin");
    const csrf = hidden(text, "_csrf");

    // No password: refused, the link stays usable.
    let res = await cl.req(`/blog/verify/${token}/`, { method: "POST", form: { _csrf: csrf } });
    assert.equal(res.status, 400);
    // The address's own name or local part is too easy.
    res = await cl.req(`/blog/verify/${token}/`, { method: "POST", form: { _csrf: csrf, password: "carol reader", confirm: "carol reader" } });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /too easy to guess/);
    res = await cl.req(`/blog/verify/${token}/`, { method: "POST", form: { _csrf: csrf, password: "a good long phrase", confirm: "another long phrase" } });
    assert.equal(res.status, 400);
    assert.equal(made.ctx.store.members.getByEmail("carol@example.com").verified_at, null);

    res = await cl.req(`/blog/verify/${token}/`, { method: "POST", form: { _csrf: csrf, password: "a good long phrase", confirm: "a good long phrase" } });
    assert.equal(res.status, 303);
    assert.ok(cl.j.cookies.get("mid"));
    assert.equal((await signIn(client(made), "carol@example.com", "a good long phrase")).status, 303);
  });

  test("an expired or unknown link shows a plain notice and no form", async () => {
    const page = await client(made).req("/blog/verify/0123456789abcdef0123456789abcdef/");
    assert.equal(page.status, 400);
    const text = await page.text();
    assert.match(text, /expired or was already used/);
    assert.doesNotMatch(text, /name="password"/);
  });

  test("a repeat sign-up never replaces a pending account's name or link", async () => {
    made.mail.sent.length = 0;
    await signUp(client(made), { email: "dave@example.com", name: "Dave First" });
    const first = tokenFrom(made, "sendVerifyMember");
    made.mail.sent.length = 0;
    const second = await signUp(client(made), { email: "dave@example.com", name: "Dave Second" });
    assert.equal(second.status, 200);
    await wait();
    assert.equal(made.mail.sent.length, 0);
    assert.equal(made.ctx.store.members.getByEmail("dave@example.com").name, "Dave First");
    const cl = client(made);
    const t = await formToken(cl, `/blog/verify/${first}/`);
    const res = await cl.req(`/blog/verify/${first}/`, { method: "POST", form: { _csrf: t, password: "the owner's phrase", confirm: "the owner's phrase" } });
    assert.equal(res.status, 303);
  });

  test("the reset form checks the password against the address and the name", async () => {
    await addMember(made, { email: "erin.reader@example.com", name: "Erin Readerson" });
    made.mail.sent.length = 0;
    const f = client(made);
    const ft = await formToken(f, "/blog/forgot/");
    await f.req("/blog/forgot/", { method: "POST", form: { _csrf: ft, email: "erin.reader@example.com" } });
    await wait();
    const token = tokenFrom(made, "sendPasswordReset");
    const cl = client(made);
    const csrf = await formToken(cl, `/blog/reset/${token}/`);
    for (const pw of ["erin readerson", "erin.reader@example.com"]) {
      const res = await cl.req(`/blog/reset/${token}/`, { method: "POST", form: { _csrf: csrf, password: pw, confirm: pw } });
      assert.equal(res.status, 400, pw);
      assert.match(await res.text(), /too easy to guess/);
    }
    const page = await cl.req(`/blog/reset/${token}/`);
    assert.equal(page.headers.get("referrer-policy"), "strict-origin");
    const ok = await cl.req(`/blog/reset/${token}/`, { method: "POST", form: { _csrf: csrf, password: "a fresh long phrase", confirm: "a fresh long phrase" } });
    assert.equal(ok.status, 303);
  });
});

describe("next can't be turned into an off-site address", () => {
  const made = makeApp({ basePath: "" });
  after(() => made.ctx.db.close());

  test("dot segments that collapse into a leading // go to the home page", async () => {
    await addMember(made, { email: "n@example.com" });
    const cl = client(made);
    const t = await formToken(cl, "/signin/");
    await cl.req("/signin/", { method: "POST", form: { _csrf: t, email: "n@example.com", password: PASS } });
    for (const next of ["/.//evil.example", "/a/..//evil.example", "/%2e//evil.example", "/.//admin/"]) {
      for (const page of ["/signin/", "/signup/"]) {
        const res = await cl.req(`${page}?next=${encodeURIComponent(next)}`);
        assert.equal(res.status, 302, `${page} ${next}`);
        assert.equal(res.headers.get("location"), "/", `${page} ${next}`);
      }
      const other = client(made);
      const tk = await formToken(other, "/signin/");
      const post = await other.req("/signin/", { method: "POST", form: { _csrf: tk, email: "n@example.com", password: PASS, next } });
      assert.equal(post.headers.get("location"), "/", next);
    }
    const ok = await cl.req("/signin/?next=%2Fa%2Fb%2F%3Fx%3D1");
    assert.equal(ok.headers.get("location"), "/a/b/?x=1");
  });
});

describe("pre-sign-in form tokens", () => {
  const made = makeApp();
  after(() => made.ctx.db.close());

  test("a token is <time>.<random>.<signature>, good for two hours", async () => {
    const cl = client(made);
    const t = await formToken(cl, "/blog/signin/");
    assert.match(t, /^\d{9,12}\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    const name = [...cl.j.cookies.keys()].find((k) => k.endsWith("fcsrf"));
    assert.equal(cl.j.cookies.get(name), t);
    // The same token comes back while it is fresh.
    assert.equal(await formToken(cl, "/blog/signin/"), t);

    const mint = (ageSeconds) => {
      const ts = Math.floor(Date.now() / 1000) - ageSeconds;
      const rand = "ab".repeat(16);
      return `${ts}.${rand}.${made.ctx.secrets.hmac(`fcsrf:${ts}.${rand}`)}`;
    };
    for (const [age, expect] of [[60, 303], [3 * 3600, 403]]) {
      const forged = mint(age);
      const c2 = client(made);
      await c2.req("/blog/signin/");
      c2.j.cookies.set(name, forged);
      await addMember(made, { email: `tok${age}@example.com` });
      const res = await c2.req("/blog/signin/", { method: "POST", form: { _csrf: forged, email: `tok${age}@example.com`, password: PASS } });
      assert.equal(res.status, expect, `age ${age}`);
    }
    // A valid-looking token with a wrong signature is refused.
    const bad = `${Math.floor(Date.now() / 1000)}.${"cd".repeat(16)}.${"0".repeat(64)}`;
    const c3 = client(made);
    await c3.req("/blog/signin/");
    c3.j.cookies.set(name, bad);
    assert.equal((await c3.req("/blog/signin/", { method: "POST", form: { _csrf: bad, email: "x@example.com", password: PASS } })).status, 403);
  });

  test("a malformed form body answers 400", async () => {
    const cl = client(made);
    const res = await cl.req("/blog/signin/", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=zzz" }, body: "this is not a multipart body" });
    assert.equal(res.status, 400);
  });
});

describe("sign-in limits and known browsers", () => {
  const made = makeApp();
  after(() => made.ctx.db.close());

  test("strangers can't pause a known browser; a new password forgets every known browser", async () => {
    await addMember(made, { email: "known@example.com" });
    const owner = client(made);
    assert.equal((await signIn(owner, "known@example.com")).status, 303);
    const kdName = [...owner.j.cookies.keys()].find((k) => k.endsWith("mkd"));
    assert.ok(kdName, "a known-browser cookie is set");
    owner.j.cookies.delete([...owner.j.cookies.keys()].find((k) => k.endsWith("mid")));

    for (let i = 0; i < 5; i++) assert.equal((await signIn(client(made), "known@example.com", `wrong guess ${i}`)).status, 401);
    // A stranger with the right password is now paused ...
    assert.equal((await signIn(client(made), "known@example.com")).status, 429);
    // ... but the known browser is not.
    assert.equal((await signIn(owner, "known@example.com")).status, 303);

    // Wrong passwords from the known browser are counted under that browser, five at a time.
    owner.j.cookies.delete([...owner.j.cookies.keys()].find((k) => k.endsWith("mid")));
    const results = [];
    for (let i = 0; i < 6; i++) results.push((await signIn(owner, "known@example.com", `bad ${i}`)).status);
    assert.deepEqual(results, [401, 401, 401, 401, 401, 429]);

    // A cookie made for another account doesn't help, and a changed password ends it.
    await addMember(made, { email: "other@example.com" });
    const row = made.ctx.store.members.getByEmail("known@example.com");
    const stolen = owner.j.cookies.get(kdName);
    const thief = client(made);
    await thief.req("/blog/signin/");
    thief.j.cookies.set(kdName, stolen);
    assert.equal((await signIn(thief, "other@example.com", "wrong guess")).status, 401);
    await made.ctx.store.members.setPassword(row.id, "a different long phrase");
    made.ctx.limiters.signinAccount.reset("known@example.com");
    const again = client(made);
    await again.req("/blog/signin/");
    again.j.cookies.set(kdName, stolen);
    for (let i = 0; i < 5; i++) await signIn(client(made), "known@example.com", `bad again ${i}`);
    assert.equal((await signIn(again, "known@example.com", "a different long phrase")).status, 429, "the old cookie no longer counts");
  });

  test("parallel guesses can't get more than five tries", async () => {
    await addMember(made, { email: "burst@example.com" });
    const clients = Array.from({ length: 10 }, () => client(made));
    const tokens = await Promise.all(clients.map((cl) => formToken(cl, "/blog/signin/")));
    const res = await Promise.all(clients.map((cl, i) => cl.req("/blog/signin/", { method: "POST", form: { _csrf: tokens[i], email: "burst@example.com", password: `wrong guess ${i}` } })));
    const statuses = res.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 5, statuses.join(","));
    assert.equal(statuses.filter((s) => s === 429).length, 5, statuses.join(","));
  });

  test("text that isn't an email doesn't create limiter keys", async () => {
    const before = made.ctx.limiters.signinAccount.size;
    const cl = client(made);
    for (let i = 0; i < 4; i++) await signIn(cl, `not an email ${i}`);
    if (before !== undefined) assert.equal(made.ctx.limiters.signinAccount.size, before);
  });

  test("a banned reader gets the same answer as a wrong password", async () => {
    const m = await addMember(made, { email: "banned@example.com" });
    made.ctx.store.members.setStatus(m.id, "banned");
    const res = await signIn(client(made), "banned@example.com");
    assert.equal(res.status, 401);
    assert.match(await res.text(), /don.t match an account/);
  });

  test("a busy password gate answers 503 with the plain message", async () => {
    await addMember(made, { email: "busy@example.com" });
    const orig = made.ctx.store.members.authenticate;
    made.ctx.store.members.authenticate = async () => {
      throw Object.assign(new Error("busy"), { code: "BUSY" });
    };
    const res = await signIn(client(made), "busy@example.com");
    made.ctx.store.members.authenticate = orig;
    assert.equal(res.status, 503);
    assert.match(await res.text(), /The site is busy right now\. Please try again in a minute\./);
  });
});

describe("sign-in notices", () => {
  const made = makeApp();
  after(() => made.ctx.db.close());

  test("inherited names are not notices", async () => {
    for (const ok of ["constructor", "__proto__", "toString"]) {
      const res = await client(made).req(`/blog/signin/?ok=${ok}`);
      assert.doesNotMatch(await res.text(), /class="notice notice-ok"/, ok);
    }
    await addMember(made, { email: "q@example.com" });
    const cl = client(made);
    await signIn(cl, "q@example.com");
    const page = await (await cl.req("/blog/account/?ok=constructor")).text();
    assert.doesNotMatch(page, /class="notice notice-ok"/);
    assert.doesNotMatch(page, /function Object/);
  });
});

describe("account page", () => {
  const made = makeApp();
  after(() => made.ctx.db.close());
  async function member(email, name = "Reader One") {
    await addMember(made, { email, name });
    const cl = client(made);
    await signIn(cl, email);
    cl.csrf = hidden(await (await cl.req("/blog/account/")).text(), "_csrf");
    return cl;
  }

  test("a name change clears only that reader's pages, and an unchanged name clears nothing", async () => {
    const cl = await member("name@example.com", "Name Reader");
    const row = made.ctx.store.members.getByEmail("name@example.com");
    const calls = [];
    const orig = made.ctx.cache.clearTag;
    const origClear = made.ctx.cache.clear;
    made.ctx.cache.clearTag = (t) => calls.push(t);
    let cleared = 0;
    made.ctx.cache.clear = () => cleared++;
    const rename = (name) => cl.req("/blog/account/name/", { method: "POST", form: { _csrf: cl.csrf, name } });
    assert.equal((await rename("Name Reader")).status, 303);
    assert.deepEqual(calls, []);
    assert.equal((await rename("Name Reader Two")).status, 303);
    assert.deepEqual(calls, [`member:${row.id}`]);
    assert.equal(cleared, 0);
    made.ctx.cache.clearTag = orig;
    made.ctx.cache.clear = origClear;
  });

  test("renaming is limited per reader, including the staff-name check", async () => {
    await made.ctx.store.users.create({ email: "st@example.com", name: "Sam Staff", password: PASS, role: "owner" });
    const cl = await member("rate@example.com", "Rate Reader");
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await cl.req("/blog/account/name/", { method: "POST", form: { _csrf: cl.csrf, name: "Sam Staff" } })).status);
    assert.equal(codes[0], 400);
    assert.equal(codes.at(-1), 429);
  });

  test("parallel wrong current passwords get at most five tries", async () => {
    const cl = await member("par@example.com", "Par Reader");
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => cl.req("/blog/account/password/", { method: "POST", form: { _csrf: cl.csrf, current: `wrong ${i}`, password: "a new passphrase!" } })));
    const s = res.map((r) => r.status);
    assert.equal(s.filter((x) => x === 400).length, 5, s.join(","));
    assert.equal(s.filter((x) => x === 429).length, 3, s.join(","));
  });

  test("password change and delete answer 503 when the password gate is busy", async () => {
    const cl = await member("busyacct@example.com", "Busy Reader");
    const orig = made.ctx.store.members.authenticate;
    made.ctx.store.members.authenticate = async () => {
      throw Object.assign(new Error("busy"), { code: "BUSY" });
    };
    const a = await cl.req("/blog/account/password/", { method: "POST", form: { _csrf: cl.csrf, current: PASS, password: "a new passphrase!" } });
    const b = await cl.req("/blog/account/delete/", { method: "POST", form: { _csrf: cl.csrf, password: PASS } });
    made.ctx.store.members.authenticate = orig;
    for (const r of [a, b]) {
      assert.equal(r.status, 503);
      assert.match(await r.text(), /The site is busy right now/);
    }
  });
});

describe("names", () => {
  test("look-alike letters, invisible fillers and spacing fold to one key", () => {
    const key = nameKey("Olive Owner");
    for (const n of ["Оlive Оwner", "o l i v e  o w n e r", "OLIVE.OWNER", "0live 0wner", "Olive​ Owner", "Olíve Ówner", "Ｏｌｉｖｅ Owner"]) assert.equal(nameKey(n), key, n);
    assert.notEqual(nameKey("Olive Owens"), key);
  });

  const made = makeApp();
  after(() => made.ctx.db.close());

  test("sign-up refuses a staff look-alike and a name made of invisible fillers", async () => {
    await made.ctx.store.users.create({ email: "staff@example.com", name: "Olive Owner", password: PASS, role: "owner" });
    for (const name of ["Оlive Оwner", "0live Owner", "Olive​Owner"]) {
      const res = await signUp(client(made), { email: "imp@example.com", name });
      assert.equal(res.status, 400, name);
      assert.match(await res.text(), /belongs to the site team/);
    }
    const blank = await signUp(client(made), { email: "blank@example.com", name: "ㅤㅤ" });
    assert.equal(blank.status, 400);
    assert.equal(made.ctx.store.members.getByEmail("blank@example.com"), null);
    assert.equal((await signUp(client(made), { email: "real@example.com", name: "Real Reader" })).status, 200);
  });
});

describe("comments", () => {
  const made = makeApp();
  let post;
  after(() => made.ctx.db.close());
  const setup = (async () => {
    const owner = await made.ctx.store.users.create({ email: "o@example.com", name: "Olive Owner", password: PASS, role: "owner" });
    made.ctx.store.settings.set({ comments_moderation: "none" });
    post = made.ctx.store.posts.save({ type: "post", status: "published", title: "A Post", slug: "a-post", excerpt: "Excerpt.", body_md: "Body.", author_id: owner.id });
  })();
  async function member(email, name) {
    await setup;
    await addMember(made, { email, name });
    const cl = client(made);
    await signIn(cl, email);
    cl.csrf = hidden(await (await cl.req("/blog/account/")).text(), "_csrf");
    return cl;
  }
  const comment = (cl, form) => cl.req("/blog/a-post/comments/", { method: "POST", form: { _csrf: cl.csrf, ...form } });

  test("format characters are stripped from a comment; an emoji sequence survives", async () => {
    const cl = await member("fmt@example.com", "Fmt Reader");
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const res = await comment(cl, { body: `he‮llo​ wor⁦ld ‍ ${family} ok` });
    assert.equal(res.status, 303);
    const saved = made.ctx.db.prepare("SELECT body FROM comments ORDER BY id DESC LIMIT 1").get().body;
    assert.equal(saved, `hello world  ${family} ok`);
  });

  test("a comment or a like clears only that post's cache tag", async () => {
    const cl = await member("tag@example.com", "Tag Reader");
    const calls = [];
    const orig = made.ctx.cache.clearTag;
    made.ctx.cache.clearTag = (t) => calls.push(t);
    const res = await comment(cl, { body: "Tagged" });
    assert.equal(res.status, 303);
    const id = made.ctx.db.prepare("SELECT id FROM comments ORDER BY id DESC LIMIT 1").get().id;
    await cl.req(`/blog/comments/${id}/like/`, { method: "POST", form: { _csrf: cl.csrf } });
    await cl.req(`/blog/comments/${id}/delete/`, { method: "POST", form: { _csrf: cl.csrf } });
    made.ctx.cache.clearTag = orig;
    assert.deepEqual(calls, [`post:${post.id}`, `post:${post.id}`, `post:${post.id}`]);
  });

  test("the waiting-comment cap counts per reader first and doesn't shut out readers with an approved comment", async () => {
    const seasoned = await member("seasoned@example.com", "Seasoned Reader");
    const fresh = await member("fresh@example.com", "Fresh Reader");
    const seasonedId = made.ctx.store.members.getByEmail("seasoned@example.com").id;
    const freshId = made.ctx.store.members.getByEmail("fresh@example.com").id;
    await comment(seasoned, { body: "An approved one" }); // moderation is off, so it publishes
    made.ctx.store.settings.set({ comments_moderation: "all" });
    made.ctx.site = ((orig) => () => ({ ...orig(), comments: { ...orig().comments, moderation: "all" } }))(made.ctx.site);
    const flood = await member("flood@example.com", "Flood Reader");
    const floodId = made.ctx.store.members.getByEmail("flood@example.com").id;
    for (let i = 0; i < 200; i++) made.ctx.store.comments.add({ postId: post.id, memberId: floodId, body: `Held ${i}`, status: "pending" });
    // A reader with an approved comment still gets in; the 10-per-reader cap holds for the flooder.
    let res = await comment(seasoned, { body: "Another from a seasoned reader" });
    assert.match(res.headers.get("location"), /c=pending/);
    res = await comment(flood, { body: "One more" });
    assert.match(res.headers.get("location"), /c=limit/);
    assert.ok(freshId && seasonedId);
    // A first-time reader is held back only by the per-post backstop.
    res = await comment(fresh, { body: "First ever" });
    assert.match(res.headers.get("location"), /c=limit/);
  });
});

describe("cookies on https", () => {
  test("reader cookies use the __Host- names and the known-browser cookie is set", async () => {
    const made = makeApp({ siteUrl: "https://example.com", basePath: "" });
    await addMember(made, { email: "h@example.com" });
    const cl = client(made, freshIp(), {}, "https://example.com");
    const page = await cl.req("/signin/");
    assert.ok(page.headers.getSetCookie().every((c) => c.startsWith("__Host-")), "the form cookie is __Host-");
    const t = hidden(await page.text(), "_csrf");
    const res = await cl.req("/signin/", { method: "POST", form: { _csrf: t, email: "h@example.com", password: PASS } });
    assert.equal(res.status, 303);
    const set = res.headers.getSetCookie();
    for (const base of ["mid", "mkd"]) {
      const c = set.find((x) => x.startsWith(`__Host-${base}=`));
      assert.ok(c, `${base} is set under __Host-`);
      assert.match(c, /Secure/i);
      assert.match(c, /HttpOnly/i);
      assert.match(c, /Path=\//);
    }
    made.ctx.db.close();
  });
});
