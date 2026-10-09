import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import type { PersonnelResponse } from '../src/office/personnel/types';
import { applyTransportChange } from '../src/office/transport/model';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(75_000);
test.describe.configure({ mode: 'serial' });

const adminHeaders = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
async function office(page: Page) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await page.goto('/kontor#/personnel');
  await expect(page.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible();
}
async function personnel(page: Page): Promise<PersonnelResponse> {
  const response = await page.request.get('/api/application/personnel', { headers: adminHeaders });
  expect(response.ok()).toBe(true);
  return response.json();
}

test('person skapas och redigeras genom kontoret och bevaras vid omladdning', async ({ page }) => {
  await office(page);
  const name = `Testpersonal ${randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'Lägg till person', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Lägg till person', exact: true });
  await create.getByLabel('Namn *', { exact: true }).fill(name);
  await create.getByLabel('Befattning', { exact: true }).fill('Kontorist');
  await create.getByLabel('Team', { exact: true }).fill('Kontor');
  await create.getByLabel('Telefon', { exact: true }).fill('070-000 12 34');
  await create.getByRole('checkbox', { name: 'Skapa inloggning', exact: true }).uncheck();
  await create.getByRole('button', { name: 'Spara person', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const created = (await personnel(page)).data.people.find(person => person.name === name)!;
  expect(created.role).toBe('Kontorist');
  expect(created.canDrive).toBe(false);
  await page.reload();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByText('070-000 12 34', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Redigera', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Redigera person', exact: true });
  await edit.getByLabel('Befattning', { exact: true }).fill('Kontorist / attest');
  await edit.getByLabel('Telefon', { exact: true }).fill('070-000 56 78');
  await edit.getByRole('button', { name: 'Spara person', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('070-000 56 78', { exact: true })).toBeVisible();
  const saved = (await personnel(page)).data.people.find(person => person.id === created.id)!;
  expect(saved.name).toBe(name);
  expect(saved.role).toBe('Kontorist / attest');
  expect(saved.phone).toBe('070-000 56 78');
  expect(saved.revision).toBeGreaterThan(created.revision);
});

test('frånvaro bevarar tre bokningar och endast tillgänglig ersättare kan tilldelas', async ({ page }) => {
  await office(page);
  const initial = await personnel(page);
  const orderIds = ['AO-1201', 'AO-1202', 'AO-1203'];
  const originals = initial.transport.orders.filter(order => orderIds.includes(order.id));
  expect(originals).toHaveLength(3);
  expect(originals.every(order => order.driverId === 'kalle' && order.status === 'booked')).toBe(true);
  const day = originals[0].date!;
  expect(originals.every(order => order.date === day)).toBe(true);
  await page.goto('/kontor#/personnel/person-kalle/schedule');
  await expect(page.getByRole('heading', { name: 'Kalle Nilsson', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Registrera frånvaro', exact: true }).click();
  const absence = page.getByRole('dialog', { name: 'Registrera frånvaro', exact: true });
  await absence.getByLabel('Från', { exact: true }).fill(day);
  await absence.getByLabel('Till', { exact: true }).fill(day);
  await absence.getByRole('button', { name: 'Kontrollera påverkan', exact: true }).click();
  await expect(absence).toContainText('3 bokade uppdrag berörs');
  for (const id of orderIds) await expect(absence).toContainText(id);
  await absence.getByRole('button', { name: 'Registrera frånvaro', exact: true }).click();
  await expect(absence).toHaveCount(0);
  const withAbsence = await personnel(page);
  expect(withAbsence.data.staffingTasks.filter(task => task.status === 'open' && orderIds.includes(task.orderId))).toHaveLength(3);
  for (const before of originals) expect(withAbsence.transport.orders.find(order => order.id === before.id)).toMatchObject({ driverId: 'kalle', date: before.date, startMinute: before.startMinute, durationMinutes: before.durationMinutes, customerName: before.customerName });
  await page.goto('/kontor#/personnel/tasks');
  await expect(page.getByRole('heading', { name: 'Bemanning att lösa', exact: true })).toBeVisible();
  for (const id of orderIds) await page.getByLabel(`Välj ${id}`, { exact: true }).check();
  await page.getByRole('button', { name: 'Välj ersättare · 3 uppdrag', exact: true }).click();
  const replacement = page.getByRole('dialog', { name: 'Välj ersättare', exact: true });
  await expect(replacement.getByRole('radio', { name: /Johan Svensson/ })).toBeDisabled();
  await expect(replacement.getByRole('radio', { name: /Lina Eriksson/ })).toBeEnabled();
  await replacement.getByRole('radio', { name: /Lina Eriksson/ }).check();
  await replacement.getByRole('button', { name: 'Tilldela Lina · 3 uppdrag', exact: true }).click();
  await expect(replacement).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Historik', exact: true })).toHaveAttribute('aria-selected', 'true');
  const assigned = await personnel(page);
  for (const before of originals) expect(assigned.transport.orders.find(order => order.id === before.id)).toMatchObject({ driverId: 'lina', date: before.date, startMinute: before.startMinute, durationMinutes: before.durationMinutes, customerName: before.customerName, address: before.address, material: before.material, status: 'booked' });
  const tasks = assigned.data.staffingTasks.filter(task => orderIds.includes(task.orderId));
  expect(tasks).toHaveLength(3);
  expect(tasks.every(task => task.status === 'resolved' && task.replacementPersonId === 'person-lina')).toBe(true);
  await page.reload();
  await page.getByRole('tab', { name: 'Historik', exact: true }).click();
  for (const id of orderIds) await expect(page.getByRole('row').filter({ hasText: id })).toContainText('Lina Eriksson');
});

test('admin skapar externt chaufförskonto med separat cookie och bara egna uppdrag', async ({ page, browser }) => {
  await office(page);
  const username = `oskar.e2e.${randomUUID().slice(0, 8)}`;
  const password = `Demo-${randomUUID()}`;
  const initial = await personnel(page);
  const firstOrder = initial.transport.orders.find(order => order.driverId === 'oskar' && order.status === 'booked')!;
  const nextTransport = applyTransportChange(initial.transport, {
    type: 'reschedule', id: firstOrder.id,
    plan: { date: '2026-10-09', startMinute: 540, durationMinutes: firstOrder.durationMinutes, driverId: firstOrder.driverId!, vehicleId: firstOrder.vehicleId! },
  }, { canPlan: true, actor: 'Systemadmin', actualUserId: 'admin', effectiveUserId: 'admin' });
  const planned = await page.request.post('/api/application/transport', { headers: adminHeaders, data: { base: initial.transport, next: nextTransport } });
  expect(planned.ok(), await planned.text()).toBe(true);
  const ownIds = initial.transport.orders.filter(order => order.driverId === 'oskar').map(order => order.id).sort();
  const foreignOrder = initial.transport.orders.find(order => order.driverId && order.driverId !== 'oskar')!;
  expect(ownIds.length).toBeGreaterThan(0);
  await page.goto('/kontor#/personnel/person-oskar/overview');
  await expect(page.getByRole('heading', { name: 'Oskar Lind', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hantera konto', exact: true }).click();
  await page.getByRole('button', { name: 'Skapa inloggning', exact: true }).click();
  const account = page.getByRole('dialog', { name: 'Extern chaufför · användarkonto', exact: true });
  await account.getByLabel('Användarnamn *', { exact: true }).fill(username);
  await account.getByLabel(/lösenord/i).fill(password);
  await account.getByRole('button', { name: 'Spara konto', exact: true }).click();
  await expect(account).toContainText('Kontot är sparat. Lösenordet visas inte igen.');
  const origin = new URL(page.url()).origin;
  const driverContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const driver = await driverContext.newPage();
    await driver.goto(`${origin}/chauffor`);
    await driver.getByLabel('Inloggningsnamn', { exact: true }).fill(username);
    await driver.getByLabel('Lösenord', { exact: true }).fill(password);
    await driver.getByRole('button', { name: 'Logga in', exact: true }).click();
    await expect(driver.getByRole('heading', { name: 'Hej, Oskar', exact: true })).toBeVisible();
    await expect(driver.locator('.driver-order-number')).toHaveCount(ownIds.length);
    expect((await driver.locator('.driver-order-number').allTextContents()).sort()).toEqual(ownIds);
    const cookie = (await driverContext.cookies()).find(value => value.name === 'jeroc_driver')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/api/driver');
    await driver.reload();
    await expect(driver.getByRole('heading', { name: 'Hej, Oskar', exact: true })).toBeVisible();
    const forbidden = await driver.request.post(`${origin}/api/driver/orders/${foreignOrder.id}/status`, { data: { status: 'on_way' } });
    expect(forbidden.status()).toBe(403);
    const hr = await driver.request.get(`${origin}/api/application/personnel`);
    expect([401, 403]).toContain(hr.status());
    const card = driver.locator('.driver-order').filter({ hasText: firstOrder.id });
    await card.getByRole('button', { name: 'Jag är på väg', exact: true }).click();
    await card.getByRole('button', { name: 'Markera uppdrag som klart', exact: true }).click();
    await expect(card).toHaveCount(0);
    await driver.getByRole('tab', { name: 'Avslutade', exact: true }).click();
    await expect(driver.locator('.driver-order').filter({ hasText: firstOrder.id })).toContainText('Klart');
    expect((await personnel(page)).transport.orders.find(order => order.id === firstOrder.id)?.status).toBe('done');
    expect(await driver.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(password);
    expect(await driver.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await driver.getByRole('button', { name: 'Logga ut chaufför', exact: true }).click();
    await expect(driver.getByRole('heading', { name: 'Dina uppdrag hos JEROC', exact: true })).toBeVisible();
    expect((await driver.request.get(`${origin}/api/driver/session`)).status()).toBe(401);
  } finally { await driverContext.close(); }
});
