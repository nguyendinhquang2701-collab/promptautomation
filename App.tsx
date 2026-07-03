import React, { useState, useEffect } from 'react';
import ScriptInput from './components/ScriptInput';
import SceneList from './components/SceneList';
import PromptOutput from './components/PromptOutput';
import Dashboard from './components/Dashboard'; 
import Header from './components/Header';
import { AppState, ScriptProject, ColorStyle, CharacterIdentity } from './types';
import { analyzeSingleSegmentToScenes, generatePromptsForSingleSegment, extractContextAndCharacters, analyzeImageStyle, AI_PROVIDERS, repairFailedScenes, PromptOptions } from './services/geminiService';

const LICENSE_DB_URL = "https://planning-with-ai-367b2-default-rtdb.asia-southeast1.firebasedatabase.app/veo3_licenses.json";

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(() => (localStorage.getItem('app1_appState') as AppState) || AppState.INPUT);

  const [isCheckingLicense, setIsCheckingLicense] = useState(true);
  const [isLicensed, setIsLicensed] = useState(false);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');
  const [licenseError, setLicenseError] = useState('');

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

  const generateFingerprint = async () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = "top";
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = "#f60";
      ctx.fillRect(125,1,62,20);
      ctx.fillStyle = "#069";
      ctx.fillText("Veo3Enterprise", 2, 15);
      ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
      ctx.fillText("Veo3Enterprise", 4, 17);
    }
    const canvasData = canvas.toDataURL();
    const navInfo = navigator.userAgent + navigator.hardwareConcurrency + navigator.language + window.screen.width + window.screen.height;
    let hash = 0;
    const str = canvasData + navInfo;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return `HW-${Math.abs(hash).toString(16).toUpperCase()}`;
  };

  const verifyLicense = async (keyToCheck: string) => {
    setLicenseError('');
    try {
      const hwId = await generateFingerprint();
      const res = await fetch(LICENSE_DB_URL);
      const data = await res.json();
      
      if (!data || !data[keyToCheck]) {
         setLicenseError('❌ Mã bản quyền không tồn tại hoặc đã bị thu hồi!');
         setIsLicensed(false);
         setIsCheckingLicense(false);
         return;
      }

      const licenseInfo = data[keyToCheck];
      const now = Date.now();

      if (!licenseInfo.deviceId) {
         // 👉 SỬA ĐỔI: Xử lý nội suy nếu durationMs là -1
         const expiresAt = licenseInfo.durationMs === -1 ? -1 : now + licenseInfo.durationMs;
         
         await fetch(`https://planning-with-ai-367b2-default-rtdb.asia-southeast1.firebasedatabase.app/veo3_licenses/${keyToCheck}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: hwId, expiresAt, activatedAt: now })
         });
         localStorage.setItem('app1_license_key', keyToCheck);
         localStorage.setItem('app1_license_expiry', expiresAt.toString());
         setIsLicensed(true);
      } 
      else if (licenseInfo.deviceId === hwId) {
         // 👉 SỬA ĐỔI: Kiểm tra bypass, nếu expiresAt !== -1 thì mới xét hết hạn
         if (licenseInfo.expiresAt !== -1 && now > licenseInfo.expiresAt) {
            setLicenseError('⏳ Mã bản quyền của bạn đã hết hạn!');
            setIsLicensed(false);
         } else {
            localStorage.setItem('app1_license_key', keyToCheck);
            localStorage.setItem('app1_license_expiry', licenseInfo.expiresAt.toString());
            setIsLicensed(true);
         }
      } 
      else {
         setLicenseError('🚨 CẢNH BÁO: Mã bản quyền này ĐÃ ĐƯỢC GẮN VỚI MỘT THIẾT BỊ KHÁC! Vui lòng mua mã mới để sử dụng.');
         setIsLicensed(false);
      }
    } catch (e) {
      setLicenseError('🌐 Lỗi kết nối mạng khi kiểm tra bản quyền.');
      setIsLicensed(false);
    }
    setIsCheckingLicense(false);
  };

  useEffect(() => {
    const savedKey = localStorage.getItem('app1_license_key');
    if (savedKey) verifyLicense(savedKey);
    else setIsCheckingLicense(false);
  }, []);

  useEffect(() => {
    if(!isLicensed) return;
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
  }, [appState, rawScript, globalContext, customPromptSuffix, styleAnalysis, styleSummary, characters, colorStyle, projects, imagePreview, promptOptions, isLicensed]);

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
        const lic = localStorage.getItem('app1_license_key');
        const exp = localStorage.getItem('app1_license_expiry'); 
        const provider = localStorage.getItem('app1_ai_provider');
        const apiTier = localStorage.getItem('app1_api_tier');
        
        const customProviders = localStorage.getItem('app1_custom_providers');
        
        const keysToSave: Record<string, string | null> = {};
        Object.keys(AI_PROVIDERS).forEach(key => {
            const storageKey = `app1_${AI_PROVIDERS[key].keyPrefix}_api_keys`;
            keysToSave[storageKey] = localStorage.getItem(storageKey);
        });
        
        localStorage.clear(); 

        if(lic) localStorage.setItem('app1_license_key', lic);
        if(exp) localStorage.setItem('app1_license_expiry', exp);
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

  if (isCheckingLicense) return <div className="min-h-screen bg-slate-950 flex items-center justify-center"><div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full"></div></div>;

  if (!isLicensed) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 selection:bg-indigo-500">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-2xl text-center relative overflow-hidden">
           <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500"></div>
           <div className="w-20 h-20 bg-slate-950 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner border border-slate-800">
             <span className="text-4xl">🔐</span>
           </div>
           <h2 className="text-2xl font-black text-white mb-2 tracking-tight">VEO 3 ENTERPRISE</h2>
           <p className="text-slate-400 text-sm mb-8">Vui lòng nhập Mã Bản Quyền (License Key) để kích hoạt phần mềm. Mỗi mã chỉ dùng cho 1 thiết bị.</p>
           
           <input type="text" value={licenseKeyInput} onChange={e => { setLicenseKeyInput(e.target.value.toUpperCase()); setLicenseError(''); }} placeholder="VD: PRO-XXXX-YYYY" className="w-full bg-slate-950 border border-slate-700 focus:border-indigo-500 text-white rounded-xl p-4 text-center font-mono text-lg tracking-widest outline-none mb-4 uppercase transition-all" />
           
           {licenseError && <p className="text-red-400 text-sm mb-4 bg-red-500/10 p-3 rounded-lg border border-red-500/20 animate-fade-in">{licenseError}</p>}
           
           <button onClick={() => verifyLicense(licenseKeyInput)} disabled={!licenseKeyInput} className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-indigo-500/20">Xác Thực Bản Quyền</button>
           <p className="text-[10px] text-slate-500 mt-6 flex items-center justify-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" /></svg>
              Hệ thống khóa phần cứng chống sao chép đang được bật.
           </p>
        </div>
      </div>
    );
  }

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
              onExtractContext={handleExtractContext} isExtractingContext={contextLoading} onAddProject={() => setProjects([...projects, { id: Date.now().toString(), name: `Phân đoạn ${projects.length + 1}`, content: '', scenes: [], promptItems: [], sceneStatus: 'idle', promptStatus: 'idle' }])} onRemoveProject={(id) => setProjects(projects.filter(p => p.id !== id))} onUpdateContent={(id, c) => setProjects(projects.map(p => p.id === id ? { ...p, content: c } : p))} onUpdateName={(id, n) => setProjects(projects.map(p => p.id === id ? { ...p, name: n } : p))} onAnalyze={handleAnalyze} isAnalyzing={loading} styleAnalysis={styleAnalysis} setStyleAnalysis={setStyleAnalysis} styleSummary={styleSummary} setStyleSummary={setStyleSummary} onAnalyzeStyle={handleAnalyzeStyle} isAnalyzingStyle={styleLoading} characters={characters} onUpdateCharacter={(id, f, v) => setCharacters(characters.map(c => c.id === id ? { ...c, [f]: v } : c))} onAddCharacter={() => setCharacters([...characters, { id: `char-${Date.now()}`, name: 'Nhân vật mới', visualDescription: '' }])} onRemoveCharacter={(id) => setCharacters(characters.filter(c => c.id !== id))} onReset={resetApp} imagePreview={imagePreview} setImagePreview={setImagePreview} 
              
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
