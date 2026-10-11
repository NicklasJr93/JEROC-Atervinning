import { useEffect, useRef, useState } from 'react';
import { CircleAlert, FileCheck2, RefreshCw, Send } from 'lucide-react';
import { can, type OfficeUser } from './model';
import { environmentFailure, useEnvironmentSession } from './EnvironmentSession';
import { EnvironmentApiError } from './environment-client';
import NvvConnectionCheckDialog, { type ExternalConnectionTest, type NvvCheckProgress } from './NvvConnectionCheckDialog';
import { spirisAccountingApi, type SpirisCardPreview, type SpirisExport } from './spiris-accounting-client';
import { vismaSandboxApi, type VismaAttestedCard, type VismaCardReference, type VismaSandboxRun } from './visma-sandbox-client';
import type { AccountingDraftRow } from './accounting-types';
import './spiris-manual-export.css';

type DialogState = { progress: NvvCheckProgress; externalTest: ExternalConnectionTest };
const money = (value: number) => value.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sameSource = (left: VismaCardReference, right: VismaCardReference) =>
  left.cardId === right.cardId && left.approvalId === right.approvalId && left.version === right.version && left.hash === right.hash;
const retryable = (job?: SpirisExport | null) => !job || ['blocked', 'rejected'].includes(job.status);
const terminal = (job: SpirisExport) => ['accepted', 'rejected', 'blocked'].includes(job.status);

export default function SpirisManualExport({ user, actualUser, canExport, onExport, onNotice }: {
  user: OfficeUser; actualUser: OfficeUser; canExport: boolean; onExport: (job: SpirisExport) => void; onNotice: (message: string) => void;
}) {
  const { session } = useEnvironmentSession();
  const identity = `${actualUser.id}/${actualUser.level}/${actualUser.permissions.join(',')}/${actualUser.siteIds?.join(',') ?? 'all'}/${user.id}/${user.level}/${user.permissions.join(',')}/${user.siteIds?.join(',') ?? 'all'}`;
  const permitted = actualUser.level === 'Systemadmin' && user.level === 'Systemadmin' && !actualUser.siteIds && !user.siteIds && can(user, 'integrationsRead') && session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const identityRef = useRef(identity); identityRef.current = identity;
  const permittedRef = useRef(permitted); permittedRef.current = permitted;
  const mounted = useRef(true), generation = useRef(0), busyRef = useRef(false);
  const controllers = useRef(new Set<AbortController>()), dialogVisible = useRef(false), unknownRef = useRef<VismaCardReference | undefined>(undefined);
  const submitButton = useRef<HTMLButtonElement>(null);
  const [cards, setCards] = useState<VismaAttestedCard[]>([]), [cardId, setCardId] = useState('');
  const [preview, setPreview] = useState<SpirisCardPreview>(), [job, setJob] = useState<SpirisExport>();
  const [busy, setBusy] = useState<'cards' | 'preview' | 'send' | 'history'>(), [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false), [dialog, setDialog] = useState<DialogState>();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; for (const controller of controllers.current) controller.abort(); };
  }, []);
  useEffect(() => {
    generation.current++;
    for (const controller of controllers.current) controller.abort(); controllers.current.clear();
    busyRef.current = false; unknownRef.current = undefined; dialogVisible.current = false;
    setCards([]); setCardId(''); setPreview(undefined); setJob(undefined); setBusy(undefined); setError(''); setUnknown(false); setDialog(undefined);
    if (!permitted) return;
    const controller = new AbortController(); controllers.current.add(controller);
    const epoch = generation.current;
    const current = () => mounted.current && !controller.signal.aborted && generation.current === epoch && identityRef.current === identity && permittedRef.current;
    busyRef.current = true; setBusy('cards');
    void vismaSandboxApi.attestedCards(controller.signal).then(next => { if (current()) setCards(next.cards); })
      .catch(failure => { if (current()) setError(environmentFailure(failure)); })
      .finally(() => { controllers.current.delete(controller); if (current()) { busyRef.current = false; setBusy(undefined); } });
    return () => { controller.abort(); controllers.current.delete(controller); };
  }, [identity, permitted]);

  function request() {
    const controller = new AbortController(); controllers.current.add(controller);
    const epoch = generation.current;
    return { controller, current: () => mounted.current && !controller.signal.aborted && generation.current === epoch && identityRef.current === identity && permittedRef.current };
  }
  async function previewCard() {
    if (!permitted || busyRef.current || !cardId) return;
    const { controller, current } = request(); busyRef.current = true; setBusy('preview'); setError(''); setPreview(undefined); setJob(undefined);
    try { const next = await spirisAccountingApi.preview(Number(cardId), controller.signal); if (current()) { setPreview(next); setJob(next.export ?? undefined); } }
    catch (failure) { if (current()) setError(environmentFailure(failure)); }
    finally { controllers.current.delete(controller); if (current()) { busyRef.current = false; setBusy(undefined); } }
  }

  async function readRun(result: SpirisExport, signal: AbortSignal) {
    const id = result.runs?.draftRequestId ?? result.runs?.supplierRequestId;
    return id ? vismaSandboxApi.historyRun(id, signal) : undefined;
  }
  function finishDialog(result: SpirisExport | undefined, run: VismaSandboxRun | undefined, source: VismaCardReference, failure?: string, definite = false) {
    if (!dialogVisible.current) return;
    const successful = result?.status === 'accepted';
    const uncertain = !definite && (!result || !terminal(result));
    const message = failure || result?.error?.message || (uncertain ? 'Resultatet är oklart. Kontrollera den sparade historiken innan fler överföringar.' : 'Fakturautkastet skapades inte. Granska överföringens sparade resultat.');
    setDialog({ progress: successful ? { phase: 'success', mode: 'test', wasteCodes: 0, transportModes: 0 } : { phase: 'error', mode: 'test', message },
      externalTest: { provider: 'Spiris', environmentLabel: 'Spiris · SANDBOX', method: run?.method ?? 'POST', path: run?.path ?? '/api/environment/visma/accounting/exports',
        payload: run ? run.payload : { cardId: source.cardId, source }, parameters: run?.parameters, run, uncertain } });
  }
  async function send() {
    if (!permitted || !canExport || busyRef.current || unknownRef.current || !preview?.eligible || !retryable(job ?? preview.export)) return;
    const source = structuredClone(preview.source), { controller, current } = request();
    busyRef.current = true; setBusy('send'); setError(''); dialogVisible.current = true;
    setDialog({ progress: { phase: 'running', mode: 'test' }, externalTest: { provider: 'Spiris', environmentLabel: 'Spiris · SANDBOX', method: 'POST', path: '/api/environment/visma/accounting/exports', payload: { cardId: source.cardId, source } } });
    try {
      const result = await spirisAccountingApi.sendExport(source.cardId, source, controller.signal);
      if (!current()) return;
      if (!sameSource(result.source, source)) throw new Error('Serverns överföring hör till en annan attestversion. Kontrollera historiken.');
      setJob(result); onExport(result);
      if (!terminal(result)) { unknownRef.current = source; setUnknown(true); }
      let run: VismaSandboxRun | undefined, journalError: string | undefined;
      try { run = await readRun(result, controller.signal); } catch (failure) { journalError = `API-journalen kunde inte hämtas: ${environmentFailure(failure)}`; }
      if (!current()) return;
      if (journalError) setError(journalError);
      finishDialog(result, run, source, result.status === 'accepted' ? undefined : journalError);
      onNotice(result.status === 'accepted' ? 'Fakturautkastet är skapat i Spiris sandbox.' : result.error?.message || 'Överföringens resultat finns i historiken.');
    } catch (failure) {
      if (!current()) return;
      const definite = failure instanceof EnvironmentApiError && failure.status >= 400 && failure.status < 500 &&
        ![408, 429].includes(failure.status) && !/(?:export|operation|response|request)_(?:unknown|busy|in_flight|pending|interrupted)/.test(failure.code);
      if (definite) {
        unknownRef.current = undefined; setUnknown(false); setPreview(undefined); setJob(undefined);
        const message = `Överföringen kunde inte startas: ${environmentFailure(failure)} Förhandsvisa avräkningen igen efter att felet är åtgärdat.`;
        setError(message); finishDialog(undefined, undefined, source, message, true);
      } else {
        unknownRef.current = source; setUnknown(true);
        const message = `Överföringens resultat är oklart: ${environmentFailure(failure)} Kontrollera historiken innan fler överföringar.`;
        setError(message); finishDialog(undefined, undefined, source, message);
      }
    } finally { controllers.current.delete(controller); if (current()) { busyRef.current = false; setBusy(undefined); } }
  }
  async function checkHistory() {
    if (!permitted || busyRef.current) return;
    const source = unknownRef.current ?? preview?.source;
    const { controller, current } = request(); busyRef.current = true; setBusy('history'); setError('');
    try {
      const [available, history] = await Promise.all([vismaSandboxApi.attestedCards(controller.signal), spirisAccountingApi.exports(controller.signal)]);
      if (!current()) return;
      setCards(available.cards);
      const result = source && history.exports.find(entry => sameSource(entry.source, source));
      if (result) {
        if (preview && sameSource(preview.source, result.source)) setJob(result);
        onExport(result);
        if (terminal(result)) { unknownRef.current = undefined; setUnknown(false); }
        else { unknownRef.current = source; setUnknown(true); }
        let run: VismaSandboxRun | undefined;
        try { run = await readRun(result, controller.signal); } catch (failure) { if (current()) setError(`API-journalen kunde inte hämtas: ${environmentFailure(failure)}`); }
        if (current()) finishDialog(result, run, source!);
      } else if (unknownRef.current) setError('Inget bekräftat slutresultat finns ännu. Fler överföringar är spärrade; kontrollera historiken igen.');
    } catch (failure) { if (current()) setError(environmentFailure(failure)); }
    finally { controllers.current.delete(controller); if (current()) { busyRef.current = false; setBusy(undefined); } }
  }

  if (!permitted) return null;
  const draft = record(preview?.draft), supplier = record(preview?.supplier);
  const rows = Array.isArray(draft.Rows) ? draft.Rows.filter(row => typeof row?.AccountNumber === 'number' && typeof row?.DebitAmount === 'number' && typeof row?.CreditAmount === 'number') as AccountingDraftRow[] : [];
  const debit = rows.reduce((sum, row) => sum + Math.round(row.DebitAmount * 100), 0), credit = rows.reduce((sum, row) => sum + Math.round(row.CreditAmount * 100), 0);
  return <section className="spiris-manual-export" aria-label="Manuell Spiris-överföring">
    <header><div><h3>Överför en attesterad avräkning</h3><p>Förhandsvisa det låsta underlaget och skapa sedan ett fakturautkast i sandbox.</p></div><button type="button" className="office-btn outline" disabled={!!busy} onClick={() => void checkHistory()}><RefreshCw size={14} />Kontrollera historik</button></header>
    <div className="spiris-manual-controls"><label>Attesterad avräkning<select aria-label="Attesterad avräkning" value={cardId} disabled={!!busy} onChange={event => { setCardId(event.target.value); setPreview(undefined); setJob(undefined); setError(''); }}><option value="">Välj en attesterad avräkning</option>{cards.map(card => <option key={card.approvalId} value={card.cardId}>Viktkort #{card.cardId} · {card.customerName} · {money(card.gross)} kr</option>)}</select></label><button type="button" className="office-btn outline" disabled={!cardId || !!busy} onClick={() => void previewCard()}><FileCheck2 size={15} />{busy === 'preview' ? 'Hämtar underlag…' : 'Förhandsvisa avräkning'}</button></div>
    {busy === 'cards' && <p role="status">Hämtar attesterade avräkningar…</p>}{!busy && !cards.length && <p>Inga aktuella kundgodkända och attesterade avräkningar finns.</p>}
    {error && <p className="spiris-manual-error" role="alert"><CircleAlert size={15} />{error}</p>}{unknown && <p className="spiris-manual-error">Resultatet behöver bekräftas i historiken. Ingen ny överföring kan startas innan dess.</p>}
    {preview && <div className="spiris-manual-preview"><p><strong>Viktkort #{preview.source.cardId} · Attestversion {preview.source.version}</strong></p>{draft.InvoiceNumber != null && <p>Fakturanummer: {String(draft.InvoiceNumber)}</p>}{supplier.Name != null && <p>Leverantör: {String(supplier.Name)}{supplier.SupplierNumber ? ` · ${String(supplier.SupplierNumber)}` : ''}</p>}
      {preview.issues.length > 0 && <ul>{preview.issues.map((issue, index) => <li key={index}>{typeof issue === 'string' ? issue : issue.message}</li>)}</ul>}
      {rows.length > 0 && <table className="spiris-journal"><caption>Kontering från den attesterade avräkningen</caption><thead><tr><th>Konto</th><th>Debet</th><th>Kredit</th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><th scope="row" title={row.TransactionText}>{row.AccountNumber}</th><td>{row.DebitAmount ? money(row.DebitAmount) : '—'}</td><td>{row.CreditAmount ? money(row.CreditAmount) : '—'}</td></tr>)}</tbody></table>}
      {rows.length > 0 && <p className={debit === credit ? 'spiris-balanced' : 'spiris-manual-error'}>{debit === credit ? 'Konteringen balanserar' : 'Debet och kredit skiljer sig. Underlaget behöver granskas.'}</p>}
      {job && <p>Överförings-ID: {job.id} · {job.status}{job.draftId ? ` · Fakturautkast-ID: ${job.draftId}` : ''}</p>}
      {!canExport && <p>Aktivera och verifiera Spiris-överföringen i inställningarna innan utkast kan skapas.</p>}
      <button ref={submitButton} type="button" className="office-btn" disabled={!canExport || !!busy || unknown || !preview.eligible || !retryable(job ?? preview.export) || rows.length === 0 || debit !== credit} onClick={() => void send()}><Send size={15} />{busy === 'send' ? 'Skapar fakturautkast…' : 'Skapa fakturautkast · SANDBOX'}</button>
    </div>}
    {dialog && <NvvConnectionCheckDialog progress={dialog.progress} externalTest={dialog.externalTest} returnFocus={submitButton} onClose={() => { dialogVisible.current = false; setDialog(undefined); }} onRetry={() => void checkHistory()} />}
  </section>;
}
