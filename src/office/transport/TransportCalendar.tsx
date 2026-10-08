import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from 'react';
import { Clock3, GripVertical, Check, Truck, AlertCircle } from 'lucide-react';
import { addDays, durationLabel, monday, timeLabel } from './model';
import { actionLabels, type CalendarProposal, type TransportDriver, type TransportFocusRequest, type TransportOrder, type TransportVehicle } from './types';
import './transport-calendar.css';

export interface TransportCalendarProps {
  orders: TransportOrder[];
  drivers: TransportDriver[];
  vehicles: TransportVehicle[];
  date: string;
  view: 'day' | 'week';
  focusDriverId: string;
  hoveredId: string | null;
  selectedId: string | null;
  draggedOrderId: string | null;
  onHover(id: string | null, sourceId?: string): void;
  onSelect(id: string): void;
  onDragOrder(id: string | null): void;
  onPropose(proposal: CalendarProposal): void;
  validateProposal(proposal: CalendarProposal): string | null;
  canPlan: boolean;
  focusRequest?: TransportFocusRequest;
}

interface Preview { proposal: CalendarProposal; error: string | null }
interface ResizeSession {
  order: TransportOrder;
  origin: number;
  pixelsPerMinute: number;
}
const snap = (minutes: number) => Math.round(minutes / 15) * 15;
const dayLabel = (date: string) => new Intl.DateTimeFormat('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00`));

export default function TransportCalendar({ orders, drivers, vehicles, date, view, focusDriverId, hoveredId, selectedId, draggedOrderId, onHover, onSelect, onDragOrder, onPropose, validateProposal, canPlan, focusRequest }: TransportCalendarProps) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const resizeRef = useRef<ResizeSession | null>(null);
  const grabRef = useRef<{ id: string; offset: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const weekStart = monday(date);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const visible = useMemo(() => orders.filter(order => order.status !== 'unbooked' && order.date && (view === 'day' ? order.date === date : days.includes(order.date)) && order.startMinute !== undefined && drivers.some(driver => driver.id === order.driverId)), [orders, view, date, days, drivers]);
  const firstMinute = Math.max(0, Math.min(420, ...visible.map(order => Math.floor(order.startMinute! / 60) * 60)));
  const lastMinute = Math.min(1440, Math.max(1020, ...visible.map(order => Math.ceil((order.startMinute! + order.durationMinutes) / 60) * 60)));
  const minutes = lastMinute - firstMinute;
  const hours = minutes / 60;
  const ticks = Array.from({ length: hours + 1 }, (_, index) => firstMinute + index * 60);
  const focusedWeek = view === 'week' && drivers.some(driver => driver.id === focusDriverId);
  const laneWidths = drivers.map(driver => focusedWeek && drivers.length > 1 ? (driver.id === focusDriverId ? 70 : 30 / (drivers.length - 1)) : 100 / drivers.length);
  const laneLeft = (index: number) => laneWidths.slice(0, index).reduce((sum, width) => sum + width, 0);
  const css = { '--tc-hours': hours, '--tc-day-width': `${hours * 74}px`, '--tc-week-height': `${hours * 68}px` } as CSSProperties;

  useEffect(() => {
    setPreview(null);
    setFeedback(null);
    resizeRef.current = null;
  }, [date, view]);
  useEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(() => {
      const card = scrollRef.current?.querySelector<HTMLElement>(`[data-order-id="${CSS.escape(focusRequest.id)}"]`);
      card?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      card?.querySelector<HTMLButtonElement>('.tc-order-open')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, date, view]);

  function proposalFor(event: DragEvent<HTMLDivElement>, driverId: string, targetDate: string): CalendarProposal | null {
    const id = draggedOrderId || event.dataTransfer.getData('application/jeroc-order');
    const order = orders.find(item => item.id === id);
    if (!canPlan || !order || (order.status !== 'unbooked' && order.status !== 'booked')) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const coordinate = view === 'day' ? event.clientX - rect.left : event.clientY - rect.top;
    const pixels = view === 'day' ? rect.width : rect.height;
    const offset = grabRef.current?.id === id ? grabRef.current.offset : 0;
    const startMinute = Math.max(firstMinute, Math.min(lastMinute - 15, snap(firstMinute + coordinate / pixels * minutes - offset)));
    return { id: order.id, date: targetDate, startMinute, durationMinutes: order.durationMinutes, driverId, kind: order.status === 'unbooked' ? 'book' : 'move' };
  }
  function dragOver(event: DragEvent<HTMLDivElement>, driverId: string, targetDate: string) {
    const proposal = proposalFor(event, driverId, targetDate);
    if (!proposal) return;
    event.preventDefault();
    const error = validateProposal(proposal);
    event.dataTransfer.dropEffect = error ? 'none' : 'move';
    setPreview({ proposal, error });
    setFeedback(error);
  }
  function drop(event: DragEvent<HTMLDivElement>, driverId: string, targetDate: string) {
    event.preventDefault();
    const proposal = proposalFor(event, driverId, targetDate);
    setPreview(null);
    grabRef.current = null;
    onDragOrder(null);
    if (!proposal) return;
    const error = validateProposal(proposal);
    setFeedback(error);
    if (!error) onPropose(proposal);
  }
  function leaveTrack(event: DragEvent<HTMLDivElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (!resizeRef.current) setPreview(null);
  }
  function startDrag(event: DragEvent<HTMLElement>, order: TransportOrder) {
    if (!canPlan || order.status !== 'booked' || resizeRef.current) {
      event.preventDefault();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = view === 'day' ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
    grabRef.current = { id: order.id, offset: Math.max(0, fraction * order.durationMinutes) };
    event.dataTransfer.setData('application/jeroc-order', order.id);
    event.dataTransfer.setData('text/plain', order.id);
    event.dataTransfer.effectAllowed = 'move';
    onDragOrder(order.id);
    onHover(null, order.id);
  }
  function endDrag() {
    grabRef.current = null;
    setPreview(null);
    onDragOrder(null);
  }
  function resizeProposal(event: PointerEvent<HTMLButtonElement>): CalendarProposal | null {
    const session = resizeRef.current;
    if (!session || !session.order.date || session.order.startMinute === undefined || !session.order.driverId) return null;
    const coordinate = view === 'day' ? event.clientX : event.clientY;
    const durationMinutes = Math.max(15, Math.min(1440, snap(session.order.durationMinutes + (coordinate - session.origin) / session.pixelsPerMinute)));
    return { id: session.order.id, date: session.order.date, startMinute: session.order.startMinute, durationMinutes, driverId: session.order.driverId, kind: 'resize' };
  }
  function startResize(event: PointerEvent<HTMLButtonElement>, order: TransportOrder) {
    if (!canPlan || order.status !== 'booked') return;
    event.preventDefault();
    event.stopPropagation();
    const track = event.currentTarget.closest<HTMLElement>('[data-timeline]');
    if (!track) return;
    const rect = track.getBoundingClientRect();
    resizeRef.current = { order, origin: view === 'day' ? event.clientX : event.clientY, pixelsPerMinute: (view === 'day' ? rect.width : rect.height) / minutes };
    event.currentTarget.setPointerCapture(event.pointerId);
    setFeedback(null);
    onHover(order.id);
  }
  function resizeMove(event: PointerEvent<HTMLButtonElement>) {
    const proposal = resizeProposal(event);
    if (!proposal) return;
    const error = validateProposal(proposal);
    setPreview({ proposal, error });
    setFeedback(error);
  }
  function finishResize(event: PointerEvent<HTMLButtonElement>) {
    const proposal = resizeProposal(event);
    const previousDuration = resizeRef.current?.order.durationMinutes;
    resizeRef.current = null;
    setPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!proposal || proposal.durationMinutes === previousDuration) return;
    const error = validateProposal(proposal);
    setFeedback(error);
    if (!error) onPropose(proposal);
  }
  function previewInTrack(driverId: string, targetDate: string) {
    if (!preview || preview.proposal.driverId !== driverId || preview.proposal.date !== targetDate || preview.proposal.kind === 'resize') return null;
    const { proposal, error } = preview;
    const geometry: CSSProperties = view === 'day'
      ? { left: `${(proposal.startMinute - firstMinute) / minutes * 100}%`, width: `${proposal.durationMinutes / minutes * 100}%` }
      : { top: `${(proposal.startMinute - firstMinute) / minutes * 100}%`, height: `${proposal.durationMinutes / minutes * 100}%` };
    return <div className={`tc-proposal ${error ? 'is-invalid' : ''}`} style={geometry} aria-hidden="true"><strong>{timeLabel(proposal.startMinute)}–{timeLabel(proposal.startMinute + proposal.durationMinutes)}</strong><span>{error || durationLabel(proposal.durationMinutes)}</span></div>;
  }
  function renderOrder(order: TransportOrder) {
    const driver = drivers.find(item => item.id === order.driverId)!;
    const vehicle = vehicles.find(item => item.id === order.vehicleId);
    const resizing = preview?.proposal.id === order.id && preview.proposal.kind === 'resize' ? preview : null;
    const duration = resizing ? resizing.proposal.durationMinutes : order.durationMinutes;
    const geometry: CSSProperties = view === 'day'
      ? { left: `${(order.startMinute! - firstMinute) / minutes * 100}%`, width: `${duration / minutes * 100}%`, '--tc-driver': driver.color } as CSSProperties
      : { top: `${(order.startMinute! - firstMinute) / minutes * 100}%`, height: `${duration / minutes * 100}%`, '--tc-driver': driver.color } as CSSProperties;
    const editable = canPlan && order.status === 'booked';
    const label = `${order.id}, ${order.customerName}, ${actionLabels[order.action]}, ${timeLabel(order.startMinute!)} till ${timeLabel(order.startMinute! + duration)}, ${driver.name}`;
    return <article
      key={order.id}
      className={`tc-order tc-order-${order.status} ${hoveredId === order.id ? 'is-hovered' : ''} ${selectedId === order.id ? 'is-selected' : ''} ${focusDriverId && focusDriverId !== driver.id ? 'is-dimmed' : ''} ${draggedOrderId === order.id ? 'is-dragging' : ''} ${resizing?.error ? 'is-invalid' : ''}`}
      style={geometry}
      data-order-id={order.id}
      data-testid={`calendar-order-${order.id}`}
      draggable={editable}
      onDragStart={event => startDrag(event, order)}
      onDragEnd={endDrag}
      onMouseEnter={() => onHover(order.id)}
      onMouseLeave={() => { if (!resizeRef.current) onHover(null, order.id); }}
    >
      <button className="tc-order-open" type="button" aria-label={label} onClick={() => onSelect(order.id)} onFocus={() => onHover(order.id)} onBlur={() => { if (!resizeRef.current) onHover(null, order.id); }}>
        <span className="tc-order-time">{order.status === 'done' ? <Check size={11} /> : order.status === 'on_way' ? <Truck size={11} /> : null}{timeLabel(order.startMinute!)}–{timeLabel(order.startMinute! + duration)}</span>
        <strong>{order.customerName}</strong>
        <span className="tc-order-action">{actionLabels[order.action]} · {order.pickupVessel || order.vesselSize || order.material}</span>
        <span className="tc-order-meta">{view === 'week' ? driver.name.split(' ')[0] : order.id}{view === 'day' && vehicle ? ` · ${vehicle.registration}` : ''}</span>
      </button>
      {editable && <button
        type="button"
        role="slider"
        className="tc-resize"
        aria-label={`Ändra tidsåtgång för ${order.id}`}
        aria-valuemin={15}
        aria-valuemax={Math.min(480, 1440 - order.startMinute!)}
        aria-valuenow={duration}
        aria-valuetext={durationLabel(duration)}
        aria-orientation={view === 'day' ? 'horizontal' : 'vertical'}
        title="Dra för att ändra tidsåtgång · steg om 15 minuter"
        draggable={false}
        onDragStart={event => event.preventDefault()}
        onPointerDown={event => startResize(event, order)}
        onPointerMove={resizeMove}
        onPointerUp={finishResize}
        onPointerCancel={() => { resizeRef.current = null; setPreview(null); }}
        onFocus={() => onHover(order.id)}
        onBlur={() => { if (!resizeRef.current) onHover(null, order.id); }}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          const decrease = view === 'day' ? 'ArrowLeft' : 'ArrowUp';
          const increase = view === 'day' ? 'ArrowRight' : 'ArrowDown';
          if (event.key !== decrease && event.key !== increase) return;
          event.preventDefault();
          event.stopPropagation();
          const proposal: CalendarProposal = { id: order.id, date: order.date!, startMinute: order.startMinute!, durationMinutes: Math.max(15, order.durationMinutes + (event.key === increase ? 15 : -15)), driverId: order.driverId!, kind: 'resize' };
          const error = validateProposal(proposal);
          setFeedback(error);
          if (!error && proposal.durationMinutes !== order.durationMinutes) onPropose(proposal);
        }}
      ><GripVertical size={13} /></button>}
    </article>;
  }

  return <section className={`transport-calendar tc-${view} ${focusedWeek ? 'tc-week-focused' : ''}`} style={css} aria-label={view === 'day' ? 'Dagsplanerare' : 'Veckoplanerare'}>
    <div className="tc-heading"><div><span className="tc-heading-icon"><Clock3 size={17} /></span><strong>{view === 'day' ? 'Dagens planering' : 'Veckans planering'}</strong><span className="tc-job-count">{visible.length} uppdrag</span></div><span className="tc-hint">{canPlan ? 'Dra in ett uppdrag · dra kanten för tidsåtgång' : 'Du kan läsa uppdrag och bokningar'}</span></div>
    <div className="tc-scroll" ref={scrollRef}>
      {view === 'day' ? <div className="tc-day-canvas">
        <div className="tc-day-header"><div className="tc-resource-header">Förare / fordon</div><div className="tc-hours">{ticks.map((tick, index) => <span key={tick} style={{ left: `${index / hours * 100}%` }}>{timeLabel(tick)}</span>)}</div></div>
        {drivers.map(driver => {
          const vehicle = vehicles.find(item => item.id === driver.vehicleId);
          return <div className={`tc-day-row ${focusDriverId && focusDriverId !== driver.id ? 'is-unfocused' : ''}`} key={driver.id}>
            <div className="tc-resource"><span className="tc-driver-avatar" style={{ background: driver.color }}>{driver.name.split(' ').map(part => part[0]).slice(0, 2).join('')}</span><div><strong>{driver.name}</strong><span>{vehicle?.registration || 'Inget fordon'}</span></div></div>
            <div className="tc-day-track" data-timeline data-driver-id={driver.id} data-date={date} data-testid={`calendar-slot-${driver.id}-${date}`} onDragOver={event => dragOver(event, driver.id, date)} onDrop={event => drop(event, driver.id, date)} onDragLeave={leaveTrack}>
              {visible.filter(order => order.driverId === driver.id).map(renderOrder)}
              {previewInTrack(driver.id, date)}
            </div>
          </div>;
        })}
      </div> : <div className="tc-week-canvas">
        <div className="tc-week-head"><div className="tc-week-time-label">Tid</div>{days.map(day => <div key={day} className={`tc-week-day-title ${day === date ? 'is-current' : ''}`}><strong>{dayLabel(day)}</strong><div className="tc-week-drivers">{drivers.map((driver, index) => <span key={driver.id} title={driver.name} style={{ flex: `0 0 ${laneWidths[index]}%` }}><i style={{ background: driver.color }} />{focusedWeek && driver.id !== focusDriverId ? driver.name[0] : driver.name.split(' ')[0]}</span>)}</div></div>)}</div>
        <div className="tc-week-body"><div className="tc-week-times">{ticks.map((tick, index) => <span key={tick} style={{ top: `${index / hours * 100}%` }}>{timeLabel(tick)}</span>)}</div>{days.map(day => <div className={`tc-week-day ${day === date ? 'is-current' : ''}`} key={day}>{drivers.map((driver, index) => <div
          className="tc-week-lane"
          key={driver.id}
          style={{ left: `${laneLeft(index)}%`, width: `${laneWidths[index]}%` }}
          data-timeline data-driver-id={driver.id} data-date={day}
          data-testid={`calendar-slot-${driver.id}-${day}`}
          onDragOver={event => dragOver(event, driver.id, day)}
          onDrop={event => drop(event, driver.id, day)}
          onDragLeave={leaveTrack}
        >{visible.filter(order => order.date === day && order.driverId === driver.id).map(renderOrder)}{previewInTrack(driver.id, day)}</div>)}</div>)}</div>
      </div>}
    </div>
    <div className={`tc-footer ${feedback ? 'has-error' : ''}`} role={feedback ? 'alert' : undefined}>{feedback ? <><AlertCircle size={14} /><span>{feedback}</span></> : <><span><i className="tc-legend-booked" />Bokat</span><span><i className="tc-legend-way" />På väg</span><span><i className="tc-legend-done" />Klart</span><span className="tc-footer-note">{canPlan ? 'Tider i steg om 15 min · klicka för detaljer' : 'Klicka för detaljer'}</span></>}</div>
  </section>;
}
