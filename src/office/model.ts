import { z } from 'zod';
import { initialCustomers } from '../data';
export const OFFICE_VERSION = '0.8.1';
export const OFFICE_WEIGHING_DEMO_VERSION = 'demo-weighings-2026-10-09-v2';
export const officeKey = 'jeroc.office.demo.v1';
export const permissionNames = {
  view: 'Se vägningar och kunder',
  prepare: 'Granska och komplettera',
  weighingAddArticle: 'Lägga till artiklar på öppna invägningar',
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
  corrections: 'Skapa och hantera rättelser',
  reports: 'Se ekonomisk översikt',
  transportRead: 'Läsa transportplanering',
  transportPlan: 'Skapa, boka och ändra transporter',
  customerApprovalRead: 'Läsa kundgodkännanden',
  environmentRead: 'Läsa miljöunderlag och mottagningar',
  environmentWrite: 'Registrera faktisk mottagning och miljöuppgifter',
  environmentClassify: 'Ändra artiklars miljöklassificering',
  environmentStorage: 'Hantera anläggningar, tillstånd och lagringsgränser',
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
  siteIds: z.array(z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/)).max(100).optional(),
  maxAttest: z.number().nonnegative(),
  ownAttest: z.boolean(),
});
export type OfficeUser = z.infer<typeof userSchema>;
const rowSchema = z.object({
  articleId: z.string(),
  articleName: z.string().max(300).optional(),
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
export type OfficeAudit = z.infer<typeof auditSchema>;
export const paymentDetailsSchema = z.object({
  method: z.enum(['bank', 'swish', 'cash', 'balance']),
  bank: z.string().optional(),
  clearing: z.string().optional(),
  account: z.string().optional(),
  holder: z.string().optional(),
  phone: z.string().optional(),
  recipient: z.string().optional(),
});
export type PaymentDetails = z.infer<typeof paymentDetailsSchema>;
const customerSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  type: z.enum(['Företag', 'Privatperson', 'BRF']),
  number: z.string(),
  customerNumber: z.string(),
  phone: z.string(),
  email: z.string(),
  address: z.string().default(''),
  postalCode: z.string().default(''),
  city: z.string().default(''),
  contactPerson: z.string().default(''),
  references: z.array(z.string()).default([]),
  origins: z.array(z.string()).default([]),
  registrations: z.array(z.string()).default([]),
  paymentProfile: paymentDetailsSchema.optional(),
  audit: z.array(auditSchema).default([]),
});
export type OfficeCustomer = z.infer<typeof customerSchema>;
export function seedOfficeCustomers(): OfficeCustomer[] {
  return initialCustomers.map((customer, index) => ({
    ...customer,
    customerNumber: `K-${String(1001 + index)}`,
    address: customer.address ?? '',
    postalCode: '',
    city: '',
    contactPerson: '',
    registrations: [...(customer.registrations ?? [])],
    references: [...customer.references],
    origins: [...customer.origins],
    paymentProfile: {
      method: 'bank',
      bank: 'Demobank',
      clearing: '8327',
      account: '1234567890',
      holder: customer.name,
    },
    audit: [],
  }));
}
const cardSchema = z.object({
  id: z.number(),
  sourceId: z.string().uuid().optional(),
  customerId: z.string().optional(),
  customerSnapshot: customerSchema.optional(),
  status: z.enum(['new', 'complement', 'customer', 'attest', 'ready', 'paid', 'balance']),
  siteId: z.string().optional(),
  customerApproval: z.object({
    id: z.string(), version: z.number().int().positive(),
    status: z.enum(['waiting', 'id_requested', 'approved', 'change_requested', 'cancelled', 'expired', 'attested']),
    updatedAt: z.string(), approvedBy: z.string().optional(), approvedAt: z.string().optional(),
    attestedBy: z.string().optional(), attestedAt: z.string().optional(),
  }).optional(),
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
  paymentDetails: paymentDetailsSchema.optional(),
  idVerified: z.boolean(),
  preparedBy: z.string().optional(),
  approvedBy: z.string().optional(),
  paidAt: z.string().optional(),
  kind: z.enum(['delivery', 'correction']).optional(),
  sourceCorrectionId: z.number().optional(),
  pricingSnapshotId: z.string().optional(),
  pricedAt: z.string().optional(),
  pricingTotal: z.number().nonnegative().optional(),
  financialPending: z.boolean().optional(),
  pricingRowsPending: z.boolean().optional(),
  audit: z.array(auditSchema),
});
export type OfficeCard = z.infer<typeof cardSchema>;
const correctionSchema = z.object({
  id: z.number(),
  serverId: z.string().max(100).optional(),
  cardId: z.number(),
  customerId: z.string(),
  articleId: z.string(),
  weightDelta: z.number(),
  reason: z.string(),
  actor: z.string(),
  at: z.string(),
  status: z.enum(['draft', 'attest', 'approved']).optional(),
  unitPrice: z.number().nonnegative().optional(),
  amountDelta: z.number().optional(),
  document: z.string().optional(),
  office: z.string().optional(),
  actualUserId: z.string().optional(),
  effectiveUserId: z.string().optional(),
  submittedBy: z.string().optional(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  resultCardId: z.number().optional(),
  audit: z.array(auditSchema).optional(),
});
export type OfficeCorrection = z.infer<typeof correctionSchema>;
const paymentSchema = z.object({
  id: z.string(),
  cardId: z.number(),
  customerId: z.string(),
  amount: z.number().nonnegative(),
  offset: z.number().nonnegative(),
  method: z.enum(['bank', 'swish', 'cash']),
  date: z.string(),
  reference: z.string(),
  actor: z.string(),
  office: z.string(),
  actualUserId: z.string().optional(),
  effectiveUserId: z.string().optional(),
  paymentDetails: paymentDetailsSchema.optional(),
  correctionIds: z.array(z.number()).optional(),
});
export type OfficePayment = z.infer<typeof paymentSchema>;
export const officeSchema = z.object({
  transportPermissionsVersion: z.number().int().min(0).max(1).default(0),
  terminalDemoPermissionsVersion: z.number().int().min(0).max(1).optional(),
  demoPrivateIdentityVersion: z.number().int().min(0).max(1).optional(),
  weighingArticlePermissionsVersion: z.number().int().min(0).max(1).optional(),
  environmentPermissionsVersion: z.number().int().min(0).max(1).optional(),
  weighingDemoVersion: z.string().optional(),
  users: z.array(userSchema),
  cards: z.array(cardSchema),
  customers: z.array(customerSchema).default(seedOfficeCustomers),
  payments: z.array(paymentSchema).default([]),
  corrections: z.array(correctionSchema),
});
export type OfficeData = z.infer<typeof officeSchema>;
export const statusNames = {
  new: 'Ny från gården',
  complement: 'Behöver kompletteras',
  customer: 'Inväntar kundgodkännande',
  attest: 'Väntar på attest',
  ready: 'Klar för utbetalning',
  paid: 'Demoutbetald',
  balance: 'Sparat på saldo',
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
        'weighingAddArticle',
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
    siteId: 'norrtalje',
    yard: 'Norrtälje',
    weigher: 'Niklas',
    date: '2026-10-09T08:41:00Z',
    reference: '',
    origin: '',
    payment: '',
    idVerified: false,
    kind: 'delivery' as const,
    audit: [
      {
        at: '2026-10-09T08:41:00Z',
        actor: 'Niklas · Gårdsplan',
        text: 'Ny demoinvägning registrerad. Kundgodkännande och intern attest återstår.',
      },
    ],
  };
  return {
    transportPermissionsVersion: 1,
    terminalDemoPermissionsVersion: 1,
    environmentPermissionsVersion: 1,
    weighingArticlePermissionsVersion: 1,
    demoPrivateIdentityVersion: 1,
    weighingDemoVersion: OFFICE_WEIGHING_DEMO_VERSION,
    users,
    customers: seedOfficeCustomers(),
    payments: [],
    corrections: [],
    cards: [
      {
        ...base,
        id: 2050,
        sourceId: 'b2640584-c96a-4c16-8744-5d82d8d72050',
        status: 'new',
        customerId: 'customer-build',
        reference: 'Batterier från verkstad · demo',
        origin: 'Industrivägen 8, 761 41 Norrtälje',
        payment: 'Bankkonto · demo 8327 / ****7890',
        rows: [
          { articleId: 'lead-battery', weight: 250, tier: 'A', price: 4.5 },
          { articleId: 'copper-1', weight: 12, tier: 'C', price: 65.6 },
        ],
      },
      {
        ...base,
        id: 2051,
        sourceId: '36b56174-7493-4ae8-8da4-f20d84b92051',
        status: 'complement',
        rows: [
          { articleId: 'copper-1', weight: 125, tier: 'A', price: 82 },
          { articleId: 'copper-mixed', weight: 230, tier: 'C', price: 56 },
          { articleId: 'stainless', weight: 130, tier: 'C', price: 14.4 },
        ],
      },
      {
        ...base,
        id: 2052,
        sourceId: '69c7b472-ec65-44f0-9aca-0679080f2052',
        status: 'new',
        customerId: 'customer-build',
        registration: 'ABC123',
        gross: 12450,
        tare: 11600,
        deduction: 20,
        origin: 'Ängsvägen 19, 761 41 Norrtälje',
        payment: 'Bankkonto · demo 8327 / ****7890',
        rows: [{ articleId: 'iron', weight: 830, tier: 'A', price: 2.4 }],
      },
      {
        ...base,
        id: 2053,
        sourceId: '4b4d9b80-eae6-446f-a22f-b21cb1ae2053',
        status: 'new',
        customerId: 'customer-erik',
        idVerified: false,
        rows: [{ articleId: 'copper-1', weight: 72, tier: 'B', price: 73.8 }],
      },
    ],
  };
}
