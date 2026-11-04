// IndexNow: tells Bing, Yandex, Seznam, Naver and others when a URL is added, changed or removed.
// Pings are skipped for sites on a private or local address, when disabled in Settings, and for pages whose canonical address is
// somewhere else. A page marked noindex is not announced either, except once to tell search engines to look again after it
// was switched to noindex (it had been announced before). Which pages qualify is decided when the address is queued.
// Requests give up after 10 seconds, never follow a redirect, go out in batches of 10,000 URLs, and a failed address is tried again
// a few minutes later (up to three times each). The same address is sent at most once every 10 minutes and at most 50,000
// addresses go out per day, so the site's key is never flooded.
import { isPrivateHost } from "./hosts.js";

const TIMEOUT_MS = 10_000;
const CHUNK = 10_000;
const RETRY_MS = 5 * 60_000;
const MAX_RETRIES = 3;
const MIN_GAP_MS = 10 * 60_000; // the same address is not sent again sooner than this
const DAY_MS = 24 * 3_600_000;
const DAY_LIMIT = 50_000;
const REMEMBER = 20_000; // how many addresses "already announced" is kept for

export function createIndexNow(ctx) {
  const queue = new Set();
  const tries = new Map(); // failed attempts per address
  const sentAt = new Map(); // address -> when it was last sent (insertion order is time order)
  const announced = new Set(); // addresses that were announced as pages to index
  const day = []; // times of the addresses sent in the last 24 hours
  let timer = null;
  let inflight = null;

  const bare = (u) => String(u).replace(/[?#].*$/, "").replace(/\/+$/, "");

  // Addresses of public pages that must not be announced: noindex pages and pages that point to another canonical address.
  function skipped(site) {
    const out = new Set();
    try {
      for (const p of ctx.store.posts.allPublic()) {
        const self = site.abs(site.url.post(p.slug));
        if (p.noindex || (p.canonical_url && bare(p.canonical_url) !== bare(self))) out.add(self);
      }
    } catch {}
    return out;
  }

  // Remembers the address (oldest forgotten first).
  const remember = (set, u) => {
    set.delete(u);
    set.add(u);
    if (set.size > REMEMBER) set.delete(set.values().next().value);
  };

  async function post(site, urls) {
    const key = site.s.indexnow_key;
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: site.host, key, keyLocation: `${site.blogUrl}/${key}.txt`, urlList: urls }),
      redirect: "error", // the request carries the site's key, so a redirect is never followed
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The answer isn't needed; release the connection.
    try {
      await res.body?.cancel?.();
    } catch {}
    console.log(`[indexnow] ${res.status} for ${urls.length} URL(s)`);
    // Rate limits and server errors are worth another try; other answers (such as a key mismatch) won't change.
    if (res.status === 429 || res.status >= 500) throw new Error(`IndexNow answered ${res.status}`);
  }

  const dayCount = () => {
    const cutoff = Date.now() - DAY_MS;
    while (day.length && day[0] < cutoff) day.shift();
    return day.length;
  };

  // Never throws: a failed ping only means search engines hear about the change later.
  async function send() {
    try {
      const site = ctx.site();
      const all = [...queue];
      queue.clear();
      if (!all.length || !ctx.config.outbound || !site.s.indexnow_enabled || isPrivateHost(site.host)) return;
      const now = Date.now();
      const eligible = all.filter((u) => URL.canParse(u) && new URL(u).hostname === site.host);
      // An address sent a few minutes ago waits its turn instead of being sent again.
      const waiting = new Set(eligible.filter((u) => now - (sentAt.get(u) ?? 0) < MIN_GAP_MS));
      let urls = eligible.filter((u) => !waiting.has(u));
      if (waiting.size) {
        let next = MIN_GAP_MS;
        for (const u of waiting) {
          next = Math.min(next, sentAt.get(u) + MIN_GAP_MS - now);
          queue.add(u);
        }
        timer ??= setTimeout(flush, Math.max(next, 1000) + 100);
        timer.unref?.();
      }
      const room = DAY_LIMIT - dayCount();
      if (urls.length > room) {
        console.warn(`[indexnow] daily limit reached; ${urls.length - Math.max(room, 0)} URL(s) not sent`);
        urls = urls.slice(0, Math.max(room, 0));
      }
      const retry = [];
      for (let i = 0; i < urls.length; i += CHUNK) {
        const chunk = urls.slice(i, i + CHUNK);
        try {
          await post(site, chunk);
          for (const u of chunk) {
            tries.delete(u);
            remember(announced, u);
            sentAt.delete(u);
            sentAt.set(u, Date.now());
            day.push(Date.now());
          }
          while (sentAt.size > REMEMBER * 2) sentAt.delete(sentAt.keys().next().value);
        } catch (err) {
          console.warn(`[indexnow] ping failed: ${err.message}`);
          for (const u of chunk) {
            const n = (tries.get(u) ?? 0) + 1;
            if (n <= MAX_RETRIES) {
              tries.set(u, n);
              retry.push(u);
            } else tries.delete(u);
          }
        }
      }
      if (retry.length) {
        for (const u of retry) queue.add(u);
        timer ??= setTimeout(flush, RETRY_MS);
        timer.unref?.();
      }
    } catch (err) {
      console.warn(`[indexnow] ping failed: ${err.message}`);
    }
  }

  // Sends what is queued. Waits for any send already running, so two never overlap. For the scheduler's timer and for tests.
  function flush() {
    clearTimeout(timer);
    timer = null;
    const run = (inflight ?? Promise.resolve()).then(send).finally(() => {
      if (inflight === run) inflight = null;
    });
    inflight = run;
    return run;
  }

  // Decides now, for each address, whether it may be announced: not a noindex page or a page canonical elsewhere,
  // unless it was announced before (then one more ping lets search engines see the change).
  const queueUrls = (urls) => {
    let skip = null;
    for (const u of urls) {
      if (!u) continue;
      if (!skip) {
        try {
          skip = skipped(ctx.site());
        } catch {
          skip = new Set();
        }
      }
      if (skip.has(u) && !announced.has(u)) continue;
      queue.add(u);
    }
  };

  return {
    // Queues absolute URLs and sends them together a few seconds later.
    ping(urls) {
      queueUrls(urls);
      timer ??= setTimeout(flush, 5000);
      timer.unref?.();
    },
    // Queues and sends right away, in the background. Safe to call inside a request: it returns at once and never throws.
    pingNow(urls) {
      queueUrls(urls);
      flush();
    },
    flush,
  };
}
