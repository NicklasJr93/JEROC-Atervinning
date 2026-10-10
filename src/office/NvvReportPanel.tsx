import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, FileText, RefreshCw, Send } from 'lucide-react';
import { can, type OfficeUser } from './model';
import { environmentApi } from './environment-client';
import { environmentFailure } from './EnvironmentSession';
import { environmentTime, environmentWeight, type EnvironmentalReport, type NvvIntegrationStatus, type NvvReportDetail, type NvvReportStatus } from './environment-types';

export const nvvStatusLabels: Record<NvvReportStatus, string> = {
  ready: 'Klar för rapportering', incomplete: 'Saknar uppgifter', sending: 'Skickas',
  reported: 'Rapporterad till NVV – TEST', simulated: 'Simulerad – ej skickad till NVV',
  error: 'Rapportering avvisad', unknown: 'Osäkert utfall', correction_required: 'Rättelse behöver rapporteras',
};
export const nvvStatusTone = (status: NvvReportStatus) => ['reported', 'ready'].includes(status) ? 'success' : ['incomplete', 'error', 'unknown', 'correction_required'].includes(status) ? 'warning' : '';

export default function NvvReportPanel({ report, receiptVersion, user, integration, historic = false, onRefresh, onNotice }: {
  report: Pick<EnvironmentalReport, 'id'>; receiptVersion: number; user: OfficeUser;
  integration?: NvvIntegrationStatus; historic?: boolean; onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [detail, setDetail] = useState<NvvReportDetail>();
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState<'send' | 'reconcile'>();
  const active = useRef(true);
  const operation = useRef(false);
  const generation = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setDetail(undefined); setError(''); setLoadError(''); setPending(undefined);
    async function load() {
      if (operation.current) return;
      const requestGeneration = generation.current;
      try { const next = await environmentApi.nvvReport(report.id, controller.signal); if (current && requestGeneration === generation.current) { setDetail(next); setLoadError(''); } }
      catch (failure) { if (current && requestGeneration === generation.current && !controller.signal.aborted) setLoadError(environmentFailure(failure)); }
    }
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5000);
    return () => { current = false; controller.abort(); window.clearInterval(timer); };
  }, [report.id, receiptVersion, user.id]);

  const approvedVersionIds = new Set(detail?.attempts.filter(attempt => attempt.outcome === 'accepted' && attempt.kind === 'submit').map(attempt => attempt.versionId));
  const correcting = detail?.status === 'correction_required' || detail?.versions.some(version => version.receiptVersion < receiptVersion && approvedVersionIds.has(version.id));
  const permitted = can(user, 'environmentReport') && (!correcting || can(user, 'environmentReportCorrect'));
  const sendable = !!detail && !historic && ['ready', 'error', 'correction_required'].includes(detail.status) && !detail.missingFields.length && !['queued', 'in_flight'].includes(detail.job?.status ?? '');
  const mode = integration?.mode ?? detail?.mode;
  const configured = integration?.configured ?? false;
  async function perform(action: 'send' | 'reconcile') {
    if (!detail || pending || !permitted || historic) return;
    operation.current = true; generation.current += 1;
    setPending(action); setError('');
    try {
      const next = action === 'send'
        ? await environmentApi.sendNvvReport(report.id, { receiptVersion, idempotencyKey: `nvv-${crypto.randomUUID()}` })
        : await environmentApi.reconcileNvvReport(report.id);
      if (!active.current) return;
      setDetail(next);
      if (next.status === 'simulated') onNotice('Rapporteringen är simulerad. Inga uppgifter har skickats till Naturvårdsverket.');
      else if (next.status === 'reported') onNotice('Rapporten har fått en bekräftelse från NVV:s testmiljö.');
      else if (next.status === 'sending') onNotice('Rapporten ligger i sändningskön för NVV:s testmiljö.');
      await onRefresh();
    } catch (failure) { if (active.current) setError(environmentFailure(failure)); }
    finally { operation.current = false; if (active.current) setPending(undefined); }
  }
  return <section className="nvv-report-panel" aria-label="NVV-rapportering">
    <div className="nvv-report-heading"><h3><FileText size={17} />NVV-rapportering</h3>{detail && <span className={`environment-pill ${nvvStatusTone(detail.status)}`}>{detail.job?.status === 'queued' ? 'Köad för sändning' : nvvStatusLabels[detail.status]}</span>}</div>
    {!detail && !loadError && <p className="environment-muted">Hämtar rapporteringsstatus…</p>}
    {detail && <>
      <p className="nvv-report-version-copy">Mottagningsversion {receiptVersion}. Rapporteringen sparas separat från lager, kundgodkännande och betalning.</p>
      {detail.avfallId && <div className={`nvv-acknowledgement ${detail.status === 'simulated' ? 'simulated' : ''}`}><CheckCircle2 size={18} /><div><strong>{detail.mode === 'mock' ? 'Simulerat ID' : 'Avfalls-ID · NVV TEST'}</strong><span>{detail.avfallId}</span></div></div>}
      {!!detail.missingFields.length && <div className="environment-alert"><CircleAlert size={16} /><div><strong>Komplettera före rapportering</strong><ul>{detail.missingFields.map(field => <li key={field}>{field}</li>)}</ul></div></div>}
      {detail.status === 'unknown' && <div className="environment-alert"><CircleAlert size={17} /><div><strong>Det är osäkert om NVV tog emot rapporten.</strong><p>Kontrollera svaret innan ett nytt försök. Omsändning är spärrad för att undvika dubbla anteckningar.</p></div></div>}
      {(detail.status === 'error' || detail.job?.lastError) && detail.job?.lastError && <div className="environment-error"><CircleAlert size={16} />{detail.job.lastError.message}</div>}
      {!historic && <div className="nvv-report-actions">
        {permitted && detail.status !== 'unknown' && <button type="button" className="office-btn" onClick={() => void perform('send')} disabled={!sendable || !configured || mode === 'disabled' || !!pending}><Send size={14} />{pending === 'send' ? 'Skickar…' : mode === 'mock' ? (correcting ? 'Simulera rättelse' : 'Simulera rapportering') : correcting ? 'Skicka rättelse till NVV – TEST' : 'Skicka till NVV – TEST'}</button>}
        {permitted && detail.status === 'unknown' && <button type="button" className="office-btn outline" onClick={() => void perform('reconcile')} disabled={!!pending || mode === 'disabled'}><RefreshCw size={14} />{pending === 'reconcile' ? 'Kontrollerar…' : 'Kontrollera utfallet hos NVV – TEST'}</button>}
        {!permitted && <small>Du saknar behörighet för {correcting ? 'NVV-rättelser' : 'NVV-rapportering'}.</small>}
        {permitted && mode === 'disabled' && <small>Aktivera testanslutningen på servern före sändning.</small>}
        {permitted && mode !== 'disabled' && !configured && <small>NVV-inställningarna behöver kompletteras.</small>}
      </div>}
      <details className="nvv-send-history" open={detail.attempts.length > 0}><summary>Skickhistorik <span>{detail.attempts.length}</span></summary>
        {!detail.attempts.length ? <p>Inga sändningsförsök ännu.</p> : <ol>{[...detail.attempts].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(attempt => {
          const version = detail.versions.find(item => item.id === attempt.versionId);
          return <li key={attempt.id}><strong>{attempt.kind === 'read' ? 'Svar kontrollerat' : version?.method === 'PUT' ? 'Rättelse' : 'Rapportering'} · {attempt.mode === 'mock' ? 'SIMULERING' : 'NVV TEST'} · {attempt.outcome === 'accepted' ? (attempt.mode === 'mock' ? 'Simulerat svar' : 'Bekräftad') : attempt.outcome === 'rejected' ? 'Avvisad' : 'Osäkert utfall'}</strong>
            <span>{environmentTime(attempt.startedAt)} · Mottagningsversion {version?.receiptVersion ?? '–'}{attempt.httpStatus ? ` · HTTP ${attempt.httpStatus}` : ''}</span>
            {attempt.avfallId && <span>{attempt.mode === 'mock' ? 'Simulerat ID' : 'Avfalls-ID TEST'}: {attempt.avfallId}</span>}
            {!!attempt.error && <p>{attempt.error.message}</p>}
            <details className="nvv-technical-details"><summary>Tekniskt svar</summary><small>Spårnings-ID: {attempt.trackingId}</small><pre>{JSON.stringify(attempt.response ?? attempt.error ?? {}, null, 2)}</pre></details>
          </li>;
        })}</ol>}
      </details>
      {!!detail.versions.length && <details className="nvv-payload-history"><summary>Rapportversioner och skickat underlag <span>{detail.versions.length}</span></summary><div>{[...detail.versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(version => <details className="nvv-frozen-payload" key={version.id}>
        <summary>Mottagningsversion {version.receiptVersion} · {environmentWeight(version.weight)} · {version.method === 'PUT' ? 'Rättelse' : 'Ny rapport'} · {version.mode === 'mock' ? 'SIMULERING' : 'NVV TEST'}</summary>
        <p>{environmentTime(version.createdAt)} · {version.createdBy} · Rapporterande organisation version {version.reporterVersion}</p>
        {version.previousAvfallId && <p>Tidigare {version.mode === 'mock' ? 'simulerat ID' : 'avfalls-ID TEST'}: {version.previousAvfallId}</p>}
        <small>{version.method} {version.path} · Kontrollsumma {version.payloadHash}</small><pre>{JSON.stringify(version.payload, null, 2)}</pre>
      </details>)}</div></details>}
    </>}
    {!!(error || loadError) && <div className="environment-error" role="alert"><CircleAlert size={16} />{error || loadError}</div>}
  </section>;
}
