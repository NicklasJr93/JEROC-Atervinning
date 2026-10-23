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
});
const debit = (account, amount) => ({ account, debitCents: amount, creditCents: 0 });
const credit = (account, amount) => ({ account, debitCents: 0, creditCents: amount });
const sum = values => values.reduce((a, b) => cents(a + cents(b)), 0);
const round = (amount, numerator, denominator = 10_000) => cents(Number((BigInt(amount) * BigInt(numerator) * 2n + BigInt(denominator)) / (BigInt(denominator) * 2n)));
const text = (value, label, maximum = 250) => { assert(typeof value === 'string' && value.trim() && value.length <= maximum, `Ange ${label} (högst ${maximum} tecken).`); return value.trim(); };
const integer = (value, min, max, label) => { assert(Number.isSafeInteger(value) && value >= min && value <= max, `${label} ska vara ${min}–${max}.`); return value; };
const collections = state => { state.payrollProfiles ??= []; state.payrollBatches ??= []; return state; };
const find = (state, id) => { const batch = (state.payrollBatches ?? []).find(item => item.id === id); assert(batch, 'Lönekörningen finns inte.'); return batch; };
const isActive = batch => batch.status !== 'reversed';
const priorRows = (state, employeeId, month, excludeId = '') => [
  ...(state.payrollBatches ?? []).filter(batch => batch.id !== excludeId && isActive(batch) && batch.status !== 'draft' && batch.month === month).flatMap(batch => batch.people.filter(person => person.employeeId === employeeId)),
  ...state.payrollRuns.filter(batch => batch.status !== 'draft' && batch.month === month).flatMap(batch => batch.lines.filter(person => person.employeeId === employeeId).map(person => ({ taxableCents: person.grossCents + person.benefitCents, withholdingCents: person.withholdingCents }))),
];
const periodicBase = person => person.periodicTaxableCents ?? person.taxableCents;
const periodicWithheld = person => person.periodicWithholdingCents ?? person.withholdingCents;
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
    const usedDays = (draft.payrollBatches ?? []).filter(isActive).flatMap(batch => batch.people).filter(person => person.employeeId === profile.employeeId).reduce((n, person) => n + person.input.vacationDays, 0);
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
  const row = {
    employeeId: employee.id, scheduledHoursHundredths: integer(input.scheduledHoursHundredths ?? 16_000, 1, 74_400, 'Schemalagd arbetstid'),
    unpaidHoursHundredths: integer(input.unpaidHoursHundredths ?? 0, 0, 74_400, 'Obetald frånvaro'),
    sickHoursHundredths: integer(input.sickHoursHundredths ?? 0, 0, 74_400, 'Sjukfrånvaro'),
    sickScheduledHoursHundredths: integer(input.sickScheduledHoursHundredths ?? 0, 0, 74_400, 'Granskat schema under sjukperioden'),
    sickScheduleConfirmed: input.sickScheduleConfirmed === true,
    sickStart: input.sickStart ?? '', sickEnd: input.sickEnd ?? '',
    vacationDays: integer(input.vacationDays ?? 0, 0, 31, 'Semesterdagar'),
    vacationBaseCents: cents(input.vacationBaseCents ?? 0), benefitCents: cents(input.benefitCents ?? 0),
    reimbursementCents: cents(input.reimbursementCents ?? 0), manualTaxCents: cents(input.manualTaxCents ?? 0),
    additionalGrossCents: cents(input.additionalGrossCents ?? 0), kind: input.kind ?? 'regular',
    extraTaxMode: input.extraTaxMode ?? 'periodic', vacationTaxMode: input.vacationTaxMode ?? 'periodic',
    annualSalaryCents: cents(input.annualSalaryCents ?? 0), annualSalaryReviewed: input.annualSalaryReviewed === true,
    note: input.note ? text(input.note, 'löneanteckning', 500) : '',
  };
  assert(['regular', 'supplement'].includes(row.kind), 'Ogiltig löneradstyp.');
  assert(['periodic', 'one-off'].includes(row.extraTaxMode) && ['periodic', 'one-off'].includes(row.vacationTaxMode), 'Välj återkommande lön eller engångsbelopp för extra lön och semester.');
  assert(row.unpaidHoursHundredths + row.sickHoursHundredths <= row.scheduledHoursHundredths, 'Frånvaron överstiger schemalagd arbetstid.');
  const prior = priorRows(state, employee.id, month, excludeId);
  const context = historicalContext ?? {
    previousTaxableCents: sum(prior.map(person => person.taxableCents)), previousWithheldCents: sum(prior.map(person => person.withholdingCents)),
    previousPeriodicTaxableCents: sum(prior.map(periodicBase)), previousPeriodicWithheldCents: sum(prior.map(periodicWithheld)),
    priorPayrollBatchIds: (state.payrollBatches ?? []).filter(batch => batch.id !== excludeId && isActive(batch) && batch.status !== 'draft' && batch.month === month && batch.people.some(person => person.employeeId === employee.id)).map(batch => batch.id),
    priorLegacyRunIds: state.payrollRuns.filter(batch => batch.status !== 'draft' && batch.month === month && batch.lines.some(person => person.employeeId === employee.id)).map(batch => batch.id),
    usedVacationDays: (state.payrollBatches ?? []).filter(batch => isActive(batch) && batch.id !== excludeId).flatMap(batch => batch.people).filter(person => person.employeeId === employee.id).reduce((a, person) => a + person.input.vacationDays, 0),
    priorKarensCents: 0,
  };
  assert(context.usedVacationDays + row.vacationDays <= profile.paidVacationDays, 'Semesterdagarna överstiger granskat saldo.');
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
  const regularBase = row.kind === 'supplement' ? 0 : employee.payType === 'hourly' ? round(employee.baseCents, row.scheduledHoursHundredths, 100) : employee.baseCents;
  const absenceDeductionCents = round(profile.deductionHourlyCents, row.unpaidHoursHundredths + row.sickHoursHundredths, 100);
  assert(absenceDeductionCents <= regularBase, 'Frånvaroavdraget överstiger grundlönen. Granska timvärdet och schemat.');
  if (row.kind === 'supplement') assert(!row.vacationDays && !row.sickHoursHundredths && !row.unpaidHoursHundredths, 'Kompletteringskörningen avser endast extra lön, förmån eller utlägg.');
  const vacationPayCents = profile.vacationMethod === 'same-pay' ? round(employee.baseCents, row.vacationDays * profile.vacationSupplementBps) : round(row.vacationBaseCents, profile.vacationPercentBps);
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
      const existingDraft = draft.payrollBatches.some(batch => batch.status === 'draft' && batch.month === month && batch.people.some(person => person.employeeId === row.employeeId));
      assert(!existingDraft, 'Det finns redan ett löneutkast för den anställde och månaden.');
      const existingRegular = draft.payrollBatches.some(batch => isActive(batch) && batch.month === month && batch.people.some(person => person.employeeId === row.employeeId && person.input.kind === 'regular')) || draft.payrollRuns.some(batch => batch.month === month && batch.lines.some(person => person.employeeId === row.employeeId));
      const bookedRegular = draft.payrollBatches.some(batch => ['posted', 'paid'].includes(batch.status) && batch.month === month && batch.people.some(person => person.employeeId === row.employeeId && person.input.kind === 'regular')) || draft.payrollRuns.some(batch => batch.status !== 'draft' && batch.month === month && batch.lines.some(person => person.employeeId === row.employeeId));
      assert(row.kind === 'supplement' || !existingRegular, 'Ordinarie månadslön finns redan. Välj kompletterande lön eller rätta originalet först.');
      assert(row.kind !== 'supplement' || bookedRegular, 'Bokför ordinarie lön före en kompletterande utbetalning.');
      if (row.kind === 'supplement') {
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
    const t = getPayrollBatchTotals(batch), amount = sum([t.withholdingCents, t.employerCents]);
    let entryId = null;
    if (amount) {
      const entry = appendEntry(draft, { date, description: `Reglering löneskatt ${batch.month}`, sourceType: 'payroll-v2-tax', sourceId: id,
        rows: [debit('2710', t.withholdingCents), debit('2731', t.employerCents), credit('1630', amount)].filter(row => row.debitCents || row.creditCents) });
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
      const historicalState = { ...state, employees: [person.employee] };
      assert(person.employee.id === person.employeeId && JSON.stringify(checkedProfile(historicalState, person.profile)) === JSON.stringify(person.profile), 'Löneradens historiska anställningsunderlag är ogiltigt.');
      for (const key of ['previousTaxableCents', 'previousWithheldCents', 'previousPeriodicTaxableCents', 'previousPeriodicWithheldCents', 'priorKarensCents']) cents(person.context[key]);
      integer(person.context.usedVacationDays, 0, 36600, 'Tidigare semesterdagar');
      const earlierBatches = state.payrollBatches.slice(0, batchIndex);
      assert(Array.isArray(person.context.priorPayrollBatchIds) && new Set(person.context.priorPayrollBatchIds).size === person.context.priorPayrollBatchIds.length && person.context.priorPayrollBatchIds.every(id => earlierBatches.some(prior => prior.id === id && prior.month === batch.month)), 'Lönens tidigare körningsreferenser är ogiltiga.');
      assert(Array.isArray(person.context.priorLegacyRunIds) && new Set(person.context.priorLegacyRunIds).size === person.context.priorLegacyRunIds.length && person.context.priorLegacyRunIds.every(id => state.payrollRuns.some(prior => prior.id === id && prior.status !== 'draft' && prior.month === batch.month)), 'Lönens tidigare äldre körningsreferenser är ogiltiga.');
      const previous = [
        ...earlierBatches.filter(prior => person.context.priorPayrollBatchIds.includes(prior.id)).flatMap(prior => prior.people.filter(row => row.employeeId === person.employeeId)),
        ...state.payrollRuns.filter(prior => person.context.priorLegacyRunIds.includes(prior.id)).flatMap(prior => prior.lines.filter(row => row.employeeId === person.employeeId).map(row => ({ taxableCents: row.grossCents + row.benefitCents, withholdingCents: row.withholdingCents }))),
      ];
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
      const amount = sum([totals.withholdingCents, totals.employerCents]); assert(batch.status === 'paid' && batch.taxSettlement.amountCents === amount && validDate(batch.taxSettlement.date) && batch.taxSettlement.date >= batch.date, 'Skatteregleringen är ogiltig.');
      if (amount) {
        addEntry(batch.taxSettlement.entryId, 'payroll-v2-tax', batch.id, batch.taxSettlement.date, [debit('2710', totals.withholdingCents), debit('2731', totals.employerCents), credit('1630', amount)].filter(row => row.debitCents || row.creditCents));
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
  for (const entry of state.entries) if (entry.sourceType.startsWith('payroll-v2')) assert(entryIds.has(entry.id), 'Löneverifikationen saknar ett verifierbart löneunderlag.');
  return { entryIds, accountBalances };
}

export function payrollReviewCsv(state, id) {
  validatePayrollBatches(state); const batch = find(state, id); assert(batch.status !== 'draft', 'Bokför lönen innan granskningsunderlaget exporteras.');
  const cell = value => `"${String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
  const rows = [['GRANSKNINGSUNDERLAG – inte AGI eller myndighetsfil'], ['Period', 'Utbetalningsdatum', 'Anställd', 'Kontant bruttolön öre', 'Förmån öre', 'Avdragen skatt öre', 'Arbetsgivaravgift öre', 'Nettolön öre', 'Regelversion'], ...batch.people.map(person => [batch.month, batch.date, person.name, person.grossCents, person.benefitCents, person.withholdingCents, person.employerCents, person.netCents, batch.ruleVersion])];
  return '\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n');
}
