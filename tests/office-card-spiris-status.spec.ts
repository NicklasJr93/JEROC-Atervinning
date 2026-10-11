import { test, expect, type Page } from '@playwright/test';
import { createOfficeCard, completedOfficeCard } from './helpers/financial-card';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
async function login(page: Page, name: string) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
}
const projection = (cardId: number, status: string) => ({ export: {
  id: `export-${cardId}`, cardId, approvalId: 'approved-version', version: 2, status,
  startedAt: '2026-10-11T09:00:00Z', finishedAt: status === 'accepted' ? '2026-10-11T09:01:00Z' : null,
  supplierId: 'supplier-persisted-id', draftId: status === 'accepted' ? 'draft-persisted-id' : null,
  events: [
    { at: '2026-10-11T09:01:00Z', text: 'Utkast sparat i Spiris.', actor: 'Spiris-arbetare' },
    { at: '2026-10-11T09:00:00Z', text: 'Attesterad version köad.', actor: 'Spiris-arbetare' },
  ],
  supplierPayload: { bankAccount: 'BANK-DATA-MUST-NOT-RENDER' },
} });

test('kortet visar endast överföringsprojektionen, ordnar händelser och slutar polla när klart', async ({ page, request }) => {
  const { cardId } = await createOfficeCard(request);
  let reads = 0;
  let status = 'queued';
  await page.route(`**/api/application/office/accounting/cards/${cardId}`, async route => {
    expect(route.request().method()).toBe('GET');
    expect(route.request().headers()['x-demo-actor']).toBe('anna');
    expect(route.request().headers()['x-demo-user']).toBe('anna');
    reads += 1;
    await route.fulfill({ json: projection(cardId, status) });
  });
  await login(page, 'Anna Nilsson');
  await page.clock.install();
  await page.goto(`/kontor#/weighings/${cardId}`);
  const panel = page.getByRole('region', { name: 'Spiris-överföring', exact: true });
  await expect(panel).toContainText('Köad');
  await expect(panel.getByRole('list', { name: 'Överföringshistorik', exact: true }).locator('li').first()).toContainText('Attesterad version köad.');
  await expect(panel).not.toContainText('BANK-DATA-MUST-NOT-RENDER');
  await expect(panel.getByRole('link', { name: 'Öppna fullständig överföringsjournal', exact: true })).toHaveCount(0);
  status = 'accepted';
  await page.clock.fastForward(2600);
  await expect(panel).toContainText('Utkast skapat');
  await expect(panel).toContainText('draft-persisted-id');
  const completeReads = reads;
  await page.clock.fastForward(6000);
  expect(reads).toBe(completeReads);
  await panel.getByRole('button', { name: 'Uppdatera', exact: true }).click();
  await expect.poll(() => reads).toBe(completeReads + 1);
});

test('attesterat kort utan överföring gör bara tre extra läsningar och journalen följer aktuell roll', async ({ page, request }) => {
  const { cardId } = await completedOfficeCard(request, { pay: false });
  let reads = 0;
  await page.route(`**/api/application/office/accounting/cards/${cardId}`, async route => {
    reads += 1;
    await route.fulfill({ json: { export: null } });
  });
  await login(page, 'Systemadmin');
  await page.clock.install();
  await page.goto(`/kontor#/weighings/${cardId}`);
  const panel = page.getByRole('region', { name: 'Spiris-överföring', exact: true });
  await expect(panel).toContainText('Ingen överföring ännu');
  await expect(panel.getByRole('link', { name: 'Öppna fullständig överföringsjournal', exact: true })).toHaveAttribute('href', '#/integrations?service=visma');
  for (let retry = 0; retry < 3; retry += 1) {
    await page.clock.fastForward(2100);
    await expect.poll(() => reads).toBe(retry + 2);
  }
  await page.clock.fastForward(10000);
  expect(reads).toBe(4);
  await page.locator('.office-sidebar-profile').getByLabel('Öppna profilmeny', { exact: true }).click();
  await page.getByLabel('Jobba som', { exact: true }).selectOption('anna');
  await expect(panel.getByRole('link', { name: 'Öppna fullständig överföringsjournal', exact: true })).toHaveCount(0);
});

test('prisbehörighet utan ekonomibehörighet läser inte överföringsstatus', async ({ page, request }) => {
  const { cardId } = await createOfficeCard(request);
  let reads = 0;
  await page.route(`**/api/application/office/accounting/cards/${cardId}`, async route => {
    reads += 1;
    await route.fulfill({ json: projection(cardId, 'accepted') });
  });
  await login(page, 'Kajsa Nilsson');
  await page.goto(`/kontor#/weighings/${cardId}`);
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: 'Spårbarhet', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Spiris-överföring', exact: true })).toHaveCount(0);
  expect(reads).toBe(0);
});

test('kortbyte avbryter en pågående statusläsning och visar bara det aktuella kortet', async ({ page, request }) => {
  const first = await createOfficeCard(request), second = await createOfficeCard(request);
  let releaseFirst!: () => void;
  const delayed = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.route(`**/api/application/office/accounting/cards/${first.cardId}`, async route => {
    await delayed;
    await route.fulfill({ json: projection(first.cardId, 'accepted') }).catch(() => {});
  });
  await page.route(`**/api/application/office/accounting/cards/${second.cardId}`, route =>
    route.fulfill({ json: projection(second.cardId, 'accepted') }));
  await login(page, 'Anna Nilsson');
  const firstRead = page.waitForRequest(value => value.url().endsWith(`/accounting/cards/${first.cardId}`));
  await page.goto(`/kontor#/weighings/${first.cardId}`);
  await firstRead;
  const cancelled = page.waitForEvent('requestfailed', value => value.url().endsWith(`/accounting/cards/${first.cardId}`));
  await page.goto(`/kontor#/weighings/${second.cardId}`);
  await cancelled;
  releaseFirst();
  const panel = page.getByRole('region', { name: 'Spiris-överföring', exact: true });
  await expect(panel).toContainText(`export-${second.cardId}`);
  await expect(panel).not.toContainText(`export-${first.cardId}`);
});
