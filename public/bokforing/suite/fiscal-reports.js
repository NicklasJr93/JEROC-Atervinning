// Fiscal-period reports keep the balance sheet cumulative and the income statement period-specific.
import { ACCOUNTS, assert, validDate } from './core.js';
const sum = values => values.reduce((total, value) => { assert(Number.isSafeInteger(value) && Number.isSafeInteger(total + value), 'Årssumman är för stor.'); return total + value; }, 0);

export function getYearReports(state, options = {}) {
  const start = options.start ?? state.company.fiscalYearStart;
  const end = options.end ?? state.company.fiscalYearEnd;
  assert(validDate(start) && validDate(end) && start <= end, 'Välj ett giltigt rapportintervall.');
  const through = state.entries.filter(entry => entry.date <= end);
  const within = through.filter(entry => entry.date >= start);
  const balance = (entries, account) => sum(entries.flatMap(entry => entry.rows.filter(row => row.account === account).map(row => row.debitCents - row.creditCents)));
  const accounts = ACCOUNTS.map(account => {
    const incomeAccount = /^[3-8]/.test(account.number);
    const all = (incomeAccount ? within : through).flatMap(entry => entry.rows.filter(row => row.account === account.number));
    const movements = within.flatMap(entry => entry.rows.filter(row => row.account === account.number));
    const debitCents = sum(all.map(row => row.debitCents));
    const creditCents = sum(all.map(row => row.creditCents));
    return { ...account, debitCents, creditCents, balanceCents: debitCents - creditCents,
      openingCents: incomeAccount ? 0 : balance(through.filter(entry => entry.date < start), account.number),
      periodDebitCents: sum(movements.map(row => row.debitCents)), periodCreditCents: sum(movements.map(row => row.creditCents)) };
  });
  const operating = within.filter(entry => entry.sourceType !== 'year-close');
  const revenueCents = -sum(operating.flatMap(entry => entry.rows.filter(row => /^3/.test(row.account)).map(row => row.debitCents - row.creditCents))) || 0;
  const expenseCents = sum(operating.flatMap(entry => entry.rows.filter(row => /^[4-8]/.test(row.account)).map(row => row.debitCents - row.creditCents)));
  const resultCents = revenueCents - expenseCents;
  const unallocatedResultCents = -sum(accounts.filter(account => /^[3-8]/.test(account.number)).map(account => account.balanceCents)) || 0;
  const assetsCents = sum(accounts.filter(account => /^1/.test(account.number)).map(account => account.balanceCents));
  const liabilitiesEquityCents = -sum(accounts.filter(account => /^2/.test(account.number)).map(account => account.balanceCents)) + unallocatedResultCents;
  return { start, end, accounts, revenueCents, expenseCents, resultCents, unallocatedResultCents, assetsCents, liabilitiesEquityCents,
    bankCents: balance(through, '1930'), receivablesCents: balance(through, '1510'), payablesCents: -balance(through, '2440') || 0,
    balanced: sum(accounts.map(account => account.debitCents)) === sum(accounts.map(account => account.creditCents)) && assetsCents === liabilitiesEquityCents };
}
