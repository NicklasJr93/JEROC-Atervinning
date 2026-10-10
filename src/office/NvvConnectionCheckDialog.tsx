import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { ArrowRight, Check, CircleAlert, Database, FileText, Leaf, LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { NvvCheckDiagnostic, NvvIntegrationStatus, NvvJsonObject, NvvSandboxRun } from './environment-types';
import './nvv-connection-check.css';

export type NvvCheckProgress =
  | { phase: 'running'; mode: NvvIntegrationStatus['mode'] }
  | { phase: 'success'; mode: NvvIntegrationStatus['mode']; wasteCodes: number; transportModes: number; diagnostics?: NvvCheckDiagnostic[] }
  | { phase: 'error'; mode: NvvIntegrationStatus['mode']; message: string; diagnostics?: NvvCheckDiagnostic[] };

const testMessages = [
  'Kontaktar NVV:s testmiljö…',
  'Kontrollerar åtkomst och hämtar kodlistor…',
  'Inväntar serverns svar…',
];
const simulationMessages = [
  'Provar det simulerade anslutningsflödet…',
  'Inväntar det simulerade svaret…',
  'Kontrollerar provets kodlistor…',
];
const submissionMessages = ['Skickar testets uppgifter till servern…', 'Inväntar NVV:s testmiljö…', 'Inväntar serverns slutresultat…'];

/** Native modal focus containment; closing only delegates visibility to the caller. */
export default function NvvConnectionCheckDialog({ progress, onClose, onRetry, returnFocus, submission }: {
  progress: NvvCheckProgress; onClose: () => void; onRetry: () => void;
  returnFocus?: RefObject<HTMLButtonElement | null>;
  submission?: { payload: NvvJsonObject; run?: NvvSandboxRun; uncertain?: boolean };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId(), descriptionId = useId();
  const [messageIndex, setMessageIndex] = useState(0);
  const simulated = progress.mode === 'mock';
  const running = progress.phase === 'running';
  const successful = progress.phase === 'success';
  const unknownSubmission = submission?.uncertain || submission?.run?.status === 'unknown';
  const messages = submission ? submissionMessages : simulated ? simulationMessages : testMessages;
  const heading = submission ? running ? 'Skickar test till NVV' : successful ? 'NVV tog emot testet' : unknownSubmission ? 'Testets resultat är oklart' : submission.run?.httpStatus != null ? 'NVV avvisade testet' : 'Testet kunde inte skickas' : running
    ? (simulated ? 'Provar simulerad anslutning' : 'Kontrollerar NVV-anslutningen')
    : successful ? (simulated ? 'Simuleringen fungerar' : 'Testanslutningen fungerar')
      : (simulated ? 'Simuleringen kunde inte slutföras' : 'Anslutningen kunde inte bekräftas');

  useEffect(() => {
    const element = dialog.current;
    const opener = returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    if (element && !element.open) element.showModal();
    element?.querySelector<HTMLButtonElement>('.nvv-check-close')?.focus({ preventScroll: true });
    return () => {
      if (element?.open) element.close();
      if (opener?.isConnected) {
        if (!opener.matches(':disabled,[aria-disabled="true"]')) opener.focus({ preventScroll: true });
        else {
          const panel = opener.closest('.nvv-integration-panel,.nvv-sandbox-workspace');
          const next = [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),summary') ?? [])]
            .find(candidate => !element?.contains(candidate) && candidate.getClientRects().length > 0);
          next?.focus({ preventScroll: true });
        }
      }
    };
  }, [returnFocus]);
  useEffect(() => {
    setMessageIndex(0);
    if (!running) return;
    const timer = window.setInterval(() => setMessageIndex(index => (index + 1) % messages.length), 2800);
    return () => window.clearInterval(timer);
  }, [running, simulated, messages.length]);

  return <dialog ref={dialog} className={`nvv-check-dialog is-${progress.phase}${simulated ? ' is-simulated' : ''}`}
    aria-labelledby={headingId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <button type="button" className="nvv-check-close" aria-label={submission ? running ? 'Dölj NVV-testet' : 'Stäng NVV-testet' : running ? 'Dölj anslutningskontrollen' : 'Stäng anslutningskontrollen'} onClick={onClose}><X size={19} /></button>
    <div className="nvv-check-visual" aria-hidden="true">
      <span className="nvv-check-mode"><ShieldCheck size={12} />{simulated ? 'SIMULERING' : 'NVV · TESTMILJÖ'}</span>
      <div className="nvv-check-connection">
        <div className="nvv-check-endpoint"><span><Database size={23} /></span><strong>JEROC</strong><small>Din server</small></div>
        <div className="nvv-check-flow">
          <i className="nvv-check-flow-line" />
          <i className="nvv-check-packet packet-one" /><i className="nvv-check-packet packet-two" /><i className="nvv-check-packet packet-three" />
          <span className="nvv-check-halo halo-one" /><span className="nvv-check-halo halo-two" />
          <span className="nvv-check-outcome">{running ? <LoaderCircle size={26} /> : successful ? <Check size={28} strokeWidth={3} /> : <CircleAlert size={27} />}</span>
        </div>
        <div className="nvv-check-endpoint"><span><Leaf size={25} /></span><strong>NVV</strong><small>{simulated ? 'Simulerat svar' : 'Testmiljö'}</small></div>
      </div>
      <span className="nvv-check-visual-caption">{submission ? running ? 'Ett uttryckligt testanrop' : successful ? 'Svar från testmiljön mottaget' : 'Se testets faktiska resultat nedan' : running ? (simulated ? 'Lokalt prov av anslutningsflödet' : 'Säker serveranslutning') : successful ? (simulated ? 'Provflödet har svarat' : 'Svar från testmiljön mottaget') : 'Kontrollen behöver åtgärdas'}</span>
    </div>
    <div className="nvv-check-content">
      <span className={`nvv-check-result-label ${successful ? 'is-success' : progress.phase === 'error' ? 'is-error' : ''}`}>
        {running ? <LoaderCircle size={13} /> : successful ? <Check size={13} /> : <CircleAlert size={13} />}
        {submission ? running ? 'Testanrop pågår' : successful ? 'Mottaget i TEST' : unknownSubmission ? 'Oklart resultat' : 'Testets svar' : running ? 'Kontroll pågår' : successful ? (simulated ? 'Simulerat resultat' : 'Verifierad testanslutning') : 'Kontrollen misslyckades'}
      </span>
      <h2 id={headingId}>{heading}</h2>
      <p id={descriptionId}>{submission ? running ? 'Servern skickar den frysta payloaden nedan till Naturvårdsverkets testmiljö. Formulärets fortsatta ändringar påverkar inte detta anrop.' : successful ? 'Testmiljön har bekräftat detta anrop. Resultatet gäller bara testet och ändrar inga viktkort eller lager.' : 'Payload och mottaget svar bevaras för detta test. Kontroll av historiken skickar inget nytt anrop till NVV.' : running
        ? (simulated ? 'Servern provar anslutningsflödet med simulerade svar.' : 'Servern kontrollerar åtkomst och hämtar avfallskoder och transportsätt från Naturvårdsverkets testmiljö.')
        : successful ? (simulated ? 'Provets kodlistor har hämtats. Resultatet är simulerat och verifierar ingen myndighetsanslutning.' : 'Servern har fått svar från Naturvårdsverket och läst in testmiljöns kodlistor.')
          : 'Se svaret nedan. När uppgifterna är rättade kan du prova anslutningen igen.'}</p>
      {running && <div className="nvv-check-activity" role="status">
        <span className="nvv-check-sr-only">{submission ? 'NVV-test pågår. Serverns svar inväntas.' : simulated ? 'Simulerad anslutningskontroll pågår. Serverns svar inväntas.' : 'Anslutningskontroll pågår. Serverns svar inväntas.'}</span>
        <span key={messageIndex} className="nvv-check-pending-message" aria-hidden="true">{messages[messageIndex]}</span>
        <span className="nvv-check-progress-track" aria-hidden="true"><i /></span>
      </div>}
      {progress.phase === 'success' && !submission && <div className="nvv-check-results" role="status">
        <div><span><Database size={18} /></span><strong>{progress.wasteCodes.toLocaleString('sv-SE')}</strong><small>Avfallskoder</small></div>
        <div><span><ArrowRight size={18} /></span><strong>{progress.transportModes.toLocaleString('sv-SE')}</strong><small>Transportsätt</small></div>
      </div>}
      {progress.phase === 'error' && <div className="nvv-check-error" role="alert"><CircleAlert size={18} /><span>{progress.message}</span></div>}
      {submission ? <>
        <section className="nvv-check-diagnostics" aria-label="Payload för detta test"><h3><FileText size={14} />Payload för detta test</h3><div className="nvv-check-request-line"><strong><b>POST</b>/insamlingar</strong>{submission.run && <span className={`nvv-check-http is-${submission.run.status}`}>{submission.run.httpStatus == null ? 'Inget HTTP-svar' : `HTTP ${submission.run.httpStatus}`}</span>}</div><pre>{JSON.stringify(submission.payload, null, 2)}</pre></section>
        <section className="nvv-check-diagnostics" aria-label="NVV:s råsvar"><h3><Database size={14} />NVV:s råsvar</h3>{submission.run ? <>
          <p><span>Spårnings-ID: {submission.run.trackingId}</span></p>
          {submission.run.avfallId && <p>Avfalls-ID: {submission.run.avfallId}</p>}
          {submission.run.clientCertificate?.organisationNumber && <p>Serverns certifikatorganisation: {submission.run.clientCertificate.organisationNumber}</p>}
          {submission.run.finishedAt && <p>Svar mottaget: {new Date(submission.run.finishedAt).toLocaleString('sv-SE')}</p>}
          <pre>{submission.run.response == null ? running ? 'Inget slutresultat ännu.' : 'Inget råsvar mottaget.' : typeof submission.run.response === 'string' ? submission.run.response : JSON.stringify(submission.run.response, null, 2)}</pre>
        </> : <p>{running ? 'Serverns svar inväntas.' : 'Inga anropsuppgifter mottagna från servern. Kontrollera testhistoriken.'}</p>}</section>
      </> : <section className="nvv-check-diagnostics" aria-label="Anrop och svar">
        <h3><FileText size={14} />Anrop och svar</h3>
        {progress.phase === 'running' ? <p>Anrop och svar visas när servern har svarat.</p>
          : !progress.diagnostics?.length ? <p>{simulated ? 'Simuleringsläge · inga anrop till NVV.' : 'Inga anropsuppgifter mottagna från servern.'}</p>
            : <ol>{progress.diagnostics.map((diagnostic, index) => {
              const response = typeof diagnostic.response === 'string' ? diagnostic.response : diagnostic.response === null ? '' : JSON.stringify(diagnostic.response);
              const shortened = response.length > 180;
              return <li key={`${diagnostic.method}/${diagnostic.path}/${diagnostic.trackingId ?? index}`}>
                <div className="nvv-check-request-line"><strong><b>{diagnostic.method}</b>{diagnostic.path}</strong><span className={`nvv-check-http is-${diagnostic.outcome}`}>{diagnostic.httpStatus === null ? 'Inget HTTP-svar' : `HTTP ${diagnostic.httpStatus}`}</span></div>
                <p><span>{shortened ? 'Förkortat svar: ' : 'Svar: '}</span>{response ? (shortened ? `${response.slice(0, 180)}…` : response) : 'Tomt svar.'}</p>
                {diagnostic.trackingId && <small>Spårnings-ID: {diagnostic.trackingId}</small>}
                {shortened && <details><summary>Visa hela sammanfattningen</summary><pre>{typeof diagnostic.response === 'string' ? diagnostic.response : JSON.stringify(diagnostic.response, null, 2)}</pre></details>}
              </li>;
            })}</ol>}
      </section>}
      {simulated && <div className="nvv-check-simulation-note"><ShieldCheck size={14} /><span>Simulering · ingen kontakt med Naturvårdsverket.</span></div>}
      <div className="nvv-check-actions">
        {progress.phase === 'error' ? <><button type="button" className="office-btn outline" onClick={onClose}>Stäng</button><button type="button" className="office-btn" onClick={onRetry}><RefreshCw size={14} />{submission ? 'Kontrollera testhistorik' : 'Försök igen'}</button></>
          : <button type="button" className={`office-btn ${running ? 'outline' : ''}`} onClick={onClose}>{running ? 'Kör i bakgrunden' : 'Klart'}{successful && <Check size={14} />}</button>}
      </div>
      {running && <small className="nvv-check-background-note">{submission ? 'Testet fortsätter när du döljer popupen.' : 'Du kan fortsätta arbeta medan servern slutför kontrollen.'}</small>}
    </div>
  </dialog>;
}
