import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, transact, accountBalance } from '../public/bokforing/suite/core.js';
import { normalizeVatExemption, validateVatExemption, vatExemptionBox, vatExemptionInvoiceText, VAT_EXEMPTION_REASONS } from '../public/bokforing/suite/vat-classification.js';
import { calculateTaxTransaction, postTaxTransaction, reverseTaxTransaction, getTaxDeclarationReport, validateTaxTransactions } from '../public/bokforing/suite/tax-ledger.js';
import { createInvoice, issueInvoice, creditInvoice, invoiceBookingSnapshot } from '../public/bokforing/suite/sales.js';
import { createCreditNote, getCreditSourceLines } from '../public/bokforing/suite/settlements.js';
import { createDeclaration, getDeclarationFile } from '../public/bokforing/suite/declarations.js';
import { renderWorkspace, handleAction } from '../public/bokforing/suite/tax-workspace.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

// Independent source checked 2026-10-23: ML (2023:200) 10:6–10,14–18,32–36,
// 12 kap and 17:24(13), and SKV's declaration instructions for box42.
// https://data.riksdagen.se/dokument/sfs-2023-200.html
// https://www.skatteverket.se/foretag/moms/deklareramoms/fyllaimomsdeklarationen.4.3a2a542410ab40a421c80004214.html
const exemption = (code = 'education', patch = {}) => ({ code, legalBasis: '10 kap. ML – utbildningens villkor och anordnare granskade', confirmed: true, ...patch });
const payload = (patch = {}) => ({ kind:'domestic-sale', date:'2026-10-12', reference:'TEST-EXEMPT', counterparty:'Fiktiv kund', country:'SE', netCents:123456, vatRate:0, conditionsConfirmed:true, vatExemption:exemption(), ...patch });
const noMutation = (state, operation, expression) => { const before = JSON.stringify(state); assert.throws(operation,expression);assert.equal(JSON.stringify(state),before); };
const open = () => transact(createEmptyState(), draft => { draft.customers.push({id:'customer',name:'Fiktiv kund AB',address:'Provvägen 1',postalCode:'12345',city:'Demostaden',country:'SE',email:''}); });
function invoice(lines = [{description:'Kurs',kind:'other',quantity:1,unitCents:50000,vatRate:0,vatExemption:exemption()}]) {
  let state = createInvoice(open(), {customerId:'customer',date:'2026-10-01',dueDate:'2026-10-31',vatMode:'standard',details:{performance:{mode:'invoice-date',confirmed:true}},lines});
  state=issueInvoice(state,state.invoices[0].id); return state;
}
function legacyDirect() {
  const state=postTaxTransaction(createEmptyState(),payload());const record=state.taxTransactions[0];
  delete record.vatExemption;delete record.vatClassificationVersion;record.boxes={'05':record.netCents};
  record.bookingSnapshot=JSON.stringify([record.kind,record.date,record.reference,record.counterparty,record.country,record.vatNumber,record.netCents,record.vatRate,record.deductibleBps,record.account,record.conditionsConfirmed,record.ruleVersion,record.originalId??null,record.rows,record.boxes,record.reason??null]);
  return state;
}

for(const item of VAT_EXEMPTION_REASONS) test(`VAT-EXEMPT: ${item.code} has explicit evidence and uses box42`,()=>{
  const actual=calculateTaxTransaction(payload({vatExemption:exemption(item.code)}));
  assert.deepEqual(actual.boxes,{'42':123456});assert.equal(actual.rows.filter(row=>row.account==='3000')[0].creditCents,123456);
  assert.equal(actual.vatClassificationVersion,1);assert.deepEqual(actual.vatExemption,exemption(item.code));
  const text=vatExemptionInvoiceText(exemption(item.code));assert.ok(text.includes(item.legalBasis));assert.ok(text.includes('Undantag från skatteplikt'));
});
test('VAT-EXEMPT: incomplete draft classification can be saved but cannot be treated as reviewed',()=>{
  const draft=normalizeVatExemption({code:'education',legalBasis:'',confirmed:false});assert.deepEqual(draft,{code:'education',legalBasis:'',confirmed:false});
  assert.throws(()=>validateVatExemption(draft),/bedömning/);
  assert.deepEqual(normalizeVatExemption({code:'',legalBasis:'Pågående bedömning'}),{code:'',legalBasis:'Pågående bedömning',confirmed:false});
  assert.equal(normalizeVatExemption(undefined),undefined);assert.equal(vatExemptionBox(undefined),undefined);
});
for(const [name,value] of [
 ['missing',undefined],['unreviewed',exemption('education',{confirmed:false})],['unknown category',exemption('other')],['missing grounds',exemption('education',{legalBasis:''})],['control characters',exemption('education',{legalBasis:'lag\nfel'})],['oversized grounds',exemption('education',{legalBasis:'a'.repeat(501)})],['forged confirmation',exemption('education',{confirmed:'true'})],
]) test(`VAT-EXEMPT: a new zero-rate event rejects ${name} without a write`,()=>{
 const state=createEmptyState();noMutation(state,()=>postTaxTransaction(state,payload({vatExemption:value})),/moms|Moms|grund|bekräft|Bekräft|bedömning|Gransk/);
});
for(const [name,patch] of [
 ['positive domestic VAT',{vatRate:25}],['EU-sale',{kind:'eu-goods-sale',country:'DE',vatNumber:'DE123456789'}],['domestic purchase',{kind:'domestic-purchase'}],['reverse-charge purchase',{kind:'domestic-reverse-service-purchase',vatRate:25}],
]) test(`VAT-EXEMPT: domestic exemption is rejected for ${name}`,()=>assert.throws(()=>calculateTaxTransaction(payload(patch)),/endast/));
test('VAT-EXEMPT: a direct event records decision, exact bank amount and report evidence',()=>{
 const state=postTaxTransaction(createEmptyState(),payload());const report=getTaxDeclarationReport(state);assert.equal(report.boxes['42'],123456);assert.equal(report.boxes['05'],0);assert.equal(report.boxes['49'],0);assert.deepEqual(report.warnings,[]);assert.equal(report.reconciled,true);assert.equal(report.evidence[0].boxes['42'],123456);
 assert.equal(accountBalance(state,'1930'),123456);assert.equal(accountBalance(state,'3000'),-123456);validateSuiteState(JSON.parse(JSON.stringify(state)));
});
test('VAT-EXEMPT: reversing a direct event preserves decision and separates VAT periods',()=>{
 const state=postTaxTransaction(createEmptyState(),payload({date:'2026-09-30'}));const before=JSON.stringify(state.taxTransactions[0]);
 const next=reverseTaxTransaction(state,state.taxTransactions[0].id,{date:'2026-10-02',reason:'Återför felregistrering'});
 assert.equal(JSON.stringify(next.taxTransactions[0]),before);assert.deepEqual(next.taxTransactions[1].vatExemption,next.taxTransactions[0].vatExemption);
 assert.equal(getTaxDeclarationReport(next,{from:'2026-07-01',to:'2026-09-30'}).boxes['42'],123456);
 assert.equal(getTaxDeclarationReport(next,{from:'2026-10-01',to:'2026-12-31'}).boxes['42'],-123456);assert.equal(accountBalance(next,'1930'),0);validateSuiteState(next);
});
test('VAT-EXEMPT: alteration of posted classification, version or reversal grounds fails validation',()=>{
 const state=postTaxTransaction(createEmptyState(),payload());
 for(const mutate of [s=>s.taxTransactions[0].vatExemption.code='healthcare',s=>s.taxTransactions[0].vatExemption.legalBasis='Ny bedömning',s=>s.taxTransactions[0].vatExemption.confirmed=false,s=>s.taxTransactions[0].vatClassificationVersion=2,s=>delete s.taxTransactions[0].vatClassificationVersion]){
  const changed=structuredClone(state);mutate(changed);assert.throws(()=>validateTaxTransactions(changed));
 }
 const reversed=reverseTaxTransaction(state,state.taxTransactions[0].id,{date:'2026-10-15',reason:'Fel'});reversed.taxTransactions[1].vatExemption.code='healthcare';assert.throws(()=>validateTaxTransactions(reversed),/klassning/);
});
test('VAT-EXEMPT: explicit zero-rate events cannot change a closed or filed VAT period',()=>{
 for(const setup of [s=>s.lockedPeriods.push('2026-10'),s=>s.vatReturns.push({id:'filed',from:'2026-10-01',to:'2026-12-31'})]){const state=createEmptyState();setup(state);noMutation(state,()=>postTaxTransaction(state,payload()),/låst|fastställd/);}
});
test('VAT-EXEMPT: pre-upgrade unclassified zero-rate event keeps original arithmetic and blocks export',()=>{
 const state=legacyDirect();const before=JSON.stringify(state);validateTaxTransactions(state);const report=getTaxDeclarationReport(state);assert.equal(report.boxes['05'],123456);assert.equal(report.boxes['42'],0);assert.equal(report.warnings.length,1);assert.equal(JSON.stringify(state),before);
 noMutation(state,()=>createDeclaration(state,{kind:'vat',from:'2026-10-01',to:'2026-12-31',orgNumber:'5599999991',reviewed:true}),/oklassificerade/);
 noMutation(state,()=>handleAction(state,'file-vat',{from:'2026-10-01',to:'2026-12-31',date:'2026-12-31',reviewed:'true'}),/Klassificera/);
});
test('VAT-EXEMPT: classified direct events produce an actual declaration containing box42',()=>{
 let state=postTaxTransaction(createEmptyState(),payload({netCents:120000}));state=createDeclaration(state,{kind:'vat',from:'2026-10-01',to:'2026-12-31',orgNumber:'5599999991',reviewed:true});
 const file=getDeclarationFile(state,state.declarations[0].id),xml=Buffer.from(file.value).toString('latin1');assert.match(xml,/<ForsOvrigt>1200<\/ForsOvrigt>/);assert.deepEqual(state.declarations[0].source.warnings,[]);
});
test('VAT-EXEMPT: tax workspace accepts explicit reviewed exemption and shows immutable grounds',()=>{
 const state=handleAction(createEmptyState(),'post-tax',{kind:'domestic-sale',date:'2026-10-01',reference:'UI',counterparty:'Fiktiv kund',country:'SE',vatNumber:'',netAmount:'500',vatRate:'0',deductiblePercent:'100',account:'4010',conditionsConfirmed:'true',vatExemptionCode:'education',vatExemptionLegalBasis:'Utbildning enligt 10 kap. ML',vatExemptionConfirmed:'true'});
 assert.equal(getTaxDeclarationReport(state).boxes['42'],50000);const html=renderWorkspace(state);assert.ok(html.includes('name="vatExemptionCode"'));assert.ok(html.includes('name="vatExemptionLegalBasis"'));assert.ok(html.includes('name="vatExemptionConfirmed"'));assert.ok(html.includes('Undantag från skatteplikt'));
});
test('VAT-EXEMPT: tax workspace preserves input state when explicit exemption is unconfirmed',()=>{
 const state=createEmptyState();noMutation(state,()=>handleAction(state,'post-tax',{kind:'domestic-sale',date:'2026-10-01',reference:'UI',counterparty:'Fiktiv kund',country:'SE',netAmount:'500',vatRate:'0',deductiblePercent:'100',conditionsConfirmed:'true',vatExemptionCode:'education',vatExemptionLegalBasis:'Utbildning enligt 10 kap. ML'}),/Bekräfta/);
});
test('VAT-EXEMPT: mixed native invoice separates taxed and exempt bases across partial credits',()=>{
 let state=invoice([{description:'Konsulttjänst',kind:'other',quantity:1,unitCents:100000,vatRate:25},{description:'Utbildning',kind:'other',quantity:1,unitCents:50000,vatRate:0,vatExemption:exemption()}]);
 const source=state.invoices[0],snapshot=source.bookingSnapshot;assert.equal(getTaxDeclarationReport(state).boxes['05'],100000);assert.equal(getTaxDeclarationReport(state).boxes['42'],50000);
 assert.deepEqual(getCreditSourceLines(state,'customer',source.id)[1].vatExemption,exemption());
 state=createCreditNote(state,{side:'customer',documentId:source.id,date:'2026-10-03',reference:'PART-1',reason:'Avbokad del',lines:[{index:1,netCents:20000},{index:0,netCents:10000}]});
 const report=getTaxDeclarationReport(state);assert.equal(report.boxes['05'],90000);assert.equal(report.boxes['42'],30000);assert.equal(report.boxes['10'],22500);assert.deepEqual(report.warnings,[]);assert.equal(report.reconciled,true);
 assert.deepEqual(state.settlements[0].lines[0].vatExemption,exemption());assert.equal(state.invoices[0].bookingSnapshot,snapshot);validateSuiteState(JSON.parse(JSON.stringify(state)));
});
test('VAT-EXEMPT: full native credit inherits exemption and clears its own box42 base',()=>{
 const state=invoice(),before=JSON.stringify(state.invoices[0]);const next=creditInvoice(state,state.invoices[0].id,{date:'2026-10-03',reason:'Avbokad kurs'});
 assert.deepEqual(next.invoices[1].lines[0].vatExemption,exemption());const report=getTaxDeclarationReport(next);assert.equal(report.boxes['42'],0);assert.equal(report.boxes['05'],0);assert.deepEqual(report.warnings,[]);assert.equal(next.invoices[0].bookingSnapshot,state.invoices[0].bookingSnapshot);validateSuiteState(next);
});
test('VAT-EXEMPT: partial credit cannot replace the original exemption by submitted metadata',()=>{
 let state=invoice();state=createCreditNote(state,{side:'customer',documentId:state.invoices[0].id,date:'2026-10-03',reference:'PART-1',reason:'Avbokad del',lines:[{index:0,netCents:20000,vatExemption:exemption('healthcare')}]});
 assert.deepEqual(state.settlements[0].lines[0].vatExemption,exemption());const tampered=structuredClone(state);tampered.settlements[0].lines[0].vatExemption.code='healthcare';assert.throws(()=>validateSuiteState(tampered));
});
test('VAT-EXEMPT: native exemption tampering is covered by the invoice snapshot',()=>{
 const state=invoice(),tampered=structuredClone(state);tampered.invoices[0].lines[0].vatExemption.legalBasis='Annat lagstöd';assert.notEqual(invoiceBookingSnapshot(tampered.invoices[0]),state.invoices[0].bookingSnapshot);assert.throws(()=>validateSuiteState(tampered));
});
test('VAT-EXEMPT: filed declaration protects exempt sales bases during a partial credit',()=>{
 const state=invoice();state.vatReturns.push({id:'filed',from:'2026-10-01',to:'2026-12-31'});
 noMutation(state,()=>createCreditNote(state,{side:'customer',documentId:state.invoices[0].id,date:'2026-10-03',reference:'BLOCKED',reason:'Avbokad del',lines:[{index:0,netCents:20000}]}),/fastställd/);
});
