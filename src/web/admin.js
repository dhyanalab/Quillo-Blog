// Admin: setup, login, dashboard, the post/page editor, media, taxonomy, comments, members, staff, redirects,
// newsletter, analytics and search engines, and settings.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { publishChecks } from "../render/checks.js";
import { LANGUAGES, isSourceName, langFor } from "../render/code.js";
import { deleteMediaFiles, inputKey, isFileUpload, processFile, processUpload, UploadError } from "../render/media.js";
import { AD_PLACES, adStatus } from "../store/ads.js";
import { explainMailError, SMTP_PRESETS } from "../services/mailer.js";
import { ANALYTICS, originOf, parseSnippet } from "./analytics.js";
import { renderSVG } from "uqr";
import { looksLikeRecoveryCode, matchCode, newSecret, otpauthUrl } from "./totp.js";
import { ROLE_LABELS, ROLES } from "../store/users.js";
import { RANK, mayGrant, mayManage as outranksTarget } from "../store/roles.js";
import { renderSimpleEmail } from "../render/email.js";
import { nameKey } from "./members.js";
import { SETTING_DEFAULTS, SOCIAL_KEYS } from "../store/settings.js";
import { MIN_PASSWORD } from "./password.js";
import { THEME_SCRIPT } from "./assets.js";
import { HTTPException } from "hono/http-exception";
import { clearAppCookie, clientIp, isAdminPath, readCookie, safeEq, sameOrigin, setAppCookie, takeClient } from "./security.js";
import { cleanText, csvCell, hasControlChars, isEmail, isSafeLocalPath, passwordProblem } from "./validate.js";
import { createRateLimiter } from "./security.js";
import { isPrivateHost } from "../services/hosts.js";
import { linkFrom, linkRows } from "./networks.js";
import { LEVELS, markdown } from "./present.js";
import {
  clampInt, countWords, isHttpUrl, isoDurationToSeconds, isoToLocalInput, isoWithOffset, isSlug, localInputToIso, readingMinutes, secondsToClock, slugify, timestampToSeconds,
} from "../render/util.js";

export const can = {
  // Owner-only settings and actions test this, so the rule lives in one place (see OWNER_ONLY_SETTINGS in the tests).
  owner: (u) => u.role === "owner",
  settings: (u) => RANK[u.role] >= RANK.admin,
  users: (u) => RANK[u.role] >= RANK.admin,
  taxonomy: (u) => RANK[u.role] >= RANK.editor,
  pages: (u) => RANK[u.role] >= RANK.editor,
  allPosts: (u) => RANK[u.role] >= RANK.editor,
  editPost: (u, p) => (p.type === "page" ? RANK[u.role] >= RANK.editor : RANK[u.role] >= RANK.editor || p.author_id === u.id),
  publish: (u, p) => RANK[u.role] >= RANK.author && can.editPost(u, p),
  // Pages follow editPost (editor and up). A contributor can delete only their own drafts that were never published.
  deletePost: (u, p) => RANK[u.role] >= RANK.editor || (p.type !== "page" && p.author_id === u.id && (u.role === "author" || (p.status === "draft" && !(p.everPublished ?? p.published_at)))),
  deleteMedia: (u, m) => RANK[u.role] >= RANK.editor || m.uploaded_by === u.id,
};

const MAX_PASSWORD = 256;
// The role table and the manage and grant rules live in one place (src/store/roles.js), shared with the store.
const assignableRoles = (actor) => ROLES.filter((r) => mayGrant(actor, r));
// Temporary passwords (set by someone else) work for 7 days.
const TEMP_PASSWORD_MS = 7 * 86_400_000;
// A setup token supplied through the environment must be at least this long (the generated one is 32 characters).
const MIN_SETUP_TOKEN = 10;

// Messages that come back in the address (?ok=code). Plain object: always look up with Object.hasOwn.
const FLASH = {
  mustchange: "Choose your own password to continue.", othersout: "Signed out everywhere else.", resetsent: "Reset link emailed to the reader.",
  saved: "Saved.", created: "Created.", deleted: "Deleted.", uploaded: "Uploaded.", password: "Password changed.",
  loggedout: "You are signed out.", pinged: "Sent every public URL to IndexNow.", restored: "Revision restored.",
  paused: "Banner switched off.", resumed: "Banner switched on.", menus: "Menus saved.",
  adson: "Ads are on.", adsoff: "Ads are off. No banners or empty boxes show anywhere on the blog.",
  placeon: "Place switched on.", placeoff: "Place switched off. Nothing shows there now.",
  analytics: "Saved. Changes show on the blog straight away.",
  nlsaved: "Draft saved.", testsent: "Test email sent. Check your inbox (and the spam folder).", sending: "Sending has started. You can leave this page; it carries on in the background.",
  retrying: "Trying the failed emails again.", unsubscribed: "Unsubscribed.", resubscribed: "Subscribed again.", mailsaved: "Email settings saved.",
  mailtest: "It works. A test email is on its way to you.",
  twostepoff: "Two-step sign-in is off.", twostepneeded: "Your site requires two-step sign-in. Turn it on here to carry on.", twosteppolicy: "Two-step rule saved.", sessionended: "That device was signed out.", twostepreset: "Two-step sign-in was turned off for this person, and they were signed out everywhere.",
  recovery: "You signed in with a recovery code. Each code works once; get new ones below if you’re running low.",
  approved: "Comment approved.", hidden: "Comment hidden.", replied: "Reply posted.", banned: "Member blocked.", unbanned: "Member unblocked.",
  mailpasscleared: "Email settings saved. You changed the server or the user name, so the saved password was removed. Enter it again to send email.",
  nlreview: "Draft saved. Read it over, then press Send to send it to your subscribers.", tombstone: "Cleared. That web address can be used again.",
};

export function adminRoutes(app, ctx) {
  const { store, config, views, assets } = ctx;
  const A = `${config.basePath}/admin`;
  const { limiters } = ctx;
  const OPEN = new Set([`${A}/login`, `${A}/login/verify`, `${A}/setup`, `${A}/static/admin.css`, `${A}/static/admin.js`, `${A}/static/editor.js`]);

  // Cookies (sid, lcsrf, kd, l2fa) go through the shared helpers: over https they get a __Host- name (which a sibling
  // sub-domain can't set or overwrite), HttpOnly, SameSite=Lax and Secure. Over plain http they keep the plain name.
  const setCookie = (c, name, value, maxAge) => setAppCookie(c, ctx, name, value, { path: A, sameSite: "Lax", ...(maxAge ? { maxAge } : {}) });
  const getCookie = (c, name) => readCookie(c, ctx, name);
  const clearCookie = (c, name) => clearAppCookie(c, ctx, name, A);

  // A persistent trail of what staff do to accounts: the console line, and a line in <data folder>/audit.log.
  const auditFile = path.join(config.dataDir, "audit.log");
  function audit(message, extra = {}) {
    console.log(`[audit] ${message}`);
    try {
      fs.appendFile(auditFile, `${JSON.stringify({ at: new Date().toISOString(), message, ...extra })}\n`, () => {});
    } catch {
      // the console line above is still there
    }
  }
  // A short plain email to a staff member about a change to their own account. Never throws, never blocks the answer.
  function notifyStaff(person, heading, body) {
    if (!person?.email || !ctx.mailer?.ready?.()) return;
    (async () => {
      const conn = ctx.mailer.open();
      try {
        const mail = renderSimpleEmail({ site: ctx.site(), heading, body });
        await conn.send({ to: { address: person.email, name: person.name || "" }, subject: mail.subject, html: mail.html, text: mail.text });
      } finally {
        conn.close();
      }
    })().catch((err) => console.warn(`[mail] account notice not sent: ${explainMailError(err).slice(0, 200)}`));
  }
  const BUSY = "The site is busy right now. Please try again in a minute.";
  const isBusy = (err) => err?.code === "BUSY";

  // The CSRF token in pages and forms is derived from the session's secret, a server secret and the day, so it
  // is not the stored value and stops working after 1 to 2 days. The previous day's token is accepted too,
  // so a page left open overnight still saves.
  const DAY = 86_400_000;
  const csrfFor = (session, day) => ctx.secrets.hmac(`csrf:${session.csrf}:${day}`);
  const csrfToken = (session) => csrfFor(session, Math.floor(Date.now() / DAY));
  const csrfOk = (session, given) => {
    if (!session || typeof given !== "string" || !given) return false;
    const day = Math.floor(Date.now() / DAY);
    // Both are compared every time, so timing doesn't tell which day matched.
    const a = safeEq(given, csrfFor(session, day));
    const b = safeEq(given, csrfFor(session, day - 1));
    return a || b;
  };

  // Where a signed-in person goes when they must choose a new password first.
  const mustChangeUrl = (user) => `${A}/users/${user.id}?ok=mustchange`;

  // An admin address is never loaded as a picture, script, font or the like (an <img> aimed at one would make a
  // signed-in staff member's browser send the request with their cookie).
  const NOT_A_PAGE = new Set(["image", "audio", "video", "track", "font", "script", "style", "object", "embed", "manifest"]);

  // Two-step sign-in can be required for owners and administrators, or for everyone (set on the Staff page).
  const twoStepRule = () => {
    const v = store.settings.all().require_two_step;
    return v === "admins" || v === "staff" ? v : "off";
  };
  const mustUseTwoStep = (u) => {
    const rule = twoStepRule();
    return !u.twoStep && (rule === "staff" || (rule === "admins" && RANK[u.role] >= RANK.admin));
  };

  // Session, login gate and CSRF for every admin request.
  app.use(`${A}/*`, async (c, next) => {
    const p = c.req.path.replace(/\/$/, "") || A;
    if (NOT_A_PAGE.has(String(c.req.header("sec-fetch-dest") || "").toLowerCase()) && !p.startsWith(`${A}/static/`)) return c.text("Not allowed here.", 403);
    // The body-limit step may have looked the session up already; reuse it so it is read once per request.
    let s = c.get("sessionLookup");
    if (s === undefined) {
      s = store.users.getSession(getCookie(c, "sid"));
      c.set("sessionLookup", s);
    }
    c.set("user", s?.user || null);
    c.set("session", s?.session || null);
    if (c.req.method === "POST" && !sameOrigin(c, ctx)) return c.text("Cross-site request blocked.", 403);
    if (OPEN.has(p)) return next();
    if (!store.users.hasOwner()) return c.redirect(`${A}/setup`);
    if (!s) {
      if (p.startsWith(`${A}/api/`)) return c.json({ error: "Your session expired. Sign in again in another tab, then retry." }, 401);
      return c.redirect(`${A}/login?next=${encodeURIComponent(c.req.path)}`);
    }
    if (c.req.method === "POST" && p.startsWith(`${A}/api/`) && !csrfOk(s.session, c.req.header("x-csrf-token"))) return c.json({ error: "Security token mismatch. Reload the page." }, 403);
    // A new account must choose its own password before anything else: only the profile page,
    // the password form and sign-out stay open.
    if (s.user.mustChange) {
      const own = `${A}/users/${s.user.id}`;
      const open = (c.req.method === "GET" && (p === own || p === `${A}/profile`)) || (c.req.method === "POST" && (p === `${own}/password` || p === `${A}/logout`));
      if (!open) {
        if (p.startsWith(`${A}/api/`)) return c.json({ error: "Choose a new password first (open Your profile)." }, 403);
        return c.redirect(mustChangeUrl(s.user));
      }
    } else if (mustUseTwoStep(s.user)) {
      // The site requires two-step sign-in and this person hasn't turned it on: only the way to do that stays open.
      const own = `${A}/users/${s.user.id}`;
      const two = `${A}/account/two-step`;
      const get = c.req.method === "GET";
      const open = p.startsWith(`${A}/static/`) || (get && (p === two || p === `${A}/profile` || p === own)) || (!get && (p === `${two}/start` || p === `${two}/enable` || p === own || p === `${own}/password` || p === `${A}/logout`));
      if (!open) {
        if (p.startsWith(`${A}/api/`)) return c.json({ error: "Your site requires two-step sign-in. Turn it on under Your profile first." }, 403);
        return c.redirect(`${two}?ok=twostepneeded`);
      }
    }
    return next();
  });
  app.get(A, (c) => c.redirect(`${A}/`, 301));

  // Reads a form and checks its CSRF token. A bad token is a 403 shown as an admin page.
  async function form(c) {
    const body = await c.req.parseBody({ all: true });
    const session = c.get("session");
    if (!csrfOk(session, body._csrf)) {
      const message = "Security token mismatch. Go back, reload and try again.";
      throw new HTTPException(403, { message, res: page(c, "error.njk", { title: "Request blocked", message }, 403) });
    }
    return body;
  }

  function page(c, template, data = {}, status = 200) {
    const a = assets.get();
    const user = c.get("user");
    const html = views.render(`admin/${template}`, {
      A,
      site: ctx.site(),
      user,
      can: user ? Object.fromEntries(Object.entries(can).map(([k, fn]) => [k, (x) => fn(user, x)])) : {},
      csrf: c.get("session") ? csrfToken(c.get("session")) : "",
      flash: flashFor(c.req.query("ok")),
      files: a.files,
      themeScript: THEME_SCRIPT,
      roleLabels: ROLE_LABELS,
      sideCounts: user && can.taxonomy(user) ? { pendingComments: store.comments.counts().pending || 0 } : {},
      ...data,
    });
    return c.html(html, status);
  }
  const deny = (c) => page(c, "error.njk", { title: "Not allowed", message: "Your role can’t do that. Ask an administrator." }, 403);
  const missing = (c) => page(c, "error.njk", { title: "Not found", message: "That item doesn’t exist any more." }, 404);

  // Only known message codes show: a plain-object lookup would also answer "constructor" or "__proto__".
  function flashFor(code) {
    return typeof code === "string" && Object.hasOwn(FLASH, code) ? FLASH[code] : "";
  }

  // Static admin files (CSS/JS), cache-busted by hash.
  app.get(`${A}/static/:file`, (c) => {
    const name = c.req.param("file");
    const files = assets.get().files;
    const f = Object.hasOwn(files, name) ? files[name] : null;
    if (!f) return c.notFound();
    // The sign-in page's own files may be cached by anyone; the editor files are for signed-in staff only.
    const scope = OPEN.has(`${A}/static/${name}`) ? "public" : "private";
    return c.body(f.body, 200, { "Content-Type": f.type, "Cache-Control": config.production ? `${scope}, max-age=31536000, immutable` : "no-cache" });
  });

  // ---------- Setup and sign-in ----------

  // The sign-in and setup forms carry a token "<seconds>.<random>.<hmac>" that is also kept in a cookie (lcsrf).
  // The two must match and the HMAC must verify; a token works for 2 hours. A page opened again reuses the cookie
  // while it has more than an hour left, so a second tab doesn't break the first tab's form.
  const LOGIN_TOKEN_SECONDS = 2 * 3600;
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const makeLoginToken = () => {
    const ts = nowSeconds();
    const rand = crypto.randomBytes(12).toString("base64url");
    return `${ts}.${rand}.${ctx.secrets.hmac(`lcsrf:${ts}.${rand}`)}`;
  };
  // The seconds a token has left, or 0 when it is forged, damaged or out of date.
  const loginTokenLeft = (token) => {
    const [ts, rand, mac, extra] = String(token ?? "").split(".");
    if (extra !== undefined || !/^\d{1,12}$/.test(ts || "") || !rand || !mac) return 0;
    const left = Number(ts) + LOGIN_TOKEN_SECONDS - nowSeconds();
    if (left <= 0 || Number(ts) > nowSeconds() + 60) return 0;
    return safeEq(mac, ctx.secrets.hmac(`lcsrf:${ts}.${rand}`)) ? left : 0;
  };
  const loginToken = (c) => {
    const have = getCookie(c, "lcsrf");
    if (have && loginTokenLeft(have) > 3600) return have;
    const t = makeLoginToken();
    setCookie(c, "lcsrf", t, LOGIN_TOKEN_SECONDS);
    return t;
  };
  const checkLoginToken = (c, body) => {
    const t = getCookie(c, "lcsrf");
    return Boolean(t) && typeof body._csrf === "string" && safeEq(body._csrf, t) && loginTokenLeft(t) > 0;
  };

  // Known browsers. After a full sign-in the browser gets a "kd" cookie: <user id>.<random>.<hmac of both and the
  // account's auth version>. A password change raises the version, which voids every such cookie. Wrong passwords
  // from a known browser are counted under that browser's own key, so a stranger's guesses at an account never
  // lock the person out of their own browser.
  const KNOWN_SECONDS = 180 * 86400;
  const kdMac = (userId, version, nonce) => ctx.secrets.hmac(`kd:${userId}.${version}.${nonce}`);
  function issueKnownDevice(c, userId) {
    const version = store.users.getAuthVersion(userId);
    if (version == null) return;
    const nonce = crypto.randomBytes(16).toString("hex");
    setCookie(c, "kd", `${userId}.${nonce}.${kdMac(userId, version, nonce)}`, KNOWN_SECONDS);
  }
  // This browser's kd nonce when the cookie is valid for the account, else "".
  function knownDevice(c, userId) {
    const [id, nonce, mac, extra] = String(getCookie(c, "kd") || "").split(".");
    if (extra !== undefined || !userId || Number(id) !== Number(userId) || !/^[0-9a-f]{32}$/.test(nonce || "") || !mac) return "";
    const version = store.users.getAuthVersion(userId);
    return version != null && safeEq(mac, kdMac(userId, version, nonce)) ? nonce : "";
  }
  // Second-step guesses from a known browser (5 per 15 minutes each), and recovery codes tried per person (5 per hour).
  const deviceCodeLimiter = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 });
  const recoveryLimiter = createRateLimiter({ limit: 5, windowMs: 3_600_000 });

  // A sign-in takes over from whatever session the browser already held, so an old cookie can't outlive it.
  async function startSession(c, user) {
    const old = getCookie(c, "sid");
    if (old) store.users.endSession(old);
    const { token } = store.users.createSession(user.id, { ip: clientIp(c, ctx), userAgent: (c.req.header("user-agent") || "").slice(0, 255) });
    setCookie(c, "sid", token, 14 * 86400);
    clearCookie(c, "lcsrf");
    issueKnownDevice(c, user.id);
  }
  // After a step-up (turning two-step on or off, new recovery codes) the session gets a new cookie token and form token
  // (same person, same end date), so a copied cookie stops working. The request's own session is updated so the page
  // being answered carries the new form token. (A sign-in's second step already ends with a brand-new session: startSession.)
  function rotateSession(c) {
    const next = store.users.rotateSession(getCookie(c, "sid"));
    if (!next) return;
    setCookie(c, "sid", next.token, 14 * 86400);
    c.set("session", { ...c.get("session"), id: crypto.createHash("sha256").update(next.token).digest("hex"), csrf: next.csrf });
  }
  // Where to go after signing in: a path inside the admin area, nothing else. The address is resolved the way a
  // browser would (dot segments and encoded dots included) and checked again, so "/admin/../x" can't get through.
  function safeNext(value) {
    const v = String(value ?? "");
    if (!isSafeLocalPath(v) || hasControlChars(v)) return `${A}/`;
    let url;
    try {
      url = new URL(v, "http://admin.invalid");
    } catch {
      return `${A}/`;
    }
    if (url.origin !== "http://admin.invalid" || !isAdminPath(url.pathname, config.basePath)) return `${A}/`;
    return `${url.pathname}${url.search}`;
  }
  const clip = (v, max) => String(v ?? "").slice(0, max);
  // A temporary password (one set by someone else) works for 7 days.
  const tempPasswordExpired = (user) => {
    const at = Date.parse(user.password_set_at ?? user.passwordSetAt ?? "");
    return Boolean(user.mustChange) && Number.isFinite(at) && Date.now() - at > TEMP_PASSWORD_MS;
  };
  const TEMP_EXPIRED = "This temporary password has expired. Ask an administrator for a new one.";
  const SLOW_DOWN = "Too many attempts. Wait 15 minutes and try again.";

  app.get(`${A}/setup`, (c) => {
    if (store.users.hasOwner()) return c.redirect(`${A}/login`);
    return page(c, "setup.njk", { token: loginToken(c), values: { site_url: new URL(c.req.url).origin, site_title: SETTING_DEFAULTS.site_title } });
  });
  // Every setup try also counts against the whole site (40 an hour), so a short token can't be ground down from many addresses.
  const setupAll = createRateLimiter({ limit: 40, windowMs: 3_600_000 });
  app.post(`${A}/setup`, async (c) => {
    if (store.users.hasOwner()) return c.redirect(`${A}/login`);
    const body = await c.req.parseBody();
    const values = { name: clip(body.name, 100).trim(), email: clip(body.email, 200).trim(), site_title: clip(body.site_title, 100).trim(), site_url: clip(body.site_url, 300).trim() };
    const fail = (error, status = 400) => page(c, "setup.njk", { token: loginToken(c), error, values }, status);
    // Setup always needs the token (SETUP_TOKEN, or the one printed when the server started), and tries are limited.
    if (!takeClient(limiters.setup, c, ctx) || !setupAll.take("all")) return fail("Too many attempts. Wait a while and try again.", 429);
    if (!checkLoginToken(c, body)) return fail("Security token expired. Try again.");
    if (config.setupToken && config.setupToken.length < MIN_SETUP_TOKEN) return fail(`The setup token on this server is too short. Use at least ${MIN_SETUP_TOKEN} characters in SETUP_TOKEN and restart the server.`);
    if (!config.setupToken || !safeEq(clip(body.setup_token, 200).trim(), config.setupToken)) return fail("Setup token is wrong.");
    if (!values.name || !isEmail(values.email)) return fail("Enter your name and a valid email.");
    const password = typeof body.password === "string" ? body.password : "";
    const problem = passwordProblem(password, { email: values.email, name: values.name }, "password");
    if (problem) return fail(problem);
    if (!isHttpUrl(values.site_url)) return fail("Site URL must start with http:// or https://");
    // Atomic: only one request can create the owner, however many arrive together.
    let user;
    try {
      user = await store.users.createOwnerIfNone({ email: values.email, password, name: values.name });
    } catch (err) {
      if (isBusy(err)) return fail(BUSY, 503);
      throw err;
    }
    if (!user) return c.redirect(`${A}/login`);
    store.settings.set({ site_title: values.site_title || SETTING_DEFAULTS.site_title, site_url: new URL(values.site_url).origin });
    await startSession(c, user);
    return c.redirect(`${A}/?ok=created`);
  });

  app.get(`${A}/login`, (c) => {
    if (!store.users.hasOwner()) return c.redirect(`${A}/setup`);
    if (c.get("user")) return c.redirect(`${A}/`);
    return page(c, "login.njk", { token: loginToken(c), next: safeNext(c.req.query("next")) });
  });
  // Throttling: every attempt counts against the client's address (never cleared by a success). Attempts at an
  // account count under the account's name, or, from a browser this person has signed in on before, under that
  // browser's own key (a success clears only that key).
  const accountKey = (email) => clip(email, 200).trim().toLowerCase();
  app.post(`${A}/login`, async (c) => {
    const body = await c.req.parseBody();
    const next = safeNext(body.next);
    const email = clip(body.email, 200);
    const fail = (error, status = 400) => page(c, "login.njk", { token: loginToken(c), error, email, next }, status);
    if (!checkLoginToken(c, body)) return fail("Your sign-in form expired. Try again.");
    if (!takeClient(limiters.login, c, ctx)) return fail(SLOW_DOWN, 429);
    const known = store.users.getByEmail(email.trim());
    const device = known ? knownDevice(c, known.id) : "";
    const key = device ? `kd:${known.id}:${device}` : accountKey(email);
    if (!limiters.loginAccount.take(key)) return fail(SLOW_DOWN, 429);
    const password = typeof body.password === "string" && body.password.length <= MAX_PASSWORD ? body.password : "";
    // The password check is slow. The account's version is noted first and compared after, so a sign-in that
    // began before a password change or reset can't finish with the old password.
    const version = known ? store.users.getAuthVersion(known.id) : null;
    let user = null;
    try {
      user = password ? await store.users.authenticate(email, password) : null;
    } catch (err) {
      if (isBusy(err)) return fail(BUSY, 503);
      if (err?.code === "PASSWORD_EXPIRED") return fail(TEMP_EXPIRED, 403);
      throw err;
    }
    if (!user) return fail("Email or password is wrong.", 401);
    if (!known || user.id !== known.id || store.users.getAuthVersion(user.id) !== version) return fail("Your account changed while you were signing in. Try again.");
    limiters.loginAccount.reset(key);
    if (tempPasswordExpired(user)) return fail(TEMP_EXPIRED, 403);
    if (user.twoStep) {
      // A locked second step still leads to the code page: a recovery code works there, an authenticator code doesn't.
      startChallenge(c, user, next, version);
      return c.redirect(`${A}/login/verify`);
    }
    await startSession(c, user);
    return c.redirect(user.mustChange ? mustChangeUrl(user) : next);
  });

  // ---------- Two-step sign-in: the second step of logging in ----------

  // After a correct password, a 5-minute challenge (kept in memory, tied to this browser by a cookie)
  // waits for the authenticator or recovery code. Wrong codes are counted per person in the database
  // (5 in a row lock the authenticator codes for 15 minutes; a recovery code still works, 5 tries an hour),
  // so new challenges don't give new guesses. A browser this person has signed in on before isn't held up by
  // that lock; it has its own limit instead. The challenge remembers the account's auth_version: a password
  // change or two-step reset voids it. A person has at most 3 open challenges, and a success closes the rest.
  const challenges = new Map();
  const CHALLENGE_MS = 5 * 60_000;
  const MAX_CHALLENGES = 10_000;
  const MAX_CHALLENGES_PER_USER = 3;
  const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
  const sweepChallenges = () => {
    const t = Date.now();
    for (const [k, v] of challenges) if (v.expires < t) challenges.delete(k);
  };
  setInterval(sweepChallenges, 60_000).unref();
  const endChallengesOf = (userId) => {
    for (const [k, v] of challenges) if (v.userId === userId) challenges.delete(k);
  };
  function startChallenge(c, user, next, authVersion) {
    const t = Date.now();
    // Maps keep insertion order, so the first key is the oldest challenge.
    while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
    const mine = [...challenges].filter(([, v]) => v.userId === user.id).map(([k]) => k);
    for (const k of mine.slice(0, Math.max(0, mine.length - (MAX_CHALLENGES_PER_USER - 1)))) challenges.delete(k);
    const token = crypto.randomBytes(24).toString("base64url");
    challenges.set(hashToken(token), { userId: user.id, next, expires: t + CHALLENGE_MS, authVersion: authVersion ?? store.users.getAuthVersion(user.id) });
    setCookie(c, "l2fa", token, CHALLENGE_MS / 1000);
  }
  function readChallenge(c) {
    const token = getCookie(c, "l2fa");
    if (!token) return null;
    const key = hashToken(token);
    const ch = challenges.get(key);
    if (!ch || ch.expires < Date.now()) {
      challenges.delete(key);
      return null;
    }
    return { key, ...ch };
  }
  const endChallenge = (c, ch) => {
    if (ch) challenges.delete(ch.key);
    clearCookie(c, "l2fa");
  };
  // A recovery code has 10 letters and digits (K7Q2M-XW4TP); an authenticator code is 6 digits. Told apart by length.
  const isRecoveryCode = (code) => looksLikeRecoveryCode(code);

  app.get(`${A}/login/verify`, (c) => {
    if (!readChallenge(c)) return c.redirect(`${A}/login`);
    return page(c, "login-verify.njk", { token: loginToken(c) });
  });
  app.post(`${A}/login/verify`, async (c) => {
    const body = await c.req.parseBody();
    const ch = readChallenge(c);
    if (!ch) return page(c, "login.njk", { token: loginToken(c), error: "That sign-in took too long. Enter your email and password again.", next: "" }, 400);
    const fail = (error, status = 400) => page(c, "login-verify.njk", { token: loginToken(c), error }, status);
    if (!checkLoginToken(c, body)) return fail("Your sign-in form expired. Try again.");
    // Every code attempt counts against the client's address too, and a success never clears it.
    if (!takeClient(limiters.login, c, ctx)) return fail(SLOW_DOWN, 429);
    const user = store.users.get(ch.userId);
    if (!user || user.status !== "active" || !user.twoStep) {
      endChallenge(c, ch);
      return page(c, "login.njk", { token: loginToken(c), error: "This account can’t sign in right now.", next: "" }, 403);
    }
    if (store.users.getAuthVersion(user.id) !== ch.authVersion) {
      endChallenge(c, ch);
      return page(c, "login.njk", { token: loginToken(c), error: "Your account changed. Enter your email and password again.", next: "" }, 400);
    }
    const device = knownDevice(c, user.id);
    const code = clip(body.code, 32).trim();
    const viaRecovery = isRecoveryCode(code);
    if (viaRecovery) {
      // Recovery codes work even while authenticator codes are locked, under their own limit.
      if (!recoveryLimiter.take(`rc:${user.id}`)) return fail("Too many recovery codes tried. Try again in an hour.", 429);
      if (!store.users.useRecoveryCode(user.id, code)) return fail("That recovery code isn’t right, or it was already used.", 401);
      recoveryLimiter.reset(`rc:${user.id}`);
    } else {
      if (device) {
        if (!deviceCodeLimiter.take(`${user.id}:${device}`)) return fail("Too many wrong codes from this browser. Try again in 15 minutes.", 429);
      } else if (store.users.totpLocked(user.id)) {
        return fail("Too many wrong codes. Try again in 15 minutes, or use a recovery code.", 429);
      }
      if (!store.users.verifyTotp(user.id, code, { ignoreLock: Boolean(device) })) {
        if (!device && store.users.recordTotpFailure(user.id).locked) {
          console.warn(`[security] second step locked for 15 minutes after wrong codes: user ${user.id}`);
          return fail("Too many wrong codes. Try again in 15 minutes, or use a recovery code.", 429);
        }
        return fail("That code isn’t right. Use the code your app shows for this site now; it changes every 30 seconds.", 401);
      }
      deviceCodeLimiter.reset(`${user.id}:${device}`);
    }
    store.users.clearTotpFailures(user.id);
    // Every other sign-in waiting for a code for this person is closed too.
    endChallengesOf(user.id);
    endChallenge(c, ch);
    await startSession(c, user);
    if (viaRecovery) {
      audit(`signed in with a recovery code: user ${user.id}`);
      notifyStaff(user, "A recovery code was used to sign in", [`A recovery code was just used to sign in to your account at ${ctx.site().title}. Each code works once.`, "If that was you, there is nothing to do. If it wasn’t, sign in, change your password and get new recovery codes."]);
    }
    if (user.mustChange) return c.redirect(mustChangeUrl(user));
    return c.redirect(viaRecovery ? `${A}/account/two-step?ok=recovery` : ch.next);
  });
  app.post(`${A}/logout`, async (c) => {
    await form(c);
    const sid = getCookie(c, "sid");
    if (sid) store.users.endSession(sid);
    endChallenge(c, readChallenge(c));
    clearCookie(c, "sid");
    return c.redirect(`${A}/login?ok=loggedout`);
  });

  // ---------- Dashboard ----------

  app.get(`${A}/`, (c) => {
    const user = c.get("user");
    const site = ctx.site();
    const mine = can.allPosts(user) ? 0 : user.id;
    const drafts = store.posts.listAdmin({ state: "draft", authorId: mine, limit: 6 }).rows;
    const scheduled = store.posts.listAdmin({ state: "scheduled", authorId: mine, limit: 6 }).rows;
    const popular = store.posts.listPublic({ order: "popular", limit: 6 });
    const health = [];
    if (/localhost|127\.0\.0\.1/.test(site.host)) health.push({ level: "warn", text: "Site URL is still localhost. Set the real domain in Settings so canonical URLs, the sitemap and social cards point to it." });
    if (!site.logo) health.push({ level: "info", text: "No logo yet. Add one in Settings, under Brand; it appears in the header, social images and Organization markup." });
    if (!site.categories.length) health.push({ level: "info", text: "No categories yet. Categories build the main menu and the home page sections." });
    if (!site.social.length) health.push({ level: "info", text: "No social profiles. Add YouTube and Instagram in Settings so search engines can link the brand." });
    if (!site.s.google_verification) health.push({ level: "info", text: "Google Search Console isn’t connected yet. Open Analytics & SEO and follow the steps." });
    if (!user.twoStep) health.push({ level: "warn", text: "Your account doesn’t use two-step sign-in yet. Turn it on under Your profile, so a stolen password alone can’t get into the admin." });
    if (!ctx.mailer.ready()) health.push({ level: "warn", text: "The site’s email isn’t set up, so new reader sign-ups are paused and newsletter emails can’t be sent. Open Newsletter > Email settings to connect your email service." });
    // Staff without two-step sign-in, for the owner to follow up.
    const noTwoStep = user.role === "owner" ? store.users.list().filter((u) => u.status === "active" && !u.twoStep && u.id !== user.id).map((u) => ({ id: u.id, name: u.name, role: u.role })) : [];
    // Numbers for areas a role can't open are not computed for it: post counts are the person's own below editor,
    // reader and subscriber totals are for roles with Settings access, comment counts for moderators.
    const own = (state) => store.posts.listAdmin({ type: "post", state, authorId: user.id, limit: 1 }).total;
    const counts = can.allPosts(user) ? store.posts.counts("post") : { draft: own("draft"), published: own("published"), scheduled: own("scheduled"), total: own("") };
    const owner = can.owner(user);
    return page(c, "dashboard.njk", {
      nav: "dashboard",
      counts,
      pageCount: can.pages(user) ? store.posts.counts("page").total : 0,
      subscribers: can.settings(user) ? store.subscribers.count() : 0,
      pendingSubscribers: can.settings(user) ? store.subscribers.pendingCount() : 0,
      members: can.settings(user) ? store.members.count() : 0,
      comments: can.taxonomy(user) ? store.comments.counts() : {},
      // Comments of every status are for moderators only.
      latestComments: can.taxonomy(user) ? store.comments.list({ limit: 5 }).rows : null,
      noTwoStep,
      // Plain sentences about the set-up of the site (from start-up checks), for the owner only.
      warnings: owner ? [...(ctx.warnings || [])].map(String) : [],
      recoveryReset: Boolean(user.recoveryCodesReset),
      media: can.taxonomy(user) ? store.media.count() : 0,
      drafts,
      scheduled,
      popular,
      health,
      sitemapUrl: `${site.blogUrl}/sitemap.xml`,
      robotsUrl: `${site.origin}/robots.txt`,
    });
  });

  // ---------- Posts and pages ----------

  // Messages for the content pages (added here so the table at the top of the file stays in one hand).
  Object.assign(FLASH, {
    duplicate: "That file was already in the library, so it wasn’t added again.",
    replyhidden: "That comment is hidden or removed, so it can’t be replied to. Approve it first.",
    pingwait: "Every URL was sent a moment ago. Wait a few minutes before sending them all again.",
    mailpasscleared: "Email settings saved. You changed the server, port, security or user name, so the saved password was removed. Enter it again to send email.",
    nothingtoretry: "Nothing failed on that newsletter, so there is nothing to send again.",
  });

  const listView = (type) => (c) => {
    const user = c.get("user");
    if (type === "page" && !can.pages(user)) return deny(c);
    const state = ["draft", "published", "scheduled"].includes(c.req.query("state")) ? c.req.query("state") : "";
    const q = String(c.req.query("q") || "").slice(0, 100);
    const categoryId = clampInt(c.req.query("category"), 0, 1e9, 0);
    const authorId = can.allPosts(user) ? clampInt(c.req.query("author"), 0, 1e9, 0) : user.id;
    const pageNo = clampInt(c.req.query("page"), 1, 1e5, 1);
    const per = 30;
    const own = (st) => store.posts.listAdmin({ type, state: st, authorId: user.id, limit: 1 }).total;
    const { rows, total } = store.posts.listAdmin({ type, state, q, categoryId, authorId, limit: per, offset: (pageNo - 1) * per });
    const users = new Map(store.users.list().map((u) => [u.id, u]));
    const cats = new Map(store.categories.list().map((k) => [k.id, k]));
    return page(c, "posts.njk", {
      nav: type === "page" ? "pages" : "posts",
      navState: state,
      type,
      rows: rows.map((p) => ({ ...p, author: users.get(p.author_id), category: cats.get(p.category_id), liveUrl: p.isPublic ? ctx.site().url.post(p.slug) : "" })),
      total,
      // Below editor, the tab totals are the person's own posts, not the whole site's.
      counts: can.allPosts(user) ? store.posts.counts(type) : { draft: own("draft"), published: own("published"), scheduled: own("scheduled"), total: own("") },
      filters: { state, q, category: categoryId, author: can.allPosts(user) && authorId ? String(authorId) : "" },
      categories: [...cats.values()],
      users: [...users.values()],
      pageNo,
      pages: Math.max(1, Math.ceil(total / per)),
    });
  };
  app.get(`${A}/posts`, listView("post"));
  app.get(`${A}/pages`, listView("page"));

  function editorData(c, post) {
    const user = c.get("user");
    const site = ctx.site();
    const tz = site.tz;
    const m = (id) => {
      const x = store.media.get(id);
      return x ? { id: x.id, url: site.url.media(x.path), alt: x.alt } : null;
    };
    const tags = post.id ? store.posts.tagsFor(post.id).map((t) => t.name).join(", ") : "";
    const v = post.video || {};
    const durationSecs = isoDurationToSeconds(v.duration);
    return {
      nav: post.type === "page" ? "pages" : "posts",
      post,
      form: {
        published_at: isoToLocalInput(post.published_at, tz),
        updated_at: isoToLocalInput(post.updated_at, tz),
        tags,
        at_a_glance: (post.at_a_glance || []).map(([k, val]) => `${k}: ${val}`).join("\n"),
        tested_with: (post.tested_with || []).join("\n"),
        chapters: (v.chapters || []).map((ch) => `${ch.at} ${ch.name}`).join("\n"),
        video_upload: v.upload_date ? isoToLocalInput(v.upload_date, tz) : "",
        video_duration: durationSecs != null ? secondsToClock(durationSecs) : v.duration || "",
      },
      media: { feature: m(post.feature_image_id), og: m(post.og_image_id) },
      categories: store.categories.list(),
      // Editors can hand a post to active people of their own rank or lower (and keep the current author).
      authors: can.allPosts(user) ? store.users.list().filter((u) => (u.status === "active" && RANK[u.role] <= RANK[user.role]) || u.id === post.author_id) : [],
      levels: LEVELS,
      langs: LANGUAGES,
      edData: {
        urlPrefix: `${site.blogUrl}/`,
        // The save times the editor loaded; a save made after someone else's is refused (see savePost).
        version: { modified: post.modified_at ?? null, updated: post.updated_at ?? null },
        canPurge: can.allPosts(user),
        glance: post.at_a_glance || [],
        sourceFiles: (post.source_files || []).map((f) => ({ name: f.name, lang: langFor(f.lang, f.name), code: f.code })),
        downloads: (post.downloads?.files || []).map((f) => {
          const x = store.media.get(f.media_id);
          return x ? { media_id: x.id, label: f.label, name: x.original_name, ext: x.path.split(".").pop(), size: x.size } : null;
        }).filter(Boolean),
      },
      liveUrl: post.isPublic ? site.url.post(post.slug) : "",
      urlPrefix: `${site.blogUrl}/`,
      canPublish: can.publish(user, post),
      canDelete: can.deletePost(user, post.id ? post : { ...post, author_id: user.id, status: "draft" }),
      tz,
      mediaBase: site.url.media(""),
    };
  }

  const newPost = (type) => (c) => {
    const user = c.get("user");
    if (type === "page" && !can.pages(user)) return deny(c);
    return page(c, "editor.njk", editorData(c, { id: 0, type, status: "draft", state: "draft", author_id: user.id, title: "", slug: "", body_md: "", at_a_glance: [], tested_with: [], video: {}, downloads: {}, source_files: [], comments_enabled: true }));
  };
  app.get(`${A}/posts/new`, newPost("post"));
  app.get(`${A}/pages/new`, newPost("page"));
  app.get(`${A}/:type{posts|pages}/:id{[0-9]+}`, (c) => {
    const post = store.posts.get(Number(c.req.param("id")));
    if (!post || post.type !== (c.req.param("type") === "pages" ? "page" : "post")) return missing(c);
    if (!can.editPost(c.get("user"), post)) return deny(c);
    return page(c, "editor.njk", editorData(c, post));
  });

  // Text from a form goes through validate.js (cleanText): control characters never belong in it, new lines stay.
  const MAX_BODY = 500_000;
  // The settings for a template: the saved SMTP password is never part of what a page receives.
  const safeSettings = () => {
    const { smtp_pass: _hidden, ...rest } = store.settings.all();
    return rest;
  };
  // One line of plain text from a form field: every run of white space (new lines too) becomes one space.
  // Repeated fields and files count as empty.
  const plainLine = (v, max) => (typeof v === "string" ? cleanText(v.replace(/\s+/g, " "), max) : "");
  // Several lines of plain text (line endings made uniform).
  const plainText = (v, max) => (typeof v === "string" ? cleanText(v.replace(/\r\n?/g, "\n"), max) : "");
  // A whole number from a form or JSON: a positive integer or a string of digits only (no arrays, booleans, hex or exponents).
  const wholeId = (v) => {
    if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : 0;
    return typeof v === "string" && /^[0-9]{1,12}$/.test(v.trim()) ? Number(v.trim()) : 0;
  };
  // One rule for a link on this site or a full web address (menus, ads, redirects, settings): at most 500 characters.
  const siteLink = (v) => typeof v === "string" && v.length <= 500 && (isSafeLocalPath(v) || isHttpUrl(v));
  const escHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const place = (key) => (typeof key === "string" && Object.hasOwn(AD_PLACES, key) ? AD_PLACES[key] : null);
  // The redirect an administrator added by hand at a post's URL, if any. Automatic ones (made by a rename or a delete) don't count.
  const adminRedirectAt = (slug) => {
    const path = `${config.basePath}/${slug}/`;
    const row = store.redirects.getByPath ? store.redirects.getByPath(path) : store.redirects.find(path);
    return row && (row.source || "admin") === "admin" ? row : null;
  };
  const tagNames = (v) => [...new Set((typeof v === "string" ? v.slice(0, 5000) : "").split(",").map((t) => plainLine(t, 60)).filter(Boolean))].slice(0, 20);
  const safeDecode = (s) => {
    try {
      return decodeURI(s);
    } catch {
      return null;
    }
  };
  const previewLimit = createRateLimiter({ limit: 120, windowMs: 60_000 });

  // Validates editor input into POST_FIELDS. Returns { values, tags, errors }.
  // Fields that need an editor (featured, noindex, canonical URL, comments on or off, back-dated publish date, "Updated" date) keep their stored values for lower roles.
  // A key the client left out keeps the stored value too, so a partial or stale save can't wipe a field.
  // A picture or file that is not already on the post is accepted only from an editor, its uploader, or when it is already public.
  const MEDIA_NOT_YOURS = "One picture or file isn't yours to use.";
  function normalize(body, user, before, { intent = "" } = {}) {
    const tz = ctx.site().tz;
    const errors = [];
    const isEditor = can.allPosts(user);
    // Plain text only: arrays, objects, numbers and booleans count as text that was not sent.
    const str = (v, max = 500) => plainText(v, max);
    const sent = (k) => body[k] !== undefined;
    const field = (k, max) => (typeof body[k] === "string" ? str(body[k], max) : before?.[k] ?? "");
    const id = (v, exists) => {
      const n = wholeId(v);
      return n && exists(n) ? n : null;
    };
    const lines = (v) => str(v, 20000).split("\n").map((l) => l.trim()).filter(Boolean);
    const type = before?.type || (body.type === "page" ? "page" : "post");
    // Pictures and files already on the post stay whoever saves it.
    const storedMedia = new Set([before?.feature_image_id, before?.og_image_id, ...(before?.downloads?.files || []).map((f) => f.media_id)].filter(Boolean));
    const mediaRef = (v, kind, where) => {
      const n = wholeId(v);
      const m = n ? store.media.get(n) : null;
      if (!m) return null;
      const say = (message) => {
        if (!errors.some((e) => e.field === where && e.message === message)) errors.push({ field: where, message });
      };
      if ((m.kind || "image") !== kind) {
        say(kind === "image" ? "this must be a picture, not a download" : "this must be a download file, not a picture");
        return null;
      }
      if (!storedMedia.has(n) && !isEditor && m.uploaded_by !== user.id && !store.media.isPublic(n)) {
        say(MEDIA_NOT_YOURS);
        return null;
      }
      return n;
    };
    const level = wholeId(body.level);
    const values = {
      type,
      title: field("title", 300),
      body_md: typeof body.body_md === "string" ? body.body_md.replace(/\r\n?/g, "\n").slice(0, MAX_BODY) : before?.body_md ?? "",
      excerpt: typeof body.excerpt === "string" ? plainLine(body.excerpt, 400) : before?.excerpt ?? "",
      seo_title: field("seo_title", 200),
      short_title: field("short_title", 100),
      canonical_url: isEditor && typeof body.canonical_url === "string" ? str(body.canonical_url, 500) : before?.canonical_url || "",
      noindex: isEditor && sent("noindex") ? Boolean(body.noindex) : Boolean(before?.noindex),
      og_title: field("og_title", 200),
      og_description: field("og_description", 400),
      og_image_id: sent("og_image_id") ? mediaRef(body.og_image_id, "image", "og_image_id") : before?.og_image_id ?? null,
      feature_image_id: sent("feature_image_id") ? mediaRef(body.feature_image_id, "image", "feature_image_id") : before?.feature_image_id ?? null,
      feature_image_alt: field("feature_image_alt", 300),
      feature_image_caption: field("feature_image_caption", 300),
      category_id: type !== "post" ? null : sent("category_id") ? id(body.category_id, store.categories.get) : before?.category_id ?? null,
      level: sent("level") ? ([1, 2, 3, 4].includes(level) ? level : null) : before?.level ?? null,
      quick_answer: field("quick_answer", 1500),
      // Rows from the editor's grid, or "Label: value" lines. Only the first rows are looked at.
      at_a_glance: !Array.isArray(body.at_a_glance) && typeof body.at_a_glance !== "string"
        ? before?.at_a_glance ?? []
        : (Array.isArray(body.at_a_glance)
          ? body.at_a_glance.slice(0, 40).map((r) => (Array.isArray(r) ? [str(r[0], 60), str(r[1], 200)] : ["", ""]))
          : lines(body.at_a_glance).slice(0, 40).map((l) => {
              const i = l.indexOf(":");
              return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, ""];
            })
        ).filter(([k, v]) => k && v).slice(0, 20),
      tested_with: typeof body.tested_with === "string" ? lines(body.tested_with).slice(0, 20) : before?.tested_with ?? [],
      featured: isEditor && sent("featured") ? Boolean(body.featured) : Boolean(before?.featured),
      // Only an editor can switch comments on or off; a save that leaves the key out keeps what is stored.
      comments_enabled: isEditor && sent("comments_enabled") ? Boolean(body.comments_enabled) : before ? before.comments_enabled !== false : true,
      // Full code for the Source code box: [{name, lang, code}].
      source_files: type === "post" && Array.isArray(body.source_files)
        ? body.source_files.slice(0, 20).map((f) => ({ name: str(f?.name, 80), lang: typeof f?.lang === "string" && Object.hasOwn(LANGUAGES, f.lang) ? f.lang : langFor("", typeof f?.name === "string" ? f.name : ""), code: typeof f?.code === "string" ? f.code.replace(/\r\n?/g, "\n").slice(0, 200_000) : "" })).filter((f) => f.name || f.code.trim())
        : before?.source_files || [],
    };
    if (values.source_files.reduce((n, f) => n + f.code.length, 0) > 600_000) errors.push({ field: "source_files", message: "the source files are too long together (600,000 characters at most)" });
    for (const f of values.source_files) if (f.name && !isSourceName(f.name)) errors.push({ field: "source_files", message: `“${f.name}” isn’t a valid file name (letters, digits, dot, dash, underscore)` });
    // Two files with one name would give the same download twice, and two entries with one name in the ZIP.
    const seenNames = new Set();
    for (const f of values.source_files) {
      const key = f.name.toLowerCase();
      if (f.name && seenNames.has(key)) errors.push({ field: "source_files", message: `two source files are called “${f.name}”; give each file its own name` });
      seenNames.add(key);
    }

    if (values.canonical_url && !isHttpUrl(values.canonical_url)) {
      errors.push({ field: "canonical_url", message: "the canonical URL must be a full web address starting with https://" });
      values.canonical_url = before?.canonical_url || "";
    }

    // Slug: from the field, else the title; unique across posts and pages. A web address that an administrator
    // redirected by hand stays reserved for everyone below that role.
    const slugTaken = (s) => store.posts.slugTaken(s, { excludeId: before?.id || 0 }) || (!can.settings(user) && s !== before?.slug && Boolean(adminRedirectAt(s)));
    // A save that leaves the URL out keeps the stored one; an empty field makes it from the title again.
    let slug = (typeof body.slug === "string" ? slugify(body.slug || values.title) : before?.slug || slugify(values.title)) || before?.slug || "";
    if (!slug) slug = `untitled-${Date.now().toString(36)}`;
    if (slugTaken(slug)) {
      if (typeof body.slug === "string" && body.slug && before?.slug !== slug) errors.push({ field: "slug", message: `the URL “${slug}” is already used by another post or page, or reserved by an administrator` });
      if (before?.slug && !slugTaken(before.slug)) slug = before.slug;
      else {
        const root = slug;
        for (let n = 2; slugTaken(slug); n++) slug = `${root}-${n}`;
      }
    }
    values.slug = slug;

    // Author: editors and up can assign, only to an active person of their own rank or lower; others always write as themselves.
    const pickable = (n) => {
      const u = store.users.get(n);
      return Boolean(u) && (n === before?.author_id || (u.status === "active" && RANK[u.role] <= RANK[user.role]));
    };
    values.author_id = isEditor ? id(body.author_id, pickable) || before?.author_id || user.id : before?.author_id || user.id;

    // Video: accepts a full YouTube URL or the 11-character id; duration as 8:04 or PT8M4S. A save without any video field keeps the stored video.
    if (before && !["video_youtube", "video_title", "video_description", "video_upload", "video_duration", "chapters"].some(sent)) {
      values.video = before.video || {};
    } else {
      const yt = str(body.video_youtube, 200);
      let ytId = /^[A-Za-z0-9_-]{11}$/.test(yt) ? yt : (/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(yt) || [])[1] || "";
      if (!/^[A-Za-z0-9_-]{11}$/.test(ytId)) ytId = "";
      if (yt && !ytId) errors.push({ field: "video_youtube", message: "that isn’t a YouTube link or an 11-character video id, so the video was left out" });
      const durRaw = str(body.video_duration, 20);
      const durSecs = /^P/i.test(durRaw) ? isoDurationToSeconds(durRaw.toUpperCase()) : timestampToSeconds(durRaw);
      const upload = localInputToIso(str(body.video_upload, 20), tz);
      values.video = {
        youtube_id: ytId,
        title: str(body.video_title, 200),
        description: str(body.video_description, 1000),
        upload_date: upload ? isoWithOffset(upload, tz) : "",
        duration: durSecs != null ? `PT${Math.floor(durSecs / 3600) ? `${Math.floor(durSecs / 3600)}H` : ""}${Math.floor((durSecs % 3600) / 60)}M${durSecs % 60}S` : durRaw,
        chapters: lines(body.chapters).slice(0, 50).map((l) => {
          const m = /^(\d+(?::\d{1,2}){1,2})\s*[-–—]?\s*(.+)$/.exec(l);
          return m ? { at: m[1], name: m[2].trim() } : { at: "", name: l };
        }),
      };
      if (!values.video.youtube_id) values.video = {};
    }

    // Downloads: a GitHub link and files from the media library (files only, and only ones this person may use).
    const files = Array.isArray(body.download_files) ? body.download_files : before?.downloads?.files || [];
    let github = typeof body.download_github === "string" ? str(body.download_github, 500) : before?.downloads?.github || "";
    if (github && !isHttpUrl(github)) {
      errors.push({ field: "download_github", message: "the GitHub link must be a full web address starting with https://" });
      github = before?.downloads?.github || "";
    }
    values.downloads = {
      github,
      files: files.slice(0, 20).map((f) => ({ media_id: mediaRef(f?.media_id, "file", "downloads"), label: str(f?.label, 80) })).filter((f) => f.media_id),
    };

    if (typeof body.published_at === "string" && body.published_at) {
      const iso = localInputToIso(str(body.published_at, 20), tz);
      // Only an editor can set a date in the past. Anyone else can set a future date only together with Publish
      // (a draft with a future date would count as published once, and could no longer be deleted by its writer).
      if (iso && (isEditor || (intent === "publish" && iso > new Date().toISOString()))) values.published_at = iso;
      else if (!iso) errors.push({ field: "published_at", message: "publish date isn’t a valid date and time" });
    }
    if (typeof body.updated_at === "string" && body.updated_at && isEditor) {
      const iso = localInputToIso(str(body.updated_at, 20), tz);
      if (iso && iso !== before?.updated_at) values.updated_at = iso;
    }
    // Tags: a save that leaves them out keeps the stored ones.
    const tags = body.tags === undefined && before ? store.posts.tagsFor(before.id).map((t) => t.name) : tagNames(body.tags);
    return { values, tags, errors };
  }

  const summary = (p) => {
    const site = ctx.site();
    return {
      id: p.id,
      type: p.type,
      slug: p.slug,
      state: p.state,
      status: p.status,
      url: site.url.post(p.slug),
      editUrl: `${A}/${p.type === "page" ? "pages" : "posts"}/${p.id}`,
      published_at: isoToLocalInput(p.published_at, site.tz),
      updated_at: isoToLocalInput(p.updated_at, site.tz),
      // The save times the editor must send with its next save.
      version: { modified: p.modified_at ?? null, updated: p.updated_at ?? null },
      words: p.word_count,
      minutes: readingMinutes(p.word_count),
    };
  };

  function runChecks(post, tagIds) {
    const site = ctx.site();
    const mdi = markdown({ current: ctx.site });
    const tokens = mdi.parse(post.body_md || "", {});
    // Every link and picture is looked up in the database; after 300 lookups the rest are left unchecked (with a note), so one save stays cheap.
    const LOOKUPS = 300;
    let lookups = 0;
    const resolvePath = (p) => {
      if (lookups++ >= LOOKUPS) return true;
      const rest = p.slice(site.base.length).replace(/^\/+|\/+$/g, "");
      if (!rest) return true;
      const parts = rest.split("/");
      if (parts[0] === "media") {
        const name = safeDecode(parts.slice(1).join("/"));
        return name !== null && Boolean(store.media.getByPath(name));
      }
      if (parts[0] === "category") return Boolean(store.categories.getBySlug(parts[1]));
      if (parts[0] === "tag") return Boolean(store.tags.getBySlug(parts[1]));
      if (parts[0] === "authors") return Boolean(store.users.getBySlug(parts[1]));
      if (["latest", "search", "rss.xml", "sitemap.xml"].includes(parts[0])) return true;
      if (["signin", "signup", "account"].includes(parts[0])) return true;
      if (parts.length === 1) return Boolean(store.posts.getPublicBySlug(parts[0]) || parts[0] === post.slug);
      return false;
    };
    const mediaExists = (p) => {
      if (lookups++ >= LOOKUPS) return true;
      const name = safeDecode(p);
      return name !== null && Boolean(store.media.getByPath(name));
    };
    try {
      const result = publishChecks({ ...post, tags: tagIds, word_count: countWords(post.body_md) }, { tokens, basePath: site.base, siteHost: site.host, resolvePath, mediaExists, mediaFileExists: (mid) => store.media.get(mid)?.kind === "file" });
      if (lookups > LOOKUPS) result.warnings.push({ field: "body_md", label: "Text", message: `the text has so many links and pictures that only the first ${LOOKUPS} were checked`, line: 0 });
      return result;
    } catch {
      // A link with a broken % sequence can make a check throw; report it instead of failing the whole save.
      return { errors: [{ field: "body_md", label: "Text", message: "a link in the text has a broken % sequence, so it couldn’t be checked", line: 0 }], warnings: [] };
    }
  }

  // Finds tags by name. Only people who manage tags (editors and up) may create new ones; the rest get the unknown names back.
  const resolveTags = (names, create) => {
    const r = store.tags.ensure(names, { create });
    return Array.isArray(r) ? { tags: r, unknown: [] } : { tags: r.tags || [], unknown: r.unknown || [] };
  };
  // The public parts of a post, to tell whether a save changed anything a search engine would see.
  const publicShape = (p, tagIds) => JSON.stringify([p.title, p.slug, p.body_md, p.excerpt, p.seo_title, p.short_title, p.canonical_url, p.noindex, p.og_title, p.og_description, p.og_image_id, p.feature_image_id, p.feature_image_alt, p.feature_image_caption, p.category_id, p.level, p.quick_answer, p.at_a_glance, p.tested_with, p.video, p.downloads, p.source_files, p.published_at, p.status, p.author_id, p.featured, [...tagIds].sort((a, b) => a - b)]);

  function pingFor(post, { removed = false } = {}) {
    const site = ctx.site();
    const urls = [site.abs(site.url.post(post.slug)), site.abs(site.url.home), `${site.blogUrl}/sitemap.xml`];
    if (!removed && post.category_id) {
      const cat = store.categories.get(post.category_id);
      if (cat) urls.push(site.abs(site.url.category(cat.slug)));
    }
    ctx.indexNow.ping(urls);
  }

  // Saves are limited per person (autosave sends one every 15 seconds, so this is far above normal use).
  const saveLimit = createRateLimiter({ limit: 60, windowMs: 60_000 });
  // A person below editor may keep about 20 million characters of their own posts (text and source files), and 10 older versions of each post.
  const LOW_ROLE_TEXT_CAP = 20_000_000;
  const LOW_ROLE_REVISIONS = 10;
  const CONFLICT_MESSAGE = "Someone else saved this post a moment ago. Copy your changes, reload, and apply them again.";
  const textUsedBy = (userId, exceptId) => ctx.db.prepare("SELECT COALESCE(SUM(length(body_md) + length(source_files)), 0) AS n FROM posts WHERE author_id = ? AND id != ?").get(userId, exceptId || 0).n;

  // Create/update through JSON. intent: autosave | save | publish | unpublish
  async function savePost(c, id) {
    const user = c.get("user");
    if (!saveLimit.take(`u:${user.id}`)) return c.json({ error: "Slow down a little and try again in a minute." }, 429);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Bad request" }, 400);
    const before = id ? store.posts.get(id) : null;
    if (id && !before) return c.json({ error: "This post was deleted." }, 404);
    const type = before?.type || (body.type === "page" ? "page" : "post");
    if (type === "page" && !can.pages(user)) return c.json({ error: "Your role can’t edit pages." }, 403);
    if (before && !can.editPost(user, before)) return c.json({ error: "You can’t edit this post." }, 403);
    // Changing or unpublishing something that is live takes the right to publish.
    if (before?.status === "published" && !can.publish(user, before)) return c.json({ error: "This post is live. Only an author or above can change or unpublish it; ask them to make the change." }, 403);
    // A person below editor can keep at most 200 posts of their own, so one account can't fill the database with drafts.
    if (!before && !can.allPosts(user) && store.posts.listAdmin({ type, authorId: user.id, limit: 1 }).total >= 200) return c.json({ error: "You have 200 posts already. Delete old drafts before starting a new one." }, 429);
    // The editor sends the save times it loaded. If the post was saved since (another tab, another person), this save would overwrite newer text.
    if (before && typeof body.loaded_modified_at === "string" && before.modified_at !== body.loaded_modified_at) return c.json({ error: CONFLICT_MESSAGE, conflict: true }, 409);

    const intent = ["autosave", "save", "publish", "unpublish"].includes(body.intent) ? body.intent : "save";
    const { values, tags, errors: inputErrors } = normalize({ ...body, type }, user, before, { intent });
    // One account can't fill the disk with text.
    if (!can.allPosts(user) && textUsedBy(user.id, before?.id) + (values.body_md?.length || 0) + values.source_files.reduce((n, f) => n + f.code.length, 0) > LOW_ROLE_TEXT_CAP) {
      return c.json({ error: "You have used up the space for your posts. Delete old drafts before adding more text." }, 413);
    }

    let status = before?.status || "draft";
    if (intent === "publish") status = "published";
    if (intent === "unpublish") status = "draft";
    if (status === "published" && !can.publish(user, before || { ...values, author_id: user.id })) return c.json({ error: "Contributors can’t publish. Save the draft and ask an editor to publish it." }, 403);
    if (intent === "autosave" && before?.status === "published") return c.json({ ok: true, skipped: true, post: summary(before) });

    values.status = status;
    if (status === "published" && !values.published_at) values.published_at = before?.status === "published" ? before.published_at : new Date().toISOString();
    if (status === "draft" && !values.published_at) values.published_at = before?.published_at ?? null;

    // The checks only look at existing tags plus placeholders for the new ones; nothing is created until a save really happens.
    const mayCreateTags = can.taxonomy(user);
    const known = resolveTags(tags, false);
    const checks = runChecks({ ...before, ...values }, [...known.tags.map((t) => t.id), ...(mayCreateTags ? known.unknown.map((_, i) => -(i + 1)) : [])]);
    checks.errors.unshift(...inputErrors.map((e) => ({ ...e, label: e.field })));
    // Creates the new tags for editors and up; everyone else gets a warning listing the names that were left out.
    const settleTags = () => {
      const r = resolveTags(tags, mayCreateTags);
      if (r.unknown.length) checks.warnings.push({ field: "tags", label: "Tags", message: `only an editor can create new tags, so these were left out: ${r.unknown.slice(0, 5).join(", ")}${r.unknown.length > 5 ? "…" : ""}. Pick tags that already exist.`, line: 0 });
      return r.tags.map((t) => t.id);
    };
    // The store also refuses a save that comes after someone else's (code CONFLICT); the editor then stops saving until the page is reloaded.
    // (The value sent is the post's modified_at as loaded: updated_at often stays the same between saves.)
    const loadedUpdated = typeof body.loaded_modified_at === "string" && body.loaded_modified_at ? { ifUpdatedAt: body.loaded_modified_at } : {};
    const persist = (input, options) => {
      const post = store.posts.save(input, { id, userId: user.id, ...options, ...(before ? loadedUpdated : {}) });
      // People below editor keep only their last few older versions of a post.
      if (!can.allPosts(user)) ctx.db.prepare("DELETE FROM revisions WHERE post_id = ? AND id NOT IN (SELECT id FROM revisions WHERE post_id = ? ORDER BY id DESC LIMIT ?)").run(post.id, post.id, LOW_ROLE_REVISIONS);
      return post;
    };

    try {
      // Anything that would go (or stay) live must pass the checks; drafts always save.
      if (status === "published" && checks.errors.length) {
        if (!before || before.status !== "published") {
          const draft = persist({ ...values, status: "draft", published_at: before?.published_at ?? null, tags: settleTags() });
          return c.json({ ok: false, saved: true, error: "Saved as a draft. Fix these before publishing:", checks, post: summary(draft) }, 422);
        }
        return c.json({ ok: false, saved: false, error: "Not saved: the live post must pass these checks.", checks, post: summary(before) }, 422);
      }

      const beforeTags = before ? store.posts.tagsFor(before.id).map((t) => t.id) : [];
      const tagIds = settleTags();
      const saved = persist({ ...values, tags: tagIds }, { keepUpdatedDate: can.allPosts(user) && Boolean(body.keep_updated_date) });
      // Tell search engines only when something they can see changed.
      const changed = !before || before.isPublic !== saved.isPublic || publicShape(before, beforeTags) !== publicShape(saved, tagIds);
      if (changed && (saved.isPublic || before?.isPublic)) pingFor(saved, { removed: !saved.isPublic });
      if (changed && before?.isPublic && before.slug !== saved.slug) pingFor(before, { removed: true });
      return c.json({ ok: true, checks, post: summary(saved) }, id ? 200 : 201);
    } catch (err) {
      if (err?.code === "CONFLICT") return c.json({ error: CONFLICT_MESSAGE, conflict: true }, 409);
      throw err;
    }
  }
  app.post(`${A}/api/posts`, (c) => savePost(c, 0));
  app.post(`${A}/api/posts/:id{[0-9]+}`, (c) => savePost(c, Number(c.req.param("id"))));

  app.post(`${A}/api/posts/:id{[0-9]+}/delete`, (c) => {
    const post = store.posts.get(Number(c.req.param("id")));
    if (!post) return c.json({ ok: true });
    if (!can.deletePost(c.get("user"), post)) return c.json({ error: "You can’t delete this post." }, 403);
    store.posts.remove(post.id);
    if (post.isPublic) pingFor(post, { removed: true });
    return c.json({ ok: true, redirect: `${A}/${post.type === "page" ? "pages" : "posts"}?ok=deleted` });
  });
  // The same from the posts list, so a draft whose editor won't open can still be removed.
  app.post(`${A}/:type{posts|pages}/:id{[0-9]+}/delete`, async (c) => {
    await form(c);
    const type = c.req.param("type") === "pages" ? "page" : "post";
    const post = store.posts.get(Number(c.req.param("id")));
    if (!post || post.type !== type) return c.redirect(`${A}/${c.req.param("type")}`);
    if (!can.deletePost(c.get("user"), post)) return deny(c);
    store.posts.remove(post.id);
    if (post.isPublic) pingFor(post, { removed: true });
    return c.redirect(`${A}/${c.req.param("type")}?ok=deleted`);
  });

  app.get(`${A}/api/posts/:id{[0-9]+}/revisions`, (c) => {
    const post = store.posts.get(Number(c.req.param("id")));
    if (!post || !can.editPost(c.get("user"), post)) return c.json({ error: "Not found" }, 404);
    return c.json({ revisions: store.posts.revisions(post.id) });
  });
  app.get(`${A}/api/posts/:id{[0-9]+}/revisions/:rev{[0-9]+}`, (c) => {
    const post = store.posts.get(Number(c.req.param("id")));
    if (!post || !can.editPost(c.get("user"), post)) return c.json({ error: "Not found" }, 404);
    const rev = store.posts.revision(post.id, Number(c.req.param("rev")));
    return rev ? c.json({ title: rev.title, body_md: rev.body_md }) : c.json({ error: "Not found" }, 404);
  });

  // Older versions can hold something that must not stay (a password or key that was pasted and then removed). Editors and up can
  // delete one version, or every older version (the newest, which is what the post has now, stays).
  const purgeRoute = (route, act) =>
    app.post(route, (c) => {
      const user = c.get("user");
      const post = store.posts.get(Number(c.req.param("id")));
      if (!post || !can.editPost(user, post)) return c.json({ error: "Not found" }, 404);
      if (!can.allPosts(user)) return c.json({ error: "Only an editor can remove older versions." }, 403);
      const removed = act(post, c);
      console.log(`[audit] ${removed} older version(s) of ${post.type} ${post.id} removed by user ${user.id}`);
      return c.json({ ok: true, removed });
    });
  purgeRoute(`${A}/api/posts/:id{[0-9]+}/revisions/purge`, (post) => store.posts.purgeRevisions(post.id));
  purgeRoute(`${A}/api/posts/:id{[0-9]+}/revisions/:rev{[0-9]+}/delete`, (post, c) => store.posts.deleteRevision(post.id, Number(c.req.param("rev"))));

  // Full-page preview of unsaved editor content, opened in a new tab. (The editor has no other preview or checks calls:
  // the earlier /api/preview and /api/checks endpoints had no caller and are gone.)
  const MAX_PREVIEW_PAYLOAD = 3_000_000;
  app.post(`${A}/preview`, async (c) => {
    const user = c.get("user");
    const body = await form(c);
    if (typeof body.payload !== "string") return c.text("Bad preview data", 400);
    if (body.payload.length > MAX_PREVIEW_PAYLOAD) return c.text("That text is too long to preview.", 413);
    let data;
    try {
      data = JSON.parse(body.payload || "{}");
    } catch {
      return c.text("Bad preview data", 400);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return c.text("Bad preview data", 400);
    if (!previewLimit.take(`u:${user.id}`)) return c.text("Slow down a little and try again in a minute.", 429);
    // An id must be a whole number (not an array, a boolean or a hex string).
    const dataId = data.id === undefined || data.id === null || data.id === "" || data.id === 0 ? 0 : wholeId(data.id);
    if (data.id && !dataId) return c.text("Bad preview data", 400);
    const before = dataId ? store.posts.get(dataId) : null;
    if (before && !can.editPost(user, before)) return deny(c);
    if ((before?.type || data.type) === "page" && !can.pages(user)) return deny(c);
    const { values } = normalize(data, user, before);
    const t = new Date().toISOString();
    const post = { id: before?.id || 0, status: "draft", state: before?.state || "draft", created_at: t, modified_at: t, views: 0, ...(before || {}), ...values, word_count: countWords(values.body_md) };
    post.published_at ||= t;
    return ctx.renderPreview(c, post);
  });

  // ---------- Media ----------

  // Alt text goes into Markdown as ![alt](address). These characters would end or change the image, so each gets a backslash.
  const mdEscape = (s) => String(s ?? "").replace(/[\\[\]()<>*_`]/g, "\\$&");
  const mediaItem = (m) => {
    const site = ctx.site();
    const small = (m.variants?.webp || []).find(([w]) => w >= 400) || m.variants?.webp?.[0];
    const url = site.url.media(m.path);
    return { id: m.id, kind: m.kind, ext: m.path.split(".").pop().toLowerCase(), url, thumb: m.kind === "file" ? "" : site.url.media(small ? small[1] : m.path), alt: m.alt, markdown: m.kind === "file" ? "" : `![${mdEscape(m.alt || "Describe this image")}](${url})`, name: m.original_name, width: m.width, height: m.height, size: m.size, mime: m.mime, created_at: m.created_at, uploaded_by: m.uploaded_by };
  };

  // At most 20 files in one request, and a daily quota per person (counted from what they uploaded in the last 24 hours).
  const MAX_FILES_PER_REQUEST = 20;
  const uploadQuota = (u) => (RANK[u.role] >= RANK.admin ? { files: 1000, bytes: 5 * 1024 ** 3 } : RANK[u.role] >= RANK.editor ? { files: 300, bytes: 1024 ** 3 } : { files: 60, bytes: 300 * 1024 ** 2 });
  const usedToday = (userId) => ctx.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM media WHERE uploaded_by = ? AND created_at >= ?").get(userId, new Date(Date.now() - 864e5).toISOString());
  // The daily quota counts what is stored, so it is not enough on its own. Every upload attempt also counts here, however it ends
  // (a repeat of a file already stored, a refusal, a deleted file uploaded again): 60 an hour below editor, 300 for editors, 1000 for administrators.
  const uploadTries = {
    low: createRateLimiter({ limit: 60, windowMs: 3_600_000 }),
    editor: createRateLimiter({ limit: 300, windowMs: 3_600_000 }),
    admin: createRateLimiter({ limit: 1000, windowMs: 3_600_000 }),
  };
  const triesFor = (u) => (can.settings(u) ? uploadTries.admin : can.allPosts(u) ? uploadTries.editor : uploadTries.low);
  // Uploads running at once: one per person below editor, two for editors and up. The place is taken before the request body is read.
  const uploading = new Map();
  function takeUploadSlot(user) {
    const n = uploading.get(user.id) || 0;
    if (n >= (can.allPosts(user) ? 2 : 1)) return null;
    uploading.set(user.id, n + 1);
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      const left = (uploading.get(user.id) || 1) - 1;
      if (left > 0) uploading.set(user.id, left);
      else uploading.delete(user.id);
    };
  }
  const altLimit = createRateLimiter({ limit: 30, windowMs: 3_600_000 });
  // Alt text and file names: plain text, at most 300 characters. Control characters and invisible format characters
  // (such as the right-to-left override, which can make "x.zip" look like "x.pdf") are removed.
  const plainAlt = (v) => (typeof v === "string" ? cleanText(v.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " "), 300) : "");
  // Messages for the few fixed codes that may arrive in ?error=. Free text from the address is never shown.
  const MEDIA_ERRORS = {
    toomany: `Choose at most ${MAX_FILES_PER_REQUEST} files at a time.`, quota: "You’ve reached today’s upload limit. Try again tomorrow, or ask an administrator.", upload: "That file couldn’t be uploaded.", used: "That file is still in use. Remove it there first.",
    busy: "An upload of yours is still running. Wait for it to finish, then try again.", tries: "That’s a lot of uploads in the last hour. Try again later.",
  };
  const uploadError = (message, status) => Object.assign(new UploadError(message), { status });
  const checkQuota = (user, size) => {
    const used = usedToday(user.id);
    const quota = uploadQuota(user);
    if (used.n + 1 > quota.files || used.bytes + size > quota.bytes) throw new UploadError(MEDIA_ERRORS.quota);
  };
  // A file that is already in the library (the same bytes) is not stored twice. Only someone who could see it in their own library
  // (an editor, or whoever uploaded it) gets its record back; anyone else only learns that it is there.
  function reuse(user, existing, alt) {
    if (!can.deleteMedia(user, existing)) throw new UploadError("That file is already in the library.");
    // The first uploader keeps the record. Fill in the alt text if it was empty.
    const text = plainAlt(alt);
    if (text && !existing.alt) store.media.setAlt(existing.id, text);
    return { media: store.media.get(existing.id), duplicate: true };
  }

  // Returns { media, duplicate }.
  async function upload(c, file, alt, { neutral = false } = {}) {
    const user = c.get("user");
    if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") throw new UploadError("Choose a file to upload.");
    if (!triesFor(user).take(`u:${user.id}`)) throw uploadError(MEDIA_ERRORS.tries, 429);
    const isFile = isFileUpload(file.name);
    if (isFile && RANK[user.role] < RANK.author) throw new UploadError("Your role can upload pictures only. Ask an author or an editor to add downloads.");
    const limit = isFile ? Math.max(config.maxUploadBytes, 50 * 1048576) : config.maxUploadBytes;
    if (file.size > limit) throw new UploadError(`That file is over ${Math.round(limit / 1048576)} MB.`);
    checkQuota(user, file.size);
    const buf = Buffer.from(await file.arrayBuffer());
    // The same bytes again: answer from the library before anything is encoded.
    const known = store.media.findByInputKey(inputKey(buf));
    if (known) return reuse(user, known, alt);
    const processed = isFile ? processFile(buf, file.name, ctx.mediaDir) : await processUpload(buf, neutral ? "m" : file.name, ctx.mediaDir);
    const existing = store.media.getByPath(processed.path);
    if (existing) return reuse(user, existing, alt);
    // The quota again, just before the row is added: other uploads of this person may have finished while this one was working.
    checkQuota(user, file.size);
    return { media: store.media.insert({ ...processed, original_name: plainAlt(String(file.name || "image")).slice(0, 200) || "image", alt: plainAlt(alt) }, user.id), duplicate: false };
  }
  // The status an UploadError carries (400 for a bad file, 503 when the image queue is full, 429 for my own limits) is the response status.
  const uploadStatus = (err) => (Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 400);

  // People below editor see only their own uploads; editors and up see everything.
  const mediaFor = (user, opts) => store.media.list(can.allPosts(user) ? opts : { ...opts, uploadedBy: user.id });
  const mediaPage = (c, extra = {}, status = 200) => {
    const pageNo = clampInt(c.req.query("page"), 1, 1e5, 1);
    const q = String(c.req.query("q") || "").slice(0, 100);
    const per = 48;
    const kind = ["image", "file"].includes(c.req.query("kind")) ? c.req.query("kind") : "";
    const items = mediaFor(c.get("user"), { limit: per + 1, offset: (pageNo - 1) * per, q, kind });
    const code = c.req.query("error");
    const error = extra.error || (typeof code === "string" && Object.hasOwn(MEDIA_ERRORS, code) ? MEDIA_ERRORS[code] : "");
    return page(c, "media.njk", { nav: "media", items: items.slice(0, per).map(mediaItem), more: items.length > per, pageNo, q, kind, error }, status);
  };
  app.get(`${A}/media`, (c) => mediaPage(c));
  app.post(`${A}/media`, async (c) => {
    const release = takeUploadSlot(c.get("user"));
    if (!release) return mediaPage(c, { error: MEDIA_ERRORS.busy }, 429);
    try {
      const body = await form(c);
      const files = [].concat(body.file || []).filter((f) => f && typeof f !== "string");
      if (files.length > MAX_FILES_PER_REQUEST) return mediaPage(c, { error: MEDIA_ERRORS.toomany }, 400);
      let added = 0;
      try {
        for (const f of files) if (!(await upload(c, f, "")).duplicate) added++;
      } catch (err) {
        if (err instanceof UploadError) return mediaPage(c, { error: err.message }, uploadStatus(err));
        throw err;
      }
      // Say so when every file was one the library already had.
      return c.redirect(`${A}/media?ok=${files.length && !added ? "duplicate" : "uploaded"}`);
    } finally {
      release();
    }
  });
  app.post(`${A}/media/:id{[0-9]+}`, async (c) => {
    const user = c.get("user");
    const body = await form(c);
    const m = store.media.get(Number(c.req.param("id")));
    if (!m) return missing(c);
    // Editors and up, or whoever uploaded the file. A missing or repeated field leaves the text as it is.
    if (!can.deleteMedia(user, m)) return deny(c);
    const alt = typeof body.alt === "string" ? plainAlt(body.alt) : null;
    // Unchanged text is not saved, so the blog's page cache is left alone.
    if (alt !== null && alt !== m.alt) {
      // The text shows on public pages and cards: once the picture is on the blog, only an editor changes it.
      if (!can.allPosts(user) && store.media.isPublic(m.id)) return mediaPage(c, { error: "That picture is on the blog now. Ask an editor to change its text." }, 403);
      if (!altLimit.take(`u:${user.id}`)) return mediaPage(c, { error: "You’ve changed a lot of picture text in the last hour. Try again later." }, 429);
      store.media.setAlt(m.id, alt);
    }
    return c.redirect(`${A}/media?ok=saved&page=${clampInt(body.page, 1, 1e5, 1)}`);
  });
  app.post(`${A}/media/:id{[0-9]+}/delete`, async (c) => {
    await form(c);
    const m = store.media.get(Number(c.req.param("id")));
    if (!m) return c.redirect(`${A}/media`);
    if (!can.deleteMedia(c.get("user"), m)) return deny(c);
    const used = store.media.usage(m);
    if (used.posts.length || used.users.length || used.ads.length || used.settings.length) {
      const n = used.posts.length + used.users.length + used.ads.length + used.settings.length;
      // Titles of drafts, older versions and sponsors are for editors; anyone else is told how many places use it.
      const where = [...used.posts.map((p) => `“${p.title || "Untitled"}”`), ...used.users.map((u) => `${u.name}'s photo`), ...used.ads.map((a) => `the ${a.name} banner`), ...used.settings.map((s) => (s === "logo_id" ? "the site logo" : "the default social image"))];
      // Shown straight from the server (not through the address), so the wording can't be supplied by a link.
      const error = can.allPosts(c.get("user")) ? `Still used by ${where.slice(0, 3).join(", ")}${where.length > 3 ? "…" : ""}. Remove it there first.` : `Still used in ${n} ${n === 1 ? "place" : "places"}. Remove it there first, or ask an editor.`;
      return mediaPage(c, { error }, 409);
    }
    store.media.remove(m.id);
    deleteMediaFiles(m, ctx.mediaDir);
    return c.redirect(`${A}/media?ok=deleted`);
  });
  app.get(`${A}/api/media`, (c) => {
    const pageNo = clampInt(c.req.query("page"), 1, 1e5, 1);
    const kind = c.req.query("kind") === "file" ? "file" : "image";
    const items = mediaFor(c.get("user"), { limit: 31, offset: (pageNo - 1) * 30, q: String(c.req.query("q") || "").slice(0, 100), kind });
    return c.json({ items: items.slice(0, 30).map(mediaItem), more: items.length > 30 });
  });
  app.post(`${A}/api/media`, async (c) => {
    const release = takeUploadSlot(c.get("user"));
    if (!release) return c.json({ error: MEDIA_ERRORS.busy }, 429);
    try {
      // The editor sends one file per request; more than 20 in one request is refused, and only the first is used.
      const body = await c.req.parseBody({ all: true });
      const files = [].concat(body.file || []);
      if (files.length > MAX_FILES_PER_REQUEST) return c.json({ error: MEDIA_ERRORS.toomany }, 400);
      const { media, duplicate } = await upload(c, files[0], [].concat(body.alt || [])[0], { neutral: [].concat(body.neutral || [])[0] === "1" });
      return c.json({ ok: true, item: mediaItem(media), duplicate }, 201);
    } catch (err) {
      if (err instanceof UploadError) return c.json({ error: err.message }, uploadStatus(err));
      throw err;
    } finally {
      release();
    }
  });

  // ---------- Categories and tags ----------

  const TAXA = {
    categories: { store: store.categories, label: "Category", plural: "Categories", fields: ["name", "slug", "description", "intro_md", "seo_title", "parent_id", "sort", "show_on_home"] },
    tags: { store: store.tags, label: "Tag", plural: "Tags", fields: ["name", "slug", "description"] },
  };

  function taxonomyInput(kind, body, id) {
    const t = TAXA[kind];
    const values = {};
    const errors = [];
    for (const f of t.fields) values[f] = plainText(body[f], f.endsWith("_md") ? 20000 : f === "name" ? 60 : 500);
    values.slug = slugify(values.slug || values.name);
    if (kind === "categories") {
      // One level of nesting: the parent must exist and be a top-level category, and a category that has sub-categories can't move under another one.
      values.parent_id = clampInt(body.parent_id, 1, 1e12, 0) || null;
      const problem = store.categories.parentProblem(id, values.parent_id);
      if (problem) {
        values.parent_id = null;
        errors.push(problem);
      }
      values.sort = clampInt(body.sort, -999, 999, 0);
      values.show_on_home = body.show_on_home ? 1 : 0;
    }
    if (!values.name) errors.push("Name is required.");
    if (!isSlug(values.slug)) errors.push("Slug must be lowercase words joined by hyphens.");
    else if (t.store.slugTaken(values.slug, id)) errors.push(`The slug “${values.slug}” is already used by another ${t.label.toLowerCase()}.`);
    if (values.description.length > 155) errors.push(`Description is ${values.description.length} characters; keep it to 155 (it is the meta description).`);
    return { values, errors };
  }

  for (const [kind, t] of Object.entries(TAXA)) {
    const listPage = (c, extra = {}, status = 200) =>
      page(c, "taxonomy.njk", { nav: kind, kind, t, items: t.store.list(), categories: store.categories.list().filter((k) => !k.parent_id), urlFor: kind, ...extra }, status);
    app.get(`${A}/${kind}`, (c) => (can.taxonomy(c.get("user")) ? listPage(c, { item: null }) : deny(c)));
    app.get(`${A}/${kind}/:id{[0-9]+}`, (c) => {
      if (!can.taxonomy(c.get("user"))) return deny(c);
      const item = t.store.get(Number(c.req.param("id")));
      return item ? listPage(c, { item }) : missing(c);
    });
    app.post(`${A}/${kind}`, async (c) => {
      if (!can.taxonomy(c.get("user"))) return deny(c);
      const { values, errors } = taxonomyInput(kind, await form(c), 0);
      if (errors.length) return listPage(c, { item: null, draft: values, errors }, 400);
      t.store.save(values);
      return c.redirect(`${A}/${kind}?ok=created`);
    });
    app.post(`${A}/${kind}/:id{[0-9]+}`, async (c) => {
      if (!can.taxonomy(c.get("user"))) return deny(c);
      const id = Number(c.req.param("id"));
      const item = t.store.get(id);
      if (!item) return missing(c);
      const { values, errors } = taxonomyInput(kind, await form(c), id);
      if (errors.length) return listPage(c, { item, draft: values, errors }, 400);
      const prefix = kind === "categories" ? "category/" : "tag/";
      if (item.slug !== values.slug) {
        // The old address keeps working. An automatic redirect never replaces one added by hand, and one that would loop is simply not made.
        try {
          store.redirects.save({ from_path: `${config.basePath}/${prefix}${item.slug}/`, to_path: `${config.basePath}/${prefix}${values.slug}/`, source: "auto" });
        } catch (err) {
          if (err?.code !== "LOOP") throw err;
        }
      }
      t.store.save(values, id);
      return c.redirect(`${A}/${kind}?ok=saved`);
    });
    app.post(`${A}/${kind}/:id{[0-9]+}/delete`, async (c) => {
      if (!can.taxonomy(c.get("user"))) return deny(c);
      await form(c);
      t.store.remove(Number(c.req.param("id")));
      return c.redirect(`${A}/${kind}?ok=deleted`);
    });
  }

  // ---------- Comments ----------

  // Editors and up moderate: approve, hide, delete, or reply as the team.
  app.get(`${A}/comments`, (c) => {
    if (!can.taxonomy(c.get("user"))) return deny(c);
    const status = ["published", "pending", "hidden"].includes(c.req.query("status")) ? c.req.query("status") : "";
    const postId = clampInt(c.req.query("post"), 0, 1e12, 0);
    const memberId = clampInt(c.req.query("member"), 0, 1e12, 0);
    const pageNo = clampInt(c.req.query("page"), 1, 1e5, 1);
    const per = 50;
    const { rows, total } = store.comments.list({ status, postId, memberId, limit: per, offset: (pageNo - 1) * per });
    const site = ctx.site();
    // Readers' email addresses are shown to administrators and the owner only; editors moderate by name.
    const showEmail = RANK[c.get("user").role] >= RANK.admin;
    const counts = store.comments.counts();
    const backParams = new URLSearchParams({ ...(status && { status }), ...(postId && { post: String(postId) }), ...(memberId && { member: String(memberId) }), ...(pageNo > 1 && { page: String(pageNo) }) });
    return page(c, "comments.njk", {
      nav: "comments",
      rows: rows.map((r) => ({ ...r, member_email: showEmail ? r.member_email : "", postUrl: site.url.post(r.post_slug) })),
      total,
      // Removed comments (kept only as an empty place for their replies) are not counted among the ones you can moderate.
      counts: { ...counts, total: (counts.published || 0) + (counts.pending || 0) + (counts.hidden || 0) },
      filters: { status, post: postId ? store.posts.get(postId) : null, member: memberId ? store.members.get(memberId) : null },
      pageNo,
      pages: Math.max(1, Math.ceil(total / per)),
      moderation: site.comments.moderation,
      // Each button form carries only the filter values and page number, not the whole request address.
      back: backParams.size ? `${A}/comments?${backParams}` : `${A}/comments`,
    });
  });
  // Back to the comments list, with the same filters. Only a local path under the comments page is accepted.
  const commentBack = (body) => {
    const back = typeof body.back === "string" ? body.back : "";
    return isSafeLocalPath(back) && (back === `${A}/comments` || back.startsWith(`${A}/comments?`)) ? back : `${A}/comments`;
  };
  const withOk = (url, ok) => {
    const u = new URL(url, "http://local");
    u.searchParams.set("ok", ok);
    return `${u.pathname}${u.search}`;
  };
  app.post(`${A}/comments/:id{[0-9]+}/:action{approve|hide|delete}`, async (c) => {
    if (!can.taxonomy(c.get("user"))) return deny(c);
    const body = await form(c);
    const comment = store.comments.get(Number(c.req.param("id")));
    if (!comment) return c.redirect(commentBack(body));
    const action = c.req.param("action");
    if (action === "delete") store.comments.remove(comment.id);
    else store.comments.setStatus(comment.id, action === "approve" ? "published" : "hidden");
    return c.redirect(withOk(commentBack(body), action === "approve" ? "approved" : action === "hide" ? "hidden" : "deleted"));
  });
  app.post(`${A}/comments/:id{[0-9]+}/reply`, async (c) => {
    const user = c.get("user");
    if (!can.taxonomy(user)) return deny(c);
    const body = await form(c);
    const comment = store.comments.get(Number(c.req.param("id")));
    const text = plainText(body.body, 5000);
    if (comment && text) {
      // A reply goes under a live top-level comment. Look at that comment first (it may be hidden or removed), so nothing is approved by a reply that then fails.
      const top = comment.parent_id ? store.comments.get(comment.parent_id) : comment;
      const topLive = top && (top.status === "published" || (top === comment && comment.status === "pending"));
      if (!topLive || comment.status === "hidden" || comment.status === "deleted") return c.redirect(withOk(commentBack(body), "replyhidden"));
      try {
        if (comment.status === "pending") store.comments.setStatus(comment.id, "published");
        store.comments.add({ postId: comment.post_id, userId: user.id, parentId: top.id, body: text });
      } catch (err) {
        if (err?.code === "PARENT_UNAVAILABLE") return c.redirect(withOk(commentBack(body), "replyhidden"));
        throw err;
      }
    }
    return c.redirect(withOk(commentBack(body), "replied"));
  });

  // ---------- Members (reader accounts) ----------

  // What the Members page may show of a reader: named fields only, never a password or token hash. The newsletter
  // column is the real subscription (confirmed, waiting to confirm, or unsubscribed), not the box ticked at sign-up.
  const memberView = (m) => ({
    id: m.id, name: m.name, email: m.email, status: m.status, created_at: m.created_at, last_seen_at: m.last_seen_at, verified_at: m.verified_at,
    comment_count: m.comment_count, newsletterStatus: store.subscribers.getByEmail(m.email)?.status || "",
  });
  function membersPage(c, { q = "", status = "", pageNo = 1, resetLink = null, error = "" } = {}, httpStatus = 200) {
    const per = 50;
    const { rows, total } = store.members.list({ q, status, limit: per, offset: (pageNo - 1) * per });
    return page(c, "members.njk", { nav: "members", rows: rows.map(memberView), total, all: store.members.count(), q, status, pageNo, pages: Math.max(1, Math.ceil(total / per)), resetLink, error }, httpStatus);
  }
  app.get(`${A}/members`, (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const q = String(c.req.query("q") || "").slice(0, 100);
    const status = ["active", "banned"].includes(c.req.query("status")) ? c.req.query("status") : "";
    return membersPage(c, { q, status, pageNo: clampInt(c.req.query("page"), 1, 1e5, 1) });
  });
  app.post(`${A}/members/:id{[0-9]+}/:action{ban|unban|delete|reset}`, async (c) => {
    const actor = c.get("user");
    if (!can.settings(actor)) return deny(c);
    await form(c);
    const m = store.members.get(Number(c.req.param("id")));
    if (!m) return c.redirect(`${A}/members`);
    const action = c.req.param("action");
    if (action === "ban" || action === "unban") {
      store.members.setStatus(m.id, action === "ban" ? "banned" : "active");
      ctx.invalidate();
      audit(`reader ${action === "ban" ? "blocked" : "unblocked"}: member ${m.id} by staff ${actor.id}`);
      return c.redirect(`${A}/members?ok=${action === "ban" ? "banned" : "unbanned"}`);
    }
    if (action === "delete") {
      store.members.remove(m.id);
      ctx.invalidate();
      audit(`reader deleted: member ${m.id} by staff ${actor.id}`);
      return c.redirect(`${A}/members?ok=deleted`);
    }
    // A single-use reset link (valid 1 hour, stored hashed), never a password. It is emailed to the reader;
    // only when the email can't go out is the link shown here, to pass on privately. Only for a reader whose
    // account is active and whose email is verified: the link proves the mailbox, so it must not be handed out
    // for an address nobody has confirmed.
    if (m.status !== "active" || !m.verified_at) return membersPage(c, { error: "A reset link can only be made for a reader who is active and has verified their email." }, 400);
    const started = store.members.startReset(m.email);
    if (!started?.token) return membersPage(c, { error: "A reset link was made for this reader in the last 15 minutes. Wait a little, then try again." }, 429);
    const link = `${ctx.site().blogUrl}/reset/${started.token}/`;
    audit(`member password reset link created: member ${m.id} by staff ${actor.id}`);
    if (ctx.mailer.ready() && (await ctx.mailer.sendPasswordReset(m, link))) return c.redirect(`${A}/members?ok=resetsent`);
    // Not sent (the site's email isn't set up, or the send failed): show the link, once.
    return membersPage(c, { resetLink: { member: m, url: link, failed: ctx.mailer.ready() } });
  });
  // The reader list is exported only by a POST with the form token (a link on another page can't start it), at most
  // 10 times an hour per person, and every export is logged. It is read in pages of 500, by id (never by offset, so a
  // sign-up, delete or block in the middle of a download can't skip or repeat a row), and streamed.
  const memberExportLimit = createRateLimiter({ limit: 10, windowMs: 3_600_000 });
  app.get(`${A}/members.csv`, (c) => c.redirect(`${A}/members`));
  app.post(`${A}/members.csv`, async (c) => {
    const user = c.get("user");
    if (!can.settings(user)) return deny(c);
    await form(c);
    if (!memberExportLimit.take(`u:${user.id}`)) return c.text("Too many exports in the last hour. Try again later.", 429);
    audit(`reader list exported by user ${user.id}`);
    const enc = new TextEncoder();
    const line = (r) => `${r.map(csvCell).join(",")}\r\n`;
    const PAGE = 500;
    const next = ctx.db.prepare(`SELECT m.id, m.name, m.email, m.status, m.created_at, m.verified_at,
        (SELECT COUNT(*) FROM comments c WHERE c.member_id = m.id) AS comment_count,
        (SELECT s.status FROM subscribers s WHERE s.email = lower(m.email)) AS newsletter_status
      FROM members m WHERE m.id < :before ORDER BY m.id DESC LIMIT :limit`);
    let before = Number.MAX_SAFE_INTEGER;
    let started = false;
    const body = new ReadableStream({
      pull(controller) {
        if (!started) {
          started = true;
          controller.enqueue(enc.encode(line(["name", "email", "status", "email_verified_at", "newsletter", "joined", "comments"])));
          return;
        }
        const rows = next.all({ before, limit: PAGE });
        if (rows.length) {
          before = rows[rows.length - 1].id;
          controller.enqueue(enc.encode(rows.map((m) => line([m.name, m.email, m.status, m.verified_at || "", m.newsletter_status || "none", m.created_at, m.comment_count])).join("")));
        }
        if (rows.length < PAGE) controller.close();
      },
    });
    return c.body(body, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="members.csv"', "Cache-Control": "no-store" });
  });

  // ---------- Menus ----------

  // Menu items are picked from a list (Home, categories, pages...) or typed as a web address.
  const cleanLabel = (v) => plainLine(v, 40);
  // A path on this site (one leading slash, never //host or a backslash) or a full http(s) address, at most 500 characters.
  // A valid address that is longer is refused (and listed in `tooLong`), never cut short into a different one.
  const cleanUrl = (v, tooLong = null) => {
    const u = typeof v === "string" ? v.trim() : "";
    if (u.length > 500 && isHttpUrl(u)) {
      tooLong?.push(u.slice(0, 60));
      return "";
    }
    return siteLink(u) ? u : "";
  };
  const parseJson = (v, fallback) => {
    try {
      if (String(v ?? "").length > 200_000) return fallback;
      return JSON.parse(String(v ?? ""));
    } catch {
      return fallback;
    }
  };
  function menuTargets() {
    const site = ctx.site();
    return [
      { group: "Main pages", items: [{ label: "Home", url: site.url.home }, { label: "Latest posts", url: site.url.latest }, { label: "Search", url: site.url.search }] },
      { group: "Categories", items: site.categories.map((k) => ({ label: k.name, url: site.url.category(k.slug) })) },
      { group: "Pages", items: site.pages },
      { group: "Tags", items: store.tags.list().filter((t) => t.post_count).slice(0, 40).map((t) => ({ label: t.name, url: site.url.tag(t.slug) })) },
      { group: "Reader accounts", items: [{ label: "Sign in", url: site.url.signin }, { label: "Create account", url: site.url.signup }] },
      { group: "Other", items: [{ label: "RSS feed", url: site.url.rss }] },
    ].filter((g) => g.items.length);
  }
  const menusPage = (c, extra = {}, status = 200) => {
    const site = ctx.site();
    const s = safeSettings();
    return page(c, "menus.njk", {
      nav: "menus",
      title: "Menus",
      navMode: s.nav_mode === "custom" || (s.nav_mode !== "auto" && s.nav_menu.trim()) ? "custom" : "auto",
      footerMode: s.footer_mode === "custom" || (s.footer_mode !== "auto" && s.footer_menu.trim()) ? "custom" : "auto",
      menuData: {
        nav: s.nav_items?.length ? s.nav_items : site.nav.map((i) => ({ label: i.label, url: i.url, children: (i.children || []).map((k) => ({ label: k.label, url: k.url })) })),
        footer: s.footer_cols?.length ? s.footer_cols : site.footer,
        autoNav: site.autoNav,
        autoFooter: site.autoFooter,
        targets: menuTargets(),
      },
      ...extra,
    }, status);
  };
  app.get(`${A}/menus`, (c) => (can.settings(c.get("user")) ? menusPage(c) : deny(c)));
  app.post(`${A}/menus`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const body = await form(c);
    const tooLong = [];
    const navItems = (Array.isArray(parseJson(body.nav_json, [])) ? parseJson(body.nav_json, []) : []).slice(0, 12).map((i) => ({
      label: cleanLabel(i?.label),
      url: cleanUrl(i?.url, tooLong),
      children: (Array.isArray(i?.children) ? i.children : []).slice(0, 12).map((k) => ({ label: cleanLabel(k?.label), url: cleanUrl(k?.url, tooLong) })).filter((k) => k.label && k.url),
    })).filter((i) => i.label && i.url);
    const footerCols = (Array.isArray(parseJson(body.footer_json, [])) ? parseJson(body.footer_json, []) : []).slice(0, 6).map((col) => ({
      title: cleanLabel(col?.title),
      links: (Array.isArray(col?.links) ? col.links : []).slice(0, 12).map((l) => ({ label: cleanLabel(l?.label), url: cleanUrl(l?.url, tooLong) })).filter((l) => l.label && l.url),
    })).filter((col) => col.title && col.links.length);
    const navMode = body.nav_mode === "custom" ? "custom" : "auto";
    const footerMode = body.footer_mode === "custom" ? "custom" : "auto";
    const errors = tooLong.slice(0, 3).map((u) => `A link is longer than 500 characters (“${u}…”). Use a shorter address.`);
    if (navMode === "custom" && !navItems.length) errors.push("Add at least one item to the main menu, or choose “Show my categories automatically”.");
    if (footerMode === "custom" && !footerCols.length) errors.push("Add at least one footer column with a title and a link, or choose “Fill it automatically”.");
    if (errors.length) return menusPage(c, { errors }, 400);
    store.settings.set({ nav_mode: navMode, nav_items: navItems, footer_mode: footerMode, footer_cols: footerCols, nav_menu: "", footer_menu: "" });
    return c.redirect(`${A}/menus?ok=menus`);
  });

  // ---------- Sponsor banners ----------

  const dayOf = (iso) => (iso ? isoToLocalInput(iso, ctx.site().tz).slice(0, 10) : "");
  const pct = (clicks, views) => (views ? `${((clicks / views) * 100).toFixed(clicks / views < 0.1 ? 2 : 1)}%` : "–");
  const adCard = (a) => ({
    ...a,
    status: adStatus(a),
    image: a.image_id ? mediaItem(store.media.get(a.image_id) || { id: 0, path: "", variants: {} }) : null,
    placeNames: a.places.map((k) => place(k)?.name).filter(Boolean),
    ctr: pct(a.clicks || 0, a.views || 0),
    startsOn: dayOf(a.starts_at),
    endsOn: dayOf(a.ends_at),
  });
  app.get(`${A}/ads`, (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const live = store.ads.live();
    const s = safeSettings();
    const off = s.ads_places_off || [];
    const ads = store.ads.list(30).map(adCard).map((a) => ({ ...a, placesOn: a.places.filter((k) => !off.includes(k)).length }));
    return page(c, "ads.njk", {
      nav: "ads",
      title: "Ads",
      ads,
      places: Object.entries(AD_PLACES).map(([key, pl], i) => ({ key, n: i + 1, ...pl, running: (live[key] || []).length, on: !off.includes(key) })),
      off,
      s,
      contactError: c.req.query("error") === "contact",
    });
  });

  // The master switch for every banner and empty box, and one switch per place.
  app.post(`${A}/ads/switch`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const on = (await form(c)).ads_enabled === "1";
    store.settings.set({ ads_enabled: on });
    return c.redirect(`${A}/ads?ok=${on ? "adson" : "adsoff"}`);
  });
  app.post(`${A}/ads/places/:key{[a-z_]+}/:state{on|off}`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    await form(c);
    const key = c.req.param("key");
    if (!place(key)) return missing(c);
    const off = new Set(store.settings.get("ads_places_off") || []);
    if (c.req.param("state") === "off") off.add(key);
    else off.delete(key);
    store.settings.set({ ads_places_off: [...off] });
    return c.redirect(`${A}/ads?ok=${c.req.param("state") === "off" ? "placeoff" : "placeon"}#places-h`);
  });
  const adForm = (c, ad, extra = {}, status = 200) => {
    const media = (id) => {
      const m = id ? store.media.get(id) : null;
      return m ? { id: m.id, url: ctx.site().url.media(m.path), width: m.width, height: m.height } : null;
    };
    return page(c, "ad.njk", {
      nav: "ads",
      title: ad?.id ? `Banner: ${ad.name}` : "New banner",
      ad: ad ? { ...ad, startsOn: ad.startsOn ?? dayOf(ad.starts_at), endsOn: ad.endsOn ?? dayOf(ad.ends_at) } : { active: true, places: [] },
      image: media(ad?.image_id),
      mobileImage: media(ad?.mobile_image_id),
      places: Object.entries(AD_PLACES).map(([key, pl], i) => ({ key, n: i + 1, ...pl, on: !(store.settings.get("ads_places_off") || []).includes(key) })),
      adsEnabled: store.settings.get("ads_enabled"),
      totals: ad?.id ? store.ads.totals(ad.id) : null,
      daily: ad?.id ? store.ads.daily(ad.id, 30).map((d) => ({ ...d, ctr: pct(d.clicks, d.views) })) : [],
      ...extra,
    }, status);
  };
  function adInput(body) {
    const tz = ctx.site().tz;
    const errors = [];
    const places = [...new Set([].concat(body.places || []).filter((k) => place(k)))];
    const image = store.media.get(clampInt(body.image_id, 1, 1e12, 0));
    const mobile = store.media.get(clampInt(body.mobile_image_id, 1, 1e12, 0));
    const startsOn = String(body.starts_on || "").trim();
    const endsOn = String(body.ends_on || "").trim();
    const values = {
      // One line: a new line in a name would reach the aria-label and the confirm box.
      name: plainLine(body.name, 80),
      url: String(body.url || "").trim().slice(0, 1000),
      alt: plainLine(body.alt, 200),
      image_id: image && image.kind !== "file" ? image.id : null,
      mobile_image_id: mobile && mobile.kind !== "file" ? mobile.id : null,
      places,
      starts_at: /^\d{4}-\d{2}-\d{2}$/.test(startsOn) ? localInputToIso(`${startsOn}T00:00`, tz) : null,
      ends_at: /^\d{4}-\d{2}-\d{2}$/.test(endsOn) ? localInputToIso(`${endsOn}T23:59`, tz) : null,
      active: body.active === "1",
      startsOn,
      endsOn,
    };
    if (!values.name) errors.push("Give the banner a name, such as the sponsor’s name.");
    if (!isHttpUrl(values.url)) errors.push("“Where the click goes” must be a full web address starting with https://");
    if (!values.image_id) errors.push("Choose the banner picture.");
    if (!places.length) errors.push("Tick at least one place where the banner should appear.");
    if (values.starts_at && values.ends_at && values.ends_at < values.starts_at) errors.push("The end date is before the start date.");
    if (!values.alt) values.alt = values.name;
    return { values, errors };
  }
  app.get(`${A}/ads/new`, (c) => (can.settings(c.get("user")) ? adForm(c, null) : deny(c)));
  app.get(`${A}/ads/:id{[0-9]+}`, (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const ad = store.ads.get(Number(c.req.param("id")));
    return ad ? adForm(c, ad) : missing(c);
  });
  app.post(`${A}/ads`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const { values, errors } = adInput(await form(c));
    if (errors.length) return adForm(c, values, { errors }, 400);
    const ad = store.ads.save(values);
    return c.redirect(`${A}/ads/${ad.id}?ok=created`);
  });
  app.post(`${A}/ads/:id{[0-9]+}`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const id = Number(c.req.param("id"));
    if (!store.ads.get(id)) return missing(c);
    const { values, errors } = adInput(await form(c));
    if (errors.length) return adForm(c, { ...values, id }, { errors }, 400);
    store.ads.save(values, id);
    return c.redirect(`${A}/ads/${id}?ok=saved`);
  });
  app.post(`${A}/ads/:id{[0-9]+}/:action{pause|resume|delete}`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    await form(c);
    const id = Number(c.req.param("id"));
    const action = c.req.param("action");
    if (action === "delete") store.ads.remove(id);
    else store.ads.setActive(id, action === "resume");
    return c.redirect(`${A}/ads?ok=${action === "delete" ? "deleted" : action === "pause" ? "paused" : "resumed"}`);
  });
  app.post(`${A}/ads/settings`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const body = await form(c);
    const contact = String(body.ads_contact_url || "").trim();
    // A path on this site, a full web address, or mailto: with one plain address (no ?subject=, no list of addresses).
    if (contact && !siteLink(contact) && !(contact.startsWith("mailto:") && isEmail(contact.slice(7)))) {
      return c.redirect(`${A}/ads?error=contact`);
    }
    store.settings.set({ ads_empty: body.ads_empty === "show" ? "show" : "hide", ads_contact_url: contact });
    return c.redirect(`${A}/ads?ok=saved`);
  });

  // ---------- Staff ----------

  // Social links from the links editor: a network and a username or link per row.
  function readLinks(body, max = 12) {
    // Only the first rows (a few more than will be kept) are read, so a huge form can't make this do unbounded work.
    const rows = max * 3;
    const nets = [].concat(body.link_network ?? []).slice(0, rows);
    const urls = [];
    const bad = [];
    [].concat(body.link_url ?? []).slice(0, rows).forEach((v, i) => {
      const typed = String(v ?? "").trim();
      if (!typed) return;
      const url = linkFrom(nets[i], typed);
      if (url) urls.push(url);
      else bad.push(`“${typed.slice(0, 60)}” isn’t a link. Paste the full address, or pick the network and type just the username.`);
    });
    return { urls: [...new Set(urls)].slice(0, max), bad };
  }

  // Staff rules (the rank table is in src/store/roles.js): you may change another staff member only as the owner or
  // when your rank is higher. Pages below show the forms only to people who may use them; every route checks again.
  const mayManage = (actor, target) => Boolean(target && target.id !== actor.id && can.users(actor) && outranksTarget(actor, target));
  // Plain text from a form field; repeated fields (arrays) and files count as empty.
  const text = (v, max) => cleanText(typeof v === "string" ? v : "", max);
  const oneLine = (v, max) => text(v, max).replace(/\s+/g, " ");

  // Step-up checks (a password, or a second-step code) sit behind one limit per session: 5 failures in 15 minutes.
  // It is the session's, not the person's, so someone holding a stolen session can't use up the real person's tries.
  // Take a try first, check, and clear the count only when the whole action went through.
  const stepKey = (c) => `step:${c.get("session").id}`;
  const takeStep = (c) => limiters.step.take(stepKey(c));
  const TOO_MANY = "Too many wrong tries. Wait 15 minutes and try again.";
  // Throws an error with code "BUSY" when too many passwords are being checked at once (see busyAnswer).
  const checkPassword = async (user, password) => {
    if (typeof password !== "string" || !password.length || password.length > MAX_PASSWORD) return false;
    try {
      return Boolean(await store.users.authenticate(user.email, password));
    } catch (err) {
      if (err?.code === "PASSWORD_EXPIRED") return false; // an expired temporary password proves nothing
      throw err;
    }
  };
  // An authenticator code (or, unless totpOnly, a recovery code). A wrong code here only counts toward the step-up
  // limit above; it never adds to the sign-in lock on the account.
  function checkSecondFactor(user, code, { totpOnly = false } = {}) {
    const typed = clip(code, 32).trim();
    return !totpOnly && isRecoveryCode(typed) ? store.users.useRecoveryCode(user.id, typed) : store.users.verifyTotp(user.id, typed, { ignoreLock: true });
  }
  // The answer when the site is busy hashing passwords: a plain 503 (JSON for the api routes).
  const busyAnswer = (c) => (c.req.path.startsWith(`${A}/api/`) ? c.json({ error: BUSY }, 503) : page(c, "error.njk", { title: "Busy", message: BUSY }, 503));
  // Wraps a route so a "BUSY" error from the password hashing becomes that answer.
  const unlessBusy = (handler) => async (c) => {
    try {
      return await handler(c);
    } catch (err) {
      if (isBusy(err)) return busyAnswer(c);
      throw err;
    }
  };
  // Staff passwords follow the same rule as readers' (a common-password list, no name or email, length).
  const staffPasswordProblem = (password, who) => passwordProblem(password, { email: who.email, name: who.name }, "password");
  // A staff name may not look the same as any reader's name (the reader side refuses staff names the same way).
  const READER_NAME_TAKEN = "A reader already uses that name. Choose another.";
  const readerUsesName = (name) => {
    const key = nameKey(name);
    return Boolean(key) && ctx.db.prepare("SELECT name FROM members").all().some((r) => nameKey(r.name) === key);
  };
  // A secret being set up for two-step sign-in lives with the session for 15 minutes at most, then it is dropped.
  const PENDING_MS = 15 * 60_000;
  const pendingSince = new Map();
  const pendingSecret = (session) => {
    if (!session.totp_pending) return null;
    const t = pendingSince.get(session.id);
    if (t && Date.now() - t < PENDING_MS) return session.totp_pending;
    pendingSince.delete(session.id);
    store.users.setPendingSecret(session.id, null);
    session.totp_pending = null;
    return null;
  };

  async function saveProfile(c, target, body, actor) {
    const errors = [];
    const self = target.id === actor.id;
    const fields = {
      name: oneLine(body.name, 100),
      email: oneLine(body.email, 200),
      slug: slugify(text(body.slug, 80) || text(body.name, 100)),
      job_title: oneLine(body.job_title, 100),
      bio: text(body.bio, 1000),
      photo_id: null,
    };
    // A profile picture must be an image. One that isn't already this person's is accepted only from an editor or
    // above, from its uploader, or when it is already shown publicly (so a media id can't be used to claim a stranger's file).
    const wantedPhoto = clampInt(body.photo_id, 1, 1e12, 0);
    const photo = wantedPhoto ? store.media.get(wantedPhoto) : null;
    if (photo?.kind === "image") {
      if (wantedPhoto === target.photo_id || RANK[actor.role] >= RANK.editor || photo.uploaded_by === actor.id || store.media.isPublic(wantedPhoto)) fields.photo_id = wantedPhoto;
      else errors.push("One picture or file isn’t yours to use.");
    }
    const links = readLinks(body, 10);
    fields.links = links.urls;
    errors.push(...links.bad);
    if (!fields.name) errors.push("Name is required.");
    else if (fields.name !== target.name && readerUsesName(fields.name)) errors.push(READER_NAME_TAKEN);
    if (!isEmail(fields.email)) errors.push("Enter a valid email.");
    const other = store.users.getByEmail(fields.email);
    if (other && other.id !== target.id) errors.push("Another account uses that email.");
    if (!isSlug(fields.slug)) errors.push("Profile URL must be lowercase words joined by hyphens.");
    else if (store.users.getBySlug(fields.slug)?.id !== target.id && store.users.getBySlug(fields.slug)) errors.push("Another author uses that profile URL.");
    if (!self) {
      // Role and status: only for someone you outrank, and only to a role below your own (the owner may give any).
      if (typeof body.role === "string" && body.role !== target.role) {
        if (!ROLES.includes(body.role)) errors.push("Unknown role.");
        else if (!assignableRoles(actor).includes(body.role)) errors.push(body.role === "owner" ? "The owner role can’t be given to someone else here." : "You can only give a role below your own.");
        else fields.role = body.role;
      }
      // Exactly "active" or "suspended": anything else is refused, so a stale form can't undo a suspension.
      if (typeof body.status === "string") {
        if (body.status !== "active" && body.status !== "suspended") errors.push("Unknown status.");
        else fields.status = body.status;
      }
    }
    // Changing a login email, suspending someone, or giving someone a lower role needs your own current password
    // (yours or, for someone else, the administrator's).
    const emailChanged = fields.email !== target.email;
    const suspending = fields.status === "suspended" && target.status !== "suspended";
    const demoting = Boolean(fields.role) && RANK[fields.role] < RANK[target.role];
    if ((emailChanged || suspending || demoting) && !errors.length) {
      if (!takeStep(c)) errors.push(TOO_MANY);
      else if (!(await checkPassword(actor, self ? body.current_password : body.actor_password))) errors.push(emailChanged ? "Enter your own current password to change the email." : "Enter your own password to suspend someone or give them a lower role.");
    }
    if (errors.length) return errors;
    try {
      // The store checks the rank rules again (and keeps at least one active owner).
      store.users.update(target.id, fields, { actor });
    } catch (err) {
      return [String(err.message || "That change isn’t allowed.")];
    }
    if (target.slug !== fields.slug) {
      try {
        store.redirects.save({ from_path: `${config.basePath}/authors/${target.slug}/`, to_path: `${config.basePath}/authors/${fields.slug}/`, source: "auto" });
      } catch {
        // an address that would loop, or that an administrator already owns, is left alone
      }
    }
    if (emailChanged || suspending || demoting) limiters.step.reset(stepKey(c));
    if (emailChanged) {
      // The store signs the account out everywhere on an email change; the person making their own change stays signed in on a fresh session.
      if (self) await startSession(c, store.users.get(target.id));
      else store.users.endAllSessions(target.id);
      audit(`login email changed: user ${target.id} by ${actor.id}`);
    }
    // A suspended or re-roled account starts over: its sessions end now, so nothing revives later.
    if (fields.status === "suspended" || (fields.role && fields.role !== target.role)) {
      store.users.endAllSessions(target.id);
      audit(`sessions ended: user ${target.id} (${fields.status === "suspended" ? "suspended" : `role ${target.role} to ${fields.role}`}) by ${actor.id}`);
    }
    return [];
  }

  const userPage = (c, target, extra = {}, status = 200) => {
    const site = ctx.site();
    const actor = c.get("user");
    const photo = store.media.get(target?.photo_id);
    const roles = assignableRoles(actor);
    if (target && !roles.includes(target.role)) roles.push(target.role);
    // The sessions list is for your own profile only. Each row gets a handle the page can post back (never the stored id).
    const self = Boolean(target) && target.id === actor.id;
    const current = c.get("session")?.id;
    const sessions = self ? store.users.listSessions(target.id).map((s) => ({ handle: sessionHandle(s.id), current: s.id === current, created_at: s.created_at, last_seen_at: s.last_seen_at, ip: s.ip, user_agent: s.user_agent })) : [];
    return page(c, "user.njk", { nav: target?.id === actor.id ? "profile" : "users", target, twoStep: target ? store.users.twoStepStatus(target.id) : null, canManage: mayManage(actor, target), canResetTwoStep: mayResetTwoStep(actor, target), linkRows: linkRows(Array.isArray(target?.links) ? target.links : []), photo: photo ? { id: photo.id, url: site.url.media(photo.path) } : null, roles, minPassword: MIN_PASSWORD, sessions, ...extra }, status);
  };
  const sessionHandle = (id) => ctx.secrets.hmac(`session-handle:${id}`).slice(0, 24);

  app.get(`${A}/users`, (c) => (can.users(c.get("user")) ? usersPage(c) : deny(c)));
  function usersPage(c, extra = {}, status = 200) {
    return page(c, "users.njk", { nav: "users", users: store.users.list(), twoStepRule: twoStepRule(), canSetRule: can.owner(c.get("user")), ...extra }, status);
  }
  // The owner decides who must use two-step sign-in. It can't be required while the owner doesn't use it, so the owner can't lock themselves out.
  app.post(`${A}/users/two-step-rule`, async (c) => {
    const actor = c.get("user");
    if (!can.owner(actor)) return deny(c);
    const body = await form(c);
    const rule = body.rule;
    if (rule !== "off" && rule !== "admins" && rule !== "staff") return usersPage(c, { ruleError: "Choose one of the options." }, 400);
    if (rule !== "off" && !actor.twoStep) return usersPage(c, { ruleError: "Turn on two-step sign-in for your own account first (under Your profile), then require it for others." }, 400);
    store.settings.set({ require_two_step: rule });
    audit(`two-step sign-in rule set to "${rule}" by ${actor.id}`);
    return c.redirect(`${A}/users?ok=twosteppolicy`);
  });
  app.get(`${A}/users/new`, (c) => (can.users(c.get("user")) ? userPage(c, null, { isNew: true }) : deny(c)));
  app.post(`${A}/users/new`, unlessBusy(async (c) => {
    const actor = c.get("user");
    if (!can.users(actor)) return deny(c);
    const body = await form(c);
    const errors = [];
    const draft = { name: oneLine(body.name, 100), email: oneLine(body.email, 200), job_title: oneLine(body.job_title, 100), role: typeof body.role === "string" ? body.role : "author" };
    const role = draft.role;
    if (role === "owner" || !ROLES.includes(role)) errors.push("Choose a role.");
    else if (!assignableRoles(actor).includes(role)) errors.push("You can only give a role below your own.");
    if (!draft.name) errors.push("Name is required.");
    else if (readerUsesName(draft.name)) errors.push(READER_NAME_TAKEN);
    if (!isEmail(draft.email)) errors.push("Enter a valid email.");
    else if (store.users.getByEmail(draft.email)) errors.push("Another account uses that email.");
    // One string, read once: a repeated field can't turn into an array here.
    const password = typeof body.password === "string" ? body.password : "";
    const problem = staffPasswordProblem(password, draft);
    if (problem) errors.push(problem);
    if (errors.length) return userPage(c, null, { isNew: true, errors, draft }, 400);
    // The new person must choose their own password the first time they sign in, and this first one expires after 7 days.
    const user = await store.users.create({ email: draft.email, password, name: draft.name, role, job_title: draft.job_title }, { mustChange: true, actor });
    audit(`staff account created: user ${user.id} (${role}) by ${actor.id}`);
    return c.redirect(`${A}/users/${user.id}?ok=created`);
  }));
  app.get(`${A}/users/:id{[0-9]+}`, (c) => {
    const actor = c.get("user");
    const target = store.users.get(Number(c.req.param("id")));
    if (!target) return missing(c);
    if (target.id !== actor.id && !can.users(actor)) return deny(c);
    return userPage(c, target);
  });
  app.get(`${A}/profile`, (c) => c.redirect(`${A}/users/${c.get("user").id}`));
  app.post(`${A}/users/:id{[0-9]+}`, unlessBusy(async (c) => {
    const actor = c.get("user");
    const target = store.users.get(Number(c.req.param("id")));
    if (!target) return missing(c);
    if (target.id !== actor.id && !mayManage(actor, target)) return deny(c);
    const body = await form(c);
    const errors = await saveProfile(c, target, body, actor);
    // What was typed goes back under "draft"; the stored person (and their role) stays what it is.
    if (errors.length) return userPage(c, target, { errors, draft: { name: oneLine(body.name, 100), slug: text(body.slug, 80), email: oneLine(body.email, 200), job_title: oneLine(body.job_title, 100), bio: text(body.bio, 1000) }, linkRows: linkRows(readLinks(body, 10).urls) }, 400);
    return c.redirect(`${A}/users/${target.id}?ok=saved`);
  }));
  app.post(`${A}/users/:id{[0-9]+}/password`, unlessBusy(async (c) => {
    const actor = c.get("user");
    const target = store.users.get(Number(c.req.param("id")));
    if (!target) return missing(c);
    if (target.id !== actor.id && !mayManage(actor, target)) return deny(c);
    const body = await form(c);
    const self = target.id === actor.id;
    const errors = [];
    const password = typeof body.password === "string" ? body.password : "";
    const problem = staffPasswordProblem(password, target);
    if (problem) errors.push(problem);
    if (password !== body.password_confirm) errors.push("The two new passwords don’t match.");
    // Your own current password is always needed: for yours, and to set someone else's (plus your code, if you use two-step).
    if (!errors.length) {
      if (!takeStep(c)) errors.push(TOO_MANY);
      else if (!(await checkPassword(actor, self ? body.current_password : body.actor_password))) errors.push(self ? "Your current password is wrong." : "Your own password is wrong.");
      else if (!self && actor.twoStep && !checkSecondFactor(actor, body.code)) errors.push("Enter a code from your app (or a recovery code) as well.");
    }
    if (errors.length) return userPage(c, target, { passwordErrors: errors }, 400);
    limiters.step.reset(stepKey(c));
    // Setting a password signs the person out everywhere and voids any sign-in waiting for a code. A password chosen
    // by someone else is a temporary one: the person must replace it at their next sign-in, and it expires in 7 days.
    try {
      await store.users.setPassword(target.id, password, { actor });
    } catch (err) {
      if (err?.code === "SAME_PASSWORD" || err?.code === "FORBIDDEN") return userPage(c, target, { passwordErrors: [String(err.message)] }, 400);
      throw err;
    }
    if (self) await startSession(c, target);
    audit(self ? `password changed: user ${target.id}` : `password set by an administrator: user ${target.id} by ${actor.id}`);
    notifyStaff(target, self ? "Your password was changed" : "A new temporary password was set for you", self
      ? [`The password for your account at ${ctx.site().title} was just changed.`, "If that wasn’t you, ask an administrator to reset it straight away."]
      : [`An administrator set a new temporary password for your account at ${ctx.site().title}. They will tell you what it is.`, "You will be asked to choose your own password when you sign in. The temporary one stops working after 7 days."]);
    return c.redirect(`${A}/users/${target.id}?ok=password`);
  }));
  // Signs your account out of every other browser and device.
  app.post(`${A}/account/sessions/end-others`, async (c) => {
    const user = c.get("user");
    await form(c);
    store.users.endOtherSessions(user.id, c.get("session").id);
    audit(`other sessions ended by the account holder: user ${user.id}`);
    return c.redirect(`${A}/users/${user.id}?ok=othersout`);
  });
  // Signs out one device from the list on your own profile (not the one in use: Sign out does that).
  app.post(`${A}/account/sessions/:handle{[0-9a-f]{24}}/end`, async (c) => {
    const user = c.get("user");
    await form(c);
    const found = store.users.listSessions(user.id).find((s) => sessionHandle(s.id) === c.req.param("handle"));
    if (found && found.id !== c.get("session").id) {
      store.users.revokeSession(user.id, found.id);
      audit(`one session ended by the account holder: user ${user.id}`);
    }
    return c.redirect(`${A}/users/${user.id}?ok=sessionended`);
  });
  // ---------- Two-step sign-in: setup and management (your own account) ----------

  const twoStepPage = (c, extra = {}, status = 200) => {
    const user = c.get("user");
    const session = c.get("session");
    const state = store.users.twoStepStatus(user.id);
    let setup = null;
    // The secret being set up stays with this session until a correct code confirms it, for 15 minutes at most.
    // Opening this page never creates one: that takes the "Start" button (a POST).
    const secret = pendingSecret(session);
    if (!state.enabled && !extra.codes && secret) {
      const url = otpauthUrl({ issuer: ctx.site().title, account: user.email, secret });
      setup = { secret: secret.match(/.{1,4}/g).join(" "), qr: renderSVG(url, { border: 2, pixelSize: 6, whiteColor: "#FFFFFF", blackColor: "#1A1D21" }) };
    }
    // The recovery codes as one block of text, for the Copy and Download buttons.
    const codesText = extra.codes ? extra.codes.join("\n") : "";
    const codesFile = extra.codes ? `Recovery codes for ${ctx.site().title} (${user.email})\n\n${codesText}\n\nEach code works once. Keep them somewhere safe.\n` : "";
    return page(c, "two-step.njk", { nav: "profile", state, setup, codesText, codesFile, recoveryReset: Boolean(user.recoveryCodesReset) && !extra.codes, required: mustUseTwoStep(user), ...extra }, status);
  };
  // Every change needs the current password (checkPassword, above); turning it off or replacing codes also needs a code.
  // All of these share the per-session step-up limit: 5 wrong tries in 15 minutes. Each one is logged and the
  // account holder is emailed, so a change nobody asked for leaves a trace.

  app.get(`${A}/account/two-step`, (c) => twoStepPage(c));
  // Starting the setup is an explicit POST: it creates the secret that the QR code shows.
  app.post(`${A}/account/two-step/start`, async (c) => {
    const user = c.get("user");
    const session = c.get("session");
    await form(c);
    if (!store.users.twoStepStatus(user.id).enabled && !pendingSecret(session)) {
      store.users.setPendingSecret(session.id, newSecret());
      for (const [id, t] of pendingSince) if (Date.now() - t > PENDING_MS) pendingSince.delete(id);
      pendingSince.set(session.id, Date.now());
    }
    return c.redirect(`${A}/account/two-step`);
  });
  app.post(`${A}/account/two-step/enable`, unlessBusy(async (c) => {
    const user = c.get("user");
    const session = c.get("session");
    const body = await form(c);
    if (store.users.twoStepStatus(user.id).enabled) return c.redirect(`${A}/account/two-step`);
    const secret = pendingSecret(session);
    if (!secret) return twoStepPage(c, { error: "The setup expired. Press “Start setup” to get a new QR code." }, 400);
    if (!takeStep(c)) return twoStepPage(c, { error: TOO_MANY }, 429);
    if (!(await checkPassword(user, body.password))) return twoStepPage(c, { error: "Your password is wrong." }, 400);
    const step = matchCode(secret, clip(body.code, 32));
    if (!step) return twoStepPage(c, { error: "That code doesn’t match. Scan the QR code on this page, then type the 6-digit code your app shows now." }, 400);
    // Conditional in the store: null when it was already turned on (two tabs at once).
    const codes = store.users.enableTwoStep(user.id, secret, step);
    if (!codes) return c.redirect(`${A}/account/two-step`);
    pendingSince.delete(session.id);
    limiters.step.reset(stepKey(c));
    store.users.endOtherSessions(user.id, session.id);
    rotateSession(c);
    audit(`two-step sign-in turned on: user ${user.id}`);
    notifyStaff(user, "Two-step sign-in was turned on", [`Two-step sign-in was just turned on for your account at ${ctx.site().title}, and your other sessions were signed out.`, "If that wasn’t you, ask an administrator to turn it off and change your password."]);
    return twoStepPage(c, { codes, justEnabled: true });
  }));
  app.post(`${A}/account/two-step/codes`, unlessBusy(async (c) => {
    const user = c.get("user");
    const body = await form(c);
    if (!store.users.twoStepStatus(user.id).enabled) return c.redirect(`${A}/account/two-step`);
    if (!takeStep(c)) return twoStepPage(c, { error: TOO_MANY }, 429);
    if (!(await checkPassword(user, body.password))) return twoStepPage(c, { error: "Your password is wrong." }, 400);
    if (!checkSecondFactor(user, body.code, { totpOnly: true })) return twoStepPage(c, { error: "That code from your app isn’t right. It changes every 30 seconds." }, 400);
    limiters.step.reset(stepKey(c));
    const codes = store.users.newRecoveryCodes(user.id);
    rotateSession(c);
    audit(`recovery codes replaced: user ${user.id}`);
    notifyStaff(user, "New recovery codes were created", [`New recovery codes were just created for your account at ${ctx.site().title}. The old ones stopped working.`, "If that wasn’t you, ask an administrator to turn two-step sign-in off for your account and change your password."]);
    return twoStepPage(c, { codes });
  }));
  app.post(`${A}/account/two-step/disable`, unlessBusy(async (c) => {
    const user = c.get("user");
    const session = c.get("session");
    const body = await form(c);
    if (!store.users.twoStepStatus(user.id).enabled) return c.redirect(`${A}/account/two-step`);
    if (!takeStep(c)) return twoStepPage(c, { error: TOO_MANY }, 429);
    if (!(await checkPassword(user, body.password))) return twoStepPage(c, { error: "Your password is wrong." }, 400);
    if (!checkSecondFactor(user, body.code)) return twoStepPage(c, { error: "That code isn’t right. Use the 6-digit code from your app, or a recovery code." }, 400);
    limiters.step.reset(stepKey(c));
    store.users.disableTwoStep(user.id, { actor: user });
    store.users.endOtherSessions(user.id, session.id);
    rotateSession(c);
    audit(`two-step sign-in turned off by the account holder: user ${user.id}`);
    notifyStaff(user, "Two-step sign-in was turned off", [`Two-step sign-in was just turned off for your account at ${ctx.site().title}, and your other sessions were signed out.`, "If that wasn’t you, sign in, change your password and turn it on again."]);
    return c.redirect(`${A}/account/two-step?ok=twostepoff`);
  }));
  // For someone who lost both their phone and their recovery codes. Only for people of a lower role
  // (the owner can do it for anyone), and only with the administrator's own password (and code, when they use two-step).
  const mayResetTwoStep = (actor, target) => mayManage(actor, target);
  app.post(`${A}/users/:id{[0-9]+}/two-step/reset`, unlessBusy(async (c) => {
    const actor = c.get("user");
    const target = store.users.get(Number(c.req.param("id")));
    if (!target) return missing(c);
    if (!mayResetTwoStep(actor, target)) return deny(c);
    const body = await form(c);
    const err = (twoStepError, status = 400) => userPage(c, target, { twoStepError }, status);
    if (!takeStep(c)) return err(TOO_MANY, 429);
    if (!(await checkPassword(actor, body.password))) return err("Your password is wrong.");
    if (actor.twoStep && !checkSecondFactor(actor, body.code)) return err("Enter a code from your app (or a recovery code) as well.");
    limiters.step.reset(stepKey(c));
    store.users.disableTwoStep(target.id, { actor });
    store.users.endAllSessions(target.id);
    audit(`two-step sign-in reset: user ${target.id} (${target.email}) by ${actor.id} (${actor.email})`);
    notifyStaff(target, "Two-step sign-in was turned off for your account", [`An administrator turned off two-step sign-in for your account at ${ctx.site().title} and signed you out everywhere.`, "Sign in with your password, then turn two-step sign-in on again under Your profile. If you didn’t ask for this, tell the site owner."]);
    return c.redirect(`${A}/users/${target.id}?ok=twostepreset`);
  }));

  // Deleting, suspending or giving someone a lower role needs your own current password (a hijacked session alone can't do it).
  app.post(`${A}/users/:id{[0-9]+}/delete`, unlessBusy(async (c) => {
    const actor = c.get("user");
    if (!can.users(actor)) return deny(c);
    const body = await form(c);
    const target = store.users.get(Number(c.req.param("id")));
    if (!target || target.role === "owner" || !mayManage(actor, target)) return deny(c);
    if (!takeStep(c)) return userPage(c, target, { deleteError: TOO_MANY }, 429);
    if (!(await checkPassword(actor, body.actor_password))) return userPage(c, target, { deleteError: "Enter your own password to delete someone." }, 400);
    limiters.step.reset(stepKey(c));
    store.users.remove(target.id, actor.id, { actor });
    audit(`staff account deleted: user ${target.id} (${target.email}) by ${actor.id}`);
    return c.redirect(`${A}/users?ok=deleted`);
  }));

  // ---------- Redirects and subscribers ----------

  // The list is read a page at a time (100 rows), with a search box and a filter for who made the row.
  const redirectsPage = (c, extra = {}, status = 200) => {
    const q = plainLine(c.req.query("q"), 100);
    const source = ["admin", "auto"].includes(c.req.query("source")) ? c.req.query("source") : "";
    const pageNo = clampInt(c.req.query("page"), 1, 1e5, 1);
    const { rows, total } = store.redirects.page({ q, source, limit: 100, offset: (pageNo - 1) * 100 });
    const qs = (p) => `?${new URLSearchParams({ ...(q && { q }), ...(source && { source }), page: String(p) })}`;
    return page(c, "redirects.njk", { nav: "redirects", items: rows, total, q, source, pageNo, pages: Math.max(1, Math.ceil(total / 100)), prevUrl: qs(pageNo - 1), nextUrl: qs(pageNo + 1), ...extra }, status);
  };
  app.get(`${A}/redirects`, (c) => (can.settings(c.get("user")) ? redirectsPage(c) : deny(c)));
  app.post(`${A}/redirects`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const body = await form(c);
    const from = typeof body.from_path === "string" ? body.from_path.trim() : "";
    const to = typeof body.to_path === "string" ? body.to_path.trim() : "";
    const code = [301, 302, 410].includes(Number(body.status_code)) ? Number(body.status_code) : 301;
    const errors = [];
    // Paths are checked with isSafeLocalPath: one leading slash, never //host or a backslash, no spaces or control characters.
    if (!isSafeLocalPath(from) || /[?#]/.test(from)) errors.push("“From” must be a path starting with /, without ? or #, spaces or control characters.");
    else if (from === A || from.startsWith(`${A}/`)) errors.push("“From” can’t be in the admin area.");
    if (code !== 410 && !siteLink(to)) errors.push("“To” must be a path starting with / (not //) or a full web address.");
    if (from === to) errors.push("“From” and “To” are the same.");
    if (errors.length) return redirectsPage(c, { errors, draft: { from_path: from, to_path: to } }, 400);
    try {
      store.redirects.save({ from_path: from, to_path: code === 410 ? "" : to, status_code: code, source: "admin" });
    } catch (err) {
      if (err?.code !== "LOOP") throw err;
      return redirectsPage(c, { errors: ["That would send visitors round in a circle."], draft: { from_path: from, to_path: to } }, 400);
    }
    return c.redirect(`${A}/redirects?ok=saved`);
  });
  // Deleting a 410 clears the "gone" notice, so the web address can be used for a new post again.
  app.post(`${A}/redirects/:id{[0-9]+}/delete`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    await form(c);
    const id = Number(c.req.param("id"));
    const row = store.redirects.get(id);
    store.redirects.remove(id);
    return c.redirect(`${A}/redirects?ok=${row?.status_code === 410 ? "tombstone" : "deleted"}`);
  });

  // ---------- Newsletter: overview, writing and sending, subscribers, email settings ----------

  const N = `${A}/newsletter`;
  const blank = { id: 0, subject: "", preheader: "", body_md: "", postIds: [], status: "draft" };
  const readNewsletter = (body) => ({
    subject: plainLine(body.subject, 150),
    preheader: plainLine(body.preheader, 150),
    body_md: String(typeof body.body_md === "string" ? body.body_md : "").replace(/\r\n?/g, "\n").slice(0, 20_000),
    postIds: [].concat(body.post_ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 12),
  });
  // A newsletter still marked "sending" an hour after it started has probably stopped, so its page stops reloading by itself.
  const liveSending = (n) => n.status === "sending" && Date.now() - Date.parse(n.sent_at || n.updated_at || "") < 3_600_000;
  // Forms carry a one-time number, so a double click or a replayed request can't create the same newsletter twice.
  const newsletterNonces = new Map();
  const nonceFor = () => crypto.randomBytes(12).toString("base64url");
  const testLimit = createRateLimiter({ limit: 6, windowMs: 15 * 60_000 });
  const exportLimit = createRateLimiter({ limit: 10, windowMs: 3_600_000 });

  app.get(`${A}/subscribers`, (c) => c.redirect(`${N}/subscribers`, 301));
  // The list is exported with a button on the Subscribers page (a form post with the security token), never by following a link.
  app.get(`${A}/subscribers.csv`, (c) => c.redirect(`${N}/subscribers`, 301));
  // The newsletter preview is a whole page on the admin address: it runs in a sandbox with no scripts, forms or connections.
  const PREVIEW_HEADERS = { "Content-Security-Policy": "sandbox; default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; font-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };

  app.get(N, (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const items = store.newsletters.list();
    const counts = { ...store.subscribers.counts(), pending: store.subscribers.pendingCount() };
    return page(c, "newsletter.njk", { nav: "newsletter", counts, totals: store.newsletters.totals(), items, problems: ctx.mailer.problems(), refresh: items.some(liveSending) });
  });

  const composer = (c, n, extra = {}, status = 200) =>
    page(c, "newsletter-edit.njk", {
      nav: "newsletter",
      n,
      posts: store.posts.listPublic({ limit: 24 }),
      active: store.subscribers.count(),
      problems: ctx.mailer.problems(),
      failures: n.id ? store.newsletters.failures(n.id) : [],
      testTo: c.get("user").email,
      refresh: liveSending(n),
      nonce: n.id ? "" : nonceFor(),
      ...extra,
    }, status);
  app.get(`${N}/new`, (c) => (can.settings(c.get("user")) ? composer(c, blank) : deny(c)));
  app.get(`${N}/:id{[0-9]+}`, (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const n = store.newsletters.get(Number(c.req.param("id")));
    return n ? composer(c, n) : missing(c);
  });
  // One form, several buttons: save the draft, preview it, send a test, or send it to everyone.
  app.post(`${N}/:id{new|[0-9]+}`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const body = await form(c);
    const action = String(body.action || "save");
    const input = readNewsletter(body);
    const id = c.req.param("id") === "new" ? 0 : Number(c.req.param("id"));
    const existing = id ? store.newsletters.get(id) : blank;
    if (!existing) return missing(c);
    if (existing.status !== "draft") return c.redirect(`${N}/${id}`);
    const draft = { ...existing, ...input };
    if (action === "preview") return c.html(ctx.newsletter.render(draft).html, 200, PREVIEW_HEADERS);
    const nonce = typeof body.nonce === "string" ? body.nonce.slice(0, 40) : "";
    const fail = (error) => composer(c, draft, { error, nonce }, 400);
    if (!input.subject) return fail("Give the newsletter a subject. It’s the first thing people see in their inbox.");
    // A new newsletter is created once per form: a repeat of the same request goes to the draft that already exists.
    if (!id && nonce && newsletterNonces.has(nonce)) return c.redirect(`${N}/${newsletterNonces.get(nonce)}?ok=nlsaved`);
    const n = store.newsletters.save(input, id, c.get("user").id);
    if (!id && nonce) {
      newsletterNonces.set(nonce, n.id);
      if (newsletterNonces.size > 500) newsletterNonces.delete(newsletterNonces.keys().next().value);
    }
    if (action === "test") {
      // The test goes to your own address, or to one other member of the team. Tests are limited per person.
      const typed = typeof body.test_to === "string" ? body.test_to.trim() : "";
      const to = typed || c.get("user").email;
      if (!isEmail(to)) return composer(c, n, { error: "Enter one email address to send the test to." }, 400);
      const team = new Set([c.get("user").email, ...store.users.list().filter((u) => u.status === "active").map((u) => u.email)].map((e) => String(e).toLowerCase()));
      if (!team.has(to.toLowerCase())) return composer(c, n, { error: "A test email can go only to you or to someone on your team. To check a newsletter on another address, add that person as staff first." }, 400);
      if (!ctx.mailer.ready()) return composer(c, n, { error: "Connect your email service first, in Email settings." }, 400);
      if (!testLimit.take(`u:${c.get("user").id}`)) return composer(c, n, { error: "You’ve sent several tests in a short time. Wait a few minutes and try again." }, 429);
      try {
        await ctx.newsletter.sendTest(n, to);
      } catch (err) {
        return composer(c, n, { error: `The test email wasn’t sent. ${plainLine(err?.message, 300)}` }, 400);
      }
      console.log(`[audit] newsletter ${n.id} test email sent by user ${c.get("user").id}`);
      return c.redirect(`${N}/${n.id}?ok=testsent`);
    }
    if (action === "send") {
      if (!ctx.mailer.ready()) return composer(c, n, { error: "Connect your email service first, in Email settings." }, 400);
      if (!store.subscribers.count()) return composer(c, n, { error: "There are no subscribers to send to yet." }, 400);
      // On a new newsletter, the draft is created first and you land on it; Send is then pressed on a saved draft.
      // (The saved draft is only ever sent once: queueing needs the status to be draft.)
      if (!id) return c.redirect(`${N}/${n.id}?ok=nlreview`);
      if (!ctx.newsletter.start(n.id)) return composer(c, n, { error: ctx.newsletter.blockedReason?.() || "This newsletter can’t be sent right now." }, 400);
      console.log(`[audit] newsletter ${n.id} sent by user ${c.get("user").id}`);
      return c.redirect(`${N}/${n.id}?ok=sending`);
    }
    return c.redirect(`${N}/${n.id}?ok=nlsaved`);
  });
  // Shows the saved newsletter as subscribers will see it.
  app.get(`${N}/:id{[0-9]+}/preview`, (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    const n = store.newsletters.get(Number(c.req.param("id")));
    return n ? c.html(ctx.newsletter.render(n).html, 200, PREVIEW_HEADERS) : missing(c);
  });
  app.post(`${N}/:id{[0-9]+}/retry`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    await form(c);
    const n = store.newsletters.get(Number(c.req.param("id")));
    if (!n || n.status === "draft" || n.status === "sending") return c.redirect(N);
    // A newsletter that went out with nothing failed has nothing to send again (and its sent time must stay as it was).
    if (n.status === "sent" && !n.failed_n) return c.redirect(`${N}/${n.id}?ok=nothingtoretry`);
    if (!ctx.mailer.ready()) return composer(c, n, { error: "Connect your email service first, in Email settings." }, 400);
    // retry() answers false when sending is blocked (for example, no public Site URL yet): say so instead of claiming it started.
    if (!ctx.newsletter.retry(n.id)) return composer(c, n, { error: ctx.newsletter.blockedReason?.() || "The failed emails can’t be sent again right now." }, 400);
    console.log(`[audit] newsletter ${n.id} retry started by user ${c.get("user").id}`);
    return c.redirect(`${N}/${n.id}?ok=retrying`);
  });
  app.post(`${N}/:id{[0-9]+}/delete`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    await form(c);
    const gone = Number(c.req.param("id"));
    store.newsletters.remove(gone);
    console.log(`[audit] newsletter ${gone} deleted by user ${c.get("user").id}`);
    return c.redirect(`${N}?ok=deleted`);
  });

  const subscribersPage = (c, extra = {}, status = 200) => {
    const q = plainLine(c.req.query("q"), 100);
    const st = ["active", "pending", "unsubscribed"].includes(c.req.query("status")) ? c.req.query("status") : "";
    const pageNo = clampInt(c.req.query("page"), 1, 1e5, 1);
    const { rows, total } = store.subscribers.list({ q, status: st, limit: 100, offset: (pageNo - 1) * 100 });
    const qs = (p) => `?${new URLSearchParams({ ...(q && { q }), ...(st && { status: st }), page: String(p) })}`;
    const counts = { ...store.subscribers.counts(), pending: store.subscribers.pendingCount() };
    return page(c, "newsletter-subscribers.njk", { nav: "newsletter", items: rows, total, counts, q, status: st, pageNo, pages: Math.max(1, Math.ceil(total / 100)), prevUrl: qs(pageNo - 1), nextUrl: qs(pageNo + 1), ...extra }, status);
  };
  app.get(`${N}/subscribers`, (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    // The message is built here from counts in the address; no wording ever comes from the link.
    let notice = "";
    if (c.req.query("added") !== undefined) {
      const n = (k) => clampInt(c.req.query(k), 0, 1e6, 0);
      const added = n("added");
      const already = n("skipped");
      const unsub = n("unsub");
      const bad = n("invalid");
      notice = `Added ${added} ${added === 1 ? "person" : "people"}.`;
      if (already) notice += ` ${already} ${already === 1 ? "was" : "were"} already on the list.`;
      const waiting = n("waiting");
      if (waiting) notice += ` ${waiting} ${waiting === 1 ? "is" : "are"} still waiting to confirm by email.`;
      if (unsub) notice += ` ${unsub} unsubscribed earlier, so ${unsub === 1 ? "was" : "were"} skipped. Use “Subscribe again” on their row if they asked to come back.`;
      if (bad) notice += ` ${bad} ${bad === 1 ? "entry wasn’t a valid email address" : "entries weren’t valid email addresses"}.`;
    }
    return subscribersPage(c, { notice });
  });
  // Adds one address, or every address found in pasted text (a column copied from a spreadsheet works).
  // The text is split on spaces, new lines, commas and semicolons, and each piece is checked on its own.
  // Addresses added here are active at once (you vouch for them), and anyone who unsubscribed is never brought back.
  // Each batch gets an id and the way the people agreed is written down; both are stored with every address of the batch.
  const addLimit = createRateLimiter({ limit: 10, windowMs: 3_600_000 });
  // Takes the quote and bracket characters off both ends of one piece, in one pass over it.
  const trimEdges = (piece) => {
    let a = 0;
    let b = piece.length;
    while (a < b && `<("'`.includes(piece[a])) a++;
    while (b > a && `>)"'`.includes(piece[b - 1])) b--;
    return piece.slice(a, b);
  };
  app.post(`${N}/subscribers/add`, async (c) => {
    const user = c.get("user");
    if (!can.settings(user)) return deny(c);
    const body = await form(c);
    const text = typeof body.emails === "string" ? body.emails : "";
    const again = (addError, status = 400) => subscribersPage(c, { addError, addText: text.slice(0, 5000) }, status);
    if (text.length > 200_000) return again("That’s too much text at once (200 KB at most). Add the addresses in smaller parts.");
    if (!addLimit.take(`u:${user.id}`)) return again("You’ve added a lot of addresses in the last hour. Try again later.", 429);
    const found = new Set();
    let invalid = 0;
    for (const piece of text.split(/[\s,;]+/).slice(0, 50_000)) {
      // No address is this long: skip the piece before doing anything with it.
      if (piece.length > 320) {
        if (piece.includes("@")) invalid++;
        continue;
      }
      if (!piece.includes("@")) continue;
      const email = trimEdges(piece).toLowerCase();
      if (!email.includes("@")) continue;
      if (isEmail(email)) found.add(email);
      else invalid++;
    }
    if (!found.size) return again("No valid email addresses found. Type or paste them, one per line.");
    if (found.size > 5000) return again("That’s more than 5,000 addresses. Add them in smaller parts.");
    const name = found.size === 1 ? plainLine(body.name, 80) : "";
    const consent = plainLine(body.consent, 100);
    const batch = crypto.randomBytes(4).toString("hex");
    const source = `added by admin ${user.id}, batch ${batch}${consent ? `: ${consent}` : ""}`;
    let added = 0;
    let already = 0;
    let unsub = 0;
    let waiting = 0;
    let n = 0;
    for (const email of found) {
      const was = store.subscribers.getByEmail(email);
      let r;
      try {
        r = store.subscribers.add(email, source, { confirmed: true, name });
      } catch (err) {
        if (err?.code !== "INVALID_EMAIL") throw err;
        invalid++;
        continue;
      }
      if (r.created || (was?.status === "pending" && r.status === "active")) added++;
      else if (r.status === "unsubscribed") unsub++;
      else if (r.status === "pending") waiting++;
      else already++;
      // A big batch gives other requests a turn now and then.
      if (++n % 250 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    console.log(`[audit] subscribers added by user ${user.id}, batch ${batch}: ${added} new, ${already} already there, ${waiting} still waiting to confirm, ${unsub} unsubscribed, ${invalid} invalid; list ${crypto.createHash("sha256").update([...found].sort().join("\n")).digest("hex").slice(0, 16)}; consent: ${consent || "none given"}`);
    return c.redirect(`${N}/subscribers?added=${added}&skipped=${already}&waiting=${waiting}&unsub=${unsub}&invalid=${invalid}`);
  });
  // The export is a form post with the security token (a link or an image can't start it), recorded in the log, limited per person,
  // and read from the database in pieces of 500 as it is sent, so a long list is never all in memory at once.
  const exportSubscribers = async (c) => {
    const user = c.get("user");
    if (!can.settings(user)) return deny(c);
    await form(c);
    if (!exportLimit.take(`u:${user.id}`)) return c.text("Too many exports in the last hour. Try again later.", 429);
    console.log(`[audit] subscriber list exported by user ${user.id}: ${store.subscribers.counts().total} rows`);
    const line = (r) => `${r.map(csvCell).join(",")}\r\n`;
    const enc = new TextEncoder();
    const PAGE = 500;
    let offset = 0;
    let started = false;
    const stream = new ReadableStream({
      pull(ctrl) {
        if (!started) {
          started = true;
          ctrl.enqueue(enc.encode(line(["email", "name", "status", "source", "subscribed_at", "unsubscribed_at"])));
          return;
        }
        const rows = store.subscribers.all({ limit: PAGE, offset });
        offset += rows.length;
        if (rows.length) ctrl.enqueue(enc.encode(rows.map((s) => line([s.email, s.name, s.status, s.source, s.created_at, s.unsubscribed_at])).join("")));
        if (rows.length < PAGE) ctrl.close();
      },
    });
    return c.body(stream, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="subscribers.csv"', "Cache-Control": "no-store" });
  };
  app.post(`${N}/subscribers.csv`, exportSubscribers);
  app.post(`${A}/subscribers.csv`, exportSubscribers);
  app.get(`${N}/subscribers.csv`, (c) => c.redirect(`${N}/subscribers`));
  app.post(`${N}/subscribers/:id{[0-9]+}/:act{unsubscribe|resubscribe|delete}`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    await form(c);
    const id = Number(c.req.param("id"));
    const act = c.req.param("act");
    const row = store.subscribers.get(id);
    if (!row) return c.redirect(`${N}/subscribers`);
    // Only this explicit action brings an unsubscribed address back.
    if (act === "resubscribe" && row.status !== "unsubscribed") return c.redirect(`${N}/subscribers`);
    if (act === "unsubscribe") store.subscribers.unsubscribe(id);
    else if (act === "resubscribe") store.subscribers.resubscribe(id);
    else store.subscribers.remove(id);
    console.log(`[audit] subscriber ${id} ${act} by user ${c.get("user").id}`);
    return c.redirect(`${N}/subscribers?ok=${{ unsubscribe: "unsubscribed", resubscribe: "resubscribed", delete: "deleted" }[act]}`);
  });

  // The server settings (host, port, security, user, password) are the owner's alone. Values pinned in the environment show as locked.
  const hasSmtpPass = () => Boolean(store.settings.getSecret("smtp_pass"));
  const smtpTestLimit = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 });
  const privateSmtpAllowed = () => process.env.ALLOW_PRIVATE_SMTP === "1";
  const mailPage = (c, extra = {}, status = 200) => {
    const srv = ctx.mailer.server();
    const locks = srv.locked || {};
    const { s: given, ...rest } = extra;
    const s = { ...(given || safeSettings()), smtp_pass: "" };
    // What is really in force wins over what was saved, so the form never shows a value that isn't used.
    if (locks.host) s.smtp_host = srv.host;
    if (locks.port) s.smtp_port = srv.port;
    if (locks.secure) s.smtp_secure = srv.secure;
    if (locks.user) s.smtp_user = srv.user;
    return page(c, "newsletter-settings.njk", { nav: "newsletter", s, hasPass: hasSmtpPass(), envPass: Boolean(process.env.SMTP_HOST && process.env.SMTP_PASSWORD), locks, canServer: can.owner(c.get("user")), presets: SMTP_PRESETS, problems: ctx.mailer.problems(), me: c.get("user").email, ...rest }, status);
  };
  app.get(`${N}/settings`, (c) => (can.settings(c.get("user")) ? mailPage(c) : deny(c)));
  app.post(`${N}/settings`, async (c) => {
    const user = c.get("user");
    if (!can.settings(user)) return deny(c);
    const body = await form(c);
    const isOwner = can.owner(user);
    const saved = safeSettings();
    const errors = [];
    const values = {
      newsletter_enabled: Boolean(body.newsletter_enabled),
      newsletter_heading: plainLine(body.newsletter_heading, 120),
      newsletter_text: plainLine(body.newsletter_text, 300),
    };
    // Who the emails come from (name, address, reply address) is the owner's, like the server: a changed sender or reply address
    // applies to every email the site sends, reader verification and password reset included.
    if (isOwner) {
      Object.assign(values, {
        mail_from_name: plainLine(body.mail_from_name, 80),
        mail_from_email: plainLine(body.mail_from_email, 120).toLowerCase(),
        mail_reply_to: plainLine(body.mail_reply_to, 120).toLowerCase(),
      });
      for (const k of ["mail_from_email", "mail_reply_to"]) if (values[k] && !isEmail(values[k])) errors.push(`“${values[k].slice(0, 80)}” isn’t an email address.`);
    }
    let passCleared = false;
    if (isOwner) {
      const locks = ctx.mailer.server().locked || {};
      const preset = typeof body.smtp_preset === "string" && Object.hasOwn(SMTP_PRESETS, body.smtp_preset) ? body.smtp_preset : "";
      const p = preset && preset !== "other" ? SMTP_PRESETS[preset] : null;
      values.smtp_preset = preset;
      values.smtp_host = locks.host ? saved.smtp_host : p ? p.host : plainLine(body.smtp_host, 200).toLowerCase();
      values.smtp_port = locks.port ? saved.smtp_port : p ? p.port : clampInt(typeof body.smtp_port === "string" ? body.smtp_port : "", 1, 65535, 587);
      values.smtp_secure = locks.secure ? saved.smtp_secure : p ? p.secure : body.smtp_secure === "ssl" ? "ssl" : "starttls";
      values.smtp_user = locks.user ? saved.smtp_user : plainLine(body.smtp_user, 200);
      if (!locks.host && values.smtp_host) {
        if (!/^[a-z0-9.-]+$/.test(values.smtp_host) || values.smtp_host.length > 253) errors.push("The email server name can only contain letters, numbers, dots and dashes, e.g. smtp.zoho.in");
        else if (!privateSmtpAllowed() && isPrivateHost(values.smtp_host)) errors.push("That email server address points inside this computer or network, which isn’t allowed. Use your email service’s public server name, e.g. smtp.zoho.in");
      }
      // A password that is too long is refused, not cut short (a cut app password would fail with no explanation).
      const typed = typeof body.smtp_pass === "string" ? body.smtp_pass : "";
      if (typed.length > 500) errors.push("That password is longer than 500 characters, which is more than can be saved. Use a shorter app password or key.");
      else if (typed) values.smtp_pass = typed;
      else if (body.smtp_pass_clear) (values.smtp_pass = ""), (passCleared = true);
      // A password saved for one server or account is never sent to a different one: that includes a new port or security mode.
      else if ((values.smtp_host !== saved.smtp_host || values.smtp_user !== saved.smtp_user || String(values.smtp_port) !== String(saved.smtp_port) || values.smtp_secure !== saved.smtp_secure) && hasSmtpPass()) (values.smtp_pass = ""), (passCleared = true);
    }
    if (errors.length) return mailPage(c, { errors, s: { ...saved, ...values } }, 400);
    store.settings.set(values);
    // The log says what changed, never the values.
    const changed = Object.keys(values).filter((k) => k !== "smtp_pass" && JSON.stringify(values[k]) !== JSON.stringify(saved[k]));
    if ("smtp_pass" in values) changed.push(values.smtp_pass ? "smtp_pass (new password)" : "smtp_pass (removed)");
    console.log(`[audit] email settings saved by user ${user.id}: ${changed.join(", ") || "no changes"}`);
    if (body.action !== "test") return c.redirect(`${N}/settings?ok=${passCleared && !body.smtp_pass_clear ? "mailpasscleared" : "mailsaved"}`);
    // Save, then connect and send one short email to the person testing, and only to their own address.
    if (!ctx.mailer.ready()) return mailPage(c, { errors: ctx.mailer.problems() }, 400);
    if (!smtpTestLimit.take(`u:${user.id}`)) return mailPage(c, { errors: ["You’ve sent several tests in a short time. Wait a few minutes and try again."] }, 429);
    const conn = ctx.mailer.open();
    try {
      await conn.verify();
      const site = ctx.site();
      const from = escHtml(store.settings.get("mail_from_email"));
      await conn.send({ to: { address: user.email, name: user.name || "" }, subject: `Test email from ${site.title}`, text: `Email sending works. Newsletters from ${site.title} will come from ${store.settings.get("mail_from_email")}.\n\n${site.blogUrl}/`, html: `<p>Email sending works. Newsletters from <b>${escHtml(site.title)}</b> will come from ${from}.</p>` });
    } catch (err) {
      return mailPage(c, { errors: [`The test failed. ${plainLine(explainMailError(err), 300)}`] }, 400);
    } finally {
      conn.close();
    }
    console.log(`[audit] email settings test sent by user ${user.id}`);
    return c.redirect(`${N}/settings?ok=mailtest`);
  });

  // ---------- Analytics and search engines ----------

  const verifyCode = (v) => (typeof v === "string" ? v.trim().replace(/^[\s\S]*content=["']([^"']+)["'][\s\S]*$/i, "$1").slice(0, 200) : "");
  // Same pattern as analyticsSetup (src/web/analytics.js), so a script address that saves here is one the blog actually uses.
  const PLAUSIBLE_PER_SITE = /\/pa-[\w-]+\.js(\?|$)/;
  const KNOWN_TRACKER_HOSTS = new Set(Object.values(ANALYTICS).map((p) => new URL(p.script).host));
  const hostOf = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return "";
    }
  };
  // The same test the blog applies when it adds the tracker to a page (src/web/analytics.js): an https origin that is a plain host,
  // an address of at most 2,048 characters, no control characters.
  const trackerUrlOk = (u) => typeof u === "string" && u.length <= 2048 && !hasControlChars(u) && isHttpUrl(u) && Boolean(originOf(u));
  // Servers where anyone can publish files: the whole address is allowed to run scripts on the blog and receive visits, so these are never accepted.
  const SHARED_HOSTS = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "ajax.googleapis.com", "code.jquery.com", "raw.githubusercontent.com", "githubusercontent.com", "github.io", "gitlab.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev", "herokuapp.com", "azurewebsites.net", "amazonaws.com", "cloudfront.net", "firebaseapp.com", "web.app", "glitch.me", "repl.co", "replit.app", "surge.sh", "onrender.com", "fly.dev", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "blogspot.com", "wordpress.com", "googleusercontent.com", "storage.googleapis.com", "r2.dev", "supabase.co"];
  const isSharedHost = (host) => {
    const h = host.replace(/:[0-9]+$/, "").toLowerCase();
    return SHARED_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
  };
  const analyticsPage = (c, extra = {}, status = 200) => {
    const site = ctx.site();
    return page(c, "analytics.njk", {
      nav: "analytics",
      s: safeSettings(),
      canAnalytics: can.owner(c.get("user")),
      providers: ANALYTICS,
      live: site.analytics,
      siteHost: site.host,
      blogUrl: `${site.blogUrl}/`,
      sitemapUrl: `${site.blogUrl}/sitemap.xml`,
      robotsUrl: `${site.origin}/robots.txt`,
      keyUrl: `${site.blogUrl}/${store.settings.get("indexnow_key")}.txt`,
      localhost: /^(localhost|127\.)/.test(site.host),
      ...extra,
    }, status);
  };
  app.get(`${A}/analytics`, (c) => (can.settings(c.get("user")) ? analyticsPage(c) : deny(c)));
  app.post(`${A}/analytics`, async (c) => {
    const user = c.get("user");
    if (!can.settings(user)) return deny(c);
    const body = await form(c);
    // The visitor-numbers service is the owner's alone: it decides where every visitor's browser sends data.
    const isOwner = can.owner(user);
    const saved = safeSettings();
    const str = (k, max = 300) => plainLine(body[k], max);
    const errors = [];
    const values = {
      google_verification: verifyCode(body.google_verification),
      bing_verification: verifyCode(body.bing_verification),
      yandex_verification: verifyCode(body.yandex_verification),
      pinterest_verification: verifyCode(body.pinterest_verification),
      facebook_verification: verifyCode(body.facebook_verification),
      ai_training: body.ai_training === "block" ? "block" : "allow",
      indexnow_enabled: Boolean(body.indexnow_enabled),
    };
    if (isOwner) {
      Object.assign(values, {
        analytics_provider: typeof body.analytics_provider === "string" && Object.hasOwn(ANALYTICS, body.analytics_provider) ? body.analytics_provider : "none",
        analytics_script: str("analytics_script", 2048),
        analytics_id: str("analytics_id", 120),
        analytics_host: str("analytics_host", 2048),
        analytics_dashboard: str("analytics_dashboard", 2048),
      });
      // Over-long values are refused, never cut short into a different address.
      for (const k of ["analytics_script", "analytics_host", "analytics_dashboard"]) if (typeof body[k] === "string" && body[k].length > 2048) errors.push("An address on this page is longer than 2,048 characters.");
      if (typeof body.analytics_code === "string" && body.analytics_code.length > 5000) errors.push("That tracking code is too long (5,000 characters at most).");
      // Pasted tracking code wins over the fields: it names the service, script and site ID.
      if (str("analytics_code", 5000)) {
        const found = parseSnippet(String(body.analytics_code).slice(0, 5000));
        if (!found) errors.push("No Plausible or Umami tracking code was found in what you pasted. Copy the whole code, starting with <script.");
        else Object.assign(values, { analytics_provider: found.provider, analytics_script: found.script, analytics_id: found.id || (found.provider === values.analytics_provider ? values.analytics_id : ""), analytics_host: found.host });
      }
      const pr = values.analytics_provider;
      if (pr === "none") Object.assign(values, { analytics_script: "", analytics_id: "", analytics_host: "" });
      if (pr !== "none" && !values.analytics_script) values.analytics_script = ANALYTICS[pr].script;
      // The script and data addresses go into every page and the security policy: https, and a plain host name or IP.
      if (values.analytics_script && !trackerUrlOk(values.analytics_script)) errors.push("The tracker’s script address must start with https:// and be a plain server name (no quotes, commas, semicolons or spaces), at most 2,048 characters.");
      if (values.analytics_host) {
        const origin = originOf(values.analytics_host);
        if (origin) values.analytics_host = origin;
        else errors.push("The data address must start with https:// and be a plain server name.");
      }
      if (pr === "plausible" && !PLAUSIBLE_PER_SITE.test(values.analytics_script)) {
        values.analytics_id = values.analytics_id.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
        if (!values.analytics_id) errors.push("Enter your site’s domain as you added it in Plausible, or paste the tracking code Plausible gives you.");
      }
      if (pr === "umami" && !/^[0-9a-f-]{36}$/i.test(values.analytics_id)) errors.push("The Umami website ID looks like 4f1c6b2e-…: 36 letters, numbers and dashes. Paste the tracking code instead and it’s filled in for you.");
      if (values.analytics_dashboard && !isHttpUrl(values.analytics_dashboard)) errors.push("The dashboard link must be a full web address.");
      // A server that anyone can put files on can't be trusted with the script (the blog allows everything on that server, not one file).
      const shared = [hostOf(values.analytics_script), hostOf(values.analytics_host)].find((h) => h && !KNOWN_TRACKER_HOSTS.has(h) && isSharedHost(h));
      if (shared) errors.push(`${shared} is a shared server where anyone can put files, so it can’t deliver your tracking script. Use your own server name, or Plausible’s or Umami’s own.`);
      // A server that isn't Plausible's or Umami's own, and wasn't saved before, needs a tick: a typo or a swapped address would send every visit there.
      const newHosts = [hostOf(values.analytics_script), hostOf(values.analytics_host)].filter((h) => h && !KNOWN_TRACKER_HOSTS.has(h) && h !== hostOf(saved.analytics_script) && h !== hostOf(saved.analytics_host));
      if (!errors.length && newHosts.length && body.confirm_host !== "1") errors.push(`Visitor numbers will be sent to ${[...new Set(newHosts)].join(" and ")}, which isn’t Plausible’s or Umami’s own server. The blog will let that whole server run scripts on every page and receive the data, not just one file, so it must be a server only you control. If that is your own server, tick “Yes, this server address is mine” and save again.`);
    }
    for (const k of ["google_verification", "bing_verification", "yandex_verification", "pinterest_verification", "facebook_verification"]) {
      if (values[k] && !/^[\w.=:+/-]+$/.test(values[k])) errors.push(`The ${k.split("_")[0]} code has characters a verification code never has. Paste just the code, or the whole <meta> tag.`);
    }
    if (errors.length) return analyticsPage(c, { errors, s: { ...saved, ...values } }, 400);
    store.settings.set(values);
    return c.redirect(`${A}/analytics?ok=analytics`);
  });
  // Sends every public URL to IndexNow (after moving domains or first launch). It runs in the background.
  const pingAllLimit = createRateLimiter({ limit: 1, windowMs: 10 * 60_000 });
  app.post(`${A}/analytics/indexnow`, async (c) => {
    if (!can.settings(c.get("user"))) return deny(c);
    await form(c);
    // Each press queues every public URL, so a second press within a few minutes is refused.
    if (!pingAllLimit.take("all")) return c.redirect(`${A}/analytics?ok=pingwait`);
    const site = ctx.site();
    // Fire and forget: the request never waits for the search engines.
    console.log(`[audit] every public URL sent to IndexNow by user ${c.get("user").id}`);
    ctx.indexNow.pingNow([...store.posts.allPublic().map((p) => site.abs(site.url.post(p.slug))), site.abs(site.url.home), `${site.blogUrl}/sitemap.xml`]);
    return c.redirect(`${A}/analytics?ok=pinged`);
  });

  // ---------- Settings ----------

  const settingsPage = (c, extra = {}, status = 200) => {
    const site = ctx.site();
    const m = (id) => {
      const x = store.media.get(id);
      return x ? { id: x.id, url: site.url.media(x.path) } : null;
    };
    const st = safeSettings();
    return page(c, "settings.njk", { nav: "settings", s: st, categories: store.categories.list(), socialRows: linkRows(st.social_links?.length ? st.social_links : SOCIAL_KEYS.map((k) => st[`social_${k}`])), logo: m(store.settings.get("logo_id")), defaultOg: m(store.settings.get("default_og_image_id")), socialKeys: SOCIAL_KEYS, zones: Intl.supportedValuesOf("timeZone"), keyUrl: `${site.blogUrl}/${store.settings.get("indexnow_key")}.txt`, sitemapUrl: `${site.blogUrl}/sitemap.xml`, envSiteUrl: config.siteUrl, canSiteUrl: can.owner(c.get("user")), ...extra }, status);
  };
  // An image from the media library, by id. 0 = none, null = the id isn't an image.
  const imageId = (v) => {
    const n = wholeId(v);
    if (!n) return 0;
    const m = store.media.get(n);
    return m && m.kind !== "file" ? n : null;
  };
  app.get(`${A}/settings`, (c) => (can.settings(c.get("user")) ? settingsPage(c) : deny(c)));
  app.post(`${A}/settings`, async (c) => {
    const user = c.get("user");
    if (!can.settings(user)) return deny(c);
    const body = await form(c);
    const errors = [];
    // Settings are single lines (they reach page titles, social cards and email subjects); only the About text keeps its new lines.
    const str = (k, max = 500) => plainLine(body[k], max);
    const values = {
      site_title: str("site_title", 100) || SETTING_DEFAULTS.site_title,
      site_description: str("site_description", 300),
      org_name: str("org_name", 100) || SETTING_DEFAULTS.org_name,
      home_url: str("home_url"),
      about_text: plainText(body.about_text, 600),
      business_name: str("business_name", 120),
      brand_name: str("brand_name", 80),
      brand_url: str("brand_url", 300),
      address_street: str("address_street", 200),
      address_city: str("address_city", 80),
      address_region: str("address_region", 80),
      address_postcode: str("address_postcode", 20),
      address_country: str("address_country", 60),
      contact_phone: str("contact_phone", 30),
      contact_email: str("contact_email", 120),
      contact_email_alt: str("contact_email_alt", 120),
      posts_per_page: clampInt(body.posts_per_page, 4, 48, 12),
      cta_download_url: str("cta_download_url"),
      cta_download_label: str("cta_download_label", 60) || SETTING_DEFAULTS.cta_download_label,
      cta_kit_url: str("cta_kit_url"),
      cta_kit_label: str("cta_kit_label", 60) || SETTING_DEFAULTS.cta_kit_label,
      news_category_slug: str("news_category_slug", 80),
      comments_enabled: Boolean(body.comments_enabled),
      comments_moderation: ["none", "first", "all"].includes(body.comments_moderation) ? body.comments_moderation : "first",
      members_signup: Boolean(body.members_signup),
    };
    // The logo and the default social image must be pictures from the media library.
    for (const [key, label] of [["logo_id", "logo"], ["default_og_image_id", "default social image"]]) {
      const id = imageId(body[key]);
      if (id === null) errors.push(`The ${label} must be a picture from the media library, not a download.`);
      else values[key] = id || null;
    }
    if (Intl.supportedValuesOf("timeZone").includes(str("timezone"))) values.timezone = str("timezone");
    // The Site URL (every canonical link, the sitemap and the mail links) is the owner's to change.
    let siteUrlRisky = false;
    if (can.owner(user)) {
      if (isHttpUrl(str("site_url"))) {
        const next = new URL(str("site_url"));
        values.site_url = next.origin;
        // Emailed links, canonical addresses, the Secure cookie flag and the same-site check all follow this address. On a live site, a changed
        // address that is plain http, or inside this machine or network, needs a tick, so a slip can't point them somewhere unusable.
        if (config.production && next.origin !== store.settings.get("site_url") && (next.protocol !== "https:" || isPrivateHost(next.hostname)) && body.confirm_site_url !== "1") {
          siteUrlRisky = true;
          errors.push("That Site URL isn’t a public https address. Links in emails and the sign-in cookies follow it, so check it. If it is right, tick “Use this address anyway” and save again.");
        }
      } else errors.push("Site URL must be a full URL such as https://iotstudio.in");
    }
    // At most 40 link rows are looked at, however many arrive.
    const social = readLinks({ link_network: [].concat(body.link_network ?? []).slice(0, 40), link_url: [].concat(body.link_url ?? []).slice(0, 40) }, 12);
    values.social_links = social.urls;
    for (const k of SOCIAL_KEYS) values[`social_${k}`] = ""; // replaced by social_links
    errors.push(...social.bad);
    // Paths on this site (one leading slash, never //host) or full web addresses.
    for (const k of ["home_url", "cta_download_url", "cta_kit_url"]) if (values[k] && !siteLink(values[k])) errors.push(`${k.replace(/_/g, " ")} must be a full web address or a path on this site such as /download/ (not //).`);
    if (values.brand_url && !isHttpUrl(values.brand_url)) errors.push("Brand website must be a full web address starting with https://");
    for (const k of ["contact_email", "contact_email_alt"]) if (values[k] && !isEmail(values[k])) errors.push(`“${values[k]}” isn’t an email address. Use one plain address such as hello@example.com.`);
    if (values.contact_phone && !/^[+\d][\d\s()-]{5,}$/.test(values.contact_phone)) errors.push("The phone number can contain only digits, spaces, brackets, dashes and a leading +.");
    if (values.site_description.length > 155) errors.push(`Site description is ${values.site_description.length} characters; keep it to 155 (it is the home page meta description).`);
    if (errors.length) return settingsPage(c, { errors, siteUrlRisky, s: { ...safeSettings(), ...values }, socialRows: linkRows(values.social_links) }, 400);
    store.settings.set(values);
    return c.redirect(`${A}/settings?ok=saved`);
  });

  app.get(`${A}/*`, (c) => missing(c));
}
