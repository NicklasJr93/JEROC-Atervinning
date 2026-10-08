import type { OfficeUser } from './model';

export type PriceTier = 'A' | 'B' | 'C';
export type PriceRule = { discountPercent: number; adjustmentKr: number };
export type PriceArticle = {
  id: string;
  category: string;
  name: string;
  description: string;
  includes: string[];
  excludes: string[];
  photos: number[];
  active: boolean;
  base: { type: 'lme'; metal: string } | { type: 'manual'; price: number };
  tiers: Record<PriceTier, PriceRule>;
  thresholds: { A: number; B: number };
  effectiveFrom: string;
  revisionId?: string;
  prices: Record<PriceTier, number | null>;
  baseSekKg: number | null;
  lmeRevisionId?: string;
};
export type LmeRate = {
  id: string;
  metal: string;
  cashUsdPerTonne: number;
  usdSek: number;
  effectiveFrom: string;
  at: string;
  actor: string;
  actingUser?: string;
  note?: string;
  sequence?: number;
};
export type CustomerPrice = {
  id?: string;
  revisionId?: string;
  customerId: string;
  articleId: string;
  kind: 'fixed' | 'tier-adjustment' | 'lme-discount';
  price?: number;
  tier?: PriceTier;
  adjustmentKr?: number;
  discountPercent?: number;
  active: boolean;
  effectiveFrom: string;
  note?: string;
};
export type PricingAudit = {
  at: string;
  actor?: string;
  actingUser?: string;
  action?: string;
  text?: string;
};
export type PricingState = {
  version: string;
  memoryOnly: boolean;
  revision: number;
  asOfDate: string;
  metals: { id: string; name: string }[];
  articles: PriceArticle[];
  articleHistory?: PriceArticle[];
  lme?: LmeRate[];
  customerPrices?: CustomerPrice[];
  customers: { id: string; name: string }[];
  users?: OfficeUser[];
  audit?: PricingAudit[];
};
export type QuoteRow = {
  articleId: string;
  weight: number;
  price: number | null;
  tier: PriceTier | 'Special' | 'Eget';
  volumeTier?: PriceTier;
  prices?: Record<PriceTier, number | null>;
  volumeBefore: number | null;
  volumeWithDelivery: number | null;
  source: string;
  baseSekKg: number | null;
  articleRevisionId: string;
  lmeRevisionId?: string;
  customerPriceRevisionId?: string;
};
export type PricingQuote = {
  rows: QuoteRow[];
  total: number | null;
  weight: number;
  deliveredAt: string;
  customerId?: string;
  memoryOnly: boolean;
};
export type PricingSnapshot = PricingQuote & {
  id: string;
  cardId: string;
  sourceSnapshotId?: string;
  supersedesSnapshotId?: string;
  correctedAt?: string;
  reason?: string;
  document?: string;
  preparedBy?: string;
  submittedBy?: string;
  approvedBy?: string;
  at: string;
  actor?: string;
  actingUser?: string;
};
export type CustomerPricePreview = {
  customerId: string;
  deliveredAt: string;
  rows: QuoteRow[];
  memoryOnly: boolean;
};
export async function pricingRequest<T>(
  path: string,
  user: OfficeUser,
  actualUser: OfficeUser,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/pricing/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-Demo-Actor': actualUser.id,
      'X-Demo-User': user.id,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      'Pristjänsten svarade inte. Försök igen när servern har startat.',
    );
  }
  if (!response.ok) {
    const detail = result as { error?: string; message?: string };
    throw new Error(
      detail.error ||
        detail.message ||
        'Pristjänsten kunde inte utföra åtgärden.',
    );
  }
  return result as T;
}
