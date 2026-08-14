import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAIRequestPayload, getOpenAIChatCompletionsUrl, shouldFallbackWithoutReasoning } from '../services/geminiService';

const vilaoProvider = {
  id: 'vilao',
  name: 'Vilao',
  type: 'openai-compatible' as const,
  model: 'occ/claude-sonnet-4-6',
  baseUrl: 'https://api.vilao.ai/v1/',
  keyPrefix: 'vilao',
  group: 'Custom',
};

test('keeps the configured base path in the diagnostic endpoint', () => {
  assert.equal(
    getOpenAIChatCompletionsUrl(vilaoProvider),
    'https://api.vilao.ai/v1/chat/completions',
  );
});

test('Fast explicitly disables streaming and requests low reasoning for custom Claude routes', () => {
  const payload = createOpenAIRequestPayload('hello', undefined, undefined, vilaoProvider, 0.5, true, true) as Record<string, unknown>;
  assert.equal(payload.stream, false);
  assert.equal(payload.reasoning_effort, 'low');
  assert.equal(payload.max_tokens, undefined);
});

test('only falls back when a provider explicitly rejects the optional reasoning field', () => {
  assert.equal(shouldFallbackWithoutReasoning(400, 'Unknown parameter: reasoning_effort'), true);
  assert.equal(shouldFallbackWithoutReasoning(422, 'extra fields not permitted: reasoning_effort'), true);
  assert.equal(shouldFallbackWithoutReasoning(429, 'rate limit'), false);
  assert.equal(shouldFallbackWithoutReasoning(400, 'invalid model id'), false);
});
