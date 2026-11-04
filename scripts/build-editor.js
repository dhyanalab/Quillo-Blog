// Bundles the Toast UI editor (MIT) and its ProseMirror dependencies into one browser file
// at assets/vendor/toastui-editor.js (and its stylesheet at toastui-editor.css), so the admin never loads code from a CDN.
//
//   npm run build:editor            build, then check the result against the recorded hashes
//   npm run build:editor -- --update   build and record the new hashes (after upgrading @toast-ui/editor or dompurify on purpose)
//   npm run build:editor -- --verify   only check the committed files against the recorded hashes (no build, no node_modules needed)
//
// The build also changes four things in the editor's own source (each one is checked, and the build fails if the text isn't found):
//   - it uses DOMPurify from package-lock.json (3.x) instead of the older copy inlined in the editor (2.3.3), and exposes it
//     as window.EditorPurify for the sanitizer that assets/js/editor.js passes in;
//   - the usage-statistics beacon to google-analytics.com is removed;
//   - raw HTML that is not a tag (a comment, <?...?>, <!DOCTYPE>, CDATA) no longer throws while a draft loads in Visual mode;
//   - the <pre> converter and link marks no longer put unsanitised text or a javascript: address into the page.
//
// Checks made before anything is recorded or written:
//   - every package that ends up inside the bundle (taken from esbuild's own list of inputs, nested copies included) is the version
//     package-lock.json pins, and has an integrity entry there; the build tools are checked the same way;
//   - exactly one DOMPurify is bundled: one lock entry, one copy of its code, and it is the pinned version;
//   - the stylesheet (built from the editor's two CSS files) is covered by its own recorded hash, next to the script's.
// If the checks fail, run `npm ci --ignore-scripts` first (it installs exactly what the lock file says) and try again.
import { build } from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The project folder comes from this file's own place, not from config.js, so --verify gives the same answer in any shell environment.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(ROOT, "assets", "vendor");
const jsFile = path.join(out, "toastui-editor.js");
const cssFile = path.join(out, "toastui-editor.css");
const hashFile = path.join(out, "toastui-editor.sha256");
const args = new Set(process.argv.slice(2));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const fail = (msg) => {
  console.error(`build-editor: ${msg}`);
  process.exit(1);
};

// The recorded hashes: one line per file, "<sha256>  <file name>  (notes)". The script's line comes first.
const recorded = (name) => {
  try {
    for (const line of fs.readFileSync(hashFile, "utf8").split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+(\S+)/.exec(line.trim());
      if (m && m[2] === name) return m[1];
    }
  } catch {
    // no file: nothing recorded
  }
  return "";
};

if (args.has("--verify")) {
  for (const [file, name] of [[jsFile, "toastui-editor.js"], [cssFile, "toastui-editor.css"]]) {
    if (!fs.existsSync(file)) fail(`assets/vendor/${name} is missing.`);
    const got = sha256(fs.readFileSync(file));
    if (!recorded(name)) fail(`no recorded hash for ${name} (assets/vendor/toastui-editor.sha256). Run: npm run build:editor -- --update`);
    if (got !== recorded(name)) fail(`assets/vendor/${name} does not match its recorded hash.\n  recorded ${recorded(name)}\n  actual   ${got}\nRebuild it with npm run build:editor, or restore the committed file.`);
    console.log(`${name} matches its recorded sha256 (${got.slice(0, 12)}…)`);
  }
  process.exit(0);
}

// ---------- The versions in node_modules must be the ones package-lock.json pins ----------

const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
// `key` is a path such as "node_modules/dompurify" (or "node_modules/a/node_modules/b" for a nested copy).
const installedVersion = (key) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, key, "package.json"), "utf8")).version;
  } catch {
    return "";
  }
};
const checkAgainstLock = (key) => {
  const entry = lock.packages?.[key];
  if (!entry?.version) fail(`${key.replace(/^.*node_modules\//, "")} is not in package-lock.json.`);
  if (!entry.integrity) fail(`${key} has no integrity entry in package-lock.json.`);
  const have = installedVersion(key);
  if (have !== entry.version) fail(`${key} in node_modules is ${have || "missing"}, but package-lock.json pins ${entry.version}. Run npm ci --ignore-scripts first.`);
  return entry.version;
};
const pinned = {};
for (const name of ["@toast-ui/editor", "dompurify", "esbuild"]) pinned[name] = checkAgainstLock(`node_modules/${name}`);

// The package a file inside node_modules belongs to, as a lock key. Returns "" for files outside node_modules.
const packageKeyOf = (file) => {
  const p = file.split(path.sep).join("/").replace(/^\.\//, "");
  const at = p.lastIndexOf("node_modules/");
  if (at < 0) return "";
  const rest = p.slice(at + "node_modules/".length).split("/");
  const len = rest[0].startsWith("@") ? 2 : 1;
  return p.slice(0, at + "node_modules/".length) + rest.slice(0, len).join("/");
};

// Exact-text changes to the editor's source. Each pattern must be found exactly as many times as listed.
const PATCHES = [
  // Use the locked DOMPurify for every sanitize call the editor makes.
  { from: "var purify = createDOMPurify();", to: "var purify = __lockedPurify;", times: 1 },
  // No usage-statistics beacon.
  { from: "function sendHostName() {", to: "function sendHostName() { return;", times: 1 },
  // Raw HTML that isn't a tag: keep the text instead of throwing.
  {
    from: "        var matched = html.match(reHTMLTag);\n        var openTagName = matched[1], closeTagName = matched[3];\n        var typeName = (openTagName || closeTagName).toLowerCase();\n        var markType",
    to: "        var matched = html.match(reHTMLTag);\n        if (!matched) { state.addText(html); return; }\n        var openTagName = matched[1], closeTagName = matched[3];\n        var typeName = (openTagName || closeTagName).toLowerCase();\n        var markType",
    times: 1,
  },
  {
    from: "            var matched = html.match(reHTMLTag);\n            var openTagName = matched[1], closeTagName = matched[3];\n            var typeName = (openTagName || closeTagName).toLowerCase();\n            var nodeType",
    to: "            var matched = html.match(reHTMLTag);\n            if (!matched) { state.openNode(state.schema.nodes.htmlComment); state.addText(node.literal); state.closeNode(); return; }\n            var openTagName = matched[1], closeTagName = matched[3];\n            var typeName = (openTagName || closeTagName).toLowerCase();\n            var nodeType",
    times: 1,
  },
  // The <pre> converter parsed raw literal text as HTML.
  { from: "        container.innerHTML = node.literal;\n        var literal = (_b = (_a = container.firstChild)", to: "        container.innerHTML = sanitizeHTML(node.literal);\n        var literal = (_b = (_a = container.firstChild)", times: 1 },
  // A link mark must not turn a javascript: (or data:, vbscript:) destination into a live address.
  { from: "href: escapeXml$1(attrs.linkUrl) }, _this.linkAttributes)", to: "href: __safeHref(escapeXml$1(attrs.linkUrl)) }, _this.linkAttributes)", times: 1 },
];
const HELPERS = `import __lockedPurify from "dompurify";
function __safeHref(u) {
  var s = String(u == null ? "" : u);
  var probe = s.replace(/&#x([0-9a-f]+);?/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); }).replace(/&#(\\d+);?/g, function (m, d) { return String.fromCharCode(Number(d)); }).replace(/&amp;/g, "&").replace(/[\\u0000-\\u0020\\u007f-\\u009f]+/g, "");
  try { probe = decodeURIComponent(probe); } catch (e) {}
  return /^(?:https?:|mailto:|tel:|[^:]*(?:[/?#]|$))/i.test(probe) ? s : "#";
}
`;

const patchEditor = {
  name: "patch-toastui",
  setup(b) {
    b.onLoad({ filter: /@toast-ui[\\/]editor[\\/]dist[\\/]esm[\\/]index\.js$/ }, (args) => {
      let src = fs.readFileSync(args.path, "utf8");
      for (const p of PATCHES) {
        const n = src.split(p.from).length - 1;
        if (n !== p.times) throw new Error(`editor source changed: expected ${p.times} match(es) of ${JSON.stringify(p.from.slice(0, 60))}, found ${n}. Review scripts/build-editor.js after upgrading @toast-ui/editor.`);
        src = src.split(p.from).join(p.to);
      }
      return { contents: HELPERS + src, loader: "js", resolveDir: path.dirname(args.path) };
    });
  },
};

fs.mkdirSync(out, { recursive: true });
const result = await build({
  stdin: { contents: 'import Editor from "@toast-ui/editor"; import DOMPurify from "dompurify"; window.ToastEditor = Editor; window.EditorPurify = DOMPurify;', resolveDir: ROOT, loader: "js" },
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  legalComments: "eof",
  write: false,
  metafile: true,
  absWorkingDir: ROOT,
  outfile: jsFile,
  plugins: [patchEditor],
});
const bundle = Buffer.from(result.outputFiles[0].contents);
const text = bundle.toString("utf8");

// ---------- Every package inside the bundle is checked against the lock file ----------

const bundled = new Set();
for (const file of Object.keys(result.metafile.inputs)) {
  const key = packageKeyOf(file);
  if (key) bundled.add(key);
}
if (!bundled.size) fail("the bundle has no packages from node_modules, which can't be right.");
for (const key of bundled) checkAgainstLock(key);
console.log(`Checked ${bundled.size} bundled packages against package-lock.json.`);

// Exactly one DOMPurify: one package in the bundle, one copy of its code, at the pinned version.
const purifyPackages = [...bundled].filter((k) => k.endsWith("/dompurify"));
if (purifyPackages.length !== 1 || purifyPackages[0] !== "node_modules/dompurify") fail(`expected exactly one DOMPurify package in the bundle (node_modules/dompurify), found: ${purifyPackages.join(", ") || "none"}.`);
// The code of a DOMPurify instance sets its version and its list of removed nodes together; the licence comment is not looked at.
// (The version is a string in the code, or, if the minifier left it as a name, the pinned version must appear as a string in the bundle.)
const purifyCopies = [...text.matchAll(/\.version\s*=\s*(?:["']([0-9][^"']*)["']|[\w$]+)\s*[,;]\s*[\w$]+\.removed\s*=\s*\[\s*\]/g)];
if (purifyCopies.length !== 1) fail(`expected one copy of the DOMPurify code in the bundle, found ${purifyCopies.length}${purifyCopies.length ? ` (${purifyCopies.map((m) => m[1] || "version by name").join(", ")})` : ""}. The editor's own older copy must be gone.`);
const [, codeVersion] = purifyCopies[0];
if (codeVersion !== undefined && codeVersion !== pinned.dompurify) fail(`the DOMPurify code inside the bundle is ${codeVersion}, but package-lock.json pins ${pinned.dompurify}.`);
if (codeVersion === undefined && !text.includes(`"${pinned.dompurify}"`) && !text.includes(`'${pinned.dompurify}'`)) fail(`the pinned DOMPurify version ${pinned.dompurify} does not appear in the bundle's code.`);
// The old inlined copy (2.3.3) must be gone, and the beacon call too. (A licence comment for the old copy may remain at the end of the file.)
if (/version\s*=\s*["']2\.3\.3["']/.test(text)) fail("the old DOMPurify 2.3.3 code is still inside the bundle.");
if (/UA-129966929-1/.test(text)) fail("the Toast UI usage-statistics code is still in the bundle.");
// The sanitizer must be reachable from the page script.
if (!/EditorPurify\s*=/.test(text)) fail("window.EditorPurify is not set by the bundle.");

// ---------- Script and stylesheet: both are covered by recorded hashes ----------

const dist = path.join(ROOT, "node_modules", "@toast-ui", "editor", "dist");
const css = Buffer.from([fs.readFileSync(path.join(dist, "toastui-editor.css"), "utf8"), fs.readFileSync(path.join(dist, "theme", "toastui-editor-dark.css"), "utf8")].join(String.fromCharCode(10)));
const jsHash = sha256(bundle);
const cssHash = sha256(css);

if (args.has("--update")) {
  fs.writeFileSync(jsFile, bundle);
  fs.writeFileSync(cssFile, css);
  fs.writeFileSync(hashFile, `${jsHash}  toastui-editor.js  (@toast-ui/editor ${pinned["@toast-ui/editor"]}, dompurify ${pinned.dompurify}, esbuild ${pinned.esbuild})\n${cssHash}  toastui-editor.css  (from @toast-ui/editor ${pinned["@toast-ui/editor"]}: toastui-editor.css and theme/toastui-editor-dark.css)\n`);
  console.log(`Recorded sha256 ${jsHash} (script) and ${cssHash} (stylesheet)`);
} else {
  if (!recorded("toastui-editor.js") || !recorded("toastui-editor.css")) fail("no recorded hash for the script or the stylesheet (assets/vendor/toastui-editor.sha256). Run: npm run build:editor -- --update");
  if (recorded("toastui-editor.js") !== jsHash) fail(`the build differs from the recorded hash.\n  recorded ${recorded("toastui-editor.js")}\n  built    ${jsHash}\nIf you upgraded a dependency on purpose, run: npm run build:editor -- --update`);
  if (recorded("toastui-editor.css") !== cssHash) fail(`the stylesheet differs from its recorded hash.\n  recorded ${recorded("toastui-editor.css")}\n  built    ${cssHash}\nIf you upgraded @toast-ui/editor on purpose, run: npm run build:editor -- --update`);
  fs.writeFileSync(jsFile, bundle);
  fs.writeFileSync(cssFile, css);
}
console.log(`Built ${path.relative(ROOT, out)}/toastui-editor.js (${jsHash.slice(0, 12)}…) and toastui-editor.css (${cssHash.slice(0, 12)}…)`);
