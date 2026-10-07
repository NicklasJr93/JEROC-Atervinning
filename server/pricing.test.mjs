import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  createPricingStore,
  PricingError,
  twelveMonthsBefore,
} from './pricing.mjs';
import { createPricingApi } from './pricing-api.mjs';

const clock = () => new Date('2026-10-07T12:00:00Z');
const setup = () => {
  const store = createPricingStore({ now: clock });
  return {
    store,
    admin: store.principal('admin'),
    lars: store.principal('lars'),
    kajsa: store.principal('kajsa'),
    anna: store.principal('anna'),
  };
};
const copper = (weight = 101, extra = {}) => ({
  customerId: 'customer-andersson',
  deliveredAt: '2026-10-07',
  rows: [{ articleId: 'copper-1', weight }],
  ...extra,
});
const fails = (action, status = 400) =>
  assert.throws(
    action,
    (error) => error instanceof PricingError && error.status === status,
  );

test('Cash USD/ton and FX calculate SEK/kg on the server without premature rounding', () => {
  const { store, lars } = setup();
  store.saveLme(
    {
      metal: 'copper',
      cashUsdPerTonne: 11000,
      usdSek: 10,
      effectiveFrom: '2026-10-07',
    },
    lars,
  );
  const result = store.quote(copper(), lars);
  assert.equal(result.rows[0].baseSekKg, 110);
  assert.equal(result.rows[0].price, 90.2);
  assert.equal(result.total, 9110.2);
  assert.deepEqual(result.rows[0].prices, { A: 90.2, B: 81.18, C: 72.16 });
  store.saveLme(
    {
      metal: 'copper',
      cashUsdPerTonne: 10000.123,
      usdSek: 10.12345,
      effectiveFrom: '2026-10-07',
    },
    lars,
  );
  assert.equal(
    store.quote(copper(), lars).rows[0].baseSekKg,
    (10000.123 * 10.12345) / 1000,
  );
});

test('current delivery participates in the per-article rolling thresholds, including split rows', () => {
  const { store, lars } = setup();
  assert.equal(store.quote(copper(49), lars).rows[0].tier, 'C');
  assert.equal(store.quote(copper(50), lars).rows[0].tier, 'B');
  assert.equal(store.quote(copper(100), lars).rows[0].tier, 'A');
  const result = store.quote(
    copper(0, {
      rows: [
        { articleId: 'copper-1', weight: 30 },
        { articleId: 'copper-1', weight: 71 },
        { articleId: 'iron', weight: 4 },
      ],
    }),
    lars,
  );
  assert.deepEqual(
    result.rows.map((row) => row.tier),
    ['A', 'A', 'C'],
  );
  assert.deepEqual(
    result.rows.map((row) => row.volumeWithDelivery),
    [101, 101, 4],
  );
  assert.equal(
    store.quote(
      {
        deliveredAt: '2026-10-07',
        rows: [{ articleId: 'copper-1', weight: 500 }],
      },
      lars,
    ).rows[0].tier,
    'C',
  );
});

test('rolling twelve months include the boundary, ignore expired volume and clamp leap day', () => {
  const { store, lars } = setup();
  store.snapshot(
    { ...copper(50, { deliveredAt: '2025-10-07' }), cardId: 'boundary' },
    lars,
  );
  store.snapshot(
    { ...copper(500, { deliveredAt: '2025-10-06' }), cardId: 'expired' },
    lars,
  );
  const row = store.quote(copper(1), lars).rows[0];
  assert.equal(row.volumeBefore, 50);
  assert.equal(row.tier, 'B');
  assert.equal(
    twelveMonthsBefore('2024-02-29T12:34:00Z').toISOString(),
    '2023-02-28T12:34:00.000Z',
  );
  assert.equal(
    twelveMonthsBefore('2026-10-07T08:41:00Z').toISOString(),
    '2025-10-07T08:41:00.000Z',
  );
});

test('article formulas and LME are selected by delivery date, future revisions do not change today', () => {
  const { store, lars } = setup();
  const original = store
    .read(lars)
    .articles.find((article) => article.id === 'copper-1');
  store.saveLme(
    {
      metal: 'copper',
      cashUsdPerTonne: 12000,
      usdSek: 10,
      effectiveFrom: '2026-10-08',
    },
    lars,
  );
  store.saveArticle(
    {
      ...original,
      tiers: { ...original.tiers, A: { discountPercent: 10, adjustmentKr: 2 } },
      effectiveFrom: '2026-10-08',
    },
    lars,
  );
  assert.equal(store.quote(copper(), lars).rows[0].price, 82);
  assert.equal(
    store.read(lars).articles.find((article) => article.id === 'copper-1')
      .prices.A,
    82,
  );
  assert.equal(
    store.quote(copper(101, { deliveredAt: '2026-10-08' }), lars).rows[0].price,
    110,
  );
});

test('Swedish delivery dates choose Cash/article revisions correctly around UTC midnight', () => {
  const { store, lars } = setup();
  store.saveLme(
    {
      metal: 'copper',
      cashUsdPerTonne: 10000,
      usdSek: 10,
      effectiveFrom: '2026-10-06',
    },
    lars,
  );
  store.saveLme(
    {
      metal: 'copper',
      cashUsdPerTonne: 11000,
      usdSek: 10,
      effectiveFrom: '2026-10-07',
    },
    lars,
  );
  assert.equal(
    store.quote(copper(101, { deliveredAt: '2026-10-06T21:30:00Z' }), lars)
      .rows[0].price,
    82,
  );
  assert.equal(
    store.quote(copper(101, { deliveredAt: '2026-10-06T22:30:00Z' }), lars)
      .rows[0].price,
    90.2,
  );
  assert.equal(
    store.quote(copper(101, { deliveredAt: '2026-10-07T00:30:00+02:00' }), lars)
      .rows[0].price,
    90.2,
  );
  const original = store
    .read(lars)
    .articles.find((article) => article.id === 'copper-1');
  store.saveArticle(
    {
      ...original,
      tiers: { ...original.tiers, A: { discountPercent: 10, adjustmentKr: 0 } },
      effectiveFrom: '2026-10-07',
    },
    lars,
  );
  assert.equal(
    store.quote(copper(101, { deliveredAt: '2026-10-06T22:30:00Z' }), lars)
      .rows[0].price,
    99,
  );
  assert.equal(
    store.quote(copper(101, { deliveredAt: '2026-10-06' }), lars).rows[0].price,
    82,
  );
  const nightStore = createPricingStore({
    now: () => new Date('2026-10-06T22:30:00Z'),
  });
  assert.equal(
    nightStore.read(nightStore.principal('lars')).asOfDate,
    '2026-10-07',
  );
});

test('date-only rolling volume includes the entire Swedish boundary day', () => {
  const { store, lars } = setup();
  store.snapshot(
    {
      ...copper(50, { deliveredAt: '2025-10-06T22:30:00Z' }),
      cardId: 'local-boundary',
    },
    lars,
  );
  store.snapshot(
    {
      ...copper(500, { deliveredAt: '2025-10-06T21:30:00Z' }),
      cardId: 'local-expired',
    },
    lars,
  );
  assert.equal(store.quote(copper(1), lars).rows[0].volumeBefore, 50);
});

test('fixed, ABC adjustment and LME discount customer agreements always outrank volume prices', () => {
  const { store, lars } = setup();
  assert.equal(
    store.quote(copper(1, { customerId: 'customer-build' }), lars).rows[0]
      .price,
    84,
  );
  const agreement = {
    customerId: 'customer-andersson',
    articleId: 'copper-1',
    effectiveFrom: '2026-10-07',
    active: true,
  };
  store.saveSpecial(
    { ...agreement, kind: 'tier-adjustment', tier: 'C', adjustmentKr: -2 },
    lars,
  );
  assert.equal(store.quote(copper(500), lars).rows[0].price, 63.6);
  store.saveSpecial(
    { ...agreement, kind: 'lme-discount', discountPercent: 5 },
    lars,
  );
  assert.equal(store.quote(copper(1), lars).rows[0].price, 95);
  store.saveSpecial(
    { ...agreement, kind: 'fixed', price: 33, active: false },
    lars,
  );
  assert.equal(store.quote(copper(101), lars).rows[0].price, 82);
});

test('historical snapshots are immutable and idempotent while exclusion prevents counting a card twice', () => {
  const { store, lars } = setup();
  const frozen = store.snapshot({ ...copper(), cardId: 5000 }, lars);
  assert.equal(frozen.total, 8282);
  store.saveLme(
    {
      metal: 'copper',
      cashUsdPerTonne: 12000,
      usdSek: 10,
      effectiveFrom: '2026-10-07',
    },
    lars,
  );
  const again = store.snapshot({ ...copper(2), cardId: 5000 }, lars);
  assert.deepEqual(again, frozen);
  assert.equal(
    store.quote(copper(1, { excludeCardId: 5000 }), lars).rows[0].volumeBefore,
    0,
  );
  assert.equal(store.quote(copper(1), lars).rows[0].volumeBefore, 101);
  frozen.rows[0].price = 0;
  assert.equal(store.snapshots(lars, 5000)[0].rows[0].price, 82);
});

test('signed correction cards preserve the source, reduce volume/statistics and also work upward', () => {
  const { store, lars } = setup();
  const source = store.snapshot({ ...copper(150), cardId: 5000 }, lars);
  const credit = store.correct(
    {
      sourceSnapshotId: source.id,
      cardId: 'R5000',
      rows: [{ articleId: 'copper-1', weightDelta: -100 }],
      reason: '100 kg registrerades på fel kund.',
      correctedAt: '2026-10-07T13:00:00Z',
    },
    lars,
  );
  assert.equal(credit.total, -8200);
  assert.equal(credit.sourceSnapshotId, source.id);
  assert.equal(store.quote(copper(1), lars).rows[0].volumeBefore, 50);
  assert.equal(store.quote(copper(1), lars).rows[0].tier, 'B');
  const plus = store.correct(
    {
      sourceSnapshotId: source.id,
      cardId: 'R5001',
      rows: [{ articleId: 'copper-1', weightDelta: 60 }],
      reason: 'Ytterligare 60 kg på samma inlämning.',
      correctedAt: '2026-10-07T14:00:00Z',
    },
    lars,
  );
  assert.equal(plus.total, 4920);
  assert.equal(store.quote(copper(1), lars).rows[0].volumeBefore, 110);
  assert.deepEqual(store.snapshots(lars, 5000)[0], source);
  const ledger = store
    .read(lars)
    .ledger.filter((entry) => entry.cardId === 'R5000');
  assert.equal(ledger[0].weightDelta, -100);
  assert.equal(ledger[0].amountDelta, -8200);
});

test('a returned draft gets a new immutable snapshot revision without double-counting volume', () => {
  const { store, lars } = setup();
  const first = store.snapshot({ ...copper(100), cardId: 5000 }, lars);
  const request = {
    ...copper(60),
    cardId: 5000,
    supersedesSnapshotId: first.id,
  };
  const second = store.snapshot(request, lars);
  assert.notEqual(second.id, first.id);
  assert.equal(second.supersedesSnapshotId, first.id);
  assert.equal(second.rows[0].tier, 'B');
  assert.equal(store.quote(copper(1), lars).rows[0].volumeBefore, 60);
  assert.deepEqual(store.snapshot(request, lars), second); // Retried submission is idempotent.
  assert.equal(
    store
      .read(lars)
      .ledger.filter((entry) => entry.cardId === '5000')
      .reduce((sum, entry) => sum + entry.weightDelta, 0),
    60,
  );
  assert.deepEqual(store.snapshots(lars, 5000)[0], first);
  fails(
    () =>
      store.snapshot(
        { ...copper(70), cardId: 5000, supersedesSnapshotId: first.id },
        lars,
      ),
    409,
  );
});

test('corrections reject superseded sources atomically and use only the current source quantity', () => {
  const { store, lars } = setup();
  const original = store.snapshot({ ...copper(100), cardId: 5000 }, lars);
  const current = store.snapshot(
    {
      ...copper(60, { customerId: 'customer-erik' }),
      cardId: 5000,
      supersedesSnapshotId: original.id,
    },
    lars,
  );
  const before = store.read(lars);
  fails(
    () =>
      store.correct(
        {
          sourceSnapshotId: original.id,
          cardId: 'Rold',
          rows: [{ articleId: 'copper-1', weightDelta: -10 }],
          reason: 'Får inte rätta en ersatt kundversion.',
          correctedAt: '2026-10-07',
        },
        lars,
      ),
    409,
  );
  assert.deepEqual(store.read(lars), before);
  assert.deepEqual(store.snapshots(lars, 5000).at(-1), current);
  const correction = store.correct(
    {
      sourceSnapshotId: current.id,
      cardId: 'Rcurrent',
      rows: [{ articleId: 'copper-1', weightDelta: -10 }],
      reason: 'Rättelse av den aktuella versionen.',
      correctedAt: '2026-10-07',
    },
    lars,
  );
  assert.equal(correction.customerId, 'customer-erik');
  assert.equal(
    store.quote(copper(1, { customerId: 'customer-erik' }), lars).rows[0]
      .volumeBefore,
    50,
  );
  assert.equal(store.quote(copper(1), lars).rows[0].volumeBefore, 0);
});

test('invalid corrections and invalid financial inputs are atomic and do not create history', () => {
  const { store, lars } = setup();
  const source = store.snapshot({ ...copper(100), cardId: 5000 }, lars);
  const before = store.read(lars);
  fails(
    () =>
      store.correct(
        {
          sourceSnapshotId: source.id,
          cardId: 'Rbad',
          rows: [{ articleId: 'copper-1', weightDelta: -150 }],
          reason: 'För stor rättelse',
          correctedAt: '2026-10-07',
        },
        lars,
      ),
    422,
  );
  fails(() => store.quote(copper(0), lars));
  fails(() =>
    store.saveLme(
      {
        metal: 'copper',
        cashUsdPerTonne: -1,
        usdSek: 10,
        effectiveFrom: '2026-10-07',
      },
      lars,
    ),
  );
  fails(() =>
    store.saveLme(
      {
        metal: 'copper',
        cashUsdPerTonne: 1,
        usdSek: 0,
        effectiveFrom: '2026-10-07',
      },
      lars,
    ),
  );
  fails(() =>
    store.saveLme(
      {
        metal: 'copper',
        cashUsdPerTonne: 1,
        usdSek: 10,
        effectiveFrom: '2026-02-30',
      },
      lars,
    ),
  );
  fails(
    () =>
      store.saveSpecial(
        {
          customerId: 'customer-build',
          articleId: 'iron',
          kind: 'lme-discount',
          discountPercent: 5,
          effectiveFrom: '2026-10-07',
        },
        lars,
      ),
    422,
  );
  assert.deepEqual(store.read(lars), before);
});

test('Jobba som applies the effective account rights and logs both people when an allowed write occurs', () => {
  const { store, admin, kajsa } = setup();
  const asKajsa = store.principal('admin', 'kajsa');
  fails(
    () =>
      store.saveLme(
        {
          metal: 'copper',
          cashUsdPerTonne: 11000,
          usdSek: 10,
          effectiveFrom: '2026-10-07',
        },
        asKajsa,
      ),
    403,
  );
  fails(() => store.principal('lars', 'kajsa'), 403);
  const users = store
    .read(admin)
    .users.map((user) =>
      user.id === 'kajsa'
        ? { ...user, permissions: [...user.permissions, 'lmeWrite'] }
        : user,
    );
  store.saveUsers({ users }, admin);
  store.saveLme(
    {
      metal: 'copper',
      cashUsdPerTonne: 11000,
      usdSek: 10,
      effectiveFrom: '2026-10-07',
    },
    store.principal('admin', 'kajsa'),
  );
  const change = store.read(store.principal('kajsa')).lme.at(-1);
  assert.equal(change.actor, 'admin');
  assert.equal(change.actingUser, 'kajsa');
  fails(
    () =>
      store.saveLme(
        {
          metal: 'copper',
          cashUsdPerTonne: 11000,
          usdSek: 10,
          effectiveFrom: '2026-10-07',
        },
        kajsa,
      ),
    403,
  ); // Old principal snapshots never gain rights.
});

test('prices, raw LME values and customer agreements are filtered on the server', () => {
  const { store, admin, anna } = setup();
  const annaState = store.read(anna);
  assert.deepEqual(annaState.lme, []);
  assert.ok(
    annaState.articles.every(
      (article) =>
        article.baseSekKg === null &&
        article.base == null &&
        article.tiers == null,
    ),
  );
  const users = store.read(admin).users;
  users.push({
    id: 'limited',
    name: 'Begränsad prisvisning',
    level: 'Medarbetare',
    permissions: ['prices', 'priceC'],
    maxAttest: 0,
    ownAttest: false,
  });
  store.saveUsers({ users }, admin);
  const principal = store.principal('limited');
  const state = store.read(principal);
  assert.equal(state.articles[0].prices.A, null);
  assert.equal(state.articles[0].prices.B, null);
  assert.equal(state.articles[0].prices.C, 65.6);
  assert.deepEqual(state.customerPrices, []);
  assert.equal(store.quote(copper(), principal).total, null);
  assert.equal(
    store.quote(copper(1, { customerId: 'customer-build' }), principal).rows[0]
      .price,
    null,
  );
});

test('VD cannot change Systemadmin and LME write permission requires LME read', () => {
  const { store, lars, admin } = setup();
  const users = store.read(lars).users;
  fails(
    () =>
      store.saveUsers(
        {
          users: users.map((user) =>
            user.id === 'admin' ? { ...user, name: 'Ändrad' } : user,
          ),
        },
        lars,
      ),
    403,
  );
  fails(
    () =>
      store.saveUsers(
        {
          users: users.map((user) =>
            user.id === 'kajsa' ? { ...user, level: 'Systemadmin' } : user,
          ),
        },
        lars,
      ),
    403,
  );
  fails(
    () =>
      store.saveUsers(
        {
          users: users.map((user) =>
            user.id === 'anna' ? { ...user, maxAttest: 100001 } : user,
          ),
        },
        lars,
      ),
    403,
  );
  fails(
    () =>
      store.saveUsers(
        {
          users: users.map((user) =>
            user.id === 'lars' ? { ...user, maxAttest: 100001 } : user,
          ),
        },
        lars,
      ),
    403,
  );
  fails(() =>
    store.saveUsers(
      {
        users: users.map((user) =>
          user.id === 'anna'
            ? { ...user, permissions: [...user.permissions, 'lmeWrite'] }
            : user,
        ),
      },
      admin,
    ),
  );
  const revised = users.map((user) =>
    user.id === 'anna' ? { ...user, maxAttest: 50000 } : user,
  );
  // Existing browser demos may retain an older permission catalogue/order on
  // administrator accounts. Their effective rights still include everything.
  revised.find((user) => user.id === 'admin').permissions = ['users', 'prices'];
  assert.equal(
    store
      .saveUsers({ users: revised }, lars)
      .users.find((user) => user.id === 'anna').maxAttest,
    50000,
  );
});

test('financial permissions expose authoritative totals while restricted row prices remain hidden', () => {
  const { store, admin, lars } = setup();
  const frozen = store.snapshot(
    { ...copper(101, { customerId: 'customer-build' }), cardId: 5000 },
    lars,
  );
  assert.equal(frozen.total, 8484);
  const users = store.read(admin).users;
  for (const right of ['reports', 'attest', 'pay'])
    users.push({
      id: `finance-${right}`,
      name: `Ekonomi ${right}`,
      level: 'Medarbetare',
      permissions: ['view', 'prices', right],
      maxAttest: 10000,
      ownAttest: false,
    });
  users.push({
    id: 'prepare-only',
    name: 'Förbered utan priser',
    level: 'Medarbetare',
    permissions: ['view', 'prepare'],
    maxAttest: 0,
    ownAttest: false,
  });
  store.saveUsers({ users }, admin);
  for (const right of ['reports', 'attest', 'pay']) {
    const principal = store.principal(`finance-${right}`);
    const archive = store.snapshots(principal, 5000)[0];
    assert.equal(archive.rows[0].price, null);
    assert.equal(archive.total, 8484);
    assert.equal(
      store.quote(copper(101, { customerId: 'customer-build' }), principal)
        .total,
      8484,
    );
  }
  const prepareOnly = store.principal('prepare-only');
  const hidden = store.snapshots(prepareOnly, 5000)[0];
  assert.equal(hidden.rows[0].price, null);
  assert.equal(hidden.total, null);
  const prepared = store.snapshot(
    { ...copper(101, { customerId: 'customer-build' }), cardId: 5001 },
    prepareOnly,
  );
  assert.equal(prepared.rows[0].price, null);
  assert.equal(prepared.total, null);
});

test('manual base articles and one-off prices use the same snapshot/audit boundary', () => {
  const { store, lars, anna } = setup();
  const base = store
    .read(lars)
    .articles.find((article) => article.id === 'iron');
  const created = store.saveArticle(
    {
      ...base,
      id: 'new-iron',
      name: 'Ny manuell artikel',
      base: { type: 'manual', price: 10 },
      tiers: {
        A: { discountPercent: 10, adjustmentKr: 1 },
        B: { discountPercent: 20, adjustmentKr: 0 },
        C: { discountPercent: 30, adjustmentKr: 0 },
      },
      effectiveFrom: '2026-10-07',
    },
    lars,
  );
  assert.equal(
    created.articles.find((article) => article.id === 'new-iron').prices.A,
    10,
  );
  const request = copper(10, {
    rows: [
      {
        articleId: 'new-iron',
        weight: 10,
        override: {
          price: 12,
          tier: 'Eget',
          reason: 'Engångsavtal vid denna leverans',
        },
      },
    ],
  });
  const frozen = store.snapshot({ ...request, cardId: 5000 }, lars);
  assert.equal(frozen.total, 120);
  assert.match(frozen.rows[0].source, /Engångsavtal/);
  assert.equal(store.snapshots(anna, 5000)[0].total, 120); // Read special price does not require write special price.
  fails(() => store.quote(request, anna), 403);
});

test('HTTP API validates identity, effective permissions, JSON, body size and same-origin writes', async (t) => {
  const store = createPricingStore({ now: clock });
  const handler = createPricingApi({ store });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res, new URL(req.url, 'http://localhost')))) {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/pricing`;
  const headers = {
    'X-Demo-Actor': 'admin',
    'X-Demo-User': 'admin',
    'Content-Type': 'application/json',
  };
  assert.equal((await fetch(`${base}/state`)).status, 401);
  const state = await fetch(`${base}/state`, { headers });
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('cache-control'), 'no-store');
  const head = await fetch(`${base}/state`, { method: 'HEAD', headers });
  assert.equal(await head.text(), '');
  const payload = JSON.stringify({
    metal: 'copper',
    cashUsdPerTonne: 11000,
    usdSek: 10,
    effectiveFrom: '2026-10-07',
  });
  assert.equal(
    (
      await fetch(`${base}/lme`, {
        method: 'POST',
        headers: { ...headers, 'X-Demo-User': 'anna' },
        body: payload,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/lme`, {
        method: 'POST',
        headers: { ...headers, Origin: 'https://unrelated.example' },
        body: payload,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/lme`, {
        method: 'POST',
        headers: { ...headers, Origin: base.replace('/api/pricing', '') },
        body: payload,
      })
    ).status,
    200,
  );
  assert.equal(
    (await fetch(`${base}/lme`, { method: 'POST', headers, body: '{broken' }))
      .status,
    400,
  );
  assert.equal(
    (
      await fetch(`${base}/lme`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ note: 'x'.repeat(140000) }),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await fetch(`${base}/lme`, {
        method: 'POST',
        headers: { 'X-Demo-Actor': 'admin' },
        body: payload,
      })
    ).status,
    415,
  );
  assert.equal(
    (await fetch(`${base}/quote`, { method: 'DELETE', headers })).status,
    405,
  );
  assert.equal(
    (await fetch(`${base}/unknown`, { method: 'POST', headers, body: '{}' }))
      .status,
    404,
  );
});
