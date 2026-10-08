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

test('boka efter ett närliggande stopp använder en timme och sparar bokningen efter omladdning', async ({ page }) => {
  await transport(page);
  const vesselColor = await pin(page, 'AO-1043').locator('.transport-map-pin-fill').getAttribute('fill');
  await expect(pin(page, 'AO-1043').locator('.transport-map-pin-fill')).not.toHaveCSS('animation-name', 'none');
  await queueCard(page, 'AO-1043').click();
  await page.getByRole('button', { name: /Boka efter/ }).first().click();
  await expect(editor(page).getByRole('combobox', { name: 'Timmar', exact: true })).toHaveValue('1');
  await expect(editor(page).getByRole('combobox', { name: 'Minuter', exact: true })).toHaveValue('0');
  const driverId = await editor(page).getByRole('combobox', { name: 'Förare', exact: true }).inputValue();
  const start = await editor(page).getByLabel('Starttid', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Bekräfta bokning', exact: true }).click();
  await expect(calendarCard(page, 'AO-1043')).toBeVisible();
  await expect(queueCard(page, 'AO-1043')).toHaveCount(0);
  await expect(pin(page, 'AO-1043')).not.toHaveClass(/is-unbooked/);
  await expect(pin(page, 'AO-1043').locator('.transport-map-pin-fill')).toHaveCSS('animation-name', 'none');
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

test('dra ett obokat arbete till en förare förhandsfyller datum, tid och fordon före bekräftelse', async ({ page }) => {
  await transport(page);
  const date = (await order(page, 'AO-1042')).date!;
  const slot = page.getByTestId(`calendar-slot-maria-${date}`);
  const rect = await slot.boundingBox();
  if (!rect) throw new Error('Marias kalender är inte synlig.');
  // 11:30 is a free slot between the driver's 08:00 and 13:00 jobs.
  await queueCard(page, 'AO-1044').dragTo(slot, { targetPosition: { x: rect.width * 270 / 600, y: rect.height / 2 } });
  await expect(page.getByRole('heading', { name: 'Boka arbetsorder', exact: true })).toBeVisible();
  await expect(editor(page).getByRole('combobox', { name: 'Förare', exact: true })).toHaveValue('maria');
  await expect(editor(page).getByRole('combobox', { name: 'Fordon', exact: true })).toHaveValue('vehicle-maria');
  await expect(editor(page).getByLabel('Datum', { exact: true })).toHaveValue(date);
  await expect(editor(page).getByLabel('Starttid', { exact: true })).toHaveValue('11:30');
  expect((await order(page, 'AO-1044')).status).toBe('unbooked');
  await page.getByRole('button', { name: 'Bekräfta bokning', exact: true }).click();
  await expect(calendarCard(page, 'AO-1044')).toContainText('11:30–12:30');
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
  await page.getByRole('button', { name: 'Bekräfta bokning', exact: true }).click();
  await expect(page.locator('.transport-editor-error')).toContainText('Oskar är redan bokad');
  await editor(page).getByRole('combobox', { name: 'Förare', exact: true }).selectOption('maria');
  await editor(page).getByRole('combobox', { name: 'Fordon', exact: true }).selectOption('vehicle-kalle');
  await page.getByRole('button', { name: 'Bekräfta bokning', exact: true }).click();
  await expect(page.locator('.transport-editor-error')).toContainText('ABC 123 är redan bokad');
  expect(await saved(page)).toEqual(before);
  await editor(page).getByRole('combobox', { name: 'Fordon', exact: true }).selectOption('vehicle-maria');
  await page.getByRole('button', { name: 'Bekräfta bokning', exact: true }).click();
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
  await page.getByRole('button', { name: 'Bekräfta bokning', exact: true }).click();
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
  await expect(pin(page, 'AO-1043').locator('.transport-map-pin-fill')).toHaveCSS('animation-name', 'none');
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
  await page.getByRole('button', { name: 'Bekräfta bokning', exact: true }).click();
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
