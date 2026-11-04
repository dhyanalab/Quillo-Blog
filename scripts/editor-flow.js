// Drives the admin editor in Edge like a person would and fails on any browser error:
// write in Markdown and visual mode, add a feature image, source code and a PDF, publish, unpublish, delete.
// It signs in as an admin and publishes, then deletes, a real post, so it only runs against a blog on this computer unless you add --allow-remote.
// Usage (the sign-in details come from the environment):
//   BLOG_ADMIN_EMAIL=you@example.com BLOG_ADMIN_PASSWORD=... node scripts/editor-flow.js http://localhost:4100/
// An account with two-step sign-in also needs BLOG_ADMIN_CODE=<the current 6-digit code>.
import { chromium } from "playwright-core";
import sharp from "sharp";

// Sign-in details come from the environment, never the command line (where they would show in process lists and shell history).
const args = process.argv.slice(2);
const allowRemote = args.includes("--allow-remote");
const positional = args.filter((a) => !a.startsWith("--"));
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (positional.length > 1) fail("Don't put an email or password on the command line. Set BLOG_ADMIN_EMAIL and BLOG_ADMIN_PASSWORD in the environment instead.\nUsage: BLOG_ADMIN_EMAIL=... BLOG_ADMIN_PASSWORD=... node scripts/editor-flow.js [http://localhost:4100/] [--allow-remote]");
const email = process.env.BLOG_ADMIN_EMAIL || "";
const password = process.env.BLOG_ADMIN_PASSWORD || "";
// Only a blog on this computer, unless you say otherwise: this script publishes and deletes a real post.
// A full 127.x.x.x address only: a public name such as 127.attacker.example must not pass.
const isLocal = (host) => host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
const base = positional[0] || "http://localhost:4100/";
if (!URL.canParse(base)) fail(`"${base}" is not a web address.`);
if (!allowRemote && !isLocal(new URL(base).hostname)) fail(`${new URL(base).host} is not on this computer. This script publishes a real post there; add --allow-remote if you really mean it.`);
if (!email || !password) fail("Set BLOG_ADMIN_EMAIL and BLOG_ADMIN_PASSWORD in the environment first.");
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
page.on("dialog", (d) => d.accept());
const step = (s) => console.log(`- ${s}`);
const url = (p) => new URL(p, base).href;
const stamp = Date.now().toString(36);
const wantSlug = `editor-flow-test-${stamp}-blink-an-led`;

await page.goto(url("admin/login"));
// The sign-in page must still be on the address that was checked: a redirect to another host would receive the password.
if (new URL(page.url()).host !== new URL(base).host) fail(`The sign-in page is on ${new URL(page.url()).host}, not on ${new URL(base).host}. Stopping before the password is typed.`);
await page.fill("input[name=email]", email);
await page.fill("input[name=password]", password);
await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
if (page.url().includes("/admin/login/verify")) {
  if (!process.env.BLOG_ADMIN_CODE) fail("This account uses two-step sign-in. Run again with BLOG_ADMIN_CODE=<the current 6-digit code>, or use an account without two-step sign-in.");
  await page.fill("input[name=code]", process.env.BLOG_ADMIN_CODE);
  await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
}
if (page.url().includes("/admin/login")) fail("Sign-in failed: check the email and password (and the two-step code). A new account must first sign in once in a browser to choose its own password.");
step("signed in");

await page.goto(url("admin/posts/new"));
await page.evaluate(() => localStorage.setItem("ed-mode", "markdown"));
await page.reload();
await page.fill("#f-title", `Editor Flow Test ${stamp}: Blink an LED`);
const slug = await page.inputValue("#f-slug");
if (slug !== wantSlug) throw new Error(`slug did not follow the title: ${slug}`);
step(`slug follows the title: ${slug}`);

await page.click(".toastui-editor-md-container .ProseMirror");
await page.keyboard.type("Intro paragraph.\n\n## Wiring\n\nConnect GPIO 2 to the LED through a resistor.\n");
await page.click('.ed-switch [data-mode="wysiwyg"]');
await page.waitForFunction(() => document.querySelector(".toastui-editor-ww-container h2")?.textContent.includes("Wiring"), null, { timeout: 5000 });
step("Markdown shows up as a heading in the visual editor");

await page.fill("#f-excerpt", "Blink the built-in LED on an ESP32 with a five-line sketch, then change the speed from your phone.");
if (!(await page.textContent("#serp-desc")).startsWith("Blink the built-in LED")) throw new Error("search preview did not update");
step("search preview updates");

// Feature image through the media dialog.
const png = await sharp({ create: { width: 1200, height: 675, channels: 3, background: "#C2410C" } }).png().toBuffer();
await page.click(".ed-add-feature");
await page.waitForSelector("#media-dialog[open]");
await page.setInputFiles(".md-upload input", { name: "editor-flow.png", mimeType: "image/png", buffer: png });
await page.waitForFunction(() => document.querySelector("input[name=feature_image_id]").value !== "", null, { timeout: 15000 });
await page.fill("input[name=feature_image_alt]", "A copper test image");
step("uploaded and picked a feature image");

// Source code and a PDF download.
await page.click("[data-add-file]");
await page.fill('#src-list [data-k="code"]', "void setup() {\n  pinMode(2, OUTPUT);\n}\n\nvoid loop() {}\n");
await page.click("[data-add-download]");
await page.waitForSelector("#media-dialog[open]");
await page.setInputFiles(".md-upload input", { name: "editor-flow-diagram.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
await page.waitForSelector("#dl-list .dl-item", { timeout: 15000 });
step("added a source file and a PDF download");

await page.click("#btn-publish");
await page.waitForFunction(() => /Published/.test(document.getElementById("ed-status").textContent), null, { timeout: 10000 });
if (!/\/admin\/posts\/\d+$/.test(page.url())) throw new Error(`URL not updated after first save: ${page.url()}`);
if (!(await page.isHidden("#btn-publish")) || (await page.textContent("#btn-save")) !== "Update") throw new Error("buttons did not switch to Update");
step(`published; editor URL is now ${new URL(page.url()).pathname}`);

const live = await page.request.get(url(`${wantSlug}/`));
if (live.status() !== 200) throw new Error(`live page returned ${live.status()}`);
const html = await live.text();
for (const [what, re] of [["feature image", /A copper test image/], ["heading", /<h2 id="wiring">/], ["source box", /<span class="src-name">main\.ino<\/span>/], ["PDF button", /dl-btn[^>]+\.pdf" download/]]) {
  if (!re.test(html)) throw new Error(`live page is missing the ${what}`);
}
step("live page shows the heading, feature image, source code and PDF button");

await page.click("#btn-unpublish");
await page.waitForFunction(() => document.getElementById("ed-state").textContent === "Draft", null, { timeout: 10000 });
const gone = await page.request.get(url(`${wantSlug}/`), { maxRedirects: 0 });
step(`unpublished; public URL now returns ${gone.status()}`);

await page.click('[data-action="delete"]');
await page.waitForURL(/\/admin\/posts\?ok=deleted/, { timeout: 10000 });
step("deleted the test post");

await browser.close();
if (errors.length) {
  console.error(`Browser errors:\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
console.log("Editor flow passed with no browser errors.");
