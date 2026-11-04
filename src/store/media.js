import { bind, now } from "../db.js";
import { likeContains, nextId } from "./sql.js";

// A picture's address without its extension. The resized copies (name-640.webp) start with it too, so one search covers them all.
const stemOf = (p) => String(p).replace(/\.[^./]+$/, "");

const hydrate = (row) => (row ? { ...row, variants: JSON.parse(row.variants || "{}") } : null);

export function createMediaStore(db, { onChange }) {
  const store = {
    get: (id) => (id ? hydrate(db.prepare("SELECT * FROM media WHERE id = ?").get(id)) : null),
    getByPath: (p) => hydrate(db.prepare("SELECT * FROM media WHERE path = ?").get(p)),
    count: () => db.prepare("SELECT COUNT(*) AS n FROM media").get().n,
    // uploadedBy limits the list to one person's files (people below editor see only their own).
    list({ limit = 48, offset = 0, q = "", kind = "", uploadedBy = null } = {}) {
      const where = [];
      if (q) where.push("(original_name LIKE :q ESCAPE '\\' OR alt LIKE :q ESCAPE '\\')");
      if (kind) where.push("kind = :kind");
      if (uploadedBy != null) where.push("uploaded_by = :uploadedBy");
      const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return db.prepare(`SELECT * FROM media ${w} ORDER BY id DESC LIMIT :limit OFFSET :offset`).all(bind({ limit, offset, ...(q ? { q: likeContains(q) } : {}), ...(kind ? { kind } : {}), ...(uploadedBy != null ? { uploadedBy } : {}) })).map(hydrate);
    },
    insert(m, userId) {
      const info = db
        .prepare(`INSERT INTO media (id, path, original_name, mime, width, height, size, alt, variants, kind, uploaded_by, created_at)
                  VALUES (${nextId("media")}, :path, :original_name, :mime, :width, :height, :size, :alt, :variants, :kind, :uploaded_by, :at)`)
        .run(bind({ width: null, height: null, ...m, alt: m.alt || "", variants: JSON.stringify(m.variants || {}), kind: m.kind || "image", uploaded_by: userId, at: now() }));
      return store.get(Number(info.lastInsertRowid));
    },
    // Alt text is capped at 300 characters. A missing value leaves the text as it was, and the page cache is
    // flushed only when the text really changed.
    setAlt(id, alt) {
      if (alt === undefined || alt === null) return;
      const next = String(alt).trim().slice(0, 300);
      const done = db.prepare("UPDATE media SET alt = ? WHERE id = ? AND alt != ?").run(next, id, next);
      if (done.changes) onChange();
    },
    // The file made from exactly these input bytes, if it is already in the library. `key` is the 16-hex SHA-256 prefix of the
    // input that the stored name carries (inputKey() in render/media.js), so no encoding is needed to find a duplicate.
    findByInputKey(key) {
      if (!/^[0-9a-f]{16}$/.test(String(key))) return null;
      return hydrate(db.prepare("SELECT * FROM media WHERE instr(path, ?) > 0 ORDER BY id LIMIT 1").get(`-${key}.`));
    },
    // True when something public uses the picture: a published post or page (feature or social image, a download, or the
    // text), a category intro, the site settings (logo, default social image), a staff profile, or a live banner.
    isPublic(id) {
      const m = store.get(id);
      if (!m) return false;
      const t = now();
      const stem = stemOf(m.path);
      const row = db
        .prepare(`SELECT 1 AS yes WHERE EXISTS (
                    SELECT 1 FROM posts WHERE status = 'published' AND published_at IS NOT NULL AND published_at <= :t AND (
                      feature_image_id = :id OR og_image_id = :id OR instr(body_md, :stem) > 0
                      OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(posts.downloads) THEN posts.downloads ELSE '{}' END, '$.files') f WHERE json_extract(f.value, '$.media_id') = :id)))
                  OR EXISTS (SELECT 1 FROM categories WHERE instr(intro_md, :stem) > 0)
                  OR EXISTS (SELECT 1 FROM settings WHERE key IN ('logo_id', 'default_og_image_id') AND value = :idText)
                  OR EXISTS (SELECT 1 FROM users WHERE photo_id = :id)
                  OR EXISTS (SELECT 1 FROM ads WHERE active = 1 AND (image_id = :id OR mobile_image_id = :id) AND (starts_at IS NULL OR starts_at <= :t) AND (ends_at IS NULL OR ends_at >= :t))`)
        .get({ id: m.id, idText: String(m.id), stem, t });
      return Boolean(row);
    },
    // Where a file is used, so it isn't deleted while a page still shows it.
    usage(m) {
      const stem = stemOf(m.path);
      const posts = db
        .prepare(`SELECT id, title, type FROM posts WHERE feature_image_id = :id OR og_image_id = :id
                  OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(posts.downloads) THEN posts.downloads ELSE '{}' END, '$.files') f WHERE json_extract(f.value, '$.media_id') = :id)
                  OR instr(body_md, :stem) > 0`)
        .all({ id: m.id, stem });
      // Older versions of posts, category intros and newsletters count too: deleting the file would break them
      // (a restored revision, an archived newsletter). They are also listed in `posts`, tagged in the title, so a
      // delete check that only reads posts/users/ads/settings still refuses.
      // The text is searched for the picture's address without its extension, so a link to a resized copy counts as well.
      const categories = db.prepare("SELECT id, name FROM categories WHERE instr(intro_md, :stem) > 0").all({ stem });
      const newsletters = db.prepare("SELECT id, subject FROM newsletters WHERE instr(body_md, :stem) > 0").all({ stem });
      const liveIds = new Set(posts.map((p) => p.id));
      const revisions = db
        .prepare(`SELECT DISTINCT p.id, p.title, p.type FROM revisions r JOIN posts p ON p.id = r.post_id WHERE instr(r.body_md, :stem) > 0`)
        .all({ stem })
        .filter((p) => !liveIds.has(p.id));
      const extra = [
        ...categories.map((c) => ({ id: c.id, title: `${c.name} (category intro)`, type: "category" })),
        ...newsletters.map((n) => ({ id: n.id, title: `${n.subject || "Untitled"} (newsletter)`, type: "newsletter" })),
        ...revisions.map((p) => ({ id: p.id, title: `${p.title || "Untitled"} (older version)`, type: "revision" })),
      ];
      const users = db.prepare("SELECT id, name FROM users WHERE photo_id = ?").all(m.id);
      const ads = db.prepare("SELECT id, name FROM ads WHERE image_id = ? OR mobile_image_id = ?").all(m.id, m.id);
      const settings = db.prepare("SELECT key FROM settings WHERE key IN ('logo_id', 'default_og_image_id') AND value = ?").all(String(m.id));
      return { posts: [...posts, ...extra], users, ads, settings: settings.map((s) => s.key), categories, newsletters, revisions };
    },
    remove(id) {
      db.prepare("DELETE FROM media WHERE id = ?").run(id);
      onChange();
    },
  };
  return store;
}
