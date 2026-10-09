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

test('person and staff account are created together, survive restart and retry without duplicates',async()=>fixture(async({a,instance})=>{
  const id=`person-${randomUUID()}`,command={action:'person.save',person:{id,name:'Ny medarbetare',kind:'employee',siteIds:['norrtalje']},createAccount:{kind:'staff'}};
  const created=await a(personnel,command);assert.equal(created.status,200,created.error);
  const person=created.data.people.find(person=>person.id===id),account=created.users.find(user=>user.id===person.userId);
  assert.ok(account);assert.equal(account.level,'Medarbetare');assert.deepEqual(account.permissions,['view']);assert.equal(account.maxAttest,0);assert.equal(account.ownAttest,false);assert.equal(account.active,true);assert.deepEqual(account.siteIds,['norrtalje']);
  const office=await a('/api/application/office');assert.deepEqual(office.data.users.find(user=>user.id===account.id),account);
  const retried=await (await instance())(personnel,command);assert.equal(retried.status,200,retried.error);assert.equal(retried.data.people.filter(p=>p.id===id).length,1);assert.equal(retried.users.filter(u=>u.id===account.id).length,1);assert.equal(retried.data.revision,created.data.revision);
  assert.equal((await a('/api/pricing/state',undefined,account.id)).status,200);
}));

test('person without login and linking existing user preserve existing identities and reject duplicate or mixed accounts',async()=>fixture(async({a})=>{
  const users=(await a('/api/pricing/state')).users;
  const noAccount=await a(personnel,{action:'person.save',person:{id:`person-${randomUUID()}`,name:'Utan inloggning',kind:'employee',siteIds:['norrtalje']}});
  assert.equal(noAccount.status,200,noAccount.error);assert.equal(noAccount.users.length,users.length);assert.ok(!noAccount.data.people.find(p=>p.name==='Utan inloggning').userId);
  const id=`person-${randomUUID()}`,linked=await a(personnel,{action:'person.save',person:{id,name:'Befintlig användare',kind:'employee',siteIds:['norrtalje'],userId:'kajsa'}});
  assert.equal(linked.status,200,linked.error);assert.equal(linked.data.people.find(p=>p.id===id).userId,'kajsa');assert.equal(linked.users.length,users.length);
  const duplicateId=`person-${randomUUID()}`,duplicate=await a(personnel,{action:'person.save',person:{id:duplicateId,name:'Dubbelkoppling',kind:'employee',siteIds:['norrtalje'],userId:'kajsa'}});assert.equal(duplicate.status,422);assert.ok(!(await a(personnel)).data.people.some(p=>p.id===duplicateId));
  for(const command of [
    {person:{name:'Både nytt och gammalt',kind:'employee',userId:'lars'},createAccount:{kind:'staff'}},
    {person:{name:'Fel kontotyp',kind:'employee'},createAccount:{kind:'external',username:'fel.konto',password:'Secret-Test-2026!'}},
    {person:{name:'Extern med personalinloggning',kind:'external',companyId:'carrier-roslagen',userId:'lars'}},
  ])assert.equal((await a(personnel,{action:'person.save',...command})).status,422);
}));

test('account creation rolls back profile and catalogs on invalid grants or driver validation',async()=>fixture(async({a})=>{
  const before=await a(personnel),beforePricing=await a('/api/pricing/state');
  const commands=[
    {person:{id:`person-${randomUUID()}`,name:'Fel behörigheter',kind:'employee'},createAccount:{kind:'staff',permissions:['salaryWrite']}},
    {person:{id:`person-${randomUUID()}`,name:'Fel fordon',kind:'employee',canDrive:true,vehicleId:'does-not-exist'},createAccount:{kind:'staff'}},
  ];
  for(const command of commands){const result=await a(personnel,{action:'person.save',...command});assert.ok(result.status>=400,result.error);}
  const after=await a(personnel);assert.deepEqual(after.data,before.data);assert.deepEqual(after.users,before.users);assert.deepEqual(after.transport,before.transport);assert.deepEqual((await a('/api/pricing/state')).users,beforePricing.users);
}));

test('scoped VD cannot create systemadmin, excessive attest or cross-site accounts; staff users right cannot escalate',async()=>fixture(async({a})=>{
  let users=(await a('/api/pricing/state')).users.map(u=>u.id==='lars'?{...u,siteIds:['norrtalje'],maxAttest:1000}:u.id==='kajsa'?{...u,siteIds:['norrtalje'],permissions:['personnelRead','personnelWrite','users']}:u);
  assert.equal((await a('/api/pricing/users',{users})).status,200);
  const rejected=[
    {person:{name:'Otillåten systemadmin',kind:'employee',siteIds:['norrtalje']},createAccount:{kind:'staff',level:'Systemadmin'}},
    {person:{name:'Otillåten attestgräns',kind:'employee',siteIds:['norrtalje']},createAccount:{kind:'staff',maxAttest:1001}},
    {person:{name:'Otillåten anläggning',kind:'employee',siteIds:['rimbo']},createAccount:{kind:'staff'}},
    {person:{name:'Otillåten systemadminkoppling',kind:'employee',siteIds:['norrtalje'],userId:'admin'}},
  ];
  for(const command of rejected)assert.equal((await a(personnel,{action:'person.save',...command},'lars')).status,403);
  const employee=await a(personnel,undefined,'kajsa');assert.ok(!employee.capabilities.includes('users'));assert.ok(!employee.users);
  assert.equal((await a(personnel,{action:'person.save',person:{name:'Försök från medarbetare',kind:'employee',siteIds:['norrtalje']},createAccount:{kind:'staff'}},'kajsa')).status,403);
  const vdCreated=await a(personnel,{action:'person.save',person:{name:'Tillåtet VD-konto',kind:'employee',siteIds:['norrtalje']},createAccount:{kind:'staff',level:'VD',maxAttest:1000}},'lars');assert.equal(vdCreated.status,200,vdCreated.error);
  assert.ok(vdCreated.users.every(u=>u.siteIds && u.siteIds.every(id=>id==='norrtalje')));
}));

test('external person and hashed login are atomic and unchanged retry preserves active session',async()=>fixture(async({a,repository,instance})=>{
  const id=`person-${randomUUID()}`,command={action:'person.save',person:{id,name:'Ny extern chaufför',kind:'external',siteIds:['norrtalje'],companyId:'carrier-roslagen',canDrive:true,vehicleId:'vehicle-oskar'},createAccount:{kind:'external',username:'new.external',password:'External-Test-2026!'}};
  const created=await a(personnel,command);assert.equal(created.status,200,created.error);assert.ok(created.data.externalAccounts.some(a=>a.personId===id && a.username==='new.external'));assert.ok(!created.data.people.find(p=>p.id===id).userId);
  const repo=await repository(),auth=await repo.transact(s=>structuredClone(s.personnelAuth));assert.ok(auth.accounts.find(a=>a.personId===id).password.digest);assert.ok(!JSON.stringify(auth).includes(command.createAccount.password));assert.ok(!JSON.stringify(created).includes('digest'));
  const login=await a('/api/driver/login',{username:'new.external',password:command.createAccount.password});assert.equal(login.status,200,login.error);const cookie=login.cookie.split(';')[0];
  const retried=await (await instance())(personnel,command);assert.equal(retried.status,200,retried.error);assert.equal(retried.data.revision,created.data.revision);assert.equal((await a('/api/driver/session',undefined,null,cookie)).status,200);
  const duplicate=await a(personnel,{...command,person:{...command.person,id:`person-${randomUUID()}`,name:'Dubbel extern'}});assert.equal(duplicate.status,422);assert.ok(!(await a(personnel)).data.people.some(p=>p.name==='Dubbel extern'));
  const mixed=await a(personnel,{action:'person.save',person:{...retried.data.people.find(p=>p.id===id),kind:'employee'}});assert.equal(mixed.status,422);
  const reset=await a(personnel,{action:'externalAccount.save',personId:id,username:'new.external',active:true,password:'Changed-Test-2026!'});assert.equal(reset.status,200,reset.error);assert.equal((await a('/api/driver/session',undefined,null,cookie)).status,401);
  assert.equal((await a(personnel,undefined,null,cookie)).status,401);
}));

test('blocked staff accounts cannot act or be impersonated and omitted active field preserves block',async()=>fixture(async({a})=>{
  const created=await a(personnel,{action:'person.save',person:{name:'Spärrbar användare',kind:'employee',siteIds:['norrtalje']},createAccount:{kind:'staff'}}),user=created.users.find(u=>u.name==='Spärrbar användare');
  assert.equal(created.status,200,created.error);
  let users=(await a('/api/pricing/state')).users.map(u=>u.id===user.id?{...u,active:false}:u);
  assert.equal((await a('/api/pricing/users',{users})).status,200);
  assert.equal((await a('/api/pricing/state',undefined,user.id)).status,401);
  users=users.map(({active,...u})=>u);assert.equal((await a('/api/pricing/users',{users})).status,200);assert.equal((await a('/api/pricing/state')).users.find(u=>u.id===user.id).active,false);
  users=(await a('/api/pricing/state')).users.map(u=>u.id==='admin'?{...u,active:false}:u);assert.ok((await a('/api/pricing/users',{users})).status>=400);
  const store=createPricingStore();const current=store.exportState().users;store.saveUsers({users:current.map(u=>u.id==='kajsa'?{...u,active:false}:u)},store.principal('admin'));assert.throws(()=>store.principal('admin','kajsa'),/giltigt demokonto/);
}));

test('blocking the first systemadmin preserves office, mobile prices and transport through another active admin',async()=>fixture(async({a})=>{
  const first=(await a('/api/pricing/state')).users;
  const second={...first.find(u=>u.id==='admin'),id:'second-admin',name:'Andra administratören',active:true};
  assert.equal((await a('/api/pricing/users',{users:[...first,second]})).status,200);
  const users=(await a('/api/pricing/state',undefined,second.id)).users.map(u=>u.id==='admin'?{...u,active:false}:u);
  assert.equal((await a('/api/pricing/users',{users},second.id)).status,200);
  assert.equal((await a('/api/application/office')).status,401);
  for(const path of ['/api/application/office','/api/application/mobile','/api/application/transport']) {
    const response=await a(path,undefined,second.id);
    assert.equal(response.status,200,response.error);
    if(path.endsWith('/mobile'))assert.ok(response.catalog.some(article=>article.id==='copper-1'));
  }
}));
