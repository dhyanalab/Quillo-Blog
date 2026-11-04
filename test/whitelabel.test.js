// White-label: a new blog starts neutral and takes its name, description, time zone, mark, region and post word from
// setup and Settings; topic features are switches; existing blogs keep their look through migration 008.
// In-process, no network. Run: node --test test/whitelabel.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/web/app.js";

const A = "/admin";
const PW = "correct horse battery";

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
const field = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];
const csrfOf = (html) => (html.match(/data-csrf="([^"]+)"/) || [])[1];

// A fresh blog, set up through the first-run form with the given extra fields.
async function newBlog(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quillo-wl-"));
  const { app, ctx } = createApp({ dataDir, production: true, outbound: false, mailTransport: { jsonTransport: true }, mailDelayMs: 0, setupToken: "test-setup" });
  const owner = jar();
  const req = async (j, p, { method = "GET", form } = {}) => {
    const headers = { origin: "http://localhost", cookie: j.header() };
    let body;
    if (form) {
      // A list becomes one field per value, as a browser sends ticked checkboxes.
      body = form instanceof URLSearchParams ? form : new URLSearchParams(Object.entries(form).flatMap(([k, v]) => [].concat(v).map((x) => [k, x])));
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const res = await app.request(`http://localhost${p}`, { method, headers, body, redirect: "manual" });
    j.store(res);
    return res;
  };
  const setupPage = await (await req(owner, `${A}/setup`)).text();
  const res = await req(owner, `${A}/setup`, {
    method: "POST",
    form: { _csrf: field(setupPage, "_csrf"), setup_token: "test-setup", site_url: "http://localhost", name: "Kim Owner", email: "kim@example.com", password: PW, ...extra },
  });
  const csrf = csrfOf(await (await req(owner, `${A}/`)).text());
  return { app, ctx, owner, req, setupPage, setupRes: res, csrf, anon: () => req(jar(), "/") };
}

describe("first-run setup names the blog", () => {
  test("the setup page asks for the name, description, time zone and the footer credit", async () => {
    const b = await newBlog({ site_title: "The Weekend Kitchen" });
    assert.match(b.setupPage, /name="site_description"/);
    assert.match(b.setupPage, /<select name="timezone" data-guess-zone>/);
    assert.match(b.setupPage, /<option selected>UTC<\/option>/);
    assert.match(b.setupPage, /<option>Asia\/Kolkata<\/option>/, "current zone names are offered");
    assert.match(b.setupPage, /name="show_powered_by" value="1" checked/);
    assert.doesNotMatch(b.setupPage, /iotstudio/i);
  });

  test("what setup saves, and a neutral public site", async () => {
    const b = await newBlog({ site_title: "The Weekend Kitchen", site_description: "Simple recipes for busy weekends.", timezone: "Asia/Kolkata", show_powered_by: "1" });
    assert.equal(b.setupRes.status, 302);
    const s = b.ctx.store.settings;
    assert.equal(s.get("site_title"), "The Weekend Kitchen");
    assert.equal(s.get("org_name"), "The Weekend Kitchen");
    assert.equal(s.get("site_description"), "Simple recipes for busy weekends.");
    assert.equal(s.get("timezone"), "Asia/Kolkata");
    assert.equal(s.get("show_powered_by"), true);
    const html = await (await b.anon()).text();
    assert.match(html, /<span class="brand-mark brand-initials" aria-hidden="true">TW<\/span>/);
    assert.match(html, /<li class="foot-powered">Powered by Quillo<\/li>/);
    assert.match(html, /<meta property="og:locale" content="en_US">/);
    assert.match(html, /placeholder="Search the posts"/);
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,[^"]*TW/);
    assert.doesNotMatch(html, /IoT Studio|ESP32|Arduino/);
    assert.doesNotMatch(html, /Your brand here/, "a new blog shows no empty sponsor boxes");
  });

  test("the footer credit stays off when unticked, and a blog needs a name", async () => {
    const b = await newBlog({ site_title: "Plain Blog" });
    assert.equal(b.ctx.store.settings.get("show_powered_by"), false);
    assert.doesNotMatch(await (await b.anon()).text(), /Powered by/);
    const unnamed = await newBlog({ site_title: "  " });
    assert.equal(unnamed.setupRes.status, 400);
    assert.match(await unnamed.setupRes.text(), /Give your blog a name/);
  });
});

describe("Settings: mark, region, post word and features", () => {
  const saveSettings = (b, form) => b.req(b.owner, `${A}/settings`, { method: "POST", form: { _csrf: b.csrf, site_title: "Trail Notes", site_url: "http://localhost", timezone: "UTC", posts_per_page: "12", ...form } });

  test("an icon mark, another region and another word for posts reach the public site", async () => {
    const b = await newBlog({ site_title: "Trail Notes" });
    const res = await saveSettings(b, { brand_mark: "book", og_locale: "en_GB", post_noun: "Hike", post_noun_plural: "Hikes" });
    assert.equal(res.status, 302, await res.clone().text());
    const html = await (await b.anon()).text();
    assert.match(html, /<span class="brand-mark" aria-hidden="true"><svg/);
    assert.match(html, /<meta property="og:locale" content="en_GB">/);
    assert.match(html, /placeholder="Search the hikes"/, "the word is lower-cased");
    const page = await (await b.req(b.owner, `${A}/settings`)).text();
    assert.match(page, /<option value="book" selected>Book<\/option>/);
    assert.match(page, /<option value="en_GB" selected>English, United Kingdom<\/option>/);
  });

  test("unknown values fall back to the defaults", async () => {
    const b = await newBlog({ site_title: "Trail Notes" });
    await saveSettings(b, { brand_mark: "skull", og_locale: "xx_YY", post_features: ["code", "rockets"] });
    const s = b.ctx.store.settings;
    assert.equal(s.get("brand_mark"), "initials");
    assert.equal(s.get("og_locale"), "en_US");
    assert.deepEqual(s.get("post_features"), ["code"]);
    assert.throws(() => s.set({ post_features: ["rockets"] }), /Invalid value/);
  });

  test("a saved old zone name shows as its current name, and current names save", async () => {
    const b = await newBlog({ site_title: "Trail Notes" });
    b.ctx.store.settings.set({ timezone: "Asia/Calcutta" });
    assert.match(await (await b.req(b.owner, `${A}/settings`)).text(), /<option selected>Asia\/Kolkata<\/option>/);
    await saveSettings(b, { timezone: "Asia/Kolkata" });
    assert.equal(b.ctx.store.settings.get("timezone"), "Asia/Kolkata");
  });

  test("topic features are off on a new blog: hidden in the editor and on posts, back when switched on", async () => {
    const b = await newBlog({ site_title: "Maker Log" });
    assert.deepEqual(b.ctx.store.settings.get("post_features"), []);
    const editor = await (await b.req(b.owner, `${A}/posts/new`)).text();
    assert.match(editor, /<section class="ed-section" id="ed-source" aria-labelledby="ed-source-h" hidden>/);
    assert.match(editor, /<section class="ed-section" id="ed-downloads" aria-labelledby="ed-downloads-h" hidden>/);
    assert.match(editor, /<label class="field" hidden><span>Tested with/);

    const ownerId = b.ctx.store.users.getByEmail("kim@example.com").id;
    b.ctx.store.posts.save({ type: "post", status: "published", title: "Blink", slug: "blink", excerpt: "Blink an LED with two lines of code.", body_md: "Text.", author_id: ownerId, source_files: [{ name: "main.py", lang: "python", code: "print(1)\n" }], tested_with: ["Board v2"] });
    let post = await (await b.req(jar(), "/blink/")).text();
    assert.doesNotMatch(post, /id="source-code"/);
    assert.doesNotMatch(post, /Tested with/);
    assert.equal((await b.req(jar(), "/blink/source/main.py")).status, 404);

    await saveSettings(b, { site_title: "Maker Log", post_features: ["code", "downloads", "tested"] });
    assert.doesNotMatch(await (await b.req(b.owner, `${A}/posts/new`)).text(), /id="ed-source" aria-labelledby="ed-source-h" hidden/);
    post = await (await b.req(jar(), "/blink/")).text();
    assert.match(post, /id="source-code"/);
    assert.match(post, /Tested with/);
    assert.equal((await b.req(jar(), "/blink/source/main.py")).status, 200);
  });
});

describe("the Advertise page text is the owner's", () => {
  test("new blogs get general text; Admin > Ads changes it", async () => {
    const b = await newBlog({ site_title: "Trail Notes" });
    const ownerId = b.ctx.store.users.getByEmail("kim@example.com").id;
    b.ctx.store.posts.save({ type: "page", status: "published", title: "Advertise with us", slug: "advertise", excerpt: "Reach our readers.", body_md: "", author_id: ownerId });
    let page = await (await b.req(jar(), "/advertise/")).text();
    assert.match(page, /<h2>Readers who come back<\/h2>/);
    assert.match(page, /<span>Shops and online stores<\/span>/);
    assert.doesNotMatch(page, /Electronics|sensor/i);

    const res = await b.req(b.owner, `${A}/ads/settings`, {
      method: "POST",
      form: new URLSearchParams([["_csrf", b.csrf], ["ads_empty", "hide"], ["ads_contact_url", ""], ["pitch_title", "Hikers who buy gear"], ["pitch_text", "Our readers plan trips and buy boots."], ["pitch_title", "Next to trail guides"], ["pitch_text", "Seen where people choose routes."], ["pitch_title", ""], ["pitch_text", ""], ["ads_who", "Outdoor shops\n\nTravel agents\n"]]),
    });
    assert.equal(res.status, 302);
    const s = b.ctx.store.settings;
    assert.deepEqual(s.get("ads_pitch").map((r) => r.title), ["Hikers who buy gear", "Next to trail guides"]);
    assert.deepEqual(s.get("ads_pitch").map((r) => r.icon), ["users", "eye"], "each reason keeps its icon");
    assert.deepEqual(s.get("ads_who"), ["Outdoor shops", "Travel agents"]);
    page = await (await b.req(jar(), "/advertise/")).text();
    assert.match(page, /<h2>Hikers who buy gear<\/h2>/);
    assert.match(page, /<span>Travel agents<\/span>/);

    // The older form (without the text fields) leaves the text alone.
    await b.req(b.owner, `${A}/ads/settings`, { method: "POST", form: { _csrf: b.csrf, ads_empty: "show", ads_contact_url: "" } });
    assert.deepEqual(s.get("ads_who"), ["Outdoor shops", "Travel agents"]);
  });
});

describe("migration 008 keeps an existing blog as it was", () => {
  const sql = fs.readFileSync(new URL("../src/migrations/008_white_label.sql", import.meta.url), "utf8");

  test("a brand-new database gets none of the old settings", async () => {
    const b = await newBlog({ site_title: "Fresh" });
    assert.equal(b.ctx.store.settings.get("brand_mark"), "initials");
    assert.equal(b.ctx.store.settings.get("post_noun"), "post");
  });

  test("a blog with staff accounts keeps its mark, features, wording and region; saved values stay", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quillo-wl-mig-"));
    const { ctx } = createApp({ dataDir, production: true, outbound: false, mailTransport: { jsonTransport: true }, setupToken: "test-setup" });
    await ctx.store.users.createOwnerIfNone({ email: "old@example.com", password: PW, name: "Old Owner" });
    ctx.store.settings.set({ site_title: "Kept Title" });
    // Run the update again as it ran on a blog that already existed.
    ctx.db.exec(sql);
    ctx.store.settings.set({ timezone: ctx.store.settings.get("timezone") }); // reload the settings cache
    const s = ctx.store.settings;
    assert.equal(s.get("brand_mark"), "chip");
    assert.equal(s.get("ads_empty"), "show", "empty sponsor boxes stay as they were");
    assert.deepEqual(s.get("post_features"), ["code", "downloads", "tested"]);
    assert.equal(s.get("post_noun"), "project");
    assert.equal(s.get("post_noun_plural"), "projects");
    assert.equal(s.get("og_locale"), "en_IN");
    assert.equal(s.get("ads_who")[0], "Electronics shops and distributors");
    assert.equal(s.get("newsletter_text"), "Leave your email and we'll write when a new project goes live.");
    assert.equal(s.get("site_title"), "Kept Title", "a value the blog had saved is kept");
  });
});
