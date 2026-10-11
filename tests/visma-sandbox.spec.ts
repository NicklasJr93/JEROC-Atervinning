import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { VismaSandboxRequest, VismaSandboxRun, VismaSandboxStatus } from '../src/office/visma-sandbox-client';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(45_000);

const testPage = '/kontor/integration/systemadminvismatest.html';
const api = '/api/environment/visma';
const supplierId = '0ab66080-23ee-4d4f-844d-ac32cbf75628';
const draftId = 'fab66080-23ee-4d4f-844d-ac32cbf75628';
const paymentTermsId = '7a2c9bd0-0bde-42a1-b3b9-a7e8248b7f1a';
const fiscalYearId = '6b93d240-7c55-4e22-9e09-93dc35e2fe84';
const accountsRunId = 'cfd3512a-ce89-439d-bca2-2b6e3a67e3a9';

function state(): VismaSandboxStatus {
  return {
    mode: 'sandbox', configured: true, connected: true, companyVerified: true,
    expectedCompanyId: 'local-browser-company', company: { id: 'local-browser-company', name: 'Lokal browserfixtur AB', number: '5560000167' },
    missing: [], scopes: ['ea:api', 'offline_access', 'ea:purchase', 'ea:accounting_readonly', 'ea:sales_readonly'],
    redirectUri: 'http://127.0.0.1:5173/api/integrations/visma/oauth/callback', runs: [],
    operations: [
      { id: 'company', label: 'Företagsinställningar', method: 'GET', path: '/companysettings', write: false },
      { id: 'fiscalYears', label: 'Räkenskapsår', method: 'GET', path: '/fiscalyears', write: false },
      { id: 'accounts', label: 'Kontoplan', method: 'GET', path: '/accounts/{fiscalYearId}', write: false },
      { id: 'paymentTerms', label: 'Betalningsvillkor', method: 'GET', path: '/termsofpayments', write: false },
      { id: 'suppliers', label: 'Leverantörer', method: 'GET', path: '/suppliers', write: false },
      { id: 'supplier', label: 'Hämta leverantör', method: 'GET', path: '/suppliers/{resourceId}', write: false },
      { id: 'draft', label: 'Hämta fakturautkast', method: 'GET', path: '/supplierinvoicedrafts/{resourceId}', write: false },
      { id: 'createSupplier', label: 'Skapa testleverantör', method: 'POST', path: '/suppliers', write: true },
      { id: 'createDraft', label: 'Skapa testfakturautkast', method: 'POST', path: '/supplierinvoicedrafts', write: true },
    ],
    templates: {
      createSupplier: { Name: 'Lokal syntetisk leverantör', TermsOfPaymentId: paymentTermsId, CountryCode: 'SE', CurrencyCode: 'SEK', IsActive: true,
        UsesAutomaticSupplierInvoiceApproval: false, UsesAutomaticInvoicePostToLedger: false },
      createDraft: { SupplierId: '00000000-0000-4000-8000-000000000000', IsCreditInvoice: false, InvoiceDate: '2026-10-11',
        InvoiceNumber: 'LOCAL-SANDBOX', TotalAmount: 100, Vat: 0, CurrencyCode: 'SEK', SkipSendToBank: true,
        Rows: [{ AccountNumber: 4000, DebitAmount: 100, CreditAmount: 0, LineNumber: 1, TransactionText: 'Lokal testkontering' }] },
    },
  };
}

function result(request: VismaSandboxRequest, response: unknown, resourceId?: string): VismaSandboxRun {
  const operation = state().operations.find(item => item.id === request.operation)!;
  const path = operation.path.replace('{fiscalYearId}', request.parameters?.fiscalYearId ?? '').replace('{resourceId}', request.parameters?.resourceId ?? '');
  return { id: request.requestId, status: 'accepted', operation: request.operation, method: operation.method, path,
    ...(request.parameters && { parameters: structuredClone(request.parameters) }), ...(request.payload && { payload: structuredClone(request.payload) }),
    startedAt: '2026-10-11T10:00:00Z', finishedAt: '2026-10-11T10:00:01Z', httpStatus: operation.write ? 201 : 200,
    response, trackingId: `local-browser-${request.operation}`, ...(resourceId && { resourceId }) };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(page: Page, onSend: (request: VismaSandboxRequest) => Promise<VismaSandboxRun>, options?: { loseResponse?: boolean; accounts?: boolean; historyOnly?: boolean }) {
  const current = state(), requests: VismaSandboxRequest[] = [], reads: string[] = [], externalRequests: string[] = [];
  if (options?.accounts) current.runs = [result({ requestId: accountsRunId, idempotencyKey: 'local-account-lookup', operation: 'accounts', parameters: { fiscalYearId } }, {
    Meta: { TotalNumberOfResults: 2, TotalNumberOfPages: 1 }, Data: [
      { Number: '4000', Name: 'Lokalt inköpskonto', IsActive: true }, { Number: '2440', Name: 'Lokal leverantörsskuld', IsActive: true },
    ],
  })];
  // Provider calls are fulfilled locally. Guard all other non-loopback HTTP as
  // well so a test cannot silently navigate to OAuth or use an external API.
  await page.route(/^https?:\/\//, route => {
    const host = new URL(route.request().url()).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { externalRequests.push(host); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  await page.route('**/api/environment/integrations/catalog**', route => route.fulfill({ json: {
    version: 1, organisationId: 'jeroc-demo', capabilities: { canManage: true }, providers: [{
      id: 'visma', name: 'Spiris / Visma eEkonomi', category: 'accounting', description: 'Lokal sandboxfixtur',
      status: 'connected', mode: 'test', implemented: true, configured: true, connected: true, requiredSetup: [],
      capabilities: { canView: true, canConfigure: true, canCheck: false, canConnect: false }, links: { settings: '/integrations/visma-test' },
    }],
  } }));
  await page.route(`**${api}/**`, async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (method === 'GET' && path === `${api}/status`) {
      reads.push(path);
      // Recovery may require the dedicated run endpoint if the status snapshot
      // has not yet included the completed request.
      await route.fulfill({ json: options?.historyOnly ? { ...current, runs: current.runs.filter(run => !requests.some(request => request.requestId === run.id)) } : current });
    } else if (method === 'POST' && path === `${api}/sandbox`) {
      const request = route.request().postDataJSON() as VismaSandboxRequest;
      requests.push(structuredClone(request));
      const run = await onSend(request);
      current.runs = [run, ...current.runs.filter(previous => previous.id !== run.id)];
      if (options?.loseResponse) await route.abort('failed'); else await route.fulfill({ json: run });
    } else if (method === 'GET' && path.startsWith(`${api}/sandbox/runs/`)) {
      reads.push(path);
      const id = decodeURIComponent(path.slice(`${api}/sandbox/runs/`.length)), run = current.runs.find(item => item.id === id);
      await route.fulfill({ status: run ? 200 : 404, json: run ?? { error: 'Lokal historikfixtur saknas.' } });
    } else {
      await route.fulfill({ status: 405, json: { error: 'Endast lokala, mockade Spiris-testanrop är tillåtna.' } });
    }
  });
  return { current, requests, reads, externalRequests };
}

async function login(page: Page, user = 'admin', direct = false) {
  await page.goto(direct ? testPage : '/kontor');
  await page.getByRole('button', { name: user === 'admin' ? /Systemadmin/ : /Lars Andersson/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
}

async function open(page: Page) {
  await page.goto(testPage);
  await expect(page.getByRole('heading', { name: 'Spiris / Visma · systemadminstest', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Välj operation', exact: true })).toBeVisible();
}

async function screenshot(page: Page, info: TestInfo, filename: string) {
  const dialog = page.locator('dialog[open]');
  await dialog.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
  });
  const path = info.outputPath(filename);
  await page.screenshot({ path }); await info.attach(filename, { path, contentType: 'image/png' });
}

test('systemadmin öppnar Spiris från integrationer och Jobba som spärrar testvyn', async ({ page }) => {
  const local = await fixture(page, async request => result(request, {}));
  await login(page);
  await page.goto('/kontor#/integrations?service=visma');
  await page.getByRole('link', { name: 'Öppna Spiris-test', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Spiris / Visma · systemadminstest', exact: true })).toBeVisible();
  await expect.poll(() => local.reads.length).toBeGreaterThan(0);
  const before = local.reads.length;
  await page.getByLabel('Öppna profilmeny', { exact: true }).click();
  await page.getByLabel('Jobba som', { exact: true }).selectOption('lars');
  await page.goto(testPage);
  await expect(page.getByRole('heading', { name: 'Behörighet saknas', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Välj operation', exact: true })).toHaveCount(0);
  expect(local.reads).toHaveLength(before); expect(local.requests).toEqual([]); expect(local.externalRequests).toEqual([]);
});

test('läsanropets animerade popup väntar på svaret och visar faktisk HTTP-status och råsvar', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const delayed = gate();
  const response = { CompanyIdentifier: 'local-browser-company', Name: 'Faktiskt lokalt svar AB', CountryCode: 'SE', CurrencyCode: 'SEK' };
  const local = await fixture(page, async request => { await delayed.promise; return result(request, response); });
  try {
    await login(page); await open(page);
    await page.getByRole('button', { name: 'Läs från Visma · SANDBOX', exact: true }).evaluate(button => {
      (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
    });
    const pending = page.getByRole('dialog', { name: 'Provar anrop till Visma', exact: true });
    await expect(pending).toBeVisible(); await expect(pending.getByRole('status')).toContainText('Serverns svar inväntas');
    expect(await pending.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBeGreaterThan(0);
    await expect(pending.getByRole('region', { name: 'Anrop för detta test', exact: true })).toContainText('Ingen payload · läsanrop.');
    await expect.poll(() => local.requests.length).toBe(1);
    expect(local.requests[0].operation).toBe('company'); expect(local.requests[0].payload).toBeUndefined();
    await expect(page.locator('.visma-sandbox-workspace .nvv-sandbox-submit button')).toBeDisabled();
    await screenshot(page, info, 'visma-company-pending-1440.png');
    delayed.release();
    const completed = page.getByRole('dialog', { name: 'Visma har svarat', exact: true });
    await expect(completed).toBeVisible(); await expect(completed).toContainText('HTTP 200');
    await expect(completed.getByRole('region', { name: 'Visma:s råsvar', exact: true })).toContainText('Faktiskt lokalt svar AB');
    expect(JSON.parse(await completed.getByRole('region', { name: 'Visma:s råsvar', exact: true }).locator('pre').innerText())).toEqual(response);
    await expect(completed).toContainText('local-browser-company'); await expect(completed).toContainText('Spårnings-ID: local-browser-company');
    await screenshot(page, info, 'visma-company-response-1440.png');
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await completed.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await completed.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0);
    await screenshot(page, info, 'visma-company-response-390.png');
    expect(local.requests).toHaveLength(1); expect(local.externalRequests).toEqual([]); expect(errors).toEqual([]);
  } finally { delayed.release(); }
});

test('redigerad leverantör skapas och svarets riktiga leverantörs-ID mappas till redigerbart fakturautkast', async ({ page }) => {
  const local = await fixture(page, async request => request.operation === 'createSupplier'
    ? result(request, { ...request.payload, Id: supplierId, SupplierNumber: 'LOCAL-001' }, supplierId)
    : result(request, { ...request.payload, Id: draftId }, draftId), { accounts: true });
  await login(page); await open(page);
  await page.getByRole('combobox', { name: 'Välj operation', exact: true }).selectOption('createSupplier');
  await page.getByLabel('Namn', { exact: true }).fill('Redigerad lokal leverantör AB');
  await page.getByRole('button', { name: 'Skicka till Visma · SANDBOX', exact: true }).click();
  const supplier = page.getByRole('dialog', { name: 'Visma har svarat', exact: true });
  await expect(supplier).toContainText('HTTP 201'); await expect(supplier).toContainText(supplierId);
  expect(local.requests[0].payload?.Name).toBe('Redigerad lokal leverantör AB');
  expect(local.requests[0].payload?.TermsOfPaymentId).toBe(paymentTermsId);
  await supplier.getByRole('button', { name: 'Klart', exact: true }).click();
  await page.getByRole('button', { name: 'Använd leverantörs-ID', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Välj operation', exact: true })).toHaveValue('createDraft');
  await expect(page.getByLabel('Leverantörs-ID', { exact: true })).toHaveValue(supplierId);
  await page.getByLabel('Fakturanummer', { exact: true }).fill('LOCAL-EDITED-002');
  await page.getByLabel('Totalbelopp', { exact: true }).fill('125.50');
  await page.getByRole('combobox', { name: 'Konto · rad 1', exact: true }).selectOption('4000');
  await page.getByRole('combobox', { name: 'Konto · rad 2', exact: true }).selectOption('2440');
  await page.getByLabel('Debet · rad 1', { exact: true }).fill('125.50');
  await page.getByLabel('Kredit · rad 2', { exact: true }).fill('125.50');
  await page.getByRole('button', { name: 'Skicka till Visma · SANDBOX', exact: true }).click();
  const draft = page.getByRole('dialog', { name: 'Visma har svarat', exact: true });
  await expect(draft).toContainText('HTTP 201'); await expect(draft).toContainText(draftId);
  expect(local.requests).toHaveLength(2);
  const payload = local.requests[1].payload!;
  expect(payload.SupplierId).toBe(supplierId); expect(payload.InvoiceNumber).toBe('LOCAL-EDITED-002'); expect(payload.TotalAmount).toBe(125.5);
  expect((payload.Rows as { DebitAmount: number }[])[0].DebitAmount).toBe(125.5); expect(payload.SkipSendToBank).toBe(true);
  expect(JSON.parse(await draft.getByRole('region', { name: 'Anrop för detta test', exact: true }).locator('pre').innerText())).toEqual(payload);
  expect(local.externalRequests).toEqual([]);
});

test('osäkert utkast återläses efter omladdning med GET-historik och bevarar den frysta payloaden', async ({ page }) => {
  const local = await fixture(page, async request => result(request, { Id: draftId, Message: 'Sparat lokalt trots förlorat webbsvar' }, draftId), { loseResponse: true, accounts: true, historyOnly: true });
  await login(page); await open(page);
  await page.getByRole('combobox', { name: 'Välj operation', exact: true }).selectOption('createDraft');
  await page.getByLabel('Leverantörs-ID', { exact: true }).fill(supplierId);
  await page.getByLabel('Fakturanummer', { exact: true }).fill('LOCAL-FROZEN-003');
  await page.getByRole('combobox', { name: 'Konto · rad 1', exact: true }).selectOption('4000');
  await page.getByRole('combobox', { name: 'Konto · rad 2', exact: true }).selectOption('2440');
  await page.getByRole('button', { name: 'Skicka till Visma · SANDBOX', exact: true }).click();
  const uncertain = page.getByRole('dialog', { name: 'Testets resultat är oklart', exact: true });
  await expect(uncertain).toBeVisible(); await expect(page.locator('.visma-sandbox-workspace .nvv-sandbox-submit button')).toBeDisabled();
  const sent = structuredClone(local.requests[0].payload);
  await uncertain.getByRole('button', { name: 'Stäng', exact: true }).click();
  await page.getByLabel('Fakturanummer', { exact: true }).fill('LOCAL-NEXT-EDIT');
  await expect(page.getByRole('button', { name: 'Skicka till Visma · SANDBOX', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Spiris / Visma · systemadminstest', exact: true })).toBeVisible();
  const history = page.getByRole('region', { name: 'Visma testhistorik', exact: true });
  await expect(history.getByRole('button', { name: 'Visa anrop och svar', exact: true })).toHaveCount(2);
  await expect(history).toContainText('HTTP 201');
  await history.getByRole('button', { name: 'Visa anrop och svar', exact: true }).first().click();
  const recovered = page.getByRole('dialog', { name: 'Visma har svarat', exact: true });
  await expect(recovered).toContainText('HTTP 201'); await expect(recovered).toContainText('Sparat lokalt trots förlorat webbsvar');
  expect(JSON.parse(await recovered.getByRole('region', { name: 'Anrop för detta test', exact: true }).locator('pre').innerText())).toEqual(sent);
  await recovered.getByRole('button', { name: 'Klart', exact: true }).click();
  const before = local.reads.length;
  await page.getByRole('button', { name: 'Kontrollera historik', exact: true }).click();
  await expect.poll(() => local.reads.length).toBeGreaterThan(before);
  expect(local.requests).toHaveLength(1); expect(local.reads).toContain(`${api}/sandbox/runs/${local.requests[0].requestId}`); expect(local.externalRequests).toEqual([]);
});

test('oklar skrivning tillåter säker läsning och ett nytt uttryckligt test först efter kontroll av testföretaget', async ({ page }) => {
  let writes = 0;
  const local = await fixture(page, async request => {
    if (request.operation === 'company') return result(request, { CompanyIdentifier: 'local-browser-company', Name: 'Kontrollerat lokalt sandboxföretag' });
    writes++;
    if (writes === 1) return { ...result(request, null), status: 'unknown', httpStatus: null,
      error: { code: 'local_unknown', message: 'Lokal fixtur: skapandet kan ha genomförts. Kontrollera testföretaget.' } };
    return result(request, { Id: supplierId, Name: request.payload?.Name }, supplierId);
  });
  await login(page); await open(page);
  await page.getByRole('combobox', { name: 'Välj operation', exact: true }).selectOption('createSupplier');
  await page.getByLabel('Namn', { exact: true }).fill('LOCAL-UNKNOWN-FIRST');
  await page.getByRole('button', { name: 'Skicka till Visma · SANDBOX', exact: true }).click();
  const unknown = page.getByRole('dialog', { name: 'Testets resultat är oklart', exact: true });
  await expect(unknown).toBeVisible(); await unknown.getByRole('button', { name: 'Stäng', exact: true }).click();
  const original = structuredClone(local.current.runs[0]);
  await expect(page.getByRole('button', { name: 'Skicka till Visma · SANDBOX', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Välj operation', exact: true }).selectOption('company');
  await page.getByRole('button', { name: 'Läs från Visma · SANDBOX', exact: true }).click();
  const inspected = page.getByRole('dialog', { name: 'Visma har svarat', exact: true });
  await expect(inspected).toContainText('Kontrollerat lokalt sandboxföretag');
  await inspected.getByRole('button', { name: 'Klart', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Kontrollera historik', exact: true })).toBeEnabled();
  // A read must leave the unresolved write recoverable across reload.
  const historyPath = `${api}/sandbox/runs/${original.id}`;
  const beforeReload = local.reads.filter(path => path === historyPath).length;
  await page.reload(); await expect(page.getByRole('combobox', { name: 'Välj operation', exact: true })).toBeVisible();
  await expect.poll(() => local.reads.filter(path => path === historyPath).length).toBeGreaterThan(beforeReload);
  await page.getByRole('combobox', { name: 'Välj operation', exact: true }).selectOption('createSupplier');
  await expect(page.getByRole('button', { name: 'Skicka till Visma · SANDBOX', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Jag har kontrollerat testföretaget', exact: true }).click();
  await page.getByLabel('Namn', { exact: true }).fill('LOCAL-EXPLICIT-NEXT');
  await page.getByRole('button', { name: 'Skicka till Visma · SANDBOX', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Visma har svarat', exact: true })).toContainText('LOCAL-EXPLICIT-NEXT');
  expect(local.requests.map(request => request.operation)).toEqual(['createSupplier', 'company', 'createSupplier']);
  expect(new Set(local.requests.map(request => request.requestId)).size).toBe(3);
  expect(local.requests[0].idempotencyKey).not.toBe(local.requests[2].idempotencyKey);
  expect(local.current.runs.find(run => run.id === original.id)).toEqual(original);
  expect(local.requests.filter(request => request.requestId === original.id)).toHaveLength(1); expect(local.externalRequests).toEqual([]);
});
