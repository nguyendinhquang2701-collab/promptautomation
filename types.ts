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
  // 👉 true = người thật/nhân vật lịch sử có thật → promptName bị cưỡng chế thành
  // DANH XƯNG dạng "the ..." (không thể trùng tên khai sinh của bất kỳ ai).
  isRealPerson?: boolean;
  visualDescription: string;
  ethnicity?: string;
  clothing?: string;
}

export type SpeedMode = 'fast' | 'ultra';

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

// 👉 THÀNH TỐ PROMPT (người dùng tick chọn trong popup cài đặt).
// 2 cơ chế truyền dữ liệu vào prompt gửi đi:
//  - mode 'ai'    → thành tố được bơm vào SCHEMA + system instruction, AI viết nội dung
//                   RIÊNG cho từng cảnh (vd: lighting, mood).
//  - mode 'fixed' → giá trị CỐ ĐỊNH, code tự gắn thẳng vào JSON cuối, không tốn AI và
//                   không bao giờ sai (vd: aspect_ratio "16:9", no_logo).
export interface PromptElement {
  key: string;          // tên trường trong JSON prompt (snake_case, ascii)
  label: string;        // nhãn hiển thị tiếng Việt
  mode: 'ai' | 'fixed';
  enabled: boolean;
  core?: boolean;       // 8 thành tố gốc của app (mặc định BẬT)
  builtin?: boolean;    // có sẵn trong app — không xoá được, chỉ tick bật/tắt
  locked?: boolean;     // action: linh hồn của prompt — luôn bật
  value?: string;       // mode 'fixed': giá trị gắn vào prompt (người dùng sửa được)
  instruction?: string; // mode 'ai': hướng dẫn để AI viết trường này
}
