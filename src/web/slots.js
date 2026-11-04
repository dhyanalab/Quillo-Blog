// Sponsor banners in their places. Everything is served from this site: pictures from /media with plain
// file names, short class names (no "ad", "banner" or "sponsor" words that blocker lists hide) and no
// third-party scripts. Each banner is clearly labelled "Sponsored" for readers. Links use rel="sponsored nofollow",
// which Google asks for on paid links. When a place has several banners, site.js shows one at random.
import { AD_PLACES } from "../store/ads.js";
import { escapeHtml, isHttpUrl } from "../render/util.js";
import { isEmail, isSafeLocalPath } from "./validate.js";

// Links are written into the page, so only a web address, a path on this site or a plain mailto: address is ever used as one.
// A mailto: link with anything after the address (?cc=, ?bcc=, ?body=) is not used, whatever was stored; the same rule as when it is saved.
const safeLink = (u) => (isHttpUrl(u) || isSafeLocalPath(u) || (/^mailto:/i.test(u || "") && !/[?&#%]/.test(String(u).slice(7)) && isEmail(String(u).slice(7))) ? u : "");

export function renderSlots(store, site) {
  // The master switch turns every place off; a place can also be switched off on its own.
  if (!site.s.ads_enabled) return {};
  const off = new Set(site.s.ads_places_off || []);
  const live = store.ads.live();
  const media = (id) => (id ? store.media.get(id) : null);
  const out = {};
  for (const [key, place] of Object.entries(AD_PLACES)) {
    if (off.has(key)) {
      out[key] = "";
      continue;
    }
    const ads = (live[key] || []).map((ad) => ({ ad, img: media(ad.image_id), phone: media(ad.mobile_image_id) })).filter((x) => x.img && isHttpUrl(x.ad.url));
    if (!ads.length) {
      out[key] = site.s.ads_empty === "show" ? emptySlot(key, place, site) : "";
      continue;
    }
    const items = ads.map(({ ad, img, phone }, i) => {
      const source = phone ? `<source media="(max-width: 640px)" srcset="${escapeHtml(site.url.media(phone.path))}">` : "";
      const size = img.width ? ` width="${img.width}" height="${img.height}"` : "";
      const loading = key === "top" ? "" : ' loading="lazy"';
      return `<a class="kx-i" href="${escapeHtml(ad.url)}" target="_blank" rel="sponsored nofollow noopener" data-i="${ad.id}"${i ? " hidden" : ""}><picture>${source}<img src="${escapeHtml(site.url.media(img.path))}" alt="${escapeHtml(ad.alt || ad.name)}"${size}${loading} decoding="async"></picture></a>`;
    });
    out[key] = `<div class="kx kx-${place.shape}" data-k="${key}"><div class="kx-f">${items.join("")}<span class="kx-l">Sponsored</span></div></div>`;
  }
  return out;
}

// "Your brand here" box for empty places, when Settings say to show them.
function emptySlot(key, place, site) {
  const inner = `<span class="kx-t">Your brand here</span><span class="kx-s">${escapeHtml(place.size)}</span>`;
  const url = safeLink(site.s.ads_contact_url);
  return `<div class="kx kx-${place.shape}" data-k="${key}">${url ? `<a class="kx-e" href="${escapeHtml(url)}">${inner}<span class="kx-c">Advertise with us</span></a>` : `<div class="kx-e">${inner}</div>`}</div>`;
}

// Splits article HTML before a middle section, so a banner can sit halfway through the text.
export function splitForSlot(html) {
  const marks = [...html.matchAll(/<div class="hx hx-2">/g)];
  if (marks.length < 3) return [html, ""];
  const at = marks[Math.floor(marks.length / 2)].index;
  return [html.slice(0, at), html.slice(at)];
}
