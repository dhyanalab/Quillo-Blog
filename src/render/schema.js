// JSON-LD, one @graph per page. Every value here is also visible on the page.
// `site` = { origin, blogUrl, name, title, description, logoUrl, sameAs[], lang, abs(path) }
import { isHttpUrl, isoDurationToSeconds } from "./util.js";

// Every string that goes into the structured data is plain text: control characters and broken surrogate pairs are
// dropped here, and "<", ">", "&" and the line separators are escaped where the JSON is written (the jsonld filter).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const clean = (v) => {
  if (typeof v === "string") return v.replace(CONTROL, "").toWellFormed();
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
  return v;
};
// Addresses in the data must be real web addresses (no javascript: or data: links, no user:password@).
const httpUrl = (u) => (isHttpUrl(u) ? u : null);
const urls = (list) => (list || []).filter(isHttpUrl);
const compact = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length)).map(([k, v]) => [k, clean(v)]));

export const orgId = (site) => `${site.origin}/#organization`;
const websiteId = (site) => `${site.blogUrl}/#website`;
export const personId = (site, author) => `${site.abs(author.url)}#person`;

export function organization(site) {
  const b = site.business || {};
  const address = b.street || b.city
    ? compact({ "@type": "PostalAddress", streetAddress: b.street, addressLocality: b.city, addressRegion: b.region, postalCode: b.postcode, addressCountry: b.country })
    : null;
  return compact({
    "@type": "Organization",
    "@id": orgId(site),
    name: b.brand || site.name,
    legalName: b.name,
    url: httpUrl(b.brandUrl) || `${site.origin}/`,
    logo: httpUrl(site.logoUrl) ? { "@type": "ImageObject", url: site.logoUrl } : null,
    address,
    telephone: b.phone,
    email: b.emails?.[0],
    sameAs: urls(site.sameAs),
  });
}

function website(site) {
  return compact({
    "@type": "WebSite",
    "@id": websiteId(site),
    name: site.title,
    description: site.description,
    url: `${site.blogUrl}/`,
    inLanguage: site.lang,
    publisher: { "@id": orgId(site) },
  });
}

export function person(site, author) {
  return compact({
    "@type": "Person",
    "@id": personId(site, author),
    name: author.name,
    url: site.abs(author.url),
    jobTitle: author.job_title,
    description: author.bio,
    image: author.photoUrl ? httpUrl(site.abs(author.photoUrl)) : null,
    sameAs: urls((author.links || []).map((l) => l.url)),
    worksFor: { "@id": orgId(site) },
  });
}

function breadcrumbs(site, crumbs) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => compact({ "@type": "ListItem", position: i + 1, name: c.name, item: c.url ? site.abs(c.url) : null })),
  };
}

const graph = (...nodes) => ({ "@context": "https://schema.org", "@graph": nodes.filter(Boolean) });

// The video as structured data: the id must be a real 11-character YouTube id, every address is built from it here (never taken
// from the caller), and a date or duration that isn't ISO 8601 is left out.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const seconds = (n) => (Number.isInteger(n) && n >= 0 ? n : null);
function videoOf(v) {
  if (!v || typeof v.id !== "string" || !VIDEO_ID.test(v.id)) return null;
  const date = typeof v.uploadDate === "string" && ISO_DATE.test(v.uploadDate) && Number.isFinite(Date.parse(v.uploadDate)) ? v.uploadDate : null;
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    uploadDate: date,
    duration: isoDurationToSeconds(v.duration) == null ? null : v.duration,
    thumbnail: `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`,
    watchUrl: `https://www.youtube.com/watch?v=${v.id}`,
    chapters: (v.chapters || []).map((c) => ({ name: c.name, start: seconds(c.start), end: seconds(c.end) })).filter((c) => c.name && c.start != null),
  };
}

export function postGraph(site, post) {
  const url = site.abs(post.url);
  const v = videoOf(post.videoInfo);
  const article = compact({
    "@type": "BlogPosting",
    "@id": `${url}#article`,
    headline: post.title,
    description: post.excerpt,
    image: post.ogImageUrl ? [post.ogImageUrl] : null,
    datePublished: post.publishedIso,
    dateModified: post.updatedIso,
    inLanguage: site.lang,
    mainEntityOfPage: url,
    url,
    wordCount: post.word_count || null,
    articleSection: post.category?.name,
    keywords: post.tags?.map((t) => t.name),
    author: { "@id": personId(site, post.author) },
    publisher: { "@id": orgId(site) },
    isPartOf: { "@id": websiteId(site) },
    video: v ? { "@id": `${url}#video` } : null,
    commentCount: post.commentCount || null,
    hasPart: post.sourceFiles?.length ? { "@id": `${url}#code` } : null,
  });
  const code = post.sourceFiles?.length
    ? compact({
        "@type": "SoftwareSourceCode",
        "@id": `${url}#code`,
        name: `Source code: ${post.title}`,
        programmingLanguage: [...new Set(post.sourceFiles.map((f) => f.langLabel))],
        codeRepository: httpUrl(post.downloads?.github),
        isPartOf: { "@id": `${url}#article` },
      })
    : null;
  const video = v
    ? compact({
        "@type": "VideoObject",
        "@id": `${url}#video`,
        name: v.title,
        description: v.description,
        thumbnailUrl: [v.thumbnail],
        uploadDate: v.uploadDate,
        duration: v.duration,
        embedUrl: `https://www.youtube.com/embed/${v.id}`,
        contentUrl: v.watchUrl,
        hasPart: v.chapters.map((c) => compact({ "@type": "Clip", name: c.name, startOffset: c.start, endOffset: c.end, url: `${v.watchUrl}&t=${c.start}s` })),
      })
    : null;
  return graph(article, video, code, breadcrumbs(site, post.crumbs), person(site, post.author), organization(site), website(site));
}

// About and Contact pages get their own schema.org types, pointing at the organisation.
const PAGE_TYPES = [[/\/about(-us)?\/$/, "AboutPage"], [/\/contact(-us)?\/$/, "ContactPage"]];

export function pageGraph(site, page) {
  const url = site.abs(page.url);
  const type = PAGE_TYPES.find(([re]) => re.test(page.url))?.[1];
  return graph(
    compact({ "@type": type || "WebPage", about: type ? { "@id": orgId(site) } : null, "@id": url, url, name: page.title, description: page.excerpt, inLanguage: site.lang, isPartOf: { "@id": websiteId(site) }, dateModified: page.updatedIso }),
    breadcrumbs(site, page.crumbs),
    organization(site),
    website(site),
  );
}

// Category, tag, list and home pages: the posts shown, in order.
export function collectionGraph(site, { url, name, description, crumbs, items, hub = false }) {
  const abs = site.abs(url);
  return graph(
    compact({
      "@type": "CollectionPage",
      "@id": hub ? `${abs}#hub` : abs,
      url: abs,
      name,
      description,
      inLanguage: site.lang,
      isPartOf: { "@id": websiteId(site) },
      mainEntity: items.length
        ? { "@type": "ItemList", itemListElement: items.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: site.abs(p.url), name: p.title })) }
        : null,
    }),
    crumbs ? breadcrumbs(site, crumbs) : null,
    organization(site),
    website(site),
  );
}

export function profileGraph(site, author, crumbs) {
  return graph({ "@type": "ProfilePage", "@id": site.abs(author.url), url: site.abs(author.url), mainEntity: person(site, author) }, breadcrumbs(site, crumbs), organization(site));
}
