import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

// This repository deliberately has no database yet. The store boundary below can
// be replaced with a repository without moving calculations into the clients.
export const metals = [
  { id: 'copper', name: 'Koppar' },
  { id: 'aluminium', name: 'Aluminium' },
  { id: 'lead', name: 'Bly' },
  { id: 'nickel', name: 'Nickel' },
  { id: 'zinc', name: 'Zink' },
  { id: 'tin', name: 'Tenn' },
];
export const permissions = [
  'view',
  'prepare',
  'weighingAddArticle',
  'customers',
  'prices',
  'priceA',
  'priceB',
  'priceC',
  'customerPrices',
  'changePrice',
  'paymentDetails',
  'verifyId',
  'attest',
  'pay',
  'corrections',
  'reports',
  'users',
  'lmeRead',
  'lmeWrite',
  'articlesEdit',
  'customerPriceEdit',
  'transportRead',
  'transportPlan',
  'workOrdersRead',
  'workOrdersWrite',
  'vesselsRead',
  'vesselsWrite',
  'warehouseRead',
  'warehouseWrite',
  'customerAccounts',
  'carrierAccounts',
  'customerApprovalRead',
  'environmentRead',
  'environmentWrite',
  'environmentClassify',
  'environmentStorage',
  'environmentReceiveException',
  'personnelRead',
  'personnelWrite',
  'employmentRead',
  'employmentWrite',
  'salaryRead',
  'salaryWrite',
  'absenceRead',
  'absenceWrite',
  'competenciesWrite',
  'staffingWrite',
  'externalAccounts',
];
const sensitivePersonnelPermissions = ['salaryRead', 'salaryWrite', 'absenceRead', 'absenceWrite'];
const finite = z.number().finite();
const nonnegative = finite.min(0).max(1e9);
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const text = z.string().trim().min(1).max(300);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
    'Ogiltigt datum',
  );
const deliveredAt = z.union([
  date,
  z
    .string()
    .max(40)
    .datetime({ offset: true })
    .refine(
      (value) => Number.isFinite(Date.parse(value)),
      'Ogiltigt inlämningsdatum',
    ),
]);
const tier = z.enum(['A', 'B', 'C']);
const tierRule = z.object({
  discountPercent: finite.min(0).max(100),
  adjustmentKr: finite.min(-1e6).max(1e6).default(0),
});
const articleSchema = z.object({
  id: id.optional(),
  category: id,
  name: text,
  description: z.string().trim().max(1000).default(''),
  includes: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  excludes: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  photos: z.array(z.number().int().min(0).max(39)).max(6).default([]),
  active: z.boolean().default(true),
  base: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('lme'),
      metal: z.enum(metals.map((metal) => metal.id)),
    }),
    z.object({ type: z.literal('manual'), price: nonnegative }),
  ]),
  tiers: z.object({ A: tierRule, B: tierRule, C: tierRule }),
  thresholds: z
    .object({ A: nonnegative, B: nonnegative })
    .refine(
      (value) => value.A >= value.B,
      'A-gränsen måste vara minst B-gränsen',
    ),
  effectiveFrom: date,
});
const lmeSchema = z.object({
  metal: z.enum(metals.map((metal) => metal.id)),
  cashUsdPerTonne: finite.positive().max(1e9),
  usdSek: finite.positive().max(1000),
  effectiveFrom: date,
  note: z.string().trim().max(1000).default(''),
});
const specialSchema = z
  .object({
    customerId: id,
    articleId: id,
    kind: z.enum(['fixed', 'tier-adjustment', 'lme-discount']),
    price: nonnegative.optional(),
    tier: tier.optional(),
    adjustmentKr: finite.min(-1e6).max(1e6).optional(),
    discountPercent: finite.min(0).max(100).optional(),
    active: z.boolean().default(true),
    effectiveFrom: date,
    note: z.string().trim().max(1000).default(''),
  })
  .superRefine((value, context) => {
    if (value.kind === 'fixed' && value.price == null)
      context.addIssue({
        code: 'custom',
        message: 'Ange fast pris',
        path: ['price'],
      });
    if (
      value.kind === 'tier-adjustment' &&
      (!value.tier || value.adjustmentKr == null)
    )
      context.addIssue({
        code: 'custom',
        message: 'Ange prislista och justering',
        path: ['tier'],
      });
    if (value.kind === 'lme-discount' && value.discountPercent == null)
      context.addIssue({
        code: 'custom',
        message: 'Ange avdrag från LME',
        path: ['discountPercent'],
      });
  });
const overrideSchema = z.object({
  price: nonnegative,
  tier: z.enum(['A', 'B', 'C', 'Eget']),
  reason: z.string().trim().min(1).max(1000),
});
const quoteSchema = z.object({
  customerId: id.optional(),
  deliveredAt,
  excludeCardId: z
    .union([z.string().min(1).max(100), z.number().int().nonnegative()])
    .optional(),
  rows: z
    .array(
      z.object({
        articleId: id,
        weight: finite.positive().max(1e9),
        override: overrideSchema.optional(),
      }),
    )
    .min(1)
    .max(100),
});
const snapshotSchema = quoteSchema.extend({
  cardId: z.union([z.string().min(1).max(100), z.number().int().nonnegative()]),
  supersedesSnapshotId: id.optional(),
});
const customerSchema = z.object({ id, name: text });
const legacySnapshotSchema = z.object({
  cardId: z.union([z.string().min(1).max(100), z.number().int().nonnegative()]),
  customerId: id,
  deliveredAt,
  preparedBy: id.optional(),
  rows: z
    .array(
      z.object({
        articleId: id,
        weight: finite.positive().max(1e9),
        price: nonnegative,
        tier: z.enum(['A', 'B', 'C', 'Special', 'Eget']),
      }),
    )
    .min(1)
    .max(100),
});
const correctionSchema = z.object({
  sourceSnapshotId: id,
  cardId: z.union([z.string().min(1).max(100), z.number().int().nonnegative()]),
  rows: z
    .array(
      z.object({
        articleId: id,
        weightDelta: finite
          .min(-1e9)
          .max(1e9)
          .refine((value) => value !== 0),
      }),
    )
    .min(1)
    .max(100),
  reason: z.string().trim().min(1).max(1000),
  correctedAt: deliveredAt,
  creatorId: id.optional(),
  submittedBy: id.optional(),
  document: z.string().trim().max(1000).default(''),
});
const userSchema = z.object({
  id,
  name: text,
  level: z.enum(['Medarbetare', 'VD', 'Systemadmin']),
  permissions: z.array(z.enum(permissions)).max(permissions.length),
  siteIds: z.array(id).max(100).optional(),
  maxAttest: nonnegative,
  ownAttest: z.boolean(),
  active: z.boolean().optional(),
});
export class PricingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const validate = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new PricingError(
      result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  return result.data;
};
export const money = (value) => {
  const rounded = Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100;
  return rounded ? Math.sign(value) * rounded : 0;
};
const copy = (value) => structuredClone(value);
const stockholmDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
// Effective dates are Swedish business dates, regardless of the server's UTC
// timezone. A date-only input is already a business date and needs no conversion.
const day = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : stockholmDate.format(new Date(value));
const latest = (rows, predicate, asOf) =>
  rows
    .filter((row) => predicate(row) && row.effectiveFrom <= asOf)
    .sort(
      (a, b) =>
        b.effectiveFrom.localeCompare(a.effectiveFrom) ||
        b.sequence - a.sequence,
    )[0];
export function twelveMonthsBefore(value) {
  const reference = new Date(value);
  const year = reference.getUTCFullYear() - 1;
  const month = reference.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(reference.getUTCDate(), lastDay),
      reference.getUTCHours(),
      reference.getUTCMinutes(),
      reference.getUTCSeconds(),
      reference.getUTCMilliseconds(),
    ),
  );
}
function seedUsers() {
  return [
    {
      id: 'kajsa',
      name: 'Kajsa Nilsson',
      level: 'Medarbetare',
      permissions: [
        'view',
        'prepare',
        'weighingAddArticle',
        'customers',
        'prices',
        'priceA',
        'priceB',
        'priceC',
        'customerPrices',
        'changePrice',
        'paymentDetails',
        'verifyId',
        'corrections',
        'lmeRead',
        'transportRead',
        'transportPlan',
        'customerApprovalRead',
        'environmentRead',
        'environmentWrite',
      ],
      maxAttest: 0,
      ownAttest: false,
    },
    {
      id: 'anna',
      name: 'Anna Nilsson',
      level: 'Medarbetare',
      permissions: [
        'view',
        'prices',
        'priceA',
        'priceB',
        'priceC',
        'customerPrices',
        'attest',
        'pay',
        'reports',
        'transportRead',
        'customerApprovalRead',
        'environmentRead',
      ],
      maxAttest: 25000,
      ownAttest: false,
    },
    {
      id: 'lars',
      name: 'Lars Andersson',
      level: 'VD',
      permissions: [...permissions],
      maxAttest: 100000,
      ownAttest: true,
    },
    {
      id: 'admin',
      name: 'Systemadmin',
      level: 'Systemadmin',
      permissions: [...permissions],
      maxAttest: 1000000,
      ownAttest: true,
    },
  ];
}
const customerSeed = [
  { id: 'customer-build', name: 'Bygg & Riv AB' },
  { id: 'customer-andersson', name: 'Anderssons Entreprenad' },
  { id: 'customer-brf', name: 'BRF Solbacken' },
  { id: 'customer-erik', name: 'Erik Johansson' },
];
const articleSeeds = [
  [
    'copper-1',
    'koppar',
    'Koppar klass 1',
    'Blank, ren, utan föroreningar',
    'Ren koppartråd, rena kopparrör och rena kopparskenor.',
    'Isolerad kabel, förtent koppar, järn och andra föroreningar.',
    [0, 1, 2, 3],
    'copper',
    100,
    [82, 73.8, 65.6],
  ],
  [
    'copper-2',
    'koppar',
    'Koppar klass 2',
    'Ren koppar med ytoxid',
    'Oisolerade kopparrör och koppartråd med mörkare yta.',
    'Isolerad kabel, järn och plast.',
    [28, 29, 30, 31],
    'copper',
    100,
    [77, 69.3, 61.6],
  ],
  [
    'copper-tin',
    'koppar',
    'Förtent koppar',
    'Koppar med förtenning',
    'Förtent koppartråd och kopparkomponenter.',
    'Isolerad kabel och blandat järnskrot.',
    [32, 33, 34, 35],
    'copper',
    100,
    [68, 61.2, 54.4],
  ],
  [
    'copper-mixed',
    'koppar',
    'Blandad koppar',
    'Blandade kopparformer',
    'Kopparrör, tråd och delar av koppar.',
    'Plast, isolerad kabel och järn.',
    [36, 37, 38, 39],
    'copper',
    100,
    [70, 63, 56],
  ],
  [
    'iron',
    'jarn',
    'Järnskrot',
    'Blandat järn och stål',
    'Järn, stål, balkar och rena metallkonstruktioner.',
    'Betong, sopor, slutna behållare och andra metaller.',
    [4, 5, 6, 7],
    null,
    3,
    [2.4, 2.16, 1.92],
  ],
  [
    'steel',
    'jarn',
    'Balk / stål',
    'Balkar och konstruktionsstål',
    'Stålbalkar och rena stålkonstruktioner.',
    'Betong, plast och andra metaller.',
    [6, 5, 4, 7],
    null,
    3.5,
    [2.8, 2.52, 2.24],
  ],
  [
    'aluminium',
    'aluminium',
    'Aluminium',
    'Rena profiler och plåt',
    'Rena aluminiumprofiler och aluminiumplåt.',
    'Järn, plast och blandade material.',
    [8, 9, 10, 11],
    'aluminium',
    20,
    [18, 16.2, 14.4],
  ],
  [
    'aluminium-cast',
    'aluminium',
    'Aluminium gjutgods',
    'Rena gjutna delar',
    'Rena gjutna aluminiumdelar.',
    'Fastmonterat järn, olja och plast.',
    [10, 8, 11, 9],
    'aluminium',
    20,
    [15, 13.5, 12],
  ],
  [
    'lead',
    'bly',
    'Bly',
    'Blyplåt, block och vikter',
    'Blyplåt, blyblock och blyvikter.',
    'Batterier och andra metaller.',
    [20, 21, 22, 23],
    'lead',
    15,
    [12, 10.8, 9.6],
  ],
  [
    'lead-battery',
    'bly',
    'Blybatterier',
    'Uttjänta blybatterier · demoartikel utan referensbilder',
    'Hela uttjänta blybatterier som hanteras på anvisad mottagningsplats.',
    'Litiumbatterier, lösa batterivätskor och blandat batteriavfall.',
    [],
    null,
    5.625,
    [4.5, 4.05, 3.6],
  ],
  [
    'cable',
    'kabel',
    'Blandkabel',
    'Isolerad kopparkabel',
    'Elektrisk kabel med kopparledare och isolering.',
    'Optisk fiber, slang och kabel med olja.',
    [24, 25, 26, 27],
    'copper',
    100,
    [23, 20.7, 18.4],
  ],
  [
    'cable-thick',
    'kabel',
    'Kraftkabel',
    'Grov isolerad kopparkabel',
    'Grov kraftkabel med kopparledare.',
    'Aluminiumkabel, fiber och oljekabel.',
    [25, 27, 26, 24],
    'copper',
    100,
    [32, 28.8, 25.6],
  ],
  [
    'brass',
    'massing',
    'Mässing',
    'Rördelar, ventiler och blandat',
    'Mässingskopplingar, ventiler och detaljer.',
    'Järn, plast och kompletta blandade armaturer.',
    [12, 13, 14, 15],
    null,
    52.5,
    [42, 37.8, 33.6],
  ],
  [
    'stainless',
    'rostfritt',
    'Rostfritt',
    'Rent, omagnetiskt rostfritt',
    'Rena rostfria rör, plåt och detaljer.',
    'Vanligt järn, plast och blandade material.',
    [16, 17, 18, 19],
    null,
    16.25,
    [13, 11.7, 10.4],
  ],
];

export function createPricingStore({ now = () => new Date(), initialState } = {}) {
  const state = {
    revision: 0,
    lme: [],
    articleHistory: [],
    customerPrices: [],
    users: seedUsers(),
    customers: copy(customerSeed),
    snapshots: [],
    ledger: [],
    audit: [],
  };
  const stamp = (principal, action) => ({
    sequence: ++state.revision,
    at: now().toISOString(),
    actor: principal.actor.id,
    actingUser: principal.user.id,
    action,
  });
  const seedPrincipal = { actor: { id: 'admin' }, user: { id: 'admin' } };
  function seedRate(metal, cashUsdPerTonne, usdSek, effectiveFrom) {
    state.lme.push({
      id: randomUUID(),
      metal,
      cashUsdPerTonne,
      usdSek,
      effectiveFrom,
      note: 'Manuellt exempelvärde · demo',
      ...stamp(seedPrincipal, 'Exempelpris'),
    });
  }
  for (const [metal, cash] of [
    ['copper', 10000],
    ['aluminium', 2000],
    ['lead', 1500],
    ['nickel', 18000],
    ['zinc', 2500],
    ['tin', 30000],
  ])
    seedRate(metal, cash, 10, '2025-01-01');
  for (const [effectiveFrom, cash, fx] of [
    ['2026-05-01', 9900, 10],
    ['2026-06-01', 10250, 9.9],
    ['2026-07-01', 10050, 10.1],
    ['2026-08-01', 9800, 10.2],
    ['2026-09-01', 10000, 10],
  ])
    seedRate('copper', cash, fx, effectiveFrom);
  for (const [
    articleId,
    category,
    name,
    description,
    includes,
    excludes,
    photos,
    metal,
    basePrice,
    prices,
  ] of articleSeeds) {
    state.articleHistory.push({
      id: articleId,
      category,
      name,
      description,
      includes: [includes],
      excludes: [excludes],
      photos,
      active: true,
      base: metal
        ? { type: 'lme', metal }
        : { type: 'manual', price: basePrice },
      tiers: Object.fromEntries(
        ['A', 'B', 'C'].map((letter, index) => [
          letter,
          {
            discountPercent: money((1 - prices[index] / basePrice) * 100),
            adjustmentKr: 0,
          },
        ]),
      ),
      thresholds: { A: 100, B: 50 },
      effectiveFrom: '2025-01-01',
      revisionId: randomUUID(),
      ...stamp(seedPrincipal, 'Exempelartikel'),
    });
  }
  state.customerPrices.push({
    id: randomUUID(),
    customerId: 'customer-build',
    articleId: 'copper-1',
    kind: 'fixed',
    price: 84,
    active: true,
    effectiveFrom: '2025-01-01',
    note: 'Kundens avtalade exempelpris',
    ...stamp(seedPrincipal, 'Exempelavtal'),
  });
  // Fresh demo cards have no approval or financial booking yet. Historical
  // volumes arise from real demo workflow actions, never invented attestations.
  if (initialState) Object.assign(state, copy(initialState));
  const can = (user, permission) =>
    sensitivePersonnelPermissions.includes(permission)
      ? user.level === 'Systemadmin' || user.permissions.includes(permission)
      : permission === 'users'
      ? user.level !== 'Medarbetare'
      : user.level !== 'Medarbetare' || user.permissions.includes(permission);
  const demand = (principal, permission) => {
    if (!can(principal.user, permission))
      throw new PricingError('Du saknar behörighet för detta moment.', 403);
  };
  function principal(actorId, userId = actorId) {
    const actor = state.users.find((user) => user.id === actorId);
    const user = state.users.find((user) => user.id === userId);
    if (!actor || !user || actor.active === false || user.active === false)
      throw new PricingError('Välj ett giltigt demokonto.', 401);
    if (actor.id !== user.id && actor.level !== 'Systemadmin')
      throw new PricingError('Endast Systemadmin får använda Jobba som.', 403);
    return { actor: copy(actor), user: copy(user) };
  }
  function articleAt(articleId, asOf) {
    const article = latest(
      state.articleHistory,
      (entry) => entry.id === articleId,
      asOf,
    );
    if (!article)
      throw new PricingError(
        `Artikeln ${articleId} saknar inställningar på inlämningsdagen.`,
        422,
      );
    return article;
  }
  function calculateArticle(article, asOf) {
    const reference =
      article.base.type === 'lme'
        ? latest(state.lme, (entry) => entry.metal === article.base.metal, asOf)
        : undefined;
    if (article.base.type === 'lme' && !reference)
      throw new PricingError(
        `LME-pris saknas för ${article.name} på inlämningsdagen.`,
        422,
      );
    // Keep full currency precision through the formula and round the payable kg
    // price once. Rounding the reference early changes payouts on large loads.
    const baseSekKg = reference
      ? (reference.cashUsdPerTonne * reference.usdSek) / 1000
      : article.base.price;
    const prices = Object.fromEntries(
      ['A', 'B', 'C'].map((letter) => [
        letter,
        money(
          Math.max(
            0,
            baseSekKg * (1 - article.tiers[letter].discountPercent / 100) +
              article.tiers[letter].adjustmentKr,
          ),
        ),
      ]),
    );
    return {
      ...copy(article),
      baseSekKg,
      prices,
      ...(reference ? { lmeRevisionId: reference.id } : {}),
    };
  }
  function volume(customerId, articleId, at, excludeCardId) {
    if (!customerId) return 0;
    if (at.length === 10) {
      const fromDate = day(
        twelveMonthsBefore(`${at}T12:00:00.000Z`).toISOString(),
      );
      return Math.max(
        0,
        state.ledger
          .filter(
            (entry) =>
              entry.customerId === customerId &&
              entry.articleId === articleId &&
              (excludeCardId == null ||
                String(entry.cardId) !== String(excludeCardId)) &&
              day(entry.deliveredAt) >= fromDate &&
              day(entry.deliveredAt) <= at,
          )
          .reduce((sum, entry) => sum + entry.weightDelta, 0),
      );
    }
    // Timestamp requests retain an exact instant and the existing UTC clock
    // boundary; date-only requests above use entire Swedish calendar days.
    const through = new Date(at).getTime();
    const from = twelveMonthsBefore(at).getTime();
    return Math.max(
      0,
      state.ledger
        .filter(
          (entry) =>
            entry.customerId === customerId &&
            entry.articleId === articleId &&
            (excludeCardId == null ||
              String(entry.cardId) !== String(excludeCardId)) &&
            new Date(entry.deliveredAt).getTime() >= from &&
            new Date(entry.deliveredAt).getTime() <= through,
        )
        .reduce((sum, entry) => sum + entry.weightDelta, 0),
    );
  }
  function fullQuote(input, principalValue, { includeDelivery = true } = {}) {
    const request = validate(quoteSchema, input);
    if (
      request.customerId &&
      !state.customers.some((customer) => customer.id === request.customerId)
    )
      throw new PricingError(
        'Kunden finns inte i prismotorns demoregister.',
        422,
      );
    const asOf = day(request.deliveredAt);
    const deliveryWeights = new Map();
    for (const row of request.rows)
      deliveryWeights.set(
        row.articleId,
        (deliveryWeights.get(row.articleId) ?? 0) + row.weight,
      );
    const rows = request.rows.map((row) => {
      const article = calculateArticle(articleAt(row.articleId, asOf), asOf);
      if (!article.active)
        throw new PricingError(
          `Artikeln ${article.name} är inaktiv på inlämningsdagen.`,
          422,
        );
      const volumeBefore = volume(
        request.customerId,
        row.articleId,
        request.deliveredAt,
        request.excludeCardId,
      );
      const volumeWithDelivery =
        volumeBefore +
        (includeDelivery ? deliveryWeights.get(row.articleId) : 0);
      const volumeTier = !request.customerId
        ? 'C'
        : volumeWithDelivery >= article.thresholds.A
          ? 'A'
          : volumeWithDelivery >= article.thresholds.B
            ? 'B'
            : 'C';
      const special = request.customerId
        ? latest(
            state.customerPrices,
            (entry) =>
              entry.customerId === request.customerId &&
              entry.articleId === row.articleId,
            asOf,
          )
        : undefined;
      let price = article.prices[volumeTier];
      let selectedTier = volumeTier;
      let source = `Volympris ${volumeTier}`;
      if (special?.active) {
        if (special.kind === 'fixed') price = money(special.price);
        else if (special.kind === 'tier-adjustment')
          price = money(
            Math.max(0, article.prices[special.tier] + special.adjustmentKr),
          );
        else {
          if (article.base.type !== 'lme')
            throw new PricingError(
              'Ett kundavtal med LME-avdrag kräver en LME-kopplad artikel.',
              422,
            );
          price = money(
            article.baseSekKg * (1 - special.discountPercent / 100),
          );
        }
        selectedTier = 'Special';
        source = 'Kundanpassat pris';
      }
      if (row.override) {
        demand(principalValue, 'changePrice');
        price = money(row.override.price);
        selectedTier = row.override.tier;
        source = `Engångspris: ${row.override.reason}`;
      }
      return {
        articleId: row.articleId,
        weight: row.weight,
        price,
        prices: copy(article.prices),
        tier: selectedTier,
        volumeTier,
        volumeBefore,
        volumeWithDelivery,
        source,
        baseSekKg: article.baseSekKg,
        articleRevisionId: article.revisionId,
        ...(article.lmeRevisionId
          ? { lmeRevisionId: article.lmeRevisionId }
          : {}),
        ...(special?.active ? { customerPriceRevisionId: special.id } : {}),
        ...(row.override ? { override: copy(row.override) } : {}),
      };
    });
    return {
      deliveredAt: request.deliveredAt,
      customerId: request.customerId,
      rows,
      total: money(
        rows.reduce((sum, row) => sum + money(row.price * row.weight), 0),
      ),
      weight: rows.reduce((sum, row) => sum + row.weight, 0),
      memoryOnly: true,
    };
  }
  function readableQuote(quote, principalValue) {
    const result = copy(quote);
    delete result.requestFingerprint;
    for (const row of result.rows) {
      const right =
        row.tier === 'Special' || row.tier === 'Eget'
          ? 'customerPrices'
          : `price${row.tier}`;
      if (!can(principalValue.user, right)) {
        row.price = null;
        delete row.override;
      }
      if (row.prices)
        for (const letter of ['A', 'B', 'C'])
          if (!can(principalValue.user, `price${letter}`))
            row.prices[letter] = null;
      if (!can(principalValue.user, 'customerPrices')) {
        delete row.customerPriceRevisionId;
        row.volumeBefore = null;
        row.volumeWithDelivery = null;
      }
      if (!can(principalValue.user, 'lmeRead')) {
        row.baseSekKg = null;
        delete row.lmeRevisionId;
      }
    }
    // Attest/payment limits are checked against the authoritative total even
    // when the account is not allowed to inspect individual price lists.
    if (
      result.rows.some((row) => row.price == null) &&
      !['reports', 'attest', 'pay'].some((right) =>
        can(principalValue.user, right),
      )
    )
      result.total = null;
    return result;
  }
  function read(principalValue, asOfDate = day(now().toISOString())) {
    validate(date, asOfDate);
    if (
      ![
        'view',
        'customers',
        'prices',
        'lmeRead',
        'articlesEdit',
        'environmentRead',
        'environmentClassify',
        'customerPriceEdit',
        'users',
      ].some((right) => can(principalValue.user, right))
    )
      throw new PricingError('Du saknar behörighet att öppna prismotorn.', 403);
    const editor = can(principalValue.user, 'articlesEdit');
    const articleIds = [
      ...new Set(state.articleHistory.map((article) => article.id)),
    ];
    const articles = articleIds
      .map((articleId) =>
        latest(
          state.articleHistory,
          (entry) => entry.id === articleId,
          asOfDate,
        ),
      )
      .filter(Boolean)
      .map((article) => {
        let current;
        try {
          current = calculateArticle(article, asOfDate);
        } catch (error) {
          if (!(error instanceof PricingError)) throw error;
          current = {
            ...copy(article),
            prices: { A: null, B: null, C: null },
            baseSekKg: null,
          };
        }
        for (const letter of ['A', 'B', 'C'])
          if (!can(principalValue.user, `price${letter}`))
            current.prices[letter] = null;
        if (!can(principalValue.user, 'lmeRead')) {
          current.baseSekKg = null;
          delete current.lmeRevisionId;
        }
        if (!editor) {
          if (!can(principalValue.user, 'lmeRead')) delete current.base;
          delete current.tiers;
        }
        return current;
      });
    return copy({
      version: '1',
      memoryOnly: true,
      revision: state.revision,
      asOfDate,
      metals,
      articles,
      articleHistory: editor ? state.articleHistory : [],
      lme: can(principalValue.user, 'lmeRead') ? state.lme : [],
      customerPrices:
        can(principalValue.user, 'customerPrices') ||
        can(principalValue.user, 'customerPriceEdit')
          ? state.customerPrices
          : [],
      customers:
        can(principalValue.user, 'customerPrices') ||
        can(principalValue.user, 'customerPriceEdit') ||
        can(principalValue.user, 'prepare') ||
        can(principalValue.user, 'view') ||
        can(principalValue.user, 'customers')
          ? state.customers
          : [],
      users: can(principalValue.user, 'users') ? state.users : [],
      audit: state.audit
        .filter((entry) =>
          entry.action.startsWith('LME')
            ? can(principalValue.user, 'lmeRead')
            : entry.action.startsWith('Artikel')
              ? editor
              : entry.action.startsWith('Kundanpassat')
                ? can(principalValue.user, 'customerPrices') ||
                  can(principalValue.user, 'customerPriceEdit')
                : can(principalValue.user, 'users'),
        )
        .map((entry) => ({
          sequence: entry.sequence,
          at: entry.at,
          actor: entry.actor,
          actingUser: entry.actingUser,
          action: entry.action,
          articleId: entry.articleId,
          customerId: entry.customerId,
          metal: entry.metal,
          cardId: entry.cardId,
        })),
      ...(can(principalValue.user, 'customerPrices')
        ? { ledger: state.ledger }
        : {}),
    });
  }
  function saveLme(input, principalValue) {
    demand(principalValue, 'lmeWrite');
    demand(principalValue, 'lmeRead');
    const row = {
      ...validate(lmeSchema, input),
      id: randomUUID(),
      ...stamp(principalValue, 'LME Cash ändrat'),
    };
    state.lme.push(row);
    state.audit.push(copy(row));
    return read(principalValue);
  }
  function saveCustomer(input, principalValue) {
    demand(principalValue, 'customers');
    const customer = validate(customerSchema, input);
    const index = state.customers.findIndex((item) => item.id === customer.id);
    if (index >= 0 && state.customers[index].name === customer.name)
      return { customer: copy(customer), memoryOnly: true };
    if (index >= 0) state.customers[index] = copy(customer);
    else state.customers.push(copy(customer));
    state.audit.push({
      customerId: customer.id,
      ...stamp(
        principalValue,
        index >= 0 ? 'Kundnamn ändrat' : 'Kund registrerad',
      ),
    });
    return { customer: copy(customer), memoryOnly: true };
  }
  function customerPreview(
    principalValue,
    customerId,
    at = day(now().toISOString()),
  ) {
    if (
      !can(principalValue.user, 'customerPrices') &&
      !can(principalValue.user, 'customerPriceEdit')
    )
      throw new PricingError('Du saknar behörighet att läsa kundpriser.', 403);
    validate(id, customerId);
    validate(date, at);
    if (!state.customers.some((customer) => customer.id === customerId))
      throw new PricingError(
        'Kunden finns inte i prismotorns demoregister.',
        422,
      );
    const articleIds = [
      ...new Set(state.articleHistory.map((article) => article.id)),
    ].filter((articleId) => {
      const article = latest(
        state.articleHistory,
        (item) => item.id === articleId,
        at,
      );
      return article?.active;
    });
    if (!articleIds.length)
      return { customerId, deliveredAt: at, rows: [], memoryOnly: true };
    const result = readableQuote(
      fullQuote(
        {
          customerId,
          deliveredAt: at,
          rows: articleIds.map((articleId) => ({ articleId, weight: 1 })),
        },
        principalValue,
        { includeDelivery: false },
      ),
      principalValue,
    );
    // This is a read-only current-price view, not a new delivery. The volume
    // tier uses only recorded deliveries and signed approved corrections.
    return {
      customerId,
      deliveredAt: at,
      rows: result.rows.map((row) => ({ ...row, weight: 0 })),
      memoryOnly: true,
    };
  }
  function saveArticle(input, principalValue) {
    demand(principalValue, 'articlesEdit');
    const parsed = validate(articleSchema, input);
    const articleId = parsed.id ?? `article-${randomUUID()}`;
    const row = {
      ...parsed,
      id: articleId,
      revisionId: randomUUID(),
      ...stamp(principalValue, 'Artikelinställningar ändrade'),
    };
    state.articleHistory.push(row);
    state.audit.push({ ...copy(row), articleId });
    return read(principalValue);
  }
  function saveSpecial(input, principalValue) {
    demand(principalValue, 'customerPriceEdit');
    const parsed = validate(specialSchema, input);
    if (!state.customers.some((customer) => customer.id === parsed.customerId))
      throw new PricingError('Kunden finns inte.', 422);
    const article = articleAt(parsed.articleId, parsed.effectiveFrom);
    if (parsed.kind === 'lme-discount' && article.base.type !== 'lme')
      throw new PricingError(
        'Kundens LME-avdrag kräver en LME-kopplad artikel.',
        422,
      );
    const row = {
      ...parsed,
      id: randomUUID(),
      ...stamp(principalValue, 'Kundanpassat pris ändrat'),
    };
    state.customerPrices.push(row);
    state.audit.push(copy(row));
    return read(principalValue);
  }
  function quote(input, principalValue) {
    if (
      !can(principalValue.user, 'prices') &&
      !can(principalValue.user, 'prepare')
    )
      throw new PricingError('Du saknar behörighet att beräkna priser.', 403);
    return readableQuote(fullQuote(input, principalValue), principalValue);
  }
  function snapshot(input, principalValue) {
    demand(principalValue, 'prepare');
    const request = validate(snapshotSchema, input);
    const requestFingerprint = JSON.stringify({
      customerId: request.customerId,
      deliveredAt: request.deliveredAt,
      rows: request.rows,
    });
    const existing = state.snapshots
      .filter((entry) => entry.cardId === String(request.cardId))
      .at(-1);
    if (existing?.requestFingerprint === requestFingerprint)
      return readableQuote(existing, principalValue);
    if (existing && !request.supersedesSnapshotId)
      return readableQuote(existing, principalValue);
    if (
      request.supersedesSnapshotId &&
      existing?.id !== request.supersedesSnapshotId
    )
      throw new PricingError(
        'Prisunderlaget har redan ersatts. Läs in kortet igen.',
        409,
      );
    if (
      existing &&
      state.ledger.some(
        (entry) =>
          entry.sourceSnapshotId === existing.id && entry.kind === 'correction',
      )
    )
      throw new PricingError(
        'Ett kort med rättelser får inte ersättas. Skapa ytterligare ett rättelsekort.',
        409,
      );
    if (!request.customerId)
      throw new PricingError('Välj kund innan priset låses.', 422);
    const calculated = fullQuote(
      { ...request, excludeCardId: request.cardId },
      principalValue,
    );
    const row = {
      ...calculated,
      id: randomUUID(),
      cardId: String(request.cardId),
      requestFingerprint,
      preparedBy: principalValue.user.id,
      ...(existing ? { supersedesSnapshotId: existing.id } : {}),
      ...stamp(
        principalValue,
        existing
          ? 'Nytt prisunderlag ersätter tidigare version'
          : 'Priser låsta på viktkort',
      ),
    };
    state.snapshots.push(copy(row));
    if (existing) {
      // Preserve the old snapshot and its rows. Reverse its contribution with
      // signed ledger entries before adding the revised draft's contribution.
      for (const entry of state.ledger.filter(
        (item) => item.snapshotId === existing.id && item.kind === 'delivery',
      ))
        state.ledger.push({
          ...copy(entry),
          id: randomUUID(),
          snapshotId: row.id,
          sourceSnapshotId: existing.id,
          weightDelta: -entry.weightDelta,
          amountDelta: -entry.amountDelta,
          recordedAt: row.at,
          kind: 'supersession',
          reason: 'Nytt prisunderlag på ett återlämnat kort',
        });
    }
    for (const item of row.rows)
      state.ledger.push({
        id: randomUUID(),
        snapshotId: row.id,
        cardId: row.cardId,
        customerId: row.customerId,
        articleId: item.articleId,
        weightDelta: item.weight,
        amountDelta: money(item.price * item.weight),
        deliveredAt: row.deliveredAt,
        recordedAt: row.at,
        kind: 'delivery',
      });
    state.audit.push({
      id: row.id,
      cardId: row.cardId,
      ...stamp(principalValue, 'Prisunderlag och volym sparade'),
    });
    return readableQuote(row, principalValue);
  }
  function snapshots(principalValue, cardId) {
    demand(principalValue, 'view');
    return state.snapshots
      .filter((entry) => cardId == null || entry.cardId === String(cardId))
      .map((entry) => readableQuote(entry, principalValue));
  }
  function restoreLegacySnapshot(input, principalValue) {
    demand(principalValue, 'attest');
    const request = validate(legacySnapshotSchema, input);
    if (!state.customers.some((item) => item.id === request.customerId))
      throw new PricingError(
        'Kunden finns inte i prismotorns demoregister.',
        422,
      );
    if (
      request.preparedBy &&
      !state.users.some((item) => item.id === request.preparedBy)
    )
      throw new PricingError('Kortets registrerade kontorist saknas.', 422);
    for (const item of request.rows)
      articleAt(item.articleId, day(request.deliveredAt));
    const existing = state.snapshots
      .filter((entry) => entry.cardId === String(request.cardId))
      .at(-1);
    const fingerprint = (entry) =>
      JSON.stringify({
        customerId: entry.customerId,
        deliveredAt: entry.deliveredAt,
        rows: entry.rows.map(({ articleId, weight, price, tier }) => ({
          articleId,
          weight,
          price,
          // Office cards use Eget for the server's Special tier. Treat only
          // those equivalent labels alike; the frozen financial tuple stays strict.
          tier: tier === 'Special' ? 'Eget' : tier,
        })),
      });
    if (existing) {
      if (fingerprint(existing) !== fingerprint(request))
        throw new PricingError(
          'Kortets frysta original skiljer sig från det sparade prisunderlaget.',
          409,
        );
      return readableQuote(existing, principalValue);
    }
    // Demo migration only: recover an already locked local original after an
    // in-memory server restart. Never quote today's rules to rewrite its price.
    const row = {
      ...copy(request),
      cardId: String(request.cardId),
      id: randomUUID(),
      total: money(
        request.rows.reduce(
          (sum, item) => sum + money(item.weight * item.price),
          0,
        ),
      ),
      weight: request.rows.reduce((sum, item) => sum + item.weight, 0),
      memoryOnly: true,
      ...stamp(principalValue, 'Fryst demounderlag återställt'),
    };
    state.snapshots.push(copy(row));
    for (const item of row.rows)
      state.ledger.push({
        id: randomUUID(),
        snapshotId: row.id,
        cardId: row.cardId,
        customerId: row.customerId,
        articleId: item.articleId,
        weightDelta: item.weight,
        amountDelta: money(item.weight * item.price),
        deliveredAt: row.deliveredAt,
        recordedAt: row.at,
        kind: 'delivery',
      });
    state.audit.push(copy(row));
    return readableQuote(row, principalValue);
  }
  function correct(input, principalValue, approvalOnly = false) {
    if (!approvalOnly) demand(principalValue, 'corrections');
    demand(principalValue, 'attest');
    const request = validate(correctionSchema, input);
    const source = state.snapshots.find(
      (entry) => entry.id === request.sourceSnapshotId,
    );
    if (!source)
      throw new PricingError('Ursprungligt prisunderlag saknas.', 422);
    if (source.sourceSnapshotId)
      throw new PricingError(
        'Rättelsen måste hänvisa till originalkortet, inte ett annat rättelsekort.',
        422,
      );
    const currentSource = state.snapshots
      .filter((entry) => entry.cardId === source.cardId)
      .at(-1);
    if (currentSource?.id !== source.id)
      throw new PricingError(
        'Prisunderlaget har ersatts. Rättelsen måste avse kortets senaste version.',
        409,
      );
    const existing = state.snapshots.find(
      (entry) => entry.cardId === String(request.cardId),
    );
    const requestFingerprint = JSON.stringify(request);
    if (existing) {
      if (existing.requestFingerprint === requestFingerprint)
        return readableQuote(existing, principalValue);
      throw new PricingError(
        'Rättelsekortets nummer används av ett annat underlag.',
        409,
      );
    }
    if (
      request.creatorId &&
      !state.users.some((item) => item.id === request.creatorId)
    )
      throw new PricingError(
        'Rättelsekortets registrerade skapare saknas.',
        422,
      );
    if (
      request.submittedBy &&
      !state.users.some((item) => item.id === request.submittedBy)
    )
      throw new PricingError(
        'Rättelsekortets registrerade inlämnare saknas.',
        422,
      );
    const preparedBy = request.creatorId ?? source.preparedBy;
    if (
      !principalValue.user.ownAttest &&
      (preparedBy === principalValue.user.id ||
        request.submittedBy === principalValue.user.id)
    )
      throw new PricingError(
        'Du får inte attestera dina egna rättelsekort.',
        403,
      );
    // Validate all rows before changing any state, including repeated article rows.
    const deltas = new Map();
    for (const item of request.rows)
      deltas.set(
        item.articleId,
        (deltas.get(item.articleId) ?? 0) + item.weightDelta,
      );
    for (const [articleId, delta] of deltas) {
      const original = source.rows.filter(
        (item) => item.articleId === articleId,
      );
      if (!original.length)
        throw new PricingError(
          'Rättelsen måste avse en artikel på ursprungskortet.',
          422,
        );
      const current = state.ledger
        .filter(
          (entry) =>
            ((entry.snapshotId === source.id && entry.kind === 'delivery') ||
              (entry.sourceSnapshotId === source.id &&
                entry.kind === 'correction')) &&
            entry.articleId === articleId,
        )
        .reduce((sum, entry) => sum + entry.weightDelta, 0);
      if (current + delta < -0.000001)
        throw new PricingError(
          'Rättelsen kan inte ta bort mer material än kortets återstående mängd.',
          422,
        );
      if (new Set(original.map((item) => item.price)).size !== 1)
        throw new PricingError(
          'Artikeln har flera ursprungspriser. Dela rättelsen per ursprungsrad.',
          422,
        );
    }
    const rows = request.rows.map((item) => {
      const original = source.rows.find(
        (row) => row.articleId === item.articleId,
      );
      return {
        articleId: item.articleId,
        weight: item.weightDelta,
        price: original.price,
        tier: original.tier,
        source: `Rättelse av viktkort ${source.cardId}`,
        sourceSnapshotId: source.id,
      };
    });
    const total = money(
      rows.reduce((sum, item) => sum + money(item.weight * item.price), 0),
    );
    if (Math.abs(total) > principalValue.user.maxAttest)
      throw new PricingError(
        'Rättelsens belopp överstiger din attestgräns.',
        403,
      );
    const row = {
      id: randomUUID(),
      cardId: String(request.cardId),
      customerId: source.customerId,
      deliveredAt: source.deliveredAt,
      correctedAt: request.correctedAt,
      sourceSnapshotId: source.id,
      reason: request.reason,
      document: request.document,
      preparedBy,
      submittedBy: request.submittedBy,
      approvedBy: principalValue.user.id,
      requestFingerprint,
      rows,
      total,
      weight: rows.reduce((sum, item) => sum + item.weight, 0),
      memoryOnly: true,
      ...stamp(principalValue, 'Rättelsekort attesterat'),
    };
    state.snapshots.push(copy(row));
    for (const item of rows)
      state.ledger.push({
        id: randomUUID(),
        snapshotId: row.id,
        sourceSnapshotId: source.id,
        cardId: row.cardId,
        customerId: row.customerId,
        articleId: item.articleId,
        weightDelta: item.weight,
        amountDelta: money(item.weight * item.price),
        deliveredAt: source.deliveredAt,
        recordedAt: row.at,
        correctedAt: request.correctedAt,
        kind: 'correction',
        reason: request.reason,
      });
    state.audit.push(copy(row));
    return readableQuote(row, principalValue);
  }
  function saveUsers(input, principalValue) {
    demand(principalValue, 'users');
    const users = validate(
      z.object({ users: z.array(userSchema).min(1).max(100) }),
      input,
    ).users.map((user) => ({
      ...user,
      // Older callers must not accidentally re-enable a blocked account.
      active: user.active ?? state.users.find((entry) => entry.id === user.id)?.active ?? true,
      // Older clients omitted this optional field. Preserve an existing site
      // restriction rather than silently widening it to every demo site.
      ...(user.siteIds !== undefined
        ? { siteIds: [...new Set(user.siteIds)] }
        : state.users.find((entry) => entry.id === user.id)?.siteIds !== undefined
          ? { siteIds: copy(state.users.find((entry) => entry.id === user.id).siteIds) }
          : {}),
      permissions:
        user.level === 'Medarbetare'
          ? [...new Set(user.permissions)]
          : user.level === 'Systemadmin'
            ? [...permissions]
            : permissions.filter(permission => !sensitivePersonnelPermissions.includes(permission) || user.permissions.includes(permission)),
    }));
    if (new Set(users.map((user) => user.id)).size !== users.length)
      throw new PricingError('Användar-id måste vara unika.');
    if (!users.some((user) => user.level === 'Systemadmin' && user.active !== false))
      throw new PricingError('Minst en Systemadmin måste finnas kvar.');
    if (!users.some((user) => user.id === principalValue.actor.id))
      throw new PricingError('Ditt eget konto måste finnas kvar.');
    if (users.find((user) => user.id === principalValue.actor.id).active === false)
      throw new PricingError('Spärra inte ditt eget konto. Använd ett annat administratörskonto.');
    if (
      users.find((user) => user.id === principalValue.actor.id).level !==
      principalValue.actor.level
    )
      throw new PricingError(
        'Ändra inte ditt eget kontos nivå. Använd ett annat administratörskonto.',
      );
    for (const user of users)
      if (
        user.permissions.includes('lmeWrite') &&
        !user.permissions.includes('lmeRead') &&
        user.level === 'Medarbetare'
      )
        throw new PricingError('Ändra LME kräver även Läs LME.');
    for (const user of users)
      if (user.level === 'Medarbetare' &&
        user.permissions.includes('transportPlan') &&
        !user.permissions.includes('transportRead'))
        throw new PricingError('Planera transporter kräver även Läs transportplanering.');
    for (const user of users)
      if (user.level === 'Medarbetare' && user.permissions.includes('environmentStorage') && !user.permissions.includes('environmentRead'))
        throw new PricingError('Hantera anläggningar och lagringsgränser kräver även Läs miljörapportering.');
    // Validate explicit HR grants without adding sensitive rights implicitly.
    // In particular VD may have ordinary access while salary/absence rights
    // remain deliberately selected; a Write grant requires its matching Read.
    const personnelPrerequisites = {
      personnelWrite: ['personnelRead'],
      employmentRead: ['personnelRead'],
      employmentWrite: ['personnelRead', 'employmentRead'],
      salaryRead: ['personnelRead'],
      salaryWrite: ['personnelRead', 'salaryRead'],
      absenceRead: ['personnelRead'],
      absenceWrite: ['personnelRead', 'absenceRead'],
      competenciesWrite: ['personnelRead'],
      staffingWrite: ['personnelRead', 'transportRead', 'transportPlan'],
      externalAccounts: ['personnelRead'],
      workOrdersWrite: ['workOrdersRead'],
      vesselsWrite: ['vesselsRead'],
      warehouseWrite: ['warehouseRead'],
      customerAccounts: ['vesselsRead'],
      carrierAccounts: ['workOrdersRead'],
    };
    for (const user of users) if (user.level !== 'Systemadmin')
      for (const [right, required] of Object.entries(personnelPrerequisites))
        if (user.permissions.includes(right) && required.some(permission => !user.permissions.includes(permission)))
          throw new PricingError(`Personalbehörigheten ${right} kräver även ${required.join(', ')}.`);
    if (principalValue.user.level !== 'Systemadmin') {
      const oldAdmins = state.users.filter(
        (user) => user.level === 'Systemadmin',
      ).map(user => ({...user, active: user.active ?? true}));
      const newAdmins = users.filter((user) => user.level === 'Systemadmin');
      // PostgreSQL JSONB may reorder object keys; compare semantic records.
      if (!isDeepStrictEqual(
        oldAdmins.toSorted((a, b) => a.id.localeCompare(b.id)),
        newAdmins.toSorted((a, b) => a.id.localeCompare(b.id)),
      ))
        throw new PricingError('VD får inte ändra Systemadmin-konton.', 403);
      for (const user of users) {
        const previous = state.users.find((entry) => entry.id === user.id);
        // Missing scope means all current and future registered facilities.
        // Keep that distinct from an explicit list when enforcing VD grants.
        const actorSites = principalValue.user.siteIds;
        const previousSites = previous?.siteIds;
        const requestedSites = user.siteIds;
        const sitesChanged = !previous ||
          JSON.stringify(previousSites?.toSorted()) !== JSON.stringify(requestedSites?.toSorted());
        if (sitesChanged && actorSites && (!requestedSites || requestedSites.some((siteId) => !actorSites.includes(siteId))))
          throw new PricingError('VD får inte ge åtkomst till en anläggning utanför sin egen behörighet.', 403);
        if (
          user.level !== 'Systemadmin' &&
          user.maxAttest > principalValue.user.maxAttest &&
          (!previous || previous.maxAttest !== user.maxAttest)
        )
          throw new PricingError(
            'VD får inte ge en högre attestgräns än sin egen.',
            403,
          );
      }
    }
    state.users = copy(users);
    state.audit.push(stamp(principalValue, 'Användarbehörigheter ändrade'));
    return read(principal(principalValue.actor.id, principalValue.user.id));
  }
  function validateMigration(input, principalValue) {
    if (principalValue.user.level !== 'Systemadmin') throw new PricingError('Endast Systemadmin kan importera prisregistret.', 403);
    const fields = ['lme', 'articleHistory', 'customerPrices', 'users', 'customers', 'snapshots', 'ledger', 'audit'];
    if (!Number.isInteger(input?.revision) || input.revision < 0 || fields.some(key => !Array.isArray(input[key]) || input[key].length > 100000)) throw new PricingError('Ogiltigt prisregister för import.');
    for (const row of input.lme) validate(lmeSchema, row);
    for (const row of input.articleHistory) validate(articleSchema, row);
    for (const row of input.customerPrices) validate(specialSchema, row);
    for (const row of input.users) validate(userSchema, row);
    for (const row of input.customers) validate(customerSchema, row);
    const ids = new Set(input.snapshots.map(row => row.id));
    if (ids.size !== input.snapshots.length || input.snapshots.some(row => typeof row.id !== 'string' || !Array.isArray(row.rows) || !Number.isFinite(row.total)) || input.ledger.some(row => !ids.has(row.snapshotId))) throw new PricingError('Prisunderlaget eller volymjournalen är ofullständig.');
    const checker = createPricingStore({ initialState: input });
    checker.saveUsers({users: input.users}, checker.principal(principalValue.actor.id));
    return copy(input);
  }
  return {
    validateMigration,
    exportState: () => copy(state),
    principal,
    can,
    read,
    saveLme,
    saveCustomer,
    customerPreview,
    saveArticle,
    saveSpecial,
    quote,
    snapshot,
    snapshots,
    // Internal server-only lookup for a validated customer review. Never exposed
    // by the pricing API or used to grant the caller additional permissions.
    getSnapshotForApproval: (snapshotId) => copy(state.snapshots.find((entry) => entry.id === snapshotId) ?? null),
    // Server-only metadata for environmental validation; no price privilege or
    // pricing output is needed to record an article's physical receipt.
    getArticleForEnvironment: (articleId) => {
      const article = latest(state.articleHistory, (entry) => entry.id === articleId, day(now().toISOString()));
      return article ? { id: article.id, name: article.name, active: article.active } : null;
    },
    restoreLegacySnapshot,
    correct,
    approveCorrection: (input, principalValue) =>
      correct(input, principalValue, true),
    saveUsers,
    volume,
  };
}
