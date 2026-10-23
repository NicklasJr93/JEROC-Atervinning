import { expect, test, type Page, type Route } from '@playwright/test';

const demo = '/bokforing/';
const storageKey = 'scrapplanner-bokforing-suite-v2';
const available = { configured: true, authenticated: true, available: true, model: 'test-model', csrfToken: 'test-csrf', sessionGeneration: 'demo-session-one' };
test.use({ viewport: { width: 1440, height: 1000 } });
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const errors: string[] = []; pageErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message)); });
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

async function mock(page: Page, { status = available, reply = async (route: Route) => route.fulfill({ json: { text: 'Kontrollera momsen och granska underlaget innan du bokför.', model: 'test-model', usage: { inputTokens: 20, outputTokens: 12 } } }) } = {}) {
  const requests: { question: string; history: unknown[]; context: Record<string, unknown> | null; headers: Record<string, string> }[] = [];
  let statusCalls = 0;
  await page.route('**/api/bokforing/ande/**', async route => {
    if (route.request().url().endsWith('/status')) { statusCalls++; return route.fulfill({ json: status }); }
    requests.push({ ...route.request().postDataJSON(), headers: route.request().headers() });
    return reply(route);
  });
  return { requests, statusCalls: () => statusCalls };
}
async function open(page: Page, route = '') {
  await page.goto(demo + route);
  await page.locator('.ande-launcher').click();
  await expect(page.locator('#suite-assistant')).toBeVisible();
}
async function ask(page: Page, text = 'Vad bör jag kontrollera?') {
  await page.locator('#assistant-input').fill(text);
  await page.locator('#ande-send').click();
}

test('Ande kontaktar servern först när panelen öppnas och ändrar inte demoboken', async ({ page }) => {
  const api = await mock(page);
  await page.goto(demo);
  const before = await page.evaluate(key => localStorage.getItem(key), storageKey);
  expect(api.statusCalls()).toBe(0);
  await page.locator('.ande-launcher').click();
  await expect(page.locator('#ande-connection')).toContainText('Ande är ansluten');
  await ask(page);
  await expect(page.locator('.ande-message-text').last()).toContainText('Kontrollera momsen');
  expect(api.requests).toHaveLength(1);
  expect(api.requests[0].headers['x-csrf-token']).toBe('test-csrf');
  expect(api.requests[0].context).toMatchObject({ source: 'browser-demo', view: 'overview', selected: null });
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(before);
});

test('saknad anslutning visas utan inloggningskrav och gör inga modellanrop', async ({ page }) => {
  const api = await mock(page, { status: { ...available, configured: false, available: false } });
  await open(page);
  await expect(page.locator('#ande-connection')).toContainText('inte tillgänglig');
  await expect(page.locator('#suite-assistant a[href="/kontor/"]')).toHaveCount(0);
  await expect(page.locator('#assistant-input')).toBeDisabled();
  await expect(page.locator('#ande-send')).toBeDisabled();
  expect(api.requests).toHaveLength(0);
});

test('fakturakontext går att stänga av och utelämnar kund-, personnummer- och betalningsfält', async ({ page }) => {
  const api = await mock(page);
  await page.goto(demo + '#sales');
  const invoice = await page.evaluate(async () => {
    const source = '/bokforing/suite/seed.js';
    const { createSuiteState } = await import(source);
    const state = createSuiteState();
    const item = state.invoices.find((entry: { status: string }) => entry.status === 'draft');
    return { id: item.id };
  });
  await page.goto(demo + '#sales/' + invoice.id);
  await page.locator('.ande-launcher').click();
  await expect(page.locator('#ande-connection')).toContainText('Ande är ansluten');
  await ask(page, 'Förklara fakturans belopp.');
  await expect(page.locator('.ande-message-text').last()).toContainText('Kontrollera momsen');
  const payload = JSON.stringify(api.requests[0].context);
  expect(api.requests[0].context).toMatchObject({ selected: { kind: 'customer-invoice', id: invoice.id } });
  expect(payload).not.toMatch(/Maria|Lind|example\.invalid|DEMOFASTIGHET|DEMO-MARIA|personId|address|payments|bankAccount/);
  await page.locator('.ande-context summary').click();
  await page.locator('#ande-share-context').uncheck();
  await ask(page, 'Vad är debet?');
  await expect.poll(() => api.requests.length).toBe(2);
  expect(api.requests[1].context).toBeNull();
  expect(api.requests[1].history).toEqual([]);
});

test('AI-text körs aldrig som HTML och bara godkända källänkar blir klickbara', async ({ page }) => {
  await mock(page, { reply: async route => route.fulfill({ json: {
    text: '<img src=x onerror="window.andeInjection=true"> Kontrollera 2641.',
    citations: [
      { title: 'Skatteverket', url: 'https://www.skatteverket.se/' },
      { title: 'Skadlig länk', url: 'javascript:alert(1)' },
      { title: 'Annan sajt', url: 'https://evil.invalid/' },
      { title: 'Wiki', url: '/bokforing/wiki/#artikel/for-revisorn' },
    ],
  } }) });
  await open(page); await ask(page);
  await expect(page.locator('.ande-message-text').last()).toContainText('<img src=x');
  await expect(page.locator('#assistant-messages img')).toHaveCount(0);
  await expect(page.locator('.ande-citations a')).toHaveCount(2);
  expect(await page.evaluate(() => (window as typeof window & { andeInjection?: boolean }).andeInjection)).toBeUndefined();
});

test('kvotfel visas ärligt utan fabricerat AI-svar eller ändrad bokföring', async ({ page }) => {
  const api = await mock(page, { reply: async route => route.fulfill({ status: 429, json: { error: 'quota', message: 'PRIVATE_PROVIDER_ERROR' } }) });
  await open(page);
  const before = await page.evaluate(key => localStorage.getItem(key), storageKey);
  await ask(page);
  await expect(page.locator('#ande-error')).toContainText('användningsgräns');
  await expect(page.locator('#assistant-input')).toBeEnabled();
  await expect(page.locator('#assistant-messages')).not.toContainText('PRIVATE_PROVIDER_ERROR');
  await expect(page.locator('#assistant-messages .chat-bubble.assistant:not(.ande-thinking)')).toHaveCount(1);
  expect(api.requests).toHaveLength(1);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(before);
});

for (const [code, status, message] of [
  ['ANDE_RESPONSE_LIMIT', 503, 'svar blev för långt'],
  ['ANDE_PROVIDER_TIMEOUT', 504, 'hann inte svara'],
  ['ANDE_PROVIDER_PROTOCOL', 503, 'ofullständigt svar'],
] as const) {
  test(`Ande förklarar ${code} och behåller frågan för ett nytt försök`, async ({ page }) => {
    let attempts = 0;
    const api = await mock(page, { reply: async route => {
      attempts++;
      return attempts === 1
        ? route.fulfill({ status, json: { code, error: 'PRIVATE_PROVIDER_ERROR' } })
        : route.fulfill({ json: { text: 'Fakturan är redan utfärdad. Kontrollera om betalningen kommit in.' } });
    } });
    await open(page);
    const question = 'vad ska jag göra här på denna sida';
    await ask(page, question);
    await expect(page.locator('#ande-error')).toContainText(new RegExp(message, 'i'));
    await expect(page.locator('#ande-error')).not.toContainText('PRIVATE_PROVIDER_ERROR');
    await expect(page.locator('#assistant-input')).toHaveValue(question);
    await page.locator('#ande-send').click();
    await expect(page.locator('.ande-message-text').last()).toContainText('Fakturan är redan utfärdad');
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1].history).toEqual([]);
    await expect(page.locator('#ande-error')).toBeHidden();
  });
}

test('byte av vy avbryter ett gammalt svar och nästa fråga får den nya kontexten', async ({ page }) => {
  let release: (() => void) | undefined;
  let count = 0;
  const api = await mock(page, { reply: async route => {
    const index = ++count;
    if (index === 1) await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { text: index === 1 ? 'Gammalt svar som inte får visas' : 'Svar i ny vy' } }).catch(() => {});
  } });
  await open(page); await ask(page);
  await expect(page.locator('.ande-thinking')).toBeVisible();
  await page.evaluate(() => { location.hash = '#purchases'; });
  await expect(page.locator('#ande-error')).toContainText('Underlaget ändrades');
  release?.();
  await expect(page.locator('#assistant-input')).toBeEnabled();
  await ask(page, 'Vad gör jag här?');
  await expect(page.locator('.ande-message-text').last()).toContainText('Svar i ny vy');
  await expect(page.locator('#assistant-messages')).not.toContainText('Gammalt svar');
  expect(api.requests[1].context).toMatchObject({ view: 'purchases' });
  expect(api.requests[1].history).toEqual([]);
});

test('nytt samtal och omladdning rensar chatten utan att spara den i webbläsarlagring', async ({ page }) => {
  const api = await mock(page);
  await open(page); await ask(page, 'Hemlig testfråga bara i den här fliken.');
  await expect(page.locator('.ande-message-text').last()).toContainText('Kontrollera momsen');
  await page.locator('#ande-new').click();
  await expect(page.locator('#assistant-messages')).not.toContainText('Hemlig testfråga');
  await ask(page, 'Ny fråga efter rensning');
  await expect.poll(() => api.requests.length).toBe(2);
  expect(api.requests[1].history).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('Hemlig testfråga');
  await page.reload(); await page.locator('.ande-launcher').click();
  await expect(page.locator('#assistant-messages')).not.toContainText('Ny fråga efter rensning');
});

test('Ande fungerar med Enter och håller sig på mobilskärmen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await mock(page);
  await open(page);
  await page.locator('#assistant-input').fill('Förklara debet.');
  await page.locator('#assistant-input').press('Enter');
  await expect(page.locator('.ande-message-text').last()).toContainText('Kontrollera momsen');
  expect(api.requests).toHaveLength(1);
  const box = await page.locator('#suite-assistant').boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844);
});

test('förnyad demosession rensar gammal historik innan nästa modellanrop', async ({ page }) => {
  const status = { ...available };
  const api = await mock(page, { status });
  await open(page); await ask(page, 'Fråga från den gamla demosessionen.');
  await expect(page.locator('.ande-message-text').last()).toContainText('Kontrollera momsen');
  status.csrfToken = 'a-new-demo-session-token';
  status.sessionGeneration = 'demo-session-two';
  await page.locator('#ande-refresh').click();
  await expect(page.locator('#assistant-messages')).not.toContainText('Fråga från den gamla');
  await expect(page.locator('#ande-connection')).toContainText('Ande är ansluten');
  await ask(page, 'Fråga i den nya demosessionen.');
  await expect.poll(() => api.requests.length).toBe(2);
  expect(api.requests[1].history).toEqual([]);
  expect(api.requests[1].headers['x-csrf-token']).toBe('a-new-demo-session-token');
});
