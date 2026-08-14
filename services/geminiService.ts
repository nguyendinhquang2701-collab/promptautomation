import { GoogleGenAI, Type } from "@google/genai";
import { Scene, ColorStyle, CharacterIdentity, PromptItem, PromptElement, SpeedMode } from "../types";
import {
  AbortableFIFOLimiter,
  AIHttpError,
  classifyAIError,
  createKeyPoolState,
  deadlineAfter,
  normalizeApiKeys,
  parseRetryAfterMs,
  remainingDeadlineMs,
  runWithWorkerPool,
  runWithRetry,
  selectNextKey,
  splitIntoBatches,
  updateKeyState,
} from "./aiRuntime";
import { ContextExtractionValidationError, normalizeContextExtraction } from "./contextExtraction";
import { AIJsonParseError, parseAIJsonResponse, parseFastCompatibleAIJsonResponse } from "./aiJson";
import { AIDiagnostic, AIDiagnosticPhase, createDiagnosticId, sanitizeDiagnosticText, sanitizeResponsePreview } from "./aiDiagnostics";
import { ThinkingProfile, ThinkingStatus, ThinkingPolicyError, resolveThinkingPolicy } from "./aiReasoningPolicy";

export type { AIDiagnostic } from "./aiDiagnostics";

export interface ProviderConfig {
  id: string;
  name: string;
  type: 'gemini' | 'openai-compatible';
  model: string;
  baseUrl?: string;
  keyPrefix: string; 
  group: string; 
  structuredOutput?: 'json_schema' | 'json_object';
  thinkingProfile?: ThinkingProfile;
  thinkingStatus?: ThinkingStatus;
  thinkingMessage?: string;
  thinkingCheckedAt?: number;
  safeConcurrency?: 1 | 2 | 4;
}

export interface PromptOptions {
  splitLogic?: string;
  audioMode?: 'remove' | 'keep';
  // 👉 Bước 2.5 — Visual Planner (chống lặp bố cục). Mặc định BẬT.
  visualPlanner?: boolean;
  // 👉 Bước 3.5 — Audit pass (soi lại prompt đã lắp ráp, lỗi Nặng thì tự viết lại).
  // Không set → BẬT; người dùng có thể tắt nếu muốn bỏ qua bước phụ trợ này.
  auditPass?: boolean;
}

export interface AIOperationOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  providerId?: string;
  onProgress?: (message: string) => void;
  onPartialScenes?: (scenes: Scene[]) => void;
  onPartialPrompts?: (items: PromptItem[]) => void;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  speedMode?: SpeedMode;
  /** Ultra binds a whole operation to one saved key slot. */
  keySlot?: number;
  /** Shared per-operation gate; keeps a mode's request count exact across all batches. */
  requestLimiter?: AbortableFIFOLimiter;
  onConcurrencyDowngrade?: (reason: string) => void;
  onRequestActivity?: (delta: 1 | -1) => void;
  /** Sanitized request lifecycle state for the progress panel and support diagnosis. */
  onDiagnostic?: (diagnostic: AIDiagnostic) => void;
}

export const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  'gpt-4o': { id: 'gpt-4o', name: 'ChatGPT 4o', type: 'openai-compatible', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', keyPrefix: 'openai', group: 'OpenAI', structuredOutput: 'json_schema' },
  'gpt-4o-mini': { id: 'gpt-4o-mini', name: 'ChatGPT 4o Mini', baseUrl: 'https://api.openai.com/v1', type: 'openai-compatible', model: 'gpt-4o-mini', keyPrefix: 'openai', group: 'OpenAI', structuredOutput: 'json_schema' },
  gemini: { id: 'gemini', name: 'Gemini 2.5 Flash', type: 'gemini', model: 'gemini-2.5-flash', keyPrefix: 'gemini', group: 'Google' },
  deepseek: { id: 'deepseek', name: 'Deepseek V4', type: 'openai-compatible', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1', keyPrefix: 'deepseek', group: 'Deepseek', structuredOutput: 'json_object' },
  grok: { id: 'grok', name: 'Grok 4.1', type: 'openai-compatible', model: 'grok-4-1-fast-reasoning', baseUrl: 'https://api.x.ai/v1', keyPrefix: 'grok', group: 'xAI', structuredOutput: 'json_object' },
  mistral: { id: 'mistral', name: 'Mistral Large', type: 'openai-compatible', model: 'mistral-large-latest', baseUrl: 'https://api.mistral.ai/v1', keyPrefix: 'mistral', group: 'Mistral', structuredOutput: 'json_object' }
};

const getProviderEndpointError = (providerConfig: ProviderConfig): string | null => {
  if (providerConfig.type === 'gemini') return null;
  let url: URL;
  try {
    url = new URL((providerConfig.baseUrl || '').trim());
  } catch {
    return 'Base URL không hợp lệ.';
  }
  if (url.username || url.password) return 'Base URL không được chứa username/password.';
  if (url.protocol === 'https:') return null;
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  const targetIsLocal = url.protocol === 'http:' && localHosts.has(url.hostname);
  const pageIsLocal = typeof window !== 'undefined' && localHosts.has(window.location.hostname);
  return targetIsLocal && pageIsLocal ? null : 'Base URL bắt buộc dùng HTTPS.';
};

export const AI_PROVIDERS: Record<string, ProviderConfig> = {};

export const loadAIProviders = () => {
    for (const key in AI_PROVIDERS) {
        delete AI_PROVIDERS[key];
    }
    Object.assign(AI_PROVIDERS, DEFAULT_PROVIDERS);
    try {
        const customStr = localStorage.getItem('app1_custom_providers');
        if (customStr) {
            let customArr = JSON.parse(customStr);
            // 👉 MIGRATION: DeepSeek khai tử deepseek-chat/deepseek-reasoner (2026/07/24) VÀ
            // endpoint chuẩn giờ là https://api.deepseek.com/v1 (thiếu /v1 → gọi API lỗi).
            // Config cũ lưu trong trình duyệt sẽ khiến API đứng → tự nâng model + chuẩn hoá
            // baseUrl, lưu lại, để người dùng chạy được ngay mà không phải sửa tay.
            let migrated = false;
            customArr = customArr.map((p: ProviderConfig) => {
                let np: ProviderConfig = p;
                if (np.model === 'deepseek-chat') { migrated = true; np = { ...np, model: 'deepseek-v4-flash', name: /v3/i.test(np.name || '') ? 'Deepseek V4' : np.name }; }
                else if (np.model === 'deepseek-reasoner') { migrated = true; np = { ...np, model: 'deepseek-v4-pro' }; }
                // Chuẩn hoá baseUrl DeepSeek thiếu /v1 (chỉ khi đúng host DeepSeek).
                if (np.baseUrl && /(^|\/\/)api\.deepseek\.com\/?$/.test(np.baseUrl.trim())) {
                    migrated = true; np = { ...np, baseUrl: 'https://api.deepseek.com/v1' };
                }
                return np;
            });
            if (migrated) localStorage.setItem('app1_custom_providers', JSON.stringify(customArr));
            customArr.forEach((p: ProviderConfig) => {
                if (!getProviderEndpointError(p)) AI_PROVIDERS[p.id] = p;
            });
        }
    } catch (e) {}
};

loadAIProviders();

// One conservative production pipeline for every provider: a single active
// request, moderate batches, and a small gap between completed calls.
const CONFIG = { BATCH_SIZE: 10, PROMPT_BATCH_SIZE: 10, REQUEST_GAP_MS: 350 };
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;
// Fast prioritizes a quick, bounded failure over a request that can hold a
// sequential workflow hostage for several minutes.
const FAST_REQUEST_TIMEOUT_MS = 120_000;
const RESPONSE_BODY_IDLE_TIMEOUT_MS = 45_000;
const FAST_LOW_PROGRESS_TIMEOUT_MS = 90_000;
const FAST_MIN_PROGRESS_BYTES = 32;
const DEFAULT_WORKFLOW_TIMEOUT_MS = {
  context: 180_000,
  analyze: 300_000,
  repair: 300_000,
  prompt: 600_000,
  style: 180_000,
};

// 👉 Veo hiểu các từ "phim nhựa" (film grain, shot on 35mm film, archival film...) theo
// nghĩa ĐEN → vẽ luôn viền phim, lỗ răng cưa, số khung hình, xước đen lên video (lỗi thật
// người dùng gặp). Thay tất định bằng từ an toàn, giữ ý "trông như quay thật".
const fixFilmLook = (s: string): string =>
  s.replace(/\bshot on (?:a\s+)?\d{1,3}\s*mm film\b/gi, 'natural realistic look')
   .replace(/\b(?:8|16|35|70)\s*mm film\b/gi, 'cinema look')
   .replace(/\b(?:subtle |fine |light |heavy )?film[- ]?grain\b/gi, 'true-to-life texture')
   .replace(/\barchival (?:footage|film)\b/gi, 'documentary realism')
   .replace(/\b(?:vintage|old) film (?:look|style|reel|stock|aesthetic)\b/gi, 'period look');

// 👉 Chốt chặn chính sách (tất định): mô tả nhân vật KHÔNG được chứa chức danh/vai trò
// (president, general, minister...) vì chính nó định danh người thật (vd "president of
// Guatemala" = Árbenz). Cắt bỏ mọi đoạn (ngăn bởi dấu phẩy) có chứa từ chức danh, giữ lại
// các đoạn ngoại hình thuần. Danh sách gọn, nhắm đúng chức danh chính trị/lãnh đạo.
const TITLE_WORD_RE = /\b(?:president|vice[- ]?president|king|queen|emperor|empress|prince|princess|monarch|dictator|general|colonel|admiral|marshal|minister|chancellor|senator|congress(?:man|woman)|governor|mayor|ambassador|ceo|chairman|chairwoman|head of state|leader|democratically elected|ruler|commander|pope|sultan|shah|tsar|czar|pharaoh|prime minister|secretary of state)\b/i;
const stripIdentityTitles = (desc: string): string => {
  if (!desc) return desc;
  return desc.split(',').map(s => s.trim()).filter(seg => seg && !TITLE_WORD_RE.test(seg)).join(', ');
};

// 👉 KHÔNG BAO GIỜ CÓ NGƯỜI DẪN CHUYỆN TRÊN HÌNH: narrator/host/presenter là người
// hiện đại, hay bị nhét vào cả cảnh cổ đại → phá mạch. Loại hẳn khỏi danh bạ nhân vật
// (narration chỉ là giọng off-screen). Video luôn liền mạch trong thế giới của câu chuyện.
// Khớp trên chuỗi ĐÃ FOLD (bỏ dấu, thường hoá) để bắt cả "Người dẫn chuyện" có dấu.
const NARRATOR_RE = /\b(?:narrator|narration|host|hostess|presenter|storyteller|story-teller|voice[- ]?over|voiceover|announcer|commentator|moderator|emcee)\b|nguoi dan|dan chuyen|dan truyen|thuyet minh|nguoi ke|nguoi thuyet/i;
const isNarratorCharacter = (c: CharacterIdentity): boolean =>
  NARRATOR_RE.test(foldText(`${c.name || ''} ${c.promptName || ''} ${c.originalName || ''}`));

// 👉 BẢO ĐẢM 100% CÓ NGOẠI HÌNH (tất định): nếu AI vẫn để trống (hoặc bị strip sạch),
// code tự dựng mô tả CHUNG theo framework Mặt/Vóc dáng/Trang phục để đồng bộ nhân vật.
const APPEARANCE_JUNK = new Set(['', 'n/a', 'none', 'unspecified', 'not specified', 'unknown', 'khong', 'null', 'undefined', '""']);
const ANIMAL_RE = /\b(horses?|dogs?|cats?|cows?|oxen|ox|buffalo(?:es)?|goats?|sheep|pigs?|hogs?|chickens?|ducks?|geese|donkeys?|mules?|elephants?|lions?|tigers?|bears?|wolves?|foxes?|deer|rabbits?|monkeys?|fish|snakes?|eagles?|owls?|camels?|mice|mouse|rats?|birds?)\b|ngựa|chó|mèo|trâu|dê|cừu|lợn|heo|gà|vịt|voi|hổ|sư tử|gấu|sói|cáo|hươu|thỏ|khỉ|cá|rắn/i;
const synthesizeAppearance = (c: CharacterIdentity): string => {
  const blob = `${c.name || ''} ${c.promptName || ''} ${c.visualDescription || ''} ${c.ethnicity || ''} ${c.clothing || ''}`;
  const animalHit = blob.match(ANIMAL_RE);
  if (animalHit && !/\b(man|woman|men|women|person|people|boy|girl|human)\b/i.test(blob)) {
    return `healthy adult ${animalHit[0].toLowerCase()}, smooth natural coat, calm eyes, sturdy build`;
  }
  const info = blob.toLowerCase();
  const female = /\b(woman|female|girl|lady|queen|princess|empress|matriarch|nun|mother|wife|daughter|actress|she|her|hostess)\b|phụ nữ|thiếu nữ|cô gái|bà |nữ /.test(info);
  const old = /\b(elderly|old|aged|senior|veteran|grand)\b|già|cao tuổi|lớn tuổi|trung niên|tóc bạc|râu bạc/.test(info);
  const young = /\b(young|teen|youth|boy|girl|child|kid|student)\b|trẻ|thanh niên|thiếu niên/.test(info);
  const ethn = (c.ethnicity && !APPEARANCE_JUNK.has(foldText(c.ethnicity.trim()))) ? c.ethnicity.trim() : 'white American';
  const clo = (c.clothing && !APPEARANCE_JUNK.has(foldText(c.clothing.trim()))) ? c.clothing.trim() : 'plain neutral everyday clothing';
  const age = old ? 'middle-aged' : young ? 'young' : 'adult';
  const gender = female ? 'woman' : 'man';
  const hair = female ? 'shoulder-length dark hair' : 'short dark hair';
  return `${age} ${ethn} ${gender}, oval face, ${hair}, medium build, ${clo}`;
};
const ensureAppearance = (c: CharacterIdentity): CharacterIdentity => {
  const cleaned = stripIdentityTitles((c.visualDescription || '').trim()).trim();
  return { ...c, visualDescription: APPEARANCE_JUNK.has(foldText(cleaned)) ? synthesizeAppearance(c) : cleaned };
};

const getColorDescription = (style: ColorStyle): string => {
  switch (style) {
    case 'cinematic': return "HDR, deep shadows, balanced highlights, pro color grading, realistic textures";
    case 'hot':       return "Orange-red grading, high contrast, warm thermal, vivid hues";
    case 'warm':      return "Golden hour, amber tones, 3200K, hazy, soft warm lighting";
    case 'cold':      return "Blue-teal grading, 6500K, cool high-key lighting, stark contrast";
    default:          return "";
  }
};

type AILane = 'scene' | 'prompt' | 'planner';
// Hard browser-wide ceiling. Each operation also brings its own mode limiter.
const AI_LIMITER = new AbortableFIFOLimiter(4);
const PLANNER_LIMITER = new AbortableFIFOLimiter(1);
let nextRequestAt = 0;
let nextUltraStartAt = 0;

const waitForRequestPace = async (signal?: AbortSignal): Promise<void> => {
  const delay = Math.max(0, nextRequestAt - Date.now());
  if (delay > 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, delay);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason || new DOMException('Operation cancelled', 'AbortError'));
      };
      function done() {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
};

const waitForUltraStartStagger = async (signal?: AbortSignal): Promise<void> => {
  const scheduledAt = Math.max(Date.now(), nextUltraStartAt);
  nextUltraStartAt = scheduledAt + 250;
  const delay = Math.max(0, scheduledAt - Date.now());
  if (delay === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delay);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason || new DOMException('Operation cancelled', 'AbortError')); };
    function done() { signal?.removeEventListener('abort', onAbort); resolve(); }
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const normalizeOperationOptions = (
  options: AIOperationOptions | undefined,
  workflowTimeoutMs: number,
): AIOperationOptions => ({
  ...options,
  providerId: options?.providerId || localStorage.getItem('app1_ai_provider') || (AI_PROVIDERS.gemini ? 'gemini' : Object.keys(AI_PROVIDERS)[0] || 'gemini'),
  deadlineAt: options?.deadlineAt ?? deadlineAfter(workflowTimeoutMs),
  attemptTimeoutMs: options?.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
  maxAttempts: Math.min(2, Math.max(1, options?.maxAttempts ?? 2)),
});

const withAuxiliaryPolicy = (options: AIOperationOptions): AIOperationOptions => ({
  ...options,
  ...(options.speedMode === 'fast'
    ? { maxAttempts: 2 }
    : { attemptTimeoutMs: Math.min(options.attemptTimeoutMs ?? 30_000, 30_000), maxAttempts: 1 }),
});

const diagnosticErrorCode = (error: unknown): string => {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  if (error instanceof AIJsonParseError) return error.code;
  if (error instanceof Error) return error.name || 'REQUEST_FAILED';
  return 'REQUEST_FAILED';
};

const emitDiagnostic = (
  options: AIOperationOptions,
  current: AIDiagnostic,
  phase: AIDiagnosticPhase,
  patch: Partial<AIDiagnostic> = {},
): AIDiagnostic => {
  const next = { ...current, ...patch, phase, updatedAt: Date.now() };
  options.onDiagnostic?.(next);
  return next;
};

// 👉 Trích khối JSON cân bằng (mảng/object) đầu tiên trong chuỗi, tôn trọng
// chuỗi con và ký tự escape. Trả về phần còn lại nếu chưa đóng ngoặc (để bước
// vá cắt cụt phía dưới xử lý tiếp).
const extractBalancedJSON = (str: string, open: '[' | '{', close: ']' | '}'): string | null => {
  const start = str.indexOf(open);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return str.substring(start, i + 1); }
  }
  return str.substring(start);
};

const sanitizeJSONString = (rawStr: string): string => {
  if (!rawStr) return "[]";
  let cleaned = rawStr.trim();

  // Bóc rào markdown ```json ... ``` (kể cả khi nằm sau lời dẫn).
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1].trim()) cleaned = fenceMatch[1].trim();

  // 👉 Một số model (đặc biệt Claude) hay chèn lời dẫn kiểu "I appreciate..."
  // trước JSON. Nếu parse trực tiếp không được, trích đúng khối JSON đầu tiên.
  let directOk = false;
  try { JSON.parse(cleaned); directOk = true; } catch (e) {}
  if (!directOk) {
    const firstArr = cleaned.indexOf('[');
    const firstObj = cleaned.indexOf('{');
    let candidate: string | null = null;
    if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) candidate = extractBalancedJSON(cleaned, '[', ']');
    else if (firstObj !== -1) candidate = extractBalancedJSON(cleaned, '{', '}');
    if (candidate) cleaned = candidate;
  }

  try { JSON.parse(cleaned); return cleaned; } catch (e) {
    if (cleaned.startsWith('[')) { const last = cleaned.lastIndexOf('}'); return last !== -1 ? cleaned.substring(0, last + 1) + ']' : "[]"; } 
    else if (cleaned.startsWith('{')) { const last = cleaned.lastIndexOf('}'); return last !== -1 ? cleaned.substring(0, last + 1) : "{}"; }
    return cleaned.replace(/[\u0000-\u001F]+/g, " ");
  }
};

export const updateUsageStats = (updates: { input?: number; output?: number; cached?: number; calls?: number; scripts?: number; prompts?: number }) => {
  const record = { timestamp: Date.now(), input: updates.input || 0, output: updates.output || 0, cached: updates.cached || 0, calls: updates.calls || 0, scripts: updates.scripts || 0, prompts: updates.prompts || 0 };
  try {
    let historyStr = localStorage.getItem('veo3_usage_history');
    let history: any[] = historyStr ? JSON.parse(historyStr) : [];
    history.push(record);
    if (history.length > 1000) history = history.slice(history.length - 1000);
    localStorage.setItem('veo3_usage_history', JSON.stringify(history));
  } catch (e) {}
};

const keyIndexes: Record<string, number> = {};

// 👉 Lấy nội dung text từ body của endpoint kiểu OpenAI — CHỊU ĐƯỢC CẢ 2 KIỂU:
//   (1) JSON thường:   { "choices":[{ "message":{ "content":"..." } }] }
//   (2) Streaming SSE: nhiều dòng  data: {"choices":[{"delta":{"content":"..."}}]}  ... data: [DONE]
// Nhiều endpoint/proxy trả SSE dù mình KHÔNG xin stream → trước đây response.json() vỡ ngay
// ("Unexpected token 'd', "data: {"id"..."). Hàm này gộp các mảnh delta lại thành text hoàn chỉnh.
export const extractOpenAIContent = (raw: string): string => {
  if (!raw) return "";
  const trimmed = raw.trimStart();
  // Kiểu 1: JSON đơn.
  if (trimmed[0] === '{') {
    try {
      const data = JSON.parse(raw);
      const c = data?.choices?.[0]?.message?.content;
      if (typeof c === 'string') return c;
    } catch (e) { /* rơi xuống thử SSE */ }
  }
  // Kiểu 2: SSE — gom content từ delta (hoặc message) của từng dòng "data:".
  if (raw.indexOf('data:') !== -1) {
    let content = '';
    for (const line of raw.split(/\r?\n/)) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      const payload = l.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        const ch = obj?.choices?.[0];
        const piece = ch?.delta?.content ?? ch?.message?.content;
        if (typeof piece === 'string') content += piece;
      } catch (e) { /* bỏ qua mảnh hỏng/không phải JSON */ }
    }
    if (content) return content;
  }
  // Cùng đường: trả nguyên văn để sanitizeJSONString/JSON.parse phía sau tự lo.
  return raw;
};

const validateProviderEndpoint = (providerConfig: ProviderConfig): void => {
  const endpointError = getProviderEndpointError(providerConfig);
  if (endpointError) throw new Error(`[LỖI CẤU HÌNH] ${providerConfig.name}: ${endpointError}`);
};

export const getOpenAIChatCompletionsUrl = (providerConfig: ProviderConfig): string =>
  `${(providerConfig.baseUrl || '').trim().replace(/\/+$/, '')}/chat/completions`;

const readProviderKeys = (providerConfig: ProviderConfig): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(`app1_${providerConfig.keyPrefix}_api_keys`) || '[]');
    return Array.isArray(parsed) ? normalizeApiKeys(parsed.filter((key): key is string => typeof key === 'string')) : [];
  } catch {
    return [];
  }
};

const executeGeminiAttempt = async <T>(
  contents: any,
  systemInstruction: string | undefined,
  schema: any,
  providerConfig: ProviderConfig,
  apiKey: string,
  temperature: number,
  signal: AbortSignal,
  timeoutMs: number,
  onDiagnostic?: (phase: AIDiagnosticPhase, patch?: Partial<AIDiagnostic>) => void,
): Promise<T> => {
  const thinkingPolicy = resolveThinkingPolicy(providerConfig);
  if (!thinkingPolicy.canRun) throw new ThinkingPolicyError(thinkingPolicy.message);
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { retryOptions: { attempts: 1 } },
  });
  const configData: any = {
    responseMimeType: 'application/json',
    maxOutputTokens: 8192,
    ...(thinkingPolicy.omitTemperature ? {} : { temperature }),
    ...thinkingPolicy.requestPatch,
    responseSchema: schema,
    abortSignal: signal,
    httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };
  if (systemInstruction) configData.systemInstruction = systemInstruction;
  onDiagnostic?.('waiting_headers');
  const response = await ai.models.generateContent({ model: providerConfig.model, contents, config: configData });
  if (response.usageMetadata) {
    updateUsageStats({
      input: response.usageMetadata.promptTokenCount,
      cached: response.usageMetadata.cachedContentTokenCount,
      output: response.usageMetadata.candidatesTokenCount,
      calls: 1,
    });
  }
  const text = response.text || '';
  onDiagnostic?.('parsing', {
    outputTokens: response.usageMetadata?.candidatesTokenCount,
    responseBytes: new TextEncoder().encode(text).byteLength,
    responsePreview: sanitizeResponsePreview(text),
  });
  const parsed = parseAIJsonResponse<T>(text);
  onDiagnostic?.('validating', { receivedItems: Array.isArray(parsed) ? parsed.length : undefined });
  return parsed;
};

const toOpenAIJsonSchema = (schema: any): any => {
  if (!schema || typeof schema !== 'object') return schema;
  const type = typeof schema.type === 'string' ? schema.type.toLowerCase() : undefined;
  const converted: Record<string, unknown> = {
    ...(type ? { type } : {}),
    ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
    ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
  };
  if (schema.properties && typeof schema.properties === 'object') {
    converted.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toOpenAIJsonSchema(value)]),
    );
  }
  if (schema.items) converted.items = toOpenAIJsonSchema(schema.items);
  return converted;
};

const openAIResponseFormat = (providerConfig: ProviderConfig, schema: any): Record<string, unknown> | undefined => {
  if (!schema || schema.type !== Type.OBJECT || !providerConfig.structuredOutput) return undefined;
  if (providerConfig.structuredOutput === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: 'automation_response',
        schema: toOpenAIJsonSchema(schema),
      },
    };
  }
  return { type: 'json_object' };
};

const buildOpenAIMessages = (contents: any, systemInstruction: string | undefined, schema: any): any[] => {
  let finalSystemInstruction = systemInstruction || 'You are a helpful assistant.';
  finalSystemInstruction += `\n\nCRITICAL DIRECTIVE: You MUST output STRICTLY valid JSON matching the exact requested structure. Do not include markdown formatting. Do NOT add a preamble, greeting, explanation, or commentary. Return only raw JSON data.`;
  if (schema) finalSystemInstruction += `\nEXPECTED JSON SCHEMA FORMAT:\n${JSON.stringify(toOpenAIJsonSchema(schema))}`;
  const messages: any[] = [{ role: 'system', content: finalSystemInstruction }];

  const pushParts = (parts: any[]) => {
    const textPart = parts.find((part: any) => part.text)?.text || '';
    const imagePart = parts.find((part: any) => part.inlineData);
    if (imagePart) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: textPart },
          { type: 'image_url', image_url: { url: `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}` } },
        ],
      });
    } else {
      messages.push({ role: 'user', content: textPart });
    }
  };

  if (typeof contents === 'string') messages.push({ role: 'user', content: contents });
  else if (Array.isArray(contents) && contents[0]?.parts) pushParts(contents[0].parts);
  else if (contents?.parts) pushParts(contents.parts);
  else throw new Error('UNSUPPORTED_VISION');
  return messages;
};

class AIResponseBodyError extends Error {
  readonly code: 'BODY_IDLE_TIMEOUT' | 'PROVIDER_STALLED_BODY' | 'PROVIDER_RESPONSE_ERROR' | 'REASONING_WITHOUT_CONTENT';

  constructor(code: 'BODY_IDLE_TIMEOUT' | 'PROVIDER_STALLED_BODY' | 'PROVIDER_RESPONSE_ERROR' | 'REASONING_WITHOUT_CONTENT', message: string) {
    super(message);
    this.name = 'AIResponseBodyError';
    this.code = code;
  }
}

export interface ResponseBodyReadOptions {
  idleTimeoutMs?: number;
  /** Abort a chunked body that keeps sending tiny heartbeats but no useful response. */
  lowProgressTimeoutMs?: number;
  minProgressBytes?: number;
  /** Upper bound for the entire body read, independent of heartbeats. */
  maxDurationMs?: number;
}

const normalizeResponseBodyReadOptions = (
  options: number | ResponseBodyReadOptions | undefined,
): Required<ResponseBodyReadOptions> => {
  if (typeof options === 'number') {
    return {
      idleTimeoutMs: options,
      lowProgressTimeoutMs: Number.POSITIVE_INFINITY,
      minProgressBytes: FAST_MIN_PROGRESS_BYTES,
      maxDurationMs: Number.POSITIVE_INFINITY,
    };
  }
  return {
    idleTimeoutMs: options?.idleTimeoutMs ?? RESPONSE_BODY_IDLE_TIMEOUT_MS,
    lowProgressTimeoutMs: options?.lowProgressTimeoutMs ?? Number.POSITIVE_INFINITY,
    minProgressBytes: options?.minProgressBytes ?? FAST_MIN_PROGRESS_BYTES,
    maxDurationMs: options?.maxDurationMs ?? Number.POSITIVE_INFINITY,
  };
};

export const readResponseBodyForDiagnostics = async (
  response: Response,
  onUpdate: (patch: Partial<AIDiagnostic>) => void,
  options?: number | ResponseBodyReadOptions,
): Promise<{ rawBody: string; bytes: number; chunkCount: number; firstByteMs?: number; bodyMs: number; lastChunkMs?: number }> => {
  const readOptions = normalizeResponseBodyReadOptions(options);
  const startedAt = Date.now();
  if (!response.body) {
    const rawBody = await response.text();
    const bytes = new TextEncoder().encode(rawBody).byteLength;
    const bodyMs = Date.now() - startedAt;
    return {
      rawBody,
      bytes,
      chunkCount: bytes > 0 ? 1 : 0,
      firstByteMs: bytes > 0 ? bodyMs : undefined,
      bodyMs,
      lastChunkMs: bytes > 0 ? bodyMs : undefined,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  let chunkCount = 0;
  let firstByteMs: number | undefined;
  let lastChunkMs: number | undefined;
  let sawDone = false;

  const waitForChunk = () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      callback();
    };
    const addTimeout = (delayMs: number, error: AIResponseBodyError) => {
      if (!Number.isFinite(delayMs)) return;
      if (delayMs <= 0) {
        finish(() => reject(error));
        return;
      }
      timers.push(setTimeout(() => finish(() => reject(error)), delayMs));
    };
    const elapsedMs = Date.now() - startedAt;
    const lowProgressRemainingMs = bytes < readOptions.minProgressBytes
      ? readOptions.lowProgressTimeoutMs - elapsedMs
      : Number.POSITIVE_INFINITY;
    const maxDurationRemainingMs = readOptions.maxDurationMs - elapsedMs;

    addTimeout(
      readOptions.idleTimeoutMs,
      bytes > 0 && bytes < readOptions.minProgressBytes
        ? new AIResponseBodyError(
          'PROVIDER_STALLED_BODY',
          `Server stopped after ${bytes} bytes before completing JSON. [PROVIDER_STALLED_BODY]`,
        )
        : new AIResponseBodyError(
          'BODY_IDLE_TIMEOUT',
          `Server stopped sending response data for ${Math.round(readOptions.idleTimeoutMs / 1_000)} seconds. [BODY_IDLE_TIMEOUT]`,
        ),
    );
    addTimeout(
      lowProgressRemainingMs,
      new AIResponseBodyError(
        'PROVIDER_STALLED_BODY',
        `Server returned only ${bytes} bytes in ${Math.round(readOptions.lowProgressTimeoutMs / 1_000)} seconds and did not complete JSON. [PROVIDER_STALLED_BODY]`,
      ),
    );
    addTimeout(
      maxDurationRemainingMs,
      new AIResponseBodyError(
        'PROVIDER_STALLED_BODY',
        `Server did not finish the response within ${Math.round(readOptions.maxDurationMs / 1_000)} seconds. [PROVIDER_STALLED_BODY]`,
      ),
    );
    reader.read().then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });

  try {
    while (true) {
      const result = await waitForChunk();
      if (result.done) break;
      if (firstByteMs === undefined) firstByteMs = Date.now() - startedAt;
      bytes += result.value.byteLength;
      chunkCount++;
      lastChunkMs = Date.now() - startedAt;
      const chunk = decoder.decode(result.value, { stream: true });
      sawDone ||= /(?:^|\n)\s*data:\s*\[DONE\]\s*(?:\n|$)/.test(`${chunks.join('')}${chunk}`);
      chunks.push(chunk);
      onUpdate({
        responseBytes: bytes,
        chunkCount,
        firstByteMs,
        bodyMs: Date.now() - startedAt,
        lastChunkMs,
        responsePreview: sanitizeResponsePreview(chunks.join(''), 200),
      });
      if (sawDone) {
        await reader.cancel();
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  chunks.push(decoder.decode());
  return {
    rawBody: chunks.join(''),
    bytes,
    chunkCount,
    firstByteMs,
    bodyMs: Date.now() - startedAt,
    lastChunkMs,
  };
};

const inspectOpenAIResponse = (rawBody: string) => {
  try {
    const parsed = JSON.parse(rawBody);
    const choice = parsed?.choices?.[0];
    const message = choice?.message;
    const usage = parsed?.usage;
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens;
    const outputTokens = usage?.completion_tokens ?? usage?.output_tokens;
    const reasoningContent = message?.reasoning_content ?? message?.reasoning;
    const providerError = parsed?.error?.message || (typeof parsed?.error === 'string' ? parsed.error : undefined);
    return {
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
      reasoningTokens: typeof reasoningTokens === 'number' ? reasoningTokens : undefined,
      outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
      reasoningContent: typeof reasoningContent === 'string' ? reasoningContent : undefined,
      providerError: typeof providerError === 'string' ? providerError : undefined,
    };
  } catch {
    return {};
  }
};

export const createOpenAIRequestPayload = (
  contents: any,
  systemInstruction: string | undefined,
  schema: any,
  providerConfig: ProviderConfig,
  temperature: number,
  fastCompatible: boolean,
): Record<string, unknown> => {
  const thinkingPolicy = resolveThinkingPolicy(providerConfig);
  if (!thinkingPolicy.canRun) throw new ThinkingPolicyError(thinkingPolicy.message);
  return {
    model: providerConfig.model,
    messages: buildOpenAIMessages(contents, systemInstruction, schema),
    ...(thinkingPolicy.omitTemperature ? {} : { temperature }),
    // Some compatibility gateways stream by default unless this is explicit.
    stream: false,
    ...thinkingPolicy.requestPatch,
    ...(fastCompatible ? {} : {
      max_tokens: 8192,
      ...(openAIResponseFormat(providerConfig, schema) ? { response_format: openAIResponseFormat(providerConfig, schema) } : {}),
    }),
  };
};

const executeOpenAIAttempt = async <T>(
  contents: any,
  systemInstruction: string | undefined,
  schema: any,
  providerConfig: ProviderConfig,
  apiKey: string,
  temperature: number,
  signal: AbortSignal,
  fastCompatible = false,
  onDiagnostic?: (phase: AIDiagnosticPhase, patch?: Partial<AIDiagnostic>) => void,
): Promise<T> => {
  const targetUrl = getOpenAIChatCompletionsUrl(providerConfig);
  onDiagnostic?.('waiting_headers');
  const sendRequest = () => fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(createOpenAIRequestPayload(
      contents,
      systemInstruction,
      schema,
      providerConfig,
      temperature,
      fastCompatible,
    )),
    signal,
  });
  const response = await sendRequest();
  onDiagnostic?.('waiting_headers', {
    status: response.status,
    contentType: response.headers.get('content-type') || undefined,
  });

  if (!response.ok) {
    const textBody = await response.text();
    let details = textBody.slice(0, 4000);
    try {
      const parsed = JSON.parse(textBody);
      details = parsed?.error?.message || JSON.stringify(parsed).slice(0, 4000);
    } catch { /* keep bounded plain-text body */ }
    throw new AIHttpError(response.status, `Server từ chối (HTTP ${response.status}): ${details}`, {
      details,
      providerId: providerConfig.id,
      retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
    });
  }

  onDiagnostic?.('reading_body', {
    status: response.status,
    contentType: response.headers.get('content-type') || undefined,
  });
  const body = await readResponseBodyForDiagnostics(
    response,
    (patch) => onDiagnostic?.('reading_body', patch),
    fastCompatible
      ? {
        idleTimeoutMs: RESPONSE_BODY_IDLE_TIMEOUT_MS,
        lowProgressTimeoutMs: FAST_LOW_PROGRESS_TIMEOUT_MS,
        minProgressBytes: FAST_MIN_PROGRESS_BYTES,
        maxDurationMs: FAST_REQUEST_TIMEOUT_MS,
      }
      : undefined,
  );
  const rawBody = body.rawBody;
  const details = inspectOpenAIResponse(rawBody);
  onDiagnostic?.('parsing', {
    responseBytes: body.bytes,
    chunkCount: body.chunkCount,
    firstByteMs: body.firstByteMs,
    bodyMs: body.bodyMs,
    lastChunkMs: body.lastChunkMs,
    finishReason: details.finishReason,
    reasoningTokens: details.reasoningTokens,
    outputTokens: details.outputTokens,
    responsePreview: sanitizeResponsePreview(rawBody),
  });
  if (details.providerError) {
    throw new AIResponseBodyError('PROVIDER_RESPONSE_ERROR', `Máy chủ trả lỗi trong HTTP 200: ${details.providerError} [PROVIDER_RESPONSE_ERROR]`);
  }
  const text = extractOpenAIContent(rawBody);
  if (!text.trim() && details.reasoningContent) {
    throw new AIResponseBodyError('REASONING_WITHOUT_CONTENT', 'Model chỉ trả reasoning mà không có nội dung kết quả. [REASONING_WITHOUT_CONTENT]');
  }
  let parsed = fastCompatible ? parseFastCompatibleAIJsonResponse(text) : parseAIJsonResponse(text);
  if (schema && schema.type === Type.ARRAY && !Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null) {
    const arrayValues = Object.values(parsed).find((value) => Array.isArray(value));
    parsed = arrayValues || [];
  }
  onDiagnostic?.('validating', { receivedItems: Array.isArray(parsed) ? parsed.length : undefined });
  return parsed as T;
};

const callAISafe = async <T>(
  contents: any,
  systemInstruction: string | undefined,
  schema: any,
  temperature = 0.5,
  lane: AILane = 'scene',
  forcedProviderId?: string,
  operationOptions?: AIOperationOptions,
): Promise<T> => {
  const options = normalizeOperationOptions(operationOptions, DEFAULT_CALL_TIMEOUT_MS);
  if (lane === 'planner') {
    return PLANNER_LIMITER.run(
      () => callAISafe<T>(contents, systemInstruction, schema, temperature, 'prompt', forcedProviderId, options),
      { signal: options.signal, deadlineAt: options.deadlineAt },
    );
  }
  const providerId = forcedProviderId || options.providerId!;
  const sourceProvider = AI_PROVIDERS[providerId];
  if (!sourceProvider) throw new Error(`[LỖI CẤU HÌNH] Không tìm thấy Model ID '${providerId}'. Vui lòng chọn lại AI.`);
  const providerConfig: ProviderConfig = { ...sourceProvider };
  validateProviderEndpoint(providerConfig);
  const thinkingPolicy = resolveThinkingPolicy(providerConfig);
  const startedAt = Date.now();
  let diagnostic: AIDiagnostic = {
    requestId: createDiagnosticId(),
    phase: 'queued',
    startedAt,
    updatedAt: startedAt,
    providerName: providerConfig.name,
    model: providerConfig.model,
    endpoint: providerConfig.type === 'openai-compatible'
      ? getOpenAIChatCompletionsUrl(providerConfig)
      : 'Google Gemini API',
    thinkingProfile: thinkingPolicy.profile,
    thinkingStatus: thinkingPolicy.status,
  };
  diagnostic = emitDiagnostic(options, diagnostic, 'queued');
  if (!thinkingPolicy.canRun) {
    const error = new ThinkingPolicyError(thinkingPolicy.message);
    diagnostic = emitDiagnostic(options, diagnostic, 'failed', {
      errorCode: error.code,
      errorMessage: thinkingPolicy.message,
    });
    throw error;
  }

  const keys = readProviderKeys(providerConfig);
  if (keys.length === 0) {
    throw new Error(`[LỖI CẤU HÌNH] BẠN CHƯA CÓ API KEY CHO MODEL: ${providerConfig.name.toUpperCase()}`);
  }
  const fixedKeySlot = options.keySlot === undefined ? undefined : Math.min(Math.max(0, options.keySlot), keys.length - 1);
  const startIndex = fixedKeySlot ?? Math.min(keyIndexes[providerConfig.id] || 0, keys.length - 1);
  // Fast keeps round-robin behavior. Ultra pins the entire operation to one key.
  if (fixedKeySlot === undefined) keyIndexes[providerConfig.id] = (startIndex + 1) % keys.length;
  let keyPool = createKeyPoolState(fixedKeySlot === undefined ? keys : [keys[startIndex]], startIndex);
  const workflowDeadline = options.deadlineAt ?? deadlineAfter(DEFAULT_CALL_TIMEOUT_MS);
  const fastCompatible = options.speedMode === 'fast';
  const attemptTimeoutMs = fastCompatible
    ? Math.max(1, Math.min(FAST_REQUEST_TIMEOUT_MS, remainingDeadlineMs(workflowDeadline)))
    : Math.min(options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS, DEFAULT_CALL_TIMEOUT_MS);
  const limiter = AI_LIMITER;

  // Queue time is governed by the workflow deadline, not the per-attempt clock.
  // FIFO admission keeps provider requests bounded and cancellable.
  const runRequest = () => limiter.run(async () => {
    if (options.speedMode === 'ultra' || options.speedMode === 'ultra-max') await waitForUltraStartStagger(options.signal);
    await waitForRequestPace(options.signal);
    try {
      const callDeadline = fastCompatible
        ? Math.min(workflowDeadline, deadlineAfter(FAST_REQUEST_TIMEOUT_MS))
        : Math.min(workflowDeadline, deadlineAfter(DEFAULT_CALL_TIMEOUT_MS));
      return await runWithRetry<T>(async ({ attempt, signal, maxAttempts }) => {
        const selected = selectNextKey(keyPool);
        keyPool = selected.state;
        if (!selected.selection) throw new Error(`[LỖI CẤU HÌNH] Không còn API key khả dụng cho ${providerConfig.name}.`);
        const selection = selected.selection;
        diagnostic = emitDiagnostic(options, diagnostic, 'connecting', { attempt, maxAttempts });
        options.onProgress?.(`Đang gọi ${providerConfig.name} (lượt ${attempt}/${maxAttempts})...`);

        options.onRequestActivity?.(1);
        try {
          const transportTimeout = Math.max(1, Math.min(attemptTimeoutMs, remainingDeadlineMs(callDeadline)));
          const result = providerConfig.type === 'gemini'
            ? executeGeminiAttempt<T>(contents, systemInstruction, schema, providerConfig, selection.key, temperature, signal, transportTimeout,
              (phase, patch) => { diagnostic = emitDiagnostic(options, diagnostic, phase, patch); })
            : executeOpenAIAttempt<T>(contents, systemInstruction, schema, providerConfig, selection.key, temperature, signal, fastCompatible,
              (phase, patch) => { diagnostic = emitDiagnostic(options, diagnostic, phase, patch); });
          const resolved = await result;
          diagnostic = emitDiagnostic(options, diagnostic, 'completed');
          return resolved;
        } catch (error) {
          const classification = classifyAIError(error);
          const isParallelMode = options.speedMode === 'ultra' || options.speedMode === 'ultra-max';
          const isProviderBackpressure = classification.kind === 'rate-limit' || classification.kind === 'quota';
          if (isParallelMode && (isProviderBackpressure || classification.kind === 'server' || classification.kind === 'timeout')) {
            options.onConcurrencyDowngrade?.(classification.kind);
          }
          if (isProviderBackpressure) {
            nextRequestAt = Math.max(nextRequestAt, Date.now() + Math.max(5_000, classification.retryAfterMs || 0));
          }
          keyPool = updateKeyState(keyPool, selection.index, classification.keyAction, {
            cooldownMs: classification.retryAfterMs || 0,
          });
          if (classification.keyAction === 'keep') keyPool = { ...keyPool, cursor: selection.index };
          throw error;
        } finally {
          options.onRequestActivity?.(-1);
        }
      }, {
        signal: options.signal,
        deadlineAt: callDeadline,
        attemptTimeoutMs,
        maxAttempts: options.maxAttempts,
        shouldRetry: (classification) => {
          if (fixedKeySlot !== undefined && (classification.kind === 'rate-limit' || classification.kind === 'quota')) return false;
          if (classification.retryable) return true;
          if (classification.keyAction !== 'disable' && classification.keyAction !== 'cooldown') return false;
          return keyPool.entries.some((entry) => entry.state === 'ready');
        },
        onRetry: (classification, _error, context) => {
          diagnostic = emitDiagnostic(options, diagnostic, 'retry_backoff', {
            attempt: context.attempt,
            maxAttempts: context.maxAttempts,
            errorCode: classification.kind,
            errorMessage: sanitizeDiagnosticText(_error instanceof Error ? _error.message : String(_error)),
          });
          options.onProgress?.(`${providerConfig.name} lỗi ${classification.kind}; thử lại lần ${context.attempt + 1}/${context.maxAttempts}...`);
        },
      });
    } catch (error) {
      diagnostic = emitDiagnostic(options, diagnostic, 'failed', {
        errorCode: diagnosticErrorCode(error),
        errorMessage: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
        status: error instanceof AIHttpError ? error.status : diagnostic.status,
      });
      throw error;
    } finally {
      nextRequestAt = Math.max(nextRequestAt, Date.now() + CONFIG.REQUEST_GAP_MS);
    }
  }, { signal: options.signal, deadlineAt: workflowDeadline });

  return options.requestLimiter
    ? options.requestLimiter.run(runRequest, { signal: options.signal, deadlineAt: workflowDeadline })
    : runRequest();
};

// ============================================================================
// 👉 CẮT & GHÉP CẢNH TỐI ƯU CHO AUTO-SYNC GIỌNG ĐỌC (đếm theo SỐ KÝ TỰ)
// Nguyên tắc: ranh giới cảnh LUÔN là biên câu thật (. ! ? … + xuống dòng) — nơi
// giọng đọc có ngắt. KHÔNG BAO GIỜ cắt giữa câu / giữa từ / giữa tên / giữa số.
// Ghép các câu liền nhau thành cảnh bằng QUY HOẠCH ĐỘNG: tối thiểu tổng "độ xấu"
// → không cảnh nào ngắn quá / dài quá, ưu tiên vùng đẹp, tự tránh câu lẻ loi,
// ưu tiên ghép tiến. Câu đơn > MAX_CHARS mới chia mềm tại DẤU CÂU thật.
// ============================================================================
// 👉 4 hằng số dễ chỉnh theo ý bạn (đơn vị: ký tự):
const MIN_CHARS = 20;      // sàn — dưới mức này bị phạt nặng (gần như cấm)
const MAX_CHARS = 150;     // trần cứng — nhóm nhiều câu không được vượt
const IDEAL_LO = 50;       // vùng ĐẸP: từ IDEAL_LO
const IDEAL_HI = 100;      //           đến IDEAL_HI → độ xấu = 0
const SOFT_TARGET = Math.round((IDEAL_LO + IDEAL_HI) / 2); // đích khi buộc chia câu >150

const SENT_DOT = String.fromCharCode(1);               // sentinel che '.' không phải hết câu
const SENT_COMMA = String.fromCharCode(2);             // sentinel che ',' trong số
const SENT_BND = String.fromCharCode(0);               // đánh dấu biên câu

// Viết tắt tiếng Việt hay gặp (không kèm dấu chấm, đã thường hóa).
const VI_ABBREV = ['tp','tt','tx','ts','ths','gs','pgs','bs','ks','kts','cn','nxb','tr','vd','tk','st','ncs','ttx','đ','q','p','f'];

// BƯỚC 1: che dấu chấm/phẩy KHÔNG phải kết thúc câu để chúng không kích hoạt cắt.
const protectFalseBoundaries = (s: string): string => {
  // (a) dấu '.'/',' nằm giữa hai chữ số: 1.000.000 · 3,5 · 2.9.1945
  s = s.replace(/(?<=\d)\.(?=\d)/g, SENT_DOT).replace(/(?<=\d),(?=\d)/g, SENT_COMMA);
  // (b) 'v.v.' — che cả hai dấu chấm
  s = s.replace(/(?<!\p{L})v\.v\./giu, m => m.replace(/\./g, SENT_DOT));
  // (c) viết tắt trong danh sách (Tp. Nxb. GS. TS. ...)
  const abbrRe = new RegExp('(?<!\\p{L})(?:' + VI_ABBREV.join('|') + ')\\.', 'giu');
  s = s.replace(abbrRe, m => m.replace(/\./g, SENT_DOT));
  // (d) chữ cái đầu tên: 1 chữ HOA + '.'  (V. A. Đ.)
  s = s.replace(/(?<!\p{L})\p{Lu}\./gu, m => m.replace('.', SENT_DOT));
  return s;
};
const restoreProtected = (s: string): string => s.split(SENT_DOT).join('.').split(SENT_COMMA).join(',');

// BƯỚC 3: tách một đoạn (đã che, đã gộp khoảng trắng) thành các câu thật.
// Nuốt dấu đóng ngoặc kép/ngoặc sau dấu kết thúc: '...tự do." Cả dân tộc...'
const splitIntoSentences = (para: string): string[] => {
  const marked = para.replace(/([.!?…]+[”’"')\]»]*)(?=\s)/gu, '$1' + SENT_BND);
  return marked.split(SENT_BND).map(x => x.trim()).filter(Boolean);
};

// BƯỚC 7: biên câu mà vế trái kết thúc bằng acronym/chữ cái đầu/chữ số → chưa an toàn, gộp về sau.
const endsUnsafe = (leftText: string): boolean => {
  const toks = leftText.trim().split(/\s+/);
  const last = (toks[toks.length - 1] || '').replace(/[”’"')\]».,!?…]+$/u, '');
  if (/\d$/.test(last)) return true;                   // kết thúc bằng chữ số
  if (/^\p{Lu}$/u.test(last)) return true;             // 1 chữ hoa (initial)
  if (/^\p{Lu}{2,4}$/u.test(last)) return true;        // acronym ngắn viết hoa (KTS, TP...)
  return false;
};

// BƯỚC 6: chia MỀM một câu quá dài (> MAX_CHARS) — CHỈ tại dấu câu thật, KHÔNG dùng
// liên từ. Đo bằng SỐ KÝ TỰ: mỗi mảnh ≤ MAX_CHARS, ưu tiên điểm cắt gần SOFT_TARGET.
const softSplitLongSentence = (sentence: string): string[] => {
  const tokens = sentence.split(/\s+/);
  const pieces: string[] = [];
  let start = 0;
  while (start < tokens.length) {
    const remLen = tokens.slice(start).join(' ').length;
    if (remLen <= MAX_CHARS) { pieces.push(tokens.slice(start).join(' ')); break; }
    let bestCut = -1, bestScore = -Infinity, cum = 0;
    for (let i = start; i < tokens.length - 1; i++) {
      cum += (i > start ? 1 : 0) + tokens[i].length;    // +1 cho khoảng trắng
      if (cum > MAX_CHARS) break;
      const tok = tokens[i];
      let priority = 0;
      if (/[;:]$/.test(tok)) priority = 3;
      else if (/[—–]$/.test(tok)) {                     // gạch dài: né dải số '1930 – 1945'
        const prevNum = /\d/.test(tokens[i].replace(/[—–]$/, '')) || /\d$/.test(tokens[i - 1] || '');
        const nextNum = /^\d/.test(tokens[i + 1] || '');
        if (!(prevNum && nextNum)) priority = 3;
      } else if (/,$/.test(tok)) priority = 2;          // phẩy thật (phẩy trong số đã bị che)
      if (priority > 0) {
        const score = -Math.abs(cum - SOFT_TARGET) + priority * 0.001;
        if (score > bestScore) { bestScore = score; bestCut = i + 1; }
      }
    }
    if (bestCut === -1) { pieces.push(tokens.slice(start).join(' ')); break; } // không có điểm an toàn → giữ nguyên
    pieces.push(tokens.slice(start, bestCut).join(' '));
    start = bestCut;
  }
  return pieces;
};

// Độ "xấu" của một cảnh dài L ký tự (càng nhỏ càng đẹp) — dùng cho DP ghép cảnh.
const sceneBadness = (L: number): number => {
  let c = 0;
  if (L < IDEAL_LO) c += (IDEAL_LO - L) ** 2;          // ngắn hơn vùng đẹp
  else if (L > IDEAL_HI) c += (L - IDEAL_HI) ** 2;     // dài hơn vùng đẹp
  if (L < MIN_CHARS) c += 100000;                      // dưới sàn → phạt nặng
  if (L > MAX_CHARS) c += 100000 + (L - MAX_CHARS) ** 2; // quá trần (chỉ với câu đơn buộc phải)
  return c;
};

// Ghép các "đơn vị" (câu trọn vẹn) liền nhau thành cảnh, tối thiểu TỔNG độ xấu (DP).
// Nhìn xa toàn cục → tự ưu tiên vùng đẹp, tránh câu lẻ, ưu tiên ghép tiến.
const packScenesOptimally = (units: string[]): string[] => {
  const n = units.length;
  if (n === 0) return [];
  const dp: number[] = new Array(n + 1).fill(Infinity);
  const nextIdx: number[] = new Array(n + 1).fill(-1);
  dp[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    let acc = '';
    for (let j = i; j < n; j++) {
      acc = acc ? acc + ' ' + units[j] : units[j];
      const L = acc.length;
      if (j > i && L > MAX_CHARS) break;               // gộp thêm là vượt trần → dừng
      const c = sceneBadness(L) + dp[j + 1];
      if (c < dp[i]) { dp[i] = c; nextIdx[i] = j + 1; } // strict '<' → hòa thì chọn nhóm ít câu hơn
    }
  }
  const scenes: string[] = [];
  let i = 0;
  while (i < n && nextIdx[i] !== -1) { scenes.push(units.slice(i, nextIdx[i]).join(' ')); i = nextIdx[i]; }
  return scenes;
};

// logic='default' → cho phép chia mềm câu dài tại dấu câu.
// logic='sentence' → không bao giờ chia câu (câu dài giữ nguyên thành 1 cảnh).
const splitScriptByCode = (text: string, logic: string = 'default'): string[] => {
  const allowSoftSplit = logic !== 'sentence';

  const prot = protectFalseBoundaries(text);
  const paragraphs = prot.split(/\n+/);                 // BƯỚC 2: xuống dòng = biên cứng
  const sentences: string[] = [];
  for (const para of paragraphs) {
    const clean = para.replace(/[^\S\n]+/g, ' ').trim();
    if (!clean) continue;
    for (const s of splitIntoSentences(clean)) sentences.push(s);
  }

  // BƯỚC 7: gộp câu mà vế trước kết thúc "không an toàn" (viết tắt lạ / số / initial).
  const safeSentences: string[] = [];
  for (const s of sentences) {
    if (safeSentences.length && endsUnsafe(safeSentences[safeSentences.length - 1])) safeSentences[safeSentences.length - 1] += ' ' + s;
    else safeSentences.push(s);
  }

  // BƯỚC 5a: dựng "đơn vị" ghép — mỗi câu là 1 đơn vị; câu đơn > MAX_CHARS thì chia
  // mềm trước tại DẤU CÂU thật thành nhiều mảnh (mỗi mảnh là 1 đơn vị).
  const units: string[] = [];
  for (const s of safeSentences) {
    if (allowSoftSplit && s.length > MAX_CHARS) {
      for (const p of softSplitLongSentence(s)) units.push(p);
    } else {
      units.push(s);
    }
  }

  // BƯỚC 5b: ghép các đơn vị liền nhau thành cảnh TỐI ƯU bằng quy hoạch động.
  const chunks = packScenesOptimally(units);

  return chunks.map(restoreProtected).filter(c => c.replace(/[^a-zA-Z0-9À-ỹ]/g, '').length > 0);
};

const SCENE_SCHEMA = { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { id: { type: Type.INTEGER }, visualDescription: { type: Type.STRING }, characterDetails: { type: Type.STRING }, settingTime: { type: Type.STRING }, duration: { type: Type.STRING, enum: ["8s"] } }, required: ["id", "visualDescription", "characterDetails", "settingTime", "duration"] } };
const PROMPT_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      sceneId: { type: Type.INTEGER, description: "Matches the input scene id." },
      camera_angle: { type: Type.STRING, description: "SHORT, 1-3 words. Neutral only: eye-level / slight low-angle / slight high-angle / straight-on." },
      shot_size: { type: Type.STRING, description: "SHORT, 1-3 words. Vary it across scenes: establishing / wide / medium-wide / medium / close-up / extreme close-up / cutaway. Close-ups and extreme close-ups are fine on OBJECTS or still details; keep PEOPLE at medium/wide and never tight on moving hands or faces." },
      camera_movement: { type: Type.STRING, description: "SHORT, 1-3 words. Exactly ONE gentle move OR static: static / slow push-in / slow pull-back / slow pan / gentle drift / slow tilt." },
      setting: { type: Type.STRING, description: "SHORT, the place only, ≤12 words. e.g. '1950s radio studio, warm lamplight'." },
      time: { type: Type.STRING, description: "SHORT, era + time of day, ≤6 words. e.g. '1950s, evening' or 'modern day, morning'." },
      character: { type: Type.STRING, description: "SHORT. Who is on screen: each person's CANONICAL_NAME + ethnicity + era-appropriate clothing (copy the VERBATIM_BLOCK exactly when the dictionary gives one). Use empty string \"\" when the scene has NO people." },
      action: { type: Type.STRING, description: "THE MAIN FIELD — put MOST of your detail here (~40-70 words). Describe ONE single, natural, graceful, SIMPLE action unfolding smoothly across 8 seconds: body posture, pace, gaze, and the gentle motion around it. Keep it ERROR-FREE: one continuous whole-body action at a calm pace; objects stay whole (never cut, peel, break, or open them); no fast, intricate, or multi-step motion; no second action. If there are NO people, describe the object/place kept alive by gentle environmental motion (wind, steam, ripples, drifting light)." },
      style: { type: Type.STRING, description: "SHORT visual style + color mood. MUST end exactly with: 'Rendered in the style of <styleSummary>.' Never use film-medium words (film grain, shot on film, 35mm film, archival)." },
      _subjects: { type: Type.STRING, description: "Comma-separated list of every CANONICAL_NAME present in this scene. Internal validation only." }
    },
    required: ["sceneId", "camera_angle", "shot_size", "camera_movement", "setting", "time", "character", "action", "style"]
  }
};

// ============================================================================
// 👉 THÀNH TỐ PROMPT TÙY CHỈNH (popup cài đặt): người dùng tick chọn thành tố nào
// vào prompt, thêm thành tố riêng, và đặt trần độ dài. Lưu trên máy (localStorage).
// - mode 'ai'    → bơm vào SCHEMA + system instruction để AI viết theo từng cảnh.
// - mode 'fixed' → giá trị cố định, code tự gắn vào JSON cuối (không tốn AI, không sai).
// ============================================================================
export const DEFAULT_PROMPT_ELEMENTS: PromptElement[] = [
  // 8 thành tố GỐC (đúng như app đang chạy) — mặc định BẬT.
  { key: 'camera_angle', label: 'Góc máy', mode: 'ai', enabled: true, core: true, builtin: true },
  { key: 'shot_size', label: 'Cỡ cảnh', mode: 'ai', enabled: true, core: true, builtin: true },
  { key: 'camera_movement', label: 'Chuyển động máy', mode: 'ai', enabled: true, core: true, builtin: true },
  { key: 'setting', label: 'Bối cảnh', mode: 'ai', enabled: true, core: true, builtin: true },
  { key: 'time', label: 'Thời điểm', mode: 'ai', enabled: true, core: true, builtin: true },
  { key: 'character', label: 'Nhân vật', mode: 'ai', enabled: true, core: true, builtin: true },
  { key: 'action', label: 'Hành động (bắt buộc)', mode: 'ai', enabled: true, core: true, builtin: true, locked: true },
  { key: 'style', label: 'Phong cách', mode: 'ai', enabled: true, core: true, builtin: true },
  // Thành tố MỞ RỘNG — mặc định TẮT, khách tick tuỳ ý.
  { key: 'aspect_ratio', label: 'Tỷ lệ khung hình', mode: 'fixed', enabled: false, builtin: true, value: '16:9' },
  { key: 'no_logo', label: 'Không logo / nhãn hiệu', mode: 'fixed', enabled: false, builtin: true, value: 'no logos, no brand names, no watermarks' },
  { key: 'no_text', label: 'Không chữ trên hình', mode: 'fixed', enabled: false, builtin: true, value: 'no on-screen text, no captions, no subtitles' },
  { key: 'lighting', label: 'Ánh sáng', mode: 'ai', enabled: false, builtin: true, instruction: 'SHORT (≤10 words): light direction, quality, color temperature. e.g. "soft window daylight, warm, low contrast". Never quality jargon.' },
  { key: 'weather', label: 'Thời tiết / không khí', mode: 'ai', enabled: false, builtin: true, instruction: 'SHORT (≤8 words): weather or air in the scene. e.g. "light morning mist drifting".' },
  { key: 'mood', label: 'Cảm xúc chủ đạo', mode: 'ai', enabled: false, builtin: true, instruction: 'ONE or TWO words only. e.g. "solemn" or "quiet hope".' },
  { key: 'color_palette', label: 'Bảng màu', mode: 'ai', enabled: false, builtin: true, instruction: 'SHORT (3-5 words): dominant colors of the frame. e.g. "amber, walnut brown, deep shadow".' },
  { key: 'sound', label: 'Âm thanh nền', mode: 'ai', enabled: false, builtin: true, instruction: 'SHORT (≤10 words): ambient sound only, no dialogue, no music. e.g. "low room tone, distant birdsong".' },
  { key: 'lens', label: 'Ống kính / DOF', mode: 'ai', enabled: false, builtin: true, instruction: 'SHORT: lens + depth of field. e.g. "35mm, shallow depth of field".' },
];

const ELEMENTS_LS_KEY = 'app1_prompt_elements';
const MAXCHARS_LS_KEY = 'app1_prompt_max_chars';

// Ghép catalog mặc định với lựa chọn đã lưu: builtin lấy trạng thái tick + value/instruction
// người dùng chỉnh; thành tố tự thêm nối vào cuối. App thêm builtin mới vẫn hiện đủ.
export const loadPromptElements = (): PromptElement[] => {
  const defaults = DEFAULT_PROMPT_ELEMENTS.map(e => ({ ...e }));
  try {
    if (typeof localStorage === 'undefined') return defaults;
    const savedStr = localStorage.getItem(ELEMENTS_LS_KEY);
    if (!savedStr) return defaults;
    const saved: PromptElement[] = JSON.parse(savedStr);
    if (!Array.isArray(saved)) return defaults;
    const savedByKey = new Map(saved.filter(s => s && s.key).map(s => [s.key, s]));
    const merged = defaults.map(def => {
      const s = savedByKey.get(def.key);
      if (!s) return def;
      return {
        ...def,
        enabled: def.locked ? true : !!s.enabled,
        value: typeof s.value === 'string' ? s.value : def.value,
        instruction: typeof s.instruction === 'string' && !def.core ? s.instruction : def.instruction,
      };
    });
    for (const s of saved) {
      if (!s || !s.key || defaults.some(d => d.key === s.key)) continue;
      merged.push({ key: s.key, label: s.label || s.key, mode: s.mode === 'fixed' ? 'fixed' : 'ai', enabled: !!s.enabled, value: s.value, instruction: s.instruction, builtin: false });
    }
    return merged;
  } catch { return defaults; }
};
export const savePromptElements = (els: PromptElement[]) => {
  try { localStorage.setItem(ELEMENTS_LS_KEY, JSON.stringify(els)); } catch { /* private mode */ }
};
export const loadMaxPromptChars = (): number => {
  try { const v = parseInt(localStorage.getItem(MAXCHARS_LS_KEY) || '0', 10); return Number.isFinite(v) && v > 0 ? v : 0; } catch { return 0; }
};
export const saveMaxPromptChars = (n: number) => {
  try { localStorage.setItem(MAXCHARS_LS_KEY, String(Math.max(0, Math.floor(n) || 0))); } catch { /* private mode */ }
};

// Trần độ dài (đếm theo JSON 1 dòng thực xuất): cắt 'action' rồi 'setting' theo RANH GIỚI
// CÂU từ cuối lên (giữ tối thiểu 1 câu) — không bao giờ cắt cụt giữa câu, không đụng
// 'character' (giữ khối VERBATIM cho validator tên).
const enforceMaxChars = (obj: Record<string, string>, maxChars: number) => {
  if (!maxChars || maxChars <= 0) return;
  const len = () => JSON.stringify(obj).length;
  for (const key of ['action', 'setting']) {
    while (len() > maxChars) {
      const s = obj[key] || '';
      const sentences = s.match(/[^.!?]+[.!?]+["'”’]?\s*/g);
      if (!sentences || sentences.length <= 1) break;
      obj[key] = sentences.slice(0, -1).join('').trim();
    }
    if (len() <= maxChars) return;
  }
};

// Cảnh mẫu để popup XEM TRƯỚC theo đúng thành tố đang tick + trần độ dài.
const SAMPLE_PI: Record<string, string> = {
  camera_angle: 'eye-level',
  shot_size: 'medium shot',
  camera_movement: 'slow push-in',
  setting: '1950s radio studio, warm lamplight',
  time: '1950s, evening',
  character: 'A Nam (middle-aged Guatemalan man, short dark hair, medium build, charcoal suit)',
  action: 'He leans toward the vintage microphone and speaks steadily, one hand resting on the desk, shoulders relaxed. Warm lamplight falls across his calm face as dust drifts slowly through the beam. The heavy curtains hang still behind him.',
  style: 'warm documentary tones. Rendered in the style of authentic documentary realism, natural lighting, true-to-life color.',
  lighting: 'soft warm key from desk lamp, low contrast',
  weather: 'still indoor air, faint dust haze',
  mood: 'solemn',
  color_palette: 'amber, walnut brown, deep shadow',
  sound: 'low room tone, soft tube hum',
  lens: '35mm, shallow depth of field',
};
export const buildSamplePrompt = (els: PromptElement[], maxChars: number): { pretty: string; chars: number } => {
  const obj: Record<string, string> = {};
  for (const e of els) {
    if (!e.enabled) continue;
    if (e.mode === 'fixed') { obj[e.key] = (e.value || '').trim(); continue; }
    obj[e.key] = SAMPLE_PI[e.key] ?? '(AI sẽ tự viết nội dung này theo từng cảnh)';
  }
  enforceMaxChars(obj, maxChars);
  return { pretty: JSON.stringify(obj, null, 2), chars: JSON.stringify(obj).length };
};

// Schema động theo thành tố đang bật: core giữ mô tả gốc trong PROMPT_SCHEMA, thành tố
// AI thêm dùng instruction của nó. Thành tố 'fixed' KHÔNG vào schema (code tự gắn).
const buildPromptSchema = (els: PromptElement[]) => {
  const coreProps: any = (PROMPT_SCHEMA as any).items.properties;
  const props: any = { sceneId: coreProps.sceneId };
  const required: string[] = ['sceneId'];
  for (const e of els) {
    if (!e.enabled || e.mode !== 'ai') continue;
    props[e.key] = coreProps[e.key] ? coreProps[e.key] : { type: Type.STRING, description: (e.instruction || e.label || e.key) + ' Keep it SHORT.' };
    if (e.core && e.key !== 'character') required.push(e.key);
  }
  if (props.character) { /* character bật thì vẫn required như cũ */ required.push('character'); }
  props._subjects = coreProps._subjects;
  return { type: Type.ARRAY, items: { type: Type.OBJECT, properties: props, required } };
};

// 👉 TỪ VỰNG STOCK-SAFE: cố tình tiết chế. Ưu tiên medium/wide + camera tĩnh (tối đa
// 1 push-in/pull-back chậm) để tránh artifact. KHÔNG còn ECU/close-up bàn tay, KHÔNG
// còn orbit/crane/whip pan/handheld — đây là các nguồn gây lỗi thừa chi, méo tay, morph.
const CINEMATOGRAPHY_GLOSSARY = `=== STOCK-SAFE VISUAL GLOSSARY (pick vocabulary ONLY from these lists) ===
SHOT_SIZES (prefer the safe ones — Medium/Wide): Wide Shot (WS), Medium Long Shot (MLS), Medium Shot (MS), Long Shot (LS), Extreme Long Shot (ELS), establishing shot. AVOID close framing on people; NEVER frame tight on hands.
ANGLES (keep neutral): eye-level, slight low-angle, slight high-angle, straight-on / frontal, three-quarter front. AVOID Dutch tilt, worm's-eye, extreme overhead.
LENSES: 24mm wide, 35mm normal, 50mm standard. (Long tele / macro / fisheye NOT used — they exaggerate distortion.)
DOF: moderate depth of field, deep focus. (No rack focus, no split focus.)
CAMERA_MOTION (choose exactly ONE gentle move per shot): slow push-in, slow pull-back, slow pan left, slow pan right, gentle lateral drift left/right, slow tilt up/down, static lock-off. A single slow smooth move (DEFAULT, preferred — keeps the frame alive). NEVER combine moves; NEVER fast tracking, crane, jib, handheld shake, gimbal runs, orbit, whip pan, zoom, drone, POV walking.
SAFE_ACTIONS (ONE per person — whole-body, rhythmic, rigid-object work; these render cleanly and give the viewer something to WATCH): walking steadily, striding across a field, climbing steps, marching in file, riding a horse or cart, rowing a boat, leading a mule, carrying a crate on the shoulder, hauling a sack, shouldering a yoke of baskets, pushing or pulling a cart, loading or unloading crates, stacking sacks, sweeping a floor, raking leaves, hoeing soil, watering plants with a can, hammering at an anvil (Medium/Wide only), stirring a large pot with a long wooden paddle, sowing seeds by hand, hanging cloth to dry.
ENVIRONMENTAL_MOTION (layer this ON TOP of the subject's ACTION; it replaces body motion only in object-only scenes): drifting smoke, rising steam, flickering candle/firelight, wind stirring fabric or grass, falling dust motes, gentle ripples on water, slow-drifting clouds, embers floating.
LIGHTING_SCHEMES: soft diffused daylight, golden hour 5500K, overcast soft light, candlelight, motivated practical, Rembrandt, rim/back light, side light, top light. Prefer SOFT over hard light (hard light exaggerates artifacts).
COMPOSITION: rule of thirds, centered framing, symmetrical, negative space, leading lines, foreground/midground/background layering, depth cues.
EMOTION_TAGS: contemplative, resolute, calm, solemn, tender, melancholic, awed, weary, watchful, faint smile, steady gaze, softened brow. (Keep expressions subtle and natural.)
=== END GLOSSARY ===`;

// 👉 QUY TẮC CHỐNG LỖI (ưu tiên #1 cho video sạch, không thừa chi/méo tay/quái dị).
// Đặt TRÊN cả yếu tố điện ảnh: thà đơn giản mà sạch còn hơn đẹp mà lỗi.
const ANTI_ARTIFACT_RULE = `=== ANTI-ARTIFACT RULE (CRITICAL — HIGHEST PRIORITY, ABOVE ANY CINEMATIC FLAIR) ===
GOAL: clean, error-free footage for historical B-roll / stock replacement. A simple clean shot ALWAYS beats a fancy shot that risks warped anatomy. Cinematic beauty is SECONDARY to being artifact-free.

DO:
- Prefer Medium/Wide framing on people so bodies and hands stay small and stable.
- ACTION FIRST: every person on screen should be visibly MID-ACTION — performing ONE continuous, whole-body ACTION that spans the full 8 seconds (pick from SAFE_ACTIONS in the glossary: walking steadily, carrying a crate on the shoulder, pushing a cart, rowing, sweeping, hoeing soil, loading sacks...). A still pose (standing watch, mourning, gazing at the horizon) is allowed ONLY when the scene truly calls for stillness — NEVER as the default. A person doing real work is far more watchable than a person posing.
- Keep hands relaxed, low-detail, or out of tight framing. NEVER stage intricate finger work / counting / complex object manipulation in close view.
- Keep the number of people LOW and interaction MINIMAL. If several people are present, each performs at most ONE simple ACTION (walking, carrying, working side by side) without physical entanglement.
- OBJECT SCENES: object-only shots are welcome — vary the form/setting/era between scenes (see VISUAL STORYTELLING RULE S2b) and keep them alive with environmental motion + one gentle camera move. If a person joins the object, keep the object as the focal anchor with ONE gentle rigid interaction (holding, reaching, placing down) at Medium/Wide distance.
- Keep every shot alive with ENVIRONMENTAL_MOTION (smoke, steam, candle flicker, wind, ripples) ALONGSIDE the subject's one continuous ACTION — environment replaces body motion only in object-only scenes.

AVOID (these are the top causes of AI artifacts):
- Tight close-ups of hands or faces performing detailed motion.
- Fast movement, running, fighting, dancing, sudden gestures (cause jelly/morphing).
- Dense crowds in sharp focus (faces and limbs merge): at most 3-5 clearly visible people in the foreground; any larger gathering only as soft-focus silhouettes in the background.
- Elaborate armor/costume with heavy fine detail in close framing.
- Any camera work beyond ONE single gentle, slow, smooth move (push-in, pull-back, slow pan, gentle drift, slow tilt) — no combined moves, no fast motion.
=== END ANTI-ARTIFACT RULE ===`;

// 👉 LUẬT KỂ CHUYỆN BẰNG HÌNH: minh họa ĐÚNG nội dung lời bình bằng NGƯỜI + BỐI CẢNH
// + VẬT THỂ. Không dùng đạo cụ trung gian (bản đồ/giấy tờ/chữ), không để khung hình
// rỗng, sự kiện bạo lực kể bằng hậu quả CÓ NGƯỜI, đám đông giới hạn 3-5 người rõ nét.
const STORYTELLING_RULE = `=== VISUAL STORYTELLING RULE (CRITICAL — the viewer must have something REAL to watch) ===
S1. SHOW THE STORY, NOT PAPERWORK. When the narration mentions a place, activity, statistic or event, depict PEOPLE actually doing that activity in that place and era. NEVER make maps, documents, newspapers, typewriters, ledgers, calendars, archives, books, letters or files the subject of a shot.
   - "bananas spread to East Africa" → traders unloading banana bunches from a wooden sailing boat at a coastal market — NOT a map with arrows.
   - "the company owned 42% of the land" → a lone farmer standing tiny before an endless fenced plantation stretching to the horizon — NOT documents or charts.
   - "a court conviction in 2024" → lawyers in suits walking up modern courthouse steps — NOT a newspaper headline.
S2. ONE CLEAR SUBJECT PER FRAME — PEOPLE ARE OPTIONAL. Every scene needs ONE subject the viewer instantly recognizes, but that subject does NOT have to be a person. Include a person only when they genuinely add interest: period workers, soldiers, traders, the story's characters. And when a person IS present, show them mid-ACTION — visibly doing one continuous piece of work (see SAFE_ACTIONS), not posing. A generic modern person adds nothing — for scenes about an object or place, the object/place ITSELF is the better subject, kept alive with environmental motion and one gentle camera move.
S2b. VARIETY ACROSS SCENES (anti-repetition — the real boredom killer). When the same topic recurs through the script, NEVER repeat the same composition scene after scene. Rotate through the subject's WHOLE WORLD along three axes — this applies to ANY topic, not just food:
   • FORMS (the subject at different stages/scales): raw material → growing/being made → the finished thing → many of them together → transported → displayed. E.g. a fruit: single fruit → hanging bunch → flowering plant → whole tree → grove rows → crates at the dock → market pile. A sword: glowing steel in the forge → the smith's workshop → the finished blade on a rack → an armory wall of weapons → a museum display. Coffee: red cherries on the branch → terraced hillsides → beans drying in the yard → burlap sacks in a warehouse → a steaming cup.
   • PLACES: where it is born, grown/made, sold, shipped, used — kitchen, jungle, plantation, workshop, village market, port warehouse, ship deck, roadside stand, shop shelf, a home.
   • ERAS & LIGHT: the ancient origin at misty dawn, the colonial/industrial era at harsh noon, the 1950s in warm tungsten, the modern day in morning sun; rain on leaves, golden hour, drifting fog, candlelight.
   Pick the form/place/era that best matches THIS chunk's narration; between neighbouring scenes, deliberately change at least the setting or the form.
S3. WHEN A PERSON JOINS AN OBJECT (optional, not required): keep the object as the focal anchor and let the person interact gently and rigidly only — holding, reaching, placing down, walking toward, examining. Follow S8's state-anchor and container tricks.
S4. SENSITIVE/VIOLENT EVENTS → AFTERMATH WITH PEOPLE, NEVER GORE. Never depict weapons being aimed or fired, fighting, corpses, blood, wounds, graves, skulls, or people in terror. Tell such moments through a calm aftermath that still contains people doing ordinary actions: soldiers slowly patrolling an empty square at dawn, a woman picking up a fallen hat, villagers walking silently past shuttered houses, mourners placing flowers and candles. The frame must never be empty scenery alone.
S5. CROWD LIMIT. At most 3-5 clearly visible people in the foreground; any larger gathering appears only as soft-focus silhouettes or indistinct shapes in the background. Never describe "thousands of people", "a sea of faces", or a dense packed crowd in sharp focus.
S6. NO READABLE TEXT. Never show text meant to be read: headlines, labels, dates, calendar pages, signs, screens, typed words. Show the passage of time through nature and light instead (leaves falling, a candle burning down, light shifting across a room, seasons changing outside a window).
S7. EXPLICIT ETHNICITY & ERA FOR EVERY PERSON (target audience: American viewers). NEVER write a bare, ambiguous person ("a woman", "a farmer", "a man in a suit") — every person in every field MUST carry an explicit nationality/ethnicity descriptor plus era-appropriate clothing. Decide it in this priority order:
   a) If the narration states or implies the person's nationality/ethnicity (Colombian workers, Guatemalan president, Arab traders...) → use exactly that.
   b) Else if the scene's location/era clearly belongs to a specific country or culture (a highland village in New Guinea, a Caribbean port, a Colombian plantation...) → use people native to that place and time.
   c) Otherwise → DEFAULT to a white American person, styled correctly for the era: modern-day scenes get contemporary American looks (e.g. "a white American woman in her 30s, casual modern clothes"); historical American scenes get period-accurate dress (e.g. "a white American man in 1950s attire").
S8. NO TRANSFORMATION MOMENTS. Video models CANNOT make an object change form mid-shot — they duplicate the object instead (the bunch stays on the tree AND appears in the hand). This applies to EVERY object and material: fruit, crops, wood, stone, cloth, rope, food, tools. NEVER depict the instant of cutting, chopping, slicing, peeling, splitting, breaking, cracking, grinding, crushing, pounding, reaping, felling, carving, sawing, tearing, squeezing. Choose the moment BEFORE or AFTER:
   - BEFORE (anticipation, no contact yet): the worker raises a machete toward the banana stem / the woodcutter rests his axe on his shoulder beside the tall tree / the cook places a whole fish on the board, knife resting beside it.
   - AFTER (result already done): the worker carries a freshly harvested banana bunch away — tree OUT of frame / split firewood lies stacked as the man wipes his brow / a farmer carries bundles of harvested rice stalks across the field / a bowl of ground spices sits beside the stone mortar.
   - NO PARTIAL / AMBIGUOUS STATES: an object is either fully INTACT or fully PROCESSED — never half-peeled, half-cut, half-eaten, partially open. A hybrid state forces the model to blend two materials (peel + flesh) and it renders nonsense. A person holds a WHOLE banana; slices sit on a plate FULLY sliced. Prefer intact objects whenever possible.
   - MATERIAL CONTRAST: keep the featured object visually DISTINCT from the clothing/background touching it (different color and texture) — similar colors bleed into each other (a pale banana against a cream knit sweater inherits the knit texture). State the contrast explicitly when needed (e.g. "a yellow banana held against a dark blue apron").
   - STATE ANCHOR WHEN HANDLED: the instant a hand touches, holds or lifts an object with a famous transformation (fruit that gets peeled, eggs, bottles, wrapped goods), the model tends to START that transformation by itself — a lifted banana begins peeling on its own. Whenever a person handles such an object, EXPLICITLY anchor its state in the narrative: "the banana remains whole, unpeeled and intact for the entire shot". Even better: have the person handle the CONTAINER instead (lifts the bowl of bananas, carries the crate, sets down the basket) so the hand never touches the fruit directly.
   - ONE-INSTANCE RULE: the featured object exists in exactly ONE place in the frame. If it is in someone's hands, its source (tree, pile, plant) must be OUT of frame and NOT mentioned — describing both invites the model to draw the object twice.
   - EXACT COUNT: always state the exact quantity of the featured object ("a single banana", "three green bottles", "one sealed envelope", "a bunch of bananas"). An object without a stated count often renders as two overlapping copies.
   - NEVER WRITE THE WORD "peel": even as a harmless noun ("its yellow peel catching the light") or inside a negation ("the peel does not open"), the word itself primes the model to start peeling. Say "skin" instead ("its smooth yellow skin"). Same logic for other trigger nouns: prefer "shell" over "cracked shell", "wrapper stays sealed" over "unwrapping".
   - Allowed object interactions are RIGID-BODY ONLY: carry, lift, hold, place down, stack, load, turn over, push a cart — the object moves but never changes shape.
=== END VISUAL STORYTELLING RULE ===`;

// 👉 TỪ KHÓA CẤM trong nội dung cảnh/prompt (giấy tờ, chữ đọc được, bạo lực, đám đông
// dày đặc) — chốt chặn bằng code: dính là loại và tạo lại (không tin AI tự giác).
const BANNED_VISUALS: { re: RegExp; label: string }[] = [
  // Giấy tờ / đạo cụ trung gian
  { re: /\bmaps?\b/i, label: 'map' },
  { re: /\bdocuments?\b/i, label: 'document' },
  { re: /\bnewspapers?\b/i, label: 'newspaper' },
  { re: /\btypewriters?\b/i, label: 'typewriter' },
  { re: /\bledgers?\b/i, label: 'ledger' },
  { re: /\bcalendars?\b/i, label: 'calendar' },
  { re: /\barchiv/i, label: 'archive' },
  { re: /\bmanuscripts?\b/i, label: 'manuscript' },
  { re: /\bpaperwork\b/i, label: 'paperwork' },
  { re: /\bbooks?\b/i, label: 'book' },
  { re: /\b(?:flipping|turning)\s+(?:the\s+)?pages?\b|\bpages?\s+flip/i, label: 'page flipping' },
  // Chữ đọc được
  { re: /\bheadlines?\b/i, label: 'headline' },
  { re: /\blabell?ed\s+['"“]/i, label: 'labeled text' },
  { re: /\b(?:legible|readable)\s+(?:text|words?|letters?)\b/i, label: 'readable text' },
  { re: /\b(?:text|words?)\s+(?:reads?|reading|visible|appear|forming)\b/i, label: 'visible words' },
  // Bạo lực / ghê rợn
  { re: /\bcorpses?\b/i, label: 'corpse' },
  { re: /\bdead bod/i, label: 'dead body' },
  { re: /\bblood\b/i, label: 'blood' },
  { re: /\bmass graves?\b/i, label: 'mass grave' },
  { re: /\bskulls?\b/i, label: 'skull' },
  { re: /\bmassacres?\b/i, label: 'massacre' },
  { re: /\bmachine guns?\b/i, label: 'machine gun' },
  { re: /\bgunfire\b/i, label: 'gunfire' },
  { re: /\bopen(?:s|ed|ing)?\s+fire\b/i, label: 'open fire' },
  { re: /\bfir(?:es?|ing)\s+(?:a\s+|the\s+|his\s+|her\s+|their\s+)?(?:rifles?|guns?|weapons?)\b/i, label: 'firing weapon' },
  { re: /\baim(?:s|ed|ing)?\s+(?:a\s+|the\s+|his\s+|her\s+|their\s+)?(?:rifles?|guns?|weapons?)/i, label: 'aiming weapon' },
  { re: /\bbombs?\s+fall/i, label: 'bombs falling' },
  { re: /\bbombings?\b/i, label: 'bombing' },
  { re: /\bexplosions?\b/i, label: 'explosion' },
  { re: /\btortur/i, label: 'torture' },
  { re: /\bexecutions?\b/i, label: 'execution' },
  { re: /\bwounded\b/i, label: 'wounded' },
  { re: /\barmed\s+(?:men|group|fighters|exiles|force)\b/i, label: 'armed men' },
  { re: /\b(?:rifles?|guns?|weapons?)\s+at the ready\b/i, label: 'weapon at the ready' },
  { re: /\b(?:bombers?|warplanes?|fighter\s+(?:jets?|planes?)|military\s+(?:aircraft|jets?))\b/i, label: 'warplane' },
  { re: /\bair\s*(?:strikes?|raids?)\b/i, label: 'air raid' },
  // Hành động BIẾN ĐỔI vật thể (model không cắt/tách/bóc/nghiền/gặt... được — sẽ nhân
  // bản vật thể). Chỉ bắt dạng ĐỘNG TỪ chủ động (verb + the/a/an/off/open/down...) —
  // danh từ "banana slices", quá khứ phân từ "freshly harvested" vẫn hợp lệ.
  { re: /\b(?:cuts?|cutting|chops?|chopping|slices?|slicing|severs?|severing|peels?|peeling|splits?|splitting|tears?|tearing|snaps?|snapping|carves?|carving|saws?|sawing|rips?|ripping|shreds?|shredding|grates?|grating|grinds?|grinding|crushes|crushing|smashes|smashing|shatters?|shattering|squeezes|squeezing|kneads?|kneading|threshes|threshing|reaps?|reaping|mows?|mowing|fells?|felling|husks?|husking|shucks?|shucking)\s+(?:the|a|an|off|open|through|into|apart|down)\b/i, label: 'object transformation' },
  { re: /\b(?:peeled|sliced|chopped|severed|snapped|crushed|smashed|shattered|ground)\s+(?:the|a|an)\b/i, label: 'object transformation' },
  { re: /\bbreak(?:s|ing)?\s+(?:open|apart|off|in half|in two)\b/i, label: 'breaking object' },
  { re: /\bcrack(?:s|ing)?\s+open\b|\bcracks?\s+(?:the|an?)\s+(?:eggs?|nuts?|coconuts?|shells?)\b/i, label: 'cracking object' },
  { re: /\bpound(?:s|ing)?\s+(?:the|a|an)\b/i, label: 'pounding object' },
  { re: /\bpress(?:es|ing)?\s+(?:the\s+)?(?:juice|oil|grapes?|sugarcane|cane|olives?)\b/i, label: 'pressing juice' },
  { re: /\bpluck(?:s|ing|ed)?\b/i, label: 'plucking' },
  { re: /\bpick(?:s|ing)?\s+(?!up\b)(?:a|an|the)\b/i, label: 'picking off (detach)' },
  // Trạng thái DỞ DANG (bóc dở, cắt dở, ăn dở) — model trộn hai vật liệu thành vô nghĩa
  // (vỏ chuối nhiễm vân áo len). Vật thể phải NGUYÊN VẸN hoặc XỬ LÝ XONG hoàn toàn.
  { re: /\b(?:half|partially|partly)[- ](?:peeled|cut|sliced|eaten|split|unwrapped)\b/i, label: 'partial state' },
  { re: /\bpeel\s+(?:already\s+)?(?:half|partly|partially)\s+open\b/i, label: 'partial state' },
  // Đám đông dày đặc
  { re: /\b(?:thousands|hundreds) of (?:people|workers|men|women|strikers|protesters)\b/i, label: 'mass crowd' },
  { re: /\bsea of faces\b/i, label: 'sea of faces' },
  { re: /\b(?:dense|packed|massive|large|huge|vast)\s+crowd/i, label: 'dense crowd' },
];
const findBannedVisual = (text: string): string | null => {
  if (!text) return null;
  for (const b of BANNED_VISUALS) if (b.re.test(text)) return b.label;
  return null;
};

// 👉 NEO TRẠNG THÁI (tất định): vật thể có "biến đổi kinh điển" (chuối→bóc vỏ, trứng→đập,
// chai→mở...) hễ bị tay cầm/nhấc là model tự khởi động biến đổi đó. Nếu prompt có cảnh
// cầm nắm các vật này mà CHƯA có câu neo trạng thái → code tự nối thêm, không chờ AI nhớ.
const RISKY_NOUNS = 'bananas?|oranges?|tangerines?|apples?|mango(?:es|s)?|peach(?:es)?|pears?|grapes?|watermelons?|pineapples?|coconuts?|corn|eggs?|bottles?|jars?|(?:tin|metal)\\s+cans?|envelopes?|letters?|gifts?|presents?|packages?|parcels?|loa(?:f|ves)|bread';
// Loại trừ: cây/vườn/lá... (cảnh đồn điền không cần neo) và nghĩa bóng (banana republic/trade...).
const RISKY_NOUN_EXCLUDE = '(?!\\s+(?:trees?|plants?|groves?|lea(?:f|ves)|plantations?|rows|fields?|republic|industry|trade|business|company|market|crops?|boom|wars?|empire))';
const HANDLED_OBJECT_RE = new RegExp('\\b(?:holds?|holding|lifts?|lifting|picks?\\s+up|picking\\s+up|carr(?:y|ies|ying)|grasps?|grips?|gripping|raises?|raising|reach(?:es|ing)?\\s+for)\\b[^.!?]{0,60}?\\b(' + RISKY_NOUNS + ')\\b' + RISKY_NOUN_EXCLUDE, 'i');
// Vật rủi ro là CHỦ THỂ TĨNH (nằm/treo/đặt trên bàn) cũng tự biến đổi nếu thiếu neo —
// ảnh thực tế: chuối nằm trên quầy bếp vẫn tự bung vỏ khi câu neo yếu ("rests intact").
// Cho phép tối đa 2 tính từ chen giữa mạo từ và danh từ ("a sealed envelope", "a ripe yellow banana").
const STATIC_SUBJECT_RE = new RegExp('\\b(?:a|an|the|one|single|ripe|yellow|green|whole)\\s+(?:[a-z][a-z-]*\\s+){0,2}(' + RISKY_NOUNS + ')\\b' + RISKY_NOUN_EXCLUDE + '[^.!?]{0,50}?\\b(?:rests?|resting|sits?|sitting|lies?|lying|hangs?|hanging|placed|stands?)\\b', 'i');
const STATE_ANCHOR_RE = /\b(?:remains?|stays?|kept?)\b[^.!?]{0,40}\b(?:whole|intact|unpeeled|unopened|unchanged|sealed|closed)\b|\b(?:unpeeled|unopened|skin intact|skin unbroken)\b/i;
// Đã có từ chỉ số lượng gần vật thể chưa? Chưa có → vật đơn lẻ hay bị render thành 2.
const COUNT_WORD_RE = /\b(?:one|single|two|three|four|five|six|a few|several|a pair of|a bunch of|a cluster of|a pile of|a row of|a basket of|a bowl of|a crate of|a stack of|dozens?)\b/i;
const buildStateAnchor = (text: string): string => {
  const m = text.match(HANDLED_OBJECT_RE) || text.match(STATIC_SUBJECT_RE);
  if (!m || STATE_ANCHOR_RE.test(text)) return '';
  const noun = m[1].toLowerCase();
  let state = 'completely whole and intact';                       // mặc định
  if (/banana|orange|tangerine|mango/.test(noun)) state = 'completely whole, unpeeled and intact, skin unbroken';
  else if (/apple|peach|pear|grape|watermelon|pineapple|coconut/.test(noun)) state = 'completely whole, uncut and intact, skin unbroken';
  else if (/corn/.test(noun)) state = 'whole and unhusked';
  else if (/egg/.test(noun)) state = 'completely whole and uncracked';
  else if (/bottle|jar|can/.test(noun)) state = 'sealed and unopened';
  else if (/envelope|letter|gift|present|package|parcel/.test(noun)) state = 'sealed, wrapped and unopened';
  else if (/loa|bread/.test(noun)) state = 'completely whole and uncut';
  // Vật số ít mà prompt chưa nói rõ số lượng → chốt "exactly one" (chống nhân đôi).
  // Câu neo KHÔNG dùng từ "peel" — chính từ đó mồi model bóc vỏ (kể cả trong câu phủ định).
  const quantity = (!noun.endsWith('s') && !COUNT_WORD_RE.test(text)) ? `Exactly one ${noun} in frame. ` : '';
  return `${quantity}The ${noun} remains ${state} from the first frame to the last.`;
};

// 👉 SỬA TẤT ĐỊNH TRÊN NỘI DUNG (chạy trước khi ghép đuôi negative — không đụng vào đuôi):
// Fix B: danh từ "peel" ở phần khẳng định ("its yellow peel") tự mồi model khởi động
// bóc vỏ → thay bằng "skin". Không đụng "unpeeled"/"peeling" (có biên từ riêng).
const fixPeelNoun = (content: string): string =>
  content.replace(/\bpeel(s)?\b/gi, (mm) => {
    const base = mm === mm.toUpperCase() ? 'SKIN' : (mm[0] === 'P' ? 'Skin' : 'skin');
    const plural = /s$/i.test(mm) ? (mm.endsWith('S') ? 'S' : 's') : '';
    return base + plural;
  });
// Fix E: đồng hồ điện tử = chữ số đọc được = render ra ký tự rác → ép sang analog trơn.
const fixDigitalClock = (content: string): string =>
  content.replace(/\bdigital\s+(clocks?|watch(?:es)?)\b/gi, 'blank-faced analog $1');
// Fix E: bất kỳ mặt đồng hồ nào cũng phải trơn không số — nếu prompt nhắc đồng hồ mà
// chưa neo "blank-faced" thì code tự nối câu neo (số trên mặt đồng hồ luôn render hỏng).
const CLOCK_RE = /\b(?:clocks?|wrist\s*watch(?:es)?|pocket\s+watch(?:es)?|watch\s+faces?)\b/i;
const CLOCK_BLANK_RE = /\bblank[- ]faced\b|\bno (?:readable )?(?:numerals|numbers|digits)\b|\bwithout (?:numerals|numbers|digits)\b/i;
const buildClockAnchor = (content: string): string =>
  CLOCK_RE.test(content) && !CLOCK_BLANK_RE.test(content)
    ? 'Every clock face is plain and blank — no numerals, no readable markings.'
    : '';

// 👉 ĐUÔI NEGATIVE THEO NGỮ CẢNH (Fix D): cụm "natural hands / anatomy" CHỈ được xuất
// hiện khi cảnh thực sự có người — nhắc "hands" trong cảnh không người khiến model tự
// vẽ thêm bàn tay vào khung hình (lỗi đã gặp thật). Cảnh vật-thể-thuần dùng đuôi riêng,
// cấm hẳn tay/bộ phận cơ thể lọt khung. (Fix F: cả hai đuôi cấm thêm chất liệu giả CGI.)
const NEGATIVE_TAIL_PERSON = "Consistent anatomy, natural hands, stable proportions. Avoid: extra or deformed limbs and fingers, face warping, morphing, duplicated people or objects, objects peeling or splitting on their own, flicker, plastic or beauty-filter skin, CGI look, 3D render, over-smooth gradients, readable text, watermark, maps or documents, dense crowds.";
const NEGATIVE_TAIL_OBJECT = "Stable forms and proportions. Avoid: morphing, warping, duplicated objects, objects peeling or splitting on their own, human hands or body parts entering the frame, flicker, CGI look, 3D render, over-smooth gradients, readable text, watermark, maps or documents.";
const NEGATIVE_TAILS = [NEGATIVE_TAIL_PERSON, NEGATIVE_TAIL_OBJECT];
const stripNegativeTails = (text: string): string => {
  let out = text;
  for (const t of NEGATIVE_TAILS) out = out.split(t).join(' ');
  return out;
};
// Cảnh có người không? Quét RỘNG (nhầm sang "có người" chỉ quay về hành vi cũ — vô hại;
// nhầm sang "không người" mới mất lưới anatomy) nhưng phải bỏ các cụm PHỦ ĐỊNH người
// ("no people in sight") trước khi quét, kẻo cảnh vật-thể bị gắn nhầm đuôi person.
const PERSON_NEG_RE = /\bno (?:people|humans?|one|body)\b|\bnobody\b|\bunattended\b|\bempty of people\b|\bwithout (?:people|anyone|a person)\b|\bdeserted\b/gi;
const PERSON_RE = /\b(?:man|men|woman|women|person|people|human|figures?|farmer|worker|soldier|sailor|fisherman|trader|merchant|vendor|villager|laborer|labourer|porter|foreman|cook|baker|blacksmith|weaver|driver|rider|guard|officer|clerk|engineer|doctor|nurse|teacher|student|monk|priest|nun|mother|father|wife|husband|son|daughter|family|child|children|boy|girl|baby|infant|elder|couple|gentleman|lady|folk|crowd|he|she|his|her)\b|\bhands?\b|\b\d+\s*-?\s*year-old\b/i;
const pickNegativeTail = (p: any, content: string): string => {
  const hasExpression = typeof p?.expression === 'string' && p.expression.trim().length > 0;
  const hasSubjects = typeof p?._validation_subjects === 'string' && p._validation_subjects.trim().length > 0;
  const scanBase = content.replace(PERSON_NEG_RE, ' ');
  return (hasExpression || hasSubjects || PERSON_RE.test(scanBase)) ? NEGATIVE_TAIL_PERSON : NEGATIVE_TAIL_OBJECT;
};

// 👉 QUY TẮC LÕI: Mỗi cảnh 8 giây CHỈ được là MỘT khoảnh khắc liên tục, MỘT bối cảnh,
// MỘT hành động đơn. Nếu một câu thoại/đoạn văn chứa nhiều ý, nhiều địa điểm hoặc nhiều
// hành động, AI phải CHỌN DUY NHẤT một ý nổi bật nhất về mặt hình ảnh và BỎ QUA phần còn lại.
// Đây là chìa khóa để video không bị "nhảy cảnh", rối mắt khi render.
const SINGLE_MOMENT_RULE = `=== SINGLE-MOMENT RULE (CRITICAL — HIGHEST PRIORITY) ===
An 8-second shot can physically show only ONE continuous moment: ONE location, ONE time, ONE primary action by the subject. It is NOT a montage.

When a text chunk contains MULTIPLE ideas, locations, or actions (e.g. "a city, then cut to a house, then back outside", or "she leaves home and arrives at the office"):
1. SELECT exactly ONE — the single most visually dominant / dramatically important moment.
2. Build the ENTIRE scene/prompt around that one moment only.
3. COMPLETELY DROP and IGNORE the other ideas/locations/actions. Do NOT mention them, do NOT try to squeeze them in.

HARD BANS (these break the video):
- NO location change within the shot (no "then moves to", "arrives at", "cut to", "meanwhile elsewhere").
- NO time jump (no "later", "then", "after that", "next").
- NO chaining of separate actions. The subject performs ONE clear action that can plausibly happen in 8 continuous seconds.
- NO scene cuts of any kind.

The camera performs at most ONE gentle, slow, smooth move (slow push-in, pull-back, slow pan, gentle drift, or slow tilt) — or stays static. Never combine moves; never orbit, crane, whip pan, handheld shake, or any fast/complex move. It stays on the SAME continuous moment in the SAME place. Multiple characters present in the SAME place at the SAME time is allowed, but they hold simple stable poses — that is still one moment.
=== END SINGLE-MOMENT RULE ===`;

// 👉 QUY TẮC AN TOÀN: TUYỆT ĐỐI không để tên người nổi tiếng / người thật ngoài đời
// (chính trị gia, ca sĩ, diễn viên, vận động viên, người nổi tiếng, nhân vật lịch sử có thật,
// thương hiệu gắn với người thật...) lọt vào BẤT KỲ khâu nào. Tên phải được thay bằng một
// tên hư cấu trung tính; chỉ được MÔ TẢ hình dáng/ngoại hình của nhân vật đó, không dùng tên thật.
// 👉 BỘ MÃ DANH ĐƯỢC DUYỆT để thay tên người thật (danh sách cố định của người dùng),
// chia theo giới tính & độ tuổi. AI được lệnh chọn từ đây; code cưỡng chế lại lần cuối.
const CODENAMES = {
  maleOld:     ['A Khan', 'A Lu', 'A Nam', 'Asen'],
  maleYoung:   ['A Chen', 'A Cua', 'A Bon'],
  femaleOld:   ['A Chi', 'Ba Mom', 'Ba Lac'],
  femaleYoung: ['May Kool', 'May Phuong', 'May Nu'],
};
const ALL_CODENAMES = [...CODENAMES.maleOld, ...CODENAMES.maleYoung, ...CODENAMES.femaleOld, ...CODENAMES.femaleYoung];

const CELEBRITY_SAFETY_RULE = `=== REAL-PERSON / CELEBRITY NAME SAFETY (CRITICAL — POLICY) ===
Using the real name of an actual public figure violates content policy. This applies to politicians, musicians, actors, athletes, influencers, royalty, real historical people, and brand mascots tied to a real person.

RULES:
1. If a character is (or is named after) a REAL public figure, NEVER output their real name. Replace it with a CODENAME chosen from the APPROVED LIST below, matched to the person's gender and age (old ≈ 50+):
   - Male, old: ${CODENAMES.maleOld.join(', ')}
   - Male, young: ${CODENAMES.maleYoung.join(', ')}
   - Female, old: ${CODENAMES.femaleOld.join(', ')}
   - Female, young: ${CODENAMES.femaleYoung.join(', ')}
   Keep the substitution CONSISTENT — the same real person always maps to the same codename everywhere, and NEVER assign one codename to two different people. If every fitting codename is taken, reuse the list IN ORDER with a number suffix: "A Khan 1", "A Lu 2", "A Nam 3", ... — never invent any other name.
1b. NEVER substitute with any other human-sounding name (e.g. "Marcus Vale", "John Smith") — ANY invented personal name can accidentally match another real person. Only the approved codenames above or a "the ..." epithet are safe.
2. The PHYSICAL DESCRIPTION (age, build, hair, skin, distinguishing features, clothing) of that person IS allowed and SHOULD be kept — convey the likeness through description, never through the name.
3. Purely fictional / original characters invented by the script keep their original name unchanged.
4. Never let a real public figure's name appear in ANY output field (names, narrative, setting, context, dialogue references). If such a name appears in the source text and is not a directory character, replace it with a generic descriptor (e.g. "a famous singer") — never the real name.
=== END REAL-PERSON NAME SAFETY ===`;

// Gom mô tả nhân vật, lọc giá trị rác và khử trùng lặp (chống ra "(Guatemalan,
// Guatemalan, Not specified)"). Tách theo dấu phẩy, so khớp không dấu/không hoa.
const CHAR_JUNK = new Set(['n/a', 'none', 'unspecified', 'not specified', 'unknown', 'not mentioned', 'no description', 'khong', 'null', 'undefined', '""', '', 'empty']);
const cleanCharacterParts = (c: CharacterIdentity): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [c.visualDescription, c.ethnicity, c.clothing]) {
    for (const piece of (raw || '').split(',')) {
      const t = piece.trim();
      const key = foldText(t);
      if (!t || CHAR_JUNK.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
};

const buildCharacterProfiles = (characters: CharacterIdentity[]): string => {
  if (!characters || characters.length === 0) return '';
  return characters.map((c, i) => {
    const detailsArr = cleanCharacterParts(c);

    const roleAlias = c.name.trim();
    const targetName = c.promptName?.trim() || roleAlias;
    const origRef = c.originalName?.trim() || '';
    // Chỉ cần dòng REDACT khi tên gốc khác tên đưa vào prompt (tức là người thật được đổi tên).
    const needsRedact = origRef && origRef.toLowerCase() !== targetName.toLowerCase();
    const fullDesc = detailsArr.join(', ');
    const fullBlock = fullDesc ? `${targetName} (${fullDesc})` : targetName;

    return `[CHARACTER ${i + 1}]
  CANONICAL_NAME: "${targetName}"
  ALIAS_IN_SCRIPT: "${roleAlias}"${needsRedact ? `
  ORIGINAL_REFERENCE (REDACT — appears in the source text; you MUST replace every occurrence of it with CANONICAL_NAME and NEVER write it in any output field): "${origRef}"` : ''}
  VERBATIM_BLOCK: "${fullBlock}"
  RULE: Whenever this character appears (by CANONICAL_NAME, by ALIAS_IN_SCRIPT,${needsRedact ? ' by ORIGINAL_REFERENCE,' : ''} or by any pronoun he/she/it/they/him/her/hắn/nó/cô ấy/anh ấy/ông ấy/bà ấy):
    - FIRST mention → copy the string after VERBATIM_BLOCK: including every word, every comma. Do NOT shorten, paraphrase, summarize, or drop any adjective. Embed this string naturally inside the sentence at the point the character is introduced.
    - SUBSEQUENT mentions → write bare CANONICAL_NAME "${targetName}" only. Never use a pronoun or a DIFFERENT generic noun ("the man", "the woman", "the figure", "the warrior"). Note: the CANONICAL_NAME itself may be a descriptive epithet (e.g. "the Silver-Bearded Statesman") — that exact epithet IS the name; copy it verbatim, never shorten or vary it.`;
  }).join('\n\n');
};

const tokenizeForValidation = (s: string): string[] => {
  if (!s) return [];
  const stop = new Set(['with','from','that','this','they','them','their','have','been','were','will','your','what','when','where','which','about','into','onto','over','under','very','also','more','most','some','such','than','then','only','just','like','than','these','those','here','there']);
  return s.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !stop.has(w));
};

const buildCharacterIndex = (characters: CharacterIdentity[]) => {
  return characters.map(c => {
    const canonical = (c.promptName?.trim() || c.name.trim());
    const descParts = [c.visualDescription, c.ethnicity, c.clothing].map(x => x?.trim() || '').filter(Boolean);
    return {
      canonical,
      aliasLower: c.name.trim().toLowerCase(),
      promptLower: (c.promptName || '').trim().toLowerCase(),
      // Tên gốc (vd tên thật của người nổi tiếng) còn nằm trong sourceText → cần khớp để nhận diện nhân vật.
      originalLower: (c.originalName || '').trim().toLowerCase(),
      descTokens: tokenizeForValidation(descParts.join(' ')),
    };
  }).filter(c => c.canonical);
};

// ============================================================================
// 👉 BỘ LỌC TÊN NGƯỜI THẬT (TẤT ĐỊNH — không phụ thuộc AI tự giác tuân thủ)
// Find-replace mọi lần xuất hiện của originalName (tên thật) → tên hư cấu
// (promptName). Khớp không phân biệt HOA/thường và KHÔNG DẤU ("Son Tung" vẫn
// bắt được dù danh bạ ghi "Sơn Tùng"), có biên từ để không phá từ khác, tên
// đầy đủ được ưu tiên trước token lẻ. Được gọi ở MỌI cửa ra của pipeline.
// ============================================================================
const foldChar = (ch: string): string => {
  if (ch === 'đ' || ch === 'Đ') return 'd';
  return ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
};
const foldText = (s: string): string => { let out = ''; for (const ch of s) out += foldChar(ch); return out; };
// fold kèm bản đồ vị trí folded → vị trí gốc, để thay đúng chỗ trên chuỗi gốc.
const foldWithMap = (s: string): { folded: string; map: number[] } => {
  let folded = ''; const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const f = foldChar(s[i]);
    for (const fc of f) { folded += fc; map.push(i); }
  }
  return { folded, map };
};
const isWordCh = (ch: string): boolean => !!ch && /[\p{L}\p{N}]/u.test(ch);

// Token quá phổ biến trong tên → không dùng đơn lẻ làm needle (tránh thay nhầm từ thường).
const NAME_TOKEN_STOP = new Set(['van', 'thi', 'the', 'von', 'der', 'de', 'la', 'le', 'di', 'da', 'mac', 'and', 'of']);

// Token trông như MỘT âm tiết tiếng Việt (đã fold) → trùng từ thường quá dễ ("minh",
// "quang", "thanh"...), không dùng đơn lẻ. Tên nước ngoài ("ronaldo", "trump", "messi")
// không khớp mẫu này nên vẫn được bắt khi đứng riêng.
const VN_SYLLABLE_RE = /^(?:b|c|ch|d|g|gh|gi|h|k|kh|l|m|n|ng|ngh|nh|p|ph|q|qu|r|s|t|th|tr|v|x)?[aeiouy]+(?:c|ch|m|n|ng|nh|p|t)?$/;

// Kiểm tra tên (đã fold) xuất hiện trong chuỗi (đã fold) với biên từ.
const containsFoldedName = (foldedHaystack: string, name: string): boolean => {
  const needle = foldText(name.trim());
  if (needle.length < 2) return false;
  let idx = foldedHaystack.indexOf(needle);
  while (idx !== -1) {
    const before = idx > 0 ? foldedHaystack[idx - 1] : '';
    const after = foldedHaystack[idx + needle.length] || '';
    if (!isWordCh(before) && !isWordCh(after)) return true;
    idx = foldedHaystack.indexOf(needle, idx + 1);
  }
  return false;
};

const scrubRealNames = (text: string, characters: CharacterIdentity[]): string => {
  if (!text || !characters || characters.length === 0) return text;
  const entries: { canonical: string; needles: string[] }[] = [];
  for (const c of characters) {
    const canonical = (c.promptName?.trim() || c.name?.trim() || '');
    const orig = (c.originalName || '').trim();
    if (!canonical || !orig) continue;
    if (foldText(orig) === foldText(canonical)) continue;   // tên thay trùng tên gốc → không thay được gì
    const needles = new Set<string>([foldText(orig)]);
    const toks = orig.split(/\s+/).map(t => foldText(t.replace(/[^\p{L}\p{N}]/gu, ''))).filter(Boolean);
    // Cụm ≥2 từ LIÊN TIẾP của tên (bắt cách gọi tắt "Son Tung", "Chí Minh"...) — đủ đặc trưng để an toàn.
    for (let a = 0; a < toks.length; a++) {
      for (let b = a + 2; b <= toks.length; b++) needles.add(toks.slice(a, b).join(' '));
    }
    // Token ĐƠN chỉ khi ≥4 ký tự, không phải từ đệm, và KHÔNG có dạng âm tiết tiếng Việt
    // (để "Ronaldo"/"Trump" đứng riêng vẫn bị thay, nhưng "minh"/"quang" trong từ thường thì không).
    for (const clean of toks) {
      if (clean.length >= 4 && !NAME_TOKEN_STOP.has(clean) && !VN_SYLLABLE_RE.test(clean)) needles.add(clean);
    }
    entries.push({ canonical, needles: Array.from(needles) });
  }
  if (entries.length === 0) return text;

  const { folded, map } = foldWithMap(text);
  const matches: { start: number; end: number; canonical: string }[] = [];
  for (const e of entries) {
    for (const needle of e.needles) {
      if (needle.length < 2) continue;
      let idx = folded.indexOf(needle);
      while (idx !== -1) {
        const before = idx > 0 ? folded[idx - 1] : '';
        const after = folded[idx + needle.length] || '';
        if (!isWordCh(before) && !isWordCh(after)) matches.push({ start: idx, end: idx + needle.length, canonical: e.canonical });
        idx = folded.indexOf(needle, idx + 1);
      }
    }
  }
  if (matches.length === 0) return text;
  // Chồng lấn: tên đầy đủ (dài hơn) thắng token lẻ; thay từ cuối về đầu để giữ nguyên index.
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept: typeof matches = [];
  let lastEnd = -1;
  for (const m of matches) { if (m.start >= lastEnd) { kept.push(m); lastEnd = m.end; } }
  let out = text;
  for (let k = kept.length - 1; k >= 0; k--) {
    const m = kept[k];
    const oStart = map[m.start];
    const oEnd = map[m.end - 1] + 1;
    out = out.slice(0, oStart) + m.canonical + out.slice(oEnd);
  }
  return out;
};

// ============================================================================
// 👉 BƯỚC 2.5 — VISUAL PLANNER (chống lặp bố cục XUYÊN mẻ và XUYÊN phân đoạn).
// Bệnh đã gặp thật: 5 cảnh liên tiếp đều "chuối trên bàn bếp" vì mỗi mẻ Bước 3
// (5 cảnh) không nhìn thấy mẻ khác. Planner nhìn 40 cảnh/lần + SỔ ĐA DẠNG dùng
// chung toàn app (các phân đoạn chạy song song dùng sổ này theo best-effort),
// giao cho mỗi cảnh một "phương án bố cục" (form/place/era/shot/person) mang tính
// RÀNG BUỘC với Bước 3. Planner hỏng → Bước 3 chạy như cũ, không thêm điểm chết.
// ============================================================================
interface VisualPlan { sceneId: number; form: string; place: string; era: string; shot: string; person_action: string; }
const PLAN_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      sceneId: { type: Type.INTEGER },
      form: { type: Type.STRING, description: "The FORM of the scene's main subject, 2-6 words (e.g. 'hanging banana bunch', 'wooden crates of bananas', 'single ripe banana', 'steam locomotive', 'harbor cranes')." },
      place: { type: Type.STRING, description: "Concrete location, 2-6 words (e.g. 'jungle plantation row', 'dockside market', '1950s American kitchen')." },
      era: { type: Type.STRING, description: "Era + light mood, 2-5 words, consistent with the script timeframe (e.g. 'colonial noon', '1950s tungsten evening', 'modern morning sun')." },
      shot: { type: Type.STRING, description: "Shot size + camera, 2-5 words from the stock-safe set (e.g. 'wide static', 'medium slow push-in')." },
      person_action: { type: Type.STRING, description: "Either 'none' (object/place-only scene) or ONE person + ONE continuous whole-body action, ≤10 words (e.g. 'a Guatemalan dockworker carries a crate'). Scenes with REQUIRED_CHARACTERS must feature those characters, never 'none'." }
    },
    required: ["sceneId", "form", "place", "era", "shot", "person_action"]
  }
};
// Khóa so trùng: gộp từ nội dung của form+place (bỏ từ dừng, bỏ 's' số nhiều, xếp
// thứ tự) để "banana on kitchen counter" và "kitchen counter with a banana" ra cùng khóa.
const PLAN_STOPWORDS = new Set(['the', 'and', 'with', 'from', 'into', 'over', 'under', 'near', 'beside', 'across', 'around', 'onto', 'upon', 'for', 'row', 'rows']);
const comboKey = (form: string, place: string): string => {
  // Stem tối giản: bỏ đuôi es/s rồi bỏ e cuối — để "bunches/bunch", "crates/crate",
  // "houses/house" đều quy về cùng gốc (chỉ cần NHẤT QUÁN làm khóa, không cần đúng ngữ pháp).
  const stem = (w: string) => (/es$/.test(w) ? w.slice(0, -2) : w.replace(/s$/, '')).replace(/e$/, '');
  const norm = (s: string) => foldText(s || '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !PLAN_STOPWORDS.has(w)).map(stem).sort().join(' ');
  return `${norm(form)}::${norm(place)}`;
};
// SỔ ĐA DẠNG: FIFO có trần — combo cũ tự rơi khỏi sổ, không cần reset thủ công.
const LEDGER_MAX = 60;
const ledgerKeys: string[] = [];
const ledgerLabels: string[] = [];
const ledgerHas = (k: string) => ledgerKeys.includes(k);
const ledgerPush = (k: string, label: string) => {
  ledgerKeys.push(k); ledgerLabels.push(label);
  while (ledgerKeys.length > LEDGER_MAX) { ledgerKeys.shift(); ledgerLabels.shift(); }
};

const PLANNER_BATCH = 40;
const buildPlannerInstruction = (globalContext: string, recentLabels: string[]): string => `You are the ART DIRECTOR planning compositions for a sequence of 8-second historical B-roll shots, BEFORE the prompt writers start. Your ONLY job: make every scene visually DIFFERENT while still illustrating its text.

For each input scene assign ONE composition plan: form / place / era / shot / person_action.

RULES:
1. ILLUSTRATE THE TEXT: the plan must show the story meaning of that scene's description — never invent an unrelated subject. Never plan maps, documents, newspapers, readable text, violence, or dense crowds.
2. ROTATE RELENTLESSLY (the whole point). Never let two nearby scenes share the same look. For each new plan, compare it against the recent scenes and the ALREADY-USED list, then change SEVERAL of these axes so it feels fresh — run this DIVERSITY CHECKLIST:
   • Same subject/character → different ACTION? (not the same pose or gesture again)
   • Same character → different NUMBER? (alone vs. part of a small group / crowd)
   • Same character → different INTERACTION? (holding something different, touching something, talking to someone vs. no one)
   • Same character → different PLACE? (indoors vs. outdoors, city vs. countryside)
   • Same setting → different TIME OF DAY? (dawn, harsh midday, golden sunset, night)
   • Same setting → different SEASON / WEATHER? (clear sun, rain, snow, fog, mist)
   • Same setting → different DEPTH LAYERS? (new foreground or background detail)
   • Same topic → different ERA? (past vs. present — great for food-history, stay within the script's overall timeframe though)
   • Same scene → different SHOT SIZE? (wide, medium, close, extreme close-up, cutaway/insert)
   • Also rotate the FORM of the subject (single item → bunch/cluster → tree/source → grove/factory rows → crates at the dock → market pile → shop shelf...).
   The 'form' and 'place' you output are the primary anti-repeat keys, but let this whole checklist drive your choices of era, shot and person_action too.
3. ALREADY-USED COMPOSITIONS (from earlier parts of this video — do NOT reuse any of these form+place pairings):
${recentLabels.length ? recentLabels.map(l => `   - ${l}`).join('\n') : '   (none yet)'}
4. PEOPLE ARE OPTIONAL: use 'none' freely for object/place scenes — but a scene listing REQUIRED_CHARACTERS must feature exactly those characters (never 'none'). When a person appears, give them ONE continuous whole-body action (carrying, walking, loading, rowing...), never posing. Any person MUST belong to THIS scene's own era and place (period-accurate dress and setting) — NEVER a narrator, host, presenter, or modern person dropped into a historical scene, and never someone addressing the camera.
5. ERA CONSISTENCY: stay inside the era implied by the scene text / context below. Vary light and sub-period, not the century.
6. SHOT: vary the shot size across scenes (establishing wide, wide, medium-wide, medium, and — for OBJECTS or still details only — close or extreme close-up). Keep PEOPLE at medium/wide (never a tight close-up on moving hands or faces). One gentle camera move max (static / slow push-in / slow pull-back / slow pan / gentle drift).

CONTEXT: ${globalContext || '(none)'}

Output strictly valid JSON for EVERY input scene id.`;

const planVisualsForScenes = async (
  scenes: Scene[],
  globalContext: string,
  requiredCharsByScene: Map<number, string[]>,
  onStatusUpdate?: (msg: string) => void,
  aiOptions?: AIOperationOptions,
): Promise<Map<number, VisualPlan>> => {
  const operation = normalizeOperationOptions(aiOptions, DEFAULT_WORKFLOW_TIMEOUT_MS.prompt);
  const plannerOperation = withAuxiliaryPolicy(operation);
  const plans = new Map<number, VisualPlan>();
  for (let i = 0; i < scenes.length; i += PLANNER_BATCH) {
    const chunk = scenes.slice(i, i + PLANNER_BATCH);
    const payload = chunk.map(s => ({
      id: s.id,
      description: (s.visualDescription || '').slice(0, 300),
      setting: (s.settingTime || '').slice(0, 120),
      REQUIRED_CHARACTERS: requiredCharsByScene.get(s.id) || []
    }));
    let planned: any[] = [];
    try {
      planned = await callAISafe<any[]>(
        `Plan compositions for these scenes:\n${JSON.stringify(payload)}`,
        buildPlannerInstruction(globalContext, ledgerLabels.slice(-25)),
        PLAN_SCHEMA, 0.6, 'planner', undefined, plannerOperation
      );
    } catch { continue; }                                  // planner là tầng phụ trợ — lỗi thì bỏ qua mẻ này
    if (!Array.isArray(planned)) continue;

    // Chống trùng TẤT ĐỊNH: trùng trong mẻ hoặc trùng sổ → gom lại xin phương án khác (1 vòng).
    const seen = new Set(ledgerKeys);
    const accepted: VisualPlan[] = [];
    let dupes: VisualPlan[] = [];
    for (const p of planned) {
      if (typeof p?.sceneId !== 'number' || !p.form || !p.place) continue;
      const k = comboKey(p.form, p.place);
      if (seen.has(k)) { dupes.push(p); } else { seen.add(k); accepted.push(p); }
    }
    if (dupes.length > 0) {
      onStatusUpdate?.(`Đổi bố cục ${dupes.length} cảnh bị trùng...`);
      try {
        const usedNow = [...ledgerLabels.slice(-25), ...accepted.map(p => `${p.form} / ${p.place}`)];
        const retryPayload = dupes.map(p => {
          const s = chunk.find(x => x.id === p.sceneId);
          return { id: p.sceneId, description: (s?.visualDescription || '').slice(0, 300), setting: (s?.settingTime || '').slice(0, 120), REQUIRED_CHARACTERS: requiredCharsByScene.get(p.sceneId) || [] };
        });
        const retried = await callAISafe<any[]>(
          `These scenes were assigned compositions that are ALREADY USED elsewhere in the video. Assign each a DIFFERENT form+place (rotate to another form of the subject or another location):\n${JSON.stringify(retryPayload)}`,
          buildPlannerInstruction(globalContext, usedNow), PLAN_SCHEMA, 0.75, 'planner', undefined, plannerOperation
        );
        if (Array.isArray(retried)) {
          const fixedIds = new Set<number>();
          for (const p of retried) {
            if (typeof p?.sceneId !== 'number' || !p.form || !p.place) continue;
            const k = comboKey(p.form, p.place);
            if (!seen.has(k)) { seen.add(k); accepted.push(p); fixedIds.add(p.sceneId); }
          }
          dupes = dupes.filter(p => !fixedIds.has(p.sceneId));
        }
      } catch { /* giữ nguyên bản trùng — đa dạng xếp sau "không lỗi" */ }
      accepted.push(...dupes);                             // vẫn nhận: trùng còn hơn thiếu plan
    }
    for (const p of accepted) {
      plans.set(p.sceneId, p);
      ledgerPush(comboKey(p.form, p.place), `${p.form} / ${p.place}`);
    }
  }
  return plans;
};

// Chỉ thị ràng buộc bơm vào payload từng cảnh của Bước 3.
const planToDirective = (p: VisualPlan | undefined, hasRequiredChars: boolean): string => {
  if (!p) return '';
  // Cảnh có nhân vật bắt buộc thì planner không được phép ép "không người".
  const person = (!p.person_action || /^none$/i.test(p.person_action.trim()))
    ? (hasRequiredChars ? '' : 'none — object/place-only scene, keep it alive with environmental motion')
    : p.person_action.trim();
  const parts = [`FORM: ${p.form}`, `PLACE: ${p.place}`, `ERA: ${p.era}`, `SHOT: ${p.shot}`];
  if (person) parts.push(`PERSON: ${person}`);
  return parts.join(' | ');
};

export const extractContextAndCharacters = async (
  rawScript: string,
  aiOptions?: AIOperationOptions,
  allowFormatRetry = true,
  formatCorrection = false,
): Promise<{ context: string; characters: CharacterIdentity[] }> => {
  if (!rawScript || rawScript.trim().length === 0) return { context: "", characters: [] };
  // Keep the full script intact, but fail clearly before asking a provider to
  // process more text than the conservative shared-context budget allows.
  if (rawScript.length > 120_000) {
    throw new Error('Kịch bản quá dài để trích xuất trong một lần. Hãy dùng model có context lớn hơn hoặc rút gọn kịch bản. [CONTEXT_LIMIT]');
  }
  const operation = normalizeOperationOptions(aiOptions, DEFAULT_WORKFLOW_TIMEOUT_MS.context);
  try {
    const result = await callAISafe<any>(
      `SCRIPT:\n${rawScript}\n\nReturn one JSON object with exactly these top-level fields: "context" (a non-empty string) and "characters" (an array). Do not use "globalContext".${formatCorrection ? '\n\nFORMAT CORRECTION: A previous response could not be validated. Return the complete object now. Do not omit context, do not wrap it in result/data/output, and do not include any text outside JSON.' : ''}`,
      `Analyze this script.
1. Extract a DENSE "context" including: Year/Era, Specific Locations, Weather/Lighting variations, Overall Cinematic Atmosphere/Mood, and the core narrative arc. This context MUST anchor the visual consistency of the entire video. The context MUST NOT contain the real name of any public figure (see REAL-PERSON NAME SAFETY) — use the invented substitute name or a generic descriptor instead.
2. Extract all distinct characters/subjects.

${CELEBRITY_SAFETY_RULE}

CRITICAL RULES:
1. Put the character's name into the "promptName" field. If the character is an ORIGINAL fictional character, copy the EXACT original name from the script (do NOT over-censor ordinary fictional names). If the character is (or is named after) a REAL public figure, put a CODENAME here chosen from the APPROVED LIST in the REAL-PERSON NAME SAFETY section, matched to the person's gender and age — NEVER another human-sounding name (any invented personal name can accidentally match a different real person). Capture ONLY the person's physical look (face, build, clothing) in "visualDescription" — never their office, title, or achievements.
1b. Put into "originalName" the exact name/reference EXACTLY as it literally appears in the script (for a real public figure, this is their REAL name). This field is used ONLY internally to find-and-replace that reference; it will never be shown. If the script gives no explicit name, leave it EMPTY "".
1c. Set "isRealPerson" to true if the character is (or is named after / clearly depicts) a REAL public figure or real historical person; set false for purely fictional/original characters.
2. Put a safe, generic role alias in the "name" field (e.g., "The Protagonist", "The Horse", "The Villain").
2b. NO NARRATOR / HOST / PRESENTER: do NOT extract a narrator, host, presenter, storyteller, voice-over, or any modern framing person as a character. Narration is off-screen audio only and NEVER appears on screen. Only extract characters that actually exist inside the story's own world and era.
3. ALWAYS FILL IN APPEARANCE (critical for cross-scene character CONSISTENCY — the same person must be redrawable every scene): every human or animal character MUST receive a complete visualDescription. If the script states physical traits, use them exactly. If the script does NOT describe the look (this is the common case for narration), INVENT a plausible, ordinary appearance that fits the character's gender, age, ethnicity and era. Keep invented looks generic and non-distinctive; for a real public figure give a generic era-appropriate look — NEVER copy their real, recognizable signature features. NEVER leave the field empty for an on-screen character.
4. "visualDescription" is physical APPEARANCE ONLY, a concise comma-separated list that FILLS ALL THREE parts of this framework in order (invent ordinary, era-appropriate details for any part the script leaves unstated — do not skip parts):
   1) FACE: age range + gender + facial features + hair + skin (e.g. "middle-aged man, square jaw, short greying hair, tanned skin").
   2) BUILD: height / body build (e.g. "medium height, sturdy build").
   3) CLOTHING: garment type + color (e.g. "charcoal double-breasted suit, white shirt").
    ABSOLUTELY FORBIDDEN here (this field must NOT identify a real person): any personal name; any role, title, office, rank, or occupation used as identity (president, king, general, minister, senator, CEO, "democratically elected", "leader of ...", "president of Guatemala"); any country or organization named as a title; any famous event, position, or achievement. PHYSICAL LOOK ONLY. NEVER leave this empty for an extracted on-screen character.
5. For "ethnicity": extract from the script if stated; else INFER from the character's story context (nationality/location/era — e.g. a Guatemalan president → "Guatemalan"); if the story gives NO such context at all, default to "white American" (the videos target American viewers). For "clothing": extract strictly from the script; if not mentioned, leave EMPTY "". ABSOLUTELY DO NOT output "Unspecified", "N/A", or "None".
Output strictly valid JSON.`, 
      { type: Type.OBJECT, properties: { context: { type: Type.STRING }, characters: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, promptName: { type: Type.STRING }, originalName: { type: Type.STRING }, isRealPerson: { type: Type.BOOLEAN }, ethnicity: { type: Type.STRING }, clothing: { type: Type.STRING }, visualDescription: { type: Type.STRING, description: "Physical appearance ONLY, comma-separated, ALWAYS FILLED for every extracted on-screen character: FACE (age, gender, facial features, hair, skin), then BUILD (height/build), then CLOTHING (type + color). NEVER a name, title, office, rank, occupation, country-as-title, or achievement (no 'president', 'general', 'president of Guatemala', 'democratically elected'), and never a real figure's signature features. Never empty." } }, required: ["name", "promptName", "originalName", "isRealPerson", "visualDescription"] } } }, required: ["context", "characters"] },
      0.4, 'scene', undefined, operation);
    let normalized;
    try {
      normalized = normalizeContextExtraction(result);
    } catch (error) {
      if ((error instanceof ContextExtractionValidationError || error instanceof AIJsonParseError) && allowFormatRetry) {
        operation.onProgress?.('AI trả dữ liệu chưa đúng định dạng; đang yêu cầu lại một lần...');
        return extractContextAndCharacters(rawScript, { ...aiOptions, maxAttempts: 1 }, false, true);
      }
      throw error;
    }
    updateUsageStats({ scripts: 1 });

    const rawChars: CharacterIdentity[] = normalized.characters
      .map((c: any, index: number) => ({
        id: `char-${index}-${Date.now()}`, ...c,
        // Lưới chặn cứng: bỏ chức danh/vai trò khỏi mô tả (chống lộ danh tính người thật).
        visualDescription: stripIdentityTitles(c.visualDescription || '')
      }))
      // 👉 Loại hẳn nhân vật dẫn chuyện/host — không bao giờ lên hình.
      .filter((c: CharacterIdentity) => !isNarratorCharacter(c));
    // 👉 CƯỠNG CHẾ MÃ DANH cho NGƯỜI THẬT (isRealPerson=true): mọi tên người tự bịa đều
    // CÓ THỂ vô tình trùng một người nổi tiếng khác. Chỉ chấp nhận: (a) mã danh trong
    // BỘ ĐƯỢC DUYỆT (CODENAMES), hoặc (b) danh xưng dạng "the ...". Ngoài ra → code tự
    // gán mã danh đúng nhóm giới tính/tuổi (đọc từ mô tả), không trùng giữa các nhân vật.
    // Nhân vật HƯ CẤU giữ nguyên tên gốc — không đụng tới.
    const isEpithet = (s: string) => /^the\s+\p{L}/iu.test(s.trim());
    const usedCodenames = new Set<string>();

    const pickCodename = (c: CharacterIdentity): string => {
      const info = `${c.name || ''} ${c.visualDescription || ''} ${c.ethnicity || ''} ${c.clothing || ''}`.toLowerCase();
      const FEMALE_CUES = ['woman', 'female', 'girl', 'lady', 'queen', 'princess', 'empress', 'matriarch', 'nun', 'phụ nữ', 'thiếu nữ', 'cô gái', 'bà lão', 'nữ hoàng', 'công chúa', 'nữ tướng'];
      const OLD_CUES = ['elderly', 'old', 'aged', 'senior', 'white hair', 'white-haired', 'silver hair', 'gray hair', 'grey hair', 'white beard', 'wrinkl', 'già', 'cao tuổi', 'lớn tuổi', 'trung niên', 'tóc bạc', 'râu bạc'];
      const YOUNG_CUES = ['young', 'teen', 'youth', 'boy', 'girl', 'trẻ', 'thanh niên', 'thiếu niên', 'thiếu nữ'];
      const isFemale = FEMALE_CUES.some(k => info.includes(k));
      const ageMatch = info.match(/(\d{1,3})\s*[- ]?\s*(?:year|years|yr|tuổi)/);
      let isOld: boolean;
      if (ageMatch) isOld = parseInt(ageMatch[1], 10) >= 50;
      else if (OLD_CUES.some(k => info.includes(k))) isOld = true;
      else if (YOUNG_CUES.some(k => info.includes(k))) isOld = false;
      else isOld = true;                                   // phim lịch sử: mặc định lớn tuổi
      const bucket = isFemale ? (isOld ? CODENAMES.femaleOld : CODENAMES.femaleYoung) : (isOld ? CODENAMES.maleOld : CODENAMES.maleYoung);
      // Chọn mã chưa dùng trong nhóm. Hết nhóm → quay vòng lại NHÓM ĐÓ và đánh số
      // tăng dần: "A Khan 1", "A Lu 2", "A Nam 3"... (giữ đúng giới tính/độ tuổi).
      for (const n of bucket) if (!usedCodenames.has(foldText(n))) return n;
      for (let k = 0; ; k++) {
        const cand = `${bucket[k % bucket.length]} ${k + 1}`;
        if (!usedCodenames.has(foldText(cand))) return cand;
      }
    };

    const characters = rawChars.map(c => {
      if (!c.isRealPerson) return c;                       // hư cấu → giữ nguyên tên gốc
      const orig = (c.originalName || '').trim();
      const pn = (c.promptName || '').trim();
      const pnFold = foldText(pn);
      // Mã hợp lệ = tên trong danh sách, CÓ THỂ kèm số đánh thêm ("A Khan 2").
      const pnBaseFold = foldText(pn.replace(/\s+\d+$/, '').trim());
      const isApprovedCodename = ALL_CODENAMES.some(n => foldText(n) === pnBaseFold);
      if (pn && pnFold !== foldText(orig) && ((isApprovedCodename && !usedCodenames.has(pnFold)) || isEpithet(pn))) {
        if (isApprovedCodename) usedCodenames.add(pnFold);
        return c;                                          // AI đã chọn đúng chuẩn → giữ
      }
      // promptName đang là TÊN NGƯỜI (nhiều khả năng chính là tên thật) → dồn nó vào
      // originalName (nếu chỗ đó trống) để bộ lọc scrub bắt được, rồi gán mã danh.
      const codename = pickCodename(c);
      usedCodenames.add(foldText(codename));
      return { ...c, originalName: orig || pn, promptName: codename };
    }).map(ensureAppearance);   // 👉 100% có ngoại hình — trống thì code tự dựng mô tả chung
    // 👉 Lọc tên thật khỏi globalContext — context này được bơm vào MỌI system prompt
    // phía sau, để nguyên tên thật là mồi cho AI lặp lại nó ở từng cảnh.
    const context = scrubRealNames(normalized.context, characters);
    return { context, characters };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("MISSING_") || message.includes("[LỖI CẤU HÌNH]")) throw e;
    // 👉 Không nuốt lỗi trong im lặng nữa: trước đây trả {context:"", characters:[]} khiến
    // App ghi đè danh bạ nhân vật bằng rỗng mà người dùng không biết → lưới chặn tê liệt.
    throw e;
  }
};

export const analyzeSingleSegmentToScenes = async (
  segment: { id: string; content: string },
  globalContext: string = '',
  options?: PromptOptions,
  characters: CharacterIdentity[] = [],
  aiOptions?: AIOperationOptions,
): Promise<Scene[]> => {
  const operation = normalizeOperationOptions(aiOptions, DEFAULT_WORKFLOW_TIMEOUT_MS.analyze);
  const exactSourceTexts = splitScriptByCode(segment.content, options?.splitLogic);
  let allFinalScenes: Scene[] = [];
  const batches: string[][] = [];
  for (let i = 0; i < exactSourceTexts.length; i += CONFIG.BATCH_SIZE) batches.push(exactSourceTexts.slice(i, i + CONFIG.BATCH_SIZE));

  const charProfiles = buildCharacterProfiles(characters);

  const processBatch = async (batchTexts: string[], index: number) => {
    const validScenes: Scene[] = batchTexts.map((exactText) => ({
      id: 0, 
      sourceText: exactText, 
      visualDescription: "",
      characterDetails: "", 
      settingTime: "", 
      duration: "8s" 
    }));
    
    let pendingIndices = batchTexts.map((_, i) => i);
    let loopCount = 0;
    const maxBatchLoops = operation.speedMode === 'fast' ? 3 : 2;

    while (pendingIndices.length > 0 && loopCount < maxBatchLoops) {
      loopCount++;
      const promptTexts = pendingIndices.map(i => `[ID: ${i + 1}] "${batchTexts[i]}"`).join('\n');
      
      const systemInstruction = `You are an expert AI Cinematographer.
I am giving you a list of EXACT text chunks from a script.
For EACH chunk, provide the camera angle (visualDescription <= 80 words), characterDetails, and settingTime.

${CELEBRITY_SAFETY_RULE}

${SINGLE_MOMENT_RULE}
The 'visualDescription' and 'settingTime' you write MUST describe only the ONE selected moment for that chunk — a single location and a single primary action. Never describe two places or a sequence of actions.

${STORYTELLING_RULE}
The 'visualDescription' MUST follow the VISUAL STORYTELLING RULE above: give the chunk ONE clear subject in its real place and era — people only when they genuinely add interest, otherwise the object/place itself in a VARIED form/setting/era (per S2/S2b — never repeat the previous chunk's composition); NEVER maps, documents, newspapers, typewriters, calendars or readable text as the subject; violent moments become a calm aftermath WITH people present; crowds capped at 3-5 clearly visible people; EVERY person carries an explicit ethnicity + era descriptor (default: white American when the story doesn't specify, per S7); NEVER the instant an object changes form — choose the moment BEFORE or AFTER, object in ONE place only (per S8).

CONTEXT: ${globalContext}

${charProfiles ? `=== MASTER CHARACTER DIRECTORY (HARD ENFORCEMENT) ===
${charProfiles}
=== END DIRECTORY ===

CHARACTER MAPPING — MANDATORY:
1. PRONOUN RESOLUTION: For every pronoun in the chunk (he/she/it/they/him/her/hắn/nó/cô ấy/anh ấy/ông ấy/bà ấy/người này/người đó), determine which character from the Directory it refers to using the CONTEXT. Do NOT leave any pronoun unresolved.
2. NAME REPLACEMENT: Replace every reference to a Directory character (by ALIAS_IN_SCRIPT, by pronoun, or by generic noun) with the CANONICAL_NAME from the Directory.
3. FULL TRAITS INJECTION: In the 'visualDescription' AND 'characterDetails' fields, on the FIRST mention of each character that appears in the chunk, paste that character's VERBATIM_BLOCK from the Directory (the exact string inside the quotes after VERBATIM_BLOCK:). Do NOT shorten, paraphrase, summarize, or drop any clause. Copy verbatim.
4. ZERO-HALLUCINATION: Do not invent actions or details not present in the chunk. Only map names/pronouns and inject the Directory's VERBATIM_BLOCK.
5. characterDetails MUST list every Directory character present in the chunk, each one written as its VERBATIM_BLOCK verbatim.` : ''}

CRITICAL: Return a JSON array with EXACTLY ${pendingIndices.length} items. The 'id' in your JSON must exactly match the [ID: X] provided. DO NOT CHANGE THE TEXT.`;

      try { 
        const aiResults = await callAISafe<any[]>(`CONTEXT: ${globalContext}\n\nTEXT CHUNKS:\n${promptTexts}`, systemInstruction, SCENE_SCHEMA, 0.4, 'scene', undefined, operation);
        const successfulIds: number[] = [];
        
        for (const res of aiResults) {
          const idx = res.id - 1;
          if (pendingIndices.includes(idx)) {
            // 👉 Lọc tên thật ngay tại cửa nhập — nếu AI quên luật, code vẫn thay tất định.
            validScenes[idx].visualDescription = scrubRealNames(res.visualDescription || "", characters);
            validScenes[idx].characterDetails = scrubRealNames(res.characterDetails || "Contextual characters", characters);
            validScenes[idx].settingTime = scrubRealNames(res.settingTime || "Contextual setting", characters);
            // 👉 Chốt chặn hình ảnh cấm (giấy tờ/chữ/bạo lực/đám đông) — dính thì tạo lại,
            // trừ vòng cuối (chấp nhận để không kẹt cả đoạn).
            const bannedHit = findBannedVisual(`${validScenes[idx].visualDescription} ${validScenes[idx].settingTime}`);
            if (validScenes[idx].visualDescription !== "" && (!bannedHit || loopCount >= maxBatchLoops)) {
               successfulIds.push(idx);
            }
          }
        }
        pendingIndices = pendingIndices.filter(i => !successfulIds.includes(i));
      } 
      catch (e: any) {
        const kind = classifyAIError(e).kind;
        if (operation.speedMode === 'fast' && loopCount < maxBatchLoops && kind !== 'authentication' && kind !== 'client') continue;
        throw e;
      }
    }
    
    return { index, chunkScenes: validScenes };
  };

  const shouldSplitSceneBatch = (error: unknown, batch: string[]): boolean => {
    if (batch.length <= 2) return false;
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof AIJsonParseError || /\b(?:413|payload too large|context length|output.*truncat)/i.test(message);
  };
  const resolveSceneBatch = async (batch: string[], index: number): Promise<Scene[]> => {
    try {
      return (await processBatch(batch, index)).chunkScenes;
    } catch (error) {
      if (!shouldSplitSceneBatch(error, batch)) throw error;
      const midpoint = Math.ceil(batch.length / 2);
      operation.onProgress?.(`Mẻ cảnh ${index + 1} quá lớn; đang tách thành ${midpoint} + ${batch.length - midpoint} cảnh.`);
      const [left, right] = await Promise.all([
        resolveSceneBatch(batch.slice(0, midpoint), index),
        resolveSceneBatch(batch.slice(midpoint), index),
      ]);
      return [...left, ...right];
    }
  };

  const completedBatches: Array<Scene[] | undefined> = Array.from({ length: batches.length });
  const batchConcurrency = operation.speedMode === 'ultra-max' ? 4 : 1;
  await runWithWorkerPool(
    batches,
    batchConcurrency,
    async (batch, index) => {
      if (operation.signal?.aborted) throw operation.signal.reason;
      const chunkScenes = await resolveSceneBatch(batch, index);
      const firstSceneId = batches.slice(0, index).reduce((count, current) => count + current.length, 0) + 1;
      completedBatches[index] = chunkScenes.map((scene, sceneIndex) => ({ ...scene, id: firstSceneId + sceneIndex }));
      allFinalScenes = completedBatches.flatMap((scenes) => scenes || []);
      operation.onPartialScenes?.([...allFinalScenes]);
      operation.onProgress?.(`Đã hoàn thành mẻ ${index + 1}/${batches.length} (${allFinalScenes.length}/${exactSourceTexts.length} cảnh)`);
    },
    { shouldStop: () => Boolean(operation.signal?.aborted) },
  );

  return allFinalScenes;
};

export const repairFailedScenes = async (
  failedScenes: Scene[],
  globalContext: string = '',
  options?: PromptOptions,
  characters: CharacterIdentity[] = [],
  aiOptions?: AIOperationOptions,
): Promise<Scene[]> => {
  if (failedScenes.length === 0) return [];
  const operation = normalizeOperationOptions(aiOptions, DEFAULT_WORKFLOW_TIMEOUT_MS.repair);
  
  const charProfiles = buildCharacterProfiles(characters);
  let loopCount = 0;
  let pending = [...failedScenes];
  let results: Scene[] = [];

  while (pending.length > 0 && loopCount < 2) {
      loopCount++;
      const currentPrompt = pending.map(s => `[ID: ${s.id}] "${s.sourceText}"`).join('\n');
      
      const systemInstruction = `You are an expert AI Cinematographer.
I am giving you a list of text chunks from a script that failed to process previously.
For EACH chunk, provide the camera angle (visualDescription <= 80 words), characterDetails, and settingTime.

${CELEBRITY_SAFETY_RULE}

${SINGLE_MOMENT_RULE}
The 'visualDescription' and 'settingTime' you write MUST describe only the ONE selected moment for that chunk — a single location and a single primary action. Never describe two places or a sequence of actions.

${STORYTELLING_RULE}
The 'visualDescription' MUST follow the VISUAL STORYTELLING RULE above: give the chunk ONE clear subject in its real place and era — people only when they genuinely add interest, otherwise the object/place itself in a VARIED form/setting/era (per S2/S2b — never repeat the previous chunk's composition); NEVER maps, documents, newspapers, typewriters, calendars or readable text as the subject; violent moments become a calm aftermath WITH people present; crowds capped at 3-5 clearly visible people; EVERY person carries an explicit ethnicity + era descriptor (default: white American when the story doesn't specify, per S7); NEVER the instant an object changes form — choose the moment BEFORE or AFTER, object in ONE place only (per S8).

CONTEXT: ${globalContext}

${charProfiles ? `=== MASTER CHARACTER DIRECTORY (HARD ENFORCEMENT) ===
${charProfiles}
=== END DIRECTORY ===

CHARACTER MAPPING — MANDATORY:
1. PRONOUN RESOLUTION: For every pronoun in the chunk (he/she/it/they/him/her/hắn/nó/cô ấy/anh ấy/ông ấy/bà ấy/người này/người đó), determine which character from the Directory it refers to using the CONTEXT. Do NOT leave any pronoun unresolved.
2. NAME REPLACEMENT: Replace every reference to a Directory character (by ALIAS_IN_SCRIPT, by pronoun, or by generic noun) with the CANONICAL_NAME from the Directory.
3. FULL TRAITS INJECTION: In the 'visualDescription' AND 'characterDetails' fields, on the FIRST mention of each character that appears in the chunk, paste that character's VERBATIM_BLOCK from the Directory (the exact string inside the quotes after VERBATIM_BLOCK:). Do NOT shorten, paraphrase, summarize, or drop any clause. Copy verbatim.
4. ZERO-HALLUCINATION: Do not invent actions or details not present in the chunk. Only map names/pronouns and inject the Directory's VERBATIM_BLOCK.
5. characterDetails MUST list every Directory character present in the chunk, each one written as its VERBATIM_BLOCK verbatim.` : ''}

CRITICAL: Return a JSON array with EXACTLY ${pending.length} items. The 'id' must exactly match the [ID: X] provided. DO NOT CHANGE THE TEXT.`;

      try {
          const aiResults = await callAISafe<any[]>(`CONTEXT: ${globalContext}\n\nTEXT CHUNKS:\n${currentPrompt}`, systemInstruction, SCENE_SCHEMA, 0.4, 'scene', undefined, operation);
          const successIds: number[] = [];
          
          for (const res of aiResults) {
              const scene = pending.find(s => s.id === res.id);
              // 👉 Chốt chặn hình ảnh cấm ở luồng vá cảnh — dính thì để vòng sau tạo lại.
              const bannedHit = findBannedVisual(`${res.visualDescription || ''} ${res.settingTime || ''}`);
              if (scene && res.visualDescription && (!bannedHit || loopCount >= 2)) {
                  results.push({
                      ...scene,
                      // 👉 Lọc tên thật ngay tại cửa nhập của luồng vá cảnh (trước đây không kiểm tra gì).
                      visualDescription: scrubRealNames(res.visualDescription, characters),
                      characterDetails: scrubRealNames(res.characterDetails || "Contextual characters", characters),
                      settingTime: scrubRealNames(res.settingTime || "Contextual setting", characters)
                  });
                  successIds.push(res.id);
              }
          }
          pending = pending.filter(s => !successIds.includes(s.id));
      } catch (e: any) { throw e; }
  }

  return [...results, ...pending];
};

export const generatePromptsForSingleSegment = async (
  segment: { id: string; scenes: Scene[] }, 
  globalContext: string = '', 
  colorStyle: ColorStyle = 'cinematic', 
  styleAnalysis: string = '', 
  styleSummary: string = '', 
  characters: CharacterIdentity[] = [], 
  onStatusUpdate?: (msg: string) => void,
  customPromptSuffix: string = '',
  options?: PromptOptions,
  aiOptions?: AIOperationOptions,
): Promise<{ items: PromptItem[], rescueProvider?: string }> => {
  if (segment.scenes.length === 0) return { items: [] };
  const operation = normalizeOperationOptions(aiOptions, DEFAULT_WORKFLOW_TIMEOUT_MS.prompt);
  const rescueOperation = withAuxiliaryPolicy(operation);
  const colorMoodDesc = getColorDescription(colorStyle);

  // 👉 Mặc định "trông như quay thật" — KHÔNG dùng từ phim nhựa (film/grain) để Veo
  // không vẽ viền phim, lỗ răng cưa, xước đen lên video.
  const finalStyleStr = fixFilmLook(styleSummary ? styleSummary.trim() : 'authentic documentary realism, natural lighting, true-to-life color');
  const techDetailsStr = styleAnalysis ? `Technical rendering details to follow: ${styleAnalysis}` : '';

  // 👉 THÀNH TỐ PROMPT theo cài đặt người dùng (popup ⚙️, lưu localStorage).
  const promptElements = loadPromptElements();
  const maxPromptChars = loadMaxPromptChars();
  const aiExtraElements = promptElements.filter(e => e.enabled && e.mode === 'ai' && !e.core);
  const fixedElements = promptElements.filter(e => e.enabled && e.mode === 'fixed');
  const disabledCoreKeys = promptElements.filter(e => e.core && !e.enabled).map(e => e.key);
  const dynamicPromptSchema = buildPromptSchema(promptElements);
  const requiredCoreKeys = promptElements.filter(e => e.enabled && e.core && e.key !== 'character').map(e => e.key);

  // BƠM TỪ ĐIỂN NHÂN VẬT VÀO BƯỚC CUỐI
  const charProfiles = buildCharacterProfiles(characters);

  // 👉 B2.5 — VISUAL PLANNER: quy hoạch bố cục TOÀN phân đoạn trước khi viết prompt.
  // Nhân vật bắt buộc của từng cảnh tính trước để planner không ép "không người"
  // vào cảnh có nhân vật. Planner chạy độc lập theo từng phân đoạn để không chặn
  // mẻ khác; sổ đa dạng vẫn được dùng theo best-effort. Planner hỏng → Bước 3 chạy như cũ.
  const segCharIndex = buildCharacterIndex(characters);
  const requiredCharsByScene = new Map<number, string[]>();
  for (const s of segment.scenes) {
    const haystack = foldText(`${s.sourceText || ''} ${s.visualDescription || ''} ${s.characterDetails || ''}`);
    const req: string[] = [];
    for (const c of segCharIndex) {
      if ((c.aliasLower && haystack.includes(foldText(c.aliasLower))) || (c.promptLower && haystack.includes(foldText(c.promptLower))) || (c.originalLower && haystack.includes(foldText(c.originalLower)))) req.push(c.canonical);
    }
    requiredCharsByScene.set(s.id, req);
  }
  let visualPlans = new Map<number, VisualPlan>();
  // Planner improves diversity but costs an extra model call; it still runs
  // through the same single-request limiter as every other AI task.
  const useVisualPlanner = options?.visualPlanner ?? true;
  if (useVisualPlanner) {
    onStatusUpdate?.('Đang quy hoạch bố cục cảnh (chống lặp)...');
    // 👉 (Sửa hiệu năng) KHÔNG nối tiếp toàn cục qua plannerChain nữa: trước đây mọi phân
    // đoạn xâu chuỗi planner tuần tự và CHẶN Bước 3 → phân đoạn sau chờ planner mọi phân
    // đoạn trước, làm chậm cả kịch bản. Giờ mỗi phân đoạn chạy planner ĐỘC LẬP (đồng thời,
    // đã bị giới hạn bởi limiter). Sổ đa dạng vẫn dùng chung nên dedup vẫn hoạt động (best-
    // effort). Planner chỉ là tầng phụ trợ — hỏng thì Bước 3 vẫn chạy bình thường.
    try { visualPlans = await planVisualsForScenes(segment.scenes, globalContext, requiredCharsByScene, onStatusUpdate, operation); } catch { /* bỏ qua */ }
  }

  const systemInstruction = `You are a video-prompt engineer for Veo 3 (8-second historical B-roll for American viewers).
For EACH input scene, output ONE JSON object with the fields below, all in ENGLISH. OUTPUT STRICTLY VALID JSON.
Put MOST of your detail in "action"; keep every other field SHORT and plain — do not over-decorate them.

FIELD GUIDE:
- sceneId: integer, matches the input id.
- camera_angle / shot_size / camera_movement: 1-3 words each. Medium or Wide framing, neutral angle, and exactly ONE gentle camera move (or static). Never a tight close-up on hands or faces.
- setting: the place, short (≤12 words). time: era + time of day, short.
- character: who is on screen with ethnicity + era clothing; use "" when the scene has NO people.
- action: the heart of the prompt (~40-70 words) — ONE single, natural, graceful, SIMPLE action unfolding smoothly across the 8 seconds. Show HOW it looks: posture, pace, gaze, the gentle motion around it. Must be ERROR-FREE (see NO ERRORS).
- style: short style + color mood, ending exactly with "Rendered in the style of ${finalStyleStr}."
- _subjects: comma-separated CANONICAL_NAMEs present (internal).
${aiExtraElements.length ? `
ADDITIONAL FIELDS (the user enabled these — fill each one for EVERY scene, keep them SHORT):
${aiExtraElements.map(e => `- ${e.key}: ${e.instruction || e.label}`).join('\n')}
` : ''}${disabledCoreKeys.length ? `
DISABLED FIELDS: do NOT output these fields at all: ${disabledCoreKeys.join(', ')}.${disabledCoreKeys.includes('character') ? " Weave each present character's VERBATIM_BLOCK directly into 'action' instead (first mention), so every character still appears by CANONICAL_NAME." : ''}
` : ''}${fixedElements.length ? `
AUTO-APPENDED FIELDS: the app itself appends these fields with fixed values — do NOT write them: ${fixedElements.map(e => e.key).join(', ')}.
` : ''}${maxPromptChars > 0 ? `
LENGTH BUDGET: keep the WHOLE JSON object under ~${maxPromptChars} characters. Shorten 'action' first to fit; never sacrifice the character descriptions.
` : ''}
ONE SCENE PER PROMPT (critical): each prompt is a SINGLE continuous moment — ONE place, ONE time, ONE action. Never change location, never jump in time, never chain actions ("then..."), never a montage or split screen. If the input text implies several moments, pick the single most visual one and silently drop the rest.

NEVER A NARRATOR ON SCREEN (critical): there is NO narrator, host, presenter, or modern framing person in any shot. Narration is off-screen voice-over only. Every scene lives ENTIRELY inside the story's own world and era — show only period-appropriate people, places and objects for that scene's time. NEVER put a modern-day person (or a person looking at the camera / addressing the viewer) into a historical scene. If a scene's text is pure narration with no character, illustrate its MEANING with era-appropriate people or objects doing something in that world — never a presenter talking to camera.

NO ERRORS (this is the #1 priority — a clean simple shot always beats a fancy one):
- ONE continuous whole-body action at a calm pace (walking, carrying, rowing, sweeping, loading, planting, speaking calmly, watching). No fast, intricate, or fiddly motion; no fine finger work in close-up.
- Keep the main action simple and rigid — people carry, hold, walk, place, row, sweep, or speak. Pick actions that do not require an object to visibly transform mid-shot. Describe every object plainly and naturally, in as few words as it needs — no extra state adjectives.
- An object appears in only ONE place in the frame (in a hand OR on a surface, never both).
- At most 3-5 people in sharp focus; larger groups only as soft, out-of-focus background.
- Every person carries an explicit ethnicity + era-appropriate clothing (default: a white American, era-correct, when the story doesn't specify).
- For anything violent, show a calm AFTERMATH with ordinary people instead of the violent instant.
- Never show maps, documents, newspapers, readable text/labels/signs, or paperwork as the subject.

REALISM: aim for footage that looks genuinely filmed — natural imperfect light, true-to-life color. NEVER use film-medium words ("film grain", "shot on film", "35mm film", "archival/vintage film") — Veo draws literal film borders, sprocket holes, frame numbers and scratches onto the image. Never "hyper-realistic / 8K / flawless" either (they cause plastic CGI skin).

VARIETY ACROSS SCENES (stock thinking — do not bore the viewer): when the same subject or character recurs, do NOT repeat the same composition. E.g. for "a leader gives a speech": one scene is the speaker, the next is city crowds listening, the next is a rural family gathered by a radio, the next is a lone worker pausing to listen — each its own single moment. Before writing each scene, run this DIVERSITY CHECKLIST versus the nearby scenes and change several axes:
   • Same character → different ACTION? (not the same pose/gesture repeated)
   • Same character → different NUMBER? (alone vs. in a small group / crowd)
   • Same character → different INTERACTION? (holding something else, touching something, talking to someone vs. no one)
   • Same character → different PLACE? (indoors vs. outdoors, city vs. countryside)
   • Same setting → different TIME OF DAY? (dawn, harsh midday, golden sunset, night)
   • Same setting → different SEASON / WEATHER? (clear sun, rain, snow, fog, mist)
   • Same setting → different DEPTH LAYERS? (new foreground or background detail)
   • Same topic → different ERA? (past vs. present — great for food-history; stay within the story's overall timeframe)
   • Same scene → different SHOT SIZE? (wide, medium, close, extreme close-up, cutaway) — keep PEOPLE at medium/wide, use close-ups only on objects/details.
When a VISUAL_PLAN is provided below, it already encodes these choices — follow it.

VISUAL PLAN: if a scene input has "VISUAL_PLAN", the art director assigned it to keep the whole video varied — FOLLOW it. Build the scene on that FORM / PLACE / ERA / SHOT. If PERSON is "none", make it an object/place scene with character="". If PERSON names someone, that person + action is the human element. The scene's own text still gives the story meaning. If the plan ever conflicts with a safety rule above, the safety rule wins.

${CELEBRITY_SAFETY_RULE}

${charProfiles ? `=== CHARACTERS (keep them visually consistent across scenes) ===
${charProfiles}
When a character appears, copy their VERBATIM_BLOCK (the text inside the quotes) into 'character' EXACTLY as written; after the first mention use the bare CANONICAL_NAME. Never use pronouns or a different generic noun for them. NEVER write their ORIGINAL_REFERENCE real name in any field.
` : ''}
CONTEXT: ${globalContext}
COLOR MOOD (fold into 'style'): ${colorMoodDesc}
${techDetailsStr}
${options?.audioMode !== 'keep' ? 'AUDIO: describe visuals only — no dialogue, no on-screen text, no music.' : ''}
Do NOT output the real name of any public figure, do NOT invent characters or props absent from the input, do NOT write any Vietnamese.`;

  const promptBatchSize = operation.speedMode === 'fast' ? 5 : CONFIG.PROMPT_BATCH_SIZE;
  const batches = splitIntoBatches(segment.scenes, promptBatchSize);
  const shouldSplitPromptBatch = (error: unknown, batch: Scene[]) => {
    if (batch.length <= 2) return false;
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof AIJsonParseError || /\b(?:413|payload too large|context length|output.*truncat)/i.test(message);
  };

  // 👉 Ghép PROMPT JSON theo THÀNH TỐ người dùng đã tick (popup ⚙️): thành tố 'ai' lấy
  // nội dung AI viết; thành tố 'fixed' gắn giá trị cố định. Áp trần độ dài nếu có.
  const assembleFinalPrompt = (p: any): string => {
    const clean = (s: any) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');
    const dotEnd = (s: string) => (!s ? '' : (/[.!?]$/.test(s) ? s : s + '.'));
    const obj: Record<string, string> = {};
    for (const e of promptElements) {
      if (!e.enabled) continue;
      if (e.mode === 'fixed') { obj[e.key] = (e.value || '').trim(); continue; }
      if (e.key === 'style') {
        let style = clean(p.style);
        if (!style.toLowerCase().includes('rendered in the style of')) {
          style = (style ? dotEnd(style) + ' ' : '') + `Rendered in the style of ${finalStyleStr}.`;
        } else {
          style = dotEnd(style);
        }
        obj.style = style;
        continue;
      }
      obj[e.key] = clean(p[e.key]);
    }
    enforceMaxChars(obj, maxPromptChars);
    return JSON.stringify(obj);   // 1 prompt = 1 dòng (JSON gọn, không xuống dòng)
  };

  const executeWithProvider = async (providerId: string): Promise<PromptItem[]> => {
    const processBatch = async (batch: Scene[], index: number): Promise<PromptItem[]> => {
      let pendingBatch = batch;
      let batchLoop = 0;
      const maxBatchLoops = operation.speedMode === 'fast' ? 3 : 2;
      const validItems: PromptItem[] = [];

      const charIndex = buildCharacterIndex(characters);
      const charByCanonical: Record<string, typeof charIndex[number]> = {};
      charIndex.forEach(c => { charByCanonical[c.canonical] = c; });

      const detectPresentChars = (s: Scene): string[] => {
        // 👉 So khớp KHÔNG DẤU để không bỏ sót khi AI viết tên kiểu romanized ("Son Tung").
        const haystack = foldText(`${s.sourceText || ''} ${s.visualDescription || ''} ${s.characterDetails || ''}`);
        const required = new Set<string>();
        for (const c of charIndex) {
          if ((c.aliasLower && haystack.includes(foldText(c.aliasLower))) || (c.promptLower && haystack.includes(foldText(c.promptLower))) || (c.originalLower && haystack.includes(foldText(c.originalLower)))) {
            required.add(c.canonical);
          }
        }
        return Array.from(required);
      };

      const fullDescriptionBlocks = (canonicalNames: string[]): string[] => {
        return canonicalNames.map(name => {
          const c = characters.find(x => (x.promptName?.trim() || x.name.trim()) === name);
          if (!c) return name;
          const parts = cleanCharacterParts(c);
          return parts.length ? `${name} (${parts.join(', ')})` : name;
        });
      };

      const validateNameAndRichness = (promptText: string, requiredNames: string[]): { ok: boolean; reason: string } => {
        const lower = promptText.toLowerCase();
        // LƯỚI CHẶN CỨNG 1: tên người thật (originalName) lọt vào prompt → loại, tạo lại.
        const foldedPrompt = foldText(promptText);
        for (const c of charIndex) {
          if (c.originalLower && foldText(c.originalLower) !== foldText(c.canonical) && containsFoldedName(foldedPrompt, c.originalLower)) {
            return { ok: false, reason: `leaked real name "${c.originalLower}" — must use canonical "${c.canonical}"` };
          }
        }
        // LƯỚI CHẶN CỨNG 2: hình ảnh cấm về chính sách (bạo lực/giấy tờ/chữ/đám đông).
        const bannedVis = findBannedVisual(promptText);
        if (bannedVis) return { ok: false, reason: `banned visual "${bannedVis}" — retell with people + setting instead` };
        // LƯỚI CHẶN CỨNG 3: nhân vật bắt buộc của cảnh phải có mặt trong prompt.
        for (const name of requiredNames) {
          if (!lower.includes(name.toLowerCase())) return { ok: false, reason: `missing name "${name}"` };
        }
        return { ok: true, reason: '' };
      };

      const hasAllRequiredFields = (pi: any): boolean => {
        // Chỉ đòi các thành tố CORE đang bật ('character' được phép rỗng — cảnh không người;
        // thành tố mở rộng thiếu thì bỏ qua, không bắt tạo lại).
        const need = ["sceneId", ...requiredCoreKeys];
        return need.every(k => pi[k] !== undefined && pi[k] !== null && (typeof pi[k] !== 'string' || pi[k].trim().length > 0));
      };

      const makePayload = (s: Scene) => {
        const present = detectPresentChars(s);
        const planDirective = planToDirective(visualPlans.get(s.id), present.length > 0);
        return {
          id: s.id,
          visualDescription: s.visualDescription,
          characterDetails: s.characterDetails,
          settingTime: s.settingTime,
          REQUIRED_NAMES_IN_PROMPT: present,
          REQUIRED_FULL_DESCRIPTIONS: fullDescriptionBlocks(present),
          ...(planDirective ? { VISUAL_PLAN: planDirective } : {})
        };
      };

      const pushAccepted = (pi: any, scene: Scene) => {
        // 👉 CHỐT CHẶN CUỐI (tất định) — mọi đường ra đều qua đây. Đơn giản:
        // 1) Nhét hậu tố người dùng (nếu có) vào cuối 'style'.
        if (customPromptSuffix.trim()) {
          const suffix = customPromptSuffix.trim();
          pi = { ...pi, style: `${(pi.style || '').trim()} ${suffix}`.trim() };
        }
        // 2) Ghép thành JSON, rồi sửa tất định trên chuỗi JSON: xóa từ "phim nhựa"
        //    (chống viền phim/xước) và quét tên người thật (chống lộ danh tính).
        let json = assembleFinalPrompt(pi);
        json = fixFilmLook(json);
        json = scrubRealNames(json, characters);
        validItems.push({
          sceneId: scene.id,
          sourceText: scene.sourceText,
          originalDescription: scene.visualDescription,
          generatedPrompt: json
        });
      };

      // (Sửa hiệu năng) Trần vòng lặp mẻ 3→2: nếu output trượt lưới thì thử lại nhiều nhất
      // 1 lần nữa rồi chấp nhận/đẩy xuống cứu hộ — cắt nửa số call thừa. Nhánh cứu hộ batch=1
      // phía dưới vẫn vá được cảnh sót nên không mất cảnh nào.
      while (pendingBatch.length > 0 && batchLoop < maxBatchLoops) {
        batchLoop++;
        try {
          const payload = pendingBatch.map(makePayload);
          const generated = await callAISafe<any[]>(
            `Generate structured prompts for:\n${JSON.stringify(payload)}\n`,
            systemInstruction, dynamicPromptSchema, 0.35, 'prompt', providerId, operation
          );

          const acceptedIds: number[] = [];
          for (const pi of generated) {
            const scene = pendingBatch.find(s => s.id === pi.sceneId);
            if (!scene) continue;
            if (!hasAllRequiredFields(pi) && batchLoop < maxBatchLoops) continue;

            const assembled = assembleFinalPrompt(pi);
            const required = detectPresentChars(scene);
            const verdict = validateNameAndRichness(assembled, required);
            if (!verdict.ok && batchLoop < maxBatchLoops) {
              continue;
            }

            pushAccepted(pi, scene);
            acceptedIds.push(pi.sceneId);
          }

          pendingBatch = pendingBatch.filter(s => !acceptedIds.includes(s.id));
        } catch (e: any) {
          const kind = classifyAIError(e).kind;
          if (operation.speedMode === 'fast' && batchLoop < maxBatchLoops && kind !== 'authentication' && kind !== 'client') continue;
          throw new Error(`Mẻ ${index + 1} thất bại: ${e.message || e}`);
        }
      }

      // 👉 CỨU HỘ TỪNG CẢNH: sau 3 vòng batch mà AI vẫn bỏ sót đúng vài cảnh
      // (thường do bị rớt khỏi mảng JSON khi gửi chung mẻ), ta gửi RIÊNG từng
      // cảnh (batch = 1). Cô lập như vậy giúp AI gần như luôn trả về đúng cảnh đó,
      // nên nút "Thử lại" mới thực sự vá được thay vì xoay rồi báo lỗi như cũ.
      if (pendingBatch.length > 0) {
        const stillPending: Scene[] = [];
        for (const scene of pendingBatch) {
          let rescued = false;
          const maxRescueAttempts = operation.speedMode === 'fast' ? 2 : 1;
          for (let attempt = 0; attempt < maxRescueAttempts && !rescued; attempt++) {
            try {
              const generated = await callAISafe<any[]>(
                `Generate structured prompts for:\n${JSON.stringify([makePayload(scene)])}\n`,
                systemInstruction, dynamicPromptSchema, 0.4, 'prompt', providerId, rescueOperation
              );
              const list = Array.isArray(generated) ? generated : [];
              const pi = list.find(g => g?.sceneId === scene.id) || list[0];
              if (pi && typeof pi.action === 'string' && pi.action.trim().length > 0) {
                pushAccepted({ ...pi, sceneId: scene.id }, scene);
                rescued = true;
              }
            } catch { /* để vòng sau / fallback cục bộ xử lý */ }
          }
          if (!rescued) stillPending.push(scene);
        }
        pendingBatch = stillPending;
      }

      // 👉 PHƯƠNG ÁN CUỐI: nếu AI vẫn không tạo nổi prompt cho cảnh (mạng/policy),
      // dựng prompt ngay từ dữ liệu đã có ở Bước 2 (visualDescription/settingTime đã
      // chứa sẵn mô tả nhân vật). Nhờ vậy KHÔNG BAO GIỜ kẹt "Bỏ sót" gây tắc cả đoạn.
      if (pendingBatch.length > 0) {
        for (const scene of pendingBatch) {
          pushAccepted({
            sceneId: scene.id,
            action: scene.visualDescription,
            character: scene.characterDetails || '',
            setting: scene.settingTime,
            time: '',
            camera_angle: 'eye-level',
            shot_size: 'medium shot',
            camera_movement: 'static',
            style: ''
          }, scene);
        }
        pendingBatch = [];
      }

      return validItems;
    };

    const resolvePromptBatch = async (batch: Scene[], index: number): Promise<PromptItem[]> => {
      operation.onProgress?.(`Đang tạo mẻ ${index + 1}/${batches.length} (${batch.length} cảnh)...`);
      try {
        return await processBatch(batch, index);
      } catch (error) {
        if (!shouldSplitPromptBatch(error, batch)) throw error;
        const midpoint = Math.ceil(batch.length / 2);
        operation.onProgress?.(`Mẻ ${index + 1} quá lớn; đang tách thành ${midpoint} + ${batch.length - midpoint} cảnh.`);
        const [left, right] = await Promise.all([
          resolvePromptBatch(batch.slice(0, midpoint), index),
          resolvePromptBatch(batch.slice(midpoint), index),
        ]);
        return [...left, ...right];
      }
    };

    const completedBatches: Array<PromptItem[] | undefined> = Array.from({ length: batches.length });
    const batchConcurrency = operation.speedMode === 'ultra-max' ? 4 : 1;
    await runWithWorkerPool(
      batches,
      batchConcurrency,
      async (batch, index) => {
        if (operation.signal?.aborted) throw operation.signal.reason;
        completedBatches[index] = await resolvePromptBatch(batch, index);
        const allResults = completedBatches.flatMap((items) => items || []).sort((a, b) => a.sceneId - b.sceneId);
        operation.onPartialPrompts?.(allResults);
        operation.onProgress?.(`Đã hoàn thành mẻ ${index + 1}/${batches.length} (${allResults.length}/${segment.scenes.length} prompt)`);
      },
      { shouldStop: () => Boolean(operation.signal?.aborted) },
    );

    return completedBatches.flatMap((items) => items || []).sort((a, b) => a.sceneId - b.sceneId);
  };

  const defaultProviderId = operation.providerId!;
  const allocationMessage = `Đang phân bổ vào ${AI_PROVIDERS[defaultProviderId]?.name || 'AI'}...`;
  onStatusUpdate?.(allocationMessage);
  operation.onProgress?.(allocationMessage);
  const items = await executeWithProvider(defaultProviderId);
  updateUsageStats({ prompts: items.length });
  return { items };
};

export const analyzeImageStyle = async (
  base64Image: string,
  mimeType: string,
  aiOptions?: AIOperationOptions,
) => {
  const operation = normalizeOperationOptions(aiOptions, DEFAULT_WORKFLOW_TIMEOUT_MS.style);
  const promptText = `You are an elite Art Director and Cinematographer. 
Analyze the uploaded image and extract ONLY its visual aesthetic.
CRITICAL RULES: 
1. DO NOT describe subjects, characters. 
2. Focus 100% on "HOW it was made/rendered".
3. The 'summary' MUST be ultra-short (under 30 characters), just 2-4 keywords defining the core art style (e.g., 'Cyberpunk 3D', 'Ghibli Anime', 'Oil painting').`; 

  const STYLE_SCHEMA = { 
      type: Type.OBJECT, 
      properties: { 
          medium_and_texture: { type: Type.STRING }, 
          color_and_lighting: { type: Type.STRING }, 
          atmosphere: { type: Type.STRING }, 
          analysis: { type: Type.STRING }, 
          summary: { type: Type.STRING, description: "Ultra-short core style keywords, max 30 chars. Example: 'Cinematic 35mm photography'" } 
      }, 
      required: ["medium_and_texture", "color_and_lighting", "atmosphere", "analysis", "summary"] 
  };
  
  const payload = [
    {
      role: "user",
      parts: [
        { inlineData: { data: base64Image, mimeType } },
        { text: promptText }
      ]
    }
  ];

  const result = await callAISafe<any>(payload, undefined, STYLE_SCHEMA, 0.2, 'scene', undefined, operation);
  return {
      analysis: result.analysis || "",
      summary: result.summary || ""
  };
};

export const extractContextFromScript = async (rawScript: string, aiOptions?: AIOperationOptions) => (await extractContextAndCharacters(rawScript, aiOptions)).context;
export const extractCharactersFromScript = async (rawScript: string, aiOptions?: AIOperationOptions) => (await extractContextAndCharacters(rawScript, aiOptions)).characters;
