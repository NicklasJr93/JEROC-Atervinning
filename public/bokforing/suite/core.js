// Shared journal for the synthetic, browser-local accounting suite.
// Validation is an application safeguard, not a tamper-proof server archive.
import { fiscalPeriodForDate, currentYearIsClosed, assertFiscalHistoryPreserved } from './fiscal-periods.js';
export const MAX_CENTS = 1_000_000_000_000;
export const ACCOUNTS = Object.freeze([
  ['1220', 'Inventarier och verktyg'],
  ['1229', 'Ackumulerade avskrivningar på inventarier'],
  ['1460', 'Lager av handelsvaror'],
  ['1510', 'Kundfordringar'],
  ['1630', 'Skattekonto'],
  ['1680', 'Andra kortfristiga fordringar'],
  ['1710', 'Förutbetalda hyreskostnader'],
  ['1790', 'Övriga förutbetalda kostnader och upplupna intäkter'],
  ['1910', 'Kassa'],
  ['1930', 'Företagskonto'],
  ['2081', 'Aktiekapital'],
  ['2091', 'Balanserat resultat'],
  ['2098', 'Vinst eller förlust från föregående år'],
  ['2099', 'Årets resultat'],
  ['2350', 'Långfristiga lån'],
  ['2440', 'Leverantörsskulder'],
  ['2490', 'Övriga kortfristiga skulder'],
  ['2510', 'Skatteskulder'],
  ['2611', 'Utgående moms 25 %'],
  ['2614', 'Utgående moms, omvänd betalningsskyldighet'],
  ['2615', 'Utgående moms import, 25 %'],
  ['2621', 'Utgående moms 12 %'],
  ['2624', 'Utgående moms, omvänd betalningsskyldighet 12 %'],
  ['2625', 'Utgående moms import, 12 %'],
  ['2631', 'Utgående moms 6 %'],
  ['2634', 'Utgående moms, omvänd betalningsskyldighet 6 %'],
  ['2635', 'Utgående moms import, 6 %'],
  ['2641', 'Ingående moms'],
  ['2645', 'Beräknad ingående moms på förvärv från utlandet'],
  ['2647', 'Ingående moms, omvänd betalningsskyldighet'],
  ['2650', 'Redovisningskonto för moms'],
  ['2710', 'Personalskatt'],
  ['2731', 'Avräkning lagstadgade sociala avgifter'],
  ['2910', 'Upplupna löner'],
  ['2990', 'Övriga upplupna kostnader och förutbetalda intäkter'],
  ['3000', 'Försäljning inom Sverige'],
  ['3231', 'Försäljning inom byggsektorn, omvänd moms'],
  ['3960', 'Valutakursvinster på rörelsefordringar och rörelseskulder'],
  ['3973', 'Vinst vid avyttring av inventarier'],
  ['4010', 'Inköp av varor och material'],
  ['4425', 'Inköpta tjänster i Sverige, omvänd moms 25 %'],
  ['4960', 'Förändring av lager'],
  ['5010', 'Lokalhyra'],
  ['5410', 'Förbrukningsinventarier'],
  ['5460', 'Förbrukningsmaterial'],
  ['6110', 'Kontorsmaterial'],
  ['6540', 'IT-tjänster'],
  ['6570', 'Bankkostnader'],
  ['6991', 'Övriga externa kostnader'],
  ['7010', 'Löner'],
  ['7082', 'Semesterlöner'],
  ['7331', 'Skattefria kostnadsersättningar'],
  ['7390', 'Övriga kostnadsersättningar och förmåner'],
  ['7510', 'Arbetsgivaravgifter'],
  ['7832', 'Avskrivningar på inventarier och verktyg'],
  ['7960', 'Valutakursförluster på rörelsefordringar och rörelseskulder'],
  ['7973', 'Förlust vid avyttring av inventarier'],
  ['8310', 'Ränteintäkter'],
  ['8410', 'Räntekostnader'],
  ['8910', 'Skatt som belastar årets resultat'],
  ['8999', 'Årets resultat'],
].map(([number, name]) => Object.freeze({ number, name })));

const accountNumbers = new Set(ACCOUNTS.map(account => account.number));
const arrays = Object.freeze(['entries', 'activity', 'customers', 'suppliers', 'projects', 'quotes', 'invoices', 'bills', 'bankTransactions', 'employees', 'payrollRuns', 'assets', 'accruals', 'inventoryItems', 'inventoryValuations', 'vatReturns', 'rotClaims', 'yearClosures']);
const optionalArrays = Object.freeze(['settlements', 'payrollProfiles', 'payrollBatches', 'fiscalYears', 'yearWorkpapers', 'taxTransactions', 'rotPlans', 'rotApplications', 'rotRepayments', 'rotCreditEvents', 'commercialArticles', 'commercialPrices', 'commercialInvoiceOrigins', 'recurringPlans', 'commercialReminders', 'projectStockLinks', 'revenueSchedules', 'projectWorkpapers', 'sieImports', 'payrollVacationYears', 'payrollRecoveries', 'declarations', 'invoiceCreditAdjustments', 'creditPreviews', 'fxDocuments', 'fxEvents', 'cashDocuments', 'cashEvents']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
const boundedText = (value, maximum = 500) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));

export function assert(condition, message = 'Uppgifterna kunde inte godkännas.') {
  if (!condition) throw new Error(message);
}

export function cents(value, allowZero = true) {
  assert(Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value <= MAX_CENTS,
    allowZero ? 'Beloppet ska vara ett positivt belopp eller noll i hela ören.' : 'Beloppet ska vara större än noll i hela ören.');
  return value;
}

export function toCents(value) {
  assert(typeof value === 'string' || typeof value === 'number', 'Ange ett belopp.');
  const input = String(value).trim();
  // Accept Swedish thousands separators only in complete three-digit groups.
  // A dot can be a decimal mark, but ambiguous thousands dots are rejected.
  assert(/^(?:\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:[,.]\d{1,2})?$/.test(input),
    'Ange ett positivt belopp med högst två decimaler, till exempel 1 250,50.');
  const [whole, fraction = ''] = input.replace(/[ \u00a0\u202f]/g, '').split(/[,.]/);
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  assert(amount <= BigInt(MAX_CENTS), 'Beloppet är för stort.');
  return Number(amount);
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function createEmptyState() {
  return {
    schemaVersion: 2,
    sequence: 0,
    company: {
      name: 'Åkes Hantverk AB', orgNumber: 'DEMO',
      fiscalYearStart: '2026-01-01', fiscalYearEnd: '2026-12-31',
      method: 'invoice', vatPeriod: 'quarter', currency: 'SEK',
    },
    lockedPeriods: [],
    ...Object.fromEntries(arrays.map(key => [key, []])),
  };
}

export function nextId(draft, prefix = 'id') {
  assert(typeof prefix === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(prefix), 'Ogiltigt ID-prefix.');
  assert(Number.isSafeInteger(draft.sequence) && draft.sequence >= 0 && draft.sequence < Number.MAX_SAFE_INTEGER - 1,
    'Demons nummerserie kan inte fortsätta.');
  draft.sequence += 1;
  return `${prefix}-${draft.sequence}`;
}

export function addActivity(draft, label, entityId = '') {
  assert(boundedText(label), 'Händelsen behöver en beskrivning.');
  assert(entityId === '' || identifier(entityId), 'Händelsens referens är ogiltig.');
  const now = new Date().toISOString();
  const event = { id: nextId(draft, 'activity'), label, entityId, date: now, createdAt: now, actor: 'Åke' };
  draft.activity.push(event);
  return event;
}

export function requireOpenPeriod(state, date) {
  assert(validDate(date), 'Ange ett giltigt bokföringsdatum.');
  assert(date >= state.company.fiscalYearStart && date <= state.company.fiscalYearEnd,
    'Bokföringsdatumet ligger utanför räkenskapsåret.');
  assert(!state.lockedPeriods.includes(date.slice(0, 7)), 'Perioden är låst. Öppna den med en dokumenterad orsak innan du bokför.');
  assert(!currentYearIsClosed(state),
    'Räkenskapsåret är avslutat.');
}

function checkedSum(values) {
  return values.reduce((total, value) => {
    assert(Number.isSafeInteger(value) && Number.isSafeInteger(total + value), 'Beloppssumman är för stor.');
    return total + value;
  }, 0);
}

function validateRows(rows) {
  assert(Array.isArray(rows) && rows.length >= 2 && rows.length <= 1_000, 'En verifikation behöver 2–1 000 konteringsrader.');
  for (const row of rows) {
    assert(row && typeof row === 'object' && accountNumbers.has(row.account), 'Välj ett konto som finns i demokontoplanen.');
    cents(row.debitCents); cents(row.creditCents);
    assert((row.debitCents > 0) !== (row.creditCents > 0), 'Varje rad ska ha belopp i antingen debet eller kredit.');
  }
  const debitTotal = checkedSum(rows.map(row => row.debitCents));
  const creditTotal = checkedSum(rows.map(row => row.creditCents));
  cents(debitTotal, false); cents(creditTotal, false);
  assert(debitTotal > 0 && debitTotal === creditTotal, 'Debet och kredit måste balansera innan du bokför.');
}

function rowBalances(rows) {
  const balances = new Map();
  for (const row of rows) {
    const result = (balances.get(row.account) ?? 0) + row.debitCents - row.creditCents;
    assert(Number.isSafeInteger(result), 'Kontosumman är för stor.');
    balances.set(row.account, result);
  }
  return balances;
}

function isReversal(rows, original) {
  const next = rowBalances(rows);
  const prior = rowBalances(original.rows);
  return [...new Set([...next.keys(), ...prior.keys()])].every(account => (next.get(account) ?? 0) === -(prior.get(account) ?? 0));
}

export function appendEntry(draft, spec) {
  assert(spec && typeof spec === 'object', 'Verifikationens uppgifter saknas.');
  requireOpenPeriod(draft, spec.date);
  assert(boundedText(spec.description), 'Verifikationen behöver en beskrivning.');
  assert(identifier(spec.sourceType) && identifier(spec.sourceId), 'Verifikationen behöver en giltig källreferens.');
  assert(!draft.entries.some(entry => entry.sourceType === spec.sourceType && entry.sourceId === spec.sourceId),
    'Den här händelsen är redan bokförd.');
  validateRows(spec.rows);
  const hasVat = spec.rows.some(row => ['2611', '2621', '2631', '2614', '2615', '2624', '2625', '2634', '2635', '2641', '2645', '2647'].includes(row.account));
  assert(!hasVat || !draft.vatReturns.some(period => spec.date >= period.from && spec.date <= period.to),
    'Momsperioden är redan fastställd. En senare momsändring behöver bokföras i en öppen, ännu inte fastställd period.');
  if (spec.correctsEntryId !== undefined) {
    const original = draft.entries.find(entry => entry.id === spec.correctsEntryId);
    assert(original, 'Ursprungsverifikationen saknas.');
    assert(!draft.entries.some(entry => entry.correctsEntryId === original.id), 'Verifikationen har redan rättats.');
    assert(!original.correctsEntryId, 'Rättelseverifikationen kan inte rättas igen i det här demoflödet.');
    assert(spec.date >= original.date, 'En rättelse kan inte dateras före ursprungsverifikationen.');
    assert(isReversal(spec.rows, original), 'Rättelsen måste återföra ursprungsverifikationens belopp.');
  }
  const entry = {
    id: nextId(draft, 'entry'), number: `A${draft.entries.length + 1}`,
    date: spec.date, description: spec.description.trim(),
    sourceType: spec.sourceType, sourceId: spec.sourceId,
    rows: spec.rows.map(row => ({ account: row.account, debitCents: row.debitCents, creditCents: row.creditCents })),
    createdAt: new Date().toISOString(), actor: 'Åke',
    ...(spec.correctsEntryId === undefined ? {} : { correctsEntryId: spec.correctsEntryId }),
  };
  draft.entries.push(entry);
  addActivity(draft, `${entry.number} · ${entry.description}`, entry.id);
  return entry;
}

export function validateState(state) {
  assert(state && typeof state === 'object' && state.schemaVersion === 2, 'Demodata har fel version.');
  assert(Number.isSafeInteger(state.sequence) && state.sequence >= 0, 'Demons ID-serie är ogiltig.');
  const company = state.company;
  assert(company && boundedText(company.name, 150) && boundedText(company.orgNumber, 40), 'Företagsuppgifterna är ogiltiga.');
  assert(company.currency === 'SEK' && ['invoice', 'cash'].includes(company.method) && ['month', 'quarter', 'year'].includes(company.vatPeriod),
    'Demons företagsinställningar stöds inte.');
  assert(validDate(company.fiscalYearStart) && validDate(company.fiscalYearEnd) && company.fiscalYearStart <= company.fiscalYearEnd,
    'Räkenskapsåret är ogiltigt.');
  assert(Array.isArray(state.lockedPeriods) && state.lockedPeriods.length <= 24 && new Set(state.lockedPeriods).size === state.lockedPeriods.length,
    'Periodlåsningen är ogiltig.');
  assert(state.lockedPeriods.every(period => typeof period === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(period) &&
    period >= company.fiscalYearStart.slice(0, 7) && period <= company.fiscalYearEnd.slice(0, 7)), 'Periodlåsningen avser en ogiltig period.');
  for (const key of [...arrays, ...optionalArrays.filter(key => state[key] !== undefined)]) {
    assert(Array.isArray(state[key]) && state[key].length <= 20_000, `Demodata för ${key} har fel format eller är för stora.`);
    const ids = new Set();
    for (const item of state[key]) {
      assert(item && typeof item === 'object' && identifier(item.id) && !ids.has(item.id), `Demodata för ${key} innehåller ogiltiga eller dubbla ID:n.`);
      // Journal/history IDs are allocated from the shared sequence. Accepting a
      // restored counter behind them would reuse source IDs on the next write.
      const allocated = /^(?:entry|activity)-([1-9]\d*)$/.exec(item.id);
      if (allocated) {
        const value = Number(allocated[1]);
        assert(Number.isSafeInteger(value) && value > 0 && value <= state.sequence,
          'Demons ID-serie täcker inte sparade verifikationer eller historikhändelser.');
      }
      ids.add(item.id);
    }
  }
  const sources = new Set();
  const entries = new Map();
  const corrected = new Set();
  state.entries.forEach((entry, index) => {
    assert(entry.number === `A${index + 1}`, 'Verifikationsserien måste vara sammanhängande och unik.');
    assert(validDate(entry.date) && fiscalPeriodForDate(state, entry.date),
      'En verifikation ligger utanför räkenskapsåret.');
    assert(boundedText(entry.description) && identifier(entry.sourceType) && identifier(entry.sourceId) && timestamp(entry.createdAt) && boundedText(entry.actor, 100),
      'En verifikations uppgifter eller källreferens är ogiltiga.');
    const source = JSON.stringify([entry.sourceType, entry.sourceId]);
    assert(!sources.has(source), 'Samma händelse får inte bokföras två gånger.');
    sources.add(source);
    validateRows(entry.rows);
    if (entry.correctsEntryId !== undefined) {
      const original = entries.get(entry.correctsEntryId);
      assert(original && !original.correctsEntryId && !corrected.has(original.id) && entry.date >= original.date && isReversal(entry.rows, original),
        'Rättelsen saknar ett giltigt samband med ursprungsverifikationen.');
      corrected.add(original.id);
    }
    entries.set(entry.id, entry);
  });
  const totalDebit = checkedSum(state.entries.flatMap(entry => entry.rows.map(row => row.debitCents)));
  const totalCredit = checkedSum(state.entries.flatMap(entry => entry.rows.map(row => row.creditCents)));
  assert(totalDebit === totalCredit, 'Hela huvudboken måste balansera i debet och kredit.');
  for (const event of state.activity) {
    assert(boundedText(event.label) && timestamp(event.createdAt ?? event.date), 'En händelse i historiken är ogiltig.');
  }
  const matchedBankEntries = new Set();
  for (const transaction of state.bankTransactions) {
    assert(validDate(transaction.date) && boundedText(transaction.description) && ['1930', '1910', '1630'].includes(transaction.account ?? '1930') &&
      Number.isSafeInteger(transaction.amountCents) && transaction.amountCents !== 0 && Math.abs(transaction.amountCents) <= MAX_CENTS,
    'En bankhändelse är ogiltig.');
    if (transaction.matchedEntryId != null) {
      const entry = entries.get(transaction.matchedEntryId);
      assert(entry, 'Bankhändelsens bokföringsreferens saknas.');
      const account = transaction.account ?? '1930';
      const entryAmount = checkedSum(entry.rows.filter(row => row.account === account).map(row => row.debitCents - row.creditCents));
      assert(entryAmount === transaction.amountCents, 'Bankhändelsens belopp stämmer inte med den matchade verifikationen.');
      const match = `${entry.id}:${account}`;
      assert(!matchedBankEntries.has(match), 'Samma bokförda bankrörelse får inte matchas två gånger.');
      matchedBankEntries.add(match);
    }
  }
  return state;
}

export function transact(state, mutate) {
  validateState(state);
  assert(typeof mutate === 'function', 'Uppdateringen saknas.');
  const draft = structuredClone(state);
  const outcome = mutate(draft);
  assert(!outcome || typeof outcome.then !== 'function', 'En bokföringstransaktion får inte innehålla asynkrona steg.');
  assert(Number.isSafeInteger(draft.sequence) && draft.sequence >= state.sequence, 'Demons ID-serie får inte flyttas bakåt.');
  assert(draft.entries.length >= state.entries.length && state.entries.every((entry, index) => JSON.stringify(entry) === JSON.stringify(draft.entries[index])),
    'Bokförda verifikationer kan inte ändras eller raderas. Skapa en länkad rättelse.');
  assert(draft.activity.length >= state.activity.length && state.activity.every((event, index) => JSON.stringify(event) === JSON.stringify(draft.activity[index])),
    'Tidigare händelser i historiken kan inte ändras eller raderas.');
  assertFiscalHistoryPreserved(state, draft);
  validateState(draft);
  return draft;
}

export function accountBalance(state, account) {
  assert(accountNumbers.has(account), 'Kontot finns inte i demokontoplanen.');
  return checkedSum(state.entries.flatMap(entry => entry.rows.filter(row => row.account === account).map(row => row.debitCents - row.creditCents)));
}

const moneyFormatter = new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function money(value) {
  assert(Number.isSafeInteger(value), 'Beloppet kan inte visas.');
  return moneyFormatter.format(value / 100);
}
