// Reader accounts after the security fixes: verified sign-up, sign-in, reset, sign-out, redirects, comments.
// Run: node --test test/fix-members.test.js
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/web/app.js";

const dirs = [];
function makeApp(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-members-"));
  dirs.push(dataDir);
  const made = createApp({ dataDir, basePath: "/blog", siteUrl: "", outbound: false, production: true, mailTransport: { jsonTransport: true }, mailDelayMs: 0, setupToken: "test-setup", trustProxy: true, ...extra });
  // Mail is spied on, not sent; "ready" is switched per test.
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
const freshIp = () => `10.1.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

function client(made, ip = freshIp(), defaults = {}) {
  const j = jar();
  return {
    j,
    ip,
    async req(p, { method = "GET", form, headers = {} } = {}) {
      const h = { origin: "http://localhost", cookie: j.header(), "x-forwarded-for": ip, ...defaults, ...headers };
      let body;
      if (form) {
        body = new URLSearchParams(form);
        h["content-type"] = "application/x-www-form-urlencoded";
      }
      const res = await made.app.request(`http://localhost${p}`, { method, headers: h, body, redirect: "manual" });
      j.store(res);
      return res;
    },
  };
}
const hidden = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];

// A page with a form: fetches it and returns its CSRF token.
async function formToken(cl, p) {
  const res = await cl.req(p);
  return hidden(await res.text(), "_csrf");
}

const PASS = "correct horse battery";
async function addMember(made, { email, name = "Reader One", password = PASS, verified = true } = {}) {
  return made.ctx.store.members.create({ email, name, password }, { verified });
}
async function signIn(cl, email, password = PASS, extra = {}) {
  const t = await formToken(cl, "/blog/signin/");
  return cl.req("/blog/signin/", { method: "POST", form: { _csrf: t, email, password, ...extra } });
}
async function signUp(cl, fields) {
  const t = await formToken(cl, "/blog/signup/");
  return cl.req("/blog/signup/", { method: "POST", form: { _csrf: t, name: "New Reader", ...fields } });
}
// Opens the emailed verify link and chooses the password (the sign-up form no longer asks for one).
async function verifyLink(cl, token, password = PASS, extra = {}) {
  const csrf = await formToken(cl, `/blog/verify/${token}/`);
  return cl.req(`/blog/verify/${token}/`, { method: "POST", form: { _csrf: csrf, password, confirm: password, ...extra } });
}

after(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

describe("sign-up needs a verified email", () => {
  let made;
  before(() => {
    made = makeApp();
  });
  after(() => made.ctx.db.close());

  test("sign-ups are closed while the mailer isn't ready", async () => {
    made.mail.ready = false;
    const cl = client(made);
    const page = await cl.req("/blog/signup/");
    assert.match(await page.text(), /open once the site.s email is set up/);
    const res = await signUp(cl, { email: "closed@example.com" });
    assert.ok([403, 503].includes(res.status));
    assert.equal(made.ctx.store.members.getByEmail("closed@example.com"), null);
    made.mail.ready = true;
  });

  test("a new and an existing address get the same response", async () => {
    made.mail.sent.length = 0;
    const a = await signUp(client(made), { email: "fresh@example.com" });
    const textA = await a.text();
    assert.equal(a.status, 200);
    assert.match(textA, /Check your inbox to finish signing up/);
    const verify = made.mail.sent.find((m) => m.kind === "sendVerifyMember");
    assert.ok(verify, "a verification email is sent");
    assert.match(verify.args[1], /\/blog\/verify\/[A-Za-z0-9_-]+\/$/);
    assert.equal(made.ctx.store.members.getByEmail("fresh@example.com").verified_at, null);

    // The same address again, in another case, from another visitor.
    made.mail.sent.length = 0;
    const b = await signUp(client(made), { email: "Fresh@Example.com", name: "Someone Else" });
    assert.equal(b.status, a.status);
    assert.equal(await b.text(), textA);

    // A verified member: same response again, and the owner gets the "already has an account" email.
    await addMember(made, { email: "has@example.com" });
    made.mail.sent.length = 0;
    const c = await signUp(client(made), { email: "has@example.com", name: "Another Name" });
    assert.equal(c.status, a.status);
    assert.equal(await c.text(), textA);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(made.mail.sent.some((m) => m.kind === "sendAccountExists"));
    assert.ok(!made.mail.sent.some((m) => m.kind === "sendVerifyMember"));
  });

  test("a later sign-up for an unverified address changes nothing and sends no new link", async () => {
    made.mail.sent.length = 0;
    await signUp(client(made), { email: "pre@example.com", name: "First Name" });
    assert.equal(made.mail.sent.filter((m) => m.kind === "sendVerifyMember").length, 1);
    const token = made.mail.sent[0].args[1].match(/verify\/([^/]+)\//)[1];
    made.mail.sent.length = 0;
    await signUp(client(made), { email: "pre@example.com", name: "Attacker Name" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(made.mail.sent.length, 0, "no second mail inside 15 minutes");
    assert.equal(made.ctx.store.members.getByEmail("pre@example.com").name, "First Name");
    // The first link still works, and the person who presses it chooses the password.
    const cl = client(made);
    assert.equal((await verifyLink(cl, token, "the owner's own phrase")).status, 303);
    assert.equal((await signIn(client(made), "pre@example.com", "the owner's own phrase")).status, 303);
  });

  test("passwords chosen from the verify link: 10 to 256 characters, and not a common one", async () => {
    made.mail.sent.length = 0;
    await signUp(client(made), { email: "short@example.com" });
    const token = made.mail.sent.find((m) => m.kind === "sendVerifyMember").args[1].match(/verify\/([^/]+)\//)[1];
    let res = await verifyLink(client(made), token, "123456789");
    assert.equal(res.status, 400);
    assert.match(await res.text(), /at least 10 characters/);
    res = await verifyLink(client(made), token, "x".repeat(257));
    assert.equal(res.status, 400);
    assert.match(await res.text(), /at most 256 characters/);
    res = await verifyLink(client(made), token, "password123");
    assert.equal(res.status, 400);
    assert.match(await res.text(), /too easy to guess/);
    assert.equal(made.ctx.store.members.getByEmail("short@example.com").verified_at, null);
  });

  test("a name can't match a staff member's name", async () => {
    await made.ctx.store.users.create({ email: "staff@example.com", name: "Olive Owner", password: PASS, role: "owner" });
    const res = await signUp(client(made), { email: "imposter@example.com", name: "  olive   OWNER " });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /belongs to the site team/);
    assert.equal(made.ctx.store.members.getByEmail("imposter@example.com"), null);

    await addMember(made, { email: "renamer@example.com", name: "Regular Reader" });
    const cl = client(made);
    await signIn(cl, "renamer@example.com");
    const csrf = hidden(await (await cl.req("/blog/account/")).text(), "_csrf");
    const r = await cl.req("/blog/account/name/", { method: "POST", form: { _csrf: csrf, name: "Olive Owner" } });
    assert.equal(r.status, 400);
  });

  test("sign-up, sign-in and account pages are private and skip analytics", async () => {
    const cl = client(made);
    for (const p of ["/blog/signin/", "/blog/signup/", "/blog/forgot/"]) {
      const res = await cl.req(p);
      assert.equal(res.headers.get("cache-control"), "private, no-store", p);
      assert.ok(!/analytics/i.test(res.headers.get("content-security-policy") || ""), p);
    }
    await addMember(made, { email: "acct@example.com" });
    await signIn(cl, "acct@example.com");
    const res = await cl.req("/blog/account/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control"), /no-store/);
  });
});

describe("sign-in", () => {
  let made;
  before(async () => {
    made = makeApp();
    await addMember(made, { email: "reader@example.com" });
  });
  after(() => made.ctx.db.close());

  test("the form token is signed: a planted cookie is refused", async () => {
    const cl = client(made);
    await cl.req("/blog/signin/");
    const forged = "a".repeat(32) + "." + "b".repeat(32);
    cl.j.cookies.set("fcsrf", forged);
    const res = await cl.req("/blog/signin/", { method: "POST", form: { _csrf: forged, email: "reader@example.com", password: PASS } });
    assert.equal(res.status, 403);
  });

  test("a cross-site post is refused", async () => {
    const cl = client(made);
    const t = await formToken(cl, "/blog/signin/");
    const res = await cl.req("/blog/signin/", { method: "POST", form: { _csrf: t, email: "reader@example.com", password: PASS }, headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
  });

  test("signing in destroys the session the browser already held", async () => {
    await addMember(made, { email: "second@example.com", name: "Second Reader" });
    const cl = client(made);
    let res = await signIn(cl, "reader@example.com");
    assert.equal(res.status, 303);
    const first = cl.j.cookies.get("mid");
    assert.ok(first);
    assert.ok(made.ctx.store.members.getSession(first));
    // A stale form: take the token while signed out, then post it with the old cookie back in place.
    cl.j.cookies.delete("mid");
    const t = await formToken(cl, "/blog/signin/");
    cl.j.cookies.set("mid", first);
    res = await cl.req("/blog/signin/", { method: "POST", form: { _csrf: t, email: "second@example.com", password: PASS } });
    assert.equal(res.status, 303);
    assert.notEqual(cl.j.cookies.get("mid"), first);
    assert.equal(made.ctx.store.members.getSession(first), null, "the first session is gone");
  });

  test("cookies are Secure on https", async () => {
    const secure = makeApp({ siteUrl: "https://example.com" });
    await addMember(secure, { email: "s@example.com" });
    const cl = client(secure, freshIp(), { origin: "https://example.com" });
    const res = await signIn(cl, "s@example.com");
    const cookie = res.headers.getSetCookie().find((c) => /^(__Host-)?mid=/.test(c));
    assert.ok(cookie, "signed in");
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /HttpOnly/i);
    secure.ctx.db.close();
  });

  test("five wrong passwords pause the account, even for the right password and another address", async () => {
    await addMember(made, { email: "target@example.com" });
    for (let i = 0; i < 5; i++) {
      const res = await signIn(client(made), "target@example.com", `wrong password ${i}`);
      assert.equal(res.status, 401);
    }
    const other = client(made);
    const res = await signIn(other, "target@example.com", PASS);
    assert.equal(res.status, 429);
    assert.equal(other.j.cookies.get("mid"), undefined);
    // A different account from the same new address is unaffected.
    assert.equal((await signIn(client(made), "reader@example.com")).status, 303);
  });

  test("one address is stopped after ten attempts, even across accounts", async () => {
    const ip = "10.9.9.9";
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await signIn(client(made, ip), `nobody${i}@example.com`, "whatever password")).status;
    assert.equal(last, 429);
  });

  test("next can't leave the site, even with control characters or backslashes", async () => {
    const bare = makeApp({ basePath: "" });
    await addMember(bare, { email: "n@example.com" });
    const attempts = ["/\t/evil.example", "/\n/evil.example", "//evil.example", "/\\evil.example", "https://evil.example/", "/admin/", "/admin", "/a/../admin/x"];
    for (const next of attempts) {
      const cl = client(bare);
      const t = await formToken(cl, "/signin/");
      const res = await cl.req("/signin/", { method: "POST", form: { _csrf: t, email: "n@example.com", password: PASS, next } });
      assert.equal(res.status, 303, next);
      assert.equal(res.headers.get("location"), "/", JSON.stringify(next));
    }
    // Signed-in visit with a bad next in the query.
    const cl = client(bare);
    await signInBare(cl);
    const res = await cl.req("/signin/?next=%2F%09%2Fevil.example");
    assert.equal(res.headers.get("location"), "/");
    // A normal one still works.
    const ok = client(bare);
    const tk = await formToken(ok, "/signin/");
    const good = await ok.req("/signin/", { method: "POST", form: { _csrf: tk, email: "n@example.com", password: PASS, next: "/some-post/?x=1#comments" } });
    assert.equal(good.headers.get("location"), "/some-post/?x=1#comments");
    bare.ctx.db.close();
    async function signInBare(c) {
      const tt = await formToken(c, "/signin/");
      return c.req("/signin/", { method: "POST", form: { _csrf: tt, email: "n@example.com", password: PASS } });
    }
  });

  test("with a base path, next stays under it and out of the admin", async () => {
    for (const next of ["/other/page/", "/blog/admin/posts", "/blog/admin"]) {
      const cl = client(made);
      const res = await signIn(cl, "reader@example.com", PASS, { next });
      assert.equal(res.headers.get("location"), "/blog/", next);
    }
    const cl = client(made);
    const res = await signIn(cl, "reader@example.com", PASS, { next: "/blog/hello/#comments" });
    assert.equal(res.headers.get("location"), "/blog/hello/#comments");
  });
});

describe("sign-out", () => {
  let made;
  before(async () => {
    made = makeApp();
    await addMember(made, { email: "out@example.com" });
  });
  after(() => made.ctx.db.close());

  test("a failed or cross-site sign-out keeps the cookie and the session", async () => {
    const cl = client(made);
    await signIn(cl, "out@example.com");
    const mid = cl.j.cookies.get("mid");
    let res = await cl.req("/blog/signout/", { method: "POST", form: { _csrf: "nope" } });
    assert.equal(res.status, 403);
    assert.equal(cl.j.cookies.get("mid"), mid);
    res = await cl.req("/blog/signout/", { method: "POST", form: { _csrf: "nope" }, headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(cl.j.cookies.get("mid"), mid);
    assert.ok(made.ctx.store.members.getSession(mid));
  });

  test("a real sign-out ends the session on the server", async () => {
    const cl = client(made);
    await signIn(cl, "out@example.com");
    const mid = cl.j.cookies.get("mid");
    const csrf = hidden(await (await cl.req("/blog/account/")).text(), "_csrf");
    const res = await cl.req("/blog/signout/", { method: "POST", form: { _csrf: csrf } });
    assert.equal(res.status, 303);
    assert.equal(cl.j.cookies.get("mid"), undefined);
    assert.equal(made.ctx.store.members.getSession(mid), null);
  });
});

describe("forgot and reset password", () => {
  let made;
  before(async () => {
    made = makeApp();
    await addMember(made, { email: "forgot@example.com" });
    await addMember(made, { email: "forgot-first@example.com" });
  });
  after(() => made.ctx.db.close());

  const forgot = async (email) => {
    const cl = client(made);
    const t = await formToken(cl, "/blog/forgot/");
    return cl.req("/blog/forgot/", { method: "POST", form: { _csrf: t, email } });
  };

  test("the answer is the same for known and unknown addresses", async () => {
    made.mail.sent.length = 0;
    const a = await forgot("forgot-first@example.com");
    const b = await forgot("nobody@example.com");
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const text = await a.text();
    assert.match(text, /If that address has an account, we.ve emailed a link/);
    assert.equal(await b.text(), text);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(made.mail.sent.filter((m) => m.kind === "sendPasswordReset").length, 1);
  });

  test("the reset link sets a new password and ends every session", async () => {
    const old = client(made);
    await signIn(old, "forgot@example.com");
    const oldMid = old.j.cookies.get("mid");
    made.mail.sent.length = 0;
    await forgot("forgot@example.com");
    await new Promise((r) => setTimeout(r, 20));
    const url = made.mail.sent.find((m) => m.kind === "sendPasswordReset").args[1];
    const token = url.match(/reset\/([^/]+)\//)[1];

    const cl = client(made);
    const page = await cl.req(`/blog/reset/${token}/`);
    assert.equal(page.status, 200);
    const csrf = hidden(await page.text(), "_csrf");
    let res = await cl.req(`/blog/reset/${token}/`, { method: "POST", form: { _csrf: csrf, password: "short", confirm: "short" } });
    assert.equal(res.status, 400);
    res = await cl.req(`/blog/reset/${token}/`, { method: "POST", form: { _csrf: csrf, password: "brand new passphrase", confirm: "different passphrase" } });
    assert.equal(res.status, 400);
    res = await cl.req(`/blog/reset/${token}/`, { method: "POST", form: { _csrf: csrf, password: "brand new passphrase", confirm: "brand new passphrase" } });
    assert.equal(res.status, 303);
    assert.equal(made.ctx.store.members.getSession(oldMid), null, "old sessions are gone");

    assert.equal((await signIn(client(made), "forgot@example.com", PASS)).status, 401);
    assert.equal((await signIn(client(made), "forgot@example.com", "brand new passphrase")).status, 303);

    // The link works once.
    const again = client(made);
    const t2 = await formToken(again, `/blog/reset/${token}/`);
    res = await again.req(`/blog/reset/${token}/`, { method: "POST", form: { _csrf: t2, password: "another new passphrase", confirm: "another new passphrase" } });
    assert.equal(res.status, 400);
  });
});

describe("account page", () => {
  let made;
  before(() => {
    made = makeApp();
  });
  after(() => made.ctx.db.close());

  test("wrong current passwords are limited per member", async () => {
    await addMember(made, { email: "pw@example.com" });
    const cl = client(made);
    await signIn(cl, "pw@example.com");
    const csrf = hidden(await (await cl.req("/blog/account/")).text(), "_csrf");
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await cl.req("/blog/account/password/", { method: "POST", form: { _csrf: csrf, current: `wrong ${i}`, password: "a new passphrase!" } })).status;
    assert.equal(last, 429);
    // Even the right password is paused now, then the account delete is too.
    const res = await cl.req("/blog/account/delete/", { method: "POST", form: { _csrf: csrf, password: PASS } });
    assert.equal(res.status, 429);
    assert.ok(made.ctx.store.members.getByEmail("pw@example.com"));
  });

  test("changing the password keeps you signed in on this device only", async () => {
    await addMember(made, { email: "chg@example.com" });
    const here = client(made);
    const there = client(made);
    await signIn(here, "chg@example.com");
    await signIn(there, "chg@example.com");
    const csrf = hidden(await (await here.req("/blog/account/")).text(), "_csrf");
    const res = await here.req("/blog/account/password/", { method: "POST", form: { _csrf: csrf, current: PASS, password: "a brand new passphrase" } });
    assert.equal(res.status, 303);
    assert.equal((await here.req("/blog/account/")).status, 200);
    assert.equal((await there.req("/blog/account/")).status, 302);
  });

  test("deleting the account also removes the newsletter subscription", async () => {
    await addMember(made, { email: "bye@example.com" });
    made.ctx.store.subscribers.add("bye@example.com", "test", { confirmed: true });
    assert.ok(made.ctx.db.prepare("SELECT 1 FROM subscribers WHERE email = ?").get("bye@example.com"));
    const cl = client(made);
    await signIn(cl, "bye@example.com");
    const csrf = hidden(await (await cl.req("/blog/account/")).text(), "_csrf");
    const res = await cl.req("/blog/account/delete/", { method: "POST", form: { _csrf: csrf, password: PASS } });
    assert.equal(res.status, 303);
    assert.equal(made.ctx.store.members.getByEmail("bye@example.com"), null);
    assert.equal(made.ctx.db.prepare("SELECT 1 FROM subscribers WHERE email = ?").get("bye@example.com"), undefined);
  });

  test("ticking the newsletter box starts a double opt-in once the email is verified", async () => {
    made.mail.sent.length = 0;
    await signUp(client(made), { email: "news@example.com", newsletter: "1" });
    const token = made.mail.sent.find((m) => m.kind === "sendVerifyMember").args[1].match(/verify\/([^/]+)\//)[1];
    assert.equal(made.ctx.db.prepare("SELECT 1 FROM subscribers WHERE email = ?").get("news@example.com"), undefined, "nothing before verification");
    const cl = client(made);
    await verifyLink(cl, token);
    const sub = made.ctx.db.prepare("SELECT status FROM subscribers WHERE email = ?").get("news@example.com");
    assert.equal(sub.status, "pending");
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(made.mail.sent.some((m) => m.kind === "sendConfirmSubscription"));
  });
});

describe("comments", () => {
  let made;
  let post;
  let ownerId;
  before(async () => {
    made = makeApp();
    const owner = await made.ctx.store.users.create({ email: "o@example.com", name: "Olive Owner", password: PASS, role: "owner" });
    ownerId = owner.id;
    made.ctx.store.settings.set({ comments_moderation: "none" });
    post = made.ctx.store.posts.save({ type: "post", status: "published", title: "A Post", slug: "a-post", excerpt: "Excerpt.", body_md: "Body.", author_id: ownerId });
    await addMember(made, { email: "c1@example.com", name: "Commenter One" });
    await addMember(made, { email: "c2@example.com", name: "Commenter Two" });
  });
  after(() => made.ctx.db.close());

  async function member(email) {
    const cl = client(made);
    await signIn(cl, email);
    cl.csrf = hidden(await (await cl.req("/blog/account/")).text(), "_csrf");
    return cl;
  }
  const comment = (cl, form) => cl.req("/blog/a-post/comments/", { method: "POST", form: { _csrf: cl.csrf, ...form } });

  test("a reply to a pending or hidden comment is refused", async () => {
    const cl = await member("c1@example.com");
    const top = made.ctx.store.comments.add({ postId: post.id, memberId: 1, body: "Held", status: "pending" });
    const before = made.ctx.store.comments.counts().total;
    const res = await comment(cl, { body: "Reply", parent_id: String(top.id) });
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /c=gone/);
    assert.equal(made.ctx.store.comments.counts().total, before);
  });

  test("likes and deletes answer alike for unknown and unseen comments", async () => {
    const cl = await member("c2@example.com");
    const hidden1 = made.ctx.store.comments.add({ postId: post.id, memberId: 1, body: "Hidden one", status: "hidden" });
    const unknown = await cl.req("/blog/comments/99999/like/", { method: "POST", form: { _csrf: cl.csrf } });
    const unseen = await cl.req(`/blog/comments/${hidden1.id}/like/`, { method: "POST", form: { _csrf: cl.csrf } });
    assert.equal(unknown.status, unseen.status);
    assert.equal(await unknown.text(), await unseen.text());
    const delUnknown = await cl.req("/blog/comments/99999/delete/", { method: "POST", form: { _csrf: cl.csrf } });
    const delOthers = await cl.req(`/blog/comments/${hidden1.id}/delete/`, { method: "POST", form: { _csrf: cl.csrf } });
    assert.equal(delUnknown.status, delOthers.status);
    assert.equal(await delUnknown.text(), await delOthers.text());
    assert.ok(made.ctx.store.comments.get(hidden1.id), "someone else's comment is untouched");
  });

  test("liking a comment doesn't clear the page cache", async () => {
    const cl = await member("c2@example.com");
    const shown = made.ctx.store.comments.add({ postId: post.id, memberId: 1, body: "Likeable", status: "published" });
    let cleared = 0;
    const orig = made.ctx.cache.clear;
    made.ctx.cache.clear = (...a) => {
      cleared++;
      return orig.apply(made.ctx.cache, a);
    };
    const res = await cl.req(`/blog/comments/${shown.id}/like/`, { method: "POST", form: { _csrf: cl.csrf } });
    assert.equal(res.status, 303);
    assert.equal(cleared, 0);
    made.ctx.cache.clear = orig;
  });

  test("a reader can delete their own comment after the post is unpublished", async () => {
    const cl = await member("c1@example.com");
    const mine = made.ctx.store.comments.add({ postId: post.id, memberId: made.ctx.store.members.getByEmail("c1@example.com").id, body: "Mine", status: "published" });
    made.ctx.store.posts.save({ ...post, status: "draft" }, { id: post.id });
    const res = await cl.req(`/blog/comments/${mine.id}/delete/`, { method: "POST", form: { _csrf: cl.csrf } });
    assert.equal(res.status, 303);
    assert.equal(made.ctx.store.comments.get(mine.id), null);
    made.ctx.store.posts.save({ ...post, status: "published" }, { id: post.id });
  });
});
