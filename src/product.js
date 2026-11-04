// The software's own name and version, shown in the admin. Each blog's own name comes from Settings.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

export const PRODUCT = Object.freeze({ name: "Quillo", version: pkg.version });
