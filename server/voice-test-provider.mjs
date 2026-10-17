// Engine selection is server-owned. Tenant profiles choose a supported voice,
// never an upstream URL, credentials, arbitrary tools or a system prompt.
export const VOICE_TEST_REALTIME_VOICES = Object.freeze(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
// BuiltInVoice in the official OpenAI Live SDK, verified 2026-10-17.
export const VOICE_TEST_LIVE_VOICES = Object.freeze(['alloy', 'ash', 'ballad', 'beacon', 'bossa', 'cedar', 'cinder', 'coral', 'delta', 'echo', 'gleam', 'marin', 'meridian', 'quartz', 'ripple', 'sage', 'shida', 'shimmer', 'stone', 'tempo', 'verse', 'vesper', 'willow']);
const modelName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value);

export function voiceTestProviderConfig(env = {}) {
  const selected = String(env.VOICE_TEST_ENGINE ?? 'live').trim().toLowerCase();
  const engine = selected === 'realtime' ? 'realtime' : 'live';
  const voices = engine === 'live' ? VOICE_TEST_LIVE_VOICES : VOICE_TEST_REALTIME_VOICES;
  const candidate = engine === 'live' ? env.VOICE_TEST_LIVE_MODEL ?? (String(env.VOICE_TEST_MODEL ?? '').startsWith('gpt-live') ? env.VOICE_TEST_MODEL : 'gpt-live-1')
    : String(env.VOICE_TEST_MODEL ?? '').startsWith('gpt-live') ? 'gpt-realtime-2.1' : env.VOICE_TEST_MODEL ?? 'gpt-realtime-2.1';
  return { engine, protocol: engine, model: modelName(candidate) ? candidate : engine === 'live' ? 'gpt-live-1' : 'gpt-realtime-2.1',
    defaultVoice: voices.includes(env.VOICE_TEST_VOICE) ? env.VOICE_TEST_VOICE : engine === 'live' ? 'meridian' : 'marin', voices,
    previewAvailable: engine === 'realtime',
    ...(!['live', 'realtime'].includes(selected) || !modelName(candidate) ? { configurationError: 'Röstmotor eller röstmodell är felkonfigurerad på servern.' } : {}) };
}

export async function createVoiceTestProvider(options = {}) {
  const config = voiceTestProviderConfig(options.env);
  if (config.configurationError) {
    const unavailable = () => { throw Object.assign(new Error(config.configurationError), { code: 'VOICE_INVALID_ENGINE', status: 503 }); };
    return { status: () => ({ model: config.model, protocol: config.protocol, previewAvailable: false, keyPresent: Boolean(options.env?.OPENAI_API_KEY?.trim()), available: false, reason: config.configurationError }),
      connectionTest: async () => ({ ok: false, model: config.model, message: config.configurationError }), start: unavailable, preview: unavailable, close: async () => {} };
  }
  if (config.engine === 'live') {
    const { createLiveVoiceTestProvider } = await import('./voice-test-live.mjs');
    return createLiveVoiceTestProvider({ ...options, env: { ...options.env, VOICE_TEST_LIVE_MODEL: config.model, VOICE_TEST_VOICE: config.defaultVoice } });
  }
  const { createVoiceTestProvider: createRealtimeProvider } = await import('./voice-test-openai.mjs');
  const provider = createRealtimeProvider({ ...options, env: { ...options.env, VOICE_TEST_MODEL: config.model, VOICE_TEST_VOICE: config.defaultVoice } });
  return { ...provider, status: () => ({ ...provider.status(), protocol: 'realtime', previewAvailable: true }) };
}
