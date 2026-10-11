import { expect, test, type Page, type Route } from '@playwright/test';
import type { AccountingSettings, AccountingDraftRow } from '../src/office/accounting-types';
import type { SpirisAccountingState, SpirisChoices, SpirisExample, SpirisExport } from '../src/office/spiris-accounting-client';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

const endpoint = '/api/environment/visma/accounting';
const ids = {
  immediate: '7a2c9bd0-0bde-42a1-b3b9-a7e8248b7f1a', thirty: '7a2c9bd0-0bde-42a1-b3b9-a7e8248b7f1b',
  fiscalYear: '6b93d240-7c55-4e22-9e09-93dc35e2fe84', reverse: '1b93d240-7c55-4e22-9e09-93dc35e2fe84',
  vat: '2b93d240-7c55-4e22-9e09-93dc35e2fe84', centerGroup: '3b93d240-7c55-4e22-9e09-93dc35e2fe84',
  norrtalje: '4b93d240-7c55-4e22-9e09-93dc35e2fe84', rimbo: '5b93d240-7c55-4e22-9e09-93dc35e2fe84',
  project: '8b93d240-7c55-4e22-9e09-93dc35e2fe84', supplierRun: '9b93d240-7c55-4e22-9e09-93dc35e2fe84',
  draftRun: 'cb93d240-7c55-4e22-9e09-93dc35e2fe84',
  supplier: 'ab93d240-7c55-4e22-9e09-93dc35e2fe84', draft: 'bb93d240-7c55-4e22-9e09-93dc35e2fe84',
};

const choices: SpirisChoices = {
  companyId: 'local-settings-company', fetchedAt: '2026-10-11T10:00:00Z',
  fiscalYears: [{ id: ids.fiscalYear, startDate: '2026-01-01', endDate: '2026-12-31', locked: false }],
  accounts: [
    [4000, 'Lokalt privatinköp'], [4010, 'Lokalt anläggningskonto'], [4415, 'Lokalt skrotinköp'],
    [2440, 'Lokal leverantörsskuld'], [2647, 'Lokal ingående omvänd moms'], [2614, 'Lokal utgående omvänd moms'],
    [2641, 'Lokal ingående moms'],
  ].map(([number, name]) => ({ number: Number(number), name: String(name), fiscalYearId: ids.fiscalYear, active: true })),
  vatCodes: [{ id: ids.reverse, code: 'REVERSE', name: 'Lokal omvänd moms 25 %', rate: 25 }, { id: ids.vat, code: 'VAT25', name: 'Lokal vanlig moms 25 %', rate: 25 }],
  paymentTerms: [{ id: ids.immediate, name: 'Omgående från testföretaget', days: 0, availableForPurchase: true }, { id: ids.thirty, name: '30 dagar netto', days: 30, availableForPurchase: true }],
  costCenters: [{ id: ids.centerGroup, name: 'Anläggningar', number: 1, active: true, items: [
    { id: ids.norrtalje, name: 'Norrtälje från testföretaget', shortName: '01', active: true },
    { id: ids.rimbo, name: 'Rimbo från testföretaget', shortName: '02', active: true },
  ] }],
  projects: [{ id: ids.project, name: 'Lokalt projekt', number: 'P01', status: 'active' }],
};

function initialState(withChoices = false): SpirisAccountingState {
  return { settings: { revision: 0, enabled: false, exportMode: 'manual', companyId: choices.companyId, sandbox: true,
    paymentTermDays: 0, accounts: {}, vatCodes: {}, sites: [] },
  company: { id: choices.companyId, name: 'Lokalt fixtureföretag AB', number: '5560000167' }, companyVerified: true,
  sites: [{ id: 'norrtalje', name: 'Norrtälje' }, { id: 'rimbo', name: 'Rimbo' }], choices: withChoices ? structuredClone(choices) : null,
  capabilities: { canConfigure: true, canExport: true, automationEnabled: false }, issues: [] };
}

function configuredState(): SpirisAccountingState {
  const result = initialState(true);
  Object.assign(result.settings, { revision: 1, sites: [{ siteId: 'norrtalje', useDefaults: true, costCenterId: ids.norrtalje }, { siteId: 'rimbo', useDefaults: true, costCenterId: ids.rimbo }], enabled: true, paymentTermsId: ids.immediate,
    accounts: { privatePurchase: 4000, reversePurchase: 4415, standardPurchase: 4000, noVatPurchase: 4000, supplierLiability: 2440, inputReverseVat: 2647, outputReverseVat: 2614, inputVat: 2641 },
    vatCodes: { reverse25: ids.reverse, standard25: ids.vat } });
  return result;
}

async function fixture(page: Page, options: { configured?: boolean; conflict?: boolean; delayed?: Promise<void>; remoteOnChoices?: boolean; mandatoryCenter?: boolean; sendGate?: Promise<void> } = {}) {
  let current = options.configured ? configuredState() : initialState();
  if (options.mandatoryCenter && current.choices) { current.choices.accounts.find(account => account.number === 4000)!.firstCostCenterMandatory = true; delete current.settings.sites[0].costCenterId; }
  const saves: { expectedRevision: number; settings: AccountingSettings }[] = [];
  const previews: { settings: AccountingSettings; siteId: string; example: SpirisExample }[] = [];
  const requests: string[] = [], external: string[] = [], sends: { cardId: number; source: SpirisExport['source'] }[] = [];
  const exportEntry: SpirisExport = { id: 'local-export-journal', source: { cardId: 3016, approvalId: ids.fiscalYear, version: 2, hash: 'a'.repeat(64) }, companyId: current.settings.companyId,
    customerId: 'local-customer', status: 'accepted', stage: 'draft', createdAt: '2026-10-11T10:00:00Z', updatedAt: '2026-10-11T10:00:01Z',
    supplierId: ids.supplier, draftId: ids.draft, error: undefined, runs: { supplierRequestId: ids.supplierRun }, settingsRevision: 1, trigger: 'manual' };
  if (options.sendGate) exportEntry.runs.draftRequestId = ids.draftRun;
  const safeFulfill = async (route: Route, response: Parameters<Route['fulfill']>[0]) => { await route.fulfill(response).catch(() => undefined); };
  await page.route(/^https?:\/\//, route => {
    const host = new URL(route.request().url()).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { external.push(host); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  await page.route('**/api/environment/integrations/catalog**', route => route.fulfill({ json: { version: 1, organisationId: 'jeroc-demo', capabilities: { canManage: true }, providers: [{
    id: 'visma', name: 'Spiris / Visma eEkonomi', description: 'Lokal testfixtur', category: 'accounting', status: 'connected', mode: 'test', implemented: true, configured: true, connected: true,
    requiredSetup: [], capabilities: { canView: true, canConfigure: true, canCheck: false, canConnect: false }, links: { settings: '/integrations/visma-test' },
  }] } }));
  await page.route(`**${endpoint}/**`, async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method(); requests.push(`${method} ${path}`);
    if (path.endsWith('/settings') && method === 'GET') {
      if (options.delayed) await options.delayed;
      return safeFulfill(route, { json: current });
    }
    if (path.endsWith('/choices') && method === 'POST') {
      current = { ...current, choices: structuredClone(choices), suggestedPaymentTermsId: ids.immediate };
      if (options.remoteOnChoices) current.settings = { ...current.settings, revision: 2, enabled: false, paymentTermDays: 30, paymentTermsId: ids.thirty };
      return route.fulfill({ json: current });
    }
    if (path.endsWith('/settings') && method === 'POST') {
      const request = route.request().postDataJSON() as { expectedRevision: number; settings: AccountingSettings }; saves.push(structuredClone(request));
      expect(route.request().headers()['x-environment-csrf']).toBeTruthy();
      expect(route.request().headers()['x-environment-actual-user']).toBe('admin');
      expect(route.request().headers()['x-environment-effective-user']).toBe('admin');
      if (options.conflict && saves.length === 1) {
        current = { ...current, settings: { ...current.settings, revision: 2, paymentTermDays: 30, paymentTermsId: ids.thirty } };
        return route.fulfill({ status: 409, json: { code: 'accounting_settings_conflict', message: 'Inställningarna ändrades i en annan flik.' } });
      }
      current = { ...current, settings: { ...request.settings, revision: current.settings.revision + 1 } };
      return route.fulfill({ json: current });
    }
    if (path.endsWith('/preview') && method === 'POST') {
      const cardInput = route.request().postDataJSON() as { cardId?: number };
      if (cardInput.cardId) return route.fulfill({ json: { source: exportEntry.source, eligible: true, issues: [],
        supplier: { Name: 'Lokal kund AB', TermsOfPaymentId: ids.immediate, CurrencyCode: 'SEK' },
        draft: { IsCreditInvoice: false, InvoiceNumber: 'AV-3016-V2', InvoiceDate: '2026-10-11', DueDate: '2026-10-11', TotalAmount: 1000, Vat: 0, CurrencyCode: 'SEK', IsDomestic: true, SkipSendToBank: true, Message: 'AV-3016-V2',
          Rows: [{ AccountNumber: 4415, DebitAmount: 1000, CreditAmount: 0, LineNumber: 1, TransactionText: 'Lokalt material' },
            { AccountNumber: 2647, DebitAmount: 250, CreditAmount: 0, LineNumber: 2, TransactionText: 'Ingående omvänd moms' },
            { AccountNumber: 2614, DebitAmount: 0, CreditAmount: 250, LineNumber: 3, TransactionText: 'Utgående omvänd moms' },
            { AccountNumber: 2440, DebitAmount: 0, CreditAmount: 1000, LineNumber: 4, TransactionText: 'Leverantörsskuld' }] } } });
      const request = route.request().postDataJSON() as { settings: AccountingSettings; siteId: string; example: SpirisExample }; previews.push(structuredClone(request));
      const issues: { code: string; message: string }[] = [];
      if (!request.settings.accounts.supplierLiability) issues.push({ code: 'accounting_account_missing', message: 'Leverantörsskuld behöver väljas.' });
      if (request.example === 'non_vat_business' && request.settings.nonVatBusinessRule !== 'no_vat') issues.push({ code: 'accounting_non_vat_rule_missing', message: 'Företag utan momsregistrering kräver en fastställd regel.' });
      const config = request.settings.sites.find(site => site.siteId === request.siteId);
      const accounts = { ...request.settings.accounts, ...(config?.useDefaults ? {} : config?.accountOverrides) };
      const rows: AccountingDraftRow[] = issues.length ? [] : request.example === 'reverse_scrap' ? [
        { AccountNumber: accounts.reversePurchase!, DebitAmount: 1000, CreditAmount: 0, LineNumber: 1, TransactionText: 'Lokalt skrotexempel' },
        { AccountNumber: accounts.inputReverseVat!, DebitAmount: 250, CreditAmount: 0, LineNumber: 2, TransactionText: 'Ingående omvänd moms' },
        { AccountNumber: accounts.outputReverseVat!, DebitAmount: 0, CreditAmount: 250, LineNumber: 3, TransactionText: 'Utgående omvänd moms' },
        { AccountNumber: accounts.supplierLiability!, DebitAmount: 0, CreditAmount: 1000, LineNumber: 4, TransactionText: 'Leverantörsskuld' },
      ] : [
        { AccountNumber: request.example === 'private' ? accounts.privatePurchase! : accounts.noVatPurchase!, DebitAmount: 1000, CreditAmount: 0, LineNumber: 1, TransactionText: 'Lokalt privatinköp' },
        { AccountNumber: accounts.supplierLiability!, DebitAmount: 0, CreditAmount: 1000, LineNumber: 2, TransactionText: 'Leverantörsskuld' },
      ];
      if (config?.costCenterId) rows.filter(row => row.DebitAmount > 0).forEach(row => { row.CostCenterItemId1 = config.costCenterId; });
      return route.fulfill({ json: { accounting: issues.length ? undefined : { baseTotal: 1000, net: 1000, invoiceTotal: 1000 }, draft: issues.length ? undefined : { Rows: rows, DueDate: '2026-10-11', TotalAmount: 1000 }, rows, issues } });
    }
    if (path.endsWith('/exports') && method === 'GET') return route.fulfill({ json: { exports: options.sendGate && sends.length === 0 ? [] : [exportEntry] } });
    if (path.endsWith('/exports') && method === 'POST') {
      sends.push(structuredClone(route.request().postDataJSON()));
      if (options.sendGate) await options.sendGate;
      return route.fulfill({ json: exportEntry });
    }
    return route.fulfill({ status: 405, json: { message: 'Oväntad operation i lokal testfixtur.' } });
  });
  await page.route(`**/api/environment/visma/sandbox/runs/${ids.supplierRun}`, route => route.fulfill({ json: {
    id: ids.supplierRun, status: 'accepted', operation: 'createSupplier', method: 'POST', path: '/suppliers', startedAt: exportEntry.createdAt,
    finishedAt: exportEntry.updatedAt, httpStatus: 201, payload: { Name: 'Lokalt testföretag' }, response: { Id: ids.supplier, Name: 'Lokalt svar AB' }, trackingId: 'local-api-tracking', resourceId: ids.supplier,
  } }));
  await page.route(`**/api/environment/visma/sandbox/runs/${ids.draftRun}`, route => route.fulfill({ json: {
    id: ids.draftRun, status: 'accepted', operation: 'createDraft', method: 'POST', path: '/supplierinvoicedrafts', startedAt: exportEntry.createdAt,
    finishedAt: exportEntry.updatedAt, httpStatus: 201, payload: { SupplierId: ids.supplier, InvoiceNumber: 'AV-3016-V2' },
    response: { Id: ids.draft, InvoiceNumber: 'AV-3016-V2' }, trackingId: 'local-draft-tracking', resourceId: ids.draft,
  } }));
  await page.route('**/api/environment/visma/attested-cards', route => route.fulfill({ json: { cards: [{ ...exportEntry.source,
    customerName: 'Lokal kund AB', customerType: 'Företag', siteName: 'Norrtälje', attestedAt: exportEntry.createdAt, attestedBy: 'Systemadmin', gross: 1000, offset: 0, net: 1000 }] } }));
  return { saves, previews, requests, external, sends };
}

async function open(page: Page) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.goto('/kontor#/integrations?service=visma');
  return page.getByRole('region', { name: 'Spiris integrationskort', exact: true });
}

test('verkliga Spiris-val styr standardvillkor och anläggningskonton utan påhittade standardkonton', async ({ page }) => {
  const local = await fixture(page), panel = await open(page);
  await expect(panel.getByLabel('Betalvillkor', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('Inköpskonto privatinköp', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('Överföring', { exact: true })).toHaveValue('manual');
  await expect(panel.getByLabel('Aktivera överföring av fakturautkast till sandbox', { exact: true })).not.toBeChecked();
  await panel.getByRole('button', { name: 'Hämta från Spiris', exact: true }).click();
  await expect(panel.getByLabel('Betalvillkor', { exact: true })).toHaveValue(ids.immediate);
  await expect(panel.getByLabel('Inköpskonto privatinköp', { exact: true })).toHaveValue('');
  await panel.getByLabel('Inköpskonto privatinköp', { exact: true }).selectOption('4000');
  await panel.getByLabel('Inköpskonto omvänd moms', { exact: true }).selectOption('4415');
  await panel.getByLabel('Leverantörsskuld', { exact: true }).selectOption('2440');
  await panel.getByLabel('Ingående omvänd moms', { exact: true }).selectOption('2647');
  await panel.getByLabel('Utgående omvänd moms', { exact: true }).selectOption('2614');
  await panel.getByLabel('Kostnadsställe Norrtälje', { exact: true }).selectOption(ids.norrtalje);
  await panel.getByLabel('Kostnadsställe Rimbo', { exact: true }).selectOption(ids.rimbo);
  await panel.getByLabel('Projekt Rimbo', { exact: true }).selectOption(ids.project);
  await panel.locator('.spiris-location-row').filter({ has: page.locator('.spiris-location-name', { hasText: 'Rimbo' }) }).getByRole('button', { name: 'Gemensamma' }).click();
  const override = panel.locator('.spiris-site-override');
  await override.getByLabel('Använd gemensamma konton', { exact: true }).uncheck();
  await override.getByLabel('Inköpskonto privatinköp Rimbo', { exact: true }).selectOption('4010');
  await panel.getByRole('button', { name: 'Spara inställningar', exact: true }).click();
  await expect.poll(() => local.saves.length).toBe(1);
  expect(local.saves[0]).toMatchObject({ expectedRevision: 0, settings: { paymentTermsId: ids.immediate, paymentTermDays: 0, exportMode: 'manual', enabled: false, sites: expect.arrayContaining([
    expect.objectContaining({ siteId: 'norrtalje', useDefaults: true, costCenterId: ids.norrtalje }),
    expect.objectContaining({ siteId: 'rimbo', useDefaults: false, costCenterId: ids.rimbo, projectId: ids.project, accountOverrides: { privatePurchase: 4010 } }),
  ]) } });
  expect(local.external).toEqual([]);
  await expect(panel.locator('input:not([type="checkbox"])')).toHaveCount(0);
});

test('förhandsvisning visar balanserad omvänd moms och kräver uttrycklig rutin för momsbefriat företag', async ({ page }) => {
  const local = await fixture(page, { configured: true }), panel = await open(page);
  await expect(panel.getByText('Konteringen balanserar', { exact: true })).toBeVisible();
  await expect(panel.locator('.spiris-journal tbody tr')).toHaveCount(4);
  await expect(panel.locator('.spiris-journal')).toContainText('2647');
  await expect(panel.locator('.spiris-journal')).toContainText('2614');
  await page.screenshot({ path: test.info().outputPath('spiris-settings-1440.png'), fullPage: true });
  await panel.getByLabel('Exempelinköp', { exact: true }).selectOption('private');
  await expect(panel.locator('.spiris-journal tbody tr')).toHaveCount(2);
  await expect(panel.locator('.spiris-journal')).toContainText('4000');
  await panel.getByLabel('Exempelinköp', { exact: true }).selectOption('non_vat_business');
  await expect(panel.getByText('Företag utan momsregistrering kräver en fastställd regel.', { exact: true })).toBeVisible();
  await expect(panel.getByText('Konteringen balanserar', { exact: true })).toHaveCount(0);
  await panel.locator('.spiris-other-rules summary').click();
  await panel.getByLabel('Företag som inte är momsregistrerat', { exact: true }).selectOption('no_vat');
  await expect(panel.getByText('Konteringen balanserar', { exact: true })).toBeVisible();
  expect(local.saves).toEqual([]); expect(local.external).toEqual([]);
  await panel.locator('.spiris-other-rules summary').click();
  await panel.getByLabel('Exempelinköp', { exact: true }).selectOption('reverse_scrap');
  await expect(panel.locator('.spiris-journal tbody tr')).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('spiris-settings-390.png'), fullPage: true });
});

test('versionskonflikt bevarar ändringar och nästa sparande använder den aktuella versionen', async ({ page }) => {
  const local = await fixture(page, { configured: true, conflict: true }), panel = await open(page);
  await panel.getByLabel('Inköpskonto privatinköp', { exact: true }).selectOption('4010');
  await panel.getByRole('button', { name: 'Spara inställningar', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Dina ändringar finns kvar');
  await expect(panel.getByLabel('Inköpskonto privatinköp', { exact: true })).toHaveValue('4010');
  await expect(panel.getByLabel('Betalvillkor', { exact: true })).toHaveValue(ids.immediate);
  await expect(panel.getByRole('button', { name: 'Spara inställningar', exact: true })).toBeDisabled();
  await expect(panel.getByRole('region', { name: 'Granska ändrade Spiris-inställningar', exact: true })).toContainText('30 dagar netto');
  await panel.getByRole('button', { name: 'Behåll mina ändringar och uppdatera version', exact: true }).click();
  await expect(panel.getByLabel('Betalvillkor', { exact: true })).toHaveValue(ids.thirty);
  await panel.getByRole('button', { name: 'Spara inställningar', exact: true }).click();
  await expect.poll(() => local.saves.length).toBe(2);
  expect(local.saves[1]).toMatchObject({ expectedRevision: 2, settings: { revision: 2, accounts: { privatePurchase: 4010 }, paymentTermsId: ids.thirty, paymentTermDays: 30 } });
});

test('hämtade val skriver inte över andra administratörers ändringar i orörda fält', async ({ page }) => {
  const local = await fixture(page, { configured: true, remoteOnChoices: true }), panel = await open(page);
  await panel.getByLabel('Inköpskonto privatinköp', { exact: true }).selectOption('4010');
  await panel.getByRole('button', { name: 'Hämta från Spiris', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Granska ändrade Spiris-inställningar', exact: true })).toContainText('Senast sparad version 2');
  await expect(panel.getByRole('button', { name: 'Spara inställningar', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Behåll mina ändringar och uppdatera version', exact: true }).click();
  await expect(panel.getByLabel('Betalvillkor', { exact: true })).toHaveValue(ids.thirty);
  await expect(panel.getByLabel('Aktivera överföring av fakturautkast till sandbox', { exact: true })).not.toBeChecked();
  await panel.getByRole('button', { name: 'Spara inställningar', exact: true }).click();
  await expect.poll(() => local.saves.length).toBe(1);
  expect(local.saves[0]).toMatchObject({ expectedRevision: 2, settings: { enabled: false, accounts: { privatePurchase: 4010 }, paymentTermDays: 30, paymentTermsId: ids.thirty } });
});

test('ett konto som kräver kostnadsställe ger ingen grön förhandsvisning innan fördelningen finns', async ({ page }) => {
  await fixture(page, { configured: true, mandatoryCenter: true }); const panel = await open(page);
  await panel.getByLabel('Exempelinköp', { exact: true }).selectOption('private');
  await expect(panel.getByText('Konto 4000 kräver kostnadsställe.', { exact: true })).toBeVisible();
  await expect(panel.getByText('Konteringen balanserar', { exact: true })).toHaveCount(0);
  await panel.getByLabel('Kostnadsställe Norrtälje', { exact: true }).selectOption(ids.norrtalje);
  await expect(panel.getByText('Konteringen balanserar', { exact: true })).toBeVisible();
});

test('överföringar visar sparade ID och läsbara API-svar i journalen', async ({ page }) => {
  await fixture(page, { configured: true }); const panel = await open(page);
  await panel.getByRole('button', { name: 'Överföringar', exact: true }).click();
  const history = panel.getByRole('region', { name: 'Spiris överföringshistorik', exact: true });
  await expect(history).toContainText('Viktkort #3016');
  await expect(history).toContainText(ids.draft);
  await expect(history).toContainText(ids.supplier);
  await history.getByText('Leverantör · anrop och svar', { exact: true }).click();
  await history.getByRole('button', { name: 'Visa API-svar', exact: true }).click();
  await expect(history.getByRole('region', { name: 'Spiris svarjournal', exact: true })).toContainText('HTTP 201');
  await expect(history.getByRole('region', { name: 'Spiris svarjournal', exact: true })).toContainText('Lokalt svar AB');
  await expect(history).toContainText('local-api-tracking');
});

test('manuell överföring kräver förhandsvisning och ett explicit klick med aktuell attestversion', async ({ page }) => {
  let release!: () => void;
  const sendGate = new Promise<void>(resolve => { release = resolve; });
  const local = await fixture(page, { configured: true, sendGate }), panel = await open(page);
  await panel.getByRole('button', { name: 'Överföringar', exact: true }).click();
  const manual = panel.getByRole('region', { name: 'Manuell Spiris-överföring', exact: true });
  await manual.getByLabel('Attesterad avräkning', { exact: true }).selectOption('3016');
  expect(local.sends).toEqual([]);
  await manual.getByRole('button', { name: 'Förhandsvisa avräkning', exact: true }).click();
  await expect(manual).toContainText('AV-3016-V2');
  expect(local.sends).toEqual([]);
  const send = manual.getByRole('button', { name: 'Skapa fakturautkast · SANDBOX', exact: true });
  const sendElement = await send.elementHandle();
  await send.click();
  await expect.poll(() => local.sends.length).toBe(1);
  await sendElement!.evaluate(element => { (element as HTMLButtonElement).click(); });
  expect(local.sends).toEqual([{ cardId: 3016, source: { cardId: 3016, approvalId: ids.fiscalYear, version: 2, hash: 'a'.repeat(64) } }]);
  await expect(page.getByRole('dialog')).toContainText('Serverns svar');
  release();
  await expect(page.getByRole('dialog')).toContainText('HTTP 201');
  await expect(page.getByRole('dialog')).toContainText(ids.draft);
  await page.getByRole('dialog').getByRole('button', { name: 'Klart', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Spiris överföringshistorik', exact: true })).toContainText(ids.draft);
  expect(local.sends).toHaveLength(1); expect(local.external).toEqual([]);
});

test('sent svar från systemadmins inställningar publiceras inte efter Jobba som', async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const local = await fixture(page, { configured: true, delayed }); await open(page);
  await expect.poll(() => local.requests.some(request => request.endsWith('/settings'))).toBe(true);
  await page.getByLabel('Öppna profilmeny', { exact: true }).click();
  await page.getByLabel('Jobba som', { exact: true }).selectOption('lars');
  release();
  await page.goto('/kontor#/integrations?service=visma');
  await expect(page.getByRole('heading', { name: 'Behörighet saknas', exact: true })).toBeVisible();
  await expect(page.getByLabel('Inköpskonto privatinköp', { exact: true })).toHaveCount(0);
  expect(local.saves).toEqual([]); expect(local.previews).toEqual([]); expect(local.external).toEqual([]);
});
