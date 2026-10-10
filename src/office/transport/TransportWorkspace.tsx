import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, Plus, Search, X, MapPin, Truck, Clock3, GripVertical, Pencil, CalendarCheck, Undo2, Info, Navigation, ArrowDownToLine, ArrowUpFromLine, Repeat2, ShieldCheck, AlertCircle, FileText } from 'lucide-react';
import { can, type OfficeCustomer, type OfficeUser } from '../model';
import TransportMap from './TransportMap';
import TransportCalendar from './TransportCalendar';
import TransportOrderEditor from './TransportOrderEditor';
import { transportKey, transportSchema, seedTransport, today, monday, addDays, timeLabel, durationLabel, applyTransportChange, saveTransportOrder, validateTransportPlan, undoTransportChange, distanceKm, effectiveTransportOrders, stageTransportPlan, removePreliminary, commitPreliminaryBookings, savePreliminaryOrder, transportPlanOf, expireTransportConfirmations } from './model';
import { vesselTypes, actionLabels, transportStatusLabels, type TransportData, type TransportOrder, type TransportPlan, type TransportDraft, type TransportChange, type TransportActor, type CalendarProposal, type TransportFocusRequest } from './types';
import './transport.css';
import { useSharedData } from '../../shared-data';
import TransportIntegrations from './TransportIntegrations';
import { useTransportOutbox } from './integrations-client';
import { readPersonnelAvailability } from '../personnel/client';
import { personnelPlanIssues } from '../personnel/model';
import type { PersonnelResponse } from '../personnel/types';
import { transportUnavailableSpans } from './personnel-availability';
import TransportDocumentPanel from '../documents/TransportDocumentPanel';
import '../documents/documents.css';

type Panel = { kind: 'details' | 'edit'; id: string } | { kind: 'book'; id: string; plan: TransportPlan } | { kind: 'create' } | null;
type Props = {
  user: OfficeUser; actualUser: OfficeUser; customers: OfficeCustomer[];
  onExit(): void; workAsControl?: ReactNode; officeBlocked?: boolean;
  onOpenStaffing?(): void;
  initialOrderId?: string;
  onOpenWorkOrder?(id: string): void;
};
const readableDate = (date: string, compact = false) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm', weekday: 'short', day: 'numeric', month: compact ? 'short' : 'long', year: 'numeric',
}).format(new Date(date + 'T12:00:00Z'));
const ActionIcon = ({ action }: { action: TransportOrder['action'] }) => {
  const Icon = action === 'exchange' ? Repeat2 : action === 'placement' ? ArrowUpFromLine : ArrowDownToLine;
  return <Icon size={16} />;
};

export default function TransportWorkspace({ user, actualUser, customers, onExit, workAsControl, officeBlocked, onOpenStaffing, initialOrderId, onOpenWorkOrder }: Props) {
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(transportKey);
      return { data: raw ? transportSchema.parse(JSON.parse(raw)) : seedTransport(), error: '' };
    } catch {
      return { data: seedTransport(), error: 'Sparade transportuppgifter kunde inte läsas. Återställ transportdemon för att fortsätta; befintliga kontorsuppgifter påverkas inte.' };
    }
  });
  const [data, setData] = useState(initial.data);
  const live = useRef(data); live.current = data;
  const [blocked, setBlocked] = useState(Boolean(initial.error));
  const [error, setError] = useState(initial.error);
  const shared = useSharedData<TransportData>({domain:'transport',key:transportKey,identity:{actor:actualUser.id,user:user.id},current:live,accept:next=>{setData(next);setBlocked(false);},error:setError,parse:value=>transportSchema.parse(value)});
  const [notice, setNotice] = useState('');
  const [undo, setUndo] = useState<TransportData | null>(null);
  const [date, setDate] = useState(today);
  const [view, setView] = useState<'day' | 'week'>('day');
  const [layout, setLayout] = useState<'both' | 'map' | 'plan'>('both');
  const [selectedDriverIds, setSelectedDriverIds] = useState(() => initial.data.drivers.map(driver => driver.id));
  const [vesselFilter, setVesselFilter] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [search, setSearch] = useState('');
  const [hover, setHover] = useState<{ id: string | null; surface: string | null }>({ id: null, surface: null });
  const hoveredId = hover.id;
  function setHoveredId(id: string | null) { setHover({ id, surface: null }); }
  function hoverOrder(id: string | null, sourceId?: string, surface = 'queue') {
    setHover(previous => id ? { id, surface }
      : sourceId && (previous.id !== sourceId || previous.surface !== surface)
        ? previous : { id: null, surface: null });
  }
  const [panel, setPanel] = useState<Panel>(null);
  const [documentOrderId, setDocumentOrderId] = useState<string>();
  const [draggedOrderId, setDraggedOrderId] = useState<string | null>(null);
  const [mapFocus, setMapFocus] = useState<TransportFocusRequest>();
  const [calendarFocus, setCalendarFocus] = useState<TransportFocusRequest>();
  const [mapRatio, setMapRatio] = useState(56);
  const mainRef = useRef<HTMLDivElement>(null);
  const queueDragGhost = useRef<HTMLCanvasElement>(null);
  const picker = useRef<((coords: { lat: number; lng: number }) => void) | null>(null);
  const [picking, setPicking] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [personnel, setPersonnel] = useState<PersonnelResponse | null>(null);
  const [personnelError, setPersonnelError] = useState('');
  const [availabilityRefresh, setAvailabilityRefresh] = useState(0);
  useEffect(() => {
    let active = true, loading = false;
    setPersonnel(null); setPersonnelError('');
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const result = await readPersonnelAvailability(actualUser.id, user.id);
        if (active) { setPersonnel(result); setPersonnelError(''); }
      } catch (reason) {
        if (active) { setPersonnel(null); setPersonnelError(reason instanceof Error ? reason.message : 'Förarnas tillgänglighet kunde inte hämtas.'); }
      } finally { loading = false; }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    const foreground = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', foreground);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', foreground); };
  }, [actualUser.id, user.id, availabilityRefresh]);
  const planning = can(user, 'transportPlan') && shared.ready && !blocked && !officeBlocked && Boolean(personnel);
  const actor: TransportActor = {
    canPlan: planning, actualUserId: actualUser.id, effectiveUserId: user.id,
    actor: (actualUser.id === user.id ? user.name : actualUser.name + ' som ' + user.name) + ' · Kontor Norrtälje',
  };
  const outbox = useTransportOutbox(data.events, actor);
  const selectedId = panel && 'id' in panel ? panel.id : null;
  const projectedOrders = effectiveTransportOrders(data).filter(order => order.operator !== 'external');
  const openedFromLink = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!shared.ready || !initialOrderId || openedFromLink.current === initialOrderId) return;
    const order = data.orders.find(entry => entry.id === initialOrderId && entry.operator !== 'external');
    if (!order) return;
    openedFromLink.current = initialOrderId;
    setPanel({ kind: 'details', id: order.id });
    if (order.date || order.requestedDate) setDate(order.date ?? order.requestedDate!);
  }, [shared.ready, initialOrderId, data.orders]);
  const preliminaryOrders = projectedOrders.filter(order => order.preliminary);
  const selected = projectedOrders.find(order => order.id === selectedId);
  const editor = panel && ['create', 'edit', 'book'].includes(panel.kind);

  useEffect(() => {
    if (!planning && editor) { setPanel(null); setPicking(false); picker.current = null; }
  }, [planning, editor]);
  useEffect(() => {
    if (!planning) return;
    function expireRequests() {
      const previous = live.current;
      if (!previous.orders.some(order => order.confirmation?.status === 'requested' && Date.parse(order.confirmation.expiresAt) <= Date.now())) return;
      try {
        const next = expireTransportConfirmations(previous, actor);
        if (next.revision !== previous.revision && save(next, previous)) setUndo(null);
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Kundförfrågan kunde inte uppdateras.'); }
    }
    expireRequests(); const timer = setInterval(expireRequests, 30000);
    return () => clearInterval(timer);
  }, [planning, actualUser.id, user.id]);
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (picking) { picker.current = null; setPicking(false); return; }
      setPanel(null); setHoveredId(null); setProfileOpen(false); setHelpOpen(false);
    }
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [picking]);

  function closePanel() {
    setPanel(null); setHoveredId(null); setPicking(false); picker.current = null; if (!blocked) setError('');
  }
  function openOrder(id: string) {
    if (picking) return;
    if (panel?.kind === 'details' && panel.id === id) { closePanel(); return; }
    if (editor && !window.confirm('Stäng formuläret? Osparade uppgifter försvinner.')) return;
    setPanel({ kind: 'details', id }); setProfileOpen(false); if (!blocked) setError('');
  }
  function updatePlanning(transform: (previous: TransportData) => TransportData, message: string) {
    try {
      const previous = live.current;
      const next = transform(previous);
      if (!save(next, previous)) return false;
      setUndo(next.revision !== previous.revision ? previous : null); setNotice(message); return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Planeringen kunde inte sparas.'); return false;
    }
  }
  function toggleDriver(id: string) {
    setSelectedDriverIds(ids => ids.includes(id) ? ids.filter(other => other !== id) : [...ids, id]);
  }
  function save(next: TransportData, _expected: TransportData): boolean {
    if (!personnel) { setError('Hämta förarnas tillgänglighet innan du ändrar planeringen.'); return false; }
    for (const order of effectiveTransportOrders(next)) {
      const previous = effectiveTransportOrders(_expected).find(old => old.id === order.id);
      const departing = order.status === 'on_way' && previous?.status !== 'on_way';
      if (order.status !== 'booked' && !departing) continue;
      const plan = transportPlanOf(order);
      const committed = _expected.preliminary[order.id] && !next.preliminary[order.id];
      const requirementsChanged = JSON.stringify(previous?.requiredCompetencies) !== JSON.stringify(order.requiredCompetencies);
      if (!plan || !departing && !committed && !requirementsChanged && JSON.stringify(transportPlanOf(previous)) === JSON.stringify(plan)) continue;
      const issue = personnelPlanIssues(personnel.data, next, order.id, plan)[0];
      if (issue) { setError(`${order.id}: ${issue}`); return false; }
    }
    return shared.save(next);
  }
  function change(operation: TransportChange, message: string, remember = true) {
    try {
      const previous = live.current;
      const next = applyTransportChange(previous, operation, actor);
      if (!save(next, previous)) return false;
      setUndo(remember && next.revision !== previous.revision ? previous : null);
      setNotice(message); return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ändringen kunde inte sparas.');
      return false;
    }
  }
  function undoChange() {
    if (!undo) return;
    try {
      const previous = live.current;
      if (save(undoTransportChange(previous, undo, actor), previous)) {
        setUndo(null); setNotice('Senaste ändringen har ångrats.');
        if (panel && 'id' in panel && !live.current.orders.some(order => order.id === panel.id)) closePanel();
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Ändringen kunde inte ångras.'); }
  }
  const startDay = view === 'week' ? monday(date) : date;
  const endDay = view === 'week' ? addDays(startDay, 6) : date;
  const visibleOrders = projectedOrders.filter(order =>
    (!vesselFilter || order.vesselType === vesselFilter) &&
    (showDone || !['done', 'cancelled'].includes(order.status)) &&
    (order.status === 'unbooked' || (order.status === 'cancelled' && !order.date) || Boolean(order.date && order.date >= startDay && order.date <= endDay)),
  );
  const queue = visibleOrders.filter(order => order.status === 'unbooked' &&
    [order.id, order.customerName, order.address, order.city, order.material, order.pickupVessel, order.replacementVessel].join(' ').toLocaleLowerCase('sv-SE').includes(search.toLocaleLowerCase('sv-SE')),
  ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const mapOrders = visibleOrders.filter(order => order.status !== 'unbooked' || queue.some(item => item.id === order.id));
  function nearest(order: TransportOrder) {
    const candidate = visibleOrders.filter(other => other.id !== order.id && other.status === 'booked' && other.driverId &&
      selectedDriverIds.includes(other.driverId))
      .sort((a, b) => distanceKm(order, a) - distanceKm(order, b))[0];
    return candidate ? { order: candidate, distance: distanceKm(order, candidate) } : undefined;
  }
  function planFor(proposal: CalendarProposal): TransportPlan {
    const order = effectiveTransportOrders(live.current).find(item => item.id === proposal.id);
    const driver = live.current.drivers.find(item => item.id === proposal.driverId);
    return {
      date: proposal.date, startMinute: proposal.startMinute, durationMinutes: proposal.durationMinutes,
      driverId: proposal.driverId,
      vehicleId: order && order.driverId === driver?.id && order.vehicleId ? order.vehicleId : driver?.vehicleId ?? '',
    };
  }
  function validateProposal(proposal: CalendarProposal) {
    if (!planning) return 'Du saknar behörighet att planera transporter.';
    const order = live.current.orders.find(item => item.id === proposal.id);
    if (!order || ['on_way', 'done', 'cancelled'].includes(order.status)) return 'Ett påbörjat, klart eller avbrutet uppdrag kan inte flyttas.';
    const plan = planFor(proposal);
    return validateTransportPlan(live.current, proposal.id, plan) || (personnel ? personnelPlanIssues(personnel.data, live.current, proposal.id, plan)[0] ?? null : 'Förarnas tillgänglighet hämtas.');
  }
  function propose(proposal: CalendarProposal) {
    const issue = validateProposal(proposal);
    if (issue) { setError(issue); return; }
    const plan = planFor(proposal);
    if (proposal.kind === 'book' || live.current.preliminary[proposal.id]) {
      updatePlanning(previous => stageTransportPlan(previous, proposal.id, plan, actor), proposal.id + ' · Preliminär bokning sparad.');
    } else {
      change({ type: 'reschedule', id: proposal.id, plan }, proposal.id + (proposal.kind === 'resize' ? ' · Tidsåtgång uppdaterad.' : ' · Bokning flyttad.'));
    }
    setDraggedOrderId(null);
    setHoveredId(null);
  }
  function book(order: TransportOrder, relative?: 'before' | 'after') {
    if (!planning) return;
    const nearby = nearest(order);
    const driver = data.drivers.find(item => item.id === (nearby?.order.driverId ?? selectedDriverIds[0])) ?? data.drivers[0];
    let startMinute = 9 * 60;
    let plannedDate = date;
    if (nearby && relative) {
      plannedDate = nearby.order.date!;
      startMinute = relative === 'after'
        ? nearby.order.startMinute! + nearby.order.durationMinutes + 15
        : nearby.order.startMinute! - order.durationMinutes - 15;
    }
    setPanel({ kind: 'book', id: order.id, plan: {
      date: plannedDate, startMinute: Math.max(0, Math.min(1440 - order.durationMinutes, startMinute)),
      durationMinutes: order.durationMinutes, driverId: driver.id, vehicleId: driver.vehicleId,
    } });
    setError('');
  }
  function submit(draft: TransportDraft, options: { repeat: 'none' | 'weekly' | 'biweekly'; scope: 'one' | 'series' }) {
    if (!panel) return false;
    const current = panel;
    const previousIds = new Set(data.orders.map(order => order.id));
    const intendedPlan = draft.status === 'booked' ? transportPlanOf({ ...draft, id: '', audit: [], updatedAt: '', bookingVersion: 0 }) : undefined;
    const unbookedDraft: TransportDraft = { ...draft, status: 'unbooked', date: undefined, startMinute: undefined, driverId: undefined, vehicleId: undefined };
    const result = updatePlanning(previous => {
      let next: TransportData;
      if (current.kind === 'create') {
        next = applyTransportChange(previous, { type: 'create', draft: intendedPlan ? { ...unbookedDraft, requestedDate: intendedPlan.date } : draft, repeat: options.repeat }, actor);
        if (intendedPlan) {
          const interval = options.repeat === 'weekly' ? 7 : options.repeat === 'biweekly' ? 14 : 0;
          next.orders.filter(order => !previousIds.has(order.id)).forEach((order, index) => {
            next = stageTransportPlan(next, order.id, { ...intendedPlan, date: addDays(intendedPlan.date, index * interval) }, actor);
          });
        }
      } else if ('id' in current) {
        if (previous.preliminary[current.id]) {
          next = savePreliminaryOrder(previous, current.id, draft, actor, options.scope);
        } else if (intendedPlan && previous.orders.find(order => order.id === current.id)?.status === 'unbooked') {
          next = saveTransportOrder(previous, current.id, unbookedDraft, actor, options.scope);
          next = stageTransportPlan(next, current.id, intendedPlan, actor);
        } else {
          next = saveTransportOrder(previous, current.id, draft, actor, options.scope);
        }
      } else return previous;
      return next.revision === previous.revision ? previous : { ...next, revision: previous.revision + 1 };
    }, intendedPlan && (current.kind === 'create' || current.kind === 'book' || selected?.preliminary) ? 'Preliminär planering sparad. Verkställ när tiderna är klara.' : 'Arbetsordern har sparats.');
    if (result) {
      const id = current.kind === 'create' ? live.current.orders.find(order => !previousIds.has(order.id))?.id : 'id' in current ? current.id : undefined;
      setPanel(id ? { kind: 'details', id } : null); setPicking(false); picker.current = null;
      if (draft.date) setDate(draft.date);
    }
    return Boolean(result);
  }
  function showOnMap(order: TransportOrder) {
    if (order.date) setDate(order.date);
    setVesselFilter(''); if (['done', 'cancelled'].includes(order.status)) setShowDone(true);
    if (order.driverId) setSelectedDriverIds(ids => ids.includes(order.driverId!) ? ids : [...ids, order.driverId!]);
    if (layout === 'plan') setLayout('both');
    setMapFocus({ id: order.id, nonce: Date.now() });
  }
  function showInCalendar(order: TransportOrder) {
    if (!order.date) return;
    setDate(order.date); setVesselFilter(''); if (['done', 'cancelled'].includes(order.status)) setShowDone(true);
    if (layout === 'map') setLayout('both');
    setCalendarFocus({ id: order.id, nonce: Date.now() });
  }
  function resizeSplit(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault(); const bounds = mainRef.current?.getBoundingClientRect(); if (!bounds) return;
    const update = (next: globalThis.PointerEvent) => setMapRatio(Math.max(25, Math.min(75, (next.clientY - bounds.top) / bounds.height * 100)));
    const end = () => { window.removeEventListener('pointermove', update); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
    window.addEventListener('pointermove', update); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  }
  const editorKey = panel ? panel.kind + (('id' in panel ? panel.id : '') + (panel.kind === 'book' ? JSON.stringify(panel.plan) : '')) : '';
  const currentDriver = selected && data.drivers.find(item => item.id === selected.driverId);
  const currentVehicle = selected && data.vehicles.find(item => item.id === selected.vehicleId);
  const currentPerson = personnel?.data.people.find(person => person.driverId === currentDriver?.id);
  const currentCompany = personnel?.data.companies.find(company => company.id === currentPerson?.companyId);
  const orderWarnings: Record<string, string[]> = {};
  if (personnel) for (const order of visibleOrders) {
    const plan = transportPlanOf(order);
    if (plan && ['booked', 'on_way'].includes(order.status)) {
      const issues = personnelPlanIssues(personnel.data, data, order.id, plan);
      if (issues.length) orderWarnings[order.id] = issues;
    }
  }
  const unavailable: Record<string, { startMinute: number; endMinute: number; label: string }[]> = {};
  if (personnel) for (const driver of data.drivers) for (let day = startDay; day <= endDay; day = addDays(day, 1)) {
    unavailable[`${driver.id}:${day}`] = transportUnavailableSpans(personnel.data, driver.id, day);
  }
  const staffingWarningCount = Object.keys(orderWarnings).length;
  const nearby = selected?.status === 'unbooked' ? nearest(selected) : undefined;
  return (
    <section className="transport-workspace" data-testid="transport-workspace">
      {documentOrderId && <TransportDocumentPanel key={`${actualUser.id}:${user.id}:${documentOrderId}`} orderId={documentOrderId}
        identity={{actualUserId:actualUser.id,userId:user.id}} canEdit={can(user, 'transportPlan') && shared.ready && !blocked && !officeBlocked}
        onClose={() => setDocumentOrderId(undefined)} />}
      <canvas className="transport-drag-ghost" ref={queueDragGhost} width={1} height={1} aria-hidden="true" />
      <header className="transport-toolbar">
        <button className="transport-back" onClick={onExit}><ArrowLeft size={17} /><span>Till kontoret</span></button>
        <h1>Transportplanering</h1>
        <div className="transport-date">
          <button aria-label="Föregående period" onClick={() => setDate(addDays(date, view === 'week' ? -7 : -1))}><ChevronLeft size={18} /></button>
          <label><span>{view === 'week' ? readableDate(startDay, true) + ' – ' + readableDate(endDay, true) : readableDate(date, true)}</span>
            <input type="date" aria-label="Datum i planeraren" value={date} onChange={event => { if (event.target.value) setDate(event.target.value); }} /></label>
          <button aria-label="Nästa period" onClick={() => setDate(addDays(date, view === 'week' ? 7 : 1))}><ChevronRight size={18} /></button>
          <button onClick={() => setDate(today())}>Idag</button>
        </div>
        <div className="transport-segment" aria-label="Kalendervy">
          <button aria-pressed={view === 'day'} className={view === 'day' ? 'active' : ''} onClick={() => setView('day')}>Dag</button>
          <button aria-pressed={view === 'week'} className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>Vecka</button>
        </div>
        <button aria-label="Visa alla förare på kartan" onClick={() => setSelectedDriverIds(data.drivers.map(driver => driver.id))}>Alla förare <small>{selectedDriverIds.length}/{data.drivers.length}</small></button>
        <select className="transport-layout-select" aria-label="Visa arbetsyta" value={layout} onChange={event => setLayout(event.target.value as typeof layout)}>
          <option value="both">Karta + planering</option><option value="map">Endast karta</option><option value="plan">Endast planering</option>
        </select>
        {planning ? <button className="transport-primary transport-new" onClick={() => { setPanel({ kind: 'create' }); setError(''); }}><Plus size={17} />Nytt uppdrag</button>
          : <span className="transport-readonly"><ShieldCheck size={15} />Läsläge</span>}
        <button className="transport-help-button" aria-label="Om transportdemon" onClick={() => setHelpOpen(!helpOpen)}><Info size={18} /></button>
        <button className="transport-profile-button" aria-label="Profil och behörighet" onClick={() => setProfileOpen(!profileOpen)}>{user.name.split(' ').map(name => name[0]).join('').slice(0, 2)}</button>
      </header>
      {profileOpen && <div className="transport-profile-popover"><strong>{user.name}</strong><span>{user.level} · {planning ? 'Planeringsbehörighet' : 'Läsbehörighet'}</span>
        {actualUser.id !== user.id && <p>Inloggad som {actualUser.name}</p>}{workAsControl}</div>}
      {helpOpen && <div className="transport-help-popover"><button aria-label="Stäng information" onClick={() => setHelpOpen(false)}><X size={17} /></button>
        <strong>Transportplanering</strong><p>Karta, planerare och arbetsordrar visar samma uppgifter. Kontur visar förare, fyllning visar kärltyp. Obokade nålar skakar kort. Klicka på förarnas namn för att välja vilka nålar du ser.</p>
        <p>Schema, frånvaro och verifierade kompetenser hämtas från personalregistret. Skrafferade tider kan inte bokas. Befintliga bokningar ligger kvar om en förare blir otillgänglig, med en bemanningsvarning. Restid bedöms manuellt.</p></div>}
      {!personnel && <div className={'transport-message ' + (personnelError ? 'error' : '')} role={personnelError ? 'alert' : 'status'}><span>{personnelError || 'Hämtar förarnas tillgänglighet…'}</span>{personnelError && <button onClick={() => setAvailabilityRefresh(value => value + 1)}>Försök igen</button>}</div>}
      {staffingWarningCount > 0 && <div className="transport-staffing-warning" role="status"><AlertCircle size={18} /><div><strong>{staffingWarningCount} uppdrag behöver bemanningskontroll</strong><span>Bokningarna finns kvar. Kontrollera tillgänglighet och kompetenser innan uppdragen körs.</span></div>{onOpenStaffing && personnel?.capabilities.includes('personnelRead') && <button onClick={onOpenStaffing}>Bemanning att lösa</button>}</div>}
      {((error && !editor) || (!error && notice)) && <div className={'transport-message ' + (error ? 'error' : '')} role={error ? 'alert' : 'status'}>
        <span>{error || notice}</span>
        {!error && undo && planning && <button onClick={undoChange}><Undo2 size={15} />Ångra</button>}
        {blocked && can(user, 'transportPlan') && <button onClick={() => {
          if (!window.confirm('Hämta aktuella serveruppgifter? Lokala osparade uppgifter bevaras i återhämtningscachen.')) return;
          try { window.location.reload(); }
          catch { setError('Lagringen är blockerad. Tillåt webbläsarlagring och ladda om.'); }
        }}>Hämta serveruppgifter</button>}
        {!blocked && <button aria-label="Stäng transportmeddelande" onClick={() => { setError(''); setNotice(''); }}><X size={16} /></button>}
      </div>}
      {layout === 'map' && <div className="transport-map-driver-controls" aria-label="Förare på kartan">{data.drivers.map(driver => <button key={driver.id} aria-pressed={selectedDriverIds.includes(driver.id)} onClick={() => toggleDriver(driver.id)}><i style={{ background: driver.color }} />{driver.name}</button>)}</div>}
      {preliminaryOrders.length > 0 && <div className="transport-planning-bar" aria-label="Preliminära bokningar">
        <div><strong>{preliminaryOrders.length} {preliminaryOrders.length === 1 ? 'preliminär bokning' : 'preliminära bokningar'}</strong><span>Inte verkställda ännu · sparas som planeringsutkast</span></div>
        <div className="transport-planning-orders">{preliminaryOrders.map(order => <button key={order.id} onClick={() => { setPanel({ kind: 'details', id: order.id }); showInCalendar(order); }}>{order.id} · {timeLabel(order.startMinute!)}</button>)}</div>
        {planning && <button className="transport-primary" onClick={() => {
          if (editor) { setError('Spara eller stäng formuläret innan du verkställer bokningarna.'); return; }
          updatePlanning(previous => commitPreliminaryBookings(previous, actor), preliminaryOrders.length + ' ' + (preliminaryOrders.length === 1 ? 'bokning har' : 'bokningar har') + ' verkställts.');
        }}>{preliminaryOrders.length === 1 ? 'Bekräfta bokning' : 'Verkställ bokningar (' + preliminaryOrders.length + ')'}</button>}
      </div>}
      <div className="transport-body">
        <div className={'transport-main layout-' + layout} ref={mainRef} style={{ gridTemplateRows: layout === 'both' ? mapRatio + 'fr 10px ' + (100 - mapRatio) + 'fr' : 'minmax(0, 1fr)' }}>
          {layout !== 'plan' && <TransportMap orders={mapOrders} drivers={data.drivers} selectedDriverIds={selectedDriverIds} hoveredId={hoveredId} selectedId={selectedId}
            onHover={(id, source) => hoverOrder(id, source, 'map')} onSelect={openOrder} focusRequest={mapFocus} pickingLocation={picking} onPickLocation={coords => { picker.current?.(coords); picker.current = null; setPicking(false); }} />}
          {layout === 'both' && <div className="transport-divider" role="separator" aria-label="Fördela yta mellan karta och planerare" aria-orientation="horizontal"
            aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(mapRatio)} tabIndex={0} onPointerDown={resizeSplit}
            onKeyDown={event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setMapRatio(value => Math.max(25, Math.min(75, value + (event.key === 'ArrowUp' ? -5 : 5)))); } }}><span /></div>}
          {layout !== 'map' && <TransportCalendar orders={visibleOrders} drivers={data.drivers} vehicles={data.vehicles} date={date} view={view} selectedDriverIds={selectedDriverIds} onToggleDriver={toggleDriver}
            hoveredId={hoveredId} selectedId={selectedId} draggedOrderId={draggedOrderId} onHover={(id, source) => hoverOrder(id, source, 'calendar')} onSelect={openOrder} onDragOrder={setDraggedOrderId}
            onPropose={propose} validateProposal={validateProposal} canPlan={planning} focusRequest={calendarFocus} unavailable={unavailable} orderWarnings={orderWarnings} />}
        </div>
        <aside className={'transport-side ' + (editor ? 'is-editor' : '')} aria-label="Arbetsordrar">
          {editor && panel ? <TransportOrderEditor key={editorKey} order={selected} data={data} customers={customers}
            personnel={personnel?.data}
            mode={panel.kind as 'create' | 'edit' | 'book'} initialPlan={panel.kind === 'book' ? panel.plan : undefined} error={error} onError={setError}
            onSubmit={submit} onCancel={() => { setPicking(false); picker.current = null; if (selectedId) setPanel({ kind: 'details', id: selectedId }); else closePanel(); if (!blocked) setError(''); }}
            onPickLocation={receive => { picker.current = receive; setPicking(true); if (layout === 'plan') setLayout('both'); }} />
            : selected && panel?.kind === 'details' ? <div className="transport-details">
              <div className="transport-side-heading"><div><span className="transport-eyebrow">ARBETSORDER</span><h2>Arbetsorder {selected.id}</h2></div>
                <button aria-label="Stäng arbetsorder" onClick={closePanel}><X size={19} /></button></div>
              <span className={'transport-state state-' + (selected.preliminary ? 'preliminary' : selected.status)}>{selected.preliminary ? 'Preliminär bokning' : transportStatusLabels[selected.status]}</span>
              {orderWarnings[selected.id] && <div className="transport-order-staffing-warning" role="status"><AlertCircle size={16} /><div><strong>Bemanning behöver åtgärdas</strong>{orderWarnings[selected.id].map(issue => <p key={issue}>{issue}</p>)}</div></div>}
              <h3>{selected.customerName}</h3>
              <p className="transport-detail-address"><MapPin size={15} /><span>{selected.address}<br />{selected.city}</span></p>
              {selected.contact && <p>{selected.contact}{selected.phone && <><br /><a href={'tel:' + selected.phone}>{selected.phone}</a></>}</p>}
              <div className="transport-detail-section"><h4>Uppdrag</h4><dl>
                <dt>Typ</dt><dd><ActionIcon action={selected.action} />{actionLabels[selected.action]}</dd>
                <dt>Kärl</dt><dd><i style={{ background: vesselTypes[selected.vesselType].color }} />{vesselTypes[selected.vesselType].label}{selected.vesselSize ? ' · ' + selected.vesselSize : ''}</dd>
                {selected.material && <><dt>Material</dt><dd>{selected.material}</dd></>}
                {selected.pickupVessel && <><dt>Hämta</dt><dd>{selected.pickupVessel}</dd></>}
                {selected.replacementVessel && <><dt>Ställ ut</dt><dd>{selected.replacementVessel}</dd></>}
                <dt>Tidsåtgång</dt><dd><Clock3 size={15} />{durationLabel(selected.durationMinutes)}</dd>
                {Boolean(selected.requiredCompetencies?.length) && <><dt>Krav</dt><dd>{selected.requiredCompetencies!.join(', ')}</dd></>}
              </dl></div>
              {selected.date && selected.startMinute !== undefined ? <div className="transport-detail-section"><h4>{selected.preliminary ? 'Preliminär planering' : 'Planering'}</h4>
                <p><CalendarDays size={16} />{readableDate(selected.date!)}</p><p><Clock3 size={16} />{timeLabel(selected.startMinute!)}–{timeLabel(selected.startMinute! + selected.durationMinutes)}</p>
                <p><i className="transport-driver-dot" style={{ borderColor: currentDriver?.color }} />{currentDriver?.name}</p><p><Truck size={16} />{currentVehicle?.registration} · {currentVehicle?.name}</p>
                {currentPerson?.kind === 'external' && <p>Extern förare · {currentCompany?.name ?? 'Åkeri'}</p>}
              </div> : <div className="transport-detail-section"><h4>Önskemål</h4><p>{selected.requestedDate ? readableDate(selected.requestedDate) : 'Ingen särskild dag angiven'}</p></div>}
              {selected.notes && <div className="transport-detail-section"><h4>Instruktioner</h4><p className="transport-notes">{selected.notes}</p></div>}
              {nearby && <div className="transport-nearby"><strong>Nära {data.drivers.find(driver => driver.id === nearby.order.driverId)?.name}s bokade stopp</strong>
                <span>{nearby.order.id} · {timeLabel(nearby.order.startMinute!)}–{timeLabel(nearby.order.startMinute! + nearby.order.durationMinutes)}</span>
                <small>Ca {nearby.distance.toLocaleString('sv-SE', { maximumFractionDigits: 1 })} km fågelväg. Kontrollera restiden; förslaget lämnar 15 min mellan uppdragen.</small>
                {planning && <div><button onClick={() => book(selected, 'before')}>Boka före</button><button onClick={() => book(selected, 'after')}>Boka efter</button></div>}
              </div>}
              <div className="transport-detail-actions">
                {onOpenWorkOrder && <button onClick={() => onOpenWorkOrder(selected.id)}><FileText size={16} />Öppna hela arbetsordern</button>}
                {planning && selected.status === 'unbooked' && <button className="transport-primary" onClick={() => book(selected)}><CalendarCheck size={17} />Boka uppdrag</button>}
                {planning && ['unbooked', 'booked'].includes(selected.status) && <button onClick={() => { setPanel({ kind: 'edit', id: selected.id }); setError(''); }}><Pencil size={16} />Redigera</button>}
                {planning && selected.preliminary && <button onClick={() => updatePlanning(previous => removePreliminary(previous, selected.id, actor), selected.id + ' är åter obokad.')}>Ta bort preliminär bokning</button>}
                {planning && selected.status === 'booked' && !selected.preliminary && <><button onClick={() => {
                  if (!window.confirm('Avboka ' + selected.id + '? Arbetsordern finns kvar bland obokade arbeten.')) return;
                  change({ type: 'unbook', id: selected.id }, selected.id + ' finns nu bland obokade arbeten.');
                }}>Avboka</button><button onClick={() => change({ type: 'status', id: selected.id, status: 'on_way' }, selected.id + ' · Föraren är på väg.')}>Markera på väg</button></>}
                {planning && !selected.preliminary && ['booked', 'on_way'].includes(selected.status) && <button onClick={() => {
                  if (window.confirm('Markera ' + selected.id + ' som klart? Uppdraget låses för planeringsändringar.')) change({ type: 'status', id: selected.id, status: 'done' }, selected.id + ' har slutförts.');
                }}>Markera klart</button>}
                {planning && ['unbooked', 'booked', 'on_way'].includes(selected.status) && <button className="transport-cancel-order" onClick={() => {
                  const reason = window.prompt('Orsak till att avbryta ' + selected.id + '? Arbetsordern och historiken sparas.');
                  if (reason === null) return;
                  change({ type: 'cancel', id: selected.id, reason }, selected.id + ' har avbrutits.');
                }}>Avbryt arbetsorder</button>}
                <button onClick={() => showOnMap(selected)}><Navigation size={16} />Visa på karta</button>
                {selected.date && <button onClick={() => showInCalendar(selected)}><CalendarDays size={16} />Visa i planeraren</button>}
              </div>
              <section className="transport-document-summary"><h4><FileText size={16} /> Transportdokument</h4><p>Förbered och arkivera ett PDF-utkast för hämtning eller utleverans.</p><button className="office-btn outline" onClick={() => setDocumentOrderId(selected.id)}><FileText size={15} /> Öppna transportunderlag</button></section>
              <TransportIntegrations data={data} actor={actor} selectedOrder={selected} outbox={outbox} onChange={(next, message) => updatePlanning(() => next, message)} onError={setError} />
              <details className="transport-audit"><summary>Historik · {selected.audit.length}</summary>
                {selected.audit.slice().reverse().map((entry, index) => <div key={entry.at + ':' + index}><strong>{entry.text}</strong><span>{entry.actor}</span>
                  <time>{new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Stockholm' }).format(new Date(entry.at))}</time></div>)}</details>
            </div> : <div className="transport-queue">
              <div className="transport-side-heading"><h2>Obokade arbeten <span>{queue.length}</span></h2></div>
              <label className="transport-queue-search"><Search size={17} /><input aria-label="Sök obokade arbeten" placeholder="Sök uppdrag…" value={search} onChange={event => setSearch(event.target.value)} /></label>
              <div className="transport-queue-filters"><select aria-label="Filtrera kärltyp" value={vesselFilter} onChange={event => setVesselFilter(event.target.value)}><option value="">Alla kärltyper</option>
                {Object.entries(vesselTypes).map(([key, type]) => <option value={key} key={key}>{type.label}</option>)}</select>
                <label><input type="checkbox" checked={showDone} onChange={event => setShowDone(event.target.checked)} />Visa avslutade</label></div>
              <div className="transport-queue-list">
                {queue.map(order => {
                  const close = nearest(order);
                  const closeDriver = close && data.drivers.find(driver => driver.id === close.order.driverId);
                  return <div key={order.id} role="button" tabIndex={0} data-testid={'transport-queue-' + order.id} data-order-id={order.id}
                    className={'transport-queue-card ' + (hoveredId === order.id ? 'is-hovered' : '')}
                    style={{ '--vessel-color': vesselTypes[order.vesselType].color } as CSSProperties}
                    draggable={planning} onDragStart={event => { event.dataTransfer.setData('application/jeroc-order', order.id); event.dataTransfer.effectAllowed = 'move'; if (queueDragGhost.current) event.dataTransfer.setDragImage(queueDragGhost.current, 0, 0); setDraggedOrderId(order.id); hoverOrder(order.id); }}
                    onDragEnd={() => { setDraggedOrderId(null); hoverOrder(null, order.id); }}
                    onMouseEnter={() => hoverOrder(order.id)} onMouseLeave={() => hoverOrder(null, order.id)} onFocus={() => hoverOrder(order.id)} onBlur={() => hoverOrder(null, order.id)}
                    onClick={() => openOrder(order.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openOrder(order.id); } }}>
                    <div className="transport-queue-card-title"><GripVertical size={16} /><strong>{order.id}</strong><i /><ChevronRight size={17} /></div>
                    <h3><ActionIcon action={order.action} />{actionLabels[order.action]} · {vesselTypes[order.vesselType].label}</h3><strong className="transport-queue-customer">{order.customerName}</strong>
                    <p><MapPin size={14} />{order.address}, {order.city}</p><span className="transport-queue-duration"><Clock3 size={14} />{durationLabel(order.durationMinutes)}</span>
                    {close && close.distance < 2 && closeDriver && <span className="transport-nearby-label">Nära {closeDriver.name}s stopp</span>}
                  </div>;
                })}
                {!queue.length && <div className="transport-empty"><CalendarCheck size={28} /><strong>{search || vesselFilter ? 'Inga matchande arbeten' : 'Alla arbeten är planerade'}</strong><span>{search || vesselFilter ? 'Prova en annan sökning eller kärltyp.' : 'Nya arbetsordrar hamnar här tills de bokas.'}</span></div>}
              </div>
              <p className="transport-queue-hint"><GripVertical size={18} /><span>Klicka för detaljer{planning && <><br />Dra till kalendern, justera och verkställ</>}</span></p>
            </div>}
        </aside>
      </div>
    </section>
  );
}
