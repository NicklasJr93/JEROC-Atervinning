import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restrictPilotIntegrationService, handlePilotIntegrationRequest } from './pilot-integrations.mjs';
import { createPricingStore } from './pricing.mjs';
import { createTerminalDemoRepository } from './terminal-demo-storage.mjs';
import { createTerminalDemoStore } from './terminal-demo.mjs';

const env = { SCRAPPLANNER_DEPLOYMENT_MODE: 'pilot' };
const blocked = operation => assert.rejects(operation, failure => failure.status === 403 && failure.code === 'pilot_integration_disabled');

test('pilot blocks writes, provider reads, callbacks, retries and future methods even with configured credentials', async () => {
  let calls = 0;
  for (const [provider, methods] of Object.entries({
    visma: ['begin', 'callback', 'complete', 'send', 'lookupChoices', 'sendExport', 'processExport', 'recreateExport', 'refreshExport', 'paymentChoices', 'requestCardBooking', 'refreshCardBooking', 'checkAttestBooking', 'synchronizeSwishPayment', 'futureProviderMethod'],
    swish: ['start', 'prepare', 'sandboxSend', 'refresh', 'resume', 'synchronizeBookkeeping'],
    bank: ['start', 'prepare', 'testConnection', 'banks', 'getAccounts', 'balances', 'completeAuthorisation', 'connectConsent', 'beginAuthorisation', 'refresh', 'resume'],
    mail: ['connectMicrosoft', 'completeMicrosoft', 'sync', 'message'],
  })) {
    const service = restrictPilotIntegrationService({ env: { ...env, VISMA_ENVIRONMENT: 'sandbox', SWISH_ENVIRONMENT: 'mss' }, provider,
      service: Object.fromEntries(methods.map(name => [name, async () => { calls++; }])) });
    for (const name of methods) await blocked(() => service[name]());
  }
  assert.equal(calls, 0, 'No provider or queue reservation method may run');
});

test('pilot workers leave stored queue jobs untouched, while local methods keep their authorization', async () => {
  const queue = [{ status: 'queued', attempts: 0 }]; let authorized = 0;
  const service = restrictPilotIntegrationService({ env, provider: 'visma', service: {
    initialize: async () => 'local storage ready',
    processQueuedExports: async () => { queue[0].attempts++; },
    processAccountingTracking: async () => { queue[0].status = 'sent'; },
    processSpirisPayments: async () => { queue[0].status = 'paid'; },
    financeSettingsForCompany: async () => ({ enabled: true, companyId: 'sandbox-company' }),
    settings: async context => { assert.equal(context.role, 'admin'); authorized++; return { settings: { enabled: true }, connected: true,
      companyVerified: true, configuration: { ready: true }, capabilities: { canConfigure: true, canExport: true, automationEnabled: true } }; },
    integrationStatus: async () => ({ configured: true, connected: true }),
  } });
  assert.equal(await service.initialize(), 'local storage ready');
  for (const method of ['processQueuedExports', 'processAccountingTracking', 'processSpirisPayments']) {
    const result = await service[method](); assert.equal(result.processed, 0); assert.equal(result.disabledReason, 'pilot_integration_disabled');
  }
  assert.deepEqual(queue, [{ status: 'queued', attempts: 0 }]);
  assert.equal(await service.financeSettingsForCompany(), null, 'Approvals cannot freeze sandbox account bindings');
  const settings = await service.settings({ role: 'admin' });
  assert.equal(authorized, 1); assert.equal(settings.settings.enabled, false); assert.equal(settings.companyVerified, false);
  assert.equal(settings.configuration.ready, false); assert.equal(settings.capabilities.canExport, false);
  const status = await service.integrationStatus(); assert.equal(status.mode, 'disabled'); assert.equal(status.connected, false);
  const payments = restrictPilotIntegrationService({ env, provider: 'swish', service: { processQueuedPayments: async () => { queue[0].status = 'paid'; } } });
  assert.equal((await payments.processQueuedPayments()).processed, 0); assert.equal(queue[0].status, 'queued');
});

test('pilot HTTP guard rejects provider operations and aliases, retaining local status/history and ordinary business routes', () => {
  for (const [method, path] of [
    ['POST', '/api/environment/visma/oauth/start'], ['POST', '/api/environment/visma/accounting/exports'],
    ['POST', '/api/environment/visma/accounting/cards/3027/booking'], ['POST', '/api/environment/payments'],
    ['GET', '/api/environment/payments/cards/3027/prepare'], ['POST', '/api/environment/bank/payments'],
    ['GET', '/api/environment/bank/accounts'], ['GET', '/api/environment/bank/balances'], ['GET', '/api/environment/swish/choices'],
    ['POST', '/api/environment/nvv/reports/report-1/send'], ['POST', '/api/environment/nvv/check'],
    ['POST', '/api/environment/nvv/diagnostics'], ['POST', '/api/mail/sync'], ['GET', '/api/mail/mailboxes/1/messages/2'],
    ['GET', '/api/integrations/openpayments/callback'], ['GET', '/api/integrations/visma/oauth/callback'],
    ['POST', '/api/voice-test/calls'], ['POST', '/api/public/voice-test/calls'], ['POST', '/api/ai-support/preview'],
    ['POST', '/api/transport/outbox'], ['POST', '/api/swish/payouts'],
  ]) {
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    assert.equal(handlePilotIntegrationRequest(env, { method }, response, new URL(path, 'http://localhost')), true, `${method} ${path}`);
    assert.equal(response.status, 403); assert.equal(JSON.parse(response.body).code, 'pilot_integration_disabled');
  }
  for (const [method, path] of [
    ['GET', '/api/environment/integrations/catalog'], ['GET', '/api/environment/visma/status'],
    ['HEAD', '/api/environment/bank/settings'], ['GET', '/api/mail/state'], ['GET', '/api/mail/messages'],
    ['GET', '/api/environment/payments/cards/3027'], ['GET', '/api/environment/visma/accounting/cards/3027/booking'],
    ['POST', '/api/terminal-demo/approvals/approval-1/attest'], ['POST', '/api/application/office'],
  ]) assert.equal(handlePilotIntegrationRequest(env, { method }, {}, new URL(path, 'http://localhost')), false, `${method} ${path}`);
});

test('demo services and routes retain their original behavior and object identity', async () => {
  let calls = 0; const service = { start: async () => ++calls };
  for (const mode of [undefined, 'demo']) {
    const env = { SCRAPPLANNER_DEPLOYMENT_MODE: mode };
    assert.equal(restrictPilotIntegrationService({ env, provider: 'swish', service }), service);
    await service.start();
    assert.equal(handlePilotIntegrationRequest(env, { method: 'POST' }, {}, new URL('http://localhost/api/environment/payments')), false);
  }
  assert.equal(calls, 2);
});

test('ordinary customer-approved attest still commits the final PDF job; Attest + bokför is blocked before state changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-attest-policy-'));
  const repository = await createTerminalDemoRepository({ env: {}, filename: join(directory, 'terminal.sqlite') });
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const now = () => new Date('2026-10-20T08:00:00Z'), pricing = createPricingStore({ now });
  let outboundCalls = 0;
  const visma = restrictPilotIntegrationService({ env, provider: 'visma', service: {
    checkAttestBooking: async () => { outboundCalls++; }, processQueuedExports: async () => { outboundCalls++; },
  } });
  const terminal = createTerminalDemoStore({ repository, principalStore: pricing, now, attestBookingCheck: approval => visma.checkAttestBooking(approval) });
  const admin = (await terminal.staffSession({ actualUserId: 'admin', effectiveUserId: 'admin' })).token;
  const staff = (await terminal.staffSession({ actualUserId: 'kajsa', effectiveUserId: 'kajsa' })).token;
  const terminalAccount = await terminal.createTerminal({ name: 'Testterminal', username: 'policy-test', password: 'Isolated-Fixture-Only!', siteId: 'norrtalje' }, admin);
  const device = await terminal.login({ username: terminalAccount.username, password: 'Isolated-Fixture-Only!' });
  const customer = { id: 'customer-build', name: 'Testkund', type: 'Privatperson', number: '197709306828', customerNumber: 'P1', phone: '', email: '',
    paymentProfile: { method: 'cash', recipient: 'Testkund' } };
  const locked = pricing.snapshot({ cardId: 99001, customerId: customer.id, deliveredAt: now().toISOString(), rows: [{ articleId: 'copper-1', weight: 1 }] }, pricing.principal('kajsa'));
  const approval = await terminal.send({ card: { id: 99001, customerId: customer.id, status: 'complement', yard: 'Norrtälje', date: now().toISOString(),
    reference: 'Policy-test', origin: 'Testvägen 1', pricingSnapshotId: locked.id, idVerified: false, weigher: 'Testpersonal', payment: 'Kontant',
    rows: locked.rows.map(row => ({ articleId: row.articleId, weight: row.weight, price: row.price, tier: row.tier === 'Special' ? 'Eget' : row.tier })), audit: [] },
    customer, terminalId: terminalAccount.id, siteId: 'norrtalje', rows: locked.rows.map(row => ({ articleId: row.articleId, name: 'Koppar', weight: row.weight, price: row.price, amount: row.weight * row.price })),
    offset: 0, correctionIds: [], idempotencyKey: 'pilot-attest-safety' }, staff);
  await terminal.respond(approval.id, { action: 'id_requested', termsAccepted: true }, device.token);
  await terminal.confirmId(approval.id, staff);
  await blocked(() => terminal.attest(approval.id, admin, { spirisAction: 'book' }));
  assert.equal((await terminal.read(admin)).approvals[0].status, 'approved');
  const result = await terminal.attest(approval.id, admin, { spirisAction: 'draft' });
  await visma.processQueuedExports({ cardId: result.cardId, reconcile: false });
  assert.equal(result.status, 'attested'); assert.equal(result.bookingConnection, undefined);
  assert.equal(outboundCalls, 0);
  const jobs = await repository.documentJobs(); assert.equal(jobs.filter(job => job.stage === 'final').length, 1);
});
