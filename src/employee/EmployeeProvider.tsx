import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { EmployeeAccountPerson, EmployeeAdminSession, EmployeeClockAction, EmployeeClockCorrection, EmployeeLeaveDraft, EmployeeOverview, EmployeeRequirement, EmployeeRequirementPerson, EmployeeSession, EmployeeTimeDraft, EmployeeTimeGate } from './types';
import { employeeCompanyId } from './cache';
import type { EmployeeSicknessCommand } from './sickness-types';
import { platformRequestHeaders, setCurrentPlatformSession } from '../platform/session';
import type { AuthenticatedPlatformSession } from '../platform/types';
import { platformApi } from '../platform/client';

let requestCompanyId: string | undefined;
let requestPersonId: string | undefined;

export class EmployeeError extends Error {
  constructor(message: string, public status: number, public code?: string, public gate?: EmployeeTimeGate) { super(message); }
}
export async function employeeRequest<T>(path: string, body?: unknown, options?: { signal?: AbortSignal; expectedCompanyId?: string; expectedPersonId?: string }): Promise<T> {
  // Capture the initiating company. A cookie changed in another tab must not
  // silently redirect an existing form or pending command to another company.
  const expectedCompany = options?.expectedCompanyId ?? requestCompanyId;
  const expectedPerson = options?.expectedPersonId ?? (path.split('?')[0] === '/login' ? undefined : requestPersonId);
  const platformHeaders = platformRequestHeaders();
  const controller = new AbortController();
  const abort = () => controller.abort(options?.signal?.reason);
  if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = body === undefined ? window.setTimeout(() => { timedOut = true; controller.abort(); }, 15000) : undefined;
  try {
    const response = await fetch(`/api/employee${path}`, {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { ...platformHeaders, ...(expectedCompany ? { 'X-Employee-Company': expectedCompany } : {}), ...(expectedPerson ? { 'X-Employee-Person': expectedPerson } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new EmployeeError(result?.error || result?.message || 'Kunde inte kontakta servern. Försök igen.', response.status, result?.code, result?.gate);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!result || typeof result !== 'object') throw new EmployeeError('Servern gav ett ofullständigt svar. Försök igen.', 502, 'invalid_response');
    return result as T;
  } catch (error) {
    if (timedOut) throw new EmployeeError('Servern svarade inte i tid. Kontrollera anslutningen och försök igen.', 0, 'request_timeout');
    throw error;
  } finally { if (timer !== undefined) window.clearTimeout(timer); options?.signal?.removeEventListener('abort', abort); }
}
export const employeeError = (error: unknown) => error instanceof TypeError ? 'Kunde inte nå servern. Kontrollera anslutningen och försök igen.' : error instanceof Error ? error.message : 'Något gick fel. Försök igen.';
export const stockholmDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

interface EmployeeContextValue {
  session: EmployeeSession | null; overview: EmployeeOverview | null;
  admin: EmployeeAdminSession | null; adminBusy: boolean;
  loading: boolean; refreshing: boolean; error: string; sessionGeneration: number;
  login: (username: string, password: string) => Promise<EmployeeOverview | EmployeeAdminSession>;
  openCompanySelection: () => Promise<void>;
  chooseCompany: (companyId: string) => Promise<boolean>;
  changeAdminPassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: (focus?: { month?: string; date?: string; view?: 'bootstrap' | 'full' }) => Promise<void>;
  saveTime: (entry: EmployeeTimeDraft) => Promise<void>;
  removeTime: (id: string, revision: number) => Promise<void>;
  requestLeave: (request: EmployeeLeaveDraft) => Promise<void>;
  cancelLeave: (id: string, revision: number) => Promise<void>;
  updateProfile: (profile: { phone: string; email: string }) => Promise<void>;
  changePassword: (currentPassword: string, password: string) => Promise<void>;
  setActiveSite: (siteId: string) => Promise<void>;
  loadRequirements: () => Promise<EmployeeRequirementPerson[]>;
  saveRequirement: (personId: string, requirement: EmployeeRequirement) => Promise<void>;
  loadAccounts: () => Promise<EmployeeAccountPerson[]>;
  saveAccount: (account: { personId: string; username: string; active: boolean; password?: string }) => Promise<void>;
  commandOrder: (orderId: string, command: 'start' | 'stop' | 'logistics' | 'status', body?: unknown) => Promise<void>;
  clockBusy: boolean;
  commandClock: (command: EmployeeClockAction | EmployeeClockCorrection) => Promise<void>;
  commandSickness: (command: EmployeeSicknessCommand) => Promise<void>;
}
const EmployeeContext = createContext<EmployeeContextValue | null>(null);
const adminPlatformSession = (value: AuthenticatedPlatformSession | undefined): value is AuthenticatedPlatformSession => Boolean(value?.authenticated
  && value.actor?.platformAdmin === true && typeof value.actor.id === 'string' && typeof value.csrfToken === 'string'
  && value.csrfToken && (typeof value.generation === 'string' || typeof value.generation === 'number') && Array.isArray(value.companies));
const activeAdminSession = (value: EmployeeAdminSession): EmployeeAdminSession => {
  if (value?.kind !== 'platform-admin' || !adminPlatformSession(value.platformSession) || !Array.isArray(value.companies))
    throw new EmployeeError('Administratörens inloggning kunde inte verifieras. Logga in igen.', 502, 'admin_session_invalid');
  return { ...value, companies: value.companies.filter(company => company.status === 'active') };
};

export function EmployeeProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<EmployeeOverview | null>(null);
  const [session, setSession] = useState<EmployeeSession | null>(null);
  const [admin, setAdmin] = useState<EmployeeAdminSession | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const adminRef = useRef<EmployeeAdminSession | null>(null), adminBusyRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [clockBusy, setClockBusy] = useState(false);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const clockBusyRef = useRef(false), overviewRef = useRef<EmployeeOverview | null>(null);
  const generation = useRef(0);
  const sequence = useRef(0);
  const focus = useRef({ month: stockholmDay().slice(0, 7), date: stockholmDay() });
  const sessionRef = useRef<EmployeeSession | null>(null);
  const invalidate = useCallback(() => { sequence.current += 1; const current = ++generation.current; setSessionGeneration(current); return current; }, []);
  const clearBusinessSession = useCallback(() => {
    requestCompanyId = undefined; requestPersonId = undefined;
    setSession(null); sessionRef.current = null; overviewRef.current = null; setOverview(null);
    setRefreshing(false); clockBusyRef.current = false; setClockBusy(false);
  }, []);
  const applyAdmin = useCallback((value: EmployeeAdminSession) => {
    const next = activeAdminSession(value);
    clearBusinessSession();
    setCurrentPlatformSession(next.platformSession); adminRef.current = next; setAdmin(next); setError('');
  }, [clearBusinessSession]);
  const apply = useCallback((result: EmployeeOverview) => {
    const previous = overviewRef.current;
    if (previous && previous.companyId === result.companyId && previous.person.id === result.person.id && result.revision < previous.revision) return;
    if (previous && (previous.companyId !== result.companyId || previous.person.id !== result.person.id)) invalidate();
    if (result.support) {
      const platform = result.support.platformSession;
      if (result.support.kind !== 'platform-admin' || !adminPlatformSession(platform) || platform.organisationId !== result.companyId
        || result.support.organisationId !== result.companyId || String(platform.generation) !== String(result.support.generation)
        || platform.csrfToken !== result.support.csrfToken)
        throw new EmployeeError('Administratörens bolag kunde inte verifieras. Logga in igen.', 502, 'admin_session_invalid');
      const next = activeAdminSession({ kind: 'platform-admin', platformSession: platform, companies: platform.companies });
      setCurrentPlatformSession(platform); adminRef.current = next; setAdmin(next);
    } else {
      setCurrentPlatformSession(undefined); adminRef.current = null; setAdmin(null);
    }
    requestCompanyId = employeeCompanyId(result.companyId);
    requestPersonId = result.person.id;
    overviewRef.current = result;
    setOverview(result); setSession(result); sessionRef.current = result; setError(''); setRefreshing(false);
  }, [invalidate]);
  const clearSession = useCallback(() => {
    invalidate();
    clearBusinessSession(); setCurrentPlatformSession(undefined); adminRef.current = null; setAdmin(null);
    adminBusyRef.current = false; setAdminBusy(false);
  }, [invalidate, clearBusinessSession]);
  const refresh = useCallback(async (next?: { month?: string; date?: string; view?: 'bootstrap' | 'full' }) => {
    if (next) focus.current = { month: next.month ?? focus.current.month, date: next.date ?? focus.current.date };
    if (!sessionRef.current) return;
    const current = generation.current, currentSequence = ++sequence.current;
    setRefreshing(true);
    try {
      const query = new URLSearchParams(focus.current);
      if (next?.view === 'bootstrap' || !next && overviewRef.current?.monthLoaded === false) query.set('view', 'bootstrap');
      const result = await employeeRequest<EmployeeOverview>(`/overview?${query}`);
      if (current !== generation.current || currentSequence !== sequence.current) return;
      apply(result);
    } catch (caught) {
      if (current !== generation.current || currentSequence !== sequence.current) return;
      if (caught instanceof EmployeeError && (caught.status === 401 || caught.code === 'company_selection_changed')) clearSession();
      setError(employeeError(caught));
      throw caught;
    } finally { if (current === generation.current && currentSequence === sequence.current) setRefreshing(false); }
  }, [apply, clearSession]);

  useEffect(() => {
    const current = invalidate();
    const controller = new AbortController();
    setLoading(true);
    void employeeRequest<EmployeeOverview | EmployeeAdminSession>('/session?view=bootstrap', undefined, { signal: controller.signal }).then(result => {
      if (generation.current === current) {
        if ('kind' in result && result.kind === 'platform-admin') applyAdmin(result);
        else { const overview = result as EmployeeOverview; focus.current = { month: overview.month, date: overview.date }; apply(overview); }
      }
    }).catch(caught => {
      if (generation.current === current && !(caught instanceof EmployeeError && caught.status === 401)) setError(employeeError(caught));
    }).finally(() => { if (generation.current === current) setLoading(false); });
    return () => { controller.abort(); generation.current += 1; sequence.current += 1; setCurrentPlatformSession(undefined); };
  }, [apply, applyAdmin, invalidate]);

  useEffect(() => {
    const expired = () => {
      if (!adminRef.current) return;
      clearSession(); setError('Administratörens session har avslutats. Logga in igen.');
    };
    window.addEventListener('scrappilot:check-platform-session', expired);
    return () => window.removeEventListener('scrappilot:check-platform-session', expired);
  }, [clearSession]);

  useEffect(() => {
    if (!session) return;
    const check = () => { if (!document.hidden) void refresh().catch(() => undefined); };
    // A minute checks for a new Stockholm day, not a network poll.
    let day = stockholmDay();
    const timer = window.setInterval(() => {
      const next = stockholmDay();
      if (next !== day) { day = next; check(); }
    }, 60_000);
    document.addEventListener('visibilitychange', check); window.addEventListener('online', check);
    window.addEventListener('jeroc:employee-session-check', check);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', check); window.removeEventListener('online', check); window.removeEventListener('jeroc:employee-session-check', check); };
  }, [session?.person.id, session?.companyId, refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const current = invalidate();
    setError('');
    const result = await employeeRequest<EmployeeOverview | EmployeeAdminSession>('/login?view=bootstrap', { username: username.trim(), password });
    if (current !== generation.current) throw new EmployeeError('Inloggningen avbröts.', 409);
    if ('kind' in result && result.kind === 'platform-admin') applyAdmin(result);
    else { const overview = result as EmployeeOverview; focus.current = { month: overview.month, date: overview.date }; apply(overview); }
    return result;
  }, [apply, applyAdmin, invalidate]);
  const openCompanySelection = useCallback(async () => {
    if (!adminRef.current || adminBusyRef.current) return;
    const current = invalidate(); clearBusinessSession(); adminBusyRef.current = true; setAdminBusy(true); setError('');
    try {
      const next = await employeeRequest<EmployeeAdminSession>('/companies');
      if (current === generation.current) applyAdmin(next);
    } catch (caught) {
      if (current === generation.current) {
        if (caught instanceof EmployeeError && caught.status === 401) clearSession();
        setError(employeeError(caught));
      }
      throw caught;
    } finally { if (current === generation.current) { adminBusyRef.current = false; setAdminBusy(false); } }
  }, [invalidate, clearBusinessSession, applyAdmin, clearSession]);
  const chooseCompany = useCallback(async (companyId: string) => {
    if (!adminRef.current || adminBusyRef.current) return false;
    if (adminRef.current.platformSession.mustChangePassword || !adminRef.current.companies.some(company => company.id === companyId && company.status === 'active'))
      throw new EmployeeError('Välj ett tillgängligt bolag.', 403);
    const current = invalidate(); clearBusinessSession(); adminBusyRef.current = true; setAdminBusy(true); setError('');
    try {
      const next = await employeeRequest<EmployeeOverview>('/company?view=bootstrap', { companyId });
      if (current !== generation.current) return false;
      if (!next.support || next.companyId !== companyId) throw new EmployeeError('Bolaget kunde inte verifieras. Logga in igen.', 502);
      focus.current = { month: next.month, date: next.date }; apply(next); return true;
    } catch (caught) {
      if (current === generation.current) {
        if (!(caught instanceof EmployeeError) || caught.status === 401 || caught.status >= 500) clearSession();
        setError(employeeError(caught));
      }
      throw caught;
    } finally { if (current === generation.current) { adminBusyRef.current = false; setAdminBusy(false); } }
  }, [invalidate, clearBusinessSession, apply, clearSession]);
  const changeAdminPassword = useCallback(async (currentPassword: string, newPassword: string) => {
    if (!adminRef.current || adminBusyRef.current) return;
    const current = invalidate(); adminBusyRef.current = true; setAdminBusy(true); setError('');
    try {
      const next = await platformApi.changePassword(currentPassword, newPassword);
      if (current !== generation.current) return;
      if (!adminPlatformSession(next)) throw new EmployeeError('Inloggningen kunde inte verifieras. Logga in igen.', 502);
      applyAdmin({ kind: 'platform-admin', platformSession: next, companies: next.companies });
    } catch (caught) { if (current === generation.current) setError(employeeError(caught)); throw caught; }
    finally { if (current === generation.current) { adminBusyRef.current = false; setAdminBusy(false); } }
  }, [invalidate, applyAdmin]);
  const logout = useCallback(async () => {
    // Invalidate pending responses immediately. A failed logout keeps the known session.
    const current = invalidate();
    if (adminRef.current) { clearBusinessSession(); adminBusyRef.current = true; setAdminBusy(true); }
    try { await employeeRequest('/logout', {}); }
    catch (caught) { if (!(caught instanceof EmployeeError && caught.status === 401)) { adminBusyRef.current = false; setAdminBusy(false); setError(employeeError(caught)); throw caught; } }
    if (current === generation.current) { clearSession(); setError(''); }
  }, [clearSession, clearBusinessSession, invalidate]);
  const mutate = useCallback(async (path: string, body: unknown, targetDate?: string) => {
    const current = generation.current;
    sequence.current += 1;
    if (targetDate) focus.current = { month: targetDate.slice(0, 7), date: targetDate };
    try {
      const query = new URLSearchParams(focus.current);
      if (overviewRef.current?.monthLoaded === false) query.set('view', 'bootstrap');
      const result = await employeeRequest<EmployeeOverview>(`${path}?${query}`, body);
      if (current !== generation.current) throw new EmployeeError('Kontot ändrades medan uppgifterna sparades.', 409);
      sequence.current += 1;
      if (result?.person && result?.gate && result?.days && result.date === focus.current.date && result.month === focus.current.month) apply(result);
      else await refresh();
    } catch (caught) {
      if (current === generation.current) {
        if (caught instanceof EmployeeError && (caught.status === 401 || caught.code === 'company_selection_changed')) clearSession();
        else if (caught instanceof EmployeeError && caught.code === 'EMPLOYEE_TIME_REQUIRED') {
          if (caught.gate) setOverview(value => value ? { ...value, gate: caught.gate! } : value);
          void refresh().catch(() => undefined);
        }
        setError(employeeError(caught));
      }
      throw caught;
    }
  }, [apply, clearSession, refresh]);
  const setActiveSite = useCallback(async (siteId: string) => {
    const currentSession = sessionRef.current;
    if (!currentSession) throw new EmployeeError('Logga in igen för att välja anläggning.', 401);
    if (!currentSession.sites.some(site => site.id === siteId && site.active !== false && currentSession.person.siteIds.includes(site.id))) {
      throw new EmployeeError('Anläggningen är inte tillgänglig för ditt konto.', 403);
    }
    if (navigator.onLine === false) throw new EmployeeError('Anläggningen kan inte bytas utan anslutning. Försök igen när du är online.', 0);
    await mutate('/active-site', { siteId });
  }, [mutate]);
  const commandClock = useCallback(async (command: EmployeeClockAction | EmployeeClockCorrection) => {
    if (clockBusyRef.current) throw new EmployeeError('En stämpling sparas redan. Vänta ett ögonblick.', 409);
    if (!overviewRef.current?.clock || (command.action !== 'clock.correct' && !overviewRef.current.clock.enabled)) throw new EmployeeError('Stämpelklockan är inte aktiverad för ditt konto.', 403);
    if (navigator.onLine === false) throw new EmployeeError('Stämpling kräver anslutning. Försök igen när du är online.', 0);
    const current = generation.current; clockBusyRef.current = true; setClockBusy(true);
    try { await mutate('/clock', command); }
    catch (caught) { if (current === generation.current && caught instanceof EmployeeError && caught.status === 409) void refresh().catch(() => undefined); throw caught; }
    finally { if (current === generation.current) { clockBusyRef.current = false; setClockBusy(false); } }
  }, [mutate, refresh]);
  return <EmployeeContext.Provider value={{ session, overview, admin, adminBusy, loading, refreshing, error, sessionGeneration, login, logout, refresh,
    openCompanySelection, chooseCompany, changeAdminPassword,
    setActiveSite,
    saveTime: entry => mutate('/time/save', entry, entry.date),
    removeTime: (id, revision) => mutate('/time/remove', { id, revision }),
    requestLeave: request => mutate('/leave/request', request),
    cancelLeave: (id, revision) => mutate('/leave/cancel', { id, revision }),
    updateProfile: profile => mutate('/profile', profile),
    changePassword: (currentPassword, password) => mutate('/password', { currentPassword, password }),
    loadRequirements: async () => (await employeeRequest<{ people: EmployeeRequirementPerson[] }>('/requirements')).people,
    saveRequirement: (personId, requirement) => mutate('/requirements', { personId, requirement: { enabled: requirement.enabled, mode: requirement.mode, revision: requirement.revision, timeSource: requirement.timeSource ?? 'workorder', effectiveFrom: requirement.effectiveFrom < stockholmDay() ? stockholmDay() : requirement.effectiveFrom, ...(requirement.mode === 'fixed' ? { dailyMinutes: requirement.dailyMinutes } : {}), ...(requirement.weekdays ? { weekdays: requirement.weekdays } : {}) } }),
    loadAccounts: async () => (await employeeRequest<{ people: EmployeeAccountPerson[] }>('/accounts')).people,
    saveAccount: account => mutate('/accounts/save', account),
    commandOrder: (orderId, command, body = {}) => mutate(`/orders/${encodeURIComponent(orderId)}/${command}`, body),
    clockBusy, commandClock,
    commandSickness: async command => {
      const companyId = sessionRef.current?.companyId;
      const current = generation.current;
      if (!sessionRef.current) throw new EmployeeError('Logga in igen för att sjukanmäla dig.', 401);
      if (navigator.onLine === false) throw new EmployeeError('Sjukanmälan kräver anslutning. Försök igen när du är online.', 0);
      try {
        await employeeRequest('/sickness', command, { expectedCompanyId: companyId, expectedPersonId: sessionRef.current.person.id });
        if (current === generation.current) await refresh();
      } catch (caught) {
        // An uncertain response is re-read, never presented as a saved report.
        // The caller retains requestId so retry cannot create another case.
        if (current === generation.current) void refresh().catch(() => undefined);
        throw caught;
      }
    },
  }}>{children}</EmployeeContext.Provider>;
}

export function useEmployee() {
  const value = useContext(EmployeeContext);
  if (!value) throw new Error('EmployeeProvider saknas.');
  return value;
}
