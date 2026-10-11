import { z } from 'zod';

export const articleTaxCategorySchema = z.enum(['scrap_reverse', 'standard_25', 'no_vat', 'review']);
export type ArticleTaxCategory = z.infer<typeof articleTaxCategorySchema>;
export const accountingAccountRoles = ['privatePurchase', 'reversePurchase', 'standardPurchase', 'noVatPurchase', 'supplierLiability', 'inputReverseVat', 'outputReverseVat', 'inputVat', 'offsetLiability'] as const;
export type AccountRole = typeof accountingAccountRoles[number];
const account = z.number().int().min(1).max(9999999999);
const accountsSchema = z.object(Object.fromEntries(accountingAccountRoles.map(role => [role, account.optional()])) as Record<AccountRole, z.ZodOptional<typeof account>>).strict();
const uuid = z.string().uuid();
const cents = z.number().int().nonnegative().safe();
export const accountingSettingsSchema = z.object({
  revision: z.number().int().positive().safe(), enabled: z.boolean(), exportMode: z.enum(['manual', 'after_attest']),
  companyId: z.string().min(1).max(100), sandbox: z.literal(true), paymentTermDays: z.number().int().min(0).max(3650),
  paymentTermsId: uuid.optional(), accounts: accountsSchema,
  vatCodes: z.object({ private: uuid.optional(), reverse25: uuid.optional(), standard25: uuid.optional(), noVat: uuid.optional() }),
  nonVatBusinessRule: z.literal('no_vat').optional(),
  offsetReconciliation: z.object({ mode: z.literal('clearing'), accountNumber: account }).optional(),
  sites: z.array(z.object({ siteId: z.string().min(1).max(100), useDefaults: z.boolean(), costCenterId: uuid.optional(), projectId: uuid.optional(), accountOverrides: accountsSchema.optional() })),
}).strict();
export type AccountingSettings = z.infer<typeof accountingSettingsSchema>;
export type AccountingIssue = { code: string; message: string };
const accountingLineSchema = z.object({
  articleId: z.string().min(1), name: z.string(), taxCategory: articleTaxCategorySchema,
  treatment: z.enum(['private', 'reverse25', 'standard25', 'noVat']),
  baseCents: cents, sellerVatCents: cents, reverseVatCents: cents, invoiceTotalCents: cents,
  amount: z.number().finite().nonnegative(), base: z.number().finite().nonnegative(), sellerVat: z.number().finite().nonnegative(), reverseVat: z.number().finite().nonnegative(),
  sellerVatRateBps: z.union([z.literal(0), z.literal(2500)]), reverseVatRateBps: z.union([z.literal(0), z.literal(2500)]),
  purchaseAccount: account, vatCodeId: uuid.optional(), costCenterId: uuid.optional(), projectId: uuid.optional(),
  weight: z.number().finite().nonnegative().optional(), price: z.number().finite().nonnegative().optional(),
}).strict();
/** Stored alongside the customer-approved economic snapshot; live settings never replace these fields. */
export const accountingSnapshotSchema = z.object({
  schemaVersion: z.literal(1), settingsRevision: z.number().int().positive().safe(), companyId: z.string().min(1), sandbox: z.literal(true),
  exportMode: z.enum(['manual', 'after_attest']), currency: z.literal('SEK'), siteId: z.string().optional(),
  customer: z.object({ type: z.string(), vatRegistered: z.boolean().nullable(), paymentTermDays: z.number().int().min(0).max(3650) }).strict(),
  paymentTermsId: uuid.optional(), accounts: accountsSchema, lines: z.array(accountingLineSchema).min(1),
  baseTotalCents: cents, sellerVatCents: cents, reverseVatCents: cents, invoiceTotalCents: cents, offsetCents: cents, paymentNetCents: cents,
  baseTotal: z.number(), sellerVat: z.number(), reverseVat: z.number(), invoiceTotal: z.number(),
  gross: z.number(), base: z.number(), vat: z.number(), offset: z.number(), net: z.number(),
  offsetReconciliation: z.object({ mode: z.literal('clearing'), accountNumber: account }).optional(),
  exportEligibility: z.object({ eligible: z.boolean(), issues: z.array(z.object({ code: z.string(), message: z.string() }).strict()) }).strict(),
}).strict();
export const purchaseAccountingSnapshotSchema = accountingSnapshotSchema;
export type AccountingSnapshot = z.infer<typeof accountingSnapshotSchema>;
export type AccountingLine = z.infer<typeof accountingLineSchema>;
export type AccountingDraftRow = {
  AccountNumber: number; DebitAmount: number; CreditAmount: number; LineNumber: number; TransactionText: string;
  VatCodeId?: string; CostCenterItemId1?: string; ProjectId?: string;
};
export type AccountingDraft = {
  SupplierId?: string; IsCreditInvoice: false; InvoiceNumber: string; InvoiceDate: string; DueDate: string;
  TotalAmount: number; Vat: number; CurrencyCode: 'SEK'; IsDomestic: true; SkipSendToBank: true; Message: string; Rows: AccountingDraftRow[];
};
