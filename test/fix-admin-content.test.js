// Editor API, media, taxonomy, comments, menus, ads, redirects, newsletter, analytics, settings and the editor's client code
// after the security fixes. In-process, no network. Run: node --test test/fix-admin-content.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createApp } from "../src/web/app.js";

const A = "/admin";
const PW = "correct horse battery";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

let ipCounter = 0;
const freshIp = () => `10.7.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

// A fresh app (own data folder) with an owner, then helpers to sign in as staff of every role.
async function makeApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-fix-content-"));
  const { app, ctx } = createApp({ dataDir, production: true, outbound: false, mailTransport: { jsonTransport: true }, mailDelayMs: 0, setupToken: "test-setup", trustProxy: true });
  const t = { app, ctx };
  t.req = async (j, p, { method = "GET", form, json, multipart, headers = {} } = {}) => {
    const h = { origin: "http://localhost", cookie: j.header(), "x-forwarded-for": j.ip || "198.51.100.1", ...headers };
    let body;
    if (form) {
      body = new URLSearchParams(form);
      h["content-type"] = "application/x-www-form-urlencoded";
    }
    if (json !== undefined) {
      body = JSON.stringify(json);
      h["content-type"] = "application/json";
    }
    if (multipart) body = multipart;
    const res = await app.request(`http://localhost${p}`, { method, headers: h, body, redirect: "manual" });
    j.store(res);
    return res;
  };
  t.newJar = () => Object.assign(jar(), { ip: freshIp() });
  const field = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];
  const csrfOf = (html) => (html.match(/data-csrf="([^"]+)"/) || [])[1];
  t.signIn = async (email, password = PW) => {
    const j = t.newJar();
    let res = await t.req(j, `${A}/login`);
    const token = field(await res.text(), "_csrf");
    res = await t.req(j, `${A}/login`, { method: "POST", form: { _csrf: token, email, password } });
    assert.equal(res.status, 302, `sign in ${email}`);
    const page = await t.req(j, `${A}/users/${ctx.store.users.getByEmail(email).id}`);
    return { j, csrf: csrfOf(await page.text()), email };
  };
  t.post = (s, p, form) => t.req(s.j, `${A}${p}`, { method: "POST", form: { _csrf: s.csrf, ...form } });
  t.api = (s, p, json) => t.req(s.j, `${A}/api${p}`, { method: "POST", json, headers: { "x-csrf-token": s.csrf } });
  t.get = (s, p) => t.req(s.j, `${A}${p}`);
  t.upload = (s, name, buf, { path: p = "/api/media" } = {}) => {
    const fd = new FormData();
    fd.append("file", new File([buf], name, { type: "image/png" }));
    return t.req(s.j, `${A}${p}`, { method: "POST", multipart: fd, headers: { "x-csrf-token": s.csrf } });
  };

  const j = t.newJar();
  let res = await t.req(j, `${A}/setup`);
  const token = field(await res.text(), "_csrf");
  res = await t.req(j, `${A}/setup`, { method: "POST", form: { _csrf: token, setup_token: "test-setup", site_title: "Test Blog", site_url: "http://localhost", name: "Olive Owner", email: "owner@example.com", password: PW } });
  assert.equal(res.status, 302, await res.text());
  for (const [name, role] of [["Ada Admin", "admin"], ["Eve Editor", "editor"], ["Alan Author", "author"], ["Cara Contributor", "contributor"], ["Cleo Contributor", "contributor"]]) {
    await ctx.store.users.create({ name, email: `${name.split(" ")[0].toLowerCase()}@example.com`, role, password: PW });
  }
  t.owner = await t.signIn("owner@example.com");
  t.admin = await t.signIn("ada@example.com");
  t.editor = await t.signIn("eve@example.com");
  t.author = await t.signIn("alan@example.com");
  t.contrib = await t.signIn("cara@example.com");
  t.contrib2 = await t.signIn("cleo@example.com");
  t.user = (email) => ctx.store.users.getByEmail(email);
  // A post straight through the store (no publishing checks).
  t.makePost = (over = {}) => ctx.store.posts.save({ type: "post", title: "Some post", slug: `some-post-${++ipCounter}`, body_md: "Words.", status: "draft", author_id: t.user("alan@example.com").id, ...over }, { userId: t.user("alan@example.com").id });
  t.png = (w = 40, h = 30, color = "#6B4EFF") => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
  return t;
}

const t = await makeApp();
const { ctx } = t;
const BASE = { type: "post", title: "A draft", intent: "save", body_md: "Hello." };

describe("editor API: permissions and input", () => {
  test("a contributor cannot create tags; unknown names are dropped with a warning, an editor creates them", async () => {
    let res = await t.api(t.contrib, "/posts", { ...BASE, title: "Tag test", slug: "tag-test", tags: "Brand New Tag, Another" });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(ctx.store.tags.getBySlug("brand-new-tag"), null);
    assert.ok(data.checks.warnings.some((w) => w.field === "tags" && /brand new tag/i.test(w.message)), JSON.stringify(data.checks.warnings));
    res = await t.api(t.editor, "/posts", { ...BASE, title: "Tag test 2", slug: "tag-test-2", tags: "Brand New Tag" });
    assert.equal(res.status, 201);
    assert.ok(ctx.store.tags.getBySlug("brand-new-tag"));
    // Now the name exists, so the contributor can pick it.
    res = await t.api(t.contrib, "/posts", { ...BASE, title: "Tag test 3", slug: "tag-test-3", tags: "Brand New Tag" });
    const post = (await res.json()).post;
    assert.deepEqual(ctx.store.posts.tagsFor(post.id).map((x) => x.slug), ["brand-new-tag"]);
  });

  test("tag names over 60 characters are cut", async () => {
    await t.api(t.editor, "/posts", { ...BASE, title: "Long tag", slug: "long-tag", tags: "x".repeat(100) });
    assert.ok(ctx.store.tags.list().every((x) => x.name.length <= 60));
  });

  test("a refused publish creates no tags", async () => {
    const before = ctx.store.tags.list().length;
    // No title, nothing else: the publish checks fail, and the draft is saved, but the editor's own tag set is the only thing created.
    const res = await t.api(t.author, "/posts", { ...BASE, title: "Refused", slug: "refused-pub", intent: "publish", tags: "Never Made" });
    assert.equal(res.status, 422);
    assert.equal(ctx.store.tags.getBySlug("never-made"), null);
    assert.equal(ctx.store.tags.list().length, before);
  });

  test("featured, noindex, canonical URL and back-dating are for editors", async () => {
    const extras = { featured: true, noindex: true, canonical_url: "https://elsewhere.example/post", published_at: "2020-01-01T10:00" };
    let res = await t.api(t.contrib, "/posts", { ...BASE, title: "Extras", slug: "extras-c", ...extras });
    const c = ctx.store.posts.get((await res.json()).post.id);
    assert.equal(c.featured, false);
    assert.equal(c.noindex, false);
    assert.equal(c.canonical_url, "");
    assert.equal(c.published_at, null);
    res = await t.api(t.editor, "/posts", { ...BASE, title: "Extras", slug: "extras-e", ...extras });
    const e = ctx.store.posts.get((await res.json()).post.id);
    assert.equal(e.featured, true);
    assert.equal(e.noindex, true);
    assert.equal(e.canonical_url, "https://elsewhere.example/post");
    assert.ok(e.published_at.startsWith("2020-01-01"));
  });

  test("a lower role keeps the stored values of those fields on later saves", async () => {
    const p = t.makePost({ slug: "keeps-values", featured: true, noindex: true, canonical_url: "https://elsewhere.example/x", author_id: t.user("alan@example.com").id });
    const res = await t.api(t.author, `/posts/${p.id}`, { ...BASE, title: "Some post", slug: "keeps-values", featured: false, noindex: false, canonical_url: "" });
    assert.equal(res.status, 200);
    const after = ctx.store.posts.get(p.id);
    assert.equal(after.featured, true);
    assert.equal(after.noindex, true);
    assert.equal(after.canonical_url, "https://elsewhere.example/x");
  });

  test("canonical URL and GitHub link must be http(s); the YouTube id must be 11 characters", async () => {
    let res = await t.api(t.editor, "/posts", { ...BASE, title: "Urls", slug: "urls-1", canonical_url: "javascript:alert(1)", download_github: "mailto:a@b.co", video_youtube: "not-an-id/../x" });
    let data = await res.json();
    const p = ctx.store.posts.get(data.post.id);
    assert.equal(p.canonical_url, "");
    assert.equal(p.downloads.github, "");
    assert.deepEqual(p.video, {});
    assert.ok(data.checks.errors.some((e) => e.field === "canonical_url"));
    res = await t.api(t.editor, "/posts", { ...BASE, title: "Urls ok", slug: "urls-2", canonical_url: "https://example.org/a", download_github: "https://github.com/x/y", video_youtube: "https://youtu.be/dQw4w9WgXcQ" });
    data = await res.json();
    const q = ctx.store.posts.get(data.post.id);
    assert.equal(q.downloads.github, "https://github.com/x/y");
    assert.equal(q.video.youtube_id, "dQw4w9WgXcQ");
  });

  test("author_id: only an active person of the editor's rank or lower", async () => {
    const owner = t.user("owner@example.com");
    const author = t.user("alan@example.com");
    const res = await t.api(t.editor, "/posts", { ...BASE, title: "Byline", slug: "byline-1", author_id: owner.id });
    assert.notEqual(ctx.store.posts.get((await res.json()).post.id).author_id, owner.id);
    const res2 = await t.api(t.editor, "/posts", { ...BASE, title: "Byline 2", slug: "byline-2", author_id: author.id });
    assert.equal(ctx.store.posts.get((await res2.json()).post.id).author_id, author.id);
    ctx.store.users.update(author.id, { status: "suspended" }, { actor: "system" });
    const res3 = await t.api(t.editor, "/posts", { ...BASE, title: "Byline 3", slug: "byline-3", author_id: author.id });
    assert.notEqual(ctx.store.posts.get((await res3.json()).post.id).author_id, author.id);
    ctx.store.users.update(author.id, { status: "active" }, { actor: "system" });
  });

  test("a live post can only be changed or unpublished by someone who can publish", async () => {
    const cara = t.user("cara@example.com");
    const p = t.makePost({ slug: "live-by-cara", author_id: cara.id, status: "published", published_at: "2024-01-01T00:00:00.000Z" });
    let res = await t.api(t.contrib, `/posts/${p.id}`, { ...BASE, title: "Edited", slug: "live-by-cara" });
    assert.equal(res.status, 403);
    res = await t.api(t.contrib, `/posts/${p.id}`, { ...BASE, intent: "unpublish", slug: "live-by-cara" });
    assert.equal(res.status, 403);
    assert.equal(ctx.store.posts.get(p.id).status, "published");
    res = await t.api(t.editor, `/posts/${p.id}`, { ...BASE, title: "Edited by editor", slug: "live-by-cara" });
    assert.notEqual(res.status, 403);
  });

  test("a slug with an administrator's redirect is reserved for lower roles", async () => {
    await t.post(t.admin, "/redirects", { from_path: "/reserved-slug/", to_path: "/somewhere/", status_code: "301" });
    let res = await t.api(t.editor, "/posts", { ...BASE, title: "Reserved", slug: "reserved-slug" });
    const data = await res.json();
    assert.ok(data.checks.errors.some((e) => e.field === "slug"), JSON.stringify(data.checks.errors));
    assert.notEqual(ctx.store.posts.get(data.post.id).slug, "reserved-slug");
    // An administrator may use it, and saving never removes the redirect.
    res = await t.api(t.admin, "/posts", { ...BASE, title: "Reserved", slug: "reserved-slug" });
    assert.equal(ctx.store.posts.get((await res.json()).post.id).slug, "reserved-slug");
    assert.ok(ctx.store.redirects.list().some((r) => r.from_path.endsWith("/reserved-slug/")));
  });

  // The editor's own calls: a save through the JSON API, and the full-page preview (a form post). The unused /api/preview and
  // /api/checks endpoints are gone (see test/fix2-admin-content.test.js).
  test("save and preview: null body, size cap, and the edit permission", async () => {
    let res = await t.req(t.editor.j, `${A}/api/posts`, { method: "POST", json: null, headers: { "x-csrf-token": t.editor.csrf } });
    assert.equal(res.status, 400);
    const preview = (s, payload) => t.post(s, "/preview", { payload: JSON.stringify(payload) });
    res = await preview(t.editor, { body_md: "# Hello" });
    assert.equal(res.status, 200);
    const other = t.makePost({ slug: "someone-elses", author_id: t.user("cleo@example.com").id });
    res = await t.api(t.contrib, `/posts/${other.id}`, { id: other.id, body_md: "x" });
    assert.equal(res.status, 403);
    res = await preview(t.contrib, { id: other.id, body_md: "x" });
    assert.equal(res.status, 403);
  });

  test("a broken % in a link does not make a save fail", async () => {
    const res = await t.api(t.editor, "/posts", { ...BASE, title: "Broken percent", slug: "broken-percent", body_md: "[a](/blog/%E0%A4%A)" });
    assert.equal(res.status, 201);
  });

  test("delete rules, and the delete button on the posts list", async () => {
    const cara = t.user("cara@example.com");
    const draft = t.makePost({ slug: "cara-draft-del", author_id: cara.id });
    const everLive = t.makePost({ slug: "cara-ever-live", author_id: cara.id, status: "published", published_at: "2024-01-01T00:00:00.000Z" });
    ctx.store.posts.save({ ...ctx.store.posts.get(everLive.id), status: "draft" }, { id: everLive.id, userId: cara.id });
    let res = await t.api(t.contrib, `/posts/${everLive.id}/delete`, {});
    assert.equal(res.status, 403);
    const html = await (await t.get(t.contrib, "/posts")).text();
    assert.match(html, new RegExp(`/admin/posts/${draft.id}/delete`));
    assert.doesNotMatch(html, new RegExp(`/admin/posts/${everLive.id}/delete`));
    res = await t.post(t.contrib, `/posts/${draft.id}/delete`, {});
    assert.equal(res.status, 302);
    assert.equal(ctx.store.posts.get(draft.id), null);
    // Pages follow editPost: a contributor can't delete a page.
    const pg = t.makePost({ type: "page", slug: "a-page-del", author_id: cara.id });
    res = await t.post(t.contrib, `/pages/${pg.id}/delete`, {});
    assert.equal(res.status, 403);
    res = await t.post(t.editor, `/pages/${pg.id}/delete`, {});
    assert.equal(res.status, 302);
  });

  test("the posts list pager keeps the category and author filters", async () => {
    const cat = ctx.store.categories.save({ name: "Pager cat", slug: "pager-cat" });
    for (let i = 0; i < 31; i++) t.makePost({ slug: `pager-${i}`, category_id: cat.id });
    const html = await (await t.get(t.editor, `/posts?category=${cat.id}&author=${t.user("alan@example.com").id}`)).text();
    assert.match(html, new RegExp(`page=2[^"]*category=${cat.id}`));
    assert.match(html, new RegExp(`page=2[^"]*author=${t.user("alan@example.com").id}`));
  });

  test("the posts quota for people below editor", async () => {
    // 200 own posts is the cap; this only checks the route still answers normally under it.
    const res = await t.api(t.contrib2, "/posts", { ...BASE, title: "Quota ok", slug: "quota-ok" });
    assert.equal(res.status, 201);
  });
});

describe("media", () => {
  test("alt text: uploader or editor only, a missing field leaves it, long text is cut", async () => {
    const png = await t.png(41, 31, "#ff0000");
    let res = await t.upload(t.contrib, "Mine.png", png);
    assert.equal(res.status, 201, await res.clone().text());
    const mine = (await res.json()).item;
    res = await t.post(t.contrib, `/media/${mine.id}`, { alt: "My picture" });
    assert.equal(res.status, 302);
    assert.equal(ctx.store.media.get(mine.id).alt, "My picture");
    // Missing field: unchanged.
    res = await t.post(t.contrib, `/media/${mine.id}`, {});
    assert.equal(ctx.store.media.get(mine.id).alt, "My picture");
    // Someone else's media: not allowed. An editor may.
    res = await t.post(t.contrib2, `/media/${mine.id}`, { alt: "Hijacked" });
    assert.equal(res.status, 403);
    assert.equal(ctx.store.media.get(mine.id).alt, "My picture");
    res = await t.post(t.editor, `/media/${mine.id}`, { alt: "y".repeat(500) });
    assert.equal(ctx.store.media.get(mine.id).alt.length, 300);
  });

  test("people below editor see only their own uploads, in the library and the picker", async () => {
    const png = await t.png(42, 32, "#00ff00");
    const res = await t.upload(t.contrib, "Cara only.png", png);
    assert.equal(res.status, 201);
    const mine = (await res.json()).item;
    const theirs = await (await t.upload(t.contrib2, "Cleo only.png", await t.png(43, 33, "#0000ff"))).json();
    const list = await (await t.get(t.contrib, "/api/media?kind=image")).json();
    assert.ok(list.items.some((i) => i.id === mine.id));
    assert.ok(!list.items.some((i) => i.id === theirs.item.id));
    const all = await (await t.get(t.editor, "/api/media?kind=image")).json();
    assert.ok(all.items.some((i) => i.id === theirs.item.id));
    const page = await (await t.get(t.contrib, "/media")).text();
    assert.ok(!page.includes("Cleo only.png"));
  });

  test("more than 20 files in one request is refused", async () => {
    const png = await t.png(44, 34, "#abcdef");
    const fd = new FormData();
    for (let i = 0; i < 21; i++) fd.append("file", new File([png], `many-${i}.png`, { type: "image/png" }));
    fd.append("_csrf", t.editor.csrf);
    const res = await t.req(t.editor.j, `${A}/media`, { method: "POST", multipart: fd });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /at most 20 files/);
  });

  test("download files are for authors and above; a contributor may upload pictures", async () => {
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("%PDF-1.4\n%%EOF")], "Guide.pdf", { type: "application/pdf" }));
    const res = await t.req(t.contrib.j, `${A}/api/media`, { method: "POST", multipart: fd, headers: { "x-csrf-token": t.contrib.csrf } });
    assert.equal(res.status, 400);
  });

  test("the daily upload quota counts what a person uploaded in the last 24 hours", async () => {
    const cleo = t.user("cleo@example.com");
    for (let i = 0; i < 60; i++) {
      ctx.db.prepare("INSERT INTO media (path, original_name, mime, size, alt, variants, kind, uploaded_by, created_at) VALUES (?, 'q.png', 'image/png', 10, '', '{}', 'image', ?, ?)").run(`quota/q-${i}.png`, cleo.id, new Date().toISOString());
    }
    const res = await t.upload(t.contrib2, "One more.png", await t.png(45, 35, "#123456"));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /upload limit/);
  });

  test("a free-text ?error= is never shown, a known code is", async () => {
    let html = await (await t.get(t.editor, "/media?error=Your%20password%20expired.%20Call%20555")).text();
    assert.doesNotMatch(html, /password expired/);
    html = await (await t.get(t.editor, "/media?error=toomany")).text();
    assert.match(html, /at most 20 files/);
  });

  test("a file in use is refused with a message built on the server", async () => {
    const png = await t.png(46, 36, "#654321");
    const m = (await (await t.upload(t.editor, "Used.png", png)).json()).item;
    t.makePost({ slug: "uses-media", title: "Uses media", feature_image_id: m.id });
    const res = await t.post(t.editor, `/media/${m.id}/delete`, {});
    assert.equal(res.status, 409);
    assert.match(await res.text(), /Still used by/);
  });
});

describe("taxonomy, comments, ads", () => {
  test("categories nest one level only", async () => {
    const a = ctx.store.categories.save({ name: "Top A", slug: "top-a" });
    const b = ctx.store.categories.save({ name: "Child B", slug: "child-b", parent_id: a.id });
    // A category with children cannot move under another one.
    let res = await t.post(t.editor, `/categories/${a.id}`, { name: "Top A", slug: "top-a", parent_id: String(ctx.store.categories.save({ name: "Other", slug: "other-top" }).id) });
    assert.equal(res.status, 400);
    assert.equal(ctx.store.categories.get(a.id).parent_id, null);
    // A grandchild is refused.
    res = await t.post(t.editor, "/categories", { name: "Grand", slug: "grand", parent_id: String(b.id) });
    const g = ctx.store.categories.getBySlug("grand");
    assert.ok(!g || !g.parent_id);
  });

  test("comment moderation return path: only the comments page, CR/LF ignored", async () => {
    let res = await t.post(t.editor, "/comments/999/approve", { back: "/admin/comments?status=pending" });
    assert.equal(res.headers.get("location"), "/admin/comments?status=pending");
    res = await t.post(t.editor, "/comments/999/approve", { back: "/admin/commentsx" });
    assert.equal(res.headers.get("location"), "/admin/comments");
    res = await t.post(t.editor, "/comments/999/approve", { back: "/admin/comments\r\nSet-Cookie: x=1" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/admin/comments");
    res = await t.post(t.editor, "/comments/999/approve", { back: "//evil.example/admin/comments" });
    assert.equal(res.headers.get("location"), "/admin/comments");
  });

  test("ad places are looked up as own keys only", async () => {
    let res = await t.post(t.admin, "/ads/places/constructor/off", {});
    assert.equal(res.status, 404);
    res = await t.post(t.admin, "/ads/places/toString/off", {});
    assert.notEqual(res.status, 302);
  });

  test("the ads contact link: path, address or one mailto", async () => {
    for (const [v, ok] of [["/advertise/", true], ["//evil.example", false], ["https://example.com/a", true], ["mailto:a@example.com", true], ["mailto:a@example.com?cc=x@y.co", false], ["mailto:a@b.co,c@d.co", false]]) {
      const res = await t.post(t.admin, "/ads/settings", { ads_contact_url: v, ads_empty: "hide" });
      assert.equal(res.headers.get("location").includes("error=contact"), !ok, v);
    }
  });
});

describe("menus and redirects", () => {
  test("menu paths must be one local path or an http(s) address", async () => {
    const nav = [{ label: "Good", url: "/blog/about/" }, { label: "Evil", url: "//evil.example" }, { label: "Back", url: "/\\evil.example" }, { label: "Ext", url: "https://example.org/x" }, { label: "Ctl", url: "/a\nb" }];
    const res = await t.post(t.admin, "/menus", { nav_mode: "custom", nav_json: JSON.stringify(nav), footer_mode: "auto", footer_json: "[]" });
    assert.equal(res.status, 302);
    const saved = ctx.store.settings.get("nav_items").map((i) => i.label);
    assert.deepEqual(saved, ["Good", "Ext"]);
  });

  test("redirect 'to' and 'from' are validated", async () => {
    for (const to of ["//evil.example/x", "/\\evil.example", "/a\r\nb", "javascript:alert(1)"]) {
      const res = await t.post(t.admin, "/redirects", { from_path: "/old-thing/", to_path: to, status_code: "301" });
      assert.equal(res.status, 400, to);
    }
    let res = await t.post(t.admin, "/redirects", { from_path: "/old-thing/", to_path: "/new-thing/", status_code: "301" });
    assert.equal(res.status, 302);
    res = await t.post(t.admin, "/redirects", { from_path: "/admin/x/", to_path: "/new-thing/", status_code: "301" });
    assert.equal(res.status, 400);
  });

  test("deleting a 410 notice says the address can be used again", async () => {
    const r = ctx.store.redirects.list().find((x) => x.from_path === "/old-thing/");
    ctx.store.redirects.save({ from_path: "/gone-thing/", to_path: "", status_code: 410 });
    const gone = ctx.store.redirects.list().find((x) => x.from_path === "/gone-thing/");
    const res = await t.post(t.admin, `/redirects/${gone.id}/delete`, {});
    assert.match(res.headers.get("location"), /ok=tombstone/);
    assert.ok(r);
  });
});

describe("newsletter and subscribers", () => {
  test("bulk add: split, validated, never reactivates, reports skipped", async () => {
    const sub = ctx.store.subscribers.add("gone@example.com", "x", { confirmed: true });
    ctx.store.subscribers.unsubscribe(sub.subscriber.id);
    ctx.store.subscribers.add("here@example.com", "x", { confirmed: true });
    const text = "new1@example.com, new2@example.com;gone@example.com\nhere@example.com bad@@example.com <named@example.com> \"quoted@example.com\"";
    const res = await t.post(t.admin, "/newsletter/subscribers/add", { emails: text });
    assert.equal(res.status, 302);
    const loc = res.headers.get("location");
    assert.match(loc, /added=4/);
    assert.match(loc, /skipped=1/);
    assert.match(loc, /unsub=1/);
    assert.match(loc, /invalid=1/);
    assert.equal(ctx.store.subscribers.list({ q: "gone@example.com" }).rows[0].status, "unsubscribed");
    assert.equal(ctx.store.subscribers.list({ q: "new1@example.com" }).rows[0].status, "active");
    const page = await (await t.req(t.admin.j, `${A}${loc.replace(A, "")}`)).text();
    assert.match(page, /Added 4 people/);
    assert.match(page, /unsubscribed earlier/);
  });

  test("bulk add: huge or hostile input is bounded", async () => {
    let res = await t.post(t.admin, "/newsletter/subscribers/add", { emails: "a@".repeat(200_001) });
    assert.equal(res.status, 400);
    const t0 = Date.now();
    res = await t.post(t.admin, "/newsletter/subscribers/add", { emails: "a@".repeat(90_000) });
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(res.status, 400);
  });

  test("free text in ?added= and ?skipped= is not shown", async () => {
    const html = await (await t.get(t.admin, "/newsletter/subscribers?added=Your%20account%20is%20locked&skipped=call%20555")).text();
    assert.doesNotMatch(html, /account is locked/);
    assert.match(html, /Added 0 people/);
  });

  test("an explicit Resubscribe brings an unsubscribed person back", async () => {
    const row = ctx.store.subscribers.list({ q: "gone@example.com" }).rows[0];
    const res = await t.post(t.admin, `/newsletter/subscribers/${row.id}/resubscribe`, {});
    assert.match(res.headers.get("location"), /ok=resubscribed/);
    assert.equal(ctx.store.subscribers.get(row.id).status, "active");
  });

  test("subscribers.csv guards formulas (tab, return, =), strips control characters", async () => {
    ctx.store.subscribers.add("csv1@example.com", "\t=1+1", { confirmed: true });
    ctx.store.subscribers.add("csv2@example.com", "\r=2+2", { confirmed: true });
    ctx.store.subscribers.add("csv3@example.com", "=HYPERLINK(1)", { confirmed: true });
    // The export is a form post with the security token; a plain GET only points at the page that has the button.
    assert.equal((await t.get(t.admin, "/newsletter/subscribers.csv")).status, 302);
    const text = await (await t.post(t.admin, "/newsletter/subscribers.csv", {})).text();
    assert.ok(!/"\t/.test(text) && !/"=/.test(text));
    assert.ok(/"'=HYPERLINK\(1\)"/.test(text));
    assert.ok(/csv1@example.com/.test(text));
  });

  test("the test email goes to your own address or one valid address, and is rate-limited", async () => {
    ctx.store.settings.set({ mail_from_email: "news@example.com", smtp_host: "smtp.example.com", smtp_user: "u", smtp_pass: "p" });
    const draft = ctx.store.newsletters.save({ subject: "Hello", preheader: "", body_md: "Hi", postIds: [] }, 0, t.admin ? t.user("ada@example.com").id : null);
    ctx.mailer.outbox.length = 0;
    let res = await t.post(t.admin, `/newsletter/${draft.id}`, { action: "test", subject: "Hello", body_md: "Hi", test_to: "" });
    assert.match(res.headers.get("location"), /ok=testsent/);
    assert.equal(ctx.mailer.outbox.at(-1).to[0].address, "ada@example.com");
    res = await t.post(t.admin, `/newsletter/${draft.id}`, { action: "test", subject: "Hello", body_md: "Hi", test_to: "a@example.com, b@example.com" });
    assert.equal(res.status, 400);
    // Only the person's own address or someone on the team: a stranger's address is refused.
    res = await t.post(t.admin, `/newsletter/${draft.id}`, { action: "test", subject: "Hello", body_md: "Hi", test_to: "friend@example.com" });
    assert.equal(res.status, 400);
    res = await t.post(t.admin, `/newsletter/${draft.id}`, { action: "test", subject: "Hello", body_md: "Hi", test_to: "eve@example.com" });
    assert.match(res.headers.get("location"), /ok=testsent/);
    let limited = false;
    for (let i = 0; i < 8; i++) {
      res = await t.post(t.admin, `/newsletter/${draft.id}`, { action: "test", subject: "Hello", body_md: "Hi", test_to: "" });
      if (res.status === 429) limited = true;
    }
    assert.ok(limited);
  });

  test("new + send is created once per form and lands on the saved draft", async () => {
    const before = ctx.store.newsletters.list().length;
    const form = { action: "send", subject: "Big news", body_md: "Hello all", nonce: "nonce-1" };
    const r1 = await t.post(t.admin, "/newsletter/new", form);
    const r2 = await t.post(t.admin, "/newsletter/new", form);
    assert.match(r1.headers.get("location"), /\/newsletter\/\d+\?ok=nlreview/);
    assert.equal(ctx.store.newsletters.list().length, before + 1);
    assert.equal(r2.status, 302);
    const id = Number(r1.headers.get("location").match(/newsletter\/(\d+)/)[1]);
    assert.equal(ctx.store.newsletters.get(id).status, "draft");
    // With the Site URL still localhost, sending is blocked with a plain message.
    const blocked = await t.post(t.admin, `/newsletter/${id}`, { action: "send", subject: "Big news", body_md: "Hello all" });
    assert.equal(blocked.status, 400);
    assert.match(await blocked.text(), /Site URL/);
    // With a public Site URL, sending the saved draft twice (a double click) only queues it once.
    ctx.store.settings.set({ site_url: "https://example.org" });
    const go = () => t.req(t.admin.j, `${A}/newsletter/${id}`, { method: "POST", form: { _csrf: t.admin.csrf, action: "send", subject: "Big news", body_md: "Hello all" }, headers: { origin: "https://example.org" } });
    try {
      const s1 = await go();
      const s2 = await go();
      assert.match(s1.headers.get("location"), /ok=sending/);
      assert.doesNotMatch(s2.headers.get("location"), /ok=sending/);
      await ctx.newsletter.idle();
    } finally {
      ctx.store.settings.set({ site_url: "http://localhost" });
      // Cookies are named for the address they were used on; sign in again on the plain-http address for the tests that follow.
      t.admin = await t.signIn("ada@example.com");
    }
  });

  test("the overview stops reloading itself for a newsletter stuck in 'sending'", async () => {
    const n = ctx.store.newsletters.save({ subject: "Stuck", preheader: "", body_md: "x", postIds: [] }, 0, null);
    ctx.db.prepare("UPDATE newsletters SET status = 'sending', sent_at = ?, updated_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", n.id);
    const html = await (await t.get(t.admin, "/newsletter")).text();
    assert.doesNotMatch(html, /http-equiv="refresh"/);
  });

  test("the unused subscribers template is gone", () => {
    assert.equal(fs.existsSync(path.join(ROOT, "views/admin/subscribers.njk")), false);
  });
});

describe("analytics, mail server and settings", () => {
  test("analytics is the owner's: an administrator's change is ignored", async () => {
    let res = await t.post(t.admin, "/analytics", { analytics_provider: "umami", analytics_script: "https://cloud.umami.is/script.js", analytics_id: "4f1c6b2e-1234-4abc-8def-0123456789ab", google_verification: "abc123" });
    assert.equal(res.status, 302);
    assert.equal(ctx.store.settings.get("analytics_provider"), "none");
    assert.equal(ctx.store.settings.get("google_verification"), "abc123");
    res = await t.post(t.owner, "/analytics", { analytics_provider: "umami", analytics_script: "https://cloud.umami.is/script.js", analytics_id: "4f1c6b2e-1234-4abc-8def-0123456789ab" });
    assert.equal(res.status, 302);
    assert.equal(ctx.store.settings.get("analytics_provider"), "umami");
  });

  test("analytics addresses: https, plain host, no tricks", async () => {
    const id = "4f1c6b2e-1234-4abc-8def-0123456789ab";
    for (const script of ["http://cloud.umami.is/script.js", "https://evil.example;script-src *", "https://a.example,https://b.example/x.js", "https://user:pw@cloud.umami.is/x.js", "https://cloud.umami.is/x.js'", "https://*.example/x.js"]) {
      const res = await t.post(t.owner, "/analytics", { analytics_provider: "umami", analytics_script: script, analytics_id: id, confirm_host: "1" });
      assert.equal(res.status, 400, script);
    }
    let res = await t.post(t.owner, "/analytics", { analytics_provider: "umami", analytics_script: "https://cloud.umami.is/script.js", analytics_host: "http://cloud.umami.is", analytics_id: id });
    assert.equal(res.status, 400);
    // Plausible: the save-time check matches the one used at render time.
    res = await t.post(t.owner, "/analytics", { analytics_provider: "plausible", analytics_script: "https://plausible.io/pa-1.js.evil", analytics_id: "" });
    assert.equal(res.status, 400);
    res = await t.post(t.owner, "/analytics", { analytics_provider: "plausible", analytics_script: "https://plausible.io/pa-abc123.js" });
    assert.equal(res.status, 302);
  });

  test("a tracker server that isn't Plausible's or Umami's needs a confirmation", async () => {
    const id = "4f1c6b2e-1234-4abc-8def-0123456789ab";
    let res = await t.post(t.owner, "/analytics", { analytics_provider: "umami", analytics_script: "https://stats.mysite.example/script.js", analytics_id: id });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /stats\.mysite\.example/);
    res = await t.post(t.owner, "/analytics", { analytics_provider: "umami", analytics_script: "https://stats.mysite.example/script.js", analytics_id: id, confirm_host: "1" });
    assert.equal(res.status, 302);
  });

  test("the mail server settings are the owner's; private hosts are refused", async () => {
    let res = await t.post(t.admin, "/newsletter/settings", { smtp_host: "smtp.changed.example", smtp_user: "x", mail_from_email: "news@example.com", mail_from_name: "News" });
    assert.equal(res.status, 302);
    assert.notEqual(ctx.store.settings.get("smtp_host"), "smtp.changed.example");
    for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "169.254.169.254", "2130706433", "intranet", "mail.internal"]) {
      res = await t.post(t.owner, "/newsletter/settings", { smtp_host: host, smtp_port: "25", mail_from_email: "news@example.com" });
      assert.equal(res.status, 400, host);
    }
    res = await t.post(t.owner, "/newsletter/settings", { smtp_host: "smtp.example.com", smtp_port: "587", smtp_user: "u", smtp_pass: "secret-pass", mail_from_email: "news@example.com" });
    assert.equal(res.status, 302);
  });

  test("changing the host or user removes the saved password; it is never in a page", async () => {
    ctx.store.settings.set({ smtp_host: "smtp.example.com", smtp_user: "u", smtp_pass: "super-secret-pass" });
    let html = await (await t.get(t.owner, "/newsletter/settings")).text();
    assert.ok(!html.includes("super-secret-pass"));
    for (const p of ["/settings", "/analytics", "/ads", "/menus"]) assert.ok(!(await (await t.get(t.owner, p)).text()).includes("super-secret-pass"), p);
    const res = await t.post(t.owner, "/newsletter/settings", { smtp_host: "smtp.other.example", smtp_port: "587", smtp_user: "u", mail_from_email: "news@example.com" });
    assert.match(res.headers.get("location"), /mailpasscleared/);
    assert.ok(!ctx.store.settings.getSecret("smtp_pass"));
    // Saving again with the same host and user and no password keeps whatever is there.
    ctx.store.settings.set({ smtp_pass: "kept-pass" });
    await t.post(t.owner, "/newsletter/settings", { smtp_host: "smtp.other.example", smtp_port: "587", smtp_user: "u", mail_from_email: "news@example.com" });
    assert.equal(ctx.store.settings.getSecret("smtp_pass"), "kept-pass");
    html = await (await t.get(t.owner, "/newsletter/settings")).text();
    assert.ok(!html.includes("kept-pass"));
  });

  test("values fixed by the environment show as locked and are not overwritten", async () => {
    const old = process.env.SMTP_HOST;
    process.env.SMTP_HOST = "smtp.fixed.example";
    try {
      const html = await (await t.get(t.owner, "/newsletter/settings")).text();
      assert.match(html, /smtp\.fixed\.example/);
      assert.match(html, /Fixed by the server/);
      await t.post(t.owner, "/newsletter/settings", { smtp_host: "smtp.typed.example", smtp_port: "587", mail_from_email: "news@example.com" });
      assert.notEqual(ctx.store.settings.get("smtp_host"), "smtp.typed.example");
    } finally {
      if (old === undefined) delete process.env.SMTP_HOST;
      else process.env.SMTP_HOST = old;
    }
  });

  test("the Site URL is the owner's", async () => {
    let res = await t.post(t.admin, "/settings", { site_title: "T", site_url: "https://evil.example" });
    assert.equal(res.status, 302);
    assert.notEqual(ctx.store.settings.get("site_url"), "https://evil.example");
    res = await t.post(t.owner, "/settings", { site_title: "T", site_url: "https://example.org" });
    assert.equal(res.status, 302);
    assert.equal(ctx.store.settings.get("site_url"), "https://example.org");
    // The origin check follows the Site URL, so put it back for the tests that come next.
    ctx.store.settings.set({ site_url: "http://localhost" });
  });

  test("settings: paths, contact email and images are checked", async () => {
    const ok = { site_title: "T" };
    for (const bad of [{ home_url: "//evil.example" }, { cta_download_url: "/\\evil.example" }, { cta_kit_url: "javascript:alert(1)" }, { contact_email: "a@b.co?cc=x@y.co" }, { contact_email: "a@b.co,c@d.co" }, { contact_email: "a&b=c@x.co?subject=1" }]) {
      const res = await t.post(t.admin, "/settings", { ...ok, ...bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    let res = await t.post(t.admin, "/settings", { ...ok, home_url: "/blog/", cta_download_url: "/download/", contact_email: "hello@example.com" });
    assert.equal(res.status, 302);
    // A download is not a picture.
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("%PDF-1.4\n%%EOF")], "Guide.pdf", { type: "application/pdf" }));
    const pdf = (await (await t.req(t.editor.j, `${A}/api/media`, { method: "POST", multipart: fd, headers: { "x-csrf-token": t.editor.csrf } })).json()).item;
    assert.equal(pdf.kind, "file");
    res = await t.post(t.admin, "/settings", { ...ok, logo_id: String(pdf.id) });
    assert.equal(res.status, 400);
    res = await t.post(t.admin, "/settings", { ...ok, default_og_image_id: "999999" });
    assert.equal(res.status, 400);
    const img = (await (await t.upload(t.editor, "Logo.png", await t.png(48, 38, "#222222"))).json()).item;
    res = await t.post(t.admin, "/settings", { ...ok, logo_id: String(img.id) });
    assert.equal(res.status, 302);
    assert.equal(ctx.store.settings.get("logo_id"), img.id);
  });

  test("a staff photo must be a picture", async () => {
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("%PDF-1.4\n%%EOF")], "Other.pdf", { type: "application/pdf" }));
    const pdf = (await (await t.req(t.editor.j, `${A}/api/media`, { method: "POST", multipart: fd, headers: { "x-csrf-token": t.editor.csrf } })).json()).item;
    const me = t.user("eve@example.com");
    await t.post(t.editor, `/users/${me.id}`, { name: "Eve Editor", email: "eve@example.com", slug: "eve-editor", photo_id: String(pdf.id) });
    assert.equal(t.user("eve@example.com").photo_id, null);
  });

  test("control characters in the settings form are removed", async () => {
    await t.post(t.admin, "/settings", { site_title: "Title\u0007 with\u0000 controls", site_description: "" });
    assert.equal(ctx.store.settings.get("site_title"), "Title with controls");
  });
});

describe("the editor's client code and the bundle", () => {
  const editorJs = fs.readFileSync(path.join(ROOT, "assets/js/editor.js"), "utf8");

  test("editor.js passes a sanitizer, captures elements first and falls back to Markdown", () => {
    assert.match(editorJs, /customHTMLSanitizer: sanitize/);
    // An explicit allow-list (no label, form controls, "for", tabindex or accesskey) instead of a profile with a deny-list.
    assert.match(editorJs, /ALLOWED_TAGS, ALLOWED_ATTR, FORBID_TAGS, FORBID_ATTR/);
    assert.match(editorJs, /const FORBID_ATTR = \["for", "form", "formaction", "accesskey", "tabindex", "id", "name", "style", "class"\]/);
    assert.doesNotMatch(editorJs, /USE_PROFILES/);
    assert.match(editorJs, /ALLOW_DATA_ATTR: false/);
    assert.match(editorJs, /window\.EditorPurify/);
    assert.ok(editorJs.indexOf("const fields = new Map()") < editorJs.indexOf("new window.ToastEditor"));
    assert.match(editorJs, /makeEditor\("markdown"\)/);
    assert.doesNotMatch(editorJs, /document\.getElementById\("(preview-form|src-tpl)"\)/);
  });

  test("the bundle matches its recorded hash, has the locked DOMPurify and no usage beacon", () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/build-editor.js"), "--verify"], { cwd: ROOT, encoding: "utf8" });
    assert.match(out, /matches its recorded sha256/);
    const bundle = fs.readFileSync(path.join(ROOT, "assets/vendor/toastui-editor.js"), "utf8");
    assert.match(bundle, /DOMPurify \d+\.\d+\.\d+/);
    assert.doesNotMatch(bundle, /UA-129966929/);
    assert.doesNotMatch(bundle, /version\s*=\s*["']2\.3\.3["']/);
  });

  test("the recorded hash is a sha256 of the committed file", () => {
    const rec = fs.readFileSync(path.join(ROOT, "assets/vendor/toastui-editor.sha256"), "utf8").trim().split(/\s+/)[0];
    assert.match(rec, /^[0-9a-f]{64}$/);
  });
});
