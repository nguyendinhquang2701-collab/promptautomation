import assert from 'node:assert/strict';
import test from 'node:test';

import { readResponseBodyForDiagnostics } from '../services/geminiService';

test('stops reading an SSE body after DONE even if the server never closes the stream', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"[]"}}]}\n\ndata: [DONE]\n\n'));
    },
  });
  const updates: number[] = [];

  const result = await readResponseBodyForDiagnostics(new Response(stream), (patch) => {
    if (patch.responseBytes !== undefined) updates.push(patch.responseBytes);
  }, 20);

  assert.match(result.rawBody, /\[DONE\]/);
  assert.ok(result.bytes > 0);
  assert.equal(updates.length, 1);
});

test('reports a stable timeout when a response body stops producing chunks', async () => {
  const stream = new ReadableStream<Uint8Array>({ start() {} });

  await assert.rejects(
    readResponseBodyForDiagnostics(new Response(stream), () => undefined, 5),
    (error: unknown) => error instanceof Error && /BODY_IDLE_TIMEOUT/.test(error.message),
  );
});

test('identifies a provider that sends a few bytes and then stalls', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{} '));
    },
  });

  await assert.rejects(
    readResponseBodyForDiagnostics(new Response(stream), () => undefined, {
      idleTimeoutMs: 5,
      lowProgressTimeoutMs: 100,
      minProgressBytes: 32,
      maxDurationMs: 100,
    }),
    (error: unknown) => (error as { code?: string }).code === 'PROVIDER_STALLED_BODY',
  );
});

test('does not let tiny heartbeat chunks keep a Fast response open forever', async () => {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(' '));
      timer = setInterval(() => controller.enqueue(encoder.encode(' ')), 2);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  await assert.rejects(
    readResponseBodyForDiagnostics(new Response(stream), () => undefined, {
      idleTimeoutMs: 50,
      lowProgressTimeoutMs: 12,
      minProgressBytes: 32,
      maxDurationMs: 100,
    }),
    (error: unknown) => (error as { code?: string }).code === 'PROVIDER_STALLED_BODY',
  );
});
