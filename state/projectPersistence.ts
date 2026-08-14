import type { PromptItem, Scene, ScriptProject, StepStatus } from '../types';

const INTERRUPTED_SCENE_MESSAGE =
  'Tác vụ chia cảnh trước đó đã bị gián đoạn. Hãy thử lại.';
const INTERRUPTED_PROMPT_MESSAGE =
  'Tác vụ tạo prompt trước đó đã bị gián đoạn. Hãy thử lại.';

const STEP_STATUSES: ReadonlySet<StepStatus> = new Set([
  'idle',
  'loading',
  'success',
  'error',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStepStatus = (value: unknown): value is StepStatus =>
  typeof value === 'string' && STEP_STATUSES.has(value as StepStatus);

const normalizeScene = (value: unknown): Scene | null => {
  if (!isRecord(value) || typeof value.id !== 'number' || !Number.isFinite(value.id)) return null;
  return {
    id: value.id,
    sourceText: typeof value.sourceText === 'string' ? value.sourceText : '',
    visualDescription: typeof value.visualDescription === 'string' ? value.visualDescription : '',
    characterDetails: typeof value.characterDetails === 'string' ? value.characterDetails : '',
    settingTime: typeof value.settingTime === 'string' ? value.settingTime : '',
    duration: typeof value.duration === 'string' ? value.duration : '8s',
    isRepairing: false,
  };
};

const normalizePromptItem = (value: unknown): PromptItem | null => {
  if (!isRecord(value) || typeof value.sceneId !== 'number' || !Number.isFinite(value.sceneId)) return null;
  if (typeof value.generatedPrompt !== 'string') return null;
  return {
    sceneId: value.sceneId,
    sourceText: typeof value.sourceText === 'string' ? value.sourceText : undefined,
    originalDescription: typeof value.originalDescription === 'string' ? value.originalDescription : '',
    generatedPrompt: value.generatedPrompt,
  };
};

export const createDefaultProject = (): ScriptProject => ({
  id: '1',
  name: 'Phân đoạn 1',
  content: '',
  scenes: [],
  promptItems: [],
  sceneStatus: 'idle',
  promptStatus: 'idle',
});

const normalizeProject = (value: unknown, index = 0): ScriptProject | null => {
  if (!isRecord(value)) return null;
  if (typeof value.content !== 'string') return null;

  const scenes = Array.isArray(value.scenes)
    ? value.scenes.map(normalizeScene).filter((scene): scene is Scene => scene !== null)
    : [];
  const promptItems = Array.isArray(value.promptItems)
    ? value.promptItems.map(normalizePromptItem).filter((item): item is PromptItem => item !== null)
    : [];
  const hasScenes = scenes.length > 0;
  const hasPrompts = promptItems.length > 0;

  // Support the original one-status storage shape while keeping current data strict.
  const legacyStatus = value.status;
  const storedSceneStatus: StepStatus = isStepStatus(value.sceneStatus)
    ? value.sceneStatus
    : hasScenes
      ? 'success'
      : isStepStatus(legacyStatus)
        ? legacyStatus
        : 'idle';
  const storedPromptStatus: StepStatus = isStepStatus(value.promptStatus)
    ? value.promptStatus
    : hasPrompts
      ? 'success'
      : hasScenes && legacyStatus === 'error'
        ? 'error'
        : 'idle';

  const sceneWasInterrupted = storedSceneStatus === 'loading';
  const promptWasInterrupted = storedPromptStatus === 'loading';

  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id : `recovered-${index + 1}`,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : `Phân đoạn ${index + 1}`,
    content: value.content,
    scenes,
    promptItems,
    sceneStatus: sceneWasInterrupted ? 'error' : storedSceneStatus,
    sceneErrorMessage: sceneWasInterrupted
      ? INTERRUPTED_SCENE_MESSAGE
      : typeof value.sceneErrorMessage === 'string'
        ? value.sceneErrorMessage
        : typeof value.errorMessage === 'string' && !hasScenes
          ? value.errorMessage
          : undefined,
    promptStatus: promptWasInterrupted ? 'error' : storedPromptStatus,
    promptErrorMessage: promptWasInterrupted
      ? INTERRUPTED_PROMPT_MESSAGE
      : typeof value.promptErrorMessage === 'string'
        ? value.promptErrorMessage
        : typeof value.errorMessage === 'string' && hasScenes
          ? value.errorMessage
          : undefined,
    loadingMessage: undefined,
    rescueProvider: typeof value.rescueProvider === 'string' ? value.rescueProvider : undefined,
  };
};

const normalizeProjects = (value: unknown): ScriptProject[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const projects = value
    .map((project, index) => normalizeProject(project, index))
    .filter((project): project is ScriptProject => project !== null);
  return projects.length > 0 ? projects : null;
};

export interface ProjectHydrationResult {
  projects: ScriptProject[];
  hadCorruption: boolean;
}

export const hydrateProjectsWithReport = (raw: string | null): ProjectHydrationResult => {
  if (!raw) return { projects: [createDefaultProject()], hadCorruption: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    const projects = normalizeProjects(parsed);
    const sourceCount = Array.isArray(parsed) ? parsed.length : 0;
    if (!projects) return { projects: [createDefaultProject()], hadCorruption: true };
    return { projects, hadCorruption: projects.length !== sourceCount };
  } catch {
    return { projects: [createDefaultProject()], hadCorruption: true };
  }
};

export const hydrateProjects = (raw: string | null): ScriptProject[] => {
  return hydrateProjectsWithReport(raw).projects;
};

export const serializeProjects = (projects: ScriptProject[]): string => {
  const normalized = normalizeProjects(projects) ?? [createDefaultProject()];
  try {
    return JSON.stringify(normalized);
  } catch {
    return JSON.stringify([createDefaultProject()]);
  }
};
