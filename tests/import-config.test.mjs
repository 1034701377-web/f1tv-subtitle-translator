import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLegacyConfig } from '../extension/import-config.js';

test('imports ordinary legacy dotenv locally without changing provider choices', () => {
  const result = parseLegacyConfig('\uFEFF' + [
    '# Local configuration',
    ' export API_KEY = "translation-fixture" # existing key',
    "API_ENDPOINT='https://translation.example/chat'",
    'API_MODEL=existing-model',
    'API_THINKING=""',
    'API_TIMEOUT_MS=8000',
    'TRANSLATION_MODE=api',
    'ASR_ENDPOINT = wss://speech.example/workspaces/existing/inference',
    'DASHSCOPE_API_KEY=speech-fixture',
    'DASHSCOPE_WORKSPACE_ID=do-not-substitute',
    'ASR_MODEL=existing-speech-model',
  ].join('\r\n'));
  assert.deepEqual(result, {
    translation: { endpoint: 'https://translation.example/chat', key: 'translation-fixture', model: 'existing-model', thinking: '' },
    asr: { enabled: true, endpoint: 'wss://speech.example/workspaces/existing/inference', key: 'speech-fixture', model: 'existing-speech-model' },
  });
});

test('caption-only files work and explicit ASR switches override inferred readiness', () => {
  const base = 'API_KEY=first\nAPI_KEY=translation-fixture\nAPI_THINKING=disabled';
  assert.deepEqual(parseLegacyConfig(base), {
    translation: { endpoint: '', key: 'translation-fixture', model: '', thinking: 'disabled' },
    asr: { enabled: false, endpoint: '', key: '', model: '' },
  });
  const asr = base + '\nASR_ENDPOINT=wss://speech.example/inference\nDASHSCOPE_API_KEY=speech-fixture';
  for (const value of ['false', 'FALSE', '0']) assert.equal(parseLegacyConfig(asr + '\nASR_ENABLED=' + value).asr.enabled, false);
  for (const value of ['true', 'TRUE', '1']) assert.equal(parseLegacyConfig(base + '\nASR_ENABLED=' + value).asr.enabled, true);
  assert.equal(parseLegacyConfig(base + '\nDASHSCOPE_WORKSPACE_ID=existing').asr.endpoint, '');
});

test('rejects oversized, missing-key and unsupported input with fixed secret-free errors', () => {
  for (const [input, code] of [
    ['#' + 'a'.repeat(65536), 'LEGACY_CONFIG_TOO_LARGE'],
    ['#' + '中'.repeat(22000), 'LEGACY_CONFIG_TOO_LARGE'],
    ['API_KEY=""', 'TRANSLATION_KEY_REQUIRED'],
    ['API_KEY=fixture-secret\nTRANSLATION_MODE=mock', 'LEGACY_CONFIG_MODE_UNSUPPORTED'],
    ['API_KEY=fixture-secret\nASR_ENABLED=maybe', 'LEGACY_CONFIG_INVALID'],
    ['API_KEY=${fixture-secret}', 'LEGACY_CONFIG_INVALID'],
    ['API_KEY=$FIXTURE_SECRET', 'LEGACY_CONFIG_INVALID'],
    ['API_KEY=$(fixture-secret)', 'LEGACY_CONFIG_INVALID'],
    ['API_KEY=`fixture-secret`', 'LEGACY_CONFIG_INVALID'],
    ['API_KEY=fixture-secret; command', 'LEGACY_CONFIG_INVALID'],
    ['API_KEY="fixture-secret\ncontinued"', 'LEGACY_CONFIG_INVALID'],
    ['API_KEY="fixture-secret\\ncontinued"', 'LEGACY_CONFIG_INVALID'],
    ["API_KEY='fixture-secret", 'LEGACY_CONFIG_INVALID'],
    ['API_KEY=fixture-secret\ncommand', 'LEGACY_CONFIG_INVALID'],
    ['API_KEY=fixture-secret\0', 'LEGACY_CONFIG_INVALID'],
    [null, 'LEGACY_CONFIG_INVALID'],
  ]) assert.throws(() => parseLegacyConfig(input), error => error.code === code && error.message === code);
});
