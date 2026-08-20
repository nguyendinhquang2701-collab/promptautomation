export class AIJsonParseError extends Error {
  readonly code: 'EMPTY_RESPONSE' | 'INVALID_JSON';
  readonly rawResponse: string;

  constructor(code: 'EMPTY_RESPONSE' | 'INVALID_JSON', message: string, rawResponse = '') {
    super(message);
    this.name = 'AIJsonParseError';
    this.code = code;
    this.rawResponse = rawResponse;
  }
}

const extractBalancedJSON = (text: string, open: '[' | '{', close: ']' | '}'): string | null => {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let insideString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '"') { insideString = !insideString; continue; }
    if (insideString) continue;
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
};

/** Parses model output without inventing a fallback value. */
export const parseAIJsonResponse = <T>(rawResponse: string): T => {
  const raw = rawResponse.trim();
  if (!raw) throw new AIJsonParseError('EMPTY_RESPONSE', 'AI không trả về nội dung. [EMPTY_RESPONSE]', rawResponse);

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1]?.trim() || raw;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const firstArray = candidate.indexOf('[');
    const firstObject = candidate.indexOf('{');
    const balanced = firstArray !== -1 && (firstObject === -1 || firstArray < firstObject)
      ? extractBalancedJSON(candidate, '[', ']')
      : firstObject !== -1 ? extractBalancedJSON(candidate, '{', '}') : null;
    if (balanced) {
      try { return JSON.parse(balanced) as T; } catch { /* throw a stable error below */ }
    }
  }
  throw new AIJsonParseError('INVALID_JSON', 'AI trả về JSON không hợp lệ hoặc phản hồi bị cắt. [INVALID_JSON]', rawResponse);
};

/**
 * Compatibility parser for slow OpenAI-compatible gateways. It keeps only
 * complete objects from a truncated top-level array; callers must still
 * validate every returned item and retry missing IDs.
 */
export const parseFastCompatibleAIJsonResponse = <T>(rawResponse: string): T => {
  let strictError: AIJsonParseError | undefined;
  try {
    return parseAIJsonResponse<T>(rawResponse);
  } catch (error) {
    strictError = error instanceof AIJsonParseError ? error : undefined;
    const raw = rawResponse.trim();
    if (!raw) throw strictError || new AIJsonParseError('EMPTY_RESPONSE', 'AI khÃ´ng tráº£ vá» ná»™i dung. [EMPTY_RESPONSE]');
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence?.[1]?.trim() || raw;
    const firstArray = candidate.indexOf('[');
    if (firstArray !== -1) {
      const arrayCandidate = candidate.slice(firstArray);
      const lastObject = arrayCandidate.lastIndexOf('}');
      if (lastObject !== -1) {
        try { return JSON.parse(`${arrayCandidate.slice(0, lastObject + 1)}]`) as T; } catch { /* try object below */ }
      }
    }
    const firstObject = candidate.indexOf('{');
    if (firstObject !== -1) {
      const objectCandidate = candidate.slice(firstObject);
      const lastObject = objectCandidate.lastIndexOf('}');
      if (lastObject !== -1) {
        try { return JSON.parse(objectCandidate.slice(0, lastObject + 1)) as T; } catch { /* stable fallback below */ }
      }
    }
    throw strictError || new AIJsonParseError('INVALID_JSON', 'AI tráº£ vá» JSON khÃ´ng há»£p lá»‡. [INVALID_JSON]');
  }
};

/** Wrapper keys a JSON-mode gateway uses when it ignores the requested "items". */
const ITEM_LIST_ALIASES = ['data', 'results', 'result', 'list', 'output', 'outputs', 'response', 'prompts', 'scenes'];
/** A batch item always carries the id the request asked it to echo back. */
const ITEM_ID_KEYS = ['sceneId', 'scene_id', 'id'];

export type ItemsEnvelopeSource = 'array' | 'items' | 'alias' | 'single-object';

export interface ItemsEnvelope {
  items: unknown[];
  /** 'array' and 'items' honour the contract; the rest were repaired here. */
  source: ItemsEnvelopeSource;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asSingleItem = (value: unknown): unknown[] | null =>
  isRecord(value) && ITEM_ID_KEYS.some(key => value[key] !== undefined) ? [value] : null;

/**
 * Recovers the item list from a JSON-mode reply.
 *
 * A model answering a one-scene batch very often drops the {"items": [...]}
 * envelope and returns the bare object: the payload is complete and valid,
 * only its wrapper is wrong. Rebuilding the list here keeps that work instead
 * of paying for a full regeneration round that would likely repeat the same
 * habit. Returns null when nothing item-shaped is present, so the caller still
 * fails loudly rather than inventing data.
 */
export const unwrapItemsEnvelope = (parsed: unknown): ItemsEnvelope | null => {
  if (Array.isArray(parsed)) return { items: parsed, source: 'array' };
  if (!isRecord(parsed)) return null;

  if (Array.isArray(parsed.items)) return { items: parsed.items, source: 'items' };
  const wrappedSingle = asSingleItem(parsed.items);
  if (wrappedSingle) return { items: wrappedSingle, source: 'items' };

  for (const key of ITEM_LIST_ALIASES) {
    if (Array.isArray(parsed[key])) return { items: parsed[key] as unknown[], source: 'alias' };
  }
  const keys = Object.keys(parsed);
  // A lone wrapper key holding an array is still an envelope, whatever its name.
  if (keys.length === 1 && Array.isArray(parsed[keys[0]])) return { items: parsed[keys[0]] as unknown[], source: 'alias' };

  const bareItem = asSingleItem(parsed);
  if (bareItem) return { items: bareItem, source: 'single-object' };
  return null;
};
