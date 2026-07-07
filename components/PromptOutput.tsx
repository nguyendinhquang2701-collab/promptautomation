import React, { useState } from 'react';
import { ScriptProject } from '../types';

interface PromptOutputProps {
  projects: ScriptProject[];
  onReset: () => void;
  onBack: () => void;
  onRetryPrompt: (id: string) => void; 
  onShare?: () => Promise<string | null>; 
}

const PromptOutput: React.FC<PromptOutputProps> = ({ projects, onReset, onBack, onRetryPrompt, onShare }) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [allCopied, setAllCopied] = useState(false);
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);

  const activeProjects = projects.filter(p => p.scenes.length > 0);

  const handleCopySingle = async (text: string, id: string) => {
    try { await navigator.clipboard.writeText(text); setCopiedId(id); setTimeout(() => setCopiedId(null), 2000); } 
    catch (err) { console.error('Failed to copy', err); }
  };

  const handleCopyAll = async () => {
    try {
      const allText = activeProjects.filter(p => p.promptStatus === 'success').flatMap(p => p.promptItems.map(item => item.generatedPrompt)).join('\n\n');
      await navigator.clipboard.writeText(allText); setAllCopied(true); setTimeout(() => setAllCopied(false), 2000);
    } catch (err) { console.error('Failed to copy all', err); }
  };

  const executeSingleDownload = (type: 'script' | 'prompt') => {
    const allItems = activeProjects.filter(p => p.promptStatus === 'success').flatMap(p => p.promptItems);
    if (allItems.length === 0) return;
    let content = '', fileName = '';
    if (type === 'script') { content = allItems.map(item => item.sourceText).join('\n\n'); fileName = `KichBan_Goc_${new Date().toISOString().slice(0,10)}.txt`; } 
    else { content = allItems.map(item => item.generatedPrompt).join('\n\n'); fileName = `Prompt_Veo3_${new Date().toISOString().slice(0,10)}.txt`; }
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const handleDownloadOption = (option: 'script' | 'prompt' | 'both') => {
    if (option === 'both') { executeSingleDownload('script'); setTimeout(() => { executeSingleDownload('prompt'); }, 300); } 
    else { executeSingleDownload(option); }
    setShowDownloadMenu(false);
  };

  const handleShare = async () => {
    if (!onShare) return; setIsSharing(true); const id = await onShare();
    if (id) { const link = `${window.location.origin}${window.location.pathname}?session=${id}`; await navigator.clipboard.writeText(link); setShareLink(link); setTimeout(() => setShareLink(null), 4000); }
    setIsSharing(false);
  };

  return (
    <div className="w-full max-w-6xl mx-auto pb-20 animate-fade-in-up">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 sticky top-[80px] z-30 bg-slate-950/90 py-4 backdrop-blur-sm border-b border-slate-800 gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Prompts Hoàn Thiện</h2>
          <p className="text-slate-400 text-sm mt-1">Copy, Tải về hoặc Chia sẻ dự án sang máy khác.</p>
        </div>
        
        <div className="flex items-center gap-4 flex-wrap justify-end">
          <button onClick={handleShare} disabled={isSharing} className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm transition-all border ${shareLink ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50 shadow-lg shadow-emerald-500/10' : 'bg-slate-800 text-amber-400 hover:bg-slate-700 border-slate-700 hover:border-amber-500/50'}`}>
            {isSharing ? (<><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Đang tải lên mây...</>) 
            : shareLink ? (<><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" /></svg> Đã copy Link!</>) 
            : (<><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M15.75 4.5a3 3 0 11.825 2.066l-8.421 4.679a3.002 3.002 0 010 1.51l8.421 4.679a3 3 0 11-.729 1.31l-8.421-4.678a3 3 0 110-4.132l8.421-4.679a3 3 0 01-.096-.755z" clipRule="evenodd" /></svg> Chia Sẻ Link</>)}
          </button>

          <div className="relative">
            <button onClick={() => setShowDownloadMenu(!showDownloadMenu)} className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm bg-slate-800 text-white hover:bg-slate-700 transition-all border border-slate-700">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M12 2.25a.75.75 0 01.75.75v11.69l3.22-3.22a.75.75 0 111.06 1.06l-4.5 4.5a.75.75 0 01-1.06 0l-4.5-4.5a.75.75 0 111.06-1.06l3.22 3.22V3a.75.75 0 01.75-.75zm-9 13.5a.75.75 0 01.75.75v2.25a1.5 1.5 0 001.5 1.5h13.5a1.5 1.5 0 001.5-1.5V16.5a.75.75 0 011.5 0v2.25a3 3 0 01-3 3H5.25a3 3 0 01-3-3V16.5a.75.75 0 01.75-.75z" clipRule="evenodd" /></svg>
              Tải File
            </button>
            {showDownloadMenu && (
              <div className="absolute right-0 mt-2 w-56 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden animate-fade-in">
                <button onClick={() => handleDownloadOption('script')} className="w-full text-left px-4 py-3 text-sm text-slate-300 hover:bg-slate-700 hover:text-white transition-colors border-b border-slate-700/50">📄 File Kịch bản (Thoại)</button>
                <button onClick={() => handleDownloadOption('prompt')} className="w-full text-left px-4 py-3 text-sm text-slate-300 hover:bg-slate-700 hover:text-white transition-colors border-b border-slate-700/50">🎬 File Prompt (Veo 3)</button>
                <button onClick={() => handleDownloadOption('both')} className="w-full text-left px-4 py-3 text-sm text-indigo-400 font-bold hover:bg-slate-700 hover:text-indigo-300 transition-colors">📦 Tải cả 2 file cùng lúc</button>
              </div>
            )}
          </div>

          <button onClick={handleCopyAll} className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold text-sm transition-all shadow-lg ${allCopied ? 'bg-emerald-500 text-white shadow-emerald-500/20' : 'bg-indigo-600 text-white hover:bg-indigo-500 hover:shadow-indigo-500/20'}`}>
            {allCopied ? (<><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M19.916 4.626a.75.75 0 01.208 1.04l-9 13.5a.75.75 0 01-1.154.114l-6-6a.75.75 0 011.06-1.06l5.353 5.353 8.493-12.739a.75.75 0 011.04-.208z" clipRule="evenodd" /></svg> Đã copy thành công!</>) : (<><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0016.5 9h-1.875a1.875 1.875 0 01-1.875-1.875V5.25A3.75 3.75 0 009 1.5H5.625z" /><path d="M12.971 1.816A5.23 5.23 0 0114.25 5.25v1.875c0 .207.168.375.375.375H16.5a5.23 5.23 0 013.434 1.279 9.768 9.768 0 00-6.963-6.963z" /></svg> Copy tất cả Prompts</>)}
          </button>
          
          <button onClick={onBack} className="text-sm text-slate-500 hover:text-white transition-colors underline">&larr; Sửa cảnh</button>
        </div>
      </div>

      <div className="space-y-12">
        {activeProjects.map((project) => (
          <div key={project.id} className="animate-fade-in">
             <div className="flex items-center gap-3 mb-6">
               <div className="h-px bg-slate-800 flex-1"></div>
               {/* 👉 MÁC ĐÓNG CỨU HỘ Ở HEADER CỦA PHÂN ĐOẠN */}
               <h3 className="text-lg font-bold text-slate-200 bg-slate-900 px-4 py-1 rounded-full border border-slate-800 flex items-center gap-2">
                 {project.name}
                 <span className="text-slate-500 text-sm font-normal">({project.promptStatus === 'success' ? `${project.promptItems.length} prompts` : project.promptStatus === 'error' ? 'Bị lỗi' : 'Đang xử lý...'})</span>
                 
                 {project.rescueProvider && (
                   <span className="bg-amber-500/10 text-amber-500 border border-amber-500/20 text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider font-bold shadow-sm flex items-center gap-1">
                     <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M10 1c3.866 0 7 1.79 7 4s-3.134 4-7 4-7-1.79-7-4 3.134-4 7-4zm5.694 8.13c.464-.264.91-.583 1.306-.952V10c0 2.21-3.134 4-7 4s-7-1.79-7-4V8.178c.396.37.842.688 1.306.953C5.838 10.006 7.854 10.5 10 10.5s4.162-.494 5.694-1.37zM3 13.179V15c0 2.21 3.134 4 7 4s7-1.79 7-4v-1.822c-1.532.876-3.548 1.37-5.694 1.37-2.146 0-4.162-.494-5.694-1.37z" clipRule="evenodd" /></svg>
                     Cứu hộ bởi {project.rescueProvider}
                   </span>
                 )}
               </h3>
               <div className="h-px bg-slate-800 flex-1"></div>
             </div>

             {project.promptStatus === 'error' && (
                <div className="bg-red-950/30 border border-red-800/50 rounded-2xl p-6 mb-6 flex flex-col md:flex-row justify-between items-center gap-4 shadow-lg">
                  <div><h3 className="text-red-400 font-bold mb-1 flex items-center gap-2"><span className="text-xl">⚠️</span> Lỗi tạo Prompt</h3><p className="text-red-300/80 text-sm font-mono">{project.promptErrorMessage}</p></div>
                  <button onClick={() => onRetryPrompt(project.id)} className="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white border border-red-600 font-bold py-2.5 px-5 rounded-xl transition-all flex items-center gap-2 shrink-0 shadow-lg shadow-red-900/20">🔄 Thử lại Prompt cho đoạn này</button>
                </div>
             )}

             {project.promptStatus === 'loading' && (
                <div className="bg-slate-900/50 border border-indigo-500/30 rounded-2xl p-10 mb-6 flex flex-col items-center justify-center gap-5">
                  <div className="relative w-16 h-16"><div className="absolute inset-0 rounded-full border-t-2 border-indigo-500 animate-spin"></div><div className="absolute inset-2 rounded-full border-r-2 border-purple-500 animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }}></div></div>
                  <div className="text-center">
                    {/* 👉 TRẠNG THÁI UI ĐỘNG THAY ĐỔI THEO TIẾN TRÌNH CỨU HỘ */}
                    <span className={`font-bold text-lg block mb-1 ${project.loadingMessage?.includes('lỗi') ? 'text-amber-400' : 'text-indigo-400'}`}>
                      {project.loadingMessage || "Đang viết lại Prompt tối ưu..."}
                    </span>
                    <span className="text-slate-500 text-xs">Vui lòng đợi trong giây lát, AI đang nhào nặn nghệ thuật!</span>
                  </div>
                </div>
             )}

             {project.promptStatus === 'success' && (
                <div className="space-y-6">
                  {project.promptItems.map((item) => (
                    <div key={`${project.id}-${item.sceneId}`} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-indigo-500/30 transition-all group relative shadow-xl">
                      <div className="absolute top-5 right-5">
                        <button onClick={() => handleCopySingle(item.generatedPrompt, `${project.id}-${item.sceneId}`)} className={`p-2 rounded-lg transition-all ${copiedId === `${project.id}-${item.sceneId}` ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'}`} title="Copy Prompt">
                          {copiedId === `${project.id}-${item.sceneId}` ? (<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M19.916 4.626a.75.75 0 01.208 1.04l-9 13.5a.75.75 0 01-1.154.114l-6-6a.75.75 0 011.06-1.06l5.353 5.353 8.493-12.739a.75.75 0 011.04-.208z" clipRule="evenodd" /></svg>) : (<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0016.5 9h-1.875a1.875 1.875 0 01-1.875-1.875V5.25A3.75 3.75 0 009 1.5H5.625z" /><path d="M12.971 1.816A5.23 5.23 0 0114.25 5.25v1.875c0 .207.168.375.375.375H16.5a5.23 5.23 0 013.434 1.279 9.768 9.768 0 00-6.963-6.963z" /></svg>)}
                        </button>
                      </div>

                      <div className="pr-12">
                        <div className="flex items-center gap-3 mb-3">
                          <span className="bg-indigo-500/10 text-indigo-400 text-xs font-bold px-2 py-1 rounded uppercase tracking-wider">Cảnh {item.sceneId}</span>
                        </div>
                        
                        <div className="mb-4">
                          <h4 className="text-[10px] uppercase text-slate-500 font-bold mb-1 tracking-tighter">Lời thoại kịch bản gốc</h4>
                          <p className="text-slate-300 text-sm leading-relaxed italic border-l-2 border-slate-700 pl-3">"{item.sourceText}"</p>
                        </div>

                        <div>
                          <h4 className="text-[10px] uppercase text-emerald-500 font-bold mb-2 tracking-tighter flex items-center gap-1">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M10 2.5c-1.31 0-2.526.386-3.546 1.051a.75.75 0 01-.82-1.256A8 8 0 0118 9a22.47 22.47 0 01-1.228 7.351.75.75 0 11-1.417-.49A20.97 20.97 0 0016.5 9 6.5 6.5 0 0010 2.5zM4.333 4.416a.75.75 0 01.218 1.038A6.466 6.466 0 003.5 9a7.966 7.966 0 01-1.293 4.362.75.75 0 01-1.257-.819A6.466 6.466 0 002 9c0-1.61.476-3.11 1.295-4.365a.75.75 0 011.038-.219zM10 6.12a3 3 0 00-3 3v1.066a1.75 1.75 0 01-1.558 1.739l-.126.015a.75.75 0 10.168 1.49l.126-.014a3.25 3.25 0 002.89-3.23V9a1.5 1.5 0 013 0v.547a4.5 4.5 0 01-1.144 3.013l-.53.53a.75.75 0 101.06 1.06l.53-.53a6 6 0 001.584-4.073V9a3 3 0 00-3-3zM7.5 15.5a.75.75 0 011-.4l.325.132a.75.75 0 10.55-1.396l-.325-.132a.75.75 0 01-.4-1 1.5 1.5 0 00-2.812-.511.75.75 0 01-1.35-.646 3 3 0 015.625 1.022.75.75 0 01.4.1l.325.132a2.25 2.25 0 11-1.65 4.187l-.325-.132a.75.75 0 01-.4-1z" clipRule="evenodd" /></svg>
                            Generated Prompt (Veo 3)
                          </h4>
                          <pre className="text-white font-medium bg-slate-950/50 p-4 rounded-xl border border-slate-800/80 leading-relaxed font-mono text-sm selection:bg-indigo-500/40 whitespace-pre-wrap break-words overflow-x-auto">
                            {item.generatedPrompt}
                          </pre>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
             )}
          </div>
        ))}
      </div>

      {projects.every(p => p.promptStatus === 'success') && (
        <div className="mt-16 text-center">
          <button onClick={onReset} className="text-slate-400 hover:text-white border border-slate-700 hover:bg-slate-800 px-8 py-3 rounded-full font-bold transition-all">+ Tạo kịch bản mới</button>
        </div>
      )}
    </div>
  );
};

export default PromptOutput;
