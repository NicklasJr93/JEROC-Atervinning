// Individually reviewed payroll calculations. This is a limited domestic 2026
// workflow, not a certificate of payroll or collective-agreement compliance.
import { assert, cents, validDate, nextId, addActivity, appendEntry, requireOpenPeriod, transact } from './core.js';
import { TAX_TABLES_2026 } from './payroll-tax-tables-2026.js';

export const PAYROLL_RULES = Object.freeze({
  version: 'SE-2026-2026-10-23', year: 2026, maximumTableIncomeCents: 8_000_000,
  taxSource: 'https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/skattetabeller.4.96cca41179bad4b1aa8a46.html',
  oneOffSource: 'https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/skatteavdrag/engangsbelopp.4.361dc8c15312eff6fd3225e.html',
  contributionSource: 'https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/arbetsgivaravgifter.4.233f91f71260075abe8800020817.html',
  sicknessSource: 'https://www.forsakringskassan.se/arbetsgivare/sjukdom-och-skada/sjuklon',
  vacationSource: 'https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/semesterlag-1977480_sfs-1977-480/',
  recoverySource: 'https://www.skatteverket.se/foretag/arbetsgivare/lamnaarbetsgivardeklaration/rattaenarbetsgivardeklaration.4.2cf1b5cd163796a5c8b6698.html',
});
const debit = (account, amount) => ({ account, debitCents: amount, creditCents: 0 });
const credit = (account, amount) => ({ account, debitCents: 0, creditCents: amount });
const sum = values => values.reduce((a, b) => cents(a + cents(b)), 0);
const round = (amount, numerator, denominator = 10_000) => cents(Number((BigInt(amount) * BigInt(numerator) * 2n + BigInt(denominator)) / (BigInt(denominator) * 2n)));
const text = (value, label, maximum = 250) => { assert(typeof value === 'string' && value.trim() && value.length <= maximum, `Ange ${label} (högst ${maximum} tecken).`); return value.trim(); };
const integer = (value, min, max, label) => { assert(Number.isSafeInteger(value) && value >= min && value <= max, `${label} ska vara ${min}–${max}.`); return value; };
const collections = state => { state.payrollProfiles ??= []; state.payrollBatches ??= []; return state; };
const recoveriesFor = (state, batchId, employeeId) => (state.payrollRecoveries ?? []).filter(item => item.batchId === batchId && item.employeeId === employeeId);
const correctedPerson = (person, records) => ({ ...person, taxableCents: person.taxableCents - sum(records.map(item => item.grossCents)), periodicTaxableCents: periodicBase(person) - sum(records.map(item => item.taxClass === 'periodic' ? item.grossCents : 0)) });
const find = (state, id) => { const batch = (state.payrollBatches ?? []).find(item => item.id === id); assert(batch, 'Lönekörningen finns inte.'); return batch; };
const isActive = batch => batch.status !== 'reversed';
const priorRows = (state, employeeId, month, excludeId = '') => [
  ...(state.payrollBatches ?? []).filter(batch => batch.id !== excludeId && isActive(batch) && batch.status !== 'draft' && batch.month === month).flatMap(batch => batch.people.filter(person => person.employeeId === employeeId).map(person => correctedPerson(person, recoveriesFor(state, batch.id, employeeId)))),
  ...state.payrollRuns.filter(batch => batch.status !== 'draft' && batch.month === month).flatMap(batch => batch.lines.filter(person => person.employeeId === employeeId).map(person => ({ taxableCents: person.grossCents + person.benefitCents, withholdingCents: person.withholdingCents }))),
];
const periodicBase = person => person.periodicTaxableCents ?? person.taxableCents;
const periodicWithheld = person => person.periodicWithholdingCents ?? person.withholdingCents;
const shiftedLegacyMessage = 'Äldre lön har flyttad utbetalningsmånad. Blanda inte detta manuella underlag med individuell lön; granska och korrigera löneunderlaget i den moderna lönemotorn först.';
function assertModernPayrollMonth(state, employeeId, month) {
  const shifted = state.payrollRuns.some(run => {
    const paymentMonth = (run.paidDate ?? run.date).slice(0, 7);
    return run.status === 'paid' && paymentMonth !== run.month && (run.month === month || paymentMonth === month) && run.lines.some(person => person.employeeId === employeeId);
  });
  assert(!shifted, shiftedLegacyMessage);
}
export function assertLegacyPayrollPaymentMonth(state, run, date) {
  const paymentMonth = date.slice(0, 7);
  if (paymentMonth === run.month) return;
  const ids = new Set(run.lines.map(person => person.employeeId));
  const dependent = (state.payrollBatches ?? []).some(batch => isActive(batch) && batch.people.some(person => ids.has(person.employeeId) &&
    (batch.month === paymentMonth || batch.month === run.month || person.context.priorLegacyRunIds.includes(run.id))));
  assert(!dependent, shiftedLegacyMessage);
}
function payrollTransaction(state, change) {
  validatePayrollBatches(state);
  const next = transact(state, change);
  validatePayrollBatches(next);
  return next;
}

export function lookupPayrollTax({ year = 2026, table, column, taxableCents }) {
  assert(year === 2026, 'Skattetabell finns för 2026. Välj ett dokumenterat skattebeslut för andra år.');
  integer(table, 29, 42, 'Skattetabell'); assert([1, 3].includes(column), 'Lönemotorn stödjer lönekolumn 1 eller 3.');
  cents(taxableCents); assert(taxableCents <= PAYROLL_RULES.maximumTableIncomeCents, 'Tabellstödet omfattar högst 80 000 kr per månad. Högre belopp behöver ett granskat skatteunderlag.');
  const source = TAX_TABLES_2026[table];
  if (!taxableCents) return { taxCents: 0, table, column, year, sourceUrl: source.url, sourceSha256: source.sha256, band: [0, 0] };
  const kronor = Math.floor(taxableCents / 100);
  const row = source.rows.find(([from, to]) => Math.max(1, kronor) >= from && kronor <= to);
  assert(row, 'Inkomsten kunde inte hittas i den officiella skattetabellen.');
  return { taxCents: row[column + 1] * 100, table, column, year, sourceUrl: source.url, sourceSha256: source.sha256, band: row.slice(0, 2) };
}

// SKVFS 2025:21, sections 2 and 4. Applies to employees with regular salary
// whose A-tax table uses column 1/3. The reviewed annual estimate includes all
// cash salary, benefits and this and prior one-off amounts; it is never guessed.
export function calculateOneOffTax({ year = 2026, column, annualSalaryCents, amountCents }) {
  assert(year === 2026 && [1, 3].includes(column), 'Engångstabellen stöder 2026 och lönekolumn 1 eller 3.');
  cents(annualSalaryCents, false); cents(amountCents);
  assert(annualSalaryCents >= amountCents, 'Beräknad årslön ska inkludera engångsbeloppet.');
  const annual = Math.floor(annualSalaryCents / 100);
  const bands = column === 1 ? [[25041, 0], [82800, 10], [192000, 21], [477600, 26], [660000, 34], [Infinity, 54]]
    : [[25041, 0], [331200, 10], [477600, 26], [660000, 34], [Infinity, 55]];
  const ratePercent = bands.find(([upper]) => annual <= upper)[1];
  // Öretal in the calculated withholding are dropped, not rounded up.
  const taxCents = Number(BigInt(amountCents) * BigInt(ratePercent) / 10000n) * 100;
  return { year, column, annualSalaryCents, amountCents, ratePercent, taxCents, sourceUrl: PAYROLL_RULES.oneOffSource, sourceVersion: 'SKVFS 2025:21' };
}

// Tax year and payment date, not employee age today, control the rate. Domestic
// ordinary employer only. Other exemptions/thresholds require a separate review.
export function calculateEmployerContributions({ birthYear, paymentDate, taxableCents, previousTaxableCents = 0 }) {
  assert(validDate(paymentDate) && paymentDate.startsWith('2026-'), 'Arbetsgivaravgiftsreglerna i denna version gäller utbetalningar 2026.');
  integer(birthYear, 1900, 2010, 'Födelseår'); cents(taxableCents); cents(previousTaxableCents);
  const amountFor = total => {
    if (birthYear <= 1937) return 0;
    if (birthYear <= 1958) return round(total, 1021);
    if (birthYear >= 2003 && birthYear <= 2007 && paymentDate >= '2026-04-01') return sum([round(Math.min(total, 2_500_000), 2081), round(Math.max(0, total - 2_500_000), 3142)]);
    return round(total, 3142);
  };
  const contributionCents = amountFor(sum([taxableCents, previousTaxableCents])) - amountFor(previousTaxableCents);
  return { contributionCents, birthYear, paymentDate, previousTaxableCents, ruleVersion: PAYROLL_RULES.version,
    classification: birthYear <= 1937 ? 'born-before-1938' : birthYear <= 1958 ? 'pension-contribution' : birthYear >= 2003 && birthYear <= 2007 && paymentDate >= '2026-04-01' ? 'youth-monthly-cap' : 'ordinary', sourceUrl: PAYROLL_RULES.contributionSource };
}

function checkedProfile(state, input) {
  const employee = state.employees.find(item => item.id === input.employeeId);
  assert(employee && employee.active !== false, 'Välj en aktiv anställd.');
  const profile = {
    id: `payroll-profile:${employee.id}`, employeeId: employee.id, birthYear: integer(input.birthYear, 1900, 2010, 'Födelseår'),
    taxMode: input.taxMode ?? 'table', table: input.table ?? 32, column: input.column ?? 1,
    weeklyHoursHundredths: integer(input.weeklyHoursHundredths, 1, 16_800, 'Veckoarbetstid i hundradels timmar'),
    deductionHourlyCents: cents(input.deductionHourlyCents, false),
    vacationMethod: input.vacationMethod ?? 'same-pay', vacationSupplementBps: input.vacationSupplementBps ?? 43,
    vacationPercentBps: input.vacationPercentBps ?? 1200, paidVacationDays: input.paidVacationDays ?? 25,
    agreementNote: text(input.agreementNote, 'avtal/rutin för frånvaro och semester'),
    taxDecisionReference: input.taxDecisionReference ? text(input.taxDecisionReference, 'referens till skattebeslut') : '',
    reviewed: input.reviewed === true, domesticOrdinary: input.domesticOrdinary === true,
  };
  assert(['table', 'decision'].includes(profile.taxMode), 'Välj skattetabell eller dokumenterat skattebeslut.');
  if (profile.taxMode === 'table') { integer(profile.table, 29, 42, 'Skattetabell'); assert([1, 3].includes(profile.column), 'Välj lönekolumn 1 eller 3 enligt A-skattsedeln.'); }
  else assert(profile.taxDecisionReference, 'Manuellt skatteavdrag kräver en referens till beslutet.');
  assert(['same-pay', 'percentage'].includes(profile.vacationMethod), 'Välj semesterregel.');
  integer(profile.vacationSupplementBps, 0, 1000, 'Semestertillägg i baspunkter'); integer(profile.vacationPercentBps, 0, 5000, 'Semesterprocent i baspunkter');
  integer(profile.paidVacationDays, 0, 366, 'Tillgängliga betalda semesterdagar');
  assert(profile.reviewed && profile.domesticOrdinary, 'Bekräfta individuellt underlag och vanlig svensk anställning. Specialfall måste granskas separat.');
  return profile;
}

export function savePayrollProfile(state, input) {
  return payrollTransaction(state, draft => {
    collections(draft); requireOpenPeriod(draft, input.date);
    const profile = checkedProfile(draft, input);
    const usedDays = (draft.payrollBatches ?? []).filter(isActive).flatMap(batch => batch.people).filter(person => person.employeeId === profile.employeeId && !person.input.vacationYearId).reduce((n, person) => n + person.input.vacationDays, 0);
    assert(profile.paidVacationDays >= usedDays, 'Semestersaldot understiger redan registrerade dagar.');
    const index = draft.payrollProfiles.findIndex(item => item.employeeId === profile.employeeId);
    if (index < 0) draft.payrollProfiles.push(profile); else draft.payrollProfiles[index] = profile;
    addActivity(draft, 'Individuellt löneunderlag granskat och sparat', profile.employeeId);
  });
}

export function calculatePayrollPerson(state, input, { paymentDate, month, excludeId = '', profile: historicalProfile, employee: historicalEmployee, context: historicalContext } = {}) {
  const employee = historicalEmployee ?? state.employees.find(item => item.id === input.employeeId);
  assert(employee && employee.active !== false, 'Den anställde saknas eller är inaktiv.');
  const profile = historicalProfile ?? (state.payrollProfiles ?? []).find(item => item.employeeId === input.employeeId);
  assert(profile?.reviewed && profile.domesticOrdinary, `Granska löneprofilen för ${employee.name} först.`);
  assert(validDate(paymentDate) && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) && paymentDate.startsWith(month), 'Utbetalningsdatumet ska ligga i löneperioden.');
  if (!historicalContext) assertModernPayrollMonth(state, employee.id, month);
  const row = {
    employeeId: employee.id, scheduledHoursHundredths: integer(input.scheduledHoursHundredths ?? 16_000, 1, 74_400, 'Schemalagd arbetstid'),
    unpaidHoursHundredths: integer(input.unpaidHoursHundredths ?? 0, 0, 74_400, 'Obetald frånvaro'),
    sickHoursHundredths: integer(input.sickHoursHundredths ?? 0, 0, 74_400, 'Sjukfrånvaro'),
    sickScheduledHoursHundredths: integer(input.sickScheduledHoursHundredths ?? 0, 0, 74_400, 'Granskat schema under sjukperioden'),
    sickScheduleConfirmed: input.sickScheduleConfirmed === true,
    sickStart: input.sickStart ?? '', sickEnd: input.sickEnd ?? '',
    vacationDays: integer(input.vacationDays ?? 0, 0, 31, 'Semesterdagar'),
    ...(input.vacationYearId ? { vacationYearId: text(input.vacationYearId, 'semesterårets ID', 200), vacationHoursHundredths: integer(input.vacationHoursHundredths ?? 0, 0, 74_400, 'Schemalagda semestertimmar') } : {}),
    vacationBaseCents: cents(input.vacationBaseCents ?? 0), benefitCents: cents(input.benefitCents ?? 0),
    reimbursementCents: cents(input.reimbursementCents ?? 0), manualTaxCents: cents(input.manualTaxCents ?? 0),
    additionalGrossCents: cents(input.additionalGrossCents ?? 0), kind: input.kind ?? 'regular',
    extraTaxMode: input.extraTaxMode ?? 'periodic', vacationTaxMode: input.vacationTaxMode ?? 'periodic',
    annualSalaryCents: cents(input.annualSalaryCents ?? 0), annualSalaryReviewed: input.annualSalaryReviewed === true,
    note: input.note ? text(input.note, 'löneanteckning', 500) : '',
  };
  assert(['regular', 'supplement', 'vacation-final'].includes(row.kind), 'Ogiltig löneradstyp.');
  if (row.kind === 'vacation-final') {
    row.finalDailyCents = cents(input.finalDailyCents ?? 0); row.finalCompensationReviewed = input.finalCompensationReviewed === true;
    row.vacationTaxMode = 'one-off';
    assert(row.vacationYearId && row.finalCompensationReviewed && !row.additionalGrossCents && !row.benefitCents && !row.reimbursementCents && !row.unpaidHoursHundredths && !row.sickHoursHundredths, 'Slutlig semesterersättning kräver semesterår och särskilt granskat underlag utan andra lönebelopp.');
    if (profile.vacationMethod === 'same-pay') assert(row.finalDailyCents > 0, 'Ange granskat ersättningsbelopp per dag enligt anställningsvillkoren.');
  }
  assert(['periodic', 'one-off'].includes(row.extraTaxMode) && ['periodic', 'one-off'].includes(row.vacationTaxMode), 'Välj återkommande lön eller engångsbelopp för extra lön och semester.');
  assert(row.unpaidHoursHundredths + row.sickHoursHundredths <= row.scheduledHoursHundredths, 'Frånvaron överstiger schemalagd arbetstid.');
  const prior = priorRows(state, employee.id, month, excludeId);
  const context = historicalContext ?? {
    previousTaxableCents: sum(prior.map(person => person.taxableCents)), previousWithheldCents: sum(prior.map(person => person.withholdingCents)),
    previousPeriodicTaxableCents: sum(prior.map(periodicBase)), previousPeriodicWithheldCents: sum(prior.map(periodicWithheld)),
    priorPayrollBatchIds: (state.payrollBatches ?? []).filter(batch => batch.id !== excludeId && isActive(batch) && batch.status !== 'draft' && batch.month === month && batch.people.some(person => person.employeeId === employee.id)).map(batch => batch.id),
    priorLegacyRunIds: state.payrollRuns.filter(batch => batch.status !== 'draft' && batch.month === month && batch.lines.some(person => person.employeeId === employee.id)).map(batch => batch.id),
    ...((state.payrollRecoveries ?? []).some(item => item.month === month && item.employeeId === employee.id) ? { priorRecoveryIds: state.payrollRecoveries.filter(item => item.month === month && item.employeeId === employee.id).map(item => item.id) } : {}),
    ...(row.vacationYearId ? vacationContext(state, row.vacationYearId, employee.id, excludeId) : {}),
    usedVacationDays: (state.payrollBatches ?? []).filter(batch => isActive(batch) && batch.id !== excludeId).flatMap(batch => batch.people).filter(person => person.employeeId === employee.id && !person.input.vacationYearId).reduce((a, person) => a + person.input.vacationDays, 0),
    priorKarensCents: 0,
  };
  if (!row.vacationYearId) assert(context.usedVacationDays + row.vacationDays <= profile.paidVacationDays, 'Semesterdagarna överstiger granskat saldo.');
  else {
    const year = (state.payrollVacationYears ?? []).find(item => item.id === row.vacationYearId);
    assert(year && year.employeeId === employee.id && year.method === profile.vacationMethod, 'Semesteråret passar inte den anställdes semesterregel.');
    assert(paymentDate >= year.leaveStart && paymentDate <= year.leaveEnd, 'Löneutbetalningen ligger utanför semesterårets uttagsperiod.');
    assert(context.vacationYearUsedDays + row.vacationDays <= year.availableDays, 'Semesterdagarna överstiger det intjänade semestersaldot.');
    assert(row.vacationDays > 0, 'Välj dagar för uttaget från semesteråret.');
    if (year.method === 'percentage' && row.kind !== 'vacation-final') assert(row.vacationHoursHundredths > 0 && row.unpaidHoursHundredths + row.sickHoursHundredths + row.vacationHoursHundredths <= row.scheduledHoursHundredths, 'Ange de schemalagda semestertimmarna så att tim-/grundlön inte betalas dubbelt.');
  }
  let sickPayCents = 0, karensCents = 0;
  if (row.sickHoursHundredths) {
    assert(validDate(row.sickStart) && validDate(row.sickEnd) && row.sickStart <= row.sickEnd, 'Ange sjukperiodens start och slut.');
    assert(row.sickEnd <= paymentDate && row.sickEnd.startsWith(month), 'Sjukfrånvarons slut ska ligga i löneperioden före utbetalningen.');
    const days = Math.round((Date.parse(row.sickEnd) - Date.parse(row.sickStart)) / 86_400_000) + 1;
    assert(days <= 14, 'Automatisk sjuklön omfattar högst sjukperiodens första 14 kalenderdagar.');
    assert(row.sickHoursHundredths <= days * 2400, 'Sjukfrånvaron överstiger antalet timmar som ryms i sjukperiodens kalenderdagar.');
    assert(row.sickScheduleConfirmed && row.sickScheduledHoursHundredths > 0, 'Bekräfta granskat arbetsschema under sjukperioden.');
    assert(row.sickHoursHundredths <= row.sickScheduledHoursHundredths && row.sickScheduledHoursHundredths <= row.scheduledHoursHundredths && row.sickScheduledHoursHundredths <= days * 2400,
      'Sjukfrånvaron överstiger granskat schema under sjukperioden.');
    if (!historicalContext) {
      const previousSickness = (state.payrollBatches ?? []).filter(batch => batch.id !== excludeId && isActive(batch) && batch.status !== 'draft').flatMap(batch => batch.people).filter(person => person.employeeId === employee.id && person.input.sickHoursHundredths);
      assert(!previousSickness.some(person => person.input.sickStart !== row.sickStart && Math.abs(Date.parse(row.sickStart) - Date.parse(person.input.sickEnd)) <= 5 * 86_400_000), 'Återinsjuknande inom fem dagar behöver samordnad sjukperiod. Använd samma startdatum och granska dagarna.');
      context.priorKarensCents = sum(previousSickness.filter(person => person.input.sickStart === row.sickStart).map(person => person.karensCents));
    }
    sickPayCents = round(round(profile.deductionHourlyCents, row.sickHoursHundredths, 100), 8000);
    const maximumKarens = round(round(profile.deductionHourlyCents, profile.weeklyHoursHundredths, 100), 1600);
    karensCents = Math.min(sickPayCents, Math.max(0, maximumKarens - context.priorKarensCents));
  } else assert(!row.sickStart && !row.sickEnd, 'Sjukdatum kräver registrerad sjukfrånvaro.');
  const regularBase = row.kind !== 'regular' ? 0 : employee.payType === 'hourly' ? round(employee.baseCents, row.scheduledHoursHundredths, 100) : employee.baseCents;
  const vacationAbsence = row.vacationYearId && profile.vacationMethod === 'percentage' && row.kind !== 'vacation-final' ? round(employee.payType === 'hourly' ? employee.baseCents : profile.deductionHourlyCents, row.vacationHoursHundredths, 100) : 0;
  const absenceDeductionCents = sum([round(profile.deductionHourlyCents, row.unpaidHoursHundredths + row.sickHoursHundredths, 100), vacationAbsence]);
  assert(absenceDeductionCents <= regularBase, 'Frånvaroavdraget överstiger grundlönen. Granska timvärdet och schemat.');
  if (row.kind === 'supplement') assert(!row.vacationDays && !row.sickHoursHundredths && !row.unpaidHoursHundredths, 'Kompletteringskörningen avser endast extra lön, förmån eller utlägg.');
  const vacationYear = row.vacationYearId && (state.payrollVacationYears ?? []).find(item => item.id === row.vacationYearId);
  const vacationPayCents = profile.vacationMethod === 'same-pay' ? (row.kind === 'vacation-final' ? cents(row.finalDailyCents * row.vacationDays) : round(employee.baseCents, row.vacationDays * profile.vacationSupplementBps))
    : vacationYear ? allocatedVacationMoney(vacationYear, context.vacationYearUsedDays, context.vacationYearUsedMoneyCents, row.vacationDays) : round(row.vacationBaseCents, profile.vacationPercentBps);
  if (profile.vacationMethod === 'same-pay') assert(employee.payType === 'monthly', 'Sammalöneregeln i detta flöde kräver månadslön.');
  const salaryCents = regularBase - absenceDeductionCents + sickPayCents - karensCents + row.additionalGrossCents;
  const grossCents = sum([salaryCents, vacationPayCents]); const taxableCents = sum([grossCents, row.benefitCents]);
  assert(taxableCents > 0 || row.reimbursementCents > 0, 'Löneraden saknar belopp.');
  const oneOffCents = sum([row.extraTaxMode === 'one-off' ? row.additionalGrossCents : 0, row.vacationTaxMode === 'one-off' ? vacationPayCents : 0]);
  const periodicTaxableCents = taxableCents - oneOffCents;
  let periodicWithholdingCents, oneOffWithholdingCents = 0;
  let tax;
  if (profile.taxMode === 'table') {
    tax = lookupPayrollTax({ table: profile.table, column: profile.column, year: Number(paymentDate.slice(0, 4)), taxableCents: sum([periodicTaxableCents, context.previousPeriodicTaxableCents]) });
    tax.periodicTaxCents = Math.max(0, tax.taxCents - context.previousPeriodicWithheldCents);
    if (oneOffCents) {
      assert(row.annualSalaryReviewed && row.annualSalaryCents >= sum([taxableCents, context.previousTaxableCents]), 'Engångsbelopp kräver granskad beräknad årslön inklusive lön, förmåner och engångsbelopp.');
      tax.oneOff = calculateOneOffTax({ year: Number(paymentDate.slice(0, 4)), column: profile.column, annualSalaryCents: row.annualSalaryCents, amountCents: oneOffCents });
    }
    tax.incrementalTaxCents = sum([tax.periodicTaxCents, tax.oneOff?.taxCents ?? 0]);
    periodicWithholdingCents = Math.min(grossCents, tax.periodicTaxCents);
    oneOffWithholdingCents = Math.min(grossCents - periodicWithholdingCents, tax.oneOff?.taxCents ?? 0);
  } else {
    tax = { taxCents: row.manualTaxCents, incrementalTaxCents: row.manualTaxCents, decisionReference: profile.taxDecisionReference };
    periodicWithholdingCents = Math.min(grossCents, row.manualTaxCents);
  }
  const withholdingCents = sum([periodicWithholdingCents, oneOffWithholdingCents]);
  const employer = calculateEmployerContributions({ birthYear: profile.birthYear, paymentDate, taxableCents, previousTaxableCents: context.previousTaxableCents });
  return { employeeId: employee.id, name: employee.name, employee: structuredClone(employee), profile: structuredClone(profile), input: row, context,
    salaryCents, vacationPayCents, absenceDeductionCents, sickPayCents, karensCents, grossCents, taxableCents, periodicTaxableCents, oneOffCents, periodicWithholdingCents, oneOffWithholdingCents,
    benefitCents: row.benefitCents, reimbursementCents: row.reimbursementCents, withholdingCents, unwithheldTaxCents: tax.incrementalTaxCents - withholdingCents,
    employerCents: employer.contributionCents, netCents: sum([grossCents - withholdingCents, row.reimbursementCents]), tax, employer };
}

export function getPayrollBatchTotals(batch) {
  return Object.fromEntries(['salaryCents', 'vacationPayCents', 'grossCents', 'taxableCents', 'benefitCents', 'reimbursementCents', 'withholdingCents', 'employerCents', 'netCents'].map(key => [key, sum(batch.people.map(person => person[key]))]));
}
export function getPayrollBatchRows(batch) {
  const t = getPayrollBatchTotals(batch);
  return [debit('7010', t.salaryCents), debit('7082', t.vacationPayCents), debit('7331', t.reimbursementCents), debit('7510', t.employerCents), credit('2710', t.withholdingCents), credit('2731', t.employerCents), credit('2910', t.netCents)].filter(row => row.debitCents || row.creditCents);
}
const batchSnapshot = batch => JSON.stringify({ date: batch.date, month: batch.month, people: batch.people, ruleVersion: batch.ruleVersion, correctionOf: batch.correctionOf ?? null });

export function createPayrollBatch(state, input) {
  return payrollTransaction(state, draft => {
    collections(draft); requireOpenPeriod(draft, input.date);
    assert(Array.isArray(input.people) && input.people.length > 0 && input.people.length <= 1000 && new Set(input.people.map(row => row.employeeId)).size === input.people.length, 'Välj individuella lönerader utan dubbletter.');
    const month = input.date.slice(0, 7);
    for (const row of input.people) {
      const kind = row.kind ?? 'regular';
      const existingDraft = draft.payrollBatches.some(batch => batch.status === 'draft' && batch.month === month && batch.people.some(person => person.employeeId === row.employeeId));
      assert(!existingDraft, 'Det finns redan ett löneutkast för den anställde och månaden.');
      const existingRegular = draft.payrollBatches.some(batch => isActive(batch) && batch.month === month && batch.people.some(person => person.employeeId === row.employeeId && person.input.kind === 'regular')) || draft.payrollRuns.some(batch => batch.month === month && batch.lines.some(person => person.employeeId === row.employeeId));
      const bookedRegular = draft.payrollBatches.some(batch => ['posted', 'paid'].includes(batch.status) && batch.month === month && batch.people.some(person => person.employeeId === row.employeeId && person.input.kind === 'regular')) || draft.payrollRuns.some(batch => batch.status !== 'draft' && batch.month === month && batch.lines.some(person => person.employeeId === row.employeeId));
      assert(kind !== 'regular' || !existingRegular, 'Ordinarie månadslön finns redan. Välj kompletterande lön eller rätta originalet först.');
      assert(kind !== 'supplement' || bookedRegular, 'Bokför ordinarie lön före en kompletterande utbetalning.');
      if (kind !== 'regular') {
        const dates = [...draft.payrollBatches.filter(batch => ['posted', 'paid'].includes(batch.status) && batch.month === month && batch.people.some(person => person.employeeId === row.employeeId)).map(batch => batch.date), ...draft.payrollRuns.filter(batch => batch.status !== 'draft' && batch.month === month && batch.lines.some(person => person.employeeId === row.employeeId)).map(batch => batch.date)];
        assert(dates.every(date => date <= input.date), 'Kompletterande lön får inte dateras före redan bokförd lön i samma månad.');
      }
    }
    const batch = { id: nextId(draft, 'payroll-v2'), date: input.date, month, status: 'draft', ruleVersion: PAYROLL_RULES.version,
      people: input.people.map(row => calculatePayrollPerson(draft, row, { paymentDate: input.date, month })), payments: [], taxSettlement: null };
    draft.payrollBatches.push(batch); addActivity(draft, `Individuellt löneutkast ${month} skapat`, batch.id);
  });
}

export function postPayrollBatch(state, id, { reviewed = false } = {}) {
  return payrollTransaction(state, draft => {
    const batch = find(draft, id); assert(batch.status === 'draft', 'Endast ett löneutkast kan bokföras.'); assert(reviewed === true, 'Bekräfta att varje lönebesked och skatteunderlag har granskats.');
    validatePayrollBatches(draft); requireOpenPeriod(draft, batch.date);
    for (const person of batch.people) {
      const recalculated = calculatePayrollPerson(draft, person.input, { paymentDate: batch.date, month: batch.month, excludeId: batch.id });
      assert(JSON.stringify(recalculated) === JSON.stringify(person), 'Löneunderlaget har ändrats sedan utkastet skapades. Skapa ett nytt utkast.');
    }
    const entry = appendEntry(draft, { date: batch.date, description: `Individuell lön ${batch.month}`, sourceType: 'payroll-v2', sourceId: batch.id, rows: getPayrollBatchRows(batch) });
    batch.entryId = entry.id; batch.snapshot = batchSnapshot(batch); batch.status = 'posted'; addActivity(draft, `Individuell lön ${batch.month} bokförd efter granskning`, batch.id);
  });
}

export function discardPayrollDraft(state, id) {
  return payrollTransaction(state, draft => { const batch = find(draft, id); assert(batch.status === 'draft', 'Endast ett obokfört utkast kan tas bort.'); draft.payrollBatches = draft.payrollBatches.filter(item => item.id !== id); addActivity(draft, `Obokfört löneutkast ${batch.month} borttaget`, id); });
}

export function discardLegacyPayrollDraft(state, id) {
  return payrollTransaction(state, draft => {
    const run = draft.payrollRuns.find(item => item.id === id);
    assert(run && run.status === 'draft' && !run.entryId && !run.paymentEntryId, 'Endast ett obokfört äldre löneutkast kan tas bort.');
    draft.payrollRuns = draft.payrollRuns.filter(item => item.id !== id);
    addActivity(draft, `Äldre obokfört löneutkast ${run.month} borttaget inför individuell lönekörning`, id);
  });
}

export function payPayrollBatch(state, id, { date }) {
  return payrollTransaction(state, draft => {
    const batch = find(draft, id); assert(batch.status === 'posted', 'Lönen måste vara bokförd och obetald.'); requireOpenPeriod(draft, date); assert(date === batch.date, 'Utbetalningen ska ske på lönekörningens skatteberäkningsdatum. Skapa annars ett nytt granskat underlag.');
    const amount = getPayrollBatchTotals(batch).netCents;
    if (amount) {
      const entry = appendEntry(draft, { date, description: `Nettolön ${batch.month}`, sourceType: 'payroll-v2-payment', sourceId: id, rows: [debit('2910', amount), credit('1930', amount)] });
      batch.payments.push({ date, amountCents: amount, entryId: entry.id });
      draft.bankTransactions.push({ id: nextId(draft, 'bank'), date, description: `Nettolön ${batch.month}`, account: '1930', amountCents: -amount, matchedEntryId: entry.id });
    }
    batch.status = 'paid'; addActivity(draft, `Nettolön ${batch.month} registrerad som utbetald i demon`, id);
  });
}

export function settlePayrollBatchTaxes(state, id, { date }) {
  return payrollTransaction(state, draft => {
    const batch = find(draft, id); assert(batch.status === 'paid', 'Registrera löneutbetalningen före skatt och avgifter.'); assert(!batch.taxSettlement, 'Skatt och avgifter är redan reglerade.'); requireOpenPeriod(draft, date); assert(date >= batch.date, 'Skatteregleringen ligger före löneutbetalningen.');
    const t = getPayrollBatchTotals(batch), payableEmployer = t.employerCents - sum((draft.payrollRecoveries ?? []).filter(item => item.batchId === id && item.contributionHandling === 'reduce-unpaid').map(item => item.employerReductionCents)), amount = sum([t.withholdingCents, payableEmployer]);
    let entryId = null;
    if (amount) {
      const entry = appendEntry(draft, { date, description: `Reglering löneskatt ${batch.month}`, sourceType: 'payroll-v2-tax', sourceId: id,
        rows: [debit('2710', t.withholdingCents), debit('2731', payableEmployer), credit('1630', amount)].filter(row => row.debitCents || row.creditCents) });
      entryId = entry.id; draft.bankTransactions.push({ id: nextId(draft, 'bank'), date, description: `Löneskatt ${batch.month}`, account: '1630', amountCents: -amount, matchedEntryId: entry.id });
    }
    batch.taxSettlement = { date, amountCents: amount, entryId }; addActivity(draft, `Löneskatt ${batch.month} reglerad mot skattekontot i demon`, id);
  });
}

export function reversePayrollBatch(state, id, { date, reason }) {
  return payrollTransaction(state, draft => {
    const batch = find(draft, id); assert(batch.status === 'posted' && !batch.payments.length && !batch.taxSettlement, 'Utbetald lön kan inte raderas eller återföras som om betalningen aldrig hänt. Positiv komplettering finns; negativ rättelse behöver separat granskat återkravsflöde.');
    requireOpenPeriod(draft, date); assert(date >= batch.date, 'Rättelsen får inte ligga före lönen.'); text(reason, 'rättelseorsak');
    assert(!draft.payrollBatches.some(other => isActive(other) && other.id !== id && other.people.some(person => person.context.priorPayrollBatchIds.includes(id))), 'Senare kompletteringslön beror på denna körning. Rätta den först.');
    assert(!draft.payrollBatches.some(other => isActive(other) && other.id !== id && other.date > batch.date && other.people.some(person => person.input.sickHoursHundredths && batch.people.some(original => original.employeeId === person.employeeId && original.input.sickHoursHundredths && original.input.sickStart === person.input.sickStart))), 'En senare lönekörning använder karenshistoriken från denna körning. Rätta den senare körningen först.');
    const years = new Set(batch.people.map(person => person.input.vacationYearId).filter(Boolean));
    const position = draft.payrollBatches.findIndex(item => item.id === id);
    assert(!draft.payrollBatches.slice(position + 1).some(item => isActive(item) && item.people.some(person => years.has(person.input.vacationYearId))), 'En senare lönekörning använder samma semestersaldo. Rätta den först.');
    const original = draft.entries.find(entry => entry.id === batch.entryId);
    const entry = appendEntry(draft, { date, description: `Rättelse lön ${batch.month} · ${reason}`, sourceType: 'payroll-v2-reversal', sourceId: id, correctsEntryId: original.id, rows: original.rows.map(row => ({ account: row.account, debitCents: row.creditCents, creditCents: row.debitCents })) });
    batch.reversal = { date, reason: reason.trim(), entryId: entry.id }; batch.status = 'reversed'; addActivity(draft, `Lönekörning återförd med koppling till originalet: ${reason}`, id);
  });
}

function sameRows(actual, expected) {
  const amounts = rows => { const result = {}; for (const row of rows) { result[row.account] ??= [0, 0]; result[row.account][0] += row.debitCents; result[row.account][1] += row.creditCents; } return JSON.stringify(Object.entries(result).filter(([, values]) => values[0] || values[1]).sort()); };
  return amounts(actual) === amounts(expected);
}

export function validatePayrollBatches(state) {
  const entryIds = new Set(), accountBalances = {};
  assert(state.payrollProfiles === undefined || Array.isArray(state.payrollProfiles), 'Löneprofilerna är ogiltiga.'); assert(state.payrollBatches === undefined || Array.isArray(state.payrollBatches), 'Lönekörningarna är ogiltiga.');
  assert(new Set((state.payrollProfiles ?? []).map(profile => profile.employeeId)).size === (state.payrollProfiles ?? []).length, 'Löneprofilerna innehåller dubbletter.');
  for (const profile of state.payrollProfiles ?? []) assert(JSON.stringify(checkedProfile(state, profile)) === JSON.stringify(profile), 'Den sparade löneprofilen är ogiltig.');
  const ids = new Set();
  const addEntry = (id, type, sourceId, date, rows) => {
    const entry = state.entries.find(item => item.id === id);
    assert(entry && !entryIds.has(id) && entry.sourceType === type && entry.sourceId === sourceId && entry.date === date && sameRows(entry.rows, rows), 'Lönekörningens verifikation stämmer inte med underlaget.');
    entryIds.add(id); for (const row of entry.rows) accountBalances[row.account] = (accountBalances[row.account] ?? 0) + row.debitCents - row.creditCents;
    return entry;
  };
  for (const [batchIndex, batch] of (state.payrollBatches ?? []).entries()) {
    assert(typeof batch.id === 'string' && !ids.has(batch.id), 'Lönekörningen har ett ogiltigt eller dubbelt ID.'); ids.add(batch.id);
    assert(validDate(batch.date) && batch.month === batch.date.slice(0, 7) && batch.ruleVersion === PAYROLL_RULES.version && ['draft', 'posted', 'paid', 'reversed'].includes(batch.status), 'Lönekörningens datum, version eller status är ogiltig.');
    assert(Array.isArray(batch.people) && batch.people.length && new Set(batch.people.map(person => person.employeeId)).size === batch.people.length, 'Lönekörningens personer är ogiltiga.');
    for (const person of batch.people) {
      assert(state.employees.some(employee => employee.id === person.employeeId), 'Löneradens anställde saknas.');
      if (isActive(batch)) assertModernPayrollMonth(state, person.employeeId, batch.month);
      const historicalState = { ...state, employees: [person.employee] };
      assert(person.employee.id === person.employeeId && JSON.stringify(checkedProfile(historicalState, person.profile)) === JSON.stringify(person.profile), 'Löneradens historiska anställningsunderlag är ogiltigt.');
      for (const key of ['previousTaxableCents', 'previousWithheldCents', 'previousPeriodicTaxableCents', 'previousPeriodicWithheldCents', 'priorKarensCents']) cents(person.context[key]);
      integer(person.context.usedVacationDays, 0, 36600, 'Tidigare semesterdagar');
      const earlierBatches = state.payrollBatches.slice(0, batchIndex);
      assert(Array.isArray(person.context.priorPayrollBatchIds) && new Set(person.context.priorPayrollBatchIds).size === person.context.priorPayrollBatchIds.length && person.context.priorPayrollBatchIds.every(id => earlierBatches.some(prior => prior.id === id && prior.month === batch.month)), 'Lönens tidigare körningsreferenser är ogiltiga.');
      if (person.input.vacationYearId) {
        const used = earlierBatches.filter(isActive).flatMap(item => item.people).filter(row => row.employeeId === person.employeeId && row.input.vacationYearId === person.input.vacationYearId);
        assert(person.context.vacationYearUsedDays === used.reduce((n, row) => n + row.input.vacationDays, 0) && person.context.vacationYearUsedMoneyCents === sum(used.map(row => row.vacationPayCents)), 'Semesteruttagets tidigare dagar och belopp stämmer inte.');
      }
      assert(Array.isArray(person.context.priorLegacyRunIds) && new Set(person.context.priorLegacyRunIds).size === person.context.priorLegacyRunIds.length && person.context.priorLegacyRunIds.every(id => state.payrollRuns.some(prior => prior.id === id && prior.status !== 'draft' && prior.month === batch.month)), 'Lönens tidigare äldre körningsreferenser är ogiltiga.');
      const previous = [
        ...earlierBatches.filter(prior => person.context.priorPayrollBatchIds.includes(prior.id)).flatMap(prior => prior.people.filter(row => row.employeeId === person.employeeId).map(row => correctedPerson(row, recoveriesFor(state, prior.id, person.employeeId).filter(item => person.context.priorRecoveryIds?.includes(item.id))))),
        ...state.payrollRuns.filter(prior => person.context.priorLegacyRunIds.includes(prior.id)).flatMap(prior => prior.lines.filter(row => row.employeeId === person.employeeId).map(row => ({ taxableCents: row.grossCents + row.benefitCents, withholdingCents: row.withholdingCents }))),
      ];
      if (person.context.priorRecoveryIds) assert(Array.isArray(person.context.priorRecoveryIds) && new Set(person.context.priorRecoveryIds).size === person.context.priorRecoveryIds.length && person.context.priorRecoveryIds.every(id => (state.payrollRecoveries ?? []).some(item => item.id === id && item.employeeId === person.employeeId && item.month === batch.month && item.date <= batch.date)), 'Lönens tidigare återkravsreferenser är ogiltiga.');
      assert(person.context.previousTaxableCents === sum(previous.map(row => row.taxableCents)) && person.context.previousWithheldCents === sum(previous.map(row => row.withholdingCents)), 'Månadens tidigare löneunderlag stämmer inte med historiken.');
      assert(person.context.previousPeriodicTaxableCents === sum(previous.map(periodicBase)) && person.context.previousPeriodicWithheldCents === sum(previous.map(periodicWithheld)), 'Tidigare regelbunden lön får inte sammanblandas med engångsbelopp.');
      if (batch.status !== 'reversed') {
        const expectedIds = earlierBatches.filter(prior => isActive(prior) && prior.status !== 'draft' && prior.month === batch.month && prior.people.some(row => row.employeeId === person.employeeId)).map(prior => prior.id);
        assert(JSON.stringify(expectedIds) === JSON.stringify(person.context.priorPayrollBatchIds), 'En tidigare lönekörning saknas i skatteunderlaget.');
      }
      const expected = calculatePayrollPerson(state, person.input, { paymentDate: batch.date, month: batch.month, excludeId: batch.id, profile: person.profile, employee: person.employee, context: person.context });
      assert(JSON.stringify(expected) === JSON.stringify(person), 'Löneberäkningen stämmer inte med det sparade underlaget.');
    }
    assert(Array.isArray(batch.payments) && batch.payments.length <= 1, 'Lönebetalningshistoriken är ogiltig.');
    if (batch.status === 'draft') { assert(!batch.entryId && !batch.snapshot && !batch.payments.length && !batch.taxSettlement && !batch.reversal, 'Ett löneutkast får inte vara bokfört.'); continue; }
    assert(batch.snapshot === batchSnapshot(batch), 'Bokfört löneunderlag får inte ändras.');
    const original = addEntry(batch.entryId, 'payroll-v2', batch.id, batch.date, getPayrollBatchRows(batch));
    const totals = getPayrollBatchTotals(batch);
    if (batch.status === 'paid') {
      if (totals.netCents) {
        assert(batch.payments.length === 1 && batch.payments[0].amountCents === totals.netCents && batch.payments[0].date === batch.date, 'Nettolönebetalningen stämmer inte.');
        addEntry(batch.payments[0].entryId, 'payroll-v2-payment', batch.id, batch.date, [debit('2910', totals.netCents), credit('1930', totals.netCents)]);
        const events = state.bankTransactions.filter(event => event.matchedEntryId === batch.payments[0].entryId && event.account === '1930');
        assert(events.length === 1 && events[0].amountCents === -totals.netCents && events[0].date === batch.date, 'Löneutbetalningens avstämda kontohändelse saknas.');
      }
      else assert(!batch.payments.length, 'Nollön får inte ha en betalning.');
    } else assert(!batch.payments.length && !batch.taxSettlement, 'Obetald eller återförd lön har betalningshändelser.');
    if (batch.taxSettlement) {
      const payableEmployer = totals.employerCents - sum((state.payrollRecoveries ?? []).filter(item => item.batchId === batch.id && item.contributionHandling === 'reduce-unpaid').map(item => item.employerReductionCents));
      const amount = sum([totals.withholdingCents, payableEmployer]); assert(batch.status === 'paid' && batch.taxSettlement.amountCents === amount && validDate(batch.taxSettlement.date) && batch.taxSettlement.date >= batch.date, 'Skatteregleringen är ogiltig.');
      if (amount) {
        addEntry(batch.taxSettlement.entryId, 'payroll-v2-tax', batch.id, batch.taxSettlement.date, [debit('2710', totals.withholdingCents), debit('2731', payableEmployer), credit('1630', amount)].filter(row => row.debitCents || row.creditCents));
        const events = state.bankTransactions.filter(event => event.matchedEntryId === batch.taxSettlement.entryId && event.account === '1630');
        assert(events.length === 1 && events[0].amountCents === -amount && events[0].date === batch.taxSettlement.date, 'Skatteregleringens avstämda kontohändelse saknas.');
      }
      else assert(batch.taxSettlement.entryId === null, 'Nollreglering får inte ha en verifikation.');
    }
    if (batch.status === 'reversed') {
      assert(batch.reversal && validDate(batch.reversal.date) && batch.reversal.date >= batch.date && text(batch.reversal.reason, 'rättelseorsak'), 'Lönerättelsen saknar underlag.');
      const reversal = addEntry(batch.reversal.entryId, 'payroll-v2-reversal', batch.id, batch.reversal.date, original.rows.map(row => ({ account: row.account, debitCents: row.creditCents, creditCents: row.debitCents })));
      assert(reversal.correctsEntryId === original.id, 'Lönerättelsen saknar originalreferens.');
    } else assert(!batch.reversal, 'En aktiv lön har en rättelse som inte har behandlats.');
  }
  validateVacationYears(state);
  validatePayrollRecoveries(state, addEntry);
  for (const entry of state.entries) if (entry.sourceType.startsWith('payroll-v2')) assert(entryIds.has(entry.id), 'Löneverifikationen saknar ett verifierbart löneunderlag.');
  return { entryIds, accountBalances };
}

export function payrollReviewCsv(state, id) {
  validatePayrollBatches(state); const batch = find(state, id); assert(batch.status !== 'draft', 'Bokför lönen innan granskningsunderlaget exporteras.');
  const cell = value => `"${String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
  const rows = [['GRANSKNINGSUNDERLAG – inte AGI eller myndighetsfil'], ['Period', 'Utbetalningsdatum', 'Anställd', 'Kontant bruttolön öre', 'Förmån öre', 'Avdragen skatt öre', 'Arbetsgivaravgift öre', 'Nettolön öre', 'Regelversion'], ...batch.people.map(person => [batch.month, batch.date, person.name, person.grossCents, person.benefitCents, person.withholdingCents, person.employerCents, person.netCents, batch.ruleVersion])];
  return '\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n');
}

const dayAfter = value => new Date(Date.parse(value + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
const dayCount = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
const yearEndFrom = start => { const value = new Date(start + 'T00:00:00Z'); value.setUTCFullYear(value.getUTCFullYear() + 1); value.setUTCDate(value.getUTCDate() - 1); return value.toISOString().slice(0, 10); };
const immutableFields = object => JSON.stringify(object);

function vacationYearValue(state, input, { historical = false } = {}) {
  assert(state.employees.some(employee => employee.id === input.employeeId), 'Den anställde saknas.');
  const profile = (state.payrollProfiles ?? []).find(item => item.employeeId === input.employeeId);
  assert(profile?.reviewed, 'Granska löneprofilen före semesterberäkningen.');
  for (const key of ['date', 'earningStart', 'earningEnd', 'employmentStart', 'employmentEnd']) assert(validDate(input[key]), 'Semesterårets datum är ogiltiga.');
  const yearDays = dayCount(input.earningStart, input.earningEnd);
  assert([365, 366].includes(yearDays), 'Intjänandeåret ska vara ett helt år med 365 eller 366 dagar.');
  assert(input.employmentStart <= input.employmentEnd, 'Anställningens slut ligger före start.');
  const employedStart = input.employmentStart > input.earningStart ? input.employmentStart : input.earningStart;
  const employedEnd = input.employmentEnd < input.earningEnd ? input.employmentEnd : input.earningEnd;
  const employedDays = employedStart <= employedEnd ? dayCount(employedStart, employedEnd) : 0;
  const nonQualifyingDays = integer(input.nonQualifyingDays ?? 0, 0, employedDays, 'Icke semesterlönegrundande kalenderdagar');
  const entitlementDays = integer(input.entitlementDays ?? 25, 25, 50, 'Årlig semesterrätt');
  const earnedDays = Math.ceil((employedDays - nonQualifyingDays) * entitlementDays / yearDays);
  const eligibleEarningsCents = cents(input.eligibleEarningsCents ?? 0);
  const carriedDays = integer(input.carriedDays ?? 0, 0, 100, 'Ingående sparade semesterdagar');
  const carriedMoneyCents = cents(input.carriedMoneyCents ?? 0);
  const leaveStart = dayAfter(input.earningEnd), leaveEnd = yearEndFrom(leaveStart);
  assert(input.date >= input.earningEnd, 'Fastställ semesteråret när intjänandeåret är avslutat.');
  const method = input.method ?? profile.vacationMethod;
  assert(['same-pay', 'percentage'].includes(method) && (historical || method === profile.vacationMethod), 'Semesterregeln ska överensstämma med den granskade löneprofilen.');
  const percentBps = integer(input.percentBps ?? profile.vacationPercentBps, 1200 + (entitlementDays - 25) * 48, 4000, 'Semesterprocent i baspunkter');
  const carriedFromYear = carriedDays ? integer(input.carriedFromYear, Number(leaveStart.slice(0, 4)) - 5, Number(leaveStart.slice(0, 4)) - 1, 'Ursprungsår för sparade dagar') : null;
  assert(carriedDays || !carriedMoneyCents, 'Sparat semesterbelopp kräver sparade dagar.');
  if (method === 'percentage' && (earnedDays || carriedDays)) assert((!earnedDays || eligibleEarningsCents > 0) && (!carriedDays || carriedMoneyCents > 0), 'Procentregeln kräver granskat semesterlöneunderlag och belopp för sparade dagar.');
  if (method === 'same-pay') assert(!carriedMoneyCents, 'Sammalöneregeln använder aktuell månadslön och dagar; ange inte ett procentbelopp.');
  assert(input.reviewed === true && input.qualifyingAbsenceReviewed === true, 'Bekräfta anställningsdagar, semesterlönegrundande frånvaro och löneunderlag.');
  const earnedMoneyCents = method === 'percentage' ? round(eligibleEarningsCents, percentBps) : 0;
  return { employeeId: input.employeeId, date: input.date, earningStart: input.earningStart, earningEnd: input.earningEnd,
    employmentStart: input.employmentStart, employmentEnd: input.employmentEnd, nonQualifyingDays, entitlementDays,
    eligibleEarningsCents, carriedDays, carriedMoneyCents, carriedFromYear, leaveStart, leaveEnd, method, percentBps,
    yearDays, employedDays, qualifyingDays: employedDays - nonQualifyingDays, earnedDays, earnedMoneyCents,
    availableDays: earnedDays + carriedDays, availableMoneyCents: sum([earnedMoneyCents, carriedMoneyCents]),
    reference: text(input.reference, 'semesterunderlagets referens'), reviewed: true, qualifyingAbsenceReviewed: true, ruleVersion: 'semesterlagen-7-16b-2026' };
}

export function createVacationYear(state, input) {
  return payrollTransaction(state, draft => {
    requireOpenPeriod(draft, input.date); draft.payrollVacationYears ??= [];
    const value = vacationYearValue(draft, input);
    assert(!draft.payrollVacationYears.some(item => item.employeeId === value.employeeId && item.leaveStart === value.leaveStart), 'Semesteråret finns redan. Det fastställda intjänandet kan inte skrivas över.');
    draft.payrollVacationYears.push({ id: nextId(draft, 'vacation-year'), ...value, snapshot: immutableFields(value) });
    addActivity(draft, `Semesterår fastställt: ${value.earnedDays} intjänade dagar och ${value.carriedDays} ingående sparade dagar`, value.employeeId);
  });
}

function vacationContext(state, id, employeeId, excludeId) {
  const people = (state.payrollBatches ?? []).filter(batch => batch.id !== excludeId && isActive(batch)).flatMap(batch => batch.people).filter(person => person.employeeId === employeeId && person.input.vacationYearId === id);
  return { vacationYearUsedDays: people.reduce((n, person) => n + person.input.vacationDays, 0), vacationYearUsedMoneyCents: sum(people.map(person => person.vacationPayCents)) };
}
function allocatedVacationMoney(year, previousDays, previousMoney, days) {
  const remainingDays = year.availableDays - previousDays;
  assert(days <= remainingDays && remainingDays > 0, 'Semesteruttaget överstiger kvarvarande dagar.');
  const remainingMoney = year.availableMoneyCents - previousMoney;
  return days === remainingDays ? remainingMoney : round(year.availableMoneyCents, previousDays + days, year.availableDays) - previousMoney;
}
export function getVacationBalance(state, id) {
  const year = (state.payrollVacationYears ?? []).find(item => item.id === id); assert(year, 'Semesteråret saknas.');
  const used = vacationContext(state, id, year.employeeId);
  return { ...year, usedDays: used.vacationYearUsedDays, remainingDays: year.availableDays - used.vacationYearUsedDays,
    usedMoneyCents: used.vacationYearUsedMoneyCents, remainingMoneyCents: year.method === 'percentage' ? year.availableMoneyCents - used.vacationYearUsedMoneyCents : null };
}
function validateVacationYears(state) {
  assert(state.payrollVacationYears === undefined || Array.isArray(state.payrollVacationYears), 'Semesterregistret är ogiltigt.');
  const ids = new Set(), years = new Set();
  for (const year of state.payrollVacationYears ?? []) {
    assert(typeof year.id === 'string' && !ids.has(year.id), 'Semesterårets ID är ogiltigt eller dubbelt.'); ids.add(year.id);
    const key = `${year.employeeId}:${year.leaveStart}`; assert(!years.has(key), 'Semesteråret är registrerat flera gånger.'); years.add(key);
    const expected = vacationYearValue(state, year, { historical: true });
    assert(year.snapshot === immutableFields(expected), 'Fastställd semesterberäkning har ändrats.');
    for (const field of Object.keys(expected)) assert(immutableFields(year[field]) === immutableFields(expected[field]), 'Semesterberäkningen stämmer inte med underlaget.');
    const balance = getVacationBalance(state, year.id);
    assert(balance.remainingDays >= 0 && (balance.remainingMoneyCents === null || balance.remainingMoneyCents >= 0), 'Semesteruttag överskrider det intjänade underlaget.');
  }
}

const recoveryComponent = (person, component, taxClass) => {
  assert(['salary', 'vacation'].includes(component) && ['periodic', 'one-off'].includes(taxClass), 'Välj löneslag och skatteklass för återkravet.');
  const total = component === 'salary' ? person.salaryCents : person.vacationPayCents;
  const oneOff = component === 'salary' ? (person.input.extraTaxMode === 'one-off' ? person.input.additionalGrossCents : 0) : (person.input.vacationTaxMode === 'one-off' ? total : 0);
  return taxClass === 'one-off' ? oneOff : total - oneOff;
};
const recoverySnapshot = record => immutableFields(Object.fromEntries(['batchId', 'originalEntryId', 'employeeId', 'month', 'date', 'component', 'taxClass', 'grossCents', 'employerReductionCents', 'contributionHandling', 'basisBatchIds', 'basisLegacyRunIds', 'priorRecoveryIds', 'basisTaxableCents', 'birthYear', 'paymentDate', 'reason', 'reference', 'reviewed', 'agiCorrectionConfirmed'].map(key => [key, record[key]])));
const remainingEmployer = (batch, employeeId, state) => batch.people.find(person => person.employeeId === employeeId).employerCents - sum((state.payrollRecoveries ?? []).filter(item => item.batchId === batch.id && item.employeeId === employeeId).map(item => item.employerReductionCents));
function recoveryRows(record) { return [debit('1680', record.grossCents), credit(record.component === 'salary' ? '7010' : '7082', record.grossCents), debit('2731', record.employerReductionCents), credit('7510', record.employerReductionCents)].filter(row => row.debitCents || row.creditCents); }

export function createPayrollRecovery(state, input) {
  return payrollTransaction(state, draft => {
    collections(draft); draft.payrollRecoveries ??= [];
    const batch = find(draft, input.batchId), person = batch.people.find(item => item.employeeId === input.employeeId);
    assert(batch.status === 'paid' && person, 'Återkrav kräver en redan utbetald individuell lön och vald anställd.');
    requireOpenPeriod(draft, input.date); assert(input.date >= batch.date, 'Återkravet får inte ligga före löneutbetalningen.');
    assert(input.reviewed === true && input.agiCorrectionConfirmed === true, 'Granska bruttokravet och bekräfta att ursprunglig AGI-period ska rättas utan minskat skatteavdrag.');
    assert(!draft.payrollBatches.some(item => item.month === batch.month && item.status !== 'paid' && item.status !== 'reversed' && item.people.some(row => row.employeeId === person.employeeId)), 'Slutför eller ta bort månadens övriga löneutkast före återkrav.');
    const component = input.component ?? 'salary', taxClass = input.taxClass ?? 'periodic', grossCents = cents(input.grossCents, false);
    const previous = draft.payrollRecoveries.filter(item => item.batchId === batch.id && item.employeeId === person.employeeId && item.component === component && item.taxClass === taxClass);
    assert(sum(previous.map(item => item.grossCents)) + grossCents <= recoveryComponent(person, component, taxClass), 'Återkravet överstiger utbetalt belopp för detta löneslag.');
    const basisBatches = draft.payrollBatches.filter(item => item.month === batch.month && item.status === 'paid' && item.people.some(row => row.employeeId === person.employeeId));
    const basisLegacy = draft.payrollRuns.filter(item => item.month === batch.month && item.status === 'paid' && item.lines.some(row => row.employeeId === person.employeeId));
    assert([...basisBatches, ...basisLegacy].every(item => item.date <= input.date), 'Återkravet får inte dateras före de utbetalningar som ingår i månadsunderlaget.');
    const prior = draft.payrollRecoveries.filter(item => item.month === batch.month && item.employeeId === person.employeeId);
    assert(prior.every(item => item.date <= input.date), 'Återkraven ska registreras i datumordning.');
    assert(basisBatches.every(item => item.people.find(row => row.employeeId === person.employeeId).profile.birthYear === person.profile.birthYear), 'Månadens födelseår skiljer sig mellan löneunderlagen. Granska innan rättelse.');
    const basisTaxableCents = sum([...basisBatches.flatMap(item => item.people.filter(row => row.employeeId === person.employeeId).map(row => row.taxableCents)), ...basisLegacy.flatMap(item => item.lines.filter(row => row.employeeId === person.employeeId).map(row => row.grossCents + row.benefitCents))]) - sum(prior.map(item => item.grossCents));
    assert(grossCents <= basisTaxableCents, 'Återkravet överstiger månadens kvarvarande skattepliktiga lön.');
    const calc = taxableCents => calculateEmployerContributions({ birthYear: person.profile.birthYear, paymentDate: batch.date, taxableCents }).contributionCents;
    const employerReductionCents = calc(basisTaxableCents) - calc(basisTaxableCents - grossCents);
    assert(employerReductionCents <= remainingEmployer(batch, person.employeeId, draft), 'Avgiftsminskningen överstiger personens avgifter i originalkörningen. Granska fördelningen mellan körningarna.');
    const contributionHandling = batch.taxSettlement ? 'tax-credit' : 'reduce-unpaid';
    if (batch.taxSettlement) assert(input.date >= batch.taxSettlement.date, 'Återkravet får inte bokföras före den redan registrerade skatteregleringen.');
    const record = { id: nextId(draft, 'payroll-recovery'), batchId: batch.id, originalEntryId: batch.entryId, employeeId: person.employeeId, month: batch.month, date: input.date, component, taxClass, grossCents, employerReductionCents, contributionHandling,
      basisBatchIds: basisBatches.map(item => item.id), basisLegacyRunIds: basisLegacy.map(item => item.id), priorRecoveryIds: prior.map(item => item.id), basisTaxableCents,
      birthYear: person.profile.birthYear, paymentDate: batch.date, reason: text(input.reason, 'orsak till återkrav'), reference: text(input.reference, 'återkravets referens'), reviewed: true, agiCorrectionConfirmed: true, payments: [], taxCredit: null };
    assert(!draft.payrollRecoveries.some(item => item.reference === record.reference), 'Återkravets referens finns redan.');
    const entry = appendEntry(draft, { date: input.date, description: `Bruttolöneåterkrav ${batch.month} · ${record.reason}`, sourceType: 'payroll-v2-recovery', sourceId: record.id, rows: recoveryRows(record) });
    record.entryId = entry.id; record.snapshot = recoverySnapshot(record); draft.payrollRecoveries.push(record);
    addActivity(draft, `Bruttolöneåterkrav registrerat; innehållen skatt ändras inte`, record.id);
  });
}

export function receivePayrollRecovery(state, id, input) {
  return payrollTransaction(state, draft => {
    const record = (draft.payrollRecoveries ?? []).find(item => item.id === id); assert(record, 'Återkravet saknas.');
    requireOpenPeriod(draft, input.date); assert(input.date >= record.date && record.payments.every(item => item.date <= input.date), 'Inbetalningen ska ligga efter återkravet och tidigare inbetalningar.');
    const amountCents = cents(input.amountCents, false), reference = text(input.reference, 'inbetalningens referens');
    assert(sum(record.payments.map(item => item.amountCents)) + amountCents <= record.grossCents, 'Inbetalningen överstiger kvarvarande bruttolönefordran.');
    assert(!(draft.payrollRecoveries ?? []).some(item => item.payments.some(payment => payment.reference === reference)), 'Inbetalningsreferensen har redan använts.');
    const paymentId = nextId(draft, 'payroll-recovery-payment');
    const entry = appendEntry(draft, { date: input.date, description: 'Inbetalning av bruttolöneåterkrav', sourceType: 'payroll-v2-recovery-payment', sourceId: paymentId, rows: [debit('1930', amountCents), credit('1680', amountCents)] });
    record.payments.push({ id: paymentId, date: input.date, amountCents, reference, entryId: entry.id });
    draft.bankTransactions.push({ id: nextId(draft, 'bank'), date: input.date, description: 'Återbetald bruttolön', account: '1930', amountCents, matchedEntryId: entry.id });
    addActivity(draft, 'Inbetalning mot bruttolönefordran registrerad', record.id);
  });
}
export function receivePayrollRecoveryTaxCredit(state, id, input) {
  return payrollTransaction(state, draft => {
    const record = (draft.payrollRecoveries ?? []).find(item => item.id === id); assert(record, 'Återkravet saknas.');
    assert(record.contributionHandling === 'tax-credit' && !record.taxCredit && record.employerReductionCents > 0, 'Återkravet har ingen oreglerad avgiftskreditering.');
    requireOpenPeriod(draft, input.date); assert(input.date >= record.date, 'Avgiftskrediteringen ligger före återkravet.');
    const reference = text(input.reference, 'Skatteverkets krediteringsreferens');
    const entry = appendEntry(draft, { date: input.date, description: 'Krediterad arbetsgivaravgift vid bruttolöneåterkrav', sourceType: 'payroll-v2-recovery-tax', sourceId: record.id, rows: [debit('1630', record.employerReductionCents), credit('2731', record.employerReductionCents)] });
    record.taxCredit = { date: input.date, reference, entryId: entry.id, amountCents: record.employerReductionCents };
    draft.bankTransactions.push({ id: nextId(draft, 'bank'), date: input.date, description: 'Krediterad arbetsgivaravgift', account: '1630', amountCents: record.employerReductionCents, matchedEntryId: entry.id });
    addActivity(draft, 'Skatteverkets faktiska avgiftskreditering registrerad', record.id);
  });
}

function validatePayrollRecoveries(state, addEntry) {
  assert(state.payrollRecoveries === undefined || Array.isArray(state.payrollRecoveries), 'Återkravsregistret är ogiltigt.');
  const ids = new Set(), references = new Set(), paymentIds = new Set(), paymentRefs = new Set();
  for (const [index, record] of (state.payrollRecoveries ?? []).entries()) {
    assert(typeof record.id === 'string' && !ids.has(record.id), 'Återkravets ID är dubbelt eller ogiltigt.'); ids.add(record.id);
    const batch = find(state, record.batchId), person = batch.people.find(item => item.employeeId === record.employeeId);
    assert(batch.status === 'paid' && person && record.month === batch.month && validDate(record.date) && record.date >= batch.date && record.reviewed === true && record.agiCorrectionConfirmed === true, 'Återkravets original, datum eller granskning är ogiltig.');
    assert(record.snapshot === recoverySnapshot(record) && text(record.reason, 'återkravsorsak') && text(record.reference, 'återkravsreferens'), 'Återkravets fastställda underlag har ändrats.');
    assert(!references.has(record.reference), 'Återkravets referens är dubbel.'); references.add(record.reference);
    cents(record.grossCents, false); cents(record.employerReductionCents); cents(record.basisTaxableCents, false);
    const prior = state.payrollRecoveries.slice(0, index).filter(item => item.month === record.month && item.employeeId === record.employeeId);
    assert(immutableFields(prior.map(item => item.id)) === immutableFields(record.priorRecoveryIds) && prior.every(item => item.date <= record.date), 'Återkravets tidigare underlag är fel.');
    assert(Array.isArray(record.basisBatchIds) && new Set(record.basisBatchIds).size === record.basisBatchIds.length && record.basisBatchIds.includes(batch.id), 'Återkravets löneunderlag saknas.');
    const basisBatches = record.basisBatchIds.map(id => find(state, id));
    assert(basisBatches.every(item => item.status === 'paid' && item.month === record.month && item.date <= record.date && item.people.some(row => row.employeeId === record.employeeId)), 'Återkravets tidigare lönekörningar är ogiltiga.');
    assert(Array.isArray(record.basisLegacyRunIds) && new Set(record.basisLegacyRunIds).size === record.basisLegacyRunIds.length, 'Återkravets äldre löneunderlag är ogiltigt.');
    const basisLegacy = record.basisLegacyRunIds.map(id => state.payrollRuns.find(item => item.id === id));
    assert(basisLegacy.every(item => item && item.status === 'paid' && item.month === record.month && item.date <= record.date && item.lines.some(row => row.employeeId === record.employeeId)), 'Återkravets äldre lönekörning saknas.');
    const expectedBasis = sum([...basisBatches.flatMap(item => item.people.filter(row => row.employeeId === record.employeeId).map(row => row.taxableCents)), ...basisLegacy.flatMap(item => item.lines.filter(row => row.employeeId === record.employeeId).map(row => row.grossCents + row.benefitCents))]) - sum(prior.map(item => item.grossCents));
    assert(expectedBasis === record.basisTaxableCents && record.grossCents <= expectedBasis, 'Återkravets månadsunderlag är ändrat.');
    const componentGross = sum([...prior.filter(item => item.batchId === record.batchId && item.component === record.component && item.taxClass === record.taxClass).map(item => item.grossCents), record.grossCents]);
    assert(componentGross <= recoveryComponent(person, record.component, record.taxClass), 'Bruttolöneåterkravet överstiger originalets löneslag.');
    const calc = taxableCents => calculateEmployerContributions({ birthYear: person.profile.birthYear, paymentDate: batch.date, taxableCents }).contributionCents;
    assert(record.birthYear === person.profile.birthYear && record.paymentDate === batch.date && record.employerReductionCents === calc(expectedBasis) - calc(expectedBasis - record.grossCents), 'Återkravets arbetsgivaravgift är fel.');
    assert(sum([...prior.filter(item => item.batchId === batch.id).map(item => item.employerReductionCents), record.employerReductionCents]) <= person.employerCents, 'Återkravets avgiftsminskning överstiger personens originalkörning.');
    assert(['reduce-unpaid', 'tax-credit'].includes(record.contributionHandling), 'Återkravets avgiftshantering är fel.');
    if (record.contributionHandling === 'tax-credit') assert(batch.taxSettlement && record.date >= batch.taxSettlement.date, 'Avgiften hade inte reglerats före krediteringskravet.');
    else if (batch.taxSettlement) assert(batch.taxSettlement.date >= record.date, 'Avgiftsminskningen ligger efter skattens reglering.');
    const entry = addEntry(record.entryId, 'payroll-v2-recovery', record.id, record.date, recoveryRows(record)); assert(record.originalEntryId === batch.entryId && !entry.correctsEntryId, 'Återkravet saknar koppling till löneoriginalet.');
    assert(Array.isArray(record.payments), 'Återkravets inbetalningar är ogiltiga.');
    let paid = 0, previousDate = record.date;
    for (const payment of record.payments) {
      assert(typeof payment.id === 'string' && !paymentIds.has(payment.id) && !paymentRefs.has(payment.reference) && text(payment.reference, 'inbetalningsreferens'), 'Återkravets inbetalnings-ID eller referens är dubbel.'); paymentIds.add(payment.id); paymentRefs.add(payment.reference);
      assert(validDate(payment.date) && payment.date >= previousDate, 'Återkravets inbetalningsdatum är fel.'); previousDate = payment.date;
      paid += cents(payment.amountCents, false); assert(paid <= record.grossCents, 'Återkravet är överbetalt.');
      addEntry(payment.entryId, 'payroll-v2-recovery-payment', payment.id, payment.date, [debit('1930', payment.amountCents), credit('1680', payment.amountCents)]);
      const bank = state.bankTransactions.filter(item => item.matchedEntryId === payment.entryId); assert(bank.length === 1 && bank[0].account === '1930' && bank[0].date === payment.date && bank[0].amountCents === payment.amountCents, 'Återkravets bankinbetalning stämmer inte.');
    }
    if (record.taxCredit) {
      const item = record.taxCredit; assert(record.contributionHandling === 'tax-credit' && record.employerReductionCents > 0 && validDate(item.date) && item.date >= record.date && item.amountCents === record.employerReductionCents && text(item.reference, 'avgiftskrediteringens referens'), 'Återkravets avgiftskreditering är fel.');
      addEntry(item.entryId, 'payroll-v2-recovery-tax', record.id, item.date, [debit('1630', item.amountCents), credit('2731', item.amountCents)]);
      const bank = state.bankTransactions.filter(value => value.matchedEntryId === item.entryId); assert(bank.length === 1 && bank[0].account === '1630' && bank[0].date === item.date && bank[0].amountCents === item.amountCents, 'Avgiftskrediteringens skattekontohändelse saknas.');
    }
  }
}

/** Paid salary only; deductions remain reported when a gross recovery is made. */
export function getPayrollDeclarationPeople(state, month) {
  validatePayrollBatches(state); assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), 'Välj en giltig deklarationsmånad.');
  const people = new Map();
  const add = (employeeId, values, source, legacy = false) => {
    const row = people.get(employeeId) ?? { employeeId, grossCents: 0, benefitCents: 0, withholdingCents: 0, employerCents: 0, sourceBatchIds: [], sourceLegacyRunIds: [], recoveryIds: [] };
    for (const field of ['grossCents', 'benefitCents', 'withholdingCents', 'employerCents']) row[field] += values[field] ?? 0;
    row[legacy ? 'sourceLegacyRunIds' : 'sourceBatchIds'].push(source); people.set(employeeId, row);
  };
  for (const batch of state.payrollBatches ?? []) if (batch.status === 'paid' && batch.month === month) for (const person of batch.people) add(person.employeeId, person, batch.id);
  // Older salary runs may have been paid after their nominal payroll month.
  // AGI follows the actual payout; historic data without paidDate uses date.
  for (const batch of state.payrollRuns) if (batch.status === 'paid' && (batch.paidDate ?? batch.date).slice(0, 7) === month) for (const person of batch.lines) add(person.employeeId, person, batch.id, true);
  for (const record of state.payrollRecoveries ?? []) if (record.month === month) {
    const row = people.get(record.employeeId); assert(row, 'Återkravet saknar utbetald lön i deklarationsperioden.');
    row.grossCents -= record.grossCents; row.employerCents -= record.employerReductionCents; row.recoveryIds.push(record.id);
  }
  for (const row of people.values()) for (const key of ['grossCents', 'benefitCents', 'withholdingCents', 'employerCents']) cents(row[key]);
  return [...people.values()];
}
