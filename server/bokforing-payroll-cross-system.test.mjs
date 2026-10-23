import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyState } from '../public/bokforing/suite/core.js';
import { createEmployee, createPayrollRun, postPayroll } from '../public/bokforing/suite/finance.js';
import { savePayrollProfile, createPayrollBatch, postPayrollBatch, reversePayrollBatch } from '../public/bokforing/suite/payroll-engine.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

function fixture() {
  let state = createEmployee(createEmptyState(), { name: 'Testanställd', payType: 'monthly', baseCents: 3200000, withholdingCents: 619000 });
  state = savePayrollProfile(state, { employeeId: state.employees[0].id, date: '2026-10-01', birthYear: 1985,
    taxMode: 'table', table: 32, column: 1, weeklyHoursHundredths: 4000, deductionHourlyCents: 20000,
    vacationMethod: 'same-pay', vacationSupplementBps: 43, vacationPercentBps: 1200, paidVacationDays: 25,
    agreementNote: 'Granskat testavtal', reviewed: true, domesticOrdinary: true });
  return state;
}
const legacy = state => createPayrollRun(state, { date: '2026-10-25', month: '2026-10' });
const modern = (state, kind = 'regular') => createPayrollBatch(state, { date: kind === 'regular' ? '2026-10-25' : '2026-10-28',
  people: [{ employeeId: state.employees[0].id, scheduledHoursHundredths: 16000, kind, ...(kind === 'supplement' ? { additionalGrossCents: 50000 } : {}) }] });

test('legacy ordinary salary is blocked after individual draft and posted salary', () => {
  let state = modern(fixture()); const draft = structuredClone(state);
  assert.throws(() => legacy(state), /redan i en individuell lönekörning/);
  assert.deepEqual(state, draft);
  state = postPayrollBatch(state, state.payrollBatches[0].id, { reviewed: true });
  const posted = structuredClone(state);
  assert.throws(() => legacy(state), /redan i en individuell lönekörning/);
  assert.deepEqual(state, posted); validateSuiteState(state);
});

test('individual ordinary salary is blocked after legacy draft and posted salary', () => {
  let state = legacy(fixture()); const draft = structuredClone(state);
  assert.throws(() => modern(state), /Ordinarie månadslön finns redan/);
  assert.deepEqual(state, draft);
  state = postPayroll(state, state.payrollRuns[0].id);
  const posted = structuredClone(state);
  assert.throws(() => modern(state), /Ordinarie månadslön finns redan/);
  assert.deepEqual(state, posted); validateSuiteState(state);
});

test('explicit individual supplement after posted legacy salary remains supported', () => {
  let state = legacy(fixture()); state = postPayroll(state, state.payrollRuns[0].id);
  state = modern(state, 'supplement');
  const batch = state.payrollBatches[0];
  assert.equal(batch.people[0].input.kind, 'supplement');
  assert.equal(batch.people[0].grossCents, 50000);
  assert.deepEqual(batch.people[0].context.priorLegacyRunIds, [state.payrollRuns[0].id]);
  state = postPayrollBatch(state, batch.id, { reviewed: true }); validateSuiteState(state);
  assert.equal(state.payrollRuns.length, 1); assert.equal(state.payrollBatches.length, 1);
});

test('restoration rejects a second ordinary salary across the two systems', () => {
  const base = fixture();
  const legacyDraft = legacy(base).payrollRuns[0];
  const state = modern(base); state.payrollRuns.push(legacyDraft);
  assert.throws(() => validateSuiteState(state), /flera ordinarie lönekörningar/);
});

test('reversed individual regular salary does not block a replacement legacy salary', () => {
  let state = modern(fixture());
  state = postPayrollBatch(state, state.payrollBatches[0].id, { reviewed: true });
  state = reversePayrollBatch(state, state.payrollBatches[0].id, { date: '2026-10-26', reason: 'Ersätt felaktig ordinarie lön' });
  state = legacy(state); validateSuiteState(state);
  assert.equal(state.payrollRuns.length, 1);
});
