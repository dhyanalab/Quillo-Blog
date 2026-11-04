// Rate-limiter counters kept in the database, so a restart doesn't give everyone a fresh allowance.
// The limiter (src/web/security.js) stores one entry per scope and key: { start, cur, prev } (times in ms).
const DEFAULT_KEEP_MS = 24 * 3600_000; // how long a row is kept when the caller doesn't say

export function createRateLimitStore(db) {
  const store = {
    get(scope, key) {
      const row = db.prepare("SELECT start, cur, prev, expires FROM rate_limits WHERE scope = ? AND key = ?").get(String(scope), String(key));
      return row ? { start: row.start, cur: row.cur, prev: row.prev, expires: row.expires } : null;
    },
    // `entry.expires` (absolute ms) says when the row may be deleted; without it the row is kept for a day.
    set(scope, key, entry) {
      const start = Math.floor(Number(entry.start) || Date.now());
      const expires = Math.floor(Number(entry.expires) || start + DEFAULT_KEEP_MS);
      db.prepare(`INSERT INTO rate_limits (scope, key, start, cur, prev, expires) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(scope, key) DO UPDATE SET start = excluded.start, cur = excluded.cur, prev = excluded.prev, expires = excluded.expires`)
        .run(String(scope), String(key), start, Math.floor(entry.cur) || 0, Math.floor(entry.prev) || 0, expires);
    },
    delete: (scope, key) => void db.prepare("DELETE FROM rate_limits WHERE scope = ? AND key = ?").run(String(scope), String(key)),
    // Removes rows whose time has passed. Returns how many.
    prune: (nowMs = Date.now()) => Number(db.prepare("DELETE FROM rate_limits WHERE expires < ?").run(nowMs).changes),
  };
  return store;
}
