// Multi-year bookkeeping keeps one immutable journal. Opening balances are
// views over prior entries, never duplicate postings of the same assets/debts.
import { ACCOUNTS, assert, cents, validDate, transact, appendEntry, addActivity, nextId } from './core.js';
import { closeYear, getCloseChecklist } from './finance.js';
import { getYearReports } from './fiscal-reports.js';
export { getYearReports } from './fiscal-reports.js';
import { fiscalPeriods, fiscalPeriodForDate, currentYearClosure, nextCalendarDate, defaultNextYearEnd } from './fiscal-periods.js';

const clone = value => structuredClone(value);
const sum = values => values.reduce((total, value) => { assert(Number.isSafeInteger(value) && Number.isSafeInteger(total + value), 'Årssumman är för stor.'); return total + value; }, 0);
const text = (value, label, max = 1000, optional = false) => { assert(typeof value === 'string' && value.length <= max && (optional || value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), `${label} saknas eller är ogiltig.`); return value.trim(); };
const boundedSigned = value => { assert(Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000_000, 'Beloppet måste vara hela ören.'); return value; };
const periodKey = (start, end) => `${start}/${end}`;
const rowsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const debit = (account, amount) => ({ account, debitCents: amount, creditCents: 0 });
const credit = (account, amount) => ({ account, debitCents: 0, creditCents: amount });
const financialReportSignature = report => JSON.stringify({
  ...Object.fromEntries(['start', 'end', 'revenueCents', 'expenseCents', 'resultCents', 'unallocatedResultCents', 'assetsCents', 'liabilitiesEquityCents', 'bankCents', 'receivablesCents', 'payablesCents', 'balanced'].map(key => [key, report[key]])),
  accounts: report.accounts.filter(account => ['debitCents', 'creditCents', 'openingCents', 'periodDebitCents', 'periodCreditCents'].some(key => account[key] !== 0))
    .map(account => Object.fromEntries(['number', 'debitCents', 'creditCents', 'balanceCents', 'openingCents', 'periodDebitCents', 'periodCreditCents'].map(key => [key, account[key]])))
    .sort((a, b) => a.number.localeCompare(b.number)),
});


function archiveSnapshot(state, closure) {
  const start = closure.fiscalYearStart; const end = closure.fiscalYearEnd;
  const report = getYearReports(state, { start, end });
  const onOrBefore = record => !record.date || record.date <= end;
  return {
    version: 1, company: clone(state.company), start, end, closure: clone(closure),
    report, entries: clone(state.entries.filter(entry => entry.date >= start && entry.date <= end)),
    lockedPeriods: [...state.lockedPeriods],
    invoices: clone(state.invoices.filter(onOrBefore)), bills: clone(state.bills.filter(onOrBefore)),
    assets: clone(state.assets.filter(onOrBefore)), accruals: clone(state.accruals.filter(onOrBefore)),
    inventoryItems: clone(state.inventoryItems), vatReturns: clone(state.vatReturns.filter(onOrBefore)),
    payrollRuns: clone(state.payrollRuns.filter(onOrBefore)),
    extensions: Object.fromEntries(['taxTransactions', 'rotPlans', 'rotApplications', 'rotRepayments', 'payrollProfiles', 'payrollBatches', 'settlements',
      'commercialArticles', 'commercialPrices', 'commercialInvoiceOrigins', 'recurringPlans', 'commercialReminders', 'projectStockLinks', 'revenueSchedules', 'projectWorkpapers']
      .filter(key => Array.isArray(state[key])).map(key => [key, clone(state[key].filter(onOrBefore))])),
    workpapers: clone((state.yearWorkpapers ?? []).filter(item => item.fiscalYearStart === start && item.fiscalYearEnd === end)),
  };
}

export function validateFiscalYears(state) {
  const claimedEntryIds = [];
  if (state.fiscalYears === undefined) return claimedEntryIds;
  assert(Array.isArray(state.fiscalYears) && state.fiscalYears.length >= 2 && state.fiscalYears.length <= 100, 'Räkenskapsårens historik är ogiltig.');
  const seen = new Set();
  state.fiscalYears.forEach((period, index) => {
    assert(period && validDate(period.start) && validDate(period.end) && period.start <= period.end && ['open', 'closed'].includes(period.status), 'Räkenskapsårets uppgifter är ogiltiga.');
    assert(period.id === `fy-${period.start}-${period.end}` && !seen.has(period.id), 'Räkenskapsåret har fel eller dubblerad identifierare.');
    seen.add(period.id);
    assert(['month', 'quarter', 'year'].includes(period.vatPeriod), 'Räkenskapsårets momsperiod saknas.');
    if (index) assert(period.start === nextCalendarDate(state.fiscalYears[index - 1].end), 'Räkenskapsåren ska följa utan glapp eller överlapp.');
    const isActive = index === state.fiscalYears.length - 1;
    if (isActive) assert(period.start === state.company.fiscalYearStart && period.end === state.company.fiscalYearEnd, 'Aktivt räkenskapsår stämmer inte med företaget.');
    else assert(period.status === 'closed', 'Ett historiskt räkenskapsår måste vara avslutat.');
    const closure = state.yearClosures.find(item => item.fiscalYearStart === period.start && item.fiscalYearEnd === period.end);
    if (period.status === 'closed') {
      assert(closure && closure.id === period.closureId && period.snapshot && typeof period.snapshotJson === 'string', 'Årsarkivets bokslut eller frysta underlag saknas.');
      assert(JSON.stringify(period.snapshot) === period.snapshotJson, 'Årsarkivets frysta underlag har ändrats.');
      assert(period.snapshot.start === period.start && period.snapshot.end === period.end && rowsEqual(period.snapshot.closure, closure), 'Årsarkivets avgränsning eller bokslut har ändrats.');
      assert(rowsEqual(period.snapshot.entries, state.entries.filter(entry => entry.date >= period.start && entry.date <= period.end)), 'En bokförd post i ett avslutat år har ändrats eller tillkommit.');
      assert(financialReportSignature(period.snapshot.report) === financialReportSignature(getYearReports(state, { start: period.start, end: period.end })), 'Årsarkivets rapport stämmer inte med historisk huvudbok.');
    } else assert(!period.snapshot && !period.snapshotJson && !period.closureId && (!closure || isActive), 'Ett öppet räkenskapsår får inte ha ett slutligt årsarkiv.');
    if (index && period.resultTransferEntryId) {
      const prior = state.fiscalYears[index - 1]; const oldClosure = state.yearClosures.find(item => item.id === prior.closureId);
      const result = oldClosure.resultCents;
      assert(result !== 0, 'En överföring av nollresultat ska inte bokföras.');
      const entry = state.entries.find(item => item.id === period.resultTransferEntryId);
      assert(entry && entry.sourceType === 'year-result-transfer' && entry.sourceId === oldClosure.id && entry.date === period.start,
        'Överföring av föregående års resultat saknar korrekt verifikation.');
      const expected = result > 0 ? [debit('2099', result), credit('2098', result)] : [debit('2098', -result), credit('2099', -result)];
      assert(rowsEqual(entry.rows, expected), 'Överföringen av föregående års resultat stämmer inte med bokslutet.');
      claimedEntryIds.push(entry.id);
    } else if (index) {
      const oldClosure = state.yearClosures.find(item => item.id === state.fiscalYears[index - 1].closureId);
      assert(oldClosure.resultCents === 0, 'Föregående års resultat saknar överföring.');
    }
  });
  assert(state.yearClosures.every(closure => state.fiscalYears.some(period => closure.fiscalYearStart === period.start && closure.fiscalYearEnd === period.end)), 'Ett bokslut saknar räkenskapsår.');
  return claimedEntryIds;
}

export function openNextYear(state, { start = nextCalendarDate(state.company.fiscalYearEnd), end = defaultNextYearEnd(start), confirmed = false } = {}) {
  assert(confirmed === true, 'Bekräfta att du vill öppna nästa år och bevara det avslutade årets historik.');
  const closure = currentYearClosure(state);
  assert(closure, 'Avsluta det aktuella räkenskapsåret innan nästa år öppnas.');
  assert(validDate(start) && validDate(end) && start === nextCalendarDate(closure.fiscalYearEnd) && start <= end, 'Nästa år ska börja dagen efter det avslutade året.');
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1;
  const maximumEnd = new Date(`${start}T00:00:00Z`); maximumEnd.setUTCMonth(maximumEnd.getUTCMonth() + 18); maximumEnd.setUTCDate(maximumEnd.getUTCDate() - 1);
  assert(days >= 28 && end <= maximumEnd.toISOString().slice(0, 10), 'Ett nytt räkenskapsår ska omfatta minst 28 dagar och högst 18 månader i denna arbetsyta.');
  if (state.fiscalYears !== undefined) validateFiscalYears(state);
  const snapshot = archiveSnapshot(state, closure);
  return transact(state, draft => {
    const old = { id: `fy-${closure.fiscalYearStart}-${closure.fiscalYearEnd}`, start: closure.fiscalYearStart, end: closure.fiscalYearEnd, status: 'closed',
      vatPeriod: state.company.vatPeriod, closureId: closure.id, snapshot, snapshotJson: JSON.stringify(snapshot) };
    const previous = draft.fiscalYears ? draft.fiscalYears.slice(0, -1) : [];
    const existingCurrent = draft.fiscalYears?.at(-1);
    if (existingCurrent?.resultTransferEntryId) old.resultTransferEntryId = existingCurrent.resultTransferEntryId;
    const next = { id: `fy-${start}-${end}`, start, end, status: 'open', vatPeriod: state.company.vatPeriod };
    draft.fiscalYears = [...previous, old, next];
    draft.company.fiscalYearStart = start; draft.company.fiscalYearEnd = end;
    draft.lockedPeriods = [];
    if (closure.resultCents) {
      const result = closure.resultCents;
      const entry = appendEntry(draft, { date: start, description: 'Föregående års resultat, i avvaktan på resultatdisposition', sourceType: 'year-result-transfer', sourceId: closure.id,
        rows: result > 0 ? [debit('2099', result), credit('2098', result)] : [debit('2098', -result), credit('2099', -result)] });
      next.resultTransferEntryId = entry.id;
    }
    addActivity(draft, `Räkenskapsår ${start}–${end} öppnat. Föregående år bevarat; reskontra, tillgångar och planer fortsätter.`, next.id);
  });
}

const CATEGORIES = new Set(['bank', 'receivables', 'payables', 'vat', 'payroll', 'assets', 'inventory', 'accruals', 'tax', 'equity', 'annual-report', 'other']);
const STATUSES = new Set(['draft', 'prepared', 'reviewed']);

export function saveYearWorkpaper(state, payload) {
  return transact(state, draft => {
    const start = payload.fiscalYearStart ?? draft.company.fiscalYearStart;
    const end = payload.fiscalYearEnd ?? draft.company.fiscalYearEnd;
    assert(start === draft.company.fiscalYearStart && end === draft.company.fiscalYearEnd && !currentYearClosure(draft), 'Bokslutsbilagor i avslutade år bevaras och kan inte skrivas om.');
    assert(CATEGORIES.has(payload.category), 'Välj område för bokslutsbilagan.');
    const title = text(payload.title, 'Rubrik', 160);
    const status = payload.status ?? 'draft'; assert(STATUSES.has(status), 'Välj en giltig granskningsstatus.');
    const preparedBy = text(payload.preparedBy ?? '', 'Upprättad av', 100, status === 'draft');
    const reviewedBy = text(payload.reviewedBy ?? '', 'Granskad av', 100, status !== 'reviewed');
    const note = text(payload.note ?? '', 'Kommentar', 6000, true);
    const evidence = text(payload.evidence ?? '', 'Underlagsreferens', 1000, true);
    if (status === 'reviewed') assert(preparedBy && reviewedBy && preparedBy !== reviewedBy && evidence, 'Granskad bilaga kräver olika upprättare/granskare och en underlagsreferens. Namnen är angivna demouppgifter.');
    const account = payload.account ?? '';
    assert(account === '' || ACCOUNTS.some(item => item.number === account), 'Välj ett giltigt konto.');
    const report = getYearReports(draft);
    const balanceCents = account ? report.accounts.find(item => item.number === account).balanceCents : null;
    draft.yearWorkpapers ??= [];
    const current = payload.id ? draft.yearWorkpapers.find(item => item.id === payload.id) : null;
    if (payload.id) assert(current && current.fiscalYearStart === start && current.fiscalYearEnd === end, 'Bokslutsbilagan finns inte i aktuellt år.');
    const revision = { at: new Date().toISOString(), title, category: payload.category, status, preparedBy, reviewedBy, note, evidence, account, balanceCents };
    if (current) { current.revisions.push(revision); Object.assign(current, revision); }
    else draft.yearWorkpapers.push({ id: nextId(draft, 'workpaper'), fiscalYearStart: start, fiscalYearEnd: end, ...revision, revisions: [clone(revision)] });
    addActivity(draft, `Bokslutsbilaga ${title}: ${status === 'reviewed' ? 'markerad granskad' : status === 'prepared' ? 'upprättad' : 'utkast'}. Namn är demouppgifter.`, current?.id ?? draft.yearWorkpapers.at(-1).id);
  });
}

export function validateYearWorkpapers(state) {
  if (state.yearWorkpapers === undefined) return;
  assert(Array.isArray(state.yearWorkpapers) && state.yearWorkpapers.length <= 5000, 'Bokslutsbilagorna har fel format.');
  const ids = new Set();
  for (const paper of state.yearWorkpapers) {
    assert(paper && typeof paper.id === 'string' && !ids.has(paper.id), 'Bokslutsbilagan har fel eller dubblerat ID.'); ids.add(paper.id);
    assert(fiscalPeriods(state).some(period => period.start === paper.fiscalYearStart && period.end === paper.fiscalYearEnd), 'Bokslutsbilagan tillhör ett okänt räkenskapsår.');
    assert(CATEGORIES.has(paper.category) && STATUSES.has(paper.status), 'Bokslutsbilagans område eller status är ogiltig.');
    text(paper.title, 'Bilagans rubrik', 160); text(paper.note, 'Kommentar', 6000, true); text(paper.evidence, 'Underlagsreferens', 1000, true);
    assert(Array.isArray(paper.revisions) && paper.revisions.length > 0 && rowsEqual(paper.revisions.at(-1), Object.fromEntries(['at', 'title', 'category', 'status', 'preparedBy', 'reviewedBy', 'note', 'evidence', 'account', 'balanceCents'].map(key => [key, paper[key]]))), 'Bokslutsbilagans ändringshistorik stämmer inte.');
    for (const revision of paper.revisions) {
      assert(Number.isFinite(Date.parse(revision.at)) && CATEGORIES.has(revision.category) && STATUSES.has(revision.status), 'Bokslutsbilagans historik är ogiltig.');
      text(revision.title, 'Bilagans rubrik', 160); text(revision.note, 'Kommentar', 6000, true); text(revision.evidence, 'Underlagsreferens', 1000, true);
      text(revision.preparedBy, 'Upprättare', 100, revision.status === 'draft'); text(revision.reviewedBy, 'Granskare', 100, revision.status !== 'reviewed');
      assert(revision.account === '' ? revision.balanceCents === null : ACCOUNTS.some(item => item.number === revision.account) && Number.isSafeInteger(revision.balanceCents), 'Bilagans kontosaldo är ogiltigt.');
      if (revision.status === 'reviewed') assert(revision.preparedBy !== revision.reviewedBy && revision.evidence, 'Granskad bilaga saknar separat granskare eller underlag.');
    }
  }
}

export function closeReviewedYear(state, payload) {
  const papers = (state.yearWorkpapers ?? []).filter(paper => paper.fiscalYearStart === state.company.fiscalYearStart && paper.fiscalYearEnd === state.company.fiscalYearEnd);
  assert(papers.every(paper => paper.status === 'reviewed'), 'Färdigställ och granska årets skapade bokslutsbilagor före årsavslut.');
  const report = getYearReports(state);
  assert(papers.every(paper => !paper.account || report.accounts.find(account => account.number === paper.account)?.balanceCents === paper.balanceCents),
    'Ett granskat kontosaldo har ändrats. Uppdatera och granska bokslutsbilagan igen.');
  return closeYear(state, { date: state.company.fiscalYearEnd, confirmed: payload.confirmed === true });
}

export function prepareCorporateTax(state, { additionsCents = 0, deductionsCents = 0, priorLossCents = 0, assessmentNote = '' } = {}) {
  cents(additionsCents); cents(deductionsCents); cents(priorLossCents);
  const report = getYearReports(state);
  const postedTaxCents = sum(state.entries.filter(entry => entry.date >= report.start && entry.date <= report.end).flatMap(entry => entry.rows.filter(row => row.account === '8910').map(row => row.debitCents - row.creditCents)));
  const resultBeforeTaxCents = boundedSigned(report.resultCents + postedTaxCents);
  const adjustedCents = boundedSigned(resultBeforeTaxCents + additionsCents - deductionsCents);
  const usedLossCents = Math.min(Math.max(0, adjustedCents), priorLossCents);
  const taxableCents = Math.max(0, adjustedCents - usedLossCents);
  // A preparation calculation, not a determination of deductible losses or an INK2 file.
  const roundedTaxableCents = Math.floor(taxableCents / 100) * 100;
  const estimatedTaxCents = Math.floor((roundedTaxableCents * 2060 / 10000) / 100) * 100;
  return { fiscalYearStart: report.start, fiscalYearEnd: report.end, resultBeforeTaxCents, additionsCents, deductionsCents, priorLossCents, usedLossCents,
    taxableCents: roundedTaxableCents, estimatedTaxCents, rateBps: 2060, assessmentNote: text(assessmentNote, 'Bedömning', 6000, true),
    status: 'review-workpaper', note: 'Beräkningsunderlag för svenskt aktiebolag. Skattemässiga justeringar och rätt till underskottsavdrag måste granskas; ingen INK2-fil eller inlämning.' };
}

export function annualReportDraft(state, options = {}) {
  const start = options.start ?? state.company.fiscalYearStart; const end = options.end ?? state.company.fiscalYearEnd;
  const archived = fiscalPeriods(state).find(period => period.start === start && period.end === end)?.snapshot;
  const report = getYearReports(state, { start, end });
  const prior = fiscalPeriods(state).find(period => period.end < start && nextCalendarDate(period.end) === start);
  const previous = prior ? getYearReports(state, prior) : null;
  const nonzeroAccounts = report.accounts.filter(account => /^[12]/.test(account.number) && account.balanceCents !== 0).map(account => ({ account: account.number, name: account.name, balanceCents: account.balanceCents }));
  return { kind: 'Årsredovisningsunderlag – utkast för granskning', company: clone(archived?.company ?? state.company), fiscalYearStart: start, fiscalYearEnd: end,
    incomeStatement: { revenueCents: report.revenueCents, expenseCents: report.expenseCents, resultCents: report.resultCents }, balanceSheet: nonzeroAccounts,
    comparative: previous ? { start: previous.start, end: previous.end, revenueCents: previous.revenueCents, expenseCents: previous.expenseCents, resultCents: previous.resultCents, assetsCents: previous.assetsCents } : null,
    managementReport: text(options.managementReport ?? '', 'Förvaltningsberättelse', 12000, true), notes: text(options.notes ?? '', 'Noter', 12000, true),
    missingBeforeAnnualReport: ['Val och kontroll av tillämpligt K-regelverk och uppställningsform', 'Fullständig förvaltningsberättelse, noter och redovisningsprinciper', 'Resultatdisposition och bolagsrättsliga beslut', 'Underskrifter, fastställelseintyg och eventuell revisionsberättelse', 'Granskat inlämningsformat till Bolagsverket'],
    submissionReady: false, generatedAt: new Date().toISOString() };
}

export function exportYearReview(state, start = state.company.fiscalYearStart, end = state.company.fiscalYearEnd) {
  const period = fiscalPeriods(state).find(item => item.start === start && item.end === end);
  assert(period, 'Välj ett registrerat räkenskapsår.');
  return { kind: 'Bokslutspaket för granskning', version: 1, period: { start, end }, company: clone(period.snapshot?.company ?? state.company),
    report: getYearReports(state, { start, end }), archivedSnapshot: period.snapshot ? clone(period.snapshot) : null,
    workpapers: clone((state.yearWorkpapers ?? []).filter(item => item.fiscalYearStart === start && item.fiscalYearEnd === end)),
    annualReportDraft: annualReportDraft(state, { start, end }), generatedAt: new Date().toISOString(), submissionReady: false };
}

export { fiscalPeriods, fiscalPeriodForDate, currentYearClosure, nextCalendarDate, defaultNextYearEnd, getCloseChecklist };
