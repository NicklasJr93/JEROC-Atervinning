import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createApplicationRepository } from './application-storage.mjs';
import { createMailService } from './mail-service.mjs';

const ctx=id=>({organisationId:'mail-company',actorId:id,effectiveUserId:id,sessionKey:`session-${id}`});
const admin=ctx('admin'),reader=ctx('reader');
const user=(id,permissions,extra={})=>({id,name:id,level:'Medarbetare',permissions,maxAttest:0,ownAttest:false,...extra});
const row=(id='message-1',sender='sender@example.test')=>({id,subject:'Fiktivt leveransärende',from:{emailAddress:{name:'Fiktiv avsändare',address:sender}},receivedDateTime:'2026-10-13T09:00:00.000Z',isRead:false,bodyPreview:'Ett mejl att läsa',hasAttachments:true});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(run){
  let now=new Date('2026-10-13T10:00:00Z'),listCalls=0,detailCalls=0,refreshCalls=0;
  const key=randomBytes(32).toString('base64'),env={SCRAPPILOT_ORGANISATION_ID:'mail-company',MAIL_TOKEN_ENCRYPTION_KEY:key};
  const seed=()=>({office:{customers:[{id:'customer-a',name:'Fiktiv kund A',type:'Företag',email:' Sender@Example.Test ',phone:'070-test',customerNumber:'K1',address:'Testgatan 1',postalCode:'11111',city:'Testort',number:'PRIVATE_IDENTIFICATION_MUST_NOT_LEAK',paymentProfile:{account:'PRIVATE_BANK_MUST_NOT_LEAK'}},
    {id:'customer-b',name:'Fiktiv kund B',type:'Privatperson',email:'sender@example.test',phone:'',customerNumber:'K2',address:'',postalCode:'',city:'',number:'PRIVATE_IDENTIFICATION_MUST_NOT_LEAK'}],cards:[{id:1,customerId:'customer-a',siteId:'site-a'},{id:2,customerId:'customer-b',siteId:'site-b'}]},
    pricing:{users:[user('admin',[],{level:'Systemadmin'}),user('reader',['mailRead','view']),user('no-view',['mailRead']),user('outsider',[]),user('restricted',['mailRead','view'],{siteIds:['site-a']}),user('restricted-admin',['mailRead','integrationsRead','integrationsManage'],{siteIds:['site-a']}),user('director',[],{level:'VD'})]},imports:[]});
  const repo=await createApplicationRepository({env:{},filename:':memory:',seed});
  const calls=[],projections=[],originalProjection=repo.readProjection.bind(repo);repo.readProjection=(callback,options)=>{projections.push(structuredClone(options));return originalProjection(callback,options);};
  let lockDepth=0;const originalTransact=repo.transact.bind(repo);repo.transact=callback=>originalTransact((...args)=>{lockDepth++;try{return callback(...args);}finally{lockDepth--;}});
  const assertOutsideLock=()=>assert.equal(lockDepth,0,'Microsoft I/O must not hold the database write lock');
  const tokens=()=>({accessToken:'SYNTHETIC_PRIVATE_ACCESS_TOKEN',refreshToken:'SYNTHETIC_PRIVATE_REFRESH_TOKEN',expiresAt:now.getTime()+3_600_000,scopes:['Mail.Read']});
  const client={configuration:()=>({ready:true,missing:[],issues:[],redirectUri:'https://app.example.test/api/integrations/microsoft-mail/callback'}),
    authorisationUrl:input=>{calls.push({operation:'url',input});return 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?'+new URLSearchParams({state:input.state,code_challenge:input.challenge});},
    exchangeCode:async input=>{assertOutsideLock();calls.push({operation:'exchange',input});return tokens();},
    refreshToken:async()=>{assertOutsideLock();refreshCalls++;return tokens();},me:async()=>{assertOutsideLock();return {id:'microsoft-user-a',displayName:'Fiktiv inkorg',mail:'office@example.test'};},
    listMessages:async options=>{assertOutsideLock();listCalls++;calls.push({operation:'list',options});return {messages:[row()],hasMore:false};},
    getMessage:async options=>{assertOutsideLock();detailCalls++;return {...row(options.messageId),body:{contentType:'text',content:'SYNTHETIC_BODY_NOT_ARCHIVED'},toRecipients:[{emailAddress:{name:'Kontoret',address:'office@example.test'}}],attachments:[{id:'file-1',name:'underlag.pdf',size:20,contentType:'application/pdf',contentBytes:'PRIVATE_ATTACHMENT_BYTES_MUST_NOT_LEAK'}],webLink:'https://outlook.office.com/mail/deeplink/read/test'};}};
  const create=(options={})=>createMailService({env,getRepository:async()=>repo,client,now:()=>now,...options});
  let service=create();
  const connect=async()=>{const start=await service.connectMicrosoft(admin),state=new URL(start.authorizationUrl).searchParams.get('state');return service.completeMicrosoft({state,code:'SYNTHETIC_ONE_USE_OAUTH_CODE'},admin);};
  const setup=async()=>{let state=await connect(),box=state.mailboxes[0];state=await service.updateMailbox(box.id,{allowedUserIds:['reader','no-view','restricted']},admin);return {state,box:state.mailboxes.find(item=>item.id===box.id),connection:state.connections[0]};};
  try{await run({repo,client,create,get service(){return service;},restart:()=>{service=create();},connect,setup,calls,projections,env,
    counts:()=>({listCalls,detailCalls,refreshCalls}),advance:ms=>{now=new Date(now.getTime()+ms);},raw:()=>repo.read(state=>structuredClone(state.mailIntegration),{domains:['mailIntegration']})});}finally{await repo.close();}
}

test('mail starts empty and metadata-only reads never dispatch Microsoft calls or manufacture a demo connection',()=>fixture(async f=>{
  const state=await f.service.state(admin);assert.deepEqual(state.connections,[]);assert.deepEqual(state.mailboxes,[]);assert.equal(state.totalUnread,0);
  assert.equal((await f.service.integrationStatus()).connected,false);assert.equal(f.calls.length,0);
  assert.ok(f.projections.every(item=>item.paths.every(path=>!['tokens','messages','oauthAttempts','audit'].includes(path[0]))));
}));
test('OAuth is session-bound, one-use and encrypted; cached state contains no credentials or body',()=>fixture(async f=>{
  const start=await f.service.connectMicrosoft(admin),state=new URL(start.authorizationUrl).searchParams.get('state');
  const before=JSON.stringify(await f.raw());assert.equal(before.includes(state),false);assert.equal(before.includes(f.calls[0].input.challenge),false);
  await assert.rejects(()=>f.service.completeMicrosoft({state,code:'SYNTHETIC_ONE_USE_OAUTH_CODE'},{...admin,sessionKey:'another-session'}),error=>error.code==='mail_callback_forbidden');
  await f.service.completeMicrosoft({state,code:'SYNTHETIC_ONE_USE_OAUTH_CODE'},admin);
  await assert.rejects(()=>f.service.completeMicrosoft({state,code:'SYNTHETIC_ONE_USE_OAUTH_CODE'},admin),error=>error.code==='mail_callback_forbidden');
  for(const value of ['SYNTHETIC_PRIVATE_ACCESS_TOKEN','SYNTHETIC_PRIVATE_REFRESH_TOKEN','SYNTHETIC_ONE_USE_OAUTH_CODE'])assert.equal(JSON.stringify(await f.raw()).includes(value),false);
  assert.equal(f.calls.filter(call=>call.operation==='exchange').length,1);f.restart();assert.equal((await f.service.state(admin)).connections[0].status,'connected');
}));
test('real/effective mail permission, mailbox ACL, integration rights and tenant boundary all fail closed',()=>fixture(async f=>{
  const {box}=await f.setup();
  for(const context of [ctx('outsider'),ctx('director'),{...admin,effectiveUserId:'outsider'},{...reader,organisationId:'other-company'}])
    await assert.rejects(()=>f.service.listMessages({mailboxId:box.id},context),error=>[401,403].includes(error.status));
  await assert.rejects(()=>f.service.connectMicrosoft(reader),error=>error.status===403);
  await assert.rejects(()=>f.service.connectMicrosoft(ctx('restricted-admin')),error=>error.status===403);
  await f.service.updateMailbox(box.id,{allowedUserIds:['no-view']},admin);
  await assert.rejects(()=>f.service.sync({mailboxId:box.id},reader),error=>error.code==='mail_mailbox_forbidden');
  assert.equal(f.counts().listCalls,0);
}));
test('a shared inbox is explicitly assigned, sync is bounded and opening text never changes read status or archives its body',()=>fixture(async f=>{
  const {box,connection}=await f.setup();await f.service.addMailbox({connectionId:connection.id,address:' shared@example.test ',allowedUserIds:['reader']},admin);
  const shared=(await f.service.state(reader)).mailboxes.find(item=>item.type==='shared');assert.ok(shared);
  await f.service.sync({mailboxId:shared.id},reader);const messages=await f.service.listMessages({mailboxId:shared.id,unreadOnly:true},reader);
  assert.equal(messages.messages.length,1);assert.equal(messages.totalUnread,1);assert.equal(f.calls.find(call=>call.operation==='list').options.mailbox,'shared@example.test');
  const detail=await f.service.message(shared.id,'message-1',reader);assert.equal(detail.message.bodyText,'SYNTHETIC_BODY_NOT_ARCHIVED');
  assert.equal(detail.message.isRead,false);assert.equal((await f.service.listMessages({mailboxId:shared.id},reader)).messages[0].isRead,false);
  const serialized=JSON.stringify(await f.raw());assert.equal(serialized.includes('SYNTHETIC_BODY_NOT_ARCHIVED'),false);assert.equal(JSON.stringify(detail).includes('PRIVATE_ATTACHMENT_BYTES_MUST_NOT_LEAK'),false);
  assert.ok(f.calls.every(call=>!['send','markRead','patchMessage'].includes(call.operation)));
}));
test('customer matching is exact email, company-local, site-scoped and never returns identification/payment fields',()=>fixture(async f=>{
  const {box}=await f.setup();await f.service.sync({mailboxId:box.id},admin);
  const all=await f.service.message(box.id,'message-1',reader);assert.equal(all.matchStatus,'multiple');assert.equal(all.matches.length,2);
  const restricted=await f.service.message(box.id,'message-1',ctx('restricted'));assert.equal(restricted.matchStatus,'matched');assert.equal(restricted.matches[0].id,'customer-a');
  const denied=await f.service.message(box.id,'message-1',ctx('no-view'));assert.equal(denied.matchStatus,'not-authorized');assert.deepEqual(denied.matches,[]);
  const serialized=JSON.stringify(all);for(const value of ['PRIVATE_IDENTIFICATION_MUST_NOT_LEAK','PRIVATE_BANK_MUST_NOT_LEAK','paymentProfile'])assert.equal(serialized.includes(value),false);
  await f.repo.transact(state=>{state.office.customers.forEach(customer=>{customer.email='sender+other@example.test';});});
  assert.equal((await f.service.message(box.id,'message-1',reader)).matchStatus,'none');
}));
test('sync deduplicates concurrent requests and disconnect rejects the stale external result',()=>fixture(async f=>{
  const {box,connection}=await f.setup();let start,finish,dispatches=0;const started=new Promise(resolve=>{start=resolve;}),gate=new Promise(resolve=>{finish=resolve;});
  f.client.listMessages=async()=>{dispatches++;start();await gate;return {messages:[row()],hasMore:false};};
  const first=f.service.sync({mailboxId:box.id},reader);await started;const second=f.service.sync({mailboxId:box.id},reader);await tick();
  await f.service.disconnect(connection.id,admin);finish();const results=await Promise.allSettled([first,second]);assert.ok(results.every(item=>item.status==='rejected'));
  assert.equal(dispatches,1);
  assert.equal((await f.service.state(admin)).connections[0].status,'disconnected');assert.deepEqual((await f.raw()).messages,{});
}));
test('mailbox ACL changes during detail fetch block returning the text',()=>fixture(async f=>{
  const {box}=await f.setup();await f.service.sync({mailboxId:box.id},reader);let start,finish;const started=new Promise(resolve=>{start=resolve;}),gate=new Promise(resolve=>{finish=resolve;});
  const original=f.client.getMessage;f.client.getMessage=async options=>{start();await gate;return original(options);};
  const request=f.service.message(box.id,'message-1',reader);await started;await f.service.updateMailbox(box.id,{allowedUserIds:[]},admin);finish();
  await assert.rejects(()=>request,error=>error.code==='mail_mailbox_forbidden');
}));
test('encrypted refresh is singleflight and keeps credentials out of state and audit',()=>fixture(async f=>{
  const {box}=await f.setup();await f.service.sync({mailboxId:box.id},reader);f.advance(3_600_000);
  await Promise.all([f.service.message(box.id,'message-1',reader),f.service.message(box.id,'message-1',reader)]);
  assert.equal(f.counts().refreshCalls,1);for(const value of ['SYNTHETIC_PRIVATE_ACCESS_TOKEN','SYNTHETIC_PRIVATE_REFRESH_TOKEN'])assert.equal(JSON.stringify(await f.raw()).includes(value),false);
}));
test('an OAuth return started before disconnect cannot silently reconnect the same Microsoft account',()=>fixture(async f=>{
  const {connection}=await f.setup(),start=await f.service.connectMicrosoft(admin),state=new URL(start.authorizationUrl).searchParams.get('state');
  let enter,finish;const started=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{finish=resolve;});const original=f.client.exchangeCode;
  f.client.exchangeCode=async input=>{enter();await gate;return original(input);};const callback=f.service.completeMicrosoft({state,code:'SYNTHETIC_RETURN_AFTER_DISCONNECT'},admin);
  await started;await f.service.disconnect(connection.id,admin);finish();await assert.rejects(()=>callback,error=>error.code==='mail_connection_changed');
  assert.equal((await f.service.state(admin)).connections[0].status,'disconnected');assert.equal((await f.raw()).connections[connection.id].tokens,null);
}));
test('malicious mailbox IDs cannot modify object prototypes',()=>fixture(async f=>{
  await f.connect();for(const id of ['__proto__','constructor','toString']){
    await assert.rejects(()=>f.service.updateMailbox(id,{displayName:'polluted'},admin),error=>error.code==='mail_not_found');
    await assert.rejects(()=>f.service.disconnect(id,admin),error=>error.code==='mail_not_found');
  }assert.equal(Object.prototype.displayName,undefined);
}));
test('opaque list cursors bind company, current permissions, filters and committed mail revision',()=>fixture(async f=>{
  const {box,connection}=await f.setup();const state=await f.service.addMailbox({connectionId:connection.id,address:'shared@example.test',allowedUserIds:['reader']},admin),shared=state.mailboxes.find(item=>item.type==='shared');
  f.client.listMessages=async()=>({messages:Array.from({length:50},(_,i)=>row('message-'+i)),hasMore:true});await f.service.sync({},reader);
  const page=await f.service.listMessages({},reader);assert.equal(page.messages.length,50);assert.equal(page.hasMore,true);assert.ok(page.nextCursor);assert.equal(page.countsPartial,true);
  const next=await f.service.listMessages({cursor:page.nextCursor},reader);assert.equal(next.messages.length,50);assert.equal(next.hasMore,false);
  for(const filters of [{cursor:page.nextCursor+'tampered'},{cursor:page.nextCursor,mailboxId:box.id},{cursor:page.nextCursor,search:'different'}])await assert.rejects(()=>f.service.listMessages(filters,reader),error=>error.code==='mail_cursor_stale');
  await f.service.updateMailbox(shared.id,{enabled:false},admin);await assert.rejects(()=>f.service.listMessages({cursor:page.nextCursor},reader),error=>error.code==='mail_cursor_stale');
}));
test('token envelopes cannot be transplanted to another connection or organisation even with the same encryption key',()=>fixture(async f=>{
  const {box,connection}=await f.setup();await f.service.sync({mailboxId:box.id},reader);
  await f.repo.transact(state=>{state.mailIntegration.organisationId='other-company';});
  const foreign=f.create({env:{...f.env,SCRAPPILOT_ORGANISATION_ID:'other-company'}}),context={...reader,organisationId:'other-company'};
  await assert.rejects(()=>foreign.message(box.id,'message-1',context),error=>error.code==='mail_credentials_unavailable');
}));
