-- Initial schema. Times are ISO 8601 UTC strings. JSON columns hold arrays/objects as text.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'author', 'contributor')),
  job_title TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  photo_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  links TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- sha256 of the cookie token
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE media (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,         -- e.g. 2026/11/esp32-wiring-a1b2c3d4.png (relative to the media dir)
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  size INTEGER NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  variants TEXT NOT NULL DEFAULT '{}', -- {"avif":[[w,path]],"webp":[[w,path]]}
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  intro_md TEXT NOT NULL DEFAULT '',
  seo_title TEXT NOT NULL DEFAULT '',
  parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  show_on_home INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE series (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,                -- short name for breadcrumbs and chips
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',    -- hub page H1
  description TEXT NOT NULL DEFAULT '',
  intro_md TEXT NOT NULL DEFAULT '',
  seo_title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'post' CHECK (type IN ('post', 'page')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  title TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',  -- meta description and card summary
  seo_title TEXT NOT NULL DEFAULT '',
  short_title TEXT NOT NULL DEFAULT '',
  canonical_url TEXT NOT NULL DEFAULT '',
  noindex INTEGER NOT NULL DEFAULT 0,
  og_title TEXT NOT NULL DEFAULT '',
  og_description TEXT NOT NULL DEFAULT '',
  og_image_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  feature_image_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  feature_image_alt TEXT NOT NULL DEFAULT '',
  feature_image_caption TEXT NOT NULL DEFAULT '',
  author_id INTEGER NOT NULL REFERENCES users(id),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  series_id INTEGER REFERENCES series(id) ON DELETE SET NULL,
  series_order INTEGER,
  series_label TEXT NOT NULL DEFAULT '',
  accent TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  level INTEGER,
  quick_answer TEXT NOT NULL DEFAULT '',
  at_a_glance TEXT NOT NULL DEFAULT '[]', -- [["Difficulty","Beginner"], ...]
  tested_with TEXT NOT NULL DEFAULT '[]', -- ["IoT Studio 1.4.0", ...]
  video TEXT NOT NULL DEFAULT '{}',       -- {youtube_id,title,description,upload_date,duration,chapters:[{at,name}]}
  downloads TEXT NOT NULL DEFAULT '{}',   -- {code,diagram_id,stl}
  next_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  next_teaser TEXT NOT NULL DEFAULT '',
  featured INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,                 -- a future time means scheduled
  updated_at TEXT,                   -- the public "Updated" date
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,         -- last save of any kind
  word_count INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  UNIQUE (type, slug)
);
CREATE INDEX posts_public ON posts(type, status, published_at);
CREATE INDEX posts_category ON posts(category_id);
CREATE INDEX posts_author ON posts(author_id);
CREATE INDEX posts_series ON posts(series_id);

CREATE TABLE post_tags (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, tag_id)
);
CREATE INDEX post_tags_tag ON post_tags(tag_id);

CREATE TABLE revisions (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX revisions_post ON revisions(post_id, id);

CREATE TABLE redirects (
  id INTEGER PRIMARY KEY,
  from_path TEXT NOT NULL UNIQUE,
  to_path TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 301 CHECK (status_code IN (301, 302, 410)),
  hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Full-text search over posts and pages; rowid = posts.id.
CREATE VIRTUAL TABLE posts_fts USING fts5(title, excerpt, body, tokenize = 'porter unicode61');
