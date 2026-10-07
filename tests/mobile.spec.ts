import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Öppna demokontot' }).click();
  await expect(
    page.getByRole('heading', { name: 'Hej Niklas.' }),
  ).toBeVisible();
}
async function start(page: Page, vehicle = false) {
  await page.getByRole('button', { name: /Starta invägning/ }).click();
  if (vehicle)
    await page
      .getByRole('button', { name: 'Fordonsvåg Vikt vid infart och utfart' })
      .click();
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
}
async function choose(page: Page, category: string, article: string) {
  await page.locator('.material-choice').filter({ hasText: category }).click();
  await page.locator('.material-choice').filter({ hasText: article }).click();
  await page
    .getByRole('button', { name: `Välj ${article}`, exact: true })
    .click();
}
async function addWeight(
  page: Page,
  category: string,
  article: string,
  value: string,
  finish = true,
) {
  await choose(page, category, article);
  await page.getByRole('textbox', { name: 'Vikt i kg' }).fill(value);
  await page
    .getByRole('button', {
      name: finish ? /Färdigvägd/ : /Material Lägg till och fortsätt/,
    })
    .click();
}

test('material, kund och ursprung sparas lokalt; inget skickas till kontoret', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (req) => {
    if (!req.url().startsWith('http://127.0.0.1:5173/'))
      external.push(req.url());
  });
  await login(page);
  await start(page);
  await addWeight(page, 'Koppar', 'Koppar klass 1', '125', false);
  await addWeight(page, 'Koppar', 'Blandad koppar', '230', false);
  await addWeight(page, 'Rostfritt', 'Rostfritt', '130');
  await expect(page.getByTestId('total-weight')).toHaveText('485 kg');
  await expect(
    page.getByRole('button', { name: /Referens & ursprung/ }),
  ).toBeDisabled();
  await expect(page.getByRole('navigation', { name: 'Huvudmeny' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: /Lägg till kund/ }).click();
  await page
    .locator('.customer-choice')
    .filter({ hasText: 'Bygg & Riv AB' })
    .click();
  await page.getByRole('button', { name: /Referens & ursprung/ }).click();
  await page
    .getByRole('button', { name: 'Projekt Solbacken', exact: true })
    .click();
  await page
    .getByLabel('Materialets ursprungsadress (valfritt)')
    .fill('Testgatan 12, 761 41 Norrtälje');
  await page.getByRole('button', { name: 'Spara uppgifter' }).click();
  await page.getByRole('button', { name: 'Spara färdig vägning' }).click();
  await expect(
    page.getByRole('heading', { name: 'Klart i demon!' }),
  ).toBeVisible();
  await expect(
    page.getByText('Inget har skickats till kontoret.', { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('total-weight')).toHaveText('485 kg');
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.mobile.demo.v1')!),
  );
  const result = saved.drafts.find(
    (d: { number: number }) => d.number === 1418,
  );
  expect(result).toMatchObject({
    status: 'ready',
    customerId: 'customer-build',
    reference: 'Projekt Solbacken',
    origin: 'Testgatan 12, 761 41 Norrtälje',
  });
  expect(external).toEqual([]);
});

test('fordonsvikt 124 och separat koppar 12 summeras till 136 på samma kort', async ({
  page,
}) => {
  await login(page);
  await start(page, true);
  await page.getByRole('button', { name: /Välj material/ }).click();
  await choose(page, 'Järn', 'Järnskrot');
  await page.getByLabel('Registreringsnummer').fill('GHI456');
  await page.getByLabel('Vikt vid infart').fill('2004');
  await page
    .getByRole('button', { name: 'Lägg till material', exact: true })
    .click();
  await choose(page, 'Koppar', 'Koppar klass 1');
  await page.getByRole('textbox', { name: 'Vikt i kg' }).fill('12');
  await page.getByRole('button', { name: 'Lägg till på kortet' }).click();
  await expect(page.getByLabel('Vikt vid infart')).toHaveValue('2004');
  await page.getByRole('button', { name: 'Spara infart' }).click();
  const pending = page.locator('.pending-card').filter({ hasText: 'GHI456' });
  await pending.getByRole('button', { name: /Registrera utfart/ }).click();
  await page.getByLabel('Vikt vid utfart').fill('2005');
  await page.getByRole('button', { name: 'Färdigvägd', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Utfartsvikten måste vara lägre',
  );
  await page.getByLabel('Vikt vid utfart').fill('1880');
  await page.getByRole('button', { name: 'Färdigvägd', exact: true }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('136 kg');
  await expect(
    page.locator('.summary-row').filter({ hasText: 'Järnskrot' }),
  ).toContainText('124 kg');
  await expect(
    page.locator('.summary-row').filter({ hasText: 'Koppar klass 1' }),
  ).toContainText('12 kg');
  await page.getByRole('button', { name: 'Spara färdig vägning' }).click();
  await expect(
    page.getByRole('heading', { name: 'Klart i demon!' }),
  ).toBeVisible();
});

test('fordonsviktavdrag kräver orsak och lämnar spårbart vågunderlag', async ({
  page,
}) => {
  await login(page);
  await page.locator('.pending-mini').filter({ hasText: 'ABC123' }).click();
  await page.getByLabel('Vikt vid utfart').fill('11600');
  await page.getByRole('button', { name: /^Viktavdrag/ }).click();
  await page.getByLabel('Viktavdrag i kg').fill('20');
  await page.getByRole('button', { name: 'Färdigvägd', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Ange en orsak');
  await page.getByLabel('Orsak', { exact: true }).fill('Betongrester');
  await page.getByRole('button', { name: 'Färdigvägd', exact: true }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('830 kg');
  await page.locator('.evidence summary').click();
  await expect(page.locator('.evidence')).toContainText('12 450 kg');
  await expect(page.locator('.evidence')).toContainText('11 600 kg');
  await expect(page.locator('.evidence')).toContainText('850 kg');
  await expect(page.locator('.evidence')).toContainText(
    '−20 kg · Betongrester',
  );
  await page.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await page.reload();
  await page
    .locator('.draft-card')
    .filter({ hasText: '#1416' })
    .getByRole('button', { name: /Fortsätt/ })
    .click();
  await expect(page.getByTestId('total-weight')).toHaveText('830 kg');
});

test('en påbörjad decimalvikt återställs efter omladdning och kan fortsättas', async ({
  page,
}) => {
  await login(page);
  await start(page);
  await choose(page, 'Koppar', 'Koppar klass 1');
  await page.getByRole('textbox', { name: 'Vikt i kg' }).fill('12,5');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Vikt i kg' })).toHaveValue(
    '12,5',
  );
  await page.getByRole('button', { name: 'Spara och pausa' }).click();
  await page
    .locator('.draft-card')
    .filter({ hasText: '#1418' })
    .getByRole('button', { name: /Fortsätt/ })
    .click();
  await expect(
    page.getByRole('button', { name: 'Spara färdig vägning' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Fortsätt ange vikt' }).click();
  await expect(page.getByRole('textbox', { name: 'Vikt i kg' })).toHaveValue(
    '12,5',
  );
  await page.getByRole('button', { name: /Färdigvägd/ }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('12,5 kg');
});

test('ny kund väljs och byte av kund rensar den gamla kundens referens', async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Utkast' })
    .click();
  await page
    .locator('.draft-card')
    .filter({ hasText: '#1414' })
    .getByRole('button', { name: /Fortsätt/ })
    .click();
  await page.getByRole('button', { name: /Lägg till kund/ }).click();
  await page
    .locator('.customer-choice')
    .filter({ hasText: 'Bygg & Riv AB' })
    .click();
  await page.getByRole('button', { name: /Referens & ursprung/ }).click();
  await page
    .getByRole('button', { name: 'Projekt Solbacken', exact: true })
    .click();
  await page.getByRole('button', { name: 'Spara uppgifter' }).click();
  await page.getByRole('button', { name: /Bygg & Riv AB/ }).click();
  await page.getByRole('button', { name: 'Byt kund', exact: true }).click();
  await page.getByRole('button', { name: 'Skapa ny kund' }).click();
  await page.getByLabel('Företagsnamn', { exact: true }).fill('Testbolaget AB');
  await page.getByRole('button', { name: 'Spara och välj kund' }).click();
  await expect(
    page.getByRole('heading', { name: 'Testbolaget AB' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Klar', exact: true }).click();
  await page.getByRole('button', { name: /Referens & ursprung/ }).click();
  await expect(
    page.getByLabel('Referens (valfritt)', { exact: true }),
  ).toHaveValue('');
  await expect(
    page.getByLabel('Materialets ursprungsadress (valfritt)'),
  ).toHaveValue('');
  await page.reload();
  await expect(page.getByText('Testbolaget AB', { exact: true })).toBeVisible();
});

test('prislistan är sökbar och visar enbart allmänna A/B/C-priser', async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Prislista' })
    .click();
  await page.getByRole('searchbox').fill('Koppar klass 1');
  await expect(page.locator('.price-row')).toHaveCount(1);
  await expect(page.locator('.price-row')).toContainText('82,00');
  await expect(page.locator('.price-row')).toContainText('73,80');
  await expect(page.locator('.price-row')).toContainText('65,60');
  await expect(page.locator('.price-row button')).toHaveCount(0);
});

test('lagringsfel stoppar klarmarkering och visar fel i stället för framgång', async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Utkast' })
    .click();
  await page
    .locator('.draft-card')
    .filter({ hasText: '#1414' })
    .getByRole('button', { name: /Fortsätt/ })
    .click();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Full', 'QuotaExceededError');
    };
  });
  await page.getByRole('button', { name: 'Spara färdig vägning' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Utkastet kunde inte sparas',
  );
  await expect(
    page.getByRole('heading', { name: 'Klart i demon!' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Sammanställning' }),
  ).toBeVisible();
});

test('ID kan skapas även när mobilen öppnar appen över ett lokalt HTTP-nät', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    });
  });
  await login(page);
  await start(page);
  await expect(
    page.getByRole('heading', { name: 'Välj material' }),
  ).toBeVisible();
});
