// The software's own name and version, shown in the admin and the optional footer credit. Each blog's own name comes
// from Settings. PRODUCT_NAME lets a reseller with a commercial licence show their own product name instead.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const custom = String(process.env.PRODUCT_NAME ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);

export const PRODUCT = Object.freeze({ name: custom || "Quillo", version: pkg.version });
