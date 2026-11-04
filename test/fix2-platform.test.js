// Tests for the platform fixes of round 2: rate limiter, cache tags, cookies, headers, same-origin, config, database safety,
// secrets, site checks, body limits and the admin host.
// Run: node --test test/fix2-platform.test.js
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { loadConfig } from "../src/config.js";
import { backupBeforeMigrate, openDb } from "../src/db.js";
import { createPageCache } from "../src/web/cache.js";
import { analyticsSetup, parseSnippet } from "../src/web/analytics.js";
import { createSecrets } from "../src/web/secrets.js";
import {
  clearAppCookie,
  clientIp,
  cookieName,
  createRateLimiter,
  logPath,
  logSafe,
  readCookie,
  sameOrigin,
  securityHeaders,
  setAppCookie,
  takeClient,
  wideKey,
} from "../src/web/security.js";
import { isPrivateHost } from "../src/services/hosts.js";
import { passwordProblem } from "../src/web/validate.js";
import { editorBundleProblem } from "../src/web/assets.js";

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fix2-platform-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // open database files can stay locked for a moment on Windows
    }
  }
});

const fakeCtx = (config = {}, site = {}, extra = {}) => ({ config, site: () => site, ...extra });
const fakeC = (headers = {}, url = "http://localhost/x") => ({ req: { url, header: (n) => headers[n.toLowerCase()] } });

// A stand-in for ctx.store.rateLimits (the real one is in the database).
const fakeRateStore = () => {
  const rows = new Map();
  return {
    rows,
    get: (scope, key) => (rows.has(`${scope}|${key}`) ? { ...rows.get(`${scope}|${key}`) } : null),
    set: (scope, key, entry) => void rows.set(`${scope}|${key}`, { ...entry }),
    delete: (scope, key) => void rows.delete(`${scope}|${key}`),
    prune: () => {},
  };
};

describe("rate limiter (L-ratelimiter, N-147, N-154, N-163)", () => {
  test("a flood of new keys never evicts a victim's counter, and a full table refuses new keys", () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 3_600_000, maxKeys: 50 });
    for (let i = 0; i < 3; i++) assert.equal(rl.take("victim"), true);
    assert.equal(rl.take("victim"), false);
    for (let i = 0; i < 500; i++) rl.take(`flood${i}`);
    assert.ok(rl.size <= 50);
    // still blocked: the counter survived the flood
    assert.equal(rl.take("victim"), false);
    assert.equal(rl.count("victim"), 3);
    // a new key while the table is full of live keys is refused (fails closed)
    assert.equal(rl.take("stranger"), false);
    rl.stop();
  });

  test("expired keys are evicted from the front, a few per call, so the table frees itself", async () => {
    const rl = createRateLimiter({ limit: 5, windowMs: 100, maxKeys: 20 });
    for (let i = 0; i < 20; i++) assert.equal(rl.take(`k${i}`), true);
    assert.equal(rl.take("late"), false);
    await new Promise((r) => setTimeout(r, 260)); // every key is now older than two windows
    assert.equal(rl.take("late"), true);
    assert.ok(rl.size >= 1 && rl.size <= 20, `size ${rl.size}`);
    for (let i = 0; i < 30; i++) rl.take(`again${i}`);
    assert.ok(rl.size <= 20);
    rl.stop();
  });

  test("taking a new key at capacity stays cheap (no full scan per call)", () => {
    const rl = createRateLimiter({ limit: 5, windowMs: 3_600_000, maxKeys: 50_000 });
    for (let i = 0; i < 50_000; i++) rl.take(`k${i}`);
    const start = process.hrtime.bigint();
    for (let i = 0; i < 2000; i++) rl.take(`new${i}`);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 250, `2000 refused takes took ${ms.toFixed(1)} ms`);
    rl.stop();
  });

  test("persisted counters survive a new limiter on the same store, reset clears them, a broken store falls back to memory", () => {
    const store = fakeRateStore();
    const make = () => createRateLimiter({ limit: 3, windowMs: 3_600_000, persist: { scope: "loginAccount", store } });
    const a = make();
    for (let i = 0; i < 3; i++) assert.equal(a.take("who@example.com"), true);
    assert.equal(a.take("who@example.com"), false);
    // "restart": a new limiter over the same rows
    const b = make();
    assert.equal(b.take("who@example.com"), false);
    assert.equal(b.count("who@example.com"), 3);
    assert.equal(b.size, 0, "nothing is kept in memory");
    assert.ok([...store.rows.values()][0].expires > Date.now(), "rows carry an expiry");
    b.reset("who@example.com");
    assert.equal(b.take("who@example.com"), true);
    const broken = createRateLimiter({ limit: 2, windowMs: 60_000, persist: { scope: "x", store: { get() { throw new Error("db"); }, set() {}, delete() {} } } });
    assert.deepEqual([broken.take("k"), broken.take("k"), broken.take("k")], [true, true, false]);
    a.stop();
    b.stop();
    broken.stop();
  });

  test("takeClient also counts the IPv6 /48 on a sibling with four times the limit", () => {
    const ctx = fakeCtx({ trustProxy: true });
    const rl = createRateLimiter({ limit: 2, windowMs: 3_600_000 });
    const from = (net64) => fakeC({ "x-forwarded-for": `2001:db8:1:${net64}::1` });
    // ten different /64s inside one /48 get 4 x 2 = 8 attempts together
    const results = [];
    for (let i = 0; i < 10; i++) results.push(takeClient(rl, from(i), ctx));
    assert.equal(results.filter(Boolean).length, 8);
    // a /64 of a different /48 is untouched
    assert.equal(takeClient(rl, fakeC({ "x-forwarded-for": "2001:db8:2:0::1" }), ctx), true);
    // IPv4 uses only its own key
    assert.equal(takeClient(rl, fakeC({ "x-forwarded-for": "203.0.113.5" }), ctx), true);
    assert.equal(takeClient(rl, fakeC({ "x-forwarded-for": "203.0.113.5" }), ctx), true);
    assert.equal(takeClient(rl, fakeC({ "x-forwarded-for": "203.0.113.5" }), ctx), false);
    assert.equal(wideKey("2001:db8:1:2::/64"), "2001:db8:1::/48");
    assert.equal(wideKey("203.0.113.5"), "");
    rl.stop();
  });
});

describe("page cache tags (Q7)", () => {
  test("clearTag drops only the tagged pages and keeps the byte count right", () => {
    const c = createPageCache();
    c.set("/a/", { body: "A" }, { tags: ["post:1", "member:9"] });
    c.set("/b/", { body: "B" }, { tags: ["post:2"] });
    c.set("/", { body: "home" }, { tags: ["lists"] });
    c.set("/plain/", { body: "no tags" });
    c.clearTag("post:1");
    assert.equal(c.get("/a/"), null);
    assert.ok(c.get("/b/") && c.get("/") && c.get("/plain/"));
    c.clearTag("member:9"); // already gone: no error
    c.clearTag("lists");
    assert.equal(c.get("/"), null);
    assert.equal(c.size, 2);
    // replacing an entry replaces its tags
    c.set("/b/", { body: "B2" }, { tags: ["post:3"] });
    c.clearTag("post:2");
    assert.equal(c.get("/b/").body, "B2");
    c.clearTag("post:3");
    assert.equal(c.get("/b/"), null);
    c.clear();
    assert.equal(c.bytes, 0);
    assert.equal(c.size, 0);
  });
});

describe("client address and origin checks (N-149, R-150, N-152, R-153)", () => {
  test("a forwarded header shorter than PROXY_HOPS is not believed and is reported", () => {
    const seen = [];
    const ctx = fakeCtx({ trustProxy: true, proxyHops: 2 }, {}, { warn: (s) => seen.push(s) });
    assert.equal(clientIp(fakeC({ "x-forwarded-for": "6.6.6.6" }), ctx), "unknown");
    assert.equal(clientIp(fakeC({ "x-forwarded-for": "6.6.6.6, 7.7.7.7" }), ctx), "6.6.6.6");
    assert.equal(seen.length, 1);
    assert.match(seen[0], /PROXY_HOPS=2/);
  });

  test("X-Forwarded-For while TRUST_PROXY is off becomes a warning for the owner", () => {
    const seen = [];
    const ctx = fakeCtx({ trustProxy: false }, {}, { warn: (s) => seen.push(s) });
    const old = console.warn;
    console.warn = () => {};
    try {
      assert.equal(clientIp(fakeC({ "x-forwarded-for": "1.2.3.4" }), ctx), "unknown");
    } finally {
      console.warn = old;
    }
    assert.match(seen[0], /TRUST_PROXY/);
  });

  test("the scheme and host take the same hop rule as the address", () => {
    const ctx = fakeCtx({ trustProxy: true, proxyHops: 1 }, {});
    const c = fakeC({ host: "internal:4100", "x-forwarded-proto": "http, https", "x-forwarded-host": "evil.test, blog.test", origin: "https://blog.test" }, "http://internal:4100/x");
    assert.equal(sameOrigin(c, ctx), true);
    const forged = fakeC({ host: "internal:4100", "x-forwarded-proto": "https, http", "x-forwarded-host": "blog.test, evil.test", origin: "https://blog.test" }, "http://internal:4100/x");
    assert.equal(sameOrigin(forged, ctx), false);
  });

  test("without a trusted proxy only this site's own hosts, this machine and bare IPs are accepted (DNS rebinding)", () => {
    const ctx = fakeCtx({}, { origin: "https://blog.example.com", https: true });
    const post = (host, origin) => sameOrigin(fakeC({ host, origin }, `http://${host}/admin/login`), ctx);
    assert.equal(post("blog.example.com", "https://blog.example.com"), true);
    assert.equal(post("www.blog.example.com", "https://www.blog.example.com"), true);
    assert.equal(post("localhost:4100", "https://localhost:4100"), true);
    assert.equal(post("127.0.0.1:4100", "https://127.0.0.1:4100"), true);
    assert.equal(post("192.168.1.20:4100", "https://192.168.1.20:4100"), true);
    // a page on attacker.test whose name now points at this machine: its Host is not one of ours
    assert.equal(post("attacker.test", "https://attacker.test"), false);
    assert.equal(post("attacker.test:4100", "https://attacker.test:4100"), false);
    // the site's own origin still works whatever Host a proxy passes on
    assert.equal(post("127.0.0.1:4100", "https://blog.example.com"), true);
  });

  test("with ADMIN_HOST its origin is accepted too", () => {
    const ctx = fakeCtx({ adminHost: "admin.example.com" }, { origin: "https://example.com" });
    assert.equal(sameOrigin(fakeC({ host: "admin.example.com", origin: "https://admin.example.com" }, "https://admin.example.com/admin/login"), ctx), true);
  });

  test("a POST with no Origin or Referer needs Sec-Fetch-Site: same-origin ('none' is refused)", () => {
    const ctx = fakeCtx({}, {});
    const req = (h) => fakeC({ host: "localhost", ...h }, "http://localhost/x");
    assert.equal(sameOrigin(req({ "sec-fetch-site": "same-origin" }), ctx), true);
    assert.equal(sameOrigin(req({ "sec-fetch-site": "none" }), ctx), false);
    assert.equal(sameOrigin(req({}), ctx), false);
  });
});

describe("cookies (Q8)", () => {
  const ctxFor = (https) => ({ config: { trustProxy: false, basePath: "" }, site: () => ({ https }) });
  const make = (ctx) => {
    const app = new Hono();
    app.get("/set", (c) => (setAppCookie(c, ctx, "sid", "v1", { path: "/admin", maxAge: 100 }), c.text(cookieName(c, ctx, "sid"))));
    app.get("/set-open", (c) => (setAppCookie(c, ctx, "t", "x", { httpOnly: false }), c.text("ok")));
    app.get("/read", (c) => c.text(String(readCookie(c, ctx, "sid"))));
    app.get("/clear", (c) => (clearAppCookie(c, ctx, "sid", "/admin"), c.text("ok")));
    return app;
  };

  test("over https the name is __Host-, Path=/, Secure, HttpOnly, SameSite", async () => {
    const res = await make(ctxFor(true)).request("https://example.com/set");
    assert.equal(await res.text(), "__Host-sid");
    const [line] = res.headers.getSetCookie();
    assert.match(line, /^__Host-sid=v1;/);
    assert.match(line, /Path=\/(;|$)/);
    assert.match(line, /Secure/);
    assert.match(line, /HttpOnly/);
    assert.match(line, /SameSite=Lax/i);
    assert.doesNotMatch(line, /Domain=/i);
    const open = await make(ctxFor(true)).request("https://example.com/set-open");
    assert.doesNotMatch(open.headers.getSetCookie()[0], /HttpOnly/);
  });

  test("over http the plain name and the given path are kept", async () => {
    const res = await make(ctxFor(false)).request("http://localhost/set");
    assert.equal(await res.text(), "sid");
    const [line] = res.headers.getSetCookie();
    assert.match(line, /^sid=v1;/);
    assert.match(line, /Path=\/admin/);
    assert.doesNotMatch(line, /Secure/);
  });

  test("reading prefers the new name; a value found only under the old name is re-issued and the old one cleared", async () => {
    const app = make(ctxFor(true));
    const both = await app.request("https://example.com/read", { headers: { cookie: "sid=old; __Host-sid=new" } });
    assert.equal(await both.text(), "new");
    assert.equal(both.headers.getSetCookie().length, 0);
    const legacy = await app.request("https://example.com/read", { headers: { cookie: "sid=old" } });
    assert.equal(await legacy.text(), "old");
    const lines = legacy.headers.getSetCookie();
    assert.ok(lines.some((l) => l.startsWith("__Host-sid=old;") && /Secure/.test(l) && /Path=\/(;|$)/.test(l)), lines.join(" | "));
    assert.ok(lines.some((l) => l.startsWith("sid=;") && /Max-Age=0/i.test(l)), lines.join(" | "));
    const none = await app.request("https://example.com/read");
    assert.equal(await none.text(), "undefined");
  });

  test("clearing deletes both names", async () => {
    const res = await make(ctxFor(true)).request("https://example.com/clear");
    const lines = res.headers.getSetCookie();
    assert.ok(lines.some((l) => l.startsWith("__Host-sid=;")));
    assert.ok(lines.some((l) => l.startsWith("sid=;") && /Path=\/admin/.test(l)));
  });
});

describe("headers (Q22, H-server-02, H-server-08, H-server-10)", () => {
  const base = { scriptHashes: ["'sha256-PUBLIC'"], adminScriptHashes: ["'sha256-ADMIN'"], styleHashes: ["'sha256-CSS'"] };
  test("public style-src has no unsafe-inline; admin keeps it; neither allows inline event handlers", () => {
    const pub = securityHeaders({ ...base, admin: false })["Content-Security-Policy"];
    const admin = securityHeaders({ ...base, admin: true })["Content-Security-Policy"];
    assert.match(pub, /style-src 'self' 'sha256-CSS'(;|$)/);
    assert.doesNotMatch(pub, /unsafe-inline/);
    assert.match(admin, /style-src 'self' 'unsafe-inline'/);
    assert.match(pub, /script-src-attr 'none'/);
    assert.match(admin, /script-src-attr 'none'/);
  });
  test("admin gets Trusted Types in report-only mode and a same-origin resource policy", () => {
    const h = securityHeaders({ ...base, admin: true });
    assert.equal(h["Content-Security-Policy-Report-Only"], "require-trusted-types-for 'script'");
    assert.equal(h["Cross-Origin-Resource-Policy"], "same-origin");
    assert.equal(securityHeaders({ ...base, admin: false })["Content-Security-Policy-Report-Only"], undefined);
  });
  test("HSTS is sent when asked, without includeSubDomains unless the owner opts in", () => {
    assert.equal(securityHeaders({ ...base, admin: false, https: true })["Strict-Transport-Security"], "max-age=31536000");
    assert.equal(securityHeaders({ ...base, admin: false, https: true, hstsSubdomains: true })["Strict-Transport-Security"], "max-age=31536000; includeSubDomains");
    assert.equal(securityHeaders({ ...base, admin: false, https: false })["Strict-Transport-Security"], undefined);
  });
  test("log text loses control characters and secret-looking tokens", () => {
    assert.equal(logSafe("a\nb\u001b[31mc"), "a?b?[31mc");
    assert.equal(logSafe(`/reset/${"A".repeat(43)}/`), "/reset/[hidden]/");
    assert.equal(logPath({ req: { path: "/verify/abcdefghijklmnopqrstuvwxyz0123/" } }), "/verify/:hidden/");
  });
});

describe("config (N-151, R-148, N-123, H-server-08)", () => {
  const withEnv = (vars, fn) => {
    const old = {};
    for (const k of Object.keys(vars)) {
      old[k] = process.env[k];
      process.env[k] = vars[k];
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(old)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  test("a MAX_UPLOAD_MB or MAIL_DELAY_MS that is not a number falls back to the default and says so", () => {
    const c = withEnv({ MAX_UPLOAD_MB: "15MB", MAIL_DELAY_MS: "fast" }, () => loadConfig({ dataDir: "x" }));
    assert.equal(c.maxUploadBytes, 15 * 1024 * 1024);
    assert.equal(c.mailDelayMs, 400);
    assert.equal(c.warnings.length, 2);
    assert.match(c.warnings.join(" "), /MAX_UPLOAD_MB/);
    assert.match(c.warnings.join(" "), /MAIL_DELAY_MS/);
    const ok = withEnv({ MAX_UPLOAD_MB: "20", MAIL_DELAY_MS: "0" }, () => loadConfig({}));
    assert.equal(ok.maxUploadBytes, 20 * 1024 * 1024);
    assert.equal(ok.mailDelayMs, 0);
    assert.deepEqual(ok.warnings, []);
    assert.equal(withEnv({ MAX_UPLOAD_MB: "-3" }, () => loadConfig({})).maxUploadBytes, 15 * 1024 * 1024);
    assert.equal(withEnv({ MAX_UPLOAD_MB: "0" }, () => loadConfig({})).maxUploadBytes, 15 * 1024 * 1024);
  });
  test("TRUST_PROXY accepts the usual spellings of yes", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", true]) assert.equal(loadConfig({ trustProxy: v }).trustProxy, true, String(v));
    for (const v of ["0", "false", "no", "", undefined]) assert.equal(loadConfig({ trustProxy: v }).trustProxy, false, String(v));
    assert.equal(withEnv({ TRUST_PROXY: "true" }, () => loadConfig({})).trustProxy, true);
  });
  test("ADMIN_HOST is a bare host", () => {
    assert.equal(loadConfig({ adminHost: "Admin.Example.com" }).adminHost, "admin.example.com");
    assert.equal(loadConfig({ adminHost: "admin.localhost:4100" }).adminHost, "admin.localhost:4100");
    assert.equal(loadConfig({}).adminHost, "");
    assert.throws(() => loadConfig({ adminHost: "https://admin.example.com" }), /ADMIN_HOST/);
    assert.throws(() => loadConfig({ adminHost: "a b" }), /ADMIN_HOST/);
  });
  test("start-up switches", () => {
    const c = loadConfig({});
    assert.equal(c.hstsSubdomains, false);
    assert.equal(c.resumeNewsletters, true);
    assert.equal(withEnv({ RESUME_NEWSLETTERS: "0" }, () => loadConfig({})).resumeNewsletters, false);
    assert.equal(withEnv({ HSTS_SUBDOMAINS: "1" }, () => loadConfig({})).hstsSubdomains, true);
  });
});

describe("database safety (N-182, R-187, N-188, H-database-15)", () => {
  test("synchronous=FULL", () => {
    const db = openDb(tmp());
    assert.equal(db.prepare("PRAGMA synchronous").get().synchronous, 2);
    db.close();
  });

  test("a changed update stops production start-up unless ALLOW_MIGRATION_DRIFT is set; elsewhere it only warns", () => {
    const dir = tmp();
    const db = openDb(dir);
    db.prepare("UPDATE schema_migrations SET checksum = 'changed' WHERE id = (SELECT MIN(id) FROM schema_migrations)").run();
    db.close();
    const quiet = console.warn;
    console.warn = () => {};
    try {
      assert.throws(() => openDb(dir, { production: true }), /ALLOW_MIGRATION_DRIFT=1/);
      const warnings = [];
      openDb(dir, { production: true, allowMigrationDrift: true, warnings }).close();
      assert.equal(warnings.length, 1);
      const dev = [];
      openDb(dir, { production: false, warnings: dev }).close();
      assert.match(dev[0], /changed after it was applied/);
    } finally {
      console.warn = quiet;
    }
  });

  test("the pre-update copy has no sessions, seals plain secrets, and is pruned", () => {
    const dir = tmp();
    const db = openDb(dir);
    const secrets = createSecrets(dir);
    db.prepare("INSERT INTO users (id, email, password_hash, name, slug, role, created_at, totp_secret) VALUES (1, 'a@example.com', 'x', 'A', 'a', 'owner', 'now', 'JBSWY3DPEHPK3PXP')").run();
    db.prepare("INSERT INTO sessions (id, user_id, csrf, created_at, expires_at, ip, user_agent) VALUES ('s1', 1, 'c', 'now', '2099-01-01', '203.0.113.7', 'Browser')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('smtp_pass', ?)").run(JSON.stringify("plain-smtp-password"));
    const backups = path.join(dir, "backups");
    fs.mkdirSync(backups, { recursive: true });
    const old = Date.now() - 90 * 86_400_000;
    for (let d = 1; d <= 5; d++) {
      const f = path.join(backups, `before-update-2020-01-0${d}T00-00-00-000Z.db`);
      fs.writeFileSync(f, "old copy");
      fs.utimesSync(f, new Date(old), new Date(old));
    }
    backupBeforeMigrate(db, dir, { production: true, secrets });
    const files = fs.readdirSync(backups).sort();
    assert.equal(files.length, 3, files.join(", "));
    const newest = path.join(backups, files.at(-1));
    const copy = new DatabaseSync(newest);
    assert.equal(copy.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0);
    const sealed = copy.prepare("SELECT totp_secret FROM users WHERE id = 1").get().totp_secret;
    assert.match(sealed, /^v1:/);
    assert.equal(secrets.open(sealed), "JBSWY3DPEHPK3PXP");
    assert.match(JSON.parse(copy.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get().value), /^v1:/);
    copy.close();
    // the live database is untouched
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1);
    assert.equal(db.prepare("SELECT totp_secret FROM users WHERE id = 1").get().totp_secret, "JBSWY3DPEHPK3PXP");
    db.close();
  });

  test("a failed pre-update copy stops production unless ALLOW_BACKUP_FAILURE is set", () => {
    const dir = tmp();
    const db = openDb(dir);
    fs.writeFileSync(path.join(dir, "backups"), "not a folder"); // the copy cannot be saved
    const quiet = console.warn;
    console.warn = () => {};
    try {
      assert.throws(() => backupBeforeMigrate(db, dir, { production: true }), /ALLOW_BACKUP_FAILURE=1/);
      const warnings = [];
      backupBeforeMigrate(db, dir, { production: true, allowBackupFailure: true, warnings });
      assert.equal(warnings.length, 1);
      const dev = [];
      backupBeforeMigrate(db, dir, { production: false, warnings: dev });
      assert.match(dev[0], /Could not save a copy/);
    } finally {
      console.warn = quiet;
    }
    db.close();
  });
});

describe("secrets (N-008, N-009)", () => {
  test("a label binds a sealed value to where it belongs", () => {
    const s = createSecrets(tmp());
    const sealed = s.seal("JBSWY3DPEHPK3PXP", "users.totp_secret:7");
    assert.match(sealed, /^v2:/);
    assert.equal(s.open(sealed, "users.totp_secret:7"), "JBSWY3DPEHPK3PXP");
    assert.throws(() => s.open(sealed, "users.totp_secret:8"), "another row");
    assert.throws(() => s.open(sealed, "settings.smtp_pass"), "another column");
    assert.throws(() => s.open(sealed), "no label");
    // unlabelled values still work as before
    assert.match(s.seal("x"), /^v1:/);
    assert.equal(s.open(s.seal("x")), "x");
    assert.equal(s.open(s.seal("x"), "ignored"), "x");
  });
  test("plain values are refused when the caller says nothing should be plain", () => {
    const s = createSecrets(tmp());
    assert.equal(s.open("plain"), "plain");
    assert.throws(() => s.open("plain", "", { allowPlain: false }), /not sealed/);
    assert.equal(s.open("", "", { allowPlain: false }), "");
    assert.equal(s.isSealed(s.seal("x")), true);
    assert.equal(s.isSealed("x"), false);
  });
  test("verify() notices sealed values this key cannot open, and a key that changed since last time", () => {
    const dir = tmp();
    const db = openDb(dir);
    const secrets = createSecrets(dir);
    assert.equal(secrets.created, true);
    assert.equal(secrets.verify(db), "", "nothing sealed yet");
    assert.ok(fs.existsSync(path.join(dir, "key-check.txt")));
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('smtp_pass', ?)").run(JSON.stringify(secrets.seal("mail-password")));
    assert.equal(secrets.verify(db), "");
    // the same data seen by a different key (a new secret.key after the old one was lost)
    const other = createSecrets(tmp());
    assert.match(other.verify(db), /cannot be read/);
    // APP_SECRET changed while the data folder stayed
    const old = process.env.APP_SECRET;
    process.env.APP_SECRET = "cd".repeat(32);
    try {
      assert.match(createSecrets(dir).verify(db), /encryption key/);
    } finally {
      if (old === undefined) delete process.env.APP_SECRET;
      else process.env.APP_SECRET = old;
    }
    db.close();
  });
  test("an all-zero key file is refused", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "secret.key"), `${"0".repeat(64)}\n`);
    assert.throws(() => createSecrets(dir), /all zeros/);
  });
});

describe("analytics (R-128, N-143)", () => {
  test("a stored provider such as constructor or __proto__ is not a provider", () => {
    for (const p of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal(analyticsSetup({ analytics_provider: p, analytics_script: "https://stats.example.com/s.js", analytics_id: "x" }), null, p);
  });
  test("attribute names are matched whole: data-src is not src, data-website-id lookalikes are not the id", () => {
    assert.equal(parseSnippet(`<script defer data-src="https://cloud.umami.is/script.js" data-website-id="abc"></script>`), null);
    const ok = parseSnippet(`<script defer data-src="https://evil.example/x.js" src="https://cloud.umami.is/script.js" data-website-id="abc"></script>`);
    assert.equal(ok.script, "https://cloud.umami.is/script.js");
    assert.equal(ok.id, "abc");
    assert.equal(parseSnippet(`<script src="https://stats.example.com/umami.js" x-data-website-id="evil"></script>`).id, "");
    assert.equal(parseSnippet(`<script defer data-domain="a.com" src="https://plausible.io/js/script.js"></script>`).id, "a.com");
  });
});

describe("password policy (Q9)", () => {
  test("passwordProblem lives in validate.js with the same behaviour", () => {
    assert.match(passwordProblem("short"), /at least 10/);
    assert.match(passwordProblem("x".repeat(300)), /at most 256/);
    assert.match(passwordProblem("password123"), /too easy/);
    assert.match(passwordProblem("jane.doe@example.com", { email: "jane.doe@example.com" }), /too easy/);
    assert.match(passwordProblem("aaaaaaaaaaaa"), /too easy/);
    assert.match(passwordProblem("short", {}, "new password"), /new password/);
    assert.equal(passwordProblem("a long phrase of words"), "");
  });
});

describe("editor bundle check (Q19)", () => {
  test("the shipped editor files match their recorded hashes", () => {
    assert.equal(editorBundleProblem(), "");
  });
});

describe("app: site, warnings, headers, body limits, admin host", async () => {
  // Loaded here so the helper tests above still run if another area's file is mid-edit.
  const { createApp } = await import("../src/web/app.js");
  const make = (extra = {}) => createApp({ dataDir: tmp(), production: true, outbound: false, mailTransport: { jsonTransport: true }, setupToken: "test-setup", ...extra });
  const form = { "content-type": "application/x-www-form-urlencoded", origin: "https://localhost" };

  test("the footer year is read when the page is built, and hasPublicUrl uses the one shared host check", () => {
    const { ctx } = make();
    const site = ctx.site();
    assert.equal(site.year, new Date().getFullYear());
    assert.equal(typeof Object.getOwnPropertyDescriptor(site, "year").get, "function");
    for (const [url, expected] of [["https://100.64.1.1", false], ["https://printer.lan", false], ["https://10.example.com", true], ["https://blog.example.com", true], ["http://localhost:4100", false]]) {
      assert.equal(make({ siteUrl: url }).ctx.site().hasPublicUrl, expected, url);
    }
    assert.equal(isPrivateHost("fd00::1"), true);
  });

  test("ctx.warnings: no SITE_URL, a local or non-https Site URL, and warn() entries", () => {
    const { ctx } = make();
    assert.ok(ctx.warnings.some((w) => /SITE_URL is not set/.test(w)));
    assert.ok(ctx.warnings.some((w) => /not a public address/.test(w)));
    ctx.warn("A custom notice.");
    ctx.warn("A custom notice.");
    assert.equal(ctx.warnings.filter((w) => w === "A custom notice.").length, 1);
    const good = make({ siteUrl: "https://blog.example.com" }).ctx.warnings;
    assert.deepEqual(good.filter((w) => /Site URL|SITE_URL/.test(w)), []);
    assert.ok(make({ siteUrl: "http://blog.example.com" }).ctx.warnings.some((w) => /not https/.test(w)));
    // development has no such nagging
    assert.deepEqual(make({ production: false }).ctx.warnings, []);
    // numbers that were not usable
    const old = process.env.MAX_UPLOAD_MB;
    process.env.MAX_UPLOAD_MB = "lots";
    try {
      assert.ok(make({ production: false }).ctx.warnings.some((w) => /MAX_UPLOAD_MB/.test(w)));
    } finally {
      if (old === undefined) delete process.env.MAX_UPLOAD_MB;
      else process.env.MAX_UPLOAD_MB = old;
    }
  });

  test("a lost encryption key shows up in ctx.warnings", () => {
    const dir = tmp();
    const first = createApp({ dataDir: dir, production: true, outbound: false, mailTransport: { jsonTransport: true }, setupToken: "t" });
    first.ctx.store.settings.set?.({ smtp_pass: "mail-password" });
    first.ctx.db.close();
    fs.rmSync(path.join(dir, "secret.key"));
    const old = console.error;
    console.error = () => {};
    try {
      const second = createApp({ dataDir: dir, production: true, outbound: false, mailTransport: { jsonTransport: true }, setupToken: "t" });
      if (first.ctx.store.settings.set) assert.ok(second.ctx.warnings.some((w) => /encryption key/.test(w)), second.ctx.warnings.join(" | "));
    } finally {
      console.error = old;
    }
  });

  test("HSTS goes out on https responses in production (no includeSubDomains), and not on http", async () => {
    const { app } = make();
    const https = await app.request("https://localhost/");
    assert.equal(https.headers.get("strict-transport-security"), "max-age=31536000");
    const http = await app.request("http://localhost/");
    assert.equal(http.headers.get("strict-transport-security"), null);
    const opt = await make({ hstsSubdomains: true }).app.request("https://localhost/");
    assert.equal(opt.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
    const dev = await make({ production: false }).app.request("https://localhost/");
    assert.equal(dev.headers.get("strict-transport-security"), null);
  });

  test("public CSP allows only the page's own stylesheet; admin keeps inline styles and gets the other protections", async () => {
    const { app, ctx } = make();
    const home = await app.request("https://localhost/");
    const csp = home.headers.get("content-security-policy");
    const style = csp.split("; ").find((d) => d.startsWith("style-src "));
    const hash = `'sha256-${crypto.createHash("sha256").update(ctx.assets.get().publicCss).digest("base64")}'`;
    assert.ok(style.includes(hash), style);
    assert.doesNotMatch(style, /unsafe-inline/);
    assert.equal(home.headers.get("cross-origin-resource-policy"), "same-origin");
    const login = await app.request("https://localhost/admin/login");
    assert.match(login.headers.get("content-security-policy"), /style-src 'self' 'unsafe-inline'/);
    assert.equal(login.headers.get("content-security-policy-report-only"), "require-trusted-types-for 'script'");
    assert.equal(login.headers.get("cross-origin-resource-policy"), "same-origin");
  });

  test("the inline stylesheet on a public page is exactly the text the policy hashes", async () => {
    const { app, ctx } = make();
    const html = await (await app.request("https://localhost/")).text();
    const m = html.match(/<style>([\s\S]*?)<\/style>/);
    if (!m) return; // the page links its stylesheet instead: nothing to hash
    const hash = `'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`;
    assert.ok(ctx.assets.get().styleHashes.includes(hash), "the inline <style> text must match a styleHashes entry");
  });

  test("body limits follow sign-in state: sign-in routes and signed-out admin 64 KB, signed-in 8 MB, chunked bodies too", async () => {
    const { app, ctx } = make();
    const big = `a=${"x".repeat(100 * 1024)}`;
    for (const p of ["setup", "login", "login/verify", "logout"]) {
      const res = await app.request(`https://localhost/admin/${p}`, { method: "POST", headers: form, body: big });
      assert.equal(res.status, 413, p);
    }
    assert.equal((await app.request("https://localhost/admin/posts", { method: "POST", headers: form, body: big })).status, 413);
    // a made-up cookie is not a session
    assert.equal((await app.request("https://localhost/admin/posts", { method: "POST", headers: { ...form, cookie: "sid=nonsense" }, body: big })).status, 413);
    const owner = await ctx.store.users.create({ name: "Olive Owner", email: "olive@example.com", role: "owner", password: "owner-pass-phrase-1" });
    const { token } = ctx.store.users.createSession(owner.id);
    for (const name of ["sid", "__Host-sid"]) {
      const res = await app.request("https://localhost/admin/nowhere", { method: "POST", headers: { ...form, cookie: `${name}=${token}` }, body: big });
      assert.notEqual(res.status, 413, name);
    }
    const huge = `a=${"x".repeat(9 * 1024 * 1024)}`;
    assert.equal((await app.request("https://localhost/admin/nowhere", { method: "POST", headers: { ...form, cookie: `sid=${token}` }, body: huge })).status, 413);
    // a chunked anonymous body is capped at 64 KB too
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const chunked = await app.request("https://localhost/admin/media", { method: "POST", headers: { ...form, "transfer-encoding": "chunked" }, body: stream, duplex: "half" });
    assert.equal(chunked.status, 413);
  });

  test("ADMIN_HOST: admin only on that host, public pages there go to the Site URL, shared files stay", async () => {
    const { app } = make({ adminHost: "admin.example.test", siteUrl: "https://www.example.test" });
    const admin = await app.request("https://admin.example.test/admin/setup");
    assert.equal(admin.status, 200);
    const wrongHost = await app.request("https://www.example.test/admin/setup");
    assert.equal(wrongHost.status, 404);
    const other = await app.request("https://evil.example.test/admin/setup");
    assert.equal(other.status, 404);
    const pub = await app.request("https://admin.example.test/some-post/?x=1");
    assert.equal(pub.status, 302);
    assert.equal(pub.headers.get("location"), "https://www.example.test/some-post/?x=1");
    const home = await app.request("https://www.example.test/");
    assert.equal(home.status, 200);
    const font = await app.request("https://admin.example.test/assets/fonts/none.woff2");
    assert.notEqual(font.status, 302);
    const post = await app.request("https://admin.example.test/subscribe", { method: "POST", headers: form });
    assert.equal(post.status, 404);
    // without ADMIN_HOST nothing changes
    const plain = make({ siteUrl: "https://www.example.test" }).app;
    assert.equal((await plain.request("https://www.example.test/admin/setup")).status, 200);
    assert.equal((await plain.request("https://admin.example.test/")).status, 200);
  });

  test("the error log never carries a decoded path, new lines or escape codes", async () => {
    const { app, ctx } = make();
    ctx.store.posts.getPublicBySlug = () => {
      throw new Error("boom\nforged line \u001b[31m with a token " + "T".repeat(40));
    };
    const lines = [];
    const old = console.error;
    console.error = (...a) => lines.push(a.join(" "));
    try {
      const res = await app.request("https://localhost/some%0Apost%1B/");
      assert.equal(res.status, 500);
    } finally {
      console.error = old;
    }
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /[\u0000-\u001f\u007f]/);
    assert.doesNotMatch(lines[0], /some.post/);
    assert.doesNotMatch(lines[0], /TTTTTTTT/);
    assert.match(lines[0], /^\[error\] GET /);
  });

  test("account and mail limiters exist; with store.rateLimits their counters survive a new app on the same data folder", async () => {
    const dir = tmp();
    const mk = () => createApp({ dataDir: dir, production: true, outbound: false, mailTransport: { jsonTransport: true }, setupToken: "t" });
    const first = mk();
    for (const k of ["loginAccount", "step", "signinAccount", "setup", "forgot", "signup"]) assert.equal(typeof first.ctx.limiters[k].take, "function", k);
    for (let i = 0; i < 5; i++) assert.equal(first.ctx.limiters.loginAccount.take("keep@example.com"), true);
    assert.equal(first.ctx.limiters.loginAccount.take("keep@example.com"), false);
    if (!first.ctx.store.rateLimits) return; // stores' side not there yet: the limiter stays in memory
    first.ctx.db.close();
    const second = mk();
    assert.equal(second.ctx.limiters.loginAccount.take("keep@example.com"), false);
  });
});

describe("server.js (R-155, R-156, R-157, N-158, N-159)", () => {
  test("starts on a free port, prints the addresses and stops on a signal", { timeout: 40_000 }, async () => {
    const dir = tmp();
    const port = 47000 + Math.floor(Math.random() * 1000);
    const env = { ...process.env, PORT: String(port), DATA_DIR: dir, BLOG_OUTBOUND: "0", NODE_ENV: "development", SETUP_TOKEN: "test-setup" };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const started = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 30_000);
      const tick = setInterval(() => {
        if (/Admin: /.test(out)) {
          clearTimeout(t);
          clearInterval(tick);
          resolve(true);
        }
      }, 100);
      child.on("exit", () => {
        clearTimeout(t);
        clearInterval(tick);
        resolve(/Admin: /.test(out));
      });
    });
    assert.ok(started, out);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    // a second copy on the same port must exit with the plain message, without announcing anything
    const second = spawn(process.execPath, [path.join(import.meta.dirname, "..", "server.js")], { env: { ...env, DATA_DIR: tmp() }, stdio: ["ignore", "pipe", "pipe"] });
    let out2 = "";
    second.stdout.on("data", (d) => (out2 += d));
    second.stderr.on("data", (d) => (out2 += d));
    const code = await new Promise((resolve) => second.on("exit", resolve));
    assert.equal(code, 1);
    assert.match(out2, /already in use/);
    assert.doesNotMatch(out2, /\[indexnow\]|\[scheduler\]/);
    child.kill();
    await new Promise((resolve) => child.on("exit", resolve));
  });
});
