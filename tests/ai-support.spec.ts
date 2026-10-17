import { test, expect, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';

test.use({ viewport: { width: 1440, height: 1100 }, isMobile: false, hasTouch: false, locale: 'sv-SE' });

type PublicSource = { url: string; title: string; verifiedAt?: string };
type StarterPack = { id: string; version: number; title: string; items: { id: string; title: string; answer: string; category: string; sources: PublicSource[] }[]; importedItemIds: string[] };
type Knowledge = { id: string; version: number; title: string; answer: string; category: string; siteIds: string[]; status: 'draft' | 'published' | 'archived'; publicApproved: boolean; createdAt: string; updatedAt: string;
  source?: { type: 'starter_pack'; packId: string; packVersion: number; itemId: string; sources: PublicSource[] } };
type Settings = { enabled: boolean; companyName: string; greeting: string; voice: string; tone: string; pace: string; pronunciationText: string };
type Support = { revision: number; settings: Settings; knowledge: Knowledge[]; suggestions: object[]; voices: { id: string; name: string }[]; sites: { id: string; name: string }[];
  articleCandidates: object[]; stats: { total: number; published: number; publishedCharacters: number; maxTotal: number; maxPublished: number; maxPublishedCharacters: number };
  capabilities: { read: boolean; write: boolean; settingsWrite: boolean; globalWrite: boolean };
  runtime?: { engine: 'live' | 'realtime'; model: string; voice: string; previewAvailable: boolean; notice?: string };
  starterPack?: StarterPack;
  runtimePreview: { siteId: string; siteName: string; items: { id: string; version: number; title: string; answer: string }[]; characters: number; revision: number } | null;
  privateFixture?: object };
type AudioQA = { plays: string[]; pauses: number; created: string[]; revoked: string[] };
declare global { interface Window { __aiSupportAudio: AudioQA } }

const secret = 'PRIVATE_AI_SUPPORT_FIXTURE_NEVER_RENDER_OR_SEND';
const audioBase64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const sites = [{ id: 'norrtalje', name: 'Norrtälje' }, { id: 'rimbo', name: 'Rimbo' }];

async function setup(page: Page, { live = false, starterPack = false } = {}) {
  const data = migrateOffice(seedOffice()), admin = data.users.find(user => user.id === 'admin')!;
  let companyId = starterPack ? 'jeroc-demo' : 'ai-support-fixture', generation = 3, failCommitted = false, sequence = 1;
  const stamp = new Date().toISOString();
  const state: Support = {
    revision: 1,
    settings: { enabled: true, companyName: 'Provbolaget Återvinning AB', greeting: 'Hej och välkommen till vår mottagning!', voice: 'marin', tone: 'friendly', pace: 'normal', pronunciationText: '' },
    knowledge: [{ id: 'f79d1eb3-c102-4aee-8466-000000000001', version: 1, title: 'Besök på mottagningen', answer: 'Välkommen med sorterat material. Kontakta kontoret om du behöver hjälp före ditt besök.', category: 'visits', siteIds: [], status: 'published', publicApproved: true, createdAt: stamp, updatedAt: stamp }],
    suggestions: [], voices: [{ id: 'marin', name: 'Marin' }, live ? { id: 'meridian', name: 'Meridian' } : { id: 'coral', name: 'Coral' }], sites,
    articleCandidates: [{ id: 'copper-1', name: 'Koppar klass 1', description: 'Ren koppar utan isolering.', includes: ['Rena kopparrör'], excludes: ['Isolerad kabel'], purchasePrice: secret }],
    stats: { total: 1, published: 1, publishedCharacters: 0, maxTotal: 100, maxPublished: 20, maxPublishedCharacters: 10000 },
    capabilities: { read: true, write: true, settingsWrite: true, globalWrite: true }, runtimePreview: null,
    ...(live ? { runtime: { engine: 'live' as const, model: 'gpt-live-1', voice: 'marin', previewAvailable: false } } : {}),
    ...(starterPack ? { starterPack: { id: 'jeroc-public-fixture', version: 1, title: 'Grundkunskap för JEROC', importedItemIds: [], items: [
      { id: 'contact', title: 'Kontakt med JEROC', answer: 'Kontoret hjälper dig inför ditt besök på mottagningen.', category: 'general', sources: [{ url: 'https://www.jeroc.se/kontakt', title: 'Kontakt – JEROC', verifiedAt: stamp }] },
      { id: 'materials', title: 'Sortering före besöket', answer: 'Håll olika material åtskilda och kontakta kontoret vid frågor om sortering.', category: 'materials', sources: [{ url: 'https://www.jeroc.se/material', title: 'Material – JEROC', verifiedAt: stamp }] },
      { id: 'visits', title: 'Planera besöket', answer: 'Stäm av mottagningens aktuella öppettider med kontoret före besöket.', category: 'visits', sources: [{ url: 'https://www.jeroc.se/besok', title: 'Besök – JEROC', verifiedAt: stamp }] },
    ] } } : {}),
    privateFixture: { apiKey: secret, bankAccount: secret, personNumber: secret },
  };
  const refreshComputed = () => {
    if (state.runtime) state.runtime.voice = state.settings.voice;
    const published = state.knowledge.filter(row => row.status === 'published' && row.publicApproved);
    state.stats = { ...state.stats, total: state.knowledge.length, published: published.length, publishedCharacters: published.reduce((sum, row) => sum + row.answer.length, 0) };
    state.runtimePreview = { siteId: 'norrtalje', siteName: 'Norrtälje', items: published.map(({ id, version, title, answer }) => ({ id, version, title, answer })), characters: state.stats.publishedCharacters, revision: state.revision };
  };
  refreshComputed();
  const requests: { path: string; method: string; body?: Record<string, unknown>; headers: Record<string, string> }[] = [], external: string[] = [], errors: string[] = [];
  const commands = new Map<string, { fingerprint: string; saved: object }>();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const qa: AudioQA = window.__aiSupportAudio = { plays: [], pauses: 0, created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); qa.created.push(url); return url; };
    URL.revokeObjectURL = url => { qa.revoked.push(url); revoke(url); };
    HTMLMediaElement.prototype.play = function () { qa.plays.push(this.currentSrc || this.src); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () { qa.pauses++; };
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:5173' && !['data:', 'blob:'].includes(url.protocol)) { external.push(url.origin); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/platform/session') return route.fulfill({ json: {
      enabled: true, authenticated: true, actor: { id: 'platform-ai-fixture', username: 'ai-fixture', name: 'AI-provets administratör', platformAdmin: true },
      actualUser: admin, user: admin, company: { id: companyId, name: state.settings.companyName, organisationNumber: '5593593626', status: 'active' },
      organisationId: companyId, effectiveUserId: admin.id, isSupportSession: false, mustChangePassword: false, csrfToken: 'ai-fixture-platform', generation, companies: [],
    } });
    const entry = { path, method: request.method(), headers: request.headers(), ...(request.postData() ? { body: request.postDataJSON() as Record<string, unknown> } : {}) };
    requests.push(entry);
    if (path.startsWith('/api/ai-support')) {
      if (request.headers()['x-platform-organisation-id'] !== companyId) return route.fulfill({ status: 409, json: { error: 'Bolaget har ändrats.', code: 'platform_context_changed' } });
      if (path === '/api/ai-support' && request.method() === 'GET') return route.fulfill({ json: state });
      if (path === '/api/ai-support/preview') return route.fulfill({ json: { audioBase64, mimeType: 'audio/mpeg', voice: entry.body?.voice } });
      const body = entry.body ?? {}, key = `${companyId}:${body.requestId}`, fingerprint = JSON.stringify([path, body]), prior = commands.get(key);
      if (body.requestId && prior) return route.fulfill(prior.fingerprint === fingerprint ? { json: { ...state, saved: prior.saved, replayed: true } } : { status: 409, json: { error: 'Samma idempotensnyckel användes för ett ändrat kommando.', code: 'ai_support_idempotency_conflict' } });
      if (body.expectedRevision !== state.revision) return route.fulfill({ status: 409, json: { error: 'Serverversionen har ändrats.', code: 'ai_support_revision_conflict' } });
      let saved: object = {};
      if (path === '/api/ai-support/settings') {
        const { expectedRevision: _revision, ...settings } = body;
        state.settings = settings as Settings; saved = { settings: true };
      } else if (path === '/api/ai-support/knowledge/from-starter-pack' && starterPack) {
        const pack = state.starterPack, itemIds = body.itemIds as string[];
        if (!pack || body.packId !== pack.id || body.packVersion !== pack.version) return route.fulfill({ status: 409, json: { error: 'Grundpaketet har ändrats.' } });
        if (body.status === 'published' && body.publicApproved !== true) return route.fulfill({ status: 422, json: { error: 'Förslagen måste granskas före publicering.' } });
        if (!Array.isArray(itemIds) || !itemIds.length || new Set(itemIds).size !== itemIds.length || itemIds.some(id => !pack.items.some(item => item.id === id) || pack.importedItemIds.includes(id))) return route.fulfill({ status: 422, json: { error: 'Välj nya förslag ur grundpaketet.' } });
        const knowledgeIds: string[] = [];
        for (const itemId of itemIds) {
          const item = pack.items.find(row => row.id === itemId)!, now = new Date().toISOString();
          const id = `f79d1eb3-c102-4aee-8466-${String(++sequence).padStart(12, '0')}`;
          state.knowledge.push({ id, version: 1, title: item.title, answer: item.answer, category: item.category, siteIds: [], status: body.status as 'draft' | 'published', publicApproved: body.publicApproved === true, createdAt: now, updatedAt: now,
            source: { type: 'starter_pack', packId: pack.id, packVersion: pack.version, itemId, sources: structuredClone(item.sources) } });
          pack.importedItemIds.push(itemId); knowledgeIds.push(id);
        }
        saved = { knowledgeIds };
      } else if (path === '/api/ai-support/knowledge') {
        if (body.status === 'published' && body.publicApproved !== true) return route.fulfill({ status: 422, json: { error: 'Informationen måste granskas före publicering.' } });
        const existing = state.knowledge.find(row => row.id === body.id), now = new Date().toISOString();
        const row = { id: existing?.id ?? `f79d1eb3-c102-4aee-8466-${String(++sequence).padStart(12, '0')}`, version: (existing?.version ?? 0) + 1,
          title: String(body.title), answer: String(body.answer), category: String(body.category), siteIds: body.siteIds as string[], status: body.status as Knowledge['status'], publicApproved: body.publicApproved === true, createdAt: existing?.createdAt ?? now, updatedAt: now };
        if (existing) Object.assign(existing, row); else state.knowledge.push(row);
        saved = { knowledgeId: row.id };
      } else if (/\/knowledge\/[^/]+\/archive$/.test(path)) {
        const id = decodeURIComponent(path.split('/').at(-2)!), row = state.knowledge.find(item => item.id === id)!;
        row.status = 'archived'; row.publicApproved = false; row.version++; row.updatedAt = new Date().toISOString(); saved = { knowledgeId: row.id };
      } else return route.fulfill({ status: 503, json: { error: 'Okänt provkommando.' } });
      state.revision++; refreshComputed();
      if (body.requestId) commands.set(key, { fingerprint, saved });
      if (failCommitted && path === '/api/ai-support/knowledge') { failCommitted = false; return route.fulfill({ status: 503, json: { error: 'Svaret försvann efter lagring.' } }); }
      return route.fulfill({ json: { ...state, saved } });
    }
    const response = path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/environment/session' ? { demo: true, actualUserId: admin.id, effectiveUserId: admin.id, user: admin, csrfToken: 'ai-fixture-environment', expiresAt: '2099-01-01T00:00:00Z' }
      : path === '/api/terminal-demo/staff-session' ? { actualUserId: admin.id, effectiveUserId: admin.id }
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: admin.id, effectiveUserId: admin.id, sites: sites.map(site => ({ ...site, active: true })), terminals: [], approvals: [], defaults: [] }
      : path === '/api/environment/integrations/catalog' ? { version: 1, organisationId: companyId, capabilities: { canManage: true }, providers: [{ id: 'ai-support', name: 'AI-kundmottagning', description: 'Bolagets publika kunskap och röst.', category: 'communication', status: 'connected', mode: 'test', implemented: true, configured: true, connected: true, capabilities: { canView: true, canConfigure: true, canCheck: false, canConnect: false }, requiredSetup: [], links: {} }] }
      : path === '/api/mail/state' ? { organisationId: companyId, configuration: { ready: false, missing: [], issues: [] }, connections: [], mailboxes: [], totalUnread: 0, capabilities: { canRead: true, canManage: true }, mode: 'live' }
      : path === '/api/logistics/summary' ? { active: 0, total: 0 } : undefined;
    if (path === '/api/terminal-demo/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: heartbeat\ndata: {}\n\n' });
    return route.fulfill({ status: response ? 200 : 503, json: response ?? { error: 'Endast isolerade AI-supporttjänster ingår i provet.' } });
  });
  await page.goto('/kontor#/integrations?service=ai-support');
  await expect(page.getByRole('heading', { name: 'AI-kundmottagning', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('tab', { name: 'Kunskap', exact: true })).toBeVisible();
  return { state: () => state, requests, external, errors,
    advanceRevision: () => { state.revision++; refreshComputed(); }, failNextCommittedKnowledge: () => { failCommitted = true; },
    switchScope: async () => { companyId = 'ai-support-other-company'; generation++; state.knowledge = []; delete state.starterPack; state.settings = { ...state.settings, companyName: 'Nya provbolaget', greeting: 'Hej från nya provbolaget!' }; state.revision++; refreshComputed(); await page.evaluate(() => window.dispatchEvent(new Event('scrappilot:check-platform-session'))); },
  };
}

const editor = (page: Page) => ({ title: page.getByRole('textbox', { name: 'Rubrik', exact: true }), answer: page.getByRole('textbox', { name: 'Svar till kunden', exact: true }) });

test('mobile knowledge stays draft until explicit public approval, then can be published and archived', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await setup(page);
  await expect(page.getByRole('link', { name: 'Testa samtal', exact: true })).toHaveAttribute('href', '/rosttest');
  await expect(page.getByRole('link', { name: 'Testa samtal', exact: true })).toHaveAttribute('target', '_blank');
  await page.getByRole('button', { name: 'Nytt svar', exact: true }).click();
  await editor(page).title.fill('Hämtning av mindre mängder');
  await editor(page).answer.fill('Beskriv materialet och mängden så återkommer kontoret med ett förslag.');
  await page.getByRole('combobox', { name: 'Kategori', exact: true }).selectOption('pickups');
  await page.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await expect.poll(() => fixture.state().knowledge.find(row => row.title === 'Hämtning av mindre mängder')?.status).toBe('draft');
  expect(fixture.state().runtimePreview?.items.some(row => row.title === 'Hämtning av mindre mängder')).toBe(false);
  const publish = page.getByRole('button', { name: /^(Publicera svar|Spara och publicera)$/ });
  const before = fixture.requests.filter(row => row.method === 'POST').length;
  await publish.click();
  await expect(page.getByRole('alert')).toContainText('Bekräfta att du har kontrollerat informationen');
  expect(fixture.requests.filter(row => row.method === 'POST')).toHaveLength(before);
  await page.getByRole('checkbox', { name: /^Jag har kontrollerat att informationen får lämnas till kunder/ }).check();
  await publish.click();
  await expect.poll(() => fixture.state().knowledge.find(row => row.title === 'Hämtning av mindre mängder')?.status).toBe('published');
  expect(fixture.state().runtimePreview?.items.some(row => row.title === 'Hämtning av mindre mängder')).toBe(true);
  await page.getByRole('button', { name: 'Arkivera', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Arkivera svaret?', exact: true }) });
  await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: 'Arkivera svar', exact: true }).click();
  await expect.poll(() => fixture.state().knowledge.find(row => row.title === 'Hämtning av mindre mängder')?.status).toBe('archived');
  await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(fixture.external).toEqual([]); expect(fixture.errors).toEqual([]);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('ai-support-mobile390.png'), fullPage: true });
});

test('a CAS conflict keeps the unsaved answer and explicit refresh only rebases its server revision', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Nytt svar', exact: true }).click();
  await editor(page).title.fill('Eget osparat svar'); await editor(page).answer.fill('Det här utkastet ska överleva en versionskonflikt.');
  fixture.advanceRevision(); await page.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Serverversionen har ändrats.');
  await expect(editor(page).answer).toHaveValue('Det här utkastet ska överleva en versionskonflikt.');
  expect(fixture.requests.filter(row => row.path === '/api/ai-support/knowledge' && row.method === 'POST')).toHaveLength(1);
  await page.getByRole('button', { name: 'Hämta aktuell version', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Aktuell serverversion hämtad.' })).toBeVisible();
  await expect(editor(page).answer).toHaveValue('Det här utkastet ska överleva en versionskonflikt.');
  await page.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await expect.poll(() => fixture.state().knowledge.find(row => row.title === 'Eget osparat svar')?.status).toBe('draft');
  expect(fixture.requests.filter(row => row.path === '/api/ai-support/knowledge' && row.method === 'POST')).toHaveLength(2);
  expect(fixture.errors).toEqual([]);
});

test('a committed answer with a lost response replays the exact command after refresh without duplicating knowledge', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Nytt svar', exact: true }).click();
  await editor(page).title.fill('Ett enda sparat svar'); await editor(page).answer.fill('Detta svar ska bara skapas en gång trots ett osäkert nätverkssvar.');
  fixture.failNextCommittedKnowledge(); await page.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Svaret försvann efter lagring.');
  await page.getByRole('button', { name: 'Uppdatera kunskapsbanken', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Aktuell serverversion hämtad.' })).toBeVisible();
  await expect(editor(page).answer).toHaveValue('Detta svar ska bara skapas en gång trots ett osäkert nätverkssvar.');
  await page.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Utkastet är sparat.' })).toBeVisible();
  const writes = fixture.requests.filter(row => row.path === '/api/ai-support/knowledge' && row.method === 'POST');
  expect(writes).toHaveLength(2); expect(writes[1].body).toEqual(writes[0].body);
  expect(fixture.state().knowledge.filter(row => row.title === 'Ett enda sparat svar')).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('voice settings save only public fields and preview uses explicit audio with cleanup on company change', async ({ page }, testInfo) => {
  const fixture = await setup(page);
  await page.getByRole('tab', { name: 'Röst & bemötande', exact: true }).click();
  await page.getByRole('textbox', { name: /^Hälsningsfras/ }).fill('Hej! Vad kan vi hjälpa dig med på mottagningen?');
  await page.getByRole('button', { name: 'Välj röst Coral', exact: true }).click();
  await page.getByRole('combobox', { name: 'Ton', exact: true }).selectOption('professional');
  await page.getByRole('combobox', { name: 'Tempo', exact: true }).selectOption('slow');
  await page.getByRole('textbox', { name: /^Uttal och förkortningar/ }).fill('AO uttalas arbetsorder.');
  await page.getByRole('button', { name: 'Spara röst & bemötande', exact: true }).click();
  await expect.poll(() => fixture.state().settings.voice).toBe('coral');
  const saved = fixture.requests.find(row => row.path === '/api/ai-support/settings' && row.method === 'POST')!;
  expect(saved.body).toMatchObject({ voice: 'coral', tone: 'professional', pace: 'slow', pronunciationText: 'AO uttalas arbetsorder.' });
  expect(Object.keys(saved.body!).sort()).toEqual(['companyName', 'enabled', 'expectedRevision', 'greeting', 'pace', 'pronunciationText', 'tone', 'voice']);
  expect(await page.evaluate(() => window.__aiSupportAudio.plays)).toEqual([]);
  await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: testInfo.outputPath('ai-support-desktop1440.png'), fullPage: true });
  await page.getByRole('button', { name: 'Provlyssna på Coral', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__aiSupportAudio.plays.length)).toBe(1);
  const played = await page.evaluate(() => window.__aiSupportAudio.plays[0]);
  await fixture.switchScope();
  await expect.poll(() => page.evaluate(url => window.__aiSupportAudio.revoked.includes(url), played)).toBe(true);
  expect(await page.evaluate(() => window.__aiSupportAudio.pauses)).toBeGreaterThan(0);
  await expect(page.getByText('Besök på mottagningen', { exact: true })).toHaveCount(0);
  for (const request of fixture.requests.filter(row => row.method === 'POST' && row.path.startsWith('/api/ai-support'))) {
    expect(request.headers['x-platform-csrf']).toBe('ai-fixture-platform'); expect(request.headers['x-platform-organisation-id']).toBe('ai-support-fixture');
    expect(request.headers['x-platform-generation']).toBe('3');
    expect(JSON.stringify(request.body)).not.toContain(secret);
  }
  await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
  expect(fixture.external).toEqual([]); expect(fixture.errors).toEqual([]);
});

test('revocation stops audio and a late older knowledge response cannot restore private company text', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('tab', { name: 'Röst & bemötande', exact: true }).click();
  await page.getByRole('button', { name: 'Provlyssna på Marin', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__aiSupportAudio.plays.length)).toBe(1);
  fixture.advanceRevision(); await page.getByRole('button', { name: 'Spara röst & bemötande', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Serverversionen har ändrats.');
  const played = await page.evaluate(() => window.__aiSupportAudio.plays[0]), old = structuredClone(fixture.state());
  let release!: () => void, entered!: () => void, finish!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }), done = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/ai-support', async route => { entered(); await gate; try { await route.fulfill({ json: old }); } catch { /* Permission cleanup aborts this old request. */ } finally { finish(); } });
  try {
    await page.getByRole('button', { name: 'Hämta aktuell version', exact: true }).click(); await started;
    await page.route('**/api/ai-support/preview', route => route.fulfill({ status: 403, json: { error: 'Åtkomsten till AI-support har återkallats.', code: 'ai_support_forbidden' } }));
    await page.getByRole('button', { name: 'Provlyssna på Coral', exact: true }).click();
    await expect.poll(() => page.evaluate(url => window.__aiSupportAudio.revoked.includes(url), played)).toBe(true);
    release(); await done; await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText('Besök på mottagningen', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: /^Hälsningsfras/ })).toHaveCount(0);
    expect(await page.evaluate(() => window.__aiSupportAudio.plays.length)).toBe(1); expect(fixture.errors).toEqual([]);
  } finally { release(); }
});

test('a voice sample arriving after a company change cannot start old-company playback', async ({ page }) => {
  const fixture = await setup(page); await page.getByRole('tab', { name: 'Röst & bemötande', exact: true }).click();
  let release!: () => void, entered!: () => void, finish!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }), done = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/ai-support/preview', async route => { entered(); await gate; try { await route.fulfill({ json: { audioBase64, mimeType: 'audio/mpeg', voice: 'marin' } }); } catch { /* Expected abort on scope change. */ } finally { finish(); } });
  try {
    await page.getByRole('button', { name: 'Provlyssna på Marin', exact: true }).click(); await started;
    await fixture.switchScope();
    await expect(page.getByRole('tab', { name: 'Kunskap', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Röst & bemötande', exact: true }).click();
    await expect(page.getByRole('textbox', { name: /^Bolagsnamn/ })).toHaveValue('Nya provbolaget');
    release(); await done; await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => window.__aiSupportAudio.plays)).toEqual([]);
    const audio = await page.evaluate(() => window.__aiSupportAudio); expect(audio.created.every(url => audio.revoked.includes(url))).toBe(true);
    expect(fixture.errors).toEqual([]);
  } finally { release(); }
});

test('a double click cannot create a second preview request while the first sample is pending', async ({ page }) => {
  const fixture = await setup(page); await page.getByRole('tab', { name: 'Röst & bemötande', exact: true }).click();
  let release!: () => void, entered!: () => void, previews = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/api/ai-support/preview', async route => { previews++; entered(); await gate; await route.fulfill({ json: { audioBase64, mimeType: 'audio/mpeg', voice: 'marin' } }); });
  try {
    await page.getByRole('button', { name: 'Provlyssna på Marin', exact: true }).dblclick({ delay: 10 }); await started;
    expect(previews).toBe(1); await expect(page.getByRole('button', { name: 'Provlyssna på Coral', exact: true })).toBeDisabled();
    release(); await expect.poll(() => page.evaluate(() => window.__aiSupportAudio.plays.length)).toBe(1);
    expect(previews).toBe(1); expect(fixture.errors).toEqual([]);
  } finally { release(); }
});

test('Live saves Meridian for the next conversation and offers the actual call instead of a legacy preview request', async ({ page }) => {
  const fixture = await setup(page, { live: true });
  const runtime = page.getByRole('region', { name: 'Aktiv röstmotor', exact: true });
  await expect(runtime).toContainText('GPT-Live'); await expect(runtime).toContainText('gpt-live-1');
  await page.getByRole('tab', { name: 'Röst & bemötande', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Provlyssna på Marin', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Provlyssna på Meridian', exact: true })).toBeDisabled();
  const call = page.getByRole('link', { name: 'Provlyssna i ett testsamtal', exact: true });
  await expect(call).toHaveAttribute('href', '/rosttest'); await expect(call).toHaveAttribute('target', '_blank');
  await page.getByRole('button', { name: 'Välj röst Meridian', exact: true }).click();
  await page.getByRole('button', { name: 'Spara röst & bemötande', exact: true }).click();
  await expect.poll(() => fixture.state().settings.voice).toBe('meridian');
  await expect(runtime).toContainText('Meridian');
  expect(fixture.requests.filter(row => row.path === '/api/ai-support/preview')).toEqual([]);
  const settings = fixture.requests.filter(row => row.path === '/api/ai-support/settings' && row.method === 'POST');
  expect(settings).toHaveLength(1); expect(settings[0].body).toMatchObject({ voice: 'meridian', expectedRevision: 1 });
  expect(await page.evaluate(() => window.__aiSupportAudio.plays)).toEqual([]);
  expect(fixture.external).toEqual([]); expect(fixture.errors).toEqual([]);
});

test('JEROC starter proposals require renewed approval, import only the selection, and disappear on company change', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await setup(page, { starterPack: true });
  const writes = () => fixture.requests.filter(row => row.path.startsWith('/api/ai-support') && row.method === 'POST');
  expect(writes()).toEqual([]);
  const open = page.getByRole('button', { name: 'Granska förslagen', exact: true });
  await expect(open).toBeVisible();
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Grundkunskap för JEROC', exact: true });
  await expect(dialog).toBeVisible(); expect(writes()).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const contact = dialog.getByRole('checkbox', { name: 'Lägg till Kontakt med JEROC', exact: true });
  const material = dialog.getByRole('checkbox', { name: 'Lägg till Sortering före besöket', exact: true });
  const visit = dialog.getByRole('checkbox', { name: 'Lägg till Planera besöket', exact: true });
  const approval = dialog.getByRole('checkbox', { name: 'Jag har granskat de valda svaren och godkänner att de får lämnas till kunder', exact: true });
  const publish = dialog.getByRole('button', { name: 'Godkänn och publicera', exact: true });
  await expect(contact).toBeChecked(); await expect(material).toBeChecked(); await expect(visit).toBeChecked();
  await expect(publish).toBeDisabled(); expect(writes()).toEqual([]);
  await expect(dialog.getByRole('link', { name: 'Kontakt – JEROC', exact: true })).toHaveAttribute('href', 'https://www.jeroc.se/kontakt');
  await approval.check(); await expect(publish).toBeEnabled();
  await material.uncheck(); await expect(approval).not.toBeChecked(); await expect(publish).toBeDisabled();
  await visit.uncheck(); await approval.check(); await publish.click();
  await expect(dialog).toHaveCount(0);
  const selected = fixture.state().knowledge.find(row => row.source?.itemId === 'contact')!;
  expect(selected).toMatchObject({ title: 'Kontakt med JEROC', status: 'published', publicApproved: true,
    source: { type: 'starter_pack', packId: 'jeroc-public-fixture', packVersion: 1, itemId: 'contact', sources: fixture.state().starterPack!.items[0].sources } });
  expect(fixture.state().knowledge.filter(row => row.source?.type === 'starter_pack')).toHaveLength(1);
  expect(fixture.state().runtimePreview?.items.some(row => row.id === selected.id)).toBe(true);
  expect(writes()).toHaveLength(1);
  expect(writes()[0].body).toEqual({ requestId: expect.stringMatching(/^[a-f0-9-]{36}$/i), expectedRevision: 1, packId: 'jeroc-public-fixture', packVersion: 1, itemIds: ['contact'], status: 'published', publicApproved: true });

  await page.getByRole('tab', { name: 'Röst & bemötande', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Osparade ändringar', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Spara röst & bemötande', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Kunskap', exact: true }).click();

  await open.click(); await expect(dialog).toBeVisible();
  await expect(contact).toBeDisabled(); await expect(contact).not.toBeChecked();
  await expect(material).toBeChecked(); await expect(visit).toBeChecked(); await expect(approval).not.toBeChecked();
  await visit.uncheck(); await dialog.getByRole('button', { name: 'Lägg till som utkast', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const draft = fixture.state().knowledge.find(row => row.source?.itemId === 'materials')!;
  expect(draft).toMatchObject({ title: 'Sortering före besöket', status: 'draft', publicApproved: false,
    source: { itemId: 'materials', sources: fixture.state().starterPack!.items[1].sources } });
  expect(fixture.state().runtimePreview?.items.some(row => row.id === draft.id)).toBe(false);
  expect(fixture.state().knowledge.some(row => row.source?.itemId === 'visits')).toBe(false);
  expect(writes()).toHaveLength(2);
  expect(writes()[1].body).toMatchObject({ expectedRevision: 2, itemIds: ['materials'], status: 'draft', publicApproved: false });

  await open.click(); await expect(dialog).toBeVisible(); await expect(visit).toBeChecked();
  const count = writes().length;
  await fixture.switchScope();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Granska förslagen', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Grundkunskap för JEROC', exact: true })).toHaveCount(0);
  await expect(page.getByText('Kontakt med JEROC', { exact: true })).toHaveCount(0);
  expect(writes()).toHaveLength(count);
  expect(fixture.external).toEqual([]); expect(fixture.errors).toEqual([]);
});
