import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ACCOUNTING_DRAFT_PARAMETERS, AccountingError, accountingExportEligibility, addCalendarDays, buildAccountingDraft,
  calculateMaterialBaseCents, freezePurchaseAccounting, moneyToCents, normalizeAccountingSettings, previewAccountingExample, stockholmInvoiceDate,
} from './visma-accounting.mjs';

const companyId = 'pinned-sandbox-company';
const settings = () => ({ revision: 7, enabled: true, exportMode: 'after_attest', companyId, sandbox: true,
  paymentTermDays: 0, paymentTermsId: randomUUID(), accounts: { privatePurchase: 4000, reversePurchase: 4415, standardPurchase: 4010,
    noVatPurchase: 4001, supplierLiability: 2440, inputReverseVat: 2647, outputReverseVat: 2614, inputVat: 2641, offsetLiability: 1680 },
  vatCodes: { reverse25: randomUUID(), standard25: randomUUID() }, sites: [{ siteId: 'yard-1', useDefaults: true, costCenterId: randomUUID(), projectId: randomUUID() }] });
const customer = patch => ({ type: 'Företag', vatRegistered: true, ...patch });
const row = (taxCategory = 'scrap_reverse', amount = 1000, patch = {}) => ({ articleId: 'article-copper', name: 'Koppar', taxCategory, amount, weight: 10, price: 100, ...patch });
const freeze = (patch = {}) => freezePurchaseAccounting({ settings: settings(), customer: customer(), rows: [row()], siteId: 'yard-1', ...patch });
const draft = accounting => buildAccountingDraft({ accounting, attestedAt: '2026-10-10T22:30:00Z', invoiceNumber: 'AV-3016-V2', supplierId: randomUUID() });
const balance = rows => rows.reduce((sum, item) => sum + moneyToCents(item.DebitAmount) - moneyToCents(item.CreditAmount), 0);
const isCode = code => error => error instanceof AccountingError && error.status === 409 && error.code === code;

test('money and weighted material arithmetic round decimal half cents without binary multiplication', () => {
  assert.equal(moneyToCents(1.005), 101); assert.equal(moneyToCents(2.675), 268); assert.equal(moneyToCents(0.1 + 0.2), 30);
  assert.equal(moneyToCents('1.005'), 101); assert.equal(moneyToCents(1e-7), 0);
  assert.equal(calculateMaterialBaseCents({ weight: 0.1, price: 0.2 }), 2);
  assert.equal(calculateMaterialBaseCents({ weight: 1.5, price: 0.67 }), 101);
  for (const value of [NaN, Infinity, -1, '1,00', 'abc', Number.MAX_SAFE_INTEGER]) assert.throws(() => moneyToCents(value), isCode('accounting_amount_invalid'));
});

test('settings defaults, UUIDs, scope, duplicate sites and contradictory inheritance are checked', () => {
  assert.deepEqual(normalizeAccountingSettings({ companyId }), { revision: 1, enabled: false, exportMode: 'manual', companyId, sandbox: true, paymentTermDays: 0, accounts: {}, vatCodes: {}, sites: [] });
  assert.throws(() => normalizeAccountingSettings(settings(), { companyId: 'another-company' }), isCode('accounting_company_mismatch'));
  for (const patch of [{ sandbox: false }, { revision: 0 }, { paymentTermDays: 1.5 }, { paymentTermsId: '0' }, { vatCodes: { reverse25: '25' } }, { sites: [{ siteId: 'yard-1', useDefaults: true, projectId: 'Project-X' }] }])
    assert.throws(() => normalizeAccountingSettings({ ...settings(), ...patch }), isCode('accounting_settings_invalid'));
  assert.throws(() => normalizeAccountingSettings({ ...settings(), sites: [{ siteId: 'same', useDefaults: true }, { siteId: 'same', useDefaults: false }] }), isCode('accounting_site_ambiguous'));
  assert.throws(() => normalizeAccountingSettings({ ...settings(), sites: [{ siteId: 'yard-1', useDefaults: true, accountOverrides: { privatePurchase: 4001 } }] }), isCode('accounting_site_ambiguous'));
});

test('private sellers have no seller or reverse VAT for taxable materials; no arbitrary VAT code is invented', () => {
  for (const category of ['scrap_reverse', 'standard_25', 'no_vat', 'review']) {
    const accounting = freeze({ customer: customer({ type: 'Privatperson', vatRegistered: undefined }), rows: [row(category)] });
    assert.equal(accounting.lines[0].treatment, 'private'); assert.equal(accounting.lines[0].purchaseAccount, 4000);
    assert.equal(accounting.lines[0].vatCodeId, undefined); assert.equal(accounting.sellerVatCents, 0); assert.equal(accounting.reverseVatCents, 0);
    assert.equal(accounting.invoiceTotal, 1000); assert.equal(draft(accounting).Vat, 0); assert.equal(balance(draft(accounting).Rows), 0);
  }
});

test('registered reverse VAT is self-assessed while registered ordinary VAT increases the frozen invoice and payment', () => {
  const reverse = freeze(), reverseDraft = draft(reverse);
  assert.equal(reverse.baseTotal, 1000); assert.equal(reverse.sellerVat, 0); assert.equal(reverse.reverseVat, 250); assert.equal(reverse.gross, 1000); assert.equal(reverse.net, 1000);
  assert.deepEqual(reverseDraft.Rows.map(item => [item.AccountNumber, item.DebitAmount, item.CreditAmount]), [[4415, 1000, 0], [2647, 250, 0], [2614, 0, 250], [2440, 0, 1000]]);
  const ordinary = freeze({ rows: [row('standard_25')] }), ordinaryDraft = draft(ordinary);
  assert.equal(ordinary.base, 1000); assert.equal(ordinary.vat, 250); assert.equal(ordinary.gross, 1250); assert.equal(ordinary.net, 1250);
  assert.deepEqual(ordinaryDraft.Rows.map(item => [item.AccountNumber, item.DebitAmount, item.CreditAmount]), [[4010, 1000, 0], [2641, 250, 0], [2440, 0, 1250]]);
  assert.equal(ordinaryDraft.TotalAmount, 1250); assert.equal(ordinaryDraft.Vat, 250); assert.equal(balance(ordinaryDraft.Rows), 0);
  assert.deepEqual(ACCOUNTING_DRAFT_PARAMETERS, { useDefaultVatCodes: false, calculateVatOnCostAccounts: false });
});

test('VAT rounds each material line once and a mixed card preserves separate classifications and totals', () => {
  const accounting = freeze({ rows: [row('standard_25', 0.02), row('standard_25', 0.02, { articleId: 'second' }), row('scrap_reverse', 100, { articleId: 'reverse' }), row('no_vat', 10, { articleId: 'exempt' })] });
  assert.equal(accounting.baseTotalCents, 11004); assert.equal(accounting.sellerVatCents, 2); assert.equal(accounting.reverseVatCents, 2500);
  assert.equal(accounting.invoiceTotalCents, 11006); assert.equal(balance(draft(accounting).Rows), 0);
  assert.deepEqual(accounting.lines.map(line => line.treatment), ['standard25', 'standard25', 'reverse25', 'noVat']);
});

test('unresolved customer status or material regimes block enabled approval, legacy disabled flow is untouched', () => {
  assert.equal(freezePurchaseAccounting({ settings: { enabled: false } }), null);
  assert.throws(() => freeze({ customer: customer({ vatRegistered: undefined }) }), isCode('accounting_vat_status_unknown'));
  assert.throws(() => freeze({ customer: customer({ type: 'Unknown' }) }), isCode('accounting_customer_review'));
  for (const category of ['review', undefined, 'fake']) assert.throws(() => freeze({ rows: [row('scrap_reverse', 1000, { taxCategory: category })] }), isCode('accounting_tax_review'));
  assert.throws(() => freeze({ rows: [row('standard_25'), row('review', 100, { articleId: 'unclassified' })] }), isCode('accounting_tax_review'));
  assert.throws(() => freeze({ customer: customer({ vatRegistered: false }) }), isCode('accounting_non_vat_rule_missing'));
  const config = { ...settings(), nonVatBusinessRule: 'no_vat' };
  const accounting = freeze({ settings: config, customer: customer({ type: 'BRF', vatRegistered: false }) });
  assert.equal(accounting.lines[0].treatment, 'noVat'); assert.equal(accounting.lines[0].purchaseAccount, 4001); assert.equal(accounting.gross, 1000);
});

test('account roles are never guessed; actual selected taxcodes may come from known account metadata', () => {
  const missingAccounts = settings(); delete missingAccounts.accounts.reversePurchase;
  assert.throws(() => freeze({ settings: missingAccounts }), isCode('accounting_account_missing'));
  const missingCodes = settings(); missingCodes.vatCodes = {};
  assert.throws(() => freeze({ settings: missingCodes }), isCode('accounting_vat_code_missing'));
  const code = randomUUID(); assert.equal(freeze({ settings: missingCodes, accountVatCodes: { 4415: code } }).lines[0].vatCodeId, code);
  assert.throws(() => freeze({ settings: missingCodes, accountVatCodes: { 4415: '25' } }), isCode('accounting_vat_code_invalid'));
});

test('sites match immutable IDs and partial overrides retain defined defaults; dimensions are copied only to the material/VAT rows', () => {
  const config = settings(); config.sites[0].useDefaults = false; config.sites[0].accountOverrides = { reversePurchase: 4400 };
  const accounting = freeze({ settings: config }), result = draft(accounting);
  assert.equal(accounting.lines[0].purchaseAccount, 4400); assert.equal(accounting.accounts.supplierLiability, 2440);
  for (const item of result.Rows.slice(0, -1)) { assert.equal(item.CostCenterItemId1, config.sites[0].costCenterId); assert.equal(item.ProjectId, config.sites[0].projectId); }
  assert.equal(result.Rows.at(-1).CostCenterItemId1, undefined); assert.equal(result.Rows.at(-1).ProjectId, undefined);
  assert.throws(() => freeze({ siteId: 'Yard Name' }), isCode('accounting_site_unmapped'));
});

test('economic freeze is deeply immutable and cannot change with later customer/settings/article changes', () => {
  const config = settings(), seller = customer({ paymentTermDays: 30 }), rows = [row('standard_25')];
  const before = structuredClone({ config, seller, rows });
  const accounting = freeze({ settings: config, customer: seller, rows });
  assert.deepEqual({ config, seller, rows }, before);
  config.revision++; config.accounts.standardPurchase = 9999; config.paymentTermDays = 90; config.sites[0].projectId = randomUUID(); seller.paymentTermDays = 15; seller.vatRegistered = false; rows[0].taxCategory = 'review'; rows[0].amount = 9999;
  assert.equal(accounting.settingsRevision, 7); assert.equal(accounting.customer.paymentTermDays, 30); assert.equal(accounting.lines[0].purchaseAccount, 4010); assert.equal(accounting.lines[0].taxCategory, 'standard_25'); assert.equal(accounting.gross, 1250);
  assert.equal(Object.isFrozen(accounting), true); assert.equal(Object.isFrozen(accounting.lines[0]), true);
  assert.equal(draft(accounting).DueDate, '2026-11-10');
});

test('offset affects frozen payment only; full gross liability remains and managed export awaits real credit reconciliation', () => {
  const config = settings(); config.offsetReconciliation = { mode: 'clearing', accountNumber: 1680 };
  const accounting = freeze({ settings: config, rows: [row('standard_25')], offset: 250 });
  assert.equal(accounting.gross, 1250); assert.equal(accounting.offset, 250); assert.equal(accounting.net, 1000);
  assert.deepEqual(accountingExportEligibility(accounting), { eligible: false, issues: [{ code: 'accounting_offset_reconciliation', message: 'Kvittning behöver kopplas till kreditunderlag i Spiris före automatisk överföring.' }] });
  const result = draft(accounting); assert.equal(result.TotalAmount, 1250); assert.equal(result.Rows.at(-1).CreditAmount, 1250); assert.equal(balance(result.Rows), 0); assert.equal(result.Rows.some(item => item.AccountNumber === 1680), false);
  assert.equal(freeze({ offset: 1000 }).net, 0); assert.throws(() => freeze({ offset: 1000.01 }), isCode('accounting_offset_invalid'));
});

test('terms inherit or override as calendar days and dates use Stockholm across midnight, DST, leap day and year end', () => {
  assert.equal(stockholmInvoiceDate('2026-10-10T22:30:00Z'), '2026-10-11');
  assert.equal(stockholmInvoiceDate('2026-03-28T23:30:00Z'), '2026-03-29');
  assert.equal(addCalendarDays('2028-02-28', 1), '2028-02-29'); assert.equal(addCalendarDays('2028-02-28', 2), '2028-03-01'); assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
  assert.equal(draft(freeze()).DueDate, '2026-10-11'); assert.equal(draft(freeze({ customer: customer({ paymentTermDays: 0 }), settings: { ...settings(), paymentTermDays: 30 } })).DueDate, '2026-10-11');
  assert.throws(() => addCalendarDays('2026-02-30', 0), isCode('accounting_attest_date_invalid'));
  assert.throws(() => stockholmInvoiceDate('2026-10-11'), isCode('accounting_attest_date_invalid'));
  for (const days of [-1, 3651, 0.5]) assert.throws(() => freeze({ customer: customer({ paymentTermDays: days }) }), isCode('accounting_payment_terms_invalid'));
  const noTerms = settings(); delete noTerms.paymentTermsId; assert.equal(freeze({ settings: noTerms }).exportEligibility.eligible, false);
});

test('expanded VAT rows honor provider limit without collapsing mixed material classification', () => {
  const rows = Array.from({ length: 34 }, (_, index) => row('scrap_reverse', 1, { articleId: `article-${index}` }));
  const accounting = freeze({ rows }); assert.equal(accounting.exportEligibility.eligible, false);
  assert.throws(() => draft(accounting), isCode('accounting_too_many_rows'));
  const valid = freeze({ rows: rows.slice(0, 33) }); assert.equal(draft(valid).Rows.length, 100); assert.equal(valid.exportEligibility.eligible, true);
});

test('tampered totals cannot become a draft and the UI sample uses the real accounting engine', () => {
  const altered = structuredClone(freeze()); altered.invoiceTotalCents++;
  assert.throws(() => draft(altered), isCode('accounting_totals_invalid'));
  for (const patch of [{ reverseVatCents: 1 }, { projectId: 'project-name' }, { sellerVatRateBps: 2500 }]) {
    const corrupted = structuredClone(freeze()); Object.assign(corrupted.lines[0], patch);
    assert.equal(accountingExportEligibility(corrupted).eligible, false);
    assert.throws(() => draft(corrupted), error => error instanceof AccountingError);
  }
  assert.throws(() => freeze({ rows: [row('no_vat', 100, { amountCents: 9999 })] }), isCode('accounting_totals_invalid'));
  assert.throws(() => freeze({ offset: 100, offsetCents: 9999 }), isCode('accounting_totals_invalid'));
  assert.throws(() => freeze({ customer: customer({ type: 'Privatperson' }), rows: [row('no_vat', undefined, { amountCents: Number.MAX_SAFE_INTEGER, amount: undefined })] }), isCode('accounting_amount_invalid'));
  const preview = previewAccountingExample({ settings: settings(), siteId: 'yard-1', example: 'standard_25', amount: 1000, date: '2026-12-31' });
  assert.equal(preview.accounting.gross, 1250); assert.equal(preview.draft.InvoiceDate, '2026-12-31'); assert.equal(balance(preview.rows), 0);
});
