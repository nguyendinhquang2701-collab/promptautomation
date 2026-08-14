import React, { useState, useEffect, useRef } from 'react';
import ScriptInput from './components/ScriptInput';
import SceneList from './components/SceneList';
import PromptOutput from './components/PromptOutput';
import Header from './components/Header';
import { AppState, ScriptProject, ColorStyle, CharacterIdentity } from './types';
import { analyzeSingleSegmentToScenes, generatePromptsForSingleSegment, extractContextAndCharacters, analyzeImageStyle, AI_PROVIDERS, repairFailedScenes, PromptOptions, AIOperationOptions } from './services/geminiService';
import { createDefaultProject, hydrateProjectsWithReport, serializeProjects } from './state/projectPersistence';

type OperationKind = 'context' | 'style' | 'analyze' | 'prompt' | 'repair';
type ApiTier = 'free' | 'paid';

interface ActiveOperation {
  id: string;
  kind: OperationKind;
  title: string;
  providerId: string;
  providerName: string;
  apiTier: ApiTier;
  startedAt: number;
  deadlineAt: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

interface OperationView {
  id: string;
  title: string;
  providerName: string;
  apiTier: ApiTier;
  startedAt: number;
  deadlineAt: number;
  progress: string;
}

const OPERATION_DEADLINES: Record<OperationKind, number> = {
  context: 5 * 60_000,
  style: 4 * 60_000,
  analyze: 8 * 60_000,
  prompt: 12 * 60_000,
  repair: 5 * 60_000,
};

const cancelledMessage = (timedOut: boolean) => timedOut
  ? 'Tác vụ đã dừng vì vượt quá thời gian cho phép. Phần dữ liệu hoàn thành trước đó vẫn được giữ lại; hãy bấm Thử lại.'
  : 'Tác vụ đã được hủy theo yêu cầu. Phần dữ liệu hoàn thành trước đó vẫn được giữ lại; bạn có thể bấm Thử lại.';

const readableError = (error: unknown): string => {
  const e = error as { name?: string; message?: string };
  if (e?.name === 'TimeoutError' || /deadline|timeout|quá thời gian/i.test(e?.message || '')) {
    return cancelledMessage(true);
  }
  if (e?.name === 'AbortError') return cancelledMessage(false);
  return e?.message || String(error);
};

const safeGetItem = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};

const safeSetItem = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch (error) {
    console.warn(`Không thể lưu ${key} vào bộ nhớ trình duyệt.`, error);
  }
};

const readStoredJSON = <T,>(key: string, fallback: T): T => {
  const raw = safeGetItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(() => (safeGetItem('app1_appState') as AppState) || AppState.INPUT);

  const [loading, setLoading] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [styleLoading, setStyleLoading] = useState(false);
  const [useParallel, setUseParallel] = useState(true);
  const activeOperationRef = useRef<ActiveOperation | null>(null);
  const [operationView, setOperationView] = useState<OperationView | null>(null);
  const [operationClock, setOperationClock] = useState(() => Date.now());
  
  const [rawScript, setRawScript] = useState(() => safeGetItem('app1_rawScript') || '');
  const [globalContext, setGlobalContext] = useState(() => safeGetItem('app1_globalContext') || '');
  
  const [customPromptSuffix, setCustomPromptSuffix] = useState(() => safeGetItem('app1_customPromptSuffix') || '');
  
  const [styleAnalysis, setStyleAnalysis] = useState(() => safeGetItem('app1_styleAnalysis') || '');
  const [styleSummary, setStyleSummary] = useState(() => safeGetItem('app1_styleSummary') || '');
  const [imagePreview, setImagePreview] = useState<string | null>(() => safeGetItem('app1_imagePreview') || null);

  const [characters, setCharacters] = useState<CharacterIdentity[]>(() =>
    readStoredJSON<CharacterIdentity[]>('app1_characters', [])
  );
  
  // Đã bỏ mục chọn "Tông màu video" khỏi UI → luôn dùng tông tự nhiên (default),
  // không ép grading điện ảnh nữa.
  const [colorStyle, setColorStyle] = useState<ColorStyle>('default');
  
  // 👉 Cập nhật cấu hình mặc định: audioMode là 'remove'
  const [promptOptions, setPromptOptions] = useState<PromptOptions>(() =>
    readStoredJSON<PromptOptions>('app1_promptOptions', { splitLogic: 'default', audioMode: 'remove' })
  );

  const [projects, setProjects] = useState<ScriptProject[]>(() => {
    const raw = safeGetItem('app1_projects');
    const restored = hydrateProjectsWithReport(raw);
    // Keep one recovery copy before the normal persistence effect sanitizes bad data.
    if (raw && restored.hadCorruption) safeSetItem('app1_projects_recovery', raw);
    return restored.projects;
  });

  useEffect(() => {
    safeSetItem('app1_appState', appState);
    safeSetItem('app1_rawScript', rawScript);
    safeSetItem('app1_globalContext', globalContext);
    safeSetItem('app1_customPromptSuffix', customPromptSuffix);
    safeSetItem('app1_styleAnalysis', styleAnalysis);
    safeSetItem('app1_styleSummary', styleSummary);
    safeSetItem('app1_characters', JSON.stringify(characters));
    safeSetItem('app1_colorStyle', colorStyle);
    safeSetItem('app1_projects', serializeProjects(projects));
    safeSetItem('app1_imagePreview', imagePreview || '');
    safeSetItem('app1_promptOptions', JSON.stringify(promptOptions));
  }, [appState, rawScript, globalContext, customPromptSuffix, styleAnalysis, styleSummary, characters, colorStyle, projects, imagePreview, promptOptions]);

  useEffect(() => {
    if (!operationView) return;
    setOperationClock(Date.now());
    const interval = setInterval(() => setOperationClock(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [operationView?.id]);

  useEffect(() => () => {
    const operation = activeOperationRef.current;
    if (!operation) return;
    clearTimeout(operation.timer);
    operation.controller.abort();
    activeOperationRef.current = null;
  }, []);

  const hasScenes = projects.some(p => p.scenes && p.scenes.length > 0);
  const hasPrompts = projects.some(p => p.promptItems && p.promptItems.length > 0);

  const isCurrentOperation = (id: string) => activeOperationRef.current?.id === id;

  const settleTransientProjects = (message: string) => {
    setProjects(prev => prev.map((project) => {
      const sceneWasLoading = project.sceneStatus === 'loading';
      const promptWasLoading = project.promptStatus === 'loading';
      return {
        ...project,
        sceneStatus: sceneWasLoading ? 'error' as const : project.sceneStatus,
        sceneErrorMessage: sceneWasLoading ? message : project.sceneErrorMessage,
        promptStatus: promptWasLoading ? 'error' as const : project.promptStatus,
        promptErrorMessage: promptWasLoading ? message : project.promptErrorMessage,
        loadingMessage: promptWasLoading ? undefined : project.loadingMessage,
        scenes: project.scenes.map(scene => scene.isRepairing ? { ...scene, isRepairing: false } : scene),
      };
    }));
  };

  const stopActiveOperation = (id: string, timedOut: boolean) => {
    const operation = activeOperationRef.current;
    if (!operation || operation.id !== id) return;
    clearTimeout(operation.timer);
    activeOperationRef.current = null;
    try {
      operation.controller.abort(new DOMException(
        timedOut ? 'Operation deadline exceeded' : 'Operation cancelled by user',
        timedOut ? 'TimeoutError' : 'AbortError'
      ));
    } catch {
      operation.controller.abort();
    }
    settleTransientProjects(cancelledMessage(timedOut));
    setLoading(false);
    setContextLoading(false);
    setStyleLoading(false);
    setOperationView(null);
    if (timedOut && (operation.kind === 'context' || operation.kind === 'style' || operation.kind === 'repair')) {
      alert(cancelledMessage(true));
    }
  };

  const beginOperation = (kind: OperationKind, title: string): ActiveOperation | null => {
    if (activeOperationRef.current) {
      alert('Một tác vụ khác đang chạy. Hãy chờ hoàn tất hoặc bấm Hủy tác vụ trước.');
      return null;
    }
    const selectedProviderId = safeGetItem('app1_ai_provider') || (AI_PROVIDERS.gemini ? 'gemini' : Object.keys(AI_PROVIDERS)[0]) || 'gemini';
    const provider = AI_PROVIDERS[selectedProviderId] || AI_PROVIDERS[Object.keys(AI_PROVIDERS)[0]];
    const providerId = provider?.id || selectedProviderId;
    const savedTier = safeGetItem('app1_api_tier');
    const apiTier: ApiTier = savedTier === 'paid' ? 'paid' : 'free';
    const startedAt = Date.now();
    const deadlineAt = startedAt + OPERATION_DEADLINES[kind];
    const id = globalThis.crypto?.randomUUID?.() || `${startedAt}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => stopActiveOperation(id, true), OPERATION_DEADLINES[kind]);
    const operation: ActiveOperation = {
      id,
      kind,
      title,
      providerId,
      providerName: provider?.name || 'AI',
      apiTier,
      startedAt,
      deadlineAt,
      controller,
      timer,
    };
    activeOperationRef.current = operation;
    setOperationView({
      id,
      title,
      providerName: operation.providerName,
      apiTier,
      startedAt,
      deadlineAt,
      progress: 'Đang chuẩn bị dữ liệu...',
    });
    return operation;
  };

  const updateOperationProgress = (operation: ActiveOperation, progress: string) => {
    if (!isCurrentOperation(operation.id)) return;
    setOperationView(prev => prev?.id === operation.id ? { ...prev, progress } : prev);
  };

  const operationOptions = (operation: ActiveOperation, prefix = ''): AIOperationOptions => ({
    signal: operation.controller.signal,
    deadlineAt: operation.deadlineAt,
    providerId: operation.providerId,
    apiTier: operation.apiTier,
    attemptTimeoutMs: 60_000,
    maxAttempts: 2,
    onProgress: (message) => updateOperationProgress(operation, prefix ? `${prefix} • ${message}` : message),
  });

  const finishOperation = (operation: ActiveOperation, unfinishedMessage: string) => {
    if (!isCurrentOperation(operation.id)) return;
    clearTimeout(operation.timer);
    activeOperationRef.current = null;
    settleTransientProjects(unfinishedMessage);
    setLoading(false);
    setContextLoading(false);
    setStyleLoading(false);
    setOperationView(null);
  };

  const requireApiKey = () => {
    const providerId = safeGetItem('app1_ai_provider') || (AI_PROVIDERS.gemini ? 'gemini' : Object.keys(AI_PROVIDERS)[0]) || 'gemini';
    const providerConfig = AI_PROVIDERS[providerId] || AI_PROVIDERS[Object.keys(AI_PROVIDERS)[0]];
    if (!providerConfig) {
      alert('⚠️ CẢNH BÁO: Không tìm thấy cấu hình AI hợp lệ. Vui lòng chọn lại model.');
      return false;
    }
    const keys = readStoredJSON<unknown[]>(`app1_${providerConfig.keyPrefix}_api_keys`, []);
    if (keys.length === 0) {
      alert(`⚠️ CẢNH BÁO: Vui lòng nhập ít nhất 1 ${providerConfig.name} API Key ở ô góc trên bên phải thanh Menu trước khi bắt đầu!`);
      return false;
    }
    return true;
  };

  const handleExtractContext = async (textToExtract: string) => {
    if (!requireApiKey() || !textToExtract.trim()) return;
    const operation = beginOperation('context', 'Trích xuất nhân vật và bối cảnh');
    if (!operation) return;
    setContextLoading(true);
    try {
      const { context, characters: chars } = await extractContextAndCharacters(textToExtract, operationOptions(operation));
      if (!isCurrentOperation(operation.id)) return;
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
      if (!isCurrentOperation(operation.id)) return;
      setProjects(chunks.map((content, i) => ({ id: (Date.now() + i).toString(), name: `Phân đoạn ${i + 1}`, content, scenes: [], promptItems: [], sceneStatus: 'idle', promptStatus: 'idle' })));
    } catch (error: unknown) {
      if (isCurrentOperation(operation.id)) alert(readableError(error));
    } finally {
      finishOperation(operation, 'Tác vụ trích xuất đã kết thúc trước khi hoàn tất. Dữ liệu nháp vẫn được giữ lại.');
    }
  };

  const handleAnalyzeStyle = async (base64: string, mimeType: string) => {
    if (!requireApiKey()) return;
    const operation = beginOperation('style', 'Phân tích phong cách ảnh');
    if (!operation) return;
    setStyleLoading(true);
    try {
      const result = await analyzeImageStyle(base64, mimeType, operationOptions(operation));
      if (!isCurrentOperation(operation.id)) return;
      setStyleAnalysis(result.analysis); setStyleSummary(result.summary);
    } catch (error: unknown) {
      if (isCurrentOperation(operation.id)) alert(`❌ LỖI PHÂN TÍCH ẢNH:\n${readableError(error)}`);
    } finally {
      finishOperation(operation, 'Tác vụ phân tích ảnh đã kết thúc trước khi hoàn tất.');
    }
  };

  const runAnalyzeOperation = async (targets: ScriptProject[], title: string, navigateToReview: boolean) => {
    if (!requireApiKey() || targets.length === 0) return;
    const operation = beginOperation('analyze', title);
    if (!operation) return;
    const targetIds = new Set(targets.map(project => project.id));
    setLoading(true);
    if (navigateToReview) setAppState(AppState.SCENE_REVIEW);
    // Keep existing scenes/prompts until replacement succeeds so cancel/error never destroys prior work.
    setProjects(prev => prev.map(project => targetIds.has(project.id)
      ? { ...project, sceneStatus: 'loading', sceneErrorMessage: undefined }
      : project));

    let completed = 0;
    const analyzeProject = async (project: ScriptProject, index: number) => {
      updateOperationProgress(operation, `Phân đoạn ${index + 1}/${targets.length} • ${project.name}`);
      try {
        const scenes = await analyzeSingleSegmentToScenes(
          { id: project.id, content: project.content },
          globalContext,
          promptOptions,
          characters,
          operationOptions(operation, project.name)
        );
        if (!isCurrentOperation(operation.id)) return;
        setProjects(prev => {
          const updatedProjects = prev.map(item => item.id === project.id ? {
            ...item,
            scenes,
            sceneStatus: 'success' as const,
            sceneErrorMessage: undefined,
            promptItems: [],
            promptStatus: 'idle' as const,
            promptErrorMessage: undefined,
          } : item);
          let counter = 1;
          return updatedProjects.map(item => item.scenes.length > 0
            ? { ...item, scenes: item.scenes.map(scene => ({ ...scene, id: counter++ })) }
            : item);
        });
      } catch (error: unknown) {
        if (isCurrentOperation(operation.id)) {
          setProjects(prev => prev.map(item => item.id === project.id
            ? { ...item, sceneStatus: 'error', sceneErrorMessage: readableError(error) }
            : item));
        }
        throw error;
      } finally {
        completed += 1;
        updateOperationProgress(operation, `Đã xử lý ${completed}/${targets.length} phân đoạn`);
      }
    };

    try {
      if (operation.apiTier === 'free') {
        for (let index = 0; index < targets.length; index++) {
          if (!isCurrentOperation(operation.id)) break;
          try {
            await analyzeProject(targets[index], index);
          } catch {
            break;
          }
        }
      } else {
        await Promise.allSettled(targets.map((project, index) => analyzeProject(project, index)));
      }
    } catch (error: unknown) {
      if (isCurrentOperation(operation.id)) updateOperationProgress(operation, readableError(error));
    } finally {
      finishOperation(operation, 'Phân đoạn chưa được xử lý vì tác vụ đã kết thúc sớm. Hãy bấm Thử lại; dữ liệu cũ vẫn được giữ nguyên.');
    }
  };

  const handleAnalyze = async () => {
    const activeProjects = projects.filter(project => project.content.trim());
    await runAnalyzeOperation(activeProjects, 'Phân tích và chia cảnh 8 giây', true);
  };

  const handleRetryAnalyze = async (projectId: string) => {
    const project = projects.find(item => item.id === projectId);
    if (!project) return;
    await runAnalyzeOperation([project], `Thử lại chia cảnh • ${project.name}`, false);
  };

  const handleRepairScenes = async (projectId: string) => {
    if (!requireApiKey()) return;
    const project = projects.find(p => p.id === projectId);
    if (!project || !project.scenes) return;
    const failedScenes = project.scenes.filter(s => s.visualDescription === "");
    if (failedScenes.length === 0) return;
    const operation = beginOperation('repair', `Vá cảnh lỗi • ${project.name}`);
    if (!operation) return;

    setProjects(prev => prev.map(p => {
      if (p.id !== projectId) return p;
      return {
        ...p,
        scenes: p.scenes.map(s => failedScenes.some(fs => fs.id === s.id) ? { ...s, isRepairing: true } : s),
      };
    }));

    try {
      const repairedScenes = await repairFailedScenes(
        failedScenes,
        globalContext,
        promptOptions,
        characters,
        operationOptions(operation, project.name)
      );
      if (!isCurrentOperation(operation.id)) return;
      setProjects(prev => prev.map(p => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          scenes: p.scenes.map(scene => {
            const repaired = repairedScenes.find(item => item.id === scene.id);
            return repaired ? { ...repaired, isRepairing: false } : { ...scene, isRepairing: false };
          }),
        };
      }));
    } catch (error: unknown) {
      if (isCurrentOperation(operation.id)) alert(`Lỗi khi vá cảnh: ${readableError(error)}`);
    } finally {
      if (isCurrentOperation(operation.id)) {
        setProjects(prev => prev.map(p => {
          if (p.id !== projectId) return p;
          return { ...p, scenes: p.scenes.map(scene => ({ ...scene, isRepairing: false })) };
        }));
      }
      finishOperation(operation, 'Tác vụ vá cảnh đã kết thúc trước khi hoàn tất. Các cảnh cũ vẫn được giữ lại.');
    }
  };

  const runPromptOperation = async (targets: ScriptProject[], title: string, navigateToResult: boolean) => {
    if (!requireApiKey() || targets.length === 0) return;
    const operation = beginOperation('prompt', title);
    if (!operation) return;
    const targetIds = new Set(targets.map(project => project.id));
    setLoading(true);
    if (navigateToResult) setAppState(AppState.RESULT);
    // Keep prior promptItems until a complete replacement arrives.
    setProjects(prev => prev.map(project => targetIds.has(project.id) ? {
      ...project,
      promptStatus: 'loading',
      promptErrorMessage: undefined,
      loadingMessage: operation.apiTier === 'free' ? 'Đang xếp hàng chờ đến lượt...' : 'Đang chuẩn bị tạo prompt...',
      rescueProvider: undefined,
    } : project));

    let completed = 0;
    const generateProject = async (project: ScriptProject, index: number) => {
      const setProjectProgress = (message: string) => {
        if (!isCurrentOperation(operation.id)) return;
        setProjects(prev => prev.map(item => item.id === project.id ? { ...item, loadingMessage: message } : item));
        updateOperationProgress(operation, `Phân đoạn ${index + 1}/${targets.length} • ${project.name} • ${message}`);
      };
      setProjectProgress('Đang viết Prompt tối ưu...');
      try {
        const result = await generatePromptsForSingleSegment(
          { id: project.id, scenes: project.scenes },
          globalContext,
          colorStyle,
          styleAnalysis,
          styleSummary,
          characters,
          setProjectProgress,
          customPromptSuffix,
          promptOptions,
          operationOptions(operation, project.name)
        );
        if (!isCurrentOperation(operation.id)) return;
        setProjects(prev => prev.map(item => item.id === project.id ? {
          ...item,
          promptItems: result.items,
          rescueProvider: result.rescueProvider,
          promptStatus: 'success',
          promptErrorMessage: undefined,
          loadingMessage: undefined,
        } : item));
      } catch (error: unknown) {
        if (isCurrentOperation(operation.id)) {
          setProjects(prev => prev.map(item => item.id === project.id ? {
            ...item,
            promptStatus: 'error',
            promptErrorMessage: readableError(error),
            loadingMessage: undefined,
          } : item));
        }
        throw error;
      } finally {
        completed += 1;
        updateOperationProgress(operation, `Đã xử lý ${completed}/${targets.length} phân đoạn`);
      }
    };

    try {
      if (operation.apiTier === 'free') {
        for (let index = 0; index < targets.length; index++) {
          if (!isCurrentOperation(operation.id)) break;
          try {
            await generateProject(targets[index], index);
          } catch {
            break;
          }
        }
      } else {
        await Promise.allSettled(targets.map((project, index) => generateProject(project, index)));
      }
    } catch (error: unknown) {
      if (isCurrentOperation(operation.id)) updateOperationProgress(operation, readableError(error));
    } finally {
      finishOperation(operation, 'Prompt chưa được xử lý vì tác vụ đã kết thúc sớm. Hãy bấm Thử lại; prompt cũ vẫn được giữ nguyên.');
    }
  };

  const handleGeneratePrompts = async () => {
    const activeProjects = projects.filter(project => project.scenes.length > 0);
    await runPromptOperation(activeProjects, 'Tạo Prompt Veo 3', true);
  };

  const handleRetryPrompt = async (projectId: string) => {
    const project = projects.find(item => item.id === projectId);
    if (!project || project.scenes.length === 0) return;
    await runPromptOperation([project], `Thử lại Prompt • ${project.name}`, false);
  };

  const resetApp = () => {
    if (activeOperationRef.current) {
      alert('Hãy hủy hoặc chờ tác vụ hiện tại hoàn tất trước khi làm mới dự án.');
      return;
    }
    if (window.confirm("Làm mới dự án? Màn hình này sẽ được xóa sạch để làm kịch bản mới.")) {
        const provider = localStorage.getItem('app1_ai_provider');
        const apiTier = localStorage.getItem('app1_api_tier');

        const customProviders = localStorage.getItem('app1_custom_providers');

        // 👉 GIỮ LẠI MÃ KÍCH HOẠT khi "Xóa Trắng" — đã nhập mã rồi thì không bao giờ
        // bắt nhập lại (trừ khi chuyển máy). Xoá mã sẽ khiến app thoát ra đòi mã.
        const license = localStorage.getItem('app1_license');
        // 👉 Giữ luôn cài đặt thành tố prompt + trần độ dài (cài đặt của người dùng, không phải bản nháp).
        const promptElements = localStorage.getItem('app1_prompt_elements');
        const maxPromptChars = localStorage.getItem('app1_prompt_max_chars');

        const keysToSave: Record<string, string | null> = {};
        Object.keys(AI_PROVIDERS).forEach(key => {
            const storageKey = `app1_${AI_PROVIDERS[key].keyPrefix}_api_keys`;
            keysToSave[storageKey] = localStorage.getItem(storageKey);
        });

        localStorage.clear();

        // 👉 KHÔI PHỤC MÃ KÍCH HOẠT TRƯỚC TIÊN — nếu một setItem phía sau lỗi (bộ nhớ đầy...)
        // thì mã vẫn đã được ghi lại, không bao giờ mất.
        if(license) localStorage.setItem('app1_license', license);

        if(provider) localStorage.setItem('app1_ai_provider', provider);
        if(apiTier) localStorage.setItem('app1_api_tier', apiTier);

        if(customProviders) localStorage.setItem('app1_custom_providers', customProviders);
        if(promptElements) localStorage.setItem('app1_prompt_elements', promptElements);
        if(maxPromptChars) localStorage.setItem('app1_prompt_max_chars', maxPromptChars);

        Object.entries(keysToSave).forEach(([k, v]) => { if (v) localStorage.setItem(k, v); });

        setAppState(AppState.INPUT); setRawScript(''); setGlobalContext(''); setStyleAnalysis(''); setStyleSummary(''); setCharacters([]); setColorStyle('default'); setImagePreview(null);
        setCustomPromptSuffix('');
        // 👉 Cập nhật reset kèm audioMode
        setPromptOptions({ splitLogic: 'default', audioMode: 'remove' });
        setProjects([{ ...createDefaultProject(), id: Date.now().toString() }]);
    }
  };

  const formatDuration = (totalSeconds: number) => {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-200">
      <Header />

      {operationView && (
        <aside
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-[100] w-[min(92vw,420px)] rounded-2xl border border-indigo-500/40 bg-slate-950/95 p-5 shadow-2xl shadow-indigo-950/60 backdrop-blur-xl"
        >
          <div className="flex items-start gap-4">
            <div className="mt-0.5 h-9 w-9 shrink-0 animate-spin rounded-full border-2 border-indigo-400/25 border-t-indigo-400" />
            <div className="min-w-0 flex-1">
              <h2 className="font-bold text-white">{operationView.title}</h2>
              <p className="mt-1 break-words text-sm text-indigo-300">{operationView.progress}</p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-medium text-slate-400">
                <span>{operationView.providerName}</span>
                <span>{operationView.apiTier === 'paid' ? 'Gói trả phí' : 'Gói miễn phí'}</span>
                <span>Đã chạy {formatDuration((operationClock - operationView.startedAt) / 1000)}</span>
                <span>Còn tối đa {formatDuration((operationView.deadlineAt - operationClock) / 1000)}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => stopActiveOperation(operationView.id, false)}
            className="mt-4 w-full rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-300 transition-colors hover:bg-red-500 hover:text-white"
          >
            Hủy tác vụ và giữ dữ liệu đã hoàn thành
          </button>
        </aside>
      )}

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
