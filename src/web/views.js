import path from "node:path";
import nunjucks from "nunjucks";
import { ROOT } from "../config.js";
import { PRODUCT } from "../product.js";
import { escapeHtml, formatDate, formatDateTime, isoToLocalInput } from "../render/util.js";
import { addIconGlobals, iconSvg } from "./icons.js";

// The browser-tab icon when the blog has no logo: the brand mark on the accent colour. A blog whose mark is the microchip keeps
// the chip drawing it always had.
const CHIP_FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23C2410C'/%3E%3Crect x='10' y='10' width='12' height='12' rx='2' fill='none' stroke='white' stroke-width='2.2'/%3E%3Cpath d='M13 6v4M19 6v4M13 22v4M19 22v4M6 13h4M6 19h4M22 13h4M22 19h4' stroke='white' stroke-width='2.2' stroke-linecap='round'/%3E%3C/svg%3E";
const initials = (name) => String(name || "?").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

export function createViews({ production }) {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(ROOT, "views"), { noCache: !production }), {
    autoescape: true,
    throwOnUndefined: false,
    trimBlocks: true,
    lstripBlocks: true,
  });
  env.addFilter("date", (iso, tz) => formatDate(iso, tz));
  env.addFilter("datetime", (iso, tz) => formatDateTime(iso, tz));
  env.addFilter("localinput", (iso, tz) => isoToLocalInput(iso, tz));
  // Data blocks: escape every character that could end a script block, open a tag or break a JS line.
  const JSON_ESCAPES = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" };
  env.addFilter("jsonld", (obj) => new nunjucks.runtime.SafeString((JSON.stringify(obj) ?? "null").replace(/[<>&\u2028\u2029]/g, (ch) => JSON_ESCAPES[ch])));
  env.addFilter("json", (obj) => JSON.stringify(obj ?? null));
  env.addFilter("plural", (n, one, many) => (n === 1 ? one : many ?? `${one}s`));
  env.addFilter("initials", initials);
  addIconGlobals(env);
  env.addGlobal("product", PRODUCT);
  env.addGlobal("faviconHref", (site) => {
    const mark = site?.brandMark;
    if (mark === "chip") return CHIP_FAVICON;
    const inner = mark && mark !== "initials"
      ? iconSvg(mark, 20).replace("<svg ", '<svg x="6" y="6" color="white" ')
      : `<text x="16" y="21.5" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="13" font-weight="700" fill="white">${escapeHtml(initials(site?.title))}</text>`;
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#C2410C"/>${inner}</svg>`)}`;
  });
  // The mark before the blog's name when it has no logo: the title's initials, or the icon chosen in Settings.
  env.addGlobal("brandMarkHtml", (site, size = 20) => {
    const mark = site?.brandMark;
    const inner = mark && mark !== "initials" ? iconSvg(mark, size) : escapeHtml(initials(site?.title));
    return new nunjucks.runtime.SafeString(`<span class="brand-mark${mark && mark !== "initials" ? "" : " brand-initials"}" aria-hidden="true">${inner}</span>`);
  });
  env.addFilter("kb", (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`));
  return {
    env,
    render: (name, data) => env.render(name, data),
  };
}
