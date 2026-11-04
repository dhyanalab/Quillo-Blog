// Tests for the platform helpers: validate.js, secrets.js, security.js, the page cache, config and the error handler.
// Run: node --test test/fix-platform.test.js
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createPageCache } from "../src/web/cache.js";
import { analyticsSetup } from "../src/web/analytics.js";
import { createSecrets } from "../src/web/secrets.js";
import { clientIp, createRateLimiter, isAdminPath, isHttps, normalizeIp, safeEq, sameOrigin, securityHeaders } from "../src/web/security.js";
import { cleanText, csvCell, hasControlChars, isEmail, isSafeLocalPath, maskEmail, normalizeEmail } from "../src/web/validate.js";
import { createViews } from "../src/web/views.js";

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fix-platform-"));
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

const fakeCtx = (config = {}, site = {}) => ({ config, site: () => site });
const fakeC = (headers = {}, url = "http://localhost/x") => ({ req: { url, header: (n) => headers[n.toLowerCase()] } });

describe("validate.js", () => {
  test("isEmail accepts normal addresses", () => {
    for (const e of ["a@b.co", "first.last+tag@example.com", "x_y@sub.example.org", "o'brien@example.ie"]) assert.equal(isEmail(e), true, e);
  });
  test("isEmail rejects injection characters, spaces and two @", () => {
    const bad = ["", "a@b", "a@@b.com", "a@b@c.com", "a b@c.com", "a,b@c.com", "a;b@c.com", 'a"b@c.com', "a<b>@c.com", "(a)@c.com", "a[b]@c.com", "a\\b@c.com", "a:b@c.com", "a@b.com\n", "a@b.com\r\nBcc: x@y.com", "a\u0000@b.com", ".a@b.com", "a..b@b.com", "a@-b.com", "a@b..com", "a@b.c om"];
    for (const e of bad) assert.equal(isEmail(e), false, JSON.stringify(e));
    assert.equal(isEmail(null), false);
    assert.equal(isEmail(`${"a".repeat(65)}@b.com`), false);
  });
  test("normalizeEmail trims and lower-cases", () => assert.equal(normalizeEmail("  Jane@Example.COM "), "jane@example.com"));
  test("isSafeLocalPath", () => {
    for (const p of ["/", "/about/", "/blog/post?x=1#y"]) assert.equal(isSafeLocalPath(p), true, p);
    for (const p of ["", "about", "//evil.com", "/\\evil.com", "/a b", "/a\tb", "/a\nb", "javascript:alert(1)", `/${"a".repeat(500)}`, 5, null]) assert.equal(isSafeLocalPath(p), false, String(p));
  });
  test("hasControlChars and cleanText", () => {
    assert.equal(hasControlChars("a\u0007b"), true);
    assert.equal(hasControlChars("a\u0085b"), true);
    assert.equal(hasControlChars("plain text"), false);
    assert.equal(cleanText("  hi\u0000 there\u009f\nline2  ", 100), "hi there\nline2");
    assert.equal(cleanText("abcdef", 3), "abc");
    assert.equal(cleanText(undefined), "");
  });
  test("csvCell quotes and guards formulas", () => {
    assert.equal(csvCell("plain"), '"plain"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    for (const v of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "\n=1"]) assert.match(csvCell(v), /^"'/, JSON.stringify(v));
    assert.equal(csvCell("a\u0000b\u0007c"), '"abc"');
    assert.equal(csvCell(null), '""');
  });
  test("maskEmail", () => {
    assert.equal(maskEmail("jane@example.com"), "j***@example.com");
    assert.equal(maskEmail("nonsense"), "***");
  });
});

describe("secrets.js", () => {
  test("seal and open round-trip, with a fresh iv each time", () => {
    const s = createSecrets(tmp());
    const a = s.seal("JBSWY3DPEHPK3PXP");
    const b = s.seal("JBSWY3DPEHPK3PXP");
    assert.match(a, /^v1:/);
    assert.notEqual(a, b);
    assert.equal(s.open(a), "JBSWY3DPEHPK3PXP");
    assert.equal(s.seal(""), "");
  });
  test("open returns legacy plaintext unchanged", () => {
    assert.equal(createSecrets(tmp()).open("old plain value"), "old plain value");
  });
  test("a tampered value does not open", () => {
    const s = createSecrets(tmp());
    const sealed = s.seal("secret");
    const broken = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`;
    assert.throws(() => s.open(broken));
  });
  test("the key file is created once and reused", () => {
    const dir = tmp();
    const one = createSecrets(dir);
    assert.ok(fs.existsSync(path.join(dir, "secret.key")));
    const sealed = one.seal("keep");
    assert.equal(createSecrets(dir).open(sealed), "keep");
    assert.equal(createSecrets(dir).hmac("x"), one.hmac("x"));
  });
  test("a different key cannot open it; hmac is hex sha256-sized", () => {
    const a = createSecrets(tmp());
    const b = createSecrets(tmp());
    assert.throws(() => b.open(a.seal("x")));
    assert.match(a.hmac("code"), /^[0-9a-f]{64}$/);
    assert.notEqual(a.hmac("code"), b.hmac("code"));
  });
  test("APP_SECRET must be 64 hex characters", () => {
    const old = process.env.APP_SECRET;
    try {
      process.env.APP_SECRET = "short";
      assert.throws(() => createSecrets(tmp()), /APP_SECRET/);
      process.env.APP_SECRET = "ab".repeat(32);
      const s = createSecrets(tmp());
      assert.equal(s.open(s.seal("v")), "v");
    } finally {
      if (old === undefined) delete process.env.APP_SECRET;
      else process.env.APP_SECRET = old;
    }
  });
});

describe("security.js", () => {
  test("safeEq", () => {
    assert.equal(safeEq("abc", "abc"), true);
    assert.equal(safeEq("abc", "abd"), false);
    assert.equal(safeEq("abc", "abcd"), false);
    assert.equal(safeEq(undefined, ""), true);
  });

  test("isAdminPath is exact", () => {
    assert.equal(isAdminPath("/admin", ""), true);
    assert.equal(isAdminPath("/admin/", ""), true);
    assert.equal(isAdminPath("/admin/posts", ""), true);
    assert.equal(isAdminPath("/admin-news/", ""), false);
    assert.equal(isAdminPath("/administrator", ""), false);
    assert.equal(isAdminPath("/blog/admin/login", "/blog"), true);
    assert.equal(isAdminPath("/blog/admin-news/", "/blog"), false);
    assert.equal(isAdminPath("/admin/x", "/blog"), false);
  });

  test("clientIp takes the rightmost hop behind a trusted proxy", () => {
    const ctx = fakeCtx({ trustProxy: true, proxyHops: 1 });
    assert.equal(clientIp(fakeC({ "x-forwarded-for": "6.6.6.6, 1.2.3.4, 5.6.7.8" }), ctx), "5.6.7.8");
    assert.equal(clientIp(fakeC({ "x-forwarded-for": "9.9.9.9" }), ctx), "9.9.9.9");
    assert.equal(clientIp(fakeC({ "x-forwarded-for": "6.6.6.6, 1.2.3.4, 5.6.7.8" }), fakeCtx({ trustProxy: true, proxyHops: 2 })), "1.2.3.4");
    // more hops than entries: the header is not believed (a forged one must not pick its own bucket), the socket address is used
    assert.equal(clientIp(fakeC({ "x-forwarded-for": "1.2.3.4" }), fakeCtx({ trustProxy: true, proxyHops: 3 })), "unknown");
  });
  test("clientIp ignores X-Forwarded-For without trustProxy and never returns an empty string", () => {
    const ip = clientIp(fakeC({ "x-forwarded-for": "1.2.3.4" }), fakeCtx({ trustProxy: false }));
    assert.equal(ip, "unknown");
    // junk in the header falls back, it never becomes a key
    assert.equal(clientIp(fakeC({ "x-forwarded-for": "not-an-ip" }), fakeCtx({ trustProxy: true })), "unknown");
    assert.equal(clientIp(fakeC({}), fakeCtx({})), "unknown");
  });
  test("clientIp reduces IPv6 to its /64 and unwraps IPv4-mapped addresses", () => {
    const ctx = fakeCtx({ trustProxy: true });
    const a = clientIp(fakeC({ "x-forwarded-for": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }), ctx);
    const b = clientIp(fakeC({ "x-forwarded-for": "2001:0db8:0001:0002::1" }), ctx);
    assert.equal(a, "2001:db8:1:2::/64");
    assert.equal(b, "2001:db8:1:2::/64");
    assert.notEqual(clientIp(fakeC({ "x-forwarded-for": "2001:db8:1:3::1" }), ctx), a);
    assert.equal(clientIp(fakeC({ "x-forwarded-for": "::ffff:203.0.113.9" }), ctx), "203.0.113.9");
    assert.equal(normalizeIp("[2001:db8::1]:443"), "2001:db8:0:0::/64");
    assert.equal(normalizeIp("203.0.113.9:5555"), "203.0.113.9");
    assert.equal(normalizeIp("fe80::1%eth0"), "fe80:0:0:0::/64");
    assert.equal(normalizeIp("garbage"), "");
  });

  test("sameOrigin compares scheme and host", () => {
    const ctx = fakeCtx({}, { origin: "https://example.com" });
    const req = (h, url = "https://example.com/admin/login") => fakeC({ host: "example.com", ...h }, url);
    assert.equal(sameOrigin(req({ origin: "https://example.com" }), ctx), true);
    assert.equal(sameOrigin(req({ origin: "http://example.com" }), ctx), false);
    assert.equal(sameOrigin(req({ origin: "https://evil.com" }), ctx), false);
    assert.equal(sameOrigin(req({ origin: "null" }), ctx), false);
    assert.equal(sameOrigin(req({ referer: "https://example.com/page" }), ctx), true);
  });
  test("sameOrigin with no Origin or Referer needs Sec-Fetch-Site", () => {
    const ctx = fakeCtx({}, {});
    const req = (h) => fakeC({ host: "localhost", ...h }, "http://localhost/x");
    assert.equal(sameOrigin(req({}), ctx), false);
    assert.equal(sameOrigin(req({ "sec-fetch-site": "cross-site" }), ctx), false);
    assert.equal(sameOrigin(req({ "sec-fetch-site": "same-origin" }), ctx), true);
    // "none" is a typed address or bookmark, not a form post
    assert.equal(sameOrigin(req({ "sec-fetch-site": "none" }), ctx), false);
  });
  test("sameOrigin takes X-Forwarded-Host from the right (like the address), and only behind a trusted proxy", () => {
    const h = { host: "internal:4100", "x-forwarded-host": "evil.example, example.com", "x-forwarded-proto": "https", origin: "https://example.com" };
    assert.equal(sameOrigin(fakeC(h, "http://internal:4100/x"), fakeCtx({ trustProxy: true }, {})), true);
    assert.equal(sameOrigin(fakeC(h, "http://internal:4100/x"), fakeCtx({ trustProxy: false }, {})), false);
    // the left side is whatever the client sent
    assert.equal(sameOrigin(fakeC({ ...h, "x-forwarded-host": "example.com, other.example" }, "http://internal:4100/x"), fakeCtx({ trustProxy: true }, {})), false);
  });
  test("isHttps", () => {
    assert.equal(isHttps(fakeC({ "x-forwarded-proto": "https" }), fakeCtx({ trustProxy: true })), true);
    assert.equal(isHttps(fakeC({ "x-forwarded-proto": "https" }), fakeCtx({ trustProxy: false })), false);
    assert.equal(isHttps(fakeC({}, "https://example.com/"), fakeCtx({})), true);
    assert.equal(isHttps(fakeC({}), fakeCtx({}, { https: true })), true);
    assert.equal(isHttps(fakeC({}), fakeCtx({}, { https: false })), false);
  });

  test("rate limiter: limit, reset, count, no creep for blocked keys", () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000 });
    assert.deepEqual([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("a"), rl.take("a")], [true, true, true, false, false]);
    assert.equal(rl.count("a"), 3);
    assert.equal(rl.take("b"), true);
    rl.reset("a");
    assert.equal(rl.count("a"), 0);
    assert.equal(rl.take("a"), true);
    rl.stop();
  });
  test("rate limiter: key table is capped and fails closed, live keys are never evicted", () => {
    const rl = createRateLimiter({ limit: 5, windowMs: 3_600_000, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) rl.take(`k${i}`);
    assert.ok(rl.size <= 100, `size ${rl.size}`);
    // the first keys keep their counters, the flood of later new keys is refused
    assert.equal(rl.count("k0"), 1);
    assert.equal(rl.count("k99"), 1);
    assert.equal(rl.take("k999"), false);
    assert.equal(rl.take("k0"), true);
    rl.stop();
  });
  test("rate limiter: a /64 gets one quota, not billions", () => {
    const rl = createRateLimiter({ limit: 5, windowMs: 3_600_000 });
    const ctx = fakeCtx({ trustProxy: true });
    const results = [];
    for (let i = 0; i < 10; i++) results.push(rl.take(clientIp(fakeC({ "x-forwarded-for": `2001:db8:0:0:${i}::1` }), ctx)));
    assert.equal(results.filter(Boolean).length, 5);
    rl.stop();
  });
  test("rate limiter: no double burst across a window edge", async () => {
    const rl = createRateLimiter({ limit: 4, windowMs: 200 });
    for (let i = 0; i < 4; i++) assert.equal(rl.take("k"), true);
    await new Promise((r) => setTimeout(r, 210)); // just past the boundary
    let ok = 0;
    for (let i = 0; i < 4; i++) if (rl.take("k")) ok++;
    assert.ok(ok < 4, `allowed ${ok} right after the edge`);
    rl.stop();
  });

  test("admin CSP has its own scripts, no frames, no ytimg", () => {
    const base = { scriptHashes: ["'sha256-PUBLIC'"], adminScriptHashes: ["'sha256-ADMIN'"], https: true };
    const admin = securityHeaders({ ...base, admin: true })["Content-Security-Policy"];
    const pub = securityHeaders({ ...base, admin: false })["Content-Security-Policy"];
    assert.match(admin, /script-src 'self' 'sha256-ADMIN'(;|$)/);
    assert.doesNotMatch(admin, /PUBLIC/);
    assert.match(admin, /frame-src 'none'/);
    assert.doesNotMatch(admin, /ytimg/);
    assert.match(pub, /sha256-PUBLIC/);
    assert.match(pub, /youtube-nocookie/);
    assert.doesNotMatch(pub, /sha256-ADMIN/);
  });
});

describe("page cache", () => {
  test("query strings do not create new entries", () => {
    const c = createPageCache();
    c.set("/post/?x=1", { body: "page" });
    c.set("/post/?x=2", { body: "page" });
    assert.equal(c.size, 1);
    assert.equal(c.get("/post/?whatever=3").body, "page");
  });
  test("byte budget evicts the oldest entries", () => {
    const c = createPageCache({ maxBytes: 1_000_000 });
    for (let i = 0; i < 20; i++) c.set(`/p${i}/`, { body: "x".repeat(100_000) });
    assert.ok(c.bytes <= 1_000_000, `bytes ${c.bytes}`);
    assert.ok(c.size < 20);
    assert.equal(c.get("/p0/"), null);
    assert.ok(c.get("/p19/"));
    c.clear();
    assert.equal(c.bytes, 0);
  });
  test("one oversized page is not cached", () => {
    const c = createPageCache({ maxBytes: 1_000_000 });
    c.set("/small/", { body: "ok" });
    c.set("/huge/", { body: "x".repeat(900_000) });
    assert.equal(c.get("/huge/"), null);
    assert.ok(c.get("/small/"));
  });
  test("entry count cap still holds", () => {
    const c = createPageCache({ max: 5 });
    for (let i = 0; i < 20; i++) c.set(`/p${i}/`, { body: "x" });
    assert.equal(c.size, 5);
  });
});

describe("config", () => {
  test("production by default, development only on request", () => {
    const old = process.env.NODE_ENV;
    try {
      delete process.env.NODE_ENV;
      assert.equal(loadConfig({}).production, true);
      assert.equal(loadConfig({}).dev, false);
      process.env.NODE_ENV = "development";
      assert.equal(loadConfig({}).production, false);
      assert.equal(loadConfig({}).dev, true);
      assert.equal(loadConfig({ production: true }).dev, false);
    } finally {
      if (old === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = old;
    }
  });
  test("SITE_URL is validated", () => {
    assert.equal(loadConfig({ siteUrl: "https://example.com/" }).siteUrl, "https://example.com");
    assert.equal(loadConfig({ siteUrl: "" }).siteUrl, "");
    assert.throws(() => loadConfig({ siteUrl: "not a url" }), /SITE_URL/);
    assert.throws(() => loadConfig({ siteUrl: "javascript:alert(1)" }), /SITE_URL/);
    assert.throws(() => loadConfig({ siteUrl: "https://user:pw@example.com" }), /SITE_URL/);
  });
  test("proxyHops and setupToken", () => {
    assert.equal(loadConfig({}).proxyHops, 1);
    assert.equal(loadConfig({ proxyHops: 2 }).proxyHops, 2);
    assert.equal(loadConfig({ setupToken: "abcdefghij" }).setupToken, "abcdefghij");
    // a token shorter than 10 characters is ignored with a warning, never an error
    const old = console.warn;
    console.warn = () => {};
    try {
      const short = loadConfig({ setupToken: "abc" });
      assert.equal(short.setupToken, "");
      assert.match(short.warnings.join(" "), /SETUP_TOKEN/);
    } finally {
      console.warn = old;
    }
  });
});

describe("analytics hosts", () => {
  const base = { analytics_provider: "umami", analytics_id: "id-1" };
  test("only plain https hosts get into the policy", () => {
    assert.equal(analyticsSetup({ ...base, analytics_script: "https://stats.example.com/script.js" }).scriptSrc[0], "https://stats.example.com");
    assert.equal(analyticsSetup({ ...base, analytics_script: "http://stats.example.com/script.js" }), null);
    assert.equal(analyticsSetup({ ...base, analytics_script: "https://stats.example.com;sandbox/script.js" }), null);
    assert.equal(analyticsSetup({ ...base, analytics_script: "https://*.example.com/script.js" }), null);
    assert.equal(analyticsSetup({ ...base, analytics_script: "https://u:p@stats.example.com/script.js" }), null);
  });
  test("the data host must be the tracker's own or Umami Cloud", () => {
    const own = analyticsSetup({ ...base, analytics_script: "https://stats.example.com/script.js", analytics_host: "https://stats.example.com" });
    assert.ok(own.connectSrc.includes("https://stats.example.com"));
    const other = analyticsSetup({ ...base, analytics_script: "https://stats.example.com/script.js", analytics_host: "https://collector.attacker.test" });
    assert.ok(!other.connectSrc.includes("https://collector.attacker.test"));
    assert.doesNotMatch(other.html, /attacker/);
  });
});

describe("views jsonld filter", () => {
  test("escapes characters that could break out of a script block", () => {
    const { env } = createViews({ production: true });
    const out = env.getFilter("jsonld")({ a: "</script><b>&\u2028\u2029" }).toString();
    for (const ch of ["<", ">", "&", "\u2028", "\u2029"]) assert.ok(!out.includes(ch), JSON.stringify(ch));
    assert.deepEqual(JSON.parse(out), { a: "</script><b>&\u2028\u2029" });
  });
});

describe("db", () => {
  test("applied updates are checksummed, unknown ones are refused", () => {
    const dir = tmp();
    const db = openDb(dir);
    const rows = db.prepare("SELECT id, checksum FROM schema_migrations").all();
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum)));
    db.prepare("INSERT INTO schema_migrations (id, applied_at, checksum) VALUES ('999_from_the_future.sql', '2030-01-01', 'x')").run();
    db.close();
    assert.throws(() => openDb(dir), /newer version/);
  });
  test("a legacy database without checksums is filled in", () => {
    const dir = tmp();
    const db = openDb(dir);
    db.exec("UPDATE schema_migrations SET checksum = NULL");
    db.close();
    const again = openDb(dir);
    assert.equal(again.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE checksum IS NULL").get().n, 0);
    again.close();
  });
  test("the data folder and database are owner-only on POSIX systems", { skip: process.platform === "win32" }, () => {
    const dir = path.join(tmp(), "data");
    openDb(dir).close();
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, "blog.db")).mode & 0o777, 0o600);
  });
});

describe("app: error handler, body limits, headers, setup token", async () => {
  // Loaded here so the helper tests above still run if another area's file is mid-edit.
  const { createApp } = await import("../src/web/app.js");
  const make = (extra = {}) => createApp({ dataDir: tmp(), production: true, outbound: false, mailTransport: { jsonTransport: true }, setupToken: "test-setup", ...extra });
  const origError = console.error;

  test("a 500 never shows a stack trace in production", async () => {
    const { app, ctx } = make();
    ctx.store.posts.getPublicBySlug = () => {
      throw new Error("SECRET-SQL-DETAIL select * from users");
    };
    console.error = () => {};
    try {
      const res = await app.request("http://localhost/some-post/");
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.doesNotMatch(text, /SECRET-SQL|at .*\.js|node_modules/);
      assert.match(text, /Something went wrong/);
    } finally {
      console.error = origError;
    }
  });
  test("development shows the error", async () => {
    const { app, ctx } = make({ production: false });
    ctx.store.posts.getPublicBySlug = () => {
      throw new Error("DEV-DETAIL");
    };
    console.error = () => {};
    try {
      const res = await app.request("http://localhost/some-post/");
      assert.equal(res.status, 500);
      assert.match(await res.text(), /DEV-DETAIL/);
    } finally {
      console.error = origError;
    }
  });
  test("bad URL encoding is a 404, not a 500", async () => {
    const { app } = make();
    const res = await app.request("http://localhost/%E0%A4%A/");
    assert.equal(res.status, 404);
  });

  test("POST bodies over 64 KB get 413 on public routes and on the sign-in routes; a signed-in admin is allowed more", async () => {
    const { app, ctx } = make();
    const form = { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" };
    const big = "a=" + "x".repeat(100 * 1024);
    const pub = await app.request("http://localhost/subscribe", { method: "POST", headers: form, body: big });
    assert.equal(pub.status, 413);
    const adm = await app.request("http://localhost/admin/login", { method: "POST", headers: form, body: big });
    assert.equal(adm.status, 413);
    // an admin request with no live session is small too
    const anon = await app.request("http://localhost/admin/posts", { method: "POST", headers: form, body: big });
    assert.equal(anon.status, 413);
    // with a live session the admin limit (8 MB) applies
    const owner = await ctx.store.users.create({ name: "Olive Owner", email: "olive@example.com", role: "owner", password: "owner-pass-phrase-1" });
    const { token } = ctx.store.users.createSession(owner.id);
    const signedIn = await app.request("http://localhost/admin/nowhere", { method: "POST", headers: { ...form, cookie: `sid=${token}` }, body: big });
    assert.notEqual(signedIn.status, 413);
    const huge = "a=" + "x".repeat(9 * 1024 * 1024);
    const signedInHuge = await app.request("http://localhost/admin/nowhere", { method: "POST", headers: { ...form, cookie: `sid=${token}` }, body: huge });
    assert.equal(signedInHuge.status, 413);
  });

  test("security headers: admin and public policies differ, admin static keeps its cache header", async () => {
    const { app } = make();
    const home = await app.request("http://localhost/");
    assert.match(home.headers.get("content-security-policy"), /frame-src https:\/\/www\.youtube-nocookie\.com/);
    const login = await app.request("http://localhost/admin/login");
    assert.match(login.headers.get("content-security-policy"), /frame-src 'none'/);
    assert.equal(login.headers.get("cache-control"), "no-store");
    const css = await app.request("http://localhost/admin/static/admin.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("cache-control"), /immutable/);
  });

  test("a setup token is generated when none is given and no owner exists", () => {
    const old = process.env.SETUP_TOKEN;
    delete process.env.SETUP_TOKEN;
    try {
      const { ctx } = createApp({ dataDir: tmp(), production: true, outbound: false, mailTransport: { jsonTransport: true } });
      assert.match(ctx.config.setupToken, /^[0-9a-f]{32}$/);
      assert.equal(ctx.config.setupTokenGenerated, true);
    } finally {
      if (old !== undefined) process.env.SETUP_TOKEN = old;
    }
  });

  test("ctx carries secrets and every limiter", () => {
    const { ctx } = make();
    assert.equal(typeof ctx.secrets.seal, "function");
    for (const k of ["login", "loginAccount", "step", "signin", "signinAccount", "signup", "subscribe", "beacon", "comment", "like", "search", "setup", "forgot"]) {
      assert.equal(typeof ctx.limiters[k]?.take, "function", k);
    }
  });
});
