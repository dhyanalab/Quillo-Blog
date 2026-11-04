// SQLite through Node's built-in driver: one file, no server. Migrations in src/migrations run in name order.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = path.join(import.meta.dirname, "migrations");
const quiet = Boolean(process.env.NODE_TEST_CONTEXT);

// The data folder and database files hold password hashes, two-step secrets and the email password: owner-only.
function lockDown(dataDir, file) {
  const targets = [[dataDir, 0o700], ...["", "-wal", "-shm"].map((x) => [`${file}${x}`, 0o600])];
  for (const [p, mode] of targets) {
    try {
      if (fs.existsSync(p)) fs.chmodSync(p, mode);
    } catch {
      // not supported on this file system (e.g. Windows): nothing to do
    }
  }
}

// options: { production, secrets, warnings, allowMigrationDrift, allowBackupFailure }. In production a changed
// update file or a failed pre-update copy stops the start-up (with the override named in the message); otherwise they only warn.
export function openDb(dataDir, options = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "blog.db");
  // Create the file owner-only before SQLite does, so it is never briefly world-readable.
  if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "a", 0o600));
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
  try {
    migrate(db, dataDir, options);
  } catch (err) {
    db.close();
    throw err;
  }
  lockDown(dataDir, file);
  return db;
}

const checksum = (sql) => crypto.createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");

function migrate(db, dataDir, options = {}) {
  const { production = false, warnings = [], allowMigrationDrift = false } = options;
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  if (!db.prepare("PRAGMA table_info(schema_migrations)").all().some((c) => c.name === "checksum")) {
    try {
      db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
    } catch (err) {
      // another process added it a moment ago
      if (!/duplicate column/i.test(String(err.message))) throw err;
    }
  }
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const sums = new Map(files.map((f) => [f, checksum(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"))]));
  const applied = db.prepare("SELECT id, checksum FROM schema_migrations").all();

  // A database made by a newer version (or a different program) must not be run against this code.
  const unknown = applied.filter((r) => !sums.has(r.id)).map((r) => r.id);
  if (unknown.length) {
    throw new Error(`This database was made by a newer version of the blog (unknown updates: ${unknown.join(", ")}). Update the blog's code, or restore a backup made by this version.`);
  }
  const drifted = [];
  for (const r of applied) {
    if (r.checksum === null) db.prepare("UPDATE schema_migrations SET checksum = ? WHERE id = ? AND checksum IS NULL").run(sums.get(r.id), r.id);
    else if (r.checksum !== sums.get(r.id)) drifted.push(r.id);
  }
  if (drifted.length) {
    const list = drifted.join(", ");
    // A changed update file means the database and the code may disagree about its shape: stop in production.
    if (production && !allowMigrationDrift) {
      throw new Error(`Database update ${list} was changed after it was applied, so the database may not match the code. Put the original update file back (or restore a backup made by this version). If you are sure it is fine, start once with ALLOW_MIGRATION_DRIFT=1.`);
    }
    const sentence = `Database update ${list} was changed after it was applied. The database may not match the code.`;
    console.warn(`Warning: ${sentence}`);
    warnings.push(sentence);
  }

  const done = new Set(applied.map((r) => r.id));
  const pending = files.filter((f) => !done.has(f));
  if (!pending.length) return;
  // An existing database is about to change shape: keep a copy of it first.
  if (done.size) backupBeforeMigrate(db, dataDir, options);
  for (const file of pending) {
    transaction(db, () => {
      // Read again inside the write lock: another process may have applied it while this one waited.
      if (db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(file)) return;
      db.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
      db.prepare("INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)").run(file, new Date().toISOString(), sums.get(file));
      if (!quiet) console.log(`Database updated: ${file}`);
    });
  }
}

// Pre-update copies are kept this long (the newest few always stay); each one is a full copy of the database.
const BACKUP_KEEP_MS = 30 * 86_400_000;
const BACKUP_KEEP_MIN = 3;

export function backupBeforeMigrate(db, dataDir, { production = false, secrets = null, warnings = [], allowBackupFailure = false } = {}) {
  let target = "";
  try {
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    target = path.join(dir, `before-update-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    // VACUUM INTO accepts an empty file: make it owner-only first, so the copy is never readable by others, even briefly.
    fs.closeSync(fs.openSync(target, "wx", 0o600));
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    fs.chmodSync(target, 0o600);
    scrubBackup(target, secrets);
    if (!quiet) console.log(`Database copy saved before updating: ${target}`);
    pruneBackups(dir, target);
  } catch (err) {
    if (target) {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // leave it
      }
    }
    const reason = String(err.message || err).split("\n")[0];
    if (production && !allowBackupFailure) {
      throw new Error(`Could not save a copy of the database before updating (${reason}). Nothing was changed. Free some disk space or check the data folder permissions and start again; if you want to update without a copy, start once with ALLOW_BACKUP_FAILURE=1.`);
    }
    const sentence = `Could not save a copy of the database before updating (${reason}).`;
    console.warn(`Warning: ${sentence}`);
    warnings.push(sentence);
  }
}

// The copy is a restore point, not a second home for secrets: sessions (with their addresses and browsers) are dropped,
// and authenticator secrets and the email password that are still plain text are sealed with the key.
function scrubBackup(file, secrets) {
  const copy = new DatabaseSync(file);
  try {
    for (const sql of ["DELETE FROM sessions", "DELETE FROM member_sessions"]) {
      try {
        copy.exec(sql);
      } catch {
        // table not there in a very old database
      }
    }
    if (secrets?.seal) {
      const isSealed = (v) => /^v[12]:/.test(String(v ?? ""));
      try {
        for (const r of copy.prepare("SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL AND totp_secret != ''").all()) {
          if (!isSealed(r.totp_secret)) copy.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(secrets.seal(r.totp_secret), r.id);
        }
        const row = copy.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get();
        const plain = row ? JSON.parse(row.value) : "";
        if (plain && !isSealed(plain)) copy.prepare("UPDATE settings SET value = ? WHERE key = 'smtp_pass'").run(JSON.stringify(secrets.seal(plain)));
      } catch {
        // columns from a later update are not there yet: nothing to seal
      }
    }
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }
}

// Old before-update copies are deleted after a while, always keeping the newest few and the one just made.
function pruneBackups(dir, keep) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^before-update-.*\.db$/.test(f)).sort().reverse();
    for (const f of files.slice(BACKUP_KEEP_MIN)) {
      const p = path.join(dir, f);
      if (p === keep) continue;
      if (Date.now() - fs.statSync(p).mtimeMs > BACKUP_KEEP_MS) fs.rmSync(p, { force: true });
    }
  } catch {
    // pruning is housekeeping: never stop the start-up for it
  }
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// node:sqlite rejects booleans and undefined; map them to 1/0 and NULL.
export function bind(values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) out[k] = v === undefined ? null : typeof v === "boolean" ? Number(v) : v;
  return out;
}

export const now = () => new Date().toISOString();
