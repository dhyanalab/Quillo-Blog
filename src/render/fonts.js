// Self-hosted fonts from @fontsource (OFL). Keeps the latin and latin-ext faces from
// Fontsource's own CSS (font-display: swap, unicode-range) and serves the woff2 files from <base>/assets/fonts/.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const FAMILIES = [
  { pkg: "@fontsource/inter", weights: [400, 500, 600, 700, 800] },
  { pkg: "@fontsource/jetbrains-mono", weights: [400, 500] },
];

const SUBSETS = ["latin", "latin-ext"];

// Preloaded because they render the first text on every page.
export const PRELOAD = ["inter-latin-400-normal.woff2", "inter-latin-700-normal.woff2"];

const pkgDir = (pkg) => path.dirname(require.resolve(`${pkg}/package.json`));

// Returns the @font-face CSS (URLs under `urlPrefix`) and a map of file name -> absolute path.
export function fontFaces(urlPrefix) {
  const css = [];
  const files = new Map();
  for (const { pkg, weights } of FAMILIES) {
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
