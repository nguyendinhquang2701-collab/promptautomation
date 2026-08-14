import assert from 'node:assert/strict';
import test from 'node:test';

import { probeOpenAIThinkingPolicy, resolveThinkingPolicy } from '../services/aiReasoningPolicy';

const custom = (model: string, extra: Record<string, unknown> = {}) => ({
  id: 'custom_test',
  type: 'openai-compatible' as const,
  model,
  baseUrl: 'https://api.example.test/v1',
  ...extra,
});

test('custom Claude requires a successful thinking-off verification', () => {
  const pending = resolveThinkingPolicy(custom('occ/claude-sonnet-4-6'));
  assert.equal(pending.profile, 'claude-disabled');
  assert.equal(pending.canRun, false);

  const verified = resolveThinkingPolicy(custom('occ/claude-sonnet-4-6', { thinkingStatus: 'verified' }));
  assert.equal(verified.canRun, true);
  assert.deepEqual(verified.requestPatch, { thinking: { type: 'disabled' } });
});

test('known reasoning-only models are blocked instead of silently running with thinking', () => {
  const policy = resolveThinkingPolicy(custom('o3-pro', { thinkingStatus: 'verified' }));
  assert.equal(policy.status, 'unsupported');
  assert.equal(policy.canRun, false);

  const manualBypass = resolveThinkingPolicy(custom('o3-pro', { thinkingProfile: 'none-needed', thinkingStatus: 'verified' }));
  assert.equal(manualBypass.canRun, false);
});

test('custom models that claim to need no reasoning still require a probe', () => {
  assert.equal(resolveThinkingPolicy(custom('gpt-4.1')).canRun, false);
  assert.equal(resolveThinkingPolicy(custom('gpt-4.1', { thinkingStatus: 'verified' })).canRun, true);
});

test('a tiny HTTP 200 body never verifies a custom provider', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const result = await probeOpenAIThinkingPolicy(custom('occ/claude-sonnet-4-6'), 'test-key');
    assert.equal(result.status, 'unverified');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('built-in DeepSeek and Gemini Flash use documented thinking-off payloads', () => {
  assert.deepEqual(
    resolveThinkingPolicy({ id: 'deepseek', type: 'openai-compatible', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1' }).requestPatch,
    { thinking: { type: 'disabled' } },
  );
  assert.deepEqual(
    resolveThinkingPolicy({ id: 'gemini', type: 'gemini', model: 'gemini-2.5-flash' }).requestPatch,
    { thinkingConfig: { thinkingBudget: 0 } },
  );
});
