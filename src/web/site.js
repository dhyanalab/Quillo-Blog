// Per-request view of the site: settings, URL builders, menus. Rebuilt only when settings or content change.
import { pictureHtml } from "../render/media.js";
import { networkOf } from "./networks.js";
import { analyticsSetup } from "./analytics.js";
import { SOCIAL_KEYS } from "../store/settings.js";
import { isHttpUrl } from "../render/util.js";
import { isSafeLocalPath } from "./validate.js";
import { isPrivateHost } from "../services/hosts.js";
import { PRODUCT } from "../product.js";
import { siteDesign } from "../design.js";

// A menu or footer link must be a path on this site or a full http(s) address. Anything else (javascript:, //host) becomes "".
const cleanUrl = (u) => {
  const v = String(u ?? "").trim();
  return v && (isSafeLocalPath(v) || isHttpUrl(v)) ? v : "";
};


// "Label | /url" per line; indented lines become a dropdown under the line above.
export function parseMenu(text) {
  const items = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const [label, url = ""] = raw.split("|").map((s) => s.trim());
    if (!label) continue;
    const item = { label, url: cleanUrl(url), children: [] };
    if (/^\s/.test(raw) && items.length) items.at(-1).children.push(item);
    else items.push(item);
  }
  return items;
}

// "## Column" starts a column; "Label | /url" lines are its links.
export function parseFooter(text) {
  const cols = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("##")) cols.push({ title: line.replace(/^#+\s*/, ""), links: [] });
    else if (cols.length) {
      const [label, url = ""] = line.split("|").map((s) => s.trim());
      if (label) cols.at(-1).links.push({ label, url: cleanUrl(url) });
    }
  }
  return cols;
}

// Pages whose address mentions privacy, terms, cookies or policy are legal pages: bottom bar, document layout.
export const isLegalSlug = (slug) => /privacy|terms|cookie|disclaimer|refund|legal|policy/i.test(slug || "");

export function buildSite(store, config) {
  // The email password stays out of every template; only the mailer reads it.
  const { smtp_pass: _secret, ...s } = store.settings.all();
  // SITE_URL is checked at start-up; the saved setting could be damaged, so fall back instead of failing every page.
  const origin = [config.siteUrl, s.site_url].map((u) => (/^https?:\/\//i.test(u || "") && URL.canParse(u) ? new URL(u).origin : "")).find(Boolean) || `http://localhost:${config.port}`;
  const base = config.basePath;
  const abs = (p) => (/^https?:\/\//i.test(p || "") ? p : `${origin}${p?.startsWith("/") ? "" : "/"}${p || ""}`);

  const url = {
    home: `${base}/`,
    latest: `${base}/latest/`,
    post: (slug) => `${base}/${slug}/`,
    category: (slug) => `${base}/category/${slug}/`,
    tag: (slug) => `${base}/tag/${slug}/`,
    author: (slug) => `${base}/authors/${slug}/`,
    search: `${base}/search/`,
    rss: `${base}/rss.xml`,
    sitemap: `${base}/sitemap.xml`,
    media: (p) => `${base}/media/${p}`,
    og: (kind, id, v) => `${base}/og/${kind}/${id}.png?v=${v}`,
    subscribe: `${base}/subscribe`,
    admin: `${base}/admin/`,
    signin: `${base}/signin/`,
    signup: `${base}/signup/`,
    signout: `${base}/signout/`,
    account: `${base}/account/`,
  };

  const categories = store.categories.list();
  const topCats = categories.filter((c) => !c.parent_id);
  const childrenOf = (id) => categories.filter((c) => c.parent_id === id);
  // Published posts in a category and its sub-categories. A category with none answers 404, so menus leave it out.
  const publicCount = (c) => c.post_count + childrenOf(c.id).reduce((n, k) => n + k.post_count, 0);

  // Newest posts of a category and its children, for the menu panels.
  const featuredIn = (cat) => {
    const ids = [cat.id, ...childrenOf(cat.id).map((k) => k.id)];
    return store.posts.listPublic({ categoryIds: ids, limit: 3 }).map((p) => {
      const img = store.media.get(p.feature_image_id);
      return { title: p.short_title || p.title, url: url.post(p.slug), thumb: img ? pictureHtml(img, { url: url.media, alt: "", sizes: "220px" }) : "" };
    });
  };
  // Automatic menu: top-level categories (those with sub-categories open a panel) and Latest.
  const autoNav = [
    ...topCats.filter(publicCount).slice(0, 7).map((c) => {
      const kids = childrenOf(c.id).filter((k) => k.post_count);
      return {
        label: c.name,
        url: url.category(c.slug),
        children: kids.map((k) => ({ label: k.name, url: url.category(k.slug), children: [] })),
        featured: kids.length ? featuredIn(c) : [],
      };
    }),
    { label: "Latest", url: url.latest, children: [] },
  ];
  // A chosen menu item that opens a list and points at a category also shows that category's newest posts.
  const catByUrl = new Map(categories.map((c) => [url.category(c.slug), c]));
  const customNav = s.nav_mode === "custom" && s.nav_items?.length ? s.nav_items : s.nav_menu.trim() ? parseMenu(s.nav_menu) : null;
  const nav = customNav
    ? customNav.map((i) => {
        const children = (i.children || []).map((k) => ({ label: k.label, url: cleanUrl(k.url), children: [] }));
        const cat = children.length ? catByUrl.get(i.url) : null;
        return { label: i.label, url: cleanUrl(i.url), children, featured: cat ? featuredIn(cat) : [] };
      })
    : autoNav;
  const newsCat = categories.find((c) => c.slug === s.news_category_slug) || null;

  const socialUrls = (s.social_links?.length ? s.social_links : SOCIAL_KEYS.map((k) => s[`social_${k}`])).filter((u) => u && isHttpUrl(u));
  // Two profiles on one network (say, two Instagram accounts) are told apart by their account name.
  const handleOf = (u) => {
    try {
      return new URL(u).pathname.split("/").filter(Boolean).at(-1) || "";
    } catch {
      return "";
    }
  };
  const perNetwork = socialUrls.reduce((m, u) => m.set(networkOf(u).id, (m.get(networkOf(u).id) || 0) + 1), new Map());
  const social = socialUrls.map((u) => {
    const n = networkOf(u);
    const handle = perNetwork.get(n.id) > 1 && n.id !== "website" ? handleOf(u) : "";
    return { key: n.id, label: handle ? `${n.name} (@${handle})` : n.name, url: u };
  });
  // Pages A to Z, by their short title ("About", not "About My Blog") for menus.
  const pages = store.posts.listPublic({ type: "page", limit: 20 })
    .map((p) => ({ ...p, title: p.short_title || p.title }))
    .sort((a, b) => a.title.localeCompare(b.title));

  // The Contact page (slug "contact" or "contact-us"), which other pages link to.
  const contactPage = pages.find((p) => /^contact(-us)?$/.test(p.slug));
  // Legal pages (privacy, terms, cookies...) sit in the footer's bottom bar, privacy first.
  const LEGAL_ORDER = ["privacy", "terms", "cookie"];
  const legalRank = (p) => ((i) => (i < 0 ? LEGAL_ORDER.length : i))(LEGAL_ORDER.findIndex((k) => p.slug.includes(k)));
  const isLegal = (p) => isLegalSlug(p.slug);
  const legal = pages.filter(isLegal).sort((a, b) => legalRank(a) - legalRank(b)).map((p) => ({ label: p.title, url: url.post(p.slug) }));
  // Automatic footer columns: categories, and the other pages.
  const autoFooter = [
    { title: "Categories", links: topCats.filter(publicCount).map((c) => ({ label: c.name, url: url.category(c.slug) })) },
    { title: "Company", links: [...pages.filter((p) => !isLegal(p)).map((p) => ({ label: p.title, url: url.post(p.slug) })), { label: "Latest posts", url: url.latest }] },
  ].filter((c) => c.links.length);
  const footer = (s.footer_mode === "custom" && s.footer_cols?.length ? s.footer_cols : s.footer_menu.trim() ? parseFooter(s.footer_menu) : autoFooter)
    .map((col) => ({ ...col, links: (col.links || []).map((l) => ({ ...l, url: cleanUrl(l.url) })) }));

  const logo = store.media.get(s.logo_id);
  const defaultOg = store.media.get(s.default_og_image_id);

  return {
    s,
    origin,
    base,
    host: new URL(origin).hostname,
    blogUrl: `${origin}${base}`,
    https: origin.startsWith("https:"),
    // False while the site URL is still a local or private address (the one shared check, services/hosts.js): mail with
    // links to it (newsletters, sign-up and password mails) would be useless to the people who get it.
    hasPublicUrl: !isPrivateHost(new URL(origin).hostname),
    abs,
    url,
    title: s.site_title,
    description: s.site_description,
    name: s.org_name,
    tz: s.timezone,
    locale: s.og_locale,
    lang: "en",
    homeUrl: cleanUrl(s.home_url) || url.home,
    logo,
    logoUrl: logo ? abs(url.media(logo.path)) : "",
    defaultOg,
    sameAs: social.map((x) => x.url),
    social,
    nav,
    footer,
    // The automatic menus and every page, for the menu editor in the admin.
    autoNav: autoNav.map((i) => ({ label: i.label, url: i.url, children: i.children.map((k) => ({ label: k.label, url: k.url })) })),
    autoFooter,
    legal,
    pages: pages.map((p) => ({ label: p.title, url: url.post(p.slug) })),
    // Each published page's address by slug, e.g. pageUrls.advertise, for links between pages.
    pageUrls: Object.fromEntries(pages.map((p) => [p.slug, url.post(p.slug)])),
    categories,
    newsCat,
    business: {
      name: s.business_name,
      brand: s.brand_name,
      brandUrl: s.brand_url,
      street: s.address_street,
      city: s.address_city,
      region: s.address_region,
      postcode: s.address_postcode,
      country: s.address_country,
      // The footer shows only the town; the full address is on the Contact page and in emails.
      locality: [s.address_city, s.address_region, s.address_country].filter(Boolean).join(", "),
      contactUrl: contactPage ? url.post(contactPage.slug) : "",
      addressLines: [s.address_street, [s.address_city, s.address_region].filter(Boolean).join(", "), [s.address_country, s.address_postcode].filter(Boolean).join(" - ")].filter(Boolean),
      mapUrl: s.address_street || s.address_city ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([s.address_street, s.address_city, s.address_region, s.address_postcode, s.address_country].filter(Boolean).join(", "))}` : "",
      phone: s.contact_phone,
      phoneHref: s.contact_phone ? `tel:${s.contact_phone.replace(/[^\d+]/g, "")}` : "",
      emails: [s.contact_email, s.contact_email_alt].filter(Boolean),
    },
    comments: { enabled: Boolean(s.comments_enabled), moderation: s.comments_moderation, signup: Boolean(s.members_signup) },
    cta: [
      cleanUrl(s.cta_download_url) && { label: s.cta_download_label, url: cleanUrl(s.cta_download_url), primary: true },
      cleanUrl(s.cta_kit_url) && { label: s.cta_kit_label, url: cleanUrl(s.cta_kit_url) },
    ].filter(Boolean),
    newsletter: s.newsletter_enabled ? { heading: s.newsletter_heading, text: s.newsletter_text } : null,
    analytics: analyticsSetup(s),
    // Ownership codes from Search Console, Bing and others, as <meta name content> pairs.
    verify: [
      ["google-site-verification", s.google_verification],
      ["msvalidate.01", s.bing_verification],
      ["yandex-verification", s.yandex_verification],
      ["p:domain_verify", s.pinterest_verification],
      ["facebook-domain-verification", s.facebook_verification],
    ].filter(([, v]) => v),
    about: s.about_text,
    // White-label: the mark shown when there is no logo ("initials" or an icon name), the topic features switched on in
    // Settings > Post features, and the optional "Powered by" credit in the footer.
    brandMark: s.brand_mark,
    postFeatures: Array.isArray(s.post_features) ? s.post_features : [],
    poweredBy: s.show_powered_by ? PRODUCT : null,
    noun: { one: s.post_noun || "post", many: s.post_noun_plural || "posts" },
    adsPitch: s.ads_pitch,
    adsWho: s.ads_who,
    // The look chosen on Admin > Design: the attributes <html> carries, the browser bar colours and the fonts to preload.
    design: siteDesign(s.design),
    // Read when a page is built, so the footer year changes at New Year even if the site object was cached.
    get year() {
      return new Date().getFullYear();
    },
  };
}
