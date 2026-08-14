import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AIAbortError,
  AIHttpError,
  AIRequestTimeoutError,
  AbortableFIFOLimiter,
  classifyAIError,
  normalizeMaxAttempts,
  runWithRetry,
} from '../services/aiRuntime';

test('retry policy is capped at two attempts', async () => {
  assert.equal(normalizeMaxAttempts(99), 2);
  let calls = 0;

  await assert.rejects(
    runWithRetry(
      async () => {
        calls += 1;
        throw new AIHttpError(503, 'busy');
      },
      { maxAttempts: 99, baseDelayMs: 0, maxDelayMs: 0 },
    ),
    (error: unknown) => error instanceof AIHttpError && error.status === 503,
  );

  assert.equal(calls, 2);
});

test('client and authentication errors are never retried', async () => {
  for (const status of [400, 401, 403]) {
    let calls = 0;
    await assert.rejects(
      runWithRetry(
        async () => {
          calls += 1;
          throw new AIHttpError(status, 'rejected');
        },
        { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      ),
    );
    assert.equal(calls, 1, `HTTP ${status} should not retry`);
  }
});

test('numeric provider code is recognized even when status is symbolic', () => {
  const classification = classifyAIError({
    status: 'RESOURCE_EXHAUSTED',
    code: 429,
    message: 'quota exceeded',
  });
  assert.equal(classification.kind, 'rate-limit');
  assert.equal(classification.retryable, true);
});

test('attempt timeout is distinct from user cancellation', async () => {
  await assert.rejects(
    runWithRetry(
      ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      { maxAttempts: 1, attemptTimeoutMs: 5 },
    ),
    (error: unknown) =>
      error instanceof AIRequestTimeoutError &&
      error.scope === 'attempt' &&
      classifyAIError(error).retryable,
  );

  const controller = new AbortController();
  const pending = runWithRetry(
    ({ signal }) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    { signal: controller.signal, maxAttempts: 2 },
  );
  controller.abort(new AIAbortError('cancelled by user'));
  await assert.rejects(pending, (error: unknown) => classifyAIError(error).kind === 'aborted');
});

test('overall deadline prevents waiting through retry backoff', async () => {
  let calls = 0;
  await assert.rejects(
    runWithRetry(
      async () => {
        calls += 1;
        throw new AIHttpError(503, 'busy');
      },
      {
        deadlineAt: Date.now() + 50,
        maxAttempts: 2,
        baseDelayMs: 100,
        maxDelayMs: 100,
        random: () => 1,
      },
    ),
    (error: unknown) => error instanceof AIRequestTimeoutError && error.scope === 'deadline',
  );
  assert.equal(calls, 1);
});

test('FIFO limiter releases capacity and removes cancelled queued work', async () => {
  const limiter = new AbortableFIFOLimiter(1);
  let releaseFirst!: () => void;
  const first = limiter.acquire().then((release) => {
    releaseFirst = release;
  });
  await first;

  const cancelled = new AbortController();
  const second = limiter.acquire({ signal: cancelled.signal });
  const third = limiter.acquire();
  assert.equal(limiter.pendingCount, 2);

  cancelled.abort(new AIAbortError('skip queued task'));
  await assert.rejects(second, (error: unknown) => classifyAIError(error).kind === 'aborted');
  assert.equal(limiter.pendingCount, 1);

  releaseFirst();
  const releaseThird = await third;
  assert.equal(limiter.activeCount, 1);
  releaseThird();
  assert.equal(limiter.activeCount, 0);
});
