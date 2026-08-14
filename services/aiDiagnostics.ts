export type AIDiagnosticPhase =
  | 'queued'
  | 'connecting'
  | 'waiting_headers'
  | 'reading_body'
  | 'parsing'
  | 'validating'
  | 'retry_backoff'
  | 'completed'
  | 'failed';

export interface AIDiagnostic {
  requestId: string;
  phase: AIDiagnosticPhase;
  startedAt: number;
  updatedAt: number;
  providerName?: string;
  model?: string;
  endpoint?: string;
  attempt?: number;
  maxAttempts?: number;
  status?: number;
  contentType?: string;
  responseBytes?: number;
  /** Number of chunks received from a streamed or chunked HTTP body. */
  chunkCount?: number;
  firstByteMs?: number;
  bodyMs?: number;
  /** Milliseconds from the start of body reading until the newest chunk. */
  lastChunkMs?: number;
  /** True when an optional compatibility field was rejected and removed. */
  compatibilityFallback?: boolean;
  finishReason?: string;
  reasoningTokens?: number;
  outputTokens?: number;
  receivedItems?: number;
  errorCode?: string;
  errorMessage?: string;
  responsePreview?: string;
}

export const createDiagnosticId = (): string =>
  globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** Keeps local diagnostics useful without retaining an unbounded model response. */
export const sanitizeDiagnosticText = (raw: string, limit = 2_000): string => {
  const normalized = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED_API_KEY]')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= limit) return normalized;
  const head = Math.floor(limit * 0.7);
  return `${normalized.slice(0, head)} … [truncated] … ${normalized.slice(-Math.floor(limit * 0.3))}`;
};

export const sanitizeResponsePreview = sanitizeDiagnosticText;
