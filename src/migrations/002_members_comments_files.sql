-- Reader accounts and comments, source code files, file downloads.

CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  newsletter INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE member_sessions (
  id TEXT PRIMARY KEY,               -- sha256 of the cookie token
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX member_sessions_member ON member_sessions(member_id);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- staff replying from the admin
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'pending', 'hidden')),
  created_at TEXT NOT NULL,
  edited_at TEXT
);
CREATE INDEX comments_post ON comments(post_id, status, created_at);
CREATE INDEX comments_member ON comments(member_id);

CREATE TABLE comment_likes (
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, member_id)
);

-- [{"name":"main.ino","lang":"cpp","code":"..."}]
ALTER TABLE posts ADD COLUMN source_files TEXT NOT NULL DEFAULT '[]';
ALTER TABLE posts ADD COLUMN comments_enabled INTEGER NOT NULL DEFAULT 1;

-- Images are resized into variants; files (PDF, STL, ZIP...) are stored as uploaded.
ALTER TABLE media ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';

-- Downloads move from {code, diagram_id, stl} to {github, files: [{media_id, label}]}.
UPDATE posts SET downloads = json_object(
  'github', COALESCE(json_extract(downloads, '$.code'), ''),
  'files', CASE WHEN json_extract(downloads, '$.diagram_id') IS NOT NULL
    THEN json_array(json_object('media_id', json_extract(downloads, '$.diagram_id'), 'label', 'Circuit diagram'))
    ELSE json_array() END
) WHERE json_valid(downloads);

-- The series box and "Next project" were removed from the site.
UPDATE posts SET next_post_id = NULL, next_teaser = '', series_id = NULL, series_order = NULL, series_label = '';
