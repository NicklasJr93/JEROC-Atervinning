// Explicit VAT classifications for the local accounting demo. Nothing is filed.
import { appendEntry, assert, cents, nextId, addActivity, requireOpenPeriod, transact, validDate } from './core.js';
import { calculateLineAmounts } from './rot.js';
import { calculatePurchaseLines } from './purchase-lines.js';

export const VAT_SOURCE = 'https://www.skatteverket.se/foretag/moms/deklareramoms/fyllaimomsdeklarationen.4.3a2a542410ab40a421c80004214.html';
export const VAT_RULE_VERSION = 'SE-VAT-2026-10-23';
export const VAT_KINDS = Object.freeze([
  { id: 'domestic-purchase', name: 'Betalt svenskt inköp', purchase: true, country: 'SE' },
  { id: 'domestic-reverse-goods-purchase', name: 'Betalda varor, svensk omvänd moms', purchase: true, country: 'SE', basis: '23', reverse: true },
  { id: 'domestic-reverse-service-purchase', name: 'Betalda tjänster, svensk omvänd moms', purchase: true, country: 'SE', basis: '24', reverse: true },
  { id: 'eu-goods-purchase', name: 'Betalt varuinköp från EU', purchase: true, basis: '20', reverse: true },
  { id: 'eu-service-purchase', name: 'Betald EU-tjänst, huvudregeln', purchase: true, basis: '21', reverse: true },
  { id: 'non-eu-service-purchase', name: 'Betald tjänst utanför EU, huvudregeln', purchase: true, basis: '22', reverse: true },
  { id: 'import-vat', name: 'Importmoms från tullunderlag', purchase: true, basis: '50', reverse: true, import: true },
  { id: 'domestic-sale', name: 'Betald svensk försäljning', basis: '05', country: 'SE' },
  { id: 'eu-goods-sale', name: 'Betald varuförsäljning till EU', basis: '35', exempt: true },
  { id: 'eu-service-sale', name: 'Betald EU-tjänst, huvudregeln', basis: '39', exempt: true },
  { id: 'export-sale', name: 'Betald varuexport utanför EU', basis: '36', exempt: true },
  { id: 'non-eu-service-sale', name: 'Betald tjänst utanför EU, huvudregeln', basis: '40', exempt: true },
]);
export const VAT_BOXES = Object.freeze([
  ['05', 'Momspliktig försäljning'], ['06', 'Momspliktiga uttag'], ['07', 'Vinstmarginalbeskattning'], ['08', 'Frivillig beskattning, hyra'],
  ['10', 'Utgående moms 25 %'], ['11', 'Utgående moms 12 %'], ['12', 'Utgående moms 6 %'],
  ['20', 'Varuinköp EU'], ['21', 'Tjänsteinköp EU, huvudregeln'], ['22', 'Tjänsteinköp utanför EU'], ['23', 'Varuinköp, svensk omvänd moms'], ['24', 'Tjänsteinköp, svensk omvänd moms'],
  ['30', 'Utgående omvänd moms 25 %'], ['31', 'Utgående omvänd moms 12 %'], ['32', 'Utgående omvänd moms 6 %'],
  ['35', 'Varuförsäljning EU'], ['36', 'Export av varor'], ['37', 'Mellanmans inköp, trepartshandel'], ['38', 'Mellanmans försäljning, trepartshandel'],
  ['39', 'Tjänsteförsäljning EU, huvudregeln'], ['40', 'Övrig tjänsteförsäljning utomlands'], ['41', 'Försäljning, svensk omvänd moms'], ['42', 'Övrig momsfri försäljning'],
  ['48', 'Ingående moms att dra av'], ['49', 'Moms att betala / få tillbaka'], ['50', 'Beskattningsunderlag import'],
  ['60', 'Utgående importmoms 25 %'], ['61', 'Utgående importmoms 12 %'], ['62', 'Utgående importmoms 6 %'],
].map(([id, title]) => ({ id, title })));
const EU = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES'.split(' '));
const EXPENSE = new Set(['4010', '5010', '5410', '5460', '6110', '6540', '6570', '6991']);
const OUTPUT = ['2611', '2621', '2631', '2614', '2624', '2634', '2615', '2625', '2635'];
const INPUT = ['2641', '2647', '2645'];
const unsupported = ['06', '07', '08', '37', '38', '42'];
const ordinaryBox = rate => ({ 25: '10', 12: '11', 6: '12' })[rate];
const reverseBox = (rate, imported = false) => ({ 25: imported ? '60' : '30', 12: imported ? '61' : '31', 6: imported ? '62' : '32' })[rate];
const outputAccount = (rate, imported = false) => ({ 25: imported ? '2615' : '2614', 12: imported ? '2625' : '2624', 6: imported ? '2635' : '2634' })[rate];
const standardAccount = rate => ({ 25: '2611', 12: '2621', 6: '2631' })[rate];
const round = (amount, numerator, denominator = 10000) => cents(Number((BigInt(amount) * BigInt(numerator) + BigInt(denominator / 2)) / BigInt(denominator)));
const debit = (account, amount) => ({ account, debitCents: amount, creditCents: 0 });
const credit = (account, amount) => ({ account, debitCents: 0, creditCents: amount });
const sum = values => values.reduce((a, b) => { assert(Number.isSafeInteger(a + b), 'Momssumman är för stor.'); return a + b; }, 0);
const label = (value, name, max = 160) => { assert(typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value), `Ange ${name}.`); return value.trim(); };
const checkRate = value => assert([0, 6, 12, 25].includes(value), 'Välj 0, 6, 12 eller 25 procent moms.');
const txRows = record => record.rows;
const snapshot = record => JSON.stringify([record.kind, record.date, record.reference, record.counterparty, record.country, record.vatNumber, record.netCents, record.vatRate, record.deductibleBps, record.account, record.conditionsConfirmed, record.ruleVersion, record.originalId ?? null, record.rows, record.boxes, record.reason ?? null]);

export function calculateTaxTransaction(payload) {
  assert(payload && typeof payload === 'object', 'Momsuppgifterna saknas.');
  const kind = VAT_KINDS.find(item => item.id === payload.kind); assert(kind, 'Välj ett granskat momsfall.');
  const date = payload.date; assert(validDate(date), 'Ange ett giltigt datum.');
  const reference = label(payload.reference, 'underlagsreferens');
  const counterparty = label(payload.counterparty, 'motpart');
  const country = String(payload.country ?? kind.country ?? '').trim().toUpperCase();
  assert(/^[A-Z]{2}$/.test(country), 'Ange motpartens landskod med två bokstäver.');
  if (kind.country) assert(country === kind.country, 'Svenska affärsfall ska ha landskod SE.');
  const isEu = payload.kind.startsWith('eu-');
  if (isEu) assert(EU.has(country), 'Välj ett annat EU-land än Sverige.');
  if (payload.kind.startsWith('non-eu-') || kind.id === 'export-sale' || kind.import) assert(country !== 'SE' && !EU.has(country), 'Detta affärsfall avser ett land utanför EU.');
  const vatNumber = String(payload.vatNumber ?? '').trim().toUpperCase();
  assert(vatNumber.length <= 30 && !/[\u0000-\u001f]/.test(vatNumber), 'VAT-numret har fel format.');
  if (isEu && !kind.purchase) assert(/^[A-Z]{2}[A-Z0-9]{2,28}$/.test(vatNumber), 'Ange köparens VAT-nummer och granska att det är giltigt.');
  assert(payload.conditionsConfirmed === true, 'Bekräfta bedömningen av momsfall, underlag och eventuell avdragsrätt.');
  const netCents = cents(payload.netCents, false), vatRate = kind.exempt ? 0 : payload.vatRate ?? 25;
  checkRate(vatRate); if (kind.reverse) assert(vatRate > 0, 'Detta omvända momsfall kräver 6, 12 eller 25 procent.');
  const deductibleBps = kind.purchase ? payload.deductibleBps ?? 10000 : 0;
  assert(Number.isInteger(deductibleBps) && deductibleBps >= 0 && deductibleBps <= 10000, 'Avdragsrätten ska vara 0–100 procent.');
  const account = kind.purchase ? payload.account ?? '4010' : '3000';
  assert(kind.purchase ? EXPENSE.has(account) : account === '3000', 'Välj ett tillåtet kostnadskonto.');
  const tax = round(netCents, vatRate, 100), deductible = round(tax, deductibleBps), excluded = tax - deductible;
  const boxes = {}, rows = [];
  if (kind.basis) boxes[kind.basis] = netCents;
  if (kind.purchase) {
    if (!kind.import) rows.push(debit(account, netCents + excluded), credit('1930', netCents + (kind.reverse ? 0 : tax)));
    else if (excluded) rows.push(debit(account, excluded));
    if (deductible) { rows.push(debit(kind.reverse ? '2645' : '2641', deductible)); boxes['48'] = deductible; }
    if (kind.reverse) { rows.push(credit(outputAccount(vatRate, kind.import), tax)); boxes[reverseBox(vatRate, kind.import)] = tax; }
  } else {
    rows.push(debit('1930', netCents + tax), credit(account, netCents));
    if (tax) { rows.push(credit(standardAccount(vatRate), tax)); boxes[ordinaryBox(vatRate)] = tax; }
  }
  return { kind: kind.id, date, reference, counterparty, country, vatNumber, netCents, vatRate, deductibleBps, account, conditionsConfirmed: true, ruleVersion: VAT_RULE_VERSION, rows: rows.filter(row => row.debitCents || row.creditCents), boxes };
}

export function validateTaxTransactions(state) {
  const records = state.taxTransactions ?? []; assert(Array.isArray(records) && records.length <= 20000, 'Momsregistreringarna har fel format.');
  const ids = new Set(), references = new Set(), claimedEntryIds = new Set();
  for (const record of records) {
    assert(typeof record.id === 'string' && !ids.has(record.id), 'Momsregistreringens ID är ogiltigt eller dubbelt.'); ids.add(record.id);
    const original = record.originalId ? records.find(item => item.id === record.originalId) : null;
    if (original) {
      assert(!original.originalId && record.date >= original.date && !records.some(item => item.id !== record.id && item.originalId === original.id), 'Momsrättelsen har en ogiltig eller dubbel originalreferens.');
      const reversed = original.rows.map(row => ({ account: row.account, debitCents: row.creditCents, creditCents: row.debitCents }));
      assert(JSON.stringify(record.rows) === JSON.stringify(reversed) && JSON.stringify(record.boxes) === JSON.stringify(Object.fromEntries(Object.entries(original.boxes).map(([key, amount]) => [key, -amount]))), 'Momsrättelsen återför inte originalets belopp.');
    } else {
      assert(!record.originalId, 'Momsrättelsens original saknas.');
      const recalculated = calculateTaxTransaction(record);
      assert(JSON.stringify(record.rows) === JSON.stringify(recalculated.rows) && JSON.stringify(record.boxes) === JSON.stringify(recalculated.boxes), 'Momsregistreringens beräkning har ändrats.');
      const ref = `${record.counterparty.toLocaleLowerCase('sv')}:${record.reference.toLocaleLowerCase('sv')}`;
      assert(!references.has(ref), 'Momsunderlaget har registrerats flera gånger.'); references.add(ref);
    }
    assert(record.bookingSnapshot === snapshot(record), 'Bokförda momsuppgifter får inte ändras.');
    const entry = state.entries.find(item => item.id === record.entryId);
    assert(entry && entry.sourceType === (original ? 'tax-transaction-reversal' : 'tax-transaction') && entry.sourceId === record.id && entry.date === record.date && JSON.stringify(entry.rows) === JSON.stringify(txRows(record)), 'Momsregistreringens verifikation saknas eller har ändrats.');
    assert(!claimedEntryIds.has(entry.id), 'Momsverifikationen används flera gånger.'); claimedEntryIds.add(entry.id);
    if (original) assert(entry.correctsEntryId === original.entryId, 'Momsrättelsen saknar länk till originalverifikationen.');
    const bankAmount = sum(record.rows.filter(row => row.account === '1930').map(row => row.debitCents - row.creditCents));
    if (bankAmount) {
      const matches = state.bankTransactions.filter(item => item.matchedEntryId === entry.id && item.account === '1930');
      assert(matches.length === 1 && matches[0].amountCents === bankAmount && matches[0].date === entry.date, 'Momsregistreringens bankhändelse saknas eller är ändrad.');
    }
  }
  return { claimedEntryIds };
}

export function postTaxTransaction(state, payload) {
  validateTaxTransactions(state);
  return transact(state, draft => {
    requireOpenPeriod(draft, payload.date);
    assert(!draft.vatReturns.some(period => payload.date >= period.from && payload.date <= period.to), 'Momsperioden är redan fastställd.');
    const values = calculateTaxTransaction(payload);
    draft.taxTransactions ??= [];
    assert(!draft.taxTransactions.some(record => !record.originalId && record.counterparty.toLocaleLowerCase('sv') === values.counterparty.toLocaleLowerCase('sv') && record.reference.toLocaleLowerCase('sv') === values.reference.toLocaleLowerCase('sv')), 'Underlaget är redan registrerat.');
    const record = { id: nextId(draft, 'tax-event'), ...values };
    const entry = appendEntry(draft, { date: record.date, description: `${VAT_KINDS.find(kind => kind.id === record.kind).name} · ${record.reference}`, sourceType: 'tax-transaction', sourceId: record.id, rows: record.rows });
    record.entryId = entry.id; record.bookingSnapshot = snapshot(record); draft.taxTransactions.push(record);
    const bankAmount = sum(record.rows.filter(row => row.account === '1930').map(row => row.debitCents - row.creditCents));
    if (bankAmount) draft.bankTransactions.push({ id: nextId(draft, 'bank'), date: record.date, description: `${record.counterparty} · ${record.reference}`, account: '1930', amountCents: bankAmount, matchedEntryId: entry.id });
    addActivity(draft, `Momsfall registrerat: ${record.reference}. Bedömning bekräftad; inget skickat.`, record.id);
    validateTaxTransactions(draft);
  });
}

export function reverseTaxTransaction(state, id, { date, reason }) {
  validateTaxTransactions(state);
  return transact(state, draft => {
    requireOpenPeriod(draft, date);
    const original = draft.taxTransactions?.find(item => item.id === id); assert(original && !original.originalId, 'Välj en ursprunglig momsregistrering.');
    assert(date >= original.date && !draft.taxTransactions.some(item => item.originalId === id), 'Momsregistreringen är redan återförd eller datumet är för tidigt.');
    label(reason, 'orsak till återföringen');
    const record = { ...structuredClone(original), id: nextId(draft, 'tax-reversal'), originalId: id, date, reference: `Rättelse ${original.reference}`, reason,
      rows: original.rows.map(row => ({ account: row.account, debitCents: row.creditCents, creditCents: row.debitCents })), boxes: Object.fromEntries(Object.entries(original.boxes).map(([key, amount]) => [key, -amount])) };
    const entry = appendEntry(draft, { date, description: `Återför momsregistrering · ${reason}`, sourceType: 'tax-transaction-reversal', sourceId: record.id, correctsEntryId: original.entryId, rows: record.rows });
    record.entryId = entry.id; record.bookingSnapshot = snapshot(record); draft.taxTransactions.push(record);
    const bankAmount = sum(record.rows.filter(row => row.account === '1930').map(row => row.debitCents - row.creditCents));
    if (bankAmount) draft.bankTransactions.push({ id: nextId(draft, 'bank'), date, description: `Återför ${original.reference}`, account: '1930', amountCents: bankAmount, matchedEntryId: entry.id });
    addActivity(draft, `Momsregistreringen ${original.reference} återförd: ${reason}`, id); validateTaxTransactions(draft);
  });
}

export function getTaxDeclarationReport(state, { from = state.company.fiscalYearStart, to = state.company.fiscalYearEnd } = {}) {
  assert(validDate(from) && validDate(to) && from <= to, 'Välj en giltig rapportperiod.');
  validateTaxTransactions(state);
  const boxes = Object.fromEntries(VAT_BOXES.map(item => [item.id, 0]));
  const evidence = [], covered = new Set(), warnings = [];
  const inPeriod = date => date >= from && date <= to;
  const add = (id, date, values, label) => { if (!inPeriod(date)) return; for (const [key, amount] of Object.entries(values)) boxes[key] = sum([boxes[key] ?? 0, amount]); if (id) covered.add(id); evidence.push({ entryId: id, date, label, boxes: values }); };
  for (const invoice of state.invoices) {
    if (invoice.status === 'draft') continue;
    const sign = invoice.kind === 'credit' ? -1 : 1, values = {};
    for (const line of invoice.lines) {
      const amount = calculateLineAmounts(line, invoice.vatMode, invoice.invoiceDiscountBps ?? 0);
      const basis = invoice.vatMode === 'reverse-construction' ? '41' : '05'; values[basis] = (values[basis] ?? 0) + sign * amount.netCents;
      if (amount.vatCents) { const box = ordinaryBox(line.vatRate); values[box] = (values[box] ?? 0) + sign * amount.vatCents; }
    }
    add(invoice.entryId, invoice.date, values, invoice.number);
  }
  for (const bill of state.bills) {
    if (bill.status === 'draft') continue;
    const values = {};
    if (bill.lines) {
      const summary = calculatePurchaseLines(bill.lines); values['48'] = summary.deductibleVatCents;
      values['24'] = sum(summary.lines.filter(line => line.vatMode === 'reverse-construction').map(line => line.netCents)); values['30'] = summary.reverseVatCents;
    } else {
      const tax = bill.vatMode === 'reverse-construction' ? round(bill.netCents, 25, 100) : bill.vatCents;
      values['48'] = tax; if (bill.vatMode === 'reverse-construction') { values['24'] = bill.netCents; values['30'] = tax; }
    }
    add(bill.entryId, bill.date, values, `${bill.supplier} ${bill.number}`);
    if (bill.creditEntryId) { const creditEntry = state.entries.find(item => item.id === bill.creditEntryId); if (creditEntry) add(creditEntry.id, creditEntry.date, Object.fromEntries(Object.entries(values).map(([key, amount]) => [key, -amount])), `Kredit ${bill.number}`); }
  }
  for (const record of state.taxTransactions ?? []) add(record.entryId, record.date, record.boxes, record.reference);
  for (const asset of state.assets) if (asset.disposalEntryId) add(asset.disposalEntryId, asset.disposalDate, { '05': asset.proceedsCents, '10': round(asset.proceedsCents, 25, 100) }, `Avyttring ${asset.name}`);
  // Use the selected original net rows for credit bases and the actual credit
  // journal for rounded VAT; repeated small credits then keep exact öre totals.
  for (const record of state.settlements ?? []) {
    const entry = state.entries.find(item => item.id === record.entryId);
    if (!entry || !inPeriod(entry.date) || covered.has(entry.id)) continue;
    if (record.kind !== 'credit') continue;
    const source = (record.side === 'customer' ? state.invoices : state.bills).find(item => item.id === record.documentId);
    if (!source || !Array.isArray(record.lines)) { warnings.push(`Kredit ${entry.number} saknar ursprungligt beskattningsunderlag.`); continue; }
    const values = {};
    for (const selected of record.lines) {
      const originalLine = source.lines?.[selected.index] ?? source;
      const mode = record.side === 'customer' ? source.vatMode : originalLine.vatMode;
      const basis = record.side === 'customer' ? (mode === 'reverse-construction' ? '41' : '05') : mode === 'reverse-construction' ? '24' : null;
      if (basis) values[basis] = (values[basis] ?? 0) - selected.netCents;
    }
    for (const row of entry.rows) {
      const box = ({ '2611': '10', '2621': '11', '2631': '12', '2614': '30', '2624': '31', '2634': '32', '2615': '60', '2625': '61', '2635': '62' })[row.account];
      if (box) values[box] = (values[box] ?? 0) + row.creditCents - row.debitCents;
      if (INPUT.includes(row.account)) values['48'] = (values['48'] ?? 0) + row.debitCents - row.creditCents;
    }
    add(entry.id, entry.date, values, record.number || record.reference);
  }
  const rows = state.entries.filter(entry => inPeriod(entry.date) && !['vat-return', 'vat-transfer', 'vat-settlement'].includes(entry.sourceType)).flatMap(entry => entry.rows);
  const ledgerOutputCents = -sum(rows.filter(row => OUTPUT.includes(row.account)).map(row => row.debitCents - row.creditCents));
  const ledgerInputCents = sum(rows.filter(row => INPUT.includes(row.account)).map(row => row.debitCents - row.creditCents));
  const outputCents = sum(['10', '11', '12', '30', '31', '32', '60', '61', '62'].map(key => boxes[key]));
  boxes['49'] = outputCents - boxes['48'];
  const unclassifiedEntries = state.entries.filter(entry => inPeriod(entry.date) && !covered.has(entry.id) && !['vat-return', 'vat-transfer', 'vat-settlement'].includes(entry.sourceType) && entry.rows.some(row => [...OUTPUT, ...INPUT].includes(row.account))).map(entry => ({ id: entry.id, number: entry.number, description: entry.description }));
  if (unclassifiedEntries.length) warnings.push(`${unclassifiedEntries.length} momsverifikationer saknar fullständig deklarationsklassning.`);
  if (ledgerOutputCents !== outputCents || ledgerInputCents !== boxes['48']) warnings.push('Deklarationsfälten stämmer inte med huvudbokens moms. Utred differensen före användning.');
  return { from, to, boxes, evidence, unsupportedBoxes: [...unsupported], unclassifiedEntries, warnings: [...new Set(warnings)], ledgerOutputCents, ledgerInputCents, outputDifferenceCents: ledgerOutputCents - outputCents, inputDifferenceCents: ledgerInputCents - boxes['48'], reconciled: ledgerOutputCents === outputCents && ledgerInputCents === boxes['48'] && unclassifiedEntries.length === 0, ruleVersion: VAT_RULE_VERSION };
}

export function taxReportCsv(state, period) {
  const report = getTaxDeclarationReport(state, period);
  const rows = ['MOMSUNDERLAG;Granskningsfil, inte myndighetsinlämning', `Period;${report.from};${report.to}`, 'Fält;Beskrivning;Belopp i ören;Hela kronor;Status'];
  for (const box of VAT_BOXES) rows.push(`${box.id};${box.title};${report.boxes[box.id]};${Math.trunc(report.boxes[box.id] / 100)};${unsupported.includes(box.id) ? 'Kräver separat bedömning' : 'Beräknat för stödda affärsfall'}`);
  rows.push(`Avstämning;${report.reconciled ? 'STÄMMER FÖR KLASSADE POSTER' : 'DIFFERENS – GRANSKA'}`);
  return '\uFEFF' + rows.join('\r\n');
}
