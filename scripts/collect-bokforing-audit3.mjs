import {readFileSync,writeFileSync,mkdirSync,existsSync,statSync} from 'node:fs';
import {relative,join} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const [casePath,tapPath,reportPath,directory,startPath]=process.argv.slice(2);
if(!startPath)throw new Error('Usage: node scripts/collect-bokforing-audit3.mjs cases.jsonl results.tap report.json output-dir started.txt');
const rows=readFileSync(casePath,'utf8').trim().split('\n').map(JSON.parse),raw=readFileSync(tapPath),tap=raw.toString();
const totals=Object.fromEntries([...tap.matchAll(/^# (tests|pass|fail|skipped|todo|cancelled) (\d+)$/gm)].map(([,key,n])=>[key,Number(n)]));
if(totals.tests!==rows.length||totals.pass!==rows.length||['fail','skipped','todo','cancelled'].some(key=>totals[key]!==0)||rows.some(row=>row.status!=='passed'||row.skip||row.todo))throw new Error('Final evidence must contain a complete successful run.');
const file=row=>relative(process.cwd(),row.file??'');
const groups=[['sales','SALES'],['purchase-fx','PURFX'],['payroll','PAY'],['vat','VAT'],['ledger-year','YEAR']];
const added=rows.filter(row=>/^server\/bokforing-audit3-/.test(file(row)));
if(added.length!==1000||rows.length-added.length!==2451)throw new Error('Expected 1000 new cases and all2451 prior cases.');
const files=[];
for(const [stem,prefix] of groups){
 const path=`server/bokforing-audit3-${stem}.test.mjs`,items=added.filter(row=>file(row)===path);
 const ids=items.map(row=>/^AUDIT3-[A-Z]+-\d{3}/.exec(row.name)?.[0]).sort();
 const expected=Array.from({length:200},(_,i)=>`AUDIT3-${prefix}-${String(i+1).padStart(3,'0')}`);
 if(JSON.stringify(ids)!==JSON.stringify(expected))throw new Error(`Missing/duplicate IDs for ${path}`);
 files.push({file:path,passed:items.length});
}
const report=existsSync(reportPath)?JSON.parse(readFileSync(reportPath,'utf8')):{};
Object.assign(report,{title:'Tredje testomgången: 1 000 nya kombinationsfall',baseline:'78801b8',baselineTestCount:2451,
 tests:{newPassed:1000,totalPassed:rows.length,failed:0,skipped:0,cancelled:0,startedAt:readFileSync(startPath,'utf8').trim(),finishedAt:statSync(tapPath).mtime.toISOString(),durationMs:Number(/^# duration_ms ([\d.]+)$/m.exec(tap)?.[1]),logSha256:createHash('sha256').update(raw).digest('hex')},testFiles:files});
const cell=v=>'"'+String(v??'').replace(/^[=+\-@\t\r]/,"'$&").replaceAll('"','""')+'"';
const csv=[['Fall-ID','Testnamn','Status','Nytt fall','Testfil','Rad']];
for(const row of rows){const name=file(row),id=/^((?:AUDIT3|AUDIT|REVIEW2)-[A-Z]+-\d{3})/.exec(row.name)?.[1]??`CHECK-${createHash('sha256').update(name+'\n'+row.line+'\n'+row.name).digest('hex').slice(0,12)}`;csv.push([id,row.name,'Godkänt',added.includes(row)?'Ja':'Nej',name,row.line]);}
if(new Set(csv.slice(1).map(row=>row[0])).size!==rows.length)throw new Error('Duplicate evidence identifiers.');
mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'testresultat-audit3.csv'),'\uFEFF'+csv.map(row=>row.map(cell).join(';')).join('\r\n')+'\r\n');writeFileSync(join(directory,'testlogg-audit3.tap.gz'),gzipSync(raw));writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({total:rows.length,newCases:1000,files,failed:0}));
