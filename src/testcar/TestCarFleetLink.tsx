import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpRight, Building2, CheckCircle2, ChevronDown, FlaskConical, Link2, LoaderCircle, RefreshCw, Unplug } from 'lucide-react';
import { platformApi } from '../platform/client';
import { can } from '../office/model';
import type { AuthenticatedPlatformSession, PlatformSession } from '../platform/types';
import './testcar-fleet-link.css';

interface FleetLinkState {
  companyName: string;
  devices: { id: string; name: string; vehicleId: string | null; status: string }[];
  link?: { deviceId: string; status: 'connected' | 'error'; lastSentAt: string | null; error?: string };
}
type Scope = { key: string; headers: Readonly<Record<string, string>> };
class LinkError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
const permitted = (value: PlatformSession): value is AuthenticatedPlatformSession => value.authenticated && !!value.organisationId && !value.mustChangePassword
  && [value.actualUser, value.user].every(user => user && user.active !== false && !Array.isArray(user.siteIds) && can(user, 'fleetRead') && can(user, 'fleetWrite'));
function scopeOf(value: AuthenticatedPlatformSession): Scope {
  return { key: JSON.stringify([value.organisationId, value.generation, value.actor.id, value.actualUser.id, value.user.id]),
    headers: Object.freeze({ 'X-Platform-CSRF': value.csrfToken, 'X-Platform-Generation': String(value.generation), 'X-Platform-Organisation-Id': value.organisationId! }) };
}
function readState(value: unknown): FleetLinkState {
  const state = value as FleetLinkState;
  if (!state || typeof state.companyName !== 'string' || !Array.isArray(state.devices)
    || !state.devices.every(device => device && typeof device.id === 'string' && typeof device.name === 'string' && typeof device.status === 'string' && (device.vehicleId === null || typeof device.vehicleId === 'string'))
    || state.link && (typeof state.link.deviceId !== 'string' || !['connected', 'error'].includes(state.link.status)
      || !(state.link.lastSentAt === null || Number.isFinite(Date.parse(state.link.lastSentAt)))))
    throw new LinkError('Bolagskopplingen gav ett ofullständigt svar. Uppdatera statusen.', 502);
  return state;
}
const time = (value: string) => new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Stockholm' }).format(new Date(value));

/** The public lab never borrows an office principal or writes global session state. */
export default function TestCarFleetLink({ csrfToken, engineOn, disabled = false, onBusyChange, onChanged }: {
  csrfToken: string | null; engineOn: boolean; disabled?: boolean; onBusyChange: (busy: boolean) => void; onChanged?: () => void;
}) {
  const [auth, setAuth] = useState<Scope>(), [stored, setStored] = useState<{ key: string; data: FleetLinkState }>(), [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [busyAction, setBusyAction] = useState<'connect' | 'disconnect'>();
  const mounted = useRef(true), sequence = useRef(0), scopeRef = useRef<Scope | undefined>(undefined), tokenRef = useRef(csrfToken); tokenRef.current = csrfToken;
  const controller = useRef<AbortController | null>(null), mutation = useRef(false), callback = useRef(onBusyChange); callback.current = onBusyChange;
  const value = auth && stored?.key === auth.key ? stored.data : undefined;
  const clear = useCallback(() => { scopeRef.current = undefined; setAuth(undefined); setStored(undefined); setSelected(''); setError(''); setUncertain(false); setOpen(false); }, []);
  const fetchState = useCallback(async (scope: Scope, signal: AbortSignal, body?: { action: 'connect' | 'disconnect'; deviceId?: string }) => {
    const capturedToken = tokenRef.current;
    if (body && !capturedToken) throw new LinkError('Testsessionen behöver hämtas igen.', 401);
    const response = await fetch('/api/testcar/fleet', { credentials: 'same-origin', cache: 'no-store', signal,
      method: body ? 'POST' : 'GET', headers: { Accept: 'application/json', ...scope.headers, ...(capturedToken ? { 'X-Testcar-CSRF': capturedToken } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'X-Testcar-CSRF': capturedToken! } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new LinkError(typeof result?.error === 'string' ? result.error : result?.error?.message || 'Bolagskopplingen kunde inte kontrolleras.', response.status, result?.code);
    return readState(result);
  }, []);
  const checkSession = useCallback(async () => {
    if (mutation.current) return;
    controller.current?.abort(); const request = new AbortController(), version = ++sequence.current; controller.current = request;
    const timer = window.setTimeout(() => request.abort(), 12_000);
    const current = () => mounted.current && sequence.current === version && controller.current === request && !request.signal.aborted;
    // A foreground return may follow a company switch in another tab.
    clear(); setLoading(true);
    try {
      const session = await platformApi.session(request.signal);
      if (!current() || !permitted(session)) return;
      const scope = scopeOf(session); scopeRef.current = scope; setAuth(scope);
      const data = await fetchState(scope, request.signal);
      if (current() && scopeRef.current?.key === scope.key) { setStored({ key: scope.key, data }); setSelected(data.link?.deviceId ?? data.devices[0]?.id ?? ''); }
    } catch (failure) {
      if (!current()) return;
      if (failure instanceof LinkError && ([401, 403].includes(failure.status) || failure.code === 'platform_context_changed' || failure.code === 'platform_company_unavailable')) clear();
      else if (scopeRef.current) setError('Kunde inte hämta bolagskopplingen. Försök igen.');
      // Public or expired office sessions must not turn the lab into an error page.
    } finally { window.clearTimeout(timer); if (mounted.current && sequence.current === version) setLoading(false); if (controller.current === request) controller.current = null; }
  }, [clear, fetchState]);
  const refresh = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope || mutation.current || controller.current) return;
    const request = new AbortController(), version = ++sequence.current; controller.current = request;
    const timer = window.setTimeout(() => request.abort(), 12_000);
    const current = () => mounted.current && sequence.current === version && scopeRef.current?.key === scope.key && controller.current === request;
    setLoading(true);
    try { const data = await fetchState(scope, request.signal); if (current() && !request.signal.aborted) { setStored({ key: scope.key, data }); setError(''); setUncertain(false); } }
    catch (failure) { if (current()) { if (failure instanceof LinkError && ([401, 403].includes(failure.status) || failure.code === 'platform_context_changed' || failure.code === 'platform_company_unavailable')) clear(); else setError('Kunde inte bekräfta bolagskopplingen. Senast hämtade status visas.'); } }
    finally { window.clearTimeout(timer); if (current()) setLoading(false); if (controller.current === request) controller.current = null; }
  }, [clear, fetchState]);
  useEffect(() => { mounted.current = true; void checkSession(); return () => { mounted.current = false; ++sequence.current; controller.current?.abort(); callback.current(false); }; }, [checkSession]);
  useEffect(() => {
    const visible = () => { if (!document.hidden) void checkSession(); };
    document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible); window.addEventListener('scrappilot:check-platform-session', visible);
    return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); window.removeEventListener('scrappilot:check-platform-session', visible); };
  }, [checkSession]);
  useEffect(() => { if (!auth || !open && !value?.link) return; const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 10_000); return () => window.clearInterval(timer); }, [auth, open, !!value?.link, refresh]);
  async function change(action: 'connect' | 'disconnect') {
    const scope = scopeRef.current;
    const deviceId = value?.link?.deviceId ?? selected;
    if (!scope || !value || mutation.current || uncertain || engineOn || disabled || !csrfToken
      || action === 'connect' && (value.link?.status === 'connected' || !value.devices.some(device => device.id === deviceId))) return;
    controller.current?.abort(); ++sequence.current; mutation.current = true;
    const request = new AbortController(), version = sequence.current; controller.current = request;
    const timer = window.setTimeout(() => request.abort(), 20_000);
    const current = () => mounted.current && scopeRef.current?.key === scope.key && version === sequence.current && controller.current === request;
    setBusy(true); setBusyAction(action); callback.current(true); setError('');
    try {
      const data = await fetchState(scope, request.signal, action === 'connect' ? { action, deviceId } : { action });
      if (current() && !request.signal.aborted) { setStored({ key: scope.key, data }); setSelected(data.link?.deviceId ?? selected); setUncertain(action === 'connect' && data.link?.status === 'error'); onChanged?.(); }
    } catch (failure) {
      if (current()) {
        if (failure instanceof LinkError && ([401, 403].includes(failure.status) || failure.code === 'platform_context_changed' || failure.code === 'platform_company_unavailable')) clear();
        else { setUncertain(true); setError(failure instanceof LinkError ? failure.message : 'Åtgärdens resultat kunde inte bekräftas. Uppdatera statusen före nästa försök.'); }
      }
    } finally { window.clearTimeout(timer); mutation.current = false; if (mounted.current) { setBusy(false); setBusyAction(undefined); callback.current(false); } if (controller.current === request) controller.current = null; }
  }
  if (!auth) return null;
  const linked = value?.link, selectedDevice = value?.devices.find(device => device.id === (linked?.deviceId ?? selected));
  return <details className="testcar-card testcar-fleet-link" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><span className="testcar-fleet-link-icon"><Building2 size={21} /></span><span><strong>Använd testbilen i ett bolag</strong><small>{value?.companyName || 'Valt bolag'} · endast simulerad kördata</small></span>{linked && <span className={`testcar-badge ${linked.status === 'connected' ? 'is-green' : 'is-amber'}`}>{linked.status === 'connected' ? 'Kopplad' : 'Kontrollera koppling'}</span>}<ChevronDown size={18} /></summary><div className="testcar-fleet-link-body"><p>Prova bolagets fordon och körjournal med syntetiska resor från testbilen.</p>{error && <div className="testcar-message is-warning" role="alert">{error}</div>}{loading && !value ? <p role="status"><LoaderCircle size={17} className="testcar-spin" />Hämtar tilldelade simulatorer…</p> : !value ? <button type="button" className="testcar-reset-link" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw size={16} />Försök igen</button> : <>{linked ? <div className={`testcar-fleet-link-status${linked.status === 'error' ? ' is-error' : ''}`}>{linked.status === 'error' ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}<div><strong>{selectedDevice?.name || 'Registrerad simulator'}</strong><span>{linked.status === 'connected' ? `Kopplad till ${value.companyName}` : 'Kopplingen behöver kontrolleras'}</span><small>{linked.lastSentAt ? `Senast skickat ${time(linked.lastSentAt)}` : 'Väntar på första mätpunkten'}</small>{linked.error && <p role="alert">{linked.error}</p>}</div></div> : value.devices.length ? <label>Tilldelad simulator<select value={selected} disabled={busy || engineOn || disabled} onChange={event => setSelected(event.target.value)}>{value.devices.map(device => <option key={device.id} value={device.id}>{device.name} · {device.vehicleId ? 'fordon kopplat' : 'välj fordon på kontoret'}</option>)}</select></label> : <p className="testcar-fleet-link-empty">Bolaget saknar en tilldelad simulator. Registrera och tilldela en simulator i plattformsadministrationen först.</p>}{linked?.status === 'error' && <p className="testcar-fleet-link-hint">{value.devices.some(device => device.id === linked.deviceId) ? 'Återanslut efter inloggning för att fortsätta med samma bolag och simulator. Väntande mätpunkter skickas först när du väljer att återansluta.' : 'Simulatorn behöver aktiveras och tilldelas bolaget av en plattformsadministratör innan den kan återanslutas.'}</p>}{engineOn && <p className="testcar-fleet-link-hint">Stäng av testbilen innan du ändrar bolagskopplingen.</p>}<div className="testcar-fleet-link-actions">{linked?.status === 'error' && <button type="button" className="testcar-primary-button" disabled={busy || uncertain || engineOn || disabled || !csrfToken || !value.devices.some(device => device.id === linked.deviceId)} onClick={() => void change('connect')}><RefreshCw size={16} className={busyAction === 'connect' ? 'testcar-spin' : undefined} />{busyAction === 'connect' ? 'Återansluter…' : 'Återanslut företagskopplingen'}</button>}{linked ? <button type="button" disabled={busy || uncertain || engineOn || disabled || !csrfToken} onClick={() => void change('disconnect')}><Unplug size={16} />{busyAction === 'disconnect' ? 'Kopplar från…' : 'Koppla från bolaget'}</button> : value.devices.length > 0 && <button type="button" className="testcar-primary-button" disabled={busy || uncertain || engineOn || disabled || !selected || !csrfToken} onClick={() => void change('connect')}><Link2 size={16} />{busy ? 'Kopplar…' : 'Koppla testbilen'}</button>}<button type="button" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw size={16} className={loading ? 'testcar-spin' : undefined} />Uppdatera status</button><a href="/kontor#/fleet?tab=devices" target="_blank" rel="noopener noreferrer">Koppla simulator till fordon<ArrowUpRight size={15} /></a></div><div className="testcar-fleet-link-note"><FlaskConical size={17} /><p>Välj fordon och ordinarie förare på kontoret. Föraren kompletterar sedan sina avslutade resor i personalappen. Kopplingen använder bara den registrerade simulatorn.</p></div></>}</div></details>;
}
