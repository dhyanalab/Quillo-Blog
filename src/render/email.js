// Emails: the newsletter (a branded header, a short message, the first post large and the rest in a two-column grid,
// a footer with social links, the business address and an unsubscribe link) and short one-button messages (confirm, verify, reset). Inline styles and tables, so every inbox
// shows them the same way.
import MarkdownIt from "markdown-it";
import { limitLinks } from "./markdown.js";
import { escapeHtml as e, isHttpUrl } from "./util.js";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
// The same limits as on the site: an address over 2,048 characters is not linked, and at most 500 links and pictures in one message.
md.use(limitLinks, { maxLinks: 500 });
// Longest message body the newsletter form accepts; nothing here reads more than this.
const MAX_BODY = 20_000;
// The site's colours, plus the dark slate, sage and orange of the logo for the header, the stripe under it and the footer.
const C = {
  ink: "#1A1D21", ink2: "#535A63", ink3: "#6B7280", line: "#DEE1E5", bg: "#EEF0F3", ac: "#C2410C", acSoft: "#FCEBDF",
  dark: "#1F262E", darkInk: "#AEB6BF", darkInk2: "#8A939D", sage: "#8BA385", sun: "#F7953A",
};
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
  return url ? `<img src="${e(url)}" alt="${e(alt)}" style="max-width:100%;height:auto;border:0;border-radius:10px">` : e(alt);
};

// Inline styles for the few tags Markdown produces.
function bodyHtml(markdown, site) {
  return md
    .render(String(markdown || ""), { site })
    .replace(/<p>/g, `<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${C.ink2}">`)
    .replace(/<a href=/g, `<a style="color:${C.ac};font-weight:600;text-decoration:underline" href=`)
    .replace(/<strong>/g, `<strong style="color:${C.ink}">`)
    .replace(/<h([1-3])>/g, `<h$1 style="margin:26px 0 10px;font-size:20px;line-height:1.3;font-weight:800;color:${C.ink}">`)
    .replace(/<(ul|ol)>/g, `<$1 style="margin:0 0 18px;padding-left:22px;font-size:16px;line-height:1.65;color:${C.ink2}">`)
    .replace(/<li>/g, `<li style="margin:0 0 6px">`)
    .replace(/<blockquote>/g, `<blockquote style="margin:0 0 18px;padding:12px 16px;border-left:4px solid ${C.ac};background:${C.acSoft};border-radius:0 8px 8px 0;color:${C.ink}">`)
    .replace(/<code>/g, `<code style="font-family:Consolas,monospace;background:${C.bg};padding:1px 5px;border-radius:4px;font-size:14px">`);
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

// ---- Shared pieces of the layout -------------------------------------------------------------------------------------------
// Tables and inline styles throughout, because many mail programs ignore <style>. The one <style> block only makes the
// two-column post grid full width on phones; where it is ignored, the columns still stack, just at their normal width.

// The site logo, when it is a picture every mail program can show (not SVG or WebP).
function logoUrl(site) {
  const l = site.logo;
  if (!l?.path || !/^image\/(jpeg|png|gif)$/.test(l.mime || "")) return "";
  try {
    return site.abs(site.url.media(l.path));
  } catch {
    return "";
  }
}

// A solid button that works without images or CSS support.
const button = (label, url, { center = false } = {}) => `<table role="presentation" cellpadding="0" cellspacing="0"${center ? ' align="center"' : ""} style="border-collapse:separate${center ? ";margin:0 auto" : ""}"><tr>
<td style="background:${C.ac};border-radius:8px"><a href="${e(url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:8px">${e(label)}</a></td>
</tr></table>`;

const eyebrow = (text, color = C.ac) =>
  `<div style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${color}">${e(text)}</div>`;

// Dark band with the logo, site name and description, then a thin stripe in the logo's three colours.
function header(site, home) {
  const logo = logoUrl(site);
  const desc = String(site.description || "").trim();
  return `<tr><td class="px" style="background:${C.dark};border-radius:14px 14px 0 0;padding:22px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
${logo ? `<td width="56" style="width:56px;padding:0 16px 0 0;vertical-align:middle"><a href="${e(home)}"><img src="${e(logo)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border:0;border-radius:12px;background:#FFFFFF"></a></td>` : ""}
<td style="vertical-align:middle">
<a href="${e(home)}" style="font-size:21px;font-weight:800;line-height:1.25;color:#FFFFFF;text-decoration:none">${e(site.title)}</a>
${desc ? `<div style="margin-top:4px;font-size:13px;line-height:1.45;color:${C.darkInk}">${e(desc)}</div>` : ""}
</td></tr></table>
</td></tr>
<tr><td style="font-size:0;line-height:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td height="4" width="34%" style="height:4px;background:${C.sun};font-size:0;line-height:0">&nbsp;</td>
<td height="4" width="33%" style="height:4px;background:${C.sage};font-size:0;line-height:0">&nbsp;</td>
<td height="4" width="33%" style="height:4px;background:${C.ac};font-size:0;line-height:0">&nbsp;</td>
</tr></table></td></tr>`;
}

// The page around the content: grey background, a 600 px white sheet, the header, then `rows` and `footer`.
function page({ site, home, subject, preheader = "", rows, footer }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${e(subject)}</title>
<style>
@media only screen and (max-width:620px){
  .col{max-width:100% !important}
  .px{padding-left:18px !important;padding-right:18px !important}
  .grid{padding-left:10px !important;padding-right:10px !important}
  .h1{font-size:24px !important}
}
</style></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};-webkit-text-size-adjust:100%">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:28px 10px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:14px">
${header(site, home)}
${rows}
${footer}
</table></td></tr></table>
</body></html>`;
}

// Dark footer: social links (as text: icons would need pictures), why the reader gets this, unsubscribe, who sends it.
function footer({ site, home, lines }) {
  const social = (site.social || []).filter((s) => s && isHttpUrl(s.url)).slice(0, 6);
  return `<tr><td class="px" style="background:${C.dark};border-radius:0 0 14px 14px;padding:24px 28px 26px;text-align:center">
${social.length ? `<p style="margin:0 0 14px;font-size:13px;line-height:1.8">${social.map((s) => `<a href="${e(s.url)}" style="color:#FFFFFF;font-weight:600;text-decoration:none">${e(s.label)}</a>`).join(`<span style="color:${C.darkInk2}">&nbsp;&nbsp;·&nbsp;&nbsp;</span>`)}</p>` : ""}
${lines.map((l, i) => `<p style="margin:${i ? "6px" : "0"} 0 0;font-size:12px;line-height:1.6;color:${i ? C.darkInk2 : C.darkInk}">${l}</p>`).join("\n")}
<p style="margin:14px 0 0;font-size:12px;line-height:1.6"><a href="${e(home)}" style="color:${C.darkInk};text-decoration:underline">${e(site.host)}</a></p>
</td></tr>`;
}

// The newsletter's date, in the site's time zone.
function issueDate(site) {
  try {
    return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: site.tz || "Asia/Kolkata" }).format(new Date());
  } catch {
    return "";
  }
}

// The first post, large.
function featuredCard(p) {
  return `<tr><td class="px" style="padding:6px 28px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:14px;overflow:hidden;background:#FFFFFF">
${p.image ? `<tr><td style="font-size:0;line-height:0"><a href="${e(p.url)}"><img src="${e(p.image)}" width="542" alt="" style="display:block;width:100%;max-width:542px;height:auto;border:0"></a></td></tr>` : ""}
<tr><td style="padding:20px 22px 22px">
${eyebrow("Featured")}
<a href="${e(p.url)}" style="font-size:22px;font-weight:800;line-height:1.3;color:${C.ink};text-decoration:none">${e(p.title)}</a>
${p.excerpt ? `<p style="margin:10px 0 18px;font-size:15px;line-height:1.6;color:${C.ink2}">${e(p.excerpt)}</p>` : `<div style="height:16px;line-height:16px">&nbsp;</div>`}
${button("Read the post", p.url)}
</td></tr></table>
</td></tr>`;
}

// One post in the two-column grid.
const gridCard = (p) => `<div class="col" style="display:inline-block;width:100%;max-width:280px;vertical-align:top;text-align:left">
<div style="padding:8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:12px;overflow:hidden;background:#FFFFFF">
${p.image ? `<tr><td style="font-size:0;line-height:0"><a href="${e(p.url)}"><img src="${e(p.image)}" width="262" alt="" style="display:block;width:100%;height:auto;border:0"></a></td></tr>` : ""}
<tr><td style="padding:14px 16px 16px">
<a href="${e(p.url)}" style="font-size:16px;font-weight:800;line-height:1.35;color:${C.ink};text-decoration:none">${e(p.title)}</a>
${p.excerpt ? `<p style="margin:6px 0 10px;font-size:14px;line-height:1.55;color:${C.ink2}">${e(p.excerpt)}</p>` : `<div style="height:8px;line-height:8px">&nbsp;</div>`}
<a href="${e(p.url)}" style="font-size:14px;font-weight:700;color:${C.ac};text-decoration:none">Read more &rarr;</a>
</td></tr></table>
</div></div>`;

// The other posts, two to a row on wide screens (Outlook gets real table cells), one per row on phones.
function grid(posts) {
  if (!posts.length) return "";
  const rows = [];
  for (let i = 0; i < posts.length; i += 2) {
    const pair = posts.slice(i, i + 2);
    rows.push(`<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" align="center"><tr><td width="280" valign="top"><![endif]-->
${pair.map((p) => gridCard(p)).join(`\n<!--[if mso]></td><td width="280" valign="top"><![endif]-->\n`)}
<!--[if mso]></td></tr></table><![endif]-->`);
  }
  return `<tr><td class="px" style="padding:22px 28px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="border-top:1px solid ${C.line};padding-top:22px">${eyebrow("More to read", C.ink3)}</td>
</tr></table></td></tr>
<tr><td class="grid" style="padding:0 20px 4px;font-size:0;line-height:0;text-align:center">
${rows.join("\n")}
</td></tr>`;
}

// posts: [{ title, url, excerpt, image }] with absolute URLs. The slow parts (Markdown, the cards) are done once; the result is
// a function that makes each subscriber's copy from their own unsubscribe link: unsubscribeUrl -> { subject, html, text }.
export function prepareNewsletter({ site, newsletter, posts }) {
  const b = site.business || {};
  const who = b.name ? `${b.name}${b.brand ? ` (${b.brand})` : ""}` : site.title;
  const address = (b.addressLines || []).join(", ");
  const home = site.abs(site.url.home);
  const subject = oneLine(newsletter.subject);
  const date = issueDate(site);

  const [first, ...rest] = posts;
  const cards = (first ? featuredCard(first) : "") + grid(rest);
  const body = bodyHtml(newsletter.body_md, site);
  const bodyText = plain(newsletter.body_md);

  const intro = `<tr><td class="px" style="padding:30px 28px 6px">
${eyebrow(date ? `Newsletter · ${date}` : "Newsletter")}
<h1 class="h1" style="margin:0 0 18px;font-size:28px;line-height:1.25;font-weight:800;color:${C.ink}">${e(subject)}</h1>
${body}
</td></tr>`;
  const visit = `<tr><td class="px" style="padding:18px 28px 30px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.acSoft};border-radius:14px"><tr><td style="padding:24px 22px;text-align:center">
<div style="margin:0 0 6px;font-size:18px;font-weight:800;line-height:1.3;color:${C.ink}">There’s more on the blog</div>
<div style="margin:0 0 16px;font-size:14px;line-height:1.55;color:${C.ink2}">Every post, project and tutorial, in one place.</div>
${button(`Visit ${site.title}`, home, { center: true })}
</td></tr></table>
</td></tr>`;

  return (unsubscribeUrl) => {
    const html = page({
      site,
      home,
      subject,
      preheader: newsletter.preheader,
      rows: intro + cards + visit,
      footer: footer({
        site,
        home,
        lines: [
          `You’re getting this because you subscribed at ${e(site.host)}. <a href="${e(unsubscribeUrl)}" style="color:#FFFFFF;text-decoration:underline">Unsubscribe</a> at any time, in one click.`,
          `${e(who)}${address ? `<br>${e(address)}` : ""}`,
        ],
      }),
    });

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

  const rows = `<tr><td class="px" style="padding:30px 28px 26px">
<h1 class="h1" style="margin:0 0 18px;font-size:26px;line-height:1.25;font-weight:800;color:${C.ink}">${e(subject)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${C.ink2}">${e(p).replace(/\n/g, "<br>")}</p>`).join("\n")}
${link ? `<div style="margin:26px 0 22px">${button(buttonText || "Open the link", link)}</div>
<p style="margin:0;font-size:13px;line-height:1.5;color:${C.ink3}">Button not working? Copy this address into your browser:<br><a href="${e(link)}" style="color:${C.ac};word-break:break-all">${e(link)}</a></p>` : ""}
</td></tr>`;

  const html = page({
    site,
    home,
    subject,
    rows,
    footer: footer({ site: { ...site, social: [] }, home, lines: ["If you didn’t ask for this, you can ignore this email.", e(who)] }),
  });

  const text = [subject, "", ...paragraphs.flatMap((p) => [p, ""]), ...(link ? [`${buttonText || "Open the link"}: ${link}`, ""] : []), "If you didn't ask for this, you can ignore this email.", who].join("\n");
  return { subject, html, text };
}
