// Newsletter subscribers (each with a private unsubscribe link) and the newsletters sent to them.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bind, now, transaction } from "../db.js";
import { isEmail } from "../web/validate.js";
import { dataDirOf, likeContains, randomHex, secretsOrPlain, sha256 } from "./sql.js";

const CONFIRM_DAYS = 7;
const CONFIRM_RESEND_MS = 15 * 60_000; // a new confirmation link only when the last one is older than this
const MAX_ATTEMPTS = 3; // a recipient that fails this often is left out for good
const SUPPRESSION_FILE = "suppression-list.txt";

// Mail server messages often repeat the address; keep addresses out of stored and logged error text.
export const scrubAddresses = (text) => String(text ?? "").replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, "[address]");

// The subscriber row without its tokens, for lists, exports and everything handed to other code.
const PUBLIC_COLUMNS = "id, email, name, source, status, created_at, unsubscribed_at";

const coded = (message, code) => Object.assign(new Error(message), { code });
const addressHash = (email) => sha256(String(email).trim().toLowerCase());

export function createSubscriberStore(db, { secrets } = {}) {
  const vault = secretsOrPlain(secrets);
  const dataDir = dataDirOf(db);
  const listFile = dataDir ? path.join(dataDir, SUPPRESSION_FILE) : "";

  // Unsubscribe codes written before hashing existed were stored in clear text: keep only their sha256, once, at start-up.
  // Old links in sent emails still work (the link's code is hashed before it is looked up).
  for (const r of db.prepare("SELECT id, token FROM subscribers WHERE length(token) = 32").all()) {
    db.prepare("UPDATE subscribers SET token = ? WHERE id = ?").run(sha256(r.token), r.id);
  }

  // ---- The suppression list: a file of sha256(address) for everyone who unsubscribed, kept outside the database ----
  // so that restoring an older database can't bring an opt-out back (see applySuppressionList).
  let listCache = { mtime: -1, set: new Set() };
  const readList = () => {
    if (!listFile) return new Set();
    try {
      const mtime = fs.statSync(listFile).mtimeMs;
      if (mtime !== listCache.mtime) listCache = { mtime, set: new Set(fs.readFileSync(listFile, "utf8").split(/\r?\n/).filter((l) => /^[0-9a-f]{64}$/.test(l))) };
      return listCache.set;
    } catch {
      return new Set();
    }
  };
  const writeList = (set) => {
    const tmp = `${listFile}.tmp`;
    fs.writeFileSync(tmp, [...set].join("\n") + (set.size ? "\n" : ""), { mode: 0o600 });
    fs.renameSync(tmp, listFile);
  };
  const suppress = (email) => {
    if (!listFile) return;
    try {
      const hash = addressHash(email);
      if (readList().has(hash)) return;
      fs.appendFileSync(listFile, `${hash}\n`, { mode: 0o600 });
    } catch (err) {
      console.warn(`Warning: could not update ${SUPPRESSION_FILE} (${err.message}).`);
    }
  };
  const unsuppress = (email) => {
    if (!listFile) return;
    try {
      const set = new Set(readList());
      if (set.delete(addressHash(email))) writeList(set);
    } catch (err) {
      console.warn(`Warning: could not update ${SUPPRESSION_FILE} (${err.message}).`);
    }
  };

  // Consent history, append-only: what happened, to whom (a hash of the address), when, and from where.
  const record = (subscriberId, email, event, source = "") =>
    db.prepare("INSERT INTO subscriber_events (subscriber_id, email_hash, event, source, created_at) VALUES (?, ?, ?, ?, ?)").run(subscriberId, addressHash(email), event, String(source).slice(0, 200), now());

  const raw = (id) => db.prepare("SELECT * FROM subscribers WHERE id = ?").get(id) || null;

  // The keyed part of an unsubscribe link. With the site's secret it is an HMAC; without one (old scripts) it is
  // keyed by the row's own stored code, which is never handed out.
  const macFor = (id, year) => {
    if (vault.real) return vault.hmac(`unsub:${id}:${year}`);
    const row = db.prepare("SELECT token FROM subscribers WHERE id = ?").get(id);
    return sha256(`unsub:${id}:${year}:${row?.token ?? ""}`);
  };

  const store = {
    // Adds an address. Returns { status, created, subscriber } and, when a confirmation email is due, `token` (also as `confirmToken`):
    // the raw link token. A throwing call (code "INVALID_EMAIL") means the address isn't a valid one.
    // - new address: "pending" until the emailed link is confirmed, or "active" at once when `confirmed` is true (an administrator adding it)
    // - active address: left as it is
    // - unsubscribed address: never changed here; only `resubscribe` or the person's own link brings it back
    // - pending address: `confirmed` activates it; otherwise it gets a fresh confirmation link only when the last one is over
    //   15 minutes old (else { status: "pending", token: null }: send no mail)
    add(email, source = "", options = {}) {
      const { confirmed = false, name = "" } = typeof options === "string" ? { name: options } : options || {};
      const e = String(email ?? "").trim().toLowerCase();
      if (!isEmail(e)) throw coded("That email address isn't valid", "INVALID_EMAIL");
      return transaction(db, () => {
        const existing = db.prepare("SELECT * FROM subscribers WHERE email = ?").get(e);
        if (existing) {
          if (existing.status === "pending") {
            if (confirmed) {
              db.prepare("UPDATE subscribers SET status = 'active', unsubscribed_at = NULL, confirm_token_hash = NULL, confirm_expires = NULL, confirm_sent_at = NULL WHERE id = ?").run(existing.id);
              record(existing.id, e, "admin-add", source);
              return result("active", false, store.get(existing.id));
            }
            return result("pending", false, store.get(existing.id), store.startConfirm(existing.id));
          }
          return result(existing.status, false, store.get(existing.id));
        }
        const nameText = String(name).slice(0, 80);
        const sourceText = String(source).slice(0, 200);
        const codeHash = sha256(randomHex(16)); // never used for links (those are keyed); the column may not be empty
        const insert = (status) =>
          Number(db.prepare("INSERT INTO subscribers (email, name, source, status, token, created_at, unsubscribed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(e, nameText, sourceText, status, codeHash, now(), status === "unsubscribed" ? now() : null).lastInsertRowid);
        // An address that opted out earlier stays opted out, even if its row was removed or the database restored.
        if (confirmed && readList().has(addressHash(e))) {
          const id = insert("unsubscribed");
          return result("unsubscribed", true, store.get(id));
        }
        if (confirmed) {
          const id = insert("active");
          record(id, e, "admin-add", sourceText);
          return result("active", true, store.get(id));
        }
        const id = insert("pending");
        record(id, e, "add", sourceText);
        return result("pending", true, store.get(id), store.startConfirm(id));
      });
    },
    // A fresh confirmation token (valid 7 days; only its sha256 is stored). Returns the raw token, or null when a live one
    // was sent less than 15 minutes ago (or the address isn't pending). `{ force: true }` always issues one.
    startConfirm(id, { force = false } = {}) {
      const row = raw(id);
      if (!row || row.status !== "pending") return null;
      const t = now();
      if (!force && row.confirm_token_hash && row.confirm_expires > t && row.confirm_sent_at && Date.now() - Date.parse(row.confirm_sent_at) < CONFIRM_RESEND_MS) return null;
      const token = randomHex(16);
      db.prepare("UPDATE subscribers SET confirm_token_hash = ?, confirm_expires = ?, confirm_sent_at = ? WHERE id = ? AND status = 'pending'").run(sha256(token), new Date(Date.now() + CONFIRM_DAYS * 864e5).toISOString(), t, id);
      return token;
    },
    // Confirms a pending address from its emailed link. Returns the subscriber, or null (wrong, used or expired link).
    // An unsubscribed address is never brought back by a confirm token. Confirming is fresh consent, so an older opt-out
    // record for the address is cleared.
    confirm(confirmToken) {
      if (!/^[0-9a-f]{32}$/.test(String(confirmToken))) return null;
      const row = db.prepare(`UPDATE subscribers SET status = 'active', unsubscribed_at = NULL, confirm_token_hash = NULL, confirm_expires = NULL, confirm_sent_at = NULL
                              WHERE confirm_token_hash = ? AND confirm_expires > ? AND status = 'pending' RETURNING id, email, source`).get(sha256(confirmToken), now());
      if (!row) return null;
      record(row.id, row.email, "confirm", row.source);
      unsuppress(row.email);
      return store.get(row.id);
    },
    get: (id) => db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM subscribers WHERE id = ?`).get(id) || null,
    getByEmail: (email) => db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM subscribers WHERE email = ?`).get(String(email || "").trim().toLowerCase()) || null,
    // The unsubscribe code for one subscriber: a keyed (HMAC) token for a calendar year, 40 hex characters
    // (32 of the MAC, then the subscriber id). It is accepted for that year and the next.
    unsubscribeToken(subscriber, year = new Date().getUTCFullYear()) {
      const id = Number(subscriber?.id ?? subscriber);
      if (!Number.isInteger(id) || id < 1) return "";
      return macFor(id, year).slice(0, 32) + id.toString(16).padStart(8, "0");
    },
    // The subscriber behind an unsubscribe code, or null. Accepts the keyed tokens of this year and last year,
    // and the old random codes in links that were already emailed (those are looked up by their hash).
    byUnsubscribeToken(t) {
      const text = String(t ?? "");
      if (/^[0-9a-f]{32}$/.test(text)) {
        return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM subscribers WHERE token = ? OR token = ?`).get(sha256(text), text) || null;
      }
      if (!/^[0-9a-f]{40}$/.test(text)) return null;
      const id = parseInt(text.slice(32), 16);
      if (!id || !raw(id)) return null;
      const year = new Date().getUTCFullYear();
      const given = Buffer.from(text.slice(0, 32));
      const ok = [year, year - 1].some((y) => crypto.timingSafeEqual(given, Buffer.from(macFor(id, y).slice(0, 32))));
      return ok ? store.get(id) : null;
    },
    byToken: (t) => store.byUnsubscribeToken(t),
    count: () => db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'active'").get().n,
    pendingCount: () => db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'pending'").get().n,
    counts: () => db.prepare(`SELECT COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(status = 'unsubscribed'), 0) AS unsubscribed, COALESCE(SUM(status = 'pending'), 0) AS pending,
                              COALESCE(SUM(status = 'active' AND created_at >= ?), 0) AS recent, COUNT(*) AS total FROM subscribers`).get(new Date(Date.now() - 30 * 864e5).toISOString()),
    list({ q = "", status = "", limit = 100, offset = 0 } = {}) {
      const where = [];
      const params = { limit, offset };
      if (q) (where.push("(email LIKE :q ESCAPE '\\' OR name LIKE :q ESCAPE '\\')"), (params.q = likeContains(q)));
      if (status) (where.push("status = :status"), (params.status = status));
      const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const { limit: _l, offset: _o, ...countParams } = params;
      return {
        rows: db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM subscribers ${w} ORDER BY id DESC LIMIT :limit OFFSET :offset`).all(params),
        total: db.prepare(`SELECT COUNT(*) AS n FROM subscribers ${w}`).get(countParams).n,
      };
    },
    // Every subscriber, without tokens. Pass `{ limit, offset }` to page through a big list.
    all: ({ limit = -1, offset = 0 } = {}) => db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM subscribers ORDER BY id LIMIT ? OFFSET ?`).all(limit, offset),
    unsubscribe(id) {
      const row = raw(id);
      const done = db.prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?, confirm_token_hash = NULL, confirm_expires = NULL, confirm_sent_at = NULL WHERE id = ? AND status IN ('active', 'pending')").run(now(), id);
      if (done.changes && row) {
        record(row.id, row.email, "unsubscribe", "");
        suppress(row.email);
      }
      return done;
    },
    // Brings an unsubscribed (or pending) address back: the admin's explicit "Resubscribe", or the person's own link.
    resubscribe(id) {
      const row = raw(id);
      const done = db.prepare("UPDATE subscribers SET status = 'active', unsubscribed_at = NULL, confirm_token_hash = NULL, confirm_expires = NULL, confirm_sent_at = NULL WHERE id = ?").run(id);
      if (done.changes && row) {
        record(row.id, row.email, "resubscribe", "");
        unsuppress(row.email);
      }
      return done;
    },
    remove: (id) => db.prepare("DELETE FROM subscribers WHERE id = ?").run(id),
    // Removes the subscriber with this address (used when a reader account is deleted). An opt-out record is never removed.
    removeByEmail: (email) => db.prepare("DELETE FROM subscribers WHERE email = ? AND status != 'unsubscribed'").run(String(email || "").trim().toLowerCase()),
    // Pending addresses that never confirmed (link expired over a day ago, older than 3 days) are removed. Returns how many.
    prunePending: () => store.pruneExpired(),
    pruneExpired: () =>
      Number(db.prepare("DELETE FROM subscribers WHERE status = 'pending' AND created_at < ? AND (confirm_expires IS NULL OR confirm_expires < ?)")
        .run(new Date(Date.now() - 3 * 864e5).toISOString(), new Date(Date.now() - 864e5).toISOString()).changes),

    // Called once at start-up, after the database is migrated. Everyone in the suppression file who is still active or
    // pending is marked unsubscribed (so restoring an older database can't bring an opt-out back), and everyone already
    // unsubscribed is added to the file (so it is complete from the first run). Returns how many rows it changed.
    applySuppressionList() {
      if (!listFile) return 0;
      let changed = 0;
      const set = new Set(readList());
      let added = false;
      for (const r of db.prepare("SELECT id, email, status FROM subscribers").all()) {
        const h = addressHash(r.email);
        if (r.status === "unsubscribed") {
          if (!set.has(h)) (set.add(h), (added = true));
        } else if (set.has(h)) {
          db.prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?, confirm_token_hash = NULL, confirm_expires = NULL, confirm_sent_at = NULL WHERE id = ?").run(now(), r.id);
          record(r.id, r.email, "unsubscribe", "suppression list");
          changed++;
        }
      }
      try {
        if (added) writeList(set);
      } catch (err) {
        console.warn(`Warning: could not write ${SUPPRESSION_FILE} (${err.message}).`);
      }
      return changed;
    },
  };

  function result(status, created, subscriber, confirmToken = null) {
    const out = { status, created, subscriber, token: confirmToken, confirmToken };
    if (confirmToken) out.subscriber = { ...subscriber, confirm_token: confirmToken };
    return out;
  }

  return store;
}

// Counts come from newsletter_sends, so they are always right, even after a retry.
const COUNTS = `(SELECT COUNT(*) FROM newsletter_sends q WHERE q.newsletter_id = n.id AND q.status = 'sent') AS sent_n,
  (SELECT COUNT(*) FROM newsletter_sends q WHERE q.newsletter_id = n.id AND q.status = 'failed') AS failed_n,
  (SELECT COUNT(*) FROM newsletter_sends q WHERE q.newsletter_id = n.id AND q.status = 'queued') AS queued_n`;

export function createNewsletterStore(db) {
  const hydrate = (r) => {
    if (!r) return null;
    let postIds = [];
    try {
      postIds = JSON.parse(r.post_ids || "[]").map(Number).filter(Boolean);
    } catch {}
    return { ...r, postIds };
  };
  const store = {
    get: (id) => hydrate(db.prepare(`SELECT n.*, ${COUNTS} FROM newsletters n WHERE n.id = ?`).get(id)),
    list: () => db.prepare(`SELECT n.*, ${COUNTS} FROM newsletters n ORDER BY COALESCE(n.sent_at, n.updated_at) DESC, n.id DESC LIMIT 100`).all().map(hydrate),
    lastSent: () => hydrate(db.prepare("SELECT * FROM newsletters WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1").get()),
    totals: () => db.prepare("SELECT (SELECT COUNT(*) FROM newsletters WHERE status = 'sent') AS sent, (SELECT COUNT(*) FROM newsletter_sends WHERE status = 'sent') AS emails").get(),
    save(input, id = 0, userId = null) {
      const t = now();
      const v = bind({ subject: input.subject, preheader: input.preheader, body_md: input.body_md, post_ids: JSON.stringify(input.postIds || []), t });
      if (id) db.prepare("UPDATE newsletters SET subject = :subject, preheader = :preheader, body_md = :body_md, post_ids = :post_ids, updated_at = :t WHERE id = :id AND status = 'draft'").run({ ...v, id });
      else id = Number(db.prepare("INSERT INTO newsletters (subject, preheader, body_md, post_ids, created_by, created_at, updated_at) VALUES (:subject, :preheader, :body_md, :post_ids, :uid, :t, :t)").run({ ...v, uid: userId }).lastInsertRowid);
      return store.get(id);
    },
    remove: (id) => db.prepare("DELETE FROM newsletters WHERE id = ? AND status != 'sending'").run(id),

    // Queues every active subscriber (never pending or unsubscribed ones) and marks the newsletter as sending.
    // Only a draft (or a failed newsletter) can be queued; returns true, or false when it can't be (the number queued is in `recipients`).
    queue(id) {
      return transaction(db, () => {
        const t = now();
        const claimed = db.prepare("UPDATE newsletters SET status = 'sending', last_error = '', started_at = ?, sent_at = NULL, updated_at = ? WHERE id = ? AND status IN ('draft', 'failed')").run(t, t, id);
        if (claimed.changes !== 1) return false;
        db.prepare("INSERT OR IGNORE INTO newsletter_sends (newsletter_id, subscriber_id) SELECT ?, id FROM subscribers WHERE status = 'active'").run(id);
        const n = db.prepare("SELECT COUNT(*) AS n FROM newsletter_sends WHERE newsletter_id = ?").get(id).n;
        db.prepare("UPDATE newsletters SET recipients = ? WHERE id = ?").run(n, id);
        return true;
      });
    },
    // Puts failed emails back in the queue for another try (and gives each another three attempts).
    // Returns how many were put back. A newsletter with nothing failed and nothing waiting is left exactly as it was
    // (its status and finish time are not touched).
    retry(id) {
      return transaction(db, () => {
        const requeued = db.prepare("UPDATE newsletter_sends SET status = 'queued', error = '', attempts = 0 WHERE newsletter_id = ? AND status = 'failed'").run(id).changes;
        const waiting = db.prepare("SELECT COUNT(*) AS n FROM newsletter_sends WHERE newsletter_id = ? AND status = 'queued'").get(id).n;
        if (requeued || waiting) db.prepare("UPDATE newsletters SET status = 'sending', last_error = '' WHERE id = ? AND status IN ('failed', 'sent', 'sending')").run(id);
        return Number(requeued);
      });
    },
    // The next people waiting for this newsletter (who haven't unsubscribed since). Fewest attempts first;
    // recipients that already failed three times are skipped (they are marked failed for good by `mark`).
    nextBatch: (id, limit = 10) =>
      db.prepare(`SELECT s.id, s.email, s.name, s.source, s.status, s.created_at, s.unsubscribed_at FROM newsletter_sends q JOIN subscribers s ON s.id = q.subscriber_id
                  WHERE q.newsletter_id = ? AND q.status = 'queued' AND s.status = 'active' AND q.attempts < ${MAX_ATTEMPTS}
                  ORDER BY q.attempts, s.id LIMIT ?`).all(id, limit),
    // Records one send attempt. A failure counts toward the three tries; the third one fails the recipient for good.
    // `{ permanent: true }` (the mail server refused this address for good) fails the recipient at once.
    mark(id, subscriberId, ok, error = "", { permanent = false } = {}) {
      const text = scrubAddresses(error).slice(0, 300);
      const t = now();
      if (ok) {
        db.prepare("UPDATE newsletter_sends SET status = 'sent', error = '', attempts = attempts + 1, sent_at = ? WHERE newsletter_id = ? AND subscriber_id = ?").run(t, id, subscriberId);
        return;
      }
      db.prepare(`UPDATE newsletter_sends SET attempts = attempts + 1, error = ?, sent_at = ?,
                  status = CASE WHEN ? = 1 OR attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE status END
                  WHERE newsletter_id = ? AND subscriber_id = ?`).run(text, t, permanent ? 1 : 0, id, subscriberId);
      db.prepare("UPDATE newsletters SET last_error = ? WHERE id = ?").run(text, id);
    },
    // Stops sending after repeated failures; the rest stay queued for "Try again".
    halt: (id, error) => db.prepare("UPDATE newsletters SET status = 'failed', last_error = ? WHERE id = ?").run(scrubAddresses(error).slice(0, 300), id),
    // Done: people who unsubscribed while it was sending are dropped from the list, and the finish time is stamped.
    finish(id) {
      db.prepare(`DELETE FROM newsletter_sends WHERE newsletter_id = ? AND status = 'queued'
                  AND subscriber_id IN (SELECT id FROM subscribers WHERE status != 'active')`).run(id);
      const n = store.get(id);
      if (!n) return;
      db.prepare("UPDATE newsletters SET status = ?, recipients = ?, sent_at = ? WHERE id = ?").run(n.sent_n === 0 && n.failed_n > 0 ? "failed" : "sent", n.sent_n + n.failed_n, now(), id);
    },
    sending: () => db.prepare("SELECT id FROM newsletters WHERE status = 'sending'").all().map((r) => r.id),
    failures: (id) => db.prepare("SELECT s.email, q.error FROM newsletter_sends q JOIN subscribers s ON s.id = q.subscriber_id WHERE q.newsletter_id = ? AND q.status = 'failed' LIMIT 50").all(id),
  };
  return store;
}
