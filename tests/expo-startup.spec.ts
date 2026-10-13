import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

test.setTimeout(45_000);
test.describe.configure({ mode: 'serial' });
type ExpoStatus = { enabled: boolean; ready: boolean; state: 'starting' | 'compiling' | 'retrying' | 'ready' | 'error' | 'disabled';
  compilingPlatform: 'ios' | 'android' | null; warmedPlatforms: ('ios' | 'android')[]; retryable: boolean; retryAt?: string; errorCode?: string };
const iosAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const androidAgent = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';
const desktopAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
async function device(browser: Browser, agent: string): Promise<{ context: BrowserContext; page: Page }> {
  const mobile = agent !== desktopAgent;
  const context = await browser.newContext({ userAgent: agent, viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 900 },
    isMobile: mobile, hasTouch: mobile, locale: 'sv-SE' });
  const page = await context.newPage();
  await page.clock.install({ time: new Date() });
  return { context, page };
}
async function fixture(page: Page, initial: ExpoStatus, hangFirst = false) {
  const controls = { state: initial, holdRetry: undefined as { ready: () => void; gate: Promise<void> } | undefined };
  const requests: string[] = [], posts: { origin?: string; url: string }[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let firstStarted!: () => void, releaseFirst!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; }), gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.route('**/expo/status', async route => {
    requests.push(route.request().method());
    const state = structuredClone(controls.state);
    if (hangFirst && requests.length === 1) { firstStarted(); await gate; }
    await route.fulfill({ json: state }).catch(error => { if (!/cancel|abort|closed|interception/i.test(String(error))) throw error; });
  });
  await page.route('**/expo/retry', async route => {
    posts.push({ origin: route.request().headers().origin, url: route.request().url() });
    expect(route.request().method()).toBe('POST');
    const held = controls.holdRetry;
    if (held) { controls.holdRetry = undefined; held.ready(); await held.gate; }
    controls.state = { enabled: true, ready: false, state: 'compiling', compilingPlatform: 'ios', warmedPlatforms: [], retryable: false };
    await route.fulfill({ json: { accepted: true, ...controls.state } });
  });
  await page.goto('/expo-go.html');
  if (hangFirst) await started;
  else await expect(page.getByRole('status')).not.toHaveText('Kontrollerar Expo-servern…');
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  return { controls, requests, posts, errors, releaseFirst };
}
const iosPartial: ExpoStatus = { enabled: true, ready: false, state: 'compiling', compilingPlatform: 'android', warmedPlatforms: ['ios'], retryable: false };

test('iPhone och desktop får en sanningsenlig öppningslänk så snart iOS är klart och pollningen fortsätter för Android', async ({ browser }, info) => {
  for (const agent of [iosAgent, desktopAgent]) {
    const { context, page } = await device(browser, agent);
    const { controls, requests, posts, errors } = await fixture(page, structuredClone(iosPartial));
    await expect(page.getByRole('link', { name: 'Öppna i Expo Go', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Öppna i Expo Go', exact: true })).toHaveAttribute('href', 'exps://jeroc-atervinning.onrender.com/expo');
    await expect(page.getByRole('status')).toContainText(agent === iosAgent ? 'Appaketet för iPhone är klart' : 'iPhone-appen är klar. Android är ännu inte klart');
    await expect(page.getByRole('status')).not.toContainText('Appaketen för iPhone och Android är förberedda');
    await expect(page.locator('#launch-platform')).toHaveText('Klart för iPhone. Android är ännu inte klart.');
    await expect(page.locator('#launch img')).toHaveAttribute('src', '/expo-go-qr.svg');
    if (agent === iosAgent) await page.screenshot({ path: info.outputPath('expo-ios-partial-390.png'), fullPage: true });
    const initialReads = requests.length;
    controls.state = { ...controls.state, state: 'retrying', compilingPlatform: null, errorCode: 'EXPO_COMPILE_TIMEOUT', retryable: true };
    await page.clock.runFor(3000);
    await expect.poll(() => requests.length).toBe(initialReads + 1);
    await expect(page.getByRole('link', { name: 'Öppna i Expo Go', exact: true })).toBeVisible();
    controls.state = { enabled: true, ready: true, state: 'ready', compilingPlatform: null, warmedPlatforms: ['ios', 'android'], retryable: false };
    await page.clock.runFor(3000);
    await expect(page.getByRole('status')).toHaveText('Appaketen för iPhone och Android är förberedda. Du kan öppna appen nu.');
    expect(posts).toHaveLength(0); expect(errors).toEqual([]);
    await context.close();
  }
});

test('Android inväntar sitt eget paket genom automatisk timeout-återhämtning utan deployinstruktioner', async ({ browser }) => {
  const { context, page } = await device(browser, androidAgent);
  const { controls, posts, errors } = await fixture(page, structuredClone(iosPartial));
  await expect(page.locator('#launch')).toBeHidden();
  await expect(page.getByRole('status')).toContainText('Förbereder appaketet för Android');
  controls.state = { ...controls.state, state: 'retrying', compilingPlatform: null, retryable: true, errorCode: 'EXPO_COMPILE_TIMEOUT' };
  await page.clock.runFor(3000);
  await expect(page.getByRole('status')).toContainText('Servern försöker automatiskt igen');
  await expect(page.locator('#launch')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Försök förbereda igen', exact: true })).toBeHidden();
  await expect(page.getByRole('status')).not.toContainText(/Render|deploy|Build Command|GitHub/i);
  controls.state = { enabled: true, ready: true, state: 'ready', compilingPlatform: null, warmedPlatforms: ['ios', 'android'], retryable: false };
  await page.clock.runFor(3000);
  await expect(page.getByRole('link', { name: 'Öppna i Expo Go', exact: true })).toBeVisible();
  expect(posts).toHaveLength(0); expect(errors).toEqual([]);
  await context.close();
});

test('statusanrop har timeout och återhämtar sig medan ett uttömt förberedelseförsök kan startas en gång efter cooldown', async ({ browser }) => {
  const { context, page } = await device(browser, iosAgent);
  const { controls, requests, posts, errors, releaseFirst } = await fixture(page,
    { enabled: true, ready: false, state: 'compiling', compilingPlatform: 'ios', warmedPlatforms: [], retryable: false }, true);
  await page.clock.runFor(8001);
  await expect(page.getByRole('status')).toContainText('Kunde tillfälligt inte kontrollera Expo-servern. Försöker igen automatiskt.');
  controls.state = { enabled: true, ready: false, state: 'error', compilingPlatform: null, warmedPlatforms: [], retryable: true,
    errorCode: 'EXPO_COMPILE_TIMEOUT', retryAt: new Date((await page.evaluate(() => Date.now())) + 4000).toISOString() };
  releaseFirst();
  await page.clock.runFor(3000);
  const retry = page.getByRole('button', { name: 'Försök förbereda igen', exact: true });
  await expect(retry).toBeVisible(); await expect(retry).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Förberedelsen hann inte bli klar inom tidsgränsen');
  await expect(page.getByRole('status')).not.toContainText(/Render|deploy|Build Command|GitHub/i);
  await retry.evaluate(button => (button as HTMLButtonElement).click());
  expect(posts).toHaveLength(0);
  await page.clock.runFor(1026);
  await expect(retry).toBeEnabled();
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  controls.holdRetry = { ready, gate };
  await retry.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await started;
  await expect(retry).toBeDisabled();
  expect(posts).toHaveLength(1);
  expect(posts[0].origin).toBe(new URL(posts[0].url).origin);
  release();
  await expect(page.getByRole('status')).toContainText('Förbereder appaketet för iPhone');
  controls.state = structuredClone(iosPartial);
  const readsBefore = requests.length;
  await page.clock.runFor(1000);
  await expect.poll(() => requests.length).toBe(readsBefore + 1);
  await expect(page.getByRole('link', { name: 'Öppna i Expo Go', exact: true })).toBeVisible();
  expect(posts).toHaveLength(1); expect(errors).toEqual([]);
  await context.close();
});
