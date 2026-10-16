import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowUpRight, Building2, Check, ChevronDown, Database, FlaskConical, Fuel, Gauge, House,
  LoaderCircle, MapPin, Milestone, Pause, Play, Power, RefreshCw, RotateCcw,
  Server, Signal, Square, Thermometer, UserRound, Warehouse, WifiOff, X,
} from 'lucide-react';
import { TestCarMap } from './TestCarMap';
import TestCarFleetLink from './TestCarFleetLink';
import { currentPlaceName, isTestCarSnapshot, readTestCarReceiver, type PlaceId, type TestCarAction, type TestCarCommand, type TestCarSnapshot, type TimeScale } from './types';
import './testcar.css';

const number = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const clock = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' });
const fullClock = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const recordDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short' });
type ResponseData = { car?: unknown; csrfToken?: unknown };
class RequestError extends Error { constructor(public status: number) { super('Testbilen svarade inte som väntat'); } }

function useTestCar() {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [car, setCar] = useState<TestCarSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const [commandError, setCommandError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<TestCarAction | null>(null);
  const carRef = useRef<TestCarSnapshot | null>(null);
  const token = useRef<string | null>(null);
  const live = useRef(false);
  const epoch = useRef(0);
  const commandBusy = useRef(false);
  const active = useRef<{ kind: 'session' | 'poll' | 'command'; controller: AbortController } | null>(null);

  const request = useCallback(async (path: string, kind: 'session' | 'poll' | 'command', init: RequestInit = {}) => {
    const operation = { kind, controller: new AbortController() };
    active.current = operation;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; operation.controller.abort(); }, 10_000);
    try {
      const response = await fetch(`/api/testcar/${path}`, {
        credentials: 'same-origin', cache: 'no-store', ...init, signal: operation.controller.signal,
      });
      if (!response.ok) throw new RequestError(response.status);
      return await response.json() as ResponseData;
    } catch (error) {
      if (timedOut) throw new Error('Testbilen svarade inte i tid');
      throw error;
    } finally {
      window.clearTimeout(timeout);
      if (active.current === operation) active.current = null;
    }
  }, []);

  const acceptCar = useCallback((value: unknown, force = false) => {
    if (!isTestCarSnapshot(value)) throw new Error('Testbilen skickade ett ofullständigt läge');
    if (!force && carRef.current && value.revision < carRef.current.revision) return;
    carRef.current = value;
    setCar(value);
  }, []);

  const bootstrap = useCallback(async (expired = false) => {
    if (active.current?.kind === 'session') return;
    active.current?.controller.abort();
    const generation = ++epoch.current;
    token.current = null;
    setCsrfToken(null);
    setLoading(true);
    setLoadError(false);
    try {
      const data = await request('session', 'session');
      if (!live.current || generation !== epoch.current) return;
      if (typeof data.csrfToken !== 'string' || !data.csrfToken) throw new Error('Testsession saknas');
      acceptCar(data.car, true);
      token.current = data.csrfToken;
      setCsrfToken(data.csrfToken);
      setSyncError(false);
      if (expired) setNotice('Testsessionen hade gått ut. En ny testbil är klar att använda.');
    } catch (error) {
      if (!live.current || generation !== epoch.current || (error instanceof Error && error.name === 'AbortError')) return;
      setLoadError(true);
      setSyncError(!!carRef.current);
    } finally {
      if (live.current && generation === epoch.current) setLoading(false);
    }
  }, [acceptCar, request]);

  const poll = useCallback(async () => {
    if (!live.current || document.visibilityState !== 'visible' || active.current || !token.current) return;
    const generation = epoch.current;
    try {
      const data = await request('state', 'poll');
      if (!live.current || generation !== epoch.current) return;
      acceptCar(data.car);
      setSyncError(false);
    } catch (error) {
      if (!live.current || generation !== epoch.current || (error instanceof Error && error.name === 'AbortError')) return;
      if (error instanceof RequestError && error.status === 401) await bootstrap(true);
      else setSyncError(true);
    }
  }, [acceptCar, bootstrap, request]);

  useEffect(() => {
    live.current = true;
    void bootstrap();
    const timer = window.setInterval(() => { void poll(); }, 1000);
    const visible = () => {
      if (document.visibilityState === 'visible') void poll();
      else if (active.current?.kind === 'poll') active.current.controller.abort();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      live.current = false;
      epoch.current += 1;
      active.current?.controller.abort();
      active.current = null;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [bootstrap, poll]);

  const command = useCallback(async (value: TestCarCommand) => {
    if (commandBusy.current || !token.current || !carRef.current || active.current?.kind === 'session') return false;
    commandBusy.current = true;
    setBusy(value.action);
    setCommandError('');
    setNotice('');
    active.current?.controller.abort();
    const generation = epoch.current;
    let succeeded = false;
    try {
      const data = await request('command', 'command', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-testcar-csrf': token.current },
        body: JSON.stringify(value),
      });
      if (!live.current || generation !== epoch.current) return false;
      acceptCar(data.car);
      setSyncError(false);
      succeeded = true;
    } catch (error) {
      if (!live.current || generation !== epoch.current || (error instanceof Error && error.name === 'AbortError')) return false;
      if (error instanceof RequestError && error.status === 401) {
        await bootstrap(true);
        if (live.current) setCommandError('Åtgärden skickades inte på nytt. Kontrollera det nya läget och välj igen.');
      } else if (error instanceof RequestError && [400, 409, 422].includes(error.status)) {
        setCommandError('Bilens läge har ändrats. Kontrollera aktuell plats och välj åtgärden igen.');
      } else {
        setCommandError('Vi kunde inte bekräfta åtgärden. Kontrollera bilens läge innan du försöker igen.');
      }
    } finally {
      commandBusy.current = false;
      if (live.current) {
        setBusy(null);
        // Read the resulting state; an uncertain command is never repeated.
        void poll();
      }
    }
    return succeeded;
  }, [acceptCar, bootstrap, poll, request]);

  const refresh = () => { if (!carRef.current || loadError) void bootstrap(); else void poll(); };
  return { car, csrfToken, loading, loadError, syncError, commandError, notice, busy, command, refresh,
    dismissNotice: () => setNotice(''), dismissError: () => setCommandError('') };
}

function PageHeader() {
  return <header className="testcar-header"><div className="testcar-header-inner">
    <a href="/" className="testcar-brand" aria-label="ScrapPilot startsida"><img src="/images/scrappilot-logo.png" alt="ScrapPilot" width="174" height="40" /></a>
    <div className="testcar-breadcrumb"><span>Labbet</span><span aria-hidden="true">/</span><strong>Testbil 01</strong></div>
    <div className="testcar-header-actions"><span className="testcar-badge testcar-test-badge"><FlaskConical size={17} />Endast testdata</span><a href="/" className="testcar-back-link">Till ScrapPilot <ArrowUpRight size={15} /></a></div>
  </div></header>;
}

function VanIllustration({ engineOn }: { engineOn: boolean }) {
  const [imageLoaded, setImageLoaded] = useState(false);
  return <div className={`testcar-van${engineOn ? ' is-running' : ''}`}>
    <svg className="testcar-van-scene" viewBox="0 0 400 205" aria-hidden="true"><path d="M0 0h400v205H0z" fill="#f0f8fd" /><path d="M0 116 55 98 130 109 240 89 330 107 400 87v118H0z" fill="#dcece5" /><path d="M0 150 400 133v72H0z" fill="#d0dce6" /><path d="m0 183 400-29" stroke="#fff" strokeWidth="3" strokeDasharray="50 34" /><g fill="#b8d4c5"><path d="m30 59-17 48h34zM363 40l-21 67h42zM331 73l-13 42h26z" /></g><path d="M30 105v32m333-37v28m-32-19v28" stroke="#96b9a9" strokeWidth="4" /></svg>
    {!imageLoaded && <svg className="testcar-van-fallback" viewBox="0 0 400 220" aria-hidden="true"><ellipse cx="207" cy="178" rx="137" ry="16" fill="#a6b8c6" opacity=".4" /><path d="m63 145 13-42 39-35h168q26 0 34 28l12 52-12 17H70Z" fill="#fff" stroke="#b0c2d1" strokeWidth="2" /><path d="M111 75h41v43H79Z" fill="#315b78" /><path d="M160 76h30v41h-30z" fill="#51758d" /><path d="m67 138 257-10 6 23-12 14H70Z" fill="#0079d7" /><path d="m189 122 126-28 6 14-132 28z" fill="#21ad62" /><path d="M193 77h90q18 0 24 19l-114 27z" fill="#f4f9fd" /><path d="M193 77v60m-41-14v30" stroke="#c2d1dd" strokeWidth="2" /><rect x="168" y="123" width="12" height="4" rx="2" fill="#45647c" /><rect x="72" y="127" width="26" height="8" rx="3" fill={engineOn ? '#fff1a6' : '#e1e8ed'} /><path d="M64 147h39v13H69Z" fill="#18394e" /><circle cx="123" cy="165" r="24" fill="#203649" /><circle cx="123" cy="165" r="13" fill="#d9e4ec" /><circle cx="283" cy="165" r="24" fill="#203649" /><circle cx="283" cy="165" r="13" fill="#d9e4ec" /><text x="203" y="107" fontSize="17" fontFamily="system-ui,sans-serif" fontWeight="800" fill="#07589b">ScrapPilot</text></svg>}
    <img className={`testcar-van-image${imageLoaded ? ' is-loaded' : ''}`} src="/images/testcar-van.png" alt="Blå och vit ScrapPilot-transportbil" onLoad={() => setImageLoaded(true)} onError={() => setImageLoaded(false)} />
    <span className="testcar-van-caption"><span className={`testcar-status-dot${engineOn ? ' is-moving' : ''}`} />{engineOn ? 'Redo att rulla' : 'Din egen lilla testbil'}</span>
  </div>;
}

function Speedometer({ speed }: { speed: number }) {
  const shownSpeed = Math.max(0, Math.round(speed));
  const progress = Math.min(120, shownSpeed) / 120;
  const angle = Math.PI + progress * Math.PI;
  const point = (radius: number) => ({ x: 160 + Math.cos(angle) * radius, y: 174 + Math.sin(angle) * radius });
  const tip = point(122); const base = point(78);
  return <div className="testcar-speedometer" role="img" aria-label={`Hastighet ${shownSpeed} kilometer i timmen`}>
    <svg viewBox="0 0 320 215" aria-hidden="true">
      <path d="M24 174a136 136 0 0 1 272 0" stroke="#e4edf5" strokeWidth="17" fill="none" />
      <path d="M24 174a136 136 0 0 1 272 0" stroke="#087de8" strokeWidth="17" fill="none" strokeDasharray={`${Math.PI * 136 * progress} ${Math.PI * 136}`} />
      {Array.from({ length: 13 }, (_, index) => {
        const theta = Math.PI + index / 12 * Math.PI;
        const outer = { x: 160 + Math.cos(theta) * 145, y: 174 + Math.sin(theta) * 145 };
        const inner = { x: 160 + Math.cos(theta) * 124, y: 174 + Math.sin(theta) * 124 };
        const text = { x: 160 + Math.cos(theta) * 108, y: 174 + Math.sin(theta) * 108 };
        return <g key={index}><line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke="#fff" strokeWidth={index % 2 === 0 ? 2 : 1} />{index % 2 === 0 && <text x={text.x} y={text.y + 4} textAnchor="middle" fill="#536b86" fontSize="12">{index * 10}</text>}</g>;
      })}
      <line x1={base.x} y1={base.y} x2={tip.x} y2={tip.y} stroke="#064e9b" strokeWidth="6" strokeLinecap="round" />
      <text x="160" y="158" textAnchor="middle" className="testcar-speed-number">{number.format(shownSpeed)}</text>
      <text x="160" y="183" textAnchor="middle" className="testcar-speed-unit">km/h</text>
    </svg>
  </div>;
}

function SpeedHistory({ car }: { car: TestCarSnapshot }) {
  const cutoff = Date.parse(car.simulatedAt) - 60_000;
  const history = car.speedHistory.filter(item => Date.parse(item.at) >= cutoff).slice(-60);
  const values = history.length > 1 ? history.map(item => item.value) : [car.telemetry.speedKmh, car.telemetry.speedKmh];
  const points = values.map((value, index) => `${28 + index / Math.max(1, values.length - 1) * 268},${82 - Math.max(0, Math.min(100, value)) / 100 * 67}`).join(' ');
  return <div className="testcar-history"><h3>Senaste minuten</h3><svg viewBox="0 0 304 95" role="img" aria-label="Hastigheten under den senaste simulerade minuten">
    <defs><linearGradient id="testcar-speed-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#83c4ff" stopOpacity=".45" /><stop offset="1" stopColor="#83c4ff" stopOpacity=".05" /></linearGradient></defs>
    {[0, 40, 80].map(value => <g key={value}><line x1="28" x2="296" y1={82 - value / 100 * 67} y2={82 - value / 100 * 67} stroke="#e2eaf2" /><text x="3" y={85 - value / 100 * 67} fontSize="10" fill="#7b8ca3">{value}</text></g>)}
    <polygon points={`28,82 ${points} 296,82`} fill="url(#testcar-speed-fill)" /><polyline points={points} fill="none" stroke="#087df0" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
  </svg><p>Simulerad tid <time dateTime={car.simulatedAt}>{fullClock.format(new Date(car.simulatedAt))}</time></p></div>;
}

function ReceiverCard({ car }: { car: TestCarSnapshot }) {
  const legacy = car.receiver === undefined;
  const receiver = readTestCarReceiver(car.receiver);
  const unavailable = receiver?.status === 'unavailable';
  const unknown = !legacy && (!receiver || receiver.status === 'unknown');
  const waiting = !legacy && car.stats.pendingRecords > 0;
  const separate = receiver?.channel === 'separate_http';
  const lastReceivedAt = receiver?.lastReceivedAt ?? (legacy ? car.stats.lastReceivedAt : null);
  const records = receiver?.recentRecords.length ? receiver.recentRecords : receiver?.lastRecord ? [receiver.lastRecord] : [];
  const storageName = receiver?.storage === 'sqlite' ? 'SQLite' : receiver?.storage === 'postgres' ? 'PostgreSQL' : null;
  const healthy = !unavailable && !unknown && car.networkOnline;
  const badge = unavailable ? 'Mottagaren är nere' : unknown ? 'Status okänd'
    : !car.networkOnline ? legacy ? 'Buffrar i bilen' : 'Bilen saknar täckning'
      : waiting ? 'Mätpunkter i kö'
      : lastReceivedAt ? legacy ? 'Testdata mottagen' : 'Sparat och kvitterat'
        : legacy ? 'Väntar på testdata' : 'Mottagaren är redo';
  return <section className={`testcar-card testcar-receiver${unavailable || unknown ? ' has-receiver-warning' : ''}`} aria-labelledby="testcar-receiver-heading">
    <div className="testcar-card-heading"><h2 id="testcar-receiver-heading">Mottagaren</h2><span className={`testcar-badge ${!healthy ? 'is-amber' : waiting ? '' : lastReceivedAt || !legacy ? 'is-green' : ''}`}>{unavailable || unknown ? <AlertTriangle size={15} /> : !car.networkOnline ? <WifiOff size={15} /> : waiting ? <RefreshCw size={15} /> : <Check size={15} />}{badge}</span></div>
    <div className="testcar-pipeline" aria-label="Testbil till virtuell FMC003 till mottagare"><span>Testbil</span><span aria-hidden="true">→</span><strong>Virtuell FMC003</strong><span aria-hidden="true">→</span><span>{separate ? 'Separat mottagare' : 'Mottagare'}</span></div>
    {!legacy && <div className="testcar-receiver-meta"><span><Server size={13} />{receiver ? separate ? 'Separat tjänst' : 'Intern testmottagare' : 'Tjänststatus saknas'}</span><span><Database size={13} />{storageName ? `${storageName} · ${receiver?.durable ? 'beständig lagring' : 'testlagring'}` : receiver ? 'Tillfällig lagring' : 'Lagring ej bekräftad'}</span></div>}
    {(unavailable || unknown || (!legacy && !car.networkOnline)) && <div className={`testcar-receiver-warning${!unavailable && !unknown ? ' is-buffering' : ''}`} role="status"><span>{unavailable ? 'Bilen fortsätter. Mätpunkterna väntar i kön och skickas igen när mottagaren svarar.' : unknown ? 'Det går inte att bekräfta mottagarens status just nu. Bilens instrument fortsätter att uppdateras.' : 'Bilen saknar mobiltäckning. Mätpunkterna buffras tills anslutningen är tillbaka.'}</span></div>}
    <dl className="testcar-receiver-stats"><div><dd>{receiver ? number.format(receiver.recordsStored) : legacy ? number.format(car.stats.recordsReceived) : '—'}</dd><dt>{legacy ? 'Mätpunkter' : 'Sparade mätpunkter'}</dt></div><div><dd>{number.format(car.stats.packetsReceived)}</dd><dt>{legacy ? 'Paket' : 'Kvitterade paket'}</dt></div><div className={car.stats.pendingRecords > 0 ? 'has-queue' : ''}><dd>{number.format(car.stats.pendingRecords)}</dd><dt>{legacy ? 'I kö' : 'Väntar i bilen'}</dt></div></dl>
    <p className="testcar-receiver-summary"><span>{decimal.format(car.stats.distanceKm)} km körda · {number.format(car.stats.trips)} resor</span><span>{lastReceivedAt ? `Senast mottaget ${fullClock.format(new Date(lastReceivedAt))}` : unknown || unavailable ? 'Senaste lagring ej bekräftad' : 'Redo för första mätpunkten'}</span></p>
    <p className="testcar-receiver-cadence">Mätning var 15:e sekund · sändning var 30:e sekund i simulerad tid</p>
    {!legacy && <>
      <details className="testcar-stored-data"><summary><Database size={15} /><span>Senast lagrad data<small>{records.length ? `${records.length} senaste mätpunkter` : 'Mätningar från mottagaren'}</small></span><ChevronDown size={17} /></summary>
        {records.length ? <div className="testcar-stored-table-wrap"><table aria-label="Senast lagrade syntetiska mätpunkter"><thead><tr><th scope="col">Mättid</th><th scope="col">Hastighet</th><th scope="col">Varvtal</th></tr></thead><tbody>{records.map((record, index) => <tr key={`${record.at}:${index}`}><td><time dateTime={record.at}><strong>{fullClock.format(new Date(record.at))}</strong><span>{recordDay.format(new Date(record.at))}</span></time></td><td><strong>{number.format(record.speedKmh)}</strong><span> km/h</span></td><td><strong>{record.rpm === undefined ? '—' : number.format(record.rpm)}</strong>{record.rpm !== undefined && <span> rpm</span>}</td></tr>)}</tbody></table></div> : <p className="testcar-stored-empty">{unknown || unavailable ? 'Lagrade mätningar kan inte visas just nu.' : receiver && receiver.recordsStored > 0 ? 'Mätpunkter har tagits emot. Detaljdata finns inte tillgängliga i den här vyn.' : 'Inga mätpunkter har lagrats ännu. Starta bilen och kör en tur.'}</p>}
        <p className="testcar-stored-caption">Syntetiska mätningar · tider visas för Stockholm</p>
      </details>
      <p className="testcar-retention-note">Bara mottagarens mätpunkter sparas här, inte bilens löpande instrumentvärden.{receiver?.durable && <> Historiken finns kvar när testbilen nollställs och rensas enligt lagringstiden.</>}</p>
    </>}
  </section>;
}

const placeIcons = { office: Building2, customer1: Warehouse, customer2: Warehouse, home: House };

function TestCarDashboard() {
  const { car, csrfToken, loading, loadError, syncError, commandError, notice, busy, command, refresh, dismissNotice, dismissError } = useTestCar();
  const [fleetBusy, setFleetBusy] = useState(false);
  const [selected, setSelected] = useState<PlaceId | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const sessionUnavailable = loading || loadError || fleetBusy;
  const durableReceiver = !!car && readTestCarReceiver(car.receiver)?.durable === true;
  useEffect(() => {
    if (car?.currentPlace.id === selected) setSelected(null);
  }, [car?.currentPlace.id, selected]);
  const onReset = async () => { if (await command({ action: 'reset' })) { setSelected(null); setConfirmReset(false); } };
  const onDrive = () => {
    if (!car) return;
    if (car.mode === 'driving') void command({ action: 'pause' });
    else {
      const destination = car.mode === 'paused' ? car.destinationId : selected;
      if (destination && destination !== car.currentPlace.id) void command({ action: 'drive', destination });
    }
  };
  const selectedPlace = car?.destinations.find(place => place.id === selected);
  const journeyInProgress = car?.mode === 'driving' || car?.mode === 'paused';
  const canDrive = !!car?.engineOn && (journeyInProgress || (!!selected && selected !== car.currentPlace.id));
  const driveLabel = car?.mode === 'driving' ? 'Pausa körning' : car?.mode === 'paused' ? 'Fortsätt körning' : selectedPlace ? `Kör till ${selectedPlace.name}` : 'Kör';

  return <div className="testcar-app"><PageHeader /><main className="testcar-main">
    <div className="testcar-intro"><div><div className="testcar-eyebrow">EN LITEN TUR I LABBET</div><h1>Din digitala testbil</h1><p>Starta bilen, välj en plats och följ resan.</p></div>
      {car && <div className="testcar-time-control"><span>Simulerad tid</span><div role="group" aria-label="Hastighet på simulerad tid">{([1, 5, 10] as TimeScale[]).map(scale => <button key={scale} type="button" aria-pressed={car.timeScale === scale} disabled={!!busy || sessionUnavailable} onClick={() => { void command({ action: 'speed', timeScale: scale }); }}>{scale}×</button>)}</div></div>}
    </div>
    {notice && <div className="testcar-message is-info" role="status"><Check size={19} /><span>{notice}</span><button type="button" onClick={dismissNotice} aria-label="Stäng meddelandet"><X size={17} /></button></div>}
    {syncError && car && <div className="testcar-message is-warning" role="status"><WifiOff size={19} /><span>Kontakten med testbilen bröts. Senaste läget visas.</span><button type="button" onClick={refresh} disabled={loading}><RefreshCw size={16} />Försök igen</button></div>}
    {commandError && <div className="testcar-message is-warning" role="alert"><AlertTriangle size={19} /><span>{commandError}</span><button type="button" onClick={dismissError} aria-label="Stäng felmeddelandet"><X size={17} /></button></div>}
    {!car ? <div className="testcar-startup testcar-card">
      <VanIllustration engineOn={false} />
      {loadError ? <><h2>Testbilen kunde inte hämtas</h2><p>Det gick inte att öppna din testsession. Försök igen om en stund.</p><button type="button" className="testcar-primary-button" onClick={refresh}><RefreshCw size={18} />Försök igen</button></> : <><LoaderCircle className="testcar-spin" size={25} /><h2 role="status">Förbereder din testbil…</h2><p>Snart är det dags att ge sig ut på en liten tur.</p></>}
    </div> : <>
      <div className="testcar-dashboard">
        <section className="testcar-card testcar-controls" aria-labelledby="testcar-car-title">
          <div className="testcar-car-title"><h2 id="testcar-car-title">{car.name}</h2><p>{car.deviceModel}</p></div>
          <VanIllustration engineOn={car.engineOn} />
          <div className="testcar-engine-buttons"><button type="button" className={`testcar-engine-start${car.engineOn ? ' is-on' : ''}`} disabled={!!busy || sessionUnavailable || car.engineOn} onClick={() => { void command({ action: 'start' }); }}><Power size={20} />{busy === 'start' ? 'Startar…' : car.engineOn ? 'Motor på' : 'Starta bilen'}</button><button type="button" className="testcar-engine-stop" disabled={!!busy || sessionUnavailable || !car.engineOn} onClick={() => { void command({ action: 'stop' }); }}><Square size={14} fill="currentColor" />{busy === 'stop' ? 'Stänger av…' : 'Stäng av'}</button></div>
          <p className="testcar-driver"><UserRound size={14} />Standardförare: <strong>{car.driver.name}</strong></p>
          <div className="testcar-current-place" aria-live="polite"><MapPin size={23} /><div><span>Nuvarande plats</span><strong>{currentPlaceName(car)}</strong></div>{car.currentPlace.id && <span className="testcar-place-check"><Check size={16} /></span>}</div>
          <h3 className="testcar-destinations-heading">Vart vill du köra?</h3>
          <div className="testcar-destinations">{car.destinations.map(place => {
            const Icon = placeIcons[place.id];
            const here = car.currentPlace.id === place.id;
            const chosen = (journeyInProgress ? car.destinationId : selected) === place.id;
            return <button type="button" key={place.id} className={`testcar-destination${chosen ? ' is-selected' : ''}${here ? ' is-here' : ''}`} disabled={here || !!busy || sessionUnavailable || journeyInProgress} aria-pressed={chosen} onClick={() => setSelected(place.id)}><Icon size={29} strokeWidth={1.7} /><span><strong>{place.name}</strong><small>{here ? 'Du är redan här' : place.subtitle}</small></span>{here && <Check className="testcar-here-check" size={14} />}</button>;
          })}</div>
          <button type="button" className="testcar-primary-button testcar-drive-button" disabled={!canDrive || !!busy || sessionUnavailable} onClick={onDrive}>{busy === 'drive' || busy === 'pause' ? <LoaderCircle size={20} className="testcar-spin" /> : car.mode === 'driving' ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}{busy === 'drive' ? 'På väg…' : busy === 'pause' ? 'Pausar…' : driveLabel}</button>
          {!car.engineOn && <p className="testcar-drive-hint">Starta bilen för att köra.</p>}
          {car.engineOn && !journeyInProgress && !selected && <p className="testcar-drive-hint">Välj en annan plats för nästa resa.</p>}
          {!confirmReset ? <button type="button" className="testcar-reset-link" disabled={!!busy || sessionUnavailable} onClick={() => setConfirmReset(true)}><RotateCcw size={16} />Nollställ testbilen</button> : <div className="testcar-reset-confirm" role="group" aria-label="Bekräfta nollställning"><strong>Börja om från Kontoret?</strong><p>Bilens lokala körning och väntande mätpunkter nollställs.{durableReceiver && <> Tidigare sparade mätpunkter i mottagaren finns kvar enligt lagringstiden.</>}</p><div><button type="button" disabled={!!busy} onClick={() => setConfirmReset(false)}>Avbryt</button><button type="button" disabled={!!busy || sessionUnavailable} onClick={() => { void onReset(); }}>{busy === 'reset' ? 'Nollställer…' : 'Ja, nollställ'}</button></div></div>}
        </section>
        <TestCarMap car={car} />
        <section className="testcar-card testcar-live" aria-labelledby="testcar-live-heading"><div className="testcar-card-heading"><h2 id="testcar-live-heading">Live från bilen</h2><button type="button" className={`testcar-badge testcar-network-toggle ${car.networkOnline ? 'is-green' : 'is-amber'}`} disabled={!!busy || sessionUnavailable} aria-label={car.networkOnline ? 'Ansluten. Simulera förlorad täckning' : 'Ingen täckning. Återställ täckning'} aria-pressed={car.networkOnline} title="Klicka för att prova med eller utan mobiltäckning" onClick={() => { void command({ action: 'network', online: !car.networkOnline }); }}>{car.networkOnline ? <Signal size={15} /> : <WifiOff size={15} />}{car.networkOnline ? 'Ansluten' : 'Ingen täckning'}</button></div>
          <Speedometer speed={car.telemetry.speedKmh} />
          <div className="testcar-metrics"><div className="testcar-metric"><Gauge size={27} /><div><span>Varvtal</span><strong>{number.format(car.telemetry.rpm)} <small>rpm</small></strong></div></div><div className="testcar-metric testcar-fuel"><Fuel size={27} /><div><span>Bränsle</span><strong>{number.format(car.telemetry.fuelPercent)} <small>%</small></strong><div className="testcar-fuel-track" role="meter" aria-label="Bränslenivå" aria-valuemin={0} aria-valuemax={100} aria-valuenow={car.telemetry.fuelPercent}><span style={{ width: `${Math.max(0, Math.min(100, car.telemetry.fuelPercent))}%` }} /></div></div></div><div className="testcar-metric"><Thermometer size={27} /><div><span>Motortemp</span><strong>{number.format(car.telemetry.coolantC)} <small>°C</small></strong></div></div><div className="testcar-metric"><Milestone size={27} /><div><span>Mätarställning</span><strong>{number.format(car.telemetry.odometerKm)} <small>km</small></strong></div></div></div>
          <SpeedHistory car={car} />
          <p className="testcar-network-hint">{car.networkOnline ? 'Prova att bryta täckningen med knappen ovan.' : 'Bilen fortsätter köra. Mätpunkterna väntar i kön.'}</p>
        </section>
      </div>
      <div className="testcar-bottom-grid"><section className="testcar-card testcar-events" aria-labelledby="testcar-events-heading"><div className="testcar-card-heading"><h2 id="testcar-events-heading">Det händer just nu</h2><span className="testcar-small-note">Alla händelser är simulerade</span></div>{car.events.length ? <ol>{[...car.events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 4).map(event => <li key={event.id} className={`is-${event.type}`}><span className="testcar-event-dot" /><time dateTime={event.at}>{clock.format(new Date(event.at))}</time><span>{event.text}</span></li>)}</ol> : <div className="testcar-no-events"><Power size={18} />Starta bilen så börjar det hända saker här.</div>}</section>
        <ReceiverCard car={car} />
      </div>
      <TestCarFleetLink csrfToken={csrfToken} engineOn={car.engineOn} disabled={!!busy || loading || loadError} onBusyChange={setFleetBusy} onChanged={refresh} />
    </>}
    <footer className="testcar-footer">ScrapPilot Labbet <span aria-hidden="true">·</span> Syntetisk bil, påhittade resor</footer>
  </main></div>;
}

class TestCarErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="testcar-app"><PageHeader /><main className="testcar-main"><div className="testcar-card testcar-startup"><AlertTriangle size={32} /><h1>Testbilen behöver en omstart</h1><p>Sidan kunde inte visas. Ladda om för att hämta bilens senaste läge.</p><button type="button" className="testcar-primary-button" onClick={() => window.location.reload()}><RefreshCw size={18} />Ladda om sidan</button></div></main></div>;
  }
}

export function TestCarApp() {
  return <TestCarErrorBoundary><TestCarDashboard /></TestCarErrorBoundary>;
}
export default TestCarApp;
