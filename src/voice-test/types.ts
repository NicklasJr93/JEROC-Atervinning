export type VoiceCallStatus = 'connecting' | 'active' | 'ended' | 'failed' | 'interrupted';
export type VoiceFollowup = 'new' | 'in_progress' | 'done';
export interface VoiceTurn { id: string; role: 'user' | 'assistant'; text: string; at: string; interrupted?: boolean }
export interface VoiceCall {
  id: string; requestId: string; revision: number; status: VoiceCallStatus;
  createdAt: string; startedAt?: string; endedAt?: string; durationSeconds: number;
  siteName?: string;
  callerNumber: string; callerLabel: string;
  createdBy: { actualUserId: string; effectiveUserId: string; name: string };
  transcript: VoiceTurn[]; transcriptComplete?: boolean; providerConfirmed?: boolean; followupStatus: VoiceFollowup; summary?: string;
  summaryStatus?: 'pending' | 'generated' | 'fallback'; topic?: string | null; callbackRequested?: boolean | null; summaryModel?: string;
  aiSupportSnapshot?: { revision: number; policyVersion: number; voice: string; knowledgeIds: string[]; contextHash: string };
  endReason?: string; error?: string;
}
export interface VoiceConfig {
  enabled: boolean; keyPresent: boolean; model: string; companyName?: string; callerNumber: string; callerLabel: string;
  voice?: string; knowledgeRevision?: number;
  maxDurationSeconds: number; available: boolean; reason?: string;
  site?: { id: string; name: string };
}
export interface VoiceState { config: VoiceConfig; calls: VoiceCall[]; currentCall: VoiceCall | null; revision: number }
export interface VoiceCheck { ok: boolean; model: string; message: string; checkedAt: string }
export type VoicePhase = 'idle' | 'microphone' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ending' | 'error';
export const ongoing = (call?: VoiceCall | null) => call?.status === 'connecting' || call?.status === 'active';
export const voiceStatusLabels: Record<VoiceCallStatus, string> = { connecting: 'Ansluter', active: 'Pågående', ended: 'Avslutat', failed: 'Misslyckades', interrupted: 'Avbrutet' };
export const followupLabels: Record<VoiceFollowup, string> = { new: 'Ny', in_progress: 'Pågår', done: 'Klar' };
