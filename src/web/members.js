// Reader accounts (sign up with a verified email, sign in, forgot and reset password, account page) and
// comments. Only signed-in readers can comment. Forms post normally; every post checks the origin and a
// CSRF token (the session's, or a signed cookie token on the pages you see before you are signed in).
import crypto from "node:crypto";
import { clearAppCookie, createRateLimiter, isAdminPath, readCookie, safeEq, sameOrigin, setAppCookie, takeClient } from "./security.js";
import { cleanText, isEmail, isSafeLocalPath, maskEmail, normalizeEmail, passwordProblem } from "./validate.js";

const MAX_PASSWORD = 256;
const SESSION_SECONDS = 30 * 86400;
const DEVICE_SECONDS = 180 * 86400; // how long a browser stays "known" after a good sign-in
const ACCOUNT_FAILS = 5; // wrong passwords per account (or per known device) before sign-in pauses
const MAX_PENDING_PER_MEMBER = 10;
const MAX_PENDING_PER_POST = 200;
const ADDRESS_MAILS = 5; // mails per address per hour (only real sends count)
const SITE_MAILS = 300; // sign-up and password mails per hour, all addresses together
const MAIL_PARALLEL = 3; // mails being handed to the mail server at once
const MAIL_WAITING = 100; // mails waiting for a turn; beyond this they are dropped
const FORM_SECONDS = 2 * 3600; // a pre-sign-in form token is good for two hours
const FORM_REISSUE = 3600; // a token older than this is replaced when the form is shown again
const TOKEN = "{[A-Za-z0-9_-]{10,200}}";
const BUSY = "The site is busy right now. Please try again in a minute.";
const BAD_BODY = "That request couldn’t be read.";

// A display name as typed, or "" when it is not usable. Invisible, filler and direction-changing characters are dropped.
const FILLERS = "\\u2800\\u3164\\u115f\\u1160\\uffa0\\u17b4\\u17b5\\u180e\\u034f\\u061c\\u00ad";
const FILLER_RE = new RegExp(`[${FILLERS}]`, "gu");
const cleanName = (v) => {
  const s = cleanText(typeof v === "string" ? v.slice(0, 200) : "", 200).replace(/\p{Cf}/gu, "").replace(FILLER_RE, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
};

// Comment text: format characters (direction overrides, zero-width marks) can hide or reorder words, so they go.
// A joiner stays only inside an emoji sequence, and a non-joiner only between letters (some scripts need it).
const cleanComment = (s) =>
  s
    .replace(/[\p{Cf}⠀ㅤᅟᅠﾠ]/gu, (ch) => (ch === "‍" || ch === "‌" ? ch : ""))
    .replace(/(?<![\p{Extended_Pictographic}️])‍|‍(?![\p{Extended_Pictographic}])/gu, "")
    .replace(/(?<!\p{L})‌|‌(?!\p{L})/gu, "");

// Look-alike letters that readers could use to pass as a staff name (Cyrillic and Greek lookalikes).
const LOOKALIKE = Object.fromEntries(
  Object.entries({
    a: "аα", b: "ьβ", c: "сϲс", e: "еєε", h: "н", i: "іїι", j: "ј", k: "кκ", m: "м", n: "ηп", o: "оοσ", p: "рρ", s: "ѕ", t: "тτ", u: "υ", v: "νѵ", x: "хχ", y: "уγ", w: "ԝ", l: "ӏ",
  }).flatMap(([latin, chars]) => [...chars].map((ch) => [ch, latin])),
);
// One key for "the same name to the eye": accents, case, spacing, punctuation, invisible characters and look-alikes
// (including 0 for o and 1, i, l for l) all fold together. Exported so the staff side can use the same comparison.
export const nameKey = (s) => {
  const t = String(s || "")
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}\p{Cc}]/gu, "")
    .replace(FILLER_RE, "")
    .toLowerCase();
  return [...t]
    .map((ch) => LOOKALIKE[ch] || ch)
    .join("")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .replace(/0/g, "o")
    .replace(/[1i]/g, "l");
};

export function memberRoutes(app, ctx, { html, notFound }) {
  const { store, config } = ctx;
  const base = config.basePath;
  const lim = () => ctx.limiters;
  const site = () => ctx.site();
  const HOUR = 3600_000;
  // Limits only this file needs. Mail is counted per address (sends only) and for the whole site.
  const mailAll = createRateLimiter({ limit: SITE_MAILS, windowMs: HOUR });
  const verifyLim = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });
  const resetLim = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });
  const accountLim = createRateLimiter({ limit: 20, windowMs: 15 * 60_000 }); // password and delete forms, per address
  const nameLim = createRateLimiter({ limit: 10, windowMs: HOUR }); // name changes, per member
  const pageOpts = (c, maxAge) => ({ path: `${base}/`, sameSite: "Lax", ...(maxAge ? { maxAge } : {}) });
  const clear = (c, name) => clearAppCookie(c, ctx, name, `${base}/`);
  const meta = (title) => ({ title: `${title} | ${site().name}`, description: site().description, canonical: "", robots: "noindex, nofollow", og: null });
  const str = (v, max) => (typeof v === "string" && v.length <= max ? v : "");
  const mailReady = () => Boolean(ctx.mailer?.ready?.());
  const absolute = (p) => `${site().blogUrl}${p}`;
  const isBusy = (err) => err?.code === "BUSY";
  // A form body that can't be read answers 400, not a 500 with a log line.
  const readBody = async (c) => {
    try {
      return await c.req.parseBody();
    } catch {
      return null;
    }
  };

  // Mail goes out in the background so the answer never depends on whether an address exists. A few at a time:
  // each one opens its own connection, so a burst waits its turn and anything beyond a long queue is dropped.
  let mailRunning = 0;
  const mailWaiting = [];
  const runMail = (fn) => {
    mailRunning++;
    let p;
    try {
      p = Promise.resolve(fn());
    } catch {
      p = Promise.resolve();
    }
    p.catch(() => {}).finally(() => {
      mailRunning--;
      const next = mailWaiting.shift();
      if (next) runMail(next);
    });
  };
  const send = (fn) => {
    if (mailRunning < MAIL_PARALLEL) return runMail(fn);
    if (mailWaiting.length < MAIL_WAITING) mailWaiting.push(fn);
  };
  // Sends one mail to an address, spending the address's allowance and the site's only when it really goes out.
  // Over a limit, nothing is sent and the page the visitor sees does not change.
  const mailTo = (limiter, email, fn) => {
    const key = `email:${email}`;
    if (limiter.count(key) >= ADDRESS_MAILS) return;
    if (!mailAll.take("all")) return;
    if (!limiter.take(key)) return;
    send(fn);
  };
  const endSession = (token) => {
    if (!token) return;
    const m = store.members;
    (m.endSession || m.destroySession).call(m, token);
  };

  // Only same-site paths under this blog, and never the admin area, are allowed as the place to go next.
  // The value that is returned is checked again: dot segments ("/.//host") can collapse into a leading "//".
  const safeNext = (v) => {
    const fallback = `${base}/`;
    const s = typeof v === "string" ? v : "";
    if (!isSafeLocalPath(s)) return fallback;
    let u;
    try {
      u = new URL(s, "http://site.invalid");
    } catch {
      return fallback;
    }
    if (u.origin !== "http://site.invalid" || !u.pathname.startsWith(`${base}/`) || u.pathname.includes("\\") || isAdminPath(u.pathname, base)) return fallback;
    const out = `${u.pathname}${u.search}${u.hash}`;
    return isSafeLocalPath(out) ? out : fallback;
  };

  // These pages hold a personal token or cookie: never cached, never counted by analytics.
  const personal = async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.set("noAnalytics", true);
    await next();
  };
  for (const p of ["signin/", "signup/", "signout/", "forgot/", "account/*", "reset/*", "verify/*"]) app.use(`${base}/${p}`, personal);
  // Link pages carry a secret in the address. Browsers send only the site's name as the referrer (not "no-referrer",
  // which would make them send "Origin: null" on the form post), and no ads or footer slots are shown on them.
  const tokenPage = async (c, next) => {
    c.header("Referrer-Policy", "strict-origin");
    c.set("noSlots", true);
    await next();
  };
  for (const p of ["reset/*", "verify/*"]) app.use(`${base}/${p}`, tokenPage);

  // A signed token in a cookie, echoed by the forms you see before you are signed in: <time>.<random>.<signature>.
  // It is good for two hours, the cookie must equal the form field, and the signature must match.
  const tokenMac = (ts, rand) => ctx.secrets.hmac(`fcsrf:${ts}.${rand}`);
  const tokenAge = (v) => {
    const m = typeof v === "string" ? /^(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(v) : null;
    if (!m || !safeEq(m[3], tokenMac(m[1], m[2]))) return -1;
    const age = Math.floor(Date.now() / 1000) - Number(m[1]);
    return age >= -60 && age <= FORM_SECONDS ? Math.max(age, 0) : -1;
  };
  const formToken = (c) => {
    let t = readCookie(c, ctx, "fcsrf");
    const age = tokenAge(t);
    if (age < 0 || age > FORM_REISSUE) {
      const ts = Math.floor(Date.now() / 1000);
      const rand = crypto.randomBytes(16).toString("hex");
      t = `${ts}.${rand}.${tokenMac(ts, rand)}`;
      setAppCookie(c, ctx, "fcsrf", t, pageOpts(c, FORM_SECONDS));
    }
    return t;
  };
  const formOk = (c, body) => {
    const t = readCookie(c, ctx, "fcsrf");
    return tokenAge(t) >= 0 && safeEq(str(body._csrf, 200), t);
  };
  const memberOk = (c, body) => {
    const m = c.get("member");
    return Boolean(m) && safeEq(str(body._csrf, 100), m.session.csrf);
  };

  // Known browsers: after a good sign-in the browser gets a signed "mkd" cookie. Wrong passwords from a known browser
  // are counted under that browser, so strangers guessing at an address can't pause the real reader's own browser.
  // The signature covers the account, a fingerprint of the current password hash (a new password ends every known
  // browser) and a random value.
  const prints = (row) => String(row.password_hash || "").split("$")[5]?.slice(0, 16) || "";
  const deviceMac = (row, nonce) => ctx.secrets.hmac(`mkd:${row.id}.${prints(row)}.${nonce}`);
  const knownDevice = (c, row) => {
    const m = /^(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(readCookie(c, ctx, "mkd") || "");
    if (!m || Number(m[1]) !== row.id || !prints(row) || !safeEq(m[3], deviceMac(row, m[2]))) return null;
    return { nonce: m[2] };
  };
  const rememberDevice = (c, row) => {
    const nonce = knownDevice(c, row)?.nonce || crypto.randomBytes(16).toString("hex");
    setAppCookie(c, ctx, "mkd", `${row.id}.${nonce}.${deviceMac(row, nonce)}`, pageOpts(c, DEVICE_SECONDS));
  };

  // Signs the reader in. Every way here (password, verify link and new password, password change) just proved a password.
  function startSession(c, memberId) {
    endSession(readCookie(c, ctx, "mid")); // a new sign-in never keeps an older session alive
    const { token } = store.members.createSession(memberId);
    setAppCookie(c, ctx, "mid", token, pageOpts(c, SESSION_SECONDS));
    clear(c, "fcsrf");
    const row = store.members.get(memberId);
    if (row) rememberDevice(c, row);
  }

  // A display name may not match any staff member's name, however it is spelled or dressed up.
  const staffName = (name) => {
    const key = nameKey(name);
    return Boolean(key) && store.users.list().some((u) => nameKey(u.name) === key);
  };
  const nameProblem = (name) => {
    if (name.length < 2) return "Enter your name (at least 2 characters).";
    if (/https?:|www\.|<|>/i.test(name)) return "Names can’t contain links.";
    if (staffName(name)) return "That name belongs to the site team. Please use a different one.";
    return "";
  };

  // Sign in
  const signinPage = (c, data = {}, status = 200) => html(c, "public/signin.njk", { meta: meta("Sign in"), formCsrf: formToken(c), signupOpen: site().comments.signup && mailReady(), ...data }, status);
  const SIGNIN_NOTES = { deleted: "Your account was deleted.", reset: "Your password was changed. Sign in with the new one.", verified: "" };
  app.get(`${base}/signin/`, (c) => {
    if (c.get("member")) return c.redirect(safeNext(c.req.query("next")));
    const ok = c.req.query("ok");
    return signinPage(c, { next: safeNext(c.req.query("next")), notice: Object.hasOwn(SIGNIN_NOTES, ok) ? SIGNIN_NOTES[ok] : "" });
  });
  app.post(`${base}/signin/`, async (c) => {
    if (!sameOrigin(c, ctx)) return c.text("Forbidden", 403);
    const body = await readBody(c);
    if (!body) return c.text(BAD_BODY, 400);
    const next = safeNext(body.next);
    const email = normalizeEmail(str(body.email, 200));
    const fail = (error, status = 400) => signinPage(c, { next, error, email }, status);
    if (!formOk(c, body)) return fail("The form expired. Please try again.", 403);
    const valid = isEmail(email);
    const row = valid ? store.members.getByEmail(email) : null;
    const device = row ? knownDevice(c, row) : null;
    // Every attempt from one address counts, and so do wrong passwords for one account. A known browser is counted
    // under its own key instead, so strangers' guesses can't pause it and a shared network can't lock it out.
    if (!device && !takeClient(lim().signin, c, ctx)) return fail("Too many attempts. Wait 15 minutes and try again.", 429);
    // The slot is taken before the slow password check, so a burst of parallel guesses can't get past the limit.
    const acct = lim().signinAccount;
    const key = device ? `mkd:${row.id}:${device.nonce}` : email;
    if (valid && !acct.take(key)) return fail("Too many attempts. Wait 15 minutes and try again.", 429);
    const password = str(body.password, MAX_PASSWORD);
    let m = null;
    try {
      m = password && valid ? await store.members.authenticate(email, password) : null;
    } catch (err) {
      if (isBusy(err)) return fail(BUSY, 503);
      throw err;
    }
    // Unverified, suspended and wrong-password accounts all get the same answer.
    if (!m || !m.verified_at || m.status !== "active") return fail("That email and password don’t match an account.", 401);
    acct.reset(key);
    startSession(c, m.id);
    return c.redirect(next, 303);
  });

  // Sign up: name and email now; the password is chosen from the emailed link.
  const signupClosed = () => {
    if (!site().comments.signup) return "New accounts are closed for now.";
    if (!mailReady()) return "New sign-ups open once the site’s email is set up. Please check back soon.";
    return "";
  };
  const signupPage = (c, data = {}, status = 200) => html(c, "public/signup.njk", { meta: meta("Create an account"), formCsrf: formToken(c), closed: signupClosed(), ...data }, status);
  app.get(`${base}/signup/`, (c) => {
    if (c.get("member")) return c.redirect(safeNext(c.req.query("next")));
    return signupPage(c, { next: safeNext(c.req.query("next")) });
  });
  app.post(`${base}/signup/`, async (c) => {
    if (!sameOrigin(c, ctx)) return c.text("Forbidden", 403);
    const body = await readBody(c);
    if (!body) return c.text(BAD_BODY, 400);
    const next = safeNext(body.next);
    const name = cleanName(body.name);
    const email = normalizeEmail(str(body.email, 200));
    const newsletter = Boolean(body.newsletter);
    const fail = (error, status = 400) => signupPage(c, { next, error, name, email, newsletter }, status);
    const closed = signupClosed();
    if (closed) return fail(closed, mailReady() ? 403 : 503);
    if (!formOk(c, body)) return fail("The form expired. Please try again.", 403);
    if (body.website) return signupPage(c, { sent: true, closed: "" }); // honeypot: pretend it worked
    if (!takeClient(lim().signup, c, ctx)) return fail("Too many new accounts from your network. Try again in an hour.", 429);
    const problem = nameProblem(name);
    if (problem) return fail(problem);
    if (!isEmail(email)) return fail("That email address doesn’t look right.");

    // The answer is the same whether or not the address already has an account, and whether or not a mail goes out.
    const sent = () => signupPage(c, { sent: true, closed: "" });
    try {
      // An address that never verified is left exactly as it is; a new link is made only when the last one is old.
      const r = store.members.signup({ email, name, newsletter });
      if (r?.existing) {
        if (r.member.status === "active") mailTo(lim().signup, email, () => ctx.mailer.sendAccountExists(r.member, absolute("/signin/"), absolute("/forgot/")));
      } else if (r?.token) {
        mailTo(lim().signup, email, () => ctx.mailer.sendVerifyMember(r.member, absolute(`/verify/${r.token}/`)));
      }
    } catch {
      // Two sign-ups for one address at the same moment: the other one wins quietly.
    }
    return sent();
  });

  // What the store knows about a link, without using it up: the member the link belongs to, or null.
  const peek = (kind, token) => {
    const t = String(token);
    if (!/^[0-9a-f]{32}$/.test(t)) return null;
    return (kind === "verify" ? store.members.byVerifyToken(t) : store.members.byResetToken(t)) || null;
  };

  // Verify the email and choose the password: the link opens a page with a password field, and the button (POST) does
  // it, because mail scanners follow links. Whoever presses it chooses the password, so nobody else's password is kept.
  const EXPIRED_VERIFY = "That link has expired or was already used. Sign in, or create your account again to get a new link.";
  const verifyPage = (c, data = {}, status = 200) =>
    html(c, "public/verify.njk", { meta: meta("Choose your password"), formCsrf: formToken(c), action: `${base}/verify/${c.req.param("token")}/`, ...data }, status);
  const pendingInfo = (m) => ({ name: m.name, email: maskEmail(m.email) });
  app.get(`${base}/verify/:token${TOKEN}/`, (c) => {
    const m = peek("verify", c.req.param("token"));
    if (!m || m.status !== "active") return verifyPage(c, { error: EXPIRED_VERIFY, expired: true }, 400);
    return verifyPage(c, { pending: pendingInfo(m) });
  });
  app.post(`${base}/verify/:token${TOKEN}/`, async (c) => {
    if (!sameOrigin(c, ctx)) return c.text("Forbidden", 403);
    const body = await readBody(c);
    if (!body) return c.text(BAD_BODY, 400);
    const token = c.req.param("token");
    if (!formOk(c, body)) return verifyPage(c, { error: "The form expired. Please try again." }, 403);
    if (!takeClient(verifyLim, c, ctx)) return verifyPage(c, { error: "Too many attempts. Try again in a little while." }, 429);
    const pending = peek("verify", token);
    if (!pending || pending.status !== "active") return verifyPage(c, { error: EXPIRED_VERIFY, expired: true }, 400);
    const again = (error, status = 400) => verifyPage(c, { error, pending: pendingInfo(pending) }, status);
    const password = typeof body.password === "string" ? body.password : "";
    const weak = passwordProblem(password, { email: pending.email, name: pending.name });
    if (weak) return again(weak);
    if (typeof body.confirm === "string" && body.confirm !== password) return again("The two passwords don’t match.");
    let m = null;
    try {
      m = await store.members.verifyWithPassword(token, password);
    } catch (err) {
      if (isBusy(err)) return again(BUSY, 503);
      throw err;
    }
    if (!m || m.status !== "active") return verifyPage(c, { error: EXPIRED_VERIFY, expired: true }, 400);
    if (m.newsletter) {
      // Ticking the box is not enough on its own: they confirm the subscription from a second email.
      try {
        const r = store.subscribers.add(m.email, "account signup", { name: m.name });
        if (r.status === "pending" && r.confirmToken) send(() => ctx.mailer.sendConfirmSubscription(r.subscriber, absolute(`/subscribe/confirm/${r.confirmToken}/`)));
      } catch {}
    }
    startSession(c, m.id);
    return c.redirect(`${base}/account/?ok=verified`, 303);
  });

  // Forgot and reset password
  const forgotPage = (c, data = {}, status = 200) => html(c, "public/forgot.njk", { meta: meta("Reset your password"), formCsrf: formToken(c), action: `${base}/forgot/`, unavailable: !mailReady(), ...data }, status);
  app.get(`${base}/forgot/`, (c) => forgotPage(c));
  app.post(`${base}/forgot/`, async (c) => {
    if (!sameOrigin(c, ctx)) return c.text("Forbidden", 403);
    const body = await readBody(c);
    if (!body) return c.text(BAD_BODY, 400);
    const email = normalizeEmail(str(body.email, 200));
    if (!formOk(c, body)) return forgotPage(c, { error: "The form expired. Please try again.", email }, 403);
    if (!takeClient(lim().forgot, c, ctx)) return forgotPage(c, { error: "Too many requests. Try again in a little while.", email }, 429);
    if (!mailReady()) return forgotPage(c, { email }, 503);
    // The answer never depends on whether the address has an account, or on whether a mail was due.
    if (isEmail(email) && lim().forgot.count(`email:${email}`) < ADDRESS_MAILS) {
      try {
        const r = store.members.startReset(email);
        const m = r?.member;
        if (m && m.status === "active") {
          if (m.verified_at) {
            if (r.token) mailTo(lim().forgot, email, () => ctx.mailer.sendPasswordReset(m, absolute(`/reset/${r.token}/`)));
          } else {
            // Never confirmed: send the confirm link again (it asks for a password).
            const v = store.members.signup({ email, name: m.name, newsletter: Boolean(m.newsletter) });
            if (v?.token) mailTo(lim().forgot, email, () => ctx.mailer.sendVerifyMember(v.member, absolute(`/verify/${v.token}/`)));
          }
        }
      } catch {}
    }
    return forgotPage(c, { sent: true });
  });

  const resetPage = (c, data = {}, status = 200) => html(c, "public/reset.njk", { meta: meta("Choose a new password"), formCsrf: formToken(c), action: `${base}/reset/${c.req.param("token")}/`, ...data }, status);
  const EXPIRED_RESET = "That link has expired or was already used. Ask for a new one.";
  app.get(`${base}/reset/:token${TOKEN}/`, (c) => resetPage(c));
  app.post(`${base}/reset/:token${TOKEN}/`, async (c) => {
    if (!sameOrigin(c, ctx)) return c.text("Forbidden", 403);
    const body = await readBody(c);
    if (!body) return c.text(BAD_BODY, 400);
    if (!formOk(c, body)) return resetPage(c, { error: "The form expired. Please try again." }, 403);
    if (!takeClient(resetLim, c, ctx)) return resetPage(c, { error: "Too many attempts. Try again in a little while." }, 429);
    const token = c.req.param("token");
    // The link is looked up first (no password work for a wrong link), so the check can use the address and the name.
    const pending = peek("reset", token);
    if (!pending || pending.status !== "active") return resetPage(c, { error: EXPIRED_RESET, expired: true }, 400);
    const password = typeof body.password === "string" ? body.password : "";
    const weak = passwordProblem(password, { email: pending.email, name: pending.name }, "new password");
    if (weak) return resetPage(c, { error: weak }, 400);
    if (password !== str(body.confirm, MAX_PASSWORD)) return resetPage(c, { error: "The two passwords don’t match." }, 400);
    let m = null;
    try {
      m = await store.members.resetByToken(token, password);
    } catch (err) {
      if (isBusy(err)) return resetPage(c, { error: BUSY }, 503);
    }
    if (!m) return resetPage(c, { error: EXPIRED_RESET, expired: true }, 400);
    endSession(readCookie(c, ctx, "mid"));
    clear(c, "mid");
    clear(c, "fcsrf");
    return c.redirect(`${base}/signin/?ok=reset`, 303);
  });

  // Signing out needs the session's own CSRF token; a failed or cross-site request changes nothing.
  app.post(`${base}/signout/`, async (c) => {
    if (!sameOrigin(c, ctx)) return c.text("Forbidden", 403);
    const body = await readBody(c);
    if (!body) return c.text(BAD_BODY, 400);
    if (c.get("member")) {
      if (!memberOk(c, body)) return c.text("Forbidden", 403);
      endSession(readCookie(c, ctx, "mid"));
    }
    clear(c, "mid");
    return c.redirect(`${base}/`, 303);
  });

  // Account page
  const requireMember = (c) => (c.get("member") ? null : c.redirect(`${base}/signin/?next=${encodeURIComponent(`${base}/account/`)}`));
  const accountPage = (c, extra = {}, status = 200) => html(c, "public/account.njk", { meta: meta("Your account"), ...extra }, status);
  const NOTES = { name: "Your name was saved.", password: "Your password was changed.", verified: "Your email is confirmed. Welcome!" };
  const tooMany = (c) => accountPage(c, { error: "Too many wrong passwords. Wait 15 minutes and try again." }, 429);
  app.get(`${base}/account/`, (c) => {
    const ok = c.req.query("ok");
    return requireMember(c) || accountPage(c, { notice: Object.hasOwn(NOTES, ok) ? NOTES[ok] : "" });
  });
  // Password checks on the account page: a limit of wrong guesses per member. The slot is taken before the slow
  // check (and given back on success), so parallel guesses can't beat the limit.
  const checkPassword = async (c, me, password) => {
    const key = `member:${me.id}`;
    if (!lim().step.take(key)) return "limited";
    let ok = false;
    try {
      ok = Boolean(password && password.length <= MAX_PASSWORD && (await store.members.authenticate(me.email, password)));
    } catch (err) {
      if (isBusy(err)) return "busy";
      throw err;
    }
    if (!ok) return "wrong";
    lim().step.reset(key);
    return "ok";
  };
  const busyPage = (c) => accountPage(c, { error: BUSY }, 503);
  app.post(`${base}/account/name/`, async (c) => {
    if (!sameOrigin(c, ctx)) return c.text("Forbidden", 403);
    const body = await readBody(c);
    if (!body) return c.text(BAD_BODY, 400);
    if (requireMember(c)) return requireMember(c);
    if (!memberOk(c, body)) return accountPage(c, { error: "The form expired. Please try again." }, 403);
    const me = c.get("member").member;
    // Changing a name is limited per reader, and every try counts (it also answers "is this a staff name?").
    if (!nameLim.take(`member:${me.id}`)) return accountPage(c, { error: "You’ve changed your name a lot just now. Try again in a little while." }, 429);
    const name = cleanName(body.name);
    const problem = nameProblem(name);
    if (problem) return accountPage(c, { error: problem }, 400);
    if (name !== me.name) {
      store.members.update(me.id, { name });
      ctx.cache.clearTag(`member:${me.id}`); // only the pages that show this reader's comments
    }
    return c.redirect(`${base}/account/?ok=name`, 303);
  });
  app.post(`${base}/account/password/`, async (c) => {
    if (!sameOrigin(c, ctx)) return c.text("Forbidden", 403);
    const body = await readBody(c);
    if (!body) return c.text(BAD_BODY, 400);
    if (requireMember(c)) return requireMember(c);
    if (!memberOk(c, body)) return accountPage(c, { error: "The form expired. Please try again." }, 403);
    if (!takeClient(accountLim, c, ctx)) return tooMany(c);
    const me = c.get("member").member;
    const password = typeof body.password === "string" ? body.password : "";
    const checked = await checkPassword(c, me, typeof body.current === "string" ? body.current : "");
    if (checked === "limited") return tooMany(c);
    if (checked === "busy") return busyPage(c);
    if (checked === "wrong") return accountPage(c, { error: "Your current password isn’t right." }, 400);
    const weak = passwordProblem(password, { email: me.email, name: me.name }, "new password");
    if (weak) return accountPage(c, { error: weak }, 400);
    try {
      await store.members.setPassword(me.id, password); // ends every session
    } catch (err) {
      if (isBusy(err)) return busyPage(c);
      throw err;
    }
    startSession(c, me.id);
    return c.redirect(`${base}/account/?ok=password`, 303);
  });
  app.post(`${base}/account/delete/`, async (c) => {
    if (!sameOrigin(c, ctx)) return c.text("Forbidden", 403);
    const body = await readBody(c);
    if (!body) return c.text(BAD_BODY, 400);
    if (requireMember(c)) return requireMember(c);
    if (!memberOk(c, body)) return accountPage(c, { error: "The form expired. Please try again." }, 403);
    if (!takeClient(accountLim, c, ctx)) return tooMany(c);
    const me = c.get("member").member;
    const checked = await checkPassword(c, me, typeof body.password === "string" ? body.password : "");
    if (checked === "limited") return tooMany(c);
    if (checked === "busy") return busyPage(c);
    if (checked === "wrong") return accountPage(c, { error: "That password isn’t right, so the account wasn’t deleted." }, 400);
    store.members.remove(me.id); // also removes their newsletter subscription
    ctx.cache.clearTag(`member:${me.id}`);
    clear(c, "mid");
    return c.redirect(`${base}/signin/?ok=deleted`, 303);
  });

  // Comments
  app.post(`${base}/:slug/comments/`, async (c) => {
    const post = store.posts.getPublicBySlug(c.req.param("slug"));
    if (!post || post.type !== "post") return notFound(c);
    const url = `${base}/${post.slug}/`;
    if (!sameOrigin(c, ctx)) return c.text("Forbidden", 403);
    const body = await readBody(c);
    if (!body) return c.text(BAD_BODY, 400);
    const m = c.get("member");
    if (!m) return c.redirect(`${base}/signin/?next=${encodeURIComponent(`${url}#comments`)}`, 303);
    if (!memberOk(c, body)) return c.text("Forbidden", 403);
    if (!site().comments.enabled || !post.comments_enabled) return c.redirect(`${url}?c=closed#comments`, 303);
    const text = cleanText(cleanComment(String(typeof body.body === "string" ? body.body.slice(0, 20_000) : "")).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n"), 5000);
    if (!text) return c.redirect(`${url}?c=empty#comments`, 303);
    if (!lim().comment.take(`m${m.member.id}`)) return c.redirect(`${url}?c=slow#comments`, 303);
    let parentId = Number(body.parent_id) || null;
    if (parentId) {
      const parent = store.comments.get(parentId);
      // A reply needs a visible comment on this same post to answer.
      if (!parent || parent.post_id !== post.id || parent.status !== "published") return c.redirect(`${url}?c=gone#comments`, 303);
      if (parent.parent_id) parentId = parent.parent_id; // replies stay one level deep
    }
    const mode = site().comments.moderation;
    const held = mode === "all" || (mode === "first" && !store.comments.hasApproved(m.member.id));
    if (held) {
      // Comments waiting for approval are capped per reader first. The per-post cap is only a backstop and never stops
      // a reader who already has an approved comment, so a crowd of new accounts can't shut everyone else out.
      const mine = store.comments.list({ status: "pending", memberId: m.member.id, limit: 1 }).total;
      if (mine >= MAX_PENDING_PER_MEMBER) return c.redirect(`${url}?c=limit#comments`, 303);
      const here = store.comments.list({ status: "pending", postId: post.id, limit: 1 }).total;
      if (here >= MAX_PENDING_PER_POST && !store.comments.hasApproved(m.member.id)) return c.redirect(`${url}?c=limit#comments`, 303);
    }
    let saved;
    try {
      saved = store.comments.add({ postId: post.id, memberId: m.member.id, parentId, body: text, status: held ? "pending" : "published" });
    } catch (err) {
      // PARENT_UNAVAILABLE: the comment being answered was hidden or removed a moment ago.
      if (err?.code !== "PARENT_UNAVAILABLE") throw err;
      return c.redirect(`${url}?c=gone#comments`, 303);
    }
    if (!held) ctx.cache.clearTag(`post:${post.id}`);
    return c.redirect(held ? `${url}?c=pending#comments` : `${url}?c=posted#comment-${saved.id}`, 303);
  });

  // Likes and deletes answer the same way for a comment that doesn't exist and one the reader can't see.
  const missing = (c) => c.text("Not found", 404);
  const ownComment = async (c) => {
    if (!sameOrigin(c, ctx)) return { error: c.text("Forbidden", 403) };
    const body = await readBody(c);
    if (!body) return { error: c.text(BAD_BODY, 400) };
    const m = c.get("member");
    if (!m || !memberOk(c, body)) return { error: c.text("Forbidden", 403) };
    const comment = store.comments.get(Number(c.req.param("id")));
    const post = comment ? store.posts.get(comment.post_id) : null;
    return { m, comment, post };
  };
  app.post(`${base}/comments/:id{[0-9]+}/like/`, async (c) => {
    const r = await ownComment(c);
    if (r.error) return r.error;
    if (!r.comment || r.comment.status !== "published" || !r.post?.isPublic) return missing(c);
    if (!lim().like.take(`m${r.m.member.id}`)) return c.text("You’re liking comments too fast. Wait a minute and try again.", 429);
    store.comments.toggleLike(r.comment.id, r.m.member.id);
    ctx.cache.clearTag(`post:${r.comment.post_id}`); // the like count on this one post only
    return c.redirect(`${base}/${r.post.slug}/#comment-${r.comment.id}`, 303);
  });
  // Readers can delete their own comment whatever its status and whether or not the post is still public.
  app.post(`${base}/comments/:id{[0-9]+}/delete/`, async (c) => {
    const r = await ownComment(c);
    if (r.error) return r.error;
    if (!r.comment || r.comment.member_id !== r.m.member.id) return missing(c);
    store.comments.remove(r.comment.id);
    ctx.cache.clearTag(`post:${r.comment.post_id}`);
    return c.redirect(r.post?.isPublic ? `${base}/${r.post.slug}/?c=deleted#comments` : `${base}/`, 303);
  });
}
