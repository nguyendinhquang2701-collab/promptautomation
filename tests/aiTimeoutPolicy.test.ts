import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUXILIARY_REQUEST_TIMEOUT_MS,
  DEFAULT_AI_ATTEMPT_TIMEOUT_MS,
  FAST_LOW_PROGRESS_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS_BY_SPEED_MODE,
  RESPONSE_BODY_IDLE_TIMEOUT_MS,
} from '../services/aiTimeoutPolicy';

test('all request timeout policies are increased by exactly 50 percent', () => {
  assert.deepEqual(REQUEST_TIMEOUT_MS_BY_SPEED_MODE, {
    fast: 180_000,
    ultra: 180_000,
    'ultra-max': 270_000,
  });
  assert.equal(DEFAULT_AI_ATTEMPT_TIMEOUT_MS, 90_000);
  assert.equal(AUXILIARY_REQUEST_TIMEOUT_MS, 45_000);
  assert.equal(RESPONSE_BODY_IDLE_TIMEOUT_MS, 67_500);
  assert.equal(FAST_LOW_PROGRESS_TIMEOUT_MS, 135_000);
});
