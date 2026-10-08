import { test, expect, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';

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
    ...fixture.cards.find((card) => card.id === 1416)!,
    id,
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
  test(`${status}: saknad ursprungsadress blockerar attest men underlaget kan sparas`, async ({
    page,
  }) => {
    await openDraft(page, id, origin, status);
    const originField = page.getByLabel('Ursprungsadress', { exact: true });
    await expect(originField).toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.getByText(
        'Ursprungsadress saknas. Fyll i och spara gatuadressen före attest.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Skicka för attest/ }),
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
      page.getByRole('button', { name: /Skicka för attest/ }),
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

test('sparad ursprungsadress räcker inför attest och referens får vara tom', async ({
  page,
}) => {
  await openDraft(page, 9103, '', 'new');
  const origin = page.getByLabel('Ursprungsadress', { exact: true });
  const send = page.getByRole('button', { name: /Skicka för attest/ });
  await origin.fill('Ängsvägen 19, Norrtälje');
  await expect(send).toBeDisabled();
  await page
    .getByRole('button', { name: 'Spara referens & ursprung', exact: true })
    .click();
  await expect(origin).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Referens', { exact: true })).toHaveValue('');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByRole('status')).toContainText('väntar nu på attest');
  await page.reload();
  const card = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
      (item: { id: number }) => item.id === 9103,
    ),
  );
  expect(card).toMatchObject({
    status: 'attest',
    origin: 'Ängsvägen 19, Norrtälje',
    reference: '',
  });
  expect(card.pricingSnapshotId).toBeTruthy();
});
