import { test, expect, type Page } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { seedTransport } from '../src/office/transport/model';
import type { TransportData } from '../src/office/transport/types';

test.use({ viewport: { width: 1920, height: 1080 }, isMobile: false, hasTouch: false });
const targetOrderIds = new WeakMap<Page, string>();
async function transport(page: Page) {
  const headers = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
  const response = await page.request.get('/api/application/transport', { headers });
  expect(response.ok()).toBe(true);
  const { data: base } = await response.json() as { data: TransportData };
  const seed = seedTransport('2026-10-09');
  const firstId = 700_000_000 + randomInt(89_000_000);
  const aliases = new Map(seed.orders.map((entry, index) => [entry.id, `AO-${firstId + index}`]));
  targetOrderIds.set(page, aliases.get('AO-1042')!);
  const originalIds = new Set(seed.orders.map(entry => entry.id));
  const retained = base.orders.filter(entry => {
    const numericId = Number(entry.id.match(/^AO-(\d+)$/)?.[1]);
    return !originalIds.has(entry.id) && (!Number.isFinite(numericId) || numericId < 700_000_000);
  });
  const retainedIds = new Set(retained.map(entry => entry.id));
  const next: TransportData = { ...base, revision: base.revision + 1,
    orders: [...retained, ...seed.orders.map(entry => ({ ...entry, id: aliases.get(entry.id)! }))],
    preliminary: Object.fromEntries(Object.entries(base.preliminary).filter(([id]) => retainedIds.has(id))),
  };
  // Preserve staffing examples, driver/person links and all existing event IDs.
  const replaced = await page.request.post('/api/application/transport', { headers, data: { kind: 'update', base, next } });
  expect(replaced.ok(), await replaced.text()).toBe(true);
  await page.route('https://*.tile.openstreetmap.org/**', (route) => route.abort());
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Kajsa Nilsson/ }).click();
  await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
  await page.locator('.office-sidebar').getByRole('button', { name: 'Transportplanering', exact: true }).click();
  await expect(page.getByTestId('transport-workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nytt uppdrag', exact: true })).toBeVisible();
  await page.getByLabel('Datum i planeraren', { exact: true }).fill('2026-10-09');
  await expect(page.getByTestId(`calendar-order-${targetOrderIds.get(page)}`)).toBeVisible();
}
const saved = (page: Page): Promise<TransportData> => page.evaluate(() => JSON.parse(localStorage.getItem('jeroc.transport.demo.v1')!));

test('lokalt sparad händelse retryas med samma ID och återläsning dubblerar inte serverns förberedda utkorg', async ({ page }) => {
  const attempts: { ids: string[]; actor: string; effective: string }[] = [];
  let transientFailure = true;
  const externalWrites: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD'].includes(request.method()) && new URL(request.url()).origin !== 'http://127.0.0.1:5173') externalWrites.push(request.url());
  });
  await page.route('**/api/transport/outbox', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') { await route.continue(); return; }
    const payload = request.postDataJSON() as { events: { id: string; orderId: string; type: string }[] };
    const own = payload.events.filter(event => event.orderId === targetOrderIds.get(page) && event.type === 'work_order.confirmation_requested');
    if (!own.length) { await route.continue(); return; }
    attempts.push({ ids: own.map((event) => event.id), actor: request.headers()['x-demo-actor'], effective: request.headers()['x-demo-user'] });
    if (transientFailure) {
      transientFailure = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Tillfälligt serverfel i testet.', deliveryEnabled: false, memoryOnly: false }) });
    } else await route.continue();
  });
  await transport(page);
  const orderId = targetOrderIds.get(page)!;
  await page.getByTestId(`calendar-order-${orderId}`).locator('.tc-order-open').click();
  const integration = page.getByRole('region', { name: 'Kundförfrågan och integrationshändelser', exact: true });
  await integration.locator('summary').click();
  const previousEvents = (await saved(page)).events.filter(event => event.actualUserId === 'kajsa' && event.effectiveUserId === 'kajsa').length;
  if (previousEvents) await expect(integration.getByRole('status')).toContainText(`${previousEvents} händelser förberedda på servern`);
  await integration.getByRole('button', { name: 'Förbered förfrågan', exact: true }).click();
  await expect(integration.getByText('Inväntar kundsvar', { exact: true })).toBeVisible();
  await expect(integration.getByRole('status')).toContainText('Lokala händelser väntar på återförsök');
  const event = (await saved(page)).events.find((item) => item.type === 'work_order.confirmation_requested' && item.orderId === orderId)!;
  expect(event).toBeTruthy();
  expect(event.actualUserId).toBe('kajsa'); expect(event.effectiveUserId).toBe('kajsa');
  await expect(integration.getByRole('status')).toContainText(`${previousEvents + 1} händelser förberedda på servern`, { timeout: 15000 });
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual({ ids: [event.id], actor: 'kajsa', effective: 'kajsa' });
  expect(attempts[1]).toEqual(attempts[0]);

  // Reload replays all this user's immutable events; inspect the batch carrying
  // this test's event rather than assuming the persistent ledger is empty.
  const replay = page.waitForResponse((response) => response.url().endsWith('/api/transport/outbox') && response.request().method() === 'POST' && response.status() === 200
    && (response.request().postDataJSON() as { events: { id: string }[] }).events.some(item => item.id === event.id));
  await page.reload();
  const receipt = await (await replay).json();
  expect(receipt.acceptedIds).toContain(event.id); expect(receipt.duplicates).toBe(receipt.acceptedIds.length); expect(receipt.prepared).toBe(0);
  expect(receipt.deliveryEnabled).toBe(false);
  expect((await saved(page)).events.filter((item) => item.id === event.id)).toHaveLength(1);
  const response = await page.request.get('/api/transport/outbox', { headers: { 'X-Demo-Actor': 'kajsa', 'X-Demo-User': 'kajsa' } });
  expect(response.status()).toBe(200);
  const outbox = await response.json();
  const own = outbox.entries.filter((entry: { event: { id: string } }) => entry.event.id === event.id);
  expect(own).toHaveLength(1);
  expect(own[0]).toMatchObject({ state: 'prepared', attempts: 0 });
  expect(outbox.deliveryEnabled).toBe(false); expect(outbox.memoryOnly).toBe(false); expect(outbox.storage).toBe('database');
  expect(externalWrites).toEqual([]);
});
