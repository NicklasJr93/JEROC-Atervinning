import { test, expect } from '@playwright/test';
import {
  seedOffice,
  OFFICE_WEIGHING_DEMO_VERSION,
  type OfficeCard,
  type OfficeData,
  type OfficeUser,
} from '../src/office/model';
import {
  approveCorrection,
  createCorrectionDraft,
  customerBalance,
  customerStats,
  migrateOffice,
  recordPayment,
  saveCardOnBalance,
  settlementPreview,
  submitCorrection,
} from '../src/office/customer-model';

function fixture(): OfficeData {
  const data = seedOffice();
  // Economic helpers are exercised against an explicit completed test case.
  // The public demo starts with unapproved cards and contains no paid seed card.
  const customer = data.customers.find((entry) => entry.id === 'customer-erik')!;
  const card: OfficeCard = {
    id: 2038,
    sourceId: 'f239a9da-6b65-4fdc-a2b8-9ec000002038',
    customerId: customer.id,
    customerSnapshot: structuredClone(customer),
    status: 'paid',
    siteId: 'norrtalje',
    customerApproval: {
      id: 'unit-approved-2038', version: 1, status: 'attested',
      updatedAt: '2026-10-07T09:00:00Z',
      approvedBy: 'Kajsa Nilsson', approvedAt: '2026-10-07T08:50:00Z',
      attestedBy: 'Anna Nilsson', attestedAt: '2026-10-07T09:00:00Z',
    },
    yard: 'Norrtälje', weigher: 'Niklas', date: '2026-10-07T08:41:00Z',
    reference: 'Avslutad enhetstestleverans', origin: 'Testgatan 12, Norrtälje',
    payment: 'Kontant', paymentDetails: { method: 'cash' },
    idVerified: true, preparedBy: 'kajsa', approvedBy: 'anna',
    paidAt: '2026-10-07T09:05:00Z',
    rows: [{ articleId: 'iron', weight: 124, tier: 'C', price: 1.92 }],
    audit: [],
  };
  data.cards = [card];
  return data;
}

function actor(data: OfficeData, id: string, extra: Partial<OfficeUser> = {}) {
  const user = { ...data.users.find((entry) => entry.id === id)!, ...extra };
  return { user, office: 'Kontor Norrtälje', now: '2026-10-07T12:00:00Z' };
}

function negativeCorrection(data: OfficeData, quantity = -100) {
  const drafted = createCorrectionDraft(
    data,
    {
      cardId: 2038,
      articleId: 'iron',
      weightDelta: quantity,
      reason: 'Materialet var felregistrerat',
      document: 'Rättelseunderlag Y',
    },
    actor(data, 'kajsa'),
  );
  const submitted = submitCorrection(
    drafted,
    drafted.corrections[0].id,
    actor(drafted, 'kajsa'),
  );
  return approveCorrection(
    submitted,
    submitted.corrections[0].id,
    actor(submitted, 'anna'),
  );
}

test('den godkända demoåterställningen ersätter gamla viktkort och deras ekonomidata en gång men bevarar kunder och användare', () => {
  const old = fixture();
  old.customers[0].name = 'Bevarad testkund AB';
  old.users[0].name = 'Bevarad kontorist';
  old.cards[0].payment = 'Tidigare betalningsunderlag · konto ****7890';
  const legacy = {
    ...old, weighingDemoVersion: undefined,
    payments: [{ id: 'old-payment', cardId: 2038, customerId: 'customer-erik', date: '2026-10-07T09:05:00Z', amount: 238.08, offset: 0, method: 'cash', actor: 'Anna Nilsson', office: 'Norrtälje', reference: 'Tidigare demo', correctionIds: [] }],
    corrections: [{ id: 1, cardId: 2038, customerId: 'customer-erik', articleId: 'iron', weightDelta: -10, reason: 'Tidigare demo', document: 'RU-OLD', actor: 'Kajsa Nilsson', at: '2026-10-07T10:00:00Z' }],
  };
  const migrated = migrateOffice(legacy);
  expect(migrated.weighingDemoVersion).toBe(OFFICE_WEIGHING_DEMO_VERSION);
  expect(migrated.cards.map((card) => card.id)).toEqual([2050, 2051, 2052, 2053]);
  expect(migrated.cards.every((card) => ['new', 'complement'].includes(card.status))).toBe(true);
  expect(migrated.cards.every((card) => !card.customerApproval && !card.idVerified && !card.approvedBy)).toBe(true);
  expect(migrated.customers).toEqual(old.customers);
  expect(migrated.users.map((user) => ({ id: user.id, name: user.name }))).toEqual(old.users.map((user) => ({ id: user.id, name: user.name })));
  expect(migrated.payments).toEqual([]);
  expect(migrated.corrections).toEqual([]);
  migrated.cards[0].reference = 'Ny ändring efter återställning';
  expect(migrateOffice(migrated)).toEqual(migrated);
});

test('låst kundögonblicksbild bevaras när kundregistret och betalningsprofilen ändras', () => {
  const fixtureData = fixture();
  const originalCustomer = fixtureData.customers.find((entry) => entry.id === 'customer-build')!;
  fixtureData.cards[0] = {
    ...fixtureData.cards[0], id: 2041, customerId: originalCustomer.id,
    customerSnapshot: structuredClone(originalCustomer), status: 'ready',
  };
  const migrated = migrateOffice(fixtureData);
  const original = structuredClone(
    migrated.cards.find((card) => card.id === 2041)!,
  );
  expect(original.customerSnapshot).toMatchObject({
    name: 'Bygg & Riv AB',
    id: 'customer-build',
  });
  const customer = migrated.customers.find(
    (entry) => entry.id === 'customer-build',
  )!;
  customer.name = 'Nytt företagsnamn AB';
  customer.address = 'Ny adress 99';
  customer.paymentProfile = {
    method: 'swish',
    phone: '0701234567',
    recipient: 'Ny mottagare',
  };
  const reloaded = migrateOffice(migrated);
  expect(reloaded.cards.find((card) => card.id === 2041)).toEqual(original);
  expect(
    reloaded.customers.find((entry) => entry.id === 'customer-build')
      ?.paymentProfile?.method,
  ).toBe('swish');
});

test('rättelsekort med samma lokala nummer får olika serveridentiteter och äldre utkast behåller sin identitet vid omladdning', () => {
  const data = fixture();
  const input = {
    cardId: 2038,
    articleId: 'iron',
    weightDelta: -10,
    reason: 'Fel vikt',
    document: 'Underlag Y',
  };
  const first = createCorrectionDraft(data, input, actor(data, 'kajsa'))
    .corrections[0];
  const otherBrowser = createCorrectionDraft(data, input, actor(data, 'kajsa'))
    .corrections[0];
  expect(first.id).toBe(otherBrowser.id);
  expect(first.serverId).toBeTruthy();
  expect(first.serverId).not.toBe(otherBrowser.serverId);
  const legacy = { ...data, corrections: [{ ...first, serverId: undefined }] };
  const migrated = migrateOffice(legacy);
  expect(migrated.corrections[0].serverId).toBeTruthy();
  expect(migrateOffice(migrated).corrections[0].serverId).toBe(
    migrated.corrections[0].serverId,
  );
});

test('rättelseutkast påverkar inte saldo och godkännande kräver attestbehörighet, beloppsgräns och annan person', () => {
  const data = fixture();
  const original = structuredClone(data.cards[0]);
  const drafted = createCorrectionDraft(
    data,
    {
      cardId: 2038,
      articleId: 'iron',
      weightDelta: -100,
      reason: 'Felregistrerad vikt',
      document: 'Underlag Y',
    },
    actor(data, 'kajsa'),
  );
  const id = drafted.corrections[0].id;
  expect(customerBalance(drafted, 'customer-erik')).toBe(0);
  expect(drafted.cards[0]).toEqual(original);
  const submitted = submitCorrection(drafted, id, actor(drafted, 'kajsa'));
  expect(customerBalance(submitted, 'customer-erik')).toBe(0);
  expect(() =>
    approveCorrection(submitted, id, actor(submitted, 'kajsa')),
  ).toThrow();
  expect(() =>
    approveCorrection(
      submitted,
      id,
      actor(submitted, 'anna', { maxAttest: 100 }),
    ),
  ).toThrow();
  const kajsa = submitted.users.find((user) => user.id === 'kajsa')!;
  expect(() =>
    approveCorrection(
      submitted,
      id,
      actor(submitted, 'kajsa', {
        permissions: [...kajsa.permissions, 'attest'],
        maxAttest: 100_000,
      }),
    ),
  ).toThrow();
  const approved = approveCorrection(submitted, id, actor(submitted, 'anna'));
  expect(customerBalance(approved, 'customer-erik')).toBe(-192);
  expect(
    customerStats(approved, 'customer-erik', '2026-10-07T12:00:00Z'),
  ).toMatchObject({
    totalKg: 24,
    totalValue: 46.08,
    weighingCount: 1,
    paidValue: 238.08,
  });
  expect(approved.cards[0]).toEqual(original);
  expect(approved.corrections[0]).toMatchObject({
    status: 'approved',
    approvedBy: 'anna',
  });
  expect(approveCorrection(approved, id, actor(approved, 'anna'))).toEqual(
    approved,
  );
});

test('negativa rättelser begränsas till originalets kvarvarande mängd', () => {
  const data = negativeCorrection(fixture(), -100);
  expect(() =>
    createCorrectionDraft(
      data,
      {
        cardId: 2038,
        articleId: 'iron',
        weightDelta: -25,
        reason: 'Ytterligare fel',
        document: 'Underlag Z',
      },
      actor(data, 'kajsa'),
    ),
  ).toThrow();
  expect(() =>
    createCorrectionDraft(
      data,
      {
        cardId: 2038,
        articleId: 'iron',
        weightDelta: -24,
        reason: 'Kvarvarande mängd fel',
        document: 'Underlag Z',
      },
      actor(data, 'kajsa'),
    ),
  ).not.toThrow();
});

test('rättelsens skapare får inte attestera den genom att låta någon annan skicka den till attest', () => {
  const data = fixture();
  const drafted = createCorrectionDraft(
    data,
    {
      cardId: 2038,
      articleId: 'iron',
      weightDelta: -100,
      reason: 'Felregistrerad vikt',
      document: 'Underlag Y',
    },
    actor(data, 'kajsa'),
  );
  const id = drafted.corrections[0].id;
  const submitted = submitCorrection(drafted, id, actor(drafted, 'lars'));
  const kajsa = submitted.users.find((user) => user.id === 'kajsa')!;
  expect(() =>
    approveCorrection(
      submitted,
      id,
      actor(submitted, 'kajsa', {
        permissions: [...kajsa.permissions, 'attest'],
        maxAttest: 100_000,
      }),
    ),
  ).toThrow();
  expect(
    approveCorrection(submitted, id, actor(submitted, 'anna')).corrections[0]
      .status,
  ).toBe('approved');
});

test('minussaldo kvittas mot nästa betalning och bara nettobeloppet blir utbetalt', () => {
  let data = negativeCorrection(fixture());
  data.cards.push({
    ...structuredClone(data.cards[0]),
    id: 5501,
    status: 'ready',
    rows: [{ articleId: 'iron', weight: 200, tier: 'A', price: 2 }],
    paymentDetails: {
      method: 'bank',
      clearing: '8327',
      account: '1234567890',
      holder: 'Erik Johansson',
    },
  });
  const original = structuredClone(data.cards.find((card) => card.id === 2038));
  const preview = settlementPreview(data, 5501);
  expect(preview).toMatchObject({ gross: 400, offset: 192, net: 208 });
  expect(preview.negativeCorrectionIds).toContain(data.corrections[0].id);
  data = recordPayment(data, 5501, actor(data, 'anna'));
  expect(data.payments.at(-1)).toMatchObject({
    cardId: 5501,
    amount: 208,
    offset: 192,
    method: 'bank',
  });
  expect(customerBalance(data, 'customer-erik')).toBe(0);
  expect(data.cards.find((card) => card.id === 2038)).toEqual(original);
  expect(recordPayment(data, 5501, actor(data, 'anna'))).toEqual(data);
});

test('minussaldo kvittas mot kortet som betalas utan att andra obetalda kort förskjuter skuldavdraget', () => {
  let data = negativeCorrection(fixture());
  for (const [id, weight] of [
    [5503, 200],
    [5504, 50],
  ]) {
    data.cards.push({
      ...structuredClone(data.cards[0]),
      id,
      status: 'ready',
      rows: [{ articleId: 'iron', weight, tier: 'A', price: 2 }],
      paymentDetails: { method: 'cash' },
    });
  }
  expect(settlementPreview(data, 5503)).toMatchObject({
    gross: 400,
    offset: 192,
    net: 208,
  });
  data = recordPayment(data, 5503, actor(data, 'anna'));
  expect(customerBalance(data, 'customer-erik')).toBe(100);
  expect(settlementPreview(data, 5504)).toMatchObject({
    gross: 100,
    offset: 0,
    net: 100,
  });
  data = recordPayment(data, 5504, actor(data, 'anna'));
  expect(
    data.payments.map((payment) => ({
      amount: payment.amount,
      offset: payment.offset,
    })),
  ).toEqual([
    { amount: 208, offset: 192 },
    { amount: 100, offset: 0 },
  ]);
  expect(data.payments[0].correctionIds).toEqual([data.corrections[0].id]);
  expect(data.payments[1].correctionIds).toEqual([]);
  expect(customerBalance(data, 'customer-erik')).toBe(0);
});

test('spara på saldo registrerar ingen betalning och kan senare betalas ut med ett riktigt betalningssätt', () => {
  let data = fixture();
  data.cards.push({
    ...structuredClone(data.cards[0]),
    id: 5502,
    status: 'ready',
    rows: [{ articleId: 'iron', weight: 100, tier: 'A', price: 2 }],
    paymentDetails: { method: 'balance' },
  });
  data = saveCardOnBalance(data, 5502, actor(data, 'anna'));
  expect(data.cards.find((card) => card.id === 5502)?.status).toBe('balance');
  expect(data.payments).toHaveLength(0);
  expect(customerBalance(data, 'customer-erik')).toBe(200);
  expect(() => recordPayment(data, 5502, actor(data, 'anna'))).toThrow();
  data = recordPayment(data, 5502, actor(data, 'anna'), { method: 'cash' });
  expect(data.payments.at(-1)).toMatchObject({
    cardId: 5502,
    amount: 200,
    method: 'cash',
  });
  expect(customerBalance(data, 'customer-erik')).toBe(0);
});

test('utbetalning kräver rättighet och ett känt ekonomiskt belopp', () => {
  const data = fixture();
  const card = data.cards[0];
  card.status = 'ready';
  card.paymentDetails = { method: 'cash' };
  expect(() => recordPayment(data, card.id, actor(data, 'kajsa'))).toThrow();
  card.financialPending = true;
  expect(() => recordPayment(data, card.id, actor(data, 'anna'))).toThrow();
  expect(data.payments).toEqual([]);
  expect(card.status).toBe('ready');
});

test('positiv rättelse skapar ett eget utbetalningskort och ingår bara en gång i kundens statistik', () => {
  const data = fixture();
  const drafted = createCorrectionDraft(
    data,
    {
      cardId: 2038,
      articleId: 'iron',
      weightDelta: 5,
      reason: 'Material saknades i vägningen',
      document: 'Underlag PLUS',
    },
    actor(data, 'kajsa'),
  );
  const id = drafted.corrections[0].id;
  const submitted = submitCorrection(drafted, id, actor(drafted, 'kajsa'));
  const approved = approveCorrection(submitted, id, actor(submitted, 'anna'));
  const child = approved.cards.find((card) => card.sourceCorrectionId === id)!;
  expect(child).toMatchObject({
    kind: 'correction',
    status: 'ready',
    customerId: 'customer-erik',
  });
  expect(child.rows).toMatchObject([
    { articleId: 'iron', weight: 5, tier: 'C', price: 1.92 },
  ]);
  expect(customerBalance(approved, 'customer-erik')).toBe(9.6);
  const stats = customerStats(
    approved,
    'customer-erik',
    '2026-10-07T12:00:00Z',
  );
  expect(stats).toMatchObject({
    totalKg: 129,
    totalValue: 247.68,
    weighingCount: 1,
    paidValue: 238.08,
    balance: 9.6,
  });
  expect(stats.articles).toMatchObject([
    { articleId: 'iron', weight: 129, value: 247.68, deliveryCount: 1 },
  ]);
  expect(stats.months.reduce((sum, month) => sum + month.weight, 0)).toBe(129);
  expect(stats.months.reduce((sum, month) => sum + month.count, 0)).toBe(1);
  expect(approved.cards.find((card) => card.id === 2038)).toEqual(
    data.cards[0],
  );
});

test('rättelser påverkar originalets tolvmånadersperiod även när pluskortet skapas idag', () => {
  const data = fixture();
  data.cards[0].date = '2025-08-10T08:00:00Z';
  const drafted = createCorrectionDraft(
    data,
    {
      cardId: 2038,
      articleId: 'iron',
      weightDelta: 5,
      reason: 'Kompletterad äldre leverans',
      document: 'Äldre underlag PLUS',
    },
    actor(data, 'kajsa'),
  );
  const id = drafted.corrections[0].id;
  const submitted = submitCorrection(drafted, id, actor(drafted, 'kajsa'));
  const approved = approveCorrection(submitted, id, actor(submitted, 'anna'));
  const stats = customerStats(
    approved,
    'customer-erik',
    '2026-10-07T12:00:00Z',
  );
  expect(stats).toMatchObject({
    totalKg: 0,
    totalValue: 0,
    weighingCount: 0,
    previousKg: 129,
    previousValue: 247.68,
    balance: 9.6,
  });
  expect(stats.articles).toEqual([]);
  expect(
    stats.months.every((month) => month.weight === 0 && month.count === 0),
  ).toBeTruthy();
});
