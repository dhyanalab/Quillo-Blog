// Turns database rows into what the templates need: URLs, dates, images, rendered Markdown, source files, SEO.
import crypto from "node:crypto";
import { highlight, langFor, langLabel, MAX_HIGHLIGHT_TOTAL } from "../render/code.js";
import { createMarkdown, estimateHtmlSize, MAX_BODY_HTML, TOO_LONG, tocFromTokens } from "../render/markdown.js";
import { highlightMarkers } from "../render/checks.js";
import { bestVariant, FILE_TYPES, pictureHtml } from "../render/media.js";
import { ogHash } from "../render/og.js";
import * as schema from "../render/schema.js";
import { escapeHtml, formatDate, isHttpUrl, isoDurationToSeconds, isoWithOffset, readingMinutes, secondsToClock, timestampToSeconds } from "../render/util.js";
import { networkOf } from "./networks.js";

export const LEVELS = { 1: "Beginner", 2: "Intermediate", 3: "Advanced", 4: "Expert" };
export const ROBOTS = "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1";

// Image `sizes` for the layouts in site.css and article.css.
export const SIZES = {
  body: "(max-width: 640px) calc(100vw - 32px), (max-width: 1000px) calc(100vw - 40px), 760px",
  hero: "100vw",
  story: "(max-width: 1080px) calc(100vw - 40px), 800px",
  card: "(max-width: 640px) calc(100vw - 32px), (max-width: 1080px) 45vw, 280px",
  row: "(max-width: 640px) 110px, 270px",
  thumb: "120px",
};

const FILE_ICONS = { pdf: "pdf", stl: "cube", "3mf": "cube", step: "cube", stp: "cube", zip: "zip" };

// One shared parser. It holds no site: each render passes its own (env.siteHost, env.basePath), so a second site object
// (a test, a second app) never inherits the first one's host. The argument is kept only for older callers.
let md;
export const markdown = () => (md ??= createMarkdown({}));

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// A Map that holds on to rendered article HTML and highlighted code, bounded by entry count and by bytes (strings are kept
// alive until the next content change, so a few huge posts must not fill the heap). The oldest entries go first.
export function createRenderMemo({ maxEntries = 180, maxBytes = 32 * 1024 * 1024 } = {}) {
  const map = new Map();
  let bytes = 0;
  const sizeOf = (key, v) => 2 * (key.length + (typeof v === "string" ? v.length : (v?.html?.length || 0) + 64));
  const drop = (k) => {
    const hit = map.get(k);
    if (!hit) return;
    bytes -= hit.size;
    map.delete(k);
  };
  return {
    get: (k) => map.get(k)?.value,
    has: (k) => map.has(k),
    set(k, value) {
      const size = sizeOf(k, value);
      drop(k);
      if (size > maxBytes / 4) return this; // one huge entry never pushes out everything else
      while (map.size >= maxEntries || bytes + size > maxBytes) drop(map.keys().next().value);
      map.set(k, { value, size });
      bytes += size;
      return this;
    },
    delete: (k) => drop(k),
    clear() {
      map.clear();
      bytes = 0;
    },
    keys: () => map.keys(),
    get size() {
      return map.size;
    },
    get bytes() {
      return bytes;
    },
  };
}

// `memo` (optional) is a Map that outlives one request. It holds finished article HTML and highlighted code, keyed by the
// content itself, so the same post is not parsed and highlighted again on every cache miss. The owner of the Map empties it
// whenever site content changes (images and alt text are part of the output).
export function createPresenter({ store, site: siteRef, memo: shared = null }) {
  const site = siteRef.current();
  const remember = (key, value, max = 60) => {
    if (!shared) return value;
    if (shared.size >= max) shared.delete(shared.keys().next().value);
    shared.set(key, value);
    return value;
  };
  // What every render of the shared parser needs to know about this site.
  const renderEnv = () => ({ siteHost: site.host, basePath: site.base });
  const memo = { users: new Map(), cats: new Map(), media: new Map() };
  const cached = (map, id, load) => {
    if (!id) return null;
    if (!map.has(id)) map.set(id, load(id));
    return map.get(id);
  };
  const media = (id) => cached(memo.media, id, store.media.get);
  const mediaUrl = (p) => site.url.media(p);
  const picture = (m, opts) => (m ? pictureHtml(m, { url: mediaUrl, ...opts }) : "");

  function author(id) {
    return cached(memo.users, id, (uid) => {
      const u = store.users.get(uid);
      if (!u) return null;
      const photo = media(u.photo_id);
      return {
        id: u.id,
        name: u.name,
        slug: u.slug,
        url: site.url.author(u.slug),
        job_title: u.job_title,
        bio: u.bio,
        links: (u.links || []).filter(isHttpUrl).map((l) => ({ url: l, label: networkOf(l).name, id: networkOf(l).id })),
        photoUrl: photo ? mediaUrl(bestVariant(photo, 400)) : "",
        hasPhoto: Boolean(photo),
        avatar: (size, alt = "") => picture(photo, { alt, sizes: `${size}px` }),
      };
    });
  }
  const category = (id) => cached(memo.cats, id, (cid) => {
    const c = store.categories.get(cid);
    return c ? { ...c, url: site.url.category(c.slug) } : null;
  });

  // Small view of a post for cards, rows and lists.
  function card(p) {
    const img = media(p.feature_image_id);
    const cat = category(p.category_id);
    const alt = p.feature_image_alt || img?.alt || "";
    return {
      id: p.id,
      type: p.type,
      url: site.url.post(p.slug),
      title: p.title,
      short_title: p.short_title || p.title,
      excerpt: p.excerpt,
      category: cat,
      author: author(p.author_id),
      published: p.published_at,
      updated: p.updated_at || p.published_at,
      publishedDisplay: formatDate(p.published_at, site.tz),
      updatedDisplay: formatDate(p.updated_at || p.published_at, site.tz),
      readMinutes: readingMinutes(p.word_count),
      level: LEVELS[p.level] || "",
      hasImage: Boolean(img),
      image: (sizes = SIZES.card, eager = false) => picture(img, { alt, sizes, eager }),
      // An image, or a drawn placeholder so rows never collapse.
      thumb: (sizes = SIZES.card, eager = false) => (img ? picture(img, { alt, sizes, eager }) : '<span class="thumb-ph" aria-hidden="true"><svg width="40%" viewBox="0 0 120 70" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="14" width="100" height="42" rx="4"/><rect x="44" y="24" width="32" height="22" rx="2"/><path d="M20 14V7M30 14V7M40 14V7M50 14V7M60 14V7M70 14V7M80 14V7M90 14V7M100 14V7M20 63v-7M30 63v-7M40 63v-7M50 63v-7M60 63v-7M70 63v-7M80 63v-7M90 63v-7M100 63v-7"/></svg></span>'),
      state: p.state,
    };
  }

  function renderBody(text, { preview = false, eagerFirstImage = false } = {}) {
    const source = String(text || "");
    const memoKey = shared && !preview ? `body:${eagerFirstImage ? 1 : 0}:${site.host}${site.base}:${sha(source)}` : "";
    const known = memoKey && shared.get(memoKey);
    if (known) return { ...known, tokens: [] };
    const mdi = markdown();
    const tokens = mdi.parse(source, renderEnv());
    // A body that would make a huge page is not built at all (an estimate from the parsed text), and one that still
    // comes out over the limit is replaced after the fact. Either way the page shows a short notice.
    const tooLong = () => {
      const result = { html: `<p class="marker">${TOO_LONG}</p>`, toc: [], tokens: [], tooLong: true };
      if (memoKey) remember(memoKey, { html: result.html, toc: result.toc, tooLong: true });
      return result;
    };
    if (estimateHtmlSize(tokens) > MAX_BODY_HTML * 1.5) return tooLong();
    const prefix = `${site.base}/media/`;
    let first = true;
    const env = {
      ...renderEnv(),
      renderImage: ({ src, alt }) => {
        const eager = eagerFirstImage && first;
        first = false;
        if (src?.startsWith(prefix)) {
          // A bad % escape in the address is just a picture that can't be found, never an error for the whole page.
          let rel = "";
          try {
            rel = decodeURI(src.slice(prefix.length));
          } catch {
            rel = "";
          }
          const m = rel ? store.media.getByPath(rel) : null;
          if (m) return picture(m, { alt: alt || m.alt, sizes: SIZES.body, eager });
          if (preview) return `<mark class="marker">Missing image: ${escapeHtml(src)}</mark>`;
        }
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`;
      },
    };
    let html = mdi.renderer.render(tokens, mdi.options, env);
    if (html.length > MAX_BODY_HTML) return tooLong();
    if (preview) html = highlightMarkers(html);
    const result = { html, toc: tocFromTokens(tokens), tokens };
    if (memoKey) remember(memoKey, { html: result.html, toc: result.toc });
    return result;
  }

  function videoInfo(v) {
    if (!v?.youtube_id || !/^[A-Za-z0-9_-]{11}$/.test(v.youtube_id)) return null;
    const id = v.youtube_id;
    const total = isoDurationToSeconds(v.duration);
    const starts = (v.chapters || []).map((c) => ({ name: c.name, at: c.at, start: timestampToSeconds(c.at) })).filter((c) => c.name && c.start != null);
    return {
      id,
      title: v.title || "",
      description: v.description || "",
      uploadDate: v.upload_date || "",
      uploadDisplay: formatDate(v.upload_date, site.tz),
      duration: v.duration || "",
      durationDisplay: total != null ? secondsToClock(total) : "",
      watchUrl: `https://www.youtube.com/watch?v=${id}`,
      thumbnail: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
      thumbnailFallback: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      chapters: starts.map((c, i) => ({ ...c, end: i + 1 < starts.length ? starts[i + 1].start : total, url: `https://www.youtube.com/watch?v=${id}&t=${c.start}s` })),
    };
  }

  const highlighted = (code, lang) => {
    if (!shared) return highlight(code, lang);
    const key = `code:${lang}:${sha(String(code))}`;
    return shared.get(key) ?? remember(key, highlight(code, lang), 120);
  };

  // Source files with highlighted code, for the Source code box after the article.
  function sourceFiles(p) {
    const base = site.url.post(p.slug);
    // Highlighting is synchronous: one post's files share a total budget, and the rest are shown as plain text.
    let left = MAX_HIGHLIGHT_TOTAL;
    return (p.source_files || []).filter((f) => f.name && f.code).map((f) => {
      const lang = langFor(f.lang, f.name);
      const over = String(f.code).length > left;
      left -= String(f.code).length;
      return {
        name: f.name,
        lang,
        langLabel: langLabel(lang),
        lines: String(f.code).split("\n").length,
        size: Buffer.byteLength(f.code),
        html: highlighted(f.code, over ? "plaintext" : lang),
        url: `${base}source/${encodeURIComponent(f.name)}`,
      };
    });
  }

  // GitHub link and uploaded files (PDF, STL, ZIP...) as download buttons.
  function downloads(p) {
    const d = p.downloads || {};
    const files = (d.files || []).map((f) => {
      const m = media(f.media_id);
      if (!m) return null;
      const ext = m.path.split(".").pop().toLowerCase();
      return { label: f.label || m.original_name, url: mediaUrl(m.path), type: FILE_TYPES[ext]?.label || ext.toUpperCase(), size: m.size, icon: FILE_ICONS[ext] || "file", primary: ["stl", "3mf", "step", "stp"].includes(ext) };
    }).filter(Boolean);
    // The first 3D-print file is the coloured button; everything else is outlined.
    let primaryUsed = false;
    for (const f of files) {
      f.primary = f.primary && !primaryUsed;
      primaryUsed ||= f.primary;
    }
    // Only a real web address becomes a link, in the preview too.
    return { github: isHttpUrl(d.github) ? d.github : "", files: [...files.filter((f) => f.primary), ...files.filter((f) => !f.primary)] };
  }

  // The image route renders the PNG; the hash in the URL changes whenever its inputs do.
  function ogFor(kind, id, input) {
    return { url: site.abs(site.url.og(kind, id, ogHash({ ...input, logo: site.s.logo_id }))), width: 1200, height: 630, alt: input.title };
  }

  const titleTag = (t) => (`${t} | ${site.name}`.length <= 60 ? `${t} | ${site.name}` : t);

  // Everything the post (or page) template needs.
  function full(p, { preview = false } = {}) {
    const c = card(p);
    const img = media(p.feature_image_id);
    const body = renderBody(p.body_md, { preview, eagerFirstImage: !img });
    const tags = store.posts.tagsFor(p.id).map((t) => ({ ...t, url: site.url.tag(t.slug) }));
    const video = videoInfo(p.video);
    const crumbs = [{ name: "Home", url: site.url.home }];
    if (c.category && p.type === "post") crumbs.push({ name: c.category.name, url: c.category.url });
    crumbs.push({ name: p.short_title || p.title });

    // Topic features (Settings > Post features) that are switched off are left out, whatever the post holds.
    const feature = (name) => site.postFeatures.includes(name);
    const files = p.type === "post" && feature("code") ? sourceFiles(p) : [];
    const dl = feature("downloads") ? downloads(p) : { github: "", files: [] };
    const tested = feature("tested") ? p.tested_with || [] : [];
    const glance = [...(p.at_a_glance || [])];
    if (tested.length) glance.push(["Tested with", tested.join(", ")]);
    const commentsOn = p.type === "post" && site.comments.enabled && p.comments_enabled;
    const commentCount = commentsOn && p.id ? store.comments.countFor(p.id) : 0;

    // Contents: the H2s, then the boxes after the article.
    const toc = [...body.toc];
    if (files.length) toc.push({ id: "source-code", text: "Source code" });
    if (dl.files.length || (dl.github && !files.length)) toc.push({ id: "downloads", text: "Downloads" });
    if (commentsOn) toc.push({ id: "comments", text: "Comments" });

    // The social image: the post's own, else (when it has no feature image either) the site's default one, else a generated card.
    const ogImage = p.og_image_id ? media(p.og_image_id) : !img && site.defaultOg ? site.defaultOg : null;
    const og = ogImage
      ? { url: site.abs(mediaUrl(bestVariant(ogImage, 1200))), width: Math.min(ogImage.width || 1200, 1200), height: ogImage.height && ogImage.width ? Math.round((Math.min(ogImage.width, 1200) / ogImage.width) * ogImage.height) : 630, alt: p.og_title || p.title }
      : ogFor(p.type === "page" ? "page" : "post", p.id, { label: p.short_title || c.category?.name || "", title: p.title, accent: "", hero: p.feature_image_id, site: site.name });

    const url = c.url;
    const view = {
      ...c,
      html: body.html,
      toc,
      tokens: body.tokens,
      tags,
      crumbs,
      downloads: dl,
      sourceFiles: files,
      sourceZip: files.length > 1 ? `${url}source.zip` : "",
      video,
      heroHtml: img ? picture(img, { alt: p.feature_image_alt || img.alt, sizes: SIZES.hero, eager: true, className: "hero-img" }) : "",
      heroCaption: p.feature_image_caption,
      quickAnswerHtml: p.quick_answer ? markdown().renderInline(p.quick_answer, renderEnv()) : "",
      glance,
      tested_with: tested,
      publishedIso: isoWithOffset(p.published_at, site.tz),
      updatedIso: isoWithOffset(p.updated_at || p.published_at, site.tz),
      word_count: p.word_count,
      shareUrl: site.abs(url),
      commentsOn,
      commentCount,
    };
    view.meta = {
      title: titleTag(p.seo_title || p.title),
      description: p.excerpt,
      canonical: isHttpUrl(p.canonical_url) ? p.canonical_url : site.abs(url),
      robots: preview || p.noindex ? "noindex, nofollow" : ROBOTS,
      og: {
        type: p.type === "post" ? "article" : "website",
        title: p.og_title || p.title,
        description: p.og_description || p.excerpt,
        image: og,
        published: view.publishedIso,
        modified: view.updatedIso,
        author: c.author ? site.abs(c.author.url) : "",
        section: c.category?.name || "",
        tags: tags.map((t) => t.name),
      },
    };
    const schemaPost = { ...view, author: c.author, category: c.category, videoInfo: video, ogImageUrl: og.url, title: p.title, excerpt: p.excerpt, url };
    view.meta.schema = c.author ? (p.type === "post" ? schema.postGraph(site, schemaPost) : schema.pageGraph(site, schemaPost)) : null;
    return view;
  }

  function listMeta({ title, description, url, page = 1, crumbs, items, hub = false, ogKind, ogId, label }) {
    const pageUrl = page > 1 ? `${url}page/${page}/` : url;
    return {
      title: titleTag(page > 1 ? `${title} (page ${page})` : title),
      description,
      canonical: site.abs(pageUrl),
      robots: ROBOTS,
      og: { type: "website", title, description, image: ogFor(ogKind, ogId, { label: label ?? "", title, accent: "", site: site.name }) },
      schema: schema.collectionGraph(site, { url: pageUrl, name: title, description, crumbs, items, hub }),
    };
  }

  // Sidebar boxes shared by the home page and list pages.
  function sidebar({ excludeIds = [] } = {}) {
    const news = site.newsCat ? store.posts.listPublic({ categoryIds: [site.newsCat.id], limit: 6, excludeIds }).map(card) : [];
    const popular = store.posts.listPublic({ order: "popular", limit: 5, excludeCategoryIds: site.newsCat ? [site.newsCat.id] : [] }).map(card);
    const topics = site.categories.filter((k) => k.post_count && k.id !== site.newsCat?.id).map((k) => ({ name: k.name, url: site.url.category(k.slug), count: k.post_count }));
    return { news, newsUrl: site.newsCat ? site.url.category(site.newsCat.slug) : "", popular, topics };
  }

  return { site, card, full, author, category, media, picture, renderBody, listMeta, titleTag, videoInfo, sidebar, sourceFiles };
}
