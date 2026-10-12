import { z } from 'zod';

export const ACCOUNT_ROLES = Object.freeze(['privatePurchase', 'reversePurchase', 'standardPurchase', 'noVatPurchase', 'supplierLiability', 'inputReverseVat', 'outputReverseVat', 'inputVat', 'offsetLiability']);
export const ACCOUNTING_DRAFT_PARAMETERS = Object.freeze({ useDefaultVatCodes: false, calculateVatOnCostAccounts: false });
const categories = new Set(['scrap_reverse', 'standard_25', 'no_vat', 'review']);
const uuid = z.string().uuid();
const accountNumber = z.number().int().min(1).max(9999999999);
const accountMap = z.object(Object.fromEntries(ACCOUNT_ROLES.map(role => [role, accountNumber.optional()]))).strict();
const settingsSchema = z.object({
  revision: z.number().int().positive().safe().default(1), enabled: z.boolean().default(false), exportMode: z.enum(['manual', 'after_attest']).default('manual'),
  companyId: z.string().trim().min(1).max(100), sandbox: z.literal(true).default(true), paymentTermDays: z.number().int().min(0).max(3650).default(0),
  trackingMaxDays: z.number().int().min(1).max(365).default(30),
  paymentTermsId: uuid.optional(), accounts: accountMap.default({}),
  vatCodes: z.object({ private: uuid.optional(), reverse25: uuid.optional(), standard25: uuid.optional(), noVat: uuid.optional() }).strict().default({}),
  nonVatBusinessRule: z.literal('no_vat').optional(),
  offsetReconciliation: z.object({ mode: z.literal('clearing'), accountNumber }).strict().optional(),
  sites: z.array(z.object({ siteId: z.string().trim().min(1).max(100), useDefaults: z.boolean(), costCenterId: uuid.optional(), projectId: uuid.optional(), accountOverrides: accountMap.optional() }).strict()).default([]),
});

export class AccountingError extends Error {
  constructor(message, code = 'accounting_invalid', status = 409) { super(message); this.name = 'AccountingError'; this.status = status; this.code = code; }
}
const fail = (message, code) => { throw new AccountingError(message, code); };
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
const safeCents = value => { if (typeof value !== 'bigint') value = BigInt(value); if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('Beloppet är negativt eller för stort.', 'accounting_amount_invalid'); return Number(value); };
const checkedCents = value => { if (!Number.isSafeInteger(value) || value < 0) fail('Belopp i ören måste vara ett icke-negativt heltal.', 'accounting_amount_invalid'); return value; };
const totalCents = values => safeCents(values.reduce((sum, value) => sum + BigInt(checkedCents(value)), 0n));
const major = value => {
  const result = checkedCents(value) / 100;
  if (moneyToCents(result) !== value) fail('Beloppet är för stort för en exakt överföring i kronor och ören.', 'accounting_amount_invalid');
  return result;
};

// Decimal strings, including the exponent form used by JS numbers, are parsed
// as rational integers. No multiplication or half-cent rounding uses floats.
function decimal(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || typeof value === 'number' && !Number.isFinite(value)) fail('Beloppet måste vara ett ändligt decimaltal.', 'accounting_amount_invalid');
  const raw = String(value).trim();
  const match = raw.match(/^\+?(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match || raw.length > 100) fail('Beloppet måste vara ett icke-negativt decimaltal.', 'accounting_amount_invalid');
  const exponent = Number(match[3] ?? 0), fraction = match[2] ?? '';
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 30) fail('Beloppets precision är inte stödd.', 'accounting_amount_invalid');
  const scale = fraction.length - exponent;
  if (Math.abs(scale) > 40) fail('Beloppets precision är inte stödd.', 'accounting_amount_invalid');
  return scale >= 0 ? [BigInt(match[1] + fraction), 10n ** BigInt(scale)] : [BigInt(match[1] + fraction) * 10n ** BigInt(-scale), 1n];
}
const roundRatio = (numerator, denominator) => safeCents((numerator * 2n + denominator) / (denominator * 2n));
export function moneyToCents(value) { const [numerator, denominator] = decimal(value); return roundRatio(numerator * 100n, denominator); }
export function calculateMaterialBaseCents({ weight, price }) { const [weightN, weightD] = decimal(weight), [priceN, priceD] = decimal(price); return roundRatio(weightN * priceN * 100n, weightD * priceD); }
const vat25 = cents => roundRatio(BigInt(checkedCents(cents)), 4n);

export function normalizeAccountingSettings(input, scope = {}) {
  const parsed = settingsSchema.safeParse({ ...input, companyId: input?.companyId ?? scope.companyId });
  if (!parsed.success) fail('Bokföringsinställningarna innehåller felaktiga konton, UUID eller villkor.', 'accounting_settings_invalid');
  const settings = parsed.data;
  if (scope.companyId && settings.companyId !== scope.companyId || scope.sandbox !== undefined && settings.sandbox !== scope.sandbox)
    fail('Bokföringsinställningarna hör till ett annat Spiris-företag eller en annan miljö.', 'accounting_company_mismatch');
  if (new Set(settings.sites.map(site => site.siteId)).size !== settings.sites.length) fail('Varje anläggning får bara ha en bokföringsmappning.', 'accounting_site_ambiguous');
  for (const site of settings.sites) if (site.useDefaults && Object.keys(site.accountOverrides ?? {}).length) fail('En anläggning kan inte både använda standardkonton och egna konton.', 'accounting_site_ambiguous');
  return settings;
}

function resolveSite(settings, siteId) {
  if (siteId === undefined || siteId === null || siteId === '') return { accounts: { ...settings.accounts } };
  const site = settings.sites.find(item => item.siteId === siteId);
  if (!site) fail('Anläggningen saknar en uttrycklig bokföringsmappning.', 'accounting_site_unmapped');
  return { siteId: site.siteId, accounts: { ...settings.accounts, ...(!site.useDefaults ? site.accountOverrides : {}) },
    ...(site.costCenterId ? { costCenterId: site.costCenterId } : {}), ...(site.projectId ? { projectId: site.projectId } : {}) };
}
const requiredAccount = (accounts, role) => { const value = accounts[role]; if (!accountNumber.safeParse(value).success) fail(`Kontot för ${role} behöver väljas före kundgodkännande.`, 'accounting_account_missing'); return value; };
function treatmentFor(customer, category, settings) {
  if (customer.type === 'Privatperson') return 'private';
  if (!['Företag', 'BRF'].includes(customer.type)) fail('Kundens företagstyp behöver granskas före kundgodkännande.', 'accounting_customer_review');
  if (typeof customer.vatRegistered !== 'boolean') fail('Företagets momsregistrering behöver fastställas före kundgodkännande.', 'accounting_vat_status_unknown');
  if (!customer.vatRegistered) {
    if (settings.nonVatBusinessRule !== 'no_vat') fail('Ett företag som inte är momsregistrerat kräver en uttrycklig rutin för inköp utan moms.', 'accounting_non_vat_rule_missing');
    return 'noVat';
  }
  if (category === 'scrap_reverse') return 'reverse25';
  if (category === 'standard_25') return 'standard25';
  if (category === 'no_vat') return 'noVat';
  fail('Materialets momsregel behöver granskas före kundgodkännande.', 'accounting_tax_review');
}

/** Only authoritative rows and customer metadata enter this economic freeze. */
export function freezePurchaseAccounting({ settings: input, customer, rows, siteId, offset, offsetCents, accountVatCodes = {} }) {
  if (!input?.enabled) return null;
  const settings = normalizeAccountingSettings(input);
  if (!customer || !Array.isArray(rows) || rows.length === 0) fail('Kund och materialrader krävs för bokföringsunderlaget.', 'accounting_source_incomplete');
  const site = resolveSite(settings, siteId), accounts = site.accounts;
  requiredAccount(accounts, 'supplierLiability');
  const days = customer.paymentTermDays ?? settings.paymentTermDays;
  if (!Number.isInteger(days) || days < 0 || days > 3650) fail('Kundens betalningsvillkor måste vara 0–3650 kalenderdagar.', 'accounting_payment_terms_invalid');
  const lines = rows.map(row => {
    if (!row || typeof row.articleId !== 'string' || !row.articleId.trim()) fail('Materialraden saknar artikelidentifierare.', 'accounting_source_incomplete');
    const taxCategory = categories.has(row.taxCategory) ? row.taxCategory : 'review';
    const treatment = treatmentFor(customer, taxCategory, settings);
    const role = { private: 'privatePurchase', reverse25: 'reversePurchase', standard25: 'standardPurchase', noVat: 'noVatPurchase' }[treatment];
    const purchaseAccount = requiredAccount(accounts, role);
    if (treatment === 'reverse25') { requiredAccount(accounts, 'inputReverseVat'); requiredAccount(accounts, 'outputReverseVat'); }
    if (treatment === 'standard25') requiredAccount(accounts, 'inputVat');
    const defaultCode = accountVatCodes[purchaseAccount];
    const vatCodeId = settings.vatCodes[treatment] ?? defaultCode ?? undefined;
    if (vatCodeId !== undefined && !uuid.safeParse(vatCodeId).success) fail('Kontots momskod måste vara ett verkligt Spiris-UUID.', 'accounting_vat_code_invalid');
    if (['reverse25', 'standard25'].includes(treatment) && !vatCodeId) fail('Materialets momskod behöver väljas före kundgodkännande.', 'accounting_vat_code_missing');
    const baseCents = row.amountCents !== undefined ? checkedCents(row.amountCents) : row.amount !== undefined ? moneyToCents(row.amount) : calculateMaterialBaseCents(row);
    if (row.amountCents !== undefined && row.amount !== undefined && baseCents !== moneyToCents(row.amount)) fail('Materialradens kronor och ören stämmer inte överens.', 'accounting_totals_invalid');
    const sellerVatCents = treatment === 'standard25' ? vat25(baseCents) : 0, reverseVatCents = treatment === 'reverse25' ? vat25(baseCents) : 0;
    const quantities = {};
    for (const key of ['weight', 'price']) if (row[key] !== undefined) { if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0) fail('Materialets vikt och pris måste vara ändliga och icke-negativa.', 'accounting_source_incomplete'); quantities[key] = row[key]; }
    return { articleId: row.articleId, name: String(row.name ?? '').slice(0, 300), taxCategory, treatment, baseCents, sellerVatCents, reverseVatCents,
      invoiceTotalCents: totalCents([baseCents, sellerVatCents]), amount: major(baseCents), base: major(baseCents), sellerVat: major(sellerVatCents), reverseVat: major(reverseVatCents),
      sellerVatRateBps: treatment === 'standard25' ? 2500 : 0, reverseVatRateBps: treatment === 'reverse25' ? 2500 : 0,
      purchaseAccount, ...(vatCodeId ? { vatCodeId } : {}), ...(site.costCenterId ? { costCenterId: site.costCenterId } : {}), ...(site.projectId ? { projectId: site.projectId } : {}), ...quantities };
  });
  const baseTotalCents = totalCents(lines.map(line => line.baseCents)), sellerVatCents = totalCents(lines.map(line => line.sellerVatCents)), reverseVatCents = totalCents(lines.map(line => line.reverseVatCents));
  const invoiceTotalCents = totalCents([baseTotalCents, sellerVatCents]), lockedOffset = offsetCents === undefined ? moneyToCents(offset ?? 0) : checkedCents(offsetCents);
  if (offsetCents !== undefined && offset !== undefined && lockedOffset !== moneyToCents(offset)) fail('Kvittningens kronor och ören stämmer inte överens.', 'accounting_totals_invalid');
  if (lockedOffset > invoiceTotalCents) fail('Kvittningen får inte överstiga hela fakturabeloppet inklusive eventuell moms.', 'accounting_offset_invalid');
  const snapshot = { schemaVersion: 1, settingsRevision: settings.revision, companyId: settings.companyId, sandbox: true, exportMode: settings.exportMode, currency: 'SEK',
    ...(site.siteId ? { siteId: site.siteId } : {}), customer: { type: customer.type, vatRegistered: customer.type === 'Privatperson' ? false : customer.vatRegistered, paymentTermDays: days },
    ...(settings.paymentTermsId ? { paymentTermsId: settings.paymentTermsId } : {}), accounts: { ...accounts }, lines,
    baseTotalCents, sellerVatCents, reverseVatCents, invoiceTotalCents, offsetCents: lockedOffset, paymentNetCents: invoiceTotalCents - lockedOffset,
    baseTotal: major(baseTotalCents), sellerVat: major(sellerVatCents), reverseVat: major(reverseVatCents), invoiceTotal: major(invoiceTotalCents),
    gross: major(invoiceTotalCents), base: major(baseTotalCents), vat: major(sellerVatCents), offset: major(lockedOffset), net: major(invoiceTotalCents - lockedOffset),
    ...(settings.offsetReconciliation ? { offsetReconciliation: { ...settings.offsetReconciliation } } : {}) };
  snapshot.exportEligibility = accountingExportEligibility(snapshot);
  return deepFreeze(snapshot);
}

export function validateAccountingSnapshot(accounting) {
  if (!accounting || accounting.schemaVersion !== 1 || accounting.sandbox !== true || typeof accounting.companyId !== 'string' || !accounting.companyId ||
    !Number.isSafeInteger(accounting.settingsRevision) || accounting.settingsRevision < 1 || accounting.currency !== 'SEK' || !['manual', 'after_attest'].includes(accounting.exportMode) ||
    !Array.isArray(accounting.lines) || !accounting.lines.length || !accountMap.safeParse(accounting.accounts).success)
    fail('Avräkningen saknar giltigt låst bokföringsunderlag.', 'accounting_freeze_missing');
  const customer = accounting.customer;
  if (!customer || !['Privatperson', 'Företag', 'BRF'].includes(customer.type) || typeof customer.vatRegistered !== 'boolean' ||
    !Number.isInteger(customer.paymentTermDays) || customer.paymentTermDays < 0 || customer.paymentTermDays > 3650)
    fail('Det låsta underlagets momsregistrering eller betalningsvillkor är felaktiga.', 'accounting_source_incomplete');
  requiredAccount(accounting.accounts, 'supplierLiability');
  for (const line of accounting.lines) {
    const role = { private: 'privatePurchase', reverse25: 'reversePurchase', standard25: 'standardPurchase', noVat: 'noVatPurchase' }[line.treatment];
    if (!role || !categories.has(line.taxCategory) || typeof line.articleId !== 'string' || !line.articleId || line.purchaseAccount !== requiredAccount(accounting.accounts, role))
      fail('Den låsta materialradens momshantering eller kontomappning är felaktig.', 'accounting_source_incomplete');
    if (customer.type === 'Privatperson' && line.treatment !== 'private' || customer.type !== 'Privatperson' && line.treatment === 'private' || !customer.vatRegistered && customer.type !== 'Privatperson' && line.treatment !== 'noVat' ||
      customer.vatRegistered && customer.type !== 'Privatperson' && ({ scrap_reverse: 'reverse25', standard_25: 'standard25', no_vat: 'noVat' }[line.taxCategory] !== line.treatment))
      fail('Den låsta momsbehandlingen stämmer inte med kund och material.', 'accounting_tax_review');
    for (const field of ['vatCodeId', 'costCenterId', 'projectId']) if (line[field] !== undefined && !uuid.safeParse(line[field]).success)
      fail('En låst momskod eller dimension saknar giltigt Spiris-UUID.', 'accounting_source_incomplete');
    const sellerVat = line.treatment === 'standard25' ? vat25(line.baseCents) : 0, reverseVat = line.treatment === 'reverse25' ? vat25(line.baseCents) : 0;
    if (['standard25', 'reverse25'].includes(line.treatment) && !line.vatCodeId) fail('Den låsta momsbehandlingen saknar momskod.', 'accounting_vat_code_missing');
    if (line.treatment === 'standard25') requiredAccount(accounting.accounts, 'inputVat');
    if (line.treatment === 'reverse25') { requiredAccount(accounting.accounts, 'inputReverseVat'); requiredAccount(accounting.accounts, 'outputReverseVat'); }
    if (line.sellerVatCents !== sellerVat || line.reverseVatCents !== reverseVat || line.invoiceTotalCents !== totalCents([line.baseCents, sellerVat]) ||
      line.sellerVatRateBps !== (line.treatment === 'standard25' ? 2500 : 0) || line.reverseVatRateBps !== (line.treatment === 'reverse25' ? 2500 : 0) ||
      moneyToCents(line.amount) !== line.baseCents || moneyToCents(line.base) !== line.baseCents || moneyToCents(line.sellerVat) !== sellerVat || moneyToCents(line.reverseVat) !== reverseVat)
      fail('Den låsta materialradens moms eller belopp stämmer inte.', 'accounting_totals_invalid');
  }
  const base = totalCents(accounting.lines.map(line => line.baseCents)), vat = totalCents(accounting.lines.map(line => line.sellerVatCents)), reverse = totalCents(accounting.lines.map(line => line.reverseVatCents));
  const gross = totalCents([base, vat]), offset = checkedCents(accounting.offsetCents);
  if (accounting.baseTotalCents !== base || accounting.sellerVatCents !== vat || accounting.reverseVatCents !== reverse || accounting.invoiceTotalCents !== gross || offset > gross || accounting.paymentNetCents !== gross - offset)
    fail('Det låsta bokföringsunderlagets rader och totaler stämmer inte.', 'accounting_totals_invalid');
  for (const [field, value] of Object.entries({ baseTotal: base, sellerVat: vat, reverseVat: reverse, invoiceTotal: gross, gross, base, vat, offset, net: gross - offset }))
    if (moneyToCents(accounting[field]) !== value) fail('Det låsta bokföringsunderlagets kronor och ören stämmer inte.', 'accounting_totals_invalid');
  return accounting;
}

export function accountingExportEligibility(accounting) {
  const issues = [];
  try { validateAccountingSnapshot(accounting); }
  catch (error) { issues.push({ code: error.code ?? 'accounting_freeze_missing', message: error.message }); }
  if (!issues.length) {
    if (!uuid.safeParse(accounting.paymentTermsId).success) issues.push({ code: 'accounting_payment_terms_missing', message: 'Ett verkligt betalningsvillkor i Spiris behöver väljas.' });
    if (accounting.offsetCents > 0) issues.push({ code: 'accounting_offset_reconciliation', message: 'Kvittning behöver kopplas till kreditunderlag i Spiris före automatisk överföring.' });
    const count = (accounting.lines ?? []).reduce((sum, line) => sum + 1 + (line.sellerVatCents > 0 ? 1 : 0) + (line.reverseVatCents > 0 ? 2 : 0), 1);
    if (count > 100) issues.push({ code: 'accounting_too_many_rows', message: 'Den fullständiga konteringen överskrider Spiris gräns på 100 rader.' });
  }
  return { eligible: issues.length === 0, issues };
}

export function stockholmInvoiceDate(attestedAt) {
  if (typeof attestedAt !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(attestedAt) || !Number.isFinite(Date.parse(attestedAt))) fail('Attesttid behöver vara en giltig tid med tidszon.', 'accounting_attest_date_invalid');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(attestedAt));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function addCalendarDays(date, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(days) || days < 0 || days > 3650) fail('Förfallodatumets kalenderdagar är felaktiga.', 'accounting_payment_terms_invalid');
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('Fakturadatumet är ogiltigt.', 'accounting_attest_date_invalid');
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Offset is displayed separately; this is a full gross invoice, never a payment. */
export function buildAccountingDraft({ accounting, attestedAt, invoiceNumber, supplierId }) {
  validateAccountingSnapshot(accounting);
  if (typeof invoiceNumber !== 'string' || !invoiceNumber.trim() || invoiceNumber.length > 50) fail('Fakturanumret måste vara 1–50 tecken.', 'accounting_invoice_number_invalid');
  if (supplierId !== undefined && !uuid.safeParse(supplierId).success) fail('Leverantörens identifierare måste vara ett UUID.', 'accounting_supplier_invalid');
  const invoiceDate = stockholmInvoiceDate(attestedAt), rows = [];
  let debitTotal = 0n, creditTotal = 0n;
  const add = (account, debit, credit, description, line, vatCode) => {
    const number = requiredAccount({ selected: account }, 'selected');
    debitTotal += BigInt(checkedCents(debit)); creditTotal += BigInt(checkedCents(credit));
    rows.push({ AccountNumber: number, DebitAmount: major(debit), CreditAmount: major(credit), LineNumber: rows.length + 1, TransactionText: description.slice(0, 100),
      ...(vatCode ? { VatCodeId: vatCode } : {}), ...(line?.costCenterId ? { CostCenterItemId1: line.costCenterId } : {}), ...(line?.projectId ? { ProjectId: line.projectId } : {}) });
  };
  for (const line of accounting.lines) {
    add(line.purchaseAccount, line.baseCents, 0, line.name || line.articleId, line, line.vatCodeId);
    if (line.sellerVatCents > 0) add(accounting.accounts.inputVat, line.sellerVatCents, 0, `Ingående moms 25 % · ${line.name}`, line);
    if (line.reverseVatCents > 0) {
      add(accounting.accounts.inputReverseVat, line.reverseVatCents, 0, `Ingående omvänd moms 25 % · ${line.name}`, line);
      add(accounting.accounts.outputReverseVat, 0, line.reverseVatCents, `Utgående omvänd moms 25 % · ${line.name}`, line);
    }
  }
  add(accounting.accounts.supplierLiability, 0, accounting.invoiceTotalCents, `Leverantörsskuld ${invoiceNumber}`);
  if (debitTotal !== creditTotal || totalCents(accounting.lines.map(line => line.baseCents)) !== accounting.baseTotalCents ||
    totalCents(accounting.lines.map(line => line.sellerVatCents)) !== accounting.sellerVatCents || totalCents([accounting.baseTotalCents, accounting.sellerVatCents]) !== accounting.invoiceTotalCents)
    fail('Det låsta bokföringsunderlagets rader och totaler stämmer inte.', 'accounting_totals_invalid');
  if (rows.length > 100) fail('Den fullständiga konteringen överskrider Spiris gräns på 100 rader.', 'accounting_too_many_rows');
  return { ...(supplierId ? { SupplierId: supplierId } : {}), IsCreditInvoice: false, InvoiceNumber: invoiceNumber, InvoiceDate: invoiceDate,
    DueDate: addCalendarDays(invoiceDate, accounting.customer.paymentTermDays), TotalAmount: major(accounting.invoiceTotalCents), Vat: major(accounting.sellerVatCents),
    CurrencyCode: 'SEK', IsDomestic: true, SkipSendToBank: true, Message: invoiceNumber.slice(0, 25), Rows: rows };
}

export function previewAccountingExample({ settings, siteId, example = 'private', amount = 1000, date = '2026-01-01' }) {
  if (!['private', 'reverse_scrap', 'standard_25', 'non_vat_business'].includes(example)) fail('Exemplet är okänt.', 'accounting_example_invalid');
  addCalendarDays(date, 0);
  const privateSeller = example === 'private';
  const accounting = freezePurchaseAccounting({ settings: { ...settings, enabled: true }, siteId,
    customer: { type: privateSeller ? 'Privatperson' : 'Företag', vatRegistered: example !== 'non_vat_business' },
    rows: [{ articleId: 'accounting-example', name: 'Exempelmaterial', amount, taxCategory: example === 'standard_25' ? 'standard_25' : 'scrap_reverse' }] });
  const draft = buildAccountingDraft({ accounting, attestedAt: `${date}T12:00:00+01:00`, invoiceNumber: 'EXEMPEL' });
  return { accounting, draft, rows: draft.Rows, issues: accounting.exportEligibility.issues };
}
