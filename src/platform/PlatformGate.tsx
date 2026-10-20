import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Building2, LogOut, Settings2, ShieldCheck, UserRound } from 'lucide-react';
import { platformApi } from './client';
import { setCurrentPlatformSession } from './session';
import ProductBrand from './ProductBrand';
import CompanyBrand from './CompanyBrand';
import { useCompanyDefaults, type CompanyDefaultsSnapshot } from '../company-settings-defaults';
import PlatformLogin from './PlatformLogin';
import PlatformPasswordChange from './PlatformPasswordChange';
import PlatformPasswordRecovery from './PlatformPasswordRecovery';
import PlatformProfile from './PlatformProfile';
import PlatformAdmin from './PlatformAdmin';
import PlatformCompanySwitcher from './PlatformCompanySwitcher';
import type { AuthenticatedPlatformSession, PlatformSession } from './types';
import './platform.css';

export type PlatformContextValue = {
  session: AuthenticatedPlatformSession;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  switchCompany: (organisationId: string, effectiveUserId?: string) => Promise<void>;
  openAdministration: () => void;
  companyBranding?: CompanyDefaultsSnapshot;
};
const Context = createContext<PlatformContextValue | undefined>(undefined);
export const usePlatformContext = () => useContext(Context);

export default function PlatformGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PlatformSession>(), [error, setError] = useState('');
  const [checking, setChecking] = useState(true), [attempt, setAttempt] = useState(0), [switcherOpen, setSwitcherOpen] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const checkingSession = useRef<Promise<void> | undefined>(undefined);
  const openingAdministration = useRef<Promise<void> | undefined>(undefined);
  const initialSession = useRef<{ attempt: number; promise: Promise<PlatformSession> } | undefined>(undefined);
  const location = useLocation(), navigate = useNavigate();
  const recoveryMode = location.pathname === '/forgot-password' ? 'request' : location.pathname === '/reset-password' ? 'reset' : undefined;
  const sessionKey = session?.authenticated ? `${session.organisationId}/${session.generation}` : '';
  const companyBranding = useCompanyDefaults({ enabled: Boolean(!recoveryMode && session?.authenticated && session.company && !session.mustChangePassword),
    scopeKey: sessionKey, refreshOnSave: true });
  useEffect(() => {
    const element = shell.current, bar = element?.querySelector<HTMLElement>('.platform-topbar'), strip = element?.querySelector<HTMLElement>('.platform-support-strip');
    if (!element || !bar) return;
    const measure = () => {
      element.style.setProperty('--platform-topbar-height', `${bar.getBoundingClientRect().height}px`);
      element.style.setProperty('--platform-header-height', `${bar.getBoundingClientRect().height + (strip?.getBoundingClientRect().height ?? 0)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(bar); if (strip) observer.observe(strip);
    return () => observer.disconnect();
  }, [sessionKey, location.pathname]);
  function accept(value: PlatformSession) {
    setCurrentPlatformSession(value); setSession(value); setError('');
  }
  async function openRequestedCompany(value: PlatformSession): Promise<PlatformSession> {
    if (!value.authenticated || value.mustChangePassword) return value;
    const query = new URLSearchParams(window.location.search), requested = query.get('company');
    setCurrentPlatformSession(value);
    const selected = requested && requested !== value.organisationId ? await platformApi.switchCompany(requested) : value;
    if (requested) {
      query.delete('company');
      window.history.replaceState(null, '', `${window.location.pathname}${query.size ? `?${query}` : ''}${window.location.hash}`);
    }
    return selected;
  }
  function authenticated(value: AuthenticatedPlatformSession) {
    setChecking(true);
    void openRequestedCompany(value).then(selected => {
      accept(selected);
      if (selected.authenticated && selected.actor.platformAdmin && !selected.company) navigate('/platform-admin', { replace: true });
    }).catch(failure => { setSession(value); setError(failure instanceof Error ? failure.message : 'Bolaget kunde inte öppnas.'); })
      .finally(() => setChecking(false));
  }
  useEffect(() => {
    if (recoveryMode) { initialSession.current = undefined; return; }
    let live = true; setChecking(true); setError('');
    // StrictMode can remount an effect. Share the whole initialization so a
    // company link cannot submit two switches with the same prior generation.
    if (initialSession.current?.attempt !== attempt)
      initialSession.current = { attempt, promise: platformApi.session().then(openRequestedCompany) };
    void initialSession.current.promise
      .then(value => { if (live) accept(value); })
      .catch(failure => { if (live) setError(failure instanceof Error ? failure.message : 'Inloggningen kunde inte kontrolleras.'); })
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [attempt, recoveryMode]);
  useEffect(() => {
    const check = () => {
      if (recoveryMode || checkingSession.current) return;
      checkingSession.current = platformApi.session().then(accept)
        .catch(failure => setError(failure instanceof Error ? failure.message : 'Inloggningen kunde inte kontrolleras.'))
        .finally(() => { checkingSession.current = undefined; });
    };
    window.addEventListener('scrappilot:check-platform-session', check);
    return () => window.removeEventListener('scrappilot:check-platform-session', check);
  }, [recoveryMode]);
  async function refresh() { accept(await platformApi.session()); }
  async function logout() {
    await platformApi.logout();
    setCurrentPlatformSession(undefined);
    window.history.replaceState(null, '', '/kontor#/dashboard'); window.location.reload();
  }
  async function switchCompany(organisationId: string, effectiveUserId?: string) {
    accept(await platformApi.switchCompany(organisationId, effectiveUserId));
    // Unmount old forms, cancel requests and reset module caches through a fresh
    // page. No business data from the previous tenant remains in component state.
    window.history.replaceState(null, '', '/kontor#/dashboard'); window.location.reload();
  }
  const openAdministration = () => {
    setSwitcherOpen(false);
    if (!session?.authenticated || !session.actor.platformAdmin) return;
    if (!session.isSupportSession && (!session.company || session.company.id === 'jeroc-demo')) {
      navigate('/platform-admin'); return;
    }
    if (openingAdministration.current) return;
    setChecking(true); setError('');
    openingAdministration.current = platformApi.openAdministration().then(value => {
      accept(value);
      // Discard mounted forms and caches from the tenant we just left.
      window.history.replaceState(null, '', '/kontor#/platform-admin'); window.location.reload();
    }).catch(failure => setError(failure instanceof Error ? failure.message : 'Systemadministrationen kunde inte öppnas.'))
      .finally(() => { openingAdministration.current = undefined; setChecking(false); });
  };
  if (recoveryMode) return <PlatformPasswordRecovery key={recoveryMode} mode={recoveryMode} onCompleted={() => {
    setCurrentPlatformSession(undefined); setSession({ enabled: true, authenticated: false }); setError('');
  }} />;
  if (checking) return <main className="platform-auth-screen"><div className="platform-loading" role="status"><ProductBrand large /><span className="platform-spinner" /><p>Öppnar din arbetsyta…</p></div></main>;
  if (!session || error) return <main className="platform-auth-screen"><section className="platform-auth-card"><ProductBrand large /><h1>Arbetsytan kunde inte öppnas</h1><p className="platform-error" role="alert">{error || 'Inloggningstjänsten är inte tillgänglig.'}</p><button type="button" className="platform-btn" onClick={() => setAttempt(value => value + 1)}>Försök igen</button>{new URLSearchParams(window.location.search).has('company') && <button className="platform-text-btn" type="button" onClick={() => {
    const query = new URLSearchParams(window.location.search); query.delete('company');
    window.history.replaceState(null, '', `${window.location.pathname}${query.size ? `?${query}` : ''}${window.location.hash}`);
    setAttempt(value => value + 1);
  }}>Öppna min arbetsyta</button>}<Link className="platform-text-btn" to="/forgot-password">Glömt lösenord?</Link></section></main>;
  if (!session.authenticated) return <PlatformLogin onSession={authenticated} />;
  if (session.mustChangePassword) return <PlatformPasswordChange session={session} onSession={authenticated} onLogout={logout} />;
  const showAdmin = session.actor.platformAdmin && (!session.company || location.pathname === '/platform-admin');
  const showProfile = location.pathname === '/profile';
  const context: PlatformContextValue = { session, refresh, logout, switchCompany, openAdministration, companyBranding };
  return <Context.Provider value={context}><div ref={shell} className={`platform-shell${showAdmin ? ' admin' : ' platform-office'}`}>
    <header className="platform-topbar">
      {session.actor.platformAdmin ? <ProductBrand /> : <CompanyBrand branding={companyBranding} className="platform-brand" />}
      <span className="platform-company-name">{showProfile ? <><UserRound size={16} />Mitt konto</> : showAdmin ? <><ShieldCheck size={16} />Systemadministration</> : <><Building2 size={16} />{companyBranding?.profile.name ?? session.company?.name ?? 'Välj bolag'}</>}</span>
      <div className="platform-topbar-actions">
        {session.actor.platformAdmin && !showAdmin && <button type="button" className="platform-text-btn" onClick={openAdministration}><Settings2 size={16} />Systemadmin</button>}
        {showAdmin && session.isSupportSession && <button type="button" className="platform-text-btn" onClick={openAdministration}><ShieldCheck size={16} />Avsluta Jobba som</button>}
        {!showAdmin && (session.actor.platformAdmin || session.companies.length > 1) && <button type="button" className="platform-text-btn" aria-expanded={switcherOpen} onClick={() => setSwitcherOpen(value => !value)}><Building2 size={16} />{session.actor.platformAdmin ? 'Jobba som bolag' : 'Byt bolag'}</button>}
        <Link className="platform-text-btn" aria-label="Min profil" aria-current={showProfile ? 'page' : undefined} to="/profile"><UserRound size={16} /><span className="platform-actor">{session.actor.name}</span>Min profil</Link>
        <button type="button" className="platform-text-btn" onClick={() => void logout().catch(failure => setError(failure instanceof Error ? failure.message : 'Utloggningen misslyckades.'))}><LogOut size={16} />Logga ut</button>
      </div>
    </header>
    {switcherOpen && <section className="platform-context-menu" aria-label="Byt bolag eller behörighet"><PlatformCompanySwitcher session={session} companies={session.companies} onSwitch={switchCompany} compact /></section>}
    {session.isSupportSession && !showAdmin && <div className="platform-support-strip"><ShieldCheck size={15} />{session.actor.name} arbetar som {session.user.name} i {session.company?.name}. Historiken sparar både inloggad och vald användare.</div>}
    {showProfile ? <PlatformProfile key={`${session.actor.id}/${session.organisationId ?? ''}/${session.generation}/${session.user.id}`} session={session} /> : showAdmin ? <PlatformAdmin session={session} onSwitch={switchCompany} /> : !session.company ? <main className="platform-admin"><section className="platform-panel"><h1>Välj bolag</h1><PlatformCompanySwitcher session={session} companies={session.companies} onSwitch={switchCompany} /></section></main>
      : <div className="platform-office-body" key={`${session.organisationId}/${session.generation}`}>{children}</div>}
  </div></Context.Provider>;
}
