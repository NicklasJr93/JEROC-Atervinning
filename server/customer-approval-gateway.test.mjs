import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantGateway } from './tenant-gateway.mjs';

const PUBLIC = '/api/public/customer-approval';
const INITIAL = 'Approval-Private-Initial-2026!';
const CHANGED = 'Approval-Private-Changed-2026!';

/** Real tenant gateway, platform cookies/CSRF, compound review command and
 * terminal HTTP actions. Only the external email/SMS delivery is substituted. */
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'customer-approval-gateway-'));
  const env = { JEROC_TENANT_DATA_DIR: directory, JEROC_DEMO_AUTO_SESSION: 'false',
    SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: INITIAL, SCRAPPLANNER_PLATFORM_ADMIN_EMAIL: 'cashier@example.test',
    APP_URL: 'https://app.scrapplanner.com' };
  for (const key of ['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA', 'PLATFORM', 'COMPANY_LOGO', 'SICKNESS_FILES', 'FLEET_FILES'])
    env[`JEROC_${key}_DB_PATH`] = join(directory, `${key.toLowerCase()}.sqlite`);
  const sends = [], failures = [];
  const prohibited = async () => { throw new Error('This fixture never sends any unrelated message.'); };
  const provider = channel => ({ configured: true, sendTest: prohibited, sendPasswordReset: prohibited,
    sendStaffInvitation: prohibited, sendWeighedDocument: prohibited,
    sendCustomerApproval: async input => { sends.push({ channel, ...structuredClone(input) }); return { providerId: randomUUID() }; } });
  let gateway, server;
  try {
    gateway = await createTenantGateway({ env, systemEmail: provider('email'), systemSms: provider('sms') });
    server = createServer((req, res) => {
      void gateway(req, res, new URL(req.url, 'http://localhost')).then(handled => {
        if (!handled) { res.writeHead(404); res.end(); }
      }).catch(error => { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end(); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    function client() {
      const cookies = new Map(); let session;
      async function request(path, body, headers = {}) {
        const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
          headers: { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
            ...(session?.authenticated && { 'x-platform-csrf': session.csrfToken, 'x-platform-generation': session.generation }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        for (const entry of response.headers.getSetCookie()) {
          const [name, value] = entry.split(';')[0].split('=');
          if (value) cookies.set(name, value); else cookies.delete(name);
        }
        const value = await response.json();
        if (value?.authenticated) session = value;
        return { status: response.status, body: value, headers: response.headers };
      }
      return { request };
    }
    const admin = client();
    assert.equal((await admin.request('/api/platform/login', { username: 'admin', password: INITIAL })).status, 200);
    const changed = await admin.request('/api/platform/change-password', { currentPassword: INITIAL, newPassword: CHANGED });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const company = await gateway.auth.getCompany('jeroc-demo');
    const business = await (await gateway.bundle(company)).applicationApi.getRepository();
    async function command(channel, id = 2053) {
      await business.transact(state => {
        const customer = state.office.customers.find(value => value.id === 'customer-build');
        customer.number = '5591237895'; customer.phone = '+46701234567'; customer.email = 'seller@example.test';
        customer.paymentProfile = { method: 'bank', bank: 'Testbank', clearing: '8327', account: '1234567890', holder: customer.name };
        const card = state.office.cards.find(value => value.id === id);
        Object.assign(card, { customerId: customer.id, status: 'complement', origin: 'Ängsvägen 19, Rimbo',
          siteId: 'norrtalje', yard: 'Norrtälje', rows: [{ articleId: 'copper-1', weight: 10, price: 1, tier: 'C' }],
          paymentDetails: structuredClone(customer.paymentProfile) });
        delete card.customerApproval; delete card.pricingSnapshotId; delete card.accounting;
      });
      const current = await admin.request('/api/application/office');
      assert.equal(current.status, 200, JSON.stringify(current.body));
      return { cardId: id, siteId: 'norrtalje', channel, recipient: channel === 'sms' ? '+46701234567' : 'seller@example.test',
        expectedCard: current.body.data.cards.find(value => value.id === id), idempotencyKey: randomUUID() };
    }
    const bearer = delivery => {
      const url = new URL(delivery.approvalUrl);
      assert.equal(url.origin, 'https://app.scrapplanner.com'); assert.equal(url.pathname, '/godkann/'); assert.equal(url.search, '');
      const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(url.hash); assert.ok(match);
      return { token: match[1], headers: { authorization: `Bearer ${match[1]}` } };
    };
    await run({ gateway, business, admin, client, command, sends, bearer });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close();
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  }
}

for (const channel of ['email', 'sms']) {
  test(`${channel} remote approval reaches the public gateway, stays pending and requires explicit staff ID proof over HTTP`, () => fixture(async f => {
    const input = await f.command(channel);
    const first = await f.admin.request('/api/application/customer-review', input);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.approval.channel, channel); assert.equal(first.body.approval.delivery.status, 'sent');
    assert.equal(first.body.approval.terminalId, undefined); assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].channel, channel); assert.equal(f.sends[0].to, input.recipient);
    const retry = await f.admin.request('/api/application/customer-review', input);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.approval.id, first.body.approval.id); assert.equal(f.sends.length, 1);
    const capability = f.bearer(f.sends[0]), visitor = f.client(), approvalId = first.body.approval.id;
    const view = await visitor.request(PUBLIC, undefined, capability.headers);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.match(view.headers.get('cache-control'), /no-store/); assert.equal(view.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(view.body.approval.id, approvalId); assert.equal(view.body.approval.status, 'waiting');
    for (const privateField of ['card', 'customer', 'paymentDetails', 'bank', 'account']) assert.equal(view.body.approval.snapshot[privateField], undefined);
    assert.equal((await visitor.request(`${PUBLIC}?token=${capability.token}`)).status, 410);
    const publicAnswer = await visitor.request(`${PUBLIC}/respond`, { action: 'id_requested', termsAccepted: true }, capability.headers);
    assert.equal(publicAnswer.status, 200, JSON.stringify(publicAnswer.body)); assert.equal(publicAnswer.body.approval.status, 'id_requested');
    const pendingOffice = await f.admin.request('/api/application/office');
    const pending = pendingOffice.body.data.cards.find(value => value.id === input.cardId);
    assert.equal(pending.idVerified, false); assert.equal(pending.customerApproval.status, 'id_requested');
    assert.equal((await visitor.request(`/api/terminal-demo/approvals/${approvalId}/confirm-id`, { idChecked: true }, capability.headers)).status, 401);
    const missingProof = await f.admin.request(`/api/terminal-demo/approvals/${approvalId}/confirm-id`, {});
    assert.equal(missingProof.status, 422, JSON.stringify(missingProof.body)); assert.equal(missingProof.body.code, 'id_check_required');
    const approved = await f.admin.request(`/api/terminal-demo/approvals/${approvalId}/confirm-id`, { idChecked: true });
    assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.snapshot.card.idVerified, true);
    const current = await f.admin.request('/api/application/office');
    assert.equal(current.body.data.cards.find(value => value.id === input.cardId).status, 'attest');
    assert.equal((await visitor.request(PUBLIC, undefined, capability.headers)).body.approval.status, 'approved');
    assert.equal(f.sends.length, 1);
    const persisted = JSON.stringify(await f.gateway.repository.read(state => state)) + JSON.stringify(await f.business.read(state => state));
    assert.equal(persisted.includes(capability.token), false, 'Only the token hash may survive in durable application/control state.');
  }));
}

test('cancelled and superseded remote links fail closed, and the routing index enforces expiry independently of ambient tenant cookies', () => fixture(async f => {
  const input = await f.command('email');
  const first = await f.admin.request('/api/application/customer-review', input);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const old = f.bearer(f.sends[0]);
  assert.equal((await f.admin.request(`/api/terminal-demo/approvals/${first.body.approval.id}/cancel`, {})).status, 200);
  assert.equal((await f.admin.request(PUBLIC, undefined, { ...old.headers, 'x-client-company': 'other-company' })).status, 410);
  const current = await f.admin.request('/api/application/office');
  const second = await f.admin.request('/api/application/customer-review', { ...input, channel: 'sms', recipient: '+46701234567',
    expectedCard: current.body.data.cards.find(value => value.id === input.cardId), idempotencyKey: randomUUID() });
  assert.equal(second.status, 200, JSON.stringify(second.body)); assert.equal(second.body.approval.version, first.body.approval.version + 1);
  const fresh = f.bearer(f.sends[1]); assert.notEqual(fresh.token, old.token);
  assert.equal((await f.admin.request(PUBLIC, undefined, { ...fresh.headers, 'x-client-company': 'other-company' })).status, 200);
  assert.equal((await f.client().request(PUBLIC, undefined, old.headers)).status, 410);
  await f.gateway.repository.transact(state => {
    const link = state.customerApprovalLinks.find(value => value.approvalId === second.body.approval.id);
    assert.ok(link); link.expiresAt = '2000-01-01T00:00:00.000Z';
  });
  const expired = await f.client().request(PUBLIC, undefined, fresh.headers);
  assert.equal(expired.status, 410); assert.equal(expired.body.approval, undefined);
  assert.equal(f.sends.length, 2);
}));
