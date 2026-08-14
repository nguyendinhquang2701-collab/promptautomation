import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AIAbortError,
  AIHttpError,
  AIRequestTimeoutError,
  AbortableFIFOLimiter,
  classifyAIError,
  normalizeMaxAttempts,
  runWithWorkerPool,
  runWithRetry,
  splitIntoBatches,
} from '../services/aiRuntime';

test('prompt-sized batches keep ordering and cap each request at ten scenes', () => {
  const batches = splitIntoBatches(Array.from({ length: 17 }, (_, index) => index + 1), 10);

  assert.deepEqual(batches.map(batch => batch.length), [10, 7]);
  assert.deepEqual(batches.flat(), Array.from({ length: 17 }, (_, index) => index + 1));
});

test('retry policy is capped at three attempts', async () => {
  assert.equal(normalizeMaxAttempts(99), 3);
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

  assert.equal(calls, 3);
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

test('a stalled provider body is retried once without rotating the key', () => {
  const classification = classifyAIError({ code: 'PROVIDER_STALLED_BODY', message: 'only 3 bytes received' });
  assert.equal(classification.kind, 'timeout');
  assert.equal(classification.retryable, true);
  assert.equal(classification.keyAction, 'keep');
});

test('a completed response with invalid JSON gets one format retry', () => {
  const classification = classifyAIError({ code: 'INVALID_JSON', message: 'model returned markdown' });
  assert.equal(classification.kind, 'format');
  assert.equal(classification.retryable, true);
  assert.equal(classification.keyAction, 'keep');
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

test('limiter can reduce a four-request operation to two without interrupting active work', async () => {
  const limiter = new AbortableFIFOLimiter(4);
  const releases: Array<() => void> = [];
  const firstFour = await Promise.all([1, 2, 3, 4].map(() => limiter.acquire()));
  assert.equal(limiter.activeCount, 4);

  limiter.setCapacity(2);
  const queued = limiter.acquire();
  assert.equal(limiter.pendingCount, 1);

  firstFour[0]();
  firstFour[1]();
  assert.equal(limiter.activeCount, 2);
  assert.equal(limiter.pendingCount, 1);

  firstFour[2]();
  const releaseQueued = await queued;
  releases.push(firstFour[3], releaseQueued);
  assert.equal(limiter.activeCount, 2);
  releases.forEach(release => release());
  assert.equal(limiter.activeCount, 0);
});

test('worker pool never exceeds its configured concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  await runWithWorkerPool([1, 2, 3, 4, 5], 2, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
  });
  assert.equal(maxActive, 2);
});

test('worker pool keeps only one worker after a safety downgrade', async () => {
  let active = 0;
  let maxActive = 0;
  const completed: number[] = [];
  await runWithWorkerPool([1, 2, 3], 2, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    completed.push(item);
    await Promise.resolve();
    active -= 1;
  }, { shouldReduceToSingleWorker: () => true });
  assert.equal(maxActive, 1);
  assert.deepEqual(completed, [1, 2, 3]);
});
