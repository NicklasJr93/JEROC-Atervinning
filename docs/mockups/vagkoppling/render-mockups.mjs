import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

// Rendering tool only. It never calls a real scale, tenant API or live server.
const folder = dirname(fileURLToPath(import.meta.url));
const repository = resolve(folder, '../../..');
const base = new URL(process.env.MOCKUP_BASE_URL || 'http://127.0.0.1:5173');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || !['http:', 'https:'].includes(base.protocol)
  || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
  throw new Error('MOCKUP_BASE_URL must be a local origin, for example http://127.0.0.1:5173.');

const { seedOffice, migrateOffice, articles } = await import(pathToFileURL(resolve(repository, 'dist-server/domain-models.mjs')).href);
// seedDemo is not a domain-model export. Bundle it in memory; no generated or
// production files are changed by preparing the screenshot fixture.
const bundled = await build({ stdin: { contents: "export { seedDemo } from './src/model.ts';", resolveDir: repository },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const { seedDemo } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const company = { id: 'vag-mockup-company', name: 'Återvinning Exempel AB', organisationNumber: '5593593626', status: 'active' };
const site = { id: 'norrtalje', name: 'Norrtälje', active: true };
const personId = 'vag-mockup-employee', draftId = 'b5dabd23-9ef3-4c94-9be8-708562e30626', cardId = 2148;
const now = new Date().toISOString(), day = now.slice(0, 10);
const office = migrateOffice(seedOffice());
const user = { ...office.users.find(value => value.id === 'admin'), name: 'Kontoret', level: 'VD' };
office.users = [user];
office.customers = [{ ...office.customers[0], name: 'Exempelbygg AB', phone: '', email: '' }];
office.cards = [{ ...office.cards.find(value => value.id === 2051), id: cardId, sourceId: draftId, status: 'complement',
  customerId: office.customers[0].id, customerSnapshot: undefined, customerApproval: undefined,
  weigher: 'Gården', date: now, reference: 'Inlämning material', origin: 'Norrtälje', audit: [],
  rows: [{ articleId: 'copper-1', articleName: 'Koppar klass 1', weight: 125, tier: 'A', price: 82 }] }];
const demo = { ...seedDemo(), customers: office.customers, drafts: [{
  id: draftId, number: cardId, siteId: site.id, mode: 'direct', status: 'draft', createdAt: now, updatedAt: now,
  customerId: office.customers[0].id, reference: '', origin: '', rows: [],
}] };
const session = { enabled: true, authenticated: true,
  actor: { id: 'vag-mockup-actor', name: user.name, username: 'kontoret', platformAdmin: false },
  actualUser: user, user, company, organisationId: company.id, effectiveUserId: user.id, isSupportSession: false,
  mustChangePassword: false, csrfToken: 'synthetic-screenshot-csrf', generation: 1, companies: [company] };
const pricing = { version: 'synthetic-vag-mockup', revision: 1, memoryOnly: true, asOfDate: day,
  metals: [], customers: office.customers.map(value => ({ id: value.id, name: value.name })), users: [user],
  articles: articles.map(article => ({ ...article, active: true, includes: [article.includes], excludes: [article.excludes],
    base: { type: 'manual', price: article.prices[0] }, baseSekKg: article.prices[0],
    tiers: { A: { discountPercent: 0, adjustmentKr: 0 }, B: { discountPercent: 10, adjustmentKr: 0 }, C: { discountPercent: 20, adjustmentKr: 0 } },
    prices: { A: article.prices[0], B: article.prices[1], C: article.prices[2] }, thresholds: { A: 1000, B: 100 }, effectiveFrom: day })) };
const employee = { companyId: company.id, companyName: company.name,
  person: { id: personId, name: 'Gården', role: 'Invägare', team: 'Gården', siteIds: [site.id] },
  capabilities: { yardWork: true, employeeTime: true, assignedOrders: false, paymentDetails: false },
  activeSiteId: site.id, sites: [site], today: day, month: day.slice(0, 7), date: day,
  gate: { blocked: false }, days: [], orders: [], selectedDay: { schedules: [], absences: [], entries: [], orders: [] } };

async function intercept(page, kind) {
  await page.addInitScript(({ personId, demo, office }) => {
    const key = `jeroc.mobile.demo.v1.employee.${personId}`;
    localStorage.setItem(key, JSON.stringify(demo)); localStorage.setItem(`${key}.postgres-imported`, 'yes');
    localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(office));
    sessionStorage.setItem('jeroc.office.user', 'admin');
    class FixtureEvents extends EventTarget {
      static OPEN = 1; readyState = 1; onmessage = null; onerror = null;
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { value: FixtureEvents });
  }, { personId, demo, office });
  const errors = [], external = [], syntheticWrites = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== base.origin) { external.push(url.origin); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (!['GET', 'HEAD'].includes(request.method())) syntheticWrites.push({ path, method: request.method() });
    const json = value => route.fulfill({ json: value });
    if (path === '/api/platform/session') return json(kind === 'office' ? session : { enabled: true, authenticated: false });
    if (path === '/api/platform/tenant-context') return json({ companyId: company.id, companyName: company.name });
    if (path === '/api/application/office') return json({ data: office, revision: 1 });
    if (path === '/api/application/mobile') return json({ data: demo, revision: 1, catalog: articles, groups: [], customerPrices: {} });
    if (path === '/api/application/revision') return json({ revision: 1 });
    if (path === '/api/pricing/state') return json(pricing);
    if (path === '/api/company-settings/defaults') return json({ companyId: company.id, version: 1,
      profile: { name: company.name }, defaults: { paymentTermsDays: 30 } });
    if (path === '/api/employee/fleet') return json({ revision: 0, personId, vehicles: [], profiles: {}, services: [], issues: [], inspections: [],
      trips: [], pendingTrips: [], workOrders: [], gate: { blocked: false, count: 0, pendingTrips: [], safeToInteract: true },
      capabilities: { read: true, write: true, vehicleWrite: false, export: false } });
    if (path === '/api/employee/customer-intake') return json({ intake: null, terminals: [], smsConfigured: false });
    if (path.startsWith('/api/employee/')) return json(employee);
    if (path === '/api/terminal-demo/staff-session') return json({ actualUserId: user.id, effectiveUserId: user.id });
    if (path === '/api/terminal-demo/state') return json({ configured: true, revision: 1,
      actualUserId: user.id, effectiveUserId: user.id, sites: [site], terminals: [], approvals: [], defaults: [] });
    if (path.endsWith('/summary')) return json({ workOrders: 0, warehouse: 0, vessels: 0 });
    if (path.includes('/accounting/cards/')) return json({ export: null });
    return route.fulfill({ status: 503, json: { error: 'Den här tjänsten ingår inte i bildmockupen.' } });
  });
  return { errors, external, syntheticWrites };
}

const panelCss = `
.scale-mockup{border:1px solid #dce7f5;border-radius:9px;background:#f7faff;padding:14px 15px;margin:18px 0;color:#193153;font-size:12px;line-height:1.45}
.scale-mockup *{box-sizing:border-box}.scale-mockup label{display:block!important;margin:0!important;font-size:11px!important;font-weight:600!important;color:#5f7799!important}
.scale-mockup select{display:block!important;width:100%!important;height:39px!important;margin:6px 0 0!important;padding:8px 10px!important;border:1px solid #dce7f5!important;border-radius:7px!important;background:white!important;color:#203b61!important;font:inherit!important;font-size:12px!important}
.scale-mockup-reading{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:13px 0 10px}.scale-mockup-value{font-size:32px;font-weight:750;letter-spacing:-.7px;line-height:1.1;color:#008854;white-space:nowrap}.scale-mockup-value small{font-size:16px;font-weight:600;letter-spacing:0;margin-left:5px}.scale-mockup-state{display:flex;align-items:center;gap:5px;background:#e9f6ef;color:#187d50;border-radius:20px;padding:4px 8px;font-size:10px;font-weight:600;white-space:nowrap}.scale-mockup-state i{display:block;width:6px;height:6px;border-radius:50%;background:#1b9c63}.scale-mockup-reading p{font-size:10px;color:#7185a6;margin:5px 0 0}.scale-mockup .scale-mockup-get{display:flex;justify-content:center;align-items:center;gap:7px;width:100%;min-height:44px;font-size:12px;font-weight:650;border:0;border-radius:7px;background:#0969f3;color:white;padding:9px 13px}.scale-mockup .scale-mockup-get svg{width:16px;height:16px}.scale-mockup-note{font-size:10px!important;color:#7185a6!important;margin:8px 0 0!important}.scale-mockup-manual{display:flex;align-items:center;gap:8px;margin-top:12px;color:#7185a6;font-size:10px}.scale-mockup-manual:before,.scale-mockup-manual:after{content:'';height:1px;background:#dce7f5;flex:1}
.weight-page[data-scale-mockup] .scale-mockup{margin:0;padding:11px 13px}.weight-page[data-scale-mockup] .scale-mockup-reading{margin:10px 0 9px}.weight-page[data-scale-mockup] .scale-mockup-value{font-size:30px}.weight-page[data-scale-mockup] .scale-mockup-note{font-size:10px!important}.weight-page[data-scale-mockup] .keypad{min-height:144px;grid-template-rows:repeat(4,minmax(31px,1fr));gap:5px}.weight-page[data-scale-mockup] .keypad button{font-size:22px}.weight-page[data-scale-mockup] .big-weight input{font-size:40px;padding-top:4px;padding-bottom:4px}
`;
async function injectPanel(page, kind) {
  await page.addStyleTag({ content: panelCss });
  await page.evaluate(({ kind }) => {
    const panel = document.createElement('section'); panel.className = 'scale-mockup'; panel.setAttribute('aria-label', 'Förslag till vågkoppling');
    panel.innerHTML = `<label for="scale-mockup-source">Hämta från våg<select id="scale-mockup-source"><option>Materialvåg 1 · Norrtälje</option><option>Materialvåg 2 · Norrtälje</option><option>Fordonsvåg · Norrtälje</option></select></label>
      <div class="scale-mockup-reading"><div><div class="scale-mockup-value">248,5<small>kg</small></div><p>Senaste avläsning: 1 sekund sedan</p></div><span class="scale-mockup-state"><i></i>Stabil vikt</span></div>
      <button type="button" class="scale-mockup-get"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/></svg>Hämta vikt</button>
      <p class="scale-mockup-note">Fyller viktfältet. ${kind === 'office' ? 'Välj sedan Spara vikt för att spara på kortet.' : 'Spara med Färdigvägt eller Nästa material.'}</p><div class="scale-mockup-manual">eller ange vikten manuellt</div>`;
    const parent = kind === 'office' ? document.querySelector('dialog[open] .quick-customer-form') : document.querySelector('.weight-form');
    const before = kind === 'office' ? parent?.querySelector('.quick-customer-fields') : parent?.querySelector('.weight-entry-label');
    if (!parent || !before) throw new Error('Befintlig viktvy hittades inte; ingen alternativ UI ska skapas.');
    parent.insertBefore(panel, before);
    if (kind === 'mobile') document.querySelector('.weight-page')?.setAttribute('data-scale-mockup', '');
    // Optional local interaction fills only the existing provisional field;
    // the original save buttons remain the only way to save a material row.
    panel.querySelector('button').addEventListener('click', () => {
      const input = kind === 'office' ? parent.querySelector('input[aria-label="Vikt (kg)"]') : parent.querySelector('input[aria-label="Vikt i kg"]');
      if (!(input instanceof HTMLInputElement)) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '248,5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    // A deliberately unavailable fixture service should not decorate the
    // unrelated backdrop with an error in this static design proposal.
    for (const element of document.querySelectorAll('.office-main [role="alert"]'))
      if (element.textContent?.includes('Den här tjänsten ingår inte i bildmockupen.')) element.remove();
  }, { kind });
}

await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
const results = [];
try {
  for (const target of [
    { kind: 'office', name: '01_Kontor_Hamta_fran_vag.png', width: 1440, height: 1000 },
    { kind: 'mobile', name: '02_Mobil_Hamta_fran_vag.png', width: 390, height: 940 },
  ]) {
    const context = await browser.newContext({ viewport: { width: target.width, height: target.height }, deviceScaleFactor: 1,
      isMobile: target.kind === 'mobile', hasTouch: target.kind === 'mobile', locale: 'sv-SE', reducedMotion: 'reduce' });
    const page = await context.newPage(), observations = await intercept(page, target.kind);
    if (target.kind === 'office') {
      await page.goto(`${base.origin}/kontor#/weighings/${cardId}`);
      await expect(page.getByRole('heading', { name: `Invägning #${cardId}`, exact: true })).toBeVisible();
      await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
      await page.getByRole('button', { name: 'Ändra vikt', exact: true }).first().click();
      await expect(page.getByRole('dialog', { name: 'Ändra vikt', exact: true })).toBeVisible();
    } else {
      await page.goto(`${base.origin}/#/weigh/${draftId}/weight/copper-1?back=summary`);
      await expect(page.getByRole('heading', { name: 'Ange vikt', exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Vikt i kg', exact: true })).toBeVisible();
    }
    await injectPanel(page, target.kind);
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode().catch(() => undefined))); });
    await expect(page.getByRole('button', { name: 'Hämta vikt', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: target.kind === 'office' ? 'Spara vikt' : 'Färdigvägt', exact: true })).toBeVisible();
    const state = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
      width: innerWidth, brokenImages: [...document.images].filter(image => !image.complete || !image.naturalWidth).length }));
    if (state.overflow || state.brokenImages || observations.errors.length || observations.external.length)
      throw new Error(JSON.stringify({ image: target.name, ...state, ...observations }));
    await page.screenshot({ path: resolve(folder, target.name), fullPage: false, animations: 'disabled' });
    results.push({ image: target.name, ...state, interceptedWrites: observations.syntheticWrites.length, productionWrites: 0 });
    if (target.kind === 'mobile') {
      await page.getByRole('button', { name: 'Hämta vikt', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Vikt i kg', exact: true })).toHaveValue('248,5');
      await page.evaluate(() => {
        document.querySelector('.scale-mockup-note').textContent = 'Vikten är hämtad till fältet. Spara med Färdigvägt eller Nästa material.';
        document.querySelector('.weight-form > .field-help').textContent = 'Hämtad från Materialvåg 1 · Inte sparad ännu';
      });
      await page.screenshot({ path: resolve(folder, '03_Mobil_Vikt_Hamtad.png'), fullPage: false, animations: 'disabled' });
      results.push({ image: '03_Mobil_Vikt_Hamtad.png', productionWrites: 0 });
    }
    await context.close();
  }
} finally { await browser.close(); }
console.log(JSON.stringify(results, null, 2));
