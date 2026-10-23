// Supplier purchases, bank reconciliation and manual journals for the synthetic demo.
// No function in this module sends a payment or accesses a bank.
import { transact, appendEntry, nextId, addActivity, assert, cents, validDate, requireOpenPeriod, accountBalance } from './core.js';

const EXPENSE_ACCOUNTS = new Set(['4010', '5010', '5410', '5460', '6110', '6540', '6570', '6991']);
const BANK_ACCOUNTS = new Set(['1930', '1910', '1630']);
const VAT_RATES = new Set([0, 6, 12, 25]);
const BILL_MODES = new Set(['standard', 'reverse-construction', 'no-vat']);
const debit = (account, amount) => ({ account, debitCents: amount, creditCents: 0 });
const credit = (account, amount) => ({ account, debitCents: 0, creditCents: amount });
const trim = (value, label, maximum = 300) => {
  assert(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maximum, `Ange ${label}.`);
  return value.trim();
};
const checkedDate = (state, value) => {
  assert(validDate(value), 'Ange ett giltigt datum.');
  requireOpenPeriod(state, value);
  return value;
};
const taxAmount = (net, rate) => cents(Number((BigInt(net) * BigInt(rate) + 50n) / 100n));
const signedAmount = amount => {
  assert(Number.isSafeInteger(amount) && amount !== 0, 'Kontohändelsen behöver ett belopp i hela ören, skilt från noll.');
  cents(Math.abs(amount), false);
  return amount;
};

function findBill(state, id) {
  const bill = state.bills.find(item => item.id === id);
  assert(bill, 'Leverantörsfakturan finns inte.');
  assert(BILL_MODES.has(bill.vatMode) && VAT_RATES.has(bill.vatRate), 'Leverantörsfakturans momstyp är ogiltig.');
  assert(['draft', 'booked', 'credited'].includes(bill.status), 'Leverantörsfakturans status är ogiltig.');
  trim(bill.supplier, 'leverantör'); trim(bill.number, 'leverantörens fakturanummer', 100);
  assert(validDate(bill.date) && validDate(bill.dueDate) && bill.dueDate >= bill.date, 'Leverantörsfakturans datum är ogiltiga.');
  assert(bill.vatMode === 'reverse-construction'
    ? bill.account === '4425' && bill.vatRate === 25
    : EXPENSE_ACCOUNTS.has(bill.account), 'Kostnadskontot hör inte till fakturans inköpstyp.');
  assert(bill.vatMode !== 'no-vat' || bill.vatRate === 0, 'Ett inköp utan moms ska ha noll i momssats.');
  cents(bill.netCents, false);
  const expectedVat = bill.vatMode === 'standard' ? taxAmount(bill.netCents, bill.vatRate) : 0;
  assert(bill.vatCents === expectedVat && bill.totalCents === bill.netCents + expectedVat, 'Leverantörsfakturans belopp stämmer inte med underlaget.');
  assert(Array.isArray(bill.payments), 'Leverantörsfakturans betalningshistorik saknas.');
  if (bill.status !== 'draft') {
    assert(bill.bookingSnapshot === billSnapshot(bill), 'Bokförda fakturauppgifter får inte ändras. Skapa en kredit i stället.');
    const entry = state.entries.find(item => item.id === bill.entryId);
    assert(entry?.sourceType === 'bill' && entry.sourceId === bill.id, 'Fakturans bokförda verifikation saknas.');
  }
  return bill;
}

function billSnapshot(bill) {
  return JSON.stringify([bill.supplier, bill.number, bill.date, bill.dueDate, bill.netCents, bill.vatRate, bill.vatMode,
    bill.account, bill.vatCents, bill.totalCents, bill.reverseConfirmed, bill.projectId ?? null]);
}

function assertManagedExpenseCoverage(draft, forceTools = false) {
  const groups = [];
  if (forceTools || draft.assets.length) groups.push(['5410']);
  if (draft.inventoryValuations?.length) groups.push(['4010', '4960']);
  for (const account of new Set((draft.accruals ?? []).map(item => item.expenseAccount))) groups.push([account]);
  for (const accounts of groups) {
    const changes = new Map();
    for (const journal of draft.entries) {
      const movement = journal.rows.filter(row => accounts.includes(row.account)).reduce((total, row) => total + row.debitCents - row.creditCents, 0);
      changes.set(journal.date, (changes.get(journal.date) ?? 0) + movement);
    }
    let available = 0;
    for (const [, movement] of [...changes].sort(([a], [b]) => a.localeCompare(b))) {
      available += movement;
      assert(Number.isSafeInteger(available) && available >= 0,
        'Inköpet har redan omklassificerats eller rättats. Ändringen får inte ta bort kostnaden bakom inventarier, lager eller periodiseringar.');
    }
  }
}

function bankEvent(draft, values) {
  const account = values.account ?? '1930';
  assert(BANK_ACCOUNTS.has(account), 'Välj företagskonto, kassa eller skattekonto.');
  const event = {
    id: nextId(draft, 'bank'), date: checkedDate(draft, values.date),
    description: trim(values.description, 'en beskrivning av kontohändelsen'), account,
    amountCents: signedAmount(values.amountCents), matchedEntryId: values.matchedEntryId ?? null,
  };
  draft.bankTransactions.push(event);
  return event;
}

export function getBillOutstanding(bill) {
  assert(bill && Array.isArray(bill.payments), 'Fakturan saknar betalningshistorik.');
  if (bill.status === 'credited') return 0;
  const paid = bill.payments.reduce((total, payment) => {
    cents(payment.amountCents, false);
    return cents(total + payment.amountCents);
  }, 0);
  assert(paid <= bill.totalCents, 'Betalningarna överstiger fakturabeloppet.');
  return bill.totalCents - paid;
}

export function createBill(state, payload) {
  return transact(state, draft => {
    assert(payload && typeof payload === 'object', 'Fakturauppgifterna saknas.');
    const supplier = trim(payload.supplier, 'leverantör');
    const number = trim(payload.number, 'leverantörens fakturanummer', 100);
    const date = checkedDate(draft, payload.date);
    assert(validDate(payload.dueDate) && payload.dueDate >= date, 'Förfallodagen får inte ligga före fakturadagen.');
    assert(!draft.bills.some(item => item.supplier.toLocaleLowerCase('sv') === supplier.toLocaleLowerCase('sv') && item.number.toLocaleLowerCase('sv') === number.toLocaleLowerCase('sv')),
      'Leverantörens fakturanummer finns redan. Underlaget får inte registreras två gånger.');
    const vatMode = payload.vatMode ?? 'standard';
    assert(BILL_MODES.has(vatMode), 'Välj en momstyp som stöds av demon.');
    const vatRate = vatMode === 'no-vat' ? 0 : (payload.vatRate ?? 25);
    assert(VAT_RATES.has(vatRate), 'Välj 0, 6, 12 eller 25 procent moms.');
    assert(vatMode !== 'reverse-construction' || vatRate === 25, 'Omvänd byggmoms i demon gäller endast 25 procent.');
    const account = vatMode === 'reverse-construction' ? '4425' : (payload.account ?? '4010');
    assert(vatMode === 'reverse-construction' || EXPENSE_ACCOUNTS.has(account), 'Välj ett kostnadskonto som stöds för inköpet.');
    if (payload.projectId) assert(draft.projects.some(project => project.id === payload.projectId), 'Projektet finns inte.');
    const netCents = cents(payload.netCents, false);
    const vatCents = vatMode === 'standard' ? taxAmount(netCents, vatRate) : 0;
    const totalCents = cents(netCents + vatCents, false);
    const bill = { id: nextId(draft, 'bill'), supplier, number, date, dueDate: payload.dueDate,
      netCents, vatRate, vatMode, account, vatCents, totalCents, reverseConfirmed: payload.reverseConfirmed === true,
      status: 'draft', payments: [], ...(payload.projectId ? { projectId: payload.projectId } : {}) };
    draft.bills.push(bill);
    addActivity(draft, `Leverantörsfaktura ${number} skapad som utkast`, bill.id);
  });
}

export function bookBill(state, id) {
  return transact(state, draft => {
    const bill = findBill(draft, id);
    assert(bill.status === 'draft', 'Leverantörsfakturan är redan bokförd.');
    checkedDate(draft, bill.date);
    const rows = [debit(bill.account, bill.netCents)];
    if (bill.vatMode === 'standard' && bill.vatCents) rows.push(debit('2641', bill.vatCents));
    if (bill.vatMode === 'reverse-construction') {
      assert(bill.reverseConfirmed, 'Bekräfta att villkoren för omvänd byggmoms är uppfyllda innan du bokför.');
      const reverseVat = taxAmount(bill.netCents, 25);
      rows.push(debit('2647', reverseVat), credit('2614', reverseVat));
    }
    rows.push(credit('2440', bill.totalCents));
    const entry = appendEntry(draft, { date: bill.date, description: `${bill.supplier} · ${bill.number}`,
      sourceType: 'bill', sourceId: bill.id, rows });
    bill.status = 'booked';
    bill.entryId = entry.id;
    bill.bookingSnapshot = billSnapshot(bill);
    addActivity(draft, `Leverantörsfaktura ${bill.number} bokförd`, bill.id);
  });
}

export function payBill(state, id, payload) {
  return transact(state, draft => {
    const bill = findBill(draft, id);
    assert(bill.status === 'booked', 'Bokför fakturan innan du registrerar en betalning.');
    const date = checkedDate(draft, payload?.date);
    assert(date >= bill.date, 'Betalningen får inte ligga före fakturadagen.');
    const amountCents = cents(payload.amountCents, false);
    assert(amountCents <= getBillOutstanding(bill), 'Betalningen överstiger fakturans återstående belopp.');
    let existingBankEvent;
    if (payload.bankEventId) {
      existingBankEvent = draft.bankTransactions.find(event => event.id === payload.bankEventId);
      assert(existingBankEvent && !existingBankEvent.matchedEntryId, 'Välj en befintlig, ännu inte avstämd bankhändelse.');
      assert(existingBankEvent.account === '1930' && existingBankEvent.date === date && existingBankEvent.amountCents === -amountCents,
        'Bankhändelsens datum, konto och utbetalningsbelopp måste motsvara betalningen.');
    }
    const paymentId = nextId(draft, 'bill-payment');
    const entry = appendEntry(draft, { date, description: `Leverantörsbetalning · ${bill.number}`,
      sourceType: 'bill-payment', sourceId: paymentId,
      rows: [debit('2440', amountCents), credit('1930', amountCents)] });
    bill.payments.push({ id: paymentId, date, amountCents, entryId: entry.id });
    if (existingBankEvent) existingBankEvent.matchedEntryId = entry.id;
    else bankEvent(draft, { date, description: `${bill.supplier} · ${bill.number}`, amountCents: -amountCents, matchedEntryId: entry.id });
    addActivity(draft, `Demobetalning registrerad för ${bill.number}`, bill.id);
  });
}

export function creditBill(state, id, payload) {
  return transact(state, draft => {
    const bill = findBill(draft, id);
    assert(bill.status === 'booked', 'Endast en bokförd faktura kan krediteras.');
    assert(bill.payments.length === 0, 'Full kreditering i demon kräver en helt obetald faktura.');
    const date = checkedDate(draft, payload?.date);
    assert(date >= bill.date, 'Krediten får inte ligga före den ursprungliga fakturan.');
    const reason = trim(payload.reason, 'orsaken till krediteringen');
    const original = draft.entries.find(entry => entry.id === bill.entryId);
    const entry = appendEntry(draft, { date, description: `Kredit · ${bill.number} · ${reason}`,
      sourceType: 'bill-credit', sourceId: bill.id, correctsEntryId: original.id,
      rows: original.rows.map(row => ({ account: row.account, debitCents: row.creditCents, creditCents: row.debitCents })) });
    assertManagedExpenseCoverage(draft, bill.account === '5410');
    bill.status = 'credited';
    bill.creditEntryId = entry.id;
    bill.creditReason = reason;
    addActivity(draft, `Leverantörsfaktura ${bill.number} krediterad med länkad verifikation`, bill.id);
  });
}

export function createBankEvent(state, payload) {
  return transact(state, draft => {
    assert(payload && typeof payload === 'object', 'Kontohändelsens uppgifter saknas.');
    // Public creation never accepts an already-matched event from arbitrary input.
    const event = bankEvent(draft, { ...payload, matchedEntryId: null });
    addActivity(draft, 'Fiktiv kontohändelse registrerad för avstämning', event.id);
  });
}

export function matchBankEvent(state, id, entryId) {
  return transact(state, draft => {
    const event = draft.bankTransactions.find(item => item.id === id);
    const entry = draft.entries.find(item => item.id === entryId);
    assert(event && entry, 'Välj en kontohändelse och en befintlig verifikation.');
    checkedDate(draft, event.date);
    assert(!event.matchedEntryId, 'Kontohändelsen är redan avstämd.');
    assert(!draft.bankTransactions.some(item => item.id !== id && item.account === event.account && item.matchedEntryId === entry.id),
      'Verifikationen är redan avstämd mot en annan händelse på kontot.');
    const amount = entry.rows.filter(row => row.account === event.account).reduce((sum, row) => sum + row.debitCents - row.creditCents, 0);
    assert(amount === event.amountCents, 'Verifikationens belopp och riktning måste motsvara kontohändelsen på samma konto.');
    assert(entry.sourceType !== 'opening' && !entry.correctsEntryId && !draft.entries.some(item => item.correctsEntryId === entry.id),
      'Ingående balans och rättade verifikationer kan inte matchas mot en ny kontohändelse.');
    event.matchedEntryId = entry.id;
    addActivity(draft, `Kontohändelse avstämd mot ${entry.number}`, event.id);
  });
}

export function bookBankEvent(state, id, payload) {
  return transact(state, draft => {
    const event = draft.bankTransactions.find(item => item.id === id);
    assert(event, 'Kontohändelsen finns inte.');
    assert(!event.matchedEntryId, 'Kontohändelsen är redan bokförd eller avstämd.');
    const date = checkedDate(draft, event.date);
    const amount = signedAmount(event.amountCents);
    const amountCents = Math.abs(amount);
    const kind = payload?.kind;
    let otherAccount;
    let counterpart = false;
    if (kind === 'fee') {
      assert(event.account === '1930' && amount < 0, 'En bankavgift ska vara en utbetalning från företagskontot.');
      otherAccount = '6570';
    } else if (kind === 'transfer-tax') {
      assert(['1930', '1630'].includes(event.account), 'En skatteöverföring görs mellan företagskonto och skattekonto.');
      otherAccount = event.account === '1930' ? '1630' : '1930';
      counterpart = true;
    } else if (kind === 'cash-transfer') {
      assert(['1930', '1910'].includes(event.account), 'En kassaöverföring görs mellan företagskonto och kassa.');
      otherAccount = event.account === '1930' ? '1910' : '1930';
      counterpart = true;
    } else if (kind === 'loan') {
      assert(event.account === '1930', 'Lån registreras mot företagskontot i demon.');
      otherAccount = '2350';
      if (amount < 0) assert(-accountBalance(draft, '2350') >= amountCents, 'Amorteringen överstiger den bokförda låneskulden. Ränta registreras separat.');
    } else if (kind === 'interest') {
      assert(event.account === '1930', 'Ränta registreras mot företagskontot i demon.');
      otherAccount = amount < 0 ? '8410' : '8310';
    } else assert(false, 'Välj bankavgift, överföring, lån eller ränta.');
    const rows = amount > 0
      ? [debit(event.account, amountCents), credit(otherAccount, amountCents)]
      : [debit(otherAccount, amountCents), credit(event.account, amountCents)];
    const description = payload.description ? trim(payload.description, 'en beskrivning') : event.description;
    const entry = appendEntry(draft, { date, description, sourceType: 'bank', sourceId: event.id, rows });
    event.matchedEntryId = entry.id;
    if (counterpart) bankEvent(draft, { date, description: `Motpost · ${description}`, account: otherAccount, amountCents: -amount, matchedEntryId: entry.id });
    addActivity(draft, `Kontohändelse bokförd som ${entry.number}`, event.id);
  });
}

function manualAccountAllowed(account) {
  return typeof account === 'string' && !['1220', '1229', '1460', '1510', '1710', '1790', '2440', '2910', '2099', '3973', '4960', '7832', '7973', '8999'].includes(account) && !/^(26|27)/.test(account);
}

export function postManualEntry(state, payload) {
  return transact(state, draft => {
    const date = checkedDate(draft, payload?.date);
    const description = trim(payload.description, 'en beskrivning');
    assert(Array.isArray(payload.rows) && payload.rows.length >= 2 && payload.rows.length <= 100, 'Ange 2–100 konteringsrader.');
    assert(payload.rows.every(row => row && manualAccountAllowed(row.account)),
      'Inventarier, lager, förutbetalda kostnader, kundfordringar, leverantörsskulder, moms, löneskulder och årsresultat hanteras i sina egna flöden.');
    const sourceId = nextId(draft, 'manual');
    const entry = appendEntry(draft, { date, description, sourceType: 'manual', sourceId, rows: payload.rows });
    assertManagedExpenseCoverage(draft);
    addActivity(draft, `Manuell verifikation ${entry.number} bokförd`, entry.id);
  });
}

export function correctEntry(state, id, payload) {
  return transact(state, draft => {
    const original = draft.entries.find(entry => entry.id === id);
    assert(original, 'Verifikationen finns inte.');
    assert(original.sourceType === 'manual', 'Den här verifikationen rättas via sitt ursprungsflöde. Fakturor krediteras i fakturavyn.');
    assert(!draft.entries.some(entry => entry.correctsEntryId === original.id), 'Verifikationen har redan en länkad rättelse.');
    assert(!draft.bankTransactions.some(event => event.matchedEntryId === original.id), 'En bankavstämd verifikation kan inte rättas i det manuella flödet.');
    const date = checkedDate(draft, payload?.date);
    assert(date >= original.date, 'Rättelsen får inte ligga före den ursprungliga verifikationen.');
    const reason = trim(payload.reason, 'orsaken till rättelsen');
    const entry = appendEntry(draft, { date, description: `Rättelse av ${original.number} · ${reason}`,
      sourceType: 'manual-correction', sourceId: original.id, correctsEntryId: original.id,
      rows: original.rows.map(row => ({ account: row.account, debitCents: row.creditCents, creditCents: row.debitCents })) });
    assertManagedExpenseCoverage(draft);
    addActivity(draft, `${original.number} rättad med ${entry.number} · ${reason}`, original.id);
  });
}
