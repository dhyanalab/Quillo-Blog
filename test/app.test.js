// End-to-end tests through the real app (no network): setup, auth, editor API, publishing checks,
// public pages, SEO output, redirects, scheduling, search, media and the newsletter. Run: npm test
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../src/web/app.js";
import { startScheduler } from "../src/services/scheduler.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-test-"));
const { app, ctx } = createApp({ dataDir, basePath: "/blog", siteUrl: "", outbound: false, production: true, setupToken: "test-setup", mailTransport: { jsonTransport: true }, mailDelayMs: 0 });

function jar() {
  const cookies = new Map();
  return {
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

// Requests come over HTTPS: the Site URL is https, and form posts must come from the same scheme and host.
async function req(j, p, { method = "GET", form, json, multipart, headers = {} } = {}) {
  const h = { origin: "https://localhost", cookie: j.header(), ...headers };
  let body;
  if (form) {
    body = new URLSearchParams(form);
    h["content-type"] = "application/x-www-form-urlencoded";
  }
  if (json) {
    body = JSON.stringify(json);
    h["content-type"] = "application/json";
  }
  if (multipart) body = multipart;
  const res = await app.request(`https://localhost${p}`, { method, headers: h, body, redirect: "manual" });
  j.store(res);
  return res;
}
const slugOf = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const field = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];
const csrfOf = (html) => (html.match(/data-csrf="([^"]+)"/) || [])[1];

const owner = jar();
let csrf = "";
const api = (j, p, json, token = csrf) => req(j, `/blog/admin/api${p}`, { method: "POST", json, headers: { "x-csrf-token": token } });

const POST = {
  type: "post",
  title: "Control an LED From Your Phone With ESP32",
  slug: "esp32-led-phone",
  excerpt: "Switch and dim an LED from your phone with an ESP32, a resistor and a free dashboard. Wiring, code and fixes.",
  body_md: "Intro paragraph with an [external link](https://www.espressif.com/) and [internal link](/blog/).\n\n## Wiring\n\n| Pin | Goes to |\n| --- | --- |\n| GPIO 23 | Resistor |\n\n## Code\n\n```cpp\nvoid setup() {}\n```\n\n> [!TIP]\n> A tip.\n\n<script>alert(1)</script>\n",
  quick_answer: "Wire GPIO 23 through a 220 Ω resistor to the LED, then upload the sketch.",
  at_a_glance: "Difficulty: Beginner\nBuild time: 10 minutes",
  tested_with: "IoT Studio 1.4.0",
  tags: "ESP32, LED",
  video_youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  video_title: "LED video",
  video_description: "The video.",
  video_upload: "2026-11-01T19:30",
  video_duration: "8:04",
  chapters: "0:00 The result\n0:15 Wiring",
};

before(async () => {
  let res = await req(owner, "/blog/admin/");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/blog/admin/setup");
  res = await req(owner, "/blog/admin/setup");
  const token = field(await res.text(), "_csrf");
  res = await req(owner, "/blog/admin/setup", { method: "POST", form: { _csrf: token, setup_token: "test-setup", site_title: "Test Blog", site_url: "https://example.com", timezone: "Asia/Kolkata", name: "Olive Owner", email: "owner@example.com", password: "correct horse battery" } });
  assert.equal(res.status, 302, await res.text());
  res = await req(owner, "/blog/admin/");
  assert.equal(res.status, 200);
  csrf = csrfOf(await res.text());
  assert.ok(csrf);
  // A category to publish into.
  res = await req(owner, "/blog/admin/categories", { method: "POST", form: { _csrf: csrf, name: "ESP32 Projects", slug: "", description: "ESP32 projects with code.", show_on_home: "1" } });
  assert.equal(res.status, 302);
  POST.category_id = String(ctx.store.categories.getBySlug("esp32-projects").id);
});

after(() => {
  ctx.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("setup and auth", () => {
  test("setup can't run twice", async () => {
    const res = await req(jar(), "/blog/admin/setup");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/blog/admin/login");
  });
  test("wrong password is refused, right one signs in", async () => {
    const j = jar();
    let res = await req(j, "/blog/admin/login");
    let token = field(await res.text(), "_csrf");
    res = await req(j, "/blog/admin/login", { method: "POST", form: { _csrf: token, email: "owner@example.com", password: "nope nope nope" } });
    assert.equal(res.status, 401);
    token = field(await res.text(), "_csrf");
    res = await req(j, "/blog/admin/login", { method: "POST", form: { _csrf: token, email: "OWNER@example.com", password: "correct horse battery", next: "/blog/admin/posts" } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/blog/admin/posts");
  });
  test("admin pages need a session", async () => {
    const res = await req(jar(), "/blog/admin/posts");
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location"), /\/blog\/admin\/login\?next=/);
    const apiRes = await api(jar(), "/posts", POST, "x");
    assert.equal(apiRes.status, 401);
  });
  test("API calls need the CSRF token and a same-site origin", async () => {
    assert.equal((await api(owner, "/posts", POST, "wrong")).status, 403);
    const cross = await req(owner, "/blog/admin/api/posts", { method: "POST", json: POST, headers: { "x-csrf-token": csrf, origin: "https://evil.example" } });
    assert.equal(cross.status, 403);
  });
});

describe("editor and publishing", () => {
  let id;
  test("a draft saves even when it isn't ready to publish", async () => {
    const res = await api(owner, "/posts", { ...POST, excerpt: "", intent: "save" });
    assert.equal(res.status, 201);
    const data = await res.json();
    id = data.post.id;
    assert.equal(data.post.state, "draft");
    assert.ok(data.checks.errors.some((e) => e.field === "excerpt"));
  });
  test("publishing is blocked by an editorial marker, with its line", async () => {
    const res = await api(owner, `/posts/${id}`, { ...POST, body_md: `${POST.body_md}\nPin 4 [CHECK: test] drives it.\n`, intent: "publish" });
    assert.equal(res.status, 422);
    const data = await res.json();
    const marker = data.checks.errors.find((e) => e.message.includes("[CHECK: test]"));
    assert.ok(marker, JSON.stringify(data.checks.errors));
    assert.ok(marker.line > 0);
    assert.equal(data.post.state, "draft");
  });
  test("a clean post publishes", async () => {
    const res = await api(owner, `/posts/${id}`, { ...POST, intent: "publish" });
    const data = await res.json();
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.post.state, "published");
  });
  test("an update that would break the live post is refused", async () => {
    const res = await api(owner, `/posts/${id}`, { ...POST, excerpt: "x".repeat(200), intent: "save" });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).saved, false);
  });
  test("the public post has the Preview markup and full SEO", async () => {
    const res = await req(jar(), "/blog/esp32-led-phone/");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>Control an LED From Your Phone With ESP32 \| Test Blog<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/blog\/esp32-led-phone\/">/);
    assert.match(html, /<meta name="robots" content="index, follow, max-image-preview:large/);
    assert.match(html, /<meta property="og:type" content="article">/);
    assert.match(html, /<meta property="og:image" content="https:\/\/example\.com\/blog\/og\/post\/\d+\.png\?v=/);
    assert.match(html, /<div class="tbl-wrap"><table>/);
    assert.match(html, /<pre><code class="lang-cpp hljs"><span class="hljs-function"><span class="hljs-type">void<\/span>/, "code is highlighted");
    assert.match(html, /class="callout callout-tip"/);
    assert.match(html, /href="https:\/\/www\.espressif\.com\/" target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "raw HTML in Markdown is escaped");
    assert.match(html, /Quick answer/);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
    const types = ld["@graph"].map((n) => n["@type"]);
    for (const t of ["BlogPosting", "VideoObject", "BreadcrumbList", "Person", "Organization", "WebSite"]) assert.ok(types.includes(t), `${t} in ${types}`);
    const video = ld["@graph"].find((n) => n["@type"] === "VideoObject");
    assert.equal(video.duration, "PT8M4S");
    assert.deepEqual(video.hasPart.map((c) => [c.startOffset, c.endOffset]), [[0, 15], [15, 484]]);
    assert.match(ld["@graph"][0].datePublished, /\+05:30$/);
  });
  test("security headers are set", async () => {
    const res = await req(jar(), "/blog/esp32-led-phone/");
    assert.match(res.headers.get("content-security-policy"), /script-src 'self' 'sha256-/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("strict-transport-security") || "", /max-age/);
  });
  test("lists, feeds, sitemap and robots include the post", async () => {
    for (const p of ["/blog/", "/blog/latest/", "/blog/category/esp32-projects/", "/blog/tag/esp32/", "/blog/authors/olive-owner/"]) {
      const res = await req(jar(), p);
      assert.equal(res.status, 200, p);
      assert.match(await res.text(), /esp32-led-phone/, p);
    }
    assert.match(await (await req(jar(), "/blog/rss.xml")).text(), /<link>https:\/\/example\.com\/blog\/esp32-led-phone\/<\/link>/);
    const sitemap = await (await req(jar(), "/sitemap.xml")).text();
    assert.match(sitemap, /<loc>https:\/\/example\.com\/blog\/esp32-led-phone\/<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    assert.match(sitemap, /<loc>https:\/\/example\.com\/blog\/category\/esp32-projects\/<\/loc>/);
    const robots = await (await req(jar(), "/robots.txt")).text();
    assert.match(robots, /User-agent: \*\nAllow: \/\nDisallow: \/blog\/admin\//);
    assert.match(robots, /Sitemap: https:\/\/example\.com\/blog\/sitemap\.xml/);
    const key = ctx.store.settings.get("indexnow_key");
    assert.equal(await (await req(jar(), `/blog/${key}.txt`)).text(), key);
  });
  test("search finds the post", async () => {
    const html = await (await req(jar(), "/blog/search/?q=dim%20led")).text();
    assert.match(html, /esp32-led-phone/);
    assert.match(html, /noindex/);
  });
  test("changing a live slug leaves a 301; deleting leaves a 410", async () => {
    let res = await api(owner, `/posts/${id}`, { ...POST, slug: "esp32-led-from-phone", intent: "save" });
    assert.equal(res.status, 200, await res.clone().text());
    res = await req(jar(), "/blog/esp32-led-phone/");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/blog/esp32-led-from-phone/");
    res = await api(owner, `/posts/${id}/delete`, {});
    assert.equal(res.status, 200);
    assert.equal((await req(jar(), "/blog/esp32-led-from-phone/")).status, 410);
    assert.equal((await req(jar(), "/blog/esp32-led-phone/")).status, 410);
  });
  test("a scheduled post stays hidden until its time", async () => {
    const future = new Date(Date.now() + 3600e3);
    const local = new Date(future.getTime() + 5.5 * 3600e3).toISOString().slice(0, 16);
    let res = await api(owner, "/posts", { ...POST, slug: "scheduled-post", published_at: local, intent: "publish" });
    const data = await res.json();
    assert.equal(data.post.state, "scheduled", JSON.stringify(data));
    assert.equal((await req(jar(), "/blog/scheduled-post/")).status, 404);
    ctx.db.prepare("UPDATE posts SET published_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), data.post.id);
    const sched = startScheduler(ctx, { intervalMs: 1e9 });
    sched.tick();
    sched.stop();
    assert.equal((await req(jar(), "/blog/scheduled-post/")).status, 200);
  });
});

describe("roles", () => {
  test("a contributor can draft but not publish", async () => {
    // Made in the store: one added from the Staff page must change its password before anything else.
    await ctx.store.users.create({ name: "Cara Contributor", email: "cara@example.com", role: "contributor", password: "contributor-pass-1" });
    let res;
    const j = jar();
    res = await req(j, "/blog/admin/login");
    const token = field(await res.text(), "_csrf");
    await req(j, "/blog/admin/login", { method: "POST", form: { _csrf: token, email: "cara@example.com", password: "contributor-pass-1" } });
    const c = csrfOf(await (await req(j, "/blog/admin/")).text());
    res = await api(j, "/posts", { ...POST, slug: "cara-draft", intent: "save" }, c);
    assert.equal(res.status, 201);
    const draftId = (await res.json()).post.id;
    res = await api(j, `/posts/${draftId}`, { ...POST, slug: "cara-draft", intent: "publish" }, c);
    assert.equal(res.status, 403);
    assert.equal((await req(j, "/blog/admin/settings")).status, 403);
  });
});

describe("media and newsletter", () => {
  test("images upload, get AVIF/WebP sizes and are served; unsafe SVG is refused", async () => {
    const png = await sharp({ create: { width: 1000, height: 600, channels: 3, background: "#6B4EFF" } }).png().toBuffer();
    let fd = new FormData();
    fd.append("file", new File([png], "Wiring Diagram.png", { type: "image/png" }));
    let res = await req(owner, "/blog/admin/api/media", { method: "POST", multipart: fd, headers: { "x-csrf-token": csrf } });
    assert.equal(res.status, 201, await res.clone().text());
    const { item } = await res.json();
    assert.match(item.url, /^\/blog\/media\/\d{4}\/\d{2}\/wiring-diagram-[0-9a-f]{16}\.png$/);
    const m = ctx.store.media.get(item.id);
    assert.deepEqual(m.variants.webp.map(([w]) => w), [400, 800, 1000]);
    res = await req(jar(), item.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    fd = new FormData();
    fd.append("file", new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], "x.svg", { type: "image/svg+xml" }));
    res = await req(owner, "/blog/admin/api/media", { method: "POST", multipart: fd, headers: { "x-csrf-token": csrf } });
    assert.equal(res.status, 400);
  });
  test("newsletter signup waits for the emailed confirmation; bad emails are refused", async () => {
    let res = await req(jar(), "/blog/subscribe", { method: "POST", form: { email: "reader@example.com", source: "/blog/" } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Check your inbox to confirm/);
    assert.equal(ctx.store.subscribers.all().find((s) => s.email === "reader@example.com").status, "pending");
    // The confirmation link opens a page with a button; only the button (POST) confirms.
    let mail;
    for (let i = 0; i < 50 && !(mail = ctx.mailer.outbox.find((m) => JSON.stringify(m.to).includes("reader@example.com"))); i++) await new Promise((r) => setTimeout(r, 20));
    const confirm = new URL(mail.html.match(/href="([^"]*\/subscribe\/confirm\/[^"]+)"/)[1]).pathname;
    const page = await req(jar(), confirm);
    assert.equal(page.status, 200);
    // Not "no-referrer": browsers then post the page's own button with "Origin: null", which the origin check refuses.
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    assert.equal(ctx.store.subscribers.all().find((s) => s.email === "reader@example.com").status, "pending", "opening the link doesn't confirm");
    res = await req(jar(), confirm, { method: "POST", form: {} });
    assert.ok(res.status < 400, `confirm: ${res.status}`);
    assert.equal(ctx.store.subscribers.all().find((s) => s.email === "reader@example.com").status, "active");
    res = await req(jar(), "/blog/subscribe", { method: "POST", form: { email: "not-an-email" } });
    assert.equal(res.status, 400);
    // Exports are form buttons (POST with the token); a plain link or image on another page can't start one.
    assert.equal((await req(owner, "/blog/admin/subscribers.csv")).headers.get("location"), "/blog/admin/newsletter/subscribers");
    assert.equal((await req(owner, "/blog/admin/newsletter/subscribers.csv")).headers.get("location"), "/blog/admin/newsletter/subscribers");
    const csv = await (await req(owner, "/blog/admin/newsletter/subscribers.csv", { method: "POST", form: { _csrf: csrf } })).text();
    assert.match(csv, /reader@example\.com/);
  });
});

describe("admin screens", () => {
  test("every admin screen renders for the owner", async () => {
    const postId = ctx.store.posts.getBySlug("post", "scheduled-post").id;
    const userId = ctx.store.users.getByEmail("owner@example.com").id;
    for (const p of ["/", "/posts", "/posts?state=draft", "/pages", "/posts/new", "/pages/new", `/posts/${postId}`, "/media", "/media?kind=file", "/categories", "/tags", "/comments", "/members", "/menus", "/ads", "/ads/new", "/users", "/users/new", `/users/${userId}`, "/redirects", "/newsletter", "/newsletter/new", "/newsletter/subscribers", "/newsletter/settings", "/analytics", "/settings"]) {
      const res = await req(owner, `/blog/admin${p}`);
      assert.equal(res.status, 200, `${p}: ${res.status}`);
      assert.equal(res.headers.get("cache-control"), "no-store", p);
    }
    // The software's name and version sit at the bottom of the admin sidebar.
    const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.match(await (await req(owner, "/blog/admin/")).text(), new RegExp(`<p class="adm-version">Quillo ${version.replace(/\./g, "\\.")}</p>`));
  });
  test("Preview renders unsaved content with the public template, never indexed", async () => {
    const payload = JSON.stringify({ ...POST, id: 0, title: "Unsaved Preview Title", body_md: "## Section\n\n[[TODO: photo]] goes here." });
    const res = await req(owner, "/blog/admin/preview", { method: "POST", form: { _csrf: csrf, payload } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<h1 id="post-title">Unsaved Preview Title<\/h1>/);
    assert.match(html, /class="preview-bar"/);
    assert.match(html, /<mark class="marker marker-todo">\[\[TODO: photo\]\]<\/mark>/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.equal(ctx.store.posts.getBySlug("post", slugOf("Unsaved Preview Title")), null, "preview doesn't save");
  });
  test("settings save and reach the public site", async () => {
    const res = await req(owner, "/blog/admin/settings", {
      method: "POST",
      form: { _csrf: csrf, site_title: "Renamed Blog", site_description: "New description.", site_url: "https://example.com", org_name: "IoT Studio", timezone: "Asia/Kolkata", posts_per_page: "12", link_network: "youtube", link_url: "iotstudio" },
    });
    assert.equal(res.status, 302, await res.clone().text());
    const seo = await req(owner, "/blog/admin/analytics", { method: "POST", form: { _csrf: csrf, analytics_provider: "none", ai_training: "block", indexnow_enabled: "1", google_verification: '<meta name="google-site-verification" content="abc123">' } });
    assert.equal(seo.status, 302, await seo.clone().text());
    const nav = [{ label: "Projects", url: "/blog/category/esp32-projects/", children: [{ label: "ESP32", url: "/blog/category/esp32-projects/" }] }, { label: "Bad link", url: "javascript:alert(1)" }];
    const menus = await req(owner, "/blog/admin/menus", { method: "POST", form: { _csrf: csrf, nav_mode: "custom", nav_json: JSON.stringify(nav), footer_mode: "auto", footer_json: "[]" } });
    assert.equal(menus.status, 302, await menus.clone().text());
    const html = await (await req(jar(), "/blog/")).text();
    assert.match(html, /<title>Renamed Blog<\/title>/);
    assert.match(html, /<meta name="google-site-verification" content="abc123">/);
    assert.match(html, /<summary>Projects/);
    assert.doesNotMatch(html, /javascript:alert/, "unsafe menu links are dropped");
    assert.match(html, /"sameAs":\["https:\/\/www\.youtube\.com\/@iotstudio"\]/);
    assert.match(await (await req(jar(), "/robots.txt")).text(), /User-agent: GPTBot\nDisallow: \//);
  });
  test("a category rename keeps the old URL working", async () => {
    const cat = ctx.store.categories.getBySlug("esp32-projects");
    const res = await req(owner, `/blog/admin/categories/${cat.id}`, { method: "POST", form: { _csrf: csrf, name: "ESP32", slug: "esp32", description: "ESP32 projects.", show_on_home: "1" } });
    assert.equal(res.status, 302);
    const old = await req(jar(), "/blog/category/esp32-projects/");
    assert.equal(old.status, 301);
    assert.equal(old.headers.get("location"), "/blog/category/esp32/");
  });
});

describe("newsletter and analytics", () => {
  test("pasted addresses are added once; a newsletter goes to each active subscriber with a one-click unsubscribe", async () => {
    let res = await req(owner, "/blog/admin/newsletter/subscribers/add", { method: "POST", form: { _csrf: csrf, emails: "Ann <ann@example.com>, bob@example.com\nann@example.com; not-an-email" } });
    assert.equal(res.status, 302, await res.clone().text());
    assert.match(res.headers.get("location"), /added=2/);
    const active = ctx.store.subscribers.count();

    const post = ctx.store.posts.listPublic({ limit: 1 })[0];
    const draft = { _csrf: csrf, subject: "New projects this month", preheader: "Two builds", body_md: "Hi! See [the blog](https://example.com/).", post_ids: String(post.id) };
    res = await req(owner, "/blog/admin/newsletter/new", { method: "POST", form: { ...draft, action: "preview" } });
    assert.match(await res.text(), /New projects this month[\s\S]*Read more/);
    assert.equal(ctx.store.newsletters.list().length, 0, "preview doesn't save");

    res = await req(owner, "/blog/admin/newsletter/new", { method: "POST", form: { ...draft, action: "test", test_to: "owner@example.com" } });
    assert.equal(res.status, 302, await res.clone().text());
    const id = Number(res.headers.get("location").match(/newsletter\/(\d+)/)[1]);
    assert.equal(ctx.mailer.outbox.at(-1).subject, "[Test] New projects this month");

    ctx.mailer.outbox.length = 0;
    res = await req(owner, `/blog/admin/newsletter/${id}`, { method: "POST", form: { ...draft, action: "send" } });
    assert.equal(res.status, 302, await res.clone().text());
    await ctx.newsletter.idle();
    const n = ctx.store.newsletters.get(id);
    assert.equal(n.status, "sent");
    assert.equal(n.sent_n, active);
    assert.equal(ctx.mailer.outbox.length, active);
    const mail = ctx.mailer.outbox.find((m) => JSON.stringify(m.to).includes("bob@example.com"));
    const unsub = mail.headers["List-Unsubscribe"].slice(1, -1);
    assert.equal(mail.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.ok(mail.html.includes(unsub) && mail.html.includes(post.title));

    // The link opens a confirmation page; inbox providers' one-click POST needs no form token.
    const path = new URL(unsub).pathname;
    res = await req(jar(), path);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /b\*\*\*@example\.com/, "the address is masked");
    res = await app.request(`https://localhost${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    assert.equal(res.status, 200);
    assert.equal(ctx.store.subscribers.list({ q: "bob@" }).rows[0].status, "unsubscribed");
    assert.equal((await req(jar(), "/blog/unsubscribe/0123456789abcdef0123456789abcdef/")).status, 404);
    assert.equal(ctx.store.subscribers.count(), active - 1);
    // A sent newsletter can't be edited.
    await req(owner, `/blog/admin/newsletter/${id}`, { method: "POST", form: { ...draft, subject: "Changed", action: "save" } });
    assert.equal(ctx.store.newsletters.get(id).subject, "New projects this month");
  });

  test("pasting an analytics code adds the tracker to public pages and allows it in the security policy only there", async () => {
    const umami = '<script defer src="https://cloud.umami.is/script.js" data-website-id="4f1c6b2e-1234-4abc-9def-0123456789ab"></script>';
    let res = await req(owner, "/blog/admin/analytics", { method: "POST", form: { _csrf: csrf, analytics_provider: "none", analytics_code: umami, ai_training: "allow" } });
    assert.equal(res.status, 302, await res.clone().text());
    res = await req(jar(), "/blog/");
    assert.match(await res.text(), /<script defer src="https:\/\/cloud\.umami\.is\/script\.js" data-website-id="4f1c6b2e-1234-4abc-9def-0123456789ab"><\/script>/);
    assert.match(res.headers.get("content-security-policy"), /script-src [^;]*https:\/\/cloud\.umami\.is.*connect-src 'self' https:\/\/cloud\.umami\.is https:\/\/gateway\.umami\.is/);
    assert.doesNotMatch((await req(owner, "/blog/admin/")).headers.get("content-security-policy"), /umami/);

    res = await req(owner, "/blog/admin/analytics", { method: "POST", form: { _csrf: csrf, analytics_provider: "umami", analytics_code: "<p>nothing here</p>" } });
    assert.equal(res.status, 400);

    const plausible = '<script async src="https://plausible.io/js/pa-AbC123xyz.js"></script>\n<script>window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()</script>';
    await req(owner, "/blog/admin/analytics", { method: "POST", form: { _csrf: csrf, analytics_provider: "none", analytics_code: plausible } });
    res = await req(jar(), "/blog/");
    const html = await res.text();
    assert.match(html, /<script async src="https:\/\/plausible\.io\/js\/pa-AbC123xyz\.js"><\/script>/);
    const inline = html.match(/<script>(window\.plausible[^<]+)<\/script>/)[1];
    const hash = (await import("node:crypto")).createHash("sha256").update(inline).digest("base64");
    assert.ok(res.headers.get("content-security-policy").includes(`'sha256-${hash}'`), "the init snippet is allowed by hash");

    await req(owner, "/blog/admin/analytics", { method: "POST", form: { _csrf: csrf, analytics_provider: "none" } });
    assert.doesNotMatch(await (await req(jar(), "/blog/")).text(), /plausible/);
  });
});

describe("URLs", () => {
  test("missing trailing slash redirects; unknown pages 404", async () => {
    let res = await req(jar(), "/blog/latest");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/blog/latest/");
    res = await req(jar(), "/blog/no-such-thing/");
    assert.equal(res.status, 404);
    assert.match(await res.text(), /Page not found/);
    assert.equal((await req(jar(), "/blog/latest/page/1/")).status, 301);
    assert.equal((await req(jar(), "/blog/latest/page/99/")).status, 404);
  });
  test("OG images render as PNG", async () => {
    const id = ctx.store.posts.getBySlug("post", "scheduled-post").id;
    const res = await req(jar(), `/blog/og/post/${id}.png?v=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.deepEqual([meta.width, meta.height], [1200, 630]);
  });
});

describe("two-step sign-in", () => {
  test("codes match the RFC 6238 test vector", async () => {
    const { base32Encode, codeAt } = await import("../src/web/totp.js");
    // RFC 6238 Appendix B, SHA1, T = 59 s (step 1): 94287082, so the 6-digit code is 287082.
    assert.equal(codeAt(base32Encode(Buffer.from("12345678901234567890")), 1), "287082");
  });
  test("turning it on needs the password and a code; then login asks for a code, once each", async () => {
    const { codeAt, stepAt } = await import("../src/web/totp.js");
    const login = async (j) => {
      // Every request here comes from one address, and its 10 tries in 15 minutes (codes included) never reset on success.
      ctx.limiters.login.reset("unknown");
      let res = await req(j, "/blog/admin/login");
      const token = field(await res.text(), "_csrf");
      return req(j, "/blog/admin/login", { method: "POST", form: { _csrf: token, email: "owner@example.com", password: "correct horse battery", next: "/blog/admin/posts" } });
    };
    // A second session, which turning it on must sign out.
    const other = jar();
    assert.equal((await login(other)).status, 302);

    // Opening the page creates nothing; "Start setup" makes the secret the QR code shows.
    let res = await req(owner, "/blog/admin/account/two-step");
    assert.doesNotMatch(await res.text(), /class="setup-key"/);
    res = await req(owner, "/blog/admin/account/two-step/start", { method: "POST", form: { _csrf: csrf } });
    assert.equal(res.status, 302);
    res = await req(owner, "/blog/admin/account/two-step");
    const html = await res.text();
    assert.match(html, /<svg[^>]*viewBox/);
    const secret = html.match(/<code class="setup-key">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, "");
    res = await req(owner, "/blog/admin/account/two-step/enable", { method: "POST", form: { _csrf: csrf, code: codeAt(secret, stepAt()), password: "wrong password here" } });
    assert.equal(res.status, 400, "the password is required");
    res = await req(owner, "/blog/admin/account/two-step/enable", { method: "POST", form: { _csrf: csrf, code: codeAt(secret, stepAt()), password: "correct horse battery" } });
    assert.equal(res.status, 200);
    const codesPage = await res.text();
    const codes = [...codesPage.matchAll(/<li><code>([A-Z2-7]{5}-[A-Z2-7]{5})<\/code><\/li>/g)].map((m) => m[1]);
    assert.equal(codes.length, 10);
    // Turning it on starts a fresh session (new cookie and form token), as a browser sees on the next page.
    csrf = csrfOf(codesPage) || csrfOf(await (await req(owner, "/blog/admin/")).text());
    assert.equal((await req(other, "/blog/admin/posts")).status, 302, "other sessions are signed out");
    assert.equal((await req(owner, "/blog/admin/posts")).status, 200, "this session stays");
    assert.ok(!JSON.stringify(ctx.store.users.get(ctx.store.users.getByEmail("owner@example.com").id)).includes(secret), "the secret never leaves the store");

    // The password alone no longer gives a session.
    const j = jar();
    res = await login(j);
    assert.equal(res.headers.get("location"), "/blog/admin/login/verify");
    assert.equal((await req(j, "/blog/admin/posts")).status, 302);
    res = await req(j, "/blog/admin/login/verify");
    let token = field(await res.text(), "_csrf");
    res = await req(j, "/blog/admin/login/verify", { method: "POST", form: { _csrf: token, code: "000000" } });
    assert.equal(res.status, 401);
    const next = codeAt(secret, stepAt() + 1);
    token = field(await res.text(), "_csrf");
    res = await req(j, "/blog/admin/login/verify", { method: "POST", form: { _csrf: token, code: next } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/blog/admin/posts");
    assert.equal((await req(j, "/blog/admin/posts")).status, 200);

    // The same code can't be used twice; a recovery code works once.
    const k = jar();
    await login(k);
    token = field(await (await req(k, "/blog/admin/login/verify")).text(), "_csrf");
    res = await req(k, "/blog/admin/login/verify", { method: "POST", form: { _csrf: token, code: next } });
    assert.equal(res.status, 401, "a used code is refused");
    token = field(await res.text(), "_csrf");
    res = await req(k, "/blog/admin/login/verify", { method: "POST", form: { _csrf: token, code: codes[0].toLowerCase() } });
    assert.equal(res.headers.get("location"), "/blog/admin/account/two-step?ok=recovery");
    const again = jar();
    await login(again);
    token = field(await (await req(again, "/blog/admin/login/verify")).text(), "_csrf");
    res = await req(again, "/blog/admin/login/verify", { method: "POST", form: { _csrf: token, code: codes[0] } });
    assert.equal(res.status, 401, "a recovery code works once");

    // Five wrong codes end the attempt. Wrong codes count per account across attempts, so start from zero.
    ctx.store.users.clearTotpFailures(ctx.store.users.getByEmail("owner@example.com").id);
    const bad = jar();
    await login(bad);
    for (let i = 0; i < 5; i++) {
      token = field(await (await req(bad, "/blog/admin/login/verify")).text(), "_csrf");
      res = await req(bad, "/blog/admin/login/verify", { method: "POST", form: { _csrf: token, code: "111111" } });
    }
    assert.match(await res.text(), /Too many wrong codes/);
    // The attempt stays open so the person can still use a recovery code, but app codes are refused for 15 minutes.
    token = field(await (await req(bad, "/blog/admin/login/verify")).text(), "_csrf");
    res = await req(bad, "/blog/admin/login/verify", { method: "POST", form: { _csrf: token, code: codeAt(secret, stepAt()) } });
    assert.equal(res.status, 429, "even the right app code waits out the lock");

    // Five wrong codes also lock the account's second step for 15 minutes; clear that to go on.
    ctx.store.users.clearTotpFailures(ctx.store.users.getByEmail("owner@example.com").id);

    // Turning it off needs the password and a code.
    res = await req(owner, "/blog/admin/account/two-step/disable", { method: "POST", form: { _csrf: csrf, code: codes[1], password: "correct horse battery" } });
    assert.equal(res.headers.get("location"), "/blog/admin/account/two-step?ok=twostepoff");
    csrf = csrfOf(await (await req(owner, "/blog/admin/")).text());
    assert.equal(ctx.store.users.twoStepStatus(ctx.store.users.getByEmail("owner@example.com").id).enabled, false);
    assert.equal((await login(jar())).headers.get("location"), "/blog/admin/posts", "password-only sign-in again");
  });
});
