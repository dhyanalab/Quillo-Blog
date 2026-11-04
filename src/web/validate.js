// Small input checks shared by every route: emails, local paths, plain text, CSV cells and the one password policy.
import { MAX_PASSWORD, MIN_PASSWORD } from "./password.js";

// Control characters: C0 (0-31), DEL, C1 (128-159) and the Unicode line and paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const CONTROL_NO_NL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

export const hasControlChars = (s) => CONTROL.test(String(s ?? ""));

const LOCAL = /^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+)*$/u;
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;

// Exactly one "@", no spaces, quotes, brackets, commas, colons or control characters.
export function isEmail(s) {
  if (typeof s !== "string" || s.length < 3 || s.length > 254) return false;
  if (/[,;:"()[\]\\<>\s]/.test(s) || CONTROL.test(s)) return false;
  const parts = s.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !LOCAL.test(local)) return false;
  if (!domain || domain.length > 253) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((l) => l.length <= 63 && LABEL.test(l));
}

export const normalizeEmail = (s) => String(s ?? "").trim().toLowerCase();

// A path on this site: one leading "/", then not "/" or "\", no control characters or whitespace, at most 500 characters.
export function isSafeLocalPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 500) return false;
  if (p[0] !== "/" || p[1] === "/" || p[1] === "\\") return false;
  return !CONTROL.test(p) && !/\s/.test(p);
}

// Plain text from a form: control characters (except new lines) removed, trimmed, capped.
export function cleanText(s, max = 500) {
  return String(s ?? "").replace(CONTROL_NO_NL, "").trim().slice(0, max);
}

// One quoted CSV cell. Values that start with = + - @ or a tab or return would run as formulas in a spreadsheet, so they get a leading apostrophe.
export function csvCell(v) {
  let s = String(v ?? "").replace(CONTROL_NO_NL, "");
  if (/^[=+\-@\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// "jane@example.com" -> "j***@example.com"
export function maskEmail(e) {
  const s = String(e ?? "");
  const i = s.lastIndexOf("@");
  if (i < 1) return "***";
  return `${s[0]}***${s.slice(i)}`;
}

// Passwords that are far too common to allow, whatever their length.
const COMMON = new Set([
  "1234567890", "12345678910", "0123456789", "0987654321", "1111111111", "0000000000", "9999999999", "1234512345",
  "qwertyuiop", "qwerty1234", "qwerty12345", "qwertyuiop123", "asdfghjkl1", "asdfghjklq", "zxcvbnm123", "1q2w3e4r5t", "1qaz2wsx3edc",
  "password12", "password123", "password1234", "password12345", "passw0rd123", "p@ssw0rd123", "password1!", "passwordpassword",
  "letmein123", "letmein1234", "welcome123", "welcome1234", "iloveyou123", "iloveyou12", "changeme123", "administrator", "trustno1234",
  "abcdefghij", "abcd123456", "abc1234567", "abcabcabcabc", "internet123", "baseball123", "football123", "superman123", "monkey12345",
  "dragon12345", "sunshine123", "princess123", "whatever123", "starwars123", "computer123", "master12345", "shadow12345", "michael1234",
]);

// One password policy for staff and readers: "" when the password is allowed, or the plain message to show.
export function passwordProblem(password, { email = "", name = "" } = {}, what = "password") {
  if (password.length < MIN_PASSWORD) return `Use a ${what} of at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Use a ${what} of at most ${MAX_PASSWORD} characters.`;
  const low = password.toLowerCase();
  const local = String(email).toLowerCase().split("@")[0];
  if (COMMON.has(low) || /^(.)\1+$/.test(password) || low === String(email).toLowerCase() || low === local || low === String(name).toLowerCase()) {
    return `That ${what} is too easy to guess. Try a longer phrase made of a few words.`;
  }
  return "";
}

// Time zones for the settings lists: Node's own list with "UTC" added, and the old names it still uses (Asia/Calcutta)
// shown by their current ones (Asia/Kolkata). Any name in the list works with Intl, so dates come out right.
const RENAMED_ZONES = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "America/Godthab": "America/Nuuk",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "Pacific/Enderbury": "Pacific/Kanton",
};
export const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").map((z) => RENAMED_ZONES[z] || z).sort()];
const ZONE_SET = new Set(TIME_ZONES);
export const isTimeZone = (z) => typeof z === "string" && ZONE_SET.has(z);
// A saved zone as the lists show it (a blog that saved "Asia/Calcutta" sees "Asia/Kolkata" selected).
export const zoneName = (z) => RENAMED_ZONES[z] || z;
