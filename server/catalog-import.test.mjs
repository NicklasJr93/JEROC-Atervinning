import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createApplicationRepository } from './application-storage.mjs';
import { createPricingStore } from './pricing.mjs';
import { assertCatalogImportDeployment, CatalogImportError, checkCatalogImportReadiness, decodeCatalogImport, decodeCatalogImportTarget, importCompanyCatalog,
  parseCatalogImport, selectCatalogImportCompany } from './catalog-import.mjs';

const company = { id: 'company-test-catalog', name: 'Exempel Återvinning AB', organisationNumber: '5560000167',
  status: 'active', storageSchema: 'jeroc_t_1234567890abcdef' };
const support = { id: '__platform-admin', name: 'Systemadmin', level: 'Systemadmin', permissions: [], maxAttest: 0, ownAttest: false, active: true };
const owner = { id: 'owner-real', name: 'Befintlig chef', level: 'VD', permissions: ['view'], siteIds: ['site-real'], maxAttest: 200, ownAttest: false, active: true };
const payload = () => ({ version: 1, importId: 'test-catalog-2026-10', company: { name: company.name, organisationNumber: company.organisationNumber },
  effectiveFrom: '2026-10-20', thresholds: { A: 2000, B: 500 },
  groups: [{ key: 'metal', name: 'Metall', description: 'Rena metaller', photo: 0 }, { key: 'wire', name: 'Kabel', description: '', photo: 24 }],
  articles: [{ name: 'Provkoppar', group: 'metal', description: 'Ren koppar', includes: ['Rör'], excludes: ['Plast'], photos: [0, 1], taxCategory: 'scrap_reverse', prices: { A: 71.23, B: 63.19, C: 63.19 } },
    { name: 'Provkabel', group: 'wire', description: '', includes: [], excludes: [], photos: [24], taxCategory: 'review', prices: { A: 17.21, B: 10.09, C: 10.09 } }],
});
const initial = () => ({ metadata: { organisation: { id: company.id, name: company.name, number: company.organisationNumber }, pricingSeed: { preserve: true } },
  pricing: { revision: 0, lme: [], articleHistory: [], groups: [], customerPrices: [], users: [structuredClone(owner), structuredClone(support)], customers: [], snapshots: [], ledger: [], audit: [] },
  office: { users: [structuredClone(owner), structuredClone(support)], cards: [{ id: 3001, note: 'Bevara denna invägning' }], customers: [{ id: 'customer-real' }] },
  personnel: { people: [{ id: 'person-real', userId: owner.id, name: owner.name }] },
  transport: { orders: [{ id: 'order-real' }] }, imports: [], mobile: { drafts: [] }, workOrderWeighing: { version: 1, drafts: {} } });
const fails = code => error => error instanceof CatalogImportError && error.code === code;
async function fixture(run, seed = initial) {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-import-')), filename = join(directory, 'app.sqlite');
  const repositories = [];
  const open = async (factory = () => { throw new Error('A fresh database must never be seeded by the import.'); }) => {
    const repository = await createApplicationRepository({ filename, env: {}, seed: factory }); repositories.push(repository); return repository;
  };
  try { await run({ repository: await open(seed), open }); }
  finally { for (const repository of repositories) await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('private payload is strict, rejects duplicate identities, missing groups, unsafe data and imprecise prices', () => {
  assert.deepEqual(parseCatalogImport(payload()), payload());
  for (const change of [value => { value.sourceArticleCode = 'do-not-store'; }, value => { value.articles[0].prices.B = -1; },
    value => { value.articles[0].prices.B = 1.001; }, value => { value.articles[0].photos = ['https://image.invalid/test.png']; },
    value => { value.articles[0].photos = [0, 0]; }, value => { delete value.thresholds; }, value => { value.thresholds.A = value.thresholds.B; },
    value => { value.effectiveFrom = '2026-02-30'; }, value => { value.articles[0].name = 'Name\nInjected'; }]) {
    const value = payload(); change(value); assert.throws(() => parseCatalogImport(value), fails('catalog_import_payload_invalid'));
  }
  const duplicate = payload(); duplicate.articles[1].name = '  PROVKOPPAR  ';
  assert.throws(() => parseCatalogImport(duplicate), fails('catalog_import_duplicate_names'));
  const duplicateGroup = payload(); duplicateGroup.groups[1].key = 'metal';
  assert.throws(() => parseCatalogImport(duplicateGroup), fails('catalog_import_duplicate_names'));
  const missing = payload(); missing.articles[0].group = 'absent';
  assert.throws(() => parseCatalogImport(missing), fails('catalog_import_group_missing'));
});

test('gzip input is bounded and target selection requires one active nonlegacy company matching name AND organisation number', () => {
  const encoded = gzipSync(JSON.stringify(payload())).toString('base64');
  assert.deepEqual(decodeCatalogImport(encoded), payload());
  for (const bad of ['', 'secret-value-not-base64', Buffer.from('{}').toString('base64'), gzipSync('x'.repeat(1024 * 1024 + 1)).toString('base64')])
    assert.throws(() => decodeCatalogImport(bad), fails('catalog_import_encoding_invalid'));
  assert.deepEqual(selectCatalogImportCompany([company], payload()), company);
  for (const altered of [{ ...company, name: 'Annat AB' }, { ...company, organisationNumber: '5555555555' }, { ...company, status: 'inactive' }, { ...company, id: 'jeroc-demo' }])
    assert.throws(() => selectCatalogImportCompany([altered], payload()), fails('catalog_import_company_missing'));
  assert.throws(() => selectCatalogImportCompany([company, { ...company, id: 'another' }], payload()), fails('catalog_import_company_ambiguous'));
});

test('target-only checks work before pricing thresholds are decided but cannot weaken actual import validation', () => {
  const undecided = payload(); undecided.thresholds = null;
  const encoded = gzipSync(JSON.stringify(undecided)).toString('base64');
  const target = decodeCatalogImportTarget(encoded);
  assert.deepEqual(target.company, undecided.company); assert.equal(target.articleCount, 2); assert.equal(target.groupCount, 2);
  assert.deepEqual(selectCatalogImportCompany([company], target), company);
  assert.throws(() => decodeCatalogImport(encoded), fails('catalog_import_payload_invalid'));
  assert.throws(() => parseCatalogImport(target), fails('catalog_import_payload_invalid'));
  const altered = structuredClone(undecided); altered.company.organisationNumber = 'not-an-org';
  assert.throws(() => decodeCatalogImportTarget(gzipSync(JSON.stringify(altered)).toString('base64')), fails('catalog_import_payload_invalid'));
});

test('read-only readiness checks existing tenant, support identity, empty financial catalog and group conflicts without thresholds or mutation', async () => fixture(async ({ repository }) => {
  const undecided = payload(); undecided.thresholds = null;
  const input = decodeCatalogImportTarget(gzipSync(JSON.stringify(undecided)).toString('base64'));
  const before = await repository.read((state, revision) => ({ state: structuredClone(state), revision }));
  const readonly = { read: (...args) => repository.read(...args), transact: () => { throw new Error('A readiness check must never transact.'); } };
  const result = await checkCatalogImportReadiness({ repository: readonly, input, company });
  assert.equal(result.ready, true); assert.equal(result.existingArticleHistoryCount, 0); assert.equal(result.existingGroupCount, 0);
  assert.deepEqual(await repository.read((state, revision) => ({ state: structuredClone(state), revision })), before);
  const alteredRead = edit => ({ read: operation => repository.read(state => { edit(state); return operation(state); }) });
  for (const [edit, code] of [
    [state => { state.metadata.organisation.id = 'other-tenant'; }, 'catalog_import_tenant_mismatch'],
    [state => { state.metadata.organisation.number = '0000000000'; }, 'catalog_import_tenant_mismatch'],
    [state => { state.pricing.users = [owner]; }, 'catalog_import_support_principal_missing'],
    [state => { state.pricing.users.find(user => user.id === support.id).active = false; }, 'catalog_import_support_principal_missing'],
    [state => { state.pricing.snapshots.push({ id: 'frozen' }); }, 'catalog_import_catalog_not_empty'],
    [state => { state.pricing.ledger.push({ id: 'delivered' }); }, 'catalog_import_catalog_not_empty'],
    [state => { state.pricing.customerPrices.push({ id: 'agreed' }); }, 'catalog_import_catalog_not_empty'],
    [state => { state.pricing.articleHistory.push({ id: 'manual' }); }, 'catalog_import_catalog_not_empty'],
    [state => { state.pricing.groups.push({ id: 'group', name: 'Metall', active: false }); }, 'catalog_import_group_conflict'],
  ]) await assert.rejects(checkCatalogImportReadiness({ repository: alteredRead(edit), input, company }), fails(code));
  assert.deepEqual(await repository.read((state, revision) => ({ state: structuredClone(state), revision })), before);
}));

test('deployment guard rejects other services, domains, demo profiles and missing/non-PostgreSQL storage', () => {
  const env = { RENDER_SERVICE_ID: 'srv-dbba71vf3r2c7384cm7g', SCRAPPLANNER_DEPLOYMENT_MODE: 'pilot', APP_URL: 'https://app.scrapplanner.com', DATABASE_URL: 'postgres://ignored.invalid/database' };
  assert.doesNotThrow(() => assertCatalogImportDeployment(env));
  for (const change of [{ RENDER_SERVICE_ID: 'other' }, { APP_URL: 'https://other.example' }, { SCRAPPLANNER_DEPLOYMENT_MODE: 'demo' }, { DATABASE_URL: undefined }, { DATABASE_URL: 'file:///tmp/data' }])
    assert.throws(() => assertCatalogImportDeployment({ ...env, ...change }), fails('catalog_import_deployment_mismatch'));
  const child = spawnSync(process.execPath, ['scripts/import-company-catalog.mjs', '--payload-env', 'CATALOG_PRIVATE'], {
    env: { ...process.env, ...env, RENDER_SERVICE_ID: 'other', DATABASE_URL: 'postgres://sensitive-password@ignored.invalid/db', CATALOG_PRIVATE: 'private-price-payload' }, encoding: 'utf8',
  });
  assert.equal(child.status, 1); assert.equal(child.stdout, '');
  assert.deepEqual(JSON.parse(child.stderr.trim().split('\n').find(line => line.startsWith('{'))), { verified: false, code: 'catalog_import_deployment_mismatch' });
  assert.ok(!`${child.stdout}${child.stderr}`.includes('sensitive-password')); assert.ok(!`${child.stdout}${child.stderr}`.includes('private-price-payload'));
});

test('durable import uses generated identities, exact fixed A/B/C, audits and preserves all existing users/business data', async () => fixture(async ({ repository, open }) => {
  const before = await repository.read(state => structuredClone(state));
  const result = await importCompanyCatalog({ repository, input: payload(), company });
  assert.equal(result.verified, true); assert.equal(result.duplicate, false); assert.equal(result.articleCount, 2);
  const reopened = await open();
  const after = await reopened.read(state => structuredClone(state));
  assert.deepEqual(after.office, before.office); assert.deepEqual(after.personnel, before.personnel); assert.deepEqual(after.transport, before.transport);
  assert.deepEqual(after.pricing.users, before.pricing.users); assert.deepEqual(after.metadata.pricingSeed, before.metadata.pricingSeed);
  assert.ok(result.articleIds.every(id => /^article-[0-9a-f-]{36}$/.test(id)));
  assert.ok(after.pricing.groups.every(group => /^group-[0-9a-f-]{36}$/.test(group.id)));
  assert.equal(after.metadata.catalogImports[0].sourceReference, payload().importId);
  assert.equal(after.metadata.catalogImports[0].articles.length, 2);
  assert.ok(after.pricing.audit.every(value => value.actor === '__platform-admin' && value.actingUser === '__platform-admin'));
  const store = createPricingStore({ initialState: after.pricing });
  const principal = store.principal('__platform-admin');
  const articles = store.read(principal, '2026-10-20').articles;
  for (const expected of payload().articles) {
    const saved = articles.find(value => value.name === expected.name);
    assert.deepEqual(saved.prices, expected.prices); assert.deepEqual(saved.photos, expected.photos); assert.equal(saved.taxCategory, expected.taxCategory);
    assert.equal(saved.tiers.A.discountPercent, 0); assert.equal(saved.tiers.B.discountPercent, 0); assert.equal(saved.base.type, 'manual');
  }
  const again = await importCompanyCatalog({ repository: reopened, input: payload(), company });
  assert.equal(again.duplicate, true); assert.deepEqual(again.articleIds, result.articleIds);
  assert.deepEqual(await reopened.read(state => structuredClone(state)), after);
}));

test('same import ID with changed prices or new request against nonempty catalog cannot modify committed data', async () => fixture(async ({ repository }) => {
  await importCompanyCatalog({ repository, input: payload(), company });
  const before = await repository.read(state => structuredClone(state));
  const changed = payload(); changed.articles[0].prices.A += 1;
  await assert.rejects(importCompanyCatalog({ repository, input: changed, company }), fails('catalog_import_marker_conflict'));
  const newRequest = payload(); newRequest.importId = 'different-import';
  await assert.rejects(importCompanyCatalog({ repository, input: newRequest, company }), fails('catalog_import_catalog_not_empty'));
  assert.deepEqual(await repository.read(state => structuredClone(state)), before);
}));

test('fractional fixed-price deltas survive persistence and independent verification without changing A/B/C prices', async () => fixture(async ({ repository, open }) => {
  const value = payload();
  const prices = [
    { A: 0.5, B: 0.7, C: 0.7 },
    { A: 0.7, B: 0.5, C: 0.5 },
    { A: 71.23, B: 63.19, C: 63.19 },
    { A: 0.1, B: 0.1, C: 0.1 },
  ];
  value.articles = prices.map((price, index) => ({ ...value.articles[0], name: `Bråkpris ${index + 1}`, prices: price }));
  const result = await importCompanyCatalog({ repository, input: value, company });
  assert.equal(result.verified, true); assert.equal(result.articleCount, prices.length);
  const reopened = await open();
  const state = await reopened.read(state => structuredClone(state));
  const store = createPricingStore({ initialState: state.pricing });
  const articles = store.read(store.principal('__platform-admin'), value.effectiveFrom).articles;
  for (const expected of value.articles) assert.deepEqual(articles.find(article => article.name === expected.name).prices, expected.prices);
  const replay = await importCompanyCatalog({ repository: reopened, input: value, company });
  assert.equal(replay.verified, true); assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.articleIds, result.articleIds);
}));

test('concurrent retries create one atomic catalog and share the generated IDs', async () => fixture(async ({ repository }) => {
  const results = await Promise.all([0, 1, 2].map(() => importCompanyCatalog({ repository, input: payload(), company })));
  assert.equal(results.filter(value => !value.duplicate).length, 1);
  for (const result of results) assert.deepEqual(result.articleIds, results[0].articleIds);
  const state = await repository.read(value => structuredClone(value));
  assert.equal(state.pricing.articleHistory.length, 2); assert.equal(state.pricing.groups.length, 2); assert.equal(state.metadata.catalogImports.length, 1);
}));

test('manual price changes after import make retry fail verification without restoring old prices', async () => fixture(async ({ repository }) => {
  await importCompanyCatalog({ repository, input: payload(), company });
  await repository.transact(state => {
    const store = createPricingStore({ initialState: state.pricing }), admin = store.principal('__platform-admin');
    const old = store.read(admin, '2026-10-20').articles[0];
    store.saveArticle({ ...old, effectiveFrom: '2026-10-20', base: { type: 'manual', price: 99 } }, admin);
    state.pricing = store.exportState();
  });
  const edited = await repository.read(state => structuredClone(state));
  await assert.rejects(importCompanyCatalog({ repository, input: payload(), company }), fails('catalog_import_verification_failed'));
  assert.deepEqual(await repository.read(state => structuredClone(state)), edited);
}));

test('wrong tenant, missing media and conflicting existing groups fail atomically before any persisted article or marker', async () => fixture(async ({ repository }) => {
  const before = await repository.read(state => structuredClone(state));
  const wrong = { ...company, id: 'wrong-tenant' };
  await assert.rejects(importCompanyCatalog({ repository, input: payload(), company: wrong }), fails('catalog_import_tenant_mismatch'));
  await assert.rejects(importCompanyCatalog({ repository, input: payload(), company, validateImages: async () => { throw new CatalogImportError('catalog_import_image_missing'); } }), fails('catalog_import_image_missing'));
  assert.deepEqual(await repository.read(state => structuredClone(state)), before);
  await repository.transact(state => { state.pricing.groups.push({ id: 'manual-group', name: 'Kabel', description: 'Keep manually chosen description', photo: 24, active: true, revision: 1, sortOrder: 10 }); });
  const edited = await repository.read(state => structuredClone(state));
  await assert.rejects(importCompanyCatalog({ repository, input: payload(), company }), fails('catalog_import_group_conflict'));
  assert.deepEqual(await repository.read(state => structuredClone(state)), edited);
}));

test('matching existing group is reused without edits and future effective dates retain exact generated mapping', async () => fixture(async ({ repository }) => {
  await repository.transact(state => { state.pricing.groups.push({ id: 'manual-metal', name: 'Metall', description: 'Rena metaller', photo: 0, active: true, revision: 7, sortOrder: 99 }); });
  const future = payload(); future.effectiveFrom = '2099-01-01';
  await importCompanyCatalog({ repository, input: future, company });
  const state = await repository.read(value => structuredClone(value));
  assert.equal(state.pricing.groups.find(value => value.id === 'manual-metal').revision, 7);
  assert.equal(state.pricing.groups.find(value => value.id === 'manual-metal').sortOrder, 99);
  assert.equal(state.pricing.articleHistory.find(value => value.name === 'Provkoppar').category, 'manual-metal');
}));

test('failed independent post-COMMIT read cannot report success; a retry verifies the durable receipt', async () => fixture(async ({ repository }) => {
  const interrupted = { transact: (...args) => repository.transact(...args), read: async () => { throw new Error('read unavailable'); } };
  await assert.rejects(importCompanyCatalog({ repository: interrupted, input: payload(), company }), /read unavailable/);
  const recovered = await importCompanyCatalog({ repository, input: payload(), company });
  assert.equal(recovered.verified, true); assert.equal(recovered.duplicate, true); assert.equal(recovered.articleCount, 2);
}));
