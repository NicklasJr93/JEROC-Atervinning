import { expect, test, type Page, type Request } from '@playwright/test';
import type { DemoData } from '../src/model';
import type { CustomerIntake, CustomerIntakeInput } from '../src/customer-intake/types';
import { emptyEmployeeFleet } from './helpers/employee-fleet';
import type { TerminalSessionState } from '../src/office/terminal-demo-types';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'sv-SE' });

const token = 'i'.repeat(43);
const publicPath = '/api/public/customer-intake';
const staffPath = '/api/employee/customer-intake';
const draftId = 'browser-intake-draft';
const expiresAt = () => new Date(Date.now() + 30 * 60_000).toISOString();
const proposal: CustomerIntakeInput = { type: 'Företag', name: 'Kundens inskickade företag AB', number: '5593593626',
  phone: '+46722002220', email: 'kund@example.test', address: 'Testgatan 1', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE' };

async function publicFixture(page: Page, { unavailable = false, staleOnSubmit = false } = {}) {
  const reads: Request[] = [], submissions: Request[] = [];
  let status = 'waiting';
  await page.context().addCookies([{ name: 'jeroc_platform', value: 'unrelated-private-staff-session', url: String(test.info().project.use.baseURL) }]);
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === publicPath || url.pathname === `${publicPath}/submit`) {
      reads.push(request);
      expect(request.headers().authorization).toBe(`Bearer ${token}`);
      expect(request.headers().cookie).toBeUndefined();
      expect(request.url()).not.toContain(token);
      if (unavailable || staleOnSubmit && url.pathname.endsWith('/submit'))
        return route.fulfill({ status: 410, json: { error: 'Kundlänken har gått ut eller ersatts.', code: 'customer_intake_unavailable' } });
      if (url.pathname.endsWith('/submit')) { submissions.push(request); status = 'submitted'; }
      return route.fulfill({ json: { company: { name: 'Intagstest Återvinning AB' },
        intake: { id: 'public-intake', status, expiresAt: expiresAt() } } });
    }
    if (url.pathname === '/api/platform/tenant-context') return route.fulfill({ json: { companyId: 'unrelated-company', companyName: 'Ska inte styra kundlänken' } });
    return route.fulfill({ status: 401, json: { error: 'Detta anonyma formulär behöver inget annat API.' } });
  });
  return { reads, submissions };
}

async function fillContact(page: Page) {
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill('559359-3626');
  await page.getByLabel('Företagsnamn', { exact: true }).fill(proposal.name);
  await page.getByLabel('Telefonnummer', { exact: true }).fill('072 200 22 20');
  await page.getByLabel('E-postadress', { exact: true }).fill(proposal.email);
  await page.getByLabel('Postadress', { exact: true }).fill(proposal.address);
  await page.getByLabel('Postnummer', { exact: true }).fill('761 41');
  await page.getByLabel('Ort', { exact: true }).fill(proposal.city);
}

test('SMS-länken visar endast kundformulär, förklarar e-post/bank och skickar bankuppgifter utan Swish eller inloggning', async ({ page }) => {
  const f = await publicFixture(page);
  await page.goto(`/kunduppgifter/#token=${token}`);
  await expect(page.getByRole('heading', { name: 'Dina kunduppgifter', exact: true })).toBeVisible();
  await expect(page.getByText('Intagstest Återvinning AB', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/ingen reklam/i)).toBeVisible();
  await expect(page.getByText(/Sparas på ditt kundkort/)).toBeVisible();
  const swish = page.getByRole('button', { name: 'Swish – kommer snart', exact: true });
  await expect(swish).toBeDisabled();
  await swish.click({ force: true });
  await expect(page.getByRole('status').filter({ hasText: /^Kommer snart$/ })).toBeVisible();
  await expect(page.getByLabel('Swish-nummer', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /lösenord|användarnamn/i })).toHaveCount(0);
  await expect(page.locator('.terminal-material-table')).toHaveCount(0);
  await fillContact(page);
  await page.getByRole('checkbox', { name: 'Lägg till bankuppgifter', exact: true }).check();
  await page.getByLabel('Clearingnummer', { exact: true }).fill('8327');
  await page.getByLabel('Kontonummer', { exact: true }).fill('00123456789');
  await page.getByLabel('Kontohavare', { exact: true }).fill(proposal.name);
  await expect(page.getByRole('option', { name: 'Swish', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Skicka mina uppgifter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tack! Dina uppgifter är skickade', exact: true })).toBeVisible();
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0].postDataJSON()).toMatchObject({ requestId: expect.any(String), customer: { ...proposal,
    paymentProfile: { method: 'bank', bankType: 'account', clearing: '8327', account: '00123456789', holder: proposal.name } } });
  expect(page.url()).not.toContain(token);
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('återkallad länk rensar kundens ifyllda formulär och visar inga uppgifter efter nekad inskickning', async ({ page }) => {
  const f = await publicFixture(page, { staleOnSubmit: true });
  await page.goto(`/kunduppgifter/#token=${token}`);
  await expect(page.getByRole('heading', { name: 'Dina kunduppgifter', exact: true })).toBeVisible();
  await fillContact(page);
  await page.getByRole('button', { name: 'Skicka mina uppgifter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Länken kan inte användas', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByText(proposal.name, { exact: true })).toHaveCount(0);
  expect(f.submissions).toHaveLength(0); expect(page.url()).not.toContain(token);
});

async function mobileFixture(page: Page) {
  const personId = 'intake-mobile-person', companyId = 'intake-browser-company';
  let data: DemoData = { version: 1, customers: [], drafts: [{ id: draftId, number: 9010, siteId: 'main', mode: 'direct', status: 'draft',
    createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z', reference: '', origin: '',
    rows: [{ id: 'original-row', articleId: 'copper-1', method: 'direct', weight: 10 }] }] };
  let intake: CustomerIntake | null = null, revision = 1;
  let writeGate: Promise<void> | undefined;
  const creates: Request[] = [], applies: Request[] = [], mobileWrites: Request[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/platform/tenant-context') return route.fulfill({ json: { companyId, companyName: 'Mobilintag AB' } });
    if (url.pathname === '/api/employee/fleet') return route.fulfill({ json: emptyEmployeeFleet(personId) });
    if (url.pathname === staffPath || url.pathname.startsWith(`${staffPath}/`)) {
      expect(request.headers()['x-employee-company']).toBe(companyId);
      expect(request.headers()['x-employee-person']).toBe(personId);
      if (request.method() === 'GET') return route.fulfill({ json: { intake, terminals: [{ id: 'terminal-1', name: 'Kassan', siteId: 'main', available: true }], smsConfigured: true } });
      if (url.pathname === staffPath) {
        creates.push(request); intake = { id: 'mobile-intake', draftId, channel: 'sms', status: 'waiting', expiresAt: expiresAt(), recipientMasked: '+46••••4567' };
        return route.fulfill({ json: { intake } });
      }
      if (url.pathname.endsWith('/apply')) {
        applies.push(request);
        const customer = { id: 'intake-created-customer', ...proposal, references: [], origins: [] };
        intake = { ...intake!, status: 'applied' }; revision++;
        const latest = data.drafts[0];
        const draftPatch = { id: draftId, customerId: customer.id, reference: latest.reference, origin: latest.origin, updatedAt: latest.updatedAt };
        data = { ...data, customers: [customer], drafts: data.drafts.map(draft => draft.id === draftId ? { ...draft, ...draftPatch } : draft) };
        return route.fulfill({ json: { intake, customer, draftPatch, revision } });
      }
      return route.fulfill({ status: 409, json: { error: 'Kommandot ingår inte i provet.' } });
    }
    if (url.pathname.startsWith('/api/employee/')) return route.fulfill({ json: { companyId, companyName: 'Mobilintag AB',
      person: { id: personId, name: 'Gårdsmedarbetare', role: 'Invägare', team: 'Gården', siteIds: ['main'] },
      capabilities: { yardWork: true, employeeTime: true, assignedOrders: false, paymentDetails: true },
      activeSiteId: 'main', sites: [{ id: 'main', name: 'Huvudanläggningen', active: true }],
      today: '2026-10-20', month: '2026-10', date: '2026-10-20', gate: { blocked: false },
      days: [], orders: [], selectedDay: { schedules: [], absences: [], entries: [], orders: [] } } });
    if (url.pathname === '/api/application/mobile') {
      if (request.method() === 'POST') {
        mobileWrites.push(request);
        const gate = writeGate; writeGate = undefined; await gate;
        const command = request.postDataJSON();
        for (const field of ['customers', 'drafts'] as const) for (const change of command[field] || [])
          data = { ...data, [field]: [...data[field].filter(value => value.id !== change.id), ...(change.next ? [change.next] : [])] };
        revision++;
      }
      return route.fulfill({ json: { data, revision, catalog: [{ id: 'copper-1', active: true, category: 'koppar', name: 'Testkoppar',
        description: '', includes: '', excludes: '', photos: [0], prices: [1, 1, 1] }], groups: [{ id: 'koppar', name: 'Koppar',
        description: '', photo: 0, sortOrder: 0, active: true, revision: 1 }] } });
    }
    return route.fulfill({ json: { revision } });
  });
  return { creates, applies, mobileWrites, data: () => data,
    holdWrite: () => { let release = () => {}; writeGate = new Promise<void>(resolve => { release = resolve; }); return release; },
    submit: () => { intake = { ...intake!, status: 'submitted', proposal, hasPaymentProfile: true }; },
    changeWeight: () => { data = { ...data, drafts: data.drafts.map(draft => ({ ...draft,
      rows: [{ ...draft.rows[0], method: 'direct', weight: 37 }, { id: 'concurrent-row', articleId: 'copper-1', method: 'direct', weight: 5 }] })) }; revision++; } };
}

test('mobilen väntar på sparat utkast före SMS och behåller fortsatt vägning när kundförslaget används', async ({ page }) => {
  const f = await mobileFixture(page);
  await page.goto(`/#/weigh/${draftId}/summary`);
  await expect(page.getByRole('heading', { name: 'Sammanställning', exact: true })).toBeVisible();
  await expect(page.getByTestId('total-weight')).toHaveText('10 kg');
  const release = f.holdWrite();
  await page.getByRole('button', { name: 'Ändra Testkoppar', exact: true }).click();
  await page.getByRole('textbox', { name: 'Vikt i kg', exact: true }).fill('37');
  await page.getByRole('button', { name: 'Färdigvägt', exact: true }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('37 kg');
  await page.getByRole('button', { name: /Lägg till kund/ }).click();
  await page.getByRole('button', { name: 'Låt kunden fylla i', exact: true }).click();
  await page.getByRole('button', { name: 'SMS', exact: true }).click();
  await page.getByLabel('Kundens mobilnummer', { exact: true }).fill('0701234567');
  await page.getByRole('button', { name: 'Skicka formulär via SMS', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Skickar förfrågan…', exact: true })).toBeVisible();
  expect(f.creates).toHaveLength(0);
  release();
  await expect(page.getByRole('heading', { name: 'Inväntar kunduppgifter', exact: true })).toBeVisible();
  expect(f.creates).toHaveLength(1);
  expect(f.creates[0].postDataJSON()).toMatchObject({ draftId, channel: 'sms', phone: '0701234567', expectedCustomerId: null });
  expect(f.data().drafts[0].rows[0]).toMatchObject({ weight: 37 });
  await page.getByRole('button', { name: 'Fortsätt utan ändring', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Spara färdig vägning', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Lägg till material', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Spara utkast', exact: true })).toBeEnabled();
  f.changeWeight(); f.submit();
  await page.reload();
  await expect(page.getByTestId('total-weight')).toHaveText('42 kg');
  await expect(page.getByRole('heading', { name: 'Kunduppgifter mottagna', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Granska kunduppgifter', exact: true }).click();
  await page.getByRole('button', { name: 'Granska kunduppgifter', exact: true }).click();
  await expect(page.getByText(proposal.name, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Använd kunduppgifterna', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vald kund', exact: true })).toBeVisible();
  expect(f.applies).toHaveLength(1);
  expect(f.data().drafts[0].rows).toHaveLength(2);
  expect(f.data().drafts[0].rows[0]).toMatchObject({ weight: 37 });
  expect(f.data().drafts[0].rows[1]).toMatchObject({ weight: 5 });
  await page.getByRole('button', { name: 'Klar', exact: true }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('42 kg');
  await expect(page.getByRole('button', { name: 'Spara färdig vägning', exact: true })).toBeEnabled();
});

test('kundterminalen visar eget formulär och rensar namn och bankfält innan nästa kund', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as typeof window & { intakeStreams: EventTarget[] }; host.intakeStreams = [];
    class Stream extends EventTarget {
      static OPEN = 1; readyState = 1; onmessage = null; onerror = null;
      constructor() { super(); host.intakeStreams.push(this); }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { value: Stream });
  });
  let session: TerminalSessionState = { terminal: { id: 'intake-terminal', name: 'Kassan', username: 'kassan', siteId: 'main',
    active: true, online: true, busy: true, busyKind: 'intake', activeIntakeId: 'terminal-first-intake' },
    approval: null, revision: 1, connectionId: 'terminal-intake-epoch' };
  const submissions: Request[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/platform/tenant-context') return route.fulfill({ json: { companyId: 'intake-company', companyName: 'Terminalintag AB' } });
    if (path === '/api/terminal-demo/session') return route.fulfill({ json: session });
    if (path === '/api/terminal-demo/heartbeat') return route.fulfill({ json: { alive: true, revision: session.revision } });
    if (path.startsWith('/api/terminal-demo/customer-intake')) {
      if (request.method() === 'POST') submissions.push(request);
      return route.fulfill({ json: { company: { name: 'Terminalintag AB' }, intake: { id: session.terminal.activeIntakeId,
        status: request.method() === 'POST' ? 'submitted' : 'waiting', expiresAt: expiresAt() } } });
    }
    return route.fulfill({ status: 404, json: { error: 'Endast terminalens eget formulär ingår.' } });
  });
  await page.goto('/terminal');
  await expect(page.getByRole('heading', { name: 'Fyll i dina uppgifter', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Granska och godkänn din avräkning', exact: true })).toHaveCount(0);
  await fillContact(page);
  await page.getByRole('checkbox', { name: 'Lägg till bankuppgifter', exact: true }).check();
  await page.getByLabel('Clearingnummer', { exact: true }).fill('8327');
  await page.getByLabel('Kontonummer', { exact: true }).fill('00123456789');
  await page.getByLabel('Kontohavare', { exact: true }).fill(proposal.name);
  await page.getByRole('button', { name: 'Skicka mina uppgifter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tack, uppgifterna är skickade', exact: true })).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0].postDataJSON()).toMatchObject({ id: 'terminal-first-intake', customer: { name: proposal.name } });
  await expect(page.getByRole('textbox')).toHaveCount(0);
  session = { ...session, revision: 2, terminal: { ...session.terminal, activeIntakeId: 'terminal-next-intake' } };
  await page.evaluate(value => {
    const host = window as typeof window & { intakeStreams: EventTarget[] };
    host.intakeStreams.at(-1)?.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(value) }));
  }, session);
  await expect(page.getByRole('heading', { name: 'Fyll i dina uppgifter', exact: true })).toBeVisible();
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: 'Lägg till bankuppgifter', exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveCount(0);
  await expect(page.getByText(proposal.name, { exact: true })).toHaveCount(0);
});
