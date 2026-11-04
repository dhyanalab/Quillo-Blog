// Reader accounts (members) and their comments. Members can only comment; staff accounts live in users.js.
import crypto from "node:crypto";
import { bind, now, transaction } from "../db.js";
import { DUMMY_HASH, hashPassword, needsRehash, verifyPassword } from "../web/password.js";
import { likeContains, nextId, randomHex, sha256 } from "./sql.js";

const SESSION_DAYS = 30; // absolute life of a reader session
const IDLE_DAYS = 14; // a session unused for this long is gone
const TOUCH_MS = 5 * 60_000; // last_seen_at is refreshed at most this often
const VERIFY_HOURS = 48;
const RESET_HOURS = 1;
const THREAD_TOP = 300; // a post page loads the newest 300 comments, and up to 300 of their newest replies
const THREAD_REPLIES = 300;
const MAX_SESSIONS = 10; // devices signed in at once per reader; the least recently used go first
const RESEND_MS = 15 * 60_000; // a new verify or reset link is issued only when the last one is older than this
const STALE_UNVERIFIED_DAYS = 3; // a sign-up that never confirmed is removed after this

export function createMemberStore(db, { onChange = () => {} } = {}) {
  const KINDS = {
    verify: { hash: "verify_token_hash", expires: "verify_expires", sent: "verify_sent_at", hours: VERIFY_HOURS },
    reset: { hash: "reset_token_hash", expires: "reset_expires", sent: "reset_sent_at", hours: RESET_HOURS },
  };
  // Issues a link token for the account, unless one went out in the last 15 minutes (then null).
  function issue(member, kind, force = false) {
    if (!member) return null;
    const k = KINDS[kind];
    const t = now();
    if (!force && member[k.hash] && member[k.expires] > t && member[k.sent] && Date.now() - Date.parse(member[k.sent]) < RESEND_MS) return null;
    const token = randomHex(16);
    db.prepare(`UPDATE members SET ${k.hash} = ?, ${k.expires} = ?, ${k.sent} = ? WHERE id = ?`).run(sha256(token), new Date(Date.now() + k.hours * 3600_000).toISOString(), t, member.id);
    return token;
  }
  // The account a live (unused, unexpired) link belongs to, without using it up.
  function byToken(kind, token) {
    if (!/^[0-9a-f]{32}$/.test(String(token))) return null;
    const k = KINDS[kind];
    return db.prepare(`SELECT * FROM members WHERE ${k.hash} = ? AND ${k.expires} > ?`).get(sha256(token), now()) || null;
  }

  const store = {
    get: (id) => (id ? db.prepare("SELECT * FROM members WHERE id = ?").get(id) || null : null),
    getByEmail: (email) => db.prepare("SELECT * FROM members WHERE email = ?").get(String(email || "").trim()) || null,
    count: () => db.prepare("SELECT COUNT(*) AS n FROM members").get().n,

    list({ q = "", status = "", limit = 50, offset = 0 } = {}) {
      const where = [];
      const params = { limit, offset };
      if (q) (where.push("(m.email LIKE :q ESCAPE '\\' OR m.name LIKE :q ESCAPE '\\')"), (params.q = likeContains(q)));
      if (status) (where.push("m.status = :status"), (params.status = status));
      const sql = `FROM members m ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
      const { limit: _l, offset: _o, ...countParams } = params;
      return {
        rows: db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM comments c WHERE c.member_id = m.id) AS comment_count ${sql} ORDER BY m.id DESC LIMIT :limit OFFSET :offset`).all(params),
        total: db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(countParams).n,
      };
    },

    // `verified: false` (the default) leaves the email unverified until the emailed link is used.
    // (Reader sign-up itself uses `signup`, which takes no password: the reader chooses one when verifying the email.)
    async create({ email, name, password, newsletter = false }, { verified = false } = {}) {
      const hash = await hashPassword(password);
      const t = now();
      const info = db.prepare(`INSERT INTO members (id, email, name, password_hash, newsletter, created_at, verified_at) VALUES (${nextId("members")}, ?, ?, ?, ?, ?, ?)`)
        .run(String(email).trim().toLowerCase(), String(name).trim(), hash, newsletter ? 1 : 0, t, verified ? t : null);
      return store.get(Number(info.lastInsertRowid));
    },
    // Reader sign-up: name and email only. Returns { member, token } for a new or still unverified address (the account
    // is left exactly as it was; `token` is the new verify link token, or null when one was sent in the last 15 minutes,
    // so nobody can keep replacing the link in the owner's inbox), and { member, token: null, existing: true } for a verified one.
    signup({ email, name, newsletter = false }) {
      const e = String(email).trim().toLowerCase();
      return transaction(db, () => {
        const row = db.prepare("SELECT * FROM members WHERE email = ?").get(e);
        if (row?.verified_at) return { member: row, token: null, existing: true };
        if (row) return { member: row, token: issue(row, "verify") };
        const info = db.prepare(`INSERT INTO members (id, email, name, password_hash, newsletter, created_at) VALUES (${nextId("members")}, ?, ?, '', ?, ?)`)
          .run(e, String(name).trim(), newsletter ? 1 : 0, now());
        const member = store.get(Number(info.lastInsertRowid));
        return { member, token: issue(member, "verify") };
      });
    },
    update(id, { name }) {
      db.prepare("UPDATE members SET name = ? WHERE id = ?").run(String(name).trim(), id);
    },
    // A new password ends every session and cancels any open reset link.
    async setPassword(id, password) {
      const hash = await hashPassword(password);
      transaction(db, () => {
        db.prepare("UPDATE members SET password_hash = ?, reset_token_hash = NULL, reset_expires = NULL, reset_sent_at = NULL WHERE id = ?").run(hash, id);
        db.prepare("DELETE FROM member_sessions WHERE member_id = ?").run(id);
      });
    },
    setStatus(id, status) {
      if (status !== "active" && status !== "banned") throw new Error("Unknown status");
      db.prepare("UPDATE members SET status = ? WHERE id = ?").run(status, id);
      if (status !== "active") db.prepare("DELETE FROM member_sessions WHERE member_id = ?").run(id);
    },
    // Deletes the account. Comments other people replied to stay as "Comment removed" (so the replies keep their place),
    // the rest go with the account. The newsletter subscription goes too, but only when the reader had verified the address
    // (an unverified sign-up proves nothing about who owns it) and never an "unsubscribed" record (that opt-out must stay).
    remove(id) {
      const member = store.get(id);
      if (!member) return { changes: 0 };
      const result = transaction(db, () => {
        db.prepare(`UPDATE comments SET status = 'deleted', body = '', member_id = NULL, user_id = NULL
                    WHERE member_id = ? AND EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = comments.id)`).run(id);
        const gone = member.verified_at ? db.prepare("DELETE FROM subscribers WHERE email = ? AND status IN ('active', 'pending')").run(member.email) : { changes: 0 };
        const info = db.prepare("DELETE FROM members WHERE id = ?").run(id);
        // Replies by this reader went with the account: a "Comment removed" shell left with nothing under it goes too,
        // and so do the likes on removed comments.
        db.prepare("DELETE FROM comments WHERE status = 'deleted' AND NOT EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = comments.id)").run();
        db.prepare("DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE status = 'deleted')").run();
        return { changes: Number(info.changes), subscribers: Number(gone.changes) };
      });
      onChange(); // the member's comments left public pages
      return result;
    },

    // Email + password. Unverified or unknown accounts get the same answer (null) as a wrong password.
    async authenticate(email, password) {
      const row = store.getByEmail(email);
      const ok = await verifyPassword(password, row?.password_hash || DUMMY_HASH);
      if (!row || !ok || !row.verified_at) return null;
      if (needsRehash(row.password_hash)) {
        const upgraded = await hashPassword(password).catch(() => null);
        if (upgraded) db.prepare("UPDATE members SET password_hash = ? WHERE id = ? AND password_hash = ?").run(upgraded, row.id, row.password_hash);
      }
      return row;
    },

    // Single-use links by email. The token is 128 random bits; only its sha256 is stored.
    // A new link replaces the old one only when no live link exists or the last was sent over 15 minutes ago;
    // otherwise these return null and no mail should be sent. `{ force: true }` (an administrator's explicit action) always issues one.
    startVerify: (id, { force = false } = {}) => issue(store.get(id), "verify", force),
    // Returns { member, token }: the member for an email address (or id), and a reset token, or null when one was sent lately.
    // An unknown address gives { member: null, token: null }.
    startReset(who, { force = false } = {}) {
      const member = typeof who === "number" ? store.get(who) : store.getByEmail(who);
      return { member, token: member ? issue(member, "reset", force) : null };
    },
    // Who a live (unused, unexpired) link belongs to, without using it up: for the page that asks for the new password.
    byVerifyToken: (token) => byToken("verify", token),
    byResetToken: (token) => byToken("reset", token),
    // Confirms the email behind a verify link and sets the reader's password in one step. The link is used up and every
    // older password and session is gone. Returns the member, or null when the link is wrong, used or expired.
    // Throws on a bad password before the link is used (and with code "BUSY" when the site is hashing too much).
    async verifyWithPassword(token, password) {
      if (!byToken("verify", token)) return null;
      const hash = await hashPassword(password);
      const t = now();
      const id = transaction(db, () => {
        const row = db.prepare(`UPDATE members SET password_hash = ?, verified_at = COALESCE(verified_at, ?), verify_token_hash = NULL, verify_expires = NULL, verify_sent_at = NULL,
                                reset_token_hash = NULL, reset_expires = NULL, reset_sent_at = NULL
                                WHERE verify_token_hash = ? AND verify_expires > ? RETURNING id`).get(hash, t, sha256(token), t);
        if (!row) return 0;
        db.prepare("DELETE FROM member_sessions WHERE member_id = ?").run(row.id);
        return row.id;
      });
      return id ? store.get(id) : null;
    },
    // Sets a new password from a reset link, ends every session and uses the link up. Returns the member or null.
    // The link is checked before any password work is done.
    async resetByToken(token, newPassword) {
      if (!byToken("reset", token)) return null;
      const hash = await hashPassword(newPassword); // throws on a bad password before the link is used
      const t = now();
      const id = transaction(db, () => {
        const row = db.prepare(`UPDATE members SET password_hash = ?, reset_token_hash = NULL, reset_expires = NULL, reset_sent_at = NULL,
                                verify_token_hash = NULL, verify_expires = NULL, verify_sent_at = NULL, verified_at = COALESCE(verified_at, ?)
                                WHERE reset_token_hash = ? AND reset_expires > ? RETURNING id`).get(hash, t, sha256(token), t);
        if (!row) return 0;
        db.prepare("DELETE FROM member_sessions WHERE member_id = ?").run(row.id);
        return row.id;
      });
      return id ? store.get(id) : null;
    },

    createSession(memberId) {
      const token = crypto.randomBytes(32).toString("base64url");
      const csrf = crypto.randomBytes(24).toString("base64url");
      const t = now();
      const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
      db.prepare("INSERT INTO member_sessions (id, member_id, csrf, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)").run(sha256(token), memberId, csrf, t, expires, t);
      db.prepare(`DELETE FROM member_sessions WHERE member_id = ? AND id NOT IN
                  (SELECT id FROM member_sessions WHERE member_id = ? ORDER BY COALESCE(last_seen_at, created_at) DESC, created_at DESC LIMIT ${MAX_SESSIONS})`).run(memberId, memberId);
      return { token, csrf, expires };
    },
    getSession(token) {
      if (!token) return null;
      const s = db.prepare("SELECT * FROM member_sessions WHERE id = ?").get(sha256(token));
      if (!s) return null;
      const t = now();
      const lastSeen = s.last_seen_at || s.created_at;
      if (s.expires_at < t || lastSeen < new Date(Date.now() - IDLE_DAYS * 864e5).toISOString()) {
        db.prepare("DELETE FROM member_sessions WHERE id = ?").run(s.id);
        return null;
      }
      const member = store.get(s.member_id);
      if (!member || member.status !== "active") return null;
      if (Date.now() - Date.parse(lastSeen) > TOUCH_MS) {
        db.prepare("UPDATE member_sessions SET last_seen_at = ? WHERE id = ?").run(t, s.id);
        s.last_seen_at = t;
      }
      if (!member.last_seen_at || Date.now() - Date.parse(member.last_seen_at) > 3600_000) db.prepare("UPDATE members SET last_seen_at = ? WHERE id = ?").run(t, member.id);
      return { session: s, member };
    },
    endSession: (token) => db.prepare("DELETE FROM member_sessions WHERE id = ?").run(sha256(token || "")),
    destroySession: (token) => store.endSession(token),
    endAllSessions: (memberId) => db.prepare("DELETE FROM member_sessions WHERE member_id = ?").run(memberId),
    // Sessions past their life or idle for too long. Also (so an hourly call to this one function is enough) the stale
    // pending rows removed by pruneUnverified and by subscribers.pruneExpired.
    pruneSessions() {
      const result = db.prepare("DELETE FROM member_sessions WHERE expires_at < ? OR COALESCE(last_seen_at, created_at) < ?").run(now(), new Date(Date.now() - IDLE_DAYS * 864e5).toISOString());
      store.pruneUnverified();
      db.prepare("DELETE FROM subscribers WHERE status = 'pending' AND created_at < ? AND (confirm_expires IS NULL OR confirm_expires < ?)").run(new Date(Date.now() - 3 * 864e5).toISOString(), new Date(Date.now() - 864e5).toISOString());
      return result;
    },
    // Sign-ups that never confirmed their email (no live link, older than 3 days) and have no comments are removed.
    // Verified reader accounts are never touched. Returns how many were removed.
    pruneUnverified() {
      const cut = new Date(Date.now() - STALE_UNVERIFIED_DAYS * 864e5).toISOString();
      return Number(db.prepare(`DELETE FROM members WHERE verified_at IS NULL AND created_at < ? AND (verify_expires IS NULL OR verify_expires < ?)
                               AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.member_id = members.id)`).run(cut, now()).changes);
    },
  };
  return store;
}

export function createCommentStore(db, { onChange }) {
  const SELECT = `SELECT c.*, m.name AS member_name, u.name AS staff_name, u.slug AS staff_slug,
      (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id = c.id) AS likes
    FROM comments c LEFT JOIN members m ON m.id = c.member_id LEFT JOIN users u ON u.id = c.user_id`;

  const store = {
    get: (id) => db.prepare(`${SELECT} WHERE c.id = ?`).get(id) || null,

    // Published comments for a post as a thread (one level of replies), oldest first.
    // A removed comment that still has replies is kept (status "deleted", empty body) so the replies keep their place.
    // A huge thread can't make every page slow: the newest 300 comments and up to 300 of their newest replies are loaded
    // (so a flood of old comments can't push newer ones out of sight). `total` is the real number of published comments.
    thread(postId) {
      const tops = db.prepare(`${SELECT} WHERE c.post_id = ? AND c.parent_id IS NULL AND c.status IN ('published', 'deleted') ORDER BY c.created_at DESC, c.id DESC LIMIT ${THREAD_TOP}`).all(postId).reverse();
      const replies = tops.length
        ? db.prepare(`${SELECT} WHERE c.post_id = ? AND c.status IN ('published', 'deleted') AND c.parent_id IN (SELECT value FROM json_each(?)) ORDER BY c.created_at DESC, c.id DESC LIMIT ${THREAD_REPLIES}`).all(postId, JSON.stringify(tops.map((r) => r.id))).reverse()
        : [];
      const top = tops.map((r) => ({ ...r, replies: [] }));
      const byId = new Map(top.map((r) => [r.id, r]));
      for (const r of replies) byId.get(r.parent_id)?.replies.push(r);
      // A removed comment with nothing left under it is not worth showing.
      const shown = top.filter((r) => r.status !== "deleted" || r.replies.length);
      const rows = [...tops, ...replies];
      return { comments: shown, count: rows.filter((r) => r.status === "published").length, total: store.countFor(postId) };
    },
    countFor: (postId) => db.prepare("SELECT COUNT(*) AS n FROM comments WHERE post_id = ? AND status = 'published'").get(postId).n,
    likedBy: (memberId, postId) => new Set(db.prepare("SELECT l.comment_id FROM comment_likes l JOIN comments c ON c.id = l.comment_id WHERE l.member_id = ? AND c.post_id = ?").all(memberId, postId).map((r) => r.comment_id)),

    // Admin list with the post title, newest first.
    list({ status = "", postId = 0, memberId = 0, limit = 50, offset = 0 } = {}) {
      const where = [];
      const params = { limit, offset };
      if (status) (where.push("c.status = :status"), (params.status = status));
      if (postId) (where.push("c.post_id = :postId"), (params.postId = postId));
      if (memberId) (where.push("c.member_id = :memberId"), (params.memberId = memberId));
      const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const { limit: _l, offset: _o, ...countParams } = params;
      return {
        rows: db.prepare(`SELECT x.*, p.title AS post_title, p.slug AS post_slug, m.email AS member_email FROM (${SELECT} ${w} ORDER BY c.id DESC LIMIT :limit OFFSET :offset) x
                          JOIN posts p ON p.id = x.post_id LEFT JOIN members m ON m.id = x.member_id`).all(params),
        total: db.prepare(`SELECT COUNT(*) AS n FROM comments c ${w}`).get(countParams).n,
      };
    },
    counts: () => db.prepare("SELECT SUM(status = 'published') AS published, SUM(status = 'pending') AS pending, SUM(status = 'hidden') AS hidden, SUM(status = 'deleted') AS deleted, COUNT(*) AS total FROM comments").get(),

    // Has this member had a comment approved before? Used by "approve first comments".
    hasApproved: (memberId) => Boolean(db.prepare("SELECT 1 FROM comments WHERE member_id = ? AND status = 'published' LIMIT 1").get(memberId)),

    // A reply must answer a published top-level comment on the same post (replies go one level deep); anything else throws.
    add({ postId, memberId = null, userId = null, parentId = null, body, status = "published" }) {
      if (parentId) {
        const parent = db.prepare("SELECT post_id, status, parent_id FROM comments WHERE id = ?").get(parentId);
        if (!parent || parent.status !== "published" || parent.post_id !== postId || parent.parent_id) {
          const err = new Error("The comment you are replying to isn't available");
          err.code = "PARENT_UNAVAILABLE";
          throw err;
        }
      }
      const info = db.prepare(`INSERT INTO comments (id, post_id, member_id, user_id, parent_id, body, status, created_at) VALUES (${nextId("comments")}, :postId, :memberId, :userId, :parentId, :body, :status, :at)`)
        .run(bind({ postId, memberId, userId, parentId, body, status, at: now() }));
      if (status === "published") onChange();
      return store.get(Number(info.lastInsertRowid));
    },
    setStatus(id, status) {
      // A removed comment stays removed.
      db.prepare("UPDATE comments SET status = ? WHERE id = ? AND status != 'deleted'").run(status, id);
      onChange();
    },
    // Deleting a comment that has replies leaves "Comment removed" in its place; otherwise it is deleted outright.
    remove(id) {
      transaction(db, () => {
        const row = db.prepare("SELECT parent_id FROM comments WHERE id = ?").get(id);
        if (!row) return;
        if (db.prepare("SELECT 1 FROM comments WHERE parent_id = ? LIMIT 1").get(id)) {
          db.prepare("UPDATE comments SET status = 'deleted', body = '', member_id = NULL, user_id = NULL WHERE id = ?").run(id);
          db.prepare("DELETE FROM comment_likes WHERE comment_id = ?").run(id);
          return;
        }
        db.prepare("DELETE FROM comments WHERE id = ?").run(id);
        // The last reply under a removed comment takes the empty shell with it.
        const p = row.parent_id && db.prepare("SELECT status FROM comments WHERE id = ?").get(row.parent_id);
        if (p?.status === "deleted" && !db.prepare("SELECT 1 FROM comments WHERE parent_id = ? LIMIT 1").get(row.parent_id)) {
          db.prepare("DELETE FROM comments WHERE id = ?").run(row.parent_id);
        }
      });
      onChange();
    },
    // Likes don't flush the page cache: a like count may be a few minutes old on a cached page.
    toggleLike(id, memberId) {
      return transaction(db, () => {
        const had = db.prepare("SELECT 1 FROM comment_likes WHERE comment_id = ? AND member_id = ?").get(id, memberId);
        if (had) db.prepare("DELETE FROM comment_likes WHERE comment_id = ? AND member_id = ?").run(id, memberId);
        else db.prepare("INSERT INTO comment_likes (comment_id, member_id) VALUES (?, ?)").run(id, memberId);
        return !had;
      });
    },
  };
  return store;
}
