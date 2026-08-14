import React, { useState, useEffect, useRef } from 'react';
import ScriptInput from './components/ScriptInput';
import SceneList from './components/SceneList';
import PromptOutput from './components/PromptOutput';
import Header from './components/Header';
import { AppState, ScriptProject, ColorStyle, CharacterIdentity, SpeedMode } from './types';
import { analyzeSingleSegmentToScenes, generatePromptsForSingleSegment, extractContextAndCharacters, analyzeImageStyle, AI_PROVIDERS, repairFailedScenes, PromptOptions, AIOperationOptions, AIDiagnostic } from './services/geminiService';
import { createDefaultProject, hydrateProjectsWithReport, serializeProjects } from './state/projectPersistence';
import { splitRawScriptIntoSegments } from './state/scriptSegmentation';
import { AbortableFIFOLimiter, runWithWorkerPool } from './services/aiRuntime';
import { resolveThinkingPolicy } from './services/aiReasoningPolicy';

type OperationKind = 'context' | 'style' | 'analyze' | 'prompt' | 'repair';

interface ActiveOperation {
  id: string;
  kind: OperationKind;
  title: string;
  providerId: string;
  providerName: string;
  speedMode: SpeedMode;
  keySlot?: number;
  ultraDowngraded: boolean;
  requestLimiter: AbortableFIFOLimiter;
  effectiveConcurrency: number;
  activeRequests: number;
  completedProjects: number;
  totalProjects: number;
  startedAt: number;
  deadlineAt: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  diagnostic?: AIDiagnostic;
  diagnostics: Record<string, AIDiagnostic>;
}

interface OperationView {
  id: string;
  title: string;
  providerName: string;
  kind: OperationKind;
  speedMode: SpeedMode;
  effectiveConcurrency: number;
  activeRequests: number;
  completedProjects: number;
  totalProjects: number;
  startedAt: number;
  deadlineAt: number;
  progress: string;
  diagnostic?: AIDiagnostic;
  diagnostics: Record<string, AIDiagnostic>;
}

type ContextExtractionFeedback = {
  tone: 'success' | 'error';
  message: string;
};

const OPERATION_DEADLINES: Record<OperationKind, number> = {
  context: 5 * 60_000,
  style: 4 * 60_000,
  analyze: 8 * 60_000,
  prompt: 12 * 60_000,
  repair: 5 * 60_000,
};
const MAX_OPERATION_DEADLINE_MS = 60 * 60_000;

const diagnosticPhaseLabel: Record<AIDiagnostic['phase'], string> = {
  queued: 'Đang chờ hàng đợi',
  connecting: 'Đang kết nối API',
  waiting_headers: 'Đang chờ phản hồi máy chủ',
  reading_body: 'Đang nhận dữ liệu phản hồi',
  parsing: 'Đang đọc JSON phản hồi',
  validating: 'Đang kiểm tra kết quả',
  retry_backoff: 'Đang chờ thử lại',
  completed: 'Đã hoàn tất request',
  failed: 'Request thất bại',
};

const diagnosticHasOpenRequest = (diagnostic?: AIDiagnostic): boolean =>
  diagnostic?.phase === 'connecting'
  || diagnostic?.phase === 'waiting_headers'
  || diagnostic?.phase === 'reading_body'
  || diagnostic?.phase === 'parsing'
  || diagnostic?.phase === 'validating';

const latestDiagnostics = (diagnostics: Record<string, AIDiagnostic>, limit = 6): AIDiagnostic[] =>
  Object.values(diagnostics)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit);

const openDiagnosticCount = (diagnostics: Record<string, AIDiagnostic>): number =>
  Object.values(diagnostics).filter(diagnosticHasOpenRequest).length;

const estimateWorkflowDeadline = (kind: 'analyze' | 'prompt', targets: ScriptProject[]): number => {
  const estimatedBatches = kind === 'analyze'
    ? targets.reduce((total, project) => total + Math.max(1, Math.ceil(project.content.length / 1_200)), 0)
    : targets.reduce((total, project) => total + Math.max(1, Math.ceil(project.scenes.length / 10) + 1), 0);
  return Math.min(
    MAX_OPERATION_DEADLINE_MS,
    Math.max(OPERATION_DEADLINES[kind], 120_000 + estimatedBatches * 120_000),
  );
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

const safeRemoveItem = (key: string): void => {
  try { localStorage.removeItem(key); } catch { /* storage is unavailable */ }
};

const readStoredJSON = <T,>(key: string, fallback: T): T => {
  const raw = safeGetItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

const readSpeedMode = (): SpeedMode => {
  const mode = safeGetItem('app1_speed_mode');
  return mode === 'ultra-max' || mode === 'ultra' ? mode : 'fast';
};

const initialConcurrency = (mode: SpeedMode, kind: OperationKind): number => {
  if (kind !== 'analyze' && kind !== 'prompt') return 1;
  if (mode === 'ultra-max') return 4;
  return mode === 'ultra' ? 2 : 1;
};

const workerConcurrency = (mode: SpeedMode): number => mode === 'ultra-max' ? 4 : mode === 'ultra' ? 2 : 1;

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(() => (safeGetItem('app1_appState') as AppState) || AppState.INPUT);

  const [loading, setLoading] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextExtractionFeedback, setContextExtractionFeedback] = useState<ContextExtractionFeedback | null>(null);
  const [styleLoading, setStyleLoading] = useState(false);
  const activeOperationRef = useRef<ActiveOperation | null>(null);
  const [operationView, setOperationView] = useState<OperationView | null>(null);
  const [lastFailedDiagnostic, setLastFailedDiagnostic] = useState<AIDiagnostic | null>(null);
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
    // Previous versions exposed a free/paid toggle. The runtime now uses one
    // conservative policy for every API, so the obsolete preference is removed.
    safeRemoveItem('app1_api_tier');
  }, []);

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

  const beginOperation = (kind: OperationKind, title: string, deadlineMs = OPERATION_DEADLINES[kind]): ActiveOperation | null => {
    if (activeOperationRef.current) {
      alert('Một tác vụ khác đang chạy. Hãy chờ hoàn tất hoặc bấm Hủy tác vụ trước.');
      return null;
    }
    setLastFailedDiagnostic(null);
    const selectedProviderId = safeGetItem('app1_ai_provider') || (AI_PROVIDERS.gemini ? 'gemini' : Object.keys(AI_PROVIDERS)[0]) || 'gemini';
    const provider = AI_PROVIDERS[selectedProviderId] || AI_PROVIDERS[Object.keys(AI_PROVIDERS)[0]];
    if (provider) {
      const thinkingPolicy = resolveThinkingPolicy(provider);
      if (!thinkingPolicy.canRun) {
        alert(`Không thể chạy ${provider.name}: ${thinkingPolicy.message} Hãy mở Quản lý Key và kiểm tra cấu hình tắt thinking.`);
        return null;
      }
    }
    const providerId = provider?.id || selectedProviderId;
    const speedMode = readSpeedMode();
    const availableKeys = provider ? readStoredJSON<string[]>(`app1_${provider.keyPrefix}_api_keys`, []).filter(key => typeof key === 'string' && key.trim()) : [];
    const startedAt = Date.now();
    const effectiveDeadlineMs = Math.min(MAX_OPERATION_DEADLINE_MS, Math.max(OPERATION_DEADLINES[kind], deadlineMs));
    const deadlineAt = startedAt + effectiveDeadlineMs;
    const id = globalThis.crypto?.randomUUID?.() || `${startedAt}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => stopActiveOperation(id, true), effectiveDeadlineMs);
    const operation: ActiveOperation = {
      id,
      kind,
      title,
      providerId,
      providerName: provider?.name || 'AI',
      speedMode,
      keySlot: speedMode !== 'fast' && availableKeys.length > 0 ? 0 : undefined,
      ultraDowngraded: false,
      requestLimiter: new AbortableFIFOLimiter(initialConcurrency(speedMode, kind)),
      effectiveConcurrency: initialConcurrency(speedMode, kind),
      activeRequests: 0,
      completedProjects: 0,
      totalProjects: 0,
      startedAt,
      deadlineAt,
      controller,
      timer,
      diagnostics: {},
    };
    activeOperationRef.current = operation;
    setOperationView({
      id,
      title,
      providerName: operation.providerName,
      kind,
      speedMode,
      effectiveConcurrency: operation.effectiveConcurrency,
      activeRequests: 0,
      completedProjects: 0,
      totalProjects: 0,
      startedAt,
      deadlineAt,
      progress: 'Đang chuẩn bị dữ liệu...',
      diagnostics: {},
    });
    return operation;
  };

  const updateOperationProgress = (operation: ActiveOperation, progress: string) => {
    if (!isCurrentOperation(operation.id)) return;
    setOperationView(prev => prev?.id === operation.id ? { ...prev, progress } : prev);
  };

  const setOperationTotal = (operation: ActiveOperation, totalProjects: number) => {
    operation.totalProjects = totalProjects;
    setOperationView(prev => prev?.id === operation.id ? { ...prev, totalProjects } : prev);
  };

  const markOperationProjectComplete = (operation: ActiveOperation) => {
    operation.completedProjects = Math.min(operation.totalProjects, operation.completedProjects + 1);
    setOperationView(prev => prev?.id === operation.id ? { ...prev, completedProjects: operation.completedProjects } : prev);
  };

  const operationOptions = (
    operation: ActiveOperation,
    prefix = '',
    partial: Pick<AIOperationOptions, 'onPartialScenes' | 'onPartialPrompts'> = {},
  ): AIOperationOptions => ({
    signal: operation.controller.signal,
    deadlineAt: operation.deadlineAt,
    providerId: operation.providerId,
    speedMode: operation.speedMode,
    keySlot: operation.keySlot,
    requestLimiter: operation.requestLimiter,
    attemptTimeoutMs: operation.speedMode === 'ultra-max'
      ? 180_000
      : operation.speedMode === 'ultra'
        ? 120_000
        : undefined,
    maxAttempts: 2,
    onProgress: (message) => updateOperationProgress(operation, prefix ? `${prefix} • ${message}` : message),
    onConcurrencyDowngrade: (reason) => {
      if (operation.speedMode === 'fast' || operation.effectiveConcurrency <= 1) return;
      operation.ultraDowngraded = true;
      operation.effectiveConcurrency = operation.effectiveConcurrency > 2 ? 2 : 1;
      operation.requestLimiter.setCapacity(operation.effectiveConcurrency);
      setOperationView(prev => prev?.id === operation.id ? { ...prev, effectiveConcurrency: operation.effectiveConcurrency } : prev);
      const nextMode = operation.effectiveConcurrency === 1 ? 'Fast' : 'Ultra';
      updateOperationProgress(operation, `${operation.speedMode === 'ultra-max' ? 'Ultra Max' : 'Ultra'} tạm chuyển về ${nextMode} vì API báo ${reason}.`);
    },
    onRequestActivity: (delta) => {
      operation.activeRequests = Math.max(0, operation.activeRequests + delta);
      setOperationView(prev => prev?.id === operation.id ? { ...prev, activeRequests: operation.activeRequests } : prev);
    },
    onDiagnostic: (diagnostic) => {
      if (!isCurrentOperation(operation.id)) return;
      operation.diagnostic = diagnostic;
      operation.diagnostics = {
        ...operation.diagnostics,
        [diagnostic.requestId]: diagnostic,
      };
      const retainedDiagnostics = latestDiagnostics(operation.diagnostics, 8);
      operation.diagnostics = Object.fromEntries(retainedDiagnostics.map(item => [item.requestId, item]));
      if (diagnostic.phase === 'failed') setLastFailedDiagnostic(diagnostic);
      setOperationView(prev => prev?.id === operation.id
        ? { ...prev, diagnostic, diagnostics: operation.diagnostics }
        : prev);
    },
    ...partial,
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
    setContextExtractionFeedback(null);
    try {
      const scriptSnapshot = textToExtract.trim();
      updateOperationProgress(operation, 'Đang gửi toàn bộ kịch bản để trích xuất bối cảnh và nhân vật...');
      const extraction = await extractContextAndCharacters(scriptSnapshot, operationOptions(operation));
      if (!isCurrentOperation(operation.id)) return;

      updateOperationProgress(operation, 'Đã trích xuất xong. Đang chia phân đoạn...');
      const segments = splitRawScriptIntoSegments(scriptSnapshot);
      if (segments.length === 0) throw new Error('Không thể chia kịch bản thành phân đoạn. [SEGMENTATION_EMPTY]');

      const hasGeneratedWork = projects.some(project => project.scenes.length > 0 || project.promptItems.length > 0);
      setGlobalContext(extraction.context);
      setCharacters(extraction.characters);
      if (hasGeneratedWork) {
        setContextExtractionFeedback({
          tone: 'success',
          message: `Đã trích xuất bối cảnh và ${extraction.characters.length} nhân vật. Giữ các phân đoạn cũ vì chúng đã có cảnh hoặc prompt.`,
        });
        return;
      }

      setProjects(segments.map((content, index) => ({
        id: `${operation.id}-${index}`,
        name: `Phân đoạn ${index + 1}`,
        content,
        scenes: [],
        promptItems: [],
        sceneStatus: 'idle' as const,
        promptStatus: 'idle' as const,
      })));
      setContextExtractionFeedback({
        tone: 'success',
        message: `Đã trích xuất bối cảnh và ${extraction.characters.length} nhân vật • Đã chia ${segments.length} phân đoạn`,
      });
      return;

    } catch (error: unknown) {
      if (isCurrentOperation(operation.id)) {
        setContextExtractionFeedback({
          tone: 'error',
          message: `Trích xuất bối cảnh và nhân vật thất bại: ${readableError(error)}`,
        });
      }
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
    const operation = beginOperation('analyze', title, estimateWorkflowDeadline('analyze', targets));
    if (!operation) return;
    setOperationTotal(operation, targets.length);
    const targetIds = new Set(targets.map(project => project.id));
    setLoading(true);
    if (navigateToReview) setAppState(AppState.SCENE_REVIEW);
    // Keep existing scenes/prompts until replacement succeeds so cancel/error never destroys prior work.
    setProjects(prev => prev.map(project => targetIds.has(project.id)
      ? { ...project, sceneStatus: 'loading', sceneErrorMessage: undefined, repairMessage: undefined }
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
          operationOptions(operation, project.name, {
            onPartialScenes: (partialScenes) => {
              if (!isCurrentOperation(operation.id)) return;
              setProjects(prev => prev.map(item => item.id === project.id ? {
                ...item,
                scenes: partialScenes,
                sceneStatus: 'loading' as const,
                promptItems: [],
                promptStatus: 'idle' as const,
              } : item));
            },
          })
        );
        if (!isCurrentOperation(operation.id)) return;
        setProjects(prev => prev.map(item => item.id === project.id ? {
          ...item,
          scenes,
          sceneStatus: 'success' as const,
          sceneErrorMessage: undefined,
          repairMessage: undefined,
          promptItems: [],
          promptStatus: 'idle' as const,
          promptErrorMessage: undefined,
        } : item));
      } catch (error: unknown) {
        if (isCurrentOperation(operation.id)) {
          setProjects(prev => prev.map(item => item.id === project.id
            ? { ...item, sceneStatus: 'error', sceneErrorMessage: readableError(error) }
            : item));
        }
        throw error;
      } finally {
        completed += 1;
        markOperationProjectComplete(operation);
        updateOperationProgress(operation, `Đã xử lý ${completed}/${targets.length} phân đoạn`);
      }
    };

    try {
      await runWithWorkerPool(
        targets,
        workerConcurrency(operation.speedMode),
        async (project, index) => {
          try { await analyzeProject(project, index); } catch { /* retain partial result and continue */ }
        },
        {
          shouldStop: () => !isCurrentOperation(operation.id),
          shouldReduceToSingleWorker: () => operation.effectiveConcurrency === 1,
        },
      );
      if (isCurrentOperation(operation.id)) {
        setProjects(prev => {
          let counter = 1;
          return prev.map(project => project.scenes.length > 0
            ? { ...project, scenes: project.scenes.map(scene => ({ ...scene, id: counter++ })) }
            : project);
        });
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
      const repairResult = await repairFailedScenes(
        failedScenes,
        globalContext,
        promptOptions,
        characters,
        operationOptions(operation, project.name, {
          onPartialScenes: (repairedScenes) => {
            if (!isCurrentOperation(operation.id)) return;
            const repairedById = new Map(repairedScenes.map(scene => [scene.id, scene]));
            setProjects(prev => prev.map(item => item.id === projectId ? {
              ...item,
              scenes: item.scenes.map(scene => repairedById.has(scene.id)
                ? { ...repairedById.get(scene.id)!, isRepairing: false }
                : scene),
              repairMessage: `Đã vá ${repairedById.size}/${failedScenes.length} cảnh; đang xử lý phần còn lại...`,
            } : item));
          },
        })
      );
      if (!isCurrentOperation(operation.id)) return;
      const repairedById = new Map(repairResult.repairedScenes.map(scene => [scene.id, scene]));
      const failedCount = repairResult.failedSceneIds.length;
      setProjects(prev => prev.map(p => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          scenes: p.scenes.map(scene => {
            const repaired = repairedById.get(scene.id);
            return repaired ? { ...repaired, isRepairing: false } : { ...scene, isRepairing: false };
          }),
          repairMessage: failedCount === 0
            ? `Đã vá thành công ${repairResult.repairedScenes.length}/${failedScenes.length} cảnh.`
            : `Đã vá ${repairResult.repairedScenes.length}/${failedScenes.length} cảnh; còn ${failedCount} cảnh cần thử lại.${repairResult.errors[0] ? ` ${readableError(repairResult.errors[0])}` : ''}`,
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
    const operation = beginOperation('prompt', title, estimateWorkflowDeadline('prompt', targets));
    if (!operation) return;
    setOperationTotal(operation, targets.length);
    const targetIds = new Set(targets.map(project => project.id));
    setLoading(true);
    if (navigateToResult) setAppState(AppState.RESULT);
    // Keep prior promptItems until a complete replacement arrives.
    setProjects(prev => prev.map(project => targetIds.has(project.id) ? {
      ...project,
      promptStatus: 'loading',
      promptErrorMessage: undefined,
      loadingMessage: 'Đang chuẩn bị tạo prompt...',
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
          operationOptions(operation, project.name, {
            onPartialPrompts: (partialItems) => {
              if (!isCurrentOperation(operation.id)) return;
              setProjects(prev => prev.map(item => item.id === project.id ? {
                ...item,
                promptItems: partialItems,
                promptStatus: 'loading' as const,
                loadingMessage: 'Đã lưu prompt theo từng mẻ...',
              } : item));
            },
          })
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
        markOperationProjectComplete(operation);
        updateOperationProgress(operation, `Đã xử lý ${completed}/${targets.length} phân đoạn`);
      }
    };

    try {
      await runWithWorkerPool(
        targets,
        workerConcurrency(operation.speedMode),
        async (project, index) => {
          try { await generateProject(project, index); } catch { /* completed projects remain available */ }
        },
        {
          shouldStop: () => !isCurrentOperation(operation.id),
          shouldReduceToSingleWorker: () => operation.effectiveConcurrency === 1,
        },
      );
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
        const customProviders = localStorage.getItem('app1_custom_providers');
        // Chế độ tốc độ là cài đặt trình duyệt, độc lập với dữ liệu dự án.
        // Xóa trắng chỉ xóa kịch bản hiện tại, không được làm người dùng mất lựa chọn này.
        const speedMode = localStorage.getItem('app1_speed_mode');

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
        if(customProviders) localStorage.setItem('app1_custom_providers', customProviders);
        if(speedMode) localStorage.setItem('app1_speed_mode', speedMode);
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

  const copyDiagnostic = async (diagnostic: AIDiagnostic) => {
    const payload = {
      requestId: diagnostic.requestId,
      phase: diagnostic.phase,
      provider: diagnostic.providerName,
      model: diagnostic.model,
      endpoint: diagnostic.endpoint,
      attempt: diagnostic.attempt && diagnostic.maxAttempts ? `${diagnostic.attempt}/${diagnostic.maxAttempts}` : undefined,
      status: diagnostic.status,
      contentType: diagnostic.contentType,
      responseBytes: diagnostic.responseBytes,
      chunkCount: diagnostic.chunkCount,
      firstByteMs: diagnostic.firstByteMs,
      bodyMs: diagnostic.bodyMs,
      lastChunkMs: diagnostic.lastChunkMs,
      compatibilityFallback: diagnostic.compatibilityFallback,
      thinkingProfile: diagnostic.thinkingProfile,
      thinkingStatus: diagnostic.thinkingStatus,
      finishReason: diagnostic.finishReason,
      reasoningTokens: diagnostic.reasoningTokens,
      outputTokens: diagnostic.outputTokens,
      receivedItems: diagnostic.receivedItems,
      errorCode: diagnostic.errorCode,
      errorMessage: diagnostic.errorMessage,
      responsePreview: diagnostic.responsePreview,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      alert('Đã sao chép chẩn đoán đã che thông tin nhạy cảm.');
    } catch {
      alert('Không thể sao chép tự động. Hãy thử lại trong trình duyệt có quyền clipboard.');
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-200">
      <Header isOperationActive={operationView !== null} />

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
                <span>{operationView.speedMode === 'ultra-max'
                  ? `Ultra Max${operationView.effectiveConcurrency === 4 ? '' : operationView.effectiveConcurrency === 2 ? ' → Ultra' : ' → Fast'} · ${operationView.kind === 'analyze' || operationView.kind === 'prompt' ? `${operationView.effectiveConcurrency} luồng · 1 API key` : 'bước này chạy đơn'}`
                  : operationView.speedMode === 'ultra'
                    ? `Ultra${operationView.effectiveConcurrency === 1 ? ' → Fast' : ''} · ${operationView.kind === 'analyze' || operationView.kind === 'prompt' ? `${operationView.effectiveConcurrency} luồng · 1 API key` : 'bước này chạy đơn'}`
                    : 'Fast · 1 luồng'}</span>
                <span>{operationView.diagnostic ? diagnosticPhaseLabel[operationView.diagnostic.phase] : `Request AI đang chạy ${operationView.activeRequests}/${operationView.effectiveConcurrency}`}</span>
                <span>Request AI đang mở {Math.max(operationView.activeRequests, openDiagnosticCount(operationView.diagnostics))}/{operationView.effectiveConcurrency}</span>
                {operationView.totalProjects > 0 && <span>Hoàn thành {operationView.completedProjects}/{operationView.totalProjects} phân đoạn</span>}
                <span>Đã chạy {formatDuration((operationClock - operationView.startedAt) / 1000)}</span>
                <span>Giới hạn còn lại {formatDuration((operationView.deadlineAt - operationClock) / 1000)}</span>
              </div>
            </div>
          </div>
          {operationView.diagnostic && (
            <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/80 p-3 text-[11px] text-slate-300">
              <div className="flex items-center justify-between gap-3">
                <span className="font-bold text-slate-100">Chẩn đoán {operationView.diagnostic.requestId.slice(0, 8)}</span>
                <span className={operationView.diagnostic.phase === 'failed' ? 'font-bold text-red-300' : 'text-indigo-300'}>{diagnosticPhaseLabel[operationView.diagnostic.phase]}</span>
              </div>
              <p className="mt-1 break-words text-slate-400">
                {operationView.diagnostic.status ? `HTTP ${operationView.diagnostic.status} · ` : ''}
                {operationView.diagnostic.responseBytes !== undefined ? `${operationView.diagnostic.responseBytes.toLocaleString()} bytes · ` : ''}
                {operationView.diagnostic.bodyMs !== undefined ? `${formatDuration(operationView.diagnostic.bodyMs / 1_000)} body` : 'Đang chờ dữ liệu'}
              </p>
              {operationView.diagnostic.chunkCount !== undefined && (
                <p className="mt-1 text-slate-500">{operationView.diagnostic.chunkCount} chunks{operationView.diagnostic.lastChunkMs !== undefined ? ` · chunk cuối ${formatDuration(operationView.diagnostic.lastChunkMs / 1_000)}` : ''}</p>
              )}
              {operationView.diagnostic.thinkingProfile && (
                <p className="mt-1 text-emerald-300">Thinking: {operationView.diagnostic.thinkingProfile} · {operationView.diagnostic.thinkingStatus || 'unknown'}</p>
              )}
              {operationView.diagnostic.compatibilityFallback && (
                <p className="mt-1 text-amber-300">Đã thử lại bằng chế độ tương thích của API.</p>
              )}
              {operationView.diagnostic.responsePreview && operationView.diagnostic.phase === 'reading_body' && (
                <p className="mt-1 break-words font-mono text-[10px] text-slate-500">Preview: {operationView.diagnostic.responsePreview}</p>
              )}
              {operationView.diagnostic.errorCode && <p className="mt-1 break-words font-medium text-red-300">{operationView.diagnostic.errorCode}: {operationView.diagnostic.errorMessage}</p>}
              <button type="button" onClick={() => void copyDiagnostic(operationView.diagnostic!)} className="mt-2 text-xs font-bold text-indigo-300 hover:text-indigo-100">
                Sao chép chẩn đoán
              </button>
              {latestDiagnostics(operationView.diagnostics).length > 1 && (
                <div className="mt-3 border-t border-slate-700 pt-2 text-[10px] text-slate-400">
                  <p className="font-bold uppercase tracking-wide text-slate-500">Các request gần nhất</p>
                  {latestDiagnostics(operationView.diagnostics, 4).map(item => (
                    <p key={item.requestId} className="mt-1 truncate">
                      {item.requestId.slice(0, 8)} · {diagnosticPhaseLabel[item.phase]}{item.status ? ` · HTTP ${item.status}` : ''}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => stopActiveOperation(operationView.id, false)}
            className="mt-4 w-full rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-300 transition-colors hover:bg-red-500 hover:text-white"
          >
            Hủy tác vụ và giữ dữ liệu đã hoàn thành
          </button>
        </aside>
      )}

      {!operationView && lastFailedDiagnostic && (
        <aside className="fixed bottom-5 right-5 z-[100] w-[min(92vw,420px)] rounded-2xl border border-red-500/40 bg-slate-950/95 p-4 shadow-2xl shadow-red-950/40">
          <p className="font-bold text-red-300">Request AI thất bại: {lastFailedDiagnostic.errorCode || 'REQUEST_FAILED'}</p>
          <p className="mt-1 break-words text-xs text-slate-300">{lastFailedDiagnostic.errorMessage || 'Có thể sao chép chẩn đoán để xác định nguyên nhân.'}</p>
          <button type="button" onClick={() => void copyDiagnostic(lastFailedDiagnostic)} className="mt-3 text-xs font-bold text-indigo-300 hover:text-indigo-100">
            Sao chép chẩn đoán
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
              onExtractContext={handleExtractContext} isExtractingContext={contextLoading} extractionFeedback={contextExtractionFeedback} onAddProject={() => setProjects([...projects, { id: Date.now().toString(), name: `Phân đoạn ${projects.length + 1}`, content: '', scenes: [], promptItems: [], sceneStatus: 'idle', promptStatus: 'idle' }])} onRemoveProject={(id) => setProjects(projects.filter(p => p.id !== id))} onUpdateContent={(id, c) => setProjects(projects.map(p => p.id === id ? { ...p, content: c } : p))} onUpdateName={(id, n) => setProjects(projects.map(p => p.id === id ? { ...p, name: n } : p))} onAnalyze={handleAnalyze} isAnalyzing={loading} styleAnalysis={styleAnalysis} setStyleAnalysis={setStyleAnalysis} styleSummary={styleSummary} setStyleSummary={setStyleSummary} onAnalyzeStyle={handleAnalyzeStyle} isAnalyzingStyle={styleLoading} characters={characters} onUpdateCharacter={(id, f, v) => setCharacters(characters.map(c => c.id === id ? { ...c, [f]: v } : c))} onAddCharacter={() => setCharacters([...characters, { id: `char-${Date.now()}`, name: 'Nhân vật mới', promptName: '', originalName: '', visualDescription: '' }])} onRemoveCharacter={(id) => setCharacters(characters.filter(c => c.id !== id))} onReset={resetApp} imagePreview={imagePreview} setImagePreview={setImagePreview}
              
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
