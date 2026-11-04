// Content administration after the second round of security fixes (audit run 3): editor saves, media references and uploads, comments,
// newsletter and subscribers, analytics and settings, the editor's client code and the editor build script.
// In-process, no network. Run: node --test test/fix2-admin-content.test.js
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


import MarkdownIt from "markdown-it";
import { AD_PLACES } from "../src/store/ads.js";

const adminSrc = fs.readFileSync(path.join(ROOT, "src/web/admin.js"), "utf8");
const editorJs = fs.readFileSync(path.join(ROOT, "assets/js/editor.js"), "utf8");
const tick = (ms = 6) => new Promise((r) => setTimeout(r, ms));

let extra = 0;
// A new signed-in person of a role (own rate-limit counters, own uploads).
async function newStaff(role) {
  const email = `extra${++extra}.${role}@example.com`;
  await ctx.store.users.create({ name: `Extra ${role} ${extra}`, email, role, password: PW });
  return t.signIn(email);
}
let pdfN = 0;
// Uploads through the JSON API; returns the parsed answer with its status.
async function up(s, name, buf) {
  const res = await t.upload(s, name, buf);
  return { status: res.status, ...(await res.json()) };
}
async function upPdf(s, name = "Guide.pdf") {
  const fd = new FormData();
  fd.append("file", new File([Buffer.from(`%PDF-1.4\n% unique ${++pdfN} ${Math.random()}\n%%EOF`)], name, { type: "application/pdf" }));
  const res = await t.req(s.j, `${A}/api/media`, { method: "POST", multipart: fd, headers: { "x-csrf-token": s.csrf } });
  return { status: res.status, ...(await res.json()) };
}
let pngN = 0;
const freshPng = () => t.png(40 + ++pngN, 30, `#${(0x100000 + pngN * 977).toString(16).padStart(6, "0")}`);
const capture = async (fn) => {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return lines;
};
const saved = async (res) => (await res.json()).post;

describe("editor saves", () => {
  test("comments on or off is for editors; a save that leaves it out keeps what is stored (H-staff-10)", async () => {
    let res = await t.api(t.author, "/posts", { ...BASE, title: "Comments flag", slug: "comments-flag", comments_enabled: false });
    const id = (await saved(res)).id;
    assert.equal(ctx.store.posts.get(id).comments_enabled, true, "an author can't switch comments off");
    await tick();
    res = await t.api(t.editor, `/posts/${id}`, { ...BASE, slug: "comments-flag", comments_enabled: false });
    assert.equal(ctx.store.posts.get(id).comments_enabled, false);
    await tick();
    await t.api(t.author, `/posts/${id}`, { ...BASE, slug: "comments-flag", comments_enabled: true });
    assert.equal(ctx.store.posts.get(id).comments_enabled, false, "an author can't switch them back on");
    await tick();
    await t.api(t.author, `/posts/${id}`, { ...BASE, slug: "comments-flag" });
    assert.equal(ctx.store.posts.get(id).comments_enabled, false, "a save without the key keeps the value");
    await tick();
    await t.api(t.editor, `/posts/${id}`, { ...BASE, slug: "comments-flag" });
    assert.equal(ctx.store.posts.get(id).comments_enabled, false);
    await tick();
    await t.api(t.editor, `/posts/${id}`, { ...BASE, slug: "comments-flag", comments_enabled: true });
    assert.equal(ctx.store.posts.get(id).comments_enabled, true);
  });

  test("a future publish date is accepted from non-editors only together with Publish (N-020)", async () => {
    const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 16);
    const res = await t.api(t.contrib, "/posts", { ...BASE, title: "Dated draft", slug: "dated-draft", published_at: future });
    const p = await saved(res);
    assert.equal(ctx.store.posts.get(p.id).published_at, null);
    const del = await t.req(t.contrib.j, `${A}/api/posts/${p.id}/delete`, { method: "POST", headers: { "x-csrf-token": t.contrib.csrf } });
    assert.equal(del.status, 200, "the writer can still delete their own draft");
    const ed = await t.api(t.editor, "/posts", { ...BASE, title: "Editor dated", slug: "editor-dated", published_at: future });
    assert.ok(ctx.store.posts.get((await saved(ed)).id).published_at, "an editor may date a draft");
  });

  test("a save after someone else's is refused with 409 (N-105, Q26)", async () => {
    const alan = t.user("alan@example.com");
    const post = t.makePost({ slug: "conflict-post", author_id: alan.id });
    await tick();
    let res = await t.api(t.author, `/posts/${post.id}`, { ...BASE, slug: "conflict-post", body_md: "one", loaded_modified_at: post.modified_at });
    assert.equal(res.status, 200);
    const v1 = (await saved(res)).version;
    assert.ok(v1.modified);
    await tick();
    res = await t.api(t.editor, `/posts/${post.id}`, { ...BASE, slug: "conflict-post", body_md: "two", loaded_modified_at: v1.modified });
    assert.equal(res.status, 200);
    await tick();
    res = await t.api(t.author, `/posts/${post.id}`, { ...BASE, slug: "conflict-post", body_md: "stale", loaded_modified_at: v1.modified });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /Someone else saved this post a moment ago\. Copy your changes, reload, and apply them again\./);
    assert.equal(ctx.store.posts.get(post.id).body_md, "two");
    assert.match(editorJs, /stale = true/);
    assert.match(editorJs, /!stale && state === "draft"/);
  });

  test("a key that is left out keeps the stored value; an empty one clears it (N-111)", async () => {
    const img = (await up(t.editor, "keep-me.png", await freshPng())).item;
    const cat = ctx.store.categories.save({ name: "Keep cat", slug: "keep-cat" });
    let res = await t.api(t.editor, "/posts", { ...BASE, title: "Keeper", slug: "keeper", feature_image_id: img.id, og_image_id: img.id, category_id: cat.id, tags: "", excerpt: "Stays" });
    const id = (await saved(res)).id;
    assert.equal(ctx.store.posts.get(id).feature_image_id, img.id);
    await tick();
    res = await t.api(t.editor, `/posts/${id}`, { type: "post", intent: "autosave", title: "Keeper" });
    const p = ctx.store.posts.get(id);
    assert.equal(p.feature_image_id, img.id);
    assert.equal(p.og_image_id, img.id);
    assert.equal(p.category_id, cat.id);
    assert.equal(p.excerpt, "Stays");
    assert.equal(p.slug, "keeper");
    assert.equal(p.body_md, "Hello.");
    await tick();
    await t.api(t.editor, `/posts/${id}`, { ...BASE, title: "Keeper", feature_image_id: "", og_image_id: "", category_id: "" });
    const q = ctx.store.posts.get(id);
    assert.equal(q.feature_image_id, null);
    assert.equal(q.og_image_id, null);
    assert.equal(q.category_id, null);
  });

  test("loosely typed values are not accepted as ids or languages (N-113)", async () => {
    const cat = ctx.store.categories.save({ name: "Loose cat", slug: "loose-cat" });
    const img = (await up(t.editor, "loose.png", await freshPng())).item;
    const res = await t.api(t.editor, "/posts", {
      ...BASE, title: "Loose", slug: "loose", category_id: [cat.id], feature_image_id: true, og_image_id: "0x" + img.id.toString(16),
      source_files: [{ name: "a.ino", lang: ["arduino"], code: "void setup() {}" }],
    });
    const p = ctx.store.posts.get((await saved(res)).id);
    assert.equal(p.category_id, null);
    assert.equal(p.feature_image_id, null);
    assert.equal(p.og_image_id, null);
    assert.equal(typeof p.source_files[0].lang, "string");
    // A digit string is fine.
    const ok = await t.api(t.editor, "/posts", { ...BASE, title: "Loose 2", slug: "loose-2", category_id: String(cat.id), feature_image_id: img.id });
    const q = ctx.store.posts.get((await saved(ok)).id);
    assert.equal(q.category_id, cat.id);
    assert.equal(q.feature_image_id, img.id);
    // The preview refuses an id that is not a whole number.
    for (const id of [[1], true, "0x1"]) {
      const r = await t.post(t.editor, "/preview", { payload: JSON.stringify({ id, body_md: "x" }) });
      assert.equal(r.status, 400, JSON.stringify(id));
    }
  });

  test("two source files with one name are refused (N-110)", async () => {
    const res = await t.api(t.editor, "/posts", { ...BASE, title: "Dupe files", slug: "dupe-files", source_files: [{ name: "main.ino", code: "a" }, { name: "Main.ino", code: "b" }] });
    const data = await res.json();
    assert.ok(data.checks.errors.some((e) => e.field === "source_files" && /two source files/.test(e.message)), JSON.stringify(data.checks.errors));
  });

  test("the unused /api/preview and /api/checks are gone; the full preview caps its payload (N-107, H-editor-05)", async () => {
    for (const p of ["/preview", "/checks"]) {
      const res = await t.api(t.editor, p, { body_md: "x" });
      assert.equal(res.status, 404, p);
    }
    let res = await t.post(t.editor, "/preview", { payload: JSON.stringify({ body_md: "# Hello" }) });
    assert.equal(res.status, 200);
    res = await t.post(t.editor, "/preview", { payload: JSON.stringify({ body_md: "x".repeat(3_100_000) }) });
    assert.equal(res.status, 413);
    // A body that is not a string is not rendered at all (it counts as left out).
    res = await t.post(t.editor, "/preview", { payload: JSON.stringify({ body_md: ["y".repeat(2_000_000)] }) });
    assert.equal(res.status, 200);
    assert.ok(!(await res.text()).includes("yyyyyyyyyy"));
  });

  test("at-a-glance rows are cut before they are processed (N-179)", async () => {
    const rows = Array.from({ length: 150_000 }, () => []);
    rows.push(["Difficulty", "Easy"]);
    const t0 = Date.now();
    const res = await t.api(t.editor, "/posts", { ...BASE, title: "Many rows", slug: "many-rows", at_a_glance: rows });
    assert.equal(res.status, 201);
    assert.ok(Date.now() - t0 < 5000);
    const good = Array.from({ length: 30 }, (_, i) => [`K${i}`, `V${i}`]);
    const r2 = await t.api(t.editor, "/posts", { ...BASE, title: "Rows", slug: "rows", at_a_glance: good });
    assert.ok(ctx.store.posts.get((await saved(r2)).id).at_a_glance.length <= 20);
  });

  test("link lookups per save are capped, with a note (N-168)", async () => {
    const body = Array.from({ length: 400 }, (_, i) => `[l](http://localhost/links-many/?n=${i})`).join("\n\n");
    const res = await t.api(t.editor, "/posts", { ...BASE, title: "Links", slug: "links-many", body_md: body });
    const data = await res.json();
    assert.equal(res.status, 201);
    assert.ok(data.checks.warnings.some((w) => /only the first 300 were checked/.test(w.message)), JSON.stringify(data.checks.warnings).slice(0, 400));
  });

  test("saves are limited per person, a person below editor keeps few older versions, and total text is capped (H-performance-13)", async () => {
    const s = await newStaff("contributor");
    let res = await t.api(s, "/posts", { ...BASE, title: "Versions", slug: "versions-x" });
    const id = (await saved(res)).id;
    for (let i = 0; i < 14; i++) {
      await tick(3);
      await t.api(s, `/posts/${id}`, { ...BASE, slug: "versions-x", body_md: `Version ${i}` });
    }
    assert.ok(ctx.store.posts.revisions(id).length <= 10, `${ctx.store.posts.revisions(id).length} versions`);
    // Text cap: a big post of their own through the store, then one more save.
    const me = ctx.store.users.getByEmail(s.email);
    t.makePost({ slug: "big-one", author_id: me.id, body_md: "x".repeat(19_990_000) });
    res = await t.api(s, "/posts", { ...BASE, title: "One more", slug: "one-more", body_md: "y".repeat(50_000) });
    assert.equal(res.status, 413);
    // Rate limit: far more than autosave would ever send.
    const f = await newStaff("contributor");
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      const r = await t.api(f, "/posts", { ...BASE, title: `Burst ${i}`, slug: `burst-${f.email}-${i}` });
      if (r.status === 429) limited++;
    }
    assert.ok(limited >= 5, `${limited} refused`);
  });
});

describe("media references and uploads", () => {
  test("a picture or file that is not yours is dropped (L-media-ref, R-094)", async () => {
    const eveImg = (await up(t.editor, "eve-private.png", await freshPng())).item;
    const caraImg = (await up(t.contrib, "cara-own.png", await freshPng())).item;
    let res = await t.api(t.contrib, "/posts", { ...BASE, title: "Foreign pic", slug: "foreign-pic", feature_image_id: eveImg.id, og_image_id: eveImg.id });
    let data = await res.json();
    const p = ctx.store.posts.get(data.post.id);
    assert.equal(p.feature_image_id, null);
    assert.equal(p.og_image_id, null);
    assert.ok(data.checks.errors.some((e) => e.message === "One picture or file isn't yours to use."), JSON.stringify(data.checks.errors));
    await tick();
    res = await t.api(t.contrib, `/posts/${p.id}`, { ...BASE, slug: "foreign-pic", feature_image_id: caraImg.id });
    assert.equal(ctx.store.posts.get(p.id).feature_image_id, caraImg.id, "their own upload is fine");
    // An editor may use any picture; what is already stored stays when the writer saves again.
    await tick();
    await t.api(t.editor, `/posts/${p.id}`, { ...BASE, slug: "foreign-pic", feature_image_id: eveImg.id });
    assert.equal(ctx.store.posts.get(p.id).feature_image_id, eveImg.id);
    await tick();
    await t.api(t.contrib, `/posts/${p.id}`, { ...BASE, slug: "foreign-pic", feature_image_id: String(eveImg.id) });
    assert.equal(ctx.store.posts.get(p.id).feature_image_id, eveImg.id, "a stored id is kept");
    // Something already public (here the site logo) may be used by anyone.
    const logo = (await up(t.editor, "the-logo.png", await freshPng())).item;
    ctx.store.settings.set({ logo_id: logo.id });
    await tick();
    await t.api(t.contrib, `/posts/${p.id}`, { ...BASE, slug: "foreign-pic", og_image_id: logo.id });
    assert.equal(ctx.store.posts.get(p.id).og_image_id, logo.id);
    ctx.store.settings.set({ logo_id: null });
  });

  test("hero and social images must be pictures; downloads must be files, and the author's own (R-094)", async () => {
    const pdf = (await upPdf(t.author)).item;
    assert.equal(pdf.kind, "file");
    let res = await t.api(t.author, "/posts", { ...BASE, title: "Pdf hero", slug: "pdf-hero", feature_image_id: pdf.id, og_image_id: pdf.id });
    let data = await res.json();
    assert.equal(ctx.store.posts.get(data.post.id).feature_image_id, null);
    assert.equal(ctx.store.posts.get(data.post.id).og_image_id, null);
    assert.ok(data.checks.errors.some((e) => /picture/.test(e.message)));
    res = await t.api(t.author, "/posts", { ...BASE, title: "Own pdf", slug: "own-pdf", download_files: [{ media_id: pdf.id, label: "Guide" }] });
    assert.equal(ctx.store.posts.get((await saved(res)).id).downloads.files.length, 1);
    // Someone else's download, saved by another author: dropped. An editor may attach it.
    const other = await newStaff("author");
    res = await t.api(other, "/posts", { ...BASE, title: "Taken pdf", slug: "taken-pdf", download_files: [{ media_id: pdf.id, label: "Guide" }] });
    data = await res.json();
    assert.equal(ctx.store.posts.get(data.post.id).downloads.files.length, 0);
    assert.ok(data.checks.errors.some((e) => e.message === "One picture or file isn't yours to use."));
    res = await t.api(t.editor, "/posts", { ...BASE, title: "Editor pdf", slug: "editor-pdf", download_files: [{ media_id: pdf.id, label: "Guide" }] });
    assert.equal(ctx.store.posts.get((await saved(res)).id).downloads.files.length, 1);
  });

  test("the same bytes again are answered from the library; others only learn that it exists (R-093, H-media-09)", async () => {
    const buf = await freshPng();
    const a = await up(t.editor, "first-name.png", buf);
    assert.equal(a.status, 201);
    const b = await up(t.editor, "second-name.png", buf);
    assert.equal(b.item.id, a.item.id);
    assert.equal(b.duplicate, true);
    // A person who could not list that file gets a plain refusal, with nothing about it.
    const c = await up(t.contrib2, "mine.png", buf);
    assert.equal(c.status, 400);
    assert.equal(c.error, "That file is already in the library.");
    assert.ok(!JSON.stringify(c).includes("first-name"));
    // The uploader gets their own record back, and the alt text is filled in when it was empty.
    const buf2 = await freshPng();
    const d = await up(t.contrib, "alt-empty.png", buf2);
    const e = await t.req(t.contrib.j, `${A}/api/media`, { method: "POST", multipart: Object.assign(new FormData(), {}), headers: { "x-csrf-token": t.contrib.csrf } });
    assert.equal(e.status, 400);
    const fd = new FormData();
    fd.append("file", new File([buf2], "again.png", { type: "image/png" }));
    fd.append("alt", "Filled in later");
    const f = await (await t.req(t.contrib.j, `${A}/api/media`, { method: "POST", multipart: fd, headers: { "x-csrf-token": t.contrib.csrf } })).json();
    assert.equal(f.item.id, d.item.id);
    assert.equal(ctx.store.media.get(d.item.id).alt, "Filled in later");
    // The plain upload form says so when every file was already there.
    const form = new FormData();
    form.append("_csrf", t.contrib.csrf);
    form.append("file", new File([buf2], "form.png", { type: "image/png" }));
    const r = await t.req(t.contrib.j, `${A}/media`, { method: "POST", multipart: form });
    assert.equal(r.status, 302);
    assert.match(r.headers.get("location"), /ok=duplicate/);
    const page = await (await t.get(t.contrib, "/media?ok=duplicate")).text();
    assert.match(page, /already in the library/);
  });

  test("uploads: one at a time below editor, two for editors, and every attempt counts (L-media-upload-quota)", async () => {
    const s = await newStaff("contributor");
    const [x, y] = await Promise.all([up(s, "slot-a.png", await t.png(900, 700, "#aa3311")), up(s, "slot-b.png", await t.png(900, 701, "#aa3322"))]);
    assert.deepEqual([x.status, y.status].sort(), [201, 429]);
    const e = await newStaff("editor");
    const both = await Promise.all([up(e, "ed-a.png", await t.png(900, 702, "#11aa33")), up(e, "ed-b.png", await t.png(900, 703, "#11aa44"))]);
    assert.deepEqual(both.map((r) => r.status), [201, 201]);
    // Repeating one file costs nothing in storage but every try is counted: 60 an hour below editor.
    const g = await newStaff("contributor");
    const buf = await freshPng();
    const statuses = [];
    for (let i = 0; i < 62; i++) statuses.push((await up(g, `repeat-${i}.png`, buf)).status);
    assert.equal(statuses[0], 201);
    assert.ok(statuses.slice(1, 60).every((s2) => s2 === 201));
    assert.equal(statuses[60], 429);
    assert.equal(ctx.store.media.list({ uploadedBy: ctx.store.users.getByEmail(g.email).id }).length, 1);
  });

  test("file names and alt text lose control and format characters (N-100, Q12)", async () => {
    const r = await upPdf(t.author, "evil‮fdp.pdf");
    assert.equal(r.status, 201);
    assert.ok(!/[‮​]/.test(r.item.name), JSON.stringify(r.item.name));
    const img = (await up(t.editor, "alt-clean.png", await freshPng())).item;
    await t.post(t.editor, `/media/${img.id}`, { alt: "Wiring\u0007 ‮diagram​  one" });
    assert.equal(ctx.store.media.get(img.id).alt, "Wiring diagram one");
  });

  test("alt text cannot break out of the Markdown image (L-media-default-alt)", async () => {
    const img = (await up(t.contrib, "meta.png", await freshPng())).item;
    const alt = "a\\](/x.png) \\[Click\\](https://example.invalid/) *b* _c_ `d` <e>";
    await t.post(t.contrib, `/media/${img.id}`, { alt });
    const items = (await (await t.get(t.editor, "/api/media")).json()).items;
    const item = items.find((i) => i.id === img.id);
    const md = new MarkdownIt({ html: false });
    for (const text of [item.markdown]) {
      const html = md.render(text);
      assert.equal((html.match(/<img /g) || []).length, 1, html);
      assert.ok(!/<a /.test(html), html);
    }
    const page = await (await t.get(t.contrib, "/media")).text();
    assert.ok(!page.includes("[Click\\](https://example.invalid/)") || page.includes("\\[Click"), "the copy button holds the escaped text");
    // The editor's own escaping, taken from the script.
    const grab = (name) => new RegExp(`^  const ${name} = .*$`, "m").exec(editorJs)[0].replace(/^  const /, "const ");
    const run = new Function(`${grab("MD_META")}\n${grab("altForMarkdown")}\n${grab("altForVisual")}\nreturn { altForMarkdown, altForVisual };`)();
    const html = md.render(`![${run.altForMarkdown(alt)}](/media/real.png)`);
    assert.equal((html.match(/<img /g) || []).length, 1, html);
    assert.ok(!/<a /.test(html), html);
    assert.ok(!/[\\[\]()<>*_`]/.test(run.altForVisual(alt)));
  });

  test("alt text on a picture that is on the blog is for editors, unchanged text is not saved, edits are limited (R-021)", async () => {
    const img = (await up(t.contrib, "public-alt.png", await freshPng())).item;
    ctx.store.settings.set({ logo_id: img.id });
    let res = await t.post(t.contrib, `/media/${img.id}`, { alt: "Changed after use" });
    assert.equal(res.status, 403);
    assert.notEqual(ctx.store.media.get(img.id).alt, "Changed after use");
    ctx.store.settings.set({ logo_id: null });
    const mine = (await up(t.contrib, "calm-alt.png", await freshPng())).item;
    await t.post(t.contrib, `/media/${mine.id}`, { alt: "Same" });
    const real = ctx.store.media.setAlt;
    let calls = 0;
    ctx.store.media.setAlt = (...a) => (calls++, real(...a));
    try {
      await t.post(t.contrib, `/media/${mine.id}`, { alt: "Same" });
      assert.equal(calls, 0, "nothing changed, nothing saved");
      let limited = false;
      for (let i = 0; i < 40; i++) {
        const r = await t.post(t.editor, `/media/${mine.id}`, { alt: `Edit ${i}` });
        if (r.status === 429) limited = true;
      }
      assert.ok(limited);
    } finally {
      ctx.store.media.setAlt = real;
    }
  });

  test("the 'still in use' message names places only to editors (N-023)", async () => {
    const img = (await up(t.contrib, "secret-use.png", await freshPng())).item;
    t.makePost({ slug: "secret-draft", title: "Secret sponsor plan", author_id: t.user("eve@example.com").id, feature_image_id: img.id });
    let res = await t.post(t.contrib, `/media/${img.id}/delete`, {});
    assert.equal(res.status, 409);
    let html = await res.text();
    assert.ok(!html.includes("Secret sponsor plan"));
    assert.match(html, /Still used in 1 place/);
    res = await t.post(t.editor, `/media/${img.id}/delete`, {});
    html = await res.text();
    assert.match(html, /Secret sponsor plan/);
  });
});

describe("comments", () => {
  const owner = () => t.user("owner@example.com");
  const post = t.makePost({ slug: "comment-host", status: "published", published_at: "2024-01-01T00:00:00.000Z" });
  const add = (over = {}) => ctx.store.comments.add({ postId: post.id, userId: owner().id, body: "A comment", ...over });
  const reply = (s, id, extraForm = {}) => t.post(s, `/comments/${id}/reply`, { body: "Thanks", back: `${A}/comments`, ...extraForm });

  test("a reply to a hidden, removed or waiting comment never answers 500 or approves by accident (N-068)", async () => {
    const hidden = add();
    ctx.store.comments.setStatus(hidden.id, "hidden");
    let res = await reply(t.editor, hidden.id);
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location"), /ok=replyhidden/);
    assert.equal(ctx.store.comments.get(hidden.id).status, "hidden");
    // A removed comment that is kept only as a place for replies.
    const top = add();
    ctx.store.comments.add({ postId: post.id, userId: owner().id, parentId: top.id, body: "Reply" });
    ctx.store.comments.remove(top.id);
    assert.equal(ctx.store.comments.get(top.id).status, "deleted");
    res = await reply(t.editor, top.id);
    assert.match(res.headers.get("location"), /ok=replyhidden/);
    // A waiting comment is approved and answered.
    const waiting = add({ status: "pending" });
    res = await reply(t.editor, waiting.id);
    assert.match(res.headers.get("location"), /ok=replied/);
    assert.equal(ctx.store.comments.get(waiting.id).status, "published");
    // A reply to a reply whose parent is hidden is refused too.
    const p2 = add();
    const r2 = ctx.store.comments.add({ postId: post.id, userId: owner().id, parentId: p2.id, body: "Child" });
    ctx.store.comments.setStatus(p2.id, "hidden");
    res = await reply(t.editor, r2.id);
    assert.match(res.headers.get("location"), /ok=replyhidden/);
    const page = await (await t.get(t.editor, "/comments?ok=replyhidden")).text();
    assert.match(page, /hidden or removed/);
  });

  test("a removed comment shows as Removed with no Approve button, and is not counted (N-069)", async () => {
    const top = add({ body: "Removed one" });
    ctx.store.comments.add({ postId: post.id, userId: owner().id, parentId: top.id, body: "Kept reply" });
    ctx.store.comments.remove(top.id);
    const html = await (await t.get(t.editor, "/comments")).text();
    assert.match(html, /Removed/);
    assert.ok(!html.includes(`/comments/${top.id}/approve`));
    assert.ok(!html.includes(`/comments/${top.id}/reply`));
    const c = ctx.store.comments.counts();
    const all = new RegExp(`All <span class="meta">${(c.published || 0) + (c.pending || 0) + (c.hidden || 0)}</span>`);
    assert.match(html, all);
  });

  test("action forms carry only the filter values and page, not the whole address (N-118)", async () => {
    add();
    const html = await (await t.get(t.editor, "/comments?status=published&junk=%3Cscript%3Ex&member=0&page=1")).text();
    const backs = [...html.matchAll(/name="back" value="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(backs.length);
    for (const b of backs) assert.equal(b, "/admin/comments?status=published");
  });
});

describe("newsletter and subscribers", () => {
  test("the add-subscribers trim is linear and long pieces are skipped (L-newsletter-regex)", async () => {
    const t0 = Date.now();
    const res = await t.post(t.admin, "/newsletter/subscribers/add", { emails: `${")".repeat(150_000)}a ${"(".repeat(60)}ok@example.com${")".repeat(60)}`, consent: "test" });
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
    assert.equal(res.status, 302);
    assert.equal(ctx.store.subscribers.getByEmail("ok@example.com")?.status, "active");
    assert.ok(!/\bfor \(const piece[\s\S]{0,400}replace\(\/\^\[</.test(adminSrc), "the quadratic pattern is gone");
  });

  test("added addresses carry a batch id and how consent was given; adding is limited; the batch is logged (N-088)", async () => {
    const s = await newStaff("admin");
    const lines = await capture(async () => {
      const res = await t.post(s, "/newsletter/subscribers/add", { emails: "consent1@example.com", consent: "signed the paper list" });
      assert.equal(res.status, 302);
    });
    const row = ctx.store.subscribers.getByEmail("consent1@example.com");
    assert.match(row.source, /batch [0-9a-f]{8}: signed the paper list/);
    assert.ok(lines.some((l) => /\[audit\] subscribers added by user \d+, batch [0-9a-f]{8}/.test(l) && /signed the paper list/.test(l)));
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const r = await t.post(s, "/newsletter/subscribers/add", { emails: `lim${i}@example.com`, consent: "x" });
      if (r.status === 429) limited = true;
    }
    assert.ok(limited);
  });

  test("an address that is waiting to confirm is not reported as already on the list (N-076)", async () => {
    ctx.store.subscribers.add("waiting1@example.com", "signup form");
    const before = ctx.db.prepare("SELECT confirm_token_hash FROM subscribers WHERE email = ?").get("waiting1@example.com").confirm_token_hash;
    const res = await t.post(t.admin, "/newsletter/subscribers/add", { emails: "waiting1@example.com", consent: "asked by mail" });
    const loc = res.headers.get("location");
    assert.match(loc, /skipped=0/);
    assert.ok(/added=1/.test(loc) || /waiting=1/.test(loc), loc);
    const row = ctx.store.subscribers.getByEmail("waiting1@example.com");
    if (row.status === "pending") assert.equal(ctx.db.prepare("SELECT confirm_token_hash FROM subscribers WHERE email = ?").get("waiting1@example.com").confirm_token_hash, before, "the mailed link keeps working");
  });

  test("the subscriber export is a form post with the token; paged reading gives every row once (Q13, H-performance-19)", async () => {
    for (let i = 0; i < 1100; i++) ctx.store.subscribers.add(`page${i}@example.com`, "bulk", { confirmed: true });
    assert.equal((await t.get(t.admin, "/newsletter/subscribers.csv")).status, 302);
    const legacy = await t.get(t.admin, "/subscribers.csv");
    assert.equal(legacy.status, 301);
    assert.equal(legacy.headers.get("location"), "/admin/newsletter/subscribers");
    const none = await t.req(t.admin.j, `${A}/newsletter/subscribers.csv`, { method: "POST", form: {} });
    assert.equal(none.status, 403);
    const res = await t.post(t.admin, "/newsletter/subscribers.csv", {});
    assert.match(res.headers.get("content-type"), /text\/csv/);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 1 + ctx.store.subscribers.counts().total);
    assert.equal(new Set(lines.map((l) => l.split(",")[0])).size, lines.length);
    const page = await (await t.get(t.admin, "/newsletter/subscribers")).text();
    assert.match(page, /<form method="post" action="\/admin\/newsletter\/subscribers\.csv">/);
  });

  test("test emails go only to you or the team; the log records tests, retries, deletes (R-085, N-087)", async () => {
    ctx.store.settings.set({ mail_from_email: "news@example.com", smtp_host: "smtp.example.com", smtp_user: "u", smtp_pass: "p" });
    const n = ctx.store.newsletters.save({ subject: "Audit me", preheader: "", body_md: "Hi", postIds: [] }, 0, t.user("ada@example.com").id);
    const lines = await capture(async () => {
      let res = await t.post(t.admin, `/newsletter/${n.id}`, { action: "test", subject: "Audit me", body_md: "Hi", test_to: "stranger@example.net" });
      assert.equal(res.status, 400);
      assert.match(await res.text(), /only to you or to someone on your team/);
      res = await t.post(t.admin, `/newsletter/${n.id}`, { action: "test", subject: "Audit me", body_md: "Hi", test_to: "EVE@example.com" });
      assert.match(res.headers.get("location"), /ok=testsent/);
      res = await t.post(t.admin, `/newsletter/${n.id}/delete`, {});
      assert.match(res.headers.get("location"), /ok=deleted/);
    });
    assert.ok(lines.some((l) => /newsletter \d+ test email sent by user/.test(l)));
    assert.ok(lines.some((l) => /newsletter \d+ deleted by user/.test(l)));
    assert.ok(!lines.some((l) => /stranger@/.test(l)));
  });

  test("retry: nothing failed means nothing to do and the sent time stays; a refusal is reported (N-084)", async () => {
    ctx.store.settings.set({ mail_from_email: "news@example.com", smtp_host: "smtp.example.com", smtp_user: "u", smtp_pass: "p" });
    const n = ctx.store.newsletters.save({ subject: "Went out", preheader: "", body_md: "Hi", postIds: [] }, 0, t.user("ada@example.com").id);
    ctx.db.prepare("UPDATE newsletters SET status = 'sent', sent_at = ? WHERE id = ?").run("2024-02-02T00:00:00.000Z", n.id);
    let res = await t.post(t.admin, `/newsletter/${n.id}/retry`, {});
    assert.match(res.headers.get("location"), /ok=nothingtoretry/);
    assert.equal(ctx.store.newsletters.get(n.id).sent_at, "2024-02-02T00:00:00.000Z");
    const sub = ctx.store.subscribers.add("failed1@example.com", "x", { confirmed: true }).subscriber;
    ctx.db.prepare("INSERT INTO newsletter_sends (newsletter_id, subscriber_id, status, error) VALUES (?, ?, 'failed', 'x')").run(n.id, sub.id);
    // The Site URL is still localhost in this test app, so sending is blocked: the answer says so.
    res = await t.post(t.admin, `/newsletter/${n.id}/retry`, {});
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Site URL/);
    assert.equal(ctx.store.newsletters.get(n.id).status, "sent");
  });

  test("the newsletter preview runs in a sandbox (N-114)", async () => {
    const n = ctx.store.newsletters.save({ subject: "Preview me", preheader: "", body_md: "Hi", postIds: [] }, 0, t.user("ada@example.com").id);
    const res = await t.get(t.admin, `/newsletter/${n.id}/preview`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy"), /^sandbox;/);
    const post = await t.post(t.admin, `/newsletter/${n.id}`, { action: "preview", subject: "Preview me", body_md: "Hi" });
    assert.match(post.headers.get("content-security-policy"), /^sandbox;/);
  });
});

describe("mail settings, analytics and settings", () => {
  const mailForm = (over = {}) => ({ newsletter_enabled: "1", newsletter_heading: "H", newsletter_text: "T", smtp_host: "smtp.example.com", smtp_user: "u", smtp_port: "587", smtp_secure: "starttls", ...over });

  test("who the emails come from is the owner's (N-086)", async () => {
    ctx.store.settings.set({ mail_from_email: "owner-set@example.com", mail_from_name: "Owner Set", mail_reply_to: "" });
    await t.post(t.admin, "/newsletter/settings", mailForm({ mail_from_email: "evil@example.com", mail_from_name: "Evil", mail_reply_to: "evil@example.com" }));
    assert.equal(ctx.store.settings.get("mail_from_email"), "owner-set@example.com");
    assert.equal(ctx.store.settings.get("mail_from_name"), "Owner Set");
    assert.equal(ctx.store.settings.get("mail_reply_to"), "");
    const page = await (await t.get(t.admin, "/newsletter/settings")).text();
    assert.match(page, /Only the owner can change this/);
    const lines = await capture(async () => {
      await t.post(t.owner, "/newsletter/settings", mailForm({ mail_from_email: "new-owner@example.com", mail_from_name: "Owner Set" }));
    });
    assert.equal(ctx.store.settings.get("mail_from_email"), "new-owner@example.com");
    assert.ok(lines.some((l) => /\[audit\] email settings saved by user \d+: .*mail_from_email/.test(l)), lines.join("|"));
  });

  test("a password over 500 characters is refused; a new port or security mode removes the saved password (N-090)", async () => {
    ctx.store.settings.set({ smtp_host: "smtp.example.com", smtp_user: "u", smtp_port: 587, smtp_secure: "starttls", smtp_pass: "keep-me" });
    let res = await t.post(t.owner, "/newsletter/settings", mailForm({ smtp_pass: "p".repeat(501) }));
    assert.equal(res.status, 400);
    assert.match(await res.text(), /longer than 500 characters/);
    assert.equal(ctx.store.settings.getSecret("smtp_pass"), "keep-me");
    const lines = await capture(async () => {
      res = await t.post(t.owner, "/newsletter/settings", mailForm({ smtp_port: "465", smtp_secure: "ssl" }));
    });
    assert.match(res.headers.get("location"), /ok=mailpasscleared/);
    assert.ok(!ctx.store.settings.getSecret("smtp_pass"));
    assert.ok(lines.some((l) => /smtp_pass \(removed\)/.test(l)));
    assert.ok(!lines.some((l) => /keep-me/.test(l)));
  });

  test("a tracker server anyone can publish on is refused; long and odd addresses are refused, not cut (R-124, R-127)", async () => {
    const id = "4f1c6b2e-1234-4abc-8def-0123456789ab";
    let res = await t.post(t.owner, "/analytics", { analytics_provider: "umami", analytics_script: "https://cdn.jsdelivr.net/npm/x/script.js", analytics_id: id, confirm_host: "1" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /shared server/);
    res = await t.post(t.owner, "/analytics", { analytics_provider: "umami", analytics_script: `https://track.example.org/${"a".repeat(2100)}.js`, analytics_id: id, confirm_host: "1" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /2,048/);
    res = await t.post(t.owner, "/analytics", { analytics_provider: "umami", analytics_script: "https://track.example.org/s.js", analytics_id: id });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /whole server run scripts/);
    res = await t.post(t.owner, "/analytics", { analytics_provider: "umami", analytics_script: "https://track.example.org/s.js", analytics_id: id, confirm_host: "1" });
    assert.equal(res.status, 302);
    await t.post(t.owner, "/analytics", { analytics_provider: "none" });
  });

  test("sending every URL to IndexNow has a cooldown (N-133)", async () => {
    const a = await t.post(t.admin, "/analytics/indexnow", {});
    const b = await t.post(t.admin, "/analytics/indexnow", {});
    assert.match(a.headers.get("location"), /ok=pinged/);
    assert.match(b.headers.get("location"), /ok=pingwait/);
  });

  test("settings text is one line; a non-public Site URL needs a tick (N-132, N-125)", async () => {
    await t.post(t.admin, "/settings", { site_title: "Line one\nline two", brand_name: "A\r\nB", about_text: "First\nSecond" });
    assert.equal(ctx.store.settings.get("site_title"), "Line one line two");
    assert.equal(ctx.store.settings.get("brand_name"), "A B");
    assert.equal(ctx.store.settings.get("about_text"), "First\nSecond");
    let res = await t.post(t.owner, "/settings", { site_title: "T", site_url: "http://example.org" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /confirm_site_url/);
    assert.equal(ctx.store.settings.get("site_url"), "http://localhost");
    res = await t.post(t.owner, "/settings", { site_title: "T", site_url: "https://10.0.0.5" });
    assert.equal(res.status, 400);
    res = await t.post(t.owner, "/settings", { site_title: "T", site_url: "http://example.org", confirm_site_url: "1" });
    assert.equal(res.status, 302);
    ctx.store.settings.set({ site_url: "http://localhost" });
    // Saving the form with the address unchanged never needs the tick.
    res = await t.post(t.owner, "/settings", { site_title: "T", site_url: "http://localhost" });
    assert.equal(res.status, 302);
  });
});

describe("menus, ads, redirects and shared checks", () => {
  test("a valid but over-long menu link is refused, not cut (N-139)", async () => {
    const long = `https://example.org/${"a".repeat(600)}`;
    const res = await t.post(t.admin, "/menus", { nav_mode: "custom", nav_json: JSON.stringify([{ label: "Long", url: long }, { label: "Home", url: "/" }]), footer_mode: "auto", footer_json: "[]" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /longer than 500 characters/);
  });

  test("an ad name is one line, and its contact link is not cut (N-145, N-140)", async () => {
    const img = (await up(t.admin, "ad-img.png", await freshPng())).item;
    const place = Object.keys(AD_PLACES)[0];
    const res = await t.post(t.admin, "/ads", { name: "Two\nlines\r\nname", url: "https://example.org/", image_id: String(img.id), places: place, active: "1" });
    assert.equal(res.status, 302);
    assert.ok(ctx.store.ads.list(50).some((a) => a.name === "Two lines name"));
    const contact = await t.post(t.admin, "/ads/settings", { ads_contact_url: `https://example.org/${"b".repeat(600)}` });
    assert.match(contact.headers.get("location"), /error=contact/);
    assert.doesNotMatch(adminSrc, /CONTROL_NO_NL/, "one shared control-character rule (validate.js cleanText)");
  });

  test("a redirect that would loop is refused with a plain message (Q14)", async () => {
    let res = await t.post(t.admin, "/redirects", { from_path: "/loop-a/", to_path: "/loop-b/", status_code: "301" });
    assert.equal(res.status, 302);
    res = await t.post(t.admin, "/redirects", { from_path: "/loop-b/", to_path: "/loop-a/", status_code: "301" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /round in a circle/);
  });
});

describe("the editor's client code, the page script and the build script", () => {
  const list = (name) => JSON.parse(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`).exec(editorJs)[1]);

  test("the preview sanitiser is an explicit allow-list (Q17, L-client-side, N-116)", () => {
    const tags = list("ALLOWED_TAGS");
    const attrs = list("ALLOWED_ATTR");
    const forbidTags = list("FORBID_TAGS");
    const forbidAttrs = list("FORBID_ATTR");
    for (const tag of ["label", "button", "input", "form", "select", "textarea", "option"]) {
      assert.ok(!tags.includes(tag), tag);
      assert.ok(forbidTags.includes(tag), tag);
    }
    for (const a of ["for", "form", "formaction", "accesskey", "tabindex"]) {
      assert.ok(!attrs.includes(a), a);
      assert.ok(forbidAttrs.includes(a), a);
    }
    assert.deepEqual(attrs.filter((a) => a.startsWith("data-")), ["data-nodeid"], "only the preview's own data attribute");
    assert.match(editorJs, /ALLOW_DATA_ATTR: false/);
    assert.doesNotMatch(editorJs, /USE_PROFILES/);
  });

  test("the editor sends only fields its page has, and stops saving after a conflict", () => {
    assert.match(editorJs, /const v = \(n\) => field\(n\)\?\.value;/);
    assert.match(editorJs, /comments_enabled: on\("comments_enabled"\)/);
    assert.match(editorJs, /loaded_modified_at: version\.modified/);
    assert.match(editorJs, /err\.status === 409/);
    assert.match(editorJs, /putImage\(item\.url/);
  });

  test("external links and the preview form carry noopener noreferrer (N-115)", () => {
    for (const f of ["media.njk", "editor.njk", "comments.njk", "analytics.njk", "posts.njk", "taxonomy.njk", "menus.njk", "newsletter-edit.njk"]) {
      const src = fs.readFileSync(path.join(ROOT, "views/admin", f), "utf8");
      assert.doesNotMatch(src, /rel="noopener"/, f);
    }
    assert.match(fs.readFileSync(path.join(ROOT, "views/admin/editor.njk"), "utf8"), /target="_blank" rel="noopener noreferrer" hidden/);
  });

  test("the page script guards the reply and compose parts (R-035)", () => {
    const site = fs.readFileSync(path.join(ROOT, "assets/js/site.js"), "utf8");
    assert.match(site, /if \(compose && parent && replyTo && cancel\)/);
  });

  test("build-editor.js checks every bundled package, one DOMPurify and the stylesheet hash, without config.js (R-199 to R-202, Q27)", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts/build-editor.js"), "utf8");
    assert.doesNotMatch(src, /import .*config\.js/);
    assert.match(src, /metafile: true/);
    assert.match(src, /packageKeyOf/);
    assert.match(src, /expected exactly one DOMPurify package/);
    assert.match(src, /toastui-editor\.css/);
    // --verify covers the script and the stylesheet, and gives one answer whatever the environment says.
    const run = (env) => execFileSync(process.execPath, [path.join(ROOT, "scripts/build-editor.js"), "--verify"], { cwd: os.tmpdir(), encoding: "utf8", env: { ...process.env, ...env } });
    const out = run({});
    assert.match(out, /toastui-editor\.js matches/);
    assert.match(out, /toastui-editor\.css matches/);
    assert.equal(run({ SITE_URL: "not a url", DATA_DIR: "/nowhere", BASE_PATH: "/zzz", NODE_ENV: "production" }), out);
    const rec = fs.readFileSync(path.join(ROOT, "assets/vendor/toastui-editor.sha256"), "utf8").trim().split(/\r?\n/);
    assert.match(rec[0], /^[0-9a-f]{64}\s+toastui-editor\.js/);
    assert.match(rec[1], /^[0-9a-f]{64}\s+toastui-editor\.css/);
  });

  test("--verify fails when the stylesheet is changed (R-200)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-editor-"));
    fs.mkdirSync(path.join(tmp, "scripts"));
    fs.mkdirSync(path.join(tmp, "assets", "vendor"), { recursive: true });
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tmp, "node_modules"), "junction");
    fs.copyFileSync(path.join(ROOT, "scripts/build-editor.js"), path.join(tmp, "scripts/build-editor.js"));
    for (const f of ["toastui-editor.js", "toastui-editor.css", "toastui-editor.sha256"]) fs.copyFileSync(path.join(ROOT, "assets/vendor", f), path.join(tmp, "assets/vendor", f));
    const verify = () => execFileSync(process.execPath, [path.join(tmp, "scripts/build-editor.js"), "--verify"], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(verify(), /matches/);
    fs.appendFileSync(path.join(tmp, "assets/vendor/toastui-editor.css"), "\n.x{display:none}");
    assert.throws(verify, (err) => /toastui-editor\.css does not match its recorded hash/.test(String(err.stderr)));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("lists and owner-only settings", () => {
  test("below editor the posts tabs count only the person's own posts (R-022)", async () => {
    const s = await newStaff("contributor");
    const me = ctx.store.users.getByEmail(s.email);
    t.makePost({ slug: "own-count-1", author_id: me.id });
    t.makePost({ slug: "own-count-2", author_id: me.id });
    const html = await (await t.get(s, "/posts")).text();
    assert.match(html, /All <span class="meta">2<\/span>/);
    assert.match(html, /Drafts <span class="meta">2<\/span>/);
    const editorHtml = await (await t.get(t.editor, "/posts")).text();
    assert.ok(!/All <span class="meta">2<\/span>/.test(editorHtml));
  });

  test("owner-only checks in the content routes use can.owner (N-027)", () => {
    const content = adminSrc.slice(adminSrc.indexOf("// ---------- Redirects and subscribers"));
    assert.doesNotMatch(content, /\.role === "owner"/);
  });
});

describe("older versions and the redirects list", () => {
  test("an editor can delete one older version or all of them; others can't (N-106)", async () => {
    const alan = t.user("alan@example.com");
    const post = t.makePost({ slug: "purge-me", author_id: alan.id });
    let last = post.modified_at;
    for (const body of ["one with PASSWORD=hunter2", "two", "three"]) {
      await tick();
      const res = await t.api(t.editor, `/posts/${post.id}`, { ...BASE, slug: "purge-me", body_md: body, loaded_modified_at: last });
      last = (await saved(res)).version.modified;
    }
    const revs = ctx.store.posts.revisions(post.id);
    assert.ok(revs.length >= 3);
    const post2 = (id, p, s) => t.req(s.j, `${A}/api/posts/${id}${p}`, { method: "POST", headers: { "x-csrf-token": s.csrf } });
    assert.equal((await post2(post.id, "/revisions/purge", t.author)).status, 403, "an author may not");
    const old = revs.find((r) => /PASSWORD/.test(ctx.store.posts.revision(post.id, r.id).body_md));
    let res = await post2(post.id, `/revisions/${old.id}/delete`, t.editor);
    assert.equal((await res.json()).removed, 1);
    assert.ok(!ctx.store.posts.revisions(post.id).some((r) => r.id === old.id));
    res = await post2(post.id, "/revisions/purge", t.editor);
    assert.equal((await res.json()).ok, true);
    assert.equal(ctx.store.posts.revisions(post.id).length, 1);
    const html = await (await t.get(t.editor, `/posts/${post.id}`)).text();
    assert.match(html, /btn-purge-revisions/);
    assert.doesNotMatch(await (await t.get(t.author, `/posts/${post.id}`)).text(), /btn-purge-revisions/);
  });

  test("the redirects list is paged and searchable", async () => {
    for (let i = 0; i < 130; i++) ctx.store.redirects.save({ from_path: `/page-test-${String(i).padStart(3, "0")}/`, to_path: "/target/", status_code: 301 });
    const p1 = await (await t.get(t.admin, "/redirects")).text();
    assert.match(p1, /Page 1 of/);
    assert.ok(!p1.includes("/page-test-129/"));
    const p2 = await (await t.get(t.admin, "/redirects?page=2")).text();
    assert.match(p2, /page-test-129/);
    const q = await (await t.get(t.admin, "/redirects?q=page-test-042")).text();
    assert.match(q, /page-test-042/);
    assert.ok(!q.includes("page-test-043"));
  });
});
