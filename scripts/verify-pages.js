// Crawls the running blog in Edge/Chrome at 375px and 1280px, light and dark, and checks:
// no sideways scrolling, no third-party font/script/style requests, visible focus rings,
// and WCAG AA contrast for all visible text. Screenshots go to test/output/.
//
// Usage: npm run verify -- http://localhost:4100/ [--allow-remote]
// To check the admin screens too, put the sign-in details in the environment (not on the command line):
//   BLOG_ADMIN_EMAIL=you@example.com BLOG_ADMIN_PASSWORD=... npm run verify -- http://localhost:4100/
// A two-step account also needs BLOG_ADMIN_CODE=<the current 6-digit code>. Without BLOG_ADMIN_EMAIL only the public pages are checked.
// It only runs against a blog on this computer unless you add --allow-remote.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { ROOT } from "../src/config.js";

// Sign-in details come from the environment, never the command line (where they would show in process lists and shell history).
const args = process.argv.slice(2);
const allowRemote = args.includes("--allow-remote");
const positional = args.filter((a) => !a.startsWith("--"));
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (positional.length > 1) fail("Don't put an email or password on the command line. Set BLOG_ADMIN_EMAIL and BLOG_ADMIN_PASSWORD in the environment instead.\nUsage: npm run verify -- [http://localhost:4100/] [--allow-remote]");
const email = process.env.BLOG_ADMIN_EMAIL || "";
const password = process.env.BLOG_ADMIN_PASSWORD || "";
// Only a blog on this computer, unless you say otherwise: with sign-in details this opens every admin screen.
// A full 127.x.x.x address only: a public name such as 127.attacker.example must not pass.
const isLocal = (host) => host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
const startUrl = positional[0] || "http://localhost:4100/";
if (!URL.canParse(startUrl)) fail(`"${startUrl}" is not a web address.`);
const start = new URL(startUrl);
if (!allowRemote && !isLocal(start.hostname)) fail(`${start.host} is not on this computer. Add --allow-remote to check it anyway (it only reads pages, but it signs in if BLOG_ADMIN_EMAIL is set).`);
const SHOTS = path.join(ROOT, "test", "output");
const MAX_PAGES = 18;

// Runs in the page: contrast of every visible text node against its effective background.
function contrastAudit() {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== "none" && n !== el) return null; // text over an image or gradient: skip
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return parse(getComputedStyle(document.body).backgroundColor);
  };
  const fails = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim()) continue;
    const el = node.parentElement;
    if (!el || seen.has(el) || el.closest(".sr-only, [hidden], .yt-poster, .h-anchor, dialog:not([open]), .serp, .hp")) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || +cs.opacity === 0 || !el.getClientRects().length) continue;
    const fg = parse(cs.color);
    const bg = bgOf(el);
    if (!fg || !bg) continue;
    const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700);
    if (ratio < (large ? 3 : 4.5)) fails.push(`${ratio.toFixed(2)}:1 "${node.textContent.trim().slice(0, 40)}" (${cs.color} on rgb(${bg.r}, ${bg.g}, ${bg.b}), ${size}px)`);
  }
  return fails;
}

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "msedge" });
fs.mkdirSync(SHOTS, { recursive: true, mode: 0o700 });
// Admin screens that list readers, subscribers, staff or mail settings are not saved as pictures: the addresses on them would end up on disk.
const SENSITIVE = /^admin\/(members|users|newsletter\/(subscribers|settings))(\/|$)/;
const problems = [];
const thirdParty = new Set();
const shotName = (u, w, s) => `${(new URL(u).pathname.replace(/^\/|\/$/g, "").replace(/[/?=&]+/g, "_") || "root").slice(0, 80)}-${w}-${s}.png`;

async function check(url, { width, scheme, context }) {
  const page = await context.newPage();
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.host === start.host || u.protocol === "data:" || u.protocol === "blob:") return;
    const type = req.resourceType();
    thirdParty.add(`${type} ${u.host}`);
    if (["font", "script", "stylesheet"].includes(type)) problems.push(`${url}: third-party ${type} ${req.url()}`);
  });
  const res = await page.goto(url, { waitUntil: "networkidle" });
  const tag = `${new URL(url).pathname} @${width} ${scheme}`;
  if (!res || res.status() >= 400) problems.push(`${tag}: HTTP ${res?.status()}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) problems.push(`${tag}: page scrolls sideways by ${overflow}px`);
  for (const f of await page.evaluate(contrastAudit)) problems.push(`${tag}: contrast ${f}`);
  if (width === 375 && scheme === "light") {
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      const f = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        // The ring may be drawn by the element or by a wrapper using :focus-within.
        const ring = (n) => {
          const cs = getComputedStyle(n);
          return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2;
        };
        const visible = ring(el) || (el.parentElement && ring(el.parentElement));
        return { name: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 30), visible };
      });
      if (f && !f.visible) problems.push(`${tag}: no focus ring on "${f.name}"`);
    }
  }
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 700) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(SHOTS, shotName(url, width, scheme)), fullPage: true });
  const links = await page.$$eval("a[href]", (as) => as.map((a) => a.href));
  await page.close();
  return links;
}

// Crawl the public site from the start URL.
const queue = [start.href];
const seen = new Set();
const pages = [];
while (queue.length && pages.length < MAX_PAGES) {
  const url = queue.shift().split("#")[0];
  if (seen.has(url)) continue;
  seen.add(url);
  pages.push(url);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light", reducedMotion: "reduce" });
  const links = await check(url, { width: 1280, scheme: "light", context: ctx });
  await ctx.close();
  for (const l of links) {
    const u = new URL(l);
    if (u.host === start.host && u.pathname.startsWith(start.pathname) && !u.pathname.includes("/admin") && !u.pathname.includes("/media/") && !u.pathname.includes("/source/") && !u.pathname.endsWith(".zip") &&!/\.(xml|txt|png)$/.test(u.pathname) && !seen.has(u.href.split("#")[0])) queue.push(u.href);
  }
}
for (const url of pages) {
  for (const [width, scheme] of [[375, "light"], [375, "dark"], [1280, "dark"]]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: "reduce" });
    await check(url, { width, scheme, context: ctx });
    await ctx.close();
  }
}

// Admin screens, when credentials are given.
if (email && password) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  const page = await ctx.newPage();
  await page.goto(new URL("admin/login", start).href);
  // The sign-in page must still be on the checked host: a redirect elsewhere would receive the password.
  if (new URL(page.url()).host !== start.host) fail(`The sign-in page is on ${new URL(page.url()).host}, not on ${start.host}. Stopping before the password is typed.`);
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", password);
  await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  if (page.url().includes("/admin/login/verify")) {
    if (!process.env.BLOG_ADMIN_CODE) fail("This account uses two-step sign-in. Run again with BLOG_ADMIN_CODE=<the current 6-digit code>, or leave out BLOG_ADMIN_EMAIL to check only the public pages.");
    await page.fill("input[name=code]", process.env.BLOG_ADMIN_CODE);
    await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  }
  if (page.url().includes("/admin/login")) fail("Sign-in failed: check the email and password (and the two-step code). A new account must first sign in once in a browser to choose its own password.");
  const firstPost = await page.evaluate(async (base) => {
    const html = await (await fetch(`${base}admin/posts`)).text();
    return (html.match(/href="([^"]*\/admin\/posts\/\d+)"/) || [])[1];
  }, start.href);
  for (const p of ["admin/", "admin/posts", firstPost, "admin/media", "admin/categories", "admin/comments", "admin/members", "admin/ads", "admin/menus", "admin/newsletter", "admin/newsletter/new", "admin/newsletter/subscribers", "admin/newsletter/settings", "admin/analytics", "admin/settings"].filter(Boolean)) {
    const url = new URL(p, start).href;
    await page.goto(url, { waitUntil: "networkidle" });
    for (const f of await page.evaluate(contrastAudit)) problems.push(`${new URL(url).pathname} (admin): contrast ${f}`);
    if (!SENSITIVE.test(p)) await page.screenshot({ path: path.join(SHOTS, `admin-${p.replace(/^.*admin\/?/, "").replace(/\//g, "_") || "dashboard"}.png`), fullPage: true });
  }
  await ctx.close();
}

await browser.close();
console.log(`Checked ${pages.length} public pages x 4 views${email ? " + admin screens" : ""}. Screenshots: ${path.relative(ROOT, SHOTS)}`);
console.log(`Third-party requests seen: ${[...thirdParty].join(", ") || "none"}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n  ${[...new Set(problems)].join("\n  ")}`);
  process.exit(1);
}
console.log("All page checks passed.");
