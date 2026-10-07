import { z } from 'zod';
export const OFFICE_VERSION = '0.2.0';
export const officeKey = 'jeroc.office.demo.v1';
export const permissionNames = {
  view: 'Se vägningar och kunder',
  prepare: 'Granska och komplettera',
  customers: 'Ändra kunduppgifter',
  prices: 'Öppna prisöversikt',
  priceA: 'Se A-priser',
  priceB: 'Se B-priser',
  priceC: 'Se C-priser',
  customerPrices: 'Se kundpriser',
  changePrice: 'Ändra pris på vägning',
  lmeRead: 'Läsa LME Cash-priser',
  lmeWrite: 'Ändra LME Cash-priser',
  articlesEdit: 'Skapa och ändra artiklar',
  customerPriceEdit: 'Hantera kundanpassade skrotpriser',
  paymentDetails: 'Hantera betalningsuppgifter',
  verifyId: 'Verifiera ID',
  attest: 'Attestera',
  pay: 'Registrera demoutbetalning',
  corrections: 'Skapa rättelseutkast',
  reports: 'Se ekonomisk översikt',
  users: 'Hantera användare',
} as const;
export type Permission = keyof typeof permissionNames;
const permission = z.enum(
  Object.keys(permissionNames) as [Permission, ...Permission[]],
);
const userSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  level: z.enum(['Medarbetare', 'VD', 'Systemadmin']),
  permissions: z.array(permission),
  maxAttest: z.number().nonnegative(),
  ownAttest: z.boolean(),
});
export type OfficeUser = z.infer<typeof userSchema>;
const rowSchema = z.object({
  articleId: z.string(),
  weight: z.number().positive(),
  tier: z.enum(['A', 'B', 'C', 'Eget']),
  price: z.number().nonnegative(),
  volumeBefore: z.number().nonnegative().optional(),
  volumeWithDelivery: z.number().nonnegative().optional(),
  source: z.string().optional(),
  manualOverride: z.boolean().optional(),
  pricePending: z.boolean().optional(),
});
const auditSchema = z.object({
  at: z.string(),
  actor: z.string(),
  text: z.string(),
  actualUserId: z.string().optional(),
  effectiveUserId: z.string().optional(),
});
const cardSchema = z.object({
  id: z.number(),
  customerId: z.string().optional(),
  status: z.enum(['new', 'complement', 'attest', 'ready', 'paid']),
  yard: z.string(),
  weigher: z.string(),
  date: z.string(),
  reference: z.string(),
  origin: z.string(),
  registration: z.string().optional(),
  gross: z.number().optional(),
  tare: z.number().optional(),
  deduction: z.number().optional(),
  rows: z.array(rowSchema),
  payment: z.string(),
  idVerified: z.boolean(),
  preparedBy: z.string().optional(),
  approvedBy: z.string().optional(),
  pricingSnapshotId: z.string().optional(),
  pricedAt: z.string().optional(),
  pricingTotal: z.number().nonnegative().optional(),
  financialPending: z.boolean().optional(),
  pricingRowsPending: z.boolean().optional(),
  audit: z.array(auditSchema),
});
export type OfficeCard = z.infer<typeof cardSchema>;
export const officeSchema = z.object({
  users: z.array(userSchema),
  cards: z.array(cardSchema),
  corrections: z.array(
    z.object({
      id: z.number(),
      cardId: z.number(),
      customerId: z.string(),
      articleId: z.string(),
      weightDelta: z.number(),
      reason: z.string(),
      actor: z.string(),
      at: z.string(),
    }),
  ),
});
export type OfficeData = z.infer<typeof officeSchema>;
export const statusNames = {
  new: 'Ny från gården',
  complement: 'Behöver kompletteras',
  attest: 'Väntar på attest',
  ready: 'Klar för utbetalning',
  paid: 'Demoutbetald',
};
export const can = (user: OfficeUser, right: Permission) =>
  right === 'users'
    ? user.level !== 'Medarbetare'
    : user.level !== 'Medarbetare' || user.permissions.includes(right);
export const amount = (card: OfficeCard) =>
  card.pricingTotal ??
  Math.round(
    card.rows.reduce(
      (sum, r) => sum + Math.round(r.weight * r.price * 100) / 100,
      0,
    ) * 100,
  ) / 100;
export const weight = (card: OfficeCard) =>
  card.rows.reduce((sum, r) => sum + r.weight, 0);
export function seedOffice(): OfficeData {
  const all = Object.keys(permissionNames) as Permission[];
  const users: OfficeUser[] = [
    {
      id: 'kajsa',
      name: 'Kajsa Nilsson',
      level: 'Medarbetare',
      permissions: [
        'view',
        'prepare',
        'customers',
        'prices',
        'priceA',
        'priceB',
        'priceC',
        'customerPrices',
        'changePrice',
        'lmeRead',
        'paymentDetails',
        'verifyId',
        'corrections',
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
      ],
      maxAttest: 25000,
      ownAttest: false,
    },
    {
      id: 'lars',
      name: 'Lars Andersson',
      level: 'VD',
      permissions: all,
      maxAttest: 100000,
      ownAttest: true,
    },
    {
      id: 'admin',
      name: 'Systemadmin',
      level: 'Systemadmin',
      permissions: all,
      maxAttest: 1000000,
      ownAttest: true,
    },
  ];
  const base = {
    yard: 'Norrtälje',
    weigher: 'Niklas',
    date: '2026-10-07T08:41:00Z',
    reference: '',
    origin: '',
    payment: 'Bankkonto · demo 8327 / ****7890',
    idVerified: true,
    audit: [
      {
        at: '2026-10-07T08:41:00Z',
        actor: 'Niklas · Gårdsplan',
        text: 'Viktkort registrerat i kontorsdemon.',
      },
    ],
  };
  return {
    users,
    corrections: [],
    cards: [
      {
        ...base,
        id: 1412,
        status: 'complement',
        idVerified: false,
        payment: '',
        rows: [
          { articleId: 'copper-1', weight: 125, tier: 'A', price: 82 },
          { articleId: 'copper-mixed', weight: 230, tier: 'C', price: 56 },
          { articleId: 'stainless', weight: 130, tier: 'C', price: 14.4 },
        ],
      },
      {
        ...base,
        id: 1416,
        status: 'new',
        customerId: 'customer-build',
        registration: 'ABC123',
        gross: 12450,
        tare: 11600,
        deduction: 20,
        rows: [{ articleId: 'iron', weight: 830, tier: 'A', price: 2.4 }],
      },
      {
        ...base,
        id: 1418,
        status: 'new',
        customerId: 'customer-erik',
        idVerified: false,
        rows: [{ articleId: 'copper-1', weight: 72, tier: 'B', price: 73.8 }],
      },
      {
        ...base,
        id: 2039,
        status: 'attest',
        customerId: 'customer-brf',
        preparedBy: 'kajsa',
        rows: [
          { articleId: 'copper-mixed', weight: 230, tier: 'C', price: 56 },
        ],
      },
      {
        ...base,
        id: 2040,
        status: 'attest',
        customerId: 'customer-build',
        preparedBy: 'kajsa',
        rows: [{ articleId: 'copper-1', weight: 500, tier: 'A', price: 82 }],
      },
      {
        ...base,
        id: 2041,
        status: 'ready',
        customerId: 'customer-build',
        preparedBy: 'kajsa',
        approvedBy: 'anna',
        reference: 'Projekt Solbacken',
        origin: 'Ängsvägen 19',
        rows: [
          { articleId: 'copper-1', weight: 125, tier: 'A', price: 82 },
          { articleId: 'copper-mixed', weight: 230, tier: 'C', price: 56 },
          { articleId: 'stainless', weight: 130, tier: 'C', price: 14.4 },
        ],
      },
      {
        ...base,
        id: 2038,
        status: 'paid',
        customerId: 'customer-erik',
        preparedBy: 'kajsa',
        approvedBy: 'anna',
        rows: [{ articleId: 'iron', weight: 124, tier: 'C', price: 1.92 }],
      },
    ],
  };
}
