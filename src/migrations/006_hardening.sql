-- Security hardening. Safe on an existing database: new columns with defaults, backfills, indexes and triggers.
-- The one table rebuild is "comments" (to allow soft-deleted comments); its likes are copied across.

-- Staff accounts: second-step lockout, a counter that ends open sign-in challenges, and "must change password".
ALTER TABLE users ADD COLUMN totp_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_locked_until TEXT;
ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_must_change INTEGER NOT NULL DEFAULT 0;

-- Idle expiry. Existing sessions start their idle clock now, so nobody is signed out by the upgrade.
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
ALTER TABLE member_sessions ADD COLUMN last_seen_at TEXT;
UPDATE member_sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE INDEX member_sessions_expires ON member_sessions(expires_at);

-- Readers: verified email, and single-use tokens (stored as sha256) for verification and password reset.
-- Everyone who already has an account counts as verified.
ALTER TABLE members ADD COLUMN verified_at TEXT;
ALTER TABLE members ADD COLUMN verify_token_hash TEXT;
ALTER TABLE members ADD COLUMN verify_expires TEXT;
ALTER TABLE members ADD COLUMN reset_token_hash TEXT;
ALTER TABLE members ADD COLUMN reset_expires TEXT;
UPDATE members SET verified_at = created_at;
CREATE INDEX members_verify_token ON members(verify_token_hash) WHERE verify_token_hash IS NOT NULL;
CREATE INDEX members_reset_token ON members(reset_token_hash) WHERE reset_token_hash IS NOT NULL;

-- Subscribers: double opt-in ("pending" until the emailed link is confirmed). Everyone on the list stays active.
ALTER TABLE subscribers ADD COLUMN confirm_token_hash TEXT;
ALTER TABLE subscribers ADD COLUMN confirm_expires TEXT;
CREATE INDEX subscribers_confirm_token ON subscribers(confirm_token_hash) WHERE confirm_token_hash IS NOT NULL;
-- The unsubscribe code may never be empty (a plain NOT NULL can't be added without rebuilding the table).
CREATE TRIGGER subscribers_token_required_insert BEFORE INSERT ON subscribers
  WHEN NEW.token IS NULL OR NEW.token = ''
  BEGIN SELECT RAISE(ABORT, 'subscribers.token is required'); END;
CREATE TRIGGER subscribers_token_required_update BEFORE UPDATE OF token ON subscribers
  WHEN NEW.token IS NULL OR NEW.token = ''
  BEGIN SELECT RAISE(ABORT, 'subscribers.token is required'); END;

-- Newsletters: attempts per recipient, and the time sending started (sent_at now means "finished").
ALTER TABLE newsletter_sends ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE newsletters ADD COLUMN started_at TEXT;
UPDATE newsletters SET started_at = sent_at WHERE sent_at IS NOT NULL;

-- Redirects: who made the row. Every existing row counts as the owner's ('admin'), because slug changes and
-- deletes can't be told apart afterwards. Rows the editor creates from now on are 'auto'.
ALTER TABLE redirects ADD COLUMN source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'auto'));

-- Posts: a plain index for slug lookups, and one URL space across posts and pages.
CREATE INDEX posts_slug ON posts(slug);
CREATE TRIGGER posts_slug_unique_insert BEFORE INSERT ON posts
  WHEN EXISTS (SELECT 1 FROM posts WHERE slug = NEW.slug)
  BEGIN SELECT RAISE(ABORT, 'a post or page already uses this slug'); END;
CREATE TRIGGER posts_slug_unique_update BEFORE UPDATE OF slug, type ON posts
  WHEN EXISTS (SELECT 1 FROM posts WHERE slug = NEW.slug AND id != NEW.id)
  BEGIN SELECT RAISE(ABORT, 'a post or page already uses this slug'); END;

-- Post ids are never handed out twice: the highest id ever used is remembered, even after a delete.
CREATE TABLE posts_id_floor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_id INTEGER NOT NULL
);
INSERT INTO posts_id_floor (id, max_id) SELECT 1, COALESCE(MAX(id), 0) FROM posts;
CREATE TRIGGER posts_id_floor_insert AFTER INSERT ON posts
  BEGIN UPDATE posts_id_floor SET max_id = max(max_id, NEW.id) WHERE id = 1; END;
CREATE TRIGGER posts_id_floor_delete AFTER DELETE ON posts
  BEGIN UPDATE posts_id_floor SET max_id = max(max_id, OLD.id) WHERE id = 1; END;

-- Comments: a removed comment that has replies stays as "Comment removed" (status 'deleted'), and deleting
-- a comment no longer deletes other people's replies (parent_id becomes SET NULL).
-- SQLite can't change a CHECK in place, so the table is rebuilt and the likes are copied across.
CREATE TEMP TABLE comment_likes_keep AS SELECT comment_id, member_id FROM comment_likes;
DROP TABLE comment_likes;
-- Dropping the old table would null the reply links of the new one (they point at the old table), so keep them aside.
CREATE TEMP TABLE comment_parents_keep AS SELECT id, parent_id FROM comments WHERE parent_id IS NOT NULL;

CREATE TABLE comments_new (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  parent_id INTEGER REFERENCES comments(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'pending', 'hidden', 'deleted')),
  created_at TEXT NOT NULL,
  edited_at TEXT
);
INSERT INTO comments_new (id, post_id, member_id, user_id, parent_id, body, status, created_at, edited_at)
  SELECT id, post_id, member_id, user_id, parent_id, body, status, created_at, edited_at FROM comments;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
UPDATE comments SET parent_id = (SELECT k.parent_id FROM comment_parents_keep k WHERE k.id = comments.id)
  WHERE id IN (SELECT id FROM comment_parents_keep);
DROP TABLE comment_parents_keep;
CREATE INDEX comments_post ON comments(post_id, status, created_at);
CREATE INDEX comments_member ON comments(member_id);
CREATE INDEX comments_parent ON comments(parent_id);

CREATE TABLE comment_likes (
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, member_id)
);
INSERT INTO comment_likes (comment_id, member_id) SELECT comment_id, member_id FROM comment_likes_keep;
DROP TABLE comment_likes_keep;
