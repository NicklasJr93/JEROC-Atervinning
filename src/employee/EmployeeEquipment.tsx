import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Clock3, KeyRound, LoaderCircle, Package, RefreshCw, ShieldCheck, Smartphone, Undo2, Wrench, type LucideIcon } from 'lucide-react';
import { Nav, Notice } from '../components';
import { EmployeeError, employeeError, employeeRequest, useEmployee } from './EmployeeProvider';
import { equipmentCategoryLabels, equipmentTime, type EmployeeEquipmentResponse, type EquipmentCategory } from '../office/personnel/equipment-types';
import './employee.css';
import './employee-equipment.css';

const categoryIcons: Record<EquipmentCategory, LucideIcon> = { phone: Smartphone, tool: Wrench, ppe: ShieldCheck, key: KeyRound, other: Package };
export default function EmployeeEquipment() {
  const { session } = useEmployee();
  const navigate = useNavigate();
  const scope = session ? JSON.stringify([session.companyId ?? 'legacy', session.person.id, session.person.userId ?? session.person.username ?? '',
    [...session.person.siteIds].sort(), session.sites.map(site => [site.id, site.active !== false] as const).sort(([first], [second]) => first.localeCompare(second))]) : '';
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const mounted = useRef(true), epoch = useRef(0), controller = useRef<AbortController | undefined>(undefined);
  const [stored, setStored] = useState<{ scope: string; value: EmployeeEquipmentResponse }>();
  const [activity, setActivity] = useState<{ scope: string; loading: boolean; error?: string }>();
  const value = stored?.scope === scope && !!session ? stored.value : undefined;
  const loading = activity?.scope === scope && activity.loading;
  const error = activity?.scope === scope ? activity.error : undefined;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; controller.current?.abort(); }; }, []);
  useEffect(() => { epoch.current++; controller.current?.abort(); controller.current = undefined; setActivity({ scope, loading: false }); }, [scope]);
  const load = useCallback(async () => {
    if (!scope || controller.current) return;
    const request = new AbortController(), version = epoch.current; controller.current = request;
    const current = () => mounted.current && !request.signal.aborted && scopeRef.current === scope && epoch.current === version && controller.current === request;
    setActivity({ scope, loading: true });
    try {
      const result = await employeeRequest<EmployeeEquipmentResponse>('/equipment', undefined, { signal: request.signal });
      if (current()) setStored({ scope, value: result });
    } catch (failure) {
      if (current()) {
        const denied = failure instanceof EmployeeError && ([401, 403].includes(failure.status) || failure.code === 'company_selection_changed');
        if (denied) setStored(undefined);
        setActivity({ scope, loading: true, error: employeeError(failure) });
        if (denied) window.dispatchEvent(new Event('jeroc:employee-session-check'));
      }
    }
    finally { if (controller.current === request) { if (current()) setActivity(previous => ({ scope, loading: false, error: previous?.scope === scope ? previous.error : undefined })); controller.current = undefined; } }
  }, [scope]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [load]);
  const history = value?.assignments.flatMap(assignment => {
    const name = assignment.itemName || value.items.find(item => item.id === assignment.itemId)?.name || 'Utrustning';
    const number = assignment.inventoryNumber || value.items.find(item => item.id === assignment.itemId)?.inventoryNumber;
    const issued = { id: `${assignment.id}/issue`, at: assignment.issuedAt, name, number, label: 'Utlämnad', note: assignment.issueNote, returned: false };
    return assignment.returnedAt ? [issued, { id: `${assignment.id}/return`, at: assignment.returnedAt, name, number, label: 'Återlämnad', note: assignment.returnNote, returned: true }] : [issued];
  }).sort((a, b) => b.at.localeCompare(a.at)) ?? [];
  return <><main className="employee-page employee-equipment-page"><header className="employee-page-heading"><button className="icon-button" aria-label="Tillbaka till profil" onClick={() => navigate('/profile')}><ArrowLeft size={22} /></button><div className="employee-heading-copy"><h1>Min utrustning</h1><p>Utrustningen som är utlämnad till dig.</p></div><button className="icon-button" aria-label="Uppdatera min utrustning" disabled={loading || !session} onClick={() => void load()}><RefreshCw size={20} className={loading ? 'employee-equipment-spin' : ''} /></button></header>
    {error && <Notice tone="red">{error}<button className="employee-text" disabled={loading} onClick={() => void load()}>Försök igen</button></Notice>}
    {!value ? <div className="employee-equipment-empty">{loading ? <LoaderCircle size={27} className="employee-equipment-spin" /> : <Package size={28} />}<p>{loading ? 'Hämtar din utrustning…' : !session ? 'Logga in för att se din utrustning.' : 'Din utrustning kunde inte hämtas.'}</p></div> : <>
      <section aria-label="Utlämnad utrustning" className="employee-equipment-list">{value.items.length ? value.items.map(item => {
        const Icon = categoryIcons[item.category], assignment = value.assignments.find(record => record.itemId === item.id && !record.returnedAt);
        return <article className="employee-equipment-card" key={item.id}><div className="employee-equipment-card-top"><span className="employee-equipment-icon"><Icon size={23} /></span><div><h2>{item.name}</h2><p>{equipmentCategoryLabels[item.category]} · {item.inventoryNumber}</p></div></div><dl>{item.serialNumber && <><dt>Serienummer</dt><dd>{item.serialNumber}</dd></>}{assignment && <><dt>Utlämnad</dt><dd>{equipmentTime(assignment.issuedAt)}</dd></>}</dl>{item.description && <p className="employee-equipment-note">{item.description}</p>}{assignment?.issueNote && <p className="employee-equipment-note">{assignment.issueNote}</p>}</article>;
      }) : <div className="employee-equipment-empty"><Package size={30} /><p>Ingen utrustning är utlämnad till dig.</p></div>}</section>
      <section className="employee-equipment-history-section"><h2><Clock3 size={18} />Historik</h2>{history.length ? <ol className="employee-equipment-history">{history.map(event => <li key={event.id}><span className={`employee-equipment-history-icon${event.returned ? ' returned' : ''}`}>{event.returned ? <Undo2 size={16} /> : <Package size={16} />}</span><div><strong>{event.label} · {event.name}</strong><small>{event.number ? `${event.number} · ` : ''}{equipmentTime(event.at)}</small>{event.note && <p>{event.note}</p>}</div></li>)}</ol> : <p className="employee-equipment-help">Här visas dina utlämningar och återlämningar när de har registrerats.</p>}</section>
    </>}
  </main><Nav /></>;
}
