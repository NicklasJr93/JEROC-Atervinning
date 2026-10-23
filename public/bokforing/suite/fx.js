// Foreign-currency documents. Every Cents amount is SEK öre; foreign amounts
// have explicit Minor names. Customer/supplier control accounts stay in SEK.
import { ACCOUNTS, MAX_CENTS, assert, cents, validDate, requireOpenPeriod, transact, nextId, appendEntry, addActivity } from './core.js';
import { fiscalPeriodForDate } from './fiscal-periods.js';

const currencies = new Set(['EUR', 'USD']);
const accounts = new Set(ACCOUNTS.map(item => item.number));
const expenseAccounts = new Set(['4010','5010','5410','5460','6110','6540','6570','6991']);
const valueText = (value, label, max = 300, allowEmpty = false) => {
  assert(typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value) && (allowEmpty || value.trim()), `${label} saknas eller har fel format.`);
  return value.trim();
};
const sum = values => values.reduce((total, value) => { assert(Number.isSafeInteger(value) && Number.isSafeInteger(total + value) && Math.abs(total + value) <= MAX_CENTS, 'Valutabeloppet är för stort.'); return total + value; }, 0);
const signedRow = (account, value) => ({ account, debitCents: Math.max(0, value), creditCents: Math.max(0, -value) });
const compact = rows => rows.filter(row => row.debitCents || row.creditCents);
const control = doc => doc.side === 'customer' ? '1510' : '2440';
const direction = doc => doc.side === 'customer' ? 1 : -1;
const snapshot = value => JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'snapshot')));
const docs = state => state.fxDocuments ?? [];
const events = state => state.fxEvents ?? [];
const lookup = (state, id) => { const doc = docs(state).find(item => item.id === id); assert(doc, 'Valutafakturan finns inte.'); return doc; };
function roundRatio(value, numerator, denominator) {
  assert(Number.isSafeInteger(value) && Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator) && numerator >= 0 && denominator > 0, 'Omräkningen är ogiltig.');
  const sign = value < 0 ? -1n : 1n;
  const result = sign * ((BigInt(Math.abs(value)) * BigInt(numerator) + BigInt(denominator) / 2n) / BigInt(denominator));
  assert(result <= BigInt(MAX_CENTS) && result >= -BigInt(MAX_CENTS), 'Det omräknade beloppet är för stort.');
  return Number(result);
}
function gcd(a,b) { while (b) [a,b] = [b,a % b]; return a; }
export function parseFxRate(value, { date, source } = {}) {
  assert(typeof value === 'string' && /^\d{1,6}(?:[,.]\d{1,8})?$/.test(value.trim()), 'Ange kurs som SEK per 1 valutaenhet, med högst åtta decimaler.');
  const [whole, fraction = ''] = value.trim().replace(',', '.').split('.');
  let denominator = 10 ** fraction.length, numerator = Number(whole) * denominator + Number(fraction || '0');
  assert(Number.isSafeInteger(numerator) && numerator > 0, 'Valutakursen måste vara större än noll.');
  const divisor = gcd(numerator, denominator); numerator /= divisor; denominator /= divisor;
  assert(validDate(date), 'Kursdatumet är ogiltigt.');
  return { numerator, denominator, date, source: valueText(source, 'Kurskälla', 200) };
}
function validateRate(rate) {
  assert(rate && Number.isSafeInteger(rate.numerator) && rate.numerator > 0 && rate.numerator <= 100_000_000_000_000 && Number.isSafeInteger(rate.denominator) && rate.denominator > 0 && rate.denominator <= 100_000_000 && gcd(rate.numerator,rate.denominator) === 1 && validDate(rate.date), 'Valutakursen är ogiltig.');
  valueText(rate.source, 'Kurskälla', 200);
}
export function convertFxMinor(foreignMinor, rate) { validateRate(rate); return roundRatio(foreignMinor, rate.numerator, rate.denominator); }
export function formatFxMinor(amount, currency) {
  assert(Number.isSafeInteger(amount) && currencies.has(currency), 'Valutabeloppet är ogiltigt.');
  return new Intl.NumberFormat('sv-SE', { style: 'currency', currency }).format(amount / 100);
}
export function formatFxRate(rate) { validateRate(rate); return (rate.numerator / rate.denominator).toLocaleString('sv-SE', { maximumFractionDigits: 8 }); }

function calculateDocument(doc) {
  assert(['customer','supplier'].includes(doc.side) && currencies.has(doc.currency), 'Välj kund/leverantör och EUR eller USD.');
  assert(doc.taxTreatment === 'domestic' || doc.taxTreatment === 'no-vat', 'Momstypen stöds inte för valutafakturor.');
  assert(doc.taxReviewed === true, 'Granska momstyp och kurs innan du sparar valutafakturan.');
  validateRate(doc.rate);
  assert(validDate(doc.date) && validDate(doc.dueDate) && doc.dueDate >= doc.date && doc.rate.date === doc.date, 'Faktura-, förfallo- eller kursdatum stämmer inte. Kursdatum ska vara fakturadatum i detta flöde.');
  valueText(doc.number, 'Fakturanummer', 100); valueText(doc.partyName, 'Motpartens namn', 150);
  valueText(doc.partyAddress, 'Motpartens adress', 500); valueText(doc.sellerName, 'Säljarens namn', 150);
  valueText(doc.sellerAddress, 'Säljarens adress', 500); valueText(doc.sellerOrgNumber, 'Säljarens organisationsnummer', 50);
  valueText(doc.sellerVatNumber, 'Säljarens momsnummer', 50, doc.taxTreatment === 'no-vat'); valueText(doc.paymentReference, 'Betalningsuppgifter', 200);
  if (doc.taxTreatment === 'no-vat') valueText(doc.taxReason, 'Orsak till ingen moms', 300);
  assert(Array.isArray(doc.lines) && doc.lines.length > 0 && doc.lines.length <= 100, 'Fakturan behöver 1–100 rader.');
  const lines = doc.lines.map(line => {
    valueText(line.description, 'Radbeskrivning', 300); cents(line.foreignNetMinor, false);
    assert([0,6,12,25].includes(line.vatRate) && (doc.taxTreatment !== 'no-vat' || line.vatRate === 0), 'Radens momssats stöds inte.');
    assert(doc.side === 'customer' ? line.account === '3000' : expenseAccounts.has(line.account), 'Välj ett kostnadskonto som stöds.');
    const foreignVatMinor = roundRatio(line.foreignNetMinor, line.vatRate, 100);
    const netCents = convertFxMinor(line.foreignNetMinor, doc.rate), vatCents = convertFxMinor(foreignVatMinor, doc.rate);
    return { ...line, foreignVatMinor, foreignGrossMinor: sum([line.foreignNetMinor,foreignVatMinor]), netCents, vatCents, grossCents: sum([netCents,vatCents]) };
  });
  assert(sum(lines.map(line => line.grossCents)) > 0, 'Fakturabeloppet är för litet efter omräkning till SEK.');
  if(lines.some(line => line.vatRate === 0)) valueText(doc.taxReason, 'Motivering till nollmoms', 300);
  return { lines, foreignNetMinor: sum(lines.map(line => line.foreignNetMinor)), foreignVatMinor: sum(lines.map(line => line.foreignVatMinor)), foreignGrossMinor: sum(lines.map(line => line.foreignGrossMinor)), netCents: sum(lines.map(line => line.netCents)), vatCents: sum(lines.map(line => line.vatCents)), grossCents: sum(lines.map(line => line.grossCents)) };
}
function addFxDifference(rows) {
  const difference = sum(rows.map(row => row.debitCents - row.creditCents));
  if (difference) rows.push(signedRow(difference > 0 ? '3960' : '7960', -difference));
  return compact(rows);
}
const initialPosition = () => ({ foreignBalanceMinor: 0, carryingCents: 0, creditNet: new Map(), issued: false, lastDate: '', revaluedDates: new Set(), reversed: new Set() });
function allocatedCarrying(position, foreignMinor) {
  assert(position.foreignBalanceMinor !== 0, 'Ingen öppen valutapost finns.');
  return roundRatio(Math.abs(position.carryingCents), foreignMinor, Math.abs(position.foreignBalanceMinor));
}
function calculateEvent(doc, event, position, priorEvents) {
  assert(event.date >= (position.lastDate || doc.date), 'Åtgärden får inte ligga före fakturans senaste händelse.');
  const sign = direction(doc), account = control(doc), taxRows = [];
  let rows;
  if (event.type === 'issue') {
    assert(!position.issued && event.date === doc.date, 'Valutafakturan är redan bokförd eller har fel datum.');
    position.issued = true; position.foreignBalanceMinor = doc.foreignGrossMinor; position.carryingCents = doc.grossCents;
    rows = [signedRow(account, sign * doc.grossCents)];
    for (const line of doc.lines) {
      rows.push(signedRow(line.account, -sign * line.netCents));
      if (line.vatCents) rows.push(signedRow(doc.side === 'customer' ? ({25:'2611',12:'2621',6:'2631'}[line.vatRate]) : '2641', -sign * line.vatCents));
      taxRows.push({ vatRate: line.vatRate, baseCents: line.netCents, vatCents: line.vatCents });
    }
  } else {
    assert(position.issued, 'Bokför fakturan före betalning eller rättelse.');
    if (event.type === 'payment' || event.type === 'refund') {
      const isRefund = event.type === 'refund';
      cents(event.foreignMinor, false); cents(event.bankCents, false); cents(event.feeCents);
      assert(isRefund ? position.foreignBalanceMinor < 0 : position.foreignBalanceMinor > 0, isRefund ? 'Fakturan har inget tillgodo att återbetala.' : 'Fakturan har inget återstående belopp att betala.');
      assert(event.foreignMinor <= Math.abs(position.foreignBalanceMinor), 'Beloppet överstiger den återstående valutaposten.');
      const carried = allocatedCarrying(position, event.foreignMinor), operationSign = isRefund ? -sign : sign;
      assert(operationSign > 0 || event.bankCents > event.feeCents, 'Bankbeloppet måste täcka den separata avgiften.');
      rows = [signedRow(account, -operationSign * carried), signedRow('1930', operationSign * event.bankCents), signedRow('6570', event.feeCents)];
      rows = addFxDifference(rows);
      position.foreignBalanceMinor += isRefund ? event.foreignMinor : -event.foreignMinor;
      position.carryingCents += isRefund ? carried : -carried;
    } else if (event.type === 'credit') {
      valueText(event.reason, 'Krediteringsorsak', 300);
      assert(Array.isArray(event.lines) && event.lines.length > 0 && event.lines.length <= doc.lines.length, 'Välj rader att kreditera.');
      const seen = new Set(); let foreignGross = 0; rows = [];
      for (const selected of event.lines) {
        assert(Number.isSafeInteger(selected.index) && !seen.has(selected.index), 'Kreditraden är ogiltig eller dubblerad.'); seen.add(selected.index);
        const line = doc.lines[selected.index]; assert(line, 'Originalraden saknas.'); cents(selected.foreignNetMinor, false);
        const before = position.creditNet.get(selected.index) ?? 0, after = sum([before,selected.foreignNetMinor]);
        assert(after <= line.foreignNetMinor, 'Krediten överstiger originalradens återstående belopp.');
        const delta = value => roundRatio(value, after, line.foreignNetMinor) - roundRatio(value, before, line.foreignNetMinor);
        const foreignVat = delta(line.foreignVatMinor), net = delta(line.netCents), vat = delta(line.vatCents);
        foreignGross = sum([foreignGross,selected.foreignNetMinor,foreignVat]);
        rows.push(signedRow(line.account, sign * net));
        if (vat) rows.push(signedRow(doc.side === 'customer' ? ({25:'2611',12:'2621',6:'2631'}[line.vatRate]) : '2641', sign * vat));
        taxRows.push({ vatRate: line.vatRate, baseCents: -net, vatCents: -vat });
        position.creditNet.set(selected.index, after);
      }
      let carried;
      if (position.foreignBalanceMinor >= foreignGross) carried = allocatedCarrying(position,foreignGross);
      else {
        validateRate(event.rate);
        assert(event.rateReviewed === true && event.rate.date === event.date, 'En kredit efter betalning behöver granskad kurs för kreditdatumet.');
        const creditForeign = foreignGross - Math.max(0,position.foreignBalanceMinor);
        carried = sum([Math.max(0,position.carryingCents),convertFxMinor(creditForeign,event.rate)]);
      }
      rows.push(signedRow(account,-sign * carried)); rows = addFxDifference(rows);
      position.foreignBalanceMinor -= foreignGross; position.carryingCents -= carried;
    } else if (event.type === 'revalue') {
      validateRate(event.rate); assert(event.reviewed === true && event.rate.date === event.date, 'Balansdagskursen behöver granskas och avse samma datum.');
      assert(!(position.revaluedDates.has(event.date) && priorEvents.at(-1)?.type === 'revalue'), 'Valutaposten har redan värderats detta datum.');
      assert(position.foreignBalanceMinor !== 0, 'En slutreglerad valutapost ska inte värderas.');
      const next = convertFxMinor(position.foreignBalanceMinor,event.rate), difference = next - position.carryingCents;
      rows = addFxDifference([signedRow(account,sign * difference)]);
      position.carryingCents = next; position.revaluedDates.add(event.date);
    } else if (event.type === 'revalue-reversal') {
      valueText(event.reason,'Rättelseorsak',300);
      const original = priorEvents.find(item => item.id === event.reversesEventId);
      assert(original?.type === 'revalue' && !position.reversed.has(original.id) && priorEvents.at(-1)?.id === original.id, 'Bara den senaste, ännu inte rättade värderingen kan återföras.');
      const originalRows = original.calculatedRows;
      assert(originalRows.length > 0, 'En oförändrad värderingskontroll behöver inte återföras.');
      rows = originalRows.map(row => ({ account:row.account,debitCents:row.creditCents,creditCents:row.debitCents }));
      const movement = sum(originalRows.filter(row => row.account === account).map(row => row.debitCents - row.creditCents)) * sign;
      position.carryingCents -= movement; position.revaluedDates.delete(original.date); position.reversed.add(original.id);
    } else assert(false, 'Okänd valutahändelse.');
  }
  position.lastDate = event.date;
  assert(Number.isSafeInteger(position.foreignBalanceMinor) && Math.abs(position.foreignBalanceMinor) <= MAX_CENTS && Number.isSafeInteger(position.carryingCents) && Math.abs(position.carryingCents) <= MAX_CENTS, 'Valutasaldot är för stort.');
  assert(position.foreignBalanceMinor === 0 ? position.carryingCents === 0 : Math.sign(position.foreignBalanceMinor) === Math.sign(position.carryingCents), 'Valutapostens ören kan inte fördelas entydigt. Använd en större delbetalning.');
  return { rows: compact(rows), taxRows };
}
function replay(state, doc, { verify = true } = {}) {
  const position = initialPosition(), prior = [], taxRows = [];
  for (const event of events(state).filter(item => item.documentId === doc.id)) {
    assert(validDate(event.date) && fiscalPeriodForDate(state,event.date), 'Valutahändelsens bokföringsår saknas.');
    valueText(event.reference,'Händelsereferens',100);
    const calculated = calculateEvent(doc,event,position,prior);
    if (verify) {
      assert(event.snapshot === snapshot(event), 'Valutahändelsens historik har ändrats.');
      const entry = state.entries.find(item => item.id === event.entryId);
      assert(event.type !== 'revalue' || event.date === fiscalPeriodForDate(state,event.date).end, 'Valutavärderingen ska avse balansdagen.');
      assert(calculated.rows.length === 0 ? event.type === 'revalue' && event.entryId === null : entry && entry.sourceType === `fx-${event.type}` && entry.sourceId === event.id && entry.date === event.date && JSON.stringify(entry.rows) === JSON.stringify(calculated.rows), 'Valutahändelsens verifikation stämmer inte.');
      const bank = event.entryId ? state.bankTransactions.filter(item => item.matchedEntryId === event.entryId && (item.account ?? '1930') === '1930') : [];
      const bankAmount = sum(calculated.rows.filter(row => row.account === '1930').map(row => row.debitCents - row.creditCents));
      assert(bankAmount ? bank.length === 1 && bank[0].amountCents === bankAmount && bank[0].date === event.date && (!event.bankEventId || bank[0].id === event.bankEventId) : bank.length === 0, 'Valutabetalningens bankhändelse stämmer inte.');
    }
    prior.push({ ...event, calculatedRows:calculated.rows });
    taxRows.push(...calculated.taxRows.map(row => ({...row,entryId:event.entryId,date:event.date,side:doc.side})));
  }
  return { ...position, taxRows };
}
export function getFxPosition(state,id) { return replay(state,lookup(state,id)); }
export function getFxTaxRows(state) { return docs(state).filter(doc => doc.status === 'issued').flatMap(doc => replay(state,doc).taxRows); }
export function validateFxState(state) {
  const claimedEntryIds = new Set(); let receivableAdjustmentCents = 0, payableAdjustmentCents = 0;
  const used = new Set();
  for (const doc of docs(state)) {
    const calculated = calculateDocument(doc);
    for (const key of ['lines','foreignNetMinor','foreignVatMinor','foreignGrossMinor','netCents','vatCents','grossCents']) assert(JSON.stringify(doc[key]) === JSON.stringify(calculated[key]), 'Valutafakturans belopp har ändrats.');
    assert(['draft','issued'].includes(doc.status), 'Valutafakturans status är ogiltig.');
    const duplicateKey = `${doc.side}:${doc.side === 'supplier' ? doc.partyName.toLocaleLowerCase('sv') + ':' : ''}${doc.number.toLocaleLowerCase('sv')}`;
    assert(!used.has(duplicateKey), 'Samma valutafaktura finns redan.'); used.add(duplicateKey);
    if (doc.status === 'issued') assert(doc.snapshot === snapshot(doc), 'En bokförd valutafaktura har ändrats.');
    const position = replay(state,doc);
    assert(doc.status === 'issued' ? position.issued : !position.issued, 'Valutafakturans status stämmer inte med huvudboken.');
    if (doc.status === 'issued') assert(events(state).some(event => event.documentId === doc.id && event.type === 'issue' && event.entryId === doc.issuedEntryId), 'Fakturans originalverifikation saknas.');
    if (doc.side === 'customer') receivableAdjustmentCents = sum([receivableAdjustmentCents,position.carryingCents]); else payableAdjustmentCents = sum([payableAdjustmentCents,position.carryingCents]);
  }
  const references = new Set();
  for (const event of events(state)) {
    assert(docs(state).some(doc => doc.id === event.documentId), 'Valutahändelsen saknar faktura.');
    const ref = `${event.documentId}:${event.type}:${event.reference}`;
    assert(!references.has(ref) && (!event.entryId || !claimedEntryIds.has(event.entryId)), 'Valutahändelsen är dubblerad.'); references.add(ref); if(event.entryId) claimedEntryIds.add(event.entryId);
  }
  return { claimedEntryIds,receivableAdjustmentCents,payableAdjustmentCents };
}
function change(state,mutation) {
  validateFxState(state);
  return transact(state,draft => {
    mutation(draft);
    for (const previous of events(state)) assert(events(draft).some(item => item.id === previous.id && JSON.stringify(item) === JSON.stringify(previous)), 'Bokförda valutahändelser får inte ändras eller tas bort.');
    for (const previous of docs(state).filter(item => item.status === 'issued')) assert(docs(draft).some(item => item.id === previous.id && JSON.stringify(item) === JSON.stringify(previous)), 'Bokförda valutafakturor får inte ändras eller tas bort.');
    validateFxState(draft);
  });
}
export function createFxDocument(state,payload) {
  return change(state,draft => {
    requireOpenPeriod(draft,payload.date);
    assert(draft.company.method === 'invoice', 'Nya valutafakturor kräver faktureringsmetoden. Valuta tillsammans med kontantmetoden stöds inte ännu.');
    const rate = typeof payload.rate === 'object' ? structuredClone(payload.rate) : parseFxRate(payload.rate,{date:payload.date,source:payload.rateSource});
    const doc = { id:nextId(draft,'fx-doc'),status:'draft',side:payload.side,currency:payload.currency,date:payload.date,dueDate:payload.dueDate,
      number:valueText(payload.number,'Fakturanummer',100),partyName:valueText(payload.partyName,'Motpartens namn',150),partyAddress:valueText(payload.partyAddress,'Motpartens adress',500),
      sellerName:valueText(payload.sellerName ?? draft.company.name,'Säljarens namn',150),sellerAddress:valueText(payload.sellerAddress,'Säljarens adress',500),
      sellerOrgNumber:valueText(payload.sellerOrgNumber ?? draft.company.orgNumber,'Säljarens organisationsnummer',50),sellerVatNumber:payload.sellerVatNumber ?? '',
      paymentReference:valueText(payload.paymentReference,'Betalningsuppgifter',200),taxTreatment:payload.taxTreatment,taxReason:payload.taxReason ?? '',taxReviewed:payload.taxReviewed === true,rate,
      lines:(payload.lines ?? []).map(line => ({description:line.description,account:payload.side === 'customer' ? '3000' : line.account,foreignNetMinor:line.foreignNetMinor,vatRate:line.vatRate})) };
    Object.assign(doc,calculateDocument(doc)); (draft.fxDocuments ??= []).push(doc);
    addActivity(draft,`Valutafakturautkast ${doc.number} · ${doc.currency}`,doc.id);
  });
}
function appendFxEvent(draft,doc,payload) {
  requireOpenPeriod(draft,payload.date);
  const id = nextId(draft,'fx-event'), event = {id,documentId:doc.id,...payload};
  const position = replay(draft,doc), prior = events(draft).filter(item => item.documentId === doc.id).map(item => ({ ...item,calculatedRows:draft.entries.find(entry => entry.id === item.entryId)?.rows }));
  const calculated = calculateEvent(doc,event,position,prior);
  const entry = calculated.rows.length ? appendEntry(draft,{date:event.date,description:`Valuta ${doc.number} · ${{issue:'faktura',payment:'betalning',credit:'kredit',refund:'återbetalning',revalue:'balansdagsvärdering','revalue-reversal':'rättelse av värdering'}[event.type]}`,sourceType:`fx-${event.type}`,sourceId:id,rows:calculated.rows}) : null;
  event.entryId = entry?.id ?? null;
  const bankAmount = sum(calculated.rows.filter(row => row.account === '1930').map(row => row.debitCents - row.creditCents));
  if (bankAmount) {
    let bank;
    if(event.bankEventId) {
      bank=draft.bankTransactions.find(item=>item.id===event.bankEventId);
      assert(bank && !bank.matchedEntryId && (bank.account??'1930')==='1930' && bank.date===event.date && bank.amountCents===bankAmount,'Välj en omatchad bankhändelse med samma datum, belopp och riktning.');
      bank.matchedEntryId=entry.id;
    } else {
      bank={id:nextId(draft,'bank'),date:event.date,description:`Valuta ${doc.number} · ${event.reference}`,amountCents:bankAmount,account:'1930',matchedEntryId:entry.id};
      draft.bankTransactions.push(bank);
    }
    event.bankEventId=bank.id;
  }
  event.snapshot=snapshot(event); (draft.fxEvents??=[]).push(event);
  return event;
}
export function issueFxDocument(state,id) {
  return change(state,draft => {
    const doc = lookup(draft,id); assert(doc.status === 'draft','Valutafakturan är redan bokförd.');
    assert(draft.company.method === 'invoice', 'Valutafakturor kan bara utfärdas med faktureringsmetoden.');
    const event = appendFxEvent(draft,doc,{type:'issue',date:doc.date,reference:doc.number});
    doc.status = 'issued'; doc.issuedEntryId = event.entryId; doc.snapshot = snapshot(doc);
  });
}
export function settleFxDocument(state,id,{date,foreignMinor,bankCents,feeCents=0,reference,refund=false,bankEventId=null}) {
  return change(state,draft => appendFxEvent(draft,lookup(draft,id),{type:refund?'refund':'payment',date,foreignMinor,bankCents,feeCents,bankEventId,reference:valueText(reference,'Betalningsreferens',100)}));
}
export function creditFxDocument(state,id,{date,lines,reason,reference,rate,rateSource,rateReviewed=false}) {
  return change(state,draft => appendFxEvent(draft,lookup(draft,id),{type:'credit',date,lines:structuredClone(lines),reason:valueText(reason,'Krediteringsorsak',300),reference:valueText(reference,'Kreditreferens',100),...(rate?{rate:typeof rate==='object'?structuredClone(rate):parseFxRate(rate,{date,source:rateSource}),rateReviewed:rateReviewed===true}:{})}));
}
export function revalueFxDocument(state,id,{date,rate,rateSource,reviewed,reference}) {
  return change(state,draft => {
    assert(date === draft.company.fiscalYearEnd,'Valutaposter värderas på räkenskapsårets sista dag i detta flöde.');
    appendFxEvent(draft,lookup(draft,id),{type:'revalue',date,rate:typeof rate === 'object'?structuredClone(rate):parseFxRate(rate,{date,source:rateSource}),reviewed:reviewed===true,reference:valueText(reference,'Värderingsreferens',100)});
  });
}
export function reverseFxRevaluation(state,id,{date,reversesEventId,reference,reason}) {
  return change(state,draft => appendFxEvent(draft,lookup(draft,id),{type:'revalue-reversal',date,reversesEventId,reference:valueText(reference,'Rättelsereferens',100),reason:valueText(reason,'Rättelseorsak',300)}));
}
const html = value => String(value ?? '').replace(/[&<>"']/g,ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export function fxInvoiceHtml(state,id) {
  const doc = lookup(state,id); const position = getFxPosition(state,id);
  return `<!doctype html><html lang="sv"><meta charset="utf-8"><title>${html(doc.number)}</title><style>body{font:15px Arial;max-width:850px;margin:40px auto;color:#182536}header{display:flex;justify-content:space-between}table{width:100%;border-collapse:collapse;margin:32px 0}td,th{text-align:left;border-bottom:1px solid #ddd;padding:10px}td:last-child,th:last-child{text-align:right}.total{text-align:right;font-size:20px}small{color:#526273}@media print{body{margin:15mm}}</style><body><header><section><h1>${doc.status==='draft'?'UTKAST · ':''}${doc.side==='customer'?'FAKTURA':'LEVERANTÖRSUNDERLAG'}</h1><h2>${html(doc.sellerName)}</h2><p>${html(doc.sellerAddress)}</p><p>Org.nr ${html(doc.sellerOrgNumber)} · Momsnr ${html(doc.sellerVatNumber)}</p></section><section><h2>${html(doc.number)}</h2><p>Fakturadatum ${html(doc.date)}<br>Förfallodatum ${html(doc.dueDate)}</p><p>${html(doc.partyName)}<br>${html(doc.partyAddress)}</p></section></header><table><thead><tr><th>Beskrivning</th><th>Netto ${html(doc.currency)}</th><th>Moms</th><th>Summa ${html(doc.currency)}</th></tr></thead><tbody>${doc.lines.map(line=>`<tr><td>${html(line.description)}</td><td>${html(formatFxMinor(line.foreignNetMinor,doc.currency))}</td><td>${line.vatRate}%</td><td>${html(formatFxMinor(line.foreignGrossMinor,doc.currency))}</td></tr>`).join('')}</tbody></table><p class="total">Totalt: ${html(formatFxMinor(doc.foreignGrossMinor,doc.currency))}</p><p class="total">${doc.status==='issued'?'Återstår: '+html(formatFxMinor(Math.max(0,position.foreignBalanceMinor),doc.currency)):''}</p><p>Moms att redovisa i SEK: ${html((doc.vatCents/100).toFixed(2))} SEK.<br><small>Fryst fakturakurs ${html(formatFxRate(doc.rate))} SEK per 1 ${html(doc.currency)} · ${html(doc.rate.date)} · ${html(doc.rate.source)}. Nettobelopp och moms omräknas och avrundas separat.</small></p>${doc.taxTreatment==='no-vat'?`<p>Momsupplysning: ${html(doc.taxReason)}</p>`:''}<p>Betalningsuppgifter: ${html(doc.paymentReference)}</p><p><small>Skapad från valutafakturans frysta uppgifter. Underlag för manuell leverans; inget skickas automatiskt.</small></p></body></html>`;
}

export function getFxClosingIssues(state) {
  const end=state.company.fiscalYearEnd;
  return docs(state).filter(doc=>doc.status==='issued' && doc.date<=end).flatMap(doc=>{
    const scoped={...state,fxEvents:events(state).filter(event=>event.date<=end)};
    const position=replay(scoped,doc);
    if(position.foreignBalanceMinor===0)return [];
    const last=events(scoped).filter(event=>event.documentId===doc.id).at(-1);
    return last?.type==='revalue' && last.date===end?[]:[{id:doc.id,number:doc.number,message:`Valutaposten ${doc.number} behöver granskad balansdagsvärdering ${end}.`}];
  });
}

export function updateFxDraft(state,id,payload) {
  return change(state,draft=>{
    const doc=lookup(draft,id);assert(doc.status==='draft','En bokförd valutafaktura kan inte redigeras. Skapa en kreditnota.');
    const next={...doc};
    for(const key of ['number','date','dueDate','partyName','partyAddress','sellerName','sellerAddress','sellerOrgNumber','sellerVatNumber','paymentReference','taxTreatment','taxReason'])if(payload[key]!==undefined)next[key]=payload[key];
    requireOpenPeriod(draft,next.date);
    if(payload.rate!==undefined)next.rate=typeof payload.rate==='object'?structuredClone(payload.rate):parseFxRate(payload.rate,{date:next.date,source:payload.rateSource??doc.rate.source});
    next.taxReviewed=payload.taxReviewed===true;
    if(payload.lines!==undefined)next.lines=payload.lines.map(line=>({description:line.description,account:doc.side==='customer'?'3000':line.account,foreignNetMinor:line.foreignNetMinor,vatRate:line.vatRate}));
    Object.assign(next,calculateDocument(next));Object.assign(doc,next);addActivity(draft,`Valutautkast ${doc.number} uppdaterat.`,doc.id);
  });
}
export function removeFxDraft(state,id) {
  return change(state,draft=>{
    const doc=lookup(draft,id);assert(doc.status==='draft','Bokförda valutafakturor kan inte raderas.');
    draft.fxDocuments=draft.fxDocuments.filter(item=>item.id!==id);addActivity(draft,`Valutautkast ${doc.number} borttaget.`,id);
  });
}
export function fxCreditHtml(state,eventId) {
  const event=events(state).find(item=>item.id===eventId&&item.type==='credit');assert(event,'Kreditnotan finns inte.');
  const doc=lookup(state,event.documentId),index=events(state).indexOf(event),earlier=events(state).slice(0,index).filter(item=>item.documentId===doc.id&&item.type==='credit');
  const lines=event.lines.map(selection=>{
    const line=doc.lines[selection.index];
    const before=sum(earlier.flatMap(item=>item.lines.filter(part=>part.index===selection.index).map(part=>part.foreignNetMinor)));
    const vat=roundRatio(line.foreignVatMinor,before+selection.foreignNetMinor,line.foreignNetMinor)-roundRatio(line.foreignVatMinor,before,line.foreignNetMinor);
    return{description:line.description,net:selection.foreignNetMinor,vat,total:selection.foreignNetMinor+vat,vatRate:line.vatRate};
  });
  const vatCents=-sum(getFxTaxRows(state).filter(row=>row.entryId===event.entryId).map(row=>row.vatCents));
  return `<!doctype html><html lang="sv"><meta charset="utf-8"><title>Kreditnota ${html(event.reference)}</title><style>body{font:15px Arial;max-width:850px;margin:40px auto}table{width:100%;border-collapse:collapse}th,td{padding:12px;border-bottom:1px solid #ddd;text-align:left}@media print{body{margin:15mm}}</style><body><h1>KREDITNOTA ${html(event.reference)}</h1><p>Unikt kredit-ID: ${html(event.id)}<br>Datum: ${html(event.date)}<br>Avser faktura ${html(doc.number)}, ${html(doc.date)}</p><h2>${html(doc.sellerName)}</h2><p>${html(doc.sellerAddress)}<br>Org.nr ${html(doc.sellerOrgNumber)} · Momsnr ${html(doc.sellerVatNumber)}</p><h2>${html(doc.partyName)}</h2><p>${html(doc.partyAddress)}</p><p>Orsak: ${html(event.reason)}</p><table><thead><tr><th>Rad</th><th>Krediterat netto</th><th>Moms</th><th>Kreditbelopp</th></tr></thead><tbody>${lines.map(line=>`<tr><td>${html(line.description)}</td><td>${html(formatFxMinor(line.net,doc.currency))}</td><td>${line.vatRate}% · ${html(formatFxMinor(line.vat,doc.currency))}</td><td>${html(formatFxMinor(line.total,doc.currency))}</td></tr>`).join('')}</tbody></table><h2>Totalt krediterat ${html(formatFxMinor(sum(lines.map(line=>line.total)),doc.currency))}</h2><p>Återförd moms i SEK: ${html((vatCents/100).toFixed(2))} SEK. Skattebeloppen följer ursprungsfakturans frysta kurs; eventuell kursdifferens bokförs separat.</p></body></html>`;
}
