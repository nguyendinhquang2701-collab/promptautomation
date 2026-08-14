export interface ExtractedCharacterData {
  name: string;
  promptName: string;
  originalName: string;
  isRealPerson: boolean;
  visualDescription: string;
  ethnicity?: string;
  clothing?: string;
}

export interface NormalizedContextExtraction {
  context: string;
  characters: ExtractedCharacterData[];
}

export class ContextExtractionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextExtractionValidationError';
  }
}

const asTrimmedString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

/**
 * Validate provider output before it reaches application state. `globalContext`
 * is accepted as a one-release compatibility alias for older/custom models.
 */
export const normalizeContextExtraction = (value: unknown): NormalizedContextExtraction => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContextExtractionValidationError('AI trả về không đúng đối tượng JSON cho bước trích xuất.');
  }

  const payload = value as Record<string, unknown>;
  const context = asTrimmedString(payload.context) || asTrimmedString(payload.globalContext);
  if (!context) {
    throw new ContextExtractionValidationError('AI không trả về bối cảnh hợp lệ.');
  }
  if (!Array.isArray(payload.characters)) {
    throw new ContextExtractionValidationError('AI không trả về danh sách nhân vật hợp lệ.');
  }

  const characters = payload.characters.map((item, index): ExtractedCharacterData => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ContextExtractionValidationError(`Nhân vật ${index + 1} không có cấu trúc hợp lệ.`);
    }
    const character = item as Record<string, unknown>;
    const name = asTrimmedString(character.name);
    const promptName = asTrimmedString(character.promptName);
    const originalName = typeof character.originalName === 'string' ? character.originalName.trim() : null;
    const visualDescription = asTrimmedString(character.visualDescription);

    if (!name || !promptName || originalName === null || typeof character.isRealPerson !== 'boolean' || !visualDescription) {
      throw new ContextExtractionValidationError(`Nhân vật ${index + 1} thiếu trường bắt buộc.`);
    }

    return {
      name,
      promptName,
      originalName,
      isRealPerson: character.isRealPerson,
      visualDescription,
      ...(asOptionalString(character.ethnicity) ? { ethnicity: asOptionalString(character.ethnicity) } : {}),
      ...(asOptionalString(character.clothing) ? { clothing: asOptionalString(character.clothing) } : {}),
    };
  });

  return { context, characters };
};
