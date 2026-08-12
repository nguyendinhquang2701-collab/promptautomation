// ============================================================================
//  HỆ THỐNG MÃ KÍCH HOẠT (LICENSE) — logic thuần + REST tới Firebase RTDB
// ----------------------------------------------------------------------------
//  Nguyên tắc:
//   - Mỗi mã = 1 phiên đăng nhập DUY NHẤT. Kích hoạt ở máy mới => máy cũ bị "đá".
//   - Hạn dùng (expiresAt) được chốt NGAY LÚC TẠO MÃ, không đổi được từ client
//     (rule Firebase đóng băng). Client chỉ được ghi 2 trường: session, sessionAt.
//   - Thời gian so hạn LẤY TỪ SERVER (chống chỉnh đồng hồ máy). Không bao giờ
//     dùng Date.now() để xét hết hạn.
// ============================================================================

const DB_BASE = "https://planning-with-ai-367b2-default-rtdb.asia-southeast1.firebasedatabase.app";
const licUrl = (code: string) => `${DB_BASE}/veo3_licenses/${encodeURIComponent(code)}.json`;

// Bảng chữ tạo mã: bỏ 0 1 O I L U (dễ nhìn nhầm). 30 ký tự.
export const LICENSE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export type LicenseRecord = {
  plan?: string;
  durationDays?: number;   // 30 | 90 | 365 | 0 (0 = vĩnh viễn)
  createdAt?: number;
  expiresAt?: number;      // 0 = vĩnh viễn
  disabled?: boolean;
  session?: string | null;
  sessionAt?: number;
};

export type StoredLicense = { code: string; token: string };
export type LicenseState = 'ACTIVE' | 'EXPIRED' | 'KICKED' | 'REVOKED';

// ---------------------------------------------------------------------------
//  1) HÀM THUẦN (dễ test, không đụng mạng)
// ---------------------------------------------------------------------------

// Chuẩn hoá mã người dùng gõ: viết hoa, bỏ mọi ký tự không phải A-Z0-9 (dấu -, space...).
export const normalizeCode = (raw: string): string =>
  (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Đúng định dạng (12 ký tự chữ-số). Không kiểm alphabet để dễ tính, sai mã sẽ trượt ở bước tra DB.
export const isValidFormat = (code: string): boolean => /^[A-Z0-9]{12}$/.test(code);

// Hiển thị đẹp: A7KF-9QMT-4XBP
export const formatCodeDisplay = (code: string): string =>
  normalizeCode(code).replace(/(.{4})(?=.)/g, '$1-');

// Hết hạn? expiresAt=0 (hoặc thiếu) => vĩnh viễn => không bao giờ hết. serverNow phải là số.
export const isExpired = (expiresAt: unknown, serverNow: number | null): boolean =>
  typeof expiresAt === 'number' && expiresAt > 0 &&
  typeof serverNow === 'number' && serverNow > expiresAt;

// Đánh giá trạng thái. Thứ tự ưu tiên: REVOKED > EXPIRED > KICKED > ACTIVE.
export const evaluate = (
  record: LicenseRecord | null | undefined,
  tokenLocal: string,
  serverNow: number | null
): LicenseState => {
  if (!record || record.disabled === true) return 'REVOKED';
  if (isExpired(record.expiresAt, serverNow)) return 'EXPIRED';
  if (record.session !== tokenLocal) return 'KICKED';
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
// Trả về giờ server ước lượng, hoặc null nếu chưa từng neo (KHÔNG fallback Date.now cho việc xét hạn).
export const getServerNow = (): number | null =>
  _anchor ? _anchor.server + (nowPerf() - _anchor.perf) : null;

export const _resetAnchorForTest = (): void => { _anchor = null; };

// ---------------------------------------------------------------------------
//  3) TẠO MÃ / TOKEN (crypto)
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

export const genCode = (): string => {
  const a = new Uint32Array(12);
  cryptoObj().getRandomValues(a);
  let s = '';
  for (let i = 0; i < 12; i++) s += LICENSE_ALPHABET[a[i] % LICENSE_ALPHABET.length];
  return s;
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
export const saveStoredLicense = (v: StoredLicense): void => {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ code: v.code, token: v.token })); } catch {}
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

// Đọc bản ghi mã. Trả null nếu mã không tồn tại. Ném NetworkError nếu lỗi mạng.
export const getRecord = async (code: string): Promise<LicenseRecord | null> => {
  const res = await fetchJSON(licUrl(code), { method: 'GET' });
  return (res && typeof res === 'object') ? (res as LicenseRecord) : null;
};

// Lấy giờ server: PATCH sessionAt = timestamp sentinel, Firebase trả lại giá trị đã giải.
// (Chỉ đụng trường sessionAt — vô hại, rule cho phép.) Đồng thời neo đồng hồ.
export const probeServerTime = async (code: string): Promise<number> => {
  const res = await fetchJSON(licUrl(code), {
    method: 'PATCH',
    body: JSON.stringify({ sessionAt: { '.sv': 'timestamp' } }),
  });
  const t = res && typeof res.sessionAt === 'number' ? res.sessionAt : null;
  if (t === null) throw new NetworkError('no-server-time');
  setServerAnchor(t);
  return t;
};

// Chiếm phiên: ghi session = token của MÁY NÀY (đá máy cũ). Trả về giờ server từ echo.
export const claimSession = async (code: string, token: string): Promise<number | null> => {
  const res = await fetchJSON(licUrl(code), {
    method: 'PATCH',
    body: JSON.stringify({ session: token, sessionAt: { '.sv': 'timestamp' } }),
  });
  const t = res && typeof res.sessionAt === 'number' ? res.sessionAt : null;
  if (t !== null) setServerAnchor(t);
  return t;
};

// ---------------------------------------------------------------------------
//  6) TIỆN ÍCH HIỂN THỊ (dùng trong app / admin)
// ---------------------------------------------------------------------------
export const PLANS: { label: string; days: number }[] = [
  { label: '1 tháng', days: 30 },
  { label: '3 tháng', days: 90 },
  { label: '1 năm', days: 365 },
  { label: 'Vĩnh viễn', days: 0 },
];

export const planLabelFromDays = (d: number | undefined): string =>
  d === 0 ? 'Vĩnh viễn' : d === 30 ? '1 tháng' : d === 90 ? '3 tháng' : d === 365 ? '1 năm' : `${d} ngày`;
