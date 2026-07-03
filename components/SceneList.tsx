import React, { useState } from 'react';
import { ScriptProject } from '../types';

interface SceneListProps {
  projects: ScriptProject[];
  onBack: () => void;
  onGeneratePrompts: () => void;
  isGenerating: boolean;
  useParallel: boolean;
  setUseParallel: (val: boolean) => void;
  onRetryAnalyze: (id: string) => void;
  onRepairScenes: (id: string) => void;
}

const SceneList: React.FC<SceneListProps> = ({ 
  projects, 
  onBack, 
  onGeneratePrompts, 
  isGenerating,
  useParallel,
  setUseParallel,
  onRetryAnalyze,
  onRepairScenes
}) => {
  
  const [refCopied, setRefCopied] = useState(false);
  const activeProjects = projects.filter(p => p.scenes.length > 0 || p.sceneStatus === 'error' || p.sceneStatus === 'loading');
  const totalScenes = projects.reduce((acc, p) => acc + (p.scenes ? p.scenes.length : 0), 0);

  const handleCopyReferenceScript = async () => {
    try {
      const allReferenceText = activeProjects
        .filter(p => p.scenes && p.scenes.length > 0)
        .flatMap(p => p.scenes.map(s => s.sourceText?.trim() || ""))
        .filter(text => text.length > 0)
        .join('\n\n'); 
      
      await navigator.clipboard.writeText(allReferenceText);
      setRefCopied(true);
      setTimeout(() => setRefCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy reference script: ', err);
    }
  };

  return (
    <div className="w-full max-w-6xl mx-auto pb-20 animate-fade-in-up">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 sticky top-[80px] z-30 bg-slate-950/90 py-4 backdrop-blur-sm border-b border-slate-800 gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Xác nhận Phân Cảnh (Pacing 8s)</h2>
          <p className="text-slate-400 text-sm mt-1">
            Tổng cộng: <span className="text-indigo-400 font-bold">{totalScenes}</span> cảnh được tối ưu hóa.
          </p>
        </div>
        
        <div className="flex flex-wrap items-center gap-4">
          <button onClick={handleCopyReferenceScript} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs transition-all border h-fit ${refCopied ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/50' : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700 border-slate-700'}`}>
            {refCopied ? (<><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M19.916 4.626a.75.75 0 01.208 1.04l-9 13.5a.75.75 0 01-1.154.114l-6-6a.75.75 0 011.06-1.06l5.353 5.353 8.493-12.739a.75.75 0 011.04-.208z" clipRule="evenodd" /></svg> Đã chép kịch bản!</>) : (<><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0016.5 9h-1.875a1.875 1.875 0 01-1.875-1.875V5.25A3.75 3.75 0 009 1.5H5.625z" /><path d="M12.971 1.816A5.23 5.23 0 0114.25 5.25v1.875c0 .207.168.375.375.375H16.5a5.23 5.23 0 013.434 1.279 9.768 9.768 0 00-6.963-6.963z" /></svg> Copy kịch bản</>)}
          </button>
          
          <button onClick={onBack} disabled={isGenerating} className="text-sm text-slate-500 hover:text-white transition-colors underline disabled:opacity-50 h-fit ml-2">&larr; Sửa</button>
        </div>
      </div>

      <div className="space-y-10">
        {activeProjects.map((project) => {
          const hasFailedScenes = project.scenes.some(s => s.visualDescription === "");
          const isAnyRepairing = project.scenes.some(s => s.isRepairing);

          return (
            <div key={project.id} className="animate-fade-in">
               <div className="flex items-center gap-3 mb-4">
                 <div className="h-px bg-slate-800 flex-1"></div>
                 <h3 className="text-lg font-bold text-slate-200 bg-slate-900 px-4 py-1 rounded-full border border-slate-800">
                   {project.name} <span className="text-slate-500 text-sm font-normal">({project.sceneStatus === 'success' ? `${project.scenes.length} nhịp 8s` : project.sceneStatus === 'error' ? 'Bị lỗi' : 'Đang xử lý...'})</span>
                 </h3>
                 
                 {hasFailedScenes && (
                     <button 
                         onClick={() => onRepairScenes(project.id)}
                         disabled={isAnyRepairing}
                         className={`ml-auto flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${isAnyRepairing ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white border border-red-500/50 shadow-lg shadow-red-500/20'}`}
                     >
                         {isAnyRepairing ? '⏳ Đang vá lỗi...' : '🔧 Tự động Vá Lỗi Cảnh Hỏng'}
                     </button>
                 )}
                 <div className="h-px bg-slate-800 flex-1"></div>
               </div>

               {project.sceneStatus === 'error' ? (
                 <div className="bg-red-950/30 border border-red-500/50 rounded-2xl p-6 text-center shadow-lg">
                   <div className="w-12 h-12 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-3"><span className="text-2xl">⚠️</span></div>
                   <h3 className="text-red-400 font-bold mb-2">Đã xảy ra lỗi khi chia cảnh đoạn này!</h3>
                   <p className="text-red-300 text-sm mb-4 font-mono">{project.sceneErrorMessage}</p>
                   <button onClick={() => onRetryAnalyze(project.id)} className="bg-red-600 hover:bg-red-500 text-white font-bold py-2 px-6 rounded-lg transition-all shadow-lg shadow-red-900/50">🔄 Nhấp để thử lại riêng đoạn này</button>
                 </div>
               ) : project.sceneStatus === 'loading' ? (
                 <div className="flex justify-center items-center py-10 border border-indigo-500/30 rounded-2xl bg-slate-900/50">
                   <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
                   <span className="ml-3 text-indigo-400 font-bold">Đang xử lý phân đoạn này...</span>
                 </div>
               ) : (
                 <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2">
                    {project.scenes.map((scene) => {
                      const isFailed = scene.visualDescription === "";
                      const isRepairing = scene.isRepairing;

                      return (
                        <div key={`${project.id}-${scene.id}`} className={`border p-0 rounded-2xl transition-all group overflow-hidden shadow-xl relative ${isFailed ? 'border-red-500/50 bg-red-950/20' : 'bg-slate-900 border-slate-800 hover:border-indigo-500/30'}`}>
                          
                          {isRepairing && (
                              <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-[2px] z-10 flex flex-col items-center justify-center">
                                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-400 mb-2"></div>
                                  <span className="text-red-400 text-xs font-bold">Đang nội suy lại ảnh...</span>
                              </div>
                          )}

                          <div className={`px-5 py-3 border-b ${isFailed ? 'bg-red-950/50 border-red-500/20' : 'bg-slate-950/80 border-slate-800/50'}`}>
                             <label className={`text-[10px] uppercase font-black tracking-widest mb-1.5 block ${isFailed ? 'text-red-400' : 'text-indigo-400'}`}>Kịch bản đối soát (Audio/Voiceover)</label>
                             <p className="text-slate-100 text-sm font-medium leading-relaxed italic">"{scene.sourceText}"</p>
                          </div>

                          <div className="p-5">
                            <div className="flex justify-between items-start mb-3">
                              <span className={`text-xs font-bold px-2 py-1 rounded uppercase tracking-wider ${isFailed ? 'bg-red-500/20 text-red-400' : 'bg-indigo-500/10 text-indigo-400'}`}>Cảnh {scene.id}</span>
                              <span className="text-slate-500 text-xs font-mono flex items-center gap-1">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75l4 4a.75.75 0 101.06-1.06l-3.25-3.25V5z" clipRule="evenodd" /></svg>
                                ~{scene.duration}
                              </span>
                            </div>
                            
                            <div className="space-y-3">
                              {isFailed ? (
                                  <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center mt-4">
                                      <span className="text-2xl mb-2 block">⚠️</span>
                                      <p className="text-red-400 text-sm font-bold">Cảnh này phân tích thất bại do mạng hụt!</p>
                                      <p className="text-red-300/70 text-xs mt-1">Vui lòng bấm nút "Vá Lỗi" ở trên để AI thử lại riêng phần thiếu.</p>
                                  </div>
                              ) : (
                                  <>
                                      <div>
                                        <h4 className="text-[10px] uppercase text-slate-500 font-bold mb-1 tracking-tighter">Mô tả hình ảnh đại diện (Visual)</h4>
                                        <p className="text-slate-300 text-sm leading-relaxed">{scene.visualDescription}</p>
                                      </div>
                                      
                                      <div className="grid grid-cols-2 gap-3">
                                        <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-800/50">
                                          <h4 className="text-[9px] uppercase text-slate-500 font-bold mb-1">Nhân vật tham gia</h4>
                                          <p className="text-slate-400 text-[11px] line-clamp-2">{scene.characterDetails || "Môi trường / Cảnh nền"}</p>
                                        </div>
                                        <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-800/50">
                                          <h4 className="text-[9px] uppercase text-slate-500 font-bold mb-1">Thời điểm / Ánh sáng</h4>
                                          <p className="text-slate-400 text-[11px]">{scene.settingTime}</p>
                                        </div>
                                      </div>
                                  </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                 </div>
               )}
            </div>
          );
        })}
      </div>

      {projects.every(p => p.sceneStatus === 'success') && !projects.some(p => p.scenes.some(s => s.visualDescription === "")) && (
        <div className="sticky bottom-6 z-40 flex flex-col items-center gap-4 mt-12">
          <button
            onClick={onGeneratePrompts}
            disabled={isGenerating}
            className={`
              shadow-2xl shadow-indigo-900/50
              flex items-center gap-3 px-8 py-4 rounded-full font-bold text-base transition-all transform
              ${isGenerating 
                ? 'bg-slate-800 text-slate-400 cursor-not-allowed scale-100' 
                : 'bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 text-white hover:scale-105 hover:shadow-indigo-500/40 active:scale-95'}
            `}
          >
            {isGenerating ? (
              <>
                <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                Đang viết Prompt tối ưu...
              </>
            ) : (
               <>
                  Tạo Prompt Veo 3 & Màu Đã Chọn
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M12.97 3.97a.75.75 0 011.06 0l7.5 7.5a.75.75 0 010 1.06l-7.5 7.5a.75.75 0 11-1.06-1.06l6.22-6.22H3a.75.75 0 010-1.5h16.19l-6.22-6.22a.75.75 0 010-1.06z" clipRule="evenodd" /></svg>
               </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export default SceneList;
