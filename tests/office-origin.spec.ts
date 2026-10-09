import { test, expect, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import { randomUUID } from 'node:crypto';

test.use({
  viewport: { width: 1440, height: 1000 },
  isMobile: false,
  hasTouch: false,
});

async function openDraft(
  page: Page,
  id: number,
  origin: string,
  status: 'new' | 'complement',
) {
  const fixture = migrateOffice(seedOffice());
  fixture.cards.push({
    ...fixture.cards.find((card) => card.id === 2052)!,
    id,
    sourceId: randomUUID(),
    status,
    origin,
    reference: '',
    audit: [],
  });
  await page.addInitScript((data) => {
    if (!localStorage.getItem('jeroc.office.demo.v1'))
      localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, fixture);
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Kajsa Nilsson/ }).click();
  await page.goto(`/kontor#/weighings/${id}`);
}

for (const [id, origin, status] of [
  [9101, '', 'new'],
  [9102, '   ', 'complement'],
] as const) {
  test(`${status}: saknad ursprungsadress blockerar kundgodkännande men underlaget kan sparas`, async ({
    page,
  }) => {
    await openDraft(page, id, origin, status);
    const originField = page.getByLabel('Ursprungsadress', { exact: true });
    await expect(originField).toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.getByText(/Ursprungsadress saknas.*före kundgodkännande/),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Visa på kundterminal', exact: true }),
    ).toBeDisabled();

    await page
      .getByLabel('Referens', { exact: true })
      .fill('Utkast med ofullständig adress');
    await page
      .getByRole('button', { name: 'Spara referens & ursprung', exact: true })
      .click();
    await page.reload();
    await expect(originField).toHaveValue(origin);
    await expect(page.getByLabel('Referens', { exact: true })).toHaveValue(
      'Utkast med ofullständig adress',
    );
    await expect(
      page.getByRole('button', { name: 'Visa på kundterminal', exact: true }),
    ).toBeDisabled();
    const card = await page.evaluate(
      (cardId) =>
        JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
          (item: { id: number }) => item.id === cardId,
        ),
      id,
    );
    expect(card).toMatchObject({
      status,
      origin,
      reference: 'Utkast med ofullständig adress',
    });
    expect(card.pricingSnapshotId).toBeUndefined();
  });
}

test('ursprungsadress måste sparas inför kundgodkännande medan referens får vara tom', async ({
  page, request,
}) => {
  expect((await request.post('/api/terminal-demo/staff-session', { data: { actualUserId: 'admin', effectiveUserId: 'admin' } })).ok()).toBeTruthy();
  const username = `origin-test-${randomUUID().slice(0, 8)}`;
  const response = await request.post('/api/terminal-demo/terminals', { data: { name: username, username, password: 'TerminalDemo123!', siteId: 'norrtalje' } });
  expect(response.ok()).toBeTruthy();
  const terminal = await response.json();
  expect((await request.post('/api/terminal-demo/login', { data: { username, password: 'TerminalDemo123!' } })).ok()).toBeTruthy();
  try {
    await openDraft(page, 9103, '', 'new');
    const origin = page.getByLabel('Ursprungsadress', { exact: true });
    const send = page.getByRole('button', { name: 'Visa på kundterminal', exact: true });
    await origin.fill('Ängsvägen 19, Norrtälje');
    await expect(send).toBeDisabled();
    await page
      .getByRole('button', { name: 'Spara referens & ursprung', exact: true })
      .click();
    await expect(origin).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Referens', { exact: true })).toHaveValue('');
    await expect(send).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Attestera', exact: true })).toHaveCount(0);
    await page.reload();
    const card = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
        (item: { id: number }) => item.id === 9103,
      ),
    );
    expect(card).toMatchObject({
      status: 'new',
      origin: 'Ängsvägen 19, Norrtälje',
      reference: '',
    });
    expect(card.pricingSnapshotId).toBeUndefined();
  } finally {
    await request.patch(`/api/terminal-demo/terminals/${terminal.id}`, { data: { active: false } });
  }
});
