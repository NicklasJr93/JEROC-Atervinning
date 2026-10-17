import { test, expect, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { fakeWebRtc } from './support/voice-web-rtc';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false, locale: 'sv-SE' });

type Call = {
  id: string; requestId: string; revision: number; status: 'connecting' | 'active' | 'ended' | 'failed';
  createdAt: string; startedAt?: string; endedAt?: string; durationSeconds: number;
  callerNumber: string; callerLabel: string;
  createdBy: { actualUserId: string; effectiveUserId: string; name: string };
  transcript: { id: string; role: 'user' | 'assistant'; text: string; at: string }[];
  summary: string; summaryStatus: 'pending' | 'generated'; transcriptComplete: boolean; followupStatus: 'new' | 'in_progress' | 'done';
};
async function setup(page: Page, { configured = true, connectionOk = true, failAfterReservation = false, protocol }: { configured?: boolean; connectionOk?: boolean; failAfterReservation?: boolean; protocol?: 'live' } = {}) {
  await fakeWebRtc(page);
  const admin = seedOffice().users.find(user => user.id === 'admin')!;
  let companyId = 'voice-fixture', generation = 7, revision = 0;
  const calls: Call[] = [], owners = new Map<string, string>(), requests: { path: string; method: string; body?: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const unexpected: string[] = [], pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const config = { enabled: true, keyPresent: configured, model: protocol === 'live' ? 'gpt-live-1' : 'gpt-realtime-mini', ...(protocol ? { protocol } : {}), callerNumber: '+46700000000', callerLabel: 'TEST', maxDurationSeconds: 180,
    available: configured, ...(configured ? {} : { reason: 'OPENAI_API_KEY saknas på servern.' }) };
  const state = () => { const visible = calls.filter(call => owners.get(call.id) === companyId); return { config, calls: visible, currentCall: visible.find(call => ['connecting', 'active'].includes(call.status)) ?? null, revision }; };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:5173' && !url.protocol.startsWith('data')) { unexpected.push(url.origin); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/platform/session') return route.fulfill({ json: {
      enabled: true, authenticated: true, actor: { id: 'platform-voice-fixture', username: 'voice-fixture', name: 'Rösttestets administratör', platformAdmin: true },
      actualUser: admin, user: admin, company: { id: companyId, name: 'Isolerat röstprov', organisationNumber: '5593593626', status: 'active' },
      organisationId: companyId, effectiveUserId: admin.id, isSupportSession: false, mustChangePassword: false, csrfToken: 'voice-fixture-csrf', generation, companies: [],
    } });
    const entry = { path, method: request.method(), headers: request.headers(), ...(request.postData() ? { body: request.postDataJSON() as Record<string, unknown> } : {}) };
    requests.push(entry);
    if (path.startsWith('/api/voice-test') && request.headers()['x-platform-organisation-id'] !== companyId)
      return route.fulfill({ status: 409, json: { error: 'Bolaget har ändrats.', code: 'platform_context_changed' } });
    if (path === '/api/voice-test' && request.method() === 'GET') return route.fulfill({ json: state() });
    if (path === '/api/voice-test/connection-test') return route.fulfill(connectionOk
      ? { json: { ok: true, model: config.model, message: 'Serveranslutningen är kontrollerad.', checkedAt: new Date().toISOString() } }
      : { status: 503, json: { error: 'Leverantörens anslutningstest misslyckades.', code: 'voice_provider_unavailable' } });
    if (path === '/api/voice-test/calls' && request.method() === 'POST') {
      const now = new Date().toISOString();
      const call: Call = { id: `e07661a4-9cb4-46fb-a706-${String(calls.length + 1).padStart(12, '0')}`, requestId: String(entry.body?.requestId), revision: 1, status: 'connecting', createdAt: now, durationSeconds: 0,
        callerNumber: config.callerNumber, callerLabel: 'TEST', createdBy: { actualUserId: admin.id, effectiveUserId: admin.id, name: 'Rösttestets administratör' },
        transcript: [], transcriptComplete: false, summary: '', summaryStatus: 'pending', followupStatus: 'new' };
      calls.unshift(call); owners.set(call.id, companyId); revision++;
      if (failAfterReservation) return route.fulfill({ status: 503, json: { error: 'Svaret försvann efter att testsamtalet reserverats.' } });
      return route.fulfill({ json: { call, ...(protocol ? { protocol } : {}), answerSdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=Isolated answer\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n' } });
    }
    const match = path.match(/^\/api\/voice-test\/calls\/([^/]+)(?:\/(ready|end|status))?$/);
    if (match) {
      const call = calls.find(value => value.id === decodeURIComponent(match[1]) && owners.get(value.id) === companyId);
      if (!call) return route.fulfill({ status: 404, json: { error: 'Samtalet finns inte.' } });
      if (match[2] === 'ready') { call.status = 'active'; call.startedAt = new Date().toISOString(); call.revision++; }
      if (match[2] === 'end') {
        call.status = 'ended'; call.endedAt = new Date().toISOString(); call.durationSeconds = 18; call.revision++;
        call.transcript = [{ id: 'server-user-1', role: 'user', text: 'Jag vill boka hämtning av skrot på tisdag.', at: call.endedAt },
          { id: 'server-assistant-1', role: 'assistant', text: 'Jag lämnar önskemålet till kontoret för uppföljning.', at: call.endedAt }];
        call.summary = 'Kunden önskar skrothämtning på tisdag. Kontoret behöver återkomma.';
        call.summaryStatus = 'generated'; call.transcriptComplete = true;
      }
      if (match[2] === 'status') { call.followupStatus = entry.body?.status as Call['followupStatus']; call.revision++; }
      return route.fulfill({ json: { call } });
    }
    return route.fulfill({ status: 503, json: { error: 'Denna tjänst ingår inte i det isolerade röstprovet.' } });
  });
  await page.goto('/kontor/rosttest');
  await expect(page.getByRole('heading', { name: 'AI-kundmottagning', exact: true })).toBeVisible();
  return { calls, requests, unexpected, pageErrors, config,
    switchScope: async () => { companyId = 'voice-other-company'; generation++; await page.evaluate(() => window.dispatchEvent(new Event('scrappilot:check-platform-session'))); },
    finishServerCall: () => { const call = calls[0]; call.status = 'ended'; call.endedAt = new Date().toISOString(); call.revision++; call.summaryStatus = 'generated'; call.transcriptComplete = true; revision++; },
  };
}

test('unconfigured server keeps the desktop test read-only and never requests microphone or provider calls', async ({ page }) => {
  const fixture = await setup(page, { configured: false });
  await expect(page.getByText(/OPENAI_API_KEY saknas/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Starta testsamtal', exact: true })).toBeDisabled();
  expect(fixture.requests.filter(request => request.method !== 'GET')).toEqual([]);
  expect(await page.evaluate(() => window.__voiceQA.mediaCalls)).toBe(0);
  expect(fixture.unexpected).toEqual([]); expect(fixture.pageErrors).toEqual([]);
});

test('mobile call sends actual SDP, treats data channel text as untrusted, and stores server follow-up after ending', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect.poll(() => fixture.requests.filter(request => request.path.endsWith('/ready')).length).toBe(1);
  expect(fixture.requests.find(request => request.path === '/api/voice-test/calls')?.body).toMatchObject({ sdp: expect.stringContaining('Isolated voice browser test'), requestId: expect.stringMatching(/^[a-f0-9-]{36}$/i) });
  expect(await page.evaluate(() => window.__voiceQA.answers)).toEqual([expect.stringContaining('Isolated answer')]);
  await page.evaluate(() => {
    window.__voiceQA.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'CLIENT_ONLY_FAKE_TEXT' });
    window.__voiceQA.message({ type: 'response.output_audio_transcript.done', transcript: 'CLIENT_ONLY_FAKE_TEXT' });
  });
  await expect(page.getByText('CLIENT_ONLY_FAKE_TEXT')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stäng av mikrofonen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Slå på mikrofonen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Avsluta samtalet', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__voiceQA.peersClosed)).toBe(1);
  await expect(page.getByText('Jag vill boka hämtning av skrot på tisdag.', { exact: true })).toBeVisible();
  await expect(page.getByText(fixture.calls[0].summary, { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Uppföljningsstatus', exact: true }).selectOption('in_progress');
  await expect.poll(() => fixture.calls[0].followupStatus).toBe('in_progress');
  const mutations = fixture.requests.filter(request => request.method === 'POST');
  for (const request of mutations) {
    expect(request.headers['x-platform-csrf']).toBe('voice-fixture-csrf');
    expect(request.headers['x-platform-generation']).toBe('7');
    expect(request.headers['x-platform-organisation-id']).toBe('voice-fixture');
    expect(JSON.stringify(request.body)).not.toContain('CLIENT_ONLY_FAKE_TEXT');
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(fixture.unexpected).toEqual([]); expect(fixture.pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('voice-mobile390.png'), fullPage: true });
});

test('microphone rejection never opens a billable call and leaves a clear recoverable error', async ({ page }) => {
  const fixture = await setup(page);
  await page.evaluate(() => { window.__voiceQA.rejectMicrophone = true; });
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /Mikrofonåtkomst nekades/ })).toBeVisible();
  expect(fixture.requests.filter(request => request.path === '/api/voice-test/calls' && request.method === 'POST')).toEqual([]);
  expect(await page.evaluate(() => window.__voiceQA.peersClosed)).toBe(await page.evaluate(() => window.__voiceQA.peersCreated));
  await expect(page.getByRole('button', { name: 'Starta testsamtal', exact: true })).toBeEnabled();
  expect(fixture.pageErrors).toEqual([]);
});

test('connection diagnostics show a provider failure without creating a call or requesting microphone', async ({ page }) => {
  const fixture = await setup(page, { connectionOk: false });
  await page.getByRole('button', { name: 'Kontrollera AI-anslutning', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Leverantörens anslutningstest misslyckades.');
  expect(fixture.requests.filter(request => request.path === '/api/voice-test/connection-test')).toHaveLength(1);
  expect(fixture.requests.filter(request => request.path === '/api/voice-test/calls' && request.method === 'POST')).toEqual([]);
  expect(await page.evaluate(() => window.__voiceQA.mediaCalls)).toBe(0);
  await expect(page.getByText('Serveranslutningen är kontrollerad.')).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]); expect(fixture.pageErrors).toEqual([]);
});

test('a company/session change closes the active peer and cannot keep background audio running', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect.poll(() => fixture.requests.filter(request => request.path.endsWith('/ready')).length).toBe(1);
  await fixture.switchScope();
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__voiceQA.peersClosed)).toBe(1);
  await expect(page.getByRole('button', { name: 'Starta testsamtal', exact: true })).toBeVisible();
  expect(fixture.requests.filter(request => request.path === '/api/voice-test/calls' && request.method === 'POST')).toHaveLength(1);
  expect(fixture.pageErrors).toEqual([]);
});

test('a failed WebRTC connection stops tracks and ends the server call instead of showing a healthy conversation', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect.poll(() => fixture.requests.filter(request => request.path.endsWith('/ready')).length).toBe(1);
  await page.evaluate(() => window.__voiceQA.disconnect());
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  await expect.poll(() => fixture.requests.filter(request => request.path.endsWith('/end')).length).toBe(1);
  await expect(page.getByRole('alert')).toContainText(/anslutning|samtal|förbindelse/i);
  await expect(page.getByRole('button', { name: 'Avsluta samtalet', exact: true })).toHaveCount(0);
  expect(fixture.pageErrors).toEqual([]);
});

test('an uncertain create reconciles the existing server call without automatically redialling', async ({ page }) => {
  const fixture = await setup(page, { failAfterReservation: true });
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Avsluta pågående testsamtal', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  await page.getByRole('button', { name: 'Uppdatera samtal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Avsluta pågående testsamtal', exact: true })).toBeVisible();
  expect(fixture.requests.filter(request => request.path === '/api/voice-test/calls' && request.method === 'POST')).toHaveLength(1);
  expect(fixture.calls).toHaveLength(1);
  await page.getByRole('button', { name: 'Avsluta pågående testsamtal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Starta testsamtal', exact: true })).toBeEnabled();
  expect(fixture.unexpected).toEqual([]); expect(fixture.pageErrors).toEqual([]);
});

test('late microphone permission after company change stops the returned track and cannot create an old-scope call', async ({ page }) => {
  const fixture = await setup(page);
  await page.evaluate(() => { window.__voiceQA.delayMicrophone = true; });
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceQA.mediaCalls)).toBe(1);
  await fixture.switchScope();
  await expect(page.getByRole('button', { name: 'Starta testsamtal', exact: true })).toBeVisible();
  await page.evaluate(() => window.__voiceQA.resolveMicrophone());
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  expect(fixture.requests.filter(request => request.path === '/api/voice-test/calls' && request.method === 'POST')).toEqual([]);
  expect(await page.evaluate(() => window.__voiceQA.peersClosed)).toBe(await page.evaluate(() => window.__voiceQA.peersCreated));
  expect(fixture.pageErrors).toEqual([]);
});

test('a terminal call in full refresh closes local audio even when currentCall becomes null', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect.poll(() => fixture.requests.filter(request => request.path.endsWith('/ready')).length).toBe(1);
  fixture.finishServerCall();
  await page.getByRole('button', { name: 'Uppdatera samtal', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__voiceQA.peersClosed)).toBe(1);
  await expect(page.getByRole('button', { name: 'Starta testsamtal', exact: true })).toBeEnabled();
  expect(fixture.requests.filter(request => request.path === '/api/voice-test/calls' && request.method === 'POST')).toHaveLength(1);
  expect(fixture.pageErrors).toEqual([]);
});

test('a forbidden call poll clears private text and a delayed older full read cannot restore it', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect.poll(() => fixture.requests.filter(request => request.path.endsWith('/ready')).length).toBe(1);
  const privateText = 'PRIVAT-RÖSTJOURNAL: återkom till provkunden om skrothämtningen.';
  const call = fixture.calls[0];
  call.transcript = [{ id: 'server-private-turn', role: 'user', text: privateText, at: new Date().toISOString() }];
  call.revision++;
  await page.getByRole('button', { name: 'Uppdatera samtal', exact: true }).click();
  await expect(page.getByText(privateText, { exact: true })).toBeVisible();
  const stale = structuredClone({ config: fixture.config, calls: fixture.calls, currentCall: call, revision: 1 });
  let releaseRead!: () => void, beginRead!: () => void, finishRead!: () => void;
  const released = new Promise<void>(resolve => { releaseRead = resolve; });
  const started = new Promise<void>(resolve => { beginRead = resolve; });
  const finished = new Promise<void>(resolve => { finishRead = resolve; });
  await page.route('**/api/voice-test', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    beginRead(); await released;
    try { await route.fulfill({ json: stale }); } catch { /* The old read should be aborted when permission is revoked. */ }
    finally { finishRead(); }
  });
  try {
    await page.getByRole('button', { name: 'Uppdatera samtal', exact: true }).click();
    await started;
    await page.route('**/api/voice-test/calls/*', route => route.request().method() === 'GET'
      ? route.fulfill({ status: 403, json: { error: 'Du saknar nu åtkomst till röstjournalen.', code: 'voice_test_forbidden' } })
      : route.fallback());
    await expect(page.getByText(privateText, { exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__voiceQA.peersClosed)).toBe(1);
    releaseRead(); await finished;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText(privateText, { exact: true })).toHaveCount(0);
    expect(fixture.requests.filter(request => request.path === '/api/voice-test/calls' && request.method === 'POST')).toHaveLength(1);
    expect(fixture.pageErrors).toEqual([]);
  } finally { releaseRead(); }
});

test('Live waits for complete ICE and session.started, sends no commands, and closes local media on session.closed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await setup(page, { protocol: 'live' });
  await page.evaluate(() => { window.__voiceQA.delayIce = true; });
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceQA.iceState())).toBe('gathering');
  expect(fixture.requests.filter(row => row.path === '/api/voice-test/calls' && row.method === 'POST')).toEqual([]);
  await page.evaluate(() => window.__voiceQA.completeIce());
  await expect.poll(() => page.evaluate(() => window.__voiceQA.answers.length)).toBe(1);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const create = fixture.requests.filter(row => row.path === '/api/voice-test/calls' && row.method === 'POST');
  expect(create).toHaveLength(1);
  expect(create[0].body?.sdp).toContain('a=candidate:qa');
  expect(fixture.requests.filter(row => row.path.endsWith('/ready'))).toEqual([]);
  await page.evaluate(() => {
    window.__voiceQA.message({ type: 'session.created' });
    window.__voiceQA.message({ type: 'session.updated' });
    window.__voiceQA.message({ type: 'session.update', session: { instructions: 'UNTRUSTED_LIVE_MESSAGE' } });
    window.__voiceQA.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'UNTRUSTED_LIVE_MESSAGE' });
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(fixture.requests.filter(row => row.path.endsWith('/ready'))).toEqual([]);
  await expect(page.getByText('UNTRUSTED_LIVE_MESSAGE', { exact: false })).toHaveCount(0);
  await page.evaluate(() => window.__voiceQA.message({ type: 'session.started' }));
  await expect.poll(() => fixture.requests.filter(row => row.path.endsWith('/ready')).length).toBe(1);
  await page.evaluate(() => window.__voiceQA.message({ type: 'session.started' }));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(fixture.requests.filter(row => row.path.endsWith('/ready'))).toHaveLength(1);
  expect(await page.evaluate(() => window.__voiceQA.sent)).toEqual([]);
  fixture.finishServerCall();
  await page.evaluate(() => window.__voiceQA.message({ type: 'session.closed' }));
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__voiceQA.peersClosed)).toBe(1);
  await expect(page.getByRole('button', { name: 'Starta testsamtal', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(fixture.unexpected).toEqual([]); expect(fixture.pageErrors).toEqual([]);
});

test('Live without session.started times out without marking ready or redialling and releases the microphone', async ({ page }) => {
  await page.clock.install();
  const fixture = await setup(page, { protocol: 'live' });
  await page.getByRole('button', { name: 'Starta testsamtal', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceQA.answers.length)).toBe(1);
  await page.clock.runFor(100);
  expect(fixture.requests.filter(row => row.path.endsWith('/ready'))).toEqual([]);
  await page.clock.fastForward(15_100);
  await expect.poll(() => page.evaluate(() => window.__voiceQA.stoppedTracks)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__voiceQA.peersClosed)).toBe(1);
  await expect.poll(() => fixture.requests.filter(row => row.path.endsWith('/end')).length).toBe(1);
  expect(fixture.requests.filter(row => row.path.endsWith('/ready'))).toEqual([]);
  expect(fixture.requests.filter(row => row.path === '/api/voice-test/calls' && row.method === 'POST')).toHaveLength(1);
  expect(await page.evaluate(() => window.__voiceQA.sent)).toEqual([]);
  expect(fixture.unexpected).toEqual([]); expect(fixture.pageErrors).toEqual([]);
});
