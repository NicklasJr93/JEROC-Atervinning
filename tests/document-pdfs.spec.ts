import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { seedOffice, type OfficeCard, type OfficeCustomer } from '../src/office/model';
import type { ArchivedDocument, TransportDocumentResponse } from '../src/office/documents/client';
import type { TerminalApproval } from '../src/office/terminal-demo-types';
import type { TransportData } from '../src/office/transport/types';
import { createOfficeCard, readOffice, saveOffice } from './helpers/financial-card';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(75_000);
test.describe.configure({ mode: 'serial' });

const admin = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function createPdfCard(request: APIRequestContext) {
  // These records share the real customer API with mobile regressions. Keep
  // their visible names unique so existing customer selectors stay unambiguous.
  const customer = structuredClone(seedOffice().customers.find(customer => customer.id === 'customer-erik')!);
  customer.id = `pdf-customer-${randomUUID()}`;
  customer.name = `PDF-kund ${randomUUID().slice(0, 8)}`;
  customer.customerNumber = `PDF-${randomInt(1e7)}`;
  return createOfficeCard(request, { customer });
}
async function post(request: APIRequestContext, path: string, data: unknown, headers?: Record<string, string>) {
  const response = await request.post(path, { headers, data });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return response.json();
}
async function archive(request: APIRequestContext, kind: 'settlement' | 'transport', sourceId: number | string): Promise<ArchivedDocument[]> {
  const response = await request.get(`/api/documents?kind=${kind}&sourceId=${encodeURIComponent(sourceId)}`, { headers: admin });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).documents;
}
async function pdf(request: APIRequestContext, document: ArchivedDocument) {
  const response = await request.get(`/api/documents/${document.id}/download`, { headers: admin });
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.headers()['content-type']).toBe('application/pdf');
  expect(response.headers()['content-disposition']).toMatch(/^inline; filename="JEROC-[^"]+\.pdf"$/);
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  const bytes = await response.body();
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1000);
  expect(sha256(bytes)).toBe(document.pdfHash);
  expect(response.headers()['x-document-hash']).toBe(document.pdfHash);
  return bytes;
}
async function office(page: Page, cardId?: number) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  if (cardId !== undefined) {
    await page.goto(`/kontor#/weighings/${cardId}`);
    await expect(page.getByRole('heading', { name: `Invägning #${cardId}`, exact: true })).toBeVisible();
  }
}
/** Freeze a genuine review and reserve a real demo terminal; customer signoff
 * and attest are performed separately so each automatic PDF stage is checked. */
async function sendReview(request: APIRequestContext, card: OfficeCard, customer: OfficeCustomer): Promise<TerminalApproval> {
  await post(request, '/api/terminal-demo/staff-session', { actualUserId: 'admin', effectiveUserId: 'admin' });
  const username = `pdf-${randomUUID().slice(0, 12)}`;
  const terminal = await post(request, '/api/terminal-demo/terminals', { username, name: username, password: 'local-test-only', siteId: card.siteId ?? 'norrtalje' });
  await post(request, '/api/terminal-demo/login', { username, password: 'local-test-only' });
  const historyResponse = await request.get(`/api/pricing/snapshots?cardId=${card.id}`, { headers: admin });
  expect(historyResponse.ok()).toBe(true);
  const { snapshots } = await historyResponse.json();
  const pricing = await post(request, '/api/pricing/snapshots', {
    cardId: card.id, customerId: customer.id, deliveredAt: card.date,
    ...(snapshots.at(-1)?.id ? { supersedesSnapshotId: snapshots.at(-1).id } : {}),
    rows: card.rows.map(row => ({ articleId: row.articleId, weight: row.weight,
      override: { price: row.price, tier: row.tier, reason: 'Prissatt underlag för PDF-regressionstest' } })),
  }, admin);
  const rows = pricing.rows.map((row: { articleId: string; weight: number; price: number; tier: string }) => ({ ...row, tier: row.tier === 'Special' ? 'Eget' : row.tier }));
  return post(request, '/api/terminal-demo/approvals', {
    card: { ...card, pricingSnapshotId: pricing.id, pricingTotal: pricing.total, rows }, customer,
    terminalId: terminal.id, siteId: card.siteId ?? 'norrtalje',
    rows: rows.map((row: OfficeCard['rows'][number]) => ({ articleId: row.articleId, name: row.articleId,
      weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })),
    offset: 0, correctionIds: [], idempotencyKey: randomUUID(),
  });
}
async function downloadMatches(page: Page, dialog: Locator, expected: Buffer) {
  await expect(dialog.locator('.document-pdf')).toHaveAttribute('src', /^blob:/);
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Ladda ned PDF', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^JEROC-[^/]+\.pdf$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect((await readFile(path!)).equals(expected)).toBe(true);
}

test('kundgranskning och attest arkiverar riktiga PDF-original som kan väljas och laddas ned', async ({ page, request }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', error => jsErrors.push(error.message));
  const fixture = await createPdfCard(request);
  await office(page, fixture.cardId);
  await page.getByRole('button', { name: 'Förhandsvisa avräkning', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Avräkningsnota', exact: true });
  await expect(dialog.locator('.office-document')).toContainText(fixture.customer.name);
  await dialog.getByRole('button', { name: 'Stäng underlag', exact: true }).click();

  const approval = await sendReview(request, fixture.card, fixture.customer);
  const initial = await archive(request, 'settlement', fixture.cardId);
  expect(initial.map(document => document.stage)).toEqual(['preliminary']);
  const original = initial[0], originalBytes = await pdf(request, original);
  await page.reload();
  await page.getByRole('button', { name: 'Förhandsvisa avräkning', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Avräkningsnota', exact: true });
  await downloadMatches(page, dialog, originalBytes);
  await dialog.getByRole('button', { name: 'Stäng underlag', exact: true }).click();

  await post(request, `/api/terminal-demo/approvals/${approval.id}/respond`, { action: 'id_requested', termsAccepted: true });
  await post(request, `/api/terminal-demo/approvals/${approval.id}/confirm-id`, {});
  const reviewed = await archive(request, 'settlement', fixture.cardId);
  expect(reviewed.map(document => document.stage).sort()).toEqual(['preliminary', 'reviewed']);
  await post(request, `/api/terminal-demo/approvals/${approval.id}/attest`, {});
  const final = await archive(request, 'settlement', fixture.cardId);
  expect(final.map(document => document.stage).sort()).toEqual(['final', 'preliminary', 'reviewed']);
  const issued = final.find(document => document.stage === 'final')!;
  const issuedBytes = await pdf(request, issued);
  expect((await pdf(request, original)).equals(originalBytes)).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Avräkningsnota', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Avräkningsnota', exact: true });
  await expect(dialog.getByLabel('Dokumentversion', { exact: true })).toHaveValue(issued.id);
  await downloadMatches(page, dialog, issuedBytes);
  await dialog.getByLabel('Dokumentversion', { exact: true }).selectOption(original.id);
  await downloadMatches(page, dialog, originalBytes);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(jsErrors).toEqual([]);
});

test('ny granskningsversion efter korrigerat pris bevarar föregående PDF oförändrad', async ({ request }) => {
  const fixture = await createPdfCard(request);
  const firstReview = await sendReview(request, fixture.card, fixture.customer);
  const first = (await archive(request, 'settlement', fixture.cardId))[0];
  const originalBytes = await pdf(request, first);
  await post(request, `/api/terminal-demo/approvals/${firstReview.id}/cancel`, {});
  const base = await readOffice(request), next = structuredClone(base);
  const card = next.cards.find(value => value.id === fixture.cardId)!;
  card.rows[0] = { ...card.rows[0], tier: 'Eget', price: card.rows[0].price + 1 };
  delete card.pricingSnapshotId; delete card.pricingTotal;
  const saved = await saveOffice(request, base, next);
  const secondReview = await sendReview(request, saved.cards.find(value => value.id === fixture.cardId)!, fixture.customer);
  const documents = await archive(request, 'settlement', fixture.cardId);
  expect(documents).toHaveLength(2);
  const updated = documents.find(document => document.sourceVersion === secondReview.version)!;
  expect(secondReview.version).toBe(firstReview.version + 1);
  expect(updated.id).not.toBe(first.id);
  expect(updated.sourceHash).not.toBe(first.sourceHash);
  expect(updated.pdfHash).not.toBe(first.pdfHash);
  expect((await pdf(request, first)).equals(originalBytes)).toBe(true);
  await pdf(request, updated);
});

test('transportutkast kan byta riktning och arkivera flera PDF-versioner utan lager- eller bokningsändring', async ({ page, request }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', error => jsErrors.push(error.message));
  const response = await request.get('/api/application/transport', { headers: admin });
  expect(response.ok()).toBe(true);
  const { data: base } = await response.json() as {data: TransportData};
  const orderId = `AO-${850_000_000 + randomInt(90_000_000)}`;
  const order = { ...structuredClone(base.orders.find(value => value.status === 'unbooked')!), id: orderId,
    customerName: `PDF-kund ${randomUUID().slice(0, 8)}`, status: 'unbooked' as const,
    requestedDate: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' }),
  };
  // This independent test customer has no registry link. A linked order must
  // correctly prefer its canonical customer's name over its display text.
  delete order.customerId;
  const next = structuredClone(base); next.orders.push(order);
  const saved = await request.post('/api/application/transport', { headers: admin, data: { base, next } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.route('https://*.tile.openstreetmap.org/**', route => route.abort());
  await office(page);
  await page.locator('.office-sidebar').getByRole('button', { name: 'Transportplanering', exact: true }).click();
  await page.getByTestId(`transport-queue-${orderId}`).click();
  await page.getByRole('button', { name: 'Öppna transportunderlag', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Transportdokument · ${orderId}`, exact: true });
  await expect(dialog.getByLabel('Riktning', { exact: true })).toHaveValue('pickup');
  await dialog.getByLabel('Riktning', { exact: true }).selectOption('outbound');
  await expect(dialog.getByLabel('Avsändare · Namn / företag', { exact: true })).toHaveValue('JEROC Återvinning AB');
  await expect(dialog.getByLabel('Mottagare · Namn / företag', { exact: true })).toHaveValue(order.customerName);
  await dialog.getByLabel('Referens', { exact: true }).fill(`PDF-${orderId}`);
  await dialog.getByLabel('Material 1', { exact: true }).fill('Blybatterier');
  await dialog.getByLabel('Avfallskod 1', { exact: true }).fill('16 06 01*');
  await dialog.getByLabel('Vikt (kg) 1', { exact: true }).fill('14.5');
  await dialog.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Transportutkastet är sparat.');
  const draftResponse = await request.get(`/api/documents/transport/${orderId}`, { headers: admin });
  expect(draftResponse.ok()).toBe(true);
  const draft = (await draftResponse.json() as TransportDocumentResponse).draft;
  expect(draft).toMatchObject({ direction: 'outbound', version: 1, reference: `PDF-${orderId}` });
  expect(draft.rows[0]).toMatchObject({ name: 'Blybatterier', weight: 14.5 });
  await dialog.getByRole('button', { name: 'Skapa PDF-utkast', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'PDF-utkastet är arkiverat.' })).toHaveText('PDF-utkastet är arkiverat.');
  const first = (await archive(request, 'transport', orderId))[0], firstBytes = await pdf(request, first);
  expect(first.stage).toBe('draft');
  await downloadMatches(page, dialog, firstBytes);
  await dialog.getByRole('button', { name: 'Uppgifter', exact: true }).click();
  await dialog.getByLabel('Vikt (kg) 1', { exact: true }).fill('17.2');
  await dialog.getByRole('button', { name: 'Skapa PDF-utkast', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'PDF-utkastet är arkiverat.' })).toHaveText('PDF-utkastet är arkiverat.');
  const versions = await archive(request, 'transport', orderId);
  expect(versions.map(document => document.sourceVersion).sort()).toEqual([1, 2]);
  expect((await pdf(request, first)).equals(firstBytes)).toBe(true);
  const latest = versions.find(document => document.sourceVersion === 2)!;
  await downloadMatches(page, dialog, await pdf(request, latest));
  await dialog.getByRole('button', { name: 'Stäng transportdokument', exact: true }).click();
  await page.getByRole('button', { name: 'Öppna transportunderlag', exact: true }).click();
  await expect(dialog.getByLabel('Riktning', { exact: true })).toHaveValue('outbound');
  await expect(dialog.getByLabel('Vikt (kg) 1', { exact: true })).toHaveValue('17.2');
  const after = await request.get('/api/application/transport', { headers: admin });
  const { data: canonical } = await after.json() as {data: TransportData};
  expect(canonical.orders.find(value => value.id === orderId)).toEqual(order);
  expect(canonical.events).toEqual(base.events);
  expect(jsErrors).toEqual([]);
});
