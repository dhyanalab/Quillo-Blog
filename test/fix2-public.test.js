// Tests for the second round of public-site fixes (audit run 3): Markdown output limits, admin-aimed images, the page cache for
// signed-in readers, the shared 404, newsletter sign-up limits, no inline styles, media headers, publish checks, schema and helpers.
// In-process, no network. Run: node --test test/fix2-public.test.js
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../src/web/app.js";
import { bodyTooLong, createMarkdown, droppedFromTokens, estimateHtmlSize, isAdminTarget, isExternal, MAX_BODY_HTML, TOO_LONG } from "../src/render/markdown.js";
import { findSecrets, publishChecks } from "../src/render/checks.js";
import { prepareNewsletter } from "../src/render/email.js";
import { ogHash } from "../src/render/og.js";
import * as schema from "../src/render/schema.js";
import { ftsQuery, isHttpUrl, localInputToIso, timestampToSeconds } from "../src/render/util.js";
import { createPresenter, createRenderMemo } from "../src/web/present.js";
import { brandSvg, iconSvg } from "../src/web/icons.js";
import { renderSlots } from "../src/web/slots.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix2-public-"));
const { app, ctx } = createApp({ dataDir, production: true, outbound: false, mailTransport: { jsonTransport: true }, setupToken: "test-setup", mailDelayMs: 0 });
// Source code, downloads and "Tested with" are switched off on a new blog (Settings > Post features); these tests use them.
ctx.store.settings.set({ post_features: ["code", "downloads", "tested"] });
const { store } = ctx;

const get = (p, { method = "GET", headers = {} } = {}) => app.request(`http://localhost${p}`, { method, headers, redirect: "manual" });
const post = (p, form, headers = {}) =>
  app.request(`http://localhost${p}`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form), redirect: "manual" });
const resetLimits = () => {
  for (const name of ["subscribe", "search"]) ctx.limiters[name].reset("unknown");
};
const past = new Date(Date.now() - 86400_000).toISOString();
const sent = [];

let author;
let published;
let known;

before(async () => {
  author = await store.users.create({ name: "Test Author", email: "author@example.com", password: "correct horse battery", role: "author" });
  const cat = store.categories.save({ name: "Projects", slug: "projects", description: "Projects.", show_on_home: 1 });
  const dir = path.join(ctx.mediaDir, "2026", "11");
  fs.mkdirSync(dir, { recursive: true });
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#c2410c" } }).png().toBuffer();
  fs.writeFileSync(path.join(dir, "pub-aaaaaaaa.png"), png);
  fs.writeFileSync(path.join(dir, "priv-bbbbbbbb.png"), png);
  fs.writeFileSync(path.join(dir, "pub-aaaaaaaa-640.webp"), png);
  known = store.media.insert({ path: "2026/11/pub-aaaaaaaa.png", original_name: "pub.png", mime: "image/png", width: 20, height: 20, size: png.length, variants: { webp: [[640, "2026/11/pub-aaaaaaaa-640.webp"]], avif: [] } }, author.id);
  store.media.insert({ path: "2026/11/priv-bbbbbbbb.png", original_name: "priv.png", mime: "image/png", width: 20, height: 20, size: png.length, variants: {} }, author.id);
  const base = { author_id: author.id, category_id: cat.id, excerpt: "A reasonably long description of the post for the tests, long enough to pass.", comments_enabled: true };
  published = store.posts.save({ ...base, type: "post", status: "published", title: "Published Post", slug: "published-post", published_at: past, body_md: "## Wiring\n\nText.", feature_image_id: known.id, feature_image_alt: "Pic", source_files: [{ name: "main.ino", code: "void setup() {}\n" }] }, { userId: author.id });
  store.posts.save({ ...base, type: "post", status: "published", title: "Second Post", slug: "second-post", published_at: past, body_md: "Text." }, { userId: author.id });
  store.posts.save({ ...base, type: "page", status: "published", title: "Plain Page", slug: "plain-page", published_at: past, body_md: "Text." }, { userId: author.id });
  ctx.mailer.ready = () => true;
  ctx.mailer.sendConfirmSubscription = (subscriber, url) => {
    sent.push({ subscriber, url });
    return Promise.resolve(true);
  };
});

after(() => {
  try {
    ctx.db.close?.();
  } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("markdown output limits (Q16)", () => {
  const md = () => createMarkdown({ siteHost: "example.com" });
  test("an address over 2,048 characters is not linked, and the text still shows", () => {
    const long = `https://example.org/${"a".repeat(3000)}`;
    const html = md().render(`[see this](${long}) and ![the alt](${long})`);
    assert.doesNotMatch(html, /<a |<img /);
    assert.ok(html.includes("see this") && html.includes("the alt"));
    assert.ok(html.length < 500);
  });
  test("links past 5,000 in one body show as text", () => {
    const html = md().render("[x](https://example.org/a) ".repeat(5100));
    assert.equal((html.match(/<a /g) || []).length, 5000);
    assert.ok(html.includes("x"));
  });
  test("a reference definition reused thousands of times can't make a huge page", () => {
    const body = `[x]: https://example.org/${"a".repeat(1900)}\n\n${"[x] ".repeat(4000)}`;
    const m = md();
    const tokens = m.parse(body, {});
    assert.ok(estimateHtmlSize(tokens) > MAX_BODY_HTML * 1.5);
    assert.equal(bodyTooLong(tokens), true);
    const store2 = { media: { get: () => null, getByPath: () => null }, comments: {}, posts: {}, users: {}, categories: {} };
    const pr = createPresenter({ store: store2, site: { current: () => ({ host: "example.com", base: "", url: { media: (p) => `/media/${p}` }, tz: "UTC" }) } });
    const out = pr.renderBody(body);
    assert.match(out.html, /too long to show/);
    assert.equal(out.html.length < 200, true);
    assert.equal(TOO_LONG, "This article is too long to show.");
  });
  test("the publish checks refuse a body that is too long, and name dropped links", () => {
    const body = `[x]: https://example.org/${"a".repeat(1900)}\n\n${"[x] ".repeat(4000)}`;
    const tokens = md().parse(body, {});
    const post = { type: "post", slug: "s", title: "T", excerpt: "x".repeat(100), body_md: body, source_files: [], downloads: {} };
    const { errors } = publishChecks(post, { tokens, basePath: "", siteHost: "example.com", resolvePath: () => true, mediaExists: () => true });
    assert.ok(errors.some((e) => /too long to show/.test(e.message)));
    const long = `[a](https://example.org/${"b".repeat(3000)})`;
    const t2 = md().parse(long, {});
    assert.equal(droppedFromTokens(t2).length, 1);
    const r2 = publishChecks({ ...post, body_md: long }, { tokens: t2, basePath: "", siteHost: "example.com", resolvePath: () => true, mediaExists: () => true });
    assert.ok(r2.errors.some((e) => /longer than 2048/.test(e.message)));
  });
  test("check messages are cut to 200 characters and stop after 50 problems", () => {
    const urls = Array.from({ length: 300 }, (_, i) => `[a${i}](https://example.org/${"z".repeat(500)}${i}) ![](/media/none/${"q".repeat(400)}${i}.png)`).join("\n\n");
    const tokens = md().parse(urls, {});
    const post = { type: "post", slug: "s", title: "T", excerpt: "x".repeat(100), body_md: urls, source_files: [], downloads: {} };
    const t = Date.now();
    const { errors, warnings } = publishChecks(post, { tokens, basePath: "", siteHost: "example.com", resolvePath: () => false, mediaExists: () => false });
    assert.ok(errors.length <= 50 && warnings.length <= 50);
    assert.ok(errors.length >= 40);
    for (const e of errors) assert.ok(e.message.length < 400, e.message.length);
    assert.ok(Date.now() - t < 3000);
  });
  test("each distinct address is parsed once per render", () => {
    const memo = new Map();
    for (let i = 0; i < 1000; i++) isExternal("https://other.example/x", "example.com", memo);
    assert.equal(memo.size, 1);
  });
  test("the render memo has a byte budget", () => {
    const memo = createRenderMemo({ maxEntries: 100, maxBytes: 1000 });
    for (let i = 0; i < 20; i++) memo.set(`k${i}`, { html: "x".repeat(100), toc: [] });
    assert.ok(memo.bytes <= 1000 && memo.size < 20);
    memo.set("huge", { html: "x".repeat(5000), toc: [] });
    assert.equal(memo.has("huge"), false, "one huge entry is not kept");
  });
});

describe("images aimed at the admin area (Q13)", () => {
  const md = (base = "") => createMarkdown({ siteHost: "example.com", basePath: base });
  test("the alt text is shown instead of an image into /admin", () => {
    for (const src of ["/admin/newsletter/subscribers.csv", "/admin", "/%61dmin/x", "../admin/x", "https://example.com/admin/members.csv", "//example.com/admin/x"]) {
      const html = md().render(`![the alt](${src})`);
      assert.doesNotMatch(html, /<img/, src);
      assert.match(html, /the alt/, src);
    }
  });
  test("with a base path only its own admin area is refused; ordinary pictures are untouched", () => {
    assert.doesNotMatch(md("/blog").render("![a](/blog/admin/x.csv)"), /<img/);
    assert.match(md("/blog").render("![a](/admin/x.png)"), /<img/);
    assert.match(md().render("![ok](/media/2026/11/a.png) ![ad](/administration/a.png) ![o](https://other.example/a.png)"), /<img[^>]*media[^>]*>[^<]*<img[^>]*administration[^>]*>[^<]*<img[^>]*other/);
    assert.equal(isAdminTarget("/admin/x", "", "example.com"), true);
    assert.equal(isAdminTarget("https://other.example/admin/x", "", "example.com"), false);
  });
  test("a published post with such an image renders without it", async () => {
    store.posts.save({ type: "post", status: "published", title: "Admin Img", slug: "admin-img", author_id: author.id, excerpt: "x", published_at: past, body_md: "![x](/admin/newsletter/subscribers.csv)" }, { userId: author.id });
    const html = await (await get("/admin-img/")).text();
    assert.doesNotMatch(html, /admin\/newsletter\/subscribers\.csv/);
  });
});

describe("links: protocol-relative and other schemes (N-040)", () => {
  test("// and ftp links are external; mailto and relative are not", () => {
    assert.equal(isExternal("//evil.example/x", "example.com"), true);
    assert.equal(isExternal("/\\evil.example/x", "example.com"), true);
    assert.equal(isExternal("ftp://files.example/x", "example.com"), true);
    assert.equal(isExternal("mailto:a@b.co", "example.com"), false);
    assert.equal(isExternal("/page/", "example.com"), false);
    assert.equal(isExternal("https://www.example.com/a", "example.com"), false);
  });
  test("one shared parser takes the host from each render (N-117)", () => {
    const m = createMarkdown({});
    assert.match(m.render("[x](https://a.example/)", { siteHost: "b.example" }), /target="_blank"/);
    assert.doesNotMatch(m.render("[x](https://a.example/)", { siteHost: "a.example" }), /target=/);
  });
});

describe("heading ids (R-034)", () => {
  test("a heading like 'Comment 12' never takes a comment's id", () => {
    const html = createMarkdown({ siteHost: "example.com" }).render("## Comment 12\n\n## Forgot\n\n## fg-email\n");
    assert.doesNotMatch(html, /id="comment-12"/);
    assert.doesNotMatch(html, /id="fg-email"/);
    assert.match(html, /id="comment-12-2"/);
  });
});

describe("shared 404 (L-public-shared-404)", () => {
  test("nothing from the first requester ends up in the cached page", async () => {
    const first = await get("/reset/aaaaaaaaaaaaaaaaaaaa.");
    assert.equal(first.status, 404);
    assert.doesNotMatch(await first.text(), /aaaaaaaaaaaaaaaaaaaa/);
    const second = await get("/no-such-page/");
    const html = await second.text();
    assert.equal(second.status, 404);
    assert.doesNotMatch(html, /reset\/aaaaaaaa/);
    assert.match(html, /name="source" value=""/);
    // A private address never uses the shared copy, and a shared one is not changed by it.
    const third = await (await get("/verify/bbbbbbbbbbbbbbbbbbbb.")).text();
    assert.doesNotMatch(third, /bbbbbbbbbbbbbbbbbbbb/);
  });
});

describe("page cache tags and signed-in readers (Q7)", () => {
  test("post pages are tagged by post; lists, feeds and the sitemap by 'lists'", async () => {
    await get("/published-post/");
    await get("/latest/");
    await get("/sitemap.xml");
    await get("/rss.xml");
    assert.ok(ctx.cache.get("/published-post/") && ctx.cache.get("/latest/") && ctx.cache.get("/sitemap.xml") && ctx.cache.get("/rss.xml"));
    ctx.cache.clearTag(`post:${published.id}`);
    assert.equal(ctx.cache.get("/published-post/"), null);
    assert.ok(ctx.cache.get("/latest/"), "lists are not touched by a comment");
    ctx.cache.clearTag("lists");
    assert.equal(ctx.cache.get("/latest/"), null);
    assert.equal(ctx.cache.get("/sitemap.xml"), null);
    assert.equal(ctx.cache.get("/rss.xml"), null);
  });
  test("a post page with comments is tagged with its commenters", async () => {
    const m = await store.members.create({ email: "tagger@example.com", name: "Tagger", password: "correct horse battery" }, { verified: true });
    store.comments.add({ postId: published.id, memberId: m.id, body: "Nice", status: "published" });
    await get("/published-post/");
    assert.ok(ctx.cache.get("/published-post/"));
    ctx.cache.clearTag(`member:${m.id}`);
    assert.equal(ctx.cache.get("/published-post/"), null);
  });
  test("a signed-in reader gets 60 fresh renders a minute, then a 429", async () => {
    const m = await store.members.create({ email: "busy@example.com", name: "Busy Reader", password: "correct horse battery" }, { verified: true });
    const { token } = store.members.createSession(m.id);
    const headers = { cookie: `mid=${token}` };
    let last;
    for (let i = 0; i < 60; i++) last = await get("/latest/", { headers });
    assert.equal(last.status, 200);
    assert.equal(last.headers.get("cache-control"), "private, no-store");
    const over = await get("/latest/", { headers });
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("retry-after"), "60");
    assert.equal(await over.text(), "You're moving fast. Please wait a minute.");
    // Anonymous visitors are not affected.
    assert.equal((await get("/latest/")).status, 200);
  });
});

describe("newsletter subscribe (Q5)", () => {
  beforeEach(resetLimits);
  test("an invalid address is refused before any limiter is spent", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await post("/subscribe", { email: "nope" })).status, 400);
    assert.equal((await post("/subscribe", { email: "fresh1@example.com" })).status, 200);
  });
  test("a pending address gets no new mail within 15 minutes, and the page is the same", async () => {
    const n = sent.length;
    const a = await (await post("/subscribe", { email: "same@example.com" })).text();
    const b = await (await post("/subscribe", { email: "same@example.com" })).text();
    assert.equal(a, b);
    assert.equal(sent.length, n + 1);
  });
  test("the per-address limit is three an hour, whatever the network", async () => {
    const pages = [];
    for (let i = 0; i < 5; i++) pages.push((await post("/subscribe", { email: "Limit@Example.com" }, { "x-forwarded-for": `9.9.9.${i}` })).status);
    assert.deepEqual(pages, [200, 200, 200, 200, 200]);
    assert.equal(sent.filter((s) => s.subscriber.email === "limit@example.com").length, 1);
  });
  test("a malformed form body is a 400", async () => {
    const res = await app.request("http://localhost/subscribe", { method: "POST", headers: { origin: "http://localhost", "content-type": "multipart/form-data; boundary=x" }, body: "garbage" });
    assert.equal(res.status, 400);
  });
});

describe("confirm and unsubscribe pages (N-074, N-075)", () => {
  let sub;
  let tok;
  before(() => {
    sub = store.subscribers.add("pat@example.com", "", { confirmed: true }).subscriber;
    tok = store.subscribers.unsubscribeToken(sub);
  });
  test("right tokens are never throttled, however often scanners follow them", async () => {
    for (let i = 0; i < 150; i++) assert.equal((await get(`/unsubscribe/${tok}/`)).status, 200);
    assert.equal((await get(`/subscribe/confirm/${"a".repeat(32)}/`)).status, 200);
  });
  test("token pages send Referrer-Policy same-origin, so their own forms post with an Origin", async () => {
    const res = await get(`/subscribe/confirm/${"c".repeat(32)}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
    const done = await post(`/subscribe/confirm/${"c".repeat(32)}/`, {});
    assert.notEqual(done.status, 403);
  });

});

describe("no inline styles in public pages (Q22)", () => {
  test("the stylesheet is a file; no <style> element and no style attribute on any page", async () => {
    for (const p of ["/", "/latest/", "/published-post/", "/plain-page/", "/category/projects/", "/authors/test-author/", "/search/?q=wiring", "/signin/", "/signup/", "/forgot/", "/no-such-page/", "/subscribe/confirm/" + "e".repeat(32) + "/"]) {
      const res = await get(p);
      const html = await res.text();
      assert.doesNotMatch(html, /<style[\s>]/i, p);
      assert.doesNotMatch(html, /\sstyle\s*=/i, p);
      assert.match(html, /<link rel="stylesheet" href="\/assets\/css\/site-[0-9a-f]{12}\.css">/, p);
    }
  });
  test("the stylesheet is served with its classes, cached for a year, and an old address still works", async () => {
    const html = await (await get("/")).text();
    const href = /href="(\/assets\/css\/site-[0-9a-f]{12}\.css)"/.exec(html)[1];
    const res = await get(href);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/css/);
    assert.match(res.headers.get("cache-control"), /immutable/);
    const css = await res.text();
    for (const cls of [".mt-18", ".btn-auto", ".av-96", ".page-body", ".prose-760", ".acc-btn", ".acc-btn-top", ".acc-note", ".cmt-notice"]) assert.ok(css.includes(cls), cls);
    assert.equal((await get(href, { headers: { "if-none-match": res.headers.get("etag") } })).status, 304);
    const old = await get("/assets/css/site-000000000000.css");
    assert.equal(old.status, 200);
    assert.equal(old.headers.get("cache-control"), "no-cache");
    assert.equal((await get("/assets/css/other-000000000000.css")).status, 404);
  });
  test("avatars use size classes", async () => {
    const html = await (await get("/published-post/")).text();
    assert.match(html, /class="av av-42"/);
    assert.match(html, /class="av av-72"/);
  });
  test("markdown, icons, highlighted code and ad slots carry no style attribute", () => {
    const md = createMarkdown({ siteHost: "example.com" });
    const html = md.render("```cpp\nint x = 1;\n```\n\n> [!NOTE]\n> hi\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![x](/media/a.png)\n\n## H\n");
    assert.doesNotMatch(html, /style=/);
    assert.doesNotMatch(iconSvg("search", 18) + brandSvg("github", 18), /style=/);
  });
});

describe("media headers (H-media-02) and ranges", () => {
  test("a picture a public post uses is revalidated after an hour; one nothing public uses is never stored", async () => {
    const open = await get("/media/2026/11/pub-aaaaaaaa.png");
    assert.equal(open.status, 200);
    assert.equal(open.headers.get("cache-control"), "public, max-age=3600, must-revalidate");
    assert.ok(open.headers.get("etag"));
    const closed = await get("/media/2026/11/priv-bbbbbbbb.png");
    assert.equal(closed.status, 200);
    assert.equal(closed.headers.get("cache-control"), "private, no-store");
    assert.equal(closed.headers.get("etag"), null);
  });
  test("a byte range is answered with 206 and a bad one with 416", async () => {
    const full = Buffer.from(await (await get("/media/2026/11/pub-aaaaaaaa.png")).arrayBuffer());
    const part = await get("/media/2026/11/pub-aaaaaaaa.png", { headers: { range: "bytes=0-9" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 0-9/${full.length}`);
    assert.equal(Buffer.from(await part.arrayBuffer()).compare(full.subarray(0, 10)), 0);
    const tail = await get("/media/2026/11/pub-aaaaaaaa.png", { headers: { range: "bytes=-5" } });
    assert.equal(tail.status, 206);
    assert.equal(Buffer.from(await tail.arrayBuffer()).compare(full.subarray(full.length - 5)), 0);
    assert.equal((await get("/media/2026/11/pub-aaaaaaaa.png", { headers: { range: `bytes=${full.length + 10}-` } })).status, 416);
    assert.equal((await get("/media/2026/11/pub-aaaaaaaa.png", { headers: { range: "bytes=abc" } })).status, 200);
  });
  test("a resized copy is found without scanning the table (N-167); a made-up variant is a 404", async () => {
    assert.equal((await get("/media/2026/11/pub-aaaaaaaa-640.webp")).status, 200);
    assert.equal((await get("/media/2026/11/pub-aaaaaaaa-999.webp")).status, 404);
    assert.equal((await get("/media/2026/11/nothing-zzzzzzzz-640.webp")).status, 404);
  });
});

describe("social images (N-092, N-102, R-172)", () => {
  test("the image is cached for an hour with an ETag, and 304 answers the check", async () => {
    const res = await get(`/og/post/${published.id}.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600, must-revalidate");
    const etag = res.headers.get("etag");
    assert.match(etag, /^W\/"[0-9a-f]{32}"$/);
    assert.equal((await get(`/og/post/${published.id}.png`, { headers: { "if-none-match": etag } })).status, 304);
  });
  test("the cache name is 128 bits of SHA-256", () => {
    assert.match(ogHash({ title: "x" }), /^[0-9a-f]{32}$/);
  });
});

describe("redirects without a trailing slash (N-121)", () => {
  test("a 410 and a redirect entered without the slash fire", async () => {
    store.redirects.save({ from_path: "/gone-page", to_path: "", status_code: 410 });
    store.redirects.save({ from_path: "/moved-page", to_path: "/latest/", status_code: 301 });
    assert.equal((await get("/gone-page")).status, 410);
    assert.equal((await get("/gone-page/")).status, 410);
    const r = await get("/moved-page");
    assert.equal(r.status, 301);
    assert.equal(r.headers.get("location"), "/latest/");
  });
});

describe("robots.txt (N-038) and counters", () => {
  test("sign-in, reset, verify and confirm pages are disallowed", async () => {
    const txt = await (await get("/robots.txt")).text();
    for (const p of ["/signin/", "/signup/", "/forgot/", "/reset/", "/verify/", "/subscribe/", "/unsubscribe/"]) assert.ok(txt.includes(`Disallow: ${p}`), p);
  });
  test("post views keep counting after many addresses (the table forgets the oldest, never freezes)", async () => {
    const before = store.posts.get(published.id).views;
    for (let i = 0; i < 5; i++) await get("/second-post/", { headers: { "x-forwarded-for": `10.1.1.${i}`, "user-agent": "Mozilla/5.0 Firefox" } });
    assert.ok(store.posts.get(published.id).views >= before);
  });
});

describe("source downloads (R-171)", () => {
  test("repeat downloads are served from memory and still 304", async () => {
    const a = await get("/published-post/source/main.ino");
    assert.equal(a.status, 200);
    const etag = a.headers.get("etag");
    assert.match(etag, /^"[0-9a-f]{32}"$/);
    assert.equal((await get("/published-post/source/main.ino", { headers: { "if-none-match": etag } })).status, 304);
    assert.equal((await get("/second-post/source/main.ino")).status, 404);
  });
});

describe("search (R-165, R-166)", () => {
  test("one-letter terms are left out and short ones are exact", () => {
    assert.equal(ftsQuery("a b esp32 led"), '"esp32"* "led"*');
    assert.equal(ftsQuery("a io"), '"io"');
    assert.equal(ftsQuery("one two three four five six seven eight").split(" ").length, 6);
  });
  test("search pages are limited per address even when the query repeats", async () => {
    ctx.limiters.search.reset("unknown");
    let last = 0;
    for (let i = 0; i < 100; i++) last = (await get("/search/?q=", { headers: { "x-forwarded-for": "3.3.3.3" } })).status;
    assert.equal(last, 429);
  });
});

describe("publish checks: the secret scan (H-editor-18, N-176)", () => {
  test("look-alike placeholders are real values; real placeholders are not", () => {
    const code = ['const char* a = "yourX";', 'const char* password = "enter1";', 'const char* ssid = "YOUR_WIFI_NAME";', 'char pass[] = "your password";', 'const char* t = "yourpassword";'].join("\n");
    const values = findSecrets(code).map((f) => f.value);
    assert.deepEqual(values, ["enter1"]);
    assert.ok(findSecrets('const char* password = "enter1";').length === 1);
    assert.equal(findSecrets('const char* a = "yourX";').length, 0, "not named like a credential");
    assert.equal(findSecrets('const char* password = "yourX";').length, 1);
  });
  test("a long value (a token) and a value on the next line are found", () => {
    assert.equal(findSecrets(`const char* token = "${"a".repeat(1500)}";`).length, 1);
    assert.equal(findSecrets('const char* password =\n  "hunter22hunter";').length, 1);
  });
  test("a very long line is scanned further and reported as partly checked", () => {
    const s = findSecrets(`${"x".repeat(250_000)}\npassword = "tooreal123";`);
    assert.deepEqual(s.skipped, [1]);
    assert.equal(s.length, 1);
  });
  test("a long run of spaces is not slow", () => {
    const t = Date.now();
    findSecrets(`password[${" ".repeat(60000)}]${" ".repeat(60000)}x "zzzz"`);
    assert.ok(Date.now() - t < 2000);
  });
});

describe("helpers", () => {
  test("isHttpUrl refuses forms browsers read differently (N-141)", () => {
    for (const v of ["https:evil.example", "http:\\\\host", "https:/evil.example", "https://exa\\mple.com", "HTTPS:evil"]) assert.equal(isHttpUrl(v), false, v);
    assert.equal(isHttpUrl("https://example.com/a?b=c#d"), true);
    assert.equal(isHttpUrl("HTTP://Example.com"), true);
  });
  test("a date that doesn't exist is '', never an error (N-112)", () => {
    assert.equal(localInputToIso("2026-13-45T25:61", "Asia/Kolkata"), "");
    assert.equal(localInputToIso("2026-02-31T10:00", "Asia/Kolkata"), "");
    assert.match(localInputToIso("2026-11-10T19:30", "Asia/Kolkata"), /^2026-11-10T14:00:00\.000Z$/);
    assert.equal(timestampToSeconds("9".repeat(400)), null);
    assert.equal(timestampToSeconds("1:02:03"), 3723);
    assert.equal(timestampToSeconds("1:2:3:4"), null);
  });
  test("icon helpers never put raw input into the markup (N-144)", () => {
    const svg = iconSvg("search", '18" onload="x', 'a" onclick="x');
    assert.doesNotMatch(svg, /on(?:load|click)=|"sonclick/);
    assert.match(svg, /width="18"/);
    assert.equal(iconSvg("constructor", 18).includes("function"), false);
    assert.match(iconSvg("down", 16, "chev"), /class="ic chev"/);
    assert.equal(brandSvg("__proto__", "9<").includes("<path d=\"\""), true);
  });
  test("a contact link with a query is not used (H-settings-06)", () => {
    const site = { s: { ads_enabled: true, ads_empty: "show", ads_contact_url: "mailto:a@b.co?bcc=x@y.co" }, url: { media: (p) => p } };
    const store2 = { ads: { live: () => ({}) }, media: { get: () => null } };
    const html = Object.values(renderSlots(store2, site)).join("");
    assert.doesNotMatch(html, /mailto|bcc/);
    site.s.ads_contact_url = "mailto:a@b.co";
    assert.match(Object.values(renderSlots(store2, site)).join(""), /href="mailto:a@b\.co"/);
  });
});

describe("structured data for video (N-041)", () => {
  const site = { origin: "https://example.com", blogUrl: "https://example.com", name: "S", title: "S", description: "d", lang: "en", abs: (p) => `https://example.com${p}` };
  const post = (video) => ({ url: "/p/", title: "T", excerpt: "e", crumbs: [{ name: "Home", url: "/" }], author: { name: "A", url: "/a/" }, videoInfo: video, publishedIso: "2026-01-01T00:00:00+05:30", updatedIso: "2026-01-01T00:00:00+05:30" });
  test("a bad id gives no video; bad dates and durations are left out; addresses are built from the id", () => {
    assert.equal(JSON.stringify(schema.postGraph(site, post({ id: "bad", title: "t" }))).includes("VideoObject"), false);
    const g = schema.postGraph(site, post({ id: "abcdefghijk", title: "t", description: "d", uploadDate: "not-a-date", duration: "soon", thumbnail: "javascript:x", watchUrl: "javascript:y", chapters: [{ name: "c", start: 5, end: 9, url: "javascript:z" }] }));
    const v = g["@graph"].find((n) => n["@type"] === "VideoObject");
    assert.equal(v.uploadDate, undefined);
    assert.equal(v.duration, undefined);
    assert.equal(v.embedUrl, "https://www.youtube.com/embed/abcdefghijk");
    assert.equal(v.contentUrl, "https://www.youtube.com/watch?v=abcdefghijk");
    assert.doesNotMatch(JSON.stringify(v), /javascript/);
    const ok = schema.postGraph(site, post({ id: "abcdefghijk", title: "t", description: "d", uploadDate: "2026-01-02", duration: "PT8M4S", chapters: [] }));
    assert.equal(ok["@graph"].find((n) => n["@type"] === "VideoObject").duration, "PT8M4S");
    assert.equal(ok["@graph"].find((n) => n["@type"] === "VideoObject").uploadDate, "2026-01-02");
  });
});

describe("newsletter text (R-089, N-175)", () => {
  const site = { title: "T", host: "example.com", abs: (p) => `https://example.com${p}`, url: { home: "/" }, business: { name: "Co" } };
  test("a picture from the same host but another scheme or port is dropped", () => {
    const body = "![a](https://example.com/media/a.png) ![b](http://example.com/media/b.png) ![c](https://example.com:8443/media/c.png)";
    const { html } = prepareNewsletter({ site, newsletter: { subject: "s", body_md: body }, posts: [] })("https://example.com/u/");
    assert.ok(html.includes("media/a.png"));
    assert.ok(!html.includes("media/b.png") && !html.includes("media/c.png"));
  });
  test("a long line of formatting marks is quick, and long addresses are not linked", () => {
    const t = Date.now();
    const body = `${"*a ".repeat(6000)}\n\n[x](https://example.com/${"q".repeat(3000)})`;
    const { text, html } = prepareNewsletter({ site, newsletter: { subject: "s", body_md: body }, posts: [] })("https://example.com/u/");
    assert.ok(Date.now() - t < 3000);
    assert.ok(typeof text === "string" && !html.includes("q".repeat(3000)));
  });
});

describe("syntax highlighting budget (R-170)", () => {
  test("one block over 20,000 characters, and code past 100,000 in total, is plain text", () => {
    const md = createMarkdown({ siteHost: "example.com" });
    const big = `int x = 1; // ${"a".repeat(25_000)}\n`;
    assert.doesNotMatch(md.render(`\`\`\`cpp\n${big}\`\`\`\n`, {}), /hljs-/);
    const block = `\`\`\`cpp\nint x = 1;\n${"// c\n".repeat(3000)}\`\`\`\n\n`;
    const html = md.render(block.repeat(10), {});
    const blocks = html.split('<div class="code">').slice(1);
    assert.equal(blocks.length, 10);
    assert.match(blocks[0], /hljs-/);
    assert.doesNotMatch(blocks[9], /hljs-(?!\s)[a-z]+">/);
  });
});

describe("stores follow-ups", () => {
  test("only the first three prefix words are prefix-matched (R-165)", () => {
    assert.equal(ftsQuery("alpha beta gamma delta"), '"alpha"* "beta"* "gamma"* "delta"');
  });
  test("a 40-hex unsubscribe token and an old 32-hex one both open the page", async () => {
    const sub = store.subscribers.add("hex40@example.com", "", { confirmed: true }).subscriber;
    const tok = store.subscribers.unsubscribeToken(sub);
    assert.match(tok, /^[0-9a-f]{40}$/);
    assert.equal((await get(`/unsubscribe/${tok}/`)).status, 200);
  });
  test("a post with no social or feature image uses the site's default image (N-146)", async () => {
    store.settings.set({ default_og_image_id: known.id });
    store.posts.save({ type: "post", status: "published", title: "No Pic", slug: "no-pic", author_id: author.id, excerpt: "x".repeat(80), published_at: past, body_md: "Text." }, { userId: author.id });
    const html = await (await get("/no-pic/")).text();
    assert.match(html, /<meta property="og:image" content="[^"]*\/media\/2026\/11\/pub-aaaaaaaa[^"]*">/);
    const withPic = await (await get("/published-post/")).text();
    assert.match(withPic, /og:image" content="[^"]*\/og\/post\//);
  });
});

// Last: it blocks the one shared test address from the token pages.
describe("token budget", () => {
  let tok;
  before(() => {
    tok = store.subscribers.unsubscribeToken(store.subscribers.getByEmail("pat@example.com"));
  });
  test("only wrong tokens use the budget", async () => {
    let last = 0;
    for (let i = 0; i < 70; i++) last = (await get(`/unsubscribe/${"9".repeat(32)}/`, { headers: { "x-forwarded-for": "7.7.7.7" } })).status;
    assert.equal(last, 429);
    assert.equal((await get(`/unsubscribe/${tok}/`)).status, 429, "one shared address, so the blocked sender is blocked");
    ctx.limiters.search.reset("unknown");
  });
});

describe("tables under the no-inline-style policy", () => {
  test("column alignment is a class, never a style attribute", () => {
    const html = createMarkdown({ siteHost: "example.com" }).render("| a | b | c | d |\n|:---|:-:|---:|---|\n| 1 | 2 | 3 | 4 |\n");
    assert.doesNotMatch(html, /style=/);
    assert.match(html, /<th class="ta-left">a<\/th>\n<th class="ta-center">b<\/th>\n<th class="ta-right">c<\/th>\n<th>d<\/th>/);
    assert.match(html, /<td class="ta-right">3<\/td>/);
    assert.match(fs.readFileSync(new URL("../assets/css/article.css", import.meta.url), "utf8"), /\.tbl-wrap \.ta-right\{text-align:right\}/);
  });
});
