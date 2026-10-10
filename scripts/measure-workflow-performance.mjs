import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] ?? '.'), artificialRtt = Number(process.argv[3] ?? 0);
const load = path => import(pathToFileURL(`${root}/${path}`));
const { createApplicationService } = await load('server/application.mjs');
const { createTerminalDemoApi } = await load('server/terminal-demo.mjs');
const { createEnvironmentApi } = await load('server/environment-api.mjs');
const tracking = new AsyncLocalStorage(), original = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  const row = tracking.getStore(); if (row) row.sql++;
  if (!row || !artificialRtt) return original.apply(this, args);
  return new Promise(resolve => setTimeout(resolve, artificialRtt)).then(() => original.apply(this, args));
};
const connectionString = process.env.JEROC_TEST_DATABASE_URL;
if (!connectionString) throw new Error('JEROC_TEST_DATABASE_URL krävs: använd en separat lokal testdatabas.');
const schema = `jeroc_measure_${randomUUID().replaceAll('-', '')}`;
const pool = new pg.Pool({ connectionString: connectionString });
await pool.query(`CREATE SCHEMA "${schema}"`);
const url = new URL(connectionString); url.searchParams.set('options', `-c search_path=${schema}`);
const env = { DATABASE_URL: url.toString() }, measures = [];
let terminal, environment;
const app = createApplicationService({ env, projections: cardId => terminal.projections(cardId),
  sendCustomerReview: (payload, principal, req) => terminal.sendPrepared(payload, principal, req), siteProvider: () => environment.getSites() });
environment = createEnvironmentApi({ env, principalStore: app.principalStore,
  outboundProvider: async () => { const repo = await app.getRepository(); const op = state => state.logistics?.inventoryMovements ?? [];
    return repo.read ? repo.read(op, { domains: ['logistics'] }) : repo.transact(op); } });
terminal = createTerminalDemoApi({ env, principalStore: app.principalStore, siteProvider: () => environment.getSites() });
const newer = Boolean((await app.getRepository()).read);
await environment.initialize?.(); await terminal.initialize?.();
const server = createServer((req, res) => tracking.run(req.headers['x-measure'] ? measures.at(-1) : undefined, async () => {
  const parsed = new URL(req.url, 'http://localhost');
  if (await app(req, res, parsed)) return;
  const operation = async () => await terminal(req, res, parsed) || await environment(req, res, parsed);
  if (newer) await operation(); else await app.withPrincipal(operation);
}));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let staffCookie = '', environmentCookie = '', csrf = '';
async function request(path, data, measured = false) {
  const row = measured ? { path, sql: 0 } : undefined; if (row) measures.push(row);
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin',
      ...(path.includes('/environment/') ? { Cookie: environmentCookie, 'X-Environment-Actual-User': 'admin', 'X-Environment-Effective-User': 'admin', 'X-Environment-CSRF': csrf } : { Cookie: staffCookie }),
      ...(measured ? { 'X-Measure': 'true' } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const value = await response.json(); if (!response.ok) throw new Error(`${path}: ${response.status} ${value.error}`);
  if (row) { row.ms = Math.round(performance.now() - started); row.bytes = Buffer.byteLength(JSON.stringify(value)); }
  return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
try {
  staffCookie = (await request('/api/terminal-demo/staff-session', { actualUserId: 'admin', effectiveUserId: 'admin' })).cookie;
  const login = await request('/api/environment/demo-session', { userId: 'admin' }); environmentCookie = login.cookie; csrf = login.value.csrfToken;
  for (const path of ['/api/application/office', '/api/terminal-demo/state', '/api/environment/session', '/api/environment/state']) {
    await request(path); await request(path, undefined, true);
  }
  await request('/api/environment/storage/check', { siteId: 'norrtalje', rows: [{ articleId: 'lead-battery', weight: 10 }], materialScope: 'hazardous' }, true);
  const device = (await request('/api/terminal-demo/terminals', { name: 'Measured terminal', username: 'measure-terminal', password: 'local-measure-only', siteId: 'norrtalje' })).value;
  await request('/api/terminal-demo/login', { username: 'measure-terminal', password: 'local-measure-only' });
  const base = (await request('/api/application/office')).value.data, next = structuredClone(base), card = next.cards.find(value => value.id === 2053);
  Object.assign(card, { status: 'complement', customerId: 'customer-build', origin: 'Testgatan 12, 76141 Norrtälje', reference: '', payment: 'Kontant', paymentDetails: { method: 'cash' },
    financialPending: true, pricingRowsPending: true, rows: [{ articleId: 'copper-1', weight: 72, tier: 'C', price: 1, pricePending: true }] });
  await request('/api/application/office', { base, next });
  const input = (await request('/api/application/office')).value.data.cards.find(value => value.id === card.id);
  if (newer) await request('/api/application/customer-review', { cardId: card.id, expectedCard: input, terminalId: device.id, siteId: 'norrtalje', idempotencyKey: randomUUID() }, true);
  else {
    await request(`/api/pricing/snapshots?cardId=${card.id}`, undefined, true);
    const frozen = (await request('/api/pricing/snapshots', { cardId: String(card.id), customerId: card.customerId, deliveredAt: card.date, rows: card.rows.map(row => ({ articleId: row.articleId, weight: row.weight })) }, true)).value;
    const rows = frozen.rows.map(row => ({ ...row, tier: row.tier === 'Special' ? 'Eget' : row.tier, pricePending: false }));
    await request('/api/terminal-demo/approvals', { card: { ...input, rows, pricingSnapshotId: frozen.id, pricingTotal: frozen.total, financialPending: false, pricingRowsPending: false },
      customer: next.customers.find(value => value.id === card.customerId), terminalId: device.id, siteId: 'norrtalje',
      rows: rows.map(row => ({ articleId: row.articleId, name: row.articleId, weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })), offset: 0, correctionIds: [], idempotencyKey: randomUUID() }, true);
    await request('/api/terminal-demo/state', undefined, true);
  }
  console.log(JSON.stringify({ version: newer ? 'updated' : 'baseline', artificialRtt, measures }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve)); await terminal.close(); await environment.close(); await app.close();
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end();
}
