// Sets Quillo's version everywhere it is written: VERSION, package.json, package-lock.json and the README badge.
//   npm run set-version -- 1.0.0
// Then add the release to CHANGELOG.md, commit, and tag it: git tag -a v1.0.0 -m "Quillo 1.0.0"
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next ?? "")) {
  console.error("Usage: npm run set-version -- <major.minor.patch>, for example 1.0.0");
  process.exit(1);
}

const file = (name) => path.join(ROOT, name);
const json = (name, update) => {
  const data = JSON.parse(fs.readFileSync(file(name), "utf8"));
  update(data);
  fs.writeFileSync(file(name), JSON.stringify(data, null, 2) + "\n");
};

const before = fs.readFileSync(file("VERSION"), "utf8").trim();
fs.writeFileSync(file("VERSION"), `${next}\n`);
json("package.json", (p) => (p.version = next));
json("package-lock.json", (l) => {
  l.version = next;
  if (l.packages?.[""]) l.packages[""].version = next;
});
const readme = fs.readFileSync(file("README.md"), "utf8");
fs.writeFileSync(file("README.md"), readme.replace(/badge\/version-\d+\.\d+\.\d+-/, `badge/version-${next}-`));
console.log(`Version ${before} -> ${next} in VERSION, package.json, package-lock.json and the README badge.`);
if (!fs.readFileSync(file("CHANGELOG.md"), "utf8").includes(`## [${next}]`)) console.log(`Remember: add a "## [${next}]" section to CHANGELOG.md.`);
