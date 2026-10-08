-- The terminal demo uses one transactional aggregate. The database, rather
-- than a Node process or an office browser, owns terminal reservations,
-- immutable review versions and the audit trail. This deliberately small
-- demo schema can be split into normalized business tables in a later phase.
CREATE TABLE IF NOT EXISTS jeroc_terminal_demo (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
