// Self-hosted fonts from @fontsource (OFL). Keeps the latin and latin-ext faces from
// Fontsource's own CSS (font-display: swap, unicode-range) and serves the woff2 files from <base>/assets/fonts/.
// Every font pair on Admin > Design (src/design.js FONT_PAIRS) is described here; a browser only downloads the faces a
// page actually uses, so listing them all costs nothing but a few lines of CSS.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Family name -> package and the weights the stylesheets use (headings 600-800, text 400-700, code 400-500).
export const FAMILIES = {
  "Inter": { pkg: "@fontsource/inter", weights: [400, 500, 600, 700, 800] },
  "JetBrains Mono": { pkg: "@fontsource/jetbrains-mono", weights: [400, 500] },
  "IBM Plex Sans": { pkg: "@fontsource/ibm-plex-sans", weights: [400, 500, 600, 700] },
  "IBM Plex Mono": { pkg: "@fontsource/ibm-plex-mono", weights: [400, 500] },
  "Plus Jakarta Sans": { pkg: "@fontsource/plus-jakarta-sans", weights: [600, 700, 800] },
  "Manrope": { pkg: "@fontsource/manrope", weights: [400, 500, 600, 700, 800] },
  "Source Serif 4": { pkg: "@fontsource/source-serif-4", weights: [400, 600, 700] },
  "Outfit": { pkg: "@fontsource/outfit", weights: [500, 600, 700, 800] },
  "Nunito": { pkg: "@fontsource/nunito", weights: [400, 500, 600, 700, 800] },
};

const SUBSETS = ["latin", "latin-ext"];

// The faces that render the first text on a page: the body text at 400 and the headings at 700.
const faceFile = (family, weight) => `${FAMILIES[family].pkg.replace("@fontsource/", "")}-latin-${weight}-normal.woff2`;
export const preloadFiles = (pair) => [...new Set([faceFile(pair.text || pair.body, 400), faceFile(pair.head, 700)])];
export const PRELOAD = preloadFiles({ head: "Inter", body: "Inter" });

const pkgDir = (pkg) => path.dirname(require.resolve(`${pkg}/package.json`));

// Returns the @font-face CSS (URLs under `urlPrefix`) and a map of file name -> absolute path.
export function fontFaces(urlPrefix) {
  const css = [];
  const files = new Map();
  for (const { pkg, weights } of Object.values(FAMILIES)) {
    for (const w of weights) {
      const source = fs.readFileSync(path.join(pkgDir(pkg), `${w}.css`), "utf8");
      for (const block of source.split(/(?=\/\* )/)) {
        const name = /\/\* ([\w-]+) \*\//.exec(block)?.[1] || "";
        const subset = name.replace(/^.*?-((?:latin-ext)|latin)-\d+-normal$/, "$1");
        if (!SUBSETS.includes(subset) || !name.endsWith(`-${subset}-${w}-normal`)) continue;
        const file = `${name}.woff2`;
        files.set(file, path.join(pkgDir(pkg), "files", file));
        css.push(block.replace(/\/\*.*?\*\//, "").replace(/src:[^;]+;/, `src: url(${urlPrefix}${file}) format('woff2');`).trim());
      }
    }
  }
  return { css: css.join("\n"), files };
}
