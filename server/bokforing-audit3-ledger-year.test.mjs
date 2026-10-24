import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ACCOUNTS, accountBalance, appendEntry, createEmptyState, transact } from '../public/bokforing/suite/core.js';
import { postManualEntry, correctEntry } from '../public/bokforing/suite/operations.js';
import { lockPeriod, unlockPeriod, closeYear } from '../public/bokforing/suite/finance.js';
import { openNextYear, getYearReports, exportYearReview, saveYearWorkpaper, closeReviewedYear } from '../public/bokforing/suite/financial-years.js';
import { importSie4, previewSieImport, exportSie4, parseSie4, decodeSie, sieFingerprint } from '../public/bokforing/suite/sie.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

// Twenty reproducible multi-account portfolios, each exercised through ten
// distinct workflows. The oracle records supplied accounting events directly;
// it does not use a production report, parser, posting or rounding helper.
const expenses=['5010','5410','5460','6110','6540','6570','6991'];
const clone=x=>structuredClone(x);
const D=(account,n)=>({account,debitCents:n,creditCents:0});
const C=(account,n)=>({account,debitCents:0,creditCents:n});
const amount=n=>`${Math.floor(n/100)}.${String(n%100).padStart(2,'0')}`;
const quoted=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
const check=s=>{validateSuiteState(s);const restored=JSON.parse(JSON.stringify(s));validateSuiteState(restored);return s;};
const noWrite=(state,run,pattern=/./)=>{const old=JSON.stringify(state);assert.throws(run,pattern);assert.equal(JSON.stringify(state),old);check(state);};
const balances=s=>Object.fromEntries(ACCOUNTS.map(({number})=>[number,accountBalance(s,number)]).filter(([,n])=>n!==0));
const apply=(book,rows)=>{for(const row of rows)book[row.account]=(book[row.account]??0)+row.debitCents-row.creditCents;return book;};
const compact=book=>Object.fromEntries(Object.entries(book).filter(([,n])=>n!==0).sort(([a],[b])=>a.localeCompare(b)));
const assertBook=(state,book)=>assert.deepEqual(compact(balances(state)),compact(book));
function data(i){
 const capital=2000000+i*101,a=101+i*617,b=203+i*419,c=907+i*1133,d=53+i*227;
 const x=expenses[i%7],y=expenses[(i+2)%7],z=expenses[(i+4)%7];
 const descriptions=[`Årsprov ${i}: "första" \\ avdelning`,`Öresintäkt ${i} & ränta`,`Återkommande kostnad ${i}`];
 const specs=[{date:'2026-04-10',description:descriptions[0],rows:[D(x,a),D(y,b),C('1930',a+b)]},
 {date:'2026-05-15',description:descriptions[1],rows:[D('1930',c),C('3000',c)]},
 {date:'2026-09-20',description:descriptions[2],rows:[D(z,d),C('1930',d)]}];
 return {i,capital,a,b,c,d,x,y,z,specs};
}
function start(p){return transact(createEmptyState(),s=>appendEntry(s,{date:'2026-01-01',description:'Fiktivt granskat ingående kapital',sourceType:'opening',sourceId:`audit3-capital-${p.i}`,rows:[D('1930',p.capital),C('2081',p.capital)]}));}
function portfolio(p,order=[0,1,2]){let state=start(p),book={'1930':p.capital,'2081':-p.capital};for(const n of order){state=postManualEntry(state,clone(p.specs[n]));apply(book,p.specs[n].rows);}return {state:check(state),book};}
function header(p){return '#FLAGGA 0\n#PROGRAM "AUDIT3 independent source" "1"\n#FORMAT PC8\n#GEN 20261024\n#SIETYP 4\n#FNAMN "Åkes Hantverk AB"\n#ORGNR "5599999991"\n#RAR 0 20260101 20261231\n#VALUTA SEK\n'+`#IB 0 1930 ${amount(p.capital)}\n#IB 0 2081 -${amount(p.capital)}\n`;}
function file(p,indexes=[0,1,2],badLast=false){return header(p)+indexes.map((n,index)=>{
 const s=p.specs[n];return `#VER "B" "${p.i*10+n+1}" ${s.date.replaceAll('-','')} ${quoted(s.description)}\n{\n`+s.rows.map((r,k)=>`#TRANS ${r.account} {} ${r.debitCents?amount(r.debitCents):'-'+amount(r.creditCents+(badLast&&index===indexes.length-1&&k===s.rows.length-1?1:0))}\n`).join('')+'}\n';
}).join('');}
function close(state){let next=state;for(let month=1;month<=12;month++)next=lockPeriod(next,`2026-${String(month).padStart(2,'0')}`);return check(closeYear(next,{date:'2026-12-31',confirmed:true}));}
let count=0;
const run=(family,p,body)=>test(`AUDIT3-YEAR-${String(++count).padStart(3,'0')} ${family}; portfolio ${p.i}`,body);
for(let i=1;i<=20;i++){
 const p=data(i);
 run('backdated portfolio order preserves complete trial balance',p,()=>{
  const forward=portfolio(p),shuffled=portfolio(p,[2,0,1]);assertBook(forward.state,forward.book);assertBook(shuffled.state,forward.book);
  assert.deepEqual(shuffled.state.entries.map(e=>e.number),['A1','A2','A3','A4']);
  assert.deepEqual(shuffled.state.entries.slice(1).map(e=>e.date),['2026-09-20','2026-04-10','2026-05-15']);
  for(const state of [forward.state,shuffled.state])for(const e of state.entries)assert.equal(e.rows.reduce((s,r)=>s+r.debitCents-r.creditCents,0),0);
 });
 run('multi-leg correction and reclassification retain every original',p,()=>{
  let {state,book}=portfolio(p);const original=clone(state.entries);state=correctEntry(state,state.entries[1].id,{date:'2026-10-01',reason:'En kronasdel rättas mellan två kostnadskonton'});
  apply(book,p.specs[0].rows.map(r=>({account:r.account,debitCents:r.creditCents,creditCents:r.debitCents})));
  const replacement=[D(p.x,p.a+1),D(p.y,p.b-1),C('1930',p.a+p.b)];state=postManualEntry(state,{date:'2026-10-01',description:'Ny korrekt klassning',rows:replacement});apply(book,replacement);
  assertBook(check(state),book);assert.deepEqual(state.entries.slice(0,original.length),original);assert.equal(state.entries[4].correctsEntryId,original[1].id);
  noWrite(state,()=>correctEntry(state,original[1].id,{date:'2026-10-02',reason:'Dubbel rättelse'}),/redan/);
 });
 run('locked original is corrected in a later open period without rewriting history',p,()=>{
  let {state,book}=portfolio(p);state=lockPeriod(state,'2026-04');const original=clone(state.entries);
  noWrite(state,()=>correctEntry(state,state.entries[1].id,{date:'2026-04-30',reason:'Låst period'}),/låst/);
  state=correctEntry(state,state.entries[1].id,{date:'2026-10-01',reason:'Dokumenterad senare rättelse'});
  apply(book,p.specs[0].rows.map(r=>({account:r.account,debitCents:r.creditCents,creditCents:r.debitCents})));
  assertBook(check(state),book);assert.deepEqual(state.entries.slice(0,original.length),original);assert.deepEqual(state.lockedPeriods,['2026-04']);
  assert.equal(getYearReports(state,{start:'2026-04-01',end:'2026-04-30'}).expenseCents,p.a+p.b);
 });
 run('SIE roundtrip conserves corrected portfolio and opening equity',p,()=>{
  let {state,book}=portfolio(p);if(i%2){state=correctEntry(state,state.entries[3].id,{date:'2026-10-01',reason:'Felaktig återkommande kostnad'});book[p.z]-=p.d;book['1930']+=p.d;}
  const bytes=exportSie4(state,{generated:'2026-10-24'}),text=decodeSie(bytes),parsed=parseSie4(bytes);
  assert.equal(sieFingerprint(text.replace(/\r\n?/g,'\n')),createHash('sha256').update(text.replace(/\r\n?/g,'\n')).digest('hex'));
  assert.equal(parsed.vouchers.length,state.entries.length-1);assert.equal(parsed.orgNumber,'5599999991');
  const imported=check(importSie4(createEmptyState(),bytes,{confirmed:true}));assertBook(imported,book);
  assert.equal(imported.entries.filter(e=>e.sourceType==='sie-import').length,state.entries.length);
  assert.ok(parsed.vouchers.some(v=>v.description.includes('Öresintäkt')));assert.ok(parsed.vouchers.some(v=>v.description.includes('"första"')));
 });
 run('overlapping SIE batches add only the new voucher and no second opening',p,()=>{
  let state=check(importSie4(createEmptyState(),file(p,[0,1]),{confirmed:true}));const first=clone(state.entries);
  const preview=previewSieImport(state,file(p));assert.equal(preview.freshCount,1);assert.equal(preview.duplicateCount,2);assert.equal(preview.includeOpening,false);
  state=check(importSie4(state,file(p),{confirmed:true}));assertBook(state,portfolio(p).book);assert.deepEqual(state.entries.slice(0,first.length),first);assert.equal(state.entries.length,4);assert.equal(state.sieImports.length,2);
  noWrite(state,()=>importSie4(state,file(p),{confirmed:true}),/redan/);
 });
 run('malformed final SIE voucher leaves a nonempty portfolio unchanged',p,()=>{
  const {state}=portfolio(p,[1]);noWrite(state,()=>importSie4(state,file(p,[0,2],true),{confirmed:true}),/balanserar/);
  assert.equal(state.entries.length,2);assert.equal(state.sieImports,undefined);
 });
 run('SIE batch spanning locked month can be retried after documented unlock',p,()=>{
  let state=lockPeriod(start(p),'2026-05'),sequence=state.sequence;
  noWrite(state,()=>importSie4(state,file(p),{confirmed:true}),/låst/);assert.equal(state.sequence,sequence);
  const oldActivity=clone(state.activity);state=unlockPeriod(state,'2026-05','Verifierat importunderlag före rättad periodlåsning');
  assert.deepEqual(state.activity.slice(0,oldActivity.length),oldActivity);
  state=check(importSie4(state,file(p),{confirmed:true}));assertBook(state,portfolio(p).book);assert.deepEqual(state.entries.map(e=>e.number),['A1','A2','A3','A4']);
 });
 run('imported and manual original journals resist balanced in-place rewriting',p,()=>{
  let state=importSie4(start(p),file(p,[0,1]),{confirmed:true});state=postManualEntry(state,clone(p.specs[2]));state=correctEntry(state,state.entries.at(-1).id,{date:'2026-10-01',reason:'Granskat rättelsebehov'});check(state);
  const target=state.entries[1].id;
  noWrite(state,()=>transact(state,draft=>{const e=draft.entries.find(e=>e.id===target);e.rows[0].debitCents+=i;e.rows.at(-1).creditCents+=i;}),/ändras|raderas/);
  noWrite(state,()=>correctEntry(state,target,{date:'2026-10-02',reason:'Felaktigt manuellt ingrepp i SIE-original'}),/ursprungsflöde/);
  assertBook(state,{'1930':p.capital-p.a-p.b+p.c,'2081':-p.capital,[p.x]:p.a,[p.y]:p.b,'3000':-p.c});
 });
 run('year carry isolates old portfolio from next-period activity and exported copies',p,()=>{
  const base=portfolio(p);let state=close(base.state);const result=p.c-p.a-p.b-p.d;
  assert.equal(state.yearClosures[0].resultCents,result);
  const ends=['2027-01-28','2027-06-30','2027-12-31','2028-06-30'];state=openNextYear(state,{confirmed:true,end:ends[i%4]});check(state);
  const frozen=JSON.stringify(state.fiscalYears[0].snapshot),originalEntries=clone(state.fiscalYears[0].snapshot.entries);
  state=postManualEntry(state,{date:'2027-01-02',description:'Nästa års faktiska kostnad',rows:[D(p.x,p.a),C('1930',p.a)]});check(state);
  assert.equal(getYearReports(state).resultCents,-p.a);assert.equal(getYearReports(state,{start:'2026-01-01',end:'2026-12-31'}).resultCents,result);
  assert.equal(accountBalance(state,'2098'),-result);assert.equal(accountBalance(state,'2099'),0);assert.equal(accountBalance(state,'1930'),p.capital+result-p.a);
  assert.equal(JSON.stringify(state.fiscalYears[0].snapshot),frozen);assert.deepEqual(state.entries.filter(e=>e.date<'2027-01-01'),originalEntries);
  const exported=exportYearReview(state,'2026-01-01','2026-12-31');exported.archivedSnapshot.entries[0].rows[0].debitCents=1;exported.company.name='Lokalt ändrat exemplar';
  assert.equal(JSON.stringify(state.fiscalYears[0].snapshot),frozen);check(state);
 });
 run('reviewed workpaper becomes stale after reclassification and retains revision evidence',p,()=>{
  let {state}=portfolio(p);const spec={title:`Kostnad ${p.x}`,category:'other',account:p.x,status:'reviewed',preparedBy:'Upprättare',reviewedBy:'Granskare',evidence:`Fiktivt underlag ${i}`};
  state=saveYearWorkpaper(state,spec);const id=state.yearWorkpapers[0].id,first=clone(state.yearWorkpapers[0].revisions[0]);
  state=correctEntry(state,state.entries[1].id,{date:'2026-10-01',reason:'Omklassning efter granskning'});
  noWrite(state,()=>closeReviewedYear(state,{confirmed:true}),/kontosaldo har ändrats/);
  state=saveYearWorkpaper(state,{...spec,id,status:'prepared'});state=saveYearWorkpaper(state,{...spec,id,status:'reviewed'});check(state);
  assert.equal(state.yearWorkpapers[0].balanceCents,0);assert.equal(first.balanceCents,p.a);assert.deepEqual(state.yearWorkpapers[0].revisions[0],first);assert.equal(state.yearWorkpapers[0].revisions.length,3);
  noWrite(state,()=>closeReviewedYear(state,{confirmed:true}),/Perioder låsta/);
 });
}
assert.equal(count,200);
