-- Sponsor banners placed by the owner (like the DigiKey and Mouser banners on CircuitDigest),
-- served from this site, with daily view and click counts.

CREATE TABLE ads (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,                -- sponsor or campaign name, only shown in the admin
  url TEXT NOT NULL,                 -- where a click goes
  alt TEXT NOT NULL DEFAULT '',      -- text for screen readers
  image_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  mobile_image_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  places TEXT NOT NULL DEFAULT '[]', -- ["top", "sidebar", ...]
  starts_at TEXT,
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ad_stats (
  ad_id INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                 -- YYYY-MM-DD (UTC)
  views INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ad_id, day)
);
