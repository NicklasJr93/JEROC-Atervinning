import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Leaf, RefreshCw } from 'lucide-react';
import { can, type OfficeUser, type Permission } from './model';
import { environmentApi, EnvironmentApiError } from './environment-client';
import type { BusinessChange } from '../shared-data';
import type { EnvironmentalDraft, EnvironmentalReceipt, EnvironmentalSourceProjection, EnvironmentSessionState, EnvironmentState } from './environment-types';
import './environment.css';

export const environmentFailure = (failure: unknown) => failure instanceof Error ? failure.message : 'Åtgärden kunde inte utföras.';
export const hasEnvironmentPermission = (user: OfficeUser, permission: Extract<Permission, `environment${string}`>) => can(user, permission);
interface EnvironmentContextValue {
  session?: EnvironmentSessionState;
  state?: EnvironmentState;
  loading: boolean;
  error: string;
  user: OfficeUser;
  actualUser: OfficeUser;
  refresh: () => Promise<void>;
  refreshSource: (sourceId: string) => Promise<EnvironmentalSourceProjection | undefined>;
  applySource: (projection: EnvironmentalSourceProjection) => void;
  applyReceipt: (receipt: EnvironmentalReceipt) => void;
  applyDraft: (draft: EnvironmentalDraft) => void;
}
const EnvironmentContext = createContext<EnvironmentContextValue | null>(null);
const mergeVersioned = <T extends { id?: string; articleId?: string; version: number }>(current: T[], incoming: T[]) => {
  const result = new Map(current.map(item => [item.id ?? item.articleId, item]));
  for (const item of incoming) {
    const key = item.id ?? item.articleId, previous = result.get(key);
    if (!previous || item.version >= previous.version) result.set(key, item);
  }
  return [...result.values()];
};
const withoutPatch = <T extends { environmentPatch?: EnvironmentalSourceProjection }>(value: T): T => {
  const { environmentPatch: _patch, ...rest } = value;
  return rest as T;
};

// Account changes finish in order because the browser shares one cookie.
// This is explicit demo authentication, not a production personnel login.
let connectionQueue = Promise.resolve();
let activeOwner: symbol | undefined;
function orderedConnection<T>(operation: () => Promise<T>): Promise<T> {
  const result = connectionQueue.then(operation);
  connectionQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function useEnvironmentSession() {
  const context = useContext(EnvironmentContext);
  if (!context) throw new Error('Miljökomponenter behöver EnvironmentSessionProvider.');
  return context;
}

export function EnvironmentSessionProvider({ user, actualUser, children }: {
  user: OfficeUser;
  actualUser: OfficeUser;
  children: ReactNode;
  onNotice?: (message: string) => void;
}) {
  const [session, setSession] = useState<EnvironmentSessionState>();
  const [state, setState] = useState<EnvironmentState>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const owner = useRef(Symbol('environment-session'));
  const identity = `${actualUser.id}/${user.id}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const generation = useRef(0);
  const stateRef = useRef<EnvironmentState | undefined>(undefined), sessionRef = useRef<EnvironmentSessionState | undefined>(undefined);
  const mutationGeneration = useRef(0), sourceRevisions = useRef(new Map<string, number>());
  const fullReadRevision = useRef(-1);
  const inFlight = useRef<{ generation: number; promise: Promise<void>; controller: AbortController } | undefined>(undefined);
  const sourceFlights = useRef(new Map<string, { generation: number; promise: Promise<EnvironmentalSourceProjection | undefined>; controller: AbortController }>());
  const permissionSignature = `${actualUser.level}/${actualUser.permissions.join(',')}/${actualUser.siteIds?.join(',') ?? 'all'}/${user.level}/${user.permissions.join(',')}/${user.siteIds?.join(',') ?? 'all'}`;
  const readable = hasEnvironmentPermission(user, 'environmentRead');
  const permitted = readable || can(user, 'integrationsRead') || hasEnvironmentPermission(user, 'environmentWrite') || hasEnvironmentPermission(user, 'environmentClassify') || hasEnvironmentPermission(user, 'environmentStorage');
  const matches = useCallback((value: { actualUserId: string; effectiveUserId: string }) =>
    value.actualUserId === actualUser.id && value.effectiveUserId === user.id, [actualUser.id, user.id]);

  const publish = useCallback((next: EnvironmentState) => { stateRef.current = next; setState(next); }, []);
  const emptyState = useCallback((): EnvironmentState => ({
    demo: true, mode: 'prepared-only', revision: 0, actualUserId: actualUser.id, effectiveUserId: user.id,
    sites: [], municipalities: [], classifications: [], receipts: [], storagePolicies: [], inventory: [], reports: [], drafts: [], corrections: [], reportHistory: [],
  }), [actualUser.id, user.id]);
  const applySource = useCallback((projection: EnvironmentalSourceProjection) => {
    if (!sessionRef.current || !matches(sessionRef.current) || activeOwner !== owner.current) return;
    if (projection.revision < Math.max(fullReadRevision.current, sourceRevisions.current.get(projection.sourceId) ?? -1)) return;
    const current = stateRef.current ?? emptyState();
    sourceRevisions.current.set(projection.sourceId, projection.revision); mutationGeneration.current += 1;
    const receipt = projection.receipt && withoutPatch(projection.receipt), draft = projection.draft && withoutPatch(projection.draft);
    publish({ ...current, revision: Math.max(current.revision, projection.revision),
      sites: mergeVersioned(current.sites, projection.sites), classifications: mergeVersioned(current.classifications, projection.classifications),
      storagePolicies: mergeVersioned(current.storagePolicies, projection.storagePolicies), municipalities: projection.municipalities ?? current.municipalities,
      receipts: [...current.receipts.filter(item => item.sourceId !== projection.sourceId), ...(receipt ? [receipt] : [])],
      drafts: [...current.drafts.filter(item => item.sourceId !== projection.sourceId), ...(draft ? [draft] : [])],
      reports: [...current.reports.filter(item => item.sourceId !== projection.sourceId), ...projection.reports],
      reportHistory: [...current.reportHistory.filter(item => item.sourceId !== projection.sourceId), ...projection.reportHistory],
      inventory: [...current.inventory.filter(item => item.sourceId !== projection.sourceId), ...projection.inventory],
      corrections: [...current.corrections.filter(item => item.sourceId !== projection.sourceId), ...(receipt?.correctionHistory ?? [])],
    });
  }, [emptyState, matches, publish]);
  const applyReceipt = useCallback((value: EnvironmentalReceipt) => {
    if (value.environmentPatch) { applySource(value.environmentPatch); return; }
    if (!sessionRef.current || !matches(sessionRef.current) || activeOwner !== owner.current) return;
    const current = stateRef.current ?? emptyState(), receipt = withoutPatch(value);
    if ((current.receipts.find(item => item.sourceId === receipt.sourceId)?.version ?? 0) > receipt.version) return;
    mutationGeneration.current += 1;
    publish({ ...current, receipts: [...current.receipts.filter(item => item.sourceId !== receipt.sourceId), receipt], drafts: current.drafts.filter(item => item.sourceId !== receipt.sourceId) });
  }, [applySource, emptyState, matches, publish]);
  const applyDraft = useCallback((value: EnvironmentalDraft) => {
    if (value.environmentPatch) { applySource(value.environmentPatch); return; }
    if (!sessionRef.current || !matches(sessionRef.current) || activeOwner !== owner.current) return;
    const current = stateRef.current ?? emptyState(), draft = withoutPatch(value);
    if ((current.drafts.find(item => item.sourceId === draft.sourceId)?.version ?? 0) > draft.version) return;
    mutationGeneration.current += 1;
    publish({ ...current, drafts: [...current.drafts.filter(item => item.sourceId !== draft.sourceId), draft] });
  }, [applySource, emptyState, matches, publish]);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current?.generation === generation.current) return inFlight.current.promise;
    const expectedIdentity = identity;
    const expectedGeneration = generation.current;
    const controller = new AbortController();
    const current = () => identityRef.current === expectedIdentity && generation.current === expectedGeneration && activeOwner === owner.current;
    const promise = (async () => {
      // Publish the single-flight promise before any early return can clear it.
      await Promise.resolve();
      try {
        if (!current() || !permitted) return;
        if (!sessionRef.current || !matches(sessionRef.current)) await orderedConnection(async () => {
          if (!current()) return;
          let nextSession: EnvironmentSessionState | undefined;
          try { nextSession = await environmentApi.session(controller.signal); }
          catch (failure) { if (!(failure instanceof EnvironmentApiError && failure.status === 401)) throw failure; }
          if (!current()) return;
          if (!nextSession || !matches(nextSession)) nextSession = await environmentApi.demoSession(actualUser.id, user.id);
          if (!current()) return;
          if (!matches(nextSession)) throw new Error('Miljösessionen tillhör ett annat konto. Försök igen.');
          environmentApi.adoptSession(nextSession); sessionRef.current = nextSession; setSession(nextSession);
        });
        if (!current() || !sessionRef.current) return;
        if (readable) {
          const epoch = mutationGeneration.current, beforeRevision = stateRef.current?.revision ?? -1;
          const next = await environmentApi.state(controller.signal);
          if (!current()) return;
          if (!matches(next)) throw new EnvironmentApiError('Kontot ändrades i en annan flik. Försök igen för att hämta dina miljöuppgifter.', 'identity_mismatch', 403);
          if (next.revision >= (stateRef.current?.revision ?? -1) && (epoch === mutationGeneration.current || next.revision > beforeRevision)) { fullReadRevision.current = next.revision; publish(next); }
        }
        if (current()) setError('');
      } catch (failure) {
        if (current() && !controller.signal.aborted) {
          if (failure instanceof EnvironmentApiError && [401, 403].includes(failure.status)) {
            generation.current += 1;
            for (const flight of sourceFlights.current.values()) flight.controller.abort(); sourceFlights.current.clear();
            environmentApi.forgetSession(); sessionRef.current = undefined; stateRef.current = undefined;
            setSession(undefined); setState(undefined); setLoading(false);
          }
          setError(environmentFailure(failure));
        }
        if (!controller.signal.aborted) throw failure;
      } finally {
        if (inFlight.current?.generation === expectedGeneration) inFlight.current = undefined;
      }
    })();
    inFlight.current = { generation: expectedGeneration, promise, controller };
    return promise;
  }, [identity, actualUser.id, user.id, readable, permitted, matches, permissionSignature, publish]);

  const refreshSource = useCallback((sourceId: string): Promise<EnvironmentalSourceProjection | undefined> => {
    if (!sourceId || !readable || !sessionRef.current || !matches(sessionRef.current)) return Promise.resolve(undefined);
    const existing = sourceFlights.current.get(sourceId);
    if (existing?.generation === generation.current) return existing.promise;
    const expectedIdentity = identity, expectedGeneration = generation.current, controller = new AbortController();
    const current = () => !controller.signal.aborted && identityRef.current === expectedIdentity && generation.current === expectedGeneration && activeOwner === owner.current;
    const epoch = mutationGeneration.current, beforeRevision = stateRef.current?.revision ?? -1;
    const promise = environmentApi.source(sourceId, controller.signal).then(projection => {
      if (current() && (epoch === mutationGeneration.current || projection.revision > beforeRevision)) applySource(projection);
      return current() ? projection : undefined;
    }).catch(failure => {
      if (current() && failure instanceof EnvironmentApiError && [401, 403].includes(failure.status)) {
        generation.current += 1; inFlight.current?.controller.abort(); inFlight.current = undefined;
        for (const flight of sourceFlights.current.values()) flight.controller.abort(); sourceFlights.current.clear();
        environmentApi.forgetSession(); sessionRef.current = undefined; stateRef.current = undefined;
        setSession(undefined); setState(undefined); setLoading(false); setError(environmentFailure(failure));
      }
      if (!controller.signal.aborted) throw failure;
      return undefined;
    }).finally(() => { if (sourceFlights.current.get(sourceId)?.generation === expectedGeneration) sourceFlights.current.delete(sourceId); });
    sourceFlights.current.set(sourceId, { generation: expectedGeneration, promise, controller });
    return promise;
  }, [identity, readable, matches, applySource]);

  useEffect(() => {
    activeOwner = owner.current;
    generation.current += 1;
    const expectedGeneration = generation.current;
    inFlight.current?.controller.abort(); inFlight.current = undefined;
    for (const flight of sourceFlights.current.values()) flight.controller.abort(); sourceFlights.current.clear(); sourceRevisions.current.clear(); fullReadRevision.current = -1;
    sessionRef.current = undefined; stateRef.current = undefined;
    setSession(undefined);
    setState(undefined);
    setError('');
    setLoading(true);
    environmentApi.forgetSession();
    void refresh().catch(() => undefined).finally(() => {
      if (generation.current === expectedGeneration && activeOwner === owner.current) setLoading(false);
    });
  }, [refresh]);

  useEffect(() => () => {
    const releasedIdentity = identityRef.current;
    generation.current += 1;
    inFlight.current?.controller.abort(); for (const flight of sourceFlights.current.values()) flight.controller.abort();
    if (activeOwner === owner.current) activeOwner = undefined;
    void orderedConnection(async () => {
      if (activeOwner) return;
      try {
        const existing = await environmentApi.session();
        if (!activeOwner && `${existing.actualUserId}/${existing.effectiveUserId}` === releasedIdentity) { environmentApi.adoptSession(existing); await environmentApi.logout(); }
      } catch { /* Session may already be expired or the server disconnected. */ }
    });
  }, []);

  useEffect(() => {
    if (!session || !matches(session) || !readable) return;
    let scheduled: ReturnType<typeof setTimeout> | undefined, active = true, targetRevision = -1;
    const invalidate = (event: Event) => {
      const change = (event as CustomEvent<BusinessChange>).detail;
      if (change.identity !== identity || change.domain !== 'environment') return;
      if (change.revision !== undefined && change.revision <= (stateRef.current?.revision ?? -1)) return;
      targetRevision = Math.max(targetRevision, change.revision ?? 0);
      if (scheduled) clearTimeout(scheduled);
      scheduled = setTimeout(() => {
        scheduled = undefined;
        if (!active || !sessionRef.current || targetRevision <= (stateRef.current?.revision ?? -1)) return;
        void refresh().then(() => {
          // One coalesced follow-up covers an event received during an older
          // read; polling never adds work behind an in-flight request.
          if (active && sessionRef.current && targetRevision > (stateRef.current?.revision ?? -1)) void refresh().catch(() => undefined);
        }).catch(() => undefined);
      }, 80);
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    }, 30000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh().catch(() => undefined); };
    window.addEventListener('jeroc:business-change', invalidate);
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearInterval(timer); if (scheduled) clearTimeout(scheduled); window.removeEventListener('jeroc:business-change', invalidate); document.removeEventListener('visibilitychange', visible); };
  }, [identity, session, matches, readable, refresh]);

  return <EnvironmentContext.Provider value={{ session: session && matches(session) ? session : undefined, state: state && matches(state) ? state : undefined, loading, error, user, actualUser, refresh, refreshSource, applySource, applyReceipt, applyDraft }}>{children}</EnvironmentContext.Provider>;
}

export function EnvironmentAccessBoundary({ children, permission = 'environmentRead' }: {
  children: ReactNode;
  permission?: 'environmentRead' | 'environmentWrite' | 'environmentClassify' | 'environmentStorage' | 'integrationsRead';
}) {
  const { session, user, loading, error, refresh } = useEnvironmentSession();
  if (!can(user, permission)) return <div className="environment-access environment-muted"><Leaf size={18} /><span>Du saknar behörighet för denna funktion.</span></div>;
  if (!session) return <div className={`environment-access ${error ? 'environment-error' : 'environment-muted'}`} role={error ? 'alert' : undefined}>
    <Leaf size={18} /><span>{error || (loading ? 'Hämtar miljöuppgifter…' : 'Miljöuppgifterna kunde inte hämtas.')}</span>
    {!loading && <button type="button" className="office-link" onClick={() => void refresh().catch(() => undefined)}><RefreshCw size={14} />Försök igen</button>}
  </div>;
  return <>{error && <div className="environment-alert" role="alert">{error}<button type="button" className="office-link" onClick={() => void refresh().catch(() => undefined)}><RefreshCw size={13} />Försök igen</button></div>}{children}</>;
}
