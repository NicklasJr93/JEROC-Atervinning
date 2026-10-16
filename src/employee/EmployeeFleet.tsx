import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Camera, CarFront, Check, CheckCircle2, ClipboardCheck, Gauge, History, LoaderCircle, MapPin, RefreshCw, Route, ShieldCheck, UserRound, Wrench, X } from 'lucide-react';
import { Button, Nav, Notice } from '../components';
import { EmployeeError, employeeError, employeeRequest, useEmployee } from './EmployeeProvider';
import { employeeCompanyId } from './cache';
import { parseEmployeeFleet, type EmployeeFleetCommand, type EmployeeFleetSnapshot, type EmployeeFleetTrip } from './employee-fleet-types';
import './employee.css';
import './employee-fleet.css';

const at = (value?: string) => value ? new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' }).format(new Date(value)) : 'Inte registrerat';
const km = (value?: number) => value === undefined ? 'Ej registrerat' : `${new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 }).format(value)} km`;
const driverSources = { default: 'Ordinarie förare', app: 'Vald i appen', panel: 'Vald i förarpanel', office: 'Vald av kontoret', unknown: 'Förare ej fastställd' };
const issueStatus = { open: 'Öppet', in_progress: 'Åtgärdas', resolved: 'Löst' };
const severityLabels = { low: 'Låg', medium: 'Normal', high: 'Hög', critical: 'Kritisk' };
type Retry = { scope: string; fingerprint: string; requestId: string; expectedRevision: number };
interface FleetContext {
  data?: EmployeeFleetSnapshot; loading: boolean; busy: boolean; error?: string; notice?: string;
  scope: string; readable: boolean; load: () => Promise<void>; command: (command: EmployeeFleetCommand) => Promise<boolean>;
  uploadPhoto: (file: File, vehicleId: string) => Promise<string | undefined>;
}
const Context = createContext<FleetContext | null>(null);
export function useEmployeeFleet() { const value = useContext(Context); if (!value) throw new Error('EmployeeFleetProvider saknas.'); return value; }

/** One own-person snapshot shared by pages and the blocking completion dialog. */
export function EmployeeFleetProvider({ children }: { children: ReactNode }) {
  const { session, sessionGeneration } = useEmployee();
  const companyId = employeeCompanyId(session?.companyId), personId = session?.person.id;
  const boundSession = useRef({ session, generation: sessionGeneration });
  if (boundSession.current.session !== session) boundSession.current = { session, generation: sessionGeneration };
  const readable = Boolean(session && boundSession.current.generation === sessionGeneration);
  const scope = JSON.stringify([companyId, personId, sessionGeneration, readable]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const mounted = useRef(true), sequence = useRef(0), readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null), retry = useRef<Retry | null>(null);
  const [stored, setStored] = useState<{ scope: string; value: EmployeeFleetSnapshot }>();
  const [activity, setActivity] = useState<{ scope: string; loading?: boolean; busy?: boolean; error?: string; notice?: string }>();
  const data = readable && stored?.scope === scope ? stored.value : undefined;
  const currentActivity = activity?.scope === scope ? activity : undefined;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++sequence.current; readController.current?.abort(); writeController.current?.abort(); }; }, []);
  useEffect(() => { ++sequence.current; readController.current?.abort(); writeController.current?.abort(); readController.current = null; writeController.current = null; retry.current = null; setStored(undefined); setActivity(undefined); }, [scope]);
  const denied = useCallback((failure: unknown) => {
    if (failure instanceof EmployeeError && ([401, 403].includes(failure.status) || ['company_selection_changed', 'person_selection_changed'].includes(failure.code ?? ''))) {
      setStored(undefined); retry.current = null; window.dispatchEvent(new Event('jeroc:employee-session-check'));
    }
  }, []);
  const load = useCallback(async () => {
    if (!readable || !personId || readController.current || writeController.current) return;
    const controller = new AbortController(), version = ++sequence.current; readController.current = controller;
    const current = () => mounted.current && scopeRef.current === scope && version === sequence.current && readController.current === controller;
    setActivity(previous => ({ ...previous, scope, loading: true }));
    try {
      const value = parseEmployeeFleet(await employeeRequest<unknown>('/fleet', undefined, { signal: controller.signal, expectedCompanyId: companyId, expectedPersonId: personId }), personId);
      if (current() && !controller.signal.aborted) { setStored(previous => previous?.scope === scope && previous.value.revision > value.revision ? previous : { scope, value }); setActivity({ scope, loading: true }); }
    } catch (failure) { if (current()) { denied(failure); setActivity({ scope, error: employeeError(failure) }); } }
    finally { if (current()) setActivity(previous => ({ ...previous, scope, loading: false })); if (readController.current === controller) readController.current = null; }
  }, [companyId, personId, readable, scope, denied]);
  useEffect(() => { void load(); return () => readController.current?.abort(); }, [load]);
  useEffect(() => {
    const visible = () => { if (!document.hidden) void load(); };
    const timer = window.setInterval(visible, 20_000);
    document.addEventListener('visibilitychange', visible); window.addEventListener('online', visible); window.addEventListener('jeroc:employee-fleet-changed', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', visible); window.removeEventListener('jeroc:employee-fleet-changed', visible); };
  }, [load]);
  const command = useCallback(async (input: EmployeeFleetCommand) => {
    if (!data || !readable || !personId || writeController.current || !data.capabilities.write) return false;
    const fingerprint = JSON.stringify(input);
    if (retry.current?.scope !== scope || retry.current.fingerprint !== fingerprint) retry.current = { scope, fingerprint, requestId: crypto.randomUUID(), expectedRevision: data.revision };
    const body = { ...input, expectedRevision: retry.current.expectedRevision, requestId: retry.current.requestId };
    readController.current?.abort(); readController.current = null; ++sequence.current;
    const controller = new AbortController(); writeController.current = controller;
    const timer = window.setTimeout(() => controller.abort(new DOMException('Servern svarade inte i tid. Dina uppgifter finns kvar. Försök igen.', 'TimeoutError')), 30_000);
    const current = () => mounted.current && scopeRef.current === scope && writeController.current === controller;
    setActivity({ scope, busy: true });
    try {
      const value = parseEmployeeFleet(await employeeRequest<unknown>('/fleet/actions', body, { signal: controller.signal, expectedCompanyId: companyId, expectedPersonId: personId }), personId);
      if (!current() || controller.signal.aborted) return false;
      if (input.action === 'trip.complete') {
        const confirmed = value.trips.find(item => item.id === input.tripId);
        if (!confirmed?.endAt || confirmed.classification !== input.classification || confirmed.revision <= input.expectedTripRevision
          || value.gate.pendingTrips.some(item => item.id === input.tripId))
          throw new Error('Resan är ännu inte bekräftad av servern. Dina uppgifter finns kvar. Försök igen.');
      }
      setStored({ scope, value }); retry.current = null; setActivity({ scope, notice: input.action === 'trip.complete' ? 'Resan är kompletterad.' : input.action === 'inspection.save' ? 'Fordonskontrollen är sparad.' : input.action === 'issue.save' ? 'Felanmälan är skickad.' : 'Du är vald som förare för nästa resa.' });
      return true;
    } catch (failure) {
      if (current()) { denied(failure); if (failure instanceof EmployeeError && failure.status === 409) retry.current = null; setActivity({ scope, error: controller.signal.aborted ? 'Servern svarade inte i tid. Dina uppgifter finns kvar. Försök igen.' : employeeError(failure) }); }
      return false;
    } finally { window.clearTimeout(timer); if (current()) setActivity(previous => ({ ...previous, scope, busy: false })); if (writeController.current === controller) writeController.current = null; }
  }, [data, readable, personId, scope, companyId, denied]);
  const uploadPhoto = useCallback(async (file: File, vehicleId: string) => {
    if (!readable || !personId || !data?.capabilities.write || writeController.current) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size === 0 || file.size > 8 * 1024 * 1024) {
      setActivity({ scope, error: 'Välj en JPG, PNG eller WEBP på högst 8 MB.' }); return;
    }
    readController.current?.abort(); readController.current = null; ++sequence.current;
    const controller = new AbortController(); writeController.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    const current = () => mounted.current && scopeRef.current === scope && writeController.current === controller;
    setActivity({ scope, busy: true });
    try {
      const response = await fetch(`/api/employee/fleet/files?${new URLSearchParams({ vehicleId, kind: 'photo' })}`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, body: file,
        headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name), 'X-Employee-Company': companyId, 'X-Employee-Person': personId },
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new EmployeeError(result?.error || 'Bilden kunde inte laddas upp.', response.status, result?.code);
      if (!result?.file || result.file.vehicleId !== vehicleId || typeof result.file.url !== 'string' || !/^\/api\/(employee\/)?fleet\/files\/[^/?#]+$/.test(result.file.url)) throw new Error('Servern kunde inte verifiera den uppladdade bilden.');
      if (current() && !controller.signal.aborted) { setActivity({ scope }); return result.file.url as string; }
    } catch (failure) { if (current()) { denied(failure); setActivity({ scope, error: controller.signal.aborted ? 'Bilduppladdningen svarade inte i tid. Försök igen.' : employeeError(failure) }); } }
    finally { window.clearTimeout(timer); if (current()) setActivity(previous => ({ ...previous, scope, busy: false })); if (writeController.current === controller) writeController.current = null; }
  }, [data, readable, personId, companyId, scope, denied]);
  const value = useMemo(() => ({ data, loading: !!currentActivity?.loading, busy: !!currentActivity?.busy, error: currentActivity?.error, notice: currentActivity?.notice, scope, readable, load, command, uploadPhoto }), [data, currentActivity, scope, readable, load, command, uploadPhoto]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function TripFacts({ trip }: { trip: EmployeeFleetTrip }) {
  return <><div className="employee-fleet-route"><MapPin size={18} /><div><strong>{trip.fromLabel || 'Startplats ej registrerad'}</strong><span>till</span><strong>{trip.toLabel || 'Slutplats ej registrerad'}</strong></div></div><dl className="employee-fleet-facts"><div><dt>Start</dt><dd>{at(trip.startAt)}</dd></div><div><dt>Slut</dt><dd>{trip.endAt ? at(trip.endAt) : 'Pågående resa'}</dd></div><div><dt>Körsträcka</dt><dd>{km(trip.distanceKm)}</dd></div><div><dt>Mätarställning</dt><dd>{km(trip.startOdometerKm)} → {km(trip.endOdometerKm)}</dd></div><div><dt>Förare</dt><dd>{driverSources[trip.driverSource]}</dd></div></dl>{trip.quality && trip.quality !== 'good' && <Notice tone="amber">{trip.quality === 'sensor_gap' ? 'Mätdata saknas för en del av resan. Kontrollera uppgifterna.' : 'Resans mätuppgifter behöver granskas.'}</Notice>}</>;
}

function TripCompletion({ trip }: { trip: EmployeeFleetTrip }) {
  const { data, busy, error, command, load, loading } = useEmployeeFleet();
  const [classification, setClassification] = useState<'private' | 'business' | ''>(''), [purpose, setPurpose] = useState(''), [orderId, setOrderId] = useState(''), [validation, setValidation] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!classification) { setValidation('Välj tjänsteresa eller privat resa.'); return; }
    if (classification === 'business' && !orderId && (purpose.trim().length < 5 || /^(tjänst|arbete|jobb|business|work)$/i.test(purpose.trim()))) { setValidation('Ange ett konkret ärende eller välj en arbetsorder.'); return; }
    setValidation('');
    await command({ action: 'trip.complete', tripId: trip.id, expectedTripRevision: trip.revision, classification,
      ...(classification === 'business' ? { ...(purpose.trim() ? { purpose: purpose.trim() } : {}), ...(orderId ? { workOrderId: orderId } : {}) } : {}) });
  }
  return <form className="employee-form employee-fleet-complete" onSubmit={event => void submit(event)}><TripFacts trip={trip} /><fieldset disabled={busy}><legend>Hur användes bilen?</legend><div className="employee-fleet-choice"><button type="button" aria-pressed={classification === 'business'} onClick={() => { setClassification('business'); setValidation(''); }}><Wrench size={19} />Tjänsteresa{classification === 'business' && <Check size={16} />}</button><button type="button" aria-pressed={classification === 'private'} onClick={() => { setClassification('private'); setPurpose(''); setOrderId(''); setValidation(''); }}><UserRound size={19} />Privat resa{classification === 'private' && <Check size={16} />}</button></div></fieldset>{classification === 'business' && <><label>Arbetsorder · valfri<select value={orderId} disabled={busy} onChange={event => setOrderId(event.target.value)}><option value="">Ingen arbetsorder vald</option>{data?.workOrders.map(order => <option key={order.id} value={order.id}>{order.id} · {order.customerName}</option>)}</select></label><label>Resans ärende{orderId ? ' · valfritt' : ''}<textarea value={purpose} disabled={busy} maxLength={1000} placeholder="Till exempel hämta material hos kund" onChange={event => setPurpose(event.target.value)} /></label></>}{classification === 'private' && <p className="employee-subtle">Resan registreras som privat utan ärende eller arbetsorder.</p>}{(validation || error) && <Notice tone="red">{validation || error}</Notice>}{error && <button type="button" className="employee-text" disabled={busy || loading} onClick={() => void load()}>Hämta aktuell status</button>}<Button type="submit" variant="blue" icon={CheckCircle2} disabled={busy || !data?.capabilities.write}>{busy ? 'Sparar resan…' : error ? 'Försök spara igen' : 'Spara och fortsätt'}</Button></form>;
}

/** Parent may suspend this only for authentication and an already active time gate. */
export function EmployeeTripGate({ suspended = false }: { suspended?: boolean }) {
  const { data, scope, readable, error, loading, load } = useEmployeeFleet();
  const dialog = useRef<HTMLDialogElement>(null), [selected, setSelected] = useState<{ scope: string; id: string }>();
  const pending = [...(data?.gate.pendingTrips ?? [])].sort((a, b) => (b.endAt ?? '').localeCompare(a.endAt ?? ''));
  const ownActiveTrip = data?.trips.some(trip => !trip.endAt && trip.personId === data.personId);
  const safeToInteract = data?.gate.safeToInteract ?? !ownActiveTrip;
  const active = pending.find(trip => selected?.scope === scope && trip.id === selected.id) ?? pending[0];
  const blocked = readable && !suspended && (!data || (data.gate.blocked && safeToInteract));
  const render = readable && !suspended && (!data || data.gate.blocked);
  // Only pin a card once it has actually been shown. While driving the closed
  // dialog keeps existing input, but an unseen older trip must not jump ahead.
  useEffect(() => { if (blocked && active && (selected?.scope !== scope || selected.id !== active.id)) setSelected({ scope, id: active.id }); }, [scope, blocked, active?.id, selected]);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!blocked) { node.close(); return; }
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    node.showModal();
    return () => { node.close(); document.body.style.overflow = previous; };
  }, [blocked, render]);
  if (!render) return null;
  return createPortal(<dialog className="employee-fleet-gate" ref={dialog} aria-labelledby="employee-trip-gate-title" aria-describedby="employee-trip-gate-description" onCancel={event => event.preventDefault()}><span className="employee-fleet-icon"><Route size={29} /></span><h2 id="employee-trip-gate-title">Komplettera din resa</h2><p id="employee-trip-gate-description">{data ? `${pending.length} ${pending.length === 1 ? 'avslutad resa behöver' : 'avslutade resor behöver'} kompletteras innan du fortsätter.` : 'Kontrollerar om du har avslutade resor att komplettera.'}</p>{active ? <TripCompletion key={`${scope}/${active.id}`} trip={active} /> : <div className="employee-fleet-empty">{loading && <LoaderCircle className="employee-fleet-spin" size={27} />}{error && <Notice tone="red">{error}</Notice>}{!loading && <Button variant="blue" icon={RefreshCw} onClick={() => void load()}>Försök hämta resor igen</Button>}</div>}</dialog>, document.body);
}

const inspectionChecks = [ ['tyres', 'Däck och hjul'], ['lights', 'Belysning och signaler'], ['fluids', 'Vätskor och synligt läckage'], ['safety', 'Säkerhetsutrustning'], ['damage', 'Skador och allmänt skick'] ] as const;
function VehicleForm({ vehicleId, kind, onClose }: { vehicleId: string; kind: 'inspection' | 'issue'; onClose: () => void }) {
  const { command, busy, error, uploadPhoto, scope } = useEmployeeFleet();
  const [photos, setPhotos] = useState<string[]>([]);
  const photoScope = useRef(scope); photoScope.current = scope;
  const photoMounted = useRef(true); useEffect(() => { photoMounted.current = true; return () => { photoMounted.current = false; }; }, []);
  const photoInput = useRef<HTMLInputElement>(null);
  async function addPhoto(file?: File) { if (!file || photos.length >= 4) return; const ownScope = scope; const url = await uploadPhoto(file, vehicleId); if (url && photoMounted.current && photoScope.current === ownScope) setPhotos(previous => [...previous, url]); }
  const [checks, setChecks] = useState<Record<string, boolean | undefined>>({}), [comment, setComment] = useState(''), [title, setTitle] = useState(''), [severity, setSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [validation, setValidation] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (kind === 'inspection' && inspectionChecks.some(([key]) => checks[key] === undefined)) { setValidation('Bedöm varje kontrollpunkt innan du sparar.'); return; }
    const saved = await command(kind === 'inspection' ? { action: 'inspection.save', vehicleId, checks: inspectionChecks.map(([key, label]) => ({ key, label, ok: checks[key]! })), comment: comment.trim(), photoUrls: photos }
      : { action: 'issue.save', issue: { vehicleId, title: title.trim(), description: comment.trim(), severity, status: 'open', photoUrls: photos } });
    if (saved) onClose();
  }
  return <section className="employee-card"><h2>{kind === 'inspection' ? 'Daglig fordonskontroll' : 'Felanmälan'}</h2><form className="employee-form" onSubmit={event => void submit(event)}>{kind === 'inspection' ? <div className="employee-fleet-checks">{inspectionChecks.map(([key, label]) => <fieldset key={key} disabled={busy}><legend>{label}</legend><div className="employee-fleet-choice"><button type="button" aria-label={`${label} · OK`} aria-pressed={checks[key] === true} onClick={() => setChecks(value => ({ ...value, [key]: true }))}>OK</button><button type="button" aria-label={`${label} · Brist`} aria-pressed={checks[key] === false} onClick={() => setChecks(value => ({ ...value, [key]: false }))}>Brist</button></div></fieldset>)}</div> : <><label>Rubrik<input required minLength={3} maxLength={200} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label><label>Allvarlighetsgrad<select value={severity} disabled={busy} onChange={event => setSeverity(event.target.value as typeof severity)}>{Object.entries(severityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>{severity === 'critical' && <Notice tone="amber">Kontakta ansvarig innan fordonet används vidare.</Notice>}</>}<label>{kind === 'inspection' ? 'Kommentar · valfri' : 'Beskriv felet'}<textarea required={kind === 'issue'} value={comment} disabled={busy} maxLength={3000} onChange={event => setComment(event.target.value)} /></label><div className="employee-fleet-photos"><input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" aria-label="Bifoga foto" disabled={busy || photos.length >= 4} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void addPhoto(file); }} hidden /><button type="button" className="employee-text" disabled={busy || photos.length >= 4} onClick={() => photoInput.current?.click()}><Camera size={18} />Bifoga foto ({photos.length}/4)</button>{photos.length > 0 && <div className="employee-fleet-photo-grid">{photos.map((url, index) => <div key={url}><img src={url} alt={`Bifogat foto ${index + 1}`} /><button type="button" aria-label={`Ta bort foto ${index + 1}`} disabled={busy} onClick={() => setPhotos(items => items.filter(item => item !== url))}><X size={15} /></button></div>)}</div>}</div>{(validation || error) && <Notice tone="red">{validation || error}</Notice>}<Button variant="blue" type="submit" disabled={busy} icon={kind === 'inspection' ? ClipboardCheck : AlertTriangle}>{busy ? 'Sparar…' : kind === 'inspection' ? 'Spara fordonskontroll' : 'Skicka felanmälan'}</Button><button type="button" className="employee-text centered" disabled={busy} onClick={onClose}>Avbryt</button></form></section>;
}

export function EmployeeFleetPage({ view = 'vehicle' }: { view?: 'vehicle' | 'trips' }) {
  const { session } = useEmployee(), { data, loading, busy, error, notice, scope, load, command } = useEmployeeFleet();
  const navigate = useNavigate(), [selected, setSelected] = useState(''), [form, setForm] = useState<'inspection' | 'issue'>(), [tripFilter, setTripFilter] = useState('all');
  useEffect(() => { setSelected(''); setForm(undefined); setTripFilter('all'); }, [scope]);
  const defaultVehicle = data?.vehicles.find(vehicle => data.profiles[vehicle.id]?.nextDriver?.personId === data.personId) ?? data?.vehicles.find(vehicle => data.profiles[vehicle.id]?.defaultDriverId === data.personId) ?? data?.vehicles[0];
  const vehicle = data?.vehicles.find(item => item.id === selected) ?? defaultVehicle, profile = vehicle && data?.profiles[vehicle.id];
  const device = data?.telematics?.devices.find(item => item.vehicleId === vehicle?.id);
  const ownTrips = [...(data?.trips ?? [])].filter(trip => trip.personId === data?.personId).sort((a, b) => b.startAt.localeCompare(a.startAt));
  const trips = ownTrips.filter(trip => tripFilter === 'all' || trip.classification === tripFilter || tripFilter === 'pending' && !!trip.endAt && data?.pendingTrips.some(item => item.id === trip.id));
  const vehicleTrips = ownTrips.filter(trip => trip.vehicleId === vehicle?.id), services = data?.services.filter(item => item.vehicleId === vehicle?.id) ?? [], issues = data?.issues.filter(item => item.vehicleId === vehicle?.id) ?? [], inspections = data?.inspections.filter(item => item.vehicleId === vehicle?.id) ?? [];
  return <><main className="employee-page employee-fleet-page"><header className="employee-page-heading"><button className="icon-button" aria-label="Tillbaka till Hem" onClick={() => navigate('/')}><ArrowLeft size={22} /></button><div className="employee-heading-copy"><h1>{view === 'trips' ? 'Mina resor' : 'Mitt fordon'}</h1><p>{view === 'trips' ? 'Din körjournal och registrerade resor.' : 'Fordonsstatus, kontroll och service.'}</p></div><button className="icon-button" aria-label="Uppdatera fordonsuppgifter" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={20} className={loading ? 'employee-fleet-spin' : undefined} /></button></header><div className="employee-segments"><button className={view === 'vehicle' ? 'active' : undefined} aria-current={view === 'vehicle' ? 'page' : undefined} onClick={() => navigate('/my-vehicle')}>Mitt fordon</button><button className={view === 'trips' ? 'active' : undefined} aria-current={view === 'trips' ? 'page' : undefined} onClick={() => navigate('/my-trips')}>Mina resor</button></div>{error && <Notice tone="red">{error}<button className="employee-text" disabled={loading || busy} onClick={() => void load()}>Försök igen</button></Notice>}{notice && <Notice tone="green">{notice}</Notice>}{!data ? <div className="employee-fleet-empty"><LoaderCircle size={28} className={loading ? 'employee-fleet-spin' : undefined} /><p>{loading ? 'Hämtar dina fordonsuppgifter…' : 'Fordonsuppgifterna är inte tillgängliga.'}</p></div> : view === 'trips' ? <><label className="employee-fleet-filter">Visa resor<select value={tripFilter} onChange={event => setTripFilter(event.target.value)}><option value="all">Alla mina resor</option><option value="business">Tjänsteresor</option><option value="private">Privata resor</option><option value="pending">Behöver kompletteras</option></select></label>{trips.length ? trips.map(trip => <details className="employee-card employee-fleet-trip" key={trip.id}><summary><span className="employee-fleet-icon"><Route size={20} /></span><span><strong>{trip.fromLabel || 'Startplats'} → {trip.toLabel || 'Slutplats'}</strong><small>{at(trip.startAt)} · {km(trip.distanceKm)}</small></span><span className={`employee-fleet-pill ${trip.classification ?? 'pending'}`}>{!trip.endAt ? 'Pågår' : trip.classification === 'private' ? 'Privat' : trip.classification === 'business' ? 'Tjänst' : 'Komplettera'}</span></summary><TripFacts trip={trip} /><p className="employee-subtle">{data.vehicles.find(item => item.id === trip.vehicleId)?.registration || 'Fordon ej tillgängligt'} · {trip.source === 'simulator' ? 'Simulerad kördata' : 'Fordonsenhet'}</p>{trip.purpose && <p>{trip.purpose}</p>}{trip.workOrderId && <p className="employee-subtle">Arbetsorder {trip.workOrderId}</p>}</details>) : <div className="employee-fleet-empty"><Route size={31} /><p>Inga resor att visa för det här urvalet.</p></div>}</> : !vehicle ? <div className="employee-fleet-empty"><CarFront size={32} /><p>Du har inget tilldelat fordon ännu.</p></div> : <>{data.vehicles.length > 1 && <label className="employee-fleet-filter">Fordon<select value={vehicle.id} onChange={event => { setSelected(event.target.value); setForm(undefined); }}>{data.vehicles.map(item => <option key={item.id} value={item.id}>{item.registration} · {item.name}</option>)}</select></label>}<section className="employee-card employee-fleet-vehicle" aria-label="Ditt fordon"><div className="employee-fleet-vehicle-heading"><span className="employee-fleet-icon"><CarFront size={29} /></span><div><span className="employee-fleet-registration">{vehicle.registration}</span><h2>{vehicle.name}</h2></div><span className={`employee-fleet-pill ${profile?.blocked ? 'blocked' : ''}`}>{profile?.blocked ? 'Spärrat' : vehicle.active === false ? 'Inaktivt' : 'Aktivt'}</span></div>{profile?.blocked && <Notice tone="red">{profile.blockReason || 'Fordonet är spärrat. Kontakta ansvarig.'}</Notice>}<dl className="employee-fleet-facts"><div><dt><UserRound size={14} />Ordinarie förare</dt><dd>{profile?.defaultDriverId === session?.person.id ? 'Du' : profile?.defaultDriverId ? 'Annan förare' : 'Ej tilldelad'}</dd></div><div><dt>Förare nästa resa</dt><dd>{profile?.nextDriver?.personId === session?.person.id ? `Du · ${profile?.nextDriver?.source === 'app' ? 'vald i appen' : profile?.nextDriver?.source === 'office' ? 'vald av kontoret' : 'vald i förarpanel'}` : profile?.nextDriver ? 'Annan förare' : 'Ordinarie förare används'}</dd></div><div><dt><Gauge size={14} />Mätarställning</dt><dd>{km(profile?.odometerKm)}</dd></div><div><dt>Mätarkälla</dt><dd>{({ manual: 'Manuell', oem: 'Fordonstillverkare', virtual: 'Virtuell mätare', unknown: 'Ej fastställd' })[profile?.odometerSource ?? 'unknown']}</dd></div><div><dt>Senaste kontakt</dt><dd>{at(device?.lastContactAt ?? profile?.lastContactAt)}</dd></div>{device && <><div><dt>Kördata</dt><dd>{device.source === 'simulator' ? 'Simulerad fordonsenhet' : 'Fordonsenhet'}</dd></div><div><dt>Kontaktstatus</dt><dd>{device.contactStatus === 'recent' ? 'Nyligen kontakt' : device.contactStatus === 'stale' ? 'Senaste kontakt är gammal' : 'Ingen kontakt registrerad'}</dd></div><div><dt>Resestatus</dt><dd>{device.tripState === 'active' ? 'Resa pågår' : device.tripState === 'idle' ? 'Ingen pågående resa' : 'Okänd'}</dd></div></>}</dl>{profile?.notes && <p className="employee-subtle">{profile.notes}</p>}{data.capabilities.write && <Button variant="outline" icon={UserRound} disabled={busy || !data.gate.safeToInteract || profile?.blocked || vehicle.active === false || profile?.nextDriver?.personId === data.personId} onClick={() => void command({ action: 'driver.select', vehicleId: vehicle.id, personId: data.personId })}>Jag kör nästa resa</Button>}<p className="employee-subtle">Förarvalet gäller nästa resa. Tidigare resor behåller sin registrerade förare.</p></section>{data.capabilities.write && <div className="employee-fleet-actions"><button onClick={() => setForm('inspection')}><ClipboardCheck size={24} /><strong>Fordonskontroll</strong><span>Kontrollera före färd</span></button><button onClick={() => setForm('issue')}><AlertTriangle size={24} /><strong>Anmäl fel</strong><span>Skada eller brist</span></button></div>}{form && <VehicleForm key={`${scope}/${vehicle.id}/${form}`} vehicleId={vehicle.id} kind={form} onClose={() => setForm(undefined)} />}<section className="employee-card"><h2><Wrench size={19} />Service</h2>{services.filter(item => item.status === 'planned').length ? services.filter(item => item.status === 'planned').map(item => <div className="employee-fleet-list-row" key={item.id}><strong>{item.title}</strong><span>{[item.dueDate, item.dueKm !== undefined ? km(item.dueKm) : undefined, item.dueHours !== undefined ? `${item.dueHours} drifttimmar` : undefined].filter(Boolean).join(' · ') || 'Tid ej planerad'}</span>{item.workshop && <small>{item.workshop}</small>}</div>) : <p className="employee-subtle">Ingen kommande service registrerad.</p>}</section><section className="employee-card"><h2><AlertTriangle size={19} />Fel och brister</h2>{issues.filter(item => item.status !== 'resolved').length ? issues.filter(item => item.status !== 'resolved').map(item => <div className="employee-fleet-list-row" key={item.id}><strong>{item.title}<span className={`employee-fleet-pill ${item.severity}`}>{severityLabels[item.severity]}</span></strong><span>{issueStatus[item.status]}</span>{item.description && <p>{item.description}</p>}</div>) : <p className="employee-subtle">Inga öppna fel registrerade.</p>}</section><details className="employee-card"><summary><History size={19} />Kontroll- och servicehistorik</summary>{inspections.length === 0 && !services.some(item => item.status === 'completed') && <p className="employee-subtle">Ingen historik registrerad.</p>}{[...inspections].sort((a, b) => b.at.localeCompare(a.at)).map(item => <div className="employee-fleet-list-row" key={item.id}><strong><ShieldCheck size={15} />Fordonskontroll · {at(item.at)}</strong><span>{item.checks.filter(check => !check.ok).length ? `${item.checks.filter(check => !check.ok).length} brister noterade` : 'Alla kontrollpunkter OK'}</span>{item.comment && <p>{item.comment}</p>}</div>)}{services.filter(item => item.status === 'completed').map(item => <div className="employee-fleet-list-row" key={item.id}><strong>{item.title}</strong><span>Slutförd {at(item.endAt)}</span></div>)}</details><section className="employee-card"><h2><Route size={19} />Dina senaste resor</h2>{vehicleTrips.slice(0, 3).map(trip => <div className="employee-fleet-list-row" key={trip.id}><strong>{trip.fromLabel || 'Startplats'} → {trip.toLabel || 'Slutplats'}</strong><span>{at(trip.startAt)} · {km(trip.distanceKm)}</span></div>)}{vehicleTrips.length === 0 && <p className="employee-subtle">Inga egna resor registrerade med fordonet.</p>}<button className="employee-text" onClick={() => navigate('/my-trips')}>Visa mina resor<Route size={16} /></button></section></>}</main><Nav /></>;
}
