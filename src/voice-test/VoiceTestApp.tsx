import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, AudioLines, Check, CheckCircle2, ChevronRight, ClipboardList, Clock3, Headphones, History, LoaderCircle, MessageSquareText, Mic, MicOff, Phone, PhoneCall, PhoneOff, RefreshCw, ShieldCheck, Sparkles, Volume2 } from 'lucide-react';
import { usePlatformContext } from '../platform/PlatformGate';
import { currentPlatformSession } from '../platform/session';
import { checkVoiceConnection, endVoiceCall, readVoice, readVoiceCall, updateVoiceFollowup, voiceDenied, voiceScope, voiceScopeKey } from './client';
import { followupLabels, ongoing, voiceStatusLabels, type VoiceCall, type VoiceCheck, type VoiceFollowup, type VoicePhase, type VoiceState } from './types';
import { useVoiceSession, voiceMediaUnavailable } from './useVoiceSession';
import './voice-test.css';

const time = (value: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
const dateTime = (value: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const duration = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;
const phaseLabels: Record<VoicePhase, string> = { idle: 'Redo för ett testsamtal', microphone: 'Väntar på mikrofonen', connecting: 'Ansluter samtalet', listening: 'AI lyssnar', thinking: 'AI förbereder sitt svar', speaking: 'AI talar', ending: 'Avslutar samtalet', error: 'Kontrollera anslutningen' };
const failureText = (failure: unknown) => failure instanceof TypeError ? 'Kunde inte nå rösttjänsten. Kontrollera anslutningen och försök igen.' : failure instanceof Error ? failure.message : 'Rösttestet kunde inte uppdateras. Försök igen.';

export default function VoiceTestApp() {
  const platform = usePlatformContext(), session = platform?.session ?? currentPlatformSession();
  const scope = useMemo(() => voiceScope(session), [voiceScopeKey(session)]), key = scope.key;
  const keyRef = useRef(key); keyRef.current = key;
  const mounted = useRef(true), epoch = useRef(0), reading = useRef<AbortController | null>(null), writing = useRef<AbortController | null>(null), polling = useRef<AbortController | null>(null);
  const [stored, setStored] = useState<{ key: string; data: VoiceState }>(), [selected, setSelected] = useState('');
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(''), [uncertain, setUncertain] = useState(false), [checking, setChecking] = useState(false);
  const [connection, setConnection] = useState<VoiceCheck>(), [online, setOnline] = useState(navigator.onLine), [now, setNow] = useState(Date.now());
  const details = useRef<HTMLElement>(null), stopAudio = useRef<() => void>(() => undefined);
  const data = scope.allowed && stored?.key === key ? stored.data : undefined;
  const dataRef = useRef(data); dataRef.current = data;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const current = useCallback(() => mounted.current && keyRef.current === key && voiceScopeKey() === key, [key]);
  const clearPrivate = useCallback(() => {
    // A concurrent response from before a revocation must not restore the
    // private journal after the server has denied a read or write.
    epoch.current++; reading.current?.abort(); writing.current?.abort(); polling.current?.abort();
    reading.current = null; writing.current = null; polling.current = null;
    stopAudio.current(); setStored(undefined); setSelected(''); setConnection(undefined); setUncertain(true);
    setBusy(''); setChecking(false); setLoading(false);
  }, []);
  const failure = useCallback((value: unknown) => {
    if (!current()) return;
    if (voiceDenied(value)) { clearPrivate(); window.dispatchEvent(new Event('scrappilot:check-platform-session')); }
    setError(failureText(value));
  }, [current, clearPrivate]);
  const acceptCall = useCallback((call: VoiceCall) => {
    if (!current()) return;
    setStored(previous => {
      if (previous?.key !== key) return previous;
      const old = previous.data.calls.find(item => item.id === call.id);
      if (old && old.revision > call.revision) return previous;
      const calls = [call, ...previous.data.calls.filter(item => item.id !== call.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
      return { key, data: { ...previous.data, calls, currentCall: ongoing(call) ? call : previous.data.currentCall?.id === call.id ? null : previous.data.currentCall } };
    });
    setSelected(value => value || call.id);
  }, [key, current]);
  const load = useCallback(async () => {
    if (!scope.allowed || reading.current || writing.current) return;
    const controller = new AbortController(), version = epoch.current; reading.current = controller; setLoading(true);
    const valid = () => current() && version === epoch.current && reading.current === controller;
    try {
      const value = await readVoice(scope, controller.signal); if (!valid() || controller.signal.aborted) return;
      setStored(previous => {
        if (previous?.key === key && previous.data.revision > value.revision) return previous;
        if (previous?.key !== key) return { key, data: value };
        const calls = value.calls.map(call => { const old = previous.data.calls.find(item => item.id === call.id); return old && old.revision > call.revision ? old : call; });
        const candidate = value.currentCall ? calls.find(call => call.id === value.currentCall?.id) ?? value.currentCall : null;
        return { key, data: { ...value, calls, currentCall: ongoing(candidate) ? candidate : null } };
      });
      setSelected(previous => previous && value.calls.some(call => call.id === previous) ? previous : value.currentCall?.id ?? value.calls[0]?.id ?? '');
      setError(''); setUncertain(false);
    } catch (value) { if (valid()) failure(value); }
    finally { if (valid()) setLoading(false); if (reading.current === controller) reading.current = null; }
  }, [scope, key, current, failure]);
  const recover = useRef(load); recover.current = load;
  const voice = useVoiceSession(scope, { onCall: acceptCall, onFailure: failure, onUncertain: () => { if (current()) { setUncertain(true); void recover.current(); } } });
  stopAudio.current = voice.stopLocal;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; reading.current?.abort(); writing.current?.abort(); polling.current?.abort(); }; }, []);
  useEffect(() => { epoch.current++; reading.current?.abort(); writing.current?.abort(); polling.current?.abort(); reading.current = null; writing.current = null; polling.current = null; setStored(undefined); setSelected(''); setError(''); setConnection(undefined); setUncertain(false); setBusy(''); setChecking(false); setLoading(false); void load(); }, [key, load]);
  useEffect(() => {
    const visible = () => { if (!document.hidden) void load(); }, connected = () => { setOnline(navigator.onLine); if (navigator.onLine) void load(); };
    document.addEventListener('visibilitychange', visible); window.addEventListener('online', connected); window.addEventListener('offline', connected);
    return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', connected); window.removeEventListener('offline', connected); };
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const active = dataRef.current?.currentCall ?? dataRef.current?.calls.find(call => call.id === selectedRef.current && call.summaryStatus === 'pending');
      if (!current() || document.hidden || polling.current || !active || !ongoing(active) && active.summaryStatus !== 'pending') return;
      const controller = new AbortController(); polling.current = controller;
      void readVoiceCall(scope, active.id, controller.signal).then(call => { if (current() && !controller.signal.aborted) { acceptCall(call); voice.acceptServerCall(call); } })
        .catch(value => { if (!controller.signal.aborted) failure(value); }).finally(() => { if (polling.current === controller) polling.current = null; });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [scope, current, acceptCall, failure, voice.acceptServerCall]);
  useEffect(() => { if (!data?.currentCall && !voice.localActive) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [data?.currentCall?.id, voice.localActive]);
  useEffect(() => {
    const local = data?.calls.find(call => call.id === voice.localCallId);
    if (local) voice.acceptServerCall(local);
  }, [data?.calls, voice.localCallId, voice.acceptServerCall]);
  async function testConnection() {
    if (checking || writing.current || !data?.config.enabled || !data.config.keyPresent) return;
    const controller = new AbortController(); writing.current = controller; setChecking(true); setError('');
    try { const value = await checkVoiceConnection(scope, controller.signal); if (current() && !controller.signal.aborted) setConnection(value); }
    catch (value) { if (current()) failure(value); }
    finally { if (current()) setChecking(false); if (writing.current === controller) writing.current = null; }
  }
  async function changeFollowup(call: VoiceCall, status: VoiceFollowup) {
    if (writing.current || busy) return;
    const controller = new AbortController(); writing.current = controller; setBusy(call.id); setError('');
    try { const value = await updateVoiceFollowup(scope, call.id, status, controller.signal); if (current() && !controller.signal.aborted) acceptCall(value); }
    catch (value) { if (current()) failure(value); }
    finally { if (current()) setBusy(''); if (writing.current === controller) writing.current = null; }
  }
  async function endOtherCall(call: VoiceCall) {
    if (writing.current || busy) return;
    const controller = new AbortController(); writing.current = controller; setBusy(call.id); setError('');
    try { const value = await endVoiceCall(scope, call.id, controller.signal); if (current() && !controller.signal.aborted) acceptCall(value); }
    catch (value) { if (current()) { failure(value); setUncertain(true); } }
    finally { if (current()) setBusy(''); if (writing.current === controller) writing.current = null; }
  }
  const active = data?.currentCall, selectedCall = data?.calls.find(call => call.id === selected) ?? active ?? data?.calls[0];
  const activeSeconds = Math.min(data?.config.maxDurationSeconds ?? 180, active?.startedAt ? Math.max(active.durationSeconds, Math.floor((now - Date.parse(active.startedAt)) / 1000)) : active?.durationSeconds ?? 0);
  const local = voice.localActive || ['microphone', 'connecting', 'ending'].includes(voice.phase);
  const unavailable = voiceMediaUnavailable();
  const canStart = !!data?.config.available && online && !unavailable && !active && !local && !uncertain && !loading && !checking && !busy;
  const companyName = data?.config.companyName || (session?.authenticated ? session.company?.name : '') || 'Ditt bolag';
  const status = active && !voice.localActive ? 'Ett testsamtal pågår i bolaget' : voice.phase === 'idle' && !data?.config.available ? 'Rösttestet är inte tillgängligt' : phaseLabels[voice.phase];
  return <main className="voice-test-app"><header className="voice-test-heading"><div><a className="voice-test-back" href="/kontor#/integrations"><ArrowLeft size={15} />Till kontoret</a><span className="voice-test-eyebrow">TESTLABBET · RÖST</span><h1>AI-kundmottagning</h1><p>Prova ett samtal med {companyName}s digitala kundmottagning.</p></div><span className="voice-test-test-badge"><ShieldCheck size={15} />Endast test</span></header>
    <div className="voice-test-settings-note"><span>{data?.config.voice ? `Nästa samtal: ${data.config.protocol === 'live' ? 'GPT-Live · ' : ''}${data.config.voice} · kunskapsversion ${data.config.knowledgeRevision ?? 0}` : 'Röst och kundgodkänd kunskap ställs in för bolaget.'}</span><a href="/kontor#/integrations?service=ai-support">Röst &amp; kunskap <ArrowUpRight size={13} /></a></div>
    {!scope.allowed ? <section className="voice-test-empty" role="alert"><ShieldCheck size={31} /><h2>Behörighet krävs</h2><p>Välj ett bolag och logga in med behörighet att använda rösttestet.</p></section> : <>
    {error && !voice.error && <div className="voice-test-notice error" role="alert"><span>{error}</span><button type="button" disabled={loading || !!busy} onClick={() => void load()}><RefreshCw size={15} />Hämta samtalsstatus</button></div>}
    <div className="voice-test-grid"><section className="voice-test-callcard" aria-label="Testsamtal"><header><div className="voice-test-company-brand">{/^jeroc/i.test(companyName) ? <img src="/images/jeroc-logo-ui.webp" alt="JEROC Återvinning" /> : <><span><Headphones size={22} /></span><strong>{companyName}</strong></>}</div><span className="voice-test-small-test">TEST</span></header><div className={`voice-test-phone-visual ${voice.phase}${voice.muted ? ' muted' : ''}`}><i /><i /><div>{voice.phase === 'speaking' || voice.phase === 'listening' || voice.phase === 'thinking' ? <AudioLines size={43} /> : <PhoneCall size={40} />}</div></div><div className="voice-test-caller"><span>Testkund · inkommande nummer</span><strong>{data?.config.callerNumber || '+46700000000'}</strong>{data?.config.site && <small className="voice-test-site">Testanläggning · {data.config.site.name}</small>}</div><div className={`voice-test-live-status ${voice.phase}`} role="status" aria-label="Samtalsstatus"><span />{status}</div>{(active || local) && <div className="voice-test-call-duration"><Clock3 size={14} /><span>{duration(activeSeconds)}</span><small>av högst {duration(data?.config.maxDurationSeconds ?? 180)}</small></div>}
      {voice.needsAudio && <div className="voice-test-notice audio"><Volume2 size={20} /><div><strong>Aktivera ljudet för att höra AI:n</strong><button type="button" onClick={() => void voice.activateAudio()}>Aktivera ljud</button></div></div>}{voice.error && <p className="voice-test-call-error" role="alert">{voice.error}</p>}
      {local ? <div className="voice-test-live-controls"><button type="button" className={voice.muted ? 'muted' : ''} aria-label={voice.muted ? 'Slå på mikrofonen' : 'Stäng av mikrofonen'} aria-pressed={voice.muted} disabled={voice.phase === 'microphone' || voice.phase === 'ending'} onClick={voice.mute}>{voice.muted ? <MicOff size={23} /> : <Mic size={23} />}<span>{voice.muted ? 'Mikrofon av' : 'Mikrofon på'}</span></button><button type="button" className="end" aria-label="Avsluta samtalet" disabled={voice.phase === 'ending'} onClick={() => void voice.end()}><PhoneOff size={24} /><span>Avsluta</span></button></div> : active ? <div className="voice-test-existing"><p>Ljudet kan inte återupptas på den här enheten. Avsluta det pågående testet innan du ringer igen.</p><button type="button" className="voice-test-end-other" disabled={!!busy} onClick={() => void endOtherCall(active)}><PhoneOff size={18} />{busy === active.id ? 'Avslutar…' : 'Avsluta pågående testsamtal'}</button><button type="button" className="voice-test-link" disabled={loading} onClick={() => { setSelected(active.id); void load(); }}>Visa pågående samtal</button></div> : <button type="button" className="voice-test-ring" disabled={!canStart} onClick={() => { setSelected(''); setError(''); voice.clearError(); void voice.start(data!.config.maxDurationSeconds, data!.config.protocol); }}><Phone size={22} />{loading && !data ? 'Hämtar rösttest…' : 'Starta testsamtal'}</button>}
      <p className="voice-test-microphone-note"><Mic size={14} />Ljudet behandlas av OpenAI. Här sparas text, ingen ljudinspelning.</p>{!online && <p className="voice-test-prerequisite">Anslut till internet för att ringa.</p>}{unavailable && <p className="voice-test-prerequisite">{unavailable}</p>}{data && !data.config.available && <p className="voice-test-prerequisite">{data.config.reason || 'Rösttjänsten behöver konfigureras på servern innan du kan ringa.'}</p>}{uncertain && <div className="voice-test-notice"><p>Kontrollera samtalsstatusen innan du startar ett nytt test.</p><button type="button" disabled={loading} onClick={() => void load()}>Hämta samtalsstatus</button></div>}
      <footer><button type="button" className="voice-test-link" disabled={checking || !data?.config.enabled || !data.config.keyPresent || !!active || local} onClick={() => void testConnection()}>{checking ? <LoaderCircle size={15} className="voice-test-spin" /> : <ShieldCheck size={15} />}{checking ? 'Kontrollerar AI-anslutningen…' : 'Kontrollera AI-anslutning'}</button>{connection && <div className={`voice-test-connection ${connection.ok ? 'ok' : ''}`} role="status">{connection.ok ? <CheckCircle2 size={15} /> : <RefreshCw size={15} />}<span>{connection.message}<small>{connection.model} · {time(connection.checkedAt)}</small></span></div>}</footer><audio ref={voice.audio} autoPlay playsInline aria-hidden="true" />
    </section>
    <section className="voice-test-details" ref={details} aria-label="Samtalsdetaljer"><header><span className="voice-test-section-icon"><ClipboardList size={22} /></span><div><h2>Uppföljning</h2><p>{selectedCall ? `${dateTime(selectedCall.createdAt)} · ${selectedCall.createdBy.name}${selectedCall.siteName ? ` · ${selectedCall.siteName}` : ''}` : 'Efter samtalet finns allt samlat här.'}</p></div>{selectedCall && <span className={`voice-test-status-pill ${selectedCall.status}`}>{voiceStatusLabels[selectedCall.status]}</span>}</header>{!selectedCall ? <div className="voice-test-waiting"><MessageSquareText size={42} /><h3>Från samtal till underlag</h3><p>Här visas vad testkunden och AI:n faktiskt sa, en sammanfattning och status för uppföljningen.</p><div><span><Check size={14} />Sparat transkript</span><span><Check size={14} />Sammanfattning</span><span><Check size={14} />Uppföljningsstatus</span></div></div> : <><div className="voice-test-record-facts"><span><Phone size={14} />{selectedCall.callerNumber}<b>TEST</b></span><span><Clock3 size={14} />{duration(selectedCall.durationSeconds)}</span></div><div className="voice-test-summary"><div className="voice-test-summary-title"><Sparkles size={17} /><h3>Sammanfattning</h3>{selectedCall.summaryStatus === 'fallback' && <span>Utdrag från samtalet</span>}</div>{selectedCall.summary ? <p>{selectedCall.summary}</p> : <p className="voice-test-muted">{ongoing(selectedCall) ? 'Sammanfattningen skapas när samtalet är avslutat.' : selectedCall.summaryStatus === 'pending' ? 'Sammanfattningen förbereds…' : 'Ingen sammanfattning finns för det här testet.'}</p>}{(selectedCall.topic || selectedCall.callbackRequested === true) && <div className="voice-test-topics">{selectedCall.topic && <span>{selectedCall.topic}</span>}{selectedCall.callbackRequested === true && <span>Önskar återkoppling</span>}</div>}</div><label className="voice-test-followup">Uppföljningsstatus<select value={selectedCall.followupStatus} disabled={!!busy || ongoing(selectedCall)} onChange={event => void changeFollowup(selectedCall, event.target.value as VoiceFollowup)}>{Object.entries(followupLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>{busy === selectedCall.id && <small role="status">Sparar status…</small>}</label>{!ongoing(selectedCall) && selectedCall.transcriptComplete === false && <p className="voice-test-incomplete">Transkriptet kan vara ofullständigt.</p>}{!ongoing(selectedCall) && selectedCall.providerConfirmed === false && <p className="voice-test-incomplete">Leverantörens avslut kunde inte bekräftas. Kontrollera samtalets status.</p>}<div className="voice-test-transcript-heading"><h3><MessageSquareText size={18} />Transkript</h3><span>{selectedCall.transcript.length} repliker</span></div>{selectedCall.transcript.length ? <ol className="voice-test-transcript">{selectedCall.transcript.map(turn => <li key={turn.id} className={turn.role}><span className="voice-test-speaker-icon">{turn.role === 'assistant' ? <Headphones size={16} /> : <Mic size={16} />}</span><div><div><strong>{turn.role === 'assistant' ? 'AI-kundmottagning' : 'Testkund'}</strong><time dateTime={turn.at}>{time(turn.at)}</time></div><p>{turn.text}</p>{turn.interrupted && <small>Avbrutet svar</small>}</div></li>)}</ol> : <div className="voice-test-empty-transcript"><AudioLines size={24} /><p>{ongoing(selectedCall) ? 'Färdiga repliker visas när de har sparats av servern.' : 'Inga färdiga repliker sparades i det här samtalet.'}</p></div>}{selectedCall.error && <p className="voice-test-call-error">{selectedCall.error}</p>}</> }</section>
    <section className="voice-test-history" aria-label="Samtalshistorik"><header><History size={20} /><div><h2>Senaste samtal</h2><p>Bolagets 20 senaste testsamtal.</p></div><button type="button" aria-label="Uppdatera samtal" disabled={loading || !!busy} onClick={() => void load()}><RefreshCw size={18} className={loading ? 'voice-test-spin' : undefined} /></button></header>{data?.calls.length ? <div className="voice-test-history-list">{data.calls.map(call => <button type="button" key={call.id} aria-label={`Öppna samtal ${call.id}`} aria-pressed={selectedCall?.id === call.id} onClick={() => { setSelected(call.id); if (window.innerWidth < 900) details.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }}><span className="voice-test-history-icon"><Phone size={17} /></span><span><strong>{dateTime(call.createdAt)}</strong><small>{voiceStatusLabels[call.status]} · {duration(call.durationSeconds)}</small></span><span className={`voice-test-followup-pill ${call.followupStatus}`}>{followupLabels[call.followupStatus]}</span><ChevronRight size={15} /></button>)}</div> : <div className="voice-test-history-empty"><Phone size={23} /><p>{loading ? 'Hämtar testsamtal…' : 'Inga testsamtal har sparats ännu.'}</p></div>}</section></div><footer className="voice-test-footer"><ShieldCheck size={14} />Testmiljö · inget verkligt telefonsamtal eller utgående meddelande skapas.<a href="/kontor#/integrations">Integrationer<ArrowUpRight size={13} /></a></footer></>}
  </main>;
}
