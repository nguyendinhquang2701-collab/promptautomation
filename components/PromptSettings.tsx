import React, { useEffect, useMemo, useState } from 'react';
import { PromptElement } from '../types';
import { DEFAULT_MAX_PROMPT_CHARS, DEFAULT_PROMPT_ELEMENTS, loadPromptElements, savePromptElements, loadMaxPromptChars, saveMaxPromptChars, buildSamplePrompt } from '../services/geminiService';

interface PromptSettingsProps {
  open: boolean;
  onClose: () => void;
}

// Chuyển nhãn tiếng Việt thành key JSON an toàn: bỏ dấu, thường hoá, snake_case.
const slugKey = (label: string): string => {
  let s = '';
  for (const ch of label) s += (ch === 'đ' || ch === 'Đ') ? 'd' : ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'thanh_to';
};

const PromptSettings: React.FC<PromptSettingsProps> = ({ open, onClose }) => {
  const [elements, setElements] = useState<PromptElement[]>([]);
  const [maxChars, setMaxChars] = useState<number>(DEFAULT_MAX_PROMPT_CHARS);
  // Form thêm thành tố mới
  const [newLabel, setNewLabel] = useState('');
  const [newMode, setNewMode] = useState<'fixed' | 'ai'>('fixed');
  const [newText, setNewText] = useState('');

  useEffect(() => {
    if (open) { setElements(loadPromptElements()); setMaxChars(loadMaxPromptChars()); }
  }, [open]);

  // Tick/sửa là LƯU NGAY trên máy — lần sau không phải chọn lại.
  const update = (next: PromptElement[]) => { setElements(next); savePromptElements(next); };
  const updateMax = (n: number) => { const v = Math.max(0, Math.floor(n) || 0); setMaxChars(v); saveMaxPromptChars(v); };

  const toggle = (key: string) => update(elements.map(e => e.key === key && !e.locked ? { ...e, enabled: !e.enabled } : e));
  const setValue = (key: string, value: string) => update(elements.map(e => e.key === key ? { ...e, value } : e));
  const setInstruction = (key: string, instruction: string) => update(elements.map(e => e.key === key ? { ...e, instruction } : e));
  const removeCustom = (key: string) => update(elements.filter(e => e.key !== key || e.builtin));

  const addCustom = () => {
    const label = newLabel.trim();
    const text = newText.trim();
    if (!label || !text) return;
    let key = slugKey(label);
    while (elements.some(e => e.key === key)) key = key + '_2';
    const el: PromptElement = newMode === 'fixed'
      ? { key, label, mode: 'fixed', enabled: true, value: text }
      : { key, label, mode: 'ai', enabled: true, instruction: text };
    update([...elements, el]);
    setNewLabel(''); setNewText('');
  };

  const resetDefaults = () => {
    update(DEFAULT_PROMPT_ELEMENTS.map(e => ({ ...e })));
    updateMax(DEFAULT_MAX_PROMPT_CHARS);
  };

  const sample = useMemo(() => buildSamplePrompt(elements, maxChars), [elements, maxChars]);
  const coreEls = elements.filter(e => e.core);
  const extraEls = elements.filter(e => e.builtin && !e.core);
  const customEls = elements.filter(e => !e.builtin);

  if (!open) return null;

  const renderRow = (e: PromptElement) => (
    <div key={e.key} className={`rounded-xl border p-3 transition-all ${e.enabled ? 'border-indigo-500/40 bg-indigo-500/5' : 'border-slate-800 bg-slate-950/50'}`}>
      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" checked={e.enabled} disabled={!!e.locked} onChange={() => toggle(e.key)}
          className="mt-0.5 w-4 h-4 accent-indigo-500 cursor-pointer disabled:cursor-not-allowed" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-semibold ${e.enabled ? 'text-slate-200' : 'text-slate-500'}`}>{e.label}</span>
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">{e.key}</span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${e.mode === 'fixed' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-sky-500/15 text-sky-400'}`}>
              {e.mode === 'fixed' ? 'Giá trị cố định' : 'AI viết theo cảnh'}
            </span>
            {e.locked && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-bold">Luôn bật</span>}
            {!e.builtin && (
              <button onClick={(ev) => { ev.preventDefault(); removeCustom(e.key); }} className="text-[10px] text-red-400 hover:text-red-300 font-bold ml-auto">Xóa</button>
            )}
          </div>
          {e.enabled && e.mode === 'fixed' && (
            <input type="text" value={e.value || ''} onChange={ev => setValue(e.key, ev.target.value)}
              onClick={ev => ev.preventDefault()}
              placeholder="Giá trị gắn vào prompt..."
              className="mt-2 w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-emerald-300 text-xs font-mono focus:outline-none focus:border-emerald-500/50" />
          )}
          {e.enabled && e.mode === 'ai' && !e.core && (
            <input type="text" value={e.instruction || ''} onChange={ev => setInstruction(e.key, ev.target.value)}
              onClick={ev => ev.preventDefault()}
              placeholder="Hướng dẫn để AI viết trường này..."
              className="mt-2 w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-sky-300 text-xs font-mono focus:outline-none focus:border-sky-500/50" />
          )}
        </div>
      </label>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col" onClick={ev => ev.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-lg font-bold text-slate-100">⚙️ Thành tố Prompt</h2>
            <p className="text-xs text-slate-500">Tick chọn thành tố đưa vào prompt — lưu tự động trên máy bạn, lần sau không cần chọn lại.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none px-2">×</button>
        </div>

        {/* Body: 2 cột — trái chọn, phải xem trước */}
        <div className="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-2 gap-0">
          {/* CỘT TRÁI */}
          <div className="p-5 space-y-5 border-b lg:border-b-0 lg:border-r border-slate-800">
            <div>
              <h3 className="text-[10px] uppercase font-black text-indigo-400 tracking-widest mb-2">Thành tố gốc (mặc định của app)</h3>
              <div className="space-y-2">{coreEls.map(renderRow)}</div>
            </div>
            <div>
              <h3 className="text-[10px] uppercase font-black text-emerald-400 tracking-widest mb-2">Thành tố mở rộng (tick nếu muốn)</h3>
              <div className="space-y-2">{extraEls.map(renderRow)}</div>
            </div>
            {customEls.length > 0 && (
              <div>
                <h3 className="text-[10px] uppercase font-black text-pink-400 tracking-widest mb-2">Thành tố bạn tự thêm</h3>
                <div className="space-y-2">{customEls.map(renderRow)}</div>
              </div>
            )}
            {/* Thêm thành tố mới */}
            <div className="rounded-xl border border-dashed border-slate-700 p-3 space-y-2">
              <h3 className="text-[10px] uppercase font-black text-slate-400 tracking-widest">+ Thêm thành tố mới</h3>
              <div className="flex gap-2">
                <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Tên thành tố (VD: Chất lượng)"
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 text-xs focus:outline-none focus:border-indigo-500/50" />
                <select value={newMode} onChange={e => setNewMode(e.target.value as 'fixed' | 'ai')}
                  className="bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs text-slate-300 cursor-pointer focus:outline-none">
                  <option value="fixed">Giá trị cố định</option>
                  <option value="ai">AI viết theo cảnh</option>
                </select>
              </div>
              <input type="text" value={newText} onChange={e => setNewText(e.target.value)}
                placeholder={newMode === 'fixed' ? 'Giá trị gắn vào mọi prompt (VD: 4K resolution)' : 'Hướng dẫn cho AI (VD: mô tả tiền cảnh, ≤8 từ)'}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs font-mono text-slate-300 focus:outline-none focus:border-indigo-500/50" />
              <div className="flex items-center justify-between">
                <p className="text-[10px] text-slate-600">
                  {newMode === 'fixed' ? 'Cố định: gắn y nguyên vào mọi prompt, không tốn AI.' : 'AI viết: nội dung khác nhau theo từng cảnh.'}
                </p>
                <button onClick={addCustom} disabled={!newLabel.trim() || !newText.trim()}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs font-bold transition-all">Thêm</button>
              </div>
            </div>
            {/* Trần độ dài */}
            <div className="rounded-xl border border-slate-700 p-3 space-y-2">
              <h3 className="text-[10px] uppercase font-black text-amber-400 tracking-widest">Độ dài tối đa của prompt</h3>
              <div className="flex items-center gap-2 flex-wrap">
                <input type="number" min={0} step={100} value={maxChars || ''} onChange={e => updateMax(parseInt(e.target.value || '0', 10))}
                  placeholder="Không giới hạn"
                  className="w-32 bg-slate-950 border border-slate-800 rounded-lg p-2 text-amber-300 text-xs font-mono focus:outline-none focus:border-amber-500/50" />
                <span className="text-xs text-slate-500">ký tự (để trống = không giới hạn)</span>
                {[0, 500, 800, 1200].map(v => (
                  <button key={v} onClick={() => updateMax(v)}
                    className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${maxChars === v ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}>
                    {v === 0 ? '∞' : v}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-600">Vượt trần → app tự rút gọn "action" rồi "setting" theo ranh giới câu (không bao giờ cắt cụt giữa câu). Xem mẫu bên phải để hình dung.</p>
            </div>
          </div>

          {/* CỘT PHẢI: XEM TRƯỚC */}
          <div className="p-5 space-y-3 bg-slate-950/40">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] uppercase font-black text-slate-400 tracking-widest">Mẫu ví dụ (cập nhật theo lựa chọn)</h3>
              <span className={`text-[11px] font-mono px-2 py-1 rounded border ${maxChars > 0 && sample.chars > maxChars ? 'bg-red-500/10 text-red-400 border-red-500/30' : 'bg-slate-800 text-slate-400 border-slate-700'}`}>
                {sample.chars} ký tự{maxChars > 0 ? ` / ${maxChars}` : ''}
              </span>
            </div>
            <pre className="bg-slate-950 border border-slate-800 rounded-xl p-4 text-emerald-300/90 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words overflow-y-auto max-h-[52vh]">{sample.pretty}</pre>
            <p className="text-[10px] text-slate-600">* Bản xuất thật là JSON 1 dòng — ở đây xuống dòng cho dễ đọc. Số ký tự tính theo bản 1 dòng.</p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-slate-800">
          <button onClick={resetDefaults} className="text-xs text-slate-500 hover:text-red-400 font-semibold transition-all">↺ Khôi phục mặc định</button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all">Xong</button>
        </div>
      </div>
    </div>
  );
};

export default PromptSettings;
