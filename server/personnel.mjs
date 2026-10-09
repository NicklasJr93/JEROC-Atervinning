import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { PricingError, createPricingStore } from './pricing.mjs';
import { createTransportOutbox } from './transport-integrations.mjs';
import { personSchema, companySchema, employmentSchema, salarySchema, scheduleSchema, absenceSchema, competencySchema, personnelPlanIssues, applyTransportChange, transportSchema } from '../dist-server/domain-models.mjs';

export const personnelRights=['personnelRead','personnelWrite','employmentRead','employmentWrite','salaryRead','salaryWrite','absenceRead','absenceWrite','competenciesWrite','staffingWrite','externalAccounts'];
const privateRights=['salaryRead','salaryWrite','absenceRead','absenceWrite'];
export const personnelCan=(principal,right)=>principal.user.level==='Systemadmin' || (privateRights.includes(right) ? principal.user.permissions.includes(right) : right==='users' ? principal.user.level!=='Medarbetare' : principal.user.level!=='Medarbetare' || principal.user.permissions.includes(right));
const fail=(message,status=409)=>{throw new PricingError(message,status);};
const demand=(p,right)=>{if(!personnelCan(p,right))fail('Du saknar behörighet för detta personalmoment.',403);};
const clone=value=>structuredClone(value);
const stamp=()=>new Date().toISOString();
const uid=prefix=>`${prefix}-${randomUUID()}`;
const dateNow=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Stockholm',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const visible=(p,person)=>!p.user.siteIds || person.siteIds.some(id=>p.user.siteIds.includes(id));
const hash=value=>createHash('sha256').update(value).digest('hex');
function passwordHash(password) {const salt=randomBytes(24).toString('hex');return {salt,digest:scryptSync(password,salt,64).toString('hex')};}
function passwordValid(password,stored) {if(!stored)return false;const actual=scryptSync(password,stored.salt,64),expected=Buffer.from(stored.digest,'hex');return actual.length===expected.length && timingSafeEqual(actual,expected);}
const actorOf=p=>({canPlan:true,actor:p.user.name,actualUserId:p.actor.id,effectiveUserId:p.user.id});
function audit(state,p,action,personId,text,transactionAudit) {
  const row={id:uid('hr-log'),action,personId,at:stamp(),actualUserId:p.actor.id,effectiveUserId:p.user.id,text};
  state.personnel.audit.push(row);transactionAudit.push({...row,domain:'personnel'});state.personnel.revision++;
}
function checkPerson(state,p,id) {
  const person=state.personnel.people.find(item=>item.id===id);
  if(!person)fail('Personen finns inte längre.',404);
  if(!visible(p,person))fail('Du saknar åtkomst till personens anläggning.',403);
  return person;
}
function parse(schema,value) {const result=schema.safeParse(value);if(!result.success)fail(result.error.issues.map(issue=>issue.message).join(' '),422);return result.data;}
function saveRecord(rows,value,key='id') {
  const index=rows.findIndex(old=>old[key]===value[key]),old=rows[index];
  if(old?.personId && old.personId!==value.personId)fail('En befintlig post kan inte flyttas till en annan person.',422);
  if(old && value.revision!==old.revision)fail('Uppgiften ändrades i en annan session. Ladda om och försök igen.');
  const saved={...value,revision:(old?.revision??0)+1};if(index<0)rows.push(saved);else rows[index]=saved;
  return saved;
}
function employmentPerson(state,p,id) {const person=checkPerson(state,p,id);if(person.kind!=='employee')fail('Anställning och lön registreras bara för JEROC:s anställda.',422);return person;}

function saveExternalAccount(state,p,person,input,transactionAudit) {
  demand(p,'externalAccounts');
  if(person.kind!=='external' || !person.companyId || !person.driverId)fail('Kontot kräver extern person med åkeri och förarprofil.',422);
  const username=parse(z.string().trim().toLowerCase().min(3).max(80).regex(/^[a-z0-9._-]+$/),input.username),active=parse(z.boolean(),input.active),old=state.personnelAuth.accounts.find(a=>a.personId===person.id);
  if(active && !person.active)fail('Aktivera personprofilen innan chaufförskontot aktiveras.',422);
  if(state.personnelAuth.accounts.some(a=>a.personId!==person.id && a.username===username))fail('Inloggningsnamnet används redan.',422);
  if(!old && !input.password)fail('Ange ett lösenord för det nya kontot.',422);
  const password=input.password===undefined?old?.password:passwordHash(parse(z.string().min(10).max(200),input.password));
  const account={personId:person.id,username,active,createdAt:old?.createdAt??stamp(),updatedAt:stamp(),lastLoginAt:old?.lastLoginAt,password};
  state.personnelAuth.accounts=state.personnelAuth.accounts.filter(a=>a.personId!==person.id).concat(account);state.personnelAuth.sessions=state.personnelAuth.sessions.filter(s=>s.personId!==person.id);
  state.personnel.externalAccounts=state.personnelAuth.accounts.map(({password,...a})=>a);
  audit(state,p,'externalAccount.saved',person.id,'Externt konto sparat. Tidigare sessioner har avslutats.',transactionAudit);
}
function staffCreation(state,p,person,input) {
  demand(p,'users');
  const account={id:person.userId??`staff-${hash(person.id).slice(0,32)}`,name:person.name,level:input.level??'Medarbetare',permissions:input.permissions??['view'],maxAttest:input.maxAttest??0,ownAttest:input.ownAttest??false,siteIds:person.siteIds,active:person.active};
  if(!person.userId && state.pricing.users.some(user=>user.id===account.id))fail('Kontot finns redan. Koppla det befintliga kontot i stället.',422);
  const pricing=createPricingStore({initialState:state.pricing});
  pricing.saveUsers({users:state.pricing.users.filter(u=>u.id!==account.id).concat(account)},p);
  return {pricing:pricing.exportState(),account:pricing.exportState().users.find(u=>u.id===account.id)};
}
const withoutRevision=({revision,...person})=>person;

/** Add the new durable domain once. All existing user, driver, order and booking
 * identities remain unchanged. Fictional example jobs are new records only. */
export function ensurePersonnel(state) {
  if(state.personnel)return;
  const defaults={kind:'employee',active:true,team:'Transport',siteIds:['norrtalje'],phone:'070-000 00 00',email:'',address:'',canDrive:false,revision:0};
  const people=[
    {...defaults,id:'person-kalle',name:'Kalle Nilsson',role:'Chaufför',employeeNumber:'P-0012',managerId:'person-anna',driverId:'kalle',vehicleId:'vehicle-kalle',canDrive:true},
    {...defaults,id:'person-lina',name:'Lina Eriksson',role:'Chaufför',employeeNumber:'P-0013',managerId:'person-anna',driverId:'lina',vehicleId:'vehicle-lina',canDrive:true},
    {...defaults,id:'person-johan',name:'Johan Svensson',role:'Chaufför',siteIds:['rimbo'],employeeNumber:'P-0014',managerId:'person-anna',driverId:'johan',vehicleId:'vehicle-service',canDrive:true},
    {...defaults,id:'person-anna',name:state.pricing.users.find(u=>u.id==='anna')?.name??'Anna Berg',role:'Gruppledare',employeeNumber:'P-0004',userId:state.pricing.users.some(u=>u.id==='anna')?'anna':undefined},
    {...defaults,id:'person-oskar',name:'Oskar Lind',kind:'external',role:'Chaufför',team:'Externa åkare',companyId:'carrier-roslagen',driverId:'oskar',vehicleId:'vehicle-oskar',canDrive:true,email:'oskar@roslagensakeri.example'},
    {...defaults,id:'person-maria',name:'Maria Johansson',role:'Chaufför / invägare',team:'Gårdsplan',employeeNumber:'P-0021',driverId:'maria',vehicleId:'vehicle-maria',canDrive:true},
  ].filter(p=>!p.driverId || ['lina','johan'].includes(p.driverId) || state.transport.drivers.some(d=>d.id===p.driverId));
  // Existing customized transport drivers also receive a stable person link.
  for(const d of state.transport.drivers)if(!people.some(p=>p.driverId===d.id))people.push({...defaults,id:`person-${d.id}`,name:d.name,role:'Chaufför',driverId:d.id,vehicleId:d.vehicleId,canDrive:true});
  const schedules=people.map(p=>({id:`schedule-${p.id}`,personId:p.id,weekdays:[1,2,3,4,5],startMinute:420,endMinute:960,lunchStart:720,lunchEnd:780,effectiveFrom:'2026-01-01',revision:0}));
  const competencies=people.filter(p=>p.canDrive).flatMap(p=>[
    {id:`competency-license-${p.id}`,personId:p.id,type:'license',name:'Körkort C / CE',codes:p.id==='person-johan'?['C']:['C','CE'],scope:'Tung lastbil',validFrom:'2026-01-01',validTo:'2030-05-14',verified:true,verifiedBy:'admin',verifiedAt:'2026-10-01T07:00:00Z',revision:0},
    {id:`competency-ykb-${p.id}`,personId:p.id,type:'ykb',name:'YKB',codes:['goods'],scope:'Godstransporter',validFrom:'2026-01-01',validTo:'2028-02-28',verified:true,verifiedBy:'admin',verifiedAt:'2026-10-01T07:00:00Z',revision:0},
    ...(p.id!=='person-johan'?[{id:`competency-adr-${p.id}`,personId:p.id,type:'adr',name:'ADR',codes:['packages'],scope:'Grundkurs / styckegods',validFrom:'2026-01-01',validTo:'2026-11-30',verified:true,verifiedBy:'admin',verifiedAt:'2026-10-01T07:00:00Z',revision:0}]:[]),
  ]);
  if(people.some(p=>p.id==='person-kalle'))competencies.push({id:'competency-truck-person-kalle',personId:'person-kalle',type:'employer',name:'Truck · körtillstånd',codes:['truck-B1'],scope:'B1 · motviktstruck',validFrom:'2025-10-01',validTo:'2026-09-30',verified:false,revision:0});
  state.personnel={version:1,revision:0,people,companies:[{id:'carrier-roslagen',name:'Roslagens Åkeri AB',number:'559123-7890',contact:'Maria Lind',phone:'070-222 33 44',email:'transport@roslagensakeri.example'}],
    employment:people.filter(p=>p.kind==='employee').map(p=>({personId:p.id,form:'permanent',startDate:p.id==='person-kalle'?'2023-04-03':'2024-01-08',percentage:100,hoursPerWeek:40,revision:0})),
    salaries:[{personId:'person-kalle',kind:'monthly',amount:34500,effectiveFrom:'2026-04-01',nextReview:'2027-04-01',note:'Fiktiv demolön.',revision:0}],schedules,
    absences:[{id:'absence-demo-johan',personId:'person-johan',kind:'leave',fromDate:'2026-10-12',toDate:'2026-10-12',allDay:true,status:'registered',createdAt:stamp(),createdBy:'admin',managerId:'person-anna',revision:0},{id:'absence-demo-kalle-holiday',personId:'person-kalle',kind:'holiday',fromDate:'2026-10-26',toDate:'2026-10-30',allDay:true,status:'registered',createdAt:stamp(),createdBy:'admin',managerId:'person-anna',revision:0}],competencies,staffingTasks:[],externalAccounts:[],audit:[]};
  state.personnelAuth={accounts:[],sessions:[],attempts:[]};
  if(!state.transport.vehicles.some(v=>v.id==='vehicle-lina'))state.transport.vehicles.push({id:'vehicle-lina',registration:'HRD 012',name:'Lastväxlare · Lina',types:['container','battery','bin','cage']});
  for(const p of people.filter(p=>p.driverId)) {
    let driver=state.transport.drivers.find(d=>d.id===p.driverId);
    if(!driver){driver={id:p.driverId,name:p.name,color:p.id==='person-lina'?'#1d9c66':'#a67b19',vehicleId:p.vehicleId};state.transport.drivers.push(driver);}
    driver.personId=p.id;if(p.companyId)driver.companyId=p.companyId;
  }
  // Future example on the next Monday; never overwrite AO-1042/1043/1044.
  const now=dateNow(),day=new Date(now+'T12:00:00Z');const weekday=day.getUTCDay();day.setUTCDate(day.getUTCDate()+((8-weekday)%7 || 7));const exampleDate=day.toISOString().slice(0,10);
  for(const [index,name,start,type] of [[1,'Verkstad Nord',480,'container'],[2,'Hasses Rör AB',600,'battery'],[3,'Bygg & Riv AB',840,'container']]) {
    const id=`AO-120${index}`;
    if(state.transport.orders.some(o=>o.id===id) || !people.some(p=>p.driverId==='kalle'))continue;
    if(state.transport.orders.some(o=>o.driverId==='kalle' && o.date===exampleDate && o.startMinute<start+60 && o.startMinute+o.durationMinutes>start && !['unbooked','cancelled'].includes(o.status)))continue;
    state.transport.orders.push({id,customerName:name,address:'Industrivägen 8',city:'Norrtälje',contact:'Demokontakt',phone:'070-000 00 00',action:'pickup',vesselType:type,material:index===2?'Blybatterier':'Metallskrot',vesselSize:'',pickupVessel:'',replacementVessel:'',notes:'Fiktivt exempel för personal och bemanning.',lat:59.7578,lng:18.7105,durationMinutes:60,status:'booked',date:exampleDate,startMinute:start,driverId:'kalle',vehicleId:'vehicle-kalle',requestedDate:exampleDate,requiredCompetencies:index===2?['license:CE','ykb:goods','adr:packages']:['license:CE','ykb:goods'],audit:[],updatedAt:stamp(),bookingVersion:1});
  }
  state.transport.revision++;
}

function affectedOrders(state,absence) {
  const person=state.personnel.people.find(p=>p.id===absence.personId);
  return state.transport.orders.filter(o=>o.driverId===person?.driverId && ['booked','on_way'].includes(o.status) && o.date>=absence.fromDate && o.date<=absence.toDate && (absence.allDay || o.startMinute<absence.endMinute && o.startMinute+o.durationMinutes>absence.startMinute));
}
export function refreshStaffingTasks(state) {
  for(const a of state.personnel.absences.filter(a=>a.status==='registered'))for(const order of affectedOrders(state,a))if(!state.personnel.staffingTasks.some(t=>t.absenceId===a.id && t.orderId===order.id && t.status==='open'))state.personnel.staffingTasks.push({id:uid('staffing'),absenceId:a.id,personId:a.personId,orderId:order.id,managerId:a.managerId,date:order.date,startMinute:order.startMinute,durationMinutes:order.durationMinutes,status:'open'});
  for(const task of state.personnel.staffingTasks.filter(t=>t.status==='open')) {
    const absence=state.personnel.absences.find(a=>a.id===task.absenceId),order=state.transport.orders.find(o=>o.id===task.orderId);
    if(!absence || absence.status==='cancelled' || !order || !affectedOrders(state,absence).some(o=>o.id===order.id)){task.status='resolved';task.resolvedAt=stamp();task.resolvedBy='system';}
  }
}
function tasksFor(state,p,ids) {
  if(!Array.isArray(ids) || !ids.length || ids.length>100)fail('Välj minst en bemanningsuppgift.',422);
  return [...new Set(ids)].map(id=>{const task=state.personnel.staffingTasks.find(t=>t.id===id);if(!task)fail('Bemanningsuppgiften finns inte.',404);checkPerson(state,p,task.personId);if(task.status!=='open')fail('Bemanningsuppgiften är redan löst.');return task;});
}
function replacementIssues(state,person,tasks) {
  const issues=[];let transport=clone(state.transport);
  for(const task of tasks) {
    const order=transport.orders.find(o=>o.id===task.orderId);if(!order || order.status!=='booked'){issues.push(`${task.orderId}: Uppdraget kan inte byta förare i nuvarande status.`);continue;}
    const plan={date:order.date,startMinute:order.startMinute,durationMinutes:order.durationMinutes,driverId:person.driverId,vehicleId:person.vehicleId??order.vehicleId};
    issues.push(...personnelPlanIssues(state.personnel,transport,order.id,plan).map(message=>`${order.id}: ${message}`));
    Object.assign(order,plan);
  }
  return [...new Set(issues)];
}
export function personnelProjection(state,p,planning=false,siteCatalog=[{id:'norrtalje',name:'Norrtälje'},{id:'rimbo',name:'Rimbo'}]) {
  const data=clone(state.personnel),ids=new Set(data.people.filter(person=>visible(p,person)).map(person=>person.id));
  data.people=data.people.filter(person=>ids.has(person.id));
  for(const key of ['employment','salaries','schedules','absences','competencies','staffingTasks','externalAccounts'])data[key]=data[key].filter(item=>ids.has(item.personId));
  data.companies=data.companies.filter(company=>!planning && personnelCan(p,'personnelWrite') || data.people.some(p=>p.companyId===company.id));
  data.audit=data.audit.filter(item=>!item.personId || ids.has(item.personId));
  if(planning || !personnelCan(p,'salaryRead'))data.salaries=[];
  if(planning || !personnelCan(p,'employmentRead'))data.employment=[];
  if(planning || !personnelCan(p,'absenceRead'))data.absences=data.absences.map(({kind,createdBy,...a})=>a);
  if(planning || !personnelCan(p,'externalAccounts'))data.externalAccounts=[];
  if(planning){data.audit=[];data.people=data.people.map(person=>({...person,phone:'',email:'',address:'',userId:undefined,employeeNumber:undefined}));data.companies=data.companies.map(c=>({...c,number:'',contact:'',phone:'',email:''}));}
  else if(!personnelCan(p,'salaryRead'))data.audit=data.audit.filter(entry=>!entry.action.startsWith('salary.'));
  const transport=clone(state.transport);
  if(p.user.siteIds){const drivers=new Set(data.people.map(person=>person.driverId));transport.orders=transport.orders.filter(order=>drivers.has(order.driverId));transport.drivers=transport.drivers.filter(driver=>drivers.has(driver.id));transport.preliminary={};transport.events=transport.events.filter(e=>transport.orders.some(o=>o.id===e.orderId));}
  if(!personnelCan(p,'transportRead')){transport.orders=[];transport.events=[];transport.preliminary={};}
  const sites=siteCatalog.filter(site=>site.active!==false && (!p.user.siteIds || p.user.siteIds.includes(site.id))).map(({id,name})=>({id,name}));
  const canManageUsers=!planning && personnelCan(p,'users');
  const users=canManageUsers?clone(state.pricing.users.filter(user=>!p.user.siteIds || user.siteIds && user.siteIds.every(id=>p.user.siteIds.includes(id)))):undefined;
  return {data,transport,sites,...(users?{users}:{}),revision:data.revision,storage:'database',demo:true,capabilities:[...personnelRights,...(!planning?['users']:[])].filter(right=>personnelCan(p,right))};
}

export function personnelCommand(state,p,command,transactionAudit=[],siteCatalog=[{id:'norrtalje',name:'Norrtälje',active:true},{id:'rimbo',name:'Rimbo',active:true}]) {
  demand(p,'personnelRead');if(!command || typeof command.action!=='string')fail('Välj en personalåtgärd.',422);
  ensurePersonnel(state);refreshStaffingTasks(state);const d=state.personnel;
  switch(command.action) {
    case 'person.save': {
      demand(p,'personnelWrite');const input=command.person??{},old=input.id && d.people.some(person=>person.id===input.id)?checkPerson(state,p,input.id):null;
      const creation=command.createAccount===undefined?undefined:parse(z.discriminatedUnion('kind',[
        z.object({kind:z.literal('staff'),level:z.enum(['Medarbetare','VD','Systemadmin']).optional(),permissions:z.array(z.string()).max(100).optional(),maxAttest:z.number().finite().nonnegative().optional(),ownAttest:z.boolean().optional()}).strict(),
        z.object({kind:z.literal('external'),username:z.string(),password:z.string().min(10).max(200)}).strict(),
      ]),command.createAccount);
      if(creation && input.userId)fail('Välj antingen ett befintligt konto eller skapa en inloggning.',422);
      const clearFields=parse(z.array(z.enum(['managerId','companyId','userId','vehicleId'])).max(4),command.clearFields??[]);
      if(clearFields.includes('userId') || input.userId!==undefined && input.userId!==old?.userId)demand(p,'users');
      const merged={active:true,role:'',team:'',siteIds:[p.user.siteIds?.[0]??'norrtalje'],phone:'',email:'',address:'',canDrive:false,revision:0,...old,...input,id:old?.id??input.id??uid('person')};for(const field of clearFields)delete merged[field];
      const person=parse(personSchema,merged);
      if(!visible(p,person) || p.user.siteIds && person.siteIds.some(id=>!p.user.siteIds.includes(id)))fail('Välj tillåtna anläggningar.',403);
      if(person.siteIds.some(id=>!siteCatalog.some(site=>site.id===id && site.active!==false)))fail('Välj en registrerad aktiv anläggning.',422);
      if(person.kind==='external' && (!person.companyId || !d.companies.some(c=>c.id===person.companyId)))fail('Extern chaufför måste kopplas till ett åkeri.',422);
      if(person.kind==='external' && person.userId || person.kind==='employee' && state.personnelAuth.accounts.some(a=>a.personId===person.id))fail('Personal- och chaufförsinloggningar kan inte blandas. Behåll personens kontotyp.',422);
      if(creation && (creation.kind==='staff')!==(person.kind==='employee'))fail('Välj en inloggning som passar personens kontotyp.',422);
      if(person.managerId && !d.people.some(manager=>manager.id===person.managerId && manager.kind==='employee' && manager.active))fail('Välj en aktiv anställd som ansvarig.',422);
      if(person.managerId && person.managerId!==old?.managerId)checkPerson(state,p,person.managerId);
      if(person.userId) {
        const linked=state.pricing.users.find(u=>u.id===person.userId);if(!linked)fail('Användarkontot finns inte.',422);
        if(input.userId!==old?.userId && (p.user.level!=='Systemadmin' && linked.level==='Systemadmin' || p.user.siteIds && (!linked.siteIds || linked.siteIds.some(id=>!p.user.siteIds.includes(id)))))fail('Kontot ligger utanför din behörighet.',403);
        if(linked.siteIds && person.siteIds.some(id=>!linked.siteIds.includes(id)))fail('Personens anläggningar måste omfattas av det kopplade kontot.',422);
      }
      for(const key of ['driverId','userId'])if(person[key] && d.people.some(item=>item.id!==person.id && item[key]===person[key]))fail('Kopplingen används redan av en annan person.',422);
      if(old?.driverId && person.driverId!==old.driverId)fail('En befintlig förarkoppling får inte byta identitet.');
      // Client-generated IDs make a repeated creation safe after a lost HTTP
      // response. An unchanged retry returns the original account without
      // resetting its password, revoking sessions or adding another account.
      if(creation && old && isDeepStrictEqual(withoutRevision(person),withoutRevision(old))) {
        if(creation.kind==='staff' && old.userId) {
          const proposed=staffCreation(state,p,person,creation),current=state.pricing.users.find(u=>u.id===old.userId);
          if(isDeepStrictEqual({...current,active:current.active??true},proposed.account))break;
          fail('Personen har redan en inloggning. Ändra den under Inloggning & behörigheter.');
        }
        if(creation.kind==='external') {
          demand(p,'externalAccounts');const current=state.personnelAuth.accounts.find(a=>a.personId===old.id);
          if(current && current.username===creation.username.trim().toLowerCase() && passwordValid(creation.password,current.password))break;
          if(current)fail('Personen har redan en inloggning. Ändra den under Inloggning & behörigheter.');
        }
      }
      if(creation?.kind==='staff') {
        if(person.userId)fail('Personen har redan ett kopplat konto.',422);
        const created=staffCreation(state,p,person,creation);state.pricing=created.pricing;state.office.users=clone(state.pricing.users);person.userId=created.account.id;
        audit(state,p,'staffAccount.created',person.id,'Personalprofil och användarkonto skapade tillsammans.',transactionAudit);
      }
      if(creation?.kind==='external' && state.personnelAuth.accounts.some(a=>a.personId===person.id))fail('Personen har redan en chaufförsinloggning.',422);
      if(person.canDrive){person.driverId??=`driver-${person.id}`;if(!person.vehicleId || !state.transport.vehicles.some(v=>v.id===person.vehicleId))fail('Välj ett befintligt fordon för förarprofilen.',422);let driver=state.transport.drivers.find(v=>v.id===person.driverId);if(!driver){driver={id:person.driverId,name:person.name,color:'#1673ff',vehicleId:person.vehicleId};state.transport.drivers.push(driver);}Object.assign(driver,{name:person.name,personId:person.id,companyId:person.companyId,vehicleId:person.vehicleId});state.transport.revision++;}
      saveRecord(d.people,person);if(person.kind==='external' && (d.employment.some(e=>e.personId===person.id) || d.salaries.some(e=>e.personId===person.id)))fail('En anställd med anställning/lön kan inte göras extern utan separat avveckling.');
      if(creation?.kind==='external')saveExternalAccount(state,p,person,{...creation,active:person.active},transactionAudit);
      if(!person.active){const a=state.personnelAuth.accounts.find(a=>a.personId===person.id);if(a)a.active=false;state.personnelAuth.sessions=state.personnelAuth.sessions.filter(s=>s.personId!==person.id);}
      audit(state,p,'person.saved',person.id,'Personprofil sparad.',transactionAudit);break;
    }
    case 'company.save': {demand(p,'personnelWrite');const company=parse(companySchema,{number:'',contact:'',phone:'',email:'',...command.company,id:command.company?.id??uid('carrier')});const index=d.companies.findIndex(c=>c.id===company.id);if(index>=0)d.companies[index]=company;else d.companies.push(company);audit(state,p,'company.saved',undefined,'Åkeri sparat.',transactionAudit);break;}
    case 'employment.save': {demand(p,'employmentWrite');const input=parse(employmentSchema,command.employment);employmentPerson(state,p,input.personId);saveRecord(d.employment,input,'personId');audit(state,p,'employment.saved',input.personId,'Anställningsuppgifter sparade.',transactionAudit);break;}
    case 'salary.save': {demand(p,'salaryWrite');const input=parse(salarySchema,command.salary);employmentPerson(state,p,input.personId);saveRecord(d.salaries,input,'personId');audit(state,p,'salary.saved',input.personId,'Löneuppgifter ändrade.',transactionAudit);break;}
    case 'schedule.save': {demand(p,'personnelWrite');const input=parse(scheduleSchema,{...command.schedule,id:command.schedule?.id??uid('schedule'),revision:command.schedule?.revision??0});checkPerson(state,p,input.personId);if(d.schedules.some(old=>old.id!==input.id && old.personId===input.personId && old.weekdays.some(day=>input.weekdays.includes(day)) && old.effectiveFrom<=(input.effectiveTo??'9999-12-31') && (old.effectiveTo??'9999-12-31')>=input.effectiveFrom))fail('Arbetspassen överlappar. Ändra det befintliga passet.',422);saveRecord(d.schedules,input);audit(state,p,'schedule.saved',input.personId,'Arbetspass sparat.',transactionAudit);break;}
    case 'competency.save': {demand(p,'competenciesWrite');const input=parse(competencySchema,{...command.competency,id:command.competency?.id??uid('competency'),revision:command.competency?.revision??0});checkPerson(state,p,input.personId);if(input.verified){input.verifiedBy=p.user.id;input.verifiedAt=stamp();}else {delete input.verifiedBy;delete input.verifiedAt;}saveRecord(d.competencies,input);audit(state,p,'competency.saved',input.personId,'Kompetens och giltighet sparad.',transactionAudit);break;}
    case 'absence.preview': case 'absence.save': {
      demand(p,'absenceWrite');const old=d.absences.find(a=>a.id===command.absence?.id);
      const input=parse(absenceSchema,{...command.absence,id:command.absence?.id??uid('absence'),revision:command.absence?.revision??0,status:'registered',createdAt:old?.createdAt??stamp(),createdBy:old?.createdBy??p.user.id});
      const person=checkPerson(state,p,input.personId);input.managerId??=person.managerId;
      if(input.managerId && !d.people.some(manager=>manager.id===input.managerId && manager.kind==='employee' && manager.active))fail('Välj en aktiv anställd som ansvarig.',422);
      if(input.managerId && input.managerId!==person.managerId)checkPerson(state,p,input.managerId);
      const affected=affectedOrders(state,input);if(command.action==='absence.preview'){demand(p,'transportRead');return {affectedOrders:clone(affected)};}
      if(old && old.status==='registered' && ['personId','kind','fromDate','toDate','allDay','startMinute','endMinute','managerId'].every(field=>isDeepStrictEqual(old[field],input[field])))break;
      saveRecord(d.absences,input);refreshStaffingTasks(state);audit(state,p,'absence.saved',input.personId,'Frånvaro registrerad. Berörda bokningar har bevarats.',transactionAudit);break;
    }
    case 'absence.cancel': {demand(p,'absenceWrite');const old=d.absences.find(a=>a.id===command.absenceId);if(!old)fail('Frånvaron finns inte.',404);checkPerson(state,p,old.personId);saveRecord(d.absences,{...old,status:'cancelled',revision:command.revision});refreshStaffingTasks(state);audit(state,p,'absence.cancelled',old.personId,'Frånvaro avbruten.',transactionAudit);break;}
    case 'replacement.preview': {demand(p,'staffingWrite');const tasks=tasksFor(state,p,command.taskIds);return {candidates:d.people.filter(person=>visible(p,person) && person.canDrive && person.driverId && person.active).map(person=>{const issues=replacementIssues(state,person,tasks);return {personId:person.id,name:person.name,available:issues.length===0,issues};})};}
    case 'staffing.assign': {
      demand(p,'staffingWrite');demand(p,'transportPlan');const tasks=tasksFor(state,p,command.taskIds),replacement=checkPerson(state,p,command.replacementPersonId);if(!replacement.canDrive || !replacement.driverId)fail('Välj en bokningsbar förare.',422);
      const issues=replacementIssues(state,replacement,tasks);if(issues.length)fail(issues.join(' '),422);
      const previousEvents=new Set(state.transport.events.map(e=>e.id));
      for(const task of tasks){const order=state.transport.orders.find(o=>o.id===task.orderId);state.transport=applyTransportChange(state.transport,{type:'reschedule',id:order.id,plan:{date:order.date,startMinute:order.startMinute,durationMinutes:order.durationMinutes,driverId:replacement.driverId,vehicleId:replacement.vehicleId??order.vehicleId}},actorOf(p));Object.assign(task,{status:'resolved',replacementPersonId:replacement.id,resolvedBy:p.user.id,resolvedAt:stamp()});}
      const box=createTransportOutbox({initialState:state.outbox});box.prepare({events:state.transport.events.filter(e=>!previousEvents.has(e.id))},p);state.outbox=box.exportState();
      audit(state,p,'staffing.resolved',replacement.id,`${tasks.length} uppdrag har fått ersättare. Tider och kunduppgifter är bevarade.`,transactionAudit);break;
    }
    case 'externalAccount.save': {
      saveExternalAccount(state,p,checkPerson(state,p,command.personId),command,transactionAudit);break;
    }
    default:fail('Personalåtgärden finns inte.',404);
  }
  return undefined;
}

/** Only changed/new bookings are checked. A sickness report never deletes the
 * customer's previous booking; it creates a staffing task instead. */
export function validatePersonnelTransportChange(state,previous,next) {
  ensurePersonnel(state);
  for(const order of next.orders)if(['booked','on_way'].includes(order.status)) {
    const old=previous.orders.find(o=>o.id===order.id),key=o=>o && [o.date,o.startMinute,o.durationMinutes,o.driverId,o.vehicleId,JSON.stringify(o.requiredCompetencies??[])].join('|');
    if(key(old)===key(order) && old.status===order.status)continue;
    const issues=personnelPlanIssues(state.personnel,next,order.id,{date:order.date,startMinute:order.startMinute,durationMinutes:order.durationMinutes,driverId:order.driverId,vehicleId:order.vehicleId});
    if(issues.length)fail(`${order.id}: ${issues.join(' ')}`,409);
  }
  for(const [id,plan] of Object.entries(next.preliminary))if(!isDeepStrictEqual(previous.preliminary[id],plan)) {
    const issues=personnelPlanIssues(state.personnel,next,id,plan);if(issues.length)fail(`${id}: ${issues.join(' ')}`,409);
  }
  // Vehicle eligibility changes must recheck affected scheduled work.
  for(const vehicle of next.vehicles)if(JSON.stringify([vehicle.types,vehicle.requiredCompetencies??[]])!==JSON.stringify([previous.vehicles.find(v=>v.id===vehicle.id)?.types,previous.vehicles.find(v=>v.id===vehicle.id)?.requiredCompetencies??[]]))for(const order of next.orders.filter(o=>o.vehicleId===vehicle.id && ['booked','on_way'].includes(o.status))) {
    const issues=personnelPlanIssues(state.personnel,next,order.id,order);if(issues.length)fail(`${order.id}: ${issues.join(' ')}`,409);
  }
}

export function createDriverApi({getRepository,readBody,json}) {
  const cookieName='jeroc_driver';
  const orderView=({audit,confirmation,...order})=>({...order,audit:[]});
  const companyView=company=>({id:company.id,name:company.name});
  function cookie(req){return req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);}
  const setCookie=(res,token,req,maxAge=8*3600)=>res.setHeader('Set-Cookie',`${cookieName}=${token}; HttpOnly; Path=/api/driver; SameSite=Strict; Max-Age=${maxAge}${req.socket.encrypted || req.headers['x-forwarded-proto']==='https'?'; Secure':''}`);
  return async(req,res,url)=>{
    if(!url.pathname.startsWith('/api/driver/'))return false;
    try {
      if(req.headers.origin && new URL(req.headers.origin).host!==req.headers.host)fail('Anropet måste komma från samma webbplats.',403);
      const path=url.pathname.slice('/api/driver/'.length),payload=req.method==='POST'?await readBody(req):null;
      const result=await (await getRepository()).transact((state,_,transactionAudit)=>{
        ensurePersonnel(state);const auth=state.personnelAuth;auth.sessions=auth.sessions.filter(s=>Date.parse(s.expiresAt)>Date.now());auth.attempts=auth.attempts.filter(a=>Date.parse(a.at)>Date.now()-15*60*1000);
        if(path==='login') {
          if(req.method!=='POST')fail('Metoden stöds inte.',405);
          const input=parse(z.object({username:z.string().trim().toLowerCase().min(1).max(80),password:z.string().min(1).max(200)}),payload),address=hash(req.socket.remoteAddress??'unknown');
          if(auth.attempts.filter(a=>a.address===address).length>=12)fail('För många inloggningsförsök. Vänta 15 minuter.',429);
          const account=auth.accounts.find(a=>a.username===input.username),person=state.personnel.people.find(p=>p.id===account?.personId);
          if(!account?.active || !person?.active || !state.personnel.companies.some(c=>c.id===person.companyId) || !passwordValid(input.password,account.password)){auth.attempts.push({address,at:stamp()});return {failure:'Fel inloggning eller inaktivt konto.'};}
          const token=randomBytes(32).toString('base64url');auth.sessions.push({tokenHash:hash(token),personId:person.id,companyId:person.companyId,expiresAt:new Date(Date.now()+8*3600000).toISOString()});account.lastLoginAt=stamp();state.personnel.externalAccounts=auth.accounts.map(({password,...a})=>a);
          transactionAudit.push({action:'externalDriver.login',personId:person.id,at:stamp()});
          return {cookie:token,value:{person:{id:person.id,name:person.name,driverId:person.driverId,companyId:person.companyId},company:companyView(state.personnel.companies.find(c=>c.id===person.companyId)),demo:true}};
        }
        const session=auth.sessions.find(s=>s.tokenHash===hash(cookie(req)??'')),person=state.personnel.people.find(p=>p.id===session?.personId),account=auth.accounts.find(a=>a.personId===person?.id);
        if(!session || !person?.active || person.kind!=='external' || !account?.active || session.companyId!==person.companyId || !state.personnel.companies.some(c=>c.id===person.companyId))fail('Logga in som extern chaufför.',401);
        if(path==='logout' && req.method==='POST'){auth.sessions=auth.sessions.filter(s=>s!==session);return {cookie:'',logout:true,value:{ok:true}};}
        const driver=state.transport.drivers.find(d=>d.id===person.driverId);
        if(!driver || driver.personId!==person.id || driver.companyId!==person.companyId)fail('Kontot saknar en giltig koppling till förare och åkeri.',403);
        if(path==='session' && req.method==='GET')return {value:{person:{id:person.id,name:person.name,driverId:person.driverId,companyId:person.companyId},company:companyView(state.personnel.companies.find(c=>c.id===person.companyId)),demo:true}};
        const orders=state.transport.orders.filter(o=>o.driverId===driver.id);
        if(path==='orders' && req.method==='GET')return {value:{orders:clone(orders.map(orderView)),demo:true}};
        const match=path.match(/^orders\/([^/]+)\/status$/);
        if(match && req.method==='POST') {
          const order=orders.find(o=>o.id===match[1]);if(!order)fail('Uppdraget är inte tilldelat dig.',403);
          const input=parse(z.object({status:z.enum(['on_way','done'])}),payload);
          if(order.status===input.status)return {value:{order:clone(orderView(order)),demo:true}};
          if((input.status==='on_way' && order.status!=='booked') || (input.status==='done' && order.status!=='on_way'))fail('Uppdraget måste påbörjas innan det slutförs.');
          if(input.status==='on_way'){const issues=personnelPlanIssues(state.personnel,state.transport,order.id,order);if(issues.length)fail(issues.join(' '),422);}
          const events=new Set(state.transport.events.map(e=>e.id));state.transport=applyTransportChange(state.transport,{type:'status',id:order.id,status:input.status},{canPlan:true,actor:person.name,actualUserId:person.id,effectiveUserId:person.id});
          // External event actor does not become an office principal; records are
          // retained as prepared integration events, never dispatched in this demo.
          const added=state.transport.events.filter(e=>!events.has(e.id));
          const box=createTransportOutbox({initialState:state.outbox});box.prepare({events:added},{actor:{id:person.id},user:{id:person.id,level:'Medarbetare',permissions:['transportRead','transportPlan']}});state.outbox=box.exportState();
          transactionAudit.push(...added.map(e=>({action:e.type,personId:person.id,orderId:order.id,at:e.at})));refreshStaffingTasks(state);
          return {value:{order:clone(orderView(state.transport.orders.find(o=>o.id===order.id))),demo:true}};
        }
        fail('Chaufförsidan finns inte.',404);
      });
      if(result.failure)json(res,401,{error:result.failure});else {if(result.cookie!==undefined)setCookie(res,result.cookie,req,result.logout?0:8*3600);json(res,200,result.value);}
    } catch(error) {json(res,error instanceof PricingError?error.status:503,{error:error instanceof PricingError?error.message:'Chaufförstjänsten kunde inte nås.'});}
    return true;
  };
}
