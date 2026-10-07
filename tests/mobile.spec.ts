import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Öppna demokontot' }).click();
  await expect(
    page.getByRole('heading', { name: 'Byt lösenord' }),
  ).toBeVisible();
  await page.getByLabel('Nytt lösenord', { exact: true }).fill('Test12345!');
  await page.getByLabel('Bekräfta nytt lösenord').fill('Test12345!');
  await page.getByRole('button', { name: 'Spara och fortsätt' }).click();
  await expect(page.getByRole('heading', { name: 'Gårdsappen' })).toBeVisible();
}
async function start(page: Page, vehicle = false) {
  await page.getByRole('button', { name: /Starta invägning/ }).click();
  await page
    .getByRole('button', { name: vehicle ? /Fordonsvåg/ : /Materialvåg/ })
    .click();
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
      name: finish ? /Färdigvägt/ : /Nästa material/,
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
    page.getByRole('heading', { name: 'Vägningen är sparad' }),
  ).toBeVisible();
  await expect(
    page.getByText('Inget skickas till kontoret i demon.', { exact: false }),
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
    .getByRole('button', { name: 'Lägg till separat material', exact: true })
    .click();
  await choose(page, 'Koppar', 'Koppar klass 1');
  await page.getByRole('textbox', { name: 'Vikt i kg' }).fill('12');
  await page.getByRole('button', { name: 'Färdigvägt' }).click();
  await expect(page.getByLabel('Vikt vid infart')).toHaveValue('2004');
  await page.getByRole('button', { name: 'Spara infart' }).click();
  await expect(page.getByRole('heading', { name: 'Gårdsappen' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('GHI456');
  await page.locator('.pending-mini').filter({ hasText: 'GHI456' }).click();
  await page.getByLabel('Vikt vid utfart').fill('2005');
  await page.getByRole('button', { name: 'Färdigvägt', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Utfartsvikten måste vara lägre',
  );
  await page.getByLabel('Vikt vid utfart').fill('1880');
  await page.getByRole('button', { name: 'Färdigvägt', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Sammanställning' }),
  ).toBeVisible();
  await expect(page.getByTestId('total-weight')).toHaveText('136 kg');
  await expect(
    page.locator('.summary-row').filter({ hasText: 'Järnskrot' }),
  ).toContainText('124 kg');
  await expect(
    page.locator('.summary-row').filter({ hasText: 'Koppar klass 1' }),
  ).toContainText('12 kg');
  await page.getByRole('button', { name: 'Spara färdig vägning' }).click();
  await expect(
    page.getByRole('heading', { name: 'Vägningen är sparad' }),
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
  await page.getByRole('button', { name: 'Färdigvägt', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Ange en orsak');
  await page.getByLabel('Orsak', { exact: true }).fill('Betongrester');
  await page.getByRole('button', { name: 'Färdigvägt', exact: true }).click();
  await expect(page).toHaveURL(/\/summary$/);
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
    .getByRole('button', { name: /Öppna vägning/ })
    .click();
  await expect(page).toHaveURL(/\/summary$/);
  await expect(page.getByTestId('total-weight')).toHaveText('830 kg');
});

test('en påbörjad decimalvikt återställs efter omladdning och kan fortsättas', async ({
  page,
}) => {
  await login(page);
  await start(page);
  await choose(page, 'Koppar', 'Koppar klass 1');
  await page.getByRole('textbox', { name: 'Vikt i kg' }).fill('12,5');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('jeroc.mobile.demo.v1')!).drafts.find(
            (d: { number: number }) => d.number === 1418,
          )?.pendingWeight?.value,
      ),
    )
    .toBe('12,5');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Vikt i kg' })).toHaveValue(
    '12,5',
  );
  await page.getByRole('button', { name: 'Avbryt materialrad' }).click();
  await page.getByRole('button', { name: 'Fortsätt väga' }).click();
  await expect(page.getByRole('textbox', { name: 'Vikt i kg' })).toHaveValue(
    '12,5',
  );
  await page.getByRole('button', { name: /Färdigvägt/ }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('12,5 kg');
});

test('ny kund väljs och byte av kund rensar den gamla kundens referens', async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Vägningar' })
    .click();
  await page
    .locator('.draft-card')
    .filter({ hasText: '#1414' })
    .getByRole('button', { name: /Öppna vägning/ })
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
    .getByRole('button', { name: 'Vägningar' })
    .click();
  await page
    .locator('.draft-card')
    .filter({ hasText: '#1414' })
    .getByRole('button', { name: /Öppna vägning/ })
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
    page.getByRole('heading', { name: 'Vägningen är sparad' }),
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

test('snabba växelvisa siffertangenter registreras en gång och 0 kan inte sparas', async ({
  page,
}) => {
  await login(page);
  await start(page);
  await choose(page, 'Koppar', 'Koppar klass 1');
  await page.getByRole('button', { name: 'Färdigvägt', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('större än 0');
  await page.evaluate(() => {
    for (const digit of '131313') {
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>('.keypad button'),
      ].find((b) => b.getAttribute('aria-label') === digit)!;
      button.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerType: 'touch',
          isPrimary: true,
          button: 0,
        }),
      );
      button.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          pointerType: 'touch',
          isPrimary: true,
          button: 0,
        }),
      );
      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      );
    }
  });
  await expect(page.getByRole('textbox', { name: 'Vikt i kg' })).toHaveValue(
    '131313',
  );
  await page.getByRole('button', { name: 'Färdigvägt', exact: true }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('131 313 kg');
  const data = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.mobile.demo.v1')!),
  );
  expect(
    data.drafts.find((d: { number: number }) => d.number === 1418).rows,
  ).toHaveLength(1);
});

test('tillbaka och X sparar ingen ny materialrad och bevarar tidigare vikter', async ({
  page,
}) => {
  await login(page);
  await start(page);
  await choose(page, 'Koppar', 'Koppar klass 1');
  await page.getByRole('textbox', { name: 'Vikt i kg' }).fill('99');
  await page.getByRole('button', { name: 'Tillbaka', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Koppar klass 1' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Välj Koppar klass 1', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: 'Vikt i kg' })).toHaveValue(
    '',
  );
  await page.getByRole('button', { name: 'Avbryt materialrad' }).click();
  await expect(
    page.getByRole('heading', { name: 'Välj material' }),
  ).toBeVisible();
  await addWeight(page, 'Koppar', 'Koppar klass 1', '125');
  await page
    .getByRole('button', { name: 'Lägg till material', exact: true })
    .click();
  await choose(page, 'Rostfritt', 'Rostfritt');
  await page.getByRole('textbox', { name: 'Vikt i kg' }).fill('77');
  await page.getByRole('button', { name: 'Avbryt materialrad' }).click();
  await expect(
    page.getByRole('heading', { name: 'Avbryt utan att spara vikten?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Avbryt', exact: true }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('125 kg');
  await page.reload();
  await expect(page.locator('.summary-row')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Fortsätt ange vikt' }),
  ).toHaveCount(0);
});

test('färdig vägning är låst även via gamla redigeringslänkar', async ({
  page,
}) => {
  await login(page);
  await start(page);
  await addWeight(page, 'Koppar', 'Koppar klass 1', '125');
  const base = page.url().replace(/summary$/, '');
  await page.getByRole('button', { name: 'Spara färdig vägning' }).click();
  await expect(
    page.getByRole('heading', { name: 'Vägningen är sparad' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Öppna vägningen' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Ny vägning', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Vägningar' })
    .click();
  await page.getByRole('tab', { name: 'Historik' }).click();
  await page.getByRole('button', { name: /Öppna vägning/ }).click();
  await expect(page.getByText('Färdig · låst', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Spara färdig vägning' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Ändra Koppar/ })).toHaveCount(
    0,
  );
  for (const path of [
    'weight/copper-1',
    'customer',
    'reference',
    'vehicle',
    'materials',
  ]) {
    await page.goto(base + path);
    await expect(
      page.getByRole('heading', { name: 'Vägning #1418' }),
    ).toBeVisible();
    await expect(page.getByTestId('total-weight')).toHaveText('125 kg');
  }
  const data = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.mobile.demo.v1')!),
  );
  expect(
    data.drafts.find((d: { number: number }) => d.number === 1418),
  ).toMatchObject({ status: 'ready', rows: [{ weight: 125 }] });
});

test('kundens sparade registreringsnummer föreslår kund och utfarten visar referens', async ({
  page,
}) => {
  await login(page);
  await start(page, true);
  await page.getByLabel('Registreringsnummer').fill('JKL789');
  await page.getByRole('button', { name: /Välj material/ }).click();
  await choose(page, 'Järn', 'Järnskrot');
  await page.getByLabel('Vikt vid infart').fill('3240');
  const gross = await page.getByLabel('Vikt vid infart').boundingBox();
  const separate = await page
    .getByRole('button', { name: 'Lägg till separat material' })
    .boundingBox();
  expect(gross!.y).toBeLessThan(separate!.y);
  await expect(
    page.getByLabel('Referens (valfritt)', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Spara infart' }).click();
  await page.locator('.pending-mini').filter({ hasText: 'JKL789' }).click();
  await page.getByRole('button', { name: 'Välj kund', exact: true }).click();
  await page
    .locator('.customer-choice')
    .filter({ hasText: 'Bygg & Riv AB' })
    .click();
  await page.getByRole('button', { name: 'Koppla JKL789 till kunden' }).click();
  await page.getByRole('button', { name: 'Klar', exact: true }).click();
  await expect(page.locator('.vehicle-customer')).toContainText(
    'Bygg & Riv AB',
  );
  await page
    .getByLabel('Referens (valfritt)', { exact: true })
    .fill('Projekt Solbacken');
  await page
    .getByLabel('Materialets ursprungsadress (valfritt)')
    .fill('Testgatan 12');
  await page.getByLabel('Vikt vid utfart').fill('1680');
  await page.getByRole('button', { name: 'Färdigvägt', exact: true }).click();
  await page.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Hem', exact: true })
    .click();
  await start(page, true);
  await page.getByLabel('Registreringsnummer').fill('jkl 789');
  await expect(page.locator('.vehicle-customer')).toContainText(
    'Bygg & Riv AB',
  );
  await page.reload();
  await expect(page.locator('.vehicle-customer')).toContainText(
    'Bygg & Riv AB',
  );
});

test('referensbilder byts med svep och fasta kontroller ligger kvar vid lång information', async ({
  page,
}) => {
  await login(page);
  await start(page);
  await page.locator('.material-choice').filter({ hasText: 'Koppar' }).click();
  await page
    .locator('.material-choice')
    .filter({ hasText: 'Koppar klass 1' })
    .click();
  await expect(page.locator('.overlay-dots')).toHaveAttribute(
    'aria-label',
    'Bild 1 av 4',
  );
  const area = await page.locator('.gallery').boundingBox();
  const session = await page.context().newCDPSession(page);
  const x = area!.x + area!.width * 0.8,
    y = area!.y + 100;
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: x - 110, y }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect(page.locator('.overlay-dots')).toHaveAttribute(
    'aria-label',
    'Bild 2 av 4',
  );
  await expect(page.locator('.gallery-thumbs')).toHaveCount(0);
  await expect(page.locator('.gallery-arrow')).toHaveCount(0);
  const header = await page.locator('.page-header').boundingBox();
  const button = await page
    .getByRole('button', { name: 'Välj Koppar klass 1', exact: true })
    .boundingBox();
  await page.evaluate(() => {
    const info = document.querySelector('.classification.excluded p')!;
    info.textContent = 'Mer materialinformation. '.repeat(120);
    document.querySelector('.article-info')!.scrollTop = 10000;
  });
  expect((await page.locator('.page-header').boundingBox())!.y).toBe(header!.y);
  expect(
    (await page
      .getByRole('button', { name: 'Välj Koppar klass 1', exact: true })
      .boundingBox())!.y,
  ).toBe(button!.y);
  expect(
    await page.locator('.article-info').evaluate((el) => el.scrollTop),
  ).toBeGreaterThan(0);
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
]) {
  test(`login, lösenord, hem och vikt ryms utan sidscroll ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const fits = async () => {
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight),
      ).toBeLessThanOrEqual(viewport.height);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(viewport.width);
    };
    await page.goto('/');
    await fits();
    await page.getByRole('button', { name: 'Öppna demokontot' }).click();
    await fits();
    await page.getByLabel('Nytt lösenord', { exact: true }).fill('Test12345!');
    await page.getByLabel('Bekräfta nytt lösenord').fill('Test12345!');
    await page.getByRole('button', { name: 'Spara och fortsätt' }).click();
    await fits();
    await start(page);
    await choose(page, 'Koppar', 'Koppar klass 1');
    await fits();
    const action = await page
      .getByRole('button', { name: 'Färdigvägt', exact: true })
      .boundingBox();
    expect(action!.y + action!.height).toBeLessThanOrEqual(viewport.height);
    await page.getByRole('textbox', { name: 'Vikt i kg' }).fill('999999');
    expect(
      await page
        .getByRole('textbox', { name: 'Vikt i kg' })
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBeTruthy();
  });
}

async function swipeCard(
  page: Page,
  card: ReturnType<Page['locator']>,
  distance: number,
  vertical = 0,
) {
  const area = await card.boundingBox();
  const session = await page.context().newCDPSession(page);
  const x = area!.x + area!.width - 28,
    y = area!.y + area!.height / 2;
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 5; step++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: x - (distance * step) / 5, y: y - (vertical * step) / 5 },
      ],
    });
  }
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await session.detach();
}

test('svep visar radering, kräver bekräftelse och behåller utkast vid Nej', async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Vägningar' })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Pågående', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('button', { name: 'Fortsätt', exact: true }),
  ).toHaveCount(0);
  const draft = page.getByRole('button', {
    name: 'Öppna vägning 1414',
    exact: true,
  });
  await swipeCard(page, draft, 65);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Radera vägning 1414', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText(
    'Vill du radera detta utkast?',
  );
  await page.getByRole('button', { name: 'Nej', exact: true }).click();
  await expect(draft).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await swipeCard(page, draft, 155);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Ja, radera', exact: true }).click();
  await expect(draft).toHaveCount(0);
  await page.reload();
  await expect(draft).toHaveCount(0);
  await swipeCard(
    page,
    page.getByRole('button', { name: 'Öppna vägning 1416', exact: true }),
    155,
  );
  await expect(page.getByRole('dialog')).toContainText(
    'Vill du radera denna pågående fordonsvägning?',
  );
  await page.getByRole('button', { name: 'Stäng', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Öppna vägning 1416', exact: true }),
  ).toBeVisible();
});

test('vägningsflikar och sök står kvar vid scroll, historik saknar radering', async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Vägningar' })
    .click();
  const controls = await page.locator('.weighings-controls').boundingBox();
  const list = page.locator('.weighings-list');
  await swipeCard(
    page,
    page.getByRole('button', { name: 'Öppna vägning 1414', exact: true }),
    0,
    100,
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Vägningar', exact: true }),
  ).toBeVisible();
  await list.evaluate((el) => {
    const spacer = document.createElement('div');
    spacer.style.height = '1800px';
    el.appendChild(spacer);
    el.scrollTop = 900;
  });
  expect((await page.locator('.weighings-controls').boundingBox())!.y).toBe(
    controls!.y,
  );
  await expect(
    page.getByPlaceholder('Sök kund, regnummer eller vägning'),
  ).toBeVisible();
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.getByRole('tab', { name: 'Historik', exact: true }).click();
  await expect(page.locator('.swipe-delete')).toHaveCount(0);
});

test('kundval visar artikelns demopris, kan bytas och kryss återställer A/B/C utan att ändra vägningar', async ({
  page,
}) => {
  await login(page);
  const before = await page.evaluate(() =>
    localStorage.getItem('jeroc.mobile.demo.v1'),
  );
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Prislista' })
    .click();
  await page.getByRole('searchbox').fill('Koppar klass 1');
  await page
    .getByRole('button', { name: 'Lägg till kund', exact: true })
    .click();
  await page.getByPlaceholder('Sök kund eller kundnummer').fill('Bygg');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Bygg & Riv AB/ })
    .click();
  await expect(page.locator('.price-row')).toContainText('84,00');
  await expect(page.locator('.price-row')).toContainText('Specialpris');
  await expect(page.locator('.price-head')).toContainText('Kundpris');
  await page.getByRole('button', { name: 'Byt kund i prislistan' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Erik Johansson/ })
    .click();
  await expect(page.locator('.price-row')).toContainText('73,80');
  await expect(page.locator('.price-row .badge')).toHaveText('B');
  await page.getByRole('searchbox').fill('Järnskrot');
  await expect(page.locator('.price-row')).toContainText('1,92');
  await expect(page.locator('.price-row .badge')).toHaveText('C');
  await page.getByRole('button', { name: 'Ta bort vald kund' }).click();
  await expect(page.locator('.price-row .price-value')).toHaveCount(3);
  await expect(
    page.getByRole('button', { name: 'Lägg till kund', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem('jeroc.mobile.demo.v1')),
  ).toBe(before);
});

test('artikelpriser visar perioder, kundjämförelse och behåller kund och sökning vid tillbaka', async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Prislista' })
    .click();
  await page.getByRole('searchbox').fill('Koppar klass 1');
  await page
    .getByRole('button', {
      name: 'Visa priser för Koppar klass 1',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Aktuella priser' }),
  ).toBeVisible();
  await expect(page.locator('.article-current-prices')).toContainText('82,00');
  await expect(
    page.getByRole('img', { name: 'A/B/C pristrend, 12 månader', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '3 mån', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '3 mån', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('img', { name: 'A/B/C pristrend, 3 månader', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Lägg till kund', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Bygg & Riv AB/ })
    .click();
  await expect(page.locator('.customer-price-highlight')).toContainText(
    '84,00 kr/kg',
  );
  await expect(page.locator('.customer-price-comparison')).toContainText(
    '+10,20',
  );
  await expect(
    page.getByRole('img', {
      name: /A\/B\/C pristrend, 3 månader, med kundpris/,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator('.customer-price-highlight')).toContainText(
    '84,00 kr/kg',
  );
  await page.getByRole('button', { name: 'Tillbaka', exact: true }).click();
  await expect(page.getByRole('searchbox')).toHaveValue('Koppar klass 1');
  await expect(
    page.getByRole('button', { name: 'Byt kund i prislistan' }),
  ).toContainText('Bygg & Riv AB');
  await page
    .getByRole('button', {
      name: 'Visa priser för Koppar klass 1',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', { name: 'Ta bort vald kund', exact: true })
    .click();
  await expect(page.locator('.customer-price-highlight')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Aktuella priser' }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'A/B/C pristrend, 12 månader', exact: true }),
  ).toBeVisible();
});

for (const width of [375, 390]) {
  test(`prislistans titel, kundval och sökning är fasta vid scroll ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 667 });
    await login(page);
    await page
      .getByRole('navigation')
      .getByRole('button', { name: 'Prislista' })
      .click();
    const header = page.locator('.prices-fixed-top');
    const position = await header.boundingBox();
    const add = await page
      .getByRole('button', { name: 'Lägg till kund', exact: true })
      .boundingBox();
    const title = await page
      .getByRole('heading', { name: 'Prislista', exact: true })
      .boundingBox();
    expect(add!.x).toBeGreaterThan(title!.x + title!.width - 1);
    await page
      .locator('.prices-scroll-list')
      .evaluate((el) => (el.scrollTop = 600));
    expect((await header.boundingBox())!.y).toBe(position!.y);
    await expect(page.getByRole('searchbox')).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page
      .getByRole('button', { name: 'Lägg till kund', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Anderssons Entreprenad/ })
      .click();
    await expect(
      page.getByRole('button', { name: 'Ta bort vald kund' }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}

test('senast sparad infart och senast öppnat utkast ligger överst även med äldre demokort från framtiden', async ({
  page,
}) => {
  await login(page);
  await page.locator('.ongoing-list .pending-mini').first().click();
  await page.goto('/');
  await page.evaluate(() => {
    const key = 'jeroc.mobile.demo.v1';
    const data = JSON.parse(localStorage.getItem(key)!);
    for (const draft of data.drafts) {
      draft.updatedAt = '2099-01-01T00:00:00.000Z';
      delete draft.activityOrder;
    }
    localStorage.setItem(key, JSON.stringify(data));
  });
  await page.reload();
  await start(page, true);
  await page.getByLabel('Registreringsnummer').fill('GHI789');
  await page.getByRole('button', { name: /Välj material/ }).click();
  await choose(page, 'Järn', 'Järnskrot');
  await page.getByLabel('Vikt vid infart').fill('3240');
  await page.getByRole('button', { name: 'Spara infart', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Gårdsappen', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.ongoing-list .pending-mini').first(),
  ).toContainText('GHI789');
  await page.reload();
  await expect(
    page.locator('.ongoing-list .pending-mini').first(),
  ).toContainText('GHI789');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Vägningar' })
    .click();
  await expect(page.locator('.weighing-card-content').first()).toContainText(
    'GHI789',
  );
  await page
    .getByRole('button', { name: 'Öppna vägning 1414', exact: true })
    .click();
  await page.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Hem', exact: true })
    .click();
  await expect(
    page.locator('.ongoing-list .pending-mini').first(),
  ).toContainText('#1414');
});
