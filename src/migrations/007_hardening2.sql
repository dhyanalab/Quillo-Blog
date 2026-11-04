-- Second security hardening round. Safe on an existing database: new columns with defaults, new tables, indexes and
-- triggers, and a few backfills. No table is rebuilt and no row of real content is deleted.

-- ---- Staff accounts ----
-- Recovery codes made before the keyed (HMAC) format can't be told apart from newer ones by the hash alone, so every
-- existing code is removed and each person who had two-step sign-in on is told to create new ones.
ALTER TABLE users ADD COLUMN recovery_codes_reset INTEGER NOT NULL DEFAULT 0;
UPDATE users SET recovery_codes_reset = 1
  WHERE totp_enabled_at IS NOT NULL AND id IN (SELECT user_id FROM user_recovery_codes);
DELETE FROM user_recovery_codes;

-- When a password was last set by someone else (a temporary password expires after 7 days). Existing accounts that
-- still have a first password to change start their 7 days now, so nobody is locked out by the upgrade.
ALTER TABLE users ADD COLUMN password_set_at TEXT;
UPDATE users SET password_set_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE password_must_change = 1;

-- Every accepted two-step code step is remembered (a short JSON list), so a code from the next step used early
-- can't lock out the real current code. totp_last_step stays as the highest step.
ALTER TABLE users ADD COLUMN totp_used_steps TEXT NOT NULL DEFAULT '[]';
UPDATE users SET totp_used_steps = json_array(totp_last_step) WHERE totp_last_step > 0;

-- ---- Ids that are never reused (users, readers, comments, media) ----
-- The highest id ever used is kept per table. It starts from the highest id in the table and from every id still
-- mentioned anywhere else (so ids deleted before this update are remembered where something still points at them).
CREATE TABLE id_floor (
  tbl TEXT PRIMARY KEY,
  max_id INTEGER NOT NULL
);
INSERT INTO id_floor (tbl, max_id) VALUES
  ('users', max(
    COALESCE((SELECT MAX(id) FROM users), 0),
    COALESCE((SELECT MAX(author_id) FROM posts), 0),
    COALESCE((SELECT MAX(user_id) FROM comments), 0),
    COALESCE((SELECT MAX(author_id) FROM revisions), 0),
    COALESCE((SELECT MAX(uploaded_by) FROM media), 0),
    COALESCE((SELECT MAX(created_by) FROM newsletters), 0))),
  ('members', max(
    COALESCE((SELECT MAX(id) FROM members), 0),
    COALESCE((SELECT MAX(member_id) FROM comments), 0),
    COALESCE((SELECT MAX(member_id) FROM comment_likes), 0),
    COALESCE((SELECT MAX(member_id) FROM member_sessions), 0))),
  ('comments', max(
    COALESCE((SELECT MAX(id) FROM comments), 0),
    COALESCE((SELECT MAX(parent_id) FROM comments), 0),
    COALESCE((SELECT MAX(comment_id) FROM comment_likes), 0))),
  ('media', max(
    COALESCE((SELECT MAX(id) FROM media), 0),
    COALESCE((SELECT MAX(feature_image_id) FROM posts), 0),
    COALESCE((SELECT MAX(og_image_id) FROM posts), 0),
    COALESCE((SELECT MAX(photo_id) FROM users), 0),
    COALESCE((SELECT MAX(image_id) FROM ads), 0),
    COALESCE((SELECT MAX(mobile_image_id) FROM ads), 0),
    COALESCE((SELECT MAX(CAST(value AS INTEGER)) FROM settings WHERE key IN ('logo_id', 'default_og_image_id') AND value GLOB '[0-9]*'), 0),
    COALESCE((SELECT MAX(CAST(json_extract(f.value, '$.media_id') AS INTEGER))
              FROM posts p, json_each(CASE WHEN json_valid(p.downloads) THEN p.downloads ELSE '{}' END, '$.files') f), 0)));

CREATE TRIGGER users_id_floor_insert AFTER INSERT ON users
  BEGIN UPDATE id_floor SET max_id = max(max_id, NEW.id) WHERE tbl = 'users'; END;
CREATE TRIGGER users_id_floor_delete AFTER DELETE ON users
  BEGIN UPDATE id_floor SET max_id = max(max_id, OLD.id) WHERE tbl = 'users'; END;
CREATE TRIGGER members_id_floor_insert AFTER INSERT ON members
  BEGIN UPDATE id_floor SET max_id = max(max_id, NEW.id) WHERE tbl = 'members'; END;
CREATE TRIGGER members_id_floor_delete AFTER DELETE ON members
  BEGIN UPDATE id_floor SET max_id = max(max_id, OLD.id) WHERE tbl = 'members'; END;
CREATE TRIGGER comments_id_floor_insert AFTER INSERT ON comments
  BEGIN UPDATE id_floor SET max_id = max(max_id, NEW.id) WHERE tbl = 'comments'; END;
CREATE TRIGGER comments_id_floor_delete AFTER DELETE ON comments
  BEGIN UPDATE id_floor SET max_id = max(max_id, OLD.id) WHERE tbl = 'comments'; END;
CREATE TRIGGER media_id_floor_insert AFTER INSERT ON media
  BEGIN UPDATE id_floor SET max_id = max(max_id, NEW.id) WHERE tbl = 'media'; END;
CREATE TRIGGER media_id_floor_delete AFTER DELETE ON media
  BEGIN UPDATE id_floor SET max_id = max(max_id, OLD.id) WHERE tbl = 'media'; END;

-- The post id floor (migration 006) also learns every post id still mentioned elsewhere.
UPDATE posts_id_floor SET max_id = max(max_id,
  COALESCE((SELECT MAX(post_id) FROM revisions), 0),
  COALESCE((SELECT MAX(post_id) FROM comments), 0),
  COALESCE((SELECT MAX(post_id) FROM post_tags), 0),
  COALESCE((SELECT MAX(next_post_id) FROM posts), 0)) WHERE id = 1;

-- ---- Readers: when the last verification and reset links were sent (a new link only after 15 minutes) ----
ALTER TABLE members ADD COLUMN verify_sent_at TEXT;
ALTER TABLE members ADD COLUMN reset_sent_at TEXT;
UPDATE members SET verify_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', verify_expires, '-48 hours') WHERE verify_token_hash IS NOT NULL AND verify_expires IS NOT NULL;
UPDATE members SET reset_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', reset_expires, '-1 hours') WHERE reset_token_hash IS NOT NULL AND reset_expires IS NOT NULL;

-- ---- Newsletter subscribers ----
ALTER TABLE subscribers ADD COLUMN confirm_sent_at TEXT;
UPDATE subscribers SET confirm_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', confirm_expires, '-7 days') WHERE confirm_token_hash IS NOT NULL AND confirm_expires IS NOT NULL;

-- An append-only record of consent changes. It keeps a hash of the address, not the address.
CREATE TABLE subscriber_events (
  id INTEGER PRIMARY KEY,
  subscriber_id INTEGER,
  email_hash TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL CHECK (event IN ('add', 'confirm', 'unsubscribe', 'resubscribe', 'admin-add')),
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX subscriber_events_subscriber ON subscriber_events(subscriber_id);
CREATE TRIGGER subscriber_events_no_update BEFORE UPDATE ON subscriber_events
  BEGIN SELECT RAISE(ABORT, 'subscriber_events is append-only'); END;
CREATE TRIGGER subscriber_events_no_delete BEFORE DELETE ON subscriber_events
  BEGIN SELECT RAISE(ABORT, 'subscriber_events is append-only'); END;

-- ---- Redirects: lookups by target, and the auto rows that get trimmed ----
CREATE INDEX redirects_to_path ON redirects(to_path);
CREATE INDEX redirects_source ON redirects(source, id);

-- ---- Rate limiter counters that survive a restart (used through store.rateLimits) ----
CREATE TABLE rate_limits (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  start INTEGER NOT NULL,      -- start of the current window, in ms
  cur INTEGER NOT NULL,        -- attempts in the current window
  prev INTEGER NOT NULL DEFAULT 0, -- attempts in the window before
  expires INTEGER NOT NULL,    -- ms; the row can be deleted after this
  PRIMARY KEY (scope, key)
) WITHOUT ROWID;
CREATE INDEX rate_limits_expires ON rate_limits(expires);
