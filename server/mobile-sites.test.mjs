import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { ensureLogistics } from './logistics.mjs';

const mobile = '/api/application/mobile';
const draft = (patch = {}) => ({ id: randomUUID(), siteId: 'rimbo', number: 1, mode: 'direct', status: 'draft',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reference: '', origin: '',
  rows: [{ id: randomUUID(), articleId: 'iron', method: 'direct', weight: 10 }], ...patch });
const records = (next, base) => ({ kind: 'records', version: 1, drafts: [{ id: next.id, next, ...(base ? { base } : {}) }], customers: [] });

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-mobile-sites-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'business.sqlite') };
  const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true },
    { id: 'inactive', name: 'Avaktiverad', active: false }, { id: 'third-yard', name: 'Tredje gården', active: true }];
  const apps = [], servers = [];
  async function instance() {
    const app = createApplicationService({ env, siteProvider: async () => sites }); apps.push(app);
    const server = createServer((req, res) => { void app(req, res, new URL(req.url, 'http://localhost')); }); servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, data, cookie, actor = 'admin') => {
      const response = await fetch(`${url}${path}`, { method: data === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-demo-actor': actor, 'x-demo-user': actor, ...(cookie ? { cookie } : {}) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], ...await response.json() };
    };
    return { app, request };
  }
  const { app, request } = await instance();
  const repository = await app.getRepository();
  await repository.transact(state => {
    const person = state.personnel.people.find(value => value.userId === 'mobile-demo');
    person.siteIds = ['norrtalje', 'rimbo', 'inactive'];
    state.pricing.users.find(value => value.id === person.userId).siteIds = ['norrtalje', 'rimbo', 'inactive', 'third-yard'];
    ensureLogistics(state, { sites, classifications: [] });
  });
  const login = async () => {
    const value = await request('/api/employee/login', { username: 'niklas', password: 'Demo123!' });
    assert.equal(value.status, 200, value.error); return value;
  };
  try { await run({ request, login, repository, instance, sites }); }
  finally {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    for (const value of apps) await value.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('new mobile drafts require captured active tenant sites from the authoritative linked account', async () => fixture(async ({ request, login, repository }) => {
  const employee = await login();
  const missing = draft(); delete missing.siteId;
  assert.equal((await request(mobile, records(missing), employee.cookie)).status, 422);
  for (const siteId of ['inactive', 'unknown'])
    assert.equal((await request(mobile, records(draft({ siteId })), employee.cookie)).status, 403);
  assert.ok(employee.sites.some(site => site.id === 'third-yard'), 'The linked account grants the third facility despite an older person scope.');
  await repository.transact(state => { state.pricing.users.find(value => value.id === 'mobile-demo').siteIds = ['norrtalje']; });
  assert.equal((await request(mobile, records(draft()), employee.cookie)).status, 403);
  const saved = await request(mobile, records(draft({ siteId: 'norrtalje' })), employee.cookie);
  assert.equal(saved.status, 200, saved.error); assert.equal(saved.data.drafts[0].siteId, 'norrtalje');
  assert.equal(saved.data.drafts.length, 1);
}));

test('a newly registered facility supplies the site ID and name for cards and stock without a demo-yard fallback', async () => fixture(async ({ request, login, repository }) => {
  await repository.transact(state => {
    state.personnel.people.find(value => value.userId === 'mobile-demo').siteIds = ['third-yard'];
    state.pricing.users.find(value => value.id === 'mobile-demo').siteIds = ['third-yard'];
  });
  const employee = await login(); assert.equal(employee.activeSiteId, 'third-yard');
  assert.deepEqual(employee.sites.map(value => value.id), ['third-yard']);
  const weighing = draft({ siteId: employee.activeSiteId, status: 'ready' });
  const created = await request(mobile, records(weighing), employee.cookie);
  assert.equal(created.status, 200, created.error);
  const state = await repository.read(state => structuredClone(state));
  const card = state.office.cards.find(value => value.sourceId === weighing.id);
  assert.equal(card.siteId, 'third-yard'); assert.equal(card.yard, 'Tredje gården');
  assert.deepEqual(state.logistics.inventoryMovements.filter(value => value.sourceId === weighing.id).map(value => value.siteId), ['third-yard']);
}));

test('queued weighings retain their original site through active changes, retries, card creation and incoming stock', async () => fixture(async ({ request, login, repository, instance, sites }) => {
  const employee = await login();
  const selected = await request('/api/employee/active-site', { siteId: 'rimbo' }, employee.cookie);
  assert.equal(selected.activeSiteId, 'rimbo');
  const queued = draft({ siteId: selected.activeSiteId });
  assert.equal((await request('/api/employee/active-site', { siteId: 'norrtalje' }, employee.cookie)).activeSiteId, 'norrtalje');
  const response = await request(mobile, records(queued), employee.cookie);
  assert.equal(response.status, 200, response.error);
  const saved = response.data.drafts[0]; assert.equal(saved.siteId, 'rimbo');
  assert.equal((await request(mobile, records({ ...saved, siteId: 'norrtalje' }, saved), employee.cookie)).status, 409);
  const legacyBase = { ...saved }; delete legacyBase.siteId;
  const edited = await request(mobile, records({ ...legacyBase, reference: 'Från den första gården' }, legacyBase), employee.cookie);
  assert.equal(edited.status, 200, edited.error); assert.equal(edited.data.drafts[0].siteId, 'rimbo');
  sites.find(value => value.id === 'rimbo').active = false;
  const current = edited.data.drafts[0], complete = { ...current, status: 'ready' };
  const input = records(complete, current);
  assert.equal((await request(mobile, input, employee.cookie)).status, 200);
  const nextInstance = await instance();
  assert.equal((await nextInstance.request(mobile, input, employee.cookie)).status, 200);
  const live = await repository.read(state => structuredClone(state));
  const cards = live.office.cards.filter(value => value.sourceId === queued.id);
  assert.equal(cards.length, 1); assert.equal(cards[0].siteId, 'rimbo'); assert.equal(cards[0].id, saved.number);
  assert.equal(live.metadata.mobileDraftSites[queued.id], 'rimbo');
  assert.deepEqual(live.logistics.inventoryMovements.filter(value => value.sourceId === queued.id).map(({ siteId, kg }) => ({ siteId, kg })), [{ siteId: 'rimbo', kg: 10 }]);
  assert.equal((await nextInstance.request('/api/employee/session', undefined, employee.cookie)).activeSiteId, 'norrtalje');
}));

test('historical metadata and linked source cards hydrate immutable sites without rewriting orders or ready cards', async () => fixture(async ({ request, login, repository }) => {
  const fromMetadata = draft(); delete fromMetadata.siteId;
  const fromCard = draft({ status: 'ready' }); delete fromCard.siteId;
  await repository.transact(state => {
    state.mobile.drafts.push(fromMetadata, fromCard);
    state.metadata.mobileDraftSites = { [fromMetadata.id]: 'rimbo' };
    state.office.cards.push({ ...structuredClone(state.office.cards[0]), id: 7001, sourceId: fromCard.id, siteId: 'rimbo', workOrderId: 'AO-site-test' });
  });
  const employee = await login();
  const projection = await request(mobile, undefined, employee.cookie);
  assert.deepEqual(projection.data.drafts.map(value => value.siteId), ['rimbo', 'rimbo']);
  const originalCard = await repository.read(state => structuredClone(state.office.cards.find(value => value.sourceId === fromCard.id)));
  const submitted = await request(mobile, records({ ...fromMetadata, status: 'ready' }, fromMetadata), employee.cookie);
  assert.equal(submitted.status, 200, submitted.error);
  const replay = await request(mobile, records(fromCard), employee.cookie);
  assert.equal(replay.status, 200, replay.error);
  const state = await repository.read(state => structuredClone(state));
  assert.equal(state.office.cards.find(value => value.sourceId === fromMetadata.id).siteId, 'rimbo');
  assert.deepEqual(state.office.cards.find(value => value.sourceId === fromCard.id), originalCard);
  assert.equal(state.office.cards.filter(value => value.sourceId === fromCard.id).length, 1);
}));

test('legacy imports archive unlocated records and use explicit or historical sites without current-choice inference', async () => fixture(async ({ request, login, repository }) => {
  const unknown = draft(); delete unknown.siteId;
  const explicit = draft({ status: 'ready' });
  const evidenced = draft({ status: 'ready' }); delete evidenced.siteId;
  await repository.transact(state => { state.metadata.mobileDraftSites = { [evidenced.id]: 'rimbo' }; });
  const employee = await login(); assert.equal(employee.activeSiteId, 'norrtalje');
  const data = { version: 1, drafts: [unknown, explicit, evidenced], customers: [] };
  const imported = await request(mobile, { kind: 'import', data }, employee.cookie);
  assert.equal(imported.status, 200, imported.error); assert.equal(imported.importConflicts, 1); assert.equal(imported.importArchived, true);
  assert.deepEqual(imported.data.drafts.map(value => value.siteId), ['rimbo', 'rimbo']);
  const again = await request(mobile, { kind: 'import', data }, employee.cookie); assert.equal(again.status, 200);
  const state = await repository.read(state => structuredClone(state));
  assert.equal(state.imports.filter(value => value.domain === 'mobile').length, 1);
  assert.equal(state.imports.find(value => value.domain === 'mobile').original.drafts[0].siteId, undefined);
  assert.equal(state.mobile.drafts.some(value => value.id === unknown.id), false);
  assert.deepEqual(state.office.cards.filter(value => [explicit.id, evidenced.id].includes(value.sourceId)).map(value => value.siteId), ['rimbo', 'rimbo']);
}));

test('restoring a historical source ID preserves its site, number and work-order card through every creation path', async () => fixture(async ({ request, login, repository }) => {
  const restored = draft({ status: 'ready' });
  await repository.transact(state => {
    state.metadata.mobileDraftSites = { [restored.id]: 'rimbo' };
    state.office.cards.push({ ...structuredClone(state.office.cards[0]), id: 7002, sourceId: restored.id, siteId: 'rimbo', workOrderId: 'AO-restored-site' });
  });
  const employee = await login();
  const original = await repository.read(state => structuredClone(state.office.cards.find(value => value.sourceId === restored.id)));
  assert.equal((await request(mobile, records({ ...restored, siteId: 'norrtalje' }), employee.cookie)).status, 409);
  const wrongImport = await request(mobile, { kind: 'import', data: { version: 1, drafts: [{ ...restored, siteId: 'norrtalje' }], customers: [] } }, employee.cookie);
  assert.equal(wrongImport.status, 200); assert.equal(wrongImport.importConflicts, 1); assert.equal(wrongImport.data.drafts.length, 0);
  const restoredResponse = await request(mobile, records(restored), employee.cookie);
  assert.equal(restoredResponse.status, 200, restoredResponse.error); assert.equal(restoredResponse.data.drafts[0].number, original.id);
  const state = await repository.read(state => structuredClone(state));
  assert.equal(state.metadata.mobileDraftSites[restored.id], 'rimbo');
  assert.deepEqual(state.office.cards.find(value => value.sourceId === restored.id), original);
  assert.equal(state.office.cards.filter(value => value.sourceId === restored.id).length, 1);
}));

test('unlocated historical drafts fail clearly and malicious IDs cannot select inherited metadata properties', async () => fixture(async ({ request, repository }) => {
  const unknown = draft(); delete unknown.siteId;
  await repository.transact(state => { state.mobile.drafts.push(unknown); });
  const changed = await request(mobile, records({ ...unknown, reference: 'Historik' }, unknown));
  assert.equal(changed.status, 422); assert.match(changed.error, /saknar sparad anläggning/);
  const valid = draft({ id: '__proto__', siteId: 'rimbo' });
  const saved = await request(mobile, records(valid)); assert.equal(saved.status, 200, saved.error);
  assert.equal(saved.data.drafts.find(value => value.id === valid.id).siteId, 'rimbo');
  const metadata = await repository.read(state => structuredClone(state.metadata.mobileDraftSites));
  assert.equal(Object.hasOwn(metadata, '__proto__'), true); assert.equal(metadata.__proto__, 'rimbo');
}));
