import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmptyState,createCustomer,createInvoice,invoiceTestExemption} from './fixtures/bokforing-compliant-invoices.mjs';
import {accountBalance} from '../public/bokforing/suite/core.js';
import {issueInvoice,receivePayment,getInvoiceTotals,getInvoiceOutstanding,copyInvoice,updateInvoiceDraft,requestRot,decideRot} from '../public/bokforing/suite/sales.js';
import {createCreditNote,refundCredit,offsetCredit,getDocumentSettlementSummary} from '../public/bokforing/suite/settlements.js';
import {createRevenueSchedule,recognizeRevenueMonth} from '../public/bokforing/suite/commercial.js';
import {validateSuiteState} from '../public/bokforing/suite/validate.js';

// AUDIT3 extends the earlier single-row arithmetic cases with complete,
// independently calculated, three-line customer histories. Each family has
// twenty reproducible portfolios varying prices, quantity, VAT, discounts and
// inclusive input. No production pricing/allocation function is used as oracle.
let serial=0;
const audit=(family,seed,fn)=>test(`AUDIT3-SALES-${String(++serial).padStart(3,'0')} ${family}; portfolio=${seed}`,fn);
const rounded=(n,d)=>Number((2n*BigInt(n)+BigInt(d))/(2n*BigInt(d)));
const fraction=(n,a,b)=>rounded(BigInt(n)*BigInt(a),b);
const taxes={6:'2631',12:'2621',25:'2611'};
function portfolio(seed,{reverse=false,rot=false}={}){
 const units=[1009,3187,22039,743,9191],quantities=[13,37,125,240,499],rates=[0,6,12,25];
 const discount=[119,750,1777,2431][seed%4];
 const rows=Array.from({length:3},(_,i)=>{
  const vatRate=rot||reverse?25:rates[(seed+i)%4];
  return {description:`Fiktiv avtalsdel ${i+1}`,kind:rot?(i<2?'labor':'material'):'other',quantity:quantities[(seed+2*i)%5]/100,unitCents:units[(seed+i)%5]+seed*29+i*7,vatRate,discountBps:[137,613,1250,2345][(seed+i)%4],unitPriceIncludesVat:!reverse&&seed%2===0,...(vatRate===0?{vatExemption:{...invoiceTestExemption}}:{}),...(rot&&i===1?{rotEligible:false}:{})};
 });
 if(rot){rows[0].unitCents+=40000;rows[1].unitCents+=20000;rows.push({description:'Fiktiv fakturaavgift',kind:'other',quantity:1,unitCents:311+seed,vatRate:25,unitPriceIncludesVat:seed%2===0,chargeType:'invoice-fee'});}
 return {rows,discount};
}
function price(row,discount,reverse=false){
 const base=fraction(row.unitCents,Math.round(row.quantity*100),100);
 const afterRow=base-fraction(base,row.discountBps??0,10000);
 const grossInput=afterRow-fraction(afterRow,row.chargeType?0:discount,10000);
 const net=row.unitPriceIncludesVat&&!reverse?fraction(grossInput,100,100+row.vatRate):grossInput;
 const vat=reverse?0:row.unitPriceIncludesVat?grossInput-net:fraction(net,row.vatRate,100);
 return {net,vat,gross:net+vat,rate:row.vatRate};
}
function oracle(port,reverse=false){const rows=port.rows.map(r=>price(r,port.discount,reverse));return {rows,net:rows.reduce((s,r)=>s+r.net,0),vat:rows.reduce((s,r)=>s+r.vat,0),gross:rows.reduce((s,r)=>s+r.gross,0)};}
function issue(port,{state,customerId,reverse=false,rot}={}){
 let s=state??createCustomer(createEmptyState(),{name:'Fiktiv avtalskund A'});
 s=createInvoice(s,{customerId:customerId??s.customers[0].id,date:'2026-05-01',dueDate:'2026-05-31',lines:port.rows,invoiceDiscountBps:port.discount,...(reverse?{vatMode:'reverse-construction',buyerConstructionConfirmed:true}:{}),...(rot?{rot}:{})});
 const id=s.invoices.at(-1).id;s=issueInvoice(s,id);return {state:s,id};
}
const doc=(s,id)=>s.invoices.find(i=>i.id===id);
function checked(s){validateSuiteState(s);validateSuiteState(JSON.parse(JSON.stringify(s)));return s;}
function rejects(s,run,rx){const before=JSON.stringify(s);assert.throws(run,rx);assert.equal(JSON.stringify(s),before);}
const pay=(s,id,n,ref='PAY',date='2026-05-02',extra={})=>receivePayment(s,id,{amountCents:n,date,reference:ref,...extra});
const selection=(o,a,b)=>o.rows.map((r,index)=>({index,netCents:Math.max(1,Math.floor(r.net*a/b))}));
function creditOracle(o,selected){return {net:selected.reduce((s,r)=>s+r.netCents,0),vat:selected.reduce((s,r)=>s+fraction(o.rows[r.index].vat,r.netCents,o.rows[r.index].net),0),rows:selected.map(r=>({...r,vat:fraction(o.rows[r.index].vat,r.netCents,o.rows[r.index].net),rate:o.rows[r.index].rate}))};}
const credit=(s,id,lines,ref='CREDIT',extra={})=>createCreditNote(s,{side:'customer',documentId:id,date:'2026-05-04',reason:'Avtalad minskning av fiktivt uppdrag',reference:ref,lines,...extra});
function ledger(s,o,c={net:0,vat:0,rows:[]},{bank=o.gross-c.net-c.vat,control=0,reverse=false}={}){
 assert.equal(accountBalance(s,'1930'),bank);
 assert.equal(accountBalance(s,'1510'),control);
 assert.equal(accountBalance(s,reverse?'3231':'3000'),0-(o.net-c.net));
 for(const [rate,account] of Object.entries(taxes)){const v=o.rows.filter(r=>r.rate===Number(rate)).reduce((sum,r)=>sum+r.vat,0)-c.rows.filter(r=>r.rate===Number(rate)).reduce((sum,r)=>sum+r.vat,0);assert.equal(accountBalance(s,account),0-v);}
}
function originalPreserved(s,old){assert.deepEqual(s.entries.slice(0,old.length),old);}

// 001–020: an intervening partial credit must reduce the final permitted receipt.
for(let seed=0;seed<20;seed++)audit('partial payment, intervening multi-rate credit, final receipt',seed,()=>{
 const p=portfolio(seed),o=oracle(p);let{state:s,id}=issue(p);const old=structuredClone(s.entries),lines=selection(o,2,5),c=creditOracle(o,lines),first=Math.floor((o.gross-c.net-c.vat)/2);
 s=pay(s,id,first);s=credit(s,id,lines);
 const remainder=o.gross-c.net-c.vat-first;
 rejects(s,()=>pay(s,id,remainder+1,'OVER','2026-05-05'),/överstiger/);
 s=checked(pay(s,id,remainder,'FINAL','2026-05-05'));ledger(s,o,c);assert.equal(getInvoiceOutstanding(doc(s,id)),0);originalPreserved(s,old);
});

// 021–040: paid invoices with mixed-rate row credits, split repayments and retry.
for(let seed=0;seed<20;seed++)audit('paid mixed invoice, row credits, two refunds and duplicate rejection',seed,()=>{
 const p=portfolio(seed),o=oracle(p);let{state:s,id}=issue(p);const old=structuredClone(s.entries),lines=selection(o,3,7),c=creditOracle(o,lines),g=c.net+c.vat;
 s=pay(s,id,o.gross);s=credit(s,id,lines);assert.equal(getDocumentSettlementSummary('customer',doc(s,id)).refundableCents,g);
 const a=Math.floor(g/3);s=refundCredit(s,{side:'customer',documentId:id,date:'2026-05-05',amountCents:a,reference:'RETURN-A'});
 rejects(s,()=>refundCredit(s,{side:'customer',documentId:id,date:'2026-05-05',amountCents:a,reference:'RETURN-A'}),/redan bokförd/);
 s=checked(refundCredit(s,{side:'customer',documentId:id,date:'2026-05-06',amountCents:g-a,reference:'RETURN-B'}));ledger(s,o,c);originalPreserved(s,old);
});

// 041–060: all three discounted tax bases reverse exactly without a fake receipt.
for(let seed=0;seed<20;seed++)audit('full three-line unpaid return with exact cumulative VAT',seed,()=>{
 const p=portfolio(seed),o=oracle(p);let{state:s,id}=issue(p);const old=structuredClone(s.entries),snapshot=doc(s,id).bookingSnapshot;
 const first=selection(o,1,3),c1=creditOracle(o,first);s=credit(s,id,first,'PART-A');
 const second=o.rows.map((r,index)=>({index,netCents:r.net-first[index].netCents}));s=checked(credit(s,id,second,'PART-B'));
 for(const account of ['1510','1930','3000','2611','2621','2631'])assert.equal(accountBalance(s,account),0,account);
 assert.ok(c1.net>0);assert.equal(doc(s,id).bookingSnapshot,snapshot);rejects(s,()=>pay(s,id,1,'EXTRA','2026-05-05'),/överstiger/);originalPreserved(s,old);
});

// 061–080: offset a returned purchase against a separate larger contract.
for(let seed=0;seed<20;seed++)audit('full paid return offsets a larger replacement invoice',seed,()=>{
 const p=portfolio(seed),o=oracle(p);let{state:s,id}=issue(p);s=pay(s,id,o.gross);s=credit(s,id,o.rows.map((r,index)=>({index,netCents:r.net})));const old=structuredClone(s.entries);
 const nextP={...p,rows:p.rows.map(r=>({...r,unitCents:r.unitCents*2+17}))},nextO=oracle(nextP),next=issue(nextP,{state:s});s=next.state;
 s=offsetCredit(s,{side:'customer',documentId:id,targetDocumentId:next.id,date:'2026-05-05',amountCents:o.gross,reference:'REPLACEMENT-OFFSET'});
 assert.equal(accountBalance(s,'1930'),o.gross);s=checked(pay(s,next.id,nextO.gross-o.gross,'REPLACEMENT-REST','2026-05-06'));ledger(s,nextO);originalPreserved(s,old);
 assert.equal(getDocumentSettlementSummary('customer',doc(s,id)).refundableCents,0);
});

// 081–100: an otherwise identical second counterparty cannot consume credit.
for(let seed=0;seed<20;seed++)audit('customer separation after paid row credit and rejected offset',seed,()=>{
 const p=portfolio(seed),o=oracle(p);let{state:s,id}=issue(p);s=pay(s,id,o.gross);const lines=selection(o,1,4),c=creditOracle(o,lines),g=c.net+c.vat;s=credit(s,id,lines);
 s=createCustomer(s,{name:'Separat fiktiv kund B'});const next=issue(p,{state:s,customerId:s.customers.at(-1).id});s=next.state;const before=structuredClone(s.entries);
 rejects(s,()=>offsetCredit(s,{side:'customer',documentId:id,targetDocumentId:next.id,date:'2026-05-05',amountCents:g,reference:'CROSS-CUSTOMER'}),/samma kund/);
 s=refundCredit(s,{side:'customer',documentId:id,date:'2026-05-05',amountCents:g,reference:'VALID-RETURN'});s=checked(pay(s,next.id,o.gross,'SECOND-CUSTOMER','2026-05-06'));
 const doubled={net:o.net*2,vat:o.vat*2,gross:o.gross*2,rows:[...o.rows,...o.rows]};ledger(s,doubled,c);originalPreserved(s,before);
});

// 101–120: copying and repricing is a new sale; cancelling the first leaves only it.
for(let seed=0;seed<20;seed++)audit('copied contract repriced and confirmed separately from returned original',seed,()=>{
 const p=portfolio(seed),o=oracle(p);let{state:s,id}=issue(p);const snapshot=doc(s,id).bookingSnapshot,old=structuredClone(s.entries);
 s=copyInvoice(s,id,{date:'2026-05-02',dueDate:'2026-06-01'});const copied=s.invoices.at(-1).id,nextP={...p,rows:p.rows.map(r=>({...r,unitCents:r.unitCents+203+seed}))},nextO=oracle(nextP);
 rejects(s,()=>issueInvoice(s,copied),/Bekräfta/);s=updateInvoiceDraft(s,copied,{lines:nextP.rows,details:{...doc(s,copied).details,performance:{mode:'invoice-date',confirmed:true}}});s=issueInvoice(s,copied);
 s=credit(s,id,o.rows.map((r,index)=>({index,netCents:r.net})));s=checked(pay(s,copied,nextO.gross,'NEW-CONTRACT','2026-05-05'));
 ledger(s,nextO);assert.equal(doc(s,id).bookingSnapshot,snapshot);assert.notEqual(doc(s,id).number,doc(s,copied).number);originalPreserved(s,old);
});

// 121–140: a partial return adjusts the already earned share and all future months.
for(let seed=0;seed<20;seed++)audit('paid deferred revenue, first recognition, row credit and remaining months',seed,()=>{
 const p=portfolio(seed),o=oracle(p),months=2+seed%4;let{state:s,id}=issue(p);
 s=createRevenueSchedule(s,{invoiceId:id,date:'2026-05-01',startMonth:'2026-05',months,amountCents:o.net,name:'Fiktivt periodavtal'});const planId=s.revenueSchedules.at(-1).id;
 s=recognizeRevenueMonth(s,planId,{date:'2026-05-02'});s=pay(s,id,o.gross,'PAID','2026-05-03');const old=structuredClone(s.entries),lines=selection(o,2,7),c=creditOracle(o,lines),remaining=o.net-c.net;
 s=credit(s,id,lines,'DEFERRED-RETURN',{specialReviewed:true});const earned=fraction(remaining,1,months);
 assert.equal(accountBalance(s,'3000'),-earned);assert.equal(accountBalance(s,'2990'),-(remaining-earned));
 s=refundCredit(s,{side:'customer',documentId:id,date:'2026-05-05',amountCents:c.net+c.vat,reference:'DEFERRED-REFUND'});
 for(let step=1;step<months;step++)s=recognizeRevenueMonth(s,planId,{date:`2026-${String(5+step).padStart(2,'0')}-15`});
 s=checked(s);ledger(s,o,c);assert.equal(accountBalance(s,'2990'),0);assert.equal(s.revenueSchedules.at(-1).status,'completed');originalPreserved(s,old);
});

// 141–160: excluded labor and invoice fees never enlarge one-person ROT base.
for(let seed=0;seed<20;seed++)audit('ROT partial approval splits payer limits while excluding labor and fees',seed,()=>{
 const p=portfolio(seed,{rot:true}),o=oracle(p),available=[2000,10000,5000000][seed%3];
 const rot=Math.floor(Math.min(Math.floor(o.rows[0].gross*30/100),5000000,available)/100)*100;
 let{state:s,id}=issue(p,{rot:{personId:`FIKTIV-${seed}`,property:`DEMO ${seed+1}:1`,paymentYear:2026,availableCents:available,eligibleConfirmed:true}});const old=structuredClone(s.entries);
 assert.deepEqual(getInvoiceTotals(doc(s,id)),{netCents:o.net,vatCents:o.vat,grossCents:o.gross,rotCents:rot,customerCents:o.gross-rot});
 const customer=o.gross-rot,a=Math.floor(customer/2);s=pay(s,id,a,'CUSTOMER-A');s=pay(s,id,customer-a,'CUSTOMER-B');
 s=requestRot(s,id,{date:'2026-05-03',workCompletedConfirmed:true,electronicPaymentConfirmed:true});assert.equal(s.rotClaims.at(-1).requestedCents,rot);
 const approved=seed%3===0?rot:seed%3===1?Math.floor(rot/200)*100:0;s=decideRot(s,id,{date:'2026-05-04',approvedCents:approved,reason:'Fiktivt granskat beslut'});
 rejects(s,()=>pay(s,id,approved+1,'TAX-EXCESS','2026-05-05',{payer:'tax'}),approved?/överstiger/:/godkänt/);
 if(approved)s=pay(s,id,approved,'TAX-OK','2026-05-05',{payer:'tax'});
 if(rot>approved)s=pay(s,id,rot-approved,'CUSTOMER-REST','2026-05-06');
 s=checked(s);ledger(s,o);originalPreserved(s,old);assert.equal(getInvoiceOutstanding(doc(s,id)),0);
});

// 161–180: matched imported bank rows are consumed once, even through failed retries.
for(let seed=0;seed<20;seed++)audit('two external bank receipts, amount mismatch and consumed-event retry',seed,()=>{
 const p=portfolio(seed),o=oracle(p);let{state:s,id}=issue(p);const old=structuredClone(s.entries),a=Math.floor(o.gross/3),b=o.gross-a;
 s.bankTransactions.push({id:'IMPORT-A',date:'2026-05-03',account:'1930',description:'Fiktiv bankimport A',amountCents:a,matchedEntryId:null},{id:'IMPORT-B',date:'2026-05-03',account:'1930',description:'Fiktiv bankimport B',amountCents:b,matchedEntryId:null});
 rejects(s,()=>pay(s,id,a+1,'WRONG','2026-05-03',{bankEventId:'IMPORT-A'}),/motsvara/);
 s=pay(s,id,a,'RIGHT-A','2026-05-03',{bankEventId:'IMPORT-A'});
 rejects(s,()=>pay(s,id,b,'USED','2026-05-03',{bankEventId:'IMPORT-A'}),/redan matchad/);
 s=checked(pay(s,id,b,'RIGHT-B','2026-05-03',{bankEventId:'IMPORT-B'}));ledger(s,o);assert.equal(s.bankTransactions.length,2);assert.ok(s.bankTransactions.every(r=>r.matchedEntryId));originalPreserved(s,old);
});

// 181–200: reverse-charge sales retain their separate revenue base through credit.
for(let seed=0;seed<20;seed++)audit('reverse construction sale, discounted row credit and final customer payment',seed,()=>{
 const p=portfolio(seed,{reverse:true}),o=oracle(p,true);let{state:s,id}=issue(p,{reverse:true});const old=structuredClone(s.entries),lines=selection(o,3,8),c=creditOracle(o,lines);
 const first=Math.floor((o.gross-c.net)/2);s=pay(s,id,first);s=credit(s,id,lines);s=checked(pay(s,id,o.gross-c.net-first,'REVERSE-FINAL','2026-05-05'));
 ledger(s,o,c,{reverse:true});assert.equal(accountBalance(s,'3000'),0);assert.equal(accountBalance(s,'2611'),0);assert.equal(getInvoiceOutstanding(doc(s,id)),0);originalPreserved(s,old);
});
if(serial!==200)throw new Error(`Expected 200 new scenarios, registered ${serial}`);
