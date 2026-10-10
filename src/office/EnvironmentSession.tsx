import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Leaf, RefreshCw } from 'lucide-react';
import { can, type OfficeUser, type Permission } from './model';
import { environmentApi, EnvironmentApiError } from './environment-client';
import type { EnvironmentSessionState, EnvironmentState } from './environment-types';
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
}
const EnvironmentContext = createContext<EnvironmentContextValue | null>(null);

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
  const permissionSignature = `${user.level}/${user.permissions.join(',')}/${user.siteIds?.join(',') ?? 'all'}`;
  const readable = hasEnvironmentPermission(user, 'environmentRead');
  const permitted = readable || can(user, 'integrationsRead') || hasEnvironmentPermission(user, 'environmentWrite') || hasEnvironmentPermission(user, 'environmentClassify') || hasEnvironmentPermission(user, 'environmentStorage');
  const matches = useCallback((value: { actualUserId: string; effectiveUserId: string }) =>
    value.actualUserId === actualUser.id && value.effectiveUserId === user.id, [actualUser.id, user.id]);

  const refresh = useCallback(async () => {
    const expectedIdentity = identity;
    const expectedGeneration = generation.current;
    const current = () => identityRef.current === expectedIdentity && generation.current === expectedGeneration && activeOwner === owner.current;
    try {
      await orderedConnection(async () => {
        if (!current()) return;
        let nextSession: EnvironmentSessionState | undefined;
        try { nextSession = await environmentApi.session(); }
        catch (failure) {
          if (!(failure instanceof EnvironmentApiError && failure.status === 401)) throw failure;
        }
        if (!current()) return;
        if (!permitted) {
          if (nextSession && matches(nextSession)) { environmentApi.adoptSession(nextSession); await environmentApi.logout(); }
          if (current()) { setSession(undefined); setState(undefined); setError(''); }
          return;
        }
        if (!nextSession || !matches(nextSession)) nextSession = await environmentApi.demoSession(actualUser.id, user.id);
        if (!current()) return;
        if (!matches(nextSession)) throw new Error('Miljösessionen tillhör ett annat konto. Försök igen.');
        environmentApi.adoptSession(nextSession);
        const nextState = readable ? await environmentApi.state() : undefined;
        if (!current()) return;
        if (nextState && !matches(nextState)) throw new Error('Kontot ändrades i en annan flik. Försök igen för att hämta dina miljöuppgifter.');
        setSession(nextSession);
        setState(nextState);
        setError('');
      });
    } catch (failure) {
      if (current()) {
        environmentApi.forgetSession();
        setSession(undefined);
        setState(undefined);
        setError(environmentFailure(failure));
      }
      throw failure;
    }
  }, [identity, actualUser.id, user.id, readable, permitted, matches, permissionSignature]);

  useEffect(() => {
    activeOwner = owner.current;
    generation.current += 1;
    const expectedGeneration = generation.current;
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
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [session, matches, readable, refresh]);

  return <EnvironmentContext.Provider value={{ session: session && matches(session) ? session : undefined, state, loading, error, user, actualUser, refresh }}>{children}</EnvironmentContext.Provider>;
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
