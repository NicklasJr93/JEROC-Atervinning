import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Clock3, KeyRound, LoaderCircle, Package, Pencil, Plus, RefreshCw, Search, ShieldCheck, Smartphone, Undo2, UserRound, Wrench, type LucideIcon } from 'lucide-react';
import { can, type OfficeUser } from '../model';
import { OfficePageHeader } from '../OfficePageHeader';
import { EquipmentApiError, equipmentApi, equipmentScope } from './equipment-client';
import { equipmentCategoryLabels, equipmentStatusLabels, equipmentTime, type EquipmentCategory, type EquipmentCommand, type EquipmentItem, type EquipmentResponse, type EquipmentReturnCondition, type EquipmentStatus } from './equipment-types';
import { Alert, Dialog, Fact, Field, Pill } from './components/Ui';
import './personal.css';
import './equipment.css';

export const equipmentIcons: Record<EquipmentCategory, LucideIcon> = { phone: Smartphone, tool: Wrench, ppe: ShieldCheck, key: KeyRound, other: Package };
const statusTone = (status: EquipmentStatus) => ({ available: 'green', issued: 'blue', maintenance: 'orange', retired: 'grey' } as const)[status];
type AssetForm = { id?: string; inventoryNumber: string; name: string; category: EquipmentCategory; siteId: string; serialNumber: string; description: string; status: EquipmentStatus; revision?: number };
type Modal = { kind: 'view' | 'edit' | 'issue' | 'return'; itemId?: string; asset?: AssetForm; personId?: string; note: string; condition: EquipmentReturnCondition };
type Scoped<T> = { scope: string; value: T };
const assetForm = (item: EquipmentItem): AssetForm => ({ ...item });

export interface EquipmentWorkspaceProps { user: OfficeUser; actualUser: OfficeUser; personId?: string; selectedSiteId?: string; onNotice: (message: string) => void }
export default function EquipmentWorkspace({ user, actualUser, personId, selectedSiteId = 'all', onNotice }: EquipmentWorkspaceProps) {
  const scope = `${equipmentScope(actualUser, user)}/${personId ?? 'all'}/${selectedSiteId}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const permitted = [user, actualUser].every(person => can(person, 'equipmentRead'));
  const permissionRef = useRef(permitted); permissionRef.current = permitted;
  const mounted = useRef(true), epoch = useRef(0), controller = useRef<AbortController | undefined>(undefined);
  const retry = useRef<{ scope: string; fingerprint: string; requestId: string } | undefined>(undefined);
  const [stored, setStored] = useState<Scoped<EquipmentResponse>>(), [modalState, setModalState] = useState<Scoped<Modal>>();
  const [activity, setActivity] = useState<{ scope: string; pending?: 'load' | 'write'; error?: string }>();
  const [query, setQuery] = useState(''), [category, setCategory] = useState('all'), [status, setStatus] = useState('all'), [siteFilter, setSiteFilter] = useState('all');
  const response = stored?.scope === scope && permitted ? stored.value : undefined;
  const modal = modalState?.scope === scope && permitted ? modalState.value : undefined;
  const pending = activity?.scope === scope ? activity.pending : undefined, error = activity?.scope === scope ? activity.error : undefined;
  const patchActivity = (patch: Partial<NonNullable<typeof activity>>) => setActivity(previous => ({ ...(previous?.scope === scope ? previous : {}), scope, ...patch }));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; controller.current?.abort(); }; }, []);
  useEffect(() => { epoch.current++; controller.current?.abort(); controller.current = undefined; setActivity({ scope }); setQuery(''); setCategory('all'); setStatus('all'); setSiteFilter('all'); }, [scope]);
  const run = useCallback(async (kind: 'load' | 'write', operation: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (!permissionRef.current || controller.current) return;
    const request = new AbortController(), version = epoch.current; controller.current = request;
    const current = () => mounted.current && !request.signal.aborted && scopeRef.current === scope && permissionRef.current && epoch.current === version && controller.current === request
      && `${equipmentScope(actualUser, user)}/${personId ?? 'all'}/${selectedSiteId}` === scope;
    patchActivity({ pending: kind, error: '' });
    try { await operation(request.signal, current); }
    catch (failure) {
      if (current()) {
        if (failure instanceof EquipmentApiError && [401, 403].includes(failure.status)) {
          setStored(undefined); setModalState(undefined); retry.current = undefined;
        }
        patchActivity({ error: failure instanceof Error ? failure.message : 'Utrustningen kunde inte sparas.' });
      }
    }
    finally { if (controller.current === request) { if (current()) patchActivity({ pending: undefined }); controller.current = undefined; } }
  }, [scope, actualUser.id, user.id, personId, selectedSiteId]);
  const load = useCallback(() => run('load', async (signal, current) => { const value = await equipmentApi.read(actualUser.id, user.id, signal); if (current()) setStored({ scope, value }); }), [run, actualUser.id, user.id, scope]);
  useEffect(() => { if (permitted) void load(); }, [load, permitted]);
  const writable = !!response?.capabilities.includes('equipmentWrite') && [user, actualUser].every(person => can(person, 'equipmentWrite'));
  const busy = pending === 'write';
  const person = response?.people.find(value => value.id === personId);
  const sites = response?.sites.filter(site => selectedSiteId === 'all' || site.id === selectedSiteId) ?? [];
  const siteName = (id: string) => response?.sites.find(site => site.id === id)?.name ?? 'Anläggning';
  const personName = (id: string) => response?.people.find(value => value.id === id)?.name ?? 'Tidigare medarbetare';
  const assignments = response?.data.assignments ?? [], items = response?.data.items ?? [];
  const activeAssignment = (itemId: string) => assignments.find(assignment => assignment.itemId === itemId && !assignment.returnedAt);
  const personAssignments = personId ? assignments.filter(assignment => assignment.personId === personId) : assignments;
  const relevantItems = items.filter(item => (selectedSiteId === 'all' || item.siteId === selectedSiteId) && (!personId || activeAssignment(item.id)?.personId === personId));
  const visible = relevantItems.filter(item => (category === 'all' || item.category === category) && (status === 'all' || item.status === status) && (siteFilter === 'all' || item.siteId === siteFilter)
    && [item.name, item.inventoryNumber, item.serialNumber, item.description, activeAssignment(item.id) && personName(activeAssignment(item.id)!.personId)].filter(Boolean).join(' ').toLocaleLowerCase('sv-SE').includes(query.toLocaleLowerCase('sv-SE')));
  const availableItems = items.filter(item => item.status === 'available' && (selectedSiteId === 'all' || item.siteId === selectedSiteId) && (!person || person.siteIds.includes(item.siteId)));
  const selected = items.find(item => item.id === modal?.itemId), selectedAssignment = selected && activeAssignment(selected.id);
  const history = response?.data.events.filter(event => !personId || event.personId === personId || event.assignmentId && personAssignments.some(assignment => assignment.id === event.assignmentId)).sort((a, b) => b.at.localeCompare(a.at)) ?? [];
  const itemHistory = selected ? response?.data.events.filter(event => event.itemId === selected.id && (!personId || event.personId === personId || event.assignmentId && personAssignments.some(assignment => assignment.id === event.assignmentId))).sort((a, b) => b.at.localeCompare(a.at)) ?? [] : [];
  function open(value: Modal) { setModalState({ scope, value }); patchActivity({ error: '' }); }
  function close() { if (!busy) setModalState(undefined); }
  function change(patch: Partial<Modal>) { setModalState(previous => previous?.scope === scope ? { scope, value: { ...previous.value, ...patch } } : previous); }
  function changeAsset(patch: Partial<AssetForm>) { if (modal?.asset) change({ asset: { ...modal.asset, ...patch } }); }
  function create() { open({ kind: 'edit', asset: { inventoryNumber: '', name: '', category: 'other', siteId: sites[0]?.id ?? '', serialNumber: '', description: '', status: 'available' }, note: '', condition: 'available' }); }
  function issue(item?: EquipmentItem) { open({ kind: 'issue', itemId: item?.id ?? availableItems[0]?.id, personId: personId ?? '', note: '', condition: 'available' }); }
  function mutate(command: EquipmentCommand, notice: string) {
    if (!writable || busy) return;
    const fingerprint = JSON.stringify(command);
    if (retry.current?.scope !== scope || retry.current.fingerprint !== fingerprint) retry.current = { scope, fingerprint, requestId: crypto.randomUUID() };
    const submitted = { ...command, requestId: retry.current.requestId }; onNotice('');
    void run('write', async (signal, current) => {
      const value = await equipmentApi.command(submitted, actualUser.id, user.id, signal);
      if (!current()) return;
      setStored({ scope, value }); setModalState(undefined); retry.current = undefined; onNotice(notice);
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault(); if (!modal) return;
    if (modal.kind === 'edit' && modal.asset) {
      const asset = modal.asset;
      mutate({ action: 'item.save', item: { ...(asset.id ? { id: asset.id, revision: asset.revision } : {}), inventoryNumber: asset.inventoryNumber.trim(), name: asset.name.trim(), category: asset.category,
        siteId: asset.siteId, serialNumber: asset.serialNumber.trim(), description: asset.description.trim(), ...(asset.status !== 'issued' ? { status: asset.status } : {}) } }, asset.id ? 'Utrustningens uppgifter är sparade.' : 'Utrustningen är registrerad.');
    } else if (selected && modal.kind === 'issue' && modal.personId) mutate({ action: 'item.issue', id: selected.id, revision: selected.revision, personId: modal.personId, note: modal.note.trim() }, 'Utrustningen är utlämnad.');
    else if (selected && modal.kind === 'return') mutate({ action: 'item.return', id: selected.id, revision: selected.revision, condition: modal.condition, note: modal.note.trim() }, 'Utrustningen är återlämnad.');
  }
  const filters = <div className="equipment-filters"><label className="equipment-search"><Search size={17} /><input aria-label="Sök utrustning" placeholder="Sök namn, inventarienummer eller serienummer…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {!personId && <><select aria-label="Kategori" value={category} onChange={event => setCategory(event.target.value)}><option value="all">Alla kategorier</option>{Object.entries(equipmentCategoryLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><select aria-label="Utrustningens status" value={status} onChange={event => setStatus(event.target.value)}><option value="all">Alla statusar</option>{Object.entries(equipmentStatusLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><select aria-label="Utrustningens anläggning" value={siteFilter} onChange={event => setSiteFilter(event.target.value)}><option value="all">Alla anläggningar</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></>}
  </div>;
  const actions = <div className="equipment-heading-actions"><button className="office-btn outline" disabled={!!pending} onClick={() => void load()}><RefreshCw size={15} className={pending === 'load' ? 'equipment-spin' : ''} />Uppdatera</button>{writable && (personId ? <button className="office-btn" disabled={busy || !person?.active || !availableItems.length} onClick={() => issue()}><Plus size={16} />Tilldela utrustning</button> : <button className="office-btn" disabled={busy || !sites.length} onClick={create}><Plus size={16} />Registrera utrustning</button>)}</div>;
  if (!permitted) return <Alert tone="orange">Du saknar behörighet att läsa utrustningsregistret.</Alert>;
  return <section className={`equipment-workspace${personId ? ' embedded' : ''}`}>
    {personId ? <><div className="equipment-heading"><div><h2>Utrustning</h2><p>Utlämnad utrustning och historik för {person?.name ?? 'personen'}.</p></div>{actions}</div>{filters}</>
      : <OfficePageHeader controls={filters}><Link className="office-link" to="/personnel"><ArrowLeft size={15} />Till personal</Link><div className="office-title"><div><span className="office-eyebrow">PERSONAL · UTRUSTNING</span><h1>Utrustning</h1><p>Registrera utrustning och följ vem som har den.</p></div>{actions}</div></OfficePageHeader>}
    {error && !modal && <Alert tone="red">{error}</Alert>}
    {!response ? <div className="office-panel equipment-empty">{pending === 'load' ? <><LoaderCircle size={24} className="equipment-spin" /><strong>Hämtar utrustning…</strong></> : <><Package size={27} /><strong>Utrustningen kunde inte hämtas.</strong><button className="office-btn outline" onClick={() => void load()}>Försök igen</button></>}</div> : <>
      {personId && !person && <Alert tone="orange">Personen finns inte i den valda anläggningen.</Alert>}
      {!personId && <div className="equipment-counts"><span><strong>{relevantItems.filter(item => item.status === 'available').length}</strong> tillgängliga</span><span><strong>{relevantItems.filter(item => item.status === 'issued').length}</strong> utlämnade</span><span><strong>{relevantItems.filter(item => item.status === 'maintenance').length}</strong> på service / kontroll</span></div>}
      <article className="office-panel equipment-table-panel">{visible.length ? <div className="equipment-table-scroll"><table className="equipment-table"><thead><tr><th>Utrustning</th><th>Kategori</th><th>Status</th><th>Hos</th><th>Anläggning</th><th><span className="equipment-sr-only">Åtgärder</span></th></tr></thead><tbody>{visible.map(item => { const Icon = equipmentIcons[item.category], assignment = activeAssignment(item.id); return <tr key={item.id} tabIndex={0} onClick={() => open({ kind: 'view', itemId: item.id, note: '', condition: 'available' })} onKeyDown={event => { if (event.key === 'Enter') open({ kind: 'view', itemId: item.id, note: '', condition: 'available' }); }}>
        <td><div className="equipment-asset-cell"><span><Icon size={20} /></span><div><strong>{item.name}</strong><small>{item.inventoryNumber}{item.serialNumber ? ` · ${item.serialNumber}` : ''}</small></div></div></td><td>{equipmentCategoryLabels[item.category]}</td><td><Pill tone={statusTone(item.status)}>{equipmentStatusLabels[item.status]}</Pill></td><td>{assignment ? personName(assignment.personId) : '—'}</td><td>{siteName(item.siteId)}</td><td onClick={event => event.stopPropagation()}>{writable && item.status === 'available' && <button className="office-link" onClick={() => issue(item)}><UserRound size={14} />Lämna ut<span className="equipment-sr-only"> {item.inventoryNumber}</span></button>}{writable && item.status === 'issued' && <button className="office-link" onClick={() => open({ kind: 'return', itemId: item.id, note: '', condition: 'available' })}><Undo2 size={14} />Återlämna<span className="equipment-sr-only"> {item.inventoryNumber}</span></button>}</td>
      </tr>; })}</tbody></table></div> : <div className="equipment-empty"><Package size={27} /><strong>{query || category !== 'all' || status !== 'all' || siteFilter !== 'all' ? 'Ingen utrustning matchar filtret.' : personId ? 'Ingen utrustning är utlämnad till personen.' : 'Ingen utrustning är registrerad ännu.'}</strong></div>}</article>
      {personId && <article className="office-panel equipment-history-panel"><h3><Clock3 size={17} />Historik</h3>{history.length ? <ol className="equipment-history">{history.map(event => <li key={event.id}><strong>{event.text}</strong><small>{equipmentTime(event.at)}{event.actor ? ` · ${event.actor}` : ''}</small>{event.note && <p>{event.note}</p>}</li>)}</ol> : <p className="equipment-help">Inga utlämningar eller återlämningar finns registrerade.</p>}</article>}
    </>}
    {modal && <Dialog title={modal.kind === 'view' ? selected?.name ?? 'Utrustning' : modal.kind === 'edit' ? modal.asset?.id ? 'Redigera utrustning' : 'Registrera utrustning' : modal.kind === 'issue' ? 'Lämna ut utrustning' : 'Återlämna utrustning'} onClose={close}>
      {error && <Alert tone="red">{error}</Alert>}
      {modal.kind === 'view' && selected ? <><div className="equipment-detail-facts"><Fact label="Inventarienummer">{selected.inventoryNumber}</Fact><Fact label="Kategori">{equipmentCategoryLabels[selected.category]}</Fact><Fact label="Status"><Pill tone={statusTone(selected.status)}>{equipmentStatusLabels[selected.status]}</Pill></Fact><Fact label="Anläggning">{siteName(selected.siteId)}</Fact>{selected.serialNumber && <Fact label="Serienummer">{selected.serialNumber}</Fact>}{selectedAssignment && <><Fact label="Utlämnad till">{personName(selectedAssignment.personId)}</Fact><Fact label="Utlämnad">{equipmentTime(selectedAssignment.issuedAt)}</Fact></>}{selected.description && <p className="equipment-description">{selected.description}</p>}</div>
        {writable && <div className="equipment-dialog-actions"><button className="office-btn outline" onClick={() => open({ kind: 'edit', itemId: selected.id, asset: assetForm(selected), note: '', condition: 'available' })}><Pencil size={15} />Redigera</button>{selected.status === 'available' && <button className="office-btn" onClick={() => issue(selected)}><UserRound size={15} />Lämna ut</button>}{selected.status === 'issued' && <button className="office-btn" onClick={() => open({ kind: 'return', itemId: selected.id, note: '', condition: 'available' })}><Undo2 size={15} />Återlämna</button>}</div>}
        <h3 className="equipment-dialog-history-heading">Historik</h3>{itemHistory.length ? <ol className="equipment-history">{itemHistory.map(event => <li key={event.id}><strong>{event.text}</strong><small>{equipmentTime(event.at)}{event.actor ? ` · ${event.actor}` : ''}</small>{event.note && <p>{event.note}</p>}</li>)}</ol> : <p className="equipment-help">Ingen historik finns registrerad.</p>}
      </> : <form onSubmit={submit}>
        {modal.kind === 'edit' && modal.asset && <div className="hr-form-grid"><Field label="Inventarienummer"><input required maxLength={80} value={modal.asset.inventoryNumber} disabled={busy} onChange={event => changeAsset({ inventoryNumber: event.target.value })} placeholder="UTR-001" /></Field><Field label="Namn"><input required maxLength={150} value={modal.asset.name} disabled={busy} onChange={event => changeAsset({ name: event.target.value })} placeholder="Telefon, borrmaskin eller skyddsutrustning" /></Field><Field label="Kategori"><select value={modal.asset.category} disabled={busy} onChange={event => changeAsset({ category: event.target.value as EquipmentCategory })}>{Object.entries(equipmentCategoryLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field><Field label="Anläggning"><select value={modal.asset.siteId} required disabled={busy} onChange={event => changeAsset({ siteId: event.target.value })}><option value="">Välj anläggning</option>{response?.sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></Field><Field label="Serienummer · valfritt"><input maxLength={150} value={modal.asset.serialNumber} disabled={busy} onChange={event => changeAsset({ serialNumber: event.target.value })} /></Field><Field label="Status">{modal.asset.status === 'issued' ? <Pill>Utlämnad</Pill> : <select value={modal.asset.status} disabled={busy} onChange={event => changeAsset({ status: event.target.value as EquipmentStatus })}>{(['available', 'maintenance', 'retired'] as const).map(id => <option key={id} value={id}>{equipmentStatusLabels[id]}</option>)}</select>}</Field><Field label="Beskrivning · valfritt" full><textarea rows={3} maxLength={1000} value={modal.asset.description} disabled={busy} onChange={event => changeAsset({ description: event.target.value })} /></Field></div>}
        {modal.kind === 'issue' && <div className="hr-form-grid"><Field label="Utrustning" full><select required value={modal.itemId ?? ''} disabled={busy} onChange={event => change({ itemId: event.target.value, personId: personId ?? '' })}><option value="">Välj utrustning</option>{availableItems.map(item => <option key={item.id} value={item.id}>{item.inventoryNumber} · {item.name}</option>)}</select></Field><Field label="Person" full><select value={modal.personId ?? ''} required disabled={busy || !!personId} onChange={event => change({ personId: event.target.value })}><option value="">Välj person</option>{response?.people.filter(value => value.active && (!selected || value.siteIds.includes(selected.siteId))).map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></Field></div>}
        {modal.kind === 'return' && selected && <><div className="equipment-return-summary"><strong>{selected.inventoryNumber} · {selected.name}</strong><p>Utlämnad till {selectedAssignment ? personName(selectedAssignment.personId) : 'personen'}.</p></div><Field label="Skick vid återlämning"><select value={modal.condition} disabled={busy} onChange={event => change({ condition: event.target.value as EquipmentReturnCondition })}><option value="available">Kan lämnas ut igen</option><option value="maintenance">Behöver service eller kontroll</option></select></Field></>}
        {['issue', 'return'].includes(modal.kind) && <Field label="Notering · valfritt" full><textarea rows={3} maxLength={1000} value={modal.note} disabled={busy} onChange={event => change({ note: event.target.value })} /></Field>}
        <div className="equipment-dialog-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={close}>Avbryt</button><button type="submit" className="office-btn" disabled={busy || pending === 'load' || !writable || modal.kind === 'issue' && (!selected || !modal.personId)}>{busy && <LoaderCircle size={15} className="equipment-spin" />}{busy ? 'Sparar…' : modal.kind === 'edit' ? 'Spara utrustning' : modal.kind === 'issue' ? 'Lämna ut utrustning' : 'Registrera återlämning'}</button></div>
      </form>}
    </Dialog>}
  </section>;
}
