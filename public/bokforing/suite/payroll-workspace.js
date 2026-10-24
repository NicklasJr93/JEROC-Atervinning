import { cents, toCents } from './core.js';
import { createPayrollBatch, discardPayrollDraft, discardLegacyPayrollDraft, getPayrollBatchTotals, getPayrollBatchRows, payPayrollBatch, payrollReviewCsv, PAYROLL_RULES, postPayrollBatch, reversePayrollBatch, savePayrollProfile, settlePayrollBatchTaxes, createVacationYear, getVacationBalance, createPayrollRecovery, receivePayrollRecovery, receivePayrollRecoveryTaxCredit, getPayrollDeclarationPeople, getPayrollAnnualContributionReview, reviewPayrollAnnualContributions, settlePayrollContributionReview } from './payroll-engine.js';

const e = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const money = value => new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK' }).format((value ?? 0) / 100);
const rawMoney = value => ((value ?? 0) / 100).toFixed(2);
const number = value => Number(String(value).replace(',', '.'));
const amount = value => toCents(value === '' || value === undefined ? '0' : value);
const yes = value => value === 'on' || value === true || value === 'true';
const dateFor = state => { const today = new Date().toISOString().slice(0, 10); return today < state.company.fiscalYearStart ? state.company.fiscalYearStart : today > state.company.fiscalYearEnd ? state.company.fiscalYearEnd : today; };
const field = (label, name, value = '', type = 'text', attributes = '') => `<label>${e(label)}<input type="${type}" name="${e(name)}" value="${e(value)}" ${attributes}></label>`;
const select = (label, name, value, options) => `<label>${e(label)}<select name="${e(name)}">${options.map(([id, text]) => `<option value="${e(id)}" ${String(value) === String(id) ? 'selected' : ''}>${e(text)}</option>`).join('')}</select></label>`;
const checkbox = (label, name, checked = false) => `<label class="payroll-check"><input type="checkbox" name="${e(name)}" ${checked ? 'checked' : ''}>${e(label)}</label>`;
const form = (action, content, id = '') => `<form data-feature-form="payroll-v2" data-action="${e(action)}">${id ? `<input type="hidden" name="id" value="${e(id)}">` : ''}${content}</form>`;
const button = (label, klass = 'button primary') => `<button class="${klass}" type="submit">${e(label)}</button>`;
const stateNames = { draft: 'Utkast', posted: 'Bokförd', paid: 'Utbetald', reversed: 'Återförd' };

function profileCard(state, employee) {
  const profile = (state.payrollProfiles ?? []).find(item => item.employeeId === employee.id);
  const hourly = employee.payType === 'hourly' ? employee.baseCents : Math.round(employee.baseCents * 12 / (52 * 40));
  return `<details class="payroll-person-card"><summary><strong>${e(employee.name)}</strong><span class="badge ${profile ? 'paid' : 'draft'}">${profile ? 'Granskad profil' : 'Löneprofil saknas'}</span></summary>${form('profile', `
    <input type="hidden" name="employeeId" value="${e(employee.id)}"><input type="hidden" name="date" value="${dateFor(state)}">
    <div class="payroll-form-grid">
      ${field('Födelseår', 'birthYear', profile?.birthYear ?? '', 'number', 'required min="1900" max="2010"')}
      ${select('Skatteunderlag', 'taxMode', profile?.taxMode ?? 'table', [['table', 'Officiell månadstabell 2026'], ['decision', 'Dokumenterat individuellt skattebeslut']])}
      ${select('Skattetabell enligt A-skattsedel', 'table', profile?.table ?? 32, Array.from({ length: 14 }, (_, index) => [29 + index, `Tabell ${29 + index}`]))}
      ${select('Lönekolumn enligt A-skattsedel', 'column', profile?.column ?? 1, [[1, 'Kolumn 1'], [3, 'Kolumn 3']])}
      ${field('Beslutsreferens (vid individuellt beslut)', 'taxDecisionReference', profile?.taxDecisionReference ?? '')}
      ${field('Ordinarie arbetstid, timmar/vecka', 'weeklyHours', (profile?.weeklyHoursHundredths ?? 4000) / 100, 'number', 'required step="0.01" min="0.01" max="168"')}
      ${field('Granskat timvärde för frånvaro, kr', 'deductionHourly', rawMoney(profile?.deductionHourlyCents ?? hourly), 'text', 'required inputmode="decimal"')}
      ${select('Semesterregel', 'vacationMethod', profile?.vacationMethod ?? (employee.payType === 'hourly' ? 'percentage' : 'same-pay'), [['same-pay', 'Sammalöneregel + tillägg'], ['percentage', 'Procent på granskat semesterunderlag']])}
      ${field('Semestertillägg per dag, %', 'vacationSupplement', (profile?.vacationSupplementBps ?? 43) / 100, 'text', 'inputmode="decimal"')}
      ${field('Semesterprocent, %', 'vacationPercent', (profile?.vacationPercentBps ?? 1200) / 100, 'text', 'inputmode="decimal"')}
      ${field('Granskat antal tillgängliga betalda dagar', 'paidVacationDays', profile?.paidVacationDays ?? 25, 'number', 'required min="0" max="366"')}
      ${select('Granskad förväntan om årsersättningen', 'contributionAnnualExpectation', profile?.contributionAnnualExpectation ?? 'at-least-1000', [['at-least-1000','Minst 1 000 kr väntas under året'],['below-1000','Under 1 000 kr väntas under året']])}
      ${field('Underlag för årsbedömningen', 'contributionAnnualReference', profile?.contributionAnnualReference ?? profile?.agreementNote ?? '', 'text', 'required maxlength="250"')}
      ${field('Avtal/rutin som styr timvärde och semester', 'agreementNote', profile?.agreementNote ?? '', 'text', 'required maxlength="250"')}
    </div>
    <p class="muted">Timvärdet ovan är ett förslag tills du har granskat det mot anställningsvillkoren. Ett semesterkonto nedan kan beräkna intjänade dagar och procentbelopp från granskat underlag. Kollektivavtalsvillkor måste anges och kontrolleras separat.</p>
    ${checkbox('Vanlig svensk anställning; inga särskilda nedsättningar utöver ålder/ungdom gäller.', 'domesticOrdinary', false)}
    ${checkbox('Jag har granskat A-skattsedel, födelseår, timvärde, semesterregel och underlag.', 'reviewed', false)}
    ${button('Spara granskad löneprofil')}`, employee.id)}</details>`;
}

function personInput(state, employee) {
  const profile = (state.payrollProfiles ?? []).find(item => item.employeeId === employee.id);
  return `<details class="payroll-person-card" ${profile ? '' : 'open'}><summary>${checkbox(employee.name, `include:${employee.id}`)}<span>${e(money(employee.baseCents))} / ${employee.payType === 'hourly' ? 'timme' : 'månad'}</span></summary>
    ${!profile ? '<p class="payroll-warning">Spara en granskad löneprofil ovan innan denna person kan ingå.</p>' : ''}
    <div class="payroll-form-grid">
      ${select('Lönetyp i körningen', `kind:${employee.id}`, 'regular', [['regular', 'Ordinarie lön'], ['supplement', 'Kompletterande lön efter ordinarie körning'], ['vacation-final', 'Slutlig semesterersättning från semesterkonto']])}
      ${field('Schemalagda timmar', `hours:${employee.id}`, 160, 'number', 'min="0.01" max="744" step="0.01"')}
      ${field('Obetald frånvaro, timmar', `unpaid:${employee.id}`, 0, 'number', 'min="0" max="744" step="0.01"')}
      ${field('Sjukfrånvaro, timmar', `sick:${employee.id}`, 0, 'number', 'min="0" max="744" step="0.01"')}
      ${field('Schemalagda timmar under sjukperioden', `sickScheduled:${employee.id}`, 0, 'number', 'min="0" max="336" step="0.01"')}
      ${field('Sjukperiodens första dag', `sickStart:${employee.id}`, '', 'date')}
      ${field('Sjukfrånvarons sista dag i denna körning', `sickEnd:${employee.id}`, '', 'date')}
      ${select('Semesterkonto för uttaget', `vacationYear:${employee.id}`, '', [['', 'Manuellt granskat saldo / inget semesterkonto'], ...(state.payrollVacationYears ?? []).filter(year => year.employeeId === employee.id).map(year => [year.id, `${year.leaveStart}–${year.leaveEnd} · ${getVacationBalance(state, year.id).remainingDays} dagar kvar`])])}
      ${field('Schemalagda semestertimmar (procentregeln)', `vacationHours:${employee.id}`, 0, 'number', 'min="0" max="744" step="0.01"')}
      ${field('Granskad semesterersättning per dag vid slutlön, kr', `finalDaily:${employee.id}`, '0.00', 'text', 'inputmode="decimal"')}
      ${checkbox('Jag har granskat slutlig semesterersättning och att anställningen/semesterårets uttag ska avslutas.', `finalReviewed:${employee.id}`)}
      ${field('Betalda semesterdagar', `vacationDays:${employee.id}`, 0, 'number', 'min="0" max="31"')}
      ${field('Semesterunderlag, kr (procentregeln)', `vacationBase:${employee.id}`, '0.00', 'text', 'inputmode="decimal"')}
      ${select('Skattehantering av semesterbeloppet', `vacationTaxMode:${employee.id}`, 'periodic', [['periodic', 'Semesterlön/tillägg för månadens uttag'], ['one-off', 'Semesterersättning/engångsbelopp']])}
      ${field('Extra skattepliktig ersättning, kr', `extra:${employee.id}`, '0.00', 'text', 'inputmode="decimal"')}
      ${select('Typ av extra ersättning', `extraTaxMode:${employee.id}`, 'periodic', [['periodic', 'Återkommande tidsbestämd lön för perioden'], ['one-off', 'Engångsbelopp: bonus, retroaktiv lön m.m.']])}
      ${field('Beräknad helårslön inkl. förmåner och engångsbelopp, kr', `annualSalary:${employee.id}`, '0.00', 'text', 'inputmode="decimal"')}
      ${field('Granskat skattepliktigt förmånsvärde, kr', `benefit:${employee.id}`, '0.00', 'text', 'inputmode="decimal"')}
      ${field('Granskade skattefria utlägg, kr', `reimbursement:${employee.id}`, '0.00', 'text', 'inputmode="decimal"')}
      ${field('Skatteavdrag enligt individuellt beslut, kr', `tax:${employee.id}`, '0.00', 'text', 'inputmode="decimal"')}
      ${field('Kommentar och underlagsreferens', `note:${employee.id}`, '', 'text', 'maxlength="500"')}
    </div>${checkbox('Jag har kontrollerat arbetsschemat för sjukperioden (krävs vid sjukfrånvaro).', `sickScheduleReviewed:${employee.id}`)}${checkbox('Jag har granskat helårslönen inklusive årets engångsbelopp (krävs för engångstabell).', `annualSalaryReviewed:${employee.id}`)}<p class="muted">Extra ersättning och semesterbelopp klassificeras var för sig. Engångstabell 2026 stöder lönekolumn 1/3 för anställda med regelbunden lön.</p></details>`;
}

function batchCard(state, batch) {
  const totals = getPayrollBatchTotals(batch);
  const noJournal = totals.benefitCents > 0 && getPayrollBatchRows(batch).length === 0;
  const statusText = noJournal ? { draft: 'Utkast', posted: 'Registrerat utan verifikation', paid: 'Förmån bekräftad', reversed: 'Underlag återtaget' }[batch.status] : stateNames[batch.status];
  const source = batch.people.find(person => person.tax.sourceUrl)?.tax.sourceUrl;
  const createDate = field('Datum', 'date', batch.date, 'date', 'required');
  const actions = batch.status === 'draft' ? `${form('post', `${checkbox('Jag har granskat varje person, skatteavdrag, frånvaro och förmåner.', 'reviewed')}${button(noJournal ? 'Registrera granskat förmånsunderlag' : 'Bokför granskad lön')}`, batch.id)}${form('discard', button('Ta bort obokfört utkast', 'button'), batch.id)}`
    : batch.status === 'posted' ? `${form('pay', `${createDate}${button(noJournal ? 'Bekräfta förmån utan utbetalning' : 'Registrera nettolöneutbetalning')}`, batch.id)}<details><summary>Rätta obetald lönekörning</summary>${form('reverse', `${createDate}${field('Orsak till rättelse', 'reason', '', 'text', 'required maxlength="250"')}${button('Skapa länkad återföring', 'button danger')}`, batch.id)}</details>`
      : batch.status === 'paid' && !batch.taxSettlement ? form('settle-tax', `${field('Datum på skattekontot', 'date', batch.date, 'date', 'required')}${button(noJournal ? 'Bekräfta att ingen skatt eller avgift ska betalas' : 'Registrera skatt och avgifter mot skattekontot', 'button')}`, batch.id) : '';
  return `<section class="panel payroll-batch"><header class="payroll-batch-header"><div><h2>Lön ${e(batch.month)}</h2><p>${e(batch.id)} · Utbetalningsdag ${e(batch.date)}</p></div><span class="badge ${batch.status === 'paid' ? 'paid' : 'draft'}">${e(statusText)}</span></header>
    <div class="payroll-totals"><div><small>Bruttolön</small><strong>${e(money(totals.grossCents))}</strong></div><div><small>Avdragen skatt</small><strong>${e(money(totals.withholdingCents))}</strong></div><div><small>Arbetsgivaravgifter</small><strong>${e(money(totals.employerCents))}</strong></div><div><small>Nettolön inklusive utlägg</small><strong>${e(money(totals.netCents))}</strong></div></div>
    ${noJournal ? '<p class="muted">Förmånsunderlag utan verifikation. Ingen kontantlön, skatt eller arbetsgivaravgift bokförs i denna körning. Förmånen finns kvar i gransknings- och AGI-underlaget.</p>' : ''}
    ${batch.people.map(person => `<details class="payroll-slip" open><summary><strong>${e(person.name)}</strong><span>${e(money(person.netCents))} att betala</span></summary>
      <dl><div><dt>Lön före frånvaro och tillägg</dt><dd>${e(money(person.input.kind !== 'regular' ? 0 : person.employee.payType === 'hourly' ? Math.round(person.employee.baseCents * person.input.scheduledHoursHundredths / 100) : person.employee.baseCents))}</dd></div><div><dt>Frånvaroavdrag</dt><dd>−${e(money(person.absenceDeductionCents))}</dd></div><div><dt>Sjuklön före karens</dt><dd>${e(money(person.sickPayCents))}</dd></div><div><dt>Karensavdrag</dt><dd>−${e(money(person.karensCents))}</dd></div><div><dt>Semesterlön/-tillägg</dt><dd>${e(money(person.vacationPayCents))}</dd></div><div><dt>Förmån, ingår i skatteunderlaget</dt><dd>${e(money(person.benefitCents))}</dd></div><div><dt>Bruttolön</dt><dd>${e(money(person.grossCents))}</dd></div><div><dt>Avdragen skatt</dt><dd>−${e(money(person.withholdingCents))}</dd></div><div><dt>Skattefria utlägg</dt><dd>${e(money(person.reimbursementCents))}</dd></div><div><dt>Att betala</dt><dd><strong>${e(money(person.netCents))}</strong></dd></div></dl>
      <p class="muted">${person.tax.sourceUrl ? `Tabell ${e(person.tax.table)}, kolumn ${e(person.tax.column)}, underlagsintervall ${e(person.tax.band.join('–'))} kr.` : `Individuellt skattebeslut: ${e(person.tax.decisionReference)}`} Avgiftsregel: ${e(person.employer.classification)}.</p>${person.tax.oneOff ? `<p class="muted">Engångsbelopp ${e(money(person.oneOffCents))}: ${e(person.tax.oneOff.ratePercent)} % enligt granskad årslön ${e(money(person.tax.oneOff.annualSalaryCents))}. Skatteavdrag ${e(money(person.tax.oneOff.taxCents))}. <a href="${e(PAYROLL_RULES.oneOffSource)}" target="_blank" rel="noopener noreferrer">Engångstabell ↗</a></p>` : ''}
      ${person.unwithheldTaxCents ? `<p class="payroll-warning">${e(money(person.unwithheldTaxCents))} av den beräknade skatten ryms inte i kontantlönen. Granska hanteringen innan du bokför.</p>` : ''}
      ${person.input.note ? `<p>${e(person.input.note)}</p>` : ''}</details>`).join('')}
    ${batch.status === 'paid' && !noJournal ? recoveryForm(state, batch) : ''}
    ${batch.reversal ? `<p class="payroll-warning">Återförd ${e(batch.reversal.date)}: ${e(batch.reversal.reason)}. ${noJournal ? 'Originalunderlaget finns kvar; ingen verifikation skapades.' : 'Originalverifikationen finns kvar.'}</p>` : ''}
    <div class="payroll-actions">${actions}</div>
    ${batch.status !== 'draft' ? `<a class="button" download="loneunderlag-${e(batch.month)}.csv" href="data:text/csv;charset=utf-8,${e(encodeURIComponent(payrollReviewCsv(state, batch.id)))}">Hämta granskningsunderlag CSV</a>` : ''}
    ${source ? `<a href="${e(source)}" target="_blank" rel="noopener noreferrer">Källtabell hos Skatteverket</a>` : ''}
  </section>`;
}

export function renderWorkspace(state) {
  const employees = state.employees.filter(employee => employee.active !== false);
  const batches = [...(state.payrollBatches ?? [])].reverse();
  return `<div class="payroll-workspace"><header class="page-heading"><div><p class="eyebrow">LÖN OCH PERSONAL</p><h1>Individuell lönehantering</h1><p>Granska underlaget per person, beräkna lönen och följ bokföring och utbetalning.</p></div><button type="button" class="button" data-action="new-employee">Ny anställd</button></header>
    <div class="demo-strip"><span><strong>Officiella skattetabeller för 2026.</strong> Tabell 29–42, lönekolumn 1/3 och månadsunderlag upp till 80 000 kr. Datum och födelseår styr arbetsgivaravgiften. Alla betalningar registreras endast i demon.</span></div>
    <section class="panel"><h2>1. Granska personernas lönevillkor</h2><p>Välj tabell enligt A-skattsedeln. Kontrollera frånvarovärde, semesterregel och saldo mot anställningsavtal.</p>${employees.map(employee => profileCard(state, employee)).join('')}${!employees.length ? '<p>Lägg upp en anställd för att börja.</p>' : ''}</section>
    ${annualContributionWorkspace(state, employees)}
    ${vacationWorkspace(state, employees)}
    <section class="panel"><h2>2. Förbered individuell lönekörning</h2>${form('create', `${field('Utbetalningsdag och bokföringsdatum', 'date', dateFor(state), 'date', 'required')}${employees.map(employee => personInput(state, employee)).join('')}<p class="muted">Sjuklön: 80 % av det granskade timvärdet, karens 20 % av en genomsnittlig veckas sjuklön, högst de första 14 kalenderdagarna. Förmåner och skattefria utlägg måste redan vara värderade och klassificerade. Extra engångsbelopp kan kräva särskilt skattebeslut.</p>${button('Beräkna individuella lönebesked')}`)}</section>
    <section class="payroll-batches"><h2>3. Granska lönebesked och bokför</h2>${batches.length ? batches.map(batch => batchCard(state, batch)).join('') : '<div class="panel"><p>Beräknade lönebesked visas här innan du bokför.</p></div>'}</section>
    ${recoveryWorkspace(state)}
    <details class="panel"><summary>Omfattning, källor och tidigare demokörningar</summary><p>Detta är ett utvecklat men avgränsat löneflöde. Semesterintjäning och stödda negativa rättelser genom bruttolöneåterkrav har egna spårbara flöden. Kollektivavtal, pension/försäkring, utlandssituationer och automatisk AGI-inlämning kräver ytterligare hantering. Gransknings-CSV är ingen myndighetsfil.</p><ul><li><a href="${PAYROLL_RULES.taxSource}" target="_blank" rel="noopener noreferrer">Skatteverket: officiella skattetabeller 2026</a></li><li><a href="${PAYROLL_RULES.contributionSource}" target="_blank" rel="noopener noreferrer">Skatteverket: arbetsgivaravgifter och ungdomsnedsättning</a></li><li><a href="${PAYROLL_RULES.vacationSource}" target="_blank" rel="noopener noreferrer">Semesterlagen</a></li></ul><p>${state.payrollRuns.length} tidigare demokörningar är bevarade. De är fortfarande del av huvudboken och hindrar dubbel ordinarie månadslön.</p>${state.payrollRuns.map(run => `<div class="payroll-legacy"><strong>${e(run.month)} · ${e(stateNames[run.status] ?? run.status)}</strong>${run.status === 'draft' ? form('discard-legacy', '<p>Det äldre utkastet använder manuella demovärden. Ta bort det om du vill göra månadens individuella lönekörning ovan.</p>' + button('Ta bort äldre obokfört utkast', 'button'), run.id) : '<p>Bokförd historik bevaras.</p>'}</div>`).join('')}</details>
  </div>`;
}

export function handleAction(state, action, data) {
  switch (action) {
    case 'annual-contribution-review': return reviewPayrollAnnualContributions(state,{employeeId:data.employeeId,year:2026,date:data.date,reference:data.reference,reviewed:yes(data.reviewed),finalBelowThreshold:yes(data.finalBelowThreshold)});
    case 'annual-contribution-settle': return settlePayrollContributionReview(state,data.id,{date:data.date,reference:data.reference,confirmed:yes(data.confirmed)});
    case 'vacation-year': return createVacationYear(state, { employeeId: data.employeeId, date: data.date, earningStart: data.earningStart, earningEnd: data.earningEnd, employmentStart: data.employmentStart, employmentEnd: data.employmentEnd, nonQualifyingDays: number(data.nonQualifyingDays), entitlementDays: number(data.entitlementDays), eligibleEarningsCents: amount(data.eligibleEarnings), carriedDays: number(data.carriedDays), carriedMoneyCents: amount(data.carriedMoney), carriedFromYear: number(data.carriedFromYear), method: data.method, percentBps: Math.round(number(data.percent) * 100), reference: data.reference, reviewed: yes(data.reviewed), qualifyingAbsenceReviewed: yes(data.qualifyingAbsenceReviewed) });
    case 'recovery': { const [component, taxClass] = String(data.category).split(':'); return createPayrollRecovery(state, { batchId: data.id, employeeId: data.employeeId, date: data.date, component, taxClass, grossCents: amount(data.gross), reason: data.reason, reference: data.reference, reviewed: yes(data.reviewed), agiCorrectionConfirmed: yes(data.agiCorrectionConfirmed) }); }
    case 'recovery-payment': return receivePayrollRecovery(state, data.id, { date: data.date, amountCents: amount(data.amount), reference: data.reference });
    case 'recovery-tax': return receivePayrollRecoveryTaxCredit(state, data.id, { date: data.date, reference: data.reference });
    case 'profile': return savePayrollProfile(state, { employeeId: data.employeeId, date: data.date, birthYear: number(data.birthYear), taxMode: data.taxMode, table: number(data.table), column: number(data.column), weeklyHoursHundredths: Math.round(number(data.weeklyHours) * 100), deductionHourlyCents: amount(data.deductionHourly), vacationMethod: data.vacationMethod, vacationSupplementBps: Math.round(number(data.vacationSupplement) * 100), vacationPercentBps: Math.round(number(data.vacationPercent) * 100), paidVacationDays: number(data.paidVacationDays), agreementNote: data.agreementNote, contributionAnnualExpectation:data.contributionAnnualExpectation, contributionAnnualReference:data.contributionAnnualReference, taxDecisionReference: data.taxDecisionReference, reviewed: yes(data.reviewed), domesticOrdinary: yes(data.domesticOrdinary) });
    case 'create': return createPayrollBatch(state, { date: data.date, people: state.employees.filter(employee => yes(data[`include:${employee.id}`])).map(employee => ({ employeeId: employee.id, kind: data[`kind:${employee.id}`], scheduledHoursHundredths: Math.round(number(data[`hours:${employee.id}`]) * 100), unpaidHoursHundredths: Math.round(number(data[`unpaid:${employee.id}`]) * 100), sickHoursHundredths: Math.round(number(data[`sick:${employee.id}`]) * 100), sickScheduledHoursHundredths: Math.round(number(data[`sickScheduled:${employee.id}`]) * 100), sickScheduleConfirmed: yes(data[`sickScheduleReviewed:${employee.id}`]), sickStart: data[`sickStart:${employee.id}`] ?? '', sickEnd: data[`sickEnd:${employee.id}`] ?? '', vacationDays: number(data[`vacationDays:${employee.id}`]), vacationYearId: data[`vacationYear:${employee.id}`] || undefined, vacationHoursHundredths: Math.round(number(data[`vacationHours:${employee.id}`] || '0') * 100), finalDailyCents: amount(data[`finalDaily:${employee.id}`]), finalCompensationReviewed: yes(data[`finalReviewed:${employee.id}`]), vacationBaseCents: amount(data[`vacationBase:${employee.id}`]), additionalGrossCents: amount(data[`extra:${employee.id}`]), extraTaxMode: data[`extraTaxMode:${employee.id}`] || 'periodic', vacationTaxMode: data[`vacationTaxMode:${employee.id}`] || 'periodic', annualSalaryCents: amount(data[`annualSalary:${employee.id}`]), annualSalaryReviewed: yes(data[`annualSalaryReviewed:${employee.id}`]), benefitCents: amount(data[`benefit:${employee.id}`]), reimbursementCents: amount(data[`reimbursement:${employee.id}`]), manualTaxCents: amount(data[`tax:${employee.id}`]), note: data[`note:${employee.id}`] ?? '' })) });
    case 'post': return postPayrollBatch(state, data.id, { reviewed: yes(data.reviewed) });
    case 'discard': return discardPayrollDraft(state, data.id);
    case 'discard-legacy': return discardLegacyPayrollDraft(state, data.id);
    case 'pay': return payPayrollBatch(state, data.id, { date: data.date });
    case 'settle-tax': return settlePayrollBatchTaxes(state, data.id, { date: data.date });
    case 'reverse': return reversePayrollBatch(state, data.id, { date: data.date, reason: data.reason });
    default: throw new Error('Okänd löneåtgärd.');
  }
}

function vacationWorkspace(state, employees) {
  const current = dateFor(state), year = Number(current.slice(0, 4));
  return `<section class="panel payroll-vacation"><header><h2>Semesterintjäning och semestersaldo</h2><p>Fastställ ett avslutat intjänandeår. Betalda dagar avrundas uppåt enligt anställningstid och semesterlönegrundande dagar; procentbelopp räknas från granskat löneunderlag.</p></header>
    <details><summary>Beräkna och fastställ semesterår</summary>${form('vacation-year', `<div class="payroll-form-grid">
      ${select('Anställd', 'employeeId', '', [['', 'Välj anställd'], ...employees.map(person => [person.id, person.name])])}
      ${field('Registreringsdatum', 'date', current, 'date', 'required')}
      ${field('Intjänandeår från', 'earningStart', `${year - 1}-04-01`, 'date', 'required')}
      ${field('Intjänandeår till', 'earningEnd', `${year}-03-31`, 'date', 'required')}
      ${field('Anställd från', 'employmentStart', `${year - 1}-04-01`, 'date', 'required')}
      ${field('Anställd till under intjänandeåret', 'employmentEnd', `${year}-03-31`, 'date', 'required')}
      ${field('Icke semesterlönegrundande kalenderdagar', 'nonQualifyingDays', 0, 'number', 'required min="0" max="366"')}
      ${field('Årlig semesterrätt, dagar', 'entitlementDays', 25, 'number', 'required min="25" max="50"')}
      ${select('Semesterregel enligt löneprofil', 'method', 'same-pay', [['same-pay', 'Sammalöneregel'], ['percentage', 'Procentregeln']])}
      ${field('Semesterlönegrundande lön, kr', 'eligibleEarnings', '0.00', 'text', 'inputmode="decimal"')}
      ${field('Semesterprocent', 'percent', '12.00', 'text', 'required inputmode="decimal"')}
      ${field('Ingående sparade dagar, granskat saldo', 'carriedDays', 0, 'number', 'required min="0" max="100"')}
      ${field('Sparat belopp, kr (procentregeln)', 'carriedMoney', '0.00', 'text', 'inputmode="decimal"')}
      ${field('Ursprungsår för sparade dagar', 'carriedFromYear', year - 1, 'number')}
      ${field('Underlags-/avtalsreferens', 'reference', '', 'text', 'required maxlength="250"')}
    </div><p class="muted">Icke semesterlönegrundande dagar måste särskiljas från semesterlönegrundande sjuk-/föräldraledighet. Löneunderlaget granskas mot löner, frånvaro och semesterregler; systemet gissar inte kollektivavtal. Sparade dagar ska ha ett gemensamt dokumenterat ursprungsår inom fem år.</p>
    ${checkbox('Jag har granskat anställningstid och semesterlönegrundande frånvaro.', 'qualifyingAbsenceReviewed')}
    ${checkbox('Jag har granskat semesterrätt, löneunderlag, sparade dagar och tillämplig regel.', 'reviewed')}${button('Fastställ semesterår')}`)}</details>
    <div class="payroll-vacation-balances">${(state.payrollVacationYears ?? []).map(year => {
      const balance = getVacationBalance(state, year.id), employee = state.employees.find(item => item.id === year.employeeId);
      return `<article class="payroll-vacation-balance"><h3>${e(employee?.name)}</h3><p>Uttagsår ${e(year.leaveStart)}–${e(year.leaveEnd)} · ${e(year.method === 'percentage' ? 'Procentregeln' : 'Sammalöneregeln')}</p><dl><div><dt>Semesterlönegrundande kalenderdagar</dt><dd>${e(year.qualifyingDays)} / ${e(year.yearDays)}</dd></div><div><dt>Intjänade + ingående sparade dagar</dt><dd>${e(year.earnedDays)} + ${e(year.carriedDays)}</dd></div><div><dt>Reserverade/uttagna dagar i lönebesked</dt><dd>${e(balance.usedDays)}</dd></div><div><dt>Kvarvarande dagar</dt><dd><strong>${e(balance.remainingDays)}</strong></dd></div>${year.method === 'percentage' ? `<div><dt>Intjänat och sparat semesterbelopp</dt><dd>${e(money(year.availableMoneyCents))}</dd></div><div><dt>Kvarvarande semesterbelopp</dt><dd>${e(money(balance.remainingMoneyCents))}</dd></div>` : ''}</dl><p class="muted">Underlag: ${e(year.reference)}. Välj detta semesterkonto på personens lönerad. Fastställt intjänande skrivs inte över.</p></article>`;
    }).join('') || '<p>Inga semesterår är fastställda ännu.</p>'}</div></section>`;
}

function recoveryForm(state, batch) {
  return `<details class="payroll-recovery-form"><summary>Rätta utbetald lön genom bruttolöneåterkrav</summary>${form('recovery', `<p>Originalets utbetalning och skatteavdrag bevaras. Ett granskat bruttokrav blir en separat fordran på den anställde och korrigerat underlag för ursprunglig AGI-period.</p><div class="payroll-form-grid">
    ${select('Anställd', 'employeeId', batch.people[0].employeeId, batch.people.map(person => [person.employeeId, person.name]))}
    ${field('Rättelsedatum', 'date', dateFor(state), 'date', 'required')}
    ${select('Felaktigt löneslag', 'category', 'salary:periodic', [['salary:periodic', 'Ordinarie/periodisk lön'], ['salary:one-off', 'Engångslön'], ['vacation:periodic', 'Semesterlön/tillägg'], ['vacation:one-off', 'Semesterersättning/engångsbelopp']])}
    ${field('Bruttobelopp att återkräva, kr', 'gross', '0.00', 'text', 'required inputmode="decimal"')}
    ${field('Orsak', 'reason', '', 'text', 'required maxlength="250"')}
    ${field('Unik krav-/underlagsreferens', 'reference', '', 'text', 'required maxlength="250"')}
  </div>${checkbox('Bruttokravet är granskat och beslutat; avdragen skatt återbetalas inte av arbetsgivaren.', 'reviewed')}${checkbox('Jag har granskat att inkomst och avgift ska rättas i ursprunglig AGI-period.', 'agiCorrectionConfirmed')}${button('Bokför separat bruttolöneåterkrav', 'button danger')}`, batch.id)}</details>`;
}

function recoveryWorkspace(state) {
  const records = state.payrollRecoveries ?? [];
  return `<section class="panel payroll-recoveries"><h2>Bruttolöneåterkrav och rättade perioder</h2><p>Återkrav skapas från den utbetalda lönekörningen ovan. Fordran, den anställdes inbetalningar och eventuell kreditering på skattekontot följs separat.</p>
    ${records.map(record => {
      const paid = record.payments.reduce((n, item) => n + item.amountCents, 0), remaining = record.grossCents - paid;
      return `<article class="payroll-recovery-card"><header><h3>${e(state.employees.find(item => item.id === record.employeeId)?.name)} · ${e(record.month)}</h3><span class="badge ${remaining ? 'draft' : 'paid'}">${remaining ? 'Fordran kvarstår' : 'Återbetalt'}</span></header>
        <p>${e(record.reason)} · Referens ${e(record.reference)}</p><div class="payroll-totals"><div><small>Bruttokrav</small><strong>${e(money(record.grossCents))}</strong></div><div><small>Inbetalt</small><strong>${e(money(paid))}</strong></div><div><small>Kvar på 1680</small><strong>${e(money(remaining))}</strong></div><div><small>Minskad arbetsgivaravgift</small><strong>${e(money(record.employerReductionCents))}</strong></div></div>
        <p class="muted">Avdragen skatt ändras inte. ${record.contributionHandling === 'reduce-unpaid' ? 'Avgiftsminskningen dras av från ännu inte reglerad arbetsgivaravgift.' : 'Avgiften var redan reglerad; registrera kreditering först när den syns på skattekontot.'}</p>
        ${remaining ? form('recovery-payment', `<div class="payroll-form-grid">${field('Datum för faktisk inbetalning', 'date', dateFor(state), 'date', 'required')}${field('Inbetalt belopp, kr', 'amount', rawMoney(remaining), 'text', 'required inputmode="decimal"')}${field('Unik betalningsreferens', 'reference', '', 'text', 'required maxlength="250"')}</div>${button('Registrera mottagen återbetalning', 'button')}`, record.id) : ''}
        ${record.contributionHandling === 'tax-credit' && record.employerReductionCents && !record.taxCredit ? form('recovery-tax', `<div class="payroll-form-grid">${field('Krediteringsdatum på skattekontot', 'date', dateFor(state), 'date', 'required')}${field('Besluts-/transaktionsreferens', 'reference', '', 'text', 'required maxlength="250"')}</div>${button('Registrera krediterad arbetsgivaravgift', 'button')}`, record.id) : ''}
        <p>${record.payments.length} registrerade inbetalningar. ${record.taxCredit ? `Avgiften krediterad ${e(record.taxCredit.date)}.` : ''}</p>
      </article>`;
    }).join('') || '<p>Inga bruttolöneåterkrav har registrerats.</p>'}
    ${[...new Set(records.map(item => item.month))].map(month => `<details><summary>Rättat AGI-underlag ${e(month)}</summary><table><thead><tr><th>Anställd</th><th>Kontant brutto</th><th>Förmån</th><th>Avdragen skatt</th><th>Arbetsgivaravgift</th></tr></thead><tbody>${getPayrollDeclarationPeople(state, month).map(row => `<tr><td>${e(state.employees.find(item => item.id === row.employeeId)?.name)}</td><td>${e(money(row.grossCents))}</td><td>${e(money(row.benefitCents))}</td><td>${e(money(row.withholdingCents))}</td><td>${e(money(row.employerCents))}</td></tr>`).join('')}</tbody></table></details>`).join('')}
    <p><a href="${e(PAYROLL_RULES.recoverySource)}" target="_blank" rel="noopener noreferrer">Skatteverket: rätta arbetsgivardeklaration ↗</a></p></section>`;
}


function annualContributionWorkspace(state,employees) {
  return `<section class="panel"><h2>Årsgräns och arbetsgivaravgifter</h2><p>Faktisk ersättning från detta bolag räknas per person och kalenderår, inklusive skattepliktiga förmåner. Under 1 000 kr är ersättningen avgiftsfri. När gränsen nås tas tidigare avgiftsfri ersättning med i periodens underlag (AGI 010, 011/012). Tidigare perioder behåller 131/132. Årsprognosen används separat för skatteavdrag. Skattefria utlägg ingår inte.</p><p class="muted">Nya och uppdaterade löneprofiler använder årsregeln. Äldre bokförda löner bevaras; vid avstämning kan deras avgifter korrigeras separat utan att originalet ändras. Belopp under 100 kr har särskilda uppgiftsregler; granska om uppgift ska lämnas som AGI eller kontrolluppgift.</p>${employees.map(employee=>{
    const review=getPayrollAnnualContributionReview(state,employee.id),last=review.latest;
    if(!review.events.length)return '';
    const records=review.history.map(item=>`<li>${e(item.date)} · ${e(item.reference)} · avgiftsdifferens ${e(money(item.deltaCents))}${item.deltaCents&&!item.settlement?form('annual-contribution-settle',`${field('Faktiskt datum på skattekontot','date',dateFor(state),'date','required')}${field('Skattekontoreferens','reference','','text','required maxlength="250"')}${checkbox('Jag har stämt av faktisk betalning eller kreditering på skattekontot.','confirmed')}${button(item.deltaCents>0?'Registrera betalad avgiftsdifferens':'Registrera krediterad avgiftsdifferens','button')}`,item.id):item.settlement?' · Reglerad på skattekontot':''}</li>`).join('');
    return `<details class="payroll-person-card"><summary><strong>${e(employee.name)}</strong><span>${e(money(review.annualTaxableCents))} under 2026${last&&!review.current?' · Ny avstämning krävs':''}</span></summary>${form('annual-contribution-review',`<input type="hidden" name="employeeId" value="${e(employee.id)}"><div class="payroll-form-grid">${field('Avstämningsdatum','date',dateFor(state),'date','required')}${field('Granskat årsunderlag / referens','reference','','text','required maxlength="250"')}</div>${checkbox('Slutlig årsbedömning: årets samlade ersättning stannar under 1 000 kr.','finalBelowThreshold')}${checkbox('Jag har granskat årets utbetalningar, förmåner, återkrav och berörda AGI-perioder.','reviewed')}${button('Bokför separat årsavstämning','button')}`)}${last?`<p>Senaste granskning ${e(last.date)}. AGI-underlaget visar de aktuella periodbeloppen. Redan sparade deklarationer behöver en ny version när underlaget ändras.</p><details><summary>Spårbar avstämningshistorik</summary><ul>${records}</ul></details>`:'<p>Gör en årsavstämning för att få granskat AGI-underlag för äldre löner.</p>'}</details>`;
  }).join('')}</section>`;
}
