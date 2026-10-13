import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApplicationRepository } from './application-storage.mjs';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { createMobileEmployeeApi, ensureMobileEmployeeAccounts } from './mobile-employee-api.mjs';
import { rowWeight } from '../dist-server/domain-models.mjs';

const siteCatalog = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }];
const receiptText = 'Färdig vägning mottagen från mobilappen. Ingen attest eller utbetalning gjord.';
async function fixture(run, companyId = 'home-activity-company') {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-home-activity-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite'), SCRAPPILOT_ORGANISATION_ID: companyId };
  const repository = await createApplicationRepository({ env, initial: initialApplicationState });
  const reads = [], read = repository.read.bind(repository);
  repository.read = (callback, options) => { reads.push(options); return read(callback, options); };
  let now = new Date('2026-10-13T08:00:00Z');
  await repository.transact(state => { ensureMobileEmployeeAccounts(state); state.mobile.drafts = []; state.office.cards = []; });
  const api = createMobileEmployeeApi({ getRepository: async () => repository, env, now: () => now, siteProvider: async () => siteCatalog,
    readBody: async req => { let value = ''; for await (const chunk of req) value += chunk; return JSON.parse(value); },
    json: (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); },
  });
  const application = createApplicationService({ repository, env, siteProvider: async () => siteCatalog });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    void (url.pathname.startsWith('/api/employee/') ? api(req, res, url) : application(req, res, url));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const requestPath = async (path, data, cookie, headers = {}) => {
    const result = await fetch(`${base}${path}`, { method: data === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: result.status, cookie: result.headers.get('set-cookie')?.split(';')[0], value: await result.json() };
  };
  const request = (path, ...args) => requestPath(`/api/employee/${path}`, ...args);
  const login = async (username = 'niklas', password = 'Demo123!') => {
    const result = await request('login?view=bootstrap', { username, password });
    assert.equal(result.status, 200, result.value.error); return result;
  };
  const submitted = (state, options = {}) => {
    const sourceId = options.sourceId ?? randomUUID(), number = options.number ?? 3000 + state.mobile.drafts.length;
    const rows = options.rows ?? [{ id: randomUUID(), method: 'direct', articleId: 'copper', weight: options.kg ?? 10 }];
    const draft = { id: sourceId, number, status: 'ready', siteId: options.siteId ?? 'norrtalje', mode: rows.some(row => row.method === 'vehicle') ? 'vehicle' : 'direct', rows,
      createdAt: '1999-01-01T00:00:00Z', updatedAt: options.clientTime ?? '1999-01-01T00:00:00Z', reference: 'SECRET-REFERENCE', origin: 'SECRET-ORIGIN' };
    const event = { at: options.at ?? '2026-10-13T06:00:00Z', actor: 'Misleading displayed name', actualUserId: options.actualUserId ?? 'mobile-demo',
      effectiveUserId: options.effectiveUserId ?? 'mobile-demo', text: receiptText };
    const card = { id: number, sourceId, siteId: draft.siteId, status: 'new', kind: 'delivery', date: '1999-01-01T00:00:00Z', weigher: 'Wrong display name',
      customerId: 'SECRET-CUSTOMER', paymentDetails: { account: 'SECRET-BANK' }, rows: [{ articleId: 'copper', weight: 999999, price: 999999 }], audit: [event] };
    state.mobile.drafts.push(draft); state.office.cards.push(card);
    state.metadata.mobileDraftSites ??= {}; state.metadata.mobileDraftSites[sourceId] = draft.siteId;
    const receipt = { sourceId, cardId: number, siteId: draft.siteId, actualUserId: event.actualUserId,
      effectiveUserId: event.effectiveUserId, submittedAt: event.at, weighedKg: rows.reduce((sum, row) => sum + rowWeight(row), 0) };
    if (options.seal !== false) {
      state.metadata.mobileSubmissionReceipts ??= []; state.metadata.mobileSubmissionReceipts.push(receipt);
    }
    return { draft, card, event, receipt };
  };
  try { await run({ repository, reads, request, requestPath, login, submitted, base, clock: value => { now = new Date(value); } }); }
  finally { await new Promise(done => server.close(done)); await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('home totals use the actual receipt operator, server Stockholm date and unique submitted net weight without customer or monthly history', async () => fixture(async ({ repository, reads, request, login, submitted }) => {
  await repository.transact(state => {
    const first = submitted(state, { rows: [{ id: 'r1', method: 'direct', articleId: 'copper', weight: 12.345 }, { id: 'r2', method: 'direct', articleId: 'brass', weight: 2.001 }] });
    state.mobile.drafts.push(structuredClone(first.draft)); state.office.cards.push(structuredClone(first.card));
    first.card.audit.push({ ...first.event, at: '2026-10-13T07:00:00Z', text: 'Priser ändrade senare av servern.' });
    submitted(state, { at: '2026-10-12T22:05:00Z', rows: [{ id: 'vehicle', method: 'vehicle', articleId: 'copper', gross: 1000, tare: 700, deduction: 20, deductionReason: 'Verkligt avdrag', registration: 'ABC123' }] });
    submitted(state, { kg: 7, actualUserId: 'mobile-demo', effectiveUserId: 'admin' });
    submitted(state, { kg: 100, actualUserId: 'admin', effectiveUserId: 'mobile-demo' });
    submitted(state, { kg: 200, at: '2026-10-12T21:59:59Z', clientTime: '2026-10-13T07:00:00Z' });
    submitted(state, { kg: 300, at: '2026-10-13T22:00:00Z' });
    submitted(state, { kg: 25, siteId: 'rimbo' });
    state.employeeTime.entries.push({ id: 'past-time', personId: 'person-mobile-demo', date: '2026-09-01', revision: 1, startMinute: 420, endMinute: 480, breakMinutes: 0,
      activity: 'SECRET-PAST-MONTH-HISTORY', note: '' });
  });
  const own = await login();
  assert.equal(own.value.monthLoaded, false); assert.equal(own.value.days.length, 1);
  assert.deepEqual(own.value.homeActivity, { date: '2026-10-13', siteId: 'norrtalje', completedWeighings: 3, weighedKg: 301.346 });
  const before = await repository.read((state, revision) => ({ state: structuredClone(state), revision }));
  const refresh = await request('session?view=bootstrap&siteId=rimbo&personId=person-mobile-admin', undefined, own.cookie, { 'x-demo-actor': 'admin' });
  assert.deepEqual(refresh.value.homeActivity, own.value.homeActivity);
  assert.equal(reads.at(-1).domains.includes('office'), false, 'light bootstrap must not fetch office cards/customers');
  assert.equal(reads.at(-1).domains.includes('mobile'), false, 'light bootstrap must not fetch weighing history');
  for (const marker of ['SECRET-REFERENCE', 'SECRET-ORIGIN', 'SECRET-CUSTOMER', 'SECRET-BANK', 'SECRET-PAST-MONTH-HISTORY', '999999']) {
    assert.equal(JSON.stringify(refresh.value).includes(marker), false, marker);
  }
  assert.deepEqual(await repository.read((state, revision) => ({ state: structuredClone(state), revision })), before, 'GET only derives totals');
  const full = await request('overview?month=2026-09&date=2026-09-01', undefined, own.cookie);
  assert.equal(full.value.monthLoaded, true); assert.deepEqual(full.value.homeActivity, own.value.homeActivity, 'historical time selection does not change today weighing metrics');
  const support = await login('admin', 'JerocDemo2026!');
  assert.deepEqual(support.value.homeActivity, { date: '2026-10-13', siteId: 'norrtalje', completedWeighings: 1, weighedKg: 100 }, 'support work is credited to its actual actor, not impersonated staff');
}));

test('drafts, missing or unverifiable receipts, nonpositive weights, deleted originals and copied corrections never become completed weighings', async () => fixture(async ({ repository, requestPath, login, submitted }) => {
  await repository.transact(state => {
    submitted(state, { kg: 5 });
    submitted(state, { kg: 50 }).draft.status = 'draft';
    submitted(state, { kg: 50 }).draft.status = 'awaiting-exit';
    submitted(state, { kg: 50 }).draft.deletedAt = '2026-10-13T07:00:00Z';
    submitted(state, { kg: 50 }).card.deletedAt = '2026-10-13T07:00:00Z';
    submitted(state, { kg: 50 }).card.kind = 'correction';
    submitted(state, { kg: 50 }).card.workOrderId = 'AO-linked';
    submitted(state, { kg: 50, seal: false }).card.audit = [];
    submitted(state, { kg: 50 }).receipt.actualUserId = undefined;
    submitted(state, { kg: 50, seal: false }).event.text = 'Unverified legacy weighing by Niklas';
    submitted(state, { kg: 50 }).receipt.submittedAt = 'invalid-date';
    submitted(state, { kg: 0 });
    submitted(state, { rows: [] });
    submitted(state, { rows: [{ id: 'partial-vehicle', method: 'vehicle', articleId: 'copper', gross: 1000, deduction: 0 }] });
    const wrongCardId = submitted(state, { kg: 50 }); wrongCardId.card.id += 5000;
    const wrongSource = submitted(state, { kg: 50 }); wrongSource.card.sourceId = randomUUID();
    const missingCard = submitted(state, { kg: 50 }); state.office.cards = state.office.cards.filter(card => card !== missingCard.card);
    const missingDraft = submitted(state, { kg: 50 }); state.mobile.drafts = state.mobile.drafts.filter(draft => draft !== missingDraft.draft);
    const changedSite = submitted(state, { kg: 50 }); state.metadata.mobileDraftSites[changedSite.draft.id] = 'rimbo';
  });
  const reconciled = await requestPath('/api/application/office', { kind: 'archive', data: { legacy: true } }, undefined,
    { 'x-demo-actor': 'admin', 'x-demo-user': 'admin' });
  assert.equal(reconciled.status, 200, reconciled.value.error);
  const own = await login();
  assert.deepEqual(own.value.homeActivity, { date: '2026-10-13', siteId: 'norrtalje', completedWeighings: 1, weighedKg: 5 });
}));

test('selected facility and current person/account capability intersections gate home statistics, not browser parameters', async () => fixture(async ({ repository, request, login, submitted }) => {
  await repository.transact(state => {
    const person = state.personnel.people.find(value => value.userId === 'mobile-demo'); person.siteIds = ['norrtalje', 'rimbo'];
    state.pricing.users.find(user => user.id === person.userId).siteIds = ['norrtalje', 'rimbo'];
    submitted(state, { kg: 10 }); submitted(state, { kg: 25, siteId: 'rimbo' });
  });
  const own = await login();
  const selected = await request('active-site?view=bootstrap', { siteId: 'rimbo' }, own.cookie);
  assert.deepEqual(selected.value.homeActivity, { date: '2026-10-13', siteId: 'rimbo', completedWeighings: 1, weighedKg: 25 });
  await repository.transact(state => { state.pricing.users.find(user => user.id === 'mobile-demo').siteIds = ['norrtalje']; });
  const revokedSite = await request('session?view=bootstrap', undefined, own.cookie);
  assert.equal(revokedSite.value.activeSiteId, 'norrtalje');
  assert.deepEqual(revokedSite.value.homeActivity, own.value.homeActivity);
  await repository.transact(state => { state.pricing.users.find(user => user.id === 'mobile-demo').permissions = ['view']; });
  const noYardWork = await request('session?view=bootstrap', undefined, own.cookie);
  assert.equal(noYardWork.value.capabilities.yardWork, false); assert.equal(noYardWork.value.homeActivity, undefined);
  await repository.transact(state => { const user = state.pricing.users.find(user => user.id === 'mobile-demo'); user.permissions = ['view', 'prepare']; user.siteIds = []; });
  const noAllowedSites = await request('session?view=bootstrap', undefined, own.cookie);
  assert.deepEqual(noAllowedSites.value.sites, []); assert.equal(noAllowedSites.value.homeActivity, undefined);
  assert.equal((await request('session?view=bootstrap')).status, 401);
  assert.equal((await request('session?view=bootstrap', undefined, 'jeroc_employee=invalid', { 'x-demo-mobile': 'niklas' })).status, 401);
}));

test('identical user and facility identifiers in different company repositories never share totals or sessions', async () => fixture(async a => {
  await a.repository.transact(state => a.submitted(state, { kg: 10 }));
  const ownA = await a.login();
  await fixture(async b => {
    await b.repository.transact(state => b.submitted(state, { kg: 90 }));
    assert.equal((await b.request('session?view=bootstrap', undefined, ownA.cookie)).status, 401);
    const ownB = await b.login();
    assert.equal(ownB.value.companyId, 'home-company-b');
    assert.equal(ownB.value.homeActivity.weighedKg, 90);
    assert.equal(ownA.value.companyId, 'home-company-a');
    assert.equal((await a.request('session?view=bootstrap', undefined, ownA.cookie)).value.homeActivity.weighedKg, 10);
  }, 'home-company-b');
}, 'home-company-a'));

test('a later customer price question cannot erase the original completed physical submission', async () => fixture(async ({ repository, request, login, submitted }) => {
  await repository.transact(state => submitted(state, { kg: 12.345 }));
  const own = await login();
  await repository.transact(state => {
    state.office.cards[0].status = 'complement';
    state.office.cards[0].customerApproval = { id: 'approval', version: 1, status: 'change_requested', updatedAt: '2026-10-13T07:00:00Z' };
    state.office.cards[0].rows[0].weight = 999;
    state.mobile.drafts[0].rows[0].weight = 888;
    state.office.cards[0].audit.push({ at: '2026-10-13T07:00:00Z', actualUserId: 'admin', effectiveUserId: 'admin', text: 'Kundens prisfråga granskas.' });
  });
  const current = await request('session?view=bootstrap', undefined, own.cookie);
  assert.deepEqual(current.value.homeActivity, own.value.homeActivity);
  assert.equal(current.value.homeActivity.weighedKg, 12.345, 'summary represents immutable original mobile weight, not later financial or material edits');
}));

test('only a real accepted mobile completion seals one receipt; replay, forged metadata, editable audit and legacy imports cannot mint receipts', async () => fixture(async ({ repository, request, requestPath, login, clock }) => {
  clock(new Date().toISOString());
  const own = await login();
  const draft = { id: randomUUID(), siteId: 'norrtalje', number: 1, mode: 'direct', status: 'ready',
    createdAt: '1999-01-01T00:00:00Z', updatedAt: '1999-01-01T00:00:00Z', reference: '', origin: 'Testgatan 1',
    rows: [{ id: randomUUID(), articleId: 'copper-1', method: 'direct', weight: 12.345 }] };
  const command = { kind: 'records', version: 1, drafts: [{ id: draft.id, next: draft }], customers: [] };
  const fake = { sourceId: draft.id, cardId: 1, siteId: 'norrtalje', actualUserId: 'admin',
    submittedAt: new Date().toISOString(), weighedKg: 900000 };
  const rejected = await requestPath('/api/application/mobile', { ...command, metadata: { mobileSubmissionReceipts: [fake] } }, own.cookie);
  assert.equal(rejected.status, 422);
  const startedAt = Date.now();
  const saved = await requestPath('/api/application/mobile', command, own.cookie);
  assert.equal(saved.status, 200, saved.value.error);
  assert.equal(JSON.stringify(saved.value).includes('mobileSubmissionReceipts'), false);
  const original = await repository.read(state => structuredClone(state.metadata.mobileSubmissionReceipts));
  assert.equal(original.length, 1);
  assert.deepEqual({ ...original[0], submittedAt: undefined }, { sourceId: draft.id,
    cardId: saved.value.data.drafts.find(value => value.id === draft.id).number, siteId: 'norrtalje', actualUserId: 'mobile-demo',
    effectiveUserId: 'mobile-demo', weighedKg: 12.345, submittedAt: undefined });
  assert.ok(Date.parse(original[0].submittedAt) >= startedAt && Date.parse(original[0].submittedAt) <= Date.now());
  assert.equal((await requestPath('/api/application/mobile', command, own.cookie)).status, 200);
  assert.deepEqual(await repository.read(state => state.metadata.mobileSubmissionReceipts), original);

  const admin = { 'x-demo-actor': 'admin', 'x-demo-user': 'admin' };
  const base = (await requestPath('/api/application/office', undefined, undefined, admin)).value.data;
  const next = structuredClone(base);
  next.cards[0].audit = [{ at: new Date().toISOString(), actor: 'Forged operator', actualUserId: 'admin', effectiveUserId: 'admin', text: receiptText }];
  next.metadata = { mobileSubmissionReceipts: [fake] };
  const changed = await requestPath('/api/application/office', { base, next, metadata: { mobileSubmissionReceipts: [fake] } }, undefined, admin);
  assert.equal(changed.status, 200, changed.value.error);
  assert.deepEqual(await repository.read(state => state.metadata.mobileSubmissionReceipts), original);
  assert.equal((await request('session?view=bootstrap', undefined, own.cookie)).value.homeActivity.weighedKg, 12.345);

  const legacy = { ...draft, id: randomUUID(), number: 9000, rows: [{ ...draft.rows[0], id: randomUUID(), weight: 200 }] };
  const imported = await requestPath('/api/application/mobile', { kind: 'import', data: { version: 1, drafts: [legacy], customers: [],
    metadata: { mobileSubmissionReceipts: [fake] } } }, own.cookie);
  assert.equal(imported.status, 200, imported.value.error);
  assert.ok(await repository.read(state => state.office.cards.some(card => card.sourceId === legacy.id)));
  assert.deepEqual(await repository.read(state => state.metadata.mobileSubmissionReceipts), original, 'legacy ready cards never backfill completion receipts');
  const refreshed = await request('session?view=bootstrap', undefined, own.cookie);
  assert.equal(refreshed.value.homeActivity.completedWeighings, 1);
  assert.equal(refreshed.value.homeActivity.weighedKg, 12.345);
}));

test('invalidating an original permanently voids its receipt; returning the old identity never reactivates it', async () => fixture(async ({ repository, request, requestPath, login, clock }) => {
  clock(new Date().toISOString());
  const own = await login();
  const source = randomUUID();
  const draft = { id: source, siteId: 'norrtalje', number: 1, mode: 'direct', status: 'ready',
    createdAt: '1999-01-01T00:00:00Z', updatedAt: '1999-01-01T00:00:00Z', reference: '', origin: 'Testgatan 1',
    rows: [{ id: randomUUID(), articleId: 'copper-1', method: 'direct', weight: 12.345 }] };
  const saved = await requestPath('/api/application/mobile', { kind: 'records', version: 1, drafts: [{ id: source, next: draft }], customers: [] }, own.cookie);
  assert.equal(saved.status, 200, saved.value.error);
  const admin = { 'x-demo-actor': 'admin', 'x-demo-user': 'admin' };
  const base = (await requestPath('/api/application/office', undefined, undefined, admin)).value.data;
  const next = structuredClone(base); next.cards[0].sourceId = randomUUID();
  const invalidated = await requestPath('/api/application/office', { base, next }, undefined, admin);
  assert.equal(invalidated.status, 200, invalidated.value.error);
  const voided = await repository.read(state => structuredClone(state.metadata.mobileSubmissionReceipts[0]));
  assert.ok(Number.isFinite(Date.parse(voided.voidedAt)));
  assert.equal((await request('session?view=bootstrap', undefined, own.cookie)).value.homeActivity.completedWeighings, 0);
  const restored = structuredClone(invalidated.value.data); restored.cards[0].sourceId = source;
  const result = await requestPath('/api/application/office', { base: invalidated.value.data, next: restored }, undefined, admin);
  assert.equal(result.status, 200, result.value.error);
  assert.deepEqual(await repository.read(state => state.metadata.mobileSubmissionReceipts[0]), voided);
  assert.equal((await request('session?view=bootstrap', undefined, own.cookie)).value.homeActivity.completedWeighings, 0);
}));
