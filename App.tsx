import React, { useState, useEffect } from 'react';
import ScriptInput from './components/ScriptInput';
import SceneList from './components/SceneList';
import PromptOutput from './components/PromptOutput';
import Header from './components/Header';
import { AppState, ScriptProject, ColorStyle, CharacterIdentity } from './types';
import { analyzeSingleSegmentToScenes, generatePromptsForSingleSegment, extractContextAndCharacters, analyzeImageStyle, AI_PROVIDERS, repairFailedScenes, PromptOptions } from './services/geminiService';

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(() => (localStorage.getItem('app1_appState') as AppState) || AppState.INPUT);

  const [loading, setLoading] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [styleLoading, setStyleLoading] = useState(false);
  const [useParallel, setUseParallel] = useState(true);
  
  const [rawScript, setRawScript] = useState(() => localStorage.getItem('app1_rawScript') || '');
  const [globalContext, setGlobalContext] = useState(() => localStorage.getItem('app1_globalContext') || '');
  
  const [customPromptSuffix, setCustomPromptSuffix] = useState(() => localStorage.getItem('app1_customPromptSuffix') || '');
  
  const [styleAnalysis, setStyleAnalysis] = useState(() => localStorage.getItem('app1_styleAnalysis') || '');
  const [styleSummary, setStyleSummary] = useState(() => localStorage.getItem('app1_styleSummary') || '');
  const [imagePreview, setImagePreview] = useState<string | null>(() => localStorage.getItem('app1_imagePreview') || null);

  const [characters, setCharacters] = useState<CharacterIdentity[]>(() => {
    const saved = localStorage.getItem('app1_characters');
    return saved ? JSON.parse(saved) : [];
  });
  
  const [colorStyle, setColorStyle] = useState<ColorStyle>(() => (localStorage.getItem('app1_colorStyle') as ColorStyle) || 'cinematic');
  
  // 👉 Cập nhật cấu hình mặc định: audioMode là 'remove'
  const [promptOptions, setPromptOptions] = useState<PromptOptions>(() => {
    const saved = localStorage.getItem('app1_promptOptions');
    return saved ? JSON.parse(saved) : { splitLogic: 'default', audioMode: 'remove' };
  });

  const [projects, setProjects] = useState<ScriptProject[]>(() => {
    const saved = localStorage.getItem('app1_projects');
    if (!saved) return [{ id: '1', name: 'Phân đoạn 1', content: '', scenes: [], promptItems: [], sceneStatus: 'idle', promptStatus: 'idle' }];
    // 👉 MIGRATION: dự án cũ chỉ có 1 cờ `status` dùng chung. Suy ra trạng thái
    // riêng cho từng bước dựa trên dữ liệu thực tế (scenes / promptItems).
    return (JSON.parse(saved) as any[]).map((p) => {
      if (p.sceneStatus || p.promptStatus) return p as ScriptProject;
      const hasScenes = Array.isArray(p.scenes) && p.scenes.length > 0;
      const hasPrompts = Array.isArray(p.promptItems) && p.promptItems.length > 0;
      return {
        ...p,
        sceneStatus: hasScenes ? 'success' : (p.status === 'loading' ? 'idle' : (p.status || 'idle')),
        sceneErrorMessage: hasScenes ? undefined : p.errorMessage,
        promptStatus: hasPrompts ? 'success' : 'idle',
        promptErrorMessage: hasPrompts ? undefined : (hasScenes ? p.errorMessage : undefined),
      } as ScriptProject;
    });
  });

  useEffect(() => {
    localStorage.setItem('app1_appState', appState);
    localStorage.setItem('app1_rawScript', rawScript);
    localStorage.setItem('app1_globalContext', globalContext);
    localStorage.setItem('app1_customPromptSuffix', customPromptSuffix);
    localStorage.setItem('app1_styleAnalysis', styleAnalysis);
    localStorage.setItem('app1_styleSummary', styleSummary);
    localStorage.setItem('app1_characters', JSON.stringify(characters));
    localStorage.setItem('app1_colorStyle', colorStyle);
    localStorage.setItem('app1_projects', JSON.stringify(projects));
    localStorage.setItem('app1_imagePreview', imagePreview || '');
    localStorage.setItem('app1_promptOptions', JSON.stringify(promptOptions));
  }, [appState, rawScript, globalContext, customPromptSuffix, styleAnalysis, styleSummary, characters, colorStyle, projects, imagePreview, promptOptions]);

  const hasScenes = projects.some(p => p.scenes && p.scenes.length > 0);
  const hasPrompts = projects.some(p => p.promptItems && p.promptItems.length > 0);

  const requireApiKey = () => {
    const providerId = localStorage.getItem('app1_ai_provider') || Object.keys(AI_PROVIDERS)[0] || 'gemini';
    const providerConfig = AI_PROVIDERS[providerId] || AI_PROVIDERS[Object.keys(AI_PROVIDERS)[0]];
    const keys = JSON.parse(localStorage.getItem(`app1_${providerConfig.keyPrefix}_api_keys`) || '[]');
    if (keys.length === 0) {
      alert(`⚠️ CẢNH BÁO: Vui lòng nhập ít nhất 1 ${providerConfig.name} API Key ở ô góc trên bên phải thanh Menu trước khi bắt đầu!`);
      return false;
    }
    return true;
  };

  const handleExtractContext = async (textToExtract: string) => {
    if (!requireApiKey() || !textToExtract.trim()) return;
    setContextLoading(true);
    try {
      const { context, characters: chars } = await extractContextAndCharacters(textToExtract);
      setGlobalContext(context); 
      setCharacters(chars);
      const MAX_CHUNK = 4500;
      let chunks = []; let remaining = textToExtract;
      while (remaining.length > 0) {
        if (remaining.length <= MAX_CHUNK) { chunks.push(remaining.trim()); break; }
        const chunk = remaining.substring(0, MAX_CHUNK);
        let splitIndex = chunk.lastIndexOf('\n\n');
        if (splitIndex === -1 || splitIndex < 3500) splitIndex = chunk.lastIndexOf('\n');
        if (splitIndex === -1 || splitIndex < 3500) splitIndex = chunk.lastIndexOf('. ');
        if (splitIndex === -1) splitIndex = MAX_CHUNK;
        chunks.push(remaining.substring(0, splitIndex).trim());
        remaining = remaining.substring(splitIndex).trim();
      }
      setProjects(chunks.map((content, i) => ({ id: (Date.now() + i).toString(), name: `Phân đoạn ${i + 1}`, content, scenes: [], promptItems: [], sceneStatus: 'idle', promptStatus: 'idle' })));
    } catch (e: any) { 
      alert(e.message); 
    } finally { setContextLoading(false); }
  };

  const handleAnalyzeStyle = async (base64: string, mimeType: string) => {
    if (!requireApiKey()) return;
    setStyleLoading(true);
    try {
      const result = await analyzeImageStyle(base64, mimeType);
      setStyleAnalysis(result.analysis); setStyleSummary(result.summary);
    } catch (e: any) { 
      alert(`❌ LỖI PHÂN TÍCH ẢNH:\n${e.message}`); 
    } finally { 
      setStyleLoading(false); 
    }
  };

  const handleAnalyze = async () => {
    if (!requireApiKey()) return;
    setLoading(true);
    const activeProjects = projects.filter(p => p.content.trim());
    if (activeProjects.length === 0) { setLoading(false); return; }
    
    const apiTier = localStorage.getItem('app1_api_tier') || 'paid';
    setAppState(AppState.SCENE_REVIEW); 

    if (apiTier === 'free') {
      setProjects(prev => prev.map(p => p.content.trim() ? { ...p, sceneStatus: 'loading', scenes: [], sceneErrorMessage: undefined, promptItems: [], promptStatus: 'idle', promptErrorMessage: undefined } : p));

      for (const project of activeProjects) {
        try {
          const scenes = await analyzeSingleSegmentToScenes({ id: project.id, content: project.content }, globalContext, promptOptions, characters);
          setProjects(prev => {
            const updatedProjects = prev.map(p => p.id === project.id ? { ...p, scenes, sceneStatus: 'success' as const } : p);
            let counter = 1;
            return updatedProjects.map(p => {
               if (p.scenes && p.scenes.length > 0) return { ...p, scenes: p.scenes.map(s => ({ ...s, id: counter++ })) };
               return p;
            });
          });
        } catch (error: any) {
          setProjects(prev => prev.map(p => {
             if (p.id === project.id) return { ...p, sceneStatus: 'error', sceneErrorMessage: String(error) };
             if (p.sceneStatus === 'loading' && p.id !== project.id) return { ...p, sceneStatus: 'error', sceneErrorMessage: 'Tiến trình bị hủy tự động do phân đoạn trước sập toàn bộ AI.' };
             return p;
          }));
          break;
        }
      }
    } else {
      setProjects(prev => prev.map(p => p.content.trim() ? { ...p, sceneStatus: 'loading', scenes: [], sceneErrorMessage: undefined, promptItems: [], promptStatus: 'idle', promptErrorMessage: undefined } : p));

      const analyzePromises = activeProjects.map(async (project) => {
        try {
          const scenes = await analyzeSingleSegmentToScenes({ id: project.id, content: project.content }, globalContext, promptOptions, characters);
          setProjects(prev => {
            const updatedProjects = prev.map(p => p.id === project.id ? { ...p, scenes, sceneStatus: 'success' as const } : p);
            let counter = 1;
            return updatedProjects.map(p => {
               if (p.scenes && p.scenes.length > 0) return { ...p, scenes: p.scenes.map(s => ({ ...s, id: counter++ })) };
               return p;
            });
          });
        } catch (error: any) {
          setProjects(prev => prev.map(p => p.id === project.id ? { ...p, sceneStatus: 'error', sceneErrorMessage: String(error) } : p));
        }
      });
      await Promise.all(analyzePromises);
    }
    
    setLoading(false);
  };

  const handleRetryAnalyze = async (projectId: string) => {
    if (!requireApiKey()) return;
    const projectToRetry = projects.find(p => p.id === projectId);
    if (!projectToRetry) return;
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, sceneStatus: 'loading', sceneErrorMessage: undefined } : p));
    try {
      const scenes = await analyzeSingleSegmentToScenes({ id: projectToRetry.id, content: projectToRetry.content }, globalContext, promptOptions, characters);
      setProjects(prev => {
        const updatedProjects = prev.map(p => p.id === projectId ? { ...p, scenes, sceneStatus: 'success' as const } : p);
        let counter = 1;
        return updatedProjects.map(p => {
           if (p.scenes && p.scenes.length > 0) return { ...p, scenes: p.scenes.map(s => ({ ...s, id: counter++ })) };
           return p;
        });
      });
    } catch (error: any) {
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, sceneStatus: 'error', sceneErrorMessage: String(error) } : p));
    }
  };

  const handleRepairScenes = async (projectId: string) => {
    if (!requireApiKey()) return;
    
    const project = projects.find(p => p.id === projectId);
    if (!project || !project.scenes) return;

    const failedScenes = project.scenes.filter(s => s.visualDescription === "");
    if (failedScenes.length === 0) return;

    setProjects(prev => prev.map(p => {
        if (p.id === projectId) {
            return {
                ...p,
                scenes: p.scenes.map(s => failedScenes.find(fs => fs.id === s.id) ? { ...s, isRepairing: true } : s)
            };
        }
        return p;
    }));

    try {
        const repairedScenes = await repairFailedScenes(failedScenes, globalContext, promptOptions, characters);
        
        setProjects(prev => prev.map(p => {
            if (p.id === projectId) {
                const newScenes = p.scenes.map(s => {
                    const repaired = repairedScenes.find(rs => rs.id === s.id);
                    if (repaired) {
                        return { ...repaired, isRepairing: false };
                    }
                    return { ...s, isRepairing: false };
                });
                return { ...p, scenes: newScenes };
            }
            return p;
        }));
    } catch (error: any) {
        alert(`Lỗi khi vá cảnh: ${error.message}`);
        setProjects(prev => prev.map(p => {
            if (p.id === projectId) {
                return { ...p, scenes: p.scenes.map(s => ({ ...s, isRepairing: false })) };
            }
            return p;
        }));
    }
  };

  const handleGeneratePrompts = async () => {
    if (!requireApiKey()) return;
    setLoading(true);
    const active = projects.filter(p => p.scenes.length > 0);
    
    const apiTier = localStorage.getItem('app1_api_tier') || 'paid';
    setAppState(AppState.RESULT);

    if (apiTier === 'free') {
      setProjects(prev => prev.map(p => p.scenes.length > 0 ? { ...p, promptStatus: 'loading', promptErrorMessage: undefined, loadingMessage: 'Đang xếp hàng chờ đến lượt...', rescueProvider: undefined } : p));

      for (const project of active) {
        setProjects(prev => prev.map(p => p.id === project.id ? { ...p, loadingMessage: 'Đang viết lại Prompt tối ưu...' } : p));
        try {
          const result = await generatePromptsForSingleSegment(
            { id: project.id, scenes: project.scenes },
            globalContext, colorStyle, styleAnalysis, styleSummary, characters,
            (msg) => setProjects(prev => prev.map(p => p.id === project.id ? { ...p, loadingMessage: msg } : p)),
            customPromptSuffix, promptOptions
          );
          setProjects(prev => prev.map(p => p.id === project.id ? { ...p, promptItems: result.items, rescueProvider: result.rescueProvider, promptStatus: 'success' } : p));
        } catch (error: any) {
          setProjects(prev => prev.map(p => {
             if (p.id === project.id) return { ...p, promptStatus: 'error', promptErrorMessage: String(error), loadingMessage: undefined };
             if (p.promptStatus === 'loading' && p.id !== project.id) return { ...p, promptStatus: 'error', promptErrorMessage: 'Tiến trình bị hủy tự động do phân đoạn trước sập toàn bộ AI.', loadingMessage: undefined, rescueProvider: undefined };
             return p;
          }));
          break;
        }
      }
    } else {
      setProjects(prev => prev.map(p => p.scenes.length > 0 ? { ...p, promptStatus: 'loading', promptErrorMessage: undefined, loadingMessage: undefined, rescueProvider: undefined } : p));

      const promptPromises = active.map(async (project) => {
        try {
          const result = await generatePromptsForSingleSegment(
            { id: project.id, scenes: project.scenes },
            globalContext, colorStyle, styleAnalysis, styleSummary, characters,
            (msg) => setProjects(prev => prev.map(p => p.id === project.id ? { ...p, loadingMessage: msg } : p)),
            customPromptSuffix, promptOptions
          );
          setProjects(prev => prev.map(p => p.id === project.id ? { ...p, promptItems: result.items, rescueProvider: result.rescueProvider, promptStatus: 'success' } : p));
        } catch (error: any) {
          setProjects(prev => prev.map(p => p.id === project.id ? { ...p, promptStatus: 'error', promptErrorMessage: String(error) } : p));
        }
      });
      await Promise.all(promptPromises);
    }
    
    setLoading(false);
  };

  const handleRetryPrompt = async (projectId: string) => {
    if (!requireApiKey()) return;
    const projectToRetry = projects.find(p => p.id === projectId);
    if (!projectToRetry || projectToRetry.scenes.length === 0) return;

    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, promptStatus: 'loading', promptErrorMessage: undefined, loadingMessage: undefined, rescueProvider: undefined } : p));

    try {
      const result = await generatePromptsForSingleSegment(
        { id: projectToRetry.id, scenes: projectToRetry.scenes },
        globalContext, colorStyle, styleAnalysis, styleSummary, characters,
        (msg) => setProjects(prev => prev.map(p => p.id === projectId ? { ...p, loadingMessage: msg } : p)),
        customPromptSuffix, promptOptions
      );
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, promptItems: result.items, rescueProvider: result.rescueProvider, promptStatus: 'success' } : p));
    } catch (error: any) {
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, promptStatus: 'error', promptErrorMessage: String(error) } : p));
    }
  };

  const resetApp = () => {
    if (window.confirm("Làm mới dự án? Màn hình này sẽ được xóa sạch để làm kịch bản mới.")) {
        const provider = localStorage.getItem('app1_ai_provider');
        const apiTier = localStorage.getItem('app1_api_tier');

        const customProviders = localStorage.getItem('app1_custom_providers');

        const keysToSave: Record<string, string | null> = {};
        Object.keys(AI_PROVIDERS).forEach(key => {
            const storageKey = `app1_${AI_PROVIDERS[key].keyPrefix}_api_keys`;
            keysToSave[storageKey] = localStorage.getItem(storageKey);
        });

        localStorage.clear();

        if(provider) localStorage.setItem('app1_ai_provider', provider);
        if(apiTier) localStorage.setItem('app1_api_tier', apiTier);
        
        if(customProviders) localStorage.setItem('app1_custom_providers', customProviders);
        
        Object.entries(keysToSave).forEach(([k, v]) => { if (v) localStorage.setItem(k, v); });

        setAppState(AppState.INPUT); setRawScript(''); setGlobalContext(''); setStyleAnalysis(''); setStyleSummary(''); setCharacters([]); setColorStyle('cinematic'); setImagePreview(null); 
        setCustomPromptSuffix('');
        // 👉 Cập nhật reset kèm audioMode
        setPromptOptions({ splitLogic: 'default', audioMode: 'remove' });
        setProjects([{ id: Date.now().toString(), name: 'Phân đoạn 1', content: '', scenes: [], promptItems: [], sceneStatus: 'idle', promptStatus: 'idle' }]);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-200">
      <Header />

      <main className="flex-1 w-full px-4 pt-10 pb-10 relative z-10">
        <div className="max-w-xl mx-auto mb-10">
          <div className="flex justify-between items-center relative">
             <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-1 bg-slate-800 -z-0 rounded-full"></div>
             <div className={`absolute left-0 top-1/2 -translate-y-1/2 h-1 bg-indigo-500 -z-0 rounded-full transition-all duration-500 ease-out ${appState === AppState.INPUT ? 'w-0' : (appState === AppState.SCENE_REVIEW) ? 'w-1/2' : 'w-full'}`}></div>
             {[1, 2, 3].map((num) => {
               const step = num === 1 ? AppState.INPUT : num === 2 ? AppState.SCENE_REVIEW : AppState.RESULT;
               const isActive = appState === step;
               const isClickable = num === 1 || (num === 2 && hasScenes) || (num === 3 && hasPrompts);
               return (
                <button key={num} onClick={() => !loading && isClickable && setAppState(step)} disabled={loading || !isClickable}
                  className={`relative z-10 w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-300 ring-4 ring-slate-950
                    ${isActive ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/50 scale-110' : isClickable ? 'bg-indigo-900/50 text-indigo-300 hover:bg-indigo-800 cursor-pointer' : 'bg-slate-800/50 text-slate-500 cursor-not-allowed'}`}
                >{num}</button>
               )
             })}
          </div>
          <div className="flex justify-between mt-3 text-[10px] font-black uppercase tracking-widest text-slate-500">
            <span>Kịch bản</span><span>Cảnh 8s</span><span>Prompts</span>
          </div>
        </div>

        <div className="w-full">
          {appState === AppState.INPUT && (
            <ScriptInput 
              projects={projects} rawScript={rawScript} setRawScript={setRawScript} globalContext={globalContext} setGlobalContext={setGlobalContext} 
              customPromptSuffix={customPromptSuffix} setCustomPromptSuffix={setCustomPromptSuffix}
              onExtractContext={handleExtractContext} isExtractingContext={contextLoading} onAddProject={() => setProjects([...projects, { id: Date.now().toString(), name: `Phân đoạn ${projects.length + 1}`, content: '', scenes: [], promptItems: [], sceneStatus: 'idle', promptStatus: 'idle' }])} onRemoveProject={(id) => setProjects(projects.filter(p => p.id !== id))} onUpdateContent={(id, c) => setProjects(projects.map(p => p.id === id ? { ...p, content: c } : p))} onUpdateName={(id, n) => setProjects(projects.map(p => p.id === id ? { ...p, name: n } : p))} onAnalyze={handleAnalyze} isAnalyzing={loading} styleAnalysis={styleAnalysis} setStyleAnalysis={setStyleAnalysis} styleSummary={styleSummary} setStyleSummary={setStyleSummary} onAnalyzeStyle={handleAnalyzeStyle} isAnalyzingStyle={styleLoading} characters={characters} onUpdateCharacter={(id, f, v) => setCharacters(characters.map(c => c.id === id ? { ...c, [f]: v } : c))} onAddCharacter={() => setCharacters([...characters, { id: `char-${Date.now()}`, name: 'Nhân vật mới', promptName: '', originalName: '', visualDescription: '' }])} onRemoveCharacter={(id) => setCharacters(characters.filter(c => c.id !== id))} onReset={resetApp} imagePreview={imagePreview} setImagePreview={setImagePreview} 
              
              colorStyle={colorStyle}
              setColorStyle={setColorStyle}
              promptOptions={promptOptions}
              setPromptOptions={setPromptOptions}
            />
          )}
          {appState === AppState.SCENE_REVIEW && (
            <SceneList 
              projects={projects} 
              onBack={() => setAppState(AppState.INPUT)} 
              onGeneratePrompts={handleGeneratePrompts} 
              isGenerating={loading} 
              useParallel={useParallel} 
              setUseParallel={setUseParallel} 
              onRetryAnalyze={handleRetryAnalyze}
              onRepairScenes={handleRepairScenes} 
            />
          )}
          {appState === AppState.RESULT && (
            <PromptOutput projects={projects} onReset={resetApp} onBack={() => setAppState(AppState.SCENE_REVIEW)} onRetryPrompt={handleRetryPrompt} />
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
