import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import type { OfficeCustomer } from '../src/office/model';
import type { PersonnelCommand, PersonnelResponse } from '../src/office/personnel/types';
import type { EnvironmentalReceiptInput, EnvironmentSessionState, EnvironmentState } from '../src/office/environment-types';
import type {
  CustomerPortalRequest, CustomerPortalState, LogisticsOfficeCommand,
  LogisticsOfficeState, LogisticsPlace, LogisticsVessel,
} from '../src/office/logistics/types';
import { addDays, today } from '../src/office/transport/model';
import { createOfficeCard, readOffice, saveOffice } from './helpers/financial-card';
import { approveCustomerCard } from './helpers/customer-approval';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(75_000);
test.describe.configure({ mode: 'serial' });

const admin = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
async function json<T>(request: APIRequestContext, path: string, data?: unknown, headers?: Record<string, string>): Promise<T> {
  const response = data === undefined ? await request.get(path, { headers }) : await request.post(path, { headers, data });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return response.json();
}
const officeState = (request: APIRequestContext) => json<LogisticsOfficeState>(request, '/api/logistics/office', undefined, admin);
const command = (request: APIRequestContext, data: LogisticsOfficeCommand) => json<LogisticsOfficeState>(request, '/api/logistics/office', data, admin);
async function office(page: Page, route?: string) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  if (route) await page.goto(`/kontor#/${route}`);
}
async function portal(browser: Browser, origin: string, path: string, username: string, password: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}${path}`);
  await page.getByLabel('Inloggningsnamn', { exact: true }).fill(username);
  await page.getByLabel('Lösenord', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Logga in', exact: true }).click();
  return { context, page, errors };
}
function customerPlace(customer: OfficeCustomer): LogisticsPlace {
  return { name: customer.name, number: customer.number, address: customer.address ?? 'Testgatan 12',
    postalCode: customer.postalCode ?? '76141', city: customer.city ?? 'Norrtälje', phone: customer.phone, contact: customer.contactPerson ?? '' };
}
async function fixture(request: APIRequestContext, page?: Page, action: 'exchange' | 'pickup' = 'exchange') {
  const suffix = randomUUID().slice(0, 8), base = await readOffice(request);
  const customer: OfficeCustomer = { ...structuredClone(base.customers.find(value => value.type === 'Företag')!),
    id: `logistics-customer-${suffix}`, name: `Portalbolag ${suffix}`, customerNumber: `E2E-${suffix}`,
    address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', email: `${suffix}@example.invalid` };
  const next = structuredClone(base); next.customers.push(customer); await saveOffice(request, base, next);
  const vessel: LogisticsVessel = { id: `K-${suffix}`, name: `Testkärl ${suffix}`, type: 'battery', size: '600 l',
    siteId: 'norrtalje', active: true, customerId: customer.id, place: customerPlace(customer), status: 'placed',
    materialArticleId: 'iron', version: 0 };
  let agreementId = `agreement-${suffix}`;
  const username = `kund.${suffix}`, password = `Local-${randomUUID()}`;
  if (page) {
    await office(page, 'vessels');
    await page.getByRole('button', { name: 'Nytt kärl', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Nytt kärl', exact: true });
    await dialog.getByLabel('Kärl-ID', { exact: true }).fill(vessel.id);
    await dialog.getByLabel('Kärlets namn', { exact: true }).fill(vessel.name);
    await dialog.getByLabel('Kärltyp', { exact: true }).selectOption(vessel.type);
    await dialog.getByLabel('Kärlets storlek', { exact: true }).fill(vessel.size);
    await dialog.getByLabel('Kärlets anläggning', { exact: true }).selectOption(vessel.siteId);
    await dialog.getByLabel('Kärlets material', { exact: true }).selectOption('iron');
    await dialog.getByLabel('Kärlets befintliga kundplacering', { exact: true }).selectOption(customer.id);
    await dialog.getByRole('button', { name: 'Spara', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: vessel.name, exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Avtal', exact: true }).click();
    await page.getByRole('button', { name: 'Nytt avtal', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Nytt avtal', exact: true });
    await dialog.getByLabel('Avtalets kund', { exact: true }).selectOption(customer.id);
    await dialog.getByLabel('Avtalets kärl', { exact: true }).selectOption(vessel.id);
    await dialog.getByLabel('Avtalets nästa tillfälle', { exact: true }).fill(addDays(today(), 14));
    await dialog.getByLabel('Avtalets intervall i dagar', { exact: true }).fill('14');
    await dialog.getByRole('button', { name: 'Spara', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    agreementId = (await officeState(request)).agreements.find(value => value.vesselId === vessel.id)!.id;
    await page.getByRole('tab', { name: 'Kundportal', exact: true }).click();
    await page.getByRole('button', { name: 'Nytt kundkonto', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Nytt kundkonto', exact: true });
    await dialog.getByLabel('Portalens kund', { exact: true }).selectOption(customer.id);
    await dialog.getByLabel('Kundens användarnamn', { exact: true }).fill(username);
    await dialog.getByLabel('Kundens lösenord', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: 'Spara', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } else {
    await command(request, { action: 'vessel.save', vessel, expectedVersion: 0 });
    await command(request, { action: 'agreement.save', expectedVersion: 0, agreement: {
      id: agreementId, customerId: customer.id, siteId: 'norrtalje', vesselId: vessel.id,
      active: true, action, intervalDays: 14, nextDate: addDays(today(), 14), notes: 'Rullande byte / hämtning i integrationstest',
    } });
    await command(request, { action: 'account.save', account: { kind: 'customer', subjectId: customer.id, username, password, active: true } });
  }
  return { customer, vessel, agreementId, username, password };
}
async function receiveHazardousStock(request: APIRequestContext, customer: OfficeCustomer) {
  // Hazardous stock must originate in the real receipt ledger, not an invented
  // warehouse adjustment or a browser-only inventory cache.
  const fixture = await createOfficeCard(request, { customer, rows: [{ articleId: 'lead-battery', weight: 100, price: 4.5, tier: 'A' }] });
  await approveCustomerCard(request, fixture.card, { customer });
  const session = await json<EnvironmentSessionState>(request, '/api/environment/demo-session', { userId: 'admin', effectiveUserId: 'admin' });
  const state = await json<EnvironmentState>(request, '/api/environment/state');
  const site = state.sites.find(value => value.id === 'norrtalje')!;
  const receipt: EnvironmentalReceiptInput = {
    sourceId: fixture.card.sourceId!, cardId: fixture.cardId, siteId: site.id,
    receivedAt: new Date().toISOString(), materialScope: 'hazardous', originAddress: fixture.card.origin,
    rows: [{ articleId: 'lead-battery', weight: 100 }],
    previousHolder: { name: customer.name, number: customer.number, contactName: '', phone: customer.phone, email: customer.email },
    lastPlace: { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' },
    nextPlace: { address: site.address, postalCode: site.postalCode, city: site.city, municipalityCode: site.municipalityCode },
    transportMode: 'road', incomingDocument: { status: 'not_shown' }, idempotencyKey: randomUUID(),
  };
  await json(request, '/api/environment/receipts', receipt, { 'X-Environment-CSRF': session.csrfToken });
}

test('kundens byte använder en enda gemensam arbetsorder och visar endast egna kärl', async ({ page, browser, request }) => {
  const own = await fixture(request, page), before = await officeState(request);
  const agreementOrder = before.orders.find(value => value.detail.vesselId === own.vessel.id)!;
  expect(agreementOrder).toMatchObject({ status: 'unbooked', action: 'exchange', detail: { source: 'agreement' } });
  const foreign: LogisticsVessel = { ...own.vessel, id: `foreign-${randomUUID()}`, name: 'Ett annat företags kärl',
    customerId: 'customer-brf', agreementId: undefined, version: 0 };
  await command(request, { action: 'vessel.save', vessel: foreign, expectedVersion: 0 });
  const origin = new URL(page.url()).origin;
  const customer = await portal(browser, origin, '/kund', own.username, own.password);
  try {
    await expect(customer.page.getByRole('heading', { name: 'Era kärl & containrar', exact: true })).toBeVisible();
    const state = await json<CustomerPortalState>(customer.page.request, `${origin}/api/customer/state`);
    expect(state.customer.id).toBe(own.customer.id);
    expect(state.vessels.map(value => value.id)).toEqual([own.vessel.id]);
    await expect(customer.page.getByText(foreign.name, { exact: true })).toHaveCount(0);
    expect([401, 403]).toContain((await customer.page.request.get(`${origin}/api/logistics/office`)).status());
    const card = customer.page.getByTestId(`customer-vessel-${own.vessel.id}`);
    await card.getByRole('button', { name: 'Beställ byte', exact: true }).click();
    const dialog = customer.page.getByRole('dialog', { name: 'Beställ byte av kärl', exact: true });
    await dialog.getByLabel('Önskad dag').fill(addDays(today(), 2));
    await dialog.getByLabel('Kommentar (valfri)', { exact: true }).fill('Lådan är full.');
    const sent = customer.page.waitForResponse(response => response.url().endsWith('/api/customer/requests') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Skicka önskemål', exact: true }).click();
    const response = await sent;
    expect(response.ok(), await response.text()).toBe(true);
    const payload = response.request().postDataJSON() as CustomerPortalRequest;
    await expect(card.getByRole('button', { name: 'Önskemål redan skickat', exact: true })).toBeDisabled();
    // A retry after a lost reply must return the same request/order, not create a second AO.
    await json(customer.page.request, `${origin}/api/customer/requests`, payload);
    const after = await officeState(request);
    const requests = after.requests.filter(value => value.customerId === own.customer.id);
    expect(requests).toHaveLength(1);
    const sharedOrders = after.orders.filter(value => value.detail.vesselId === own.vessel.id);
    expect(sharedOrders).toHaveLength(1);
    expect(sharedOrders[0]).toMatchObject({ id: agreementOrder.id, customerId: own.customer.id,
      status: 'unbooked', action: 'exchange', detail: { vesselId: own.vessel.id, source: 'agreement' } });
    expect(after.orders.map(value => value.id).sort()).toEqual(before.orders.map(value => value.id).sort());
    expect(requests[0].orderId).toBe(agreementOrder.id);
    await page.goto('/kontor#/work-orders');
    await expect(page.getByRole('row').filter({ hasText: agreementOrder.id })).toHaveCount(1);
    await page.locator('.office-sidebar').getByRole('button', { name: 'Transportplanering', exact: true }).click();
    await expect(page.getByTestId(`transport-queue-${agreementOrder.id}`)).toHaveCount(1);
    await customer.page.reload();
    await expect(customer.page.getByTestId(`customer-vessel-${own.vessel.id}`)).toContainText('Önskemål redan skickat');
    expect(await customer.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(customer.errors).toEqual([]);
  } finally { await customer.context.close(); }
});

test('önskemål om tidigare hämtning bevarar den bokade arbetsorderns tid och identitet', async ({ page, browser, request }) => {
  const own = await fixture(request, undefined, 'pickup'), initial = await officeState(request);
  const order = initial.orders.find(value => value.detail.vesselId === own.vessel.id)!;
  let date = addDays(today(), 35);
  while (![2, 3, 4].includes(new Date(`${date}T12:00:00Z`).getUTCDay()) || initial.orders.some(value =>
    value.date === date && ['booked', 'on_way'].includes(value.status) && (value.driverId === 'lina' || value.vehicleId === 'vehicle-lina') &&
    (value.startMinute ?? 0) < 660 && (value.startMinute ?? 0) + value.durationMinutes > 600)) date = addDays(date, 1);
  const booked = await command(request, { action: 'order.book', orderId: order.id, expectedVersion: order.detail.version,
    plan: { date, startMinute: 600, durationMinutes: 60, driverId: 'lina', vehicleId: 'vehicle-lina' } });
  const original = booked.orders.find(value => value.id === order.id)!;
  await office(page);
  const origin = new URL(page.url()).origin;
  const customer = await portal(browser, origin, '/kund', own.username, own.password);
  try {
    const card = customer.page.getByTestId(`customer-vessel-${own.vessel.id}`);
    await card.getByRole('button', { name: 'Önska tidigare hämtning', exact: true }).click();
    const dialog = customer.page.getByRole('dialog', { name: 'Önska tidigare hämtning', exact: true });
    await dialog.getByLabel('Önskad dag').fill(addDays(date, -1));
    await dialog.getByRole('button', { name: 'Skicka önskemål', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const after = await officeState(request);
    expect(after.orders.map(value => value.id).sort()).toEqual(booked.orders.map(value => value.id).sort());
    const unchanged = after.orders.find(value => value.id === original.id)!;
    expect(unchanged).toMatchObject({ status: 'booked', date: original.date, startMinute: original.startMinute,
      durationMinutes: original.durationMinutes, driverId: original.driverId, vehicleId: original.vehicleId, bookingVersion: original.bookingVersion });
    const requests = after.requests.filter(value => value.customerId === own.customer.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ type: 'earlier', status: 'pending', orderId: original.id, requestedDate: addDays(date, -1) });
    const ownState = await json<CustomerPortalState>(customer.page.request, `${origin}/api/customer/state`);
    expect(ownState.orders.find(value => value.id === original.id)?.date).toBe(original.date);
    expect(customer.errors).toEqual([]);
  } finally { await customer.context.close(); }
});

test('åkeriet tilldelar chaufför och lastad farlig transport kräver aktuella godkännanden före lageruttag', async ({ page, browser, request }) => {
  const officeErrors: string[] = []; page.on('pageerror', error => officeErrors.push(error.message));
  const own = await fixture(request), suffix = randomUUID().slice(0, 8);
  const carrierId = `carrier-${suffix}`, personId = `driver-person-${suffix}`;
  const carrierUsername = `akeri.${suffix}`, driverUsername = `chauffor.${suffix}`, password = `Local-${randomUUID()}`;
  const personnel = (data: PersonnelCommand) => json<PersonnelResponse>(request, '/api/application/personnel', data, admin);
  await personnel({ action: 'company.save', company: { id: carrierId, name: `Åkeri ${suffix}`,
    number: '559123-7890', contact: 'Testledare', phone: '070-000 00 00', email: `${suffix}@example.invalid` } });
  const createdPerson = await personnel({ action: 'person.save', person: { id: personId, name: `Chaufför ${suffix}`,
    kind: 'external', companyId: carrierId, canDrive: true, vehicleId: 'vehicle-oskar', siteIds: ['norrtalje'] },
    createAccount: { kind: 'external', username: driverUsername, password } });
  const driverId = createdPerson.data.people.find(value => value.id === personId)!.driverId!;
  await personnel({ action: 'competency.save', competency: { personId, type: 'license', name: 'Körkort C / CE',
    codes: ['C', 'CE'], scope: 'Tung lastbil', validFrom: '2020-01-01', validTo: '2030-01-01', verified: true } });
  await personnel({ action: 'competency.save', competency: { personId, type: 'ykb', name: 'YKB',
    codes: ['goods'], scope: 'Godstransporter', validFrom: '2020-01-01', validTo: '2030-01-01', verified: true } });
  await command(request, { action: 'account.save', account: { kind: 'carrier', subjectId: carrierId,
    username: carrierUsername, password, active: true } });
  await receiveHazardousStock(request, own.customer);
  const initial = await officeState(request), site = initial.sites.find(value => value.id === 'norrtalje')!;
  const created = await command(request, { action: 'order.create', idempotencyKey: randomUUID(), input: {
    siteId: site.id, action: 'outbound', operator: 'external', carrierId, customerId: own.customer.id,
    from: { name: `JEROC · ${site.name}`, address: site.address, postalCode: site.postalCode, city: site.city },
    to: customerPlace(own.customer), vesselType: 'battery', materialRows: [{ articleId: 'lead-battery', plannedKg: 25 }],
    requestedWindow: { date: addDays(today(), 3) }, handling: 'Batterierna står upprätt i ett tätt, märkt kärl.',
  } });
  const order = created.orders.find(value => !initial.orders.some(old => old.id === value.id))!;
  const initialStock = initial.stock.find(value => value.siteId === site.id && value.articleId === 'lead-battery')!;
  const reservedStock = created.stock.find(value => value.siteId === site.id && value.articleId === 'lead-battery')!;
  expect(reservedStock.onHandKg).toBe(initialStock.onHandKg);
  expect(reservedStock.reservedKg).toBe(initialStock.reservedKg + 25);
  expect(reservedStock.availableKg).toBe(initialStock.availableKg - 25);
  await command(request, { action: 'order.send', orderId: order.id, expectedVersion: order.detail.version });
  await office(page);
  const origin = new URL(page.url()).origin;
  const carrier = await portal(browser, origin, '/akeri', carrierUsername, password);
  let driver: Awaited<ReturnType<typeof portal>> | undefined;
  try {
    const carrierCard = carrier.page.locator('.carrier-order').filter({ hasText: order.id });
    await expect(carrierCard).toHaveCount(1);
    await carrierCard.getByRole('button', { name: 'Acceptera uppdrag', exact: true }).click();
    await expect(carrier.page.getByText('Uppdraget är accepterat.', { exact: true })).toBeVisible();
    await carrierCard.getByLabel(`Chaufför ${order.id}`, { exact: true }).selectOption(driverId);
    await carrierCard.getByLabel(`Fordon ${order.id}`, { exact: true }).selectOption('vehicle-oskar');
    await carrierCard.getByRole('button', { name: 'Tilldela förare', exact: true }).click();
    await expect(carrier.page.getByText('Chauffören är tilldelad uppdraget.', { exact: true })).toBeVisible();
    const assigned = (await officeState(request)).orders.find(value => value.id === order.id)!;
    expect(assigned.detail).toMatchObject({ carrierRequest: { status: 'accepted' }, assignedDriverId: driverId });
    driver = await portal(browser, origin, '/chauffor', driverUsername, password);
    const driverCard = driver.page.locator('.driver-order').filter({ hasText: order.id });
    await expect(driver.page.locator('.driver-order-number')).toHaveCount(1);
    await driverCard.getByRole('button', { name: 'Visa uppgifter', exact: true }).click();
    await driverCard.getByRole('button', { name: 'På väg till lastning', exact: true }).click();
    await driverCard.getByRole('button', { name: 'Jag är på lastningsplatsen', exact: true }).click();
    await driverCard.getByLabel('Lastad vikt Blybatterier', { exact: true }).fill('24');
    await driverCard.getByRole('button', { name: 'Spara lastade vikter', exact: true }).click();
    await expect(driverCard.getByRole('button', { name: 'Påbörja transport med last', exact: true })).toBeDisabled();
    const loaded = await officeState(request), loadedOrder = loaded.orders.find(value => value.id === order.id)!;
    expect(loadedOrder.detail.execution.stage).toBe('loaded');
    expect(loadedOrder.detail.materialRows[0].actualKg).toBe(24);
    const stockBefore = loaded.stock.find(value => value.siteId === site.id && value.articleId === 'lead-battery')!;
    expect(stockBefore.onHandKg).toBe(initial.stock.find(value => value.siteId === site.id && value.articleId === 'lead-battery')!.onHandKg);
    const blocked = await driver.page.request.post(`${origin}/api/driver/orders/${order.id}/logistics`, {
      data: { action: 'depart', expectedVersion: loadedOrder.detail.version },
    });
    expect(blocked.status()).toBeGreaterThanOrEqual(400); expect(blocked.status()).toBeLessThan(500);
    expect((await officeState(request)).inventoryMovements.filter(value => value.kind === 'outbound' && value.sourceId === order.id)).toHaveLength(0);
    let current = await command(request, { action: 'order.clearance', orderId: order.id, expectedVersion: loadedOrder.detail.version, cleared: true });
    let detail = current.orders.find(value => value.id === order.id)!.detail;
    current = await command(request, { action: 'order.document', orderId: order.id, expectedVersion: detail.version });
    detail = current.orders.find(value => value.id === order.id)!.detail;
    await command(request, { action: 'order.sign', orderId: order.id, expectedVersion: detail.version, role: 'sender', documentVersion: detail.document!.version });
    await driver.page.getByRole('button', { name: 'Uppdatera uppdrag', exact: true }).click();
    await driverCard.getByRole('checkbox', { name: 'Jag har granskat transportuppgifterna för denna version.', exact: true }).check();
    await driverCard.getByRole('button', { name: 'Godkänn som transportör (demo)', exact: true }).click();
    await expect(driverCard.getByRole('button', { name: 'Påbörja transport med last', exact: true })).toBeEnabled();
    await driverCard.getByRole('button', { name: 'Påbörja transport med last', exact: true }).click();
    await expect(driverCard.getByRole('button', { name: 'Bekräfta leverans', exact: true })).toBeVisible();
    const departed = await officeState(request);
    expect(departed.orders.find(value => value.id === order.id)!.detail.execution.stage).toBe('departed');
    expect(departed.inventoryMovements.filter(value => value.kind === 'outbound' && value.sourceId === order.id)).toHaveLength(1);
    expect(departed.stock.find(value => value.siteId === site.id && value.articleId === 'lead-battery')!.onHandKg).toBe(stockBefore.onHandKg - 24);
    await driverCard.getByRole('button', { name: 'Bekräfta leverans', exact: true }).click();
    await expect(driverCard).toHaveCount(0);
    const delivered = await officeState(request);
    expect(delivered.orders.find(value => value.id === order.id)).toMatchObject({ status: 'done', detail: { execution: { stage: 'delivered' } } });
    expect(delivered.inventoryMovements.filter(value => value.kind === 'outbound' && value.sourceId === order.id)).toHaveLength(1);
    expect(delivered.stock.find(value => value.siteId === site.id && value.articleId === 'lead-battery')!.onHandKg).toBe(stockBefore.onHandKg - 24);
    // An external order may finish without an internal calendar slot. The
    // ordinary transport store must still parse/reload that completed order.
    const transport = await json<{ data: { orders: { id: string; status: string }[] } }>(request, '/api/application/transport', undefined, admin);
    expect(transport.data.orders.find(value => value.id === order.id)?.status).toBe('done');
    await page.goto('/kontor#/work-orders');
    await page.reload();
    await page.getByRole('button', { name: 'Historik', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: order.id })).toHaveCount(1);
    await page.goto('/kontor#/transport');
    await expect(page.getByTestId('transport-workspace')).toBeVisible();
    await expect(page.getByTestId(`transport-queue-${order.id}`)).toHaveCount(0);
    expect(await driver.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(carrier.errors).toEqual([]); expect(driver.errors).toEqual([]); expect(officeErrors).toEqual([]);
  } finally { await driver?.context.close(); await carrier.context.close(); }
});
