import { createCustomer, createEmptyState, createInvoice, legacyZeroVatFixture, invoiceTestParty, invoiceTestExemption } from './fixtures/bokforing-compliant-invoices.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountBalance } from '../public/bokforing/suite/core.js';
import { issueInvoice, receivePayment, getInvoiceOutstanding, requestRot, decideRot } from '../public/bokforing/suite/sales.js';
import { calculateLineAmounts, calculateRot } from '../public/bokforing/suite/rot.js';
import { calculateTaxTransaction, postTaxTransaction, reverseTaxTransaction, getTaxDeclarationReport, taxReportCsv } from '../public/bokforing/suite/tax-ledger.js';
import { createRotPlan, prepareRotApplication, decideRotApplication, receiveRotApplicationPayment, repayRotApplication } from '../public/bokforing/suite/rot-extended.js';
import { createCreditNote } from '../public/bokforing/suite/settlements.js';
import { getRotCreditState, prepareCorrectedRotRequest, decideCorrectedRotRequest, receiveCorrectedRotPayment, repayCorrectedRot, getRotCreditClosingIssues } from '../public/bokforing/suite/rot-credit.js';
import { createDeclaration } from '../public/bokforing/suite/declarations.js';
import { createCashState, createCashDocument, issueCashDocument, payCashDocument } from '../public/bokforing/suite/cash-method.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

// Independent audit scenarios, reviewed 2026-10-23. This is not authority approval.
// SKV VAT box meanings, including separate bases/output/input and net tax:
// https://www.skatteverket.se/foretag/moms/deklareramoms/fyllaimomsdeklarationen.4.3a2a542410ab40a421c80004214.html
// SKV ROT 2026: 30% of labor incl. VAT, 50,000 kr/person/year, 75,000 kr
// combined ROT/RUT; material, travel and administration are excluded:
// https://www.skatteverket.se/foretag/skatterochavdrag/rotochrut/safungerarrotavdraget
// SKV: partial payment gives the same proportion of ROT; electronic payment,
// completed work, payment-year assignment and 31 January following-year deadline:
// https://www.skatteverket.se/privat/fastigheterochbostad/rotarbeteochrutarbete/safungerarrotavdraget.4.5947400c11f47f7f9dd80004014.html
// Whole-krona request truncation: HUSFL (2009:194), 5 §:
// https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-2009194-om-forfarandet-vid-skattereduktion_sfs-2009-194/
// The tests verify the
// demo's current model, not actual eligibility, external tax capacity or filing.
let scenarioNumber = 0;
const scenario = (name, body) => test(`AUDIT-TAXROT-${String(++scenarioNumber).padStart(3, '0')} ${name}`, body);
const verify = state => { assert.equal(validateSuiteState(state), state); return state; };
const untouched = (state, operation, pattern) => { const before = JSON.stringify(state); assert.throws(operation, pattern); assert.equal(JSON.stringify(state), before); };
const empty = () => createCustomer(createEmptyState(), { name: 'Fiktiv ROT-kund', email: 'audit@example.test' });
const row = (kind = 'labor', patch = {}) => ({ kind, description: kind === 'labor' ? 'Arbete' : kind === 'material' ? 'Material' : 'Resor', quantity: 1, unitCents: 100000, vatRate: 25, ...patch });
const rot = patch => ({ paymentYear: 2026, personId: 'AUDIT-A', property: 'DEMO 1:1', eligibleConfirmed: true, availableCents: 5000000, ...patch });
function invoice({ lines = [row(), row('material', { unitCents: 40000 }), row('other', { unitCents: 10000 })], ...patch } = {}) {
  let state = empty();
  state = createInvoice(state, { customerId: state.customers[0].id, date: '2026-10-01', dueDate: '2026-10-31', vatMode: 'standard', lines, rot: rot(), ...patch });
  return verify(issueInvoice(state, state.invoices[0].id));
}
const participants = () => [{ personId: 'AUDIT-A', name: 'A', allocationCents: 25000, availableCents: 5000000, eligibleConfirmed: true }, { personId: 'AUDIT-B', name: 'B', allocationCents: 12500, availableCents: 5000000, eligibleConfirmed: true }];
function plan() { const state = invoice(); return verify(createRotPlan(state, state.invoices[0].id, { date: '2026-10-01', participants: participants() })); }
const applicationPayload = { date: '2026-10-04', workCompletedConfirmed: true, electronicPaymentConfirmed: true };
function applied(amountCents = 150000) {
  let state = plan(); state = receivePayment(state, state.invoices[0].id, { date: '2026-10-02', amountCents, reference: 'CUSTOMER-1' });
  return verify(prepareRotApplication(state, state.rotPlans[0].id, applicationPayload));
}
function decided() { const state = applied(); return verify(decideRotApplication(state, state.rotApplications[0].id, { date: '2026-10-05' })); }
function paid() { const state = decided(); return verify(receiveRotApplicationPayment(state, state.rotApplications[0].id, { date: '2026-10-06', amountCents: 37500, reference: 'SKV-1' })); }
const creditPayload = (state, patch = {}) => ({ side: 'customer', documentId: state.invoices[0].id, date: '2026-10-15', reason: 'Minskat arbete', reference: 'CREDIT-1', lines: [{ index: 0, netCents: 40000 }], specialReviewed: true, rotCaseAdjusted: true, taxReference: 'EXTERNAL-1', taxRefundConfirmed: true, ...patch });
function credited(patch = {}) { const state = invoice(); return verify(createCreditNote(state, creditPayload(state, patch))); }
function correctedRequest() {
  let state = credited(); state = receivePayment(state, state.invoices[0].id, { date: '2026-10-16', amountCents: 115000, reference: 'CORRECTED-CUSTOMER' });
  return verify(prepareCorrectedRotRequest(state, state.invoices[0].id, { date: '2026-10-17', reference: 'CORRECTED-REQUEST', workCompletedConfirmed: true, electronicPaymentConfirmed: true }));
}
function correctedDecision() { const state = correctedRequest(); return verify(decideCorrectedRotRequest(state, state.invoices[0].id, { date: '2026-10-18', requestId: state.rotCreditEvents.at(-1).id, approvedCents: 22500, reference: 'CORRECTED-DECISION' })); }
function correctedPaid() { const state = correctedDecision(); return verify(receiveCorrectedRotPayment(state, state.invoices[0].id, { date: '2026-10-19', requestId: state.rotCreditEvents.find(e => e.kind === 'request').id, amountCents: 22500, reference: 'CORRECTED-RECEIPT' })); }
const taxPayload = (patch = {}) => ({ kind: 'domestic-purchase', date: '2026-10-03', reference: 'AUDIT-TAX', counterparty: 'Fiktiv leverantör', country: 'SE', netCents: 123457, vatRate: 25, deductibleBps: 10000, account: '4010', conditionsConfirmed: true, ...patch });
const kinds = [
  ['domestic-purchase', 'SE', null, false, false, true],
  ['domestic-reverse-goods-purchase', 'SE', '23', true, false, true],
  ['domestic-reverse-service-purchase', 'SE', '24', true, false, true],
  ['eu-goods-purchase', 'DE', '20', true, false, true],
  ['eu-service-purchase', 'FI', '21', true, false, true],
  ['non-eu-service-purchase', 'US', '22', true, false, true],
  ['import-vat', 'GB', '50', true, true, true],
  ['domestic-sale', 'SE', '05', false, false, false],
  ['eu-goods-sale', 'FR', '35', false, false, false],
  ['eu-service-sale', 'NL', '39', false, false, false],
  ['export-sale', 'NO', '36', false, false, false],
  ['non-eu-service-sale', 'CH', '40', false, false, false],
];
// The expected accounts/boxes are prescribed here, not imported from production.
for (const [kind, country, basis, reverse, imported, purchase] of kinds) {
  const exempt = !purchase && kind !== 'domestic-sale';
  for (const rate of exempt ? [0] : [6, 12, 25]) for (const bps of purchase ? [0, 3333, 10000] : [0]) {
    scenario(`VAT ${kind}, ${rate}%, deductible ${bps}/10000`, () => {
      const vat = Math.round(123457 * rate / 100), deductible = purchase ? Math.round(vat * bps / 10000) : 0;
      const state = verify(postTaxTransaction(empty(), taxPayload({ kind, country, vatRate: rate, deductibleBps: bps, vatNumber: country + '12345678' })));
      const record = state.taxTransactions[0], report = getTaxDeclarationReport(state);
      if (basis) assert.equal(report.boxes[basis], 123457);
      assert.equal(report.boxes['48'], deductible);
      assert.equal(report.boxes['49'], (purchase && !reverse ? 0 : vat) - deductible);
      assert.equal(accountBalance(state, '1930'), imported ? 0 : purchase ? -(123457 + (reverse ? 0 : vat)) : 123457 + vat);
      if (purchase) assert.equal(accountBalance(state, '4010'), (imported ? 0 : 123457) + vat - deductible);
      if (vat && (!purchase || reverse)) {
        const outputBox = (imported ? {6:'62',12:'61',25:'60'} : reverse ? {6:'32',12:'31',25:'30'} : {6:'12',12:'11',25:'10'})[rate];
        assert.equal(report.boxes[outputBox], vat);
      }
      assert.equal(report.reconciled, true); assert.equal(report.evidence.length, 1);
      assert.equal(record.rows.reduce((v, r) => v + r.debitCents - r.creditCents, 0), 0);
    });
  }
}
for (const kind of ['domestic-sale', 'domestic-purchase']) scenario(`zero-rated supported ${kind}`, () => {
  const state = verify(postTaxTransaction(empty(), taxPayload({ kind, vatRate: 0, ...(kind === 'domestic-sale' ? {vatExemption:{...invoiceTestExemption}} : {}) })));
  assert.equal(getTaxDeclarationReport(state).boxes['49'], 0); assert.equal(Math.abs(accountBalance(state, '1930')), 123457);
});
for (const net of [1, 2, 49, 50, 51, 99, 100, 101, 399, 401]) scenario(`mixed VAT aggregates before whole-krona export, base ${net}`, () => {
  let state = empty(); let output = 0; let expectedBase = 0;
  for (const rate of [6, 12, 25]) { state = postTaxTransaction(state, taxPayload({ kind: 'domestic-sale', netCents: net, vatRate: rate, reference: `rate-${rate}` })); output += Math.round(net * rate / 100); expectedBase += net; }
  verify(state); const report = getTaxDeclarationReport(state); assert.equal(report.boxes['05'], expectedBase); assert.equal(report.boxes['49'], output);
  const csv = taxReportCsv(state); assert.ok(csv.split('\r\n').some(line => line.startsWith(`05;Momspliktig försäljning;${expectedBase};${Math.trunc(expectedBase / 100)};`)));
});
const invalidTax = [
 ['unknown kind', {kind:'unknown'}], ['invalid date', {date:'2026-02-30'}], ['empty reference',{reference:''}], ['control reference',{reference:'a\nb'}], ['long reference',{reference:'x'.repeat(161)}],
 ['empty counterparty',{counterparty:' '}], ['bad country',{country:'SWE'}], ['foreign domestic',{country:'NO'}], ['zero amount',{netCents:0}], ['negative amount',{netCents:-1}], ['fractional amount',{netCents:1.5}], ['large amount',{netCents:1e12+1}],
 ['unsupported rate',{vatRate:13}], ['string rate',{vatRate:'25'}], ['negative deductible',{deductibleBps:-1}], ['excess deductible',{deductibleBps:10001}], ['fractional deductible',{deductibleBps:0.5}], ['unconfirmed',{conditionsConfirmed:false}], ['string confirmation',{conditionsConfirmed:'true'}], ['protected account',{account:'1930'}],
 ['EU Sweden',{kind:'eu-goods-purchase',country:'SE'}], ['EU Norway',{kind:'eu-service-purchase',country:'NO'}], ['import EU',{kind:'import-vat',country:'DE'}], ['nonEU Sweden',{kind:'non-eu-service-purchase',country:'SE'}], ['export EU',{kind:'export-sale',country:'FR'}],
 ['reverse no VAT',{kind:'eu-service-purchase',country:'DE',vatRate:0}], ['EU sale missing VAT',{kind:'eu-goods-sale',country:'DE'}], ['EU sale malformed VAT',{kind:'eu-service-sale',country:'NL',vatNumber:'123'}], ['VAT control',{vatNumber:'SE\n123'}], ['VAT too long',{vatNumber:'S'.repeat(31)}],
];
for (const [name, patch] of invalidTax) scenario(`reject VAT ${name} atomically`, () => { const state = empty(); untouched(state, () => postTaxTransaction(state, taxPayload(patch))); });
for (const [kind, country] of kinds) scenario(`reversal preserves original and moves ${kind} to correction date`, () => {
  let state = postTaxTransaction(empty(), taxPayload({ kind, country, vatNumber: country+'123456' })); const original = structuredClone(state.taxTransactions[0]);
  state = verify(reverseTaxTransaction(state, original.id, { date:'2026-11-01', reason:'Felaktigt underlag' }));
  assert.deepEqual(state.taxTransactions[0], original); const all = getTaxDeclarationReport(state); assert.ok(Object.values(all.boxes).every(amount => amount === 0));
  const october = getTaxDeclarationReport(state,{from:'2026-10-01',to:'2026-10-31'}), november = getTaxDeclarationReport(state,{from:'2026-11-01',to:'2026-11-30'});
  for (const key of Object.keys(october.boxes)) assert.equal(october.boxes[key] + november.boxes[key], 0);
  untouched(state, () => reverseTaxTransaction(state, original.id,{date:'2026-11-02',reason:'Dubbel rättelse'}));
});
const taxMutations = [
 ['net',s=>s.taxTransactions[0].netCents++], ['rate',s=>s.taxTransactions[0].vatRate=12], ['deductible',s=>s.taxTransactions[0].deductibleBps=0], ['country',s=>s.taxTransactions[0].country='US'], ['reference',s=>s.taxTransactions[0].reference='changed'], ['counterparty',s=>s.taxTransactions[0].counterparty='changed'], ['snapshot',s=>s.taxTransactions[0].bookingSnapshot='bad'], ['tax boxes',s=>s.taxTransactions[0].boxes['48']++], ['source row',s=>s.taxTransactions[0].rows[0].debitCents++], ['journal',s=>s.entries.find(e=>e.id===s.taxTransactions[0].entryId).rows[0].debitCents++], ['bank amount',s=>s.bankTransactions[0].amountCents++], ['bank date',s=>s.bankTransactions[0].date='2026-10-04'], ['bank account',s=>s.bankTransactions[0].account='1910'], ['missing bank',s=>s.bankTransactions=[]], ['missing entry',s=>s.entries=[]], ['duplicate source',s=>s.taxTransactions.push(structuredClone(s.taxTransactions[0]))],
];
for (const [name, mutate] of taxMutations) scenario(`full validation rejects altered VAT ${name}`, () => { const state=postTaxTransaction(empty(),taxPayload()); mutate(state); assert.throws(()=>validateSuiteState(state)); });
// A separate arithmetic oracle using ordinary exact-range integer arithmetic.
function lineOracle(line, discount=0) { let value=Math.round(line.unitCents*line.quantity); value-=Math.round(value*(line.discountBps??0)/10000); value-=Math.round(value*(line.chargeType?0:discount)/10000); const net=line.unitPriceIncludesVat?Math.round(value*100/(100+line.vatRate)):value; const vat=line.unitPriceIncludesVat?value-net:Math.round(net*line.vatRate/100); return {netCents:net,vatCents:vat,grossCents:net+vat}; }
for (const vatRate of [0,6,12,25]) for (const includes of [false,true]) for (const [discountBps,invoiceDiscount] of [[0,0],[1000,0],[0,1750],[2500,1250]]) scenario(`line oracle VAT ${vatRate}, inclusive ${includes}, discounts ${discountBps}/${invoiceDiscount}`,()=>{
  const line=row('material',{unitCents:12345,quantity:2.25,vatRate,unitPriceIncludesVat:includes,discountBps}); assert.deepEqual(calculateLineAmounts(line,'standard',invoiceDiscount),lineOracle(line,invoiceDiscount));
});
const basisScenarios = [
 ['labor only',[row()],0], ['material excluded',[row(),row('material')],0], ['travel excluded',[row(),row('other')],0], ['explicit labor excluded',[row(),row('labor',{rotEligible:false})],0], ['row rebate',[row('labor',{discountBps:1250})],0], ['invoice rebate',[row()],2300], ['both rebates',[row('labor',{discountBps:1500})],1750], ['VAT inclusive',[row('labor',{unitPriceIncludesVat:true})],0], ['fractional quantity',[row('labor',{quantity:0.37,unitCents:11111})],0], ['fee no rebate',[row(),row('other',{quantity:1,unitCents:4900,chargeType:'invoice-fee'})],2000], ['two eligible labor',[row(),row('labor',{unitCents:33333,discountBps:1100})],500], ['material different VAT',[row(),row('material',{vatRate:6,unitCents:99999})],0],
];
for (const [name,lines,discount] of basisScenarios) scenario(`ROT basis ${name}`,()=>{ const labor=lines.filter(l=>l.kind==='labor'&&l.rotEligible!==false).reduce((v,l)=>v+lineOracle(l,discount).grossCents,0); const actual=calculateRot({vatMode:'standard',rot:rot(),lines,invoiceDiscountBps:discount}); assert.equal(actual.laborGrossCents,labor); assert.equal(actual.deductionCents,Math.floor(labor*0.3/100)*100); });
for (const [available,remaining,expected] of [[5000000,5000000,5000000],[2500000,5000000,2500000],[123456,5000000,123400],[5000000,123456,123400],[0,5000000,0],[5000000,0,0],[99,5000000,0],[5000000,100,100]]) scenario(`ROT cap available ${available}, remaining ${remaining}`,()=>{ const actual=calculateRot({vatMode:'standard',rot:rot({availableCents:available,remainingCents:remaining}),lines:[row('labor',{unitCents:20000000})]}); assert.equal(actual.deductionCents,expected); });
const invalidRot = [
 ['wrong year',{rot:rot({paymentYear:2025})}],['future year',{rot:rot({paymentYear:2027})}],['unconfirmed',{rot:rot({eligibleConfirmed:false})}],['missing property',{rot:rot({property:''})}],['missing person',{rot:rot({personId:''})}],['negative capacity',{rot:rot({availableCents:-100})}],['fractional capacity',{rot:rot({availableCents:0.1})}],['reverse VAT',{vatMode:'reverse-construction'}],['no lines',{lines:[]}],['material only',{lines:[row('material')]}],['travel only',{lines:[row('other')]}],['excluded labor only',{lines:[row('labor',{rotEligible:false})]}],['6% labor',{lines:[row('labor',{vatRate:6})]}],['12% labor',{lines:[row('labor',{vatRate:12})]}],['material falsely eligible',{lines:[row('material',{rotEligible:true})]}],['negative remaining',{rot:rot({remainingCents:-100})}],
];
for (const [name,patch] of invalidRot) scenario(`reject ROT ${name}`,()=>assert.throws(()=>calculateRot({vatMode:'standard',rot:rot(),lines:[row()],...patch})));
const partialCases = [[400,[100,0]],[799,[100,0]],[1000,[100,100]],[3333,[500,300]],[9999,[1600,800]],[10000,[1700,800]],[37500,[6200,3100]],[50000,[8300,4200]],[74999,[12500,6200]],[75000,[12500,6200]],[149999,[24900,12500]],[150000,[25000,12500]]];
for (const [amount,expected] of partialCases) scenario(`two-person partial ROT from customer payment ${amount}`,()=>{const state=applied(amount);assert.deepEqual(state.rotApplications[0].personLines.map(x=>x.amountCents),expected);assert.equal(state.rotApplications[0].requestedCents,expected[0]+expected[1]);});
const invalidPeople = [
 ['same ID',p=>p[1].personId='AUDIT-A'],['normalized duplicate',p=>p[1].personId='a u d i t - a'],['missing name',p=>p[0].name=''],['missing identity',p=>p[0].personId=''],['unconfirmed person',p=>p[0].eligibleConfirmed=false],['insufficient capacity',p=>p[0].availableCents=24900],['fractional allocation',p=>p[0].allocationCents=24999],['excess allocation',p=>p[0].allocationCents=5000100],['wrong sum',p=>p[0].allocationCents=24000],['zero allocation',p=>p[0].allocationCents=0],
];
for (const [name,mutate] of invalidPeople) scenario(`reject ROT plan ${name} atomically`,()=>{const state=invoice(),people=participants();mutate(people);untouched(state,()=>createRotPlan(state,state.invoices[0].id,{date:'2026-10-01',participants:people}));});
for (const [date,accepted] of [['2026-10-02',true],['2027-01-01',true],['2027-01-31',true],['2027-02-01',false]]) scenario(`application deadline ${date}`,()=>{let state=plan();state=receivePayment(state,state.invoices[0].id,{date:'2026-10-02',amountCents:150000,reference:'CUSTOMER'});if(accepted){state=verify(prepareRotApplication(state,state.rotPlans[0].id,{...applicationPayload,date}));assert.equal(state.rotApplications[0].requestedCents,37500);}else untouched(state,()=>prepareRotApplication(state,state.rotPlans[0].id,{...applicationPayload,date}));});
for (const [name,patch] of [['work unconfirmed',{workCompletedConfirmed:false}],['payment unconfirmed',{electronicPaymentConfirmed:false}],['before payment',{date:'2026-10-01'}],['malformed date',{date:'2026-13-01'}]]) scenario(`reject application ${name} atomically`,()=>{let state=plan();state=receivePayment(state,state.invoices[0].id,{date:'2026-10-02',amountCents:150000,reference:'CUSTOMER'});untouched(state,()=>prepareRotApplication(state,state.rotPlans[0].id,{...applicationPayload,...patch}));});
const appMutations = [
 ['plan person',s=>s.rotPlans[0].participants[0].personId='changed'],['plan allocation',s=>s.rotPlans[0].participants[0].allocationCents+=100],['plan date',s=>s.rotPlans[0].date='2026-09-30'],['plan snapshot',s=>s.rotPlans[0].bookingSnapshot='bad'],['request amount',s=>s.rotApplications[0].requestedCents+=100],['request person',s=>s.rotApplications[0].personLines[0].personId='changed'],['basis amount',s=>s.rotApplications[0].basisPayments[0].amountCents++],['basis id',s=>s.rotApplications[0].basisPayments[0].id='missing'],['basis date',s=>s.rotApplications[0].basisPayments[0].date='2026-10-03'],['request snapshot',s=>s.rotApplications[0].bookingSnapshot='bad'],['approved summary',s=>s.invoices[0].rot.approvedCents++],['request year',s=>s.rotApplications[0].paymentYear=2027],
];
for (const [name,mutate] of appMutations) scenario(`full validation rejects altered ROT ${name}`,()=>{const state=applied();mutate(state);assert.throws(()=>validateSuiteState(state));});
for (const [a,b] of [[25000,12500],[0,12500],[25000,0],[10000,5000],[0,0]]) scenario(`ROT decision ${a}/${b} preserves customer debt`,()=>{let state=applied();state=verify(decideRotApplication(state,state.rotApplications[0].id,{date:'2026-10-05',approvedByPerson:{'AUDIT-A':a,'AUDIT-B':b},reason:'Otillräckligt utrymme'}));assert.equal(state.invoices[0].rot.approvedCents,a+b);assert.equal(getInvoiceOutstanding(state.invoices[0]),37500);});
for (const amount of [1,100,12345,37500]) scenario(`received ROT ${amount} reduces receivable only`,()=>{const before=decided();const state=verify(receiveRotApplicationPayment(before,before.rotApplications[0].id,{date:'2026-10-06',amountCents:amount,reference:'SKV'}));assert.equal(accountBalance(state,'1510'),37500-amount);assert.equal(accountBalance(state,'1930'),150000+amount);assert.equal(accountBalance(state,'3000'),-150000);assert.equal(accountBalance(state,'2611'),-37500);});
for (const amount of [1,100,12000,37500]) scenario(`returned ROT ${amount} reopens receivable without new sales/VAT`,()=>{const before=paid();const state=verify(repayRotApplication(before,before.rotApplications[0].id,{date:'2026-10-07',amountCents:amount,reference:'RECOVERY',reason:'Beslut om återkrav'}));assert.equal(accountBalance(state,'1510'),amount);assert.equal(accountBalance(state,'1930'),187500-amount);assert.equal(accountBalance(state,'3000'),-150000);assert.equal(accountBalance(state,'2611'),-37500);});
for (const [name,patch] of [['overpayment',{amountCents:37501}],['zero',{amountCents:0}],['negative',{amountCents:-1}],['before decision',{date:'2026-10-04'}],['empty ref',{reference:''}]]) scenario(`reject ROT receipt ${name}`,()=>{const state=decided();untouched(state,()=>receiveRotApplicationPayment(state,state.rotApplications[0].id,{date:'2026-10-06',amountCents:37500,reference:'SKV',...patch}));});
for (const [name,patch] of [['excess recovery',{amountCents:37501}],['zero recovery',{amountCents:0}],['before receipt',{date:'2026-10-05'}],['empty reason',{reason:''}],['empty reference',{reference:''}]]) scenario(`reject ROT repayment ${name}`,()=>{const state=paid();untouched(state,()=>repayRotApplication(state,state.rotApplications[0].id,{date:'2026-10-07',amountCents:10000,reference:'RECOVERY',reason:'Återkrav',...patch}));});
for (const [index,net,expected] of [[0,1,37400],[0,100,37400],[0,1000,37100],[0,33333,25000],[0,40000,22500],[0,99999,0],[0,100000,0],[1,1,37500],[1,20000,37500],[1,40000,37500],[2,5000,37500],[2,10000,37500]]) scenario(`credit row ${index} net ${net}: remaining ROT ${expected}`,()=>{const state=credited({lines:[{index,netCents:net}]});assert.equal(getRotCreditState(state,state.invoices[0].id).allowedCents,expected);const report=getTaxDeclarationReport(state);assert.equal(report.boxes['05'],150000-net);assert.equal(report.reconciled,true);});
for (const [name,patch] of [['unreviewed',{specialReviewed:false}],['unadjusted case',{rotCaseAdjusted:false}],['empty authority reference',{taxReference:''}],['before invoice',{date:'2026-09-30'}],['excess labor credit',{lines:[{index:0,netCents:100001}]}]]) scenario(`reject ROT credit ${name}`,()=>{const state=invoice();untouched(state,()=>createCreditNote(state,creditPayload(state,patch)));});
scenario('paid credit requires actual tax refund confirmation',()=>{const state=paid();untouched(state,()=>createCreditNote(state,creditPayload(state,{taxRefundConfirmed:false})));});
scenario('paid labor credit repays tax without rewriting original applications',()=>{const before=paid(),apps=structuredClone(before.rotApplications),entries=structuredClone(before.entries);const state=verify(createCreditNote(before,creditPayload(before)));assert.equal(getRotCreditState(state,state.invoices[0].id).repaidCents,15000);assert.deepEqual(state.rotApplications,apps);assert.deepEqual(state.entries.slice(0,entries.length),entries);});
scenario('corrected request has exactly remaining deduction and no accounting entry',()=>{const state=correctedRequest();assert.equal(state.rotCreditEvents.at(-1).requestedCents,22500);assert.equal(state.entries.length,3);assert.ok(getRotCreditClosingIssues(state).length>0);});
scenario('completed corrected request clears closing issue and receivable',()=>{const state=correctedPaid();assert.equal(getInvoiceOutstanding(state.invoices[0]),0);assert.deepEqual(getRotCreditClosingIssues(state),[]);assert.equal(accountBalance(state,'1510'),0);});
for(const amount of [100,7500,22500]) scenario(`corrected recovery ${amount} reopens only bank/receivable`,()=>{const state=correctedPaid();const next=verify(repayCorrectedRot(state,state.invoices[0].id,{date:'2026-10-20',amountCents:amount,reference:'RECOVERY',reason:'Återkrav',paymentConfirmed:true}));assert.equal(accountBalance(next,'1510'),amount);assert.equal(accountBalance(next,'1930'),137500-amount);assert.equal(accountBalance(next,'2611'),-27500);assert.equal(accountBalance(next,'3000'),-110000);});
const creditMutations=[['allowed',s=>s.rotCreditEvents[0].allowedCents++],['date',s=>s.rotCreditEvents[0].date='2026-09-01'],['reference',s=>s.rotCreditEvents[0].externalReference='bad'],['snapshot',s=>s.rotCreditEvents[0].snapshot='bad'],['original person',s=>s.rotCreditEvents[0].original.rot.personId='other'],['missing event',s=>s.rotCreditEvents=[]],['duplicated event',s=>s.rotCreditEvents.push(structuredClone(s.rotCreditEvents[0]))],['settlement amount',s=>s.settlements[0].amountCents++],['invoice approved',s=>s.invoices[0].rot.approvedCents++],['invoice version',s=>s.invoices[0].rotCreditVersion++]];
for(const [name,mutate] of creditMutations)scenario(`full validation rejects changed credit ${name}`,()=>{const state=credited();mutate(state);assert.throws(()=>validateSuiteState(state));});
for(const kind of ['tax post','tax reverse','ROT receipt','ROT repayment','ROT credit','corrected request','corrected recovery']) scenario(`locked month stops ${kind} atomically`,()=>{
 let state,operation;
 if(kind==='tax post'){state=empty();operation=()=>postTaxTransaction(state,taxPayload());}
 if(kind==='tax reverse'){state=postTaxTransaction(empty(),taxPayload());operation=()=>reverseTaxTransaction(state,state.taxTransactions[0].id,{date:'2026-10-04',reason:'Rättelse'});}
 if(kind==='ROT receipt'){state=decided();operation=()=>receiveRotApplicationPayment(state,state.rotApplications[0].id,{date:'2026-10-06',amountCents:100,reference:'SKV'});}
 if(kind==='ROT repayment'){state=paid();operation=()=>repayRotApplication(state,state.rotApplications[0].id,{date:'2026-10-07',amountCents:100,reference:'RECOVERY',reason:'Återkrav'});}
 if(kind==='ROT credit'){state=invoice();operation=()=>createCreditNote(state,creditPayload(state));}
 if(kind==='corrected request'){state=credited();operation=()=>prepareCorrectedRotRequest(state,state.invoices[0].id,{date:'2026-10-17',reference:'REQUEST',workCompletedConfirmed:true,electronicPaymentConfirmed:true});}
 if(kind==='corrected recovery'){state=correctedPaid();operation=()=>repayCorrectedRot(state,state.invoices[0].id,{date:'2026-10-20',amountCents:100,reference:'RECOVERY',reason:'Återkrav',paymentConfirmed:true});}
 state.lockedPeriods=['2026-10'];untouched(state,operation,/låst/);
});
function sixPersonPlan() {
  let state=invoice({lines:[row('labor',{unitCents:13600})]});
  return verify(createRotPlan(state,state.invoices[0].id,{date:'2026-10-01',participants:[1500,1500,900,500,500,200].map((allocationCents,index)=>({personId:`SIX-${index}`,name:`Person ${index}`,allocationCents,availableCents:5000000,eligibleConfirmed:true}))}));
}
for(const [firstPaid,nextPaid,firstShares,nextShares] of [
 [1189,1400,[100,100,100,100,100,0],[200,100,100,100,100,0]],
 [5834,6067,[700,700,400,300,300,100],[800,700,400,300,300,100]],
]) scenario(`partial ROT preserves submitted person shares at ${firstPaid} -> ${nextPaid}`,()=>{
 let state=sixPersonPlan();
 state=receivePayment(state,state.invoices[0].id,{date:'2026-10-02',amountCents:firstPaid,reference:'FIRST'});
 state=verify(prepareRotApplication(state,state.rotPlans[0].id,{...applicationPayload,date:'2026-10-03'}));
 assert.deepEqual(state.rotApplications[0].personLines.map(p=>p.amountCents),firstShares);
 const frozen=structuredClone(state.rotApplications[0]);
 state=receivePayment(state,state.invoices[0].id,{date:'2026-10-04',amountCents:nextPaid-firstPaid,reference:'SECOND'});
 state=verify(prepareRotApplication(state,state.rotPlans[0].id,{...applicationPayload,date:'2026-10-05'}));
 assert.deepEqual(state.rotApplications[0],frozen);
 assert.deepEqual(state.rotApplications[0].personLines.map((p,i)=>p.amountCents+state.rotApplications[1].personLines[i].amountCents),nextShares);
 assert.ok(state.rotApplications[1].personLines.every(p=>p.amountCents>=0));
 state=receivePayment(state,state.invoices[0].id,{date:'2026-10-06',amountCents:11900-nextPaid,reference:'FINAL'});
 state=verify(prepareRotApplication(state,state.rotPlans[0].id,{...applicationPayload,date:'2026-10-07'}));
 assert.deepEqual(state.rotApplications[0].personLines.map((p,i)=>state.rotApplications.reduce((sum,a)=>sum+a.personLines[i].amountCents,0)),[1500,1500,900,500,500,200]);
});
function anotherInvoice(state,{personId='AUDIT-A',availableCents=5000000}={}) {
 state=createInvoice(state,{customerId:state.customers[0].id,date:'2026-10-10',dueDate:'2026-10-31',vatMode:'standard',lines:[row()],rot:rot({personId,availableCents})});
 return issueInvoice(state,state.invoices.at(-1).id);
}
for(const personId of ['AUDIT-A','audit-a','A U D I T - A'])scenario(`annual reservation normalizes identity ${personId}`,()=>{
 const state=verify(anotherInvoice(invoice(),{personId,availableCents:50000}));assert.equal(state.invoices[1].rot.reservedCents,12500);assert.equal(state.invoices[1].rot.remainingCents,12500);
});
scenario('independent person keeps separate annual capacity',()=>{const state=verify(anotherInvoice(invoice(),{personId:'OTHER',availableCents:50000}));assert.equal(state.invoices[1].rot.reservedCents,37500);});
scenario('fully reserved annual capacity rejects another issued invoice atomically',()=>{let state=invoice({rot:rot({availableCents:37500})});untouched(state,()=>anotherInvoice(state,{availableCents:37500}));});
scenario('legacy partial denial releases capacity without rewriting frozen originals',()=>{
 let state=invoice();state=receivePayment(state,state.invoices[0].id,{date:'2026-10-02',amountCents:150000,reference:'LEGACY-CUSTOMER'});state=requestRot(state,state.invoices[0].id,{date:'2026-10-03',workCompletedConfirmed:true,electronicPaymentConfirmed:true});state=verify(decideRot(state,state.invoices[0].id,{date:'2026-10-04',approvedCents:10000,reason:'Begränsat utrymme'}));const frozen=state.invoices[0].bookingSnapshot;state=verify(anotherInvoice(state,{availableCents:50000}));assert.equal(state.invoices[1].rot.reservedCents,37500);assert.equal(state.invoices[0].bookingSnapshot,frozen);
});
for(const [name,create] of [['VAT',()=>postTaxTransaction(empty(),taxPayload())],['ROT plan',plan],['partial application',applied],['paid ROT',paid],['credit',credited],['corrected paid ROT',correctedPaid]])scenario(`JSON reload retains validated ${name}`,()=>{const state=create(),reloaded=JSON.parse(JSON.stringify(state));verify(reloaded);assert.deepEqual(reloaded,state);});
scenario('multi-person invoice cannot prepare automatic corrected request after credit',()=>{let state=paid();state=verify(createCreditNote(state,creditPayload(state)));untouched(state,()=>prepareCorrectedRotRequest(state,state.invoices[0].id,{date:'2026-10-16',reference:'MULTI-CORRECTION',workCompletedConfirmed:true,electronicPaymentConfirmed:true}),/personvis/);});
for(const date of ['2027-01-01','2027-01-31'])scenario(`2027 customer payment remains outside explicit 2026 ROT model ${date}`,()=>{const state=invoice();untouched(state,()=>receivePayment(state,state.invoices[0].id,{date,amountCents:100,reference:'NEXT-YEAR'}));});
// F13: zero percent does not identify the legal VAT treatment. Until native
// sales have explicit classification, keep their old figures visible and stop
// declaration creation. Never infer a blanket move from field 05 to field 42.
const vatDeclaration = {kind:'vat',orgNumber:'5560269986',from:'2026-10-01',to:'2026-12-31',reviewed:true,createdAt:'2026-10-23T12:00:00Z'};
const unknownZero = report => report.warnings.some(message=>/0 %.*momsklassificering/.test(message));
for(const lines of [[row('material',{vatRate:0})],[row(),row('other',{vatRate:0})]])scenario(`unclassified native zero-VAT ${lines.length===1?'sole':'mixed'} invoice blocks declaration`,()=>{
 const state=verify(legacyZeroVatFixture(lines.length===1?'sole':'mixed'));const report=getTaxDeclarationReport(state);
 assert.equal(report.boxes['05'],lines.reduce((sum,l)=>sum+l.unitCents,0));assert.equal(report.boxes['42'],0);assert.equal(report.reconciled,true);assert.equal(unknownZero(report),true);
 assert.match(taxReportCsv(state),/Granskningsvarning;.*0 %.*momsklassificering/);
 untouched(state,()=>createDeclaration(state,vatDeclaration),/oklassificerade/);
});
scenario('unclassified direct domestic zero-VAT sale blocks declaration',()=>{
 const state=verify(legacyZeroVatFixture('direct'));
 const report=getTaxDeclarationReport(state);assert.equal(report.boxes['05'],123457);assert.equal(report.boxes['42'],0);assert.equal(unknownZero(report),true);
 untouched(state,()=>createDeclaration(state,vatDeclaration),/oklassificerade/);
});
scenario('prior-period zero-VAT invoice warns in its own period only',()=>{
 const state=verify(legacyZeroVatFixture('prior'));
 assert.equal(unknownZero(getTaxDeclarationReport(state,{from:'2026-09-01',to:'2026-09-30'})),true);
 assert.equal(unknownZero(getTaxDeclarationReport(state,{from:'2026-10-01',to:'2026-12-31'})),false);
 verify(createDeclaration(state,vatDeclaration));
});
scenario('zero-value discounted zero-VAT line does not create classification warning',()=>{
 const state=verify(legacyZeroVatFixture('discounted'));
 assert.equal(unknownZero(getTaxDeclarationReport(state)),false);verify(createDeclaration(state,vatDeclaration));
});
scenario('zero rounded VAT on a positive 6 percent rate remains explicitly taxable',()=>{
 const state=invoice({rot:null,lines:[row('material',{vatRate:6,unitCents:1})]});
 const report=getTaxDeclarationReport(state);assert.equal(report.boxes['05'],1);assert.equal(report.boxes['12'],0);assert.equal(unknownZero(report),false);verify(createDeclaration(state,vatDeclaration));
});
scenario('prior-period zero-VAT invoice credit warns in credit period',()=>{
 let state=verify(legacyZeroVatFixture('prior'));
 state=verify(createCreditNote(state,{side:'customer',documentId:state.invoices[0].id,date:'2026-10-15',reason:'Korrigerad prestation',reference:'ZERO-CREDIT',lines:[{index:0,netCents:50000}]}));
 const report=getTaxDeclarationReport(state,{from:'2026-10-01',to:'2026-12-31'});assert.equal(report.boxes['05'],-50000);assert.equal(unknownZero(report),true);untouched(state,()=>createDeclaration(state,vatDeclaration),/oklassificerade/);
});
scenario('known EU zero-VAT sale retains explicit field 35 without warning',()=>{
 const state=verify(postTaxTransaction(empty(),taxPayload({kind:'eu-goods-sale',country:'DE',vatNumber:'DE123456789',vatRate:0})));
 const report=getTaxDeclarationReport(state);assert.equal(report.boxes['35'],123457);assert.equal(unknownZero(report),false);verify(createDeclaration(state,vatDeclaration));
});
scenario('reviewed domestic exempt cash sale retains field 42 and declaration support',()=>{
 let state=createCashState({eligibilityConfirmed:true,expectedTurnoverCents:100000000,vatPeriod:'quarter'});
 state=createCashDocument(state,{side:'customer',partyName:'Fiktiv hyresgäst',partyAddress:'Exempelgatan 1',partyPostalCode:'12345',partyCity:'Demostaden',partyCountry:'SE',performance:{mode:'invoice-date',confirmed:true},vatExemption:{...invoiceTestExemption},reference:'EXEMPT-CASH',date:'2026-10-01',dueDate:'2026-10-31',supplyConfirmed:true,vatReason:'Granskat undantag för momsfri fastighetsuthyrning',lines:[{description:'Momsfri hyra',netCents:100000,vatRate:0}]});
 state=issueCashDocument(state,state.cashDocuments[0].id);state=verify(payCashDocument(state,state.cashDocuments[0].id,{date:'2026-10-02',amountCents:100000,reference:'EXEMPT-PAYMENT'}));
 const report=getTaxDeclarationReport(state);assert.equal(report.boxes['42'],100000);assert.equal(report.boxes['05'],0);assert.equal(unknownZero(report),false);verify(createDeclaration(state,vatDeclaration));
});
