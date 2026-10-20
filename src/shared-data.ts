import { useEffect, useRef, useState } from 'react';
import { articleGroups, updateArticleCatalog, updateCustomerPriceCatalog } from './data';
import { currentPlatformSession } from './platform/session';

type Identity = { actor: string; user: string } | { mobile: true } | { employee: string; companyId?: string };
function platformSessionForIdentity(identity: Identity | undefined) {
 const candidate = identity && ('actor' in identity || 'employee' in identity) ? currentPlatformSession() : undefined;
 if (!candidate?.authenticated) return undefined;
 if (identity && 'actor' in identity) return candidate;
 // Mobile support uses a virtual employee principal, never a real employee's
 // recovery cache. Only the matching authenticated platform actor supplies it.
 if (identity && 'employee' in identity && identity.employee === '__platform-admin'
   && candidate.actor.platformAdmin && candidate.organisationId === identity.companyId) return candidate;
 return undefined;
}
export const sharedBusinessIdentity = (identity: Identity | undefined) => {
 if (!identity) return undefined;
 const principal = 'employee' in identity ? `${identity.companyId ? `${identity.companyId}:` : ''}employee:${identity.employee}` : 'mobile' in identity ? 'mobile' : `${identity.actor}:${identity.user}`;
 const session = platformSessionForIdentity(identity);
 if ('employee' in identity && session) return `${session.organisationId}:${session.generation}:platform-admin:${session.actor.id}:${principal}`;
 return session?.organisationId ? `${session.organisationId}:${session.generation}:${principal}` : principal;
};
const identityScope = sharedBusinessIdentity;
/** Recovery data is never reused by another company, acting account or session
 * generation. These keys are client recovery aids, not authorization. */
export function sharedBusinessCacheKey(key: string, identity?: Identity) {
 const session = platformSessionForIdentity(identity);
 if (identity && 'employee' in identity && identity.companyId) {
  const employeeKey = `${key}.company.${encodeURIComponent(identity.companyId)}.employee.${encodeURIComponent(identity.employee)}`;
  return session ? `${employeeKey}.support.${encodeURIComponent(session.actor.id)}.generation.${encodeURIComponent(String(session.generation))}` : employeeKey;
 }
 return session?.organisationId
  ? `${key}.company.${encodeURIComponent(session.organisationId)}.principal.${encodeURIComponent(`${identity && 'actor' in identity ? identity.actor : ''}/${identity && 'actor' in identity ? identity.user : ''}`)}.generation.${encodeURIComponent(String(session.generation))}`
  : key;
}
type Pending<T> = { base: T; next: T };
type Options<T> = {
 domain: 'office' | 'mobile' | 'transport'; key: string; identity?: Identity;
 current: { current: T }; accept(data: T): void; error(message: string): void;
 parse(value: unknown): T;
};
export type BusinessChange = { identity: string; domain: string; revision?: number; eventId?: string };
export type BusinessConnection = { identity: string; connected: boolean };
const changeEvent = 'jeroc:business-change';
const connectionEvent = 'jeroc:business-connection';
const connections = new Map<string, boolean>();
const mobileCatalogCacheBaseKey = 'jeroc.mobile.article-catalog.v1';
let activeMobileCatalogScope = '';
/** Forward metadata from the existing authenticated staff stream, without
 * opening another connection or sharing customer projections between users. */
export function notifyBusinessChange(change: BusinessChange) {
 if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(changeEvent, { detail: change }));
}
export function notifyBusinessConnection(identity: string, connected: boolean) {
 connections.set(identity, connected);
 if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(connectionEvent, { detail: { identity, connected } }));
}
export function businessConnection(identity: string) { return connections.get(identity) === true; }

type SyncState<T> = {
 scope: string; ready: boolean; queue: Pending<T>[]; flight?: Promise<void>;
 observedRevision: number; confirmedRevision: number; confirmedEpoch: number;
 targetRevision: number; pendingChange: boolean; failure?: Error;
};
const equalValue = (first: unknown, second: unknown) => JSON.stringify(first) === JSON.stringify(second);
const objectValue = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const identifiedArray = (value: unknown): value is Array<Record<string, unknown> & { id: string | number }> => Array.isArray(value) && value.every(item => objectValue(item) && (typeof item.id === 'string' || typeof item.id === 'number')) && new Set(value.map(item => item.id)).size === value.length;
export function compactMobileUpdate(payload: unknown): unknown {
 if (!objectValue(payload) || !objectValue(payload.base) || !objectValue(payload.next)) return payload;
 const before = payload.base, after = payload.next;
 if (!identifiedArray(before.drafts) || !identifiedArray(after.drafts) || !identifiedArray(before.customers) || !identifiedArray(after.customers)) return payload;
 const changes = (base: Array<Record<string, unknown> & { id: string | number }>, next: Array<Record<string, unknown> & { id: string | number }>) => {
  const old = new Map(base.map(record => [record.id, record])), wanted = new Map(next.map(record => [record.id, record]));
  return [...new Set([...old.keys(), ...wanted.keys()])].filter(id => !equalValue(old.get(id), wanted.get(id)))
   .map(id => ({ id, ...(old.has(id) ? { base: old.get(id) } : {}), ...(wanted.has(id) ? { next: wanted.get(id) } : {}) }));
 };
 return { kind: 'records', version: 1, drafts: changes(before.drafts, after.drafts), customers: changes(before.customers, after.customers) };
}
/** Advance untouched server fields while retaining optimistic changes and the
 * old base of competing changes, so the server can explicitly reject them. */
export function rebaseConfirmedChanges<T>(base: T, next: T, confirmed: T): Pending<T> {
 function overlay(before: unknown, wanted: unknown, acknowledged: unknown): Pending<unknown> {
  if (equalValue(before, wanted)) return { base: acknowledged, next: acknowledged };
  if (equalValue(before, acknowledged)) return { base: acknowledged, next: wanted };
  if (identifiedArray(before) && identifiedArray(wanted) && identifiedArray(acknowledged)) {
   const originals = new Map(before.map(item => [item.id, item])), changes = new Map(wanted.map(item => [item.id, item])), server = new Map(acknowledged.map(item => [item.id, item]));
   const rebased: unknown[] = [], optimistic: unknown[] = [];
   for (const id of new Set([...server.keys(), ...originals.keys(), ...changes.keys()])) {
    const item = overlay(originals.get(id), changes.get(id), server.get(id));
    if (item.base !== undefined) rebased.push(item.base);
    if (item.next !== undefined) optimistic.push(item.next);
   }
   return { base: rebased, next: optimistic };
  }
  if (objectValue(before) && objectValue(wanted) && objectValue(acknowledged)) {
   const rebased: Record<string, unknown> = {}, optimistic: Record<string, unknown> = {};
   for (const field of new Set([...Object.keys(acknowledged), ...Object.keys(before), ...Object.keys(wanted)])) {
    const item = overlay(before[field], wanted[field], acknowledged[field]);
    if (item.base !== undefined) rebased[field] = item.base;
    if (item.next !== undefined) optimistic[field] = item.next;
   }
   return { base: rebased, next: optimistic };
  }
  // Atomic fields changed on both sides keep their original baseline. Removing
  // that baseline would turn an unresolved conflict into a silent overwrite.
  return { base: before, next: wanted };
 }
 return overlay(base, next, confirmed) as Pending<T>;
}
/** A local recovery cache and serialized durable write queue. PostgreSQL remains
 * authoritative; failed writes are reported and survive lost connections. */
export function useSharedData<T>(options: Options<T>) {
 const scopedOptions = { ...options, key: sharedBusinessCacheKey(options.key, options.identity) };
 const latest = useRef(scopedOptions); latest.current = scopedOptions;
 const identityKey = identityScope(options.identity);
 const [ready, setReady] = useState(false);
 const [, refreshCatalog] = useState(0), catalogSignature = useRef('');
 const state = useRef<SyncState<T>>({ scope: '', ready: false, queue: [], observedRevision: 0, confirmedRevision: 0, confirmedEpoch: 0, targetRevision: 0, pendingChange: false });
 const runner = useRef<() => Promise<void>>(async () => {});
 const recoveryKey = `${scopedOptions.key}.server-pending.${identityKey}`;
 function enqueue(next: T): boolean {
  const o = latest.current, s = state.current;
  if (!s.ready || s.scope !== identityKey || identityScope(o.identity) !== identityKey) { o.error('Ansluter till den gemensamma databasen. Vänta ett ögonblick.'); return false; }
  try {
   const parsed = o.parse(next), item = { base: structuredClone(o.current.current), next: parsed };
   const queue = [...s.queue, item], previousCache = localStorage.getItem(o.key);
   try {
    localStorage.setItem(o.key, JSON.stringify(parsed));
    localStorage.setItem(recoveryKey, JSON.stringify(queue));
   } catch (error) {
    try { if (previousCache === null) localStorage.removeItem(o.key); else localStorage.setItem(o.key, previousCache); } catch { /* Retain the previous durable queue. */ }
    throw error;
   }
   s.queue = queue; s.failure = undefined;
   o.current.current = parsed; o.accept(parsed);
   void runner.current(); return true;
  } catch { o.error('Ändringen kunde inte sparas i återhämtningscachen.'); return false; }
 }
 function applyConfirmed(updater: (current: T) => T, revision?: number) {
  const o = latest.current, s = state.current;
  if (s.scope !== identityKey || identityScope(o.identity) !== identityKey || !s.ready) return;
  if (revision !== undefined && revision < s.confirmedRevision) return;
  let acknowledged = s.queue.length ? o.parse(updater(s.queue[0].base)) : o.parse(updater(o.current.current));
  const queue = s.queue.map(item => {
   const rebased = rebaseConfirmedChanges(item.base, item.next, acknowledged);
   const operation = { base: o.parse(rebased.base), next: o.parse(rebased.next) };
   // Later operations keep earlier optimistic edits, including on the same
   // card, instead of restoring the original server projection over them.
   acknowledged = operation.next;
   return operation;
  });
  const parsed = acknowledged;
  s.queue = queue; s.confirmedEpoch += 1;
  if (revision !== undefined) { s.confirmedRevision = Math.max(s.confirmedRevision, revision); s.observedRevision = Math.max(s.observedRevision, revision); }
  o.current.current = parsed; o.accept(parsed);
  try { localStorage.setItem(o.key, JSON.stringify(parsed)); localStorage.setItem(recoveryKey, JSON.stringify(queue)); }
  catch { o.error('Serverändringen är sparad, men återhämtningscachen kunde inte uppdateras.'); }
 }
 async function flush() {
  const s = state.current;
  if (s.scope !== identityKey || identityScope(latest.current.identity) !== identityKey) throw new Error('Användaren har ändrats. Försök igen.');
  if (s.ready && !s.queue.length && !s.failure) return;
  await runner.current();
  if (state.current !== s) throw new Error('Användaren har ändrats. Försök igen.');
  if (!s.ready || s.queue.length || s.failure) throw s.failure ?? new Error('Osparade ändringar kunde inte sparas. Försök igen.');
 }
 useEffect(() => {
  const o = latest.current;
  if (!identityKey) { state.current.ready = false; setReady(false); return; }
  let active = true, followUp: ReturnType<typeof setTimeout> | undefined;
  const s: SyncState<T> = { scope: identityKey, ready: false, queue: [], observedRevision: 0, confirmedRevision: 0, confirmedEpoch: 0, targetRevision: 0, pendingChange: false };
  state.current = s; setReady(false);
  const principal = o.identity!;
  const platformSession = platformSessionForIdentity(principal);
  const streamIdentity = 'employee' in principal ? `${principal.companyId ? `${principal.companyId}:` : ''}employee:${principal.employee}` : 'mobile' in principal ? 'mobile' : `${principal.actor}/${principal.user}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...('employee' in principal ? principal.companyId ? { 'X-Employee-Company': principal.companyId } : {} : 'mobile' in principal ? { 'X-Demo-Mobile': 'niklas' } : { 'X-Demo-Actor': principal.actor, 'X-Demo-User': principal.user }),
   ...(platformSession ? { 'X-Platform-Generation': String(platformSession.generation), 'X-Platform-CSRF': platformSession.csrfToken,
    ...(platformSession.organisationId ? { 'X-Platform-Organisation-Id': platformSession.organisationId } : {}) } : {}) };
  const url = `/api/application/${o.domain}`;
  const mobileCatalogCacheKey = sharedBusinessCacheKey(mobileCatalogCacheBaseKey, principal);
  if (o.domain === 'mobile') {
   if ('employee' in principal && principal.companyId && activeMobileCatalogScope !== identityKey) {
    // Module-level catalogs belong to the previous login until explicitly
    // cleared. Never display another company's prices during the first read.
    updateArticleCatalog([], []); updateCustomerPriceCatalog({});
    catalogSignature.current = ''; activeMobileCatalogScope = identityKey;
   }
   try {
    const cached = JSON.parse(localStorage.getItem(mobileCatalogCacheKey) ?? 'null');
    if (cached?.version === 1 && updateArticleCatalog(cached.catalog, cached.groups)) refreshCatalog(value => value + 1);
   } catch { /* A damaged catalog cache leaves the seed register intact. */ }
  }
  const currentScope = () => {
   const current = latest.current, principal = current.identity;
   const currentIdentity = identityScope(principal);
   return active && state.current === s && currentIdentity === identityKey && current.domain === o.domain && current.key === o.key;
  };
  async function request(payload?: unknown) {
   const confirmedEpoch = s.confirmedEpoch;
   const command = o.domain === 'mobile' ? compactMobileUpdate(payload) : payload;
   const requestUrl = o.domain === 'mobile' && !payload ? `${url}?prices=none` : url;
   const response = await fetch(requestUrl, { method: payload ? 'POST' : 'GET', credentials: 'same-origin', headers, body: payload ? JSON.stringify(command) : undefined });
   const result = await response.json();
   if (!currentScope()) throw new DOMException('Användaren har ändrats.', 'AbortError');
   if (!response.ok) {
    if ('employee' in principal && (response.status === 401 || result.code === 'EMPLOYEE_TIME_REQUIRED')) window.dispatchEvent(new Event('jeroc:employee-session-check'));
    throw Object.assign(new Error(result.error ?? 'Databasen kunde inte nås.'), { status: response.status, code: result.code, gate: result.gate });
   }
   if (o.domain === 'mobile' && Array.isArray(result.catalog)) {
    const signature = JSON.stringify([result.catalog, result.groups, result.customerPrices]);
    if (signature !== catalogSignature.current && updateArticleCatalog(result.catalog, result.groups)) {
     catalogSignature.current = signature;
     refreshCatalog(value => value + 1);
     try { localStorage.setItem(mobileCatalogCacheKey, JSON.stringify({ version: 1, catalog: result.catalog, groups: articleGroups })); }
     catch { /* The current server register remains usable without a cache. */ }
    }
   }
   if (o.domain === 'mobile' && result.customerPrices) updateCustomerPriceCatalog(result.customerPrices);
   if (o.domain === 'mobile' && typeof result.businessDate === 'string') observedBusinessDate = result.businessDate;
   if (o.domain === 'mobile' && typeof result.mobilePricingRevision === 'string') window.dispatchEvent(new CustomEvent('jeroc:mobile-pricing-change', { detail: { identity: identityKey, revision: result.mobilePricingRevision } }));
   if (o.domain === 'mobile' && 'employee' in principal && objectValue(command) && command.kind === 'records'
       && Array.isArray(command.drafts) && objectValue(result.data) && Array.isArray(result.data.drafts)) {
    // A completed draft is optimistic until the write is acknowledged. Refresh
    // Home only after that commit, including when navigation beat the save.
    const confirmedDrafts: unknown[] = result.data.drafts;
    const confirmedReady = new Set(confirmedDrafts.filter(objectValue).filter(draft => draft.status === 'ready').map(draft => draft.id));
    const completed = command.drafts.some(change => objectValue(change) && typeof change.id === 'string'
      && objectValue(change.next) && change.next.status === 'ready'
      && (!objectValue(change.base) || change.base.status !== 'ready') && confirmedReady.has(change.id));
    if (completed) window.dispatchEvent(new CustomEvent('jeroc:mobile-weighing-submitted', {
     detail: { companyId: principal.companyId ?? 'jeroc-demo', personId: principal.employee },
    }));
   }
   return { ...result, confirmedEpoch } as { data: T; revision?: number; importConflicts?: number; confirmedEpoch: number };
  }
  function accept(data: T) {
   if (!currentScope()) return;
   const parsed = latest.current.parse(data);
   if (JSON.stringify(latest.current.current.current) !== JSON.stringify(parsed)) { latest.current.current.current = parsed; latest.current.accept(parsed); }
   localStorage.setItem(o.key, JSON.stringify(parsed));
  }
  function acceptResult(result: { data: T; revision?: number; confirmedEpoch: number }) {
   if (result.revision !== undefined) s.observedRevision = Math.max(s.observedRevision, result.revision);
   if (s.queue.length) return;
   if (result.revision !== undefined && result.revision < s.confirmedRevision) return;
   if (result.confirmedEpoch !== s.confirmedEpoch && (result.revision === undefined || result.revision <= s.confirmedRevision)) return;
   accept(result.data);
   if (result.revision !== undefined) s.confirmedRevision = Math.max(s.confirmedRevision, result.revision);
  }
  function sync(): Promise<void> {
   if (!currentScope()) return Promise.resolve();
   if (s.flight) return s.flight;
   s.pendingChange = false;
   const task = (async () => {
    let bootstrapped = false;
    try {
     s.failure = undefined;
     if (!s.ready) {
      const legacy = localStorage.getItem(o.key);
      let result = await request();
      // A platform account always starts with its server projection. Importing
      // browser demo state into a selected company would cross company scopes.
      const allowLegacyImport = !platformSession && !('employee' in principal && principal.companyId && principal.companyId !== 'jeroc-demo');
      if (allowLegacyImport && legacy && !localStorage.getItem(`${o.key}.postgres-imported`)) {
       if (!localStorage.getItem(`${o.key}.legacy-before-postgres`)) localStorage.setItem(`${o.key}.legacy-before-postgres`, legacy);
       let legacyData;
       try { legacyData = o.parse(JSON.parse(legacy)); }
       catch { await request({ kind: 'archive', data: { raw: legacy, reason: 'Lokalt register kunde inte tolkas' } }); }
       if (legacyData) result = await request({ kind: 'import', data: legacyData });
       localStorage.setItem(`${o.key}.postgres-imported`, 'yes');
       if (result.importConflicts) latest.current.error('Äldre lokala uppgifter har bevarats separat där de skiljer sig från servern. Serverns aktuella uppgifter visas.');
      }
      if (!legacy) localStorage.setItem(`${o.key}.postgres-imported`, 'yes');
      const recovery = JSON.parse(localStorage.getItem(recoveryKey) ?? '[]') as Pending<T>[];
      s.queue = recovery.map(item => ({ base: o.parse(item.base), next: o.parse(item.next) }));
      if (s.queue.length) accept(s.queue[s.queue.length - 1].next); else acceptResult(result);
      s.ready = true; setReady(true); bootstrapped = true;
      if (!result.importConflicts) latest.current.error('');
     }
     if (s.queue.length) {
      while (currentScope() && s.queue.length) {
       const item = s.queue[0], result = await request({ kind: 'update', ...item });
       s.queue.shift(); localStorage.setItem(recoveryKey, JSON.stringify(s.queue));
       acceptResult(result);
       if (!s.queue.length) latest.current.error('');
      }
     } else if (!bootstrapped) { const result = await request(); acceptResult(result); }
    } catch (error) {
     if (!currentScope()) return;
     s.failure = error instanceof Error ? error : new Error('Anslutningen avbröts.');
     if ((error as { status?: number }).status === 409 && s.queue.length) {
      s.ready = false; setReady(false);
      try {
       localStorage.setItem(`${o.key}.conflict.${Date.now()}`, JSON.stringify(s.queue));
       for (const item of s.queue) await request({ kind: 'archive', data: item });
       const result = await request(); s.queue = []; localStorage.setItem(recoveryKey, '[]'); acceptResult(result); s.ready = true; setReady(true);
       latest.current.error('Samtidig ändring: serverns aktuella uppgifter visas. Ditt osparade underlag har bevarats separat. Kontrollera och gör ändringen igen.');
      } catch { latest.current.error('Konflikten kunde inte arkiveras. Osparat arbete finns kvar på denna enhet.'); }
     } else latest.current.error(s.failure.message + (s.queue.length ? ' Osparat arbete finns kvar på denna enhet.' : ''));
    }
   })();
   s.flight = task;
   void task.finally(() => {
    if (s.flight === task) s.flight = undefined;
    if (currentScope() && !s.failure && (s.queue.length || (s.pendingChange && s.targetRevision > s.observedRevision))) {
     followUp = setTimeout(() => { followUp = undefined; void sync(); }, 60);
    }
   });
   return task;
  }
  const onChange = (event: Event) => {
   const change = (event as CustomEvent<BusinessChange>).detail;
   if (change.identity !== streamIdentity || change.domain !== 'application') return;
   if (change.revision !== undefined && change.revision <= s.observedRevision) return;
   s.targetRevision = Math.max(s.targetRevision, change.revision ?? s.observedRevision + 1);
   if (s.flight) s.pendingChange = true; else { if (followUp) clearTimeout(followUp); followUp = setTimeout(() => { followUp = undefined; if (s.targetRevision > s.observedRevision) void sync(); }, 60); }
  };
  const online = () => void sync();
  const visible = () => { if (document.visibilityState === 'visible') void sync(); };
  // With a live staff stream, reads follow committed revisions. Mobile and
  // disconnected clients retain a small recovery poll without overlapping it.
  let lastPoll = Date.now();
  let checkingRevision = false;
  let observedBusinessDate: string | undefined;
  async function checkRevision() {
   if (!currentScope() || s.flight || checkingRevision || navigator.onLine === false) return;
   if (!s.ready || s.queue.length || s.failure) { void sync(); return; }
   checkingRevision = true;
   try {
    const response = await fetch(`/api/application/revision?domain=${o.domain}`, { credentials: 'same-origin', headers });
    const value = await response.json();
    if (!currentScope()) return;
    if (!response.ok) {
     if ('employee' in principal && response.status === 401) window.dispatchEvent(new Event('jeroc:employee-session-check'));
     throw new Error(value.error ?? 'Databasen kunde inte nås.');
    }
    const changedDay = o.domain === 'mobile' && typeof value.businessDate === 'string'
      && value.businessDate !== observedBusinessDate;
    observedBusinessDate = value.businessDate;
    if (changedDay || Number.isSafeInteger(value.revision) && value.revision > s.observedRevision) void sync();
   } catch (error) {
    if (currentScope()) latest.current.error(error instanceof Error ? error.message : 'Databasen kunde inte nås.');
   } finally { checkingRevision = false; }
  }
  const timer = setInterval(() => {
   const delay = businessConnection(streamIdentity) ? 60000 : 15000;
   if (document.visibilityState === 'visible' && Date.now() - lastPoll >= delay) { lastPoll = Date.now(); void checkRevision(); }
  }, 2000);
  runner.current = sync; void sync();
  window.addEventListener(changeEvent, onChange); window.addEventListener('online', online); document.addEventListener('visibilitychange', visible);
  return () => { active = false; clearInterval(timer); if (followUp) clearTimeout(followUp); window.removeEventListener(changeEvent, onChange); window.removeEventListener('online', online); document.removeEventListener('visibilitychange', visible); };
 }, [identityKey, options.domain, scopedOptions.key]);
 return { ready: ready && state.current.scope === identityKey, save: enqueue, refresh: () => runner.current(), flush, applyConfirmed };
}
