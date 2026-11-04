export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function slugify(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

export const isSlug = (s) => typeof s === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);

// Offset of a time zone from UTC at a given instant, in ms.
function tzOffset(ts, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(ts / 1000) * 1000;
}

// "2026-11-10T19:30" in the site time zone -> ISO UTC string. Returns "" for bad input.
export function localInputToIso(value, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(value || ""))) return "";
  const guess = Date.parse(`${value}:00Z`);
  // A date that doesn't exist (month 13, hour 25, 31 February) is not a date: "" (never an error).
  if (!Number.isFinite(guess) || new Date(guess).toISOString().slice(0, 16) !== value) return "";
  try {
    let ts = guess - tzOffset(guess, timeZone);
    ts = guess - tzOffset(ts, timeZone);
    return new Date(ts).toISOString();
  } catch {
    return "";
  }
}

// ISO UTC -> "2026-11-10T19:30" in the site time zone, for <input type="datetime-local">.
export function isoToLocalInput(iso, timeZone) {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (isNaN(ts)) return "";
  return new Date(ts + tzOffset(ts, timeZone)).toISOString().slice(0, 16);
}

// ISO -> YYYY-MM-DD in the site time zone (for markup and sitemaps).
export function isoToYmd(iso, timeZone) {
  return isoToLocalInput(iso, timeZone).slice(0, 10);
}

// ISO -> "10 Nov 2026" in the site time zone.
export function formatDate(iso, timeZone = "UTC") {
  if (!iso || isNaN(Date.parse(iso))) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date(iso));
}

export function formatDateTime(iso, timeZone = "UTC") {
  if (!iso || isNaN(Date.parse(iso))) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

// ISO with the site's UTC offset, e.g. 2026-11-10T19:30:00+05:30 (for structured data).
export function isoWithOffset(iso, timeZone) {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const off = tzOffset(ts, timeZone) / 60000;
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${new Date(ts + off * 60000).toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

export const rfc822 = (iso) => new Date(iso).toUTCString();

// "PT8M4S" -> 484
export function isoDurationToSeconds(value) {
  const m = /^P(?:(\d{1,6})D)?(?:T(?:(\d{1,6})H)?(?:(\d{1,6})M)?(?:(\d{1,6}(?:\.\d{1,3})?)S)?)?$/.exec(String(value || ""));
  if (!m || value === "P" || value === "PT") return null;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return Math.round(+d * 86400 + +h * 3600 + +min * 60 + +s);
}

// "1:02:03" / "0:15" -> seconds
export function timestampToSeconds(value) {
  const parts = String(value ?? "").trim().split(":");
  // h:mm:ss at most, and each part a few digits: a long run of digits is not a time (it would become Infinity).
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d{1,5}$/.test(p))) return null;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

export function secondsToClock(total) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export const countWords = (markdown) => String(markdown ?? "").trim().split(/\s+/).filter(Boolean).length;

// Same rule as the Content Hub Preview: words / 230, rounded, at least 1.
export const readingMinutes = (words) => Math.max(1, Math.round(words / 230));

// A full http(s) address: written with "://" (so "https:evil.example" and "http:\\host", which browsers read differently, are
// refused), no backslash, no spaces or control characters, no user:password@, a real host.
export const isHttpUrl = (v) => {
  if (typeof v !== "string" || v.length > 2048 || /[\s\u0000-\u001f\u007f\\]/.test(v) || !/^https?:\/\/[^/?#]/i.test(v)) return false;
  try {
    const u = new URL(v);
    return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && Boolean(u.hostname);
  } catch {
    return false;
  }
};

// Text that is safe inside XML 1.0 (RSS, sitemaps): drops the control characters and lone surrogates XML forbids.
export const xmlText = (v) => String(v ?? "").replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "");

// Content-Disposition for a download: a plain ASCII name plus the full UTF-8 name (RFC 6266), never raw header text.
export function contentDisposition(name, type = "attachment") {
  const clean = String(name ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/[\\/]/g, "_").slice(0, 150) || "download";
  const ascii = clean.replace(/[^\x20-\x7e]|["%;\\]/g, "_");
  const star = encodeURIComponent(clean).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  return type + '; filename="' + ascii + "\"; filename*=UTF-8''" + star;
}

// User text -> safe FTS5 query: each word quoted. Words of three letters or more are prefix-matched ("esp" finds "esp32"); a
// two-letter word must match exactly and a one-letter word is left out, because short prefixes are the costliest to look up.
// Only the first three prefix words are prefix-matched; the others must match exactly. At most six words.
export function ftsQuery(q) {
  const words = String(q ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  let prefixes = 0;
  return words.filter((w) => [...w].length >= 2).slice(0, 6).map((w) => ([...w].length >= 3 && prefixes++ < 3 ? `"${w}"*` : `"${w}"`)).join(" ");
}

export const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
