import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { createPricingStore } from './pricing.mjs';
import { createApplicationRepository } from './application-storage.mjs';
import { createCorrectionDraft, submitCorrection, approveCorrection, recordPayment } from '../dist-server/domain-models.mjs';
const office='/api/application/office', mobile='/api/application/mobile', transport='/api/application/transport';
async function fixture(run) {
 const dir=await mkdtemp(join(tmpdir(),'jeroc-application-')); let pool,schema;
 let env={JEROC_APPLICATION_DB_PATH:join(dir,'business.sqlite')};
 if(process.env.JEROC_TEST_DATABASE_URL){const {Pool}=await import('pg');pool=new Pool({connectionString:process.env.JEROC_TEST_DATABASE_URL});schema='jeroc_application_'+randomUUID().replaceAll('-','');await pool.query(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.JEROC_TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);env={DATABASE_URL:url.toString()};}
 const apps=[],servers=[],repos=[];
 async function instance() {
  const app=createApplicationService({env});apps.push(app);const server=createServer((req,res)=>void app(req,res,new URL(req.url,'http://localhost')));servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return async(path,data,actor='admin',user=actor)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:data?'POST':'GET',headers:{'content-type':'application/json','x-demo-actor':actor,'x-demo-user':user,'x-demo-mobile':'niklas'},body:data?JSON.stringify(data):undefined});return {status:response.status,...await response.json()};};
 }
 async function repository(){const repo=await createApplicationRepository({env,initial:initialApplicationState});repos.push(repo);return repo;}
 try{await run({a:await instance(),instance,repository,pool,schema});}
 finally{for(const server of servers)await new Promise(resolve=>server.close(resolve));for(const app of apps)await app.close();for(const repo of repos)await repo.close();if(pool){await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await pool.end();}await rm(dir,{recursive:true,force:true});}
}
const post=async(a,path,base,next,actor='admin')=>{const r=await a(path,{base,next},actor);assert.equal(r.status,200,r.error);return r;};
test('two offices merge different fields and reject a stale competing edit',async()=>fixture(async({a,instance})=>{
 const b=await instance(),base=(await a(office)).data,first=structuredClone(base),second=structuredClone(base);
 first.cards[0].origin='Testgatan 1';second.cards[1].reference='Kassa 2';await Promise.all([post(a,office,base,first),post(b,office,base,second)]);
 const saved=(await b(office)).data;assert.equal(saved.cards[0].origin,'Testgatan 1');assert.equal(saved.cards[1].reference,'Kassa 2');
 const stale=structuredClone(base);stale.cards[0].origin='Annan adress';assert.equal((await b(office,{base,next:stale})).status,409);await post(a,office,base,first);
}));
test('mobile submission survives a new instance and produces exactly one numbered office card',async()=>fixture(async({a,instance})=>{
 const base=(await a(mobile)).data,next=structuredClone(base),id=randomUUID(),customer={...next.customers[0],id:randomUUID(),name:'Mobilverkstaden'};next.customers.push(customer);
 next.drafts.push({id,number:1418,mode:'direct',status:'ready',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),reference:'Mobil',origin:'Testgatan 2',customerId:customer.id,rows:[{id:randomUUID(),articleId:'lead-battery',method:'direct',weight:12}]});
 await post(a,mobile,base,next);await post(a,mobile,base,next);const b=await instance(),data=(await b(office)).data,cards=data.cards.filter(card=>card.sourceId===id);
 assert.equal(cards.length,1);assert.ok(cards[0].id>2053);assert.equal(cards[0].rows[0].weight,12);assert.equal(cards[0].status,'new');assert.ok(data.customers.some(c=>c.id===customer.id));
 const saved=(await b(mobile)).data;assert.equal(saved.drafts[0].number,cards[0].id);const edit=structuredClone(saved);edit.drafts[0].rows[0].weight=13;assert.equal((await b(mobile,{base:saved,next:edit})).status,409);
}));
test('pricing and revoked permissions remain authoritative across instances',async()=>fixture(async({a,instance})=>{
 const users=(await a('/api/pricing/state')).users.map(user=>user.id==='kajsa'?{...user,permissions:['view'],siteIds:['rimbo']}:user);assert.equal((await a('/api/pricing/users',{users})).status,200);
 const b=await instance(),restricted=await b(office,undefined,'kajsa');assert.equal(restricted.status,200);assert.ok(restricted.data.cards.every(card=>(card.siteId??(card.yard==='Rimbo'?'rimbo':'norrtalje'))==='rimbo'));
 const base=(await b(office)).data,next=structuredClone(base);next.users=next.users.map(user=>user.id==='kajsa'?{...user,level:'Systemadmin'}:user);await post(b,office,base,next);assert.equal((await b('/api/pricing/state',undefined,'kajsa')).users.length,0);
 const article={...(await a('/api/pricing/state')).articles[0],base:{type:'manual',price:123}};delete article.prices;assert.equal((await a('/api/pricing/articles',article)).status,200);assert.equal((await b('/api/pricing/state')).articles.find(row=>row.id===article.id).baseSekKg,123);
}));
test('browser supplied approval, attest and paid status cannot skip server workflow',async()=>fixture(async({a})=>{
 const base=(await a(office)).data;
 for(const status of ['attest','ready','paid']){const next=structuredClone(base);next.cards[0].status=status;assert.equal((await a(office,{base,next})).status,409);}
 const next=structuredClone(base);next.cards[0].customerApproval={id:randomUUID(),version:1,status:'approved',updatedAt:new Date().toISOString()};assert.equal((await a(office,{base,next})).status,409);
}));
test('transport and disabled outbox persist and reject duplicate event identities',async()=>fixture(async({a,instance})=>{
 const base=(await a(transport)).data,next=structuredClone(base);next.orders[0].notes='Gemensam planering';await post(a,transport,base,next);const b=await instance();assert.equal((await b(transport)).data.orders[0].notes,'Gemensam planering');
 const event={id:randomUUID(),type:'work_order.updated',orderId:next.orders[0].id,at:new Date().toISOString(),bookingVersion:0,customer:{name:'Testkund'},actor:'Systemadmin',actualUserId:'admin',effectiveUserId:'admin'};
 assert.equal((await a('/api/transport/outbox',{events:[event]})).status,200);const box=await b('/api/transport/outbox');assert.equal(box.memoryOnly,false);assert.equal(box.deliveryEnabled,false);assert.equal(box.entries.length,1);assert.equal((await b('/api/transport/outbox',{events:[event]})).duplicates,1);
 assert.equal((await b('/api/transport/outbox',{events:[{...event,reason:'Annat innehåll'}]})).status,409);
}));
test('legacy originals are archived once and unverified payment states never replay',async()=>fixture(async({a,repository,pool,schema})=>{
 const data=(await a(office)).data;data.cards[0].origin='Äldre testadress';data.cards[1].status='paid';data.cards.push({...structuredClone(data.cards[2]),id:9999,sourceId:randomUUID(),status:'new',idVerified:false});
 const result=await a(office,{kind:'import',data});assert.equal(result.status,200,result.error);assert.equal(result.data.cards[0].origin,'Äldre testadress');assert.notEqual(result.data.cards[1].status,'paid');assert.ok(result.data.cards.some(card=>card.id===9999));assert.equal((await a(office,{kind:'import',data})).status,200);
 const state=await (await repository()).transact(state=>structuredClone(state));assert.equal(state.imports.length,1);assert.equal(state.imports[0].original.cards[1].status,'paid');
 if(pool)assert.equal((await pool.query(`SELECT data FROM "${schema}".jeroc_application_imports`)).rows.length,1);
}));
test('Render refuses a missing PostgreSQL configuration',async()=>{
 await assert.rejects(()=>createApplicationRepository({env:{RENDER:'true'},initial:initialApplicationState}),error=>error.status===503);
});
test('one-time migration preserves LME and mobile price catalog without dispatch',async()=>fixture(async({a,instance})=>{
 const legacy=createPricingStore(),admin=legacy.principal('admin');legacy.saveLme({metal:'copper',cashUsdPerTonne:12000,usdSek:10,effectiveFrom:'2026-10-01'},admin);const payload={pricing:legacy.exportState(),outbox:[]};
 assert.equal((await a('/api/application/import-pricing',payload)).status,200);assert.equal((await a('/api/application/import-pricing',payload)).status,200);
 const b=await instance();assert.ok((await b('/api/pricing/state')).lme.some(rate=>rate.cashUsdPerTonne===12000));assert.equal((await b(mobile)).catalog.find(article=>article.id==='copper-1').prices[0],98.4);
 const other=structuredClone(payload);other.pricing.revision++;assert.equal((await b('/api/application/import-pricing',other)).status,409);
}));
test('positive correction and manual saldo payment preserve the original and cannot replay',async()=>fixture(async({a,repository})=>{
 await (await repository()).transact(state=>{
  const pricing=createPricingStore({initialState:state.pricing}),snapshot=pricing.snapshot({cardId:'2050',customerId:'customer-build',deliveredAt:'2026-10-09',rows:[{articleId:'copper-1',weight:12}]},pricing.principal('kajsa'));
  Object.assign(state.office.cards[0],{customerId:'customer-build',status:'balance',idVerified:true,approvedBy:'anna',origin:'Testgatan 1',pricingSnapshotId:snapshot.id,pricingTotal:snapshot.total,paymentDetails:{method:'balance'},rows:snapshot.rows.map(row=>({articleId:row.articleId,weight:row.weight,tier:'Eget',price:row.price})),audit:[]});state.pricing=pricing.exportState();
 });
 const first=(await a(office)).data,kajsa=first.users.find(user=>user.id==='kajsa'),anna=first.users.find(user=>user.id==='anna');
 const draft=createCorrectionDraft(first,{cardId:2050,articleId:'copper-1',weightDelta:2,reason:'Extra mängd',document:'Viktprotokoll'},{user:kajsa,now:'2026-10-09T11:00:00Z'});await post(a,office,first,draft,'kajsa');
 const second=(await a(office)).data,correction=second.corrections.at(-1),submitted=submitCorrection(second,correction.id,{user:kajsa});await post(a,office,second,submitted,'kajsa');
 const receipt=await a('/api/pricing/approved-corrections',{sourceSnapshotId:submitted.cards[0].pricingSnapshotId,cardId:correction.serverId,rows:[{articleId:'copper-1',weightDelta:2}],reason:correction.reason,correctedAt:correction.at,creatorId:'kajsa',submittedBy:'kajsa',document:correction.document},'anna');assert.equal(receipt.status,201);
 const before=(await a(office)).data,approved=approveCorrection(before,correction.id,{user:anna});await post(a,office,before,approved,'anna');const ready=(await a(office)).data,card=ready.cards.find(card=>card.sourceCorrectionId===correction.id);assert.equal(card.status,'ready');assert.equal(card.rows[0].weight,2);assert.equal(ready.cards[0].status,'balance');
 const paid=recordPayment(ready,2050,{user:anna},{method:'cash',recipient:'Test'},'Manuell test');await post(a,office,ready,paid,'anna');await post(a,office,ready,paid,'anna');assert.equal((await a(office)).data.payments.filter(pay=>pay.cardId===2050).length,1);
}));
test('restricted preparer adds a material without receiving or overwriting hidden prices',async()=>fixture(async({a})=>{
 const users=(await a('/api/pricing/state')).users.map(user=>user.id==='kajsa'?{...user,permissions:['view','prepare','weighingAddArticle']}:user);assert.equal((await a('/api/pricing/users',{users})).status,200);
 const base=(await a(office,undefined,'kajsa')).data;assert.ok(base.cards.every(card=>card.rows.every(row=>row.price===0)));assert.ok(base.customers.every(customer=>!customer.paymentProfile));const next=structuredClone(base);next.cards[0].rows.push({articleId:'iron',weight:5,price:0,tier:'C',pricePending:true});
 await post(a,office,base,next,'kajsa');const saved=(await a(office)).data.cards[0];assert.equal(saved.rows.length,next.cards[0].rows.length);assert.ok(saved.rows[0].price>0);assert.equal(saved.rows.at(-1).weight,5);
}));

test('a read-only office can archive old local data without gaining write privileges or blocking login',async()=>fixture(async({a})=>{
 const legacy=(await a(office)).data;legacy.cards[0].origin='Unprivileged import';
 const result=await a(office,{kind:'import',data:legacy},'anna');assert.equal(result.status,200,result.error);assert.ok(result.importConflicts>0);
 assert.notEqual((await a(office)).data.cards[0].origin,'Unprivileged import');
 const next=structuredClone(result.data);next.cards[0].origin='Forbidden update';assert.equal((await a(office,{base:result.data,next},'anna')).status,403);
}));
