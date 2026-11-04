// Builds the Quillo website (site/*.html) from site-src/: each page in site-src/pages gets the shared head, header,
// icons and footer from site-src/partials. The site/ folder is what goes online (Cloudflare Pages, or any static host).
// Run: npm run build:site
//
// A page starts with a comment of settings, one per line:
//   <!--
//   title: Features
//   description: One sentence for search engines and social cards.
//   nav: features            (which header link is marked as the current page)
//   path: /features/         (the page's address)
//   -->
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "site-src");
const OUT = path.join(ROOT, "site");
const ORIGIN = "https://quillo.dhyanalab.in";
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const partials = { head: read("partials/head.html"), header: read("partials/header.html"), footer: read("partials/footer.html"), icons: read("partials/icons.svg") };
const NAV = ["features", "designs", "pricing", "get-started"];

const pages = [];
for (const file of fs.readdirSync(path.join(SRC, "pages")).filter((f) => f.endsWith(".html")).sort()) {
  const raw = read(`pages/${file}`);
  const m = /^<!--([\s\S]*?)-->\s*/.exec(raw);
  if (!m) throw new Error(`${file}: the settings comment is missing`);
  const meta = Object.fromEntries(m[1].split("\n").map((l) => /^\s*(\w+):\s*(.+?)\s*$/.exec(l)).filter(Boolean).map((x) => [x[1], x[2]]));
  for (const k of ["title", "description", "path"]) if (!meta[k]) throw new Error(`${file}: "${k}" is missing`);
  let header = partials.header;
  for (const n of NAV) header = header.replaceAll(`data-nav="${n}"`, meta.nav === n ? 'aria-current="page"' : "");
  const html = partials.head
    .replaceAll("{{title}}", esc(meta.title === "Quillo" ? "Quillo: the blog platform you own" : `${meta.title} | Quillo`))
    .replaceAll("{{description}}", esc(meta.description))
    .replaceAll("{{url}}", esc(ORIGIN + meta.path))
    .replace("{{icons}}", partials.icons)
    .replace("{{header}}", header)
    .replace("{{main}}", raw.slice(m[0].length).trim())
    .replace("{{footer}}", partials.footer)
    .replace(/ +>/g, ">");
  const out = meta.path === "/" ? "index.html" : meta.path === "/404" ? "404.html" : path.join(meta.path.replace(/^\/|\/$/g, ""), "index.html");
  fs.mkdirSync(path.dirname(path.join(OUT, out)), { recursive: true });
  fs.writeFileSync(path.join(OUT, out), html);
  pages.push({ out, path: meta.path });
}

// The sitemap lists every page except the "not found" page.
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(OUT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.filter((p) => p.path !== "/404").map((p) => `  <url><loc>${ORIGIN}${p.path}</loc><lastmod>${today}</lastmod></url>`).join("\n")}\n</urlset>\n`);
console.log(`Built ${pages.length} pages into site/: ${pages.map((p) => p.out).join(", ")}`);
