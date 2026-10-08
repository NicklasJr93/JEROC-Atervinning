import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, Plus, Search, X, MapPin, Truck, Clock3, GripVertical, Pencil, CalendarCheck, Undo2, Info, Navigation, ArrowDownToLine, ArrowUpFromLine, Repeat2, ShieldCheck } from 'lucide-react';
import { can, type OfficeCustomer, type OfficeUser } from '../model';
import TransportMap from './TransportMap';
import TransportCalendar from './TransportCalendar';
import TransportOrderEditor from './TransportOrderEditor';
import { transportKey, transportSchema, seedTransport, today, monday, addDays, timeLabel, durationLabel, applyTransportChange, saveTransportOrder, validateTransportPlan, undoTransportChange, distanceKm } from './model';
import { vesselTypes, actionLabels, transportStatusLabels, type TransportData, type TransportOrder, type TransportPlan, type TransportDraft, type TransportChange, type TransportActor, type CalendarProposal, type TransportFocusRequest } from './types';
import './transport.css';

type Panel = { kind: 'details' | 'edit'; id: string } | { kind: 'book'; id: string; plan: TransportPlan } | { kind: 'create' } | null;
type Props = {
  user: OfficeUser; actualUser: OfficeUser; customers: OfficeCustomer[];
  onExit(): void; workAsControl?: ReactNode; officeBlocked?: boolean;
};
const readableDate = (date: string, compact = false) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm', weekday: 'short', day: 'numeric', month: compact ? 'short' : 'long', year: 'numeric',
}).format(new Date(date + 'T12:00:00Z'));
const ActionIcon = ({ action }: { action: TransportOrder['action'] }) => {
  const Icon = action === 'exchange' ? Repeat2 : action === 'placement' ? ArrowUpFromLine : ArrowDownToLine;
  return <Icon size={16} />;
};

export default function TransportWorkspace({ user, actualUser, customers, onExit, workAsControl, officeBlocked }: Props) {
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
  const [notice, setNotice] = useState('');
  const [undo, setUndo] = useState<TransportData | null>(null);
  const [date, setDate] = useState(today);
  const [view, setView] = useState<'day' | 'week'>('day');
  const [layout, setLayout] = useState<'both' | 'map' | 'plan'>('both');
  const [focusDriverId, setFocusDriverId] = useState('oskar');
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
  const [draggedOrderId, setDraggedOrderId] = useState<string | null>(null);
  const [mapFocus, setMapFocus] = useState<TransportFocusRequest>();
  const [calendarFocus, setCalendarFocus] = useState<TransportFocusRequest>();
  const [mapRatio, setMapRatio] = useState(56);
  const mainRef = useRef<HTMLDivElement>(null);
  const picker = useRef<((coords: { lat: number; lng: number }) => void) | null>(null);
  const [picking, setPicking] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const planning = can(user, 'transportPlan') && !blocked && !officeBlocked;
  const actor: TransportActor = {
    canPlan: planning, actualUserId: actualUser.id, effectiveUserId: user.id,
    actor: (actualUser.id === user.id ? user.name : actualUser.name + ' som ' + user.name) + ' · Kontor Norrtälje',
  };
  const selectedId = panel && 'id' in panel ? panel.id : null;
  const selected = data.orders.find(order => order.id === selectedId);
  const editor = panel && ['create', 'edit', 'book'].includes(panel.kind);

  useEffect(() => {
    if (initial.error) return;
    try {
      if (!localStorage.getItem(transportKey)) localStorage.setItem(transportKey, JSON.stringify(initial.data));
    } catch {
      setBlocked(true); setError('Transportuppgifterna kunde inte sparas. Tillåt webbläsarlagring och ladda om sidan.');
    }
  }, [initial]);
  useEffect(() => {
    function external(event: StorageEvent) {
      if (event.key !== transportKey) return;
      try {
        if (!event.newValue) throw new Error();
        const next = transportSchema.parse(JSON.parse(event.newValue));
        live.current = next; setData(next); setUndo(null); setPanel(null); setPicking(false); picker.current = null;
        setBlocked(false); setError(''); setNotice('Planeringen uppdaterades från en annan flik.');
      } catch {
        setBlocked(true); setError('Transportuppgifterna ändrades eller togs bort i en annan flik. Ladda om eller återställ transportdemon.');
      }
    }
    window.addEventListener('storage', external);
    return () => window.removeEventListener('storage', external);
  }, []);
  useEffect(() => {
    if (!planning && editor) { setPanel(null); setPicking(false); picker.current = null; }
  }, [planning, editor]);
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
    if (editor && !window.confirm('Stäng formuläret? Osparade uppgifter försvinner.')) return;
    setPanel({ kind: 'details', id }); setProfileOpen(false); if (!blocked) setError('');
  }
  function save(next: TransportData, expected: TransportData): boolean {
    try {
      const stored = localStorage.getItem(transportKey);
      const latest = stored ? transportSchema.parse(JSON.parse(stored)) : undefined;
      if (latest && latest.revision !== expected.revision) {
        live.current = latest; setData(latest); setUndo(null);
        throw new Error('Planeringen ändrades i en annan flik. Kontrollera uppgifterna och försök igen.');
      }
      localStorage.setItem(transportKey, JSON.stringify(transportSchema.parse(next)));
      live.current = next; setData(next); setError(''); return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ändringen kunde inte sparas.');
      return false;
    }
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
  const visibleOrders = data.orders.filter(order =>
    (!vesselFilter || order.vesselType === vesselFilter) &&
    (showDone || order.status !== 'done') &&
    (order.status === 'unbooked' || Boolean(order.date && order.date >= startDay && order.date <= endDay)),
  );
  const queue = visibleOrders.filter(order => order.status === 'unbooked' &&
    [order.id, order.customerName, order.address, order.city, order.material, order.pickupVessel, order.replacementVessel].join(' ').toLocaleLowerCase('sv-SE').includes(search.toLocaleLowerCase('sv-SE')),
  ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const mapOrders = visibleOrders.filter(order => order.status !== 'unbooked' || queue.some(item => item.id === order.id));
  function nearest(order: TransportOrder) {
    const candidate = visibleOrders.filter(other => other.id !== order.id && other.status === 'booked' && other.driverId &&
      (!focusDriverId || other.driverId === focusDriverId))
      .sort((a, b) => distanceKm(order, a) - distanceKm(order, b))[0];
    return candidate ? { order: candidate, distance: distanceKm(order, candidate) } : undefined;
  }
  function planFor(proposal: CalendarProposal): TransportPlan {
    const order = live.current.orders.find(item => item.id === proposal.id);
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
    if (!order || ['on_way', 'done'].includes(order.status)) return 'Ett påbörjat eller klart uppdrag kan inte flyttas.';
    return validateTransportPlan(live.current, proposal.id, planFor(proposal));
  }
  function propose(proposal: CalendarProposal) {
    const issue = validateProposal(proposal);
    if (issue) { setError(issue); return; }
    const plan = planFor(proposal);
    if (proposal.kind === 'book') {
      setPanel({ kind: 'book', id: proposal.id, plan }); setError('');
    } else {
      change({ type: 'reschedule', id: proposal.id, plan }, proposal.id + (proposal.kind === 'resize' ? ' · Tidsåtgång uppdaterad.' : ' · Bokning flyttad.'));
    }
    setDraggedOrderId(null);
  }
  function book(order: TransportOrder, relative?: 'before' | 'after') {
    if (!planning) return;
    const nearby = nearest(order);
    const driver = data.drivers.find(item => item.id === (nearby?.order.driverId ?? focusDriverId)) ?? data.drivers[0];
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
    let result = false;
    if (current.kind === 'create') {
      result = change({ type: 'create', draft, repeat: options.repeat }, 'Arbetsordern har skapats.', false);
    } else if ('id' in current) {
      try {
        const previous = live.current;
        const next = saveTransportOrder(previous, current.id, draft, actor, options.scope);
        result = save(next, previous);
        if (result) {
          setUndo(next.revision !== previous.revision ? previous : null);
          setNotice(current.kind === 'book' ? current.id + ' har bokats.' : current.id + ' har uppdaterats.');
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Arbetsordern kunde inte sparas.');
      }
    }
    if (result) {
      const id = current.kind === 'create' ? live.current.orders.find(order => !previousIds.has(order.id))?.id : 'id' in current ? current.id : undefined;
      setPanel(id ? { kind: 'details', id } : null); setPicking(false); picker.current = null;
      if (draft.date) setDate(draft.date);
    }
    return Boolean(result);
  }
  function showOnMap(order: TransportOrder) {
    if (order.date) setDate(order.date);
    setVesselFilter(''); if (order.status === 'done') setShowDone(true);
    if (layout === 'plan') setLayout('both');
    setMapFocus({ id: order.id, nonce: Date.now() });
  }
  function showInCalendar(order: TransportOrder) {
    if (!order.date) return;
    setDate(order.date); setVesselFilter(''); if (order.status === 'done') setShowDone(true);
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
  const nearby = selected?.status === 'unbooked' ? nearest(selected) : undefined;
  return (
    <section className="transport-workspace" data-testid="transport-workspace">
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
        <label className="transport-driver-focus"><span className="sr-only">Förarfokus</span>
          <select aria-label="Förarfokus" value={focusDriverId} onChange={event => setFocusDriverId(event.target.value)}>
            <option value="">Alla förare</option>
            {data.drivers.map(driver => <option key={driver.id} value={driver.id}>Fokus: {driver.name}</option>)}
          </select></label>
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
        <strong>Transportdemo · Sparas i denna webbläsare</strong><p>Karta, planerare och arbetsordrar visar samma uppgifter. Kontur visar förare, fyllning visar kärltyp. Obokade nålar pulserar mjukt.</p>
        <p>Restid bedöms manuellt. Förslagen visar närhet på kartan; de beräknar ingen körväg. Gemensam databas och förarapp kopplas på senare.</p></div>}
      {((error && !editor) || (!error && notice)) && <div className={'transport-message ' + (error ? 'error' : '')} role={error ? 'alert' : 'status'}>
        <span>{error || notice}</span>
        {!error && undo && planning && <button onClick={undoChange}><Undo2 size={15} />Ångra</button>}
        {blocked && can(user, 'transportPlan') && <button onClick={() => {
          if (!window.confirm('Återställ transportdemon? Endast transporternas lokala testdata ersätts.')) return;
          try { const reset = seedTransport(); localStorage.setItem(transportKey, JSON.stringify(reset)); live.current = reset; setData(reset); setBlocked(false); setError(''); setUndo(null); setPanel(null); setDate(today()); }
          catch { setError('Lagringen är blockerad. Tillåt webbläsarlagring och ladda om.'); }
        }}>Återställ transportdemo</button>}
        {!blocked && <button aria-label="Stäng transportmeddelande" onClick={() => { setError(''); setNotice(''); }}><X size={16} /></button>}
      </div>}
      <div className="transport-body">
        <div className={'transport-main layout-' + layout} ref={mainRef} style={{ gridTemplateRows: layout === 'both' ? mapRatio + 'fr 10px ' + (100 - mapRatio) + 'fr' : 'minmax(0, 1fr)' }}>
          {layout !== 'plan' && <TransportMap orders={mapOrders} drivers={data.drivers} focusDriverId={focusDriverId} hoveredId={hoveredId} selectedId={selectedId}
            onHover={(id, source) => hoverOrder(id, source, 'map')} onSelect={openOrder} focusRequest={mapFocus} pickingLocation={picking} onPickLocation={coords => { picker.current?.(coords); picker.current = null; setPicking(false); }} />}
          {layout === 'both' && <div className="transport-divider" role="separator" aria-label="Fördela yta mellan karta och planerare" aria-orientation="horizontal"
            aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(mapRatio)} tabIndex={0} onPointerDown={resizeSplit}
            onKeyDown={event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setMapRatio(value => Math.max(25, Math.min(75, value + (event.key === 'ArrowUp' ? -5 : 5)))); } }}><span /></div>}
          {layout !== 'map' && <TransportCalendar orders={visibleOrders} drivers={data.drivers} vehicles={data.vehicles} date={date} view={view} focusDriverId={focusDriverId}
            hoveredId={hoveredId} selectedId={selectedId} draggedOrderId={draggedOrderId} onHover={(id, source) => hoverOrder(id, source, 'calendar')} onSelect={openOrder} onDragOrder={setDraggedOrderId}
            onPropose={propose} validateProposal={validateProposal} canPlan={planning} focusRequest={calendarFocus} />}
        </div>
        <aside className={'transport-side ' + (editor ? 'is-editor' : '')} aria-label="Arbetsordrar">
          {editor && panel ? <TransportOrderEditor key={editorKey} order={selected} data={data} customers={customers}
            mode={panel.kind as 'create' | 'edit' | 'book'} initialPlan={panel.kind === 'book' ? panel.plan : undefined} error={error} onError={setError}
            onSubmit={submit} onCancel={() => { setPicking(false); picker.current = null; if (selectedId) setPanel({ kind: 'details', id: selectedId }); else closePanel(); if (!blocked) setError(''); }}
            onPickLocation={receive => { picker.current = receive; setPicking(true); if (layout === 'plan') setLayout('both'); }} />
            : selected && panel?.kind === 'details' ? <div className="transport-details">
              <div className="transport-side-heading"><div><span className="transport-eyebrow">ARBETSORDER</span><h2>Arbetsorder {selected.id}</h2></div>
                <button aria-label="Stäng arbetsorder" onClick={closePanel}><X size={19} /></button></div>
              <span className={'transport-state state-' + selected.status}>{transportStatusLabels[selected.status]}</span>
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
              </dl></div>
              {selected.status !== 'unbooked' ? <div className="transport-detail-section"><h4>Planering</h4>
                <p><CalendarDays size={16} />{readableDate(selected.date!)}</p><p><Clock3 size={16} />{timeLabel(selected.startMinute!)}–{timeLabel(selected.startMinute! + selected.durationMinutes)}</p>
                <p><i className="transport-driver-dot" style={{ borderColor: currentDriver?.color }} />{currentDriver?.name}</p><p><Truck size={16} />{currentVehicle?.registration} · {currentVehicle?.name}</p>
              </div> : <div className="transport-detail-section"><h4>Önskemål</h4><p>{selected.requestedDate ? readableDate(selected.requestedDate) : 'Ingen särskild dag angiven'}</p></div>}
              {selected.notes && <div className="transport-detail-section"><h4>Instruktioner</h4><p className="transport-notes">{selected.notes}</p></div>}
              {nearby && <div className="transport-nearby"><strong>Nära {data.drivers.find(driver => driver.id === nearby.order.driverId)?.name}s bokade stopp</strong>
                <span>{nearby.order.id} · {timeLabel(nearby.order.startMinute!)}–{timeLabel(nearby.order.startMinute! + nearby.order.durationMinutes)}</span>
                <small>Ca {nearby.distance.toLocaleString('sv-SE', { maximumFractionDigits: 1 })} km fågelväg. Kontrollera restiden; förslaget lämnar 15 min mellan uppdragen.</small>
                {planning && <div><button onClick={() => book(selected, 'before')}>Boka före</button><button onClick={() => book(selected, 'after')}>Boka efter</button></div>}
              </div>}
              <div className="transport-detail-actions">
                {planning && selected.status === 'unbooked' && <button className="transport-primary" onClick={() => book(selected)}><CalendarCheck size={17} />Boka uppdrag</button>}
                {planning && ['unbooked', 'booked'].includes(selected.status) && <button onClick={() => { setPanel({ kind: 'edit', id: selected.id }); setError(''); }}><Pencil size={16} />Redigera</button>}
                {planning && selected.status === 'booked' && <><button onClick={() => {
                  if (!window.confirm('Avboka ' + selected.id + '? Arbetsordern finns kvar bland obokade arbeten.')) return;
                  change({ type: 'unbook', id: selected.id }, selected.id + ' finns nu bland obokade arbeten.');
                }}>Avboka</button><button onClick={() => change({ type: 'status', id: selected.id, status: 'on_way' }, selected.id + ' · Föraren är på väg.')}>Markera på väg</button></>}
                {planning && ['booked', 'on_way'].includes(selected.status) && <button onClick={() => {
                  if (window.confirm('Markera ' + selected.id + ' som klart? Uppdraget låses för planeringsändringar.')) change({ type: 'status', id: selected.id, status: 'done' }, selected.id + ' har slutförts.');
                }}>Markera klart</button>}
                <button onClick={() => showOnMap(selected)}><Navigation size={16} />Visa på karta</button>
                {selected.date && <button onClick={() => showInCalendar(selected)}><CalendarDays size={16} />Visa i planeraren</button>}
              </div>
              <details className="transport-audit"><summary>Historik · {selected.audit.length}</summary>
                {selected.audit.slice().reverse().map((entry, index) => <div key={entry.at + ':' + index}><strong>{entry.text}</strong><span>{entry.actor}</span>
                  <time>{new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Stockholm' }).format(new Date(entry.at))}</time></div>)}</details>
            </div> : <div className="transport-queue">
              <div className="transport-side-heading"><h2>Obokade arbeten <span>{queue.length}</span></h2></div>
              <label className="transport-queue-search"><Search size={17} /><input aria-label="Sök obokade arbeten" placeholder="Sök uppdrag…" value={search} onChange={event => setSearch(event.target.value)} /></label>
              <div className="transport-queue-filters"><select aria-label="Filtrera kärltyp" value={vesselFilter} onChange={event => setVesselFilter(event.target.value)}><option value="">Alla kärltyper</option>
                {Object.entries(vesselTypes).map(([key, type]) => <option value={key} key={key}>{type.label}</option>)}</select>
                <label><input type="checkbox" checked={showDone} onChange={event => setShowDone(event.target.checked)} />Visa klara</label></div>
              <div className="transport-queue-list">
                {queue.map(order => {
                  const close = nearest(order);
                  const closeDriver = close && data.drivers.find(driver => driver.id === close.order.driverId);
                  return <div key={order.id} role="button" tabIndex={0} data-testid={'transport-queue-' + order.id} data-order-id={order.id}
                    className={'transport-queue-card ' + (hoveredId === order.id ? 'is-hovered' : '')}
                    style={{ '--vessel-color': vesselTypes[order.vesselType].color } as CSSProperties}
                    draggable={planning} onDragStart={event => { event.dataTransfer.setData('application/jeroc-order', order.id); event.dataTransfer.effectAllowed = 'move'; setDraggedOrderId(order.id); setHoveredId(order.id); }}
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
              <p className="transport-queue-hint"><GripVertical size={18} /><span>Klicka för detaljer{planning && <><br />Dra till kalendern för att boka</>}</span></p>
            </div>}
        </aside>
      </div>
    </section>
  );
}
