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

const asBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return undefined;
};

const unwrapKnownPayload = (value: Record<string, unknown>): Record<string, unknown> => {
  for (const key of ['result', 'data', 'output']) {
    const nested = value[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  return value;
};

/**
 * Validate provider output before it reaches app state. Known wrapper and
 * field aliases are accepted only for provider compatibility.
 */
export const normalizeContextExtraction = (value: unknown): NormalizedContextExtraction => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContextExtractionValidationError('AI trả về kết quả trích xuất không phải JSON object. [WRONG_SHAPE]');
  }

  const payload = unwrapKnownPayload(value as Record<string, unknown>);
  const context = asTrimmedString(payload.context)
    || asTrimmedString(payload.globalContext)
    || asTrimmedString(payload.global_context);
  if (!context) {
    throw new ContextExtractionValidationError('AI không trả về bối cảnh hợp lệ. [EMPTY_CONTEXT]');
  }

  const rawCharacters = payload.characters ?? payload.characterList ?? payload.character_list;
  if (!Array.isArray(rawCharacters)) {
    throw new ContextExtractionValidationError('AI không trả về danh sách nhân vật hợp lệ. [INVALID_CHARACTERS]');
  }

  const characters = rawCharacters.map((item, index): ExtractedCharacterData => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ContextExtractionValidationError(`Nhân vật ${index + 1} có cấu trúc không hợp lệ. [INVALID_CHARACTER]`);
    }
    const character = item as Record<string, unknown>;
    const name = asTrimmedString(character.name)
      || asTrimmedString(character.promptName)
      || asTrimmedString(character.prompt_name)
      || asTrimmedString(character.originalName)
      || asTrimmedString(character.original_name);
    const promptName = asTrimmedString(character.promptName) || asTrimmedString(character.prompt_name) || name;
    const originalName = asOptionalString(character.originalName) || asOptionalString(character.original_name) || '';
    const visualDescription = asOptionalString(character.visualDescription) || asOptionalString(character.visual_description) || '';
    const isRealPerson = asBoolean(character.isRealPerson) ?? asBoolean(character.is_real_person) ?? false;

    if (!name || !promptName) {
      throw new ContextExtractionValidationError(`Nhân vật ${index + 1} thiếu tên hợp lệ. [INVALID_CHARACTER]`);
    }

    return {
      name,
      promptName,
      originalName,
      isRealPerson,
      visualDescription,
      ...(asOptionalString(character.ethnicity) ? { ethnicity: asOptionalString(character.ethnicity) } : {}),
      ...(asOptionalString(character.clothing) ? { clothing: asOptionalString(character.clothing) } : {}),
    };
  });

  return { context, characters };
};
