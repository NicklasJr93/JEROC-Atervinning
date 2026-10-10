import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Building2, CalendarDays, CheckCircle2, ChevronRight, Clock3, ClipboardList, Info, LoaderCircle, LockKeyhole, LogOut, MapPin, Package, Phone, RefreshCw, UserRound, X } from 'lucide-react';
import type { CustomerPortalRequest, CustomerPortalState, LogisticsAgreement, LogisticsCustomerRequest, LogisticsOrder, LogisticsVessel } from '../office/logistics/types';
import './customer.css';

interface CustomerSession { demo: boolean; customer: { id: string; name: string } }
interface RequestDialog { vessel: LogisticsVessel; type: CustomerPortalRequest['type']; order?: LogisticsOrder; idempotencyKey: string }
interface InformationDialog { title: string; subtitle: string; body: ReactNode }
class CustomerError extends Error { constructor(message: string, public status: number) { super(message); } }

async function customerRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/customer${path}`, {
    credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new CustomerError(result?.error || 'Kunde inte kontakta JEROC. Försök igen.', response.status);
  return result as T;
}

const message = (error: unknown) => error instanceof Error ? error.message : 'Något gick fel. Försök igen.';
const initials = (name: string) => name.split(' ').filter(Boolean).map(part => part[0]).slice(0, 2).join('');
const dayLabel = (day?: string) => {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'Tid enligt överenskommelse';
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return 'Datum behöver kompletteras';
  return new Intl.DateTimeFormat('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Stockholm' }).format(date);
};
const today = () => new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Europe/Stockholm' }).format(new Date());
const dayBefore = (day?: string) => { if (!day) return undefined; const stamp = new Date(`${day}T12:00:00Z`).getTime(); return Number.isNaN(stamp) ? undefined : new Date(stamp - 86400000).toISOString().slice(0, 10); };
const minuteLabel = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const orderDate = (order: LogisticsOrder) => order.detail.confirmedWindow?.date || order.date;
const orderTime = (order: LogisticsOrder) => {
  const window = order.detail.confirmedWindow;
  if (window?.from && window.to) return `${window.from}–${window.to}`;
  if (order.startMinute !== undefined) return `${minuteLabel(order.startMinute)}–${minuteLabel(order.startMinute + order.durationMinutes)}`;
  return '';
};
const orderLabel = (order: LogisticsOrder) => [dayLabel(orderDate(order)), orderTime(order)].filter(Boolean).join(' · ');
const placeLabel = (vessel: LogisticsVessel) => vessel.place?.name || 'Er plats';
const addressLabel = (vessel: LogisticsVessel) => [vessel.place?.address, [vessel.place?.postalCode, vessel.place?.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const agreementFor = (data: CustomerPortalState, vessel: LogisticsVessel) => data.agreements.find(agreement => agreement.active && agreement.vesselId === vessel.id);
const requestFor = (data: CustomerPortalState, vessel: LogisticsVessel) => data.requests.find(request => request.vesselId === vessel.id && request.status === 'pending');
const bookedFor = (data: CustomerPortalState, vessel: LogisticsVessel) => data.orders.filter(order => order.detail.vesselId === vessel.id && ['booked', 'on_way'].includes(order.status)).sort((a, b) => `${orderDate(a) || '9999'}`.localeCompare(`${orderDate(b) || '9999'}`))[0];
const materialFor = (data: CustomerPortalState, vessel: LogisticsVessel) => {
  const order = data.orders.find(item => item.detail.vesselId === vessel.id);
  return order?.material || order?.detail.materialRows.map(row => row.name).join(' & ') || 'Material enligt ert avtal';
};

function VesselIllustration({ type }: { type: LogisticsVessel['type'] }) {
  if (type === 'bin') return <svg className="customer-vessel" viewBox="0 0 270 170" aria-label="Illustration av ett hjulförsett kärl" role="img">
    <ellipse cx="137" cy="153" rx="81" ry="8" fill="#dde7f1" /><path d="m73 47 11 97c2 8 7 11 15 11h77c9 0 13-4 15-11l12-97" fill="#2178ac" stroke="#175f92" strokeWidth="2" /><path d="m83 49 11 89c1 4 3 6 7 6h72c4 0 6-2 7-6l11-89" fill="#298bc0" /><path d="M70 46h136v12H70Z" fill="#185e91" /><path d="M65 42c0-6 5-11 11-11h121c8 0 12 4 13 11l-1 5H65Z" fill="#526a7a" /><path d="M76 30h125l-8-8H85Z" fill="#708696" /><path d="M68 48v19m141-19v19" stroke="#1b5b87" strokeWidth="5" strokeLinecap="round" /><rect x="104" y="72" width="68" height="35" rx="3" fill="#f7fbff" /><text x="138" y="87" textAnchor="middle" fill="#236aaa" fontSize="10" fontWeight="700" fontFamily="Arial,sans-serif">JEROC</text><text x="138" y="99" textAnchor="middle" fill="#258551" fontSize="7" fontFamily="Arial,sans-serif">Återvinning</text><circle cx="96" cy="148" r="12" fill="#475867" /><circle cx="96" cy="148" r="5" fill="#7d8e9d" /><circle cx="179" cy="148" r="12" fill="#475867" /><circle cx="179" cy="148" r="5" fill="#7d8e9d" /><path d="M93 118h84" stroke="#1c72a6" strokeWidth="3" />
  </svg>;
  if (type === 'container') return <svg className="customer-vessel" viewBox="0 0 270 170" aria-label="Illustration av en skrotcontainer" role="img">
    <ellipse cx="136" cy="145" rx="112" ry="10" fill="#dde7f1" /><path d="m41 57 181-7 23 20-8 65-184 6-18-23Z" fill="#2478ac" stroke="#175f92" strokeWidth="2" /><path d="m41 57 181-7 23 20-183 9Z" fill="#b1c4d1" /><path d="m53 64 165-6 13 10-167 7Z" fill="#687e8e" /><path d="m62 79 183-9-8 65-184 6Z" fill="#2a8abe" /><path d="m41 57 21 22-9 62-18-23Z" fill="#1b679d" /><path d="m75 81-4 58m33-60-4 58m33-59-4 58m33-59-4 58m33-59-4 58m33-59-4 59" stroke="#1a6fa7" strokeWidth="5" /><rect x="118" y="89" width="53" height="25" rx="2" fill="#f7fbff" transform="rotate(-3 144 101)" /><text x="145" y="103" textAnchor="middle" fill="#236aaa" fontSize="9" fontWeight="700" fontFamily="Arial,sans-serif">JEROC</text><path d="m48 145 18-1m144-6 20-1" stroke="#526575" strokeWidth="8" strokeLinecap="round" />
  </svg>;
  return <div className="customer-vessel-generic"><Package size={76} strokeWidth={1.1} /><span>{type === 'battery' ? 'Batterilåda' : 'Materialbur'}</span></div>;
}

function Modal({ title, subtitle, children, onClose, busy }: { title: string; subtitle: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = dialog.current?.querySelector<HTMLElement>('input,button,textarea,select');
    first?.focus();
    return () => { document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, []);
  return <div className="customer-overlay" onClick={event => { if (!busy && event.target === event.currentTarget) onClose(); }}><section className="customer-modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="customer-dialog-title" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); closeRef.current(); }
    if (event.key !== 'Tab') return;
    const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]') || [])];
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><header className="customer-modal-heading"><div><h2 id="customer-dialog-title">{title}</h2><p>{subtitle}</p></div><button className="customer-icon-button" aria-label="Stäng dialog" disabled={busy} onClick={onClose}><X size={20} /></button></header>{children}</section></div>;
}

function VesselCard({ vessel, data, disabled, onRequest, onInformation }: { vessel: LogisticsVessel; data: CustomerPortalState; disabled: boolean; onRequest: (vessel: LogisticsVessel, type: CustomerPortalRequest['type'], order?: LogisticsOrder) => void; onInformation: (dialog: InformationDialog) => void }) {
  const agreement = agreementFor(data, vessel), pending = requestFor(data, vessel), booked = bookedFor(data, vessel);
  const canRequest = !!agreement && vessel.status === 'placed';
  const exchangeAlreadyBooked = booked?.action === 'exchange';
  const requestType = booked && booked.action === 'pickup' && booked.status === 'booked' ? 'earlier' : agreement?.action || 'pickup';
  const requestName = requestType === 'earlier' ? 'Önska tidigare hämtning' : requestType === 'exchange' ? 'Beställ byte' : 'Önska hämtning';
  const agreementTitle = agreement?.action === 'exchange' ? 'Rullande byte' : 'Avtalad hämtning';
  const showAgreement = (entry: LogisticsAgreement) => onInformation({ title: agreementTitle, subtitle: `${vessel.name} · ${vessel.id}`, body: <><p className="customer-info-text">{entry.notes || (entry.action === 'exchange' ? 'Vi hämtar det fulla kärlet och lämnar ett tomt enligt ert avtal.' : 'Hämtning sker enligt er överenskommelse med JEROC.')}</p>{entry.intervalDays > 0 && <p className="customer-info-text">Planerad intervall: {entry.intervalDays} dagar.</p>}<div className="customer-request-notice"><Info size={18} /><span>Kontakta JEROC om ni behöver ändra omfattning eller material i avtalet.</span></div></> });
  return <article className="customer-asset-card" data-vessel-id={vessel.id} data-testid={`customer-vessel-${vessel.id}`}>
    <div className="customer-asset-heading"><span className="customer-asset-id">{vessel.id}</span><span className={`customer-pill ${pending ? 'amber' : booked ? 'blue' : 'green'}`}>{pending ? 'Önskemål skickat' : booked ? booked.status === 'on_way' ? 'På väg' : 'Hämtning bokad' : 'Utställt'}</span></div>
    <div className="customer-vessel-area"><VesselIllustration type={vessel.type} />{vessel.size && <span className="customer-vessel-size">{vessel.size}</span>}</div>
    <div className="customer-asset-main"><div className="customer-asset-title"><div><h2>{vessel.name}</h2><p>{materialFor(data, vessel)}</p></div><span className="customer-material-icon">{vessel.type === 'bin' ? <RefreshCw size={22} /> : <Package size={22} />}</span></div>
      <div className="customer-asset-place"><MapPin size={17} /><div><strong>{placeLabel(vessel)}</strong><span>{addressLabel(vessel) || 'Plats behöver kompletteras av JEROC'}</span></div></div>
      {agreement ? <div className="customer-agreement"><span className="customer-agreement-icon"><RefreshCw size={17} /></span><div><strong>{agreementTitle}</strong><small>{agreement.action === 'exchange' ? 'Fullt kärl byts mot ett tomt' : 'Enligt er överenskommelse'}</small></div><button className="customer-text-button" onClick={() => showAgreement(agreement)}>Avtal<ChevronRight size={15} /></button></div> : <div className="customer-agreement no-agreement"><Info size={17} /><small>Kontakta JEROC för att planera nästa åtgärd.</small></div>}
      <div className="customer-next-action"><span>{booked ? 'NÄSTA PLANERADE ÅTGÄRD' : 'NÄSTA BYTE / HÄMTNING'}</span><strong>{booked ? orderLabel(booked) : agreement?.nextDate ? dayLabel(agreement.nextDate) : agreement?.action === 'exchange' ? 'Byte när kärlet är fullt' : 'Enligt överenskommelse'}</strong><small>{booked ? `${booked.action === 'exchange' ? 'Byte' : 'Hämtning'} · ${booked.id} · Tid planerad av JEROC` : 'Önskat datum är inte en bekräftad bokning.'}</small></div>
      {pending && <div className="customer-request-inline"><Clock3 size={17} /><div><strong>{pending.type === 'earlier' ? 'Tidigare hämtning önskad' : pending.type === 'exchange' ? 'Önskemål om byte skickat' : 'Önskemål om hämtning skickat'}</strong><small>{pending.requestedDate ? `Önskad dag: ${dayLabel(pending.requestedDate)} · ` : ''}Inväntar JEROC</small></div></div>}
      <div className="customer-asset-actions"><button className={`customer-button${requestType === 'exchange' ? ' primary' : ''}`} disabled={disabled || !!pending || !canRequest || exchangeAlreadyBooked || booked?.status === 'on_way'} onClick={() => onRequest(vessel, requestType, requestType === 'earlier' ? booked : undefined)}>{requestType === 'exchange' ? <RefreshCw size={16} /> : <CalendarDays size={16} />}{pending ? 'Önskemål redan skickat' : exchangeAlreadyBooked ? 'Byte redan planerat' : requestName}</button>{pending && <button className="customer-text-button" onClick={() => onInformation(requestInformation(pending, vessel, booked))}>Visa önskemål<ChevronRight size={15} /></button>}</div>
    </div>
  </article>;
}

function requestInformation(request: LogisticsCustomerRequest, vessel: LogisticsVessel, booked?: LogisticsOrder): InformationDialog {
  return { title: 'Ditt önskemål', subtitle: `${vessel.name} · ${vessel.id}`, body: <><div className="customer-request-info"><div><span>Arbetsorder</span><strong>{request.orderId}</strong></div><div><span>Önskad dag</span><strong>{dayLabel(request.requestedDate)}</strong></div>{booked && <div><span>Nuvarande bokning</span><strong>{orderLabel(booked)}</strong></div>}{request.comment && <div><span>Kommentar</span><p>{request.comment}</p></div>}</div><div className="customer-request-notice"><Info size={18} /><span>JEROC återkommer med tid. {booked ? 'Den nuvarande bokningen gäller tills en ny tid bekräftats.' : 'Ni behöver inte skapa en till förfrågan.'}</span></div></> };
}

export default function CustomerApp() {
  const [session, setSession] = useState<CustomerSession | null>(null);
  const [data, setData] = useState<CustomerPortalState | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false), [logoutBusy, setLogoutBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'vessels' | 'requests'>('vessels');
  const [place, setPlace] = useState('all');
  const [dialog, setDialog] = useState<RequestDialog | null>(null), [information, setInformation] = useState<InformationDialog | null>(null);
  const [requestedDate, setRequestedDate] = useState(''), [comment, setComment] = useState('');
  const [requestBusy, setRequestBusy] = useState(false), [requestError, setRequestError] = useState('');
  const generation = useRef(0), readSequence = useRef(0), submitting = useRef(false);

  const clearSession = useCallback(() => {
    generation.current += 1; readSequence.current += 1;
    setSession(null); setData(null); setDialog(null); setInformation(null); setNotice(''); setDataLoading(false); setPlace('all');
  }, []);
  const handleUnauthorized = useCallback((caught: unknown) => {
    if (caught instanceof CustomerError && caught.status === 401) { clearSession(); setError('Logga in igen för att se era kärl och önskemål.'); return true; }
    return false;
  }, [clearSession]);
  const refresh = useCallback(async (showLoading = false) => {
    const current = generation.current, sequence = ++readSequence.current;
    if (showLoading) setDataLoading(true);
    try {
      const result = await customerRequest<CustomerPortalState>('/state');
      if (current !== generation.current || sequence !== readSequence.current) return;
      setData(result); setError('');
    } catch (caught) {
      if (current !== generation.current || sequence !== readSequence.current) return;
      if (!handleUnauthorized(caught)) setError(message(caught));
    } finally { if (current === generation.current && sequence === readSequence.current) setDataLoading(false); }
  }, [handleUnauthorized]);
  useEffect(() => {
    const current = generation.current;
    void customerRequest<CustomerSession>('/session').then(result => { if (current === generation.current) setSession(result); }).catch(caught => {
      if (current === generation.current && !(caught instanceof CustomerError && caught.status === 401)) setError(message(caught));
    }).finally(() => { if (current === generation.current) setInitializing(false); });
    return () => { generation.current += 1; readSequence.current += 1; };
  }, []);
  useEffect(() => {
    if (!session) return;
    void refresh(true);
    const onRefresh = () => { if (!document.hidden && !submitting.current) void refresh(); };
    const timer = window.setInterval(onRefresh, 30_000);
    window.addEventListener('online', onRefresh); document.addEventListener('visibilitychange', onRefresh);
    return () => { window.clearInterval(timer); window.removeEventListener('online', onRefresh); document.removeEventListener('visibilitychange', onRefresh); };
  }, [session, refresh]);
  const login = async (event: FormEvent) => {
    event.preventDefault(); if (loginBusy) return;
    const current = ++generation.current;
    setLoginBusy(true); setError('');
    try {
      const result = await customerRequest<CustomerSession>('/login', { username: username.trim(), password });
      if (current !== generation.current) return;
      setSession(result); setPassword(''); setNotice('');
    } catch (caught) { if (current === generation.current) setError(message(caught)); }
    finally { if (current === generation.current) setLoginBusy(false); }
  };
  const logout = async () => {
    if (logoutBusy || requestBusy) return;
    setLogoutBusy(true); setError('');
    try { await customerRequest('/logout', {}); clearSession(); }
    catch (caught) { if (!handleUnauthorized(caught)) setError(message(caught)); }
    finally { setLogoutBusy(false); }
  };
  const openRequest = (vessel: LogisticsVessel, type: CustomerPortalRequest['type'], order?: LogisticsOrder) => {
    if (!data || requestFor(data, vessel)) return;
    setDialog({ vessel, type, order, idempotencyKey: crypto.randomUUID() });
    setRequestedDate(''); setComment(''); setRequestError(''); setNotice('');
  };
  const submitRequest = async (event: FormEvent) => {
    event.preventDefault(); if (!dialog || submitting.current || !data) return;
    if (requestFor(data, dialog.vessel)) { setRequestError('Ett önskemål för detta kärl finns redan hos JEROC.'); return; }
    if (!requestedDate || requestedDate < today() || (dialog.type === 'earlier' && dialog.order && requestedDate >= (orderDate(dialog.order) || '9999-12-31'))) { setRequestError(dialog.type === 'earlier' ? 'Välj en tidigare dag än den bokade hämtningen.' : 'Välj önskad dag, idag eller senare.'); return; }
    const current = generation.current;
    submitting.current = true; setRequestBusy(true); setRequestError(''); readSequence.current += 1;
    const input: CustomerPortalRequest = { vesselId: dialog.vessel.id, type: dialog.type, requestedDate, comment: comment.trim(), existingOrderId: dialog.type === 'earlier' ? dialog.order?.id : undefined, idempotencyKey: dialog.idempotencyKey };
    try {
      const result = await customerRequest<CustomerPortalState & { request: LogisticsCustomerRequest }>('/requests', input);
      if (current !== generation.current) return;
      readSequence.current += 1; setData(result); setDialog(null);
      setNotice('Önskemålet är sparat hos JEROC. Tid är ännu inte bekräftad.');
    } catch (caught) {
      if (current !== generation.current) return;
      if (!handleUnauthorized(caught)) { setRequestError(message(caught)); if (caught instanceof CustomerError && caught.status === 409) await refresh(); }
    } finally { submitting.current = false; setRequestBusy(false); }
  };
  const customerName = session?.customer.name || '';
  const vessels = data?.vessels.filter(vessel => vessel.active && vessel.status === 'placed') || [];
  const places = [...new Set(vessels.map(vessel => placeLabel(vessel)))];
  const shownVessels = vessels.filter(vessel => place === 'all' || placeLabel(vessel) === place);
  const requests = data?.requests || [];
  const pendingCount = requests.filter(request => request.status === 'pending').length;
  const plannedCount = data?.orders.filter(order => ['booked', 'on_way'].includes(order.status)).length || 0;
  const disabled = requestBusy || logoutBusy;
  const requestTypeLabel = (type: LogisticsCustomerRequest['type']) => type === 'exchange' ? 'Byte av kärl' : type === 'earlier' ? 'Tidigare hämtning' : 'Hämtning';

  if (initializing) return <div className="customer-app customer-initializing" role="status"><LoaderCircle size={28} className="customer-spinner" /><p>Öppnar kundportalen…</p></div>;
  if (!session) return <div className="customer-app"><main className="customer-login-page"><div className="customer-login-shell"><section className="customer-login-intro"><img src="/images/jeroc-logo-v2.png" alt="JEROC Återvinning" /><span className="customer-login-eyebrow">VÄLKOMMEN TILL KUNDPORTALEN</span><h1>Ditt skrot.<br />Enklare att hantera.</h1><p>Håll koll på era kärl och containrar. Beställ byte och se planerade hämtningar på samma ställe.</p><div className="customer-login-illustrations"><div><VesselIllustration type="bin" /></div><div><VesselIllustration type="container" /></div></div><div className="customer-login-feature"><RefreshCw size={20} /><span>Beställ byte när kärlet är fullt</span></div><div className="customer-login-feature"><CalendarDays size={20} /><span>Se planerade hämtningar och önska en annan dag</span></div><div className="customer-login-feature"><Building2 size={20} /><span>Samlad översikt för ert företag</span></div></section><form className="customer-login-form" onSubmit={login}><div className="customer-login-mobile-logo"><img src="/images/jeroc-logo-v2.png" alt="JEROC Återvinning" /></div><div className="customer-eyebrow">KUNDINLOGGNING</div><h2>Logga in</h2><p>Välkommen tillbaka till JEROC.</p><label className="customer-field" htmlFor="customer-username">Inloggningsnamn<div className="customer-input"><UserRound size={17} /><input id="customer-username" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" required disabled={loginBusy} value={username} onChange={event => setUsername(event.target.value)} /></div></label><label className="customer-field" htmlFor="customer-password">Lösenord<div className="customer-input"><LockKeyhole size={17} /><input id="customer-password" name="password" type="password" autoComplete="current-password" required disabled={loginBusy} value={password} onChange={event => setPassword(event.target.value)} /></div></label>{error && <p className="customer-error" role="alert">{error}</p>}<button className="customer-button primary" disabled={loginBusy}>{loginBusy ? <><LoaderCircle size={17} className="customer-spinner" />Loggar in…</> : <>Logga in<ArrowRight size={17} /></>}</button><div className="customer-login-access"><strong>Saknar ni ett konto?</strong><p>JEROC hjälper er att komma igång med kundportalen.</p></div><div className="customer-login-demo-note"><Info size={17} /><span>Kundportalen är en demo. Kontot och era önskemål hanteras av JEROC.</span></div></form></div><p className="customer-login-footer">JEROC Återvinning · Kundportal</p></main></div>;

  return <div className="customer-app"><aside className="customer-sidebar"><img className="customer-logo" src="/images/jeroc-logo-v2.png" alt="JEROC Återvinning" /><div className="customer-eyebrow">KUNDPORTAL</div><nav aria-label="Kundportal"><button className={tab === 'vessels' ? 'active' : ''} onClick={() => setTab('vessels')}><Package size={20} /><span>Kärl & containrar</span></button><button className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}><ClipboardList size={20} /><span>Mina önskemål</span>{pendingCount > 0 && <small>{pendingCount}</small>}</button></nav><div className="customer-sidebar-bottom"><div className="customer-signed-in"><span className="customer-avatar">{initials(customerName)}</span><span><strong>{customerName}</strong><small>Kundkonto</small></span></div><button className="customer-text-button" onClick={() => void logout()} disabled={disabled || logoutBusy}>{logoutBusy ? <LoaderCircle size={16} className="customer-spinner" /> : <LogOut size={16} />}Logga ut</button>{session.demo && <small>JEROC · Demo · Fiktiva uppgifter</small>}</div></aside><div className="customer-workspace"><header className="customer-topbar"><img src="/images/jeroc-logo-v2.png" alt="JEROC Återvinning" className="customer-mobile-logo" /><span>Kundportalen<ChevronRight size={14} />{tab === 'vessels' ? 'Kärl & containrar' : 'Mina önskemål'}</span><button className="customer-icon-button" aria-label="Uppdatera kundportalen" disabled={dataLoading || disabled} onClick={() => void refresh(true)}><RefreshCw size={18} className={dataLoading ? 'customer-spinner' : ''} /></button><button className="customer-mobile-logout customer-icon-button" aria-label="Logga ut" onClick={() => void logout()} disabled={disabled}><LogOut size={18} /></button></header>{session.demo && <div className="customer-demo-bar">Demo · Önskemål sparas gemensamt hos JEROC · Ingen automatisk avisering skickas</div>}<main className="customer-main"><div className="customer-page-heading"><div><div className="customer-eyebrow">KUNDPORTAL · {customerName}</div><h1>{tab === 'vessels' ? 'Era kärl & containrar' : 'Mina önskemål'}</h1><p>{tab === 'vessels' ? 'Se vad ni har utställt och beställ nästa byte eller hämtning.' : 'Följ era förfrågningar. Önskade datum är inte bekräftade bokningar.'}</p></div><div className="customer-account-select"><Building2 size={18} /><label><small>Företag</small><select aria-label="Ditt företag"><option>{customerName}</option></select></label></div></div>{error && <p className="customer-error" role="alert">{error}</p>}{notice && <p className="customer-notice" role="status"><CheckCircle2 size={18} />{notice}</p>}
      {dataLoading && !data ? <div className="customer-empty" role="status"><LoaderCircle size={28} className="customer-spinner" /><p>Hämtar era kärl och önskemål…</p></div> : data ? tab === 'vessels' ? <><section className="customer-overview-strip" aria-label="Översikt"><div><strong>{vessels.length}</strong><span>Utställda kärl & containrar</span></div><div><strong>{plannedCount}</strong><span>Planerade uppdrag</span></div><div><strong>{pendingCount}</strong><span>Önskemål hos JEROC</span></div></section><div className="customer-assets-toolbar"><h2>Dina utställda</h2><label><MapPin size={15} /><select aria-label="Filtrera plats" value={place} onChange={event => setPlace(event.target.value)}><option value="all">Alla platser</option>{places.map(entry => <option key={entry}>{entry}</option>)}</select></label></div><div className="customer-assets-grid">{shownVessels.map(vessel => <VesselCard key={vessel.id} vessel={vessel} data={data} disabled={disabled} onRequest={openRequest} onInformation={setInformation} />)}</div>{!shownVessels.length && <div className="customer-empty"><Package size={36} /><h2>Inga utställda kärl här</h2><p>JEROC hjälper er att registrera och planera era kärl och containrar.</p></div>}<div className="customer-help-strip"><div><Phone size={19} /><span><strong>Behöver ni hjälp med ert kärl?</strong><small>Kontakta JEROC om avtal, material eller planerad hämtning.</small></span></div></div></> : <section className="customer-panel customer-requests-panel"><div className="customer-panel-heading"><h2><Clock3 size={19} />Dina önskemål</h2><span className="customer-pill grey">JEROC planerar</span></div>{[...requests].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(request => <div className="customer-request-row" key={request.id}><div><strong>{requestTypeLabel(request.type)}</strong><small>{request.vesselId} · {request.orderId}</small>{request.comment && <p>{request.comment}</p>}</div><div><span>Önskad dag</span><strong>{dayLabel(request.requestedDate)}</strong></div><span className={`customer-pill ${request.status === 'pending' ? 'amber' : request.status === 'accepted' ? 'green' : 'grey'}`}>{request.status === 'pending' ? 'Inväntar planering' : request.status === 'accepted' ? 'Hanterat av JEROC' : 'Avböjt'}</span>{request.response && <p className="customer-request-response">{request.response}</p>}</div>)}{!requests.length && <div className="customer-empty"><ClipboardList size={32} /><h2>Inga önskemål ännu</h2><p>Önskemål om byte och hämtning visas här när ni skickat dem.</p></div>}<p className="customer-requests-note"><Info size={15} />Önskad dag är inte en bekräftad tid. JEROC återkommer när det är planerat.</p></section> : <div className="customer-empty"><p>Kunduppgifterna kunde inte hämtas.</p><button className="customer-button" onClick={() => void refresh(true)}>Försök igen</button></div>}
    </main><div className="customer-mobile-tabs"><button className={tab === 'vessels' ? 'active' : ''} onClick={() => setTab('vessels')}><Package size={19} />Kärl & containrar</button><button className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}><ClipboardList size={19} />Mina önskemål{pendingCount > 0 && <small>{pendingCount}</small>}</button></div></div>
    {dialog && <Modal title={dialog.type === 'exchange' ? 'Beställ byte av kärl' : dialog.type === 'earlier' ? 'Önska tidigare hämtning' : 'Önska hämtning'} subtitle={dialog.type === 'exchange' ? 'Vi hämtar det fulla kärlet och lämnar ett tomt.' : dialog.type === 'earlier' ? 'Önskemålet kopplas till er redan planerade hämtning.' : 'JEROC återkommer med planerad tid.'} onClose={() => setDialog(null)} busy={requestBusy}><form onSubmit={submitRequest}><div className="customer-modal-asset"><div><VesselIllustration type={dialog.vessel.type} /></div><span><strong>{dialog.vessel.name} · {dialog.vessel.size}</strong><small>{dialog.vessel.id} · {customerName}</small><small>{addressLabel(dialog.vessel)}</small></span></div>{dialog.order && <div className="customer-existing-booking"><CalendarDays size={17} /><div><span>Nuvarande bokning · {dialog.order.id}</span><strong>{orderLabel(dialog.order)}</strong><small>Denna bokning gäller tills JEROC bekräftat en ändring.</small></div></div>}<div className="customer-request-form"><label className="customer-field" htmlFor="customer-request-date">Önskad dag<input id="customer-request-date" type="date" required min={today()} max={dialog.type === 'earlier' && dialog.order ? dayBefore(orderDate(dialog.order)) : undefined} value={requestedDate} disabled={requestBusy} onChange={event => setRequestedDate(event.target.value)} /><small>Önskemål · JEROC återkommer med planerad tid.</small></label><label className="customer-field" htmlFor="customer-request-comment">Kommentar (valfri)<textarea id="customer-request-comment" rows={3} maxLength={1000} placeholder="Till exempel när ni finns på plats eller var kärlet står" value={comment} disabled={requestBusy} onChange={event => setComment(event.target.value)} /></label></div><div className="customer-request-notice"><Info size={18} /><span>{dialog.type === 'earlier' ? 'Vi försöker ordna en tidigare hämtning. Er befintliga bokning ändras inte automatiskt.' : 'Önskad dag är inte en bekräftad tid. JEROC återkommer när uppdraget är planerat.'}</span></div>{requestError && <p className="customer-error" role="alert">{requestError}</p>}<div className="customer-modal-actions"><button type="button" className="customer-button" disabled={requestBusy} onClick={() => setDialog(null)}>Avbryt</button><button className="customer-button primary" disabled={requestBusy}>{requestBusy ? <><LoaderCircle size={17} className="customer-spinner" />Sparar…</> : 'Skicka önskemål'}</button></div></form></Modal>}
    {information && <Modal title={information.title} subtitle={information.subtitle} onClose={() => setInformation(null)}>{information.body}<div className="customer-modal-actions"><button className="customer-button primary" onClick={() => setInformation(null)}>Stäng</button></div></Modal>}
  </div>;
}
