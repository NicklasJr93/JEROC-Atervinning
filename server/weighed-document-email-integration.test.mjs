import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createTenantServices } from './tenant-services.mjs';
import { createPricingStore } from './pricing.mjs';
import { documentHash } from './documents/model.mjs';
import { closePdfRenderer } from './documents/render-pool.mjs';

after(closePdfRenderer);

const company = { id: 'weighed-email-company', name: 'Kontorets Återvinning AB', organisationNumber: '5593593626' };
const customer = { id: 'customer-build', name: 'Syntetisk testkund AB', type: 'Företag', number: '5560000167', customerNumber: 'K-1001', phone: '', email: '',
  paymentProfile: { method: 'cash', recipient: 'Syntetisk testkund AB' } };
const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true, address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje' }];
const settingsInput = value => ({ expectedVersion: value.version, profile: value.profile, documents: value.documents, defaults: value.defaults, notifications: value.notifications });

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'weighed-email-integration-'));
  const env = { SCRAPPLANNER_DEPLOYMENT_MODE: 'pilot', SCRAPPILOT_ORGANISATION_ID: company.id };
  for (const key of ['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA', 'COMPANY_LOGO'])
    env[`JEROC_${key}_DB_PATH`] = join(directory, `${key.toLowerCase()}.sqlite`);
  const sent = [], failures = [];
  const email = { configured: true, sendWeighedDocument: async command => {
    sent.push({ ...command, pdf: Buffer.from(command.pdf) });
    return { providerId: randomUUID() };
  } };
  const options = { env, company, initialSites: sites, weighedDocumentEmailSender: email };
  let service, server;
  const principal = { companyId: company.id, actorId: 'admin', userId: 'admin', scopeKey: 'weighed-email-fixture', canManage: true };
  try {
    service = await createTenantServices(options);
    server = createServer((req, res) => {
      void service.handle(req, res, new URL(req.url, 'http://localhost')).then(handled => {
        if (!handled) { res.writeHead(404); res.end(); }
      }).catch(error => { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end(); });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/terminal-demo`;
    async function request(path, input, cookie) {
      const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
      return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    const staff = {};
    for (const id of ['admin', 'kajsa', 'anna']) {
      const response = await request('/staff-session', { actualUserId: id, effectiveUserId: id });
      assert.equal(response.status, 200, JSON.stringify(response.value)); staff[id] = response.cookie;
    }
    const created = await request('/terminals', { name: 'Mejlkopians testterminal', username: 'email-fixture', password: 'Private-Terminal-Fixture-2026!', siteId: 'norrtalje' }, staff.admin);
    assert.equal(created.status, 201, JSON.stringify(created.value));
    const logged = await request('/login', { username: 'email-fixture', password: 'Private-Terminal-Fixture-2026!' });
    assert.equal(logged.status, 200, JSON.stringify(logged.value));
    const repository = await service.applicationApi.getRepository();
    const frozen = await repository.transact(state => {
      const pricing = createPricingStore({ initialState: state.pricing });
      const result = pricing.snapshot({ cardId: 9201, customerId: customer.id, deliveredAt: '2026-10-09T09:00:00Z', rows: [{ articleId: 'copper-1', weight: 10 }] }, pricing.principal('kajsa'));
      state.pricing = pricing.exportState(); return result;
    });
    const rows = frozen.rows.map(row => ({ articleId: row.articleId, weight: row.weight, price: row.price, tier: row.tier === 'Special' ? 'Eget' : row.tier }));
    const payload = { card: { id: 9201, siteId: 'norrtalje', customerId: customer.id, status: 'complement', yard: 'Norrtälje', date: '2026-10-09T09:00:00Z', reference: 'Kontorets PDF-kopia', origin: 'Testgatan 12', pricingSnapshotId: frozen.id, rows, audit: [] },
      customer, terminalId: created.value.id, siteId: 'norrtalje', rows: rows.map(row => ({ articleId: row.articleId, name: 'Koppar klass 1', weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })), offset: 0, correctionIds: [], idempotencyKey: 'email-integration-first-send' };
    async function saveSettings(change) {
      const input = settingsInput(await service.companySettingsService.get()); change(input);
      return service.companySettingsService.save(input, principal, { reauthorize: async () => principal });
    }
    await run({ get service() { return service; }, request, staff, device: logged.cookie, payload, sent, saveSettings, principal,
      restart: async () => { await service.close(); service = await createTenantServices(options); },
    });
  } finally {
    if (server) { server.closeAllConnections(); server.close(); await once(server, 'close'); }
    await service?.close(); await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  }
}

async function sendAndApprove(f) {
  const created = await f.request('/approvals', f.payload, f.staff.kajsa);
  assert.equal(created.status, 201, JSON.stringify(created.value));
  await f.service.terminalDemoApi.drainDocumentJobs();
  await f.service.weighedDocumentEmailService.processQueuedWeighedDocumentEmails();
  assert.equal(f.sent.length, 0, 'A preliminary PDF must never email the office');
  const id = created.value.id;
  assert.equal((await f.request(`/approvals/${id}/respond`, { action: 'id_requested', termsAccepted: true }, f.device)).status, 200);
  const approved = await f.request(`/approvals/${id}/confirm-id`, { idChecked: true }, f.staff.kajsa);
  assert.equal(approved.status, 200, JSON.stringify(approved.value));
  await f.service.terminalDemoApi.drainDocumentJobs();
  await f.service.weighedDocumentEmailService.processQueuedWeighedDocumentEmails();
  assert.equal(f.sent.length, 0, 'Customer approval alone must not email the office');
  return id;
}

test('enabled company setting emails exactly the archived final PDF after attest; retries and restart cannot resend it', { timeout: 30000 }, () => fixture(async f => {
  const logo = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#17334f' } }).png().toBuffer();
  const uploaded = await f.service.companyLogoService.upload({ contentType: 'image/png', base64: logo.toString('base64') }, f.principal, { reauthorize: async () => f.principal });
  await f.saveSettings(input => {
    input.documents.logoId = uploaded.logoId;
    input.notifications.weighedDocumentEmail = { enabled: true, recipients: ['office@example.test'] };
  });
  const id = await sendAndApprove(f);
  const result = await f.request(`/approvals/${id}/attest`, {}, f.staff.anna);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  await f.service.terminalDemoApi.drainDocumentJobs();
  await f.service.weighedDocumentEmailService.processQueuedWeighedDocumentEmails();
  assert.equal(f.sent.length, 1);
  const delivered = f.sent[0], archived = await f.service.documentsApi.readArchivedDocumentForEmail(delivered.documentId);
  assert.equal(archived.stage, 'final'); assert.equal(archived.kind, 'settlement');
  assert.equal(archived.snapshot.company.id, company.id); assert.equal(archived.snapshot.company.logoId, uploaded.logoId);
  assert.equal(delivered.companyName, company.name); assert.equal(String(delivered.cardNumber), '9201');
  assert.equal(delivered.to, 'office@example.test');
  assert.ok(archived.snapshot.approval.at); assert.ok(archived.snapshot.attest.at);
  assert.equal(documentHash(delivered.pdf), archived.pdfHash); assert.deepEqual(delivered.pdf, archived.pdf);
  assert.match(delivered.pdf.subarray(0, 8).toString(), /^%PDF-/);
  assert.equal((await f.request(`/approvals/${id}/attest`, {}, f.staff.anna)).status, 200);
  await f.service.terminalDemoApi.drainDocumentJobs();
  await f.service.weighedDocumentEmailService.processQueuedWeighedDocumentEmails();
  await f.restart();
  await f.service.terminalDemoApi.drainDocumentJobs();
  await f.service.weighedDocumentEmailService.processQueuedWeighedDocumentEmails();
  assert.equal(f.sent.length, 1, 'Repeated attest, queue drain and service restart must not resend the office copy');
}));

test('default-off company setting archives the attested PDF without sending any office email', { timeout: 30000 }, () => fixture(async f => {
  const settings = await f.service.companySettingsService.get();
  assert.deepEqual(settings.notifications.weighedDocumentEmail, { enabled: false, recipients: [] });
  const id = await sendAndApprove(f);
  const result = await f.request(`/approvals/${id}/attest`, {}, f.staff.anna);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  await f.service.terminalDemoApi.drainDocumentJobs();
  await f.service.weighedDocumentEmailService.processQueuedWeighedDocumentEmails();
  const finalJobs = (await f.service.terminalDemoApi.documentJobs()).filter(job => job.stage === 'final');
  assert.equal(finalJobs.length, 1); assert.equal(finalJobs[0].status, 'completed');
  const emailStatus = await f.service.weighedDocumentEmailService.status();
  assert.equal(emailStatus.decisions, 0); assert.equal(emailStatus.queued, 0); assert.equal(emailStatus.sent, 0);
  assert.equal(f.sent.length, 0);
}));
