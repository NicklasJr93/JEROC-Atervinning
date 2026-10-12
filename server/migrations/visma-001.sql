-- Integration journals/cache rows are separate from the business aggregate.
-- Keep each complete record so new provider fields remain backed up without a
-- field allowlist, while indexing only routing/idempotency/queue attributes.
CREATE TABLE IF NOT EXISTS jeroc_visma_records (
  organisation_id TEXT NOT NULL,
  collection TEXT NOT NULL CHECK (collection IN ('runs','audit','outbox','choices','settingsHistory','mappings')),
  record_key TEXT NOT NULL,
  document JSONB NOT NULL,
  idempotency_key TEXT,
  company_id TEXT,
  customer_id TEXT,
  card_id TEXT,
  status TEXT,
  trigger_kind TEXT,
  sort_at TEXT,
  revision TEXT,
  sequence BIGSERIAL NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organisation_id,collection,record_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS jeroc_visma_run_idempotency
  ON jeroc_visma_records(organisation_id,idempotency_key)
  WHERE collection='runs' AND idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS jeroc_visma_export_idempotency
  ON jeroc_visma_records(organisation_id,idempotency_key)
  WHERE collection='outbox' AND idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jeroc_visma_record_queue
  ON jeroc_visma_records(organisation_id,collection,status,sort_at,record_key);
CREATE INDEX IF NOT EXISTS jeroc_visma_record_history
  ON jeroc_visma_records(organisation_id,collection,sort_at DESC,sequence DESC);
CREATE INDEX IF NOT EXISTS jeroc_visma_record_card
  ON jeroc_visma_records(organisation_id,collection,card_id,sort_at DESC);
CREATE INDEX IF NOT EXISTS jeroc_visma_record_company
  ON jeroc_visma_records(organisation_id,collection,company_id,revision,record_key);

-- Render can briefly run an older instance beside the new one. Once migration
-- commits, that instance must not put journals back into the compact document
-- and reserve duplicate provider operations from an apparently empty history.
CREATE OR REPLACE FUNCTION jeroc_guard_compact_visma_document() RETURNS trigger AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.domain='vismaIntegration' AND OLD.document->>'storageVersion'='1' THEN
      IF NEW.document->>'storageVersion' IS DISTINCT FROM '1' OR EXISTS (
        SELECT 1 FROM jsonb_each(COALESCE(NEW.document->'tenants','{}'::jsonb)) AS tenant
        WHERE tenant.value ?| ARRAY['runs','audit']
          OR (tenant.value->'finance') ?| ARRAY['outbox','choices','settingsHistory','mappings']
      ) THEN
        RAISE EXCEPTION 'Spiris-lagringen har uppgraderats. Den äldre serverversionen får inte skriva integrationshistorik.' USING ERRCODE='55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='jeroc_application_documents'::regclass AND tgname='jeroc_compact_visma_guard') THEN
    CREATE TRIGGER jeroc_compact_visma_guard BEFORE INSERT OR UPDATE ON jeroc_application_documents
      FOR EACH ROW EXECUTE FUNCTION jeroc_guard_compact_visma_document();
  END IF;
END;
$$;

-- Keep active bookkeeping follow-ups separate from completed transfer history.
CREATE INDEX IF NOT EXISTS jeroc_visma_tracking_due
  ON jeroc_visma_records(organisation_id,company_id,(document->'tracking'->>'nextCheckAt'),sequence)
  WHERE collection='outbox' AND status='accepted' AND
    (NOT(document ? 'tracking') OR document->'tracking'->>'state' IN ('pending','paused'));
