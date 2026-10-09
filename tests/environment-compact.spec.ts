import { randomInt, randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { seedOffice, type OfficeData } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { EnvironmentState } from '../src/office/environment-types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(75_000);

function receiptFixture(origin = 'Industrivägen 8, 761 41 Norrtälje') {
  const data = migrateOffice(seedOffice());
  const cardId = 56_000_000 + randomInt(1_000_000);
  const sourceId = randomUUID();
  data.cards.push({ ...data.cards.find(card => card.id === 2050)!, id: cardId, sourceId, origin });
  return { data, cardId, sourceId };
}

async function openCard(page: Page, fixture: ReturnType<typeof receiptFixture>, userName = 'Systemadmin') {
  await page.addInitScript(value => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(value));
  }, fixture.data);
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(userName) }).click();
  await page.goto(`/kontor#/weighings/${fixture.cardId}`);
  const panel = page.getByRole('region', { name: 'Miljö och mottagning', exact: true });
  await expect(panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true })).toBeEnabled();
  return panel;
}

async function state(request: APIRequestContext): Promise<EnvironmentState> {
  const response = await request.get('/api/environment/state');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function recorded(page: Page, sourceId: string) {
  await expect.poll(async () => (await state(page.request)).receipts.some(receipt => receipt.sourceId === sourceId)).toBe(true);
  return (await state(page.request)).receipts.find(receipt => receipt.sourceId === sourceId)!;
}

async function confirmReceipt(page: Page, sourceId: string) {
  const panel = page.getByRole('region', { name: 'Miljö och mottagning', exact: true });
  await expect(panel).toContainText('Norrtälje · 0188');
  await panel.getByLabel('Dokumentstatus', { exact: true }).selectOption('provided');
  await panel.getByRole('button', { name: 'Bekräfta mottagning', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Bekräfta mottagning', exact: true });
  await expect(review).toContainText('Blybatterier');
  await expect(review).toContainText('250 kg');
  await expect(review).toContainText('Koppar klass 1');
  await expect(review).toContainText('12 kg');
  await review.getByRole('button', { name: 'Bekräfta mottagning', exact: true }).click();
  await expect(review).toHaveCount(0);
  return recorded(page, sourceId);
}

test('miljökortet ligger efter kundgodkännande och är kompakt före första mottagningen utan extra inloggning', async ({ page }) => {
  const fixture = receiptFixture();
  const panel = await openCard(page, fixture);
  await expect(page.getByLabel('Lösenord för miljödemot', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Anslut', exact: true })).toHaveCount(0);
  const order = await page.locator('.approval-controls, .environment-receipt-panel, .office-card-attest').evaluateAll(elements => elements.map(element => element.className));
  expect(order).toHaveLength(3);
  expect(order[0]).toContain('approval-controls');
  expect(order[1]).toContain('environment-receipt-panel');
  expect(order[2]).toContain('office-card-attest');

  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await expect(panel).toContainText('Industrivägen 8, 761 41 Norrtälje');
  await expect(panel.getByLabel('Transportsätt', { exact: true })).toHaveValue('road');
  await expect(panel.getByLabel('Inkommande transportdokument', { exact: true })).toHaveValue('');
  await expect(panel.getByRole('button', { name: 'Ändra tidigare innehavare', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Ändra ursprungsadress', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Ändra mottagningstid', exact: true })).toBeVisible();
  await expect(panel.getByLabel('Tidigare innehavare – namn', { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('Senaste hanteringsplats – postnummer', { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('Senaste hanteringsplats – kommunkod', { exact: true })).toHaveCount(0);
  expect(await panel.locator('input:visible, textarea:visible').count()).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const stored = await state(page.request);
  expect(stored.receipts.some(receipt => receipt.sourceId === fixture.sourceId)).toBe(false);
  expect(stored.inventory.some(item => item.sourceId === fixture.sourceId)).toBe(false);
});

test('sparat miljöutkast följer viktkortets ändrade ursprung och skapar inget fysiskt lager efter omladdning', async ({ page }) => {
  const fixture = receiptFixture();
  const panel = await openCard(page, fixture);
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await panel.getByLabel('Inkommande transportdokument', { exact: true }).fill('UTKAST-REFERENS');
  await panel.getByLabel('Transportsätt', { exact: true }).selectOption('rail');
  await panel.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await expect.poll(async () => (await state(page.request)).drafts.find(draft => draft.sourceId === fixture.sourceId)?.input.incomingDocument?.reference).toBe('UTKAST-REFERENS');

  await page.getByLabel('Ursprungsadress', { exact: true }).fill('Ängsvägen 19, 761 41 Norrtälje');
  await page.getByRole('button', { name: 'Spara referens & ursprung', exact: true }).click();
  await expect(panel).toContainText('Ängsvägen 19, 761 41 Norrtälje');
  await expect(panel).toContainText('Norrtälje · 0188');
  await panel.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await expect.poll(async () => (await state(page.request)).drafts.find(draft => draft.sourceId === fixture.sourceId)?.input.originAddress).toBe('Ängsvägen 19, 761 41 Norrtälje');
  await page.reload();
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await expect(panel.getByLabel('Inkommande transportdokument', { exact: true })).toHaveValue('UTKAST-REFERENS');
  await expect(panel.getByLabel('Transportsätt', { exact: true })).toHaveValue('rail');
  const shared = await state(page.request);
  const draft = shared.drafts.find(item => item.sourceId === fixture.sourceId)!;
  expect(draft.input.originAddress).toBe('Ängsvägen 19, 761 41 Norrtälje');
  expect(draft.input.lastPlace).toMatchObject({ address: 'Ängsvägen 19', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' });
  expect(shared.receipts.filter(item => item.sourceId === fixture.sourceId)).toHaveLength(0);
  expect(shared.inventory.filter(item => item.sourceId === fixture.sourceId)).toHaveLength(0);
  expect(shared.reports.filter(item => item.sourceId === fixture.sourceId)).toHaveLength(0);
});

test('saknat faktiskt ursprung använder aldrig kundens fakturaadress och redigering återförs till viktkortet', async ({ page }) => {
  const fixture = receiptFixture('');
  const billing = fixture.data.customers.find(customer => customer.id === 'customer-build')!;
  billing.address = 'Fakturagatan 99'; billing.postalCode = '11122'; billing.city = 'Stockholm';
  const panel = await openCard(page, fixture);
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await expect(panel).not.toContainText('Fakturagatan 99');
  await panel.getByRole('button', { name: 'Bekräfta mottagning', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(/ursprungsadress|kommun/i);
  await expect(page.getByRole('dialog', { name: 'Bekräfta mottagning', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Ändra ursprungsadress', exact: true }).click();
  const actualOrigin = panel.getByLabel('Ursprungsadress för materialet', { exact: true });
  await expect(actualOrigin).toHaveValue('');
  await actualOrigin.fill('Industrivägen 8, 761 41 Norrtälje');
  await panel.getByRole('button', { name: 'Spara ursprungsadress', exact: true }).click();
  await expect(page.getByLabel('Ursprungsadress', { exact: true })).toHaveValue('Industrivägen 8, 761 41 Norrtälje');
  await expect(panel).toContainText('Industrivägen 8, 761 41 Norrtälje');
  const saved = await page.evaluate(cardId => JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find((card: { id: number }) => card.id === cardId), fixture.cardId);
  expect(saved.origin).toBe('Industrivägen 8, 761 41 Norrtälje');
  await expect(panel).toContainText('Norrtälje · 0188');
  await panel.getByLabel('Dokumentstatus', { exact: true }).selectOption('provided');
  await expect(panel.getByRole('button', { name: 'Bekräfta mottagning', exact: true })).toBeEnabled();
});

test('osäker kommun kompletteras med ett begripligt kommunval utan separata gata- och postnummerfält', async ({ page }) => {
  const origin = 'Storgatan 12, 123 45 Demoort';
  const fixture = receiptFixture(origin);
  // Isolate the UI response to an ambiguous address lookup. Resolver matching
  // and municipal validation have separate server tests; this test uses no
  // third-party address provider and registers no physical receipt.
  await page.route('**/api/environment/address/resolve', async route => {
    const input = route.request().postDataJSON() as { originAddress: string; municipalityCode?: string };
    await route.fulfill({ json: {
      originAddress: input.originAddress,
      status: input.municipalityCode ? 'resolved' : 'needs_municipality',
      provider: 'explicit-browser-test',
      municipalityConfirmed: Boolean(input.municipalityCode),
      place: { address: 'Storgatan 12', postalCode: '12345', city: 'Demoort', municipalityCode: input.municipalityCode ?? '' },
      missingFields: input.municipalityCode ? [] : ['municipalityCode'],
      candidates: [],
    } });
  });
  const panel = await openCard(page, fixture);
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await expect(panel).toContainText(origin);
  await panel.getByRole('button', { name: 'Ändra ursprungsadress', exact: true }).click();
  await expect(panel.getByLabel('Ursprungsadress för materialet', { exact: true })).toHaveValue(origin);
  const municipality = panel.getByLabel('Kommun för ursprungsadressen', { exact: true });
  await expect(municipality).toBeVisible();
  await expect(municipality.locator('option[value="0188"]')).toHaveText(/Norrtälje/);
  await expect(panel.getByLabel('Senaste hanteringsplats – gatuadress', { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('Senaste hanteringsplats – postnummer', { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('Senaste hanteringsplats – kommunkod', { exact: true })).toHaveCount(0);
  const stored = await state(page.request);
  expect(stored.receipts.some(receipt => receipt.sourceId === fixture.sourceId)).toBe(false);
});

test('transportdokument kan finnas utan nummer och mottagning visar vikterna innan de låses', async ({ page }) => {
  const fixture = receiptFixture();
  const panel = await openCard(page, fixture);
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  const receipt = await confirmReceipt(page, fixture.sourceId);
  expect(receipt.snapshot.incomingDocument).toMatchObject({ status: 'provided' });
  expect(receipt.snapshot.incomingDocument.reference ?? '').toBe('');
  expect(receipt.deviations.some(item => item.code.includes('document'))).toBe(false);
  expect(receipt.snapshot.lastPlace).toMatchObject({ address: 'Industrivägen 8', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' });
  expect(receipt.snapshot.rows.map(row => [row.articleId, row.weight])).toEqual([['lead-battery', 250], ['copper-1', 12]]);
  const physical = (await state(page.request)).inventory.filter(item => item.sourceId === fixture.sourceId);
  expect(physical).toHaveLength(2);
  expect(physical.reduce((sum, item) => sum + item.weight, 0)).toBe(262);
});

test('två vägningar av samma artikel blir en fysisk mängd utan en falsk begäran om miljörättelse', async ({ page }) => {
  const fixture = receiptFixture();
  const card = fixture.data.cards.find(item => item.id === fixture.cardId)!;
  card.rows = [{ ...card.rows[0], weight: 125 }, { ...card.rows[0], weight: 125 }, card.rows[1]];
  const panel = await openCard(page, fixture);
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await expect(panel).toContainText('Norrtälje · 0188');
  await panel.getByLabel('Dokumentstatus', { exact: true }).selectOption('provided');
  await panel.getByRole('button', { name: 'Bekräfta mottagning', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Bekräfta mottagning', exact: true });
  await expect(review.getByText('125 kg', { exact: true })).toHaveCount(2);
  await review.getByRole('button', { name: 'Bekräfta mottagning', exact: true }).click();
  const receipt = await recorded(page, fixture.sourceId);
  expect(receipt.snapshot.rows.filter(row => row.articleId === 'lead-battery')).toEqual([expect.objectContaining({ weight: 250 })]);
  expect((await state(page.request)).inventory.filter(item => item.sourceId === fixture.sourceId && item.articleId === 'lead-battery').reduce((sum, item) => sum + item.weight, 0)).toBe(250);
  await expect(panel).not.toContainText(/viktkortet.*skiljer|viktkortet.*ändrats/i);
});

test('ändrad vikt kräver spårbar miljörättelse med bevarat original och nettolager medan en prisändring inte gör det', async ({ page }) => {
  const fixture = receiptFixture();
  const panel = await openCard(page, fixture);
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  const original = await confirmReceipt(page, fixture.sourceId);
  // This remains an unapproved editable weighing. The browser-local demo card
  // represents a yard weighing correction; the server receipt stays immutable.
  await page.evaluate(cardId => {
    const data = JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!);
    data.cards.find((card: { id: number }) => card.id === cardId).rows[0].weight = 245;
    localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, fixture.cardId);
  await page.reload();
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await expect(panel).toContainText(/viktkortet.*skiljer|viktkortet.*ändrats|skiljer.*viktkort|mängd.*skiljer/i);
  await panel.getByRole('button', { name: 'Rätta miljöuppgifter', exact: true }).click();
  const reason = 'Kontrollvägning: fem kilo emballage ingick felaktigt.';
  await panel.getByLabel('Orsak till miljörättelse', { exact: true }).fill(reason);
  await panel.getByRole('button', { name: 'Spara miljörättelse', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Bekräfta miljörättelse', exact: true });
  await expect(review).toContainText('245 kg');
  await review.getByRole('button', { name: /Bekräfta miljörättelse|Spara miljörättelse/ }).click();
  await expect.poll(async () => (await state(page.request)).receipts.find(receipt => receipt.sourceId === fixture.sourceId)?.version).toBe(2);
  const shared = await state(page.request);
  const current = shared.receipts.find(receipt => receipt.sourceId === fixture.sourceId)!;
  expect(current.snapshot.rows[0].weight).toBe(245);
  expect(current.originalSnapshot?.rows[0].weight).toBe(250);
  expect(current.originalHash).toBe(original.hash);
  expect(current.hash).not.toBe(original.hash);
  expect(current.correctionHistory).toHaveLength(1);
  expect(current.correctionHistory?.[0]).toMatchObject({ reason, previousHash: original.hash, version: 2 });
  expect(shared.inventory.filter(item => item.sourceId === fixture.sourceId && item.articleId === 'lead-battery').reduce((sum, item) => sum + item.weight, 0)).toBe(245);
  expect(shared.reports.find(item => item.sourceId === fixture.sourceId)).toMatchObject({ weight: 245, version: 2 });
  expect(shared.reportHistory.find(item => item.sourceId === fixture.sourceId)).toMatchObject({ weight: 250, version: 1, status: 'superseded' });
  await expect(panel).toContainText('Versionshistorik');
  await expect(panel).toContainText(reason);

  await page.evaluate(cardId => {
    const data = JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!);
    data.cards.find((card: { id: number }) => card.id === cardId).rows[0].price = 9;
    localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, fixture.cardId);
  await page.reload();
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await expect(panel).not.toContainText(/viktkortet.*skiljer|viktkortet.*ändrats|skiljer.*viktkort|mängd.*skiljer/i);
  const after = await state(page.request);
  expect(after.receipts.find(receipt => receipt.sourceId === fixture.sourceId)?.hash).toBe(current.hash);
  expect(after.corrections.filter(item => item.sourceId === fixture.sourceId)).toHaveLength(1);
  expect(after.inventory.filter(item => item.sourceId === fixture.sourceId && item.articleId === 'lead-battery').reduce((sum, item) => sum + item.weight, 0)).toBe(245);
});

test('två kassor som ändrar samma utkast får versionskonflikt utan att det andra lokala förslaget försvinner', async ({ browser, baseURL }) => {
  const fixture = receiptFixture();
  const contexts: BrowserContext[] = [];
  try {
    for (let index = 0; index < 2; index += 1) contexts.push(await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } }));
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    const panels = await Promise.all(pages.map(page => openCard(page, fixture)));
    await Promise.all(panels.map(panel => panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click()));
    await panels[0].getByLabel('Inkommande transportdokument', { exact: true }).fill('KASSA-ETT');
    await panels[1].getByLabel('Inkommande transportdokument', { exact: true }).fill('KASSA-TVÅ');
    await panels[0].getByRole('button', { name: 'Spara utkast', exact: true }).click();
    await expect.poll(async () => (await state(contexts[0].request)).drafts.find(draft => draft.sourceId === fixture.sourceId)?.input.incomingDocument?.reference).toBe('KASSA-ETT');
    const conflict = pages[1].waitForResponse(response => response.url().includes(`/api/environment/drafts/${fixture.sourceId}`) && response.request().method() === 'PUT');
    await panels[1].getByRole('button', { name: 'Spara utkast', exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(panels[1].getByRole('alert')).toContainText(/utkast|version|annan/i);
    await expect(panels[1].getByLabel('Inkommande transportdokument', { exact: true })).toHaveValue('KASSA-TVÅ');
    const stored = await state(contexts[1].request);
    expect(stored.drafts.find(draft => draft.sourceId === fixture.sourceId)?.input.incomingDocument?.reference).toBe('KASSA-ETT');
    expect(stored.inventory.filter(item => item.sourceId === fixture.sourceId)).toHaveLength(0);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('ett kontobyte i en annan flik kan inte spara det öppna miljökortet som fel person', async ({ page, context }) => {
  const fixture = receiptFixture();
  const panel = await openCard(page, fixture);
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await panel.getByLabel('Inkommande transportdokument', { exact: true }).fill('OSPARAT-FÖRSLAG');
  const anotherTab = await context.newPage();
  try {
    await anotherTab.goto('/kontor');
    const changed = await anotherTab.request.post('/api/environment/demo-session', { data: { userId: 'lars', effectiveUserId: 'lars' } });
    expect(changed.ok()).toBeTruthy();
    const attempt = page.waitForResponse(response => response.url().includes(`/api/environment/drafts/${fixture.sourceId}`) && response.request().method() === 'PUT');
    await panel.getByRole('button', { name: 'Spara utkast', exact: true }).click();
    const blocked = await attempt;
    expect(blocked.request().headers()['x-environment-actual-user']).toBe('admin');
    expect(blocked.status()).toBe(403);
    expect((await blocked.json()).code).toBe('session_identity_mismatch');
    await expect(panel.getByRole('alert')).toContainText('annan flik');
    expect((await state(anotherTab.request)).drafts.some(draft => draft.sourceId === fixture.sourceId)).toBe(false);
  } finally { await anotherTab.close(); }
});

test('ny demomedarbetare ansluts automatiskt med miljöläsning och anläggningsgräns utan prisbehörighet', async ({ page }) => {
  const headers = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
  const before = await page.request.get('/api/pricing/state', { headers });
  expect(before.ok()).toBeTruthy();
  const originalUsers = (await before.json()).users;
  const user = { id: `environment-reader-${randomUUID().slice(0, 8)}`, name: 'Miljöläsare utan priser', level: 'Medarbetare' as const,
    permissions: ['view', 'environmentRead'] as const, siteIds: ['norrtalje'], maxAttest: 0, ownAttest: false };
  expect((await page.request.post('/api/pricing/users', { headers, data: { users: [...originalUsers, user] } })).ok()).toBe(true);
  const fixture = receiptFixture();
  fixture.data.users = [...originalUsers, user] as OfficeData['users'];
  try {
    await page.addInitScript(data => { if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data)); }, fixture.data);
    await page.goto('/kontor');
    await page.getByRole('button', { name: /Miljöläsare utan priser/ }).click();
    await page.goto('/kontor#/environment');
    await expect(page.getByRole('heading', { name: 'Miljörapportering', exact: true })).toBeVisible();
    await expect(page.getByLabel('Lösenord för miljödemot', { exact: true })).toHaveCount(0);
    const session = await page.request.get('/api/environment/session');
    expect(session.ok()).toBe(true);
    expect(await session.json()).toMatchObject({ demo: true, actualUserId: user.id, effectiveUserId: user.id });
    const restricted = await state(page.request);
    expect(restricted.sites.map(site => site.id)).toEqual(['norrtalje']);
    expect((await page.request.get('/api/environment/state?siteId=rimbo')).status()).toBe(403);
    await page.goto('/kontor#/prices');
    await page.getByRole('button', { name: 'Redigera Blybatterier', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Miljöklassificering för Blybatterier', exact: true });
    await expect(panel.getByLabel('Avfallskod', { exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Spara miljöklassificering', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Prisbas & A/B/C-formler', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Referenspris (SEK/kg)', { exact: true })).toHaveCount(0);
    const prices = await page.request.get('/api/pricing/state', { headers: { 'X-Demo-Actor': user.id, 'X-Demo-User': user.id } });
    expect(prices.ok()).toBe(true);
    const article = (await prices.json()).articles.find((item: { id: string }) => item.id === 'lead-battery');
    expect(article).toBeDefined();
    expect(article.base).toBeUndefined();
    expect(article.tiers).toBeUndefined();
    expect(article.baseSekKg).toBeNull();
    expect(article.prices).toEqual({ A: null, B: null, C: null });
  } finally {
    expect((await page.request.post('/api/pricing/users', { headers, data: { users: originalUsers } })).ok()).toBe(true);
  }
});
