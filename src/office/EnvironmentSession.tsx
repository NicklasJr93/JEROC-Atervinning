import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyRound, Leaf, RefreshCw } from 'lucide-react';
import type { OfficeUser } from './model';
import { environmentApi, EnvironmentApiError } from './environment-client';
import type { EnvironmentSessionState, EnvironmentState } from './environment-types';
import './environment.css';

export const environmentFailure = (failure: unknown) => failure instanceof Error ? failure.message : 'Åtgärden kunde inte utföras.';
export const hasEnvironmentPermission = (user: OfficeUser, permission: 'environmentRead' | 'environmentWrite' | 'environmentClassify') => user.level !== 'Medarbetare' || (user.permissions as readonly string[]).includes(permission);
interface EnvironmentContextValue {
  session?: EnvironmentSessionState; state?: EnvironmentState; loading: boolean; error: string;
  user: OfficeUser; actualUser: OfficeUser;
  login: (password: string) => Promise<void>; refresh: () => Promise<void>;
}
const EnvironmentContext = createContext<EnvironmentContextValue | null>(null);
export function useEnvironmentSession() {
  const context = useContext(EnvironmentContext);
  if (!context) throw new Error('Miljökomponenter behöver EnvironmentSessionProvider.');
  return context;
}
export function EnvironmentSessionProvider({ user, actualUser, children, onNotice }: { user: OfficeUser; actualUser: OfficeUser; children: ReactNode; onNotice?: (message: string) => void }) {
  const [session, setSession] = useState<EnvironmentSessionState>();
  const [state, setState] = useState<EnvironmentState>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const identity = `${actualUser.id}/${user.id}`;
  const permissionSignature = `${user.level}/${user.permissions.join(',')}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const matches = useCallback((value: EnvironmentSessionState) => value.actualUserId === actualUser.id && value.effectiveUserId === user.id, [actualUser.id, user.id]);
  const refresh = useCallback(async () => {
    const startIdentity = identity;
    try {
      const next = await environmentApi.state();
      if (identityRef.current === startIdentity) { setState(next); setError(''); }
    } catch (failure) {
      if (identityRef.current !== startIdentity) return;
      if (failure instanceof EnvironmentApiError && failure.status === 401) { setSession(undefined); setState(undefined); }
      if (failure instanceof EnvironmentApiError && failure.status === 403) setState(undefined);
      setError(environmentFailure(failure)); throw failure;
    }
  }, [identity]);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setSession(undefined); setState(undefined); setError(''); setLoading(true);
    void environmentApi.session(controller.signal).then(async next => {
      if (!active) return;
      if (!matches(next)) { await environmentApi.logout(); return; }
      setSession(next);
      if (hasEnvironmentPermission(user, 'environmentRead')) {
        const nextState = await environmentApi.state(controller.signal);
        if (active) setState(nextState);
      }
    }).catch(failure => {
      if (!active || controller.signal.aborted) return;
      if (!(failure instanceof EnvironmentApiError && failure.status === 401)) setError(environmentFailure(failure));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [identity, matches, permissionSignature]);
  useEffect(() => {
    if (!session || !matches(session) || !hasEnvironmentPermission(user, 'environmentRead')) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh().catch(() => undefined); }, 8000);
    return () => window.clearInterval(timer);
  }, [session, matches, refresh, permissionSignature]);
  const login = useCallback(async (password: string) => {
    const startIdentity = identity;
    setLoading(true); setError('');
    try {
      const next = await environmentApi.login(actualUser.id, password, user.id);
      if (identityRef.current !== startIdentity || !matches(next)) return;
      setSession(next);
      await refresh();
      onNotice?.('Miljödemot är anslutet. Mottagningar sparas gemensamt på servern.');
    } catch (failure) {
      if (identityRef.current === startIdentity) setError(environmentFailure(failure));
      throw failure;
    } finally { if (identityRef.current === startIdentity) setLoading(false); }
  }, [actualUser.id, user.id, identity, matches, refresh, onNotice]);
  return <EnvironmentContext.Provider value={{ session: session && matches(session) ? session : undefined, state, loading, error, user, actualUser, login, refresh }}>{children}</EnvironmentContext.Provider>;
}

export function EnvironmentAccessBoundary({ children, permission = 'environmentRead' }: { children: ReactNode; permission?: 'environmentRead' | 'environmentWrite' | 'environmentClassify' }) {
  const { session, user, actualUser, login, loading, error, refresh } = useEnvironmentSession();
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  useEffect(() => { setPassword(''); setLocalError(''); }, [user.id, actualUser.id]);
  if (!hasEnvironmentPermission(user, permission)) return <div className="environment-access environment-muted"><Leaf size={18} /><span>Du saknar behörighet för denna miljöfunktion.</span></div>;
  if (session) return <>{error && <div className="environment-alert" role="alert">{error}<button type="button" className="office-link" onClick={() => void refresh().catch(() => undefined)}><RefreshCw size={13} />Försök igen</button></div>}{children}</>;
  async function connect() {
    if (loading) return;
    setLocalError('');
    try { await login(password); setPassword(''); }
    catch (failure) { setLocalError(environmentFailure(failure)); }
  }
  return <div className="environment-access" data-testid="environment-session-login"><span className="environment-icon"><KeyRound size={20} /></span><div className="environment-access-copy"><strong>Anslut till miljödemot</strong><p>{actualUser.name}{actualUser.id !== user.id ? ` · jobbar som ${user.name}` : ''}. Personlig serverinloggning för gemensamt sparade mottagningar.</p><small>DEMO · lösenord: <code>JerocDemo2026!</code></small></div><div className="environment-access-actions"><input type="password" aria-label="Lösenord för miljödemot" autoComplete="current-password" placeholder="Demolösenord" value={password} onChange={event => setPassword(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void connect(); } }} /><button type="button" className="office-btn" disabled={loading || !password} onClick={() => void connect()}>{loading ? 'Ansluter…' : 'Anslut'}</button></div>{(localError || error) && <div className="environment-error" role="alert">{localError || error}</div>}</div>;
}
