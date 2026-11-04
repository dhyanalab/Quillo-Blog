// Public site: home, lists, posts, pages, search, feeds, sitemap, robots, media, OG images,
// reader accounts and comments (members.js), and source-code downloads.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { isSourceName, zipFiles } from "../render/code.js";
import { ogImageFile } from "../render/og.js";
import * as schema from "../render/schema.js";
import { AD_PLACES } from "../store/ads.js";
import { contentDisposition, isHttpUrl, isoToYmd, rfc822, xmlText } from "../render/util.js";
import { THEME_SCRIPT } from "./assets.js";
import { memberRoutes } from "./members.js";
import { createPresenter, createRenderMemo } from "./present.js";
import { renderSlots, splitForSlot } from "./slots.js";
import { isLegalSlug } from "./site.js";
import { siteDesign } from "../design.js";
import { clearAppCookie, clientIp, createRateLimiter, isAdminPath, isBot, readCookie, safeEq, sameOrigin, takeClient } from "./security.js";
import { hasControlChars, isEmail, isSafeLocalPath, maskEmail, normalizeEmail } from "./validate.js";

const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".svg": "image/svg+xml", ".woff2": "font/woff2",
  ".pdf": "application/pdf", ".stl": "model/stl", ".3mf": "model/3mf", ".step": "model/step", ".stp": "model/step", ".zip": "application/zip",
};
// Downloads are always saved, never opened in the browser.
const ATTACH = new Set([".pdf", ".stl", ".3mf", ".step", ".stp", ".zip"]);
const NOTICES = {
  posted: { kind: "ok", text: "Your comment is live." },
  pending: { kind: "info", text: "Thanks! Your comment will appear once it’s approved." },
  deleted: { kind: "ok", text: "Your comment was deleted." },
  empty: { kind: "err", text: "Write something before posting." },
  slow: { kind: "err", text: "You’re commenting too fast. Wait a minute and try again." },
  closed: { kind: "err", text: "Comments are closed on this post." },
  gone: { kind: "err", text: "That comment is no longer available." },
  limit: { kind: "err", text: "You have several comments waiting for approval. Please try again later." },
};
const TOKEN_RE = /^[0-9a-f]{32}$/;
const NOT_FOUND_KEY = "\0not-found";

export function paginate(total, page, perPage, baseUrl) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const link = (n) => (n === 1 ? baseUrl : `${baseUrl}page/${n}/`);
  const nums = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const items = [];
  nums.forEach((n, i) => {
    if (i && n - nums[i - 1] > 1) items.push({ gap: true });
    items.push({ n, url: link(n), current: n === page });
  });
  return { page, pages, prev: page > 1 ? link(page - 1) : null, next: page < pages ? link(page + 1) : null, items, offset: (page - 1) * perPage };
}

// If-None-Match against an ETag (weak or strong, one or a list, or "*").
function notModified(c, etag) {
  const inm = c.req.header("if-none-match");
  if (!inm) return false;
  const strip = (v) => v.trim().replace(/^W\//, "");
  return inm.trim() === "*" || inm.split(",").some((v) => strip(v) === strip(etag));
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Remembers keys with the time each was last counted, oldest first. Expired keys go a few per call, and when the table is full
// the oldest go (never "stop remembering"), so it stays small without ever freezing a counter.
function createSeen(max, ttlMs) {
  const map = new Map();
  return {
    // True when `key` was counted less than `gap` ms ago; otherwise remembers it now and returns false.
    seen(key, t, gap = ttlMs) {
      const at = map.get(key);
      if (at !== undefined && t - at < gap) return true;
      map.delete(key);
      map.set(key, t);
      for (let i = 0; i < 20; i++) {
        const first = map.entries().next().value;
        if (!first || !(map.size > max || t - first[1] > ttlMs)) break;
        map.delete(first[0]);
      }
      return false;
    },
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
}

// A mail address that is safe to put after "mailto:" as it is: no "?" (which starts cc, bcc and body fields), "&", "#", "%" or slash.
const mailbox = (e) => typeof e === "string" && isEmail(e) && !/[?&#%/\\]/.test(e.split("@")[0]);
// Stored contact values are checked again where they are used, whatever path wrote them.
const cleanBusiness = (b = {}) => ({ ...b, emails: (b.emails || []).filter(mailbox), brandUrl: isHttpUrl(b.brandUrl) ? new URL(b.brandUrl).href : "" });

export function publicRoutes(app, ctx) {
  const { store, config, views, assets, cache } = ctx;
  const base = config.basePath;
  // Limiters come from the app; a stand-in keeps the routes working if the app was built without them.
  const limiter = (name, opts) => ctx.limiters?.[name] || createRateLimiter(opts);
  const subscribeLimit = limiter("subscribe", { limit: 5, windowMs: 3600_000 });
  const beaconLimit = limiter("beacon", { limit: 120, windowMs: 60_000 });
  const searchLimit = limiter("search", { limit: 30, windowMs: 60_000 });
  // Whole-site cap on confirmation mails for new or pending addresses, so changing addresses can't grow the list or the outgoing
  // mail without end. Only requests that would send a mail count towards it.
  const SUBSCRIBE_CAP = 300;
  const subscribeAll = createRateLimiter({ limit: SUBSCRIBE_CAP, windowMs: 3600_000 });
  // And one per address (lower-cased): three requests an hour, however many networks they come from.
  const subscribeAddr = createRateLimiter({ limit: 3, windowMs: 3600_000 });
  // Token links (confirm, unsubscribe): only a wrong or unknown token counts, so mail scanners that follow every link and
  // one-click unsubscribes from shared addresses never use it up.
  const TOKEN_FAILS = 60;
  const tokenFail = createRateLimiter({ limit: TOKEN_FAILS, windowMs: 15 * 60_000 });
  const tokenBlocked = (c) => tokenFail.count(clientIp(c, ctx)) >= TOKEN_FAILS;
  const tokenTooMany = (c) => c.text("Too many requests. Try again later.", 429);
  // A signed-in reader's pages are rendered fresh each time, so each reader gets a limited number of them a minute.
  const memberRenders = createRateLimiter({ limit: 60, windowMs: 60_000 });
  const searchPages = createRateLimiter({ limit: 90, windowMs: 60_000 });
  const ogLimit = createRateLimiter({ limit: 120, windowMs: 60_000 });
  const sourceLimit = createRateLimiter({ limit: 120, windowMs: 60_000 });
  // How many views one post can count in a minute (the view counter is advisory; this blunts inflation by rotating addresses).
  const viewBudget = createRateLimiter({ limit: 300, windowMs: 60_000 });

  // Everything remembered between requests is dropped whenever the page cache is: any content change, or a post going live.
  // `gen` counts those clears, so a page that was being rendered during a change is never stored afterwards. `tagGen` does
  // the same for clearTag (a comment, a like, a reader's new name).
  let gen = 0;
  let tagGen = 0;
  const searchMemo = new Map();
  const renderMemo = createRenderMemo();
  const ogFiles = new Map(); // "kind/id" -> cached image file
  const publicMedia = new Map(); // media id -> is it used by something public
  const sourceMemo = new Map(); // post slug -> its source files (and ZIP)
  let zipBytes = 0;
  const clearPageCache = cache.clear.bind(cache);
  cache.clear = () => {
    gen++;
    searchMemo.clear();
    renderMemo.clear();
    ogFiles.clear();
    publicMedia.clear();
    sourceMemo.clear();
    zipBytes = 0;
    return clearPageCache();
  };
  if (typeof cache.clearTag === "function") {
    const clearTag = cache.clearTag.bind(cache);
    cache.clearTag = (tag) => {
      tagGen++;
      return clearTag(tag);
    };
  }

  const presenter = () => createPresenter({ store, site: { current: ctx.site }, memo: renderMemo });
  const perPage = () => Math.min(48, Math.max(4, Number(store.settings.get("posts_per_page")) || 12));

  // The site as templates see it: no raw settings (mail server, keys), only what pages show.
  const templateSites = new WeakMap();
  const templateSite = (site) => {
    let t = templateSites.get(site);
    if (!t) {
      t = { ...site, s: {}, business: cleanBusiness(site.business) };
      // The spread copied the year once; read it at render time again, so the footer changes at New Year on a quiet site.
      Object.defineProperty(t, "year", { get: () => new Date().getFullYear(), enumerable: true });
      templateSites.set(site, t);
    }
    return t;
  };

  // The public stylesheet is a file (the security policy allows no inline <style>). Its name carries a hash of its content, so a
  // new build is a new address.
  const CSS = { site: "publicCss", preview: "previewCss" };
  const cssMemo = new Map();
  function cssHref(name) {
    const body = assets.get()[CSS[name]];
    let hit = cssMemo.get(name);
    if (!hit || hit.body !== body) {
      hit = { body, href: `${base}/assets/css/${name}-${crypto.createHash("sha256").update(body).digest("hex").slice(0, 12)}.css` };
      cssMemo.set(name, hit);
    }
    return hit.href;
  }
  app.get(`${base}/assets/css/:file{[a-z]+-[0-9a-f]{12}\\.css}`, (c) => {
    const [, name] = /^([a-z]+)-/.exec(c.req.param("file")) || [];
    if (!Object.hasOwn(CSS, name)) return c.text("Not found", 404);
    const current = cssHref(name);
    const body = cssMemo.get(name).body;
    const etag = `"${current.slice(current.lastIndexOf("-") + 1, -4)}"`;
    // An old address (from a page cached before a rebuild) still gets the current styles, but is not kept for a year.
    const same = c.req.path === current;
    const headers = { "Content-Type": "text/css; charset=utf-8", "Cache-Control": same ? "public, max-age=31536000, immutable" : "no-cache", ETag: etag };
    if (same && notModified(c, etag)) return c.body(null, 304, headers);
    return c.body(body, 200, headers);
  });

  const designOf = (c) => (c.get("design") ? siteDesign(c.get("design")) : ctx.site().design);

  function render(c, template, data) {
    const a = assets.get();
    const m = c.get("member");
    // Admin > Design draws pages with the look being tried ("design"); every other page uses the saved one.
    const tryDesign = c.get("design");
    const site = tryDesign ? { ...templateSite(ctx.site()), design: siteDesign(tryDesign) } : templateSite(ctx.site());
    return views.render(template, {
      site, cssUrl: cssHref("site"), previewCssUrl: data?.preview ? cssHref("preview") : "", siteJs: a.siteJs, themeScript: THEME_SCRIPT, preload: assets.preloadFor(site.design),
      // Only what a template shows: never the password hash or other account fields.
      member: m ? { id: m.member.id, name: m.member.name, email: m.member.email } : null,
      // Pages that carry a secret in their address (verify, reset) show no banners: nothing on them may load from or tell anyone else.
      memberCsrf: m?.session.csrf || "", currentUrl: c.req.path, slots: c.get("noSlots") ? {} : renderSlots(store, ctx.site()),
      noAnalytics: Boolean(c.get("noAnalytics")), designPreview: Boolean(c.get("designPreview")),
      previewScript: c.get("designPreview") ? `${base}/admin/static/site.js?v=${a.files["site.js"].hash}` : "", ...data,
    });
  }

  // Pages for signed-in readers are personal: never cached, never shared.
  function html(c, template, data, status = 200) {
    const body = render(c, template, data);
    if (c.get("member")) c.header("Cache-Control", "private, no-store");
    return c.html(body, status);
  }

  // Serves a page from the cache when possible; caches 200 responses that are safe to share. The key is the path only:
  // no cached page reads the query string, so ?x=1, ?x=2... can't force fresh renders. A handler can leave a note for
  // later hits with c.set("cacheMeta", ...), which `onHit` receives, and name the things the page shows with
  // c.set("cacheTags", [...]) (plus the fixed `tags`), so a comment or a name change drops only the pages it touches.
  // A signed-in reader's page is personal, so it is rendered fresh, but at most 60 times a minute per reader.
  const cached = (handler, { onHit, tags: fixedTags = [] } = {}) => async (c) => {
    const m = c.get("member");
    if (m) {
      if (!memberRenders.take(String(m.member.id))) return c.text("You're moving fast. Please wait a minute.", 429, { "Retry-After": "60", "Cache-Control": "private, no-store" });
      return handler(c);
    }
    const key = c.req.path;
    const hit = cache.get(key);
    if (hit) {
      onHit?.(c, hit.meta);
      // Whether a page was cached is not shown outside development.
      return c.body(hit.body, hit.status, config.production ? { "Content-Type": hit.type } : { "Content-Type": hit.type, "X-Cache": "hit" });
    }
    const g = gen;
    const tg = tagGen;
    const res = await handler(c);
    if (res?.status === 200 && !res.headers.get("set-cookie")) {
      const body = await res.clone().text();
      if (g === gen && tg === tagGen) cache.set(key, { body, status: 200, type: res.headers.get("content-type") || "text/html; charset=utf-8", meta: c.get("cacheMeta") }, { tags: [...fixedTags, ...(c.get("cacheTags") || [])] });
    }
    return res;
  };

  // Redirect targets are checked again here: a path on this site (one leading slash) or a full web address.
  const safeTarget = (to) => isSafeLocalPath(to) || isHttpUrl(to);

  // A redirect or 410 for this address, as typed with or without the trailing slash and with or without percent-encoding.
  function findRedirect(c) {
    const p = c.req.path;
    let raw = p;
    try {
      raw = new URL(c.req.url).pathname;
    } catch {
      raw = p;
    }
    const forms = (x) => (x.endsWith("/") ? [x, x.slice(0, -1)] : [x, `${x}/`]);
    for (const candidate of new Set([...forms(p), ...forms(raw)])) {
      if (!candidate) continue;
      const r = store.redirects.find(candidate);
      if (r) return r;
    }
    return null;
  }

  async function notFound(c) {
    const r = findRedirect(c);
    if (r) {
      store.redirects.hit(r.id);
      if (r.status_code === 410) return html(c, "public/error.njk", { meta: errorMeta("Page removed"), code: 410, heading: "This page has been removed", text: "It’s no longer on the site." }, 410);
      if (safeTarget(r.to_path)) return c.redirect(r.to_path, r.status_code);
    }
    // Every "not found" page is the same, so one copy serves them all (readers see their own header, so they get a fresh one, and so
    // does a request for a private address such as a reset link). The page never holds anything from the request: not its path
    // (the newsletter box would write it into a hidden field) and not its analytics decision.
    const shared = !c.get("member") && !c.get("noAnalytics");
    if (shared) {
      const hit = cache.get(NOT_FOUND_KEY);
      if (hit) return c.html(hit.body, 404);
    }
    const g = gen;
    const body = render(c, "public/error.njk", { meta: errorMeta("Page not found"), code: 404, heading: "Page not found", text: "This page doesn’t exist or has moved.", currentUrl: "", newsletterSource: "", ...(shared ? { noAnalytics: false } : {}) });
    if (shared && g === gen) cache.set(NOT_FOUND_KEY, { body, status: 404, type: "text/html; charset=utf-8" });
    if (c.get("member")) c.header("Cache-Control", "private, no-store");
    return c.html(body, 404);
  }
  ctx.notFound = notFound;

  const errorMeta = (title) => ({ title: `${title} | ${ctx.site().name}`, description: ctx.site().description, canonical: "", robots: "noindex", og: null });

  const pageNumber = (c) => {
    const n = c.req.param("n");
    if (n === undefined) return 1;
    return /^[1-9]\d{0,4}$/.test(n) ? Number(n) : 0;
  };

  // Renders one page of a list, with 301 for /page/1/ and 404 past the end.
  function listPage(c, { total, baseUrl, load, view }) {
    const page = pageNumber(c);
    if (!page) return notFound(c);
    if (c.req.param("n") === "1") return c.redirect(baseUrl, 301);
    const pg = paginate(total, page, perPage(), baseUrl);
    if (page > pg.pages) return notFound(c);
    const items = load(perPage(), pg.offset);
    return html(c, "public/list.njk", { side: presenter().sidebar(), ...view(items, pg), pagination: pg.pages > 1 ? pg : null });
  }

  const noMember = (p) => isAdminPath(p, base) || p.startsWith(`${base}/media/`) || p.startsWith(`${base}/assets/`) || p.startsWith(`${base}/og/`);

  app.use(`${base}/*`, async (c, next) => {
    const p = c.req.path;
    // Trailing slash on every page URL.
    if ((c.req.method === "GET" || c.req.method === "HEAD") && !p.endsWith("/") && !path.posix.basename(p).includes(".") && !isAdminPath(p, base) && !p.includes("/source/")) {
      // Control characters (a %0D%0A in the path, say) never belong in an address.
      if (hasControlChars(p)) return notFound(c);
      // A redirect or 410 entered without the trailing slash must fire, so it is looked up before the slash is added.
      if (findRedirect(c)) return notFound(c);
      // The Location is built from the address as it was sent (still percent-encoded) and always starts with exactly one
      // slash: leading slashes and backslashes are collapsed, so "//host" can never turn into another site.
      const url = new URL(c.req.url);
      const target = `/${url.pathname.replace(/^[/\\]+/, "")}/${url.search}`;
      return c.redirect(target, 301);
    }
    // A signed-in reader sees their name in the header and can comment.
    if (!noMember(p)) {
      const token = readCookie(c, ctx, "mid");
      if (token) {
        const s = store.members.getSession(token);
        if (s) c.set("member", s);
        else clearAppCookie(c, ctx, "mid", `${base}/`);
      }
    }
    return next();
  });
  if (base) {
    app.get(base, (c) => c.redirect(`${base}/`, 301));
    app.get("/", (c) => c.redirect(`${base}/`, 302));
  }

  // Home: a big story with Editor's Choice beside it, the latest posts with News and Most read in a
  // sidebar, then one row per category. News posts stay in the News column.
  const homePage = (c) => {
    const pr = presenter();
    const site = pr.site;
    const newsIds = site.newsCat ? [site.newsCat.id] : [];
    const featured = store.posts.listPublic({ featured: true, limit: 5, excludeCategoryIds: newsIds });
    const fill = featured.length < 5 ? store.posts.listPublic({ limit: 5 - featured.length, excludeIds: featured.map((r) => r.id), excludeCategoryIds: newsIds }) : [];
    const top = [...featured, ...fill];
    const shown = top.map((r) => r.id);
    const latest = store.posts.listPublic({ limit: perPage(), excludeIds: shown, excludeCategoryIds: newsIds });
    const total = store.posts.countPublic({ excludeCategoryIds: newsIds });
    const sections = site.categories
      .filter((cat) => cat.show_on_home && !cat.parent_id && !newsIds.includes(cat.id))
      .map((cat) => {
        const ids = [cat.id, ...site.categories.filter((k) => k.parent_id === cat.id).map((k) => k.id)];
        return { category: pr.category(cat.id), posts: store.posts.listPublic({ categoryIds: ids, limit: 4 }).map(pr.card) };
      })
      .filter((s) => s.posts.length >= 2);
    const cards = top.map(pr.card);
    const meta = pr.listMeta({ title: site.title, description: site.description, url: site.url.home, items: [...cards, ...latest.map(pr.card)], ogKind: "home", ogId: 0 });
    meta.title = site.title;
    return html(c, "public/home.njk", {
      meta,
      story: cards[0] || null,
      picks: cards.slice(1),
      latest: latest.map(pr.card),
      moreUrl: total > shown.length + latest.length ? site.url.latest : "",
      side: pr.sidebar(),
      sections,
    });
  };
  app.get(`${base}/`, cached(homePage, { tags: ["lists"] }));

  // Every post, newest first.
  const latest = cached((c) => {
    const pr = presenter();
    const site = pr.site;
    return listPage(c, {
      total: store.posts.countPublic(),
      baseUrl: site.url.latest,
      load: (limit, offset) => store.posts.listPublic({ limit, offset }).map(pr.card),
      view: (items, pg) => {
        const crumbs = [{ name: "Home", url: site.url.home }, { name: "Latest" }];
        return { meta: pr.listMeta({ title: "Latest posts", description: `Every post on ${site.title}, newest first.`, url: site.url.latest, page: pg.page, crumbs, items, ogKind: "latest", ogId: 0 }), crumbs, heading: { title: "Latest posts", description: `Every project, tutorial and news story on ${site.title}, newest first.` }, items };
      },
    });
  }, { tags: ["lists"] });
  app.get(`${base}/latest/`, latest);
  app.get(`${base}/latest/page/:n/`, latest);

  // A category and its sub-categories: the ids whose posts count.
  const categoryIds = (site, cat) => [cat.id, ...site.categories.filter((k) => k.parent_id === cat.id).map((k) => k.id)];

  const category = cached((c) => {
    const pr = presenter();
    const site = pr.site;
    const cat = store.categories.getBySlug(c.req.param("slug"));
    if (!cat) return notFound(c);
    const children = site.categories.filter((k) => k.parent_id === cat.id);
    const ids = categoryIds(site, cat);
    // Like tags and authors, a category with nothing published is not a page yet.
    const total = store.posts.countPublic({ categoryIds: ids });
    if (!total) return notFound(c);
    const parent = cat.parent_id ? pr.category(cat.parent_id) : null;
    const baseUrl = site.url.category(cat.slug);
    return listPage(c, {
      total,
      baseUrl,
      load: (limit, offset) => store.posts.listPublic({ categoryIds: ids, limit, offset }).map(pr.card),
      view: (items, pg) => {
        const crumbs = [{ name: "Home", url: site.url.home }, ...(parent ? [{ name: parent.name, url: parent.url }] : []), { name: cat.name }];
        const title = cat.seo_title || cat.name;
        return {
          meta: pr.listMeta({ title, description: cat.description || `${cat.name} posts on ${site.title}.`, url: baseUrl, page: pg.page, crumbs, items, ogKind: "category", ogId: cat.id, label: "Category" }),
          crumbs,
          heading: { kicker: parent ? parent.name : "", title: cat.name, description: cat.description, introHtml: pg.page === 1 && cat.intro_md ? pr.renderBody(cat.intro_md).html : "" },
          subnav: children.filter((k) => k.post_count).map((k) => ({ label: k.name, url: site.url.category(k.slug) })),
          feedUrl: `${baseUrl}rss.xml`,
          items,
          empty: "No posts in this category yet.",
        };
      },
    });
  }, { tags: ["lists"] });
  app.get(`${base}/category/:slug/`, category);
  app.get(`${base}/category/:slug/page/:n/`, category);

  const tag = cached((c) => {
    const pr = presenter();
    const site = pr.site;
    const t = store.tags.getBySlug(c.req.param("slug"));
    if (!t) return notFound(c);
    const baseUrl = site.url.tag(t.slug);
    const total = store.posts.countPublic({ tagId: t.id });
    if (!total) return notFound(c);
    return listPage(c, {
      total,
      baseUrl,
      load: (limit, offset) => store.posts.listPublic({ tagId: t.id, limit, offset }).map(pr.card),
      view: (items, pg) => {
        const crumbs = [{ name: "Home", url: site.url.home }, { name: t.name }];
        return { meta: pr.listMeta({ title: `${t.name} ${site.noun.many}`, description: t.description || `Posts tagged ${t.name} on ${site.title}.`, url: baseUrl, page: pg.page, crumbs, items, ogKind: "tag", ogId: t.id, label: "Tag" }), crumbs, heading: { kicker: "Tag", title: t.name, description: t.description }, items };
      },
    });
  }, { tags: ["lists"] });
  app.get(`${base}/tag/:slug/`, tag);
  app.get(`${base}/tag/:slug/page/:n/`, tag);

  const authorPage = cached((c) => {
    const pr = presenter();
    const site = pr.site;
    const u = store.users.getBySlug(c.req.param("slug"));
    if (!u) return notFound(c);
    const total = store.posts.countPublic({ authorId: u.id });
    if (!total) return notFound(c);
    const a = pr.author(u.id);
    const baseUrl = a.url;
    return listPage(c, {
      total,
      baseUrl,
      load: (limit, offset) => store.posts.listPublic({ authorId: u.id, limit, offset }).map(pr.card),
      view: (items, pg) => {
        const crumbs = [{ name: "Home", url: site.url.home }, { name: a.name }];
        const meta = pr.listMeta({ title: `${a.name}${a.job_title ? `, ${a.job_title}` : ""}`, description: a.bio || `Posts by ${a.name} on ${site.title}.`, url: baseUrl, page: pg.page, crumbs, items, ogKind: "author", ogId: u.id, label: "Author" });
        meta.og.type = "profile";
        meta.schema = schema.profileGraph(site, a, crumbs);
        return { meta, crumbs, profile: a, heading: { title: `Posts by ${a.name}` }, items };
      },
    });
  }, { tags: ["lists"] });
  app.get(`${base}/authors/:slug/`, authorPage);
  app.get(`${base}/authors/:slug/page/:n/`, authorPage);

  // Search is never cached by the page cache and never indexed. Each IP gets a limited number of searches a minute; the
  // same search repeated (or a later page of it) is answered from a short memory that is cleared on any content change.
  app.get(`${base}/search/`, (c) => {
    // Every search page costs a render, so each address gets a limited number of them (repeated or empty searches included).
    if (!takeClient(searchPages, c, ctx)) return c.text("You’re searching very fast. Wait a minute and try again.", 429, { "Retry-After": "60", "Cache-Control": "no-store" });
    const pr = presenter();
    const site = pr.site;
    const q = String(c.req.query("q") || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, 100).trim();
    const page = Math.max(1, Math.min(50, Math.floor(Number(c.req.query("page"))) || 1));
    // At least one word of two letters or digits is needed; shorter terms match half the site and cost the most.
    const searchable = /[\p{L}\p{N}]{2,}/u.test(q);
    let rows = [];
    let total = 0;
    let note = "";
    if (q && !searchable) note = "Use a word of at least two letters.";
    else if (q) {
      const key = `${gen}|${page}|${perPage()}|${q.toLowerCase()}`;
      let found = searchMemo.get(key);
      if (!found) {
        if (!takeClient(searchLimit, c, ctx)) {
          c.header("Retry-After", "60");
          return html(c, "public/list.njk", {
            meta: { title: `Search | ${site.name}`, description: site.description, canonical: "", robots: "noindex, follow", og: null },
            crumbs: [{ name: "Home", url: site.url.home }, { name: "Search" }],
            heading: { title: "Search", description: "" },
            search: { q },
            items: [],
            side: pr.sidebar(),
            empty: "You’re searching very fast. Wait a minute and try again.",
            pagination: null,
          }, 429);
        }
        const res = store.posts.search(q, { limit: perPage(), offset: (page - 1) * perPage() });
        // Result pages only need what the cards show, so the long article text isn't kept in memory.
        found = { rows: res.rows.map(({ body_md: _b, source_files: _s, ...rest }) => rest), total: res.total };
        if (searchMemo.size >= 40) searchMemo.delete(searchMemo.keys().next().value);
        searchMemo.set(key, found);
      }
      ({ rows, total } = found);
    }
    const pages = Math.ceil(total / perPage());
    const link = (n) => `${site.url.search}?q=${encodeURIComponent(q)}${n > 1 ? `&page=${n}` : ""}`;
    const crumbs = [{ name: "Home", url: site.url.home }, { name: "Search" }];
    return html(c, "public/list.njk", {
      meta: { title: q ? `Search: ${q} | ${site.name}` : `Search | ${site.name}`, description: site.description, canonical: "", robots: "noindex, follow", og: null },
      crumbs,
      heading: { title: q ? `Results for “${q}”` : "Search", description: q && !note ? `${total} ${total === 1 ? "result" : "results"}` : "" },
      search: { q },
      items: rows.map(pr.card),
      side: pr.sidebar(),
      empty: note || (q ? "Nothing matched. Try fewer or different words." : "Type a word or two to search."),
      pagination: pages > 1 ? { page, pages, prev: page > 1 ? link(page - 1) : null, next: page < pages ? link(page + 1) : null, items: Array.from({ length: pages }, (_, i) => ({ n: i + 1, url: link(i + 1), current: i + 1 === page })) } : null,
    });
  });

  // The page a signup form was on, as a path on this site (anything else is dropped).
  const localSource = (value) => {
    const v = String(value || "").trim();
    let p = "";
    if (v.startsWith("/")) p = v;
    else if (isHttpUrl(v)) {
      try {
        const u = new URL(v);
        if (u.origin === new URL(ctx.site().origin).origin) p = u.pathname;
      } catch {
        p = "";
      }
    }
    p = p.split(/[?#]/)[0];
    return isSafeLocalPath(p) ? p : "";
  };

  // Newsletter signup. A new address is only recorded as "pending" and gets one email with a confirm link; it is not
  // mailed newsletters until that link is used. The page says the same thing whatever happened, so it can't be used to
  // find out who is subscribed. Newsletters are written and sent from Admin > Newsletter.
  app.post(`${base}/subscribe`, async (c) => {
    const site = ctx.site();
    const meta = { title: `Subscribe | ${site.name}`, description: site.description, canonical: "", robots: "noindex", og: null };
    if (!sameOrigin(c, ctx)) return c.text("Forbidden", 403);
    let form;
    try {
      form = await c.req.parseBody();
    } catch {
      return html(c, "public/subscribed.njk", { meta, ok: false, message: "That request couldn’t be read. Please try again." }, 400);
    }
    const email = normalizeEmail(typeof form.email === "string" ? form.email : "");
    // In this order: the honeypot, a real-looking address, the sender's network, the address itself, then the site-wide cap.
    if (form.website) return html(c, "public/subscribed.njk", { meta, ok: true }); // honeypot: pretend it worked
    if (!isEmail(email)) return html(c, "public/subscribed.njk", { meta, ok: false, message: "That email address doesn’t look right." }, 400);
    if (!takeClient(subscribeLimit, c, ctx)) return html(c, "public/subscribed.njk", { meta, ok: false, message: "Too many signups from your network. Try again in an hour." }, 429);
    // An address asked about more than three times an hour gets the same page as everyone and nothing more (the mails are already on their way).
    if (!subscribeAddr.take(email.toLowerCase())) return html(c, "public/subscribed.njk", { meta, ok: true });
    // Looked at, not used up, until a mail is really due: requests that send nothing don't spend the site-wide cap.
    if (subscribeAll.count("all") >= SUBSCRIBE_CAP) return html(c, "public/subscribed.njk", { meta, ok: false, message: "We’re getting a lot of signups right now. Please try again later." }, 429);
    if (ctx.mailer?.ready && !ctx.mailer.ready()) return html(c, "public/subscribed.njk", { meta, ok: false, message: "Newsletter sign-ups open once the site’s email is set up. Please check back soon." }, 503);
    const source = localSource(typeof form.source === "string" ? form.source : "");
    const result = store.subscribers.add(email, source, { confirmed: false });
    // A pending address that was mailed a link a few minutes ago gets no new token and no mail.
    const confirmToken = result.confirmToken ?? result.token ?? null;
    if (result.status === "pending" && confirmToken) {
      subscribeAll.take("all");
      // Not awaited: the reply must not depend on whether the address is new or how fast the mail server is.
      const url = site.abs(`${base}/subscribe/confirm/${confirmToken}/`);
      Promise.resolve(ctx.mailer?.sendConfirmSubscription?.(result.subscriber, url)).catch(() => {});
    }
    return html(c, "public/subscribed.njk", { meta, ok: true });
  });

  // Token pages (confirm, unsubscribe): never cached, no analytics tag (the token is in the address), and the address is
  // never sent to another site. "same-origin", not "no-referrer": with no-referrer a browser posts the page's own forms
  // with "Origin: null", which sameOrigin refuses, so the confirm and resubscribe buttons would always answer 403.
  const tokenPage = (c, template, title, data, status = 200) => {
    const site = ctx.site();
    c.set("noAnalytics", true);
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "same-origin");
    return html(c, template, { meta: { title: `${title} | ${site.name}`, description: "", canonical: "", robots: "noindex, nofollow", og: null }, ...data }, status);
  };

  // Confirm link in the confirmation email. Opening it only shows a button: mail scanners follow links, so a GET must never confirm.
  const confirmPage = (c, data, status = 200) => tokenPage(c, "public/confirm.njk", "Confirm subscription", { action: `${base}/subscribe/confirm/${c.req.param("token")}/`, ...data }, status);
  app.get(`${base}/subscribe/confirm/:token/`, (c) => {
    if (tokenBlocked(c)) return tokenTooMany(c);
    if (!TOKEN_RE.test(c.req.param("token"))) {
      takeClient(tokenFail, c, ctx);
      return confirmPage(c, { bad: true }, 404);
    }
    return confirmPage(c, {});
  });
  app.post(`${base}/subscribe/confirm/:token/`, async (c) => {
    if (!sameOrigin(c, ctx)) return c.text("Forbidden", 403);
    if (tokenBlocked(c)) return tokenTooMany(c);
    const sub = TOKEN_RE.test(c.req.param("token")) ? store.subscribers.confirm(c.req.param("token")) : null;
    if (!sub) takeClient(tokenFail, c, ctx);
    return sub ? confirmPage(c, { done: true }) : confirmPage(c, { bad: true }, 404);
  });

  // Unsubscribe links in newsletters. The private code in the link is the proof, so the POST also
  // works as the one-click unsubscribe that Gmail and Outlook send (List-Unsubscribe-Post).
  const unsubscribePage = (c, data, status = 200) => {
    const sub = data.sub || null;
    return tokenPage(c, "public/unsubscribe.njk", "Unsubscribe", {
      ...data,
      // The page shows a masked address and only the status, never the whole record.
      sub: sub ? { status: sub.status } : null,
      maskedEmail: sub ? maskEmail(sub.email) : "",
      action: `${base}/unsubscribe/${c.req.param("token")}/`,
    }, status);
  };
  const lookUnsubscribe = (c) => {
    const token = c.req.param("token");
    const sub = /^[\w.~-]{1,200}$/.test(token) ? store.subscribers.byUnsubscribeToken(token) : null;
    if (!sub) takeClient(tokenFail, c, ctx);
    return sub;
  };
  app.get(`${base}/unsubscribe/:token/`, (c) => {
    if (tokenBlocked(c)) return tokenTooMany(c);
    const sub = lookUnsubscribe(c);
    return unsubscribePage(c, { sub }, sub ? 200 : 404);
  });
  app.post(`${base}/unsubscribe/:token/`, async (c) => {
    // One-click unsubscribe (RFC 8058) is authorised by the token alone, so there is no origin check. Only wrong tokens count
    // against the sender's budget, so a right one is never refused.
    if (tokenBlocked(c)) return tokenTooMany(c);
    const sub = lookUnsubscribe(c);
    if (!sub) return unsubscribePage(c, { sub }, 404);
    const body = await c.req.parseBody().catch(() => ({}));
    if (body.again && sameOrigin(c, ctx)) {
      // Only the subscriber's own link can bring an unsubscribed address back.
      if (sub.status === "unsubscribed") store.subscribers.resubscribe(sub.id);
      return unsubscribePage(c, { sub: store.subscribers.get(sub.id), again: true });
    }
    if (sub.status === "active") store.subscribers.unsubscribe(sub.id);
    return unsubscribePage(c, { sub: store.subscribers.get(sub.id), done: sub.status !== "pending" });
  });

  const rss = (feed) => (c) => {
    const pr = presenter();
    const site = pr.site;
    const data = feed(c, pr, site);
    if (!data) return notFound(c);
    // Characters XML forbids (U+0000 to U+0008 and so on) would make readers reject the whole feed.
    const x = xmlText;
    const items = data.posts.map((p) => {
      const card = pr.card(p);
      return { ...card, title: x(card.title), excerpt: x(card.excerpt), link: x(site.abs(card.url)), date: rfc822(p.published_at), categoryName: x(card.category?.name || ""), author: card.author ? { ...card.author, name: x(card.author.name) } : null };
    });
    const body = views.render("public/rss.njk", { site: templateSite(site), title: x(data.title), link: x(site.abs(data.link)), selfLink: x(site.abs(data.self)), description: x(data.description), items, built: rfc822(items[0]?.published || new Date().toISOString()) });
    return c.body(body, 200, { "Content-Type": "application/rss+xml; charset=utf-8" });
  };
  app.get(`${base}/rss.xml`, cached(rss((c, pr, site) => ({ title: site.title, link: site.url.home, self: site.url.rss, description: site.description, posts: store.posts.listPublic({ limit: 20 }) })), { tags: ["lists"] }));
  app.get(`${base}/category/:slug/rss.xml`, cached(rss((c, pr, site) => {
    const cat = store.categories.getBySlug(c.req.param("slug"));
    if (!cat) return null;
    const posts = store.posts.listPublic({ categoryIds: categoryIds(site, cat), limit: 20 });
    if (!posts.length) return null;
    return { title: `${cat.name} | ${site.title}`, link: site.url.category(cat.slug), self: `${site.url.category(cat.slug)}rss.xml`, description: cat.description || site.description, posts };
  }), { tags: ["lists"] }));

  // Sitemap with lastmod and image entries. Served at <base>/sitemap.xml (and /sitemap.xml under a sub-folder).
  const sitemap = cached((c) => {
    const pr = presenter();
    const site = pr.site;
    const urls = [];
    const add = (loc, lastmod, images = []) => urls.push({ loc: site.abs(loc), lastmod: lastmod ? isoToYmd(lastmod, site.tz) : "", images });
    const all = store.posts.allPublic();
    const newest = all[0]?.updated_at || all[0]?.published_at;
    add(site.url.home, newest);
    add(site.url.latest, newest);
    for (const p of all) {
      if (p.noindex || (p.canonical_url && p.canonical_url !== site.abs(site.url.post(p.slug)))) continue;
      const img = pr.media(p.feature_image_id);
      add(site.url.post(p.slug), p.updated_at || p.published_at, img ? [{ loc: site.abs(site.url.media(img.path)), title: p.feature_image_alt || p.title }] : []);
    }
    const lastOf = (rows) => rows[0]?.updated_at || rows[0]?.published_at;
    for (const cat of site.categories) {
      const rows = store.posts.listPublic({ categoryIds: categoryIds(site, cat), limit: 1 });
      if (rows.length) add(site.url.category(cat.slug), lastOf(rows));
    }
    for (const t of store.tags.list().filter((t) => t.post_count)) add(site.url.tag(t.slug), lastOf(store.posts.listPublic({ tagId: t.id, limit: 1 })));
    for (const u of store.users.list()) {
      const rows = store.posts.listPublic({ authorId: u.id, limit: 1 });
      if (rows.length) add(site.url.author(u.slug), lastOf(rows));
    }
    return c.body(views.render("public/sitemap.njk", { urls }), 200, { "Content-Type": "application/xml; charset=utf-8" });
  }, { tags: ["lists"] });
  app.get(`${base}/sitemap.xml`, sitemap);
  if (base) app.get("/sitemap.xml", sitemap);

  app.get("/robots.txt", (c) => {
    const site = ctx.site();
    const lines = ["User-agent: *", "Allow: /", `Disallow: ${base}/admin/`, `Disallow: ${base}/account/`, `Disallow: ${base}/search/`, `Disallow: ${base}/unsubscribe/`, `Disallow: ${base}/subscribe/`,
      // Pages whose address carries a one-time token, and the sign-in pages.
      `Disallow: ${base}/signin/`, `Disallow: ${base}/signup/`, `Disallow: ${base}/signout/`, `Disallow: ${base}/forgot/`, `Disallow: ${base}/reset/`, `Disallow: ${base}/verify/`, ""];
    if (site.s.ai_training === "block") {
      for (const ua of ["GPTBot", "ClaudeBot", "Google-Extended", "CCBot", "Applebot-Extended", "meta-externalagent"]) lines.push(`User-agent: ${ua}`, "Disallow: /", "");
    }
    lines.push(`Sitemap: ${site.blogUrl}/sitemap.xml`);
    return c.text(`${lines.join("\n")}\n`);
  });

  // IndexNow key file (keyLocation in pings points here).
  app.get(`${base}/:key{[0-9a-f]{32}\\.txt}`, (c) => {
    const key = store.settings.get("indexnow_key");
    return key && safeEq(c.req.param("key"), `${key}.txt`) ? c.text(key) : notFound(c);
  });

  // The media row for a file: the original, or one of the resized copies listed on an image's row.
  // Files that no row knows about are never served.
  // A resized copy's name is its original's name plus "-<width>.webp" or ".avif", so the original is found with a handful of
  // exact lookups, never a scan of the table.
  const ORIGINAL_EXTS = ["jpg", "jpeg", "png", "webp", "avif", "gif"];
  function mediaFor(rel) {
    const direct = store.media.getByPath(rel);
    if (direct) return direct;
    const v = /^(.+)-\d+\.(?:avif|webp)$/.exec(rel);
    if (!v) return null;
    for (const ext of ORIGINAL_EXTS) {
      const row = store.media.getByPath(`${v[1]}.${ext}`);
      if (row && Object.values(row.variants || {}).flat().some(([, p]) => p === rel)) return row;
    }
    return null;
  }
  // Whether a file is used by anything public (a live post or page, the site settings, a profile, a live banner). Remembered until
  // the next content change.
  function isPublicMedia(m) {
    if (typeof store.media.isPublic !== "function") return true;
    let v = publicMedia.get(m.id);
    if (v === undefined) {
      v = Boolean(store.media.isPublic(m.id));
      if (publicMedia.size >= 5000) publicMedia.clear();
      publicMedia.set(m.id, v);
    }
    return v;
  }

  // Uploaded media. Names carry a hash of the content, so a file never changes under its name, but a removed file stops
  // being served and browsers re-check after an hour (five minutes for downloads), so a withdrawn file doesn't linger in caches.
  // A file nothing public uses (a draft's picture) is never stored by caches at all. Ranges are supported. SVGs get a CSP that
  // blocks scripts if opened directly; files (PDF, STL, ZIP...) are always downloaded under their original name. Files are
  // streamed, not read into memory.
  app.get(`${base}/media/*`, async (c) => {
    // Hono has already decoded the path once; decoding again would turn a literal "%2F" into a folder separator.
    const rel = c.req.path.slice(`${base}/media/`.length);
    const gone = () => c.text("Not found", 404);
    if (!rel || rel.length > 300 || hasControlChars(rel) || rel.includes("\\") || rel.split("/").some((s) => !s || s === "." || s === "..")) return gone();
    const m = mediaFor(rel);
    if (!m) return gone();
    const file = path.resolve(ctx.mediaDir, rel);
    if (!file.startsWith(ctx.mediaDir + path.sep)) return gone();
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext];
    if (!type) return gone();
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st?.isFile()) return gone();
    const attach = ATTACH.has(ext);
    const open = isPublicMedia(m);
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      "Content-Type": type,
      "Cache-Control": !open ? "private, no-store" : attach ? "public, max-age=300, must-revalidate" : "public, max-age=3600, must-revalidate",
      "Accept-Ranges": "bytes",
    };
    if (open) {
      headers.ETag = etag;
      headers["Last-Modified"] = st.mtime.toUTCString();
    }
    if (type === "image/svg+xml") headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    if (attach) {
      headers["Content-Disposition"] = contentDisposition(m.original_name || path.basename(file));
      headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
    }
    if (open && notModified(c, etag)) return c.body(null, 304, headers);
    // One byte range ("bytes=0-99", "bytes=500-", "bytes=-200") is answered with 206; anything else is the whole file.
    const range = c.req.method === "GET" ? /^bytes=(\d*)-(\d*)$/.exec((c.req.header("range") || "").trim()) : null;
    const ifRange = c.req.header("if-range");
    if (range && (range[1] || range[2]) && (!ifRange || ifRange === etag)) {
      const last = st.size - 1;
      const start = range[1] === "" ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
      const end = range[1] === "" || range[2] === "" ? last : Math.min(Number(range[2]), last);
      if (start > end || start > last) return c.body(null, 416, { ...headers, "Content-Range": `bytes */${st.size}` });
      headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
      headers["Content-Length"] = String(end - start + 1);
      return c.body(Readable.toWeb(fs.createReadStream(file, { start, end })), 206, headers);
    }
    headers["Content-Length"] = String(st.size);
    if (c.req.method === "HEAD") return c.body(null, 200, headers);
    return c.body(Readable.toWeb(fs.createReadStream(file)), 200, headers);
  });

  app.get(`${base}/assets/fonts/:file`, async (c) => {
    const file = assets.fontFile(c.req.param("file"));
    if (!file) return notFound(c);
    return c.body(await fs.promises.readFile(file), 200, { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000, immutable" });
  });

  // Open Graph images, generated on first request and cached on disk. Only what the public site shows has an image.
  // The address of the image is remembered (until the next content change), so a repeat request doesn't load the post again. The
  // answer is cached for an hour and checked with an ETag after that, so a retitled or unpublished post's old image doesn't linger.
  app.get(`${base}/og/:kind/:file{[0-9]+\\.png}`, async (c) => {
    if (!takeClient(ogLimit, c, ctx)) return c.text("Too many requests", 429, { "Retry-After": "60", "Cache-Control": "no-store" });
    const id = Number(c.req.param("file").replace(".png", ""));
    const memoKey = `${c.req.param("kind")}/${id}`;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let file = ogFiles.get(memoKey);
        if (!file) {
          const input = Number.isSafeInteger(id) ? ogInput(c.req.param("kind"), id) : null;
          if (!input) return c.text("Not found", 404);
          const g = gen;
          file = await ogImageFile(input, path.join(config.dataDir, "cache", "og"));
          if (g === gen) {
            if (ogFiles.size >= 2000) ogFiles.clear();
            ogFiles.set(memoKey, file);
          }
        }
        const etag = `W/"${path.basename(file, ".png")}"`;
        const headers = { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600, must-revalidate", ETag: etag };
        if (notModified(c, etag)) return c.body(null, 304, headers);
        const body = await fs.promises.readFile(file).catch(() => null);
        if (body) return c.body(body, 200, headers);
        ogFiles.delete(memoKey); // pruned since: make it again
      }
      return c.text("Image not available", 404, { "Cache-Control": "no-store" });
    } catch (err) {
      console.warn(`[og] image not made: ${String(err?.message || err).slice(0, 160)}`);
      return c.text("Image not available", 404, { "Cache-Control": "no-store" });
    }
  });

  const OG_KINDS = new Set(["post", "page", "category", "tag", "author", "home", "latest"]);
  function ogInput(kind, id) {
    if (typeof kind !== "string" || !OG_KINDS.has(kind)) return null;
    const site = ctx.site();
    const mediaFile = (mid) => {
      const m = mid ? store.media.get(mid) : null;
      return m && m.kind !== "file" ? path.join(ctx.mediaDir, m.path) : null;
    };
    const common = { site: site.title, siteName: site.title, logoFile: mediaFile(site.s.logo_id) };
    if (kind === "post" || kind === "page") {
      // Published rows only, and the row must be the kind the address says.
      const p = store.posts.get(id);
      if (!p || !p.isPublic || p.type !== kind) return null;
      const cat = store.categories.get(p.category_id);
      return { ...common, label: p.short_title || cat?.name || "", title: p.title, accent: "", hero: p.feature_image_id, heroFile: mediaFile(p.feature_image_id) };
    }
    let found = null;
    if (kind === "home") found = id === 0 ? { label: "", title: site.title } : null;
    else if (kind === "latest") found = id === 0 ? { label: "", title: "Latest posts" } : null;
    else if (kind === "category") {
      const cat = store.categories.get(id);
      if (cat && store.posts.countPublic({ categoryIds: categoryIds(site, cat) })) found = { label: "Category", title: cat.seo_title || cat.name };
    } else if (kind === "tag") {
      const t = store.tags.get(id);
      if (t && store.posts.countPublic({ tagId: t.id })) found = { label: "Tag", title: `${t.name} ${site.noun.many}` };
    } else if (kind === "author") {
      const u = store.users.get(id);
      if (u && store.posts.countPublic({ authorId: u.id })) found = { label: "Author", title: u.name };
    }
    return found ? { ...common, accent: "", ...found } : null;
  }

  // Views and clicks of sponsor banners, sent by site.js ("v:3,7" or "c:3"). Counts only: no cookies, nothing about the reader.
  // Only banners that are showing right now are counted, and one reader's repeat reports are counted once in a while.
  // These numbers are advisory: a client that sends a same-origin Origin header, or rotates addresses, can still inflate them.
  const beaconSeen = createSeen(50_000, 30 * 60_000); // "ip|kind|ad" -> time of the last counted report; oldest forgotten first
  const BEACON_GAP = { views: 30 * 60_000, clicks: 5 * 60_000 };
  app.post(`${base}/k`, async (c) => {
    if (!sameOrigin(c, ctx) || isBot(c.req.header("user-agent")) || !takeClient(beaconLimit, c, ctx)) return c.body(null, 204);
    const m = /^([vc]):(\d{1,9}(?:,\d{1,9}){0,9})$/.exec((await c.req.text()).slice(0, 120).trim());
    if (!m) return c.body(null, 204);
    const kind = m[1] === "c" ? "clicks" : "views";
    const live = new Set(Object.values(store.ads.live()).flat().map((ad) => ad.id));
    const t = Date.now();
    const ip = clientIp(c, ctx);
    for (const id of new Set(m[2].split(",").map(Number))) {
      if (!live.has(id)) continue;
      if (beaconSeen.seen(`${ip}|${kind}|${id}`, t, BEACON_GAP[kind])) continue;
      store.ads.record(id, kind);
    }
    return c.body(null, 204);
  });

  // Reader accounts and comments.
  memberRoutes(app, ctx, { html, notFound });

  // Source code: one file, or all of them as a ZIP. Browsers and caches must check back each time (the answer is a 304 while
  // nothing changed), so a withdrawn post's files stop being served at once.
  const SOURCE_CACHE = "public, max-age=0, must-revalidate";
  const ZIP_BUDGET = 32 * 1024 * 1024;
  // A published post's source files are remembered (until the next content change, which includes withdrawing the post), with
  // their ETags and their ZIP, so a repeat download does no query, no JSON parsing and no hashing. The ZIPs are bounded in bytes.
  function sourceOf(slug) {
    // The Source code feature switched off in Settings hides the files, and their downloads too.
    if (!ctx.site().postFeatures.includes("code")) return null;
    let e = sourceMemo.get(slug);
    if (e) return e;
    // The narrow query (id, slug and source files only), not the whole post row.
    const post = store.posts.getPublicSourceFiles(slug);
    if (post?.type !== "post") return null;
    const files = (post.source_files || []).filter((x) => isSourceName(x.name || "") && typeof x.code === "string").map((x) => ({ name: x.name, code: x.code, etag: `"${sha(x.code).slice(0, 32)}"` }));
    e = { slug: post.slug, files, zip: null };
    if (sourceMemo.size >= 64) {
      const [oldKey, old] = sourceMemo.entries().next().value;
      if (old.zip) zipBytes -= old.zip.data.length;
      sourceMemo.delete(oldKey);
    }
    sourceMemo.set(slug, e);
    return e;
  }
  app.get(`${base}/:slug/source/:name`, (c) => {
    if (!takeClient(sourceLimit, c, ctx)) return c.text("Too many downloads. Wait a minute and try again.", 429, { "Retry-After": "60" });
    const name = c.req.param("name");
    const file = isSourceName(name) ? sourceOf(c.req.param("slug"))?.files.find((x) => x.name === name) : null;
    if (!file) return notFound(c);
    const headers = { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": contentDisposition(file.name), "Cache-Control": SOURCE_CACHE, ETag: file.etag };
    if (notModified(c, file.etag)) return c.body(null, 304, headers);
    return c.body(file.code, 200, headers);
  });
  // The ZIP is built once per version of the files, not on every download.
  app.get(`${base}/:slug/source.zip`, (c) => {
    if (!takeClient(sourceLimit, c, ctx)) return c.text("Too many downloads. Wait a minute and try again.", 429, { "Retry-After": "60" });
    const entry = sourceOf(c.req.param("slug"));
    const files = entry ? entry.files.filter((x) => x.code) : [];
    if (!files.length) return notFound(c);
    if (!entry.zip) {
      const data = zipFiles(files, entry.slug);
      for (const e of sourceMemo.values()) {
        if (zipBytes + data.length <= ZIP_BUDGET) break;
        if (e.zip) {
          zipBytes -= e.zip.data.length;
          e.zip = null;
        }
      }
      entry.zip = { data, etag: `"${sha(JSON.stringify([entry.slug, files.map((x) => x.etag)])).slice(0, 32)}"` };
      zipBytes += data.length;
    }
    const zip = entry.zip;
    const headers = { "Content-Type": "application/zip", "Content-Disposition": contentDisposition(`${entry.slug}.zip`), "Cache-Control": SOURCE_CACHE, ETag: zip.etag };
    if (notModified(c, zip.etag)) return c.body(null, 304, headers);
    return c.body(zip.data, 200, headers);
  });

  // One counted view per reader, post and day (the reader is the client address); prefetches, HEAD requests and bots don't count.
  // Advisory too: the table forgets its oldest addresses when full (it never stops counting), and one post counts at most 300
  // views a minute.
  const viewsSeen = createSeen(100_000, 86_400_000);
  let viewsDay = "";
  function countView(c, id) {
    if (c.req.method !== "GET" || isBot(c.req.header("user-agent"))) return;
    if (/prefetch/i.test(`${c.req.header("purpose") || ""} ${c.req.header("sec-purpose") || ""}`)) return;
    const day = new Date().toISOString().slice(0, 10);
    if (day !== viewsDay) {
      viewsSeen.clear();
      viewsDay = day;
    }
    if (viewsSeen.seen(`${clientIp(c, ctx)}|${id}`, Date.now()) || !viewBudget.take(String(id))) return;
    store.posts.addView(id);
  }

  // Posts and pages share /<base>/<slug>/. A page served from the cache never loads the post's row; the cached entry
  // remembers which post it was so the view can still be counted.
  app.get(`${base}/:slug/`, cached((c) => {
    const post = store.posts.getPublicBySlug(c.req.param("slug"));
    if (!post) return notFound(c);
    if (post.type === "post") {
      countView(c, post.id);
      c.set("cacheMeta", { viewId: post.id });
    }
    // The page shows this post, so it is dropped from the cache when the post changes (see members: comments and likes).
    const tags = [`post:${post.id}`];
    c.set("cacheTags", tags);
    const pr = presenter();
    const view = pr.full(post);
    if (post.type === "page") return html(c, ...pageView(post, view));
    const related = store.posts.related(post, 3).map(pr.card);
    const data = { meta: view.meta, post: view, related, newsletterSource: view.url, bodyParts: splitForSlot(view.html) };
    // "Classic with sidebar" shows the News, Most read and newsletter boxes beside the article.
    if (designOf(c).article === "classic") data.side = pr.sidebar({ excludeIds: [post.id] });
    // It also shows these readers' names, so a rename drops it too.
    if (view.commentsOn) {
      data.thread = store.comments.thread(post.id);
      const readers = new Set();
      for (const top of data.thread.comments) {
        if (top.member_id) readers.add(top.member_id);
        for (const r of top.replies || []) if (r.member_id) readers.add(r.member_id);
      }
      for (const id of readers) tags.push(`member:${id}`);
      const m = c.get("member");
      data.liked = m ? store.comments.likedBy(m.member.id, post.id) : new Set();
      if (m) {
        const key = c.req.query("c");
        data.commentNotice = typeof key === "string" && Object.hasOwn(NOTICES, key) ? NOTICES[key] : null;
      }
    }
    return html(c, "public/post.njk", data);
  }, { onHit: (c, meta) => meta?.viewId && countView(c, meta.viewId) }));

  // Renders a draft with the public templates for the editor's Preview button.
  ctx.renderPreview = (c, post) => {
    const pr = presenter();
    const view = pr.full(post, { preview: true });
    const data = { meta: view.meta, post: view, related: [], preview: true, thread: { comments: [], count: 0 }, liked: new Set(), bodyParts: splitForSlot(view.html) };
    if (post.type === "page") {
      const [template, extra] = pageView(post, view);
      return html(c, template, { ...data, ...extra });
    }
    return html(c, "public/post.njk", data);
  };

  // Admin > Design: the home page or the newest post, drawn with the look being tried (c.set("design", ...)). Never cached,
  // no analytics, no view counted, no banners.
  ctx.renderDesignPreview = (c, page) => {
    c.set("noAnalytics", true);
    c.set("noSlots", true);
    // The admin's security rules don't run the site's own script, and the frame needs none of it.
    c.set("designPreview", true);
    const pr = presenter();
    // Of the 30 newest posts, the one that shows the most of the article's parts (source code, downloads, a table, a picture,
    // a contents list); News items are usually short, so they come last.
    const newsId = pr.site.newsCat?.id;
    const score = (r) => {
      const body = r.body_md || "";
      return (r.source_files?.length ? 8 : 0) + (r.downloads?.github || r.downloads?.files?.length ? 4 : 0) + (/^\|.*\|\s*$/m.test(body) ? 2 : 0)
        + (r.feature_image_id ? 2 : 0) + ((body.match(/^## /gm) || []).length > 1 ? 1 : 0) - (newsId && r.category_id === newsId ? 10 : 0);
    };
    const best = page === "post" ? store.posts.listPublic({ limit: 30 }).reduce((a, r) => (!a || score(r) > score(a) ? r : a), null) : null;
    const post = best && store.posts.getPublicBySlug(best.slug);
    if (!post) return homePage(c);
    const view = pr.full(post);
    const thread = view.commentsOn ? store.comments.thread(post.id) : { comments: [], count: 0 };
    const side = designOf(c).article === "classic" ? pr.sidebar({ excludeIds: [post.id] }) : undefined;
    return html(c, "public/post.njk", { meta: view.meta, post: view, related: store.posts.related(post, 3).map(pr.card), bodyParts: splitForSlot(view.html), thread, liked: new Set(), side });
  };

  // About, Contact, Advertise and legal pages have their own layouts, filled from categories, Settings and the
  // ad places; other pages are plain.
  function pageView(post, view) {
    const site = ctx.site();
    const data = { meta: view.meta, post: view };
    const business = templateSite(site).business;
    if (/^contact(-us)?$/.test(post.slug || "")) return ["public/page-contact.njk", data];
    if (isLegalSlug(post.slug)) {
      const art = /cookie/.test(post.slug) ? "cookie" : /privacy/.test(post.slug) ? "shield" : "file";
      return ["public/page-legal.njk", { ...data, art, legalOthers: site.legal.filter((l) => l.url !== view.url) }];
    }
    if (/^advertis(e|ing)(-with-us)?$/.test(post.slug || "")) {
      // Places switched off in Admin > Ads aren't offered; the rest are numbered in order for the maps.
      const off = new Set(site.s.ads_places_off || []);
      const places = Object.entries(AD_PLACES).filter(([key]) => !off.has(key)).map(([key, pl], i) => ({ key, n: i + 1, ...pl }));
      const email = business.emails[0];
      const bookUrl = email ? `mailto:${email}?subject=${encodeURIComponent(`Advertising on ${site.title}`)}` : site.pageUrls.contact || "";
      const heroButtons = [bookUrl && { label: "Ask for the rate card", url: bookUrl, icon: "mail" }, places.length && { label: "See the banner places", url: "#places" }].filter(Boolean);
      return ["public/page-advertise.njk", { ...data, places, placeNo: Object.fromEntries(places.map((x) => [x.key, x.n])), bookUrl, heroButtons }];
    }
    if (!/^about(-us)?$/.test(post.slug || "")) return ["public/page.njk", data];
    const cats = site.categories;
    const TOPIC_ICONS = [[/project/, "chip"], [/tutorial|guide|learn/, "book"], [/news/, "rss"]];
    const topics = cats.filter((k) => !k.parent_id).map((k) => ({
      name: k.name,
      description: k.description,
      url: site.url.category(k.slug),
      count: k.post_count + cats.filter((x) => x.parent_id === k.id).reduce((n, x) => n + x.post_count, 0),
      icon: TOPIC_ICONS.find(([re]) => re.test(k.slug))?.[1] || "folder",
    }));
    // An empty category answers 404, so only one with posts gets the button.
    const projects = topics.find((t) => t.icon === "chip" && t.count);
    const heroButtons = [{ label: projects ? "Explore the projects" : "Read the latest posts", url: projects?.url || site.url.latest }];
    if (site.pageUrls.contact) heroButtons.push({ label: "Contact us", url: site.pageUrls.contact });
    let brandHost = "";
    try {
      brandHost = business.brandUrl ? new URL(business.brandUrl).hostname.replace(/^www\./, "") : "";
    } catch {}
    return ["public/page-about.njk", { ...data, topics, heroButtons, brandHost }];
  }
}
