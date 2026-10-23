import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createCustomer, createInvoice, legacyZeroVatFixture } from './fixtures/bokforing-compliant-invoices.mjs';
import { accountBalance } from '../public/bokforing/suite/core.js';
import { issueInvoice, receivePayment, copyInvoice, updateInvoiceDraft, invoiceBookingSnapshot } from '../public/bokforing/suite/sales.js';
import { createCreditNote } from '../public/bokforing/suite/settlements.js';
import { postTaxTransaction, reverseTaxTransaction, getTaxDeclarationReport } from '../public/bokforing/suite/tax-ledger.js';
import { fileVatPeriod } from '../public/bokforing/suite/finance.js';
import { createDeclaration, getDeclarationFile } from '../public/bokforing/suite/declarations.js';
import { createFxDocument, issueFxDocument, settleFxDocument, creditFxDocument } from '../public/bokforing/suite/fx.js';
import { createCashState, createCashDocument, issueCashDocument, payCashDocument, creditCashDocument, refundCashDocument } from '../public/bokforing/suite/cash-method.js';
import { invoiceDocumentHTML } from '../public/bokforing/suite/invoice-page.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

// Second-round business chains, not repetitions of input-field validation.
// Fixed expected amounts are independent facit. Partition tests compare two
// different event histories to detect drift without reusing production rounding.
const VAT='SE559900123601';
const exemption=(code='property-rental',legalBasis='Fiktiv lokalhyra enligt 10 kap. 35 § ML utan frivillig beskattning.')=>({code,legalBasis,confirmed:true});
const period=(from='2026-10-01',to='2026-12-31')=>({from,to,date:to});
function base(){return createCustomer(createEmptyState(),{name:'Fiktiv kund AB'});}
const line=(net,rate=0,patch={})=>({description:rate?'Utförd tjänst':'Fiktiv lokalhyra',kind:'other',quantity:1,unitCents:net,vatRate:rate,...(rate===0?{vatExemption:exemption()}:{}),...patch});
function invoice(lines=[line(100000)],patch={}){let state=base();state=createInvoice(state,{customerId:state.customers[0].id,date:'2026-10-01',dueDate:'2026-10-31',vatMode:'standard',lines,...patch});return issueInvoice(state,state.invoices.at(-1).id);}
function direct(state=createEmptyState(),patch={}){return postTaxTransaction(state,{kind:'domestic-sale',date:'2026-10-03',reference:'DIRECT',counterparty:'Fiktiv hyresgäst',country:'SE',netCents:100000,vatRate:0,conditionsConfirmed:true,vatExemption:exemption(),...patch});}
function declaration(state,range=period()){return createDeclaration(state,{kind:'vat',from:range.from,to:range.to,orgNumber:'5599001236',reviewed:true,createdAt:'2026-12-31T18:00:00Z'});}
const boxes=(state,range=period())=>getTaxDeclarationReport(state,range).boxes;
const verified=state=>{validateSuiteState(state);validateSuiteState(JSON.parse(JSON.stringify(state)));return state;};
const noWrite=(state,run,pattern)=>{const before=JSON.stringify(state);assert.throws(run,pattern);assert.equal(JSON.stringify(state),before);};
function cash(lines,patch={}){let state=createCashState({eligibilityConfirmed:true,vatPeriod:'month',orgNumber:'5599001236',vatNumber:VAT,postalCode:'12345',city:'Demostaden',country:'SE'});state=createCashDocument(state,{side:'customer',partyName:'Fiktiv kund',partyAddress:'Fiktivgatan 1',partyPostalCode:'12345',partyCity:'Demostaden',partyCountry:'SE',date:'2026-01-10',dueDate:'2026-01-31',reference:'CASH',supplyConfirmed:true,performance:{mode:'invoice-date',confirmed:true},vatExemption:exemption(),lines,...patch});return issueCashDocument(state,state.cashDocuments[0].id);}
function fx(state=createEmptyState(),patch={}){state=createFxDocument(state,{side:'customer',currency:'EUR',number:'FX',date:'2026-10-01',dueDate:'2026-10-31',partyName:'Fiktiv kund',partyAddress:'Fiktivgatan1',partyPostalCode:'12345',partyCity:'Demostaden',partyCountry:'SE',sellerName:'Fiktiv AB',sellerAddress:'Fiktivgatan2',sellerPostalCode:'12345',sellerCity:'Demostaden',sellerCountry:'SE',sellerOrgNumber:'5599001236',sellerVatNumber:VAT,sellerLegalForm:'AB',sellerRegisteredOffice:'Demostaden',sellerInLiquidation:false,performance:{mode:'invoice-date',confirmed:true},paymentReference:'FX',taxTreatment:'domestic',taxReviewed:true,taxReason:'Fiktiv lokalhyra är granskad',vatExemption:exemption(),rate:'11',rateSource:'Fiktiv kurs',lines:[{description:'Lokalhyra',foreignNetMinor:10000,vatRate:0}],...patch});return issueFxDocument(state,state.fxDocuments.at(-1).id);}

test('REVIEW2-VAT-001 direct exempt reversal must not rewrite a finalized quarter',()=>{
 const posted=direct();const state=fileVatPeriod(posted,period());const id=state.taxTransactions[0].id;
 noWrite(state,()=>reverseTaxTransaction(state,id,{date:'2026-10-04',reason:'Rättelse i redan fastställd period'}),/fastställd|momsperiod/i);
});
test('REVIEW2-VAT-002 exempt reversal in next open quarter preserves filed history',()=>{
 const posted=direct(createEmptyState(),{date:'2026-09-10'}),before=JSON.stringify(posted.taxTransactions[0]);
 let state=fileVatPeriod(posted,period('2026-07-01','2026-09-30'));
 state=reverseTaxTransaction(state,state.taxTransactions[0].id,{date:'2026-10-04',reason:'Rättelse i öppen period'});
 assert.equal(boxes(state,period('2026-07-01','2026-09-30'))['42'],100000);assert.equal(boxes(state)['42'],-100000);assert.equal(JSON.stringify(state.taxTransactions[0]),before);verified(state);
});
test('REVIEW2-VAT-003 mixed invoice credit across filed quarter keeps exact signed bases',()=>{
 let state=invoice([line(100000,25),line(50000)],{date:'2026-09-30',dueDate:'2026-10-31'});const id=state.invoices[0].id,snapshot=state.invoices[0].bookingSnapshot;
 state=fileVatPeriod(state,period('2026-07-01','2026-09-30'));state=createCreditNote(state,{side:'customer',documentId:id,date:'2026-10-05',reference:'CROSS',reason:'Prisrättelse',lines:[{index:0,netCents:20000},{index:1,netCents:10000}]});
 assert.deepEqual([boxes(state,period('2026-07-01','2026-09-30'))['05'],boxes(state,period('2026-07-01','2026-09-30'))['42']],[100000,50000]);assert.deepEqual([boxes(state)['05'],boxes(state)['42'],boxes(state)['10']],[-20000,-10000,-5000]);assert.equal(state.invoices[0].bookingSnapshot,snapshot);verified(state);
});
test('REVIEW2-VAT-004 successive tiny mixed credits equal one final full credit',()=>{
 const source=invoice([line(101,6),line(103)]),id=source.invoices[0].id;
 let split=source;for(const [i,a,b]of [[0,1,1],[1,37,17],[2,63,85]])split=createCreditNote(split,{side:'customer',documentId:id,date:`2026-10-0${i+2}`,reference:`PART-${i}`,reason:'Avtalad minskning',lines:[{index:0,netCents:a},{index:1,netCents:b}]});
 const once=createCreditNote(source,{side:'customer',documentId:id,date:'2026-10-04',reference:'ONCE',reason:'Hela avtalet upphört',lines:[{index:0,netCents:101},{index:1,netCents:103}]});
 for(const code of ['05','42','12','49'])assert.equal(boxes(split)[code],boxes(once)[code]);assert.deepEqual([boxes(split)['05'],boxes(split)['42'],boxes(split)['12']],[0,0,0]);assert.equal(accountBalance(split,'1510'),0);verified(split);
});
test('REVIEW2-VAT-005 mixed discounts and an exempt invoice fee use independent base facit',()=>{
 let state=invoice([line(100000,12,{discountBps:1000}),line(50000),line(1000,0,{chargeType:'invoice-fee'})],{invoiceDiscountBps:2000});
 // 100000 * .9 * .8 = 72000; exempt50000*.8+undiscountedfee1000=41000.
 assert.deepEqual([boxes(state)['05'],boxes(state)['42'],boxes(state)['11']],[72000,41000,8640]);
 state=createCreditNote(state,{side:'customer',documentId:state.invoices[0].id,date:'2026-10-02',reference:'FEE',reason:'Halverad avgift',lines:[{index:2,netCents:500}]});assert.deepEqual([boxes(state)['05'],boxes(state)['42'],boxes(state)['11']],[72000,40500,8640]);verified(state);
});
test('REVIEW2-VAT-006 copied exempt invoice requires new performance review but retains its exact ground',()=>{
 const source=invoice(),old=source.invoices[0],original=JSON.stringify(old);let state=copyInvoice(source,old.id,{date:'2026-11-01',dueDate:'2026-11-30'});const copy=state.invoices.at(-1);
 assert.deepEqual(copy.lines[0].vatExemption,old.lines[0].vatExemption);assert.equal(copy.details.performance.confirmed,false);noWrite(state,()=>issueInvoice(state,copy.id),/Bekräfta|bekräfta/);
 state=updateInvoiceDraft(state,copy.id,{details:{...copy.details,performance:{mode:'invoice-date',confirmed:true}}});state=issueInvoice(state,copy.id);assert.equal(JSON.stringify(state.invoices[0]),original);assert.equal(boxes(state)['42'],200000);verified(state);
});
test('REVIEW2-VAT-007 ordinary payment leaves a reviewed mixed VAT export byte-identical',()=>{
 let state=declaration(invoice([line(100000,25),line(50000)]));const record=state.declarations[0],before=getDeclarationFile(state,record.id).value;
 state=receivePayment(state,state.invoices[0].id,{date:'2026-10-15',amountCents:70000,reference:'PARTIAL'});assert.deepEqual(getDeclarationFile(state,record.id).value,before);assert.equal(boxes(state)['42'],50000);verified(state);
});
test('REVIEW2-VAT-008 later exempt credit invalidates the prior reviewed declaration source',()=>{
 let state=declaration(invoice());const record=state.declarations[0];
 state=createCreditNote(state,{side:'customer',documentId:state.invoices[0].id,date:'2026-10-04',reference:'AFTER-REVIEW',reason:'Delavbokning',lines:[{index:0,netCents:25000}]});
 assert.throws(()=>getDeclarationFile(state,record.id),/ändrats|ny deklarationsversion/);assert.equal(boxes(state)['42'],75000);verified(state);
});
test('REVIEW2-VAT-009 a new incomplete exempt draft prevents finalizing an otherwise clean quarter',()=>{
 let state=invoice();state=createInvoice(state,{customerId:state.customers[0].id,date:'2026-10-05',dueDate:'2026-10-31',lines:[line(50000,0,{vatExemption:{code:'education',legalBasis:'',confirmed:false}})]});
 noWrite(state,()=>fileVatPeriod(state,period()),/utkast/);assert.equal(boxes(state)['42'],100000);verified(state);
});
test('REVIEW2-VAT-010 native, direct and foreign exempt sources add without duplicated tax base',()=>{
 let state=invoice([line(100000,25),line(50000)]);state=direct(state,{netCents:30000});state=fx(state,{number:'COMBINED',lines:[{description:'Lokalhyra',foreignNetMinor:20000,vatRate:0}]});
 const report=getTaxDeclarationReport(state);assert.deepEqual([report.boxes['05'],report.boxes['42'],report.boxes['10']],[100000,300000,25000]);assert.equal(report.evidence.length,3);assert.deepEqual(report.warnings,[]);assert.equal(report.reconciled,true);verified(state);
});
test('REVIEW2-VAT-011 paid FX invoice credit and refund preserve original SEK tax bases despite changed rates',()=>{
 let state=fx(createEmptyState(),{lines:[{description:'Tjänst',foreignNetMinor:10000,vatRate:6},{description:'Lokalhyra',foreignNetMinor:20000,vatRate:0}]});const id=state.fxDocuments[0].id,original=state.fxDocuments[0].snapshot;
 state=settleFxDocument(state,id,{date:'2026-10-05',foreignMinor:30600,bankCents:367200,feeCents:100,reference:'PAY'});
 state=creditFxDocument(state,id,{date:'2026-10-06',lines:[{index:1,foreignNetMinor:5000}],reason:'Minskad hyra',reference:'CREDIT',rate:'13',rateSource:'Fiktiv kurs',rateReviewed:true});
 state=settleFxDocument(state,id,{date:'2026-10-07',foreignMinor:5000,bankCents:65200,feeCents:200,reference:'REFUND',refund:true});
 assert.deepEqual([boxes(state)['05'],boxes(state)['42'],boxes(state)['12']],[110000,165000,6600]);assert.equal(state.fxDocuments[0].snapshot,original);verified(state);
});
test('REVIEW2-VAT-012 partitioned FX credits conserve every rounded ore of exempt and taxable rows',()=>{
 let state=fx(createEmptyState(),{rate:'11.333333',lines:[{description:'Tjänst',foreignNetMinor:101,vatRate:6},{description:'Lokalhyra',foreignNetMinor:103,vatRate:0}]});const id=state.fxDocuments[0].id;
 for(const [i,a,b]of [[0,1,1],[1,37,17],[2,63,85]])state=creditFxDocument(state,id,{date:`2026-10-0${i+2}`,lines:[{index:0,foreignNetMinor:a},{index:1,foreignNetMinor:b}],reason:'Delvis avtal hävt',reference:`FX-PART-${i}`,rate:'11.333333',rateSource:'Samma kurs',rateReviewed:true});
 assert.deepEqual([boxes(state)['05'],boxes(state)['42'],boxes(state)['12']],[0,0,0]);assert.equal(accountBalance(state,'1510'),0);verified(state);
});
test('REVIEW2-VAT-013 monthly cash payments allocate mixed bases once across a filed period',()=>{
 let state=cash([{description:'Tjänst',netCents:10000,vatRate:25},{description:'Lokalhyra',netCents:5000,vatRate:0}]);const id=state.cashDocuments[0].id;
 state=payCashDocument(state,id,{date:'2026-01-20',amountCents:7000,reference:'JAN'});state=fileVatPeriod(state,period('2026-01-01','2026-01-31'));state=payCashDocument(state,id,{date:'2026-02-05',amountCents:10500,reference:'FEB'});
 assert.deepEqual([boxes(state,period('2026-01-01','2026-01-31'))['05'],boxes(state,period('2026-01-01','2026-01-31'))['42'],boxes(state,period('2026-01-01','2026-01-31'))['10']],[4000,2000,1000]);
 assert.deepEqual([boxes(state,period('2026-02-01','2026-02-28'))['05'],boxes(state,period('2026-02-01','2026-02-28'))['42'],boxes(state,period('2026-02-01','2026-02-28'))['10']],[6000,3000,1500]);verified(state);
});
test('REVIEW2-VAT-014 refund of mixed cash credit moves only the next month tax bases',()=>{
 let state=cash([{description:'Tjänst',netCents:10000,vatRate:25},{description:'Lokalhyra',netCents:5000,vatRate:0}]);const id=state.cashDocuments[0].id;
 state=payCashDocument(state,id,{date:'2026-01-20',amountCents:17500,reference:'JAN'});state=fileVatPeriod(state,period('2026-01-01','2026-01-31'));state=creditCashDocument(state,id,{date:'2026-02-05',amountCents:7000,reference:'CREDIT',reason:'Prisnedsättning'});state=refundCashDocument(state,id,{date:'2026-02-06',amountCents:7000,reference:'REFUND'});
 assert.deepEqual([boxes(state,period('2026-02-01','2026-02-28'))['05'],boxes(state,period('2026-02-01','2026-02-28'))['42'],boxes(state,period('2026-02-01','2026-02-28'))['10']],[-4000,-2000,-1000]);assert.deepEqual([boxes(state,period('2026-01-01','2026-02-28'))['05'],boxes(state,period('2026-01-01','2026-02-28'))['42']],[6000,3000]);verified(state);
});
test('REVIEW2-VAT-015 unpaid cash exemption does not enter a declaration until receipt',()=>{
 let state=cash([{description:'Lokalhyra',netCents:12345,vatRate:0}]);state=declaration(state,period('2026-01-01','2026-01-31'));const id=state.declarations[0].id;assert.equal(boxes(state,period('2026-01-01','2026-01-31'))['42'],0);
 state=payCashDocument(state,state.cashDocuments[0].id,{date:'2026-01-20',amountCents:12345,reference:'RECEIPT'});assert.equal(boxes(state,period('2026-01-01','2026-01-31'))['42'],12345);assert.throws(()=>getDeclarationFile(state,id),/ändrats/);verified(state);
});
test('REVIEW2-VAT-016 crediting one of two exemption categories preserves each independent original ground',()=>{
 const school=exemption('education','Fiktiv utbildning enligt 10 kap. 15 § ML.'),insurance=exemption('insurance','Fiktiv försäkring enligt 10 kap. 32 § ML.');let state=invoice([line(70000,0,{vatExemption:school}),line(30000,0,{vatExemption:insurance})]);
 state=createCreditNote(state,{side:'customer',documentId:state.invoices[0].id,date:'2026-10-03',reference:'SCHOOL-ONLY',reason:'Kursdel avbokad',lines:[{index:0,netCents:35000}]});
 assert.deepEqual(state.invoices[0].lines.map(x=>x.vatExemption),[school,insurance]);assert.deepEqual(state.settlements[0].lines[0].vatExemption,school);assert.equal(boxes(state)['42'],65000);verified(state);
});
test('REVIEW2-VAT-017 new classified sale never silently repairs a real older unclassified sale',()=>{
 let state=legacyZeroVatFixture('sole');const original=JSON.stringify(state.invoices[0]);state=direct(state,{netCents:25000});const report=getTaxDeclarationReport(state);
 assert.equal(report.boxes['42'],25000);assert.ok(report.boxes['05']>0);assert.ok(report.warnings.length>0);assert.equal(JSON.stringify(state.invoices[0]),original);noWrite(state,()=>fileVatPeriod(state,period()),/oklassificerade/);verified(state);
});
test('REVIEW2-VAT-018 exempt legal evidence remains text in the invoice and original snapshot',()=>{
 const proof=exemption('education','10 kap ML – <img src=x onerror="alert(1)"> & granskat villkor');const state=invoice([line(100000,0,{vatExemption:proof})]);const html=invoiceDocumentHTML(state,state.invoices[0]);
 assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('&amp; granskat'));assert.ok(invoiceBookingSnapshot(state.invoices[0]).includes('onerror'));assert.equal(boxes(state)['42'],100000);verified(state);
});

test('REVIEW2-VAT-019 filed taxable base is protected even when VAT rounds to zero ore',()=>{
 for(const vatRate of [6,12,25]){
  let state=direct(createEmptyState(),{vatRate,netCents:1,vatExemption:undefined});assert.equal(boxes(state)['05'],1);
  assert.equal(boxes(state)[{6:'12',12:'11',25:'10'}[vatRate]],0);
  state=fileVatPeriod(state,period());noWrite(state,()=>reverseTaxTransaction(state,state.taxTransactions[0].id,{date:'2026-10-04',reason:'Rättelse av ett öre i låst momsunderlag'}),/fastställd/);
 }
});
test('REVIEW2-VAT-020 non-VAT purchase reversal remains allowed when no declaration field changes',()=>{
 let state=postTaxTransaction(createEmptyState(),{kind:'domestic-purchase',date:'2026-10-03',reference:'NONVAT-PURCHASE',counterparty:'Fiktiv leverantör',country:'SE',netCents:10000,vatRate:0,conditionsConfirmed:true});
 assert.deepEqual(state.taxTransactions[0].boxes,{});state=fileVatPeriod(state,period());const before=boxes(state);
 state=reverseTaxTransaction(state,state.taxTransactions[0].id,{date:'2026-10-04',reason:'Återför inköp utan momsunderlag'});
 assert.deepEqual(boxes(state),before);assert.equal(state.taxTransactions.length,2);verified(state);
});
