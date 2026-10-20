import { OfficePageHeader } from './OfficePageHeader';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, CheckCircle2, CircleAlert, Code2, Copy, FileText, FlaskConical, History, Leaf, LoaderCircle, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import { can, type OfficeUser } from './model';
import { environmentApi, EnvironmentApiError } from './environment-client';
import { environmentFailure, useEnvironmentSession } from './EnvironmentSession';
import { environmentTime, type NvvJsonObject, type NvvJsonValue, type NvvSandboxPreset, type NvvSandboxRequest, type NvvSandboxRun, type NvvSandboxState } from './environment-types';
import NvvConnectionCheckDialog, { type NvvCheckProgress } from './NvvConnectionCheckDialog';
import AddressField from '../address-assistance/AddressField';
import './environment.css';
import './nvv-sandbox.css';

const runLabels: Record<NvvSandboxRun['status'], string> = { in_flight: 'Inväntar NVV', accepted: 'Mottaget i TEST', rejected: 'Avvisat', unknown: 'Oklart resultat' };
const jsonText = (value: unknown) => JSON.stringify(value, null, 2);
const supportPreset: NvvSandboxPreset = 'support-2026-10-16';
const ownPreset: NvvSandboxPreset = 'testbolag1-own-2026-10-16';
const freshOwnForm = (template: NvvJsonObject): NvvJsonObject => {
  const time = new Date().toISOString();
  return { ...structuredClone(template), tidpunkt: time, mottagningsDatum: time,
    referens: `JEROC-OWN-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}` };
};
const objectValue = (value: NvvJsonValue | undefined): NvvJsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const fieldValue = (payload: NvvJsonObject | undefined, path: string[]) => {
  let value: NvvJsonValue | undefined = payload;
  for (const part of path) value = objectValue(value)[part];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
};
function parsePayload(value: string): NvvJsonObject {
  const result: unknown = JSON.parse(value);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('JSON-payloaden måste vara ett objekt.');
  return result as NvvJsonObject;
}
const localDateTime = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
};
const progressFor = (run: NvvSandboxRun): NvvCheckProgress => run.status === 'in_flight'
  ? { phase: 'running', mode: 'test' }
  : run.status === 'accepted' ? { phase: 'success', mode: 'test', wasteCodes: 0, transportModes: 0 }
    : { phase: 'error', mode: 'test', message: run.error?.message || (run.status === 'unknown' ? 'Servern har inget säkert slutresultat. Kontrollera testhistoriken innan en ny sändning.' : 'NVV:s testmiljö avvisade anropet. Se råsvaret nedan.') };

type SubmissionDialog = { progress: NvvCheckProgress; payload: NvvJsonObject; run?: NvvSandboxRun };

export default function NvvSandboxWorkspace({ user, actualUser }: { user: OfficeUser; actualUser: OfficeUser }) {
  const { session, loading: sessionLoading, error: sessionError, refreshSession } = useEnvironmentSession();
  const permitted = user.level === 'Systemadmin' && actualUser.level === 'Systemadmin' && !user.siteIds && !actualUser.siteIds && can(user, 'environmentIntegration');
  const sessionMatches = session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const identity = `${actualUser.id}/${actualUser.level}/${actualUser.permissions.join(',')}/${actualUser.siteIds?.join(',') ?? 'all'}/${user.id}/${user.level}/${user.permissions.join(',')}/${user.siteIds?.join(',') ?? 'all'}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const mounted = useRef(true), generation = useRef(0), busy = useRef(false);
  const readFlight = useRef<{ generation: number; promise: Promise<void>; controller: AbortController } | undefined>(undefined);
  const writeController = useRef<AbortController | undefined>(undefined);
  const requestRef = useRef<{ request: NvvSandboxRequest; fingerprint: string } | undefined>(undefined);
  const formRef = useRef<NvvJsonObject | undefined>(undefined);
  const dialogRef = useRef<SubmissionDialog | null>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const [sandbox, setSandbox] = useState<NvvSandboxState>();
  const [payload, setPayload] = useState<NvvJsonObject>();
  const queryPreset = new URLSearchParams(window.location.search).get('preset');
  // Existing bookmarked support links now open the requested own-reporting probe.
  // Historical runs keep their original preset and payload.
  const requestedPreset = useRef<NvvSandboxPreset | undefined>(!queryPreset || queryPreset === supportPreset || queryPreset === ownPreset ? ownPreset : undefined);
  const [preset, setPreset] = useState<NvvSandboxPreset | undefined>(requestedPreset.current);
  const [editor, setEditor] = useState<'fields' | 'json'>('fields');
  const [raw, setRaw] = useState('');
  const [loading, setLoading] = useState(false), [sending, setSending] = useState(false), [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<SubmissionDialog | null>(null);
  dialogRef.current = dialog;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; readFlight.current?.controller.abort(); writeController.current?.abort(); }; }, []);
  useEffect(() => {
    generation.current++; readFlight.current?.controller.abort(); readFlight.current = undefined;
    writeController.current?.abort(); writeController.current = undefined; busy.current = false;
    requestRef.current = undefined; formRef.current = undefined; dialogRef.current = null;
    setSandbox(undefined); setPayload(undefined); setRaw(''); setDialog(null); setEditor('fields');
    setPreset(requestedPreset.current);
    setSending(false); setUncertain(false); setError(''); setNotice('');
  }, [identity]);

  const adoptForm = (value: NvvJsonObject) => {
    const copy = structuredClone(value); formRef.current = copy; setPayload(copy); setRaw(jsonText(copy)); setError('');
  };
  const load = useCallback((): Promise<void> => {
    if (!permitted || !sessionMatches) return Promise.resolve();
    const epoch = generation.current;
    if (readFlight.current?.generation === epoch) return readFlight.current.promise;
    const controller = new AbortController(), current = () => mounted.current && !controller.signal.aborted && generation.current === epoch && identityRef.current === identity;
    const flight = { generation: epoch, controller, promise: Promise.resolve() };
    setLoading(true);
    flight.promise = (async () => {
      try {
        const next = await environmentApi.nvvSandbox(controller.signal);
        if (!current()) return;
        setSandbox(next); setError('');
        if (!formRef.current) {
          const copy = requestedPreset.current === ownPreset && next.ownTest ? freshOwnForm(next.ownTest.template) : structuredClone(next.template);
          formRef.current = copy; setPayload(copy); setRaw(jsonText(copy));
        }
        const recovering = requestRef.current;
        if (recovering) {
          let found = next.runs.find(run => run.id === recovering.request.requestId);
          if (!found && uncertain) {
            try { found = await environmentApi.nvvSandboxRun(recovering.request.requestId, controller.signal); }
            catch (failure) { if (!(failure instanceof EnvironmentApiError && failure.status === 404)) throw failure; }
          }
          if (!current()) return;
          if (found) {
            const run = found;
            setSandbox(state => state ? { ...state, runs: [run, ...state.runs.filter(item => item.id !== run.id)].slice(0, 50) } : state);
            setUncertain(false);
            if (run.status === 'accepted' || run.status === 'rejected') requestRef.current = undefined;
            if (dialogRef.current && (dialogRef.current.run?.id === run.id || !dialogRef.current.run))
              setDialog({ progress: progressFor(run), payload: structuredClone(run.payload), run });
          }
        }
      } catch (failure) { if (current()) setError(environmentFailure(failure)); }
      finally { if (current()) setLoading(false); if (readFlight.current === flight) readFlight.current = undefined; }
    })();
    readFlight.current = flight;
    return flight.promise;
  }, [permitted, sessionMatches, identity, uncertain]);

  useEffect(() => {
    if (!permitted || !sessionMatches) return;
    void load();
    return () => { readFlight.current?.controller.abort(); readFlight.current = undefined; };
  }, [identity, permitted, sessionMatches]);
  const unresolved = sandbox?.runs.find(run => run.id === requestRef.current?.request.requestId && (run.status === 'in_flight' || run.status === 'unknown'));
  const stoppedOwnRun = sandbox?.runs.find(run => run.preset === ownPreset && run.status !== 'rejected');
  const ownReady = !!sandbox?.ownTest?.ready && !stoppedOwnRun;
  const selectedTest = preset === ownPreset ? sandbox?.ownTest : sandbox?.supportTest;
  const stoppedPresetRun = preset && sandbox?.runs.find(run => run.preset === preset && run.status !== 'rejected');
  const presetReady = !!selectedTest?.ready && !stoppedPresetRun;
  const issueFor = (stopped: NvvSandboxRun | undefined, config: NvvSandboxState['ownTest']) => stopped
    ? stopped.status === 'accepted' ? 'Ett prov med denna mall har redan tagits emot av NVV. Inga fler ska skickas.' : 'Ett prov med denna mall saknar säkert slutresultat. Kontrollera historiken före ett nytt prov.'
    : config?.issues.join(' ') || (!config ? 'Testmallen blir tillgänglig när serveruppdateringen är klar.' : '');
  const ownIssue = issueFor(stoppedOwnRun, sandbox?.ownTest);
  const presetIssue = issueFor(stoppedPresetRun || undefined, selectedTest);
  useEffect(() => {
    if (!sessionMatches || (!uncertain && unresolved?.status !== 'in_flight')) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [sessionMatches, uncertain, unresolved?.id, unresolved?.status, load]);

  function updateField(path: string[], value: NvvJsonValue) {
    const copy = structuredClone(formRef.current ?? {});
    let owner = copy;
    for (const part of path.slice(0, -1)) { owner[part] = { ...objectValue(owner[part]) }; owner = owner[part] as NvvJsonObject; }
    owner[path.at(-1)!] = value; adoptForm(copy);
  }
  function switchEditor(next: 'fields' | 'json') {
    if (next === editor) return;
    if (next === 'fields') {
      try { adoptForm(parsePayload(raw)); }
      catch (failure) { setError(`JSON-payloaden kunde inte läsas: ${environmentFailure(failure)}`); return; }
    } else setRaw(jsonText(formRef.current ?? {}));
    setEditor(next); setError('');
  }
  function toggleAgent(enabled: boolean) {
    const copy = structuredClone(formRef.current ?? {});
    for (const key of ['ombud', 'ombudetsNamn', 'ombudetsKontaktpersonNamn', 'ombudetsKontaktpersonEpost', 'ombudetsKontaktpersonTelefonnummer']) {
      if (enabled) copy[key] = copy[key] ?? ''; else delete copy[key];
    }
    adoptForm(copy);
  }
  function prepareOwnTest() {
    if (!ownReady || !sandbox?.ownTest || busy.current || uncertain || unresolved) return;
    adoptForm(freshOwnForm(sandbox.ownTest.template)); setPreset(ownPreset); setEditor('fields');
    setNotice('Testbolag 1 utan ombud är förberett. Granska uppgifterna och tryck på Skicka till NVV · TEST.');
  }
  async function send() {
    if (!permitted || !sessionMatches || busy.current || !sandbox?.ready || sandbox.mode !== 'test' || unresolved || uncertain || preset && !presetReady) return;
    let frozen: NvvJsonObject;
    try { frozen = structuredClone(editor === 'json' ? parsePayload(raw) : formRef.current ?? {}); }
    catch (failure) { setError(`JSON-payloaden kunde inte läsas: ${environmentFailure(failure)}`); return; }
    const fingerprint = JSON.stringify({ payload: frozen, preset: preset ?? null });
    if (requestRef.current?.fingerprint !== fingerprint) {
      const requestId = crypto.randomUUID();
      requestRef.current = { fingerprint, request: { requestId, idempotencyKey: `nvv-test-${requestId}`, payload: frozen, ...(preset && { preset }) } };
    }
    const submitted = requestRef.current.request, epoch = generation.current;
    const controller = new AbortController(); writeController.current = controller;
    const current = () => mounted.current && identityRef.current === identity && generation.current === epoch;
    busy.current = true; setSending(true); setError(''); setNotice('');
    const pendingDialog: SubmissionDialog = { progress: { phase: 'running', mode: 'test' }, payload: frozen };
    dialogRef.current = pendingDialog; setDialog(pendingDialog);
    try {
      const run = await environmentApi.sendNvvSandbox(submitted, controller.signal);
      if (!current()) return;
      setSandbox(state => state ? { ...state, runs: [run, ...state.runs.filter(item => item.id !== run.id)].slice(0, 50) } : state);
      setUncertain(false);
      if (run.status === 'accepted' || run.status === 'rejected') requestRef.current = undefined;
      if (dialogRef.current && (!dialogRef.current.run || dialogRef.current.run.id === submitted.requestId))
        setDialog({ progress: progressFor(run), payload: structuredClone(run.payload), run });
      setNotice(run.status === 'accepted' ? 'NVV:s testmiljö tog emot anropet.' : run.status === 'rejected' ? 'Testets svar finns i historiken.' : 'Slutresultatet är inte känt. Kontrollera testhistoriken.');
    } catch (failure) {
      if (!current()) return;
      const definite = failure instanceof EnvironmentApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status);
      const message = definite ? environmentFailure(failure) : 'Serverns slutresultat saknas. Kontrollera testhistoriken innan en ny sändning.';
      setUncertain(!definite); setError(message);
      if (dialogRef.current && (!dialogRef.current.run || dialogRef.current.run.id === submitted.requestId))
        setDialog({ progress: { phase: 'error', mode: 'test', message }, payload: frozen });
    } finally { if (current()) { busy.current = false; setSending(false); } if (writeController.current === controller) writeController.current = undefined; }
  }

  const field = (label: string, path: string[], options?: { numeric?: boolean; date?: boolean; wide?: boolean }) => {
    const value = fieldValue(payload, path);
    if (path.length === 3 && path[1] === 'adress' && path[2] === 'adressrad') {
      const place = path[0];
      return <label className={options?.wide ? 'is-wide' : undefined}>{label}<AddressField
        aria-label={label}
        value={{ address: value, postalCode: fieldValue(payload, [place, 'adress', 'postnummer']), city: '', countryCode: 'SE' }}
        scopeKey={`nvv-test:${identity}:${place}:${preset ?? 'manual'}`} disabled={sending || loading || uncertain || !!unresolved}
        requestHeaders={{ 'X-Demo-Actor': actualUser.id, 'X-Demo-User': user.id }} autoComplete="off"
        onChange={text => updateField(path, text)} onApply={address => {
          const copy = structuredClone(formRef.current ?? {}), previous = objectValue(copy[place]);
          copy[place] = { ...previous, adress: { ...objectValue(previous.adress), adressrad: address.address, postnummer: address.postalCode } };
          adoptForm(copy);
        }} /></label>;
    }
    return <label className={options?.wide ? 'is-wide' : undefined}>{label}<input type={options?.date ? 'datetime-local' : options?.numeric ? 'number' : 'text'} step={options?.numeric ? '0.001' : undefined} value={options?.date ? localDateTime(value) : value} onChange={event => {
      const next = event.target.value;
      if (options?.date && next && !Number.isFinite(Date.parse(next))) { setError('Datumet kunde inte läsas. Ange ett giltigt datum och klockslag.'); return; }
      updateField(path, options?.date && next ? new Date(next).toISOString() : options?.numeric && next !== '' ? Number(next) : next);
    }} autoComplete="off" /></label>;
  };
  const agentEnabled = payload && Object.prototype.hasOwnProperty.call(payload, 'ombud');
  const blockedReason = sending ? 'Inväntar serverns svar.' : uncertain || unresolved ? 'Ett test saknar säkert slutresultat. Kontrollera testhistoriken.'
    : sandbox?.mode !== 'test' ? 'Servern behöver vara inställd för NVV:s testmiljö.' : !sandbox.ready ? 'Komplettera serveranslutningen före testet.' : preset && !presetReady ? presetIssue || 'Testet kan inte skickas med den aktuella anslutningen.' : '';

  return <section className="environment-workspace nvv-sandbox-workspace">
    <OfficePageHeader>
    <div className="office-title environment-workspace-title"><div><a className="office-link" href="/kontor#/integrations?service=nvv"><ArrowLeft size={14} />Till NVV-inställningar</a><span className="office-eyebrow">INTEGRATIONER · SEPARAT TESTFORMULÄR</span><h1>NVV · systemadminstest</h1><p>Prova ett mottagningsanrop och se exakt vilka uppgifter NVV svarar på.</p></div><span className="environment-pill warning"><FlaskConical size={14} />Endast TEST</span></div>
    </OfficePageHeader>
    {!permitted ? <div className="office-panel environment-empty"><ShieldCheck size={30} /><h2>Endast systemadmin</h2><p>Testformuläret kräver systemadmin med NVV-behörighet.</p></div>
      : !sessionMatches ? <div className="environment-access"><LoaderCircle size={18} /><span>{sessionError || (sessionLoading ? 'Ansluter testsessionen…' : 'Testsessionen kunde inte anslutas.')}</span>{!sessionLoading && <button className="office-link" type="button" onClick={() => void refreshSession().catch(() => undefined)}>Försök igen</button>}</div>
        : <>
          <div className="nvv-sandbox-context office-panel"><span className="environment-icon"><Leaf size={22} /></span><div><strong>NVV:s testmiljö · POST /insamlingar</strong><p>Serverns klientcertifikat och API-anslutning används. Testet ändrar inga viktkort, lager eller ekonomiposter.</p>{sandbox?.certificate?.metadataAvailable && <small>Certifikat: {sandbox.certificate.organisationName || 'Namn ej angivet'}{sandbox.certificate.organisationNumber && ` · ${sandbox.certificate.organisationNumber}`}</small>}</div><button className="office-btn outline" type="button" disabled={loading} onClick={() => void load()}><RefreshCw size={14} />{loading ? 'Hämtar…' : 'Kontrollera testhistorik'}</button></div>
          {!!sandbox?.missing.length && <div className="environment-alert" role="status"><CircleAlert size={16} /><div><strong>Återstår före testet</strong><ul>{sandbox.missing.map(item => <li key={item}>{item}</li>)}</ul></div></div>}
          <section className="office-panel nvv-support-test" aria-label="Testbolag 1 utan ombud"><div><span className="office-eyebrow">FÖRIFYLLT KONTROLLPROV</span><h2>Testbolag 1 · egen rapportering</h2><p>Samma testorganisation används i verksamhetsuppgifterna och klientcertifikatet. Inga ombudsuppgifter skickas.</p><dl><div><dt>Verksamhetsutövare och certifikat</dt><dd>Testbolag 1 · 5560000167</dd></div><div><dt>Tidigare innehavare</dt><dd>Testbolag 1 · 5560000167</dd></div></dl><p>Testkontakter, material och platser fylls i automatiskt. Inget skickas förrän du trycker på Skicka till NVV · TEST.</p>{ownIssue && <p className="nvv-support-issue" role="status">{ownIssue}</p>}{preset === ownPreset && <span className="environment-pill success"><CheckCircle2 size={13} />Testbolag 1 utan ombud är valt</span>}</div><button type="button" className="office-btn outline" disabled={!ownReady || loading || sending || uncertain || !!unresolved} onClick={prepareOwnTest}><FlaskConical size={15} />Förbered Testbolag 1 utan ombud</button></section>
          {error && <div className="environment-error" role="alert"><CircleAlert size={16} />{error}</div>}
          {notice && <p className="nvv-sandbox-notice" role="status">{notice}</p>}
          {payload ? <div className="nvv-sandbox-layout">
            <form className="office-panel nvv-sandbox-form" onSubmit={event => { event.preventDefault(); void send(); }} aria-label="NVV:s testformulär">
              <div className="nvv-sandbox-form-header"><div><h2>Testuppgifter</h2><p>{preset === ownPreset ? 'Testbolag 1 är förifyllt utan ombud. Testorganisationen kontrolleras också på servern.' : preset ? 'Tidigare supportprov. Verksamhetsutövare och ombud kontrolleras också på servern.' : 'Ändra uppgifterna inför nästa test.'}</p></div><button className="office-link" type="button" onClick={() => { if (sandbox) { adoptForm(sandbox.template); setPreset(undefined); setNotice('Serverns testmall har återställts i formuläret.'); } }}>Återställ testmall</button></div>
              <div className="nvv-sandbox-tabs" role="tablist" aria-label="Redigera testpayload"><button type="button" role="tab" aria-selected={editor === 'fields'} aria-controls="nvv-sandbox-fields" onClick={() => switchEditor('fields')}><FileText size={15} />Formulär</button><button type="button" role="tab" aria-selected={editor === 'json'} aria-controls="nvv-sandbox-json" onClick={() => switchEditor('json')}><Code2 size={15} />Avancerad JSON</button></div>
              {editor === 'json' ? <div id="nvv-sandbox-json" role="tabpanel" className="nvv-sandbox-json"><label>JSON-payload<textarea value={raw} onChange={event => { setRaw(event.target.value); setError(''); }} rows={25} spellCheck={false} /></label><small>Objektet skickas som det skrivs. Adressen och autentiseringen bestäms av servern.</small></div>
                : <div id="nvv-sandbox-fields" role="tabpanel">
                  <fieldset><legend>Rapporterande verksamhet</legend><div className="nvv-sandbox-fields">{field('Verksamhetsutövare · organisationsnummer', ['verksamhetsutovare'])}{field('Verksamhetens namn', ['verksamhetensNamn'])}{field('Verksamhetens kontaktperson', ['verksamhetensKontaktpersonNamn'])}{field('Verksamhetens e-post', ['verksamhetensKontaktpersonEpost'])}{field('Verksamhetens telefon', ['verksamhetensKontaktpersonTelefonnummer'])}{field('Tidigare innehavare · organisationsnummer', ['tidigareInnehavare'])}</div></fieldset>
                  <fieldset><legend>Avfall & mottagning</legend><div className="nvv-sandbox-fields">{field('Avfallskod', ['avfall', 'kod'])}{field('Mängd (kg)', ['avfall', 'mangd'], { numeric: true })}{field('Mottagningsdatum', ['mottagningsDatum'], { date: true })}{field('Anteckningstid', ['tidpunkt'], { date: true })}<label>Transportsätt<select value={fieldValue(payload, ['transportsatt'])} onChange={event => updateField(['transportsatt'], event.target.value)}><option value="R">Vägtransport · R</option><option value="T">Järnväg · T</option><option value="S">Sjötransport · S</option><option value="A">Flygtransport · A</option>{!['R', 'T', 'S', 'A'].includes(fieldValue(payload, ['transportsatt'])) && <option value={fieldValue(payload, ['transportsatt'])}>{fieldValue(payload, ['transportsatt']) || 'Ej angivet'}</option>}</select></label>{field('Referens', ['referens'])}</div></fieldset>
                  {(['senasteHanteringsPlats', 'kommandeHanteringsPlats'] as const).map(place => <fieldset key={place}><legend>{place === 'senasteHanteringsPlats' ? 'Senaste hanteringsplats' : 'Kommande hanteringsplats'}</legend><div className="nvv-sandbox-fields">{field('Adress' + (place === 'senasteHanteringsPlats' ? ' · senaste hanteringsplats' : ' · kommande hanteringsplats'), [place, 'adress', 'adressrad'], { wide: true })}{field('Postnummer' + (place === 'senasteHanteringsPlats' ? ' · senaste hanteringsplats' : ' · kommande hanteringsplats'), [place, 'adress', 'postnummer'])}{field('Kommunkod' + (place === 'senasteHanteringsPlats' ? ' · senaste hanteringsplats' : ' · kommande hanteringsplats'), [place, 'kommunkod'])}</div>
                  </fieldset>)}
                  <fieldset><legend>Ombud</legend><label className="nvv-sandbox-agent-toggle"><input type="checkbox" checked={!!agentEnabled} onChange={event => toggleAgent(event.target.checked)} />Lägg till ombudsuppgifter för detta test</label>{agentEnabled && <div className="nvv-sandbox-fields">{field('Ombud · organisationsnummer', ['ombud'])}{field('Ombudets namn', ['ombudetsNamn'])}{field('Ombudets kontaktperson', ['ombudetsKontaktpersonNamn'])}{field('Ombudets e-post', ['ombudetsKontaktpersonEpost'])}{field('Ombudets telefon', ['ombudetsKontaktpersonTelefonnummer'])}</div>}</fieldset>
                </div>}
              <div className="nvv-sandbox-submit"><div><strong>Skickning sker endast när du trycker på knappen.</strong>{blockedReason && <small>{blockedReason}</small>}</div><button ref={submitButton} className="office-btn" type="submit" disabled={!!blockedReason}><Send size={15} />{sending ? 'Skickar…' : 'Skicka till NVV · TEST'}</button></div>
            </form>
            <aside className="office-panel nvv-sandbox-preview" aria-label="Utgående testpayload"><h2><Code2 size={18} />Utgående payload</h2><p>{editor === 'json' ? 'Innehållet i JSON-redigeraren skickas.' : 'Formulärets aktuella NVV-fält.'}</p><pre>{editor === 'json' ? raw : jsonText(payload)}</pre><small>Varje test sparar en egen kopia av payloaden, svaret och spårnings-ID:t.</small></aside>
          </div> : loading && <div className="environment-empty"><LoaderCircle size={25} /><p>Hämtar testmallen…</p></div>}
          <section className="office-panel nvv-sandbox-history" aria-label="NVV:s testhistorik"><header><div><h2><History size={19} />Testhistorik</h2><p>Senaste 50 testerna. Tidigare payload och svar bevaras.</p></div>{unresolved && <span className="environment-pill warning"><CircleAlert size={13} />{runLabels[unresolved.status]}</span>}</header>
            {!sandbox?.runs.length ? <p className="nvv-sandbox-empty">Inga tester har skickats från detta formulär.</p> : <ol>{sandbox.runs.map(run => <li key={run.id}>
              <div className="nvv-sandbox-run-heading"><span className={`environment-pill ${run.status === 'accepted' ? 'success' : 'warning'}`}>{run.status === 'accepted' ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}{runLabels[run.status]}</span><strong>{environmentTime(run.startedAt)}</strong><span>{run.httpStatus == null ? 'Inget HTTP-svar' : `HTTP ${run.httpStatus}`}</span><div><button className="office-link" type="button" onClick={() => setDialog({ progress: progressFor(run), payload: structuredClone(run.payload), run })}><ArrowUpRight size={14} />Visa anrop och svar</button><button className="office-link" type="button" onClick={() => { adoptForm(run.payload); setPreset(run.preset); setNotice('Testets uppgifter har lagts i formuläret. Inget nytt anrop har skickats.'); }}><Copy size={14} />Använd uppgifter</button></div></div>
              <small>{run.preset === ownPreset ? 'Testbolag 1 utan ombud · ' : run.preset ? 'NVV-supportens test · ' : ''}Spårnings-ID: {run.trackingId}</small>{run.profile && <small>Certifikatets organisation: {run.profile.certificateOrganisationNumber} · {run.transport?.protocol || 'TLS 1.2'}</small>}{run.avfallId && <small>Avfalls-ID: {run.avfallId}</small>}{run.error && <p>{run.error.message}</p>}
            </li>)}</ol>}
          </section>
        </>}
    {dialog && <NvvConnectionCheckDialog progress={dialog.progress} submission={{ payload: dialog.payload, run: dialog.run, uncertain }} returnFocus={submitButton} onClose={() => { dialogRef.current = null; setDialog(null); }} onRetry={() => void load()} />}
  </section>;
}
