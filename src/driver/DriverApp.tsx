import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CalendarDays, CheckCircle2, ChevronDown, Clock3, ClipboardList, LoaderCircle, LockKeyhole, LogOut, MapPin, Phone, RefreshCw, Truck, UserRound } from 'lucide-react';
import { actionLabels, transportStatusLabels, vesselTypes, type TransportOrder } from '../office/transport/types';
import type { LogisticsDriverCommand, LogisticsOrderDetail } from '../office/logistics/types';
import DriverLogistics from './DriverLogistics';
import './driver.css';

interface DriverSession {
  person: { id: string; name: string; kind: 'employee' | 'external'; driverId: string; companyId?: string };
  company: { id: string; name: string };
  demo: boolean;
}

class DriverError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function driverRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/driver${path}`, {
    credentials: 'same-origin', cache: 'no-store',
    ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new DriverError(result?.error || 'Kunde inte kontakta JEROC. Försök igen.', response.status);
  return result as T;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Något gick fel. Försök igen.';
const timeLabel = (minutes: number) => `${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`;
const dayLabel = (day?: string) => day ? new Intl.DateTimeFormat('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Stockholm' }).format(new Date(`${day}T12:00:00Z`)) : 'Datum saknas';

type DriverTransportOrder = TransportOrder & { detail?: LogisticsOrderDetail };

function DriverOrder({ order, open, busy, disabled, onToggle, onStatus, onLogistics }: {
  order: DriverTransportOrder; open: boolean; busy: boolean; disabled: boolean; onToggle: () => void;
  onStatus: (status: 'on_way' | 'done') => void;
  onLogistics: (command: LogisticsDriverCommand) => void;
}) {
  const type = vesselTypes[order.vesselType];
  const time = order.startMinute === undefined ? '' : `${timeLabel(order.startMinute)}–${timeLabel(order.startMinute + order.durationMinutes)}`;
  return <article className={`driver-order${open ? ' is-open' : ''}`}>
    <div className="driver-order-top"><span className="driver-order-number">{order.id}</span><span className={`driver-status ${order.status}`}>{transportStatusLabels[order.status]}</span></div>
    <h2>{order.customerName}</h2>
    <p className="driver-order-kind"><Truck size={17} />{actionLabels[order.action]} · {type.label}{order.vesselSize && ` · ${order.vesselSize}`}</p>
    <p className="driver-order-address"><MapPin size={17} /><span>{order.address}{order.city && `, ${order.city}`}</span></p>
    <div className={`driver-order-time${order.status === 'unbooked' ? ' is-wish' : ''}`}><CalendarDays size={18} /><div><strong>{dayLabel(order.date || order.requestedDate)}{time && ` · ${time}`}</strong><span>{order.status === 'unbooked' ? 'Önskat datum · tid är inte bokad' : `Bokad tid · ${order.durationMinutes} minuter`}</span></div></div>
    <button className="driver-order-toggle" aria-expanded={open} aria-controls={`driver-details-${order.id}`} onClick={onToggle}>Visa {open ? 'färre' : 'uppgifter'}<ChevronDown size={18} /></button>
    {open && <div className="driver-order-details" id={`driver-details-${order.id}`}>
      {order.material && <div><span>Material</span><strong>{order.material}</strong></div>}
      {order.pickupVessel && <div><span>Kärl att hämta</span><strong>{order.pickupVessel}</strong></div>}
      {order.replacementVessel && <div><span>Kärl att lämna</span><strong>{order.replacementVessel}</strong></div>}
      {order.contact && <div><span>Kontakt på plats</span><strong>{order.contact}</strong></div>}
      {order.phone && <a className="driver-contact" href={`tel:${order.phone.replace(/[^+\d]/g, '')}`}><Phone size={17} />{order.phone}</a>}
      {order.notes && <div className="driver-order-notes"><span>Instruktioner</span><p>{order.notes}</p></div>}
      {order.detail && order.status !== 'cancelled' && <DriverLogistics key={`${order.id}:${order.detail.version}`} detail={order.detail} busy={busy} disabled={disabled} onAction={onLogistics} />}
    </div>}
    {!order.detail && order.status === 'booked' && <button className="driver-button primary driver-order-action" disabled={disabled} onClick={() => onStatus('on_way')}>{busy ? <LoaderCircle className="driver-spinner" size={18} /> : <Truck size={18} />}{busy ? 'Sparar…' : 'Jag är på väg'}</button>}
    {!order.detail && order.status === 'on_way' && <button className="driver-button green driver-order-action" disabled={disabled} onClick={() => onStatus('done')}>{busy ? <LoaderCircle className="driver-spinner" size={18} /> : <CheckCircle2 size={18} />}{busy ? 'Sparar…' : 'Markera uppdrag som klart'}</button>}
  </article>;
}

export default function DriverApp() {
  const [session, setSession] = useState<DriverSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [orders, setOrders] = useState<DriverTransportOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const generation = useRef(0);
  const orderSequence = useRef(0);

  const clearSession = useCallback(() => {
    generation.current += 1; orderSequence.current += 1;
    setSession(null); setOrders([]); setOpenId(null); setBusyOrder(null); setOrdersLoading(false); setNotice('');
  }, []);

  const refreshOrders = useCallback(async (showLoading = false) => {
    const current = generation.current, sequence = ++orderSequence.current;
    if (showLoading) setOrdersLoading(true);
    try {
      const result = await driverRequest<{ orders: DriverTransportOrder[] }>('/orders');
      if (current !== generation.current || sequence !== orderSequence.current) return;
      setOrders(result.orders); setError('');
    } catch (caught) {
      if (current !== generation.current || sequence !== orderSequence.current) return;
      if (caught instanceof DriverError && caught.status === 401) { clearSession(); setError('Logga in igen för att se dina uppdrag.'); }
      else setError(errorMessage(caught));
    } finally { if (current === generation.current && sequence === orderSequence.current) setOrdersLoading(false); }
  }, [clearSession]);

  useEffect(() => {
    const current = generation.current;
    void driverRequest<DriverSession>('/session').then(result => {
      if (current !== generation.current) return;
      setSession(result);
    }).catch(caught => {
      if (current !== generation.current) return;
      if (!(caught instanceof DriverError && caught.status === 401)) setError(errorMessage(caught));
    }).finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current += 1; orderSequence.current += 1; };
  }, []);

  useEffect(() => {
    if (!session) return;
    void refreshOrders(true);
    const refresh = () => { if (!document.hidden) void refreshOrders(); };
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh); window.addEventListener('online', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('online', refresh); };
  }, [session, refreshOrders]);

  const login = async (event: FormEvent) => {
    event.preventDefault(); if (loginBusy) return;
    const current = ++generation.current;
    setLoginBusy(true); setError('');
    try {
      const result = await driverRequest<DriverSession>('/login', { username: username.trim(), password });
      if (current !== generation.current) return;
      setSession(result); setPassword(''); setNotice('');
    } catch (caught) { if (current === generation.current) setError(errorMessage(caught)); }
    finally { if (current === generation.current) setLoginBusy(false); }
  };

  const logout = async () => {
    if (logoutBusy) return;
    setLogoutBusy(true); setError('');
    try { await driverRequest('/logout', {}); clearSession(); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setLogoutBusy(false); }
  };

  const updateStatus = async (order: DriverTransportOrder, status: 'on_way' | 'done') => {
    if (busyOrder || logoutBusy) return;
    const current = generation.current;
    setBusyOrder(order.id); setOrdersLoading(false); setError(''); setNotice('');
    // Prevent an older order-list response from replacing the status mutation.
    orderSequence.current += 1;
    try {
      const result = await driverRequest<{ order: DriverTransportOrder }>(`/orders/${encodeURIComponent(order.id)}/status`, { status });
      if (current !== generation.current) return;
      orderSequence.current += 1;
      setOrders(list => list.map(entry => entry.id === result.order.id ? result.order : entry));
      setNotice(status === 'done' ? `${order.id} är markerat som klart.` : `${order.id}: du är på väg.`);
    } catch (caught) {
      if (current !== generation.current) return;
      if (caught instanceof DriverError && caught.status === 401) { clearSession(); setError('Logga in igen för att uppdatera uppdraget.'); }
      else { await refreshOrders(); setError(errorMessage(caught)); }
    } finally { if (current === generation.current) setBusyOrder(null); }
  };

  const updateLogistics = async (order: DriverTransportOrder, command: LogisticsDriverCommand) => {
    if (busyOrder || logoutBusy) return;
    const current = generation.current;
    setBusyOrder(order.id); setError(''); setNotice(''); orderSequence.current += 1;
    try {
      const result = await driverRequest<{ order: DriverTransportOrder }>(`/orders/${encodeURIComponent(order.id)}/logistics`, command);
      if (current !== generation.current) return;
      orderSequence.current += 1;
      setOrders(list => list.map(entry => entry.id === result.order.id ? result.order : entry));
      setNotice({ 'travel.empty': 'Du är på väg till lastningsplatsen.', arrive: 'Ankomst till lastningsplatsen registrerad.', load: 'Lastade vikter är sparade.', sign: 'Den aktuella dokumentversionen är godkänd i demo.', depart: 'Transport med last har påbörjats.', deliver: 'Leveransen är registrerad.' }[command.action]);
    } catch (caught) {
      if (current !== generation.current) return;
      if (caught instanceof DriverError && caught.status === 401) { clearSession(); setError('Logga in igen för att uppdatera uppdraget.'); }
      else { await refreshOrders(); setError(errorMessage(caught)); }
    } finally { if (current === generation.current) setBusyOrder(null); }
  };

  const activeOrders = orders.filter(order => !['done', 'cancelled'].includes(order.status));
  const history = orders.filter(order => ['done', 'cancelled'].includes(order.status));
  const shownOrders = [...(tab === 'active' ? activeOrders : history)].sort((a, b) => {
    const first = `${a.date || a.requestedDate || '9999-12-31'}:${(a.startMinute ?? 1440).toString().padStart(4, '0')}`;
    const second = `${b.date || b.requestedDate || '9999-12-31'}:${(b.startMinute ?? 1440).toString().padStart(4, '0')}`;
    return tab === 'history' ? second.localeCompare(first) : first.localeCompare(second);
  });

  return <div className="driver-app">
    <header className="driver-header"><img src="/images/jeroc-logo-v2.png" alt="JEROC Återvinning" /><span><Truck size={18} />Chaufför</span>{session && <button className="driver-logout" disabled={logoutBusy || Boolean(busyOrder)} onClick={() => void logout()} aria-label="Logga ut chaufför">{logoutBusy ? <LoaderCircle size={18} className="driver-spinner" /> : <LogOut size={18} />}</button>}</header>
    {loading ? <main className="driver-loading" role="status"><LoaderCircle className="driver-spinner" size={28} /><p>Öppnar chaufförsportalen…</p></main> : !session ? <main className="driver-login"><div className="driver-login-icon"><Truck size={30} /></div><span className="driver-eyebrow">CHAUFFÖRSPORTAL</span><h1>Dina uppdrag hos JEROC</h1><p>Logga in med ditt chaufförskonto.</p><form onSubmit={login}>
      <label htmlFor="driver-username">Inloggningsnamn</label><div className="driver-input"><UserRound size={18} /><input id="driver-username" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" required disabled={loginBusy} value={username} onChange={event => setUsername(event.target.value)} /></div>
      <label htmlFor="driver-password">Lösenord</label><div className="driver-input"><LockKeyhole size={18} /><input id="driver-password" name="password" type="password" autoComplete="current-password" required disabled={loginBusy} value={password} onChange={event => setPassword(event.target.value)} /></div>
      {error && <p className="driver-error" role="alert">{error}</p>}
      <button className="driver-button primary" disabled={loginBusy}>{loginBusy ? <><LoaderCircle className="driver-spinner" size={18} />Loggar in…</> : 'Logga in'}</button>
    </form><p className="driver-login-help">Ditt konto administreras av JEROC. <a href="/akeri">Logga in som åkeriets transportledare</a></p></main> : <main className="driver-main">
      <section className="driver-welcome"><div className="driver-avatar">{session.person.name.split(' ').filter(Boolean).map(part => part[0]).slice(0, 2).join('')}</div><div><span className="driver-eyebrow">{session.company.name}</span><h1>Hej, {session.person.name.split(' ')[0]}</h1><p>Här är dina tilldelade uppdrag.</p></div></section>
      <div className="driver-list-heading"><h2>Mina uppdrag</h2><button className="driver-refresh" disabled={ordersLoading || Boolean(busyOrder) || logoutBusy} onClick={() => void refreshOrders(true)} aria-label="Uppdatera uppdrag"><RefreshCw size={18} className={ordersLoading ? 'driver-spinner' : ''} /></button></div>
      <div className="driver-tabs" role="tablist" aria-label="Uppdrag"><button role="tab" id="driver-active-tab" aria-selected={tab === 'active'} aria-controls="driver-order-list" className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>Uppdrag{activeOrders.length > 0 && <span>{activeOrders.length}</span>}</button><button role="tab" id="driver-history-tab" aria-selected={tab === 'history'} aria-controls="driver-order-list" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Avslutade</button></div>
      {error && <p className="driver-error" role="alert">{error}</p>}{notice && <p className="driver-notice" role="status"><CheckCircle2 size={18} />{notice}</p>}
      <section id="driver-order-list" role="tabpanel" aria-labelledby={tab === 'active' ? 'driver-active-tab' : 'driver-history-tab'} className="driver-order-list" aria-busy={ordersLoading}>
        {ordersLoading && !orders.length ? <div className="driver-empty" role="status"><LoaderCircle className="driver-spinner" size={26} /><p>Hämtar uppdrag…</p></div> : shownOrders.length ? shownOrders.map(order => <DriverOrder key={order.id} order={order} open={openId === order.id} busy={busyOrder === order.id} disabled={Boolean(busyOrder) || logoutBusy} onToggle={() => setOpenId(current => current === order.id ? null : order.id)} onStatus={status => void updateStatus(order, status)} onLogistics={command => void updateLogistics(order, command)} />) : <div className="driver-empty">{tab === 'active' ? <ClipboardList size={34} /> : <Clock3 size={34} />}<h2>{tab === 'active' ? 'Inga tilldelade uppdrag' : 'Inga avslutade uppdrag'}</h2><p>{tab === 'active' ? 'Nya uppdrag visas här när JEROC har tilldelat dem till dig.' : 'Slutförda och avbrutna uppdrag visas här.'}</p></div>}
      </section>
    </main>}
    <footer className="driver-footer">JEROC · Chaufförsportal{session?.demo !== false && ' · Demo'}</footer>
  </div>;
}
