import test from 'node:test';
import assert from 'node:assert/strict';
import { accountBalance, appendEntry, createEmptyState, transact, validateState } from '../public/bokforing/suite/core.js';
import { closeYear, createAsset, createEmployee, createPayrollRun, depreciateAsset, disposeAsset, fileVatPeriod, getCloseChecklist,
  getPayrollTotals, getReports, getVatReport, getVatPeriodBounds, lockPeriod, payPayroll, payrollAgiCsv, postPayroll, settlePayrollTaxes, settleVat, unlockPeriod, updateCompany } from '../public/bokforing/suite/finance.js';
import { createAccrual, postAccrualMonth } from '../public/bokforing/suite/periodization.js';
import { createStockItem, recordStockMovement, postStockValuation } from '../public/bokforing/suite/inventory.js';

const debit = (account, value) => ({ account, debitCents: value, creditCents: 0 });
const credit = (account, value) => ({ account, debitCents: 0, creditCents: value });
function opened() {
  return transact(createEmptyState(), state => appendEntry(state, { date: '2026-01-01', description: 'Ingående balans', sourceType: 'opening', sourceId: 'opening', rows: [debit('1930', 10_000_000), credit('2081', 2_500_000), credit('2091', 7_500_000)] }));
}
function purchased(cost = 3_000_000, date = '2026-10-01') {
  return transact(opened(), state => appendEntry(state, { date, description: 'Verktyg', sourceType: 'test-purchase', sourceId: 'tools', rows: [debit('5410', cost), credit('1930', cost)] }));
}
function employeeState() {
  return createEmployee(opened(), { name: 'Åke', payType: 'monthly', baseCents: 3_200_000, withholdingCents: 750_000, employerRateBps: 3142 });
}
function saleState() {
  return transact(opened(), state => appendEntry(state, { date: '2026-03-15', description: 'Försäljning', sourceType: 'test-sale', sourceId: 'sale', rows: [debit('1930', 1_250_000), credit('3000', 1_000_000), credit('2611', 250_000)] }));
}
const journalUnchanged = (state, fn, pattern) => { const original = JSON.stringify(state); assert.throws(fn, pattern); assert.equal(JSON.stringify(state), original); };

test('lön beräknas från uttryckliga antaganden och bokförs/betalas balanserat en gång', () => {
  let state = createPayrollRun(employeeState(), { month: '2026-10', date: '2026-10-25' });
  const run = state.payrollRuns[0];
  assert.deepEqual(getPayrollTotals(run), { grossCents: 3_200_000, withholdingCents: 750_000, netCents: 2_450_000, employerCents: 1_005_440, benefitCents: 0, reimbursementCents: 0 });
  state = postPayroll(state, run.id); assert.equal(accountBalance(state, '2910'), -2_450_000);
  assert.equal(accountBalance(state, '2710'), -750_000); assert.equal(accountBalance(state, '2731'), -1_005_440);
  journalUnchanged(state, () => postPayroll(state, run.id), /redan bokförd/);
  const beforeBank = accountBalance(state, '1930'); state = payPayroll(state, run.id, { date: '2026-10-25' });
  assert.equal(accountBalance(state, '2910'), 0); assert.equal(accountBalance(state, '1930'), beforeBank - 2_450_000);
  assert.equal(state.bankTransactions.length, 1); assert.equal(state.bankTransactions[0].matchedEntryId, state.payrollRuns[0].paymentEntryId);
  journalUnchanged(state, () => payPayroll(state, run.id, { date: '2026-10-26' }), /en gång/);
  assert.equal(getReports(state).balanced, true); validateState(state);
});

test('timlön, frånvaro, semester, förmån och utlägg har rätt separata effekter', () => {
  let state = createEmployee(opened(), { name: 'Sara', payType: 'hourly', baseCents: 20_000, withholdingCents: 200_000, employerRateBps: 3142 });
  const id = state.employees[0].id;
  state = createPayrollRun(state, { month: '2026-10', date: '2026-10-25', hours: { [id]: 120.5 }, sickDeductionCents: { [id]: 10_000 }, vacationPayCents: 20_000, benefitCents: 100_000, reimbursementCents: 30_000 });
  const totals = getPayrollTotals(state.payrollRuns[0]);
  assert.equal(totals.grossCents, 2_420_000); assert.equal(totals.netCents, 2_250_000); assert.equal(totals.employerCents, 791_784);
  state = postPayroll(state, state.payrollRuns[0].id); assert.equal(accountBalance(state, '7331'), 30_000); assert.equal(getReports(state).balanced, true);
});

test('dubbla anställda/månad och negativa löner avvisas utan mutation', () => {
  const base = employeeState();
  journalUnchanged(base, () => createPayrollRun(base, { month: '2026-10', date: '2026-10-25', sickDeductionCents: 4_000_000 }), /Frånvaro/);
  journalUnchanged(base, () => createPayrollRun(base, { month: '2026-10', date: '2026-10-25', withholdingCents: 4_000_000 }), /Skatteavdrag/);
  const state = createPayrollRun(base, { month: '2026-10', date: '2026-10-25' });
  journalUnchanged(state, () => createPayrollRun(state, { month: '2026-10', date: '2026-10-28' }), /redan/);
  journalUnchanged(base, () => createPayrollRun(base, { month: '2026-10', date: '2026-11-25' }), /lönemånaden/);
});

test('AGI-export är märkt arbetsunderlag och neutraliserar formler i fria fält', () => {
  let state = createEmployee(opened(), { name: '=HYPERLINK("example")', payType: 'monthly', baseCents: 1_000_000, withholdingCents: 100_000 });
  state = createPayrollRun(state, { month: '2026-10', date: '2026-10-25' }); const id = state.payrollRuns[0].id;
  assert.throws(() => payrollAgiCsv(state, id), /Bokför/);
  state = postPayroll(state, id); const csv = payrollAgiCsv(state, id);
  assert.match(csv, /inte Skatteverkets inlämningsformat/); assert.match(csv, /'=HYPERLINK/); assert.match(csv, /1000000/);
});

test('ändrade löneberäkningar, procentsatser och saknad anställd stoppas före bokföring', () => {
  const original = createPayrollRun(employeeState(), { month: '2026-10', date: '2026-10-25' });
  const id = original.payrollRuns[0].id;
  for (const mutation of [
    line => { line.employerCents = 1; },
    line => { line.employerRateBps = 1; },
    line => { line.grossCents += 1; },
    line => { line.withholdingCents = line.grossCents + 1; },
    line => { line.netCents += 1; },
    line => { line.employeeId = 'not-an-employee'; },
    line => { line.sickDeductionCents = -1; },
  ]) {
    const changed = structuredClone(original); mutation(changed.payrollRuns[0].lines[0]);
    journalUnchanged(changed, () => postPayroll(changed, id), /Lönerad|Posten|Belopp/);
  }
});

test('skatt och arbetsgivaravgifter regleras via skattekontot utan dubbelbetalning', () => {
  let state = createPayrollRun(employeeState(), { month: '2026-10', date: '2026-10-25' }); const id = state.payrollRuns[0].id;
  journalUnchanged(state, () => settlePayrollTaxes(state, id, { date: '2026-10-28' }), /Bokför lönekörningen/);
  state = postPayroll(state, id); const balance = accountBalance(state, '1930'); const cost = getReports(state).expenseCents;
  state = settlePayrollTaxes(state, id, { date: '2026-11-12' });
  assert.equal(accountBalance(state, '2710'), 0); assert.equal(accountBalance(state, '2731'), 0); assert.equal(accountBalance(state, '1630'), 0);
  assert.equal(accountBalance(state, '1930'), balance - 750_000 - 1_005_440); assert.equal(accountBalance(state, '2910'), -2_450_000);
  assert.equal(getReports(state).expenseCents, cost); assert.equal(state.payrollRuns[0].taxesSettled, true); assert.equal(state.bankTransactions.length, 3);
  journalUnchanged(state, () => settlePayrollTaxes(state, id, { date: '2026-11-13' }), /redan reglerade/);
  state = payPayroll(state, id, { date: '2026-10-25' }); assert.equal(accountBalance(state, '2910'), 0); assert.equal(getReports(state).balanced, true);
});

test('noll skatt och avgift markeras utan nollverifikation', () => {
  let state = createEmployee(opened(), { name: 'Test', payType: 'monthly', baseCents: 100_000, withholdingCents: 0, employerRateBps: 0 });
  state = createPayrollRun(state, { month: '2026-10', date: '2026-10-25' }); const id = state.payrollRuns[0].id; state = postPayroll(state, id);
  const count = state.entries.length; state = settlePayrollTaxes(state, id, { date: '2026-11-12' });
  assert.equal(state.entries.length, count); assert.equal(state.payrollRuns[0].taxesSettled, true); assert.deepEqual(state.payrollRuns[0].taxSettlementEntryIds, []);
});

test('inventarie omklassificerar existerande inköp och kan inte hitta på anskaffningskostnad', () => {
  journalUnchanged(opened(), () => createAsset(opened(), { name: 'Kompressor', date: '2026-10-01', costCents: 3_000_000, lifeMonths: 60 }), /5410/);
  journalUnchanged(purchased(), () => createAsset(purchased(), { name: 'Kompressor', date: '2026-09-01', costCents: 3_000_000, lifeMonths: 60 }), /anskaffningsdatumet/);
  const original = purchased(); const state = createAsset(original, { name: 'Kompressor', date: '2026-10-01', costCents: 3_000_000, lifeMonths: 60 });
  assert.equal(accountBalance(state, '5410'), 0); assert.equal(accountBalance(state, '1220'), 3_000_000);
  assert.equal(accountBalance(original, '5410'), 3_000_000); assert.equal(getReports(state).balanced, true);
  const allocated = createAsset(original, { name: 'Tilldelad senare', date: '2026-10-15', costCents: 2_000_000, lifeMonths: 60 });
  journalUnchanged(allocated, () => createAsset(allocated, { name: 'Bakdaterad överlappning', date: '2026-10-01', costCents: 2_000_000, lifeMonths: 60 }), /redan använt/);
});

test('avskrivning högst en gång per månad, exakt sluttotal även med avrundningsöre', () => {
  let state = createAsset(purchased(100, '2026-01-01'), { name: 'Test', date: '2026-01-01', costCents: 100, lifeMonths: 3 }); const id = state.assets[0].id;
  state = depreciateAsset(state, id, { date: '2026-01-31' });
  assert.equal(state.assets[0].depreciations[0].amountCents, 33);
  journalUnchanged(state, () => depreciateAsset(state, id, { date: '2026-01-31' }), /redan/);
  state = depreciateAsset(state, id, { date: '2026-02-28' }); state = depreciateAsset(state, id, { date: '2026-03-31' });
  assert.equal(accountBalance(state, '1229'), -100); assert.equal(accountBalance(state, '7832'), 100);
  journalUnchanged(state, () => depreciateAsset(state, id, { date: '2026-04-30' }), /helt avskriven/);
});

test('försäljning av inventarie bokar moms och resultat samt tar bort kvarvarande värde', () => {
  let state = createAsset(purchased(), { name: 'Kompressor', date: '2026-10-01', costCents: 3_000_000, lifeMonths: 60 }); const id = state.assets[0].id;
  state = depreciateAsset(state, id, { date: '2026-10-31' }); const bank = accountBalance(state, '1930');
  state = disposeAsset(state, id, { date: '2026-11-01', proceedsCents: 3_100_000 });
  assert.equal(accountBalance(state, '1220'), 0); assert.equal(accountBalance(state, '1229'), 0);
  assert.equal(accountBalance(state, '2611'), -775_000); assert.equal(accountBalance(state, '3973'), -150_000);
  assert.equal(accountBalance(state, '1930'), bank + 3_875_000); assert.equal(getReports(state).balanced, true);
  journalUnchanged(state, () => disposeAsset(state, id, { date: '2026-11-02' }), /redan/);
});

test('utrangering utan ersättning kostnadsför restvärdet utan moms', () => {
  let state = createAsset(purchased(), { name: 'Kompressor', date: '2026-10-01', costCents: 3_000_000, lifeMonths: 60 }); const id = state.assets[0].id;
  state = disposeAsset(state, id, { date: '2026-10-15' });
  assert.equal(accountBalance(state, '7973'), 3_000_000); assert.equal(accountBalance(state, '2611'), 0); assert.equal(getReports(state).balanced, true);
});

test('momsunderlag omför rätt konton och betalning går via skattekontot en gång', () => {
  let state = saleState();
  const range = { from: '2026-01-01', to: '2026-03-31', date: '2026-03-31' };
  assert.equal(getVatReport(state, range).payableCents, 250_000);
  state = fileVatPeriod(state, range); const id = state.vatReturns[0].id;
  assert.equal(accountBalance(state, '2611'), 0); assert.equal(accountBalance(state, '2650'), -250_000);
  assert.equal(getVatReport(state, range).outputCents, 250_000, 'omföring ska inte nolla rapportens bevisbelopp');
  journalUnchanged(state, () => fileVatPeriod(state, range), /överlappar/);
  const bank = accountBalance(state, '1930'); state = settleVat(state, id, { date: '2026-04-12' });
  assert.equal(accountBalance(state, '2650'), 0); assert.equal(accountBalance(state, '1630'), 0); assert.equal(accountBalance(state, '1930'), bank - 250_000);
  assert.equal(state.bankTransactions.length, 3); assert.equal(getReports(state).balanced, true);
  journalUnchanged(state, () => settleVat(state, id, { date: '2026-04-13' }), /redan/);
});

test('momsåterbetalning har omvända sidor och ökar bank utan resultatpåverkan', () => {
  let state = transact(opened(), draft => appendEntry(draft, { date: '2026-02-01', description: 'Inköp', sourceType: 'test-vat-buy', sourceId: '1', rows: [debit('4010', 100_000), debit('2641', 25_000), credit('1930', 125_000)] }));
  state = fileVatPeriod(state, { from: '2026-01-01', to: '2026-03-31', date: '2026-03-31' }); const id = state.vatReturns[0].id;
  assert.equal(accountBalance(state, '2650'), 25_000); const bank = accountBalance(state, '1930'); const result = getReports(state).resultCents;
  state = settleVat(state, id, { date: '2026-04-12' }); assert.equal(accountBalance(state, '1930'), bank + 25_000); assert.equal(accountBalance(state, '2650'), 0);
  assert.equal(getReports(state).resultCents, result); assert.equal(getReports(state).balanced, true);
});

test('moms fastställs inte över utkast, i framtiden eller i överlappande intervall', () => {
  const state = saleState(); journalUnchanged(state, () => fileVatPeriod(state, { from: '2026-01-01', to: '2026-03-31', date: '2026-03-15' }), /sista dag/);
  journalUnchanged(state, () => getVatReport(state, { from: '2026-03-01', to: '2026-02-28' }), /start/);
  const draftState = structuredClone(state); draftState.invoices.push({ id: 'draft-one', status: 'draft', date: '2026-02-01' });
  journalUnchanged(draftState, () => fileVatPeriod(draftState, { from: '2026-01-01', to: '2026-03-31', date: '2026-03-31' }), /fakturautkast/);
});

test('momsfastställelse följer månad, kvartal eller år medan rapporten kan avgränsas fritt', () => {
  const state = saleState();
  assert.deepEqual(getVatPeriodBounds(state, '2026-03-15'), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(getVatPeriodBounds(state, '2026-10-23'), { from: '2026-10-01', to: '2026-12-31' });
  assert.equal(getVatReport(state, { from: '2026-03-15', to: '2026-03-15' }).outputCents, 250_000);
  journalUnchanged(state, () => fileVatPeriod(state, { from: '2026-03-15', to: '2026-03-15', date: '2026-03-15' }), /hel momsperiod/);
  journalUnchanged(state, () => fileVatPeriod(state, { from: '2026-01-01', to: '2026-01-31', date: '2026-01-31' }), /hel momsperiod/);
  const monthly = updateCompany(state, { vatPeriod: 'month' });
  assert.deepEqual(getVatPeriodBounds(monthly, '2026-02-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.doesNotThrow(() => fileVatPeriod(monthly, { from: '2026-03-01', to: '2026-03-31', date: '2026-03-31' }));
  const yearly = updateCompany(state, { vatPeriod: 'year' });
  assert.deepEqual(getVatPeriodBounds(yearly, '2026-03-15'), { from: '2026-01-01', to: '2026-12-31' });
});

test('periodlås kontrollerar avstämning och kräver dokumenterad orsak för upplåsning', () => {
  let state = opened();
  state = transact(state, draft => { draft.bankTransactions.push({ id: 'unmatched', date: '2026-10-01', description: 'Avgift', amountCents: -100, account: '1930', matchedEntryId: null }); });
  journalUnchanged(state, () => lockPeriod(state, '2026-10'), /kontohändelser/);
  state = lockPeriod(state, '2026-09'); assert.ok(state.lockedPeriods.includes('2026-09'));
  journalUnchanged(state, () => unlockPeriod(state, '2026-09', ''), /Anledning/);
  state = unlockPeriod(state, '2026-09', 'Underlag behöver rättas'); assert.ok(!state.lockedPeriods.includes('2026-09')); assert.match(state.activity.at(-1).label, /Underlag behöver rättas/);
});

test('årsslut bevarar resultatrapport och balanser samt spärrar efterföljande bokning', () => {
  let state = updateCompany(saleState(), { vatPeriod: 'year' }); state = fileVatPeriod(state, { from: '2026-01-01', to: '2026-12-31', date: '2026-12-31' });
  for (let month = 1; month <= 12; month++) state = lockPeriod(state, `2026-${String(month).padStart(2, '0')}`);
  assert.equal(getCloseChecklist(state).every(item => item.done), true);
  journalUnchanged(state, () => closeYear(state, { date: '2026-12-31', confirmed: false }), /Bekräfta/);
  const entriesBefore = structuredClone(state.entries); const result = getReports(state).resultCents;
  state = closeYear(state, { date: '2026-12-31', confirmed: true });
  assert.deepEqual(state.entries.slice(0, entriesBefore.length), entriesBefore); assert.equal(accountBalance(state, '2099'), -result);
  assert.equal(getReports(state).resultCents, result); assert.equal(getReports(state).balanced, true);
  const opening = state.yearClosures[0].openingBalances; assert.equal(opening.reduce((total, row) => total + row.debitCents - row.creditCents, 0), 0);
  journalUnchanged(state, () => createPayrollRun(state, { month: '2026-12', date: '2026-12-31' }), /avslutat/);
  journalUnchanged(state, () => unlockPeriod(state, '2026-12', 'Test'), /avslutat/);
});

function lockAllMonths(state) {
  for (let month = 1; month <= 12; month++) state = lockPeriod(state, `2026-${String(month).padStart(2, '0')}`);
  return state;
}

test('årsavslut kräver årets periodisering men tillåter kostnad som avser nästa år', () => {
  let state = transact(opened(), draft => appendEntry(draft, { date: '2026-12-01', description: 'IT-avtal december–februari', sourceType: 'manual', sourceId: 'it-contract', rows: [debit('6540', 120_000), credit('1930', 120_000)] }));
  state = createAccrual(state, { name: 'IT-avtal', date: '2026-12-01', amountCents: 120_000, expenseAccount: '6540', months: 3, startMonth: '2026-12' });
  const accrualId = state.accruals[0].id;
  assert.equal(getCloseChecklist(state).find(item => item.id === 'accruals').done, false);
  state = lockAllMonths(state);
  journalUnchanged(state, () => closeYear(state, { date: '2026-12-31', confirmed: true }), /Periodiseringar genomgångna/);
  state = unlockPeriod(state, '2026-12', 'Bokföra decemberdelen');
  state = postAccrualMonth(state, accrualId, { date: '2026-12-31' });
  assert.equal(getCloseChecklist(state).find(item => item.id === 'accruals').done, true);
  state = lockPeriod(state, '2026-12'); state = closeYear(state, { date: '2026-12-31', confirmed: true });
  assert.equal(accountBalance(state, '1790'), 80_000);
  assert.equal(state.yearClosures[0].openingBalances.find(row => row.account === '1790').debitCents, 80_000);
});

test('årsavslut spärras vid lagerrörelse efter senaste värdering och släpps efter ny värdering', () => {
  let state = transact(opened(), draft => appendEntry(draft, { date: '2026-10-01', description: 'Material', sourceType: 'manual', sourceId: 'material-stock', rows: [debit('4010', 100_000), credit('1930', 100_000)] }));
  state = createStockItem(state, { name: 'Byggmaterial', unit: 'st', unitCostCents: 10_000 }); const itemId = state.inventoryItems[0].id;
  state = recordStockMovement(state, itemId, { date: '2026-10-02', kind: 'in', quantity: 10, reason: 'Materialinköp' });
  assert.equal(getCloseChecklist(state).find(item => item.id === 'inventory').done, false);
  state = postStockValuation(state, { date: '2026-10-31' });
  assert.equal(getCloseChecklist(state).find(item => item.id === 'inventory').done, true);
  state = recordStockMovement(state, itemId, { date: '2026-11-01', kind: 'out', quantity: 1, reason: 'Förbrukat material' });
  state = lockAllMonths(state);
  journalUnchanged(state, () => closeYear(state, { date: '2026-12-31', confirmed: true }), /Materiallager inventerat och värderat/);
  state = unlockPeriod(state, '2026-12', 'Årets slutliga inventering');
  state = postStockValuation(state, { date: '2026-12-31' });
  assert.equal(accountBalance(state, '1460'), 90_000);
  state = lockPeriod(state, '2026-12'); state = closeYear(state, { date: '2026-12-31', confirmed: true });
  assert.equal(state.yearClosures[0].openingBalances.find(row => row.account === '1460').debitCents, 90_000);
});

test('bolagsinställningar tillåter inte flytt av bokförda år eller osupporterad metod', () => {
  const state = opened();
  journalUnchanged(state, () => updateCompany(state, { fiscalYearStart: '2025-01-01' }), /inte flyttas/);
  journalUnchanged(state, () => updateCompany(state, { method: 'cash' }), /faktureringsmetoden/);
  const updated = updateCompany(state, { name: 'Fiktiva Hantverk AB', vatPeriod: 'month' }); assert.equal(updated.company.name, 'Fiktiva Hantverk AB'); assert.equal(updated.company.vatPeriod, 'month');
});
