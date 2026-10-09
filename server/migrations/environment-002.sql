-- Editable environmental preparation never creates stock or a reporting clock.
-- Corrections append a new immutable version of an existing physical receipt;
-- signed inventory movements live in the correction's immutable JSON snapshot.
CREATE TABLE IF NOT EXISTS jeroc_environment_drafts (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_environment_corrections (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES jeroc_environment_receipts(id),
  version INTEGER NOT NULL CHECK (version > 1),
  data JSONB NOT NULL,
  UNIQUE (receipt_id, version)
);
