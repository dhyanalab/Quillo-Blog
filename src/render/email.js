// Emails: the newsletter (a short message, the chosen posts as cards, a footer with the business address and an
// unsubscribe link) and short one-button messages (confirm, verify, reset). Inline styles and tables, so every inbox
// shows them the same way.
import MarkdownIt from "markdown-it";
import { limitLinks } from "./markdown.js";
import { escapeHtml as e, isHttpUrl } from "./util.js";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
// The same limits as on the site: an address over 2,048 characters is not linked, and at most 500 links and pictures in one message.
md.use(limitLinks, { maxLinks: 500 });
// Longest message body the newsletter form accepts; nothing here reads more than this.
const MAX_BODY = 20_000;
const C = { ink: "#1A1D21", ink2: "#535A63", line: "#DEE1E5", bg: "#F4F5F7", ac: "#C2410C" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const stripHost = (h) => String(h || "").toLowerCase().replace(/^www\./, "");

// Pictures in a newsletter load from this site only. A picture from anywhere else would make every subscriber's mail
// program contact that host, so it is left out and only its description is kept.
md.renderer.rules.image = (tokens, idx, opts, env) => {
  const tok = tokens[idx];
  const alt = (tok.children || []).map((c) => c.content).join("");
  const site = env?.site;
  const src = tok.attrGet("src") || "";
  if (!site) return e(alt);
  let url = "";
  if (src.startsWith("/") && !src.startsWith("//") && !src.includes("\\")) url = site.abs(src);
  // The same site means the same scheme, host and port, not just the same host name.
  else if (isHttpUrl(src) && new URL(src).origin === new URL(site.abs("/")).origin) url = src;
  return url ? `<img src="${e(url)}" alt="${e(alt)}" style="max-width:100%;height:auto;border:0">` : e(alt);
};

// Inline styles for the few tags Markdown produces.
function bodyHtml(markdown, site) {
  return md
    .render(String(markdown || ""), { site })
    .replace(/<p>/g, `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${C.ink}">`)
    .replace(/<a href=/g, `<a style="color:${C.ac};text-decoration:underline" href=`)
    .replace(/<h([1-3])>/g, `<h$1 style="margin:24px 0 10px;font-size:20px;line-height:1.3;color:${C.ink}">`)
    .replace(/<(ul|ol)>/g, `<$1 style="margin:0 0 16px;padding-left:22px;font-size:16px;line-height:1.6;color:${C.ink}">`)
    .replace(/<blockquote>/g, `<blockquote style="margin:0 0 16px;padding:4px 0 4px 14px;border-left:3px solid ${C.ac};color:${C.ink2}">`)
    .replace(/<code>/g, `<code style="font-family:Consolas,monospace;background:${C.bg};padding:1px 4px;border-radius:4px">`);
}

// Formatting marks removed from a piece of text (no addresses in it: those are protected by plain()). Each pattern can take time
// quadratic in the length of a line, so a line longer than this is left as written.
const MAX_FORMAT_LINE = 1000;
const unformatLine = (s) =>
  s
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, "$1$2")
    .replace(/`+/g, "")
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?)/gm, "");
const unformat = (s) => s.split("\n").map((line) => (line.length > MAX_FORMAT_LINE ? line : unformatLine(line))).join("\n");

// Plain-text version of the Markdown. Web addresses are set aside first, so formatting marks are stripped from the
// words only: "http://x/a_b" stays exactly as written and a link's text can't point somewhere else.
function plain(markdown) {
  const kept = [];
  const hold = (s) => `\uE000${kept.push(s) - 1}\uE001`;
  let s = String(markdown || "").slice(0, MAX_BODY).replace(/[\uE000\uE001]/g, "");
  s = s.replace(/!\[([^\]]{0,300})\]\(([^)\s]{0,2048})(?:\s+"[^"]{0,300}")?\)/g, (m, alt) => alt);
  s = s.replace(/\[([^\]]{1,300})\]\(([^)\s]{1,2048})(?:\s+"[^"]{0,300}")?\)/g, (m, text, url) => {
    const label = unformat(text).trim();
    return hold(!label || label === url ? url : `${label} (${url})`);
  });
  s = s.replace(/https?:\/\/[^\s<>()[\]]{1,2048}/g, (u) => hold(u));
  return unformat(s)
    .replace(/\uE000(\d+)\uE001/g, (m, i) => kept[Number(i)])
    .trim();
}

// One line only: a line break in a subject would add mail headers.
const oneLine = (s) => String(s ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").trim();

// posts: [{ title, url, excerpt, image }] with absolute URLs. The slow parts (Markdown, the cards) are done once; the result is
// a function that makes each subscriber's copy from their own unsubscribe link: unsubscribeUrl -> { subject, html, text }.
export function prepareNewsletter({ site, newsletter, posts }) {
  const b = site.business || {};
  const who = b.name ? `${b.name}${b.brand ? ` (${b.brand})` : ""}` : site.title;
  const address = (b.addressLines || []).join(", ");
  const home = site.abs(site.url.home);
  const subject = oneLine(newsletter.subject);

  const cards = posts
    .map(
      (p) => `<tr><td style="padding:0 0 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:10px;overflow:hidden">
${p.image ? `<tr><td><a href="${e(p.url)}"><img src="${e(p.image)}" width="560" alt="" style="display:block;width:100%;max-width:560px;height:auto;border:0"></a></td></tr>` : ""}
<tr><td style="padding:16px 18px">
<a href="${e(p.url)}" style="font-size:18px;font-weight:700;line-height:1.35;color:${C.ink};text-decoration:none">${e(p.title)}</a>
${p.excerpt ? `<p style="margin:8px 0 12px;font-size:15px;line-height:1.55;color:${C.ink2}">${e(p.excerpt)}</p>` : ""}
<a href="${e(p.url)}" style="display:inline-block;font-size:15px;font-weight:600;color:${C.ac};text-decoration:none">Read more</a>
</td></tr></table></td></tr>`,
    )
    .join("\n");
  const body = bodyHtml(newsletter.body_md, site);
  const bodyText = plain(newsletter.body_md);

  return (unsubscribeUrl) => {
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${e(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT}">
${newsletter.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(newsletter.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:12px">
<tr><td style="padding:22px 20px 6px;border-bottom:3px solid ${C.ac}"><a href="${e(home)}" style="font-size:20px;font-weight:800;color:${C.ink};text-decoration:none">${e(site.title)}</a></td></tr>
<tr><td style="padding:24px 20px 4px">
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:${C.ink}">${e(subject)}</h1>
${body}
</td></tr>
${cards ? `<tr><td style="padding:4px 20px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}</table></td></tr>` : ""}
<tr><td style="padding:18px 20px 22px;border-top:1px solid ${C.line};font-size:13px;line-height:1.6;color:${C.ink2}">
You’re getting this because you subscribed at <a href="${e(home)}" style="color:${C.ink2}">${e(site.host)}</a>.
<a href="${e(unsubscribeUrl)}" style="color:${C.ac}">Unsubscribe</a> at any time, in one click.<br>
${e(who)}${address ? `<br>${e(address)}` : ""}
</td></tr>
</table></td></tr></table>
</body></html>`;

    const text = [
      subject,
      "",
      bodyText,
      "",
      ...posts.flatMap((p) => [p.title, p.excerpt, p.url, ""]),
      "--",
      `You're getting this because you subscribed at ${site.host}.`,
      `Unsubscribe: ${unsubscribeUrl}`,
      who,
      address,
    ]
      .filter((l) => l !== undefined)
      .join("\n");

    return { subject, html, text };
  };
}

// The same, for one subscriber at once.
export function renderNewsletter({ site, newsletter, posts, unsubscribeUrl }) {
  return prepareNewsletter({ site, newsletter, posts })(unsubscribeUrl);
}

// A short message with one button: confirm a subscription, verify an account, reset a password.
// `body` is plain text (paragraphs separated by a blank line, or an array of paragraphs); nothing in it is treated as HTML.
export function renderSimpleEmail({ site, heading, body, buttonText, url }) {
  const subject = oneLine(heading);
  const paragraphs = (Array.isArray(body) ? body : String(body ?? "").split(/\n\s*\n/)).map((p) => String(p).trim()).filter(Boolean);
  const link = isHttpUrl(url) ? url : "";
  const home = site.abs(site.url.home);
  const who = site.business?.name || site.title;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${e(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:12px">
<tr><td style="padding:22px 20px 6px;border-bottom:3px solid ${C.ac}"><a href="${e(home)}" style="font-size:20px;font-weight:800;color:${C.ink};text-decoration:none">${e(site.title)}</a></td></tr>
<tr><td style="padding:24px 20px 20px">
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:${C.ink}">${e(subject)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${C.ink}">${e(p).replace(/\n/g, "<br>")}</p>`).join("\n")}
${link ? `<p style="margin:24px 0"><a href="${e(link)}" style="display:inline-block;background:${C.ac};color:#FFFFFF;font-size:16px;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:8px">${e(buttonText || "Open the link")}</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:${C.ink2}">Button not working? Copy this address into your browser:<br><a href="${e(link)}" style="color:${C.ac};word-break:break-all">${e(link)}</a></p>` : ""}
</td></tr>
<tr><td style="padding:16px 20px 20px;border-top:1px solid ${C.line};font-size:13px;line-height:1.6;color:${C.ink2}">
If you didn’t ask for this, you can ignore this email.<br>${e(who)}
</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [subject, "", ...paragraphs.flatMap((p) => [p, ""]), ...(link ? [`${buttonText || "Open the link"}: ${link}`, ""] : []), "If you didn't ask for this, you can ignore this email.", who].join("\n");
  return { subject, html, text };
}
