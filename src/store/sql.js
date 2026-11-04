// Small helpers shared by the stores.
import crypto from "node:crypto";
import path from "node:path";

// A LIKE pattern that matches the text literally: % and _ typed by staff are not wildcards.
// Use it with: ... LIKE :q ESCAPE '\'
export const likeContains = (q) => `%${String(q).replace(/[\\%_]/g, "\\$&")}%`;

export const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
export const randomHex = (bytes = 16) => crypto.randomBytes(bytes).toString("hex");

// The secrets helper from the web layer ({ seal, open, hmac }). Without one (old callers, scripts),
// values stay as they are and recovery codes fall back to plain sha256.
export function secretsOrPlain(secrets) {
  if (secrets && typeof secrets.seal === "function" && typeof secrets.open === "function") {
    // A value that can't be opened (damaged, or sealed with another key) reads as empty rather than crashing a request.
    const open = (v, label) => {
      try {
        return secrets.open(v, label);
      } catch {
        return "";
      }
    };
    return { seal: secrets.seal, open, hmac: secrets.hmac || sha256, real: true };
  }
  return { seal: (s) => s, open: (s) => s, hmac: sha256, real: false };
}

export const isSealed = (v) => typeof v === "string" && (v.startsWith("v1:") || v.startsWith("v2:"));

// Ids that are never handed out twice. A table's next id is one above the highest id it ever held (kept in id_floor by
// triggers), not just one above what is in it now, so a stale form or old in-memory state can't land on a new row.
// Use it as an expression inside the INSERT itself: INSERT INTO t (id, ...) VALUES (${nextId("t")}, ...)
export const nextId = (table) =>
  `(SELECT max(COALESCE((SELECT max_id FROM id_floor WHERE tbl = '${table}'), 0), COALESCE((SELECT MAX(id) FROM ${table}), 0)) + 1)`;

// The folder that holds this database file ("" for an in-memory database).
export function dataDirOf(db) {
  try {
    const row = db.prepare("PRAGMA database_list").all().find((r) => r.name === "main");
    return row?.file ? path.dirname(row.file) : "";
  } catch {
    return "";
  }
}
