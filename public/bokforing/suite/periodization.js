// Prepaid-expense schedules for the synthetic accounting suite.
// Recognition dates and expense classification are explicit user judgements.
import { transact, appendEntry, nextId, addActivity, assert, cents, validDate, requireOpenPeriod } from './core.js';

export const ACCRUAL_EXPENSE_ACCOUNTS = Object.freeze(['5010', '6540', '6991']);
const debit = (account, amount) => ({ account, debitCents: amount, creditCents: 0 });
const credit = (account, amount) => ({ account, debitCents: 0, creditCents: amount });
const checkedMonth = value => {
  assert(typeof value === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value) && validDate(`${value}-01`), 'Ange en giltig startmånad.');
  return value;
};
const monthIndex = month => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const monthAt = index => `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
const targetAmount = (amountCents, number, months) => Number((BigInt(amountCents) * BigInt(number) * 2n + BigInt(months)) / (BigInt(months) * 2n));

export function accrualBookingSnapshot(item) {
  return JSON.stringify([item.name, item.type, item.date, item.amountCents, item.expenseAccount, item.months, item.startMonth]);
}

function validateSchedule(item) {
  assert(item && typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= 160, 'Periodiseringen behöver ett namn.');
  assert(item.type === 'prepaid', 'Demoflödet stödjer förutbetalda kostnader.');
  assert(validDate(item.date), 'Periodiseringens bokföringsdatum är ogiltigt.');
  cents(item.amountCents, false);
  assert(ACCRUAL_EXPENSE_ACCOUNTS.includes(item.expenseAccount), 'Välj lokalhyra, IT-tjänster eller övriga externa kostnader för periodiseringen.');
  assert(Number.isSafeInteger(item.months) && item.months >= 1 && item.months <= 120, 'Fördelningen ska omfatta 1–120 månader.');
  checkedMonth(item.startMonth);
  assert(item.startMonth >= item.date.slice(0, 7), 'Startmånaden får inte ligga före periodiseringens bokföringsdatum.');
  assert(monthIndex(item.startMonth) + item.months - 1 < 120_000, 'Periodiseringsplanens slutmånad är ogiltig.');
  assert(Array.isArray(item.postings) && item.postings.length <= item.months, 'Periodiseringsplanens månadshistorik är ogiltig.');
  let recognized = 0;
  for (let index = 0; index < item.postings.length; index++) {
    const posting = item.postings[index];
    const expectedMonth = monthAt(monthIndex(item.startMonth) + index);
    const expectedCumulative = targetAmount(item.amountCents, index + 1, item.months);
    assert(posting.month === expectedMonth && validDate(posting.date) && posting.date.slice(0, 7) === expectedMonth && posting.date >= item.date,
      'Periodiseringsplanens bokningar måste följa månaderna i tidsordning.');
    assert(posting.amountCents === expectedCumulative - recognized, 'Periodiseringens månadsbelopp stämmer inte med planen.');
    assert(posting.amountCents === 0 ? posting.entryId === null : typeof posting.entryId === 'string', 'Periodiseringens bokföringsreferens är ogiltig.');
    recognized = expectedCumulative;
  }
  assert(['active', 'completed'].includes(item.status) && (item.status === 'completed') === (item.postings.length === item.months),
    'Periodiseringens status stämmer inte med månadshistoriken.');
  return recognized;
}

export function getAccrualRemaining(item) {
  return item.amountCents - validateSchedule(item);
}

export function createAccrual(state, payload) {
  return transact(state, draft => {
    assert(payload && typeof payload === 'object', 'Periodiseringens uppgifter saknas.');
    assert(Array.isArray(draft.accruals), 'Demoversionen behöver uppdateras för att använda periodiseringar.');
    requireOpenPeriod(draft, payload.date);
    const item = {
      id: nextId(draft, 'accrual'), name: typeof payload.name === 'string' ? payload.name.trim() : payload.name,
      type: payload.type ?? 'prepaid', date: payload.date, amountCents: cents(payload.amountCents, false),
      expenseAccount: payload.expenseAccount, months: payload.months, startMonth: payload.startMonth,
      status: 'active', postings: [],
    };
    validateSchedule(item);
    const available = draft.entries.filter(entry => entry.date <= item.date)
      .flatMap(entry => entry.rows).filter(row => row.account === item.expenseAccount)
      .reduce((sum, row) => sum + row.debitCents - row.creditCents, 0);
    assert(Number.isSafeInteger(available) && available >= item.amountCents,
      'Bokför först kostnaden. Periodiseringen får inte överstiga bokförd nettokostnad på det valda kontot vid datumet.');
    const movements = new Map([[item.date, -item.amountCents]]);
    for (const journal of draft.entries) {
      const movement = journal.rows.filter(row => row.account === item.expenseAccount)
        .reduce((sum, row) => sum + row.debitCents - row.creditCents, 0);
      movements.set(journal.date, (movements.get(journal.date) ?? 0) + movement);
    }
    let unallocated = 0;
    for (const [, movement] of [...movements].sort(([a], [b]) => a.localeCompare(b))) {
      unallocated += movement;
      assert(Number.isSafeInteger(unallocated) && unallocated >= 0,
        'Kostnaden är redan använd i en annan omföring eller periodisering. Samma kostnad får inte periodiseras två gånger.');
    }
    const entry = appendEntry(draft, { date: item.date, description: `Förutbetald kostnad · ${item.name}`,
      sourceType: 'accrual-prepaid', sourceId: item.id,
      rows: [debit('1790', item.amountCents), credit(item.expenseAccount, item.amountCents)] });
    item.entryId = entry.id;
    item.bookingSnapshot = accrualBookingSnapshot(item);
    draft.accruals.push(item);
    addActivity(draft, `Förutbetald kostnad upplagd: ${item.name}, ${item.months} månader.`, item.id);
  });
}

export function postAccrualMonth(state, id, { date }) {
  return transact(state, draft => {
    const item = draft.accruals.find(accrual => accrual.id === id);
    assert(item, 'Periodiseringen finns inte.');
    validateSchedule(item);
    assert(item.bookingSnapshot === accrualBookingSnapshot(item), 'Den bokförda periodiseringsplanen får inte ändras.');
    assert(item.status === 'active', 'Periodiseringen är redan färdigfördelad.');
    const acquisition = draft.entries.find(entry => entry.id === item.entryId);
    assert(acquisition?.sourceType === 'accrual-prepaid' && acquisition.sourceId === item.id, 'Periodiseringens ursprungsverifikation saknas.');
    requireOpenPeriod(draft, date);
    const month = monthAt(monthIndex(item.startMonth) + item.postings.length);
    assert(date >= item.date && date.slice(0, 7) === month, `Bokför nästa planerade månad, ${month}. Månader kan inte hoppas över eller bokföras dubbelt.`);
    const alreadyRecognized = item.amountCents - getAccrualRemaining(item);
    const amountCents = targetAmount(item.amountCents, item.postings.length + 1, item.months) - alreadyRecognized;
    let entryId = null;
    if (amountCents > 0) {
      entryId = appendEntry(draft, { date, description: `Periodisering ${month} · ${item.name}`,
        sourceType: 'accrual-recognition', sourceId: `${item.id}:${month}`,
        rows: [debit(item.expenseAccount, amountCents), credit('1790', amountCents)] }).id;
    }
    item.postings.push({ month, date, amountCents, entryId });
    if (item.postings.length === item.months) item.status = 'completed';
    addActivity(draft, `Periodisering ${month} registrerad för ${item.name}.`, item.id);
  });
}
