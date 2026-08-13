import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeCode, isValidFormat, formatCodeDisplay, isExpired, evaluate,
  getServerNow, probeServerTime, getRecord, claimSession, genToken,
  readStoredLicense, saveStoredLicense, clearStoredLicense,
  NetworkError, LicenseState, StoredLicense,
} from '../services/licenseService';

// Các "màn" của cổng kích hoạt.
type Screen = 'boot' | 'form' | 'active' | 'expired' | 'revoked' | 'kicked' | 'network';

const POLL_MS = 30000;

const LicenseGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 👉 BOOT LẠC QUAN: máy đã có mã lưu thì VÀO THẲNG app ngay, không hiện màn nào.
  // Việc kiểm tra (đá/hết hạn/thu hồi) chạy NGẦM; chỉ chặn khi có kết luận XÁC ĐỊNH.
  // Nhờ vậy: đã nhập mã rồi thì không bao giờ bắt nhập lại, và vẫn dùng được cả khi mạng chập chờn.
  const bootHasLicense = useMemo(() => !!readStoredLicense(), []);

  const [screen, setScreen] = useState<Screen>(bootHasLicense ? 'active' : 'form');
  const [everActive, setEverActive] = useState(bootHasLicense);
  const [codeInput, setCodeInput] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const everActiveRef = useRef(bootHasLicense);
  const runningRef = useRef(false);
  const claimingRef = useRef(false);          // đang kích hoạt/chuyển máy => tạm khoá verify nền (tránh "kicked" oan)
  const nullCountRef = useRef(0);             // đếm số lần getRecord trả null liên tiếp (chống thu hồi oan do blip)
  const lastGoodRef = useRef<StoredLicense | null>(readStoredLicense()); // mã đọc được gần nhất (dự phòng khi đọc lỗi)

  const goActive = useCallback(() => {
    everActiveRef.current = true;
    setEverActive(true);
    setScreen('active');
    setFormError('');
  }, []);

  // Kiểm tra ngầm trạng thái mã đang lưu. Đã vào app rồi (everActive) thì lỗi mạng
  // KHÔNG hạ màn — chỉ đổi trạng thái khi có kết luận xác định (đá/hết hạn/thu hồi).
  const runVerify = useCallback(async () => {
    if (runningRef.current || claimingRef.current) return; // đang kích hoạt thì đừng verify chen ngang
    runningRef.current = true;
    try {
      // Đọc mã. Nếu đọc HỤT (null) mà đã vào app rồi => coi là lỗi tạm (Safari ẩn danh,
      // bộ nhớ, hoặc tab khác đăng xuất) => GIỮ app, dùng lại mã tốt gần nhất. Chỉ hiện
      // form khi CHƯA từng kích hoạt (thật sự chưa có mã).
      const readNow = readStoredLicense();
      const stored = readNow || (everActiveRef.current ? lastGoodRef.current : null);
      if (!stored) { if (!everActiveRef.current) setScreen('form'); return; }
      if (readNow) lastGoodRef.current = readNow;

      let rec;
      try { rec = await getRecord(stored.code); }
      catch (e) {
        if (e instanceof NetworkError) {
          // Đang chạy thì GIỮ nguyên trạng thái (đừng đá oan vì mạng chập chờn).
          if (!everActiveRef.current) setScreen('network');
        }
        return;
      }

      if (rec === null) {
        // null = mã không có trên server (đã thu hồi). Nhưng cũng có thể là blip 1 nhịp:
        // đã vào app rồi thì phải trả null 2 nhịp LIÊN TIẾP mới kết luận thu hồi.
        if (everActiveRef.current) {
          nullCountRef.current += 1;
          if (nullCountRef.current >= 2) setScreen('revoked');
        } else {
          setScreen('revoked');
        }
        return;
      }
      nullCountRef.current = 0; // có bản ghi thật => reset đếm blip

      let sNow = getServerNow();
      if (sNow === null) {
        try { sNow = await probeServerTime(stored.code); }
        catch (e) {
          if (e instanceof NetworkError && !everActiveRef.current) setScreen('network');
          return;
        }
      }

      const state: LicenseState = evaluate(rec, stored.token, sNow);
      if (state === 'ACTIVE') goActive();
      else if (state === 'EXPIRED') setScreen('expired');
      else if (state === 'REVOKED') setScreen('revoked');
      else setScreen('kicked');
    } finally {
      runningRef.current = false;
    }
  }, [goActive]);

  // Vòng đời: kiểm tra ban đầu + poll định kỳ + khi tab hiện lại / focus / đổi ở tab khác.
  useEffect(() => {
    runVerify();
    const iv = setInterval(() => { runVerify(); }, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') runVerify(); };
    const onFocus = () => runVerify();
    const onStorage = (e: StorageEvent) => { if (e.key === 'app1_license') runVerify(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
    };
  }, [runVerify]);

  // Kích hoạt / chiếm phiên bằng 1 mã.
  const doClaim = useCallback(async (rawCode: string) => {
    claimingRef.current = true;  // khoá verify nền suốt quá trình chiếm phiên (tránh "kicked" oan)
    setBusy(true);
    setFormError('');
    try {
      const code = normalizeCode(rawCode);
      if (!isValidFormat(code)) { setFormError('Mã không đúng định dạng.'); return; }

      let rec;
      try { rec = await getRecord(code); }
      catch { setFormError('Lỗi mạng — kiểm tra kết nối rồi thử lại.'); return; }

      if (rec === null) { setFormError('Mã không tồn tại.'); return; }

      // Lấy giờ server (bắt buộc, để tính/so hạn theo server).
      let sNow = getServerNow();
      if (sNow === null) {
        try { sNow = await probeServerTime(code); }
        catch { setFormError('Lỗi mạng — kiểm tra kết nối rồi thử lại.'); return; }
      }
      if (isExpired(rec.expiresAt, sNow)) { setFormError('Mã đã hết hạn sử dụng.'); return; }

      // Kích hoạt LẦN ĐẦU (chưa có expiresAt và không vĩnh viễn) => chốt hạn từ bây giờ.
      const extra: Record<string, any> = {};
      const notYetActivated = typeof rec.expiresAt !== 'number';
      if (notYetActivated && typeof rec.durationMs === 'number' && rec.durationMs > 0) {
        extra.expiresAt = sNow + rec.durationMs;
      }

      const token = genToken();
      try { await claimSession(code, token, extra); }
      catch { setFormError('Lỗi mạng — kiểm tra kết nối rồi thử lại.'); return; }

      // Lưu mã và KIỂM CHỨNG đã lưu được. Nếu bộ nhớ đầy không lưu nổi => báo rõ,
      // KHÔNG cho vào app (nếu không lần sau mở lại sẽ bắt nhập mã oan).
      const saved = saveStoredLicense({ code, token });
      if (!saved) {
        setFormError('Không lưu được mã trên máy này (bộ nhớ trình duyệt đầy). Hãy bấm "Xóa Trắng" để dọn bớt rồi thử lại.');
        return;
      }
      lastGoodRef.current = { code, token };
      nullCountRef.current = 0;
      setCodeInput('');
      goActive();
    } finally {
      claimingRef.current = false;
      setBusy(false);
    }
  }, [goActive]);

  const logoutToForm = useCallback(() => {
    clearStoredLicense();       // chỉ xoá mã, GIỮ nguyên bản nháp kịch bản của người dùng
    setFormError('');
    setCodeInput('');
    setScreen('form');
  }, []);

  const reclaimHere = useCallback(() => {
    const stored = readStoredLicense();
    if (stored) doClaim(stored.code);
    else setScreen('form');
  }, [doClaim]);

  // ----- GIAO DIỆN -----
  const isBlocking = screen !== 'active';
  const showChildren = everActive; // đã từng vào app thì GIỮ app dưới lớp phủ để không mất việc đang làm

  return (
    <>
      {showChildren && children}
      {isBlocking && (
        <div style={overlayStyle(everActive)}>
          <div style={cardStyle}>
            {screen === 'boot' && (
              <>
                <div style={spinnerStyle} />
                <p style={{ color: '#cbd5e1', marginTop: 16 }}>Đang kiểm tra bản quyền…</p>
              </>
            )}

            {screen === 'network' && (
              <>
                <div style={iconStyle}>📡</div>
                <h2 style={titleStyle}>Không kết nối được máy chủ</h2>
                <p style={descStyle}>Hãy kiểm tra mạng rồi thử lại.</p>
                <button style={primaryBtn} onClick={() => runVerify()} disabled={busy}>Thử lại</button>
              </>
            )}

            {screen === 'form' && (
              <>
                <div style={iconStyle}>🔑</div>
                <h2 style={titleStyle}>Nhập mã kích hoạt</h2>
                <p style={descStyle}>Dán mã bạn đã mua để bắt đầu sử dụng.</p>
                <input
                  style={inputStyle}
                  value={formatCodeDisplay(codeInput)}
                  onChange={(e) => setCodeInput(normalizeCode(e.target.value).slice(0, 40))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !busy) doClaim(codeInput); }}
                  placeholder="VD: PRO-A7K9QM"
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                />
                {formError && <p style={errStyle}>{formError}</p>}
                <button style={primaryBtn} onClick={() => doClaim(codeInput)} disabled={busy || !codeInput}>
                  {busy ? 'Đang kích hoạt…' : 'Kích hoạt'}
                </button>
              </>
            )}

            {screen === 'kicked' && (
              <>
                <div style={iconStyle}>🔒</div>
                <h2 style={titleStyle}>Mã đang được dùng ở nơi khác</h2>
                <p style={descStyle}>Mỗi mã chỉ đăng nhập được ở một nơi cùng lúc. Nhấn nút dưới để chuyển về máy này (nơi kia sẽ bị đăng xuất).</p>
                {formError && <p style={errStyle}>{formError}</p>}
                <button style={primaryBtn} onClick={reclaimHere} disabled={busy}>
                  {busy ? 'Đang chuyển…' : 'Dùng ở máy này'}
                </button>
                <button style={ghostBtn} onClick={logoutToForm} disabled={busy}>Nhập mã khác</button>
              </>
            )}

            {screen === 'expired' && (
              <>
                <div style={iconStyle}>⏳</div>
                <h2 style={titleStyle}>Mã đã hết hạn</h2>
                <p style={descStyle}>Mã kích hoạt của bạn đã hết thời gian sử dụng.</p>
                <button style={primaryBtn} onClick={() => runVerify()} disabled={busy}>Thử lại</button>
                <button style={ghostBtn} onClick={logoutToForm} disabled={busy}>Nhập mã khác</button>
              </>
            )}

            {screen === 'revoked' && (
              <>
                <div style={iconStyle}>🚫</div>
                <h2 style={titleStyle}>Mã không còn hiệu lực</h2>
                <p style={descStyle}>Mã này đã bị khoá hoặc không tồn tại.</p>
                <button style={primaryBtn} onClick={() => runVerify()} disabled={busy}>Thử lại</button>
                <button style={ghostBtn} onClick={logoutToForm} disabled={busy}>Nhập mã khác</button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
};

// ----- style nội tuyến (độc lập CSS của app) -----
const overlayStyle = (over: boolean): React.CSSProperties => ({
  position: 'fixed', inset: 0, zIndex: 2147483000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 20,
  background: over ? 'rgba(2,6,23,0.72)' : 'linear-gradient(135deg,#0f172a,#1e293b)',
  backdropFilter: over ? 'blur(6px)' : undefined,
});
const cardStyle: React.CSSProperties = {
  width: '100%', maxWidth: 400, background: '#0b1220',
  border: '1px solid #1e293b', borderRadius: 16, padding: '32px 28px',
  textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
};
const iconStyle: React.CSSProperties = { fontSize: 44, marginBottom: 8 };
const titleStyle: React.CSSProperties = { color: '#f1f5f9', fontSize: 20, fontWeight: 700, margin: '4px 0 8px' };
const descStyle: React.CSSProperties = { color: '#94a3b8', fontSize: 14, lineHeight: 1.5, margin: '0 0 18px' };
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '13px 14px', fontSize: 18,
  letterSpacing: 2, textAlign: 'center', fontWeight: 600,
  background: '#020617', color: '#f8fafc', border: '1px solid #334155',
  borderRadius: 10, outline: 'none', textTransform: 'uppercase',
};
const errStyle: React.CSSProperties = { color: '#f87171', fontSize: 13, margin: '10px 0 0' };
const primaryBtn: React.CSSProperties = {
  width: '100%', marginTop: 16, padding: '13px 0', fontSize: 15, fontWeight: 700,
  color: '#fff', background: 'linear-gradient(135deg,#4f46e5,#7c3aed)',
  border: 'none', borderRadius: 10, cursor: 'pointer',
};
const ghostBtn: React.CSSProperties = {
  width: '100%', marginTop: 10, padding: '11px 0', fontSize: 14, fontWeight: 600,
  color: '#94a3b8', background: 'transparent', border: '1px solid #334155',
  borderRadius: 10, cursor: 'pointer',
};
const spinnerStyle: React.CSSProperties = {
  width: 34, height: 34, margin: '0 auto', borderRadius: '50%',
  border: '3px solid #334155', borderTopColor: '#7c3aed',
  animation: 'lic-spin 0.8s linear infinite',
};

// keyframes cho spinner (chèn 1 lần)
if (typeof document !== 'undefined' && !document.getElementById('lic-gate-kf')) {
  const st = document.createElement('style');
  st.id = 'lic-gate-kf';
  st.textContent = '@keyframes lic-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(st);
}

export default LicenseGate;
