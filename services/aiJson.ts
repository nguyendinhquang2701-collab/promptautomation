export class AIJsonParseError extends Error {
  readonly code: 'EMPTY_RESPONSE' | 'INVALID_JSON';

  constructor(code: 'EMPTY_RESPONSE' | 'INVALID_JSON', message: string) {
    super(message);
    this.name = 'AIJsonParseError';
    this.code = code;
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
  if (!raw) throw new AIJsonParseError('EMPTY_RESPONSE', 'AI không trả về nội dung. [EMPTY_RESPONSE]');

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
  throw new AIJsonParseError('INVALID_JSON', 'AI trả về JSON không hợp lệ hoặc phản hồi bị cắt. [INVALID_JSON]');
};
