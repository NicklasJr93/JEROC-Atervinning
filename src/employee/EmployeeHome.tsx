import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ChevronRight, Clock3, Moon, RefreshCw, Scale, Sun, Truck, Wrench, type LucideIcon } from 'lucide-react';
import { MenuRow, Nav, Notice } from '../components';
import { useDemo } from '../store';
import { draftPath, recentDraftFirst } from '../model';
import { actionLabels, vesselTypes } from '../office/transport/types';
import { ActiveSitePicker } from './ActiveSitePicker';
import { EmployeeClockCard } from './EmployeeClock';
import { EmployeeSicknessCard } from './EmployeeSickness';
import { useEmployee } from './EmployeeProvider';
import { useEmployeeFleet } from './EmployeeFleet';
import { capitalize, fullDayLabel, hoursLabel, minuteLabel } from './Calendar';
import { employeeCompanyId } from './cache';
import './employee-home.css';

const zone = 'Europe/Stockholm';
// Only a non-sensitive visit marker; login generation separates people and
// companies. A return from weighing refreshes the small server projection.
let lastHomeVisitScope: string | undefined;
function useGreeting(serverNow?: string) {
  const anchor = useRef({ source: serverNow, offset: serverNow && Number.isFinite(Date.parse(serverNow)) ? Date.parse(serverNow) - Date.now() : 0 });
  if (anchor.current.source !== serverNow) anchor.current = { source: serverNow, offset: serverNow && Number.isFinite(Date.parse(serverNow)) ? Date.parse(serverNow) - Date.now() : 0 };
  const [, setTick] = useState(0);
  useEffect(() => {
    const update = () => { if (!document.hidden) setTick(value => value + 1); };
    const timer = window.setInterval(update, 60000);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, []);
  const now = new Date(Date.now() + anchor.current.offset);
  const hour = Number(new Intl.DateTimeFormat('sv-SE', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  return { date: new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now),
    text: hour < 5 ? 'God natt' : hour < 12 ? 'God morgon' : hour < 18 ? 'God eftermiddag' : 'God kväll', night: hour < 5 || hour >= 18 };
}
function HomeSection({ title, children, className = '', note }: { title: string; children: ReactNode; className?: string; note?: string }) {
  return <section className={`employee-home-section ${className}`}><header className="employee-home-section-header"><h2>{title}</h2>{note && <span>{note}</span>}</header>{children}</section>;
}
function Shortcut({ title, description, icon: Icon, onClick, primary = false, count, disabled = false }: { title: string; description: string; icon: LucideIcon; onClick: () => void; primary?: boolean; count?: number; disabled?: boolean }) {
  return <button disabled={disabled} className={`employee-home-shortcut${primary ? ' primary' : ''}`} aria-label={title} onClick={onClick}><span className="employee-home-tile-icon"><Icon size={27} /></span><span className="employee-home-shortcut-copy"><strong>{title}</strong><small>{description}</small></span>{count !== undefined && count > 0 ? <span className="employee-home-count">{count} kvar</span> : <ChevronRight size={20} />}</button>;
}

export default function EmployeeHomePage() {
  const fleet = useEmployeeFleet();
  const { overview, session, refresh, error, refreshing, sessionGeneration } = useEmployee();
  const { data, markDraftActive, sharedReady } = useDemo();
  const navigate = useNavigate();
  const greeting = useGreeting(overview?.clock?.serverNow);
  const entered = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!session || !overview) return;
    let returning = false;
    const visitScope = `${employeeCompanyId(session.companyId)}/${session.person.id}/${sessionGeneration}`;
    if (entered.current !== visitScope) {
      entered.current = visitScope;
      returning = lastHomeVisitScope === visitScope;
      lastHomeVisitScope = visitScope;
    }
    if (returning || overview.date !== greeting.date || overview.today !== greeting.date || overview.monthLoaded !== false)
      void refresh({ date: greeting.date, month: greeting.date.slice(0, 7), view: 'bootstrap' }).catch(() => undefined);
  }, [refresh, overview?.date, overview?.today, overview?.monthLoaded, greeting.date, session?.companyId, session?.person.id, sessionGeneration]);
  const failure = error && <div className="employee-error"><Notice tone="red">{error}</Notice><button className="employee-text" disabled={refreshing} onClick={() => void refresh({ view: 'bootstrap' }).catch(() => undefined)}><RefreshCw size={16} />Försök igen</button></div>;
  if (!session || !overview) return <><main className="employee-page employee-home"><h1>Hem</h1><div className="employee-empty"><Clock3 size={27} /><p>Hämtar din dag…</p></div>{failure}</main><Nav /></>;
  const day = overview.date === greeting.date && overview.today === greeting.date && overview.selectedDay.date === greeting.date ? overview.selectedDay : undefined;
  const todayOrders = session.capabilities.assignedOrders ? overview.orders.filter(order => order.date === greeting.date && order.status !== 'cancelled')
    .sort((first, second) => (first.startMinute ?? 1440) - (second.startMinute ?? 1440) || first.id.localeCompare(second.id)) : [];
  const remaining = todayOrders.filter(order => order.status !== 'done');
  const weekEnd = new Date(`${greeting.date}T12:00:00Z`); weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const next = session.capabilities.assignedOrders ? overview.upcomingOrders?.filter(order => order.date && order.date >= greeting.date && order.date <= weekEnd.toISOString().slice(0, 10) && !['done', 'cancelled'].includes(order.status))
    .sort((first, second) => (first.date ?? '').localeCompare(second.date ?? '') || (first.startMinute ?? 1440) - (second.startMinute ?? 1440) || first.id.localeCompare(second.id))[0] : undefined;
  const tomorrow = new Date(`${greeting.date}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const nextDay = next?.date === greeting.date ? 'Idag' : next?.date === tomorrow.toISOString().slice(0, 10) ? 'Imorgon' : next?.date ? capitalize(fullDayLabel(next.date)) : '';
  const schedules = [...(day?.schedules ?? [])].sort((first, second) => first.startMinute - second.startMinute);
  const ongoing = sharedReady ? data.drafts.filter(draft => draft.status !== 'ready').sort(recentDraftFirst)[0] : undefined;
  const ongoingSite = session.sites.find(site => site.id === ongoing?.siteId);
  const activeWork = overview.activeWork;
  const canWeigh = session.sites.some(site => site.active !== false && site.id === session.activeSiteId && session.person.siteIds.includes(site.id));
  const progressExpected = day && overview.requirement.enabled && !overview.clock?.requiresCorrection && Number.isFinite(day.expectedMinutes) && day.expectedMinutes > 0 ? day.expectedMinutes : undefined;
  const firstName = session.person.name.trim().split(/\s+/)[0];
  const DaySummary = <div className={`employee-home-day-summary${!session.capabilities.assignedOrders ? ' single' : ''}`}><div><span>Arbetspass</span>{day ? schedules.length ? schedules.map(schedule => <strong key={schedule.id}>{minuteLabel(schedule.startMinute)}–{minuteLabel(schedule.endMinute)}</strong>) : <strong className="employee-home-unplanned">Inget planerat pass</strong> : <strong className="employee-home-unplanned">Hämtar arbetspass…</strong>}</div>{session.capabilities.assignedOrders && <div><strong>{todayOrders.length} uppdrag idag</strong></div>}</div>;
  return <><main className="employee-page employee-home">
    <header className="employee-home-hero"><div className="employee-home-site"><ActiveSitePicker /></div><div className="employee-home-greeting"><h1><span>{greeting.text},</span><strong>{firstName || session.person.name}{greeting.night ? <Moon size={29} aria-hidden="true" /> : <Sun size={31} aria-hidden="true" />}</strong></h1><p>{capitalize(fullDayLabel(greeting.date))}</p></div><div className="employee-home-mascot" aria-hidden="true"><img src="/images/skrotis-home.webp" alt="" width="384" height="366" decoding="async" fetchPriority="low" /></div></header>
    {failure}
    {overview.clock?.enabled ? <EmployeeClockCard variant="home" daySummary={DaySummary} expectedMinutes={progressExpected} recordedMinutes={day?.recordedMinutes} /> : <section className="employee-card employee-home-day-card"><header><h2>Din dag</h2></header>{DaySummary}{day && session.capabilities.employeeTime && <div className="employee-home-recorded"><span>Arbetad tid idag</span><strong>{hoursLabel(day.recordedMinutes)}</strong></div>}{progressExpected !== undefined && day && <div className="employee-home-progress" role="progressbar" aria-label="Arbetstid i förhållande till dagens timkrav" aria-valuemin={0} aria-valuemax={progressExpected} aria-valuenow={Math.min(progressExpected, day.recordedMinutes)} aria-valuetext={`${hoursLabel(day.recordedMinutes)} av ${hoursLabel(progressExpected)}`}><span style={{ width: `${Math.min(100, day.recordedMinutes / progressExpected * 100)}%` }} /></div>}</section>}
    <EmployeeSicknessCard />
    {session.capabilities.assignedOrders && (next ? <button className="employee-home-next employee-home-card" aria-label="Öppna nästa uppdrag" onClick={() => navigate(`/assignments?order=${encodeURIComponent(next.id)}`)}><span className="employee-home-next-heading"><strong>Nästa uppdrag</strong><span>{nextDay} · {next.startMinute !== undefined ? minuteLabel(next.startMinute) : 'Tid ej bokad'}</span></span><span className="employee-home-next-content"><span className="employee-home-tile-icon"><Truck size={30} /></span><span><strong>{actionLabels[next.action]} · {next.customerName}</strong><small>{[next.city || next.address, next.vesselSize ? `${vesselTypes[next.vesselType]?.label ?? 'Kärl'} ${next.vesselSize}` : ''].filter(Boolean).join(' · ')}</small></span><ChevronRight size={24} /></span></button> : <section className="employee-home-card employee-home-no-next"><h2>Nästa uppdrag</h2><p>Inga kommande uppdrag de närmaste sju dagarna.</p><button className="employee-text" onClick={() => navigate('/schedule')}>Öppna mitt schema<ChevronRight size={16} /></button></section>)}
    {Boolean(fleet.data?.vehicles.length || fleet.data?.trips.length) && <HomeSection title="Fordon & resor"><MenuRow title="Mitt fordon" description="Fordonskontroll, service och körjournal" icon={Truck} onClick={() => navigate('/my-vehicle')} /></HomeSection>}
    <HomeSection title="Snabbval"><div className={`employee-home-shortcuts${!session.capabilities.yardWork && !session.capabilities.assignedOrders ? ' single' : ''}`}>{session.capabilities.yardWork && <><Shortcut primary title="Väg in" disabled={!canWeigh} description={canWeigh ? 'Ny invägning' : 'Anläggning behöver tilldelas'} icon={Scale} onClick={() => navigate('/new')} /><Shortcut title="Gårdsarbete" description="Vägningar & prislista" icon={Wrench} onClick={() => navigate('/yard')} /></>}{session.capabilities.assignedOrders && <Shortcut title="Mina uppdrag" description="Arbetsorder & transportdokument" icon={Truck} count={remaining.length} onClick={() => navigate('/assignments')} />}{session.capabilities.employeeTime && (session.capabilities.yardWork || session.capabilities.assignedOrders) && <Shortcut title="Mitt schema" description="Arbetspass och kommande jobb" icon={CalendarDays} onClick={() => navigate('/schedule')} />}{!session.capabilities.yardWork && !session.capabilities.assignedOrders && session.capabilities.employeeTime && <><Shortcut title="Schema & tid" description="Schema och ledighet" icon={CalendarDays} onClick={() => navigate('/schedule')} /><Shortcut title="Tidrapportering" description="Registrerad arbetstid" icon={Clock3} onClick={() => navigate('/time')} /></>}</div>{!session.capabilities.yardWork && !session.capabilities.assignedOrders && !session.capabilities.employeeTime && <p className="employee-subtle">Du hittar ditt schema och din profil i menyn.</p>}</HomeSection>
    {(activeWork || ongoing && session.capabilities.yardWork) && <HomeSection title="Fortsätt där du var" className="employee-home-recovery">{activeWork && <MenuRow title={overview.clock?.enabled ? 'Pågående uppdragsfördelning' : 'Pågående arbetstid'} description={`${activeWork.orderId} · startad ${new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: zone }).format(new Date(activeWork.startedAt))}`} icon={Clock3} onClick={() => navigate(session.capabilities.assignedOrders ? `/assignments?order=${encodeURIComponent(activeWork.orderId)}` : '/time')} />}{ongoing && session.capabilities.yardWork && <MenuRow title={ongoing.vehicleInput?.registration || `Vägning #${ongoing.number}`} description={`${ongoing.status === 'awaiting-exit' ? 'Väntar på utvägning' : 'Fortsätt din invägning'}${ongoingSite ? ` · ${ongoingSite.name}` : ''}`} icon={Scale} onClick={() => { markDraftActive(ongoing.id); navigate(draftPath(ongoing)); }} />}</HomeSection>}
  </main><Nav /></>;
}
