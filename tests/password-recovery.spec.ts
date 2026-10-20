import { expect, test, type Page, type Request } from '@playwright/test';

const token = 'aB09_-'.repeat(7) + 'x';
const password = 'Min nya trygga lösenfras 2026!';
const notice = 'Om adressen är kopplad till ett aktivt konto skickar vi en återställningslänk.';
test.use({ viewport: { width: 1100, height: 900 }, isMobile: false, hasTouch: false });

async function setup(page: Page, options: { sessionError?: boolean; confirmStatus?: number; confirmError?: string; failFirstConfirm?: boolean; deferConfirm?: boolean; malformedConfirm?: boolean } = {}) {
  const requests: Request[] = [], nonPublic: string[] = [];
  let sessionReads = 0, confirmations = 0, release!: () => void;
  const confirmationGate = options.deferConfirm ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push(request);
    if (path === '/api/platform/session') {
      sessionReads++;
      return options.sessionError ? route.fulfill({ status: 401, json: { error: 'Gammal session.' } })
        : route.fulfill({ json: { enabled: true, authenticated: false } });
    }
    if (path === '/api/platform/password-reset/request') return route.fulfill({ json: { ok: true, message: 'Annan leverantörstext får inte avslöja konton.' } });
    if (path === '/api/platform/password-reset/confirm') {
      confirmations++;
      if (options.failFirstConfirm && confirmations === 1) return route.abort('failed');
      await confirmationGate;
      return route.fulfill({ status: options.confirmStatus ?? 200, json: options.confirmStatus ? { error: options.confirmError, code: 'password_reset_invalid' }
        : options.malformedConfirm ? { ok: false } : { ok: true } });
    }
    nonPublic.push(path);
    return route.fulfill({ status: 503, json: { error: 'Tjänsten ingår inte i återställningsprovet.' } });
  });
  return { requests, nonPublic, sessionReads: () => sessionReads, confirmations: () => confirmations, release: () => release?.() };
}

async function openReset(page: Page) {
  await page.goto(`/kontor/#/reset-password?token=${token}`);
  await expect(page.getByRole('heading', { name: 'Välj ett nytt lösenord', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/reset-password$/);
}
async function fillPassword(page: Page, confirmed = password) {
  await page.getByLabel('Nytt lösenord', { exact: true }).fill(password);
  await page.getByLabel('Bekräfta nytt lösenord', { exact: true }).fill(confirmed);
}

test('Glömt lösenord från kontorets inloggning skickar bara registrerad e-post och ger generellt besked', async ({ page }) => {
  const f = await setup(page);
  await page.goto('/kontor/');
  await page.getByRole('link', { name: 'Glömt lösenord?', exact: true }).click();
  await page.getByLabel('E-postadress', { exact: true }).fill('vd@example.test');
  await page.getByRole('button', { name: 'Skicka återställningslänk', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(notice);
  const resetRequest = f.requests.find(request => request.url().endsWith('/password-reset/request'))!;
  expect(resetRequest.method()).toBe('POST'); expect(resetRequest.postDataJSON()).toEqual({ email: 'vd@example.test' });
  expect(f.nonPublic).toEqual([]);
  await expect(page.getByText('Annan leverantörstext får inte avslöja konton.', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveCount(0);
});

test('publik återställningssida fungerar utan sessionskontroll eller verksamhetsanrop', async ({ page }) => {
  const f = await setup(page, { sessionError: true });
  await page.goto('/kontor/#/forgot-password');
  await expect(page.getByRole('heading', { name: 'Glömt lösenord?', exact: true })).toBeVisible();
  expect(f.sessionReads()).toBe(0); expect(f.nonPublic).toEqual([]);
  await openReset(page);
  expect(f.sessionReads()).toBe(0); expect(f.nonPublic).toEqual([]);
  // Opening an emailed link never consumes it or changes a password.
  expect(f.confirmations()).toBe(0);
});

test('valfritt användarnamn skiljer konton med samma e-postadress utan att avslöja kontot i svaret', async ({ page }) => {
  const f = await setup(page);
  await page.goto('/kontor/#/forgot-password');
  await page.getByLabel('E-postadress', { exact: true }).fill('nicklas@example.test');
  await page.getByLabel('Användarnamn (valfritt)', { exact: true }).fill(' admin ');
  await page.getByRole('button', { name: 'Skicka återställningslänk', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(notice);
  const resetRequest = f.requests.find(request => request.url().endsWith('/password-reset/request'))!;
  expect(resetRequest.postDataJSON()).toEqual({ email: 'nicklas@example.test', username: 'admin' });
  await expect(page.getByText('Annan leverantörstext får inte avslöja konton.', { exact: true })).toHaveCount(0);
});

test('återställningen går att öppna även när en gammal inloggning inte kan kontrolleras', async ({ page }) => {
  const f = await setup(page, { sessionError: true });
  await page.goto('/kontor/');
  await expect(page.getByRole('heading', { name: 'Arbetsytan kunde inte öppnas', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Glömt lösenord?', exact: true }).click();
  await expect(page.getByLabel('E-postadress', { exact: true })).toBeVisible();
  expect(f.sessionReads()).toBe(1); expect(f.nonPublic).toEqual([]);
});

test('lösenorden måste stämma överens och token skickas endast i bekräftelsens JSON', async ({ page }) => {
  const f = await setup(page);
  await openReset(page);
  await fillPassword(page, 'Det här är ett annat lösenord!');
  await page.getByRole('button', { name: 'Spara nytt lösenord', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('stämmer inte överens');
  expect(f.confirmations()).toBe(0);
  await page.getByLabel('Bekräfta nytt lösenord', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Spara nytt lösenord', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lösenordet är ändrat', exact: true })).toBeVisible();
  const confirm = f.requests.find(request => request.url().endsWith('/password-reset/confirm'))!;
  expect(confirm.method()).toBe('POST'); expect(confirm.postDataJSON()).toEqual({ token, newPassword: password, confirmPassword: password });
  expect(f.requests.every(request => !request.url().includes(token))).toBe(true);
  expect(f.requests.some(request => request.url().endsWith('/login'))).toBe(false);
  await expect(page.getByLabel('Nytt lösenord', { exact: true })).toHaveCount(0);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain(token); expect(storage).not.toContain(password);
  await expect(page.locator('body')).not.toContainText(token);
  await expect(page).toHaveURL(/#\/reset-password$/);
});

test('ogiltig eller förbrukad länk ger begripligt fel och möjlighet att begära en ny', async ({ page }) => {
  const f = await setup(page, { confirmStatus: 422, confirmError: 'Länken är ogiltig eller har gått ut. Begär en ny återställningslänk.' });
  await openReset(page); await fillPassword(page);
  await page.getByRole('button', { name: 'Spara nytt lösenord', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('ogiltig eller har gått ut');
  await expect(page.getByRole('heading', { name: 'Lösenordet är ändrat', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Begär en ny återställningslänk', exact: true }).click();
  await expect(page.getByLabel('E-postadress', { exact: true })).toBeVisible();
  expect(f.confirmations()).toBe(1);
});

test('saknad eller felaktig token lämnar inte något nytt lösenordsformulär tillgängligt', async ({ page }) => {
  const f = await setup(page);
  for (const fragment of ['#/reset-password', '#/reset-password?token=fel', `#/reset-password?token=${token}&token=${token}`]) {
    await page.goto(`/kontor/${fragment}`);
    await expect(page.getByRole('alert')).toContainText('Länken saknas eller är ogiltig');
    await expect(page.getByLabel('Nytt lösenord', { exact: true })).toHaveCount(0);
  }
  expect(f.confirmations()).toBe(0);
});

test('nätfel behåller länken i minnet så användaren kan försöka igen utan att något lösenord lagras', async ({ page }) => {
  const f = await setup(page, { failFirstConfirm: true });
  await openReset(page); await fillPassword(page);
  await page.getByRole('button', { name: 'Spara nytt lösenord', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Kontrollera anslutningen');
  await page.getByRole('button', { name: 'Spara nytt lösenord', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lösenordet är ändrat', exact: true })).toBeVisible();
  expect(f.confirmations()).toBe(2);
});

test('två samtidiga submit-händelser ger bara en lösenordsändring', async ({ page }) => {
  const f = await setup(page, { deferConfirm: true });
  await openReset(page); await fillPassword(page);
  await page.locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await expect.poll(f.confirmations).toBe(1);
  await expect(page.getByRole('button', { name: 'Sparar…', exact: true })).toBeDisabled();
  f.release();
  await expect(page.getByRole('heading', { name: 'Lösenordet är ändrat', exact: true })).toBeVisible();
  expect(f.confirmations()).toBe(1);
});

test('ofullständigt serversvar får inte visas som lyckad lösenordsändring', async ({ page }) => {
  await setup(page, { malformedConfirm: true });
  await openReset(page); await fillPassword(page);
  await page.getByRole('button', { name: 'Spara nytt lösenord', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('resultat kunde inte bekräftas');
  await expect(page.getByRole('heading', { name: 'Lösenordet är ändrat', exact: true })).toHaveCount(0);
});
