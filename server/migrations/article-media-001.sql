CREATE TABLE IF NOT EXISTS jeroc_article_media (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  record JSONB NOT NULL,
  full_image BYTEA NOT NULL,
  thumbnail BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
