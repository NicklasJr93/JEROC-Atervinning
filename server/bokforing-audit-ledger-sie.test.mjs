import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MAX_CENTS, accountBalance, appendEntry, cents, createEmptyState, toCents, transact, validDate } from '../public/bokforing/suite/core.js';
import { postManualEntry, correctEntry } from '../public/bokforing/suite/operations.js';
import { lockPeriod, unlockPeriod } from '../public/bokforing/suite/finance.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { parseSie4, previewSieImport, importSie4, exportSie4, exportSie4Text, encodeSiePc8, decodeSie, sieFingerprint } from '../public/bokforing/suite/sie.js';
import { createSuiteStorage, STORAGE_KEY } from '../public/bokforing/suite/storage.js';

// Each registration is an independently reported deterministic scenario. Fixtures
// and expected cents/bytes are written here, rather than produced by the parser.
let serial = 0;
const audit = (name, run) => test(`AUDIT-LEDGER-${String(++serial).padStart(3, '0')} ${name}`, run);
const clone = value => structuredClone(value);
const checked = state => { assert.equal(validateSuiteState(state), state); return state; };
const rows = (amount = 12345, expense = '5010') => [
  { account: expense, debitCents: amount, creditCents: 0 },
  { account: '1930', debitCents: 0, creditCents: amount },
];
const manual = (state = createEmptyState(), overrides = {}) => checked(postManualEntry(state, { date: '2026-06-15', description: 'Granskat fiktivt underlag', rows: rows(), ...overrides }));
const atomicReject = (state, action, pattern = /./) => {
  const before = clone(state);
  assert.throws(() => action(state), pattern);
  assert.deepEqual(state, before, 'A rejected operation must leave its input unchanged');
  checked(state);
};
// Explicit fictional organisation fixture matching the current demo company.
// Keep the mismatch/missing-identity cases below as independent negative tests.
const header = '#FLAGGA 0\n#PROGRAM "Independent audit fixture" "1"\n#FORMAT PC8\n#GEN 20261023\n#SIETYP 4\n#FNAMN "Åkes Hantverk AB"\n#ORGNR "5599999991"\n#RAR 0 20260101 20261231\n#VALUTA SEK\n';
const voucher = ({ series = 'B', number = '1', date = '20260615', text = 'Handskriven avgift', debit = '6570', credit = '1930', amount = '123.45', extra = '' } = {}) =>
  `#VER "${series}" "${number}" ${date} "${text}"\n{\n#TRANS ${debit} {} ${amount}\n#TRANS ${credit} {} -${amount}\n${extra}}\n`;
const source = overrides => header + voucher(overrides);
const imported = overrides => checked(importSie4(createEmptyState(), source(overrides), { confirmed: true }));

for (const [input, expected] of [
  ['0',0], ['0,01',1], ['0.09',9], ['1',100], ['1,2',120], ['1.23',123],
  ['000001.23',123], ['  999,99  ',99999], ['1 000,00',100000], ['999 999.99',99999999],
  ['1\u00a0000,01',100001], ['1\u202f000.02',100002], ['1 000 000,00',100000000],
  ['9 999 999 999,99',999999999999], ['10000000000.00',1000000000000], [12.34,1234],
]) audit(`decimal amount ${JSON.stringify(input)} has exact cents ${expected}`, () => assert.equal(toCents(input), expected));
for (const input of ['', ' ', '-0', '-1', '+1', '.5', ',5', '1.', '1,', '1.001', '1,001', '1e2',
  '1.000,00', '1,000.00', '1 00', '1234 567', '1\t000', '1\n000', '1  000', '1_000',
  'NaN', 'Infinity', '10000000000.01', 1e21, null, true, {}, []]) {
  audit(`reject malformed or excessive decimal ${JSON.stringify(input)}`, () => assert.throws(() => toCents(input)));
}
for (const [input, expected] of [
  ['2026-01-01',true],['2026-12-31',true],['2026-04-30',true],['2024-02-29',true],
  ['2000-02-29',true],['1900-02-28',true],['2026-02-28',true],['2026-10-31',true],
  ['2026-02-29',false],['1900-02-29',false],['2100-02-29',false],['2026-04-31',false],
  ['2026-06-31',false],['2026-00-01',false],['2026-13-01',false],['2026-01-00',false],
  ['2026-01-32',false],['2026-1-01',false],['26-01-01',false],['2026-01-01T00:00:00Z',false],
  [' 2026-01-01',false],['2026-01-01 ',false],[null,false],[20260101,false],
]) audit(`calendar boundary ${JSON.stringify(input)} valid=${expected}`, () => assert.equal(validDate(input), expected));
for (const [input, allowZero, expected] of [[0,true,0],[1,false,1],[MAX_CENTS,true,MAX_CENTS],[MAX_CENTS,false,MAX_CENTS]]) {
  audit(`integer cents accepts ${input} with allowZero=${allowZero}`, () => assert.equal(cents(input,allowZero), expected));
}
for (const [input, allowZero] of [[0,false],[-1,true],[0.5,true],[MAX_CENTS+1,true],[Number.MAX_SAFE_INTEGER,true],[Infinity,true],[NaN,true],['100',true]]) {
  audit(`integer cents rejects ${String(input)} with allowZero=${allowZero}`, () => assert.throws(() => cents(input, allowZero)));
}

for (const [expense, amount, date] of [
  ['5010',1,'2026-01-01'], ['5410',99,'2026-01-31'], ['5460',100,'2026-02-28'],
  ['6110',101,'2026-03-31'], ['6540',12345,'2026-04-30'], ['6570',99999,'2026-05-31'],
  ['6991',1000000,'2026-06-30'], ['4010',999999999999,'2026-07-31'], ['7010',MAX_CENTS,'2026-08-31'],
  ['7331',777,'2026-09-30'], ['7390',333,'2026-10-31'], ['7510',10001,'2026-11-30'],
  ['8310',222,'2026-12-31'], ['8410',1000001,'2026-02-01'], ['8910',45678,'2026-06-01'], ['3000',897,'2026-09-01'],
]) audit(`post and JSON restore ${expense} ${amount} cents on ${date}`, () => {
  const state = createEmptyState(), before = clone(state);
  const next = manual(state, {date,rows:rows(amount,expense)});
  assert.deepEqual(state,before);
  assert.equal(next.entries[0].number,'A1');
  assert.equal(accountBalance(next,expense),amount); assert.equal(accountBalance(next,'1930'),-amount);
  assert.deepEqual(checked(JSON.parse(JSON.stringify(next))),next);
});
for (const [label, mutate] of [
  ['no rows', s => {s.rows=[];}], ['one row', s => {s.rows.length=1;}],
  ['one-cent imbalance', s=>{s.rows[1].creditCents--;}], ['both sides',s=>{s.rows[0].creditCents=1;}],
  ['zero row',s=>{s.rows[0].debitCents=0;}], ['negative debit',s=>{s.rows[0].debitCents=-12345;}],
  ['fractional debit',s=>{s.rows[0].debitCents=12345.5;}], ['string debit',s=>{s.rows[0].debitCents='12345';}],
  ['excessive debit',s=>{s.rows=rows(MAX_CENTS+1);}], ['unknown account',s=>{s.rows[0].account='9998';}],
  ['numeric account',s=>{s.rows[0].account=5010;}], ['null row',s=>{s.rows[0]=null;}],
  ['unrepresented date',s=>{s.date='2026-02-29';}], ['previous year',s=>{s.date='2025-12-31';}],
  ['next year',s=>{s.date='2027-01-01';}], ['empty description',s=>{s.description=' ';}],
  ['description beyond limit',s=>{s.description='x'.repeat(501);}], ['embedded control text',s=>{s.description='Cost\u0000';}],
]) audit(`manual rejection is atomic: ${label}`, () => {
  const spec={date:'2026-06-15',description:'Felaktigt underlag',rows:rows()};mutate(spec);
  atomicReject(manual(), state=>postManualEntry(state,spec));
});
for (const account of ['1220','1229','1460','1510','1680','1710','1790','2440','2490','2611','2641','2650','2710','2731','2910','2099','4960','8999']) {
  audit(`manual posting cannot bypass protected control account ${account}`,()=>atomicReject(createEmptyState(),state=>postManualEntry(state,{date:'2026-06-15',description:'Bypass',rows:rows(100,account)})));
}
for (let month=1;month<=12;month++) {
  const period=`2026-${String(month).padStart(2,'0')}`;
  audit(`lock ${period}, reject posting, reopen with retained history`,()=>{
    let state=checked(lockPeriod(createEmptyState(),period));
    assert.deepEqual(state.lockedPeriods,[period]);
    atomicReject(state,s=>postManualEntry(s,{date:`${period}-01`,description:'Blocked',rows:rows(100)}),/låst/);
    const priorActivity=clone(state.activity);
    state=checked(unlockPeriod(state,period,'Kontrollerad rättelse enligt underlag'));
    assert.deepEqual(state.lockedPeriods,[]); assert.deepEqual(state.activity.slice(0,priorActivity.length),priorActivity);
    assert.match(state.activity.at(-1).label,/Kontrollerad rättelse/);
    checked(manual(state,{date:`${period}-01`}));
  });
}
for (const reason of ['', ' ', '\n', 'x'.repeat(501)]) audit(`unlock rejects invalid reason ${JSON.stringify(reason.slice(0,20))}`,()=>{
  atomicReject(checked(lockPeriod(createEmptyState(),'2026-06')),s=>unlockPeriod(s,'2026-06',reason));
});
for (const period of ['2025-12','2027-01','2026-00','2026-13','2026-6','June']) audit(`period lock rejects ${period}`,()=>atomicReject(createEmptyState(),s=>lockPeriod(s,period)));

for (const amount of [1,99,100,101,12345,99999999,MAX_CENTS]) audit(`linked correction exactly reverses ${amount} cents and is retained on restore`,()=>{
  const original=manual(createEmptyState(),{rows:rows(amount)}), snapshot=clone(original);
  const state=checked(correctEntry(original,original.entries[0].id,{date:'2026-06-16',reason:'Fel konto enligt verifikation'}));
  assert.deepEqual(original,snapshot); assert.deepEqual(state.entries[0],original.entries[0]);
  assert.equal(state.entries[1].number,'A2');assert.equal(state.entries[1].correctsEntryId,state.entries[0].id);
  assert.deepEqual(state.entries[1].rows,[{account:'5010',debitCents:0,creditCents:amount},{account:'1930',debitCents:amount,creditCents:0}]);
  assert.equal(accountBalance(state,'5010'),0);assert.equal(accountBalance(state,'1930'),0);
  checked(JSON.parse(JSON.stringify(state)));
});
for(const [label, act] of [
  ['missing original',s=>correctEntry(s,'missing',{date:'2026-06-16',reason:'Rättning'})],
  ['before original date',s=>correctEntry(s,s.entries[0].id,{date:'2026-06-14',reason:'Rättning'})],
  ['invalid leap day',s=>correctEntry(s,s.entries[0].id,{date:'2026-02-29',reason:'Rättning'})],
  ['next year',s=>correctEntry(s,s.entries[0].id,{date:'2027-01-01',reason:'Rättning'})],
  ['blank reason',s=>correctEntry(s,s.entries[0].id,{date:'2026-06-16',reason:' '})],
]) audit(`correction rejects ${label} atomically`,()=>atomicReject(manual(),act));
audit('same original cannot be corrected a second time',()=>{
  const original=manual();const state=checked(correctEntry(original,original.entries[0].id,{date:'2026-06-16',reason:'Rättning'}));
  atomicReject(state,s=>correctEntry(s,s.entries[0].id,{date:'2026-06-17',reason:'Dubbel'}),/redan/);
});
audit('a correction cannot itself be corrected by the manual workflow',()=>{
  const original=manual();const state=checked(correctEntry(original,original.entries[0].id,{date:'2026-06-16',reason:'Rättning'}));
  atomicReject(state,s=>correctEntry(s,s.entries[1].id,{date:'2026-06-17',reason:'Kedja'}),/ursprungsflöde/);
});
audit('journals retain a contiguous sequence across backdated entries and corrections',()=>{
  let state=manual(createEmptyState(),{date:'2026-06-01'});
  state=manual(state,{date:'2026-01-01'});state=manual(state,{date:'2026-12-31'});
  state=checked(correctEntry(state,state.entries[0].id,{date:'2026-06-02',reason:'Rättelse'}));
  assert.deepEqual(state.entries.map(x=>x.number),['A1','A2','A3','A4']);
  assert.equal(new Set(state.entries.map(x=>x.id)).size,4);checked(JSON.parse(JSON.stringify(state)));
});

for (const [label, mutate] of [
  ['journal deletion',s=>{s.entries=[];}], ['journal replacement',s=>{s.entries[0]={...s.entries[0],description:'Changed'};}],
  ['journal number change',s=>{s.entries[0].number='A2';}], ['journal date change',s=>{s.entries[0].date='2026-07-01';}],
  ['journal source change',s=>{s.entries[0].sourceId='changed';}], ['balanced amount change',s=>{s.entries[0].rows=rows(100);} ],
  ['journal actor change',s=>{s.entries[0].actor='Other';}], ['journal creation change',s=>{s.entries[0].createdAt='2026-01-01T00:00:00Z';}],
  ['history deletion',s=>{s.activity=[];}], ['history label change',s=>{s.activity[0].label='Changed';}],
  ['history actor change',s=>{s.activity[0].actor='Other';}], ['sequence rollback',s=>{s.sequence=0;}],
]) audit(`transaction prevents ${label}`,()=>atomicReject(manual(),s=>transact(s,mutate)));

for(const [label,mutate] of [
  ['wrong schema',s=>{s.schemaVersion=3;}], ['negative sequence',s=>{s.sequence=-1;}], ['fractional sequence',s=>{s.sequence=1.5;}],
  ['empty company name',s=>{s.company.name=' ';}], ['missing organisation',s=>{delete s.company.orgNumber;}],
  ['unsupported currency',s=>{s.company.currency='EUR';}], ['unknown method',s=>{s.company.method='hybrid';}],
  ['unknown VAT period',s=>{s.company.vatPeriod='week';}], ['inverted fiscal year',s=>{s.company.fiscalYearStart='2026-12-31';s.company.fiscalYearEnd='2026-01-01';}],
  ['invalid fiscal date',s=>{s.company.fiscalYearEnd='2026-02-29';}], ['missing journal array',s=>{delete s.entries;}],
  ['missing activity array',s=>{delete s.activity;}], ['malformed journal array',s=>{s.entries={};}],
  ['duplicated journal id',s=>{const entry=clone(s.entries[0]);entry.number='A2';entry.sourceId='different';s.entries.push(entry);}],
  ['journal number gap',s=>{s.entries[0].number='A2';}], ['wrong journal prefix',s=>{s.entries[0].number='B1';}],
  ['duplicate source pair',s=>{const entry=clone(s.entries[0]);entry.id='entry-unique';entry.number='A2';s.entries.push(entry);}],
  ['journal control character',s=>{s.entries[0].description='Cost\u0000';}], ['blank actor',s=>{s.entries[0].actor=' ';}],
  ['invalid creation timestamp',s=>{s.entries[0].createdAt='2026-02-29T12:00:00Z';}], ['unknown account',s=>{s.entries[0].rows[0].account='9998';}],
  ['fractional booked amount',s=>{s.entries[0].rows[0].debitCents+=0.5;}], ['one-cent journal imbalance',s=>{s.entries[0].rows[0].debitCents++;}],
  ['invalid source identifier',s=>{s.entries[0].sourceId='bad id';}], ['orphan business source',s=>{s.entries[0].sourceType='missing-origin';}],
  ['invalid locked month',s=>{s.lockedPeriods=['2026-13'];}], ['duplicate lock',s=>{s.lockedPeriods=['2026-06','2026-06'];}],
  ['lock outside year',s=>{s.lockedPeriods=['2025-12'];}], ['invalid history timestamp',s=>{s.activity[0].createdAt='not-a-date';}],
  ['unknown reversal original',s=>{s.entries[0].correctsEntryId='missing';}],
]) audit(`restore rejects ${label}`,()=>{
  const original=manual(), before=clone(original), malformed=clone(original);mutate(malformed);
  assert.throws(()=>validateSuiteState(malformed));assert.deepEqual(original,before);
});

// Handwritten SIE tests exercise independent source files, not export->parse only.
for (const [amount,expected] of [['0.01',1],['0.10',10],['1',100],['1.2',120],['1.23',123],['123456.78',12345678],['10000000000.00',MAX_CENTS]]) audit(`SIE handwritten amount ${amount} preserves ${expected} cents`,()=>{
  const state=imported({amount});assert.equal(accountBalance(state,'6570'),expected);assert.equal(accountBalance(state,'1930'),-expected);
  const parsed=parseSie4(exportSie4(state,{generated:'2026-10-23'}));assert.equal(parsed.vouchers[0].rows[0].amountCents,expected);
});
for (const amount of ['0','0.00','-0','1,23','1.234','+1','1e3','NaN','Infinity','10000000000.01']) audit(`SIE rejects invalid transaction amount ${amount}`,()=>{
  atomicReject(createEmptyState(),s=>importSie4(s,source({amount}),{confirmed:true}));
});
for (const [label,replace] of [
  ['missing flag',s=>s.replace('#FLAGGA 0\n','')],['already imported flag',s=>s.replace('#FLAGGA 0','#FLAGGA 1')],
  ['invalid flag',s=>s.replace('#FLAGGA 0','#FLAGGA 2')],['missing program',s=>s.replace('#PROGRAM "Independent audit fixture" "1"\n','')],
  ['missing format',s=>s.replace('#FORMAT PC8\n','')],['unsupported format',s=>s.replace('#FORMAT PC8','#FORMAT UTF8')],
  ['missing generation date',s=>s.replace('#GEN 20261023\n','')],['invalid generation date',s=>s.replace('#GEN 20261023','#GEN 20260229')],
  ['wrong SIE type',s=>s.replace('#SIETYP 4','#SIETYP 3')],['missing SIE type',s=>s.replace('#SIETYP 4\n','')],
  ['missing company name',s=>s.replace('#FNAMN "Åkes Hantverk AB"\n','')],['empty company name',s=>s.replace('Åkes Hantverk AB',' ')],
  ['currency mismatch',s=>s.replace('#VALUTA SEK','#VALUTA EUR')],['year mismatch',s=>s.replace('20260101 20261231','20250101 20251231')],
  ['organisation mismatch',s=>s.replace('#ORGNR "5599999991"','#ORGNR "OTHER"')],['invalid voucher date',s=>s.replace('20260615','20260431')],
  ['voucher outside year',s=>s.replace('20260615','20270101')],['missing brace',s=>s.replace('\n{\n','\n')],
  ['unfinished voucher',s=>s.slice(0,s.lastIndexOf('}'))],['extra closing brace',s=>s+'}\n'],
  ['unknown record',s=>s+'#UNKNOWN 1\n'],['unchecked checksum',s=>s+'#KSUMMA 123\n'],
  ['dimension metadata',s=>s+'#DIM 1 "Avdelning"\n'],['transaction object',s=>s.replace('6570 {}','6570 {1 "A"}')],
  ['transaction different date',s=>s.replace('#TRANS 6570 {} 123.45','#TRANS 6570 {} 123.45 20260616')],
  ['unbalanced voucher',s=>s.replace('-123.45','-123.44')],['NUL input',s=>s+'\u0000'],
  ['duplicated header',s=>s+'#FLAGGA 0\n'],['malformed quoted string',s=>s.replace('"Handskriven avgift"','"Missing end')],
  ['nonnumeric voucher number',s=>s.replace('"B" "1"','"B" "ABC"')],
]) audit(`SIE import rejects ${label} atomically`,()=>atomicReject(createEmptyState(),s=>importSie4(s,replace(source()),{confirmed:true})));

for(const [label,extra] of [
  ['duplicate account','#KONTO 6570 "Avgift"\n#KONTO 6570 "Dublett"\n'],
  ['duplicate year','#RAR 0 20260101 20261231\n'],
  ['invalid year index','#RAR 1 20250101 20251231\n'],
  ['inverted year','#RAR -1 20251231 20250101\n'],
  ['invalid account syntax','#KONTO 123 "Kort"\n'],
  ['income IB','#IB 0 3000 1.00\n'],
  ['balance RES','#RES 0 1930 1.00\n'],
  ['duplicate balance','#IB 0 1930 1.00\n#IB 0 1930 1.00\n'],
  ['unbalanced IB','#IB 0 1930 1.00\n'],
  ['wrong UB','#UB 0 1930 -123.44\n#RES 0 6570 123.45\n'],
]) audit(`SIE rejects ${label}`,()=>atomicReject(createEmptyState(),s=>importSie4(s,source()+extra,{confirmed:true})));

for(const [label,mapping] of [['unknown target',{'6570':'9998'}],['nonaccount key',{'cost':'6570'}],['null mapping',null],['array mapping',[]],['numeric target',{'6570':5010}],['result-closing target',{'6570':'8999'}]]) audit(`SIE rejects mapping ${label}`,()=>atomicReject(createEmptyState(),s=>importSie4(s,source(),{confirmed:true,mapping})));
for(const target of ['5010','5410','6110','6540','6991']) audit(`SIE explicit mapping from external 6999 to ${target} survives restoration`,()=>{
  const text=source({debit:'6999'});const state=checked(importSie4(createEmptyState(),text,{confirmed:true,mapping:{6999:target}}));
  assert.equal(accountBalance(state,target),12345);assert.equal(state.sieImports[0].sourceText,text);
  assert.deepEqual(state.sieImports[0].mapping,{6999:target});checked(JSON.parse(JSON.stringify(state)));
});
for(const account of ['1510','2440','1220','1229','1790','1460','2910','2710','2731','2650','1680']) audit(`SIE imported ${account} reconciles without fabricating an underlying register`,()=>{
  const state=imported({debit:account});assert.equal(accountBalance(state,account),12345);
  assert.equal(state.invoices.length+state.bills.length+state.assets.length+state.payrollRuns.length,0);
  checked(JSON.parse(JSON.stringify(state)));
});
audit('SIE preview leaves state unchanged and requires confirmation before import',()=>{
  const state=createEmptyState(),before=clone(state),preview=previewSieImport(state,source());
  assert.equal(preview.freshCount,1);assert.equal(preview.debitCents,12345);assert.deepEqual(state,before);
  atomicReject(state,s=>importSie4(s,source()),/bekräfta/);
});
audit('exact SIE file cannot be imported twice',()=>atomicReject(imported(),s=>importSie4(s,source(),{confirmed:true}),/redan importerats/));
audit('renamed SIE company does not disguise duplicate voucher identity',()=>atomicReject(imported(),s=>importSie4(s,source().replace('Åkes Hantverk AB','Nytt visningsnamn'),{confirmed:true}),/Alla verifikationer/));
audit('SIE leading zeros in voucher number do not disguise duplicate identity',()=>atomicReject(imported(),s=>importSie4(s,source({number:'0001'}),{confirmed:true}),/Alla verifikationer/));
audit('SIE changed content of existing voucher is rejected',()=>atomicReject(imported(),s=>importSie4(s,source({amount:'123.46'}),{confirmed:true}),/ändrats/));
audit('SIE duplicate and fresh vouchers import only the fresh one',()=>{
  const original=imported();const text=header+voucher()+voucher({number:'2',date:'20260701',amount:'2.01'});
  const preview=previewSieImport(original,text);assert.equal(preview.freshCount,1);assert.equal(preview.duplicateCount,1);
  const state=checked(importSie4(original,text,{confirmed:true}));assert.equal(state.entries.length,2);assert.equal(accountBalance(state,'6570'),12546);
  assert.deepEqual(state.entries[0],original.entries[0]);checked(JSON.parse(JSON.stringify(state)));
});
audit('SIE duplicate voucher number within one file fails atomically',()=>atomicReject(createEmptyState(),s=>importSie4(s,source()+voucher(),{confirmed:true}),/flera gånger/));
audit('SIE different original series preserve both vouchers in local contiguous series',()=>{
  const state=checked(importSie4(createEmptyState(),source()+voucher({series:'C'}),{confirmed:true}));
  assert.deepEqual(state.entries.map(x=>x.number),['A1','A2']);assert.match(state.entries[0].description,/^B1 /);assert.match(state.entries[1].description,/^C1 /);
});
for(const [series,number] of [['','1'],['B',''],['','']]) audit(`anonymous SIE ${JSON.stringify([series,number])} requires separate review`,()=>{
  const state=createEmptyState(),text=source({series,number});assert.equal(previewSieImport(state,text).anonymous,true);
  atomicReject(state,s=>importSie4(s,text,{confirmed:true}),/utan serie/);
  const next=checked(importSie4(state,text,{confirmed:true,anonymousConfirmed:true}));assert.equal(next.entries.length,1);
});
audit('SIE import containing later locked voucher is wholly rejected',()=>{
  const state=checked(lockPeriod(createEmptyState(),'2026-07'));
  atomicReject(state,s=>importSie4(s,source()+voucher({number:'2',date:'20260701'}),{confirmed:true}),/låst/);
});
audit('SIE opening balances import once and are excluded from exported vouchers',()=>{
  const text=header+'#IB 0 1930 1000.01\n#IB 0 2081 -1000.01\n'+voucher();
  const state=checked(importSie4(createEmptyState(),text,{confirmed:true}));
  assert.equal(accountBalance(state,'1930'),87656);assert.equal(accountBalance(state,'2081'),-100001);
  const parsed=parseSie4(exportSie4(state,{generated:'2026-10-23'}));assert.equal(parsed.vouchers.length,1);
  assert.deepEqual(parsed.balances.filter(x=>x.kind==='IB').map(x=>[x.account,x.amountCents]),[['1930',100001],['2081',-100001]]);
});
audit('SIE opening-only import requires reconciling declared closing balances',()=>{
  const text=header+'#IB 0 1930 0.01\n#IB 0 2081 -0.01\n#UB 0 1930 0.01\n#UB 0 2081 -0.01\n';
  const state=checked(importSie4(createEmptyState(),text,{confirmed:true}));assert.equal(state.entries.length,1);assert.equal(accountBalance(state,'1930'),1);
});
audit('SIE opening balance may not be mapped into income',()=>atomicReject(createEmptyState(),s=>importSie4(s,header+'#IB 0 1930 1000.00\n#IB 0 2081 -1000.00\n'+voucher(),{confirmed:true,mapping:{2081:'3000'}}),/balanskonton/));
audit('SIE original result-closing account cannot be bypassed by mapping',()=>atomicReject(createEmptyState(),s=>importSie4(s,source({debit:'8999'}),{confirmed:true,mapping:{8999:'6991'}}),/8999/));

for(const [label,mutate] of [
  ['source text',s=>{s.sieImports[0].sourceText+='\n#PROSA "Changed"';}],
  ['file hash',s=>{s.sieImports[0].fileHash='0'.repeat(64);}], ['target organisation',s=>{s.sieImports[0].targetOrgNumber='OTHER';}],
  ['year',s=>{s.sieImports[0].year.start='2025-01-01';}], ['version',s=>{s.sieImports[0].version=2;}],
  ['missing item',s=>{s.sieImports[0].items=[];}], ['unknown item index',s=>{s.sieImports[0].items[0].index=1;}],
  ['item source key',s=>{s.sieImports[0].items[0].sourceKey='bad';}], ['item hash',s=>{s.sieImports[0].items[0].contentHash='bad';}],
  ['item source id',s=>{s.sieImports[0].items[0].sourceId='bad';}], ['item journal link',s=>{s.sieImports[0].items[0].entryId='missing';}],
  ['balanced imported rows',s=>{s.entries[0].rows=rows(100,'6570');}], ['import journal description',s=>{s.entries[0].description='Changed';}],
  ['import journal date',s=>{s.entries[0].date='2026-06-16';}], ['missing import history',s=>{s.sieImports=[];}],
  ['duplicate import history',s=>{const batch=clone(s.sieImports[0]);batch.id='new-batch';s.sieImports.push(batch);}],
  ['invalid import timestamp',s=>{s.sieImports[0].importedAt='not-a-date';}], ['empty importing actor',s=>{s.sieImports[0].actor=' ';}],
]) audit(`SIE restore rejects changed ${label}`,()=>{
  const state=imported();mutate(state);assert.throws(()=>validateSuiteState(state));
});
for(const [text,expected] of [['','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],['abc','ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],['åäö漢字',null],['x'.repeat(55),null],['x'.repeat(56),null],['x'.repeat(64),null],['x'.repeat(1000),null]]) audit(`SIE fingerprint matches independent SHA-256 for ${JSON.stringify(text.slice(0,12))} length ${text.length}`,()=>assert.equal(sieFingerprint(text),expected??createHash('sha256').update(text).digest('hex')));
for(const [text,bytes] of [['ÅÄÖåäö',[143,142,153,134,132,148]],['éüß',[130,129,225]],['A\\"\r\n',[65,92,34,13,10]],['–—…',[45,45,46,46,46]]]) audit(`SIE PC8 uses independently known bytes ${JSON.stringify(text)}`,()=>assert.deepEqual([...encodeSiePc8(text)],bytes));
for(const text of ['漢字','🙂','€']) audit(`SIE PC8 rejects unrepresentable text ${text}`,()=>assert.throws(()=>encodeSiePc8(text),/PC8/));
audit('SIE UTF-8 BOM is refused under PC8 and supported with explicit encoding',()=>{
  const bytes=new TextEncoder().encode('\uFEFF'+source());assert.throws(()=>parseSie4(bytes),/UTF-8/);
  const parsed=parseSie4(bytes,{encoding:'utf8'});assert.equal(parsed.companyName,'Åkes Hantverk AB');assert.equal(parsed.vouchers[0].rows[0].amountCents,12345);
});
audit('SIE exporter writes CRLF and an independent PC8 company name',()=>{
  const state=manual();const bytes=exportSie4(state,{generated:'2026-10-23'}),text=decodeSie(bytes);
  assert.equal(text.replaceAll('\r\n','').includes('\n'),false);assert.ok(bytes.includes(143));
  assert.match(text,/#FLAGGA 0\r\n/);assert.match(text,/#RAR 0 20260101 20261231\r\n/);
  assert.match(text,/#TRANS 5010 \{\} 123\.45\r\n/);assert.match(text,/#TRANS 1930 \{\} -123\.45\r\n/);
});
audit('SIE exporter rejects an empty fiscal year',()=>assert.throws(()=>exportSie4Text(createEmptyState()),/saknar bokföring/));
audit('SIE exporter rejects unknown fiscal boundaries',()=>assert.throws(()=>exportSie4Text(manual(),{start:'2026-01-02',end:'2026-12-31'}),/registrerat/));

for(const [label,mutate] of [
  ['journal imbalance',s=>{s.entries[0].rows[0].debitCents++;}], ['journal gap',s=>{s.entries[0].number='A3';}],
  ['orphan import',s=>{s.sieImports=[];}], ['changed import original',s=>{s.sieImports[0].sourceText+='\n#PROSA "Changed"';}],
]) audit(`persistent restore preserves invalid bytes and refuses ${label}`,()=>{
  const state=imported();mutate(state);const raw=JSON.stringify(state),values=new Map([[STORAGE_KEY,raw]]);
  const store=createSuiteStorage({getStorage:()=>({getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}),locks:{request:(_name,_options,callback)=>callback({mode:'exclusive'})}});
  const loaded=store.load();assert.equal(loaded.error?.code,'INVALID_DATA');assert.equal(loaded.writable,false);assert.equal(values.get(STORAGE_KEY),raw);
});

for (const sequence of [0,1,2,3]) audit(`restore rejects ID sequence ${sequence} behind existing generated journal or history IDs`,()=>{
  const state=manual();state.sequence=sequence;
  assert.throws(()=>validateSuiteState(state),/ID-serie/);
});
audit('restore accepts an ID sequence equal to the highest generated history ID',()=>{
  const state=manual();assert.equal(state.sequence,4);checked(state);
  const next=manual(state);assert.equal(next.entries[1].number,'A2');assert.notEqual(next.entries[0].id,next.entries[1].id);
});
audit('restore rejects generated journal ID beyond the sequence',()=>{
  const state=manual();state.entries[0].id='entry-5';assert.throws(()=>validateSuiteState(state),/ID-serie/);
});
audit('restore rejects generated history ID beyond safe integer range',()=>{
  const state=manual();state.activity[0].id='activity-9007199254740993';assert.throws(()=>validateSuiteState(state),/ID-serie/);
});

audit('manual non-generated journal and activity identifiers remain restorable',()=>{
  const state=manual();state.entries[0].id='external-entry-20260101';state.activity[0].id='external-history-20260101';
  checked(state);
});
audit('zero-prefixed non-generated identifiers do not impose a generated sequence',()=>{
  const state=manual();state.entries[0].id='entry-00020260101';state.activity[0].id='activity-00020260101';
  checked(state);
});
audit('SIE retained source normalizes CRLF to LF rather than storing original file bytes',()=>{
  const original=source().replaceAll('\n','\r\n');
  const state=checked(importSie4(createEmptyState(),encodeSiePc8(original),{confirmed:true}));
  assert.equal(state.sieImports[0].sourceText,source());assert.notEqual(state.sieImports[0].sourceText,original);
});
audit('SIE newline normalization also detects the same file with changed line endings',()=>{
  atomicReject(imported(),state=>importSie4(state,source().replaceAll('\n','\r\n'),{confirmed:true}),/redan importerats/);
});
audit('SIE active transactions exclude BTRANS and RTRANS and retain them as source text',()=>{
  const text=source().replace('#TRANS 6570 {} 123.45', '#BTRANS 5010 {} 20.00\n#RTRANS 6570 {} 123.45\n#TRANS 6570 {} 123.45');
  const preview=previewSieImport(createEmptyState(),text);assert.equal(preview.parsed.ignoredCorrections,2);
  const state=checked(importSie4(createEmptyState(),text,{confirmed:true}));assert.equal(accountBalance(state,'5010'),0);
  assert.equal(accountBalance(state,'6570'),12345);assert.match(state.sieImports[0].sourceText,/#BTRANS/);
});
audit('SIE quantity is retained in original text with warning but not imported as a ledger quantity',()=>{
  const text=source().replace('#TRANS 6570 {} 123.45','#TRANS 6570 {} 123.45 20260615 "Tio stycken" 10');
  const preview=previewSieImport(createEmptyState(),text);assert.ok(preview.warnings.some(x=>/Kvantiteter/.test(x)));
  const state=checked(importSie4(createEmptyState(),text,{confirmed:true}));assert.equal(accountBalance(state,'6570'),12345);
  assert.equal(state.entries[0].rows[0].quantity,undefined);assert.match(state.sieImports[0].sourceText,/Tio stycken/);
});
audit('SIE missing organisation number gives an explicit ownership warning',()=>{
  const text=source().replace('#ORGNR "5599999991"\n','');
  const preview=previewSieImport(createEmptyState(),text);assert.ok(preview.warnings.some(x=>/saknar organisationsnummer/.test(x)));
  const state=checked(importSie4(createEmptyState(),text,{confirmed:true}));assert.equal(state.entries.length,1);
});
audit('SIE re-export uses the local journal series while retaining the source series in description',()=>{
  const state=imported({series:'ZZ',number:'29'}),parsed=parseSie4(exportSie4(state,{generated:'2026-10-23'}));
  assert.equal(parsed.vouchers[0].series,'A');assert.equal(parsed.vouchers[0].number,'1');assert.match(parsed.vouchers[0].description,/^ZZ29 /);
});
audit('demo attribution is a fixed actor label rather than authenticated user identity',()=>{
  const state=manual();assert.equal(state.entries[0].actor,'Åke');assert.ok(state.activity.every(x=>x.actor==='Åke'));
});
audit('documented storage boundary: a coherently edited manual journal has no independent original to compare',()=>{
  const state=manual();state.entries[0].rows=rows(54321);
  checked(JSON.parse(JSON.stringify(state)));assert.equal(accountBalance(state,'5010'),54321);
});
audit('documented storage boundary: deleting a persisted period lock is not externally detectable',()=>{
  const state=checked(lockPeriod(manual(),'2026-06'));state.lockedPeriods=[];
  checked(JSON.parse(JSON.stringify(state)));assert.equal(state.lockedPeriods.length,0);
});
audit('anonymous source review cannot deduplicate the same business event across changed files',()=>{
  const text=source({series:'',number:''}),options={confirmed:true,anonymousConfirmed:true};
  let state=checked(importSie4(createEmptyState(),text,options));
  state=checked(importSie4(state,text+'#PROSA "New file"\n',options));
  assert.equal(state.entries.length,2);assert.equal(accountBalance(state,'6570'),24690);
});
