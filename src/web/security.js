// Security headers, same-origin checks for form posts, client IPs, cookies and simple rate limits.
import crypto from "node:crypto";
import net from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { routePath } from "hono/route";

// Constant-time string comparison (works for different lengths, never throws).
export function safeEq(a, b) {
  const h = (v) => crypto.createHash("sha256").update(String(v ?? "")).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// True for the admin area itself, not for look-alike paths such as /admin-news/.
export const isAdminPath = (path, base = "") => path === `${base}/admin` || path.startsWith(`${base}/admin/`);

// `analytics` adds the visitor-analytics tracker's own addresses on public pages.
// Public pages allow the public inline scripts (`scriptHashes`) and their one inline stylesheet (`styleHashes`);
// admin pages only their own scripts (`adminScriptHashes`).
export function securityHeaders({ scriptHashes, adminScriptHashes = [], styleHashes = [], admin, https, analytics = null, hstsSubdomains = false }) {
  const csp = [
    "default-src 'self'",
    ["script-src 'self'", ...(admin ? adminScriptHashes : scriptHashes), ...(analytics?.scriptSrc || [])].join(" "),
    // No page uses inline event handlers (onclick=...), so none are allowed.
    "script-src-attr 'none'",
    // Public pages: files from this site and the one inline stylesheet, nothing else. The admin keeps inline styles, which the editor needs.
    admin ? "style-src 'self' 'unsafe-inline'" : ["style-src 'self'", ...styleHashes].join(" "),
    admin ? "img-src 'self' data: blob:" : "img-src 'self' data: https://i.ytimg.com",
    "font-src 'self'",
    ["connect-src 'self'", ...(analytics?.connectSrc || [])].join(" "),
    admin ? "frame-src 'none'" : "frame-src https://www.youtube-nocookie.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${admin ? "'none'" : "'self'"}`,
  ].join("; ");
  const headers = {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  if (admin) {
    headers["X-Frame-Options"] = "DENY";
    headers["Cross-Origin-Resource-Policy"] = "same-origin";
    // Trusted Types would stop most script injection through the editor, but the editor's own bundle writes HTML strings
    // everywhere, so enforcing it breaks the editor. Report-only shows any problems in the browser console without breaking anything.
    headers["Content-Security-Policy-Report-Only"] = "require-trusted-types-for 'script'";
  }
  // Sub-domains are covered only when the owner asks for it (HSTS_SUBDOMAINS=1).
  if (https) headers["Strict-Transport-Security"] = `max-age=31536000${hstsSubdomains ? "; includeSubDomains" : ""}`;
  return headers;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// Text that is safe to write to a log line: control characters (new lines, terminal escape sequences) become "?" and
// anything that looks like a secret token (a long run of letters, digits, "-" and "_") is hidden.
export const logSafe = (value, max = 200) => String(value ?? "").replace(CONTROL_CHARS, "?").replace(/[A-Za-z0-9_-]{32,}/g, "[hidden]").slice(0, max);

// The route pattern ("/verify/:token/") for a log line, never the real path: real paths carry reset, verify, confirm and
// unsubscribe tokens, and Hono has already percent-decoded them (so %0A is a real new line).
export function logPath(c) {
  try {
    const route = routePath(c);
    if (route && !route.includes("*")) return logSafe(route);
  } catch {
    // not inside a matched route: use the cleaned path below
  }
  const path = String(c.req.path || "").split("/").map((seg) => (seg.length >= 20 ? ":hidden" : seg)).join("/");
  return logSafe(path);
}

const firstValue = (v) => String(v || "").split(",")[0].trim();

// Makes an address a rate-limit key: IPv6 becomes its /64 prefix, IPv4-mapped IPv6 becomes IPv4.
export function normalizeIp(raw) {
  let ip = String(raw || "").trim();
  if (!ip) return "";
  const bracket = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) ip = bracket[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  ip = ip.replace(/%.*$/, "");
  const kind = net.isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return "";
  // Expand "::" and an embedded IPv4 tail into eight 16-bit groups.
  const m4 = ip.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m4) {
    const o = m4[2].split(".").map(Number);
    ip = `${m4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, rest] = ip.split("::");
  const a = head ? head.split(":") : [];
  const b = rest !== undefined && rest ? rest.split(":") : [];
  const groups = rest === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  const g = groups.map((x) => parseInt(x, 16));
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return "";
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  if (mapped) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

// The wider /48 key for an IPv6 per-client key ("" for IPv4 and anything else).
export function wideKey(key) {
  const m = /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(String(key));
  return m ? `${m[1]}::/48` : "";
}

// Records a sentence for the owner's dashboard (ctx.warnings), once.
const note = (ctx, sentence) => {
  try {
    ctx?.warn?.(sentence);
  } catch {
    // warnings are advice only
  }
};

let warnedProxy = false;

// The entry `proxyHops` from the right of a comma-separated forwarded header (the one the nearest proxy itself appended;
// everything to the left is whatever the client sent). "" when the header has fewer entries than there are proxies.
function forwardedValue(c, ctx, name) {
  const parts = String(c.req.header(name) || "").split(",").map((s) => s.trim()).filter(Boolean);
  const hops = Math.max(1, Number(ctx?.config?.proxyHops) || 1);
  return parts.length >= hops ? parts[parts.length - hops] : "";
}

// The visitor's address, safe to use as a rate-limit key. Behind a trusted proxy it is the
// X-Forwarded-For entry `proxyHops` from the right (the one the proxy itself appended). When the header is shorter than
// the hop count, or the entry is not an address, the socket's own address is used. Never returns "".
export function clientIp(c, ctx) {
  const config = ctx?.config || {};
  if (config.trustProxy) {
    const hops = Math.max(1, Number(config.proxyHops) || 1);
    const parts = String(c.req.header("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= hops) {
      const ip = normalizeIp(parts[parts.length - hops]);
      if (ip) return ip;
    }
    if (parts.length) note(ctx, `A request arrived with an X-Forwarded-For header that does not match PROXY_HOPS=${hops} (it had ${parts.length} address${parts.length === 1 ? "" : "es"} or an unreadable one). Check PROXY_HOPS and that your proxy sets X-Forwarded-For; until then visitors share one rate limit.`);
  }
  // Behind a proxy without TRUST_PROXY, every visitor would share the proxy's address (one rate-limit bucket): say so once.
  if (!config.trustProxy && c.req.header("x-forwarded-for")) {
    note(ctx, "Requests carry an X-Forwarded-For header but TRUST_PROXY is not set, so every visitor shares one rate limit and sign-in limits can lock everyone out. If a reverse proxy sits in front of this site, set TRUST_PROXY=1 (see the README).");
    if (!warnedProxy) {
      warnedProxy = true;
      console.warn("Warning: requests carry X-Forwarded-For but TRUST_PROXY is not set, so all visitors share one rate limit. Set TRUST_PROXY=1 if a reverse proxy sits in front of this app (see the README).");
    }
  }
  try {
    return normalizeIp(getConnInfo(c).remote.address) || "unknown";
  } catch {
    return "unknown";
  }
}

// Whether the browser reached us over HTTPS (used for the Secure flag on every cookie).
export function isHttps(c, ctx) {
  if (ctx?.config?.trustProxy && forwardedValue(c, ctx, "x-forwarded-proto").toLowerCase() === "https") return true;
  try {
    if (new URL(c.req.url).protocol === "https:") return true;
  } catch {
    // fall through
  }
  return Boolean(ctx?.site?.().https);
}

// The host the browser asked for (with its port), lower-cased. Behind a trusted proxy it is what the proxy reported.
export function requestHost(c, ctx) {
  const reported = ctx?.config?.trustProxy ? forwardedValue(c, ctx, "x-forwarded-host") : "";
  let host = reported || c.req.header("host") || "";
  if (!host) {
    try {
      host = new URL(c.req.url).host;
    } catch {
      host = "";
    }
  }
  return host.toLowerCase();
}

// Hosts a form post may come from when no trusted proxy tells us the real host: this site's own host, the admin host,
// this machine and bare IP addresses. A made-up name that a DNS-rebinding page points at us is none of those.
function ownHost(host, ctx) {
  const bare = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!bare) return false;
  if (net.isIP(bare) || bare === "localhost" || bare.endsWith(".localhost")) return true;
  const known = new Set();
  const add = (v) => {
    try {
      if (v) known.add(new URL(v.includes("://") ? v : `http://${v}`).host.toLowerCase());
    } catch {
      // not a usable address
    }
  };
  add(ctx?.config?.siteUrl);
  add(ctx?.config?.adminHost);
  try {
    add(ctx?.site?.().origin);
  } catch {
    // site settings unreadable: only the configured hosts count
  }
  // "www.example.com" and "example.com" are the same site for this purpose.
  const plain = (h) => h.replace(/^www\./, "");
  return [...known].some((k) => k === host || plain(k) === plain(host));
}

// Rejects form posts whose Origin (or Referer) is another site, comparing scheme and host.
export function sameOrigin(c, ctx) {
  const config = ctx?.config || {};
  const host = requestHost(c, ctx);
  const scheme = isHttps(c, ctx) ? "https" : "http";
  const allowed = new Set();
  // Behind a trusted proxy the host is the proxy's report; otherwise it must be one of this site's own hosts.
  if (host && (config.trustProxy || ownHost(host, ctx))) allowed.add(`${scheme}://${host}`);
  if (config.adminHost) allowed.add(`${scheme}://${config.adminHost}`);
  try {
    const site = ctx?.site?.().origin;
    if (site) allowed.add(site.toLowerCase());
  } catch {
    // site settings unreadable: only the request's own origin counts
  }
  const source = c.req.header("origin") || c.req.header("referer");
  if (!source) {
    // Some clients send neither header; accept only what the browser itself marks as same-origin (not "none": that is a typed address, not a form post).
    return c.req.header("sec-fetch-site") === "same-origin";
  }
  try {
    return allowed.has(new URL(source).origin.toLowerCase());
  } catch {
    return false;
  }
}

// Cookies. On https every cookie is named "__Host-<name>" (Secure, Path=/, no Domain), which a sibling sub-domain cannot overwrite.
// Over plain http (development) the plain name is used. Cookies set before this change carry the plain name: they are still
// read once, then re-issued under the new name.
const LEGACY_LIFETIMES = { sid: 14 * 86400, mid: 30 * 86400, kd: 180 * 86400, mkd: 180 * 86400 };
const reissued = new WeakMap(); // request context -> names already re-issued

export const cookieName = (c, ctx, base) => (isHttps(c, ctx) ? `__Host-${base}` : base);

// opts: { path, maxAge, sameSite, httpOnly, legacyPath }. The path is forced to "/" for the prefixed name.
export function setAppCookie(c, ctx, base, value, opts = {}) {
  const https = isHttps(c, ctx);
  const o = { path: https ? "/" : opts.path || "/", httpOnly: opts.httpOnly !== false, sameSite: opts.sameSite || "Lax", secure: https };
  if (opts.maxAge) o.maxAge = opts.maxAge;
  setCookie(c, https ? `__Host-${base}` : base, value, o);
  // Over https the old plain-named cookie is now stale: remove it where it was set.
  if (https && getCookie(c, base) !== undefined) clearLegacy(c, ctx, base, opts.legacyPath);
}

function clearLegacy(c, ctx, base, legacyPath) {
  const root = ctx?.config?.basePath || "";
  const paths = new Set([legacyPath, `${root}/admin`, `${root}/`, "/"].filter((p) => typeof p === "string" && p));
  for (const path of paths) deleteCookie(c, base, { path, secure: isHttps(c, ctx) });
}

// Reads the prefixed name first, then the old plain one. A value found only under the old name is re-issued under the new name.
export function readCookie(c, ctx, base, opts = {}) {
  const https = isHttps(c, ctx);
  if (https) {
    const v = getCookie(c, `__Host-${base}`);
    if (v) return v;
  }
  const legacy = getCookie(c, base);
  if (!legacy || !https) return legacy;
  let done = reissued.get(c);
  if (!done) reissued.set(c, (done = new Set()));
  if (!done.has(base)) {
    done.add(base);
    try {
      setAppCookie(c, ctx, base, legacy, { maxAge: LEGACY_LIFETIMES[base], ...opts });
    } catch {
      // the response is not writable here (for example a fake request in a test): the old cookie still works
    }
  }
  return legacy;
}

// Deletes the cookie under both names. `legacyPath` is where the old plain-named cookie was set.
export function clearAppCookie(c, ctx, base, legacyPath) {
  const https = isHttps(c, ctx);
  if (https) deleteCookie(c, `__Host-${base}`, { path: "/", secure: true });
  deleteCookie(c, base, { path: legacyPath || "/", secure: https });
}

// Sliding-window counters per key (e.g. login attempts per IP). Refused attempts are not counted. The key table is capped:
// only expired keys are ever evicted (a few from the front of the table on each call), so a flood of new keys can never push
// out a victim's counters; when the table is full of live keys a new key is refused instead (it fails closed).
// With `persist: { scope, store }` (store = ctx.store.rateLimits) nothing is kept in memory: counters live in the database
// and survive a restart. `limiter.wide` is a sibling with four times the limit, for IPv6 /48 networks (see takeClient).
export function createRateLimiter({ limit, windowMs, maxKeys = 50_000, persist = null }) {
  const hits = new Map(); // key -> { start, cur, prev }

  // Moves the entry's window forward to `t`.
  const roll = (e, t) => {
    const n = Math.floor((t - e.start) / windowMs);
    if (n >= 1) {
      e.prev = n === 1 ? e.cur : 0;
      e.cur = 0;
      e.start += n * windowMs;
    }
  };
  const used = (e, t) => e.prev * (1 - (t - e.start) / windowMs) + e.cur;
  const expired = (e, t) => t - e.start >= 2 * windowMs;

  // Drops up to `n` expired entries, looking only at the front (the least recently used keys).
  const evict = (t, n) => {
    let seen = 0;
    for (const [k, e] of hits) {
      if (seen++ >= n) break;
      if (expired(e, t)) hits.delete(k);
    }
  };
  const sweep = () => {
    const t = Date.now();
    for (const [k, e] of hits) if (expired(e, t)) hits.delete(k);
  };
  const timer = persist ? null : setInterval(sweep, Math.min(Math.max(windowMs, 1000), 60_000));
  timer?.unref?.();

  // In-memory counting, also the fallback when the database cannot be reached.
  const memory = {
    take(key) {
      const t = Date.now();
      let e = hits.get(key);
      if (e) {
        hits.delete(key); // re-insert below, so the least recently used keys stay at the front
        roll(e, t);
      } else {
        evict(t, hits.size >= maxKeys ? 256 : 4);
        if (hits.size >= maxKeys) return false;
        e = { start: t, cur: 0, prev: 0 };
      }
      hits.set(key, e);
      if (used(e, t) + 1 > limit) return false;
      e.cur++;
      return true;
    },
    count(key) {
      const e = hits.get(key);
      if (!e) return 0;
      const t = Date.now();
      roll(e, t);
      return Math.ceil(used(e, t));
    },
    reset: (key) => hits.delete(key),
  };

  let sibling = null;
  const limiter = {
    // Returns true while the key is under its limit.
    take(key) {
      if (!persist) return memory.take(key);
      try {
        const t = Date.now();
        const e = persist.store.get(persist.scope, key) || { start: t, cur: 0, prev: 0 };
        roll(e, t);
        if (used(e, t) + 1 > limit) return false;
        e.cur++;
        persist.store.set(persist.scope, key, { start: e.start, cur: e.cur, prev: e.prev, expires: e.start + 2 * windowMs });
        return true;
      } catch {
        return memory.take(key);
      }
    },
    // How many attempts the key has used in the current window (rounded up).
    count(key) {
      if (!persist) return memory.count(key);
      try {
        const e = persist.store.get(persist.scope, key);
        if (!e) return 0;
        const t = Date.now();
        roll(e, t);
        return Math.ceil(used(e, t));
      } catch {
        return memory.count(key);
      }
    },
    reset(key) {
      if (!persist) return memory.reset(key);
      try {
        persist.store.delete(persist.scope, key);
      } catch {
        // fall through to memory
      }
      return memory.reset(key);
    },
    get size() {
      return hits.size;
    },
    // A limiter for the wider IPv6 network (/48): four times the limit.
    get wide() {
      sibling ??= createRateLimiter({ limit: limit * 4, windowMs, maxKeys, persist: persist && { ...persist, scope: `${persist.scope}:wide` } });
      return sibling;
    },
    stop() {
      if (timer) clearInterval(timer);
      sibling?.stop();
    },
  };
  return limiter;
}

// Takes one attempt for the visitor: their own address key (an IPv4 address or IPv6 /64), and for IPv6 also the /48 network key
// on the limiter's wide sibling, so one network can't multiply its budget by using many /64s. True only if both pass.
export function takeClient(limiter, c, ctx) {
  const key = clientIp(c, ctx);
  if (!limiter.take(key)) return false;
  const wide = wideKey(key);
  return wide ? limiter.wide.take(wide) : true;
}

export const isBot = (ua = "") => /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|monitor/i.test(ua);
