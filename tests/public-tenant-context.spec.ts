import { expect, test } from '@playwright/test';

for (const [pagePath, apiPath] of [['/chauffor', '/api/driver'], ['/kund', '/api/customer'], ['/akeri', '/api/carrier']]) {
  test(`${pagePath} captures its selected company once and fences later portal login after another tab switches`, async ({ page }) => {
    let contexts = 0, selected = 'company-a';
    const captured: string[] = [];
    await page.route('**/api/platform/tenant-context', route => {
      contexts++;
      return route.fulfill({ json: { companyId: selected, companyName: 'Bolag A' } });
    });
    await page.route(`**${apiPath}/**`, route => {
      captured.push(route.request().headers()['x-client-company']);
      return route.fulfill({ status: selected === 'company-a' ? 401 : 409,
        json: selected === 'company-a' ? { error: 'Logga in' } : { code: 'company_selection_changed', error: 'Företaget har ändrats. Öppna inloggningslänken igen.' } });
    });
    await page.goto(pagePath);
    await expect(page.getByLabel('Inloggningsnamn', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'ScrapPilot', exact: true }).first()).toBeVisible();
    if (pagePath === '/kund') await expect(page.getByText('Välkommen tillbaka till Bolag A.', { exact: true })).toBeVisible();
    else await expect(page.getByRole('heading', { name: new RegExp(`(?:hos|från) Bolag A$`) })).toBeVisible();
    expect(contexts).toBe(1);
    expect(captured.length).toBeGreaterThan(0);
    selected = 'company-b';
    await page.getByLabel('Inloggningsnamn', { exact: true }).fill('portal-test');
    await page.getByLabel('Lösenord', { exact: true }).fill('Unique-Test-Password!');
    await page.getByRole('button', { name: 'Logga in', exact: true }).click();
    await expect(page.getByText('Företaget har ändrats. Öppna inloggningslänken igen.', { exact: true })).toBeVisible();
    expect(contexts).toBe(1);
    expect(captured.every(value => value === 'company-a')).toBe(true);
  });
}

test('terminal device commands and event stream remain bound to the first selected company', async ({ page }) => {
  let contexts = 0, selected = 'company-a';
  const captured: string[] = [];
  await page.addInitScript(() => {
    const host = window as typeof window & { terminalStreamUrls: string[] };
    host.terminalStreamUrls = [];
    class Stream extends EventTarget {
      static OPEN = 1; readyState = 1; onmessage = null; onerror = null;
      constructor(url: string) { super(); host.terminalStreamUrls.push(url); }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { value: Stream });
  });
  await page.route('**/api/platform/tenant-context', route => {
    contexts++;
    return route.fulfill({ json: { companyId: selected, companyName: 'Bolag A' } });
  });
  await page.route('**/api/terminal-demo/**', route => {
    captured.push(route.request().headers()['x-client-company']);
    if (selected !== 'company-a') return route.fulfill({ status: 409, json: { code: 'company_selection_changed', error: 'Företaget har ändrats.' } });
    return route.fulfill({ json: {
      terminal: { id: 'terminal-a', name: 'Terminal A', username: 'terminal', siteId: 'main', active: true, online: true, busy: false },
      approval: null, revision: 1, connectionId: 'connection-a',
    } });
  });
  await page.goto('/terminal');
  await expect(page.getByRole('heading', { name: 'Invänta personal', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Välkommen till Bolag A', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'ScrapPilot', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { terminalStreamUrls: string[] }).terminalStreamUrls))
    .toContain('/api/terminal-demo/terminal-events?expectedCompany=company-a');
  expect(contexts).toBe(1);
  selected = 'company-b';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('button', { name: 'Logga in terminal', exact: true })).toBeVisible();
  expect(contexts).toBe(1);
  expect(captured.every(value => value === 'company-a')).toBe(true);
});
