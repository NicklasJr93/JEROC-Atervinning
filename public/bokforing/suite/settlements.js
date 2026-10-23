// Credit notes, repayments and explicit offsets for the browser-local demo.
// Originals are never rewritten. New documents are independently journaled.
import { assert, cents, validDate, requireOpenPeriod, transact, nextId, appendEntry, addActivity } from './core.js';
import { calculateLineAmounts } from './rot.js';
import { invoiceBookingSnapshot, getInvoiceTotals } from './sales.js';
import { billSnapshot } from './purchase-data.js';
import * as Purchases from './operations.js';
import { fiscalPeriodForDate } from './fiscal-periods.js';
import { calculateRevenueCreditAdjustments, revenuePrincipal } from './revenue-credit.js';
import { applyRotCreditDraft, getRotCreditState, rotCreditLimit, syncRotCredit, validateRotCreditEvents } from './rot-credit.js';

const MIRRORS = ['settlementCreditCents', 'settlementRefundCents', 'settlementOffsetInCents', 'settlementOffsetOutCents'];
const row = (account, debitCents = 0, creditCents = 0) => ({ account, debitCents, creditCents });
const sum = values => values.reduce((value, next) => { assert(Number.isSafeInteger(next) && Number.isSafeInteger(value + next), 'Beloppssumman är för stor.'); return value + next; }, 0);
const text = (value, label, max = 300) => { assert(typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value), `${label} saknas eller har fel format.`); return value.trim(); };
const key = (side, id) => `${side}:${id}`;
const records = state => state.settlements ?? [];
const rounded = (amount, numerator, denominator) => Number((BigInt(amount) * BigInt(numerator) + BigInt(denominator) / 2n) / BigInt(denominator));
const mirrorValues = () => Object.fromEntries(MIRRORS.map(name => [name, 0]));
const documentSnapshot = (side, document) => side === 'customer' ? invoiceBookingSnapshot(document) : billSnapshot(document);

function sourceDocument(state, side, id) {
  assert(['customer', 'supplier'].includes(side), 'Välj kund eller leverantör.');
  const source = (side === 'customer' ? state.invoices : state.bills).find(item => item.id === id);
  assert(source && (side === 'customer' ? source.kind === 'invoice' && source.status === 'issued' : source.status === 'booked'), 'Välj en bokförd originalfaktura.');
  assert(source.bookingSnapshot === documentSnapshot(side, source), 'Originalfakturans frysta uppgifter har ändrats.');
  const entry = state.entries.find(item => item.id === source.entryId);
  assert(entry && entry.sourceId === source.id && entry.sourceType === (side === 'customer' ? 'invoice' : 'bill'), 'Originalfakturans bokföring saknas.');
  return source;
}

export function getDocumentBalance(side, document) {
  const gross = side === 'customer' ? getInvoiceTotals(document).grossCents : document.totalCents;
  return sum([gross, -sum((document.payments ?? []).map(payment => payment.amountCents)),
    -(document.settlementCreditCents ?? 0), document.settlementRefundCents ?? 0,
    document.settlementOffsetOutCents ?? 0, -(document.settlementOffsetInCents ?? 0), side === 'customer' ? document.rotRepaymentCents ?? 0 : 0]);
}

export function getDocumentSettlementSummary(side, document) {
  const balanceCents = getDocumentBalance(side, document);
  return { balanceCents, outstandingCents: Math.max(0, balanceCents), refundableCents: Math.max(0, -balanceCents),
    creditCents: document.settlementCreditCents ?? 0, refundCents: document.settlementRefundCents ?? 0 };
}

// A line's original posted VAT is allocated cumulatively. Several small credits
// therefore reverse exactly the original öre when the final remainder is credited.
export function getCreditSourceLines(state, side, id) {
  const source = sourceDocument(state, side, id);
  const sourceLines = side === 'customer' ? source.lines : source.lines ?? [{ description: source.number, netCents: source.netCents }];
  return sourceLines.map((line, index) => {
    let netCents, rows;
    if (side === 'customer') {
      const amounts = calculateLineAmounts(line, source.vatMode, source.invoiceDiscountBps ?? 0);
      netCents = amounts.netCents;
      rows = [row('1510', amounts.grossCents), row(source.vatMode === 'reverse-construction' ? '3231' : '3000', 0, netCents)];
      if (amounts.vatCents) rows.push(row({ 25: '2611', 12: '2621', 6: '2631' }[line.vatRate], 0, amounts.vatCents));
    } else {
      netCents = line.netCents;
      rows = source.lines ? Purchases.getBillLineBookingRows(source, index) : Purchases.getBillBookingRows(source);
    }
    const creditedNetCents = sum(records(state).filter(record => record.kind === 'credit' && record.side === side && record.documentId === id)
      .flatMap(record => record.lines.filter(item => item.index === index).map(item => item.netCents)));
    return { index, description: line.description || `Rad ${index + 1}`, netCents, creditedNetCents, remainingNetCents: netCents - creditedNetCents, rows };
  });
}

function creditRows(state, side, id, selections, priorCredits = null, beforeEntryId = null) {
  assert(Array.isArray(selections) && selections.length > 0 && selections.length <= 100, 'Välj minst en rad att kreditera.');
  const lines = getCreditSourceLines(state, side, id);
  const seen = new Set(), selected = [], posting = [];
  const control = side === 'customer' ? '1510' : '2440';
  for (const selection of selections) {
    assert(selection && Number.isSafeInteger(selection.index) && !seen.has(selection.index), 'Kreditraden är ogiltig eller förekommer flera gånger.');
    seen.add(selection.index);
    const original = lines[selection.index];
    assert(original, 'Originalraden saknas.');
    const amount = cents(selection.netCents, false);
    const before = priorCredits ? priorCredits.get(selection.index) ?? 0 : original.creditedNetCents;
    assert(before + amount <= original.netCents, 'Krediteringen överstiger originalradens återstående nettobelopp.');
    const partial = original.rows.filter(item => item.account !== control).map(item => {
      const difference = value => rounded(value, before + amount, original.netCents) - rounded(value, before, original.netCents);
      return row(item.account, difference(item.creditCents), difference(item.debitCents));
    }).filter(item => item.debitCents || item.creditCents);
    const delta = sum(partial.map(item => item.debitCents - item.creditCents));
    const lineGross = side === 'customer' ? delta : -delta;
    cents(lineGross, false);
    posting.push(...partial, side === 'customer' ? row(control, 0, lineGross) : row(control, lineGross));
    selected.push({ index: selection.index, netCents: amount });
    if (priorCredits) priorCredits.set(selection.index, before + amount);
  }
  const amountCents = sum(posting.filter(item => item.account === control).map(item => side === 'customer' ? item.creditCents : item.debitCents));
  const revenueAdjustments=side==='customer'?calculateRevenueCreditAdjustments(state,id,sum(selected.map(item=>item.netCents)),beforeEntryId):[];
  for(const adjustment of revenueAdjustments){
    let remaining=adjustment.deferredCents;
    const plan=(state.revenueSchedules??[]).find(item=>item.id===adjustment.planId);
    for(const item of posting)if(item.account===plan.revenueAccount&&item.debitCents&&remaining){const take=Math.min(item.debitCents,remaining);item.debitCents-=take;remaining-=take;}
    assert(remaining===0,'Periodiseringskrediten överstiger intäktsraden.');
    if(adjustment.deferredCents)posting.push(row('2990',adjustment.deferredCents));
  }
  return { lines: selected, rows: posting.filter(item=>item.debitCents||item.creditCents), amountCents: cents(amountCents, false), revenueAdjustments };
}

const recordSnapshot = record => JSON.stringify(Object.fromEntries(Object.entries(record).filter(([name]) => name !== 'snapshot')));
function latestDate(source, relevant) {
  return [source.date, ...(source.payments ?? []).map(payment => payment.date), ...relevant.map(record => record.date)].sort().at(-1);
}
function operationDate(state, side, source, date, extraId = null) {
  requireOpenPeriod(state, date);
  const relevant = records(state).filter(record => record.side === side && ([source.id, extraId].includes(record.documentId) || [source.id, extraId].includes(record.targetDocumentId)));
  assert(date >= latestDate(source, relevant), 'Åtgärden får inte dateras före fakturans senaste betalning, kredit eller kvittning.');
  return date;
}
function nextCreditNumber(state, side) {
  const prefix = side === 'customer' ? 'K' : 'LK';
  const all = [...records(state), ...state.invoices];
  const used = all.map(item => new RegExp(`^${prefix}-(\\d+)$`).exec(item.number ?? '')).filter(Boolean).map(match => Number(match[1]));
  return `${prefix}-${String(Math.max(0, ...used) + 1).padStart(4, '0')}`;
}
function attachMirrors(state) {
  const totals = new Map();
  const take = (side, id) => { const idKey = key(side, id); if (!totals.has(idKey)) totals.set(idKey, { ...mirrorValues(), settlementLastDate: '' }); return totals.get(idKey); };
  for (const record of records(state)) {
    const values = take(record.side, record.documentId);
    values.settlementLastDate = [values.settlementLastDate, record.date].sort().at(-1);
    if (record.kind === 'credit') values.settlementCreditCents = cents(values.settlementCreditCents + record.amountCents);
    if (record.kind === 'refund') values.settlementRefundCents = cents(values.settlementRefundCents + record.amountCents);
    if (record.kind === 'offset') {
      values.settlementOffsetOutCents = cents(values.settlementOffsetOutCents + record.amountCents);
      const target = take(record.side, record.targetDocumentId);
      target.settlementOffsetInCents = cents(target.settlementOffsetInCents + record.amountCents);
      target.settlementLastDate = [target.settlementLastDate, record.date].sort().at(-1);
    }
  }
  for (const [side, documents] of [['customer', state.invoices], ['supplier', state.bills]]) for (const document of documents) {
    const values = totals.get(key(side, document.id));
    if (values) Object.assign(document, values);
  }
  return totals;
}
function addRecord(state, values, rows) {
  const id = nextId(state, 'settlement');
  const record = { id, ...values };
  record.entryId = appendEntry(state, { date: record.date, description: `${{ credit: 'Kredit', refund: 'Återbetalning', offset: 'Kvittning' }[record.kind]} · ${record.number || record.reference}`,
    sourceType: `settlement-${record.kind}`, sourceId: id, rows }).id;
  record.snapshot = recordSnapshot(record);
  (state.settlements ??= []).push(record);
  attachMirrors(state);
  addActivity(state, `${{ credit: 'Kreditnota bokförd', refund: 'Återbetalning registrerad', offset: 'Kredit kvittad' }[record.kind]} · ${record.number || record.reference}`, id);
  return record;
}
function transition(state, mutation) {
  validateSettlements(state);
  const next = transact(state, draft => {
    mutation(draft);
    assert(records(state).every((record, index) => JSON.stringify(record) === JSON.stringify(records(draft)[index])), 'Bokförda krediter och återbetalningar får inte ändras eller raderas.');
    validateSettlements(draft);
  });
  return next;
}
function uniqueReference(state, side, kind, sourceId, reference) {
  assert(!records(state).some(record => record.side === side && record.kind === kind && record.documentId === sourceId && record.reference === reference), 'Åtgärden med den här referensen är redan bokförd.');
}

function requireCreditTaxPeriodOpen(state, side, source, date, selections) {
  // Zero output tax can still change declared sales or reverse-charge bases.
  const changesBasis=selections.some(selection=>selection.netCents>0&&(side==='customer'||(source.lines?.[selection.index]?.vatMode??source.vatMode)==='reverse-construction'));
  assert(!changesBasis || !state.vatReturns.some(period=>date>=period.from&&date<=period.to),
    'Momsperioden är redan fastställd. En senare momsändring behöver bokföras i en öppen, ännu inte fastställd period.');
}

// A preview is calculated from the original journal and current correction history.
// The fingerprint prevents a saved review from silently applying to a new balance.
export function previewCreditNote(state,payload) {
  const {side,documentId,date}=payload,source=sourceDocument(state,side,documentId);
  operationDate(state,side,source,date);
  text(payload.reason,'Krediteringsorsak');text(payload.reference,'Kreditens referens',100);
  uniqueReference(state,side,'credit',documentId,payload.reference);
  assert((state.revenueSchedules??[]).filter(item=>item.invoiceId===documentId).every(item=>item.date<=date&&item.postings.every(posting=>posting.date<=date)),'Krediten får inte dateras före intäktsperiodiseringens start eller redan bokförd intäktsföring.');
  const calculated=creditRows(state,side,documentId,payload.lines);
  requireCreditTaxPeriodOpen(state,side,source,date,calculated.lines);
  const hasRevenue=side==='customer'&&(state.revenueSchedules??[]).some(item=>item.invoiceId===documentId);
  let rot=null;
  if(source.rot){
    const current=getRotCreditState(state,documentId),before=current?.allowedCents??source.rot.approvedCents??source.rot.reservedCents;
    const temporary={...state,settlements:[...records(state),{kind:'credit',side,documentId,lines:calculated.lines,amountCents:calculated.amountCents}]};
    const after=Math.min(before,rotCreditLimit(temporary,documentId));
    const paid=sum(source.payments.filter(item=>item.payer==='tax').map(item=>item.amountCents))-(source.rotRepaymentCents??0);
    rot={beforeCents:before,afterCents:after,taxRepaymentCents:Math.max(0,paid-after)};
  }
  const input=JSON.stringify([state.entries,state.invoices,state.bills,state.settlements,state.rotCreditEvents,state.revenueSchedules]);
  let hash=2166136261;for(let i=0;i<input.length;i++)hash=Math.imul(hash^input.charCodeAt(i),16777619);
  return {payload:{side,documentId,date,reason:payload.reason,reference:payload.reference,lines:calculated.lines},fingerprint:(hash>>>0).toString(16),hasRevenue,rot,...calculated};
}

export function createCreditNote(state, { side, documentId, date, reason, reference, lines, specialReviewed=false, rotCaseAdjusted=false, taxRefundConfirmed=false, taxReference='' }) {
  return transition(state, draft => {
    const source = sourceDocument(draft, side, documentId);
    operationDate(draft, side, source, date);
    assert((draft.revenueSchedules??[]).filter(item=>item.invoiceId===documentId).every(item=>item.date<=date&&item.postings.every(posting=>posting.date<=date)),'Krediten får inte dateras före intäktsperiodiseringens start eller redan bokförd intäktsföring.');
    reason = text(reason, 'Krediteringsorsak'); reference = text(reference, 'Kreditens referens', 100);
    uniqueReference(draft, side, 'credit', documentId, reference);
    const calculated = creditRows(draft, side, documentId, lines);
    requireCreditTaxPeriodOpen(draft, side, source, date, calculated.lines);
    const hasRevenue=side==='customer'&&(draft.revenueSchedules??[]).some(item=>item.invoiceId===documentId);
    if(hasRevenue||source.rot)assert(specialReviewed===true,'Granska och bekräfta ROT eller intäktsperiodisering före bokföring.');
    const record=addRecord(draft, { kind: 'credit', side, documentId, sourceEntryId: source.entryId, sourceSnapshot: documentSnapshot(side, source),
      date, reason, reference, number: nextCreditNumber(draft, side), lines: calculated.lines, amountCents: calculated.amountCents, ...(hasRevenue?{revenueAdjustments:calculated.revenueAdjustments,specialReviewed:true}:{}) }, calculated.rows);
    if(source.rot)applyRotCreditDraft(draft,source,record,{rotCaseAdjusted,taxRefundConfirmed,taxReference,reason});
    for(const plan of draft.revenueSchedules??[])if(plan.invoiceId===documentId&&revenuePrincipal(draft,plan).principalCents===0)plan.status='cancelled';
  });
}

export function refundCredit(state, { side, documentId, date, amountCents, reference, bankEventId = null }) {
  return transition(state, draft => {
    const source = sourceDocument(draft, side, documentId);
    operationDate(draft, side, source, date);
    amountCents = cents(amountCents, false); reference = text(reference, 'Betalningsreferens', 100);
    uniqueReference(draft, side, 'refund', documentId, reference);
    assert(amountCents <= getDocumentSettlementSummary(side, source).refundableCents, 'Återbetalningen överstiger fakturans kvarvarande tillgodobelopp.');
    const sign = side === 'customer' ? -1 : 1;
    let bank = bankEventId ? draft.bankTransactions.find(item => item.id === bankEventId) : null;
    if (bankEventId) assert(bank && !bank.matchedEntryId && bank.account === '1930' && bank.date === date && bank.amountCents === sign * amountCents,
      'Välj en omatchad bankhändelse med samma datum, konto, belopp och betalningsriktning.');
    const control = side === 'customer' ? '1510' : '2440';
    const posting = side === 'customer' ? [row(control, amountCents), row('1930', 0, amountCents)] : [row('1930', amountCents), row(control, 0, amountCents)];
    const record = addRecord(draft, { kind: 'refund', side, documentId, sourceEntryId: source.entryId,
      date, reference, amountCents, bankEventId: bankEventId || nextId(draft, 'bank') }, posting);
    if (bank) bank.matchedEntryId = record.entryId;
    else draft.bankTransactions.push({ id: record.bankEventId, date, description: `Återbetalning · ${source.number} · ${reference}`, account: '1930', amountCents: sign * amountCents, matchedEntryId: record.entryId });
    if(source.rot&&getRotCreditState(draft,source.id))syncRotCredit(draft,source.id);
  });
}

function sameParty(side, source, target) {
  return side === 'customer' ? source.customerId === target.customerId : source.supplier.trim().toLocaleLowerCase('sv') === target.supplier.trim().toLocaleLowerCase('sv');
}
export function offsetCredit(state, { side, documentId, targetDocumentId, date, amountCents, reference }) {
  return transition(state, draft => {
    const source = sourceDocument(draft, side, documentId), target = sourceDocument(draft, side, targetDocumentId);
    assert(!source.rot&&!target.rot,'ROT-fakturor kvittas inte; använd spårbar kundbetalning eller återbetalning.');
    assert(source.id !== target.id && sameParty(side, source, target), 'Kvittning kräver två olika fakturor för samma kund eller leverantör.');
    operationDate(draft, side, source, date, target.id); operationDate(draft, side, target, date, source.id);
    amountCents = cents(amountCents, false); reference = text(reference, 'Kvittningsreferens', 100);
    uniqueReference(draft, side, 'offset', documentId, reference);
    assert(amountCents <= getDocumentSettlementSummary(side, source).refundableCents && amountCents <= getDocumentSettlementSummary(side, target).outstandingCents,
      'Kvittningen överstiger tillgodobeloppet eller målfakturans kvarvarande skuld.');
    const control = side === 'customer' ? '1510' : '2440';
    addRecord(draft, { kind: 'offset', side, documentId, targetDocumentId, sourceEntryId: source.entryId, targetEntryId: target.entryId,
      date, reference, amountCents }, [row(control, amountCents), row(control, 0, amountCents)]);
  });
}

function equalRows(actual, expected) {
  const aggregate = rows => {
    const values = new Map();
    for (const item of rows) { const prior = values.get(item.account) ?? [0, 0]; prior[0] += item.debitCents; prior[1] += item.creditCents; values.set(item.account, prior); }
    return JSON.stringify([...values].filter(([, values]) => values[0] || values[1]).sort(([a], [b]) => a.localeCompare(b)));
  };
  return aggregate(actual) === aggregate(expected);
}

// Returned adjustments extend the ordinary reskontra reconciliation; they are
// signed receivable/payable balances, not just positive "amount due" figures.
export function validateSettlements(state) {
  assert(state.settlements === undefined || Array.isArray(state.settlements) && state.settlements.length <= 20000, 'Kredit- och återbetalningshistoriken är ogiltig.');
  const all = records(state), ids = new Set(), entryIds = new Set(), numbers = new Set(state.invoices.map(item => item.number).filter(Boolean)), references = new Set();
  const prior = [], byLine = new Map(), mirrored = new Map();
  const take = (side, id) => { const idKey = key(side, id); if (!mirrored.has(idKey)) mirrored.set(idKey, { ...mirrorValues(), settlementLastDate: '' }); return mirrored.get(idKey); };
  const balanceBefore = (side, source, record) => {
    const values = mirrored.get(key(side, source.id)) ?? mirrorValues(), index=state.entries.findIndex(entry=>entry.id===record.entryId);
    const priorEntry=id=>state.entries.findIndex(entry=>entry.id===id)<index;
    const corrected=getRotCreditState(state,source.id);
    const repayments=corrected?corrected.events[0].original.rotRepaymentCents+sum(corrected.events.filter(event=>(event.kind==='credit'||event.kind==='recovery')&&event.entryId&&priorEntry(event.entryId)).map(event=>event.kind==='credit'?event.taxRepaymentCents:event.amountCents)):source.rotRepaymentCents??0;
    return getDocumentBalance(side, { ...source, rotRepaymentCents:repayments,payments: source.payments.filter(payment => payment.date <= record.date&&priorEntry(payment.entryId)), ...values });
  };
  for (const record of all) {
    assert(record && typeof record.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(record.id) && !ids.has(record.id), 'Kredit- eller återbetalnings-ID är ogiltigt eller återanvänt.'); ids.add(record.id);
    assert(['credit', 'refund', 'offset'].includes(record.kind) && ['customer', 'supplier'].includes(record.side), 'Kreditens åtgärdstyp är ogiltig.');
    assert(record.snapshot === recordSnapshot(record), 'En bokförd kredit, återbetalning eller kvittning har ändrats.');
    const source = sourceDocument(state, record.side, record.documentId);
    assert(record.sourceEntryId === source.entryId, 'Kreditens originalreferens har ändrats.');
    assert(validDate(record.date) && fiscalPeriodForDate(state, record.date) && record.date >= source.date, 'Kreditens datum är ogiltigt.');
    assert(record.date >= latestDate({ ...source, payments: [] }, prior.filter(item => item.side === record.side && (item.documentId === source.id || item.targetDocumentId === source.id))), 'Krediter och återbetalningar måste följa datumordningen.');
    text(record.reference, 'Referens', 100); cents(record.amountCents, false);
    const ref = `${record.side}:${record.kind}:${record.documentId}:${record.reference}`;
    assert(!references.has(ref), 'Samma kredit- eller betalningsreferens har registrerats flera gånger.'); references.add(ref);
    const values = take(record.side, source.id), control = record.side === 'customer' ? '1510' : '2440';
    let expected;
    if (record.kind === 'credit') {
      text(record.reason, 'Krediteringsorsak');
      if(record.side==='customer') {
        const creditEntryIndex=state.entries.findIndex(entry=>entry.id===record.entryId);
        assert((state.revenueSchedules??[]).filter(plan=>plan.invoiceId===record.documentId).every(plan=>plan.date<=record.date&&plan.postings
          .filter(posting=>posting.entryId?state.entries.findIndex(entry=>entry.id===posting.entryId)<creditEntryIndex:(posting.entryCount??0)<=creditEntryIndex)
          .every(posting=>posting.date<=record.date)), 'Krediten får inte dateras före intäktsperiodiseringens start eller redan bokförd intäktsföring.');
      }
      assert(new RegExp(`^${record.side === 'customer' ? 'K' : 'LK'}-\\d{4,}$`).test(record.number) && !numbers.has(record.number), 'Kreditnotans nummer är ogiltigt eller återanvänt.'); numbers.add(record.number);
      assert(record.sourceSnapshot === documentSnapshot(record.side, source), 'Kreditnotans originaluppgifter har ändrats.');
      const idKey = key(record.side, source.id); if (!byLine.has(idKey)) byLine.set(idKey, new Map());
      const replay = { ...state, settlements: prior };
      const calculated = creditRows(replay, record.side, source.id, record.lines, byLine.get(idKey),record.entryId);
      assert(JSON.stringify(record.revenueAdjustments??[])===JSON.stringify(calculated.revenueAdjustments)&&(!calculated.revenueAdjustments.length||record.specialReviewed===true),'Kreditens periodiseringsrättelse har ändrats.');
      assert(calculated.amountCents === record.amountCents && JSON.stringify(calculated.lines) === JSON.stringify(record.lines), 'Kreditnotans belopp eller rader har ändrats.');
      expected = calculated.rows;
      values.settlementCreditCents = cents(values.settlementCreditCents + record.amountCents);
    } else if (record.kind === 'refund') {
      assert(record.amountCents <= -balanceBefore(record.side, source, record), 'Återbetalningen saknar ett tillräckligt tillgodobelopp vid betalningsdatumet.');
      const sign = record.side === 'customer' ? -1 : 1;
      expected = record.side === 'customer' ? [row(control, record.amountCents), row('1930', 0, record.amountCents)] : [row('1930', record.amountCents), row(control, 0, record.amountCents)];
      const bank = state.bankTransactions.filter(item => item.matchedEntryId === record.entryId);
      assert(bank.length === 1 && bank[0].id === record.bankEventId && bank[0].account === '1930' && bank[0].date === record.date && bank[0].amountCents === sign * record.amountCents, 'Återbetalningen saknar korrekt kopplad bankhändelse.');
      values.settlementRefundCents = cents(values.settlementRefundCents + record.amountCents);
    } else {
      const target = sourceDocument(state, record.side, record.targetDocumentId);
      assert(source.id !== target.id && sameParty(record.side, source, target) && record.targetEntryId === target.entryId && record.date >= target.date, 'Kvittningens målfaktura eller motpart är ogiltig.');
      assert(record.amountCents <= -balanceBefore(record.side, source, record) && record.amountCents <= balanceBefore(record.side, target, record), 'Kvittningen överstiger tillgodobelopp eller obetald faktura.');
      expected = [row(control, record.amountCents), row(control, 0, record.amountCents)];
      values.settlementOffsetOutCents = cents(values.settlementOffsetOutCents + record.amountCents);
      const targetValues = take(record.side, target.id);
      targetValues.settlementOffsetInCents = cents(targetValues.settlementOffsetInCents + record.amountCents);
      targetValues.settlementLastDate = [targetValues.settlementLastDate, record.date].sort().at(-1);
    }
    const entry = state.entries.find(item => item.id === record.entryId);
    assert(entry && !entryIds.has(entry.id) && entry.sourceType === `settlement-${record.kind}` && entry.sourceId === record.id && entry.date === record.date && !entry.correctsEntryId && equalRows(entry.rows, expected), 'Kreditens bokföring stämmer inte med underlaget.');
    entryIds.add(entry.id); values.settlementLastDate = [values.settlementLastDate, record.date].sort().at(-1); prior.push(record);
  }
  let receivableAdjustmentCents = 0, payableAdjustmentCents = 0;
  for (const [side, documents] of [['customer', state.invoices], ['supplier', state.bills]]) for (const document of documents) {
    const expected = mirrored.get(key(side, document.id));
    for (const field of MIRRORS) {
      assert((document[field] ?? 0) === (expected?.[field] ?? 0), 'Fakturans kredit- eller återbetalningssaldo stämmer inte med historiken.');
      if (document[field] !== undefined) cents(document[field]);
    }
    assert((document.settlementLastDate ?? '') === (expected?.settlementLastDate ?? ''), 'Fakturans senaste kreditdatum stämmer inte med historiken.');
    if (expected) {
      const adjustment = -expected.settlementCreditCents + expected.settlementRefundCents + expected.settlementOffsetOutCents - expected.settlementOffsetInCents;
      if (side === 'customer') receivableAdjustmentCents += adjustment; else payableAdjustmentCents += adjustment;
    }
  }
  validateManagedCostCoverage(state, all);
  const rotCredits=validateRotCreditEvents(state);
  rotCredits.claimedEntryIds.forEach(id=>{assert(!entryIds.has(id),'ROT-återbetalningen har dubbel bokföringsreferens.');entryIds.add(id);});
  return { claimedEntryIds: [...entryIds], receivableAdjustmentCents:receivableAdjustmentCents+rotCredits.receivableAdjustmentCents, payableAdjustmentCents };
}

function validateManagedCostCoverage(state, all) {
  if (!all.some(record => record.kind === 'credit' && record.side === 'supplier')) return;
  const groups = [...new Set(state.accruals.map(item => item.expenseAccount))].map(account => [account]);
  if (state.assets.length) groups.push(['5410']);
  if (state.inventoryValuations.length) groups.push(['4010', '4960']);
  for (const accounts of groups) {
    const changes = new Map();
    for (const entry of state.entries) changes.set(entry.date, (changes.get(entry.date) ?? 0) + sum(entry.rows.filter(item => accounts.includes(item.account)).map(item => item.debitCents - item.creditCents)));
    let available = 0;
    for (const [, change] of [...changes].sort(([a], [b]) => a.localeCompare(b))) {
      available += change;
      assert(available >= 0, 'Krediten skulle ta bort en kostnad som redan används av inventarie, lager eller periodisering. Rätta den kopplingen först.');
    }
  }
}
