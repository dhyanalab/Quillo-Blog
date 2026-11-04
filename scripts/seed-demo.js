// Demo content for previewing the layout: categories (Projects with sub-categories, Tutorials, News),
// a demo author, posts with source code and downloads, news items, a page, a few reader comments and two demo
// sponsor banners.
// Every demo post is tagged "demo" and every demo account uses an @example.invalid address.
//   npm run seed -- --dev        add the demo content (a practice site only: it publishes everything at once)
//   npm run seed -- --remove     delete exactly what the seed added, using the record it keeps in <DATA_DIR>/demo-seed.json (categories stay)
// It refuses to run in production mode, or on a site that already has posts, members or subscribers, unless you add --force.
// With --force in production the demo author is created suspended and every demo post and the demo page as a draft, and the banners
// switched off, so nothing appears on the live site by itself. --remove only deletes rows that still carry the demo marks.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createStore } from "../src/store/index.js";
import { deleteMediaFiles, processFile, processUpload } from "../src/render/media.js";
import { createSecrets } from "../src/web/secrets.js";

const config = loadConfig();
const argv = process.argv.slice(2);
const force = argv.includes("--force");
const remove = argv.includes("--remove");
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!remove && config.production && !force) {
  fail("This is production mode, and the demo content would be published on the live site at once.\nFor a practice site run: npm run seed -- --dev   (or set NODE_ENV=development). To seed this site anyway, add --force.");
}
const store = createStore(openDb(config.dataDir), { basePath: config.basePath, secrets: createSecrets(config.dataDir) });
const mediaDir = path.join(config.dataDir, "media");
const manifestFile = path.join(config.dataDir, "demo-seed.json");
const DEMO_EMAIL = "demo-author@example.invalid";
const DEMO_READERS = [["Priya S", "priya@example.invalid"], ["Rahul M", "rahul@example.invalid"]];
const DEMO_ADS = ["Demo sponsor (wide)", "Demo sponsor (sidebar)"];
const count = (table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

// What the seed added, by id. Removal deletes these (and only those that still carry the demo marks, see below) and nothing else.
const record = { posts: [], media: [], users: [], members: [], ads: [], tags: [] };
// A record left by an earlier run (for example one that stopped half way) is kept and added to, so --remove still finds every run's content.
function loadOldRecord() {
  try {
    const old = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    for (const kind of Object.keys(record)) for (const id of old[kind] || []) if (Number.isInteger(id) && !record[kind].includes(id)) record[kind].push(id);
  } catch {}
}
if (!remove) loadOldRecord();
// With --force on a production site nothing goes live by itself.
const quiet = config.production && force && !remove;

// Demo content made before the record existed: found by its exact marks (the demo author's address, the demo readers' addresses and the two banner names).
function recoverRecord() {
  const author = store.users.getByEmail(DEMO_EMAIL);
  const out = { posts: [], media: [], users: author ? [author.id] : [], members: [], ads: [], tags: [] };
  if (!author) return null;
  const media = new Set();
  for (const r of store.db.prepare("SELECT id FROM posts WHERE author_id = ?").all(author.id)) {
    const p = store.posts.get(r.id);
    out.posts.push(p.id);
    if (p.feature_image_id) media.add(p.feature_image_id);
    for (const f of p.downloads?.files || []) media.add(f.media_id);
  }
  for (const a of store.db.prepare(`SELECT id, image_id, mobile_image_id FROM ads WHERE name IN (${DEMO_ADS.map(() => "?").join(",")})`).all(...DEMO_ADS)) {
    out.ads.push(a.id);
    for (const m of [a.image_id, a.mobile_image_id]) if (m) media.add(m);
  }
  if (author.photo_id) media.add(author.photo_id);
  out.media = [...media];
  for (const [, email] of DEMO_READERS) {
    const m = store.members.getByEmail(email);
    if (m) out.members.push(m.id);
  }
  const tag = store.tags.getBySlug("demo");
  if (tag) out.tags.push(tag.id);
  return out;
}

if (remove) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch {
    rec = recoverRecord();
  }
  if (!rec) {
    console.log("Nothing to remove: this data folder has no record of demo content.");
    process.exit(0);
  }
  const db = store.db;
  const gone = { posts: 0, media: 0 };
  // The record lists ids, but after restoring an older database or reusing a data folder an id can belong to real content.
  // So every row is looked at again, and deleted only if it still carries the demo marks: the demo author's address, the demo banner names,
  // the demo reader addresses, the "demo" tag, and file names that start with "demo-".
  const demoAuthor = store.users.getByEmail(DEMO_EMAIL);
  const skipped = [];
  const isDemo = {
    post: (id) => Boolean(demoAuthor) && db.prepare("SELECT 1 FROM posts WHERE id = ? AND author_id = ?").get(id, demoAuthor.id) !== undefined,
    ad: (id) => db.prepare(`SELECT 1 FROM ads WHERE id = ? AND name IN (${DEMO_ADS.map(() => "?").join(",")})`).get(id, ...DEMO_ADS) !== undefined,
    media: (m) => String(m.original_name || "").startsWith("demo-") && m.uploaded_by == null,
    user: (id) => Boolean(demoAuthor) && demoAuthor.id === id && demoAuthor.role !== "owner",
    member: (id) => DEMO_READERS.some(([, email]) => store.members.getByEmail(email)?.id === id),
    tag: (id) => store.tags.getBySlug("demo")?.id === id,
  };
  for (const id of rec.posts || []) {
    if (!isDemo.post(id)) {
      if (store.posts.get(id)) skipped.push(`post ${id}`);
      continue;
    }
    const p = store.posts.remove(id);
    if (!p) continue;
    gone.posts++;
    // Deleting a live post leaves a 410 at its address; drop the ones the seed itself caused.
    db.prepare("DELETE FROM redirects WHERE from_path = ? AND status_code = 410 AND source = 'auto'").run(`${config.basePath}/${p.slug}/`);
  }
  for (const id of rec.ads || []) {
    if (isDemo.ad(id)) store.ads.remove(id);
    else skipped.push(`banner ${id}`);
  }
  for (const id of rec.media || []) {
    const m = store.media.get(id);
    if (!m) continue;
    if (!isDemo.media(m)) {
      skipped.push(`file ${id}`);
      continue;
    }
    db.prepare("UPDATE users SET photo_id = NULL WHERE photo_id = ?").run(m.id);
    store.media.remove(m.id);
    deleteMediaFiles(m, mediaDir);
    gone.media++;
  }
  for (const id of rec.users || []) {
    if (isDemo.user(id)) db.prepare("DELETE FROM users WHERE id = ?").run(id);
    else skipped.push(`account ${id}`);
  }
  for (const id of rec.members || []) {
    if (isDemo.member(id)) store.members.remove(id);
    else skipped.push(`reader ${id}`);
  }
  // The "demo" tag only goes if nothing else uses it now.
  for (const id of rec.tags || []) if (isDemo.tag(id) && !db.prepare("SELECT 1 FROM post_tags WHERE tag_id = ?").get(id)) store.tags.remove(id);
  fs.rmSync(manifestFile, { force: true });
  console.log(`Demo content removed (${gone.posts} posts and pages, ${gone.media} files). Categories stay.`);
  if (skipped.length) console.log(`Left alone because they no longer look like demo content: ${skipped.join(", ")}.`);
  process.exit(0);
}

if (store.users.getByEmail(DEMO_EMAIL)) {
  console.log("Demo content is already there. Remove it with: npm run seed -- --remove");
  process.exit(0);
}
if (!force) {
  const busy = [["posts", count("posts")], ["members", count("members")], ["subscribers", count("subscribers")], ["newsletters", count("newsletters")]].filter(([, n]) => n > 0);
  if (busy.length) fail(`This site already has content (${busy.map(([k, n]) => `${n} ${k}`).join(", ")}), and the demo content would go live next to it.
To add it anyway, run again with --force.`);
}

// Write the record of what was added, also when the seed stops half way, so --remove can still clean up.
const keep = (kind, row) => {
  record[kind].push(row.id);
  return row;
};
process.on("exit", () => {
  if (Object.values(record).some((ids) => ids.length)) fs.writeFileSync(manifestFile, JSON.stringify(record), { mode: 0o600 });
});

// Generated pictures in the site colours, so cards and heroes have something to show.
const DRAWINGS = {
  board: '<rect x="460" y="300" width="680" height="300" rx="26" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="10"/><rect x="690" y="370" width="220" height="160" rx="14" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="10"/>' + Array.from({ length: 12 }, (_, i) => `<path d="M${520 + i * 52} 300v-56M${520 + i * 52} 600v56" stroke="#fff" stroke-opacity=".75" stroke-width="10" stroke-linecap="round"/>`).join(""),
  sonar: '<rect x="430" y="330" width="740" height="250" rx="26" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="10"/><circle cx="640" cy="455" r="90" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="10"/><circle cx="960" cy="455" r="90" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="10"/><circle cx="640" cy="455" r="36" fill="#fff" fill-opacity=".5"/><circle cx="960" cy="455" r="36" fill="#fff" fill-opacity=".5"/>',
  cam: '<rect x="520" y="260" width="560" height="380" rx="40" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="10"/><circle cx="800" cy="450" r="120" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="10"/><circle cx="800" cy="450" r="50" fill="#fff" fill-opacity=".5"/>',
  wifi: '<path d="M560 470a340 340 0 0 1 480 0M630 550a240 240 0 0 1 340 0M700 630a140 140 0 0 1 200 0" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="14" stroke-linecap="round"/><circle cx="800" cy="690" r="18" fill="#fff"/>',
  chart: '<path d="M440 640h720M440 640V250" stroke="#fff" stroke-opacity=".75" stroke-width="10" stroke-linecap="round"/><path d="m490 560 130-110 130 60 150-160 130 80 110-70" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>',
  led: '<path d="M720 470a80 80 0 1 1 160 0v80H720z" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="10"/><path d="M760 550v120M840 550v90M800 300v-60M690 350l-40-40M910 350l40-40" stroke="#fff" stroke-opacity=".8" stroke-width="10" stroke-linecap="round"/>',
  bolt: '<path d="M860 230 680 480h130l-50 200 200-260H830z" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="12" stroke-linejoin="round"/>',
};
const PALETTES = [["#16181B", "#C2410C"], ["#1A1D21", "#0E7490"], ["#22262B", "#B45309"], ["#14171A", "#536271"], ["#1B1F23", "#9A3412"], ["#101418", "#0F766E"]];
async function demoImage(name, drawing, palette, label) {
  const [a, b] = PALETTES[palette % PALETTES.length];
  const grid = Array.from({ length: 33 }, (_, i) => `<path d="M${i * 50} 0v900" stroke="#fff" stroke-opacity=".05"/>`).join("") + Array.from({ length: 19 }, (_, i) => `<path d="M0 ${i * 50}h1600" stroke="#fff" stroke-opacity=".05"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/>${grid}${DRAWINGS[drawing]}</svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const processed = await processUpload(buf, `${name}.png`, mediaDir);
  return keep("media", store.media.insert({ ...processed, original_name: `${name}.png`, alt: `Demo illustration: ${label}` }, null));
}
// A one-page PDF and a small STL so the download buttons have real files.
function demoPdf(title) {
  const text = `BT /F1 28 Tf 72 720 Td (${title.replace(/[()\\]/g, "")}) Tj 0 -40 Td /F1 14 Tf (Demo circuit diagram for previewing the download buttons.) Tj ET`;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
function demoStl(name) {
  const v = [[0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0], [0, 0, 12], [40, 0, 12], [40, 30, 12], [0, 30, 12]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return Buffer.from(`solid ${name}\n${faces.map((f) => `facet normal 0 0 0\n outer loop\n${f.map((i) => `  vertex ${v[i].join(" ")}`).join("\n")}\n endloop\nendfacet`).join("\n")}\nendsolid ${name}\n`);
}
const fileMedia = (buf, name) => keep("media", store.media.insert({ ...processFile(buf, name, mediaDir), original_name: name }, null));

const author = keep("users", await store.users.create({ email: DEMO_EMAIL, password: crypto.randomBytes(24).toString("base64url"), name: "Demo Author", role: "author", job_title: "Embedded engineer", bio: "Placeholder profile used by the demo content. Delete it with npm run seed -- --remove." }));
store.users.update(author.id, { links: ["https://www.youtube.com/@example", "https://www.linkedin.com/in/example"] }, { actor: "system" });
// On a live site (--force in production) the demo author cannot sign in and nothing is published.
if (quiet) store.users.update(author.id, { status: "suspended" }, { actor: "system" });

// Categories: Projects with sub-categories, Tutorials and News.
const cat = (name, slug, description, parent_id = null, sort = 0) => {
  const found = store.categories.getBySlug(slug);
  const data = { name, slug, description, intro_md: "", seo_title: "", parent_id, sort, show_on_home: 1 };
  return found ? store.categories.save({ ...found, ...data }, found.id) : store.categories.save(data);
};
const projects = cat("Projects", "projects", "Step-by-step builds with wiring, full code and downloads.", null, 1);
const esp = cat("ESP32 Projects", "esp32-projects", "ESP32 projects with wiring diagrams, full code and a phone dashboard.", projects.id, 2);
const cam = cat("ESP32-CAM Projects", "esp32-cam", "Camera projects with the ESP32-CAM board.", projects.id, 3);
const ard = cat("Arduino Projects", "arduino", "Arduino projects for beginners and makers.", projects.id, 4);
const iot = cat("IoT Projects", "iot", "Connected-device builds, dashboards and protocols.", projects.id, 5);
const tut = cat("Tutorials", "tutorials", "Guides to the ideas behind IoT projects.", null, 6);
const news = cat("News", "news", "New boards, tools and events for makers.", null, 7);

const hadDemoTag = Boolean(store.tags.getBySlug("demo"));
const ensured = store.tags.ensure(["demo", "ESP32", "LED", "MQTT", "Sensors", "Arduino", "WiFi", "ESP32-CAM"], { create: true });
const tags = Array.isArray(ensured) ? ensured : ensured.tags;
if (!hadDemoTag) record.tags.push(tags.find((t) => t.name === "demo").id);
const tagIds = (...names) => names.map((n) => tags.find((t) => t.name === n)?.id).filter(Boolean);

const SNIPPET = `long duration = pulseIn(ECHO_PIN, HIGH, 30000);
float distanceCm = duration * 0.0343 / 2;`;
const body = (topic, imagePath) => `This is **demo content** for previewing the blog layout. Remove it with \`npm run seed -- --remove\`.

## What you'll build

A short demo of ${topic}. The section headings become the contents list beside the article, and each one gets a link anchor.

![Demo wiring illustration for ${topic}](${config.basePath}/media/${imagePath})

*An italic line right under a picture becomes its caption.*

## Components required

| Component | Qty | Notes |
| --- | ---: | --- |
| ESP32 DevKit V1 | 1 | Any ESP32-WROOM-32 board |
| HC-SR04 ultrasonic sensor | 1 | Mount 5 cm above the overflow |
| Active buzzer, 5 V | 1 | Switched by a transistor |
| Jumper wires | 10 | Male to female |

## How it works

The sensor sends a short pulse of sound and times the echo. Half of that time, multiplied by the speed of sound, is the distance. Short snippets like this one can stay in the text; the full sketch is in the Source code box below.

\`\`\`cpp
${SNIPPET}
\`\`\`

\`\`\`text
Connecting to WiFi....
Connected. IP address: 192.168.1.42
\`\`\`

> [!TIP]
> Callouts come in five kinds: note, tip, important, warning and caution.

> [!WARNING]
> Never connect an LED to a GPIO pin without a resistor.

## FAQ

### Is this real content?

No. It is placeholder text so you can see every part of the article layout.

### How do I remove it?

Run \`npm run seed -- --remove\`.
`;

const MAIN_INO = `#include <WiFi.h>
#include "config.h"

const int TRIG_PIN = 5;
const int ECHO_PIN = 18;
const int BUZZER_PIN = 19;

float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  return duration * 0.0343 / 2;
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(250);
}

void loop() {
  float cm = readDistanceCm();
  int level = constrain(map(cm, TANK_EMPTY_CM, TANK_FULL_CM, 0, 100), 0, 100);
  digitalWrite(BUZZER_PIN, level < 15 ? HIGH : LOW);
  Serial.printf("Level: %d%%\\n", level);
  delay(2000);
}
`;
const CONFIG_H = `// Fill in your own network details before uploading.
#define WIFI_SSID      "YOUR_WIFI_NAME"
#define WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"

// Distance from the sensor to the water, in cm.
#define TANK_EMPTY_CM  120
#define TANK_FULL_CM   20
`;

const POSTS = [
  { title: "Demo: ESP32 Water Tank Level Monitor With Alarm", short: "Tank Level", cat: esp, draw: "sonar", pal: 0, featured: 1, tags: ["demo", "ESP32", "Sensors"], files: true, dl: true },
  { title: "Demo: ESP32-CAM Motion Alert That Sends a Photo", short: "Motion Alert", cat: cam, draw: "cam", pal: 1, featured: 1, tags: ["demo", "ESP32-CAM", "WiFi"], files: true },
  { title: "Demo: Control an LED From Your Phone With ESP32", short: "LED Control", cat: esp, draw: "led", pal: 2, featured: 1, tags: ["demo", "ESP32", "LED"], files: true, dl: true },
  { title: "Demo: ESP32 Temperature and Humidity Monitor", short: "Climate Monitor", cat: esp, draw: "chart", pal: 5, tags: ["demo", "ESP32", "Sensors"] },
  { title: "Demo: Arduino Traffic Light for Beginners", short: "Traffic Light", cat: ard, draw: "led", pal: 4, tags: ["demo", "Arduino", "LED"] },
  { title: "Demo: Smart Plant Watering With a Soil Sensor", short: "Plant Watering", cat: iot, draw: "board", pal: 3, tags: ["demo", "Sensors", "WiFi"] },
  { title: "Demo: Build Your First MQTT Dashboard", short: "MQTT Dashboard", cat: iot, draw: "wifi", pal: 1, tags: ["demo", "MQTT", "WiFi"] },
  { title: "Demo: What Is MQTT and Why IoT Uses It", short: "MQTT basics", cat: tut, draw: "wifi", pal: 0, tags: ["demo", "MQTT"] },
  { title: "Demo: Read Any I2C Sensor on ESP32", short: "I2C sensors", cat: tut, draw: "board", pal: 2, tags: ["demo", "ESP32", "Sensors"] },
  { title: "Demo: Run an ESP32 From Batteries for Months", short: "Battery power", cat: tut, draw: "bolt", pal: 4, tags: ["demo", "ESP32"] },
];
const NEWS = [
  "Demo news: New Wi-Fi 6 modules aimed at battery sensors",
  "Demo news: Arduino IDE update makes library installs faster",
  "Demo news: Maker fair opens project registrations",
  "Demo news: Cheaper camera boards arrive for hobby projects",
  "Demo news: Open-source PCB tool adds a new autorouter",
];

const day = 864e5;
const slugOf = (t) => t.toLowerCase().replace(/^demo( news)?: /, (m) => (m.includes("news") ? "demo-news-" : "demo-")).replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
const created = [];
for (const [i, d] of POSTS.entries()) {
  const img = await demoImage(`demo-${i + 1}`, d.draw, d.pal, d.short);
  const files = [];
  if (d.dl) {
    files.push({ media_id: fileMedia(demoPdf(d.short), `demo-${i + 1}-circuit-diagram.pdf`).id, label: "Circuit diagram" });
    files.push({ media_id: fileMedia(demoStl("mount"), `demo-${i + 1}-sensor-mount.stl`).id, label: "Sensor mount (STL)" });
  }
  const post = store.posts.save({
    type: "post",
    status: quiet ? "draft" : "published",
    title: d.title,
    slug: slugOf(d.title),
    body_md: body(d.short.toLowerCase(), img.path),
    excerpt: `Demo post for previewing the layout: ${d.short.toLowerCase()} with wiring, code and downloads you can try at home.`,
    short_title: d.short,
    author_id: author.id,
    category_id: d.cat.id,
    level: 1,
    quick_answer: `This is the quick answer box for ${d.short}: two or three sentences that answer the main question, written as real text in the page.`,
    at_a_glance: [["Difficulty", "Beginner"], ["Build time", "About 20 minutes"], ["Board", "ESP32 DevKit V1"]],
    tested_with: ["ESP32 Arduino core 3.3.12"],
    source_files: d.files ? [{ name: "main.ino", lang: "arduino", code: MAIN_INO }, { name: "config.h", lang: "cpp", code: CONFIG_H }] : [],
    downloads: { github: d.files ? "https://github.com/example/demo" : "", files },
    feature_image_id: img.id,
    feature_image_alt: `Demo illustration: ${d.short}`,
    featured: Boolean(d.featured),
    published_at: new Date(Date.now() - (POSTS.length - i) * 2 * day).toISOString(),
    tags: tagIds(...d.tags),
  }, { userId: author.id });
  created.push(keep("posts", post));
}
for (const [i, title] of NEWS.entries()) {
  const img = await demoImage(`demo-news-${i + 1}`, ["wifi", "board", "chart", "cam", "board"][i], i + 2, "News");
  keep("posts", store.posts.save({
    type: "post", status: quiet ? "draft" : "published", title, slug: slugOf(title), author_id: author.id, category_id: news.id,
    body_md: "This is a **demo news item** for previewing the News column. Remove it with `npm run seed -- --remove`.\n\n## What happened\n\nPlaceholder text for a short news story.",
    excerpt: "Demo news item for previewing the News column on the home page and in the sidebar.",
    feature_image_id: img.id, feature_image_alt: "Demo illustration: News",
    published_at: new Date(Date.now() - i * 0.6 * day - 3600e3).toISOString(), tags: tagIds("demo"),
  }, { userId: author.id }));
}

keep("posts", store.posts.save({ type: "page", status: quiet ? "draft" : "published", title: "About (demo)", slug: "about-demo", body_md: "This is a demo page. Pages hold things like About, Contact and Privacy.\n\n## Who we are\n\nPlaceholder text.", excerpt: "Demo page for previewing the page layout.", author_id: author.id, published_at: new Date().toISOString(), tags: tagIds("demo") }, { userId: author.id }));

// Two demo readers and a short thread on the first post.
const readers = [];
for (const [name, email] of DEMO_READERS) readers.push(store.members.getByEmail(email) || keep("members", await store.members.create({ email, name, password: crypto.randomBytes(18).toString("base64url") }, { verified: true })));
const first = created[0];
const c1 = store.comments.add({ postId: first.id, memberId: readers[0].id, body: "Worked first time. I had to raise the sensor by 3 cm because my overflow pipe sits close to the top." });
store.comments.add({ postId: first.id, userId: author.id, parentId: c1.id, body: "Thanks Priya, good tip. I'll add it to the troubleshooting part." });
store.comments.add({ postId: first.id, memberId: readers[1].id, body: "Could this run from an 18650 cell? How long would it last?" });
store.comments.toggleLike(c1.id, readers[1].id);

// Two demo sponsor banners, so the ad places show what a real banner looks like.
async function demoBanner(w, h, file) {
  const big = w >= 600;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16181B"/><stop offset="1" stop-color="#3A2216"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><rect x="0" y="${h - 6}" width="${w}" height="6" fill="#C2410C"/>
    <text x="${big ? 28 : w / 2}" y="${big ? h / 2 - 4 : h / 2 - 14}" font-family="Arial, Helvetica, sans-serif" font-size="${big ? 22 : 20}" font-weight="700" fill="#FFFFFF" text-anchor="${big ? "start" : "middle"}">Demo sponsor banner</text>
    <text x="${big ? 28 : w / 2}" y="${big ? h / 2 + 22 : h / 2 + 14}" font-family="Arial, Helvetica, sans-serif" font-size="${big ? 15 : 14}" fill="#FF9A62" text-anchor="${big ? "start" : "middle"}">${w} × ${h}${big ? " · replace it under Admin, Ads" : ""}</text>
    ${big ? `<rect x="${w - 150}" y="${h / 2 - 20}" width="122" height="40" rx="8" fill="#C2410C"/><text x="${w - 89}" y="${h / 2 + 6}" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="700" fill="#FFFFFF" text-anchor="middle">Shop now</text>` : ""}</svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return keep("media", store.media.insert({ ...(await processUpload(buf, "m", mediaDir)), original_name: file, alt: "" }, null));
}
const wide = await demoBanner(728, 90, "demo-banner-728x90.png");
const phone = await demoBanner(320, 100, "demo-banner-320x100.png");
const box = await demoBanner(300, 250, "demo-banner-300x250.png");
keep("ads", store.ads.save({ name: "Demo sponsor (wide)", url: "https://example.com/", alt: "Demo sponsor banner", image_id: wide.id, mobile_image_id: phone.id, places: ["top", "article_end"], active: !quiet }));
keep("ads", store.ads.save({ name: "Demo sponsor (sidebar)", url: "https://example.com/", alt: "Demo sponsor banner", image_id: box.id, places: ["sidebar"], active: !quiet }));

if (quiet) console.log("This is a production site, so the demo author is suspended, the posts and the page are drafts and the banners are off. Nothing shows on the live site.");
console.log(`Added ${created.length} demo posts, ${NEWS.length} news items, 1 page, 7 categories, a demo author, 2 demo readers, 3 comments and 2 demo banners.\nRemove them with: npm run seed -- --remove`);
