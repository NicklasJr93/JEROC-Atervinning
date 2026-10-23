// SEK cash-accounting cycle. Documents are not ledger entries until payment or
// year-end recognition. Originals and event snapshots are kept for replay.
import { ACCOUNTS, createEmptyState, transact, appendEntry, nextId, addActivity, assert, cents, validDate, requireOpenPeriod } from './core.js';
import { fiscalPeriodForDate } from './fiscal-periods.js';
import { INVOICE_REQUIREMENTS_VERSION, normalizePerformance, assertInvoiceIssuanceReady } from './invoice-requirements.js';
import { normalizeVatExemption, validateVatExemption } from './vat-classification.js';

const EXPENSES = new Set(ACCOUNTS.filter(a => /^[456]/.test(a.number) && !['4960'].includes(a.number)).map(a => a.number));
const VAT_ACCOUNTS = { 25: '2611', 12: '2621', 6: '2631' };
const sum = values => values.reduce((total, value) => { assert(Number.isSafeInteger(value) && Number.isSafeInteger(total + value), 'Kontantmetodens belopp är för stort.'); return total + value; }, 0);
const txt = (value, label, max = 300) => { assert(typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value), `${label} saknas eller är ogiltig.`); return value.trim(); };
const optionalText = (value, label, max) => { assert(typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value), `${label} har fel format.`); return value.trim(); };
const clone = value => structuredClone(value);
const round = (value, numerator, denominator) => Number((BigInt(value) * BigInt(numerator) + BigInt(denominator) / 2n) / BigInt(denominator));
const byAccount = rows => {
  const balances = new Map();
  for (const row of rows) balances.set(row.account, (balances.get(row.account) || 0) + row.debitCents - row.creditCents);
  return [...balances].filter(([, amount]) => amount).sort(([a], [b]) => a.localeCompare(b)).map(([account, amount]) => ({ account, debitCents: Math.max(0, amount), creditCents: Math.max(0, -amount) }));
};
const add = (rows, account, signedDebit) => { if (signedDebit) rows.push({ account, debitCents: Math.max(0, signedDebit), creditCents: Math.max(0, -signedDebit) }); };
function ensureCash(state) {
  assert(state.company.method === 'cash' && state.company.currency === 'SEK', 'Öppna ett övningsbolag med kontantmetoden och SEK.');
  cents(state.company.cashMethodSetup?.expectedTurnoverCents);
  txt(state.company.address, 'Företagets adress');
  assert(state.company.cashMethodSetup?.eligibilityConfirmed === true && state.company.cashMethodSetup.expectedTurnoverCents <= 300_000_000,
    'Kontantmetodens tillämplighet måste bekräftas för ett bolag med normalt högst tre miljoner kronor i årsomsättning.');
}
function linesFor(input, side) {
  assert(Array.isArray(input) && input.length >= 1 && input.length <= 100, 'Ange 1–100 fakturarader.');
  return input.map(line => {
    assert(!line.currency || line.currency === 'SEK', 'Kontantmetoden stöder bara SEK här.');
    assert(!line.rot && !line.reverseConfirmed && (!line.vatMode || line.vatMode === 'standard' || line.vatMode === 'domestic'), 'ROT och särskilda internationella momstidpunkter har ännu inte ett kontantmetodflöde.');
    const description = txt(line.description, 'Radtext');
    const netCents = cents(line.netCents, false), vatRate = Number(line.vatRate ?? 25);
    assert([0, 6, 12, 25].includes(vatRate), 'Välj en svensk momssats: 0, 6, 12 eller 25 procent.');
    const account = side === 'customer' ? '3000' : line.account ?? '4010';
    assert(side === 'customer' || EXPENSES.has(account), 'Välj ett kostnadskonto för inköpet.');
    const deductibleBps = side === 'customer' ? 10000 : line.deductibleBps ?? 10000;
    assert(Number.isInteger(deductibleBps) && deductibleBps >= 0 && deductibleBps <= 10000, 'Avdragsandelen ska vara mellan 0 och 100 procent.');
    const vatCents = round(netCents, vatRate, 100), deductibleVatCents = round(vatCents, deductibleBps, 10000);
    return { description, account, netCents, vatRate, vatCents, deductibleBps, deductibleVatCents, grossCents: cents(netCents + vatCents, false) };
  });
}
function snapshot(doc) {
  const result = Object.fromEntries(['id', 'side', 'partyName', 'partyAddress', 'partyOrgNumber', 'companyDetails', 'date', 'dueDate', 'number', 'reference', 'vatReason', 'supplyConfirmed', 'lines'].map(key => [key, doc[key]]));
  for (const key of ['partyPostalCode','partyCity','partyCountry','performance','vatExemption','requirementsVersion']) if (doc[key] !== undefined) result[key] = doc[key];
  return JSON.stringify(result);
}
function assertCashInvoiceReady(doc) {
  assert(doc.performance?.mode !== 'advance-payment', 'Förskott stöds inte i kontantmetodens fakturaflöde.');
  const performedUntil = doc.performance?.mode === 'period' ? doc.performance.to : doc.performance?.mode === 'date' ? doc.performance.date : doc.date;
  assert(!performedUntil || performedUntil <= doc.date, 'Framtida leverans/utförande kräver ett separat förskottsflöde.');
  assertInvoiceIssuanceReady({ seller: doc.companyDetails,
    customer: { name: doc.partyName, address: doc.partyAddress, postalCode: doc.partyPostalCode, city: doc.partyCity, country: doc.partyCountry },
    date: doc.date, performance: doc.performance, sellerVatRequired: doc.lines.some(line => line.vatRate > 0) });
  if (doc.lines.some(line => line.vatRate === 0)) validateVatExemption(doc.vatExemption);
  else assert(doc.vatExemption === undefined || doc.vatExemption?.code === '' && doc.vatExemption?.legalBasis === '' && doc.vatExemption?.confirmed === false, 'Momsundantag kan bara anges för fakturor med 0 %-rader.');
}

function progress(doc) { return doc.lines.map(line => ({ effective: line.grossCents, recognized: 0, paid: 0 })); }
function allocate(amount, weights) {
  cents(amount); const total = sum(weights);
  assert(amount <= total, 'Beloppet överstiger fakturans återstående belopp.');
  if (!amount) return weights.map(() => 0);
  assert(total > 0, 'Det finns inget belopp att fördela.');
  const fractions = weights.map((weight, index) => ({ index, remainder: BigInt(amount) * BigInt(weight) % BigInt(total), amount: Number(BigInt(amount) * BigInt(weight) / BigInt(total)) }));
  let left = amount - sum(fractions.map(item => item.amount));
  for (const item of [...fractions].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) if (left > 0) { item.amount++; left--; }
  return fractions.map(item => item.amount);
}
function economicRows(rows, doc, index, before, after) {
  const line = doc.lines[index], grossDelta = after - before;
  if (!grossDelta) return;
  if (doc.side === 'customer') {
    const vatDelta = round(after, line.vatCents, line.grossCents) - round(before, line.vatCents, line.grossCents);
    add(rows, '3000', -(grossDelta - vatDelta));
    if (line.vatRate) add(rows, VAT_ACCOUNTS[line.vatRate], -vatDelta);
  } else {
    const vatDelta = round(after, line.deductibleVatCents, line.grossCents) - round(before, line.deductibleVatCents, line.grossCents);
    add(rows, line.account, grossDelta - vatDelta); add(rows, '2641', vatDelta);
  }
}
function eventTaxBoxes(doc, previous, next, rows) {
  const boxes = {};
  if (doc.side === 'customer') doc.lines.forEach((line, index) => {
    const delta = next[index].recognized - previous[index].recognized;
    const vatDelta = round(next[index].recognized, line.vatCents, line.grossCents) - round(previous[index].recognized, line.vatCents, line.grossCents);
    const field = line.vatRate === 0 ? '42' : '05';
    boxes[field] = (boxes[field] ?? 0) + delta - vatDelta;
  });
  for (const row of rows) {
    const signed = row.debitCents - row.creditCents, field = ({ '2611': '10', '2621': '11', '2631': '12', '2641': '48' })[row.account];
    if (field) boxes[field] = (boxes[field] ?? 0) + (field === '48' ? signed : -signed);
  }
  return boxes;
}
function calculateEvent(doc, current, kind, amount) {
  const next = clone(current), rows = [], sideSign = doc.side === 'customer' ? 1 : -1;
  let allocations;
  if (kind === 'payment') assert(amount <= Math.max(0, sum(current.map(p => p.effective - p.paid))), 'Betalningen överstiger fakturans nettokvarvarande belopp.');
  if (kind === 'refund') assert(amount <= Math.max(0, sum(current.map(p => p.paid - p.effective))), 'Återbetalningen överstiger tillgodot.');
  if (kind === 'payment') allocations = allocate(amount, current.map(p => Math.max(0, p.effective - p.paid)));
  else if (kind === 'refund') allocations = allocate(amount, current.map(p => Math.max(0, p.paid - p.effective)));
  else if (kind === 'credit') allocations = allocate(amount, current.map(p => p.effective));
  else if (kind === 'year-end') allocations = current.map(p => p.effective - p.recognized);
  else throw new Error('Okänd händelse för kontantmetoden.');
  allocations.forEach((part, index) => {
    const before = current[index], after = next[index];
    if (kind === 'payment') {
      const carried = Math.min(part, Math.max(0, before.recognized - before.paid));
      after.paid += part; after.recognized += part - carried;
      add(rows, '1930', sideSign * part);
    } else if (kind === 'refund') {
      const carried = Math.min(part, Math.max(0, before.paid - before.recognized));
      after.paid -= part; after.recognized -= part - carried;
      add(rows, '1930', -sideSign * part);
    } else if (kind === 'credit') {
      after.effective -= part;
      const carried = Math.min(part, Math.max(0, before.recognized - before.paid));
      after.recognized -= carried;
    } else { after.recognized += part; }
    economicRows(rows, doc, index, before.recognized, after.recognized);
    assert(after.recognized >= 0 && after.recognized <= doc.lines[index].grossCents && after.paid >= 0 && after.effective >= 0, 'Fakturans delbelopp är inkonsekventa.');
  });
  const beforeBalance = sum(current.map(line => line.recognized - line.paid));
  const afterBalance = sum(next.map(line => line.recognized - line.paid));
  if (doc.side === 'customer') {
    add(rows, '1510', Math.max(0, afterBalance) - Math.max(0, beforeBalance));
    add(rows, '2490', Math.min(0, afterBalance) - Math.min(0, beforeBalance));
  } else {
    add(rows, '2440', -(Math.max(0, afterBalance) - Math.max(0, beforeBalance)));
    add(rows, '1680', -(Math.min(0, afterBalance) - Math.min(0, beforeBalance)));
  }
  return { next, rows: byAccount(rows), allocations };
}
function documentFor(state, id) { const doc = (state.cashDocuments ?? []).find(item => item.id === id); assert(doc, 'Kontantfakturan finns inte.'); return doc; }
function currentProgress(state, doc) {
  let current = progress(doc);
  for (const event of (state.cashEvents ?? []).filter(item => item.documentId === doc.id)) current = calculateEvent(doc, current, event.kind, event.amountCents).next;
  return current;
}
export function getCashDocumentSummary(state, docOrId) {
  const doc = typeof docOrId === 'string' ? documentFor(state, docOrId) : docOrId;
  const p = currentProgress(state, doc), originalCents = sum(doc.lines.map(line => line.grossCents)), effectiveCents = sum(p.map(line => line.effective));
  const paidCents = sum(p.map(line => line.paid)), recognizedCents = sum(p.map(line => line.recognized));
  return { originalCents, effectiveCents, creditCents: originalCents - effectiveCents, paidCents, recognizedCents,
    outstandingCents: Math.max(0, effectiveCents - paidCents), refundableCents: Math.max(0, paidCents - effectiveCents),
    ledgerBalanceCents: recognizedCents - paidCents, unrecognizedCents: effectiveCents - recognizedCents, recognitionNeeded: p.some(line => line.effective !== line.recognized) };
}
function checked(state, mutate) {
  ensureCash(state); validateCashState(state);
  const next = transact(state, mutate); validateCashState(next); return next;
}
export function createCashState({ name = 'Åkes kontantmetod AB', orgNumber, address = 'Exempelvägen 1, Demostaden', start = '2026-01-01', end = '2026-12-31', vatPeriod = 'quarter', expectedTurnoverCents = 0, eligibilityConfirmed = false, postalCode, city, country, vatNumber, legalForm, registeredOffice, inLiquidation } = {}) {
  assert(eligibilityConfirmed === true, 'Bekräfta att företaget får använda kontantmetoden.');
  cents(expectedTurnoverCents); assert(expectedTurnoverCents <= 300_000_000, 'Den här kontantmetoden förutsätter normalt högst tre miljoner kronor i årsomsättning.');
  assert(validDate(start) && validDate(end) && start <= end && ['month', 'quarter', 'year'].includes(vatPeriod), 'Kontrollera räkenskapsår och momsperiod.');
  const state = createEmptyState();
  Object.assign(state.company, { name: txt(name, 'Företagsnamn', 150), orgNumber: txt(orgNumber ?? state.company.orgNumber, 'Organisationsnummer', 40), address: txt(address, 'Företagets adress'), method: 'cash', currency: 'SEK', fiscalYearStart: start, fiscalYearEnd: end, vatPeriod,
    cashMethodSetup: { eligibilityConfirmed: true, expectedTurnoverCents } });
  for (const [key,value] of Object.entries({postalCode,city,country,vatNumber,legalForm,registeredOffice})) if (value !== undefined) state.company[key] = String(value).trim();
  if (inLiquidation !== undefined) { assert(typeof inLiquidation === 'boolean', 'Likvidationsstatus ska vara ja eller nej.'); state.company.inLiquidation = inLiquidation; }
  state.cashDocuments = []; state.cashEvents = [];
  addActivity(state, 'Nytt övningsbolag med kontantmetoden; tidigare demobok ändras inte av denna beräkning.');
  return state;
}
export function createCashDocument(state, payload) {
  return checked(state, draft => {
    assert(payload && ['customer', 'supplier'].includes(payload.side), 'Välj kund- eller leverantörsfaktura.');
    assert(!payload.currency || payload.currency === 'SEK', 'Kontantmetoden stöder bara SEK här.');
    assert(!payload.rot && !payload.reverseConfirmed && (!payload.vatMode || payload.vatMode === 'standard' || payload.vatMode === 'domestic'), 'ROT, omvänd moms och internationella momsfall måste hanteras i särskilt stödda flöden.');
    requireOpenPeriod(draft, payload.date);
    assert(validDate(payload.dueDate) && payload.dueDate >= payload.date, 'Förfallodatumet är ogiltigt.');
    const lines = linesFor(payload.lines, payload.side), reference = txt(payload.reference, 'Fakturareferens', 100);
    assert(!(draft.cashDocuments ?? []).some(item => item.id !== payload.id && item.side === payload.side && item.reference === reference && item.partyName === payload.partyName?.trim()), 'Fakturans referens finns redan för motparten.');
    const existing = payload.id ? documentFor(draft, payload.id) : null;
    assert(!existing || existing.status === 'draft', 'En utfärdad kontantfaktura får inte ändras.');
    const doc = { id: existing?.id ?? nextId(draft, 'cash-document'), side: payload.side, partyName: txt(payload.partyName, 'Motpartens namn', 150), partyAddress: txt(payload.partyAddress, 'Motpartens adress'),
      partyOrgNumber: String(payload.partyOrgNumber ?? '').trim().slice(0, 40), date: payload.date, dueDate: payload.dueDate, reference, vatReason: String(payload.vatReason ?? '').trim().slice(0, 300), supplyConfirmed: payload.supplyConfirmed === true,
      partyPostalCode: optionalText(payload.partyPostalCode ?? '', 'Motpartens postnummer', 30), partyCity: optionalText(payload.partyCity ?? '', 'Motpartens ort', 150), partyCountry: optionalText(payload.partyCountry ?? 'SE', 'Motpartens landkod', 2),
      performance: normalizePerformance(payload.performance), vatExemption: normalizeVatExemption(payload.vatExemption),
      status: 'draft', number: '', lines };
    draft.cashDocuments ??= []; if (existing) Object.assign(existing, doc); else draft.cashDocuments.push(doc);
    addActivity(draft, `Kontantmetod: fakturautkast ${reference} registrerat utan bokföring.`, doc.id);
  });
}
export function issueCashDocument(state, id) {
  return checked(state, draft => {
    const doc = documentFor(draft, id); assert(doc.status === 'draft', 'Fakturan är redan utfärdad.'); requireOpenPeriod(draft, doc.date);
    assert(doc.supplyConfirmed, 'Bekräfta att leveransen eller arbetet är utfört; förskott ingår inte i detta flöde.');
    assert(doc.lines.every(line => line.vatRate !== 0) || doc.vatReason || doc.vatExemption?.confirmed, 'Ange skälet till fakturering utan moms.');
    const prefix = doc.side === 'customer' ? 'CF' : 'CL';
    const numbers = draft.cashDocuments.map(item => new RegExp(`^${prefix}-(\\d+)$`).exec(item.number)).filter(Boolean).map(match => Number(match[1]));
    doc.number = `${prefix}-${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}`; doc.status = 'issued';
    doc.companyDetails = { name: draft.company.name, orgNumber: draft.company.orgNumber, address: draft.company.address };
    if (doc.side === 'customer') {
      for (const key of ['postalCode','city','country','vatNumber','legalForm','registeredOffice','inLiquidation']) doc.companyDetails[key] = draft.company[key];
      assertCashInvoiceReady(doc);
      if (!doc.lines.some(line => line.vatRate === 0)) delete doc.vatExemption;
      if (doc.performance.mode === 'invoice-date') doc.performance = { mode: 'date', date: doc.date, confirmed: true };
      doc.requirementsVersion = INVOICE_REQUIREMENTS_VERSION;
    }
    doc.snapshot = snapshot(doc);
    addActivity(draft, `${doc.number} utfärdad/registrerad. Bokföring sker vid betalning eller årsslut.`, doc.id);
  });
}
function appendCashEvent(state, id, { kind, date, amountCents = 0, reference, bankEventId = '', reviewed = false, reason = '' }) {
  return checked(state, draft => {
    const doc = documentFor(draft, id); assert(doc.status === 'issued', 'Utfärda eller registrera fakturan först.'); requireOpenPeriod(draft, date);
    assert(date >= doc.date && (draft.cashEvents ?? []).filter(e => e.documentId === id).every(e => e.date <= date), 'Datumet får inte ligga före fakturan eller en tidigare fakturahändelse.');
    if (kind === 'year-end') assert(date === draft.company.fiscalYearEnd && reviewed, 'Årsskiftesbokning kräver granskning och årets sista dag.');
    else cents(amountCents, false);
    const ref = txt(reference, 'Händelsereferens', 100);
    assert(!(draft.cashEvents ?? []).some(e => e.reference === ref), 'Händelsereferensen finns redan.');
    const before = currentProgress(draft, doc), calculated = calculateEvent(doc, before, kind, amountCents);
    const taxBoxes = eventTaxBoxes(doc, before, calculated.next, calculated.rows);
    assert(!Object.values(taxBoxes).some(amount => amount !== 0) || !draft.vatReturns.some(period => date >= period.from && date <= period.to), 'Momsperioden är redan fastställd. En senare momsändring behöver bokföras i en öppen, ännu inte fastställd period.');
    // Equal-account line movements can cancel in the ledger while their
    // recognition allocations still need to be closed for the next year.
    if (kind === 'year-end') assert(calculated.allocations.some(part => part !== 0), 'Fakturan har inget kvar att bokföra vid årsslut.');
    const event = { id: nextId(draft, 'cash-event'), documentId: id, kind, date, reference: ref, amountCents,
      allocations: calculated.allocations, rows: calculated.rows, createdAt: new Date().toISOString() };
    if (kind === 'credit' && doc.side === 'supplier') {
      const accounts = new Set(doc.lines.map(line => line.account));
      assert(!(accounts.has('5410') && draft.assets.some(a => a.status === 'active')) && !(accounts.has('4010') && draft.inventoryValuations.length) && !draft.accruals.some(a => accounts.has(a.expenseAccount)), 'Återför först inventarie, lagervärdering eller periodisering som använder inköpets kostnad.');
    }
    if (kind === 'credit') event.reason = txt(reason, 'Orsak till krediteringen', 500);
    if (kind === 'credit') event.number = `CK-${String((draft.cashEvents ?? []).filter(e => e.kind === 'credit').length + 1).padStart(4, '0')}`;
    if (calculated.rows.length) {
      const entry = appendEntry(draft, { date, description: `${doc.number} · ${kind === 'payment' ? 'betalning' : kind === 'refund' ? 'återbetalning' : kind === 'credit' ? 'kreditnota' : 'årsskiftesbokning'}`, sourceType: `cash-${kind}`, sourceId: event.id, rows: calculated.rows });
      event.entryId = entry.id;
      if (['payment', 'refund'].includes(kind)) {
        const sign = (doc.side === 'customer' ? 1 : -1) * (kind === 'refund' ? -1 : 1);
        let bank;
        if (bankEventId) {
          bank = draft.bankTransactions.find(item => item.id === bankEventId);
          assert(bank && !bank.matchedEntryId && bank.account === '1930' && bank.date === date && bank.amountCents === sign * amountCents, 'Den valda kontohändelsen stämmer inte med betalningen eller är redan matchad.');
          bank.matchedEntryId = entry.id;
        } else {
          bank = { id: nextId(draft, 'bank'), date, account: '1930', description: `${doc.number} · ${reference}`, amountCents: sign * amountCents, matchedEntryId: entry.id };
          draft.bankTransactions.push(bank);
        }
        event.bankEventId = bank.id;
      }
    }
    draft.cashEvents ??= []; draft.cashEvents.push(event);
    addActivity(draft, `${event.number ?? doc.number}: ${kind} registrerad med bevarat original.`, event.id);
  });
}
export const payCashDocument = (state, id, input) => appendCashEvent(state, id, { ...input, kind: 'payment' });
export const creditCashDocument = (state, id, input) => appendCashEvent(state, id, { ...input, kind: 'credit' });
export const refundCashDocument = (state, id, input) => appendCashEvent(state, id, { ...input, kind: 'refund' });
export function recognizeCashYearEnd(state, { date = state.company.fiscalYearEnd, reference = `AR-${date}`, reviewed = false } = {}) {
  ensureCash(state); assert(reviewed === true, 'Granska de obetalda fakturorna före årsskiftesbokningen.');
  let next = state, count = 0;
  for (const doc of state.cashDocuments ?? []) if (doc.status === 'issued' && doc.date <= date && getCashDocumentSummary(next, doc).recognitionNeeded) {
    next = appendCashEvent(next, doc.id, { kind: 'year-end', date, reference: `${reference}:${doc.id}`, reviewed }); count++;
  }
  assert(count > 0, 'Inga obetalda belopp återstår att bokföra vid årsslut.'); return next;
}
export function getCashClosingIssues(state) {
  if (state.company.method !== 'cash') return [];
  return (state.cashDocuments ?? []).filter(doc => doc.date <= state.company.fiscalYearEnd).flatMap(doc => doc.status === 'draft'
    ? [{ id: doc.id, reason: `${doc.reference}: hantera utkastet före årsavslut.` }]
    : getCashDocumentSummary(state, doc).recognitionNeeded ? [{ id: doc.id, reason: `${doc.number}: obetalda belopp behöver årsskiftesbokas.` }] : []);
}
export function validateCashState(state) {
  const docs = state.cashDocuments ?? [], events = state.cashEvents ?? [];
  const claimedEntryIds = [], result = { claimedEntryIds, receivableAdjustmentCents: 0, payableAdjustmentCents: 0, accountAdjustments: { '1680': 0, '2490': 0 } };
  if (!docs.length && !events.length && state.company.method !== 'cash') return result;
  ensureCash(state); assert(!state.invoices.length && !state.bills.length && !(state.fxDocuments ?? []).length, 'Kontantmetodens bolag får inte blanda faktureringsmetodens dokument eller valuta ännu.');
  const docIds = new Set(), numbers = new Set(), refs = new Set(), eventIds = new Set(), invoiceRefs = new Set(), creditNumbers = new Set();
  for (const doc of docs) {
    assert(doc && typeof doc.id === 'string' && !docIds.has(doc.id), 'Kontantfakturans ID är dubblerat.'); docIds.add(doc.id);
    assert(['customer', 'supplier'].includes(doc.side) && ['draft', 'issued'].includes(doc.status), 'Kontantfakturans typ eller status är ogiltig.');
    txt(doc.partyName, 'Motpart', 150); txt(doc.partyAddress, 'Adress'); txt(doc.reference, 'Fakturareferens', 100);
    const invoiceRef = JSON.stringify([doc.side, doc.partyName, doc.reference]);
    assert(!invoiceRefs.has(invoiceRef), 'Fakturareferensen har dubblerats för samma motpart.'); invoiceRefs.add(invoiceRef);
    assert(validDate(doc.date) && fiscalPeriodForDate(state, doc.date) && validDate(doc.dueDate) && doc.dueDate >= doc.date, 'Fakturans datum är ogiltiga.');
    const expectedLines = linesFor(doc.lines, doc.side);
    assert(JSON.stringify(expectedLines) === JSON.stringify(doc.lines), 'Fakturaradernas frysta belopp har ändrats.');
    if (doc.status === 'draft') assert(doc.number === '' && !doc.snapshot && !events.some(e => e.documentId === doc.id), 'Utkastet har utfärdade händelser.');
    else {
      assert(new RegExp(`^${doc.side === 'customer' ? 'CF' : 'CL'}-\\d{4,}$`).test(doc.number) && !numbers.has(doc.number) && doc.snapshot === snapshot(doc) && doc.supplyConfirmed, 'Originalfakturan eller dess nummer har ändrats.'); numbers.add(doc.number);
      txt(doc.companyDetails?.name, 'Ursprungligt företagsnamn', 150); txt(doc.companyDetails?.orgNumber, 'Ursprungligt organisationsnummer', 40); txt(doc.companyDetails?.address, 'Ursprunglig företagsadress');
      assert(doc.lines.every(line => line.vatRate !== 0) || doc.vatReason || doc.vatExemption?.confirmed, 'Momsfri faktura saknar motivering.');
      if (doc.requirementsVersion !== undefined) { assert(doc.side === 'customer' && doc.requirementsVersion === INVOICE_REQUIREMENTS_VERSION, 'Fakturakravens version är ogiltig.'); assertCashInvoiceReady(doc); }
    }
    let current = progress(doc), lastDate = doc.date;
    for (const event of events.filter(item => item.documentId === doc.id)) {
      assert(!eventIds.has(event.id), 'Händelsens ID har dubblerats.'); eventIds.add(event.id);
      assert(validDate(event.date) && fiscalPeriodForDate(state, event.date) && event.date >= lastDate && ['payment', 'credit', 'refund', 'year-end'].includes(event.kind), 'Fakturans händelseordning eller datum är ogiltiga.'); lastDate = event.date;
      if (event.kind === 'credit') { txt(event.reason, 'Kreditorsak', 500); assert(/^CK-\d{4,}$/.test(event.number) && !creditNumbers.has(event.number), 'Kreditnotans nummer är ogiltigt eller dubblerat.'); creditNumbers.add(event.number); }
      assert(typeof event.createdAt === 'string' && Number.isFinite(Date.parse(event.createdAt)), 'Händelsens tidsstämpel saknas.');
      txt(event.reference, 'Händelsereferens', 100); assert(!refs.has(event.reference), 'Händelsereferensen har dubblerats.'); refs.add(event.reference);
      if (event.kind === 'year-end') assert(event.date === fiscalPeriodForDate(state, event.date).end && event.amountCents === 0, 'Årsskifteshändelsen har fel datum eller belopp.'); else cents(event.amountCents, false);
      const expected = calculateEvent(doc, current, event.kind, event.amountCents);
      assert(JSON.stringify(event.rows) === JSON.stringify(expected.rows) && JSON.stringify(event.allocations) === JSON.stringify(expected.allocations), 'Kontantmetodens händelsebelopp har ändrats.');
      if (expected.rows.length) {
        const entry = state.entries.find(item => item.id === event.entryId);
        assert(entry && entry.sourceType === `cash-${event.kind}` && entry.sourceId === event.id && entry.date === event.date && JSON.stringify(entry.rows) === JSON.stringify(expected.rows), 'Kontantmetodens verifikation saknas eller har ändrats.'); claimedEntryIds.push(entry.id);
        if (['payment', 'refund'].includes(event.kind)) {
          const bank = state.bankTransactions.find(item => item.id === event.bankEventId), sign = (doc.side === 'customer' ? 1 : -1) * (event.kind === 'refund' ? -1 : 1);
          assert(bank && bank.matchedEntryId === entry.id && bank.account === '1930' && bank.date === event.date && bank.amountCents === sign * event.amountCents, 'Kontantmetodens bankhändelse saknas eller har ändrats.');
        } else assert(!event.bankEventId, 'Händelsen har en otillåten bankkoppling.');
      } else assert(!event.entryId && !event.bankEventId && (event.kind === 'credit' || event.kind === 'year-end' && expected.allocations.some(part => part !== 0)), 'En händelse saknar bokföring.');
      current = expected.next;
    }
    const balance = sum(current.map(line => line.recognized - line.paid));
    if (doc.side === 'customer') { result.receivableAdjustmentCents += Math.max(0,balance); result.accountAdjustments['2490'] += Math.min(0,balance); } else { result.payableAdjustmentCents += Math.max(0,balance); result.accountAdjustments['1680'] -= Math.min(0,balance); }
  }
  assert(events.every(event => docIds.has(event.documentId)), 'En kontanthändelse saknar originalfaktura.');
  assert(state.entries.filter(entry => entry.sourceType.startsWith('cash-')).every(entry => claimedEntryIds.includes(entry.id)), 'En kontantverifikation saknar verifierad händelse.');
  return result;
}

export function deleteCashDraft(state, id) {
  return checked(state, draft => { const doc = documentFor(draft, id); assert(doc.status === 'draft', 'Bara ett obokfört utkast kan tas bort.'); draft.cashDocuments = draft.cashDocuments.filter(item => item.id !== id); addActivity(draft, `Kontantutkast ${doc.reference} borttaget.`, id); });
}

export function getCashTaxRows(state) {
  const output=[];
  for (const doc of state.cashDocuments ?? []) {
    let previous=progress(doc);
    for (const event of (state.cashEvents ?? []).filter(item=>item.documentId===doc.id)) {
      const next=calculateEvent(doc,previous,event.kind,event.amountCents).next;
      if (event.entryId || event.kind === 'year-end') {
        const boxes = eventTaxBoxes(doc, previous, next, event.rows);
        // A zero-net closing allocation may still reclassify taxable/exempt
        // bases even when no ledger account changes by a whole öre.
        if (event.entryId || Object.values(boxes).some(amount => amount !== 0)) output.push({entryId:event.entryId ?? null,date:event.date,description:`${doc.number} · kontantmetoden`,boxes,...(doc.side === 'customer' && doc.requirementsVersion !== INVOICE_REQUIREMENTS_VERSION && (boxes['42'] ?? 0) !== 0 ? {requiresVatReview:true} : {})});
      }
      previous=next;
    }
  }
  return output;
}
