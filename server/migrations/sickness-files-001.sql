CREATE TABLE IF NOT EXISTS jeroc_sickness_files (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  record JSONB NOT NULL,
  bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS jeroc_sickness_files_case ON jeroc_sickness_files(case_id, person_id);
