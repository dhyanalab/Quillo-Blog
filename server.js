// Starts the blog: `npm start` (production) or `npm run dev` (development: reloads views and assets on each request).
// Run it under a supervisor (systemd, pm2, Docker's restart policy...): after an unexpected error it stops on purpose, and the supervisor starts it again.
import { serve } from "@hono/node-server";
import { createApp } from "./src/web/app.js";
import { logSafe } from "./src/web/security.js";
import { startScheduler } from "./src/services/scheduler.js";

let server = null;
let dying = false;

// After an uncaught error the program's state can no longer be trusted (Node says so too): log one line, stop taking
// connections and exit with code 1 within five seconds, so the supervisor restarts it cleanly.
function fatal(kind, err) {
  console.error(`[${kind}] ${logSafe(String(err?.stack || err).split("\n").slice(0, 3).join(" | "), 600)}`);
  if (dying) return;
  dying = true;
  const hard = setTimeout(() => process.exit(1), 5000);
  hard.unref?.();
  if (!server) process.exit(1);
  try {
    server.close(() => process.exit(1));
    server.closeIdleConnections?.();
  } catch {
    process.exit(1);
  }
}
process.on("unhandledRejection", (err) => fatal("unhandledRejection", err));
process.on("uncaughtException", (err) => fatal("uncaughtException", err));

let app;
let ctx;
try {
  ({ app, ctx } = createApp());
} catch (err) {
  // Bad settings (like an invalid SITE_URL or APP_SECRET), a database from another version, or a failed safety check: say so plainly.
  console.error(`Could not start: ${err.message}`);
  process.exit(1);
}
const { port, host, basePath, production } = ctx.config;

let scheduler = null;
server = serve({ fetch: app.fetch, port, hostname: host, serverOptions: { maxHeaderSize: 16 * 1024 } }, () => {
  // Only now is the port ours: the scheduler (which pings search engines) and the newsletter resume start after a successful listen,
  // so a second copy that cannot get the port never announces anything.
  scheduler = startScheduler(ctx);
  // RESUME_NEWSLETTERS=0 keeps unfinished newsletters paused (after restoring an older backup, check the subscriber list first).
  if (ctx.config.resumeNewsletters) {
    try {
      ctx.newsletter.resume();
    } catch (err) {
      console.error(`[newsletter] could not resume unfinished sending: ${logSafe(err?.message)}`);
    }
  } else {
    // Unfinished newsletters are shown as stopped, with the reason, instead of staying "sending".
    try {
      ctx.newsletter.resume({ paused: true });
    } catch (err) {
      console.error(`[newsletter] could not pause unfinished sending: ${logSafe(err?.message)}`);
    }
    console.log("Newsletters that were sending are paused (RESUME_NEWSLETTERS=0).");
  }
  const local = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  const owner = ctx.store.users.hasOwner();
  console.log(`Data:  ${ctx.config.dataDir}`);
  console.log(`Blog:  ${local}${basePath}/`);
  console.log(`Admin: ${local}${basePath}/admin/`);
  if (!owner) {
    console.log("");
    // A token made at start-up is shown (it exists nowhere else). One supplied through SETUP_TOKEN is never printed.
    if (ctx.config.setupTokenGenerated) {
      console.log("No owner account yet. To create it, open:");
      console.log(`  ${local}${basePath}/admin/setup`);
      console.log("and enter this setup token (made for this start-up only; a new one is made each time until the owner exists):");
      console.log(`  ${ctx.config.setupToken}`);
    } else {
      console.log("No owner account yet. To create it, open:");
      console.log(`  ${local}${basePath}/admin/setup`);
      console.log("and enter the SETUP_TOKEN you set.");
    }
    console.log("");
  }
  // Things the owner should know about (also shown on the admin dashboard).
  if (production) {
    for (const w of ctx.warnings) console.log(`Notice: ${w}`);
    if (!ctx.config.trustProxy && ctx.config.siteUrl.startsWith("https:") && /^(127\.|localhost|::1)/.test(host)) {
      console.log("Notice: the site is https but TRUST_PROXY is not set. If a reverse proxy sits in front of this app, set TRUST_PROXY=1 so every visitor gets their own rate limit (see the README).");
    }
  }
});

// Slow or stalled clients must not hold connections open forever. Uploads get five minutes in total, and a connection that
// moves no data at all for two minutes (a trickling request or a client that stopped reading a download) is closed.
server.headersTimeout = 30_000;
server.requestTimeout = 5 * 60_000;
server.timeout = 2 * 60_000;
server.keepAliveTimeout = 65_000;
server.maxConnections = 1024;

// One address may not hold every connection slot. Behind a proxy all connections come from the proxy, so the proxy must limit
// them instead (see the README); loopback is never limited.
const open = new Map();
server.on("connection", (socket) => {
  const ip = socket.remoteAddress || "";
  if (ctx.config.trustProxy || !ip || /^(127\.|::1$|::ffff:127\.)/.test(ip)) return;
  const n = (open.get(ip) || 0) + 1;
  if (n > ctx.config.maxConnectionsPerIp) {
    socket.destroy();
    return;
  }
  open.set(ip, n);
  socket.once("close", () => {
    const left = (open.get(ip) || 1) - 1;
    if (left > 0) open.set(ip, left);
    else open.delete(ip);
  });
});

server.on("error", (err) => {
  // Only start-up problems (port in use, no permission) stop the blog; other server errors are logged.
  if (err.code === "EADDRINUSE") console.error(`Port ${port} is already in use. Start on another one, e.g. PORT=4200 npm start`);
  else if (err.code === "EACCES" || err.code === "EADDRNOTAVAIL") console.error(`Cannot listen on ${host}:${port} (${err.code}).`);
  else {
    console.error(`[server] ${logSafe(err.message)}`);
    return;
  }
  process.exit(1);
});
server.on("clientError", (err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  else socket.destroy(err);
});

// Shutdown waits (briefly) for what is in flight: requests being answered, the queued search-engine pings, a newsletter
// batch. A newsletter that is cut off is picked up again at the next start. Nothing waits longer than 15 seconds.
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  const hard = setTimeout(() => process.exit(0), 15_000);
  hard.unref?.();
  scheduler?.stop?.();
  const closed = new Promise((resolve) => server.close(() => resolve()));
  server.closeIdleConnections?.();
  const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
  try {
    await within(closed, 8000);
    await within(Promise.resolve(ctx.indexNow?.flush?.()), 8000);
    await within(Promise.resolve(ctx.newsletter?.idle?.()), 4000);
  } catch (err) {
    console.error(`[shutdown] ${logSafe(err?.message)}`);
  }
  try {
    ctx.db.close();
  } catch {
    // already closed
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
