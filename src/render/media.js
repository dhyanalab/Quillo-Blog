// Image uploads: the type is detected from the bytes, raster images are re-encoded (EXIF/GPS stripped,
// orientation fixed) with AVIF + WebP sizes for srcset, and SVGs are checked for scripts and outside references.
//
// Stored names are <slug>-<first 16 hex of the SHA-256 of the uploaded file>.<ext> (see inputKey). A file is never overwritten: a name
// that already holds the same bytes is reused, and one that holds different bytes (a leftover from an older run) is left alone and the
// new file is stored under a second name, <slug>-r2-<hash>. Everything is encoded in memory first and then written in
// one synchronous step, so a failure leaves nothing behind and a delete can't slip in between the original and its variants.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { escapeHtml, slugify } from "./util.js";

const WIDTHS = [400, 800, 1200, 1600];
const MAX_ORIGINAL = 2400;
const MAX_PIXELS = 40_000_000;
const MAX_GIF_FRAMES = 200;
const MAX_SVG_CHARS = 1_000_000; // a drawing bigger than this is not a plain logo or diagram
const FORMATS = { jpeg: ["jpg", "image/jpeg"], png: ["png", "image/png"], webp: ["webp", "image/webp"], gif: ["gif", "image/gif"], avif: ["avif", "image/avif"], heif: ["avif", "image/avif"] };

export class UploadError extends Error {
  // `status` is what a web route should answer with: 400 for a bad file, 503 when the processor is busy.
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Every sharp() call gets the pixel limit, so one small file can't ask for a huge decode.
const open = (input, options = {}) => sharp(input, { limitInputPixels: MAX_PIXELS, ...options });

// At most two images are processed at a time and at most eight wait, so a burst of uploads can't starve the public site
// or pile up in memory. A finishing job hands its place straight to the next one in line.
const MAX_ACTIVE = 2;
const MAX_WAITING = 8;
const waiting = [];
let active = 0;
async function gated(fn) {
  if (active >= MAX_ACTIVE) {
    if (waiting.length >= MAX_WAITING) throw new UploadError("The image processor is busy. Try again in a minute.", 503);
    await new Promise((resolve) => waiting.push(resolve));
  } else active++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

// The 16 hex characters of the SHA-256 of the uploaded bytes: the same value that ends every stored name, so a file that was
// uploaded before can be found without encoding it again.
export const inputKey = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
const monthDir = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

// Writes one file without ever replacing another: the bytes go to a uniquely named temporary file, which is then linked to the
// final name (a link fails if the name is taken). An existing file with the same bytes is reused; different bytes are a name clash.
function writeNew(mediaDir, rel, data, created) {
  const full = path.join(mediaDir, rel);
  const sameOrClash = () => {
    if (!fs.readFileSync(full).equals(data)) throw Object.assign(new UploadError("A different file is already stored under this name. Rename the file and upload it again."), { clash: true });
  };
  const tmp = `${full}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { flag: "wx" });
  try {
    fs.linkSync(tmp, full);
    created.push(full);
  } catch (err) {
    if (err.code === "EEXIST") sameOrClash();
    else {
      // A disk without hard links: fall back to an exclusive write of the final name.
      try {
        fs.writeFileSync(full, data, { flag: "wx" });
        created.push(full);
      } catch (err2) {
        if (err2.code === "EEXIST") sameOrClash();
        else throw err2;
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Writes every file of one upload, or none: files created by this call are removed when anything fails.
function writeAll(mediaDir, files) {
  const created = [];
  try {
    fs.mkdirSync(path.join(mediaDir, path.dirname(files[0].rel)), { recursive: true });
    for (const f of files) writeNew(mediaDir, f.rel, f.data, created);
  } catch (err) {
    for (const f of created) fs.rmSync(f, { force: true });
    throw err;
  }
}

// Stores an upload as <dir>/<base>-<key><tail>. `files` are { tail, data } (".png", "-400.webp"...); the first is the original.
// A name taken by different bytes (a leftover) is never touched: the next name <base>-r2-<key> is tried, and so on. Returns the stem.
function place(mediaDir, base, key, files) {
  const dir = monthDir();
  for (let n = 1; n <= 5; n++) {
    const stem = `${dir}/${n === 1 ? base : `${base}-r${n}`}-${key}`;
    try {
      writeAll(mediaDir, files.map((f) => ({ rel: `${stem}${f.tail}`, data: f.data })));
      return stem;
    } catch (err) {
      if (!err?.clash) throw err;
    }
  }
  throw new UploadError("A different file is already stored under this name. Rename the file and upload it again.");
}

// --- SVG ---
// Every check here must cost time in proportion to the size of the input (no regular expression that can backtrack over the
// whole text for each start position), because an upload is examined on the one thread that also serves the site.

// A character reference as a character. Leading zeros don't change the value ("&#0000106;" is "j"); a number too big to be a character gives "".
const codePoint = (digits, radix) => {
  const d = digits.replace(/^0+/, "");
  if (d.length > 8) return "";
  const n = d ? parseInt(d, radix) : 0;
  return n <= 0x10ffff ? String.fromCodePoint(n) : "";
};

// Numeric and the few named entities that can hide a scheme or a quote ("&#106;avascript:", "java&Tab;script:").
function decodeEntities(text) {
  const named = { colon: ":", tab: "\t", newline: "\n", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", sol: "/", lpar: "(", rpar: ")" };
  let out = String(text);
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/&#x([0-9a-f]+);?/gi, (m, h) => codePoint(h, 16))
      .replace(/&#(\d+);?/g, (m, d) => codePoint(d, 10))
      .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
  }
  return out;
}

const WS = /\s/;

// The text without /* ... */ comments. Walks forward once; a comment that never ends is left in place.
function stripCssComments(text) {
  const parts = [];
  let i = 0;
  for (;;) {
    const start = text.indexOf("/*", i);
    if (start < 0) break;
    const end = text.indexOf("*/", start + 2);
    if (end < 0) break;
    parts.push(text.slice(i, start));
    i = end + 2;
  }
  parts.push(text.slice(i));
  return parts.join("");
}

// True when a url( points anywhere but at a "#id" inside the file.
function hasOutsideUrl(text) {
  const lower = text.toLowerCase();
  let i = 0;
  for (;;) {
    i = lower.indexOf("url(", i);
    if (i < 0) return false;
    let j = i + 4;
    while (j < lower.length && WS.test(lower[j])) j++;
    if (lower[j] === '"' || lower[j] === "'") j++;
    while (j < lower.length && WS.test(lower[j])) j++;
    if (lower[j] !== "#") return true;
    i = j;
  }
}

const countOf = (text, re) => {
  let n = 0;
  for (const _ of text.matchAll(re)) n++;
  return n;
};

// Returns the reason an SVG can't be accepted, or "".
function svgProblem(text) {
  const raw = String(text);
  if (raw.length > MAX_SVG_CHARS) return "it is larger than 1 MB";
  const dec = decodeEntities(raw);
  // Scripts could be hidden by line breaks, control characters or comments inside a scheme name.
  const squashed = stripCssComments(dec).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, "").toLowerCase();
  for (const t of [raw, dec]) {
    if (/<!DOCTYPE|<!ENTITY/i.test(t)) return "it has a DOCTYPE or ENTITY declaration";
    if (/<\s*(?:[\w.-]+:)?script\b/i.test(t)) return "it contains a script";
    if (/<\s*(?:[\w.-]+:)?(?:foreignObject|iframe|embed|object)\b/i.test(t)) return "it embeds other content";
    if (/[\s"'/]on[\w-]+\s*=/i.test(t)) return "it has event handlers";
    if (/@import/i.test(t)) return "it imports other style sheets";
    if (t.includes("\\")) return "it uses backslash escapes";
    if (/image-set\s*\(/i.test(t)) return "it loads something from outside the file";
  }
  if (/(?:java|vb)script:|data:text\/html|data:application/.test(squashed)) return "it contains a script address";
  for (const t of [raw, dec]) {
    for (const m of t.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const value = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (!value.startsWith("#")) return "it links to something outside the file";
    }
    if (hasOutsideUrl(t)) return "it loads something from outside the file";
    // Animation can set a link or an address after the file has loaded.
    if (/<\s*(?:[\w.-]+:)?(?:set|animate|animateTransform|animateMotion)\b/i.test(t)) {
      if (/\battributeName\s*=\s*["']?\s*(?:[\w.-]+:)?href\b/i.test(t)) return "it animates a link";
      for (const m of t.matchAll(/\b(?:to|from|values|by)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const v = decodeEntities(m[1] ?? m[2] ?? "").trim().toLowerCase();
        if (v.includes("//") || v.startsWith("data:") || v.includes("url(")) return "it animates something to an outside address";
      }
    }
  }
  // A drawing that asks the viewer's browser for an enormous amount of work (copies of copies, piles of filters).
  if (countOf(dec, /</g) > 20_000) return "it has too many elements";
  if (countOf(dec, /<\s*(?:[\w.-]+:)?use[\s/>]/gi) > 50) return "it reuses elements too many times";
  if (countOf(dec, /<\s*(?:[\w.-]+:)?filter[\s/>]/gi) > 20 || countOf(dec, /<\s*(?:[\w.-]+:)?fe[A-Z][A-Za-z]+[\s/>]/g) > 100) return "it has too many filters";
  return "";
}

// True when the first bytes read as an SVG file: an optional <?xml ?> line, comments, an optional DOCTYPE, then <svg.
// Walks the first 2 KB once with indexOf, so a head full of tiny comments can't make it slow.
function looksLikeSvg(buf) {
  const head = buf.subarray(0, 2048).toString("utf8");
  const n = head.length;
  let i = head.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skipSpace = () => {
    while (i < n && WS.test(head[i])) i++;
  };
  const at = (s) => head.slice(i, i + s.length).toLowerCase() === s;
  skipSpace();
  if (at("<?xml")) {
    const end = head.indexOf(">", i);
    if (end < 0) return false;
    i = end + 1;
    skipSpace();
  }
  while (at("<!--")) {
    const end = head.indexOf("-->", i + 4);
    if (end < 0) return false;
    i = end + 3;
    skipSpace();
  }
  if (at("<!doctype svg")) {
    const end = head.indexOf(">", i);
    if (end < 0) return false;
    i = end + 1;
    skipSpace();
  }
  return at("<svg") && (i + 4 >= n ? false : WS.test(head[i + 4]) || head[i + 4] === ">");
}

export async function processUpload(buffer, originalName, mediaDir) {
  if (!buffer?.length) throw new UploadError("The file is empty.");
  return gated(() => handleUpload(buffer, originalName, mediaDir));
}

async function handleUpload(buffer, originalName, mediaDir) {
  const base = slugify(path.parse(originalName || "image").name).slice(0, 60) || "image";
  const key = inputKey(buffer);

  if (looksLikeSvg(buffer)) {
    if (buffer.length > MAX_SVG_CHARS) throw new UploadError("This SVG can't be uploaded: it is larger than 1 MB. Export a plain, smaller SVG.");
    const problem = svgProblem(buffer.toString("utf8"));
    if (problem) throw new UploadError(`This SVG can't be uploaded: ${problem}. Export a plain SVG without scripts, links or embedded content.`);
    const meta = await open(buffer).metadata().catch(() => ({}));
    const rel = `${place(mediaDir, base, key, [{ tail: ".svg", data: buffer }])}.svg`;
    return { path: rel, mime: "image/svg+xml", width: meta.width || null, height: meta.height || null, size: buffer.length, variants: {} };
  }

  let meta;
  try {
    meta = await open(buffer, { animated: true }).metadata();
  } catch (err) {
    if (/pixel limit/i.test(err?.message)) throw new UploadError(`That image is too large (over ${MAX_PIXELS / 1_000_000} megapixels). Resize it and upload it again.`);
    throw new UploadError("That file isn't an image this site accepts (JPEG, PNG, WebP, AVIF, GIF or SVG).");
  }
  const fmt = FORMATS[meta.format];
  if (!fmt) throw new UploadError(`Unsupported image format: ${meta.format}`);
  const [ext, mime] = fmt;
  const frames = meta.pages || 1;
  const frameHeight = meta.pageHeight || meta.height || 0;
  if (!meta.width || !frameHeight) throw new UploadError("That image has no size, so it can't be used.");
  if (meta.width * frameHeight * frames > MAX_PIXELS) throw new UploadError(`That image is too large (over ${MAX_PIXELS / 1_000_000} megapixels). Resize it and upload it again.`);

  // Animated GIFs are re-encoded, which drops comments, location data and anything appended after the picture.
  if (meta.format === "gif" && frames > 1) {
    if (frames > MAX_GIF_FRAMES) throw new UploadError(`That GIF has ${frames} frames. The limit is ${MAX_GIF_FRAMES}.`);
    if (meta.width > MAX_ORIGINAL || frameHeight > MAX_ORIGINAL) throw new UploadError(`That GIF is wider or taller than ${MAX_ORIGINAL} pixels. Resize it and upload it again.`);
    let data;
    try {
      data = await open(buffer, { animated: true }).gif().toBuffer();
    } catch {
      throw new UploadError("That image couldn't be processed. It may be damaged. Try exporting it again.");
    }
    const rel = `${place(mediaDir, base, key, [{ tail: ".gif", data }])}.gif`;
    return { path: rel, mime, width: meta.width, height: frameHeight, size: data.length, variants: {} };
  }

  // One decode: oriented, resized to at most 2400 px and kept as raw pixels. The original and every variant are made from those pixels.
  let pixels;
  try {
    let decoded = open(buffer).rotate().resize({ width: MAX_ORIGINAL, withoutEnlargement: true });
    if (meta.space === "cmyk") decoded = decoded.toColourspace("srgb");
    pixels = await decoded.raw().toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new UploadError(/pixel limit/i.test(err.message) ? "That image is too large. Resize it and upload it again." : "That image couldn't be read. It may be damaged.");
  }
  const { width, height, channels } = pixels.info;
  const fromPixels = () => sharp(pixels.data, { raw: { width, height, channels } });
  const encode = (img, as) =>
    as === "jpg" ? img.jpeg({ quality: 82, mozjpeg: true }) : as === "png" ? img.png({ compressionLevel: 9 }) : as === "webp" ? img.webp({ quality: 80 }) : as === "gif" ? img.gif() : img.avif({ quality: 55, effort: 4 });

  // Anything sharp throws from here on becomes a plain upload error, and the big pixel buffer is let go as soon as it isn't needed.
  const files = [];
  const variants = { avif: [], webp: [] };
  let original;
  try {
    original = await encode(fromPixels(), ext).toBuffer();
    files.push({ tail: `.${ext}`, data: original });
    const widths = [...new Set([...WIDTHS.filter((w) => w < width), Math.min(width, WIDTHS.at(-1))])].sort((a, b) => a - b);
    for (const w of widths) {
      for (const [format, opts] of [["avif", { quality: 50, effort: 4 }], ["webp", { quality: 78 }]]) {
        files.push({ tail: `-${w}.${format}`, data: await fromPixels().resize({ width: w })[format](opts).toBuffer() });
        variants[format].push([w, `-${w}.${format}`]);
      }
    }
  } catch {
    throw new UploadError("That image couldn't be processed. It may be damaged or unusual. Try exporting it again as a JPEG or PNG.");
  } finally {
    pixels = null;
  }
  const stem = place(mediaDir, base, key, files);
  for (const list of Object.values(variants)) for (const entry of list) entry[1] = `${stem}${entry[1]}`;
  return { path: `${stem}.${ext}`, mime, width, height, size: original.length, variants };
}

// Downloadable files (circuit diagrams, 3D-print files, archives) are stored exactly as uploaded,
// after checking that the bytes match the type. They are always served as attachments.
export const FILE_TYPES = {
  pdf: { mime: "application/pdf", label: "PDF", check: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  stl: { mime: "model/stl", label: "STL", check: (b) => /^\s*solid[\s\S]*facet/i.test(b.subarray(0, 4096).toString("latin1")) || (b.length >= 84 && b.length === 84 + 50 * b.readUInt32LE(80)) },
  "3mf": { mime: "model/3mf", label: "3MF", check: isZip },
  step: { mime: "model/step", label: "STEP", check: (b) => b.subarray(0, 64).toString("latin1").trimStart().startsWith("ISO-10303-21") },
  stp: { mime: "model/step", label: "STEP", check: (b) => b.subarray(0, 64).toString("latin1").trimStart().startsWith("ISO-10303-21") },
  zip: { mime: "application/zip", label: "ZIP", check: isZip },
};
function isZip(b) {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
}
export const isFileUpload = (name) => Object.hasOwn(FILE_TYPES, path.extname(name || "").slice(1).toLowerCase());

export function processFile(buffer, originalName, mediaDir) {
  if (!buffer?.length) throw new UploadError("The file is empty.");
  const ext = path.extname(originalName || "").slice(1).toLowerCase();
  const type = Object.hasOwn(FILE_TYPES, ext) ? FILE_TYPES[ext] : null;
  if (!type) throw new UploadError(`Files of type .${ext} can't be uploaded. Use PDF, STL, 3MF, STEP or ZIP.`);
  if (!type.check(buffer)) throw new UploadError(`This doesn't look like a real ${type.label} file.`);
  const base = slugify(path.parse(originalName).name).slice(0, 60) || "file";
  const rel = `${place(mediaDir, base, inputKey(buffer), [{ tail: `.${ext}`, data: buffer }])}.${ext}`;
  return { path: rel, mime: type.mime, size: buffer.length, variants: {}, kind: "file" };
}

export function deleteMediaFiles(media, mediaDir) {
  const files = [media.path, ...Object.values(media.variants || {}).flat().map(([, p]) => p)];
  for (const f of files) fs.rmSync(path.join(mediaDir, f), { force: true });
}

// <picture> with AVIF/WebP sources, or a plain <img> for SVG/GIF. `url` maps a stored path to its URL.
// Each size list is used only when it has entries, so a row with WebP sizes but no AVIF list still renders.
export function pictureHtml(media, { url, alt = "", sizes = "100vw", eager = false, className = "" }) {
  const attrs = [
    `src="${escapeHtml(url(media.path))}"`,
    `alt="${escapeHtml(alt)}"`,
    media.width ? `width="${media.width}" height="${media.height}"` : "",
    eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"',
    'decoding="async"',
    className ? `class="${escapeHtml(className)}"` : "",
  ].filter(Boolean).join(" ");
  const v = media.variants || {};
  const srcset = (list) => list.map(([w, p]) => `${escapeHtml(url(p))} ${w}w`).join(", ");
  const sources = [["avif", "image/avif"], ["webp", "image/webp"]]
    .filter(([format]) => Array.isArray(v[format]) && v[format].length)
    .map(([format, type]) => `<source type="${type}" srcset="${srcset(v[format])}" sizes="${escapeHtml(sizes)}">`)
    .join("");
  if (!sources) return `<img ${attrs}>`;
  return `<picture>${sources}<img ${attrs}></picture>`;
}

// The best single file for a fixed size (OG images, RSS enclosures): a WebP near `target` px, else the original.
export function bestVariant(media, target = 1200) {
  const list = media.variants?.webp || [];
  const pick = list.find(([w]) => w >= target) || list.at(-1);
  return pick ? pick[1] : media.path;
}
