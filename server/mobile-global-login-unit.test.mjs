import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { createGlobalEmployeeLogin, employeeLoginAddress, employeeLoginPasswordValid } from './mobile-global-login.mjs';

test('only the Render deployment trusts a bounded valid final proxy IP', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(employeeLoginAddress(req, {}), employeeLoginAddress({ ...req, headers: {} }, {}));
  assert.equal(employeeLoginAddress(req, { RENDER: 'true' }), employeeLoginAddress({ ...req, socket: { remoteAddress: '198.51.100.7' }, headers: {} }, {}));
  for (const forwarded of ['forged', `${'a'.repeat(2048)},198.51.100.7`, '198.51.100.7:1234'])
    assert.equal(employeeLoginAddress({ ...req, headers: { 'x-forwarded-for': forwarded } }, { RENDER: 'true' }), employeeLoginAddress(req, {}));
});

test('malformed or absent stored credentials perform safe dummy work and never authenticate', async () => {
  for (const stored of [undefined, {}, { salt: 'bad', digest: 'bad' }, { salt: 'a'.repeat(48), digest: 'xyz' }])
    assert.equal(await employeeLoginPasswordValid('A-private-candidate-password', stored), false);
});

test('global login bounds concurrent expensive work before opening a tenant or issuing cookies', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let reads = 0, opened = 0;
  const api = createGlobalEmployeeLogin({ repository: { read: async operation => { reads += 1; await gate; return operation({ users: [], memberships: [], companies: [] }); } },
    auth: { resolveTenantSelector: async () => undefined }, openCompany: async () => { opened += 1; }, sameOrigin: () => {},
    json: (res, status, value) => { res.status = status; res.value = value; } });
  const request = name => {
    const req = Readable.from([Buffer.from(JSON.stringify({ username: name, password: 'Not-stored-anywhere-2026!' }))]);
    Object.assign(req, { method: 'POST', headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } });
    const res = { cookies: [], getHeader: () => undefined, setHeader() { this.cookies.push(true); } };
    return { res, pending: api.handle(req, res, new URL('http://localhost/api/employee/login?view=bootstrap')) };
  };
  const inflight = ['one', 'two', 'three', 'four'].map(request);
  while (reads < 4) await new Promise(resolve => setImmediate(resolve));
  const rejected = request('five'); await rejected.pending;
  assert.equal(rejected.res.status, 429); assert.equal(rejected.res.value.code, 'employee_login_rate_limit');
  release(); await Promise.all(inflight.map(value => value.pending));
  assert.equal(reads, 4); assert.equal(opened, 0);
  for (const { res } of inflight) { assert.equal(res.status, 401); assert.deepEqual(res.cookies, []); assert.equal(res.value.code, 'employee_login_failed'); }
});

test('a shared yard IP permits thirteen distinct logins while each identifier stays bounded', async () => {
  const company = { id: 'selected-company' };
  const api = createGlobalEmployeeLogin({ repository: { read: async operation => operation({ users: [] }) },
    auth: { resolveTenantSelector: async () => ({ company }) }, openCompany: async () => ({ handle: async (req, res) => { res.status = 200; return true; } }),
    sameOrigin: () => {}, json: (res, status) => { res.status = status; } });
  const login = async username => {
    const req = Readable.from([Buffer.from(JSON.stringify({ username, password: 'Shared-yard-private-2026!' }))]);
    Object.assign(req, { method: 'POST', headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '192.0.2.10' } });
    const res = {}; await api.handle(req, res, new URL('http://localhost/api/employee/login?view=bootstrap')); return res.status;
  };
  for (let index = 0; index < 13; index++) assert.equal(await login(`yard.worker.${index}`), 200);
  for (let index = 0; index < 12; index++) assert.equal(await login('same.worker'), 200);
  assert.equal(await login('same.worker'), 429);
});
