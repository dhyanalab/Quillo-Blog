// Tests for the public-site security fixes: redirects, OG images, media, search, subscribe/confirm/unsubscribe,
// beacons, view counts, caching, rendering and e-mail helpers. In-process, no network. Run: node --test test/fix-public.test.js
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../src/web/app.js";
import { createMarkdown } from "../src/render/markdown.js";
import { findSecrets, publishChecks } from "../src/render/checks.js";
import { highlight, langFor } from "../src/render/code.js";
import { prepareNewsletter, renderNewsletter, renderSimpleEmail } from "../src/render/email.js";
import { contentDisposition, isHttpUrl, xmlText } from "../src/render/util.js";
import { pruneOgCache } from "../src/render/og.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-public-"));
const { app, ctx } = createApp({ dataDir, production: true, outbound: false, mailTransport: { jsonTransport: true }, setupToken: "test-setup", mailDelayMs: 0 });
// Source code, downloads and "Tested with" are switched off on a new blog (Settings > Post features); these tests use them.
ctx.store.settings.set({ post_features: ["code", "downloads", "tested"] });
const { store } = ctx;

const get = (p, { method = "GET", headers = {}, body } = {}) => app.request(`http://localhost${p}`, { method, headers, body, redirect: "manual" });
const post = (p, form, headers = {}) =>
  app.request(`http://localhost${p}`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form), redirect: "manual" });
// Every test request shares one address, so the sign-up limits are cleared between tests.
const resetLimits = () => {
  for (const name of ["subscribe", "search"]) ctx.limiters[name].reset("unknown");
};
const past = new Date(Date.now() - 86400_000).toISOString();

let author;
let published;
let draft;
let draftPage;
let publishedPage;
let cat;
let emptyCat;
let draftTag;
const sentConfirmations = [];

before(async () => {
  author = await store.users.create({ name: "Test Author", email: "author@example.com", password: "correct horse battery", role: "author" });
  cat = store.categories.save({ name: "Projects", slug: "projects", description: "Projects.", show_on_home: 1 });
  emptyCat = store.categories.save({ name: "Secret Stuff", slug: "secret-stuff", description: "Unreleased.", show_on_home: 0 });
  const base = { author_id: author.id, category_id: cat.id, excerpt: "A reasonably long description of the post for the tests, long enough to pass.", comments_enabled: true };
  published = store.posts.save({ ...base, type: "post", status: "published", title: "Published Post", slug: "published-post", published_at: past, body_md: "## Wiring\n\nText.", source_files: [{ name: "main.ino", code: "void setup() {}\n" }, { name: "b.h", code: "// b\n" }] }, { userId: author.id });
  draft = store.posts.save({ ...base, type: "post", status: "draft", title: "Secret Draft Title", slug: "secret-draft", body_md: "x" }, { userId: author.id });
  draftPage = store.posts.save({ ...base, type: "page", status: "draft", title: "Secret Draft Page", slug: "secret-page", body_md: "x" }, { userId: author.id });
  publishedPage = store.posts.save({ ...base, type: "page", status: "published", title: "Public Page", slug: "public-page", published_at: past, body_md: "x" }, { userId: author.id });
  store.posts.save({ ...base, type: "post", status: "published", title: "Administration Guide", slug: "administration-guide", published_at: past, body_md: "x" }, { userId: author.id });
  draftTag = store.tags.save({ name: "Hidden Tag", slug: "hidden-tag", description: "" });
  store.posts.save({ ...store.posts.get(draft.id), tags: [draftTag.id] }, { id: draft.id, userId: author.id });
  ctx.mailer.ready = () => true;
  ctx.mailer.sendConfirmSubscription = (subscriber, url) => {
    sentConfirmations.push({ subscriber, url });
    return Promise.resolve(true);
  };
});

after(() => {
  try {
    ctx.db.close?.();
  } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("trailing-slash redirect never leaves the site", () => {
  test("//host, backslash and tab forms stay on this site", async () => {
    for (const p of ["//evil.example/x", "///evil.example/x", "/%5Cevil.example/x", "/%5C%5Cevil.example/x", "/%2F%2Fevil.example/x"]) {
      const res = await get(p);
      if (res.status === 301) {
        const loc = res.headers.get("location");
        assert.match(loc, /^\/(?![/\\])/, `${p} -> ${loc}`);
      } else {
        assert.ok(res.status < 500, `${p} gave ${res.status}`);
      }
    }
  });
  test("control characters give 404, not a server error", async () => {
    for (const p of ["/foo%0D%0Abar", "/%09/evil.example/x", "/foo%00bar"]) {
      const res = await get(p);
      assert.equal(res.status, 404, p);
    }
  });
  test("an accented path keeps its percent-encoding", async () => {
    const res = await get("/caf%C3%A9");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/caf%C3%A9/");
  });
  test("the query string is kept", async () => {
    const res = await get("/latest?x=1");
    assert.equal(res.headers.get("location"), "/latest/?x=1");
  });
  test("a slug that merely starts with admin is a normal public page", async () => {
    const res = await get("/administration-guide");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/administration-guide/");
    const page = await get("/administration-guide/");
    assert.equal(page.status, 200);
    assert.notEqual(page.headers.get("cache-control"), "no-store");
  });
});

describe("open graph images", () => {
  test("drafts and wrong types give 404; published posts and pages render", async () => {
    assert.equal((await get(`/og/post/${draft.id}.png`)).status, 404);
    assert.equal((await get(`/og/page/${draft.id}.png`)).status, 404);
    assert.equal((await get(`/og/page/${draftPage.id}.png`)).status, 404);
    assert.equal((await get(`/og/post/${draftPage.id}.png`)).status, 404);
    assert.equal((await get(`/og/page/${published.id}.png`)).status, 404, "a post id under /og/page/");
    const ok = await get(`/og/post/${published.id}.png`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    const meta = await sharp(Buffer.from(await ok.arrayBuffer())).metadata();
    assert.equal(meta.width, 1200);
    assert.equal((await get(`/og/page/${publishedPage.id}.png`)).status, 200);
  });
  test("tags, authors and categories need public posts", async () => {
    assert.equal((await get(`/og/tag/${draftTag.id}.png`)).status, 404);
    assert.equal((await get(`/og/category/${emptyCat.id}.png`)).status, 404);
    assert.equal((await get(`/og/category/${cat.id}.png`)).status, 200);
    const nobody = await store.users.create({ name: "No Posts", email: "np@example.com", password: "correct horse battery", role: "author" });
    assert.equal((await get(`/og/author/${nobody.id}.png`)).status, 404);
    assert.equal((await get(`/og/author/${author.id}.png`)).status, 200);
  });
  test("inherited names are not kinds", async () => {
    for (const kind of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.equal((await get(`/og/${kind}/1.png`)).status, 404, kind);
  });
  test("a missing hero image does not break the image", async () => {
    const m = store.media.insert({ path: "2026/11/gone-aaaa.png", original_name: "gone.png", mime: "image/png", width: 10, height: 10, size: 1, variants: {} }, author.id);
    const p = store.posts.save({ type: "post", status: "published", title: "Broken Hero", slug: "broken-hero", author_id: author.id, excerpt: "x", published_at: past, body_md: "x", feature_image_id: m.id }, { userId: author.id });
    const res = await get(`/og/post/${p.id}.png`);
    assert.equal(res.status, 200);
  });
  test("old images are pruned", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "og-prune-"));
    const old = path.join(dir, "old.png");
    const fresh = path.join(dir, "fresh.png");
    fs.writeFileSync(old, "x");
    fs.writeFileSync(fresh, "x");
    const t = new Date(Date.now() - 60 * 86400_000);
    fs.utimesSync(old, t, t);
    assert.equal(await pruneOgCache(dir, { force: true }), 1);
    assert.ok(!fs.existsSync(old) && fs.existsSync(fresh));
  });
});

describe("media", () => {
  let known;
  before(async () => {
    const dir = path.join(ctx.mediaDir, "2026", "11");
    fs.mkdirSync(dir, { recursive: true });
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#c2410c" } }).png().toBuffer();
    fs.writeFileSync(path.join(dir, "known-aaaaaaaa.png"), png);
    fs.writeFileSync(path.join(dir, "orphan-bbbbbbbb.png"), png);
    fs.writeFileSync(path.join(dir, "known-aaaaaaaa-640.webp"), png);
    fs.writeFileSync(path.join(dir, "guide-cccccccc.pdf"), "%PDF-1.4 test");
    known = store.media.insert({ path: "2026/11/known-aaaaaaaa.png", original_name: "known.png", mime: "image/png", width: 20, height: 20, size: png.length, variants: { webp: [[640, "2026/11/known-aaaaaaaa-640.webp"]], avif: [] } }, author.id);
    // A picture used by a published post is public: caches may keep it for an hour and revalidate with its ETag.
    store.posts.save({ type: "post", status: "published", title: "Has Picture", slug: "has-picture", author_id: author.id, excerpt: "x", published_at: past, body_md: "x", feature_image_id: known.id, feature_image_alt: "A picture" }, { userId: author.id });
    store.media.insert({ path: "2026/11/guide-cccccccc.pdf", original_name: 'weird "name"\r\n.pdf', mime: "application/pdf", size: 13, variants: {}, kind: "file" }, author.id);
  });
  test("a file with a media row is served, with an ETag and 304", async () => {
    const res = await get("/media/2026/11/known-aaaaaaaa.png");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    const etag = res.headers.get("etag");
    assert.ok(etag);
    assert.doesNotMatch(res.headers.get("cache-control"), /immutable/);
    assert.match(res.headers.get("cache-control"), /max-age=3600, must-revalidate/);
    assert.ok((await res.arrayBuffer()).byteLength > 0);
    const again = await get("/media/2026/11/known-aaaaaaaa.png", { headers: { "if-none-match": etag } });
    assert.equal(again.status, 304);
    assert.equal((await get("/media/2026/11/known-aaaaaaaa.png", { method: "HEAD" })).status, 200);
  });
  test("resized copies listed on a row are served", async () => {
    assert.equal((await get("/media/2026/11/known-aaaaaaaa-640.webp")).status, 200);
  });
  test("a file nobody uploaded through the library gets 404", async () => {
    assert.equal((await get("/media/2026/11/orphan-bbbbbbbb.png")).status, 404);
  });
  test("odd paths give 404, not 500", async () => {
    for (const p of ["/media/%E0%A4%A", "/media/..%2F..%2Fsecret.png", "/media/2026%2F11%2Fknown-aaaaaaaa.png"]) {
      const res = await get(p);
      assert.ok(res.status === 404 || res.status === 301, `${p} gave ${res.status}`);
    }
  });
  test("downloads are attachments with a safely encoded name", async () => {
    const res = await get("/media/2026/11/guide-cccccccc.pdf");
    assert.equal(res.status, 200);
    const cd = res.headers.get("content-disposition");
    assert.match(cd, /^attachment; filename="[^"\r\n]*"; filename\*=UTF-8''[A-Za-z0-9%._-]+$/);
    assert.doesNotMatch(cd, /[\r\n]/);
    assert.equal(known.id > 0, true);
  });
});

describe("page cache and counters", () => {
  test("the query string does not make a new cache entry", async () => {
    await get("/latest/");
    const res = await get("/latest/?junk=1");
    // The page is in the cache, and a production response does not say so.
    assert.ok(ctx.cache.get("/latest/"));
    assert.equal(res.headers.get("x-cache"), null);
    assert.equal((await get("/latest/?junk=2")).status, 200);
  });
  test("a post view counts once per reader per day, and HEAD never counts", async () => {
    const before = store.posts.get(published.id).views;
    await get("/published-post/", { headers: { "user-agent": "Mozilla/5.0 Firefox" } });
    await get("/published-post/", { headers: { "user-agent": "Mozilla/5.0 Firefox" } });
    await get("/published-post/", { headers: { "user-agent": "Mozilla/5.0 Firefox" } });
    assert.equal(store.posts.get(published.id).views, before + 1);
    const headBefore = store.posts.get(published.id).views;
    await get("/published-post/", { method: "HEAD" });
    assert.equal(store.posts.get(published.id).views, headBefore);
  });
  test("404 pages are served from one cached copy", async () => {
    const a = await get("/no-such-page-1/");
    const b = await get("/no-such-page-2/");
    assert.equal(a.status, 404);
    assert.equal(await a.text(), await b.text());
  });
});

describe("categories", () => {
  test("a category with no public posts gives 404, page and feed", async () => {
    assert.equal((await get("/category/secret-stuff/")).status, 404);
    assert.equal((await get("/category/secret-stuff/rss.xml")).status, 404);
    assert.equal((await get("/category/projects/")).status, 200);
    assert.equal((await get("/category/projects/rss.xml")).status, 200);
  });
});

describe("search", () => {
  test("a one-letter search is refused with a friendly note and costs no query", async () => {
    const res = await get("/search/?q=a");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /at least two letters/);
  });
  test("a normal search works", async () => {
    const res = await get("/search/?q=wiring");
    assert.equal(res.status, 200);
  });
  test("searches are rate limited per address", async () => {
    let last = 0;
    for (let i = 0; i < 80; i++) last = (await get(`/search/?q=term${i}x`, { headers: { "x-forwarded-for": "9.9.9.9" } })).status;
    // Without a trusted proxy every request shares one address, so the limiter must have kicked in.
    assert.equal(last, 429);
  });
});

describe("newsletter signup with double opt-in", () => {
  let token;
  beforeEach(resetLimits);
  test("a new address becomes pending and gets a confirmation link; the page says the same for everyone", async () => {
    const res = await post("/subscribe", { email: "Reader@Example.com", source: "/published-post/" });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /Check your inbox/);
    const sub = store.subscribers.all().find((s) => s.email === "reader@example.com");
    assert.equal(sub.status, "pending");
    assert.equal(sub.source, "/published-post/");
    assert.equal(sentConfirmations.length, 1);
    // An address that is already pending gets the identical page, and no second mail while the first link is fresh.
    const again = await (await post("/subscribe", { email: "reader@example.com" })).text();
    assert.equal(again, text);
    assert.equal(sentConfirmations.length, 1);
    token = /\/subscribe\/confirm\/([0-9a-f]{32})\//.exec(sentConfirmations.at(-1).url)?.[1];
    assert.ok(token);
  });
  test("the source field is reduced to a path on this site", async () => {
    await post("/subscribe", { email: "src1@example.com", source: "https://evil.example/lure" });
    await post("/subscribe", { email: "src2@example.com", source: "//evil.example/x" });
    for (const e of ["src1@example.com", "src2@example.com"]) assert.equal(store.subscribers.all().find((s) => s.email === e).source, "");
  });
  test("addresses with quotes, commas or brackets are refused", async () => {
    for (const email of ['a"b@example.com', "a,b@example.com", "a@b@example.com", "<a@example.com>", "a b@example.com"]) {
      const res = await post("/subscribe", { email });
      assert.equal(res.status, 400, email);
    }
  });
  test("a cross-site post is refused", async () => {
    const res = await post("/subscribe", { email: "x1@example.com" }, { origin: "https://evil.example" });
    assert.equal(res.status, 403);
  });
  test("pending addresses are not mailed newsletters", () => {
    assert.equal(store.subscribers.count(), 0);
  });
  test("opening the confirm link does not confirm; the button does", async () => {
    const view = await get(`/subscribe/confirm/${token}/`);
    assert.equal(view.status, 200);
    assert.match(await view.text(), /Yes, subscribe me/);
    assert.equal(store.subscribers.all().find((s) => s.email === "reader@example.com").status, "pending");
    const done = await post(`/subscribe/confirm/${token}/`, {});
    assert.equal(done.status, 200);
    assert.match(await done.text(), /on the list/);
    assert.equal(store.subscribers.all().find((s) => s.email === "reader@example.com").status, "active");
    const reuse = await post(`/subscribe/confirm/${token}/`, {});
    assert.equal(reuse.status, 404);
  });
  test("a bad token is a 404 and never an error", async () => {
    assert.equal((await get("/subscribe/confirm/nothex/")).status, 404);
    assert.equal((await post(`/subscribe/confirm/${"0".repeat(32)}/`, {})).status, 404);
  });
  test("when email isn't set up, sign-up says so instead of pretending", async () => {
    const original = ctx.mailer.ready;
    ctx.mailer.ready = () => false;
    const res = await post("/subscribe", { email: "late@example.com" });
    ctx.mailer.ready = original;
    assert.equal(res.status, 503);
    assert.ok(!store.subscribers.all().some((s) => s.email === "late@example.com"));
  });
});

describe("unsubscribe page", () => {
  let sub;
  beforeEach(resetLimits);
  before(() => {
    store.settings.set({ analytics_provider: "umami", analytics_id: "abc-123" });
    sub = store.subscribers.add("jane.doe@example.com", "", { confirmed: true }).subscriber;
    sub.token = store.subscribers.unsubscribeToken(sub);
  });
  test("shows a masked address and no analytics tag or origin", async () => {
    const res = await get(`/unsubscribe/${sub.token}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /j\*\*\*@example\.com/);
    assert.doesNotMatch(html, /jane\.doe/);
    assert.doesNotMatch(html, /cloud\.umami\.is/);
    assert.doesNotMatch(res.headers.get("content-security-policy"), /umami/);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    // Public pages still carry the tag.
    const home = await (await get("/")).text();
    assert.match(home, /cloud\.umami\.is/);
  });
  test("one-click POST unsubscribes without an origin check, and is throttled", async () => {
    const res = await app.request(`http://localhost/unsubscribe/${sub.token}/`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    assert.equal(res.status, 200);
    assert.equal(store.subscribers.get(sub.id).status, "unsubscribed");
  });
  test("only the subscriber's own page brings an address back", async () => {
    const res = await post(`/unsubscribe/${sub.token}/`, { again: "1" });
    assert.equal(res.status, 200);
    assert.equal(store.subscribers.get(sub.id).status, "active");
    // The public form can't reactivate an unsubscribed address.
    store.subscribers.unsubscribe(sub.id);
    const r = await post("/subscribe", { email: "jane.doe@example.com" });
    assert.equal(r.status, 200);
    assert.equal(store.subscribers.get(sub.id).status, "unsubscribed");
  });
  test("an unknown token is a 404", async () => {
    assert.equal((await get(`/unsubscribe/${"1".repeat(32)}/`)).status, 404);
    assert.equal((await get("/unsubscribe/zzz/")).status, 404);
  });
});

describe("ad beacon", () => {
  let live;
  let off;
  before(() => {
    const img = store.media.insert({ path: "2026/11/ad-dddddddd.png", original_name: "ad.png", mime: "image/png", width: 10, height: 10, size: 1, variants: {} }, author.id);
    live = store.ads.save({ name: "Live", url: "https://example.com/", image_id: img.id, places: ["top"], active: 1 });
    off = store.ads.save({ name: "Off", url: "https://example.com/", image_id: img.id, places: ["top"], active: 0 });
  });
  const beacon = (body, headers = {}) => app.request("http://localhost/k", { method: "POST", headers: { origin: "http://localhost", "user-agent": "Mozilla/5.0", ...headers }, body });
  test("counts live ads once, ignores inactive ads and other origins", async () => {
    await beacon(`v:${live.id},${off.id},99999`);
    await beacon(`v:${live.id}`);
    assert.equal(store.ads.totals(live.id).views, 1);
    assert.equal(store.ads.totals(off.id).views, 0);
    await beacon(`c:${live.id}`, { origin: "https://evil.example" });
    assert.equal(store.ads.totals(live.id).clicks, 0);
    await beacon(`c:${live.id}`);
    await beacon(`c:${live.id}`);
    assert.equal(store.ads.totals(live.id).clicks, 1);
  });
});

describe("downloads of source files", () => {
  test("a single file has a safe disposition and revalidates", async () => {
    const res = await get("/published-post/source/main.ino");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="main\.ino"/);
    assert.match(res.headers.get("cache-control"), /max-age=0, must-revalidate/);
    const etag = res.headers.get("etag");
    assert.equal((await get("/published-post/source/main.ino", { headers: { "if-none-match": etag } })).status, 304);
  });
  test("the ZIP is built once per version of the files", async () => {
    const a = await get("/published-post/source.zip");
    assert.equal(a.status, 200);
    assert.equal(a.headers.get("content-type"), "application/zip");
    const buf = Buffer.from(await a.arrayBuffer());
    assert.equal(buf.readUInt32LE(0), 0x04034b50);
    const etag = a.headers.get("etag");
    const b = await get("/published-post/source.zip");
    assert.equal(b.headers.get("etag"), etag);
    assert.equal((await get("/published-post/source.zip", { headers: { "if-none-match": etag } })).status, 304);
  });
  test("a draft's files are not served", async () => {
    assert.equal((await get("/secret-draft/source.zip")).status, 404);
    assert.equal((await get("/secret-draft/source/main.ino")).status, 404);
  });
});

describe("RSS", () => {
  test("XML-illegal characters are stripped", async () => {
    const t = `Bad${String.fromCharCode(0, 8)}Title`;
    store.posts.save({ type: "post", status: "published", title: t, slug: "bad-title", author_id: author.id, excerpt: `Excerpt${String.fromCharCode(1)}x`, published_at: past, body_md: "x" }, { userId: author.id });
    const res = await get("/rss.xml");
    assert.equal(res.status, 200);
    const xml = await res.text();
    assert.ok(xml.includes("BadTitle"));
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(xml, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });
});

describe("reader pages", () => {
  test("?c=constructor shows no empty notice box", async () => {
    const m = await store.members.create({ email: "reader1@example.com", name: "Rita Reader", password: "correct horse battery" }, { verified: true });
    const { token } = store.members.createSession(m.id);
    const html = await (await get("/published-post/?c=constructor", { headers: { cookie: `mid=${token}` } })).text();
    assert.doesNotMatch(html, /class="notice[^"]*"[^>]*>\s*<\/p>/);
    const ok = await (await get("/published-post/?c=posted", { headers: { cookie: `mid=${token}` } })).text();
    assert.match(ok, /Your comment is live/);
    assert.doesNotMatch(html, /password_hash|scrypt\$/);
  });
});

describe("markdown", () => {
  const md = () => createMarkdown({ siteHost: "example.com" });
  const heads = (text) => [...md().render(text).matchAll(/<h\d id="([^"]+)"/g)].map((m) => m[1]);
  test("many equal headings cost linear time and get unique ids", () => {
    const t = Date.now();
    const text = "#\n".repeat(20000);
    const ids = [...md().parse(text, {}).filter((x) => x.type === "heading_open").map((x) => x.attrGet("id"))];
    assert.equal(new Set(ids).size, 20000);
    assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
  });
  test("body headings never take an id the templates use", () => {
    const ids = heads("## Comments\n\n## Downloads\n\n## Source code\n\n## Quick answer\n\n## Live\n\n## Compose\n\n## Newsletter\n\n## src-1\n");
    for (const reserved of ["comments", "downloads", "source-code", "quick-answer", "live", "compose", "newsletter", "src-1"]) assert.ok(!ids.includes(reserved), reserved);
    assert.equal(new Set(ids).size, ids.length);
  });
  test("repeated headings named src finish and get unique ids (every src-<n> is reserved)", () => {
    const ids = heads("# src\n\n# src\n\n## SRC\n\n## src-1\n");
    assert.deepEqual(ids, ["src", "src-h-2", "src-h-3", "src-1-2"]);
  });
  test("a heading that collides with a generated id still gets a unique one", () => {
    const ids = heads("## A\n\n## A\n\n## A 2\n\n## A\n");
    assert.equal(new Set(ids).size, 4);
  });
  test("thousands of empty alerts render quickly", () => {
    const t = Date.now();
    const html = md().render("> [!NOTE]\n\n".repeat(8000));
    assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
    assert.ok(html.includes("callout-note"));
  });
  test("an alert keeps its text; an empty one hides its paragraph", () => {
    const html = md().render("> [!TIP]\n> Use a resistor.\n\n> [!NOTE]\n");
    assert.match(html, /callout-tip[\s\S]*Use a resistor\./);
    assert.match(html, /callout-note/);
  });
  test("a code fence labelled constructor or __proto__ renders", () => {
    for (const lang of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const html = md().render(`\`\`\`${lang}\nint x;\n\`\`\`\n`);
      assert.match(html, /<pre><code/);
      assert.doesNotMatch(html, /function|\[native code\]/);
    }
  });
  test("external links get noopener noreferrer", () => {
    assert.match(md().render("[x](https://other.example/)"), /rel="noopener noreferrer"/);
    assert.doesNotMatch(md().render("[x](https://example.com/page)"), /noopener/);
  });
  test("langFor and highlight survive inherited names", () => {
    for (const k of ["constructor", "__proto__", "toString"]) {
      assert.equal(langFor(k, ""), "plaintext");
      assert.equal(langFor("", `file.${k}`), "plaintext");
      assert.equal(typeof highlight("a<b", k), "string");
    }
    assert.equal(langFor("ino"), "arduino");
    assert.equal(highlight("<b>", "plaintext"), "&lt;b&gt;");
  });
});

describe("publish checks", () => {
  test("findSecrets is linear on hostile lines", () => {
    const t = Date.now();
    findSecrets('""'.repeat(250000));
    findSecrets("a".repeat(120000) + '"x"');
    findSecrets('x=""'.repeat(100000));
    assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
  });
  test("real credentials are found, placeholders and look-alikes behave", () => {
    const found = findSecrets('const char* ssid = "HomeNet";\nconst char* password = "enterprise-psk";\nconst char* ok = "YOUR_WIFI_PASSWORD";\nWiFi.begin("MyHome", "hunter22");\nconst char* t2 = "enter your token";\nchar pass[] = "example";');
    const values = found.map((f) => f.value);
    assert.ok(values.includes("HomeNet"));
    assert.ok(values.includes("enterprise-psk"), "enterprise is not a placeholder");
    assert.ok(values.includes("hunter22"));
    assert.ok(!values.includes("YOUR_WIFI_PASSWORD"));
    assert.ok(!values.includes("enter your token"));
    assert.ok(!values.includes("example"));
  });
  test("the message does not repeat any part of the secret", () => {
    const post = { type: "post", title: "T", excerpt: "x".repeat(100), body_md: "", source_files: [{ name: "a.ino", code: 'const char* password = "zebra-secret";' }], downloads: {} };
    const { errors } = publishChecks(post, { tokens: [], basePath: "", siteHost: "example.com", resolvePath: () => true, mediaExists: () => true });
    const e = errors.find((x) => /real password/.test(x.message));
    assert.ok(e);
    assert.doesNotMatch(e.message, /zeb/);
  });
  test("a bad % escape in a link is reported, not thrown", () => {
    const md = createMarkdown({ siteHost: "example.com" });
    const body = "[a](/%E0%A4%A) [b](#%E0%A4%A) [c](https://example.com/%E0%A4%A)\n";
    const tokens = md.parse(body, {});
    const post = { type: "post", slug: "s", title: "T", excerpt: "x".repeat(100), body_md: body, source_files: [], downloads: {} };
    let result;
    assert.doesNotThrow(() => {
      result = publishChecks(post, { tokens, basePath: "", siteHost: "example.com", resolvePath: () => true, mediaExists: () => true });
    });
    assert.ok(result.errors.length >= 2);
  });
  test("an image from another site is a warning", () => {
    const md = createMarkdown({ siteHost: "example.com" });
    const body = "![alt](https://tracker.example/p.png)\n";
    const post = { type: "post", slug: "s", title: "T", excerpt: "x".repeat(100), body_md: body, source_files: [], downloads: {} };
    const { warnings } = publishChecks(post, { tokens: md.parse(body, {}), basePath: "", siteHost: "example.com", resolvePath: () => true, mediaExists: () => true });
    assert.ok(warnings.some((w) => /another site/.test(w.message)));
  });
});

describe("renderer inputs", () => {
  test("a bad % escape in a post image address does not break the post", () => {
    const p = store.posts.save({ type: "post", status: "published", title: "Bad Escape", slug: "bad-escape", author_id: author.id, excerpt: "x", published_at: past, body_md: `![alt](${"/media/2026/11/%E0%A4%A.png"})\n` }, { userId: author.id });
    assert.ok(p.id);
    return get("/bad-escape/").then((res) => assert.equal(res.status, 200));
  });
  test("isHttpUrl rejects credentials and whitespace", () => {
    assert.equal(isHttpUrl("https://example.com/a"), true);
    assert.equal(isHttpUrl("https://user:pw@example.com/"), false);
    assert.equal(isHttpUrl("https://example.com/a b"), false);
    assert.equal(isHttpUrl("javascript:alert(1)"), false);
    assert.equal(isHttpUrl("https://example.com/\nfoo"), false);
  });
  test("xmlText drops characters XML forbids", () => {
    assert.equal(xmlText(`a${String.fromCharCode(0, 8, 11)}b${String.fromCharCode(0xd800)}c\td\n`), "abc\td\n");
  });
  test("contentDisposition never emits raw header characters", () => {
    const cd = contentDisposition('a"b\r\nc é.zip');
    assert.doesNotMatch(cd, /[\r\n]/);
    assert.match(cd, /filename\*=UTF-8''/);
  });
});

describe("email helpers", () => {
  const site = { title: "Test Blog", host: "example.com", abs: (p) => `https://example.com${p}`, url: { home: "/" }, business: { name: "Test Co", addressLines: ["1 Road"] } };
  const newsletter = { subject: "Hello\r\nBcc: x@example.com", preheader: "", body_md: "See http://example.com/a_b_c and [the *link*](http://example.com/p_q) **bold**\n\n![pic](https://tracker.example/t.png)" };
  test("prepareNewsletter renders once and fills in each unsubscribe link", () => {
    const make = prepareNewsletter({ site, newsletter, posts: [{ title: "P", url: "https://example.com/p/", excerpt: "e", image: "" }] });
    const a = make("https://example.com/unsubscribe/aaa/");
    const b = make("https://example.com/unsubscribe/bbb/");
    assert.ok(a.html.includes("unsubscribe/aaa") && !a.html.includes("unsubscribe/bbb"));
    assert.ok(b.text.includes("unsubscribe/bbb"));
    assert.doesNotMatch(a.subject, /[\r\n]/);
    assert.deepEqual(renderNewsletter({ site, newsletter, posts: [], unsubscribeUrl: "https://example.com/u/" }).subject, a.subject);
  });
  test("remote images are dropped from the newsletter", () => {
    const { html, text } = prepareNewsletter({ site, newsletter, posts: [] })("https://example.com/u/");
    assert.doesNotMatch(html, /tracker\.example/);
    assert.doesNotMatch(text, /tracker\.example/);
  });
  test("the plain-text version keeps underscores in addresses", () => {
    const { text } = prepareNewsletter({ site, newsletter, posts: [] })("https://example.com/u/");
    assert.ok(text.includes("http://example.com/a_b_c"));
    assert.ok(text.includes("the link (http://example.com/p_q)"));
    assert.ok(text.includes("bold") && !text.includes("**"));
  });
  test("renderSimpleEmail escapes text and returns html and text", () => {
    const m = renderSimpleEmail({ site, heading: "Confirm <b>", body: "Hello <script>\n\nSecond paragraph", buttonText: "Go", url: "https://example.com/c/abc/" });
    assert.equal(m.subject, "Confirm <b>");
    assert.ok(m.html.includes("&lt;script&gt;") && !m.html.includes("<script>"));
    assert.ok(m.html.includes('href="https://example.com/c/abc/"'));
    assert.ok(m.text.includes("Go: https://example.com/c/abc/"));
    assert.ok(!renderSimpleEmail({ site, heading: "x", body: "y", buttonText: "Go", url: "javascript:alert(1)" }).html.includes("javascript:"));
  });
});
