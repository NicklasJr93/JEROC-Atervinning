import type { Page } from '@playwright/test';

type VoiceQA = {
  mediaCalls: number; stoppedTracks: number; peersCreated: number; peersClosed: number;
  offers: string[]; answers: string[]; sent: string[];
  rejectMicrophone: boolean; delayMicrophone: boolean; delayIce: boolean;
  resolveMicrophone: () => void; message: (data: object) => void; disconnect: () => void;
  iceState: () => string; completeIce: () => void;
};
declare global { interface Window { __voiceQA: VoiceQA } }

export async function fakeWebRtc(page: Page) {
  await page.addInitScript(() => {
    const channels: Channel[] = [], peers: Peer[] = [];
    let finishMicrophone: (() => void) | undefined;
    const qa: VoiceQA = window.__voiceQA = {
      mediaCalls: 0, stoppedTracks: 0, peersCreated: 0, peersClosed: 0,
      offers: [], answers: [], sent: [], rejectMicrophone: false, delayMicrophone: false, delayIce: false,
      resolveMicrophone: () => finishMicrophone?.(),
      message: data => channels.at(-1)?.emit('message', JSON.stringify(data)),
      disconnect: () => { const peer = peers.at(-1); if (peer) { peer.connectionState = 'failed'; peer.emit('connectionstatechange'); } },
      iceState: () => peers.at(-1)?.iceGatheringState ?? 'none',
      completeIce: () => {
        const peer = peers.at(-1); if (!peer || peer.connectionState === 'closed') return;
        peer.iceGatheringState = 'complete';
        if (peer.localDescription) peer.localDescription.sdp += 'a=candidate:qa 1 udp 1 127.0.0.1 49170 typ host\r\n';
        peer.emit('icegatheringstatechange'); peer.emit('icecandidate');
      },
    };
    class Channel extends EventTarget {
      readyState = 'connecting'; label = 'oai-events';
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      send(data: string) { qa.sent.push(data); }
      emit(type: string, data?: string) {
        const event = type === 'message' ? new MessageEvent(type, { data }) : new Event(type);
        this.dispatchEvent(event);
        if (type === 'message') this.onmessage?.(event as MessageEvent);
        else if (type === 'open') this.onopen?.(event);
        else if (type === 'close') this.onclose?.(event);
      }
      close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.emit('close'); }
    }
    class Peer extends EventTarget {
      connectionState = 'new'; iceConnectionState = 'new'; iceGatheringState = 'complete';
      localDescription: { type: string; sdp: string } | null = null;
      remoteDescription: { type: string; sdp: string } | null = null;
      onconnectionstatechange: ((event: Event) => void) | null = null;
      oniceconnectionstatechange: ((event: Event) => void) | null = null;
      onicegatheringstatechange: ((event: Event) => void) | null = null;
      onicecandidate: ((event: Event) => void) | null = null;
      ontrack: ((event: Event & { streams: MediaStream[] }) => void) | null = null;
      channel?: Channel;
      tracks: MediaStreamTrack[] = [];
      constructor() { super(); qa.peersCreated++; peers.push(this); }
      emit(type: string) {
        const event = type === 'icecandidate' ? Object.assign(new Event(type), { candidate: null }) : new Event(type);
        this.dispatchEvent(event);
        if (type === 'connectionstatechange') this.onconnectionstatechange?.(event);
        if (type === 'icegatheringstatechange') this.onicegatheringstatechange?.(event);
        if (type === 'icecandidate') this.onicecandidate?.(event);
      }
      addTrack(track: MediaStreamTrack) { this.tracks.push(track); return { track }; }
      getSenders() { return this.tracks.map(track => ({ track })); }
      createDataChannel() { const channel = new Channel(); channels.push(channel); this.channel = channel; return channel; }
      async createOffer() { const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=Isolated voice browser test\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n'; qa.offers.push(sdp); return { type: 'offer', sdp }; }
      async setLocalDescription(value: { type: string; sdp: string }) { this.localDescription = { ...value }; if (qa.delayIce) this.iceGatheringState = 'gathering'; }
      async setRemoteDescription(value: { type: string; sdp: string }) {
        this.remoteDescription = value; qa.answers.push(value.sdp);
        queueMicrotask(() => {
          if (this.connectionState === 'closed') return;
          this.connectionState = 'connected'; this.iceConnectionState = 'connected';
          if (this.channel) { this.channel.readyState = 'open'; this.channel.emit('open'); }
          this.emit('connectionstatechange');
        });
      }
      close() { if (this.connectionState === 'closed') return; qa.peersClosed++; this.connectionState = 'closed'; this.channel?.close(); this.emit('connectionstatechange'); }
    }
    Object.defineProperty(window, 'RTCPeerConnection', { value: Peer, configurable: true });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => {
        qa.mediaCalls++;
        if (qa.rejectMicrophone) throw new DOMException('Microphone denied for isolated browser test', 'NotAllowedError');
        if (qa.delayMicrophone) await new Promise<void>(resolve => { finishMicrophone = resolve; });
        const stream = new AudioContext().createMediaStreamDestination().stream;
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track); let stopped = false;
          track.stop = () => { if (!stopped) { stopped = true; qa.stoppedTracks++; } stop(); };
        }
        return stream;
      },
    } });
    HTMLMediaElement.prototype.play = () => Promise.resolve();
  });
}

