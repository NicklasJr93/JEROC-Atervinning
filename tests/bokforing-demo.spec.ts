import { expect, test, type Page } from '@playwright/test';

// These checks use only the public, synthetic browser-local page. They need
// neither an authenticated account nor any business API or production data.
const storageKey = 'scrapplanner-bokforing-demo-v1';
const demoPath = '/bokforing/index.html';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(30_000);

async function openDraft(page: Page, id = 'doc-office') {
  await page.bringToFront();
  await page.goto(`${demoPath}#documents/${id}`);
  // Hash navigation retains unsaved edits. Reload isolates each scenario from
  // its preceding in-memory draft while preserving the actual storage data.
  await page.reload();
  await expect(page.locator('#book-document')).toBeVisible();
}

function row(page: Page, index: number, field: string) {
  return page.locator(`[data-row="${index}"][data-field="${field}"]`);
}

async function rawState(page: Page) {
  return page.evaluate(key => localStorage.getItem(key), storageKey);
}

async function savedState(page: Page) {
  const raw = await rawState(page);
  expect(raw).not.toBeNull();
  return JSON.parse(raw!);
}

async function expectBooked(page: Page) {
  await expect(page.locator('.entry-editor h2')).toHaveText('Bokförd kontering');
}

test('inköpseditorn erbjuder bara konton och moms som stöds av underlagets kategori', async ({ page }) => {
  const options = async () => row(page, 0, 'account').locator('option').evaluateAll(nodes =>
    nodes.map(node => (node as HTMLOptionElement).value));

  await openDraft(page);
  const standard = await options();
  expect(standard).toEqual(expect.arrayContaining(['4010', '6110', '2440', '2641']));
  for (const account of ['1510', '1930', '2091', '3010', '2611', '2614', '2647', '4415']) {
    expect(standard).not.toContain(account);
  }

  await openDraft(page, 'doc-reverse');
  expect((await options()).sort()).toEqual(['2440', '2614', '2647', '4415']);

  await openDraft(page, 'doc-private');
  const privatePurchase = await options();
  expect(privatePurchase).toEqual(expect.arrayContaining(['4010', '2440']));
  expect(privatePurchase.some(account => /^26/.test(account))).toBe(false);
});

test('balanserade inköpsrader med fel fakturatotal eller moms nekas utan att sparas', async ({ page }) => {
  await openDraft(page);
  await row(page, 0, 'debitCents').fill('1010');
  await row(page, 2, 'creditCents').fill('1260');
  await expect(page.locator('#book-document')).toBeEnabled();
  await page.locator('#book-document').click();
  await expect(page.locator('#draft-error')).toContainText('totalbelopp');
  expect(await rawState(page)).toBeNull();

  await openDraft(page);
  await row(page, 0, 'debitCents').fill('1100');
  await row(page, 1, 'debitCents').fill('150');
  await expect(page.locator('#book-document')).toBeEnabled();
  await page.locator('#book-document').click();
  await expect(page.locator('#draft-error')).toContainText('moms');
  expect(await rawState(page)).toBeNull();
});

test('bokföring bekräftas först efter sparande och dubbelklick ger en beständig verifikation', async ({ page }) => {
  await openDraft(page);
  await page.locator('#book-document').dblclick({ noWaitAfter: true });
  await expectBooked(page);
  let saved = await savedState(page);
  expect(saved.entries).toHaveLength(13);
  expect(saved.entries.filter((entry: { documentId?: string }) => entry.documentId === 'doc-office')).toHaveLength(1);

  await page.reload();
  await expectBooked(page);
  await expect(page.locator('#book-document')).toHaveCount(0);
  saved = await savedState(page);
  expect(saved.documents.find((document: { id: string }) => document.id === 'doc-office').status).toBe('booked');
  expect(saved.entries).toHaveLength(13);
});

test('en gammal flik spärras och kan läsa in senaste före en andra bokning utan dataförlust', async ({ page, context }) => {
  await openDraft(page);
  const second = await context.newPage();
  await openDraft(second, 'doc-equipment');

  await page.bringToFront();
  await page.locator('#book-document').click();
  await expectBooked(page);

  await second.bringToFront();
  await expect(second.locator('#storage-notice')).toBeVisible();
  await expect(second.locator('#storage-notice')).toContainText('annan flik');
  await expect(second.locator('#book-document')).toBeDisabled();
  expect((await savedState(second)).entries).toHaveLength(13);

  await second.locator('[data-action="reload-demo"]').click();
  await expect(second.locator('#storage-notice')).toBeHidden();
  await expect(second.locator('#book-document')).toBeEnabled();
  await second.locator('#book-document').click();
  await expectBooked(second);
  const saved = await savedState(second);
  expect(saved.entries).toHaveLength(14);
  for (const id of ['doc-office', 'doc-equipment']) {
    expect(saved.documents.find((document: { id: string }) => document.id === id).status).toBe('booked');
    expect(saved.entries.filter((entry: { documentId?: string }) => entry.documentId === id)).toHaveLength(1);
  }
  await second.close();
});

test('simulerad full browserlagring ger fel och ingen bokförd vy eller lyckad kvittens', async ({ page }) => {
  await page.addInitScript(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Simulated storage quota', 'QuotaExceededError');
      original.call(this, name, value);
    };
  }, storageKey);
  await openDraft(page);
  await page.locator('#book-document').click();
  await expect(page.locator('#storage-notice')).toContainText('kunde inte sparas');
  await expect(page.locator('.entry-editor h2')).toHaveText('Granska kontering');
  await expect(page.locator('#book-document')).toBeDisabled();
  await expect(page.locator('#toast')).not.toContainText('är bokförd och sparad');
  expect(await rawState(page)).toBeNull();

  await page.reload();
  await expect(page.locator('.entry-editor h2')).toHaveText('Granska kontering');
  await expect(page.locator('#book-document')).toBeEnabled();
});

test('osäker återläsningskvittens spärrar nytt försök och reload hittar exakt den sparade bokningen', async ({ page }) => {
  await page.addInitScript(key => {
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    let rejectNextRead = false;
    Storage.prototype.setItem = function (name, value) {
      originalSet.call(this, name, value);
      if (name === key) rejectNextRead = true;
    };
    Storage.prototype.getItem = function (name) {
      if (name === key && rejectNextRead) {
        rejectNextRead = false;
        throw new DOMException('Simulated readback failure', 'SecurityError');
      }
      return originalGet.call(this, name);
    };
  }, storageKey);
  await openDraft(page);
  await page.locator('#book-document').click();
  await expect(page.locator('#storage-notice')).toContainText('kan redan vara sparad');
  await expect(page.locator('.entry-editor h2')).toHaveText('Granska kontering');
  await expect(page.locator('#book-document')).toBeDisabled();
  await expect(page.locator('#toast')).not.toContainText('är bokförd och sparad');

  await page.reload();
  await expectBooked(page);
  expect((await savedState(page)).entries).toHaveLength(13);
});

test('reset med sparfel bevarar demoboken och lyckad reset kräver en ny bekräftelse', async ({ page }) => {
  await page.addInitScript(key => {
    const original = Storage.prototype.setItem;
    const browser = window as typeof window & { failNextDemoWrite?: boolean };
    browser.failNextDemoWrite = false;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && browser.failNextDemoWrite) {
        browser.failNextDemoWrite = false;
        throw new DOMException('Simulated reset quota failure', 'QuotaExceededError');
      }
      original.call(this, name, value);
    };
  }, storageKey);
  await openDraft(page);
  await page.locator('#book-document').click();
  await expectBooked(page);
  const before = await rawState(page);
  await page.evaluate(() => { (window as typeof window & { failNextDemoWrite: boolean }).failNextDemoWrite = true; });
  await page.locator('[data-action="reset"]').click();
  await page.locator('[data-action="confirm-reset"]').click({ noWaitAfter: true });
  await expect(page.locator('#reset-dialog')).toBeVisible();
  await expect(page.locator('#reset-error')).toContainText('kunde inte sparas');
  expect(await rawState(page)).toBe(before);

  await page.reload();
  await expectBooked(page);
  await page.locator('[data-action="reset"]').click();
  await page.locator('[data-action="confirm-reset"]').click({ noWaitAfter: true });
  await expect(page.locator('#reset-dialog')).toBeHidden();
  const reset = await savedState(page);
  expect(reset.entries).toHaveLength(12);
  expect(reset.documents.filter((document: { status: string }) => document.status === 'draft')).toHaveLength(8);
  expect(await rawState(page)).not.toBe(before);
});

test('äldre ogiltiga demodata bevaras i läsläge tills användaren uttryckligen återställer', async ({ page }) => {
  await openDraft(page);
  await page.locator('#book-document').click();
  await expectBooked(page);
  const invalid = await page.evaluate(key => {
    const saved = JSON.parse(localStorage.getItem(key)!);
    delete saved._demoStorageRevision;
    saved.documents.find((document: { id: string }) => document.id === 'doc-office').rows[0].account = '1930';
    saved.entries.find((entry: { documentId?: string }) => entry.documentId === 'doc-office').rows[0].account = '1930';
    const raw = JSON.stringify(saved);
    localStorage.setItem(key, raw);
    return raw;
  }, storageKey);
  await page.reload();
  await expect(page.locator('#storage-notice')).toContainText('bevarats');
  await expect(page.locator('#book-document')).toBeDisabled();
  expect(await rawState(page)).toBe(invalid);

  await page.locator('[data-action="reset"]').click();
  await page.locator('[data-action="confirm-reset"]').click({ noWaitAfter: true });
  await expect(page.locator('#reset-dialog')).toBeHidden();
  await expect(page.locator('#storage-notice')).toBeHidden();
  const reset = await savedState(page);
  expect(reset.entries).toHaveLength(12);
  expect(reset.documents.find((document: { id: string }) => document.id === 'doc-office').status).toBe('draft');
});

for (const viewport of [
  { label: 'dator', width: 1440, height: 1000 },
  { label: 'mobil', width: 390, height: 844 },
]) {
  test(`Ande skymmer inte pekarklick på femradig kontering på ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openDraft(page);
    await row(page, 0, 'debitCents').fill('800');
    for (const index of [3, 4]) {
      await page.locator('[data-action="add-row"]').click();
      await row(page, index, 'debitCents').fill('100');
    }
    const button = page.locator('#book-document');
    await expect(button).toBeEnabled();
    await button.scrollIntoViewIfNeeded();
    expect(await button.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('#book-document') === element;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await button.click();
    await expectBooked(page);
    expect((await savedState(page)).documents.find((document: { id: string }) => document.id === 'doc-office').rows).toHaveLength(5);
  });
}
