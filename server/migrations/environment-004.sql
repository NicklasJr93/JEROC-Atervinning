-- NVV reporting is append-only evidence around existing physical receipts.
-- No reset, external calls, inventory or financial changes occur in migration.
CREATE TABLE IF NOT EXISTS jeroc_environment_nvvSettings (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_environment_nvvChecks (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_environment_nvvReports (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_environment_nvvAttempts (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_environment_nvvJobs (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
