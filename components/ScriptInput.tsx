import React, { useRef } from 'react';
import { ScriptProject, CharacterIdentity, ColorStyle } from '../types';

interface ScriptInputProps {
  projects: ScriptProject[];
  rawScript: string;
  setRawScript: (val: string) => void;
  globalContext: string;
  setGlobalContext: (val: string) => void;
  
  customPromptSuffix: string;
  setCustomPromptSuffix: (val: string) => void;

  onExtractContext: (script: string) => void;
  isExtractingContext: boolean;
  onAddProject: () => void;
  onRemoveProject: (id: string) => void;
  onUpdateContent: (id: string, content: string) => void;
  onUpdateName: (id: string, name: string) => void;
  onAnalyze: () => void;
  isAnalyzing: boolean;
  styleAnalysis: string;
  setStyleAnalysis: (val: string) => void;
  styleSummary: string;
  setStyleSummary: (val: string) => void;
  onAnalyzeStyle: (base64: string, mimeType: string) => Promise<void>;
  isAnalyzingStyle: boolean;
  characters: CharacterIdentity[];
  onUpdateCharacter: (id: string, field: 'name' | 'promptName' | 'originalName' | 'visualDescription' | 'ethnicity' | 'clothing', val: string) => void;
  onAddCharacter: () => void;
  onRemoveCharacter: (id: string) => void;
  onReset: () => void; 
  imagePreview: string | null; 
  setImagePreview: (val: string | null) => void; 
  
  // Props mới cho Control Panel & Màu sắc
  colorStyle: ColorStyle;
  setColorStyle: (val: ColorStyle) => void;
  promptOptions: { splitLogic?: string; audioMode?: 'remove' | 'keep' };
  setPromptOptions: (val: any) => void;
}

const ScriptInput: React.FC<ScriptInputProps> = ({ 
  projects, rawScript, setRawScript, globalContext, setGlobalContext, 
  customPromptSuffix, setCustomPromptSuffix, 
  onExtractContext, isExtractingContext,
  onAddProject, onRemoveProject, onUpdateContent, onUpdateName, onAnalyze, isAnalyzing,
  styleAnalysis, setStyleAnalysis, styleSummary, setStyleSummary, onAnalyzeStyle, isAnalyzingStyle,
  characters, onUpdateCharacter, onAddCharacter, onRemoveCharacter, onReset, imagePreview, setImagePreview,
  colorStyle, setColorStyle, promptOptions, setPromptOptions
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasContent = projects.some(p => p.content.trim().length > 0);
  const canExtract = rawScript.trim().length > 10;

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        setImagePreview(base64);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleAnalyzeClick = () => {
      if (imagePreview) {
          const [mimePart, dataPart] = imagePreview.split(';base64,');
          const mimeType = mimePart.split(':')[1];
          onAnalyzeStyle(dataPart, mimeType);
      }
  };

  return (
    <div className="w-full max-w-6xl mx-auto animate-fade-in">
      <div className="flex justify-between items-end mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Thiết Lập Sản Xuất</h2>
          <p className="text-slate-400 text-sm mt-1">Dán kịch bản và tải ảnh phong cách để AI đồng bộ hình ảnh cho toàn bộ video.</p>
        </div>
        
        <div className="flex items-center gap-3">
          <button onClick={onReset} disabled={isAnalyzing} className="flex items-center gap-2 px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 hover:border-red-500/50 rounded-lg text-sm font-semibold transition-all disabled:opacity-50">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M16.5 4.478v.227a48.816 48.816 0 013.878.512.75.75 0 11-.256 1.478l-.209-.035-1.005 13.07a3 3 0 01-2.991 2.77H8.084a3 3 0 01-2.991-2.77L4.087 6.66l-.209.035a.75.75 0 01-.256-1.478A48.567 48.567 0 017.5 4.705v-.227c0-1.564 1.213-2.9 2.816-2.951a52.662 52.662 0 013.369 0c1.603.051 2.815 1.387 2.815 2.951zm-6.136-1.452a51.196 51.196 0 013.273 0C14.39 3.05 15 3.684 15 4.478v.113a49.488 49.488 0 00-6 0v-.113c0-.794.609-1.428 1.636-1.452z" clipRule="evenodd" /></svg>
            Xóa Trắng
          </button>
          <button onClick={onAddProject} disabled={isAnalyzing} className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-indigo-400 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M12 3.75a.75.75 0 01.75.75v6.75h6.75a.75.75 0 010 1.5h-6.75v6.75a.75.75 0 01-1.5 0v-6.75H4.5a.75.75 0 010-1.5h6.75V4.5a.75.75 0 01.75-.75z" clipRule="evenodd" /></svg>
            Thêm Phân Đoạn
          </button>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-6 mb-8">
        {/* ========================================== */}
        {/* CỘT TRÁI (COL-8): KỊCH BẢN & NHÂN VẬT      */}
        {/* ========================================== */}
        <div className="md:col-span-2 flex flex-col gap-6">
          <div className="bg-indigo-950/30 border border-indigo-500/30 rounded-2xl p-6 shadow-xl relative overflow-hidden flex flex-col h-full">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-3">
              <div className="flex items-center gap-2">
                  <div className="p-1.5 bg-indigo-500 rounded text-white shadow-lg shadow-indigo-500/50">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M10.5 3.75a6.75 6.75 0 100 13.5 6.75 6.75 0 000-13.5zM2.25 10.5a8.25 8.25 0 1114.59 5.28l4.69 4.69a.75.75 0 11-1.06 1.06l-4.69-4.69A8.25 8.25 0 012.25 10.5z" clipRule="evenodd" /></svg>
                  </div>
                  <h3 className="text-lg font-bold text-indigo-300">Kịch Bản Thô</h3>
              </div>
              <button onClick={() => onExtractContext(rawScript)} disabled={!canExtract || isExtractingContext} className={`text-xs flex items-center gap-2 px-4 py-2 rounded-lg font-bold border transition-all ${!canExtract || isExtractingContext ? 'bg-slate-800/50 text-slate-500 border-slate-700 cursor-not-allowed' : 'bg-indigo-600 text-white border-indigo-500 hover:bg-indigo-500 shadow-lg shadow-indigo-500/20'}`}>
                {isExtractingContext ? "Đang xử lý kịch bản..." : "Tự Động Trích Xuất Nhân Vật & Bối Cảnh"}
              </button>
            </div>
            
            <textarea value={rawScript} onChange={(e) => setRawScript(e.target.value)} placeholder="Dán toàn bộ kịch bản thô vào đây..." className="w-full flex-1 min-h-[160px] bg-slate-900/80 border border-indigo-500/30 rounded-xl p-4 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all resize-y font-mono text-sm leading-relaxed mb-4"/>

            <div className="pt-4 border-t border-indigo-500/30 space-y-4">
              <div>
                <label className="text-[10px] uppercase font-black text-indigo-400 tracking-widest mb-2 block">Bối cảnh chung (Context)</label>
                <textarea value={globalContext} onChange={(e) => setGlobalContext(e.target.value)} placeholder="Bối cảnh không gian, thời gian..." className="w-full h-16 bg-slate-900/50 border border-indigo-500/20 rounded-lg p-3 text-indigo-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all resize-none font-mono text-xs leading-relaxed"/>
              </div>
              
              <div>
                <label className="text-[10px] uppercase font-black text-pink-400 tracking-widest mb-2 block flex items-center gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M10 1c3.866 0 7 1.79 7 4s-3.134 4-7 4-7-1.79-7-4 3.134-4 7-4zm5.694 8.13c.464-.264.91-.583 1.306-.952V10c0 2.21-3.134 4-7 4s-7-1.79-7-4V8.178c.396.37.842.688 1.306.953C5.838 10.006 7.854 10.5 10 10.5s4.162-.494 5.694-1.37zM3 13.179V15c0 2.21 3.134 4 7 4s7-1.79 7-4v-1.822c-1.532.876-3.548 1.37-5.694 1.37-2.146 0-4.162-.494-5.694-1.37z" clipRule="evenodd" /></svg>
                  Hậu Tố Prompt (Bắt buộc nối vào đuôi mọi Prompt)
                </label>
                <textarea 
                  value={customPromptSuffix} 
                  onChange={(e) => setCustomPromptSuffix(e.target.value)} 
                  placeholder="VD: no text, cinematic lighting, 8k resolution, photorealistic..." 
                  className="w-full h-16 bg-slate-900/50 border border-pink-500/30 rounded-lg p-3 text-pink-200 focus:outline-none focus:ring-1 focus:ring-pink-500 transition-all resize-none font-mono text-xs leading-relaxed"
                />
              </div>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
               <div className="flex items-center gap-2">
                  <div className="p-1.5 bg-amber-500 rounded text-white shadow-lg shadow-amber-500/50">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M7.5 6a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM3.751 20.105a8.25 8.25 0 0116.498 0 .75.75 0 01-.437.695A18.683 18.683 0 0112 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 01-.437-.695z" clipRule="evenodd" /></svg>
                  </div>
                  <h3 className="text-lg font-bold text-amber-400">Hồ Sơ Nhân Vật</h3>
               </div>
               <button onClick={onAddCharacter} className="text-xs bg-slate-800 hover:bg-slate-700 text-amber-500 px-3 py-1.5 rounded-lg border border-slate-700 transition-colors">+ Thêm</button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
               {characters.length === 0 && <p className="col-span-full text-slate-500 text-sm italic py-4 text-center">AI sẽ tự động mô tả nhân vật dựa trên kịch bản.</p>}
               {characters.map(char => (
                 <div key={char.id} className="bg-slate-950/50 border border-slate-800 p-4 rounded-xl relative group">
                    <button onClick={() => onRemoveCharacter(char.id)} className="absolute top-2 right-2 text-slate-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" /></svg>
                    </button>
                    
                    <input 
                      value={char.name}
                      onChange={(e) => onUpdateCharacter(char.id, 'name', e.target.value)}
                      placeholder="Tên ẩn danh (AI trích xuất)..."
                      className="bg-transparent border-none p-0 text-amber-400 font-bold mb-3 focus:ring-0 w-full text-lg"
                    />

                    <div className="mb-3 bg-amber-500/10 border border-amber-500/20 p-2 rounded-lg">
                      <label className="text-[10px] uppercase font-bold text-amber-500 tracking-widest mb-1 block">
                        Tên Đưa Vào Prompt
                      </label>
                      <input
                        value={char.promptName || ''}
                        onChange={(e) => onUpdateCharacter(char.id, 'promptName', e.target.value)}
                        placeholder="Ghi tên nhân vật bạn muốn thêm vào prompt..."
                        className="bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:border-amber-500 w-full placeholder-slate-600 font-mono"
                      />
                    </div>

                    <div className="mb-3 bg-red-500/5 border border-red-500/20 p-2 rounded-lg">
                      <label className="text-[10px] uppercase font-bold text-red-400/90 tracking-widest mb-1 block">
                        🚫 Tên Thật (Sẽ Bị Chặn Khỏi Prompt)
                      </label>
                      <input
                        value={char.originalName || ''}
                        onChange={(e) => onUpdateCharacter(char.id, 'originalName', e.target.value)}
                        placeholder="Tên người thật trong kịch bản (nếu có)..."
                        className="bg-slate-950 border border-slate-800 rounded-md px-2 py-1.5 text-xs text-red-300 focus:outline-none focus:border-red-500/50 w-full placeholder-slate-600 font-mono"
                      />
                      <p className="text-[9px] text-slate-500 mt-1 leading-tight">Hệ thống tự động thay mọi lần xuất hiện của tên này bằng "Tên Đưa Vào Prompt".</p>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-2 mb-2">
                      <div className="flex flex-col gap-1">
                        <label className="text-[9px] uppercase font-bold text-slate-500">Sắc tộc</label>
                        <input value={char.ethnicity || ''} onChange={(e) => onUpdateCharacter(char.id, 'ethnicity', e.target.value)} placeholder="VD: Người Việt..." className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-300 focus:outline-none focus:ring-1 focus:ring-amber-500"/>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[9px] uppercase font-bold text-slate-500">Trang phục</label>
                        <input value={char.clothing || ''} onChange={(e) => onUpdateCharacter(char.id, 'clothing', e.target.value)} placeholder="VD: Áo dài..." className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-300 focus:outline-none focus:ring-1 focus:ring-amber-500"/>
                      </div>
                    </div>

                    <textarea value={char.visualDescription} onChange={(e) => onUpdateCharacter(char.id, 'visualDescription', e.target.value)} placeholder="Mô tả ngoại hình kỹ thuật..." className="w-full h-20 bg-slate-900 border border-slate-800 rounded-lg p-2 text-slate-300 text-xs focus:outline-none resize-none font-mono"/>
                 </div>
               ))}
            </div>
          </div>
        </div>

        {/* ========================================== */}
        {/* CỘT PHẢI (COL-4): STYLE & CONTROL PANEL    */}
        {/* ========================================== */}
        <div className="md:col-span-1 flex flex-col gap-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col h-fit sticky top-24">
            
            {/* --- KHỐI PHONG CÁCH MẪU --- */}
            <div className="flex items-center gap-2 mb-4">
                <div className="p-1.5 bg-emerald-500 rounded text-white shadow-lg shadow-emerald-500/50">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M1.5 6a2.25 2.25 0 012.25-2.25h16.5A2.25 2.25 0 0122.5 6v12a2.25 2.25 0 01-2.25 2.25H3.75A2.25 2.25 0 011.5 18V6zM3 16.06V18c0 .414.336.75.75.75h16.5A.75.75 0 0021 18v-1.94l-2.69-2.689a1.5 1.5 0 00-2.12 0l-.88.879.97.97a.75.75 0 11-1.06 1.06l-5.16-5.159a1.5 1.5 0 00-2.12 0L3 16.061zm10.125-7.81a1.125 1.125 0 112.25 0 1.125 1.125 0 01-2.25 0z" clipRule="evenodd" /></svg>
                </div>
                <h3 className="text-base font-bold text-emerald-400">Phong Cách Mẫu</h3>
            </div>

            <div className="flex flex-col gap-3">
              <div onClick={() => fileInputRef.current?.click()} className={`relative h-28 rounded-xl border-2 border-dashed transition-all cursor-pointer flex items-center justify-center overflow-hidden ${imagePreview ? 'border-emerald-500/50' : 'border-slate-700 hover:border-emerald-500/30 hover:bg-emerald-500/5'}`}>
                {imagePreview ? (<><img src={imagePreview} alt="Ref" className="w-full h-full object-cover" /><div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"><span className="text-white text-[10px] font-bold">Thay đổi ảnh</span></div></>) : (<div className="text-center p-2"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 mx-auto text-slate-600 mb-1"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v6m3-3H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg><span className="text-slate-500 text-[10px]">Tải ảnh mẫu (Gốc)</span></div>)}
                <input type="file" ref={fileInputRef} onChange={handleImageChange} accept="image/*" className="hidden" />
              </div>

              {imagePreview && (
                  <button 
                    onClick={handleAnalyzeClick} 
                    disabled={isAnalyzingStyle}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-xl text-[11px] font-bold transition-all shadow-sm"
                  >
                    {isAnalyzingStyle ? (
                      <><div className="w-3 h-3 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"></div> Phân tích...</>
                    ) : (
                      <><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5z" clipRule="evenodd" /></svg> 
                      Phân Tích Bằng AI</>
                    )}
                  </button>
              )}

              <div className="bg-emerald-950/20 border border-emerald-500/20 rounded-xl p-2.5">
                <label className="text-[9px] uppercase font-black text-emerald-500 tracking-widest mb-1 block">Phong cách chủ đạo</label>
                <textarea value={styleSummary} onChange={(e) => setStyleSummary(e.target.value)} placeholder="VD: Cyberpunk..." className="w-full h-12 bg-slate-950 border border-emerald-500/30 rounded-lg p-2 text-emerald-300 text-[10px] focus:outline-none focus:ring-1 focus:ring-emerald-500 resize-none font-mono custom-scrollbar"/>
              </div>

              <div>
                <label className="text-[9px] uppercase font-black text-slate-500 tracking-widest mb-1 block">Chi tiết kỹ thuật</label>
                <textarea value={styleAnalysis} onChange={(e) => setStyleAnalysis(e.target.value)} placeholder="Phân tích kỹ thuật..." className="w-full h-16 bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-400 text-[10px] focus:outline-none resize-none font-mono custom-scrollbar"/>
              </div>
            </div>

            {/* --- KHỐI CONTROL PANEL --- */}
            <div className="mt-4 pt-5 border-t border-slate-800 flex flex-col gap-4">
              <div className="flex items-center gap-2 mb-1">
                  <div className="p-1.5 bg-blue-500 rounded text-white shadow-lg shadow-blue-500/50">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                      <path fillRule="evenodd" d="M11.078 2.25c-.917 0-1.699.663-1.85 1.567L9.05 4.889c-.02.12-.115.26-.297.348a7.493 7.493 0 00-.986.57c-.166.115-.334.126-.45.083L6.3 5.508a1.875 1.875 0 00-2.282.819l-.922 1.597a1.875 1.875 0 00.432 2.385l.84.692c.095.078.17.229.154.43a7.598 7.598 0 000 1.139c.015.2-.059.352-.153.43l-.841.692a1.875 1.875 0 00-.432 2.385l.922 1.597a1.875 1.875 0 002.282.818l1.019-.382c.115-.043.283-.031.45.082.312.214.641.405.985.57.182.088.277.228.297.35l.178 1.071c.151.904.933 1.567 1.85 1.567h1.844c.916 0 1.699-.663 1.85-1.567l.178-1.072c.02-.12.114-.26.297-.349.344-.165.673-.356.985-.57.167-.114.335-.125.45-.082l1.02.382a1.875 1.875 0 002.28-.819l.923-1.597a1.875 1.875 0 00-.432-2.385l-.84-.692c-.095-.078-.17-.229-.154-.43a7.614 7.614 0 000-1.139c-.016-.2.059-.352.153-.43l.84-.692c.708-.582.891-1.59.433-2.385l-.922-1.597a1.875 1.875 0 00-2.282-.818l-1.02.382c-.114.043-.282.031-.449-.083a7.49 7.49 0 00-.985-.57c-.183-.087-.277-.227-.297-.348l-.179-1.072a1.875 1.875 0 00-1.85-1.567h-1.843zM12 15.75a3.75 3.75 0 100-7.5 3.75 3.75 0 000 7.5z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <h3 className="text-base font-bold text-blue-400">Control Panel</h3>
              </div>

              <div>
                <label className="text-[9px] uppercase font-black text-slate-500 tracking-widest mb-1.5 block">
                  Tông Màu Video
                </label>
                <select 
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-blue-500/50 text-xs font-semibold cursor-pointer"
                  value={colorStyle}
                  onChange={e => setColorStyle(e.target.value as any)}
                >
                  <option value="default">✨ Mặc định (Tự nhiên)</option>
                  <option value="cinematic">🎬 Màu Phim (Cinematic)</option>
                  <option value="hot">🔥 Màu Nóng (Hot)</option>
                  <option value="warm">☀️ Màu Ấm (Warm)</option>
                  <option value="cold">❄️ Màu Lạnh (Cold)</option>
                </select>
              </div>

              <div>
                <label className="text-[9px] uppercase font-black text-slate-500 tracking-widest mb-1.5 block">
                  Cơ chế cắt kịch bản
                </label>
                <select 
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-indigo-300 focus:outline-none focus:border-blue-500/50 text-xs font-semibold cursor-pointer"
                  value={promptOptions?.splitLogic || 'default'}
                  onChange={e => setPromptOptions({...promptOptions, splitLogic: e.target.value})}
                >
                  <option value="default">Cắt đoạn thông minh (Mặc định)</option>
                  <option value="sentence">1 Câu = 1 Cảnh (Gộp khi &lt; 60 ký tự) - Tiết kiệm</option>
                </select>
              </div>

              {/* 👉 KHỐI UI MỚI: TÙY CHỌN XỬ LÝ LỜI THOẠI/ÂM THANH */}
              <div>
                <label className="text-[9px] uppercase font-black text-slate-500 tracking-widest mb-1.5 block">
                  Xử lý Âm thanh / Lời thoại
                </label>
                <select 
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-pink-400 focus:outline-none focus:border-blue-500/50 text-xs font-semibold cursor-pointer"
                  value={promptOptions?.audioMode || 'remove'}
                  onChange={e => setPromptOptions({...promptOptions, audioMode: e.target.value as 'remove' | 'keep'})}
                >
                  <option value="remove">🔇 Lược bỏ (Chuẩn cho Veo 3 / Sora)</option>
                  <option value="keep">🔊 Giữ nguyên (Cho các Model hỗ trợ Audio)</option>
                </select>
              </div>

            </div>

          </div>
        </div>

      </div>

      <div className="space-y-6">
        <h3 className="text-xl font-bold text-slate-200 px-2 flex items-center gap-2">Phân Đoạn Kịch Bản</h3>
        {projects.map((project, index) => {
          return (
            <div key={project.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl relative group transition-all duration-300">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-3">
                <div className="flex items-center gap-3 flex-1">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-slate-800 text-slate-400 text-xs font-bold">{index + 1}</span>
                  <input type="text" value={project.name} onChange={(e) => onUpdateName(project.id, e.target.value)} className="bg-transparent border-none text-slate-200 font-semibold focus:ring-0 focus:outline-none w-full" placeholder="Tên phân đoạn..."/>
                </div>
                
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-mono px-2 py-1 rounded border bg-slate-800 text-slate-400 border-slate-700">{project.content.length} ký tự</span>
                  {projects.length > 1 && (<button onClick={() => onRemoveProject(project.id)} className="text-slate-600 hover:text-red-400 transition-colors p-2"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M16.5 4.478v.227a48.816 48.816 0 013.878.512.75.75 0 11-.256 1.478l-.209-.035-1.005 13.07a3 3 0 01-2.991 2.77H8.084a3 3 0 01-2.991-2.77L4.087 6.66l-.209.035a.75.75 0 01-.256-1.478A48.567 48.567 0 017.5 4.705v-.227c0-1.564 1.213-2.9 2.816-2.951a52.662 52.662 0 013.369 0c1.603.051 2.815 1.387 2.815 2.951zm-6.136-1.452a51.196 51.196 0 013.273 0C14.39 3.05 15 3.684 15 4.478v.113a49.488 49.488 0 00-6 0v-.113c0-.794.609-1.428 1.636-1.452z" clipRule="evenodd" /></svg></button>)}
                </div>
              </div>

              <textarea value={project.content} onChange={(e) => onUpdateContent(project.id, e.target.value)} placeholder="Nhập nội dung kịch bản..." className="w-full h-40 bg-slate-950 border border-slate-800 rounded-xl p-4 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all resize-none font-mono text-sm leading-relaxed"/>
            </div>
          );
        })}
      </div>
      
      <div className="flex justify-end mt-8 pb-10">
        <button onClick={onAnalyze} disabled={!hasContent || isAnalyzing} className={`flex items-center gap-2 px-8 py-4 rounded-xl font-bold text-base transition-all shadow-xl ${!hasContent || isAnalyzing ? 'bg-slate-800 text-slate-500 cursor-not-allowed shadow-none' : 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white hover:shadow-indigo-500/25 hover:scale-[1.02] active:scale-[0.98]'}`}>
          {isAnalyzing ? "Đang Phân Tích Cảnh..." : "Bắt Đầu Chia Cảnh 8s"}
        </button>
      </div>
    </div>
  );
};

export default ScriptInput;
