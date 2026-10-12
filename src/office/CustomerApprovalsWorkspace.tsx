import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock3, FileSearch, MessageSquare, Monitor, Search, X } from 'lucide-react';
import { activeApprovalStatuses, approvalLabels, type ApprovalStatus, type PublicSettlement, type TerminalApproval, type TerminalDemoState } from './terminal-demo-types';
import { TerminalServiceNotice } from './TerminalWorkspace';
import { SettlementView } from '../terminal/SettlementView';
import { OfficePageHeader } from './OfficePageHeader';
import { createWeightCardPreview, WeightCardLink, WeightCardRow, WeightCardRows } from './WeightCardRows';
import './terminals.css';

const money = (value: number) => value.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' });
const time = (value: string) => new Date(value).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function ApprovalVersionPreview({ approval, siteName, onClose }: { approval: TerminalApproval; siteName: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') { event.preventDefault(); closeRef.current?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [onClose]);
  const snapshot = approval.snapshot;
  const settlement: PublicSettlement = {
    cardId: approval.cardId, version: approval.version,
    customerName: snapshot.customer.name, customerNumber: snapshot.customer.customerNumber,
    siteName, rows: snapshot.rows, gross: snapshot.gross, offset: snapshot.offset, net: snapshot.net,
    paymentMethod: snapshot.paymentMethod, reference: snapshot.reference, origin: snapshot.origin,
    deliveredAt: snapshot.deliveredAt, termsVersion: snapshot.termsVersion, hash: snapshot.hash,
  };
  return <div className="approval-version-backdrop"><section className="approval-version-dialog" role="dialog" aria-modal="true" aria-label={`Avräkningsversion ${approval.version} · INV-${approval.cardId}`}>
    <header><div><span className="office-eyebrow">FRYST GRANSKNINGSVERSION</span><h2>Avräkningsversion {approval.version} · INV-{approval.cardId}</h2><p>{approvalLabels[approval.status]} · skickad {time(approval.createdAt)}</p></div><button ref={closeRef} className="terminal-icon-button" aria-label="Stäng versionsgranskning" onClick={onClose}><X size={22} /></button></header>
    <p className="approval-version-readonly">Detta är exakt det underlag kunden fick granska. Uppgifterna är låsta och kan inte ändras här.</p>
    <SettlementView settlement={settlement} />
    <p className="approval-version-terms">Intygande: {snapshot.termsVersion} · Version {approval.version}</p>
  </section></div>;
}
export function latestApprovals(approvals: TerminalApproval[]) {
  const latest = new Map<number, TerminalApproval>();
  for (const approval of approvals) {
    const previous = latest.get(approval.cardId);
    if (!previous || approval.version > previous.version || (approval.version === previous.version && approval.createdAt > previous.createdAt)) latest.set(approval.cardId, approval);
  }
  return latest;
}
export function activeApprovalCount(state?: TerminalDemoState, siteId = '') {
  return [...latestApprovals(state?.approvals ?? []).values()].filter(approval => (!siteId || siteId === 'all' || approval.siteId === siteId) && (approval.status === 'waiting' || approval.status === 'id_requested')).length;
}
export type CustomerApprovalsWorkspaceProps = {
  state?: TerminalDemoState; siteId: string; onOpenCard: (id: number) => void;
  loading?: boolean; error?: string; configurationRequired?: boolean;
  onRefresh?: () => Promise<void>; canSeeMoney?: boolean;
};
export default function CustomerApprovalsWorkspace({ state, siteId, onOpenCard, loading, error, configurationRequired, onRefresh, canSeeMoney = true }: CustomerApprovalsWorkspaceProps) {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'active';
  const query = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const dateFrom = params.get('from') ?? '';
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const setTab = (value: 'active' | 'history') => {
    const next = new URLSearchParams(params);
    if (value === 'history') next.set('tab', value); else next.delete('tab');
    next.delete('status');
    setParams(next, { replace: true });
  };
  const [preview, setPreview] = useState<TerminalApproval>();
  useEffect(() => {
    if (preview && (!canSeeMoney || !state?.approvals.some(approval => approval.id === preview.id) || (siteId && siteId !== 'all' && preview.siteId !== siteId))) setPreview(undefined);
  }, [preview, canSeeMoney, state?.approvals, siteId]);
  const latest = useMemo(() => latestApprovals(state?.approvals ?? []), [state?.approvals]);
  const relevant = (state?.approvals ?? []).filter(approval => !siteId || siteId === 'all' || approval.siteId === siteId);
  const active = relevant.filter(approval => latest.get(approval.cardId)?.id === approval.id && activeApprovalStatuses.includes(approval.status));
  const history = relevant.filter(approval => latest.get(approval.cardId)?.id !== approval.id || !activeApprovalStatuses.includes(approval.status));
  const filtered = (tab === 'active' ? active : history).filter(approval => (!status || approval.status === status)
    && (!dateFrom || approval.createdAt.slice(0, 10) >= dateFrom)
    && `${approval.cardId} ${approval.snapshot.customer.name} ${approval.snapshot.reference}`.toLowerCase().includes(query.toLowerCase().trim())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const needsAction = active.filter(approval => approval.status === 'change_requested' || approval.status === 'expired').length;
  const statusOptions: ApprovalStatus[] = tab === 'active' ? activeApprovalStatuses : ['approved', 'attested', 'cancelled', 'waiting', 'id_requested', 'change_requested', 'expired'];
  const controls = <div className="approval-list-tools"><div className="approval-tabs" role="tablist" aria-label="Kundgodkännanden"><button role="tab" aria-selected={tab === 'active'} className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>Aktiva <span>{active.length}</span></button><button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Historik <span>{history.length}</span></button></div><label className="approval-search"><Search size={16} /><input aria-label="Sök kundgodkännanden" placeholder="Sök kort, kund eller referens…" value={query} onChange={event => setFilter('q', event.target.value)} /></label><select aria-label="Filtrera godkännandestatus" value={status} onChange={event => setFilter('status', event.target.value)}><option value="">Alla statusar</option>{statusOptions.map(option => <option value={option} key={option}>{approvalLabels[option]}</option>)}</select><input type="date" aria-label="Utskick från datum" value={dateFrom} onChange={event => setFilter('from', event.target.value)} /></div>;

  return <section className="terminal-workspace approval-workspace">
    <OfficePageHeader controls={controls}><div className="office-title"><div><span className="office-eyebrow">GRANSKNING FÖRE ATTEST</span><h1>Kundgodkännanden</h1><p>Kundens granskning och svar, samlade för hela kontoret.</p></div><span className="approval-live"><i className="terminal-dot online" />{state ? 'Uppdateras live' : 'Ansluter…'}</span></div></OfficePageHeader>
    {(error || configurationRequired) && <TerminalServiceNotice error={error} configurationRequired={configurationRequired} onRefresh={onRefresh} />}
    <div className="terminal-summary approval-summary"><span><Clock3 size={17} /><strong>{activeApprovalCount(state, siteId)}</strong> inväntar kund</span><span><MessageSquare size={17} /><strong>{needsAction}</strong> behöver åtgärd</span><span><CheckCircle2 size={17} /><strong>{relevant.filter(approval => approval.status === 'approved' || approval.status === 'attested').length}</strong> godkända versioner</span></div>
    <div className="office-panel approval-list-panel">
      <WeightCardRows scope={`${state?.actualUserId ?? ''}/${state?.effectiveUserId ?? ''}:${siteId}:${canSeeMoney}`}><div className="office-table-wrap"><table className="office-table approval-table"><thead><tr><th>Invägning / kund</th><th>Anläggning</th>{canSeeMoney && <th>Belopp</th>}<th>Kundgodkännande</th><th>Kanal / terminal</th><th>Utskick</th>{canSeeMoney && <th>Versionsgranskning</th>}</tr></thead><tbody>{filtered.map(approval => {
        const to = `/customer-approvals/${approval.cardId}${location.search}`;
        const rowPreview = { ...createWeightCardPreview(approval.snapshot.card, approval.snapshot.customer.name),
          materials: approval.snapshot.rows.map(row => ({ name: row.name, weight: row.weight })),
          origin: approval.snapshot.origin, reference: approval.snapshot.reference,
          note: `Avräkningsversion ${approval.version}${latest.get(approval.cardId)?.id !== approval.id ? ' · Tidigare version' : ''}`,
          nextStep: approval.status === 'change_requested' ? 'Granska kundens ändringsbegäran' : approval.status === 'id_requested' ? 'Kontrollera kundens legitimation' : approval.status === 'expired' ? 'Skicka en ny granskningsversion' : approval.status === 'waiting' ? 'Invänta kundens godkännande' : approval.status === 'approved' ? 'Granska och attestera avräkningen' : approval.status === 'attested' ? 'Följ utbetalningen på det aktuella kortet' : 'Granska historiken eller öppna det aktuella kortet' };
        return <WeightCardRow key={approval.id} rowKey={approval.id} cardId={approval.cardId} to={to} onOpen={onOpenCard} preview={rowPreview}>
        <td><WeightCardLink className="office-link approval-card-link" cardId={approval.cardId} to={to} onOpen={onOpenCard} label={latest.get(approval.cardId)?.id !== approval.id ? `Öppna aktuellt kort INV-${approval.cardId}` : `Öppna viktkort ${approval.cardId}`}>INV-{approval.cardId}</WeightCardLink><strong>{approval.snapshot.customer.name}</strong><small>Version {approval.version}{approval.snapshot.reference ? ` · ${approval.snapshot.reference}` : ''}</small></td>
        <td>{state?.sites.find(site => site.id === approval.siteId)?.name ?? approval.siteId}</td>{canSeeMoney && <td className="approval-amount">{money(approval.snapshot.net)}</td>}
        <td><span className={`approval-status approval-${approval.status}`}>{approvalLabels[approval.status]}</span>{approval.status === 'change_requested' && <small className="approval-change-comment">{approval.comment}</small>}{latest.get(approval.cardId)?.id !== approval.id && <small>Tidigare version</small>}</td>
        <td><span className="approval-terminal-name"><Monitor size={14} />Kundterminal</span><small>{state?.terminals.find(terminal => terminal.id === approval.terminalId)?.name ?? 'Terminal'}</small></td>
        <td>{time(approval.createdAt)}<small>{approval.sentBy}</small></td>{canSeeMoney && <td><div className="approval-version-actions"><button className="office-link" aria-label={`Granska avräkningsversion ${approval.version} för invägning ${approval.cardId}`} onClick={() => setPreview(approval)}><FileSearch size={14} />Granska version</button></div></td>}
      </WeightCardRow>;
      })}</tbody></table></div></WeightCardRows>
      {!filtered.length && <div className="terminal-empty"><Monitor size={30} /><h2>{loading ? 'Hämtar kundgodkännanden…' : query || status || dateFrom ? 'Inga kort matchar sökningen' : tab === 'active' ? 'Inga aktiva kundgodkännanden' : 'Historiken är tom'}</h2><p>{tab === 'active' ? 'Visa en färdig avräkning på en kundterminal från invägningskortet.' : 'Godkända, avslutade och tidigare versioner samlas här.'}</p></div>}
    </div>
    {preview && canSeeMoney && <ApprovalVersionPreview approval={preview} siteName={state?.sites.find(site => site.id === preview.siteId)?.name ?? preview.siteId} onClose={() => setPreview(undefined)} />}
  </section>;
}
