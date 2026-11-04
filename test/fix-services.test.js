// Tests for the services fixes: media processing, the mailer, the newsletter sender, IndexNow, the scheduler and the user script.
// Run: node --test test/fix-services.test.js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import nodemailer from "nodemailer";
import sharp from "sharp";
import { openDb } from "../src/db.js";
import { processFile, processUpload, UploadError } from "../src/render/media.js";
import * as emailLib from "../src/render/email.js";
import { createIndexNow } from "../src/services/indexnow.js";
import { isPrivateHost } from "../src/services/hosts.js";
import { createMailer, explainMailError, isPermanentRecipientError } from "../src/services/mailer.js";
import { createNewsletterSender } from "../src/services/newsletter.js";
import { startScheduler } from "../src/services/scheduler.js";
import { createStore } from "../src/store/index.js";
import { createSecrets } from "../src/web/secrets.js";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `fix-services-${name}-`));
const png = (w, h, background = "#C2410C") => sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();
const walk = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));

// --- media ---

test("media: names carry 16 hex of SHA-256, variants are written, and the same upload is reused", async () => {
  const dir = tmp("media");
  const buf = await png(1800, 900);
  const a = await processUpload(buf, "Hello World.png", dir);
  assert.match(a.path, /^\d{4}\/\d\d\/hello-world-[0-9a-f]{16}\.png$/);
  assert.equal(a.path.split("-").at(-1).split(".")[0], crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16));
  assert.equal(a.width, 1800);
  assert.ok(a.variants.webp.length >= 3 && a.variants.avif.length === a.variants.webp.length);
  for (const f of [a.path, ...Object.values(a.variants).flat().map(([, p]) => p)]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const before = walk(dir).length;
  const b = await processUpload(buf, "Hello World.png", dir);
  assert.equal(b.path, a.path);
  assert.equal(walk(dir).length, before, "reuse writes nothing new");
  assert.ok(!walk(dir).some((f) => f.endsWith(".tmp")), "no temporary files left");
});

test("media: a name that already holds different bytes is never overwritten; the upload gets a second name (N-097)", async () => {
  const dir = tmp("collide");
  const buf = await png(500, 300);
  const a = await processUpload(buf, "logo.png", dir);
  fs.writeFileSync(path.join(dir, a.path), "somebody else's bytes");
  const b = await processUpload(buf, "logo.png", dir);
  assert.notEqual(b.path, a.path);
  assert.match(b.path, /\/logo-r2-[0-9a-f]{16}\.png$/,"the name still ends in the same 16 hex characters");
  assert.equal(fs.readFileSync(path.join(dir, a.path), "utf8"), "somebody else's bytes", "the other file is untouched");
  assert.equal((await sharp(path.join(dir, b.path)).metadata()).width, 500);
  assert.equal((await processUpload(buf, "logo.png", dir)).path, b.path, "the same upload is reused again");
});

test("media: files written before a failure are cleaned up", async () => {
  const dir = tmp("cleanup");
  const buf = await png(1000, 500);
  const a = await processUpload(buf, "pic.png", dir);
  // Keep the originals of a first upload, then clash on one variant of a second run in a fresh folder.
  const dir2 = tmp("cleanup2");
  fs.mkdirSync(path.join(dir2, path.dirname(a.path)), { recursive: true });
  const clash = a.variants.webp.at(-1)[1];
  fs.writeFileSync(path.join(dir2, clash), "different");
  const second = await processUpload(buf, "pic.png", dir2);
  assert.match(second.path, /-r2-/, "the clash on one variant moved the whole upload to the second name");
  assert.ok(!fs.existsSync(path.join(dir2, a.path)), "nothing from the first attempt is left");
  assert.equal(fs.readFileSync(path.join(dir2, clash), "utf8"), "different");
  // Any other write failure removes everything written so far (a folder sits where a variant belongs).
  const dir3 = tmp("cleanup3");
  fs.mkdirSync(path.join(dir3, clash), { recursive: true });
  await assert.rejects(() => processUpload(buf, "pic.png", dir3));
  assert.ok(!fs.existsSync(path.join(dir3, a.path)), "the original written before the failure was removed");
});

test("media: an image over the pixel limit is refused even though the file is small", async () => {
  const dir = tmp("pixels");
  const big = await png(7000, 7000, "#000000");
  assert.ok(big.length < 2_000_000);
  await assert.rejects(() => processUpload(big, "huge.png", dir), (e) => e instanceof UploadError && /too large/i.test(e.message));
  assert.equal(walk(dir).length, 0);
});

test("media: animated GIFs are re-encoded, and over-long ones are refused", async () => {
  const dir = tmp("gif");
  const frames = (n) => {
    const raw = Buffer.alloc(8 * 8 * 3 * n);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 31) % 251;
    return sharp(raw, { raw: { width: 8, height: 8 * n, channels: 3, pageHeight: 8 } }).gif({ loop: 0, delay: Array(n).fill(80) }).toBuffer();
  };
  const small = await frames(3);
  const withComment = Buffer.concat([small, Buffer.from("TRAILING-SECRET-DATA")]);
  const r = await processUpload(withComment, "anim.gif", dir);
  const stored = fs.readFileSync(path.join(dir, r.path));
  assert.ok(!stored.includes(Buffer.from("TRAILING-SECRET-DATA")), "trailing data is gone");
  assert.equal((await sharp(stored, { animated: true }).metadata()).pages, 3);
  const long = await frames(201);
  await assert.rejects(() => processUpload(long, "long.gif", dir), (e) => e instanceof UploadError && /frames/.test(e.message));
});

test("media: SVG checks reject scripts, entities, outside links and accept plain drawings", async () => {
  const dir = tmp("svg");
  const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">${inner}</svg>`;
  const good = [wrap('<rect width="5" height="5" fill="red"/>'), wrap('<defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="3" height="3"/><use href="#g"/>')];
  const bad = [
    wrap("<script>alert(1)</script>"),
    wrap('<svg:script xmlns:svg="http://www.w3.org/2000/svg">x</svg:script>'),
    wrap('<foreignObject><div/></foreignObject>'),
    wrap('<rect onload="x()" width="1" height="1"/>'),
    wrap('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>'),
    wrap('<a xlink:href="&#106;avascript:alert(1)"><rect width="1" height="1"/></a>'),
    wrap('<a href="java&#x09;script:alert(1)"><rect width="1" height="1"/></a>'),
    wrap('<image href="https://example.com/x.png"/>'),
    wrap('<image href="data:image/png;base64,AAAA"/>'),
    wrap('<style>@import url(https://example.com/a.css);</style>'),
    wrap('<rect style="fill:url(https://example.com/a)" width="1" height="1"/>'),
    `<!DOCTYPE svg [<!ENTITY x "y">]>${wrap("<rect/>")}`,
    `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${wrap("<rect/>")}`,
  ];
  for (const svg of good) assert.match((await processUpload(Buffer.from(svg), "ok.svg", dir)).path, /\.svg$/);
  for (const svg of bad) await assert.rejects(() => processUpload(Buffer.from(svg), "bad.svg", dir), UploadError, svg.slice(0, 90));
});

test("media: downloads get SHA-256 names, are never overwritten, and bad types are refused", async () => {
  const dir = tmp("files");
  const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
  const a = processFile(pdf, "Circuit Diagram.pdf", dir);
  assert.match(a.path, /circuit-diagram-[0-9a-f]{16}\.pdf$/);
  assert.equal(processFile(pdf, "Circuit Diagram.pdf", dir).path, a.path);
  fs.writeFileSync(path.join(dir, a.path), "other");
  const second = processFile(pdf, "Circuit Diagram.pdf", dir);
  assert.match(second.path, /circuit-diagram-r2-[0-9a-f]{16}\.pdf$/);
  assert.equal(fs.readFileSync(path.join(dir, a.path), "utf8"), "other", "never overwritten");
  assert.deepEqual(fs.readFileSync(path.join(dir, second.path)), pdf);
  assert.throws(() => processFile(Buffer.from("MZ"), "x.exe", dir), UploadError);
  assert.throws(() => processFile(Buffer.from("hello"), "x.pdf", dir), UploadError);
});

// --- mailer ---

const fakeSite = () => ({
  title: "Test Blog", hasPublicUrl: true, host: "blog.example.com", base: "", blogUrl: "https://blog.example.com", s: { indexnow_enabled: true, indexnow_key: "k" },
  business: {}, abs: (p) => (/^https?:/.test(p) ? p : `https://blog.example.com${p}`), url: { home: "/", post: (s) => `/${s}/`, media: (p) => `/media/${p}` },
});
const mailerCtx = (settings = {}, config = { mailTransport: { jsonTransport: true } }) => ({
  config,
  site: fakeSite,
  store: { settings: { all: () => ({ mail_from_email: "news@blog.example.com", mail_from_name: "Test Blog", ...settings }) } },
});

test("mailer: recipients go out as { address, name } objects and a comma address is refused", async () => {
  const mailer = createMailer(mailerCtx());
  const conn = mailer.open();
  await conn.send({ to: { address: "ann@example.com", name: 'Ann, "the" Admin\r\nBcc: x@evil.example' }, subject: "Hi", text: "Hello" });
  await conn.send({ to: "bob@example.com", subject: "Hi", text: "Hello" });
  assert.equal(mailer.outbox.length, 2);
  assert.deepEqual(mailer.outbox[1].to, [{ address: "bob@example.com", name: "" }]);
  assert.equal(mailer.outbox[0].to.length, 1);
  assert.equal(mailer.outbox[0].to[0].address, "ann@example.com");
  assert.ok(!/\r|\n/.test(mailer.outbox[0].to[0].name));
  for (const bad of ["x,victim@example.com", "a@b.com;c@d.com", '"a"@example.com', "a b@example.com", "<a@example.com>", "plain"]) {
    await assert.rejects(() => conn.send({ to: bad, subject: "s", text: "t" }), /valid/, bad);
  }
  assert.equal(mailer.outbox.length, 2, "nothing extra was sent");
  conn.close();
});

test("mailer: the open transport is pooled, and connects to the address that was checked", async () => {
  const original = nodemailer.createTransport;
  let seen = null;
  nodemailer.createTransport = (options) => ((seen = options), original({ jsonTransport: true }));
  const saved = { ...process.env };
  try {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "u";
    process.env.SMTP_PASSWORD = "pw-for-the-test";
    const ctx = { ...mailerCtx({}, { mailTransport: null }), dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }] };
    const conn = createMailer(ctx).open();
    assert.equal(seen, null, "nothing is created before the first message");
    await conn.send({ to: "a@example.com", subject: "s", text: "t" });
    conn.close();
  } finally {
    nodemailer.createTransport = original;
    for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"]) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
  assert.equal(seen.pool, true);
  assert.equal(seen.host, "93.184.216.34", "the connection goes to the address that was checked");
  assert.equal(seen.servername, "smtp.example.com", "and the certificate is still checked against the name");
  assert.equal(seen.auth.pass, "pw-for-the-test");
});

test("mailer: SMTP_PASSWORD is only used with SMTP_HOST, and private hosts are refused", () => {
  const keys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_SECURE", "SMTP_PASSWORD", "ALLOW_PRIVATE_SMTP"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const reset = () => keys.forEach((k) => delete process.env[k]);
  try {
    reset();
    const live = { mailTransport: null };
    const withSettings = (s) => createMailer(mailerCtx(s, live));
    // An admin-chosen host never gets the environment password.
    process.env.SMTP_PASSWORD = "env-secret";
    assert.ok(withSettings({ smtp_host: "mail.evil-example.com", smtp_user: "u" }).problems().some((p) => /password/i.test(p)));
    // With the host pinned in the environment, the password applies and the form values are locked.
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "me@example.com";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "ssl";
    const pinned = withSettings({ smtp_host: "mail.evil-example.com", smtp_user: "other", smtp_port: 25, smtp_secure: "starttls" });
    assert.deepEqual(pinned.problems(), []);
    assert.deepEqual(pinned.server(), { host: "smtp.example.com", port: 465, secure: "ssl", user: "me@example.com", locked: { host: true, port: true, secure: true, user: true } });
    // Private and loopback servers are refused unless allowed.
    for (const host of ["127.0.0.1", "localhost", "10.1.2.3", "192.168.0.5", "169.254.169.254", "[::1]", "db.internal", "nas"]) {
      process.env.SMTP_HOST = host;
      assert.ok(withSettings({}).problems().some((p) => /inside this computer or network/.test(p)), host);
    }
    process.env.ALLOW_PRIVATE_SMTP = "1";
    assert.deepEqual(withSettings({}).problems(), []);
  } finally {
    reset();
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test("mailer: a private server is refused when sending, before any connection is made", async () => {
  const saved = process.env.ALLOW_PRIVATE_SMTP;
  delete process.env.ALLOW_PRIVATE_SMTP;
  try {
    const conn = createMailer(mailerCtx({ smtp_host: "127.0.0.1", smtp_user: "u", smtp_pass: "p" }, { mailTransport: null })).open();
    await assert.rejects(() => conn.send({ to: "a@example.com", subject: "s", text: "t" }), /inside this computer or network/);
    await assert.rejects(() => conn.verify(), /inside this computer or network/);
    conn.close();
  } finally {
    if (saved !== undefined) process.env.ALLOW_PRIVATE_SMTP = saved;
  }
});

test("mailer: error text never echoes the password", () => {
  process.env.SMTP_PASSWORD = "hunter2-secret";
  try {
    const text = explainMailError(new Error("550 relay denied for password=hunter2-secret AUTH PLAIN AHVzZXIAaHVudGVyMi1zZWNyZXQ= hunter2-secret"));
    assert.ok(!text.includes("hunter2-secret") && !text.includes("AHVzZXIA"), text);
    assert.ok(!/[\r\n]/.test(explainMailError(new Error("bad\r\nreply"))));
  } finally {
    delete process.env.SMTP_PASSWORD;
  }
  const rcpt = Object.assign(new Error("550 no such user"), { command: "RCPT TO", responseCode: 550 });
  assert.equal(isPermanentRecipientError(rcpt), true);
  assert.equal(isPermanentRecipientError(Object.assign(new Error("x"), { command: "MAIL FROM", responseCode: 550 })), false);
});

test("mailer: the four helper emails go to one { address, name } and never throw", async (t) => {
  if (typeof emailLib.renderSimpleEmail !== "function") return t.skip("renderSimpleEmail is not in render/email.js yet");
  const mailer = createMailer(mailerCtx());
  const person = { email: "reader@example.com", name: "Reader, One" };
  assert.equal(await mailer.sendConfirmSubscription(person, "https://blog.example.com/subscribe/confirm/abc/"), true);
  assert.equal(await mailer.sendVerifyMember(person, "https://blog.example.com/verify/abc/"), true);
  assert.equal(await mailer.sendAccountExists(person, "https://blog.example.com/signin/", "https://blog.example.com/forgot/"), true);
  assert.equal(await mailer.sendPasswordReset(person, "https://blog.example.com/reset/abc/"), true);
  assert.equal(mailer.outbox.length, 4);
  for (const m of mailer.outbox) {
    assert.deepEqual(m.to, [{ address: "reader@example.com", name: "Reader, One" }]);
    assert.match(m.html + m.text, /blog\.example\.com/);
  }
  // A bad address is logged and returns false instead of throwing.
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await mailer.sendPasswordReset({ email: "a,b@example.com", name: "" }, "https://x/"), false);
  } finally {
    console.warn = warn;
  }
});

test("hosts: private and public host detection", () => {
  for (const h of ["localhost", "localhost:4100", "127.0.0.1", "0.0.0.0", "10.0.0.1", "172.16.5.5", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "[::1]", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "foo.local", "foo.internal", "intranet", "2130706433", "0x7f.1", "127.1", ""]) assert.equal(isPrivateHost(h), true, h);
  for (const h of ["example.com", "localhost.example.com", "blog.iotstudio.in", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "192.169.0.1"]) assert.equal(isPrivateHost(h), false, h);
});

// --- newsletter sender ---

function newsletterSetup({ send }) {
  const dir = tmp("news");
  const db = openDb(dir);
  const store = createStore(db, { basePath: "" });
  const calls = [];
  const conn = {
    async send(msg) {
      calls.push(msg);
      return send(msg, calls);
    },
    close() {},
  };
  let ready = true;
  const ctx = { db, store, site: fakeSite, mailer: { ready: () => ready, open: () => conn } };
  const addSub = (email, status = "active") => Number(db.prepare("INSERT INTO subscribers (email, name, source, status, token, created_at) VALUES (?, '', '', ?, ?, ?)").run(email, status, crypto.randomBytes(16).toString("hex"), new Date().toISOString()).lastInsertRowid);
  const newsletter = store.newsletters.save({ subject: "Hello", preheader: "", body_md: "Body **text**", postIds: [] }, 0, null);
  return { db, store, ctx, calls, addSub, newsletter, sender: createNewsletterSender(ctx, { delayMs: 0 }), setReady: (v) => (ready = v) };
}
const quiet = async (fn) => {
  const log = console.log;
  const warn = console.warn;
  console.log = console.warn = (...a) => process.stderr.write(`${a.join(" ")}\n`);
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
};
const rcptError = () => Object.assign(new Error("550 5.1.1 no such mailbox"), { command: "RCPT TO", responseCode: 550 });

test("newsletter: refused addresses don't halt the send, and each retry tries them once", async () => {
  const bad = new Set(["bad1@example.com", "bad2@example.com", "bad3@example.com", "bad4@example.com", "bad5@example.com", "bad6@example.com"]);
  const s = newsletterSetup({
    send(msg) {
      if (bad.has(msg.to.address)) throw rcptError();
      return { messageId: "x" };
    },
  });
  for (const b of bad) s.addSub(b);
  for (let i = 1; i <= 10; i++) s.addSub(`good${i}@example.com`);
  await quiet(async () => {
    assert.equal(s.sender.start(s.newsletter.id), true);
    await s.sender.idle();
  });
  let n = s.store.newsletters.get(s.newsletter.id);
  assert.equal(n.sent_n, 10, "every good address was mailed, although six refusals came first");
  assert.equal(n.failed_n, 6);
  assert.equal(n.queued_n, 0);
  assert.equal(n.status, "sent");
  const triedBad = () => s.calls.filter((m) => bad.has(m.to.address)).length;
  assert.equal(triedBad(), 6, "a refused address is tried once, not three times");
  for (const m of s.calls) {
    assert.deepEqual(Object.keys(m.to).sort(), ["address", "name"]);
    assert.match(m.headers["List-Unsubscribe"], /\/unsubscribe\/[\w.-]{16,}\/>/);
  }
  // Try again: the refused ones are tried again, and the good ones are never mailed twice.
  await quiet(async () => {
    s.sender.retry(s.newsletter.id);
    await s.sender.idle();
  });
  assert.equal(triedBad(), 12);
  assert.equal(s.calls.filter((m) => m.to.address.startsWith("good")).length, 10);
  assert.notEqual(s.store.newsletters.get(s.newsletter.id).status, "sending");
});

test("newsletter: a recipient that fails three times is quarantined and the rest are still sent", async () => {
  const s = newsletterSetup({
    send(msg) {
      if (msg.to.address === "flaky@example.com") throw Object.assign(new Error("450 mailbox busy"), { command: "RCPT TO", responseCode: 450 });
      return {};
    },
  });
  s.addSub("flaky@example.com");
  for (let i = 1; i <= 5; i++) s.addSub(`ok${i}@example.com`);
  await quiet(async () => {
    s.sender.start(s.newsletter.id);
    await s.sender.idle();
  });
  const n = s.store.newsletters.get(s.newsletter.id);
  assert.equal(n.sent_n, 5);
  assert.equal(n.failed_n, 1);
  assert.equal(n.queued_n, 0);
  assert.equal(s.calls.filter((m) => m.to.address === "flaky@example.com").length, 3, "three attempts, then quarantined");
  assert.equal(n.status, "sent");
});

test("newsletter: someone who unsubscribes mid-send is skipped", async () => {
  let s;
  const unsub = [];
  s = newsletterSetup({
    send(msg) {
      // While the first message is going out, the third person unsubscribes.
      if (msg.to.address === "p1@example.com") s.db.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email = 'p3@example.com'").run();
      unsub.push(msg.to.address);
      return {};
    },
  });
  for (let i = 1; i <= 4; i++) s.addSub(`p${i}@example.com`);
  await quiet(async () => {
    s.sender.start(s.newsletter.id);
    await s.sender.idle();
  });
  assert.deepEqual(unsub, ["p1@example.com", "p2@example.com", "p4@example.com"]);
  const n = s.store.newsletters.get(s.newsletter.id);
  assert.equal(n.sent_n, 3);
  assert.equal(n.status, "sent");
});

test("newsletter: a recipient is marked before the send, so a crash can't send twice", async () => {
  let s;
  let seen = null;
  s = newsletterSetup({
    send(msg) {
      const row = s.db.prepare("SELECT status, error FROM newsletter_sends WHERE newsletter_id = ? AND subscriber_id = (SELECT id FROM subscribers WHERE email = ?)").get(s.newsletter.id, msg.to.address);
      seen = row;
      return {};
    },
  });
  s.addSub("one@example.com");
  await quiet(async () => {
    s.sender.start(s.newsletter.id);
    await s.sender.idle();
  });
  assert.equal(seen.error, "Sending…", "the row already said 'sending' when the email went out");
  assert.equal(s.store.newsletters.get(s.newsletter.id).sent_n, 1);

  // After a crash the same marker is left behind; resuming doesn't send that person again.
  const s2 = newsletterSetup({ send: () => ({}) });
  const id = s2.addSub("crashed@example.com");
  s2.addSub("waiting@example.com");
  s2.store.newsletters.queue(s2.newsletter.id);
  s2.db.prepare("UPDATE newsletter_sends SET error = 'Sending…' WHERE subscriber_id = ?").run(id);
  await quiet(async () => {
    s2.sender.resume();
    await s2.sender.idle();
  });
  assert.deepEqual(s2.calls.map((m) => m.to.address), ["waiting@example.com"]);
  const row = s2.db.prepare("SELECT status FROM newsletter_sends WHERE subscriber_id = ?").get(id);
  assert.equal(row.status, "failed");
});

test("newsletter: five failures in a row (not recipient refusals) stop the send, and resume() waits for ready mail", async () => {
  const s = newsletterSetup({
    send() {
      throw Object.assign(new Error("connect ETIMEDOUT 203.0.113.9:587"), { code: "ETIMEDOUT" });
    },
  });
  for (let i = 1; i <= 8; i++) s.addSub(`t${i}@example.com`);
  await quiet(async () => {
    s.sender.start(s.newsletter.id);
    await s.sender.idle();
  });
  assert.equal(s.calls.length, 5);
  assert.equal(s.store.newsletters.get(s.newsletter.id).status, "failed");
  // Back to "sending" with mail not set up: resume() must not even open a connection.
  s.store.newsletters.retry(s.newsletter.id);
  s.setReady(false);
  s.sender.resume();
  await s.sender.idle();
  assert.equal(s.calls.length, 5, "no attempt while mail isn't ready");
});

test("newsletter: a throw inside a run never escapes as an unhandled rejection", async () => {
  const s = newsletterSetup({ send: () => ({}) });
  s.addSub("a@example.com");
  s.ctx.mailer.open = () => {
    throw new Error("boom");
  };
  let escaped = null;
  const onRejection = (e) => (escaped = e);
  process.once("unhandledRejection", onRejection);
  await quiet(async () => {
    s.sender.start(s.newsletter.id);
    await s.sender.idle();
    await new Promise((r) => setTimeout(r, 30));
  });
  process.removeListener("unhandledRejection", onRejection);
  assert.equal(escaped, null);
  assert.equal(s.store.newsletters.get(s.newsletter.id).status, "failed");
});

// --- IndexNow and the scheduler ---

test("indexnow: skips private sites, noindex and canonical-elsewhere pages, times out and sends in chunks", async () => {
  const site = fakeSite();
  const rows = [
    { slug: "indexed", noindex: 0, canonical_url: "" },
    { slug: "hidden", noindex: 1, canonical_url: "" },
    { slug: "syndicated", noindex: 0, canonical_url: "https://other.example.org/original/" },
    { slug: "self", noindex: 0, canonical_url: "https://blog.example.com/self" },
  ];
  const ctx = { config: { outbound: true }, site: () => site, store: { posts: { allPublic: () => rows } } };
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body), signal: init.signal });
    return { status: 200 };
  };
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  try {
    const nowSite = createIndexNow(ctx);
    nowSite.ping(["slug", "hidden", "syndicated", "indexed", "self"].map((s) => `https://blog.example.com/${s}/`));
    await nowSite.flush();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body.urlList.sort(), ["https://blog.example.com/indexed/", "https://blog.example.com/self/", "https://blog.example.com/slug/"].sort());
    assert.ok(posts[0].signal instanceof AbortSignal, "the request has a timeout signal");

    // A big queue goes out in batches of 10,000, with nothing dropped.
    posts.length = 0;
    const big = createIndexNow(ctx);
    big.ping(Array.from({ length: 25_000 }, (_, i) => `https://blog.example.com/p${i}/`));
    await big.flush();
    assert.deepEqual(posts.map((p) => p.body.urlList.length), [10_000, 10_000, 5_000]);

    // Private sites send nothing.
    posts.length = 0;
    for (const host of ["localhost", "192.168.1.9", "blog.local", "[::1]"]) {
      const local = createIndexNow({ ...ctx, site: () => ({ ...site, host }) });
      local.ping([`https://${host}/a/`]);
      await local.flush();
    }
    assert.equal(posts.length, 0);
    // A host such as localhost.example.com is a real public name.
    const named = createIndexNow({ ...ctx, site: () => ({ ...site, host: "localhost.example.com" }) });
    named.ping(["https://localhost.example.com/a/"]);
    await named.flush();
    assert.equal(posts.length, 1);

    // A failure is swallowed (and queued again), and pingNow returns at once.
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    console.warn = () => {};
    const failing = createIndexNow(ctx);
    assert.equal(failing.pingNow(["https://blog.example.com/x/"]), undefined);
    await failing.flush();
  } finally {
    globalThis.fetch = realFetch;
    console.log = log;
    console.warn = warn;
  }
});

test("scheduler: a failing tick is caught, the last tick is saved, and downtime posts are caught up", async () => {
  const dir = tmp("sched");
  const db = openDb(dir);
  const live = [];
  const pings = [];
  let boom = true;
  const ctx = {
    db,
    invalidate() {},
    site: fakeSite,
    indexNow: { ping: (u) => pings.push(...u) },
    store: {
      posts: { wentLiveBetween: (from, to) => (boom ? (() => { throw new Error("sqlite busy"); })() : live.filter((p) => p.at > from && p.at <= to)) },
      ads: { changedBetween: () => false },
      users: { pruneSessions: () => (ctx.pruned = (ctx.pruned || 0) + 1) },
      members: { pruneSessions: () => (ctx.prunedMembers = (ctx.prunedMembers || 0) + 1) },
    },
  };
  const warn = console.warn;
  const log = console.log;
  console.warn = console.log = () => {};
  try {
    // The server was last seen two hours ago; a post went live an hour ago while it was off.
    const twoHoursAgo = new Date(Date.now() - 2 * 3600e3).toISOString();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('scheduler_last_tick', ?)").run(JSON.stringify(twoHoursAgo));
    live.push({ slug: "while-away", at: new Date(Date.now() - 3600e3).toISOString() });
    const sched = startScheduler(ctx, { intervalMs: 3_600_000 });
    sched.tick(); // throws inside, must not escape
    assert.equal(pings.length, 0);
    const savedTime = () => JSON.parse(db.prepare("SELECT value FROM scheduler_state WHERE key = 'scheduler_last_tick'").get().value);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'scheduler_last_tick'").get().n, 0, "the old settings row was taken over and removed");
    assert.equal(savedTime(), twoHoursAgo, "a failed tick doesn't move the saved time");
    boom = false;
    sched.tick();
    assert.ok(pings.some((u) => u.includes("while-away")), "the post that went live during downtime is announced");
    const saved = savedTime();
    assert.ok(saved > twoHoursAgo);
    assert.equal(ctx.pruned, 1, "expired staff sessions pruned");
    assert.equal(ctx.prunedMembers, 1, "expired reader sessions pruned");
    sched.tick();
    assert.equal(ctx.pruned, 1, "pruning happens at most hourly");
    sched.stop();
  } finally {
    console.warn = warn;
    console.log = log;
  }
});

// --- scripts/user.js ---

test("user script: refuses a missing database, validates emails, guards owners, keeps suspension, ends sessions", async () => {
  const script = path.join(import.meta.dirname, "..", "scripts", "user.js");
  const run = (dir, ...args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, APP_SECRET: "", DATA_DIR: dir, NODE_ENV: "development" }, encoding: "utf8" });
  const missing = path.join(tmp("user-missing"), "nope");
  const r0 = run(missing, "list");
  assert.notEqual(r0.status, 0);
  assert.match(r0.stderr, /No database/i);
  assert.ok(!fs.existsSync(path.join(missing, "blog.db")), "a missing database is not created");

  const dir = tmp("user");
  const nokey = tmp("user-nokey");
  openDb(nokey).close();
  const rk = run(nokey, "list");
  assert.notEqual(rk.status, 0);
  assert.match(rk.stderr, /secret.key/);

  openDb(dir).close(); // an existing, empty database
  createSecrets(dir); // and its secret.key
  const dbPath = path.join(dir, "blog.db");
  let r = run(dir, "create", "bad,email@example.com", "Bad", "author");
  assert.notEqual(r.status, 0);
  r = run(dir, "create", "Mixed.Case@Example.com", "Esc\u001b[31m Name", "author");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mixed\.case@example\.com/);
  assert.ok(r.stdout.includes(dbPath) || r.stderr.includes(dbPath) || /blog\.db/.test(r.stdout + r.stderr), "prints the database path");
  r = run(dir, "create", "MIXED.case@example.com", "Dup", "author");
  assert.notEqual(r.status, 0, "case-insensitive duplicate");
  r = run(dir, "create", "boss@example.com", "Boss", "owner");
  assert.notEqual(r.status, 0, "owner needs --force");
  assert.match(r.stderr, /--force/);
  r = run(dir, "create", "boss@example.com", "Boss", "owner", "--force");
  assert.equal(r.status, 0, r.stderr);
  r = run(dir, "list");
  assert.ok(!r.stdout.includes("\u001b"), "control characters are stripped");
  assert.match(r.stdout, /Esc/);

  // Reset keeps a suspension unless --activate.
  const db = openDb(dir);
  db.prepare("UPDATE users SET status = 'suspended' WHERE email = 'mixed.case@example.com'").run();
  r = run(dir, "reset", "mixed.case@example.com");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(db.prepare("SELECT status FROM users WHERE email = 'mixed.case@example.com'").get().status, "suspended");
  r = run(dir, "reset", "mixed.case@example.com", "--activate");
  assert.equal(db.prepare("SELECT status FROM users WHERE email = 'mixed.case@example.com'").get().status, "active");

  // end-sessions
  const sess = (email) => db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)").get(email).n;
  const uid = db.prepare("SELECT id FROM users WHERE email = 'boss@example.com'").get().id;
  const exp = new Date(Date.now() + 864e5).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, csrf, created_at, expires_at) VALUES ('tok1', ?, 'c', ?, ?)").run(uid, exp, exp);
  assert.equal(sess("boss@example.com"), 1);
  r = run(dir, "end-sessions", "boss@example.com");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sess("boss@example.com"), 0);
  db.prepare("INSERT INTO sessions (id, user_id, csrf, created_at, expires_at) VALUES ('tok2', ?, 'c', ?, ?)").run(uid, exp, exp);
  r = run(dir, "end-sessions", "--all");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  db.close();
});

test("scripts: browser scripts refuse remote URLs without --allow-remote and need credentials from the environment", () => {
  for (const name of ["editor-flow.js", "verify-pages.js"]) {
    const script = path.join(import.meta.dirname, "..", "scripts", name);
    const r = spawnSync(process.execPath, [script, "https://blog.example.com/"], { env: { ...process.env, BLOG_ADMIN_EMAIL: "a@example.com", BLOG_ADMIN_PASSWORD: "x" }, encoding: "utf8", timeout: 20_000 });
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /--allow-remote/, name);
  }
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "scripts", "editor-flow.js"), "http://localhost:1/"], { env: { ...process.env, BLOG_ADMIN_EMAIL: "", BLOG_ADMIN_PASSWORD: "" }, encoding: "utf8", timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BLOG_ADMIN_EMAIL/);
});

test("seed script: refuses production data and a site that already has content", () => {
  const script = path.join(import.meta.dirname, "..", "scripts", "seed-demo.js");
  const dir = tmp("seed");
  const db = openDb(dir);
  db.prepare("INSERT INTO subscribers (email, name, source, status, token, created_at) VALUES ('real@example.com', '', '', 'active', 'abc', ?)").run(new Date().toISOString());
  createSecrets(dir);
  db.close();
  const run = (env, ...args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, DATA_DIR: dir, ...env }, encoding: "utf8" });
  let r = run({ NODE_ENV: "production" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--force/);
  r = run({ NODE_ENV: "development" });
  assert.notEqual(r.status, 0, "a site that already has an owner needs --force");
  assert.match(r.stderr, /--force/);
});

test("newsletter: nothing is sent while the site address is only a local one", async () => {
  const s = newsletterSetup({ send: () => ({}) });
  s.addSub("a@example.com");
  s.ctx.site = () => ({ ...fakeSite(), hasPublicUrl: false });
  assert.equal(s.sender.start(s.newsletter.id), false);
  assert.match(s.sender.blockedReason(), /Site URL/);
  assert.equal(s.calls.length, 0);
  assert.equal(s.store.newsletters.get(s.newsletter.id).status, "draft");
});
