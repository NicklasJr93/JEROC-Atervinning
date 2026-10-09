-- Etapp 1. Environment data is independent of financial/customer approval state.
-- The metadata row serializes writes across all server instances. Receipt and
-- inventory identities additionally have database constraints against duplicates.
CREATE TABLE IF NOT EXISTS jeroc_environment_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1), data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_environment_credentials (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_environment_sessions (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_environment_classifications (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_environment_receipts (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE, data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_environment_inventory (
  id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES jeroc_environment_receipts(id),
  article_id TEXT NOT NULL, data JSONB NOT NULL,
  UNIQUE (receipt_id, article_id)
);
CREATE TABLE IF NOT EXISTS jeroc_environment_reports (
  id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES jeroc_environment_receipts(id),
  article_id TEXT NOT NULL, data JSONB NOT NULL,
  UNIQUE (receipt_id, article_id)
);
CREATE TABLE IF NOT EXISTS jeroc_environment_requests (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_environment_audit (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
