import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createEmptyState, appendEntry, transact, accountBalance } from '../public/bokforing/suite/core.js';
import { createSuiteState } from '../public/bokforing/suite/seed.js';
import { decodeSie, encodeSiePc8, exportSie4, exportSie4Text, importSie4, parseSie4, previewSieImport, sieFingerprint, validateSieImports } from '../public/bokforing/suite/sie.js';
import { getDownload, handleAction } from '../public/bokforing/suite/sie-workspace.js';

const header = '#FLAGGA 0\n#PROGRAM "Bokföring Test" "2.0"\n#FORMAT PC8\n#GEN 20261023\n#SIETYP 4\n#FNAMN "Åkes Hantverk AB"\n#RAR 0 20260101 20261231\n#VALUTA SEK\n';
const voucher = (number='1',date='20260201',description='Bankavgift',account='6570',value='125.25') => `#VER "B" "${number}" ${date} "${description}"\n{\n#TRANS ${account} {} ${value}\n#TRANS 1930 {} -${value}\n}\n`;
const fixture = (extra='') => header+voucher()+extra;
const confirmed = { confirmed:true };

function compareBalances(source, decoded) {
  const values = new Map(decoded.balances.filter(row=>row.year===0&&row.kind==='IB').map(row=>[row.account,row.amountCents]));
  for(const entry of decoded.vouchers)for(const row of entry.rows)values.set(row.account,(values.get(row.account)??0)+row.amountCents);
  for(const [account,value] of values)assert.equal(value,accountBalance(source,account),account);
}

test('SHA-256 fingerprint agrees with independent node implementation, including Swedish Unicode',()=>{
  for(const value of ['','abc','Åkes Hantverk AB \"Örebro\"','x'.repeat(1000)])assert.equal(sieFingerprint(value),createHash('sha256').update(value).digest('hex'));
});

test('PC8 uses CP437 bytes, preserves Swedish characters and rejects unsupported Unicode',()=>{
  const text='ÅÄÖåäö é £'; const bytes=encodeSiePc8(text);
  assert.equal(bytes[0],0x8f); assert.equal(bytes[1],0x8e); assert.equal(bytes[2],0x99);
  assert.equal(decodeSie(bytes),text);
  assert.throws(()=>encodeSiePc8('Faktura 😀'),/kan inte skrivas/);
  const utf8=new TextEncoder().encode('\uFEFFÅke');
  assert.throws(()=>decodeSie(utf8),/UTF-8/);
  assert.equal(decodeSie(utf8,{encoding:'utf8'}),'Åke');
});

test('exported SIE4 has mandatory headers, all journal balances and no duplicated opening entry',()=>{
  assert.throws(()=>exportSie4(createEmptyState()),/saknar bokföring/);
  const state=createSuiteState(), bytes=exportSie4(state,{generated:'2026-10-23'}), decoded=parseSie4(bytes);
  assert.equal(decoded.program[0],'ScrapPlanner Bokforing');
  assert.equal(decoded.companyName,state.company.name);
  assert.equal(decoded.vouchers.length,state.entries.filter(entry=>entry.sourceType!=='opening').length);
  assert.equal(decoded.balances.find(row=>row.kind==='IB'&&row.account==='1930').amountCents,50_000_000);
  assert.ok(decodeSie(bytes).startsWith('#FLAGGA 0\r\n'));
  compareBalances(state,decoded);
});

test('quoted fields retain escaped quotes and backslashes while export normalizes typography safely',()=>{
  let state=transact(createEmptyState(),draft=>appendEntry(draft,{date:'2026-02-01',description:'Köp “test” – C:\\Kvitton',sourceType:'manual',sourceId:'m-1',rows:[{account:'6570',debitCents:12300,creditCents:0},{account:'1930',debitCents:0,creditCents:12300}]}));
  const parsed=parseSie4(exportSie4(state,{generated:'2026-10-23'}));
  assert.equal(parsed.vouchers[0].description,'Köp "test" - C:\\Kvitton');
});

test('hand-authored external SIE voucher imports atomically with original reference and exact cents',()=>{
  const state=createEmptyState(), before=structuredClone(state), next=importSie4(state,encodeSiePc8(fixture()),confirmed);
  assert.deepEqual(state,before); assert.equal(next.entries.length,1);
  assert.equal(accountBalance(next,'6570'),12525); assert.equal(accountBalance(next,'1930'),-12525);
  assert.equal(next.entries[0].description,'B1 · Bankavgift'); assert.equal(next.entries[0].sourceType,'sie-import');
  const checked=validateSieImports(next); assert.deepEqual([...checked.claimedEntryIds],[next.entries[0].id]);
  assert.equal(checked.accountAdjustments['1930'],-12525);
  assert.throws(()=>importSie4(next,fixture(),confirmed),/redan importerats/);
});

test('ingående balance imports once and subsequent exports do not count it twice',()=>{
  const text=header+'#IB 0 1930 1000.00\n#IB 0 2081 -1000.00\n#UB 0 1930 874.75\n#UB 0 2081 -1000.00\n#RES 0 6570 125.25\n'+voucher();
  const state=importSie4(createEmptyState(),text,confirmed);
  assert.equal(state.entries.length,2); assert.equal(accountBalance(state,'1930'),87475);
  validateSieImports(state); compareBalances(state,parseSie4(exportSie4(state,{generated:'2026-10-23'})));
  const second=header+'#PROSA "Ny export"\n#IB 0 1930 1000.00\n#IB 0 2081 -1000.00\n'+voucher()+voucher('2','20260301');
  const next=importSie4(state,second,confirmed);
  assert.equal(next.entries.length,3); assert.equal(next.sieImports[1].items.length,1); validateSieImports(next);
});

test('matching native opening is retained while mismatched or unbalanced IB is rejected',()=>{
  const state=transact(createEmptyState(),draft=>appendEntry(draft,{date:'2026-01-01',description:'IB',sourceType:'opening',sourceId:'ib',rows:[{account:'1930',debitCents:100000,creditCents:0},{account:'2081',debitCents:0,creditCents:100000}]}));
  const text=header+'#IB 0 1930 1000.00\n#IB 0 2081 -1000.00\n'+voucher();
  assert.equal(importSie4(state,text,confirmed).entries.length,2);
  assert.throws(()=>previewSieImport(state,text.replaceAll('1000.00','2000.00')),/skiljer/);
  assert.throws(()=>previewSieImport(createEmptyState(),text.replace('#IB 0 2081 -1000.00','#IB 0 2081 -900.00')),/balanserar/);
});

test('cross-file duplicate voucher is skipped, changed voucher is rejected and source history is complete',()=>{
  const first=importSie4(createEmptyState(),fixture(),confirmed);
  const next=importSie4(first,header+'#PROSA "Updated export"\n'+voucher()+voucher('2','20260301','Nästa avgift'),confirmed);
  assert.equal(next.entries.length,2); validateSieImports(next);
  assert.throws(()=>importSie4(next,header+'#PROSA "Altered"\n'+voucher('1','20260201','Bankavgift','6570','126.25'),confirmed),/ändrats/);
  const altered=structuredClone(next); altered.sieImports[1].items=[];
  assert.throws(()=>validateSieImports(altered),/verifikationslista|saknar/);
});

test('locked late voucher rolls back earlier valid voucher and all metadata',()=>{
  const state=createEmptyState(); state.lockedPeriods=['2026-03']; const before=structuredClone(state);
  assert.throws(()=>importSie4(state,fixture(voucher('2','20260301')),confirmed),/låst/);
  assert.deepEqual(state,before);
});

test('unknown account requires explicit mapping without losing gross debit/credit rows',()=>{
  const text=header+'#KONTO 3010 "Försäljning"\n#VER "S" "12" 20260501 "Försäljning"\n{\n#TRANS 1930 {} 1000.00\n#TRANS 3010 {} -900.00\n#TRANS 3010 {} -200.00\n#TRANS 3010 {} 100.00\n}\n';
  assert.throws(()=>previewSieImport(createEmptyState(),text),/3010 behöver kopplas/);
  const next=importSie4(createEmptyState(),text,{...confirmed,mapping:{3010:'3000'}});
  assert.equal(next.entries[0].rows.length,4); assert.equal(accountBalance(next,'3000'),-100000); validateSieImports(next);
});

test('company/year mismatch, malformed amounts, dimensions and incorrect closing balances are blocked',()=>{
  const state=createEmptyState();
  const bad=[
    [fixture().replace('#VALUTA SEK','#VALUTA EUR'),/valuta/],
    [fixture().replace('#FNAMN', '#ORGNR "556334-3689"\n#FNAMN'),/organisationsnummer/],
    [fixture().replace('20260101 20261231','20250101 20251231'),/räkenskapsåret/],
    [fixture().replace('125.25','125,25'),/punkt/],
    [fixture().replace('125.25','125.255'),/decimaler/],
    [fixture().replace('125.25','1000000000000000.00'),/beloppsgräns/],
    [fixture().replace('6570 {}','6570 {1 "P1"}'),/dimensioner/],
    [fixture()+'#UB 0 1930 -125.24\n#RES 0 6570 125.25\n',/SIE-saldot/],
    [fixture().replace('20260201','20260230'),/ogiltigt datum/],
    [fixture()+'#KSUMMA 12345\n',/KSUMMA/],
  ];
  for(const [text,error] of bad)assert.throws(()=>previewSieImport(state,text),error);
});

test('removed and added history rows follow active TRANS rows, not doubled BTRANS/RTRANS',()=>{
  const text=header+'#VER "B" "1" 20260201 "Rättad"\n{\n#BTRANS 6110 {} 100.00\n#RTRANS 6570 {} 100.00\n#TRANS 6570 {} 100.00\n#TRANS 1930 {} -100.00\n}\n';
  const preview=previewSieImport(createEmptyState(),text);
  assert.equal(preview.parsed.ignoredCorrections,2); assert.equal(preview.debitCents,10000);
  const next=importSie4(createEmptyState(),text,confirmed); assert.equal(next.entries[0].rows.length,2);
});

test('import requires explicit review, anonymous-file acknowledgement and detects tampering',()=>{
  assert.throws(()=>importSie4(createEmptyState(),fixture()),/bekräfta/);
  const text=fixture().replace('#VER "B" "1"','#VER "" ""');
  assert.throws(()=>importSie4(createEmptyState(),text,confirmed),/utan serie/);
  const next=importSie4(createEmptyState(),text,{...confirmed,anonymousConfirmed:true});
  validateSieImports(next);
  for(const mutate of [state=>{state.entries[0].rows[0].debitCents++;},state=>{state.sieImports[0].sourceText+='\n#PROSA "changed"';},state=>{state.sieImports[0].items[0].contentHash='bad';}]) {
    const altered=structuredClone(next); mutate(altered); assert.throws(()=>validateSieImports(altered),/ändrats|stämmer/);
  }
});

test('workspace exports binary PC8 and marks acknowledged source copy without deleting original',()=>{
  const state=importSie4(createEmptyState(),fixture(),confirmed);
  const original=state.sieImports[0].sourceText;
  const output=getDownload(state,'export',{year:'2026-01-01/2026-12-31'});
  assert.ok(output.value instanceof Uint8Array); assert.match(output.name,/\.se$/); parseSie4(output.value);
  const receipt=getDownload(state,'receipt',{id:state.sieImports[0].id});
  assert.match(decodeSie(receipt.value),/^#FLAGGA 1/); assert.equal(state.sieImports[0].sourceText,original);
  assert.throws(()=>handleAction(state,'import',{sourceText:fixture(),confirmed:false}),/bekräfta/);
});

test('SIE imports protected balance accounts through full suite validation without fictitious subledgers', async()=>{
  const {validateSuiteState}=await import('../public/bokforing/suite/validate.js');
  const accounts=['1510','2440','1220','1229','1790','1460','2910','2710','2731','2650','1680'];
  for(const [index,account] of accounts.entries()) {
    const source=header+voucher(String(index+1),'20260401',`Överföring ${account}`,account);
    const imported=importSie4(createEmptyState(),source,confirmed);
    validateSuiteState(imported);
    assert.equal(imported.invoices.length,0); assert.equal(imported.bills.length,0);
    assert.equal(imported.assets.length,0); assert.equal(imported.payrollRuns.length,0);
    const restored=JSON.parse(JSON.stringify(imported));validateSuiteState(restored);
  }
});

test('mapping cannot move opening balance to income and renamed identity cannot re-import numbered vouchers',()=>{
  const text=header+'#IB 0 1930 1000.00\n#IB 0 2081 -1000.00\n'+voucher();
  assert.throws(()=>previewSieImport(createEmptyState(),text,{mapping:{1930:'3000'}}),/balanskonton/);
  const imported=importSie4(createEmptyState(),fixture(),confirmed);
  assert.throws(()=>importSie4(imported,fixture().replace('Åkes Hantverk AB','Bolagets nya namn'),confirmed),/Alla verifikationer finns redan/);
});

test('large gross totals and missing import metadata fail before acceptance',()=>{
  const text=header+'#VER "B" "1" 20260102 "För stort"\n{\n#TRANS 6570 {} 6000000000.00\n#TRANS 6570 {} 6000000000.00\n#TRANS 1930 {} -6000000000.00\n#TRANS 1930 {} -6000000000.00\n}\n';
  assert.throws(()=>previewSieImport(createEmptyState(),text),/beloppsgräns/);
  const imported=importSie4(createEmptyState(),fixture(),confirmed);
  imported.sieImports[0].importedAt='';assert.throws(()=>validateSieImports(imported),/tidpunkt/);
});

test('inventory imports are blocked after a native valuation to preserve the stock control account',async()=>{
  const {postStockValuation,createStockItem,recordStockMovement}=await import('../public/bokforing/suite/inventory.js');
  let state=createStockItem(createEmptyState(),{name:'Fiktiv skruv',unit:'st',unitCostCents:100});
  state=recordStockMovement(state,state.inventoryItems[0].id,{date:'2026-01-01',kind:'in',quantity:10,reason:'Fiktiv inleverans'});
  state=transact(state,draft=>appendEntry(draft,{date:'2026-01-01',description:'Inköp',sourceType:'manual',sourceId:'stock-buy',rows:[{account:'4010',debitCents:1000,creditCents:0},{account:'1930',debitCents:0,creditCents:1000}]}));
  state=postStockValuation(state,{date:'2026-01-02'});
  assert.throws(()=>previewSieImport(state,header+voucher('1','20260103','Lagervärde','1460')),/före första lagervärderingen/);
});

test('already result-transferred SIE cannot hide profit through imported account 8999',()=>{
  const source=header+'#VER "A" "1" 20261001 "Försäljning"\n{\n#TRANS 1930 {} 1000.00\n#TRANS 3000 {} -1000.00\n}\n#VER "A" "2" 20261231 "Årets resultat"\n{\n#TRANS 8999 {} 1000.00\n#TRANS 2099 {} -1000.00\n}\n';
  const state=createEmptyState(), original=structuredClone(state);
  assert.throws(()=>previewSieImport(state,source),/resultatbokning på konto 8999/);
  assert.throws(()=>importSie4(state,source,confirmed),/resultatbokning på konto 8999/);
  assert.throws(()=>previewSieImport(state,source,{mapping:{8999:'6991'}}),/resultatbokning på konto 8999/);
  assert.throws(()=>previewSieImport(state,fixture(),{mapping:{6570:'8999'}}),/resultatbokning på konto 8999/);
  assert.deepEqual(state,original);
});

test('balanced opening profit accounts 2098 and 2099 remain usable without changing current-year result',async()=>{
  const {validateSuiteState}=await import('../public/bokforing/suite/validate.js');
  const {getReports}=await import('../public/bokforing/suite/finance.js');
  for(const account of ['2098','2099']) {
    const source=header+`#IB 0 1930 1000.00\n#IB 0 ${account} -1000.00\n#UB 0 1930 1000.00\n#UB 0 ${account} -1000.00\n`;
    const state=importSie4(createEmptyState(),source,confirmed);
    validateSuiteState(state);
    assert.equal(accountBalance(state,account),-100000);
    assert.equal(getReports(state).resultCents,0);
    compareBalances(state,parseSie4(exportSie4(state)));
  }
});
