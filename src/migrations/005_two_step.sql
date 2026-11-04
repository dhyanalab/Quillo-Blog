-- Two-step sign-in for staff: an authenticator app (TOTP) plus single-use recovery codes.

ALTER TABLE users ADD COLUMN totp_secret TEXT;                          -- base32 secret, set once two-step sign-in is on
ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0; -- last accepted 30-second step: each code works once

-- A secret being set up is kept with the session that started it, until a correct code confirms it.
ALTER TABLE sessions ADD COLUMN totp_pending TEXT;

CREATE TABLE user_recovery_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,            -- sha256 of the normalized code; the code itself is shown once
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX user_recovery_codes_user ON user_recovery_codes(user_id);
