import { GoogleGenAI, Type } from "@google/genai";
import { Scene, ColorStyle, CharacterIdentity, PromptItem } from "../types";

export interface ProviderConfig {
  id: string;
  name: string;
  type: 'gemini' | 'openai-compatible';
  model: string;
  baseUrl?: string;
  keyPrefix: string; 
  group: string; 
}

export interface PromptOptions {
  splitLogic?: string;
  audioMode?: 'remove' | 'keep';
}

export const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  'gpt-4o': { id: 'gpt-4o', name: 'ChatGPT 4o', type: 'openai-compatible', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', keyPrefix: 'openai', group: 'OpenAI' },
  'gpt-4o-mini': { id: 'gpt-4o-mini', name: 'ChatGPT 4o Mini', type: 'openai-compatible', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', keyPrefix: 'openai', group: 'OpenAI' },
  gemini: { id: 'gemini', name: 'Gemini 2.5 Flash', type: 'gemini', model: 'gemini-2.5-flash', keyPrefix: 'gemini', group: 'Google' },
  deepseek: { id: 'deepseek', name: 'Deepseek V3', type: 'openai-compatible', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', keyPrefix: 'deepseek', group: 'Deepseek' },
  grok: { id: 'grok', name: 'Grok 4.1', type: 'openai-compatible', model: 'grok-4-1-fast-reasoning', baseUrl: 'https://api.x.ai/v1', keyPrefix: 'grok', group: 'xAI' },
  mistral: { id: 'mistral', name: 'Mistral Large', type: 'openai-compatible', model: 'mistral-large-latest', baseUrl: 'https://api.mistral.ai/v1', keyPrefix: 'mistral', group: 'Mistral' }
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
            const customArr = JSON.parse(customStr);
            customArr.forEach((p: ProviderConfig) => {
                AI_PROVIDERS[p.id] = p;
            });
        }
        const envKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
        if (envKey && envKey.trim() !== '') {
            const currentKeysStr = localStorage.getItem('app1_gemini_api_keys');
            let currentKeys = currentKeysStr ? JSON.parse(currentKeysStr) : [];
            if (!currentKeys.includes(envKey)) {
                currentKeys.unshift(envKey);
                localStorage.setItem('app1_gemini_api_keys', JSON.stringify(currentKeys));
            }
        }
    } catch (e) {}
};

loadAIProviders();

const CONFIG = { SCENE_CONCURRENCY: 3, PROMPT_CONCURRENCY: 5, MAX_RETRIES: 3, BATCH_SIZE: 10 };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const getColorDescription = (style: ColorStyle): string => {
  switch (style) {
    case 'cinematic': return "HDR, deep shadows, balanced highlights, pro color grading, realistic textures";
    case 'hot':       return "Orange-red grading, high contrast, warm thermal, vivid hues";
    case 'warm':      return "Golden hour, amber tones, 3200K, hazy, soft warm lighting";
    case 'cold':      return "Blue-teal grading, 6500K, cool high-key lighting, stark contrast";
    default:          return "";
  }
};

const createConcurrencyLimiter = (defaultMax: number) => {
  let running = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const apiTier = localStorage.getItem('app1_api_tier') || 'paid';
    const maxConcurrent = apiTier === 'free' ? 1 : defaultMax;
    while (running >= maxConcurrent) await new Promise<void>(resolve => queue.push(resolve));
    running++;
    try { return await fn(); } finally { running--; if (queue.length > 0) queue.shift()!(); }
  };
};

const limitSceneConcurrency = createConcurrencyLimiter(CONFIG.SCENE_CONCURRENCY);
const limitPromptConcurrency = createConcurrencyLimiter(CONFIG.PROMPT_CONCURRENCY);

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

const FIREBASE_DB_URL = "https://planning-with-ai-367b2-default-rtdb.asia-southeast1.firebasedatabase.app/veo3_stats.json"; 
export const updateUsageStats = (updates: { input?: number; output?: number; cached?: number; calls?: number; scripts?: number; prompts?: number }) => {
  const record = { timestamp: Date.now(), input: updates.input || 0, output: updates.output || 0, cached: updates.cached || 0, calls: updates.calls || 0, scripts: updates.scripts || 0, prompts: updates.prompts || 0 };
  try {
    let historyStr = localStorage.getItem('veo3_usage_history');
    let history: any[] = historyStr ? JSON.parse(historyStr) : [];
    history.push(record);
    if (history.length > 5000) history = history.slice(history.length - 5000);
    localStorage.setItem('veo3_usage_history', JSON.stringify(history));
  } catch (e) {}
  if (FIREBASE_DB_URL && FIREBASE_DB_URL.startsWith("http")) fetch(FIREBASE_DB_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) }).catch(e => {});
};

const keyIndexes: Record<string, number> = {};

const callGeminiSafe = async <T>(contents: any, systemInstruction: string | undefined, schema: any, model: string, temperature = 0.5, limiter = limitSceneConcurrency, forcedProviderId: string): Promise<T> => {
  const providerConfig = AI_PROVIDERS[forcedProviderId];
  const executeCall = async () => {
    const keys = JSON.parse(localStorage.getItem(`app1_${providerConfig.keyPrefix}_api_keys`) || '[]');
    if (!keys || keys.length === 0) throw new Error(`[LỖI CẤU HÌNH] BẠN CHƯA CÓ API KEY CHO MODEL: ${providerConfig.name.toUpperCase()}`);
    if (keyIndexes[providerConfig.id] === undefined) keyIndexes[providerConfig.id] = 0;
    if (keyIndexes[providerConfig.id] >= keys.length) keyIndexes[providerConfig.id] = 0;
    const ai = new GoogleGenAI({ apiKey: keys[keyIndexes[providerConfig.id]] });
    const configData: any = { 
      responseMimeType: "application/json", maxOutputTokens: 8192, temperature, responseSchema: schema,
      safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }]
    };
    if (systemInstruction) configData.systemInstruction = systemInstruction;
    const response = await ai.models.generateContent({ model, contents, config: configData });
    if (response.usageMetadata) updateUsageStats({ input: response.usageMetadata.promptTokenCount, cached: response.usageMetadata.cachedContentTokenCount, output: response.usageMetadata.candidatesTokenCount, calls: 1 });
    return JSON.parse(sanitizeJSONString(response.text || "[]")) as T;
  };
  let initialKeysLen = Math.max(1, JSON.parse(localStorage.getItem(`app1_${providerConfig.keyPrefix}_api_keys`) || '[]').length);
  let maxRetries = Math.max(CONFIG.MAX_RETRIES, initialKeysLen * 3);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { return await limiter(executeCall); } 
    catch(error: any) {
      const status = error?.status || error?.code;
      if (status === 429) {
         const currentKeys = JSON.parse(localStorage.getItem(`app1_${providerConfig.keyPrefix}_api_keys`) || '[]');
         if (currentKeys.length > 1) { keyIndexes[providerConfig.id] = (keyIndexes[providerConfig.id] + 1) % currentKeys.length; await delay(1000); continue; } 
         else { if (attempt >= maxRetries) throw new Error(`LỖI 429: Key ${providerConfig.name} cạn Hạn ngạch.`); await delay(Math.min(2000 * Math.pow(2, attempt - 1), 15000)); continue; }
      }
      if ((status === 503 || status === 500) && attempt < maxRetries) { await delay(3000); continue; }
      throw error;
    }
  }
  throw new Error(`Lỗi mạng không xác định API Key ${providerConfig.name}.`);
};

const callOpenAISafe = async <T>(contents: any, systemInstruction: string | undefined, providerId: string, schema: any, temperature = 0.5, limiter = limitSceneConcurrency): Promise<T> => {
  const providerConfig = AI_PROVIDERS[providerId];
  if (!providerConfig) throw new Error(`[LỖI CẤU HÌNH] Không tìm thấy Model ID '${providerId}' trong hệ thống! Vui lòng chọn lại AI.`);

  const executeCall = async () => {
    const keys = JSON.parse(localStorage.getItem(`app1_${providerConfig.keyPrefix}_api_keys`) || '[]');
    if (!keys || keys.length === 0) throw new Error(`[LỖI CẤU HÌNH] BẠN CHƯA CÓ API KEY CHO MODEL: ${providerConfig.name.toUpperCase()}`);
    
    if (keyIndexes[providerConfig.id] === undefined) keyIndexes[providerConfig.id] = 0;
    if (keyIndexes[providerConfig.id] >= keys.length) keyIndexes[providerConfig.id] = 0;
    const currentApiKey = keys[keyIndexes[providerConfig.id]];
    
    let finalSystemInstruction = systemInstruction || "You are a helpful assistant.";
    finalSystemInstruction += `\n\nCRITICAL DIRECTIVE: You MUST output STRICTLY valid JSON matching the exact requested structure. Do not include markdown formatting like \`\`\`json. Do NOT add any preamble, greeting, explanation, or commentary (e.g. "I appreciate", "Sure", "Here is..."). Your entire response MUST start with '[' or '{' and end with ']' or '}'. Return only the raw JSON data.`;
    if (schema) finalSystemInstruction += `\nEXPECTED JSON SCHEMA FORMAT:\n${JSON.stringify(schema)}`;
    
    let messages: any[] = [{ role: "system", content: finalSystemInstruction }];
    
    if (typeof contents === 'string') {
        messages.push({ role: "user", content: contents });
    } else if (Array.isArray(contents) && contents[0]?.parts) {
        const parts = contents[0].parts;
        const textPart = parts.find((p: any) => p.text)?.text || "";
        const imagePart = parts.find((p: any) => p.inlineData);

        if (imagePart) {
            messages.push({
                role: "user",
                content: [
                    { type: "text", text: textPart },
                    { type: "image_url", image_url: { url: `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}` } }
                ]
            });
        } else {
             messages.push({ role: "user", content: textPart });
        }
    } else if (contents.parts) {
        const textPart = contents.parts.find((p: any) => p.text)?.text || "";
        const imagePart = contents.parts.find((p: any) => p.inlineData);
        if (imagePart) {
            messages.push({
                role: "user",
                content: [
                    { type: "text", text: textPart },
                    { type: "image_url", image_url: { url: `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}` } }
                ]
            });
        } else {
             messages.push({ role: "user", content: textPart });
        }
    } else {
        throw new Error("UNSUPPORTED_VISION");
    }
    
    const cleanBaseUrl = (providerConfig.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const targetUrl = `${cleanBaseUrl}/chat/completions`;
    
    const response = await fetch(targetUrl, { 
      method: 'POST', 
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${currentApiKey}` 
      }, 
      body: JSON.stringify({ 
        model: providerConfig.model, 
        messages: messages, 
        temperature: temperature
      }) 
    });
    
    if (!response.ok) {
        const textBody = await response.text(); 
        let errStr = textBody;
        try {
            const errObj = JSON.parse(textBody);
            errStr = errObj.error?.message || JSON.stringify(errObj);
        } catch(e) {}
        throw { status: response.status, details: errStr };
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "[]";
    let parsed = JSON.parse(sanitizeJSONString(text));

    if (schema && schema.type === Type.ARRAY && !Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null) {
        const arrayValues = Object.values(parsed).find(v => Array.isArray(v));
        parsed = arrayValues ? arrayValues : [];
    }

    return parsed as T;
  };
  
  const initialKeysLen = Math.max(1, JSON.parse(localStorage.getItem(`app1_${providerConfig.keyPrefix}_api_keys`) || '[]').length);
  const maxRetries = Math.max(CONFIG.MAX_RETRIES, initialKeysLen * 3);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { return await limiter(executeCall); } 
    catch(error: any) {
      if (error instanceof TypeError && error.message === 'Failed to fetch') {
          throw new Error(`Bị TRÌNH DUYỆT chặn kết nối (Lỗi CORS). Hãy kiểm tra lại link API hoặc bật tiện ích Allow CORS trên trình duyệt.`);
      }

      const status = error?.status || error?.response?.status;
      if (status === 429 || status === 402) { 
         const currentKeys = JSON.parse(localStorage.getItem(`app1_${providerConfig.keyPrefix}_api_keys`) || '[]');
         if (currentKeys.length > 1) { keyIndexes[providerConfig.id] = (keyIndexes[providerConfig.id] + 1) % currentKeys.length; await delay(1000); continue; } 
         else { if (attempt >= maxRetries) throw new Error(`LỖI 429/402: Key ${providerConfig.name} cạn Hạn ngạch.`); await delay(Math.min(2000 * Math.pow(2, attempt - 1), 15000)); continue; }
      }
      if ((status === 503 || status === 500 || status === 502) && attempt < maxRetries) { await delay(3000); continue; }
      
      if (error?.details) {
          throw new Error(`Server từ chối (HTTP ${status}): ${error.details}`);
      }
      
      if (error.message) throw error; 
      throw new Error(`Lỗi kết nối API ${providerConfig.name}: HTTP ${status || 'Unknown'}`);
    }
  }
  throw new Error(`Lỗi mạng không xác định API ${providerConfig.name}`);
};

const callAISafe = async <T>(contents: any, systemInstruction: string | undefined, schema: any, temperature = 0.5, limiter = limitSceneConcurrency, forcedProviderId?: string): Promise<T> => {
  const providerId = forcedProviderId || localStorage.getItem('app1_ai_provider') || Object.keys(AI_PROVIDERS)[0] || 'gemini';
  const providerConfig = AI_PROVIDERS[providerId] || AI_PROVIDERS[Object.keys(AI_PROVIDERS)[0]];
  if (providerConfig.type === 'openai-compatible') return await callOpenAISafe<T>(contents, systemInstruction, providerId, schema, temperature, limiter);
  return await callGeminiSafe<T>(contents, systemInstruction, schema, providerConfig.model, temperature, limiter, providerId);
};

const splitScriptByCode = (text: string, logic: string = 'default'): string[] => {
  if (logic === 'sentence') {
    const fragments = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?。]|\.{3}|…)\s+|\n+/);
    const chunks: string[] = [];
    let current = "";
    
    for (let frag of fragments) {
      frag = frag.trim();
      if (!frag) continue;

      current = current ? current + " " + frag : frag;

      if (current.length >= 60) {
        chunks.push(current);
        current = "";
      }
    }
    
    if (current) {
      if (chunks.length > 0 && current.length < 60) {
        chunks[chunks.length - 1] += " " + current;
      } else {
        chunks.push(current);
      }
    }
    return chunks.filter(c => c.replace(/[^a-zA-Z0-9\u00C0-\u1EF9]/g, '').length > 0);
  }

  const fragments = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?。])\s+|\n+/);
  const chunks: string[] = [];
  let current = "";
  for (let frag of fragments) {
    frag = frag.trim();
    if (!frag) continue;
    if (frag.length > 140) {
      if (current) { chunks.push(current); current = ""; }
      let remaining = frag;
      while (remaining.length > 140) {
        let targetPoint = Math.floor(remaining.length / 2);
        if (targetPoint > 80) targetPoint = 75; 
        let cutIndex = -1;
        for (let i = 0; i < 30; i++) {
          if (targetPoint + i < remaining.length && [',', ';', ':', '-', '—'].includes(remaining[targetPoint + i])) { cutIndex = targetPoint + i + 1; break; }
          if (targetPoint - i > 0 && [',', ';', ':', '-', '—'].includes(remaining[targetPoint - i])) { cutIndex = targetPoint - i + 1; break; }
        }
        if (cutIndex === -1) {
          for (let i = 0; i < 30; i++) {
            if (targetPoint + i < remaining.length && remaining[targetPoint + i] === ' ') { cutIndex = targetPoint + i; break; }
            if (targetPoint - i > 0 && remaining[targetPoint - i] === ' ') { cutIndex = targetPoint - i; break; }
          }
        }
        if (cutIndex === -1) cutIndex = 75;
        chunks.push(remaining.substring(0, cutIndex).trim());
        remaining = remaining.substring(cutIndex).trim();
      }
      if (remaining) current = remaining; 
      continue;
    }
    if (!current) { current = frag; } else {
      if (current.length < 40) { if (current.length + frag.length + 1 <= 120) { current += " " + frag; } else { chunks.push(current); current = frag; } } 
      else { chunks.push(current); current = frag; }
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(c => c.replace(/[^a-zA-Z0-9\u00C0-\u1EF9]/g, '').length > 0);
};

const SCENE_SCHEMA = { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { id: { type: Type.INTEGER }, visualDescription: { type: Type.STRING }, characterDetails: { type: Type.STRING }, settingTime: { type: Type.STRING }, duration: { type: Type.STRING, enum: ["8s"] } }, required: ["id", "visualDescription", "characterDetails", "settingTime", "duration"] } };
const PROMPT_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      sceneId: { type: Type.INTEGER },
      shot: { type: Type.STRING, description: "Shot size + neutral angle + lens + DOF, Medium/Wide preferred. e.g. 'Static medium-wide eye-level shot, 35mm, moderate depth of field'. Never a tight close-up on hands." },
      narrative: { type: Type.STRING, description: "One flowing paragraph. Introduce each character with their VERBATIM_BLOCK inline (first mention only), then give each ONE simple, stable action — woven together naturally. Keep actions calm and single (standing, sitting, looking, slowly turning, gently stirring); no fast or intricate motion. e.g. 'Cecily Alderton (slender 23-year-old English woman, warm ivory skin...) stands quietly by the window as Adrian Ashbourne (tall 35-year-old British Regent, broad-shouldered...) sits calmly at the desk, gaze lifting toward Cecily Alderton.' Do NOT list all characters first then write actions separately." },
      expression: { type: Type.STRING, description: "Subtle facial expression / emotional beat per character. Empty string if no person on screen." },
      setting: { type: Type.STRING, description: "Environment, period, weather, time of day, props in frame, plus any gentle environmental motion (smoke, steam, candle flicker, wind)." },
      lighting: { type: Type.STRING, description: "Light direction, color temperature, contrast, key/fill/rim, named scheme. Prefer soft over hard light." },
      camera_motion: { type: Type.STRING, description: "LOCKED camera: 'static lock-off' by default, or at most ONE single very slow push-in / pull-back. Never orbit, crane, tracking, handheld, whip pan, zoom, or drone." },
      style_tail: { type: Type.STRING, description: "Style summary + quality anchors. MUST end with the exact phrase: Rendered in the style of <styleSummary>." },
      _validation_subjects: { type: Type.STRING, description: "Comma-separated list of every CANONICAL_NAME that appears in this scene. Used for internal validation only." }
    },
    required: ["sceneId", "shot", "narrative", "setting", "lighting", "camera_motion", "style_tail", "_validation_subjects"]
  }
};

// 👉 TỪ VỰNG STOCK-SAFE: cố tình tiết chế. Ưu tiên medium/wide + camera tĩnh (tối đa
// 1 push-in/pull-back chậm) để tránh artifact. KHÔNG còn ECU/close-up bàn tay, KHÔNG
// còn orbit/crane/whip pan/handheld — đây là các nguồn gây lỗi thừa chi, méo tay, morph.
const CINEMATOGRAPHY_GLOSSARY = `=== STOCK-SAFE VISUAL GLOSSARY (pick vocabulary ONLY from these lists) ===
SHOT_SIZES (prefer the safe ones — Medium/Wide): Wide Shot (WS), Medium Long Shot (MLS), Medium Shot (MS), Long Shot (LS), Extreme Long Shot (ELS), establishing shot. AVOID close framing on people; NEVER frame tight on hands.
ANGLES (keep neutral): eye-level, slight low-angle, slight high-angle, straight-on / frontal, three-quarter front. AVOID Dutch tilt, worm's-eye, extreme overhead.
LENSES: 24mm wide, 35mm normal, 50mm standard. (Long tele / macro / fisheye NOT used — they exaggerate distortion.)
DOF: moderate depth of field, deep focus. (No rack focus, no split focus.)
CAMERA_MOTION (LOCKED — choose ONE): static lock-off (DEFAULT, preferred) OR one single very slow push-in OR one single very slow pull-back. Nothing else — no dolly-sideways, tracking, crane, jib, handheld, gimbal, orbit, whip pan, zoom, drone, POV.
ENVIRONMENTAL_MOTION (use this INSTEAD of body motion to keep the shot alive): drifting smoke, rising steam, flickering candle/firelight, wind stirring fabric or grass, falling dust motes, gentle ripples on water, slow-drifting clouds, embers floating.
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
- Give each person ONE single simple action, or a still, stable pose (standing, sitting, looking, slowly turning the head, gently stirring, slowly walking).
- Keep hands relaxed, low-detail, or out of tight framing. NEVER stage intricate finger work / counting / complex object manipulation in close view.
- Keep the number of people LOW and interaction MINIMAL. If several people are present, they mostly stand/sit calmly; no tangled group action.
- Prefer OBJECTS and ENVIRONMENTS as the subject when possible (props, landscapes, food, tools, architecture) — they morph far less than human bodies.
- Keep the shot alive with ENVIRONMENTAL_MOTION (smoke, steam, candle flicker, wind, ripples) rather than complex body motion.

AVOID (these are the top causes of AI artifacts):
- Tight close-ups of hands or faces performing detailed motion.
- Fast movement, running, fighting, dancing, sudden gestures (cause jelly/morphing).
- Crowds and dense multi-person interaction (faces and limbs merge).
- Elaborate armor/costume with heavy fine detail in close framing.
- Any camera move beyond a single very slow push-in / pull-back.
=== END ANTI-ARTIFACT RULE ===`;

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

The camera stays essentially LOCKED. It is either fully static (locked-off) or performs at most ONE single very slow push-in or pull-back — never orbit, crane, whip pan, handheld, or any fast/complex move. It stays on the SAME continuous moment in the SAME place. Multiple characters present in the SAME place at the SAME time is allowed, but they hold simple stable poses — that is still one moment.
=== END SINGLE-MOMENT RULE ===`;

// 👉 QUY TẮC AN TOÀN: TUYỆT ĐỐI không để tên người nổi tiếng / người thật ngoài đời
// (chính trị gia, ca sĩ, diễn viên, vận động viên, người nổi tiếng, nhân vật lịch sử có thật,
// thương hiệu gắn với người thật...) lọt vào BẤT KỲ khâu nào. Tên phải được thay bằng một
// tên hư cấu trung tính; chỉ được MÔ TẢ hình dáng/ngoại hình của nhân vật đó, không dùng tên thật.
const CELEBRITY_SAFETY_RULE = `=== REAL-PERSON / CELEBRITY NAME SAFETY (CRITICAL — POLICY) ===
Using the real name of an actual public figure violates content policy. This applies to politicians, musicians, actors, athletes, influencers, royalty, real historical people, and brand mascots tied to a real person.

RULES:
1. If a character is (or is named after) a REAL public figure, NEVER output their real name. Replace it with a NEUTRAL, INVENTED fictional name (e.g. "Marcus Vale", "Elena Hart"). Keep the substitution CONSISTENT — the same real person always maps to the same invented name everywhere.
2. The PHYSICAL DESCRIPTION (age, build, hair, skin, distinguishing features, clothing) of that person IS allowed and SHOULD be kept — convey the likeness through description, never through the name.
3. Purely fictional / original characters invented by the script keep their original name unchanged.
4. Never let a real public figure's name appear in ANY output field (names, narrative, setting, context, dialogue references). If such a name appears in the source text and is not a directory character, replace it with a generic descriptor (e.g. "a famous singer") — never the real name.
=== END REAL-PERSON NAME SAFETY ===`;

const buildCharacterProfiles = (characters: CharacterIdentity[]): string => {
  if (!characters || characters.length === 0) return '';
  return characters.map((c, i) => {
    const detailsArr: string[] = [];
    if (c.visualDescription?.trim()) detailsArr.push(c.visualDescription.trim());
    const eth = c.ethnicity?.trim().toLowerCase();
    if (eth && !['n/a', 'none', 'unspecified', 'không', 'null', 'undefined', '""'].includes(eth)) detailsArr.push(c.ethnicity!.trim());
    const clo = c.clothing?.trim().toLowerCase();
    if (clo && !['n/a', 'none', 'unspecified', 'không', 'null', 'undefined', '""'].includes(clo)) detailsArr.push(c.clothing!.trim());

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
    - SUBSEQUENT mentions → write bare CANONICAL_NAME "${targetName}" only. Never use a pronoun or generic noun ("the man", "the woman", "the figure", "the warrior").`;
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

export const extractContextAndCharacters = async (rawScript: string): Promise<{ context: string; characters: CharacterIdentity[] }> => {
  if (!rawScript || rawScript.trim().length === 0) return { context: "", characters: [] };
  try {
    const result = await callAISafe<any>(
      `SCRIPT:\n"${rawScript}"`, 
      `Analyze this script.
1. Extract a DENSE "globalContext" including: Year/Era, Specific Locations, Weather/Lighting variations, Overall Cinematic Atmosphere/Mood, and the core narrative arc. This context MUST anchor the visual consistency of the entire video. The globalContext MUST NOT contain the real name of any public figure (see REAL-PERSON NAME SAFETY) — use the invented substitute name or a generic descriptor instead.
2. Extract all distinct characters/subjects.

${CELEBRITY_SAFETY_RULE}

CRITICAL RULES:
1. Put the character's name into the "promptName" field. If the character is an ORIGINAL fictional character, copy the EXACT original name from the script (do NOT over-censor ordinary fictional names). If the character is (or is named after) a REAL public figure, put an INVENTED neutral fictional name here instead of the real name, and capture the person's recognizable look in "visualDescription".
1b. Put into "originalName" the exact name/reference EXACTLY as it literally appears in the script (for a real public figure, this is their REAL name). This field is used ONLY internally to find-and-replace that reference; it will never be shown. If the script gives no explicit name, leave it EMPTY "".
2. Put a safe, generic role alias in the "name" field (e.g., "The Protagonist", "The Horse", "The Villain").
3. ZERO-HALLUCINATION (CRITICAL): Extract ONLY physical traits explicitly mentioned or strongly implied in the script. DO NOT invent details like hair color or age if they are missing from the text.
4. "visualDescription" MUST follow this exact formula if details exist: "[Age/Gender/Species], [Body Type/Build], [Hair/Coat/Skin], [Key Features]". Keep it as a concise comma-separated list. If completely undefined, leave it EMPTY "".
5. For "ethnicity" and "clothing", extract strictly from the script. If NOT explicitly mentioned, leave the string EMPTY "". ABSOLUTELY DO NOT output "Unspecified", "N/A", or "None".
Output strictly valid JSON.`, 
      { type: Type.OBJECT, properties: { context: { type: Type.STRING }, characters: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, promptName: { type: Type.STRING }, originalName: { type: Type.STRING }, ethnicity: { type: Type.STRING }, clothing: { type: Type.STRING }, visualDescription: { type: Type.STRING } }, required: ["name", "promptName", "visualDescription"] } } }, required: ["context", "characters"] },
      0.4, limitSceneConcurrency); 
    updateUsageStats({ scripts: 1 });
    return { context: result.context || "", characters: (result.characters || []).map((c: any, index: number) => ({ id: `char-${index}-${Date.now()}`, ...c })) };
  } catch (e: any) { 
    if (e.message.includes("MISSING_") || e.message.includes("[LỖI CẤU HÌNH]")) throw e;
    return { context: "", characters: [] }; 
  }
};

export const analyzeSingleSegmentToScenes = async (segment: { id: string; content: string }, globalContext: string = '', options?: PromptOptions, characters: CharacterIdentity[] = []): Promise<Scene[]> => {
  const exactSourceTexts = splitScriptByCode(segment.content, options?.splitLogic);
  let allFinalScenes: Scene[] = [];
  let globalSceneId = 1;
  const batches: string[][] = [];
  for (let i = 0; i < exactSourceTexts.length; i += CONFIG.BATCH_SIZE) batches.push(exactSourceTexts.slice(i, i + CONFIG.BATCH_SIZE));

  const charProfiles = buildCharacterProfiles(characters);

  const chunkPromises = batches.map(async (batchTexts, index) => {
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

    while (pendingIndices.length > 0 && loopCount < 3) {
      loopCount++;
      const promptTexts = pendingIndices.map(i => `[ID: ${i + 1}] "${batchTexts[i]}"`).join('\n');
      
      const systemInstruction = `You are an expert AI Cinematographer.
I am giving you a list of EXACT text chunks from a script.
For EACH chunk, provide the camera angle (visualDescription <= 80 words), characterDetails, and settingTime.

${CELEBRITY_SAFETY_RULE}

${SINGLE_MOMENT_RULE}
The 'visualDescription' and 'settingTime' you write MUST describe only the ONE selected moment for that chunk — a single location and a single primary action. Never describe two places or a sequence of actions.

CONTEXT: ${globalContext}

${charProfiles ? `=== MASTER CHARACTER DIRECTORY (HARD ENFORCEMENT) ===
${charProfiles}
=== END DIRECTORY ===

CHARACTER MAPPING — MANDATORY:
1. PRONOUN RESOLUTION: For every pronoun in the chunk (he/she/it/they/him/her/hắn/nó/cô ấy/anh ấy/ông ấy/bà ấy/người này/người đó), determine which character from the Directory it refers to using the CONTEXT. Do NOT leave any pronoun unresolved.
2. NAME REPLACEMENT: Replace every reference to a Directory character (by ALIAS_IN_SCRIPT, by pronoun, or by generic noun) with the CANONICAL_NAME from the Directory.
3. FULL TRAITS INJECTION: In the 'visualDescription' AND 'characterDetails' fields, on the FIRST mention of each character that appears in the chunk, paste the FULL_DESCRIPTION_BLOCK exactly as shown between >>> and <<<. Do NOT shorten, paraphrase, summarize, or drop any clause. Copy verbatim.
4. ZERO-HALLUCINATION: Do not invent actions or details not present in the chunk. Only map names/pronouns and inject the Directory's FULL_DESCRIPTION_BLOCK.
5. characterDetails MUST list every Directory character present in the chunk, each one written as its FULL_DESCRIPTION_BLOCK verbatim.` : ''}

CRITICAL: Return a JSON array with EXACTLY ${pendingIndices.length} items. The 'id' in your JSON must exactly match the [ID: X] provided. DO NOT CHANGE THE TEXT.`;

      try { 
        const aiResults = await callAISafe<any[]>(`CONTEXT: ${globalContext}\n\nTEXT CHUNKS:\n${promptTexts}`, systemInstruction, SCENE_SCHEMA, 0.4, limitSceneConcurrency); 
        const successfulIds: number[] = [];
        
        for (const res of aiResults) {
          const idx = res.id - 1; 
          if (pendingIndices.includes(idx)) {
            validScenes[idx].visualDescription = res.visualDescription || "";
            validScenes[idx].characterDetails = res.characterDetails || "Contextual characters";
            validScenes[idx].settingTime = res.settingTime || "Contextual setting";
            if (validScenes[idx].visualDescription !== "") {
               successfulIds.push(idx);
            }
          }
        }
        pendingIndices = pendingIndices.filter(i => !successfulIds.includes(i));
      } 
      catch (e: any) { 
        if (e.message.includes("[LỖI CẤU HÌNH]") || e.message.includes("CORS")) throw e; 
        if (loopCount >= 3 && pendingIndices.length === batchTexts.length) throw e; 
      }
    }
    
    return { index, chunkScenes: validScenes };
  });

  const results = await Promise.allSettled(chunkPromises);
  let hasError = false;
  let errorMsg = "";
  const successfulResults: {index: number, chunkScenes: Scene[]}[] = [];

  results.forEach(res => {
    if (res.status === 'fulfilled') {
      successfulResults.push(res.value);
    } else {
      hasError = true; 
      errorMsg = String(res.reason); 
    }
  });

  if (hasError) throw new Error(errorMsg);

  successfulResults.sort((a, b) => a.index - b.index).forEach(res => { 
    res.chunkScenes.forEach(s => { allFinalScenes.push({ ...s, id: globalSceneId++ }); }); 
  });
  
  return allFinalScenes;
};

export const repairFailedScenes = async (failedScenes: Scene[], globalContext: string = '', options?: PromptOptions, characters: CharacterIdentity[] = []): Promise<Scene[]> => {
  if (failedScenes.length === 0) return [];
  
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

CONTEXT: ${globalContext}

${charProfiles ? `=== MASTER CHARACTER DIRECTORY (HARD ENFORCEMENT) ===
${charProfiles}
=== END DIRECTORY ===

CHARACTER MAPPING — MANDATORY:
1. PRONOUN RESOLUTION: For every pronoun in the chunk (he/she/it/they/him/her/hắn/nó/cô ấy/anh ấy/ông ấy/bà ấy/người này/người đó), determine which character from the Directory it refers to using the CONTEXT. Do NOT leave any pronoun unresolved.
2. NAME REPLACEMENT: Replace every reference to a Directory character (by ALIAS_IN_SCRIPT, by pronoun, or by generic noun) with the CANONICAL_NAME from the Directory.
3. FULL TRAITS INJECTION: In the 'visualDescription' AND 'characterDetails' fields, on the FIRST mention of each character that appears in the chunk, paste the FULL_DESCRIPTION_BLOCK exactly as shown between >>> and <<<. Do NOT shorten, paraphrase, summarize, or drop any clause. Copy verbatim.
4. ZERO-HALLUCINATION: Do not invent actions or details not present in the chunk. Only map names/pronouns and inject the Directory's FULL_DESCRIPTION_BLOCK.
5. characterDetails MUST list every Directory character present in the chunk, each one written as its FULL_DESCRIPTION_BLOCK verbatim.` : ''}

CRITICAL: Return a JSON array with EXACTLY ${pending.length} items. The 'id' must exactly match the [ID: X] provided. DO NOT CHANGE THE TEXT.`;

      try {
          const aiResults = await callAISafe<any[]>(`CONTEXT: ${globalContext}\n\nTEXT CHUNKS:\n${currentPrompt}`, systemInstruction, SCENE_SCHEMA, 0.4, limitSceneConcurrency);
          const successIds: number[] = [];
          
          for (const res of aiResults) {
              const scene = pending.find(s => s.id === res.id);
              if (scene && res.visualDescription) {
                  results.push({
                      ...scene,
                      visualDescription: res.visualDescription,
                      characterDetails: res.characterDetails || "Contextual characters",
                      settingTime: res.settingTime || "Contextual setting"
                  });
                  successIds.push(res.id);
              }
          }
          pending = pending.filter(s => !successIds.includes(s.id));
      } catch (e: any) {
          if (loopCount >= 2) throw e;
      }
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
  options?: PromptOptions
): Promise<{ items: PromptItem[], rescueProvider?: string }> => {
  if (segment.scenes.length === 0) return { items: [] };
  const colorMoodDesc = getColorDescription(colorStyle);
  
  const finalStyleStr = styleSummary ? styleSummary.trim() : 'Cinematic realistic 35mm';
  const techDetailsStr = styleAnalysis ? `Technical rendering details to follow: ${styleAnalysis}` : '';

  // BƠM TỪ ĐIỂN NHÂN VẬT VÀO BƯỚC CUỐI
  const charProfiles = buildCharacterProfiles(characters);

  const systemInstruction = `You are a Master Cinematography Prompt Engineer for Veo 3 video generation.
For each input scene, output a JSON object with these fields. The user's code assembles them into the final video prompt. OUTPUT STRICTLY VALID JSON.

OUTPUT FIELDS (all required, all in ENGLISH):
- sceneId          (integer, matches input id)
- shot             (shot size + angle + lens + DOF — pick from GLOSSARY vocabulary)
- narrative        (ONE flowing paragraph — the core of the prompt. See NARRATIVE RULE below.)
- expression       (facial expression / emotional beat per character; "" if no person on screen)
- setting          (period, location, weather, time of day, props, environmental texture)
- lighting         (direction, Kelvin, hardness, scheme — must integrate COLOR GRADING)
- camera_motion    (camera movement across the 8 seconds — pick from GLOSSARY vocabulary)
- style_tail       (style summary + quality anchors; MUST end with: "Rendered in the style of ${finalStyleStr}.")
- _validation_subjects (comma-separated list of every CANONICAL_NAME present in this scene)

${CELEBRITY_SAFETY_RULE}

${SINGLE_MOMENT_RULE}
Apply this to the 'narrative', 'setting' and 'camera_motion' fields: depict ONLY the single selected moment. If the input scene text implies several locations or actions, pick the one most important moment and write the prompt for that alone — silently drop the rest.

${ANTI_ARTIFACT_RULE}
Apply the ANTI-ARTIFACT RULE to every field: keep framing Medium/Wide, give each person one simple stable action, keep the camera locked, and lean on environmental motion. Being artifact-free outranks looking cinematic.

CONTEXT: ${globalContext}

COLOR GRADING: ${colorMoodDesc}
${techDetailsStr}

${CINEMATOGRAPHY_GLOSSARY}

${charProfiles ? `
=== MASTER CHARACTER DICTIONARY ===
${charProfiles}
=== END DICTIONARY ===

NARRATIVE RULE — how to write the 'narrative' field when characters are present:
The 'narrative' is ONE flowing paragraph. It must weave each character's VERBATIM_BLOCK together with ONE simple, stable action each — NOT list all characters first and actions after. Keep every action calm and single (standing, sitting, looking, slowly turning the head, gently holding an object). No fast, intricate, or multi-step motion. Interaction between people stays minimal.

PATTERN:
  "[Character A VERBATIM_BLOCK] [holds one simple pose / does one calm action], while [Character B VERBATIM_BLOCK] [holds one simple pose / does one calm action]; [Character A bare name] [keeps that single quiet action]."

HOW TO EMBED VERBATIM_BLOCK:
  - Take the exact string from the VERBATIM_BLOCK field in the Character Dictionary (the string inside the quotes "...").
  - Insert it at the first natural point in the sentence where the character is introduced.
  - Do NOT add, remove, or rephrase any word. Copy it character-for-character.
  - Second and later mentions of the same character: use only the bare CANONICAL_NAME — no pronoun, no generic noun.

EXAMPLE (3-character scene, follow this narrative pattern — note the calm, single actions):
  Dictionary:
    CANONICAL_NAME="Edmund", VERBATIM_BLOCK: "Edmund (distinguished 38-year-old English lord, dark swept hair, sharp jaw, tall lean frame, navy tailcoat)"
    CANONICAL_NAME="Lady Whitmore", VERBATIM_BLOCK: "Lady Whitmore (stately 55-year-old English matriarch, silver-streaked coiffure, burgundy silk gown, pearl choker)"
    CANONICAL_NAME="Clara", VERBATIM_BLOCK: "Clara (slender 22-year-old English woman, auburn ringlets, pale ivory skin, white empire-waist gown)"

  ✅ CORRECT narrative (medium-wide, everyone calm and mostly still):
    "In a medium-wide framing, Edmund (distinguished 38-year-old English lord, dark swept hair, sharp jaw, tall lean frame, navy tailcoat) stands quietly at the left with a steady, formal posture, while Lady Whitmore (stately 55-year-old English matriarch, silver-streaked coiffure, burgundy silk gown, pearl choker) sits composed in an armchair and Clara (slender 22-year-old English woman, auburn ringlets, pale ivory skin, white empire-waist gown) stands near the window; Edmund slowly turns Edmund's head toward the room's center as candle flames flicker and dust drifts in the soft light."

  ❌ WRONG (all descriptions first, actions after):
    "Edmund (distinguished lord). Lady Whitmore (stately matriarch). Clara (slender woman). Edmund stands... Lady Whitmore sits... Clara waits."
  ❌ WRONG (shortened VERBATIM_BLOCK):
    "Edmund (English lord in navy tailcoat) stands..."  — missing age, hair, jaw, frame.
  ❌ WRONG (pronoun used):
    "Edmund stands. He turns his head..." — must be "Edmund slowly turns Edmund's head".
  ❌ WRONG (busy / fast / intricate action):
    "Edmund strides across the hall gesturing sharply while Clara hurriedly counts coins in close-up." — too much motion, tight hand work → artifacts.

ABSOLUTE NAMING RULES:
A. Every CANONICAL_NAME in _validation_subjects MUST appear in 'narrative' at least once with its full VERBATIM_BLOCK on first mention.
B. VERBATIM_BLOCK must be copied exactly — every word, every comma. No shortening.
C. After first mention: bare CANONICAL_NAME only. NEVER pronouns (he/she/they/him/her/hắn/nó/cô ấy/anh ấy) or generic nouns ("the man", "the woman", "the figure").
D. If input has REQUIRED_FULL_DESCRIPTIONS, every string there must appear verbatim inside 'narrative'.
` : `
NARRATIVE RULE (no listed characters):
Write a calm, single-subject paragraph describing ONE main subject (prefer an object, prop, or environment) held in a stable shot over 8 seconds. Introduce the subject with full visual detail on first mention. Keep it alive with environmental motion (smoke, steam, wind, ripples, flickering light) rather than complex action.
`}

ABSOLUTE MANDATORY RULES:
1. ENGLISH ONLY in every field. DO NOT use Vietnamese anywhere.
1b. NO REAL-PERSON NAMES: never output the real name of any public figure/celebrity in any field — use only the invented CANONICAL_NAMEs from the dictionary or a generic descriptor (see REAL-PERSON NAME SAFETY). Their physical description is fine; their real name is not.
2. NO HALLUCINATION: do not invent characters, actions, or props not in the input.
3. STYLE TAIL must end exactly with: "Rendered in the style of ${finalStyleStr}."
4. 'lighting' must integrate the COLOR GRADING listed above.
5. No word "cut" anywhere. No location change, no time jump, no second action — ONE continuous moment only (see SINGLE-MOMENT RULE).
6. ARTIFACT-FREE OVER CINEMATIC: obey the ANTI-ARTIFACT RULE first. Pull vocabulary from the STOCK-SAFE GLOSSARY; keep framing Medium/Wide, camera locked, actions simple. Never trade safety for flair.
${options?.audioMode !== 'keep' ? '7. AMBIENT-ONLY AUDIO: describe ONLY visuals. No dialogue, quotes, on-screen text, voiceover. If sound is implied, treat it as quiet ambient environmental sound only — no dialogue, no music.' : ''}
DENSITY: narrative preserves every VERBATIM_BLOCK in full, but otherwise stays lean — one calm action per subject, no padding. Other fields: 1-3 tight sentences each.`;

  const PROMPT_BATCH_SIZE = 5;
  const batches: Scene[][] = [];
  for (let i = 0; i < segment.scenes.length; i += PROMPT_BATCH_SIZE) batches.push(segment.scenes.slice(i, i + PROMPT_BATCH_SIZE));

  // 👉 Cue KHẲNG ĐỊNH (consistent anatomy...) đặt trước, rồi mới tới danh sách phủ định
  // NGẮN & CỤ THỂ nhắm đúng lỗi hay gặp — theo đúng cách VEO 3 phản hồi tốt nhất.
  const NEGATIVE_TAIL = "Consistent anatomy, natural hand pose, stable proportions, steady motion. Avoid: extra limbs, extra fingers, deformed or fused hands, face warping, morphing, flicker, jitter, duplicated people, oversaturated colors, plastic skin, text, watermark, caption.";

  const assembleFinalPrompt = (p: any): string => {
    const clean = (s: any) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');
    const dotEnd = (s: string) => (!s ? '' : (/[.!?]$/.test(s) ? s : s + '.'));
    const segs: string[] = [];
    if (clean(p.shot)) segs.push(dotEnd(clean(p.shot)));
    if (clean(p.narrative)) segs.push(dotEnd(clean(p.narrative)));
    if (clean(p.expression)) segs.push(dotEnd("Expression: " + clean(p.expression)));
    if (clean(p.setting)) segs.push(dotEnd("Setting: " + clean(p.setting)));
    if (clean(p.lighting)) segs.push(dotEnd("Lighting: " + clean(p.lighting)));
    if (clean(p.camera_motion)) segs.push(dotEnd("Camera: " + clean(p.camera_motion)));
    let tail = clean(p.style_tail);
    const anchor = `Rendered in the style of ${finalStyleStr}.`;
    if (!tail.toLowerCase().includes(anchor.toLowerCase())) {
      tail = (tail ? dotEnd(tail) + ' ' : '') + anchor;
    } else {
      tail = dotEnd(tail);
    }
    segs.push(tail);
    segs.push(NEGATIVE_TAIL);
    return segs.join(' ');
  };

  const executeWithProvider = async (providerId: string): Promise<PromptItem[]> => {
    const batchPromises = batches.map(async (batch, index) => {
      let pendingBatch = batch;
      let batchLoop = 0;
      const validItems: PromptItem[] = [];

      const charIndex = buildCharacterIndex(characters);
      const charByCanonical: Record<string, typeof charIndex[number]> = {};
      charIndex.forEach(c => { charByCanonical[c.canonical] = c; });

      const detectPresentChars = (s: Scene): string[] => {
        const haystack = `${s.sourceText || ''} ${s.visualDescription || ''} ${s.characterDetails || ''}`.toLowerCase();
        const required = new Set<string>();
        for (const c of charIndex) {
          if ((c.aliasLower && haystack.includes(c.aliasLower)) || (c.promptLower && haystack.includes(c.promptLower)) || (c.originalLower && haystack.includes(c.originalLower))) {
            required.add(c.canonical);
          }
        }
        return Array.from(required);
      };

      const fullDescriptionBlocks = (canonicalNames: string[]): string[] => {
        return canonicalNames.map(name => {
          const c = characters.find(x => (x.promptName?.trim() || x.name.trim()) === name);
          if (!c) return name;
          const parts: string[] = [];
          if (c.visualDescription?.trim()) parts.push(c.visualDescription.trim());
          const eth = c.ethnicity?.trim().toLowerCase();
          if (eth && !['n/a','none','unspecified','không','null','undefined','""'].includes(eth)) parts.push(c.ethnicity!.trim());
          const clo = c.clothing?.trim().toLowerCase();
          if (clo && !['n/a','none','unspecified','không','null','undefined','""'].includes(clo)) parts.push(c.clothing!.trim());
          return parts.length ? `${name} (${parts.join(', ')})` : name;
        });
      };

      const validateNameAndRichness = (promptText: string, requiredNames: string[]): { ok: boolean; reason: string } => {
        const lower = promptText.toLowerCase();
        // LƯỚI CHẶN CỨNG: nếu tên thật (originalName, khác với tên hư cấu) lọt vào prompt → loại, tạo lại.
        for (const c of charIndex) {
          if (c.originalLower && c.originalLower.length >= 4 && c.originalLower !== c.canonical.toLowerCase() && lower.includes(c.originalLower)) {
            return { ok: false, reason: `leaked real name "${c.originalLower}" — must use canonical "${c.canonical}"` };
          }
        }
        for (const name of requiredNames) {
          if (!lower.includes(name.toLowerCase())) return { ok: false, reason: `missing name "${name}"` };
          const c = charByCanonical[name];
          if (!c || c.descTokens.length === 0) continue;
          const matched = c.descTokens.filter(t => lower.includes(t)).length;
          const ratio = matched / c.descTokens.length;
          if (ratio < 0.55) return { ok: false, reason: `description coverage for "${name}" only ${(ratio*100).toFixed(0)}%` };
        }
        return { ok: true, reason: '' };
      };

      const hasAllRequiredFields = (pi: any): boolean => {
        const need = ["sceneId", "shot", "narrative", "setting", "lighting", "camera_motion", "style_tail"];
        return need.every(k => pi[k] !== undefined && pi[k] !== null && (typeof pi[k] !== 'string' || pi[k].trim().length > 0));
      };

      const makePayload = (s: Scene) => {
        const present = detectPresentChars(s);
        return {
          id: s.id,
          visualDescription: s.visualDescription,
          characterDetails: s.characterDetails,
          settingTime: s.settingTime,
          REQUIRED_NAMES_IN_PROMPT: present,
          REQUIRED_FULL_DESCRIPTIONS: fullDescriptionBlocks(present)
        };
      };

      const pushAccepted = (pi: any, scene: Scene) => {
        let finalPromptStr = assembleFinalPrompt(pi);
        if (customPromptSuffix.trim()) {
           const suffix = customPromptSuffix.trim();
           if (finalPromptStr.endsWith('.')) {
               finalPromptStr = finalPromptStr.slice(0, -1) + ", " + suffix + ".";
           } else {
               finalPromptStr += ", " + suffix;
           }
        }
        validItems.push({
          sceneId: scene.id,
          sourceText: scene.sourceText,
          originalDescription: scene.visualDescription,
          generatedPrompt: `${scene.id}. ${finalPromptStr}`
        });
      };

      while (pendingBatch.length > 0 && batchLoop < 3) {
        batchLoop++;
        try {
          const payload = pendingBatch.map(makePayload);
          const generated = await callAISafe<any[]>(
            `Generate structured prompts for:\n${JSON.stringify(payload)}\n`,
            systemInstruction, PROMPT_SCHEMA, 0.35, limitPromptConcurrency, providerId
          );

          const acceptedIds: number[] = [];
          for (const pi of generated) {
            const scene = pendingBatch.find(s => s.id === pi.sceneId);
            if (!scene) continue;
            if (!hasAllRequiredFields(pi) && batchLoop < 3) continue;

            const assembled = assembleFinalPrompt(pi);
            const required = detectPresentChars(scene);
            const verdict = validateNameAndRichness(assembled, required);
            if (!verdict.ok && batchLoop < 3) {
              continue;
            }

            pushAccepted(pi, scene);
            acceptedIds.push(pi.sceneId);
          }

          pendingBatch = pendingBatch.filter(s => !acceptedIds.includes(s.id));
        } catch (e: any) {
          if (batchLoop >= 3) throw new Error(`Mẻ ${index + 1} quá tải: ${e.message}`);
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
          for (let attempt = 0; attempt < 2 && !rescued; attempt++) {
            try {
              const generated = await callAISafe<any[]>(
                `Generate structured prompts for:\n${JSON.stringify([makePayload(scene)])}\n`,
                systemInstruction, PROMPT_SCHEMA, 0.4, limitPromptConcurrency, providerId
              );
              const list = Array.isArray(generated) ? generated : [];
              const pi = list.find(g => g?.sceneId === scene.id) || list[0];
              if (pi && typeof pi.narrative === 'string' && pi.narrative.trim().length > 0) {
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
            narrative: scene.visualDescription,
            setting: scene.settingTime,
            style_tail: ''
          }, scene);
        }
        pendingBatch = [];
      }

      return validItems;
    });

    const results = await Promise.allSettled(batchPromises);
    const allResults: PromptItem[] = [];
    let hasError = false; let errorMsg = "";
    results.forEach(res => {
      if (res.status === 'fulfilled') allResults.push(...res.value);
      else { hasError = true; errorMsg = res.reason; }
    });
    if (hasError) throw new Error(errorMsg);
    
    return allResults.sort((a, b) => a.sceneId - b.sceneId);
  };

  const defaultProviderId = localStorage.getItem('app1_ai_provider') || Object.keys(AI_PROVIDERS)[0] || 'gemini';
  const apiTier = localStorage.getItem('app1_api_tier') || 'paid';
  
  try {
    if (onStatusUpdate) onStatusUpdate(`Đang phân bổ vào ${AI_PROVIDERS[defaultProviderId]?.name || 'AI'}...`);
    const items = await executeWithProvider(defaultProviderId);
    updateUsageStats({ prompts: items.length });
    return { items };
  } catch (error: any) {
    if (apiTier === 'paid' || error.message.includes("[LỖI CẤU HÌNH]")) throw error;

    const availableProviders = Object.values(AI_PROVIDERS).filter(p => {
       if (p.id === defaultProviderId) return false;
       const keys = JSON.parse(localStorage.getItem(`app1_${p.keyPrefix}_api_keys`) || '[]');
       return keys.length > 0;
    });

    const shuffled = availableProviders.sort(() => 0.5 - Math.random());
    let lastError = error;
    let currentFailedProvider = AI_PROVIDERS[defaultProviderId]?.name;

    for (const fallbackProv of shuffled) {
       try {
         if (onStatusUpdate) onStatusUpdate(`⚠️ ${currentFailedProvider} lỗi. Đang mượn ${fallbackProv.name} cứu hộ...`);
         const items = await executeWithProvider(fallbackProv.id);
         updateUsageStats({ prompts: items.length });
         return { items, rescueProvider: fallbackProv.name };
       } catch (fallbackError: any) {
         lastError = fallbackError;
         currentFailedProvider = fallbackProv.name; 
       }
    }
    throw new Error(`Mọi AI dự phòng đều đã sập. Cứu hộ thất bại! Chi tiết cuối: ${lastError.message}`);
  }
};

export const analyzeImageStyle = async (base64Image: string, mimeType: string) => {
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

  try {
    const result = await callAISafe<any>(payload, undefined, STYLE_SCHEMA, 0.2, limitSceneConcurrency);
    
    return { 
        analysis: result.analysis || "", 
        summary: result.summary || "" 
    };
    
  } catch (error: any) { 
    const currentProviderId = localStorage.getItem('app1_ai_provider') || 'gemini';
    
    if (currentProviderId !== 'gemini') {
        console.warn(`Model đang chọn từ chối phân tích ảnh. Kích hoạt cứu hộ nền bằng Gemini...`);
        try {
            const fallbackResult = await callAISafe<any>(payload, undefined, STYLE_SCHEMA, 0.2, limitSceneConcurrency, 'gemini');
            return { 
                analysis: fallbackResult.analysis || "", 
                summary: fallbackResult.summary || "" 
            };
        } catch (fallbackError: any) {
            throw new Error(`\n- AI đang chọn không hỗ trợ đọc ảnh.\n- Hệ thống cố cứu hộ bằng Gemini nhưng thất bại: ${fallbackError.message}`);
        }
    }
    
    throw error;
  }
};

export const extractContextFromScript = async (rawScript: string) => (await extractContextAndCharacters(rawScript)).context;
export const extractCharactersFromScript = async (rawScript: string) => (await extractContextAndCharacters(rawScript)).characters;
