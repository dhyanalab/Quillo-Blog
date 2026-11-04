// End-to-end tests for the blog at the root of the domain (the default): reader accounts, comments and
// moderation, source code files and downloads, and the publishing check for real Wi-Fi passwords.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/web/app.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-site-test-"));
const { app, ctx } = createApp({ dataDir, siteUrl: "", outbound: false, production: true, setupToken: "test-setup", mailTransport: { jsonTransport: true }, mailDelayMs: 0 });

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
const field = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];
const csrfOf = (html) => (html.match(/data-csrf="([^"]+)"/) || [])[1];

const owner = jar();
let csrf = "";
const api = (p, json) => req(owner, `/admin/api${p}`, { method: "POST", json, headers: { "x-csrf-token": csrf } });
const upload = async (name, bytes) => {
  const fd = new FormData();
  fd.append("file", new File([bytes], name));
  return req(owner, "/admin/api/media", { method: "POST", multipart: fd, headers: { "x-csrf-token": csrf } });
};

const MAIN = '#include "config.h"\n\nvoid setup() {\n  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);\n}\n\nvoid loop() {}\n';
const CONFIG = '#define WIFI_SSID "YOUR_WIFI_NAME"\n#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"\n';
const POST = {
  type: "post",
  title: "ESP32 Water Tank Level Monitor",
  slug: "tank-level",
  excerpt: "Measure the water level in a tank with an ultrasonic sensor and an ESP32, and sound an alarm before it runs dry.",
  body_md: "Intro.\n\n## Wiring\n\nText.\n\n## FAQ\n\n### Does it work outdoors?\n\nYes.\n",
  quick_answer: "An ultrasonic sensor measures the distance to the water.",
  at_a_glance: [["Difficulty", "Beginner"], ["Build time", "20 minutes"]],
  tags: "ESP32",
  source_files: [{ name: "main.ino", lang: "arduino", code: MAIN }, { name: "config.h", lang: "cpp", code: CONFIG }],
  download_github: "https://github.com/example/tank",
};
let postId = 0;

before(async () => {
  let res = await req(owner, "/admin/");
  assert.equal(res.headers.get("location"), "/admin/setup");
  res = await req(owner, "/admin/setup");
  const token = field(await res.text(), "_csrf");
  res = await req(owner, "/admin/setup", { method: "POST", form: { _csrf: token, setup_token: "test-setup", site_title: "IoT Studio Blog", site_url: "https://blog.example.com", name: "Olive Owner", email: "owner@example.com", password: "correct horse battery" } });
  assert.equal(res.status, 302);
  csrf = csrfOf(await (await req(owner, "/admin/")).text());
});
after(() => {
  ctx.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("root URLs", () => {
  test("the blog lives at / and the admin at /admin", async () => {
    assert.equal((await req(jar(), "/")).status, 200);
    assert.equal((await req(jar(), "/admin/")).headers.get("location"), "/admin/login?next=%2Fadmin%2F");
    const robots = await (await req(jar(), "/robots.txt")).text();
    assert.match(robots, /Disallow: \/admin\/\nDisallow: \/account\//);
    assert.match(robots, /Sitemap: https:\/\/blog\.example\.com\/sitemap\.xml/);
  });
  test("reserved paths can't be used as post URLs", async () => {
    const res = await api("/posts", { ...POST, slug: "signin", intent: "save" });
    const data = await res.json();
    assert.notEqual(data.post.slug, "signin");
    await api(`/posts/${data.post.id}/delete`, {});
  });
});

describe("source code and downloads", () => {
  test("a real Wi-Fi password blocks publishing", async () => {
    const res = await api("/posts", { ...POST, slug: "leaky", source_files: [{ name: "main.ino", lang: "arduino", code: 'const char* password = "hunter2024";\n' }], intent: "publish" });
    assert.equal(res.status, 422);
    const data = await res.json();
    assert.ok(data.checks.errors.some((e) => e.field === "source_files" && /looks like a real password/.test(e.message)), JSON.stringify(data.checks.errors));
    await api(`/posts/${data.post.id}/delete`, {});
  });
  test("PDF and STL uploads are checked by their contents", async () => {
    let res = await upload("fake.pdf", "not a pdf");
    assert.equal(res.status, 400);
    res = await upload("diagram.pdf", "%PDF-1.4\n%%EOF\n");
    assert.equal(res.status, 201);
    const pdf = (await res.json()).item;
    assert.equal(pdf.kind, "file");
    res = await upload("mount.stl", "solid m\nfacet normal 0 0 0\nendsolid m\n");
    assert.equal(res.status, 201);
    const stl = (await res.json()).item;
    POST.download_files = [{ media_id: pdf.id, label: "Circuit diagram" }, { media_id: stl.id, label: "Sensor mount" }];
    const file = await req(jar(), stl.url);
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-disposition"), /attachment; filename="mount\.stl"/);
  });
  test("the post shows the source box after the FAQ and the download buttons", async () => {
    const res = await api("/posts", { ...POST, intent: "publish" });
    const data = await res.json();
    assert.equal(res.status, 201, JSON.stringify(data.checks?.errors));
    postId = data.post.id;
    const html = await (await req(jar(), "/tank-level/")).text();
    const faq = html.indexOf('id="faq"');
    const source = html.indexOf('id="source-code"');
    const downloads = html.indexOf('id="downloads"');
    assert.ok(faq > 0 && source > faq && downloads > source, "FAQ, then Source code, then Downloads");
    assert.match(html, /<span class="src-name">main\.ino<\/span>/);
    assert.match(html, /class="dl-btn dl-main" href="\/media\/[^"]+\.stl" download/, "the STL is the main button");
    assert.match(html, /View on GitHub/);
    assert.doesNotMatch(html, /series-box|Next project/);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
    assert.ok(ld["@graph"].some((n) => n["@type"] === "SoftwareSourceCode"));
  });
  test("source files download one by one and as a ZIP", async () => {
    let res = await req(jar(), "/tank-level/source/config.h");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), CONFIG);
    res = await req(jar(), "/tank-level/source.zip");
    assert.equal(res.headers.get("content-type"), "application/zip");
    const zip = Buffer.from(await res.arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.ok(zip.includes(Buffer.from("tank-level/main.ino")));
  });
});

describe("sponsor banners", () => {
  let adId = 0;
  let pictureUrl = "";
  test("a banner picture uploaded from the Ads page gets a plain file name", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 728, height: 90, channels: 3, background: "#0050A0" } }).png().toBuffer();
    const fd = new FormData();
    fd.append("file", new File([png], "digikey-728x90-banner.png", { type: "image/png" }));
    fd.append("neutral", "1");
    const res = await req(owner, "/admin/api/media", { method: "POST", multipart: fd, headers: { "x-csrf-token": csrf } });
    assert.equal(res.status, 201);
    const { item } = await res.json();
    assert.match(item.url, /^\/media\/\d{4}\/\d{2}\/m-[0-9a-f]{16}\.png$/);
    assert.equal(item.name, "digikey-728x90-banner.png", "the admin still sees the original name");
    pictureUrl = item.url;
    const form = new URLSearchParams([["_csrf", csrf], ["name", "DigiKey November"], ["url", "https://www.digikey.in/"], ["alt", "DigiKey: electronic parts"], ["image_id", String(item.id)], ["places", "top"], ["places", "sidebar"], ["places", "article_end"], ["active", "1"]]);
    const saved = await app.request("https://localhost/admin/ads", { method: "POST", headers: { origin: "https://localhost", cookie: owner.header(), "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
    assert.equal(saved.status, 302, await saved.clone().text());
    adId = Number(saved.headers.get("location").match(/\/ads\/(\d+)/)[1]);
  });
  test("the banner shows in its places, labelled, with no blocker-bait names", async () => {
    const html = await (await req(jar(), "/tank-level/")).text();
    assert.match(html, new RegExp(`<div class="kx kx-wide" data-k="top"><div class="kx-f"><a class="kx-i" href="https://www.digikey.in/" target="_blank" rel="sponsored nofollow noopener" data-i="${adId}">`));
    assert.match(html, /data-k="article_end"/);
    assert.match(html, /<span class="kx-l">Sponsored<\/span>/);
    assert.ok(html.includes(pictureUrl));
    const markup = html.slice(html.indexOf('data-k="top"') - 40, html.indexOf('data-k="top"') + 600);
    assert.doesNotMatch(markup, /class="[^"]*\b(ad|ads|advert|banner|sponsor)/i);
    assert.doesNotMatch(await (await req(jar(), "/")).text(), /data-k="article_end"/, "article places stay on articles");
  });
  test("views and clicks are counted, bots are not", async () => {
    await req(jar(), "/k", { method: "POST", headers: { "content-type": "text/plain" }, form: undefined, json: undefined, multipart: `v:${adId}` });
    await req(jar(), "/k", { method: "POST", multipart: `c:${adId}` });
    await req(jar(), "/k", { method: "POST", multipart: `v:${adId}`, headers: { "user-agent": "Googlebot/2.1" } });
    await req(jar(), "/k", { method: "POST", multipart: `v:${adId}`, headers: { origin: "https://evil.example" } });
    assert.deepEqual({ ...ctx.store.ads.totals(adId) }, { views: 1, clicks: 1 });
    const page = await (await req(owner, `/admin/ads/${adId}`)).text();
    assert.match(page, /Views, all time/);
  });
  test("paused or ended banners disappear; empty places can show “Your brand here”", async () => {
    await req(owner, `/admin/ads/settings`, { method: "POST", form: { _csrf: csrf, ads_empty: "hide", ads_contact_url: "" } });
    await req(owner, `/admin/ads/${adId}/pause`, { method: "POST", form: { _csrf: csrf } });
    let html = await (await req(jar(), "/tank-level/")).text();
    assert.doesNotMatch(html, /data-k="top"/);
    await req(owner, `/admin/ads/settings`, { method: "POST", form: { _csrf: csrf, ads_empty: "show", ads_contact_url: "/advertise/" } });
    html = await (await req(jar(), "/tank-level/")).text();
    assert.match(html, /<a class="kx-e" href="\/advertise\/"><span class="kx-t">Your brand here<\/span><span class="kx-s">970 × 90 or 728 × 90<\/span>/);
    await req(owner, `/admin/ads/settings`, { method: "POST", form: { _csrf: csrf, ads_empty: "hide", ads_contact_url: "" } });
    await req(owner, `/admin/ads/${adId}/resume`, { method: "POST", form: { _csrf: csrf } });
    ctx.store.ads.save({ ...ctx.store.ads.get(adId), ends_at: new Date(Date.now() - 864e5).toISOString() }, adId);
    assert.doesNotMatch(await (await req(jar(), "/tank-level/")).text(), /data-k="top"/);
  });
  test("the master switch hides everything; a place switch hides just that place", async () => {
    ctx.store.ads.save({ ...ctx.store.ads.get(adId), ends_at: null, active: true }, adId);
    await req(owner, `/admin/ads/settings`, { method: "POST", form: { _csrf: csrf, ads_empty: "show", ads_contact_url: "" } });
    let html = await (await req(jar(), "/tank-level/")).text();
    assert.match(html, /data-k="top"><div class="kx-f">/, "banner on top");
    assert.match(html, /data-k="article_mid"|data-k="article_top"/, "empty boxes elsewhere");

    let res = await req(owner, "/admin/ads/places/top/off", { method: "POST", form: { _csrf: csrf } });
    assert.equal(res.status, 302);
    html = await (await req(jar(), "/tank-level/")).text();
    assert.doesNotMatch(html, /data-k="top"/, "the switched-off place is empty");
    assert.match(html, /data-k="article_end"><div class="kx-f">/, "the same banner still shows in its other places");
    assert.match(await (await req(owner, "/admin/ads")).text(), /<tr class="row-off">/);

    res = await req(owner, "/admin/ads/switch", { method: "POST", form: { _csrf: csrf, ads_enabled: "0" } });
    assert.equal(res.headers.get("location"), "/admin/ads?ok=adsoff");
    html = await (await req(jar(), "/tank-level/")).text();
    assert.doesNotMatch(html, /class="kx /, "no banners or empty boxes anywhere");
    assert.doesNotMatch(await (await req(jar(), "/")).text(), /class="kx /);
    assert.match(await (await req(owner, `/admin/ads/${adId}`)).text(), /Ads are switched off for the whole blog/);

    await req(owner, "/admin/ads/switch", { method: "POST", form: { _csrf: csrf, ads_enabled: "1" } });
    await req(owner, "/admin/ads/places/top/on", { method: "POST", form: { _csrf: csrf } });
    assert.match(await (await req(jar(), "/tank-level/")).text(), /data-k="top"><div class="kx-f">/, "back on");
    assert.equal((await req(owner, "/admin/ads/places/nope/off", { method: "POST", form: { _csrf: csrf } })).status, 404);
  });
  test("a banner needs a picture, a full link and a place", async () => {
    const res = await req(owner, "/admin/ads", { method: "POST", form: { _csrf: csrf, name: "Broken", url: "digikey.in" } });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /must be a full web address/);
    assert.match(html, /Choose the banner picture/);
    assert.match(html, /Tick at least one place/);
  });
});

describe("menus", () => {
  test("a chosen menu with a drop-down and footer columns reach the site", async () => {
    const nav = [{ label: "Projects", url: "/category/news/", children: [{ label: "Tank level", url: "/tank-level/" }] }, { label: "Shop", url: "https://shop.example.com/" }];
    const footer = [{ title: "Company", links: [{ label: "About", url: "/about/" }] }];
    const res = await req(owner, "/admin/menus", { method: "POST", form: { _csrf: csrf, nav_mode: "custom", nav_json: JSON.stringify(nav), footer_mode: "custom", footer_json: JSON.stringify(footer) } });
    assert.equal(res.status, 302);
    const html = await (await req(jar(), "/")).text();
    assert.match(html, /<summary>Projects/);
    assert.match(html, /<a href="\/tank-level\/">Tank level<\/a>/);
    assert.match(html, /<a href="https:\/\/shop\.example\.com\/"[^>]*>Shop<\/a>/);
    assert.match(html, /<h2 class="foot-title">Company<\/h2>/);
    const empty = await req(owner, "/admin/menus", { method: "POST", form: { _csrf: csrf, nav_mode: "custom", nav_json: "[]", footer_mode: "auto", footer_json: "[]" } });
    assert.equal(empty.status, 400);
    await req(owner, "/admin/menus", { method: "POST", form: { _csrf: csrf, nav_mode: "auto", nav_json: "[]", footer_mode: "auto", footer_json: "[]" } });
    assert.doesNotMatch(await (await req(jar(), "/")).text(), />Shop<\/a>/);
  });
});

describe("profile links", () => {
  const post = (pairs) => app.request("https://localhost" + pairs.path, { method: "POST", headers: { origin: "https://localhost", cookie: owner.header(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(pairs.body), redirect: "manual" });
  test("usernames become full links and show as logos on the author page", async () => {
    const me = ctx.store.users.getByEmail("owner@example.com");
    const base = [["_csrf", csrf], ["name", me.name], ["email", me.email], ["slug", me.slug], ["job_title", "Embedded engineer"], ["bio", "Builds things."]];
    let res = await post({ path: `/admin/users/${me.id}`, body: [...base, ["link_network", "instagram"], ["link_url", "@iotstudio"], ["link_network", "website"], ["link_url", "iotstudio.in"], ["link_network", "github"], ["link_url", ""]] });
    assert.equal(res.status, 302, await res.clone().text());
    assert.deepEqual(ctx.store.users.get(me.id).links, ["https://www.instagram.com/iotstudio/", "https://iotstudio.in/"]);
    const html = await (await req(jar(), `/authors/${me.slug}/`)).text();
    assert.match(html, /<ul class="netlinks"[^>]*><li><a href="https:\/\/www\.instagram\.com\/iotstudio\/" target="_blank" rel="noopener me" title="Instagram"><svg/);
    assert.match(html, /title="Website"/);
    res = await post({ path: `/admin/users/${me.id}`, body: [...base, ["link_network", "discord"], ["link_url", "not a link"]] });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /isn’t a link/);
    const editor = await (await req(owner, `/admin/users/${me.id}`)).text();
    assert.match(editor, /<option value="instagram"[^>]*selected>Instagram<\/option>/);
  });
});

describe("reader accounts and comments", () => {
  const reader = jar();
  let readerCsrf = "";
  test("signing up needs the form token and the emailed link, where the reader chooses a real password", async () => {
    let res = await req(reader, "/signup/?next=/tank-level/%23comments");
    const token = field(await res.text(), "_csrf");
    res = await req(reader, "/signup/", { method: "POST", form: { _csrf: "wrong", name: "Priya", email: "priya@example.com" } });
    assert.equal(res.status, 403);
    res = await req(reader, "/signup/", { method: "POST", form: { _csrf: token, name: "Priya", email: "priya@example.com", next: "/tank-level/#comments" } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Check your inbox/);
    assert.equal(ctx.store.members.getByEmail("priya@example.com").verified_at, null, "not verified yet");
    // The emailed link opens a page that asks for the password; only whoever holds the link chooses it.
    let mail;
    for (let i = 0; i < 50 && !(mail = ctx.mailer.outbox.find((m) => JSON.stringify(m.to).includes("priya@example.com"))); i++) await new Promise((r) => setTimeout(r, 20));
    const verify = new URL(mail.html.match(/href="([^"]*\/verify\/[^"]+)"/)[1]).pathname;
    const page = await (await req(reader, verify)).text();
    assert.match(page, /p\*\*\*@example\.com/, "the page names the (masked) address being verified");
    const vToken = field(page, "_csrf");
    res = await req(reader, verify, { method: "POST", form: { _csrf: vToken, password: "short", confirm: "short" } });
    assert.equal(res.status, 400);
    res = await req(reader, verify, { method: "POST", form: { _csrf: vToken, password: "long-enough-1", confirm: "long-enough-1" } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/account/?ok=verified");
  });
  test("signed-in readers see the comment box; pages for them are never cached", async () => {
    const res = await req(reader, "/tank-level/");
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const html = await res.text();
    assert.match(html, /id="compose"/);
    readerCsrf = field(html, "_csrf");
    const anon = await (await req(jar(), "/tank-level/")).text();
    assert.match(anon, /Join the discussion/);
    assert.doesNotMatch(anon, /id="compose"/);
  });
  test("a first comment waits for approval, then later ones go live", async () => {
    let res = await req(reader, "/tank-level/comments/", { method: "POST", form: { _csrf: readerCsrf, body: "Worked first time!" } });
    assert.equal(res.headers.get("location"), "/tank-level/?c=pending#comments");
    assert.doesNotMatch(await (await req(jar(), "/tank-level/")).text(), /Worked first time!/);
    const pending = ctx.store.comments.list({ status: "pending" }).rows[0];
    res = await req(owner, `/admin/comments/${pending.id}/approve`, { method: "POST", form: { _csrf: csrf } });
    assert.equal(res.status, 302);
    assert.match(await (await req(jar(), "/tank-level/")).text(), /Worked first time!/);
    res = await req(reader, "/tank-level/comments/", { method: "POST", form: { _csrf: readerCsrf, body: "A second one.", parent_id: String(pending.id) } });
    assert.match(res.headers.get("location"), /\?c=posted#comment-\d+$/);
    const html = await (await req(jar(), "/tank-level/")).text();
    assert.match(html, /<ol class="replies">[\s\S]*A second one\./);
    assert.match(html, /2 comments/);
  });
  test("comments need a signed-in reader and the session token", async () => {
    let res = await req(jar(), "/tank-level/comments/", { method: "POST", form: { body: "Spam" } });
    assert.match(res.headers.get("location"), /^\/signin\//);
    res = await req(reader, "/tank-level/comments/", { method: "POST", form: { _csrf: "nope", body: "Forged" } });
    assert.equal(res.status, 403);
    res = await req(reader, "/tank-level/comments/", { method: "POST", form: { _csrf: readerCsrf, body: "Cross-site" }, headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
  });
  test("comment text is escaped", async () => {
    await req(reader, "/tank-level/comments/", { method: "POST", form: { _csrf: readerCsrf, body: "<img src=x onerror=alert(1)>" } });
    const html = await (await req(jar(), "/tank-level/")).text();
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
  test("a blocked reader is signed out and can't sign back in", async () => {
    const m = ctx.store.members.getByEmail("priya@example.com");
    await req(owner, `/admin/members/${m.id}/ban`, { method: "POST", form: { _csrf: csrf } });
    assert.match(await (await req(reader, "/tank-level/")).text(), /Join the discussion/);
    let res = await req(reader, "/signin/");
    const token = field(await res.text(), "_csrf");
    res = await req(reader, "/signin/", { method: "POST", form: { _csrf: token, email: "priya@example.com", password: "long-enough-1" } });
    assert.equal(res.status, 401, "a blocked reader gets the same answer as a wrong password");
    await req(owner, `/admin/members/${m.id}/unban`, { method: "POST", form: { _csrf: csrf } });
  });
  test("readers can delete their account and comments with their password", async () => {
    const r = jar();
    let res = await req(r, "/signin/");
    const token = field(await res.text(), "_csrf");
    res = await req(r, "/signin/", { method: "POST", form: { _csrf: token, email: "priya@example.com", password: "long-enough-1" } });
    assert.equal(res.status, 303);
    const page = await (await req(r, "/account/")).text();
    const t = field(page, "_csrf");
    res = await req(r, "/account/delete/", { method: "POST", form: { _csrf: t, password: "wrong-password" } });
    assert.equal(res.status, 400);
    res = await req(r, "/account/delete/", { method: "POST", form: { _csrf: t, password: "long-enough-1" } });
    assert.equal(res.status, 303);
    assert.equal(ctx.store.members.getByEmail("priya@example.com"), null);
    assert.doesNotMatch(await (await req(jar(), "/tank-level/")).text(), /Worked first time!/);
  });
  test("comments can be turned off per post and sign-ups closed", async () => {
    await api(`/posts/${postId}`, { ...POST, comments_enabled: false, intent: "save" });
    assert.doesNotMatch(await (await req(jar(), "/tank-level/")).text(), /id="comments"/);
    const s = ctx.store.settings;
    s.set({ members_signup: false });
    const html = await (await req(jar(), "/signup/")).text();
    assert.match(html, /New accounts are closed/);
    s.set({ members_signup: true });
  });
  test("the admin comment and member screens render", async () => {
    for (const p of ["/admin/comments", "/admin/comments?status=pending", "/admin/members"]) {
      assert.equal((await req(owner, p)).status, 200, p);
    }
    // The reader export is a form button (POST with the token), so an image or link on another page can't start it.
    assert.equal((await req(owner, "/admin/members.csv")).status, 302);
    const csv = await req(owner, "/admin/members.csv", { method: "POST", form: { _csrf: csrf } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
  });
});

describe("business details", () => {
  test("the footer shows only the town; the full address lives on the Contact page", async () => {
    ctx.store.settings.set({ business_name: "Example Works", address_street: "12 Long Street, Big Nagar", address_city: "Coimbatore", address_region: "Tamil Nadu", address_postcode: "641015", address_country: "India", contact_phone: "+91 90000 00000", contact_email: "hello@example.com" });
    const ownerId = ctx.db.prepare("SELECT id FROM users WHERE role = 'owner'").get().id;
    ctx.store.posts.save({ type: "page", status: "published", title: "Contact Us", short_title: "Contact", slug: "contact", excerpt: "How to reach Example Works.", body_md: "**Address:** 12 Long Street, Big Nagar, Coimbatore 641015", author_id: ownerId });
    for (const [slug, title] of [["cookie-policy", "Cookie Policy"], ["privacy-policy", "Privacy Policy"]]) ctx.store.posts.save({ type: "page", status: "published", title, slug, excerpt: `${title} for Example Works.`, body_md: "## What we collect\n\nText.\n\n## Your rights\n\nMore text.", author_id: ownerId });
    const home = await (await req(jar(), "/")).text();
    const contact = home.match(/<div class="foot-col foot-contact">[\s\S]*?<\/div>/)[0];
    assert.match(contact, /Coimbatore, Tamil Nadu, India/);
    assert.doesNotMatch(contact, /Long Street|641015/, "no street or PIN in the footer");
    assert.match(home.match(/<h2 class="foot-title">Company<\/h2>[\s\S]*?<\/ul>/)[0], /<a href="\/contact\/">Contact<\/a>/, "the Contact page is in the Company column");
    // Legal pages sit in the bottom bar, privacy first, before RSS and Sitemap; there's no Legal column.
    assert.doesNotMatch(home, /<h2 class="foot-title">Legal<\/h2>/);
    assert.match(home.match(/<ul class="foot-meta"[\s\S]*?<\/ul>/)[0], /Privacy Policy[\s\S]*Cookie Policy[\s\S]*RSS[\s\S]*Sitemap/);
    const page = await (await req(jar(), "/contact/")).text();
    // The Contact page shows cards built from the business details, with a map link.
    assert.match(page, /<h2>Email us<\/h2>[\s\S]*hello@example\.com/);
    assert.match(page, /<h2>Visit us<\/h2>[\s\S]*<b>Example Works<\/b><br>12 Long Street, Big Nagar/);
    assert.match(page, /href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=12%20Long%20Street/);
    // The About page gets topic cards from the categories and a quick-facts box.
    ctx.store.categories.save({ name: "Projects", slug: "projects", description: "Builds." });
    ctx.store.categories.save({ name: "Guides", slug: "guides", description: "How-tos." });
    ctx.store.posts.save({ type: "post", status: "published", title: "A First Guide", slug: "a-first-guide", excerpt: "The first guide.", body_md: "Text.", author_id: ownerId, category_id: ctx.store.categories.getBySlug("guides").id });
    ctx.store.posts.save({ type: "page", status: "published", title: "About Example Works", short_title: "About", slug: "about", excerpt: "Who we are.", body_md: "We build things.", author_id: ownerId });
    const about = await (await req(jar(), "/about/")).text();
    assert.match(about, /class="lp-card"[\s\S]*<a href="\/category\/guides\/">1 post<\/a>/);
    assert.match(about, /<dt>Run by<\/dt><dd>Example Works<\/dd>/);
    assert.match(about, /We build things\./);
    // "Projects" has no posts yet, so its page is a 404: its card stays, but nothing links to it.
    assert.match(about, /<h2>Projects<\/h2>[\s\S]*?Coming soon/);
    assert.doesNotMatch(about, /href="\/category\/projects\/"/, "an empty category isn't linked");
    assert.equal((await req(jar(), "/category/projects/")).status, 404);
    assert.match(page, /"@type":"ContactPage","about":\{"@id":"[^"]+#organization"\}/);
    // Legal pages: the policy on its own sheet, a contents list, the other policies and a print button.
    const privacy = await (await req(jar(), "/privacy-policy/")).text();
    assert.match(privacy, /<div class="lg-doc">/);
    assert.match(privacy, /Last updated <time datetime=/);
    assert.match(privacy, /<h2 id="toc-h">On this page<\/h2>[\s\S]*What we collect[\s\S]*Your rights/);
    assert.match(privacy, /<h2 id="other-h">Other policies<\/h2>[\s\S]*Cookie Policy/);
    assert.match(privacy, /data-print/);
    // The Advertise page lists the banner places that are switched on, with a booking email.
    ctx.store.posts.save({ type: "page", status: "published", title: "Advertise With Us", short_title: "Advertise", slug: "advertise", excerpt: "Banner places and sizes.", body_md: "", author_id: ownerId });
    ctx.store.settings.set({ ads_places_off: ["footer"] });
    const ad = await (await req(jar(), "/advertise/")).text();
    assert.equal((ad.match(/class="am-place"/g) || []).length, 8, "a place switched off isn't offered");
    assert.doesNotMatch(ad, /Bottom of every page/);
    assert.match(ad, /href="mailto:hello@example\.com\?subject=Advertising%20on%20/);
    ctx.store.settings.set({ ads_places_off: [] });
    // Two accounts on one network are told apart by name.
    ctx.store.settings.set({ social_links: ["https://www.instagram.com/brand.one/", "https://www.instagram.com/brand_two", "https://github.com/example"] });
    const social = (await (await req(jar(), "/")).text()).match(/<ul class="social"[\s\S]*?<\/ul>/)[0];
    assert.match(social, /title="Instagram \(@brand\.one\)"[\s\S]*title="Instagram \(@brand_two\)"[\s\S]*title="GitHub"/);
    // The newsletter email keeps the full postal address.
    assert.match(ctx.newsletter.render({ subject: "Hi", preheader: "", body_md: "", postIds: [] }).html, /12 Long Street, Big Nagar/);
  });
});
