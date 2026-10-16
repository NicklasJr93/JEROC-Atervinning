import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error Node loads the real in-memory server model, which has no generated declarations.
import { createTestCar } from '../server/telematics/testcar-model.mjs';
// @ts-expect-error The production Codec 8E decoder is plain Node ESM.
import { decodeCodec8EFrame, encodeRecordAck } from '../server/telematics/codec8e.mjs';
import type { TestCarCommand, TestCarSnapshot, TestCarReceiver, TestCarReceiverRecord } from '../src/testcar/types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, locale: 'sv-SE' });
test.describe.configure({ mode: 'serial' });

/** HTTP/session security has its own server tests. Here every response comes
 * from the real isolated model, including its Codec 8E decoder and ACK path. */
async function fixture(page: Page, options: { sessionFailure?: boolean; failTiles?: boolean; separateReceiver?: boolean; receiverMode?: 'deferred' | 'unavailable' | 'immediate' } = {}) {
  let wallMs = Date.parse('2026-10-16T08:00:00.000Z');
  const controls = { sessionFailure: options.sessionFailure ?? false, failTiles: options.failTiles ?? false,
    uncertainCommand: false, holdCommand: undefined as { entered: () => void; gate: Promise<void> } | undefined,
    receiverMode: options.receiverMode ?? 'immediate' };
  const stored: Omit<TestCarReceiver, 'channel' | 'transport'> & { packetsReceived: number; distanceKm: number; trips: number } = {
    status: 'ready', durable: true, storage: 'sqlite', recordsStored: 0, packetsReceived: 0, distanceKm: 0, trips: 0,
    lastReceivedAt: null, lastRecord: null, recentRecords: [], lastError: null,
  };
  const waiting: { frame: Buffer; resolve: (ack: Buffer) => void }[] = [];
  const committed = new Map<string, TestCarReceiverRecord>();
  let receiverCalls = 0;
  function commit(frame: Buffer): Buffer {
    const { records } = decodeCodec8EFrame(frame) as { records: { at: string; gps: { latitude: number; longitude: number; speedKmh: number }; io: Record<number, string> }[] };
    for (const record of records) {
      const value: TestCarReceiverRecord = {
        at: record.at, lat: record.gps.latitude, lng: record.gps.longitude, speedKmh: record.gps.speedKmh,
        rpm: parseInt(record.io[36], 16), fuelPercent: parseInt(record.io[48], 16),
        coolantC: Buffer.from(record.io[32], 'hex').readInt8(), batteryVolts: parseInt(record.io[66], 16) / 1000,
        odometerMeters: parseInt(record.io[16], 16), ignition: record.io[239] === '01', movement: record.io[240] === '01',
      };
      committed.set(JSON.stringify(value), value);
    }
    stored.recordsStored = committed.size;
    stored.packetsReceived++;
    stored.status = 'ready'; stored.lastError = null; stored.lastReceivedAt = new Date(wallMs).toISOString();
    stored.recentRecords = [...committed.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-10);
    stored.lastRecord = stored.recentRecords.at(-1) ?? null;
    return encodeRecordAck(records.length) as Buffer;
  }
  const model = createTestCar({ now: () => new Date(wallMs), random: () => 0.5,
    ...(options.separateReceiver ? {
      receiverSnapshot: () => structuredClone(stored),
      receivePacket(frame: Buffer) {
        receiverCalls++;
        if (controls.receiverMode === 'unavailable') {
          stored.status = 'unavailable'; stored.lastError = 'Local receiver is unavailable';
          return Promise.reject(new Error(stored.lastError));
        }
        if (controls.receiverMode === 'deferred') return new Promise<Buffer>(resolve => waiting.push({ frame: Buffer.from(frame), resolve }));
        return commit(frame);
      },
    } : {}),
  }) as { snapshot(): TestCarSnapshot; command(value: TestCarCommand): TestCarSnapshot; tick(seconds?: number): TestCarSnapshot; close(): void };
  page.on('close', () => { model.close(); for (const item of waiting.splice(0)) item.resolve(encodeRecordAck(0) as Buffer); });
  const commands: TestCarCommand[] = [], requests: string[] = [], unexpected: string[] = [], errors: string[] = [], tiles: string[] = [];
  const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:5173').origin;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin && url.pathname.startsWith('/api/testcar/')) {
      requests.push(`${request.method()} ${url.pathname}`);
      if (url.pathname === '/api/testcar/session' && request.method() === 'GET') {
        if (controls.sessionFailure) return route.fulfill({ status: 503, json: { error: 'Local test session temporarily unavailable' } });
        return route.fulfill({ json: { csrfToken: 'local-testcar-csrf-token', car: model.snapshot() } });
      }
      if (url.pathname === '/api/testcar/state' && request.method() === 'GET') return route.fulfill({ json: { car: model.snapshot() } });
      if (url.pathname === '/api/testcar/command' && request.method() === 'POST') {
        expect(request.headers()['x-testcar-csrf']).toBe('local-testcar-csrf-token');
        const command = request.postDataJSON() as TestCarCommand;
        commands.push(command);
        try {
          const car = model.command(command), held = controls.holdCommand;
          controls.holdCommand = undefined;
          if (held) { held.entered(); await held.gate; }
          if (controls.uncertainCommand) {
            controls.uncertainCommand = false;
            return route.fulfill({ status: 503, json: { error: 'Local simulated response lost after commit' } });
          }
          return route.fulfill({ json: { car } });
        } catch (error) {
          const failure = error as { status?: number; code?: string; message?: string };
          return route.fulfill({ status: failure.status ?? 500, json: { error: failure.message, code: failure.code } });
        }
      }
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: 'Unexpected test-car endpoint' } });
    }
    if (url.hostname === 'tile.openstreetmap.org') {
      tiles.push(url.pathname);
      if (controls.failTiles) return route.abort('failed');
      // Transparent local tile keeps the application's own synthetic overview
      // visible. No external map service or production API is called by tests.
      return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64') });
    }
    if (url.origin !== origin || url.pathname.startsWith('/api/')) {
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  return { model, controls, commands, requests, unexpected, errors, tiles, stored, receiverCalls: () => receiverCalls,
    async commitNext() {
      const next = waiting.shift(); expect(next, 'The virtual FMC003 must have an outstanding packet').toBeDefined();
      next!.resolve(commit(next!.frame));
      await new Promise<void>(resolve => setImmediate(resolve));
    },
    advance(seconds: number) { wallMs += seconds * 1000; return model.tick(seconds); } };
}

const place = (page: Page) => page.locator('.testcar-current-place');
const destination = (page: Page, name: string) => page.locator('.testcar-destinations').getByRole('button', { name: new RegExp(`^${name} `) });
const receiver = (page: Page) => page.getByRole('region', { name: 'Mottagaren', exact: true });
const count = (page: Page, name: string) => {
  const labels: Record<string, RegExp> = { Mätpunkter: /^(?:Mätpunkter|Sparade mätpunkter)$/, Paket: /^(?:Paket|Kvitterade paket)$/, 'I kö': /^(?:I kö|Väntar i bilen)$/ };
  return receiver(page).locator('dl > div').filter({ has: page.getByText(labels[name] ?? name, { exact: true }) }).locator('dd');
};
async function refresh(page: Page) { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); }
function isolated(value: Awaited<ReturnType<typeof fixture>>) { expect(value.unexpected).toEqual([]); expect(value.errors).toEqual([]); }
async function start(page: Page) {
  await page.getByRole('button', { name: 'Starta bilen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Motor på', exact: true })).toBeDisabled();
}


test('egen testbil startar på Kontoret, kör till Kund 1 och visar den faktiska ankomstplatsen', async ({ page }, info) => {
  const car = await fixture(page);
  await page.goto('/testbil1');
  await expect(page.getByRole('heading', { name: 'Din digitala testbil', exact: true })).toBeVisible();
  await expect(place(page)).toContainText('Kontoret');
  await expect(destination(page, 'Kontoret')).toBeDisabled();
  await expect(destination(page, 'Kontoret')).toContainText('Du är redan här');
  await expect(page.getByRole('button', { name: 'Kör', exact: true })).toBeDisabled();
  await start(page);
  await destination(page, 'Kund 1').click();
  await page.getByRole('button', { name: 'Kör till Kund 1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pausa körning', exact: true })).toBeEnabled();
  car.advance(4); await refresh(page);
  await expect(page.getByRole('img', { name: /^Hastighet [1-9]\d* kilometer i timmen$/ })).toBeVisible();
  await expect(place(page)).toContainText('Längs vägen');
  await page.screenshot({ path: info.outputPath('testcar-driving-1440.png') });
  for (let seconds = 0; car.model.snapshot().mode === 'driving' && seconds < 120; seconds++) car.advance(1);
  const arrived = car.model.snapshot();
  expect(arrived.currentPlace.id).toBe('customer1');
  expect(arrived.stats.trips).toBe(1);
  expect(arrived.stats.distanceKm).toBeGreaterThan(0);
  await refresh(page);
  await expect(place(page)).toContainText('Kund 1');
  await expect(page.getByRole('heading', { name: 'Parkerad vid Kund 1', exact: true })).toBeVisible();
  await expect(destination(page, 'Kund 1')).toBeDisabled();
  await expect(destination(page, 'Kund 1')).toContainText('Du är redan här');
  await expect(page.getByRole('button', { name: 'Kör', exact: true })).toBeDisabled();
  await expect(count(page, 'Mätpunkter')).toHaveText(String(arrived.stats.recordsReceived));
  expect(car.commands.filter(value => value.action === 'drive')).toEqual([{ action: 'drive', destination: 'customer1' }]);
  isolated(car);
});

test('paus och fortsättning behåller samma resa medan motorstopp lämnar bilen längs vägen', async ({ page }) => {
  const car = await fixture(page);
  await page.goto('/testbil1'); await start(page);
  await destination(page, 'Kund 2').click();
  await page.getByRole('button', { name: 'Kör till Kund 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pausa körning', exact: true })).toBeEnabled();
  car.advance(10); await refresh(page);
  await expect(place(page)).toContainText('Längs vägen');
  const moving = car.model.snapshot();
  await page.getByRole('button', { name: 'Pausa körning', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pausad på väg till Kund 2', exact: true })).toBeVisible();
  car.advance(8); await refresh(page);
  expect(car.model.snapshot().currentPlace).toEqual(moving.currentPlace);
  expect(car.model.snapshot().telemetry.odometerKm).toBe(moving.telemetry.odometerKm);
  await expect(page.getByRole('img', { name: 'Hastighet 0 kilometer i timmen', exact: true })).toBeVisible();
  await expect(place(page)).toContainText('Längs vägen');
  await page.getByRole('button', { name: 'Fortsätt körning', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pausa körning', exact: true })).toBeEnabled();
  expect(car.model.snapshot().trips).toHaveLength(1);
  expect(car.model.snapshot().trips[0].id).toBe(moving.trips[0].id);
  car.advance(3); await refresh(page);
  await page.getByRole('button', { name: 'Stäng av', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Starta bilen', exact: true })).toBeEnabled();
  const stopped = car.model.snapshot();
  expect(stopped.engineOn).toBe(false); expect(stopped.currentPlace.id).toBeNull();
  expect(stopped.trips[0].completed).toBe(false);
  car.advance(10); await refresh(page);
  expect(car.model.snapshot().currentPlace).toEqual(stopped.currentPlace);
  await expect(place(page)).toContainText('Längs vägen');
  await expect(page.getByRole('button', { name: /^Kör(?: till .*)?$/ })).toBeDisabled();
  isolated(car);
});

test('förlorad täckning buffrar riktiga mätpunkter och återanslutning tömmer kön utan dubbelräkning', async ({ page }) => {
  const car = await fixture(page);
  await page.goto('/testbil1');
  await page.getByRole('button', { name: 'Ansluten. Simulera förlorad täckning', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ingen täckning. Återställ täckning', exact: true })).toBeVisible();
  await start(page); await destination(page, 'Hem').click();
  await page.getByRole('button', { name: 'Kör till Hem', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pausa körning', exact: true })).toBeEnabled();
  car.advance(20); await refresh(page);
  const offline = car.model.snapshot();
  expect(offline.stats.pendingRecords).toBeGreaterThan(10);
  await expect(count(page, 'Mätpunkter')).toHaveText('0');
  await expect(count(page, 'I kö')).toHaveText(String(offline.stats.pendingRecords));
  await expect(receiver(page)).toContainText('Bilen saknar täckning');
  await page.getByRole('button', { name: 'Ingen täckning. Återställ täckning', exact: true }).click();
  await expect(count(page, 'I kö')).toHaveText('0');
  const connected = car.model.snapshot();
  expect(connected.stats.recordsReceived).toBe(offline.stats.pendingRecords);
  expect(connected.stats.packetsReceived).toBeGreaterThan(0);
  await expect(count(page, 'Mätpunkter')).toHaveText(String(connected.stats.recordsReceived));
  await refresh(page);
  expect(car.model.snapshot().stats.recordsReceived).toBe(connected.stats.recordsReceived);
  expect(car.commands.filter(value => value.action === 'network')).toEqual([{ action: 'network', online: false }, { action: 'network', online: true }]);
  await page.getByRole('button', { name: 'Nollställ testbilen', exact: true }).click();
  expect(car.model.snapshot().stats.recordsReceived).toBe(connected.stats.recordsReceived);
  await page.getByRole('group', { name: 'Bekräfta nollställning', exact: true }).getByRole('button', { name: 'Ja, nollställ', exact: true }).click();
  await expect(place(page)).toContainText('Kontoret');
  await expect(count(page, 'Mätpunkter')).toHaveText('0'); await expect(count(page, 'Paket')).toHaveText('0');
  await expect(count(page, 'I kö')).toHaveText('0');
  isolated(car);
});

test('osäkert startsvar skickas en gång trots dubbeltryck och senaste serverläge visas utan automatisk omsändning', async ({ page }) => {
  const car = await fixture(page);
  await page.goto('/testbil1');
  const button = page.getByRole('button', { name: 'Starta bilen', exact: true });
  await expect(button).toBeEnabled();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  car.controls.holdCommand = { entered, gate }; car.controls.uncertainCommand = true;
  await button.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await started;
  expect(car.commands).toEqual([{ action: 'start' }]);
  await expect(page.getByRole('button', { name: 'Startar…', exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole('alert')).toContainText('Vi kunde inte bekräfta åtgärden');
  await expect(page.getByRole('button', { name: 'Motor på', exact: true })).toBeDisabled();
  await refresh(page);
  expect(car.commands).toEqual([{ action: 'start' }]);
  expect(car.model.snapshot().engineOn).toBe(true);
  isolated(car);
});

test.describe('mobil och återhämtning', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('nätfel kan hämtas om och en utebliven kartbakgrund blockerar inte mobilens bilkontroller', async ({ page }, info) => {
    const car = await fixture(page, { sessionFailure: true, failTiles: true });
    await page.goto('/testbil1');
    await expect(page.getByRole('heading', { name: 'Testbilen kunde inte hämtas', exact: true })).toBeVisible();
    const failedReads = car.requests.length;
    expect(car.commands).toEqual([]);
    car.controls.sessionFailure = false;
    await page.getByRole('button', { name: 'Försök igen', exact: true }).click();
    await expect(place(page)).toContainText('Kontoret');
    expect(car.requests.length).toBeGreaterThan(failedReads);
    await expect(page.getByText('Översiktskarta · simulerad resa', { exact: true })).toBeVisible();
    await expect.poll(() => car.tiles.length).toBeGreaterThan(0);
    await start(page); await destination(page, 'Kund 1').click();
    await page.getByRole('button', { name: 'Kör till Kund 1', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pausa körning', exact: true })).toBeEnabled();
    car.advance(5); await refresh(page);
    await expect(place(page)).toContainText('Längs vägen');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath('testcar-mobile-390.png'), fullPage: true });
    await page.getByRole('button', { name: 'Stäng av', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Starta bilen', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    isolated(car);
  });
});

test('separat mottagare visar bara committade mätpunkter medan ett Codec8E-paket väntar på kvittens', async ({ page }, info) => {
  const car = await fixture(page, { separateReceiver: true, receiverMode: 'deferred' });
  await page.goto('/testbil1'); await start(page);
  await destination(page, 'Kund 1').click();
  await page.getByRole('button', { name: 'Kör till Kund 1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pausa körning', exact: true })).toBeEnabled();
  car.advance(4); await refresh(page);
  expect(car.receiverCalls()).toBe(1); // Sampling continues, but the outstanding packet is never sent concurrently.
  const pending = car.model.snapshot().stats.pendingRecords;
  expect(pending).toBeGreaterThan(1);
  await expect(count(page, 'Mätpunkter')).toHaveText('0'); await expect(count(page, 'Paket')).toHaveText('0');
  await expect(count(page, 'I kö')).toHaveText(String(pending));
  await expect(receiver(page)).toContainText('Mätpunkter i kö');
  await expect(receiver(page)).not.toContainText('Sparat och kvitterat');
  await receiver(page).getByText('Senast lagrad data', { exact: false }).click();
  await expect(receiver(page)).toContainText('Inga mätpunkter har lagrats ännu');
  await expect(page.getByRole('table', { name: 'Senast lagrade syntetiska mätpunkter', exact: true })).toHaveCount(0);
  await car.commitNext(); await refresh(page);
  await expect(count(page, 'Mätpunkter')).toHaveText('1'); await expect(count(page, 'Paket')).toHaveText('1');
  await expect(receiver(page)).toContainText('Mätpunkter i kö');
  await expect(receiver(page)).not.toContainText('Sparat och kvitterat');
  const table = page.getByRole('table', { name: 'Senast lagrade syntetiska mätpunkter', exact: true });
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody tr').getByRole('cell').nth(1)).toHaveText('0 km/h');
  await expect(table.locator('tbody tr').getByRole('cell').nth(2)).toHaveText('780 rpm');
  expect(car.model.snapshot().telemetry.rpm).toBeGreaterThan(780);
  expect(car.model.snapshot().stats.pendingRecords).toBeGreaterThan(0);
  await expect(receiver(page)).toContainText('Separat tjänst');
  await expect(receiver(page)).toContainText('SQLite · beständig lagring');
  await page.screenshot({ path: info.outputPath('testcar-receiver-committed-1440.png'), fullPage: true });
  car.controls.receiverMode = 'immediate';
  await car.commitNext(); await refresh(page);
  await expect(count(page, 'I kö')).toHaveText('0');
  await expect(receiver(page)).toContainText('Sparat och kvitterat');
  isolated(car);
});

test.describe('separat mottagare på mobil', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('mottagaravbrott skiljs från bilens täckning och återhämtning visar lagrade telemetrirader', async ({ page }, info) => {
    const car = await fixture(page, { separateReceiver: true, receiverMode: 'unavailable' });
    await page.goto('/testbil1'); await start(page);
    await expect(receiver(page)).toContainText('Mottagaren är nere');
    await expect(count(page, 'Mätpunkter')).toHaveText('0'); await expect(count(page, 'I kö')).toHaveText('1');
    await expect(page.getByRole('button', { name: 'Ansluten. Simulera förlorad täckning', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Ansluten. Simulera förlorad täckning', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Ingen täckning. Återställ täckning', exact: true })).toBeVisible();
    await expect(receiver(page)).toContainText('Mottagaren är nere');
    const attempts = car.receiverCalls();
    car.controls.receiverMode = 'immediate'; car.stored.status = 'ready'; car.stored.lastError = null;
    await refresh(page);
    await expect(receiver(page)).toContainText('Bilen saknar täckning');
    await expect(receiver(page)).not.toContainText('Mottagaren är nere');
    expect(car.receiverCalls()).toBe(attempts);
    await expect(count(page, 'I kö')).toHaveText('1');
    await page.getByRole('button', { name: 'Ingen täckning. Återställ täckning', exact: true }).click();
    await expect(count(page, 'I kö')).toHaveText('0');
    await expect(count(page, 'Mätpunkter')).toHaveText('1');
    await expect(receiver(page)).toContainText('Sparat och kvitterat');
    await receiver(page).getByText('Senast lagrad data', { exact: false }).click();
    const table = page.getByRole('table', { name: 'Senast lagrade syntetiska mätpunkter', exact: true });
    await expect(table.getByRole('columnheader')).toHaveText(['Mättid', 'Hastighet', 'Varvtal']);
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.locator('tbody tr').getByRole('cell').nth(2)).toHaveText('780 rpm');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath('testcar-receiver-mobile-390.png'), fullPage: true });
    isolated(car);
  });
});
