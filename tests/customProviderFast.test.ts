import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAIRequestPayload, DEFAULT_MAX_PROMPT_CHARS, getOpenAIChatCompletionsUrl, loadMaxPromptChars, recoverImageStyleFromMarkdown } from '../services/geminiService';

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

test('prompt length defaults to 500 characters when no browser preference exists', () => {
  assert.equal(DEFAULT_MAX_PROMPT_CHARS, 500);
  assert.equal(loadMaxPromptChars(), 500);
});

test('custom OpenAI providers wrap array output in an items object for JSON mode', () => {
  const payload = createOpenAIRequestPayload(
    'hello',
    'Return scene data.',
    { type: 'ARRAY', items: { type: 'OBJECT', properties: {}, required: [] } },
    { ...vilaoProvider, id: 'custom_vilao', structuredOutput: 'json_object' },
    0.2,
    false,
  ) as { response_format?: { type?: string }; messages: Array<{ role: string; content: string }> };
  assert.equal(payload.response_format?.type, 'json_object');
  assert.match(payload.messages[0].content, /"items"/);
});

test('style markdown can be recovered without re-uploading the image', () => {
  const recovered = recoverImageStyleFromMarkdown('summary: Historical Epic Cinema\n- **Medium:** Live-action realism\n- **Lighting:** Warm candlelight\n- **Mood:** Regal\n- **Cinematography:** Wide period composition');
  assert.equal(recovered?.summary, 'Historical Epic Cinema');
  assert.match(recovered?.analysis || '', /Warm candlelight/);
});
