import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowUpRight, Boxes, Building2, History, Info, PackageCheck, Plus, RefreshCw, Search, ShieldAlert, SlidersHorizontal, X } from 'lucide-react';
import type { OfficeUser } from '../model';
import type { LogisticsOfficeCommand, LogisticsOfficeState, LogisticsStock } from './types';
import { logisticsRequest } from './client';
import './warehouse.css';

export const logisticsKg = (kg: number) => kg.toLocaleString('sv-SE', { maximumFractionDigits: 2 });
export const logisticsDate = (date: string) => new Date(date).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });

export function useLogisticsOffice(actorId: string, userId: string) {
  const [state, setState] = useState<LogisticsOfficeState>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const identity = `${actorId}/${userId}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const loadSequence = useRef(0);
  const request = useCallback(async (command?: LogisticsOfficeCommand, signal?: AbortSignal) => {
    return logisticsRequest(actorId, userId, command, signal);
  }, [actorId, userId]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const expectedIdentity = identity, sequence = ++loadSequence.current;
    try {
      const next = await request(undefined, signal);
      if (expectedIdentity === identityRef.current && sequence === loadSequence.current) { setState(next); setError(''); }
    } catch (failure) {
      if (!signal?.aborted && expectedIdentity === identityRef.current && sequence === loadSequence.current) setError(failure instanceof Error ? failure.message : 'Uppgifterna kunde inte hämtas.');
    } finally { if (expectedIdentity === identityRef.current && !signal?.aborted) setLoading(false); }
  }, [identity, request]);
  useEffect(() => {
    const controller = new AbortController();
    setState(undefined); setError(''); setLoading(true); setBusy(false);
    void refresh(controller.signal);
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(controller.signal); }, 15_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [refresh]);
  const command = async (value: LogisticsOfficeCommand) => {
    const expectedIdentity = identity; setBusy(true); setError(''); ++loadSequence.current;
    try {
      const next = await request(value);
      if (expectedIdentity === identityRef.current) { ++loadSequence.current; setState(next); }
      return next;
    } catch (failure) {
      if (expectedIdentity === identityRef.current) setError(failure instanceof Error ? failure.message : 'Ändringen kunde inte sparas.');
      throw failure;
    } finally { if (expectedIdentity === identityRef.current) setBusy(false); }
  };
  return { state, error, loading, busy, refresh, command };
}

export function LogisticsDialog({ title, children, onClose, className = 'warehouse-dialog' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button,input,select,textarea')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className={className === 'vessels-dialog' ? 'vessels-dialog-backdrop' : 'warehouse-dialog-backdrop'} onMouseDown={event => { if (event.target === event.currentTarget) onCloseRef.current(); }}>
    <div className={className} ref={ref} role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onCloseRef.current(); }
      if (event.key === 'Tab') {
        const elements = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]') ?? [])];
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}><header><h2>{title}</h2><button type="button" aria-label="Stäng" onClick={onClose}><X size={21} /></button></header>{children}</div>
  </div>;
}

export interface WarehouseOutboundPrefill { siteId: string; articleId: string; articleName: string; estimatedKg: number }
export interface WarehouseWorkspaceProps {
  actorId: string; userId: string; user: OfficeUser; selectedSite?: string;
  onNotice?: (message: string) => void; onBookOutbound: (prefill: WarehouseOutboundPrefill) => void;
}
type Adjustment = { mode: 'intake' | 'adjustment'; siteId: string; articleId: string; kg: string; reason: string; idempotencyKey: string };

export default function WarehouseWorkspace({ actorId, userId, selectedSite = 'all', onNotice, onBookOutbound }: WarehouseWorkspaceProps) {
  const { state, error, loading, busy, refresh, command } = useLogisticsOffice(actorId, userId);
  const [siteId, setSiteId] = useState(selectedSite);
  const [search, setSearch] = useState('');
  const [materialScope, setMaterialScope] = useState('all');
  const [adjustment, setAdjustment] = useState<Adjustment>();
  const [history, setHistory] = useState<LogisticsStock>();
  const [formError, setFormError] = useState('');
  useEffect(() => setSiteId(selectedSite), [selectedSite]);
  useEffect(() => { setAdjustment(undefined); setHistory(undefined); setFormError(''); }, [actorId, userId]);
  const sites = state?.sites ?? [];
  const writable = state?.capabilities.includes('warehouseWrite');
  const canBook = state?.capabilities.includes('workOrdersWrite');
  const stock = (state?.stock ?? []).filter(row => (siteId === 'all' || row.siteId === siteId) &&
    `${row.articleName} ${row.wasteCode} ${sites.find(site => site.id === row.siteId)?.name ?? ''}`.toLowerCase().includes(search.toLowerCase()) &&
    (materialScope === 'all' || row.hazardous === (materialScope === 'hazardous')));
  const total = (field: 'onHandKg' | 'reservedKg' | 'availableKg') => stock.reduce((sum, row) => sum + row[field], 0);
  const startAdjustment = (mode: Adjustment['mode'], row?: LogisticsStock) => {
    setFormError(''); setAdjustment({ mode, siteId: row?.siteId ?? (siteId !== 'all' ? siteId : sites[0]?.id ?? ''), articleId: row?.articleId ?? state?.articles.find(article => !article.hazardous)?.id ?? '', kg: '', reason: '', idempotencyKey: crypto.randomUUID() });
  };
  async function saveAdjustment(event: React.FormEvent) {
    event.preventDefault(); if (!adjustment || busy) return;
    const kg = Number(adjustment.kg.replace(/\s/g, '').replace(',', '.'));
    if (!adjustment.siteId || !adjustment.articleId || !Number.isFinite(kg) || kg === 0 || (adjustment.mode === 'intake' && kg < 0) || !adjustment.reason.trim()) { setFormError('Välj anläggning och material. Ange en mängd och en motivering.'); return; }
    try {
      await command({ action: 'inventory.adjust', siteId: adjustment.siteId, articleId: adjustment.articleId, kg, reason: adjustment.reason.trim(), idempotencyKey: adjustment.idempotencyKey });
      setAdjustment(undefined); onNotice?.('Lagerrörelsen är sparad med motivering och ansvarig användare.');
    } catch (failure) { setFormError(failure instanceof Error ? failure.message : 'Lagerrörelsen kunde inte sparas.'); }
  }
  return <section className="warehouse-workspace" aria-label="Lageröversikt">
    <div className="office-title warehouse-title"><div><span className="office-eyebrow">MATERIAL & TILLGÄNGLIGA MÄNGDER</span><h1>Lager</h1><p>Överblick per material och anläggning. Reserverat material finns kvar i det fysiska lagret.</p></div><div className="warehouse-title-actions"><button className="office-btn outline" type="button" onClick={() => void refresh()} aria-label="Uppdatera lagret"><RefreshCw size={15} /></button>{writable && <><button className="office-btn outline" type="button" onClick={() => startAdjustment('adjustment')}><SlidersHorizontal size={15} />Inventeringsrättelse</button><button className="office-btn" type="button" onClick={() => startAdjustment('intake')}><Plus size={16} />Lägg in lager</button></>}</div></div>
    {error && <div className="warehouse-message error" role="alert"><AlertCircle size={17} />{error}</div>}
    {loading ? <div className="warehouse-loading" role="status">Hämtar lager…</div> : <>
      <div className="warehouse-stats"><div className="warehouse-stat"><Boxes size={20} /><div><span>Fysiskt lager</span><strong>{logisticsKg(total('onHandKg'))} kg</strong><small>Registrerad mängd</small></div></div><div className="warehouse-stat"><PackageCheck size={20} /><div><span>Tillgängligt</span><strong>{logisticsKg(total('availableKg'))} kg</strong><small>Kan planeras för utleverans</small></div></div><div className="warehouse-stat"><ArrowDownToLine size={20} /><div><span>Reserverat</span><strong>{logisticsKg(total('reservedKg'))} kg</strong><small>Planerade utleveranser</small></div></div><div className="warehouse-stat"><Building2 size={20} /><div><span>Anläggningar</span><strong>{new Set(stock.map(row => row.siteId)).size}</strong><small>{stock.length} materialposter i urvalet</small></div></div></div>
      <div className="warehouse-toolbar"><label className="warehouse-search"><Search size={16} /><input aria-label="Sök material i lager" placeholder="Sök material eller avfallskod…" value={search} onChange={event => setSearch(event.target.value)} /></label><label><Building2 size={16} /><select aria-label="Anläggning för lager" value={siteId} onChange={event => setSiteId(event.target.value)}><option value="all">Alla anläggningar</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label><select aria-label="Materialtyp i lager" value={materialScope} onChange={event => setMaterialScope(event.target.value)}><option value="all">Alla material</option><option value="ordinary">Vanligt material</option><option value="hazardous">Farligt avfall</option></select></div>
      {stock.length ? <div className="warehouse-materials">{stock.map(row => <article className="warehouse-material" key={`${row.siteId}/${row.articleId}`}><header><div><h2>{row.articleName}</h2><small>{sites.find(site => site.id === row.siteId)?.name ?? row.siteId}</small></div><span className="warehouse-material-icon"><Boxes size={23} /></span></header>{row.hazardous && <span className="warehouse-pill hazardous"><ShieldAlert size={12} />Farligt avfall · {row.wasteCode}</span>}<div className="warehouse-free"><span>Tillgängligt för utleverans</span><strong>{logisticsKg(row.availableKg)}<small>kg</small></strong></div><div className="warehouse-breakdown"><div><span>Fysiskt lager</span><strong>{logisticsKg(row.onHandKg)} kg</strong></div><div><span>Reserverat</span><strong>{logisticsKg(row.reservedKg)} kg</strong></div></div><footer><button type="button" className="warehouse-text-button" onClick={() => setHistory(row)}><History size={14} />Lagerhistorik</button>{canBook && <button type="button" className="office-btn outline" disabled={row.availableKg <= 0} onClick={() => onBookOutbound({ siteId: row.siteId, articleId: row.articleId, articleName: row.articleName, estimatedKg: row.availableKg })}>Boka utleverans<ArrowUpRight size={14} /></button>}</footer></article>)}</div> : <div className="warehouse-empty"><Boxes size={35} /><h2>Inga material i urvalet</h2><p>Ändra sökningen eller välj en annan anläggning.</p></div>}
      <div className="warehouse-message"><Info size={16} />Reservation minskar tillgänglig mängd. Fysiskt lager minskar först när en lastad avfärd bekräftas. Farligt avfall hålls separat från vanligt material i miljörapporteringen.</div>
    </>}
    {adjustment && <LogisticsDialog title={adjustment.mode === 'intake' ? 'Lägg in lager' : 'Inventeringsrättelse'} onClose={() => { if (!busy) setAdjustment(undefined); }}><form onSubmit={event => void saveAdjustment(event)}><p>{adjustment.mode === 'intake' ? 'Registrera befintligt vanligt material med en spårbar motivering.' : 'Ange skillnaden mot registrerat lager. Positiv mängd lägger till, negativ mängd drar av.'}</p><div className="warehouse-form"><label>Anläggning *<select aria-label="Lagerändringens anläggning" value={adjustment.siteId} required onChange={event => setAdjustment({ ...adjustment, siteId: event.target.value })}>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label><label>Material *<select aria-label="Lagerändringens material" value={adjustment.articleId} required onChange={event => setAdjustment({ ...adjustment, articleId: event.target.value })}>{(state?.articles ?? []).filter(article => !article.hazardous).map(article => <option key={article.id} value={article.id}>{article.name}</option>)}</select></label><label className="full">{adjustment.mode === 'intake' ? 'Mängd' : 'Förändring'} (kg) *<input aria-label="Lagerändring i kg" inputMode="decimal" required value={adjustment.kg} placeholder={adjustment.mode === 'intake' ? 'T.ex. 1 000' : 'T.ex. -25 eller 25'} onChange={event => setAdjustment({ ...adjustment, kg: event.target.value })} /></label><label className="full">Motivering *<textarea aria-label="Motivering till lagerändring" required value={adjustment.reason} maxLength={1000} rows={3} placeholder="Beskriv inventeringen eller varifrån den registrerade mängden kommer" onChange={event => setAdjustment({ ...adjustment, reason: event.target.value })} /></label></div><p>Farligt avfall registreras genom faktisk miljömottagning eller miljörättelse.</p>{formError && <div className="warehouse-message error" role="alert">{formError}</div>}<footer><button type="button" className="office-btn outline" disabled={busy} onClick={() => setAdjustment(undefined)}>Avbryt</button><button type="submit" className="office-btn" disabled={busy}>{busy ? 'Sparar…' : 'Spara lagerrörelse'}</button></footer></form></LogisticsDialog>}
    {history && <LogisticsDialog title={`Lagerhistorik · ${history.articleName}`} onClose={() => setHistory(undefined)}><p>{sites.find(site => site.id === history.siteId)?.name} · {logisticsKg(history.onHandKg)} kg i fysiskt lager</p><div className="warehouse-history">{(state?.inventoryMovements ?? []).filter(movement => movement.siteId === history.siteId && movement.articleId === history.articleId).sort((a, b) => b.at.localeCompare(a.at)).map(movement => <div className="warehouse-history-row" key={movement.id}><div><strong>{movement.kind === 'outbound' ? 'Utleverans' : movement.kind === 'receipt' ? 'Mottagning' : 'Inventeringsrättelse'}</strong><small>{logisticsDate(movement.at)}</small><small>{movement.reason}</small></div><strong>{movement.kg > 0 ? '+' : ''}{logisticsKg(movement.kg)} kg</strong></div>)}{!(state?.inventoryMovements ?? []).some(movement => movement.siteId === history.siteId && movement.articleId === history.articleId) && <div className="warehouse-message">Historiken finns i mottagningsunderlagen för detta material.</div>}</div></LogisticsDialog>}
  </section>;
}
