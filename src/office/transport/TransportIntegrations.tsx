import { useEffect, useState } from 'react';
import { Check, Clock3, MessageCircle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { requestTransportConfirmation, respondTransportConfirmation, timeLabel } from './model';
import type { TransportActor, TransportData, TransportEventType, TransportIntegrationEvent, TransportOrder } from './types';
import type { TransportOutboxState } from './integrations-client';
import './transport-integrations.css';

type Props = {
  data: TransportData; actor: TransportActor; selectedOrder?: TransportOrder;
  outbox?: TransportOutboxState;
  onChange(next: TransportData, message: string): boolean | void;
  onError(message: string): void;
};
const eventLabels: Record<TransportEventType, string> = {
  'work_order.created': 'Arbetsorder skapad', 'work_order.updated': 'Arbetsorder ändrad',
  'work_order.booked': 'Bokning verkställd', 'work_order.rescheduled': 'Bokning ändrad',
  'work_order.booking_cancelled': 'Bokning avbokad', 'work_order.cancelled': 'Arbetsorder avbruten',
  'work_order.en_route': 'Föraren är på väg', 'work_order.completed': 'Arbete slutfört',
  'work_order.confirmation_requested': 'Kundförfrågan förberedd', 'work_order.confirmation_accepted': 'Kunden har godkänt',
  'work_order.confirmation_declined': 'Kunden har nekat', 'work_order.confirmation_expired': 'Svarstiden har gått ut',
};
const formatAt = (value: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const formatDay = (value: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(value + 'T12:00:00Z'));
function EventRow({ event }: { event: TransportIntegrationEvent }) {
  const before = event.beforePlan, after = event.afterPlan;
  return <li className="transport-integration-event">
    <div><strong>{eventLabels[event.type]}</strong><time dateTime={event.at}>{formatAt(event.at)}</time></div>
    <span>{event.orderId} · {event.customer.name}</span>
    {(before || after) && <span className="transport-event-time">{before && `${before.date} ${timeLabel(before.startMinute)}–${timeLabel(before.startMinute + before.durationMinutes)}`}{before && after && ' → '}{after && `${after.date} ${timeLabel(after.startMinute)}–${timeLabel(after.startMinute + after.durationMinutes)}`}</span>}
    {event.driver && <span>Förare: {event.driver.name}</span>}
    {event.reason && <span>{event.reason}</span>}
    <small>{event.actor} · Bokningsversion {event.bookingVersion}</small>
    <small className="transport-event-id">Händelse-ID: {event.id}</small>
  </li>;
}

export default function TransportIntegrations({ data, actor, selectedOrder: order, outbox, onChange, onError }: Props) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [hours, setHours] = useState(48);
  const [clock, setClock] = useState(Date.now);
  const [allEvents, setAllEvents] = useState(false);
  useEffect(() => { setReplyOpen(false); }, [order?.id, order?.bookingVersion, order?.confirmation?.id]);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 30000); return () => clearInterval(timer); }, []);
  if (!order) return null;
  const confirmation = order.confirmation;
  const current = confirmation && confirmation.bookingVersion === order.bookingVersion;
  const expired = Boolean(confirmation && Date.parse(confirmation.expiresAt) <= clock);
  const waiting = Boolean(current && confirmation.status === 'requested' && !expired);
  const status = !current ? 'Ingen förfrågan' : expired && confirmation.status === 'requested' ? 'Svarstiden har gått ut'
    : { requested: 'Inväntar kundsvar', accepted: 'Godkänd av kunden', declined: 'Nekad av kunden', expired: 'Svarstiden har gått ut' }[confirmation.status];
  const canRequest = actor.canPlan && order.status === 'booked' && !order.preliminary && !waiting;
  const events = [...data.events].reverse().filter((event) => allEvents || event.orderId === order.id);
  function request() {
    if (!canRequest) return;
    try {
      const next = requestTransportConfirmation(data, order!.id, new Date(Date.now() + hours * 3600000).toISOString(), actor);
      onChange(next, 'Kundförfrågan förberedd. Inget meddelande har skickats.');
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Förfrågan kunde inte förberedas.'); }
  }
  function reply(accepted: boolean) {
    if (!confirmation || !actor.canPlan) return;
    try {
      const next = respondTransportConfirmation(data, order!.id, confirmation.id, confirmation.bookingVersion, accepted, actor);
      if (onChange(next, accepted ? 'Kundens godkännande registrerat i demon.' : 'Kundens nej registrerat. Bokningen ligger kvar tills den planeras om.') !== false) setReplyOpen(false);
    } catch (reason) { onError(reason instanceof Error ? reason.message : 'Svaret kunde inte registreras.'); }
  }
  return <section className="transport-integrations" aria-label="Kundförfrågan och integrationshändelser">
    <h4><MessageCircle size={15} /> Bokningsförfrågan</h4>
    <div className={`transport-confirmation-status ${waiting ? 'waiting' : current && confirmation.status === 'accepted' ? 'accepted' : ''}`}><Clock3 size={13} /><span>{status}</span></div>
    {current && <p className="transport-confirmation-meta">{waiting ? 'Svara senast ' : 'Svarstid: '}{formatAt(confirmation.expiresAt)} · Version {confirmation.bookingVersion}</p>}
    {actor.canPlan && order.status === 'booked' && !order.preliminary && !waiting && <div className="transport-confirmation-request">
      <label>Svarstid<select aria-label="Svarstid för bokningsförfrågan" value={hours} onChange={(event) => setHours(Number(event.target.value))}><option value={24}>24 timmar</option><option value={48}>48 timmar</option><option value={72}>72 timmar</option></select></label>
      <button onClick={request}><MessageCircle size={13} /> Förbered förfrågan</button>
    </div>}
    {(order.status === 'unbooked' || order.preliminary) && <p>Verkställ bokningen för att förbereda en kundförfrågan.</p>}
    {waiting && actor.canPlan && order.status === 'booked' && <button className="transport-reply-preview-button" onClick={() => setReplyOpen((open) => !open)} aria-expanded={replyOpen}>Visa kundens svarsvy (demo)</button>}
    {replyOpen && waiting && order.status === 'booked' && <div className="transport-reply-preview" role="region" aria-label="Kundens svarsvy i demo">
      <small>Förhandsvisning av kundens svar</small><strong>Passar den föreslagna tiden?</strong>
      <span>{order.customerName}</span><span>{order.date && formatDay(order.date)}</span>
      <b>{order.startMinute !== undefined && `${timeLabel(order.startMinute)}–${timeLabel(order.startMinute + order.durationMinutes)}`}</b>
      <span>{order.address}, {order.city}</span>
      <div><button className="accept" onClick={() => reply(true)}><Check size={14} /> Ja, tiden passar</button><button onClick={() => reply(false)}><X size={14} /> Nej, ändra tiden</button></div>
    </div>}
    <p className="transport-integration-note"><ShieldCheck size={13} /> Förberett för aviseringar. SMS, e-post och svarslänkar kopplas in senare.</p>
    <details className="transport-event-log">
      <summary>Integrationshändelser <span>{data.events.filter((event) => event.orderId === order.id).length}</span></summary>
      <div className="transport-outbox-info"><strong>Utkorg · inga utskick</strong><span>Händelser och utkorg sparas i den gemensamma databasen. Leveranser är avstängda.</span>
        {outbox?.total ? <span role="status">{outbox.state === 'prepared' ? `${outbox.prepared} händelser förberedda på servern` : outbox.state === 'retrying' ? 'Servern svarade inte. Lokala händelser väntar på återförsök.' : 'Förbereder utkorgen…'}</span> : null}
        {outbox?.error && <button onClick={outbox.retry}><RefreshCw size={12} /> Försök igen</button>}
      </div>
      <label className="transport-events-filter"><input type="checkbox" checked={allEvents} onChange={(event) => setAllEvents(event.target.checked)} /> Visa alla arbetsorders händelser</label>
      {events.length ? <ol>{events.map((event) => <EventRow key={event.id} event={event} />)}</ol> : <p>Inga händelser har skapats för den här arbetsordern ännu.</p>}
    </details>
  </section>;
}
