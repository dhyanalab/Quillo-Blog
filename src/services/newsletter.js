// Sends a newsletter in the background, a few emails at a time, recording each one so a restart
// carries on where it stopped. A recipient is marked "sending" before the email goes out, so a crash can never
// mean a second copy: after a restart that recipient is shown as failed, and the owner can choose Try again.
//
// Which failures stop a run: only the ones that are not about one recipient (the connection, the login, TLS, timeouts, the sender,
// or a policy or relay refusal that applies to everybody). Five of those in a row stop it. A refusal of one recipient never does:
// a permanent refusal fails that address at once, a "try later" gets up to three attempts, and the run carries on.
import crypto from "node:crypto";
import { bestVariant } from "../render/media.js";
import * as emailLib from "../render/email.js";
import { classifyMailError, explainMailError, loggable } from "./mailer.js";

const MAX_FAILS_IN_A_ROW = 5;
const SENDING = "Sending…";
const INTERRUPTED = "Stopped while sending, so it may or may not have arrived. Use Try again to send it once more.";
const LEASE_MS = 120_000; // one process at a time sends; the claim is renewed after every email and lapses if the process dies
const NOT_READY_MESSAGE = "Email isn’t set up yet, so this newsletter was not sent. Finish Newsletter > Email settings, then use Try again.";
const PAUSED_MESSAGE = "Sending was paused when the blog started (RESUME_NEWSLETTERS=0). Use Try again when you are ready.";

// The email with the unsubscribe link left open: rendered once per newsletter, then filled in per recipient.
const prepare = (args) => (emailLib.prepareNewsletter ? emailLib.prepareNewsletter(args) : (url) => emailLib.renderNewsletter({ ...args, unsubscribeUrl: url }));

export function createNewsletterSender(ctx, { delayMs = 400 } = {}) {
  const { store } = ctx;
  const running = new Set();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // A pause that isn't a sensible number (MAIL_DELAY_MS=abc gives NaN) falls back to the default.
  const pause = Number.isFinite(Number(delayMs)) && Number(delayMs) >= 0 ? Number(delayMs) : 400;
  const me = crypto.randomBytes(8).toString("hex");

  // The posts featured in a newsletter, with absolute links and a picture every inbox can show.
  function postsFor(newsletter) {
    const site = ctx.site();
    const t = new Date().toISOString();
    return newsletter.postIds
      .map((id) => store.posts.get(id))
      .filter((p) => p && p.status === "published" && p.published_at <= t)
      .map((p) => {
        const img = store.media.get(p.feature_image_id);
        const file = img ? (/^image\/(jpeg|png|gif)$/.test(img.mime) ? img.path : bestVariant(img, 1200)) : "";
        return { title: p.title, url: site.abs(site.url.post(p.slug)), excerpt: p.excerpt, image: file ? site.abs(site.url.media(file)) : "" };
      });
  }

  // Every mail carries the subscriber's own unsubscribe link, made by the subscriber store (a keyed token for the current year).
  const unsubscribeUrl = (subscriber) => {
    const site = ctx.site();
    let token = "";
    if (subscriber?.id) token = store.subscribers.unsubscribeToken?.(subscriber, new Date().getUTCFullYear()) ?? subscriber.token ?? "";
    return site.abs(`${site.base}/unsubscribe/${encodeURIComponent(token || "preview")}/`);
  };

  const prepared = (newsletter) => prepare({ site: ctx.site(), newsletter, posts: postsFor(newsletter) });

  // The email exactly as a subscriber receives it.
  const render = (newsletter, subscriber = null) => prepared(newsletter)(unsubscribeUrl(subscriber));

  // The finished message for one recipient. `build` comes from prepared(), so the Markdown is rendered once per send.
  function message(build, subscriber) {
    const url = unsubscribeUrl(subscriber);
    const mail = build(url);
    return {
      to: { address: subscriber.email, name: subscriber.name || "" },
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    };
  }

  // A single copy to the owner, marked as a test. Throws a plain-language error.
  async function sendTest(newsletter, to) {
    const conn = ctx.mailer.open();
    try {
      const m = message(prepared(newsletter), { email: to, name: "", token: "" });
      await conn.send({ ...m, subject: `[Test] ${m.subject}` });
    } catch (err) {
      throw new Error(explainMailError(err));
    } finally {
      conn.close();
    }
  }

  // Anyone left "sending" by a crash or restart: we can't tell whether it arrived, so it is marked failed and not sent again on its own.
  function settleInterrupted(id) {
    ctx.db.prepare("UPDATE newsletter_sends SET status = 'failed', attempts = attempts + 1, error = ? WHERE newsletter_id = ? AND status = 'queued' AND error = ?").run(INTERRUPTED, id, SENDING);
  }

  // An address the server refused for good has no use for more tries.
  function failForGood(id, subscriberId) {
    ctx.db.prepare("UPDATE newsletter_sends SET status = 'failed' WHERE newsletter_id = ? AND subscriber_id = ? AND status = 'queued'").run(id, subscriberId);
  }

  // Only one process sends at a time. The claim lives in the database (so a second copy of the blog on the same data folder waits),
  // is renewed after every email, and simply lapses if the process dies.
  let leaseReady = false;
  function lease() {
    try {
      if (!leaseReady) {
        ctx.db.exec("CREATE TABLE IF NOT EXISTS service_leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until TEXT NOT NULL)");
        leaseReady = true;
      }
      const t = Date.now();
      const r = ctx.db
        .prepare("INSERT INTO service_leases (name, owner, until) VALUES ('newsletter', ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, until = excluded.until WHERE service_leases.owner = excluded.owner OR service_leases.until < ?")
        .run(me, new Date(t + LEASE_MS).toISOString(), new Date(t).toISOString());
      return r.changes === 1;
    } catch (err) {
      console.warn(`[newsletter] could not check the sending claim: ${loggable(err)}`);
      return true; // a broken claim table must not stop the owner's newsletter
    }
  }
  function release() {
    try {
      ctx.db.prepare("DELETE FROM service_leases WHERE name = 'newsletter' AND owner = ?").run(me);
    } catch {}
  }

  // Every email carries an unsubscribe link, so nothing goes out while the site address is only a local one.
  const noPublicUrl = () => ctx.site().hasPublicUrl === false;
  const NO_URL_MESSAGE = "Set the Site URL to your real web address (in Settings) before sending, so the unsubscribe links work.";
  const BUSY_MESSAGE = "Another newsletter is still being sent. Wait for it to finish, then try again.";

  async function run(id) {
    if (running.has(id)) return;
    running.add(id);
    let conn = null;
    let failsInARow = 0;
    let holding = false;
    const sentThisRun = new Set();
    try {
      let newsletter = store.newsletters.get(id);
      if (!newsletter || newsletter.status !== "sending") return;
      if (noPublicUrl()) {
        store.newsletters.halt(id, NO_URL_MESSAGE);
        return;
      }
      // If another process holds the claim, wait for it to lapse (it renews while it is alive, so a live sender is never taken over).
      for (let waited = 0; !(holding = lease()); waited += 2000) {
        if (waited > LEASE_MS + 4000) return;
        await wait(2000);
      }
      const build = prepared(newsletter);
      settleInterrupted(id);
      conn = ctx.mailer.open();
      for (;;) {
        newsletter = store.newsletters.get(id);
        if (!newsletter || newsletter.status !== "sending") return;
        const batch = store.newsletters.nextBatch(id, 10);
        if (!batch.length) break;
        for (const queued of batch) {
          if (sentThisRun.has(queued.id)) continue; // already mailed in this run, whatever the database says
          // Re-read the recipient: someone may have unsubscribed or been removed since the batch was read.
          const fresh = store.subscribers.get(queued.id);
          if (!fresh || fresh.status !== "active") continue;
          const sub = { ...queued, ...fresh };
          if (!lease()) return; // another process has taken over
          ctx.db.prepare("UPDATE newsletter_sends SET error = ? WHERE newsletter_id = ? AND subscriber_id = ?").run(SENDING, id, sub.id);

          // The send and the bookkeeping are separate steps: a database problem after a good send is never counted as a failed send.
          let failure = null;
          try {
            await conn.send(message(build, sub));
          } catch (err) {
            failure = err;
          }
          if (!failure) {
            sentThisRun.add(sub.id);
            failsInARow = 0;
            try {
              store.newsletters.mark(id, sub.id, true);
            } catch {
              try {
                store.newsletters.mark(id, sub.id, true);
              } catch (err2) {
                store.newsletters.halt(id, "The email went out but could not be recorded, so sending stopped to keep anyone from getting a second copy. Check the disk, then use Try again.");
                console.warn(`[newsletter] could not record a sent email: ${loggable(err2)}`);
                return;
              }
            }
          } else {
            const kind = classifyMailError(failure);
            // A permanent refusal fails the recipient at once (the store does it; failForGood is only a fallback for an older store).
            store.newsletters.mark(id, sub.id, false, kind === "permanent" ? "The email server refused this address." : explainMailError(failure), { permanent: kind === "permanent" });
            if (kind === "permanent") failForGood(id, sub.id);
            // The server answered for this recipient, so the connection itself is fine; only failures that aren't about one recipient add up.
            if (kind === "transport") failsInARow++;
            else failsInARow = 0;
            if (failure?.code === "EAUTH" || failsInARow >= MAX_FAILS_IN_A_ROW) {
              store.newsletters.halt(id, explainMailError(failure));
              console.warn(`[newsletter] stopped "${newsletter.subject}": ${loggable(failure)}`);
              return;
            }
          }
          if (pause) await wait(pause);
        }
      }
      store.newsletters.finish(id);
      const done = store.newsletters.get(id);
      console.log(`[newsletter] "${done.subject}": ${done.sent_n} sent, ${done.failed_n} failed`);
    } catch (err) {
      try {
        store.newsletters.halt(id, explainMailError(err));
      } catch {}
      console.warn(`[newsletter] send stopped: ${loggable(err)}`);
    } finally {
      conn?.close();
      if (holding) release();
      running.delete(id);
    }
  }

  // Runs a send in the background. Nothing it throws can escape and end the process.
  const launch = (id) =>
    run(id).catch((err) => console.warn(`[newsletter] send failed: ${loggable(err)}`));

  // Shows why a newsletter that was left "sending" is not being sent, so it can be retried or deleted.
  const haltVisibly = (id, reason) => {
    try {
      store.newsletters.halt(id, reason);
    } catch (err) {
      console.warn(`[newsletter] could not stop a newsletter that can't be sent: ${loggable(err)}`);
    }
  };

  return {
    render,
    sendTest,
    // Queues everyone and starts sending. Returns false when the newsletter can't be sent (already sent or sending, no public Site URL,
    // or another newsletter is being sent).
    start(id) {
      if (noPublicUrl() || running.size) return false;
      const queued = store.newsletters.queue(id);
      if (queued) launch(id);
      return Boolean(queued);
    },
    // Puts failed emails back in the queue and sends again. Returns false (and changes nothing) while a send is running or can't start.
    retry(id) {
      if (noPublicUrl() || running.size) return false;
      store.newsletters.retry(id);
      launch(id);
      return true;
    },
    // True while sending is blocked, with the reason to show.
    blockedReason: () => (noPublicUrl() ? NO_URL_MESSAGE : running.size ? BUSY_MESSAGE : ""),
    // Picks up newsletters that were sending when the server stopped, once email is set up. When they can't be picked up
    // (no email set up, a local Site URL, or RESUME_NEWSLETTERS=0), they are shown as stopped, with the reason, so Try again or Delete is possible.
    resume({ paused = false } = {}) {
      const ids = store.newsletters.sending().filter((id) => !running.has(id));
      if (!ids.length) return;
      const reason = paused || process.env.RESUME_NEWSLETTERS === "0" ? PAUSED_MESSAGE : !ctx.mailer.ready() ? NOT_READY_MESSAGE : noPublicUrl() ? NO_URL_MESSAGE : "";
      if (reason) {
        for (const id of ids) haltVisibly(id, reason);
        return;
      }
      // One at a time, so two newsletters never go to the same people together.
      (async () => {
        for (const id of ids) await launch(id);
      })();
    },
    isRunning: (id) => running.has(id),
    // For tests: resolves when nothing is sending.
    async idle() {
      while (running.size) await wait(10);
    },
  };
}
