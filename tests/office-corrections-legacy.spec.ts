import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { migrateOffice } from '../src/office/customer-model';
import { completedOfficeCard, readOffice, saveOffice } from './helpers/financial-card';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

test('ett äldre rättelseutkast kan få sitt saknade underlag kompletterat utan att ändra original eller saldo', async ({ page, request }) => {
  // Financial history must come from the shared approval/attest/payment APIs.
  // Only the old missing-document correction format is migrated in this fixture.
  const { cardId } = await completedOfficeCard(request);
  const base = await readOffice(request), id = Math.max(0, ...base.corrections.map(c => c.id)) + 1;
  const original = base.cards.find(c => c.id === cardId)!;
  const originalPayments = base.payments.filter(p => p.cardId === cardId);
  const legacy = structuredClone(base);
  legacy.corrections.push({ id, cardId, customerId: original.customerId!, articleId: 'iron', weightDelta: -10,
    reason: 'Fel registrerad mängd', actor: 'Kajsa Nilsson', at: new Date().toISOString() });
  await saveOffice(request, base, migrateOffice(legacy));
  const document = `RU-LEGACY-${randomUUID().slice(0, 8)}`;

  await page.goto('/kontor');
  await page.getByRole('button', { name: /Lars Andersson/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.goto('/kontor#/corrections');
  const row = page.getByRole('row').filter({ hasText: `#${cardId}` });
  await row.getByRole('button', { name: 'Granska utkast', exact: true }).click();
  await page.getByLabel('Rättelseunderlag', { exact: true }).fill(document);
  await page.getByRole('button', { name: 'Spara rättelseunderlag', exact: true }).click();
  await expect.poll(async () => (await readOffice(request)).corrections.find(c => c.id === id)?.document).toBe(document);
  await page.reload();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('row').filter({ hasText: `#${cardId}` }).getByRole('button', { name: 'Skicka rättelse för attest', exact: true }).click();
  await expect.poll(async () => (await readOffice(request)).corrections.find(c => c.id === id)?.status).toBe('attest');
  await expect(page.getByRole('row').filter({ hasText: document })).toContainText('Väntar på attest');

  const state = await readOffice(request), correction = state.corrections.find(c => c.id === id)!;
  expect(state.cards.find(c => c.id === cardId)).toEqual(original);
  expect(state.payments.filter(p => p.cardId === cardId)).toEqual(originalPayments);
  expect(correction).toMatchObject({ status: 'attest', document, weightDelta: -10 });
  expect(correction.audit?.some(a => a.text.includes(document))).toBe(true);
});
