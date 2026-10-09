-- Versioned configured limits; no permit values are inferred or seeded.
-- The metadata-row transaction lock serializes capacity checks and stock writes.
CREATE TABLE IF NOT EXISTS jeroc_environment_storagePolicies (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS jeroc_environment_siteRecords (
  id TEXT PRIMARY KEY, data JSONB NOT NULL
);
