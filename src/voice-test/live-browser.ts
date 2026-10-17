/** GPT-Live WebRTC protocol, verified against the official guides:
 * https://developers.openai.com/api/docs/guides/voice-webrtc?api=live
 * https://developers.openai.com/api/reference/resources/live
 * No API key, session configuration, or JSON commands enter this browser helper.
 */
export type VoiceProtocol = 'realtime' | 'live';

/** The unified Live HTTP endpoint does not use trickle ICE. Submit the browser's
 * final localDescription only after gathering completes, with a bounded wait. */
export function waitForLiveIce(peer: RTCPeerConnection, signal: AbortSignal, timeoutMs = 10_000): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Anslutningen avbröts.', 'AbortError'));
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { window.clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); signal.removeEventListener('abort', cancelled); };
    const changed = () => { if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); } };
    const cancelled = () => { cleanup(); reject(signal.reason ?? new DOMException('Anslutningen avbröts.', 'AbortError')); };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('Ljudanslutningen kunde inte förberedas i tid. Kontrollera anslutningen och försök igen.')); }, timeoutMs);
    peer.addEventListener('icegatheringstatechange', changed); signal.addEventListener('abort', cancelled, { once: true }); changed();
  });
}

export interface LiveOutputMeter { attach: (stream: MediaStream) => void; resume: () => Promise<void>; stop: () => void }
/** Live has no Realtime output-buffer speech boundary events. Observe the actual
 * received audio locally for the visual speaking indicator. Audio is neither
 * stored nor uploaded here. If Web Audio is unavailable, omit the indicator. */
export function createLiveOutputMeter(onActivity: (active: boolean) => void): LiveOutputMeter | undefined {
  const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) return undefined;
  let context: AudioContext;
  try { context = new Constructor(); } catch { return undefined; }
  let source: MediaStreamAudioSourceNode | undefined, analyser: AnalyserNode | undefined, timer: number | undefined;
  let stopped = false, speaking = false, lastSound = 0;
  const resume = async () => { if (!stopped && context.state === 'suspended') await context.resume(); };
  // Called from the start gesture, before waiting for microphone permission.
  void resume().catch(() => undefined);
  const detach = () => { if (timer !== undefined) window.clearInterval(timer); timer = undefined; try { source?.disconnect(); analyser?.disconnect(); } catch { /* A closed audio context is already detached. */ } source = undefined; analyser = undefined; };
  return {
    attach(stream) {
      if (stopped) return;
      detach(); speaking = false; lastSound = 0;
      try {
        source = context.createMediaStreamSource(stream); analyser = context.createAnalyser(); analyser.fftSize = 512; source.connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        timer = window.setInterval(() => {
          if (stopped || !analyser || context.state !== 'running') return;
          analyser.getByteTimeDomainData(samples); let squares = 0;
          for (const value of samples) squares += ((value - 128) / 128) ** 2;
          const audible = Math.sqrt(squares / samples.length) > 0.012, now = performance.now();
          if (audible) lastSound = now;
          const active = audible || speaking && now - lastSound < 350;
          if (active !== speaking) { speaking = active; onActivity(active); }
        }, 100);
      } catch { detach(); }
    },
    resume,
    stop() { if (stopped) return; stopped = true; detach(); void context.close().catch(() => undefined); },
  };
}
