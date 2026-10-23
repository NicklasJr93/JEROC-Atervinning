import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createEmptyState } from '../public/bokforing/suite/core.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { createCashState, createCashDocument, issueCashDocument, creditCashDocument, validateCashState } from '../public/bokforing/suite/cash-method.js';
import { createFxDocument, issueFxDocument, creditFxDocument, getFxTaxRows, validateFxState, fxInvoiceHtml, fxCreditHtml } from '../public/bokforing/suite/fx.js';
import { getDownload as cashDownload } from '../public/bokforing/suite/cash-workspace.js';
import { createDeclaration } from '../public/bokforing/suite/declarations.js';
import { getTaxDeclarationReport } from '../public/bokforing/suite/tax-ledger.js';

const VAT='SE559900123601';
const exempt={code:'property-rental',legalBasis:'Fiktivt hyresavtal X: momsfri lokalupplåtelse enligt 10 kap. 35 § ML, utan frivillig beskattning.',confirmed:true};
const party={partyName:'Fiktiv köpare AB',partyAddress:'Testgatan 7',partyPostalCode:'111 22',partyCity:'Demostaden',partyCountry:'SE'};
const performance={mode:'invoice-date',confirmed:true};
function cash(extra={}) {
 let state=createCashState({eligibilityConfirmed:true,orgNumber:'559900-1236',vatNumber:VAT,postalCode:'222 33',city:'Exempelorten',country:'SE'});
 state=createCashDocument(state,{side:'customer',...party,date:'2026-10-01',dueDate:'2026-10-31',reference:'KRAV-1',supplyConfirmed:true,performance,lines:[{description:'Utförd tjänst',netCents:100000,vatRate:25}],...extra});
 return{state,id:state.cashDocuments[0].id};
}
function fx(extra={}) {
 let state=createEmptyState();
 state=createFxDocument(state,{side:'customer',currency:'EUR',...party,sellerName:'Fiktiv säljare AB',sellerAddress:'Testvägen 2',sellerPostalCode:'222 33',sellerCity:'Exempelorten',sellerCountry:'SE',sellerOrgNumber:'559900-1236',sellerVatNumber:VAT,date:'2026-10-01',dueDate:'2026-10-31',number:'FX-KRAV-1',paymentReference:'FX-KRAV-1',taxTreatment:'domestic',taxReviewed:true,rate:'11',rateSource:'Fiktivt kursunderlag',performance,lines:[{description:'Utförd tjänst',foreignNetMinor:10000,vatRate:25,account:'4010'}],...extra});
 return{state,id:state.fxDocuments[0].id};
}
const verify=state=>{validateSuiteState(state);validateSuiteState(JSON.parse(JSON.stringify(state)));return state;};

for(const [kind,build,issue] of [['cash',cash,issueCashDocument],['fx',fx,issueFxDocument]]) {
 for(const missing of ['partyPostalCode','partyCity','partyCountry','performance']) test(`${kind} requires ${missing} at issuance but preserves incomplete draft`,()=>{
  const {state,id}=build({[missing]:missing==='performance'?undefined:''}),before=JSON.stringify(state);
  assert.throws(()=>issue(state,id),/kompletteras|bekräfta|datum|landkod/i);
  assert.equal(JSON.stringify(state),before);
 });
 test(`${kind} rejects unconfirmed and future performance without a partial issue`,()=>{
  for(const invalid of [{mode:'date',date:'2026-10-01',confirmed:false},{mode:'date',date:'2026-10-02',confirmed:true},{mode:'period',from:'2026-09-01',to:'2026-10-02',confirmed:true},{mode:'advance-payment',date:'2026-09-30',confirmed:true}]) {
   const{state,id}=build({performance:invalid}),before=JSON.stringify(state);
   assert.throws(()=>issue(state,id),/kompletteras|Förskott|Framtida|förskott/i);assert.equal(JSON.stringify(state),before);
  }
 });
 test(`${kind} issues complete frozen data and validates it again on restore`,()=>{
  let {state,id}=build();state=verify(issue(state,id));
  const doc=kind==='cash'?state.cashDocuments[0]:state.fxDocuments[0];
  assert.equal(doc.requirementsVersion,1);
  const bad=structuredClone(state),changed=kind==='cash'?bad.cashDocuments[0]:bad.fxDocuments[0];changed.partyPostalCode='';
  assert.throws(()=>verify(bad));
 });
 test(`${kind} newly issued zero VAT needs explicit reviewed legal classification`,()=>{
  const lines=kind==='cash'?[{description:'Momsfri lokalhyra',netCents:100000,vatRate:0}]:[{description:'Momsfri lokalhyra',foreignNetMinor:10000,vatRate:0}];
  for(const classification of [undefined,{...exempt,confirmed:false}]) {
   const{state,id}=build({lines,vatExemption:classification,vatReason:'Allmän text räcker inte',taxReason:'Allmän text räcker inte'});
   assert.throws(()=>issue(state,id),/moms|undantag|grund|granska/i);
  }
  const{state,id}=build({lines,vatExemption:exempt});verify(issue(state,id));
 });
 test(`${kind} supplier record is not forced through outgoing customer identity checks`,()=>{
  const{state,id}=build({side:'supplier',partyPostalCode:'',partyCity:'',partyCountry:'',performance:undefined,sellerVatNumber:'VAT-FROM-SUPPLIER'});
  verify(issue(state,id));
 });
}

test('cash invoice and credit print frozen VAT identity, postal addresses, performance and legal ground',()=>{
 let {state,id}=cash({lines:[{description:'Momsfri lokalhyra',netCents:100000,vatRate:0}],vatExemption:exempt});
 state=issueCashDocument(state,id);
 const before=structuredClone(state.cashDocuments[0]);
 state=verify(creditCashDocument(state,id,{date:'2026-10-02',amountCents:50000,reference:'C-KRAV',reason:'Prisrättelse'}));
 assert.deepEqual(state.cashDocuments[0],before);
 const invoice=cashDownload(state,'print',{id}).value;
 const credit=cashDownload(state,'print-credit',{id:state.cashEvents[0].id}).value;
 for(const html of [invoice,credit]) for(const text of [VAT,'111 22','222 33','Demostaden','2026-10-01','Undantag från skatteplikt','10 kap. 35']) assert.ok(html.includes(text),text);
 assert.ok(credit.includes('Avser original CF-0001'));
});

test('FX mixed invoice and partial credit preserve separate 05/42 tax bases and print legal details',()=>{
 let {state,id}=fx({lines:[{description:'Arbete',foreignNetMinor:10000,vatRate:25},{description:'Momsfri lokalhyra',foreignNetMinor:20000,vatRate:0}],vatExemption:exempt});
 state=issueFxDocument(state,id);
 let rows=getFxTaxRows(state);assert.deepEqual(rows.map(x=>x.basisBox),['05','42']);
 let report=getTaxDeclarationReport(state,{from:'2026-10-01',to:'2026-10-31'});
 assert.equal(report.boxes['05'],110000);assert.equal(report.boxes['42'],220000);
 const before=structuredClone(state.fxDocuments[0]);
 state=verify(creditFxDocument(state,id,{date:'2026-10-02',lines:[{index:1,foreignNetMinor:5000}],reason:'Minskad hyra',reference:'FX-C1'}));
 assert.deepEqual(state.fxDocuments[0],before);
 report=getTaxDeclarationReport(state,{from:'2026-10-01',to:'2026-10-31'});assert.equal(report.boxes['05'],110000);assert.equal(report.boxes['42'],165000);
 for(const html of [fxInvoiceHtml(state,id),fxCreditHtml(state,state.fxEvents.at(-1).id)]) for(const text of [VAT,'111 22','222 33','Demostaden','2026-10-01','Undantag från skatteplikt','10 kap. 35']) assert.ok(html.includes(text),text);
 for(const html of [fxInvoiceHtml(state,id),fxCreditHtml(state,state.fxEvents.at(-1).id)]) assert.ok(html.includes('gäller endast rader med 0 % moms'));
});

test('cash legacy issued originals remain readable without new fields',()=>{
 let{state,id}=cash();state=issueCashDocument(state,id);const old=state.cashDocuments[0];
 for(const key of ['partyPostalCode','partyCity','partyCountry','performance','vatExemption','requirementsVersion'])delete old[key];
 for(const key of ['postalCode','city','country','vatNumber','legalForm','registeredOffice','inLiquidation'])delete old.companyDetails[key];
 const keys=['id','side','partyName','partyAddress','partyOrgNumber','companyDetails','date','dueDate','number','reference','vatReason','supplyConfirmed','lines'];
 old.snapshot=JSON.stringify(Object.fromEntries(keys.map(key=>[key,old[key]])));
 assert.equal(validateCashState(state).claimedEntryIds.length,0);verify(state);
});

test('FX legacy issued originals retain old snapshot and tax representation',()=>{
 let{state,id}=fx();state=issueFxDocument(state,id);const old=state.fxDocuments[0];
 for(const key of ['partyPostalCode','partyCity','partyCountry','sellerPostalCode','sellerCity','sellerCountry','sellerLegalForm','sellerRegisteredOffice','sellerInLiquidation','performance','vatExemption','requirementsVersion'])delete old[key];
 old.sellerVatNumber='SE-DEMO';
 old.snapshot=JSON.stringify(Object.fromEntries(Object.entries(old).filter(([key])=>key!=='snapshot')));
 verify(state);assert.equal(validateFxState(state).claimedEntryIds.size,1);assert.equal(getFxTaxRows(state)[0].basisBox,undefined);
});


for(const [kind,build,issue] of [['cash',cash,issueCashDocument],['fx',fx,issueFxDocument]]) {
 test(`${kind} rejects an exemption on wholly taxable invoices without changing the draft`,()=>{
  for(const exemption of [exempt,{...exempt,confirmed:false},{code:'',legalBasis:'Användaren skriver en otillämplig text',confirmed:false}]) {
   const {state,id}=build({vatExemption:exemption}),before=JSON.stringify(state);
   assert.throws(()=>issue(state,id),/Momsundantag kan bara anges.*0 %/);assert.equal(JSON.stringify(state),before);
  }
 });
 test(`${kind} drops empty exemption form fields on wholly taxable invoices`,()=>{
  let {state,id}=build({vatExemption:{code:'',legalBasis:'',confirmed:false}});state=verify(issue(state,id));
  const doc=kind==='cash'?state.cashDocuments[0]:state.fxDocuments[0];
  assert.equal(doc.vatExemption,undefined);
  const html=kind==='cash'?cashDownload(state,'print',{id}).value:fxInvoiceHtml(state,id);
  assert.ok(!html.includes('Undantag från skatteplikt'));
 });
 test(`${kind} restore rejects an exemption added to a new wholly taxable original even with a recomputed snapshot`,()=>{
  let {state,id}=build();state=issue(state,id);
  const doc=kind==='cash'?state.cashDocuments[0]:state.fxDocuments[0];doc.vatExemption=structuredClone(exempt);
  if(kind==='fx') doc.snapshot=JSON.stringify(Object.fromEntries(Object.entries(doc).filter(([key])=>key!=='snapshot')));
  else {
   const fields=['id','side','partyName','partyAddress','partyOrgNumber','companyDetails','date','dueDate','number','reference','vatReason','supplyConfirmed','lines'];
   for(const key of ['partyPostalCode','partyCity','partyCountry','performance','vatExemption','requirementsVersion'])if(doc[key]!==undefined)fields.push(key);
   doc.snapshot=JSON.stringify(Object.fromEntries(fields.map(key=>[key,doc[key]])));
  }
  assert.throws(()=>kind==='cash'?validateCashState(state):validateFxState(state),/Momsundantag kan bara anges.*0 %/);
 });
}

const legacySource=JSON.parse(readFileSync(new URL('./fixtures/bokforing-invoice-requirements/legacy-special-8a1c143.json',import.meta.url),'utf8'));
for(const kind of ['fx','cash']) test(`${kind} real 8a1c143 zero-VAT fixture preserves its original base but blocks a new XML export pending review`,()=>{
 const state=structuredClone(legacySource[kind]),before=JSON.stringify(state);
 assert.equal(legacySource.sourceRevision,'8a1c143');verify(state);
 const report=getTaxDeclarationReport(state,{from:'2026-10-01',to:'2026-12-31'});
 assert.equal(report.boxes[kind==='fx'?'05':'42'],kind==='fx'?110000:100000);
 assert.equal(report.boxes[kind==='fx'?'42':'05'],0);assert.ok(report.warnings.length>0);
 assert.throws(()=>createDeclaration(state,{kind:'vat',from:'2026-10-01',to:'2026-12-31',orgNumber:'5599001236',reviewed:true}),/oklassificerade|Granska/);
 assert.equal(JSON.stringify(state),before);
});


test('cash mixed invoice limits the exemption note to zero-rate rows',()=>{
 let{state,id}=cash({lines:[{description:'Momspliktig tjänst',netCents:100000,vatRate:25},{description:'Momsfri lokalhyra',netCents:200000,vatRate:0}],vatExemption:exempt});
 state=issueCashDocument(state,id);const html=cashDownload(state,'print',{id}).value;
 assert.ok(html.includes('Momsundantaget gäller endast rader med 0 % moms.'));
 assert.ok(html.includes('Momspliktig tjänst'));assert.ok(html.includes('Momsfri lokalhyra'));
});


for(const kind of ['cash','fx']) test(`${kind} AB invoice freezes and prints registered office and liquidation status`,()=>{
 let state,id;
 if(kind==='cash') {
  ({state,id}=cash());state.company.registeredOffice='Sätesorten';state.company.inLiquidation=true;state=issueCashDocument(state,id);
  assert.equal(state.cashDocuments[0].companyDetails.registeredOffice,'Sätesorten');
  const html=cashDownload(state,'print',{id}).value;assert.ok(html.includes('Styrelsens säte: Sätesorten'));assert.ok(html.includes('Under likvidation'));
  state.company.registeredOffice='Annan ort';assert.ok(cashDownload(state,'print',{id}).value.includes('Styrelsens säte: Sätesorten'));
 } else {
  ({state,id}=fx({sellerRegisteredOffice:'Sätesorten',sellerInLiquidation:true}));state=issueFxDocument(state,id);
  assert.equal(state.fxDocuments[0].sellerRegisteredOffice,'Sätesorten');
  const html=fxInvoiceHtml(state,id);assert.ok(html.includes('Styrelsens säte: Sätesorten'));assert.ok(html.includes('Under likvidation'));
  state=creditFxDocument(state,id,{date:'2026-10-02',lines:[{index:0,foreignNetMinor:1000}],reference:'ABL-KREDIT',reason:'Prisrättelse'});
  const credit=fxCreditHtml(state,state.fxEvents.at(-1).id);assert.ok(credit.includes('Styrelsens säte: Sätesorten'));assert.ok(credit.includes('Under likvidation'));
 }
 verify(state);
});

for(const kind of ['cash','fx']) test(`${kind} AB invoice rejects missing registered office without issuing`,()=>{
 let state,id;
 if(kind==='cash') {({state,id}=cash());state.company.registeredOffice='';}
 else ({state,id}=fx({sellerRegisteredOffice:''}));
 const before=JSON.stringify(state);assert.throws(()=>kind==='cash'?issueCashDocument(state,id):issueFxDocument(state,id),/styrelsesäte/);assert.equal(JSON.stringify(state),before);
});
