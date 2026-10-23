import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEmptyState, transact, appendEntry, accountBalance } from '../public/bokforing/suite/core.js';
import { lockPeriod, closeYear, fileVatPeriod, createEmployee, createPayrollRun, postPayroll, payPayroll } from '../public/bokforing/suite/finance.js';
import { getYearReports, openNextYear, annualReportDraft, exportYearReview, prepareCorporateTax, saveYearWorkpaper, closeReviewedYear } from '../public/bokforing/suite/financial-years.js';
import { buildAgiXml, buildVatXml, buildSruFiles, buildAnnualReportHtml, createDeclaration, getDeclarationFile, suggestSruFields, getDeclarationRescontra, VAT_XML_FIELDS, SRU_FIELDS, encodeLatin1, zipFiles } from '../public/bokforing/suite/declarations.js';
import { createCustomer, createInvoice, issueInvoice, receivePayment } from '../public/bokforing/suite/sales.js';
import { createBill, bookBill, payBill } from '../public/bokforing/suite/operations.js';
import { createCreditNote } from '../public/bokforing/suite/settlements.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

// Each registration below is an independent business scenario. Monetary
// expectations use integer identities and declared posting inputs, not the
// production report/tax helpers being audited.
let sequence = 0;
const audit = (name, run) => test(`AUDIT-CLOSE-${String(++sequence).padStart(3, '0')} ${name}`, run);
const D = (account, n) => ({ account, debitCents: n, creditCents: 0 });
const C = (account, n) => ({ account, debitCents: 0, creditCents: n });
const initial = () => transact(createEmptyState(), s => appendEntry(s, { date: '2026-01-01', description: 'Audit capital', sourceType: 'opening', sourceId: 'audit-capital', rows: [D('1930', 2500000), C('2081', 2500000)] }));
const post = (s, date, debit, credit, amount) => transact(s, d => appendEntry(d, { date, description: `Audit ${debit}/${credit}`, sourceType: 'manual', sourceId: `audit-${d.sequence}`, rows: [D(debit, amount), C(credit, amount)] }));
function close(s) {
  for (let m = 1; m <= 12; m++) s = lockPeriod(s, `${s.company.fiscalYearStart.slice(0, 4)}-${String(m).padStart(2, '0')}`);
  return closeYear(s, { date: s.company.fiscalYearEnd, confirmed: true });
}
const profitState = (revenue = 500000, expense = 103000) => { let s = initial(); if (revenue) s = post(s, '2026-10-01', '1930', '3000', revenue); if (expense) s = post(s, '2026-11-01', '6540', '1930', expense); return s; };
const verify = s => { validateSuiteState(JSON.parse(JSON.stringify(s))); return s; };
const stamp = '2026-10-23T12:34:56Z';
const agiBase = { kind: 'agi', month: '2026-10', orgNumber: '5560269986', createdAt: stamp, contactName: 'Kerstin Åström', contactPhone: '0101234567', contactEmail: 'audit@example.invalid', domesticOrdinary: true, reviewed: true, absenceReviewed: true, people: [] };
const person = { employeeId: 'audit-person', personalNumber: '198501011236', specification: 1, grossCents: 3200099, benefitCents: 20099, withholdingCents: 619099, employerCents: 1011731 };
const agiTags = (xml, name) => [...xml.matchAll(new RegExp(`<agd:${name}(?: [^>]*)?>([^<]*)</agd:${name}>`, 'g'))].map(m => m[1]);
const xmlValue = (xml, name) => Number(new RegExp(`<${name}>(-?\\d+)</${name}>`).exec(xml)?.[1] ?? 0);
const schema = fileURLToPath(new URL('./fixtures/bokforing-declarations/arbetsgivardeklaration_1.1.xsd', import.meta.url));
function validAgi(xml) {
  const r = spawnSync('python3', ['-c', 'from lxml import etree\nimport sys\ns=etree.XMLSchema(file=sys.argv[1]);s.assertValid(etree.fromstring(sys.stdin.buffer.read()))', schema], { input: xml, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
}
const sruInput = (s, extra = {}) => ({ kind: 'sru', orgNumber: '5560269986', createdAt: stamp, start: '2026-01-01', end: '2026-12-31', name: 'Åkes Audit AB', postalCode: '12345', city: 'Örebro', forms: suggestSruFields(s).forms, reviewed: true, manualReconciliationConfirmed: true, ...extra });
const annualInput = extra => ({ kind: 'annual', orgNumber: '5560269986', name: 'Åkes Audit AB', start: '2026-01-01', end: '2026-12-31', createdAt: stamp, reviewed: true, firstYear: true, smallPrivateAB: true, scopeReviewed: true, registeredOffice: 'Örebro', signaturePlace: 'Örebro', signatureDate: '2027-02-01', managementReport: 'Verksamhet med granskat underlag.', events: 'Inga väsentliga händelser.', postBalanceEvents: 'Inga senare händelser.', equityNote: 'Kapital inbetalat.', accountingPolicies: 'Anskaffningsvärde och SEK.', assetNote: 'Inga anläggningstillgångar.', employeeNote: 'Inga anställda.', securityNote: 'Inga säkerheter.', debtNote: 'Inga långfristiga skulder.', relatedPartyNote: 'Inga närståendelån.', taxNote: 'Skatt bedömd separat.', averageEmployees: 0, dividendCents: 0, dividendReviewed: true, allSignatoriesConfirmed: true, signatories: [{ name: 'Anna & Åke', role: 'Styrelseledamot' }], ...extra });
const format = n => new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n / 100);

// 1–24: period-specific result, cumulative bank/equity and exact öre.
for (const [i, amounts] of [
  [101, 0], [101, 99], [99, 101], [250001, 100099], [1000000, 333333], [1, 2],
  [999999, 999998], [7654321, 1234567], [800000, 800000], [333300, 111100], [7, 3], [100000000, 9876543],
].entries()) for (const afterClose of [false, true]) audit(`report ${i + 1}, ${afterClose ? 'closed' : 'open'}: exact income and balance`, () => {
  const [sales, costs] = amounts;
  let s = profitState(sales, costs); if (afterClose) s = close(s); verify(s);
  const r = getYearReports(s);
  assert.equal(r.revenueCents, sales); assert.equal(r.expenseCents, costs); assert.equal(r.resultCents, sales - costs);
  assert.equal(r.bankCents, 2500000 + sales - costs); assert.equal(r.assetsCents, r.bankCents); assert.equal(r.balanced, true);
  assert.equal(r.unallocatedResultCents, afterClose ? 0 : sales - costs);
});

// 25–44: both signs, zero, multi-year continuation and immutable history.
for (const [i, result] of [0, 1, -1, 99, -99, 100, -100, 98765, -54321, 1000000].entries()) for (const nextResult of [i + 101, -i - 201]) audit(`year carry ${result} then ${nextResult}`, () => {
  let s = result >= 0 ? post(initial(), '2026-11-01', '1930', '3000', result || 1) : post(initial(), '2026-11-01', '6540', '1930', -result);
  if (!result) s = post(s, '2026-11-02', '6540', '1930', 1);
  s = close(s); const originalEntries = structuredClone(s.entries); const oldResult = result;
  s = openNextYear(s, { confirmed: true });
  const frozen = s.fiscalYears[0].snapshotJson;
  assert.deepEqual(s.entries.slice(0, originalEntries.length), originalEntries);
  assert.equal(s.entries.filter(e => e.sourceType === 'opening').length, 1);
  assert.equal(accountBalance(s, '2098'), -oldResult || 0); assert.equal(accountBalance(s, '2099'), 0);
  s = nextResult > 0 ? post(s, '2027-03-01', '1930', '3000', nextResult) : post(s, '2027-03-01', '6540', '1930', -nextResult); verify(s);
  assert.equal(getYearReports(s).resultCents, nextResult); assert.equal(getYearReports(s, { start: '2026-01-01', end: '2026-12-31' }).resultCents, oldResult);
  assert.equal(s.fiscalYears[0].snapshotJson, frozen);
  const draft = annualReportDraft(s); assert.equal(draft.comparative.resultCents, oldResult); assert.equal(draft.submissionReady, false);
});

// 45–68: business categories and a real prepare/review/revision chain.
for (const [i, category] of ['bank', 'receivables', 'payables', 'vat', 'payroll', 'assets', 'inventory', 'accruals', 'tax', 'equity', 'annual-report', 'other'].entries()) for (const account of ['', '1930']) audit(`workpaper ${category} ${account || 'non-account'} review revision`, () => {
  let s = saveYearWorkpaper(profitState(200000 + i, 10000), { title: category, category, account, note: `Underlag ${i}` });
  const id = s.yearWorkpapers[0].id;
  s = saveYearWorkpaper(s, { id, title: category, category, account, status: 'prepared', preparedBy: 'Upprättare', evidence: `Bilaga ${i}` });
  s = saveYearWorkpaper(s, { id, title: category, category, account, status: 'reviewed', preparedBy: 'Upprättare', reviewedBy: 'Granskare', evidence: `Bilaga ${i}` }); verify(s);
  assert.equal(s.yearWorkpapers[0].revisions.length, 3); assert.equal(s.yearWorkpapers[0].status, 'reviewed');
  assert.equal(s.yearWorkpapers[0].balanceCents, account ? 2690000 + i : null);
  assert.equal(exportYearReview(s).workpapers[0].id, id);
});

// 69–92: independent tax arithmetic, signed result and restricted loss usage.
for (const result of [-200001, -1, 0, 199, 123456, 99999999]) for (const [add, deduct, loss] of [[0, 0, 0], [12345, 6789, 0], [500001, 100099, 250001], [0, 0, 999999999]]) audit(`tax result ${result}, add ${add}, deduct ${deduct}, loss ${loss}`, () => {
  let s = initial(); if (result > 0) s = post(s, '2026-10-01', '1930', '3000', result); if (result < 0) s = post(s, '2026-10-01', '6540', '1930', -result); verify(s);
  const t = prepareCorporateTax(s, { additionsCents: add, deductionsCents: deduct, priorLossCents: loss, assessmentNote: 'Auditerad aritmetik; avdragsrätt bedöms separat.' });
  const adjusted = result + add - deduct, used = Math.min(Math.max(0, adjusted), loss), taxable = Math.max(0, adjusted - used);
  const whole = BigInt(Math.floor(taxable / 100));
  assert.equal(t.resultBeforeTaxCents, result); assert.equal(t.usedLossCents, used); assert.equal(t.taxableCents, Number(whole * 100n));
  assert.equal(t.estimatedTaxCents, Number(whole * 206n / 1000n * 100n)); assert.equal(t.status, 'review-workpaper');
});

// 93–112: all outgoing VAT groups plus per-field truncation and refund totals.
for (const [i, key] of ['10', '11', '12', '30', '31', '32', '60', '61', '62', '48'].entries()) for (const sign of [1, -1]) audit(`VAT ${key} sign ${sign}, independent whole-krona total`, () => {
  const amount = sign * (10000 + i * 101 + 99); const boxes = { [key]: amount, '49': key === '48' ? -amount : amount };
  const xml = buildVatXml({ orgNumber: '5560269986', from: '2026-10-01', to: '2026-12-31', reviewed: true, boxes, note: 'Öresprov & kontroll' });
  assert.equal(xmlValue(xml, VAT_XML_FIELDS.find(([field]) => field === key)[1]), Math.trunc(amount / 100));
  assert.equal(xmlValue(xml, 'MomsBetala'), (key === '48' ? -1 : 1) * Math.trunc(amount / 100));
  assert.match(xml, /Version="6.0"/); assert.equal([...xml].every(c => c.codePointAt(0) < 128), true);
});

// 113–124: registered monthly VAT exports are source-bound and ledger-neutral.
for (let month = 1; month <= 12; month++) audit(`registered VAT month ${month} exports exact calendar boundary`, () => {
  const s = initial(); s.company.vatPeriod = 'month'; const mm = String(month).padStart(2, '0');
  const to = new Date(Date.UTC(2026, month, 0)).toISOString().slice(0, 10);
  const saved = createDeclaration(s, { kind: 'vat', orgNumber: '5560269986', from: `2026-${mm}-01`, to, reviewed: true, createdAt: stamp }); verify(saved);
  const file = getDeclarationFile(saved, saved.declarations[0].id);
  assert.match(file.value, new RegExp(`<Period>2026${mm}</Period>`)); assert.equal(xmlValue(file.value, 'MomsBetala'), 0); assert.deepEqual(saved.entries, s.entries);
});

// 125–136: real salary -> payment -> AGI and official XSD; varying months/pay.
for (let month = 1; month <= 12; month++) audit(`AGI paid salary month ${month} and official XSD`, () => {
  const mm = String(month).padStart(2, '0'), gross = 2000000 + month * 10000, tax = 400000 + month * 1000;
  let s = createEmployee(initial(), { name: 'Fiktiv auditperson', payType: 'monthly', baseCents: gross, withholdingCents: tax, employerRateBps: 3142 });
  s = createPayrollRun(s, { date: `2026-${mm}-25`, month: `2026-${mm}` }); const id = s.payrollRuns[0].id;
  s = postPayroll(s, id); s = payPayroll(s, id, { date: `2026-${mm}-26` });
  s = createDeclaration(s, { ...agiBase, month: `2026-${mm}`, people: [{ employeeId: s.employees[0].id, personalNumber: person.personalNumber, specification: month }] }); verify(s);
  const xml = getDeclarationFile(s, s.declarations[0].id).value; validAgi(xml);
  assert.deepEqual(agiTags(xml, 'KontantErsattningUlagAG'), [String(gross / 100)]); assert.deepEqual(agiTags(xml, 'AvdrPrelSkatt'), [String(tax / 100)]);
  assert.deepEqual(agiTags(xml, 'SummaSkatteavdr'), [String(tax / 100)]); assert.deepEqual(agiTags(xml, 'Specifikationsnummer'), [String(month)]);
});

// 137–148: parental absence alternatives, independent hour/percentage values.
for (const type of ['FORALDRAPENNING', 'TILLFALLIG_FORALDRAPENNING']) for (const [field, values] of [['hoursHundredths', [1, 800, 2400]], ['percentHundredths', [1, 3333, 10000]]]) for (const quantity of values) audit(`AGI ${type} ${field} ${quantity}`, () => {
  const xml = buildAgiXml({ ...agiBase, people: [person], absences: [{ employeeId: person.employeeId, date: '2026-10-12', type, specification: 7, [field]: quantity }] }); validAgi(xml);
  const suffix = type === 'FORALDRAPENNING' ? 'FP' : 'TFP', tag = `${field === 'hoursHundredths' ? 'FranvaroTimmar' : 'FranvaroProcent'}${suffix}`;
  assert.deepEqual(agiTags(xml, tag), [(quantity / 100).toFixed(2)]); assert.deepEqual(agiTags(xml, 'FranvaroDatum'), ['2026-10-12']);
});

// 149–160: consistent SRU arithmetic through ledger suggestions and ZIP bytes.
for (const [i, [sales, cost]] of [[100, 0], [500000, 103000], [100, 200], [200, 100], [999900, 999800], [50000, 50000], [9876500, 1234500], [100000000, 9800000], [100, 99900], [321000, 13000], [700, 300], [2000000, 999900]].entries()) audit(`SRU result case ${i + 1} and Latin-1 archive`, () => {
  let s = initial(); s = post(s, '2026-10-01', '1930', '3000', sales); if (cost) s = post(s, '2026-10-02', '6540', '1930', cost); verify(s);
  const input = sruInput(s), files = buildSruFiles(input), expected = (sales - cost) / 100;
  const field = expected >= 0 ? '7450' : '7550'; assert.equal(input.forms.INK2R[field], String(Math.abs(expected)));
  assert.match(files['BLANKETTER.SRU'], /#BLANKETT INK2R-2026P4\r\n/); assert.equal(files['INFO.SRU'].includes('\r\n#NAMN Åkes Audit AB\r\n'), true);
  const zipped = zipFiles(files); assert.equal(new DataView(zipped.buffer).getUint32(0, true), 0x04034b50); assert.equal(encodeLatin1(files['INFO.SRU']).includes(197), true);
  s = createDeclaration(s, input); verify(s); assert.deepEqual(getDeclarationFile(s, s.declarations[0].id).value, zipped);
});

// 161–172: native receivable/payable credit balances must be gross at end date.
for (const side of ['customer', 'supplier']) for (const [i, net] of [10000, 20000, 80000, 123600, 200000, 999600].entries()) audit(`gross rescontra ${side}, open net ${net}`, () => {
  let s = initial(); let paidId;
  for (let n = 0; n < 2; n++) {
    if (side === 'customer') {
      s = createCustomer(s, { name: `Audit customer ${n}` });
      s = createInvoice(s, { customerId: s.customers.at(-1).id, date: '2026-10-01', dueDate: '2026-10-31', lines: [{ description: 'Delivered work', kind: 'labor', quantity: 1, unitCents: net, vatRate: 25 }] });
      const id = s.invoices.at(-1).id; s = issueInvoice(s, id); if (n) { s = receivePayment(s, id, { date: '2026-10-02', amountCents: net * 5 / 4, reference: 'audit-paid' }); paidId = id; }
    } else {
      s = createBill(s, { supplier: `Audit supplier ${n}`, number: `AUD-${n}`, date: '2026-10-01', dueDate: '2026-10-31', account: '4010', netCents: net, vatRate: 25 });
      const id = s.bills.at(-1).id; s = bookBill(s, id); if (n) { s = payBill(s, id, { date: '2026-10-02', amountCents: net * 5 / 4, reference: 'audit-paid' }); paidId = id; }
    }
  }
  const creditNet = net / 4; s = createCreditNote(s, { side, documentId: paidId, date: '2026-10-03', reason: 'Returned delivery', reference: `audit-credit-${i}`, lines: [{ index: 0, netCents: creditNet }] }); verify(s);
  const r = getDeclarationRescontra(s, '2026-12-31'), creditGross = Math.round(creditNet * 1.25);
  assert.equal(r.unknown.length, 0); assert.equal(r[side === 'customer' ? 'customerCreditCents' : 'supplierCreditCents'], creditGross);
  assert.equal(getDeclarationRescontra(s, '2026-10-02')[side === 'customer' ? 'customerCreditCents' : 'supplierCreditCents'], 0);
  assert.equal(r.positions.filter(p => p.side === side).find(p => p.balanceCents > 0).balanceCents, net * 5 / 4);
});

// 173–184: closed K2 statements include exact result and isolated archive.
for (const [i, result] of [0, 100, -100, 99, -99, 397000, 987654, -543210, 1, -1, 1000000, 9999999].entries()) audit(`annual statement result ${result} and immutable review export`, () => {
  let s = initial(); if (result > 0) s = post(s, '2026-10-01', '1930', '3000', result); if (result < 0) s = post(s, '2026-10-01', '6540', '1930', -result); s = close(s); verify(s);
  const html = buildAnnualReportHtml(s, annualInput({ averageEmployees: i / 10 }));
  assert.ok(html.includes(`<th>Årets resultat</th><td>${format(result)}</td>`)); assert.ok(html.includes('Anna &amp; Åke')); assert.ok(html.includes(`Medelantal anställda: ${i / 10}`));
  s = createDeclaration(s, annualInput()); s = openNextYear(s, { confirmed: true }); verify(s);
  const review = exportYearReview(s, '2026-01-01', '2026-12-31'); assert.equal(review.report.resultCents, result); assert.equal(review.archivedSnapshot.extensions.declarations.length, 1);
  review.archivedSnapshot.report.resultCents = 99; assert.equal(s.fiscalYears[0].snapshot.report.resultCents, result);
  assert.equal(getDeclarationFile(s, s.declarations[0].id).value, buildAnnualReportHtml(s, annualInput()));
});

// 185 onward: distinct integrity, date, identity, format and review failures.
const guardCases = [
 ['year opening needs a closure', () => openNextYear(initial(), { confirmed: true }), /Avsluta/],
 ['year opening needs confirmation', () => openNextYear(close(initial()), {}), /Bekräfta/],
 ['year opening rejects gap', () => openNextYear(close(initial()), { confirmed: true, start: '2027-01-02' }), /dagen efter/],
 ['year opening rejects overlap', () => openNextYear(close(initial()), { confirmed: true, start: '2026-12-31' }), /dagen efter/],
 ['year opening rejects 27 days', () => openNextYear(close(initial()), { confirmed: true, end: '2027-01-27' }), /28 dagar/],
 ['year opening rejects more than 18 months', () => openNextYear(close(initial()), { confirmed: true, end: '2028-07-01' }), /18 månader/],
 ['workpaper rejects same reviewer', () => saveYearWorkpaper(initial(), { title: 'Bank', category: 'bank', status: 'reviewed', preparedBy: 'A', reviewedBy: 'A', evidence: 'E' }), /olika/],
 ['workpaper rejects absent evidence', () => saveYearWorkpaper(initial(), { title: 'Bank', category: 'bank', status: 'reviewed', preparedBy: 'A', reviewedBy: 'B' }), /underlagsreferens/],
 ['workpaper rejects nonexistent account', () => saveYearWorkpaper(initial(), { title: 'Bank', category: 'bank', account: '9999' }), /giltigt konto/],
 ['workpaper rejects unknown category', () => saveYearWorkpaper(initial(), { title: 'Bank', category: 'not-category' }), /område/],
 ['workpaper rejects historic write', () => saveYearWorkpaper(close(initial()), { title: 'Bank', category: 'bank' }), /avslutade/],
 ['reviewed stale balance blocks closing', () => { let s = saveYearWorkpaper(initial(), { title: 'Bank', category: 'bank', account: '1930', status: 'reviewed', preparedBy: 'A', reviewedBy: 'B', evidence: 'Bank' }); s = post(s, '2026-10-01', '6540', '1930', 101); closeReviewedYear(s, { confirmed: true }); }, /kontosaldo har ändrats/],
 ['VAT rejects unknown field', () => buildVatXml({ orgNumber: '5560269986', from: '2026-01-01', to: '2026-03-31', reviewed: true, boxes: { '99': 100 } }), /okända/],
 ['VAT rejects mismatched total', () => buildVatXml({ orgNumber: '5560269986', from: '2026-01-01', to: '2026-03-31', reviewed: true, boxes: { '10': 100, '49': 99 } }), /Ruta 49/],
 ['VAT rejects midmonth start', () => buildVatXml({ orgNumber: '5560269986', from: '2026-01-02', to: '2026-03-31', reviewed: true, boxes: {} }), /hela kalender/],
 ['VAT rejects midmonth end', () => buildVatXml({ orgNumber: '5560269986', from: '2026-01-01', to: '2026-03-30', reviewed: true, boxes: {} }), /hela kalender/],
 ['VAT rejects wrong registered interval', () => createDeclaration(initial(), { kind: 'vat', orgNumber: '5560269986', from: '2026-10-01', to: '2026-10-31', reviewed: true }), /registrerade/],
 ['AGI rejects 2027 silent format reuse', () => buildAgiXml({ ...agiBase, month: '2027-01' }), /2026/],
 ['AGI rejects bad organisation digit', () => buildAgiXml({ ...agiBase, orgNumber: '5560269987' }), /kontrollsiffra/],
 ['AGI rejects absent absence review', () => buildAgiXml({ ...agiBase, absenceReviewed: false }), /Granska/],
 ['AGI rejects duplicated recipients', () => buildAgiXml({ ...agiBase, people: [person, { ...person, specification: 2 }] }), /dubblerat/],
 ['AGI rejects negative gross', () => buildAgiXml({ ...agiBase, people: [{ ...person, grossCents: -1 }] }), /negativa/],
 ['AGI rejects zero specification', () => buildAgiXml({ ...agiBase, people: [{ ...person, specification: 0 }] }), /specifikation/],
 ['AGI rejects absence without recipient', () => buildAgiXml({ ...agiBase, absences: [{ employeeId: 'missing' }] }), /saknar/],
 ['AGI rejects simultaneous hours and percentage', () => buildAgiXml({ ...agiBase, people: [person], absences: [{ employeeId: person.employeeId, date: '2026-10-12', type: 'FORALDRAPENNING', specification: 1, hoursHundredths: 100, percentHundredths: 50 }] }), /antingen/],
 ['AGI rejects absence outside month', () => buildAgiXml({ ...agiBase, people: [person], absences: [{ employeeId: person.employeeId, date: '2026-09-30', type: 'FORALDRAPENNING', specification: 1, hoursHundredths: 100 }] }), /redovisningsmånaden/],
 ['SRU rejects unsupported period', () => buildSruFiles(sruInput(initial(), { end: '2026-08-31' })), /2026P4/],
 ['SRU rejects line injection', () => buildSruFiles(sruInput(initial(), { name: 'Audit\n#FIL_SLUT' })), /radbrytning/],
 ['SRU rejects non-Latin-1 company', () => buildSruFiles(sruInput(initial(), { name: 'Audit 😀' })), /ISO-8859-1/],
 ['SRU rejects unknown catalog field', () => { const p = sruInput(initial()); p.forms.INK2R['9999'] = '1'; buildSruFiles(p); }, /Okänd/],
 ['SRU rejects balance discrepancy', () => { const p = sruInput(initial()); p.forms.INK2R['7281'] = '24999'; buildSruFiles(p); }, /balansera/],
 ['SRU rejects unsupported group-loss rule', () => { const p = sruInput(initial()); p.forms.INK2S['7672'] = '1'; buildSruFiles(p); }, /Koncernbidrag/],
 ['K2 rejects open accounting year', () => buildAnnualReportHtml(initial(), annualInput()), /Avsluta/],
 ['K2 rejects missing signatory confirmation', () => buildAnnualReportHtml(close(initial()), annualInput({ allSignatoriesConfirmed: false })), /styrelseledamöter/],
 ['K2 rejects signature before period end', () => buildAnnualReportHtml(close(initial()), annualInput({ signatureDate: '2026-12-30' })), /Underskriftsdatum/],
 ['K2 rejects dividend beyond free capital', () => buildAnnualReportHtml(close(profitState()), annualInput({ dividendCents: 397001 })), /Resultatdisposition/],
];
for (const [label, action, error] of guardCases) audit(label, () => assert.throws(action, error));

// 221–228: actual XSD monetary facets, including a multi-recipient HU total.
for (const key of ['grossCents', 'benefitCents', 'withholdingCents']) {
  audit(`AGI ${key} accepts BELOPP10 exact maximum`, () => {
    const xml = buildAgiXml({ ...agiBase, people: [{ ...person, [key]: 999999999999 }] }); validAgi(xml);
    const tag = { grossCents: 'KontantErsattningUlagAG', benefitCents: 'SkatteplOvrigaFormanerUlagAG', withholdingCents: 'AvdrPrelSkatt' }[key];
    assert.deepEqual(agiTags(xml, tag), ['9999999999']);
  });
  audit(`AGI ${key} rejects BELOPP10 maximum plus one exported krona`, () => {
    assert.throws(() => buildAgiXml({ ...agiBase, people: [{ ...person, [key]: 1000000000000 }] }), /gräns|BELOPP10|tio|10 siffror/i);
  });
}
function distinctPerson(n, withholdingCents) {
  const nine = `850101${String(n).padStart(3, '0')}`;
  const check = (10 - [...nine].reduce((total, digit, index) => { const product = Number(digit) * (index % 2 ? 1 : 2); return total + (product > 9 ? product - 9 : product); }, 0) % 10) % 10;
  return { ...person, employeeId: `recipient-${n}`, personalNumber: `19${nine}${check}`, specification: n, withholdingCents, grossCents: withholdingCents, benefitCents: 0, employerCents: 0 };
}
for (const excess of [0, 1]) audit(`AGI HU497 BELOPP12 ${excess ? 'maximum plus one' : 'exact maximum'}`, () => {
  const people = Array.from({ length: 100 }, (_, n) => distinctPerson(n + 1, 999999999900));
  people.push(distinctPerson(101, (99 + excess) * 100));
  if (excess) assert.throws(() => buildAgiXml({ ...agiBase, people }), /gräns|BELOPP12|tolv|12 siffror/i);
  else { const xml = buildAgiXml({ ...agiBase, people }); validAgi(xml); assert.deepEqual(agiTags(xml, 'SummaSkatteavdr'), ['999999999999']); }
});

for (const date of ['2026-02-30T12:00:00Z', '2026-04-31T12:00:00Z']) audit(`AGI rejects normalized nonexistent timestamp ${date}`, () => {
  assert.throws(() => buildAgiXml({ ...agiBase, createdAt: date }), /Framställningstid|datum/);
});

audit('saved SRU becomes stale when a new in-period cost changes its accounting source', () => {
  let s = profitState(); s = createDeclaration(s, sruInput(s)); const id = s.declarations[0].id;
  s = post(s, '2026-12-01', '6570', '1930', 10000); verify(s);
  assert.throws(() => getDeclarationFile(s, id), /ny deklarationsversion/);
});
audit('saved VAT becomes stale when a new taxable invoice changes the same period', () => {
  let s = createDeclaration(initial(), { kind: 'vat', orgNumber: '5560269986', from: '2026-10-01', to: '2026-12-31', reviewed: true, createdAt: stamp }); const id = s.declarations[0].id;
  s = createCustomer(s, { name: 'Later taxable customer' });
  s = createInvoice(s, { customerId: s.customers[0].id, date: '2026-11-01', dueDate: '2026-11-30', lines: [{ description: 'Taxable delivery', kind: 'labor', quantity: 1, unitCents: 10000, vatRate: 25 }] });
  s = issueInvoice(s, s.invoices[0].id); verify(s); assert.throws(() => getDeclarationFile(s, id), /ny deklarationsversion/);
});
audit('saved AGI becomes stale when another salary is actually paid in its month', () => {
  let s = createEmployee(initial(), { name: 'Paid salary recipient', payType: 'monthly', baseCents: 2000000, withholdingCents: 400000 });
  s = createPayrollRun(s, { date: '2026-09-25', month: '2026-09' }); s = postPayroll(s, s.payrollRuns[0].id); s = payPayroll(s, s.payrollRuns[0].id, { date: '2026-10-01' });
  s = createDeclaration(s, { ...agiBase, people: [{ employeeId: s.employees[0].id, personalNumber: person.personalNumber, specification: 1 }] }); const id = s.declarations[0].id;
  s = createPayrollRun(s, { date: '2026-10-25', month: '2026-10' }); s = postPayroll(s, s.payrollRuns[1].id); s = payPayroll(s, s.payrollRuns[1].id, { date: '2026-10-26' });
  verify(s); assert.throws(() => getDeclarationFile(s, id), /ny deklarationsversion/);
});
audit('historical SRU remains downloadable after only next-year activity', () => {
  let s = close(profitState()); s = createDeclaration(s, sruInput(s)); const id = s.declarations[0].id, bytes = getDeclarationFile(s, id).value;
  s = openNextYear(s, { confirmed: true }); s = post(s, '2027-01-04', '6540', '1930', 112233); verify(s);
  assert.deepEqual(getDeclarationFile(s, id).value, bytes);
});
for (const [description, mutate] of [
  ['change archive company', s => { s.fiscalYears[0].snapshot.company.name = 'Changed'; }],
  ['drop archive year', s => { s.fiscalYears.shift(); }],
  ['change archive report', s => { s.fiscalYears[0].snapshot.report.resultCents++; }],
]) audit(`historical archive transaction rejects ${description}`, () => {
  const s = openNextYear(close(profitState()), { confirmed: true }); verify(s);
  assert.throws(() => transact(s, mutate), /Arkiverade/); validateSuiteState(s);
});
audit('K2 requires an explanation when comparative turnover grows by more than thirty percent', () => {
  let s = openNextYear(close(profitState(100000, 10000)), { confirmed: true }); s = post(s, '2027-10-01', '1930', '3000', 130001); s = close(s); verify(s);
  const data = annualInput({ start: '2027-01-01', end: '2027-12-31', signatureDate: '2028-01-20' });
  assert.throws(() => buildAnnualReportHtml(s, data), /omsättningsförändring/);
  assert.match(buildAnnualReportHtml(s, { ...data, turnoverChangeNote: 'Ny kund gav omsättningsökning.' }), /Ny kund/);
});
audit('K2 exactly thirty percent comparative growth does not require extra note', () => {
  let s = openNextYear(close(profitState(100000, 10000)), { confirmed: true }); s = post(s, '2027-10-01', '1930', '3000', 130000); s = close(s); verify(s);
  const html = buildAnnualReportHtml(s, annualInput({ start: '2027-01-01', end: '2027-12-31', signatureDate: '2028-01-20' }));
  assert.match(html, /2026-01-01–2026-12-31/); assert.ok(html.includes('1 300,00'));
});
audit('K2 missing material accounting policies stops the completed annual document', () => {
  const s = close(profitState()); verify(s); assert.throws(() => buildAnnualReportHtml(s, annualInput({ accountingPolicies: '' })), /upplysning accountingPolicies/);
});
