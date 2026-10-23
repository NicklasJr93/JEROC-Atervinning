// Synthetic accounting workflows. Tax inputs are examples, never tax-table decisions.
import { ACCOUNTS, accountBalance, addActivity, appendEntry, assert, cents, nextId, requireOpenPeriod, transact, validDate } from './core.js';
import { getAccrualRemaining, getExpenseBasisEntries } from './periodization.js';
import { getStockValue } from './inventory.js';
import { currentYearIsClosed, historicalCompany } from './fiscal-periods.js';
import { getYearReports } from './fiscal-reports.js';
import { getRevenueDueMonths } from './commercial.js';
import { getCashClosingIssues } from './cash-method.js';
import { getFxClosingIssues } from './fx.js';
import { getRotCreditState, getRotCreditClosingIssues } from './rot-credit.js';
import { assertLegacyPayrollPaymentMonth } from './payroll-engine.js';
import { getTaxDeclarationReport } from './tax-ledger.js';

const copy = value => structuredClone(value);
const debit = (account, value) => ({ account, debitCents: value, creditCents: 0 });
const credit = (account, value) => ({ account, debitCents: 0, creditCents: value });
const compact = rows => rows.filter(row => row.debitCents || row.creditCents);
const sum = values => values.reduce((total, value) => { const result = total + value; assert(Number.isSafeInteger(result), 'Beloppet är för stort.'); return result; }, 0);
const roundRate = (amount, rate, denominator = 10000) => Number((BigInt(amount) * BigInt(rate) + BigInt(denominator / 2)) / BigInt(denominator));
const label = (value, name = 'Namn') => { assert(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 160, `${name} måste anges och får innehålla högst 160 tecken.`); return value.trim(); };
const lookup = (state, collection, id) => { const value = state[collection].find(item => item.id === id); assert(value, 'Posten kunde inte hittas.'); return value; };
const checkDate = date => assert(validDate(date), 'Ange ett giltigt datum.');
const withinYear = (state, date) => { checkDate(date); assert(date >= state.company.fiscalYearStart && date <= state.company.fiscalYearEnd, 'Datumet måste ligga i räkenskapsåret.'); };
const checkUnclosed = state => assert(!currentYearIsClosed(state), 'Räkenskapsåret är avslutat. Historiken är bevarad och kan inte ändras.');
const monthsBetween = (from, to) => {
  const result = [];
  let year = Number(from.slice(0, 4)); let month = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  while (`${year}-${String(month).padStart(2, '0')}` <= last) {
    result.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1; if (month > 12) { month = 1; year += 1; }
  }
  return result;
};
const employeeValue = (value, employeeId, fallback = 0) => value === undefined ? fallback : (typeof value === 'object' && value !== null ? value[employeeId] ?? fallback : value);
const checkedMonth = (state, month) => {
  assert(typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month), 'Ange en giltig månad.');
  assert(monthsBetween(state.company.fiscalYearStart, state.company.fiscalYearEnd).includes(month), 'Månaden ligger utanför räkenskapsåret.');
};

function bankEvent(draft, entry, account, amountCents, description) {
  draft.bankTransactions.push({ id: nextId(draft, 'bank'), date: entry.date, description, account, amountCents, matchedEntryId: entry.id });
}

export function createEmployee(state, payload) {
  return transact(state, draft => {
    checkUnclosed(draft);
    const name = label(payload.name);
    assert(['monthly', 'hourly'].includes(payload.payType), 'Välj månads- eller timlön.');
    const baseCents = cents(payload.baseCents, false);
    const withholdingCents = cents(payload.withholdingCents ?? 0);
    const employerRateBps = payload.employerRateBps ?? 3142;
    assert(Number.isSafeInteger(employerRateBps) && employerRateBps >= 0 && employerRateBps <= 10000, 'Arbetsgivaravgiften anges som 0–10000 hundradels procent.');
    const employee = { id: nextId(draft, 'emp'), name, payType: payload.payType, baseCents, withholdingCents, employerRateBps, active: true };
    draft.employees.push(employee);
    addActivity(draft, `Anställd upplagd: ${name}. Skatteavdrag och avgift är angivna demoantaganden.`, employee.id);
  });
}

export function createPayrollRun(state, payload) {
  return transact(state, draft => {
    checkUnclosed(draft); checkedMonth(draft, payload.month); requireOpenPeriod(draft, payload.date);
    assert(payload.date.slice(0, 7) === payload.month, 'Lönedatumet ska ligga i den valda lönemånaden.');
    const ids = payload.employeeIds ?? draft.employees.filter(employee => employee.active !== false).map(employee => employee.id);
    assert(Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length, 'Välj minst en anställd, utan dubbletter.');
    const lines = ids.map(id => {
      const employee = lookup(draft, 'employees', id);
      assert(employee.active !== false, 'En inaktiv anställd kan inte ingå i lönekörningen.');
      assert(!draft.payrollRuns.some(run => run.month === payload.month && run.lines.some(line => line.employeeId === id)), `${employee.name} finns redan i en lönekörning för månaden.`);
      assert(!(draft.payrollBatches ?? []).some(batch => batch.status !== 'reversed' && batch.month === payload.month &&
        (batch.people ?? []).some(person => person.employeeId === id)),
      `${employee.name} finns redan i en individuell lönekörning för månaden. Använd kompletterande lön eller rätta originalet först.`);
      const hours = employeeValue(payload.hours, id, 160);
      assert(typeof hours === 'number' && Number.isFinite(hours) && hours > 0 && hours <= 744 && Math.abs(Math.round(hours * 100) - hours * 100) < 0.000001, 'Timmar ska vara positiva med högst två decimaler.');
      const base = employee.payType === 'hourly' ? roundRate(employee.baseCents, Math.round(hours * 100), 100) : employee.baseCents;
      const sickDeductionCents = cents(employeeValue(payload.sickDeductionCents, id));
      const vacationPayCents = cents(employeeValue(payload.vacationPayCents, id));
      const benefitCents = cents(employeeValue(payload.benefitCents, id));
      const reimbursementCents = cents(employeeValue(payload.reimbursementCents, id));
      assert(sickDeductionCents <= base + vacationPayCents, 'Frånvaroavdraget överstiger lönen.');
      const grossCents = cents(sum([base, vacationPayCents]) - sickDeductionCents, false);
      const withholdingCents = cents(employeeValue(payload.withholdingCents, id, employee.withholdingCents));
      assert(withholdingCents <= grossCents, 'Skatteavdraget får inte överstiga kontant bruttolön.');
      const netCents = cents(sum([grossCents - withholdingCents, reimbursementCents]));
      const employerCents = cents(roundRate(cents(sum([grossCents, benefitCents])), employee.employerRateBps));
      return { employeeId: id, name: employee.name, payType: employee.payType, hours: employee.payType === 'hourly' ? hours : null, baseCents: base,
        sickDeductionCents, vacationPayCents, grossCents, withholdingCents, netCents, employerCents, employerRateBps: employee.employerRateBps, benefitCents, reimbursementCents };
    });
    const run = { id: nextId(draft, 'payroll'), month: payload.month, date: payload.date, status: 'draft', lines,
      calculationNote: 'Demo: skatteavdrag, arbetsgivaravgift och frånvaro är manuellt angivna antaganden. Förmåners underliggande kostnad bokförs separat.' };
    draft.payrollRuns.push(run); addActivity(draft, `Löneutkast för ${payload.month} skapat.`, run.id);
  });
}

export function getPayrollTotals(run) {
  assert(Array.isArray(run?.lines), 'Lönekörningen saknas.');
  return Object.fromEntries(['grossCents', 'withholdingCents', 'netCents', 'employerCents', 'benefitCents', 'reimbursementCents'].map(key => [key, sum(run.lines.map(line => line[key] ?? 0))]));
}

/** Recalculate the saved assumptions before posting, paying or exporting a run. */
export function validatePayrollRun(state, run) {
  assert(run && typeof run === 'object' && Array.isArray(run.lines) && run.lines.length > 0, 'Lönekörningens underlag saknas.');
  const periodState = { ...state, company: historicalCompany(state, run.date) };
  checkedMonth(periodState, run.month); withinYear(periodState, run.date);
  assert(run.date.slice(0, 7) === run.month, 'Lönekörningens datum stämmer inte med månaden.');
  assert(new Set(run.lines.map(line => line.employeeId)).size === run.lines.length, 'En anställd förekommer flera gånger i lönekörningen.');
  for (const line of run.lines) {
    const employee = lookup(state, 'employees', line.employeeId);
    assert(line.name === employee.name && line.payType === employee.payType, 'Löneraden stämmer inte med den anställdes sparade underlag.');
    const rate = employee.employerRateBps;
    assert(Number.isSafeInteger(rate) && rate >= 0 && rate <= 10000 && line.employerRateBps === rate, 'Löneradens arbetsgivaravgift har ogiltigt beräkningsunderlag.');
    cents(employee.baseCents, false);
    let expectedBase = employee.baseCents;
    if (employee.payType === 'hourly') {
      assert(typeof line.hours === 'number' && Number.isFinite(line.hours) && line.hours > 0 && line.hours <= 744 && Math.abs(Math.round(line.hours * 100) - line.hours * 100) < 0.000001, 'Löneradens timmar är ogiltiga.');
      expectedBase = roundRate(employee.baseCents, Math.round(line.hours * 100), 100);
    } else assert(employee.payType === 'monthly' && line.hours === null, 'Löneradens löneform är ogiltig.');
    cents(line.baseCents, false); cents(line.sickDeductionCents); cents(line.vacationPayCents); cents(line.benefitCents); cents(line.reimbursementCents);
    cents(line.grossCents, false); cents(line.withholdingCents); cents(line.netCents); cents(line.employerCents);
    assert(line.baseCents === expectedBase, 'Löneradens grundlön stämmer inte med beräkningsunderlaget.');
    const expectedGross = sum([expectedBase, line.vacationPayCents]) - line.sickDeductionCents;
    assert(expectedGross > 0 && line.grossCents === expectedGross && line.withholdingCents <= expectedGross, 'Löneradens bruttolön, frånvaro eller skatteavdrag stämmer inte.');
    assert(line.netCents === sum([expectedGross - line.withholdingCents, line.reimbursementCents]), 'Löneradens nettolön stämmer inte.');
    assert(line.employerCents === roundRate(cents(sum([expectedGross, line.benefitCents])), rate), 'Löneradens arbetsgivaravgift stämmer inte med sparade antaganden.');
  }
  return run;
}

export function postPayroll(state, id) {
  return transact(state, draft => {
    const run = lookup(draft, 'payrollRuns', id); assert(run.status === 'draft', 'Lönekörningen är redan bokförd.');
    validatePayrollRun(draft, run);
    const totals = getPayrollTotals(run);
    const rows = compact([debit('7010', totals.grossCents), debit('7331', totals.reimbursementCents), debit('7510', totals.employerCents),
      credit('2710', totals.withholdingCents), credit('2731', totals.employerCents), credit('2910', totals.netCents)]);
    const entry = appendEntry(draft, { date: run.date, description: `Lön ${run.month} · angivna demoantaganden`, sourceType: 'payroll', sourceId: id, rows });
    run.entryId = entry.id; run.status = 'posted'; addActivity(draft, `Lönekörning ${run.month} bokförd som ${entry.number}.`, id);
  });
}

export function payPayroll(state, id, { date }) {
  return transact(state, draft => {
    const run = lookup(draft, 'payrollRuns', id); assert(run.status === 'posted', 'Bokför lönekörningen först. Utbetalning kan registreras en gång.');
    validatePayrollRun(draft, run);
    assert(date >= run.date, 'Utbetalningen kan inte ligga före lönedatumet.');
    assertLegacyPayrollPaymentMonth(draft, run, date);
    const total = getPayrollTotals(run).netCents;
    if (total) {
      const entry = appendEntry(draft, { date, description: `Löneutbetalning ${run.month}`, sourceType: 'payroll-payment', sourceId: id,
        rows: [debit('2910', total), credit('1930', total)] });
      run.paymentEntryId = entry.id; bankEvent(draft, entry, '1930', -total, `Löneutbetalning ${run.month}`);
    } else requireOpenPeriod(draft, date);
    run.status = 'paid'; run.paidDate = date; addActivity(draft, `Löneutbetalning ${run.month} registrerad i demon.`, id);
  });
}

export function settlePayrollTaxes(state, id, { date }) {
  return transact(state, draft => {
    const run = lookup(draft, 'payrollRuns', id);
    assert(['posted', 'paid'].includes(run.status), 'Bokför lönekörningen innan skatt och avgifter regleras.');
    assert(!run.taxesSettled, 'Lönekörningens skatt och avgifter är redan reglerade.');
    validatePayrollRun(draft, run); requireOpenPeriod(draft, date);
    assert(date >= run.date, 'Skatt och avgifter kan inte regleras före lönedatumet.');
    const totals = getPayrollTotals(run); const amount = cents(sum([totals.withholdingCents, totals.employerCents]));
    run.taxSettlementEntryIds = [];
    if (amount) {
      const transfer = appendEntry(draft, { date, description: `Insättning skattekonto · lön ${run.month}`, sourceType: 'payroll-tax-transfer', sourceId: id,
        rows: [debit('1630', amount), credit('1930', amount)] });
      const settlement = appendEntry(draft, { date, description: `Skatt och arbetsgivaravgifter · ${run.month}`, sourceType: 'payroll-tax-settlement', sourceId: id,
        rows: compact([debit('2710', totals.withholdingCents), debit('2731', totals.employerCents), credit('1630', amount)]) });
      bankEvent(draft, transfer, '1930', -amount, `Löneskatter ${run.month} · överföring till skattekonto`);
      bankEvent(draft, transfer, '1630', amount, `Löneskatter ${run.month} · insättning`);
      bankEvent(draft, settlement, '1630', -amount, `Skatt och avgifter ${run.month}`);
      run.taxSettlementEntryIds = [transfer.id, settlement.id];
    }
    run.taxesSettled = true; run.taxSettledDate = date;
    addActivity(draft, `Skatt och arbetsgivaravgifter ${run.month} reglerade med simulerade kontohändelser.`, id);
  });
}

const csvCell = value => { const text = String(value ?? ''); return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`; };
export function payrollAgiCsv(state, id) {
  const run = lookup(state, 'payrollRuns', id); assert(run.status !== 'draft', 'Bokför lönekörningen innan AGI-underlaget exporteras.');
  validatePayrollRun(state, run);
  const rows = [['DEMO – granskningsunderlag, inte Skatteverkets inlämningsformat'], ['Period', 'Anställd', 'Kontant bruttolön (öre)', 'Förmån (öre)', 'Skatteavdrag (öre)', 'Arbetsgivaravgift (öre)'],
    ...run.lines.map(line => [run.month, line.name, line.grossCents, line.benefitCents, line.withholdingCents, line.employerCents])];
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n');
}

export function createAsset(state, payload) {
  return transact(state, draft => {
    checkUnclosed(draft); requireOpenPeriod(draft, payload.date);
    const name = label(payload.name); const costCents = cents(payload.costCents, false); const residualCents = cents(payload.residualCents ?? 0);
    assert(residualCents < costCents, 'Restvärdet ska vara lägre än anskaffningsvärdet.');
    assert(Number.isSafeInteger(payload.lifeMonths) && payload.lifeMonths >= 1 && payload.lifeMonths <= 600, 'Nyttjandeperioden ska vara 1–600 månader.');
    const basisEntries = getExpenseBasisEntries(draft, payload.date);
    const purchasesByDate = sum(basisEntries.filter(entry => entry.date <= payload.date).flatMap(entry => entry.rows).filter(row => row.account === '5410').map(row => row.debitCents - row.creditCents));
    assert(purchasesByDate >= costCents, 'Bokför först inköpet på 5410 i aktuellt räkenskapsår. Omklassificeringen får inte överstiga bokfört inköp vid anskaffningsdatumet.');
    const expenseChanges = new Map([[payload.date, -costCents]]);
    for (const journal of basisEntries) {
      const change = sum(journal.rows.filter(row => row.account === '5410').map(row => row.debitCents - row.creditCents));
      expenseChanges.set(journal.date, (expenseChanges.get(journal.date) ?? 0) + change);
    }
    let availableExpense = 0;
    for (const [, change] of [...expenseChanges].sort(([a], [b]) => a.localeCompare(b))) {
      availableExpense += change;
      assert(Number.isSafeInteger(availableExpense) && availableExpense >= 0, 'Inköpet är redan använt i en annan omklassificering. Samma inköp får inte bli flera inventarier.');
    }
    const asset = { id: nextId(draft, 'asset'), name, date: payload.date, costCents, lifeMonths: payload.lifeMonths, residualCents, depreciations: [], status: 'active' };
    const entry = appendEntry(draft, { date: payload.date, description: `Omklassificering till inventarie · ${name}`, sourceType: 'asset-acquisition', sourceId: asset.id,
      rows: [debit('1220', costCents), credit('5410', costCents)] });
    asset.entryId = entry.id; draft.assets.push(asset); addActivity(draft, `Inventarie upplagd: ${name}. Nyttjandeperioden är en manuell bedömning.`, asset.id);
  });
}

export function depreciateAsset(state, id, { date }) {
  return transact(state, draft => {
    const asset = lookup(draft, 'assets', id); assert(asset.status === 'active', 'Inventarien är avyttrad.');
    requireOpenPeriod(draft, date); assert(date >= asset.date, 'Avskrivningen kan inte ligga före anskaffningen.');
    const month = date.slice(0, 7); assert(!asset.depreciations.some(item => item.month === month), 'Inventarien är redan avskriven för månaden.');
    const latest = asset.depreciations.at(-1); assert(!latest || latest.date < date, 'Avskrivningar ska registreras i tidsordning.');
    const expectedMonth = monthsBetween(asset.date, date)[asset.depreciations.length];
    assert(month === expectedMonth, `Avskriv först ${expectedMonth ?? 'nästa månad'} så att planen följs utan överhoppade månader.`);
    const cumulative = sum(asset.depreciations.map(item => item.amountCents));
    const depreciable = asset.costCents - asset.residualCents;
    assert(cumulative < depreciable, 'Inventarien är redan helt avskriven till restvärdet.');
    // Cumulative proportional rounding prevents a residual cent drift over the full plan.
    const exactTarget = Number((BigInt(depreciable) * BigInt(asset.depreciations.length + 1) * 2n + BigInt(asset.lifeMonths)) / BigInt(asset.lifeMonths * 2));
    const amountCents = Math.min(depreciable - cumulative, Math.max(1, Math.min(depreciable, exactTarget) - cumulative));
    const entry = appendEntry(draft, { date, description: `Avskrivning ${month} · ${asset.name}`, sourceType: 'asset-depreciation', sourceId: `${id}:${month}`,
      rows: [debit('7832', amountCents), credit('1229', amountCents)] });
    asset.depreciations.push({ month, date, amountCents, entryId: entry.id }); addActivity(draft, `Avskrivning registrerad för ${asset.name}, ${month}.`, id);
  });
}

export function disposeAsset(state, id, { date, proceedsCents = 0 }) {
  return transact(state, draft => {
    const asset = lookup(draft, 'assets', id); assert(asset.status === 'active', 'Inventarien är redan avyttrad.');
    requireOpenPeriod(draft, date); assert(date >= asset.date && asset.depreciations.every(item => item.date <= date), 'Avyttringen kan inte ligga före anskaffning eller bokförd avskrivning.');
    cents(proceedsCents); const accumulated = sum(asset.depreciations.map(item => item.amountCents));
    const bookValue = asset.costCents - accumulated; const vat = roundRate(proceedsCents, 2500); const gross = cents(sum([proceedsCents, vat]));
    const difference = proceedsCents - bookValue;
    const rows = compact([debit('1229', accumulated), credit('1220', asset.costCents), debit('1930', gross), credit('2611', vat),
      ...(difference >= 0 ? [credit('3973', difference)] : [debit('7973', -difference)])]);
    const entry = appendEntry(draft, { date, description: `${proceedsCents ? 'Försäljning' : 'Utrangering'} · ${asset.name}`, sourceType: 'asset-disposal', sourceId: id, rows });
    if (gross) bankEvent(draft, entry, '1930', gross, `Försäljning ${asset.name}`);
    asset.status = 'disposed'; asset.disposalDate = date; asset.disposalEntryId = entry.id; asset.proceedsCents = proceedsCents;
    addActivity(draft, `Inventarie avyttrad: ${asset.name}.`, id);
  });
}

export function getReports(state) {
  return getYearReports(state);
}

const outputAccounts = ['2611', '2621', '2631', '2614', '2615', '2624', '2625', '2634', '2635'];
const inputAccounts = ['2641', '2647', '2645'];
export function getVatPeriodBounds(state, date) {
  withinYear(state, date);
  if (state.company.vatPeriod === 'year') return { from: state.company.fiscalYearStart, to: state.company.fiscalYearEnd };
  assert(['month', 'quarter'].includes(state.company.vatPeriod), 'Företagets momsperiod stöds inte.');
  const year = Number(date.slice(0, 4)); const month = Number(date.slice(5, 7));
  const startMonth = state.company.vatPeriod === 'quarter' ? Math.floor((month - 1) / 3) * 3 + 1 : month;
  const endMonth = state.company.vatPeriod === 'quarter' ? startMonth + 2 : month;
  const periodStart = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  const periodEnd = new Date(Date.UTC(year, endMonth, 0)).toISOString().slice(0, 10);
  return { from: periodStart < state.company.fiscalYearStart ? state.company.fiscalYearStart : periodStart,
    to: periodEnd > state.company.fiscalYearEnd ? state.company.fiscalYearEnd : periodEnd };
}

export function getVatReport(state, { from, to }) {
  withinYear(state, from); withinYear(state, to); assert(from <= to, 'Momsperiodens start får inte ligga efter slutet.');
  const entries = state.entries.filter(entry => entry.date >= from && entry.date <= to && !['vat-return', 'vat-settlement', 'vat-transfer'].includes(entry.sourceType));
  const rows = entries.flatMap(entry => entry.rows);
  const balances = Object.fromEntries([...outputAccounts, ...inputAccounts].map(account => [account, sum(rows.filter(row => row.account === account).map(row => row.debitCents - row.creditCents))]));
  const outputCents = -sum(outputAccounts.map(account => balances[account]));
  const inputCents = sum(inputAccounts.map(account => balances[account]));
  return { from, to, outputCents, inputCents, payableCents: outputCents - inputCents, balances,
    entries: entries.filter(entry => entry.rows.some(row => [...outputAccounts, ...inputAccounts].includes(row.account))) };
}

export function fileVatPeriod(state, { from, to, date }) {
  return transact(state, draft => {
    checkUnclosed(draft); requireOpenPeriod(draft, date);
    const bounds = getVatPeriodBounds(draft, from);
    assert(from === bounds.from && to === bounds.to, 'Välj en hel momsperiod enligt företagets inställning för månad, kvartal eller år.');
    const report = getVatReport(draft, { from, to });
    assert(date >= to, 'Momsunderlaget kan inte fastställas före periodens sista dag.');
    assert(!draft.vatReturns.some(item => item.from <= to && item.to >= from), 'Perioden överlappar redan fastställd moms.');
    const unfinished = [...draft.invoices, ...draft.bills].some(item => item.status === 'draft' && item.date >= from && item.date <= to);
    assert(!unfinished, 'Granska fakturautkast i momsperioden innan underlaget fastställs.');
    const declaration = getTaxDeclarationReport(draft, { from, to });
    assert(declaration.warnings.length === 0, 'Momsunderlaget har oklassificerade eller ofullständiga poster. Utred granskningsvarningarna innan perioden fastställs.');
    const record = { id: nextId(draft, 'vat'), from, to, date, outputCents: report.outputCents, inputCents: report.inputCents,
      payableCents: report.payableCents, status: 'filed', entryId: null, settlementEntryIds: [], evidenceEntryIds: report.entries.map(entry => entry.id), balances: copy(report.balances) };
    const rows = [...outputAccounts, ...inputAccounts].flatMap(account => report.balances[account] > 0 ? [credit(account, report.balances[account])] : report.balances[account] < 0 ? [debit(account, -report.balances[account])] : []);
    if (record.payableCents > 0) rows.push(credit('2650', record.payableCents));
    else if (record.payableCents < 0) rows.push(debit('2650', -record.payableCents));
    if (rows.length) record.entryId = appendEntry(draft, { date, description: `Fastställt momsunderlag ${from}–${to}`, sourceType: 'vat-return', sourceId: record.id, rows }).id;
    draft.vatReturns.push(record); addActivity(draft, `Momsunderlag för ${from}–${to} fastställt i demon; ingen deklaration skickad.`, record.id);
  });
}

export function settleVat(state, id, { date }) {
  return transact(state, draft => {
    const record = lookup(draft, 'vatReturns', id); assert(record.status === 'filed', 'Momsperioden är redan reglerad.');
    requireOpenPeriod(draft, date); assert(date >= record.date, 'Regleringen kan inte ligga före fastställt momsunderlag.');
    const amount = Math.abs(record.payableCents);
    if (amount) {
      const payment = record.payableCents > 0;
      const transfer = appendEntry(draft, { date, description: `${payment ? 'Insättning' : 'Återbetalning'} skattekonto · moms`, sourceType: 'vat-transfer', sourceId: id,
        rows: payment ? [debit('1630', amount), credit('1930', amount)] : [debit('1930', amount), credit('1630', amount)] });
      const settlement = appendEntry(draft, { date, description: `Reglering moms ${record.from}–${record.to}`, sourceType: 'vat-settlement', sourceId: id,
        rows: payment ? [debit('2650', amount), credit('1630', amount)] : [debit('1630', amount), credit('2650', amount)] });
      bankEvent(draft, transfer, '1930', payment ? -amount : amount, 'Moms · överföring skattekonto');
      bankEvent(draft, transfer, '1630', payment ? amount : -amount, 'Moms · överföring från/till bank');
      bankEvent(draft, settlement, '1630', payment ? -amount : amount, 'Momsreglering');
      record.settlementEntryIds = [transfer.id, settlement.id];
    }
    record.status = 'settled'; record.settledDate = date; addActivity(draft, 'Momsreglering bokförd med simulerade kontohändelser.', id);
  });
}

export function lockPeriod(state, month) {
  return transact(state, draft => {
    checkUnclosed(draft); checkedMonth(draft, month);
    assert(!draft.lockedPeriods.includes(month), 'Perioden är redan låst.');
    assert(!draft.bankTransactions.some(item => item.date.startsWith(month) && !item.matchedEntryId), 'Stäm av periodens kontohändelser före låsning.');
    assert(![...draft.invoices, ...draft.bills, ...(draft.fxDocuments ?? []), ...(draft.cashDocuments ?? [])].some(item => item.date.startsWith(month) && item.status === 'draft'), 'Perioden innehåller fakturautkast som behöver behandlas.');
    assert(!draft.payrollRuns.some(item => item.month === month && item.status === 'draft'), 'Perioden innehåller en lönekörning som behöver behandlas.');
    assert(!(draft.payrollBatches ?? []).some(item => item.date.startsWith(month) && item.status === 'draft'), 'Perioden innehåller ett individuellt löneutkast som behöver behandlas.');
    assert(!getRevenueDueMonths(draft, month).some(item => item.month === month), 'Perioden innehåller intäktsperiodiseringar som behöver bokföras.');
    if (month === draft.company.fiscalYearEnd.slice(0, 7)) {
      assert(!getCashClosingIssues(draft).length, 'Bokslutsboka kontantmetodens obetalda poster före låsning av årets sista månad.');
      assert(!getFxClosingIssues(draft).length, 'Granska valutaposternas balansdagsvärdering före låsning av årets sista månad.');
    }
    draft.lockedPeriods.push(month); draft.lockedPeriods.sort(); addActivity(draft, `Perioden ${month} låst.`, month);
  });
}

export function unlockPeriod(state, month, reason) {
  return transact(state, draft => {
    checkUnclosed(draft); checkedMonth(draft, month); const explanation = label(reason, 'Anledning');
    assert(draft.lockedPeriods.includes(month), 'Perioden är inte låst.');
    draft.lockedPeriods = draft.lockedPeriods.filter(item => item !== month); addActivity(draft, `Perioden ${month} öppnad igen. Anledning: ${explanation}`, month);
  });
}

export function getCloseChecklist(state) {
  const months = monthsBetween(state.company.fiscalYearStart, state.company.fiscalYearEnd);
  const unlocked = months.filter(month => !state.lockedPeriods.includes(month));
  const draftDocs = [...state.invoices, ...state.bills, ...(state.fxDocuments ?? []), ...(state.cashDocuments ?? [])].filter(item => item.status === 'draft');
  const unmatched = state.bankTransactions.filter(item => !item.matchedEntryId);
  const draftPayroll = [...state.payrollRuns, ...(state.payrollBatches ?? [])].filter(item => item.status === 'draft');
  const openRot = state.invoices.filter(invoice => {
    if (!invoice.rot || invoice.kind === 'credit' || invoice.status !== 'issued') return false;
    if (getRotCreditState(state, invoice.id)) return false;
    if ((state.rotPlans ?? []).some(plan => plan.invoiceId === invoice.id)) return false;
    const claim = state.rotClaims.find(item => item.invoiceId === invoice.id);
    if (!claim || claim.status === 'prepared') return true;
    if (claim.status === 'denied') return false;
    const paid = sum((invoice.payments ?? []).filter(payment => payment.payer === 'tax').map(payment => payment.amountCents));
    return claim.status !== 'approved' || paid < claim.approvedCents;
  });
  const outstandingVat = [...outputAccounts, ...inputAccounts].some(account => accountBalance(state, account) !== 0);
  const unfinishedAssets = state.assets.filter(asset => asset.status === 'active' && sum(asset.depreciations.map(item => item.amountCents)) < asset.costCents - asset.residualCents && !asset.depreciations.some(item => item.month === state.company.fiscalYearEnd.slice(0, 7)));
  const firstMonth = state.company.fiscalYearStart.slice(0, 7); const lastMonth = state.company.fiscalYearEnd.slice(0, 7);
  const outstandingAccrualMonths = (state.accruals ?? []).flatMap(accrual => {
    getAccrualRemaining(accrual);
    const posted = new Set(accrual.postings.map(posting => posting.month));
    const start = Number(accrual.startMonth.slice(0, 4)) * 12 + Number(accrual.startMonth.slice(5, 7)) - 1;
    return Array.from({ length: accrual.months }, (_, offset) => {
      const index = start + offset; return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
    }).filter(month => month >= firstMonth && month <= lastMonth && !posted.has(month));
  });
  const latestValuation = (state.inventoryValuations ?? []).at(-1);
  const pendingStockMovements = (state.inventoryItems ?? []).flatMap(item => item.movements).filter(movement => !latestValuation || movement.date > latestValuation.date);
  const currentStockValue = getStockValue(state);
  const revenueDueMonths = getRevenueDueMonths(state);
  const extendedRotOpen = (state.rotPlans ?? []).filter(plan => {
    if (getRotCreditState(state, plan.invoiceId)) return false;
    const applications = (state.rotApplications ?? []).filter(item => item.planId === plan.id);
    return sum(applications.map(item => item.requestedCents)) < plan.reservedCents || applications.some(item => !item.decision ||
      sum((item.decision?.personLines ?? []).map(person => person.approvedCents)) >
      sum(state.invoices.flatMap(invoice => invoice.payments.filter(payment => payment.rotApplicationId === item.id).map(payment => payment.amountCents))));
  });
  const stockReconciles = accountBalance(state, '1460') === currentStockValue;
  const inventoryDone = pendingStockMovements.length === 0 && stockReconciles;
  const cashIssues = getCashClosingIssues(state), fxIssues = getFxClosingIssues(state);
  const correctedRotIssues = getRotCreditClosingIssues(state);
  return [
    { id: 'periods', label: 'Perioder låsta', done: unlocked.length === 0, detail: unlocked.length ? `${unlocked.length} perioder återstår: ${unlocked.join(', ')}` : 'Samtliga perioder är låsta.' },
    { id: 'documents', label: 'Fakturautkast behandlade', done: draftDocs.length === 0, detail: `${draftDocs.length} utkast återstår.` },
    { id: 'bank', label: 'Bank och skattekonto avstämda', done: unmatched.length === 0, detail: `${unmatched.length} omatchade händelser.` },
    { id: 'payroll', label: 'Lönekörningar bokförda', done: draftPayroll.length === 0, detail: `${draftPayroll.length} löneutkast återstår.` },
    { id: 'vat', label: 'Momsunderlag fastställda', done: !outstandingVat, detail: outstandingVat ? 'Moms finns kvar på ingående eller utgående momskonton.' : 'Momskontona är omförda till redovisningskonto.' },
    { id: 'rot', label: 'ROT-ärenden genomgångna', done: openRot.length + extendedRotOpen.length + correctedRotIssues.length === 0, detail: `${openRot.length + extendedRotOpen.length + correctedRotIssues.length} öppna ärenden återstår.` },
    { id: 'assets', label: 'Årets avskrivningar genomgångna', done: unfinishedAssets.length === 0, detail: `${unfinishedAssets.length} inventarier behöver avskrivning till årets sista månad.` },
    { id: 'accruals', label: 'Periodiseringar genomgångna', done: outstandingAccrualMonths.length === 0, detail: `${outstandingAccrualMonths.length} planerade månadsbokningar återstår för räkenskapsåret. Framtida års kostnader förs vidare.` },
    { id: 'revenue-accruals', label: 'Intäktsperiodiseringar genomgångna', done: revenueDueMonths.length === 0, detail: `${revenueDueMonths.length} planerade intäktsmånader återstår för räkenskapsåret.` },
    { id: 'inventory', label: 'Materiallager inventerat och värderat', done: inventoryDone, detail: pendingStockMovements.length ? `${pendingStockMovements.length} lagerrörelser behöver följas upp med en ny värdering.` : stockReconciles ? 'Aktuellt lagervärde stämmer med konto 1460.' : 'Aktuellt lagervärde stämmer inte med konto 1460.' },
    { id: 'cash-year-end', label: 'Kontantmetodens obetalda poster bokslutsbokade', done: cashIssues.length === 0, detail: `${cashIssues.length} kontantmetodsposter återstår att hantera.` },
    { id: 'fx-year-end', label: 'Valutaposter värderade vid bokslut', done: fxIssues.length === 0, detail: `${fxIssues.length} öppna valutaposter behöver balansdagsvärdering.` },
    { id: 'year', label: 'Året kan avslutas', done: !currentYearIsClosed(state), detail: currentYearIsClosed(state) ? 'Året är redan avslutat.' : 'Bokslutsbedömningar, skatt och periodiseringar behöver bekräftas av dig.' },
  ];
}

export function closeYear(state, { date, confirmed }) {
  return transact(state, draft => {
    checkUnclosed(draft); assert(date === draft.company.fiscalYearEnd, 'Årsavslutets datum ska vara räkenskapsårets sista dag.');
    assert(confirmed === true, 'Bekräfta att bokslutsbedömningar, skatt och periodiseringar har granskats.');
    const remaining = getCloseChecklist(draft).filter(item => !item.done); assert(!remaining.length, `Årsavslut är spärrat: ${remaining.map(item => item.label).join(', ')}.`);
    const report = getReports(draft); assert(report.balanced, 'Bokföringen balanserar inte.');
    const record = { id: nextId(draft, 'year'), date, fiscalYearStart: draft.company.fiscalYearStart, fiscalYearEnd: date, resultCents: report.resultCents,
      entryId: null, note: 'Demobokslut. Årsredovisning och deklaration ska upprättas och granskas separat.' };
    if (report.resultCents) {
      const locked = [...draft.lockedPeriods]; draft.lockedPeriods = draft.lockedPeriods.filter(month => month !== date.slice(0, 7));
      const result = report.resultCents;
      record.entryId = appendEntry(draft, { date, description: 'Årets resultat · demobokslut', sourceType: 'year-close', sourceId: record.id,
        rows: result > 0 ? [debit('8999', result), credit('2099', result)] : [debit('2099', -result), credit('8999', -result)] }).id;
      draft.lockedPeriods = locked;
    }
    record.openingBalances = getReports(draft).accounts.filter(account => /^[12]/.test(account.number) && account.balanceCents).map(account => ({ account: account.number, debitCents: Math.max(0, account.balanceCents), creditCents: Math.max(0, -account.balanceCents) }));
    draft.yearClosures.push(record); addActivity(draft, 'Året avslutat i demon. Historik och ingående balanser är bevarade.', record.id);
  });
}

export function updateCompany(state, payload) {
  return transact(state, draft => {
    checkUnclosed(draft);
    if (payload.name !== undefined) draft.company.name = label(payload.name, 'Företagsnamn');
    if (payload.orgNumber !== undefined) draft.company.orgNumber = label(payload.orgNumber, 'Organisationsnummer');
    for (const key of ['address','address2','postalCode','city','country','vatNumber']) if (payload[key] !== undefined) {
      assert(typeof payload[key] === 'string' && payload[key].length <= 300, 'Företagets adress- eller momsuppgift är ogiltig.');
      draft.company[key] = payload[key].trim();
    }
    if (payload.legalForm !== undefined) { assert(['AB','sole-trader','other'].includes(payload.legalForm), 'Välj bolagsform.'); draft.company.legalForm = payload.legalForm; }
    if (payload.registeredOffice !== undefined) { assert(typeof payload.registeredOffice === 'string' && payload.registeredOffice.length <= 150, 'Styrelsens sätesort är ogiltig.'); draft.company.registeredOffice = payload.registeredOffice.trim(); }
    if (payload.inLiquidation !== undefined) { assert(typeof payload.inLiquidation === 'boolean', 'Ange om bolaget är under likvidation.'); draft.company.inLiquidation = payload.inLiquidation; }
    if (payload.method !== undefined) { assert(payload.method === draft.company.method, 'Metoden kan inte bytas på befintlig bokföring. Starta ett nytt övningsbolag för att välja kontantmetoden.'); }
    if (payload.vatPeriod !== undefined) { assert(['month', 'quarter', 'year'].includes(payload.vatPeriod), 'Välj månad, kvartal eller år för moms.'); assert(!draft.vatReturns.length || payload.vatPeriod === draft.company.vatPeriod, 'Momsperioden kan inte ändras efter fastställt underlag.'); draft.company.vatPeriod = payload.vatPeriod; }
    for (const key of ['fiscalYearStart', 'fiscalYearEnd']) if (payload[key] !== undefined) {
      checkDate(payload[key]); assert(!draft.entries.length || payload[key] === draft.company[key], 'Räkenskapsåret kan inte flyttas när verifikationer finns.'); draft.company[key] = payload[key];
    }
    assert(draft.company.fiscalYearStart <= draft.company.fiscalYearEnd, 'Räkenskapsårets start ska ligga före slutdatumet.');
    addActivity(draft, 'Företagsinställningar uppdaterade.');
  });
}
