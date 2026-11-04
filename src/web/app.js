// Builds the Hono app: data store, page cache, views, public site and admin.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import { createStore } from "../store/index.js";
import { createAssets, editorBundleProblem } from "./assets.js";
import { createPageCache } from "./cache.js";
import { publicRoutes } from "./public.js";
import { adminRoutes } from "./admin.js";
import { createRateLimiter, isAdminPath, isHttps, logPath, logSafe, readCookie, requestHost, securityHeaders } from "./security.js";
import { createSecrets } from "./secrets.js";
import { buildSite } from "./site.js";
import { createViews } from "./views.js";
import { createIndexNow } from "../services/indexnow.js";
import { createMailer } from "../services/mailer.js";
import { createNewsletterSender } from "../services/newsletter.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

// Every rate limit in one place, shared by the admin and public routes.
// The ones that guard accounts and mail (sign-in per account, step-up checks, setup, forgot, sign-up) keep their counters in
// the database, so a restart or a crash loop does not hand attackers fresh budgets. Without the store they stay in memory.
function createLimiters(store) {
  const l = (limit, windowMs) => createRateLimiter({ limit, windowMs });
  const kept = (scope, limit, windowMs) => createRateLimiter({ limit, windowMs, persist: store?.rateLimits ? { scope, store: store.rateLimits } : null });
  return {
    login: l(10, 15 * MIN), // staff sign-in, per address; every attempt counts
    loginAccount: kept("loginAccount", 5, 15 * MIN), // staff sign-in, per account; failures only
    step: kept("step", 5, 15 * MIN), // password or code checks on account changes, per session
    signin: l(10, 15 * MIN), // reader sign-in, per address
    signinAccount: kept("signinAccount", 5, 15 * MIN), // reader sign-in, per account
    signup: kept("signup", 5, HOUR),
    subscribe: l(5, HOUR),
    beacon: l(120, MIN),
    comment: l(6, MIN),
    like: l(30, MIN),
    search: l(30, MIN),
    setup: kept("setup", 10, HOUR),
    forgot: kept("forgot", 5, HOUR),
  };
}

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  // Plain sentences for the owner's dashboard (ctx.warnings): settings that were not usable, things found at start-up.
  const noted = new Set(config.warnings);
  const dbExisted = fs.existsSync(path.join(config.dataDir, "blog.db"));
  const secrets = createSecrets(config.dataDir);
  const dbWarnings = [];
  const db = openDb(config.dataDir, {
    production: config.production,
    secrets,
    warnings: dbWarnings,
    allowMigrationDrift: config.allowMigrationDrift,
    allowBackupFailure: config.allowBackupFailure,
  });
  for (const w of dbWarnings) noted.add(w);
  // A wrong DATA_DIR looks like a blog that lost everything: say what was found.
  if (config.production) {
    const where = config.dataDir;
    if (!dbExisted) {
      const w = `A new, empty database was created in ${where}. If you expected your existing blog, DATA_DIR points at the wrong folder.`;
      noted.add(w);
      console.warn(`Warning: ${w}`);
    } else if (!fs.existsSync(path.join(where, "media"))) {
      const w = `The database in ${where} exists but its media folder is missing, so uploaded pictures and files will not show. Check DATA_DIR or restore the media folder.`;
      noted.add(w);
      console.warn(`Warning: ${w}`);
    }
  }
  const cache = createPageCache();
  let site = null;
  const store = createStore(db, {
    basePath: config.basePath,
    secrets,
    onChange: () => {
      cache.clear();
      site = null;
    },
  });

  // Sealed values (two-step secrets, the email password) that the current key cannot open: a lost or replaced key.
  const keyProblem = secrets.verify(db);
  if (keyProblem) {
    noted.add(keyProblem);
    console.error(`Warning: ${keyProblem}`);
  }
  const bundleProblem = editorBundleProblem();
  if (bundleProblem) noted.add(bundleProblem);
  // A restored older database must not bring back people who unsubscribed: apply the suppression list now.
  try {
    store.subscribers.applySuppressionList?.();
  } catch (err) {
    console.warn(`Warning: could not apply the unsubscribe list (${logSafe(err?.message)}).`);
  }
  // Expired rate-limit rows are removed now and then.
  if (store.rateLimits?.prune) {
    const prune = () => {
      try {
        store.rateLimits.prune(Date.now());
      } catch {
        // housekeeping only
      }
    };
    prune();
    setInterval(prune, 10 * MIN).unref?.();
  }

  // Creating the first owner always needs a setup token: SETUP_TOKEN, or a random one made now (server.js prints the link).
  if (!config.setupToken && !store.users.hasOwner()) {
    config.setupToken = crypto.randomBytes(16).toString("hex");
    config.setupTokenGenerated = true;
  }

  const ctx = {
    config,
    db,
    store,
    cache,
    secrets,
    limiters: createLimiters(store),
    // Sentences about this installation for the owner (shown on the dashboard): start-up findings plus live checks of the Site URL.
    warn: (sentence) => noted.add(sentence),
    get warnings() {
      const out = [...noted];
      if (config.production && !config.siteUrl) {
        out.push("SITE_URL is not set, so links in feeds, emails and the sitemap come from the Site URL setting, which can be edited in Settings. Set SITE_URL (for example https://example.com) in the server's settings to lock it.");
      }
      if (config.production) {
        try {
          const s = ctx.site();
          if (!s.hasPublicUrl) out.push(`The Site URL (${s.origin}) is not a public address, so links in emails and feeds would not work for readers. Set it to your public https address.`);
          else if (!s.https) out.push(`The Site URL (${s.origin}) is not https, so browsers get no HSTS and links in emails are not secure. Set it to your public https address.`);
        } catch {
          // site settings unreadable: nothing to add
        }
      }
      return out;
    },
    mediaDir: path.join(config.dataDir, "media"),
    views: createViews(config),
    assets: createAssets(config),
    site: () => (site ??= buildSite(store, config)),
    // Call after anything that changes what the public sees outside the store (e.g. a scheduled post going live).
    invalidate: () => {
      cache.clear();
      site = null;
    },
  };
  ctx.indexNow = createIndexNow(ctx);
  ctx.mailer = createMailer(ctx);
  ctx.newsletter = createNewsletterSender(ctx, { delayMs: config.mailDelayMs });

  const app = new Hono();
  const A = `${config.basePath}/admin`;

  // With ADMIN_HOST set the admin answers only on that host, and public pages asked for on it go to the Site URL
  // (the shared files the admin pages themselves use stay available). Cookies are never given a Domain, so they stay host-only.
  if (config.adminHost) {
    const shared = [`${config.basePath}/assets/`, `${config.basePath}/media/`];
    app.use("*", (c, next) => {
      const onAdminHost = requestHost(c, ctx) === config.adminHost;
      if (isAdminPath(c.req.path, config.basePath)) return onAdminHost ? next() : ctx.notFound?.(c) || c.text("Page not found", 404);
      if (!onAdminHost || shared.some((p) => c.req.path.startsWith(p))) return next();
      if (!["GET", "HEAD"].includes(c.req.method)) return c.text("Page not found", 404);
      return c.redirect(`${ctx.site().origin}${c.req.path}${new URL(c.req.url).search}`, 302);
    });
  }

  app.use("*", async (c, next) => {
    await next();
    const admin = isAdminPath(c.req.path, config.basePath);
    const { scriptHashes, adminScriptHashes, styleHashes } = ctx.assets.get();
    const site = ctx.site();
    // Pages that must never carry the analytics tag (sign-in, account, unsubscribe...) set "noAnalytics".
    const analytics = admin || c.get("noAnalytics") ? null : site.analytics;
    for (const [k, v] of Object.entries(securityHeaders({ scriptHashes, adminScriptHashes, styleHashes, admin, https: config.production && isHttps(c, ctx), hstsSubdomains: config.hstsSubdomains, analytics }))) {
      if (!c.res.headers.has(k)) c.res.headers.set(k, v);
    }
    // Pages and downloads are not for other sites to embed (images and fonts stay embeddable: email and feed readers load them).
    if (!admin && !c.res.headers.has("Cross-Origin-Resource-Policy")) {
      if (/^text\/html/.test(c.res.headers.get("content-type") || "") || /attachment/i.test(c.res.headers.get("content-disposition") || "")) {
        c.res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
      }
    }
    // Admin pages are never cached; the hashed static files (CSS, JS) keep their long cache header.
    if (admin) {
      if (!c.req.path.startsWith(`${A}/static/`)) c.res.headers.set("Cache-Control", "no-store");
    } else if (!c.res.headers.has("Cache-Control")) {
      const type = c.res.headers.get("content-type") || "";
      if (type.startsWith("text/html")) c.res.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
      else if (/xml/.test(type)) c.res.headers.set("Cache-Control", "public, max-age=300"); // feeds and sitemaps: short, so removed posts don't linger
    }
  });

  // Request body limits, before any route reads a body. The size depends on who is asking: 64 KB for the public site and for the
  // admin pages you reach before signing in (setup, sign-in, second step, sign-out) and for any admin request without a live
  // staff session; 8 MB for the rest of the admin with a live session, and the upload limit on the two upload routes.
  const tooLarge = (c) => c.text("That request is too large.", 413);
  const limitFor = (maxSize) => bodyLimit({ maxSize, onError: tooLarge });
  const publicLimit = limitFor(64 * 1024);
  const adminLimit = limitFor(8 * 1024 * 1024);
  const uploadLimit = limitFor(Math.max(config.maxUploadBytes, 50 * 1024 * 1024) + 1024 * 1024);
  const smallAdmin = new Set(["setup", "login", "login/verify", "logout"].map((p) => `${A}/${p}`));
  app.use("*", (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    const p = c.req.path.replace(/\/+$/, "");
    if (!isAdminPath(c.req.path, config.basePath) || smallAdmin.has(p)) return publicLimit(c, next);
    // The staff session is looked up once per request; the admin gate reuses it.
    let session = c.get("sessionLookup");
    if (session === undefined) {
      try {
        session = store.users.getSession(readCookie(c, ctx, "sid")) || null;
      } catch {
        session = null;
      }
      c.set("sessionLookup", session);
    }
    if (!session) return publicLimit(c, next);
    return c.req.method === "POST" && (p === `${A}/media` || p === `${A}/api/media`) ? uploadLimit(c, next) : adminLimit(c, next);
  });

  adminRoutes(app, ctx);
  publicRoutes(app, ctx);
  app.notFound((c) => ctx.notFound(c));

  // Last word on errors: honour HTTP errors thrown on purpose, treat bad URL encoding as 404, and show a stack trace only in development.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof URIError) {
      try {
        return ctx.notFound(c);
      } catch {
        return c.text("Page not found", 404);
      }
    }
    // The route pattern, not the real path (which carries tokens and, once decoded, can hold new lines or escape codes).
    console.error(`[error] ${c.req.method} ${logPath(c)}: ${logSafe(String(err?.message || err).split("\n")[0])}`);
    return c.text(config.dev ? String(err?.stack || err) : "Something went wrong. Please try again in a moment.", 500);
  });

  return { app, ctx };
}
