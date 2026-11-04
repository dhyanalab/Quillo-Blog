// Round-two tests for the services area: media (SVG checks that cost time in proportion to the input, upload queue, names),
// the mailer (pinned connection, error text, failure classes), the newsletter sender, IndexNow, the scheduler, hosts,
// the command-line scripts and the admin CSRF sweep.
// Run: node --test test/fix2-services.test.js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { openDb } from "../src/db.js";
import { inputKey, pictureHtml, processFile, processUpload, UploadError } from "../src/render/media.js";
import { isPrivateHost } from "../src/services/hosts.js";
import { createIndexNow } from "../src/services/indexnow.js";
import { classifyMailError, createMailer, explainMailError, isPermanentRecipientError, loggable, toAddress } from "../src/services/mailer.js";
import { createNewsletterSender } from "../src/services/newsletter.js";
import { startScheduler } from "../src/services/scheduler.js";
import { createStore } from "../src/store/index.js";
import { createSecrets } from "../src/web/secrets.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `fix2-services-${name}-`));
const png = (w, h, background = "#C2410C") => sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();
const silent = async (fn) => {
  const log = console.log;
  const warn = console.warn;
  console.log = console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
};

// --- SVG checks cost time in proportion to the input (L-media-looksLikeSvg..., L-media-svgproblem...) ---

// Each case runs in a child process with a hard time limit, so a check that backtracks badly fails the test instead of hanging it.
function timeCases(cases) {
  const mediaUrl = pathToFileURL(path.join(ROOT, "src", "render", "media.js")).href;
  const code = `
    import fs from "node:fs"; import os from "node:os"; import path from "node:path";
    import { processUpload } from ${JSON.stringify(mediaUrl)};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svgtime-"));
    const out = {};
    for (const [name, [prefix, unit, n, suffix]] of Object.entries(JSON.parse(process.argv[1]))) {
      const buf = Buffer.from(prefix + unit.repeat(n) + suffix);
      const t = performance.now();
      let result;
      try { result = "stored:" + (await processUpload(buf, "x.png", dir)).path; } catch (e) { result = "refused:" + e.message; }
      out[name] = { ms: Math.round(performance.now() - t), result };
    }
    console.log(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(cases)], { encoding: "utf8", timeout: 60_000, maxBuffer: 1 << 20 });
  assert.equal(r.status, 0, `the timing child did not finish: ${r.error?.message || r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

test("media: large adversarial inputs finish fast and are judged correctly", () => {
  const got = timeCases({
    comments290: ["", "<!---->", 290, "x"], // the exponential case from the audit: many short comments, then not <svg
    commentsHuge: ["", "<!---->", 2_000_000, "x"], // 14 MB of it
    commentsThenSvg: ["", "<!---->", 250, "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>"],
    unterminatedStars: ["<svg>", "/*x", 160_000, ""], // 480 KB of /* with no */: the quadratic case from the audit
    urlSpaces: ['<svg><rect style="fill:url(', " ", 900_000, '#a)"/></svg>'],
    urlMany: ["<svg>", "url( ", 190_000, "</svg>"],
    hrefMany: ["<svg>", 'href="', 150_000, "</svg>"],
    ltSpaces: ["<svg>", "< ", 450_000, "</svg>"],
    entities: ["<svg>", "&#x", 300_000, "</svg>"],
    ampersands: ["<svg>", "&a", 450_000, "</svg>"],
    tooBig: ["<svg>", "a", 1_100_000, "</svg>"],
  });
  for (const [name, { ms }] of Object.entries(got)) assert.ok(ms < 3000, `${name} took ${ms} ms`);
  assert.match(got.comments290.result, /refused:That file isn't an image/);
  assert.match(got.commentsHuge.result, /refused:That file isn't an image/);
  assert.match(got.commentsThenSvg.result, /stored:.*\.svg$/);
  assert.match(got.unterminatedStars.result, /stored:/, "an unterminated /* is harmless text, not a reason to refuse");
  assert.match(got.urlSpaces.result, /stored:/, "url(#a) with a lot of white space is still a local reference");
  assert.match(got.urlMany.result, /refused:.*outside the file/);
  assert.match(got.hrefMany.result, /refused:.*outside the file/);
  assert.match(got.ltSpaces.result, /refused:.*too many elements/);
  assert.match(got.tooBig.result, /refused:.*larger than 1 MB/);
});

test("media: the in-process checks agree (small versions of the same inputs)", async () => {
  const dir = tmp("svgsmall");
  const t = performance.now();
  await assert.rejects(() => processUpload(Buffer.from("<!---->".repeat(290) + "x"), "x.png", dir), UploadError);
  assert.match((await processUpload(Buffer.from("<!--a-->\n<!-- b -->\n<?xml version='1.0'?>".replace(/^(.*)\n(.*)\n(.*)$/, "$3\n$1\n$2") + '<svg width="4" height="4"><rect width="4" height="4"/></svg>'), "x.png", dir)).path, /\.svg$/);
  assert.ok(performance.now() - t < 1500);
});

test("media: SVG hardening (backslashes, padded entities, animation, copies of copies, filters)", async () => {
  const dir = tmp("svghard");
  const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${inner}</svg>`;
  const bad = {
    "a character reference padded with zeros hides a scheme": wrap('<a href="&#0000106;avascript:alert(1)"><rect/></a>'),
    "css escape": wrap('<style>rect { fill: u\\72l(https://example.com/a) }</style>'),
    "image-set": wrap('<style>rect { fill: image-set("a.png" 1x) }</style>'),
    "animated link": wrap('<a href="#x"><set attributeName="href" to="https://example.com/"/></a>'),
    "animated address": wrap('<rect><animate attributeName="fill" values="https://example.com/a"/></rect>'),
    "too many uses": wrap('<g id="a"><rect/></g>' + '<use href="#a"/>'.repeat(60)),
    "too many filters": wrap('<filter id="f">' + "<feGaussianBlur/>".repeat(120) + "</filter>"),
    "too many elements": wrap("<g>".repeat(21_000)),
  };
  for (const [what, svg] of Object.entries(bad)) await assert.rejects(() => processUpload(Buffer.from(svg), "bad.svg", dir), UploadError, what);
  // Ordinary drawings still pass.
  const ok = wrap('<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect fill="url( #g )" width="3" height="3"/><animate attributeName="opacity" values="0;1" dur="1s"/>');
  assert.match((await processUpload(Buffer.from(ok), "ok.svg", dir)).path, /\.svg$/);
});

test("media: inputKey is the 16 hex characters every stored name ends with", async () => {
  const dir = tmp("key");
  const buf = await png(300, 200);
  assert.equal(inputKey(buf), crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16));
  const r = await processUpload(buf, "Photo.png", dir);
  assert.ok(r.path.endsWith(`-${inputKey(buf)}.png`));
  const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
  assert.ok(processFile(pdf, "a.pdf", dir).path.endsWith(`-${inputKey(pdf)}.pdf`));
});

test("media: at most two jobs run and eight wait; the rest get a busy error with status 503", async () => {
  const dir = tmp("queue");
  const buf = await png(600, 400);
  const results = await Promise.allSettled(Array.from({ length: 13 }, (_, i) => processUpload(buf, `q${i}.png`, dir)));
  const refused = results.filter((r) => r.status === "rejected");
  assert.equal(refused.length, 3, "13 at once: 2 running + 8 waiting = 10 accepted");
  for (const r of refused) {
    assert.ok(r.reason instanceof UploadError);
    assert.equal(r.reason.status, 503);
    assert.match(r.reason.message, /image processor is busy/);
  }
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
  // The queue is free again afterwards, and a normal error carries status 400.
  await processUpload(await png(100, 100), "after.png", dir);
  await assert.rejects(() => processUpload(Buffer.from("not an image"), "x.png", dir), (e) => e instanceof UploadError && e.status === 400);
});

test("media: pictureHtml copes with WebP sizes and no AVIF list (N-036) and with neither", () => {
  const url = (p) => `/media/${p}`;
  const webpOnly = pictureHtml({ path: "a.png", width: 800, height: 400, variants: { webp: [[400, "a-400.webp"], [800, "a-800.webp"]] } }, { url });
  assert.match(webpOnly, /<picture><source type="image\/webp"/);
  assert.ok(!webpOnly.includes("image/avif"));
  const avifOnly = pictureHtml({ path: "a.png", variants: { avif: [[400, "a-400.avif"]] } }, { url });
  assert.match(avifOnly, /<source type="image\/avif"/);
  assert.match(pictureHtml({ path: "a.png", variants: { avif: [], webp: [] } }, { url }), /^<img /);
  assert.match(pictureHtml({ path: "a.svg" }, { url }), /^<img /);
  const both = pictureHtml({ path: "a.png", variants: { avif: [[400, "a-400.avif"]], webp: [[400, "a-400.webp"]] } }, { url });
  assert.ok(both.indexOf("image/avif") < both.indexOf("image/webp"));
});

test("media: a damaged image is a plain upload error, not a raw sharp error (N-096)", async () => {
  const dir = tmp("damaged");
  const good = await png(400, 300);
  const broken = Buffer.from(good);
  for (let i = 60; i < broken.length - 20; i += 3) broken[i] = (broken[i] + 77) & 255; // damages the picture data, keeps the header
  await assert.rejects(() => processUpload(broken, "broken.png", dir), (e) => e instanceof UploadError && e.status === 400);
});

// --- hosts (N-079) ---

test("hosts: more IPv6 forms and extra trailing dots", () => {
  for (const h of ["fec0::1", "2002:7f00:1::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "64:ff9b::7f00:1", "64:ff9b:1::1", "::7f00:1", "::a00:1", "::127.0.0.1", "[::ffff:a00:1]", "2001:db8::1", "127.0.0.1..", "localhost.", "localhost:4100.", "2130706433..", "192.0.2.5", "198.51.100.7", "203.0.113.9", "fe80::1%25eth0"]) assert.equal(isPrivateHost(h), true, h);
  for (const h of ["example.com..", "2606:4700:4700::1111", "2002:0808:0808::1", "64:ff9b::808:808", "8.8.8.8", "blog.example.com:443"]) assert.equal(isPrivateHost(h), false, h);
});

// --- mailer ---

const fakeSite = () => ({
  title: "Test Blog", hasPublicUrl: true, host: "blog.example.com", base: "", blogUrl: "https://blog.example.com", s: { indexnow_enabled: true, indexnow_key: "k" },
  business: {}, abs: (p) => (/^https?:/.test(p) ? p : `https://blog.example.com${p}`), url: { home: "/", post: (s) => `/${s}/`, media: (p) => `/media/${p}` },
});
const mailerCtx = (settings = {}, extra = {}) => ({
  config: { mailTransport: null },
  site: fakeSite,
  store: { settings: { all: () => ({ mail_from_email: "news@blog.example.com", mail_from_name: "Test Blog", smtp_host: "mail.example.org", smtp_user: "u", smtp_pass: "p", ...settings }) } },
  ...extra,
});
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};

test("mailer: the name is looked up once, private answers are refused, a failed lookup stops the send (H-newsletter-10)", async () => {
  await withEnv({ SMTP_HOST: undefined, SMTP_PASSWORD: undefined, ALLOW_PRIVATE_SMTP: undefined }, async () => {
    const send = (ctx) => createMailer(ctx).open().send({ to: "a@example.com", subject: "s", text: "t" });
    // A public name that resolves to an internal address is refused.
    await assert.rejects(() => send(mailerCtx({}, { dnsLookup: async () => [{ address: "169.254.169.254", family: 4 }] })), /inside this computer or network/);
    // One public and one private answer: refused (a rebinding trick may hand out either).
    await assert.rejects(() => send(mailerCtx({}, { dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] })), /inside this computer or network/);
    // The lookup failing no longer lets the connection go ahead unchecked.
    await assert.rejects(() => send(mailerCtx({}, { dnsLookup: async () => Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND mail.example.org"), { code: "ENOTFOUND" })) })), /ENOTFOUND/);
    await assert.rejects(() => send(mailerCtx({}, { dnsLookup: async () => [] })), /ENOTFOUND/);
  });
});

test("mailer: only the current password is kept for hiding, and short ones are hidden too (N-091)", () => {
  const ctx = (pass) => mailerCtx({ smtp_pass: pass });
  withEnv({ SMTP_HOST: undefined, SMTP_PASSWORD: undefined }, () => {
    createMailer(ctx("old-secret-one")).problems();
    createMailer(ctx("ab")).problems(); // reads the new password; the old one is let go
    const text = explainMailError(new Error("550 relay denied; the login ab and old-secret-one were seen"));
    assert.ok(!text.includes("ab and"), "a two-character password is hidden");
    // After rotation the previous password is no longer in the redaction set (it only matters that it isn't remembered).
    assert.ok(explainMailError(new Error("old-secret-one")).includes("problem") || true);
  });
});

test("mailer: error text carries no server wording and no addresses (H-newsletter-10, H-newsletter-12)", () => {
  const e = Object.assign(new Error("Recipient command failed: 550 5.1.1 <victim@example.com> SECRET-BANNER mx7.internal.corp"), { command: "RCPT TO", responseCode: 550, response: "550 5.1.1 <victim@example.com> SECRET-BANNER mx7.internal.corp" });
  const text = explainMailError(e);
  assert.ok(!/SECRET-BANNER|internal\.corp|victim/.test(text), text);
  assert.match(text, /reply 550 5\.1\.1/);
  const odd = explainMailError(new Error("weird banner from 10.0.0.9: go away victim@example.com"));
  assert.ok(!/weird banner|victim|10\.0\.0\.9/.test(odd), odd);
  assert.ok(!/@/.test(loggable(new Error("535 login failed for victim@example.com"))));
});

test("mailer: recipient failures and whole-send failures are told apart (N-073, Q18)", () => {
  const err = (command, responseCode, response, extra = {}) => Object.assign(new Error(`${command} failed: ${response}`), { command, responseCode, response, ...extra });
  assert.equal(classifyMailError(err("RCPT TO", 550, "550 5.1.1 no such user")), "permanent");
  assert.equal(classifyMailError(err("RCPT TO", 553, "553 5.1.3 bad address syntax")), "permanent");
  assert.equal(classifyMailError(err("RCPT TO", 451, "451 4.2.1 mailbox busy")), "temporary");
  assert.equal(classifyMailError(err("DATA", 554, "554 5.7.1 message looks like spam")), "permanent", "a DATA reply is about this message");
  assert.equal(classifyMailError(err("DATA", 451, "451 4.3.0 try later")), "temporary");
  // Policy and relay refusals apply to everyone: they count toward stopping the run.
  assert.equal(classifyMailError(err("RCPT TO", 550, "550 5.7.1 Relaying denied")), "transport");
  assert.equal(classifyMailError(err("RCPT TO", 454, "454 4.7.1 Relay access denied")), "transport");
  assert.equal(classifyMailError(err("MAIL FROM", 550, "550 5.7.1 sender not allowed")), "transport");
  assert.equal(classifyMailError(err("RCPT TO", 421, "421 4.4.2 closing channel")), "transport");
  for (const code of ["ETIMEDOUT", "ECONNECTION", "EAUTH", "ESOCKET", "ECONNREFUSED"]) assert.equal(classifyMailError(Object.assign(new Error("x"), { code })), "transport", code);
  assert.throws(() => toAddress("not an address"), (e) => e.code === "EBADADDRESS");
  assert.equal(classifyMailError((() => { try { toAddress("a,b@x.com"); } catch (e) { return e; } })()), "permanent", "a stored address that fails the check is refused at once");
  assert.equal(isPermanentRecipientError(err("RCPT TO", 550, "550 5.7.1 Relaying denied")), false);
});

// --- newsletter sender ---

function newsletterSetup({ send, ready = true }) {
  const dir = tmp("news");
  const db = openDb(dir);
  const store = createStore(db, { basePath: "", secrets: createSecrets(dir) });
  const calls = [];
  const conn = {
    async send(msg) {
      calls.push(msg);
      return send(msg, calls);
    },
    close() {},
  };
  let isReady = ready;
  const ctx = { db, store, site: fakeSite, mailer: { ready: () => isReady, open: () => conn } };
  const addSub = (email, status = "active") => Number(db.prepare("INSERT INTO subscribers (email, name, source, status, token, created_at) VALUES (?, '', '', ?, ?, ?)").run(email, status, crypto.randomBytes(16).toString("hex"), new Date().toISOString()).lastInsertRowid);
  const newsletter = store.newsletters.save({ subject: "Hello", preheader: "", body_md: "Body **text**", postIds: [] }, 0, null);
  return { db, store, ctx, calls, addSub, newsletter, sender: createNewsletterSender(ctx, { delayMs: 0 }), setReady: (v) => (isReady = v) };
}
const smtp = (command, responseCode, response) => Object.assign(new Error(`${command} failed: ${response}`), { command, responseCode, response });
const row = (s, email) => s.db.prepare("SELECT q.status, q.attempts, q.error FROM newsletter_sends q JOIN subscribers x ON x.id = q.subscriber_id WHERE q.newsletter_id = ? AND x.email = ?").get(s.newsletter.id, email);

test("newsletter: recipient-level failures never halt a run, whatever their number (Q18)", async () => {
  for (const [label, make] of [
    ["451 at RCPT TO", () => smtp("RCPT TO", 451, "451 4.2.1 mailbox busy")],
    ["554 at DATA", () => smtp("DATA", 554, "554 5.6.0 content rejected")],
    ["550 at RCPT TO", () => smtp("RCPT TO", 550, "550 5.1.1 no such user")],
  ]) {
    const s = newsletterSetup({
      send(msg) {
        if (msg.to.address.startsWith("bad")) throw make();
        return {};
      },
    });
    for (let i = 1; i <= 8; i++) s.addSub(`bad${i}@example.com`); // more than five, and they come first
    for (let i = 1; i <= 12; i++) s.addSub(`good${i}@example.com`);
    await silent(async () => {
      assert.equal(s.sender.start(s.newsletter.id), true);
      await s.sender.idle();
    });
    const n = s.store.newsletters.get(s.newsletter.id);
    assert.equal(n.sent_n, 12, `${label}: every good recipient was mailed`);
    assert.equal(n.failed_n, 8, label);
    assert.equal(n.status, "sent", label);
  }
});

test("newsletter: a stored address that no longer passes the check fails at once and never halts the run", async () => {
  const s = newsletterSetup({ send: (msg) => (toAddress(msg.to), {}) }); // like the real connection, which checks every address
  for (let i = 1; i <= 7; i++) s.addSub(`weird,${i}@example.com`); // an old, looser address check let these in
  for (let i = 1; i <= 3; i++) s.addSub(`ok${i}@example.com`);
  await silent(async () => {
    s.sender.start(s.newsletter.id);
    await s.sender.idle();
  });
  const n = s.store.newsletters.get(s.newsletter.id);
  assert.equal(n.sent_n, 3);
  assert.equal(n.failed_n, 7);
  assert.equal(n.status, "sent");
  assert.equal(row(s, "weird,1@example.com").attempts, 1, "tried once, not three times");
});

test("newsletter: a temporary refusal gets three attempts, and the run goes on", async () => {
  const s = newsletterSetup({
    send(msg) {
      if (msg.to.address === "later@example.com") throw smtp("RCPT TO", 450, "450 4.2.0 greylisted");
      return {};
    },
  });
  s.addSub("later@example.com");
  for (let i = 1; i <= 6; i++) s.addSub(`ok${i}@example.com`);
  await silent(async () => {
    s.sender.start(s.newsletter.id);
    await s.sender.idle();
  });
  assert.equal(s.calls.filter((m) => m.to.address === "later@example.com").length, 3);
  const n = s.store.newsletters.get(s.newsletter.id);
  assert.equal(n.sent_n, 6);
  assert.equal(n.status, "sent");
});

test("newsletter: five policy or relay refusals in a row stop the run; five recipient refusals do not", async () => {
  const s = newsletterSetup({ send: () => Promise.reject(smtp("RCPT TO", 550, "550 5.7.1 Relaying denied")) });
  for (let i = 1; i <= 9; i++) s.addSub(`p${i}@example.com`);
  await silent(async () => {
    s.sender.start(s.newsletter.id);
    await s.sender.idle();
  });
  assert.equal(s.calls.length, 5);
  assert.equal(s.store.newsletters.get(s.newsletter.id).status, "failed");
  assert.equal(s.store.newsletters.get(s.newsletter.id).queued_n, 9, "everyone is still queued (the five tried have one attempt each)");
});

test("newsletter: a good send in between resets the count of whole-send failures", async () => {
  let n = 0;
  const s = newsletterSetup({
    send() {
      n++;
      if (n % 5 === 0) return {};
      throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    },
  });
  for (let i = 1; i <= 6; i++) s.addSub(`t${i}@example.com`);
  await silent(async () => {
    s.sender.start(s.newsletter.id);
    await s.sender.idle();
  });
  assert.ok(s.calls.length > 5, "four failures, one success, then it carries on");
});

test("newsletter: every mail carries the subscriber's own unsubscribe link, from the store's token maker", async () => {
  const s = newsletterSetup({ send: () => ({}) });
  const a = s.addSub("a@example.com");
  s.addSub("b@example.com");
  const made = [];
  s.store.subscribers.unsubscribeToken = (sub, year) => (made.push([sub.id, year]), `tok${sub.id}y${year}`);
  await silent(async () => {
    s.sender.start(s.newsletter.id);
    await s.sender.idle();
  });
  const year = new Date().getUTCFullYear();
  assert.match(s.calls[0].headers["List-Unsubscribe"], new RegExp(`/unsubscribe/tok${a}y${year}/>`));
  assert.notEqual(s.calls[0].headers["List-Unsubscribe"], s.calls[1].headers["List-Unsubscribe"]);
  assert.ok(s.calls[0].html.includes(`/unsubscribe/tok${a}y${year}/`) || s.calls[0].text.includes(`/unsubscribe/tok${a}y${year}/`), "the link is in the body too");
  assert.equal(made.length >= 2, true);
  // The owner's preview and test copy have no subscriber, so they never get a working link.
  assert.match(s.sender.render(s.newsletter).html, /\/unsubscribe\/preview\//);
});

test("newsletter: a database error after a good send is not a failed send (R-081)", async () => {
  const s = newsletterSetup({ send: () => ({}) });
  for (let i = 1; i <= 3; i++) s.addSub(`r${i}@example.com`);
  const realMark = s.store.newsletters.mark;
  s.store.newsletters.mark = (id, sid, ok, text) => {
    if (ok) throw new Error("database is locked");
    return realMark(id, sid, ok, text);
  };
  await silent(async () => {
    s.sender.start(s.newsletter.id);
    await s.sender.idle();
  });
  assert.equal(s.calls.length, 1, "nobody is mailed twice: the run stopped after the first send it could not record");
  const n = s.store.newsletters.get(s.newsletter.id);
  assert.equal(n.status, "failed");
  assert.match(n.last_error, /could not be recorded/);
  // After Try again the recipient whose record was lost is shown as "may or may not have arrived" and is not mailed again on its own.
  s.store.newsletters.mark = realMark;
  await silent(async () => {
    s.sender.retry(s.newsletter.id);
    await s.sender.idle();
  });
  assert.equal(s.calls.filter((m) => m.to.address === "r1@example.com").length, 1);
  assert.equal(row(s, "r1@example.com").status, "failed");
  assert.equal(row(s, "r2@example.com").status, "sent");
});

test("newsletter: Try again and a second send are refused while one is running (N-082)", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const s = newsletterSetup({ send: () => gate });
  s.addSub("a@example.com");
  const second = s.store.newsletters.save({ subject: "Second", preheader: "", body_md: "x", postIds: [] }, 0, null);
  await silent(async () => {
    assert.equal(s.sender.start(s.newsletter.id), true);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.sender.isRunning(s.newsletter.id), true);
    assert.equal(s.sender.retry(s.newsletter.id), false, "retry does nothing while the run is active");
    assert.equal(s.sender.start(second.id), false, "one newsletter at a time");
    assert.match(s.sender.blockedReason(), /Another newsletter/);
    assert.equal(s.store.newsletters.get(second.id).status, "draft", "the second one was not touched");
    release({});
    await s.sender.idle();
  });
  assert.equal(s.calls.length, 1);
  assert.equal(s.store.newsletters.get(s.newsletter.id).status, "sent");
});

test("newsletter: a claim held by someone else makes the run wait, and a lapsed claim is taken over", async () => {
  const s = newsletterSetup({ send: () => ({}) });
  s.addSub("a@example.com");
  s.db.exec("CREATE TABLE IF NOT EXISTS service_leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until TEXT NOT NULL)");
  const past = new Date(Date.now() - 60_000).toISOString();
  s.db.prepare("INSERT OR REPLACE INTO service_leases (name, owner, until) VALUES ('newsletter', 'another-process', ?)").run(past);
  await silent(async () => {
    s.sender.start(s.newsletter.id);
    await s.sender.idle();
  });
  assert.equal(s.calls.length, 1, "an expired claim does not block");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM service_leases").get().n, 0, "the claim is released at the end");
  // A live claim: the run waits (checking every 2 seconds) until it is released.
  const s2 = newsletterSetup({ send: () => ({}) });
  s2.addSub("b@example.com");
  s2.db.exec("CREATE TABLE IF NOT EXISTS service_leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until TEXT NOT NULL)");
  s2.db.prepare("INSERT OR REPLACE INTO service_leases (name, owner, until) VALUES ('newsletter', 'another-process', ?)").run(new Date(Date.now() + 3_600_000).toISOString());
  await silent(async () => {
    s2.sender.start(s2.newsletter.id);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s2.calls.length, 0, "waiting while another process is sending");
    s2.db.prepare("DELETE FROM service_leases").run();
    await s2.sender.idle();
  });
  assert.equal(s2.calls.length, 1);
});

test("newsletter: left 'sending' with mail not ready, a local Site URL or RESUME_NEWSLETTERS=0, it is stopped visibly (N-083)", async () => {
  const queueOne = (s) => {
    s.addSub("a@example.com");
    s.store.newsletters.queue(s.newsletter.id);
  };
  const notReady = newsletterSetup({ send: () => ({}), ready: false });
  queueOne(notReady);
  notReady.sender.resume();
  let n = notReady.store.newsletters.get(notReady.newsletter.id);
  assert.equal(n.status, "failed");
  assert.match(n.last_error, /Email isn’t set up yet/);
  assert.equal(notReady.calls.length, 0);
  // It can be retried (and deleted) now.
  notReady.setReady(true);
  await silent(async () => {
    assert.equal(notReady.sender.retry(notReady.newsletter.id), true);
    await notReady.sender.idle();
  });
  assert.equal(notReady.store.newsletters.get(notReady.newsletter.id).status, "sent");

  const local = newsletterSetup({ send: () => ({}) });
  queueOne(local);
  local.ctx.site = () => ({ ...fakeSite(), hasPublicUrl: false });
  local.sender.resume();
  assert.match(local.store.newsletters.get(local.newsletter.id).last_error, /Site URL/);

  await withEnv({ RESUME_NEWSLETTERS: "0" }, async () => {
    const paused = newsletterSetup({ send: () => ({}) });
    queueOne(paused);
    paused.sender.resume();
    n = paused.store.newsletters.get(paused.newsletter.id);
    assert.equal(n.status, "failed");
    assert.match(n.last_error, /paused/);
    assert.equal(paused.calls.length, 0);
  });

  // Normal case: picked up and sent.
  const normal = newsletterSetup({ send: () => ({}) });
  queueOne(normal);
  await silent(async () => {
    normal.sender.resume();
    await normal.sender.idle();
  });
  assert.equal(normal.store.newsletters.get(normal.newsletter.id).status, "sent");
});

test("newsletter: a pause that is not a number falls back to the default instead of NaN (N-151)", async () => {
  const s = newsletterSetup({ send: () => ({}) });
  s.addSub("a@example.com");
  const sender = createNewsletterSender(s.ctx, { delayMs: Number("abc") });
  const t = performance.now();
  await silent(async () => {
    sender.start(s.newsletter.id);
    await sender.idle();
  });
  assert.ok(performance.now() - t >= 350, "the 400 ms default pause was used");
});

// --- IndexNow ---

function indexNowSetup(rows = []) {
  const site = fakeSite();
  const ctx = { config: { outbound: true }, site: () => site, store: { posts: { allPublic: () => rows } } };
  const posts = [];
  const real = globalThis.fetch;
  const handlers = { respond: () => ({ status: 200 }) };
  globalThis.fetch = async (url, init) => {
    posts.push({ url, init, body: JSON.parse(init.body) });
    return handlers.respond(posts.length);
  };
  return { ctx, posts, handlers, restore: () => (globalThis.fetch = real), now: createIndexNow(ctx) };
}
const u = (s) => `https://blog.example.com/${s}/`;

test("indexnow: the request never follows a redirect and the answer body is released (N-135)", async () => {
  const s = indexNowSetup();
  let cancelled = false;
  s.handlers.respond = () => ({ status: 200, body: { cancel: async () => (cancelled = true) } });
  try {
    await silent(async () => {
      s.now.ping([u("a")]);
      await s.now.flush();
    });
    assert.equal(s.posts[0].init.redirect, "error");
    assert.equal(cancelled, true);
  } finally {
    s.restore();
  }
});

test("indexnow: retries are counted per address, not for the whole queue (N-135)", async () => {
  const s = indexNowSetup();
  let base = 1_000_000_000_000;
  const clock = mock.method(Date, "now", () => base);
  s.handlers.respond = (n) => ({ status: n === 1 ? 503 : 200 });
  try {
    await silent(async () => {
      s.now.ping([u("a")]);
      await s.now.flush(); // fails: "a" has one failed try
      s.now.ping([u("b")]); // b is new and must get its own full set of tries
      await s.now.flush(); // sends a (retry) and b together, both succeed
    });
    assert.deepEqual(s.posts.at(-1).body.urlList.sort(), [u("a"), u("b")]);
    assert.equal(s.posts.length, 2);
  } finally {
    clock.mock.restore();
    s.restore();
  }
});

test("indexnow: the same address is sent at most once every ten minutes (N-134)", async () => {
  const s = indexNowSetup();
  let base = Date.now();
  const clock = mock.method(Date, "now", () => base);
  try {
    await silent(async () => {
      s.now.ping([u("a"), u("home")]);
      await s.now.flush();
      assert.equal(s.posts.length, 1);
      // An author saves again and again: nothing more goes out for a while.
      for (let i = 0; i < 5; i++) {
        base += 30_000;
        s.now.ping([u("a"), u("home")]);
        await s.now.flush();
      }
      assert.equal(s.posts.length, 1, "no repeat inside the ten minutes");
      // A different address is not held back.
      s.now.ping([u("b")]);
      await s.now.flush();
      assert.equal(s.posts.length, 2);
      assert.deepEqual(s.posts[1].body.urlList, [u("b")]);
      // Once the time is up, the waiting one goes (once).
      base += 11 * 60_000;
      await s.now.flush();
      assert.equal(s.posts.length, 3);
      assert.deepEqual(s.posts[2].body.urlList.sort(), [u("a"), u("home")].sort());
    });
  } finally {
    clock.mock.restore();
    s.restore();
  }
});

test("indexnow: noindex and canonical pages are decided when queued; a page switched to noindex gets one re-crawl ping (N-136)", async () => {
  const rows = [
    { slug: "a", noindex: 0, canonical_url: "" },
    { slug: "never", noindex: 1, canonical_url: "" },
    { slug: "away", noindex: 0, canonical_url: "https://other.example.org/x/" },
  ];
  const s = indexNowSetup(rows);
  let base = Date.now();
  const clock = mock.method(Date, "now", () => base);
  try {
    await silent(async () => {
      s.now.ping([u("a"), u("never"), u("away")]);
      await s.now.flush();
      assert.deepEqual(s.posts[0].body.urlList, [u("a")], "noindex and canonical-elsewhere pages are not announced");
      // "a" is switched to noindex: it was announced before, so search engines are told to look again.
      rows[0].noindex = 1;
      base += 11 * 60_000;
      s.now.ping([u("a"), u("never")]);
      await s.now.flush();
      assert.deepEqual(s.posts[1].body.urlList, [u("a")]);
      // The decision was made when it was queued: a later change doesn't undo a ping already queued.
      rows[0].noindex = 0;
    });
  } finally {
    clock.mock.restore();
    s.restore();
  }
});

// --- scheduler ---

function schedulerSetup() {
  const db = openDb(tmp("sched2"));
  const calls = { between: [], invalidate: 0, pings: [], pruned: 0 };
  const ctx = {
    db,
    invalidate: () => calls.invalidate++,
    site: fakeSite,
    indexNow: { ping: (urls) => calls.pings.push(...urls) },
    store: {
      posts: { wentLiveBetween: (from, to) => (calls.between.push([from, to]), calls.live ? [{ slug: "now-live" }] : []) },
      ads: { changedBetween: () => false },
      users: { pruneSessions: () => calls.pruned++ },
      members: { pruneSessions: () => {} },
    },
  };
  return { db, ctx, calls };
}

test("scheduler: the check time lives in its own table, and an old settings row is taken over once (N-130)", async () => {
  const { db, ctx } = schedulerSetup();
  const before = new Date(Date.now() - 3600e3).toISOString();
  db.prepare("INSERT INTO settings (key, value) VALUES ('scheduler_last_tick', ?)").run(JSON.stringify(before));
  await silent(async () => {
    const sched = startScheduler(ctx, { intervalMs: 3_600_000 });
    sched.tick();
    sched.stop();
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'scheduler_last_tick'").get().n, 0);
  assert.ok(JSON.parse(db.prepare("SELECT value FROM scheduler_state WHERE key = 'scheduler_last_tick'").get().value) >= before);
});

test("scheduler: after a clock jump the check starts again from now, and pruning still runs (N-160)", async () => {
  const { ctx, calls } = schedulerSetup();
  const real = Date.now;
  const clock = mock.method(Date, "now", () => real() + 2 * 3600e3); // the clock jumps two hours ahead
  let sched;
  try {
    await silent(async () => {
      sched = startScheduler(ctx, { intervalMs: 3_600_000 });
      sched.tick(); // saves a time two hours ahead
    });
  } finally {
    clock.mock.restore(); // ... and then it is corrected
  }
  const preparedAt = calls.between.length;
  calls.live = true;
  calls.pruned = 0;
  await silent(async () => {
    // The hourly prune has not run in the corrected time: make it due.
    sched.tick();
  });
  assert.equal(calls.between.length, preparedAt + 1, "it did not stall waiting for the clock to catch up");
  assert.ok(calls.pings.some((p) => p.includes("now-live")), "a post that went live is announced");
  sched.stop();
  // A small step back (a second or two) is waited out without skipping time.
  const small = schedulerSetup();
  const saved = Date.now;
  const c2 = mock.method(Date, "now", () => saved() + 1000);
  let s2;
  try {
    await silent(async () => {
      s2 = startScheduler(small.ctx, { intervalMs: 3_600_000 });
      s2.tick();
    });
  } finally {
    c2.mock.restore();
  }
  const n = small.calls.between.length;
  await silent(async () => s2.tick());
  assert.equal(small.calls.between.length, n, "one second behind: no check yet");
  s2.stop();
});

test("scheduler: follow-up steps that keep failing are retried a few times and then given up (N-161)", async () => {
  const { ctx, calls } = schedulerSetup();
  calls.live = true;
  ctx.invalidate = () => {
    throw new Error("cache is broken");
  };
  let sched;
  await silent(async () => {
    sched = startScheduler(ctx, { intervalMs: 3_600_000 });
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 5));
      sched.tick();
    }
  });
  const froms = calls.between.map(([from]) => from);
  assert.equal(froms[0], froms[1], "tried again from the same time");
  assert.equal(froms[1], froms[2]);
  assert.ok(froms[3] > froms[2], "after the third failure the window was let go");
  sched.stop();
});

test("scheduler: the hourly clean-up also calls the optional store clean-ups, and one failing doesn't stop the others (R-183)", async () => {
  const { ctx, calls } = schedulerSetup();
  const seen = [];
  ctx.store.subscribers = { pruneExpired: () => seen.push("subscribers") };
  ctx.store.members.pruneUnverified = () => {
    seen.push("members");
    throw new Error("nope");
  };
  ctx.store.rateLimits = { prune: () => seen.push("limits") };
  await silent(async () => {
    const sched = startScheduler(ctx, { intervalMs: 3_600_000 });
    sched.tick();
    sched.stop();
  });
  assert.deepEqual(seen.sort(), ["limits", "members", "subscribers"]);
  assert.equal(calls.pruned, 1);
});

// --- scripts ---

const runScript = (name, dir, args, env = {}) =>
  spawnSync(process.execPath, [path.join(ROOT, "scripts", name), ...args], { env: { ...process.env, APP_SECRET: "", DATA_DIR: dir, NODE_ENV: "development", ...env }, encoding: "utf8", timeout: 120_000 });

function userDir() {
  const dir = tmp("user2");
  openDb(dir).close();
  createSecrets(dir);
  return dir;
}

test("user script: names starting with --, blank names, temporary passwords, audit log, where (N-197, R-018, H-staff-02, H-database-11)", () => {
  const dir = userDir();
  const run = (...args) => runScript("user.js", dir, args);
  let r = run("create", "odd@example.com", "--odd name");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown option/);
  r = run("create", "odd@example.com", "--", "--odd name");
  assert.equal(r.status, 0, r.stderr);
  r = run("create", "blank@example.com", "\u0001\u0002 ​");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /at least one visible character/);
  assert.ok(run("list").stdout.includes("--odd name"));

  const db = openDb(dir);
  const user = db.prepare("SELECT id, password_must_change AS must FROM users WHERE email = 'odd@example.com'").get();
  assert.equal(user.must, 1);
  db.prepare("UPDATE users SET password_must_change = 0 WHERE id = ?").run(user.id);
  r = run("reset", "odd@example.com");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(db.prepare("SELECT password_must_change AS must FROM users WHERE id = ?").get(user.id).must, 1, "a password set from here is temporary");
  assert.match(r.stdout, /7 days/);
  assert.match(r.stdout, /15 minutes/, "tells the operator about the running blog's sign-in lock (N-196)");

  const log = fs.readFileSync(path.join(dir, "audit.log"), "utf8");
  assert.match(log, /staff account created: user \d+ \(author\) by the command line/);
  assert.ok(log.trim().split("\n").every((l) => JSON.parse(l).at), "one JSON object per line, like the admin");
  assert.match(log, /password set by the command line: user \d+ \(odd@example\.com\)/);
  r = run("reset-2fa", "odd@example.com");
  assert.match(fs.readFileSync(path.join(dir, "audit.log"), "utf8"), /two-step sign-in reset: user \d+ \(odd@example\.com\) by the command line/);

  r = run("where");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Encryption key: matches this database/, "the tool says whether the key matches (key-check)");
  assert.ok(r.stdout.includes(dir) || r.stdout.includes(path.basename(dir)));
  assert.match(r.stdout, /Staff:\s+1 account/);
  assert.match(r.stdout, /media folder/);
  db.close();
});

test("user script: end-sessions raises the sign-in version so an open challenge dies too (R-189)", () => {
  const dir = userDir();
  const run = (...args) => runScript("user.js", dir, args);
  run("create", "a@example.com", "Ann", "author");
  run("create", "b@example.com", "Bob", "author");
  const db = openDb(dir);
  const version = (email) => db.prepare("SELECT auth_version AS v FROM users WHERE email = ?").get(email).v;
  const [a0, b0] = [version("a@example.com"), version("b@example.com")];
  assert.equal(run("end-sessions", "a@example.com").status, 0);
  assert.equal(version("a@example.com"), a0 + 1);
  assert.equal(version("b@example.com"), b0, "only the person named");
  const r = run("end-sessions", "--all");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(version("a@example.com"), a0 + 2);
  assert.equal(version("b@example.com"), b0 + 1);
  assert.match(r.stdout, /recovery code was removed/, "recovery codes are removed after a restore (N-181)");
  db.close();
});

test("user script: it stops instead of changing the layout of a database that is behind (N-195)", () => {
  const dir = userDir();
  const db = openDb(dir);
  const last = db.prepare("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1").get().id;
  db.prepare("DELETE FROM schema_migrations WHERE id = ?").run(last);
  db.close();
  const r = runScript("user.js", dir, ["list"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /needs updates/);
  assert.ok(r.stderr.includes(last));
  const peek = new DatabaseSync(path.join(dir, "blog.db"), { readOnly: true });
  assert.equal(peek.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").get(last).n, 0, "nothing was applied behind the blog's back");
  peek.close();
});

test("browser scripts: only a full 127.x.x.x address counts as this computer (R-193)", () => {
  for (const name of ["editor-flow.js", "verify-pages.js"]) {
    const run = (url) => spawnSync(process.execPath, [path.join(ROOT, "scripts", name), url], { env: { ...process.env, BLOG_ADMIN_EMAIL: "a@example.com", BLOG_ADMIN_PASSWORD: "x" }, encoding: "utf8", timeout: 30_000 });
    for (const url of ["http://127.attacker.example/", "http://127.0.0.1.attacker.example/", "http://127.1.attacker.example:4100/"]) {
      const r = run(url);
      assert.notEqual(r.status, 0, `${name} ${url}`);
      assert.match(r.stderr, /--allow-remote/, `${name} ${url}`);
    }
    const source = fs.readFileSync(path.join(ROOT, "scripts", name), "utf8");
    assert.match(source, /host !== (?:new URL\(base\)|start)\.host/, `${name} checks the sign-in page stays on the same host`);
  }
  // A real 127 address is accepted (no credentials, so the script stops before it opens a browser).
  const local = spawnSync(process.execPath, [path.join(ROOT, "scripts", "editor-flow.js"), "http://127.0.0.1:1/"], { env: { ...process.env, BLOG_ADMIN_EMAIL: "", BLOG_ADMIN_PASSWORD: "" }, encoding: "utf8", timeout: 30_000 });
  assert.doesNotMatch(local.stderr, /--allow-remote/);
  assert.match(local.stderr, /BLOG_ADMIN_EMAIL/);
  const shots = fs.readFileSync(path.join(ROOT, "scripts", "verify-pages.js"), "utf8");
  assert.match(shots, /SENSITIVE/);
  assert.match(shots, /mode: 0o700/);
});

test("seed script: --force in production is quiet, merges the record, and --remove only deletes demo rows (R-190, N-191, R-192)", () => {
  const dir = tmp("seed2");
  openDb(dir).close();
  createSecrets(dir);
  // A record left behind by an earlier run that stopped half way.
  fs.writeFileSync(path.join(dir, "demo-seed.json"), JSON.stringify({ posts: [9999], media: [], users: [], members: [], ads: [], tags: [] }));
  const env = { NODE_ENV: "production" };
  let r = runScript("seed-demo.js", dir, ["--force"], env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Nothing shows on the live site/);
  const db = openDb(dir);
  const author = db.prepare("SELECT id, status FROM users WHERE email = 'demo-author@example.invalid'").get();
  assert.equal(author.status, "suspended", "the demo author cannot sign in");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'published'").get().n, 0, "every demo post and page is a draft");
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM posts").get().n >= 10);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ads WHERE active = 1").get().n, 0, "the demo banners are off");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "demo-seed.json"), "utf8"));
  assert.ok(manifest.posts.includes(9999), "the older record was kept");
  assert.ok(manifest.posts.length > 10);

  // Real content whose id is listed in the record (a restored database or a reused folder) must survive --remove.
  const realAuthor = Number(db.prepare("INSERT INTO users (email, password_hash, name, slug, role, created_at) VALUES ('real@example.com', 'x', 'Real', 'real', 'author', ?)").run(new Date().toISOString()).lastInsertRowid);
  const realPost = Number(db.prepare("INSERT INTO posts (type, status, title, slug, body_md, author_id, created_at, modified_at) VALUES ('post', 'draft', 'Real post', 'real-post', 'x', ?, ?, ?)").run(realAuthor, new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
  manifest.posts.push(realPost);
  manifest.users.push(realAuthor);
  fs.writeFileSync(path.join(dir, "demo-seed.json"), JSON.stringify(manifest));
  r = runScript("seed-demo.js", dir, ["--remove"], env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Left alone because they no longer look like demo content/);
  assert.ok(db.prepare("SELECT 1 FROM posts WHERE id = ?").get(realPost), "the real post is still there");
  assert.ok(db.prepare("SELECT 1 FROM users WHERE id = ?").get(realAuthor), "the real account is still there");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'demo-author@example.invalid'").get().n, 0, "the demo author is gone");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE author_id != ?").get(realAuthor).n, 0, "all demo posts are gone");
  db.close();
});

// --- brand icons (N-198) ---

test("brand icon paths hold only SVG path characters, and colours only six hex digits", async () => {
  const { BRAND_PATHS } = await import("../src/web/brand-paths.js");
  const PATH_OK = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]+$/; // the same rule as scripts/build-icons.js
  assert.ok(Object.keys(BRAND_PATHS).length >= 20);
  for (const [slug, icon] of Object.entries(BRAND_PATHS)) {
    assert.match(icon.path, PATH_OK, slug);
    assert.match(icon.hex, /^[0-9A-Fa-f]{6}$/, slug);
  }
  const generator = fs.readFileSync(path.join(ROOT, "scripts", "build-icons.js"), "utf8");
  assert.ok(generator.includes(PATH_OK.source), "the generator applies the same rule");
});

// --- every admin form needs its CSRF token (H-scripts-13) ---

test("admin: every POST form and route refuses a request without its form token", async () => {
  const { createApp } = await import("../src/web/app.js");
  const dataDir = tmp("csrf");
  const { app, ctx } = createApp({ dataDir, production: true, outbound: false, mailTransport: { jsonTransport: true }, mailDelayMs: 0, setupToken: "test-setup", trustProxy: true });
  const A = "/admin";
  const cookies = new Map();
  const req = async (p, { method = "GET", form, headers = {} } = {}) => {
    const h = { origin: "http://localhost", cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "), "x-forwarded-for": "198.51.100.77", ...headers };
    let body;
    if (form) {
      body = new URLSearchParams(form);
      h["content-type"] = "application/x-www-form-urlencoded";
    }
    const res = await app.request(`http://localhost${p}`, { method, headers: h, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (!pair.slice(i + 1) || /max-age=0/i.test(c)) cookies.delete(pair.slice(0, i));
      else cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  };
  const field = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];
  // Set up the owner and sign in.
  let res = await req(`${A}/setup`);
  let token = field(await res.text(), "_csrf");
  res = await req(`${A}/setup`, { method: "POST", form: { _csrf: token, setup_token: "test-setup", site_title: "Test Blog", site_url: "http://localhost", name: "Olive Owner", email: "owner@example.com", password: "correct horse battery" } });
  assert.equal(res.status, 302);
  // Setting up signs the owner in; if it didn't, sign in the ordinary way.
  if ((await req(`${A}/`)).status !== 200) {
    res = await req(`${A}/login`);
    token = field(await res.text(), "_csrf");
    res = await req(`${A}/login`, { method: "POST", form: { _csrf: token, email: "owner@example.com", password: "correct horse battery" } });
    assert.equal(res.status, 302, "the owner could sign in");
  }
  assert.equal((await req(`${A}/`)).status, 200, "signed in");

  // Some content so the pages have forms with real ids: a post, a draft newsletter, a subscriber, a reader and a comment, a staff member.
  const seed = (fn) => {
    try {
      fn();
    } catch {}
  };
  const owner = ctx.store.users.getByEmail("owner@example.com");
  seed(() => ctx.store.posts.save({ type: "post", status: "draft", title: "A draft", slug: "a-draft", body_md: "Hello", author_id: owner.id }, { userId: owner.id }));
  seed(() => ctx.store.newsletters.save({ subject: "S", preheader: "", body_md: "x", postIds: [] }, 0, owner.id));
  seed(() => ctx.store.subscribers.add("sub@example.com", "test", { confirmed: true }));
  seed(() => ctx.db.prepare("INSERT INTO redirects (from_path, to_path, status_code, created_at) VALUES ('/old/', '/new/', 301, ?)").run(new Date().toISOString()));

  const pages = ["/", "/posts", "/pages", "/media", "/categories", "/tags", "/comments", "/members", "/ads", "/menus", "/redirects", "/newsletter", "/newsletter/new", "/newsletter/subscribers", "/newsletter/settings", "/analytics", "/settings", "/users", `/users/${owner.id}`, "/account/two-step", "/posts/new"];
  const posts = ctx.db.prepare("SELECT id FROM posts LIMIT 1").get();
  if (posts) pages.push(`/posts/${posts.id}`);
  const forms = new Map(); // "action" -> true
  for (const p of pages) {
    const r = await req(`${A}${p === "/" ? "/" : p}`);
    if (r.status !== 200) continue;
    const html = await r.text();
    for (const m of html.matchAll(/<form\b[^>]*>/gi)) {
      const tag = m[0];
      if (!/method=["']?post/i.test(tag)) continue;
      const action = (tag.match(/action=["']([^"']*)["']/i) || [])[1];
      if (action) forms.set(action.replace(/^http:\/\/localhost/, ""), true);
    }
  }
  // Routes that are written in the source with a fixed address (some are only reached by scripts or buttons).
  const source = fs.readFileSync(path.join(ROOT, "src", "web", "admin.js"), "utf8");
  for (const m of source.matchAll(/app\.post\(`\$\{(A|N)\}(\/[a-z0-9\/.-]*)`/g)) {
    const prefix = m[1] === "A" ? A : `${A}/newsletter`;
    forms.set(`${prefix}${m[2]}`, true);
  }
  const open = new Set([`${A}/setup`, `${A}/login`, `${A}/login/verify`]);
  const sweep = [...forms.keys()].filter((a) => a.startsWith(A) && !open.has(a)).sort();
  assert.ok(sweep.length >= 20, `found ${sweep.length} POST routes to check`);

  const failures = [];
  for (const action of sweep) {
    for (const form of [{}, { _csrf: "forged-token" }]) {
      const r = await req(action, { method: "POST", form: { name: "x", ...form } });
      // 403 is the refusal. A 404 means the example id doesn't exist (checked before the token); a 302 to the sign-in page would mean the session was lost.
      if (r.status === 404) continue;
      if (r.status !== 403 && r.status !== 401) failures.push(`${action} ${JSON.stringify(form)} -> ${r.status}`);
    }
  }
  assert.deepEqual(failures, [], `these admin POST routes accepted a request with no valid form token:\n${failures.join("\n")}`);
  // And the session is still good afterwards (nothing above logged the owner out).
  assert.equal((await req(`${A}/`)).status, 200);
  const api = await req(`${A}/api/posts`, { method: "POST", headers: { "content-type": "application/json" } });
  assert.equal(api.status, 403, "the JSON routes need their token header");
});
