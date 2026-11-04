// Markdown -> HTML: tables wrapped in .tbl-wrap, highlighted code blocks with a copy button,
// external links in a new tab, GitHub alerts as callouts, figures and stable heading ids.
import MarkdownIt from "markdown-it";
import { highlight, langFor, MAX_HIGHLIGHT_TOTAL } from "./code.js";
import { escapeHtml, slugify } from "./util.js";

const ALERTS = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

const svg = (body) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ALERT_ICONS = {
  NOTE: svg('<circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v4M8 4.8v.01"/>'),
  TIP: svg('<path d="M5.6 10.6a4.5 4.5 0 1 1 4.8 0V12H5.6z"/><path d="M6.4 14.2h3.2"/>'),
  IMPORTANT: svg('<path d="M2.5 3h11v7.5h-6L4.5 13v-2.5h-2z"/><path d="M8 5.2v2.6M8 9.6v.01"/>'),
  WARNING: svg('<path d="M8 1.8 14.6 13.6H1.4z"/><path d="M8 6.4v3.2M8 11.7v.01"/>'),
  CAUTION: svg('<path d="M5.3 1.5h5.4l3.8 3.8v5.4l-3.8 3.8H5.3l-3.8-3.8V5.3z"/><path d="M8 4.9v3.6M8 11v.01"/>'),
};

const LANG_LABELS = Object.assign(Object.create(null), {
  cpp: "C++", "c++": "C++", c: "C", ino: "Arduino", arduino: "Arduino",
  text: "Serial Monitor", txt: "Text", bash: "Bash", sh: "Shell", shell: "Shell", console: "Console",
  powershell: "PowerShell", ps1: "PowerShell", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML",
  ini: "INI", python: "Python", py: "Python", js: "JavaScript", javascript: "JavaScript",
  html: "HTML", css: "CSS", diff: "Diff", xml: "XML",
});

// Ids the page templates use themselves (and "src-1", "src-2"...). A heading in the article never takes one of
// these, so anchors and aria-labelledby stay unique.
export const RESERVED_IDS = new Set([
  "live", "compose", "comments", "comments-h", "comment-body", "newsletter", "nl-title", "nl-email", "downloads", "downloads-h",
  "source-code", "source-code-h", "quick-answer", "main", "main-nav", "post-title", "page-title", "toc-h", "x-video", "x-author", "x-related",
  "search-bar", "search-q", "head-q", "err-q", "side-email", "side-news", "side-nl", "side-popular", "side-topics", "places", "places-h",
  "app-h", "auth-h", "book-h", "facts-h", "fit-h", "follow-h", "help-h", "how-h", "latest-h", "other-h", "picks-h", "rules-h",
  "acc-cur", "acc-del", "acc-del-pass", "acc-name", "acc-name-in", "acc-new", "acc-out", "acc-pass", "si-email", "si-pass", "su-email", "su-name", "su-pass",
  "fg-email", "rs-pass", "rs-conf",
]);
// "src-<n>" are the source-code boxes and "comment-<n>" the comments. (The category cards' "cat-<slug>" ids exist only on the home
// page, where no article is shown.)
const isReservedId = (id) => RESERVED_IDS.has(id) || /^(?:src|comment)-\d+$/.test(id);

// `> [!NOTE]` as the first line of a blockquote turns it into a typed callout.
function githubAlerts(md) {
  md.core.ruler.after("block", "github_alerts", (state) => {
    const t = state.tokens;
    for (let i = 0; i < t.length - 2; i++) {
      if (t[i].type !== "blockquote_open" || t[i + 1].type !== "paragraph_open" || t[i + 2].type !== "inline") continue;
      // The visual editor saves "[!NOTE]" as "\[!NOTE\]" and may keep text on the same line; all forms work.
      const m = /^\\?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\\?\][ \t]*\n?/i.exec(t[i + 2].content);
      if (!m) continue;
      const type = m[1].toUpperCase();
      t[i].meta = { alert: type };
      let depth = 0;
      for (let j = i; j < t.length; j++) {
        if (t[j].type === "blockquote_open") depth++;
        else if (t[j].type === "blockquote_close" && --depth === 0) {
          t[j].meta = { alert: type };
          break;
        }
      }
      t[i + 2].content = t[i + 2].content.slice(m[0].length);
      // An empty first paragraph is hidden in place. Splicing the token array here would cost O(tokens) per alert.
      if (!t[i + 2].content.trim()) {
        t[i + 1].hidden = true;
        t[i + 2].hidden = true;
        t[i + 2].children = [];
        t[i + 3].hidden = true;
      }
    }
  });

  md.renderer.rules.blockquote_open = (tokens, idx, opts, env, self) => {
    const type = tokens[idx].meta?.alert;
    if (!type) return self.renderToken(tokens, idx, opts);
    return `<div class="callout callout-${type.toLowerCase()}" role="note">\n<p class="callout-title">${ALERT_ICONS[type]}${ALERTS[type]}</p>\n`;
  };
  md.renderer.rules.blockquote_close = (tokens, idx, opts, env, self) =>
    tokens[idx].meta?.alert ? "</div>\n" : self.renderToken(tokens, idx, opts);
}

// Stable ids from heading text, plus a hover/focus "#" link beside h2–h4.
function headingIds(md) {
  md.core.ruler.push("heading_ids", (state) => {
    const used = new Set();
    const next = new Map(); // base -> the next number to try, so every heading costs O(1) however many repeat
    const t = state.tokens;
    for (let i = 0; i < t.length; i++) {
      if (t[i].type !== "heading_open") continue;
      const text = (t[i + 1].children || [])
        .filter((c) => c.type === "text" || c.type === "code_inline")
        .map((c) => c.content)
        .join("")
        .trim();
      const base = slugify(text) || "section";
      let id = base;
      if (used.has(id) || isReservedId(id)) {
        // Every "src-<n>" belongs to the source-code boxes, so repeats of a heading named "src" count as
        // "src-h-<n>"; otherwise the search below would never find a free id.
        const stem = base === "src" ? "src-h" : base;
        let n = next.get(stem) || 2;
        while (used.has(`${stem}-${n}`) || isReservedId(`${stem}-${n}`)) n++;
        id = `${stem}-${n}`;
        next.set(stem, n + 1);
      }
      used.add(id);
      t[i].attrSet("id", id);
      t[i].meta = { ...t[i].meta, text };
    }
  });

  md.renderer.rules.heading_open = (tokens, idx, opts, env, self) => {
    const tok = tokens[idx];
    if (tok.tag === "h1") return self.renderToken(tokens, idx, opts);
    return `<div class="hx hx-${tok.tag.slice(1)}">` + self.renderToken(tokens, idx, opts);
  };
  md.renderer.rules.heading_close = (tokens, idx, opts, env, self) => {
    const tok = tokens[idx];
    if (tok.tag === "h1") return self.renderToken(tokens, idx, opts);
    const open = tokens[idx - 2];
    const id = open.attrGet("id");
    return `${self.renderToken(tokens, idx, opts)}<a class="h-anchor" href="#${id}" aria-label="Link to section: ${escapeHtml(open.meta?.text)}">#</a></div>\n`;
  };
}

// A paragraph holding only an image becomes <figure>; the image title becomes <figcaption>.
// Also marks the first image in the document so it can load eagerly.
function figures(md, { siteHost, basePath = "" } = {}) {
  md.core.ruler.push("figures", (state) => {
    const t = state.tokens;
    let first = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i].type !== "inline" || !t[i].children) continue;
      for (const c of t[i].children) {
        if (c.type !== "image") continue;
        c.meta = { ...c.meta, first, line: t[i].map ? t[i].map[0] : null };
        first = false;
      }
      if (t[i - 1]?.type !== "paragraph_open" || t[i + 1]?.type !== "paragraph_close") continue;
      const kids = t[i].children.filter((c) => !(c.type === "text" && !c.content.trim()) && c.type !== "softbreak");
      // An image alone, or an image with an italic line right under it (the caption).
      const italic = (list) => list.length >= 3 && list[0].type === "em_open" && list.at(-1).type === "em_close" && list.slice(1, -1).every((c) => c.type === "text" || c.type === "code_inline");
      if (kids[0]?.type === "image" && (kids.length === 1 || italic(kids.slice(1)))) {
        t[i - 1].hidden = true;
        t[i + 1].hidden = true;
        kids[0].meta.figure = true;
        if (kids.length > 1) {
          kids[0].meta.caption = kids.slice(2, -1).map((c) => c.content).join("");
          t[i].children = [kids[0]];
        }
        continue;
      }
      // An italic paragraph straight after an image paragraph is that image's caption.
      if (kids.length >= 3 && italic(kids) && t[i - 3]?.type === "inline" && t[i - 2]?.type === "paragraph_close" && t[i - 3].children?.length === 1 && t[i - 3].children[0].meta?.figure && !t[i - 3].children[0].meta.caption && !t[i - 3].children[0].attrGet("title")) {
        t[i - 3].children[0].meta.caption = kids.slice(1, -1).map((c) => c.content).join("");
        t[i - 1].hidden = true;
        t[i + 1].hidden = true;
        t[i].children = [];
      }
    }
  });

  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const tok = tokens[idx];
    const src = tok.attrGet("src");
    const alt = self.renderInlineAsText(tok.children || [], opts, env);
    const title = tok.attrGet("title");
    // A picture that points into the admin area is never drawn (its address would be fetched with the visitor's admin cookie):
    // the alt text is shown instead.
    const host = env?.siteHost ?? (typeof siteHost === "function" ? siteHost() : siteHost) ?? "";
    if (isAdminTarget(src, env?.basePath ?? basePath, host)) return tok.meta?.figure ? `<p>${escapeHtml(alt)}</p>\n` : escapeHtml(alt);
    const img = env?.renderImage
      ? env.renderImage({ src, alt, eager: tok.meta?.first })
      : `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`;
    if (!tok.meta?.figure) return img;
    const text = title || tok.meta?.caption;
    const caption = text ? `<figcaption>${escapeHtml(text)}</figcaption>` : "";
    return `<figure>${img}${caption}</figure>\n`;
  };
}

export const COPY_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';

function codeBlocks(md) {
  const render = (content, lang, env) => {
    // Highlighting is synchronous, so one article gets a total budget; code past it is shown as plain text.
    let plain = false;
    if (env) {
      env.highlighted = (env.highlighted || 0) + content.length;
      plain = env.highlighted > MAX_HIGHLIGHT_TOTAL;
    }
    const cls = lang ? ` class="lang-${escapeHtml(lang)} hljs"` : ' class="hljs"';
    const label = lang ? LANG_LABELS[lang] || lang : "Code";
    const term = lang === "text" || lang === "console" ? " code-term" : "";
    return (
      `<div class="code${term}"><div class="code-bar"><span class="code-lang">${escapeHtml(label)}</span>` +
      `<button type="button" class="code-copy" hidden>${COPY_ICON}<span>Copy</span></button></div>` +
      `<pre><code${cls}>${term || plain ? escapeHtml(content) : highlight(content, langFor(lang))}</code></pre></div>\n`
    );
  };
  md.renderer.rules.fence = (tokens, idx, opts, env) => {
    const tok = tokens[idx];
    const lang = (tok.info || "").trim().split(/\s+/)[0].toLowerCase().slice(0, 30);
    return render(tok.content, lang, env);
  };
  md.renderer.rules.code_block = (tokens, idx, opts, env) => render(tokens[idx].content, "", env);
}

function tables(md) {
  md.renderer.rules.table_open = () => '<div class="tbl-wrap"><table>\n';
  md.renderer.rules.table_close = () => "</table></div>\n";
  // Column alignment (|:--|--:|) becomes a class: the public content policy blocks inline style attributes.
  md.core.ruler.push("table_align_class", (state) => {
    for (const t of state.tokens) {
      if ((t.type !== "th_open" && t.type !== "td_open") || !t.attrs) continue;
      const align = /^text-align:(left|center|right)$/.exec(t.attrGet("style") || "")?.[1];
      t.attrs = t.attrs.filter(([k]) => k !== "style");
      if (align) t.attrJoin("class", `ta-${align}`);
    }
  });
}

function links(md, siteHost) {
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const tok = tokens[idx];
    const rewritten = env?.rewriteHref?.(tok.attrGet("href"));
    if (rewritten) tok.attrSet("href", rewritten);
    // The site comes with each render (env.siteHost), so one shared parser never holds on to the first caller's site.
    const host = env?.siteHost ?? (typeof siteHost === "function" ? siteHost() : siteHost) ?? "";
    // Each distinct address is parsed once per render.
    if (isExternal(tok.attrGet("href"), host, env ? (env.externalMemo ??= new Map()) : null)) {
      tok.attrSet("target", "_blank");
      tok.attrSet("rel", "noopener noreferrer");
    }
    return self.renderToken(tokens, idx, opts);
  };
}

// A web link (http, https, ftp, or "//host/...", with or without backslashes) to another host. mailto:, tel: and the like are not.
export function isExternal(href, siteHost, memo = null) {
  const key = String(href ?? "");
  if (memo?.has(key)) return memo.get(key);
  let out = false;
  try {
    const u = new URL(key, "https://relative.invalid/");
    if (u.hostname !== "relative.invalid" && /^(?:https?|ftps?):$/.test(u.protocol)) out = u.hostname.replace(/^www\./, "") !== String(siteHost || "").replace(/^www\./, "");
  } catch {
    out = false;
  }
  memo?.set(key, out);
  return out;
}

// True when an address (as written in a post) points into this site's admin area. Resolved the way a browser would from a post
// page, and decoded the way the router does, so "/%61dmin/..." and "../admin/..." are caught too.
export function isAdminTarget(src, basePath = "", siteHost = "") {
  let u;
  try {
    u = new URL(String(src ?? ""), `https://site.invalid${basePath}/post/`);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (u.hostname !== "site.invalid" && siteHost && u.hostname.replace(/^www\./, "") !== String(siteHost).replace(/^www\./, "")) return false;
  let p;
  try {
    p = decodeURI(u.pathname);
  } catch {
    return false;
  }
  return p === `${basePath}/admin` || p.startsWith(`${basePath}/admin/`);
}

// Output limits, so a short text can't expand into a huge page: an address longer than `maxChars` is not linked, and links and
// pictures past `maxLinks` in one body show as plain text. The text of a dropped link, or the alt text of a dropped picture,
// still shows. Dropped ones are marked (meta.dropped) so the publish checks can say so.
export const MAX_LINK_CHARS = 2048;
export const MAX_LINKS = 5000;
export function limitLinks(md, { maxLinks = MAX_LINKS, maxChars = MAX_LINK_CHARS } = {}) {
  const toText = (t, content, meta) => {
    t.type = "text";
    t.tag = "";
    t.nesting = 0;
    t.attrs = null;
    t.children = null;
    t.content = content;
    t.meta = meta;
  };
  md.core.ruler.push("limit_links", (state) => {
    let count = 0;
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      const open = [];
      for (const t of block.children) {
        if (t.type === "link_open") {
          const href = t.attrGet("href") || "";
          const why = href.length > maxChars ? "long" : ++count > maxLinks ? "many" : "";
          open.push(Boolean(why));
          if (why) toText(t, "", { dropped: why, what: "link", line: block.map?.[0] ?? 0 });
        } else if (t.type === "link_close") {
          if (open.pop()) toText(t, "", { closed: true });
        } else if (t.type === "image") {
          const src = t.attrGet("src") || "";
          const why = src.length > maxChars ? "long" : ++count > maxLinks ? "many" : "";
          if (why) toText(t, (t.children || []).map((c) => c.content || "").join(""), { dropped: why, what: "image", line: block.map?.[0] ?? 0 });
        }
      }
    }
  });
}

// The links and pictures that were left as plain text because of the limits above.
export function droppedFromTokens(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t.type !== "inline" || !t.children) continue;
    for (const c of t.children) if (c.meta?.dropped) out.push({ ...c.meta });
  }
  return out;
}

// A rough size of the HTML a body will make, from its tokens (no rendering). Used to refuse an article that would be too big
// to show, before building it.
export const MAX_BODY_HTML = 2 * 1024 * 1024;
export const TOO_LONG = "This article is too long to show.";
export function estimateHtmlSize(tokens) {
  let n = 0;
  const attrs = (t) => {
    let a = 0;
    if (t.attrs) for (const [k, v] of t.attrs) a += k.length + String(v).length + 4;
    return a;
  };
  for (const t of tokens) {
    n += 24 + attrs(t);
    if (t.type === "fence" || t.type === "code_block") n += 320 + t.content.length * 2;
    else if (t.type === "blockquote_open" && t.meta?.alert) n += 600;
    else if (t.type === "heading_open") n += 160;
    if (t.children) {
      for (const c of t.children) {
        n += 6 + (c.content?.length || 0) + attrs(c);
        if (c.type === "image") n += 1200;
      }
    }
  }
  return n;
}
// True when the body would render to more than MAX_BODY_HTML. Only a body near the limit is actually rendered to find out.
let measurer;
export function bodyTooLong(tokens) {
  const est = estimateHtmlSize(tokens);
  if (est > MAX_BODY_HTML * 1.5) return true;
  if (est < MAX_BODY_HTML / 2) return false;
  measurer ??= createMarkdown({ siteHost: "" });
  return measurer.renderer.render(tokens, measurer.options, {}).length > MAX_BODY_HTML;
}

export function createMarkdown({ siteHost = "", basePath = "" } = {}) {
  // Raw HTML is off: several people write here, and a <script> in a post must never run on the site or in admin.
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  // Only autolink URLs with a scheme, so things like "Serial.print" or "esp32.io" in prose stay text.
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
  md.use(githubAlerts);
  md.use(headingIds);
  md.use(limitLinks);
  md.use(figures, { siteHost, basePath });
  md.use(codeBlocks);
  md.use(tables);
  md.use(links, siteHost);
  return md;
}

// h2 headings for the Contents box (all headings with `all`, for anchor checks).
export function tocFromTokens(tokens, { all = false } = {}) {
  return tokens
    .filter((t) => t.type === "heading_open" && (all || t.tag === "h2"))
    .map((t) => ({ id: t.attrGet("id"), text: t.meta?.text || "" }));
}

// Every image token in document order, with its 0-based body line.
export function imagesFromTokens(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t.type !== "inline" || !t.children) continue;
    for (const c of t.children) {
      if (c.type === "image") {
        out.push({ src: c.attrGet("src"), alt: c.children?.map((x) => x.content).join("") ?? "", line: t.map?.[0] ?? 0 });
      }
    }
  }
  return out;
}

export function linksFromTokens(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t.type !== "inline" || !t.children) continue;
    for (const c of t.children) {
      if (c.type === "link_open") out.push({ href: c.attrGet("href"), line: t.map?.[0] ?? 0 });
    }
  }
  return out;
}
