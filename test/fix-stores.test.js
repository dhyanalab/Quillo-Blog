// Store-layer tests for the security fixes: run with `node --test test/fix-stores.test.js`.
import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.js";
import { createStore } from "../src/store/index.js";
import { createSecrets } from "../src/web/secrets.js";
import { DUMMY_HASH, hashPassword, MAX_PASSWORD, needsRehash, verifyPassword } from "../src/web/password.js";
import { codeAt, looksLikeRecoveryCode, looksLikeTotpCode, newSecret, stepAt } from "../src/web/totp.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "stores-test-"));
const PW = "correct horse battery";

function setup({ secrets = true } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  const sec = secrets ? createSecrets(dir) : undefined;
  let changes = 0;
  const store = createStore(db, { basePath: "/blog", onChange: () => changes++, secrets: sec });
  return { dir, db, store, secrets: sec, changes: () => changes, resetChanges: () => (changes = 0) };
}

async function owner(store) {
  return store.users.createOwnerIfNone({ email: "owner@example.com", password: PW, name: "Owner One" });
}

const post = (store, userId, over = {}) =>
  store.posts.save({ title: "T", slug: "t", body_md: "body", author_id: userId, status: "draft", ...over }, { userId });

describe("password hashing", () => {
  test("hash, verify, caps and rehash detection", async () => {
    const h = await hashPassword(PW);
    assert.ok(await verifyPassword(PW, h));
    assert.ok(!(await verifyPassword("wrong password!", h)));
    await assert.rejects(() => hashPassword("short"));
    await assert.rejects(() => hashPassword("x".repeat(MAX_PASSWORD + 1)));
    assert.equal(await verifyPassword("x".repeat(MAX_PASSWORD + 1), h), false);
    assert.equal(needsRehash(h), false);
    assert.equal(needsRehash("scrypt$16384$8$1$AAAA$BBBB"), true);
    // The dummy hash uses the current cost, so unknown emails cost the same as known ones.
    assert.equal(DUMMY_HASH.split("$").slice(1, 4).join("$"), h.split("$").slice(1, 4).join("$"));
  });
});

describe("migration 006 on an existing database", () => {
  test("applies to a database built from migrations 1 to 5 and keeps its data", () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, "old.db"));
    db.exec("PRAGMA foreign_keys = ON");
    const migrations = path.join(import.meta.dirname, "../src/migrations");
    const files = fs.readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((f) => f < "006")) db.exec(fs.readFileSync(path.join(migrations, f), "utf8"));
    const t = new Date().toISOString();
    db.prepare("INSERT INTO users (email,password_hash,name,slug,role,created_at) VALUES ('a@x.com','h','A','a','owner',?)").run(t);
    db.prepare("INSERT INTO posts (slug,title,author_id,created_at,modified_at) VALUES ('p1','P1',1,?,?)").run(t, t);
    db.prepare("INSERT INTO members (email,name,password_hash,created_at) VALUES ('m@x.com','M','h',?)").run(t);
    db.prepare("INSERT INTO comments (post_id,member_id,body,created_at) VALUES (1,1,'one',?)").run(t);
    db.prepare("INSERT INTO comments (post_id,member_id,parent_id,body,created_at) VALUES (1,1,1,'reply',?)").run(t);
    db.prepare("INSERT INTO comment_likes VALUES (1,1)").run();
    db.prepare("INSERT INTO subscribers (email,created_at,token) VALUES ('s@x.com',?,'abc')").run(t);
    db.prepare("INSERT INTO redirects (from_path,to_path,created_at) VALUES ('/a/','/b/',?)").run(t);
    db.exec("BEGIN");
    db.exec(fs.readFileSync(path.join(migrations, "006_hardening.sql"), "utf8"));
    db.exec("COMMIT");
    assert.ok(db.prepare("SELECT verified_at FROM members").get().verified_at, "existing members are verified");
    assert.equal(db.prepare("SELECT status FROM subscribers").get().status, "active");
    assert.equal(db.prepare("SELECT source FROM redirects").get().source, "admin");
    assert.deepEqual(db.prepare("SELECT id, parent_id FROM comments ORDER BY id").all().map((r) => [r.id, r.parent_id]), [[1, null], [2, 1]]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comment_likes").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
  });
});

describe("users", () => {
  let ctx;
  before(() => {
    ctx = setup();
  });

  test("createOwnerIfNone is atomic: the second owner is refused", async () => {
    const { store } = ctx;
    const [a, b] = await Promise.all([
      store.users.createOwnerIfNone({ email: "o1@example.com", password: PW, name: "Owner One" }),
      store.users.createOwnerIfNone({ email: "o2@example.com", password: PW, name: "Owner Two" }),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
    assert.equal(store.users.list().filter((u) => u.role === "owner").length, 1);
    assert.equal(await store.users.createOwnerIfNone({ email: "o3@example.com", password: PW, name: "Three" }), null);
  });

  test("new staff must change their password; setPassword clears it and bumps auth_version", async () => {
    const { store } = ctx;
    const u = await store.users.create({ email: "ed@example.com", password: PW, name: "Ed Itor", role: "editor" }, { mustChange: true });
    assert.equal(u.mustChange, true);
    const v0 = store.users.getAuthVersion(u.id);
    const s = store.users.createSession(u.id);
    await store.users.setPassword(u.id, "another long password", { actor: u });
    assert.equal(store.users.get(u.id).mustChange, false);
    assert.equal(store.users.getAuthVersion(u.id), v0 + 1);
    assert.equal(store.users.getSession(s.token), null, "setPassword ends sessions");
    assert.equal(store.users.getAuthVersion(999999), null);
  });

  test("authenticate does not record a login; creating a session does", async () => {
    const { store } = ctx;
    const u = await store.users.create({ email: "login@example.com", password: PW, name: "Log In", role: "author" });
    assert.ok(await store.users.authenticate("login@example.com", PW));
    assert.equal(store.users.get(u.id).last_login_at, null);
    store.users.createSession(u.id, { ip: "1.2.3.4", userAgent: "x".repeat(400) });
    assert.ok(store.users.get(u.id).last_login_at);
    assert.equal(await store.users.authenticate("login@example.com", "wrong password!"), null);
    assert.equal(await store.users.authenticate("nobody@example.com", PW), null);
  });

  test("an old weaker hash is upgraded after a good sign-in", async () => {
    const { store, db } = ctx;
    const u = await store.users.create({ email: "old@example.com", password: PW, name: "Old Hash", role: "author" });
    const salt = crypto.randomBytes(16);
    const legacy = `scrypt$16384$8$1$${salt.toString("base64")}$${crypto.scryptSync(PW, salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64")}`;
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(legacy, u.id);
    assert.ok(await store.users.authenticate("old@example.com", PW));
    const after = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(u.id).password_hash;
    assert.notEqual(after, legacy);
    assert.equal(needsRehash(after), false);
    assert.ok(await store.users.authenticate("old@example.com", PW));
  });

  test("sessions: idle expiry, absolute expiry, touch, prune, end all, list and revoke", async () => {
    const { store, db } = ctx;
    const u = await store.users.create({ email: "sess@example.com", password: PW, name: "Sess Ion", role: "author" });
    const a = store.users.createSession(u.id, { ip: "9.9.9.9", userAgent: "ua" });
    assert.ok(store.users.getSession(a.token));
    const id = db.prepare("SELECT id FROM sessions WHERE user_id = ?").get(u.id).id;
    // Idle for three days: gone.
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(new Date(Date.now() - 3 * 864e5).toISOString(), id);
    assert.equal(store.users.getSession(a.token), null);
    // Seen 10 minutes ago: refreshed.
    const b = store.users.createSession(u.id);
    const bid = db.prepare("SELECT id FROM sessions WHERE user_id = ?").get(u.id).id;
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(old, bid);
    store.users.getSession(b.token);
    assert.ok(db.prepare("SELECT last_seen_at FROM sessions WHERE id = ?").get(bid).last_seen_at > old);
    // Past its 14 days: gone.
    db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), bid);
    assert.equal(store.users.getSession(b.token), null);
    // Prune removes expired and idle rows only.
    const keep = store.users.createSession(u.id);
    const idle = store.users.createSession(u.id);
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = (SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1)").run(new Date(Date.now() - 5 * 864e5).toISOString(), u.id);
    store.users.pruneSessions();
    assert.ok(store.users.getSession(keep.token));
    assert.equal(store.users.getSession(idle.token), null);
    assert.equal(store.users.listSessions(u.id).length, 1);
    const sid = store.users.listSessions(u.id)[0].id;
    assert.equal(store.users.revokeSession(u.id, sid), true);
    const c = store.users.createSession(u.id);
    store.users.createSession(u.id);
    store.users.endSession(c.token);
    assert.equal(store.users.getSession(c.token), null);
    store.users.endAllSessions(u.id);
    assert.equal(store.users.listSessions(u.id).length, 0);
  });

  test("two-step: secrets and recovery codes are sealed, enabling is conditional", async () => {
    const { store, db } = ctx;
    const u = await store.users.create({ email: "tfa@example.com", password: PW, name: "Two Step", role: "author" });
    const s = store.users.createSession(u.id);
    const secret = newSecret();
    store.users.setPendingSecret(db.prepare("SELECT id FROM sessions WHERE user_id = ?").get(u.id).id, secret);
    assert.ok(db.prepare("SELECT totp_pending FROM sessions WHERE user_id = ?").get(u.id).totp_pending.startsWith("v2:"));
    assert.equal(store.users.getSession(s.token).session.totp_pending, secret, "the session still reads the opened secret");

    const step = stepAt();
    const codes = store.users.enableTwoStep(u.id, secret, step);
    assert.equal(codes.length, 10);
    assert.equal(store.users.enableTwoStep(u.id, newSecret(), step), null, "a second enrolment can't overwrite the first");
    const row = db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(u.id);
    assert.ok(row.totp_secret.startsWith("v2:"));
    assert.notEqual(row.totp_secret, secret);
    assert.equal(store.users.get(u.id).twoStep, true);

    // A code works once.
    const code = codeAt(secret, step + 1);
    assert.equal(store.users.verifyTotp(u.id, code), true);
    assert.equal(store.users.verifyTotp(u.id, code), false);

    // Recovery codes are an HMAC of the code, not plain sha256, and work once.
    const hashes = db.prepare("SELECT code_hash FROM user_recovery_codes WHERE user_id = ?").all(u.id).map((r) => r.code_hash);
    const plain = codes[0].replace("-", "");
    assert.ok(!hashes.includes(crypto.createHash("sha256").update(plain).digest("hex")));
    assert.ok(hashes.includes(ctx.secrets.hmac(plain)));
    assert.equal(store.users.useRecoveryCode(u.id, codes[0].toLowerCase()), true);
    assert.equal(store.users.useRecoveryCode(u.id, codes[0]), false);
    assert.equal(store.users.twoStepStatus(u.id).codesLeft, 9);

    // A legacy sha256 row is no longer accepted.
    db.prepare("INSERT INTO user_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)").run(u.id, crypto.createHash("sha256").update("ABCDEFGHJK").digest("hex"), new Date().toISOString());
    assert.equal(store.users.useRecoveryCode(u.id, "ABCDE-FGHJK"), false);

    const v = store.users.getAuthVersion(u.id);
    store.users.disableTwoStep(u.id, { actor: u });
    assert.equal(store.users.getAuthVersion(u.id), v + 1);
    assert.equal(store.users.get(u.id).twoStep, false);
  });

  test("five wrong codes lock the second step for 15 minutes; success clears the count", async () => {
    const { store, db } = ctx;
    const u = await store.users.create({ email: "lock@example.com", password: PW, name: "Lock Out", role: "author" });
    const secret = newSecret();
    store.users.enableTwoStep(u.id, secret, 0);
    for (let i = 0; i < 4; i++) assert.deepEqual(store.users.recordTotpFailure(u.id), { locked: false });
    store.users.clearTotpFailures(u.id);
    for (let i = 0; i < 4; i++) store.users.recordTotpFailure(u.id);
    assert.equal(store.users.totpLocked(u.id), false);
    assert.deepEqual(store.users.recordTotpFailure(u.id), { locked: true });
    assert.equal(store.users.totpLocked(u.id), true);
    // While locked even a right code is refused.
    assert.equal(store.users.verifyTotp(u.id, codeAt(secret, stepAt())), false);
    // After the lock runs out the account works again and counting restarts.
    db.prepare("UPDATE users SET totp_locked_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), u.id);
    assert.equal(store.users.totpLocked(u.id), false);
    assert.deepEqual(store.users.recordTotpFailure(u.id), { locked: false });
    assert.equal(store.users.verifyTotp(u.id, codeAt(secret, stepAt())), true);
    store.users.clearTotpFailures(u.id);
    assert.equal(db.prepare("SELECT totp_failures FROM users WHERE id = ?").get(u.id).totp_failures, 0);
  });

  test("code routing goes by length", () => {
    assert.equal(looksLikeRecoveryCode("K7Q2M-XW4TP"), true);
    assert.equal(looksLikeRecoveryCode("123456"), false);
    assert.equal(looksLikeTotpCode("123 456"), true);
    assert.equal(looksLikeTotpCode("K7Q2MXW4TP"), false);
  });

  test("store invariants: the last owner stays, role/status changes end sessions, rank rules apply with an actor", async () => {
    const { store } = ctx;
    const o = store.users.list().find((u) => u.role === "owner");
    const system = { actor: "system" };
    assert.throws(() => store.users.update(o.id, { role: "admin" }, system), /at least one active owner/);
    assert.throws(() => store.users.update(o.id, { status: "suspended" }, system), /at least one active owner/);
    assert.throws(() => store.users.remove(o.id, undefined, system), /at least one active owner/);
    assert.throws(() => store.users.update(o.id, { role: "wizard" }, system), /Unknown role/);

    const admin = await store.users.create({ email: "adm@example.com", password: PW, name: "Adm In", role: "admin" });
    const peer = await store.users.create({ email: "adm2@example.com", password: PW, name: "Adm Two", role: "admin" });
    const author = await store.users.create({ email: "aut@example.com", password: PW, name: "Aut Hor", role: "author" });
    assert.throws(() => store.users.update(o.id, { name: "Hacked" }, { actor: admin }), /can't change/);
    assert.throws(() => store.users.update(peer.id, { email: "x@example.com" }, { actor: admin }), /can't change/);
    assert.throws(() => store.users.update(author.id, { role: "admin" }, { actor: admin }), /can't give/);
    assert.ok(store.users.update(author.id, { role: "editor" }, { actor: admin }));
    assert.ok(store.users.update(author.id, { role: "admin" }, { actor: o }));

    const s = store.users.createSession(author.id);
    const v = store.users.getAuthVersion(author.id);
    store.users.update(author.id, { status: "suspended" }, system);
    assert.equal(store.users.getSession(s.token), null);
    assert.equal(store.users.getAuthVersion(author.id), v + 1);
    store.users.update(author.id, { bio: "hi" }, system);
    assert.equal(store.users.getAuthVersion(author.id), v + 1, "a plain profile edit does not change auth_version");
  });
});

describe("secrets at rest", () => {
  test("existing plaintext two-step secrets and SMTP password are encrypted once at start-up", async () => {
    const dir = tmp();
    const db = openDb(dir);
    // Written by the old code (no secrets helper).
    const old = createStore(db, { basePath: "/blog" });
    const u = await old.users.create({ email: "p@example.com", password: PW, name: "Plain Text", role: "author" });
    const secret = newSecret();
    old.users.enableTwoStep(u.id, secret, 0);
    old.settings.set({ smtp_pass: "hunter2-hunter2" });
    assert.equal(db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(u.id).totp_secret, secret);
    // Started again with the real secrets.
    const sec = createSecrets(dir);
    const store = createStore(db, { basePath: "/blog", secrets: sec });
    assert.ok(db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(u.id).totp_secret.startsWith("v2:"));
    assert.ok(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get().value).startsWith("v2:"));
    assert.equal(store.users.verifyTotp(u.id, codeAt(secret, stepAt() + 1)), true);
    assert.equal(store.settings.getSecret("smtp_pass"), "hunter2-hunter2");
    // A third start leaves sealed values alone.
    const before = db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(u.id).totp_secret;
    createStore(db, { basePath: "/blog", secrets: sec });
    assert.equal(db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(u.id).totp_secret, before);
  });

  test("without a secrets helper everything still works (plain storage)", async () => {
    const { store, db } = setup({ secrets: false });
    const u = await store.users.create({ email: "n@example.com", password: PW, name: "No Secrets", role: "author" });
    const secret = newSecret();
    const codes = store.users.enableTwoStep(u.id, secret, 0);
    assert.equal(db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(u.id).totp_secret, secret);
    assert.equal(store.users.useRecoveryCode(u.id, codes[1]), true);
    store.settings.set({ smtp_pass: "abc-abc-abc" });
    assert.equal(store.settings.getSecret("smtp_pass"), "abc-abc-abc");
  });
});

describe("settings", () => {
  test("all() hides smtp_pass, getSecret opens it, set is all-or-nothing, corrupt rows are tolerated", () => {
    const { store, db } = setup();
    store.settings.set({ smtp_pass: "s3cret-pass-word", smtp_host: "mail.example.com" });
    const all = store.settings.all();
    assert.equal("smtp_pass" in all, false);
    assert.equal(all.smtp_pass_set, true);
    assert.equal(store.settings.get("smtp_pass"), "");
    assert.equal(store.settings.getSecret("smtp_pass"), "s3cret-pass-word");
    assert.ok(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get().value).startsWith("v2:"));
    assert.equal(all.smtp_host, "mail.example.com");
    assert.equal(store.settings.getSecret("site_title"), "");

    // Unknown key: nothing is saved, nothing changes.
    assert.throws(() => store.settings.set({ site_title: "Changed", nope: 1 }), /Unknown setting: nope/);
    assert.notEqual(store.settings.get("site_title"), "Changed");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'site_title'").get().n, 0);
    assert.throws(() => store.settings.set({ site_title: undefined }), /Invalid value/);

    // Clearing the password.
    store.settings.set({ smtp_pass: "" });
    assert.equal(store.settings.all().smtp_pass_set, false);
    assert.equal(store.settings.getSecret("smtp_pass"), "");

    // A corrupt row doesn't break loading.
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('site_title', '{not json')").run();
    store.settings.set({ org_name: "Acme" });
    assert.equal(store.settings.get("org_name"), "Acme");
    assert.equal(store.settings.get("site_title"), "IoT Studio Blog");
  });
});

describe("members and comments", () => {
  test("verification, reset tokens, sessions and prune", async () => {
    const { store, db } = setup();
    const m = await store.members.create({ email: "Reader@Example.com", name: "Reader", password: PW });
    assert.equal(m.verified_at, null);
    assert.equal(await store.members.authenticate("reader@example.com", PW), null, "unverified readers can't sign in");

    const t = store.members.startVerify(m.id);
    assert.match(t, /^[0-9a-f]{32}$/);
    assert.equal(db.prepare("SELECT verify_token_hash FROM members WHERE id = ?").get(m.id).verify_token_hash, crypto.createHash("sha256").update(t).digest("hex"));
    assert.equal(await store.members.verifyWithPassword("0".repeat(32), "some new password"), null);
    assert.equal(await store.members.verifyWithPassword("not a token", "some new password"), null);
    await assert.rejects(() => store.members.verifyWithPassword(t, "short"));
    assert.equal(store.members.byVerifyToken(t).id, m.id, "a bad password doesn't use the link up");
    assert.equal((await store.members.verifyWithPassword(t, PW)).id, m.id);
    assert.equal(await store.members.verifyWithPassword(t, PW), null, "single use");
    assert.ok(await store.members.authenticate("reader@example.com", PW));
    // Expired verify token.
    const t2 = store.members.startVerify(m.id, { force: true });
    db.prepare("UPDATE members SET verify_expires = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), m.id);
    assert.equal(await store.members.verifyWithPassword(t2, PW), null);

    // Reset: short password doesn't use the link up; the right one ends all sessions.
    const s = store.members.createSession(m.id);
    const r = store.members.startReset("reader@example.com").token;
    await assert.rejects(() => store.members.resetByToken(r, "short"));
    assert.equal((await store.members.resetByToken(r, "a brand new password")).id, m.id);
    assert.equal(await store.members.resetByToken(r, "another new password"), null, "single use");
    assert.equal(store.members.getSession(s.token), null);
    assert.ok(await store.members.authenticate("reader@example.com", "a brand new password"));
    const r2 = store.members.startReset(m.id, { force: true }).token;
    db.prepare("UPDATE members SET reset_expires = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), m.id);
    assert.equal(await store.members.resetByToken(r2, "yet another password"), null);

    // Sessions: idle 14 days / absolute 30 days, prune.
    const a = store.members.createSession(m.id);
    const b = store.members.createSession(m.id);
    const ids = db.prepare("SELECT id FROM member_sessions WHERE member_id = ? ORDER BY rowid").all(m.id).map((x) => x.id);
    db.prepare("UPDATE member_sessions SET last_seen_at = ? WHERE id = ?").run(new Date(Date.now() - 15 * 864e5).toISOString(), ids[0]);
    assert.equal(store.members.getSession(a.token), null);
    assert.ok(store.members.getSession(b.token));
    db.prepare("INSERT INTO member_sessions (id, member_id, csrf, created_at, expires_at, last_seen_at) VALUES ('x', ?, 'c', ?, ?, ?)").run(m.id, new Date().toISOString(), new Date(Date.now() - 1000).toISOString(), new Date().toISOString());
    store.members.pruneSessions();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM member_sessions").get().n, 1);
    store.members.endSession(b.token);
    assert.equal(store.members.getSession(b.token), null);
  });

  test("list escapes LIKE wildcards", async () => {
    const { store } = setup();
    await store.members.create({ email: "a_b@example.com", name: "Under", password: PW }, { verified: true });
    await store.members.create({ email: "axb@example.com", name: "Letter", password: PW }, { verified: true });
    assert.equal(store.members.list({ q: "a_b" }).total, 1);
    assert.equal(store.members.list({ q: "%" }).total, 0);
    assert.equal(store.members.list({ q: "a" }).total, 2);
  });

  test("comments: published-parent check, soft delete with replies, no cache flush on likes", async () => {
    const { store, resetChanges, changes } = setup();
    const o = await owner(store);
    const m = await store.members.create({ email: "c@example.com", name: "Commenter", password: PW }, { verified: true });
    const p = post(store, o.id, { status: "published", published_at: "2020-01-01T00:00:00.000Z" });
    const top = store.comments.add({ postId: p.id, memberId: m.id, body: "top" });
    const reply = store.comments.add({ postId: p.id, memberId: m.id, parentId: top.id, body: "reply" });
    const held = store.comments.add({ postId: p.id, memberId: m.id, body: "held", status: "pending" });
    assert.throws(() => store.comments.add({ postId: p.id, memberId: m.id, parentId: held.id, body: "x" }), /isn't available/);
    assert.throws(() => store.comments.add({ postId: p.id, memberId: m.id, parentId: 99999, body: "x" }), /isn't available/);
    const other = post(store, o.id, { slug: "other", status: "published", published_at: "2020-01-01T00:00:00.000Z" });
    assert.throws(() => store.comments.add({ postId: other.id, memberId: m.id, parentId: top.id, body: "x" }), /isn't available/);

    resetChanges();
    assert.equal(store.comments.toggleLike(top.id, m.id), true);
    assert.equal(store.comments.toggleLike(top.id, m.id), false);
    assert.equal(changes(), 0, "likes don't flush the page cache");

    // Removing a comment with a reply keeps a shell; the reply survives.
    store.comments.remove(top.id);
    const shell = store.comments.get(top.id);
    assert.equal(shell.status, "deleted");
    assert.equal(shell.body, "");
    assert.ok(store.comments.get(reply.id));
    const t = store.comments.thread(p.id);
    assert.equal(t.comments.length, 1);
    assert.equal(t.comments[0].status, "deleted");
    assert.equal(t.comments[0].replies.length, 1);
    assert.equal(t.count, 1);
    store.comments.setStatus(top.id, "published");
    assert.equal(store.comments.get(top.id).status, "deleted", "a removed comment can't be revived");
    // Removing the last reply takes the shell with it.
    store.comments.remove(reply.id);
    assert.equal(store.comments.get(top.id), null);
    assert.equal(store.comments.thread(p.id).comments.length, 0);
  });

  test("removing a reader keeps other people's replies, drops the subscription", async () => {
    const { store } = setup();
    const o = await owner(store);
    const a = await store.members.create({ email: "a@example.com", name: "Alice", password: PW }, { verified: true });
    const b = await store.members.create({ email: "b@example.com", name: "Bob", password: PW }, { verified: true });
    const p = post(store, o.id, { status: "published", published_at: "2020-01-01T00:00:00.000Z" });
    const c1 = store.comments.add({ postId: p.id, memberId: a.id, body: "alice with reply" });
    const c2 = store.comments.add({ postId: p.id, memberId: a.id, body: "alice alone" });
    const reply = store.comments.add({ postId: p.id, memberId: b.id, parentId: c1.id, body: "bob replies" });
    store.subscribers.add("a@example.com", "", { confirmed: true });
    store.subscribers.add("b@example.com", "", { confirmed: true });
    store.members.remove(a.id);
    assert.equal(store.members.get(a.id), null);
    assert.ok(store.comments.get(reply.id), "Bob's reply survives");
    assert.equal(store.comments.get(c1.id).status, "deleted");
    assert.equal(store.comments.get(c2.id), null);
    assert.equal(store.subscribers.getByEmail("a@example.com"), null);
    assert.ok(store.subscribers.getByEmail("b@example.com"));
  });
});

describe("subscribers (double opt-in)", () => {
  test("add / confirm / unsubscribe / resubscribe rules", () => {
    const { store, db } = setup();
    const s = store.subscribers;
    const r1 = s.add("New@Example.com", "/blog/x/", { name: "N" });
    assert.equal(r1.status, "pending");
    assert.equal(r1.created, true);
    assert.match(r1.confirmToken, /^[0-9a-f]{32}$/);
    assert.equal(r1.subscriber.confirm_token, r1.confirmToken);
    assert.equal(s.pendingCount(), 1);
    assert.equal(s.count(), 0);
    const row = db.prepare("SELECT confirm_token_hash, confirm_expires FROM subscribers WHERE email = 'new@example.com'").get();
    assert.equal(row.confirm_token_hash, crypto.createHash("sha256").update(r1.confirmToken).digest("hex"));
    assert.ok(Date.parse(row.confirm_expires) > Date.now() + 6 * 864e5);

    // A pending address gets a fresh token only once the last one is over 15 minutes old; the old one then stops working.
    const same = s.add("new@example.com", "");
    assert.equal(same.status, "pending");
    assert.equal(same.token, null, "no second mail within 15 minutes");
    db.prepare("UPDATE subscribers SET confirm_sent_at = ? WHERE email = 'new@example.com'").run(new Date(Date.now() - 16 * 60_000).toISOString());
    const r2 = s.add("new@example.com", "");
    assert.equal(r2.status, "pending");
    assert.equal(r2.created, false);
    assert.notEqual(r2.confirmToken, r1.confirmToken);
    assert.equal(s.confirm(r1.confirmToken), null);
    assert.equal(s.confirm("zzz"), null);
    const confirmed = s.confirm(r2.confirmToken);
    assert.equal(confirmed.status, "active");
    assert.equal(s.confirm(r2.confirmToken), null);

    // Active stays untouched.
    const r3 = s.add("new@example.com", "again");
    assert.equal(r3.status, "active");
    assert.equal(r3.created, false);
    assert.ok(!r3.confirmToken);

    // Unsubscribed is never changed by add(), not even with confirmed: true.
    s.unsubscribe(confirmed.id);
    for (const opts of [{}, { confirmed: true }]) {
      const r = s.add("new@example.com", "again", opts);
      assert.equal(r.status, "unsubscribed");
      assert.equal(r.created, false);
    }
    assert.equal(s.get(confirmed.id).status, "unsubscribed");
    // An old confirm link can't bring it back either.
    assert.equal(s.confirm(r2.confirmToken), null);
    assert.equal(s.get(confirmed.id).status, "unsubscribed");
    // Only resubscribe does.
    s.resubscribe(confirmed.id);
    assert.equal(s.get(confirmed.id).status, "active");

    // Admin import path: confirmed rows are active at once.
    const r4 = s.add("admin@example.com", "added by admin", { confirmed: true });
    assert.equal(r4.status, "active");
    assert.equal(r4.created, true);
    // Legacy third argument (a name) still works.
    assert.equal(s.add("legacy@example.com", "x", "Legacy Name").subscriber.name, "Legacy Name");
    // Expired confirm tokens fail.
    const r5 = s.add("late@example.com");
    db.prepare("UPDATE subscribers SET confirm_expires = ? WHERE email = 'late@example.com'").run(new Date(Date.now() - 1000).toISOString());
    assert.equal(s.confirm(r5.confirmToken), null);
  });

  test("all() and list exclude tokens, LIKE is escaped, removeByEmail works, token can't be null", () => {
    const { store, db } = setup();
    const s = store.subscribers;
    s.add("a_b@example.com", "", { confirmed: true });
    s.add("axb@example.com", "", { confirmed: true });
    assert.equal("token" in s.all()[0], false);
    assert.equal("confirm_token_hash" in s.all()[0], false);
    assert.equal("token" in s.list().rows[0], false);
    assert.equal(s.list({ q: "a_b" }).total, 1);
    assert.equal(s.list({ q: "%" }).total, 0);
    assert.equal(s.all({ limit: 1 }).length, 1);
    assert.equal(s.removeByEmail("A_B@example.com").changes, 1);
    assert.equal(s.count(), 1);
    assert.throws(() => db.prepare("INSERT INTO subscribers (email, token, created_at) VALUES ('t@example.com', NULL, 'x')").run(), /token is required/);
    const axb = s.getByEmail("axb@example.com");
    assert.equal("token" in axb, false);
    assert.equal(s.byUnsubscribeToken(s.unsubscribeToken(axb)).id, axb.id);
  });
});

describe("newsletters", () => {
  test("queue guard, pending/unsubscribed never queued, attempts and quarantine, finish stamps sent_at", async () => {
    const { store } = setup();
    const o = await owner(store);
    const s = store.subscribers;
    const act = s.add("act@example.com", "", { confirmed: true }).subscriber;
    s.add("pend@example.com");
    const gone = s.add("gone@example.com", "", { confirmed: true }).subscriber;
    s.unsubscribe(gone.id);
    const n = store.newsletters.save({ subject: "Hello", preheader: "", body_md: "Hi", postIds: [] }, 0, o.id);
    assert.equal(n.sent_at, null);

    assert.equal(store.newsletters.queue(n.id), true);
    assert.equal(store.newsletters.queue(n.id), false, "already sending");
    const q = store.newsletters.get(n.id);
    assert.equal(q.status, "sending");
    assert.equal(q.recipients, 1);
    assert.ok(q.started_at);
    assert.equal(q.sent_at, null);
    assert.equal(store.newsletters.nextBatch(n.id).length, 1);

    // Two failures leave it queued, the third quarantines it.
    store.newsletters.mark(n.id, act.id, false, "550 mailbox act@example.com unavailable");
    assert.equal(store.newsletters.nextBatch(n.id).length, 1);
    store.newsletters.mark(n.id, act.id, false, "again");
    assert.equal(store.newsletters.nextBatch(n.id).length, 1);
    store.newsletters.mark(n.id, act.id, false, "third");
    assert.equal(store.newsletters.nextBatch(n.id).length, 0);
    assert.equal(store.newsletters.get(n.id).failed_n, 1);
    assert.ok(!/@/.test(store.newsletters.get(n.id).last_error));

    store.newsletters.mark(n.id, act.id, false, "550 no such user act@example.com");
    assert.equal(store.newsletters.failures(n.id)[0].error.includes("act@example.com"), false);

    store.newsletters.finish(n.id);
    const done = store.newsletters.get(n.id);
    assert.equal(done.status, "failed");
    assert.ok(done.sent_at);
    assert.equal(store.newsletters.queue(n.id), true, "a failed newsletter can be queued again");

    // Retry gives failed recipients three more attempts, and a sent one can't be queued.
    store.newsletters.retry(n.id);
    assert.equal(store.newsletters.nextBatch(n.id).length, 1);
    store.newsletters.mark(n.id, act.id, true);
    store.newsletters.finish(n.id);
    assert.equal(store.newsletters.get(n.id).status, "sent");
    assert.equal(store.newsletters.queue(n.id), false);
    assert.equal(store.newsletters.queue(99999), false);
  });

  test("nextBatch orders by attempts, then id", async () => {
    const { store } = setup();
    const o = await owner(store);
    const a = store.subscribers.add("a@example.com", "", { confirmed: true }).subscriber;
    const b = store.subscribers.add("b@example.com", "", { confirmed: true }).subscriber;
    const n = store.newsletters.save({ subject: "S", preheader: "", body_md: "B", postIds: [] }, 0, o.id);
    store.newsletters.queue(n.id);
    store.newsletters.mark(n.id, a.id, false, "temporary");
    assert.deepEqual(store.newsletters.nextBatch(n.id).map((x) => x.id), [b.id, a.id]);
  });
});

describe("posts and redirects", () => {
  test("slug change makes an auto redirect; admin redirects are never overwritten or deleted", async () => {
    const { store, db } = setup();
    const o = await owner(store);
    const live = "2020-01-01T00:00:00.000Z";
    const p = post(store, o.id, { slug: "first", status: "published", published_at: live });
    store.redirects.save({ from_path: "/blog/second/", to_path: "/blog/elsewhere/", status_code: 301 }); // admin row
    assert.equal(store.redirects.getByPath("/blog/second/").source, "admin");

    // A draft saved at a slug that has an admin redirect leaves it alone.
    const draft = post(store, o.id, { slug: "second", title: "Draft" });
    assert.ok(store.redirects.find("/blog/second/"), "a draft doesn't delete the redirect");
    store.posts.remove(draft.id);
    // Even the live post taking that slug doesn't delete an admin row.
    store.posts.save({ slug: "second" }, { id: p.id, userId: o.id });
    const row = store.redirects.find("/blog/first/");
    assert.equal(row.source, "auto");
    assert.equal(row.to_path, "/blog/second/");
    assert.ok(store.redirects.find("/blog/second/"), "the admin row survives");
    assert.equal(store.redirects.find("/blog/second/").source, "admin");

    // Renaming back removes the automatic row at the slug it takes over, not admin rows.
    store.posts.save({ slug: "third" }, { id: p.id, userId: o.id });
    store.posts.save({ slug: "first" }, { id: p.id, userId: o.id });
    assert.equal(store.redirects.find("/blog/first/"), null, "an auto redirect at the live slug is dropped");
    assert.equal(store.redirects.find("/blog/second/").source, "admin");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM redirects WHERE source = 'auto'").get().n >= 1, true);

    // An admin 301 at the old slug isn't overwritten by a rename.
    store.redirects.save({ from_path: "/blog/first/", to_path: "/blog/admin-target/", status_code: 302 });
    store.posts.save({ slug: "fourth" }, { id: p.id, userId: o.id });
    const kept = store.redirects.find("/blog/first/");
    assert.equal(kept.to_path, "/blog/admin-target/");
    assert.equal(kept.source, "admin");
  });

  test("deleting a live post writes an auto 410 without touching admin rows", async () => {
    const { store } = setup();
    const o = await owner(store);
    const p = post(store, o.id, { slug: "gone", status: "published", published_at: "2020-01-01T00:00:00.000Z" });
    store.redirects.save({ from_path: "/blog/old-gone/", to_path: "/blog/gone/", status_code: 301 }); // admin row pointing at it
    store.posts.remove(p.id);
    const r = store.redirects.find("/blog/gone/");
    assert.equal(r.status_code, 410);
    assert.equal(r.source, "auto");
    const admin = store.redirects.find("/blog/old-gone/");
    assert.equal(admin.status_code, 301, "an admin redirect to the deleted post keeps its own code");
    assert.equal(admin.to_path, "/blog/gone/");
    // A draft leaves no tombstone.
    const d = post(store, o.id, { slug: "draft-gone" });
    store.posts.remove(d.id);
    assert.equal(store.redirects.find("/blog/draft-gone/"), null);
    // An admin rule at the slug is not replaced by the tombstone.
    const q = post(store, o.id, { slug: "ruled", status: "published", published_at: "2020-01-01T00:00:00.000Z" });
    store.redirects.save({ from_path: "/blog/ruled/", to_path: "/blog/new-home/", status_code: 301 });
    store.posts.remove(q.id);
    assert.equal(store.redirects.find("/blog/ruled/").to_path, "/blog/new-home/");
  });

  test("a 410 redirect doesn't rewrite other redirects; self-redirects are refused", () => {
    const { store } = setup();
    store.redirects.save({ from_path: "/a/", to_path: "/b/", status_code: 301 });
    store.redirects.save({ from_path: "/b/", to_path: "", status_code: 410 });
    assert.equal(store.redirects.find("/a/").to_path, "/b/");
    assert.equal(store.redirects.find("/a/").status_code, 301);
    assert.equal(store.redirects.find("/b/").status_code, 410);
    assert.throws(() => store.redirects.save({ from_path: "/z/", to_path: "/z/", status_code: 301 }), /itself/);
    // Chains collapse for ordinary redirects.
    store.redirects.save({ from_path: "/c/", to_path: "/a/", status_code: 301 });
    store.redirects.save({ from_path: "/a/", to_path: "/final/", status_code: 301 });
    assert.equal(store.redirects.find("/c/").to_path, "/final/");
  });

  test("drafts don't flush the page cache; live changes do", async () => {
    const { store, resetChanges, changes } = setup();
    const o = await owner(store);
    resetChanges();
    const d = post(store, o.id, { slug: "d1" });
    store.posts.save({ title: "Changed" }, { id: d.id, userId: o.id });
    assert.equal(changes(), 0);
    store.posts.save({ status: "published", published_at: "2020-01-01T00:00:00.000Z" }, { id: d.id, userId: o.id });
    assert.equal(changes(), 1);
    store.posts.save({ status: "draft" }, { id: d.id, userId: o.id });
    assert.equal(changes(), 2, "unpublishing flushes");
    store.posts.save({ title: "Still draft" }, { id: d.id, userId: o.id });
    assert.equal(changes(), 2);
    assert.equal(store.posts.get(d.id).everPublished, true);
    assert.equal(post(store, o.id, { slug: "d2" }).everPublished, false);
  });

  test("post ids are not reused after a delete; slugs are unique across posts and pages", async () => {
    const { store, db } = setup();
    const o = await owner(store);
    const a = post(store, o.id, { slug: "a" });
    const b = post(store, o.id, { slug: "b" });
    store.posts.remove(b.id);
    const c = post(store, o.id, { slug: "c" });
    assert.ok(c.id > b.id);
    store.posts.remove(c.id);
    store.posts.remove(a.id);
    assert.ok(post(store, o.id, { slug: "d" }).id > c.id);
    // Same slug as a page: the database refuses even without slugTaken.
    post(store, o.id, { slug: "about", type: "page" });
    assert.throws(() => post(store, o.id, { slug: "about", type: "post" }));
    assert.throws(() => db.prepare("UPDATE posts SET slug = 'about', type = 'post' WHERE slug = 'd'").run());
  });

  test("admin search escapes wildcards; list filters take bound ids", async () => {
    const { store } = setup();
    const o = await owner(store);
    post(store, o.id, { slug: "one", title: "100% done" });
    post(store, o.id, { slug: "two", title: "Plain title" });
    assert.equal(store.posts.listAdmin({ q: "%" }).total, 1);
    assert.equal(store.posts.listAdmin({ q: "n_t" }).total, 0);
    const cat = store.categories.save({ name: "Cat", slug: "cat" });
    post(store, o.id, { slug: "three", status: "published", published_at: "2020-01-01T00:00:00.000Z", category_id: cat.id });
    assert.equal(store.posts.listPublic({ categoryIds: [cat.id] }).length, 1);
    assert.equal(store.posts.listPublic({ excludeCategoryIds: [cat.id] }).length, 0);
    assert.equal(store.posts.listPublic({ excludeIds: [NaN, "1 OR 1=1", 9999] }).length, 1);
    assert.equal(store.posts.countPublic({ categoryIds: [Infinity, cat.id] }), 1);
  });
});

describe("taxonomy", () => {
  test("tags.ensure creates only when asked, caps names, reports unknown names", () => {
    const { store } = setup();
    store.tags.save({ name: "ESP32", slug: "esp32", description: "" });
    const r = store.tags.ensure(["ESP32", "Brand New", "x".repeat(100)], { create: false });
    assert.deepEqual(r.tags.map((t) => t.slug), ["esp32"]);
    assert.equal(r.unknown.length, 2);
    assert.equal(store.tags.getBySlug("brand-new"), null);

    const c = store.tags.ensure(["ESP32", "Brand New", "y".repeat(100), "  "], { create: true });
    assert.equal(c.tags.length, 3);
    assert.deepEqual(c.unknown, []);
    assert.equal(c.tags[2].name.length, 60);
    assert.ok(store.tags.getBySlug("brand-new"));

    // Older callers: no options means the array form that creates.
    const legacy = store.tags.ensure(["Legacy Tag"]);
    assert.ok(Array.isArray(legacy));
    assert.equal(legacy[0].slug, "legacy-tag");
    // At most 20 names per call.
    const many = store.tags.ensure(Array.from({ length: 30 }, (_, i) => `tag number ${i}`), { create: true });
    assert.equal(many.tags.length, 20);
  });

  test("categories nest one level only", () => {
    const { store } = setup();
    const top = store.categories.save({ name: "Top", slug: "top" });
    const child = store.categories.save({ name: "Child", slug: "child", parent_id: top.id });
    const other = store.categories.save({ name: "Other", slug: "other" });
    assert.throws(() => store.categories.save({ name: "Grandchild", slug: "gc", parent_id: child.id }), /one level/);
    assert.throws(() => store.categories.save({ name: "Top", slug: "top", parent_id: other.id }, top.id), /sub-categories/);
    assert.throws(() => store.categories.save({ name: "Self", slug: "self", parent_id: other.id }, other.id), /own parent/);
    assert.throws(() => store.categories.save({ name: "X", slug: "x", parent_id: 99999 }), /doesn't exist/);
    assert.equal(store.categories.parentProblem(other.id, top.id), "");
    assert.ok(store.categories.save({ name: "Other", slug: "other", parent_id: top.id }, other.id));
  });
});

describe("media", () => {
  test("setAlt caps and ignores undefined; usage covers category intros, newsletters and revisions", async () => {
    const { store } = setup();
    const o = await owner(store);
    const m = store.media.insert({ path: "2026/11/pic-abc.png", original_name: "pic.png", mime: "image/png", size: 10, alt: "keep" }, o.id);
    store.media.setAlt(m.id, undefined);
    assert.equal(store.media.get(m.id).alt, "keep");
    store.media.setAlt(m.id, "a".repeat(500));
    assert.equal(store.media.get(m.id).alt.length, 300);
    assert.equal(store.media.list({ q: "%" }).length, 0);

    assert.equal(store.media.usage(m).posts.length, 0);
    store.categories.save({ name: "Cat", slug: "cat", intro_md: `![x](/media/${m.path})` });
    store.newsletters.save({ subject: "News", preheader: "", body_md: `![x](/media/${m.path})`, postIds: [] }, 0, o.id);
    const p = post(store, o.id, { slug: "withpic", body_md: `![x](/media/${m.path})` });
    store.posts.save({ body_md: "no picture now" }, { id: p.id, userId: o.id });
    const u = store.media.usage(m);
    assert.equal(u.categories.length, 1);
    assert.equal(u.newsletters.length, 1);
    assert.equal(u.revisions.length, 1, "an older version of a post still shows it");
    assert.equal(u.posts.length, 3, "all uses are also listed in posts, so a delete check that reads only posts still refuses");
    assert.ok(u.posts.some((x) => /category intro/.test(x.title)));
  });
});
