-- Newsletter: subscribers can unsubscribe with a private link, and newsletters are written and sent from the admin.

ALTER TABLE subscribers ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE subscribers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'; -- 'active' or 'unsubscribed'
ALTER TABLE subscribers ADD COLUMN token TEXT;                          -- private code in unsubscribe links
ALTER TABLE subscribers ADD COLUMN unsubscribed_at TEXT;
UPDATE subscribers SET token = lower(hex(randomblob(16))) WHERE token IS NULL;
CREATE UNIQUE INDEX subscribers_token ON subscribers(token);

CREATE TABLE newsletters (
  id INTEGER PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT '',
  preheader TEXT NOT NULL DEFAULT '',   -- the grey preview line inboxes show after the subject
  body_md TEXT NOT NULL DEFAULT '',
  post_ids TEXT NOT NULL DEFAULT '[]',  -- posts featured under the message
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'failed')),
  recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

-- One row per recipient, so sending can resume after a restart and nobody gets it twice.
CREATE TABLE newsletter_sends (
  newsletter_id INTEGER NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  error TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  PRIMARY KEY (newsletter_id, subscriber_id)
);
CREATE INDEX newsletter_sends_queue ON newsletter_sends(newsletter_id, status);
