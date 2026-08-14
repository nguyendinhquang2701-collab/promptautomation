/**
 * Split a raw script into project-sized segments without dropping text or
 * getting stuck on punctuation/line-break edge cases.
 */
export const splitRawScriptIntoSegments = (
  rawScript: string,
  maxChars = 4500,
  preferredMinimum = 3500,
): string[] => {
  const source = rawScript.trim();
  if (!source) return [];

  const safeMax = Math.max(1, Math.floor(maxChars));
  const safeMinimum = Math.min(safeMax, Math.max(1, Math.floor(preferredMinimum)));
  const segments: string[] = [];
  let remaining = source;

  while (remaining.length > safeMax) {
    const window = remaining.slice(0, safeMax);
    let splitAt = 0;

    // Prefer paragraph/cue boundaries and sentence endings, but only when the
    // resulting segment is reasonably sized. `match.index + match[0].length`
    // is always positive, so the loop can never repeat without consuming text.
    const boundaryPattern = /\n{1,}|[.!?…]+(?:["')\]]*)\s+/g;
    for (const match of window.matchAll(boundaryPattern)) {
      const candidate = (match.index || 0) + match[0].length;
      if (candidate >= safeMinimum) splitAt = candidate;
    }

    if (splitAt === 0) splitAt = safeMax;
    const segment = remaining.slice(0, splitAt).trim();

    // Defensive fallback for unusual Unicode/whitespace input.
    if (!segment) {
      splitAt = safeMax;
      segments.push(remaining.slice(0, splitAt));
    } else {
      segments.push(segment);
    }
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) segments.push(remaining);
  return segments;
};
