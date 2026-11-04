// Admin > Design: the catalogue, the colour themes and font pairs, "Light only", saving, and the live preview frame.
// In-process, no network. Run: node --test test/design.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createApp } from "../src/web/app.js";
import { THEME_SCRIPT } from "../src/web/assets.js";
import { cleanDesign, DESIGN_DEFAULTS, DESIGN_GROUPS, FONT_PAIRS, isDesign, PALETTES, siteDesign, themeCss } from "../src/design.js";
import { FAMILIES, fontFaces, preloadFiles } from "../src/render/fonts.js";

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

async function newBlog() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quillo-design-"));
  const { app, ctx } = createApp({ dataDir, production: true, outbound: false, mailTransport: { jsonTransport: true }, mailDelayMs: 0, setupToken: "test-setup" });
  const req = async (j, p, { method = "GET", form } = {}) => {
    const headers = { origin: "http://localhost", cookie: j.header() };
    let body;
    if (form) {
      body = new URLSearchParams(form);
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const res = await app.request(`http://localhost${p}`, { method, headers, body, redirect: "manual" });
    j.store(res);
    return res;
  };
  const owner = jar();
  const setupPage = await (await req(owner, `${A}/setup`)).text();
  await req(owner, `${A}/setup`, { method: "POST", form: { _csrf: field(setupPage, "_csrf"), setup_token: "test-setup", site_url: "http://localhost", site_title: "Design Test", name: "Kim Owner", email: "kim@example.com", password: PW } });
  const csrf = csrfOf(await (await req(owner, `${A}/`)).text());
  const signIn = async (email, password) => {
    const j = jar();
    ctx.limiters.login.reset("unknown");
    const token = field(await (await req(j, `${A}/login`)).text(), "_csrf");
    await req(j, `${A}/login`, { method: "POST", form: { _csrf: token, email, password } });
    return j;
  };
  const save = (choices) => req(owner, `${A}/design`, { method: "POST", form: { _csrf: csrf, ...DESIGN_DEFAULTS, ...choices } });
  const home = async () => (await req(jar(), "/")).text();
  return { app, ctx, owner, req, csrf, signIn, save, home };
}

// WCAG contrast ratio of two #RRGGBB colours.
const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("the design catalogue", () => {
  test("every group starts on its first option, which is the original look", () => {
    for (const g of DESIGN_GROUPS) assert.equal(DESIGN_DEFAULTS[g.key], g.options[0].id, g.key);
    assert.deepEqual({ palette: DESIGN_DEFAULTS.palette, fonts: DESIGN_DEFAULTS.fonts, mode: DESIGN_DEFAULTS.mode }, { palette: "copper", fonts: "inter", mode: "both" });
    assert.ok(DESIGN_GROUPS.length >= 14, "all the picker's groups are listed");
  });

  test("unknown groups and options fall back to the defaults; only known choices are a valid setting", () => {
    assert.deepEqual(cleanDesign({ palette: "blue", fonts: "comic-sans", extra: "x" }), { ...DESIGN_DEFAULTS, palette: "blue" });
    assert.deepEqual(cleanDesign(null), DESIGN_DEFAULTS);
    assert.deepEqual(cleanDesign(["blue"]), DESIGN_DEFAULTS);
    assert.equal(isDesign({ palette: "teal" }), true, "a saved design may leave groups out");
    assert.equal(isDesign({ palette: "pink" }), false);
    assert.equal(isDesign({ colour: "teal" }), false);
    assert.equal(isDesign("teal"), false);
  });

  test("the stylesheet has a light, a dark-by-device and a dark-by-switch block for each theme, and a block for each font pair", () => {
    const css = themeCss();
    for (const id of Object.keys(PALETTES)) {
      assert.ok(css.includes(`:root[data-d-palette="${id}"]{`), id);
      assert.ok(css.includes(`@media (prefers-color-scheme: dark){:root[data-d-palette="${id}"]:not([data-theme="light"]){`), id);
      assert.ok(css.includes(`:root[data-d-palette="${id}"][data-theme="dark"]{`), id);
    }
    assert.ok(!css.includes('data-d-palette="copper"'), "Copper & Slate is the stylesheet's own default");
    for (const id of Object.keys(FONT_PAIRS).filter((f) => f !== "inter")) assert.ok(css.includes(`:root[data-d-fonts="${id}"]{`), id);
    assert.match(css, /data-d-fonts="manrope"\]\{[^}]*--font-text:"Source Serif 4",Georgia/);
  });

  test("text stays readable in every theme, light and dark (contrast 4.5 or more)", () => {
    for (const [id, p] of Object.entries(PALETTES)) {
      for (const [mode, t] of Object.entries(p)) {
        for (const surface of ["bg", "sf", "sf2"]) {
          for (const text of ["ink", "ink2", "ink3", "acText"]) assert.ok(contrast(t[text], t[surface]) >= 4.5, `${id} ${mode}: ${text} on ${surface} is ${contrast(t[text], t[surface]).toFixed(2)}`);
        }
        assert.ok(contrast(t.acInk, t.ac) >= 4.5, `${id} ${mode}: button text`);
        assert.ok(contrast(t.hiText, t.hiSoft) >= 4.5, `${id} ${mode}: highlight text`);
      }
    }
  });

  test("every font pair's families are self-hosted, and its preload files exist", () => {
    const { files } = fontFaces("/assets/fonts/");
    for (const [id, pair] of Object.entries(FONT_PAIRS)) {
      for (const family of [pair.head, pair.body, pair.text, pair.mono].filter(Boolean)) assert.ok(FAMILIES[family], `${id}: ${family}`);
      for (const file of preloadFiles(pair)) assert.ok(files.has(file) && fs.existsSync(files.get(file)), `${id}: ${file}`);
    }
    assert.deepEqual(preloadFiles(FONT_PAIRS.inter), ["inter-latin-400-normal.woff2", "inter-latin-700-normal.woff2"], "the original pair preloads what it always did");
  });

  test("the browser bar colours follow the theme", () => {
    assert.deepEqual(siteDesign({}).themeColor, { light: "#FFFFFF", dark: "#191C1F" });
    assert.deepEqual(siteDesign({ palette: "blue" }).themeColor, { light: "#FFFFFF", dark: "#111A2E" });
  });

  test("the head script ignores a reader's saved dark choice when the blog is Light only", () => {
    const run = (mode) => {
      const html = { dataset: mode ? { dMode: mode } : {}, classList: { add() {} } };
      vm.runInNewContext(THEME_SCRIPT, { document: { documentElement: html }, localStorage: { getItem: () => "dark" } });
      return html.dataset.theme;
    };
    assert.equal(run("both"), "dark");
    assert.equal(run(undefined), "dark", "the admin has no mode and keeps its own switch");
    assert.equal(run("light"), undefined);
  });
});

describe("Admin > Design", () => {
  test("a new blog shows the original look: Copper & Slate, Inter, light and dark", async () => {
    const b = await newBlog();
    const html = await b.home();
    assert.match(html, /<html lang="[^"]+" data-base="" data-d-palette="copper" data-d-fonts="inter" data-d-mode="both">/);
    assert.match(html, /<meta name="theme-color" content="#FFFFFF" media="\(prefers-color-scheme: light\)">/);
    assert.match(html, /<meta name="theme-color" content="#191C1F" media="\(prefers-color-scheme: dark\)">/);
    assert.match(html, /class="icon-btn theme-toggle"/);
    assert.match(html, /<link rel="preload" href="\/assets\/fonts\/inter-latin-400-normal.woff2"/);
  });

  test("the page lists every choice, marks the original, and shows the preview frame", async () => {
    const b = await newBlog();
    const res = await b.req(b.owner, `${A}/design`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const id of Object.keys(PALETTES)) assert.match(html, new RegExp(`name="palette" value="${id}"`));
    for (const id of Object.keys(FONT_PAIRS)) assert.match(html, new RegExp(`name="fonts" value="${id}"`));
    assert.match(html, /name="palette" value="copper" data-default="yes" checked>/);
    assert.match(html, /<iframe id="design-frame"[^>]+src="\/admin\/design\/preview\?page=home&amp;palette=copper&amp;fonts=inter&amp;mode=both"/);
    assert.match(html, /More choices on the way/);
    assert.match(html, /href="\/admin\/design" aria-current="page"/);
    // This page, and only this page, may show the site in a frame.
    assert.match(res.headers.get("content-security-policy"), /frame-src 'self'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    const other = await b.req(b.owner, `${A}/settings`);
    assert.match(other.headers.get("content-security-policy"), /frame-src 'none'/);
    assert.match(other.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  });

  test("saving a theme and font pair changes the public site and the admin", async () => {
    const b = await newBlog();
    const res = await b.save({ palette: "teal", fonts: "manrope" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `${A}/design?ok=design`);
    assert.deepEqual(b.ctx.store.settings.get("design"), { ...DESIGN_DEFAULTS, palette: "teal", fonts: "manrope" });
    const html = await b.home();
    assert.match(html, /data-d-palette="teal" data-d-fonts="manrope" data-d-mode="both"/);
    assert.match(html, /<meta name="theme-color" content="#0C1E21" media="\(prefers-color-scheme: dark\)">/);
    assert.match(html, /href="\/assets\/fonts\/source-serif-4-latin-400-normal.woff2"/);
    assert.match(html, /href="\/assets\/fonts\/manrope-latin-700-normal.woff2"/);
    const font = await b.req(jar(), "/assets/fonts/manrope-latin-700-normal.woff2");
    assert.equal(font.status, 200);
    const admin = await (await b.req(b.owner, `${A}/`)).text();
    assert.match(admin, /<html lang="en" data-d-palette="teal" data-d-fonts="manrope">/);
    assert.match(await (await b.req(b.owner, `${A}/design?ok=design`)).text(), /Design saved\. Your blog shows it now\./);
  });

  test("Light only: always light, one browser bar colour, no switch", async () => {
    const b = await newBlog();
    await b.save({ mode: "light" });
    const html = await b.home();
    assert.match(html, /data-d-mode="light" data-theme="light">/);
    assert.doesNotMatch(html, /class="icon-btn theme-toggle"/);
    assert.match(html, /<meta name="theme-color" content="#FFFFFF">/);
    assert.doesNotMatch(html, /<meta name="theme-color"[^>]*media=/);
  });

  test("unknown choices are ignored, and groups that aren't ready keep their default", async () => {
    const b = await newBlog();
    await b.save({ palette: "rainbow", fonts: "plex", header: "dark", home: "magazine" });
    assert.deepEqual(b.ctx.store.settings.get("design"), { ...DESIGN_DEFAULTS, fonts: "plex" });
  });

  test("the preview draws the home page or newest article with the choices in its address, and only for admins", async () => {
    const b = await newBlog();
    const ownerId = b.ctx.db.prepare("SELECT id FROM users WHERE role = 'owner'").get().id;
    b.ctx.store.posts.save({ type: "post", status: "published", title: "Garden Lights", slug: "garden-lights", excerpt: "Solar lights for the garden.", body_md: "## Parts\n\nSome text.", author_id: ownerId, category_id: null, tags: "" }, 0, {});
    b.ctx.invalidate();

    let res = await b.req(b.owner, `${A}/design/preview?page=home&palette=red&fonts=outfit&mode=light`);
    assert.equal(res.status, 200);
    let html = await res.text();
    assert.match(html, /data-d-palette="red" data-d-fonts="outfit" data-d-mode="light" data-theme="light">/);
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'self'/);
    assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(res.headers.get("cache-control"), /no-store/);
    assert.doesNotMatch(html, /const toggle = document.querySelector/, "the site's own script is left out of the preview");

    html = await (await b.req(b.owner, `${A}/design/preview?page=post&palette=nope`)).text();
    assert.match(html, /Garden Lights/);
    assert.match(html, /data-d-palette="copper"/, "an unknown choice shows the default");
    // Trying a look in the preview saves nothing and leaves the public site alone.
    assert.deepEqual(b.ctx.store.settings.get("design"), DESIGN_DEFAULTS);
    assert.match(await b.home(), /data-d-palette="copper"/);

    // Signed out: the sign-in page, not the preview.
    res = await b.req(jar(), `${A}/design/preview?page=home`);
    assert.notEqual(res.status, 200);
    // Staff without the settings permission can neither open, preview nor save.
    await b.ctx.store.users.create({ email: "aki@example.com", password: "author password 1", name: "Aki Author", role: "author" }, { actor: "system" });
    const aki = await b.signIn("aki@example.com", "author password 1");
    assert.equal((await b.req(aki, `${A}/design`)).status, 403);
    assert.equal((await b.req(aki, `${A}/design/preview?page=home`)).status, 403);
    const akiCsrf = csrfOf(await (await b.req(aki, `${A}/`)).text());
    assert.equal((await b.req(aki, `${A}/design`, { method: "POST", form: { _csrf: akiCsrf, palette: "red" } })).status, 403);
    assert.deepEqual(b.ctx.store.settings.get("design"), DESIGN_DEFAULTS);
  });
});
