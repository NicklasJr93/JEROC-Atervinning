import { test, expect, type Page } from '@playwright/test';
import type { TransportData } from '../src/office/transport/types';

test.use({ viewport: { width: 1920, height: 1080 }, isMobile: false, hasTouch: false });
async function transport(page: Page) {
  await page.route('https://*.tile.openstreetmap.org/**', (route) => route.abort());
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Kajsa Nilsson/ }).click();
  await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
  await page.locator('.office-sidebar').getByRole('button', { name: 'Transportplanering', exact: true }).click();
  await expect(page.getByTestId('transport-workspace')).toBeVisible();
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
    const payload = request.postDataJSON() as { events: { id: string }[] };
    attempts.push({ ids: payload.events.map((event) => event.id), actor: request.headers()['x-demo-actor'], effective: request.headers()['x-demo-user'] });
    if (transientFailure) {
      transientFailure = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Tillfälligt serverfel i testet.', deliveryEnabled: false, memoryOnly: true }) });
    } else await route.continue();
  });
  await transport(page);
  await page.getByTestId('calendar-order-AO-1042').locator('.tc-order-open').click();
  const integration = page.getByRole('region', { name: 'Kundförfrågan och integrationshändelser', exact: true });
  await integration.locator('summary').click();
  await integration.getByRole('button', { name: 'Förbered förfrågan', exact: true }).click();
  await expect(integration.getByText('Inväntar kundsvar', { exact: true })).toBeVisible();
  await expect(integration.getByRole('status')).toContainText('Lokala händelser väntar på återförsök');
  const event = (await saved(page)).events.find((item) => item.type === 'work_order.confirmation_requested')!;
  expect(event).toBeTruthy();
  expect(event.actualUserId).toBe('kajsa'); expect(event.effectiveUserId).toBe('kajsa');
  await expect(integration.getByRole('status')).toContainText('1 händelser förberedda på servern', { timeout: 15000 });
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual({ ids: [event.id], actor: 'kajsa', effective: 'kajsa' });
  expect(attempts[1]).toEqual(attempts[0]);

  const replay = page.waitForResponse((response) => response.url().endsWith('/api/transport/outbox') && response.request().method() === 'POST' && response.status() === 200);
  await page.reload();
  const receipt = await (await replay).json();
  expect(receipt.acceptedIds).toEqual([event.id]); expect(receipt.duplicates).toBe(1); expect(receipt.prepared).toBe(0);
  expect(receipt.deliveryEnabled).toBe(false);
  expect((await saved(page)).events.filter((item) => item.id === event.id)).toHaveLength(1);
  const response = await page.request.get('/api/transport/outbox', { headers: { 'X-Demo-Actor': 'kajsa', 'X-Demo-User': 'kajsa' } });
  expect(response.status()).toBe(200);
  const outbox = await response.json();
  const own = outbox.entries.filter((entry: { event: { id: string } }) => entry.event.id === event.id);
  expect(own).toHaveLength(1);
  expect(own[0]).toMatchObject({ state: 'prepared', attempts: 0 });
  expect(outbox.deliveryEnabled).toBe(false); expect(outbox.memoryOnly).toBe(true);
  expect(externalWrites).toEqual([]);
});
