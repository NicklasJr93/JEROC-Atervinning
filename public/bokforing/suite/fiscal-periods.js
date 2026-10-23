// Date helpers shared by the journal and year-end workspace. No model imports.
export function fiscalPeriods(state) {
  if (Array.isArray(state.fiscalYears) && state.fiscalYears.length) return state.fiscalYears;
  return [{ start: state.company.fiscalYearStart, end: state.company.fiscalYearEnd, status: currentYearClosure(state) ? 'closed' : 'open', vatPeriod: state.company.vatPeriod }];
}

export function fiscalPeriodForDate(state, date) {
  return fiscalPeriods(state).find(period => date >= period.start && date <= period.end) ?? null;
}

export function currentYearClosure(state) {
  return (state.yearClosures ?? []).find(closure => closure.fiscalYearStart === state.company.fiscalYearStart && closure.fiscalYearEnd === state.company.fiscalYearEnd) ?? null;
}

export function currentYearIsClosed(state) {
  return state.fiscalYears === undefined ? (state.yearClosures ?? []).length > 0 : currentYearClosure(state) !== null;
}

export function activeFiscalPeriod(state) {
  return fiscalPeriods(state).find(period => period.start === state.company.fiscalYearStart && period.end === state.company.fiscalYearEnd) ?? null;
}

export function historicalCompany(state, date) {
  const period = fiscalPeriodForDate(state, date);
  return period ? { ...state.company, fiscalYearStart: period.start, fiscalYearEnd: period.end, vatPeriod: period.vatPeriod ?? state.company.vatPeriod } : state.company;
}

export function nextCalendarDate(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export function defaultNextYearEnd(start) {
  const value = new Date(`${start}T00:00:00.000Z`);
  value.setUTCFullYear(value.getUTCFullYear() + 1);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function assertFiscalHistoryPreserved(previous, next) {
  for (const period of previous.fiscalYears ?? []) {
    if (period.status !== 'closed') continue;
    const retained = (next.fiscalYears ?? []).find(item => item.id === period.id);
    if (!retained || JSON.stringify(retained) !== JSON.stringify(period)) throw new Error('Arkiverade räkenskapsår får inte ändras eller raderas.');
  }
  for (const paper of previous.yearWorkpapers ?? []) {
    const retained = (next.yearWorkpapers ?? []).find(item => item.id === paper.id);
    if (!retained || retained.fiscalYearStart !== paper.fiscalYearStart || retained.fiscalYearEnd !== paper.fiscalYearEnd || retained.revisions.length < paper.revisions.length ||
      paper.revisions.some((revision, index) => JSON.stringify(revision) !== JSON.stringify(retained.revisions[index]))) {
      throw new Error('Bokslutsbilagornas tidigare versioner får inte ändras eller raderas.');
    }
    const archived = (previous.yearClosures ?? []).some(closure => closure.fiscalYearStart === paper.fiscalYearStart && closure.fiscalYearEnd === paper.fiscalYearEnd);
    if (archived && JSON.stringify(retained) !== JSON.stringify(paper)) throw new Error('Bokslutsbilagor i avslutade år får inte ändras.');
  }
}
