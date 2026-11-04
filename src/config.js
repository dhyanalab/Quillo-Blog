import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

const normalizeBase = (value) => {
  const p = String(value).trim().replace(/\/+$/, "");
  return p && !p.startsWith("/") ? `/${p}` : p;
};

// SITE_URL must be a plain http(s) address. Returns its origin ("" when unset); a bad value stops the start-up with a clear message.
function checkSiteUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SITE_URL "${raw}" is not a valid web address. Use something like https://example.com`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new Error(`SITE_URL "${raw}" must be a plain http:// or https:// address, with no login details.`);
  }
  return url.origin;
}

// ADMIN_HOST is a bare host name (with an optional port): the only address the admin answers on. "" when unset.
function checkAdminHost(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(raw) || raw.includes("..")) {
    throw new Error(`ADMIN_HOST "${raw}" must be a host name such as admin.example.com (no https://, no path).`);
  }
  return raw;
}

// A number from the environment. A missing value gives the default; a value that is not a usable number
// (like "15MB") also gives the default, and the reason goes into `warnings` for the dashboard and the console.
function numberSetting(name, raw, { def, min, max, integer = true }, warnings) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    warnings.push(`${name} is "${String(raw).slice(0, 40)}", which is not a number from ${min} to ${max}, so the default (${def}) is used.`);
    return def;
  }
  return n;
}

function usableSetupToken(raw, warnings) {
  const token = String(raw ?? "");
  if (token && token.length < 10) {
    const sentence = "SETUP_TOKEN is shorter than 10 characters, so it is ignored and a random one is made at each start until the owner exists.";
    warnings.push(sentence);
    console.warn(`Warning: ${sentence}`);
    return "";
  }
  return token;
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

// Runtime configuration from the environment. Site content settings (title, URL, menus...) live in the database.
export function loadConfig(overrides = {}) {
  const env = process.env;
  const warnings = [];
  // Production unless NODE_ENV=development or the server was started with --dev (npm run dev does that).
  const dev = overrides.dev ?? (env.NODE_ENV === "development" || process.argv.includes("--dev"));
  const production = overrides.production ?? !dev;
  const trust = overrides.trustProxy ?? env.TRUST_PROXY;
  const maxUploadMb = numberSetting("MAX_UPLOAD_MB", overrides.maxUploadMb ?? env.MAX_UPLOAD_MB, { def: 15, min: 1, max: 500, integer: false }, warnings);
  return {
    root: ROOT,
    port: overrides.port !== undefined || env.PORT === undefined || env.PORT === "" ? Number(overrides.port) || 4100 : numberSetting("PORT", env.PORT, { def: 4100, min: 1, max: 65535 }, warnings),
    host: overrides.host ?? env.HOST ?? "127.0.0.1",
    production,
    dev: !production,
    // Where the blog lives on the domain: "" (the whole domain, default) or a folder such as "/blog".
    basePath: normalizeBase(overrides.basePath ?? env.BASE_PATH ?? ""),
    dataDir: path.resolve(ROOT, overrides.dataDir ?? env.DATA_DIR ?? "data"),
    // When set, wins over the Site URL setting. Set it in production so links never depend on an editable setting.
    siteUrl: checkSiteUrl(overrides.siteUrl ?? env.SITE_URL),
    // When set, the admin answers only on this host (for example admin.example.com) and public pages on it go to the Site URL.
    adminHost: checkAdminHost(overrides.adminHost ?? env.ADMIN_HOST),
    // Trust X-Forwarded-For / X-Forwarded-Proto / X-Forwarded-Host from a reverse proxy. "1", "true", "yes" and "on" all mean yes.
    trustProxy: trust === true || truthy(trust),
    // How many proxies sit in front of the app. The visitor's address (and the scheme and host the proxy reported) is the
    // X-Forwarded-* entry this many places from the right.
    proxyHops: numberSetting("PROXY_HOPS", overrides.proxyHops ?? env.PROXY_HOPS, { def: 1, min: 1, max: 10 }, warnings),
    // Needed to create the first owner account: from SETUP_TOKEN, or generated at start-up while no owner exists (see app.js).
    // A supplied setup token shorter than 10 characters is ignored (treated as unset, so a random one is made while no owner exists).
    setupToken: usableSetupToken(overrides.setupToken ?? env.SETUP_TOKEN, warnings),
    // IndexNow pings and other outbound calls; off in tests.
    outbound: overrides.outbound ?? env.BLOG_OUTBOUND !== "0",
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    // Nodemailer transport options that replace the SMTP settings (tests use { jsonTransport: true }).
    mailTransport: overrides.mailTransport ?? null,
    // Pause between newsletter emails, to stay under email services' rate limits.
    mailDelayMs: overrides.mailDelayMs ?? numberSetting("MAIL_DELAY_MS", env.MAIL_DELAY_MS, { def: 400, min: 0, max: 60_000 }, warnings),
    // HSTS also covering sub-domains is the owner's choice (HSTS_SUBDOMAINS=1), never the default.
    hstsSubdomains: overrides.hstsSubdomains ?? truthy(env.HSTS_SUBDOMAINS),
    // Newsletters that were sending when the server stopped carry on at start-up unless RESUME_NEWSLETTERS=0.
    resumeNewsletters: overrides.resumeNewsletters ?? env.RESUME_NEWSLETTERS !== "0",
    // One address may hold this many connections at once (only when no proxy is in front; the proxy should limit then).
    maxConnectionsPerIp: numberSetting("MAX_CONNECTIONS_PER_IP", overrides.maxConnectionsPerIp ?? env.MAX_CONNECTIONS_PER_IP, { def: 100, min: 5, max: 1024 }, warnings),
    // Escape hatches for start-up checks that otherwise stop the server in production.
    allowMigrationDrift: overrides.allowMigrationDrift ?? env.ALLOW_MIGRATION_DRIFT === "1",
    allowBackupFailure: overrides.allowBackupFailure ?? env.ALLOW_BACKUP_FAILURE === "1",
    // Plain sentences about settings that were not usable (shown on the owner's dashboard).
    warnings,
  };
}
