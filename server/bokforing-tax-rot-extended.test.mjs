import { createEmptyState, createInvoice, invoiceTestParty } from './fixtures/bokforing-compliant-invoices.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEntry, accountBalance, transact } from '../public/bokforing/suite/core.js';
import { issueInvoice, receivePayment, getInvoiceOutstanding } from '../public/bokforing/suite/sales.js';
import { createBill, bookBill } from '../public/bokforing/suite/operations.js';
import { createCreditNote } from '../public/bokforing/suite/settlements.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { calculateTaxTransaction, postTaxTransaction, reverseTaxTransaction, validateTaxTransactions, getTaxDeclarationReport, taxReportCsv } from '../public/bokforing/suite/tax-ledger.js';
import { createRotPlan, prepareRotApplication, decideRotApplication, receiveRotApplicationPayment, repayRotApplication, validateRotApplications } from '../public/bokforing/suite/rot-extended.js';
import { handleAction as taxAction } from '../public/bokforing/suite/tax-workspace.js';

function open() {
  return transact(createEmptyState(), state => {
    state.customers.push({ id: 'person', name: 'Testkund', email: '', ...invoiceTestParty });
    appendEntry(state, { date: '2026-01-01', description: 'Ingående balans', sourceType: 'opening', sourceId: 'opening', rows: [{ account: '1930', debitCents: 100_000_000, creditCents: 0 }, { account: '2081', debitCents: 0, creditCents: 100_000_000 }] });
  });
}
const tax = (patch = {}) => ({ kind: 'eu-service-purchase', date: '2026-10-05', reference: 'INV-EU-1', counterparty: 'Exempel GmbH', country: 'DE', netCents: 100000, vatRate: 25, deductibleBps: 10000, account: '6540', conditionsConfirmed: true, ...patch });
function rotInvoice() {
  let state = createInvoice(open(), { customerId: 'person', date: '2026-10-01', dueDate: '2026-11-01', vatMode: 'standard', lines: [
    { kind: 'labor', description: 'Arbete', quantity: 1, unitCents: 3200000, vatRate: 25 },
    { kind: 'material', description: 'Material', quantity: 1, unitCents: 1920000, vatRate: 25 },
  ], rot: { personId: 'FIRST', property: 'DEMO 1:1', paymentYear: 2026, eligibleConfirmed: true, availableCents: 5000000 } });
  return issueInvoice(state, state.invoices[0].id);
}
function planState() {
  const state = rotInvoice();
  return createRotPlan(state, state.invoices[0].id, { date: '2026-10-01', participants: [
    { personId: 'PERSON-A', name: 'Person A', allocationCents: 600000, availableCents: 5000000, eligibleConfirmed: true },
    { personId: 'PERSON-B', name: 'Person B', allocationCents: 600000, availableCents: 5000000, eligibleConfirmed: true },
  ] });
}
const partial = () => {
  let state = planState(); state = receivePayment(state, state.invoices[0].id, { date: '2026-10-10', amountCents: 3900000, reference: 'del1' });
  return prepareRotApplication(state, state.rotPlans[0].id, { date: '2026-10-11', workCompletedConfirmed: true, electronicPaymentConfirmed: true });
};
const noMutation = (state, operation, pattern) => { const before = JSON.stringify(state); assert.throws(operation, pattern); assert.equal(JSON.stringify(state), before); };

test('EU-tjänst bokför underlag, omvänd moms och bank separat', () => {
  const state = postTaxTransaction(open(), tax());
  assert.equal(accountBalance(state, '6540'), 100000); assert.equal(accountBalance(state, '2614'), -25000); assert.equal(accountBalance(state, '2645'), 25000);
  assert.equal(accountBalance(state, '1930'), 99900000); assert.deepEqual(state.taxTransactions[0].boxes, { '21': 100000, '48': 25000, '30': 25000 });
  validateTaxTransactions(state); validateSuiteState(state); assert.equal(getTaxDeclarationReport(state).reconciled, true);
});
test('avdragsbegränsning lägger ej avdragsgill moms på kostnaden', () => {
  const state = postTaxTransaction(open(), tax({ deductibleBps: 5000 }));
  assert.equal(accountBalance(state, '6540'), 112500); assert.equal(accountBalance(state, '2645'), 12500); assert.equal(accountBalance(state, '2614'), -25000);
  assert.equal(getTaxDeclarationReport(state).boxes['49'], 12500);
});
test('omvänd moms 6 och 12 procent hamnar i skilda deklarationsfält', () => {
  for (const [rate, account, box] of [[6, '2634', '32'], [12, '2624', '31']]) {
    const state = postTaxTransaction(open(), tax({ vatRate: rate })); assert.equal(accountBalance(state, account), -1000*rate); assert.equal(getTaxDeclarationReport(state).boxes[box], 1000*rate);
  }
});
test('importmoms räknas från tullunderlag utan att bokföra varuinköpet igen', () => {
  const state = postTaxTransaction(open(), tax({ kind: 'import-vat', country: 'US', deductibleBps: 5000 }));
  assert.equal(accountBalance(state,'1930'),100000000); assert.equal(accountBalance(state,'2615'),-25000); assert.equal(accountBalance(state,'2645'),12500); assert.equal(accountBalance(state,'6540'),12500);
  const report = getTaxDeclarationReport(state); assert.equal(report.boxes['50'],100000); assert.equal(report.boxes['60'],25000); assert.equal(report.reconciled,true);
});
test('EU-försäljning kräver granskat VAT-nummer och rätt land', () => {
  assert.throws(() => calculateTaxTransaction(tax({ kind: 'eu-goods-sale', vatNumber: '' })),/VAT/);
  assert.throws(() => calculateTaxTransaction(tax({ country:'US' })),/EU-land/);
  assert.throws(() => calculateTaxTransaction(tax({ conditionsConfirmed:false })),/Bekräfta/);
  const state = postTaxTransaction(open(),tax({ kind:'eu-goods-sale',vatNumber:'DE123456789' })); assert.equal(getTaxDeclarationReport(state).boxes['35'],100000); assert.equal(accountBalance(state,'3000'),-100000);
});
test('dubbla underlag, låst period och fastställd moms stoppas utan mutation', () => {
  const state = postTaxTransaction(open(),tax()); noMutation(state,()=>postTaxTransaction(state,tax()),/redan/);
  const locked = open(); locked.lockedPeriods=['2026-10']; noMutation(locked,()=>postTaxTransaction(locked,tax()),/låst/);
  const filed=open(); filed.vatReturns.push({id:'vat',from:'2026-10-01',to:'2026-12-31'}); noMutation(filed,()=>postTaxTransaction(filed,tax()),/fastställd/);
});
test('rättelse bevarar original och återför moms/bank med länkad verifikation', () => {
  const original=postTaxTransaction(open(),tax()), snapshot=JSON.stringify(original.entries[1]);
  const state=reverseTaxTransaction(original,original.taxTransactions[0].id,{date:'2026-10-10',reason:'Dubbelt mottaget underlag'});
  assert.equal(JSON.stringify(state.entries[1]),snapshot); assert.equal(accountBalance(state,'2614'),0); assert.equal(accountBalance(state,'2645'),0); assert.equal(accountBalance(state,'1930'),100000000); assert.equal(getTaxDeclarationReport(state).boxes['21'],0);
  noMutation(state,()=>reverseTaxTransaction(state,original.taxTransactions[0].id,{date:'2026-10-11',reason:'Igen'}),/redan/);
});
test('manipulerade momsbelopp eller bokningsrader upptäcks', () => {
  const state=postTaxTransaction(open(),tax());
  for(const mutate of [s=>s.taxTransactions[0].netCents++,s=>s.taxTransactions[0].boxes['21']++,s=>s.taxTransactions[0].bookingSnapshot='x',s=>s.entries[1].rows[0].debitCents++]){
    const changed=structuredClone(state);mutate(changed);assert.throws(()=>validateTaxTransactions(changed));
  }
});
test('momsrapport samlar fakturor, fler inköpsrader och EU-affärer utan dubbelräkning', () => {
  let state=createInvoice(open(),{customerId:'person',date:'2026-10-01',dueDate:'2026-11-01',vatMode:'standard',lines:[{kind:'labor',description:'Arbete',quantity:1,unitCents:100000,vatRate:25}]});state=issueInvoice(state,state.invoices[0].id);
  state=createBill(state,{supplier:'Test AB',number:'I1',date:'2026-10-02',dueDate:'2026-11-02',lines:[{description:'Material',account:'4010',netCents:10000,vatRate:25,vatMode:'standard',deductibleBps:5000},{description:'Bygg',account:'4425',netCents:20000,vatRate:25,vatMode:'reverse-construction',reverseConfirmed:true}]});state=bookBill(state,state.bills[0].id);
  state=postTaxTransaction(state,tax());const report=getTaxDeclarationReport(state);
  assert.equal(report.boxes['05'],100000);assert.equal(report.boxes['10'],25000);assert.equal(report.boxes['24'],20000);assert.equal(report.boxes['30'],30000);assert.equal(report.boxes['48'],31250);assert.equal(report.boxes['49'],23750);assert.equal(report.reconciled,true);
  assert.match(taxReportCsv(state),/inte myndighetsinlämning/);
});
test('oklassificerad moms visas som avvikelse, inte färdigt deklarationsunderlag', () => {
  const state=transact(open(),draft=>appendEntry(draft,{date:'2026-10-01',description:'Manuell moms',sourceType:'unknown-tax',sourceId:'unknown',rows:[{account:'1930',debitCents:12500,creditCents:0},{account:'3000',debitCents:0,creditCents:10000},{account:'2611',debitCents:0,creditCents:2500}]}));
  const report=getTaxDeclarationReport(state);assert.equal(report.reconciled,false);assert.equal(report.unclassifiedEntries.length,1);assert.equal(report.outputDifferenceCents,2500);
});
test('delkredit minskar deklarationens ursprungsunderlag och exakta momsbelopp', () => {
  let state=createInvoice(open(),{customerId:'person',date:'2026-10-01',dueDate:'2026-11-01',vatMode:'standard',lines:[{kind:'labor',description:'Arbete',quantity:1,unitCents:100000,vatRate:25}]});state=issueInvoice(state,state.invoices[0].id);
  state=createCreditNote(state,{side:'customer',documentId:state.invoices[0].id,date:'2026-10-03',reason:'Del av arbete borttaget',reference:'K1',lines:[{index:0,netCents:20000}]});
  const report=getTaxDeclarationReport(state);assert.equal(report.boxes['05'],80000);assert.equal(report.boxes['10'],20000);assert.equal(report.reconciled,true);validateSuiteState(state);
});
test('momsrapporten avgränsar transaktioner och senare rättelser till valda datum', () => {
  let state=postTaxTransaction(open(),tax({date:'2026-03-10'}));
  state=postTaxTransaction(state,tax({date:'2026-10-10',reference:'EU-Q4',netCents:200000}));
  state=reverseTaxTransaction(state,state.taxTransactions[0].id,{date:'2026-10-12',reason:'Senare rättelse'});
  const first=getTaxDeclarationReport(state,{from:'2026-01-01',to:'2026-03-31'}),last=getTaxDeclarationReport(state,{from:'2026-10-01',to:'2026-12-31'});
  assert.equal(first.boxes['21'],100000);assert.equal(first.boxes['30'],25000);assert.equal(first.reconciled,true);
  assert.equal(last.boxes['21'],100000);assert.equal(last.boxes['30'],25000);assert.equal(last.reconciled,true);validateSuiteState(state);
});
test('momsarbetsytan kan välja period, fastställa och reglera nya omvända momsfall', () => {
  let state=postTaxTransaction(open(),tax({deductibleBps:5000}));
  state=taxAction(state,'set-tax-period',{from:'2026-10-01',to:'2026-12-31'});
  state=taxAction(state,'file-vat',{from:'2026-10-01',to:'2026-12-31',date:'2026-12-31',reviewed:'true'});validateSuiteState(state);
  assert.equal(state.vatReturns[0].payableCents,12500);assert.equal(accountBalance(state,'2650'),-12500);
  state=taxAction(state,'settle-vat',{id:state.vatReturns[0].id,date:'2026-12-31'});validateSuiteState(state);assert.equal(accountBalance(state,'2650'),0);assert.equal(state.vatReturns[0].status,'settled');
});
test('två ROT-personer behåller originalets frysta bokning och totalsumma', () => {
  const original=rotInvoice(),snapshot=original.invoices[0].bookingSnapshot;const state=createRotPlan(original,original.invoices[0].id,{date:'2026-10-01',participants:[{name:'A',personId:'A',allocationCents:600000,availableCents:5000000,eligibleConfirmed:true},{name:'B',personId:'B',allocationCents:600000,availableCents:5000000,eligibleConfirmed:true}]});
  assert.equal(state.invoices[0].bookingSnapshot,snapshot);assert.equal(state.entries.length,original.entries.length);assert.equal(state.rotPlans[0].reservedCents,1200000);validateRotApplications(state);
});
test('ROT-delbegäran proportioneras till 75 procent för två personer', () => {
  const state=partial(),app=state.rotApplications[0];assert.equal(app.requestedCents,900000);assert.deepEqual(app.personLines.map(item=>item.amountCents),[450000,450000]);validateSuiteState(state);
  noMutation(state,()=>prepareRotApplication(state,state.rotPlans[0].id,{date:'2026-10-12',workCompletedConfirmed:true,electronicPaymentConfirmed:true}),/ingen ny/);
});
test('ROT-avslag, slutbetalning och nästa begäran lämnar korrekt kundfordran', () => {
  let state=partial(),id=state.rotApplications[0].id;state=decideRotApplication(state,id,{date:'2026-10-12',reason:'Utrymme begränsat',approvedByPerson:{'PERSON-A':400000,'PERSON-B':450000}});state=receiveRotApplicationPayment(state,id,{date:'2026-10-13',amountCents:850000,reference:'SKV-del1'});
  assert.equal(getInvoiceOutstanding(state.invoices[0]),1650000);
  state=receivePayment(state,state.invoices[0].id,{date:'2026-10-14',amountCents:1350000,reference:'kund-slut'});state=prepareRotApplication(state,state.rotPlans[0].id,{date:'2026-10-15',workCompletedConfirmed:true,electronicPaymentConfirmed:true});
  const last=state.rotApplications.at(-1);assert.equal(last.requestedCents,300000);state=decideRotApplication(state,last.id,{date:'2026-10-16'});state=receiveRotApplicationPayment(state,last.id,{date:'2026-10-17',amountCents:300000,reference:'SKV-del2'});assert.equal(getInvoiceOutstanding(state.invoices[0]),0);validateRotApplications(state);validateSuiteState(state);
});
test('ROT-återkrav minskar bank och återöppnar kundfordran utan ny intäkt', () => {
  let state=partial(),id=state.rotApplications[0].id;state=decideRotApplication(state,id,{date:'2026-10-12'});state=receiveRotApplicationPayment(state,id,{date:'2026-10-13',amountCents:900000,reference:'SKV-1'});
  const bank=accountBalance(state,'1930'),revenue=accountBalance(state,'3000'),due=getInvoiceOutstanding(state.invoices[0]);state=repayRotApplication(state,id,{date:'2026-10-14',amountCents:100000,reason:'Manuellt återkravsbeslut',reference:'KRAV-1'});
  assert.equal(accountBalance(state,'1930'),bank-100000);assert.equal(accountBalance(state,'3000'),revenue);assert.equal(getInvoiceOutstanding(state.invoices[0]),due+100000);assert.equal(validateRotApplications(state).receivableAdjustmentCents,100000);validateSuiteState(state);
  noMutation(state,()=>repayRotApplication(state,id,{date:'2026-10-15',amountCents:900000,reason:'För stort',reference:'KRAV-2'}),/överstiger/);
});
test('ROT-regler stoppar dubbla personer, saknade bekräftelser och fel beloppssumma', () => {
  const state=rotInvoice(),person={personId:'SAME',name:'A',allocationCents:600000,availableCents:5000000,eligibleConfirmed:true};
  noMutation(state,()=>createRotPlan(state,state.invoices[0].id,{date:'2026-10-01',participants:[person,person]}),/Samma person/);
  noMutation(state,()=>createRotPlan(state,state.invoices[0].id,{date:'2026-10-01',participants:[person]}),/summera/);
  noMutation(planState(),()=>prepareRotApplication(planState(),planState().rotPlans[0].id,{date:'2026-10-11',workCompletedConfirmed:false,electronicPaymentConfirmed:true}),/Bekräfta/);
});
test('ROT-delbegäran kan förberedas i januari men inte efter fristen', () => {
  let state=planState();state=receivePayment(state,state.invoices[0].id,{date:'2026-12-20',amountCents:2600000,reference:'dec'});
  const january=prepareRotApplication(state,state.rotPlans[0].id,{date:'2027-01-15',workCompletedConfirmed:true,electronicPaymentConfirmed:true});assert.equal(january.rotApplications[0].requestedCents,600000);
  noMutation(state,()=>prepareRotApplication(state,state.rotPlans[0].id,{date:'2027-02-01',workCompletedConfirmed:true,electronicPaymentConfirmed:true}),/31 januari/);
});
test('ROT-historik och hänvisning till faktiska betalningar kontrolleras', () => {
  const state=partial();for(const mutate of [s=>s.rotPlans[0].participants[0].allocationCents+=100,s=>s.rotApplications[0].requestedCents+=100,s=>s.rotApplications[0].basisPayments[0].amountCents++,s=>s.invoices[0].rot.approvedCents--]){const changed=structuredClone(state);mutate(changed);assert.throws(()=>validateRotApplications(changed));}
});
