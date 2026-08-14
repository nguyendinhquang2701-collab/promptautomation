/**
 * Provider-agnostic runtime primitives for AI requests.
 *
 * This module deliberately has no dependency on geminiService. It owns the
 * mechanics that must be shared by every provider: cancellation, deadlines,
 * bounded retries, key health/rotation, and fair concurrency limiting.
 */

export const DEFAULT_MAX_ATTEMPTS = 2 as const;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 90_000;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
export const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const SERVER_ERROR_STATUSES = new Set([500, 502, 503, 504]);

export type TimeoutScope = 'attempt' | 'deadline';
export type AIErrorKind =
  | 'aborted'
  | 'timeout'
  | 'network'
  | 'rate-limit'
  | 'quota'
  | 'authentication'
  | 'client'
  | 'server'
  | 'format'
  | 'unknown';
export type KeyAction = 'keep' | 'next' | 'cooldown' | 'disable';

export class AIAbortError extends Error {
  readonly code = 'AI_ABORTED';

  constructor(message = 'AI request was aborted.', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AIAbortError';
  }
}

export class AIRequestTimeoutError extends Error {
  readonly code = 'AI_REQUEST_TIMEOUT';

  constructor(
    readonly scope: TimeoutScope,
    readonly timeoutMs: number,
    options?: { cause?: unknown; deadlineAt?: number; message?: string },
  ) {
    super(
      options?.message ||
        (scope === 'deadline'
          ? 'The AI request exceeded its total deadline.'
          : `The AI request attempt timed out after ${timeoutMs}ms.`),
      { cause: options?.cause },
    );
    this.name = 'AIRequestTimeoutError';
    this.deadlineAt = options?.deadlineAt;
  }

  readonly deadlineAt?: number;
}

export interface AIHttpErrorOptions {
  details?: unknown;
  retryAfterMs?: number;
  providerId?: string;
  cause?: unknown;
}

export class AIHttpError extends Error {
  readonly code = 'AI_HTTP_ERROR';
  readonly details?: unknown;
  readonly retryAfterMs?: number;
  readonly providerId?: string;

  constructor(readonly status: number, message: string, options: AIHttpErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AIHttpError';
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
    this.providerId = options.providerId;
  }
}

export interface AIErrorClassification {
  kind: AIErrorKind;
  retryable: boolean;
  keyAction: KeyAction;
  providerFallbackAllowed: boolean;
  status?: number;
  retryAfterMs?: number;
}

const numericStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  // SDKs differ: Google may expose a symbolic `status` together with numeric
  // `code`, while fetch-style clients put the number on `response.status`.
  // Inspect every candidate instead of letting a symbolic value mask the code.
  for (const raw of [candidate.status, candidate.response?.status, candidate.code]) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && /^\d{3}$/.test(raw)) return Number(raw);
  }
  return undefined;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

/** Pure classification; callers may override retry decisions per operation. */
export const classifyAIError = (error: unknown): AIErrorClassification => {
  if (error instanceof AIRequestTimeoutError) {
    return {
      kind: 'timeout',
      retryable: error.scope === 'attempt',
      keyAction: error.scope === 'attempt' ? 'next' : 'keep',
      providerFallbackAllowed: true,
    };
  }
  if (error instanceof AIAbortError) {
    return {
      kind: 'aborted',
      retryable: false,
      keyAction: 'keep',
      providerFallbackAllowed: false,
    };
  }

  const name =
    error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string'
      ? (error as { name: string }).name
      : '';
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  if (name === 'AbortError') {
    return {
      kind: 'aborted',
      retryable: false,
      keyAction: 'keep',
      providerFallbackAllowed: false,
    };
  }

  if (code === 'PROVIDER_STALLED_BODY' || code === 'BODY_IDLE_TIMEOUT') {
    return {
      kind: 'timeout',
      retryable: true,
      keyAction: 'keep',
      providerFallbackAllowed: false,
    };
  }

  if (code === 'INVALID_JSON' || code === 'EMPTY_RESPONSE') {
    return {
      kind: 'format',
      retryable: true,
      keyAction: 'keep',
      providerFallbackAllowed: false,
    };
  }

  const status = error instanceof AIHttpError ? error.status : numericStatus(error);
  const retryAfterMs = error instanceof AIHttpError ? error.retryAfterMs : undefined;
  const message = errorMessage(error);
  const invalidKey = /API[_ ]?KEY[_ ]?INVALID|API key not valid|invalid api key/i.test(message);

  if (status === 401 || status === 403 || invalidKey) {
    return {
      kind: 'authentication',
      retryable: false,
      keyAction: 'disable',
      providerFallbackAllowed: true,
      status,
    };
  }
  if (status === 402) {
    return {
      kind: 'quota',
      retryable: false,
      keyAction: 'cooldown',
      providerFallbackAllowed: true,
      status,
      retryAfterMs,
    };
  }
  if (status === 429) {
    return {
      kind: 'rate-limit',
      retryable: true,
      keyAction: 'cooldown',
      providerFallbackAllowed: true,
      status,
      retryAfterMs,
    };
  }
  if (status !== undefined && SERVER_ERROR_STATUSES.has(status)) {
    return {
      kind: 'server',
      retryable: true,
      keyAction: 'keep',
      providerFallbackAllowed: true,
      status,
      retryAfterMs,
    };
  }
  if (status !== undefined) {
    return {
      kind: 'client',
      retryable: RETRYABLE_HTTP_STATUSES.has(status),
      keyAction: 'keep',
      providerFallbackAllowed: false,
      status,
      retryAfterMs,
    };
  }

  if (error instanceof TypeError || /failed to fetch|networkerror|network request failed/i.test(message)) {
    return {
      kind: 'network',
      retryable: true,
      keyAction: 'next',
      providerFallbackAllowed: true,
    };
  }

  return {
    kind: 'unknown',
    retryable: false,
    keyAction: 'keep',
    providerFallbackAllowed: false,
  };
};

/** Parses either Retry-After seconds or an HTTP-date. */
export const parseRetryAfterMs = (value: string | null | undefined, now = Date.now()): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
};

export const deadlineAfter = (timeoutMs: number, now = Date.now()): number =>
  now + Math.max(0, timeoutMs);

export const remainingDeadlineMs = (deadlineAt: number | undefined, now = Date.now()): number =>
  deadlineAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadlineAt - now);

export const computeBackoffDelayMs = (
  failedAttempt: number,
  baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
  random = Math.random,
): number => {
  const exponent = Math.max(0, failedAttempt - 1);
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
  return Math.max(0, Math.floor(ceiling * Math.min(1, Math.max(0, random()))));
};

const abortReasonAsError = (reason: unknown, fallbackMessage = 'AI request was aborted.'): Error => {
  if (reason instanceof Error) return reason;
  return new AIAbortError(fallbackMessage, { cause: reason });
};

export interface LinkedAbortHandle {
  controller: AbortController;
  signal: AbortSignal;
  dispose: () => void;
}

export interface LinkedAbortOptions {
  signals?: Array<AbortSignal | null | undefined>;
  deadlineAt?: number;
  timeoutMs?: number;
  now?: () => number;
  timeoutScope?: TimeoutScope;
}

/**
 * Links parent cancellation with the earliest of an attempt timeout and total
 * deadline. Always call dispose() when the operation settles.
 */
export const createLinkedAbortController = (options: LinkedAbortOptions = {}): LinkedAbortHandle => {
  const controller = new AbortController();
  const now = options.now || Date.now;
  const cleanups: Array<() => void> = [];

  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  for (const parent of options.signals || []) {
    if (!parent) continue;
    if (parent.aborted) {
      abort(parent.reason);
      break;
    }
    const onAbort = () => abort(parent.reason);
    parent.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => parent.removeEventListener('abort', onAbort));
  }

  const remaining = remainingDeadlineMs(options.deadlineAt, now());
  const requestedTimeout =
    options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.timeoutMs);
  const effectiveTimeout = Math.min(remaining, requestedTimeout);

  if (!controller.signal.aborted && Number.isFinite(effectiveTimeout)) {
    const deadlineWins = remaining <= requestedTimeout;
    const scope = deadlineWins ? 'deadline' : options.timeoutScope || 'attempt';
    const timeoutError = new AIRequestTimeoutError(scope, effectiveTimeout, {
      deadlineAt: options.deadlineAt,
    });
    if (effectiveTimeout <= 0) {
      abort(timeoutError);
    } else {
      const timer = setTimeout(() => abort(timeoutError), effectiveTimeout);
      cleanups.push(() => clearTimeout(timer));
    }
  }

  let disposed = false;
  return {
    controller,
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
};

export interface AttemptAbortOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  attemptTimeoutMs?: number;
  now?: () => number;
}

export const createAttemptAbortController = (options: AttemptAbortOptions = {}): LinkedAbortHandle =>
  createLinkedAbortController({
    signals: [options.signal],
    deadlineAt: options.deadlineAt,
    timeoutMs: options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
    timeoutScope: 'attempt',
    now: options.now,
  });

export const sleepAbortable = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(abortReasonAsError(signal.reason));
  const delayMs = Math.max(0, ms);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(abortReasonAsError(signal?.reason)));
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

export interface RetryAttemptContext {
  attempt: number;
  maxAttempts: 1 | 2 | 3;
  signal: AbortSignal;
  deadlineAt?: number;
}

export interface RetryOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  attemptTimeoutMs?: number;
  /** Values above three are intentionally clamped to three. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  classify?: (error: unknown) => AIErrorClassification;
  shouldRetry?: (
    classification: AIErrorClassification,
    error: unknown,
    context: RetryAttemptContext,
  ) => boolean;
  onRetry?: (
    classification: AIErrorClassification,
    error: unknown,
    context: RetryAttemptContext,
    delayMs: number,
  ) => void | Promise<void>;
  random?: () => number;
}

export const normalizeMaxAttempts = (value: number | undefined): 1 | 2 | 3 =>
  value !== undefined && value <= 1 ? 1 : value !== undefined && value >= 3 ? 3 : DEFAULT_MAX_ATTEMPTS;

/** A deadline-aware retry loop with a hard ceiling of three attempts. */
export const runWithRetry = async <T>(
  operation: (context: RetryAttemptContext) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
  const overall = createLinkedAbortController({
    signals: [options.signal],
    deadlineAt: options.deadlineAt,
  });
  const classify = options.classify || classifyAIError;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (overall.signal.aborted) throw abortReasonAsError(overall.signal.reason);

      const attemptAbort = createAttemptAbortController({
        signal: overall.signal,
        deadlineAt: options.deadlineAt,
        attemptTimeoutMs: options.attemptTimeoutMs,
      });
      const context: RetryAttemptContext = {
        attempt,
        maxAttempts,
        signal: attemptAbort.signal,
        deadlineAt: options.deadlineAt,
      };

      try {
        return await operation(context);
      } catch (caught) {
        const error = attemptAbort.signal.aborted
          ? abortReasonAsError(attemptAbort.signal.reason)
          : caught;
        const classification = classify(error);
        const retry = options.shouldRetry
          ? options.shouldRetry(classification, error, context)
          : classification.retryable;

        if (!retry || attempt >= maxAttempts) throw error;
        if (overall.signal.aborted) throw abortReasonAsError(overall.signal.reason);

        const calculatedDelay = computeBackoffDelayMs(
          attempt,
          options.baseDelayMs,
          options.maxDelayMs,
          options.random,
        );
        const delayMs = classification.retryAfterMs ?? calculatedDelay;
        const remaining = remainingDeadlineMs(options.deadlineAt);
        if (remaining <= delayMs) {
          throw new AIRequestTimeoutError('deadline', remaining, {
            cause: error,
            deadlineAt: options.deadlineAt,
          });
        }

        await options.onRetry?.(classification, error, context, delayMs);
        await sleepAbortable(delayMs, overall.signal);
      } finally {
        attemptAbort.dispose();
      }
    }

    throw new Error('Retry loop exited unexpectedly.');
  } finally {
    overall.dispose();
  }
};

export type KeyState = 'ready' | 'cooldown' | 'disabled';

export interface AIKeyEntry {
  key: string;
  state: KeyState;
  cooldownUntil: number;
}

export interface AIKeyPoolState {
  entries: AIKeyEntry[];
  cursor: number;
}

export interface AIKeySelection {
  key: string;
  index: number;
}

export interface AIKeySelectionResult {
  state: AIKeyPoolState;
  selection?: AIKeySelection;
  nextAvailableAt?: number;
}

export const normalizeApiKeys = (keys: readonly string[]): string[] =>
  Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));

export const createKeyPoolState = (keys: readonly string[], startIndex = 0): AIKeyPoolState => {
  const normalized = normalizeApiKeys(keys);
  return {
    entries: normalized.map((key) => ({ key, state: 'ready', cooldownUntil: 0 })),
    cursor: normalized.length === 0 ? 0 : ((startIndex % normalized.length) + normalized.length) % normalized.length,
  };
};

/** Pure round-robin selection. The selected key advances the returned cursor. */
export const selectNextKey = (pool: AIKeyPoolState, now = Date.now()): AIKeySelectionResult => {
  const entries = pool.entries.map((entry) =>
    entry.state === 'cooldown' && entry.cooldownUntil <= now
      ? { ...entry, state: 'ready' as const, cooldownUntil: 0 }
      : { ...entry },
  );
  if (entries.length === 0) return { state: { entries, cursor: 0 } };

  for (let offset = 0; offset < entries.length; offset++) {
    const index = (pool.cursor + offset) % entries.length;
    if (entries[index].state !== 'ready') continue;
    return {
      state: { entries, cursor: (index + 1) % entries.length },
      selection: { key: entries[index].key, index },
    };
  }

  const cooldowns = entries
    .filter((entry) => entry.state === 'cooldown')
    .map((entry) => entry.cooldownUntil);
  return {
    state: { entries, cursor: pool.cursor % entries.length },
    nextAvailableAt: cooldowns.length > 0 ? Math.min(...cooldowns) : undefined,
  };
};

/** Pure key-health update suitable for reducers and deterministic tests. */
export const updateKeyState = (
  pool: AIKeyPoolState,
  index: number,
  action: KeyAction,
  options: { now?: number; cooldownMs?: number } = {},
): AIKeyPoolState => {
  if (index < 0 || index >= pool.entries.length) return pool;
  const now = options.now ?? Date.now();
  const entries = pool.entries.map((entry, entryIndex) => {
    if (entryIndex !== index) return { ...entry };
    if (action === 'disable') return { ...entry, state: 'disabled' as const, cooldownUntil: 0 };
    if (action === 'cooldown') {
      return {
        ...entry,
        state: 'cooldown' as const,
        cooldownUntil: now + Math.max(0, options.cooldownMs || 0),
      };
    }
    return { ...entry, state: 'ready' as const, cooldownUntil: 0 };
  });
  return { entries, cursor: pool.cursor };
};

type Release = () => void;

interface Waiter {
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  dispose: () => void;
  onAbort: () => void;
}

export interface LimiterAcquireOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

/** Abortable, fair FIFO semaphore. Queue time is covered by deadlineAt. */
export class AbortableFIFOLimiter {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('Limiter capacity must be a positive integer.');
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get currentCapacity(): number {
    return this.capacity;
  }

  /** Changes admission capacity without interrupting requests already in flight. */
  setCapacity(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('Limiter capacity must be a positive integer.');
    }
    this.capacity = capacity;
    this.drain();
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  acquire(options: LimiterAcquireOptions = {}): Promise<Release> {
    const linked = createLinkedAbortController({
      signals: [options.signal],
      deadlineAt: options.deadlineAt,
    });
    if (linked.signal.aborted) {
      const error = abortReasonAsError(linked.signal.reason);
      linked.dispose();
      return Promise.reject(error);
    }

    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal: linked.signal,
        dispose: linked.dispose,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          waiter.dispose();
          reject(abortReasonAsError(waiter.signal.reason));
        },
      };
      waiter.signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }

  async run<T>(operation: () => Promise<T>, options: LimiterAcquireOptions = {}): Promise<T> {
    const release = await this.acquire(options);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  cancelPending(reason: unknown = new AIAbortError('Limiter queue was cancelled.')): void {
    for (const waiter of this.queue.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.dispose();
      waiter.reject(abortReasonAsError(reason));
    }
  }

  private drain(): void {
    while (this.active < this.capacity && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.signal.aborted) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.dispose();
        waiter.reject(abortReasonAsError(waiter.signal.reason));
        continue;
      }

      this.active++;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.dispose();
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
}

export interface WorkerPoolOptions {
  /** Stop all workers before they claim another item. */
  shouldStop?: () => boolean;
  /** In Ultra mode, stop secondary workers after provider backpressure. */
  shouldReduceToSingleWorker?: () => boolean;
}

/**
 * A small deterministic worker pool for independent projects. Callers own
 * result persistence; this primitive only controls how many jobs are active.
 */
export const runWithWorkerPool = async <T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  options: WorkerPoolOptions = {},
): Promise<void> => {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Worker concurrency must be positive.');
  let nextIndex = 0;

  const runWorker = async (workerIndex: number): Promise<void> => {
    while (!options.shouldStop?.()) {
      if (workerIndex > 0 && options.shouldReduceToSingleWorker?.()) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, (_, index) => runWorker(index)));
};

/** Split an ordered list into bounded, non-empty batches. */
export const splitIntoBatches = <T>(items: readonly T[], batchSize: number): T[][] => {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('Batch size must be a positive integer.');
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
};
