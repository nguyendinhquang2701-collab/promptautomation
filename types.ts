// types.ts - Bản chuẩn Enterprise cho App Bán

export interface Scene {
  id: number;
  sourceText: string; 
  visualDescription: string;
  characterDetails: string;
  settingTime: string;
  duration: string;
  // 👉 CỜ TRẠNG THÁI MỚI: Báo hiệu UI đang xoay loading vá riêng cảnh này
  isRepairing?: boolean;
}

export interface CharacterIdentity {
  id: string;
  name: string;
  promptName?: string;
  // 👉 Tên/định danh y như trong kịch bản gốc (với người nổi tiếng đây là TÊN THẬT).
  // CHỈ dùng nội bộ để map & thay thế (redaction) — KHÔNG BAO GIỜ xuất ra prompt/video.
  originalName?: string;
  visualDescription: string;
  ethnicity?: string;
  clothing?: string;
}

export interface PromptItem {
  sceneId: number;
  sourceText?: string;
  originalDescription: string;
  generatedPrompt: string;
}

export type ColorStyle = 'default' | 'cinematic' | 'hot' | 'warm' | 'cold';

export type StepStatus = 'idle' | 'loading' | 'success' | 'error';

export interface ScriptProject {
  id: string;
  name: string;
  content: string;
  scenes: Scene[];
  promptItems: PromptItem[];
  // 👉 TÁCH TRẠNG THÁI: Bước 2 (chia cảnh) và Bước 3 (tạo prompt) độc lập nhau,
  // tránh lỗi của bước này hiển thị nhầm sang bước kia.
  sceneStatus: StepStatus;
  sceneErrorMessage?: string;
  promptStatus: StepStatus;
  promptErrorMessage?: string;
  loadingMessage?: string;
  rescueProvider?: string;
}

export enum AppState {
  INPUT = 'INPUT',
  SCENE_REVIEW = 'SCENE_REVIEW',
  RESULT = 'RESULT',
}

export interface PromptResult {
  rawText: string;
  prompts: string[];
}
