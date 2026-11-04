// Publishing checks. Errors block publishing; warnings are advice shown in the editor.
import { bodyTooLong, droppedFromTokens, imagesFromTokens, linksFromTokens, MAX_LINK_CHARS, MAX_LINKS, TOO_LONG, tocFromTokens } from "./markdown.js";
import { isSourceName } from "./code.js";
import { isHttpUrl, isoDurationToSeconds, timestampToSeconds } from "./util.js";

// Editorial markers from the Content Hub Preview and the writing session.
export const MARKERS = [
  { re: /\[\[TODO\b[^\]]*(?:\]\])?/gi, kind: "todo", message: "unresolved [[TODO]] placeholder" },
  { re: /\[CHECK:[^\]]*\]?/gi, kind: "check", message: "editorial [CHECK: …] marker" },
  { re: /\[(?:URL|DATE|link|repo-url|sketch-dir|newsletter link|article URL|repo URL)\]/g, kind: "placeholder", message: "placeholder" },
  { re: /\{(?:P|C|K|S|BOARD_NOTE)\}/g, kind: "board", message: "board token" },
];
export const WEEK_RE = /\bweek[\s-]*\d+/gi;

const FIELD_LABELS = {
  title: "Title", excerpt: "Meta description", seo_title: "SEO title", short_title: "Short title", quick_answer: "Quick answer",
  feature_image_alt: "Feature image alt", feature_image_caption: "Feature image caption",
  og_title: "Social title", og_description: "Social description", body_md: "Body", source_files: "Source code", downloads: "Downloads",
};

// Messages never repeat more than this much of an address, and a check stops after this many problems (a body with tens of
// thousands of broken links would otherwise make a huge answer).
const MAX_ECHO = 200;
const MAX_PROBLEMS = 50;
const short = (v) => {
  const t = String(v ?? "");
  return t.length > MAX_ECHO ? `${t.slice(0, MAX_ECHO)}…` : t;
};

// Real network names, passwords and keys must never be published. A quoted value assigned to something
// named like a credential (or passed to WiFi.begin) is fine only when it is clearly a placeholder.
const SECRET = "(?:ssid|passw(?:or)?d|pass|psk|api[_-]?key|secret|auth[_-]?token|access[_-]?token|device[_-]?key|bot[_-]?token|token)";
// Each pattern is tested only against the short window of text just before a quoted string, and starts with a fixed
// word (no leading \w*), so the work per string is small and cannot grow with the length of the line.
const ASSIGNED = [
  new RegExp(`${SECRET}\\w*["']?\\s*(?:\\[\\s*\\d*\\s*\\]\\s*)?(?:=|:)\\s*$`, "i"),
  new RegExp(`#define\\s+\\w*${SECRET}\\w*\\s+$`, "i"),
  /\b(?:WiFi|wifi|WiFiMulti|wifiMulti)\.(?:begin|softAP|addAP)\s*\(\s*(?:"[^"]*"\s*,\s*)?$/,
];
// Words that make a value a placeholder: whole words only (letters and digits around them count), so "enterprise-psk", "enter1"
// and "yourX" are still treated as real values. "your" counts when a separator or a credential word follows
// ("YOUR_WIFI_PASSWORD", "your wifi", "yourpassword").
const PLACEHOLDER = /(?<![a-z0-9])your(?:[-_ ]|(?:wifi|network|password|pass|ssid|key|token|secret|psk)(?![a-z0-9]))|(?<![a-z0-9])(?:example|xxx+|changeme|change[-_ ]?me|placeholder|replace|enter|insert|my[-_ ]?(?:wifi|network|password|ssid))(?![a-z0-9])|<[^>]*>|\.\.\.|^\*+$|^(?:password|ssid)$/i;
const WINDOW = 160; // characters before a quoted string that can name the credential
const MAX_LINE = 200_000; // a longer line (minified code) is only scanned up to here, and findSecrets().skipped says so
const MAX_QUOTED_PER_LINE = 2000;
const MAX_VALUE = 4000; // a quoted value up to this long is checked (JWTs, PEM keys)
const QUOTED = new RegExp(`"([^"\\n]{0,${MAX_VALUE}})"|'([^'\\n]{0,${MAX_VALUE}})'`, "g");
const MAX_FINDINGS = 200;

// An aid for the editor, not a guarantee. What it sees: a quoted value (up to MAX_VALUE characters) assigned to a credential-like
// name on the same line, or on the line after one that ends in = : ( or a comma. What it does not see: secrets written another way
// (built from pieces, read from a macro, base64 in a comment), anything past MAX_LINE characters on one line, and anything past
// MAX_QUOTED_PER_LINE quoted strings on one line. Lines that long are listed in the result's `skipped`, so the editor can say they
// were only partly checked. Nothing here makes it safe to publish credentials in source files.
export function findSecrets(text) {
  const found = [];
  found.skipped = [];
  const lines = String(text ?? "").split("\n");
  let tail = ""; // the end of the last non-blank line, for a value that sits on the next one
  for (let i = 0; i < lines.length && found.length < MAX_FINDINGS; i++) {
    if (lines[i].length > MAX_LINE) found.skipped.push(i + 1);
    const line = lines[i].length > MAX_LINE ? lines[i].slice(0, MAX_LINE) : lines[i];
    const lead = tail;
    if (line.trim()) tail = line.slice(-WINDOW);
    if (!/["']/.test(line) || !/(?:^|[=:(,\s])["']/.test(line)) continue;
    let seen = 0;
    for (const m of line.matchAll(QUOTED)) {
      if (++seen > MAX_QUOTED_PER_LINE) {
        found.skipped.push(i + 1);
        break;
      }
      let before = line.slice(Math.max(0, m.index - WINDOW), m.index);
      // A value that opens a line: the assignment is at the end of the line above.
      if (!before.trim()) before = lead + before;
      // Cheap test first: the text before the string must end in = or : or an opening bracket or comma.
      if (!/[=:(,]\s*$|#define\s+\S+\s+$/.test(before)) continue;
      if (!ASSIGNED.some((re) => re.test(before))) continue;
      const value = (m[1] ?? m[2] ?? "").trim();
      if (value.length >= 3 && !PLACEHOLDER.test(value)) found.push({ line: i + 1, value });
    }
  }
  return found;
}

function scanText(text, field, add, full) {
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length && !full(); i++) {
    const line = lines[i];
    for (const { re, message } of MARKERS) for (const m of line.matchAll(re)) add(field, `${message} "${short(m[0])}" must be resolved`, field === "body_md" ? i + 1 : 0);
    for (const m of line.matchAll(WEEK_RE)) add(field, `week number "${short(m[0])}" must not appear on the site`, field === "body_md" ? i + 1 : 0);
  }
}

// A bad % escape in a link must not throw: it is reported as a problem with the link instead.
const safeDecode = (s, fn) => {
  try {
    return fn(s);
  } catch {
    return null;
  }
};
const sameHost = (src, siteHost) => {
  try {
    return new URL(src).hostname.replace(/^www\./, "") === String(siteHost || "").replace(/^www\./, "");
  } catch {
    return false;
  }
};

// `post` is a hydrated post; `ctx` = { tokens, basePath, siteHost, resolvePath(path) -> bool, mediaExists(path) -> bool }
export function publishChecks(post, ctx) {
  const errors = [];
  const warnings = [];
  // At most MAX_PROBLEMS of each; the last slot says there are more.
  const push = (list, field, message, line) => {
    if (list.length >= MAX_PROBLEMS) return;
    if (list.length === MAX_PROBLEMS - 1) {
      field = "body_md";
      message = "more problems were found; only the first ones are shown. Fix these and check again";
      line = 0;
    }
    list.push({ field, label: FIELD_LABELS[field] || field, message, line });
  };
  const err = (field, message, line = 0) => push(errors, field, message, line);
  const warn = (field, message, line = 0) => push(warnings, field, message, line);
  const full = () => errors.length >= MAX_PROBLEMS;
  const isPost = post.type === "post";

  if (!post.title?.trim()) err("title", "a title is required");
  if (!post.excerpt?.trim()) err("excerpt", "a meta description is required (it is the search snippet and card summary)");
  if (post.excerpt?.length > 155) err("excerpt", `${post.excerpt.length} characters; keep it to 155`);
  if (post.excerpt && post.excerpt.length < 70) warn("excerpt", "under 70 characters; search engines may write their own snippet");
  if (post.seo_title?.length > 60) err("seo_title", `${post.seo_title.length} characters; keep it to 60`);
  if (!post.seo_title && post.title?.length > 60) warn("seo_title", `the title is ${post.title.length} characters; add an SEO title of 60 or fewer`);

  // Markers and week numbers anywhere a reader could see them.
  for (const f of ["title", "excerpt", "seo_title", "short_title", "quick_answer", "feature_image_alt", "feature_image_caption", "og_title", "og_description", "body_md"]) scanText(post[f], f, err, full);
  for (const [label, value] of post.at_a_glance || []) scanText(`${label} ${value}`, "at_a_glance", err, full);
  for (const t of post.tested_with || []) scanText(t, "tested_with", err, full);
  scanText(`${post.video?.title || ""}\n${post.video?.description || ""}`, "video", err, full);
  scanText(post.downloads?.github || "", "downloads", err, full);
  for (const f of post.downloads?.files || []) scanText(f.label, "downloads", err, full);

  // Source code files: names, markers and credentials.
  const names = new Set();
  (post.source_files || []).forEach((f, i) => {
    const name = f.name || `file ${i + 1}`;
    if (!isSourceName(f.name || "")) err("source_files", `"${name}" is not a valid file name (letters, digits, dot, dash or underscore)`);
    else if (names.has(f.name.toLowerCase())) err("source_files", `two files are named "${f.name}"`);
    names.add(String(f.name || "").toLowerCase());
    if (!String(f.code || "").trim()) err("source_files", `"${name}" is empty`);
    const codeLines = String(f.code || "").split("\n");
    for (let n = 0; n < codeLines.length && !full(); n++) {
      for (const { re, message } of MARKERS) for (const m of codeLines[n].matchAll(re)) err("source_files", `${message} "${short(m[0])}" in ${name}, line ${n + 1}`);
    }
    // The message names the file and line only: the value itself (even its first letters) is not repeated back.
    const secrets = findSecrets(f.code);
    for (const s of secrets) err("source_files", `${name}, line ${s.line} looks like a real password, network name or key. Use a placeholder such as "YOUR_WIFI_PASSWORD"`);
    for (const n of secrets.skipped.slice(0, 3)) warn("source_files", `${name}, line ${n} is very long, so it was only partly checked for passwords and keys`);
  });
  const bodySecrets = findSecrets(post.body_md);
  for (const s of bodySecrets) err("body_md", "this line looks like a real password, network name or key. Use a placeholder such as \"YOUR_WIFI_PASSWORD\"", s.line);
  for (const n of bodySecrets.skipped.slice(0, 3)) warn("body_md", "this line is very long, so it was only partly checked for passwords and keys", n);

  if (post.feature_image_id && !post.feature_image_alt?.trim()) err("feature_image_alt", "the feature image needs alt text");
  if (/^#[0-9a-f]{6}$/i.test(post.accent || "") === false && post.accent) err("accent", "accent must be a #RRGGBB colour");
  if (post.canonical_url && !isHttpUrl(post.canonical_url)) err("canonical_url", "canonical URL must be a full http(s) URL");

  // Body images and links.
  const tokens = ctx.tokens;
  const media = `${ctx.basePath}/media/`;
  // Links and pictures the page leaves as plain text (an address over the length limit, or too many in one body).
  for (const d of droppedFromTokens(tokens).slice(0, 5)) {
    err("body_md", d.dropped === "long" ? `a ${d.what} address is longer than ${MAX_LINK_CHARS} characters, so it will show as plain text` : `more than ${MAX_LINKS} links and pictures in one article; the rest will show as plain text`, d.line + 1);
  }
  // A body that would make a page over the size limit cannot be published.
  if (!full() && bodyTooLong(tokens)) err("body_md", `${TOO_LONG} Shorten it or split it into two posts.`);
  for (const img of imagesFromTokens(tokens)) {
    if (full()) break;
    const line = img.line + 1;
    if (!img.alt.trim()) err("body_md", `image "${short(img.src)}" has no alt text`, line);
    if (img.src?.startsWith(media) && !ctx.mediaExists(img.src.slice(media.length))) err("body_md", `image not found in the media library: ${short(img.src)}`, line);
    // Pages only load pictures from this site (the security policy blocks other hosts), so an outside picture would not show.
    else if (/^https?:\/\//i.test(img.src || "") && !sameHost(img.src, ctx.siteHost)) warn("body_md", `image "${short(img.src)}" is on another site and won't show; upload it to the media library instead`, line);
  }
  const ids = new Set(tocFromTokens(tokens, { all: true }).map((h) => h.id));
  // Each distinct address is parsed once, however many times it is used.
  const parsed = new Map();
  const parseLink = (href) => {
    if (parsed.has(href)) return parsed.get(href);
    let url = null;
    try {
      url = new URL(href, `https://${ctx.siteHost}${ctx.basePath}/${post.slug}/`);
    } catch {
      url = null;
    }
    const entry = { url, path: url ? safeDecode(url.pathname, decodeURI) : null, internal: null };
    parsed.set(href, entry);
    return entry;
  };
  for (const link of linksFromTokens(tokens)) {
    if (full()) break;
    const href = link.href || "";
    const line = link.line + 1;
    if (href.startsWith("#")) {
      if (href.length > 1 && !ids.has(safeDecode(href.slice(1), decodeURIComponent))) err("body_md", `link to "${short(href)}", but no heading has that id`, line);
      continue;
    }
    const entry = parseLink(href);
    const url = entry.url;
    if (!url) {
      err("body_md", `"${short(href)}" is not a valid link`, line);
      continue;
    }
    if (!/^https?:$/.test(url.protocol) && !/^(mailto|tel):$/.test(url.protocol)) err("body_md", `"${short(href)}" uses an unsafe link type`, line);
    if (url.hostname.replace(/^www\./, "") !== ctx.siteHost.replace(/^www\./, "")) continue;
    const p = entry.path;
    if (p === null) {
      err("body_md", `"${short(href)}" is not a valid link (bad % escape)`, line);
      continue;
    }
    if (p === ctx.basePath || p.startsWith(`${ctx.basePath}/`)) {
      entry.internal ??= Boolean(ctx.resolvePath(p));
      if (!entry.internal) err("body_md", `broken internal link "${short(href)}"`, line);
    }
  }

  // Video: once an id is set, the structured data needs the rest.
  const v = post.video || {};
  if (v.youtube_id) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(v.youtube_id)) err("video", `"${v.youtube_id}" is not an 11-character YouTube id`);
    if (!v.title) err("video", "video title is required when a YouTube id is set");
    if (!v.description) err("video", "video description is required when a YouTube id is set");
    if (!v.upload_date) err("video", "video upload date is required when a YouTube id is set");
    if (!v.duration) err("video", "video duration is required when a YouTube id is set");
    else if (isoDurationToSeconds(v.duration) == null) err("video", `duration "${v.duration}" is not valid (e.g. PT8M4S)`);
    let prev = -1;
    for (const c of v.chapters || []) {
      const s = timestampToSeconds(c.at);
      if (s == null || !c.name) err("video", `chapter "${c.at} ${c.name || ""}" needs a time (m:ss) and a name`);
      else if (s <= prev) err("video", `chapter "${c.at}" must come after the previous chapter`);
      else prev = s;
    }
    const dur = isoDurationToSeconds(v.duration);
    if (dur != null && prev >= dur) err("video", "the last chapter starts after the video ends");
  }

  const gh = post.downloads?.github;
  if (gh && !/\[\[TODO/i.test(gh) && !isHttpUrl(gh)) err("downloads", "the GitHub link must be a full https:// URL");
  for (const f of post.downloads?.files || []) {
    if (!ctx.mediaFileExists?.(f.media_id)) err("downloads", `the file "${f.label || f.media_id}" is no longer in the media library`);
    if (!String(f.label || "").trim()) err("downloads", "every download needs a label, such as \"Circuit diagram\"");
  }

  // Advice for search and answer engines.
  if (isPost) {
    if (!post.category_id) warn("category_id", "no category: the post won't appear in any category page");
    if (!post.feature_image_id) warn("feature_image_id", "no feature image: cards and social shares will use the default image");
    if (!post.quick_answer?.trim()) warn("quick_answer", "no quick answer: answer engines quote this box first");
    if (!post.tags?.length) warn("tags", "no tags");
  }
  if (post.word_count < 300 && isPost) warn("body_md", `only ${post.word_count} words; thin pages rarely rank`);
  String(post.body_md || "").split("\n").forEach((line, i) => /^#\s/.test(line) && warn("body_md", "a # H1 in the body; the title is already the H1, start sections at ##", i + 1));

  return { errors, warnings };
}

// Wraps markers in <mark> so admin previews show them.
export function highlightMarkers(html) {
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith("<")) return part;
      let out = part;
      for (const { re, kind } of MARKERS) out = out.replace(re, (m) => `<mark class="marker marker-${kind}">${m}</mark>`);
      return out;
    })
    .join("");
}
