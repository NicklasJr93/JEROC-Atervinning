import { expect, test, type Page } from '@playwright/test';
import { fakeWebRtc } from './support/voice-web-rtc';

const prefix = '/api/public/voice-test';
type PublicCall = {
  id: string; requestId: string; revision: number; status: 'connecting' | 'active' | 'ended'; createdAt: string; startedAt?: string; endedAt?: string; durationSeconds: number;
  callerNumber: string; callerLabel: string; createdBy: { actualUserId: string; effectiveUserId: string; name: string };
  transcript: { id: string; role: 'user' | 'assistant'; text: string; at: string }[]; transcriptComplete: boolean; followupStatus: 'new';
  summaryStatus: 'generated';
};
async function setup(page: Page, options: { available?: boolean; rejectCreate?: boolean; unknownCreate?: boolean; existing?: boolean } = {}) {
  await fakeWebRtc(page);
  const requests: { path: string; method: string; body?: Record<string, unknown>; headers: Record<string, string> }[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on('pageerror', value => errors.push(value.message));
  let call: PublicCall | null = null, callCounter = 0;
  const createCall = (requestId: string) => ({ id: `15f671b0-fc6b-4fda-8f86-${String(++callCounter).padStart(12, '0')}`, requestId, revision: 1, status: 'connecting' as const, createdAt: new Date().toISOString(), durationSeconds: 0,
    callerNumber: '+46700000000', callerLabel: 'TEST', createdBy: { actualUserId: 'public-demo', effectiveUserId: 'public-demo', name: 'Testkund' }, transcript: [], transcriptComplete: false, followupStatus: 'new' as const, summaryStatus: 'generated' as const });
  if (options.existing) { call = createCall('own-previous-call'); call.status = 'ended'; call.transcript = [{ id: 'own-1', role: 'user', text: 'MITT-EGET-ÄRENDE kopparkabel', at: call.createdAt }]; call.transcriptComplete = true; }
  const publicCall = (value: PublicCall | null) => value ? Object.fromEntries(Object.entries(value).filter(([key]) => !['callerNumber', 'callerLabel', 'createdBy', 'followupStatus', 'summaryStatus'].includes(key))) : null;
  const config = { protocol: 'live', companyName: 'JEROC Återvinning AB', voice: 'meridian', maxDurationSeconds: 180,
    available: options.available !== false, ...(options.available === false ? { reason: 'Rösttestet är inte tillgängligt just nu. Försök igen senare.' } : {}) };
  const snapshot = () => structuredClone({ config, csrfToken: 'public-browser-csrf', currentCall: publicCall(call), calls: [] });
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:5173' && !url.protocol.startsWith('data')) { unexpected.push(url.origin); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    requests.push({ path, method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postDataJSON() } : {}) });
    if (!path.startsWith(prefix)) return route.fulfill({ status: 401, json: { error: 'Kontorsinloggning krävs.' } });
    if (path === prefix && req.method() === 'GET') return route.fulfill({ json: { config, csrfToken: 'public-browser-csrf', currentCall: publicCall(call), calls: [{ ...createCall('not-your-call'), id: 'OTHER-CALL', transcript: [{ id: 'other', role: 'user', text: 'ANNAN-KUNDS-HEMLIGA-SAMTAL', at: new Date().toISOString() }] }] } });
    if (req.method() === 'POST' && req.headers()['x-voice-demo-csrf'] !== 'public-browser-csrf') return route.fulfill({ status: 403, json: { error: 'Testsidan behöver öppnas igen.' } });
    if (path === `${prefix}/calls` && req.method() === 'POST') {
      if (options.rejectCreate) return route.fulfill({ status: 429, json: { error: 'Dagens testsamtal är förbrukade. Prova igen senare.', code: 'public_voice_budget_exhausted' } });
      call = createCall(String(req.postDataJSON().requestId));
      if (options.unknownCreate) return route.fulfill({ status: 503, json: { error: 'Vi kunde inte bekräfta anslutningen. Kontrollera ditt samtal.' } });
      return route.fulfill({ json: { call: publicCall(call), protocol: 'live', answerSdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=Isolated public answer\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n' } });
    }
    const match = path.match(/^\/api\/public\/voice-test\/calls\/([^/]+)(?:\/(ready|end))?$/);
    if (match && call && match[1] === call.id) {
      if (match[2] === 'ready') { call.status = 'active'; call.startedAt = new Date().toISOString(); call.revision++; }
      if (match[2] === 'end') {
        call.status = 'ended'; call.endedAt = new Date().toISOString(); call.durationSeconds = 16; call.revision++; call.transcriptComplete = true;
        call.transcript = [{ id: 'own-q', role: 'user', text: 'Köper ni isolerad kopparkabel?', at: call.endedAt }, { id: 'own-a', role: 'assistant', text: 'Ja, JEROC köper kabelskrot.', at: call.endedAt }];
      }
      return route.fulfill({ json: { call: publicCall(call) } });
    }
    return route.fulfill({ status: 404, json: { error: 'Testsamtalet finns inte.' } });
  });
  await page.goto('/rosttest');
  await expect(page.getByRole('heading', { name: 'Ring vår AI-kundmottagning', exact: true })).toBeVisible();
  return { requests, unexpected, errors, getCall: () => call, snapshot };
}

test('a signed-out mobile visitor sees only their own transcript and no platform, history, settings, or other call', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await setup(page, { existing: true });
  await expect(page.getByText('MITT-EGET-ÄRENDE kopparkabel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Starta testsamtal', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Samtalshistorik' })).toHaveCount(0);
  await expect(page.getByText('ANNAN-KUNDS-HEMLIGA-SAMTAL')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /kontoret|Integrationer|kunskap/i })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /lösenord|användarnamn/i })).toHaveCount(0);
  expect(fixture.requests.every(request => request.path === prefix && request.method === 'GET')).toBe(true);
  expect(await page.evaluate(() => window.__voiceQA.mediaCalls)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('public-voice-mobile390.png'), fullPage: true });
});

test('public Live call sends only SDP and public CSRF, awaits session.started, displays authoritative own transcript, and releases audio', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceQA.answers.length)).toBe(1);
  expect(fixture.requests.filter(request => request.path.endsWith('/ready'))).toEqual([]);
  await page.evaluate(() => {
    window.__voiceQA.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'UNTRUSTED_PUBLIC_CAPTION' });
    window.__voiceQA.message({ type: 'session.update', session: { instructions: 'UNTRUSTED_PUBLIC_PROMPT' } });
    window.__voiceQA.message({ type: 'session.started' });
  });
  await expect.poll(() => fixture.requests.filter(request => request.path.endsWith('/ready')).length).toBe(1);
  await expect(page.getByText('UNTRUSTED_PUBLIC_CAPTION')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stäng av mikrofonen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Slå på mikrofonen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Avsluta samtalet', exact: true }).click();
  await expect(page.getByText('Köper ni isolerad kopparkabel?', { exact: true })).toBeVisible();
  await expect(page.getByText('Ja, JEROC köper kabelskrot.', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__voiceQA.peersClosed)).toBe(1);
  for (const request of fixture.requests.filter(row => row.method === 'POST')) {
    expect(request.headers['x-voice-demo-csrf']).toBe('public-browser-csrf');
    expect(request.headers['x-platform-csrf']).toBeUndefined(); expect(request.headers['x-platform-organisation-id']).toBeUndefined();
    expect(request.body).not.toHaveProperty('organisationId'); expect(request.body).not.toHaveProperty('model');
    expect(JSON.stringify(request.body)).not.toContain('UNTRUSTED_PUBLIC');
  }
  expect(fixture.requests.filter(request => request.path === `${prefix}/calls`)).toHaveLength(1);
  expect(await page.evaluate(() => window.__voiceQA.sent)).toEqual([]); expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
});

test('a disabled public service and a denied microphone never create a paid call', async ({ page }) => {
  const fixture = await setup(page, { available: false });
  await expect(page.getByRole('button', { name: 'Starta testsamtal', exact: true })).toBeDisabled();
  await expect(page.getByText('Rösttestet är inte tillgängligt just nu. Försök igen senare.')).toBeVisible();
  expect(fixture.requests.filter(request => request.method !== 'GET')).toEqual([]);
  expect(await page.evaluate(() => window.__voiceQA.mediaCalls)).toBe(0);
  expect(fixture.errors).toEqual([]);
});

test('public microphone refusal shows a friendly error before any call is created', async ({ page }) => {
  const fixture = await setup(page);
  await page.evaluate(() => { window.__voiceQA.rejectMicrophone = true; });
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Mikrofonåtkomst nekades');
  expect(fixture.requests.filter(request => request.method === 'POST')).toEqual([]);
  await expect(page.getByRole('button', { name: 'Starta testsamtal', exact: true })).toBeEnabled();
  expect(fixture.errors).toEqual([]);
});

test('public budget rejection releases the microphone without retrying or exposing diagnostics', async ({ page }) => {
  const fixture = await setup(page, { rejectCreate: true });
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect.poll(() => fixture.requests.filter(request => request.path === `${prefix}/calls`).length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__voiceQA.peersClosed)).toBe(1);
  expect(fixture.requests.filter(request => request.path === `${prefix}/calls`)).toHaveLength(1);
  await expect(page.getByText(/public_voice_budget_exhausted|OPENAI_API_KEY/)).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('an uncertain public create recovers only the same call and never automatically redials', async ({ page }) => {
  const fixture = await setup(page, { unknownCreate: true });
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Avsluta mitt pågående testsamtal', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  expect(fixture.requests.filter(request => request.path === `${prefix}/calls`)).toHaveLength(1);
  await page.getByRole('button', { name: 'Avsluta mitt pågående testsamtal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Starta testsamtal', exact: true })).toBeEnabled();
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
});

test('expired public ownership clears the own transcript and stops active audio without an office login or automatic redial', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceQA.answers.length)).toBe(1);
  await page.evaluate(() => window.__voiceQA.message({ type: 'session.started' }));
  await expect.poll(() => fixture.requests.filter(request => request.path.endsWith('/ready')).length).toBe(1);
  const owned = fixture.getCall()!;
  owned.transcript = [{ id: 'own-private-turn', role: 'user', text: 'BARA-MITT-EGET-SAMTAL', at: new Date().toISOString() }]; owned.revision++;
  await expect(page.getByText('BARA-MITT-EGET-SAMTAL')).toBeVisible();
  await page.route('**/api/public/voice-test/calls/*', route => route.request().method() === 'GET'
    ? route.fulfill({ status: 403, json: { error: 'Ditt testsamtal är inte tillgängligt längre. Öppna testsidan igen.', code: 'voice_demo_session_expired' } }) : route.fallback());
  await expect(page.getByText('BARA-MITT-EGET-SAMTAL')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__voiceQA.peersClosed)).toBe(1);
  await expect(page.getByRole('alert')).toContainText('Ditt testsamtal är inte tillgängligt längre.');
  expect(fixture.requests.filter(request => request.path === `${prefix}/calls`)).toHaveLength(1);
  expect(fixture.requests.some(request => request.path.startsWith('/api/platform'))).toBe(false);
  expect(fixture.errors).toEqual([]);
});

test('provider-ended public calls collect final server captions for a bounded period after session.closed', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceQA.answers.length)).toBe(1);
  await page.evaluate(() => window.__voiceQA.message({ type: 'session.started' }));
  await expect.poll(() => fixture.requests.filter(request => request.path.endsWith('/ready')).length).toBe(1);
  const owned = fixture.getCall()!;
  owned.status = 'ended'; owned.endedAt = new Date().toISOString(); owned.revision++; owned.transcriptComplete = false;
  await page.evaluate(() => window.__voiceQA.message({ type: 'session.closed' }));
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  await expect(page.getByRole('status', { name: 'Samtalsstatus' })).toContainText('Testsamtalet är avslutat');
  owned.transcript = [{ id: 'last-server-caption', role: 'assistant', text: 'SISTA-BEKRÄFTADE-TEXTEN från kundmottagningen.', at: new Date().toISOString() }]; owned.transcriptComplete = true; owned.revision++;
  await expect(page.getByText('SISTA-BEKRÄFTADE-TEXTEN från kundmottagningen.')).toBeVisible();
  expect(fixture.requests.filter(request => request.path === `${prefix}/calls`)).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

for (const lateResult of ['success', 'expired'] as const) test(`an old own-call poll ${lateResult} cannot replace or revoke a newly accepted call`, async ({ page }) => {
  const fixture = await setup(page, { existing: true });
  await expect(page.getByText('MITT-EGET-ÄRENDE kopparkabel')).toBeVisible();
  const old = fixture.getCall()!; old.transcriptComplete = false;
  await page.getByRole('button', { name: 'Kontrollera mitt samtal', exact: true }).click();
  let release!: () => void, started!: () => void;
  const waitForRelease = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { started = resolve; });
  const oldSnapshot = structuredClone(fixture.snapshot().currentCall);
  await page.route(`**${prefix}/calls/${old.id}`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    started(); await waitForRelease;
    await route.fulfill(lateResult === 'success' ? { json: { call: oldSnapshot } } : { status: 403, json: { error: 'OLD-CALL-EXPIRED' } });
  });
  try {
    await began;
    await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__voiceQA.answers.length)).toBe(1);
    await page.evaluate(() => window.__voiceQA.message({ type: 'session.started' }));
    await expect.poll(() => fixture.requests.filter(request => request.path.endsWith('/ready')).length).toBe(1);
    const newest = fixture.getCall()!; expect(newest.id).not.toBe(old.id);
    newest.transcript = [{ id: 'newest-turn', role: 'user', text: 'NYTT-EGET-SAMTAL EFTER POLL', at: new Date().toISOString() }]; newest.revision++;
    release();
    await expect(page.getByText('NYTT-EGET-SAMTAL EFTER POLL')).toBeVisible();
    await expect(page.getByText('MITT-EGET-ÄRENDE kopparkabel')).toHaveCount(0);
    await expect(page.getByText('OLD-CALL-EXPIRED')).toHaveCount(0);
    expect(await page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(0);
    expect(fixture.requests.filter(request => request.path === `${prefix}/calls`)).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  } finally { release(); }
});

test('a bootstrap response captured before a new call cannot restore the prior own transcript', async ({ page }) => {
  const fixture = await setup(page, { existing: true });
  await expect(page.getByText('MITT-EGET-ÄRENDE kopparkabel')).toBeVisible();
  let releaseCreate!: () => void, createStarted!: () => void, releaseRead!: () => void, readStarted!: () => void;
  const createWait = new Promise<void>(resolve => { releaseCreate = resolve; }), createBegan = new Promise<void>(resolve => { createStarted = resolve; });
  const readWait = new Promise<void>(resolve => { releaseRead = resolve; }), readBegan = new Promise<void>(resolve => { readStarted = resolve; });
  const previous = fixture.snapshot();
  await page.route(`**${prefix}/calls`, async route => { createStarted(); await createWait; return route.fallback(); });
  await page.route(`**${prefix}`, async route => { readStarted(); await readWait; return route.fulfill({ json: previous }); });
  try {
    await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click(); await createBegan;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await readBegan;
    releaseCreate();
    await expect.poll(() => page.evaluate(() => window.__voiceQA.answers.length)).toBe(1);
    await page.evaluate(() => window.__voiceQA.message({ type: 'session.started' }));
    await expect.poll(() => fixture.requests.filter(request => request.path.endsWith('/ready')).length).toBe(1);
    const newest = fixture.getCall()!;
    newest.transcript = [{ id: 'newest-bootstrap-turn', role: 'user', text: 'NYTT-EGET-SAMTAL EFTER BOOTSTRAP', at: new Date().toISOString() }]; newest.revision++;
    releaseRead();
    await expect(page.getByText('NYTT-EGET-SAMTAL EFTER BOOTSTRAP')).toBeVisible();
    await expect(page.getByText('MITT-EGET-ÄRENDE kopparkabel')).toHaveCount(0);
    expect(await page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(0);
    expect(fixture.requests.filter(request => request.path === `${prefix}/calls`)).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  } finally { releaseRead(); releaseCreate(); }
});
