import { test, expect } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';

test.use({
  viewport: { width: 1440, height: 1000 },
  isMobile: false,
  hasTouch: false,
});
test('ett äldre rättelseutkast kan få sitt saknade underlag kompletterat utan att ändra original eller saldo', async ({
  page,
}) => {
  const fixture = migrateOffice(seedOffice());
  fixture.corrections.push({
    id: 77,
    cardId: 2038,
    customerId: 'customer-erik',
    articleId: 'iron',
    weightDelta: -10,
    reason: 'Fel registrerad mängd',
    actor: 'Kajsa Nilsson',
    at: '2026-10-07T10:00:00Z',
  });
  const original = fixture.cards.find((c) => c.id === 2038)!;
  await page.addInitScript((data) => {
    if (!localStorage.getItem('jeroc.office.demo.v1'))
      localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, fixture);
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Lars Andersson/ }).click();
  await page.goto('/kontor#/corrections');
  await page
    .getByRole('button', { name: 'Granska utkast', exact: true })
    .click();
  await page
    .getByLabel('Rättelseunderlag', { exact: true })
    .fill('RU-LEGACY-77');
  await page
    .getByRole('button', { name: 'Spara rättelseunderlag', exact: true })
    .click();
  await page.reload();
  await page
    .getByRole('button', { name: 'Skicka rättelse för attest', exact: true })
    .click();
  await expect(
    page.getByText('Väntar på attest', { exact: true }).first(),
  ).toBeVisible();
  const state = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!),
  );
  expect(state.cards.find((c: { id: number }) => c.id === 2038)).toEqual(
    original,
  );
  expect(state.payments).toEqual([]);
  expect(state.corrections[0]).toMatchObject({
    status: 'attest',
    document: 'RU-LEGACY-77',
    weightDelta: -10,
  });
  expect(
    state.corrections[0].audit.some((a: { text: string }) =>
      a.text.includes('RU-LEGACY-77'),
    ),
  ).toBe(true);
});
