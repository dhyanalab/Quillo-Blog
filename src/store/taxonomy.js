// Categories (one per post, nestable) and tags (many per post), plus redirects.
import { bind, now, transaction } from "../db.js";
import { slugify } from "../render/util.js";
import { likeContains } from "./sql.js";

const MAX_TAG_NAME = 60;
const MAX_TAGS = 2000;
const PUBLIC = "p.status = 'published' AND p.published_at <= :now AND p.type = 'post'";

function table(db, name, fields, { onChange, countSql }) {
  const store = {
    get: (id) => (id ? db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id) || null : null),
    getBySlug: (slug) => db.prepare(`SELECT * FROM ${name} WHERE slug = ?`).get(slug) || null,
    list: () => db.prepare(`SELECT t.*, (${countSql}) AS post_count FROM ${name} t ORDER BY ${name === "categories" ? "t.sort, t.name" : "t.name"}`).all({ now: now() }),
    slugTaken: (slug, excludeId = 0) => Boolean(db.prepare(`SELECT 1 FROM ${name} WHERE slug = ? AND id != ?`).get(slug, excludeId)),
    save(input, id = 0) {
      const values = Object.fromEntries(fields.map((f) => [f, input[f] ?? (f === "sort" || f === "show_on_home" ? 0 : f === "parent_id" ? null : "")]));
      if (name === "tags") values.name = String(values.name).slice(0, MAX_TAG_NAME);
      if (name === "categories") {
        const problem = store.parentProblem(id, values.parent_id);
        if (problem) throw new Error(problem);
      }
      if (id) {
        db.prepare(`UPDATE ${name} SET ${fields.map((f) => `${f} = :${f}`).join(", ")} WHERE id = :id`).run(bind({ ...values, id }));
      } else {
        const info = db.prepare(`INSERT INTO ${name} (${fields.join(", ")}, created_at) VALUES (${fields.map((f) => `:${f}`).join(", ")}, :at)`).run(bind({ ...values, at: now() }));
        id = Number(info.lastInsertRowid);
      }
      onChange();
      return store.get(id);
    },
    // Why a category can't have this parent ("" when it can): categories nest one level deep.
    parentProblem(id, parentId) {
      if (!parentId) return "";
      if (id && Number(parentId) === Number(id)) return "A category can't be its own parent.";
      const parent = db.prepare("SELECT parent_id FROM categories WHERE id = ?").get(parentId);
      if (!parent) return "That parent category doesn't exist.";
      if (parent.parent_id) return "Categories can only go one level deep.";
      if (id && db.prepare("SELECT 1 FROM categories WHERE parent_id = ? LIMIT 1").get(id)) return "This category has sub-categories, so it can't become one itself.";
      return "";
    },
    remove(id) {
      db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(id);
      onChange();
    },
  };
  return store;
}

export function createTaxonomyStore(db, { onChange }) {
  const categories = table(db, "categories", ["name", "slug", "description", "intro_md", "seo_title", "parent_id", "sort", "show_on_home"], {
    onChange,
    countSql: `SELECT COUNT(*) FROM posts p WHERE p.category_id = t.id AND ${PUBLIC}`,
  });
  const tags = table(db, "tags", ["name", "slug", "description"], {
    onChange,
    countSql: `SELECT COUNT(*) FROM post_tags pt JOIN posts p ON p.id = pt.post_id WHERE pt.tag_id = t.id AND ${PUBLIC}`,
  });

  // Finds tags by name. With `{ create: true}` new names become tags (up to 20 names per call, 60 characters each,
  // and never past MAX_TAGS tags in all); otherwise unknown names are only reported.
  // Returns { tags, unknown }. Called without options (older callers) it creates as before and returns the tags array.
  tags.ensure = (names, options) => {
    const legacy = options === undefined;
    const create = legacy || Boolean(options.create);
    const found = [];
    const unknown = [];
    const seen = new Set();
    for (const raw of [...new Set(names.map((n) => String(n).trim().slice(0, MAX_TAG_NAME)).filter(Boolean))].slice(0, 20)) {
      const slug = slugify(raw);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      let tag = tags.getBySlug(slug);
      if (!tag && create && db.prepare("SELECT COUNT(*) AS n FROM tags").get().n < MAX_TAGS) tag = tags.save({ name: raw, slug, description: "" });
      if (tag) found.push(tag);
      else unknown.push(raw);
    }
    return legacy ? found : { tags: found, unknown };
  };

  return { categories, tags };
}


const MAX_AUTO_REDIRECTS = 2000; // automatic rows kept; the oldest go first
const LOOP_HOPS = 5;

// Would a redirect from -> to send visitors round in a circle? Follows the redirects that already exist from `to`, up to 5 hops.
export function redirectLoop(db, from, to) {
  let at = to;
  for (let hop = 0; hop < LOOP_HOPS; hop++) {
    if (at === from) return true;
    const row = db.prepare("SELECT to_path, status_code FROM redirects WHERE from_path = ?").get(at);
    if (!row || row.status_code === 410 || !row.to_path) return false;
    at = row.to_path;
  }
  return at === from;
}

// Keeps at most 2,000 automatic rows (the editor's own slug-change redirects); rows the owner made are never touched.
export function pruneAutoRedirects(db) {
  db.prepare(`DELETE FROM redirects WHERE source = 'auto' AND id NOT IN
              (SELECT id FROM redirects WHERE source = 'auto' ORDER BY created_at DESC, id DESC LIMIT ${MAX_AUTO_REDIRECTS})`).run();
}

export function createRedirectStore(db, { onChange }) {
  const page = ({ limit = 100, offset = 0, q = "", source = "" } = {}) => {
    const where = [];
    const params = {};
    if (q) (where.push("(from_path LIKE :q ESCAPE '\\' OR to_path LIKE :q ESCAPE '\\')"), (params.q = likeContains(q)));
    if (source) (where.push("source = :source"), (params.source = source));
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return {
      rows: db.prepare(`SELECT * FROM redirects ${w} ORDER BY from_path LIMIT :limit OFFSET :offset`).all({ ...params, limit, offset }),
      total: db.prepare(`SELECT COUNT(*) AS n FROM redirects ${w}`).get(params).n,
    };
  };
  const store = {
    // The redirects, by address. Capped (5,000 by default); use `page` for the admin list.
    list: ({ limit = 5000, offset = 0, q = "", source = "" } = {}) => page({ limit, offset, q, source }).rows,
    // One page of the list with the total: { rows, total }. Filter by text (`q`) or by who made it (`source`: "admin" or "auto").
    page,
    get: (id) => db.prepare("SELECT * FROM redirects WHERE id = ?").get(id) || null,
    find: (from) => db.prepare("SELECT * FROM redirects WHERE from_path = ?").get(from) || null,
    getByPath: (from) => store.find(from),
    // The hit counter is sampled (one write per ten visits, counted as ten), so a busy old URL isn't a write per request.
    hit: (id) => (Math.random() < 0.1 ? db.prepare("UPDATE redirects SET hits = hits + 10 WHERE id = ?").run(id) : undefined),
    // Saves a redirect. `source` says who made it: "admin" (the owner, the default) or "auto" (a slug rename).
    // - An "auto" save never overwrites or deletes an "admin" row: it returns { skipped: true }.
    // - A save that would send visitors round in a circle (within 5 hops) throws an Error with code "LOOP".
    // - Automatic rows are trimmed to the newest 2,000.
    save({ from_path, to_path, status_code = 301, source = "admin" }) {
      if (![301, 302, 410].includes(status_code)) throw new Error("Unknown redirect type");
      if (source !== "admin" && source !== "auto") throw new Error("Unknown redirect source");
      if (status_code !== 410 && from_path === to_path) throw new Error("A redirect can't point at itself");
      const result = transaction(db, () => {
        const existing = store.find(from_path);
        if (source === "auto" && existing?.source === "admin") return { skipped: true };
        if (status_code !== 410) {
          // A page that now exists at the target must not redirect back to where it came from (only an automatic row is dropped).
          db.prepare("DELETE FROM redirects WHERE from_path = ? AND source = 'auto'").run(to_path);
          if (redirectLoop(db, from_path, to_path)) throw Object.assign(new Error("That would send visitors round in a circle."), { code: "LOOP" });
        }
        db.prepare(`INSERT INTO redirects (from_path, to_path, status_code, source, created_at) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(from_path) DO UPDATE SET to_path = excluded.to_path, status_code = excluded.status_code, source = excluded.source`)
          .run(from_path, status_code === 410 ? "" : to_path, status_code, source, now());
        if (status_code !== 410) {
          // Point older redirects at the new target, so there are no chains. Automatic saves touch only automatic rows.
          db.prepare(`UPDATE redirects SET to_path = ? WHERE to_path = ? AND from_path != ? ${source === "auto" ? "AND source = 'auto'" : ""}`).run(to_path, from_path, from_path);
        }
        if (source === "auto") pruneAutoRedirects(db);
        return { skipped: false };
      });
      if (!result.skipped) onChange();
      return result;
    },
    remove(id) {
      db.prepare("DELETE FROM redirects WHERE id = ?").run(id);
      onChange();
    },
    removeFrom: (from) => db.prepare("DELETE FROM redirects WHERE from_path = ?").run(from),
  };
  return store;
}
