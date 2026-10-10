import { useEffect, useRef, useState } from 'react';
import { updateArticleCatalog, updateCustomerPriceCatalog } from './data';

type Identity = { actor: string; user: string } | { mobile: true };
type Pending<T> = { base: T; next: T };
type Options<T> = {
 domain: 'office' | 'mobile' | 'transport'; key: string; identity?: Identity;
 current: { current: T }; accept(data: T): void; error(message: string): void;
 parse(value: unknown): T;
};
/** A local recovery cache and serialized durable write queue. PostgreSQL remains
 * authoritative; failed writes are reported and survive lost connections. */
export function useSharedData<T>(options: Options<T>) {
 const latest=useRef(options);latest.current=options;
 const identityKey=options.identity && ('mobile' in options.identity?'mobile':`${options.identity.actor}:${options.identity.user}`);
 const [ready,setReady]=useState(false);
 const [,refreshCatalog]=useState(0), catalogSignature=useRef('');
 const state=useRef<{scope:string;ready:boolean;queue:Pending<T>[];sending:boolean;refreshRequested:boolean}>({scope:'',ready:false,queue:[],sending:false,refreshRequested:false});
 const runner=useRef<()=>Promise<void>>(async()=>{});
 const recoveryKey=`${options.key}.server-pending.${identityKey}`;
 function enqueue(next:T):boolean {
  const o=latest.current, s=state.current;
  if(!s.ready || s.scope!==identityKey){o.error('Ansluter till den gemensamma databasen. Vänta ett ögonblick.');return false;}
  try {
   const parsed=o.parse(next), item={base:structuredClone(o.current.current),next:parsed};
   const queue=[...s.queue,item], previousCache=localStorage.getItem(o.key);
   // Only queue work after both recovery writes succeed. A storage failure
   // must not leave a hidden operation for the next background sync to send.
   try {
    localStorage.setItem(o.key,JSON.stringify(parsed));
    localStorage.setItem(recoveryKey,JSON.stringify(queue));
   }catch(error){
    try {if(previousCache===null)localStorage.removeItem(o.key);else localStorage.setItem(o.key,previousCache);}catch { /* Keep the durable queue unchanged when storage is unavailable. */ }
    throw error;
   }
   s.queue=queue;
   o.current.current=parsed;o.accept(parsed);
   void runner.current();return true;
  }catch{o.error('Ändringen kunde inte sparas i återhämtningscachen.');return false;}
 }
 useEffect(()=>{
  const o=latest.current;
  if(!identityKey){state.current.ready=false;setReady(false);return;}
  let active=true;
  const s={scope:identityKey,ready:false,queue:[] as Pending<T>[],sending:false,refreshRequested:false};state.current=s;setReady(false);
  const headers:Record<string,string>={'Content-Type':'application/json',...('mobile' in o.identity! ? {'X-Demo-Mobile':'niklas'} : {'X-Demo-Actor':o.identity!.actor,'X-Demo-User':o.identity!.user})};
  const url=`/api/application/${o.domain}`;
  async function request(payload?:unknown) {
   const response=await fetch(url,{method:payload?'POST':'GET',headers,body:payload?JSON.stringify(payload):undefined});
   const result=await response.json();
   if(!response.ok)throw Object.assign(new Error(result.error??'Databasen kunde inte nås.'),{status:response.status});
   if(o.domain==='mobile' && Array.isArray(result.catalog)) {
    const signature=JSON.stringify([result.catalog,result.customerPrices]);
    if(signature!==catalogSignature.current){catalogSignature.current=signature;updateArticleCatalog(result.catalog);refreshCatalog(value=>value+1);}
   }
   if(o.domain==='mobile' && result.customerPrices)updateCustomerPriceCatalog(result.customerPrices);
   return result as {data:T;importConflicts?:number};
  }
  function accept(data:T) {
   if(!active)return;
   const parsed=latest.current.parse(data);
   if(JSON.stringify(latest.current.current.current)!==JSON.stringify(parsed)){latest.current.current.current=parsed;latest.current.accept(parsed);}
   localStorage.setItem(o.key,JSON.stringify(parsed));
  }
  async function sync() {
   if(!active)return;
   if(s.sending){s.refreshRequested=true;return;}
   s.sending=true;s.refreshRequested=false;
   try {
    if(!s.ready) {
     const legacy=localStorage.getItem(o.key);
     let result=await request();
     if(legacy&&!localStorage.getItem(`${o.key}.postgres-imported`)) {
      // Never overwrite the original local export, including conflicts.
      if(!localStorage.getItem(`${o.key}.legacy-before-postgres`))localStorage.setItem(`${o.key}.legacy-before-postgres`,legacy);
      let legacyData;
      try { legacyData=o.parse(JSON.parse(legacy)); }
      catch {
       await request({kind:'archive',data:{raw:legacy,reason:'Lokalt register kunde inte tolkas'}});
      }
      if(legacyData)result=await request({kind:'import',data:legacyData});
      localStorage.setItem(`${o.key}.postgres-imported`,'yes');
      if(result.importConflicts)latest.current.error('Äldre lokala uppgifter har bevarats separat där de skiljer sig från servern. Serverns aktuella uppgifter visas.');
     }
     if(!legacy)localStorage.setItem(`${o.key}.postgres-imported`,'yes');
     s.queue=JSON.parse(localStorage.getItem(recoveryKey)??'[]') as Pending<T>[];
     if(s.queue.length)accept(s.queue[s.queue.length-1].next);else accept(result.data);
     s.ready=true;if(active)setReady(true);
     if(!result.importConflicts)latest.current.error('');
    }
    if(s.queue.length) {
     while(active&&s.queue.length) {
      const item=s.queue[0], result=await request({kind:'update',...item});
      s.queue.shift();localStorage.setItem(recoveryKey,JSON.stringify(s.queue));
      if(!s.queue.length) {accept(result.data);latest.current.error('');}
     }
    }else {const result=await request();if(!s.queue.length)accept(result.data);}
   }catch(error) {
    if(active) {
     if((error as {status?:number}).status===409 && s.queue.length) {
      s.ready=false;setReady(false);
      try {
       localStorage.setItem(`${o.key}.conflict.${Date.now()}`,JSON.stringify(s.queue));
       // Archive every failed operation before removing it from the retry queue.
       for(const item of s.queue)await request({kind:'archive',data:item});
       const result=await request();s.queue=[];localStorage.setItem(recoveryKey,'[]');accept(result.data);s.ready=true;setReady(true);
       latest.current.error('Samtidig ändring: serverns aktuella uppgifter visas. Ditt osparade underlag har bevarats separat. Kontrollera och gör ändringen igen.');
      }catch {latest.current.error('Konflikten kunde inte arkiveras. Osparat arbete finns kvar på denna enhet.');}
     } else latest.current.error((error instanceof Error?error.message:'Anslutningen avbröts.')+(s.queue.length?' Osparat arbete finns kvar på denna enhet.':''));
    }
   }finally{
    s.sending=false;
    // Coalesce terminal events arriving during a write/read into one follow-up
    // sync. Existing queued edits are still serialized before accepting a read.
    if(active&&s.refreshRequested)void sync();
   }
  }
  runner.current=sync;void sync();
  const timer=setInterval(()=>void sync(),4000);
  const online=()=>void sync();window.addEventListener('online',online);
  return()=>{active=false;clearInterval(timer);window.removeEventListener('online',online);};
 },[identityKey,options.domain,options.key]);
 return {ready,save:enqueue,refresh:()=>runner.current()};
}
