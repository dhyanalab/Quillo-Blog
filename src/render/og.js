// 1200x630 Open Graph images: graphite background, a copper label, the title, the feature image and the site mark.
// Satori turns text into paths (no system fonts needed); sharp makes the PNG. Results are cached on disk by content hash.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import satori from "satori";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const fontFile = (pkg, name) => fs.readFileSync(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "files", name));

let fonts;
function loadFonts() {
  fonts ??= [
    { name: "Inter", weight: 800, style: "normal", data: fontFile("@fontsource/inter", "inter-latin-800-normal.woff") },
    { name: "Inter", weight: 700, style: "normal", data: fontFile("@fontsource/inter", "inter-latin-700-normal.woff") },
    { name: "Inter", weight: 600, style: "normal", data: fontFile("@fontsource/inter", "inter-latin-600-normal.woff") },
  ];
  return fonts;
}

// Dark Copper & Slate values from tokens.css.
const BG = "#16181B";
const INK = "#F4F2EF";
const ACCENT_TEXT = "#FF9A62";
const DEFAULT_ACCENT = "#C2410C";

const el = (type, style, children) => ({ type, props: { style, children } });

function titleSize(title, narrow) {
  const n = title.length;
  if (n <= 40) return narrow ? 58 : 66;
  if (n <= 70) return narrow ? 48 : 56;
  return narrow ? 40 : 46;
}

// Pictures come from the media folder, but a stored SVG or a huge image must not be decoded without a size limit. An SVG is drawn
// at a few hundred pixels, so it gets a much lower cap (it is rasterised in full, unlike a JPEG, which is decoded at reduced size).
const RASTER_PIXELS = 24_000_000;
const SVG_PIXELS = 4_000_000;
async function dataUri(file, w, h, fit) {
  const { format } = await sharp(file, { limitInputPixels: RASTER_PIXELS }).metadata();
  const input = format === "svg" ? sharp(file, { limitInputPixels: SVG_PIXELS, density: 72 }) : sharp(file, { limitInputPixels: RASTER_PIXELS });
  const png = await input.resize(w, h, { fit, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function render({ label: rawLabel, title: rawTitle, accent, heroFile, logoFile, siteName: rawSiteName }) {
  const color = accent || DEFAULT_ACCENT;
  const label = String(rawLabel || "").slice(0, 60);
  const title = String(rawTitle || "").slice(0, 200);
  const siteName = String(rawSiteName || "").slice(0, 80);
  // A missing or damaged picture only means the image is drawn without it.
  const hero = heroFile ? await dataUri(heroFile, 440, 630, "cover").catch(() => null) : null;
  const logo = logoFile ? await dataUri(logoFile, 120, 40, "inside").catch(() => null) : null;

  // Satori boxes are content-box: let the text column fill what the image leaves instead of sizing it.
  const text = el("div", { display: "flex", flexDirection: "column", flexGrow: 1, flexBasis: 0, padding: "64px 64px 76px 72px" }, [
    label
      ? el("div", { display: "flex" }, [el("div", { display: "flex", background: color, color: "#FFFFFF", fontFamily: "Inter", fontWeight: 700, fontSize: 24, padding: "8px 18px", borderRadius: 8, letterSpacing: "0.04em", textTransform: "uppercase" }, label)])
      : el("div", { display: "flex" }, ""),
    el("div", { display: "flex", marginTop: 30, color: INK, fontFamily: "Inter", fontWeight: 800, fontSize: titleSize(title, !!hero), lineHeight: 1.1, letterSpacing: "-0.025em" }, title),
    el("div", { display: "flex", flexGrow: 1 }, ""),
    el("div", { display: "flex", alignItems: "center" }, [
      logo
        ? { type: "img", props: { src: logo, height: 40, style: { height: 40, marginRight: 14 } } }
        : el("div", { display: "flex", width: 36, height: 36, borderRadius: 9, background: color, marginRight: 14 }, ""),
      el("div", { display: "flex", color: INK, fontFamily: "Inter", fontWeight: 800, fontSize: 32, letterSpacing: "-0.02em" }, siteName.replace(/ Blog$/, "")),
      ...(/ Blog$/.test(siteName) ? [el("div", { display: "flex", color: ACCENT_TEXT, fontFamily: "Inter", fontWeight: 700, fontSize: 32, marginLeft: 10 }, "Blog")] : []),
    ]),
  ]);

  const root = el("div", { display: "flex", width: 1200, height: 630, background: BG, position: "relative" }, [
    text,
    ...(hero ? [{ type: "img", props: { src: hero, width: 440, height: 630, style: { width: 440, height: 630, flexShrink: 0 } } }] : []),
    el("div", { display: "flex", position: "absolute", left: 0, bottom: 0, width: 1200, height: 14, background: color }, ""),
  ]);

  const svg = await satori(root, { width: 1200, height: 630, fonts: loadFonts() });
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

// 128 bits of SHA-256: the name of the cached image, and the `?v=` in its address.
export function ogHash(input) {
  const h = crypto.createHash("sha256").update(JSON.stringify({ v: 5, ...input, heroFile: undefined, logoFile: undefined }));
  for (const f of [input.heroFile, input.logoFile]) {
    const st = f ? fs.statSync(f, { throwIfNoEntry: false }) : null;
    if (st) h.update(st.mtimeMs + f);
  }
  return h.digest("hex").slice(0, 32);
}

// At most two images are drawn at once, and a second request for the same image waits for the first. A waiting job is handed
// the finished job's place directly (the count is not lowered and raised again), so a request arriving in between can't slip in as a third.
const MAX_RENDERS = 2;
let running = 0;
const waiting = [];
const inFlight = new Map();
async function slot(job) {
  if (running >= MAX_RENDERS) await new Promise((resolve) => waiting.push(resolve));
  else running++;
  try {
    return await job();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

// An image that could not be made is not tried again for a minute, so one broken picture can't keep the renderer busy.
const failures = new Map();
const FAIL_MS = 60_000;

const DAY = 86_400_000;
const lastPrune = new Map();

// Deletes images nobody has asked for in a week (every edit to a title, hero or logo leaves one behind, and an image can carry the
// title of a post that was unpublished since), stray temp files, and the oldest images beyond `maxFiles`. Runs at most once an
// hour per folder, and never blocks the request that triggered it. The folder holds only copies that are made again on demand, so it
// is safe to leave out of backups.
export async function pruneOgCache(cacheDir, { maxAgeMs = 7 * DAY, maxFiles = 2000, force = false } = {}) {
  const t = Date.now();
  if (!force && t - (lastPrune.get(cacheDir) || 0) < 3600_000) return 0;
  lastPrune.set(cacheDir, t);
  let removed = 0;
  try {
    const names = await fs.promises.readdir(cacheDir);
    const files = (await Promise.all(names.map(async (name) => {
      const file = path.join(cacheDir, name);
      const st = await fs.promises.stat(file).catch(() => null);
      return st ? { name, file, mtime: st.mtimeMs } : null;
    }))).filter(Boolean);
    const drop = async (f) => {
      await fs.promises.rm(f.file, { force: true });
      removed++;
    };
    const keep = [];
    for (const f of files) {
      if (f.name.endsWith(".tmp")) {
        if (t - f.mtime > 3600_000) await drop(f);
      } else if (f.name.endsWith(".png")) {
        if (t - f.mtime > maxAgeMs) await drop(f);
        else keep.push(f);
      }
    }
    keep.sort((a, b) => a.mtime - b.mtime);
    for (const f of keep.slice(0, Math.max(0, keep.length - maxFiles))) await drop(f);
  } catch {
    // an unreadable cache folder is simply left alone
  }
  return removed;
}

// Returns the PNG file path, rendering it only when no cached copy exists. File work is asynchronous, so it never stalls other requests.
export async function ogImageFile(input, cacheDir) {
  const file = path.join(cacheDir, `${ogHash(input)}.png`);
  const st = await fs.promises.stat(file).catch(() => null);
  if (st) {
    // Used images get a fresh timestamp (at most once a day) so pruning keeps them.
    if (Date.now() - st.mtimeMs > DAY) await fs.promises.utimes(file, new Date(), new Date()).catch(() => {});
    return file;
  }
  const failed = failures.get(file);
  if (failed && failed.until > Date.now()) throw failed.err;
  let job = inFlight.get(file);
  if (!job) {
    job = slot(async () => {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      try {
        await fs.promises.writeFile(tmp, await render(input));
        await fs.promises.rename(tmp, file);
      } finally {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
      }
    }).catch((err) => {
      if (failures.size >= 500) failures.delete(failures.keys().next().value);
      failures.set(file, { until: Date.now() + FAIL_MS, err });
      throw err;
    }).finally(() => inFlight.delete(file));
    inFlight.set(file, job);
  }
  await job;
  pruneOgCache(cacheDir).catch(() => {});
  return file;
}
