import type { PromptItem, Scene, ScriptProject } from '../types';

export interface PromptCompletion {
  totalScenes: number;
  completedPrompts: number;
  missingSceneIds: number[];
  percent: number;
  completedItems: PromptItem[];
  isComplete: boolean;
}

const usablePrompt = (item: PromptItem): boolean =>
  Number.isFinite(item.sceneId) && item.generatedPrompt.trim().length > 0;

export const getProjectPromptCompletion = (
  project: Pick<ScriptProject, 'scenes' | 'promptItems'>,
): PromptCompletion => {
  const promptByScene = new Map<number, PromptItem>();
  const validSceneIds = new Set(project.scenes.map(scene => scene.id));

  for (const item of project.promptItems) {
    if (validSceneIds.has(item.sceneId) && usablePrompt(item)) promptByScene.set(item.sceneId, item);
  }

  const completedItems: PromptItem[] = [];
  const missingSceneIds: number[] = [];
  for (const scene of project.scenes) {
    const item = promptByScene.get(scene.id);
    if (item) completedItems.push(item);
    else missingSceneIds.push(scene.id);
  }

  const totalScenes = project.scenes.length;
  const completedPrompts = completedItems.length;
  const percent = totalScenes === 0 ? 0 : Math.round((completedPrompts / totalScenes) * 100);
  return {
    totalScenes,
    completedPrompts,
    missingSceneIds,
    percent,
    completedItems,
    isComplete: totalScenes > 0 && completedPrompts === totalScenes,
  };
};

export const getOverallPromptCompletion = (
  projects: Array<Pick<ScriptProject, 'scenes' | 'promptItems'>>,
): Omit<PromptCompletion, 'completedItems' | 'missingSceneIds'> & { missingPrompts: number } => {
  const active = projects.filter(project => project.scenes.length > 0);
  const totals = active.map(getProjectPromptCompletion);
  const totalScenes = totals.reduce((sum, item) => sum + item.totalScenes, 0);
  const completedPrompts = totals.reduce((sum, item) => sum + item.completedPrompts, 0);
  const missingPrompts = Math.max(0, totalScenes - completedPrompts);
  return {
    totalScenes,
    completedPrompts,
    missingPrompts,
    percent: totalScenes === 0 ? 0 : Math.round((completedPrompts / totalScenes) * 100),
    isComplete: totalScenes > 0 && missingPrompts === 0,
  };
};

export const mergePromptItemsByScene = (
  scenes: Scene[],
  current: PromptItem[],
  incoming: PromptItem[],
): PromptItem[] => getProjectPromptCompletion({
  scenes,
  promptItems: [...current, ...incoming],
}).completedItems;
