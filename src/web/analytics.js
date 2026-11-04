// Cookieless visitor analytics (Plausible or Umami): reads the tracking code the owner pastes,
// and builds the script tag plus the addresses the security policy must allow.
import { isHttpUrl } from "../render/util.js";

export const ANALYTICS = {
  plausible: { name: "Plausible", script: "https://plausible.io/js/script.js", signup: "https://plausible.io/register", dashboard: "https://plausible.io/sites" },
  umami: { name: "Umami", script: "https://cloud.umami.is/script.js", signup: "https://cloud.umami.is/signup", dashboard: "https://cloud.umami.is/" },
};

// Plausible's newer per-site scripts (pa-….js) need this queue set up first; its hash is allowed by the security policy.
export const PLAUSIBLE_INIT = "window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()";

// The name must start the attribute: `src` never matches inside `data-src`.
const attr = (tag, name) => (tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']+)["']`, "i")) || [])[1] || "";

// Reads the code copied from Plausible or Umami. Returns null when no tracker is found.
export function parseSnippet(text) {
  const tags = String(text || "").match(/<script\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const src = attr(tag, "src");
    if (!isHttpUrl(src) || !/^https:/i.test(src)) continue;
    const websiteId = attr(tag, "data-website-id");
    if (websiteId || /umami/i.test(src)) return { provider: "umami", script: src, id: websiteId, host: attr(tag, "data-host-url") };
    if (/plausible|\/pa-[\w-]+\.js/i.test(src) || attr(tag, "data-domain")) return { provider: "plausible", script: src, id: attr(tag, "data-domain"), host: "" };
  }
  return null;
}

// The https origin of an address, or "" when it is not a plain https host. Because origins go straight
// into the security policy, anything with ; , quotes, * or spaces is refused outright.
export const originOf = (u) => {
  const raw = String(u || "");
  if (/[;,'"*\s\\]/.test(raw)) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return /^[a-z0-9.-]+(:\d+)?$/i.test(url.host) ? url.origin : "";
  } catch {
    return "";
  }
};

// The tag for public pages, and the origins it loads from and sends to.
export function analyticsSetup(s) {
  // Own properties only: a stored provider such as "constructor" or "__proto__" is not a provider.
  const p = Object.hasOwn(ANALYTICS, s.analytics_provider) ? ANALYTICS[s.analytics_provider] : undefined;
  const script = s.analytics_script || p?.script || "";
  // The script and every address must be a plain https host: these values go into the security policy.
  const origin = originOf(script);
  if (!p || !origin || !isHttpUrl(script)) return null;
  const esc = (v) => String(v).replace(/[&"<>']/g, (ch) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;", "'": "&#39;" })[ch]);
  if (s.analytics_provider === "plausible") {
    const perSite = /\/pa-[\w-]+\.js(\?|$)/.test(script);
    if (!perSite && !s.analytics_id) return null;
    return {
      name: p.name,
      html: perSite
        ? `<script async src="${esc(script)}"></script>\n<script>${PLAUSIBLE_INIT}</script>`
        : `<script defer data-domain="${esc(s.analytics_id)}" src="${esc(script)}"></script>`,
      scriptSrc: [origin],
      connectSrc: [origin],
    };
  }
  if (!s.analytics_id) return null;
  // Umami Cloud's tracker sends to its gateway; a self-hosted one sends to its own server or data-host-url.
  const cloud = origin === "https://cloud.umami.is";
  // A data address is accepted only when it is the tracker's own server or Umami Cloud, so a typo or a
  // changed setting can't make every public page send requests to some other host.
  const wanted = originOf(s.analytics_host);
  const host = wanted && (wanted === origin || wanted === "https://cloud.umami.is" || wanted === "https://gateway.umami.is") ? wanted : "";
  return {
    name: p.name,
    html: `<script defer src="${esc(script)}" data-website-id="${esc(s.analytics_id)}"${host ? ` data-host-url="${esc(host)}"` : ""}></script>`,
    scriptSrc: [origin],
    connectSrc: [...new Set([origin, host, cloud ? "https://gateway.umami.is" : ""].filter(Boolean))],
  };
}
