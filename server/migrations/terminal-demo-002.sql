CREATE TABLE IF NOT EXISTS jeroc_terminal_presence (
  terminal_id TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_terminal_pdf_jobs (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  approval_snapshot JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claim_token TEXT,
  lease_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE(approval_id,stage,source_hash)
);
CREATE INDEX IF NOT EXISTS jeroc_terminal_pdf_pending ON jeroc_terminal_pdf_jobs(status,available_at,lease_until);
