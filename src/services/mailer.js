// Sends email through the SMTP service set in Admin > Newsletter > Email settings.
// Tests pass `mailTransport: { jsonTransport: true }`; messages then land in `outbox` instead of being sent.
//
// Server settings can be pinned in the environment (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_SECURE). A pinned value wins over the
// saved setting and the admin form shows it as locked. SMTP_PASSWORD is only used together with SMTP_HOST, so the password can never
// be sent to a server chosen in the admin screens. Private and loopback servers are refused unless ALLOW_PRIVATE_SMTP=1.
import dns from "node:dns/promises";
import net from "node:net";
import nodemailer from "nodemailer";
import * as emailLib from "../render/email.js";
import { isEmail } from "../web/validate.js";
import { isPrivateHost } from "./hosts.js";

// Common email services, so the owner picks a name instead of typing server details.
export const SMTP_PRESETS = {
  zoho: { name: "Zoho Mail (India)", host: "smtp.zoho.in", port: 465, secure: "ssl", user: "Your full Zoho email address", pass: "Your Zoho password, or an app password if two-factor sign-in is on" },
  brevo: { name: "Brevo (free for 300 emails a day)", host: "smtp-relay.brevo.com", port: 587, secure: "starttls", user: "The SMTP login shown in Brevo under SMTP & API", pass: "The SMTP key from Brevo (not your Brevo password)" },
  gmail: { name: "Gmail or Google Workspace", host: "smtp.gmail.com", port: 465, secure: "ssl", user: "Your Gmail address", pass: "An app password (Google Account > Security > App passwords)" },
  hostinger: { name: "Hostinger email", host: "smtp.hostinger.com", port: 465, secure: "ssl", user: "Your full email address", pass: "That mailbox’s password" },
  ses: { name: "Amazon SES (Mumbai)", host: "email-smtp.ap-south-1.amazonaws.com", port: 587, secure: "starttls", user: "The SMTP user name from the SES console", pass: "The SMTP password from the SES console" },
  other: { name: "Another email service", host: "", port: 587, secure: "starttls", user: "Usually your email address", pass: "Your email password or SMTP key" },
};

// The one password in force. Only the current one is remembered, so a rotated password is not kept in memory.
let currentSecret = "";

// Secrets that must never appear in an error message shown to a person or written to a log.
const hide = (s) => {
  let out = String(s ?? "");
  for (const secret of [process.env.SMTP_PASSWORD, currentSecret]) if (secret) out = out.split(secret).join("[hidden]");
  return out
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\b(AUTH\s+(?:PLAIN|LOGIN|CRAM-MD5)\s+)\S+/gi, "$1[hidden]")
    .replace(/\b(pass(?:word)?\s*[=:]\s*)\S+/gi, "$1[hidden]");
};

// Mail servers often repeat the address in their reply. Anything address-shaped is replaced before text is logged or stored.
export const scrubAddresses = (text) => String(text ?? "").replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, "[address]");

// A recipient as { address, name }. Throws for anything nodemailer could read as more than one mailbox.
export function toAddress(who) {
  const address = typeof who === "string" ? who.trim() : String(who?.address ?? "").trim();
  if (!isEmail(address)) throw Object.assign(new Error("That email address isn’t valid."), { code: "EBADADDRESS" });
  // Names go in a header, so line breaks and quotes are dropped.
  // eslint-disable-next-line no-control-regex
  const name = typeof who === "string" ? "" : String(who?.name ?? "").replace(/[\u0000-\u001f\u007f-\u009f"<>\\]+/g, " ").trim().slice(0, 80);
  return { address, name };
}

const validPort = (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 65535 ? Number(v) : 0);

// Short emails (verification, reset...) go out a few at a time. When too many are waiting the extra ones are dropped, so a flood of
// sign-up requests can't pile up connections to the mail server.
const MAX_SIMPLE_AT_ONCE = 3;
const MAX_SIMPLE_WAITING = 30;
const simpleWaiting = [];
let simpleActive = 0;
async function simpleSlot() {
  if (simpleActive >= MAX_SIMPLE_AT_ONCE) {
    if (simpleWaiting.length >= MAX_SIMPLE_WAITING) return false;
    await new Promise((resolve) => simpleWaiting.push(resolve));
  } else simpleActive++;
  return true;
}
function simpleDone() {
  const next = simpleWaiting.shift();
  if (next) next();
  else simpleActive--;
}

export function createMailer(ctx) {
  const outbox = [];
  const override = ctx.config.mailTransport;
  const settings = () => ctx.store.settings.all();
  const env = () => process.env;
  const allowPrivate = () => env().ALLOW_PRIVATE_SMTP === "1";
  const lookup = ctx.dnsLookup || dns.lookup;

  // The server details actually in force: the environment first, then the saved settings.
  function server() {
    const e = env();
    const s = settings();
    const pinnedSecure = ["ssl", "starttls"].includes(e.SMTP_SECURE) ? e.SMTP_SECURE : "";
    return {
      host: String(e.SMTP_HOST || s.smtp_host || "").trim(),
      port: validPort(e.SMTP_PORT) || validPort(s.smtp_port) || 587,
      secure: pinnedSecure || (s.smtp_secure === "ssl" ? "ssl" : "starttls"),
      user: String(e.SMTP_USER || s.smtp_user || "").trim(),
      // Which values the environment fixes; the admin form shows these as locked.
      locked: { host: Boolean(e.SMTP_HOST), port: Boolean(validPort(e.SMTP_PORT)), secure: Boolean(pinnedSecure), user: Boolean(e.SMTP_USER) },
    };
  }

  // SMTP_PASSWORD belongs to the host named in SMTP_HOST, so it is ignored when the host comes from the settings.
  function password() {
    const e = env();
    let pass = "";
    if (e.SMTP_HOST && e.SMTP_PASSWORD) pass = e.SMTP_PASSWORD;
    else pass = (ctx.store.settings.getSecret ? ctx.store.settings.getSecret("smtp_pass") : settings().smtp_pass) || "";
    if (pass) currentSecret = pass;
    return pass;
  }

  // What is still missing before email can be sent, in plain words.
  const problems = () => {
    if (override) return [];
    const s = settings();
    const srv = server();
    const out = [];
    if (!s.mail_from_email) out.push("Add the email address newsletters come from.");
    if (!srv.host) out.push("Choose your email service.");
    if (srv.host && !srv.user) out.push("Add the email service’s user name.");
    if (srv.host && srv.user && !password()) out.push("Add the email service’s password.");
    if (srv.host && !allowPrivate() && isPrivateHost(srv.host)) out.push("The email server address points inside this computer or network, which isn’t allowed. Use your email service’s public server name.");
    return out;
  };

  // Looks the server name up once, refuses private addresses, and returns the address to connect to. The connection is then made to
  // that very address (with the name kept for the TLS check), so the name can't point somewhere else between the check and the connect.
  async function pin(host) {
    const refuse = () => {
      throw new Error("The email server address points inside this computer or network, which isn’t allowed. Use your email service’s public server name.");
    };
    if (!allowPrivate() && isPrivateHost(host)) refuse();
    if (net.isIP(host)) return { address: host, servername: "" };
    const found = await lookup(host, { all: true }); // a failed lookup throws, so the send fails instead of going unchecked
    if (!found?.length) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    if (!allowPrivate() && found.some((a) => isPrivateHost(a.address))) refuse();
    const first = found.find((a) => a.family === 4) || found[0];
    return { address: first.address, servername: host };
  }

  // One pooled connection for a batch of emails; call close() when done. The transport is made when the first message goes out,
  // after the server name has been checked.
  function open() {
    const s = settings();
    const srv = server();
    let transport = null;
    let building = null;
    let closed = false;
    const build = async () => {
      let t;
      if (override) t = nodemailer.createTransport(override);
      else {
        const target = await pin(srv.host);
        t = nodemailer.createTransport({
          host: target.address,
          servername: target.servername || undefined,
          port: srv.port,
          secure: srv.secure === "ssl",
          requireTLS: srv.secure !== "ssl",
          auth: srv.user ? { user: srv.user, pass: password() } : undefined,
          pool: true,
          maxConnections: 2,
          maxMessages: 100,
          connectionTimeout: 20_000,
          greetingTimeout: 20_000,
          socketTimeout: 60_000,
        });
      }
      if (closed) t.close();
      transport = t;
      return t;
    };
    const getTransport = () => {
      if (transport) return transport;
      building ??= build().finally(() => (building = null));
      return building;
    };
    const from = { name: s.mail_from_name || ctx.site().title, address: s.mail_from_email || "newsletter@example.invalid" };
    const asList = (to) => (Array.isArray(to) ? to : [to]).map(toAddress);
    return {
      async send(msg) {
        // Recipients are always {address, name} objects, so nodemailer never re-reads an address as a list.
        const to = asList(msg.to);
        const t = await getTransport();
        const info = await t.sendMail({ from, replyTo: s.mail_reply_to || undefined, ...msg, to });
        if (override?.jsonTransport) outbox.push(JSON.parse(info.message));
        return info;
      },
      async verify() {
        if (override) return true;
        return (await getTransport()).verify();
      },
      close() {
        closed = true;
        transport?.close();
      },
    };
  }

  // One short email (confirmation, verification, reset). Never throws: a failure is logged and the caller carries on.
  async function sendSimple(to, content, what) {
    let slot = false;
    try {
      if (!ready()) return false;
      slot = await simpleSlot();
      if (!slot) {
        console.warn(`[mail] ${what} email not sent: too many emails waiting`);
        return false;
      }
      const mail = emailLib.renderSimpleEmail({ site: ctx.site(), ...content });
      const conn = open();
      try {
        await conn.send({ to, subject: mail.subject, html: mail.html, text: mail.text });
      } finally {
        conn.close();
      }
      return true;
    } catch (err) {
      console.warn(`[mail] ${what} email not sent: ${loggable(err)}`);
      return false;
    } finally {
      if (slot) simpleDone();
    }
  }

  const ready = () => problems().length === 0;
  const to = (person) => ({ address: person?.email, name: person?.name || "" });
  const title = () => ctx.site().title;

  return {
    problems,
    ready,
    open,
    outbox,
    // The environment-fixed server values, and the effective ones (no password), for the settings screen.
    server,
    sendConfirmSubscription: (subscriber, url) =>
      sendSimple(to(subscriber), { heading: "Confirm your subscription", body: `Please confirm that you want new posts from ${title()} by email. If you didn’t ask for this, you can ignore this message and nothing will be sent.`, buttonText: "Confirm subscription", url }, "subscription confirmation"),
    sendVerifyMember: (member, url) =>
      sendSimple(to(member), { heading: "Verify your email", body: `Welcome to ${title()}. Please confirm your email address to finish creating your account. If you didn’t sign up, you can ignore this message.`, buttonText: "Verify my email", url }, "verification"),
    sendAccountExists: (member, signinUrl, resetUrl) =>
      sendSimple(to(member), { heading: "You already have an account", body: [`Someone used this email address to sign up at ${title()}, but it already has an account. You can sign in with it.`, `If you forgot your password, reset it here: ${resetUrl}`], buttonText: "Sign in", url: signinUrl }, "account notice"),
    sendPasswordReset: (member, url) =>
      sendSimple(to(member), { heading: "Reset your password", body: `Someone asked to reset the password for your ${title()} account. The link works once and expires in 1 hour. If it wasn’t you, ignore this message and your password stays as it is.`, buttonText: "Choose a new password", url }, "password reset"),
  };
}

// The reply code and enhanced status of an SMTP failure, e.g. { code: 550, enhanced: "5.1.1" }.
function replyOf(err) {
  const text = String(err?.response ?? err?.message ?? "");
  const code = Number(err?.responseCode) || Number((text.match(/\b([2-5]\d\d)[ -]/) || [])[1]) || 0;
  const enhanced = (text.match(/\b[2-5]\d\d[ -]\s*([45]\.\d{1,3}\.\d{1,3})\b/) || [])[1] || "";
  return { code, enhanced };
}

// Turns SMTP errors into something the owner can act on. Never echoes a password, an address, or the server's own wording
// (a mail server's reply can carry banners and internal host names); at most the reply code is shown.
export function explainMailError(err) {
  const m = hide(err?.message || err);
  if (/isn’t valid|points inside this computer/.test(m)) return m.slice(0, 300);
  if (err?.code === "EAUTH" || /\b535\b|auth/i.test(m)) return "The email service refused the user name or password. Check both, or create an app password (see the help under the password box).";
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return "The email server address wasn’t found. Check the server name, and that this computer is online.";
  if (/ETIMEDOUT|ECONNREFUSED|ESOCKET|Greeting never received/i.test(m)) return "Couldn’t reach the email server. Check the port and security choice, or try the other one (465 with SSL, 587 with STARTTLS).";
  const { code, enhanced } = replyOf(err);
  const shown = code ? ` (reply ${code}${enhanced ? ` ${enhanced}` : ""})` : "";
  if (/\b(550|553|554)\b|sender|not allowed|relay/i.test(m)) return `The email service wouldn’t send from this address. Use an address you own on that service, and verify your domain with it.${shown}`;
  return `The email service reported a problem${shown}. Check the email settings and try again.`;
}

// What to write in the server log for a failed email: the plain explanation, with anything address-shaped removed.
export const loggable = (err) => scrubAddresses(explainMailError(err)).slice(0, 200);

// How a failed send should be treated:
//   "permanent": the server (or our own check) refused this recipient for good; mark them failed and carry on
//   "temporary": the server answered for this recipient with a "try later"; they get up to three attempts, and the run carries on
//   "transport": the problem is not about this recipient: connection, TLS, login, timeouts, the sender, or a policy or relay refusal
//                that applies to everyone (enhanced status 5.7.x or 4.7.x at RCPT TO). Only these count toward stopping a run.
export function classifyMailError(err) {
  if (err?.code === "EBADADDRESS") return "permanent";
  const { code, enhanced } = replyOf(err);
  const command = err?.command;
  const c = Number(err?.responseCode) || code;
  if ((command === "RCPT TO" || command === "DATA") && c >= 400) {
    if (c === 421) return "transport"; // "service closing the channel" is about the connection
    if (command === "RCPT TO" && /^[45]\.7\./.test(enhanced)) return "transport";
    return c >= 500 ? "permanent" : "temporary";
  }
  return "transport";
}

// True when the server said "no" to this recipient for good, so retrying the same address is pointless.
export const isPermanentRecipientError = (err) => classifyMailError(err) === "permanent";
