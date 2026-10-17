import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Clock3, Headphones, MessageSquareText, Mic, MicOff, Phone, PhoneCall, PhoneOff, RefreshCw, ShieldCheck, Volume2 } from 'lucide-react';
import { endVoiceCall, publicVoiceScope, readPublicVoice, readVoiceCall, VoiceApiError } from './client';
import { ongoing, type VoiceCall, type VoicePhase, type VoiceState } from './types';
import { useVoiceSession, voiceMediaUnavailable } from './useVoiceSession';
import './voice-test.css';

const duration = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;
const phaseLabels: Record<VoicePhase, string> = { idle: 'Redo för ett testsamtal', microphone: 'Väntar på mikrofonen', connecting: 'Ansluter samtalet', listening: 'AI lyssnar', thinking: 'AI förbereder sitt svar', speaking: 'AI talar', ending: 'Avslutar samtalet', error: 'Samtalet behöver kontrolleras' };
const failureText = (failure: unknown) => failure instanceof VoiceApiError ? failure.message
  : failure instanceof TypeError ? 'Kunde inte nå rösttjänsten. Kontrollera anslutningen och försök igen.'
    : 'Rösttjänsten svarade inte i tid. Kontrollera ditt samtal innan du försöker igen.';

/** A public visitor only sees the current browser capability's own call.
 * There is no platform session, company picker, journal list, or settings API. */
export default function PublicVoiceTestApp() {
  const [data, setData] = useState<VoiceState>(), [scope, setScope] = useState(() => publicVoiceScope(''));
  const [loading, setLoading] = useState(true), [ending, setEnding] = useState(false), [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(''), [online, setOnline] = useState(navigator.onLine), [now, setNow] = useState(Date.now());
  const mounted = useRef(true), epoch = useRef(0), reading = useRef<AbortController | null>(null), polling = useRef<AbortController | null>(null);
  const dataRef = useRef(data); dataRef.current = data;
  const finalCaptionWindow = useRef<{ id: string; until: number } | undefined>(undefined);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const stopAudio = useRef<() => void>(() => undefined), refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const failure = useCallback((value: unknown) => {
    if (!mounted.current) return;
    if (value instanceof VoiceApiError && [401, 403].includes(value.status)) {
      epoch.current++; reading.current?.abort(); polling.current?.abort(); reading.current = null; polling.current = null;
      stopAudio.current(); setData(undefined); setScope(publicVoiceScope('')); setUncertain(true); setLoading(false);
    }
    setError(failureText(value));
  }, []);
  const acceptCall = useCallback((call: VoiceCall, expectedId?: string) => {
    if (!mounted.current) return;
    const previous = dataRef.current;
    if (!previous || expectedId !== undefined && previous.currentCall?.id !== expectedId || previous.currentCall?.id === call.id && previous.currentCall.revision > call.revision) return;
    // Advance the identity synchronously so older GET callbacks cannot win a
    // race while React is still batching the newly accepted call's render.
    const next = { ...previous, calls: [], currentCall: call }; dataRef.current = next; setData(next);
  }, []);
  const voice = useVoiceSession(scope, { onCall: acceptCall, onFailure: failure, onUncertain: () => { if (mounted.current) { setUncertain(true); void refreshRef.current(); } } });
  stopAudio.current = voice.stopLocal;
  const load = useCallback(async () => {
    if (reading.current) return;
    const controller = new AbortController(), version = epoch.current, callAtStart = dataRef.current?.currentCall?.id ?? null; reading.current = controller; setLoading(true);
    const requestCurrent = () => mounted.current && epoch.current === version && reading.current === controller && !controller.signal.aborted;
    const valid = () => requestCurrent() && (dataRef.current?.currentCall?.id ?? null) === callAtStart;
    try {
      const value = await readPublicVoice(controller.signal);
      if (!valid()) return;
      setScope(previous => previous.headers['X-Voice-Demo-CSRF'] === value.csrfToken ? previous : publicVoiceScope(value.csrfToken));
      setData(previous => {
        if ((previous?.currentCall?.id ?? null) !== callAtStart) return previous;
        const old = previous?.currentCall, incoming = value.currentCall;
        return { ...value, calls: [], currentCall: old && incoming && old.id === incoming.id && old.revision > incoming.revision ? old : incoming };
      });
      setError(''); setUncertain(false);
    } catch (value) { if (valid()) failure(value); }
    finally { if (requestCurrent()) setLoading(false); if (reading.current === controller) reading.current = null; }
  }, [failure]);
  refreshRef.current = load;
  useEffect(() => {
    mounted.current = true; void load();
    return () => { mounted.current = false; epoch.current++; reading.current?.abort(); polling.current?.abort(); reading.current = null; polling.current = null; };
  }, [load]);
  useEffect(() => {
    const visible = () => { if (!document.hidden) void load(); }, connected = () => { setOnline(navigator.onLine); if (navigator.onLine) void load(); };
    document.addEventListener('visibilitychange', visible); window.addEventListener('online', connected); window.addEventListener('offline', connected);
    return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', connected); window.removeEventListener('offline', connected); };
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const active = dataRef.current?.currentCall, ownedScope = scopeRef.current, version = epoch.current;
      if (active && !ongoing(active) && finalCaptionWindow.current?.id !== active.id) finalCaptionWindow.current = { id: active.id, until: Date.now() + 30_000 };
      const draining = active && !active.transcriptComplete && finalCaptionWindow.current?.id === active.id && Date.now() < finalCaptionWindow.current.until;
      if (document.hidden || polling.current || !ownedScope.allowed || !active || !ongoing(active) && !draining) return;
      const controller = new AbortController(); polling.current = controller;
      void readVoiceCall(ownedScope, active.id, controller.signal).then(call => {
        if (mounted.current && !controller.signal.aborted && version === epoch.current && ownedScope.key === scopeRef.current.key && dataRef.current?.currentCall?.id === active.id) acceptCall(call, active.id);
      }).catch(value => { if (!controller.signal.aborted && version === epoch.current && ownedScope.key === scopeRef.current.key && dataRef.current?.currentCall?.id === active.id) failure(value); }).finally(() => { if (polling.current === controller) polling.current = null; });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [acceptCall, failure]);
  useEffect(() => { if (data?.currentCall) voice.acceptServerCall(data.currentCall); }, [data?.currentCall, voice.acceptServerCall]);
  useEffect(() => { if (!ongoing(data?.currentCall) && !voice.localActive) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [data?.currentCall, voice.localActive]);
  async function endPrevious() {
    const active = data?.currentCall, ownedScope = scope;
    if (!active || !ongoing(active) || ending) return;
    setEnding(true); setError('');
    try { const call = await endVoiceCall(ownedScope, active.id); if (mounted.current && ownedScope.key === scopeRef.current.key) { acceptCall(call); setUncertain(false); } }
    catch (value) { if (mounted.current && ownedScope.key === scopeRef.current.key) { failure(value); setUncertain(true); } }
    finally { if (mounted.current) setEnding(false); }
  }
  const call = data?.currentCall, active = ongoing(call), local = voice.localActive || ['microphone', 'connecting', 'ending'].includes(voice.phase);
  const unavailable = voiceMediaUnavailable(), canStart = !!data?.config.available && scope.allowed && online && !unavailable && !active && !local && !uncertain && !loading && !ending;
  const seconds = active && call?.startedAt ? Math.max(call.durationSeconds, Math.floor((now - Date.parse(call.startedAt)) / 1000)) : call?.durationSeconds ?? 0;
  const status = active && !local ? 'Ditt testsamtal pågår' : !local && call && !active ? 'Testsamtalet är avslutat' : phaseLabels[voice.phase];
  return <main className="voice-test-app voice-public-app">
    <header className="voice-test-heading"><div><span className="voice-test-eyebrow">JEROC ÅTERVINNING · RÖSTDEMO</span><h1>Ring vår AI-kundmottagning</h1><p>Fråga om skrot, material och hämtning. Prova direkt här i webbläsaren.</p></div><span className="voice-test-test-badge"><ShieldCheck size={15} />Testsamtal</span></header>
    <div className="voice-test-grid">
      <section className="voice-test-callcard" aria-label="Testsamtal"><header><div className="voice-test-company-brand"><img src="/images/jeroc-logo-ui.webp" alt="JEROC Återvinning" /></div><span className="voice-test-small-test">AI · TEST</span></header>
        <div className={`voice-test-phone-visual ${voice.phase}${voice.muted ? ' muted' : ''}`}><i /><i /><div>{['speaking', 'listening', 'thinking'].includes(voice.phase) ? <AudioLines size={43} /> : <PhoneCall size={40} />}</div></div>
        <div className="voice-test-caller"><span>Du pratar med en AI-assistent</span><strong>JEROC kundmottagning</strong></div>
        <div className={`voice-test-live-status ${voice.phase}`} role="status" aria-label="Samtalsstatus"><span />{loading && !data ? 'Förbereder rösttestet…' : status}</div>
        {(active || local) && <div className="voice-test-call-duration"><Clock3 size={14} /><span>{duration(seconds)}</span><small>av högst {duration(data?.config.maxDurationSeconds ?? 180)}</small></div>}
        {voice.needsAudio && <div className="voice-test-notice audio"><Volume2 size={20} /><div><strong>Aktivera ljudet för att höra AI:n</strong><button type="button" onClick={() => void voice.activateAudio()}>Aktivera ljud</button></div></div>}
        {(voice.error || error) && <p className="voice-test-call-error" role="alert">{voice.error || error}</p>}
        {local ? <div className="voice-test-live-controls"><button type="button" className={voice.muted ? 'muted' : ''} aria-label={voice.muted ? 'Slå på mikrofonen' : 'Stäng av mikrofonen'} aria-pressed={voice.muted} disabled={voice.phase === 'microphone' || voice.phase === 'ending'} onClick={voice.mute}>{voice.muted ? <MicOff size={23} /> : <Mic size={23} />}<span>{voice.muted ? 'Mikrofon av' : 'Mikrofon på'}</span></button><button type="button" className="end" aria-label="Avsluta samtalet" disabled={voice.phase === 'ending'} onClick={() => void voice.end()}><PhoneOff size={24} /><span>Avsluta</span></button></div>
          : active ? <div className="voice-test-existing"><p>Du har ett pågående testsamtal. Ljudet kan inte återupptas efter en omladdning.</p><button type="button" className="voice-test-end-other" disabled={ending} onClick={() => void endPrevious()}><PhoneOff size={18} />{ending ? 'Avslutar…' : 'Avsluta mitt pågående testsamtal'}</button></div>
            : <button type="button" className="voice-test-ring" disabled={!canStart} onClick={() => { setError(''); voice.clearError(); void voice.start(data!.config.maxDurationSeconds, data!.config.protocol); }}><Phone size={22} />{loading && !data ? 'Förbereder rösttestet…' : 'Starta testsamtal'}</button>}
        <p className="voice-test-microphone-note"><Mic size={14} />När du startar ber webbläsaren om mikrofonåtkomst. Ljudet behandlas av OpenAI. Text sparas för uppföljning hos JEROC, ingen ljudinspelning sparas här.</p>
        <p className="voice-public-privacy">Lämna inga personnummer, bankuppgifter eller andra känsliga uppgifter i testet. Du visas som en påhittad testkund.</p>
        {!online && <p className="voice-test-prerequisite">Anslut till internet för att ringa.</p>}{unavailable && <p className="voice-test-prerequisite">{unavailable}</p>}
        {data && !data.config.available && <p className="voice-test-prerequisite">{data.config.reason || 'Rösttestet är inte tillgängligt just nu. Försök igen senare.'}</p>}
        <footer><button type="button" className="voice-test-link" disabled={loading || local || ending} onClick={() => { voice.clearError(); void load(); }}><RefreshCw size={14} />{loading ? 'Kontrollerar…' : 'Kontrollera mitt samtal'}</button></footer><audio ref={voice.audio} autoPlay playsInline aria-hidden="true" />
      </section>
      <section className="voice-test-details" aria-label="Ditt samtal"><header><span className="voice-test-section-icon"><MessageSquareText size={22} /></span><div><h2>Ditt samtal i text</h2><p>Här visas bara ditt eget testsamtal.</p></div></header>
        {!call?.transcript.length ? <div className="voice-test-waiting"><Headphones size={42} /><h3>Vad vill du fråga om?</h3><p>{active ? 'Det ni säger visas här när det har transkriberats.' : 'Prova till exempel: ”Köper ni kopparkabel?” eller ”Kan ni hämta mitt skrot?”'}</p></div>
          : <><div className="voice-public-transcript-caption"><span>{active ? 'Pågående testsamtal' : 'Avslutat testsamtal'}</span>{!active && !call.transcriptComplete && <span>Texten kan vara ofullständig.</span>}</div><ol className="voice-test-transcript">{call.transcript.map(turn => <li key={turn.id} className={turn.role}><span className="voice-test-speaker-icon">{turn.role === 'assistant' ? <Headphones size={16} /> : <Mic size={16} />}</span><div><div><strong>{turn.role === 'assistant' ? 'JEROC · AI' : 'Du · testkund'}</strong></div><p>{turn.text}</p></div></li>)}</ol></>}
      </section>
    </div><footer className="voice-test-footer"><ShieldCheck size={14} />Röstdemo · högst {duration(data?.config.maxDurationSeconds ?? 180)} per samtal. Inga bokningar, betalningar eller riktiga telefonsamtal görs här.</footer>
  </main>;
}
