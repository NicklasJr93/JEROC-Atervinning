import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createTerminalDemoRepository } from './terminal-demo-storage.mjs';
import { createTerminalDemoStore, createTerminalDemoApi } from './terminal-demo.mjs';
import { createPricingStore } from './pricing.mjs';
import { createChangeEvents } from './change-events.mjs';

const customer={id:'customer-build',name:'Terminal Test AB',type:'Företag',number:'556000-0167',customerNumber:'TEST-1',phone:'',email:'',paymentProfile:{method:'cash'}};
const backends=['SQLite',...(process.env.JEROC_TEST_DATABASE_URL?['PostgreSQL']:[])];
async function fixture(backend,run) {
  const directory=await mkdtemp(join(tmpdir(),'jeroc-terminal-performance-'));
  let adminPool,schema,options={env:{},filename:join(directory,'terminal.sqlite')};
  if(backend==='PostgreSQL'){
    const {Pool}=await import('pg');adminPool=new Pool({connectionString:process.env.JEROC_TEST_DATABASE_URL});
    schema=`terminal_performance_${randomUUID().replaceAll('-','')}`;await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.JEROC_TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);options={env:{DATABASE_URL:url.toString()}};
  }
  let repo=await createTerminalDemoRepository(options),time=Date.parse('2026-10-10T08:00:00Z');
  const now=()=>new Date(time),pricing=createPricingStore({now});
  const sites=[{id:'norrtalje',name:'Norrtälje',active:true,address:'Originalgatan 1',postalCode:'76141',city:'Norrtälje'}];
  const makeStore=()=>createTerminalDemoStore({repository:repo,principalStore:pricing,siteProvider:()=>sites,now});
  let store=makeStore();
  const admin=(await store.staffSession({actualUserId:'admin',effectiveUserId:'admin'})).token;
  const staff=(await store.staffSession({actualUserId:'kajsa',effectiveUserId:'kajsa'})).token;
  const terminal=await store.createTerminal({name:'Testterminal',username:'testterminal',password:'terminal-password',siteId:'norrtalje'},admin);
  const device=(await store.login({username:'testterminal',password:'terminal-password'})).token;
  const payload=cardId=>{
    const locked=pricing.snapshot({cardId,customerId:customer.id,deliveredAt:now().toISOString(),rows:[{articleId:'copper-1',weight:10}]},pricing.principal('kajsa'));
    const rows=locked.rows.map(row=>({articleId:row.articleId,weight:row.weight,price:row.price,tier:row.tier==='Special'?'Eget':row.tier}));
    return {card:{id:cardId,sourceId:`test-${cardId}`,siteId:'norrtalje',customerId:customer.id,status:'complement',yard:'Norrtälje',date:now().toISOString(),reference:'',origin:'Originalgatan 1',pricingSnapshotId:locked.id,rows,audit:[]},customer,terminalId:terminal.id,siteId:'norrtalje',rows:rows.map(row=>({...row,name:'Koppar',amount:Math.round(row.weight*row.price*100)/100})),offset:0,correctionIds:[],idempotencyKey:`performance-${cardId}`};
  };
  // Settlement rows are a strict API shape, without the card-only tier.
  const request=cardId=>{const value=payload(cardId);value.rows=value.rows.map(({tier,...row})=>row);return value;};
  try {await run({get repo(){return repo;},get store(){return store;},options,pricing,sites,now,admin,staff,terminal,device,request,advance:ms=>{time+=ms;},restart:async()=>{store.close();await repo.close();repo=await createTerminalDemoRepository(options);store=makeStore();}});}
  finally {store.close();await repo.close();if(adminPool){await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);await adminPool.end();}await rm(directory,{recursive:true,force:true});}
}

for(const backend of backends){
  test(`${backend}: state, device and card projections are read-only; presence is throttled and separate`,()=>fixture(backend,async f=>{
    const sent=await f.store.send(f.request(4100),f.staff);
    const before=await f.repo.read(state=>structuredClone(state));
    let writes=0;const transact=f.repo.transact;f.repo.transact=(...args)=>{writes++;return transact(...args);};
    for(let index=0;index<20;index++){
      assert.equal((await f.store.session(f.device)).approval.id,sent.id);
      assert.equal((await f.store.read(f.staff)).approvals[0].id,sent.id);
      assert.equal((await f.store.projections(4100)).length,1);
      assert.equal((await f.store.projections(4101)).length,0);
    }
    assert.equal(writes,0,'No SELECT FOR UPDATE path may be used for projections');
    const after=await f.repo.read(state=>structuredClone(state));assert.deepEqual(after,before);
    f.advance(11000);await f.store.heartbeat(f.device);
    const presence=await f.repo.read(state=>structuredClone(state));
    assert.equal(presence.revision,before.revision);assert.deepEqual(presence.audit,before.audit);
    assert.notEqual(presence.terminals[0].lastSeen,before.terminals[0].lastSeen);
    f.advance(1000);await f.store.heartbeat(f.device);
    assert.equal((await f.repo.read(state=>state.terminals[0].lastSeen)),presence.terminals[0].lastSeen);
    assert.equal(writes,0);
  }));

  test(`${backend}: displayed acknowledgement belongs to exact device/version/hash and is idempotent`,()=>fixture(backend,async f=>{
    const sent=await f.store.send(f.request(4200),f.staff);
    assert.equal(sent.displayedAt,undefined);
    await assert.rejects(f.store.displayed(sent.id,{version:sent.version+1,snapshotHash:sent.snapshot.hash},f.device),error=>error.code==='stale_approval');
    await assert.rejects(f.store.displayed(sent.id,{version:sent.version,snapshotHash:'0'.repeat(64)},f.device),error=>error.code==='stale_approval');
    const displayed=await f.store.displayed(sent.id,{version:sent.version,snapshotHash:sent.snapshot.hash},f.device);
    assert.equal(displayed.displayedAt,f.now().toISOString());assert.ok(displayed.revision>sent.revision);
    f.advance(1000);
    assert.deepEqual(await f.store.displayed(sent.id,{version:sent.version,snapshotHash:sent.snapshot.hash},f.device),displayed);
    assert.equal((await f.repo.read(state=>state.audit.filter(entry=>entry.action==='approval.displayed').length)),1);
    assert.equal((await f.repo.documentJobs()).length,1,'Display acknowledgement must not enqueue another original');
  }));

  test(`${backend}: PDF jobs roll back atomically, survive restart, preserve immutable site/approval and fence stale leases`,()=>fixture(backend,async f=>{
    await assert.rejects(f.repo.transact(state=>{state.approvals.push({id:'rollback',status:'waiting',snapshot:{hash:'0'.repeat(64)}});throw new Error('rollback');}));
    assert.deepEqual(await f.repo.documentJobs(),[]);
    const sent=await f.store.send(f.request(4300),f.staff);
    f.sites[0].address='Changedgatan 2';
    await f.store.respond(sent.id,{action:'id_requested',termsAccepted:true},f.device);
    await f.store.confirmId(sent.id,f.staff);
    await f.store.cancel(sent.id,f.staff);
    assert.equal((await f.repo.documentJobs()).length,2);
    await f.restart();
    const first=await f.repo.claimDocumentJob(f.now().toISOString(),1000);
    assert.equal(first.stage,'preliminary');assert.equal(first.siteSnapshot.address,'Originalgatan 1');assert.equal(first.approval.status,'waiting');
    f.advance(2000);const replacement=await f.repo.claimDocumentJob(f.now().toISOString(),1000);
    assert.equal(replacement.id,first.id);assert.notEqual(replacement.claimToken,first.claimToken);
    await f.repo.finishDocumentJob(first,undefined,f.now().toISOString());
    assert.equal((await f.repo.documentJobs()).find(job=>job.id===first.id).status,'running','Expired worker must not mark a new lease complete');
    await f.repo.finishDocumentJob(replacement,undefined,f.now().toISOString());
    const reviewed=await f.repo.claimDocumentJob(f.now().toISOString());assert.equal(reviewed.stage,'reviewed');assert.equal(reviewed.approval.status,'approved');assert.equal(reviewed.approval.approvedHash,reviewed.sourceHash);assert.equal(reviewed.siteSnapshot.address,'Originalgatan 1');
    await f.repo.finishDocumentJob(reviewed,new Error('retry'),f.now().toISOString());
    assert.equal(await f.repo.claimDocumentJob(f.now().toISOString()),undefined);
    f.advance(10000);const retry=await f.repo.claimDocumentJob(f.now().toISOString());assert.equal(retry.id,reviewed.id);
    await f.repo.finishDocumentJob(retry,undefined,f.now().toISOString());
    await f.restart();assert.ok((await f.repo.documentJobs()).every(job=>job.status==='completed'));assert.equal(await f.repo.claimDocumentJob(f.now().toISOString()),undefined);
  }));
}

test('staff SSE sends an authenticated baseline and committed invalidations immediately; identity mismatch cannot mutate',()=>fixture('SQLite',async f=>{
  const api=createTerminalDemoApi({repository:f.repo,principalStore:f.pricing,siteProvider:()=>f.sites,now:f.now,env:{}});
  const server=createServer(async(req,res)=>{await api(req,res,new URL(req.url,'http://localhost'));});server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}/api/terminal-demo`;
  const controller=new AbortController();let reader;
  try{
    const auth=await fetch(origin+'/staff-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actualUserId:'admin',effectiveUserId:'admin'})});const cookie=auth.headers.get('set-cookie').split(';')[0];await auth.json();
    const mismatch=await fetch(origin+'/terminals',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-Terminal-Actual-User':'kajsa','X-Terminal-Effective-User':'kajsa'},body:JSON.stringify({name:'Forbidden',username:'forbidden',password:'terminal-password',siteId:'norrtalje'})});
    assert.equal(mismatch.status,409);assert.equal((await mismatch.json()).code,'staff_identity_changed');
    const response=await fetch(origin+'/events',{headers:{Cookie:cookie,'X-Terminal-Actual-User':'admin','X-Terminal-Effective-User':'admin'},signal:controller.signal});reader=response.body.getReader();
    const decoder=new TextDecoder();let accumulated='';
    const readUntil=async pattern=>{while(!pattern.test(accumulated)){const result=await reader.read();if(result.done)throw new Error('SSE ended');accumulated+=decoder.decode(result.value,{stream:true});}return accumulated;};
    const baseline=await readUntil(/event: state/);assert.match(baseline,/id: [a-f0-9-]+/);assert.match(baseline,/"actualUserId":"admin"/);
    accumulated='';const sent=await f.store.send(f.request(4400),f.staff);
    const changed=await readUntil(new RegExp(sent.id));assert.match(changed,/event: change/);assert.match(changed,/"domain":"terminal"/);assert.match(changed,/"effectiveUserId":"admin"/);
    assert.equal((await f.repo.read(state=>state.terminals.length)),1,'Mismatched UI identity created no terminal');
  }finally{controller.abort();await reader?.cancel().catch(()=>{});server.closeAllConnections();server.close();await once(server,'close');await api.close();}
}));

if(process.env.JEROC_TEST_DATABASE_URL)test('PostgreSQL LISTEN/NOTIFY reaches an independent hub only after commit with no customer data',()=>fixture('PostgreSQL',async f=>{
  const other=createChangeEvents({env:f.options.env,namespace:randomUUID()});
  const received=[];const unsubscribe=other.subscribe(event=>received.push(event));await other.ready();
  try{
    const next=new Promise(resolve=>{const remove=other.subscribe(event=>{if(event.domain==='terminal'){remove();resolve(event);}});});
    const sent=await f.store.send(f.request(4500),f.staff);const event=await next;
    assert.equal(event.revision,sent.revision);assert.deepEqual(Object.keys(event).sort(),['domain','eventId','revision']);
    const count=received.length;await assert.rejects(f.repo.transact(state=>{state.revision++;throw new Error('rollback');}));
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(received.length,count);
  }finally{unsubscribe();await other.close();}
}));

for(const backend of backends)test(`${backend}: compound send requires the same staff cookie/expected identity inside its write transaction`,()=>fixture(backend,async f=>{
  const api=createTerminalDemoApi({repository:f.repo,principalStore:f.pricing,siteProvider:()=>f.sites,now:f.now,env:f.options.env});
  const identity={actorId:'kajsa',userId:'kajsa'},payload=f.request(4600);
  try{
    await assert.rejects(api.sendPrepared(payload,identity,{headers:{}}),error=>error.code==='staff_session_required');
    await assert.rejects(api.sendPrepared(payload,identity,{headers:{cookie:`jeroc_terminal_demo_staff=${f.admin}`}}),error=>error.code==='staff_identity_changed');
    await assert.rejects(api.sendPrepared(payload,identity,{headers:{cookie:`jeroc_terminal_demo_staff=${f.staff}`,'x-terminal-actual-user':'anna','x-terminal-effective-user':'anna'}}),error=>error.code==='staff_identity_changed');
    assert.deepEqual(await f.repo.documentJobs(),[]);
    const sent=await api.sendPrepared(payload,identity,{headers:{cookie:`jeroc_terminal_demo_staff=${f.staff}`,'x-terminal-actual-user':'kajsa','x-terminal-effective-user':'kajsa'}});
    assert.equal(sent.snapshot.card.preparedBy,'kajsa');assert.equal((await f.repo.documentJobs()).length,1);
  }finally{await api.close();}
}));

if(process.env.JEROC_TEST_DATABASE_URL)test('PostgreSQL terminal projections do not wait behind an uncommitted terminal writer',()=>fixture('PostgreSQL',async f=>{
  let unlock,entered;const gate=new Promise(resolve=>{unlock=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  const before=await f.repo.read(state=>state.revision);
  const write=f.repo.transact(async state=>{state.revision++;entered();await gate;});
  await ready;
  try{
    const snapshot=await Promise.race([f.store.read(f.staff),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Read waited for terminal writer')),1000);timer.unref();})]);
    assert.equal(snapshot.revision,before);
  }finally{unlock();await write;}
}));

test('presence expiry invalidates online state at 35 seconds and releases stale customer display at 90 seconds', {timeout:5000},async t=>fixture('SQLite',async f=>{
  const sent=await f.store.send(f.request(4700),f.staff),events=[];
  const unsubscribe=f.repo.events.subscribe(event=>events.push(event));
  t.mock.timers.enable({apis:['setTimeout']});
  try{
    await f.store.heartbeat(f.device);events.length=0;
    f.advance(35001);t.mock.timers.tick(35001);
    assert.ok(events.some(event=>event.domain==='terminal-presence'));
    assert.equal((await f.store.read(f.staff)).terminals[0].online,false);
    assert.equal((await f.store.session(f.device)).approval.id,sent.id,'Display remains until safe disconnect limit');
    const released=new Promise(resolve=>{const remove=f.repo.events.subscribe(event=>{if(event.domain==='terminal'){remove();resolve();}});});
    f.advance(55000);t.mock.timers.tick(55000);await released;
    assert.equal((await f.store.session(f.device)).approval,null);
    assert.equal((await f.repo.read(state=>state.approvals.find(approval=>approval.id===sent.id).status)),'expired');
  }finally{unsubscribe();t.mock.timers.reset();}
}));
