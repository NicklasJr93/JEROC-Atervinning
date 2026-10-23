import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const [tapPath, reportPath, outputDirectory, startPath] = process.argv.slice(2);
if (!tapPath || !reportPath || !outputDirectory) throw new Error('Usage: node scripts/collect-bokforing-audit-results.mjs results.tap report.json output-dir [start-time-file]');
const source = readFileSync(tapPath), lines = source.toString('utf8').split(/\r?\n/);
const definitions = [
  ['AUDIT-LEDGER', 'Kärnbokföring och SIE', 'server/bokforing-audit-ledger-sie.test.mjs'],
  ['AUDIT-SALES', 'Fakturor och krediter', 'server/bokforing-audit-sales-credit.test.mjs'],
  ['AUDIT-CASHFX', 'Kontantmetod och valuta', 'server/bokforing-audit-cash-fx.test.mjs'],
  ['AUDIT-PAYROLL', 'Lön och semester', 'server/bokforing-audit-payroll.test.mjs'],
  ['AUDIT-TAXROT', 'Moms och ROT', 'server/bokforing-audit-tax-rot.test.mjs'],
  ['AUDIT-CLOSE', 'Bokslut och export', 'server/bokforing-audit-closing-exports.test.mjs'],
];
const cases = [], totals = {}; let last;
for (const line of lines) {
  const match = /^\s*(not )?ok (\d+) - (.+)$/.exec(line);
  if (match) {
    const name = match[3], definition = definitions.find(([prefix]) => name.startsWith(`${prefix}-`));
    const id = definition ? new RegExp(`^(${definition[0]}-\\d+)`).exec(name)?.[1] : `BASE-${String(cases.length + 1).padStart(4, '0')}`;
    last = { id, name, status: /# (SKIP|TODO)/.test(name) ? 'Överhoppat' : match[1] ? 'Underkänt' : 'Godkänt',
      area: definition?.[1] ?? 'Befintlig regression', file: definition?.[2] ?? '', milliseconds: null, audit: Boolean(definition) };
    cases.push(last);
  } else {
    const duration = /^\s+duration_ms: ([\d.]+)/.exec(line);
    if (duration && last) last.milliseconds = Number(duration[1]);
    const total = /^# (tests|pass|fail|skipped|todo|cancelled|duration_ms) ([\d.]+)/.exec(line);
    if (total) totals[total[1]] = Number(total[2]);
  }
}
if (!Number.isInteger(totals.tests) || cases.length !== totals.tests) throw new Error('TAP is incomplete or contains unsupported nested suites.');
if (totals.fail || totals.skipped || totals.todo || totals.cancelled) throw new Error('Refusing to publish a passed report for failed, skipped or incomplete tests.');
const auditCases = cases.filter(item => item.audit), identifiers = new Set(auditCases.map(item => item.id));
if (identifiers.size !== auditCases.length || auditCases.length < 1000) throw new Error('Audit case identifiers must be unique and at least 1,000 scenarios must pass.');
if (definitions.some(([prefix]) => auditCases.filter(item => item.id.startsWith(prefix+'-')).length < 200)) throw new Error('Each audit area must include at least 200 separate cases.');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
report.tests = { ...report.tests, newPassed: auditCases.length, totalPassed: totals.pass, regressionPassed: cases.length - auditCases.length,
  failed: totals.fail, skipped: totals.skipped, startedAt: startPath ? readFileSync(startPath,'utf8').trim() : statSync(tapPath).birthtime.toISOString(),
  finishedAt: statSync(tapPath).mtime.toISOString(), durationMs: totals.duration_ms, logSha256: createHash('sha256').update(source).digest('hex') };
report.domains = report.domains.map(item => ({ ...item, count: auditCases.filter(test => test.id.startsWith(item.prefix+'-')).length }));
const escape = value => {
  let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
};
const rows = [['Fall-ID','Område','Testnamn','Status','Tid (ms)','Testfil'],...cases.map(test=>[test.id,test.area,test.name,test.status,test.milliseconds,test.file])];
mkdirSync(outputDirectory,{recursive:true});
writeFileSync(join(outputDirectory,'testresultat-2026-10-23.csv'),'\uFEFF'+rows.map(row=>row.map(escape).join(';')).join('\r\n')+'\r\n');
writeFileSync(join(outputDirectory,'testlogg-2026-10-23.tap.gz'),gzipSync(source));
writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ ...report.tests, areas: report.domains.map(({prefix,count})=>({prefix,count})) }));
