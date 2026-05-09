-- Schema v2 — auth_user table for Sign in with Google.
-- One row per signed-in identity. is_active flag accommodates future
-- multi-account UX without a schema change. last_signed_in_at tracks the
-- most recent successful flow for staleness display.

CREATE TABLE IF NOT EXISTS auth_user (
  sub                 TEXT PRIMARY KEY,
  email               TEXT NOT NULL,
  email_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  name                TEXT,
  picture_url         TEXT,
  last_signed_in_at   BIGINT NOT NULL,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO schema_version (version) VALUES (2)
ON CONFLICT (version) DO NOTHING;
