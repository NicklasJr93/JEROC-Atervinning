import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { can } from '../dist-server/domain-models.mjs';
import { resolvePricingPrincipal } from './pricing.mjs';
import { createMicrosoftMailClient } from './microsoft-mail-client.mjs';

const DOMAIN='mailIntegration',OAUTH_MS=10*60_000,LEASE_MS=90_000;
const copy=value=>structuredClone(value),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own=(records,id)=>records&&typeof id==='string'&&Object.hasOwn(records,id)?records[id]:undefined;
const address=value=>typeof value==='string'?value.trim().toLowerCase():'';
const email=z.string().trim().email().max(254).transform(address),identifier=z.string().min(1).max(150);
const mailboxInput=z.object({connectionId:identifier,address:email,displayName:z.string().trim().min(1).max(150).optional(),allowedUserIds:z.array(identifier).max(100).optional()}).strict();
const mailboxPatch=z.object({displayName:z.string().trim().min(1).max(150).optional(),allowedUserIds:z.array(identifier).max(100).optional(),enabled:z.boolean().optional()}).strict();
const managed=user=>['Systemadmin','VD'].includes(user.level)&&can(user,'integrationsRead')&&can(user,'integrationsManage')&&!Array.isArray(user.siteIds);
const metadataFields=['id','mailboxId','subject','from','receivedAt','isRead','bodyPreview','hasAttachments'];
const text=(value,max=1000)=>typeof value==='string'?value.slice(0,max):'';
const party=value=>({name:text(value?.emailAddress?.name,300),address:address(value?.emailAddress?.address)});
const permittedLink=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&['outlook.office.com','outlook.office365.com','outlook.live.com'].includes(url.hostname)?url.toString():undefined;}catch{return undefined;}};
const publicMessage=item=>copy(Object.fromEntries(metadataFields.map(key=>[key,item[key]])));
const errorProjection=error=>({code:typeof error?.code==='string'&&/^(?:microsoft_mail_|mail_)[A-Za-z0-9_-]{1,80}$/.test(error.code)?error.code:'mail_provider_failed',
  message:'Microsoft-anslutningen kunde inte kontrolleras. Försök igen eller anslut kontot på nytt.'});
export class MailServiceError extends Error{constructor(message,status=422,code='mail_invalid'){super(message);this.status=status;this.code=code;}}
const fail=(message,status=422,code='mail_invalid')=>{throw new MailServiceError(message,status,code);};

/** The private domain holds encrypted credentials and bounded message metadata.
 * Office/mobile projections never include it. No provider read flag or email is
 * changed: opening a message is Graph GET only, and bodies are not archived. */
export function createMailService({getRepository,env=process.env,client=createMicrosoftMailClient({env}),now=()=>new Date(),authorizeContext=async()=>{}}={}){
  if(typeof getRepository!=='function')throw new TypeError('En serverlagrad mejldomän krävs.');
  const organisationId=env.SCRAPPILOT_ORGANISATION_ID??env.JEROC_TENANT_ID??'jeroc-demo';
  const clock=()=>new Date(now()),refreshFlights=new Map(),syncFlights=new Map();
  const initial=()=>({version:1,organisationId,revision:0,connections:{},mailboxes:{},messages:{},oauthAttempts:{},audit:[],publicConnections:[],publicMailboxes:[]});
  const domain=(state,create=false)=>{if(!state[DOMAIN]){if(!create)return initial();state[DOMAIN]=initial();}
    if(state[DOMAIN].organisationId!==organisationId)fail('Mejlanslutningen tillhör ett annat bolag.',403,'mail_tenant_mismatch');return state[DOMAIN];};
  const read=async(callback,paths)=>{const repo=await getRepository();return paths&&repo.readProjection?repo.readProjection(state=>callback(domain(state)),{domain:DOMAIN,paths:[['organisationId'],...paths]}):repo.read(state=>callback(domain(state)),{domains:[DOMAIN]});};
  function publishMetadata(value){value.publicConnections=Object.values(value.connections).map(item=>copy(Object.fromEntries(['id','provider','address','displayName','status','lastError','updatedAt'].filter(key=>item[key]!==undefined).map(key=>[key,item[key]]))));
    value.publicMailboxes=Object.values(value.mailboxes).map(box=>({...copy(Object.fromEntries(['id','connectionId','address','displayName','type','enabled','allowedUserIds','lastSyncedAt','lastError'].filter(key=>box[key]!==undefined).map(key=>[key,box[key]]))),
      unreadCount:Object.values(value.messages[box.id]??{}).filter(item=>!item.isRead).length,countsPartial:box.hasMore===true}));}
  const write=async callback=>(await getRepository()).transact((state,revision,audit)=>{const value=domain(state,true),result=callback(value,state,audit);publishMetadata(value);return result;});
  const scoped=context=>{if(context?.organisationId!==organisationId||!context.actorId||!context.effectiveUserId||!context.sessionKey)
    fail('En aktiv företagssession krävs.',403,'mail_forbidden');};
  const principalIn=(state,context,manage=false)=>{scoped(context);const principal=resolvePricingPrincipal(state.pricing?.users??[],context.actorId,context.effectiveUserId);
    if(manage?![principal.actor,principal.user].every(managed):![principal.actor,principal.user].every(user=>can(user,'mailRead')))
      fail(manage?'Behörighet att hantera bolagets integrationer krävs.':'Behörighet att läsa mejl krävs.',403,'mail_forbidden');return principal;};
  const authorize=async(context,manage=false)=>{scoped(context);await authorizeContext(context,{manage});return (await getRepository()).read(state=>principalIn(state,context,manage),{domains:['pricing']});};
  const canMailbox=(box,principal)=>box?.enabled&&[principal.actor,principal.user].every(user=>can(user,'mailRead')&&(managed(user)||box.allowedUserIds.includes(user.id)));
  const boxIn=(value,id,principal)=>{const box=own(value.mailboxes,id);if(!canMailbox(box,principal))fail('Inkorgen är inte tillgänglig för denna användare.',403,'mail_mailbox_forbidden');return box;};
  function event(value,audit,context,action,details={}){value.revision+=1;const entry={id:randomUUID(),at:clock().toISOString(),action,
    actualUserId:context.actorId,effectiveUserId:context.effectiveUserId,...details};value.audit.push(entry);audit?.push(entry);}
  function configuration(){const base=client.configuration(),key=env.MAIL_TOKEN_ENCRYPTION_KEY??env.VISMA_TOKEN_ENCRYPTION_KEY;
    const valid=typeof key==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(key)&&Buffer.from(key,'base64').length===32;
    return {ready:base.ready&&valid,missing:[...(base.missing??[]),...(!key?['MAIL_TOKEN_ENCRYPTION_KEY']:[])],
      issues:[...(base.issues??[]),...(key&&!valid?['Mejlens krypteringsnyckel behöver vara 32 byte i base64.']:[])],redirectUri:base.redirectUri??null};}
  const encryptionKey=()=>{if(!configuration().ready)fail('Microsoft-anslutningen saknar serverinställningar.',409,'mail_not_configured');return Buffer.from(env.MAIL_TOKEN_ENCRYPTION_KEY??env.VISMA_TOKEN_ENCRYPTION_KEY,'base64');};
  function encrypt(value,purpose,id,generation=''){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);cipher.setAAD(Buffer.from(JSON.stringify([organisationId,purpose,id,generation])));
    return {version:1,iv:iv.toString('base64'),tag:null,data:Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]).toString('base64'),...{tag:cipher.getAuthTag().toString('base64')}};}
  function decrypt(value,purpose,id,generation=''){try{const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(value.iv,'base64'));decipher.setAAD(Buffer.from(JSON.stringify([organisationId,purpose,id,generation])));decipher.setAuthTag(Buffer.from(value.tag,'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data,'base64')),decipher.final()]).toString('utf8'));}catch(error){if(error.code==='mail_not_configured')throw error;fail('Mejlanslutningens krypterade uppgifter kunde inte läsas.',409,'mail_credentials_unavailable');}}
  const binding=context=>hash([organisationId,context.actorId,context.effectiveUserId,context.sessionKey]);
  function connectionIn(value,id){const connection=own(value.connections,id);if(!connection||connection.status==='disconnected'||!connection.tokens)fail('Anslut Microsoft-kontot på nytt.',409,'mail_connection_required');return connection;}
  function unchanged(value,id,generation){const connection=connectionIn(value,id);if(connection.generation!==generation)fail('Microsoft-anslutningen ändrades under hämtningen.',409,'mail_connection_changed');return connection;}
  function validateAcl(ids,state){const unique=[...new Set(ids??[])];if(unique.some(id=>!state.pricing.users.some(user=>user.id===id&&user.active!==false&&can(user,'mailRead'))))
    fail('Välj aktiva användare med behörighet att läsa mejl.',422,'mail_acl_invalid');return unique;}
  function metadata(raw,mailboxId){if(typeof raw?.id!=='string'||!raw.id||raw.id.length>2048||!Number.isFinite(Date.parse(raw.receivedDateTime)))fail('Microsofts mejl-ID eller datum kunde inte verifieras.',502,'mail_response_invalid');
    return {id:raw.id,mailboxId,subject:text(raw.subject,1000),from:party(raw.from),receivedAt:new Date(raw.receivedDateTime).toISOString(),isRead:raw.isRead===true,
      bodyPreview:text(raw.bodyPreview,2000),hasAttachments:raw.hasAttachments===true};}
  async function access(id,context,mailboxId){const principal=await authorize(context,false),snapshot=await read(value=>{if(mailboxId)boxIn(value,mailboxId,principal);return copy(connectionIn(value,id));});
    const tokens=decrypt(snapshot.tokens,'tokens',id,snapshot.generation);
    if(Number(tokens.expiresAt)>clock().getTime()+60_000)return {accessToken:tokens.accessToken,generation:snapshot.generation};
    if(refreshFlights.has(id))return refreshFlights.get(id);
    const flight=(async()=>{const leaseId=randomUUID();await write((value,state)=>{const currentPrincipal=principalIn(state,context);if(mailboxId)boxIn(value,mailboxId,currentPrincipal);const item=unchanged(value,id,snapshot.generation);
      if(item.refreshLease&&Date.parse(item.refreshLease.expiresAt)>clock().getTime())fail('Kontots anslutning uppdateras. Försök igen.',409,'mail_refresh_pending');item.refreshLease={id:leaseId,expiresAt:new Date(clock().getTime()+LEASE_MS).toISOString()};});
      try{const fresh=await client.refreshToken({refreshToken:tokens.refreshToken});await authorize(context,false);
        await write((value,state)=>{const currentPrincipal=principalIn(state,context);if(mailboxId)boxIn(value,mailboxId,currentPrincipal);const item=unchanged(value,id,snapshot.generation);
          if(item.refreshLease?.id!==leaseId)fail('Kontots anslutning ändrades.',409,'mail_connection_changed');item.tokens=encrypt(fresh,'tokens',id,item.generation);item.refreshLease=null;item.status='connected';item.lastError=null;item.updatedAt=clock().toISOString();});
        return {accessToken:fresh.accessToken,generation:snapshot.generation};
      }catch(error){await write(value=>{const item=value.connections[id];if(item?.generation===snapshot.generation&&item.refreshLease?.id===leaseId){item.refreshLease=null;item.status='error';item.lastError=errorProjection(error);}});throw error;}
    })();refreshFlights.set(id,flight);try{return await flight;}finally{if(refreshFlights.get(id)===flight)refreshFlights.delete(id);}}

  async function state(context){let principal,canRead=false,canManage=false;try{principal=await authorize(context);canRead=true;}catch(error){if(error.status!==403)throw error;principal=await authorize(context,true);}
    canManage=[principal.actor,principal.user].every(managed);
    return read(value=>{const boxes=(value.publicMailboxes??[]).filter(box=>canManage||canMailbox(box,principal));
      const connectionIds=new Set(boxes.map(box=>box.connectionId));
      const mailboxes=boxes.map(box=>({...copy(box),unreadCount:canMailbox(box,principal)?box.unreadCount:0}));
      return {organisationId,configuration:configuration(),connections:(value.publicConnections??[]).filter(item=>canManage||connectionIds.has(item.id)),
        mailboxes,totalUnread:mailboxes.reduce((sum,item)=>sum+item.unreadCount,0),capabilities:{canManage,canRead},mode:'live'};},[['publicConnections'],['publicMailboxes']]);}
  async function connectMicrosoft(context){await authorize(context,true);encryptionKey();const id=randomUUID(),stateValue=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
    await write((value,state,audit)=>{principalIn(state,context,true);for(const attempt of Object.values(value.oauthAttempts))if(Date.parse(attempt.expiresAt)<=clock().getTime()||attempt.binding===binding(context))delete value.oauthAttempts[attempt.id];
      value.oauthAttempts[id]={id,stateHash:hash(stateValue),binding:binding(context),connectionGenerations:Object.fromEntries(Object.values(value.connections).map(item=>[item.id,item.generation])),verifier:encrypt(verifier,'oauth',id),status:'pending',expiresAt:new Date(clock().getTime()+OAUTH_MS).toISOString()};event(value,audit,context,'mail_oauth_started');});
    return {authorizationUrl:client.authorisationUrl({state:stateValue,challenge:createHash('sha256').update(verifier).digest('base64url')})};}
  async function completeMicrosoft(query,context){await authorize(context,true);const returned=text(query?.state,300),code=text(query?.code,4096);if(!returned||!code&&!query?.error)fail('Microsofts returuppgifter saknas.',422,'mail_callback_invalid');
    const reserved=await write((value,state)=>{principalIn(state,context,true);const attempt=Object.values(value.oauthAttempts).find(item=>item.stateHash===hash(returned));
      if(!attempt||attempt.binding!==binding(context)||Date.parse(attempt.expiresAt)<=clock().getTime()||attempt.status!=='pending')fail('Microsofts retur hör till en annan eller avslutad session.',403,'mail_callback_forbidden');
      attempt.status='exchanging';return copy(attempt);});
    try{if(query.error)fail('Microsoft-anslutningen avbröts.',409,'mail_oauth_denied');const tokens=await client.exchangeCode({code,verifier:decrypt(reserved.verifier,'oauth',reserved.id)}),identity=await client.me(tokens.accessToken);
      const mailboxAddress=email.safeParse(identity.mail||identity.userPrincipalName);if(!mailboxAddress.success||typeof identity.id!=='string'||!identity.id)fail('Microsoft-kontots adress kunde inte verifieras.',502,'mail_identity_invalid');
      await authorize(context,true);await write((value,state,audit)=>{principalIn(state,context,true);const attempt=value.oauthAttempts[reserved.id];if(!attempt||attempt.status!=='exchanging'||attempt.binding!==binding(context))fail('Microsoft-anslutningen ändrades.',409,'mail_connection_changed');
        const existing=Object.values(value.connections).find(item=>item.microsoftUserId===identity.id);
        if(existing&&attempt.connectionGenerations?.[existing.id]!==existing.generation)fail('Microsoft-anslutningen ändrades efter att inloggningen startade.',409,'mail_connection_changed');
        const id=existing?.id??randomUUID(),generation=randomUUID();
        value.connections[id]={...existing,id,generation,provider:'microsoft',microsoftUserId:identity.id,address:mailboxAddress.data,displayName:text(identity.displayName,150)||mailboxAddress.data,status:'connected',
          updatedAt:clock().toISOString(),tokens:encrypt(tokens,'tokens',id,generation),lastError:null,refreshLease:null};
        let primary=Object.values(value.mailboxes).find(box=>box.connectionId===id&&box.type==='primary');
        if(!primary){const boxId=randomUUID();primary=value.mailboxes[boxId]={id:boxId,connectionId:id,address:mailboxAddress.data,displayName:text(identity.displayName,150)||mailboxAddress.data,type:'primary',enabled:true,allowedUserIds:[],revision:1};}
        else{primary.address=mailboxAddress.data;primary.enabled=true;primary.revision+=1;primary.syncLease=null;}
        attempt.status='completed';delete attempt.verifier;event(value,audit,context,'mail_microsoft_connected',{connectionId:id,mailboxId:primary.id});});
      return state(context);
    }catch(error){await write(value=>{const attempt=value.oauthAttempts[reserved.id];if(attempt){attempt.status='failed';delete attempt.verifier;}});throw error;}}
  async function disconnect(connectionId,context){await authorize(context,true);await write((value,state,audit)=>{principalIn(state,context,true);const connection=own(value.connections,connectionId);if(!connection)fail('Anslutningen finns inte.',404,'mail_not_found');
    connection.generation=randomUUID();connection.tokens=null;connection.refreshLease=null;connection.status='disconnected';connection.updatedAt=clock().toISOString();connection.lastError=null;
    for(const box of Object.values(value.mailboxes))if(box.connectionId===connectionId){box.enabled=false;box.revision+=1;box.syncLease=null;delete value.messages[box.id];}event(value,audit,context,'mail_microsoft_disconnected',{connectionId});});return state(context);}
  async function addMailbox(input,context){const parsed=mailboxInput.safeParse(input);if(!parsed.success)fail('Kontrollera inkorgens uppgifter.');await authorize(context,true);
    await write((value,state,audit)=>{principalIn(state,context,true);const connection=connectionIn(value,parsed.data.connectionId),existing=Object.values(value.mailboxes).find(box=>box.connectionId===connection.id&&box.address===parsed.data.address);
      if(existing)return;const id=randomUUID();value.mailboxes[id]={id,connectionId:connection.id,address:parsed.data.address,displayName:parsed.data.displayName??parsed.data.address,type:'shared',enabled:true,allowedUserIds:validateAcl(parsed.data.allowedUserIds,state),revision:1};event(value,audit,context,'mail_mailbox_added',{mailboxId:id,connectionId:connection.id});});return state(context);}
  async function updateMailbox(id,input,context){const parsed=mailboxPatch.safeParse(input);if(!parsed.success)fail('Kontrollera inkorgens uppgifter.');await authorize(context,true);
    await write((value,state,audit)=>{principalIn(state,context,true);const box=own(value.mailboxes,id);if(!box)fail('Inkorgen finns inte.',404,'mail_not_found');const patch=parsed.data;
      if(patch.allowedUserIds)patch.allowedUserIds=validateAcl(patch.allowedUserIds,state);Object.assign(box,patch,{revision:box.revision+1,syncLease:null});if(!box.enabled)delete value.messages[id];event(value,audit,context,'mail_mailbox_updated',{mailboxId:id});});return state(context);}
  async function syncMailbox(mailboxId,context){const principal=await authorize(context),snapshot=await read(value=>copy(boxIn(value,mailboxId,principal)));
    if(syncFlights.has(mailboxId))return syncFlights.get(mailboxId);
    const flight=(async()=>{const lease=randomUUID(),tokens=await access(snapshot.connectionId,context,mailboxId);await write((value,state)=>{const currentPrincipal=principalIn(state,context),box=boxIn(value,mailboxId,currentPrincipal);unchanged(value,box.connectionId,tokens.generation);
      if(box.revision!==snapshot.revision)fail('Inkorgen ändrades under hämtningen.',409,'mail_mailbox_changed');if(box.syncLease&&Date.parse(box.syncLease.expiresAt)>clock().getTime())fail('Inkorgen hämtas redan. Försök igen.',409,'mail_sync_pending');box.syncLease={id:lease,expiresAt:new Date(clock().getTime()+LEASE_MS).toISOString()};});
      try{const result=await client.listMessages({accessToken:tokens.accessToken,mailbox:snapshot.type==='primary'?'me':snapshot.address,maxCount:50});
        const messages=Object.fromEntries(result.messages.slice(0,50).map(raw=>{const item=metadata(raw,mailboxId);return [item.id,item];}));await authorize(context);
        await write((value,state,audit)=>{const currentPrincipal=principalIn(state,context),box=boxIn(value,mailboxId,currentPrincipal);unchanged(value,box.connectionId,tokens.generation);if(box.revision!==snapshot.revision||box.syncLease?.id!==lease)fail('Inkorgen ändrades under hämtningen.',409,'mail_mailbox_changed');
          value.messages[mailboxId]=messages;box.lastSyncedAt=clock().toISOString();box.lastError=null;box.hasMore=result.hasMore===true;box.syncLease=null;event(value,audit,context,'mail_mailbox_synchronized',{mailboxId,count:Object.keys(messages).length});});
      }catch(error){await write(value=>{const box=value.mailboxes[mailboxId];if(box?.revision===snapshot.revision&&box.syncLease?.id===lease){box.lastError=errorProjection(error);box.syncLease=null;}});throw error;}
    })();syncFlights.set(mailboxId,flight);try{return await flight;}finally{if(syncFlights.get(mailboxId)===flight)syncFlights.delete(mailboxId);}}
  async function sync(input={},context){if(!input||typeof input!=='object'||Object.keys(input).some(key=>key!=='mailboxId')||input.mailboxId!==undefined&&typeof input.mailboxId!=='string')fail('Välj en inkorg.');
    const principal=await authorize(context),ids=await read(value=>input.mailboxId?[boxIn(value,input.mailboxId,principal).id]:Object.values(value.mailboxes).filter(box=>canMailbox(box,principal)).map(box=>box.id));
    for(const id of ids)await syncMailbox(id,context);return state(context);}
  async function listMessages(input={},context){const parsed=z.object({mailboxId:identifier.optional(),unreadOnly:z.boolean().optional(),search:z.string().max(300).optional(),cursor:z.string().max(2000).optional()}).strict().safeParse(input);if(!parsed.success)fail('Kontrollera mejlsökningen.');const filters=parsed.data,principal=await authorize(context);
    return read(value=>{const ids=filters.mailboxId?[boxIn(value,filters.mailboxId,principal).id]:Object.values(value.mailboxes).filter(box=>canMailbox(box,principal)).map(box=>box.id).sort();
      const scope=hash([binding(context),ids,filters.unreadOnly===true,filters.search??'']);let offset=0;
      if(filters.cursor){try{const [encoded,signature,...extra]=filters.cursor.split('.'),expected=createHmac('sha256',encryptionKey()).update(encoded).digest('base64url');if(extra.length||signature?.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw new Error();const cursor=JSON.parse(Buffer.from(encoded,'base64url').toString());if(cursor.scope!==scope||cursor.revision!==value.revision||cursor.expiresAt<=clock().getTime()||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw new Error();offset=cursor.offset;}catch{fail('Mejllistan har ändrats. Hämta den igen.',409,'mail_cursor_stale');}}
      const all=ids.flatMap(id=>Object.values(value.messages[id]??{})),search=(filters.search??'').trim().toLowerCase(),selected=all.filter(item=>(!filters.unreadOnly||!item.isRead)&&(!search||`${item.subject} ${item.from.name} ${item.from.address} ${item.bodyPreview}`.toLowerCase().includes(search)))
        .sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt)||`${a.mailboxId}:${a.id}`.localeCompare(`${b.mailboxId}:${b.id}`));
      const hasMore=offset+50<selected.length;let nextCursor=null;if(hasMore){const encoded=Buffer.from(JSON.stringify({scope,revision:value.revision,offset:offset+50,expiresAt:clock().getTime()+15*60_000})).toString('base64url');nextCursor=encoded+'.'+createHmac('sha256',encryptionKey()).update(encoded).digest('base64url');}
      return {messages:selected.slice(offset,offset+50).map(publicMessage),hasMore,nextCursor,totalUnread:all.filter(item=>!item.isRead).length,countsPartial:ids.some(id=>value.mailboxes[id].hasMore===true)};},[['mailboxes'],['messages'],['revision']]);}
  async function matchesFor(sender,principal){if(![principal.actor,principal.user].every(user=>can(user,'view')))return {matches:[],matchStatus:'not-authorized'};const repo=await getRepository();
    const operation=state=>{const office=state.office??{},restricted=[principal.actor,principal.user].filter(user=>Array.isArray(user.siteIds));
      const permittedCustomers=new Set((office.cards??[]).filter(card=>restricted.every(user=>user.siteIds.includes(card.siteId))).map(card=>card.customerId));
      const found=(office.customers??[]).filter(customer=>address(customer.email)===sender&&sender&&(!restricted.length||permittedCustomers.has(customer.id)));
      const matches=found.map(customer=>copy(Object.fromEntries(['id','name','type','customerNumber','email','phone','address','postalCode','city'].map(key=>[key,customer[key]??'']))));return {matches,matchStatus:matches.length===1?'matched':matches.length>1?'multiple':'none'};};
    return repo.readProjection?repo.readProjection(operation,{domain:'office',paths:[['customers'],['cards']]}):repo.read(operation,{domains:['office']});}
  async function message(mailboxId,messageId,context){if(typeof messageId!=='string'||!messageId||messageId.length>2048)fail('Välj ett giltigt mejl.');const principal=await authorize(context),snapshot=await read(value=>{const box=boxIn(value,mailboxId,principal);if(!Object.hasOwn(value.messages[box.id]??{},messageId))fail('Mejlet finns inte i den synkroniserade inkorgen.',404,'mail_not_found');return copy(box);});
    const tokens=await access(snapshot.connectionId,context,mailboxId),raw=await client.getMessage({accessToken:tokens.accessToken,mailbox:snapshot.type==='primary'?'me':snapshot.address,messageId});
    if(raw.id!==messageId||String(raw.body?.contentType).toLowerCase()!=='text')fail('Microsofts mejl kunde inte verifieras som text.',502,'mail_response_invalid');const currentPrincipal=await authorize(context);
    await read(value=>{const box=boxIn(value,mailboxId,currentPrincipal);unchanged(value,box.connectionId,tokens.generation);if(box.revision!==snapshot.revision)fail('Inkorgen ändrades under hämtningen.',409,'mail_mailbox_changed');});
    const result={...metadata(raw,mailboxId),bodyText:text(raw.body.content,300_000),to:(raw.toRecipients??[]).slice(0,100).map(party),attachments:(raw.attachments??[]).slice(0,100).map(item=>({id:text(item.id,2048),name:text(item.name,300),size:Number.isSafeInteger(item.size)&&item.size>=0?item.size:0,contentType:text(item.contentType,150)})),
      ...(permittedLink(raw.webLink)&&{webLink:permittedLink(raw.webLink)})};return {message:result,...await matchesFor(result.from.address,currentPrincipal)};}
  async function integrationStatus(context){if(context)await authorize(context,true);const config=configuration();return read(value=>{const connected=(value.publicConnections??[]).some(item=>item.status==='connected'),failed=(value.publicConnections??[]).some(item=>item.status==='error');return {mode:config.ready?'production':'disabled',configured:config.ready,connected:config.ready&&connected,failed,
    lastCheckedAt:(value.publicMailboxes??[]).map(item=>item.lastSyncedAt).filter(Boolean).sort().at(-1)??null};},[['publicConnections'],['publicMailboxes']]);}
  return {state,connectMicrosoft,completeMicrosoft,disconnect,addMailbox,updateMailbox,sync,listMessages,message,integrationStatus};
}
