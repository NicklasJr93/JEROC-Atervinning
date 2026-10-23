import { expect, test, type Page } from '@playwright/test';

// Exercises the public, browser-local supplier workspace and actual IndexedDB
// documents. No mail, accounting, bank or production endpoint is contacted.
const demo = '/bokforing/index.html';
const storageKey = 'scrapplanner-bokforing-suite-v2';
test.use({ viewport: { width: 1500, height: 1050 }, isMobile: false, hasTouch: false });
test.setTimeout(45_000);
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const errors: string[] = []; pageErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message)); });
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });
const editor = (page: Page) => page.locator('#purchase-page-form');
const action = (page: Page, name: string) => page.locator(`#suite-main [data-action="${name}"]`);
const upload = (page: Page, source = 'file') => page.locator(`[data-document-upload][data-source="${source}"]`).first();
const png = { name: 'fiktiv-faktura.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGJkAAAAASUVORK5CYII=', 'base64') };
function pdfFile() {
  const contents = 'BT /F1 12 Tf 30 150 Td (FIKTIV FAKTURA) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}endstream`,
  ];
  let text = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { name: 'fiktiv-bilaga.pdf', mimeType: 'application/pdf', buffer: Buffer.from(text) };
}
async function open(page: Page, route = 'purchases') {
  await page.goto(`${demo}#${route}`);
  await expect(page.locator('#suite-main')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#suite-main')).not.toContainText('Vyn kunde inte öppnas');
}
async function savedState(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
}
async function documents(page: Page) {
  return page.evaluate(async () => {
    const path = '/bokforing/suite/documents.js';
    return (await import(path)).createDocumentStore().list();
  });
}
async function fillField(page: Page, name: string, value: string) {
  const field = editor(page).locator(`[name="${name}"]`);
  const parents = field.locator('xpath=ancestor::details');
  for (let index = 0; index < await parents.count(); index++) {
    const parent = parents.nth(index);
    if (await parent.getAttribute('open') === null) await parent.locator(':scope > summary').click();
  }
  await field.fill(value);
}
async function fillBill(page: Page, number = 'TEST-2026-14') {
  await fillField(page, 'supplier', 'Exempelverkstaden AB');
  await fillField(page, 'number', number);
  await fillField(page, 'netCents', '1000');
}
async function save(page: Page) {
  await editor(page).locator('button[type="submit"]').click();
  await expect(editor(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#purchases\/[^/]+$/);
}
async function book(page: Page) {
  await action(page, 'book-bill').click();
  await page.locator('#suite-dialog [name="reviewed"]').check();
  await page.locator('#suite-dialog button[type="submit"]').click();
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
}

async function deferDocumentVerification(page: Page) {
  await page.evaluate(() => {
    const scope = window as typeof window & {
      purchaseRaceStarted?: boolean;
      purchaseRaceFinished?: boolean;
      releasePurchaseRace?: () => void;
    };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let armed = true;
    crypto.subtle.digest = (algorithm, bytes) => {
      if (!armed) return digest(algorithm, bytes);
      armed = false;
      scope.purchaseRaceStarted = true;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        scope.releasePurchaseRace = () => { void digest(algorithm, bytes).then(resolve, reject); };
      });
    };
    const request = navigator.locks.request;
    Object.defineProperty(navigator.locks, 'request', { configurable: true, value: function (...args: unknown[]) {
      const pending = Reflect.apply(request, navigator.locks, args) as Promise<unknown>;
      if (args[0] !== 'scrapplanner-bokforing-document-links') return pending;
      scope.purchaseRaceFinished = false;
      return pending.finally(() => { scope.purchaseRaceFinished = true; });
    } });
  });
}

test('äldre leverantörsfaktura öppnas på egen adress via tangentbord utan att sparade data skrivs om', async ({ page }) => {
  await open(page);
  const legacy = await page.evaluate(async key => {
    const path = '/bokforing/suite/seed.js';
    const state = (await import(path)).createSuiteState();
    for (const bill of state.bills) {
      delete bill.details; delete bill.attachments; delete bill.additionalAttachments; delete bill.additionalAttachmentsSnapshot;
      if (bill.status !== 'draft') bill.bookingSnapshot = JSON.stringify([bill.supplier, bill.number, bill.date, bill.dueDate, bill.netCents, bill.vatRate, bill.vatMode, bill.account, bill.vatCents, bill.totalCents, bill.reverseConfirmed, bill.projectId ?? null]);
    }
    const bill = state.bills.find((item: { status: string }) => item.status === 'booked');
    const raw = JSON.stringify(state); localStorage.setItem(key, raw);
    return { id: bill.id, number: bill.number, raw };
  }, storageKey);
  await page.reload();
  const link = page.locator(`[data-select-bill="${legacy.id}"]`);
  await link.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#purchases/${legacy.id}$`));
  await expect(page.locator('#suite-main')).toContainText(legacy.number);
  await expect(page.locator('#suite-main [data-select-bill]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#suite-storage-notice')).toBeHidden();
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(legacy.raw);
  await page.goBack(); await expect(page).toHaveURL(/#purchases$/);
  await page.goForward(); await expect(page).toHaveURL(new RegExp(`#purchases/${legacy.id}$`));
});

test('stor leverantörseditor behåller felaktig inmatning och sparar redigerbara fakturauppgifter', async ({ page }) => {
  await open(page, 'purchases/new');
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
  const formBox = await editor(page).boundingBox(), mainBox = await page.locator('#suite-main').boundingBox();
  expect(formBox!.width).toBeGreaterThan(mainBox!.width * 0.85);
  await fillBill(page);
  await fillField(page, 'details.ourReference', 'Åke testar referens');
  await fillField(page, 'details.paymentReference', '1234567890');
  await fillField(page, 'netCents', 'inte ett belopp');
  await editor(page).locator('button[type="submit"]').click();
  await expect(page.locator('#purchase-page-error')).toBeVisible();
  await expect(editor(page).locator('[name="details.ourReference"]')).toHaveValue('Åke testar referens');
  await expect(editor(page).locator('[name="netCents"]')).toHaveValue('inte ett belopp');
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  await fillField(page, 'netCents', '1000'); await save(page);
  await action(page, 'edit-bill').click();
  await expect(page).toHaveURL(/#purchases\/[^/]+\/edit$/);
  await expect(editor(page).locator('[name="details.ourReference"]')).toHaveValue('Åke testar referens');
  await fillField(page, 'details.ourReference', 'Ny referens efter granskning'); await save(page);
  const saved = await savedState(page), bill = saved.bills.at(-1);
  expect(bill.details.paymentReference).toBe('1234567890');
  expect(bill.details.ourReference).toBe('Ny referens efter granskning');
  expect(bill.totalCents).toBe(125_000);
});

test('PNG och PDF sparas som riktiga lokala filer och följer fakturan efter omladdning', async ({ page }) => {
  await open(page, 'purchases/new'); await fillBill(page, 'UPLOAD-2026-01');
  await upload(page).setInputFiles([png, pdfFile()]);
  await expect.poll(async () => (await documents(page)).length).toBe(2);
  await expect(page.locator('#purchase-document-panel')).toContainText('fiktiv-faktura.png');
  await save(page); const bill = (await savedState(page)).bills.at(-1);
  expect(bill.attachments).toHaveLength(2);
  expect(bill.attachments.map((file: { type: string }) => file.type).sort()).toEqual(['application/pdf', 'image/png']);
  await page.reload();
  await expect(page.locator('#purchase-document-panel')).toContainText('fiktiv-faktura.png');
  const pdf = bill.attachments.find((file: { type: string }) => file.type === 'application/pdf');
  await page.locator(`[data-action="select-document"][data-id="${pdf.id}"]`).click();
  await expect(page.locator('#purchase-document-viewer iframe, #purchase-document-viewer object')).toBeVisible();
  const persisted = await page.evaluate(async () => {
    const path = '/bokforing/suite/documents.js'; const store = (await import(path)).createDocumentStore();
    const files = await store.list();
    return Promise.all(files.map(async (file: { id: string }) => { const item = await store.get(file.id); return { name: item.name, size: item.blob.size, type: item.blob.type }; }));
  });
  expect(persisted).toEqual(expect.arrayContaining([{ name: png.name, size: png.buffer.length, type: 'image/png' }, { name: 'fiktiv-bilaga.pdf', size: pdfFile().buffer.length, type: 'application/pdf' }]));
});

test('underlagsimport nekar falsk PDF och återanvänder samma fil utan dubletter', async ({ page }) => {
  await open(page, 'purchases/new');
  await upload(page).setInputFiles([png, { name: 'falsk.pdf', mimeType: 'application/pdf', buffer: Buffer.from('detta är ingen PDF') }]);
  await expect(page.locator('#purchase-page-error')).toBeVisible();
  expect(await documents(page)).toHaveLength(0);
  await upload(page).setInputFiles(png);
  await expect.poll(async () => (await documents(page)).length).toBe(1);
  await upload(page).setInputFiles({ ...png, name: 'samma-bild-igen.png' });
  await expect.poll(async () => (await documents(page)).length).toBe(1);
  await fillBill(page, 'ONE-DOCUMENT'); await save(page);
  expect((await savedState(page)).bills.at(-1).attachments).toHaveLength(1);
});

test('bokförd leverantörsfaktura behåller originalet när en ny bilaga läggs till', async ({ page }) => {
  await open(page, 'purchases/new'); await fillBill(page, 'LOCKED-DOCUMENT');
  await upload(page).setInputFiles(png);
  await expect.poll(async () => (await documents(page)).length).toBe(1);
  await save(page); await book(page);
  const before = await savedState(page), original = before.bills.at(-1);
  await expect(action(page, 'edit-bill')).toHaveCount(0);
  await expect(action(page, 'unlink-document')).toHaveCount(0);
  await upload(page).setInputFiles(pdfFile());
  await expect.poll(async () => ((await savedState(page)).bills.at(-1).additionalAttachments ?? []).length).toBe(1);
  const after = await savedState(page), bill = after.bills.at(-1);
  expect(bill.attachments).toEqual(original.attachments);
  expect(bill.bookingSnapshot).toBe(original.bookingSnapshot);
  expect(bill.entryId).toBe(original.entryId);
  expect(after.entries).toEqual(before.entries);
  await page.reload();
  await expect(page.locator('#purchase-document-panel')).toContainText('fiktiv-bilaga.pdf');
  await expect(action(page, 'unlink-document')).toHaveCount(0);
});

test('inkorgen skapar fakturautkast och kopplar komplettering till befintlig faktura utan ny skuld', async ({ page }) => {
  await open(page, 'purchases/inbox');
  await expect(page.locator('#suite-main')).toContainText(/E-post.*inte ansluten|E-postmottagning.*inte ansluten/i);
  await upload(page).setInputFiles(pdfFile());
  await expect.poll(async () => (await documents(page)).length).toBe(1);
  const document = (await documents(page))[0];
  await page.locator(`[data-action="create-bill-from-document"][data-id="${document.id}"]`).click();
  await expect(editor(page)).toBeVisible();
  await expect(page.locator('#purchase-document-panel')).toContainText(document.name);
  await fillBill(page, 'FROM-INBOX'); await save(page);
  expect((await savedState(page)).bills.at(-1).attachments[0].id).toBe(document.id);
  await book(page);
  const before = await savedState(page), original = before.bills.at(-1);
  await page.goto(`${demo}#purchases/inbox`);
  await expect(page.locator('#suite-main')).toContainText('FROM-INBOX');
  await upload(page).setInputFiles(png);
  await expect.poll(async () => (await documents(page)).length).toBe(2);
  const supplement = (await documents(page)).find((file: { name: string }) => file.name === png.name);
  await page.locator(`[data-action="link-document-existing"][data-id="${supplement.id}"]`).click();
  await page.locator('#suite-dialog [name="billId"]').selectOption(original.id);
  await page.locator('#suite-dialog button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`#purchases/${original.id}$`));
  const after = await savedState(page), changed = after.bills.find((bill: { id: string }) => bill.id === original.id);
  expect(after.bills).toHaveLength(before.bills.length);
  expect(after.entries).toEqual(before.entries);
  expect(changed.bookingSnapshot).toBe(original.bookingSnapshot);
  expect(changed.additionalAttachments[0].id).toBe(supplement.id);
});

test('mobil visar hela leverantörsformuläret och erbjuder kamerafångst', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'purchases/new');
  await expect(upload(page, 'camera')).toHaveAttribute('capture', 'environment');
  await expect(upload(page, 'camera')).toHaveAttribute('accept', /image\//);
  await fillBill(page, 'MOBILE-CAMERA');
  await upload(page, 'camera').setInputFiles(png);
  await expect.poll(async () => (await documents(page)).length).toBe(1);
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(widths.page).toBeLessThanOrEqual(widths.viewport + 1);
  await save(page);
  expect((await savedState(page)).bills.at(-1).attachments[0].source).toBe('camera');
});

test('osparade leverantörsuppgifter kan stanna kvar och demo-reset lämnar filerna i inkorgen', async ({ page }) => {
  await open(page, 'purchases/new'); await fillBill(page, 'UNSAVED-SUPPLIER');
  await fillField(page, 'details.ourReference', 'Referens som ska återställas');
  await upload(page).setInputFiles(png);
  await expect.poll(async () => (await documents(page)).length).toBe(1);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('[data-nav="overview"]').click();
  await expect(page).toHaveURL(/#purchases\/new$/);
  await expect(editor(page).locator('[name="details.ourReference"]')).toHaveValue('Referens som ska återställas');
  await page.locator('#suite-sidebar [data-action="reset"]').click();
  await page.locator('#suite-dialog [name="confirmed"]').check();
  await page.locator('#suite-dialog button[type="submit"]').click();
  await expect(page).toHaveURL(/#purchases$/);
  await expect(editor(page)).toHaveCount(0);
  await action(page, 'new-bill').click();
  await expect(editor(page).locator('[name="details.ourReference"]')).toHaveValue('');
  expect(await documents(page)).toHaveLength(1);
  // Leave the untouched new editor before returning to the document inbox.
  await page.goto(`${demo}#purchases/inbox`);
  await expect(page.locator('#suite-main')).toContainText(png.name);
});

test('fördröjd koppling från inkorgen får inte hamna på ett nytt utkast efter navigering', async ({ page }) => {
  await open(page, 'purchases/inbox');
  await upload(page).setInputFiles(png);
  await expect.poll(async () => (await documents(page)).length).toBe(1);
  const file = (await documents(page))[0];
  await action(page, 'purchase-back').click();
  await action(page, 'new-bill').click();
  await fillBill(page, 'UTKAST-A');
  await action(page, 'open-document-picker').click();
  await expect(page.locator('#suite-dialog')).toBeVisible();
  await deferDocumentVerification(page);
  await page.locator(`#suite-dialog [data-action="attach-document"][data-id="${file.id}"]`).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { purchaseRaceStarted?: boolean }).purchaseRaceStarted)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-nav="overview"]').click();
  await expect(page).toHaveURL(/#overview$/);
  await page.locator('[data-nav="purchases"]').click();
  await action(page, 'new-bill').click();
  await expect(page).toHaveURL(/#purchases\/new$/);
  await fillBill(page, 'UTKAST-B');
  await page.evaluate(() => (window as typeof window & { releasePurchaseRace?: () => void }).releasePurchaseRace?.());
  await expect.poll(() => page.evaluate(() => (window as typeof window & { purchaseRaceFinished?: boolean }).purchaseRaceFinished)).toBe(true);
  await expect(editor(page).locator('[name="number"]')).toHaveValue('UTKAST-B');
  expect(await editor(page).getAttribute('data-attachments')).toBe('[]');
  await expect(action(page, 'select-document')).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#suite-main a[data-action="purchase-back"]').click();
  await action(page, 'purchase-inbox').click();
  await expect(page.locator('#suite-main')).toContainText(png.name);
  await expect(page.locator(`[data-action="create-bill-from-document"][data-id="${file.id}"]`)).toBeVisible();
});

test('fördröjd koppling får inte återföra ändringar på en nollställd demobok', async ({ page }) => {
  await open(page, 'purchases/inbox');
  await upload(page).setInputFiles(png);
  await expect.poll(async () => (await documents(page)).length).toBe(1);
  const file = (await documents(page))[0];
  const targetId = await page.evaluate(async () => {
    const path = '/bokforing/suite/seed.js';
    const state = (await import(path)).createSuiteState();
    return state.bills.find((bill: { status: string }) => bill.status === 'booked').id as string;
  });
  await page.locator(`[data-action="link-document-existing"][data-id="${file.id}"]`).click();
  await page.locator('#suite-dialog [name="billId"]').selectOption(targetId);
  await deferDocumentVerification(page);
  await page.locator('#suite-dialog button[type="submit"]').click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { purchaseRaceStarted?: boolean }).purchaseRaceStarted)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
  await page.locator('#suite-sidebar [data-action="reset"]').click();
  await page.locator('#suite-dialog [name="confirmed"]').check();
  await page.locator('#suite-dialog button[type="submit"]').click();
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
  await expect(page).toHaveURL(/#purchases$/);
  const resetState = await savedState(page);
  await page.evaluate(() => (window as typeof window & { releasePurchaseRace?: () => void }).releasePurchaseRace?.());
  await expect.poll(() => page.evaluate(() => (window as typeof window & { purchaseRaceFinished?: boolean }).purchaseRaceFinished)).toBe(true);
  await expect(page).toHaveURL(/#purchases$/);
  const after = await savedState(page);
  expect(after).toEqual(resetState);
  expect(after.bills.find((bill: { id: string }) => bill.id === targetId).additionalAttachments ?? []).toHaveLength(0);
  expect(after.entries).toEqual(resetState.entries);
  expect(await documents(page)).toHaveLength(1);
});
