import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyState, accountBalance } from '../public/bokforing/suite/core.js';
import { createCustomer, createInvoice, issueInvoice, updateInvoiceDraft, creditInvoice, copyInvoice, receivePayment, invoiceBookingSnapshot } from '../public/bokforing/suite/sales.js';
import { updateCompany } from '../public/bokforing/suite/finance.js';
import { createCreditNote } from '../public/bokforing/suite/settlements.js';
import { createCashState, createCashDocument, issueCashDocument, payCashDocument, creditCashDocument, refundCashDocument, getCashDocumentSummary } from '../public/bokforing/suite/cash-method.js';
import { getDownload as cashDownload } from '../public/bokforing/suite/cash-workspace.js';
import { createFxDocument, issueFxDocument, updateFxDraft, fxInvoiceHtml, getFxTaxRows } from '../public/bokforing/suite/fx.js';
import { getTaxDeclarationReport } from '../public/bokforing/suite/tax-ledger.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

// Additional composition/metamorphic cases, not reruns of missing-field checks.
// Amount expectations are literal independent values for SEK 100 + 25% VAT.
const company={name:'Fiktiv AB',orgNumber:'5599999991',vatNumber:'SE559999999101',address:'Säljvägen 1',postalCode:'12345',city:'Teststad',country:'SE',legalForm:'AB',registeredOffice:'Sätesort A',inLiquidation:false};
const buyer={name:'Kund A',orgNumber:'5599001236',vatNumber:'SE559900123601',address:'Kundvägen 2',postalCode:'23456',city:'Kundstad',country:'SE'};
const performed={mode:'date',date:'2026-10-01',confirmed:true};
const plain={description:'Utförd tjänst',kind:'labor',quantity:1,unitCents:10000,vatRate:25};
const exemption=(code='property-rental')=>({code,legalBasis:code==='insurance'?'Granskat försäkringsavtal enligt ML 10:32':'Granskat hyresavtal enligt ML 10:35 utan frivillig beskattning',confirmed:true});
const last=state=>state.invoices.at(-1);
const checked=state=>{validateSuiteState(state);validateSuiteState(JSON.parse(JSON.stringify(state)));return state;};
const journal=state=>state.entries.map(entry=>({date:entry.date,rows:entry.rows}));
function native(payload={}, meta={}){
 let state=createEmptyState();Object.assign(state.company,company,meta);
 state=createCustomer(state,buyer);
 state=createInvoice(state,{customerId:state.customers[0].id,date:'2026-10-01',dueDate:'2026-10-31',lines:[plain],details:{performance:performed},...payload});
 return{state,id:last(state).id};
}
function cash(payload={},meta={}){
 let state=createCashState({...company,...meta,eligibilityConfirmed:true});
 state=createCashDocument(state,{side:'customer',partyName:buyer.name,partyAddress:buyer.address,partyOrgNumber:buyer.orgNumber,partyPostalCode:buyer.postalCode,partyCity:buyer.city,partyCountry:'SE',date:'2026-10-01',dueDate:'2026-10-31',reference:'CASH-A',supplyConfirmed:true,performance:performed,lines:[{description:'Utförd tjänst',netCents:10000,vatRate:25}],...payload});
 return{state,id:state.cashDocuments.at(-1).id};
}
function fx(payload={},meta={}){
 let state=createEmptyState();Object.assign(state.company,company,meta);
 state=createFxDocument(state,{side:'customer',currency:'EUR',partyName:buyer.name,partyAddress:buyer.address,partyPostalCode:buyer.postalCode,partyCity:buyer.city,partyCountry:'SE',sellerName:state.company.name,sellerAddress:state.company.address,sellerOrgNumber:state.company.orgNumber,sellerVatNumber:state.company.vatNumber,sellerPostalCode:state.company.postalCode,sellerCity:state.company.city,sellerCountry:'SE',sellerLegalForm:'AB',sellerRegisteredOffice:state.company.registeredOffice,sellerInLiquidation:state.company.inLiquidation,date:'2026-10-01',dueDate:'2026-10-31',number:'FX-A',paymentReference:'FX-A',taxTreatment:'domestic',taxReviewed:true,performance:performed,rate:'1',rateSource:'Fiktivt 1:1-kursunderlag',lines:[{description:'Utförd tjänst',foreignNetMinor:10000,vatRate:25}],...payload});
 return{state,id:state.fxDocuments.at(-1).id};
}
const types=[['native',native,issueInvoice,s=>last(s)],['cash',cash,issueCashDocument,s=>s.cashDocuments.at(-1)],['fx',fx,issueFxDocument,s=>s.fxDocuments.at(-1)]];

// Different complete metadata must change the document, never the money.
test('REVIEW2-INVOICE-001 party and registered-office edits do not alter any financial rows',()=>{
 for(const [kind,make,issue,document]of types){
  let a=make(),b=make({}, {address:'Annan säljväg 99',registeredOffice:'Sätesort B'});
  a.state=issue(a.state,a.id);b.state=issue(b.state,b.id);
  if(kind==='cash')for(const fixture of[a,b])fixture.state=payCashDocument(fixture.state,fixture.id,{date:'2026-10-02',amountCents:12500,reference:'FULL'});
  checked(a.state);checked(b.state);assert.deepEqual(journal(a.state),journal(b.state),kind);
  assert.equal(accountBalance(a.state,'3000'),-10000);assert.equal(accountBalance(a.state,'2611'),-2500);
  assert.notDeepEqual(document(a.state),document(b.state),kind);
 }
});

test('REVIEW2-INVOICE-002 caller mutation of a supplied performance object cannot change a saved draft',()=>{
 for(const[kind,make,issue,document]of types){
  const input={mode:'period',from:'2026-09-01',to:'2026-09-30',confirmed:true};
  const fixture=make(kind==='native'?{details:{performance:input}}:{performance:input});
  input.to='2027-12-31';input.confirmed=false;
  const saved=kind==='native'?document(fixture.state).details.performance:document(fixture.state).performance;
  assert.deepEqual(saved,{mode:'period',from:'2026-09-01',to:'2026-09-30',confirmed:true},kind);
  checked(issue(fixture.state,fixture.id));
 }
});

test('REVIEW2-INVOICE-003 a known prior-year supply period is retained separately from the current invoice date',()=>{
 const period={mode:'period',from:'2025-12-01',to:'2025-12-31',confirmed:true};
 for(const[kind,make,issue,document]of types){
  const fixture=make(kind==='native'?{date:'2026-01-05',dueDate:'2026-02-04',details:{performance:period}}:{date:'2026-01-05',dueDate:'2026-02-04',performance:period});
  const state=checked(issue(fixture.state,fixture.id));
  const value=kind==='native'?document(state).details.performance:document(state).performance;
  assert.deepEqual(value,period,kind);assert.equal(document(state).date,'2026-01-05');
  // This checks the retained documentary dates, not the legal accrual period.
 }
});

test('REVIEW2-INVOICE-004 changing a draft customer clears the previous recipient and date confirmation',()=>{
 let{state,id}=native();state=createCustomer(state,{...buyer,name:'Kund B',address:'Ny kundväg 4',vatNumber:'SE559999998301',orgNumber:'5599999983'});
 const nextCustomer=state.customers.at(-1);state=updateInvoiceDraft(state,id,{customerId:nextCustomer.id});
 assert.equal(last(state).details.customer.name,'Kund B');assert.equal(last(state).details.customer.address,'Ny kundväg 4');
 assert.equal(last(state).details.performance,undefined);
 const before=JSON.stringify(state);assert.throws(()=>issueInvoice(state,id),/Bekräfta datum/);assert.equal(JSON.stringify(state),before);
 state=updateInvoiceDraft(state,id,{details:{performance:performed}});checked(issueInvoice(state,id));
});

test('REVIEW2-INVOICE-005 a full credit can be copied into a separately confirmed positive invoice',()=>{
 let{state,id}=native();state=issueInvoice(state,id);const original=invoiceBookingSnapshot(last(state));
 state=creditInvoice(state,id,{date:'2026-10-02',reason:'Hela uppdraget återfört'});const creditId=last(state).id;
 state=copyInvoice(state,creditId,{date:'2026-10-03',dueDate:'2026-11-02'});const newId=last(state).id;
 assert.equal(last(state).kind,'invoice');assert.equal(last(state).details.performance.confirmed,false);
 state=updateInvoiceDraft(state,newId,{details:{...last(state).details,performance:{mode:'date',date:'2026-10-03',confirmed:true}}});
 state=checked(issueInvoice(state,newId));assert.equal(accountBalance(state,'1510'),12500);assert.equal(accountBalance(state,'3000'),-10000);
 assert.equal(invoiceBookingSnapshot(state.invoices.find(x=>x.id===id)),original);
 assert.equal(last(state).details.performance.date,'2026-10-03');
});

test('REVIEW2-INVOICE-006 successive credits keep two different exemption grounds attached to their original rows',()=>{
 let{state,id}=native({lines:[{...plain,description:'Försäkring',vatRate:0,vatExemption:exemption('insurance')},{...plain,description:'Lokalhyra',unitCents:20000,vatRate:0,vatExemption:exemption()}]});
 state=issueInvoice(state,id);const original=invoiceBookingSnapshot(last(state));
 for(const[index,netCents,date]of[[1,5000,'2026-10-02'],[0,10000,'2026-10-03'],[1,15000,'2026-10-04']])state=createCreditNote(state,{side:'customer',documentId:id,date,reference:'C-'+date,reason:'Delåtergång',lines:[{index,netCents}]});
 checked(state);assert.deepEqual(state.settlements.map(x=>x.lines[0].vatExemption.code),['property-rental','insurance','property-rental']);
 assert.equal(getTaxDeclarationReport(state,{from:'2026-10-01',to:'2026-10-31'}).boxes['42'],0);
 assert.equal(accountBalance(state,'1510'),0);assert.equal(invoiceBookingSnapshot(state.invoices[0]),original);
});

test('REVIEW2-INVOICE-007 later buyer-register identity changes cannot rewrite a paid original invoice',()=>{
 let{state,id}=native();state=issueInvoice(state,id);const original=invoiceBookingSnapshot(last(state));
 Object.assign(state.customers[0],{name:'Senare registerkund',orgNumber:'5599999983',vatNumber:'SE559999998301',address:'Senare väg 7'});
 state=checked(receivePayment(state,id,{date:'2026-10-02',amountCents:12500}));
 assert.equal(accountBalance(state,'1510'),0);assert.equal(invoiceBookingSnapshot(last(state)),original);
 assert.equal(last(state).details.customer.name,'Kund A');assert.equal(last(state).details.customer.vatNumber,buyer.vatNumber);
});

test('REVIEW2-INVOICE-008 separate cash invoices retain the registered office applicable at each issue',()=>{
 let{state,id:first}=cash();state=issueCashDocument(state,first);state=updateCompany(state,{registeredOffice:'Sätesort B'});
 const template={...state.cashDocuments[0],id:undefined,reference:'CASH-B',date:'2026-10-02',performance:{mode:'date',date:'2026-10-02',confirmed:true}};
 state=createCashDocument(state,template);const second=state.cashDocuments.at(-1).id;state=issueCashDocument(state,second);
 for(const id of[second,first])state=payCashDocument(state,id,{date:'2026-10-03',amountCents:12500,reference:'PAY-'+id});
 checked(state);assert.equal(accountBalance(state,'1930'),25000);assert.equal(accountBalance(state,'2611'),-5000);
 assert.match(cashDownload(state,'print',{id:first}).value,/Styrelsens säte: Sätesort A/);
 assert.match(cashDownload(state,'print',{id:second}).value,/Styrelsens säte: Sätesort B/);
});

test('REVIEW2-INVOICE-009 an incomplete current cash-company VAT blocks new issues but not historical refund settlement',()=>{
 let{state,id}=cash();state=issueCashDocument(state,id);const original=state.cashDocuments[0].snapshot;
 state=updateCompany(state,{vatNumber:''});
 state=payCashDocument(state,id,{date:'2026-10-02',amountCents:12500,reference:'PAY'});
 state=creditCashDocument(state,id,{date:'2026-10-03',amountCents:2500,reference:'CREDIT',reason:'Delåtergång'});
 state=checked(refundCashDocument(state,id,{date:'2026-10-04',amountCents:2500,reference:'REFUND'}));
 assert.equal(accountBalance(state,'1930'),10000);assert.equal(getCashDocumentSummary(state,id).refundableCents,0);assert.equal(state.cashDocuments[0].snapshot,original);
 state=createCashDocument(state,{...state.cashDocuments[0],id:undefined,reference:'NEW'});const newId=state.cashDocuments.at(-1).id;
 const before=JSON.stringify(state);assert.throws(()=>issueCashDocument(state,newId),/momsregistreringsnummer/);assert.equal(JSON.stringify(state),before);
});

test('REVIEW2-INVOICE-010 a cash payload cannot inject a different seller snapshot at issuance',()=>{
 const{state,id}=cash({companyDetails:{...company,name:'Spoofad säljare',vatNumber:'SE559900123601',registeredOffice:'Spoofad ort'}});
 const next=checked(issueCashDocument(state,id)),doc=next.cashDocuments[0];
 assert.equal(doc.companyDetails.name,company.name);assert.equal(doc.companyDetails.vatNumber,company.vatNumber);assert.equal(doc.companyDetails.registeredOffice,'Sätesort A');
});

test('REVIEW2-INVOICE-011 moving an FX draft date requires a matching dated rate without losing the earlier supply date',()=>{
 let{state,id}=fx();const before=JSON.stringify(state);
 assert.throws(()=>updateFxDraft(state,id,{date:'2026-10-02',taxReviewed:true}),/Kursdatum/);assert.equal(JSON.stringify(state),before);
 state=updateFxDraft(state,id,{date:'2026-10-02',rate:'1',rateSource:'Nytt daterat kursunderlag',taxReviewed:true});state=checked(issueFxDocument(state,id));
 const doc=state.fxDocuments[0];assert.equal(doc.rate.date,'2026-10-02');assert.equal(doc.performance.date,'2026-10-01');
 assert.equal(accountBalance(state,'1510'),12500);assert.match(fxInvoiceHtml(state,id),/Leverans\/utförande: 2026-10-01/);
});

test('REVIEW2-INVOICE-012 changing an exempt FX draft into taxable supply requires removing the old exemption',()=>{
 let{state,id}=fx({taxTreatment:'no-vat',sellerVatNumber:'',taxReason:'Granskad momsfri hyra',vatExemption:exemption(),lines:[{description:'Lokalhyra',foreignNetMinor:10000,vatRate:0}]});
 state=updateFxDraft(state,id,{taxTreatment:'domestic',sellerVatNumber:company.vatNumber,taxReviewed:true,lines:[{description:'Ny momspliktig tjänst',foreignNetMinor:10000,vatRate:25}]});
 const before=JSON.stringify(state);assert.throws(()=>issueFxDocument(state,id),/Momsundantag kan bara anges/);assert.equal(JSON.stringify(state),before);
 state=updateFxDraft(state,id,{vatExemption:null,taxReviewed:true});state=checked(issueFxDocument(state,id));
 assert.equal(state.fxDocuments[0].vatExemption,undefined);assert.equal(getFxTaxRows(state)[0].basisBox,'05');assert.equal(accountBalance(state,'2611'),-2500);
});

test('REVIEW2-INVOICE-013 changing taxable FX supply into explicitly exempt supply preserves a zero tax amount',()=>{
 let{state,id}=fx();state=updateFxDraft(state,id,{taxTreatment:'no-vat',sellerVatNumber:'',taxReason:'Granskad momsfri hyra',vatExemption:exemption(),taxReviewed:true,lines:[{description:'Lokalhyra',foreignNetMinor:10000,vatRate:0}]});
 state=checked(issueFxDocument(state,id));assert.equal(accountBalance(state,'1510'),10000);assert.equal(accountBalance(state,'2611'),0);
 assert.equal(getFxTaxRows(state)[0].basisBox,'42');assert.match(fxInvoiceHtml(state,id),/10 kap\. 35/);
});

test('REVIEW2-INVOICE-014 caller-supplied requirement stamps cannot bypass unconfirmed performance in any creation API',()=>{
 for(const[kind,make,issue,document]of types){
  const input=kind==='native'?{details:{requirementsVersion:1,performance:{...performed,confirmed:false}}}:{requirementsVersion:1,performance:{...performed,confirmed:false}};
  const fixture=make(input),doc=document(fixture.state);
  assert.equal(kind==='native'?doc.details.requirementsVersion:doc.requirementsVersion,undefined,kind);
  const before=JSON.stringify(fixture.state);assert.throws(()=>issue(fixture.state,fixture.id),/Bekräfta datum/);assert.equal(JSON.stringify(fixture.state),before,kind);
 }
});

test('REVIEW2-INVOICE-015 repairing multiple native completeness errors does not consume invoice numbers',()=>{
 let{state,id}=native({details:{performance:{...performed,confirmed:false}}},{vatNumber:''});
 const initialSequence=state.sequence;assert.throws(()=>issueInvoice(state,id),/kompletteras/);assert.equal(state.sequence,initialSequence);
 state=updateCompany(state,{vatNumber:company.vatNumber});const repairedSequence=state.sequence;
 assert.throws(()=>issueInvoice(state,id),/Bekräfta datum/);assert.equal(state.sequence,repairedSequence);
 state=updateInvoiceDraft(state,id,{details:{performance:performed}});state=checked(issueInvoice(state,id));
 assert.equal(last(state).number,'F-0001');assert.equal(state.entries.length,1);assert.equal(accountBalance(state,'1510'),12500);
});
