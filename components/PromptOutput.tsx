import React, { useState } from 'react';
import { ScriptProject } from '../types';
import { getOverallPromptCompletion, getProjectPromptCompletion } from '../state/promptCompletion';

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

  const activeProjects = projects.filter(project => project.scenes.length > 0);
  const overall = getOverallPromptCompletion(activeProjects);
  const projectCompletion = new Map(activeProjects.map(project => [project.id, getProjectPromptCompletion(project)]));
  const allItems = activeProjects.flatMap(project => projectCompletion.get(project.id)?.completedItems || []);

  const positionByKey = new Map<string, number>();
  let position = 0;
  activeProjects.forEach(project => {
    projectCompletion.get(project.id)?.completedItems.forEach(item => {
      positionByKey.set(`${project.id}-${item.sceneId}`, ++position);
    });
  });

  const handleCopySingle = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (error) {
      console.error('Failed to copy', error);
    }
  };

  const numberedPrompts = (items: { generatedPrompt: string }[]) =>
    items.map((item, index) => `${index + 1}. ${item.generatedPrompt}`).join('\n\n');

  const handleCopyAll = async () => {
    if (!overall.isComplete) return;
    try {
      await navigator.clipboard.writeText(numberedPrompts(allItems));
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy all', error);
    }
  };

  const executeSingleDownload = (type: 'script' | 'prompt') => {
    if (!overall.isComplete || allItems.length === 0) return;
    const content = type === 'script'
      ? allItems.map(item => item.sourceText).join('\n\n')
      : numberedPrompts(allItems);
    const fileName = type === 'script'
      ? `KichBan_Goc_${new Date().toISOString().slice(0, 10)}.txt`
      : `Prompt_Veo3_${new Date().toISOString().slice(0, 10)}.txt`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const handleDownloadOption = (option: 'script' | 'prompt' | 'both') => {
    if (option === 'both') {
      executeSingleDownload('script');
      setTimeout(() => executeSingleDownload('prompt'), 300);
    } else {
      executeSingleDownload(option);
    }
    setShowDownloadMenu(false);
  };

  const handleShare = async () => {
    if (!onShare || !overall.isComplete) return;
    setIsSharing(true);
    try {
      const id = await onShare();
      if (id) {
        const link = `${window.location.origin}${window.location.pathname}?session=${id}`;
        await navigator.clipboard.writeText(link);
        setShareLink(link);
        setTimeout(() => setShareLink(null), 4000);
      }
    } finally {
      setIsSharing(false);
    }
  };

  return (
    <div className="w-full max-w-6xl mx-auto pb-20 animate-fade-in-up">
      <div className="sticky top-[80px] z-30 mb-8 border-b border-slate-800 bg-slate-950/90 py-4 backdrop-blur-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white">{overall.isComplete ? 'Prompts Hoàn Thiện' : 'Tiến độ tạo Prompts'}</h2>
            <p className="mt-1 text-sm text-slate-400">
              Đã hoàn thành {overall.completedPrompts}/{overall.totalScenes} prompt — tương ứng {overall.percent}% số cảnh.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-4">
            {overall.isComplete && onShare && (
              <button onClick={handleShare} disabled={isSharing} className={`flex items-center gap-2 rounded-xl border px-5 py-2.5 text-sm font-bold transition-all ${shareLink ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-400' : 'border-slate-700 bg-slate-800 text-amber-400 hover:bg-slate-700'}`}>
                {isSharing ? 'Đang tải lên...' : shareLink ? 'Đã copy Link!' : 'Chia Sẻ Link'}
              </button>
            )}

            {overall.isComplete && (
              <div className="relative">
                <button onClick={() => setShowDownloadMenu(!showDownloadMenu)} className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-5 py-2.5 text-sm font-bold text-white transition-all hover:bg-slate-700">
                  ↓ Tải File
                </button>
                {showDownloadMenu && (
                  <div className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-slate-700 bg-slate-800 shadow-2xl">
                    <button onClick={() => handleDownloadOption('script')} className="w-full border-b border-slate-700/50 px-4 py-3 text-left text-sm text-slate-300 hover:bg-slate-700">📄 File Kịch bản (Thoại)</button>
                    <button onClick={() => handleDownloadOption('prompt')} className="w-full border-b border-slate-700/50 px-4 py-3 text-left text-sm text-slate-300 hover:bg-slate-700">🎬 File Prompt (Veo 3)</button>
                    <button onClick={() => handleDownloadOption('both')} className="w-full px-4 py-3 text-left text-sm font-bold text-indigo-400 hover:bg-slate-700">📦 Tải cả 2 file</button>
                  </div>
                )}
              </div>
            )}

            {overall.isComplete && (
              <button onClick={handleCopyAll} className={`rounded-xl px-6 py-2.5 text-sm font-bold text-white shadow-lg transition-all ${allCopied ? 'bg-emerald-500' : 'bg-indigo-600 hover:bg-indigo-500'}`}>
                {allCopied ? '✓ Đã copy thành công!' : '▣ Copy tất cả Prompts'}
              </button>
            )}

            <button onClick={onBack} className="text-sm text-slate-500 underline transition-colors hover:text-white">← Sửa cảnh</button>
          </div>
        </div>

        <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800">
          <div className={`h-full rounded-full transition-all duration-500 ${overall.isComplete ? 'bg-emerald-500' : 'bg-indigo-500'}`} style={{ width: `${overall.percent}%` }} />
        </div>
        {!overall.isComplete && (
          <p className="mt-2 text-xs font-medium text-amber-300">
            Còn thiếu {overall.missingPrompts} prompt. Nút tải và copy sẽ xuất hiện khi đủ 100% số cảnh.
          </p>
        )}
      </div>

      <div className="space-y-12">
        {activeProjects.map(project => {
          const completion = projectCompletion.get(project.id)!;
          const missingPreview = completion.missingSceneIds.slice(0, 20).join(', ');
          const moreMissing = Math.max(0, completion.missingSceneIds.length - 20);
          return (
            <div key={project.id} className="animate-fade-in">
              <div className="mb-6 flex items-center gap-3">
                <div className="h-px flex-1 bg-slate-800" />
                <h3 className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-4 py-1 text-lg font-bold text-slate-200">
                  {project.name}
                  <span className="text-sm font-normal text-slate-500">({completion.completedPrompts}/{completion.totalScenes} prompts · {completion.percent}%)</span>
                  {project.rescueProvider && (
                    <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-500">
                      Cứu hộ bởi {project.rescueProvider}
                    </span>
                  )}
                </h3>
                <div className="h-px flex-1 bg-slate-800" />
              </div>

              {project.promptStatus === 'error' && project.promptErrorMessage && (
                <div className="mb-4 rounded-2xl border border-red-800/50 bg-red-950/30 p-5">
                  <h3 className="mb-1 font-bold text-red-400">⚠️ Lỗi tạo Prompt</h3>
                  <p className="font-mono text-sm text-red-300/80">{project.promptErrorMessage}</p>
                </div>
              )}

              {project.promptStatus === 'loading' && (
                <div className="mb-6 flex flex-col items-center justify-center gap-4 rounded-2xl border border-indigo-500/30 bg-slate-900/50 p-8">
                  <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-500" />
                  <div className="text-center">
                    <span className="block font-bold text-indigo-400">{project.loadingMessage || 'Đang viết Prompt tối ưu...'}</span>
                    <span className="mt-1 block text-xs text-slate-500">Đã có {completion.completedPrompts}/{completion.totalScenes} prompt.</span>
                  </div>
                </div>
              )}

              {!completion.isComplete && project.promptStatus !== 'loading' && (
                <div className="mb-6 flex flex-col gap-4 rounded-2xl border border-amber-500/40 bg-amber-950/20 p-5 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h3 className="font-bold text-amber-300">Thiếu {completion.missingSceneIds.length} prompt</h3>
                    <p className="mt-1 text-xs text-amber-200/70">Cảnh chưa có prompt: {missingPreview}{moreMissing > 0 ? ` và ${moreMissing} cảnh khác` : ''}.</p>
                  </div>
                  <button onClick={() => onRetryPrompt(project.id)} className="shrink-0 rounded-xl border border-amber-500 bg-amber-500/15 px-5 py-2.5 font-bold text-amber-300 transition-all hover:bg-amber-500 hover:text-slate-950">
                    🩹 Vá {completion.missingSceneIds.length} prompt còn thiếu
                  </button>
                </div>
              )}

              {completion.completedItems.length > 0 && (
                <div className="space-y-6">
                  {completion.completedItems.map(item => {
                    const itemKey = `${project.id}-${item.sceneId}`;
                    const itemPosition = positionByKey.get(itemKey);
                    return (
                      <div key={itemKey} className="group relative rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl transition-all hover:border-indigo-500/30">
                        {overall.isComplete && (
                          <div className="absolute right-5 top-5">
                            <button onClick={() => handleCopySingle(itemPosition ? `${itemPosition}. ${item.generatedPrompt}` : item.generatedPrompt, itemKey)} className={`rounded-lg p-2 transition-all ${copiedId === itemKey ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'}`} title="Copy Prompt (kèm số thứ tự)">
                              {copiedId === itemKey ? '✓' : '▣'}
                            </button>
                          </div>
                        )}

                        <div className={overall.isComplete ? 'pr-12' : ''}>
                          <div className="mb-3 flex items-center gap-3">
                            <span className="rounded bg-amber-500/15 px-2 py-1 text-xs font-black tracking-wider text-amber-400">#{itemPosition ?? '-'}</span>
                            <span className="rounded bg-indigo-500/10 px-2 py-1 text-xs font-bold uppercase tracking-wider text-indigo-400">Cảnh {item.sceneId}</span>
                          </div>
                          <div className="mb-4">
                            <h4 className="mb-1 text-[10px] font-bold uppercase tracking-tighter text-slate-500">Lời thoại kịch bản gốc</h4>
                            <p className="border-l-2 border-slate-700 pl-3 text-sm italic leading-relaxed text-slate-300">“{item.sourceText}”</p>
                          </div>
                          <div>
                            <h4 className="mb-2 text-[10px] font-bold uppercase tracking-tighter text-emerald-500">Generated Prompt (Veo 3)</h4>
                            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-slate-800/80 bg-slate-950/50 p-4 font-mono text-sm font-medium leading-relaxed text-white">{item.generatedPrompt}</pre>
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

      {overall.isComplete && (
        <div className="mt-16 text-center">
          <button onClick={onReset} className="rounded-full border border-slate-700 px-8 py-3 font-bold text-slate-400 transition-all hover:bg-slate-800 hover:text-white">+ Tạo kịch bản mới</button>
        </div>
      )}
    </div>
  );
};

export default PromptOutput;
