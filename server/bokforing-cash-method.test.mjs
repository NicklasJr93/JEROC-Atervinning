import assert from 'node:assert/strict';
import test from 'node:test';
import { accountBalance, transact } from '../public/bokforing/suite/core.js';
import { createCashState, createCashDocument, issueCashDocument, payCashDocument, creditCashDocument, refundCashDocument, recognizeCashYearEnd, getCashDocumentSummary, getCashClosingIssues, getCashTaxRows, validateCashState, deleteCashDraft } from '../public/bokforing/suite/cash-method.js';
import { fileVatPeriod, lockPeriod, closeYear } from '../public/bokforing/suite/finance.js';
import { openNextYear } from '../public/bokforing/suite/financial-years.js';
import { createInvoice } from '../public/bokforing/suite/sales.js';
import { createBill } from '../public/bokforing/suite/operations.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { getTaxDeclarationReport } from '../public/bokforing/suite/tax-ledger.js';

const start=()=>createCashState({eligibilityConfirmed:true,expectedTurnoverCents:100_000_000,vatPeriod:'year',orgNumber:'559900-1236',vatNumber:'SE559900123601',postalCode:'111 22',city:'Demostaden',country:'SE'});
function draft(state=start(), extra={}) {
  return createCashDocument(state,{side:'customer',partyName:'Provkund AB',partyAddress:'Testgatan 1',partyPostalCode:'111 22',partyCity:'Demostaden',partyCountry:'SE',performance:{mode:'invoice-date',confirmed:true},reference:'REF-1',date:'2026-10-01',dueDate:'2026-10-31',supplyConfirmed:true,lines:[{description:'Utfört arbete',netCents:100_000,vatRate:25}],...extra});
}
function issued(state=start(),extra={}) {const next=draft(state,extra);return issueCashDocument(next,next.cashDocuments.at(-1).id);}
const id=s=>s.cashDocuments.at(-1).id;
function roll(state){
  let s=fileVatPeriod(state,{from:'2026-01-01',to:'2026-12-31',date:'2026-12-31'});
  for(let m=1;m<=12;m++)s=lockPeriod(s,`2026-${String(m).padStart(2,'0')}`);
  s=closeYear(s,{date:'2026-12-31',confirmed:true});return openNextYear(s,{confirmed:true});
}

test('cash company requires explicit eligibility and the supported turnover; native accrual writes are blocked',()=>{
  assert.throws(()=>createCashState(),/Bekräfta/);
  assert.throws(()=>createCashState({eligibilityConfirmed:true,expectedTurnoverCents:300_000_001}),/tre miljoner/);
  const s=start();
  assert.throws(()=>createInvoice(s,{}),/kontantmetoden/);
  assert.throws(()=>createBill(s,{}),/kontantmetoden/);
  assert.equal(validateCashState(s).claimedEntryIds.length,0);
});
test('issued cash invoice is frozen but creates no income, VAT or receivable before a payment',()=>{
  let s=issued();assert.equal(s.entries.length,0);assert.equal(accountBalance(s,'1510'),0);assert.equal(accountBalance(s,'2611'),0);
  assert.equal(getCashDocumentSummary(s,id(s)).outstandingCents,125_000);
  assert.equal(getCashClosingIssues(s).length,1);
  const corrupted=structuredClone(s);corrupted.cashDocuments[0].lines[0].netCents++;
  assert.throws(()=>validateCashState(corrupted),/ändrats/);
  assert.throws(()=>createCashDocument(s,{...s.cashDocuments[0],id:id(s)}),/inte ändras/);
});
test('partial cash payments recognize only their portion and final settlement leaves exact totals',()=>{
  let s=issued();const doc=id(s);
  s=payCashDocument(s,doc,{date:'2026-10-05',amountCents:50_000,reference:'p1'});
  assert.equal(accountBalance(s,'1930'),50_000);assert.equal(accountBalance(s,'3000'),-40_000);assert.equal(accountBalance(s,'2611'),-10_000);assert.equal(accountBalance(s,'1510'),0);
  s=payCashDocument(s,doc,{date:'2026-10-06',amountCents:75_000,reference:'p2'});
  assert.equal(accountBalance(s,'3000'),-100_000);assert.equal(accountBalance(s,'2611'),-25_000);assert.equal(getCashDocumentSummary(s,doc).outstandingCents,0);
  assert.throws(()=>payCashDocument(s,doc,{date:'2026-10-07',amountCents:1,reference:'over'}),/överstiger/);
  validateCashState(JSON.parse(JSON.stringify(s)));
});
test('supplier invoice mixes VAT and deduction proportions, paid portions reconcile to the full invoice',()=>{
  let s=issued(start(),{side:'supplier',lines:[{description:'Delavdrag',account:'6540',netCents:10_000,vatRate:25,deductibleBps:5000},{description:'Sex procent',account:'6110',netCents:10_000,vatRate:6}]});
  const doc=id(s);s=payCashDocument(s,doc,{date:'2026-10-05',amountCents:11_550,reference:'p1'});s=payCashDocument(s,doc,{date:'2026-10-06',amountCents:11_550,reference:'p2'});
  assert.equal(accountBalance(s,'1930'),-23_100);assert.equal(accountBalance(s,'2641'),1850);assert.equal(accountBalance(s,'6540'),11_250);assert.equal(accountBalance(s,'6110'),10_000);assert.equal(accountBalance(s,'2440'),0);
  assert.equal(getCashTaxRows(s).reduce((sum,row)=>sum+(row.boxes['48']||0),0),1850);
});
test('unpaid credit changes the owed amount without premature income or VAT entries',()=>{
  let s=issued();const doc=id(s),snapshot=s.cashDocuments[0].snapshot;
  s=creditCashDocument(s,doc,{date:'2026-10-05',amountCents:25_000,reference:'c1',reason:'Prisjustering'});
  assert.equal(s.entries.length,0);assert.equal(s.cashEvents[0].number,'CK-0001');assert.equal(s.cashDocuments[0].snapshot,snapshot);
  s=payCashDocument(s,doc,{date:'2026-10-06',amountCents:100_000,reference:'p1'});
  assert.equal(accountBalance(s,'3000'),-80_000);assert.equal(accountBalance(s,'2611'),-20_000);
});
test('credit after payment reverses VAT when a real cash refund is recorded',()=>{
  let s=issued();const doc=id(s);s=payCashDocument(s,doc,{date:'2026-10-05',amountCents:125_000,reference:'p1'});
  const count=s.entries.length;s=creditCashDocument(s,doc,{date:'2026-10-06',amountCents:25_000,reference:'c1',reason:'Del av arbetet återgår'});
  assert.equal(s.entries.length,count);assert.equal(getCashDocumentSummary(s,doc).refundableCents,25_000);
  assert.throws(()=>refundCashDocument(s,doc,{date:'2026-10-07',amountCents:25_001,reference:'over'}),/överstiger/);
  s=refundCashDocument(s,doc,{date:'2026-10-07',amountCents:25_000,reference:'r1'});
  assert.equal(accountBalance(s,'1930'),100_000);assert.equal(accountBalance(s,'3000'),-80_000);assert.equal(accountBalance(s,'2611'),-20_000);
});
test('year-end recognizes unpaid remainder; next-year payment only settles carried receivable',()=>{
  let s=issued();const doc=id(s);s=payCashDocument(s,doc,{date:'2026-10-05',amountCents:50_000,reference:'p1'});
  s=recognizeCashYearEnd(s,{reviewed:true});assert.equal(accountBalance(s,'1510'),75_000);assert.equal(getCashClosingIssues(s).length,0);
  assert.throws(()=>recognizeCashYearEnd(s,{reviewed:true}),/Inga obetalda/);
  s=roll(s);const past=JSON.stringify(s.fiscalYears[0].snapshot);s=payCashDocument(s,doc,{date:'2027-01-05',amountCents:75_000,reference:'p2'});
  assert.deepEqual(s.entries.at(-1).rows.map(r=>r.account),['1510','1930']);assert.equal(accountBalance(s,'1510'),0);assert.equal(JSON.stringify(s.fiscalYears[0].snapshot),past);validateCashState(s);
});
test('year-end recognizes supplier debt and later supplier repayment clears it without new costs',()=>{
  let s=issued(start(),{side:'supplier'}),doc=id(s);s=recognizeCashYearEnd(s,{reviewed:true});assert.equal(accountBalance(s,'2440'),-125_000);
  s=roll(s);s=payCashDocument(s,doc,{date:'2027-01-05',amountCents:125_000,reference:'p1'});
  assert.deepEqual(s.entries.at(-1).rows.map(r=>r.account),['1930','2440']);assert.equal(accountBalance(s,'2440'),0);
});
test('unrefunded paid credit is recognized as a credit balance at year-end and later clears only that balance',()=>{
  let s=issued(),doc=id(s);s=payCashDocument(s,doc,{date:'2026-10-05',amountCents:125_000,reference:'p1'});s=creditCashDocument(s,doc,{date:'2026-10-06',amountCents:25_000,reference:'c1',reason:'Kredit'});
  s=recognizeCashYearEnd(s,{reviewed:true});assert.equal(accountBalance(s,'2490'),-25_000);
  s=roll(s);s=refundCashDocument(s,doc,{date:'2027-01-05',amountCents:25_000,reference:'r1'});
  assert.deepEqual(s.entries.at(-1).rows.map(r=>r.account),['1930','2490']);assert.equal(accountBalance(s,'2490'),0);
  validateSuiteState(s);
});
test('supplier credit is a separate receivable at year-end and its next-year refund does not deduct VAT twice',()=>{
  let s=issued(start(),{side:'supplier'}),doc=id(s);
  s=payCashDocument(s,doc,{date:'2026-10-05',amountCents:125_000,reference:'p1'});
  s=creditCashDocument(s,doc,{date:'2026-10-06',amountCents:25_000,reference:'c1',reason:'Återlämnat material'});
  s=recognizeCashYearEnd(s,{reviewed:true});assert.equal(accountBalance(s,'1680'),25_000);assert.equal(accountBalance(s,'2440'),0);
  validateSuiteState(s);s=roll(s);
  s=refundCashDocument(s,doc,{date:'2027-01-05',amountCents:25_000,reference:'r1'});
  assert.deepEqual(s.entries.at(-1).rows.map(r=>r.account),['1680','1930']);assert.equal(accountBalance(s,'1680'),0);
  assert.equal(getCashTaxRows(s).filter(row=>row.date.startsWith('2027')).reduce((n,row)=>n+(row.boxes['48']??0),0),0);
  validateSuiteState(JSON.parse(JSON.stringify(s)));
});
test('cash VAT report classifies taxable and exempt paid portions and unsupported combinations fail closed',()=>{
  let s=issued(start(),{vatExemption:{code:'property-rental',legalBasis:'Granskad fiktiv momsfri lokalhyra enligt 10 kap. 35 § ML',confirmed:true},vatReason:'Undantag från skatteplikt, granskat i övningen',lines:[{description:'Utfört arbete',netCents:100_000,vatRate:25},{description:'Momsfri prestation',netCents:50_000,vatRate:0}]}),doc=id(s);
  s=payCashDocument(s,doc,{date:'2026-10-05',amountCents:175_000,reference:'p1'});
  const report=getTaxDeclarationReport(s,{from:'2026-01-01',to:'2026-12-31'});
  assert.equal(report.boxes['05'],100_000);assert.equal(report.boxes['42'],50_000);assert.equal(report.boxes['10'],25_000);assert.equal(report.reconciled,true);
  for(const unsupported of [{currency:'EUR'},{rot:{}},{vatMode:'reverse-construction'},{lines:[{description:'EU',netCents:100,vatMode:'eu-sale'}]}])assert.throws(()=>draft(start(),unsupported),/stöder bara SEK|särskilt stödda|internationella/);
  validateSuiteState(s);
});
test('duplicate references, locked periods and missing bank events are rejected atomically',()=>{
  let s=issued(),doc=id(s);s=payCashDocument(s,doc,{date:'2026-10-05',amountCents:50_000,reference:'p1'});
  assert.throws(()=>payCashDocument(s,doc,{date:'2026-10-06',amountCents:1,reference:'p1'}),/finns redan/);
  const locked=transact(s,d=>d.lockedPeriods.push('2026-10'));
  assert.throws(()=>payCashDocument(locked,doc,{date:'2026-10-07',amountCents:1,reference:'p2'}),/låst/);
  const tampered=structuredClone(s);tampered.bankTransactions=[];assert.throws(()=>validateCashState(tampered),/bankhändelse/);
});
test('drafts are editable and removable, while issued originals cannot be deleted',()=>{
  let s=draft(),doc=id(s);s=createCashDocument(s,{...s.cashDocuments[0],id:doc,partyName:'Rättad kund'});assert.equal(s.cashDocuments[0].partyName,'Rättad kund');
  s=deleteCashDraft(s,doc);assert.equal(s.cashDocuments.length,0);
  s=issued();assert.throws(()=>deleteCashDraft(s,id(s)),/utkast/);
});
test('many tiny payments preserve exact cents over mixed rates',()=>{
  let s=issued(start(),{lines:[{description:'En krona',netCents:100,vatRate:25},{description:'Annan moms',netCents:101,vatRate:12}]}),doc=id(s);
  const total=getCashDocumentSummary(s,doc).originalCents;
  for(let i=0;i<total;i++)s=payCashDocument(s,doc,{date:'2026-10-05',amountCents:1,reference:`p-${i}`});
  assert.equal(accountBalance(s,'1930'),238);assert.equal(accountBalance(s,'3000'),-201);assert.equal(accountBalance(s,'2611'),-25);assert.equal(accountBalance(s,'2621'),-12);
});
