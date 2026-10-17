import { useCallback, useEffect, useRef, useState } from 'react';
import { createVoiceCall, endVoiceCall, endVoiceOnLeave, readyVoiceCall, voiceScopeKey, type VoiceScope } from './client';
import type { VoiceCall, VoicePhase } from './types';
import { createLiveOutputMeter, waitForLiveIce, type LiveOutputMeter, type VoiceProtocol } from './live-browser';

interface Resource {
  scope: VoiceScope; requestId: string; controller: AbortController; peer: RTCPeerConnection;
  stream?: MediaStream; remote?: MediaStream; channel?: RTCDataChannel; callId?: string;
  createSent: boolean; readySent: boolean; closing: boolean; outputActive: boolean;
  protocol: VoiceProtocol; serverStarted: boolean; outputMeter?: LiveOutputMeter;
  disconnectedTimer?: number; limitTimer?: number; startedTimer?: number;
}
export const voiceMediaUnavailable = () => !window.isSecureContext ? 'Öppna sidan via HTTPS för att använda mikrofonen.'
  : !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined' ? 'Den här webbläsaren saknar stöd för röstsamtal. Prova Safari eller Chrome.' : '';
const mediaError = (error: unknown) => error instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError'].includes(error.name)
  ? 'Mikrofonåtkomst nekades. Tillåt mikrofonen för sidan och försök igen.'
  : error instanceof DOMException && ['NotFoundError', 'DevicesNotFoundError'].includes(error.name)
    ? 'Ingen mikrofon hittades. Anslut en mikrofon och försök igen.'
    : error instanceof TypeError ? 'Kunde inte ansluta till rösttjänsten. Kontrollera anslutningen och hämta aktuell samtalsstatus.'
      : error instanceof Error ? error.message : 'Ljudanslutningen kunde inte startas.';

/** Audio stays in the peer connection. Data-channel events are used only for
 * live indicators; the journal always comes from the server's own connection. */
export function useVoiceSession(scope: VoiceScope, handlers: {
  onCall: (call: VoiceCall) => void; onFailure: (failure: unknown) => void; onUncertain: (requestId: string) => void;
}) {
  const [phase, setPhase] = useState<VoicePhase>('idle'), [muted, setMuted] = useState(false), [needsAudio, setNeedsAudio] = useState(false), [error, setError] = useState('');
  const audio = useRef<HTMLAudioElement>(null), resource = useRef<Resource | undefined>(undefined), mounted = useRef(true), generation = useRef(0);
  const handlerRef = useRef(handlers); handlerRef.current = handlers;
  const scopeRef = useRef(scope.key); scopeRef.current = scope.key;
  const owned = useCallback((item: Resource) => mounted.current && resource.current === item && scopeRef.current === item.scope.key && voiceScopeKey() === item.scope.key && !item.closing, []);
  const release = useCallback((item?: Resource) => {
    if (!item) return;
    item.closing = true; item.controller.abort();
    if (item.disconnectedTimer) window.clearTimeout(item.disconnectedTimer);
    if (item.limitTimer) window.clearTimeout(item.limitTimer);
    if (item.startedTimer) window.clearTimeout(item.startedTimer);
    item.outputMeter?.stop();
    item.peer.onconnectionstatechange = null; item.peer.oniceconnectionstatechange = null; item.peer.ontrack = null;
    if (item.channel) { item.channel.onmessage = null; item.channel.onopen = null; item.channel.onclose = null; item.channel.close(); }
    item.stream?.getTracks().forEach(track => track.stop()); item.remote?.getTracks().forEach(track => track.stop());
    item.peer.close();
    const element = audio.current;
    if (element && (resource.current === item || item.remote && element.srcObject === item.remote)) { element.pause(); element.srcObject = null; }
    if (resource.current === item) resource.current = undefined;
  }, []);
  const stopLocal = useCallback(() => { ++generation.current; release(resource.current); setMuted(false); setNeedsAudio(false); setPhase('idle'); }, [release]);
  useEffect(() => {
    mounted.current = true; setPhase('idle'); setError(''); setMuted(false); setNeedsAudio(false);
    return () => { mounted.current = false; ++generation.current; const item = resource.current; release(item); if (item?.callId) endVoiceOnLeave(item.scope, item.callId); };
  }, [scope.key, release]);
  useEffect(() => {
    const leave = () => { const item = resource.current; ++generation.current; release(item); if (item?.callId) endVoiceOnLeave(item.scope, item.callId); };
    window.addEventListener('pagehide', leave); return () => window.removeEventListener('pagehide', leave);
  }, [release]);
  const end = useCallback(async () => {
    const item = resource.current;
    if (!item || item.closing) return;
    const version = ++generation.current;
    // Stop capturing immediately, while retaining the peer briefly so the
    // server's sideband can finish the last audio transcription before closing.
    item.closing = true; item.controller.abort();
    if (item.disconnectedTimer) window.clearTimeout(item.disconnectedTimer);
    if (item.limitTimer) window.clearTimeout(item.limitTimer);
    item.stream?.getTracks().forEach(track => { track.enabled = false; track.stop(); });
    audio.current?.pause();
    setMuted(false); setNeedsAudio(false); setError(''); setPhase('ending');
    const current = () => mounted.current && generation.current === version && scopeRef.current === item.scope.key && voiceScopeKey() === item.scope.key;
    if (!item.callId) {
      release(item);
      if (item.createSent) { handlerRef.current.onUncertain(item.requestId); if (current()) { setError('Ljudet är stängt. Hämta samtalsstatus för att kontrollera om servern hann öppna samtalet.'); setPhase('error'); } }
      else if (current()) setPhase('idle');
      return;
    }
    const cleanupDeadline = window.setTimeout(() => release(item), item.protocol === 'live' ? 20_000 : 6_000);
    try { const call = await endVoiceCall(item.scope, item.callId); if (current()) { handlerRef.current.onCall(call); setPhase('idle'); } }
    catch (failure) { if (current()) { setError('Ljudet är stängt på den här enheten. Hämta samtalsstatus för att kontrollera avslutet.'); setPhase('error'); handlerRef.current.onFailure(failure); handlerRef.current.onUncertain(item.requestId); } }
    finally { window.clearTimeout(cleanupDeadline); release(item); }
  }, [release]);
  const start = useCallback(async (maxDurationSeconds: number, protocol: VoiceProtocol = 'realtime') => {
    if (resource.current || !scope.allowed) return;
    const unavailable = voiceMediaUnavailable();
    if (unavailable) { setError(unavailable); setPhase('error'); return; }
    const version = ++generation.current;
    let peer: RTCPeerConnection;
    try { peer = new RTCPeerConnection(); } catch (failure) { setError(mediaError(failure)); setPhase('error'); return; }
    const item: Resource = { scope, requestId: crypto.randomUUID(), controller: new AbortController(), peer, createSent: false, readySent: false, closing: false, outputActive: false, protocol, serverStarted: false };
    resource.current = item; setPhase('microphone'); setError(''); setMuted(false); setNeedsAudio(false);
    const current = () => owned(item) && generation.current === version;
    if (protocol === 'live') item.outputMeter = createLiveOutputMeter(active => {
      if (current() && item.serverStarted && item.readySent) { item.outputActive = active; setPhase(active ? 'speaking' : 'listening'); }
    });
    const failTransport = (message: string) => {
      if (!current()) return;
      const id = item.callId; release(item); setPhase('error'); setError(message);
      if (id) endVoiceOnLeave(scope, id);
      handlerRef.current.onUncertain(item.requestId);
    };
    const markReady = () => {
      if (!current() || !item.callId || item.readySent || item.protocol === 'live' && !item.serverStarted) return;
      const connected = peer.connectionState === 'connected' || ['connected', 'completed'].includes(peer.iceConnectionState);
      if (!connected) return;
      item.readySent = true;
      if (item.startedTimer) window.clearTimeout(item.startedTimer); item.startedTimer = undefined;
      void readyVoiceCall(scope, item.callId, item.controller.signal).then(call => {
        if (!current()) return;
        handlerRef.current.onCall(call); setPhase(previous => ['connecting', 'microphone'].includes(previous) ? 'listening' : previous);
      }).catch(failure => { if (current()) { handlerRef.current.onFailure(failure); failTransport('Samtalet kunde inte bekräftas. Hämta aktuell status innan du försöker igen.'); } });
    };
    peer.onconnectionstatechange = () => {
      if (!current()) return;
      if (peer.connectionState === 'connected') { if (item.disconnectedTimer) window.clearTimeout(item.disconnectedTimer); item.disconnectedTimer = undefined; markReady(); }
      else if (peer.connectionState === 'failed') failTransport('Ljudanslutningen bröts. Samtalet är stängt på den här enheten.');
      else if (peer.connectionState === 'disconnected') {
        setPhase('connecting');
        if (!item.disconnectedTimer) item.disconnectedTimer = window.setTimeout(() => failTransport('Ljudanslutningen kunde inte återställas. Hämta samtalsstatus.'), 8_000);
      }
    };
    peer.oniceconnectionstatechange = markReady;
    peer.ontrack = event => {
      if (!current() || !audio.current) return;
      const stream = event.streams[0] ?? new MediaStream([event.track]); item.remote = stream;
      item.outputMeter?.attach(stream);
      audio.current.srcObject = stream;
      void audio.current.play().then(() => { if (current()) setNeedsAudio(false); }).catch(() => { if (current()) setNeedsAudio(true); });
    };
    const channel = peer.createDataChannel('oai-events'); item.channel = channel;
    channel.onmessage = event => {
      if (!current() || typeof event.data !== 'string') return;
      let message: { type?: string }; try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (item.protocol === 'live') {
        // The restricted Live channel only reports lifecycle. In particular,
        // captions never become the authoritative journal and no session
        // instructions, responses, or other client commands are sent here.
        if (message.type === 'session.started') { item.serverStarted = true; markReady(); }
        else if (message.type === 'session.closed') {
          release(item); setPhase('idle'); setMuted(false); setNeedsAudio(false);
          handlerRef.current.onUncertain(item.requestId);
        } else if (message.type === 'error') failTransport('Rösttjänsten avbröt anslutningen. Hämta aktuell samtalsstatus.');
        return;
      }
      if (message.type === 'output_audio_buffer.started') { item.outputActive = true; setPhase('speaking'); }
      else if (['output_audio_buffer.stopped', 'output_audio_buffer.cleared', 'input_audio_buffer.speech_started'].includes(message.type ?? '')) { item.outputActive = false; setPhase('listening'); }
      else if (message.type === 'response.created') setPhase('thinking');
      else if (message.type === 'response.done' && !item.outputActive) setPhase('listening');
      // Conversation and transcription events deliberately do not write UI history.
    };
    channel.onopen = markReady;
    channel.onclose = () => { if (current()) failTransport('Ljudanslutningen stängdes utan bekräftat avslut. Hämta aktuell samtalsstatus.'); };
    try {
      let waiting = true;
      const mediaPromise = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      void mediaPromise.then(stream => { if (!waiting || !current()) stream.getTracks().forEach(track => track.stop()); }).catch(() => undefined);
      let microphoneTimer: number | undefined;
      try {
        const stream = await Promise.race([mediaPromise, new Promise<never>((_, reject) => { microphoneTimer = window.setTimeout(() => reject(new Error('Mikrofonen svarade inte. Kontrollera sidans mikrofonbehörighet och försök igen.')), 25_000); })]);
        if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
        item.stream = stream;
      } finally { waiting = false; if (microphoneTimer) window.clearTimeout(microphoneTimer); }
      if (!current()) return;
      const stream = item.stream;
      if (!stream) throw new Error('Mikrofonen kunde inte öppnas.');
      stream.getAudioTracks().forEach(track => peer.addTrack(track, stream));
      setPhase('connecting');
      const offer = await peer.createOffer(); if (!current()) return;
      await peer.setLocalDescription(offer); if (!current()) return;
      if (item.protocol === 'live') await waitForLiveIce(peer, item.controller.signal);
      if (!current()) return;
      const sdp = peer.localDescription?.sdp ?? offer.sdp;
      if (!sdp) throw new Error('Webbläsaren kunde inte skapa en ljudanslutning.');
      item.createSent = true;
      const response = await createVoiceCall(scope, item.requestId, sdp, item.controller.signal);
      if (!current()) { endVoiceOnLeave(scope, response.call.id); return; }
      item.callId = response.call.id; handlerRef.current.onCall(response.call);
      if (item.protocol === 'live') item.startedTimer = window.setTimeout(() => failTransport('GPT-Live kunde inte bekräfta att samtalet har startat. Ljudet är stängt. Hämta aktuell samtalsstatus.'), 15_000);
      await peer.setRemoteDescription({ type: 'answer', sdp: response.answerSdp });
      if (!current()) return;
      markReady();
      item.limitTimer = window.setTimeout(() => { if (current()) void end(); }, Math.max(1, maxDurationSeconds) * 1000);
    } catch (failure) {
      if (!current()) return;
      release(item); setPhase('error'); setError(mediaError(failure)); handlerRef.current.onFailure(failure);
      if (item.callId) endVoiceOnLeave(scope, item.callId);
      if (item.createSent) handlerRef.current.onUncertain(item.requestId);
    }
  }, [scope.key, scope.allowed, owned, release, end]);
  const mute = useCallback(() => {
    const item = resource.current; if (!item?.stream || !owned(item)) return;
    const next = !muted; item.stream.getAudioTracks().forEach(track => { track.enabled = !next; }); setMuted(next);
  }, [muted, owned]);
  const activateAudio = useCallback(async () => {
    const item = resource.current; if (!item || !owned(item) || !audio.current) return;
    try { await item.outputMeter?.resume().catch(() => undefined); await audio.current.play(); if (owned(item)) { setNeedsAudio(false); setError(''); } }
    catch { if (owned(item)) setError('Ljudet kunde inte startas. Kontrollera enhetens ljudinställningar och försök igen.'); }
  }, [owned]);
  const acceptServerCall = useCallback((call: VoiceCall) => {
    const item = resource.current;
    if (item?.callId === call.id && !item.closing && !['connecting', 'active'].includes(call.status)) { release(item); setPhase('idle'); setMuted(false); setNeedsAudio(false); }
  }, [release]);
  return { phase, muted, error, needsAudio, audio, start, end, mute, activateAudio, stopLocal, acceptServerCall,
    localCallId: resource.current?.callId, localActive: !!resource.current,
    clearError: () => setError('') };
}
