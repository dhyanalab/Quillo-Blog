// Scheduled posts are already in the database with a future published_at. When that time passes,
// clear the page cache (so lists and the sitemap include them) and ping IndexNow.
// Banners with a start or end date work the same way: the cache clears when one starts or stops.
// The time of the last successful check is kept in the database (in its own small table, not in the site's settings),
// so posts that went live while the server was off are still announced.
// Once an hour, expired staff and reader sessions, expired sign-up confirmations and spent rate-limit counters are deleted.
const LAST_TICK_KEY = "scheduler_last_tick";
const HOUR = 3_600_000;
const JUMP_MS = 5 * 60_000; // a clock that is further behind the saved time than this was set back, not just slightly off
const MAX_TRIES = 3; // a window whose follow-up steps keep failing is given up after this many checks

export function startScheduler(ctx, { intervalMs = 30_000 } = {}) {
  let stateReady = false;
  const state = () => {
    if (!stateReady) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS scheduler_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      stateReady = true;
    }
    return ctx.db;
  };
  const readLast = () => {
    try {
      let row = state().prepare("SELECT value FROM scheduler_state WHERE key = ?").get(LAST_TICK_KEY);
      if (!row) {
        // Older versions kept the time in the settings table: take it over once, and remove it from there.
        row = ctx.db.prepare("SELECT value FROM settings WHERE key = ?").get(LAST_TICK_KEY);
        if (row) {
          state().prepare("INSERT OR REPLACE INTO scheduler_state (key, value) VALUES (?, ?)").run(LAST_TICK_KEY, row.value);
          ctx.db.prepare("DELETE FROM settings WHERE key = ?").run(LAST_TICK_KEY);
        }
      }
      const t = row ? JSON.parse(row.value) : "";
      return typeof t === "string" && !Number.isNaN(Date.parse(t)) && Date.parse(t) <= Date.now() ? t : "";
    } catch {
      return "";
    }
  };
  const saveLast = (t) => {
    try {
      state().prepare("INSERT OR REPLACE INTO scheduler_state (key, value) VALUES (?, ?)").run(LAST_TICK_KEY, JSON.stringify(t));
    } catch (err) {
      console.warn(`[scheduler] could not save the last check time: ${err.message}`);
    }
  };

  let last = readLast() || new Date().toISOString();
  let lastPrune = 0;
  let failedTries = 0;

  function prune() {
    lastPrune = Date.now();
    const steps = [
      ["expired sessions", () => (ctx.store.users.pruneSessions?.(), ctx.store.members.pruneSessions?.())],
      ["expired sign-up confirmations", () => (ctx.store.subscribers?.pruneExpired?.(), ctx.store.members.pruneUnverified?.())],
      ["old rate-limit counters", () => ctx.store.rateLimits?.prune?.(Date.now())],
    ];
    for (const [what, fn] of steps) {
      try {
        fn();
      } catch (err) {
        console.warn(`[scheduler] could not remove ${what}: ${err.message}`);
      }
    }
  }

  const tick = () => {
    try {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      // The clock was set back by a lot (or a forward jump was saved): start from now instead of waiting for it to catch up.
      // A small step back is waited out, so no stretch of time is skipped.
      if (now < last && Date.parse(last) - nowMs > JUMP_MS) {
        console.warn("[scheduler] the clock is far behind the last saved check; starting again from the current time");
        last = now;
        saveLast(now);
      }
      if (now >= last) {
        const live = ctx.store.posts.wentLiveBetween(last, now);
        const adsChanged = ctx.store.ads.changedBetween(last, now);
        let followUp = true;
        try {
          if (adsChanged || live.length) ctx.invalidate();
          if (live.length) {
            const site = ctx.site();
            ctx.indexNow.ping([...live.map((p) => site.abs(site.url.post(p.slug))), site.abs(site.url.home), `${site.blogUrl}/sitemap.xml`]);
            console.log(`[scheduler] published ${live.map((p) => p.slug).join(", ")}`);
          }
        } catch (err) {
          // Tried again at the next check, but not for ever: after a few failures the window is let go.
          followUp = ++failedTries >= MAX_TRIES;
          console.warn(`[scheduler] ${followUp ? "giving up on this check" : "check failed, will try again"}: ${err.message}`);
        }
        if (followUp) {
          failedTries = 0;
          last = now;
          saveLast(now);
        }
      }
    } catch (err) {
      console.warn(`[scheduler] check failed, will try again: ${err.message}`);
    }
    if (Date.now() - lastPrune >= HOUR) prune();
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  // A first check soon after start-up announces anything that went live while the server was off.
  const first = setTimeout(tick, 3000);
  first.unref?.();
  return {
    tick,
    stop: () => {
      clearInterval(timer);
      clearTimeout(first);
    },
  };
}
