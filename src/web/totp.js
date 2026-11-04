// Authenticator-app codes (TOTP, RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), the otpauth:// link the
// QR code carries, and single-use recovery codes. Works with Google Authenticator, Microsoft Authenticator,
// Zoho OneAuth, Authy, 1Password and every other standard app; nothing is sent anywhere.
import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Not a base32 secret");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// A new 160-bit secret, as base32 (what authenticator apps expect).
export const newSecret = () => base32Encode(crypto.randomBytes(20));

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

// The code for one 30-second step.
export function codeAt(secret, step, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(n).padStart(digits, "0");
}

// Checks a typed code against the current step and one step either side (for clock drift).
// Steps at or before `afterStep` and steps listed in `used` are refused, so each code works only once.
// Tracking the used steps (not just the latest) means a code from the next step, used early, can't block the real current code.
// Returns the matching step, or 0.
export function matchCode(secret, code, { afterStep = 0, used = [], now = Date.now() } = {}) {
  const typed = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return 0;
  const current = stepAt(now);
  let found = 0;
  for (const step of [current - 1, current, current + 1]) {
    // Compare every candidate in constant time, so timing doesn't reveal which step matched.
    const same = crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(typed));
    if (same && !found && step > afterStep && !used.includes(step)) found = step;
  }
  return found;
}

// The link authenticator apps read from the QR code.
export function otpauthUrl({ issuer, account, secret }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${q}`;
}

// Recovery codes look like K7Q2M-XW4TP: 50 random bits each, easy to read and type.
export const RECOVERY_COUNT = 10;
export function newRecoveryCode() {
  const s = base32Encode(crypto.randomBytes(7)).slice(0, 10);
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
export const normalizeRecoveryCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
export const looksLikeRecoveryCode = (code) => normalizeRecoveryCode(code).length === 10;
// Codes are told apart by length: a recovery code is 10 base32 characters, an authenticator code is 6 digits.
export const looksLikeTotpCode = (code) => /^\d{6}$/.test(String(code || "").replace(/\s/g, ""));
