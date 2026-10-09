import { randomInt, randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { EnvironmentSessionState, EnvironmentState, EnvironmentalReceiptInput } from '../src/office/environment-types';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(75_000);

async function environmentDemoSession(request: APIRequestContext, userId = 'admin', effectiveUserId = userId) {
  const response = await request.post('/api/environment/demo-session', {
    data: { userId, effectiveUserId },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<EnvironmentSessionState>;
}

async function environmentState(request: APIRequestContext) {
  const response = await request.get('/api/environment/state');
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<EnvironmentState>;
}

test('två separata kassor delar oföränderlig mottagning utan dubbelt lager eller rapportunderlag', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  try {
    const one = await environmentDemoSession(first.request);
    const two = await environmentDemoSession(second.request);
    expect(one.demo).toBe(true);
    expect(one.csrfToken).not.toBe(two.csrfToken);
    const sessionCookie = (await first.cookies()).find(cookie => cookie.name === 'jeroc_environment_staff');
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    const before = await environmentState(first.request);
    const classification = before.classifications.find(item => item.articleId === 'lead-battery');
    const classified = await first.request.put('/api/environment/classifications/lead-battery', {
      headers: { 'X-Environment-CSRF': one.csrfToken },
      data: { expectedVersion: classification?.version ?? 0, hazardous: true, wasteCode: '160601', wasteDescription: 'Blybatterier', handlingInstructions: 'Förvara upprätt i tätt batterikärl.', adrRequired: false },
    });
    expect(classified.ok()).toBeTruthy();
    const savedClassification = await classified.json();
    expect((await environmentState(second.request)).classifications.find(item => item.articleId === 'lead-battery')).toMatchObject(savedClassification);

    const sourceId = randomUUID();
    const input: EnvironmentalReceiptInput = {
      sourceId, cardId: 54_000_000 + randomInt(1_000_000), siteId: 'norrtalje', receivedAt: '2026-10-09T11:20:00+02:00',
      rows: [{ articleId: 'lead-battery', weight: 250 }, { articleId: 'copper-1', weight: 12 }],
      previousHolder: { name: 'Testverkstad AB', number: '5560000167', contactName: 'Testperson', email: 'test@example.invalid', phone: '0701234567' },
      lastPlace: { address: 'Industrivägen 8', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' },
      nextPlace: { address: 'Ängsvägen 19', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' },
      transportMode: 'road', incomingDocument: { status: 'missing', missingReason: 'Transportdokument saknades vid mottagning · regressionstest.' },
      idempotencyKey: `receipt-${sourceId}`,
    };
    const received = await first.request.post('/api/environment/receipts', { headers: { 'X-Environment-CSRF': one.csrfToken }, data: input });
    expect(received.ok()).toBeTruthy();
    const receipt = await received.json();
    expect(receipt.snapshot.rows[0].classification).toMatchObject({ version: savedClassification.version, hazardous: true, wasteCode: '160601' });
    expect(receipt.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.deviations.length).toBeGreaterThan(0);

    // A retry from another authenticated browser returns the same physical event.
    const repeated = await second.request.post('/api/environment/receipts', { headers: { 'X-Environment-CSRF': two.csrfToken }, data: input });
    expect(repeated.ok()).toBeTruthy();
    expect((await repeated.json()).id).toBe(receipt.id);
    const shared = await environmentState(second.request);
    expect(shared.receipts.filter(item => item.sourceId === sourceId)).toHaveLength(1);
    expect(shared.inventory.filter(item => item.sourceId === sourceId)).toHaveLength(2);
    expect(shared.inventory.filter(item => item.sourceId === sourceId).reduce((sum, item) => sum + item.weight, 0)).toBe(262);
    expect(shared.reports.filter(item => item.sourceId === sourceId)).toHaveLength(1);
    expect(shared.reports.find(item => item.sourceId === sourceId)).toMatchObject({ weight: 250, wasteCode: '160601', mode: 'prepared-only' });

    const changed = await second.request.post('/api/environment/receipts', {
      headers: { 'X-Environment-CSRF': two.csrfToken }, data: { ...input, rows: [{ articleId: 'lead-battery', weight: 249 }] },
    });
    expect(changed.status()).toBe(409);
    const revisedClassification = await second.request.put('/api/environment/classifications/lead-battery', {
      headers: { 'X-Environment-CSRF': two.csrfToken },
      data: { expectedVersion: savedClassification.version, hazardous: true, wasteCode: '160601', wasteDescription: 'Blybatterier', handlingInstructions: 'Nya instruktioner gäller enbart senare mottagningar.', adrRequired: false },
    });
    expect(revisedClassification.ok()).toBeTruthy();
    const reloaded = await first.request.get('/api/environment/session');
    expect(reloaded.ok()).toBeTruthy();
    expect((await environmentState(first.request)).receipts.find(item => item.sourceId === sourceId)).toEqual(receipt);
  } finally {
    await first.close();
    await second.close();
  }
});

test('miljödemosessionen kräver känd användare, sessionscookie, åtgärdsrätt och CSRF', async ({ browser, baseURL }) => {
  const anonymous = await browser.newContext({ baseURL });
  const limited = await browser.newContext({ baseURL });
  const admin = await browser.newContext({ baseURL });
  try {
    expect((await anonymous.request.get('/api/environment/state', { headers: { 'X-Demo-User': 'admin', 'X-Demo-Actor': 'admin' } })).status()).toBe(401);
    expect((await anonymous.request.post('/api/environment/demo-session', { data: { userId: 'unknown-worker', effectiveUserId: 'admin' } })).status()).toBe(401);
    const session = await environmentDemoSession(admin.request);
    const state = await environmentState(admin.request);
    const current = state.classifications.find(item => item.articleId === 'lead-battery');
    const input = { expectedVersion: current?.version ?? 0, hazardous: true, wasteCode: '160601', wasteDescription: 'Blybatterier', handlingInstructions: '', adrRequired: false };
    expect((await admin.request.put('/api/environment/classifications/lead-battery', { data: input })).status()).toBe(403);
    expect((await admin.request.put('/api/environment/classifications/lead-battery', { headers: { 'X-Environment-CSRF': `${session.csrfToken}-invalid` }, data: input })).status()).toBe(403);
    const worker = await environmentDemoSession(limited.request, 'admin', 'anna');
    expect((await limited.request.put('/api/environment/classifications/lead-battery', { headers: { 'X-Environment-CSRF': worker.csrfToken }, data: input })).status()).toBe(403);
  } finally {
    await Promise.all([anonymous.close(), limited.close(), admin.close()]);
  }
});

test('artikelklassificering och faktisk mottagning sparas via kontoret och syns på en annan kassa', async ({ page, browser, baseURL }) => {
  const data = migrateOffice(seedOffice());
  const sourceId = randomUUID();
  const cardId = 55_000_000 + randomInt(1_000_000);
  data.cards.push({ ...data.cards.find(card => card.id === 2050)!, id: cardId, sourceId });
  const copperCardId = cardId + 1;
  const copper = data.cards.find(card => card.id === 2050)!.rows.find(row => row.articleId === 'copper-1')!;
  data.cards.push({ ...data.cards.find(card => card.id === 2050)!, id: copperCardId, sourceId: randomUUID(), rows: [copper] });
  await page.addInitScript(value => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(value));
  }, data);
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  const session = await environmentDemoSession(page.request);
  const before = await environmentState(page.request);
  const policy = await page.request.put('/api/environment/storage/policies/norrtalje', {
    headers: { 'X-Environment-CSRF': session.csrfToken },
    data: { expectedVersion: before.storagePolicies.find(item => item.siteId === 'norrtalje')?.version ?? 0,
      totalMaxKg: 1_000_000, rules: [{ wasteCode: '160601', allowed: true, maxKg: 1_000_000 }] },
  });
  expect(policy.ok()).toBe(true);
  await page.goto('/kontor#/prices');
  await page.getByRole('button', { name: 'Redigera Blybatterier', exact: true }).click();
  const classification = page.getByRole('region', { name: 'Miljöklassificering för Blybatterier', exact: true });
  await expect(classification.getByLabel('Avfallskod', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Lösenord för miljödemot', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Anslut', exact: true })).toHaveCount(0);
  await classification.getByRole('button', { name: /^Farligt avfall/ }).click();
  await classification.getByLabel('Avfallskod', { exact: true }).fill('160601');
  await classification.getByLabel('Miljöbeskrivning', { exact: true }).fill('Blybatterier');
  const instruction = `Tätt batterikärl · test ${sourceId}`;
  await classification.getByLabel('Säkerhetsanvisningar', { exact: true }).fill(instruction);
  await classification.getByRole('button', { name: 'Spara miljöklassificering', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Miljöklassificeringen och lagringsreglerna är sparade');
  await page.reload();
  await page.getByRole('button', { name: 'Redigera Blybatterier', exact: true }).click();
  await expect(classification.getByLabel('Säkerhetsanvisningar', { exact: true })).toHaveValue(instruction);
  await page.goto(`/kontor#/weighings/${copperCardId}`);
  await expect(page.getByRole('heading', { name: `Invägning #${copperCardId}`, exact: true })).toBeVisible();
  await expect.poll(async () => (await page.request.get('/api/environment/session')).ok()).toBe(true);
  await expect(page.getByRole('region', { name: 'Miljö och mottagning', exact: true })).toHaveCount(0);
  await expect(page.locator('.office-panel').filter({ has: page.getByRole('heading', { name: 'Material & prissättning', exact: true }) })).toContainText('Koppar klass 1');
  await page.goto(`/kontor#/weighings/${cardId}`);
  const receiptPanel = page.getByRole('region', { name: 'Miljö och mottagning', exact: true });
  await receiptPanel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await expect(receiptPanel).toContainText('250 kg');
  await expect(receiptPanel).not.toContainText('Koppar klass 1');
  await expect(receiptPanel.getByRole('region', { name: 'Lagringskontroll', exact: true })).toContainText('Tillkommer 250 kg');
  await expect(receiptPanel.getByRole('region', { name: 'Lagringskontroll', exact: true })).not.toContainText('Mottagningen ryms inte');
  await expect(receiptPanel).toContainText('Industrivägen 8, 761 41 Norrtälje');
  await expect(receiptPanel).toContainText('Norrtälje · 0188');
  await receiptPanel.getByLabel('Dokumentstatus', { exact: true }).selectOption('provided');
  await receiptPanel.getByLabel('Inkommande transportdokument', { exact: true }).fill(`TD-IN-${cardId}`);
  await receiptPanel.getByRole('button', { name: 'Bekräfta mottagning', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Bekräfta mottagning', exact: true });
  await expect(review).toContainText('250 kg');
  await expect(review).not.toContainText('12 kg');
  await expect(review).not.toContainText('Koppar klass 1');
  await review.getByRole('button', { name: 'Bekräfta mottagning', exact: true }).click();
  await expect.poll(async () => (await environmentState(page.request)).receipts.some(item => item.sourceId === sourceId)).toBe(true);
  await expect(receiptPanel.getByRole('button', { name: 'Bekräfta mottagning', exact: true })).toHaveCount(0);
  await page.reload();
  await receiptPanel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await expect(receiptPanel).toContainText(`TD-IN-${cardId}`);

  const colleague = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  try {
    const second = await colleague.newPage();
    await second.addInitScript(value => {
      if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(value));
    }, data);
    await second.goto('/kontor');
    await second.getByRole('button', { name: /Systemadmin/ }).click();
    await second.goto(`/kontor#/weighings/${cardId}`);
    const sharedPanel = second.getByRole('region', { name: 'Miljö och mottagning', exact: true });
    await expect(sharedPanel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true })).toBeEnabled();
    await sharedPanel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
    await expect(sharedPanel).toContainText(`TD-IN-${cardId}`);
    const state = await environmentState(colleague.request);
    expect(state.receipts.filter(item => item.sourceId === sourceId)).toHaveLength(1);
    expect(state.inventory.filter(item => item.sourceId === sourceId)).toHaveLength(1);
    expect(state.receipts.find(item => item.sourceId === sourceId)?.snapshot).toMatchObject({ materialScope: 'hazardous', rows: [{ articleId: 'lead-battery', weight: 250 }] });
    expect(state.reports.filter(item => item.sourceId === sourceId)).toHaveLength(1);
  } finally { await colleague.close(); }
});
