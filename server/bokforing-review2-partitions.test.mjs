import test from 'node:test';
import assert from 'node:assert/strict';
import { accountBalance } from '../public/bokforing/suite/core.js';
import { createEmptyState, createCustomer, createInvoice } from './fixtures/bokforing-compliant-invoices.mjs';
import { issueInvoice, receivePayment } from '../public/bokforing/suite/sales.js';
import { createCreditNote, refundCredit } from '../public/bokforing/suite/settlements.js';
import { createCashState, createCashDocument, issueCashDocument, payCashDocument, creditCashDocument, refundCashDocument } from '../public/bokforing/suite/cash-method.js';
import { createFxDocument, issueFxDocument, settleFxDocument, creditFxDocument, getFxPosition } from '../public/bokforing/suite/fx.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

// Metamorphic checks: a completed sale/full return has the same balances whether
// payments and refunds arrive together or in uneven pieces. Facit is expressed
// independently in integer öre; no production total/allocation helper is used.
const cases = [
  { label:'25% och ojämna ören', rows:[[10003,25]], rate:'11.12345678' },
  { label:'12% och sista öret', rows:[[107,12]], rate:'0.87654321' },
  { label:'6% och små belopp', rows:[[37,6]], rate:'1.23456789' },
  { label:'blandade skattesatser', rows:[[113,25],[211,12],[307,6]], rate:'11.11' },
];
const round = (value, numerator, denominator=100) => Number((BigInt(value)*BigInt(numerator)*2n+BigInt(denominator))/(2n*BigInt(denominator)));
const pieces = total => [1,Math.floor(total/3),total-1-Math.floor(total/3)];
const saved = state => {const copy=JSON.parse(JSON.stringify(state));validateSuiteState(copy);return copy;};
const balances = state => Object.fromEntries(['1930','1510','3000','2611','2621','2631','6570'].map(a=>[a,accountBalance(state,a)]));
const party = {partyName:'Fiktiv återköpskund',partyAddress:'Provvägen 1',partyPostalCode:'12345',partyCity:'Demostaden',partyCountry:'SE',performance:{mode:'invoice-date',confirmed:true}};
const basic = {date:'2026-10-01',dueDate:'2026-10-31'};
function invoiceTotals(rows){return {net:rows.reduce((s,[n])=>s+n,0),vat:rows.reduce((s,[n,v])=>s+round(n,v),0)};}
function checkPaid(state, expected) {
  assert.equal(accountBalance(state,'1930'),expected.net+expected.vat);
  assert.equal(accountBalance(state,'1510'),0);
  assert.equal(accountBalance(state,'3000'),-expected.net);
  assert.equal(['2611','2621','2631'].reduce((s,a)=>s+accountBalance(state,a),0),-expected.vat);
}
function checkReturned(state, originalEntry) {
  assert.deepEqual(balances(state),{'1930':0,'1510':0,'3000':0,'2611':0,'2621':0,'2631':0,'6570':0});
  assert.equal(accountBalance(state,'3960')+accountBalance(state,'7960'),0);
  if(originalEntry)assert.deepEqual(state.entries[0],originalEntry);
}
for(const c of cases) {
  test(`REVIEW2-PARTITION native ${c.label}: uneven payment and refund partitions conserve every öre`,()=>{
    const expected=invoiceTotals(c.rows),gross=expected.net+expected.vat;
    let base=createCustomer(createEmptyState(),{name:party.partyName});
    base=createInvoice(base,{...basic,customerId:base.customers[0].id,lines:c.rows.map(([n,v])=>({description:'Fiktiv vara',quantity:1,unitCents:n,vatRate:v,kind:'material'}))});
    const id=base.invoices[0].id;base=issueInvoice(base,id);
    const original=structuredClone(base.entries[0]),snapshot=base.invoices[0].bookingSnapshot;
    const results=[];
    for(const divided of [false,true]) {
      let state=saved(base);
      for(const [i,n] of (divided?pieces(gross):[gross]).entries())state=saved(receivePayment(state,id,{date:'2026-10-02',amountCents:n,reference:`PAY-${i}`}));
      checkPaid(state,expected);
      state=saved(createCreditNote(state,{side:'customer',documentId:id,date:'2026-10-03',reference:'FULL-RETURN',reason:'Hela köpet återgår',lines:c.rows.map(([n],index)=>({index,netCents:n}))}));
      for(const [i,n] of (divided?pieces(gross).reverse():[gross]).entries())state=saved(refundCredit(state,{side:'customer',documentId:id,date:'2026-10-04',amountCents:n,reference:`REFUND-${i}`}));
      checkReturned(state,original);assert.equal(state.invoices[0].bookingSnapshot,snapshot);
      const before=structuredClone(state);assert.throws(()=>refundCredit(state,{side:'customer',documentId:id,date:'2026-10-05',amountCents:1,reference:'EXCESS'}));assert.deepEqual(state,before);
      results.push(balances(state));
    }
    assert.deepEqual(results[0],results[1]);
  });
  test(`REVIEW2-PARTITION cash ${c.label}: paid revenue and full return do not depend on payment partitions`,()=>{
    const expected=invoiceTotals(c.rows),gross=expected.net+expected.vat;
    let base=createCashState({eligibilityConfirmed:true,expectedTurnoverCents:100000,vatPeriod:'year'});
    base=createCashDocument(base,{...basic,...party,side:'customer',reference:'CASH-PARTITION',supplyConfirmed:true,lines:c.rows.map(([n,v])=>({description:'Fiktiv vara',netCents:n,vatRate:v}))});
    const id=base.cashDocuments[0].id;base=issueCashDocument(base,id);const snapshot=base.cashDocuments[0].snapshot;
    const results=[];
    for(const divided of [false,true]) {
      let state=saved(base);
      for(const [i,n] of (divided?pieces(gross):[gross]).entries())state=saved(payCashDocument(state,id,{date:'2026-10-02',amountCents:n,reference:`PAY-${i}`}));
      checkPaid(state,expected);
      state=saved(creditCashDocument(state,id,{date:'2026-10-03',amountCents:gross,reference:'FULL-RETURN',reason:'Hela köpet återgår'}));
      for(const [i,n] of (divided?pieces(gross).reverse():[gross]).entries())state=saved(refundCashDocument(state,id,{date:'2026-10-04',amountCents:n,reference:`REFUND-${i}`}));
      checkReturned(state);assert.equal(state.cashDocuments[0].snapshot,snapshot);
      const before=structuredClone(state);assert.throws(()=>refundCashDocument(state,id,{date:'2026-10-05',amountCents:1,reference:'EXCESS'}));assert.deepEqual(state,before);
      results.push(balances(state));
    }
    assert.deepEqual(results[0],results[1]);
  });
  test(`REVIEW2-PARTITION FX ${c.label}: separate currency rounding cancels on a fully repaid return`,()=>{
    const digits=c.rate.split('.')[1].length,denominator=10**digits,numerator=Number(c.rate.replace('.',''));
    const expected={net:c.rows.reduce((s,[n])=>s+round(n,numerator,denominator),0),vat:c.rows.reduce((s,[n,v])=>s+round(round(n,v),numerator,denominator),0)};
    const foreign=invoiceTotals(c.rows),foreignGross=foreign.net+foreign.vat,gross=expected.net+expected.vat;
    let base=createFxDocument(createEmptyState(),{...basic,...party,side:'customer',currency:'EUR',number:'FX-PARTITION',rate:c.rate,rateSource:'Fiktiv granskad kurs',taxTreatment:'domestic',taxReviewed:true,paymentReference:'REF',sellerName:'Fiktivt AB',sellerAddress:'Provvägen 2',sellerPostalCode:'12345',sellerCity:'Demostaden',sellerCountry:'SE',sellerOrgNumber:'5599999991',sellerVatNumber:'SE559999999101',lines:c.rows.map(([n,v])=>({description:'Fiktiv vara',foreignNetMinor:n,vatRate:v}))});
    const id=base.fxDocuments[0].id;base=issueFxDocument(base,id);const original=structuredClone(base.entries[0]),document=structuredClone(base.fxDocuments[0]);
    const results=[];
    for(const divided of [false,true]) {
      let state=saved(base),allocated=0,cumulative=0;
      const foreignPieces=divided?pieces(foreignGross):[foreignGross];
      for(const [i,n] of foreignPieces.entries()){cumulative+=n;const target=round(gross,cumulative,foreignGross);state=saved(settleFxDocument(state,id,{date:'2026-10-02',foreignMinor:n,bankCents:target-allocated,reference:`PAY-${i}`}));allocated=target;}
      checkPaid(state,expected);assert.equal(getFxPosition(state,id).foreignBalanceMinor,0);
      state=saved(creditFxDocument(state,id,{date:'2026-10-03',reference:'FULL-RETURN',reason:'Hela köpet återgår',rate:c.rate,rateSource:'Samma fiktiva kurs',rateReviewed:true,lines:c.rows.map(([n],index)=>({index,foreignNetMinor:n}))}));
      cumulative=0;allocated=0;
      for(const [i,n] of [...foreignPieces].reverse().entries()){cumulative+=n;const target=round(gross,cumulative,foreignGross);state=saved(settleFxDocument(state,id,{date:'2026-10-04',foreignMinor:n,bankCents:target-allocated,reference:`REFUND-${i}`,refund:true}));allocated=target;}
      checkReturned(state,original);assert.equal(getFxPosition(state,id).foreignBalanceMinor,0);assert.deepEqual(state.fxDocuments[0],document);
      results.push(balances(state));
    }
    assert.deepEqual(results[0],results[1]);
  });
}
