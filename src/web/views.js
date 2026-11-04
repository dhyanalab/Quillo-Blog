import path from "node:path";
import nunjucks from "nunjucks";
import { ROOT } from "../config.js";
import { PRODUCT } from "../product.js";
import { formatDate, formatDateTime, isoToLocalInput } from "../render/util.js";
import { addIconGlobals } from "./icons.js";

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
  env.addFilter("initials", (name) => String(name || "?").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase());
  addIconGlobals(env);
  env.addGlobal("product", PRODUCT);
  env.addFilter("kb", (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`));
  return {
    env,
    render: (name, data) => env.render(name, data),
  };
}
