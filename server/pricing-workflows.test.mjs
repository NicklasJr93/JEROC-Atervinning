import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createPricingStore, money, PricingError } from './pricing.mjs';
import { createPricingApi } from './pricing-api.mjs';

const setup = () => {
  const store = createPricingStore({
    now: () => new Date('2026-10-07T12:00:00Z'),
  });
  return {
    store,
    admin: store.principal('admin'),
    lars: store.principal('lars'),
    kajsa: store.principal('kajsa'),
    anna: store.principal('anna'),
  };
};
const fails = (action, status) =>
  assert.throws(
    action,
    (failure) => failure instanceof PricingError && failure.status === status,
  );
const original = {
  cardId: 7000,
  customerId: 'customer-andersson',
  deliveredAt: '2026-09-05',
  preparedBy: 'kajsa',
  rows: [{ articleId: 'copper-1', weight: 150, price: 77.31, tier: 'A' }],
};
const correction = (sourceSnapshotId, extra = {}) => ({
  sourceSnapshotId,
  cardId: 'R-7000',
  rows: [{ articleId: 'copper-1', weightDelta: -100 }],
  reason: 'Registrerad mängd var 100 kg för stor.',
  correctedAt: '2026-10-07',
  creatorId: 'kajsa',
  document: 'Underlag Y',
  ...extra,
});

test('registering a customer enables volume quotes and agreements without exposing payment data', () => {
  const { store, kajsa, anna } = setup();
  const payload = {
    id: 'customer-new',
    name: 'Ny Kund AB',
    bankAccount: 'should-never-be-stored',
  };
  const saved = store.saveCustomer(payload, kajsa);
  assert.deepEqual(saved.customer, { id: 'customer-new', name: 'Ny Kund AB' });
  const revision = store.read(kajsa).revision;
  assert.deepEqual(store.saveCustomer(payload, kajsa), saved);
  assert.equal(store.read(kajsa).revision, revision);
  const quote = store.quote(
    {
      customerId: payload.id,
      deliveredAt: '2026-10-07',
      rows: [{ articleId: 'copper-1', weight: 101 }],
    },
    kajsa,
  );
  assert.equal(quote.rows[0].tier, 'A');
  assert.equal(quote.rows[0].volumeBefore, 0);
  fails(
    () => store.saveCustomer({ ...payload, name: 'Otillåten ändring' }, anna),
    403,
  );
  assert.equal(
    store.read(kajsa).customers.find((item) => item.id === payload.id).name,
    payload.name,
  );
});

test('customer previews use recorded per-article rolling volume without adding hypothetical deliveries', () => {
  const { store, lars, anna } = setup();
  const archived = store.restoreLegacySnapshot(
    { ...original, rows: [{ ...original.rows[0], weight: 49.5 }] },
    lars,
  );
  const before = store.read(lars);
  const current = store.customerPreview(
    anna,
    'customer-andersson',
    '2026-10-07',
  );
  const copper = current.rows.find((row) => row.articleId === 'copper-1');
  assert.equal(copper.weight, 0);
  assert.equal(copper.volumeBefore, 49.5);
  assert.equal(copper.volumeWithDelivery, 49.5);
  assert.equal(copper.tier, 'C'); // A fabricated one-kg delivery would cross B.
  assert.equal(copper.price, 65.6);
  assert.equal(
    current.rows.find((row) => row.articleId === 'iron').volumeBefore,
    0,
  );
  assert.equal(
    store
      .customerPreview(lars, 'customer-andersson', '2027-10-07')
      .rows.find((row) => row.articleId === 'copper-1').volumeBefore,
    0,
  );
  assert.deepEqual(store.read(lars), before);
  assert.equal(store.snapshots(lars, 7000)[0].id, archived.id);
});

test('view-only customer register access keeps all prices, agreements, ledger and LME hidden', () => {
  const { store, admin } = setup();
  const users = store.read(admin).users;
  users.push({
    id: 'view-only',
    name: 'Endast kort',
    level: 'Medarbetare',
    permissions: ['view'],
    maxAttest: 0,
    ownAttest: false,
  });
  store.saveUsers({ users }, admin);
  const user = store.principal('view-only');
  const state = store.read(user);
  assert.equal(state.customers.length, 4);
  assert.deepEqual(state.customerPrices, []);
  assert.deepEqual(state.lme, []);
  assert.equal(state.ledger, undefined);
  assert.ok(
    state.articles.every(
      (article) =>
        Object.values(article.prices).every((price) => price === null) &&
        article.base == null,
    ),
  );
  fails(() => store.customerPreview(user, 'customer-build'), 403);
});

test('legacy originals are restored at their frozen prices and retry atomically without counting twice', () => {
  const { store, lars, kajsa } = setup();
  fails(() => store.restoreLegacySnapshot(original, kajsa), 403);
  const source = store.restoreLegacySnapshot(original, lars);
  assert.equal(source.rows[0].price, 77.31);
  assert.equal(source.total, 11596.5);
  const before = store.read(lars);
  assert.deepEqual(store.restoreLegacySnapshot(original, lars), source);
  fails(
    () =>
      store.restoreLegacySnapshot(
        { ...original, rows: [{ ...original.rows[0], price: 99 }] },
        lars,
      ),
    409,
  );
  fails(
    () =>
      store.restoreLegacySnapshot(
        { ...original, cardId: 7001, preparedBy: 'missing-user' },
        lars,
      ),
    422,
  );
  assert.deepEqual(store.read(lars), before);
  assert.equal(
    store.volume(original.customerId, 'copper-1', '2026-10-07'),
    150,
  );
});

test('approved corrections use immutable original prices and are idempotent in both directions', () => {
  const { store, lars, anna } = setup();
  const source = store.restoreLegacySnapshot(original, lars);
  // Anna can attest another person's correction without permission to create it.
  const request = correction(source.id);
  const minus = store.approveCorrection(request, anna);
  assert.equal(minus.total, -7731);
  assert.equal(minus.document, 'Underlag Y');
  assert.equal(minus.approvedBy, 'anna');
  assert.equal(store.volume(original.customerId, 'copper-1', '2026-10-07'), 50);
  const before = store.read(lars);
  assert.deepEqual(store.approveCorrection(request, anna), minus);
  assert.deepEqual(store.read(lars), before);
  fails(
    () =>
      store.approveCorrection(
        correction(minus.id, { cardId: 'R-recursive' }),
        anna,
      ),
    422,
  );
  fails(
    () =>
      store.approveCorrection({ ...request, reason: 'Annat underlag' }, anna),
    409,
  );
  const plus = store.approveCorrection(
    correction(source.id, {
      cardId: 'R-7001',
      rows: [{ articleId: 'copper-1', weightDelta: 60 }],
    }),
    anna,
  );
  assert.equal(plus.total, 4638.6);
  assert.equal(
    store.volume(original.customerId, 'copper-1', '2026-10-07'),
    110,
  );
  assert.deepEqual(store.snapshots(lars, 7000)[0], source);
});

test('a local Eget label matches its frozen Special source without repricing or duplicate volume', () => {
  const { store, lars, anna } = setup();
  const source = store.snapshot(
    {
      cardId: 7100,
      customerId: 'customer-build',
      deliveredAt: '2026-10-07',
      rows: [{ articleId: 'copper-1', weight: 101 }],
    },
    lars,
  );
  assert.equal(source.rows[0].tier, 'Special');
  assert.equal(source.rows[0].price, 84);
  const local = {
    cardId: source.cardId,
    customerId: source.customerId,
    deliveredAt: source.deliveredAt,
    preparedBy: source.preparedBy,
    rows: source.rows.map(({ articleId, weight, price }) => ({
      articleId,
      weight,
      price,
      tier: 'Eget',
    })),
  };
  const before = store.read(lars);
  const restored = store.restoreLegacySnapshot(local, anna);
  assert.equal(restored.id, source.id);
  assert.equal(restored.rows[0].tier, 'Special');
  assert.equal(restored.total, source.total);
  assert.deepEqual(store.read(lars), before);
  fails(
    () =>
      store.restoreLegacySnapshot(
        {
          ...local,
          rows: [{ ...local.rows[0], tier: 'A' }],
        },
        anna,
      ),
    409,
  );
  fails(
    () =>
      store.restoreLegacySnapshot(
        {
          ...local,
          rows: [{ ...local.rows[0], price: 83 }],
        },
        anna,
      ),
    409,
  );
  const credit = store.approveCorrection(
    correction(source.id, {
      cardId: 'R-special',
      rows: [{ articleId: 'copper-1', weightDelta: -1 }],
    }),
    anna,
  );
  assert.equal(credit.total, -84);
  assert.equal(credit.rows[0].tier, 'Special');
  // The fresh demo contains no historical seed deliveries. Only this original
  // and its signed correction contribute to the customer's physical volume.
  assert.equal(store.volume(source.customerId, 'copper-1', '2026-10-07'), 100);
  assert.deepEqual(store.snapshots(lars, source.cardId)[0], source);
});

test('correction approval enforces effective rights, own-attest and absolute amount caps before changing volume', () => {
  const { store, lars, anna, kajsa } = setup();
  const source = store.restoreLegacySnapshot(original, lars);
  const before = store.read(lars);
  fails(() => store.correct(correction(source.id), kajsa), 403);
  fails(
    () =>
      store.approveCorrection(
        correction(source.id),
        store.principal('admin', 'kajsa'),
      ),
    403,
  );
  fails(
    () =>
      store.approveCorrection(
        correction(source.id, { creatorId: 'anna' }),
        anna,
      ),
    403,
  );
  fails(
    () =>
      store.approveCorrection(
        correction(source.id, {
          rows: [{ articleId: 'copper-1', weightDelta: 400 }],
        }),
        anna,
      ),
    403,
  );
  fails(
    () =>
      store.approveCorrection(
        correction(source.id, {
          rows: [{ articleId: 'copper-1', weightDelta: -151 }],
        }),
        anna,
      ),
    422,
  );
  assert.deepEqual(store.read(lars), before);
});

test('correction own-attest checks both creator and submitter and retries preserve both identities', () => {
  const { store, admin, lars, anna } = setup();
  store.saveUsers(
    {
      users: store.read(admin).users.map((user) =>
        user.id === 'kajsa'
          ? {
              ...user,
              permissions: [...user.permissions, 'attest'],
              maxAttest: 25000,
            }
          : user,
      ),
    },
    admin,
  );
  const kajsa = store.principal('kajsa');
  const source = store.restoreLegacySnapshot(original, lars);
  const before = store.read(lars);
  // The creator cannot approve merely because someone else submits the card.
  fails(
    () =>
      store.approveCorrection(
        correction(source.id, {
          creatorId: 'kajsa',
          submittedBy: 'anna',
        }),
        kajsa,
      ),
    403,
  );
  // The submitter cannot approve merely because someone else created the card.
  fails(
    () =>
      store.approveCorrection(
        correction(source.id, {
          creatorId: 'kajsa',
          submittedBy: 'anna',
        }),
        anna,
      ),
    403,
  );
  fails(
    () =>
      store.approveCorrection(
        correction(source.id, {
          submittedBy: 'missing-user',
        }),
        anna,
      ),
    422,
  );
  assert.deepEqual(store.read(lars), before);
  const request = correction(source.id, {
    creatorId: 'kajsa',
    submittedBy: 'anna',
  });
  const approved = store.approveCorrection(request, lars);
  assert.equal(approved.preparedBy, 'kajsa');
  assert.equal(approved.submittedBy, 'anna');
  const after = store.read(lars);
  assert.deepEqual(store.approveCorrection(request, lars), approved);
  assert.deepEqual(store.read(lars), after);
  fails(
    () => store.approveCorrection({ ...request, submittedBy: 'lars' }, lars),
    409,
  );
});

test('signed corrections round negative half cents symmetrically and preserve the first approval on retry', () => {
  const { store, lars } = setup();
  for (const value of [0.005, 1.005, 1.235, 77.315, 0.0049]) {
    assert.equal(money(-value), money(value) ? -money(value) : 0);
  }
  assert.equal(money(-0.005), -0.01);
  assert.equal(Object.is(money(-0.0049), -0), false);
  const source = store.restoreLegacySnapshot(
    {
      ...original,
      rows: [{ ...original.rows[0], weight: 1, price: 0.01 }],
    },
    lars,
  );
  const request = correction(source.id, {
    rows: [{ articleId: 'copper-1', weightDelta: -0.5 }],
  });
  const approved = store.approveCorrection(
    request,
    store.principal('admin', 'anna'),
  );
  assert.equal(approved.total, -0.01);
  assert.equal(approved.actor, 'admin');
  assert.equal(approved.actingUser, 'anna');
  assert.equal(approved.approvedBy, 'anna');
  const beforeRetry = store.read(lars);
  const retried = store.approveCorrection(request, lars);
  assert.equal(retried.id, approved.id);
  assert.equal(retried.actor, 'admin');
  assert.equal(retried.actingUser, 'anna');
  assert.equal(retried.approvedBy, 'anna');
  assert.deepEqual(store.read(lars), beforeRetry);
  const plus = store.approveCorrection(
    correction(source.id, {
      cardId: 'R-half-cent-plus',
      rows: [{ articleId: 'copper-1', weightDelta: 0.5 }],
    }),
    lars,
  );
  assert.equal(plus.total, 0.01);
  const entries = store
    .read(lars)
    .ledger.filter((entry) => entry.sourceSnapshotId === source.id);
  assert.equal(
    entries.reduce((sum, entry) => sum + entry.amountDelta, 0),
    0,
  );
});

test('HTTP customer and approval routes retain effective-account authorization and read-only previews', async () => {
  const { store } = setup();
  const api = createPricingApi({ store });
  const server = createServer(
    (req, res) => void api(req, res, new URL(req.url, 'http://localhost')),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/pricing/`;
    const headers = {
      'X-Demo-Actor': 'admin',
      'X-Demo-User': 'kajsa',
      'Content-Type': 'application/json',
    };
    const customer = await fetch(`${base}customers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'customer-http', name: 'HTTP Kund' }),
    });
    assert.equal(customer.status, 200);
    const preview = await fetch(
      `${base}customer-preview?customerId=customer-http&at=2026-10-07`,
      { headers },
    );
    assert.equal(preview.status, 200);
    assert.ok(
      (await preview.json()).rows.every(
        (row) => row.weight === 0 && row.volumeBefore === 0,
      ),
    );
    const forbidden = await fetch(`${base}legacy-snapshots`, {
      method: 'POST',
      headers,
      body: JSON.stringify(original),
    });
    assert.equal(forbidden.status, 403);
    const imported = await fetch(`${base}legacy-snapshots`, {
      method: 'POST',
      headers: { ...headers, 'X-Demo-User': 'anna' },
      body: JSON.stringify(original),
    });
    assert.equal(imported.status, 201);
    const source = await imported.json();
    const approval = await fetch(`${base}approved-corrections`, {
      method: 'POST',
      headers: { ...headers, 'X-Demo-User': 'anna' },
      body: JSON.stringify(correction(source.id)),
    });
    assert.equal(approval.status, 201);
    const result = await approval.json();
    assert.equal(result.total, -7731);
    assert.equal(result.actor, 'admin');
    assert.equal(result.actingUser, 'anna');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
