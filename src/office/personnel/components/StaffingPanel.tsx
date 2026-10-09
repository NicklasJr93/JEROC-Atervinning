import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, Search, TriangleAlert, Users } from 'lucide-react';
import type { PersonnelCommand, PersonnelResponse, ReplacementCandidate, StaffingTask } from '../types';
import { Alert, Dialog, Panel, Pill, formatDate, initials, minuteLabel } from './Ui';

interface Props {
  response: PersonnelResponse;
  runCommand: (command: PersonnelCommand) => Promise<PersonnelResponse>;
  onOpenPerson?: (id: string, tab?: string) => void;
  onOpenOrder?: (id: string) => void;
}
export default function StaffingPanel({ response, runCommand, onOpenPerson, onOpenOrder }: Props) {
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ taskIds: string[]; candidates: ReplacementCandidate[] }>();
  const [candidateId, setCandidateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const person = (id?: string) => response.data.people.find(item => item.id === id);
  const order = (id: string) => response.transport.orders.find(item => item.id === id);
  const active = response.data.staffingTasks.filter(item => item.status === 'open');
  const history = response.data.staffingTasks.filter(item => item.status === 'resolved');
  const canAssign = response.capabilities.includes('staffingWrite');
  const filtered = useMemo(() => (tab === 'active' ? active : history).filter(item => [item.orderId, order(item.orderId)?.customerName, person(item.personId)?.name, person(item.managerId)?.name, person(item.replacementPersonId)?.name, item.date].some(value => value?.toLocaleLowerCase('sv-SE').includes(query.toLocaleLowerCase('sv-SE')))).sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute), [response, tab, query]);
  useEffect(() => { setSelected(current => current.filter(id => response.data.staffingTasks.some(item => item.id === id && item.status === 'open'))); }, [response.data.staffingTasks]);
  const chosenTasks = preview?.taskIds.map(id => response.data.staffingTasks.find(item => item.id === id)).filter((item): item is StaffingTask => Boolean(item)) ?? [];
  const allSelected = filtered.length > 0 && filtered.every(item => selected.includes(item.id));
  const choose = (id: string) => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const checkReplacement = async (taskIds: string[]) => {
    if (!taskIds.length || !canAssign) return;
    setBusy(true); setError(''); setSuccess('');
    try { const next = await runCommand({ action: 'replacement.preview', taskIds }); const candidates = next.preview?.candidates ?? []; setPreview({ taskIds, candidates }); setCandidateId(candidates.find(item => item.available)?.personId ?? ''); }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'Ersättare kunde inte kontrolleras.'); }
    finally { setBusy(false); }
  };
  const assign = async () => {
    if (!preview || !candidateId) return;
    setBusy(true); setError('');
    try { const next = await runCommand({ action: 'staffing.assign', taskIds: preview.taskIds, replacementPersonId: candidateId }); const name = next.data.people.find(item => item.id === candidateId)?.name ?? 'Ersättaren'; setSuccess(`${name} har tilldelats ${preview.taskIds.length} uppdrag. Tider, kunder och arbetsordrar är bevarade.`); setPreview(undefined); setSelected([]); setTab('history'); }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'Bemanningen kunde inte sparas.'); }
    finally { setBusy(false); }
  };
  const close = () => { if (!busy) { setPreview(undefined); setError(''); } };
  return <div className="hr-staffing-workspace">
    <div className="office-page-title"><div><h1>Bemanning att lösa</h1><p>Uppdrag som behöver en tillgänglig förare med rätt kompetens.</p></div></div>
    <div className="hr-metrics three"><div className="hr-metric"><span>Behöver ersättare</span><strong>{active.length}</strong><small>Bokade uppdrag ligger kvar</small></div><div className="hr-metric"><span>Berörda förare</span><strong>{new Set(active.map(item => item.personId)).size}</strong><small>Registrerad frånvaro</small></div><div className="hr-metric"><span>Hanterade uppdrag</span><strong>{history.length}</strong><small>Spårbar tilldelning av ersättare</small></div></div>
    {success && <Alert tone="green"><Check size={20} /><div><strong>Bemanningen är uppdaterad</strong><p>{success}</p></div></Alert>}
    {error && !preview && <Alert tone="red">{error}</Alert>}
    {active.length > 0 && <Alert tone="orange"><TriangleAlert size={20} /><div><strong>{active.length} uppdrag behöver hanteras</strong><p>Välj ett eller flera uppdrag. Tillgänglighet, arbetstid, fordon och kompetenser kontrolleras före tilldelning.</p></div></Alert>}
    <Panel title={tab === 'active' ? 'Berörda uppdrag' : 'Hanterade uppdrag'} icon={<Users size={20} />} actions={tab === 'active' && canAssign && <button className="office-btn primary" disabled={!selected.length || busy} onClick={() => checkReplacement(selected)}>{busy ? 'Kontrollerar…' : `Välj ersättare${selected.length ? ` · ${selected.length} uppdrag` : ''}`}</button>}>
      <div className="hr-subtabs" role="tablist" aria-label="Bemanningsuppgifter"><button role="tab" aria-selected={tab === 'active'} className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>Aktiva{active.length > 0 && <span className="hr-tab-count">{active.length}</span>}</button><button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Historik</button></div>
      <label className="hr-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Sök arbetsorder, kund, förare eller ansvarig…" aria-label="Sök bemanningsuppgift" /></label>
      <div className="hr-table-scroll"><table className="hr-table"><thead><tr>{tab === 'active' && canAssign && <th><input type="checkbox" aria-label="Välj alla visade uppdrag" checked={allSelected} onChange={() => setSelected(current => allSelected ? current.filter(id => !filtered.some(item => item.id === id)) : [...new Set([...current, ...filtered.map(item => item.id)])])} /></th>}<th>Arbetsorder / kund</th><th>Tid</th><th>Förare</th><th>Krav</th><th>Ansvarig</th><th>Status</th><th /></tr></thead><tbody>{filtered.map(item => { const booking = order(item.orderId); const original = person(item.personId); const replacement = person(item.replacementPersonId); const vehicle = response.transport.vehicles.find(value => value.id === booking?.vehicleId); const requirements = [...new Set([...(booking?.requiredCompetencies ?? []), ...(vehicle?.requiredCompetencies ?? [])])]; return <tr key={item.id}>{tab === 'active' && canAssign && <td><input type="checkbox" aria-label={`Välj ${item.orderId}`} checked={selected.includes(item.id)} onChange={() => choose(item.id)} /></td>}<td><strong>{item.orderId} · {booking?.customerName ?? 'Arbetsorder'}</strong><small>{booking?.material ?? ''}</small>{onOpenOrder && <button className="hr-text-btn" onClick={() => onOpenOrder(item.orderId)}>Visa arbetsorder</button>}</td><td>{formatDate(item.date)}<small>{minuteLabel(item.startMinute)}–{minuteLabel(item.startMinute + item.durationMinutes)}</small></td><td>{onOpenPerson ? <button className="hr-text-btn" onClick={() => onOpenPerson(item.replacementPersonId ?? item.personId, 'schedule')}>{replacement?.name ?? original?.name ?? 'Förare'}</button> : <strong>{replacement?.name ?? original?.name ?? 'Förare'}</strong>}<small>{replacement ? `Ersätter ${original?.name ?? 'tidigare förare'}` : 'Frånvarande'}</small></td><td>{vehicle?.name ?? 'Fordon enligt arbetsorder'}<small>{requirements.length ? requirements.join(' · ') : 'Uppdragets registrerade krav'}</small></td><td>{person(item.managerId)?.name ?? 'Ej tilldelad'}</td><td><Pill tone={item.status === 'resolved' ? 'green' : 'orange'}>{item.status === 'resolved' ? 'Löst' : 'Behöver förare'}</Pill>{item.resolvedAt && <small>{formatDate(item.resolvedAt)}</small>}</td><td>{item.status === 'open' && canAssign && <button className="office-btn" disabled={busy} onClick={() => checkReplacement([item.id])}>Hantera</button>}</td></tr>; })}</tbody></table></div>{!filtered.length && <p className="hr-empty">{query ? 'Inga uppdrag matchar sökningen.' : tab === 'active' ? 'Inga bemanningsproblem just nu.' : 'Inga hanterade bemanningsuppgifter ännu.'}</p>}
    </Panel>
    {preview && <Dialog title="Välj ersättare" description={`${chosenTasks.length} uppdrag · Samma tider och kunder, ny förare.`} onClose={close}>
      <div className="hr-replacement-orders">{chosenTasks.map(item => <div className="hr-preview-order" key={item.id}><strong>{item.orderId} · {order(item.orderId)?.customerName ?? 'Arbetsorder'}</strong><span>{formatDate(item.date)} · {minuteLabel(item.startMinute)}–{minuteLabel(item.startMinute + item.durationMinutes)}</span></div>)}</div>
      <div className="hr-candidates">{preview.candidates.map(item => <label key={item.personId} className={`hr-candidate${candidateId === item.personId ? ' selected' : ''}${item.available ? '' : ' unavailable'}`}><input type="radio" name="replacement-person" value={item.personId} checked={candidateId === item.personId} disabled={!item.available || busy} onChange={() => setCandidateId(item.personId)} /><span className="hr-avatar">{initials(item.name)}</span><div><strong>{item.name}</strong><small>{item.available ? 'Tillgänglig och uppfyller kraven för alla valda uppdrag' : item.issues.join(' · ') || 'Kan inte tilldelas dessa uppdrag'}</small><Pill tone={item.available ? 'green' : 'red'}>{item.available ? 'Kan tilldelas' : 'Kan inte väljas'}</Pill></div>{candidateId === item.personId && <Check size={20} />}</label>)}</div>
      {!preview.candidates.some(item => item.available) && <Alert tone="orange">Ingen ersättare uppfyller kraven för alla valda uppdrag. Prova färre uppdrag eller komplettera förarnas schema och kompetenser.</Alert>}
      <Alert><CalendarDays size={20} /><div><strong>Bokningarna behåller sina tider</strong><p>Frånvaron ligger kvar. Tilldelningen kontrolleras igen när du sparar, så att en förare inte kan dubbelbokas.</p></div></Alert>
      {error && <Alert tone="red">{error}</Alert>}<div className="hr-dialog-actions"><button className="office-btn" disabled={busy} onClick={close}>Avbryt</button><button className="office-btn primary" disabled={busy || !candidateId || !preview.candidates.some(item => item.personId === candidateId && item.available)} onClick={assign}>{busy ? 'Tilldelar…' : `Tilldela ${person(candidateId)?.name?.split(' ')[0] ?? 'ersättare'} · ${chosenTasks.length} uppdrag`}</button></div>
    </Dialog>}
  </div>;
}
