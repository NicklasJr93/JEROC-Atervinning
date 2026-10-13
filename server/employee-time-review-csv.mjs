const textCell = value => {
  const text = String(value ?? '');
  // Quoting protects delimiters; the apostrophe prevents formula execution.
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};
const minutes = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Tidexporten innehåller ett ogiltigt minutvärde.');
  return value;
};

/** Minute columns retain exact totals; decimal hours are an Excel convenience,
 * not a salary, overtime or OB calculation. Input is the authorized approved projection. */
export function employeeTimeReviewCsv(exported) {
  const rows = [['Period', 'Person', 'Anställningsnummer', 'Version', 'Datum', 'Tidskälla',
    'Arbetad tid (min)', 'Arbetad tid (h)', 'Timkrav efter frånvaro (min)', 'Frånvaro (min)',
    'Rast (min)', 'Arbetsorderfördelning (min)', 'Manuell fördelning (min)', 'Ofördelad tid (min)',
    'Saknad tid (min)', 'Attesterad', 'Kontrollsumma']];
  for (const report of exported.reports) {
    if (report.period.source !== 'approved' || !report.review.approvedAt) throw new TypeError('Endast attesterade versioner kan exporteras.');
    for (const day of report.period.days) {
      const worked = minutes(day.recordedMinutes);
      rows.push([exported.month, report.person.name, report.person.employeeNumber ?? '', report.review.version,
        day.date, day.timeSource === 'clock' ? 'Stämpelklocka' : 'Arbetsorder och manuell tid',
        worked, (worked / 60).toFixed(4).replace('.', ','), minutes(day.expectedMinutes), minutes(day.absenceMinutes),
        minutes(day.breakMinutes), minutes(day.automaticMinutes), minutes(day.manualMinutes), minutes(day.unallocatedMinutes),
        minutes(day.missingMinutes), report.review.approvedAt, report.period.sourceHash]);
    }
  }
  return '\uFEFF' + rows.map(row => row.map(textCell).join(';')).join('\r\n') + '\r\n';
}
