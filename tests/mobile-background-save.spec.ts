import { test, expect, type Page } from '@playwright/test';
import type { DemoData } from '../src/model';

const api = '/api/application/mobile';
const cacheKey = 'jeroc.mobile.demo.v1';
const pendingKey = `${cacheKey}.server-pending.mobile`;
const headers = { 'X-Demo-Mobile': 'niklas' };

async function serverData(page: Page): Promise<DemoData> {
  const response = await page.request.get(api, { headers });
  expect(response.ok()).toBe(true);
  return (await response.json()).data;
}

async function login(page: Page) {
  let reads = 0;
  page.on('response', response => {
    if (new URL(response.url()).pathname === api && response.request().method() === 'GET' && response.ok()) reads++;
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Öppna demokontot' }).click();
  await page.getByLabel('Nytt lösenord', { exact: true }).fill('Test12345!');
  await page.getByLabel('Bekräfta nytt lösenord').fill('Test12345!');
  await page.getByRole('button', { name: 'Spara och fortsätt' }).click();
  await expect(page.getByRole('heading', { name: 'Gårdsappen' })).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
}

async function openWeight(page: Page) {
  await page.getByRole('button', { name: /Starta invägning/ }).click();
  await page.getByRole('button', { name: /Materialvåg/ }).click();
  await page.locator('.material-choice').filter({ hasText: 'Koppar' }).click();
  await page.locator('.material-choice').filter({ hasText: 'Koppar klass 1' }).click();
  await page.getByRole('button', { name: 'Välj Koppar klass 1', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Vikt i kg' })).toBeVisible();
  return new URL(page.url()).hash.match(/^#\/weigh\/([^/]+)/)![1];
}

async function tapDigits(page: Page, digits: string) {
  // A real touch sequence includes the compatibility click. Each digit must
  // be accepted once even when several different keys are pressed rapidly.
  await page.evaluate(value => {
    for (const digit of value) {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.keypad button')]
        .find(element => element.getAttribute('aria-label') === digit)!;
      button.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0,
      }));
      button.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerType: 'touch', isPrimary: true, button: 0,
      }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    }
  }, digits);
}

async function pending(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]') as { next: DemoData }[], pendingKey);
}

test.beforeEach(async ({ page }) => {
  // Start with the actual shared store, avoiding a legacy import or overwrite
  // of other tests' drafts. Each test creates its own draft through the UI.
  const canonical = await serverData(page);
  await page.addInitScript(({ key, data }) => {
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, JSON.stringify(data));
      localStorage.setItem(`${key}.postgres-imported`, 'yes');
    }
  }, { key: cacheKey, data: canonical });
});

test('normal bakgrundssparning visar inget fel och flyttar inte siffertangenterna', async ({ page }) => {
  const scriptErrors: string[] = [];
  page.on('pageerror', error => scriptErrors.push(error.message));
  await login(page);

  await page.evaluate(() => {
    const observations = { alerts: [] as string[], boxes: [] as number[][], trackKeypad: false };
    (window as unknown as { saveObservations: typeof observations }).saveObservations = observations;
    const recordAlert = (element: Element) => {
      if (element.matches('.storage-error, [role="alert"].red')) observations.alerts.push(element.textContent ?? '');
      element.querySelectorAll('.storage-error, [role="alert"].red').forEach(node => observations.alerts.push(node.textContent ?? ''));
    };
    new MutationObserver(records => {
      for (const record of records) {
        record.addedNodes.forEach(node => { if (node instanceof Element) recordAlert(node); });
      }
    }).observe(document.body, { childList: true, subtree: true });
    const sample = () => {
      if (observations.trackKeypad) {
        const box = document.querySelector('.keypad')?.getBoundingClientRect();
        if (box) observations.boxes.push([box.x, box.y, box.width, box.height]);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let delayed = false;
  await page.route(`**${api}`, async route => {
    if (route.request().method() === 'POST' && !delayed) {
      delayed = true;
      await hold;
    }
    await route.continue();
  });

  try {
    const id = await openWeight(page);
    expect(delayed).toBe(true);
    const baseline = await page.locator('.keypad').boundingBox();
    expect(baseline).not.toBeNull();
    await page.evaluate(() => {
      (window as unknown as { saveObservations: { trackKeypad: boolean } }).saveObservations.trackKeypad = true;
    });
    await tapDigits(page, '13131');
    await expect(page.getByRole('textbox', { name: 'Vikt i kg' })).toHaveValue('13131');
    await expect.poll(async () => (await pending(page)).at(-1)?.next.drafts.find(draft => draft.id === id)?.pendingWeight?.value).toBe('13131');
    expect((await pending(page)).length).toBeGreaterThanOrEqual(2);
    expect((await serverData(page)).drafts.find(draft => draft.id === id)).toBeUndefined();
    await expect(page.locator('.storage-error')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);

    release();
    await expect.poll(async () => (await pending(page)).length).toBe(0);
    expect((await serverData(page)).drafts.find(draft => draft.id === id)?.pendingWeight?.value).toBe('13131');
    const observations = await page.evaluate(() => (window as unknown as {
      saveObservations: { alerts: string[]; boxes: number[][]; trackKeypad: boolean };
    }).saveObservations);
    expect(observations.alerts).toEqual([]);
    expect(observations.boxes.length).toBeGreaterThan(0);
    for (const box of observations.boxes) {
      [baseline!.x, baseline!.y, baseline!.width, baseline!.height].forEach((value, index) => {
        expect(Math.abs(box[index] - value)).toBeLessThanOrEqual(1);
      });
    }
    expect(scriptErrors).toEqual([]);
  } finally {
    release();
  }
});

test('ett verkligt serverfel behåller varning och osparade siffror tills kön återhämtats', async ({ page }) => {
  const scriptErrors: string[] = [];
  page.on('pageerror', error => scriptErrors.push(error.message));
  await login(page);
  const id = await openWeight(page);
  await expect.poll(async () => (await pending(page)).length).toBe(0);

  let unavailable = true;
  let failedPosts = 0;
  await page.route(`**${api}`, async route => {
    if (unavailable && route.request().method() === 'POST') {
      failedPosts++;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Testservern är tillfälligt otillgänglig.' }) });
    } else await route.continue();
  });

  await tapDigits(page, '242');
  const warning = page.locator('.storage-error').getByRole('alert');
  await expect(warning).toContainText('Testservern är tillfälligt otillgänglig.');
  await expect(warning).toContainText('Osparat arbete finns kvar på denna enhet.');
  expect((await pending(page)).length).toBeGreaterThan(0);
  expect((await serverData(page)).drafts.find(draft => draft.id === id)?.pendingWeight).toBeUndefined();

  // Later input remains editable, but must not erase the genuine error while
  // earlier work is still waiting for an unavailable server.
  await tapDigits(page, '424');
  await expect(page.getByRole('textbox', { name: 'Vikt i kg' })).toHaveValue('242424');
  await expect.poll(async () => (await pending(page)).at(-1)?.next.drafts.find(draft => draft.id === id)?.pendingWeight?.value).toBe('242424');
  await expect(warning).toContainText('Osparat arbete finns kvar på denna enhet.');
  expect(failedPosts).toBeGreaterThanOrEqual(2);

  // A new page instance must recover the durable queue rather than relying on
  // React state from the original page. Replay the real writes after recovery.
  unavailable = false;
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Vikt i kg' })).toHaveValue('242424');
  await expect.poll(async () => (await pending(page)).length).toBe(0);
  await expect(page.locator('.storage-error')).toHaveCount(0);
  expect((await serverData(page)).drafts.find(draft => draft.id === id)?.pendingWeight?.value).toBe('242424');
  expect(scriptErrors).toEqual([]);
});
