import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { afterDatabaseCommit } from './database-runtime.mjs';

const DOMAIN = 'vismaIntegration', LOCK = 1860399453;
const collections = ['runs', 'audit', 'outbox', 'choices', 'settingsHistory', 'mappings'];
const migration = readFile(new URL('./migrations/visma-001.sql', import.meta.url), 'utf8');
const clone = value => structuredClone(value);
const initial = () => ({ version: 1, tenants: {} });
const legacyKey = (value, index) => `legacy:${index}:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const historyKey = (companyId, revision) => JSON.stringify([companyId, String(revision)]);
const own = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
function put(object, path, value) {
  for (const part of path.slice(0, -1)) { if (!Object.hasOwn(object, part)) own(object, part, {}); object = object[part]; }
  own(object, path.at(-1), clone(value));
}
function get(object, path) {
  for (const part of path) { if (!object || typeof object !== 'object' || !Object.hasOwn(object, part)) return { present: false }; object = object[part]; }
  return { present: true, value: object };
}
function compact(document) {
  const result = clone(document);
  result.storageVersion = 1;
  for (const tenant of Object.values(result.tenants ?? {})) {
    delete tenant.runs; delete tenant.audit;
    if (tenant.finance) for (const collection of ['outbox', 'choices', 'settingsHistory', 'mappings']) delete tenant.finance[collection];
  }
  return result;
}
function record(organisationId, collection, key, value, companyId, revision) {
  return { organisationId, collection, key, document: value,
    idempotencyKey: collection === 'runs' ? value?.keyHash ?? null : collection === 'outbox' ? value?.key ?? null : null,
    companyId: companyId ?? value?.companyId ?? null, customerId: value?.customerId ?? null,
    cardId: value?.source?.cardId === undefined ? null : String(value.source.cardId), status: value?.status ?? null,
    trigger: value?.trigger ?? null, sortAt: value?.startedAt ?? value?.createdAt ?? value?.at ?? null, revision: revision === undefined ? null : String(revision) };
}
function recordsOf(document) {
  const result = [];
  for (const [organisationId, tenant] of Object.entries(document.tenants ?? {})) {
    for (const collection of ['runs', 'audit', 'outbox']) {
      const values = collection === 'outbox' ? tenant.finance?.outbox : tenant[collection];
      for (const [index, value] of (values ?? []).entries()) result.push(record(organisationId, collection, String(value?.id ?? legacyKey(value, index)), value));
    }
    for (const collection of ['choices', 'mappings']) for (const [key, value] of Object.entries(tenant.finance?.[collection] ?? {}))
      result.push(record(organisationId, collection, key, value, collection === 'choices' ? key : undefined));
    for (const [companyId, versions] of Object.entries(tenant.finance?.settingsHistory ?? {})) for (const [revision, value] of Object.entries(versions))
      result.push(record(organisationId, 'settingsHistory', historyKey(companyId, revision), value, companyId, revision));
  }
  return result;
}
const identity = row => JSON.stringify([row.organisationId, row.collection, row.key]);
async function saveRecords(client, rows) {
  if (!rows.length) return;
  await client.query(`INSERT INTO jeroc_visma_records(organisation_id,collection,record_key,document,idempotency_key,company_id,customer_id,card_id,status,trigger_kind,sort_at,revision)
    SELECT value->>'organisationId',value->>'collection',value->>'key',value->'document',value->>'idempotencyKey',value->>'companyId',
      value->>'customerId',value->>'cardId',value->>'status',value->>'trigger',value->>'sortAt',value->>'revision'
    FROM jsonb_array_elements($1::jsonb) AS value
    ON CONFLICT(organisation_id,collection,record_key) DO UPDATE SET document=EXCLUDED.document,idempotency_key=EXCLUDED.idempotency_key,
      company_id=EXCLUDED.company_id,customer_id=EXCLUDED.customer_id,card_id=EXCLUDED.card_id,status=EXCLUDED.status,
      trigger_kind=EXCLUDED.trigger_kind,sort_at=EXCLUDED.sort_at,revision=EXCLUDED.revision,updated_at=NOW()`, [JSON.stringify(rows)]);
}
async function loadCompact(client, lock = false) {
  const result = await client.query(`SELECT document FROM jeroc_application_documents WHERE domain=$1${lock ? ' FOR UPDATE' : ''}`, [DOMAIN]);
  return result.rows[0]?.document ?? initial();
}
function selectors(options = {}, reading = false) {
  const result = [], organisationId = options.organisationId ?? null;
  const add = (collection, values = {}) => result.push({ collection, organisationId, ...values });
  const runs = options.runs ?? true, finance = options.finance ?? true;
  if (runs) add('runs', typeof runs === 'object' ? { id: runs.id ?? null, key: runs.keyHash ?? null } : {});
  // Writes append audit entries without loading a growing historical journal.
  if (reading && options.audit !== false) add('audit');
  if (finance === true) for (const collection of ['outbox', 'choices', 'settingsHistory', 'mappings']) add(collection);
  else if (finance && typeof finance === 'object') {
    if (finance.outbox) add('outbox', typeof finance.outbox === 'object' ? { id: finance.outbox.id ?? null, key: finance.outbox.key ?? null } : {});
    if (finance.mappings === true) add('mappings');
    else for (const key of finance.mappingKeys ?? []) add('mappings', { id: key });
    for (const companyId of finance.choicesCompanies ?? []) add('choices', { id: companyId });
    for (const item of finance.historyRevisions ?? []) add('settingsHistory', { id: historyKey(item.companyId, item.revision) });
  }
  return result;
}
function hydrate(document, rows) {
  const result = clone(document);
  for (const tenant of Object.values(result.tenants ?? {})) {
    tenant.runs = []; tenant.audit = [];
    tenant.finance ??= {}; tenant.finance.settings ??= {}; tenant.finance.outbox = []; tenant.finance.choices = {}; tenant.finance.settingsHistory = {}; tenant.finance.mappings = {};
  }
  for (const row of rows) {
    const tenant = result.tenants[row.organisation_id];
    if (!tenant) continue;
    if (['runs', 'audit'].includes(row.collection)) tenant[row.collection].push(row.document);
    else if (row.collection === 'outbox') tenant.finance.outbox.push(row.document);
    else if (row.collection === 'settingsHistory') put(tenant.finance.settingsHistory, [row.company_id, row.revision], row.document);
    else own(tenant.finance[row.collection], row.record_key, row.document);
  }
  return result;
}
async function loadRecords(client, requested) {
  if (!requested.length) return [];
  const parameters = [], conditions = requested.map(selection => {
    const bind = value => { parameters.push(value); return `$${parameters.length}`; };
    const clauses = [`records.collection=${bind(selection.collection)}`];
    if (selection.organisationId !== null && selection.organisationId !== undefined) clauses.push(`records.organisation_id=${bind(selection.organisationId)}`);
    if (selection.id !== null && selection.id !== undefined || selection.key !== null && selection.key !== undefined) {
      const keys = [];
      if (selection.id !== null && selection.id !== undefined) keys.push(`records.record_key=${bind(selection.id)}`);
      if (selection.key !== null && selection.key !== undefined) keys.push(`records.idempotency_key=${bind(selection.key)}`);
      clauses.push(`(${keys.join(' OR ')})`);
    }
    return `(${clauses.join(' AND ')})`;
  });
  return (await client.query(`SELECT records.organisation_id,records.collection,records.record_key,records.company_id,records.revision,records.document
    FROM jeroc_visma_records AS records
    WHERE ${conditions.join(' OR ')} ORDER BY records.sequence`, parameters)).rows;
}
function movedPath(path) {
  if (path[0] !== 'finance') return null;
  if (['choices', 'mappings'].includes(path[1]) && path.length >= 3) return { collection: path[1], key: path[2], tail: path.slice(3) };
  if (path[1] === 'settingsHistory' && path.length >= 4) return { collection: path[1], key: historyKey(path[2], path[3]), tail: path.slice(4) };
  return null;
}
function projectedPaths(paths) {
  if (!Array.isArray(paths) || paths.some(path => !Array.isArray(path) || !path.length || path.some(key => typeof key !== 'string'))) throw new TypeError('Välj giltiga integrationsuppgifter.');
  return paths;
}

/** Indexed PostgreSQL integration records, with the existing SQLite adapter for
 * development. Provider dispatch still happens outside these short units. */
export function createVismaStorage({ getRepository, organisationId: defaultOrganisationId = 'jeroc-demo' } = {}) {
  if (typeof getRepository !== 'function') throw new TypeError('getRepository krävs.');
  const readyRepositories = new WeakSet();
  async function ready() {
    const repo = await getRepository();
    if (repo.kind !== 'postgresql') return repo;
    // A first migration may join an outer business unit. Its local callback can
    // finish before that outer unit commits; cache readiness only after commit,
    // so a later rollback cannot leave a false "ready" marker in this process.
    // Never share an uncommitted promise across units: another unit may wait on
    // our advisory lock while the current unit needs to read its own migration.
    if (!readyRepositories.has(repo)) {
      await repo.runInTransaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
        await client.query(await migration);
        const document = await loadCompact(client, true);
        if (document.storageVersion !== 1) {
          await saveRecords(client, recordsOf(document));
          await client.query(`INSERT INTO jeroc_application_documents(domain,document) VALUES($1,$2::jsonb)
            ON CONFLICT(domain) DO UPDATE SET document=EXCLUDED.document,updated_at=NOW()`, [DOMAIN, JSON.stringify(compact(document))]);
        }
        afterDatabaseCommit(() => { readyRepositories.add(repo); });
      });
    }
    return repo;
  }
  const readUnit = (repo, operation) => repo.runInReadTransaction(operation);
  async function read(operation, options = {}) {
    const repo = await ready();
    if (repo.kind !== 'postgresql') return repo.read(state => operation(state[DOMAIN] ?? initial()), { domains: [DOMAIN] });
    return readUnit(repo, async client => operation(hydrate(await loadCompact(client), await loadRecords(client, selectors(options, true)))));
  }
  async function transact(operation, options = {}) {
    const repo = await ready();
    if (repo.kind !== 'postgresql') return repo.transact(state => { state[DOMAIN] ??= initial(); return operation(state[DOMAIN]); });
    return repo.runInTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
      const before = await loadCompact(client, true), loaded = await loadRecords(client, selectors(options));
      const document = hydrate(before, loaded), previous = new Map(recordsOf(document).map(row => [identity(row), { ...row, document: clone(row.document) }]));
      const result = await operation(document), after = compact(document), updated = recordsOf(document), next = new Set(updated.map(identity));
      await saveRecords(client, updated.filter(row => JSON.stringify(previous.get(identity(row))?.document) !== JSON.stringify(row.document)));
      const removed = [...previous].filter(([key, row]) => row.collection !== 'audit' && !next.has(key)).map(([, row]) => row);
      if (removed.length) await client.query(`DELETE FROM jeroc_visma_records AS records USING jsonb_array_elements($1::jsonb) AS removed
        WHERE records.organisation_id=removed->>'organisationId' AND records.collection=removed->>'collection' AND records.record_key=removed->>'key'`, [JSON.stringify(removed)]);
      if (JSON.stringify(after) !== JSON.stringify(before)) await client.query(`INSERT INTO jeroc_application_documents(domain,document) VALUES($1,$2::jsonb)
        ON CONFLICT(domain) DO UPDATE SET document=EXCLUDED.document,updated_at=NOW()`, [DOMAIN, JSON.stringify(after)]);
      return result;
    });
  }
  async function readTenantProjection(operation, paths, organisationId = defaultOrganisationId) {
    projectedPaths(paths);
    const repo = await ready();
    if (repo.kind !== 'postgresql') {
      const select = state => operation(state[DOMAIN]?.tenants?.[organisationId] ?? {});
      if (typeof repo.readProjection === 'function') return repo.readProjection(select, { domain: DOMAIN, paths: paths.map(path => ['tenants', organisationId, ...path]) });
      return repo.read(select, { domains: [DOMAIN] });
    }
    return readUnit(repo, async client => {
      const requests = [], broad = [];
      for (const path of paths) {
        const moved = movedPath(path);
        if (moved) requests.push({ kind: 'record', path, ...moved });
        else if (['runs', 'audit'].includes(path[0]) || path[0] === 'finance' && ['outbox', 'choices', 'settingsHistory', 'mappings'].includes(path[1])) broad.push(path);
        else requests.push({ kind: 'compact', path, tail: ['tenants', organisationId, ...path] });
      }
      const projected = {};
      if (requests.length) {
        const rows = (await client.query(`WITH requested AS (
          SELECT value->>'kind' AS kind,value->>'collection' AS collection,value->>'key' AS record_key,
            ARRAY(SELECT jsonb_array_elements_text(value->'path')) AS path,
            ARRAY(SELECT jsonb_array_elements_text(value->'tail')) AS tail
          FROM jsonb_array_elements($2::jsonb) AS value)
          SELECT requested.path,(CASE WHEN requested.kind='compact' THEN documents.document #> requested.tail ELSE records.document #> requested.tail END)::text AS value_json
          FROM requested LEFT JOIN jeroc_application_documents AS documents ON requested.kind='compact' AND documents.domain=$3
          LEFT JOIN jeroc_visma_records AS records ON requested.kind='record' AND records.organisation_id=$1
            AND records.collection=requested.collection AND records.record_key=requested.record_key`, [organisationId, JSON.stringify(requests), DOMAIN])).rows;
        for (const row of rows) if (row.value_json !== null) put(projected, row.path, JSON.parse(row.value_json));
      }
      if (broad.length) {
        const collectionNames = [...new Set(broad.map(path => path[0] === 'finance' ? path[1] : path[0]))];
        const rows = await loadRecords(client, collectionNames.map(collection => ({ organisationId, collection })));
        const tenant = hydrate({ tenants: { [organisationId]: {} } }, rows).tenants[organisationId];
        for (const path of broad) { const value = get(tenant, path); if (value.present) put(projected, path, value.value); }
      }
      return operation(projected);
    });
  }
  async function findRun(id, keyHash, organisationId = defaultOrganisationId) {
    const repo = await ready();
    if (repo.kind !== 'postgresql') return read(document => document.tenants?.[organisationId]?.runs?.find(run => run.id === id || keyHash && run.keyHash === keyHash) ?? null);
    return readUnit(repo, async client => (await client.query(`SELECT document FROM jeroc_visma_records
      WHERE organisation_id=$1 AND collection='runs' AND (record_key=$2 OR idempotency_key=$3) ORDER BY sequence LIMIT 1`, [organisationId, id ?? null, keyHash ?? null])).rows[0]?.document ?? null);
  }
  async function latestRuns(limit = 50, organisationId = defaultOrganisationId) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Välj ett giltigt antal integrationsförsök.');
    const repo = await ready();
    if (repo.kind !== 'postgresql') return read(document => (document.tenants?.[organisationId]?.runs ?? []).slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit));
    return readUnit(repo, async client => (await client.query(`SELECT document FROM jeroc_visma_records
      WHERE organisation_id=$1 AND collection='runs' ORDER BY sort_at DESC NULLS LAST,sequence DESC LIMIT $2`, [organisationId, limit])).rows.map(row => row.document));
  }
  async function queryExports(options = {}) {
    const { organisationId = defaultOrganisationId, companyId, id, key, cardId, statuses, trigger, limit, fields, trackingDueAt, trackingGeneration, descending = false } = options;
    if (statuses !== undefined && (!Array.isArray(statuses) || statuses.some(status => typeof status !== 'string')) || fields !== undefined && (!Array.isArray(fields) || fields.some(field => typeof field !== 'string'))
      || limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 10000)) throw new TypeError('Välj giltiga överföringsfilter.');
    const repo = await ready();
    if (repo.kind !== 'postgresql') return read(document => {
      let jobs = (document.tenants?.[organisationId]?.finance?.outbox ?? []).filter(job => (companyId === undefined || job.companyId === companyId) && (id === undefined || job.id === id)
        && (key === undefined || job.key === key) && (cardId === undefined || String(job.source?.cardId) === String(cardId)) && (statuses === undefined || statuses.includes(job.status)) && (trigger === undefined || job.trigger === trigger));
      if (trackingDueAt !== undefined) jobs = jobs.filter(job => {
        const tracking = job.tracking;
        if (tracking?.lease && tracking.lease.until > trackingDueAt) return false;
        return !tracking || tracking.state === 'pending' && (!tracking.nextCheckAt || tracking.nextCheckAt <= trackingDueAt)
          || tracking.state === 'paused' && tracking.checkedGeneration !== trackingGeneration;
      });
      jobs = jobs.slice().sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') * (descending ? -1 : 1));
      if (limit !== undefined) jobs = jobs.slice(0, limit);
      return fields ? jobs.map(job => Object.fromEntries(fields.filter(field => Object.hasOwn(job, field)).map(field => [field, clone(job[field])]))) : clone(jobs);
    });
    return readUnit(repo, async client => {
      const ordering = descending ? 'DESC' : 'ASC';
      const rows = (await client.query(`SELECT CASE WHEN $9::text[] IS NULL THEN records.document ELSE
        COALESCE((SELECT jsonb_object_agg(field,records.document->field) FROM unnest($9::text[]) AS field WHERE records.document ? field),'{}'::jsonb) END AS document
        FROM jeroc_visma_records AS records WHERE organisation_id=$1 AND collection='outbox'
          AND ($2::text IS NULL OR company_id=$2) AND ($3::text IS NULL OR record_key=$3) AND ($4::text IS NULL OR idempotency_key=$4)
          AND ($5::text IS NULL OR card_id=$5) AND ($6::text[] IS NULL OR status=ANY($6)) AND ($7::text IS NULL OR trigger_kind=$7)
          AND ($10::text IS NULL OR (
            (document->'tracking'->'lease'->>'until' IS NULL OR document->'tracking'->'lease'->>'until'<=$10) AND (
              NOT(document ? 'tracking') OR document->'tracking'->>'state'='pending' AND (document->'tracking'->>'nextCheckAt' IS NULL OR document->'tracking'->>'nextCheckAt'<=$10)
              OR document->'tracking'->>'state'='paused' AND document->'tracking'->>'checkedGeneration' IS DISTINCT FROM $11::text)))
        ORDER BY sort_at ${ordering} NULLS LAST,sequence ${ordering} LIMIT $8`,
      [organisationId, companyId ?? null, id ?? null, key ?? null, cardId === undefined ? null : String(cardId), statuses ?? null, trigger ?? null, limit ?? null, fields ?? null, trackingDueAt ?? null, trackingGeneration ?? null])).rows;
      return rows.map(row => row.document);
    });
  }
  return { ready, read, transact, readTenantProjection, findRun, latestRuns, queryExports };
}
