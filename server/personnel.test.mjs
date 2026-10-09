import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplicationService,initialApplicationState} from './application.mjs';
import {createApplicationRepository} from './application-storage.mjs';
import {createPricingStore} from './pricing.mjs';
import {applyTransportChange} from '../dist-server/domain-models.mjs';

const personnel='/api/application/personnel',transport='/api/application/transport';
async function fixture(run) {
  const dir=await mkdtemp(join(tmpdir(),'jeroc-personnel-'));let env={JEROC_APPLICATION_DB_PATH:join(dir,'business.sqlite')},pool,schema;
  if(process.env.JEROC_TEST_DATABASE_URL){const {Pool}=await import('pg');pool=new Pool({connectionString:process.env.JEROC_TEST_DATABASE_URL});schema='jeroc_personnel_'+randomUUID().replaceAll('-','');await pool.query(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.JEROC_TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);env={DATABASE_URL:url.toString()};}
  const apps=[],servers=[],repos=[];
  async function instance(){const app=createApplicationService({env});apps.push(app);const server=createServer((req,res)=>void app(req,res,new URL(req.url,'http://localhost')));servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;return async(path,data,actor='admin',cookie)=>{const response=await fetch(base+path,{method:data?'POST':'GET',headers:{'content-type':'application/json',...(actor?{'x-demo-actor':actor,'x-demo-user':actor}:{}),...(cookie?{cookie}:{})},body:data?JSON.stringify(data):undefined});return {status:response.status,cookie:response.headers.get('set-cookie'),...await response.json()};};}
  async function repository(){const repo=await createApplicationRepository({env,initial:initialApplicationState});repos.push(repo);return repo;}
  try{await run({a:await instance(),instance,repository});}finally{for(const server of servers)await new Promise(resolve=>server.close(resolve));for(const app of apps)await app.close();for(const repo of repos)await repo.close();if(pool){await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await pool.end();}await rm(dir,{recursive:true,force:true});}
}
async function absenceInput(a){const state=await a(personnel),order=state.transport.orders.find(o=>o.id==='AO-1201');return {id:randomUUID(),personId:'person-kalle',kind:'sick',fromDate:order.date,toDate:order.date,allDay:true,managerId:'person-anna'};}
test('personnel migration preserves bookings and durable records survive a second instance',async()=>fixture(async({a,instance,repository})=>{
  const repo=await repository(),before=await repo.transact(s=>structuredClone(s.transport.orders));const first=await a(personnel);assert.equal(first.status,200,first.error);for(const order of before)assert.deepEqual(first.transport.orders.find(o=>o.id===order.id),order);
  const kalle=first.data.people.find(p=>p.id==='person-kalle');const saved=await a(personnel,{action:'person.save',person:{...kalle,phone:'070-123 44 55'}});assert.equal(saved.status,200,saved.error);
  const second=await (await instance())(personnel);assert.equal(second.data.people.find(p=>p.id===kalle.id).phone,'070-123 44 55');assert.equal(second.transport.orders.filter(o=>/^AO-120[123]$/.test(o.id)).length,3);
}));
test('salary and absence reasons require explicit VD rights and planning never leaks sensitive data',async()=>fixture(async({a})=>{
  const admin=await a(personnel);assert.ok(admin.data.salaries.length);const users=(await a('/api/pricing/state')).users.map(u=>u.id==='lars'?{...u,permissions:u.permissions.filter(p=>!['salaryRead','salaryWrite','absenceRead','absenceWrite'].includes(p))}:u);assert.equal((await a('/api/pricing/users',{users})).status,200);
  const vd=await a(personnel,undefined,'lars');assert.deepEqual(vd.data.salaries,[]);assert.ok(vd.data.absences.every(a=>!('kind'in a) && !('createdBy'in a)));assert.equal((await a(personnel,{action:'salary.save',salary:admin.data.salaries[0]},'lars')).status,403);
  const planning=await a(personnel+'?view=planning',undefined,'kajsa');assert.equal(planning.status,200,planning.error);assert.equal(planning.data.employment.length,0);assert.equal(planning.data.salaries.length,0);assert.ok(planning.data.people.every(p=>!p.userId && !p.phone && !p.email && !p.address));assert.ok(planning.data.absences.every(a=>!a.kind));
}));
test('absence creates staffing tasks without deleting bookings; eligible replacement atomically updates orders and outbox',async()=>fixture(async({a})=>{
  const input=await absenceInput(a),before=(await a(personnel)).transport;
  const preview=await a(personnel,{action:'absence.preview',absence:input});assert.equal(preview.preview.affectedOrders.length,3);
  const registered=await a(personnel,{action:'absence.save',absence:input});assert.equal(registered.status,200,registered.error);const tasks=registered.data.staffingTasks.filter(t=>t.personId===input.personId && t.status==='open');assert.equal(tasks.length,3);for(const task of tasks)assert.deepEqual(registered.transport.orders.find(o=>o.id===task.orderId),before.orders.find(o=>o.id===task.orderId));
  const repeated=await a(personnel,{action:'absence.save',absence:input});assert.equal(repeated.status,200);assert.equal(repeated.data.absences.filter(a=>a.id===input.id).length,1);assert.equal(repeated.data.staffingTasks.filter(t=>t.absenceId===input.id).length,3);
  const ids=tasks.map(t=>t.id),candidates=await a(personnel,{action:'replacement.preview',taskIds:ids});assert.ok(candidates.preview.candidates.find(p=>p.personId==='person-lina').available);assert.ok(!candidates.preview.candidates.find(p=>p.personId==='person-johan').available);
  const rejected=await a(personnel,{action:'staffing.assign',taskIds:ids,replacementPersonId:'person-johan'});assert.equal(rejected.status,422);
  const assigned=await a(personnel,{action:'staffing.assign',taskIds:ids,replacementPersonId:'person-lina'});assert.equal(assigned.status,200,assigned.error);for(const task of tasks){const old=before.orders.find(o=>o.id===task.orderId),order=assigned.transport.orders.find(o=>o.id===task.orderId);assert.equal(order.driverId,'lina');assert.equal(order.customerName,old.customerName);assert.equal(order.date,old.date);assert.equal(order.startMinute,old.startMinute);assert.equal(order.durationMinutes,old.durationMinutes);}
  assert.ok(assigned.data.absences.some(a=>a.personId===input.personId && a.status==='registered'));assert.equal(assigned.data.staffingTasks.filter(t=>ids.includes(t.id) && t.status==='resolved').length,3);assert.equal((await a('/api/transport/outbox')).entries.filter(e=>ids.some(id=>assigned.data.staffingTasks.find(t=>t.id===id)?.orderId===e.event.orderId)).length,3);
}));
test('new bookings reject absence and competence conflicts but existing notes remain editable',async()=>fixture(async({a})=>{
  const input=await absenceInput(a);assert.equal((await a(personnel,{action:'absence.save',absence:input})).status,200);
  let base=(await a(transport)).data,next=structuredClone(base);next.orders.find(o=>o.id==='AO-1201').notes='Frånvarobokningen behålls.';assert.equal((await a(transport,{base,next})).status,200);
  base=(await a(transport)).data;next=structuredClone(base);Object.assign(next.orders.find(o=>o.id==='AO-1043'),{status:'booked',date:input.fromDate,startMinute:900,driverId:'kalle',vehicleId:'vehicle-kalle'});assert.equal((await a(transport,{base,next})).status,409);
  base=(await a(transport)).data;next=structuredClone(base);Object.assign(next.orders.find(o=>o.id==='AO-1043'),{status:'booked',date:input.fromDate,startMinute:900,driverId:'johan',vehicleId:'vehicle-service',requiredCompetencies:['license:CE']});assert.equal((await a(transport,{base,next})).status,409);
  base=(await a(transport)).data;next=structuredClone(base);next.preliminary['AO-1043']={date:input.fromDate,startMinute:900,durationMinutes:60,driverId:'kalle',vehicleId:'vehicle-kalle'};assert.equal((await a(transport,{base,next})).status,409);
}));
test('record revision checks prevent lost updates and rejects cross-person row reassignment',async()=>fixture(async({a})=>{
  const first=await a(personnel),schedule=first.data.schedules.find(s=>s.personId==='person-kalle');assert.equal((await a(personnel,{action:'schedule.save',schedule:{...schedule,endMinute:975}})).status,200);assert.equal((await a(personnel,{action:'schedule.save',schedule:{...schedule,endMinute:990}})).status,409);
  const competency=first.data.competencies[0];assert.equal((await a(personnel,{action:'competency.save',competency:{...competency,personId:'person-lina'}})).status,422);
}));
test('external accounts hash credentials, restrict assigned orders and revoke sessions on password reset',async()=>fixture(async({a,repository})=>{
  assert.equal((await a(personnel,{action:'externalAccount.save',personId:'person-oskar',username:'Oskar.Extern',active:true,password:'TestPassword-2026!'})).status,200);
  const repo=await repository(),auth=await repo.transact(s=>structuredClone(s.personnelAuth));assert.ok(auth.accounts[0].password.digest);assert.ok(!JSON.stringify(auth).includes('TestPassword-2026!'));assert.ok(!JSON.stringify((await a(personnel)).data.externalAccounts).includes('digest'));
  assert.equal((await a('/api/driver/login',{username:'oskar.extern',password:'wrong'})).status,401);const login=await a('/api/driver/login',{username:'oskar.extern',password:'TestPassword-2026!'});assert.equal(login.status,200,login.error);assert.ok(login.cookie.includes('HttpOnly'));const cookie=login.cookie.split(';')[0];
  const orders=await a('/api/driver/orders',undefined,'admin',cookie);assert.equal(orders.status,200);assert.ok(orders.orders.every(o=>o.driverId==='oskar'));assert.ok(orders.orders.every(o=>o.audit.length===0));assert.equal((await a('/api/driver/orders/AO-1201/status',{status:'on_way'},'admin',cookie)).status,403);
  assert.equal((await a(personnel,undefined,null,cookie)).status,401);
  const order=orders.orders.find(o=>o.status==='booked');
  // Calendar demo bookings follow today's date; the account/status test needs
  // an explicit eligible weekday, including when the suite runs on a weekend.
  const base=(await a(transport)).data,next=applyTransportChange(base,{type:'reschedule',id:order.id,plan:{date:'2026-10-09',startMinute:540,durationMinutes:order.durationMinutes,driverId:order.driverId,vehicleId:order.vehicleId}},
    {canPlan:true,actor:'Systemadmin',actualUserId:'admin',effectiveUserId:'admin'});
  const planned=await a(transport,{base,next});assert.equal(planned.status,200,planned.error);
  assert.equal((await a(`/api/driver/orders/${order.id}/status`,{status:'done'},'admin',cookie)).status,409);assert.equal((await a(`/api/driver/orders/${order.id}/status`,{status:'on_way'},'admin',cookie)).status,200);assert.equal((await a(`/api/driver/orders/${order.id}/status`,{status:'done'},'admin',cookie)).status,200);
  assert.equal((await a(personnel,{action:'externalAccount.save',personId:'person-oskar',username:'oskar.extern',active:false})).status,200);assert.equal((await a('/api/driver/session',undefined,'admin',cookie)).status,401);
}));
test('facility-scoped personnel rights cannot read or mutate another site or private payroll',async()=>fixture(async({a})=>{
  const admin=await a(personnel),users=(await a('/api/pricing/state')).users.map(u=>u.id==='kajsa'?{...u,siteIds:['rimbo'],permissions:['personnelRead','personnelWrite','salaryRead','salaryWrite','absenceRead','absenceWrite','transportRead']}:u);assert.equal((await a('/api/pricing/users',{users})).status,200);
  const scoped=await a(personnel,undefined,'kajsa');assert.equal(scoped.status,200);assert.ok(scoped.data.people.every(p=>p.siteIds.includes('rimbo')));assert.equal(scoped.data.salaries.length,0);assert.equal((await a(personnel,{action:'salary.save',salary:admin.data.salaries[0]},'kajsa')).status,403);
  assert.equal((await a(personnel,{action:'person.save',person:{name:'Otillåten profil',kind:'employee',siteIds:['norrtalje']}},'kajsa')).status,403);
  assert.equal((await a(personnel,{action:'absence.save',absence:{personId:'person-johan',kind:'leave',fromDate:'2026-10-13',toDate:'2026-10-13',allDay:true}},'kajsa')).status,200);
}));
test('HR write grants require matching reads without implicitly granting sensitive VD rights',()=>{
  const store=createPricingStore(),admin=store.principal('admin'),users=store.exportState().users;
  assert.throws(()=>store.saveUsers({users:users.map(u=>u.id==='lars'?{...u,permissions:['salaryWrite']}:u)},admin),/salaryRead/);
  assert.throws(()=>store.saveUsers({users:users.map(u=>u.id==='kajsa'?{...u,permissions:['salaryRead','salaryWrite']}:u)},admin),/personnelRead/);
  store.saveUsers({users:users.map(u=>u.id==='kajsa'?{...u,permissions:['personnelRead','salaryRead','salaryWrite']}:u.id==='lars'?{...u,permissions:[]}:u)},admin);
  const saved=store.exportState().users;assert.deepEqual(saved.find(u=>u.id==='kajsa').permissions,['personnelRead','salaryRead','salaryWrite']);assert.ok(!saved.find(u=>u.id==='lars').permissions.some(p=>['salaryRead','salaryWrite','absenceRead','absenceWrite'].includes(p)));
});
