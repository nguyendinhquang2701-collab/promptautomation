// ============================================================================
//  HỆ THỐNG MÃ KÍCH HOẠT (LICENSE) — logic thuần + REST tới Firebase RTDB
// ----------------------------------------------------------------------------
//  Sơ đồ dữ liệu (khớp với công cụ admin Key_tool): veo3_licenses/{KEY}
//    { customerName, durationMs, createdAt, deviceId, deviceAt, expiresAt }
//
//  Nguyên tắc:
//   - Mỗi mã = 1 phiên DUY NHẤT. Kích hoạt ở máy mới => ghi đè deviceId =>
//     máy cũ lần kiểm tra kế tiếp thấy lệch => bị đăng xuất (chuyển máy tự do).
//   - HẠN DÙNG tính từ LÚC KÍCH HOẠT LẦN ĐẦU: expiresAt = giờ-kích-hoạt + durationMs.
//     durationMs = -1 => vĩnh viễn (không đặt expiresAt).
//   - So hạn theo GIỜ SERVER (neo bằng performance.now, KHÔNG dùng Date.now)
//     => khách chỉnh đồng hồ máy vô ích.
//   - Firebase để MỞ (không cần secret) cho đơn giản; client ghi trực tiếp.
// ============================================================================

const DB_BASE = "https://planning-with-ai-367b2-default-rtdb.asia-southeast1.firebasedatabase.app";
const licUrl = (code: string) => `${DB_BASE}/veo3_licenses/${encodeURIComponent(code)}.json`;

export type LicenseRecord = {
  customerName?: string;
  durationMs?: number;     // -1 = vĩnh viễn
  createdAt?: number;
  deviceId?: string | null; // token của máy đang giữ phiên
  deviceAt?: number;        // giờ server lần chiếm phiên gần nhất
  expiresAt?: number | null; // null/thiếu = chưa kích hoạt hoặc vĩnh viễn
};

export type StoredLicense = { code: string; token: string };
export type LicenseState = 'ACTIVE' | 'EXPIRED' | 'KICKED' | 'REVOKED';

// ---------------------------------------------------------------------------
//  1) HÀM THUẦN (dễ test, không đụng mạng)
// ---------------------------------------------------------------------------

// Chuẩn hoá mã: viết hoa, bỏ khoảng trắng + ký tự Firebase cấm (. $ # [ ] /). Giữ dấu '-'.
export const normalizeCode = (raw: string): string =>
  (raw || '').toUpperCase().replace(/[\s.$#\[\]/]/g, '').trim();

// Đúng định dạng: bắt đầu bằng chữ/số, cho phép chữ-số và dấu '-', dài >= 4 (vd PRO-A7K9QM).
export const isValidFormat = (code: string): boolean => /^[A-Z0-9][A-Z0-9-]{2,}$/.test(code);

// Hiển thị: giữ nguyên (mã đã có sẵn dấu '-' từ tiền tố).
export const formatCodeDisplay = (code: string): string => normalizeCode(code);

// Hết hạn? expiresAt không phải số dương => vĩnh viễn/chưa kích hoạt => không hết. serverNow phải là số.
export const isExpired = (expiresAt: unknown, serverNow: number | null): boolean =>
  typeof expiresAt === 'number' && expiresAt > 0 &&
  typeof serverNow === 'number' && serverNow > expiresAt;

// Đánh giá trạng thái. Ưu tiên: REVOKED > EXPIRED > KICKED > ACTIVE.
export const evaluate = (
  record: LicenseRecord | null | undefined,
  tokenLocal: string,
  serverNow: number | null
): LicenseState => {
  if (!record) return 'REVOKED';                       // bị thu hồi (xoá khỏi DB)
  if (isExpired(record.expiresAt, serverNow)) return 'EXPIRED';
  if (record.deviceId !== tokenLocal) return 'KICKED'; // máy khác đã chiếm phiên
  return 'ACTIVE';
};

// ---------------------------------------------------------------------------
//  2) ĐỒNG HỒ SERVER — mỏ neo bằng performance.now() (đơn điệu, chống lùi đồng hồ)
// ---------------------------------------------------------------------------
let _anchor: { server: number; perf: number } | null = null;
const nowPerf = (): number =>
  (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : 0;

export const setServerAnchor = (serverMs: number): void => {
  if (typeof serverMs === 'number' && isFinite(serverMs) && serverMs > 0) {
    _anchor = { server: serverMs, perf: nowPerf() };
  }
};
// Giờ server ước lượng, hoặc null nếu chưa neo (KHÔNG fallback Date.now cho việc xét hạn).
export const getServerNow = (): number | null =>
  _anchor ? _anchor.server + (nowPerf() - _anchor.perf) : null;

export const _resetAnchorForTest = (): void => { _anchor = null; };

// ---------------------------------------------------------------------------
//  3) TOKEN thiết bị (crypto)
// ---------------------------------------------------------------------------
const cryptoObj = (): Crypto => {
  const c = (typeof crypto !== 'undefined' ? crypto : (globalThis as any).crypto);
  if (!c || !c.getRandomValues) throw new Error('crypto.getRandomValues không khả dụng');
  return c;
};

export const genToken = (): string => {
  const a = new Uint8Array(16);
  cryptoObj().getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
};

// ---------------------------------------------------------------------------
//  4) LƯU TRỮ TRÊN MÁY
// ---------------------------------------------------------------------------
const LS_KEY = 'app1_license';

export const readStoredLicense = (): StoredLicense | null => {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (!s) return null;
    const o = JSON.parse(s);
    return (o && typeof o.code === 'string' && typeof o.token === 'string') ? { code: o.code, token: o.token } : null;
  } catch { return null; }
};
// Lưu mã. Trả TRUE nếu ghi thành công (đã đọc lại kiểm chứng). Nếu bộ nhớ đầy,
// dọn ảnh xem trước (nặng nhất) rồi thử lại — KHÔNG được để mã lưu hụt âm thầm,
// vì lưu hụt = lần sau mở lại bắt nhập mã oan.
export const saveStoredLicense = (v: StoredLicense): boolean => {
  const payload = JSON.stringify({ code: v.code, token: v.token });
  const tryWrite = (): boolean => {
    try {
      localStorage.setItem(LS_KEY, payload);
      return localStorage.getItem(LS_KEY) === payload;
    } catch { return false; }
  };
  if (tryWrite()) return true;
  try { localStorage.removeItem('app1_imagePreview'); } catch {}
  return tryWrite();
};
export const clearStoredLicense = (): void => {
  try { localStorage.removeItem(LS_KEY); } catch {}
};

// ---------------------------------------------------------------------------
//  5) REST tới Firebase (có timeout, phân biệt lỗi mạng)
// ---------------------------------------------------------------------------
export class NetworkError extends Error {}

const fetchJSON = async (url: string, opts: RequestInit = {}, ms = 15000): Promise<any> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  let resp: Response;
  try {
    resp = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
  } catch {
    clearTimeout(t);
    throw new NetworkError('network');
  }
  clearTimeout(t);
  if (!resp.ok) throw new NetworkError('http ' + resp.status);
  const text = await resp.text();
  if (!text || text === 'null') return null;
  try { return JSON.parse(text); } catch { throw new NetworkError('bad-json'); }
};

// Đọc bản ghi mã. null nếu không tồn tại. Ném NetworkError nếu lỗi mạng.
export const getRecord = async (code: string): Promise<LicenseRecord | null> => {
  const res = await fetchJSON(licUrl(code), { method: 'GET' });
  return (res && typeof res === 'object') ? (res as LicenseRecord) : null;
};

// Lấy giờ server: PATCH deviceAt = timestamp sentinel, Firebase trả lại giá trị đã giải. Đồng thời neo đồng hồ.
export const probeServerTime = async (code: string): Promise<number> => {
  const res = await fetchJSON(licUrl(code), {
    method: 'PATCH',
    body: JSON.stringify({ deviceAt: { '.sv': 'timestamp' } }),
  });
  const t = res && typeof res.deviceAt === 'number' ? res.deviceAt : null;
  if (t === null) throw new NetworkError('no-server-time');
  setServerAnchor(t);
  return t;
};

// Chiếm phiên: ghi deviceId = token máy này (đá máy cũ). extra = { expiresAt } khi kích hoạt lần đầu.
// Trả về giờ server từ echo (deviceAt).
export const claimSession = async (
  code: string, token: string, extra: Record<string, any> = {}
): Promise<number | null> => {
  const res = await fetchJSON(licUrl(code), {
    method: 'PATCH',
    body: JSON.stringify({ deviceId: token, deviceAt: { '.sv': 'timestamp' }, ...extra }),
  });
  const t = res && typeof res.deviceAt === 'number' ? res.deviceAt : null;
  if (t !== null) setServerAnchor(t);
  return t;
};

// ---------------------------------------------------------------------------
//  6) TIỆN ÍCH HIỂN THỊ
// ---------------------------------------------------------------------------
export const planLabelFromMs = (ms: number | undefined): string => {
  if (ms === -1) return 'Vĩnh viễn';
  if (ms === 3600000) return '1 giờ';
  if (ms === 604800000) return '7 ngày';
  if (ms === 2592000000) return '1 tháng';
  if (ms === 7776000000) return '3 tháng';
  if (ms === 31536000000) return '1 năm';
  if (typeof ms === 'number' && ms > 0) return `${Math.round(ms / 86400000)} ngày`;
  return '-';
};
