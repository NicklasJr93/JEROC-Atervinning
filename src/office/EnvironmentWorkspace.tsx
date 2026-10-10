import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronRight, CircleAlert, FileText, Leaf, Package, PlugZap, RefreshCw, Search, X } from 'lucide-react';
import { can, type OfficeUser } from './model';
import type { EnvironmentalReport, EnvironmentalReportHistory, IncomingEnvironmentalDocument, NvvIntegrationStatus, NvvReportStatus } from './environment-types';
import { environmentTime, environmentWeight, formatWasteCode, transportModeNames } from './environment-types';
import { environmentApi } from './environment-client';
import { EnvironmentAccessBoundary, environmentFailure, useEnvironmentSession } from './EnvironmentSession';
import { nvvModeLabel } from './NvvIntegrationPanel';
import NvvReportPanel, { nvvStatusLabels, nvvStatusTone } from './NvvReportPanel';
import './environment.css';

const dueDate = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Stockholm' });
const today = () => new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Europe/Stockholm' }).format(new Date());
const isCompleted = (report: EnvironmentalReport) => report.status === 'reported' || report.status === 'simulated';
const documentLabel = (document: IncomingEnvironmentalDocument) => {
  if (document.status === 'not_required') return 'Behövs ej';
  if (document.status === 'not_shown') return 'Ej uppvisat';
  if (document.status === 'missing') return `Saknas · ${document.missingReason ?? ''}`;
  if (document.status === 'provided' || document.reference) return document.reference || 'Dokument finns · utan referensnummer';
  return 'Inte kontrollerat';
};
type Selection = { id: string; version?: number; priorVersion: boolean };
type HistoryRow = { report: EnvironmentalReport | EnvironmentalReportHistory; priorVersion: boolean };

export default function EnvironmentWorkspace({ user, actualUser, onNotice, siteId = 'all', onOpenCard }: {
  user: OfficeUser; actualUser: OfficeUser; onNotice: (message: string) => void; siteId?: string; onOpenCard?: (id: number) => void;
}) {
  const { state, session, refresh, loading } = useEnvironmentSession();
  const [tab, setTab] = useState<'active' | 'history' | 'inventory'>('active');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [selection, setSelection] = useState<Selection>();
  const [nvv, setNvv] = useState<NvvIntegrationStatus>();
  const [nvvError, setNvvError] = useState('');
  useEffect(() => { setSelection(undefined); setQuery(''); setStatus(''); setTab('active'); setNvv(undefined); setNvvError(''); }, [user.id, actualUser.id]);
  useEffect(() => {
    if (!session) return;
    let current = true;
    const controller = new AbortController();
    async function loadStatus() {
      try { const next = await environmentApi.nvvStatus(controller.signal); if (current) { setNvv(next); setNvvError(''); } }
      catch (failure) { if (current && !controller.signal.aborted) setNvvError(environmentFailure(failure)); }
    }
    void loadStatus();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void loadStatus(); }, 5000);
    return () => { current = false; controller.abort(); window.clearInterval(timer); };
  }, [session?.actualUserId, session?.effectiveUserId]);

  const receipts = (state?.receipts ?? []).filter(receipt => siteId === 'all' || !siteId || receipt.siteId === siteId);
  const reports = (state?.reports ?? []).filter(report => siteId === 'all' || !siteId || report.siteId === siteId);
  const active = reports.filter(report => !isCompleted(report));
  const inventory = (state?.inventory ?? []).filter(item => siteId === 'all' || !siteId || item.siteId === siteId);
  const priorReports = (state?.reportHistory ?? []).filter(report => siteId === 'all' || !siteId || report.siteId === siteId);
  const history: HistoryRow[] = [
    ...reports.filter(isCompleted).map(report => ({ report, priorVersion: false })),
    ...priorReports.map(report => ({ report, priorVersion: true })),
  ].sort((a, b) => b.report.createdAt.localeCompare(a.report.createdAt) || (b.report.version ?? 1) - (a.report.version ?? 1));
  const selected = selection?.priorVersion
    ? priorReports.find(report => report.id === selection.id && report.version === selection.version)
    : reports.find(report => report.id === selection?.id);
  const selectedReceipt = selected ? receipts.find(receipt => receipt.id === selected.receiptId) : undefined;
  const selectedVersion = selection?.priorVersion ? selected?.version : selectedReceipt?.version;
  const selectedSnapshot = selection?.priorVersion && selectedReceipt
    ? (selectedVersion === 1 ? selectedReceipt.originalSnapshot ?? selectedReceipt.snapshot : selectedReceipt.correctionHistory?.find(correction => correction.version === selectedVersion)?.snapshot)
    : selectedReceipt?.snapshot;
  const selectReport = (report: EnvironmentalReport | EnvironmentalReportHistory, priorVersion = false) => setSelection({ id: report.id, version: report.version, priorVersion });
  useEffect(() => { if (selection && state && (!selected || !selectedReceipt)) setSelection(undefined); }, [selection, state, selected, selectedReceipt]);
  useEffect(() => {
    if (!selected) return;
    const previous = document.activeElement;
    const dialog = document.querySelector<HTMLElement>('.environment-detail-dialog');
    dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelection(undefined);
      if (event.key === 'Tab' && dialog) {
        const elements = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary')];
        const first = elements[0]; const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [selection?.id, selection?.version, selection?.priorVersion]);
  const filtered = active.filter(report => (!status || report.status === status) && `${report.id} ${report.cardId} ${report.wasteCode} ${report.wasteDescription} ${receipts.find(receipt => receipt.id === report.receiptId)?.snapshot.previousHolder.name ?? ''}`.toLocaleLowerCase('sv-SE').includes(query.trim().toLocaleLowerCase('sv-SE'))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
  const deviationCount = receipts.filter(receipt => receipt.deviations.length > 0).length;
  async function reload() { try { await refresh(); setNvv(await environmentApi.nvvStatus()); onNotice('Miljöunderlagen och NVV-statusen är uppdaterade.'); } catch { /* Error is shown by the session boundary. */ } }

  return <section className="environment-workspace" data-user={user.id}>
    <div className="office-title environment-workspace-title"><div><span className="office-eyebrow">MOTTAGNING & LAGER</span><h1>Miljörapportering</h1><p>Mottagningsunderlag, NVV-rapportering och lagerrörelser.</p></div><div className="environment-title-actions"><span className={`environment-pill ${nvv?.connected ? 'success' : 'warning'}`}><Leaf size={14} />{nvv ? nvvModeLabel(nvv.mode) : 'NVV · hämtar status'}</span>{can(user, 'integrationsRead') && <Link to="/integrations?service=nvv" className="office-btn outline"><PlugZap size={14} />NVV-inställningar</Link>}<button type="button" className="office-btn outline" onClick={() => void reload()} disabled={loading}><RefreshCw size={14} />Uppdatera</button></div></div>
    <EnvironmentAccessBoundary>
      {!!nvvError && <div className="environment-error" role="alert"><CircleAlert size={16} />{nvvError}</div>}
      <div className="environment-stats">
        <article><span className="environment-stat-icon warning"><CircleAlert size={23} /></span><div><strong>{active.filter(report => ['incomplete', 'error', 'unknown', 'correction_required'].includes(report.status)).length}</strong><h2>Behöver åtgärd</h2><small>Komplettering, rättelse eller svarskontroll</small></div></article>
        <article><span className="environment-stat-icon success"><CheckCircle2 size={23} /></span><div><strong>{active.filter(report => report.status === 'ready').length}</strong><h2>Klara för rapportering</h2><small>Väntar på explicit sändning</small></div></article>
        <article><span className="environment-stat-icon warning"><FileText size={22} /></span><div><strong>{deviationCount}</strong><h2>Avvikelser</h2><small>Transportdokument att följa upp</small></div></article>
        <article><span className="environment-stat-icon success"><Package size={23} /></span><div><strong>{environmentWeight(inventory.reduce((sum, item) => sum + item.weight, 0))}</strong><h2>Registrerat lager</h2><small>{inventory.length} sparade lagerrörelser</small></div></article>
      </div>
      <div className="office-panel environment-list-panel">
        <div className="environment-list-tools"><div className="environment-tabs" role="tablist" aria-label="Miljöunderlag">
          <button type="button" role="tab" aria-selected={tab === 'active'} className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>Aktiva {active.length > 0 && <span>{active.length}</span>}</button>
          <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Historik {history.length > 0 && <span>{history.length}</span>}</button>
          <button type="button" role="tab" aria-selected={tab === 'inventory'} className={tab === 'inventory' ? 'active' : ''} onClick={() => setTab('inventory')}>Lager</button>
        </div>{tab === 'active' && <><label className="environment-search"><Search size={16} /><input aria-label="Sök miljöunderlag" placeholder="Sök invägning, innehavare eller avfall…" value={query} onChange={event => setQuery(event.target.value)} /></label><select aria-label="Filtrera miljöstatus" value={status} onChange={event => setStatus(event.target.value)}><option value="">Alla statusar</option>{(['ready', 'incomplete', 'sending', 'error', 'unknown', 'correction_required'] as NvvReportStatus[]).map(value => <option value={value} key={value}>{nvvStatusLabels[value]}</option>)}</select></>}</div>
        {tab === 'active' && <><div className="office-table-wrap"><table className="office-table environment-table"><thead><tr><th>Miljöärende / källa</th><th>Tidigare innehavare</th><th>Avfall / vikt</th><th>Anläggning</th><th>Frister</th><th>Status</th><th /></tr></thead><tbody>{filtered.map(report => {
          const receipt = receipts.find(item => item.id === report.receiptId);
          return <tr key={report.id}><td><button type="button" className="office-link" onClick={() => selectReport(report)}>{report.id}</button><small>Invägningskort INV-{report.cardId}</small></td><td><strong>{receipt?.snapshot.previousHolder.name}</strong><small>{receipt?.snapshot.previousHolder.number}</small></td><td><strong>{report.wasteDescription}</strong><small>{formatWasteCode(report.wasteCode)} · {environmentWeight(report.weight)}</small></td><td>{state?.sites.find(site => site.id === report.siteId)?.name ?? report.siteId}</td><td className={report.reportDueDate < today() ? 'environment-overdue' : ''}><strong>Anteckning: {dueDate(report.noteDueDate)}</strong><small>Rapportering: {dueDate(report.reportDueDate)}</small></td><td><span className={`environment-pill ${nvvStatusTone(report.status)}`}>{nvvStatusLabels[report.status]}</span>{receipt?.deviations.length ? <small className="environment-deviation-text"><CircleAlert size={12} />Dokumentavvikelse</small> : null}</td><td><button type="button" className="office-link" aria-label={`Visa miljöunderlag för INV-${report.cardId}`} onClick={() => selectReport(report)}>Visa <ChevronRight size={14} /></button></td></tr>;
        })}</tbody></table></div>{!filtered.length && <div className="environment-empty"><Leaf size={30} /><h2>{query || status ? 'Inga miljöunderlag matchar' : reports.length ? 'Inga underlag väntar på åtgärd' : 'Inga mottagningsunderlag ännu'}</h2><p>{reports.length ? 'Bekräftade test- och simuleringsresultat finns i Historik.' : 'Bekräfta mottagning på ett invägningskort med farligt avfall. Underlaget visas här för alla behöriga kassor.'}</p></div>}</>}
        {tab === 'history' && <>{history.length ? <div className="office-table-wrap"><table className="office-table environment-table"><thead><tr><th>Invägning / version</th><th>Material / mängd</th><th>Status</th><th>Rättelse / kvittens</th><th /></tr></thead><tbody>{history.map(({ report, priorVersion }) => {
          const receipt = receipts.find(item => item.id === report.receiptId);
          const correction = priorVersion ? receipt?.correctionHistory?.find(item => item.version === (report.version ?? 1) + 1) : undefined;
          return <tr key={`${report.id}/${report.version ?? receipt?.version ?? 1}/${priorVersion}`}><td><strong>INV-{report.cardId}</strong><small>Mottagningsversion {report.version ?? receipt?.version ?? 1}</small></td><td><strong>{report.wasteDescription}</strong><small>{formatWasteCode(report.wasteCode)} · {environmentWeight(report.weight)}</small></td><td><span className={`environment-pill ${priorVersion ? '' : nvvStatusTone(report.status as NvvReportStatus)}`}>{priorVersion ? 'Ersatt av rättelse' : nvvStatusLabels[report.status as NvvReportStatus]}</span></td><td>{priorVersion ? correction?.reason || 'Ny mottagningsversion' : report.nvv?.avfallId || 'Sparad rapportkvittens'}<small>{correction ? `${environmentTime(correction.createdAt)} · ${correction.createdBy}` : ''}</small></td><td><button type="button" className="office-link" aria-label={`Visa miljöhistorik för INV-${report.cardId} version ${report.version ?? receipt?.version ?? 1}`} onClick={() => selectReport(report, priorVersion)}>Visa <ChevronRight size={14} /></button></td></tr>;
        })}</tbody></table></div> : <div className="environment-empty"><FileText size={30} /><h2>Inga tidigare miljöversioner ännu</h2><p>Bekräftade rapporteringar och tidigare mottagningsversioner bevaras här.</p></div>}</>}
        {tab === 'inventory' && <><div className="office-table-wrap"><table className="office-table environment-table"><thead><tr><th>Material</th><th>Anläggning</th><th>Registrerad mängd</th><th>Lagerrörelser</th></tr></thead><tbody>{stockGroups.map((group, index) => <tr key={`${group.siteId}/${group.articleId}/${group.wasteCode}/${index}`}><td><strong>{group.description}</strong><small>{group.wasteCode ? formatWasteCode(group.wasteCode, group.hazardous) : 'Ingen avfallskod registrerad'}{group.hazardous ? ' · Farligt avfall' : ''}</small></td><td>{state?.sites.find(item => item.id === group.siteId)?.name ?? group.siteId}</td><td><strong>{environmentWeight(group.weight)}</strong></td><td>{group.count} lagerrörelser</td></tr>)}</tbody></table></div>{!stockGroups.length && <div className="environment-empty"><Package size={30} /><h2>Inga lagerrörelser ännu</h2><p>En bekräftad mottagning skapar en lagerrörelse per material.</p></div>}<div className="environment-info"><Package size={17} />Registrerade mottagningar, rättelser och faktiska utleveranser. NVV-kvittensen ändrar inte lagret.</div></>}
      </div>
      <div className="environment-info"><Leaf size={17} />{nvv?.mode === 'test' ? 'Endast uttrycklig sändning till NVV:s testmiljö. Inga produktionsrapporter skickas.' : nvv?.mode === 'mock' ? 'Simuleringsläge · inga uppgifter skickas till Naturvårdsverket.' : 'NVV-rapportering är avstängd. Mottagningsunderlagen är sparade på servern.'} Miljöfristerna följer den faktiska mottagningen.</div>
      {selected && selectedReceipt && selectedSnapshot && <div className="environment-detail-backdrop"><section className="environment-detail-dialog" role="dialog" aria-modal="true" aria-label={`Miljöunderlag INV-${selected.cardId}`}>
        <header><div><span className="office-eyebrow">INSAMLARENS MOTTAGNING</span><h2>Miljöunderlag · INV-{selected.cardId}</h2><p>{environmentTime(selectedSnapshot.receivedAt)} · {state?.sites.find(item => item.id === selected.siteId)?.name}</p></div><button type="button" className="environment-toggle" aria-label="Stäng miljöunderlag" onClick={() => setSelection(undefined)}><X size={21} /></button></header>
        <div className="environment-info"><FileText size={18} /><strong>Mottagningsversion {selectedVersion}</strong>{selection?.priorVersion ? 'Tidigare låst version · ersatt av rättelse' : 'Låst mottagningsunderlag · originalet bevaras'}</div>
        <dl className="environment-detail-facts">
          <div><dt>Avfall</dt><dd>{selected.wasteDescription} · {formatWasteCode(selected.wasteCode)}</dd></div><div><dt>Mängd</dt><dd>{environmentWeight(selected.weight)}</dd></div>
          <div><dt>Tidigare innehavare</dt><dd>{selectedSnapshot.previousHolder.name} · {selectedSnapshot.previousHolder.number}</dd></div>
          <div><dt>Kontakt</dt><dd>{[selectedSnapshot.previousHolder.contactName, selectedSnapshot.previousHolder.email, selectedSnapshot.previousHolder.phone].filter(Boolean).join(' · ') || '–'}</dd></div>
          <div><dt>Senaste hanteringsplats</dt><dd>{selectedSnapshot.lastPlace.address}, {selectedSnapshot.lastPlace.postalCode} {selectedSnapshot.lastPlace.city} · kommun {selectedSnapshot.lastPlace.municipalityCode}</dd></div>
          <div><dt>Kommande hanteringsplats</dt><dd>{selectedSnapshot.nextPlace.address}, {selectedSnapshot.nextPlace.postalCode} {selectedSnapshot.nextPlace.city} · kommun {selectedSnapshot.nextPlace.municipalityCode}</dd></div>
          <div><dt>Transportsätt</dt><dd>{transportModeNames[selectedSnapshot.transportMode]}</dd></div><div><dt>Transportdokument</dt><dd>{documentLabel(selectedSnapshot.incomingDocument)}</dd></div>
          <div><dt>Anteckning senast</dt><dd>{dueDate(selected.noteDueDate)}</dd></div><div><dt>Rapportering senast</dt><dd>{dueDate(selected.reportDueDate)}</dd></div>
        </dl>
        {selectedReceipt.deviations.map(deviation => <div className="environment-alert" key={deviation.code}><CircleAlert size={17} />{deviation.message}</div>)}
        <NvvReportPanel key={`${user.id}/${actualUser.id}/${selected.id}/${selectedVersion}/${selection?.priorVersion}`} report={selected} receiptVersion={selectedVersion ?? 1} user={user} integration={nvv} historic={selection?.priorVersion} onRefresh={refresh} onNotice={onNotice} />
        <small className="environment-snapshot-hash">Original {selectedReceipt.id} · Kontrollsumma {selectedReceipt.originalHash || selectedReceipt.hash}</small>
        {onOpenCard && <div className="environment-actions"><button type="button" className="office-btn outline" onClick={() => { setSelection(undefined); onOpenCard(selected.cardId); }}>Öppna invägning INV-{selected.cardId}<ChevronRight size={15} /></button></div>}
      </section></div>}
    </EnvironmentAccessBoundary>
  </section>;
}
