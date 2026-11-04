import crypto from "node:crypto";
import { bind, now, transaction } from "../db.js";
import { DUMMY_HASH, hashPassword, needsRehash, verifyPassword } from "../web/password.js";
import { isSlug, slugify } from "../render/util.js";
import { matchCode, newRecoveryCode, normalizeRecoveryCode, RECOVERY_COUNT } from "../web/totp.js";
import { mayGrant, mayManage } from "./roles.js";
import { isSealed, nextId, secretsOrPlain, sha256 } from "./sql.js";

export const ROLES = ["owner", "admin", "editor", "author", "contributor"];
export const ROLE_LABELS = { owner: "Owner", admin: "Administrator", editor: "Editor", author: "Author", contributor: "Contributor" };
const STATUSES = ["active", "suspended"];

const SESSION_DAYS = 14; // absolute life of a staff session
const IDLE_DAYS = 2; // a session unused for this long is gone
const TOUCH_MS = 5 * 60_000; // last_seen_at is refreshed at most this often
const MAX_SESSIONS = 10; // devices signed in at once per person; the least recently used go first
const TOTP_MAX_FAILURES = 5;
const TOTP_LOCK_MS = 15 * 60_000;
const TEMP_PASSWORD_DAYS = 7; // a password someone else chose must be replaced within this time

// Sealed values are bound to what they belong to, so one can't be copied to another person's row.
const totpLabel = (userId) => `users.totp_secret:${userId}`;
const pendingLabel = (userId) => `sessions.totp_pending:${userId}`;
const coded = (message, code) => Object.assign(new Error(message), { code });

// Secrets never leave the store: no password hash, authenticator secret, lock state or auth_version in user objects.
function hydrate(row) {
  if (!row) return null;
  const { password_hash, totp_secret, totp_last_step, totp_used_steps, totp_failures, totp_locked_until, auth_version, recovery_codes_reset, password_set_at, ...user } = row;
  let links = [];
  try {
    links = JSON.parse(row.links || "[]");
  } catch {}
  return {
    ...user,
    twoStep: Boolean(row.totp_enabled_at && totp_secret),
    mustChange: Boolean(row.password_must_change),
    recoveryCodesReset: Boolean(recovery_codes_reset),
    passwordSetAt: password_set_at || null,
    links,
  };
}

const usedSteps = (text) => {
  try {
    const list = JSON.parse(text || "[]");
    return Array.isArray(list) ? list.filter(Number.isInteger) : [];
  } catch {
    return [];
  }
};

export function createUserStore(db, { onChange, secrets }) {
  const vault = secretsOrPlain(secrets);

  // Authenticator secrets written before sealing existed are encrypted once, at start-up.
  if (vault.real) {
    for (const r of db.prepare("SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL").all()) {
      if (!isSealed(r.totp_secret)) db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(vault.seal(r.totp_secret, totpLabel(r.id)), r.id);
    }
    for (const r of db.prepare("SELECT id, user_id, totp_pending FROM sessions WHERE totp_pending IS NOT NULL").all()) {
      if (!isSealed(r.totp_pending)) db.prepare("UPDATE sessions SET totp_pending = ? WHERE id = ?").run(vault.seal(r.totp_pending, pendingLabel(r.user_id)), r.id);
    }
  }

  const insertUser = (data, hash, { mustChange = false, role = data.role || "author" } = {}) => {
    if (!ROLES.includes(role)) throw new Error("Unknown role");
    const { email, name, job_title = "", bio = "" } = data;
    const t = now();
    const info = db
      .prepare(`INSERT INTO users (id, email, password_hash, name, slug, role, job_title, bio, password_must_change, password_set_at, created_at)
                VALUES (${nextId("users")}, :email, :hash, :name, :slug, :role, :job_title, :bio, :must, :set_at, :at)`)
      .run(bind({ email: String(email).trim(), hash, name: String(name).trim(), slug: store.uniqueSlug(name), role, job_title, bio, must: mustChange ? 1 : 0, set_at: t, at: t }));
    return Number(info.lastInsertRowid);
  };

  const activeOwnersExcept = (id) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active' AND id != ?").get(id).n;

  // Who is making the change: "system" (the command-line tool, set-up, tests) or a staff user. The row is read again,
  // so a stale or forged object can't carry rank it no longer has. A missing actor is an error, never a free pass.
  function resolveActor(actor) {
    if (actor === "system") return "system";
    if (actor === undefined || actor === null) throw coded("Who is making this change?", "NO_ACTOR");
    const row = typeof actor === "object" ? db.prepare("SELECT id, role, status FROM users WHERE id = ?").get(Number(actor.id)) : null;
    if (!row || row.status !== "active") throw coded("You can't change this account", "FORBIDDEN");
    return row;
  }
  const forbid = (message = "You can't change this account") => {
    throw coded(message, "FORBIDDEN");
  };
  // Changing another person's account needs the owner or a higher rank; changing your own is always allowed here.
  const needManage = (who, target) => {
    if (who === "system" || who.id === target.id) return;
    if (!mayManage(who, target)) forbid();
  };

  // Profile fields, checked here as well as in the routes, so a new caller can't store a broken public URL or a stray picture.
  function checkFields(fields, id) {
    if ("name" in fields && (!String(fields.name || "").trim() || String(fields.name).length > 200)) throw new Error("A name is needed (up to 200 characters)");
    if ("email" in fields && (!String(fields.email || "").trim() || String(fields.email).length > 254)) throw new Error("An email address is needed");
    if ("slug" in fields) {
      if (!isSlug(fields.slug) || fields.slug.length > 80) throw new Error("Profile URL must be lowercase words joined by hyphens.");
      if (db.prepare("SELECT 1 FROM users WHERE slug = ? AND id != ?").get(fields.slug, id)) throw new Error("That profile URL is already taken.");
    }
    if ("job_title" in fields && (typeof fields.job_title !== "string" || fields.job_title.length > 200)) throw new Error("The job title is too long");
    if ("bio" in fields && (typeof fields.bio !== "string" || fields.bio.length > 5000)) throw new Error("The bio is too long");
    if ("links" in fields) {
      const links = fields.links;
      const ok = Array.isArray(links) && links.length <= 20 && links.every((u) => typeof u === "string" && u.length <= 500 && /^https?:\/\//i.test(u));
      if (!ok) throw new Error("Links must be web addresses");
    }
    if ("photo_id" in fields && fields.photo_id != null) {
      const m = db.prepare("SELECT kind FROM media WHERE id = ?").get(Number(fields.photo_id));
      if (!m || m.kind !== "image") throw new Error("That picture can't be used as a profile photo");
    }
  }

  const store = {
    count: () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
    // Setup stays open until someone owns the site (demo authors don't count).
    hasOwner: () => Boolean(db.prepare("SELECT 1 FROM users WHERE role = 'owner' LIMIT 1").get()),
    get: (id) => hydrate(db.prepare("SELECT * FROM users WHERE id = ?").get(id)),
    getBySlug: (slug) => hydrate(db.prepare("SELECT * FROM users WHERE slug = ?").get(slug)),
    getByEmail: (email) => hydrate(db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).trim())),
    list: () =>
      db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id AND p.type = 'post') AS post_count
                  FROM users u ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 WHEN 'author' THEN 3 ELSE 4 END, name`).all().map(hydrate),

    uniqueSlug(base, excludeId = 0) {
      const root = slugify(base) || "author";
      let slug = root;
      for (let n = 2; db.prepare("SELECT 1 FROM users WHERE slug = ? AND id != ?").get(slug, excludeId); n++) slug = `${root}-${n}`;
      return slug;
    },

    // A new staff account. `mustChange` makes the person pick their own password at first sign-in (within 7 days).
    // Pass `{ actor }` (a staff user) to apply the role-granting rule; without one (set-up, scripts, tests) any role may be created.
    async create(data, { mustChange = false, actor } = {}) {
      const role = data.role || "author";
      if (actor && actor !== "system") {
        const who = resolveActor(actor);
        if (!mayGrant(who, role)) forbid("You can't give this role");
      }
      const hash = await hashPassword(data.password);
      const id = transaction(db, () => insertUser(data, hash, { mustChange, role }));
      onChange();
      return store.get(id);
    },

    // Creates the first owner, and only if nobody owns the site yet. Atomic: two setup requests can't both win.
    // Returns the user, or null when an owner already exists.
    async createOwnerIfNone(data) {
      const hash = await hashPassword(data.password);
      const id = transaction(db, () => {
        if (store.hasOwner()) return 0;
        return insertUser(data, hash, { role: "owner" });
      });
      if (!id) return null;
      onChange();
      return store.get(id);
    },

    // Changes profile fields. The store keeps its own rules, so a new caller can't get around them:
    // the site always keeps one active owner, a role, status or email change signs the person out everywhere,
    // and `actor` (a staff user, or "system" for the command-line tool, set-up and tests) is required:
    // only the owner, or someone of higher rank, may change another account, and roles can be given only by mayGrant.
    update(id, fields, { actor } = {}) {
      const who = resolveActor(actor);
      const target = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
      if (!target) return null;
      if ("role" in fields && !ROLES.includes(fields.role)) throw new Error("Unknown role");
      if ("status" in fields && !STATUSES.includes(fields.status)) throw new Error("Unknown status");
      checkFields(fields, id);
      const nextRole = fields.role ?? target.role;
      const nextStatus = fields.status ?? target.status;
      if (target.role === "owner" && (nextRole !== "owner" || nextStatus !== "active") && !activeOwnersExcept(id)) {
        throw new Error("The site needs at least one active owner");
      }
      if (who !== "system") {
        const self = who.id === target.id;
        needManage(who, target);
        if (nextRole !== target.role) {
          if (self && who.role !== "owner") forbid("You can't give this role");
          if (!mayGrant(who, nextRole)) forbid("You can't give this role");
        }
        if (self && nextStatus !== target.status) forbid("You can't change your own status");
      }
      const allowed = ["email", "name", "slug", "role", "job_title", "bio", "photo_id", "links", "status"];
      const sets = [];
      const values = { id };
      for (const key of allowed) {
        if (!(key in fields)) continue;
        sets.push(`${key} = :${key}`);
        values[key] = key === "links" ? JSON.stringify(fields.links) : key === "email" ? String(fields.email).trim() : key === "name" ? String(fields.name).trim() : fields[key];
      }
      const emailChanged = "email" in fields && String(fields.email).trim().toLowerCase() !== String(target.email).toLowerCase();
      const loseSessions = nextRole !== target.role || nextStatus !== target.status || emailChanged;
      if (loseSessions) sets.push("auth_version = auth_version + 1");
      transaction(db, () => {
        if (sets.length) db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = :id`).run(bind(values));
        if (loseSessions) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      });
      onChange();
      return store.get(id);
    },

    // A new password ends every session and invalidates open sign-in challenges.
    // Your own password is yours: it clears "must change password". A password set for someone else (or by the
    // command-line tool) is temporary: the person must replace it at their next sign-in, within 7 days.
    // The new password may not equal the current one.
    async setPassword(id, password, { actor } = {}) {
      const who = resolveActor(actor);
      const target = db.prepare("SELECT id, role, password_hash FROM users WHERE id = ?").get(id);
      if (!target) return false;
      needManage(who, target);
      if (await verifyPassword(password, target.password_hash)) throw coded("Choose a password you haven't used before for this account.", "SAME_PASSWORD");
      const hash = await hashPassword(password);
      const own = who !== "system" && who.id === target.id;
      transaction(db, () => {
        db.prepare("UPDATE users SET password_hash = ?, password_must_change = ?, password_set_at = ?, auth_version = auth_version + 1 WHERE id = ?").run(hash, own ? 0 : 1, now(), id);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      });
      return true;
    },

    // Returns the user when the email and password match an active account.
    // It does not record a sign-in: that happens when the session is created, after any second step.
    // Throws an error with code "PASSWORD_EXPIRED" when the right password is a temporary one older than 7 days.
    async authenticate(email, password) {
      const row = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim());
      // Hash anyway when the user is unknown, so timing doesn't reveal which emails exist.
      const ok = await verifyPassword(password, row?.password_hash || DUMMY_HASH);
      if (!row || !ok || row.status !== "active") return null;
      if (row.password_must_change && row.password_set_at && Date.parse(row.password_set_at) < Date.now() - TEMP_PASSWORD_DAYS * 864e5) {
        throw coded("This temporary password has expired. Ask an administrator for a new one.", "PASSWORD_EXPIRED");
      }
      if (needsRehash(row.password_hash)) {
        // Upgrade an older, weaker hash now that the password is known. A password changed meanwhile wins.
        const upgraded = await hashPassword(password).catch(() => null);
        if (upgraded) db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?").run(upgraded, row.id, row.password_hash);
      }
      return hydrate(row);
    },

    // Deletes a user and gives their posts to another (active) user. The last owner can't be deleted.
    // Only the owner, or someone of higher rank, may delete another account (`actor`, as in update()).
    remove(id, reassignTo, { actor } = {}) {
      const who = resolveActor(actor);
      const target = db.prepare("SELECT id, role, status FROM users WHERE id = ?").get(id);
      if (!target) return;
      if (who !== "system" && (who.id === target.id || !mayManage(who, target))) forbid();
      if (target.role === "owner" && !activeOwnersExcept(id)) throw new Error("The site needs at least one active owner");
      const give = reassignTo !== undefined && reassignTo !== null && Number(reassignTo) !== Number(id);
      if (give) {
        const heir = db.prepare("SELECT status FROM users WHERE id = ?").get(Number(reassignTo));
        if (!heir || heir.status !== "active") throw new Error("The person who takes over the posts must be an active staff member");
      }
      transaction(db, () => {
        if (give) db.prepare("UPDATE posts SET author_id = ? WHERE author_id = ?").run(Number(reassignTo), id);
        db.prepare("DELETE FROM users WHERE id = ?").run(id);
      });
      onChange();
    },

    // The number that ends open sign-in challenges: it changes with a password, a second-step change, a role or status change.
    getAuthVersion(id) {
      const row = db.prepare("SELECT auth_version FROM users WHERE id = ?").get(id);
      return row ? row.auth_version : null;
    },

    // Sessions: the cookie holds a random token; the database stores only its hash.
    // Creating one is the moment of a full sign-in, so that is when last_login_at is written.
    // A person keeps at most MAX_SESSIONS signed-in devices; the least recently used go first.
    createSession(userId, { ip = "", userAgent = "" } = {}) {
      const token = crypto.randomBytes(32).toString("base64url");
      const csrf = crypto.randomBytes(24).toString("base64url");
      const t = now();
      const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
      transaction(db, () => {
        db.prepare("INSERT INTO sessions (id, user_id, csrf, created_at, expires_at, ip, user_agent, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(sha256(token), userId, csrf, t, expires, String(ip).slice(0, 64), String(userAgent).slice(0, 255), t);
        db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id NOT IN
                    (SELECT id FROM sessions WHERE user_id = ? ORDER BY COALESCE(last_seen_at, created_at) DESC, created_at DESC LIMIT ${MAX_SESSIONS})`).run(userId, userId);
        db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(t, userId);
      });
      return { token, csrf, expires };
    },
    // Swaps a session's cookie token and form token for new ones (same person, same end date), so a copied cookie stops
    // working at moments like finishing a second step or a step-up check. Returns the new { token, csrf, expires }, or null.
    rotateSession(token) {
      if (!token) return null;
      const next = crypto.randomBytes(32).toString("base64url");
      const csrf = crypto.randomBytes(24).toString("base64url");
      const row = db.prepare("UPDATE sessions SET id = ?, csrf = ?, last_seen_at = ? WHERE id = ? RETURNING expires_at").get(sha256(next), csrf, now(), sha256(token));
      return row ? { token: next, csrf, expires: row.expires_at } : null;
    },
    getSession(token) {
      if (!token) return null;
      const s = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sha256(token));
      if (!s) return null;
      const t = now();
      const lastSeen = s.last_seen_at || s.created_at;
      if (s.expires_at < t || lastSeen < new Date(Date.now() - IDLE_DAYS * 864e5).toISOString()) {
        db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id);
        return null;
      }
      const user = store.get(s.user_id);
      if (!user || user.status !== "active") return null;
      if (Date.now() - Date.parse(lastSeen) > TOUCH_MS) {
        db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(t, s.id);
        s.last_seen_at = t;
      }
      if (s.totp_pending) s.totp_pending = vault.open(s.totp_pending, pendingLabel(s.user_id));
      return { session: s, user };
    },
    endSession: (token) => db.prepare("DELETE FROM sessions WHERE id = ?").run(sha256(token || "")),
    destroySession: (token) => store.endSession(token),
    // Every session of one user (password reset, suspension, "sign out everywhere"). Pass `{ actor }` to apply the rank rule
    // when someone else's sessions are ended; without one it is allowed (signing out never gives anyone access).
    endAllSessions(userId, { actor } = {}) {
      if (actor && actor !== "system") {
        const who = resolveActor(actor);
        const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
        if (target) needManage(who, target);
      }
      return db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    },
    // Signs a user out everywhere except the given session (by its stored id).
    endOtherSessions: (userId, keepSessionId) => db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, keepSessionId || ""),
    // The devices signed in as this user, newest use first (ids are the stored hashes, never the cookie token).
    listSessions: (userId) =>
      db.prepare("SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY COALESCE(last_seen_at, created_at) DESC").all(userId),
    revokeSession: (userId, sessionId) => db.prepare("DELETE FROM sessions WHERE user_id = ? AND id = ?").run(userId, String(sessionId || "")).changes === 1,
    // Removes sessions past their life or idle for too long, and expired rate-limit counters.
    pruneSessions() {
      const result = db.prepare("DELETE FROM sessions WHERE expires_at < ? OR COALESCE(last_seen_at, created_at) < ?").run(now(), new Date(Date.now() - IDLE_DAYS * 864e5).toISOString());
      db.prepare("DELETE FROM rate_limits WHERE expires < ?").run(Date.now());
      return result;
    },

    // After an incident or a restore of an older backup: ends every session, removes every recovery code (the person is told
    // to create new ones), and ends open sign-in challenges. Pass one `userId`, or none for every account. `actor` as in update():
    // for one account the rank rule applies; for every account only "system" or an owner may do it.
    revokeAccess(userId, { actor } = {}) {
      const who = resolveActor(actor);
      if (userId == null) {
        if (who !== "system" && who.role !== "owner") forbid();
      } else {
        const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
        if (!target) return 0;
        needManage(who, target);
      }
      const ids = userId == null ? db.prepare("SELECT id FROM users").all().map((r) => r.id) : [Number(userId)];
      transaction(db, () => {
        for (const id of ids) {
          db.prepare("UPDATE users SET auth_version = auth_version + 1, recovery_codes_reset = CASE WHEN totp_enabled_at IS NOT NULL AND EXISTS (SELECT 1 FROM user_recovery_codes WHERE user_id = users.id) THEN 1 ELSE recovery_codes_reset END WHERE id = ?").run(id);
          db.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(id);
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
        }
      });
      return ids.length;
    },

    // ---- Two-step sign-in (authenticator app) ----

    twoStepStatus(userId) {
      const row = db.prepare("SELECT totp_enabled_at, totp_secret, recovery_codes_reset FROM users WHERE id = ?").get(userId);
      const left = db.prepare("SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL").get(userId).n;
      return { enabled: Boolean(row?.totp_enabled_at && row.totp_secret), enabledAt: row?.totp_enabled_at || null, codesLeft: left, recoveryCodesReset: Boolean(row?.recovery_codes_reset) };
    },
    // A secret being set up belongs to the session that asked for it.
    setPendingSecret(sessionId, secret) {
      const row = db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(sessionId);
      return db.prepare("UPDATE sessions SET totp_pending = ? WHERE id = ?").run(secret && row ? vault.seal(secret, pendingLabel(row.user_id)) : secret, sessionId);
    },
    // Turns two-step sign-in on with a confirmed secret; returns the new recovery codes (shown once).
    // Returns null when it is already on, so a second request can't replace the secret and codes just issued.
    enableTwoStep(userId, secret, step) {
      const codes = transaction(db, () => {
        const done = db.prepare("UPDATE users SET totp_secret = ?, totp_enabled_at = ?, totp_last_step = ?, totp_used_steps = ?, totp_failures = 0, totp_locked_until = NULL WHERE id = ? AND totp_enabled_at IS NULL")
          .run(vault.seal(secret, totpLabel(userId)), now(), step, JSON.stringify(step > 0 ? [step] : []), userId);
        if (done.changes !== 1) return null;
        db.prepare("UPDATE sessions SET totp_pending = NULL WHERE user_id = ?").run(userId);
        return store.newRecoveryCodes(userId);
      });
      if (codes) onChange();
      return codes;
    },
    // Turns two-step off for an account (`actor` as in update(): your own, or someone you outrank).
    disableTwoStep(userId, { actor } = {}) {
      const who = resolveActor(actor);
      const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
      if (!target) return;
      needManage(who, target);
      transaction(db, () => {
        db.prepare("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = 0, totp_used_steps = '[]', totp_failures = 0, totp_locked_until = NULL, auth_version = auth_version + 1 WHERE id = ?").run(userId);
        db.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(userId);
        // A half-finished set-up must not survive: its secret would otherwise be there if two-step is turned on again.
        db.prepare("UPDATE sessions SET totp_pending = NULL WHERE user_id = ?").run(userId);
      });
      onChange();
    },

    // Wrong codes are counted per user, across every sign-in challenge: five in a row lock the second step for 15 minutes.
    totpLocked(userId) {
      const row = db.prepare("SELECT totp_locked_until FROM users WHERE id = ?").get(userId);
      return Boolean(row?.totp_locked_until && row.totp_locked_until > now());
    },
    recordTotpFailure(userId) {
      return transaction(db, () => {
        const row = db.prepare("SELECT totp_failures, totp_locked_until FROM users WHERE id = ?").get(userId);
        if (!row) return { locked: false };
        if (row.totp_locked_until && row.totp_locked_until > now()) return { locked: true };
        const failures = (row.totp_locked_until ? 0 : row.totp_failures) + 1; // an old lock that has run out starts a fresh count
        if (failures >= TOTP_MAX_FAILURES) {
          db.prepare("UPDATE users SET totp_failures = 0, totp_locked_until = ? WHERE id = ?").run(new Date(Date.now() + TOTP_LOCK_MS).toISOString(), userId);
          return { locked: true };
        }
        db.prepare("UPDATE users SET totp_failures = ?, totp_locked_until = NULL WHERE id = ?").run(failures, userId);
        return { locked: false };
      });
    },
    clearTotpFailures: (userId) => db.prepare("UPDATE users SET totp_failures = 0, totp_locked_until = NULL WHERE id = ?").run(userId),

    // Checks an authenticator code. A code is accepted once: its step is recorded atomically (every recent step is
    // remembered, so a code from the next step, used early, can't block the real current code).
    // The database lock refuses the check, unless `ignoreLock` is set: a browser the person signed in from before is
    // limited by its own counter instead (so strangers' wrong guesses can't lock the owner out of their own device).
    verifyTotp(userId, code, { ignoreLock = false } = {}) {
      if (!ignoreLock && store.totpLocked(userId)) return false;
      const row = db.prepare("SELECT totp_secret, totp_last_step, totp_used_steps FROM users WHERE id = ? AND totp_enabled_at IS NOT NULL").get(userId);
      if (!row?.totp_secret) return false;
      const secret = vault.open(row.totp_secret, totpLabel(userId));
      if (!secret) return false; // a secret that can't be opened must never match anything
      const used = usedSteps(row.totp_used_steps);
      const step = matchCode(secret, code, { afterStep: used.length ? 0 : row.totp_last_step, used });
      if (!step) return false;
      const keep = [...used.filter((s) => s >= step - 6), step];
      return db.prepare("UPDATE users SET totp_used_steps = ?, totp_last_step = max(totp_last_step, ?) WHERE id = ? AND totp_used_steps = ?").run(JSON.stringify(keep), step, userId, row.totp_used_steps).changes === 1;
    },
    // Uses up one recovery code. Returns true once per code. Codes are stored as an HMAC with the server secret.
    // The second-step lock does not block recovery codes: the caller limits them on their own.
    useRecoveryCode(userId, code) {
      const clean = normalizeRecoveryCode(code);
      if (clean.length !== 10) return false;
      return db.prepare("UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").run(now(), userId, vault.hmac(clean)).changes === 1;
    },
    // Replaces every recovery code with a new set; returns the codes (shown once). Clears the "old codes were removed" notice.
    newRecoveryCodes(userId) {
      const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
      db.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(userId);
      const ins = db.prepare("INSERT INTO user_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)");
      for (const code of codes) ins.run(userId, vault.hmac(normalizeRecoveryCode(code)), now());
      db.prepare("UPDATE users SET recovery_codes_reset = 0 WHERE id = ?").run(userId);
      return codes;
    },
  };
  return store;
}
