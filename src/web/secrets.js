// Secrets at rest: seals small values (two-step secrets, the email password) with AES-256-GCM.
// The key is APP_SECRET (64 hex characters) or a random file in the data folder, created on first use.
// A small "key check" file remembers which key sealed things, so a lost or replaced key is noticed at start-up.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "v1:"; // sealed with no label
const PREFIX_LABELLED = "v2:"; // sealed and bound to a label (such as the column and user it belongs to)
const CHECK_FILE = "key-check.txt";

const KEY_HELP = "Restore the original secret.key (or APP_SECRET) from your backup; sealed values cannot be read without it.";

function checkKeyBytes(key, where) {
  // An all-zero key is a placeholder or a damaged file, never a real random key.
  if (key.every((b) => b === 0)) throw new Error(`${where} does not hold a real key (it is all zeros). Restore it from a backup rather than editing it.`);
  return key;
}

function loadKey(dataDir) {
  const fromEnv = (process.env.APP_SECRET || "").trim();
  if (fromEnv) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv)) throw new Error("APP_SECRET must be 64 hex characters (for example: openssl rand -hex 32).");
    return { key: checkKeyBytes(Buffer.from(fromEnv, "hex"), "APP_SECRET"), created: false };
  }
  const file = path.join(dataDir, "secret.key");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    const hex = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return { key: checkKeyBytes(Buffer.from(hex, "hex"), file), created: false };
    throw new Error(`${file} is not a valid key file (expected 64 hex characters). Restore it from a backup rather than deleting it.`);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const key = crypto.randomBytes(32);
  try {
    // "wx": never replace a key another process just wrote.
    fs.writeFileSync(file, key.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    return { key, created: true };
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    return { key: Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex"), created: false };
  }
}

export function createSecrets(dataDir) {
  const { key, created } = loadKey(dataDir);
  // A separate key for HMACs, so one key is never used for two jobs.
  const macKey = crypto.createHmac("sha256", key).update("hmac-key").digest();
  // Identifies the key without revealing it.
  const fingerprint = crypto.createHmac("sha256", key).update("key-check").digest("hex").slice(0, 32);
  const checkPath = path.join(dataDir, CHECK_FILE);
  const readCheck = () => {
    try {
      return fs.readFileSync(checkPath, "utf8").trim();
    } catch {
      return "";
    }
  };
  const writeCheck = () => {
    try {
      fs.writeFileSync(checkPath, `${fingerprint}\n`, { mode: 0o600, flag: "wx" });
    } catch {
      // already there, or not writable: the check is advice only
    }
  };

  const isSealed = (v) => typeof v === "string" && (v.startsWith(PREFIX) || v.startsWith(PREFIX_LABELLED));
  const aad = (label) => Buffer.from(`blog-secret:${String(label ?? "")}`, "utf8");

  const api = {
    created, // true when the key was made just now
    fingerprint,
    isSealed,
    // Returns "v1:<iv>.<tag>.<data>" (base64url), or "v2:..." when a label is given: the label is bound into the seal,
    // so the value only opens for the same label (for example "users.totp_secret:7"). Empty input stays empty.
    seal(text, label) {
      const plain = String(text ?? "");
      if (!plain) return "";
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const labelled = label !== undefined && label !== null && label !== "";
      if (labelled) cipher.setAAD(aad(label));
      const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return `${labelled ? PREFIX_LABELLED : PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
    },
    // Reverses seal(). A "v2:" value needs the label it was sealed with. A value with no prefix is old plaintext and is returned
    // as it is, unless `{ allowPlain: false }` is passed (then it throws: after start-up sealing nothing should be plain).
    open(sealed, label, { allowPlain = true } = {}) {
      const s = String(sealed ?? "");
      const labelled = s.startsWith(PREFIX_LABELLED);
      if (!labelled && !s.startsWith(PREFIX)) {
        if (s && !allowPlain) throw new Error("Value is not sealed.");
        return s;
      }
      const [iv, tag, data] = s.slice(PREFIX.length).split(".");
      if (!iv || !tag || !data) throw new Error("Sealed value is damaged.");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      if (labelled) decipher.setAAD(aad(label));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    },
    hmac: (text) => crypto.createHmac("sha256", macKey).update(String(text ?? "")).digest("hex"),
    // Looks for sealed values this key cannot open (the key was lost, replaced or APP_SECRET changed). Returns a plain
    // sentence about it, or "". Also remembers the key's fingerprint the first time, so a later change is noticed.
    verify(db) {
      let problem = "";
      const recorded = readCheck();
      if (recorded && recorded !== fingerprint) {
        problem = `The encryption key is not the one this data was sealed with. Two-step sign-in and the email password will not work until it is back. ${KEY_HELP}`;
      }
      if (!problem && db) {
        const samples = [];
        try {
          for (const r of db.prepare("SELECT totp_secret AS v FROM users WHERE totp_secret LIKE 'v1:%' LIMIT 20").all()) samples.push(r.v);
          for (const r of db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").all()) {
            const v = JSON.parse(r.value);
            if (typeof v === "string" && v.startsWith(PREFIX)) samples.push(v);
          }
        } catch {
          // tables not there yet (a brand-new database): nothing sealed
        }
        for (const v of samples) {
          try {
            api.open(v);
          } catch {
            problem = `Saved two-step secrets or the email password cannot be read with the current encryption key. ${KEY_HELP}`;
            break;
          }
        }
      }
      if (!problem && !recorded) writeCheck();
      return problem;
    },
  };
  return api;
}
