import { randomUUID } from 'node:crypto';
import { addSpirisEvent, initialTracking, publicSpirisEvents, observeSpirisDraft, trackingInterval } from './visma-tracking.mjs';
import { z } from 'zod';
import { customerIdentifierError, customerIdentityKey, normalizeOrganisationNumber } from '../dist-server/domain-models.mjs';
import { EnvironmentError } from './environment-storage.mjs';
import { readSpirisInvoiceBalance } from './visma-invoice-balance.mjs';
import { latestAttestedVismaCards } from './visma-weightcard.mjs';
import { normalizeAccountingSettings as normalize, accountingExportEligibility, buildAccountingDraft as buildDraft, previewAccountingExample as examplePreview,
  AccountingError, moneyToCents, calculateMaterialBaseCents } from './visma-accounting.mjs';

const LEASE = 120000, RECONCILE_INTERVAL = 5 * 60 * 1000;
const clone = value => structuredClone(value);
const fail = (message, status = 409, code = 'visma_export_invalid') => { throw new EnvironmentError(message, status, code); };
const uuid = value => z.string().uuid().safeParse(value).success;
const ref = approval => ({ cardId: approval.cardId, approvalId: approval.id, version: approval.version, hash: approval.snapshot.hash });
const key = (companyId, source) => `${companyId}:${source.cardId}:${source.approvalId}:${source.version}:${source.hash}`;
const mappingKey = (companyId, customerId) => JSON.stringify([companyId, String(customerId)]);
const initial = () => ({ settings: {}, settingsHistory: {}, choices: {}, mappings: {}, outbox: [] });
function normalizedChoices(value) {
  if (!value) return null;
  const choices = clone(value);
  // Spiris expresses VatRate as a fraction (0.25), while accounting/UI use
  // percent (25). Older caches stored the provider value without a unit. The
  // explicit marker keeps an already normalized 1 percent from becoming 100.
  if (choices.vatRateUnit !== 'percent') choices.vatCodes = choices.vatCodes.map(code => ({ ...code,
    rate: typeof code.rate === 'number' && Number.isFinite(code.rate) && code.rate >= 0 && code.rate <= 1
      ? Math.round(code.rate * 100 * 1e8) / 1e8 : code.rate }));
  choices.vatRateUnit = 'percent'; return choices;
}
const defaultSettings = companyId => ({ revision: 0, enabled: false, exportMode: 'manual', companyId: companyId ?? '', sandbox: true,
  paymentTermDays: 0, trackingMaxDays: 30, accounts: {}, vatCodes: {}, sites: [] });
const cleanText = (value, max = 100) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function organisationNumber(value, type = 'Företag') {
  if (typeof value !== 'string') return null;
  // An enskild firma has the owner's valid ten-digit personal identifier as
  // its business identifier. Private sellers never receive a CIN at all.
  const normalized = normalizeOrganisationNumber(value);
  const candidate = /^16\d{10}$/.test(normalized) ? normalized.slice(2) : value;
  return customerIdentifierError(type, candidate) ? null : customerIdentityKey(type, candidate);
}
function safeSupplierNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 16 || !/^[A-Za-z0-9._-]+$/.test(value)) fail('Kundnumret kan inte användas som ett exakt och säkert Spiris-leverantörsnummer.', 409, 'visma_supplier_number_invalid');
  const digits = value.replace(/[-.]/g, '');
  if (/^\d{10}$/.test(digits) && Number(digits[2]) <= 1 || /^(?:19|20)\d{10}$/.test(digits))
    fail('Personnummer får inte användas som Spiris-leverantörsnummer.', 409, 'visma_supplier_number_invalid');
  return value;
}
const exportInput = z.object({ cardId: z.number().int().positive().safe(), source: z.object({ cardId: z.number().int().positive().safe(),
  approvalId: z.string().uuid(), version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict();
const publicExport = job => ({ ...Object.fromEntries(['id', 'source', 'companyId', 'customerId', 'status', 'stage', 'createdAt', 'updatedAt',
  'finishedAt', 'supplierId', 'draftId', 'error', 'settingsRevision', 'trigger', 'tracking', 'booking', 'environment', 'recreatedFrom', 'attemptNumber'].filter(name => job[name] !== undefined).map(name => [name, clone(job[name])])),
  events: publicSpirisEvents(job),
  runs: { ...(job.supplierRequestReserved ? { supplierRequestId: job.runs.supplierRequestId } : {}),
    ...(job.draftRequestReserved ? { draftRequestId: job.runs.draftRequestId } : {}) } });
const accountingCall = (operation, ...args) => { try { return operation(...args); } catch (error) { if (error instanceof AccountingError) throw new EnvironmentError(error.message, error.status, error.code); throw error; } };
const normalizeAccountingSettings = (...args) => accountingCall(normalize, ...args);
const buildAccountingDraft = input => accountingCall(buildDraft, input);
const previewAccountingExample = input => accountingCall(examplePreview, input);
function spirisAmountError(value, field, message, status = 409, code = 'accounting_amount_invalid') {
  const error = new EnvironmentError(`Spiris-fältet ${field}: ${message}`, status, code);
  // Name the failing field without persisting provider values or invoice data.
  error.details = { provider: 'spiris', field, valueType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value };
  return error;
}
function spirisMoneyToCents(value, field) {
  try { return moneyToCents(value); } catch (error) {
    if (error instanceof AccountingError && error.code === 'accounting_amount_invalid')
      throw spirisAmountError(value, field, error.message, error.status, error.code);
    throw error;
  }
}

// An unchanged total is insufficient: a human could have edited accounts or
// dimensions in the draft. Convert only the exact frozen accounting rows.
export function verifySpirisBookingRecord(record, job, booked = false) {
  const expected = job.draft;
  if (!record || record.Id !== (booked ? job.tracking?.invoiceId ?? record.Id : job.draftId) || !uuid(record.Id)
    || record.SupplierId !== job.supplierId || record.InvoiceNumber !== expected.InvoiceNumber
    || record.CurrencyCode !== expected.CurrencyCode || spirisMoneyToCents(record.TotalAmount, 'TotalAmount') !== moneyToCents(expected.TotalAmount)
    || record.IsCreditInvoice !== expected.IsCreditInvoice || record.SkipSendToBank !== true
    || typeof record.InvoiceDate !== 'string' || record.InvoiceDate.slice(0, 10) !== expected.InvoiceDate.slice(0, 10)
    || typeof record.DueDate !== 'string' || record.DueDate.slice(0, 10) !== expected.DueDate.slice(0, 10)
    || !Array.isArray(record.Rows) || record.Rows.length !== expected.Rows.length)
    fail('Spiris-underlaget har ändrats jämfört med den attesterade avräkningen. Granska det före bokföring eller utbetalning.', 409, 'visma_booking_identity_conflict');
  for (const field of ['Vat', 'VatHigh', 'VatMedium', 'VatLow']) {
    if (spirisMoneyToCents(record[field] ?? 0, field) !== moneyToCents(expected[field] ?? 0)) fail('Momsen i Spiris stämmer inte med den låsta avräkningen.', 409, 'visma_booking_identity_conflict');
  }
  const projectRow = (row, index, provider = false) => ({ account: row.AccountNumber,
    debit: provider ? spirisMoneyToCents(row.DebitAmount ?? row.DebetAmount ?? 0, `Rows[${index}].${row.DebitAmount != null ? 'DebitAmount' : 'DebetAmount'}`)
      : moneyToCents(row.DebitAmount ?? row.DebetAmount ?? 0),
    credit: provider ? spirisMoneyToCents(row.CreditAmount ?? 0, `Rows[${index}].CreditAmount`) : moneyToCents(row.CreditAmount ?? 0),
    ...Object.fromEntries(['VatCodeId', 'CostCenterItemId1', 'CostCenterItemId2', 'CostCenterItemId3', 'ProjectId'].map(field => [field, row[field] || null])) });
  const actualRows = record.Rows.map((row, index) => projectRow(row, index, true)).map(row => JSON.stringify(row)).sort();
  const expectedRows = expected.Rows.map((row, index) => projectRow(row, index)).map(row => JSON.stringify(row)).sort();
  if (JSON.stringify(actualRows) !== JSON.stringify(expectedRows)) fail('Konton eller konteringsrader i Spiris stämmer inte med den låsta avräkningen.', 409, 'visma_booking_identity_conflict');
  if (booked && (record.CreatedFromDraftId !== job.draftId || record.Status !== 1 || !uuid(record.VoucherId)
    || typeof record.VoucherNumber !== 'string' || !record.VoucherNumber.trim()))
    fail('Spiris har inte bekräftat en bokförd faktura med verifikation från detta utkast.', 409, 'visma_booking_unverified');
  return record;
}

// This module gets a private transport capability from the OAuth service. A
// worker never manufactures a Systemadmin principal or accepts one from HTTP.
export function createVismaExports({ organisationId = 'jeroc-demo', readTenantProjection, queryExports, connectionPaths, connectionFrom, transact, tenantFor, scoped, audit, clock, config, connection,
  sourceProvider, sitesProvider, authorizeContext, authorizeBookingContext, send, lookupBatch, readbackBatch, bookingBatch }) {
  const financeFor = (tenant, create = false) => {
    if (!create) return { ...initial(), ...tenant.finance };
    const finance = tenant.finance ??= {};
    for (const [name, value] of Object.entries(initial())) finance[name] ??= value;
    return finance;
  };
  const readFinanceProjection = (operation, paths) => readTenantProjection(tenant => operation(financeFor(tenant)), paths.map(path => ['finance', ...path]));
  const mutate = (operation, finance = false) => transact(state => { const tenant = tenantFor(state, organisationId, true); return operation(financeFor(tenant, true), tenant); }, { organisationId: organisationId, finance });
  const exportJobs = options => queryExports({ organisationId: organisationId, ...options });
  const readJob = async id => (await exportJobs({ id, limit: 1 }))[0] ?? null;
  const companyId = () => config().expectedCompanyId;
  const currentSettings = () => readFinanceProjection(finance => clone(finance.settings[companyId()] ?? defaultSettings(companyId())), [['settings', companyId() ?? '']]);
  const currentChoices = () => readFinanceProjection(finance => normalizedChoices(finance.choices[companyId()] ?? null), [['choices', companyId() ?? '']]);
  const authorize = async context => { scoped(context); await authorizeContext(context); };
  async function sites() {
    const values = await sitesProvider();
    return (Array.isArray(values) ? values : values?.sites ?? []).map(site => ({ id: String(site.id), name: cleanText(site.name ?? site.label ?? site.id) }));
  }
  async function dto() {
    // Connection, configuration and cached choices must describe one database
    // snapshot. Reading the whole integration document three times also copied
    // every historical response and export, even for this small settings page.
    const [snapshot, actualSites] = await Promise.all([
      readTenantProjection(tenant => {
        const finance = financeFor(tenant);
        return { settings: clone(finance.settings[companyId()] ?? defaultSettings(companyId())),
          choices: normalizedChoices(finance.choices[companyId()] ?? null), connected: connectionFrom(tenant) };
      }, [...connectionPaths, ['finance', 'settings', companyId() ?? ''], ['finance', 'choices', companyId() ?? '']]),
      sites(),
    ]);
    const { settings, connected, choices } = snapshot;
    const suggested = choices?.paymentTerms.filter(term => term.availableForPurchase && term.days === 0) ?? [];
    return { settings, ...connected, sites: actualSites, choices, capabilities: { canConfigure: true,
      canExport: Boolean(settings.enabled && connected.companyVerified), automationEnabled: Boolean(settings.enabled && settings.exportMode === 'after_attest') },
      issues: [...(!companyId() ? [organisationId === 'jeroc-demo'
        ? 'Sandboxföretaget behöver låsas med VISMA_SANDBOX_COMPANY_ID.' : 'Anslut företagets eget Spiris-sandboxföretag.'] : []),
        ...(!connected.companyVerified ? ['Anslut och verifiera sandboxföretaget innan överföring.'] : [])],
      ...(suggested.length === 1 ? { suggestedPaymentTermsId: suggested[0].id } : {}) };
  }
  async function list(operation, parameters, context, worker = false, scopeKey, sendLookup) {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const requestId = randomUUID(), request = { operation, requestId, idempotencyKey: requestId,
        parameters: { ...parameters, page, pageSize: sendLookup ? 1000 : 100 } };
      const run = await (sendLookup ? sendLookup(request) : send(request, context, worker, scopeKey));
      if (run.status !== 'accepted') fail(run.error?.message ?? 'Spiris uppgifter kunde inte hämtas.', 409, run.error?.code ?? 'visma_lookup_failed');
      const body = run.response, data = body?.Data;
      if (!body || Array.isArray(body) || !Array.isArray(data) || data.some(item => !item || typeof item !== 'object' || Array.isArray(item)) ||
        operation === 'suppliers' && data.some(item => !uuid(item.Id))) fail('Spiris gav inte en verifierbar resultatlista.', 502, 'visma_lookup_incomplete');
      result.push(...data);
      const pages = body.Meta?.TotalNumberOfPages;
      if (!Number.isInteger(pages) || pages < 0 || pages > 100 || body.Meta.CurrentPage !== page ||
        !Number.isInteger(body.Meta.TotalNumberOfResults) || body.Meta.TotalNumberOfResults < 0) fail('Spiris sidindelning kan inte verifieras.', 502, 'visma_lookup_incomplete');
      if (pages <= page) {
        if (body.Meta.TotalNumberOfResults !== result.length)
          fail('Alla Spiris poster kunde inte hämtas.', 502, 'visma_lookup_incomplete');
        return result;
      }
    }
    fail('Spiris resultatlista överstiger testkopplingens gräns.', 502, 'visma_lookup_incomplete');
  }
  function verifySelections(settings, choices, actualSites) {
    if (!settings.enabled) return;
    if (!choices || choices.companyId !== settings.companyId) fail('Hämta företagets kontoplan och val från Spiris innan inställningarna aktiveras.', 409, 'visma_choices_required');
    const term = choices.paymentTerms.find(item => item.id === settings.paymentTermsId);
    if (!term?.availableForPurchase || term.days !== settings.paymentTermDays) fail('Betalningsvillkoret måste finnas för inköp och stämma med antalet dagar.', 422, 'visma_terms_invalid');
    const numbers = new Set(choices.accounts.filter(account => account.active).map(account => account.number));
    const codes = new Set(choices.vatCodes.map(code => code.id));
    const projectIds = new Set(choices.projects.filter(item => item.status === 1).map(item => item.id));
    const dimensionIds = new Set(choices.costCenters.filter(center => center.number === 1 && center.active).flatMap(center => center.items.filter(item => item.active).map(item => item.id)));
    const siteIds = new Set(actualSites.map(site => site.id));
    const selectedAccounts = [...Object.values(settings.accounts), ...settings.sites.flatMap(site => Object.values(site.accountOverrides ?? {})),
      ...(settings.offsetReconciliation?.accountNumber ? [settings.offsetReconciliation.accountNumber] : [])];
    if (selectedAccounts.some(number => !numbers.has(number))) fail('Alla valda konton måste finnas och vara aktiva i företagets kontoplan.', 422, 'visma_account_invalid');
    if (Object.values(settings.vatCodes ?? {}).some(id => !codes.has(id))) fail('En vald momskod finns inte hos företaget.', 422, 'visma_vat_invalid');
    for (const [treatment, id] of Object.entries(settings.vatCodes ?? {})) {
      const rate = choices.vatCodes.find(code => code.id === id)?.rate, expected = ['reverse25', 'standard25'].includes(treatment) ? 25 : 0;
      if (typeof rate !== 'number' || rate !== expected) fail('Momskodens verkliga procentsats stämmer inte med den valda momsregeln.', 422, 'visma_vat_invalid');
    }
    for (const site of settings.sites) {
      if (!siteIds.has(site.siteId)) fail('Anläggningskopplingen finns inte i JEROC.', 422, 'site_forbidden');
      if (site.costCenterId && !dimensionIds.has(site.costCenterId)) fail('Välj en aktiv post i Spiris första resultatenhet.', 422, 'visma_dimension_invalid');
      if (site.projectId && !projectIds.has(site.projectId)) fail('Välj ett pågående Spiris-projekt.', 422, 'visma_project_invalid');
    }
  }
  function verifyDraftAccounts(draft, accounts, normalized = false) {
    for (const row of draft.Rows) {
      const account = accounts.find(item => Number(normalized ? item.number : item.Number) === row.AccountNumber);
      const active = normalized ? account?.active : account?.IsActive;
      const blocked = normalized ? account?.blockedForManualBooking : account?.IsBlockedForManualBooking;
      const mandatoryCenter = normalized ? account?.firstCostCenterMandatory : account?.IsFirstCostCenterMandatory;
      const centerAllowed = normalized ? account?.costCenterAllowed : account?.IsCostCenterAllowed;
      const projectAllowed = normalized ? account?.projectAllowed : account?.IsProjectAllowed;
      if (!account || active === false || blocked) fail(`Kontot ${row.AccountNumber} kan inte användas i fakturans räkenskapsår.`, 422, 'visma_account_invalid');
      if (mandatoryCenter && !row.CostCenterItemId1) fail(`Kontot ${row.AccountNumber} kräver en post i första resultatenheten.`, 422, 'visma_dimension_required');
      if (row.CostCenterItemId1 && centerAllowed === false || row.ProjectId && projectAllowed === false)
        fail(`Kontot ${row.AccountNumber} tillåter inte de valda dimensionerna.`, 422, 'visma_dimension_invalid');
    }
  }
  async function findApproval(cardId) {
    const approval = latestAttestedVismaCards(await sourceProvider({ cardId })).find(item => String(item.cardId) === String(cardId));
    if (!approval) fail('Kortets aktuella version måste vara kundgodkänd och internt attesterad.', 409, 'visma_source_unattested');
    return approval;
  }
  function prepare(approval) {
    const snapshot = approval.snapshot, customer = snapshot.customer;
    const accounting = snapshot.accounting ?? snapshot.card?.accounting;
    if (!accounting) fail('Kortet saknar låst och kontrollerad ekonomikonfiguration. Äldre kort kan endast användas i det manuella sandboxformuläret.', 409, 'visma_accounting_legacy');
    if (snapshot.accounting && snapshot.card?.accounting && JSON.stringify(snapshot.accounting) !== JSON.stringify(snapshot.card.accounting))
      fail('Kortets låsta ekonomiuppgifter motsäger varandra.', 409, 'visma_source_incomplete');
    const eligibility = accountingExportEligibility(accounting);
    if (!eligibility.eligible) fail(eligibility.issues.map(issue => typeof issue === 'string' ? issue : issue.message).join(' '), 409, 'visma_accounting_blocked');
    if (accounting.companyId !== companyId()) fail('Kortets låsta ekonomi tillhör ett annat Spiris-företag.', 409, 'visma_company_mismatch');
    if (!customer?.id || !customer.name || !snapshot.rows?.length || !uuid(accounting.paymentTermsId)) fail('Kortets låsta kund- eller betalningsuppgifter är ofullständiga.', 409, 'visma_source_incomplete');
    if (String(snapshot.card?.id) !== String(approval.cardId) || customer.type !== accounting.customer?.type ||
      customer.type !== 'Privatperson' && customer.vatRegistered !== accounting.customer?.vatRegistered ||
      snapshot.rows.length !== accounting.lines?.length ||
      ['gross', 'offset', 'net'].some(name => !Number.isFinite(snapshot[name]) || moneyToCents(snapshot[name]) !== moneyToCents(accounting[name])))
      fail('Den kundgodkända avräkningen stämmer inte med sitt låsta bokföringsunderlag.', 409, 'visma_source_incomplete');
    for (let index = 0; index < snapshot.rows.length; index++) {
      const row = snapshot.rows[index], line = accounting.lines[index];
      if (!Number.isFinite(row.weight) || row.weight <= 0 || !Number.isFinite(row.price) || row.price < 0 || !Number.isFinite(row.amount) || row.amount < 0 ||
        !['scrap_reverse', 'standard_25', 'no_vat'].includes(line.taxCategory) || row.taxCategory !== undefined && row.taxCategory !== line.taxCategory ||
        row.articleId !== line.articleId || calculateMaterialBaseCents(row) !== line.baseCents || moneyToCents(row.amount) !== line.baseCents ||
        line.weight !== undefined && line.weight !== row.weight || line.price !== undefined && line.price !== row.price)
        fail('Materialraderna stämmer inte med den låsta konteringen.', 409, 'visma_source_incomplete');
    }
    const supplier = { Name: cleanText(customer.name, 50), TermsOfPaymentId: accounting.paymentTermsId, CountryCode: 'SE', CurrencyCode: 'SEK', IsActive: true,
      UsesAutomaticSupplierInvoiceApproval: false, UsesAutomaticInvoicePostToLedger: false };
    const add = (name, value, max) => { const parsed = cleanText(value, max); if (parsed) supplier[name] = parsed; };
    const supplierNumber = safeSupplierNumber(customer.customerNumber); if (supplierNumber) supplier.SupplierNumber = supplierNumber;
    const privateSeller = customer.type === 'Privatperson';
    if (!privateSeller) {
      const identifier = organisationNumber(customer.number, customer.type);
      if (!identifier) fail('Företagets organisationsnummer behöver granskas före Spiris-koppling.', 409, 'visma_supplier_identity_invalid');
      supplier.CorporateIdentityNumber = identifier;
    }
    const address = cleanText(customer.address, 300), embedded = address.match(/^(.+?)[,\s]+(\d{3}\s?\d{2})\s+([^,]+)$/);
    add('Address1', embedded ? embedded[1] : address, 50); add('PostalCode', customer.postalCode || embedded?.[2], 10); add('City', customer.city || embedded?.[3], 50);
    add('EmailAddress', customer.email, 255); add('Telephone', customer.phone, 50); add('ContactPersonName', customer.contactPerson, 50);
    const payment = snapshot.card.paymentDetails ?? customer.paymentProfile;
    if (snapshot.paymentMethod === 'bank' && payment?.method === 'bank') {
      add('Clearing', payment.clearing?.replace(/\D/g, ''), 5); add('BankAccountNumber', payment.account?.replace(/[\s-]/g, ''), 50); add('BankName', payment.bank, 50); supplier.BankCountryCode = 'SE';
    }
    const invoiceNumber = `AV-${approval.cardId}-V${approval.version}`;
    const draft = buildAccountingDraft({ accounting, attestedAt: approval.attestedAt, invoiceNumber });
    return { source: ref(approval), accounting: clone(accounting), customerId: String(customer.id), privateSeller, supplier, draft,
      companyId: accounting.companyId, settingsRevision: accounting.settingsRevision ?? accounting.settingsVersion ?? accounting.revision };
  }
  async function assertFrozenAuthorization(prepared) {
    const original = await readFinanceProjection(finance => finance.settingsHistory?.[prepared.companyId]?.[prepared.settingsRevision], [['settingsHistory', prepared.companyId, String(prepared.settingsRevision)]]);
    if (!original?.enabled || !original.enabledBy?.actualUserId || original.companyId !== prepared.companyId || original.exportMode !== prepared.accounting.exportMode)
      fail('Den låsta ekonomiversionen saknar en sparad aktivering av systemadmin för detta sandboxföretag.', 409, 'visma_accounting_config_unknown');
  }
  async function preview(input, context) {
    await authorize(context);
    if (input && Object.hasOwn(input, 'cardId')) {
      const parsed = exportInput.safeParse(input); if (!parsed.success) fail('Välj ett giltigt viktkort.', 422);
      const approval = await findApproval(parsed.data.cardId);
      try {
        const prepared = prepare(approval); await assertFrozenAuthorization(prepared);
        const mapping = await readFinanceProjection(finance => clone(finance.mappings[mappingKey(prepared.companyId, prepared.customerId)] ?? null), [['mappings', mappingKey(prepared.companyId, prepared.customerId)]]);
        return { ...prepared, eligible: true, issues: [], mapping: mapping?.supplierId ? { supplierId: mapping.supplierId } : null,
          export: await exportJobs({ companyId: prepared.companyId, key: key(prepared.companyId, prepared.source), limit: 1 }).then(jobs => jobs[0] ? publicExport(jobs[0]) : null) };
      } catch (error) { if (!(error instanceof EnvironmentError)) throw error; return { source: ref(approval), eligible: false, issues: [error.message], code: error.code }; }
    }
    if (!input || typeof input !== 'object' || Object.keys(input).some(name => !['settings', 'siteId', 'example', 'amount', 'date'].includes(name))) fail('Förhandsvisningens uppgifter är inte giltiga.', 422);
    const provided = input.settings ?? await currentSettings();
    const settings = normalizeAccountingSettings({ ...provided, revision: Math.max(1, provided.revision ?? 1) }, { companyId: companyId(), sandbox: true });
    const [choices, actualSites] = await Promise.all([currentChoices(), sites()]);
    verifySelections({ ...settings, enabled: true }, choices, actualSites);
    const preview = previewAccountingExample({ ...input, settings }), date = preview.draft.InvoiceDate;
    const years = choices.fiscalYears.filter(year => year.startDate.slice(0, 10) <= date && year.endDate.slice(0, 10) >= date);
    if (years.length !== 1 || years[0].locked) fail('Exemplet behöver ett öppet räkenskapsår i de hämtade Spiris-valen.', 422, 'visma_fiscal_year_invalid');
    verifyDraftAccounts(preview.draft, choices.accounts.filter(account => account.fiscalYearId === years[0].id), true);
    return { ...preview, eligible: preview.issues.length === 0 };
  }
  async function enqueue(input, context, worker = false, approvalSnapshot) {
    if (!worker) await authorize(context); else await assertWorkerAuthorization(context);
    const parsed = exportInput.safeParse(input); if (!parsed.success) fail('Välj ett giltigt viktkort.', 422);
    const approval = approvalSnapshot ?? await findApproval(parsed.data.cardId), prepared = prepare(approval);
    await assertFrozenAuthorization(prepared);
    if (parsed.data.source && Object.keys(prepared.source).some(name => parsed.data.source[name] !== prepared.source[name])) fail('Attestversionen har ändrats. Hämta uppgifterna igen.', 409, 'visma_source_changed');
    const settings = await currentSettings();
    if (!settings.enabled) fail('Spiris-överföring är inte aktiverad i ekonomiinställningarna.', 409, 'visma_export_disabled');
    const connected = await connection(); if (!connected.companyVerified) fail('Anslut och verifiera sandboxföretaget först.', 409, 'visma_company_unverified');
    return mutate((finance, tenant) => {
      const prior = finance.outbox.find(job => job.key === key(prepared.companyId, prepared.source));
      if (prior) return publicExport(prior);
      const timestamp = clock().toISOString(), job = { ...prepared, id: randomUUID(), key: key(prepared.companyId, prepared.source), status: 'queued', stage: 'supplier',
        trackingMaxDays: settings.trackingMaxDays ?? 30, connectionGeneration: connected.generation,
        ...(approval.spirisAction === 'book' ? { booking: {
          status: 'queued', requestId: randomUUID(), requestedAt: timestamp,
          requestedBy: clone(approval.bookingRequestedBy ?? {}), scope: clone(approval.bookingConnection ?? {}), source: clone(prepared.source), automatic: true,
        } } : {}),
        environment: 'sandbox', attemptNumber: 1, trigger: worker ? 'after_attest' : 'manual', createdAt: timestamp, updatedAt: timestamp, actualUserId: context.actorId, effectiveUserId: context.effectiveUserId,
        authorization: { kind: worker ? 'after_attest' : 'manual', actualUserId: context.actorId, effectiveUserId: context.effectiveUserId,
          at: timestamp, configRevision: settings.revision, companyId: settings.companyId },
        attestActorId: approval.attestedById ?? approval.attestedBy ?? null, runs: { supplierRequestId: randomUUID(), draftRequestId: randomUUID() },
        events: [] };
      addSpirisEvent(job, 'queued', timestamp, worker ? 'Spiris-arbetare' : context.actorId);
      finance.outbox.push(job); audit(tenant, context, 'visma.export_queued', { exportId: job.id, source: job.source, trigger: job.trigger, settingsRevision: job.settingsRevision, attestActorId: job.attestActorId });
      return publicExport(job);
    }, { outbox: { key: key(prepared.companyId, prepared.source) } });
  }
  async function assertWorkerAuthorization(context) {
    if (context?.organisationId !== organisationId || context.actorId !== 'service:spiris-export') fail('Ogiltig arbetarbehörighet.', 403, 'forbidden');
    const settings = await currentSettings();
    if (!config().configured || !settings.enabled || !settings.enabledBy?.actualUserId || settings.companyId !== companyId())
      fail('Automatisk överföring måste aktiveras av systemadmin för det låsta sandboxföretaget.', 409, 'visma_automation_disabled');
    if (settings.exportMode !== 'after_attest') {
      const job = context.exportId ? await readJob(context.exportId) : null;
      if (job?.trigger !== 'manual' || job.authorization?.kind !== 'manual' || !job.authorization.actualUserId || !job.authorization.effectiveUserId || job.authorization.companyId !== companyId())
        fail('Automatisk upptäckt av attestversioner är inte aktiverad.', 409, 'visma_automation_disabled');
    }
  }
  async function assertExportAuthorization(context, worker, id) {
    if (worker) await assertWorkerAuthorization(context); else await authorize(context);
    const settings = await currentSettings();
    if (!settings.enabled || settings.companyId !== companyId()) fail('Spiris-överföring har stängts av.', 409, 'visma_export_disabled');
    if (id) {
      const job = await readJob(id);
      if (!job || job.companyId !== companyId()) fail('Överföringen tillhör ett annat Spiris-företag.', 409, 'visma_company_mismatch');
    }
  }
  async function updateJob(id, owner, operation, relatedMappingKey) {
    return mutate((finance, tenant) => { const job = finance.outbox.find(item => item.id === id);
      if (!job || job.lease?.id !== owner) fail('Överföringen hanteras av en annan arbetare.', 409, 'visma_export_busy');
      operation(job, finance, tenant); job.updatedAt = clock().toISOString(); return publicExport(job); }, { outbox: { id }, mappingKeys: relatedMappingKey ? [relatedMappingKey] : [] });
  }
  async function process(id, context, worker = false) {
    await assertExportAuthorization(context, worker, id);
    const current = await readJob(id);
    if (!current) fail('Överföringen finns inte.', 404, 'not_found');
    const relatedMappingKey = mappingKey(current.companyId, current.customerId);
    const reservation = await mutate(finance => {
      const job = finance.outbox.find(item => item.id === id); if (!job) fail('Överföringen finns inte.', 404, 'not_found');
      if (['accepted', 'rejected', 'unknown', 'blocked'].includes(job.status)) return { prior: publicExport(job) };
      if (job.lease && Date.parse(job.lease.until) > clock().getTime()) return { prior: publicExport(job) };
      const map = finance.mappings[mappingKey(job.companyId, job.customerId)];
      if (map?.lease && map.lease.jobId !== job.id && Date.parse(map.lease.until) > clock().getTime()) return { prior: publicExport(job) };
      const owner = randomUUID(), until = new Date(clock().getTime() + LEASE).toISOString();
      job.lease = { id: owner, until }; job.status = 'processing';
      if (!job.events.some(event => event.type === 'started')) addSpirisEvent(job, 'started', clock().toISOString(), worker ? 'Spiris-arbetare' : context.actorId);
      const mapping = finance.mappings[mappingKey(job.companyId, job.customerId)] ??= { companyId: job.companyId, customerId: job.customerId };
      mapping.lease = { jobId: job.id, until }; return { job: clone(job), mapping: clone(mapping), owner };
    }, { outbox: { id }, mappingKeys: [relatedMappingKey] });
    if (reservation.prior) return reservation.prior;
    let { job, mapping } = reservation; const owner = reservation.owner;
    const update = operation => updateJob(job.id, owner, operation, relatedMappingKey);
    const event = (entry, text, type) => type
      ? addSpirisEvent(entry, type, clock().toISOString(), worker ? 'Spiris-arbetare' : context.actorId, text)
      : entry.events.push({ id: randomUUID(), at: clock().toISOString(), text, actor: worker ? 'Spiris-arbetare' : context.actorId });
    try {
      const approval = await findApproval(job.source.cardId), prepared = prepare(approval);
      await assertFrozenAuthorization(prepared);
      if (key(job.companyId, prepared.source) !== (job.sourceKey ?? job.key)) fail('Kortets attestversion har ändrats.', 409, 'visma_source_changed');
      const terms = await list('paymentTerms', {}, context, worker, job.id);
      const term = terms.find(item => item.Id === job.accounting.paymentTermsId);
      if (!term || term.AvailableForPurchase !== true || term.NumberOfDays !== job.accounting.customer.paymentTermDays)
        fail('Det låsta betalningsvillkoret motsvarar inte längre kundens godkända antal dagar i Spiris.', 409, 'visma_terms_invalid');
      if (!mapping.supplierId) {
        if (mapping.status === 'unknown' || mapping.status === 'rejected') fail('Leverantörsförsöket behöver kontrolleras i Spiris innan fler underlag kan skapas.', 409, 'visma_supplier_review');
        if (!mapping.createRequest) {
          const suppliers = await list('suppliers', {}, context, worker, job.id);
          const exact = job.supplier.SupplierNumber ? suppliers.filter(item => item.SupplierNumber === job.supplier.SupplierNumber) : [];
          if (exact.length > 1) fail('Flera Spiris-leverantörer har samma kundnummer. Kopplingen behöver kontrolleras.', 409, 'visma_supplier_ambiguous');
          let match = exact[0];
          if (!match && !job.privateSeller && job.supplier.CorporateIdentityNumber) {
            const organisation = job.supplier.CorporateIdentityNumber.replace(/\D/g, '');
            const candidates = suppliers.filter(item => organisationNumber(item.CorporateIdentityNumber) === organisation);
            if (candidates.length > 1) fail('Flera Spiris-leverantörer har samma organisationsnummer. Kopplingen behöver kontrolleras.', 409, 'visma_supplier_ambiguous');
            match = candidates[0];
          }
          if (match) {
            if (!uuid(match.Id) || match.IsActive === false) fail('Den matchade leverantören är inte aktiv eller saknar verifierbart ID.', 409, 'visma_supplier_invalid');
            if (!job.privateSeller && job.supplier.CorporateIdentityNumber && match.CorporateIdentityNumber &&
              organisationNumber(match.CorporateIdentityNumber) !== job.supplier.CorporateIdentityNumber)
              fail('Spiris-leverantörens organisationsnummer motsäger kundens låsta identitet.', 409, 'visma_supplier_identity_conflict');
            await update((entry, finance, tenant) => {
              const record = finance.mappings[mappingKey(job.companyId, job.customerId)]; record.supplierId = match.Id; record.status = 'accepted'; record.matchedBy = exact.length ? 'supplier_number' : 'organisation_number';
              entry.supplierId = match.Id; entry.stage = 'draft'; event(entry, 'Befintlig Spiris-leverantör kopplad.');
              audit(tenant, context, 'visma.supplier_mapped', { exportId: entry.id, customerId: entry.customerId, companyId: entry.companyId, supplierId: match.Id });
            });
            mapping.supplierId = match.Id;
          } else {
            await update((entry, finance) => {
              const record = finance.mappings[mappingKey(job.companyId, job.customerId)];
              record.createRequest = { requestId: entry.runs.supplierRequestId, source: entry.source, payload: entry.supplier, scopeKey: entry.id }; record.status = 'reserved';
            });
            mapping.createRequest = { requestId: job.runs.supplierRequestId, source: job.source, payload: job.supplier, scopeKey: job.id };
          }
        }
        if (!mapping.supplierId) {
          const request = mapping.createRequest;
          await update(entry => { entry.runs.supplierRequestId = request.requestId; entry.supplierRequestReserved = true; });
          const run = await send({ operation: 'createSupplier', requestId: request.requestId, idempotencyKey: `supplier:${request.requestId}`, payload: request.payload, source: request.source }, context, worker, request.scopeKey);
          await update((entry, finance, tenant) => {
            const record = finance.mappings[mappingKey(job.companyId, job.customerId)];
            if (run.status === 'accepted') { record.supplierId = run.resourceId; record.status = 'accepted'; entry.supplierId = run.resourceId; entry.stage = 'draft'; event(entry, 'Spiris-leverantör skapad och kopplad.'); }
            else if (run.status !== 'in_flight') { record.status = run.status; entry.status = run.status; entry.error = run.error; event(entry, run.error?.message ?? 'Leverantörsförsöket behöver kontrolleras.', run.status === 'rejected' ? 'remote_rejected' : run.status === 'unknown' ? 'response_unknown' : 'local_blocked'); }
            audit(tenant, context, `visma.export_supplier_${run.status}`, { exportId: entry.id, runId: run.id, supplierId: run.resourceId ?? null });
          });
          if (run.status !== 'accepted') return await finish(job.id, owner, relatedMappingKey);
          mapping.supplierId = run.resourceId;
        }
      }
      await update(entry => { entry.supplierId = mapping.supplierId; entry.stage = 'draft'; });
      // Validate the mapped supplier and the exact fiscal year's real accounts.
      const supplierRequestId = randomUUID();
      await update(entry => { if (!entry.supplierRequestReserved) { entry.runs.supplierRequestId = supplierRequestId; entry.supplierRequestReserved = true; } });
      const supplierRun = await send({ operation: 'supplier', requestId: supplierRequestId, idempotencyKey: supplierRequestId,
        parameters: { resourceId: mapping.supplierId } }, context, worker, job.id);
      if (supplierRun.status !== 'accepted' || supplierRun.response?.Id !== mapping.supplierId || supplierRun.response.IsActive === false)
        fail('Den kopplade Spiris-leverantören kunde inte verifieras.', 409, 'visma_supplier_invalid');
      if (job.supplier.SupplierNumber && supplierRun.response.SupplierNumber && supplierRun.response.SupplierNumber !== job.supplier.SupplierNumber)
        fail('Den kopplade leverantörens nummer motsäger kundens låsta nummer.', 409, 'visma_supplier_identity_conflict');
      if (!job.privateSeller && job.supplier.CorporateIdentityNumber && supplierRun.response.CorporateIdentityNumber &&
        organisationNumber(supplierRun.response.CorporateIdentityNumber) !== job.supplier.CorporateIdentityNumber)
        fail('Den kopplade leverantörens organisationsnummer har ändrats.', 409, 'visma_supplier_identity_conflict');
      const years = await list('fiscalYears', {}, context, worker, job.id), date = job.draft.InvoiceDate.slice(0, 10);
      const matchingYears = years.filter(year => cleanText(year.StartDate).slice(0, 10) <= date && cleanText(year.EndDate).slice(0, 10) >= date);
      if (matchingYears.length !== 1) fail('Fakturadatumets räkenskapsår är inte entydigt i Spiris.', 409, 'visma_fiscal_year_invalid');
      const fiscalYear = matchingYears[0];
      if (!fiscalYear || fiscalYear.IsLockedForAccounting || !uuid(fiscalYear.Id)) fail('Fakturadatumet saknar ett öppet räkenskapsår i Spiris.', 409, 'visma_fiscal_year_invalid');
      const accounts = await list('accounts', { fiscalYearId: fiscalYear.Id }, context, worker, job.id);
      verifyDraftAccounts(job.draft, accounts);
      // Recheck absence immediately before a recreation POST, after terms and
      // account reads. A human may have booked/restored the old draft meanwhile.
      if (job.recreatedFrom) {
        const previous = await readJob(job.recreatedFrom);
        if (!previous || previous.companyId !== job.companyId) fail('Tidigare försök saknar rätt Spiris-koppling.', 409, 'visma_recreate_invalid');
        const observed = await readbackBatch(context, sendRead => observeSpirisDraft(previous, sendRead), worker, previous.id);
        if (observed.kind !== 'missing') fail('Det tidigare underlaget finns eller är bokfört. Återskapandet stoppades.', 409, 'visma_recreate_exists');
      }
      await update(entry => { entry.draftRequestReserved = true; });
      const draftRun = await send({ operation: 'createDraft', requestId: job.runs.draftRequestId, idempotencyKey: `draft:${job.runs.draftRequestId}`,
        parameters: { useDefaultVatCodes: false, calculateVatOnCostAccounts: false }, payload: { ...job.draft, SupplierId: mapping.supplierId }, source: job.source }, context, worker, job.id);
      await update((entry, _finance, tenant) => {
        if (draftRun.status !== 'in_flight') { entry.status = draftRun.status; entry.error = draftRun.error ?? null; entry.draftId = draftRun.resourceId ?? null;
          entry.finishedAt = clock().toISOString();
          if (draftRun.status === 'accepted') { entry.tracking = initialTracking(entry, entry.trackingMaxDays ?? 30);
            if (entry.booking) entry.tracking.nextCheckAt = clock().toISOString();
            event(entry, '', entry.recreatedFrom ? 'draft_recreated' : 'draft_created'); }
          else event(entry, draftRun.error?.message ?? 'Fakturautkastets försök behöver kontrolleras.', draftRun.status === 'rejected' ? 'remote_rejected' : draftRun.status === 'unknown' ? 'response_unknown' : 'local_blocked'); }
        audit(tenant, context, `visma.export_draft_${draftRun.status}`, { exportId: entry.id, runId: draftRun.id, draftId: draftRun.resourceId ?? null });
      });
      return await finish(job.id, owner, relatedMappingKey);
    } catch (error) {
      if (!(error instanceof EnvironmentError)) error = new EnvironmentError('Överföringen avbröts. Kontrollera det sparade försöket innan fortsatt arbete.', 409, 'visma_export_interrupted');
      await update((entry, _finance, tenant) => { entry.status = 'blocked'; entry.error = { code: error.code, message: error.message }; event(entry, error.message, 'local_blocked');
        audit(tenant, context, 'visma.export_blocked', { exportId: entry.id, code: error.code }); });
      return await finish(job.id, owner, relatedMappingKey);
    }
  }
  async function finish(id, owner, relatedMappingKey) {
    return updateJob(id, owner, (job, finance) => {
      if (job.status === 'processing') job.status = 'queued';
      const mapping = finance.mappings[mappingKey(job.companyId, job.customerId)]; if (mapping?.lease?.jobId === job.id) delete mapping.lease;
      delete job.lease;
    }, relatedMappingKey);
  }
  async function recordPrequeueBlock(approval, error, context) {
    const accounting = approval.snapshot.accounting ?? approval.snapshot.card?.accounting;
    if (!accounting || accounting.companyId !== companyId() || accounting.exportMode !== 'after_attest') return;
    const original = await readFinanceProjection(finance => finance.settingsHistory?.[accounting.companyId]?.[accounting.settingsRevision ?? accounting.settingsVersion ?? accounting.revision],
      [['settingsHistory', accounting.companyId, String(accounting.settingsRevision ?? accounting.settingsVersion ?? accounting.revision)]]);
    if (!original?.enabled || !original.enabledBy?.actualUserId) return;
    const source = ref(approval), sourceKey = key(accounting.companyId, source);
    await mutate((finance, tenant) => {
      if (finance.outbox.some(job => job.key === sourceKey)) return;
      const at = clock().toISOString(), job = { id: randomUUID(), key: sourceKey, source, companyId: accounting.companyId, environment: 'sandbox',
        status: 'blocked', stage: 'validation', createdAt: at, updatedAt: at, finishedAt: at, trigger: 'after_attest', attemptNumber: 1,
        customerId: String(approval.snapshot.customer?.id ?? ''), settingsRevision: original.revision,
        error: { code: error.code, message: error.message }, events: [], runs: {} };
      addSpirisEvent(job, 'local_blocked', at, 'Spiris-arbetare', error.message); finance.outbox.push(job);
      audit(tenant, context, 'visma.export_prequeue_blocked', { exportId: job.id, source, code: error.code });
    }, { outbox: { key: sourceKey } });
  }
  async function assertTrackingAuthorization(context, id) {
    if (context?.organisationId !== organisationId || context.actorId === 'service:spiris-export' && context.effectiveUserId !== 'service:spiris-export')
      fail('Ogiltig kontrollbehörighet.', 403, 'forbidden');
    const settings = await currentSettings(), connected = await connection(), job = id ? await readJob(id) : null;
    if (!config().configured || !settings.enabled || !settings.enabledBy?.actualUserId || !connected.companyVerified)
      fail('Spiris-kontrollen är pausad. Aktivera och verifiera anslutningen till rätt företag.', 409, 'visma_tracking_paused');
    if (!job || job.status !== 'accepted' || job.companyId !== companyId() || (job.environment ?? 'sandbox') !== 'sandbox')
      fail('Kontrollen tillhör en annan koppling eller saknar ett bekräftat utkast.', 409, 'visma_company_mismatch');
  }
  async function sourceMatches(job) {
    const approval = await findApproval(job.source.cardId);
    if (key(job.companyId, ref(approval)) !== (job.sourceKey ?? job.key)) fail('Kortets attestversion har ändrats. Underlaget får inte återskapas.', 409, 'visma_source_changed');
    await assertFrozenAuthorization(prepare(approval)); return approval;
  }
  const bookingContext = booking => ({ organisationId, actorId: booking.requestedBy?.actualUserId, effectiveUserId: booking.requestedBy?.effectiveUserId });
  const bookingSite = approval => approval.snapshot?.accounting?.siteId ?? approval.snapshot?.card?.accounting?.siteId ?? approval.snapshot?.card?.siteId;
  const sameSource = (a, b) => a && b && ['cardId', 'approvalId', 'version', 'hash'].every(field => String(a[field]) === String(b[field]));
  async function bookingAuthorise(context, approval, write) {
    scoped(context, false);
    await authorizeBookingContext(context, { cardId: approval.cardId, siteId: bookingSite(approval), write });
  }
  async function checkAttestBooking(approval, context) {
    await bookingAuthorise(context, approval, true);
    const accounting = approval.snapshot?.accounting ?? approval.snapshot?.card?.accounting;
    const settings = await currentSettings(), connected = await connection();
    if (!config().configured || !connected.companyVerified || !settings.enabled || settings.exportMode !== 'after_attest'
      || !accounting || accounting.companyId !== companyId() || accounting.exportMode !== 'after_attest')
      fail('Attest och bokför kräver en verifierad Spiris-koppling med överföring efter attest för detta underlag.', 409, 'visma_booking_not_configured');
    const revision = accounting.settingsRevision ?? accounting.settingsVersion ?? accounting.revision;
    await assertFrozenAuthorization({ companyId: accounting.companyId, settingsRevision: revision, accounting });
    return { companyId: accounting.companyId, generation: connected.generation, settingsRevision: revision };
  }
  async function exactCardJob(approval) {
    const jobs = await exportJobs({ cardId: approval.cardId, statuses: ['accepted', 'queued', 'processing', 'blocked', 'rejected', 'unknown'], limit: 100 });
    return jobs.filter(job => sameSource(job.source, ref(approval)) && job.tracking?.state !== 'replaced')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (b.attemptNumber ?? 1) - (a.attemptNumber ?? 1))[0] ?? null;
  }
  async function cardBookingStatus(cardId, context) {
    if (!Number.isSafeInteger(cardId) || cardId <= 0) fail('Välj ett giltigt viktkort.', 422);
    let approval;
    try { approval = await findApproval(cardId); } catch (error) {
      if (error.code !== 'visma_source_unattested') throw error;
      scoped(context, false); await authorizeBookingContext(context, { cardId, write: false });
      return { status: 'awaiting_attest', canBook: false, canRefresh: false, reason: 'Kortet behöver attesteras före bokföring.' };
    }
    await bookingAuthorise(context, approval, false);
    const [job, settings, connected] = await Promise.all([exactCardJob(approval), currentSettings(), connection()]);
    const available = Boolean(config().configured && settings.enabled && connected.companyVerified
      && (approval.snapshot?.accounting ?? approval.snapshot?.card?.accounting)?.companyId === companyId());
    let canWrite = false;
    if (available) try { await bookingAuthorise(context, approval, true); canWrite = true; } catch (error) { if (error.status !== 403) throw error; }
    const booking = job?.booking;
    const sameConnection = job?.companyId === companyId() && (!booking || booking.scope?.generation === connected.generation && booking.scope?.companyId === companyId());
    const rawStatus = !available ? 'not_configured' : !job ? 'creating_draft' : !sameConnection ? 'paused'
      : job.status !== 'accepted' ? ['queued', 'processing'].includes(job.status) ? 'creating_draft' : 'failed'
      : job.tracking?.state === 'booked' ? 'booked' : job.tracking?.state === 'missing' ? 'missing'
      : booking?.status === 'queued' || booking?.status === 'processing' ? 'booking'
      : booking?.status === 'unknown' ? 'unknown' : booking?.status === 'paused' ? 'paused'
      : booking?.status === 'failed' ? 'failed' : 'draft';
    return { status: rawStatus, cardId, source: ref(approval), exportId: job?.id ?? null, draftId: job?.draftId ?? null,
      invoiceId: job?.tracking?.invoiceId ?? null, voucherNumber: job?.tracking?.voucherNumber ?? null,
      canBook: Boolean(canWrite && sameConnection && job?.status === 'accepted' && !booking?.postReserved && ['draft', 'failed'].includes(rawStatus)),
      canRefresh: Boolean(available && sameConnection && job?.status === 'accepted' && rawStatus !== 'booking'),
      checkedAt: booking?.checkedAt ?? job?.tracking?.lastCheckedAt ?? null,
      reason: !available ? 'Spiris-kopplingen behöver vara aktiv och verifierad före utbetalning.' : !sameConnection && job ? 'Underlaget tillhör en tidigare Spiris-koppling.'
        : booking?.error?.message ?? job?.error?.message ?? (rawStatus === 'draft' ? 'Bokför underlaget i Spiris före utbetalning.' : null),
      error: booking?.error ? clone(booking.error) : job?.error ? clone(job.error) : null };
  }
  async function requestCardBooking(input, context) {
    if (!input || Object.keys(input).some(name => name !== 'cardId') || !Number.isSafeInteger(input.cardId) || input.cardId <= 0) fail('Välj ett giltigt viktkort.', 422);
    const approval = await findApproval(input.cardId); await bookingAuthorise(context, approval, true);
    const prepared = prepare(approval); await assertFrozenAuthorization(prepared);
    const connected = await connection(), settings = await currentSettings(), job = await exactCardJob(approval);
    if (!config().configured || !connected.companyVerified || !settings.enabled || job?.companyId !== companyId() || job.status !== 'accepted')
      fail('Ett bekräftat fakturautkast i rätt Spiris-koppling krävs före bokföring.', 409, 'visma_booking_not_ready');
    await mutate((finance, tenant) => {
      const entry = finance.outbox.find(item => item.id === job.id);
      if (entry.tracking?.state === 'booked' || entry.booking?.status === 'queued' || entry.booking?.status === 'processing') return;
      if (entry.booking?.postReserved) fail('Bokföringen har redan skickats. Kontrollera det befintliga underlaget; det skickas inte igen.', 409, 'visma_booking_unknown');
      entry.booking = { status: 'queued', requestId: randomUUID(), requestedAt: clock().toISOString(), source: clone(entry.source),
        requestedBy: { actualUserId: context.actorId, effectiveUserId: context.effectiveUserId },
        scope: { companyId: entry.companyId, generation: connected.generation, settingsRevision: entry.settingsRevision } };
      entry.tracking ??= initialTracking(entry);
      entry.tracking.state = 'pending'; entry.tracking.nextCheckAt = clock().toISOString();
      delete entry.tracking.reason; delete entry.tracking.error;
      entry.events ??= []; entry.events.push({ id: randomUUID(), type: 'booking_requested', text: 'Bokföring i Spiris begärd', at: clock().toISOString(), actor: context.actorId });
      audit(tenant, context, 'visma.booking_requested', { exportId: entry.id, source: entry.source });
    }, { outbox: { id: job.id } });
    return cardBookingStatus(input.cardId, context);
  }
  async function assertBookingAuthorization(job, write = true) {
    const approval = await sourceMatches(job), settings = await currentSettings(), connected = await connection();
    const booking = job.booking;
    if (!booking || !sameSource(booking.source, job.source) || booking.scope?.companyId !== job.companyId
      || booking.scope?.generation !== connected.generation || booking.scope?.settingsRevision !== job.settingsRevision
      || job.companyId !== companyId() || !config().configured || !settings.enabled || !connected.companyVerified)
      fail('Bokföringsbegäran tillhör en ändrad eller avstängd Spiris-koppling.', 409, 'visma_booking_connection_changed');
    if (write) await bookingAuthorise(bookingContext(booking), approval, true);
    return approval;
  }
  function observedAdapter(send) {
    return async request => { const result = await send(request.operation, request.parameters); return { ...result, status: result.outcome }; };
  }
  async function confirmInvoice(job, send, observation) {
    const result = await send('invoice', { resourceId: observation.invoiceId });
    if (result.outcome !== 'accepted') fail('Den bokförda fakturan kunde inte läsas tillbaka från Spiris.', 503, 'visma_booking_unavailable');
    verifySpirisBookingRecord(result.response, { ...job, tracking: { ...job.tracking, invoiceId: observation.invoiceId } }, true);
    return { ...observation, invoice: result.response };
  }
  async function processBooking(id, { force = false, readOnly = false } = {}) {
    const current = await readJob(id);
    if (!current || current.status !== 'accepted' || !current.booking) return null;
    const reservation = await mutate(finance => {
      const entry = finance.outbox.find(job => job.id === id), booking = entry.booking;
      if (entry.tracking?.state === 'booked' || booking.status === 'booked'
        || booking.lease && Date.parse(booking.lease.until) > clock().getTime()
        || entry.tracking?.lease && Date.parse(entry.tracking.lease.until) > clock().getTime()
        || !force && (['failed', 'paused'].includes(booking.status) || booking.nextCheckAt && Date.parse(booking.nextCheckAt) > clock().getTime())) return { prior: true };
      const owner = randomUUID(); booking.lease = { id: owner, until: new Date(clock().getTime() + LEASE).toISOString() };
      booking.status = booking.postReserved ? 'unknown' : 'processing';
      return { owner, job: clone(entry) };
    }, { outbox: { id } });
    if (reservation.prior) return null;
    const { job, owner } = reservation;
    const update = operation => mutate((finance, tenant) => {
      const entry = finance.outbox.find(item => item.id === id);
      if (entry?.booking?.lease?.id !== owner) fail('Bokföringen hanteras av en annan arbetare.', 409, 'visma_booking_busy');
      operation(entry, tenant); entry.updatedAt = clock().toISOString();
    }, { outbox: { id } });
    try {
      await assertBookingAuthorization(job, !job.booking.postReserved && !readOnly);
      const observation = await bookingBatch(job.booking.scope,
        () => assertBookingAuthorization(job, !job.booking.postReserved && !readOnly), async send => {
          const before = await observeSpirisDraft(job, observedAdapter(send));
          if (before.kind === 'booked') return confirmInvoice(job, send, before);
          if (before.kind === 'missing') return before;
          if (job.booking.postReserved || readOnly) return { kind: 'draft_exists' };
          const draft = await send('draft', { resourceId: job.draftId });
          if (draft.outcome !== 'accepted') fail('Utkastet kunde inte verifieras före bokföring.', 503, 'visma_booking_unavailable');
          verifySpirisBookingRecord(draft.response, job);
          await assertBookingAuthorization(job, true);
          // Irrevocable before the POST. A crash or lost response can only
          // reconcile this same draft; no worker repeats a conversion.
          await update(entry => {
            if (entry.booking.postReserved) fail('Bokföringen är redan reserverad.', 409, 'visma_booking_unknown');
            entry.booking.postReserved = true; entry.booking.postReservedAt = clock().toISOString();
          });
          const converted = await send('convertDraft', { resourceId: job.draftId });
          await update(entry => { entry.booking.response = { outcome: converted.outcome, httpStatus: converted.httpStatus, data: clone(converted.response ?? null) }; });
          if (converted.outcome !== 'accepted') return { kind: converted.outcome === 'rejected' ? 'rejected' : 'unknown', error: converted.error,
            providerErrorCode: converted.response?.ErrorCode, httpStatus: converted.httpStatus };
          if (converted.httpStatus !== 201 || !uuid(converted.response?.Id)) return { kind: 'unknown' };
          verifySpirisBookingRecord(converted.response, { ...job, tracking: { ...job.tracking, invoiceId: converted.response.Id } }, true);
          return confirmInvoice(job, send, { kind: 'booked', invoiceId: converted.response.Id,
            invoiceNumber: converted.response.NumberSeries && Number.isInteger(converted.response.Number) ? `${converted.response.NumberSeries}${converted.response.Number}` : converted.response.InvoiceNumber,
            voucherId: converted.response.VoucherId, voucherNumber: converted.response.VoucherNumber });
        });
      await update((entry, tenant) => {
        const at = clock().toISOString(), booking = entry.booking;
        booking.checkedAt = at; booking.failureCount = 0; delete booking.error;
        if (observation.kind === 'booked') {
          Object.assign(entry.tracking, { state: 'booked', invoiceId: observation.invoiceId, invoiceNumber: observation.invoiceNumber,
            voucherId: observation.voucherId, voucherNumber: observation.voucherNumber, lastCheckedAt: at, nextCheckAt: null });
          booking.status = 'booked'; booking.finishedAt = at; booking.nextCheckAt = null;
          addSpirisEvent(entry, 'booked', at, booking.requestedBy.actualUserId, `Verifikation ${observation.voucherNumber}`);
          audit(tenant, bookingContext(booking), 'visma.invoice_booked_confirmed', { exportId: id, source: entry.source, invoiceId: observation.invoiceId });
        } else {
          booking.status = observation.kind === 'rejected' ? 'failed' : observation.kind === 'missing' ? 'failed' : booking.postReserved ? 'unknown' : 'queued';
          if (booking.postReserved && booking.status === 'unknown') {
            booking.reconcileCount = (booking.reconcileCount ?? 0) + 1;
            if (booking.reconcileCount >= 8 || clock().getTime() - Date.parse(booking.postReservedAt) >= 86400000) booking.status = 'failed';
          }
          booking.error = { code: observation.kind === 'rejected' ? 'visma_booking_rejected' : observation.kind === 'missing' ? 'visma_booking_missing' : 'visma_booking_unknown',
            message: observation.kind === 'rejected' ? 'Spiris avvisade bokföringen. Granska underlaget i Spiris och uppdatera status.'
              : observation.kind === 'missing' ? 'Utkastet och motsvarande bokförda faktura kunde inte hittas.' : 'Bokföringen är inte bekräftad. Det befintliga underlaget kontrolleras utan omsändning.',
            ...(Number.isInteger(observation.httpStatus) ? { httpStatus: observation.httpStatus } : {}),
            ...(Number.isInteger(observation.providerErrorCode) ? { providerErrorCode: observation.providerErrorCode } : {}) };
          booking.nextCheckAt = booking.status === 'failed' ? null : new Date(clock().getTime() + 300000).toISOString();
          entry.tracking.state = booking.status === 'failed' ? observation.kind === 'missing' ? 'missing' : 'attention' : 'pending';
          entry.tracking.nextCheckAt = booking.nextCheckAt; entry.tracking.reason = booking.error.message;
        }
        delete booking.lease;
      });
    } catch (error) {
      const checkedGeneration = (await connection()).generation;
      await update(entry => {
        const booking = entry.booking; booking.failureCount = (booking.failureCount ?? 0) + 1; booking.checkedAt = clock().toISOString();
        booking.status = ['visma_booking_connection_changed', 'visma_company_mismatch', 'visma_not_connected'].includes(error.code) ? 'paused'
          : booking.postReserved && booking.failureCount < 8 ? 'unknown' : error.status === 503 && booking.failureCount < 8 ? 'queued' : 'failed';
        booking.error = { code: error.code ?? 'visma_booking_unavailable', message: error.message ?? 'Bokföringen kunde inte kontrolleras.',
          ...(error.code === 'accounting_amount_invalid' && error.details?.provider === 'spiris' ? { details: clone(error.details) } : {}) };
        booking.nextCheckAt = ['unknown', 'queued'].includes(booking.status) ? new Date(clock().getTime() + Math.min(1440, 5 * 2 ** (booking.failureCount - 1)) * 60000).toISOString() : null;
        entry.tracking.state = booking.status === 'paused' ? 'paused' : booking.status === 'failed' ? 'attention' : 'pending';
        entry.tracking.checkedGeneration = checkedGeneration; entry.tracking.reason = booking.error.message;
        entry.tracking.nextCheckAt = booking.nextCheckAt; delete booking.lease;
      });
    }
    return readJob(id);
  }
  async function refreshCardBooking(cardId, context) {
    const approval = await findApproval(cardId); await bookingAuthorise(context, approval, false);
    const job = await exactCardJob(approval);
    if (!job || job.status !== 'accepted') return cardBookingStatus(cardId, context);
    if (job.booking && job.tracking?.state !== 'booked') await processBooking(job.id, { force: true, readOnly: true });
    else {
      const connected = await connection();
      if (job.companyId !== companyId() || !connected.companyVerified) fail('Rätt Spiris-koppling måste vara aktiv.', 409, 'visma_booking_connection_changed');
      const observation = await bookingBatch({ companyId: job.companyId, generation: connected.generation }, () => bookingAuthorise(context, approval, false),
        async send => {
          if (job.tracking?.state === 'booked') return confirmInvoice(job, send, { kind: 'booked', invoiceId: job.tracking.invoiceId,
            invoiceNumber: job.tracking.invoiceNumber, voucherId: job.tracking.voucherId, voucherNumber: job.tracking.voucherNumber });
          const value = await observeSpirisDraft(job, observedAdapter(send)); return value.kind === 'booked' ? confirmInvoice(job, send, value) : value;
        });
      if (observation.kind === 'booked') await mutate((finance, tenant) => {
        const entry = finance.outbox.find(item => item.id === job.id), at = clock().toISOString();
        if (entry.tracking?.state !== 'booked') { addSpirisEvent(entry, 'booked', at, context.actorId, `Verifikation ${observation.voucherNumber}`);
          audit(tenant, context, 'visma.invoice_booked_confirmed', { exportId: entry.id, invoiceId: observation.invoiceId, source: entry.source }); }
        entry.tracking ??= initialTracking(entry); Object.assign(entry.tracking, { state: 'booked', invoiceId: observation.invoiceId,
          invoiceNumber: observation.invoiceNumber, voucherId: observation.voucherId, voucherNumber: observation.voucherNumber, lastCheckedAt: at, nextCheckAt: null });
      }, { outbox: { id: job.id } });
    }
    return cardBookingStatus(cardId, context);
  }
  async function assertPaymentReady(source, { fresh = true } = {}) {
    const settings = await currentSettings(), connected = await connection();
    if (!settings.enabled || !connected.companyVerified || !config().configured) fail('Bokför underlaget i Spiris före utbetalning.', 409, 'visma_payment_not_booked');
    const approval = await findApproval(source.cardId);
    if (!sameSource(source, ref(approval))) fail('Utbetalningens attestversion har ändrats.', 409, 'visma_source_changed');
    const candidates = (await exportJobs({ companyId: companyId(), cardId: source.cardId, statuses: ['accepted'], limit: 100 }))
      .filter(job => sameSource(job.source, source) && job.tracking?.state === 'booked');
    if (candidates.length !== 1) fail('Bokför underlaget i Spiris före utbetalning.', 409, candidates.length > 1 ? 'visma_payment_ambiguous' : 'visma_payment_not_booked');
    const job = candidates[0]; await sourceMatches(job);
    if (job.booking && job.booking.scope?.generation !== connected.generation) fail('Underlaget tillhör en tidigare Spiris-koppling.', 409, 'visma_booking_connection_changed');
    if (!fresh) return { source: clone(job.source), companyId: job.companyId, generation: connected.generation, invoiceId: job.tracking.invoiceId,
      draftId: job.draftId, status: 'booked', voucherNumber: job.tracking.voucherNumber };
    return bookingBatch({ companyId: job.companyId, generation: connected.generation }, async () => {
      await sourceMatches(job); const active = await currentSettings();
      if (!active.enabled || companyId() !== job.companyId) fail('Spiris-kopplingen är avstängd eller ändrad.', 409, 'visma_booking_connection_changed');
    }, async send => { const verified = await confirmInvoice(job, send, { kind: 'booked', invoiceId: job.tracking.invoiceId });
      const record = verified.invoice;
      for (const field of ['RemainingAmountInvoiceCurrency', ...(record.RemainingAmount !== undefined ? ['RemainingAmount'] : [])]) {
        if (readSpirisInvoiceBalance(record, field).cents !== moneyToCents(job.draft.TotalAmount))
          throw spirisAmountError(record[field], field, 'Spiris-fakturan är redan helt eller delvis betald. Kontrollera betalningen före utbetalning.', 409, 'visma_payment_already_recorded');
      }
      if (record.PaymentStatus !== undefined && ![3, 7, 8, 10, 13, 14].includes(record.PaymentStatus))
        fail('Spiris-fakturan är redan helt eller delvis betald. Kontrollera betalningen före utbetalning.', 409, 'visma_payment_already_recorded');
      return { source: clone(job.source), companyId: job.companyId, generation: connected.generation, invoiceId: record.Id,
        draftId: job.draftId, status: 'booked', voucherNumber: record.VoucherNumber }; });
  }
  const mutateTracking = (id, owner, operation) => mutate((finance, tenant) => {
    const job = finance.outbox.find(item => item.id === id);
    if (!job || job.tracking?.lease?.id !== owner) fail('En annan arbetare hanterar statuskontrollen.', 409, 'visma_tracking_busy');
    operation(job, tenant); job.updatedAt = clock().toISOString(); delete job.tracking.lease; return publicExport(job);
  }, { outbox: { id } });
  async function refreshExport(id, context, worker = false, force = true) {
    if (!worker) await authorize(context);
    await assertTrackingAuthorization(context, id);
    const settings = await currentSettings(), connected = await connection();
    const reservation = await mutate(finance => {
      const job = finance.outbox.find(item => item.id === id);
      if (!job || job.status !== 'accepted') fail('Det finns inget bekräftat fakturautkast att kontrollera.', 409, 'visma_tracking_unverified');
      job.tracking ??= initialTracking(job, settings.trackingMaxDays ?? 30);
      const tracking = job.tracking;
      if (['booked', 'replaced'].includes(tracking.state) || tracking.lease && Date.parse(tracking.lease.until) > clock().getTime()
        || job.booking?.lease && Date.parse(job.booking.lease.until) > clock().getTime()) return { prior: publicExport(job) };
      if (!force && (['missing', 'expired', 'attention'].includes(tracking.state) || tracking.state === 'paused' && tracking.checkedGeneration === connected.generation ||
        tracking.nextCheckAt && Date.parse(tracking.nextCheckAt) > clock().getTime())) return { prior: publicExport(job) };
      const deadlineAt = new Date(Date.parse(tracking.startedAt) + (settings.trackingMaxDays ?? 30) * 86400000).toISOString(); tracking.deadlineAt = deadlineAt;
      if (!force && clock().getTime() >= Date.parse(deadlineAt)) {
        if (tracking.state !== 'expired') addSpirisEvent(job, 'tracking_expired', clock().toISOString(), 'Spiris-arbetare');
        tracking.state = 'expired'; tracking.nextCheckAt = null; tracking.reason = 'Automatisk uppföljning har avslutats. Kontrollera bokföringen manuellt.';
        return { prior: publicExport(job) };
      }
      const owner = randomUUID(); tracking.lease = { id: owner, until: new Date(clock().getTime() + LEASE).toISOString() };
      return { owner, job: clone(job) };
    }, { outbox: { id } });
    if (reservation.prior) return reservation.prior;
    const { job, owner } = reservation;
    try {
      const observation = await readbackBatch(context, async (sendRead, generation) => ({ ...await observeSpirisDraft(job, sendRead), generation }), worker, id);
      return await mutateTracking(id, owner, (entry, tenant) => {
        if (tenant.generation !== observation.generation) fail('Anslutningen har ändrats under kontrollen.', 409, 'visma_not_connected');
        const tracking = entry.tracking, at = clock().toISOString(); tracking.lastCheckedAt = at; tracking.failureCount = 0;
        tracking.checkedGeneration = observation.generation; tracking.intervalMinutes = trackingInterval(entry, clock());
        delete tracking.reason; delete tracking.error;
        if (observation.kind === 'booked') {
          Object.assign(tracking, { state: 'booked', invoiceId: observation.invoiceId, invoiceNumber: observation.invoiceNumber,
            voucherId: observation.voucherId, voucherNumber: observation.voucherNumber, nextCheckAt: null });
          addSpirisEvent(entry, 'booked', at, worker ? 'Spiris-arbetare' : context.actorId, `Verifikation ${observation.voucherNumber}`);
          audit(tenant, context, 'visma.invoice_booked_confirmed', { exportId: id, source: entry.source, invoiceId: observation.invoiceId, voucherId: observation.voucherId });
        } else if (observation.kind === 'missing') {
          if (!tracking.firstMissingAt) { tracking.firstMissingAt = at; tracking.missingCount = 1; }
          else if (clock().getTime() - Date.parse(tracking.firstMissingAt) >= 300000) tracking.missingCount = Math.max(2, tracking.missingCount + 1);
          if (tracking.missingCount >= 2) {
            if (tracking.state !== 'missing') addSpirisEvent(entry, 'draft_missing', at, worker ? 'Spiris-arbetare' : context.actorId);
            tracking.state = 'missing'; tracking.nextCheckAt = null; tracking.reason = 'Utkastet och motsvarande bokförda faktura saknas efter förnyad kontroll.';
          } else { tracking.state = 'pending'; tracking.nextCheckAt = new Date(clock().getTime() + 300000).toISOString();
            tracking.reason = 'Underlaget hittades inte. Systemet gör en förnyad kontroll innan återskapande blir möjligt.'; }
        } else {
          tracking.state = 'pending'; tracking.missingCount = 0; delete tracking.firstMissingAt;
          tracking.nextCheckAt = new Date(clock().getTime() + tracking.intervalMinutes * 60000).toISOString();
        }
      });
    } catch (error) {
      if (error?.status === 403) { await mutateTracking(id, owner, () => {}); throw error; }
      const code = error instanceof EnvironmentError ? error.code : 'visma_tracking_unavailable';
      return mutateTracking(id, owner, entry => {
        const tracking = entry.tracking; tracking.failureCount = (tracking.failureCount ?? 0) + 1;
        tracking.error = { code, message: error instanceof EnvironmentError ? error.message : 'Bokföringskontrollen avbröts. Senaste bekräftade status behålls.',
          ...(error instanceof EnvironmentError && Object.hasOwn(error, 'providerHttpStatus') ? { httpStatus: Number.isInteger(error.providerHttpStatus) ? error.providerHttpStatus : null } : {}),
          ...(error instanceof EnvironmentError && Number.isSafeInteger(error.providerErrorCode) ? { providerErrorCode: error.providerErrorCode } : {}) };
        tracking.reason = tracking.error.message; tracking.lastAttemptAt = clock().toISOString(); tracking.checkedGeneration = connected.generation;
        if (['visma_tracking_access', 'visma_tracking_paused', 'visma_not_connected', 'visma_credentials_unavailable', 'visma_refresh_failed', 'visma_refresh_unknown'].includes(code)) {
          tracking.state = 'paused'; tracking.nextCheckAt = null;
        } else if (tracking.failureCount >= 8 || ['visma_tracking_ambiguous', 'visma_tracking_identity_conflict', 'visma_tracking_accounting_unknown'].includes(code)) {
          tracking.state = 'attention'; tracking.nextCheckAt = null;
        } else { tracking.state = 'pending'; tracking.nextCheckAt = new Date(clock().getTime() + Math.min(1440, 5 * 2 ** (tracking.failureCount - 1)) * 60000).toISOString(); }
      });
    }
  }
  let trackingRunning = false;
  async function processAccountingTracking() {
    if (trackingRunning) return { checked: 0 };
    trackingRunning = true;
    try {
      const settings = await currentSettings(), connected = await connection();
      if (!settings.enabled || !settings.enabledBy?.actualUserId || !config().configured || !connected.companyVerified) return { checked: 0 };
      const context = { organisationId: organisationId, actorId: 'service:spiris-export', effectiveUserId: 'service:spiris-export' };
      const jobs = await exportJobs({ companyId: companyId(), statuses: ['accepted'], trackingDueAt: clock().toISOString(), trackingGeneration: connected.generation,
        fields: ['id', 'booking'], limit: 10 });
      let checked = 0;
      for (const { id, booking } of jobs) {
        if (booking && ['queued', 'processing', 'unknown'].includes(booking.status)) await processBooking(id);
        else await refreshExport(id, context, true, false);
        checked++;
      }
      return { checked };
    } finally { trackingRunning = false; }
  }
  async function recreateExport(id, input, context) {
    await authorize(context);
    if (!input || Object.keys(input).some(name => name !== 'requestId') || !uuid(input.requestId)) fail('Återskapandet behöver ett nytt giltigt försöks-ID.', 422, 'visma_invalid');
    await assertTrackingAuthorization(context, id);
    const previous = await readJob(id);
    if (previous.recreation?.requestId === input.requestId) {
      const prior = await readJob(previous.recreation.jobId); if (prior) return publicExport(prior);
    }
    if (previous.tracking?.state !== 'missing') fail('Återskapande kräver att utkast och bokförd faktura bekräftats saknade.', 409, 'visma_recreate_not_missing');
    await sourceMatches(previous);
    const settings = await currentSettings();
    const owner = randomUUID();
    const reservation = await mutate(finance => {
      const old = finance.outbox.find(job => job.id === id);
      if (old.recreation) return { priorId: old.recreation.jobId };
      if (old.tracking?.state !== 'missing' || old.tracking.lease && Date.parse(old.tracking.lease.until) > clock().getTime())
        fail('Underlaget kontrolleras eller återskapas redan.', 409, 'visma_tracking_busy');
      old.tracking.lease = { id: owner, until: new Date(clock().getTime() + LEASE).toISOString() }; return { job: clone(old) };
    }, { outbox: { id } });
    if (reservation.priorId) return publicExport(await readJob(reservation.priorId));
    try {
      const observation = await readbackBatch(context, async (sendRead, generation) => ({ ...await observeSpirisDraft(reservation.job, sendRead), generation }), false, id);
      if (observation.kind !== 'missing') {
        await mutateTracking(id, owner, (old, tenant) => {
          if (tenant.generation !== observation.generation) fail('Anslutningen har ändrats.', 409, 'visma_not_connected');
          const at = clock().toISOString(); old.tracking.lastCheckedAt = at; delete old.tracking.reason; delete old.tracking.error;
          if (observation.kind === 'booked') {
            Object.assign(old.tracking, { state: 'booked', invoiceId: observation.invoiceId, invoiceNumber: observation.invoiceNumber,
              voucherId: observation.voucherId, voucherNumber: observation.voucherNumber, nextCheckAt: null });
            addSpirisEvent(old, 'booked', at, context.actorId, `Verifikation ${observation.voucherNumber}`);
          } else {
            old.tracking.state = 'pending'; old.tracking.missingCount = 0; delete old.tracking.firstMissingAt;
            old.tracking.nextCheckAt = new Date(clock().getTime() + trackingInterval(old, clock()) * 60000).toISOString();
          }
        });
        fail('Spiris-underlaget finns eller är bokfört. Inget nytt utkast har skapats.', 409, 'visma_recreate_exists');
      }
      await sourceMatches(previous); await authorize(context); await assertTrackingAuthorization(context, id);
      const created = await mutate((finance, tenant) => {
        const old = finance.outbox.find(job => job.id === id);
        if (old.recreation) return publicExport(finance.outbox.find(job => job.id === old.recreation.jobId));
        if (old.tracking?.lease?.id !== owner || tenant.generation !== observation.generation)
          fail('Kopplingen eller kontrollen har ändrats. Inget nytt utkast har skapats.', 409, 'visma_tracking_busy');
        const at = clock().toISOString(), sourceKey = old.sourceKey ?? old.key;
        const job = { ...clone(old), id: randomUUID(), key: `${sourceKey}:recreate:${input.requestId}`, sourceKey,
          status: 'queued', stage: 'draft', createdAt: at, updatedAt: at, trigger: 'manual', environment: 'sandbox',
          recreatedFrom: old.id, attemptNumber: (old.attemptNumber ?? 1) + 1, actualUserId: context.actorId, effectiveUserId: context.effectiveUserId,
          authorization: { kind: 'manual', actualUserId: context.actorId, effectiveUserId: context.effectiveUserId, at, configRevision: settings.revision, companyId: old.companyId },
          trackingMaxDays: settings.trackingMaxDays ?? 30, events: [], runs: { supplierRequestId: randomUUID(), draftRequestId: randomUUID() } };
        for (const name of ['tracking', 'lease', 'finishedAt', 'draftId', 'error', 'recreation', 'supplierRequestReserved', 'draftRequestReserved']) delete job[name];
        addSpirisEvent(job, 'queued', at, context.actorId, 'Aktivt återskapande av samma attesterade underlag.');
        old.recreation = { requestId: input.requestId, jobId: job.id, at }; old.tracking.state = 'replaced'; old.tracking.nextCheckAt = null; delete old.tracking.lease;
        finance.outbox.push(job); audit(tenant, context, 'visma.export_recreation_reserved', { exportId: job.id, previousExportId: old.id, source: old.source });
        return publicExport(job);
      }, { outbox: { id } });
      return process(created.id, context);
    } catch (error) {
      await mutate(finance => { const old = finance.outbox.find(job => job.id === id); if (old?.tracking?.lease?.id === owner) delete old.tracking.lease; }, { outbox: { id } });
      throw error;
    }
  }
  let workerRunning = false, reconciliationRequested = false, lastReconciliationAt = null;
  const pendingCards = new Set();
  async function processQueuedExports({ cardId, reconcile = true } = {}) {
    if (cardId !== undefined) {
      if (!Number.isSafeInteger(cardId) || cardId <= 0) fail('Välj ett giltigt viktkort.', 422);
      pendingCards.add(cardId);
    }
    if (reconcile) reconciliationRequested = true;
    // A new committed attest may arrive while another provider request is in
    // flight. Keep its hint for the next pass rather than dropping the event.
    if (workerRunning) return { processed: 0 };
    workerRunning = true;
    let consumedHints = [], consumedReconciliation = false;
    try {
      const settings = await currentSettings();
      if (!settings.enabled || !settings.enabledBy?.actualUserId || !config().configured) return { processed: 0 };
      const context = { organisationId: organisationId, actorId: 'service:spiris-export', effectiveUserId: 'service:spiris-export' };
      const automatic = settings.exportMode === 'after_attest';
      const fullReconciliation = reconciliationRequested || lastReconciliationAt !== null && clock().getTime() - lastReconciliationAt >= RECONCILE_INTERVAL;
      const hints = automatic ? [...pendingCards].slice(0, fullReconciliation ? undefined : 50) : [];
      consumedHints = hints; consumedReconciliation = automatic && fullReconciliation;
      if (!automatic) pendingCards.clear();
      for (const id of hints) pendingCards.delete(id);
      let approvals = [];
      try {
        if (automatic && fullReconciliation) {
          reconciliationRequested = false;
          approvals = latestAttestedVismaCards(await sourceProvider());
          lastReconciliationAt = clock().getTime();
        } else if (automatic && hints.length) {
          const requested = new Set(hints);
          approvals = latestAttestedVismaCards((await Promise.all(hints.map(id => sourceProvider({ cardId: id })))).flat())
            .filter(approval => requested.has(Number(approval.cardId)));
        }
      } catch (error) {
        for (const id of hints) pendingCards.add(id);
        if (fullReconciliation) reconciliationRequested = true;
        throw error;
      }
      // Startup and periodic reconciliation remain authoritative after restart;
      // normal 20-second passes drain indexed jobs without scanning all attests.
      const knownKeys = new Set(automatic && fullReconciliation ? (await exportJobs({ companyId: companyId(), fields: ['key'] })).map(job => job.key) : []);
      for (const approval of approvals) {
        const sourceKey = key(companyId(), ref(approval));
        if (knownKeys.has(sourceKey)) continue;
        if (!fullReconciliation && (await exportJobs({ companyId: companyId(), key: sourceKey, fields: ['key'], limit: 1 })).length) continue;
        try {
          const prepared = prepare(approval);
          const authorizedRevision = await readFinanceProjection(finance => finance.settingsHistory?.[prepared.companyId]?.[prepared.settingsRevision], [['settingsHistory', prepared.companyId, String(prepared.settingsRevision)]]);
          if (prepared.accounting.exportMode === 'after_attest' && authorizedRevision?.enabled && authorizedRevision.exportMode === 'after_attest' && authorizedRevision.enabledBy?.actualUserId)
            await enqueue({ cardId: approval.cardId }, context, true, approval);
          knownKeys.add(sourceKey);
        }
        catch (error) { if (!(error instanceof EnvironmentError)) throw error; await recordPrequeueBlock(approval, error, context); }
      }
      const jobs = await exportJobs({ companyId: companyId(), statuses: ['queued', 'processing'],
        ...(!automatic ? { trigger: 'manual' } : {}), fields: ['id'], limit: 25 });
      let processed = 0;
      for (const { id } of jobs) { await process(id, { ...context, exportId: id }, true); processed++; }
      // The existing due-tracking index also finds durable booking intents on
      // accepted drafts. No full journal scan or repeated conversion POST.
      const bookings = await exportJobs({ companyId: companyId(), statuses: ['accepted'], trackingDueAt: clock().toISOString(),
        trackingGeneration: (await connection()).generation, bookingDueOnly: true, fields: ['id'], limit: 25 });
      for (const job of bookings) { await processBooking(job.id); processed++; }
      return { processed };
    } catch (error) {
      for (const id of consumedHints) pendingCards.add(id);
      if (consumedReconciliation) reconciliationRequested = true;
      throw error;
    } finally { workerRunning = false; }
  }
  return {
    assertWorkerAuthorization,
    assertExportAuthorization,
    assertTrackingAuthorization,
    assertPaymentReady,
    // Private payout worker projection. Browser API methods cannot choose a
    // different invoice, customer or approval version for a paid instruction.
    async paymentTarget(source) {
      const settings = await currentSettings(), connected = await connection();
      const matches = (await exportJobs({ companyId: companyId(), cardId: source.cardId, statuses: ['accepted'], limit: 100 }))
        .filter(job => job.source.approvalId === source.approvalId && job.source.version === source.version && job.source.hash === source.hash
          && (job.environment ?? 'sandbox') === 'sandbox' && job.tracking?.state !== 'replaced');
      const booked = matches.filter(job => job.tracking?.state === 'booked');
      if (booked.length > 1) fail('Flera bokförda fakturor matchar utbetalningen. Kopplingen måste granskas.', 409, 'visma_payment_ambiguous');
      const job = booked[0] ?? matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
      return { settings: clone(settings), connected, job: job ? clone(job) : null };
    },
    publicMethods: {
      async settings(context) { await authorize(context); return dto(); },
      async saveSettings(input, context) {
        await authorize(context);
        if (!companyId()) fail(organisationId === 'jeroc-demo'
          ? 'VISMA_SANDBOX_COMPANY_ID behöver låsa sandboxföretaget före konfiguration.'
          : 'Anslut och verifiera företagets eget Spiris-sandboxföretag före konfiguration.', 409, 'visma_company_unverified');
        if (!input || Object.keys(input).some(name => !['expectedRevision', 'settings'].includes(name)) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)
          fail('Inställningarna måste innehålla aktuellt revisionsnummer.', 422);
        const normalized = normalizeAccountingSettings({ ...input.settings, revision: input.expectedRevision + 1 }, { companyId: companyId(), sandbox: true });
        const [choices, actualSites] = await Promise.all([currentChoices(), sites()]);
        verifySelections(normalized, choices, actualSites);
        await mutate((finance, tenant) => {
          const current = finance.settings[companyId()] ?? defaultSettings(companyId());
          if (current.revision !== input.expectedRevision) fail('Ekonomiinställningarna har ändrats. Hämta sidan på nytt.', 409, 'revision_conflict');
          const saved = { ...normalized, revision: current.revision + 1 };
          if (saved.enabled) saved.enabledBy = { actualUserId: context.actorId, effectiveUserId: context.effectiveUserId, at: clock().toISOString() };
          finance.settings[companyId()] = saved;
          finance.settingsHistory ??= {}; finance.settingsHistory[companyId()] ??= {}; finance.settingsHistory[companyId()][saved.revision] = clone(saved);
          audit(tenant, context, 'visma.accounting_settings_saved', { companyId: companyId(), revision: saved.revision, enabled: saved.enabled, exportMode: saved.exportMode });
        }); return dto();
      },
      async lookupChoices(context) {
        await authorize(context);
        const connected = await connection(); if (!connected.companyVerified) fail('Anslut och verifiera sandboxföretaget först.', 409, 'visma_company_unverified');
        return lookupBatch(context, async (sendLookup, signal, generation) => {
          const fetchList = (operation, parameters = {}) => list(operation, parameters, context, false, undefined, sendLookup);
          // The lists are independent. Historical account plans remain complete,
          // but four year-read workers avoid multiplying latency by every year.
          const fetchAccountPlans = async () => {
            const years = await fetchList('fiscalYears');
            const validYears = years.filter(item => uuid(item.Id)), accountPages = new Array(validYears.length); let nextYear = 0;
            await Promise.all(Array.from({ length: Math.min(4, validYears.length) }, async () => {
              while (nextYear < validYears.length) {
                signal.throwIfAborted(); const index = nextYear++;
                accountPages[index] = await fetchList('accounts', { fiscalYearId: validYears[index].Id });
              }
            }));
            return { years, accountList: accountPages.flat() };
          };
          // Account plans depend only on fiscal years. A slow project or VAT
          // response must not delay the first account page unnecessarily.
          const [terms, { years, accountList }, vatCodes, costCenters, projects] = await Promise.all([
            fetchList('paymentTerms'), fetchAccountPlans(), fetchList('vatCodes'), fetchList('costCenters'), fetchList('projects'),
          ]);
          const choices = normalizedChoices({ companyId: companyId(), fetchedAt: clock().toISOString(),
            fiscalYears: years.filter(item => uuid(item.Id)).map(item => ({ id: item.Id, startDate: item.StartDate, endDate: item.EndDate, locked: Boolean(item.IsLockedForAccounting) })),
            accounts: accountList.map(item => ({ number: Number(item.Number), name: cleanText(item.Name), fiscalYearId: item.FiscalYearId,
              active: item.IsActive !== false, vatCodeId: item.VatCodeId ?? null, firstCostCenterMandatory: item.IsFirstCostCenterMandatory === true,
              costCenterAllowed: item.IsCostCenterAllowed !== false, projectAllowed: item.IsProjectAllowed !== false,
              blockedForManualBooking: item.IsBlockedForManualBooking === true, transactionTextAllowed: item.AllowTransactionText !== false })),
            paymentTerms: terms.filter(item => uuid(item.Id)).map(item => ({ id: item.Id, name: cleanText(item.Name ?? item.NameEnglish), days: item.NumberOfDays, availableForPurchase: item.AvailableForPurchase === true })),
            vatCodes: vatCodes.filter(item => uuid(item.Id)).map(item => ({ id: item.Id, code: cleanText(item.Code), name: cleanText(item.Description), rate: item.VatRate })),
            costCenters: costCenters.filter(item => uuid(item.Id)).map(item => ({ id: item.Id, name: cleanText(item.Name), number: item.Number, active: item.IsActive !== false,
              items: (item.Items ?? []).filter(part => uuid(part.Id)).map(part => ({ id: part.Id, name: cleanText(part.Name), shortName: cleanText(part.ShortName), active: part.IsActive !== false })) })),
            projects: projects.filter(item => uuid(item.Id)).map(item => ({ id: item.Id, name: cleanText(item.Name), number: cleanText(item.Number), status: item.Status })) });
          await authorize(context); signal.throwIfAborted();
          await mutate((finance, tenant) => {
            signal.throwIfAborted();
            if (tenant.generation !== generation) fail('Anslutningen har ändrats under hämtningen.', 409, 'visma_not_connected');
            finance.choices[choices.companyId] = choices;
            audit(tenant, context, 'visma.accounting_choices_fetched', { companyId: choices.companyId, accounts: choices.accounts.length, fiscalYears: choices.fiscalYears.length });
          }); return dto();
        });
      },
      preview,
      async exports(context, cardId) { await authorize(context); return { exports: (await exportJobs({ ...(cardId === undefined ? {} : { cardId }), descending: true })).map(publicExport) }; },
      enqueueExport: (input, context) => enqueue(input, context),
      async sendExport(input, context) { const job = await enqueue(input, context); return process(job.id, context); },
      processExport: (id, context) => process(id, context),
      processQueuedExports,
      processAccountingTracking,
      refreshExport: (id, context) => refreshExport(id, context),
      recreateExport,
      checkAttestBooking,
      cardBookingStatus,
      requestCardBooking,
      refreshCardBooking,
      assertPaymentReady,
      async financeSettingsForCompany(customer) {
        const settings = await currentSettings(); if (!settings.enabled || settings.companyId !== companyId()) return null;
        const days = customer?.paymentTermDays ?? settings.paymentTermDays;
        if (!Number.isInteger(days) || days < 0 || days > 3650) fail('Kundens betalningsvillkor behöver granskas före kundgodkännande.', 409, 'accounting_payment_terms_invalid');
        if (days === settings.paymentTermDays) return settings;
        const terms = await readFinanceProjection(finance => finance.choices[companyId()]?.paymentTerms.filter(term => term.days === days && term.availableForPurchase) ?? [], [['choices', companyId() ?? '', 'paymentTerms']]);
        if (terms.length !== 1) fail(`Kundens villkor ${days} dagar behöver ett entydigt verkligt inköpsvillkor i Spiris. Hämta och kontrollera betalningsvillkoren.`, 409, 'accounting_payment_terms_unmapped');
        return { ...settings, paymentTermDays: days, paymentTermsId: terms[0].id };
      },
      async cardExportProjection(cardId) {
        const jobs = await exportJobs({ cardId, fields: ['id', 'source', 'companyId', 'environment', 'status', 'createdAt', 'finishedAt', 'supplierId', 'draftId', 'draft', 'error', 'events', 'tracking', 'booking', 'attemptNumber', 'recreatedFrom', 'recreation'] });
        const job = jobs.sort((a, b) => b.source.version - a.source.version || b.createdAt.localeCompare(a.createdAt) || (b.attemptNumber ?? 1) - (a.attemptNumber ?? 1))[0];
        if (!job) return null;
        const [settings, connected] = await Promise.all([currentSettings(), connection()]);
        const sameConnection = job.companyId === companyId() && (job.environment ?? 'sandbox') === 'sandbox';
        const available = sameConnection && settings.enabled && config().configured && connected.companyVerified;
        let tracking = job.status === 'accepted' ? clone(job.tracking ?? initialTracking(job, settings.trackingMaxDays ?? 30)) : null;
        if (tracking?.lease) delete tracking.lease;
        if (tracking) {
          delete tracking.checkedGeneration;
          if (!available && !['booked', 'replaced'].includes(tracking.state)) tracking = { ...tracking, state: 'paused', nextCheckAt: null,
            reason: sameConnection ? 'Anslutningen eller överföringen är avstängd. Senaste bekräftade status behålls.' : 'Underlaget hör till en tidigare Spiris-koppling. Det kontrolleras inte mot det nya företaget.' };
        }
        const related = jobs.filter(item => item.companyId === job.companyId && item.source.approvalId === job.source.approvalId && item.source.hash === job.source.hash);
        const events = related.flatMap(item => publicSpirisEvents(item).map(event => ({ ...event, exportId: item.id, version: item.source.version })))
          .sort((a, b) => a.at.localeCompare(b.at));
        return { id: job.id, cardId: job.source.cardId, approvalId: job.source.approvalId, version: job.source.version, companyId: job.companyId, environment: job.environment ?? 'sandbox', status: job.status,
          startedAt: job.createdAt, finishedAt: job.finishedAt ?? null, supplierId: job.supplierId ?? null, draftId: job.draftId ?? null, reference: job.draft?.InvoiceNumber ?? `AV-${job.source.cardId}-V${job.source.version}`,
          error: job.error ? { code: job.error.code, message: job.error.message } : null, events, tracking,
          booking: job.booking ? { status: job.booking.status, requestedAt: job.booking.requestedAt, checkedAt: job.booking.checkedAt ?? null,
            error: job.booking.error ? clone(job.booking.error) : null } : null,
          relatedAttemptIds: related.map(item => item.id), canExport: false, canRefresh: Boolean(available && job.status === 'accepted' && !['booked', 'replaced'].includes(tracking?.state)),
          canRecreate: Boolean(available && job.status === 'accepted' && tracking?.state === 'missing' && !job.recreation) };

      },
    },
  };
}
