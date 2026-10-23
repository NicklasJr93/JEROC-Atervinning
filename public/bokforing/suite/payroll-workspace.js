import { cents, toCents } from './core.js';
import { createPayrollBatch, discardPayrollDraft, discardLegacyPayrollDraft, getPayrollBatchTotals, payPayrollBatch, payrollReviewCsv, PAYROLL_RULES, postPayrollBatch, reversePayrollBatch, savePayrollProfile, settlePayrollBatchTaxes } from './payroll-engine.js';

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
      ${field('Avtal/rutin som styr timvärde och semester', 'agreementNote', profile?.agreementNote ?? '', 'text', 'required maxlength="250"')}
    </div>
    <p class="muted">Timvärdet ovan är ett förslag tills du har granskat det mot anställningsvillkoren. Semestersaldot anges från granskat underlag; intjäning och alla kollektivavtal beräknas inte automatiskt.</p>
    ${checkbox('Vanlig svensk anställning och årsersättning över avgiftsgränsen; inga särskilda nedsättningar utöver ålder/ungdom gäller.', 'domesticOrdinary', false)}
    ${checkbox('Jag har granskat A-skattsedel, födelseår, timvärde, semesterregel och underlag.', 'reviewed', false)}
    ${button('Spara granskad löneprofil')}`, employee.id)}</details>`;
}

function personInput(state, employee) {
  const profile = (state.payrollProfiles ?? []).find(item => item.employeeId === employee.id);
  return `<details class="payroll-person-card" ${profile ? '' : 'open'}><summary>${checkbox(employee.name, `include:${employee.id}`)}<span>${e(money(employee.baseCents))} / ${employee.payType === 'hourly' ? 'timme' : 'månad'}</span></summary>
    ${!profile ? '<p class="payroll-warning">Spara en granskad löneprofil ovan innan denna person kan ingå.</p>' : ''}
    <div class="payroll-form-grid">
      ${select('Lönetyp i körningen', `kind:${employee.id}`, 'regular', [['regular', 'Ordinarie lön'], ['supplement', 'Kompletterande lön efter ordinarie körning']])}
      ${field('Schemalagda timmar', `hours:${employee.id}`, 160, 'number', 'min="0.01" max="744" step="0.01"')}
      ${field('Obetald frånvaro, timmar', `unpaid:${employee.id}`, 0, 'number', 'min="0" max="744" step="0.01"')}
      ${field('Sjukfrånvaro, timmar', `sick:${employee.id}`, 0, 'number', 'min="0" max="744" step="0.01"')}
      ${field('Schemalagda timmar under sjukperioden', `sickScheduled:${employee.id}`, 0, 'number', 'min="0" max="336" step="0.01"')}
      ${field('Sjukperiodens första dag', `sickStart:${employee.id}`, '', 'date')}
      ${field('Sjukfrånvarons sista dag i denna körning', `sickEnd:${employee.id}`, '', 'date')}
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
  const source = batch.people.find(person => person.tax.sourceUrl)?.tax.sourceUrl;
  const createDate = field('Datum', 'date', batch.date, 'date', 'required');
  const actions = batch.status === 'draft' ? `${form('post', `${checkbox('Jag har granskat varje person, skatteavdrag, frånvaro och förmåner.', 'reviewed')}${button('Bokför granskad lön')}`, batch.id)}${form('discard', button('Ta bort obokfört utkast', 'button'), batch.id)}`
    : batch.status === 'posted' ? `${form('pay', `${createDate}${button('Registrera nettolöneutbetalning')}`, batch.id)}<details><summary>Rätta obetald lönekörning</summary>${form('reverse', `${createDate}${field('Orsak till rättelse', 'reason', '', 'text', 'required maxlength="250"')}${button('Skapa länkad återföring', 'button danger')}`, batch.id)}</details>`
      : batch.status === 'paid' && !batch.taxSettlement ? form('settle-tax', `${field('Datum på skattekontot', 'date', batch.date, 'date', 'required')}${button('Registrera skatt och avgifter mot skattekontot', 'button')}`, batch.id) : '';
  return `<section class="panel payroll-batch"><header class="payroll-batch-header"><div><h2>Lön ${e(batch.month)}</h2><p>${e(batch.id)} · Utbetalningsdag ${e(batch.date)}</p></div><span class="badge ${batch.status === 'paid' ? 'paid' : 'draft'}">${e(stateNames[batch.status])}</span></header>
    <div class="payroll-totals"><div><small>Bruttolön</small><strong>${e(money(totals.grossCents))}</strong></div><div><small>Avdragen skatt</small><strong>${e(money(totals.withholdingCents))}</strong></div><div><small>Arbetsgivaravgifter</small><strong>${e(money(totals.employerCents))}</strong></div><div><small>Nettolön inklusive utlägg</small><strong>${e(money(totals.netCents))}</strong></div></div>
    ${batch.people.map(person => `<details class="payroll-slip" open><summary><strong>${e(person.name)}</strong><span>${e(money(person.netCents))} att betala</span></summary>
      <dl><div><dt>Lön före frånvaro och tillägg</dt><dd>${e(money(person.input.kind === 'supplement' ? 0 : person.employee.payType === 'hourly' ? Math.round(person.employee.baseCents * person.input.scheduledHoursHundredths / 100) : person.employee.baseCents))}</dd></div><div><dt>Frånvaroavdrag</dt><dd>−${e(money(person.absenceDeductionCents))}</dd></div><div><dt>Sjuklön före karens</dt><dd>${e(money(person.sickPayCents))}</dd></div><div><dt>Karensavdrag</dt><dd>−${e(money(person.karensCents))}</dd></div><div><dt>Semesterlön/-tillägg</dt><dd>${e(money(person.vacationPayCents))}</dd></div><div><dt>Förmån, ingår i skatteunderlaget</dt><dd>${e(money(person.benefitCents))}</dd></div><div><dt>Bruttolön</dt><dd>${e(money(person.grossCents))}</dd></div><div><dt>Avdragen skatt</dt><dd>−${e(money(person.withholdingCents))}</dd></div><div><dt>Skattefria utlägg</dt><dd>${e(money(person.reimbursementCents))}</dd></div><div><dt>Att betala</dt><dd><strong>${e(money(person.netCents))}</strong></dd></div></dl>
      <p class="muted">${person.tax.sourceUrl ? `Tabell ${e(person.tax.table)}, kolumn ${e(person.tax.column)}, underlagsintervall ${e(person.tax.band.join('–'))} kr.` : `Individuellt skattebeslut: ${e(person.tax.decisionReference)}`} Avgiftsregel: ${e(person.employer.classification)}.</p>${person.tax.oneOff ? `<p class="muted">Engångsbelopp ${e(money(person.oneOffCents))}: ${e(person.tax.oneOff.ratePercent)} % enligt granskad årslön ${e(money(person.tax.oneOff.annualSalaryCents))}. Skatteavdrag ${e(money(person.tax.oneOff.taxCents))}. <a href="${e(PAYROLL_RULES.oneOffSource)}" target="_blank" rel="noopener noreferrer">Engångstabell ↗</a></p>` : ''}
      ${person.unwithheldTaxCents ? `<p class="payroll-warning">${e(money(person.unwithheldTaxCents))} av den beräknade skatten ryms inte i kontantlönen. Granska hanteringen innan du bokför.</p>` : ''}
      ${person.input.note ? `<p>${e(person.input.note)}</p>` : ''}</details>`).join('')}
    ${batch.reversal ? `<p class="payroll-warning">Återförd ${e(batch.reversal.date)}: ${e(batch.reversal.reason)}. Originalverifikationen finns kvar.</p>` : ''}
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
    <section class="panel"><h2>2. Förbered individuell lönekörning</h2>${form('create', `${field('Utbetalningsdag och bokföringsdatum', 'date', dateFor(state), 'date', 'required')}${employees.map(employee => personInput(state, employee)).join('')}<p class="muted">Sjuklön: 80 % av det granskade timvärdet, karens 20 % av en genomsnittlig veckas sjuklön, högst de första 14 kalenderdagarna. Förmåner och skattefria utlägg måste redan vara värderade och klassificerade. Extra engångsbelopp kan kräva särskilt skattebeslut.</p>${button('Beräkna individuella lönebesked')}`)}</section>
    <section class="payroll-batches"><h2>3. Granska lönebesked och bokför</h2>${batches.length ? batches.map(batch => batchCard(state, batch)).join('') : '<div class="panel"><p>Beräknade lönebesked visas här innan du bokför.</p></div>'}</section>
    <details class="panel"><summary>Omfattning, källor och tidigare demokörningar</summary><p>Detta är ett utvecklat men avgränsat löneflöde. Kollektivavtal, semesterintjäning, pension/försäkring, utlandssituationer, AGI-inlämning och negativa rättelser efter utbetalning återstår. Gransknings-CSV är ingen myndighetsfil.</p><ul><li><a href="${PAYROLL_RULES.taxSource}" target="_blank" rel="noopener noreferrer">Skatteverket: officiella skattetabeller 2026</a></li><li><a href="${PAYROLL_RULES.contributionSource}" target="_blank" rel="noopener noreferrer">Skatteverket: arbetsgivaravgifter och ungdomsnedsättning</a></li><li><a href="${PAYROLL_RULES.vacationSource}" target="_blank" rel="noopener noreferrer">Semesterlagen</a></li></ul><p>${state.payrollRuns.length} tidigare demokörningar är bevarade. De är fortfarande del av huvudboken och hindrar dubbel ordinarie månadslön.</p>${state.payrollRuns.map(run => `<div class="payroll-legacy"><strong>${e(run.month)} · ${e(stateNames[run.status] ?? run.status)}</strong>${run.status === 'draft' ? form('discard-legacy', '<p>Det äldre utkastet använder manuella demovärden. Ta bort det om du vill göra månadens individuella lönekörning ovan.</p>' + button('Ta bort äldre obokfört utkast', 'button'), run.id) : '<p>Bokförd historik bevaras.</p>'}</div>`).join('')}</details>
  </div>`;
}

export function handleAction(state, action, data) {
  switch (action) {
    case 'profile': return savePayrollProfile(state, { employeeId: data.employeeId, date: data.date, birthYear: number(data.birthYear), taxMode: data.taxMode, table: number(data.table), column: number(data.column), weeklyHoursHundredths: Math.round(number(data.weeklyHours) * 100), deductionHourlyCents: amount(data.deductionHourly), vacationMethod: data.vacationMethod, vacationSupplementBps: Math.round(number(data.vacationSupplement) * 100), vacationPercentBps: Math.round(number(data.vacationPercent) * 100), paidVacationDays: number(data.paidVacationDays), agreementNote: data.agreementNote, taxDecisionReference: data.taxDecisionReference, reviewed: yes(data.reviewed), domesticOrdinary: yes(data.domesticOrdinary) });
    case 'create': return createPayrollBatch(state, { date: data.date, people: state.employees.filter(employee => yes(data[`include:${employee.id}`])).map(employee => ({ employeeId: employee.id, kind: data[`kind:${employee.id}`], scheduledHoursHundredths: Math.round(number(data[`hours:${employee.id}`]) * 100), unpaidHoursHundredths: Math.round(number(data[`unpaid:${employee.id}`]) * 100), sickHoursHundredths: Math.round(number(data[`sick:${employee.id}`]) * 100), sickScheduledHoursHundredths: Math.round(number(data[`sickScheduled:${employee.id}`]) * 100), sickScheduleConfirmed: yes(data[`sickScheduleReviewed:${employee.id}`]), sickStart: data[`sickStart:${employee.id}`] ?? '', sickEnd: data[`sickEnd:${employee.id}`] ?? '', vacationDays: number(data[`vacationDays:${employee.id}`]), vacationBaseCents: amount(data[`vacationBase:${employee.id}`]), additionalGrossCents: amount(data[`extra:${employee.id}`]), extraTaxMode: data[`extraTaxMode:${employee.id}`] || 'periodic', vacationTaxMode: data[`vacationTaxMode:${employee.id}`] || 'periodic', annualSalaryCents: amount(data[`annualSalary:${employee.id}`]), annualSalaryReviewed: yes(data[`annualSalaryReviewed:${employee.id}`]), benefitCents: amount(data[`benefit:${employee.id}`]), reimbursementCents: amount(data[`reimbursement:${employee.id}`]), manualTaxCents: amount(data[`tax:${employee.id}`]), note: data[`note:${employee.id}`] ?? '' })) });
    case 'post': return postPayrollBatch(state, data.id, { reviewed: yes(data.reviewed) });
    case 'discard': return discardPayrollDraft(state, data.id);
    case 'discard-legacy': return discardLegacyPayrollDraft(state, data.id);
    case 'pay': return payPayrollBatch(state, data.id, { date: data.date });
    case 'settle-tax': return settlePayrollBatchTaxes(state, data.id, { date: data.date });
    case 'reverse': return reversePayrollBatch(state, data.id, { date: data.date, reason: data.reason });
    default: throw new Error('Okänd löneåtgärd.');
  }
}
