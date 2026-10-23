import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createEmptyState } from '../public/bokforing/suite/core.js';
import { createCustomer, createInvoice, issueInvoice, creditInvoice, copyInvoice, invoiceBookingSnapshot } from '../public/bokforing/suite/sales.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { invoiceDocumentHTML, renderInvoiceDetail } from '../public/bokforing/suite/invoice-page.js';
import { getInvoiceIssuanceIssues, validSwedishVatNumber } from '../public/bokforing/suite/invoice-requirements.js';

// ML (2023:200) 17 kap. 24, 26 §§: completeness and amendments, not a
// confirmation that the fictional supplier is actually VAT-registered.
const customer = {name:'Testkund AB',address:'Kundgatan 1',postalCode:'12345',city:'Teststad',country:'SE',vatNumber:'SE559999998301'};
const ordinary = {description:'Utfört arbete',kind:'labor',quantity:1,unitCents:10000,vatRate:25};
const exemption = {code:'healthcare',legalBasis:'Fiktivt granskat vårdfall enligt 10 kap. ML',confirmed:true};
function make(payload = {}, company = {}) {
  let state=createCustomer(createEmptyState(),customer);
  Object.assign(state.company,company);
  return createInvoice(state,{customerId:state.customers[0].id,date:'2026-10-23',dueDate:'2026-11-22',lines:[ordinary],...payload,
    details:payload.details===undefined?{performance:{mode:'invoice-date',confirmed:true}}:payload.details});
}
const last=state=>state.invoices.at(-1);
const issue=state=>issueInvoice(state,last(state).id);
function unchangedFailure(state, pattern) {
  const before=JSON.stringify(state);assert.throws(()=>issue(state),pattern);assert.equal(JSON.stringify(state),before);
}

for (const field of ['address','postalCode','city','vatNumber']) test(`INVOICE-REQ seller ${field} is required before posting`,()=>{
  const state=make();state.company[field]='';unchangedFailure(state,/Säljaren|Säljarens/);
});
for (const field of ['address','postalCode','city']) test(`INVOICE-REQ buyer ${field} is required before posting`,()=>{
  const state=make();last(state).details.customer[field]='';unchangedFailure(state,/Köparen/);
});
test('INVOICE-REQ incomplete draft remains editable and can be saved',()=>{
  let state=createCustomer(createEmptyState(),{name:'Ofullständig kund'});
  state=createInvoice(state,{customerId:state.customers[0].id,date:'2026-10-23',dueDate:'2026-11-22',lines:[ordinary]});
  assert.equal(last(state).status,'draft');assert.equal(state.entries.length,0);
  const html=renderInvoiceDetail(state,last(state));assert.match(html,/Komplettera före utfärdande/);assert.match(html,/postnummer saknas/);
  unchangedFailure(state,/kompletteras/);
});
test('INVOICE-REQ implicit or unconfirmed performance date cannot issue',()=>{
  for (const performance of [undefined,{mode:'invoice-date',confirmed:false}]) unchangedFailure(make({details:{performance}}),/Bekräfta datum/);
});
test('INVOICE-REQ valid issue freezes exact performance date and current seller',()=>{
  let state=issue(make());const invoice=last(state);assert.equal(invoice.details.requirementsVersion,1);
  assert.deepEqual(invoice.details.performance,{mode:'date',date:'2026-10-23',confirmed:true});
  const frozen=invoice.bookingSnapshot;state.company.address='Senare adress';state.company.vatNumber='';
  assert.equal(invoiceBookingSnapshot(invoice),frozen);assert.equal(invoice.details.seller.address,'Exempelgatan 1');
  validateSuiteState(JSON.parse(JSON.stringify(state)));
});
test('INVOICE-REQ another performance date and a valid period print explicitly',()=>{
  for (const performance of [{mode:'date',date:'2026-10-20',confirmed:true},{mode:'period',from:'2026-10-01',to:'2026-10-20',confirmed:true}]) {
    const state=issue(make({details:{performance}}));const html=invoiceDocumentHTML(state,last(state));
    assert.match(html,/2026-10-20/);assert.match(html,/SE559999999101/);assert.match(html,/12345 Teststad/);validateSuiteState(state);
  }
});
test('INVOICE-REQ invalid or inverted performance periods cannot issue',()=>{
  for (const performance of [{mode:'period',from:'2026-10-20',to:'2026-10-01',confirmed:true},{mode:'period',from:'',to:'2026-10-20',confirmed:true}]) unchangedFailure(make({details:{performance}}),/Utförandeperioden/);
});
test('INVOICE-REQ advance receipts and future work need a separate accounting flow',()=>{
  unchangedFailure(make({details:{performance:{mode:'advance-payment',date:'2026-10-20',confirmed:true}}}),/separat förskottsflöde/);
  unchangedFailure(make({details:{performance:{mode:'date',date:'2026-10-25',confirmed:true}}}),/före leverans/);
  unchangedFailure(make({details:{performance:{mode:'period',from:'2026-10-20',to:'2026-11-01',confirmed:true}}}),/före leverans/);
});
test('INVOICE-REQ reverse construction requires buyer VAT and confirmation',()=>{
  const state=make({vatMode:'reverse-construction',buyerConstructionConfirmed:true});last(state).details.customer.vatNumber='';
  unchangedFailure(state,/Köparens svenska momsregistreringsnummer/);
  const valid=issue(make({vatMode:'reverse-construction',buyerConstructionConfirmed:true}));validateSuiteState(valid);
  assert.match(invoiceDocumentHTML(valid,last(valid)),/SE559999998301/);
});
test('INVOICE-REQ VAT format validates check digit but does not verify registration',()=>{
  assert.equal(validSwedishVatNumber('SE 559999-9991 01'),true);
  for (const value of ['SE559999999201','DE559999999101','SE559999999102','DEMO','']) assert.equal(validSwedishVatNumber(value),false);
  unchangedFailure(make({}, {vatNumber:'SE559999999201'}),/momsregistreringsnummer/);
});
test('INVOICE-REQ wholly exempt invoice may omit supplier VAT but keeps legal basis',()=>{
  const state=issue(make({lines:[{...ordinary,vatRate:0,vatExemption:exemption}]},{vatNumber:''}));
  assert.match(invoiceDocumentHTML(state,last(state)),/Undantag från skatteplikt/);validateSuiteState(state);
});
test('INVOICE-REQ mixed taxable and exempt supplies still require supplier VAT',()=>{
  unchangedFailure(make({lines:[ordinary,{...ordinary,vatRate:0,vatExemption:exemption}]},{vatNumber:''}),/Säljarens/);
});
test('INVOICE-REQ unclassified zero VAT stays draft and cannot be posted',()=>{
  unchangedFailure(make({lines:[{...ordinary,vatRate:0}]}),/0 % räcker inte/);
  const pending=make({lines:[{...ordinary,vatRate:0,vatExemption:{code:'healthcare',legalBasis:'',confirmed:false}}]});
  assert.doesNotThrow(()=>renderInvoiceDetail(pending,last(pending)));unchangedFailure(pending,/hänvisning och bedömning/);
});
test('INVOICE-REQ exemption metadata cannot be silently carried onto taxable lines',()=>{
  unchangedFailure(make({lines:[{...ordinary,vatExemption:exemption}]}),/bara anges/);
});
test('INVOICE-REQ copied invoice requires a new date confirmation',()=>{
  let state=issue(make());state=copyInvoice(state,last(state).id,{date:'2026-10-24',dueDate:'2026-11-23'});
  assert.equal(last(state).details.performance.confirmed,false);unchangedFailure(state,/Bekräfta datum/);
});
test('INVOICE-REQ credit retains the original supply date, address and VAT',()=>{
  let state=issue(make());state=creditInvoice(state,last(state).id,{date:'2026-10-26',reason:'Återföring'});
  const html=invoiceDocumentHTML(state,last(state));assert.match(html,/Leverans\/utförande: 2026-10-23/);
  assert.match(html,/Originalfakturans datum/);validateSuiteState(state);
});
test('INVOICE-REQ tampered required fields fail restore even with a rebuilt snapshot',()=>{
  const state=issue(make());last(state).details.customer.postalCode='';last(state).bookingSnapshot=invoiceBookingSnapshot(last(state));
  assert.throws(()=>validateSuiteState(state),/postnummer saknas/);
});
test('INVOICE-REQ user text is escaped on the complete invoice document',()=>{
  const state=make();last(state).details.customer.name='<img src=x onerror=alert(1)>';
  const issued=issue(state),html=invoiceDocumentHTML(issued,last(issued));assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img src=x/);
});
test('INVOICE-REQ helper reports every missing party field together',()=>{
  const issues=getInvoiceIssuanceIssues({seller:{},customer:{},date:'2026-10-23'});
  assert.ok(issues.length>=12);assert.ok(issues.some(x=>x.includes('Bekräfta datum')));
});

test('INVOICE-REQ an optional buyer VAT number must still be valid when supplied',()=>{
  const state=make();last(state).details.customer.vatNumber='SE559999999201';unchangedFailure(state,/angivna momsregistreringsnummer/);
});

test('INVOICE-REQ Swedish supplier organisation and VAT identity must agree',()=>{
  assert.doesNotThrow(()=>issue(make({}, {orgNumber:'559999-9991'})));
  unchangedFailure(make({}, {orgNumber:'559999-9983'}),/Säljarens organisations-\/personnummer.*olika/);
});
test('INVOICE-REQ 16-prefixed Swedish organisation numbers use the same ten-digit VAT identity',()=>{
  assert.doesNotThrow(()=>issue(make({}, {orgNumber:'165599999991'})));
  unchangedFailure(make({}, {orgNumber:'165599999983'}),/Säljarens organisations-\/personnummer.*olika/);
});
test('INVOICE-REQ Swedish buyer organisation and VAT identity must agree',()=>{
  const state=make();last(state).details.customer.orgNumber='559999-9991';
  unchangedFailure(state,/Köparens organisations-\/personnummer.*olika/);
  last(state).details.customer.orgNumber='559999-9983';assert.doesNotThrow(()=>issue(state));
});
test('INVOICE-REQ ten and twelve-digit sole-trader identity matches the same VAT identity',()=>{
  for (const orgNumber of ['850101-1236','198501011236']) {
    assert.doesNotThrow(()=>issue(make({}, {orgNumber,vatNumber:'SE850101123601',legalForm:'sole-trader'})));
    unchangedFailure(make({}, {orgNumber,vatNumber:'SE559999999101',legalForm:'sole-trader'}),/Säljarens organisations-\/personnummer.*olika/);
  }
});
test('INVOICE-REQ free-form imported identifiers are not guessed as registered identities',()=>{
  for (const orgNumber of ['DEMO','IMPORT-5599999983','EXT/5599999983']) assert.doesNotThrow(()=>issue(make({}, {orgNumber,legalForm:'other'})));
});
test('INVOICE-REQ restored new invoice rejects mismatched identity even after snapshot rebuilding',()=>{
  const state=issue(make({}, {orgNumber:'5599999991'}));
  last(state).details.seller.orgNumber='5599999983';last(state).bookingSnapshot=invoiceBookingSnapshot(last(state));
  assert.throws(()=>validateSuiteState(state),/Säljarens organisations-\/personnummer.*olika/);
});

test('INVOICE-REQ AB invoices require the company organisation number and board seat',()=>{
  unchangedFailure(make({}, {orgNumber:'DEMO'}),/giltiga svenska organisationsnummer/);
  unchangedFailure(make({}, {registeredOffice:''}),/styrelsesäte saknas/);
  unchangedFailure(make({}, {legalForm:undefined}),/bolagsform/);
});
test('INVOICE-REQ AB seat and liquidation are printed from the frozen company snapshot',()=>{
  let state=issue(make({}, {registeredOffice:'Sätesstaden',inLiquidation:true}));
  state.company.registeredOffice='Ny sätesort';state.company.inLiquidation=false;
  const html=invoiceDocumentHTML(state,last(state));assert.match(html,/Styrelsens säte: Sätesstaden/);assert.match(html,/Under likvidation/);
  assert.doesNotMatch(html,/Ny sätesort/);validateSuiteState(state);
});
test('INVOICE-REQ AB liquidation status cannot be an untyped assertion',()=>{
  const state=make();state.company.inLiquidation=undefined;unchangedFailure(state,/under likvidation/);
});
test('INVOICE-REQ legacy invoice details stay unchanged when newer AB fields are absent',()=>{
  const state=issue(make());const invoice=last(state);delete invoice.details.requirementsVersion;
  for(const key of ['legalForm','registeredOffice','inLiquidation'])delete invoice.details.seller[key];
  invoice.bookingSnapshot=invoiceBookingSnapshot(invoice);const before=JSON.stringify(invoice);
  validateSuiteState(state);assert.equal(JSON.stringify(invoice),before);
});


test('INVOICE-REQ actual 8a1c143 invoices restore byte-identically without newer AB fields',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/bokforing-legacy-zero-vat-8a1c143.json',import.meta.url),'utf8'));
  for(const state of Object.values(fixture.scenarios)) {
    const before=JSON.stringify(state);validateSuiteState(state);assert.equal(JSON.stringify(state),before);
    for(const invoice of state.invoices) assert.equal(invoiceBookingSnapshot(invoice),invoice.bookingSnapshot);
  }
});
