import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAIRequestPayload, getOpenAIChatCompletionsUrl } from '../services/geminiService';

const vilaoProvider = {
  id: 'vilao',
  name: 'Vilao',
  type: 'openai-compatible' as const,
  model: 'occ/claude-sonnet-4-6',
  baseUrl: 'https://api.vilao.ai/v1/',
  keyPrefix: 'vilao',
  group: 'Custom',
  thinkingStatus: 'verified' as const,
};

test('keeps the configured base path in the diagnostic endpoint', () => {
  assert.equal(
    getOpenAIChatCompletionsUrl(vilaoProvider),
    'https://api.vilao.ai/v1/chat/completions',
  );
});

test('every speed mode disables streaming and thinking for custom Claude routes', () => {
  const fastPayload = createOpenAIRequestPayload('hello', undefined, undefined, vilaoProvider, 0.5, true) as Record<string, unknown>;
  const parallelPayload = createOpenAIRequestPayload('hello', undefined, undefined, vilaoProvider, 0.5, false) as Record<string, unknown>;
  for (const payload of [fastPayload, parallelPayload]) {
    assert.equal(payload.stream, false);
    assert.deepEqual(payload.thinking, { type: 'disabled' });
  }
  assert.equal(fastPayload.max_tokens, undefined);
  assert.equal(parallelPayload.max_tokens, 8192);
});
