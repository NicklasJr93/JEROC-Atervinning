import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationRepository } from './application-storage.mjs';
import { initialApplicationState } from './application.mjs';
import { createBankPayments,bankMoneyToCents } from './bank-payments.mjs';
import { createSwishPayments } from './swish-payments.mjs';

const CARD=2053,BANK='SWEDSESS',ACCOUNT='debtor-sek',IBAN='SE4550000000058398257466';
const ctx={organisationId:'jeroc-demo',actorId:'admin',effectiveUserId:'admin',sessionKey:'bank-session',psuIp:'127.0.0.1',userAgent:'Fixture'};
const details=()=>({method:'bank',bankType:'account',clearing:'8327',account:'1234567890',holder:'Erik Johansson'});
const proof=()=>({status:'booked',companyId:'sandbox-company',generation:'generation-a',invoiceId:'45411b28-fecb-43e9-8829-466fe0f45c88',draftId:'b1f5b3a0-22f9-4aa8-abdf-fa9bd389c1cb'});
async function fixture(run,hooks={}) {
  const state=initialApplicationState(),customer=state.office.customers.find(item=>item.id==='customer-erik'),card=state.office.cards.find(item=>item.id===CARD);
  Object.assign(customer,{number:'197709306828'});
  Object.assign(card,{status:'ready',siteId:'norrtalje',customerId:customer.id,origin:'Testgatan 1',reference:'Bank fixture',payment:'Bankkonto',paymentDetails:details(),
    pricingSnapshotId:'bank-pricing',pricingTotal:240,financialPending:false,pricingRowsPending:false,rows:[{articleId:'copper-1',weight:1,price:240,tier:'C'}],
    customerApproval:{id:'bank-approval',version:1,status:'attested'}});
  const snapshot={hash:'bank-frozen',card:structuredClone(card),customer:structuredClone(customer),rows:[{articleId:'copper-1',name:'Koppar',weight:1,price:240,amount:240}],gross:240,net:240,offset:0};
  const approval={id:'bank-approval',cardId:CARD,version:1,status:'attested',snapshot,approvedAt:'2026-10-13T08:00:00Z',attestedAt:'2026-10-13T08:01:00Z',attestedBy:'admin',approvedHash:snapshot.hash,approvedMethod:'id'};
  state.bankPayments={version:1,organisationId:'jeroc-demo',settings:{enabled:true,bankId:BANK,corporateId:'5593593626',psuId:'199306236374',debtorAccountId:ACCOUNT,
    bookkeepingEnabled:true,registerSpirisPayment:true,revision:1,spirisCompanyId:'sandbox-company',spirisBankAccountId:'6727d011-9654-497e-b10f-14f6de3b39d2'},
    consents:{'fixture-consent':{id:'fixture-consent',providerConsentId:'provider-consent',bankId:BANK,corporateId:'5593593626',psuId:'199306236374',status:'valid',expiresAt:'2026-11-13T23:59:59.000Z'}},
    currentConsentId:'fixture-consent',accounts:[{id:ACCOUNT,name:'Företagskonto',currency:'SEK',iban:IBAN}],jobs:{},audit:[],workIds:[],nextWorkAt:null};
  const repo=await createApplicationRepository({env:{},filename:':memory:',seed:()=>state});let timestamp=new Date('2026-10-13T09:00:00Z');
  const calls=[],payloads=new Map(),bookkeeping=[],documents=[];
  const success=(data,statusCode=200)=>({ok:true,environment:'sandbox',statusCode,data,journal:{method:'GET',path:'/fixture',response:structuredClone(data),statusCode},uncertain:false});
  const client={configurationStatus:()=>({ready:true,mode:'sandbox',missing:[],issues:[]}),
    banks:async()=>success({aspsps:[{bicFi:BANK,name:'Swedbank'}]}),testConnection:async()=>success({aspsps:[{bicFi:BANK,name:'Swedbank'}]}),
    bankDetails:async()=>success({bicFi:BANK,globalPaymentProducts:['domestic','swedish-giro']}),
    readConsentStatus:async options=>{calls.push({method:'GET',kind:'consent',id:options.id});return hooks.consentRead?hooks.consentRead(options,success):success({consentStatus:'valid'});},
    accounts:async()=>success({accounts:[{resourceId:ACCOUNT,currency:'SEK',iban:IBAN,name:'Företagskonto'}]}),
    balances:async()=>success({balances:[{balanceAmount:{amount:'1000.00',currency:'SEK'},balanceType:'interimAvailable'}]}),
    createPayment:async options=>{calls.push({method:'POST',kind:'payment',...structuredClone(options)});payloads.set('provider-payment',structuredClone(options.payload));
      return hooks.create?hooks.create(options,success):success({paymentId:'provider-payment',transactionStatus:'RCVD'},201);},
    readPayment:async options=>{calls.push({method:'GET',kind:'payment',...structuredClone(options)});const payload=payloads.get(options.id);assert.ok(payload,'Read uses reserved provider ID');
      return hooks.read?hooks.read(options,payload,success):success({...payload,paymentId:options.id,transactionStatus:'ACSC'});},
    createConsent:async options=>{calls.push({method:'POST',kind:'consent',...structuredClone(options)});return success({consentId:'consent-new',consentStatus:'received'},201);},
    createAuthorisation:async options=>{calls.push({method:'POST',kind:'auth-create',...structuredClone(options)});return success({authorisationId:'auth-id',scaMethods:[{authenticationMethodId:'mbid'}],scaStatus:'received'});},
    startAuthorisation:async options=>{calls.push({method:'PUT',kind:'auth-start',...structuredClone(options)});return {...success({scaStatus:'started'}),...(!hooks.decoupled?{authorisationUrl:`https://oauth.sandbox.openbankingplatform.com/connect/authorize?state=${options.state}`}:{})};},
    readAuthorisation:async options=>{calls.push({method:'GET',kind:'auth-read',...structuredClone(options)});return success({scaStatus:'started'});},
    renewAuthorisation:options=>{calls.push({method:'LOCAL',kind:'auth-renew',...structuredClone(options)});return {ok:true,authorisationUrl:`https://oauth.sandbox.openbankingplatform.com/connect/authorize?state=${options.state}`};},
    completeAuthorisation:async options=>{calls.push({method:'POST',kind:'auth-complete',...structuredClone(options)});return success({activated:true});},
  };
  const service=()=>createBankPayments({getRepository:async()=>repo,sourceProvider:async()=>[structuredClone(approval)],client,env:{OPENPAYMENTS_REDIRECT_URI:'https://scrappilot.test/api/integrations/openpayments/callback'},now:()=>timestamp,
    assertPaymentReady:hooks.assertPaymentReady??(async()=>proof()),onPrepared:hooks.onPrepared,
    onPaymentConfirmed:async item=>{documents.push(structuredClone(item));return hooks.onPaymentConfirmed?hooks.onPaymentConfirmed(item):{documentId:'bank-paid-pdf'};},
    onVerifiedPayment:async item=>{bookkeeping.push(structuredClone(item));return {status:'registered',paymentId:'spiris-payment'};}});
  const payments=service(),input=overrides=>({cardId:CARD,source:{approvalId:approval.id,version:approval.version,hash:snapshot.hash},paymentDetails:details(),...overrides});
  try{await run({payments,repo,approval,snapshot,client,calls,payloads,bookkeeping,documents,service,input,advance:ms=>{timestamp=new Date(timestamp.getTime()+ms);}});}finally{await repo.close();}
}

test('exact bank decimals accept 240 and 240.00; reject negative, zero and excess precision',()=>{
  assert.equal(bankMoneyToCents(240),24000);assert.equal(bankMoneyToCents('240.00'),24000);
  for(const value of ['-240.00','240,00','1.001',0,NaN,null])assert.throws(()=>bankMoneyToCents(value));
});
test('payout reservation never performs a provider POST; creation and signing do not prove payment',()=>fixture(async f=>{
  const prep=await f.payments.prepare(CARD,ctx);assert.equal(prep.canStart,true,prep.issues.join('; '));
  const item=await f.payments.start(f.input(),ctx);assert.equal(item.status,'queued');assert.equal(f.calls.some(call=>call.method==='POST'),false);
  await f.payments.processQueuedPayments();let current=await f.payments.job(item.id,ctx);assert.equal(current.status,'awaiting_authorization');assert.equal(current.canAuthorise,true);
  assert.equal(f.bookkeeping.length,0);assert.equal(f.documents.length,0);
  current=await f.payments.beginAuthorisation(item.id,{},ctx);assert.ok(current.authorisationUrl);assert.equal(f.bookkeeping.length,0);assert.equal(current.status,'awaiting_authorization');
  assert.equal(f.calls.find(call=>call.kind==='auth-create').id,'provider-payment');
}));
test('authenticated callback matches the bound session and only a full ACSC GET records sandbox payment and PDF',()=>fixture(async f=>{
  const item=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();const sign=await f.payments.beginAuthorisation(item.id,{},ctx);
  const state=new URL(sign.authorisationUrl).searchParams.get('state');
  await assert.rejects(()=>f.payments.completeAuthorisation({code:'callback-code',state},{...ctx,sessionKey:'different'}),error=>error.code==='bank_callback_forbidden');
  const result=await f.payments.completeAuthorisation({code:'callback-code',state},ctx);assert.equal(result.job.status,'simulated_paid');
  assert.equal(result.job.bookkeepingStatus,'registered');assert.equal(f.bookkeeping.length,1);assert.equal(f.documents.length,1);
  assert.equal(f.bookkeeping[0].providerResult.status,'ACSC');assert.equal(f.bookkeeping[0].providerResult.paymentDateSource,'sandbox_confirmation');
  assert.ok(await f.payments.readVerifiedPayment(item.id));
  await f.payments.completeAuthorisation({code:'callback-code',state},ctx);assert.equal(f.calls.filter(call=>call.kind==='auth-complete').length,1);
  assert.equal(f.calls.filter(call=>call.kind==='payment'&&call.method==='POST').length,1);
}));
test('safe refresh before sign is GET-only and preserves awaiting authorisation for RCVD',()=>fixture(async f=>{
  const item=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();const result=await f.payments.refresh(item.id,ctx);
  assert.equal(result.status,'awaiting_authorization');assert.equal(result.canAuthorise,true);assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
},{read:async(options,payload,success)=>success({...payload,paymentId:options.id,transactionStatus:'RCVD'})}));
test('decoupled sandbox sign is polled without browser callback and without another POST',()=>fixture(async f=>{
  const item=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();const signed=await f.payments.beginAuthorisation(item.id,{},ctx);
  assert.equal(signed.authorisationUrl,null);assert.equal(signed.status,'pending');f.advance(11000);await f.payments.processQueuedPayments();
  assert.equal((await f.payments.job(item.id,ctx)).status,'simulated_paid');assert.equal(f.calls.filter(call=>call.kind==='payment'&&call.method==='POST').length,1);
},{decoupled:true}));
test('concurrent reservations and workers dispatch exactly one bank payment',()=>fixture(async f=>{
  const second=f.service(),items=await Promise.all(Array.from({length:8},(_,i)=>(i%2?second:f.payments).start(f.input(),ctx)));
  assert.equal(new Set(items.map(item=>item.id)).size,1);await Promise.all([f.payments.processQueuedPayments(),second.processQueuedPayments()]);
  assert.equal(f.calls.filter(call=>call.kind==='payment'&&call.method==='POST').length,1);
}));
test('a lost POST reply keeps the card reserved across restart and can never auto-resend',()=>fixture(async f=>{
  const item=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();assert.equal((await f.payments.job(item.id,ctx)).status,'unknown');
  const restarted=f.service();assert.equal((await restarted.start(f.input(),ctx)).id,item.id);f.advance(120000);await restarted.processQueuedPayments();await restarted.refresh(item.id,ctx);
  assert.equal(f.calls.filter(call=>call.kind==='payment'&&call.method==='POST').length,1);assert.equal(f.bookkeeping.length,0);
  await assert.rejects(()=>restarted.assertNoManagedPayment(CARD),error=>error.code==='bank_payment_reserved');
},{create:async()=>({ok:false,environment:'sandbox',uncertain:true,error:{code:'bank_transport_unknown',message:'timeout'}})}));
test('201 with claimed ACSC still requires matching authenticated GET',()=>fixture(async f=>{
  const item=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();assert.equal((await f.payments.job(item.id,ctx)).status,'pending');assert.equal(f.bookkeeping.length,0);
  f.advance(11000);await f.payments.processQueuedPayments();assert.equal((await f.payments.job(item.id,ctx)).status,'simulated_paid');
},{create:async(options,success)=>success({...options.payload,paymentId:'provider-payment',transactionStatus:'ACSC'},201)}));
for(const field of ['amount','currency','creditor','debtor','reference','environment'])test(`ACSC mismatched ${field} never records payment`,()=>fixture(async f=>{
  const item=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();const result=await f.payments.refresh(item.id,ctx);
  assert.equal(result.status,'unknown');assert.equal(result.error.code,'bank_response_mismatch');assert.equal(f.bookkeeping.length,0);assert.equal(f.documents.length,0);assert.equal(await f.payments.readVerifiedPayment(item.id),null);
},{read:async(options,payload,success)=>{const response={...payload,paymentId:options.id,transactionStatus:'ACSC'};
  if(field==='amount')response.instructedAmount={amount:'241.00',currency:'SEK'};
  if(field==='currency')response.instructedAmount={amount:'240.00',currency:'EUR'};
  if(field==='creditor')response.creditorAccount={...payload.creditorAccount,accountNumber:'44444444'};
  if(field==='debtor')response.debtorAccount={iban:'SE3550000000054910000003',currency:'SEK'};
  if(field==='reference')response.remittanceInformationUnstructured='ANOTHER-INVOICE';
  return {...success(response),...(field==='environment'?{environment:'production'}:{})};}}));
test('a changed Spiris connection after reservation blocks before dispatch and never pays',()=>fixture(async f=>{
  const item=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();assert.equal((await f.payments.job(item.id,ctx)).status,'blocked');assert.equal(f.calls.filter(call=>call.kind==='payment'&&call.method==='POST').length,0);
},{assertPaymentReady:async(_source,{fresh})=>({...proof(),generation:fresh?'generation-b':'generation-a'})}));
test('actual and effective permission plus site scope are both required',()=>fixture(async f=>{
  await f.repo.transact(state=>{const admin=state.pricing.users.find(item=>item.id==='admin');admin.level='Medarbetare';admin.permissions=[];});
  await assert.rejects(()=>f.payments.start(f.input(),ctx),error=>error.status===403);
  await f.repo.transact(state=>{const admin=state.pricing.users.find(item=>item.id==='admin');admin.permissions=['pay'];admin.siteIds=['rimbo'];});
  await assert.rejects(()=>f.payments.start(f.input(),ctx),error=>error.code==='bank_site_forbidden');
}));
test('revoked queued worker authority and tenant settings block before provider POST',()=>fixture(async f=>{
  const item=await f.payments.start(f.input(),ctx);await f.repo.transact(state=>{const admin=state.pricing.users.find(user=>user.id==='admin');admin.level='Medarbetare';admin.permissions=[];});
  await f.payments.processQueuedPayments();assert.equal(await f.repo.read(state=>state.bankPayments.jobs[item.id].status),'blocked');assert.equal(f.calls.filter(call=>call.kind==='payment'&&call.method==='POST').length,0);
}));
test('recipient edits require a reason and preserve the original frozen card; amount cannot be overridden',()=>fixture(async f=>{
  const changed={...details(),account:'44444444'};await assert.rejects(()=>f.payments.start(f.input({paymentDetails:changed}),ctx),error=>error.code==='bank_override_reason_required');
  const item=await f.payments.start(f.input({paymentDetails:changed,reason:'Kunden bekräftade nytt konto'}),ctx);assert.equal(item.amountCents,24000);assert.equal(item.originalPaymentDetails.account,'1234567890');
  assert.equal(await f.repo.read(state=>state.office.cards.find(value=>value.id===CARD).paymentDetails.account),'1234567890');
  await assert.rejects(()=>f.payments.start(f.input({amount:1}),ctx),error=>error.status===422);
}));
test('edited recipient data cannot diverge from the persisted provider payload before dispatch',()=>fixture(async f=>{
  const item=await f.payments.start(f.input(),ctx);await f.repo.transact(state=>{state.bankPayments.jobs[item.id].paymentDetails.account='44444444';});await f.payments.processQueuedPayments();
  assert.equal((await f.payments.job(item.id,ctx)).status,'blocked');assert.equal(f.calls.filter(call=>call.kind==='payment'&&call.method==='POST').length,0);
}));
test('Swish and bank reservations share one durable cross-provider card guard',()=>fixture(async f=>{
  const item=await f.payments.start(f.input(),ctx);
  const swish=createSwishPayments({getRepository:async()=>f.repo,sourceProvider:async()=>[structuredClone(f.approval)],client:{configurationStatus:async()=>({ready:true,mode:'mss',merchantAlias:'1234679304'})},env:{},assertPaymentReady:async()=>proof()});
  await swish.saveSettings({enabled:true},ctx);
  await assert.rejects(()=>swish.start({cardId:CARD,paymentDetails:{method:'swish',phone:'+46711111132',recipient:'Erik Johansson',personalNumber:'197709306828'},reason:'Byte till Swish'},ctx),error=>error.code==='payment_already_reserved');
  await assert.rejects(()=>f.payments.assertNoManagedPayment(CARD),error=>error.code==='bank_payment_reserved');assert.equal((await f.payments.getCardJobs(CARD,ctx))[0].id,item.id);
}));
test('a Swish reservation, even unknown, blocks starting a bank payout',()=>fixture(async f=>{
  await f.repo.transact(state=>{state.swishPayments={organisationId:'jeroc-demo',jobs:{existing:{id:'prior',source:{cardId:CARD},status:'unknown'}}};});
  await assert.rejects(()=>f.payments.start(f.input(),ctx),error=>error.code==='payment_already_reserved');
  assert.equal(f.calls.filter(call=>call.kind==='payment'&&call.method==='POST').length,0);
}));
test('AIS consent uses its remote ID, persists expiry and only permits accounts returned by the chosen bank',()=>fixture(async f=>{
  const consent=await f.payments.connectConsent({},ctx);assert.ok(consent.authorisationUrl);assert.ok(consent.expiresAt);assert.equal(f.calls.find(call=>call.kind==='auth-create').id,'consent-new');
  const state=new URL(consent.authorisationUrl).searchParams.get('state');await f.payments.completeAuthorisation({code:'consent-code',state},ctx);
  const accounts=await f.payments.getAccounts(ctx);assert.equal(accounts.accounts[0].id,ACCOUNT);
  await assert.rejects(()=>f.payments.saveSettings({enabled:true,debtorAccountId:'unverified-other-account'},ctx),error=>error.code==='bank_account_invalid');
  await f.payments.saveSettings({enabled:true,debtorAccountId:ACCOUNT},ctx);assert.equal((await f.payments.balances(ctx)).ok,true);
}));
test('failed AIS callback preserves safe diagnostics, hides its consumed link and explicitly reauthorises the same consent once',()=>fixture(async f=>{
  let activated=false;
  f.client.readConsentStatus=async options=>{f.calls.push({method:'GET',kind:'consent',id:options.id});return {ok:true,data:{consentStatus:activated?'valid':'received'}};};
  f.client.completeAuthorisation=async options=>{f.calls.push({method:'POST',kind:'auth-complete',...structuredClone(options)});
    return activated?{ok:true,statusCode:200,data:{activated:true}}:{ok:false,statusCode:400,uncertain:false,
      error:{code:'bank_authorisation_activation_failed',message:'Activation rejected',providerCodes:['invalid_grant']},
      journal:{method:'POST',path:'/connect/token',statusCode:400,request:{code:options.code},response:{error:'invalid_grant',error_description:options.code}}};};
  const consent=await f.payments.connectConsent({},ctx),oldState=new URL(consent.authorisationUrl).searchParams.get('state');
  const query={code:'synthetic-consumed-code-must-not-persist',state:oldState};
  await assert.rejects(()=>f.payments.completeAuthorisation(query,ctx),error=>error.code==='bank_consent_pending');
  let current=(await f.payments.settings(ctx)).consent;
  assert.equal(current.authorisationUrl,null);assert.equal(current.canReauthorise,true);
  assert.equal(current.authorisationDiagnostics.httpStatus,400);assert.deepEqual(current.authorisationDiagnostics.providerCodes,['invalid_grant']);
  assert.equal(JSON.stringify(await f.repo.read(state=>state.bankPayments)).includes(query.code),false);
  await assert.rejects(()=>f.payments.completeAuthorisation(query,ctx),error=>error.code==='bank_consent_pending');
  assert.equal(f.calls.filter(call=>call.kind==='auth-complete').length,1);
  const restarted=await Promise.all([f.payments.connectConsent({},ctx),f.payments.connectConsent({},ctx)]);
  current=(await f.payments.settings(ctx)).consent;
  assert.equal(current.id,consent.id);assert.equal(current.providerConsentId,consent.providerConsentId);
  assert.equal(f.calls.filter(call=>call.kind==='consent'&&call.method==='POST').length,1);
  assert.equal(f.calls.filter(call=>call.kind==='auth-create').length,1);assert.equal(f.calls.filter(call=>call.kind==='auth-renew').length,1);
  assert.equal(f.calls.filter(call=>call.kind==='auth-start').length,1);
  assert.ok(restarted.some(item=>item.authorisationUrl));assert.equal(current.canReauthorise,false);
  const newState=new URL(current.authorisationUrl).searchParams.get('state');assert.notEqual(newState,oldState);
  await assert.rejects(()=>f.payments.completeAuthorisation(query,ctx),error=>error.code==='bank_callback_state_invalid');
  activated=true;await f.payments.completeAuthorisation({code:'synthetic-new-code',state:newState},ctx);
  current=(await f.payments.settings(ctx)).consent;assert.equal(current.status,'valid');assert.equal(current.authorisationUrl,null);
  assert.equal(current.authorisationDiagnostics.ok,true);assert.equal(f.bookkeeping.length,0);assert.equal(f.documents.length,0);
}));
test('uncertain AIS activation reconciles the existing consent and SCA before any explicit replacement signing',()=>fixture(async f=>{
  let consentValid=false,scaReadable=false;
  f.client.readConsentStatus=async options=>{f.calls.push({method:'GET',kind:'consent',id:options.id});return {ok:true,data:{consentStatus:consentValid?'valid':'received'}};};
  f.client.readAuthorisation=async options=>{f.calls.push({method:'GET',kind:'auth-read',...options});return scaReadable?{ok:true,data:{scaStatus:'started'}}:{ok:false};};
  f.client.completeAuthorisation=async()=>({ok:false,statusCode:500,uncertain:true,error:{code:'bank_authorisation_activation_failed',message:'Synthetic upstream 500'}});
  const consent=await f.payments.connectConsent({},ctx),state=new URL(consent.authorisationUrl).searchParams.get('state');
  await assert.rejects(()=>f.payments.completeAuthorisation({code:'synthetic-timeout-code',state},ctx),error=>error.code==='bank_consent_pending');
  assert.equal((await f.payments.settings(ctx)).consent.canReauthorise,false);
  assert.equal((await f.payments.settings(ctx)).consent.authorisationDiagnostics.httpStatus,500);
  const count=f.calls.filter(call=>call.kind==='auth-create').length;
  await assert.rejects(()=>f.payments.connectConsent({},ctx),error=>error.code==='bank_consent_reauthorisation_blocked');
  assert.equal(f.calls.filter(call=>call.kind==='auth-create').length,count);
  scaReadable=true;const restart=await f.payments.connectConsent({},ctx);assert.equal(restart.id,consent.id);assert.ok(restart.authorisationUrl);
  assert.equal(f.calls.filter(call=>call.kind==='consent'&&call.method==='POST').length,1);
  assert.equal(f.calls.filter(call=>call.kind==='auth-create').length,count);
}));
test('an uncertain OAuth callback that already activated its consent is reconciled without creating any new consent or signing',()=>fixture(async f=>{
  let consentValid=false;
  f.client.readConsentStatus=async options=>{f.calls.push({method:'GET',kind:'consent',id:options.id});return {ok:true,data:{consentStatus:consentValid?'valid':'received'}};};
  f.client.completeAuthorisation=async()=>({ok:false,uncertain:true,error:{code:'bank_authorisation_activation_unknown',message:'Synthetic timeout'}});
  const consent=await f.payments.connectConsent({},ctx),state=new URL(consent.authorisationUrl).searchParams.get('state');
  await assert.rejects(()=>f.payments.completeAuthorisation({code:'synthetic-timeout-code',state},ctx),error=>error.code==='bank_consent_pending');
  consentValid=true;const recovered=await f.payments.connectConsent({},ctx);
  assert.equal(recovered.id,consent.id);assert.equal(recovered.status,'valid');assert.equal(recovered.authorisationUrl,null);
  assert.equal(recovered.error,null);assert.equal(recovered.canReauthorise,false);
  assert.equal(f.calls.filter(call=>call.kind==='consent'&&call.method==='POST').length,1);
  assert.equal(f.calls.filter(call=>call.kind==='auth-create').length,1);
}));
test('an obsolete consent callback cannot activate the previous bank or retrieve accounts for a replacement connection',()=>fixture(async f=>{
  const consent=await f.payments.connectConsent({},ctx),state=new URL(consent.authorisationUrl).searchParams.get('state');
  await f.payments.saveSettings({enabled:true,bankId:'NDEASESS'},ctx);
  await assert.rejects(()=>f.payments.completeAuthorisation({code:'synthetic-obsolete-callback',state},ctx),error=>error.code==='bank_connection_changed');
  assert.equal(f.calls.filter(call=>call.kind==='auth-complete').length,0);
}));
test('bank identity changes during OAuth activation prevent the old reply from updating or querying the new consent',()=>fixture(async f=>{
  let start,finish;const started=new Promise(resolve=>{start=resolve;}),gate=new Promise(resolve=>{finish=resolve;});
  const consent=await f.payments.connectConsent({},ctx),state=new URL(consent.authorisationUrl).searchParams.get('state');
  f.client.completeAuthorisation=async()=>{start();await gate;return {ok:true,statusCode:200,data:{activated:true}};};
  const callback=f.payments.completeAuthorisation({code:'synthetic-gated-callback',state},ctx);await started;
  const reads=f.calls.filter(call=>call.kind==='consent'&&call.method==='GET').length;
  await f.payments.saveSettings({enabled:true,bankId:'NDEASESS'},ctx);finish();
  await assert.rejects(()=>callback,error=>error.code==='bank_connection_changed');
  assert.equal(f.calls.filter(call=>call.kind==='consent'&&call.method==='GET').length,reads);
}));
test('expired or revoked account consent prevents bank dispatch',()=>fixture(async f=>{
  const item=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();assert.equal((await f.payments.job(item.id,ctx)).status,'blocked');assert.equal(f.calls.filter(call=>call.kind==='payment'&&call.method==='POST').length,0);
},{consentRead:async(_options,success)=>success({consentStatus:'revokedByPsu'})}));
test('changed bank identity clears old consent and account selection',()=>fixture(async f=>{
  await f.payments.saveSettings({enabled:true,bankId:'NDEASESS'},ctx);const result=await f.payments.settings(ctx);assert.equal(result.consent,null);assert.deepEqual(result.accounts,[]);assert.equal(result.settings.debtorAccountId,null);
}));
test('bank discovery uses BIC and explicit connection test saves bounded safe diagnostics',()=>fixture(async f=>{
  assert.equal((await f.payments.banks(ctx)).banks[0].id,BANK);const testResult=await f.payments.testConnection(ctx);assert.ok(Array.isArray(testResult.journal));assert.equal((await f.payments.settings(ctx)).lastTest.ok,true);
}));
test('foreign IBAN and currency are not silently converted into domestic SEK payments',()=>fixture(async f=>{
  await assert.rejects(()=>f.payments.start(f.input({paymentDetails:{method:'bank',bankType:'iban',iban:'DE89370400440532013000',holder:'Erik Johansson'},reason:'Foreign'}),ctx),error=>error.code==='bank_country_unsupported');
  assert.equal(f.calls.filter(call=>call.kind==='payment'&&call.method==='POST').length,0);
}));
test('PDF retry is independent and never creates another bank payment or Spiris payment',()=>{
  let attempts=0;return fixture(async f=>{const item=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();await f.payments.refresh(item.id,ctx);
    assert.equal((await f.payments.job(item.id,ctx)).paymentDocumentStatus,'failed');assert.equal(f.bookkeeping.length,1);f.advance(61000);await f.payments.processQueuedPayments();
    assert.equal((await f.payments.job(item.id,ctx)).paymentDocumentStatus,'archived');assert.equal(f.calls.filter(call=>call.kind==='payment'&&call.method==='POST').length,1);assert.equal(f.bookkeeping.length,1);
  },{onPaymentConfirmed:async()=>{if(++attempts===1)throw new Error('PDF failed');return {documentId:'retried-paid-pdf'};}});
});

test('a late callback token response cannot downgrade an already verified ACSC payment or change its receipt',()=>fixture(async f=>{
  let release,entered;const gated=new Promise(resolve=>{entered=resolve;});const held=new Promise(resolve=>{release=resolve;});
  f.client.completeAuthorisation=async options=>{f.calls.push({method:'POST',kind:'auth-complete',...options});entered();await held;return {ok:true,environment:'sandbox',data:{activated:true},statusCode:200};};
  const item=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();const sign=await f.payments.beginAuthorisation(item.id,{},ctx);
  const query={code:'held-code',state:new URL(sign.authorisationUrl).searchParams.get('state')};const callback=f.payments.completeAuthorisation(query,ctx);await gated;
  await f.payments.refresh(item.id,ctx);const proofBefore=await f.payments.readVerifiedPayment(item.id);assert.ok(proofBefore);f.advance(10000);release();await callback;
  const proofAfter=await f.payments.readVerifiedPayment(item.id);assert.equal(proofAfter.status,'simulated_paid');assert.deepEqual(proofAfter.providerResult,proofBefore.providerResult);
  assert.equal(f.bookkeeping.length,1);assert.equal(f.documents.length,1);
}));
test('legacy default account and empty form fields do not demand a reason or alter frozen history',()=>fixture(async f=>{
  delete f.approval.snapshot.card.paymentDetails.bankType;
  await f.repo.transact(state=>{delete state.office.cards.find(item=>item.id===CARD).paymentDetails.bankType;});
  const item=await f.payments.start(f.input({paymentDetails:{...details(),bank:'',iban:'',bic:'',bankgiro:'',plusgiro:'',bankCountry:'',beneficiaryAddress:'',ocr:''}}),ctx);
  assert.equal(item.reason,'');assert.equal(item.originalPaymentDetails.bankType,undefined);assert.equal(item.events.some(event=>event.action==='payment_details_overridden'),false);
}));
test('concurrent cross-provider starts reserve only one bank or Swish instruction under the same transaction',()=>fixture(async f=>{
  const swish=createSwishPayments({getRepository:async()=>f.repo,sourceProvider:async()=>[structuredClone(f.approval)],client:{configurationStatus:async()=>({ready:true,mode:'mss',merchantAlias:'1234679304'})},env:{},assertPaymentReady:async()=>proof()});
  await swish.saveSettings({enabled:true},ctx);
  const results=await Promise.allSettled([f.payments.start(f.input(),ctx),swish.start({cardId:CARD,paymentDetails:{method:'swish',phone:'+46711111132',recipient:'Erik Johansson',personalNumber:'197709306828'},reason:'Byte till Swish'},ctx)]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);assert.equal(results.find(item=>item.status==='rejected').reason.code,'payment_already_reserved');
  const reserved=await f.repo.read(state=>Object.values(state.bankPayments.jobs).length+Object.values(state.swishPayments.jobs).length);assert.equal(reserved,1);
}));
test('completed receipt proof rejects mutated frozen data or recipient instructions',()=>fixture(async f=>{
  const item=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();await f.payments.refresh(item.id,ctx);assert.ok(await f.payments.readVerifiedPayment(item.id));
  await f.repo.transact(state=>{state.bankPayments.jobs[item.id].sourceSnapshot.card.rows[0].weight=999;});assert.equal(await f.payments.readVerifiedPayment(item.id),null);
}));
test('consent expiry is enforced locally even if the remote status remains valid',()=>fixture(async f=>{
  await f.repo.transact(state=>{state.bankPayments.consents['fixture-consent'].expiresAt='2026-10-12T23:59:59.000Z';});
  await assert.rejects(()=>f.payments.start(f.input(),ctx),error=>error.code==='bank_consent_expired');
  await assert.rejects(()=>f.payments.getAccounts(ctx),error=>error.code==='bank_consent_expired');
}));

test('decoupled pending bank status continues GET polling until actual ACSC',()=>{
  let reads=0;return fixture(async f=>{const item=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();await f.payments.beginAuthorisation(item.id,{},ctx);
    f.advance(11000);await f.payments.processQueuedPayments();assert.equal((await f.payments.job(item.id,ctx)).status,'pending');assert.equal(f.bookkeeping.length,0);
    f.advance(11000);await f.payments.processQueuedPayments();assert.equal((await f.payments.job(item.id,ctx)).status,'simulated_paid');assert.equal(reads,2);
  },{decoupled:true,read:async(options,payload,success)=>success({...payload,paymentId:options.id,transactionStatus:++reads===1?'ACTC':'ACSC'})});
});

test('a proven local/authentication failure permits only an explicit retry while unknown transport keeps reservation',()=>fixture(async f=>{
  const first=await f.payments.start(f.input(),ctx);await f.payments.processQueuedPayments();const failed=await f.payments.job(first.id,ctx);
  assert.equal(failed.status,'failed');assert.equal(failed.events.at(-1).action,'payment_not_sent');
  assert.equal((await f.payments.start(f.input(),ctx)).id,first.id);const retried=await f.payments.start(f.input({retryOf:first.id}),ctx);assert.notEqual(retried.id,first.id);assert.equal(retried.retryOf,first.id);
},{create:async()=>({ok:false,environment:'sandbox',statusCode:null,uncertain:false,error:{code:'bank_authentication_unavailable',message:'OAuth server could not be reached'}})}));
