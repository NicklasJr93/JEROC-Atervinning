import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, accountBalance } from '../public/bokforing/suite/core.js';
import { createBill, bookBill, payBill } from '../public/bokforing/suite/operations.js';
import { createCreditNote, refundCredit } from '../public/bokforing/suite/settlements.js';
import { createCashState, createCashDocument, issueCashDocument, payCashDocument, creditCashDocument, refundCashDocument, getCashDocumentSummary } from '../public/bokforing/suite/cash-method.js';
import { createFxDocument, issueFxDocument, settleFxDocument, creditFxDocument, revalueFxDocument, getFxPosition } from '../public/bokforing/suite/fx.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { getTaxDeclarationReport } from '../public/bokforing/suite/tax-ledger.js';

// Audit 3 matrix: independent whole-ore facit, different tax/deduction paths,
// payment partitions, currency directions and valuation-to-credit chains.
// Fixed matrices are reproducible; test IDs remain stable. No production
// amount/allocation function is called to derive expected numbers.
const halfUp=(amount,n,d=100)=>Number((BigInt(amount)*BigInt(n)*2n+BigInt(d))/(2n*BigInt(d)));
const sum=xs=>xs.reduce((a,b)=>a+b,0);
const bal=(s,a)=>accountBalance(s,a);
const restored=s=>{const copy=JSON.parse(JSON.stringify(s));validateSuiteState(copy);return copy;};
const unchangedFailure=(s,run)=>{const original=JSON.stringify(s);assert.throws(run);assert.equal(JSON.stringify(s),original);};
const partition=(total,mode)=>{
 if(mode===0)return[total];
 if(mode===1)return[1,total-1];
 if(mode===2){const first=Math.floor(total/3);return[first,total-first];}
 if(mode===3){const first=Math.floor(total/4),second=Math.floor(total/3);return[first,second,total-first-second];}
 const first=Math.floor(total/5),second=Math.floor(total/7),third=Math.floor(total/3);return[first,second,third,total-first-second-third];
};
let serial=0;
const check=(title,run)=>test(`AUDIT3-PURFX-${String(++serial).padStart(3,'0')} ${title}`,run);

const modes=[{mode:'standard',rate:25},{mode:'standard',rate:12},{mode:'standard',rate:6},{mode:'reverse-construction',rate:25}];
for(const [modeIndex,setting] of modes.entries())for(const [deductIndex,deductible] of [0,2500,5000,7500,10000].entries())for(let variant=0;variant<4;variant++){
 check(`mixed supplier ${setting.mode}/${setting.rate} deduction ${deductible} payment split ${variant}`,()=>{
  const primaryNet=[101,997,10003,37429][variant]+deductIndex*17;
  const secondaryNet=313+modeIndex*83+variant*37,secondaryRate=[6,25,12,6][modeIndex],secondaryDeductible=10000-deductible,taxFreeNet=149+variant*11;
  const primaryVat=halfUp(primaryNet,setting.rate),secondaryVat=halfUp(secondaryNet,secondaryRate);
  const primaryInput=halfUp(primaryVat,deductible,10000),secondaryInput=halfUp(secondaryVat,secondaryDeductible,10000);
  const primaryPayable=primaryNet+(setting.mode==='standard'?primaryVat:0),secondaryPayable=secondaryNet+secondaryVat,total=primaryPayable+secondaryPayable+taxFreeNet;
  const primaryAccount=setting.mode==='standard'?'4010':'4425';
  let s=createBill(createEmptyState(),{supplier:'Fiktiv matriskund AB',number:'SUPPLIER-MATRIX',date:'2026-10-01',dueDate:'2026-10-31',lines:[
   {description:'Primärrad',account:primaryAccount,netCents:primaryNet,vatMode:setting.mode,vatRate:setting.rate,deductibleBps:deductible,...(setting.mode==='reverse-construction'?{reverseConfirmed:true}:{})},
   {description:'Sekundärrad',account:'6540',netCents:secondaryNet,vatMode:'standard',vatRate:secondaryRate,deductibleBps:secondaryDeductible},
   {description:'Momsfri inköpsrad',account:'5010',netCents:taxFreeNet,vatMode:'no-vat',vatRate:0,deductibleBps:0},
  ]});
  const id=s.bills[0].id;s=bookBill(s,id);const original=structuredClone(s.entries[0]),snapshot=s.bills[0].bookingSnapshot;
  assert.equal(bal(s,'2440'),-total);assert.equal(bal(s,primaryAccount),primaryNet+primaryVat-primaryInput);
  assert.equal(bal(s,'6540'),secondaryNet+secondaryVat-secondaryInput);
  assert.equal(bal(s,'2641'),secondaryInput+(setting.mode==='standard'?primaryInput:0));
  assert.equal(bal(s,'2647'),setting.mode==='reverse-construction'?primaryInput:0);assert.equal(bal(s,'2614'),setting.mode==='reverse-construction'?-primaryVat:0);
  for(const [i,amount] of partition(total,variant+1).entries())s=payBill(s,id,{date:'2026-10-02',amountCents:amount,reference:`PAY-${i}`});
  s=restored(s);assert.equal(bal(s,'2440'),0);assert.equal(bal(s,'1930'),-total);
  s=createCreditNote(s,{side:'supplier',documentId:id,date:'2026-10-03',reason:'Primärraden återgår',reference:'ROW-RETURN',lines:[{index:0,netCents:primaryNet}]});
  assert.equal(bal(s,'2440'),primaryPayable);assert.equal(bal(s,primaryAccount),0);assert.equal(bal(s,'2647'),0);assert.equal(bal(s,'2614'),0);
  for(const [i,amount] of partition(primaryPayable,4-variant).entries())s=refundCredit(s,{side:'supplier',documentId:id,date:'2026-10-04',amountCents:amount,reference:`REFUND-${i}`});
  s=restored(s);assert.equal(bal(s,'2440'),0);assert.equal(bal(s,'1930'),-secondaryPayable-taxFreeNet);assert.equal(bal(s,'2641'),secondaryInput);
  assert.equal(bal(s,'6540'),secondaryNet+secondaryVat-secondaryInput);assert.equal(bal(s,'5010'),taxFreeNet);
  assert.deepEqual(s.entries[0],original);assert.equal(s.bills[0].bookingSnapshot,snapshot);
  unchangedFailure(s,()=>refundCredit(s,{side:'supplier',documentId:id,date:'2026-10-05',amountCents:1,reference:'OVER-REFUND'}));
 });
}

// Frozen two-row 20% credit allocations, independently calculated in whole öre.
const cashPreCreditShares=[[201,103],[216,107],[230,112],[246,116],[261,120],[218,115],[234,120],[250,125],[266,130],[282,134],[251,98],[268,102],[286,106],[304,110],[322,114]];
for(const side of ['customer','supplier'])for(const [rateIndex,vatRate] of [6,12,25].entries())for(let split=0;split<5;split++)for(const beforePayment of [false,true]){
 check(`cash ${side} ${vatRate}% split ${split} ${beforePayment?'credit before payment':'credit after payment'}`,()=>{
  const primaryNet=947+split*71+rateIndex*29,secondaryNet=461+split*19,secondRate=[12,25,6][rateIndex],deductible=side==='supplier'?[0,2500,5000,7500,10000][split]:10000;
  const primaryVat=halfUp(primaryNet,vatRate),secondaryVat=halfUp(secondaryNet,secondRate),primaryInput=halfUp(primaryVat,deductible,10000),gross=primaryNet+primaryVat+secondaryNet+secondaryVat;
  let s=createCashState({eligibilityConfirmed:true,expectedTurnoverCents:1000000,vatPeriod:'month'});
  s=createCashDocument(s,{side,partyName:'Fiktiv kassaflödeskund',partyAddress:'Provvägen 2',partyPostalCode:'12345',partyCity:'Demostaden',partyCountry:'SE',performance:{mode:'invoice-date',confirmed:true},date:'2026-10-01',dueDate:'2026-10-31',reference:'CASH-MATRIX',supplyConfirmed:true,lines:[
   {description:'Primär rad',account:'4010',netCents:primaryNet,vatRate,deductibleBps:deductible},
   {description:'Sekundär rad',account:'6540',netCents:secondaryNet,vatRate:secondRate,deductibleBps:10000},
  ]});
  const id=s.cashDocuments[0].id;s=issueCashDocument(s,id);const snapshot=s.cashDocuments[0].snapshot;assert.equal(s.entries.length,0);
  const earlierCredit=beforePayment?Math.floor(gross/5):0;
  if(earlierCredit)s=creditCashDocument(s,id,{date:'2026-10-02',amountCents:earlierCredit,reference:'PRE-CREDIT',reason:'Avtalad minskning före betalning'});
  const paid=gross-earlierCredit;
  for(const [i,amount] of partition(paid,split).entries())s=payCashDocument(s,id,{date:i===0?'2026-10-31':'2026-11-01',amountCents:amount,reference:`PAY-${i}`});
  s=restored(s);assert.equal(getCashDocumentSummary(s,id).outstandingCents,0);assert.equal(bal(s,'1930'),(side==='customer'?1:-1)*paid);
  const creditShares=beforePayment?cashPreCreditShares[rateIndex*5+split]:[0,0];
  assert.equal(sum(creditShares),earlierCredit);
  const effectiveGross=[primaryNet+primaryVat-creditShares[0],secondaryNet+secondaryVat-creditShares[1]];
  if(side==='customer'){
   const effectiveVat=[halfUp(effectiveGross[0],primaryVat,primaryNet+primaryVat),halfUp(effectiveGross[1],secondaryVat,secondaryNet+secondaryVat)];
   assert.equal(bal(s,'3000'),-sum(effectiveGross)+sum(effectiveVat));
   assert.equal(sum(['2611','2621','2631'].map(a=>bal(s,a))),-sum(effectiveVat));
  }else{
   const effectiveInput=[halfUp(effectiveGross[0],primaryInput,primaryNet+primaryVat),halfUp(effectiveGross[1],secondaryVat,secondaryNet+secondaryVat)];
   assert.equal(bal(s,'4010'),effectiveGross[0]-effectiveInput[0]);assert.equal(bal(s,'6540'),effectiveGross[1]-effectiveInput[1]);assert.equal(bal(s,'2641'),sum(effectiveInput));
  }
  const october=structuredClone(getTaxDeclarationReport(s,{from:'2026-10-01',to:'2026-10-31'}).boxes);
  s=creditCashDocument(s,id,{date:'2026-11-02',amountCents:paid,reference:'POST-CREDIT',reason:'Hela återstående köpet återgår'});
  assert.equal(getCashDocumentSummary(s,id).refundableCents,paid);
  for(const [i,amount] of partition(paid,4-split).entries())s=refundCashDocument(s,id,{date:i===0?'2026-11-30':'2026-12-01',amountCents:amount,reference:`REFUND-${i}`});
  s=restored(s);for(const account of ['1930','1510','2440','2490','1680','3000','4010','6540','2641','2611','2621','2631'])assert.equal(bal(s,account),0,account);
  assert.equal(getCashDocumentSummary(s,id).refundableCents,0);assert.equal(s.cashDocuments[0].snapshot,snapshot);
  assert.deepEqual(getTaxDeclarationReport(s,{from:'2026-10-01',to:'2026-10-31'}).boxes,october);
  unchangedFailure(s,()=>refundCashDocument(s,id,{date:'2026-12-02',amountCents:1,reference:'EXCESS'}));
 });
}

const rates=['0.87654321','1.23456789','10.01234567','11.33333333','13.98765432'];
const rational=value=>{const parts=value.split('.'),scale=10**(parts[1]?.length??0);return{n:Number(parts.join('')),d:scale};};
for(const side of ['customer','supplier'])for(const currency of ['EUR','USD'])for(const [vatIndex,vatRate] of [6,12,25].entries())for(const [rateIndex,rate] of rates.entries()){
 check(`FX ${side} ${currency} ${vatRate}% rate ${rate} ${rateIndex>=3?'revaluation before full credit':'paid full credit'}`,()=>{
  const inputRate=rational(rate),creditRate=String(Number(rate)+0.125),nextRate=rational(creditRate),rows=[{foreignNetMinor:1207+vatIndex*211,vatRate},{foreignNetMinor:997+rateIndex*79,vatRate:[12,25,6][vatIndex]}];
  const expectedNet=sum(rows.map(row=>halfUp(row.foreignNetMinor,inputRate.n,inputRate.d))),expectedVat=sum(rows.map(row=>halfUp(halfUp(row.foreignNetMinor,row.vatRate),inputRate.n,inputRate.d)));
  const foreignGross=sum(rows.map(row=>row.foreignNetMinor+halfUp(row.foreignNetMinor,row.vatRate))),gross=expectedNet+expectedVat,sign=side==='customer'?1:-1;
  let s=createFxDocument(createEmptyState(),{side,currency,number:'FX-MATRIX',date:'2026-10-01',dueDate:'2026-10-31',partyName:'Fiktiv valutapart',partyAddress:'Provvägen 1',partyPostalCode:'12345',partyCity:'Demostaden',partyCountry:'SE',sellerName:'Fiktivt testbolag AB',sellerAddress:'Provvägen 3',sellerOrgNumber:'5599999991',sellerVatNumber:'SE559999999101',sellerPostalCode:'12345',sellerCity:'Demostaden',sellerCountry:'SE',performance:{mode:'invoice-date',confirmed:true},paymentReference:'FX',taxTreatment:'domestic',taxReviewed:true,rate,rateSource:'Fiktiv fast matrisnotering',lines:rows.map((r,i)=>({...r,description:`Rad ${i}`,account:side==='supplier'?'4010':'3000'}))});
  const id=s.fxDocuments[0].id;s=issueFxDocument(s,id);const original=structuredClone(s.fxDocuments[0]),entry=structuredClone(s.entries[0]),control=side==='customer'?'1510':'2440';
  assert.equal(bal(s,control),sign*gross);assert.equal(bal(s,side==='customer'?'3000':'4010'),-sign*expectedNet);
  const partial=rateIndex>=3,paidForeign=partial?Math.floor(foreignGross*2/5):foreignGross,paidGross=partial?halfUp(gross,paidForeign,foreignGross)+17:gross+17,payFee=3;
  const pieces=partial?[paidForeign]:partition(paidForeign,2);let allocated=0,cumulative=0;
  for(const [i,amount]of pieces.entries()){cumulative+=amount;const target=halfUp(paidGross,cumulative,paidForeign);s=settleFxDocument(s,id,{date:'2026-10-02',foreignMinor:amount,bankCents:target-allocated,feeCents:i===0?payFee:0,reference:`PAY-${i}`});allocated=target;}
  const expectedCarry=gross-halfUp(gross,paidForeign,foreignGross);assert.equal(getFxPosition(s,id).carryingCents,expectedCarry);
  const expectedPaymentFx=side==='customer'?halfUp(gross,paidForeign,foreignGross)-paidGross-payFee:paidGross-payFee-halfUp(gross,paidForeign,foreignGross);
  assert.equal(bal(s,'3960')+bal(s,'7960'),expectedPaymentFx);
  const correctionDate=partial?'2026-12-31':'2026-10-03';
  if(partial){s=revalueFxDocument(s,id,{date:correctionDate,rate:creditRate,rateSource:'Fiktiv balansdagsnotering',reference:'YEAR-END',reviewed:true});assert.equal(getFxPosition(s,id).carryingCents,halfUp(foreignGross-paidForeign,nextRate.n,nextRate.d));}
  s=creditFxDocument(s,id,{date:correctionDate,reason:'Hela avtalet hävs efter betalning',reference:'CREDIT',rate:creditRate,rateSource:'Fiktiv kreditdagsnotering',rateReviewed:true,lines:rows.map((r,index)=>({index,foreignNetMinor:r.foreignNetMinor}))});
  assert.equal(getFxPosition(s,id).foreignBalanceMinor,-paidForeign);assert.equal(getFxPosition(s,id).carryingCents,-halfUp(paidForeign,nextRate.n,nextRate.d));
  const refunded=halfUp(paidForeign,nextRate.n,nextRate.d)+23,refundFee=2;
  s=settleFxDocument(s,id,{date:correctionDate,foreignMinor:paidForeign,bankCents:refunded,feeCents:refundFee,reference:'REFUND',refund:true});
  s=restored(s);assert.equal(getFxPosition(s,id).foreignBalanceMinor,0);assert.equal(getFxPosition(s,id).carryingCents,0);
  for(const account of ['1510','2440','3000','4010','2641','2611','2621','2631'])assert.equal(bal(s,account),0,account);
  assert.equal(bal(s,'1930'),sign*(paidGross-refunded));assert.equal(bal(s,'6570'),payFee+refundFee);assert.equal(bal(s,'3960')+bal(s,'7960'),-sign*(paidGross-refunded)-payFee-refundFee);
  assert.equal(JSON.stringify(s.fxDocuments[0]),JSON.stringify(original));assert.deepEqual(s.entries[0],entry);
  unchangedFailure(s,()=>settleFxDocument(s,id,{date:correctionDate,foreignMinor:1,bankCents:1,feeCents:0,reference:'EXCESS',refund:true}));
 });
}
assert.equal(serial,200,'The audit matrix must contain exactly 200 independently named cases.');
