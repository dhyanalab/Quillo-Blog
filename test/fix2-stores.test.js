// Store-layer tests for security round 2: run with `node --test test/fix2-stores.test.js`.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.js";
import { createStore } from "../src/store/index.js";
import { createSecrets } from "../src/web/secrets.js";
import { gateLimits, gateState, hashPassword, verifyPassword } from "../src/web/password.js";
import { codeAt, newSecret, stepAt } from "../src/web/totp.js";
import { mayGrant, mayManage, outranks, RANK } from "../src/store/roles.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "stores2-test-"));
const PW = "correct horse battery";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const system = { actor: "system" };
const past = (ms) => new Date(Date.now() - ms).toISOString();
const live = "2020-01-01T00:00:00.000Z";

function setup({ secrets = true } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  const sec = secrets ? createSecrets(dir) : undefined;
  const store = createStore(db, { basePath: "/blog", onChange: () => {}, secrets: sec });
  return { dir, db, store, secrets: sec };
}
const owner = (store) => store.users.createOwnerIfNone({ email: "owner@example.com", password: PW, name: "Owner One" });
const staff = (store, name, role) => store.users.create({ email: `${name.toLowerCase().replace(/\W+/g, "")}@example.com`, password: PW, name, role });
const post = (store, userId, over = {}) => store.posts.save({ title: "T", slug: "t", body_md: "body", author_id: userId, status: "draft", ...over }, { userId });
const codeOf = (e) => e?.code;
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected code ${code}`);

describe("migration 007 on an existing database", () => {
  test("applies on top of 1 to 6 with real data and keeps it", () => {
    const dir = tmp();
    const db = new DatabaseSync(path.join(dir, "old.db"));
    db.exec("PRAGMA foreign_keys = ON");
    const migrations = path.join(import.meta.dirname, "../src/migrations");
    const files = fs.readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((f) => f < "007")) db.exec(fs.readFileSync(path.join(migrations, f), "utf8"));
    const t = new Date().toISOString();
    db.prepare("INSERT INTO users (email,password_hash,name,slug,role,created_at,totp_enabled_at,totp_secret,totp_last_step,password_must_change) VALUES ('a@x.com','h','A','a','owner',?,?,'s',77,1)").run(t, t);
    db.prepare("INSERT INTO users (email,password_hash,name,slug,role,created_at) VALUES ('b@x.com','h','B','b','author',?)").run(t);
    db.prepare("DELETE FROM users WHERE id = 2").run(); // id 2 is gone before the upgrade...
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO posts (slug,title,author_id,created_at,modified_at) VALUES ('p1','P1',2,?,?)").run(t, t); // ...but a post still names it
    db.prepare("INSERT INTO user_recovery_codes (user_id, code_hash, created_at) VALUES (1, 'abc', ?)").run(t);
    db.prepare("INSERT INTO members (email,name,password_hash,created_at,verify_token_hash,verify_expires) VALUES ('m@x.com','M','h',?, 'hh', ?)").run(t, new Date(Date.now() + 3600e3).toISOString());
    db.prepare("INSERT INTO media (path,original_name,mime,size,created_at) VALUES ('2026/11/a-0123456789abcdef.png','a','image/png',1,?)").run(t);
    db.prepare("INSERT INTO settings (key,value) VALUES ('logo_id','9')").run();
    db.prepare("INSERT INTO subscribers (email,created_at,token) VALUES ('s@x.com',?,'abc')").run(t);
    db.prepare("INSERT INTO redirects (from_path,to_path,created_at) VALUES ('/a/','/b/',?)").run(t);
    db.exec("BEGIN");
    db.exec(fs.readFileSync(path.join(migrations, "007_hardening2.sql"), "utf8"));
    db.exec("COMMIT");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_recovery_codes").get().n, 0, "old recovery codes are gone");
    assert.equal(db.prepare("SELECT recovery_codes_reset FROM users WHERE id = 1").get().recovery_codes_reset, 1);
    assert.equal(db.prepare("SELECT recovery_codes_reset FROM users WHERE slug = 'b' ").get(), undefined);
    assert.equal(db.prepare("SELECT totp_used_steps FROM users WHERE id = 1").get().totp_used_steps, "[77]");
    assert.ok(db.prepare("SELECT password_set_at FROM users WHERE id = 1").get().password_set_at, "a pending first password starts its 7 days now");
    assert.ok(db.prepare("SELECT verify_sent_at FROM members").get().verify_sent_at);
    const floor = (tbl) => db.prepare("SELECT max_id FROM id_floor WHERE tbl = ?").get(tbl).max_id;
    assert.equal(floor("users"), 2, "a deleted id that a post still names is remembered");
    assert.equal(floor("media"), 9, "a deleted media id that the settings still name is remembered");
    assert.equal(db.prepare("SELECT source FROM redirects").get().source, "admin");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM subscribers").get().n, 1);
    // Triggers keep the floor up, including through a cascade delete.
    db.prepare("INSERT INTO users (id,email,password_hash,name,slug,role,created_at) VALUES (3,'c@x.com','h','C','c','author',?)").run(t);
    assert.equal(floor("users"), 3);
    db.prepare("DELETE FROM users WHERE id = 3").run();
    assert.equal(floor("users"), 3);
    db.close();
  });

  test("a fresh database gets everything, and ids are never reused", async () => {
    const { store, db } = setup();
    const o = await owner(store);
    const a = await staff(store, "Ann Author", "author");
    store.users.remove(a.id, o.id, system);
    const b = await staff(store, "Bob Author", "author");
    assert.ok(b.id > a.id, "a deleted user's id is not handed out again");
    const m = await store.members.create({ email: "m1@example.com", name: "M1", password: PW });
    store.members.remove(m.id);
    const m2 = await store.members.create({ email: "m2@example.com", name: "M2", password: PW });
    assert.ok(m2.id > m.id);
    const p = post(store, o.id);
    const c1 = store.comments.add({ postId: p.id, memberId: m2.id, body: "one" });
    store.comments.remove(c1.id);
    const c2 = store.comments.add({ postId: p.id, memberId: m2.id, body: "two" });
    assert.ok(c2.id > c1.id);
    const x = store.media.insert({ path: "2026/11/x-aaaaaaaaaaaaaaaa.png", original_name: "x", mime: "image/png", size: 1 }, o.id);
    store.media.remove(x.id);
    const y = store.media.insert({ path: "2026/11/y-bbbbbbbbbbbbbbbb.png", original_name: "y", mime: "image/png", size: 1 }, o.id);
    assert.ok(y.id > x.id, "a deleted picture's id is not handed out again");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });
});

describe("password hashing capacity", () => {
  test("a full queue answers BUSY, and the cost ceiling is lowered", async () => {
    const saved = { ...gateLimits };
    try {
      gateLimits.running = 1;
      gateLimits.waiting = 1;
      const jobs = Array.from({ length: 4 }, () => hashPassword(PW).then(() => "ok", (e) => e.code));
      const out = await Promise.all(jobs);
      assert.deepEqual(out.filter((x) => x === "BUSY").length, 2, `two are turned away: ${out}`);
      assert.equal(out.filter((x) => x === "ok").length, 2);
      assert.deepEqual(gateState(), { running: 0, waiting: 0 });
      // verify is gated too, and a dummy check counts
      gateLimits.running = 1;
      gateLimits.waiting = 0;
      const h = await hashPassword(PW);
      const v = await Promise.all([verifyPassword(PW, h), verifyPassword(PW, h).catch((e) => e.code)]);
      assert.equal(v[0], true);
      assert.equal(v[1], "BUSY");
    } finally {
      Object.assign(gateLimits, saved);
    }
    // A stored hash that asks for more than 2^17 / r 16 / p 4 is refused outright, without allocating.
    const salt = Buffer.alloc(16, 1).toString("base64");
    const hash = Buffer.alloc(64, 2).toString("base64");
    assert.equal(await verifyPassword(PW, `scrypt$${2 ** 18}$8$1$${salt}$${hash}`), false);
    assert.equal(await verifyPassword(PW, `scrypt$16384$32$1$${salt}$${hash}`), false);
    assert.equal(await verifyPassword(PW, `scrypt$16384$8$16$${salt}$${hash}`), false);
  });

  test("an older, cheaper hash still verifies (and is padded to the same work)", async () => {
    const salt = crypto.randomBytes(16);
    const legacy = `scrypt$16384$8$1$${salt.toString("base64")}$${crypto.scryptSync(PW, salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64")}`;
    assert.equal(await verifyPassword(PW, legacy), true);
    assert.equal(await verifyPassword("wrong password!", legacy), false);
  });
});

describe("roles", () => {
  test("one ranking and the manage and grant rules", () => {
    assert.deepEqual(RANK, { owner: 5, admin: 4, editor: 3, author: 2, contributor: 1 });
    const o = { id: 1, role: "owner" };
    const a = { id: 2, role: "admin" };
    const a2 = { id: 3, role: "admin" };
    const e = { id: 4, role: "editor" };
    assert.equal(mayManage(o, a), true);
    assert.equal(mayManage(o, o), false, "never yourself");
    assert.equal(mayManage(a, e), true);
    assert.equal(mayManage(a, a2), false);
    assert.equal(mayManage(e, a), false);
    assert.equal(outranks(a, e), true);
    assert.equal(outranks(e, a), false);
    assert.equal(mayGrant(o, "admin"), true);
    assert.equal(mayGrant(o, "owner"), false);
    assert.equal(mayGrant(a, "editor"), true);
    assert.equal(mayGrant(a, "admin"), false);
    assert.equal(mayGrant(e, "author"), false, "below administrator nobody grants roles");
    assert.equal(mayManage({ role: "admin" }, "editor"), true, "role names work too");
  });
});

describe("users", () => {
  test("the store enforces the rules itself: actor required, rank, grants, strict status", async () => {
    const { store } = setup();
    const o = await owner(store);
    const admin = await staff(store, "Adm In", "admin");
    const admin2 = await staff(store, "Adm Two", "admin");
    const ed = await staff(store, "Ed Itor", "editor");
    throwsCode(() => store.users.update(ed.id, { bio: "x" }), "NO_ACTOR");
    throwsCode(() => store.users.update(ed.id, { bio: "x" }, { actor: null }), "NO_ACTOR");
    await assert.rejects(() => store.users.setPassword(ed.id, "a different password"), (e) => e.code === "NO_ACTOR");
    throwsCode(() => store.users.remove(ed.id), "NO_ACTOR");
    throwsCode(() => store.users.disableTwoStep(ed.id), "NO_ACTOR");
    throwsCode(() => store.users.update(admin2.id, { name: "Hacked" }, { actor: admin }), "FORBIDDEN");
    throwsCode(() => store.users.update(admin.id, { email: "new@example.com" }, { actor: ed }), "FORBIDDEN");
    await assert.rejects(() => store.users.setPassword(admin.id, "a different password", { actor: ed }), (e) => e.code === "FORBIDDEN");
    throwsCode(() => store.users.remove(admin.id, o.id, { actor: ed }), "FORBIDDEN");
    throwsCode(() => store.users.remove(ed.id, o.id, { actor: ed }), "FORBIDDEN");
    throwsCode(() => store.users.disableTwoStep(admin.id, { actor: ed }), "FORBIDDEN");
    throwsCode(() => store.users.update(ed.id, { role: "admin" }, { actor: admin }), "FORBIDDEN");
    throwsCode(() => store.users.update(ed.id, { role: "owner" }, { actor: o }), "FORBIDDEN", "even the owner can't hand out owner");
    throwsCode(() => store.users.update(admin.id, { role: "owner" }, { actor: admin }), "FORBIDDEN");
    throwsCode(() => store.users.update(admin.id, { status: "suspended" }, { actor: admin }), "FORBIDDEN");
    throwsCode(() => store.users.update(ed.id, { role: "owner" }, { actor: { id: 999, role: "owner" } }), "FORBIDDEN", "a made-up actor has no rank");
    assert.throws(() => store.users.update(ed.id, { status: "Active" }, system), /Unknown status/);
    assert.throws(() => store.users.update(ed.id, { status: "banned" }, system), /Unknown status/);
    assert.equal(store.users.update(ed.id, { role: "author" }, { actor: admin }).role, "author");
    // The owner can still do everything allowed.
    assert.equal(store.users.update(admin2.id, { status: "suspended" }, { actor: o }).status, "suspended");
    // A suspended actor has no rank any more.
    throwsCode(() => store.users.update(ed.id, { bio: "x" }, { actor: admin2 }), "FORBIDDEN");
    await assert.rejects(() => store.users.create({ email: "g@example.com", password: PW, name: "G", role: "admin" }, { actor: admin }), (e) => e.code === "FORBIDDEN");
    assert.ok(await store.users.create({ email: "g2@example.com", password: PW, name: "G2", role: "editor" }, { actor: admin }));
    // remove validates who takes the posts
    assert.throws(() => store.users.remove(ed.id, 99999, system), /active staff member/);
  });

  test("profile fields are checked in the store; an email change ends sessions", async () => {
    const { store, db } = setup();
    const o = await owner(store);
    const ed = await staff(store, "Ed Itor", "editor");
    assert.throws(() => store.users.update(ed.id, { slug: "Not A Slug" }, system), /lowercase words/);
    assert.throws(() => store.users.update(ed.id, { slug: o.slug }, system), /already taken/);
    assert.throws(() => store.users.update(ed.id, { links: ["javascript:alert(1)"] }, system), /web addresses/);
    assert.throws(() => store.users.update(ed.id, { links: "https://a.example" }, system), /web addresses/);
    assert.throws(() => store.users.update(ed.id, { photo_id: 12345 }, system), /can't be used/);
    assert.throws(() => store.users.update(ed.id, { name: "   " }, system), /name is needed/);
    assert.throws(() => store.users.update(ed.id, { bio: "x".repeat(6000) }, system), /too long/);
    assert.equal(store.users.update(ed.id, { slug: "ed-the-editor", links: ["https://a.example/x"] }, system).slug, "ed-the-editor");
    const s = store.users.createSession(ed.id);
    const v = store.users.getAuthVersion(ed.id);
    store.users.update(ed.id, { email: "ed2@example.com" }, system);
    assert.equal(store.users.getSession(s.token), null, "an email change ends sessions");
    assert.equal(store.users.getAuthVersion(ed.id), v + 1);
    const hidden = store.users.get(ed.id);
    for (const k of ["totp_failures", "totp_locked_until", "auth_version", "password_hash", "totp_secret", "totp_used_steps"]) assert.equal(k in hidden, false, k);
    assert.equal(store.users.list().some((u) => "auth_version" in u), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  });

  test("passwords set by someone else are temporary; your own is yours; no reuse", async () => {
    const { store, db } = setup();
    const o = await owner(store);
    const ed = await staff(store, "Ed Itor", "editor");
    await assert.rejects(() => store.users.setPassword(ed.id, PW, { actor: o }), (e) => e.code === "SAME_PASSWORD");
    await store.users.setPassword(ed.id, "temporary password one", { actor: o });
    assert.equal(store.users.get(ed.id).mustChange, true, "set by another person: must change");
    assert.ok(store.users.get(ed.id).passwordSetAt);
    assert.ok(await store.users.authenticate("editor@example.com", "temporary password one"));
    db.prepare("UPDATE users SET password_set_at = ? WHERE id = ?").run(past(8 * 864e5), ed.id);
    await assert.rejects(() => store.users.authenticate("editor@example.com", "temporary password one"), (e) => e.code === "PASSWORD_EXPIRED" && /expired/.test(e.message));
    assert.equal(await store.users.authenticate("editor@example.com", "wrong password!!"), null, "a wrong password still just fails");
    // choosing your own clears it
    db.prepare("UPDATE users SET password_set_at = ? WHERE id = ?").run(past(1000), ed.id);
    await store.users.setPassword(ed.id, "my own new password", { actor: ed });
    assert.equal(store.users.get(ed.id).mustChange, false);
    assert.ok(await store.users.authenticate("editor@example.com", "my own new password"));
    // the command-line tool's passwords are temporary too
    await store.users.setPassword(ed.id, "printed on a screen", system);
    assert.equal(store.users.get(ed.id).mustChange, true);
    // a first password for a new account expires as well
    const n = await store.users.create({ email: "new@example.com", password: "first password given", name: "New", role: "author" }, { mustChange: true });
    db.prepare("UPDATE users SET password_set_at = ? WHERE id = ?").run(past(8 * 864e5), n.id);
    await assert.rejects(() => store.users.authenticate("new@example.com", "first password given"), (e) => e.code === "PASSWORD_EXPIRED");
  });

  test("two-step: old recovery codes are not accepted, the flag clears, spent codes work without the lock", async () => {
    const { store, db, secrets } = setup();
    const o = await owner(store);
    const secret = newSecret();
    const codes = store.users.enableTwoStep(o.id, secret, 0);
    // a sha256 row of a code never works
    db.prepare("INSERT INTO user_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)").run(o.id, sha("ABCDEFGHJK"), new Date().toISOString());
    assert.equal(store.users.useRecoveryCode(o.id, "ABCDE-FGHJK"), false);
    // the lock doesn't block recovery codes; it blocks verifyTotp unless asked to ignore it
    for (let i = 0; i < 5; i++) store.users.recordTotpFailure(o.id);
    assert.equal(store.users.totpLocked(o.id), true);
    assert.equal(store.users.verifyTotp(o.id, codeAt(secret, stepAt())), false);
    assert.equal(store.users.verifyTotp(o.id, codeAt(secret, stepAt()), { ignoreLock: true }), true);
    assert.equal(store.users.useRecoveryCode(o.id, codes[0]), true);
    assert.equal(store.users.useRecoveryCode(o.id, codes[0]), false);
    // the "old codes removed" flag clears when new codes are made
    db.prepare("UPDATE users SET recovery_codes_reset = 1 WHERE id = ?").run(o.id);
    assert.equal(store.users.get(o.id).recoveryCodesReset, true);
    assert.equal(store.users.twoStepStatus(o.id).recoveryCodesReset, true);
    store.users.newRecoveryCodes(o.id);
    assert.equal(store.users.get(o.id).recoveryCodesReset, false);
    assert.ok(db.prepare("SELECT code_hash FROM user_recovery_codes WHERE user_id = ?").all(o.id).every((r) => /^[0-9a-f]{64}$/.test(r.code_hash)));
    assert.ok(secrets);
  });

  test("a code from the next step, used early, doesn't block the real current code", async () => {
    const { store } = setup();
    const o = await owner(store);
    const secret = newSecret();
    store.users.enableTwoStep(o.id, secret, 0);
    const step = stepAt();
    assert.equal(store.users.verifyTotp(o.id, codeAt(secret, step + 1)), true);
    assert.equal(store.users.verifyTotp(o.id, codeAt(secret, step + 1)), false, "but it works once");
    assert.equal(store.users.verifyTotp(o.id, codeAt(secret, step)), true, "the current code still works");
    assert.equal(store.users.verifyTotp(o.id, codeAt(secret, step)), false);
    assert.equal(store.users.verifyTotp(o.id, codeAt(secret, step - 1)), true);
  });

  test("turning two-step off clears a pending enrolment; sessions are capped, listed and rotated", async () => {
    const { store, db } = setup();
    const o = await owner(store);
    const s = store.users.createSession(o.id);
    const sid = db.prepare("SELECT id FROM sessions WHERE user_id = ?").get(o.id).id;
    store.users.setPendingSecret(sid, newSecret());
    store.users.enableTwoStep(o.id, newSecret(), 0); // clears pending itself...
    store.users.setPendingSecret(sid, newSecret()); // ...so set it again, as a half-finished new set-up
    store.users.disableTwoStep(o.id, { actor: o });
    assert.equal(db.prepare("SELECT totp_pending FROM sessions WHERE id = ?").get(sid).totp_pending, null);

    for (let i = 0; i < 14; i++) store.users.createSession(o.id);
    assert.equal(store.users.listSessions(o.id).length, 10, "at most 10 devices");
    const rotated = store.users.rotateSession(s.token);
    assert.equal(rotated, null, "the oldest session was already pushed out");
    const fresh = store.users.createSession(o.id);
    const r = store.users.rotateSession(fresh.token);
    assert.ok(r.token && r.token !== fresh.token && r.csrf !== fresh.csrf);
    assert.equal(store.users.getSession(fresh.token), null, "the old cookie no longer works");
    assert.ok(store.users.getSession(r.token));
    assert.equal(r.expires, fresh.expires, "the end date is kept");
  });

  test("revokeAccess ends sessions, removes recovery codes and bumps auth_version", async () => {
    const { store, db } = setup();
    const o = await owner(store);
    const ed = await staff(store, "Ed Itor", "editor");
    store.users.enableTwoStep(ed.id, newSecret(), 0);
    store.users.createSession(ed.id);
    const v = store.users.getAuthVersion(ed.id);
    throwsCode(() => store.users.revokeAccess(ed.id, { actor: ed }) && store.users.revokeAccess(null, { actor: ed }), "FORBIDDEN");
    assert.equal(store.users.revokeAccess(null, system), 2);
    assert.equal(store.users.getAuthVersion(ed.id), v + 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_recovery_codes").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
    assert.equal(store.users.get(ed.id).recoveryCodesReset, true);
    assert.ok(o);
  });
});

describe("readers", () => {
  test("sign-up leaves an unverified account alone and issues a link at most every 15 minutes", async () => {
    const { store, db } = setup();
    const first = store.members.signup({ email: "New@Example.com", name: "First Person", newsletter: true });
    assert.match(first.token, /^[0-9a-f]{32}$/);
    assert.equal(first.member.email, "new@example.com");
    assert.equal(first.member.password_hash, "", "no password yet");
    assert.equal(first.member.verified_at, null);
    // someone else signs up with the same address: nothing changes, no new token
    const again = store.members.signup({ email: "new@example.com", name: "Attacker", newsletter: false });
    assert.equal(again.token, null);
    assert.equal(again.existing, undefined);
    assert.equal(store.members.getByEmail("new@example.com").name, "First Person");
    assert.equal(store.members.byVerifyToken(first.token).id, first.member.id, "the first link still works");
    // after 15 minutes a new link replaces the old one
    db.prepare("UPDATE members SET verify_sent_at = ? WHERE id = ?").run(past(16 * 60_000), first.member.id);
    const third = store.members.signup({ email: "new@example.com", name: "x" });
    assert.ok(third.token && third.token !== first.token);
    assert.equal(store.members.byVerifyToken(first.token), null);
    // an expired link counts as none
    db.prepare("UPDATE members SET verify_expires = ? WHERE id = ?").run(past(1000), first.member.id);
    assert.ok(store.members.signup({ email: "new@example.com", name: "x" }).token);
    // verify with a password
    const t = store.members.signup({ email: "new@example.com", name: "x" }).token ?? store.members.startVerify(first.member.id, { force: true });
    const verified = await store.members.verifyWithPassword(t, "my chosen password");
    assert.ok(verified.verified_at);
    assert.ok(await store.members.authenticate("new@example.com", "my chosen password"));
    // a verified account answers existing
    const known = store.members.signup({ email: "new@example.com", name: "Someone" });
    assert.deepEqual([known.token, known.existing], [null, true]);
    assert.equal(store.members.getByEmail("new@example.com").name, "First Person");
  });

  test("an old pending account with a password gets the new flow: the old hash is replaced", async () => {
    const { store } = setup();
    const m = await store.members.create({ email: "old@example.com", name: "Old", password: "attackers choice" });
    const { token } = store.members.signup({ email: "old@example.com", name: "x" });
    const v = await store.members.verifyWithPassword(token, "the real owner choice");
    assert.ok(v);
    assert.equal(await store.members.authenticate("old@example.com", "attackers choice"), null);
    assert.ok(await store.members.authenticate("old@example.com", "the real owner choice"));
    assert.ok(m);
  });

  test("reset links follow the same 15 minute rule and the link is checked before any hashing", async () => {
    const { store, db } = setup();
    const m = await store.members.create({ email: "r@example.com", name: "R", password: PW }, { verified: true });
    assert.deepEqual(store.members.startReset("nobody@example.com"), { member: null, token: null });
    const a = store.members.startReset("R@example.com");
    assert.equal(a.member.id, m.id);
    assert.match(a.token, /^[0-9a-f]{32}$/);
    assert.equal(store.members.startReset("r@example.com").token, null);
    assert.equal(store.members.byResetToken(a.token).id, m.id);
    db.prepare("UPDATE members SET reset_sent_at = ? WHERE id = ?").run(past(16 * 60_000), m.id);
    const b = store.members.startReset("r@example.com").token;
    assert.ok(b && b !== a.token);
    assert.equal(await store.members.resetByToken("f".repeat(32), "whatever it is now"), null);
    assert.equal(await store.members.resetByToken(a.token, "whatever it is now"), null, "the replaced link is dead");
    assert.ok(await store.members.resetByToken(b, "whatever it is now"));
  });

  test("deleting a reader keeps opt-outs and other people's subscriptions, and cleans up shells and likes", async () => {
    const { store, db } = setup();
    const o = await owner(store);
    const p = post(store, o.id);
    // verified reader with an active subscription: it goes; an unsubscribed record stays
    const v = await store.members.create({ email: "v@example.com", name: "V", password: PW }, { verified: true });
    store.subscribers.add("v@example.com", "", { confirmed: true });
    const u = await store.members.create({ email: "u@example.com", name: "U", password: PW }, { verified: true });
    const us = store.subscribers.add("u@example.com", "", { confirmed: true }).subscriber;
    store.subscribers.unsubscribe(us.id);
    // unverified account whose address belongs to a real subscriber: the subscription stays
    await store.members.create({ email: "w@example.com", name: "W", password: PW });
    store.subscribers.add("w@example.com", "", { confirmed: true });
    store.members.remove(v.id);
    store.members.remove(u.id);
    store.members.remove(store.members.getByEmail("w@example.com").id);
    assert.equal(store.subscribers.getByEmail("v@example.com"), null);
    assert.equal(store.subscribers.getByEmail("u@example.com").status, "unsubscribed");
    assert.equal(store.subscribers.getByEmail("w@example.com").status, "active");

    // a comment whose only reply was by the same reader: the shell goes too, and so do likes on removed comments
    const a = await store.members.create({ email: "a@example.com", name: "A", password: PW }, { verified: true });
    const b = await store.members.create({ email: "b@example.com", name: "B", password: PW }, { verified: true });
    const top = store.comments.add({ postId: p.id, memberId: a.id, body: "top" });
    const mine = store.comments.add({ postId: p.id, memberId: a.id, parentId: top.id, body: "reply by me" });
    store.comments.toggleLike(top.id, b.id);
    store.members.remove(a.id);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comments").get().n, 0, "no hidden empty shell is left");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comment_likes").get().n, 0);
    assert.ok(mine);
  });

  test("comments: replies go one level deep; the thread shows the newest rows", async () => {
    const { store, db } = setup();
    const o = await owner(store);
    const p = post(store, o.id);
    const m = await store.members.create({ email: "c@example.com", name: "C", password: PW }, { verified: true });
    const top = store.comments.add({ postId: p.id, memberId: m.id, body: "top" });
    const reply = store.comments.add({ postId: p.id, memberId: m.id, parentId: top.id, body: "reply" });
    throwsCode(() => store.comments.add({ postId: p.id, memberId: m.id, parentId: reply.id, body: "reply to reply" }), "PARENT_UNAVAILABLE");
    // 320 more top-level comments: the oldest fall off, the newest stay
    const ins = db.prepare("INSERT INTO comments (post_id, member_id, body, status, created_at) VALUES (?, ?, ?, 'published', ?)");
    for (let i = 0; i < 320; i++) ins.run(p.id, m.id, `c${i}`, new Date(Date.now() + i * 1000).toISOString());
    const t = store.comments.thread(p.id);
    assert.equal(t.comments.length, 300);
    assert.equal(t.comments.at(-1).body, "c319", "the newest comment is shown");
    assert.equal(t.comments[0].body, "c20");
    assert.equal(t.total, 322);
    assert.ok(store.comments.counts().deleted === 0);
  });

  test("stale sign-ups and pending newsletter rows are purged, verified ones never", async () => {
    const { store, db } = setup();
    store.members.signup({ email: "stale@example.com", name: "S" });
    store.members.signup({ email: "fresh@example.com", name: "F" });
    await store.members.create({ email: "ok@example.com", name: "OK", password: PW }, { verified: true });
    db.prepare("UPDATE members SET created_at = ?, verify_expires = ? WHERE email = 'stale@example.com'").run(past(5 * 864e5), past(3 * 864e5));
    db.prepare("UPDATE members SET created_at = ? WHERE email = 'ok@example.com'").run(past(50 * 864e5));
    const live = store.subscribers.add("pend@example.com").subscriber;
    const old = store.subscribers.add("oldpend@example.com").subscriber;
    db.prepare("UPDATE subscribers SET created_at = ?, confirm_expires = ? WHERE id = ?").run(past(10 * 864e5), past(3 * 864e5), old.id);
    const un = store.subscribers.add("un@example.com", "", { confirmed: true }).subscriber;
    store.subscribers.unsubscribe(un.id);
    db.prepare("UPDATE subscribers SET created_at = ? WHERE id = ?").run(past(50 * 864e5), un.id);
    store.members.pruneSessions();
    assert.equal(store.members.getByEmail("stale@example.com"), null);
    assert.ok(store.members.getByEmail("fresh@example.com"));
    assert.ok(store.members.getByEmail("ok@example.com"));
    assert.equal(store.subscribers.getByEmail("oldpend@example.com"), null);
    assert.ok(store.subscribers.get(live.id));
    assert.equal(store.subscribers.get(un.id).status, "unsubscribed");
  });
});

describe("subscribers", () => {
  test("add validates, activates pending rows for an admin, and sends a link at most every 15 minutes", () => {
    const { store, db } = setup();
    const s = store.subscribers;
    throwsCode(() => s.add("not an email"), "INVALID_EMAIL");
    throwsCode(() => s.add('a,b@example.com'), "INVALID_EMAIL");
    const r1 = s.add("p@example.com");
    assert.ok(r1.token && r1.token === r1.confirmToken);
    assert.deepEqual([s.add("p@example.com").status, s.add("p@example.com").token], ["pending", null]);
    const admin = s.add("p@example.com", "added by admin", { confirmed: true });
    assert.equal(admin.status, "active", "an administrator's add activates a pending row");
    assert.equal(s.confirm(r1.token), null, "the mailed link no longer matters");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM subscriber_events").get().n >= 2, true);
  });

  test("unsubscribe codes: hashed at rest, keyed for new links, this year and last year only", async () => {
    const { store, db, secrets, dir } = setup();
    // an old plaintext code is hashed once at start-up, and the old link keeps working
    const sub = store.subscribers.add("legacy@example.com", "", { confirmed: true }).subscriber;
    const plain = "0123456789abcdef0123456789abcdef";
    db.prepare("UPDATE subscribers SET token = ? WHERE id = ?").run(plain, sub.id);
    const again = createStore(db, { basePath: "/blog", secrets });
    assert.equal(db.prepare("SELECT token FROM subscribers WHERE id = ?").get(sub.id).token, sha(plain));
    assert.equal(again.subscribers.byUnsubscribeToken(plain).id, sub.id);
    assert.equal(again.subscribers.byUnsubscribeToken("f".repeat(32)), null);
    // new keyed tokens
    const year = new Date().getUTCFullYear();
    const tok = store.subscribers.unsubscribeToken(sub, year);
    assert.match(tok, /^[0-9a-f]{40}$/);
    assert.equal(store.subscribers.byUnsubscribeToken(tok).id, sub.id);
    assert.equal(store.subscribers.byUnsubscribeToken(store.subscribers.unsubscribeToken(sub, year - 1)).id, sub.id);
    assert.equal(store.subscribers.byUnsubscribeToken(store.subscribers.unsubscribeToken(sub, year - 2)), null);
    assert.equal(store.subscribers.byUnsubscribeToken(tok.slice(0, 32) + "00000063"), null, "another id with the same MAC fails");
    assert.equal(store.subscribers.byUnsubscribeToken(secrets.hmac("x").slice(0, 40)), null);
    assert.ok(dir);
    // a store without secrets still makes keyed tokens
    const bare = setup({ secrets: false });
    const b = bare.store.subscribers.add("bare@example.com", "", { confirmed: true }).subscriber;
    assert.equal(bare.store.subscribers.byUnsubscribeToken(bare.store.subscribers.unsubscribeToken(b)).id, b.id);
    assert.notEqual(bare.store.subscribers.unsubscribeToken(b), sha(`unsub:${b.id}:${year}`).slice(0, 32) + b.id.toString(16).padStart(8, "0"));
  });

  test("the suppression list survives a restore, and every consent change is recorded", () => {
    const { store, db, dir } = setup();
    const s = store.subscribers;
    const a = s.add("gone@example.com", "", { confirmed: true }).subscriber;
    const b = s.add("stays@example.com", "", { confirmed: true }).subscriber;
    s.unsubscribe(a.id);
    const file = path.join(dir, "suppression-list.txt");
    assert.equal(fs.readFileSync(file, "utf8").trim(), sha("gone@example.com"), "only a hash, never the address");
    // pretend an older backup was restored: the row is active again
    db.prepare("UPDATE subscribers SET status = 'active', unsubscribed_at = NULL WHERE id = ?").run(a.id);
    assert.equal(s.applySuppressionList(), 1);
    assert.equal(s.get(a.id).status, "unsubscribed");
    assert.equal(s.get(b.id).status, "active");
    assert.equal(s.applySuppressionList(), 0);
    // an administrator can't re-add an opted-out address after removing its row
    s.remove(a.id);
    assert.equal(s.add("gone@example.com", "x", { confirmed: true }).status, "unsubscribed");
    // the person's own resubscribe and a fresh double opt-in both clear the entry
    const again = s.getByEmail("gone@example.com");
    s.resubscribe(again.id);
    assert.equal(fs.readFileSync(file, "utf8").trim(), "");
    assert.equal(s.applySuppressionList(), 0);
    assert.equal(s.get(again.id).status, "active");
    // the list is seeded from rows that are already unsubscribed
    s.unsubscribe(b.id);
    fs.writeFileSync(file, "");
    s.applySuppressionList();
    assert.equal(fs.readFileSync(file, "utf8").trim(), sha("stays@example.com"));
    const events = db.prepare("SELECT event FROM subscriber_events ORDER BY id").all().map((r) => r.event);
    for (const e of ["admin-add", "unsubscribe", "resubscribe"]) assert.ok(events.includes(e), e);
    assert.throws(() => db.prepare("DELETE FROM subscriber_events").run(), /append-only/);
    assert.throws(() => db.prepare("UPDATE subscriber_events SET source = 'x'").run(), /append-only/);
  });

  test("a permanent failure marks the recipient failed at once; a retry of a finished newsletter changes nothing", () => {
    const { store } = setup();
    const s = store.subscribers;
    const a = s.add("a@example.com", "", { confirmed: true }).subscriber;
    const n = store.newsletters.save({ subject: "S", preheader: "", body_md: "b" });
    store.newsletters.queue(n.id);
    store.newsletters.mark(n.id, a.id, false, "550 no such user", { permanent: true });
    assert.equal(store.newsletters.get(n.id).failed_n, 1);
    assert.equal(store.newsletters.nextBatch(n.id).length, 0);
    assert.equal(store.newsletters.nextBatch(n.id).every((r) => !("token" in r)), true);
    store.newsletters.finish(n.id);
    const done = store.newsletters.get(n.id);
    assert.equal(store.newsletters.retry(n.id), 1);
    store.newsletters.finish(n.id);
    const sentAt = store.newsletters.get(n.id).sent_at;
    assert.ok(done.sent_at);
    const b = s.add("b@example.com", "", { confirmed: true }).subscriber;
    store.newsletters.mark(n.id, a.id, true);
    store.newsletters.finish(n.id);
    const before = store.newsletters.get(n.id);
    assert.equal(store.newsletters.retry(n.id), 0, "nothing failed: nothing changes");
    assert.deepEqual([store.newsletters.get(n.id).status, store.newsletters.get(n.id).sent_at], [before.status, before.sent_at]);
    assert.ok(sentAt && b);
  });
});

describe("redirects and posts", () => {
  test("auto saves never touch admin rows; source is kept; loops are refused", () => {
    const { store, db } = setup();
    const r = store.redirects;
    r.save({ from_path: "/blog/category/x/", to_path: "/blog/elsewhere/", status_code: 301 });
    r.save({ from_path: "/blog/authors/gone/", to_path: "", status_code: 410 });
    assert.deepEqual(r.save({ from_path: "/blog/category/x/", to_path: "/blog/category/y/", source: "auto" }), { skipped: true });
    assert.equal(r.find("/blog/category/x/").to_path, "/blog/elsewhere/");
    // the target of an auto save may be an admin 410: it is kept
    r.save({ from_path: "/blog/authors/old/", to_path: "/blog/authors/gone/", source: "auto" });
    assert.equal(r.find("/blog/authors/gone/").status_code, 410, "the admin 410 survives");
    assert.equal(r.find("/blog/authors/old/").source, "auto");
    // an admin save takes over an auto row, and the source is stored
    r.save({ from_path: "/blog/authors/old/", to_path: "/blog/authors/new/" });
    assert.equal(r.find("/blog/authors/old/").source, "admin");
    // auto rows pointing at the old path are re-pointed; admin rows are left for auto saves
    r.save({ from_path: "/blog/tag/a/", to_path: "/blog/tag/b/", source: "auto" });
    r.save({ from_path: "/blog/tag/b/", to_path: "/blog/tag/c/", source: "auto" });
    assert.equal(r.find("/blog/tag/a/").to_path, "/blog/tag/c/");
    // loops
    r.save({ from_path: "/blog/p/", to_path: "/blog/q/" });
    r.save({ from_path: "/blog/q/", to_path: "/blog/r/" });
    throwsCode(() => r.save({ from_path: "/blog/r/", to_path: "/blog/p/" }), "LOOP");
    throwsCode(() => r.save({ from_path: "/blog/r/", to_path: "/blog/p/", source: "auto" }), "LOOP");
    assert.equal(r.find("/blog/r/"), null, "nothing was saved");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM redirects WHERE from_path = '/blog/r/'").get().n, 0);
    // a longer chain than 5 hops isn't followed
    const raw = db.prepare("INSERT INTO redirects (from_path, to_path, created_at) VALUES (?, ?, 'x')");
    for (let i = 0; i < 6; i++) raw.run(`/blog/c${i}/`, `/blog/c${i + 1}/`);
    assert.doesNotThrow(() => r.save({ from_path: "/blog/c6/", to_path: "/blog/c0/" }), "a chain longer than 5 hops isn't followed");
    raw.run("/blog/d0/", "/blog/d1/");
    raw.run("/blog/d1/", "/blog/d2/");
    throwsCode(() => r.save({ from_path: "/blog/d2/", to_path: "/blog/d0/" }), "LOOP");
    throwsCode(() => r.save({ from_path: "/blog/z/", to_path: "/blog/z2/", status_code: 418 }), undefined);
  });

  test("auto rows are trimmed to the newest 2,000; the list pages and filters", () => {
    const { store, db } = setup();
    const ins = db.prepare("INSERT INTO redirects (from_path, to_path, source, created_at) VALUES (?, ?, 'auto', ?)");
    for (let i = 0; i < 2100; i++) ins.run(`/blog/old${i}/`, `/blog/new${i}/`, new Date(Date.now() - (3000 - i) * 1000).toISOString());
    store.redirects.save({ from_path: "/blog/keep/", to_path: "/blog/there/" });
    store.redirects.save({ from_path: "/blog/last/", to_path: "/blog/next/", source: "auto" });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM redirects WHERE source = 'auto'").get().n, 2000);
    assert.ok(store.redirects.find("/blog/last/"));
    assert.equal(store.redirects.find("/blog/old0/"), null, "the oldest go first");
    assert.ok(store.redirects.find("/blog/keep/"), "admin rows are never trimmed");
    const page = store.redirects.page({ limit: 10, offset: 0, source: "admin" });
    assert.deepEqual([page.rows.length, page.total], [1, 1]);
    assert.equal(store.redirects.page({ q: "old1999" }).total, 1);
    assert.equal(store.redirects.get(page.rows[0].id).from_path, "/blog/keep/");
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'redirects_to_path'").get());
  });

  test("renaming and unpublishing: no redirect reveals the new address of something that isn't public", async () => {
    const { store } = setup();
    const o = await owner(store);
    const p = post(store, o.id, { slug: "alpha", status: "published", published_at: live });
    // renamed and unpublished in one save: no redirect
    store.posts.save({ slug: "beta", status: "draft" }, { id: p.id, userId: o.id });
    assert.equal(store.redirects.find("/blog/alpha/"), null);
    // renamed while live, then unpublished: the redirect to it goes away
    store.posts.save({ slug: "gamma", status: "published" }, { id: p.id, userId: o.id });
    store.posts.save({ slug: "delta" }, { id: p.id, userId: o.id });
    assert.equal(store.redirects.find("/blog/gamma/").to_path, "/blog/delta/");
    store.posts.save({ status: "draft" }, { id: p.id, userId: o.id });
    assert.equal(store.redirects.find("/blog/gamma/"), null);
    // an admin redirect that points back would make a loop: the automatic one is simply not made
    store.posts.save({ status: "published" }, { id: p.id, userId: o.id });
    store.redirects.save({ from_path: "/blog/epsilon/", to_path: "/blog/delta/" });
    store.posts.save({ slug: "epsilon" }, { id: p.id, userId: o.id });
    assert.equal(store.redirects.find("/blog/delta/"), null, "no loop with the admin row");
    assert.equal(store.redirects.find("/blog/epsilon/").source, "admin");
  });

  test("concurrent edits, reserved slugs, duplicate repair, purge and the scheduler's light query", async () => {
    const { store, db } = setup();
    const o = await owner(store);
    const p = post(store, o.id, { slug: "one", title: "One" });
    const loaded = store.posts.get(p.id).modified_at;
    store.posts.save({ title: "Two" }, p.id, { userId: o.id }); // both call shapes work
    throwsCode(() => store.posts.save({ title: "Stale" }, { id: p.id, userId: o.id, ifUpdatedAt: loaded }), "CONFLICT");
    assert.equal(store.posts.get(p.id).title, "Two");
    const now = store.posts.get(p.id).modified_at;
    assert.equal(store.posts.save({ title: "Three" }, p.id, { userId: o.id, ifUpdatedAt: now }).title, "Three");
    assert.equal(store.posts.save({ title: "Four" }, { id: p.id, userId: o.id, ifUpdatedAt: "" }).title, "Four", "no token, no check");
    for (const s of ["forgot", "reset", "verify", "confirm"]) assert.equal(store.posts.slugTaken(s), true, s);

    // revisions can be purged
    const revs = store.posts.revisions(p.id).length;
    assert.ok(revs >= 3);
    const rid = store.posts.revisions(p.id).at(-1).id;
    assert.equal(store.posts.deleteRevision(p.id, rid), 1);
    assert.equal(store.posts.purgeRevisions(p.id), revs - 2);
    assert.equal(store.posts.revisions(p.id).length, 1);

    // light scheduler rows
    post(store, o.id, { slug: "sched", status: "published", published_at: "2021-01-01T00:00:00.000Z" });
    const rows = store.posts.wentLiveBetween("2020-12-31T00:00:00.000Z", "2021-01-02T00:00:00.000Z");
    assert.deepEqual(Object.keys(rows[0]).sort(), ["id", "slug", "type"]);

    // a post and a page with the same slug (an old or restored database) are repaired at start-up
    db.exec("DROP TRIGGER posts_slug_unique_insert; DROP TRIGGER posts_slug_unique_update");
    db.prepare("INSERT INTO posts (slug, title, type, author_id, created_at, modified_at) VALUES ('about', 'About page', 'page', ?, 'x', 'x')").run(o.id);
    db.prepare("INSERT INTO posts (slug, title, type, status, author_id, created_at, modified_at) VALUES ('about', 'About post', 'post', 'published', ?, 'x', 'x')").run(o.id);
    const quiet = console.warn;
    const warned = [];
    console.warn = (m) => warned.push(m);
    try {
      createStore(db, { basePath: "/blog" });
    } finally {
      console.warn = quiet;
    }
    assert.equal(warned.length, 1);
    assert.equal(db.prepare("SELECT slug FROM posts WHERE title = 'About post'").get().slug, "about", "the published one keeps the address");
    assert.equal(db.prepare("SELECT slug FROM posts WHERE title = 'About page'").get().slug, "about-page");
  });
});

describe("media", () => {
  test("duplicate lookup, public use, variant-aware usage, a broken downloads column, and quiet alt saves", async () => {
    let changes = 0;
    const dir = tmp();
    const db = openDb(dir);
    const store = createStore(db, { basePath: "/blog", onChange: () => changes++ });
    const o = await owner(store);
    const m = store.media.insert({ path: "2026/11/pic-0123456789abcdef.png", original_name: "pic", mime: "image/png", size: 1, variants: { webp: [[640, "2026/11/pic-0123456789abcdef-640.webp"]] } }, o.id);
    assert.equal(store.media.findByInputKey("0123456789abcdef").id, m.id);
    assert.equal(store.media.findByInputKey("fedcba9876543210"), null);
    assert.equal(store.media.findByInputKey("%"), null);
    assert.equal(store.media.isPublic(m.id), false);
    // a draft that uses it doesn't make it public; a published post that links a resized copy does
    const draft = post(store, o.id, { slug: "d", body_md: "![x](/blog/media/2026/11/pic-0123456789abcdef-640.webp)" });
    assert.equal(store.media.isPublic(m.id), false);
    assert.ok(store.media.usage(m).posts.some((p) => p.id === draft.id), "a link to a resized copy counts as use");
    store.posts.save({ status: "published", published_at: live }, { id: draft.id, userId: o.id });
    assert.equal(store.media.isPublic(m.id), true);
    store.posts.save({ status: "draft" }, { id: draft.id, userId: o.id });
    assert.equal(store.media.isPublic(m.id), false);
    // the other ways: profile, live ad, setting
    const m2 = store.media.insert({ path: "2026/11/b-1111111111111111.png", original_name: "b", mime: "image/png", size: 1 }, o.id);
    store.users.update(o.id, { photo_id: m2.id }, system);
    assert.equal(store.media.isPublic(m2.id), true);
    store.users.update(o.id, { photo_id: null }, system);
    assert.equal(store.media.isPublic(m2.id), false);
    const ad = store.ads.save({ name: "Ad", url: "https://example.com", image_id: m2.id, places: ["top"], active: false });
    assert.equal(store.media.isPublic(m2.id), false, "a paused banner is not public");
    store.ads.setActive(ad.id, true);
    assert.equal(store.media.isPublic(m2.id), true);
    store.ads.remove(ad.id);
    store.settings.set({ logo_id: m2.id });
    assert.equal(store.media.isPublic(m2.id), true);
    // one post with a broken downloads column doesn't break the usage query
    db.prepare("UPDATE posts SET downloads = 'not json' WHERE id = ?").run(draft.id);
    assert.doesNotThrow(() => store.media.usage(m));
    assert.doesNotThrow(() => store.media.isPublic(m.id));
    // alt text: no cache flush when nothing changed
    store.media.setAlt(m.id, "A picture");
    const n = changes;
    store.media.setAlt(m.id, "A picture");
    assert.equal(changes, n);
    store.media.setAlt(m.id, "Another");
    assert.equal(changes, n + 1);
  });
});

describe("settings, ads and rate limits", () => {
  test("values are type-checked, the cache can't be changed from outside, and reads never write", () => {
    const { store, db } = setup();
    assert.throws(() => store.settings.set({ nav_menu: null }), /Invalid value/);
    assert.throws(() => store.settings.set({ nav_items: "x" }), /Invalid value/);
    assert.throws(() => store.settings.set({ posts_per_page: "12" }), /Invalid value/);
    assert.throws(() => store.settings.set({ require_two_step: "everyone" }), /Invalid value/);
    assert.throws(() => store.settings.set({ logo_id: 424242 }), /Invalid value/);
    assert.throws(() => store.settings.set({ constructor: "x" }), /Unknown setting/);
    assert.throws(() => store.settings.set({ __proto__: "x", toString: "y" }), /Unknown setting/);
    store.settings.set({ require_two_step: "admins", nav_items: [{ label: "A", url: "/a/", children: [] }] });
    assert.equal(store.settings.get("require_two_step"), "admins");
    assert.equal(store.settings.get("constructor"), "");
    // a damaged row of the wrong type falls back to the default instead of breaking every page
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('nav_menu', 'null')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('footer_cols', '\"text\"')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('require_two_step', '\"bogus\"')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('_scheduler_last_tick', '\"2026\"')").run();
    store.settings.set({ site_title: "Same" }); // reloads
    const all = store.settings.all();
    assert.equal(all.nav_menu, "");
    assert.deepEqual(all.footer_cols, []);
    assert.equal(all.require_two_step, "off");
    assert.equal("_scheduler_last_tick" in all, false, "unknown rows never reach the settings object");
    // a copy: mutating it changes nothing for the next reader
    all.nav_items.push("junk");
    all.site_title = "Mutated";
    assert.equal(store.settings.all().site_title, "Same");
    assert.equal(store.settings.all().nav_items.length, 1);
    store.settings.get("nav_items").length = 0;
    assert.equal(store.settings.all().nav_items.length, 1);
    // the search-engine key exists from start-up and reading doesn't write
    const key = db.prepare("SELECT value FROM settings WHERE key = 'indexnow_key'").get();
    assert.match(JSON.parse(key.value), /^[0-9a-f]{32}$/);
    const before = db.prepare("SELECT COUNT(*) AS n FROM settings").get().n;
    store.settings.all();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings").get().n, before);
    assert.match(store.settings.get("indexnow_key"), /^[0-9a-f]{32}$/);
  });

  test("ads count views and clicks only while a banner is showing", async () => {
    const { store } = setup();
    const o = await owner(store);
    const m = store.media.insert({ path: "2026/11/ad-2222222222222222.png", original_name: "ad", mime: "image/png", size: 1 }, o.id);
    const mk = (over) => store.ads.save({ name: "A", url: "https://example.com", image_id: m.id, places: ["top"], active: true, ...over });
    const running = mk({});
    const paused = mk({ active: false });
    const future = mk({ starts_at: new Date(Date.now() + 864e5).toISOString() });
    const ended = mk({ ends_at: new Date(Date.now() - 864e5).toISOString() });
    for (const ad of [running, paused, future, ended, { id: 99999 }]) {
      store.ads.record(ad.id, "views");
      store.ads.record(ad.id, "clicks");
    }
    const tot = (id) => [store.ads.totals(id).views, store.ads.totals(id).clicks];
    assert.deepEqual(tot(running.id), [1, 1]);
    for (const ad of [paused, future, ended]) assert.deepEqual(tot(ad.id), [0, 0]);
  });

  test("rate-limit counters are stored with an expiry and pruned", () => {
    const { store } = setup();
    const r = store.rateLimits;
    assert.equal(r.get("login", "a"), null);
    r.set("login", "a", { start: 1000, cur: 2, prev: 1, expires: Date.now() + 60_000 });
    r.set("login", "b", { start: 1000, cur: 1, prev: 0, expires: Date.now() - 1 });
    r.set("step", "a", { start: Date.now(), cur: 9, prev: 0 });
    assert.deepEqual(r.get("login", "a"), { start: 1000, cur: 2, prev: 1, expires: r.get("login", "a").expires });
    assert.ok(r.get("login", "a").expires > Date.now());
    r.set("login", "a", { start: 2000, cur: 3, prev: 2, expires: Date.now() + 60_000 });
    assert.deepEqual([r.get("login", "a").start, r.get("login", "a").cur, r.get("login", "a").prev], [2000, 3, 2]);
    assert.deepEqual(r.get("step", "a").cur, 9, "scopes are separate");
    assert.equal(r.prune(Date.now()), 1, "only the expired row goes");
    assert.equal(r.get("login", "b"), null);
    r.delete("login", "a");
    assert.equal(r.get("login", "a"), null);
    assert.equal(codeOf(undefined), undefined);
  });
});

describe("narrow queries and sealed labels", () => {
  test("source files come from a narrow query; search counts stop at a cap; sealed values are bound to their owner", async () => {
    const { store, db } = setup();
    const o = await owner(store);
    const p = post(store, o.id, { slug: "src", status: "published", published_at: live, source_files: [{ name: "main.ino", lang: "cpp", code: "void setup(){}" }] });
    const got = store.posts.getPublicSourceFiles("src");
    assert.deepEqual(Object.keys(got).sort(), ["id", "slug", "source_files", "type"]);
    assert.equal(got.source_files[0].name, "main.ino");
    store.posts.save({ status: "draft" }, { id: p.id, userId: o.id });
    assert.equal(store.posts.getPublicSourceFiles("src"), null, "not public: nothing");
    const page = post(store, o.id, { slug: "pg", type: "page", status: "published", published_at: live });
    assert.equal(store.posts.getPublicSourceFiles(page.slug), null, "a page has no downloads");
    // search: the count is capped
    for (let i = 0; i < 6; i++) post(store, o.id, { slug: `s${i}`, title: `alpha ${i}`, body_md: "alpha", status: "published", published_at: live });
    assert.equal(store.posts.search("alpha").total, 6);
    assert.equal(store.posts.search("alpha", { maxCount: 4 }).total, 4);
    // a sealed authenticator secret opens only for its own user
    const a = await staff(store, "Aa Aa", "author");
    const b = await staff(store, "Bb Bb", "author");
    const secret = newSecret();
    store.users.enableTwoStep(a.id, secret, 0);
    const sealed = db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(a.id).totp_secret;
    db.prepare("UPDATE users SET totp_secret = ?, totp_enabled_at = ? WHERE id = ?").run(sealed, new Date().toISOString(), b.id);
    assert.equal(store.users.verifyTotp(b.id, codeAt(secret, stepAt() + 1), { ignoreLock: true }), false, "copied to another row: it does not open");
    assert.equal(store.users.verifyTotp(a.id, codeAt(secret, stepAt() + 1)), true);
  });
});
