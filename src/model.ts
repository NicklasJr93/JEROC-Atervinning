import { z } from 'zod';
import { articles, initialCustomers, type Customer } from './data';

const weight = z.number().finite().nonnegative();
const rowSchema = z.discriminatedUnion('method', [
  z.object({
    id: z.string(),
    articleId: z.string(),
    method: z.literal('direct'),
    weight: weight.positive(),
  }),
  z.object({
    id: z.string(),
    articleId: z.string(),
    method: z.literal('vehicle'),
    registration: z.string(),
    gross: weight.positive().optional(),
    tare: weight.optional(),
    deduction: weight,
    deductionReason: z.string(),
    entryAt: z.string().optional(),
    exitAt: z.string().optional(),
  }),
]);
export const draftSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  mode: z.enum(['direct', 'vehicle']),
  status: z.enum(['draft', 'awaiting-exit', 'ready']),
  createdAt: z.string(),
  updatedAt: z.string(),
  activityOrder: z.number().int().nonnegative().optional(),
  rows: z.array(rowSchema),
  customerId: z.string().optional(),
  reference: z.string(),
  origin: z.string(),
  pendingWeight: z
    .object({
      articleId: z.string(),
      value: z.string(),
      rowId: z.string().optional(),
      back: z.string(),
    })
    .optional(),
  vehicleInput: z
    .object({
      registration: z.string(),
      gross: z.string(),
      tare: z.string(),
      deduction: z.string(),
      reason: z.string(),
    })
    .optional(),
});
export type MaterialRow = z.infer<typeof rowSchema>;
export type VehicleRow = Extract<MaterialRow, { method: 'vehicle' }>;
export type Draft = z.infer<typeof draftSchema>;
const customerSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['Företag', 'Privatperson', 'BRF']),
  number: z.string(),
  phone: z.string(),
  email: z.string(),
  address: z.string().optional(),
  references: z.array(z.string()),
  origins: z.array(z.string()),
  registrations: z.array(z.string()).optional(),
});
export const storeSchema = z
  .object({
    version: z.literal(1),
    drafts: z.array(draftSchema),
    customers: z.array(customerSchema),
  })
  .superRefine((store, ctx) => {
    if (
      store.drafts.some((d) =>
        d.rows.some((r) => !articles.some((a) => a.id === r.articleId)),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Okänd artikel' });
  });
export type DemoData = { version: 1; drafts: Draft[]; customers: Customer[] };
export const STORE_KEY = 'jeroc.mobile.demo.v1';
export const APP_VERSION = '0.2.3';
export const normalizeRegistration = (value: string) =>
  value.toUpperCase().replace(/[\s-]/g, '');
export const draftPath = (draft: Draft) =>
  `/weigh/${draft.id}/${draft.status !== 'ready' && draft.mode === 'vehicle' && !draft.rows.some((r) => r.method === 'vehicle' && r.tare != null) ? 'vehicle' : 'summary'}`;
export const id = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `demo-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('')}`;
export const kilos = (n: number) =>
  new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 3 }).format(n);
export const money = (n: number) =>
  new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
export const dateTime = (s: string) =>
  new Intl.DateTimeFormat('sv-SE', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(s));
export function parseWeight(s: string): number | null {
  const normalized = s.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) && n <= 1_000_000 ? n : null;
}
export function rowWeight(row: MaterialRow): number {
  return row.method === 'direct'
    ? row.weight
    : row.gross != null && row.tare != null
      ? Math.max(
          0,
          Math.round((row.gross - row.tare - row.deduction) * 1000) / 1000,
        )
      : 0;
}
export const totalWeight = (draft: Draft) =>
  Math.round(draft.rows.reduce((sum, row) => sum + rowWeight(row), 0) * 1000) /
  1000;
export function vehicleError(
  gross: number | null,
  tare: number | null,
  deduction: number | null,
  reason: string,
): string | null {
  if (gross == null || gross <= 0) return 'Ange en infartsvikt större än 0 kg.';
  if (tare == null || tare < 0) return 'Ange en giltig utfartsvikt.';
  if (tare >= gross) return 'Utfartsvikten måste vara lägre än infartsvikten.';
  if (deduction == null || deduction < 0 || deduction >= gross - tare)
    return 'Viktavdraget måste vara mindre än nettovikten.';
  if (deduction > 0 && !reason.trim())
    return 'Ange en orsak till viktavdraget.';
  return null;
}
export function isComplete(draft: Draft): boolean {
  return (
    draft.rows.length > 0 &&
    (draft.mode !== 'vehicle' ||
      draft.rows.some((r) => r.method === 'vehicle')) &&
    draft.rows.every((row) =>
      row.method === 'direct'
        ? row.weight > 0
        : row.gross != null &&
          row.tare != null &&
          !vehicleError(
            row.gross,
            row.tare,
            row.deduction,
            row.deductionReason,
          ),
    )
  );
}
export function createDraft(data: DemoData, mode: Draft['mode']): Draft {
  const now = new Date().toISOString();
  return {
    id: id(),
    number: Math.max(1417, ...data.drafts.map((d) => d.number)) + 1,
    mode,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    rows: [],
    reference: '',
    origin: '',
  };
}
export function seedDemo(): DemoData {
  const now = new Date().toISOString();
  const base = { createdAt: now, updatedAt: now, reference: '', origin: '' };
  return {
    version: 1,
    customers: initialCustomers,
    drafts: [
      {
        ...base,
        id: 'demo-1414',
        number: 1414,
        mode: 'direct',
        status: 'draft',
        rows: [
          {
            id: 'demo-row-1',
            articleId: 'copper-1',
            method: 'direct',
            weight: 125,
          },
        ],
      },
      {
        ...base,
        id: 'demo-1415',
        number: 1415,
        mode: 'direct',
        status: 'draft',
        customerId: 'customer-build',
        rows: [
          {
            id: 'demo-row-2',
            articleId: 'copper-mixed',
            method: 'direct',
            weight: 230,
          },
          {
            id: 'demo-row-3',
            articleId: 'stainless',
            method: 'direct',
            weight: 130,
          },
        ],
      },
      {
        ...base,
        id: 'demo-1416',
        number: 1416,
        mode: 'vehicle',
        status: 'awaiting-exit',
        rows: [
          {
            id: 'demo-row-4',
            articleId: 'iron',
            method: 'vehicle',
            registration: 'ABC123',
            gross: 12450,
            deduction: 0,
            deductionReason: '',
            entryAt: now,
          },
        ],
      },
      {
        ...base,
        id: 'demo-1417',
        number: 1417,
        mode: 'vehicle',
        status: 'awaiting-exit',
        rows: [
          {
            id: 'demo-row-5',
            articleId: 'aluminium',
            method: 'vehicle',
            registration: 'DEF456',
            gross: 4320,
            deduction: 0,
            deductionReason: '',
            entryAt: now,
          },
        ],
      },
    ],
  };
}

export function recentDraftFirst(a: Draft, b: Draft): number {
  return (
    (b.activityOrder ?? 0) - (a.activityOrder ?? 0) ||
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
    b.number - a.number
  );
}
