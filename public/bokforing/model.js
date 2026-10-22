// Synthetic browser-local examples only. This module never reads production data.
export const STORAGE_KEY = 'scrapplanner-bokforing-demo-v1';

export const ACCOUNTS = Object.freeze([
  ['1510', 'Kundfordringar'],
  ['1930', 'Företagskonto'],
  ['2091', 'Balanserat resultat'],
  ['2440', 'Leverantörsskulder'],
  ['2611', 'Utgående moms 25 %'],
  ['2614', 'Utgående moms, omvänd betalningsskyldighet'],
  ['2641', 'Ingående moms'],
  ['2647', 'Ingående moms, omvänd betalningsskyldighet'],
  ['3010', 'Försäljning'],
  ['4010', 'Inköp av varor'],
  ['4415', 'Varuinköp i Sverige, omvänd moms 25 %'],
  ['5010', 'Lokalhyra'],
  ['5410', 'Förbrukningsinventarier'],
  ['5460', 'Förbrukningsmaterial'],
  ['5710', 'Frakter och transporter'],
  ['6110', 'Kontorsmaterial'],
  ['6212', 'Mobiltelefon'],
  ['6540', 'IT-tjänster'],
  ['6570', 'Bankkostnader'],
  ['6991', 'Övriga externa kostnader'],
].map(([number, name]) => Object.freeze({ number, name })));

const accountNumbers = new Set(ACCOUNTS.map(account => account.number));
// This demo only posts positive supplier purchases. Cash/bank transactions,
// sales, assets and credit notes need separate reviewed posting flows.
const purchaseExpenseAccounts = new Set(['4010', '5010', '5410', '5460', '5710', '6110', '6212', '6540', '6570', '6991']);
const vatAccounts = new Set(['2611', '2614', '2641', '2647']);
const MAX_CENTS = 1_000_000_000_000;
const clone = value => structuredClone(value);
const debit = (account, amount) => ({ account, debitCents: amount, creditCents: 0 });
const credit = (account, amount) => ({ account, debitCents: 0, creditCents: amount });
const validCents = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTS;
const validSignedCents = value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_CENTS;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const text = (value, max = 300) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isoDate = value => typeof value === 'string' && /^2026-10-(?:0[1-9]|[12]\d|3[01])$/.test(value);

function fail(message) { throw new Error(message); }

export function purchaseAccountOptions(document) {
  if (!document || !['standard', 'private', 'reverse'].includes(document.category)) return [];
  const allowed = new Set(document.category === 'reverse' ? ['4415'] : purchaseExpenseAccounts);
  allowed.add('2440');
  if (document.category === 'standard' && document.vatCents) allowed.add('2641');
  if (document.category === 'reverse') { allowed.add('2647'); allowed.add('2614'); }
  return ACCOUNTS.filter(account => allowed.has(account.number));
}

function sum(values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total + value)) fail('Beloppet är för stort.');
    total += value;
  }
  return total;
}

function validatedRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 100) fail('En verifikation behöver 2–100 konteringsrader.');
  const result = rows.map(row => {
    if (!row || typeof row !== 'object' || !accountNumbers.has(row.account)) fail('Välj ett giltigt konto på varje rad.');
    if (!validCents(row.debitCents) || !validCents(row.creditCents)) fail('Ange giltiga positiva belopp i hela ören.');
    if ((row.debitCents > 0) === (row.creditCents > 0)) fail('Varje rad ska ha ett belopp i antingen debet eller kredit.');
    return { account: row.account, debitCents: row.debitCents, creditCents: row.creditCents };
  });
  if (sum(result.map(row => row.debitCents)) !== sum(result.map(row => row.creditCents))) fail('Debet och kredit måste balansera innan du bokför.');
  return result;
}

function accountBalance(rows, account) {
  return sum(rows.filter(row => row.account === account).map(row => row.debitCents - row.creditCents));
}

function validatePurchaseRows(document, rows) {
  const checked = validatedRows(rows);
  const payableRows = checked.filter(row => row.account === '2440');
  if (payableRows.some(row => row.debitCents) || sum(payableRows.map(row => row.creditCents)) !== document.totalCents) {
    fail('Leverantörsskulden måste motsvara underlagets totalbelopp.');
  }
  const taxRows = checked.filter(row => vatAccounts.has(row.account));
  if (document.category === 'private' && (document.vatCents || taxRows.length)) {
    fail('Det här privata inköpsunderlaget har ingen moms att bokföra.');
  }
  const expectedTax = new Map();
  if (document.category === 'standard') expectedTax.set('2641', { debitCents: document.vatCents, creditCents: 0 });
  if (document.category === 'reverse') {
    if (document.vatCents) fail('Underlaget med omvänd moms får inte innehålla debiterad leverantörsmoms.');
    const reverseVat = Math.round(document.netCents / 4);
    expectedTax.set('2647', { debitCents: reverseVat, creditCents: 0 });
    expectedTax.set('2614', { debitCents: 0, creditCents: reverseVat });
  }
  if (taxRows.some(row => !expectedTax.has(row.account))) {
    fail('Momskontot hör inte till det här underlagets momstyp.');
  }
  for (const [account, expected] of expectedTax) {
    const actual = taxRows.filter(row => row.account === account);
    if (actual.some(row => expected.debitCents ? row.creditCents : row.debitCents) ||
      sum(actual.map(row => row.debitCents)) !== expected.debitCents || sum(actual.map(row => row.creditCents)) !== expected.creditCents) {
      fail(document.category === 'reverse'
        ? 'Underlaget med omvänd moms behöver båda de föreslagna momsraderna med rätt belopp och sida.'
        : 'Ingående moms måste motsvara momsen i underlaget utan extra motbokningar.');
    }
  }
  const purchaseRows = checked.filter(row => row.account !== '2440' && !vatAccounts.has(row.account));
  const allowedExpenses = document.category === 'reverse' ? new Set(['4415']) : purchaseExpenseAccounts;
  if (purchaseRows.some(row => !allowedExpenses.has(row.account))) {
    fail(document.category === 'reverse'
      ? 'Det här demounderlaget med omvänd moms ska bokföras som varuinköp på konto 4415.'
      : 'Välj ett kostnadskonto för inköpet. Bank, fordringar, intäkter och eget kapital hör inte till det här inköpsflödet.');
  }
  if (purchaseRows.some(row => row.creditCents) || sum(purchaseRows.map(row => row.debitCents)) !== document.netCents) {
    fail('Inköpsradernas debet måste motsvara underlagets nettobelopp utan extra motbokningar.');
  }
  return checked;
}

function document({ id, supplier, title, number, date, net, vat = 0, account = '6110', category = 'standard', source = 'Uppladdat underlag', status = 'draft' }) {
  const total = net + vat;
  const rows = [debit(account, net)];
  if (vat) rows.push(debit('2641', vat));
  if (category === 'reverse') rows.push(debit('2647', Math.round(net / 4)), credit('2614', Math.round(net / 4)));
  rows.push(credit('2440', total));
  return { id, supplier, title, number, date, dueDate: '2026-10-31', totalCents: total, netCents: net, vatCents: vat,
    source, category, status, version: status === 'booked' ? 2 : 1, rows,
    items: [{ description: title, quantity: 1, netCents: net }] };
}

export function createState() {
  const documents = [
    document({ id: 'doc-office', supplier: 'Kontorsbutiken AB', title: 'Kontorsmaterial', number: 'K-1042', date: '2026-10-21', net: 100_000, vat: 25_000 }),
    document({ id: 'doc-equipment', supplier: 'Arbetsplats Sverige AB', title: 'Utrustning till kontoret', number: 'AP-206', date: '2026-10-20', net: 250_000, vat: 62_500, account: '5410' }),
    document({ id: 'doc-material', supplier: 'Förbrukning Norden AB', title: 'Förbrukningsmaterial', number: 'FN-884', date: '2026-10-19', net: 500_000, vat: 125_000, account: '5460' }),
    document({ id: 'doc-phone', supplier: 'Mobilbolaget Sverige AB', title: 'Mobilabonnemang', number: 'MS-319', date: '2026-10-18', net: 60_000, vat: 15_000, account: '6212' }),
    document({ id: 'doc-freight', supplier: 'Transportpartner AB', title: 'Transport av material', number: 'TP-552', date: '2026-10-17', net: 340_000, vat: 85_000, account: '5710' }),
    document({ id: 'doc-reverse', supplier: 'Metallkretsen AB', title: 'Skrotinköp · omvänd moms', number: 'AV-2048', date: '2026-10-22', net: 500_000, account: '4415', category: 'reverse', source: 'ScrapPlanner · demounderlag' }),
    document({ id: 'doc-private', supplier: 'Privat säljare · exempel', title: 'Inköp från privat säljare', number: 'AV-2049', date: '2026-10-22', net: 300_000, account: '4010', category: 'private', source: 'ScrapPlanner · demounderlag' }),
    document({ id: 'doc-service', supplier: 'Svensk Support AB', title: 'IT-support', number: 'SS-105', date: '2026-10-16', net: 200_000, vat: 50_000, account: '6540' }),
    document({ id: 'doc-goods-booked', supplier: 'Materialgrossisten AB', title: 'Varuinköp', number: 'MG-409', date: '2026-10-07', net: 6_000_000, vat: 1_500_000, account: '4010', status: 'booked' }),
    document({ id: 'doc-equipment-booked', supplier: 'Kontorsteknik AB', title: 'Förbrukningsinventarier', number: 'KT-772', date: '2026-10-09', net: 1_500_000, vat: 375_000, account: '5410', status: 'booked' }),
    document({ id: 'doc-it-booked', supplier: 'Driftpartner Sverige AB', title: 'IT-tjänster', number: 'DS-218', date: '2026-10-12', net: 1_200_000, vat: 300_000, account: '6540', status: 'booked' }),
    document({ id: 'doc-office-booked', supplier: 'Kontorsbutiken AB', title: 'Kontorsmaterial', number: 'K-1031', date: '2026-10-15', net: 600_000, vat: 150_000, account: '6110', status: 'booked' }),
  ];
  const docRows = id => clone(documents.find(item => item.id === id).rows);
  const entries = [
    { id: 'entry-opening', number: 'A101', date: '2026-10-01', description: 'Ingående balans · demobolag', source: 'Demobolag', rows: [debit('1930', 21_955_000), credit('2091', 21_955_000)] },
    { id: 'entry-cash-sale', number: 'A102', date: '2026-10-03', description: 'Kundbetalning · faktura F-1008', source: 'Kundfakturering · demo', rows: [debit('1930', 12_500_000), credit('3010', 10_000_000), credit('2611', 2_500_000)] },
    { id: 'entry-receivable', number: 'A103', date: '2026-10-05', description: 'Kundfaktura F-1009', source: 'Kundfakturering · demo', rows: [debit('1510', 7_500_000), credit('3010', 6_000_000), credit('2611', 1_500_000)] },
    { id: 'entry-rent', number: 'A104', date: '2026-10-06', description: 'Lokalhyra oktober', source: 'Bank · demo', rows: [debit('5010', 1_800_000), credit('1930', 1_800_000)] },
    { id: 'entry-goods-bill', number: 'A105', date: '2026-10-07', description: 'Varuinköp · MG-409', source: 'Uppladdat underlag', documentId: 'doc-goods-booked', rows: docRows('doc-goods-booked') },
    { id: 'entry-equipment-bill', number: 'A106', date: '2026-10-09', description: 'Förbrukningsinventarier · KT-772', source: 'Uppladdat underlag', documentId: 'doc-equipment-booked', rows: docRows('doc-equipment-booked') },
    { id: 'entry-equipment-payment', number: 'A107', date: '2026-10-10', description: 'Betalning · KT-772', source: 'Bank · demo', rows: [debit('2440', 1_875_000), credit('1930', 1_875_000)] },
    { id: 'entry-it-bill', number: 'A108', date: '2026-10-12', description: 'IT-tjänster · DS-218', source: 'Uppladdat underlag', documentId: 'doc-it-booked', rows: docRows('doc-it-booked') },
    { id: 'entry-it-payment', number: 'A109', date: '2026-10-13', description: 'Betalning · DS-218', source: 'Bank · demo', rows: [debit('2440', 1_500_000), credit('1930', 1_500_000)] },
    { id: 'entry-office-bill', number: 'A110', date: '2026-10-15', description: 'Kontorsmaterial · K-1031', source: 'Uppladdat underlag', documentId: 'doc-office-booked', rows: docRows('doc-office-booked') },
    { id: 'entry-office-payment', number: 'A111', date: '2026-10-16', description: 'Betalning · K-1031', source: 'Bank · demo', rows: [debit('2440', 750_000), credit('1930', 750_000)] },
    { id: 'entry-bank-fee', number: 'A112', date: '2026-10-20', description: 'Bankavgift oktober', source: 'Bank · demo', rows: [debit('6570', 80_000), credit('1930', 80_000)] },
  ];
  const bankTransactions = [
    { id: 'bank-sale', date: '2026-10-03', description: 'Kundbolaget Norden AB · F-1008', amountCents: 12_500_000, matchedEntryId: null, suggestedEntryId: 'entry-cash-sale' },
    { id: 'bank-rent', date: '2026-10-06', description: 'Hyresvärden AB · oktober', amountCents: -1_800_000, matchedEntryId: null, suggestedEntryId: 'entry-rent' },
    { id: 'bank-equipment', date: '2026-10-10', description: 'Kontorsteknik AB · KT-772', amountCents: -1_875_000, matchedEntryId: 'entry-equipment-payment', suggestedEntryId: 'entry-equipment-payment' },
    { id: 'bank-it', date: '2026-10-13', description: 'Driftpartner Sverige AB · DS-218', amountCents: -1_500_000, matchedEntryId: null, suggestedEntryId: 'entry-it-payment' },
    { id: 'bank-office', date: '2026-10-16', description: 'Kontorsbutiken AB · K-1031', amountCents: -750_000, matchedEntryId: null, suggestedEntryId: 'entry-office-payment' },
    { id: 'bank-fee', date: '2026-10-20', description: 'Bankavgift oktober', amountCents: -80_000, matchedEntryId: 'entry-bank-fee', suggestedEntryId: 'entry-bank-fee' },
    { id: 'bank-unknown', date: '2026-10-21', description: 'Okänd referens · behöver utredas', amountCents: -169_000, matchedEntryId: null },
  ];
  return {
    schemaVersion: 1,
    company: { name: 'Exempelbolaget AB', period: 'Oktober 2026' },
    documents, entries, bankTransactions,
    activity: [
      { id: 'activity-demo-start', label: 'Demobolaget är redo att utforska', date: '2026-10-22T08:00:00.000Z' },
      { id: 'activity-bank', label: 'Sju bankhändelser finns att stämma av', date: '2026-10-22T08:15:00.000Z' },
      { id: 'activity-source', label: 'Två demounderlag från ScrapPlanner har kommit in', date: '2026-10-22T08:30:00.000Z' },
    ],
  };
}

export function validateState(state) {
  if (!state || state.schemaVersion !== 1 || state.company?.name !== 'Exempelbolaget AB' || state.company?.period !== 'Oktober 2026') fail('Demodata har fel version.');
  const bounds = { documents: 100, entries: 1_000, bankTransactions: 1_000, activity: 1_000 };
  for (const [key, maximum] of Object.entries(bounds)) {
    if (!Array.isArray(state[key]) || state[key].length > maximum) fail('Demodata har fel format.');
    const ids = state[key].map(item => item?.id);
    if (ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) fail('Demodata innehåller felaktiga referenser.');
  }
  if (!state.entries.length) fail('Ingående demobokföring saknas.');
  const documents = new Map(state.documents.map(item => [item.id, item]));
  const entries = new Map(state.entries.map(item => [item.id, item]));
  const numbers = new Set();
  for (const entry of state.entries) {
    if (!/^A[1-9]\d{0,8}$/.test(entry.number) || numbers.has(entry.number) || !isoDate(entry.date) || !text(entry.description) || !text(entry.source)) fail('En demoverifikation är ogiltig.');
    numbers.add(entry.number);
    validatedRows(entry.rows);
    if (entry.documentId !== undefined && !documents.has(entry.documentId)) fail('Verifikationens underlag saknas.');
  }
  for (const item of state.documents) {
    if (!text(item.supplier) || !text(item.title) || !text(item.number, 100) || !text(item.source) || !isoDate(item.date) || !isoDate(item.dueDate) ||
      !validCents(item.totalCents) || item.totalCents === 0 || !validCents(item.netCents) || !validCents(item.vatCents) || item.netCents + item.vatCents !== item.totalCents ||
      !['standard', 'private', 'reverse'].includes(item.category) || !['draft', 'booked'].includes(item.status) || !Number.isSafeInteger(item.version) || item.version < 1 || item.version > 1_000_000) fail('Ett demounderlag är ogiltigt.');
    if (!Array.isArray(item.items) || !item.items.length || item.items.length > 100 || item.items.some(row => !text(row?.description) || !Number.isSafeInteger(row.quantity) || row.quantity < 1 || !validCents(row.netCents)) ||
      sum(item.items.map(row => row.netCents)) !== item.netCents) fail('Underlagets rader måste motsvara underlagets nettobelopp.');
    validatePurchaseRows(item, item.rows);
    const booked = state.entries.filter(entry => entry.documentId === item.id);
    if (booked.length !== (item.status === 'booked' ? 1 : 0)) fail('Underlagets bokföringsstatus stämmer inte.');
    if (booked.length && JSON.stringify(booked[0].rows) !== JSON.stringify(item.rows)) fail('Bokförda rader och underlag stämmer inte.');
  }
  const matches = new Set();
  for (const bank of state.bankTransactions) {
    if (!isoDate(bank.date) || !text(bank.description) || !validSignedCents(bank.amountCents) || bank.amountCents === 0 || (bank.matchedEntryId !== null && !validId(bank.matchedEntryId))) fail('En bankhändelse är ogiltig.');
    if (bank.suggestedEntryId !== undefined && !entries.has(bank.suggestedEntryId)) fail('Bankförslaget har fel referens.');
    if (bank.matchedEntryId !== null) {
      const entry = entries.get(bank.matchedEntryId);
      if (!entry || accountBalance(entry.rows, '1930') !== bank.amountCents || matches.has(entry.id)) fail('Bankmatchningen stämmer inte.');
      matches.add(entry.id);
    }
  }
  for (const event of state.activity) {
    if (!text(event.label) || typeof event.date !== 'string' || event.date.length > 35 || !Number.isFinite(Date.parse(event.date))) fail('En historikhändelse är ogiltig.');
  }
  return state;
}

export function restoreState(raw) {
  try { validateState(raw); return clone(raw); }
  catch { return createState(); }
}

export function money(cents) {
  if (!Number.isSafeInteger(cents)) return '—';
  return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100);
}

export function getReports(state) {
  const totals = new Map(ACCOUNTS.map(account => [account.number, { ...account, debitCents: 0, creditCents: 0, balanceCents: 0 }]));
  for (const entry of state.entries) {
    for (const row of entry.rows) {
      const account = totals.get(row.account);
      if (!account) fail('Kontot finns inte i demokontoplanen.');
      account.debitCents = sum([account.debitCents, row.debitCents]);
      account.creditCents = sum([account.creditCents, row.creditCents]);
      account.balanceCents = account.debitCents - account.creditCents;
    }
  }
  const accounts = [...totals.values()].filter(account => account.debitCents || account.creditCents);
  const revenueCents = -sum(accounts.filter(account => account.number.startsWith('3')).map(account => account.balanceCents));
  const expenseCents = sum(accounts.filter(account => /^[4-7]/.test(account.number)).map(account => account.balanceCents));
  return { accounts, revenueCents, expenseCents, resultCents: revenueCents - expenseCents };
}

export function getSummary(state) {
  const reports = getReports(state);
  const balance = number => reports.accounts.find(account => account.number === number)?.balanceCents ?? 0;
  return {
    bankCents: balance('1930'), revenueCents: reports.revenueCents, expenseCents: reports.expenseCents, resultCents: reports.resultCents,
    draftCount: state.documents.filter(document => document.status === 'draft').length,
    bookedCount: state.documents.filter(document => document.status === 'booked').length,
    receivablesCents: balance('1510'), payablesCents: -balance('2440'),
  };
}

export function getVatReport(state) {
  const reports = getReports(state);
  const balance = number => reports.accounts.find(account => account.number === number)?.balanceCents ?? 0;
  const outputVatCents = -balance('2611'), inputVatCents = balance('2641');
  const reverseOutputVatCents = -balance('2614'), reverseInputVatCents = balance('2647');
  return { salesBaseCents: reports.revenueCents, outputVatCents, inputVatCents, reverseBaseCents: balance('4415'), reverseOutputVatCents, reverseInputVatCents,
    payableCents: sum([outputVatCents, reverseOutputVatCents, -inputVatCents, -reverseInputVatCents]) };
}

function nextIdentity(state, prefix) {
  let next = 1;
  const used = new Set([...state.entries, ...state.activity].map(item => item.id));
  while (used.has(prefix + next)) next++;
  return prefix + next;
}

export function bookDraft(state, documentId, rows, expectedVersion) {
  validateState(state);
  const document = state.documents.find(item => item.id === documentId);
  if (!document) fail('Underlaget kunde inte hittas.');
  if (document.status !== 'draft' || state.entries.some(entry => entry.documentId === documentId)) fail('Underlaget är redan bokfört.');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== document.version) fail('Underlaget har ändrats. Granska den senaste versionen innan du bokför.');
  const checked = validatePurchaseRows(document, rows);
  const highestNumber = Math.max(...state.entries.map(entry => Number(entry.number.slice(1))));
  if (highestNumber >= 999_999_999) fail('Demons verifikationsserie är full.');
  const result = clone(state);
  const updated = result.documents.find(item => item.id === documentId);
  updated.status = 'booked'; updated.version++; updated.rows = clone(checked);
  const entry = { id: nextIdentity(result, 'entry-demo-'), number: 'A' + (highestNumber + 1), date: document.date,
    description: document.title + ' · ' + document.number, documentId, source: document.source, rows: clone(checked) };
  result.entries.push(entry);
  result.activity.unshift({ id: nextIdentity(result, 'activity-book-'), label: entry.number + ' · ' + document.supplier + ' bokförd i demon', date: new Date().toISOString() });
  result.activity = result.activity.slice(0, 100);
  validateState(result);
  return result;
}

export function matchBank(state, bankId, entryId) {
  validateState(state);
  const bank = state.bankTransactions.find(item => item.id === bankId);
  const entry = state.entries.find(item => item.id === entryId);
  if (!bank || !entry) fail('Välj en bankhändelse och en bokföringspost.');
  if (bank.matchedEntryId !== null) fail('Bankhändelsen är redan matchad.');
  if (state.bankTransactions.some(item => item.matchedEntryId === entryId)) fail('Bokföringsposten är redan matchad mot en annan bankhändelse.');
  if (accountBalance(entry.rows, '1930') !== bank.amountCents) fail('Bankhändelsens belopp stämmer inte med bokföringspostens bankrad.');
  const result = clone(state);
  result.bankTransactions.find(item => item.id === bankId).matchedEntryId = entryId;
  result.activity.unshift({ id: nextIdentity(result, 'activity-bank-'), label: 'Bankhändelse matchad · ' + bank.description, date: new Date().toISOString() });
  result.activity = result.activity.slice(0, 100);
  return result;
}

export function assistantAnswer(state, question, context = 'overview') {
  const summary = getSummary(state), vat = getVatReport(state);
  const normalized = String(question ?? '').slice(0, 2_000).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const selectedId = typeof context === 'object' ? context?.documentId : context;
  const document = state.documents.find(item => item.id === selectedId) ?? state.documents.find(item => item.status === 'draft');
  if (/moms/.test(normalized)) return {
    text: 'I oktober visar demobolagets bokförda poster ' + money(vat.outputVatCents) + ' i vanlig utgående moms och ' + money(vat.inputVatCents) + ' i vanlig ingående moms. Omvänd moms visas separat: ' + money(vat.reverseOutputVatCents) + ' utgående och ' + money(vat.reverseInputVatCents) + ' ingående. Det ger ett preliminärt nettobelopp på ' + money(vat.payableCents) + '. Utkast ingår först när de har bokförts. Här kan du granska vilka poster som ligger bakom siffrorna.',
    links: [{ label: 'Visa momsunderlag', view: 'vat' }, { label: 'Öppna huvudboken', view: 'ledger' }],
  };
  if (/konter|detta konto|den har posten|underlaget/.test(normalized) && document) return {
    text: document.category === 'reverse'
      ? 'Det valda demounderlaget från ' + document.supplier + ' är förberett som ett bedömt inköp med omvänd moms: varuinköp ' + money(document.netCents) + ', både utgående och ingående omvänd moms ' + money(Math.round(document.netCents / 4)) + ', och leverantörsskuld ' + money(document.totalCents) + '. I en verklig affär behöver material, parternas momsstatus och avdragsrätt först verifieras. Förslaget ändrar inte bokföringen förrän du godkänner det.'
      : document.category === 'private'
        ? 'Det här demounderlaget är klassat som ett inköp från en privat säljare. Förslaget bokför inköpet mot leverantörsskuld på ' + money(document.totalCents) + ' utan ingående moms. Verklig säljarstatus och underlag behöver kontrolleras. Du kan granska raderna innan du bokför.'
        : 'Underlaget från ' + document.supplier + ' avser ' + document.title.toLowerCase() + '. Förslaget delar upp ' + money(document.totalCents) + ' i kostnad ' + money(document.netCents) + ' och ingående moms ' + money(document.vatCents) + ', mot leverantörsskuld. Granska kontot, beloppen och underlaget innan du godkänner. Debet och kredit kontrolleras av demon.',
    links: [{ label: 'Granska underlag', view: 'documents' }, { label: 'Visa huvudbok', view: 'ledger' }],
  };
  if (/resultat|kostnad|intakt|forsalj/.test(normalized)) return {
    text: 'Demobolaget har ' + money(summary.revenueCents) + ' i bokförda intäkter och ' + money(summary.expenseCents) + ' i kostnader för oktober. Resultatet är ' + money(summary.resultCents) + '. Intäkter och kostnader är något annat än bankens in- och utbetalningar; exempelvis finns ' + money(summary.receivablesCents) + ' i kundfordringar. Underlag som fortfarande är utkast ingår inte i resultatet. Demon har inga verifierade jämförelsetal för tidigare månader.',
    links: [{ label: 'Visa resultatrapport', view: 'reports' }, { label: 'Följ poster i huvudboken', view: 'ledger' }],
  };
  if (/bank|match|saldo|betala/.test(normalized)) {
    const pending = state.bankTransactions.filter(item => item.matchedEntryId === null).length;
    return { text: 'Det bokförda saldot på företagskontot är ' + money(summary.bankCents) + '. ' + pending + ' bankhändelser återstår att stämma av. En matchning kopplar en bankhändelse till en redan bokförd bankrad och bokför inte samma betalning igen. Händelsen med okänd referens behöver utredas. Demon gör inga riktiga betalningar.', links: [{ label: 'Stäm av banken', view: 'bank' }] };
  }
  if (/sakna|gransk|avvikel|klar|kvar|borja|hjalp|gora/.test(normalized)) return {
    text: 'Börja gärna med de ' + summary.draftCount + ' underlagen som väntar på granskning. Därefter kan du stämma av banken och kontrollera momsunderlaget. Jag kan förklara exemplen och föreslå nästa steg. I den här demon är svaren exempelbaserade och hämtar aktuella belopp från ditt lokala demobolag.',
    links: [{ label: 'Granska underlag', view: 'documents' }, { label: 'Stäm av banken', view: 'bank' }, { label: 'Visa momsunderlag', view: 'vat' }],
  };
  return { text: 'Jag hjälper dig att utforska demobolagets bokföring. Fråga till exempel varför ett konto föreslås, vad resultatet består av eller vad som återstår att granska. Svaren i den här första demon är exempelbaserade; jag hämtar inga uppgifter från din riktiga verksamhet.', links: [{ label: 'Visa översikten', view: 'overview' }, { label: 'Granska underlag', view: 'documents' }] };
}
