// CSS and JS bundles. Public pages inline their CSS and JS (no render-blocking requests);
// admin pages load cached files. Inline scripts get CSP hashes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { fontFaces, preloadFiles } from "../render/fonts.js";
import { FONT_PAIRS, themeCss } from "../design.js";
import { PLAUSIBLE_INIT } from "./analytics.js";

const read = (f) => fs.readFileSync(path.join(ROOT, "assets", f), "utf8");
// The bundled editor (npm run build:editor) only changes on upgrades, so it is read once.
let vendor = null;
const vendorFiles = () =>
  (vendor ??= Object.fromEntries(
    [["toastui-editor.js", "text/javascript; charset=utf-8"], ["toastui-editor.css", "text/css; charset=utf-8"]].map(([f, type]) => {
      const body = read(`vendor/${f}`);
      return [f, { body, type, hash: sha(body, "sha1", "hex").slice(0, 10) }];
    }),
  ));
const minifyCss = (css) =>
  css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{};,])\s*/g, "$1").replace(/;}/g, "}").trim();
const sha = (s, alg = "sha256", enc = "base64") => crypto.createHash(alg).update(s).digest(enc);

// Runs in <head> before first paint so a saved theme never flashes; the "js" class lets CSS collapse the mobile menu.
// A blog set to "Light only" (Admin > Design) ignores a reader's saved choice.
export const THEME_SCRIPT = 'var d=document.documentElement;d.classList.add("js");if(d.dataset.dMode!=="light")try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")d.dataset.theme=t}catch(e){}';

// Compares the bundled editor files with the hashes recorded when they were built (assets/vendor/toastui-editor.sha256,
// lines of "<sha256>  <file>"). Returns a plain sentence about a mismatch, or "" when they match or no hash is recorded.
export function editorBundleProblem() {
  try {
    const recorded = read("vendor/toastui-editor.sha256");
    const bad = [];
    for (const m of recorded.matchAll(/^([0-9a-f]{64})\s+(\S+)/gim)) {
      const file = path.basename(m[2]);
      if (sha(fs.readFileSync(path.join(ROOT, "assets", "vendor", file)), "sha256", "hex") !== m[1].toLowerCase()) bad.push(file);
    }
    return bad.length ? `The editor files (${bad.join(", ")}) do not match the hashes recorded when they were built. If you did not change them yourself, restore them from a trusted copy.` : "";
  } catch (err) {
    return err.code === "ENOENT" ? "" : `The editor files could not be checked (${String(err.message).split("\n")[0]}).`;
  }
}

export function createAssets({ basePath, production }) {
  const fonts = fontFaces(`${basePath}/assets/fonts/`);
  let built = null;

  const build = () => {
    // The colour themes and font pairs from Admin > Design come after the default tokens, so they win where <html> asks for them.
    const css = (files) => minifyCss([fonts.css, read("css/tokens.css"), themeCss(), ...files.map((f) => read(`css/${f}`))].join("\n"));
    const publicCss = css(["base.css", "site.css", "article.css"]);
    const previewCss = minifyCss(read("css/preview.css"));
    const siteJs = read("js/site.js");
    const adminCss = css(["base.css", "admin.css", "editor.css"]);
    const adminJs = read("js/admin.js");
    const editorJs = read("js/editor.js");
    const menusJs = read("js/menus.js");
    const designJs = read("js/design.js");
    const files = {
      "admin.css": { body: adminCss, type: "text/css; charset=utf-8" },
      "admin.js": { body: adminJs, type: "text/javascript; charset=utf-8" },
      "editor.js": { body: editorJs, type: "text/javascript; charset=utf-8" },
      "menus.js": { body: menusJs, type: "text/javascript; charset=utf-8" },
      "design.js": { body: designJs, type: "text/javascript; charset=utf-8" },
      // The public script as a file, for the Admin > Design preview (the admin's security rules run no inline public script).
      "site.js": { body: siteJs, type: "text/javascript; charset=utf-8" },
    };
    for (const f of Object.values(files)) f.hash = sha(f.body, "sha1", "hex").slice(0, 10);
    Object.assign(files, vendorFiles());
    return {
      publicCss,
      previewCss,
      siteJs,
      files,
      scriptHashes: [THEME_SCRIPT, siteJs, PLAUSIBLE_INIT].map((s) => `'sha256-${sha(s)}'`),
      // The public pages inline their stylesheet (and the preview stylesheet after it) in one <style> element; the policy
      // allows exactly that text instead of every inline style.
      styleHashes: [publicCss, publicCss + previewCss].map((s) => `'sha256-${sha(s)}'`),
      // Admin pages run only the theme script inline; the public scripts are not allowed there.
      adminScriptHashes: [THEME_SCRIPT].map((s) => `'sha256-${sha(s)}'`),
    };
  };

  // In development the files are re-read on every request, so edits show on reload.
  const get = () => (production ? (built ??= build()) : build());

  return {
    get,
    fontFile: (name) => fonts.files.get(name) || null,
    // The font files a page asks for early: the body text and headings of the chosen font pair.
    preloadFor: (design) => preloadFiles(FONT_PAIRS[design?.fonts] || FONT_PAIRS.inter).map((f) => `${basePath}/assets/fonts/${f}`),
  };
}
