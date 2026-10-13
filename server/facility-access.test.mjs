import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialApplicationState } from './application.mjs';
import { createApplicationRepository } from './application-storage.mjs';
import { ensurePersonnel, personnelCommand, personnelProjection } from './personnel.mjs';
import { createMobileEmployeeApi, ensureMobileEmployeeAccounts } from './mobile-employee-api.mjs';
import { migratePersonnelFacilityAccess, syncPersonnelFacilityAccess, personnelFacilityScope } from './facility-access.mjs';

const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }];
const at = new Date('2026-10-13T08:00:00Z');
function fixture() {
  const state = initialApplicationState(); ensurePersonnel(state, sites);
  const admin = state.pricing.users.find(user => user.id === 'admin');
  return { state, principal: { actor: admin, user: admin } };
}
function linked(state, name, personSites, accountSites) {
  const user = { id: `user-${name}`, name, level: 'Medarbetare', active: true, permissions: ['view','prepare'], maxAttest: 0, ownAttest: false,
    ...(accountSites === undefined ? {} : { siteIds: [...accountSites] }) };
  const person = { id: `person-${name}`, userId: user.id, name, kind: 'employee', active: true, role: '', team: '', siteIds: [...personSites],
    phone: '', email: '', address: '', canDrive: false, revision: 0 };
  state.pricing.users.push(user); state.personnel.people.push(person);
  return { user, person };
}

test('legacy linked scopes migrate to their old intersection without a union, fallback, or Systemadmin exception', () => {
  const { state } = fixture();
  const overlap = linked(state,'overlap',['norrtalje'],['norrtalje','rimbo']);
  const disjoint = linked(state,'disjoint',['norrtalje'],['rimbo']);
  const broad = linked(state,'broad',['rimbo'],undefined); broad.user.level = 'Systemadmin';
  migratePersonnelFacilityAccess(state,{siteCatalog:sites,now:at});
  assert.deepEqual(overlap.user.siteIds,['norrtalje']); assert.deepEqual(overlap.person.siteIds,['norrtalje']);
  assert.deepEqual(disjoint.user.siteIds,[]); assert.deepEqual(disjoint.person.siteIds,[]);
  assert.deepEqual(broad.user.siteIds,['rimbo']); assert.deepEqual(broad.person.siteIds,['rimbo']);
  const conflict = state.metadata.facilityAccess.conflicts.find(item=>item.personId===overlap.person.id);
  assert.deepEqual(conflict.previousAccountSiteIds,['norrtalje','rimbo']); assert.deepEqual(conflict.effectiveSiteIds,['norrtalje']);
  assert.equal(state.metadata.facilityAccess.conflicts.find(item=>item.personId===broad.person.id).previousAccountSiteIds,null);
  const snapshot=structuredClone(state); migratePersonnelFacilityAccess(state,{siteCatalog:sites,now:at}); assert.deepEqual(state,snapshot);
});

test('authorised account scope changes materialise once and later migration never reapplies stale personnel restrictions', () => {
  const { state }=fixture(); const { user,person }=linked(state,'expand',['norrtalje'],['norrtalje']);
  migratePersonnelFacilityAccess(state,{siteCatalog:sites,now:at});
  state.employeeTime={clockSessions:[{id:'historic-clock',personId:person.id,siteId:'norrtalje'}]};
  const historic=structuredClone(state.employeeTime);
  user.siteIds=['norrtalje','rimbo']; syncPersonnelFacilityAccess(state,{siteCatalog:sites});
  assert.deepEqual(person.siteIds,user.siteIds); assert.deepEqual(personnelFacilityScope(state,person),user.siteIds);
  person.siteIds=['norrtalje']; migratePersonnelFacilityAccess(state,{siteCatalog:sites,now:at});
  assert.deepEqual(person.siteIds,['norrtalje','rimbo']); assert.deepEqual(user.siteIds,['norrtalje','rimbo']);
  user.siteIds=[]; syncPersonnelFacilityAccess(state,{siteCatalog:sites}); assert.deepEqual(person.siteIds,[]);
  assert.deepEqual(state.employeeTime,historic,'historical clock records are never relocated');
});

test('an explicit unrestricted grant follows the trusted site catalog while missing accounts fail closed', () => {
  const { state }=fixture(); const { user,person }=linked(state,'all',['norrtalje'],['norrtalje']);
  migratePersonnelFacilityAccess(state,{siteCatalog:sites}); delete user.siteIds;
  syncPersonnelFacilityAccess(state,{siteCatalog:sites}); assert.deepEqual(person.siteIds,['norrtalje','rimbo']);
  const expanded=[...sites,{id:'new-site',name:'Ny',active:true}];
  syncPersonnelFacilityAccess(state,{siteCatalog:expanded}); assert.deepEqual(person.siteIds,['norrtalje','rimbo','new-site']);
  state.logistics={sites:[]};syncPersonnelFacilityAccess(state);
  assert.deepEqual(person.siteIds,['norrtalje','rimbo','new-site'],'an empty/partial logistics cache is not the canonical site catalog');
  assert.equal(user.siteIds,undefined); migratePersonnelFacilityAccess(state,{siteCatalog:expanded}); assert.equal(user.siteIds,undefined);
  state.pricing.users=state.pricing.users.filter(item=>item.id!==user.id);
  syncPersonnelFacilityAccess(state,{siteCatalog:expanded}); assert.deepEqual(person.siteIds,[]); assert.deepEqual(personnelFacilityScope(state,person),[]);
});

test('domain-limited read copies without migration metadata use the current account without remigrating old membership', () => {
  const {state}=fixture(); const {person,user}=linked(state,'read',['norrtalje'],['norrtalje']);
  migratePersonnelFacilityAccess(state,{siteCatalog:sites}); user.siteIds=['norrtalje','rimbo'];
  const limited={pricing:structuredClone(state.pricing),personnel:structuredClone(state.personnel),transport:structuredClone(state.transport)};
  ensurePersonnel(limited,sites);
  assert.deepEqual(limited.personnel.people.find(item=>item.id===person.id).siteIds,['norrtalje','rimbo']);
  assert.deepEqual(limited.pricing.users.find(item=>item.id===user.id).siteIds,['norrtalje','rimbo']);
  assert.deepEqual(person.siteIds,['norrtalje'],'read-copy normalisation does not persist changes');
});

test('linked profile saves ignore stale or forged scope fields and new account creation needs an explicit grant', () => {
  const {state,principal}=fixture(); const {person,user}=linked(state,'edit',['norrtalje'],['norrtalje']);
  migratePersonnelFacilityAccess(state,{siteCatalog:sites}); user.siteIds=['norrtalje','rimbo']; syncPersonnelFacilityAccess(state,{siteCatalog:sites});
  personnelCommand(state,principal,{action:'person.save',person:{id:person.id,name:'Ändrat namn',kind:'employee',revision:person.revision,siteIds:['forged-site']}},[],sites);
  assert.deepEqual(state.personnel.people.find(item=>item.id===person.id).siteIds,['norrtalje','rimbo']);
  assert.deepEqual(user.siteIds,['norrtalje','rimbo']);
  assert.throws(()=>personnelCommand(state,principal,{action:'person.save',person:{name:'Implicit',kind:'employee'},createAccount:{kind:'staff'}},[],sites),error=>error.status===422);
  personnelCommand(state,principal,{action:'person.save',person:{id:'explicit',name:'Explicit',kind:'employee'},createAccount:{kind:'staff',siteIds:['rimbo']}},[],sites);
  const created=state.personnel.people.find(item=>item.id==='explicit');
  assert.deepEqual(created.siteIds,['rimbo']); assert.deepEqual(state.pricing.users.find(item=>item.id===created.userId).siteIds,['rimbo']);
  assert.throws(()=>personnelCommand(state,principal,{action:'person.save',person:{id:'explicit',name:'Explicit',kind:'employee'},
    createAccount:{kind:'staff',siteIds:['norrtalje']}},[],sites),error=>error.status===409);
});

test('external credentials own their explicit scope; profile edits cannot grant access and company/driver links stay intact', () => {
  const {state,principal}=fixture(); const person=state.personnel.people.find(item=>item.kind==='external');
  const oldLinks={companyId:person.companyId,driverId:person.driverId};
  assert.throws(()=>personnelCommand(state,principal,{action:'externalAccount.save',personId:person.id,username:'scope.external',active:true,password:'Scope-Example-2026!'},[],sites),error=>error.status===422);
  personnelCommand(state,principal,{action:'externalAccount.save',personId:person.id,username:'scope.external',active:true,password:'Scope-Example-2026!',siteIds:['rimbo']},[],sites);
  assert.deepEqual(state.personnelAuth.accounts.find(item=>item.personId===person.id).siteIds,['rimbo']);
  const current=state.personnel.people.find(item=>item.id===person.id);
  personnelCommand(state,principal,{action:'person.save',person:{...current,siteIds:['norrtalje'],name:'Ändrad extern'}},[],sites);
  const saved=state.personnel.people.find(item=>item.id===person.id);
  assert.deepEqual(saved.siteIds,['rimbo']); assert.deepEqual({companyId:saved.companyId,driverId:saved.driverId},oldLinks);
  assert.equal(JSON.stringify(personnelProjection(state,principal,false,sites)).includes('digest'),false);
});

test('migration review is scoped to dual account administrators and confirming the captured scope grants nothing', () => {
  const {state,principal}=fixture(); const {person}=linked(state,'review',['norrtalje'],['norrtalje','rimbo']);
  migratePersonnelFacilityAccess(state,{siteCatalog:sites,now:at});
  const projection=personnelProjection(state,principal,false,sites),conflict=projection.facilityAccessConflicts.find(item=>item.personId===person.id);
  const weak={id:'weak',name:'Weak',level:'Medarbetare',permissions:['personnelRead'],siteIds:['norrtalje']};
  assert.equal(personnelProjection(state,{actor:weak,user:weak},false,sites).facilityAccessConflicts,undefined);
  const command={action:'facilityAccess.confirm',personId:person.id,conflictId:conflict.id,expectedRevision:person.revision,expectedSiteIds:['norrtalje']};
  assert.throws(()=>personnelCommand(state,{actor:weak,user:principal.user},command,[],sites),error=>error.status===403);
  assert.throws(()=>personnelCommand(state,principal,{...command,expectedSiteIds:['rimbo']},[],sites),error=>error.status===409);
  const before=structuredClone(state.pricing.users);
  personnelCommand(state,principal,command,[],sites); assert.deepEqual(state.pricing.users,before);
  assert.ok(state.metadata.facilityAccess.conflicts.find(item=>item.id===conflict.id).resolvedAt);
  assert.equal(personnelProjection(state,principal,false,sites).facilityAccessConflicts?.some(item=>item.id===conflict.id)??false,false);
});

test('mobile sessions see authorised expansion immediately and cannot retain a revoked active facility', async () => {
  const dir=await mkdtemp(join(tmpdir(),'jeroc-facility-scope-'));
  const env={JEROC_APPLICATION_DB_PATH:join(dir,'application.sqlite')};
  const repository=await createApplicationRepository({env,initial:initialApplicationState});
  await repository.transact(state=>{ensureMobileEmployeeAccounts(state);migratePersonnelFacilityAccess(state,{siteCatalog:sites});});
  const api=createMobileEmployeeApi({env,getRepository:async()=>repository,siteProvider:async()=>sites,now:()=>at,
    readBody:async req=>{let value='';for await(const chunk of req)value+=chunk;return JSON.parse(value);},
    json:(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}});
  const server=createServer((req,res)=>void api(req,res,new URL(req.url,'http://localhost')));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let cookie;
  const request=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/employee/${path}`,{
    method:body?'POST':'GET',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
    cookie=response.headers.get('set-cookie')?.split(';')[0]??cookie;return {status:response.status,...await response.json()};};
  try {
    const login=await request('login?view=bootstrap',{username:'niklas',password:'Demo123!'});assert.equal(login.status,200,login.error);
    await repository.transact(state=>{state.pricing.users.find(user=>user.id==='mobile-demo').siteIds=['norrtalje','rimbo'];syncPersonnelFacilityAccess(state,{siteCatalog:sites});});
    const expanded=await request('session?view=bootstrap');assert.deepEqual(expanded.sites.map(site=>site.id),['norrtalje','rimbo']);
    const selected=await request('active-site?view=bootstrap',{siteId:'rimbo'});assert.equal(selected.activeSiteId,'rimbo');
    await repository.transact(state=>{state.pricing.users.find(user=>user.id==='mobile-demo').siteIds=['norrtalje'];syncPersonnelFacilityAccess(state,{siteCatalog:sites});});
    const revoked=await request('session?view=bootstrap');assert.equal(revoked.activeSiteId,'norrtalje');assert.deepEqual(revoked.person.siteIds,['norrtalje']);
    assert.equal((await request('active-site',{siteId:'rimbo'})).status,403);
    await repository.transact(state=>{state.pricing.users.find(user=>user.id==='mobile-demo').siteIds=[];syncPersonnelFacilityAccess(state,{siteCatalog:sites});});
    const empty=await request('session?view=bootstrap');assert.equal(empty.activeSiteId,undefined);assert.deepEqual(empty.sites,[]);assert.deepEqual(empty.person.siteIds,[]);
  } finally {await new Promise(resolve=>server.close(resolve));await repository.close();await rm(dir,{recursive:true,force:true});}
});
