// One-time DEMO migration, not a backup/restore or production-auth tool.
import {readFile,writeFile,chmod} from 'node:fs/promises';
const [action,source,file]=process.argv.slice(2);
if(!['capture','apply'].includes(action)||!source||!file)throw new Error('Använd: node scripts/migrate-live-pricing.mjs capture|apply https://server /sökväg/original.json');
const base=new URL(source);if(base.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(base.hostname))throw new Error('Använd HTTPS.');
const headers={'X-Demo-Actor':'admin','X-Demo-User':'admin'};
async function request(path,payload) {const r=await fetch(new URL(path,base),{method:payload?'POST':'GET',headers:{...headers,...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error??`HTTP ${r.status}`);return data;}
if(action==='capture') {
 const state=await request('/api/pricing/state'),snapshots=(await request('/api/pricing/snapshots')).snapshots,outbox=(await request('/api/transport/outbox')).entries;
 const verify=await request('/api/pricing/state');
 if(verify.revision!==state.revision)throw new Error('Prisregistret ändrades under exporten. Försök igen innan driftsättning.');
 const fields=['revision','lme','articleHistory','customerPrices','users','customers','ledger','audit'];
 await writeFile(file,JSON.stringify({pricing:{...Object.fromEntries(fields.map(k=>[k,state[k]])),snapshots},outbox}),{mode:0o600});await chmod(file,0o600);
 console.log(`Original sparat: ${state.articleHistory.length} artikelversioner, ${snapshots.length} snapshot, ${outbox.length} utkorgsposter.`);
} else {await request('/api/application/import-pricing',JSON.parse(await readFile(file,'utf8')));console.log('Engångsimport bekräftad. Inga externa leveranser aktiverade.');}
