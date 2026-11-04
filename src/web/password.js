// scrypt password hashes: "scrypt$N$r$p$salt$hash" (base64). No native dependencies.
import crypto from "node:crypto";
import os from "node:os";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
// N=2^16, r=8, p=2 (64 MiB): one of OWASP's equal-strength scrypt settings.
const PARAMS = { N: 65536, r: 8, p: 2 };
const KEYLEN = 64;

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 256;

// The most a stored hash may ask for (N-014). Older hashes made with cheaper settings stay valid.
const MAX_COST = { N: 2 ** 17, r: 16, p: 4 };

// Node's default scrypt memory limit is 32 MiB, so ask for what the cost needs (a little over 128 * N * r, plus 1 MiB of room).
const maxmem = ({ N, r, p }) => 129 * N * r + 130 * r * p + 1024 * 1024;

// Capacity gate: password hashing runs on libuv's small thread pool and costs 64 MiB each, so only a few run at once,
// a short line may wait, and everyone else is told the site is busy (error code "BUSY") instead of queueing without end.
export const gateLimits = { running: Math.max(1, Math.min(4, os.availableParallelism())), waiting: 64 };
let running = 0;
const waiting = [];
export const gateState = () => ({ running, waiting: waiting.length });

function gated(job) {
  return new Promise((resolve, reject) => {
    const start = () => {
      running++;
      Promise.resolve()
        .then(job)
        .then(resolve, reject)
        .finally(() => {
          running--;
          const next = waiting.shift();
          if (next) next();
        });
    };
    if (running < gateLimits.running) return start();
    if (waiting.length >= gateLimits.waiting) {
      const err = new Error("The site is busy right now. Please try again in a minute.");
      err.code = "BUSY";
      return reject(err);
    }
    waiting.push(start);
  });
}

export async function hashPassword(password) {
  const text = String(password);
  if (text.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  if (text.length > MAX_PASSWORD) throw new Error(`Password must be at most ${MAX_PASSWORD} characters`);
  const salt = crypto.randomBytes(16);
  const hash = await gated(() => scrypt(text, salt, KEYLEN, { ...PARAMS, maxmem: maxmem(PARAMS) }));
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

const work = ({ N, r, p }) => N * r * p;

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const cost = { N: +N, r: +r, p: +p };
  // A damaged or hostile stored value must not ask for unbounded memory.
  if (![cost.N, cost.r, cost.p].every(Number.isInteger) || cost.N < 2 || cost.N > MAX_COST.N || cost.r < 1 || cost.r > MAX_COST.r || cost.p < 1 || cost.p > MAX_COST.p) return false;
  const text = String(password ?? "");
  if (text.length > MAX_PASSWORD) return false;
  const expected = Buffer.from(hash, "base64");
  return gated(async () => {
    const actual = await scrypt(text, Buffer.from(salt, "base64"), expected.length || KEYLEN, { ...cost, maxmem: maxmem(cost) });
    // An account still on a cheaper hash would answer faster than an unknown address (which costs the full amount).
    // Top the work up to the current cost so the two take about the same time. The result is thrown away.
    const missing = work(PARAMS) - work(cost);
    if (missing > 0) {
      const pad = { N: 16384, r: 8, p: Math.max(1, Math.round(missing / (16384 * 8))) };
      await scrypt(text, Buffer.from(salt, "base64"), KEYLEN, { ...pad, maxmem: maxmem(pad) });
    }
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  });
}

// True when a stored hash was made with weaker settings than the current ones (rehash after a good login).
export function needsRehash(stored) {
  const [scheme, N, r, p] = String(stored).split("$");
  if (scheme !== "scrypt") return true;
  return +N < PARAMS.N || +r < PARAMS.r || +p < PARAMS.p;
}

// A hash nobody can match, built from PARAMS, so unknown emails cost as much as known ones.
export const DUMMY_HASH = `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${Buffer.alloc(16, 1).toString("base64")}$${Buffer.alloc(KEYLEN, 2).toString("base64")}`;
