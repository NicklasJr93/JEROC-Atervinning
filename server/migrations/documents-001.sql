-- Files are separate immutable records, not browser printouts or mutable business JSON.
CREATE TABLE IF NOT EXISTS jeroc_document_archive (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  stage TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  template_version TEXT NOT NULL,
  record JSONB NOT NULL,
  pdf BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(kind, source_id, source_version, stage, source_hash, template_version)
);
CREATE INDEX IF NOT EXISTS jeroc_document_source ON jeroc_document_archive(kind, source_id, created_at);
CREATE TABLE IF NOT EXISTS jeroc_transport_document_drafts (
  order_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(order_id, version)
);
CREATE TABLE IF NOT EXISTS jeroc_document_audit (
  id TEXT PRIMARY KEY,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
