import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceTestProviderConfig, createVoiceTestProvider, VOICE_TEST_LIVE_VOICES, VOICE_TEST_REALTIME_VOICES } from './voice-test-provider.mjs';

test('Live is the default and legacy model variables cannot select the wrong API family', () => {
  const live = voiceTestProviderConfig({ VOICE_TEST_MODEL: 'gpt-realtime-2.1' });
  assert.equal(live.engine, 'live'); assert.equal(live.model, 'gpt-live-1'); assert.equal(live.defaultVoice, 'meridian'); assert.equal(live.previewAvailable, false);
  assert.ok(VOICE_TEST_REALTIME_VOICES.every(voice => VOICE_TEST_LIVE_VOICES.includes(voice)));
  const rollback = voiceTestProviderConfig({ VOICE_TEST_ENGINE: 'realtime', VOICE_TEST_MODEL: 'gpt-live-1' });
  assert.equal(rollback.model, 'gpt-realtime-2.1'); assert.equal(rollback.defaultVoice, 'marin'); assert.equal(rollback.previewAvailable, true);
  assert.equal(voiceTestProviderConfig({ VOICE_TEST_VOICE: 'cedar' }).defaultVoice, 'cedar');
});

test('invalid server engine fails closed without opening an upstream connection', async () => {
  const provider = await createVoiceTestProvider({ env: { VOICE_TEST_ENGINE: 'arbitrary', OPENAI_API_KEY: 'LOCAL-FAKE-KEY' }, fetchImpl: () => { throw Error('upstream forbidden'); } });
  assert.equal(provider.status().available, false); assert.equal(provider.status().previewAvailable, false);
  assert.equal((await provider.connectionTest()).ok, false); assert.throws(() => provider.start({}), /felkonfigurerad/); await provider.close();
});
