-- Durable business domains. Adding attributes to a domain does not require a
-- backup field allowlist: PostgreSQL stores the entire validated document.
CREATE TABLE IF NOT EXISTS jeroc_application_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1), revision BIGINT NOT NULL DEFAULT 0
);
INSERT INTO jeroc_application_meta(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS jeroc_application_documents (
  domain TEXT PRIMARY KEY, document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS jeroc_application_audit (
  id BIGSERIAL PRIMARY KEY, recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS jeroc_application_imports (id TEXT PRIMARY KEY, data JSONB NOT NULL);
