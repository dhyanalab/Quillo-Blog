// Staff accounts from the command line, for when nobody can sign in.
//   npm run user -- list
//   npm run user -- where                                (which data folder and database this tool is using, and what is in it)
//   npm run user -- reset you@example.com [--activate]   (prints a new random password; a suspended account stays suspended unless --activate)
//   npm run user -- reset-2fa you@example.com            (turns off two-step sign-in, e.g. after losing the phone)
//   npm run user -- create you@example.com "Your Name" [admin|editor|author|contributor]
//   npm run user -- create you@example.com "Your Name" owner --force
//   npm run user -- end-sessions you@example.com         (signs one person out everywhere)
//   npm run user -- end-sessions --all                   (signs every staff member and reader out, e.g. after a restore)
// It works on the database in DATA_DIR (default ./data) and never creates one: a wrong DATA_DIR stops here instead of starting an empty site.
// It also refuses to change the database's layout: if the blog's code is newer than the database, start the blog once (it keeps a copy first)
// or, with the blog stopped, add --migrate.
// Every change made here is also written to <DATA_DIR>/audit.log (the same file the admin writes to).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, ROOT } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createStore } from "../src/store/index.js";
import { ROLES } from "../src/store/users.js";
import { createSecrets } from "../src/web/secrets.js";
import { isEmail, normalizeEmail } from "../src/web/validate.js";

const USAGE = 'Usage:\n  npm run user -- list\n  npm run user -- where\n  npm run user -- reset <email> [--activate]\n  npm run user -- reset-2fa <email>\n  npm run user -- create <email> "<name>" [admin|editor|author|contributor]\n  npm run user -- create <email> "<name>" owner --force\n  npm run user -- end-sessions <email>\n  npm run user -- end-sessions --all\nA name that starts with -- goes after a lone --, for example: create <email> -- "--odd name"';
const FLAGS = ["--force", "--activate", "--all", "--dev", "--migrate"];

// Anything printed to the terminal comes from the database, so control characters (escape sequences, bidi tricks) are dropped.
const clean = (s) => String(s ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
const fail = (msg) => {
  console.error(clean(msg));
  process.exit(1);
};

// Everything after a lone "--" is plain text, never an option.
const raw = process.argv.slice(2);
const stop = raw.indexOf("--");
const optionArgs = stop < 0 ? raw : raw.slice(0, stop);
const afterStop = stop < 0 ? [] : raw.slice(stop + 1);
const flags = new Set(optionArgs.filter((a) => a.startsWith("--")));
const unknown = [...flags].filter((f) => !FLAGS.includes(f));
if (unknown.length) fail(`Unknown option ${unknown.join(", ")}.\n${USAGE}`);
const [cmd, who, name, role = "author"] = [...optionArgs.filter((a) => !a.startsWith("--")), ...afterStop];
if (!["list", "where", "reset", "reset-2fa", "create", "end-sessions"].includes(cmd)) {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}

const config = loadConfig();
const dbFile = path.join(config.dataDir, "blog.db");
if (!fs.existsSync(dbFile)) fail(`No database at ${clean(dbFile)}.\nThis tool never creates one. Check DATA_DIR (the folder that holds blog.db), or start the server once to create a new site.`);
if (!process.env.APP_SECRET && !fs.existsSync(path.join(config.dataDir, "secret.key"))) {
  fail(`There is no secret.key next to ${clean(dbFile)} and APP_SECRET is not set.\nIf you restored a backup, put the original secret.key (or APP_SECRET) back first; a new key could not read the saved two-step secrets and email password.`);
}

// The blog's own start-up applies database updates (after saving a copy). This tool only looks: if updates are waiting it stops,
// because changing the layout under a running blog that still holds the old one could break it.
function pendingUpdates() {
  const files = fs.readdirSync(path.join(ROOT, "src", "migrations")).filter((f) => f.endsWith(".sql")).sort();
  let applied = [];
  const peek = new DatabaseSync(dbFile, { readOnly: true });
  try {
    applied = peek.prepare("SELECT id FROM schema_migrations").all().map((r) => r.id);
  } catch {
    applied = [];
  } finally {
    peek.close();
  }
  return files.filter((f) => !applied.includes(f));
}
const pending = pendingUpdates();
if (pending.length && !flags.has("--migrate")) {
  fail(`This database needs updates from this version of the blog (${pending.join(", ")}).\nStart the blog once so it can apply them (it saves a copy of the database first), then run this again.\nIf the blog is stopped, you can add --migrate to apply them from here.`);
}
console.error(`Using database: ${clean(dbFile)}`);
const secrets = createSecrets(config.dataDir);
const db = openDb(config.dataDir);
const store = createStore(db, { basePath: config.basePath, secrets });
// Does the encryption key match this database? A wrong key would lock people with two-step sign-in out.
const keyProblem = secrets.verify(db);
if (keyProblem) console.error(`WARNING: ${clean(keyProblem)}`);
else console.error("Encryption key: matches this database.");
const password = () => crypto.randomBytes(12).toString("base64url");
const SYSTEM = { actor: "system" };

// A record of what was done here, in the same form the admin uses: a console line and a JSON line in <DATA_DIR>/audit.log.
function audit(message, extra = {}) {
  console.log(`[audit] ${clean(message)}`);
  try {
    fs.appendFileSync(path.join(config.dataDir, "audit.log"), `${JSON.stringify({ at: new Date().toISOString(), message: clean(message), source: "command line", ...extra })}
`, { mode: 0o600 });
  } catch {}
}

// A password chosen here is known to the operator, so it is temporary: the person must choose their own at the next sign-in,
// and it stops working after 7 days.
function markTemporary(id) {
  store.db.prepare("UPDATE users SET password_must_change = 1 WHERE id = ?").run(id);
  try {
    store.db.prepare("UPDATE users SET password_set_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  } catch {
    // an older layout without that column
  }
}

// Emails are stored in lower case; older accounts may not be, so try both spellings.
const findUser = (e) => store.users.getByEmail(normalizeEmail(e)) || store.users.getByEmail(String(e ?? "").trim());
const needUser = () => {
  const user = who && findUser(who);
  if (!user) fail(`No account with the email ${clean(who)}`);
  return user;
};

if (cmd === "list") {
  for (const u of store.users.list()) console.log(`${clean(u.role).padEnd(12)} ${clean(u.email).padEnd(32)} ${clean(u.name)}${u.status === "suspended" ? " (suspended)" : ""}`);
} else if (cmd === "where") {
  const one = (sql) => {
    try {
      return store.db.prepare(sql).get().n;
    } catch {
      return "?";
    }
  };
  const mediaDir = path.join(config.dataDir, "media");
  console.log(`Data folder:   ${clean(config.dataDir)}`);
  console.log(`Database:      ${clean(dbFile)} (${(fs.statSync(dbFile).size / 1024).toFixed(0)} KB)`);
  console.log(`Staff:         ${one("SELECT COUNT(*) AS n FROM users")} account(s), owner ${store.users.hasOwner() ? "exists" : "does NOT exist yet"}`);
  console.log(`Posts:         ${one("SELECT COUNT(*) AS n FROM posts")}   Readers: ${one("SELECT COUNT(*) AS n FROM members")}   Subscribers: ${one("SELECT COUNT(*) AS n FROM subscribers")}`);
  console.log(`Uploads:       ${one("SELECT COUNT(*) AS n FROM media")} in the library; media folder ${fs.existsSync(mediaDir) ? "found" : "NOT FOUND"}`);
  console.log("If these numbers look empty for a site that has content, DATA_DIR is probably pointing at the wrong folder.");
} else if (cmd === "reset" && who) {
  const user = needUser();
  const pw = password();
  await store.users.setPassword(user.id, pw, { ...SYSTEM, mustChange: true });
  markTemporary(user.id);
  store.users.endAllSessions(user.id, SYSTEM);
  if (flags.has("--activate")) store.users.update(user.id, { status: "active" }, SYSTEM);
  audit(`password set by the command line: user ${user.id} (${user.email})`);
  if (flags.has("--activate")) audit(`suspension lifted by the command line: user ${user.id}`);
  const note = user.status === "suspended" ? (flags.has("--activate") ? "The account was suspended and is now active again." : "The account is still suspended. Add --activate to lift the suspension.") : "";
  console.log(`New password for ${clean(user.email)}: ${pw}\nIt is temporary: they must choose their own at the next sign-in, and it stops working after 7 days.\nAll their sessions were signed out, and any sign-in in progress can no longer be finished.${note ? `\n${note}` : ""}`);
  console.log("If the blog is running and the person typed a wrong password several times just before, the running blog can keep refusing for up to 15 minutes. Restarting the blog clears that.");
} else if (cmd === "reset-2fa" && who) {
  const user = needUser();
  store.users.disableTwoStep(user.id, SYSTEM);
  store.users.endAllSessions(user.id, SYSTEM);
  audit(`two-step sign-in reset: user ${user.id} (${user.email}) by the command line`);
  console.log(`Two-step sign-in is off for ${clean(user.email)}. They can sign in with their password and set it up again.\nAll their sessions were signed out.`);
} else if (cmd === "create" && who && name) {
  const email = normalizeEmail(who);
  if (!isEmail(email)) fail(`"${clean(who)}" is not a valid email address.`);
  const displayName = clean(name).replace(/\s+/g, " ").trim().slice(0, 80);
  if (!displayName) fail("The name needs at least one visible character.");
  if (!ROLES.includes(role)) fail(`Role must be one of: ${ROLES.join(", ")}`);
  if (role === "owner" && !flags.has("--force")) fail("The owner has full control of the site. To add another owner, repeat the command with --force.");
  if (findUser(email)) fail(`${email} already has an account. Use: npm run user -- reset ${email}`);
  const pw = password();
  const made = await store.users.create({ email, password: pw, name: displayName, role }, { mustChange: true, ...SYSTEM });
  if (made?.id) markTemporary(made.id);
  audit(`staff account created: user ${made?.id ?? "?"} (${role}) by the command line`);
  console.log(`Created ${role} ${email} with password: ${pw}\nThey must choose a new password when they first sign in, and this one stops working after 7 days.`);
} else if (cmd === "end-sessions" && (who || flags.has("--all"))) {
  // Sessions are deleted, and the sign-in version of each account is raised, so a two-step challenge that is already open
  // in the running blog can no longer be finished either.
  if (flags.has("--all")) {
    // Every staff session ends, every account's sign-in version goes up, and every recovery code is removed (a restored backup can
    // bring back codes that were already used); people are asked to create new ones.
    const staff = store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
    store.users.revokeAccess(null, SYSTEM);
    const readers = store.db.prepare("DELETE FROM member_sessions").run().changes;
    audit("sessions ended for every staff member and reader by the command line");
    console.log(`Signed out everyone: ${staff} staff session(s) and ${readers} reader session(s) ended.`);
    console.log("Every recovery code was removed too (a restored backup can bring back codes that were already used). People with two-step sign-in are asked to create new ones at their next sign-in. If a restore also brought back an old authenticator secret, use 'reset-2fa' for that account.");
  } else {
    const user = needUser();
    const n = store.users.endAllSessions(user.id, SYSTEM).changes;
    store.db.prepare("UPDATE users SET auth_version = auth_version + 1 WHERE id = ?").run(user.id);
    audit(`sessions ended: user ${user.id} by the command line`);
    console.log(`Signed out ${clean(user.email)}: ${n} session(s) ended.`);
  }
} else {
  console.log(USAGE);
  process.exit(1);
}
