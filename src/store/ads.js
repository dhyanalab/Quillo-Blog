// Sponsor banners: the places they can appear, the banners themselves and their daily views and clicks.
import { bind, now } from "../db.js";

// Every place a banner can appear, with the picture sizes to ask the sponsor for.
export const AD_PLACES = {
  top: { name: "Top of every page", where: "Under the menu bar on every page", size: "970 × 90 or 728 × 90", phone: "320 × 100", shape: "wide" },
  home_mid: { name: "Home page, middle", where: "Between the latest posts and the category rows", size: "970 × 90 or 728 × 90", phone: "320 × 100", shape: "wide" },
  sidebar: { name: "Sidebar", where: "In the sidebar of the home page and category pages, under News", size: "300 × 250 or 300 × 600", phone: "300 × 250", shape: "box" },
  list_top: { name: "Category pages", where: "Above the list of posts on category, tag and search pages", size: "728 × 90", phone: "320 × 100", shape: "wide" },
  article_top: { name: "Article, top", where: "Under the quick answer, before the article text", size: "728 × 90", phone: "320 × 100", shape: "wide" },
  article_mid: { name: "Article, middle", where: "Halfway through the article text (articles with 3 or more sections)", size: "728 × 90 or 300 × 250", phone: "300 × 250", shape: "wide" },
  article_side: { name: "Article, beside the text", where: "Under the contents list and share buttons, on computers only", size: "250 × 250 or 160 × 600", phone: "Not shown on phones", shape: "rail" },
  article_end: { name: "Article, end", where: "After the downloads, before the comments", size: "728 × 90", phone: "320 × 100", shape: "wide" },
  footer: { name: "Bottom of every page", where: "Above the footer on every page", size: "970 × 90 or 728 × 90", phone: "320 × 100", shape: "wide" },
};

const hydrate = (row) => {
  if (!row) return null;
  let places = [];
  try {
    places = JSON.parse(row.places || "[]").filter((p) => AD_PLACES[p]);
  } catch {}
  return { ...row, places, active: Boolean(row.active) };
};

// "running", "scheduled", "ended" or "paused" at time `t`.
export function adStatus(ad, t = now()) {
  if (!ad.active) return "paused";
  if (ad.starts_at && ad.starts_at > t) return "scheduled";
  if (ad.ends_at && ad.ends_at < t) return "ended";
  return "running";
}

export function createAdStore(db, { onChange }) {
  const store = {
    get: (id) => hydrate(db.prepare("SELECT * FROM ads WHERE id = ?").get(id)),

    // Every banner with its views and clicks over the last `days` days.
    list(days = 30) {
      const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
      return db.prepare(`SELECT a.*, COALESCE(SUM(s.views), 0) AS views, COALESCE(SUM(s.clicks), 0) AS clicks
                         FROM ads a LEFT JOIN ad_stats s ON s.ad_id = a.id AND s.day >= ?
                         GROUP BY a.id ORDER BY a.active DESC, a.id DESC`).all(since).map(hydrate);
    },
    totals: (id) => db.prepare("SELECT COALESCE(SUM(views), 0) AS views, COALESCE(SUM(clicks), 0) AS clicks FROM ad_stats WHERE ad_id = ?").get(id),
    daily: (id, days = 30) => db.prepare("SELECT day, views, clicks FROM ad_stats WHERE ad_id = ? AND day >= ? ORDER BY day DESC").all(id, new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)),

    // Banners showing right now, grouped by place.
    live() {
      const t = now();
      const rows = db.prepare(`SELECT * FROM ads WHERE active = 1 AND image_id IS NOT NULL AND (starts_at IS NULL OR starts_at <= :t) AND (ends_at IS NULL OR ends_at >= :t) ORDER BY id`).all({ t }).map(hydrate);
      const byPlace = {};
      for (const ad of rows) for (const p of ad.places) (byPlace[p] ??= []).push(ad);
      return byPlace;
    },
    // True when a banner started or stopped between two instants, so cached pages get refreshed.
    changedBetween: (from, to) => Boolean(db.prepare('SELECT 1 FROM ads WHERE active = 1 AND ((starts_at > :from AND starts_at <= :to) OR (ends_at > :from AND ends_at <= :to)) LIMIT 1').get({ from, to })),

    save(input, id = 0) {
      const t = now();
      const values = bind({
        name: input.name,
        url: input.url,
        alt: input.alt || "",
        image_id: input.image_id || null,
        mobile_image_id: input.mobile_image_id || null,
        places: JSON.stringify(input.places || []),
        starts_at: input.starts_at || null,
        ends_at: input.ends_at || null,
        active: input.active ? 1 : 0,
        t,
      });
      if (id) {
        db.prepare(`UPDATE ads SET name = :name, url = :url, alt = :alt, image_id = :image_id, mobile_image_id = :mobile_image_id, places = :places,
                    starts_at = :starts_at, ends_at = :ends_at, active = :active, updated_at = :t WHERE id = :id`).run({ ...values, id });
      } else {
        id = Number(db.prepare(`INSERT INTO ads (name, url, alt, image_id, mobile_image_id, places, starts_at, ends_at, active, created_at, updated_at)
                                VALUES (:name, :url, :alt, :image_id, :mobile_image_id, :places, :starts_at, :ends_at, :active, :t, :t)`).run(values).lastInsertRowid);
      }
      onChange();
      return store.get(id);
    },
    setActive(id, active) {
      db.prepare("UPDATE ads SET active = ?, updated_at = ? WHERE id = ?").run(active ? 1 : 0, now(), id);
      onChange();
    },
    remove(id) {
      db.prepare("DELETE FROM ads WHERE id = ?").run(id);
      onChange();
    },

    // Counts a view or a click, for a banner that is showing right now (active, with a picture, inside its dates).
    // Anything else (paused, scheduled, ended, unknown) is ignored. No cookies and nothing about the reader is stored.
    record(id, kind) {
      if (kind !== "views" && kind !== "clicks") return;
      const t = now();
      db.prepare(`INSERT INTO ad_stats (ad_id, day, ${kind}) SELECT id, :day, 1 FROM ads
                  WHERE id = :id AND active = 1 AND image_id IS NOT NULL AND (starts_at IS NULL OR starts_at <= :t) AND (ends_at IS NULL OR ends_at >= :t)
                  ON CONFLICT(ad_id, day) DO UPDATE SET ${kind} = ${kind} + 1`).run({ day: t.slice(0, 10), id, t });
    },
  };
  return store;
}
