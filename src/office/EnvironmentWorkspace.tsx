import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, CircleAlert, FileText, Leaf, Package, RefreshCw, Search, X } from 'lucide-react';
import type { OfficeUser } from './model';
import type { EnvironmentalReport, IncomingEnvironmentalDocument } from './environment-types';
import { environmentTime, environmentWeight, formatWasteCode, transportModeNames } from './environment-types';
import { EnvironmentAccessBoundary, useEnvironmentSession } from './EnvironmentSession';
import './environment.css';

const dueDate = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Stockholm' });
const today = () => new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Europe/Stockholm' }).format(new Date());
const documentLabel = (document: IncomingEnvironmentalDocument) => {
  if (document.status === 'not_required') return 'Behövs ej';
  if (document.status === 'not_shown') return 'Ej uppvisat';
  if (document.status === 'missing') return `Saknas · ${document.missingReason ?? ''}`;
  if (document.status === 'provided' || document.reference) return document.reference || 'Dokument finns · utan referensnummer';
  return 'Inte kontrollerat';
};
export default function EnvironmentWorkspace({ user, actualUser, onNotice, siteId = 'all', onOpenCard }: { user: OfficeUser; actualUser: OfficeUser; onNotice: (message: string) => void; siteId?: string; onOpenCard?: (id: number) => void }) {
  const { state, refresh, loading } = useEnvironmentSession();
  const [tab, setTab] = useState<'active' | 'history' | 'inventory'>('active');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<EnvironmentalReport>();
  useEffect(() => { setSelected(undefined); setQuery(''); setStatus(''); setTab('active'); }, [user.id, actualUser.id]);
  useEffect(() => {
    if (!selected) return;
    const current = state?.reports.find(report => report.id === selected.id);
    if (!current || (siteId !== 'all' && current.siteId !== siteId)) setSelected(undefined);
    else if (current !== selected) setSelected(current);
  }, [selected?.id, state?.reports, siteId]);
  useEffect(() => {
    if (!selected) return;
    const previous = document.activeElement;
    const dialog = document.querySelector<HTMLElement>('.environment-detail-dialog');
    const button = dialog?.querySelector<HTMLButtonElement>('button'); button?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(undefined);
      if (event.key === 'Tab' && dialog) {
        const elements = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])')];
        const first = elements[0]; const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [selected?.id]);
  const receipts = (state?.receipts ?? []).filter(receipt => siteId === 'all' || !siteId || receipt.siteId === siteId);
  const reports = (state?.reports ?? []).filter(report => siteId === 'all' || !siteId || report.siteId === siteId);
  const inventory = (state?.inventory ?? []).filter(item => siteId === 'all' || !siteId || item.siteId === siteId);
  const history = (state?.reportHistory ?? []).filter(report => siteId === 'all' || !siteId || report.siteId === siteId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version);
  const filtered = reports.filter(report => (!status || report.status === status) && `${report.id} ${report.cardId} ${report.wasteCode} ${report.wasteDescription} ${receipts.find(receipt => receipt.id === report.receiptId)?.snapshot.previousHolder.name ?? ''}`.toLocaleLowerCase('sv-SE').includes(query.trim().toLocaleLowerCase('sv-SE'))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const stockGroups = useMemo(() => {
    const groups = new Map<string, { articleId: string; wasteCode: string; siteId: string; weight: number; count: number; description: string; hazardous: boolean }>();
    for (const entry of inventory) {
      const receipt = receipts.find(receipt => receipt.id === entry.receiptId);
      const original = entry.classification ?? (receipt?.originalSnapshot ?? receipt?.snapshot)?.rows.find(row => row.articleId === entry.articleId && row.classification.wasteCode === entry.wasteCode)?.classification;
      const key = `${entry.siteId}/${entry.articleId}/${entry.wasteCode}/${original?.version ?? 0}`;
      const prior = groups.get(key);
      if (prior) { prior.weight += entry.weight; prior.count++; }
      else groups.set(key, { articleId: entry.articleId, wasteCode: entry.wasteCode, siteId: entry.siteId, weight: entry.weight, count: 1, description: original?.wasteDescription || entry.articleId, hazardous: original?.hazardous ?? false });
    }
    return [...groups.values()];
  }, [inventory, receipts]);
  const selectedReceipt = selected ? receipts.find(receipt => receipt.id === selected.receiptId) : undefined;
  const deviationCount = receipts.filter(receipt => receipt.deviations.length > 0).length;
  async function reload() { try { await refresh(); onNotice('Miljöunderlagen är uppdaterade från servern.'); } catch { /* Error is shown by the session boundary. */ } }
  return <section className="environment-workspace" data-user={user.id}>
    <div className="office-title environment-workspace-title"><div><span className="office-eyebrow">MOTTAGNING & LAGER</span><h1>Miljörapportering</h1><p>Mottagningsunderlag, avvikelser och inkommande lager.</p></div><div className="environment-title-actions"><span className="environment-pill warning"><CircleAlert size={14} />Naturvårdsverket · ej ansluten</span><button type="button" className="office-btn outline" onClick={() => void reload()} disabled={loading}><RefreshCw size={14} />Uppdatera</button></div></div>
    <EnvironmentAccessBoundary><div className="environment-stats"><article><span className="environment-stat-icon"><FileText size={22} /></span><div><strong>{reports.filter(report => report.status === 'incomplete').length}</strong><h2>Saknar uppgifter</h2><small>Måste kompletteras</small></div></article><article><span className="environment-stat-icon success"><CheckCircle2 size={23} /></span><div><strong>{reports.filter(report => report.status === 'ready').length}</strong><h2>Förberedda underlag</h2><small>Ej skickade till myndigheten</small></div></article><article><span className="environment-stat-icon warning"><CircleAlert size={23} /></span><div><strong>{deviationCount}</strong><h2>Avvikelser</h2><small>Transportdokument att följa upp</small></div></article><article><span className="environment-stat-icon success"><Package size={23} /></span><div><strong>{environmentWeight(inventory.reduce((sum, item) => sum + item.weight, 0))}</strong><h2>Inkommande lager</h2><small>{inventory.length} sparade lagerrörelser</small></div></article></div>
      <div className="office-panel environment-list-panel"><div className="environment-list-tools"><div className="environment-tabs" role="tablist" aria-label="Miljöunderlag"><button type="button" role="tab" aria-selected={tab === 'active'} className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>Aktiva <span>{reports.length}</span></button><button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Historik <span>{history.length}</span></button><button type="button" role="tab" aria-selected={tab === 'inventory'} className={tab === 'inventory' ? 'active' : ''} onClick={() => setTab('inventory')}>Lager</button></div>{tab === 'active' && <><label className="environment-search"><Search size={16} /><input aria-label="Sök miljöunderlag" placeholder="Sök invägning, innehavare eller avfall…" value={query} onChange={event => setQuery(event.target.value)} /></label><select aria-label="Filtrera miljöstatus" value={status} onChange={event => setStatus(event.target.value)}><option value="">Alla statusar</option><option value="ready">Förberett – ej skickat</option><option value="incomplete">Saknar uppgifter</option></select></>}</div>
        {tab === 'active' && <><div className="office-table-wrap"><table className="office-table environment-table"><thead><tr><th>Miljöärende / källa</th><th>Tidigare innehavare</th><th>Avfall / vikt</th><th>Anläggning</th><th>Frister</th><th>Status</th><th /></tr></thead><tbody>{filtered.map(report => {
          const receipt = receipts.find(item => item.id === report.receiptId);
          return <tr key={report.id}><td><button type="button" className="office-link" onClick={() => setSelected(report)}>{report.id}</button><small>Invägningskort INV-{report.cardId}</small></td><td><strong>{receipt?.snapshot.previousHolder.name}</strong><small>{receipt?.snapshot.previousHolder.number}</small></td><td><strong>{report.wasteDescription}</strong><small>{formatWasteCode(report.wasteCode)} · {environmentWeight(report.weight)}</small></td><td>{state?.sites.find(site => site.id === report.siteId)?.name ?? report.siteId}</td><td className={report.reportDueDate < today() ? 'environment-overdue' : ''}><strong>Anteckning: {dueDate(report.noteDueDate)}</strong><small>Rapportering: {dueDate(report.reportDueDate)}</small></td><td><span className={`environment-pill ${report.status === 'ready' ? 'success' : 'warning'}`}>{report.status === 'ready' ? 'Förberett – ej skickat' : 'Saknar uppgifter'}</span>{receipt?.deviations.length ? <small className="environment-deviation-text"><CircleAlert size={12} />Dokumentavvikelse</small> : null}</td><td><button type="button" className="office-link" aria-label={`Visa miljöunderlag för INV-${report.cardId}`} onClick={() => setSelected(report)}>Visa <ChevronRight size={14} /></button></td></tr>;
        })}</tbody></table></div>{!filtered.length && <div className="environment-empty"><Leaf size={30} /><h2>{query || status ? 'Inga miljöunderlag matchar' : 'Inga mottagningsunderlag ännu'}</h2><p>Bekräfta mottagning på ett invägningskort med farligt avfall. Underlaget visas här för alla behöriga kassor.</p></div>}</>}
        {tab === 'history' && <>{history.length ? <div className="office-table-wrap"><table className="office-table environment-table"><thead><tr><th>Invägning / version</th><th>Material</th><th>Tidigare mängd</th><th>Rättelse</th><th /></tr></thead><tbody>{history.map(report => {
          const receipt = receipts.find(item => item.id === report.receiptId);
          const correction = receipt?.correctionHistory?.find(item => item.version === report.version + 1);
          return <tr key={`${report.id}/${report.version}`}><td><strong>INV-{report.cardId}</strong><small>Version {report.version} · Ersatt av rättelse</small></td><td>{report.wasteDescription}<small>{formatWasteCode(report.wasteCode)}</small></td><td>{environmentWeight(report.weight)}</td><td>{correction?.reason || 'Ny mottagningsversion'}<small>{correction ? `${environmentTime(correction.createdAt)} · ${correction.createdBy}` : ''}</small></td><td>{onOpenCard && <button type="button" className="office-link" onClick={() => onOpenCard(report.cardId)}>Visa invägning <ChevronRight size={14} /></button>}</td></tr>;
        })}</tbody></table></div> : <div className="environment-empty"><FileText size={30} /><h2>Inga tidigare miljöversioner ännu</h2><p>När en mottagning rättas sparas tidigare underlag här. Inga myndighetsrapporter har skickats.</p></div>}</>}
        {tab === 'inventory' && <><div className="office-table-wrap"><table className="office-table environment-table"><thead><tr><th>Material</th><th>Anläggning</th><th>Inkommande mängd</th><th>Lagerrörelser</th></tr></thead><tbody>{stockGroups.map((group, index) => <tr key={`${group.siteId}/${group.articleId}/${group.wasteCode}/${index}`}><td><strong>{group.description}</strong><small>{group.wasteCode ? formatWasteCode(group.wasteCode, group.hazardous) : 'Ingen avfallskod registrerad'}{group.hazardous ? ' · Farligt avfall' : ''}</small></td><td>{state?.sites.find(item => item.id === group.siteId)?.name ?? group.siteId}</td><td><strong>{environmentWeight(group.weight)}</strong></td><td>{group.count} lagerrörelser</td></tr>)}</tbody></table></div>{!stockGroups.length && <div className="environment-empty"><Package size={30} /><h2>Inga inkommande lagerrörelser ännu</h2><p>En bekräftad mottagning skapar en lagerrörelse per material.</p></div>}<div className="environment-info"><Package size={17} />Visar inkommande mängd. Utleveranser och lageravdrag byggs i nästa etapp.</div></>}
      </div><div className="environment-info"><Leaf size={17} />Förberett demo-underlag · inga uppgifter skickas till Naturvårdsverket. Kundgodkännande och betalning styr inte miljöfristerna.</div>
      {selected && selectedReceipt && <div className="environment-detail-backdrop"><section className="environment-detail-dialog" role="dialog" aria-modal="true" aria-label={`Miljöunderlag INV-${selected.cardId}`}><header><div><span className="office-eyebrow">INSAMLARENS MOTTAGNING</span><h2>Miljöunderlag · INV-{selected.cardId}</h2><p>{environmentTime(selectedReceipt.receivedAt)} · {state?.sites.find(item => item.id === selected.siteId)?.name}</p></div><button type="button" className="environment-toggle" aria-label="Stäng miljöunderlag" onClick={() => setSelected(undefined)}><X size={21} /></button></header><div className="environment-info"><FileText size={18} /><strong>Förberett – ej skickat</strong>Aktuell mottagningsversion {selectedReceipt.version} · Originalet bevaras</div><dl className="environment-detail-facts"><div><dt>Avfall</dt><dd>{selected.wasteDescription} · {formatWasteCode(selected.wasteCode)}</dd></div><div><dt>Mängd</dt><dd>{environmentWeight(selected.weight)}</dd></div><div><dt>Tidigare innehavare</dt><dd>{selectedReceipt.snapshot.previousHolder.name} · {selectedReceipt.snapshot.previousHolder.number}</dd></div><div><dt>Kontakt</dt><dd>{selectedReceipt.snapshot.previousHolder.contactName} · {selectedReceipt.snapshot.previousHolder.email} · {selectedReceipt.snapshot.previousHolder.phone}</dd></div><div><dt>Senaste hanteringsplats</dt><dd>{selectedReceipt.snapshot.lastPlace.address}, {selectedReceipt.snapshot.lastPlace.postalCode} {selectedReceipt.snapshot.lastPlace.city} · kommun {selectedReceipt.snapshot.lastPlace.municipalityCode}</dd></div><div><dt>Kommande hanteringsplats</dt><dd>{selectedReceipt.snapshot.nextPlace.address}, {selectedReceipt.snapshot.nextPlace.postalCode} {selectedReceipt.snapshot.nextPlace.city} · kommun {selectedReceipt.snapshot.nextPlace.municipalityCode}</dd></div><div><dt>Transportsätt</dt><dd>{transportModeNames[selectedReceipt.snapshot.transportMode]}</dd></div><div><dt>Transportdokument</dt><dd>{documentLabel(selectedReceipt.snapshot.incomingDocument)}</dd></div><div><dt>Anteckning senast</dt><dd>{dueDate(selected.noteDueDate)}</dd></div><div><dt>Rapportering senast</dt><dd>{dueDate(selected.reportDueDate)}</dd></div></dl>{selected.missingFields.length > 0 && <div className="environment-alert"><CircleAlert size={17} /><div><strong>Uppgifter återstår före rapportering</strong>{selected.missingFields.map(field => <p key={field}>{field}</p>)}</div></div>}{selectedReceipt.deviations.map(deviation => <div className="environment-alert" key={deviation.code}><CircleAlert size={17} />{deviation.message}</div>)}<small className="environment-snapshot-hash">Original {selectedReceipt.id} · Kontrollsumma {selectedReceipt.originalHash || selectedReceipt.hash}</small>{onOpenCard && <div className="environment-actions"><button type="button" className="office-btn outline" onClick={() => { setSelected(undefined); onOpenCard(selected.cardId); }}>Öppna invägning INV-{selected.cardId}<ChevronRight size={15} /></button></div>}</section></div>}
    </EnvironmentAccessBoundary>
  </section>;
}
