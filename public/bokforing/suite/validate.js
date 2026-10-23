// Restore/write validation composes the independent demo modules without making
// the core transaction helper depend on their business logic.
import { ACCOUNTS, MAX_CENTS, accountBalance, assert, cents, validDate, validateState } from './core.js';
import { getInvoiceTotals, invoiceBookingSnapshot } from './sales.js';
import { calculateLineAmounts, calculateRot, ROT_RULES_2026 } from './rot.js';
import { getReports, getVatPeriodBounds, getVatReport, validatePayrollRun } from './finance.js';
import { accrualBookingSnapshot, getAccrualRemaining } from './periodization.js';
import { validateInventoryState } from './inventory.js';

const debit = (account, amount) => ({ account, debitCents: amount, creditCents: 0 });
const credit = (account, amount) => ({ account, debitCents: 0, creditCents: amount });
const nonzero = rows => rows.filter(row => row.debitCents || row.creditCents);
const text = (value, max = 500, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
const sum = values => values.reduce((result, value) => { assert(Number.isSafeInteger(value) && Number.isSafeInteger(result + value), 'En beloppssumma är ogiltig.'); return result + value; }, 0);
const total = values => cents(sum(values));
const signed = value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_CENTS;
const roundRate = (amount, rate, denominator = 10000) => Number((BigInt(amount) * BigInt(rate) + BigInt(denominator / 2)) / BigInt(denominator));
const date = (value, label) => assert(validDate(value), `${label} har ett ogiltigt datum.`);
const unique = (items, key, label) => assert(new Set(items.map(item => item[key])).size === items.length, `${label} innehåller dubbletter.`);
const requireArray = (items, label, max = 20000) => assert(Array.isArray(items) && items.length <= max, `${label} har fel format.`);
const positiveFields = (object, fields) => fields.forEach(key => cents(object[key]));
const monthIndex = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
const manualProtected = new Set(['1220', '1229', '1460', '1510', '1710', '1790', '2440', '2910', '2099', '8999', '4960', '7832', '3973', '7973']);

function sides(rows) {
  const accounts = new Map();
  rows.forEach(row => {
    const current = accounts.get(row.account) ?? [0, 0];
    current[0] += row.debitCents; current[1] += row.creditCents;
    assert(current.every(Number.isSafeInteger), 'Kontosumman är ogiltig.');
    accounts.set(row.account, current);
  });
  return [...accounts].filter(([, values]) => values[0] || values[1]).sort(([a], [b]) => a.localeCompare(b));
}
function sameRows(actual, expected, label) {
  assert(JSON.stringify(sides(actual)) === JSON.stringify(sides(nonzero(expected))), `${label}: bokföringen stämmer inte med underlaget.`);
}
function sameList(actual, expected, label) {
  assert(Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected), `${label} stämmer inte med den sparade bokföringen.`);
}
function reversal(entry) {
  return entry.rows.map(row => ({ account: row.account, debitCents: row.creditCents, creditCents: row.debitCents }));
}
function fieldLines(lines, label) {
  requireArray(lines, label, 100);
  assert(lines.length > 0, `${label} saknar rader.`);
  lines.forEach(line => calculateLineAmounts(line));
}

export function validateSuiteState(state) {
  validateState(state);
  validateInventoryState(state);
  const maps = Object.fromEntries(['entries', 'customers', 'projects', 'quotes', 'invoices', 'bills', 'employees', 'payrollRuns', 'assets', 'accruals', 'inventoryItems', 'inventoryValuations', 'vatReturns', 'rotClaims', 'bankTransactions', 'yearClosures']
    .map(key => [key, new Map(state[key].map(item => [item.id, item]))]));
  const claimedEntries = new Set();
  const getEntry = (id, type, sourceId, expectedDate) => {
    const entry = maps.entries.get(id);
    assert(entry && entry.sourceType === type && entry.sourceId === sourceId, `Bokföringsreferensen för ${type} saknas eller har ändrats.`);
    if (expectedDate) assert(entry.date === expectedDate, `Bokföringsdatumet för ${type} stämmer inte med underlaget.`);
    assert(!claimedEntries.has(id), 'En verifikation hör till flera oförenliga underlag.');
    claimedEntries.add(id);
    return entry;
  };
  const noEntry = (entity, label) => assert(!entity.entryId, `${label} är ett utkast men har en bokförd verifikation.`);
  const inYear = (value, label) => { date(value, label); assert(value >= state.company.fiscalYearStart && value <= state.company.fiscalYearEnd, `${label} ligger utanför räkenskapsåret.`); };
  const projectFor = (id, customerId) => {
    if (id == null || id === '') return;
    const project = maps.projects.get(id);
    assert(project && (!customerId || project.customerId === customerId), 'Projektets kundreferens är ogiltig.');
  };
  const paymentBank = (payment, sign) => {
    const events = state.bankTransactions.filter(event => event.matchedEntryId === payment.entryId && (event.account ?? '1930') === '1930');
    assert(events.length === 1 && events[0].date === payment.date && events[0].amountCents === sign * payment.amountCents,
      'Betalningens avstämda bankhändelse saknas eller har ändrats.');
    if (payment.bankEventId) assert(events[0].id === payment.bankEventId, 'Betalningens bankreferens stämmer inte.');
  };

  for (const customer of state.customers) {
    assert(text(customer.name, 150) && text(customer.email ?? '', 254, true) && text(customer.address ?? '', 500, true), 'Kunduppgifterna är ogiltiga.');
  }
  for (const supplier of state.suppliers) assert(text(supplier.name, 150), 'Leverantörsregistrets uppgifter är ogiltiga.');
  for (const project of state.projects) {
    assert(text(project.name, 150) && maps.customers.has(project.customerId) && project.status === 'active', 'Projektuppgifterna är ogiltiga.');
    cents(project.budgetCents); requireArray(project.items, 'Projektets tid och material', 10000); unique(project.items, 'id', 'Projektets rader');
    project.items.forEach(item => { assert(text(item.id, 200), 'Projektradens ID saknas.'); calculateLineAmounts({ ...item, vatRate: item.vatRate ?? 25 }); });
  }
  for (const quote of state.quotes) {
    assert(maps.customers.has(quote.customerId) && text(quote.number, 50) && /^O-\d{4,}$/.test(quote.number) && ['draft', 'accepted', 'invoiced'].includes(quote.status), 'Offertuppgifterna är ogiltiga.');
    projectFor(quote.projectId, quote.customerId); date(quote.date, 'Offerten'); date(quote.validUntil, 'Offertens giltighetstid');
    assert(quote.validUntil >= quote.date, 'Offertens giltighetstid är ogiltig.'); fieldLines(quote.lines, 'Offerten');
    if (quote.status === 'invoiced') assert(maps.invoices.get(quote.invoiceId)?.sourceQuoteId === quote.id, 'Offertens fakturareferens saknas.');
    else assert(!quote.invoiceId, 'En ofakturerad offert har en felaktig fakturareferens.');
  }
  unique(state.quotes, 'number', 'Offertnumren');

  const invoiceNumbers = new Set();
  const rotUse = new Map();
  for (const invoice of state.invoices) {
    assert(maps.customers.has(invoice.customerId) && ['invoice', 'credit'].includes(invoice.kind) && ['draft', 'issued', 'credited'].includes(invoice.status), 'Kundfakturans grunduppgifter är ogiltiga.');
    projectFor(invoice.projectId, invoice.customerId); inYear(invoice.date, 'Fakturan'); date(invoice.dueDate, 'Förfallodagen');
    assert(invoice.dueDate >= invoice.date && typeof invoice.buyerConstructionConfirmed === 'boolean', 'Fakturans datum eller momsbedömning är ogiltig.');
    fieldLines(invoice.lines, 'Kundfakturan'); requireArray(invoice.payments, 'Kundbetalningarna'); requireArray(invoice.reminders, 'Påminnelserna');
    unique(invoice.payments, 'id', 'Kundbetalningarna'); unique(invoice.payments, 'reference', 'Kundbetalningarnas referenser'); unique(invoice.reminders, 'id', 'Påminnelserna');
    invoice.reminders.forEach(reminder => { assert(text(reminder.id, 200) && text(reminder.note), 'Påminnelsen är ogiltig.'); date(reminder.date, 'Påminnelsen'); });
    const totals = getInvoiceTotals(invoice);
    if (invoice.vatMode === 'reverse-construction') assert((invoice.status === 'draft' || invoice.buyerConstructionConfirmed) && !invoice.rot, 'Omvänd byggmoms kräver köparbedömning och kan inte kombineras med ROT.');
    if (invoice.status === 'draft') {
      assert(invoice.kind === 'invoice' && invoice.number === '' && invoice.payments.length === 0 && invoice.reminders.length === 0, 'Ett fakturautkast har utfärdade uppgifter.');
      noEntry(invoice, 'Kundfakturan');
      assert(!invoice.creditId && !invoice.originalInvoiceId, 'Ett fakturautkast kan inte vara krediterat.');
    } else {
      assert(new RegExp(`^${invoice.kind === 'credit' ? 'K' : 'F'}-\\d{4,}$`).test(invoice.number) && !invoiceNumbers.has(invoice.number), 'Fakturanumret är ogiltigt eller återanvänt.');
      invoiceNumbers.add(invoice.number);
      assert(invoice.bookingSnapshot === invoiceBookingSnapshot(invoice), 'Den utfärdade kundfakturans uppgifter har ändrats.');
      const entry = getEntry(invoice.entryId, invoice.kind === 'credit' ? 'invoice-credit' : 'invoice', invoice.id, invoice.date);
      if (invoice.kind === 'credit') {
        const original = maps.invoices.get(invoice.originalInvoiceId);
        assert(invoice.status === 'issued' && original?.kind === 'invoice' && original.status === 'credited' && original.creditId === invoice.id && invoice.date >= original.date,
          'Kreditfakturan saknar ett giltigt original.');
        assert(!invoice.rot && invoice.payments.length === 0 && entry.correctsEntryId === original.entryId, 'Kreditfakturans rättelse- eller betalningsuppgifter är ogiltiga.');
        sameRows(entry.rows, reversal(maps.entries.get(original.entryId)), 'Kreditfakturan');
      } else {
        const expected = [debit('1510', totals.grossCents), credit(invoice.vatMode === 'reverse-construction' ? '3231' : '3000', totals.netCents)];
        if (invoice.vatMode === 'standard') for (const [rate, account] of [[25, '2611'], [12, '2621'], [6, '2631']]) {
          const value = total(invoice.lines.filter(line => line.vatRate === rate).map(line => calculateLineAmounts(line).vatCents));
          if (value) expected.push(credit(account, value));
        }
        sameRows(entry.rows, expected, 'Kundfakturan');
        if (invoice.status === 'credited') assert(invoice.payments.length === 0 && maps.invoices.get(invoice.creditId)?.originalInvoiceId === invoice.id, 'Den krediterade fakturan saknar länkad kreditfaktura.');
        else assert(!invoice.creditId, 'En aktiv kundfaktura har en felaktig kreditreferens.');
      }
    }
    for (const payment of invoice.payments) {
      cents(payment.amountCents, false); inYear(payment.date, 'Kundbetalningen');
      assert(payment.date >= invoice.date && ['customer', 'tax'].includes(payment.payer) && text(payment.id, 200) && text(payment.reference, 100), 'Kundbetalningens uppgifter är ogiltiga.');
      const entry = getEntry(payment.entryId, 'customer-payment', payment.id, payment.date);
      sameRows(entry.rows, [debit('1930', payment.amountCents), credit('1510', payment.amountCents)], 'Kundbetalningen'); paymentBank(payment, 1);
    }
    const customerPaid = total(invoice.payments.filter(item => item.payer === 'customer').map(item => item.amountCents));
    const taxPaid = total(invoice.payments.filter(item => item.payer === 'tax').map(item => item.amountCents));
    assert(customerPaid <= totals.customerCents && taxPaid <= totals.rotCents && customerPaid + taxPaid <= totals.grossCents, 'Kundbetalningar överstiger fakturans kvarvarande belopp.');
    if (!invoice.rot) assert(taxPaid === 0, 'Skatteverkets betalning saknar ROT-underlag.');
    else {
      const rot = invoice.rot; const calculation = calculateRot(invoice);
      if (invoice.status !== 'draft') {
        cents(rot.reservedCents, false); cents(rot.remainingCents);
        assert(rot.remainingCents <= Math.min(rot.availableCents, ROT_RULES_2026.capCents) && rot.reservedCents === calculation.deductionCents,
          'ROT-reservationen stämmer inte med arbetskostnaden och det uppgivna utrymmet.');
        assert(['awaiting-customer', 'requested', 'approved', 'denied', 'settled'].includes(rot.status), 'ROT-ärendets status är ogiltig.');
        if (invoice.status === 'issued') {
          const person = `${rot.paymentYear}:${rot.personId.replace(/[\s-]/g, '').toUpperCase()}`;
          rotUse.set(person, (rotUse.get(person) ?? 0) + (rot.approvedCents ?? rot.reservedCents));
        }
        if (rot.status === 'awaiting-customer') assert(!rot.claimId && !state.rotClaims.some(item => item.invoiceId === invoice.id), 'ROT-ärendet har en oväntad begäran.');
        else {
          const claim = maps.rotClaims.get(rot.claimId);
          assert(claim?.invoiceId === invoice.id && rot.workCompletedConfirmed === true && rot.electronicPaymentConfirmed === true,
            'ROT-begärans underlag eller bekräftelser saknas.');
          assert(customerPaid >= totals.grossCents - rot.reservedCents, 'ROT-begäran saknar hela den ursprungliga kundbetalningen.');
          if (rot.status === 'requested') assert(claim.status === 'prepared' && rot.approvedCents === undefined && taxPaid === 0, 'Ett förberett ROT-ärende har fel beslut eller betalning.');
          if (['approved', 'denied', 'settled'].includes(rot.status)) {
            assert(['approved', 'denied'].includes(claim.status) && claim.approvedCents === rot.approvedCents, 'ROT-beslutet stämmer inte med fakturan.');
            if (rot.status === 'denied') assert(rot.approvedCents === 0 && taxPaid === 0, 'Ett avslaget ROT-ärende kan inte ha en skattebetalning.');
            if (rot.status === 'settled') assert(customerPaid + taxPaid === totals.grossCents, 'Ett slutreglerat ROT-ärende har en restfordran.');
          }
        }
      }
      if (taxPaid) {
        const claim = maps.rotClaims.get(rot.claimId);
        assert(['approved', 'settled'].includes(rot.status) && claim?.status === 'approved' && validDate(claim.decisionDate) && invoice.payments.filter(item => item.payer === 'tax').every(item => item.date >= claim.decisionDate), 'ROT-betalningen saknar ett tidigare godkänt beslut.');
      }
    }
    if (invoice.sourceQuoteId) assert(maps.quotes.get(invoice.sourceQuoteId)?.invoiceId === invoice.id, 'Fakturans offertreferens är ogiltig.');
  }
  rotUse.forEach(value => assert(value <= ROT_RULES_2026.capCents, 'Samma persons registrerade ROT-reservationer överstiger årstaket.'));
  unique(state.rotClaims, 'invoiceId', 'ROT-begäran');
  for (const claim of state.rotClaims) {
    const invoice = maps.invoices.get(claim.invoiceId);
    assert(invoice?.kind === 'invoice' && invoice.status === 'issued' && invoice.rot?.claimId === claim.id && ['prepared', 'approved', 'denied'].includes(claim.status), 'ROT-begäran saknar en giltig faktura.');
    date(claim.date, 'ROT-begäran'); cents(claim.requestedCents, false);
    const paidBeforeClaim = total(invoice.payments.filter(item => item.payer === 'customer' && item.date <= claim.date).map(item => item.amountCents));
    assert(claim.requestedCents === invoice.rot.reservedCents && claim.date >= invoice.date && claim.date <= `${invoice.rot.paymentYear + 1}-01-31` && paidBeforeClaim >= getInvoiceTotals(invoice).grossCents - invoice.rot.reservedCents, 'ROT-begärans belopp eller datum är ogiltiga.');
    if (claim.status !== 'prepared') {
      cents(claim.approvedCents); date(claim.decisionDate, 'ROT-beslutet');
      assert(claim.decisionDate >= claim.date && claim.approvedCents <= claim.requestedCents && (claim.status === 'approved') === (claim.approvedCents > 0), 'ROT-beslutet är ogiltigt.');
      if (claim.approvedCents < claim.requestedCents) assert(text(claim.reason, 300), 'Minskat ROT-belopp saknar motivering.');
    }
  }

  const supplierNumbers = new Set();
  for (const bill of state.bills) {
    assert(text(bill.supplier, 300) && text(bill.number, 100) && ['draft', 'booked', 'credited'].includes(bill.status), 'Leverantörsfakturans uppgifter är ogiltiga.');
    const number = `${bill.supplier.toLocaleLowerCase('sv')}:${bill.number.toLocaleLowerCase('sv')}`;
    assert(!supplierNumbers.has(number), 'Leverantörens fakturanummer har registrerats två gånger.'); supplierNumbers.add(number);
    inYear(bill.date, 'Leverantörsfakturan'); date(bill.dueDate, 'Förfallodagen'); assert(bill.dueDate >= bill.date, 'Leverantörsfakturans förfallodag är ogiltig.');
    projectFor(bill.projectId); cents(bill.netCents, false); cents(bill.vatCents); cents(bill.totalCents, false);
    assert([0, 6, 12, 25].includes(bill.vatRate) && ['standard', 'reverse-construction', 'no-vat'].includes(bill.vatMode) && typeof bill.reverseConfirmed === 'boolean', 'Leverantörsfakturans momstyp är ogiltig.');
    const expectedVat = bill.vatMode === 'standard' ? roundRate(bill.netCents, bill.vatRate, 100) : 0;
    assert(bill.vatCents === expectedVat && bill.totalCents === bill.netCents + expectedVat && (bill.vatMode !== 'no-vat' || bill.vatRate === 0), 'Leverantörsfakturans belopp stämmer inte.');
    assert(bill.vatMode === 'reverse-construction' ? bill.account === '4425' && bill.vatRate === 25 : ['4010', '5010', '5410', '5460', '6110', '6540', '6570', '6991'].includes(bill.account), 'Leverantörsfakturans kostnadskonto är ogiltigt.');
    requireArray(bill.payments, 'Leverantörsbetalningarna'); unique(bill.payments, 'id', 'Leverantörsbetalningarna');
    if (bill.status === 'draft') { noEntry(bill, 'Leverantörsfakturan'); assert(bill.payments.length === 0 && !bill.creditEntryId, 'Fakturautkastet har en betalning eller kredit.'); }
    else {
      assert(bill.bookingSnapshot === JSON.stringify([bill.supplier, bill.number, bill.date, bill.dueDate, bill.netCents, bill.vatRate, bill.vatMode, bill.account, bill.vatCents, bill.totalCents, bill.reverseConfirmed, bill.projectId ?? null]), 'Den bokförda leverantörsfakturans uppgifter har ändrats.');
      const entry = getEntry(bill.entryId, 'bill', bill.id, bill.date);
      const expected = [debit(bill.account, bill.netCents), credit('2440', bill.totalCents)];
      if (expectedVat) expected.push(debit('2641', expectedVat));
      if (bill.vatMode === 'reverse-construction') { assert(bill.reverseConfirmed, 'Omvänd byggmoms saknar bekräftad bedömning.'); const reverseVat = roundRate(bill.netCents, 25, 100); expected.push(debit('2647', reverseVat), credit('2614', reverseVat)); }
      sameRows(entry.rows, expected, 'Leverantörsfakturan');
      if (bill.status === 'credited') {
        assert(bill.payments.length === 0 && text(bill.creditReason, 300), 'Krediterad leverantörsfaktura har betalningar eller saknar orsak.');
        const correction = getEntry(bill.creditEntryId, 'bill-credit', bill.id); assert(correction.correctsEntryId === entry.id && correction.date >= bill.date, 'Leverantörskrediten saknar korrekt originalreferens.'); sameRows(correction.rows, reversal(entry), 'Leverantörskrediten');
      } else assert(!bill.creditEntryId, 'En aktiv leverantörsfaktura har en felaktig kreditreferens.');
    }
    for (const payment of bill.payments) {
      cents(payment.amountCents, false); inYear(payment.date, 'Leverantörsbetalningen'); assert(payment.date >= bill.date, 'Leverantörsbetalningen ligger före fakturan.');
      const entry = getEntry(payment.entryId, 'bill-payment', payment.id, payment.date); sameRows(entry.rows, [debit('2440', payment.amountCents), credit('1930', payment.amountCents)], 'Leverantörsbetalningen'); paymentBank(payment, -1);
    }
    assert(total(bill.payments.map(item => item.amountCents)) <= bill.totalCents, 'Leverantörsbetalningarna överstiger fakturan.');
  }

  for (const employee of state.employees) {
    assert(text(employee.name, 160) && ['monthly', 'hourly'].includes(employee.payType) && typeof employee.active === 'boolean', 'Den anställdes uppgifter är ogiltiga.');
    cents(employee.baseCents, false); cents(employee.withholdingCents); assert(Number.isSafeInteger(employee.employerRateBps) && employee.employerRateBps >= 0 && employee.employerRateBps <= 10000, 'Arbetsgivaravgiftens demoantagande är ogiltigt.');
  }
  const employeeMonths = new Set();
  for (const run of state.payrollRuns) {
    validatePayrollRun(state, run);
    inYear(run.date, 'Lönekörningen'); assert(run.date.startsWith(`${run.month}-`) && ['draft', 'posted', 'paid'].includes(run.status), 'Lönekörningens period eller status är ogiltig.');
    requireArray(run.lines, 'Lönekörningen', 1000); assert(run.lines.length, 'Lönekörningen saknar anställda.'); unique(run.lines, 'employeeId', 'Lönekörningen');
    for (const line of run.lines) {
      assert(maps.employees.has(line.employeeId) && text(line.name, 160) && ['monthly', 'hourly'].includes(line.payType), 'Löneradens anställd saknas.');
      const key = `${run.month}:${line.employeeId}`; assert(!employeeMonths.has(key), 'En anställd har flera lönekörningar för samma månad.'); employeeMonths.add(key);
      positiveFields(line, ['baseCents', 'sickDeductionCents', 'vacationPayCents', 'grossCents', 'withholdingCents', 'netCents', 'employerCents', 'benefitCents', 'reimbursementCents']);
      assert(Number.isSafeInteger(line.employerRateBps) && line.employerRateBps >= 0 && line.employerRateBps <= 10000, 'Löneradens avgiftsantagande är ogiltigt.');
      assert(line.grossCents > 0 && line.grossCents === line.baseCents + line.vacationPayCents - line.sickDeductionCents && line.withholdingCents <= line.grossCents && line.netCents === line.grossCents - line.withholdingCents + line.reimbursementCents && line.employerCents === roundRate(total([line.grossCents, line.benefitCents]), line.employerRateBps), 'Löneberäkningen stämmer inte med löneunderlaget.');
    }
    const totals = Object.fromEntries(['grossCents', 'reimbursementCents', 'employerCents', 'withholdingCents', 'netCents'].map(key => [key, total(run.lines.map(line => line[key]))]));
    if (run.status === 'draft') { noEntry(run, 'Lönekörningen'); assert(!run.paymentEntryId, 'Löneutkastet har en betalning.'); }
    else {
      const entry = getEntry(run.entryId, 'payroll', run.id, run.date);
      sameRows(entry.rows, [debit('7010', totals.grossCents), debit('7331', totals.reimbursementCents), debit('7510', totals.employerCents), credit('2710', totals.withholdingCents), credit('2731', totals.employerCents), credit('2910', totals.netCents)], 'Lönekörningen');
      if (run.status === 'paid') {
        inYear(run.paidDate, 'Löneutbetalningen'); assert(run.paidDate >= run.date, 'Löneutbetalningen ligger före lönekörningen.');
        if (totals.netCents) {
          const payment = getEntry(run.paymentEntryId, 'payroll-payment', run.id, run.paidDate); sameRows(payment.rows, [debit('2910', totals.netCents), credit('1930', totals.netCents)], 'Löneutbetalningen');
          paymentBank({ entryId: payment.id, date: payment.date, amountCents: totals.netCents }, -1);
        } else assert(!run.paymentEntryId, 'En nollutbetalning har en betalningsverifikation.');
      } else assert(!run.paymentEntryId, 'En obetald lönekörning har en betalningsverifikation.');
    }
    assert(run.taxesSettled === undefined || typeof run.taxesSettled === 'boolean', 'Löneskattens betalningsstatus är ogiltig.');
    if (run.taxesSettled) {
      assert(run.status !== 'draft', 'Löneutkastet kan inte ha en skattereglering.');
      inYear(run.taxSettledDate, 'Löneskattens reglering'); assert(run.taxSettledDate >= run.date, 'Löneskatten har reglerats före lönekörningen.');
      requireArray(run.taxSettlementEntryIds, 'Löneskattens reglering', 2);
      const taxAmount = total([totals.withholdingCents, totals.employerCents]);
      if (taxAmount) {
        assert(run.taxSettlementEntryIds.length === 2, 'Löneskattens reglering saknar verifikationer.');
        sameRows(getEntry(run.taxSettlementEntryIds[0], 'payroll-tax-transfer', run.id, run.taxSettledDate).rows, [debit('1630', taxAmount), credit('1930', taxAmount)], 'Löneskattens kontoöverföring');
        sameRows(getEntry(run.taxSettlementEntryIds[1], 'payroll-tax-settlement', run.id, run.taxSettledDate).rows, [debit('2710', totals.withholdingCents), debit('2731', totals.employerCents), credit('1630', taxAmount)], 'Löneskattens reglering');
      } else assert(run.taxSettlementEntryIds.length === 0, 'Nollbeloppet för löneskatt har en regleringsverifikation.');
    } else assert(!run.taxSettlementEntryIds?.length && !run.taxSettledDate, 'Löneskatten har regleringsuppgifter utan betald status.');
  }

  for (const asset of state.assets) {
    assert(text(asset.name, 160) && ['active', 'disposed'].includes(asset.status), 'Inventariens uppgifter är ogiltiga.'); inYear(asset.date, 'Inventarien');
    cents(asset.costCents, false); cents(asset.residualCents); assert(asset.residualCents < asset.costCents && Number.isSafeInteger(asset.lifeMonths) && asset.lifeMonths >= 1 && asset.lifeMonths <= 600, 'Inventariens värde eller nyttjandeperiod är ogiltig.');
    const acquisition = getEntry(asset.entryId, 'asset-acquisition', asset.id, asset.date); sameRows(acquisition.rows, [debit('1220', asset.costCents), credit('5410', asset.costCents)], 'Inventarieanskaffningen');
    requireArray(asset.depreciations, 'Avskrivningsplanen', 600); unique(asset.depreciations, 'month', 'Avskrivningsplanen');
    let accumulated = 0;
    asset.depreciations.forEach((item, index) => {
      inYear(item.date, 'Avskrivningen'); cents(item.amountCents, false);
      assert(item.date >= asset.date && item.month === item.date.slice(0, 7) && (index === 0 || item.date > asset.depreciations[index - 1].date), 'Avskrivningsdatumen är ogiltiga.');
      // The module posts one sequential month at a time, starting at acquisition.
      assert(monthIndex(item.month) === monthIndex(asset.date) + index, 'Avskrivningsplanen har en saknad eller dubblerad månad.');
      const depreciable = asset.costCents - asset.residualCents;
      const target = Math.min(depreciable, Number((BigInt(depreciable) * BigInt(index + 1) * 2n + BigInt(asset.lifeMonths)) / BigInt(asset.lifeMonths * 2)));
      const expectedAmount = Math.min(depreciable - accumulated, Math.max(1, target - accumulated));
      assert(item.amountCents === expectedAmount, 'Avskrivningsbeloppet stämmer inte med planen.'); accumulated += item.amountCents;
      const entry = getEntry(item.entryId, 'asset-depreciation', `${asset.id}:${item.month}`, item.date); sameRows(entry.rows, [debit('7832', item.amountCents), credit('1229', item.amountCents)], 'Avskrivningen');
    });
    assert(accumulated <= asset.costCents - asset.residualCents, 'Avskrivningarna överstiger inventariens avskrivningsbara värde.');
    if (asset.status === 'disposed') {
      inYear(asset.disposalDate, 'Avyttringen'); cents(asset.proceedsCents); assert(asset.disposalDate >= asset.date && asset.depreciations.every(item => item.date <= asset.disposalDate), 'Avyttringens datum är ogiltigt.');
      const bookValue = asset.costCents - accumulated; const vat = roundRate(asset.proceedsCents, 2500); const difference = asset.proceedsCents - bookValue;
      const entry = getEntry(asset.disposalEntryId, 'asset-disposal', asset.id, asset.disposalDate);
      sameRows(entry.rows, [debit('1229', accumulated), credit('1220', asset.costCents), debit('1930', total([asset.proceedsCents, vat])), credit('2611', vat), ...(difference >= 0 ? [credit('3973', difference)] : [debit('7973', -difference)])], 'Inventariens avyttring');
    } else assert(!asset.disposalEntryId && !asset.disposalDate, 'En aktiv inventarie har en avyttringsverifikation.');
  }

  for (const accrual of state.accruals) {
    inYear(accrual.date, 'Periodiseringen'); getAccrualRemaining(accrual);
    assert(accrual.bookingSnapshot === accrualBookingSnapshot(accrual), 'Den bokförda periodiseringsplanen har ändrats.');
    sameRows(getEntry(accrual.entryId, 'accrual-prepaid', accrual.id, accrual.date).rows, [debit('1790', accrual.amountCents), credit(accrual.expenseAccount, accrual.amountCents)], 'Periodiseringens förutbetalda kostnad');
    for (const posting of accrual.postings) {
      inYear(posting.date, 'Periodiseringens månadsbokning');
      if (posting.amountCents) sameRows(getEntry(posting.entryId, 'accrual-recognition', `${accrual.id}:${posting.month}`, posting.date).rows, [debit(accrual.expenseAccount, posting.amountCents), credit('1790', posting.amountCents)], 'Periodiseringens månadsbokning');
      else assert(posting.entryId === null, 'En nollperiodisering har en felaktig verifikation.');
    }
  }

  for (const valuation of state.inventoryValuations) {
    if (valuation.deltaCents) {
      const amount = Math.abs(valuation.deltaCents);
      sameRows(getEntry(valuation.entryId, 'inventory-valuation', valuation.id, valuation.date).rows,
        valuation.deltaCents > 0 ? [debit('1460', amount), credit('4960', amount)] : [debit('4960', amount), credit('1460', amount)], 'Lagervärderingen');
    } else assert(valuation.entryId === null, 'Oförändrat lagervärde har en felaktig verifikation.');
  }

  for (const record of state.vatReturns) {
    inYear(record.from, 'Momsperiodens start'); inYear(record.to, 'Momsperiodens slut'); inYear(record.date, 'Momsomföringen');
    assert(record.from <= record.to && record.date >= record.to && ['filed', 'settled'].includes(record.status), 'Momsperiodens datum eller status är ogiltig.');
    const bounds = getVatPeriodBounds(state, record.from);
    assert(record.from === bounds.from && record.to === bounds.to, 'Fastställt momsunderlag följer inte företagets valda momsperiod.');
    assert(state.vatReturns.every(other => other.id === record.id || record.to < other.from || record.from > other.to), 'Momsperioderna överlappar.');
    const report = getVatReport(state, record);
    assert(record.outputCents === report.outputCents && record.inputCents === report.inputCents && record.payableCents === report.payableCents && signed(record.payableCents), 'Det fastställda momsunderlaget har ändrats.');
    assert(JSON.stringify(record.balances) === JSON.stringify(report.balances), 'Momskontonas omföringsunderlag har ändrats.'); sameList(record.evidenceEntryIds, report.entries.map(entry => entry.id), 'Momsunderlagets verifikationer');
    const expected = Object.entries(record.balances).flatMap(([account, value]) => value > 0 ? [credit(account, value)] : value < 0 ? [debit(account, -value)] : []);
    if (record.payableCents > 0) expected.push(credit('2650', record.payableCents)); else if (record.payableCents < 0) expected.push(debit('2650', -record.payableCents));
    if (expected.length) sameRows(getEntry(record.entryId, 'vat-return', record.id, record.date).rows, expected, 'Momsomföringen'); else assert(record.entryId === null, 'En tom momsperiod har en omföringsverifikation.');
    requireArray(record.settlementEntryIds, 'Momsregleringen', 2);
    if (record.status === 'settled') {
      inYear(record.settledDate, 'Momsregleringen'); assert(record.settledDate >= record.date, 'Momsregleringen ligger före omföringen.');
      const amount = Math.abs(record.payableCents); const payable = record.payableCents > 0;
      if (amount) {
        assert(record.settlementEntryIds.length === 2, 'Momsregleringen saknar verifikationer.');
        sameRows(getEntry(record.settlementEntryIds[0], 'vat-transfer', record.id, record.settledDate).rows, payable ? [debit('1630', amount), credit('1930', amount)] : [debit('1930', amount), credit('1630', amount)], 'Momsöverföringen');
        sameRows(getEntry(record.settlementEntryIds[1], 'vat-settlement', record.id, record.settledDate).rows, payable ? [debit('2650', amount), credit('1630', amount)] : [debit('1630', amount), credit('2650', amount)], 'Momsregleringen');
      } else assert(record.settlementEntryIds.length === 0, 'Nollmoms har en betalningsverifikation.');
    } else assert(record.settlementEntryIds.length === 0, 'En oreglerad momsperiod har betalningsverifikationer.');
  }

  assert(state.yearClosures.length <= 1, 'Räkenskapsåret har avslutats flera gånger.');
  for (const closure of state.yearClosures) {
    assert(closure.date === state.company.fiscalYearEnd && closure.fiscalYearStart === state.company.fiscalYearStart && closure.fiscalYearEnd === state.company.fiscalYearEnd && signed(closure.resultCents), 'Årsavslutets räkenskapsår är ogiltigt.');
    const report = getReports(state); assert(report.resultCents === closure.resultCents && report.balanced, 'Årsavslutets resultat stämmer inte.');
    if (closure.resultCents) sameRows(getEntry(closure.entryId, 'year-close', closure.id, closure.date).rows, closure.resultCents > 0 ? [debit('8999', closure.resultCents), credit('2099', closure.resultCents)] : [debit('2099', -closure.resultCents), credit('8999', -closure.resultCents)], 'Årsresultatet');
    else assert(closure.entryId === null, 'Nollresultatet har en felaktig bokning.');
    sameList(closure.openingBalances, report.accounts.filter(account => /^[12]/.test(account.number) && account.balanceCents).map(account => ({ account: account.number, debitCents: Math.max(0, account.balanceCents), creditCents: Math.max(0, -account.balanceCents) })), 'Nästa års ingående balanser');
  }

  for (const entry of state.entries) {
    if (claimedEntries.has(entry.id)) continue;
    if (entry.sourceType === 'opening') {
      assert(entry.date === state.company.fiscalYearStart && entry.rows.every(row => /^[12]/.test(row.account)), 'Ingående balans får bara innehålla balanskonton vid årets början.');
    } else if (entry.sourceType === 'manual') {
      assert(entry.rows.every(row => !manualProtected.has(row.account) && !/^(26|27)/.test(row.account)), 'En manuell verifikation får inte kringgå reskontra, inventarier, moms eller löneskulder.');
    } else if (entry.sourceType === 'manual-correction') {
      const original = maps.entries.get(entry.correctsEntryId);
      assert(original?.sourceType === 'manual' && entry.sourceId === original.id, 'Den manuella rättelsens original är ogiltigt.');
    } else if (entry.sourceType === 'bank') {
      const event = maps.bankTransactions.get(entry.sourceId);
      assert(event?.matchedEntryId === entry.id && event.date === entry.date, 'Bankverifikationen saknar sin avstämda kontohändelse.');
      const eventAccount = event.account ?? '1930'; const others = [...new Set(entry.rows.map(row => row.account).filter(account => account !== eventAccount))];
      assert(others.length === 1 && ['6570', '1630', '1930', '1910', '2350', '8310', '8410'].includes(others[0]), 'Bankverifikationen innehåller ett konto utanför bankflödet.');
      const amount = Math.abs(event.amountCents); sameRows(entry.rows, event.amountCents > 0 ? [debit(eventAccount, amount), credit(others[0], amount)] : [debit(others[0], amount), credit(eventAccount, amount)], 'Bankverifikationen');
    } else assert(false, `Verifikationen ${entry.number} saknar ett giltigt underlag för ${entry.sourceType}.`);
  }
  const openingBalance = account => sum(state.entries.filter(entry => entry.sourceType === 'opening').flatMap(entry => entry.rows.filter(row => row.account === account).map(row => row.debitCents - row.creditCents)));
  const receivable = sum(state.invoices.filter(invoice => invoice.kind === 'invoice' && invoice.status === 'issued').map(invoice => getInvoiceTotals(invoice).grossCents - sum(invoice.payments.map(payment => payment.amountCents))));
  const payable = sum(state.bills.filter(bill => bill.status === 'booked').map(bill => bill.totalCents - sum(bill.payments.map(payment => payment.amountCents))));
  assert(accountBalance(state, '1510') === openingBalance('1510') + receivable, 'Kundreskontran stämmer inte med huvudboken.');
  assert(accountBalance(state, '2440') === openingBalance('2440') - payable, 'Leverantörsreskontran stämmer inte med huvudboken.');
  const activeAssets = state.assets.filter(asset => asset.status === 'active');
  assert(accountBalance(state, '1220') === openingBalance('1220') + sum(activeAssets.map(asset => asset.costCents)), 'Inventarieregistret stämmer inte med huvudbokens anskaffningsvärde.');
  assert(accountBalance(state, '1229') === openingBalance('1229') - sum(activeAssets.flatMap(asset => asset.depreciations.map(item => item.amountCents))), 'Inventarieregistret stämmer inte med huvudbokens avskrivningar.');
  assert(accountBalance(state, '1790') === openingBalance('1790') + sum(state.accruals.map(getAccrualRemaining)), 'Periodiseringsplanerna stämmer inte med huvudbokens förutbetalda kostnader.');
  assert(accountBalance(state, '1460') === (state.inventoryValuations.at(-1)?.valueCents ?? openingBalance('1460')), 'Lagerregistret stämmer inte med huvudbokens senast värderade lagervärde.');
  if (state.assets.length || state.bills.some(bill => bill.account === '5410' && bill.status === 'credited')) {
    let availableEquipment = 0;
    const chronological = state.entries.map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.date.localeCompare(b.entry.date) || a.index - b.index);
    for (const { entry } of chronological) {
      availableEquipment += sum(entry.rows.filter(row => row.account === '5410').map(row => row.debitCents - row.creditCents));
      assert(availableEquipment >= 0, 'Omklassificerade inventarieinköp har krediterats eller flyttats före tillgängligt inköp.');
    }
  }
  for (const expenseAccount of new Set(state.accruals.map(item => item.expenseAccount))) {
    const byDate = new Map();
    for (const entry of state.entries) {
      const movement = sum(entry.rows.filter(row => row.account === expenseAccount).map(row => row.debitCents - row.creditCents));
      byDate.set(entry.date, (byDate.get(entry.date) ?? 0) + movement);
    }
    let unallocated = 0;
    for (const [, movement] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
      unallocated += movement;
      assert(Number.isSafeInteger(unallocated) && unallocated >= 0, 'En periodiserad kostnad saknar täckning i bokförda inköp efter rättelser och omföringar.');
    }
  }
  const postedPayroll = state.payrollRuns.filter(run => run.status !== 'draft');
  assert(accountBalance(state, '2910') === openingBalance('2910') - sum(postedPayroll.filter(run => run.status === 'posted').flatMap(run => run.lines.map(line => line.netCents))), 'Löneskulden stämmer inte med obetalda lönekörningar.');
  assert(accountBalance(state, '2710') === openingBalance('2710') - sum(postedPayroll.filter(run => !run.taxesSettled).flatMap(run => run.lines.map(line => line.withholdingCents))), 'Personalskatten stämmer inte med lönekörningarna.');
  assert(accountBalance(state, '2731') === openingBalance('2731') - sum(postedPayroll.filter(run => !run.taxesSettled).flatMap(run => run.lines.map(line => line.employerCents))), 'Arbetsgivaravgifterna stämmer inte med lönekörningarna.');
  assert(accountBalance(state, '2650') === openingBalance('2650') - sum(state.vatReturns.filter(record => record.status === 'filed').map(record => record.payableCents)), 'Momsskulden stämmer inte med fastställda och oreglerade perioder.');
  const report = getReports(state);
  assert(report.balanced && ACCOUNTS.every(account => Number.isSafeInteger(accountBalance(state, account.number))), 'Rapporterna balanserar inte eller innehåller för stora belopp.');
  return state;
}
