import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { EmployeeAccountPerson, EmployeeClockAction, EmployeeClockCorrection, EmployeeLeaveDraft, EmployeeOverview, EmployeeRequirement, EmployeeRequirementPerson, EmployeeSession, EmployeeTimeDraft, EmployeeTimeGate } from './types';
import { employeeCompanyId } from './cache';

let requestCompanyId: string | undefined;

export class EmployeeError extends Error {
  constructor(message: string, public status: number, public code?: string, public gate?: EmployeeTimeGate) { super(message); }
}
export async function employeeRequest<T>(path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  // Capture the initiating company. A cookie changed in another tab must not
  // silently redirect an existing form or pending command to another company.
  const expectedCompany = requestCompanyId;
  const response = await fetch(`/api/employee${path}`, {
    credentials: 'same-origin', cache: 'no-store', signal: options?.signal,
    headers: { ...(expectedCompany ? { 'X-Employee-Company': expectedCompany } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new EmployeeError(result?.error || result?.message || 'Kunde inte kontakta servern. Försök igen.', response.status, result?.code, result?.gate);
  return result as T;
}
export const employeeError = (error: unknown) => error instanceof TypeError ? 'Kunde inte nå servern. Kontrollera anslutningen och försök igen.' : error instanceof Error ? error.message : 'Något gick fel. Försök igen.';
export const stockholmDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

interface EmployeeContextValue {
  session: EmployeeSession | null; overview: EmployeeOverview | null;
  loading: boolean; refreshing: boolean; error: string;
  login: (username: string, password: string) => Promise<EmployeeSession>;
  logout: () => Promise<void>;
  refresh: (focus?: { month?: string; date?: string }) => Promise<void>;
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
}
const EmployeeContext = createContext<EmployeeContextValue | null>(null);

export function EmployeeProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<EmployeeOverview | null>(null);
  const [session, setSession] = useState<EmployeeSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [clockBusy, setClockBusy] = useState(false);
  const clockBusyRef = useRef(false), overviewRef = useRef<EmployeeOverview | null>(null);
  const generation = useRef(0);
  const sequence = useRef(0);
  const focus = useRef({ month: stockholmDay().slice(0, 7), date: stockholmDay() });
  const sessionRef = useRef<EmployeeSession | null>(null);
  const apply = useCallback((result: EmployeeOverview) => {
    const previous = overviewRef.current;
    if (previous && previous.companyId === result.companyId && previous.person.id === result.person.id && result.revision < previous.revision) return;
    requestCompanyId = employeeCompanyId(result.companyId);
    overviewRef.current = result;
    setOverview(result); setSession(result); sessionRef.current = result; setError(''); setRefreshing(false);
  }, []);
  const clearSession = useCallback(() => {
    requestCompanyId = undefined;
    generation.current += 1; sequence.current += 1;
    setSession(null); sessionRef.current = null; overviewRef.current = null; setOverview(null); setRefreshing(false); clockBusyRef.current = false; setClockBusy(false);
  }, []);
  const refresh = useCallback(async (next?: { month?: string; date?: string }) => {
    if (next) focus.current = { ...focus.current, ...next };
    if (!sessionRef.current) return;
    const current = generation.current, currentSequence = ++sequence.current;
    setRefreshing(true);
    try {
      const query = new URLSearchParams(focus.current);
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
    const current = ++generation.current;
    setLoading(true);
    void employeeRequest<EmployeeOverview>('/session').then(result => {
      if (generation.current === current) { focus.current = { month: result.month, date: result.date }; apply(result); }
    }).catch(caught => {
      if (generation.current === current && !(caught instanceof EmployeeError && caught.status === 401)) setError(employeeError(caught));
    }).finally(() => { if (generation.current === current) setLoading(false); });
    return () => { generation.current += 1; sequence.current += 1; };
  }, [apply]);

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
    const current = ++generation.current;
    sequence.current += 1; setError('');
    const result = await employeeRequest<EmployeeOverview>('/login', { username: username.trim(), password });
    if (current !== generation.current) throw new EmployeeError('Inloggningen avbröts.', 409);
    focus.current = { month: result.month, date: result.date }; apply(result);
    return result;
  }, [apply]);
  const logout = useCallback(async () => {
    // Invalidate pending responses immediately. A failed logout keeps the known session.
    const current = ++generation.current; sequence.current += 1;
    try { await employeeRequest('/logout', {}); }
    catch (caught) { if (!(caught instanceof EmployeeError && caught.status === 401)) throw caught; }
    if (current === generation.current) { clearSession(); setError(''); }
  }, [clearSession]);
  const mutate = useCallback(async (path: string, body: unknown, targetDate?: string) => {
    const current = generation.current;
    sequence.current += 1;
    if (targetDate) focus.current = { month: targetDate.slice(0, 7), date: targetDate };
    try {
      const query = new URLSearchParams(focus.current);
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
  return <EmployeeContext.Provider value={{ session, overview, loading, refreshing, error, login, logout, refresh,
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
  }}>{children}</EmployeeContext.Provider>;
}

export function useEmployee() {
  const value = useContext(EmployeeContext);
  if (!value) throw new Error('EmployeeProvider saknas.');
  return value;
}
