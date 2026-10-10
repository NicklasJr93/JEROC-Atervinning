-- Systemadmin's isolated TEST requests. No receipt/financial relation and no
-- automatic dispatch/replay occurs when these records are restored or read.
CREATE TABLE IF NOT EXISTS jeroc_environment_nvvSandboxRuns (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
