import { test, expect } from '@playwright/test';

const routes = ['/', '/plattformen/', '/integrationer/', '/priser/', '/kontakt/', '/integritet/'];

async function revealLazyImages(page) {
  await page.evaluate(async () => {
    for (const img of document.images) {
      img.loading = 'eager';
      await img.decode().catch(() => {});
    }
  });
}

test('all public pages render without overflow, broken assets, runtime errors or external requests', async ({ page }) => {
  const errors = [];
  const external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (!request.url().startsWith('http://127.0.0.1:4174/')) external.push(request.url());
  });
  for (const route of routes) {
    const response = await page.goto(route);
    expect(response.status(), route).toBe(200);
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.locator('footer')).toContainText('EndorGroup');
    await revealLazyImages(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), route).toBe(true);
    expect(await page.locator('img').evaluateAll(images => images.filter(image => !image.complete || !image.naturalWidth).map(image => image.src)), route).toEqual([]);
    await expect(page.getByRole('banner').getByRole('link', { name: 'Logga in', exact: true })).toHaveAttribute('href', 'https://app.scrapplanner.com');
  }
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('navigation and feature anchors open the requested content', async ({ page }, testInfo) => {
  await page.goto('/');
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Öppna menyn' }).click();
  await page.getByRole('navigation', { name: 'Huvudnavigation' }).getByRole('link', { name: 'Plattformen', exact: true }).click();
  await expect(page).toHaveURL(/\/plattformen\/$/);
  await expect(page.locator('#main-nav a[href="/plattformen/"]')).toHaveAttribute('aria-current', 'page');
  const anchor = page.locator('main a[href^="#"]').first();
  const href = await anchor.getAttribute('href');
  await anchor.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.locator(href)).toBeInViewport();
  await page.locator('footer').getByRole('link', { name: 'Priser & offert' }).click();
  await expect(page).toHaveURL(/\/priser\/$/);
  await expect(page.locator('main')).toContainText('offert');
});

test('product phones keep realistic device proportions on desktop and mobile', async ({ page }) => {
  let checked = 0;
  for (const route of ['/', '/plattformen/']) {
    await page.goto(route);
    await page.evaluate(() => document.fonts.ready);
    const phones = page.locator('main .phone');
    for (let index = 0; index < await phones.count(); index += 1) {
      const phone = phones.nth(index);
      await phone.scrollIntoViewIfNeeded();
      await expect(phone).toBeVisible();
      // Transforms change the bounding rectangle; the underlying device frame is
      // what must retain its proportions when text and responsive layouts change.
      const dimensions = await phone.evaluate(device => ({ width: device.offsetWidth, height: device.offsetHeight }));
      expect(dimensions.width, `${route}: visible phone width`).toBeGreaterThan(80);
      expect(dimensions.height / dimensions.width, `${route}: phone height/width`).toBeGreaterThanOrEqual(2);
      expect(dimensions.height / dimensions.width, `${route}: phone height/width`).toBeLessThanOrEqual(2.2);
      checked += 1;
    }
    await expect(page.locator('main').getByText(/illustrativ[\s\S]*produktvy|illustrativ[\s\S]*produktvyer|utvalt produktutsnitt/i).first()).toBeVisible();
  }
  expect(checked, 'the product story should include a phone illustration').toBeGreaterThan(0);
});

test('the hero illustration never covers the primary or secondary action', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The responsive breakpoint sweep is checked once.');
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    const actions = await page.evaluate(() => {
      const illustration = document.querySelector('.hero-workspace').getBoundingClientRect();
      return [...document.querySelectorAll('.hero-actions a')].map(action => {
        const bounds = action.getBoundingClientRect();
        return {
          label: action.textContent.trim(),
          covered: bounds.left < illustration.right && bounds.right > illustration.left
            && bounds.top < illustration.bottom && bounds.bottom > illustration.top,
        };
      });
    });
    expect(actions.length).toBe(2);
    for (const action of actions) expect(action.covered, `${width}px: ${action.label}`).toBe(false);
  }
});

test('contact information stays on the device until the visitor sends their own email', async ({ page }) => {
  const dataRequests = [];
  const requests = [];
  page.on('request', request => {
    requests.push(request);
    if (!['GET', 'HEAD'].includes(request.method())) dataRequests.push(request.url());
  });
  await page.goto('/kontakt/');
  const literal = '<img src=x onerror="window.enquiryInjected=true"> & Ärendet gäller kopparkabel?';
  await page.locator('#name').fill('Anna Öst');
  await page.locator('#email').fill('anna+demo@example.com');
  await page.locator('#company').fill('Återvinning & Transport AB');
  await page.locator('#message').fill(literal);
  await page.locator('#privacy-consent').check();
  const initialRequestCount = requests.length;
  await page.getByRole('button', { name: 'Förbered förfrågan' }).click();
  await expect(page.locator('#enquiry-result')).toBeVisible();
  await expect(page.locator('#enquiry-result')).toContainText('Inget meddelande har skickats');
  const prepared = await page.locator('#enquiry-text').inputValue();
  expect(prepared).toContain(literal);
  expect(prepared).toContain('Anna Öst');
  expect(prepared).toContain('anna+demo@example.com');
  expect(await page.evaluate(() => window.enquiryInjected)).toBeUndefined();
  expect(await page.locator('#enquiry-result img').count()).toBe(0);
  const mailto = new URL(await page.locator('#email-enquiry').getAttribute('href'));
  expect(mailto.protocol).toBe('mailto:');
  expect(decodeURIComponent(mailto.pathname)).toBe('nicklas@endorgroup.se');
  expect(mailto.searchParams.get('body')).toContain(literal);
  expect(mailto.searchParams.has('bcc')).toBe(false);
  expect(dataRequests).toEqual([]);
  expect(requests.length).toBe(initialRequestCount);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(await page.context().cookies()).toEqual([]);
});

test('required fields stop incomplete enquiries and copying has a useful fallback', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } },
    });
    document.execCommand = () => false;
  });
  await page.goto('/kontakt/');
  await page.getByRole('button', { name: 'Förbered förfrågan' }).click();
  await expect(page.locator('#enquiry-result')).toBeHidden();
  await page.locator('#name').fill('Anna');
  await page.locator('#email').fill('anna@example.com');
  await page.locator('#company').fill('Testföretag');
  await page.locator('#message').fill('Vi vill boka en genomgång.');
  await page.getByRole('button', { name: 'Förbered förfrågan' }).click();
  await expect(page.locator('#enquiry-result')).toBeHidden();
  await page.locator('#privacy-consent').check();
  await page.getByRole('button', { name: 'Förbered förfrågan' }).click();
  await expect(page.locator('#enquiry-result')).toBeVisible();
  await page.getByRole('button', { name: 'Kopiera förfrågan' }).click();
  await expect(page.locator('#form-status')).toContainText(/markera|kopiera|kopiering/i);
  await expect(page.locator('#enquiry-text')).toBeFocused();
});

test('unknown pages return an actual 404 and unsupported form posts cannot be submitted', async ({ page, request }) => {
  const response = await page.goto('/sidan-finns-inte/');
  expect(response.status()).toBe(404);
  await expect(page.locator('main h1')).toContainText('vägen slut');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  const post = await request.post('/kontakt/', { data: 'not-a-submission' });
  expect(post.status()).toBe(405);
  expect(post.headers().allow).toBe('GET, HEAD');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['content-security-policy']).toContain("form-action 'none'");
  await page.getByRole('link', { name: 'Till startsidan' }).click();
  await expect(page).toHaveURL('/');
});

test('mobile navigation supports keyboard opening, dismissal and focus return', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile navigation appears at the narrow breakpoint.');
  await page.goto('/');
  const toggle = page.locator('.menu-toggle');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#main-nav')).toBeVisible();
  await page.getByRole('navigation', { name: 'Huvudnavigation' }).getByRole('link', { name: 'Plattformen', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await expect(page.locator('#main-nav')).toBeHidden();
});

test('narrow phones and intermediate tablets have no overflowing content', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Additional widths are checked once.');
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of routes) {
      await page.goto(route);
      await revealLazyImages(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px ${route}`).toBe(true);
    }
  }
});
