import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { ensurePersonnel, refreshStaffingTasks } from './personnel.mjs';
import { ensureLogistics } from './logistics.mjs';

const sites = [{ id: 'norrtalje', name: 'Norrtälje', city: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', city: 'Rimbo', active: true }];
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(run) {
  const state = initialApplicationState();
  ensurePersonnel(state); ensureLogistics(state, { sites });
  // Unrelated integration and answer history must not enter these read paths.
  state.integrationHistory = { unrelated: 'x'.repeat(100_000) };
  let revision = 0;
  const reads = [], writes = [];
  const repository = {
    kind: 'test',
    async read(operation, { domains } = {}) {
      reads.push(domains);
      const snapshot = structuredClone(domains ? Object.fromEntries(domains.filter(domain => Object.hasOwn(state, domain)).map(domain => [domain, state[domain]])) : state);
      return operation(snapshot, revision);
    },
    async transact(operation) {
      writes.push(true);
      const before = JSON.stringify(state), result = await operation(state, revision, []);
      if (before !== JSON.stringify(state)) revision++;
      return result;
    },
    async close() {},
  };
  let siteReads = 0, environmentReads = 0;
  const app = createApplicationService({ repository, siteProvider: async () => { siteReads++; return sites; }, environmentProvider: async () => { environmentReads++; return { classifications: [], inventory: [] }; } });
  await app.getRepository(); // The one-time legacy migration is a real startup write.
  const reset = () => { reads.length = 0; writes.length = 0; siteReads = 0; environmentReads = 0; };
  reset();
  const server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = async (path, { actor = 'admin', cookie, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(actor ? { 'x-demo-actor': actor, 'x-demo-user': actor } : {}), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  try { await run({ state, reads, writes, request, reset, providerCalls: () => ({ siteReads, environmentReads }), revision: () => revision }); }
  finally { await new Promise(resolve => server.close(resolve)); await app.close(); }
}

test('work-order menu count is a single selected-domain read with facility and permission isolation', () => fixture(async ({ state, reads, writes, request, reset, providerCalls }) => {
  const scoped = state.pricing.users.find(user => user.id === 'kajsa');
  scoped.level = 'Medarbetare'; scoped.permissions = ['workOrdersRead']; scoped.siteIds = ['rimbo'];
  const [first, second] = state.transport.orders;
  first.siteId = 'norrtalje'; second.siteId = 'rimbo';
  first.status = second.status = 'unbooked';
  const baseline = structuredClone(state);
  const all = await request('/api/logistics/summary');
  assert.equal(all.status, 200, all.value.error);
  assert.equal(all.value.workOrders, state.transport.orders.filter(order => !['done', 'cancelled'].includes(order.status)).length);
  assert.deepEqual(Object.keys(all.value).sort(), ['revision', 'workOrders']);
  assert.deepEqual(reads, [['pricing', 'transport', 'logistics']]);
  assert.equal(writes.length, 0); assert.deepEqual(providerCalls(), { siteReads: 0, environmentReads: 0 });
  reset();
  const own = await request('/api/logistics/summary?siteId=rimbo', { actor: 'kajsa' });
  assert.equal(own.status, 200); assert.equal(own.value.workOrders, 1);
  assert.equal((await request('/api/logistics/summary?siteId=norrtalje', { actor: 'kajsa' })).status, 403);
  assert.equal((await request('/api/logistics/summary', { actor: null })).status, 401);
  scoped.permissions = [];
  assert.equal((await request('/api/logistics/summary', { actor: 'kajsa' })).status, 403);
  scoped.permissions = ['workOrdersRead'];
  assert.equal((await request('/api/logistics/summary', { body: {} })).status, 405);
  assert.equal(writes.length, 0); assert.deepEqual(state, baseline);
}));

test('revision recovery verifies live permissions and cookies without returning business data or writing', () => fixture(async ({ state, writes, request, revision }) => {
  const before = JSON.stringify(state), current = revision();
  const result = await request('/api/application/revision?domain=office');
  assert.equal(result.status, 200);
  assert.deepEqual(result.value, { domain: 'office', revision: current });
  assert.equal((await request('/api/application/revision?domain=office', { actor: null })).status, 401);
  assert.equal((await request('/api/application/revision?domain=invalid')).status, 404);
  const user = state.pricing.users.find(value => value.id === 'kajsa');
  const saved = structuredClone(user);
  Object.assign(user, { level: 'Medarbetare', permissions: [] });
  assert.equal((await request('/api/application/revision?domain=office', { actor: 'kajsa' })).status, 403);
  user.permissions = ['transportRead']; user.siteIds = ['norrtalje'];
  assert.equal((await request('/api/application/revision?domain=transport', { actor: 'kajsa' })).status, 403);
  Object.assign(user, saved); if (!Object.hasOwn(saved, 'siteIds')) delete user.siteIds;
  assert.equal((await request('/api/application/revision?domain=mobile', { cookie: 'jeroc_employee=expired' })).status, 401);
  assert.equal(writes.length, 0); assert.equal(revision(), current); assert.equal(JSON.stringify(state), before);
}));

test('personnel and full logistics views do not persist derived work or acquire the business write lock', () => fixture(async ({ state, reads, writes, request, revision }) => {
  const order = state.transport.orders.find(order => order.driverId === 'kalle' && order.status === 'booked');
  state.personnel.absences.push({ id: 'read-only-absence', personId: 'person-kalle', kind: 'sick', fromDate: order.date, toDate: order.date, allDay: true, status: 'registered', managerId: 'person-anna', revision: 0 });
  const before = structuredClone(state), beforeRevision = revision();
  const personnel = await request('/api/application/personnel');
  assert.equal(personnel.status, 200, personnel.value.error);
  const task = personnel.value.data.staffingTasks.find(task => task.absenceId === 'read-only-absence');
  assert.ok(task);
  const repeated = await request('/api/application/personnel');
  assert.equal(repeated.value.data.staffingTasks.find(item => item.absenceId === task.absenceId && item.orderId === task.orderId).id, task.id);
  const planning = await request('/api/application/personnel?view=planning', { actor: 'kajsa' });
  assert.equal(planning.status, 200); assert.deepEqual(planning.value.data.salaries, []);
  assert.ok(planning.value.data.people.every(person => !person.userId && !person.phone && !person.email));
  const logistics = await request('/api/logistics/office');
  assert.equal(logistics.status, 200, logistics.value.error);
  assert.equal(writes.length, 0); assert.equal(revision(), beforeRevision); assert.deepEqual(state, before);
  assert.ok(reads.every(domains => !domains.includes('integrationHistory') && !domains.includes('employeeTime')));
  assert.deepEqual(reads[0], ['pricing', 'personnel', 'transport']);
  // A later real command derives the same task id, so selecting a task from a
  // read-only page is safe even before its first durable maintenance command.
  refreshStaffingTasks(state);
  assert.equal(state.personnel.staffingTasks.find(item => item.absenceId === task.absenceId && item.orderId === task.orderId).id, task.id);
}));

test('driver GET expires sessions without pruning auth records or fetching irrelevant stock domains', () => fixture(async ({ state, reads, writes, request }) => {
  const person = state.personnel.people.find(person => person.id === 'person-oskar');
  state.personnelAuth.accounts.push({ personId: person.id, username: 'read.test', active: true });
  state.personnelAuth.sessions.push({ tokenHash: hash('valid-driver'), personId: person.id, companyId: person.companyId, expiresAt: new Date(Date.now() + 60_000).toISOString() }, { tokenHash: hash('expired-driver'), personId: person.id, companyId: person.companyId, expiresAt: '2020-01-01T00:00:00.000Z' });
  state.personnelAuth.attempts.push({ address: 'old', at: '2020-01-01T00:00:00.000Z' });
  const before = structuredClone(state);
  for (const path of ['session', 'orders']) {
    const result = await request(`/api/driver/${path}`, { actor: null, cookie: 'jeroc_driver=valid-driver' });
    assert.equal(result.status, 200, result.value.error);
    if (path === 'orders') assert.ok(result.value.orders.every(order => order.driverId === person.driverId));
  }
  assert.equal((await request('/api/driver/session', { cookie: 'jeroc_driver=expired-driver' })).status, 401);
  assert.equal((await request('/api/driver/session')).status, 401);
  assert.equal(writes.length, 0); assert.deepEqual(state, before);
  assert.ok(reads.every(domains => !domains.includes('office') && !domains.includes('employeeTime') && !domains.includes('integrationHistory')));
}));

test('customer and carrier GETs keep session expiry and subject scope without auth maintenance or environment reads', () => fixture(async ({ state, writes, request, providerCalls }) => {
  const customer = state.office.customers[0], company = state.personnel.companies[0];
  for (const [kind, subject] of [['customer', customer], ['carrier', company]]) {
    state.logisticsAuth.accounts.push({ id: `${kind}-test`, kind, subjectId: subject.id, username: `${kind}.read`, active: true });
    state.logisticsAuth.sessions.push({ kind, tokenHash: hash(`${kind}-valid`), accountId: `${kind}-test`, subjectId: subject.id, expiresAt: new Date(Date.now() + 60_000).toISOString() }, { kind, tokenHash: hash(`${kind}-expired`), accountId: `${kind}-test`, subjectId: subject.id, expiresAt: '2020-01-01T00:00:00.000Z' });
  }
  state.logisticsAuth.attempts.push({ kind: 'customer', address: 'old', at: '2020-01-01T00:00:00.000Z' });
  const before = structuredClone(state);
  for (const kind of ['customer', 'carrier']) {
    const own = await request(`/api/${kind}/state`, { actor: null, cookie: `jeroc_${kind}=${kind}-valid` });
    assert.equal(own.status, 200, own.value.error);
    if (kind === 'customer') assert.equal(own.value.customer.id, customer.id);
    else assert.equal(own.value.company.id, company.id);
    assert.equal((await request(`/api/${kind}/session`, { cookie: `jeroc_${kind}=${kind}-expired` })).status, 401);
    assert.equal((await request(`/api/${kind}/session`)).status, 401);
  }
  assert.equal(writes.length, 0); assert.deepEqual(providerCalls(), { siteReads: 0, environmentReads: 0 }); assert.deepEqual(state, before);
}));
