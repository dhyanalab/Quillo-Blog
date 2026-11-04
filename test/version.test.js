// The version is written in VERSION, package.json and package-lock.json, and every release has a CHANGELOG section.
// Run: node --test test/version.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const version = read("VERSION").trim();

test("VERSION holds a plain major.minor.patch version", () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test("package.json and package-lock.json carry the same version (npm run set-version keeps them in step)", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(pkg.version, version);
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);
});

test("the README version badge shows it", () => {
  assert.ok(read("README.md").includes(`badge/version-${version}-`), "README.md badge is out of date: run npm run set-version");
});

test("the release is described in CHANGELOG.md", () => {
  assert.ok(read("CHANGELOG.md").includes(`## [${version}]`), `CHANGELOG.md needs a "## [${version}]" section`);
});
