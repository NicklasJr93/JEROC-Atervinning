import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, accountBalance, validateState } from '../public/bokforing/suite/core.js';
import { createFxDocument, issueFxDocument, settleFxDocument, creditFxDocument, revalueFxDocument, reverseFxRevaluation, getFxPosition, validateFxState, getFxTaxRows, getFxClosingIssues, parseFxRate, convertFxMinor, fxInvoiceHtml, updateFxDraft, removeFxDraft, fxCreditHtml } from '../public/bokforing/suite/fx.js';
import { closeYear, fileVatPeriod, lockPeriod } from '../public/bokforing/suite/finance.js';
import { openNextYear } from '../public/bokforing/suite/financial-years.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { handleAction } from '../public/bokforing/suite/fx-workspace.js';
const base={side:'customer',currency:'EUR',number:'FX-1',date:'2026-10-01',dueDate:'2026-10-31',partyName:'Exempelkund',partyAddress:'Kundgatan 1',sellerName:'Exempel AB',sellerAddress:'Säljgatan 2',sellerOrgNumber:'559900-1236',sellerVatNumber:'SE559900123601',sellerPostalCode:'111 22',sellerCity:'Demostaden',sellerCountry:'SE',partyPostalCode:'111 22',partyCity:'Demostaden',partyCountry:'SE',performance:{mode:'invoice-date',confirmed:true},paymentReference:'Referens FX-1',taxTreatment:'domestic',taxReviewed:true,rate:'11,00',rateSource:'Dokumenterad manuell kurs',lines:[{description:'Tjänst',foreignNetMinor:8000,vatRate:25,account:'4010'}]};
function fixture(overrides={}) { let state=createFxDocument(createEmptyState(),{...base,...overrides});const id=state.fxDocuments[0].id;state=issueFxDocument(state,id);return{state,id}; }
const verify=state=>{validateState(state);validateSuiteState(state);const checks=validateFxState(state);assert.equal(accountBalance(state,'1510'),checks.receivableAdjustmentCents);assert.equal(accountBalance(state,'2440'),(-checks.payableAdjustmentCents)||0);return state;};
const pay=(state,id,foreignMinor,bankCents,reference='BET-1',extra={})=>settleFxDocument(state,id,{date:'2026-10-10',foreignMinor,bankCents,reference,...extra});
const credit=(state,id,foreignNetMinor,reference='KREDIT-1',date='2026-10-11')=>creditFxDocument(state,id,{date,reference,reason:'Retur',rate:'11',rateSource:'Kreditdagskurs',rateReviewed:true,lines:[{index:0,foreignNetMinor}]});

test('foreign monetary units convert through a bounded exact rational, including zero/unsafe rejection',()=>{
 const rate=parseFxRate('11,12345678',{date:'2026-10-01',source:'Kurs'});
 assert.equal(rate.numerator,556172839);assert.equal(rate.denominator,50000000);
 assert.equal(convertFxMinor(100,rate),1112); assert.equal(convertFxMinor(-100,rate),-1112);
 for(const value of ['0','-1','NaN','1.123456789','1e2'])assert.throws(()=>parseFxRate(value,{date:'2026-10-01',source:'Kurs'}));
 assert.throws(()=>convertFxMinor(Number.MAX_SAFE_INTEGER,rate));
});
test('customer EUR invoice freezes foreign components and SEK VAT, then settles with a separately recorded fee and gain',()=>{
 let{state,id}=fixture();verify(state);const original=structuredClone(state.fxDocuments[0]);
 assert.equal(accountBalance(state,'1510'),110000);assert.equal(accountBalance(state,'3000'),-88000);assert.equal(accountBalance(state,'2611'),-22000);
 state=verify(pay(state,id,10000,111500,'BET-1',{feeCents:500}));
 assert.equal(accountBalance(state,'1930'),111500);assert.equal(accountBalance(state,'6570'),500);assert.equal(accountBalance(state,'3960'),-2000);
 assert.equal(getFxPosition(state,id).foreignBalanceMinor,0);assert.equal(getFxPosition(state,id).carryingCents,0);
 assert.deepEqual(state.fxDocuments[0],original);assert.equal(getFxTaxRows(state).length,1);
});
test('supplier USD invoice settles its payable with fee and exchange loss',()=>{
 let{state,id}=fixture({side:'supplier',currency:'USD'});verify(state);
 state=verify(pay(state,id,10000,113500,'BET-1',{feeCents:500}));
 assert.equal(accountBalance(state,'2440'),0);assert.equal(accountBalance(state,'1930'),-113500);assert.equal(accountBalance(state,'6570'),500);assert.equal(accountBalance(state,'7960'),3000);
 assert.equal(accountBalance(state,'2641'),22000);
});
test('partial payments allocate the final carrying öre exactly and reject overpayment/duplicate references/backdated changes',()=>{
 let{state,id}=fixture();state=verify(pay(state,id,3333,36663,'DEL-1'));
 assert.equal(getFxPosition(state,id).carryingCents,73337);
 assert.throws(()=>pay(state,id,6668,73348,'OVER'),/överstiger/);
 assert.throws(()=>pay(state,id,1,11,'DEL-1'),/dubblerad/);
 assert.throws(()=>pay(state,id,1,11,'OLD',{date:'2026-10-09'}),/före/);
 state=verify(pay(state,id,6667,73337,'DEL-2'));assert.equal(accountBalance(state,'1510'),0);
});
test('mixed VAT credit allocates exact original component öre and preserves the posted original',()=>{
 let{state,id}=fixture({rate:'1,12345678',lines:[{description:'Liten',foreignNetMinor:3,vatRate:25},{description:'Bok',foreignNetMinor:1001,vatRate:6}]});
 const original=structuredClone(state.fxDocuments[0]);
 for(let index=0;index<3;index++)state=verify(creditFxDocument(state,id,{date:'2026-10-11',reference:'C'+index,reason:'Retur',lines:[{index:0,foreignNetMinor:1}]}));
 state=verify(creditFxDocument(state,id,{date:'2026-10-11',reference:'C-BOOK',reason:'Retur',lines:[{index:1,foreignNetMinor:1001}]}));
 for(const account of ['1510','3000','2611','2631'])assert.equal(accountBalance(state,account),0);
 assert.deepEqual(state.fxDocuments[0],original);
 assert.throws(()=>credit(state,id,1,'TOO-MUCH'),/överstiger/);
 assert.equal(getFxTaxRows(state).filter(row=>row.baseCents<0).length,4);
});
test('credit after payment creates a foreign credit balance and a real refund settles it at a new course',()=>{
 let{state,id}=fixture();state=pay(state,id,10000,110000);state=verify(credit(state,id,4000));
 assert.equal(getFxPosition(state,id).foreignBalanceMinor,-5000);assert.equal(accountBalance(state,'1510'),-55000);
 state=verify(settleFxDocument(state,id,{date:'2026-10-12',foreignMinor:5000,bankCents:56000,reference:'RETUR-1',refund:true}));
 assert.equal(getFxPosition(state,id).foreignBalanceMinor,0);assert.equal(accountBalance(state,'7960'),1000);
 assert.equal(state.bankTransactions.at(-1).amountCents,-56000);
});
test('supplier credit/refund and a credit crossing a partial payment both retain exactly one payable/receivable',()=>{
 let{state,id}=fixture({side:'supplier'});state=pay(state,id,5000,55000);state=verify(credit(state,id,8000));
 assert.equal(getFxPosition(state,id).foreignBalanceMinor,-5000);assert.equal(accountBalance(state,'2440'),55000);
 state=verify(settleFxDocument(state,id,{date:'2026-10-12',foreignMinor:5000,bankCents:55500,feeCents:500,reference:'RETUR',refund:true}));
 assert.equal(accountBalance(state,'2440'),0);assert.equal(accountBalance(state,'3960'),-1000);assert.equal(accountBalance(state,'6570'),500);
});
test('reviewed year-end valuation changes only carrying value; reversal and new valuation preserve history',()=>{
 let{state,id}=fixture();assert.equal(getFxClosingIssues(state).length,1);
 state=verify(revalueFxDocument(state,id,{date:'2026-12-31',rate:'12',rateSource:'Balansdagsunderlag',reference:'VAL-1',reviewed:true}));
 assert.equal(getFxPosition(state,id).carryingCents,120000);assert.equal(accountBalance(state,'3960'),-10000);assert.equal(getFxClosingIssues(state).length,0);
 assert.throws(()=>revalueFxDocument(state,id,{date:'2026-12-31',rate:'13',rateSource:'Kurs',reference:'VAL-2',reviewed:true}),/redan värderats/);
 const old=structuredClone(state.fxEvents.at(-1));
 state=verify(reverseFxRevaluation(state,id,{date:'2026-12-31',reversesEventId:old.id,reason:'Fel kurs',reference:'R-1'}));
 assert.equal(getFxPosition(state,id).carryingCents,110000);assert.deepEqual(state.fxEvents.find(event=>event.id===old.id),old);
 state=verify(revalueFxDocument(state,id,{date:'2026-12-31',rate:'11.5',rateSource:'Korrigerad kurs',reference:'VAL-2',reviewed:true}));
 assert.equal(getFxPosition(state,id).carryingCents,115000);
});
test('an unchanged reviewed closing rate is recorded without an artificial zero journal',()=>{
 let{state,id}=fixture(); const count=state.entries.length;
 state=revalueFxDocument(state,id,{date:'2026-12-31',rate:'11',rateSource:'Samma balansdagskurs',reference:'VAL-1',reviewed:true});
 verify(state);assert.equal(state.entries.length,count);assert.equal(state.fxEvents.at(-1).entryId,null);assert.equal(getFxClosingIssues(state).length,0);
});
test('future-year payment uses the revalued carrying amount and does not repeat prior VAT',()=>{
 let{state,id}=fixture();state=revalueFxDocument(state,id,{date:'2026-12-31',rate:'12',rateSource:'Kurs',reference:'VAL',reviewed:true});
 state=fileVatPeriod(state,{from:'2026-10-01',to:'2026-12-31',date:'2026-12-31'});
 for(let month=1;month<=12;month++)state=lockPeriod(state,`2026-${String(month).padStart(2,'0')}`);
 state=closeYear(state,{date:'2026-12-31',confirmed:true});
 state=openNextYear(state,{confirmed:true});
 state=verify(pay(state,id,10000,120500,'NEXT',{date:'2027-01-10'}));assert.equal(accountBalance(state,'1510'),0);assert.equal(accountBalance(state,'2611'),0);assert.equal(accountBalance(state,'2650'),-22000);assert.equal(accountBalance(state,'3960'),-10500);
});
test('period locks, missing review, unsupported foreign VAT and tampered originals or journals are blocked',()=>{
 assert.throws(()=>fixture({currency:'JPY'}),/EUR eller USD/);
 assert.throws(()=>fixture({taxReviewed:false}),/Granska/);
 assert.throws(()=>fixture({taxTreatment:'reverse-construction'}),/Momstypen/);
 let{state,id}=fixture();state.lockedPeriods=['2026-10'];assert.throws(()=>pay(state,id,10000,110000),/låst/);state.lockedPeriods=[];
 for(const mutation of [s=>s.fxDocuments[0].grossCents++,s=>s.fxEvents[0].reference='Ändrat',s=>s.entries[0].rows[0].debitCents++]){const bad=structuredClone(state);mutation(bad);assert.throws(()=>validateFxState(bad));}
});
test('a printed foreign invoice shows currency and frozen SEK VAT, escapes content, and workspace actions use real engine operations',()=>{
 let state=handleAction(createEmptyState(),'create',{...base,reviewed:'on',performanceConfirmed:'on',lines:'Arbete; 80,00; 25; 4010'});const id=state.fxDocuments[0].id;
 state=handleAction(state,'issue',{id});const html=fxInvoiceHtml(state,id);
 assert.match(html,/EUR/);assert.match(html,/220\.00 SEK/);assert.match(html,/11/);
 const custom=structuredClone(state);custom.fxDocuments[0].partyName='<script>alert(1)</script>';const out=fxInvoiceHtml(custom,id);assert.ok(!out.includes('<script>'));assert.match(out,/&lt;script&gt;/);
});

test('drafts can be edited and removed, but posted originals cannot and customer numbers stay unique',()=>{
 let state=createFxDocument(createEmptyState(),base),id=state.fxDocuments[0].id;
 state=updateFxDraft(state,id,{partyName:'Ändrad kund',taxReviewed:true,lines:[{description:'Ny rad',foreignNetMinor:10000,vatRate:25}]});
 assert.equal(state.fxDocuments[0].partyName,'Ändrad kund');assert.equal(state.fxDocuments[0].grossCents,137500);
 const removed=removeFxDraft(state,id);assert.equal(removed.fxDocuments.length,0);
 state=issueFxDocument(state,id);verify(state);
 assert.throws(()=>updateFxDraft(state,id,{taxReviewed:true}),/kan inte redigeras/);
 assert.throws(()=>removeFxDraft(state,id),/kan inte raderas/);
 assert.throws(()=>createFxDocument(state,{...base,partyName:'Annan kund'}),/finns redan/);
});
test('existing bank entry is matched without duplicate money and wrong bank direction is rejected',()=>{
 let {state,id}=fixture();
 state.bankTransactions.push({id:'imported-bank',account:'1930',date:'2026-10-10',description:'Inbetalning',amountCents:110000,matchedEntryId:null});
 assert.throws(()=>pay(state,id,10000,109999,'BAD',{bankEventId:'imported-bank'}),/omatchad bankhändelse/);
 const count=state.bankTransactions.length;
 state=verify(pay(state,id,10000,110000,'GOOD',{bankEventId:'imported-bank'}));
 assert.equal(state.bankTransactions.length,count);assert.ok(state.bankTransactions[0].matchedEntryId);
});
test('credit after revaluation reverses original VAT and recognises only the residual currency difference',()=>{
 let{state,id}=fixture();state=revalueFxDocument(state,id,{date:'2026-12-31',rate:'12',rateSource:'Kurs',reference:'VAL',reviewed:true});
 state=verify(credit(state,id,8000,'KREDIT','2026-12-31'));
 assert.equal(accountBalance(state,'1510'),0);assert.equal(accountBalance(state,'2611'),0);
 assert.equal(accountBalance(state,'3960'),-10000);assert.equal(accountBalance(state,'7960'),10000);
 const html=fxCreditHtml(state,state.fxEvents.at(-1).id);assert.match(html,/KREDITNOTA/);assert.match(html,/FX-1/);assert.match(html,/220\.00 SEK/);
});

test('a newly created refund balance uses the credit-date rate while VAT reverses the original rate',()=>{
 let{state,id}=fixture();state=pay(state,id,10000,110000);
 assert.throws(()=>creditFxDocument(state,id,{date:'2026-10-11',reference:'MISSING-RATE',reason:'Retur',lines:[{index:0,foreignNetMinor:4000}]}),/Valutakursen/);
 state=verify(creditFxDocument(state,id,{date:'2026-10-11',reference:'NEW-RATE',reason:'Retur',rate:'12',rateSource:'Kreditdagskurs',rateReviewed:true,lines:[{index:0,foreignNetMinor:4000}]}));
 assert.equal(getFxPosition(state,id).carryingCents,-60000);assert.equal(accountBalance(state,'7960'),5000);
 assert.equal(accountBalance(state,'2611'),-11000);
 state=verify(settleFxDocument(state,id,{date:'2026-10-12',foreignMinor:5000,bankCents:60000,reference:'REFUND',refund:true}));assert.equal(getFxPosition(state,id).carryingCents,0);assert.equal(accountBalance(state,'7960'),5000);
});
