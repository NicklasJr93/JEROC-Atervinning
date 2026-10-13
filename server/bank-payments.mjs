import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { EnvironmentError } from './environment-storage.mjs';
import { resolvePricingPrincipal } from './pricing.mjs';
import { latestAttestedVismaCards } from './visma-weightcard.mjs';
import { assertNoCrossManagedPayment, findManagedPayment } from './managed-payment-guard.mjs';
import { buildSandboxPaymentPayload, safeOpenPaymentsData } from './openpayments-client.mjs';
import { can, normalizePaymentDetails, bankRecipientError } from '../dist-server/domain-models.mjs';

const DOMAIN = 'bankPayments', LEASE_MS = 45_000, POLL_MS = 10_000;
const copy = value => structuredClone(value), equal = isDeepStrictEqual;
const text = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = (message, status = 422, code = 'bank_invalid') => { throw new EnvironmentError(message, status, code); };
const uuid = z.string().uuid(), opaque = z.string().trim().min(1).max(200);
const settingsSchema = z.object({ enabled: z.boolean(), bankId: opaque.nullable().optional(), corporateId: opaque.nullable().optional(), psuId: opaque.nullable().optional(),
  debtorAccountId: opaque.nullable().optional(), bookkeepingEnabled: z.boolean().optional(), registerSpirisPayment: z.boolean().optional(),
  spirisBankAccountId: uuid.nullable().optional(), spirisCompanyId: opaque.nullable().optional() }).strict();
const paymentSchema = z.object({ method: z.enum(['bank', 'swish', 'cash', 'balance']), bankType: z.enum(['account','bankgiro','plusgiro','iban']).optional(),
  bank: z.string().max(100).optional(), clearing: z.string().max(20).optional(), account: z.string().max(100).optional(), holder: z.string().max(200).optional(),
  bankgiro: z.string().max(30).optional(), plusgiro: z.string().max(30).optional(), iban: z.string().max(50).optional(), bic: z.string().max(20).optional(),
  bankCountry: z.string().max(2).optional(), beneficiaryAddress: z.string().max(500).optional(), ocr: z.string().max(50).optional(),
  phone: z.string().max(100).optional(), recipient: z.string().max(200).optional(), personalNumber: z.string().max(30).optional() }).strict();
const startSchema = z.object({ cardId: z.number().int().positive(), source: z.object({ approvalId: opaque, version: z.number().int().positive(), hash: opaque }).strict().optional(),
  paymentDetails: paymentSchema.optional(), reason: z.string().trim().max(1000).optional(), retryOf: uuid.optional() }).strict();
const authInputSchema = z.object({ authenticationMethodId: opaque.optional() }).strict();
const defaults = () => ({ enabled: false, bookkeepingEnabled: false, registerSpirisPayment: false, revision: 0 });
const initial = organisationId => ({ version: 1, organisationId, settings: defaults(), jobs: {}, audit: [], consents: {}, currentConsentId: null, accounts: [], workIds: [], nextWorkAt: null });
const terminal = job => ['simulated_paid', 'rejected', 'failed', 'blocked', 'cancelled'].includes(job.status);
const blocking = job => !['rejected', 'failed', 'cancelled'].includes(job.status);
const neverSent = job => !job.sentAt && !job.providerPaymentId && !job.events?.some(item => item.action === 'payment_sent');
const safeError = error => ({ code: text(error?.code, 100) || 'bank_request_failed', message: text(error?.message, 300) || 'Banktestet behöver granskas.' });
const exactState = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const itemAmount = cents => `${Math.floor(cents/100)}.${String(cents%100).padStart(2,'0')}`;

export function bankMoneyToCents(value) {
  const decimal = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  const match = decimal.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!match) fail('Beloppet ska anges i kronor med högst två decimaler.', 422, 'bank_amount_invalid');
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) fail('Bankbetalningens belopp måste vara större än noll.', 422, 'bank_amount_invalid');
  return cents;
}

function safeConsent(item) {
  if (!item) return null;
  return copy({ ...Object.fromEntries(['id','providerConsentId','bankId','status','scaStatus','authorisationUrl','authorisationDiagnostics','createdAt','updatedAt','expiresAt','error']
    .filter(key => item[key] !== undefined).map(key => [key,item[key]])),
    ...(item.authorisation?.callbackReservedAt && {authorisationUrl:null}),
    canReauthorise: Boolean(item.providerConsentId && item.status !== 'valid' && item.authorisation?.phase === 'failed' && !item.authorisation?.unknown) });
}
function publicJob(item) {
  if (!item) return null;
  return copy({ ...Object.fromEntries(['id','organisationId','provider','kind','mode','simulation','source','sourceSnapshotHash','sourceSnapshot','amount','amountCents','currency',
    'paymentDetails','originalPaymentDetails','reason','recipient','status','bookkeepingStatus','bookkeeping','createdAt','updatedAt','verifiedAt','finishedAt','events','error','retryOf',
    'request','response','providerInstructionUUID','providerPaymentId','providerPaymentReference','providerProduct','bankId','authorisationUrl','scaStatus','bookingProof',
    'spirisCompanyId','spirisBankAccountId','reservedBy','revisionActor','bookkeepingEnabled','registerSpirisPayment','nextCheckAt','pollSuspended','documentRevision',
    'paymentDocumentStatus','paymentDocumentError','paymentConfirmationDocument','preflightStatus','preflightCheckedAt','authorisationDiagnostics']
    .filter(key => item[key] !== undefined).map(key => [key,item[key]])),
    ...(item.request?{request:{method:item.request.method,path:item.request.path,payload:safeOpenPaymentsData(item.request.payload)}}:{}),
    ...(item.authorisation?.callbackReservedAt && {authorisationUrl:null}),
    canAuthorise: Boolean(item.status === 'awaiting_authorization' && item.providerPaymentId && !item.authorisation?.unknown),
    canResume: Boolean(item.status === 'blocked' && neverSent(item) && item.preflightStatus === 'ready' && !item.lease) });
}
function accountReference(account) {
  const value = account.account ?? account;
  if (value.iban) return { iban: value.iban.replaceAll(' ','').toUpperCase(), currency: 'SEK' };
  if (value.bban) return { bban: value.bban.replaceAll(' ',''), currency: 'SEK' };
  if (value.clearingNumber && value.accountNumber) return { clearingNumber: value.clearingNumber, accountNumber: value.accountNumber, currency: 'SEK' };
  return null;
}
function recipientFor(details) {
  return {name:details.holder,...(details.bankType==='iban'?{iban:details.iban}:details.bankType==='bankgiro'?{bankgiro:details.bankgiro}:details.bankType==='plusgiro'?{plusgiro:details.plusgiro}:{clearing:details.clearing,account:details.account})};
}
function comparableDetails(details) {
  const normalized=normalizePaymentDetails(details);
  if(normalized.method==='bank')normalized.bankType??='account';
  return Object.fromEntries(Object.entries(normalized).filter(([,value])=>value!==undefined&&value!==''));
}
function accountsFrom(data) {
  const values = Array.isArray(data) ? data : data?.accounts ?? [];
  return values.filter(item => item && typeof item === 'object' && item.currency === 'SEK').map(item => ({
    id: text(item.resourceId ?? item.accountId ?? item.id), name: text(item.name ?? item.product ?? 'Bankkonto'), currency: 'SEK',
    ...(accountReference(item) ?? {}),
  })).filter(item => item.id && accountReference(item));
}

/** Tenant journal for real Open Payments SANDBOX requests. HTTP creation, SCA
 * and accepted/pending statuses never prove settlement. Only a matched resource
 * GET with ACSC can archive a simulated-payment PDF or register in Spiris sandbox. */
export function createBankPayments({ getRepository, sourceProvider = async () => [], client, env = process.env, now = () => new Date(),
  authorizeContext = async () => {}, assertPaymentReady = async () => fail('Bokför underlaget i Spiris före utbetalning.',409,'bank_invoice_unbooked'),
  onPrepared, onPaymentConfirmed, onVerifiedPayment } = {}) {
  if (typeof getRepository !== 'function' || !client) throw new TypeError('getRepository och Open Payments-klient krävs.');
  const organisationId = env.SCRAPPILOT_ORGANISATION_ID ?? env.JEROC_TENANT_ID ?? 'jeroc-demo';
  const clock = () => new Date(now()), nextAt = (delay = POLL_MS) => new Date(clock().getTime() + delay).toISOString();
  let processing = null;
  const domain = (state, create = false) => {
    if (!state[DOMAIN]) { if (!create) return initial(organisationId); state[DOMAIN] = initial(organisationId); }
    const value = state[DOMAIN];
    if (value.organisationId !== organisationId) fail('Bankjournalen tillhör ett annat bolag.',403,'bank_tenant_mismatch');
    value.consents ??= {}; value.accounts ??= []; return value;
  };
  const read = async (operation, paths) => { const repo = await getRepository(); return paths && repo.readProjection
    ? repo.readProjection(state => operation(domain(state)), {domain:DOMAIN,paths})
    : repo.read(state => operation(domain(state)), {domains:[DOMAIN]}); };
  const paymentDocumentWork = item => Boolean(onPaymentConfirmed && item.status === 'simulated_paid' && item.paymentDocumentStatus !== 'archived' && (item.paymentDocumentAttempts ?? 0) < 5);
  const bookkeepingWork = item => Boolean(onVerifiedPayment && item.status === 'simulated_paid' && item.registerSpirisPayment && !['registered','failed','blocked','paused'].includes(item.bookkeepingStatus));
  function indexWork(value) {
    const due = item => item.status === 'simulated_paid' ? [
      ...(paymentDocumentWork(item) ? [item.paymentDocumentLease?.expiresAt ?? item.paymentDocumentNextCheckAt ?? item.createdAt] : []),
      ...(bookkeepingWork(item) ? [item.bookkeepingLease?.expiresAt ?? item.bookkeepingNextCheckAt ?? item.createdAt] : []),
    ].sort()[0] ?? item.createdAt : item.lease?.expiresAt ?? item.nextCheckAt ?? item.createdAt;
    const active = Object.values(value.jobs).filter(item => !terminal(item) && item.status !== 'awaiting_authorization' && !item.pollSuspended || paymentDocumentWork(item) || bookkeepingWork(item));
    active.sort((a,b) => due(a).localeCompare(due(b))); value.workIds = active.map(item => item.id); value.nextWorkAt = active.length ? due(active[0]) : null;
  }
  const transaction = async operation => (await getRepository()).transact((state,revision,audit) => {
    const value = domain(state,true), result = operation(value,state,audit); indexWork(value); return result;
  });
  function scoped(context) {
    if (context?.organisationId !== organisationId || !context.actorId || !context.effectiveUserId || !context.sessionKey)
      fail('En aktiv betalningssession för detta bolag krävs.',403,'bank_forbidden');
  }
  function principalIn(state,context,{admin=false,siteId}={}) {
    scoped(context); const principal = resolvePricingPrincipal(state.pricing?.users ?? [],context.actorId,context.effectiveUserId);
    for (const user of [principal.actor,principal.user]) {
      if (!can(user,admin?'integrationsManage':'pay')) fail(admin?'Behörighet att hantera integrationer krävs.':'Behörighet att göra utbetalningar krävs.',403,'bank_forbidden');
      if (admin && Array.isArray(user.siteIds) || siteId && Array.isArray(user.siteIds) && !user.siteIds.includes(siteId))
        fail('Du saknar åtkomst till betalningens anläggning.',403,'bank_site_forbidden');
    }
    return principal;
  }
  async function authorize(context,options) { scoped(context); await authorizeContext(context); return (await getRepository()).read(state=>principalIn(state,context,options),{domains:['pricing']}); }
  function event(item,action,context,details={}) {
    item.events ??= []; item.events.push({id:randomUUID(),at:clock().toISOString(),action,actualUserId:context?.actorId??'service:openpayments',
      effectiveUserId:context?.effectiveUserId??'service:openpayments',...copy(details)}); item.updatedAt = clock().toISOString();
  }
  const workerContext = item => ({organisationId,actorId:item.authorization.actorId,effectiveUserId:item.authorization.effectiveUserId,sessionKey:'durable-bank-instruction'});
  function authorisationDiagnostics(result, stage, secrets = []) {
    const sensitive=[env.OPENPAYMENTS_CLIENT_SECRET,...secrets];
    const status = result?.statusCode;
    const codes = [...new Set([...(result?.error?.providerCodes ?? []), result?.data?.error, result?.data?.code]
      .filter(code => typeof code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(code)
        && !sensitive.some(secret=>typeof secret==='string' && secret.length>=4 && code.includes(secret))))].slice(0,20);
    const journal = (Array.isArray(result?.journal) ? result.journal : result?.journal ? [result.journal] : []).slice(-8);
    return { stage, checkedAt:clock().toISOString(), ok:result?.ok === true,
      httpStatus:Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      errorCode:result?.error?.code ? text(result.error.code,100) : null, providerCodes:codes,
      journal:safeOpenPaymentsData(journal,0,sensitive) };
  }
  async function configuration() {
    const config = await client.configurationStatus();
    if ((config.mode ?? config.environment) !== 'sandbox') return {...config,ready:false,issues:[...(config.issues??[]),'Endast Open Payments sandbox stöds.']};
    return {...config,redirectUri:env.OPENPAYMENTS_REDIRECT_URI ?? (env.RENDER_EXTERNAL_URL ? `${env.RENDER_EXTERNAL_URL.replace(/\/$/,'')}/api/integrations/openpayments/callback` : null)};
  }
  const providerContext = (settings,context={}) => ({bankId:settings.bankId,psuId:settings.psuId,corporateId:settings.corporateId,
    psuIp:context.psuIp ?? context.ipAddress ?? '127.0.0.1',userAgent:context.userAgent ?? 'ScrapPilot Sandbox'});
  function assertProviderConfiguration(settings) {
    if (!settings.bankId || !settings.psuId || !settings.corporateId) fail('Välj testbank och ange testföretag samt bankanvändare i Integrationer.',409,'bank_settings_incomplete');
  }
  function selectedAccount(value) {
    const consent = value.consents[value.currentConsentId];
    if (!consent || consent.status !== 'valid' || consent.bankId !== value.settings.bankId || consent.corporateId !== value.settings.corporateId || consent.psuId !== value.settings.psuId)
      fail('Anslut testbanken och godkänn tillgång till konton först.',409,'bank_consent_required');
    if (consent.expiresAt && Date.parse(consent.expiresAt) <= clock().getTime()) fail('Bankmedgivandet har gått ut. Anslut banken igen.',409,'bank_consent_expired');
    const account = value.accounts.find(item => item.id === value.settings.debtorAccountId);
    if (!account || !accountReference(account)) fail('Välj ett verifierat SEK-konto från testbanken.',409,'bank_account_required');
    return {consent,account};
  }
  async function initialize() { await transaction(()=>undefined); }
  async function integrationStatus() {
    const value = await read(item=>({settings:copy(item.settings),connection:copy(item.connection??null)}),[['organisationId'],['settings'],['connection']]);
    const enabled = value.settings.enabled && env.OPENPAYMENTS_ENVIRONMENT !== 'production';
    return {mode:'test',configured:enabled,connected:Boolean(enabled&&value.connection?.lastVerifiedAt),simulation:true,
      lastCheckedAt:value.connection?.lastCheckedAt??null,missing:enabled?[]:['Aktivera Open Payments sandbox under Integrationer.']};
  }
  async function settings(context) {
    await authorize(context,{admin:true}); const value = await read(copy);
    return {settings:copy(value.settings),configuration:await configuration(),mode:'sandbox',simulation:true,lastTest:copy(value.lastTest??null),
      consent:safeConsent(value.consents[value.currentConsentId]),accounts:copy(value.accounts)};
  }
  async function saveSettings(input,context) {
    const parsed = settingsSchema.safeParse(input); if (!parsed.success) fail('Kontrollera bankinställningarna.',422,'bank_settings_invalid');
    await authorize(context,{admin:true});
    await transaction((value,state,audit)=>{
      principalIn(state,context,{admin:true});
      const next = {...value.settings,...parsed.data};
      if (next.debtorAccountId && !value.accounts.some(item=>item.id===next.debtorAccountId)) fail('Välj ett konto som hämtats från denna testbank.',422,'bank_account_invalid');
      const identityChanged = ['bankId','psuId','corporateId'].some(key=>(next[key]??'')!==(value.settings[key]??''));
      if (identityChanged) { value.currentConsentId=null; value.accounts=[]; next.debtorAccountId=null; }
      const bookkeepingEnabled = parsed.data.bookkeepingEnabled ?? parsed.data.registerSpirisPayment ?? value.settings.bookkeepingEnabled ?? false;
      value.settings = {...next,bookkeepingEnabled,registerSpirisPayment:bookkeepingEnabled,revision:value.settings.revision+1,updatedAt:clock().toISOString(),
        updatedBy:{actualUserId:context.actorId,effectiveUserId:context.effectiveUserId}};
      const entry={id:randomUUID(),at:clock().toISOString(),action:'bank_settings_saved',actualUserId:context.actorId,effectiveUserId:context.effectiveUserId,revision:value.settings.revision};
      value.audit.push(entry); audit?.push(entry);
    });
    return settings(context);
  }
  async function banks(context) {
    await authorize(context,{admin:true}); const result=await client.banks();
    if (!result.ok) fail(result.error?.message??'Banklistan kunde inte hämtas.',502,result.error?.code??'bank_choices_failed');
    const rows=Array.isArray(result.data)?result.data:result.data?.aspsps??result.data?.banks??[];
    return {banks:rows.map(item=>({id:text(item.bicFi??item.id??item.aspspId),name:text(item.name??item.bicFi??item.bic??'Testbank'),...(item.countryCode??item.country?{countryCode:item.countryCode??item.country}:{}),
      ...(item.globalPaymentProducts?{paymentProducts:copy(item.globalPaymentProducts)}:{})})).filter(item=>item.id),configuration:await configuration(),simulation:true,journal:result.journal};
  }
  async function testConnection(context) {
    await authorize(context,{admin:true}); const result=await client.testConnection();
    const response={...result,checkedAt:clock().toISOString(),journal:Array.isArray(result.journal)?result.journal:result.journal?[result.journal]:[]};
    await transaction((value,state)=>{principalIn(state,context,{admin:true});value.connection={lastCheckedAt:clock().toISOString(),
      ...(result.ok?{lastVerifiedAt:clock().toISOString()}:{}),lastError:result.ok?null:safeError(result.error)};value.lastTest=copy(response);});
    return response;
  }
  function redirectUri() {
    const value=env.OPENPAYMENTS_REDIRECT_URI ?? (env.RENDER_EXTERNAL_URL ? `${env.RENDER_EXTERNAL_URL.replace(/\/$/,'')}/api/integrations/openpayments/callback` : null);
    if (!value) fail('Lägg till den registrerade OPENPAYMENTS_REDIRECT_URI i servermiljön.',409,'bank_redirect_missing');
    let url;try{url=new URL(value);}catch{fail('Bankkopplingens returadress är ogiltig.',409,'bank_redirect_invalid');}
    if(url.protocol!=='https:'||url.username||url.password||url.hash) fail('Bankkopplingens returadress måste vara en HTTPS-adress.',409,'bank_redirect_invalid');
    return url.toString();
  }
  async function createRedirectAuthorisation({resource,id,product,bankId,psuId,corporateId,existingAuthorisationId},context,input,save) {
    const uri=redirectUri(),state=randomUUID()+randomUUID();
    await save({phase:'creating',stateHash:hash(state),redirectUri:uri,context:{actorId:context.actorId,effectiveUserId:context.effectiveUserId,sessionHash:hash(context.sessionKey)},expiresAt:nextAt(15*60_000),
      ...(existingAuthorisationId && {authorisationId:existingAuthorisationId})});
    const options={resource,id,product,...providerContext({bankId,psuId,corporateId},context),redirectUri:uri};
    if(existingAuthorisationId){
      const renewed=client.renewAuthorisation({...options,authorisationId:existingAuthorisationId,state});
      if(!renewed.ok){await save({phase:'failed',error:safeError(renewed.error)});return null;}
      await save({phase:'started',authorisationId:existingAuthorisationId,authorisationUrl:renewed.authorisationUrl,scaStatus:'started',error:null});
      return {authorisationUrl:renewed.authorisationUrl,scaStatus:'started'};
    }
    const created=await client.createAuthorisation(options);
    if(!created.ok) {await save({phase:created.uncertain?'unknown':'failed',unknown:Boolean(created.uncertain),error:safeError(created.error)});return null;}
    const authId=created.data?.authorisationId??created.data?.authorizationId;
    if(!authId){await save({phase:'unknown',unknown:true,error:{code:'bank_authorisation_missing',message:'Bankens signerings-ID saknas. Ingen ny signering startas automatiskt.'}});return null;}
    await save({phase:'created',authorisationId:authId,scaStatus:created.data?.scaStatus});
    const methods=created.data?.scaMethods??created.data?.authenticationMethods??[];
    const method=input.authenticationMethodId??methods[0]?.authenticationMethodId;
    if(!method||!methods.some(item=>item.authenticationMethodId===method)){
      await save({phase:'failed',error:{code:'bank_authorisation_method_missing',message:'Banken har inte lämnat en verifierad signeringsmetod.'}});return null;
    }
    await save({phase:'starting',authenticationMethodId:method});
    const started=await client.startAuthorisation({...options,authorisationId:authId,...(method?{authenticationMethodId:method}:{}),redirectUri:uri,state});
    if(!started.ok){await save({phase:started.uncertain?'unknown':'failed',unknown:Boolean(started.uncertain),error:safeError(started.error)});return null;}
    const authorisationUrl=started.authorisationUrl??null;
    if(authorisationUrl){let parsed;try{parsed=new URL(authorisationUrl);}catch{}
      if(!parsed||!['https://oauth.sandbox.openbankingplatform.com','https://auth.sandbox.openbankingplatform.com'].includes(parsed.origin)
        ||parsed.pathname!=='/connect/authorize'||parsed.username||parsed.password||parsed.hash){
        await save({phase:'unknown',unknown:true,error:{code:'bank_authorisation_link_invalid',message:'Bankens godkännandelänk kunde inte verifieras.'}});return null;
      }
    }
    await save({phase:'started',authorisationUrl,scaStatus:started.data?.scaStatus,error:null});
    return {authorisationUrl,scaStatus:started.data?.scaStatus};
  }
  async function connectConsent(input={},context) {
    const parsed=authInputSchema.safeParse(input);if(!parsed.success)fail('Kontrollera bankanslutningen.');
    await authorize(context,{admin:true});await configuration().then(config=>{if(!config.ready)fail('Open Payments sandbox är inte konfigurerad.',409,'bank_not_configured');});
    const current=await read(value=>copy(value.consents[value.currentConsentId]??null));
    const retry=Boolean(current?.providerConsentId && ['failed','unknown'].includes(current.authorisation?.phase)
      && (current.authorisation?.callbackReservedAt || current.authorisation?.phase === 'failed'));
    let existingAuthorisationId;
    if(retry){
      // A consumed OAuth code is never replayed. First inspect the exact same
      // consent; a timeout may still have activated it at the provider.
      const checked=await client.readConsentStatus({id:current.providerConsentId,...providerContext(current,context)});
      if(!checked.ok)fail(checked.error?.message??'Medgivandet kunde inte kontrolleras.',502,checked.error?.code??'bank_consent_failed');
      const status=checked.data?.consentStatus??checked.data?.status;
      if(status==='valid'){await getAccounts(context,current.id);return safeConsent(await read(value=>value.consents[current.id]));}
      if(!['received','partiallyAuthorised'].includes(status))fail('Kontrollera det tidigare bankmedgivandets status före ny signering.',409,'bank_consent_reauthorisation_blocked');
      if(current.authorisation?.authorisationId){
        const checkedAuth=await client.readAuthorisation?.({resource:'consent',id:current.providerConsentId,
          authorisationId:current.authorisation.authorisationId,...providerContext(current,context)});
        if(!checkedAuth?.ok || checkedAuth.data?.scaStatus!=='started')
          fail('Bankens tidigare signering måste kunna kontrolleras före en ny signering.',409,'bank_consent_reauthorisation_blocked');
        existingAuthorisationId=current.authorisation.authorisationId;
      }
    }
    const reservation=await transaction((value,state)=>{
      principalIn(state,context,{admin:true});assertProviderConfiguration(value.settings);
      const active=value.consents[value.currentConsentId];
      if(retry && (active?.id!==current.id || ['bankId','corporateId','psuId'].some(key=>active[key]!==value.settings[key])))
        fail('Bankkopplingen ändrades under kontrollen.',409,'bank_connection_changed');
      if(retry && active?.id===current.id && active.authorisation?.stateHash===current.authorisation?.stateHash
        && ['failed','unknown'].includes(active.authorisation?.phase)){
        if(Date.parse(active.expiresAt)<=clock().getTime())fail('Bankmedgivandet har gått ut. Anslut banken igen.',409,'bank_consent_expired');
        active.authorisationHistory??=[];active.authorisationHistory.push(copy(active.authorisation));
        active.authorisation={phase:'reserved'};active.authorisationUrl=null;active.scaStatus=null;active.error=null;active.status='authorising';
        event(active,'bank_consent_reauthorisation_reserved',context);
        return {item:copy(active),reauthorise:true,existingAuthorisationId};
      }
      if(retry)return {existing:copy(active)};
      if(active&&['creating','authorising','unknown'].includes(active.status))return {existing:copy(active)};
      const id=randomUUID(),validUntil=new Date(clock().getTime()+30*86_400_000).toISOString().slice(0,10),
        item={id,bankId:value.settings.bankId,corporateId:value.settings.corporateId,psuId:value.settings.psuId,status:'creating',validUntil,expiresAt:`${validUntil}T23:59:59.000Z`,createdAt:clock().toISOString(),updatedAt:clock().toISOString(),events:[]};
      value.consents[id]=item;value.currentConsentId=id;value.accounts=[];value.settings.debtorAccountId=null;event(item,'bank_consent_reserved',context);
      return {item:copy(item)};
    });
    if(reservation.existing)return safeConsent(reservation.existing);
    const item=reservation.item;
    let providerConsentId=item.providerConsentId;
    if(!reservation.reauthorise){
      const result=await client.createConsent({...providerContext(item,context),requestId:item.id,payload:{access:{},combinedServiceIndicator:false,frequencyPerDay:4,recurringIndicator:true,validUntil:item.validUntil}});
      await transaction(value=>{const saved=value.consents[item.id];saved.status=result.ok?'authorising':result.uncertain?'unknown':'failed';saved.error=result.ok?null:safeError(result.error);
        saved.providerConsentId=result.data?.consentId??result.data?.id??null;saved.updatedAt=clock().toISOString();});
      if(!result.ok)return safeConsent(await read(value=>value.consents[item.id]));
      providerConsentId=result.data?.consentId??result.data?.id;
    }
    if(!providerConsentId){await transaction(value=>{value.consents[item.id].status='unknown';value.consents[item.id].error={code:'bank_consent_id_missing',message:'Bankens medgivande-ID saknas.'};});return safeConsent(await read(value=>value.consents[item.id]));}
    const save=patch=>transaction(value=>{const saved=value.consents[item.id];saved.authorisation={...(saved.authorisation??{}),...patch};
      if(patch.scaStatus)saved.scaStatus=patch.scaStatus;if(Object.hasOwn(patch,'authorisationUrl'))saved.authorisationUrl=patch.authorisationUrl;
      if(patch.error)saved.error=patch.error;if(patch.unknown)saved.status='unknown';saved.updatedAt=clock().toISOString();});
    await createRedirectAuthorisation({...item,resource:'consent',id:providerConsentId,existingAuthorisationId:reservation.existingAuthorisationId},context,parsed.data,save);
    return safeConsent(await read(value=>value.consents[item.id]));
  }
  async function verifyConsent(value,context) {
    const consent=value.consents[value.currentConsentId];if(!consent?.providerConsentId)fail('Anslut testbanken först.',409,'bank_consent_required');
    if(consent.expiresAt&&Date.parse(consent.expiresAt)<=clock().getTime())fail('Bankmedgivandet har gått ut. Anslut banken igen.',409,'bank_consent_expired');
    const result=await client.readConsentStatus({id:consent.providerConsentId,...providerContext(consent,context)});
    if(!result.ok)fail(result.error?.message??'Medgivandet kunde inte kontrolleras.',502,result.error?.code??'bank_consent_failed');
    const status=result.data?.consentStatus??result.data?.status;
    await transaction(saved=>{const item=saved.consents[consent.id];item.status=status==='valid'?'valid':['rejected','revokedByPsu','expired','terminatedByTpp'].includes(status)?status:'authorising';item.updatedAt=clock().toISOString();
      if(status==='valid'){item.error=null;item.expiresAt=result.data?.validUntil?new Date(`${result.data.validUntil}T23:59:59Z`).toISOString():item.expiresAt;}
      if(saved.currentConsentId===item.id&&item.status!=='valid'){saved.accounts=[];saved.settings.debtorAccountId=null;}});
    if(status!=='valid')fail('Bankens kontomedgivande är inte godkänt ännu.',409,'bank_consent_pending');
    return consent;
  }
  async function getAccounts(context,expectedConsentId) {
    await authorize(context,{admin:true});const value=await read(copy);
    if(expectedConsentId && (value.currentConsentId!==expectedConsentId
      || ['bankId','corporateId','psuId'].some(key=>value.consents[expectedConsentId]?.[key]!==value.settings[key])))
      fail('Bankkopplingen ändrades innan dess konton kunde kontrolleras.',409,'bank_connection_changed');
    const consent=await verifyConsent(value,context);
    const result=await client.accounts({consentId:consent.providerConsentId,...providerContext(consent,context)});
    if(!result.ok)fail(result.error?.message??'Bankkonton kunde inte hämtas.',502,result.error?.code??'bank_accounts_failed');
    const accounts=accountsFrom(result.data);
    await transaction((saved,state)=>{principalIn(state,context,{admin:true});if(saved.currentConsentId!==consent.id||saved.settings.bankId!==consent.bankId)fail('Bankkopplingen ändrades under hämtningen.',409,'bank_connection_changed');
      saved.accounts=accounts;if(!accounts.some(item=>item.id===saved.settings.debtorAccountId))saved.settings.debtorAccountId=null;});
    return {consent:safeConsent(await read(saved=>saved.consents[consent.id])),accounts,simulation:true,journal:result.journal};
  }
  async function balances(context) {
    await authorize(context,{admin:true});const value=await read(copy);await verifyConsent(value,context);const {consent,account}=selectedAccount(await read(copy));
    const result=await client.balances({consentId:consent.providerConsentId,accountId:account.id,...providerContext(consent,context)});
    return {accountId:account.id,data:result.ok?result.data:null,journal:result.journal,error:result.error,ok:result.ok,simulation:true};
  }
  const currentApproval=async cardId=>latestAttestedVismaCards(await sourceProvider({cardId})).find(item=>String(item.cardId)===String(cardId));
  function sourceFrom(approval) {
    const snapshot=approval.snapshot,card=snapshot.card,customer=snapshot.customer;
    if(!card||!customer||String(card.id)!==String(approval.cardId)||!card.siteId||!customer.id||!snapshot.hash)fail('Den attesterade avräkningens uppgifter är ofullständiga.',409,'bank_source_incomplete');
    const amountCents=bankMoneyToCents(snapshot.net),gross=bankMoneyToCents(snapshot.gross),offset=snapshot.offset;
    if(typeof offset!=='number'||!Number.isFinite(offset)||offset!==0||gross!==amountCents)fail('Avräkningar med kvittning behöver separat betalningsavstämning.',409,'bank_source_amount_invalid');
    return {source:{cardId:approval.cardId,approvalId:approval.id,version:approval.version,hash:snapshot.hash,siteId:card.siteId,customerId:customer.id,
      customerName:customer.name,customerType:customer.type,attestedAt:approval.attestedAt,attestedBy:approval.attestedBy,number:`AV-${approval.cardId}-V${approval.version}`},
      snapshot:copy(snapshot),customer:copy(customer),amountCents,originalPaymentDetails:normalizePaymentDetails(card.paymentDetails??customer.paymentProfile??{method:'bank'})};
  }
  function assertOffice(state,source) {
    assertNoCrossManagedPayment(state,source.source.cardId,DOMAIN);
    const card=state.office?.cards?.find(item=>String(item.id)===String(source.source.cardId));
    if(!card||card.kind==='correction')fail('Det ursprungliga viktkortet saknas.',409,'bank_source_missing');
    if(state.office.payments?.some(item=>String(item.cardId)===String(card.id))||['paid','balance'].includes(card.status))fail('Kortet har redan en betalning eller är sparat på saldo.',409,'bank_already_paid');
    const frozen=source.snapshot.card;
    if(card.customerId!==frozen.customerId||card.origin!==frozen.origin||card.reference!==frozen.reference
      ||!equal(card.rows?.map(item=>[item.articleId,item.weight,item.price]),frozen.rows?.map(item=>[item.articleId,item.weight,item.price]))
      ||!equal(card.paymentDetails,frozen.paymentDetails)||card.pricingSnapshotId!==frozen.pricingSnapshotId
      ||card.customerApproval&&(card.customerApproval.id!==source.source.approvalId||card.customerApproval.version!==source.source.version))
      fail('Viktkortet har ändrats efter kundgodkännande och attest.',409,'bank_source_changed');
  }
  async function verifiedBooking(source,{fresh=false,previous}={}) {
    const result=await assertPaymentReady(source,{fresh});
    if(result?.status!=='booked'||!result.companyId||!result.generation||!result.invoiceId)fail('Bokför underlaget i Spiris före utbetalning.',409,'bank_invoice_unbooked');
    const proof={companyId:result.companyId,generation:result.generation,invoiceId:result.invoiceId,draftId:result.draftId??null};
    if(previous&&!equal(previous,proof))fail('Spiris-fakturan eller kopplingen har ändrats.',409,'bank_booking_changed');return proof;
  }
  function validateDetails(details) {
    if(details.method!=='bank')fail('Välj bankbetalning för detta test.',409,'bank_method_unsupported');
    const error=bankRecipientError(details);if(error)fail(error,422,'bank_recipient_invalid');
    if(details.bankCountry&&details.bankCountry!=='SE'||details.iban&&!details.iban.startsWith('SE'))fail('Första banketappen stöder endast svenska SEK-betalningar.',409,'bank_country_unsupported');
  }
  async function prepare(cardId,context) {
    await authorize(context);const approval=await currentApproval(cardId);if(!approval)fail('Kortet måste vara kundgodkänt och attesterat.',409,'bank_source_unattested');
    const source=sourceFrom(approval);await authorize(context,{siteId:source.source.siteId});
    const data=await (await getRepository()).read(state=>{principalIn(state,context,{siteId:source.source.siteId});assertOffice(state,source);const value=domain(state);
      const jobs=Object.values(value.jobs).filter(item=>String(item.source?.cardId)===String(cardId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return {settings:copy(value.settings),existingJob:publicJob(jobs[0]),state:copy(value)};
    },{domains:['pricing','office',DOMAIN,'swishPayments']});
    const config=await configuration(),issues=[];let bookingProof=null;
    if(!data.settings.enabled)issues.push('Aktivera Open Payments sandbox under Integrationer.');
    if(!config.ready)issues.push(...(config.issues??[]),...(config.missing??[]));
    try{assertProviderConfiguration(data.settings);selectedAccount(data.state);}catch(error){issues.push(error.message);}
    try{bookingProof=await verifiedBooking(source.source);}catch(error){issues.push(error.message);}
    if(data.existingJob&&blocking(data.existingJob))issues.push('Kortet har redan en reserverad eller genomförd bankbetalning.');
    const canInitiate=issues.length===0;try{validateDetails(source.originalPaymentDetails);}catch(error){issues.push(error.message);}
    return {cardId,source:source.source,sourceSnapshotHash:source.snapshot.hash,amount:source.amountCents/100,amountCents:source.amountCents,currency:'SEK',
      paymentDetails:copy(source.originalPaymentDetails),originalPaymentDetails:source.originalPaymentDetails,customer:{id:source.customer.id,name:source.customer.name,type:source.customer.type,number:source.customer.number},
      canStart:issues.length===0,canInitiate,issues,simulation:true,mode:'sandbox',configuration:config,bookingProof,settings:data.settings,existingJob:data.existingJob};
  }
  async function start(input,context) {
    const parsed=startSchema.safeParse(input);if(!parsed.success)fail('Kontrollera betalningsinstruktionen.');
    const request=parsed.data;await authorize(context);const approval=await currentApproval(request.cardId);if(!approval)fail('Kortet måste vara kundgodkänt och attesterat.',409,'bank_source_unattested');
    const source=sourceFrom(approval);await authorize(context,{siteId:source.source.siteId});
    if(request.source&&['approvalId','version','hash'].some(key=>request.source[key]!==source.source[key]))fail('Attestversionen har ändrats.',409,'bank_source_changed');
    const details=normalizePaymentDetails(request.paymentDetails??source.originalPaymentDetails);validateDetails(details);
    const modified=!equal(comparableDetails(details),comparableDetails(source.originalPaymentDetails));if(modified&&!request.reason?.trim())fail('Ange en orsak när betalningsuppgifter ändras.',422,'bank_override_reason_required');
    const bookingProof=await verifiedBooking(source.source),config=await configuration();if(!config.ready)fail('Open Payments sandbox är inte konfigurerad.',409,'bank_not_configured');
    const configured=await read(copy);assertProviderConfiguration(configured.settings);const {account,consent}=selectedAccount(configured);
    const bank=await client.bankDetails(configured.settings.bankId);if(!bank.ok)fail(bank.error?.message??'Testbankens stöd kunde inte kontrolleras.',502,'bank_product_unknown');
    const built=buildSandboxPaymentPayload({amountCents:source.amountCents,recipient:details,debtorAccount:accountReference(account),reference:source.source.number,bankDetails:bank.data});
    if(!built.ok)fail(built.error?.message??'Banken stöder inte mottagarens betalningstyp.',409,built.error?.code??'bank_product_unsupported');
    return transaction((value,state,audit)=>{
      principalIn(state,context,{siteId:source.source.siteId});assertOffice(state,source);if(!value.settings.enabled)fail('Banktest är inte aktiverat.',409,'bank_disabled');
      if(!equal(value.settings,configured.settings)||value.currentConsentId!==consent.id)fail('Bankinställningarna ändrades. Öppna utbetalningen igen.',409,'bank_settings_changed');selectedAccount(value);
      const previous=Object.values(value.jobs).filter(item=>String(item.source?.cardId)===String(request.cardId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
      if(previous){if(blocking(previous)||request.retryOf!==previous.id)return publicJob(previous);if(!['rejected','failed'].includes(previous.status))fail('Ett nytt försök är spärrat tills utfallet är granskat.',409,'bank_retry_forbidden');}
      else if(request.retryOf)fail('Det tidigare försöket saknas.',409,'bank_retry_forbidden');
      const id=randomUUID(),timestamp=clock().toISOString(),actor=state.pricing.users.find(item=>item.id===context.actorId),user=state.pricing.users.find(item=>item.id===context.effectiveUserId);
      const item={id,organisationId,provider:'openpayments',kind:'card',mode:'sandbox',simulation:true,source:source.source,sourceSnapshotHash:source.snapshot.hash,sourceSnapshotIntegrity:hash(source.snapshot),sourceSnapshot:source.snapshot,
        amountCents:source.amountCents,amount:source.amountCents/100,currency:'SEK',bookingProof,paymentDetails:details,originalPaymentDetails:source.originalPaymentDetails,reason:request.reason??'',
        recipient:recipientFor(details),
        bankId:value.settings.bankId,corporateId:value.settings.corporateId,psuId:value.settings.psuId,consentId:consent.id,debtorAccountId:account.id,debtorAccount:accountReference(account),
        settingsRevision:value.settings.revision,spirisBankAccountId:value.settings.spirisBankAccountId??null,spirisCompanyId:value.settings.spirisCompanyId??null,
        registerSpirisPayment:value.settings.bookkeepingEnabled,bookkeepingEnabled:value.settings.bookkeepingEnabled,providerInstructionUUID:randomUUID(),providerProduct:built.product,
        status:'queued',bookkeepingStatus:value.settings.bookkeepingEnabled?'pending':'not_requested',paymentDocumentStatus:'pending',createdAt:timestamp,updatedAt:timestamp,events:[],
        authorization:{actorId:context.actorId,effectiveUserId:context.effectiveUserId,siteId:source.source.siteId},
        reservedBy:{actualUserId:context.actorId,effectiveUserId:context.effectiveUserId,actualUserName:actor?.name??context.actorId,effectiveUserName:user?.name??context.effectiveUserId},...(previous?{retryOf:previous.id}:{})};
      item.revisionActor={actualUserId:context.actorId,effectiveUserId:context.effectiveUserId,name:user?.name??context.effectiveUserId,actualName:actor?.name??context.actorId};
      item.request={method:'POST',path:`/psd2/paymentinitiation/v1/payments/${built.product}`,payload:copy(built.payload)};item.instructionHash=hash(item.request.payload);value.jobs[id]=item;
      event(item,'payment_reserved',context,{text:'Banktest reserverat. Belopp och attestversion är låsta. Inga riktiga pengar flyttas.'});
      if(modified)event(item,'payment_details_overridden',context,{text:'Betalningsuppgifter ändrade med orsak.',reason:item.reason,before:source.originalPaymentDetails,after:details});
      audit?.push({action:'bank_payment_reserved',paymentId:id,cardId:request.cardId,amountCents:item.amountCents,actualUserId:context.actorId,effectiveUserId:context.effectiveUserId,at:timestamp,reason:item.reason});
      return publicJob(item);
    });
  }
  async function authorizeJob(id,context) {
    if(!uuid.safeParse(id).success)fail('Betalningsförsöket saknas.',404,'bank_job_missing');const item=await read(value=>copy(value.jobs[id]??null));
    if(!item)fail('Betalningsförsöket saknas.',404,'bank_job_missing');await authorize(context,{siteId:item.source.siteId});return item;
  }
  const job=async(id,context)=>publicJob(await authorizeJob(id,context));
  async function getCardJobs(cardId,context) {
    await authorize(context);const items=await read(value=>Object.values(value.jobs).filter(item=>String(item.source?.cardId)===String(cardId)).map(copy));
    await (await getRepository()).read(state=>{const card=state.office?.cards?.find(item=>String(item.id)===String(cardId));if(!card)fail('Viktkortet saknas.',404,'bank_source_missing');principalIn(state,context,{siteId:card.siteId});},{domains:['office','pricing']});
    return items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(publicJob);
  }
  async function inspectDispatch(item,context) {
    const approval=await currentApproval(item.source.cardId);if(!approval)fail('Den ursprungliga attesten saknas.',409,'bank_source_changed');const source=sourceFrom(approval);
    await (await getRepository()).read(state=>assertInstruction(domain(state),state,item,context,source),{domains:[DOMAIN,'pricing','office','swishPayments']});
    await verifiedBooking(item.source,{fresh:true,previous:item.bookingProof});
    await verifyConsent(await read(copy),context);
    const config=await configuration();if(!config.ready)fail('Banktestanslutningen är inte klar.',409,'bank_not_configured');
    return source;
  }
  function assertInstruction(value,state,item,context,source) {
    principalIn(state,context,{siteId:source.source.siteId});principalIn(state,workerContext(item),{siteId:source.source.siteId});assertOffice(state,source);
    if(!value.settings.enabled)fail('Banktest har stängts av.',409,'bank_disabled');
    const account=selectedAccount(value);
    if(value.settings.bankId!==item.bankId||value.settings.psuId!==item.psuId||value.settings.corporateId!==item.corporateId||account.consent.id!==item.consentId||account.account.id!==item.debtorAccountId
      ||!equal(accountReference(account.account),item.debtorAccount)||(value.settings.spirisCompanyId??null)!==item.spirisCompanyId||(value.settings.spirisBankAccountId??null)!==item.spirisBankAccountId
      ||Boolean(value.settings.bookkeepingEnabled)!==Boolean(item.bookkeepingEnabled))fail('Bank- eller Spiris-inställningarna har ändrats.',409,'bank_settings_changed');
    if(!equal(source.source,item.source)||!equal(source.snapshot,item.sourceSnapshot)||hash(item.sourceSnapshot)!==item.sourceSnapshotIntegrity||source.amountCents!==item.amountCents||item.amount!==item.amountCents/100||item.currency!=='SEK'
      ||!equal(source.originalPaymentDetails,item.originalPaymentDetails))fail('Den låsta avräkningen har ändrats.',409,'bank_source_changed');
    validateDetails(item.paymentDetails);
    const rebuilt=buildSandboxPaymentPayload({amountCents:item.amountCents,recipient:item.paymentDetails,debtorAccount:item.debtorAccount,reference:item.source.number,
      executionDate:item.request.payload.requestedExecutionDate,bankDetails:{globalPaymentProducts:[item.providerProduct]}});
    if(!rebuilt.ok||rebuilt.product!==item.providerProduct||!equal(rebuilt.payload,item.request.payload)||!equal(item.recipient,recipientFor(item.paymentDetails)))
      fail('Mottagaruppgifterna stämmer inte med den låsta bankinstruktionen.',409,'bank_instruction_changed');
    if(item.request?.method!=='POST'||item.request.path!==`/psd2/paymentinitiation/v1/payments/${item.providerProduct}`||hash(item.request.payload)!==item.instructionHash)
      fail('Den sparade bankinstruktionen har ändrats.',409,'bank_instruction_changed');
  }
  async function reserveWork(id,force=false) {
    return transaction(value=>{
      const item=value.jobs[id];if(!item||terminal(item)||!force&&item.status==='awaiting_authorization'||item.lease&&Date.parse(item.lease.expiresAt)>clock().getTime())return null;
      if(!force&&(item.pollSuspended||item.nextCheckAt&&Date.parse(item.nextCheckAt)>clock().getTime()))return null;
      if(!neverSent(item)&&!item.providerPaymentId){item.status='unknown';item.pollSuspended=true;item.nextCheckAt=null;item.error={code:'bank_reconciliation_required',message:'Bankens betalnings-ID saknas efter sändningen. Kontrollera utfallet manuellt; skapa ingen ny betalning.'};return null;}
      item.lease={id:randomUUID(),expiresAt:nextAt(LEASE_MS)};return {item:copy(item),leaseId:item.lease.id,dispatch:item.status==='queued'&&neverSent(item)};
    });
  }
  const updateReserved=(id,leaseId,mutate)=>transaction((value,state)=>{const item=value.jobs[id];if(!item||item.lease?.id!==leaseId)return null;mutate(item,value,state);return copy(item);});
  async function beforeDispatch(reservation) {
    const {item,leaseId}=reservation;
    try {
      await inspectDispatch(item,workerContext(item));
      if(onPrepared&&!item.documentPreparedAt){const result=await onPrepared(publicJob(item));await updateReserved(item.id,leaseId,saved=>{saved.documentPreparedAt=clock().toISOString();if(result)saved.documentRevision=copy(result);});}
      const source=await inspectDispatch(item,workerContext(item));
      return transaction((value,state)=>{const saved=value.jobs[item.id];if(saved?.lease?.id!==leaseId)return false;assertInstruction(value,state,saved,workerContext(saved),source);
        saved.sentAt=clock().toISOString();saved.status='in_flight';event(saved,'payment_sent',undefined,{text:'Instruktionen skickas till Open Payments sandbox. Inga riktiga pengar flyttas.'});return true;});
    }catch(error){await updateReserved(item.id,leaseId,saved=>{saved.status='blocked';saved.lease=null;saved.error=safeError(error);event(saved,'payment_blocked',undefined,{text:saved.error.message,error:copy(saved.error)});});return false;}
  }
  function matchesPayment(item,data) {
    const sent=item.request.payload;
    if(!data||typeof data!=='object'||data.instructedAmount?.currency!=='SEK')return false;
    let cents;try{cents=bankMoneyToCents(data.instructedAmount.amount);}catch{return false;}
    const sameReference=(actual,expected)=>Boolean(actual&&expected&&Object.entries(expected).every(([key,value])=>actual[key]===value));
    if(cents!==item.amountCents||!sameReference(data.debtorAccount,sent.debtorAccount)||data.creditorName!==sent.creditorName)return false;
    if(sent.creditorGiro&&!sameReference(data.creditorGiro,sent.creditorGiro)||sent.creditorAccount&&!sameReference(data.creditorAccount,sent.creditorAccount))return false;
    if(sent.remittanceInformationUnstructured&&data.remittanceInformationUnstructured!==sent.remittanceInformationUnstructured)return false;
    if(sent.ocrRef&&data.ocrRef!==sent.ocrRef||sent.invoiceRef&&data.invoiceRef!==sent.invoiceRef)return false;
    return !data.paymentId||data.paymentId===item.providerPaymentId;
  }
  function instructionIntegrity(item) {
    if(!item?.sourceSnapshot||!item?.source||item.sourceSnapshotIntegrity!==hash(item.sourceSnapshot)
      ||item.sourceSnapshotHash!==item.source.hash||item.sourceSnapshot.hash!==item.source.hash||item.instructionHash!==hash(item.request?.payload)
      ||item.amount!==item.amountCents/100||item.currency!=='SEK'||!equal(item.recipient,recipientFor(item.paymentDetails)))return false;
    const built=buildSandboxPaymentPayload({amountCents:item.amountCents,recipient:item.paymentDetails,debtorAccount:item.debtorAccount,reference:item.source.number,
      executionDate:item.request?.payload?.requestedExecutionDate,bankDetails:{globalPaymentProducts:[item.providerProduct]}});
    return Boolean(built.ok&&equal(built.payload,item.request.payload));
  }
  async function settle(reservation,result) {
    const updated=await updateReserved(reservation.item.id,reservation.leaseId,(saved,value)=>{
      saved.lease=null;value.connection={...(value.connection??{}),lastCheckedAt:clock().toISOString()};
      saved.response={method:reservation.dispatch?'POST':'GET',httpStatus:result.statusCode??null,data:result.journal?.response??null};
      if(reservation.dispatch&&result.ok){const id=result.data?.paymentId??result.data?.id;if(id)saved.providerPaymentId=id;
        const accepted=['ACSC','ACSP','ACCC'].includes(result.data?.transactionStatus);
        saved.status=saved.providerPaymentId?(accepted?'pending':'awaiting_authorization'):'unknown';saved.nextCheckAt=accepted?nextAt():null;saved.pollSuspended=!saved.providerPaymentId;
        saved.error=saved.providerPaymentId?null:{code:'bank_payment_id_missing',message:'Bankens betalnings-ID saknas. Ingen ny betalning skickas.'};
        event(saved,'payment_authorisation_required',undefined,{text:'Testbanken har tagit emot instruktionen. Signering krävs; betalningen är inte genomförd.'});return;}
      if(!reservation.dispatch&&result.ok&&result.data?.transactionStatus==='ACSC'){
        if(result.environment!=='sandbox'||!instructionIntegrity(saved)||!matchesPayment(saved,result.data)){saved.status='unknown';saved.pollSuspended=true;saved.nextCheckAt=null;
          saved.error={code:'bank_response_mismatch',message:'Bankens genomförandesvar matchar inte den låsta instruktionen. Ingen utbetalning eller bokföring bekräftas.'};event(saved,'payment_response_mismatch',undefined,{text:saved.error.message});return;}
        saved.status='simulated_paid';saved.providerResult={...copy(result.data),status:'ACSC',paymentId:saved.providerPaymentId,
          datePaid:clock().toISOString(),datePaidSource:'sandbox_confirmation',paymentDateSource:'sandbox_confirmation',amount:itemAmount(saved.amountCents),currency:'SEK'};
        saved.providerPaymentReference=text(result.data.paymentId??saved.providerPaymentId);
        saved.verifiedAt=clock().toISOString();saved.finishedAt=saved.verifiedAt;saved.nextCheckAt=null;saved.error=null;value.connection.lastVerifiedAt=saved.verifiedAt;
        event(saved,'payment_simulated_paid',undefined,{text:'Open Payments sandbox bekräftade testbetalningen med ACSC. Detta är en simulering.'});return;}
      if(!reservation.dispatch&&result.ok&&result.data?.transactionStatus==='RJCT'){
        if(!instructionIntegrity(saved)||!matchesPayment(saved,result.data)){saved.status='unknown';saved.pollSuspended=true;saved.nextCheckAt=null;saved.error={code:'bank_response_mismatch',message:'Bankens avvisning matchar inte den låsta instruktionen.'};return;}
        saved.status='rejected';saved.finishedAt=clock().toISOString();saved.nextCheckAt=null;saved.error={code:'bank_rejected',message:'Testbanken avvisade betalningen.'};event(saved,'payment_rejected',undefined,{text:saved.error.message});return;}
      if(reservation.dispatch&&!result.ok&&!result.uncertain&&Number(result.statusCode)>=400&&Number(result.statusCode)<500&&![408,409,429].includes(Number(result.statusCode))){
        saved.status='rejected';saved.finishedAt=clock().toISOString();saved.nextCheckAt=null;saved.error=safeError(result.error);event(saved,'payment_rejected',undefined,{text:saved.error.message});return;}
      // These adapter codes can only arise before the payment HTTP request:
      // failed token acquisition/local validation is not an unknown bank debit.
      // A new attempt still requires an explicit retryOf of this failed attempt.
      if(reservation.dispatch&&!result.ok&&!result.uncertain&&result.statusCode==null&&[
        'bank_not_configured','bank_context_invalid','bank_payload_invalid','bank_authentication_failed','bank_authentication_unavailable',
        'bank_request_id_invalid','bank_target_forbidden',
      ].includes(result.error?.code)){
        saved.status='failed';saved.finishedAt=clock().toISOString();saved.nextCheckAt=null;saved.error=safeError(result.error);
        event(saved,'payment_not_sent',undefined,{text:'Ingen betalningsbegäran skickades till banken. '+saved.error.message});return;
      }
      const decoupledStarted=saved.authorisation?.phase==='started'&&!saved.authorisationUrl;
      const awaiting=Boolean(saved.providerPaymentId&&!saved.authorisation?.callbackReservedAt&&!decoupledStarted&&['RCVD','ACTC','PATC'].includes(result.data?.transactionStatus));
      saved.status=result.ok?(awaiting?'awaiting_authorization':'pending'):'unknown';saved.nextCheckAt=awaiting?null:nextAt(result.ok?POLL_MS:60_000);saved.error=result.ok?null:safeError(result.error);
      if(!reservation.dispatch)saved.pollCount=(saved.pollCount??0)+1;
      if(!result.ok)saved.failedPolls=(saved.failedPolls??0)+1;
      if(!saved.providerPaymentId||(saved.failedPolls??0)>=8||(saved.pollCount??0)>=40||clock().getTime()-Date.parse(saved.createdAt)>86_400_000){saved.pollSuspended=true;saved.nextCheckAt=null;
        saved.error={code:'bank_reconciliation_required',message:'Automatisk kontroll har pausats. Kontrollera samma betalning manuellt; skapa ingen ny.'};}
      event(saved,result.ok?'payment_pending':'payment_outcome_unknown',undefined,{text:saved.error?.message??'Bankens slutliga genomförandebesked inväntas.'});
    });
    if(updated?.status==='simulated_paid'){await synchronizePaymentDocument(updated.id);await synchronizeBookkeeping(updated.id);}return updated;
  }
  async function run(id,force=false) {
    const reservation=await reserveWork(id,force);if(!reservation)return;
    if(reservation.dispatch&&!await beforeDispatch(reservation))return;
    const item=reservation.item,options={product:item.providerProduct,...providerContext(item)};let result;
    try{result=reservation.dispatch?await client.createPayment({...options,requestId:item.providerInstructionUUID,payload:copy(item.request.payload)}):await client.readPayment({...options,id:item.providerPaymentId});}
    catch(error){result={ok:false,uncertain:true,environment:'sandbox',error:safeError(error)};}
    await settle(reservation,result);
  }
  async function beginAuthorisation(id,input={},context) {
    const parsed=authInputSchema.safeParse(input);if(!parsed.success)fail('Kontrollera bankens signeringsmetod.');
    const existing=await authorizeJob(id,context);
    if(existing.status!=='awaiting_authorization'||!existing.providerPaymentId)fail('Betalningen väntar inte på bankens signering.',409,'bank_authorisation_unavailable');
    await inspectDispatch(existing,context);
    const reserved=await transaction((value,state)=>{const item=value.jobs[id];principalIn(state,context,{siteId:item.source.siteId});principalIn(state,workerContext(item),{siteId:item.source.siteId});
      if(item.status!=='awaiting_authorization'||item.providerPaymentId!==existing.providerPaymentId)fail('Bankens signering är inte längre aktuell för detta betalningsförsök.',409,'bank_authorisation_unavailable');
      if(item.authorisation)return {existing:true,item:copy(item)};item.authorisation={phase:'reserved'};event(item,'payment_authorisation_reserved',context,{text:'Bankens signering förbereds för samma betalnings-ID.'});return {item:copy(item)};});
    if(reserved.existing)return publicJob(reserved.item);
    const item=reserved.item;
    const save=async patch=>{
      if(['creating','starting'].includes(patch.phase))await inspectDispatch(item,context);
      return transaction((value,state)=>{const saved=value.jobs[id];
        if(['creating','starting'].includes(patch.phase)){
          principalIn(state,context,{siteId:saved.source.siteId});principalIn(state,workerContext(saved),{siteId:saved.source.siteId});
          if(saved.status!=='awaiting_authorization')fail('Signeringen har redan avslutats eller betalningen ändrat status.',409,'bank_authorisation_unavailable');
        }
        saved.authorisation={...saved.authorisation,...patch};
        if(Object.hasOwn(patch,'authorisationUrl'))saved.authorisationUrl=patch.authorisationUrl;if(patch.scaStatus)saved.scaStatus=patch.scaStatus;
        if(saved.status!=='simulated_paid'){
          if(patch.error)saved.error=patch.error;
          if(patch.phase==='started'&&!patch.authorisationUrl){saved.status='pending';saved.nextCheckAt=nextAt();}
          if(patch.unknown){saved.pollSuspended=true;event(saved,'payment_authorisation_unknown',undefined,{text:patch.error?.message??'Signeringens svar saknas; ingen ny start görs.'});}
        }
        saved.updatedAt=clock().toISOString();
      });
    };
    await createRedirectAuthorisation({...item,resource:'payment',id:item.providerPaymentId,product:item.providerProduct},context,parsed.data,save);
    return job(id,context);
  }
  async function completeAuthorisation(query,context) {
    const code=text(query?.code,4000),state=text(query?.state,200);if(!code||!state)fail('Bankens returuppgifter saknas.',422,'bank_callback_invalid');
    scoped(context);await authorizeContext(context);
    const stateHash=hash(state),match=await read(value=>{
      const payment=Object.values(value.jobs).find(item=>item.authorisation?.stateHash===stateHash);if(payment)return {kind:'payment',item:copy(payment)};
      const consent=Object.values(value.consents).find(item=>item.authorisation?.stateHash===stateHash);return consent?{kind:'consent',item:copy(consent)}:null;
    });
    if(!match)fail('Bankens returhörning matchar ingen aktiv signering.',403,'bank_callback_state_invalid');
    const {item,kind}=match,auth=item.authorisation;
    if(!exactState(auth.stateHash,stateHash)||auth.context.actorId!==context.actorId||auth.context.effectiveUserId!==context.effectiveUserId
      ||auth.context.sessionHash!==hash(context.sessionKey)||Date.parse(auth.expiresAt)<=clock().getTime())fail('Bankens signering tillhör en annan eller utgången session.',403,'bank_callback_forbidden');
    await authorize(context,kind==='consent'?{admin:true}:{siteId:item.source.siteId});
    const reserved=await transaction((value,state)=>{const saved=kind==='payment'?value.jobs[item.id]:value.consents[item.id];principalIn(state,context,kind==='consent'?{admin:true}:{siteId:saved.source.siteId});
      if(kind==='consent' && (value.currentConsentId!==item.id || ['bankId','corporateId','psuId'].some(key=>saved[key]!==value.settings[key])))
        fail('Bankkopplingen ändrades innan bankens retur kunde aktiveras.',409,'bank_connection_changed');
      if(!exactState(saved.authorisation?.stateHash,stateHash))fail('Bankens returhörning matchar ingen aktiv signering.',403,'bank_callback_state_invalid');
      if(saved.authorisation.callbackReservedAt)return false;saved.authorisation.callbackReservedAt=clock().toISOString();saved.authorisation.phase='completing';saved.authorisationUrl=null;saved.authorisation.authorisationUrl=null;return true;});
    if(reserved){
      const result=await client.completeAuthorisation({resource:kind==='payment'?'payment':'consent',product:item.providerProduct,id:kind==='payment'?item.providerPaymentId:item.providerConsentId,
        ...providerContext(item,context),authorisationId:auth.authorisationId,redirectUri:auth.redirectUri,code});
      await transaction(value=>{const saved=kind==='payment'?value.jobs[item.id]:value.consents[item.id];
        if(kind==='consent' && (value.currentConsentId!==item.id || ['bankId','corporateId','psuId'].some(key=>saved[key]!==value.settings[key])))
          fail('Bankkopplingen ändrades under bankens retur.',409,'bank_connection_changed');
        if(!exactState(saved.authorisation?.stateHash,stateHash))fail('Bankens signering har ersatts av en ny signering.',409,'bank_authorisation_changed');
        saved.authorisation.phase=result.ok?'completed':result.uncertain?'unknown':'failed';saved.authorisation.unknown=!result.ok && Boolean(result.uncertain);
        saved.authorisationDiagnostics=authorisationDiagnostics(result,'activation',[code]);
        if(saved.status!=='simulated_paid')saved.error=result.ok?null:safeError(result.error);if(kind==='payment'){
          if(saved.status!=='simulated_paid'){saved.status=result.ok?'pending':'unknown';saved.nextCheckAt=result.ok?nextAt():null;saved.pollSuspended=!result.ok;}
          event(saved,'payment_authorisation_completed',context,{text:result.ok?'Bankens retur mottagen. Genomförandet kontrolleras separat.':'Bankens signeringssvar saknas. Ingen ny betalning startas.'});}});
    }
    if(kind==='consent'){
      await read(value=>{if(value.currentConsentId!==item.id || ['bankId','corporateId','psuId'].some(key=>value.consents[item.id]?.[key]!==value.settings[key]))
        fail('Bankkopplingen ändrades under bankens retur.',409,'bank_connection_changed');});
      await getAccounts(context,item.id);return {kind,consent:safeConsent(await read(value=>value.consents[item.id]))};
    }
    await run(item.id,true);return {kind,job:await job(item.id,context)};
  }
  async function refresh(id,context) {
    const existing=await authorizeJob(id,context);
    if(existing.status==='simulated_paid'){await synchronizePaymentDocument(id,{force:true});await synchronizeBookkeeping(id,{force:true});}
    else if(existing.status==='blocked'&&neverSent(existing)){
      let error;try{await inspectDispatch(existing,context);}catch(failure){error=failure;}
      await transaction(value=>{const saved=value.jobs[id];if(saved.status!=='blocked'||!neverSent(saved)||saved.lease)return;saved.preflightStatus=error?'blocked':'ready';saved.preflightCheckedAt=clock().toISOString();saved.error=error?safeError(error):null;
        event(saved,error?'payment_preflight_blocked':'payment_preflight_ready',context,{text:error?saved.error.message:'Förkontrollen är klar. Fortsätt den ursprungliga instruktionen uttryckligen.'});});
    }else if(!terminal(existing)&&existing.status!=='queued'){
      // The first resource GET is safe even when SCA has not finished. Creating
      // or retrying an authorisation is always a separate explicit operation.
      await run(id,true);
    }
    return job(id,context);
  }
  async function resume(id,context) {
    const existing=await authorizeJob(id,context);if(existing.status!=='blocked'||!neverSent(existing)||existing.preflightStatus!=='ready')fail('Kontrollera den spärrade instruktionen först.',409,'bank_resume_forbidden');
    const source=await inspectDispatch(existing,context);
    return transaction((value,state)=>{const item=value.jobs[id];if(item.status!=='blocked'||!neverSent(item)||item.preflightStatus!=='ready'||item.lease)fail('Betalningen kan inte fortsätta.',409,'bank_resume_forbidden');
      assertInstruction(value,state,item,context,source);item.status='queued';item.error=null;item.nextCheckAt=null;item.pollSuspended=false;delete item.preflightStatus;
      event(item,'payment_resumed',context,{text:'Samma osända bankinstruktion köades efter verifierad förkontroll.'});return publicJob(item);});
  }
  async function synchronizePaymentDocument(id,{force=false}={}) {
    if(!onPaymentConfirmed)return;
    const reservation=await transaction(value=>{const item=value.jobs[id];if(!item||item.status!=='simulated_paid'||item.providerResult?.transactionStatus!=='ACSC'||!instructionIntegrity(item)||!matchesPayment(item,item.providerResult)||item.paymentDocumentStatus==='archived'
      ||item.paymentDocumentLease&&Date.parse(item.paymentDocumentLease.expiresAt)>clock().getTime()||!force&&((item.paymentDocumentAttempts??0)>=5||item.paymentDocumentNextCheckAt&&Date.parse(item.paymentDocumentNextCheckAt)>clock().getTime()))return null;
      item.paymentDocumentLease={id:randomUUID(),expiresAt:nextAt(LEASE_MS)};item.paymentDocumentAttempts=(item.paymentDocumentAttempts??0)+1;return {item:copy(item),leaseId:item.paymentDocumentLease.id};});
    if(!reservation)return;let result,error;
    try{result=await onPaymentConfirmed(copy(reservation.item));if(!result?.documentId)throw new Error('Betalningsbekräftelsens PDF kunde inte arkiveras.');}catch(failure){error=safeError(failure);}
    await transaction(value=>{const item=value.jobs[id];if(item.paymentDocumentLease?.id!==reservation.leaseId)return;item.paymentDocumentLease=null;
      item.paymentDocumentStatus=error?'failed':'archived';item.paymentDocumentError=error?.message??null;item.paymentDocumentNextCheckAt=error&&item.paymentDocumentAttempts<5?nextAt(60_000):null;
      if(!error)item.paymentConfirmationDocument=copy(result);event(item,error?'payment_confirmation_pdf_failed':'payment_confirmation_pdf_archived',undefined,{text:error?.message??'Ny avräknings-PDF med verifierad banktestbekräftelse är arkiverad.'});});
  }
  async function synchronizeBookkeeping(id,{force=false}={}) {
    if(!onVerifiedPayment)return;
    const reservation=await transaction(value=>{const item=value.jobs[id];if(!item||item.status!=='simulated_paid'||item.providerResult?.transactionStatus!=='ACSC'||!instructionIntegrity(item)||!matchesPayment(item,item.providerResult)||!item.registerSpirisPayment||item.bookkeepingStatus==='registered'
      ||item.bookkeepingLease&&Date.parse(item.bookkeepingLease.expiresAt)>clock().getTime()||!force&&item.bookkeepingNextCheckAt&&Date.parse(item.bookkeepingNextCheckAt)>clock().getTime())return null;
      item.bookkeepingLease={id:randomUUID(),expiresAt:nextAt(LEASE_MS)};return {item:copy(item),leaseId:item.bookkeepingLease.id};});
    if(!reservation)return;let result;
    try{result=await onVerifiedPayment(copy(reservation.item),{force});}catch(error){result={status:'unknown',reason:text(error.message,300)};}
    await transaction(value=>{const item=value.jobs[id];if(item.bookkeepingLease?.id!==reservation.leaseId)return;item.bookkeepingLease=null;
      const previous=item.bookkeepingStatus;item.bookkeepingStatus=['registered','waiting_booked','paused','unknown','failed','blocked','pending'].includes(result?.status)?result.status:'unknown';item.bookkeeping=copy(result??{});
      item.bookkeepingNextCheckAt=['registered','blocked','failed','paused'].includes(item.bookkeepingStatus)?null:nextAt(300_000);
      if(previous!==item.bookkeepingStatus)event(item,'payment_bookkeeping_updated',undefined,{text:item.bookkeepingStatus==='registered'?'Banktestbetalningen är registrerad i Spiris sandbox.':result?.reason??'Spiris betalningsregistrering inväntas.',status:item.bookkeepingStatus});});
  }
  async function processQueuedPayments({limit=10}={}) {
    if(processing)return processing;
    processing=(async()=>{const index=await read(value=>({ids:value.workIds??[],next:value.nextWorkAt}),[['organisationId'],['workIds'],['nextWorkAt']]);if(!index.ids.length||index.next&&Date.parse(index.next)>clock().getTime())return 0;
      const chosen=index.ids.slice(0,Math.min(50,limit)),items=await read(value=>chosen.map(id=>value.jobs[id]).filter(Boolean).filter(item=>item.status==='simulated_paid'||!item.pollSuspended&&(!item.nextCheckAt||Date.parse(item.nextCheckAt)<=clock().getTime())).map(copy),[['organisationId'],...chosen.map(id=>['jobs',id])]);
      for(const item of items){if(item.status==='simulated_paid'){await synchronizePaymentDocument(item.id);await synchronizeBookkeeping(item.id);}else await run(item.id);}return items.length;})();
    try{return await processing;}finally{processing=null;}
  }
  async function readVerifiedPayment(id) {
    if(!uuid.safeParse(id).success)return null;
    return read(value=>{
      const item=value.jobs[id];
      return item?.status==='simulated_paid'&&item.provider==='openpayments'&&item.mode==='sandbox'&&item.simulation===true&&item.verifiedAt
        &&item.providerResult?.transactionStatus==='ACSC'&&item.providerResult.status==='ACSC'&&instructionIntegrity(item)&&matchesPayment(item,item.providerResult)?copy(item):null;
    });
  }
  async function assertNoManagedPayment(cardId,state) {
    const existing=state?findManagedPayment(state,cardId):await (await getRepository()).read(value=>findManagedPayment(value,cardId),{domains:[DOMAIN,'swishPayments']});
    if(existing)fail('Kortet har en reserverad eller genomförd integrationsbetalning. Manuell betalning är spärrad.',409,'bank_payment_reserved');
  }
  return {initialize,integrationStatus,settings,saveSettings,banks,testConnection,connectConsent,getAccounts,balances,prepare,start,job,getCardJobs,refresh,resume,
    beginAuthorisation,completeAuthorisation,processQueuedPayments,readVerifiedPayment,assertNoManagedPayment,synchronizeBookkeeping,synchronizePaymentDocument};
}
