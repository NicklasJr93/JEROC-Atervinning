import { test, expect, type Locator, type Page } from '@playwright/test';
import { addDays, monday } from '../src/office/transport/model';
import type { TransportData, TransportOrder } from '../src/office/transport/types';

test.use({ viewport: { width: 1920, height: 1080 }, isMobile: false, hasTouch: false });

async function transport(page: Page, user = 'Kajsa Nilsson') {
  // The map's independently hosted background must not decide whether booking works.
  await page.route('https://*.tile.openstreetmap.org/**', (route) => route.abort());
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(user) }).click();
  await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
  await page.locator('.office-sidebar').getByRole('button', { name: 'Transportplanering', exact: true }).click();
  await expect(page.getByTestId('transport-workspace')).toBeVisible();
  await expect.poll(async () => Boolean(await page.evaluate(() => localStorage.getItem('jeroc.transport.demo.v1')))).toBe(true);
}

async function saved(page: Page): Promise<TransportData> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('jeroc.transport.demo.v1')!));
}

async function order(page: Page, id: string): Promise<TransportOrder> {
  return (await saved(page)).orders.find((item) => item.id === id)!;
}

const calendarCard = (page: Page, id: string) => page.getByTestId(`calendar-order-${id}`);
const pin = (page: Page, id: string) => page.getByTestId(`transport-pin-${id}`);
const queueCard = (page: Page, id: string) => page.getByTestId(`transport-queue-${id}`);
const editor = (page: Page) => page.locator('.transport-order-editor');

async function openCalendarOrder(page: Page, id: string) {
  await calendarCard(page, id).locator('.tc-order-open').click();
  await expect(page.getByRole('heading', { name: `Arbetsorder ${id}`, exact: true })).toBeVisible();
}

async function closeDetails(page: Page) {
  await page.getByRole('button', { name: 'Stäng arbetsorder', exact: true }).click();
}

async function savePlanAndConfirm(page: Page) {
  await editor(page).getByRole('button', { name: 'Spara planering', exact: true }).click();
  await page.getByRole('button', { name: 'Bekräfta bokning', exact: true }).click();
}

async function dropAt(page: Page, source: Locator, driverId: string, date: string, minute: number) {
  const slot = page.getByTestId(`calendar-slot-${driverId}-${date}`);
  const rect = await slot.boundingBox();
  if (!rect) throw new Error(`${driverId}s kalender är inte synlig.`);
  await source.dragTo(slot, { sourcePosition: { x: 4, y: 14 }, targetPosition: { x: rect.width * (minute - 420) / 600, y: rect.height / 2 } });
}

async function resizeBy(page: Page, slider: Locator, pixels: number, vertical = false) {
  const rect = await slider.boundingBox();
  if (!rect) throw new Error('Tidsåtgångens draghandtag är inte synligt.');
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (vertical ? 0 : pixels), y + (vertical ? pixels : 0), { steps: 6 });
  await page.mouse.up();
}

test('karta, kalender och obokade arbeten delar hover och samma arbetsordersdetaljer', async ({ page }) => {
  await transport(page);
  await expect(page.locator('.office-sidebar')).toBeHidden();
  await expect(page.locator('.office-search')).toBeHidden();

  await calendarCard(page, 'AO-1042').hover();
  await expect(pin(page, 'AO-1042')).toHaveClass(/is-hovered/);
  await pin(page, 'AO-1042').hover();
  await expect(calendarCard(page, 'AO-1042')).toHaveClass(/is-hovered/);
  await queueCard(page, 'AO-1043').hover();
  await expect(pin(page, 'AO-1043')).toHaveClass(/is-hovered/);
  await pin(page, 'AO-1043').hover();
  await expect(queueCard(page, 'AO-1043')).toHaveClass(/is-hovered/);

  await pin(page, 'AO-1043').click();
  await expect(page.getByRole('heading', { name: 'Arbetsorder AO-1043', exact: true })).toBeVisible();
  await expect(page.getByTestId('transport-workspace')).toContainText('Verkstadsvägen 12');
  await expect(pin(page, 'AO-1043')).toHaveClass(/is-selected/);
  await closeDetails(page);
  await queueCard(page, 'AO-1043').click();
  await expect(page.getByRole('heading', { name: 'Arbetsorder AO-1043', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(queueCard(page, 'AO-1043')).toBeVisible();
  await expect(pin(page, 'AO-1043')).not.toHaveClass(/is-selected/);
});

test('förarceller växlar flera karturval utan att gömma kalenderns arbeten eller obokade uppdrag', async ({ page }) => {
  await transport(page);
  const oskar = page.getByRole('button', { name: 'Visa Oskar på kartan', exact: true });
  const kalle = page.getByRole('button', { name: 'Visa Kalle på kartan', exact: true });
  const maria = page.getByRole('button', { name: 'Visa Maria på kartan', exact: true });
  await expect(oskar).toHaveAttribute('aria-pressed', 'true');
  await expect(kalle).toHaveAttribute('aria-pressed', 'true');
  await expect(maria).toHaveAttribute('aria-pressed', 'true');
  await kalle.click();
  await maria.click();
  await expect(kalle).toHaveAttribute('aria-pressed', 'false');
  await expect(pin(page, 'AO-1042')).toHaveCount(0);
  await expect(pin(page, 'AO-1050')).toHaveCount(0);
  await expect(pin(page, 'AO-1101')).toBeVisible();
  await expect(pin(page, 'AO-1043')).toBeVisible();
  await expect(calendarCard(page, 'AO-1042')).toHaveCSS('opacity', '1');
  await expect(calendarCard(page, 'AO-1050')).toBeVisible();
  await kalle.click();
  await expect(pin(page, 'AO-1042')).toBeVisible();
  await expect(pin(page, 'AO-1050')).toHaveCount(0);
  await page.getByRole('button', { name: 'Vecka', exact: true }).click();
  await page.getByRole('button', { name: 'Visa Maria på kartan', exact: true }).first().click();
  await expect(pin(page, 'AO-1050')).toBeVisible();
  for (const button of await page.getByRole('button', { name: 'Visa Maria på kartan', exact: true }).all()) {
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
});

test('samma arbetsorder kan avmarkeras från både kartan och kalendern', async ({ page }) => {
  await transport(page);
  const heading = page.getByRole('heading', { name: 'Arbetsorder AO-1042', exact: true });
  await pin(page, 'AO-1042').click();
  await expect(heading).toBeVisible();
  await expect(calendarCard(page, 'AO-1042').locator('.tc-order-open')).toHaveAttribute('aria-pressed', 'true');
  await calendarCard(page, 'AO-1042').locator('.tc-order-open').click();
  await expect(heading).toHaveCount(0);
  await expect(pin(page, 'AO-1042')).not.toHaveClass(/is-selected/);
  await expect(queueCard(page, 'AO-1043')).toBeVisible();
  await openCalendarOrder(page, 'AO-1042');
  await pin(page, 'AO-1042').click();
  await expect(heading).toHaveCount(0);
  await expect(calendarCard(page, 'AO-1042').locator('.tc-order-open')).toHaveAttribute('aria-pressed', 'false');
  await pin(page, 'AO-1043').click();
  await pin(page, 'AO-1043').click();
  await expect(page.getByRole('heading', { name: 'Arbetsorder AO-1043', exact: true })).toHaveCount(0);
  await expect(queueCard(page, 'AO-1043')).toBeVisible();
});

test('boka efter ett närliggande stopp använder en timme och sparar bokningen efter omladdning', async ({ page }) => {
  await transport(page);
  const vesselColor = await pin(page, 'AO-1043').locator('.transport-map-pin-fill').getAttribute('fill');
  await expect(pin(page, 'AO-1043').locator('.transport-map-pin-art')).not.toHaveCSS('animation-name', 'none');
  await queueCard(page, 'AO-1043').click();
  await page.getByRole('button', { name: /Boka efter/ }).first().click();
  await expect(editor(page).getByRole('combobox', { name: 'Timmar', exact: true })).toHaveValue('1');
  await expect(editor(page).getByRole('combobox', { name: 'Minuter', exact: true })).toHaveValue('0');
  const driverId = await editor(page).getByRole('combobox', { name: 'Förare', exact: true }).inputValue();
  const start = await editor(page).getByLabel('Starttid', { exact: true }).inputValue();
  await savePlanAndConfirm(page);
  await expect(calendarCard(page, 'AO-1043')).toBeVisible();
  await expect(queueCard(page, 'AO-1043')).toHaveCount(0);
  await expect(pin(page, 'AO-1043')).not.toHaveClass(/is-unbooked/);
  await expect(pin(page, 'AO-1043').locator('.transport-map-pin-art')).toHaveCSS('animation-name', 'none');
  await expect(pin(page, 'AO-1043').locator('.transport-map-pin-fill')).toHaveAttribute('fill', vesselColor!);
  expect(await order(page, 'AO-1043')).toMatchObject({
    status: 'booked', durationMinutes: 60, driverId,
    startMinute: Number(start.slice(0, 2)) * 60 + Number(start.slice(3)),
  });

  await page.reload();
  await expect(calendarCard(page, 'AO-1043')).toBeVisible();
  await expect(pin(page, 'AO-1043')).not.toHaveClass(/is-unbooked/);
  expect((await order(page, 'AO-1043')).audit.at(-1)).toMatchObject({ actualUserId: 'kajsa', effectiveUserId: 'kajsa' });
});

test('släppt obokat arbete stannar i kalendern som preliminärt före bekräftelse', async ({ page }) => {
  await transport(page);
  const date = (await order(page, 'AO-1042')).date!;
  // 11:30 is a free slot between the driver's 08:00 and 13:00 jobs.
  await dropAt(page, queueCard(page, 'AO-1044'), 'maria', date, 690);
  await expect(editor(page)).toHaveCount(0);
  await expect(calendarCard(page, 'AO-1044')).toHaveClass(/is-preliminary/);
  await expect(calendarCard(page, 'AO-1044')).toContainText('11:30–12:30');
  await expect(queueCard(page, 'AO-1044')).toHaveCount(0);
  expect((await order(page, 'AO-1044')).status).toBe('unbooked');
  expect((await saved(page)).preliminary['AO-1044']).toMatchObject({ date, startMinute: 690, durationMinutes: 60, driverId: 'maria', vehicleId: 'vehicle-maria' });
  expect((await saved(page)).events.filter(event => event.type === 'work_order.booked')).toHaveLength(0);
  await page.getByRole('button', { name: 'Bekräfta bokning', exact: true }).click();
  await expect(calendarCard(page, 'AO-1044')).toContainText('11:30–12:30');
  await expect(calendarCard(page, 'AO-1044')).not.toHaveClass(/is-preliminary/);
  expect((await saved(page)).preliminary['AO-1044']).toBeUndefined();
  expect((await saved(page)).events.filter(event => event.type === 'work_order.booked' && event.orderId === 'AO-1044')).toHaveLength(1);
});

test('flera preliminära bokningar kan flyttas, förlängas och laddas om innan de verkställs tillsammans', async ({ page }) => {
  await transport(page);
  const date = (await order(page, 'AO-1042')).date!;
  await dropAt(page, queueCard(page, 'AO-1043'), 'maria', date, 570);
  await dropAt(page, queueCard(page, 'AO-1044'), 'oskar', date, 690);
  await expect(page.getByRole('button', { name: 'Verkställ bokningar (2)', exact: true })).toBeVisible();
  await expect(queueCard(page, 'AO-1043')).toHaveCount(0);
  await expect(queueCard(page, 'AO-1044')).toHaveCount(0);
  await expect(calendarCard(page, 'AO-1043')).toHaveClass(/is-preliminary/);
  await expect(calendarCard(page, 'AO-1044')).toHaveClass(/is-preliminary/);
  await dropAt(page, calendarCard(page, 'AO-1043'), 'kalle', date, 690);
  await expect(calendarCard(page, 'AO-1043')).toContainText('11:30–12:30');
  const slider = page.getByRole('slider', { name: 'Ändra tidsåtgång för AO-1043', exact: true });
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '75');
  expect((await saved(page)).preliminary['AO-1043']).toMatchObject({ driverId: 'kalle', durationMinutes: 75, startMinute: 690 });
  expect((await saved(page)).events.filter(event => event.type === 'work_order.booked')).toHaveLength(0);
  await page.reload();
  await expect(calendarCard(page, 'AO-1043')).toHaveClass(/is-preliminary/);
  await expect(calendarCard(page, 'AO-1043')).toContainText('11:30–12:45');
  await expect(queueCard(page, 'AO-1044')).toHaveCount(0);
  await page.getByRole('button', { name: 'Verkställ bokningar (2)', exact: true }).click();
  await expect(calendarCard(page, 'AO-1043')).not.toHaveClass(/is-preliminary/);
  await expect(calendarCard(page, 'AO-1044')).not.toHaveClass(/is-preliminary/);
  expect((await saved(page)).preliminary).toEqual({});
  expect((await saved(page)).events.filter(event => event.type === 'work_order.booked').map(event => event.orderId).sort()).toEqual(['AO-1043', 'AO-1044']);
  expect(await order(page, 'AO-1043')).toMatchObject({ status: 'booked', durationMinutes: 75, driverId: 'kalle' });
});

test('borttagen preliminär bokning återför uppdraget till kön utan bokningshändelse', async ({ page }) => {
  await transport(page);
  const date = (await order(page, 'AO-1042')).date!;
  await dropAt(page, queueCard(page, 'AO-1044'), 'maria', date, 690);
  await openCalendarOrder(page, 'AO-1044');
  await page.getByRole('button', { name: 'Ta bort preliminär bokning', exact: true }).click();
  await expect(calendarCard(page, 'AO-1044')).toHaveCount(0);
  // Closing details is optional: removing the draft must make its queue entry reachable.
  if (await page.getByRole('button', { name: 'Stäng arbetsorder', exact: true }).isVisible()) await closeDetails(page);
  await expect(queueCard(page, 'AO-1044')).toBeVisible();
  expect((await saved(page)).preliminary).toEqual({});
  expect((await saved(page)).events.filter(event => event.type === 'work_order.booked')).toHaveLength(0);
  expect((await order(page, 'AO-1044')).status).toBe('unbooked');
});

test('flytt visar endast tidskortet vid den nya tiden och avbruten dragning återställer originalet', async ({ page }) => {
  await transport(page);
  const date = (await order(page, 'AO-1042')).date!;
  const source = calendarCard(page, 'AO-1042');
  const target = page.getByTestId(`calendar-slot-kalle-${date}`);
  const sourceRect = await source.boundingBox(), targetRect = await target.boundingBox();
  if (!sourceRect || !targetRect) throw new Error('Kalenderns dragytor saknas.');
  const before = await saved(page);
  await page.mouse.move(sourceRect.x + 4, sourceRect.y + 14);
  await page.mouse.down();
  await page.mouse.move(sourceRect.x + 14, sourceRect.y + 14);
  await page.mouse.move(targetRect.x + targetRect.width * 270 / 600, targetRect.y + targetRect.height / 2, { steps: 5 });
  await expect(page.locator('.tc-proposal')).toContainText('11:30–12:30');
  await expect(source).toHaveCSS('opacity', '0');
  expect(await saved(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.tc-proposal')).toHaveCount(0);
  await expect(source).toHaveCSS('opacity', '1');
  await expect(source).toContainText('10:00–11:00');
  expect(await saved(page)).toEqual(before);
});

test('kundförfrågans svar följer bokningsversionen och ett nej avbokar inte uppdraget', async ({ page }) => {
  await transport(page);
  await openCalendarOrder(page, 'AO-1042');
  const section = page.getByRole('region', { name: 'Kundförfrågan och integrationshändelser', exact: true });
  await section.getByRole('combobox', { name: 'Svarstid för bokningsförfrågan', exact: true }).selectOption('24');
  await section.getByRole('button', { name: 'Förbered förfrågan', exact: true }).click();
  await expect(section.getByText('Inväntar kundsvar', { exact: true })).toBeVisible();
  const original = await order(page, 'AO-1042');
  expect(original.confirmation).toMatchObject({ status: 'requested', bookingVersion: original.bookingVersion });
  await section.getByRole('button', { name: 'Visa kundens svarsvy (demo)', exact: true }).click();
  const reply = page.getByRole('region', { name: 'Kundens svarsvy i demo', exact: true });
  await expect(reply).toContainText('10:00–11:00');
  await reply.getByRole('button', { name: 'Ja, tiden passar', exact: true }).click();
  await expect(section.getByText('Godkänd av kunden', { exact: true })).toBeVisible();
  expect((await order(page, 'AO-1042')).status).toBe('booked');
  await page.getByRole('slider', { name: 'Ändra tidsåtgång för AO-1042', exact: true }).press('ArrowRight');
  await expect(section.getByText('Ingen förfrågan', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Visa kundens svarsvy (demo)', exact: true })).toHaveCount(0);
  expect((await order(page, 'AO-1042')).bookingVersion).toBeGreaterThan(original.bookingVersion);
  await section.getByRole('button', { name: 'Förbered förfrågan', exact: true }).click();
  await section.getByRole('button', { name: 'Visa kundens svarsvy (demo)', exact: true }).click();
  await reply.getByRole('button', { name: 'Nej, ändra tiden', exact: true }).click();
  await expect(section.getByText('Nekad av kunden', { exact: true })).toBeVisible();
  const final = await order(page, 'AO-1042');
  expect(final).toMatchObject({ status: 'booked', durationMinutes: 75, confirmation: { status: 'declined', bookingVersion: final.bookingVersion } });
  await section.getByText('Integrationshändelser', { exact: false }).first().click();
  await expect(section.locator('.transport-integration-event').filter({ hasText: 'Kunden har godkänt' })).toHaveCount(1);
  await expect(section.locator('.transport-integration-event').filter({ hasText: 'Kunden har nekat' })).toHaveCount(1);
  expect((await saved(page)).events.filter(event => event.orderId === 'AO-1042' && event.type === 'work_order.confirmation_requested')).toHaveLength(2);
});

test('draghandtag och tangentbord ändrar samma tidsåtgång, redigeringen är synkad och Ångra återställer', async ({ page }) => {
  await transport(page);
  const initial = await order(page, 'AO-1042');
  const slot = page.getByTestId(`calendar-slot-kalle-${initial.date}`);
  const rect = await slot.boundingBox();
  if (!rect) throw new Error('Kalles kalender är inte synlig.');
  const slider = page.getByRole('slider', { name: 'Ändra tidsåtgång för AO-1042', exact: true });
  await resizeBy(page, slider, rect.width * 15 / 600);
  await expect(slider).toHaveAttribute('aria-valuenow', '75');
  await expect(calendarCard(page, 'AO-1042')).toContainText('10:00–11:15');
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '90');
  await openCalendarOrder(page, 'AO-1042');
  await page.getByRole('button', { name: 'Redigera', exact: true }).click();
  await expect(editor(page).getByRole('combobox', { name: 'Timmar', exact: true })).toHaveValue('1');
  await expect(editor(page).getByRole('combobox', { name: 'Minuter', exact: true })).toHaveValue('30');
  await page.getByRole('button', { name: 'Avbryt', exact: true }).click();
  await page.getByRole('button', { name: 'Ångra', exact: true }).click();
  await expect(slider).toHaveAttribute('aria-valuenow', '75');
  expect(await order(page, 'AO-1042')).toMatchObject({ startMinute: initial.startMinute, durationMinutes: 75 });

  // Extending into Kalle's 13:00 job must leave the valid length untouched.
  await resizeBy(page, slider, rect.width * 120 / 600);
  await expect(page.locator('.tc-footer[role="alert"]')).toContainText('Kalle är redan bokad');
  await expect(slider).toHaveAttribute('aria-valuenow', '75');
  expect((await order(page, 'AO-1042')).durationMinutes).toBe(75);
});

test('bokningsformuläret stoppar både förarkrock och fordonskrock utan att spara delvis', async ({ page }) => {
  await transport(page);
  const before = await saved(page);
  await queueCard(page, 'AO-1043').click();
  await page.getByRole('button', { name: 'Boka uppdrag', exact: true }).click();
  await editor(page).getByLabel('Starttid', { exact: true }).fill('10:00');
  await editor(page).getByRole('combobox', { name: 'Förare', exact: true }).selectOption('oskar');
  await editor(page).getByRole('button', { name: 'Spara planering', exact: true }).click();
  await expect(page.locator('.transport-editor-error')).toContainText('Oskar är redan bokad');
  await editor(page).getByRole('combobox', { name: 'Förare', exact: true }).selectOption('maria');
  await editor(page).getByRole('combobox', { name: 'Fordon', exact: true }).selectOption('vehicle-kalle');
  await editor(page).getByRole('button', { name: 'Spara planering', exact: true }).click();
  await expect(page.locator('.transport-editor-error')).toContainText('ABC 123 är redan bokad');
  expect(await saved(page)).toEqual(before);
  await editor(page).getByRole('combobox', { name: 'Fordon', exact: true }).selectOption('vehicle-maria');
  await savePlanAndConfirm(page);
  await expect(calendarCard(page, 'AO-1043')).toBeVisible();
});

test('ny arbetsorder kräver adress och kartposition och bevarar egen tidsåtgång vid avbokning', async ({ page }) => {
  await transport(page);
  await page.getByRole('button', { name: 'Nytt uppdrag', exact: true }).click();
  await editor(page).getByLabel(/Kundnamn/).fill('Testverkstaden');
  await editor(page).getByLabel(/^Ort/).fill('Rimbo');
  await page.getByRole('button', { name: 'Spara arbetsorder', exact: true }).click();
  await expect(editor(page).getByLabel(/Hämtningsadress/)).toBeFocused();
  await editor(page).getByLabel(/Hämtningsadress/).fill('Torgvägen 20');
  await page.getByRole('button', { name: 'Spara arbetsorder', exact: true }).click();
  await expect(page.locator('.transport-editor-error')).toContainText('välj platsen på kartan');
  await editor(page).getByRole('combobox', { name: 'Timmar', exact: true }).selectOption('2');
  await editor(page).getByRole('combobox', { name: 'Minuter', exact: true }).selectOption('15');
  await page.getByRole('button', { name: 'Välj på kartan', exact: true }).click();
  const map = page.locator('.transport-map-canvas');
  const rect = await map.boundingBox();
  if (!rect) throw new Error('Kartan är inte synlig.');
  await map.click({ position: { x: rect.width * 0.22, y: rect.height * 0.55 } });
  await expect(editor(page).getByText('Plats vald', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Spara arbetsorder', exact: true }).click();
  const created = (await saved(page)).orders.find((item) => item.customerName === 'Testverkstaden')!;
  expect(created).toMatchObject({ address: 'Torgvägen 20', durationMinutes: 135, status: 'unbooked' });
  expect(Number.isFinite(created.lat) && Number.isFinite(created.lng)).toBe(true);
  await closeDetails(page);
  await queueCard(page, created.id).click();
  await page.getByRole('button', { name: 'Boka uppdrag', exact: true }).click();
  await editor(page).getByLabel('Starttid', { exact: true }).fill('15:00');
  await savePlanAndConfirm(page);
  await expect(calendarCard(page, created.id)).toContainText('15:00–17:15');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Avboka', exact: true }).click();
  await closeDetails(page);
  await expect(queueCard(page, created.id)).toBeVisible();
  await expect(calendarCard(page, created.id)).toHaveCount(0);
  await expect(pin(page, created.id)).toHaveClass(/is-unbooked/);
  await page.reload();
  await expect(queueCard(page, created.id)).toContainText('2 tim 15 min');
  const unbooked = await order(page, created.id);
  expect(unbooked).toMatchObject({ status: 'unbooked', durationMinutes: 135 });
  expect(unbooked.startMinute).toBeUndefined();
  expect(unbooked.audit.map((entry) => entry.text).join(' ')).toContain('avbokad');
});

test('ny veckoserie sparar fyra preliminära tillfällen och verkställer dem gemensamt', async ({ page }) => {
  await transport(page);
  const firstDate = addDays((await order(page, 'AO-1042')).date!, 1);
  await page.getByRole('button', { name: 'Nytt uppdrag', exact: true }).click();
  await editor(page).getByLabel('Kundnamn', { exact: true }).fill('Veckohämtning Test');
  await editor(page).getByLabel('Hämtningsadress', { exact: true }).fill('Verkstadsvägen 25');
  await editor(page).getByLabel('Ort', { exact: true }).fill('Rimbo');
  await editor(page).getByRole('button', { name: 'Välj på kartan', exact: true }).click();
  const map = page.locator('.transport-map-canvas');
  const rect = await map.boundingBox();
  if (!rect) throw new Error('Kartan är inte synlig.');
  await map.click({ position: { x: rect.width * 0.22, y: rect.height * 0.55 } });
  await editor(page).getByRole('checkbox', { name: 'Planera preliminär bokning', exact: true }).check();
  await editor(page).getByLabel('Datum', { exact: true }).fill(firstDate);
  await editor(page).getByLabel('Starttid', { exact: true }).fill('11:00');
  await editor(page).getByRole('combobox', { name: 'Förare', exact: true }).selectOption('maria');
  await editor(page).getByRole('combobox', { name: 'Återkommande', exact: true }).selectOption('weekly');
  await editor(page).getByRole('button', { name: 'Spara arbetsorder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Verkställ bokningar (4)', exact: true })).toBeVisible();
  const pending = await saved(page);
  const created = pending.orders.filter(item => item.customerName === 'Veckohämtning Test');
  expect(created).toHaveLength(4);
  expect(new Set(created.map(item => item.seriesId)).size).toBe(1);
  expect(created[0].seriesId).toBeTruthy();
  for (const [index, item] of created.entries()) {
    expect(item.status).toBe('unbooked');
    expect(pending.preliminary[item.id]).toMatchObject({ date: addDays(firstDate, index * 7), startMinute: 660, durationMinutes: 60, driverId: 'maria', vehicleId: 'vehicle-maria' });
  }
  expect(pending.events.map(event => event.type)).toEqual(Array(4).fill('work_order.created'));
  await expect(calendarCard(page, created[0].id)).toHaveClass(/is-preliminary/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Verkställ bokningar (4)', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Verkställ bokningar (4)', exact: true }).click();
  const committed = await saved(page);
  expect(committed.preliminary).toEqual({});
  expect(committed.orders.filter(item => item.customerName === 'Veckohämtning Test').every(item => item.status === 'booked')).toBe(true);
  expect(committed.events.filter(event => event.type === 'work_order.booked').map(event => event.orderId).sort()).toEqual(created.map(item => item.id).sort());
});

test('Escape avbryter en pågående tidsjustering utan att spara efter att musen släpps', async ({ page }) => {
  await transport(page);
  const before = await saved(page);
  const date = (await order(page, 'AO-1042')).date!;
  const slider = page.getByRole('slider', { name: 'Ändra tidsåtgång för AO-1042', exact: true });
  const handle = await slider.boundingBox();
  const track = await page.getByTestId(`calendar-slot-kalle-${date}`).boundingBox();
  if (!handle || !track) throw new Error('Kalenderns tidsreglage saknas.');
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + track.width * 30 / 600, y, { steps: 5 });
  await expect(slider).toHaveAttribute('aria-valuenow', '90');
  await expect(calendarCard(page, 'AO-1042')).toContainText('10:00–11:30');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuenow', '60');
  await expect(calendarCard(page, 'AO-1042')).toContainText('10:00–11:00');
  expect(await saved(page)).toEqual(before);
});

test('veckovyn använder lodrät tidsåtgång och datumväxling behåller obokade arbeten', async ({ page }) => {
  await transport(page);
  const bookedDate = (await order(page, 'AO-1042')).date!;
  await page.getByRole('button', { name: 'Vecka', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Veckoplanerare', exact: true })).toBeVisible();
  const slider = page.getByRole('slider', { name: 'Ändra tidsåtgång för AO-1042', exact: true });
  await expect(slider).toHaveAttribute('aria-orientation', 'vertical');
  await slider.focus();
  await slider.press('ArrowDown');
  await expect(slider).toHaveAttribute('aria-valuenow', '75');
  await page.getByRole('button', { name: 'Nästa period', exact: true }).click();
  await expect(calendarCard(page, 'AO-1042')).toHaveCount(0);
  await expect(queueCard(page, 'AO-1043')).toBeVisible();
  await page.getByRole('button', { name: 'Föregående period', exact: true }).click();
  await expect(calendarCard(page, 'AO-1042')).toBeVisible();
  await page.getByRole('button', { name: 'Dag', exact: true }).click();
  await expect(slider).toHaveAttribute('aria-orientation', 'horizontal');
  await page.getByLabel('Datum i planeraren', { exact: true }).fill(addDays(monday(bookedDate), 7));
  await expect(calendarCard(page, 'AO-1042')).toHaveCount(0);
});

test('läsbehörighet visar arbetsordrar men ger inga redigerings-, boknings- eller dragkontroller', async ({ page }) => {
  await transport(page, 'Anna Nilsson');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(pin(page, 'AO-1043').locator('.transport-map-pin-art')).toHaveCSS('animation-name', 'none');
  await expect(pin(page, 'AO-1043').locator('.transport-map-pin-contour')).toHaveAttribute('stroke-dasharray', '4 4');
  await expect(page.getByRole('button', { name: 'Nytt uppdrag', exact: true })).toHaveCount(0);
  await expect(queueCard(page, 'AO-1043')).toHaveAttribute('draggable', 'false');
  await expect(calendarCard(page, 'AO-1042')).toHaveAttribute('draggable', 'false');
  await expect(page.getByRole('slider')).toHaveCount(0);
  const before = await saved(page);
  await openCalendarOrder(page, 'AO-1042');
  await expect(page.getByRole('button', { name: 'Redigera', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Avboka', exact: true })).toHaveCount(0);
  await closeDetails(page);
  await queueCard(page, 'AO-1043').click();
  await expect(page.getByRole('button', { name: 'Boka uppdrag', exact: true })).toHaveCount(0);
  expect(await saved(page)).toEqual(before);
});

test('Systemadmin Jobba som följer vald transportbehörighet och sparar båda personerna i historiken', async ({ page }) => {
  await transport(page, 'Systemadmin');
  async function workAs(userId: string) {
    await page.getByRole('button', { name: 'Profil och behörighet', exact: true }).click();
    await page.getByLabel('Jobba som', { exact: true }).selectOption(userId);
    await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
    await page.locator('.office-sidebar').getByRole('button', { name: 'Transportplanering', exact: true }).click();
    await expect(page.getByTestId('transport-workspace')).toBeVisible();
  }
  await workAs('anna');
  await expect(page.getByRole('button', { name: 'Nytt uppdrag', exact: true })).toHaveCount(0);
  await expect(page.getByRole('slider')).toHaveCount(0);
  await queueCard(page, 'AO-1043').click();
  await expect(page.getByRole('button', { name: 'Boka uppdrag', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Redigera', exact: true })).toHaveCount(0);
  await closeDetails(page);
  await workAs('kajsa');
  await expect(page.getByRole('button', { name: 'Nytt uppdrag', exact: true })).toBeVisible();
  await queueCard(page, 'AO-1043').click();
  await page.getByRole('button', { name: 'Boka efter', exact: true }).click();
  await savePlanAndConfirm(page);
  await expect(calendarCard(page, 'AO-1043')).toBeVisible();
  const history = (await order(page, 'AO-1043')).audit.at(-1)!;
  expect(history).toMatchObject({ actualUserId: 'admin', effectiveUserId: 'kajsa' });
  expect(history.actor).toContain('Systemadmin som Kajsa Nilsson');
  await page.reload();
  await expect(calendarCard(page, 'AO-1043')).toBeVisible();
  await page.getByRole('button', { name: 'Profil och behörighet', exact: true }).click();
  await expect(page.getByLabel('Jobba som', { exact: true })).toHaveValue('kajsa');
  await expect(page.getByRole('button', { name: 'Nytt uppdrag', exact: true })).toBeVisible();
});
