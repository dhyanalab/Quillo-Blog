// Posts and pages. A published post with a future published_at is "scheduled" and stays hidden until then.
import { bind, now, transaction } from "../db.js";
import { countWords, ftsQuery } from "../render/util.js";
import { likeContains } from "./sql.js";
import { pruneAutoRedirects, redirectLoop } from "./taxonomy.js";

const JSON_FIELDS = { at_a_glance: [], tested_with: [], video: {}, downloads: {}, source_files: [] };

export const POST_FIELDS = [
  "type", "status", "title", "slug", "body_md", "excerpt", "seo_title", "short_title", "canonical_url", "noindex",
  "og_title", "og_description", "og_image_id", "feature_image_id", "feature_image_alt", "feature_image_caption",
  "author_id", "category_id", "accent", "kind", "level",
  "quick_answer", "at_a_glance", "tested_with", "video", "downloads", "source_files", "comments_enabled", "featured",
  "published_at", "updated_at",
];

const POST_DEFAULTS = {
  type: "post", status: "draft", title: "", body_md: "", excerpt: "", seo_title: "", short_title: "", canonical_url: "", noindex: false,
  og_title: "", og_description: "", og_image_id: null, feature_image_id: null, feature_image_alt: "", feature_image_caption: "",
  category_id: null, accent: "", kind: "", level: null, quick_answer: "",
  comments_enabled: true, featured: false, published_at: null, updated_at: null,
};

// Fields whose change counts as a content update (moves the public "Updated" date).
const CONTENT_FIELDS = ["title", "body_md", "excerpt", "quick_answer", "at_a_glance", "tested_with", "downloads", "source_files", "video"];

export const RESERVED_SLUGS = new Set(["admin", "category", "tag", "tags", "authors", "author", "search", "page", "media", "assets", "og", "rss.xml", "feed", "sitemap.xml", "robots.txt", "subscribe", "preview", "latest", "signin", "signup", "signout", "account", "comments", "members", "files", "k", "unsubscribe", "newsletter", "forgot", "reset", "verify", "confirm", "rss", "index", "login", "logout", "static"]);

const PUBLIC = "p.status = 'published' AND p.published_at IS NOT NULL AND p.published_at <= :now";

function hydrate(row) {
  if (!row) return null;
  const post = { ...row };
  for (const [k, empty] of Object.entries(JSON_FIELDS)) {
    try {
      post[k] = JSON.parse(row[k] || "null") ?? empty;
    } catch {
      post[k] = empty;
    }
  }
  post.noindex = Boolean(row.noindex);
  post.featured = Boolean(row.featured);
  post.comments_enabled = row.comments_enabled === undefined ? true : Boolean(row.comments_enabled);
  const t = now();
  post.isPublic = row.status === "published" && Boolean(row.published_at) && row.published_at <= t;
  post.isScheduled = row.status === "published" && Boolean(row.published_at) && row.published_at > t;
  post.state = post.isScheduled ? "scheduled" : row.status;
  // Was it ever on the site? (An unpublished post keeps its published_at.)
  post.everPublished = row.status === "published" || Boolean(row.published_at);
  return post;
}

const serialize = (key, value) => (key in JSON_FIELDS ? JSON.stringify(value ?? JSON_FIELDS[key]) : value);

export function createPostStore(db, { onChange, basePath }) {
  const urlFor = (slug) => `${basePath}/${slug}/`;

  // A post and a page may never share a slug (one URL space). A database from before that rule, or restored from an
  // older copy, can still hold such a pair, which makes every save of either abort. Report it and rename the extra one
  // (the published one keeps the slug; otherwise the lower id does).
  for (const { slug } of db.prepare("SELECT slug FROM posts GROUP BY slug HAVING COUNT(*) > 1").all()) {
    const rows = db.prepare("SELECT id, type FROM posts WHERE slug = ? ORDER BY (status = 'published') DESC, id").all(slug);
    for (const row of rows.slice(1)) {
      let next = `${slug}-${row.type}`;
      for (let n = 2; db.prepare("SELECT 1 FROM posts WHERE slug = ?").get(next) || RESERVED_SLUGS.has(next); n++) next = `${slug}-${row.type}-${n}`;
      db.prepare("UPDATE posts SET slug = ? WHERE id = ?").run(next, row.id);
      console.warn(`Warning: a post and a page both used the address "${slug}". The ${row.type} (id ${row.id}) is now "${next}"; check it in the admin.`);
    }
  }

  const store = {
    get: (id) => hydrate(db.prepare("SELECT * FROM posts WHERE id = ?").get(id)),
    getBySlug: (type, slug) => hydrate(db.prepare("SELECT * FROM posts WHERE type = ? AND slug = ?").get(type, slug)),
    getPublicBySlug: (slug) => hydrate(db.prepare(`SELECT * FROM posts p WHERE p.slug = :slug AND ${PUBLIC}`).get({ slug, now: now() })),

    // True when a post or page already uses the slug (they share the /<base>/<slug>/ URL space).
    slugTaken(slug, { excludeId = 0 } = {}) {
      if (RESERVED_SLUGS.has(slug)) return true;
      return Boolean(db.prepare("SELECT 1 FROM posts WHERE slug = ? AND id != ?").get(slug, excludeId));
    },
    uniqueSlug(base, excludeId = 0) {
      const root = base || "untitled";
      let slug = root;
      for (let n = 2; store.slugTaken(slug, { excludeId }); n++) slug = `${root}-${n}`;
      return slug;
    },

    // Admin list, newest change first.
    listAdmin({ type = "post", state = "", authorId = 0, categoryId = 0, q = "", limit = 30, offset = 0 } = {}) {
      const where = ["p.type = :type"];
      const params = { type, limit, offset };
      if (state === "draft") where.push("p.status = 'draft'");
      if (state === "published") where.push(`p.status = 'published' AND p.published_at <= :now`);
      if (state === "scheduled") where.push(`p.status = 'published' AND p.published_at > :now`);
      if (state === "published" || state === "scheduled") params.now = now();
      if (authorId) (where.push("p.author_id = :authorId"), (params.authorId = authorId));
      if (categoryId) (where.push("p.category_id = :categoryId"), (params.categoryId = categoryId));
      if (q) (where.push("p.title LIKE :q ESCAPE '\\'"), (params.q = likeContains(q)));
      const sql = `FROM posts p WHERE ${where.join(" AND ")}`;
      const { limit: _l, offset: _o, ...countParams } = params;
      return {
        rows: db.prepare(`SELECT p.* ${sql} ORDER BY p.modified_at DESC LIMIT :limit OFFSET :offset`).all(bind(params)).map(hydrate),
        total: db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(bind(countParams)).n,
      };
    },

    counts(type = "post") {
      const t = now();
      return db.prepare(`SELECT
          SUM(status = 'draft') AS draft,
          SUM(status = 'published' AND published_at <= :t) AS published,
          SUM(status = 'published' AND published_at > :t) AS scheduled,
          COUNT(*) AS total FROM posts WHERE type = :type`).get({ t, type });
    },

    // Public lists. Filters are optional; order is newest first unless `order` says otherwise.
    listPublic({ type = "post", categoryIds, excludeCategoryIds, tagId, authorId, featured, excludeIds = [], order = "new", limit = 12, offset = 0 } = {}) {
      const { sql, params } = publicFilter({ type, categoryIds, excludeCategoryIds, tagId, authorId, featured, excludeIds });
      const orderBy = order === "popular" ? "p.views DESC, p.published_at DESC" : "p.published_at DESC, p.id DESC";
      return db.prepare(`SELECT p.* ${sql} ORDER BY ${orderBy} LIMIT :limit OFFSET :offset`).all(bind({ ...params, limit, offset })).map(hydrate);
    },
    countPublic(filters = {}) {
      const { sql, params } = publicFilter({ type: "post", ...filters });
      return db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(bind(params)).n;
    },

    // Same category or shared tags first, then the newest posts to fill up.
    related(post, limit = 3) {
      const rows = db
        .prepare(`SELECT p.*, (SELECT COUNT(*) FROM post_tags a JOIN post_tags b ON a.tag_id = b.tag_id WHERE a.post_id = p.id AND b.post_id = :id) AS shared
                  FROM posts p WHERE ${PUBLIC} AND p.type = 'post' AND p.id != :id
                  ORDER BY shared DESC, (p.category_id IS :cat) DESC, p.published_at DESC LIMIT :limit`)
        .all(bind({ id: post.id, cat: post.category_id, limit, now: now() }));
      return rows.map(hydrate);
    },

    // The source files of a published post (not a page), with only the columns a download needs.
    // Returns { id, slug, type, source_files } or null. (Narrow on purpose: no body, no other JSON columns.)
    getPublicSourceFiles(slug) {
      const row = db.prepare(`SELECT p.id, p.slug, p.type, p.source_files FROM posts p WHERE p.slug = :slug AND p.type = 'post' AND ${PUBLIC}`).get({ slug: String(slug), now: now() });
      if (!row) return null;
      let files = [];
      try {
        files = JSON.parse(row.source_files || "[]");
      } catch {}
      return { id: row.id, slug: row.slug, type: row.type, source_files: Array.isArray(files) ? files : [] };
    },

    // Full-text search. `total` counts at most `maxCount` matches (default 500), so a broad query can't make the count scan without end.
    search(q, { limit = 12, offset = 0, maxCount = 500 } = {}) {
      const match = ftsQuery(q);
      if (!match) return { rows: [], total: 0 };
      const base = `FROM posts_fts f JOIN posts p ON p.id = f.rowid WHERE posts_fts MATCH :match AND ${PUBLIC} AND p.noindex = 0`;
      const params = { match, now: now() };
      return {
        rows: db.prepare(`SELECT p.* ${base} ORDER BY bm25(posts_fts, 10.0, 4.0, 1.0) LIMIT :limit OFFSET :offset`).all({ ...params, limit, offset }).map(hydrate),
        total: db.prepare(`SELECT COUNT(*) AS n FROM (SELECT p.id ${base} LIMIT :maxCount)`).get({ ...params, maxCount }).n,
      };
    },

    tagsFor: (id) => db.prepare("SELECT t.* FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = ? ORDER BY pt.sort").all(id),

    // Saves a post. `input` holds POST_FIELDS (already validated) plus `tags` (array of tag ids).
    // Options come as `save(input, { id, userId, keepUpdatedDate, ifUpdatedAt })` or `save(input, id, { userId, ... })`.
    // `ifUpdatedAt`: the value the editor loaded (the post's modified_at, or its updated_at). When the stored post has changed since,
    // nothing is saved and an Error with code "CONFLICT" is thrown, so a stale editor tab can't overwrite someone else's save.
    save(input, second = {}, third = {}) {
      const opts = typeof second === "number" ? { ...third, id: second } : { ...second, ...third };
      let { id = 0 } = opts;
      const { userId, keepUpdatedDate = false, ifUpdatedAt } = opts;
      const before = id ? store.get(id) : null;
      if (id && !before) throw new Error("Post not found");
      if (before && ifUpdatedAt && ifUpdatedAt !== before.modified_at && ifUpdatedAt !== before.updated_at) {
        throw Object.assign(new Error("Someone else saved this post a moment ago."), { code: "CONFLICT" });
      }
      const t = now();
      const next = { ...POST_DEFAULTS, ...(before || {}), ...input };
      for (const [k, empty] of Object.entries(JSON_FIELDS)) next[k] ??= empty;

      if (next.status === "published" && !next.published_at) next.published_at = t;

      const wasLive = before?.isPublic;
      const contentChanged = !before || CONTENT_FIELDS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
      if (next.status === "published") {
        if (!before || before.status !== "published" || !before.updated_at) next.updated_at = next.published_at;
        else if (input.updated_at) next.updated_at = input.updated_at;
        else if (wasLive && contentChanged && !keepUpdatedDate) next.updated_at = t > next.published_at ? t : next.published_at;
        if (next.updated_at < next.published_at) next.updated_at = next.published_at;
      }

      const values = Object.fromEntries(POST_FIELDS.map((k) => [k, serialize(k, next[k])]));
      values.word_count = countWords(next.body_md);
      values.modified_at = t;

      const nextLive = next.status === "published" && Boolean(next.published_at) && next.published_at <= t;
      const saved = transaction(db, () => {
        if (before) {
          db.prepare(`UPDATE posts SET ${[...POST_FIELDS, "word_count", "modified_at"].map((k) => `${k} = :${k}`).join(", ")} WHERE id = :id`).run(bind({ ...values, id }));
        } else {
          // Ids are never reused: take the next one above the highest id ever used, even if that post was deleted.
          const floor = db.prepare("SELECT max_id FROM posts_id_floor WHERE id = 1").get()?.max_id ?? 0;
          const top = db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM posts").get().n;
          id = Math.max(floor, top) + 1;
          const cols = ["id", ...POST_FIELDS, "word_count", "modified_at", "created_at"];
          db.prepare(`INSERT INTO posts (${cols.join(", ")}) VALUES (${cols.map((c) => `:${c}`).join(", ")})`).run(bind({ ...values, id, created_at: t }));
        }

        if (Array.isArray(input.tags)) {
          db.prepare("DELETE FROM post_tags WHERE post_id = ?").run(id);
          const ins = db.prepare("INSERT OR IGNORE INTO post_tags (post_id, tag_id, sort) VALUES (?, ?, ?)");
          input.tags.forEach((tagId, i) => ins.run(id, tagId, i));
        }

        db.prepare("DELETE FROM posts_fts WHERE rowid = ?").run(id);
        db.prepare("INSERT INTO posts_fts (rowid, title, excerpt, body) VALUES (?, ?, ?, ?)").run(id, next.title || "", next.excerpt || "", next.body_md || "");

        const last = db.prepare("SELECT title, body_md FROM revisions WHERE post_id = ? ORDER BY id DESC LIMIT 1").get(id);
        if (!last || last.title !== next.title || last.body_md !== next.body_md) {
          db.prepare("INSERT INTO revisions (post_id, title, body_md, author_id, created_at) VALUES (?, ?, ?, ?, ?)").run(id, next.title || "", next.body_md || "", userId ?? null, t);
          db.prepare("DELETE FROM revisions WHERE post_id = ? AND id NOT IN (SELECT id FROM revisions WHERE post_id = ? ORDER BY id DESC LIMIT 30)").run(id, id);
        }

        // A post that is live at its URL takes over any automatic redirect left there. Drafts leave redirects alone.
        if (nextLive) db.prepare("DELETE FROM redirects WHERE from_path = ? AND source = 'auto'").run(urlFor(next.slug));
        // A live post that changes slug and stays live keeps its old URL working with a 301. Only rows the editor made itself
        // ('auto') are touched: a redirect or 410 the owner added by hand is never overwritten or deleted here.
        // No redirect is made when it would form a loop with another redirect, or when the post stops being live in the same save
        // (a redirect would reveal the new address of something that is no longer public).
        if (wasLive && nextLive && before.slug !== next.slug && !redirectLoop(db, urlFor(before.slug), urlFor(next.slug))) {
          db.prepare(`INSERT INTO redirects (from_path, to_path, status_code, source, created_at) VALUES (?, ?, 301, 'auto', ?)
                      ON CONFLICT(from_path) DO UPDATE SET to_path = excluded.to_path, status_code = 301 WHERE redirects.source = 'auto'`).run(urlFor(before.slug), urlFor(next.slug), t);
          db.prepare("UPDATE redirects SET to_path = ? WHERE to_path = ? AND source = 'auto'").run(urlFor(next.slug), urlFor(before.slug));
          pruneAutoRedirects(db);
        }
        // A post that stops being live (unpublished, or moved to a future date) takes the automatic redirects that lead to it away.
        if (wasLive && !nextLive) {
          db.prepare("DELETE FROM redirects WHERE source = 'auto' AND to_path IN (?, ?)").run(urlFor(before.slug), urlFor(next.slug));
        }

        return store.get(id);
      });
      // Only changes that readers can see flush the page cache; saving a draft does not.
      if (wasLive || nextLive || next.status === "published" || before?.status === "published") onChange();
      return saved;
    },

    // Deleting a live post leaves a 410 Gone at its URL, so search engines drop it quickly.
    remove(id) {
      const post = store.get(id);
      if (!post) return;
      transaction(db, () => {
        db.prepare("DELETE FROM posts_fts WHERE rowid = ?").run(id);
        db.prepare("UPDATE posts SET next_post_id = NULL WHERE next_post_id = ?").run(id); // legacy column, still a foreign key
        db.prepare("DELETE FROM posts WHERE id = ?").run(id);
        if (post.isPublic) {
          // Only automatic rows are changed; a redirect the owner set by hand at this URL stays as it is.
          db.prepare(`INSERT INTO redirects (from_path, to_path, status_code, source, created_at) VALUES (?, '', 410, 'auto', ?)
                      ON CONFLICT(from_path) DO UPDATE SET to_path = '', status_code = 410 WHERE redirects.source = 'auto'`).run(urlFor(post.slug), now());
          db.prepare("UPDATE redirects SET to_path = '', status_code = 410 WHERE to_path = ? AND source = 'auto'").run(urlFor(post.slug));
          pruneAutoRedirects(db);
        }
      });
      if (post.status === "published") onChange(); // a draft never showed on the site
      return post;
    },

    revisions: (id) => db.prepare("SELECT r.id, r.title, r.created_at, u.name AS author_name, length(r.body_md) AS size FROM revisions r LEFT JOIN users u ON u.id = r.author_id WHERE r.post_id = ? ORDER BY r.id DESC").all(id),
    revision: (postId, revId) => db.prepare("SELECT * FROM revisions WHERE post_id = ? AND id = ?").get(postId, revId) || null,
    // Purging: an older version that holds something that must not be kept (a pasted password or key) can be removed.
    // `deleteRevision` removes one; `purgeRevisions` removes every version but the newest `keep` (default: only the newest, which is
    // the version the post has now). Both return how many were removed.
    deleteRevision: (postId, revId) => Number(db.prepare("DELETE FROM revisions WHERE post_id = ? AND id = ?").run(postId, revId).changes),
    purgeRevisions: (postId, { keep = 1 } = {}) =>
      Number(db.prepare("DELETE FROM revisions WHERE post_id = ? AND id NOT IN (SELECT id FROM revisions WHERE post_id = ? ORDER BY id DESC LIMIT ?)").run(postId, postId, Math.max(0, Math.floor(keep))).changes),

    addView: (id) => db.prepare("UPDATE posts SET views = views + 1 WHERE id = ?").run(id),

    // Earliest scheduled post that is still in the future, for the scheduler.
    nextScheduledAt: () => db.prepare("SELECT MIN(published_at) AS at FROM posts WHERE status = 'published' AND published_at > ?").get(now()).at,
    // Posts that went live between two instants (scheduled posts reaching their time).
    // Only what the scheduler needs (id, slug, type), not whole posts.
    wentLiveBetween: (from, to) => db.prepare("SELECT id, slug, type FROM posts WHERE status = 'published' AND published_at > ? AND published_at <= ?").all(from, to),

    // Everything public, for the sitemap.
    allPublic: () => db.prepare(`SELECT p.id, p.type, p.slug, p.title, p.updated_at, p.published_at, p.feature_image_id, p.feature_image_alt, p.noindex, p.canonical_url FROM posts p WHERE ${PUBLIC} ORDER BY p.published_at DESC`).all({ now: now() }),
  };

  function publicFilter({ type, categoryIds, excludeCategoryIds, tagId, authorId, featured, excludeIds = [] }) {
    const where = [PUBLIC, "p.type = :type"];
    const params = { type, now: now() };
    let join = "";
    // Id lists go in as JSON and are read with json_each, so nothing is spliced into the SQL.
    const ints = (list) => JSON.stringify(list.map(Number).filter(Number.isInteger));
    if (categoryIds?.length) (where.push("p.category_id IN (SELECT value FROM json_each(:categoryIds))"), (params.categoryIds = ints(categoryIds)));
    if (excludeCategoryIds?.length) (where.push("(p.category_id IS NULL OR p.category_id NOT IN (SELECT value FROM json_each(:excludeCategoryIds)))"), (params.excludeCategoryIds = ints(excludeCategoryIds)));
    if (tagId) (join = "JOIN post_tags pt ON pt.post_id = p.id AND pt.tag_id = :tagId"), (params.tagId = tagId);
    if (authorId) (where.push("p.author_id = :authorId"), (params.authorId = authorId));
    if (featured) where.push("p.featured = 1");
    if (excludeIds.length) (where.push("p.id NOT IN (SELECT value FROM json_each(:excludeIds))"), (params.excludeIds = ints(excludeIds)));
    return { sql: `FROM posts p ${join} WHERE ${where.join(" AND ")}`, params };
  }

  return store;
}
