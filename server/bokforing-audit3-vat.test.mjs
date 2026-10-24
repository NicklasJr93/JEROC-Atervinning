import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from './fixtures/bokforing-compliant-invoices.mjs';
import { accountBalance } from '../public/bokforing/suite/core.js';
import { postTaxTransaction, reverseTaxTransaction, getTaxDeclarationReport } from '../public/bokforing/suite/tax-ledger.js';
import { fileVatPeriod } from '../public/bokforing/suite/finance.js';
import { createDeclaration, getDeclarationFile } from '../public/bokforing/suite/declarations.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

// AUDIT3: 20 six-source portfolios, exercised through ten different histories.
// Expected balances derive from the transaction's tax category and integer-öre
// arithmetic below, never calculateTaxTransaction/getTaxDeclarationReport.
const amounts=[1,2,3,7,11,29,101,333,999,1001,9999,10001,100003,123457,999999,1000001,7654321,12345678,99999999,123456789];
const deductions=[0,1,17,3333,5000,6667,9999,10000];
const rates=[6,12,25];
const reverseKinds=['domestic-reverse-goods-purchase','domestic-reverse-service-purchase','eu-goods-purchase','eu-service-purchase','non-eu-service-purchase'];
const foreignKinds=['eu-goods-sale','eu-service-sale','export-sale','non-eu-service-sale'];
const q2={from:'2026-04-01',to:'2026-06-30',date:'2026-06-30'};
const q3={from:'2026-07-01',to:'2026-09-30'};
const codes=['05','06','07','08','10','11','12','20','21','22','23','24','30','31','32','35','36','37','38','39','40','41','42','48','49','50','60','61','62'];
const xmlTags={'05':'ForsMomsEjAnnan','10':'MomsUtgHog','11':'MomsUtgMedel','12':'MomsUtgLag','20':'InkopVaruAnnatEg','21':'InkopTjanstAnnatEg','22':'InkopTjanstUtomEg','23':'InkopVaruSverige','24':'InkopTjanstSverige','30':'MomsInkopUtgHog','31':'MomsInkopUtgMedel','32':'MomsInkopUtgLag','35':'ForsVaruAnnatEg','36':'ForsVaruUtomEg','39':'ForsTjSkskAnnatEg','40':'ForsTjOvrUtomEg','42':'ForsOvrigt','48':'MomsIngAvdr','49':'MomsBetala','50':'MomsUlagImport','60':'MomsImportUtgHog','61':'MomsImportUtgMedel','62':'MomsImportUtgLag'};
function assertXmlKronor(xml,expectedBoxes){
 const kr=Object.fromEntries(Object.entries(expectedBoxes).map(([k,v])=>[k,Math.trunc(v/100)]));
 kr['49']=['10','11','12','30','31','32','60','61','62'].reduce((sum,k)=>sum+kr[k],0)-kr['48'];
 for(const [box,tag]of Object.entries(xmlTags)){
  const match=xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  if(kr[box]!==0||box==='49'){assert.ok(match,tag);assert.equal(match[1],String(kr[box]),tag);}
  else assert.equal(match,null,`${tag} must omit zero kronor`);
 }
}
const accounts=['1930','3000','4010','5460','2611','2621','2631','2614','2624','2634','2615','2625','2635','2641','2645'];
const halfUp=(n,p,d)=>Number((BigInt(n)*BigInt(p)*2n+BigInt(d))/(2n*BigInt(d)));
const emptyBoxes=()=>Object.fromEntries(codes.map(c=>[c,0]));
const emptyBalances=()=>Object.fromEntries(accounts.map(c=>[c,0]));
const exemption={code:'property-rental',legalBasis:'Fiktiv lokalupplåtelse enligt 10 kap. ML utan frivillig beskattning.',confirmed:true};
function specs(i){
 const n=amounts[i],rate=rates[i%3],rRate=rates[(i+1)%3],mRate=rates[(i+2)%3],ded=deductions[i%deductions.length];
 const raw=[
  {kind:'domestic-sale',country:'SE',netCents:n,vatRate:rate},
  {kind:'domestic-sale',country:'SE',netCents:n+17,vatRate:0,vatExemption:{...exemption}},
  {kind:'domestic-purchase',country:'SE',netCents:2*n+1,vatRate:rRate,deductibleBps:ded,account:'5460'},
  {kind:reverseKinds[i%5],country:i%5<2?'SE':i%5<4?'DE':'US',netCents:3*n+2,vatRate:mRate,deductibleBps:deductions[(i+3)%8]},
  {kind:'import-vat',country:'US',netCents:4*n+100,vatRate:rate,deductibleBps:deductions[(i+5)%8]},
  {kind:foreignKinds[i%4],country:i%4<2?'DE':'US',vatNumber:i%4<2?'DE123456789':'',netCents:5*n+4},
 ];
 return raw.map((r,j)=>({...r,date:`2026-06-${String(j+10).padStart(2,'0')}`,reference:`PORTFOLIO-${i}-SOURCE-${j}`,counterparty:`Fiktiv motpart ${j}`,conditionsConfirmed:true}));
}
function oracle(list){
 const b=emptyBoxes(),a=emptyBalances();
 const add=(key,value)=>{b[key]+=value;};const balance=(key,value)=>{a[key]+=value;};
 for(const s of list){
  const n=s.netCents,rate=s.vatRate??0,vat=halfUp(n,rate,100),ded=halfUp(vat,s.deductibleBps??10000,10000),excluded=vat-ded;
  if(s.kind==='domestic-sale'){
   add(rate?'05':'42',n);balance('1930',n+vat);balance('3000',-n);
   if(rate){add({6:'12',12:'11',25:'10'}[rate],vat);balance({6:'2631',12:'2621',25:'2611'}[rate],-vat);}
  }else if(s.kind==='domestic-purchase'){
   balance(s.account??'4010',n+excluded);balance('1930',-(n+vat));balance('2641',ded);add('48',ded);
  }else if(s.kind==='import-vat'||reverseKinds.includes(s.kind)){
   const imported=s.kind==='import-vat';
   add(imported?'50':{'domestic-reverse-goods-purchase':'23','domestic-reverse-service-purchase':'24','eu-goods-purchase':'20','eu-service-purchase':'21','non-eu-service-purchase':'22'}[s.kind],n);
   add(imported?{6:'62',12:'61',25:'60'}[rate]:{6:'32',12:'31',25:'30'}[rate],vat);add('48',ded);
   balance(s.account??'4010',(imported?0:n)+excluded);if(!imported)balance('1930',-n);
   balance('2645',ded);balance(imported?{6:'2635',12:'2625',25:'2615'}[rate]:{6:'2634',12:'2624',25:'2614'}[rate],-vat);
  }else{
   add({'eu-goods-sale':'35','eu-service-sale':'39','export-sale':'36','non-eu-service-sale':'40'}[s.kind],n);balance('1930',n);balance('3000',-n);
  }
 }
 b['49']=['10','11','12','30','31','32','60','61','62'].reduce((sum,k)=>sum+b[k],0)-b['48'];
 return {boxes:b,balances:a};
}
function portfolio(i,order=[0,1,2,3,4,5]){const source=specs(i);let state=createEmptyState();for(const j of order)state=postTaxTransaction(state,source[j]);return{state,source};}
function report(state,range=q2){return getTaxDeclarationReport(state,range);}
function verify(state){validateSuiteState(state);const restored=JSON.parse(JSON.stringify(state));validateSuiteState(restored);return restored;}
function equalReport(state,source,range=q2){const actual=report(state,range),expected=oracle(source);assert.deepEqual(actual.boxes,expected.boxes);assert.deepEqual(actual.warnings,[]);assert.equal(actual.reconciled,true);return expected;}
function equalBalances(state,expected){for(const account of accounts)assert.equal(accountBalance(state,account),expected[account],account);}
function atomic(state,run,pattern){const before=JSON.stringify(state);assert.throws(run,pattern);assert.equal(JSON.stringify(state),before);}
function declare(state){return createDeclaration(state,{kind:'vat',from:q2.from,to:q2.to,orgNumber:state.company.orgNumber,reviewed:true,createdAt:'2026-07-01T10:00:00Z'});}
let count=0;
function scenario(i,family,run){const id=`AUDIT3-VAT-${String(++count).padStart(3,'0')}`;test(`${id} ${family}; portfolio=${i+1} net=${amounts[i]} rate=${rates[i%3]} deduction=${deductions[i%8]}`,run);}
for(let i=0;i<20;i++){
 scenario(i,'six supported source types agree with independent VAT and ledger totals',()=>{
  const {state,source}=portfolio(i);const expected=equalReport(state,source);equalBalances(state,expected.balances);verify(state);
 });
 scenario(i,'reversed insertion order preserves declaration and ledger totals',()=>{
  const normal=portfolio(i),reverse=portfolio(i,[5,4,3,2,1,0]);
  const expected=equalReport(reverse.state,normal.source);assert.deepEqual(report(reverse.state).boxes,report(normal.state).boxes);equalBalances(reverse.state,expected.balances);verify(reverse.state);
 });
 scenario(i,'all six same-quarter reversals cancel bases and every ledger account',()=>{
  let{state,source}=portfolio(i);const originals=JSON.stringify(state.taxTransactions),ids=state.taxTransactions.map(t=>t.id);
  for(const id of ids)state=reverseTaxTransaction(state,id,{date:'2026-06-25',reason:'Hela den fiktiva portföljen återgår'});
  assert.deepEqual(report(state).boxes,emptyBoxes());equalBalances(state,emptyBalances());assert.equal(JSON.stringify(state.taxTransactions.slice(0,6)),originals);assert.equal(source.length,6);verify(state);
 });
 scenario(i,'selective reversals retain only the three remaining sources',()=>{
  let{state,source}=portfolio(i);const ids=state.taxTransactions.map(t=>t.id),original=JSON.stringify(state.taxTransactions);
  for(const j of [0,2,4])state=reverseTaxTransaction(state,ids[j],{date:'2026-06-25',reason:'Tre oberoende affärer rättas'});
  const expected=equalReport(state,source.filter((_,j)=>j%2===1));equalBalances(state,expected.balances);assert.equal(JSON.stringify(state.taxTransactions.slice(0,6)),original);verify(state);
 });
 scenario(i,'filed quarter rejects each remaining VAT-relevant reversal atomically',()=>{
  const initial=portfolio(i);const state=fileVatPeriod(initial.state,q2);const before=report(state).boxes;
  for(const j of [0,1,3,4,5])atomic(state,()=>reverseTaxTransaction(state,state.taxTransactions[j].id,{date:'2026-06-25',reason:'Otillåten ändring av fastställt underlag'}),/fastställd/);
  assert.deepEqual(report(state).boxes,before);verify(state);
 });
 scenario(i,'next-quarter full reversal preserves filed source bases and signs',()=>{
  let{state,source}=portfolio(i);state=fileVatPeriod(state,q2);const record=JSON.stringify(state.vatReturns[0]),expected=oracle(source).boxes,ids=state.taxTransactions.map(t=>t.id);
  for(const id of ids)state=reverseTaxTransaction(state,id,{date:'2026-07-05',reason:'Rättelse i nästa öppna period'});
  assert.deepEqual(report(state).boxes,expected);const negative=Object.fromEntries(codes.map(k=>[k,expected[k]===0?0:-expected[k]]));
  const actual=report(state,q3).boxes;for(const k of codes)assert.equal(actual[k]||0,negative[k],k);
  assert.equal(JSON.stringify(state.vatReturns[0]),record);verify(state);
 });
 scenario(i,'new in-period source invalidates reviewed XML without editing prior review',()=>{
  let{state,source}=portfolio(i);state=declare(state);const review=JSON.stringify(state.declarations[0]),id=state.declarations[0].id;
  assertXmlKronor(getDeclarationFile(state,id).value,oracle(source).boxes);const extra={...source[0],date:'2026-06-26',reference:'EXTRA',netCents:source[0].netCents+31};
  state=postTaxTransaction(state,extra);atomic(state,()=>getDeclarationFile(state,id),/ändrats|ny deklarationsversion/);assert.equal(JSON.stringify(state.declarations[0]),review);equalReport(state,[...source,extra]);verify(state);
 });
 scenario(i,'outside-period source leaves reviewed XML bytes and old bases unchanged',()=>{
  let{state,source}=portfolio(i);state=declare(state);const id=state.declarations[0].id,bytes=getDeclarationFile(state,id).value;
  state=postTaxTransaction(state,{...source[0],date:'2026-07-15',reference:'LATER',netCents:source[0].netCents+37});
  assert.equal(getDeclarationFile(state,id).value,bytes);equalReport(state,source);verify(state);
 });
 scenario(i,'normalized duplicate rejects altered money while another counterparty is distinct',()=>{
  let{state,source}=portfolio(i);const duplicate={...source[0],reference:`  ${source[0].reference.toLowerCase()} `,counterparty:` ${source[0].counterparty.toUpperCase()} `,netCents:source[0].netCents+41};
  atomic(state,()=>postTaxTransaction(state,duplicate),/redan registrerat/);const separate={...duplicate,counterparty:'Annan självständig fiktiv motpart'};state=postTaxTransaction(state,separate);equalReport(state,[...source,separate]);verify(state);
 });
 scenario(i,'multi-source restoration rejects altered cross-record evidence',()=>{
  const{state}=portfolio(i),before=JSON.stringify(state),mutated=structuredClone(state);
  switch(i%5){
   case 0:mutated.taxTransactions[1].boxes['42']++;break;
   case 1:mutated.bankTransactions[0].matchedEntryId=mutated.taxTransactions[1].entryId;break;
   case 2:mutated.entries=mutated.entries.filter(e=>e.id!==mutated.taxTransactions[3].entryId);break;
   case 3:mutated.taxTransactions[3].id=mutated.taxTransactions[0].id;break;
   case 4:mutated.taxTransactions[0].rows[0].account='3000';break;
  }
  assert.throws(()=>validateSuiteState(mutated));assert.equal(JSON.stringify(state),before);verify(state);
 });
}
assert.equal(count,200);
