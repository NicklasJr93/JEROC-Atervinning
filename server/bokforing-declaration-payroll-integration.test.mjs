import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEmptyState } from '../public/bokforing/suite/core.js';
import { createEmployee, createPayrollRun, postPayroll, payPayroll } from '../public/bokforing/suite/finance.js';
import { savePayrollProfile, createPayrollBatch, postPayrollBatch, payPayrollBatch, createPayrollRecovery, getPayrollDeclarationPeople } from '../public/bokforing/suite/payroll-engine.js';
import { createDeclaration, getDeclarationFile, getAgiPeople, buildAgiXml } from '../public/bokforing/suite/declarations.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

const schemaPath = fileURLToPath(new URL('./fixtures/bokforing-declarations/arbetsgivardeklaration_1.1.xsd', import.meta.url));
function assertAgiSchema(xml) {
  const result = spawnSync('python3', ['-c', 'from lxml import etree\nimport sys\nschema = etree.XMLSchema(file=sys.argv[1])\nschema.assertValid(etree.fromstring(sys.stdin.buffer.read()))\nprint("valid")', schemaPath], { input: xml, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout.trim(), 'valid');
}
function profile(state) {
  return savePayrollProfile(state, { employeeId: state.employees[0].id, date: '2026-10-01', birthYear: 1985, taxMode: 'table', table: 32, column: 1, weeklyHoursHundredths: 4000, deductionHourlyCents: 20000, vacationMethod: 'same-pay', vacationSupplementBps: 43, vacationPercentBps: 1200, paidVacationDays: 25, agreementNote: 'Granskat fiktivt löneunderlag', reviewed: true, domesticOrdinary: true });
}
function salary(state, date = '2026-10-25') {
  state = createPayrollBatch(state, { date, people: [{ employeeId: state.employees[0].id, scheduledHoursHundredths: 16000 }] });
  const id = state.payrollBatches.at(-1).id;
  state = postPayrollBatch(state, id, { reviewed: true });
  return payPayrollBatch(state, id, { date });
}
const fixture = () => salary(profile(createEmployee(createEmptyState(), { name: 'Fiktiv AGI-person', payType: 'monthly', baseCents: 3200000 })));
const metadata = state => ({ kind: 'agi', month: '2026-10', orgNumber: '5566778899', createdAt: '2026-11-05T12:00:00Z', contactName: 'Åke Ö & granskningsgruppen', contactPhone: '0701234567', contactEmail: 'test@example.invalid', domesticOrdinary: true, reviewed: true, absenceReviewed: true, people: [{ employeeId: state.employees[0].id, personalNumber: '198501011236', specification: 1 }] });
const reclaim = state => createPayrollRecovery(state, { batchId: state.payrollBatches[0].id, employeeId: state.employees[0].id, date: '2026-11-02', grossCents: 100000, component: 'salary', taxClass: 'periodic', reason: 'Granskat bruttolöneåterkrav i test', reference: 'KRAV-AGI-01', reviewed: true, agiCorrectionConfirmed: true });
const tag = (xml, name) => [...xml.matchAll(new RegExp(`<agd:${name}(?: [^>]*)?>([^<]*)</agd:${name}>`, 'g'))].map(match => match[1]);

test('AGI recovery is reported in original salary month with unchanged withholding and schema-valid UTF-8', () => {
  let state = fixture();
  const input = metadata(state), originalTax = getPayrollDeclarationPeople(state, input.month)[0].withholdingCents;
  state = createDeclaration(state, input);
  const original = getDeclarationFile(state, state.declarations[0].id);
  assertAgiSchema(original.value);
  assert.deepEqual(tag(original.value, 'KontantErsattningUlagAG'), ['32000']);
  state = reclaim(state);
  assert.throws(() => getDeclarationFile(state, state.declarations[0].id), /ändrats/);
  assert.deepEqual(getAgiPeople(state, '2026-11'), []);
  const corrected = getAgiPeople(state, input.month)[0];
  assert.equal(corrected.grossCents, 3100000);
  assert.equal(corrected.withholdingCents, originalTax);
  assert.equal(corrected.employerCents, 974020);
  assert.deepEqual(corrected.recoveryIds, [state.payrollRecoveries[0].id]);
  state = createDeclaration(state, input);
  const file = getDeclarationFile(state, state.declarations.at(-1).id);
  assert.deepEqual(tag(file.value, 'RedovisningsPeriod'), ['202610', '202610']);
  assert.deepEqual(tag(file.value, 'KontantErsattningUlagAG'), ['31000']);
  assert.deepEqual(tag(file.value, 'AvdrPrelSkatt'), [String(originalTax / 100)]);
  assert.deepEqual(tag(file.value, 'SummaSkatteavdr'), [String(originalTax / 100)]);
  assert.deepEqual(tag(file.value, 'SummaArbAvgSlf'), ['9740']);
  assert.deepEqual(tag(file.value, 'Specifikationsnummer'), ['1']);
  assert.deepEqual(tag(file.value, 'BetalningsmottagarId'), ['198501011236']);
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(file.value)), file.value);
  assert.match(file.value, /Åke Ö &amp; granskningsgruppen/);
  assertAgiSchema(file.value);
  validateSuiteState(state);
});

test('a recovery never silently moves negative salary into the recovery month', () => {
  let state = fixture();
  state = reclaim(state);
  state = salary(state, '2026-11-25');
  assert.equal(getAgiPeople(state, '2026-10')[0].grossCents, 3100000);
  assert.equal(getAgiPeople(state, '2026-11')[0].grossCents, 3200000);
  const input = { ...metadata(state), month: '2026-11', createdAt: '2026-12-05T12:00:00Z' };
  state = createDeclaration(state, input);
  const file = getDeclarationFile(state, state.declarations.at(-1).id);
  assert.deepEqual(tag(file.value, 'RedovisningsPeriod'), ['202611', '202611']);
  assert.deepEqual(tag(file.value, 'KontantErsattningUlagAG'), ['32000']);
  assertAgiSchema(file.value);
  validateSuiteState(state);
});

test('AGI snapshot derives monetary values from payroll and requires explicit recovery review', () => {
  const state = fixture(), input = metadata(state);
  const injected = createDeclaration(state, { ...input, people: [{ ...input.people[0], grossCents: 1, withholdingCents: 0, employerCents: 0 }] });
  const file = getDeclarationFile(injected, injected.declarations.at(-1).id);
  assert.deepEqual(tag(file.value, 'KontantErsattningUlagAG'), ['32000']);
  assert.deepEqual(tag(file.value, 'AvdrPrelSkatt'), ['6190']);
  assert.throws(() => createPayrollRecovery(state, { batchId: state.payrollBatches[0].id, employeeId: state.employees[0].id, date: '2026-11-02', grossCents: 100000, reason: 'Test', reference: 'NO-REVIEW', reviewed: true, agiCorrectionConfirmed: false }), /Granska.*AGI/);
  assertAgiSchema(file.value);
});

test('AGI specification remains stable across a correction of the same recipient', () => {
  let state = fixture(), input = metadata(state);
  state = createDeclaration(state, input);
  state = reclaim(state);
  assert.throws(() => createDeclaration(state, { ...input, people: [{ ...input.people[0], specification: 2 }] }), /specifikation|rättelse/i);
  state = createDeclaration(state, input);
  assert.equal(state.declarations[0].payload.people[0].specification, state.declarations[1].payload.people[0].specification);
  assertAgiSchema(getDeclarationFile(state, state.declarations[1].id).value);
});

test('AGI whole-krona withholding totals are the sum of exported recipient values', () => {
  const base = metadata({ employees: [{ id: 'test-person' }] });
  const xml = buildAgiXml({ ...base, people: [
    { employeeId: 'test-person', personalNumber: '198501011236', specification: 1, grossCents: 100099, benefitCents: 199, withholdingCents: 123499, employerCents: 31419 },
  ] });
  assert.deepEqual(tag(xml, 'KontantErsattningUlagAG'), ['1000']);
  assert.deepEqual(tag(xml, 'SkatteplOvrigaFormanerUlagAG'), ['1']);
  assert.deepEqual(tag(xml, 'AvdrPrelSkatt'), ['1234']);
  assert.deepEqual(tag(xml, 'SummaSkatteavdr'), ['1234']);
  assert.deepEqual(tag(xml, 'SummaArbAvgSlf'), ['314']);
  assertAgiSchema(xml);
});

test('legacy October salary paid in November is declared only in the actual payment month', () => {
  let state = createEmployee(createEmptyState(), { name: 'Fiktiv äldre lönerad', payType: 'monthly', baseCents: 3200000, withholdingCents: 619000 });
  state = createPayrollRun(state, { date: '2026-10-25', month: '2026-10' });
  const runId = state.payrollRuns[0].id;
  state = postPayroll(state, runId);
  state = payPayroll(state, runId, { date: '2026-11-03' });
  assert.deepEqual(getAgiPeople(state, '2026-10'), []);
  const people = getAgiPeople(state, '2026-11');
  assert.equal(people.length, 1);
  assert.equal(people[0].grossCents, 3200000);
  assert.equal(people[0].withholdingCents, 619000);
  assert.deepEqual(people[0].sourceLegacyRunIds, [runId]);
  state = createDeclaration(state, { ...metadata(state), month: '2026-11', createdAt: '2026-12-05T12:00:00Z' });
  const file = getDeclarationFile(state, state.declarations.at(-1).id);
  assert.deepEqual(tag(file.value, 'RedovisningsPeriod'), ['202611', '202611']);
  assert.deepEqual(tag(file.value, 'KontantErsattningUlagAG'), ['32000']);
  assert.deepEqual(tag(file.value, 'AvdrPrelSkatt'), ['6190']);
  assertAgiSchema(file.value);
  validateSuiteState(state);
});
