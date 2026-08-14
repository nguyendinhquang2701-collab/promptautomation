import assert from 'node:assert/strict';
import test from 'node:test';
import type { PromptItem, Scene } from '../types';
import { getOverallPromptCompletion, getProjectPromptCompletion, mergePromptItemsByScene } from '../state/promptCompletion';

const scenes: Scene[] = [1, 2, 3].map(id => ({
  id,
  sourceText: `scene ${id}`,
  visualDescription: `visual ${id}`,
  characterDetails: '',
  settingTime: '',
  duration: '8s',
}));

const prompt = (sceneId: number, generatedPrompt = `prompt ${sceneId}`): PromptItem => ({
  sceneId,
  sourceText: `scene ${sceneId}`,
  originalDescription: `visual ${sceneId}`,
  generatedPrompt,
});

test('prompt completion counts unique usable prompts that belong to real scenes', () => {
  const result = getProjectPromptCompletion({
    scenes,
    promptItems: [prompt(1), prompt(1, 'new prompt 1'), prompt(2, '  '), prompt(99)],
  });

  assert.equal(result.completedPrompts, 1);
  assert.equal(result.totalScenes, 3);
  assert.equal(result.percent, 33);
  assert.deepEqual(result.missingSceneIds, [2, 3]);
  assert.equal(result.completedItems[0].generatedPrompt, 'new prompt 1');
});

test('repair merge preserves completed prompts and orders replacements by scene', () => {
  const merged = mergePromptItemsByScene(scenes, [prompt(1), prompt(3)], [prompt(2), prompt(3, 'replacement 3')]);
  assert.deepEqual(merged.map(item => item.sceneId), [1, 2, 3]);
  assert.equal(merged[2].generatedPrompt, 'replacement 3');
});

test('overall completion reports the exact percentage and only completes at 100%', () => {
  const result = getOverallPromptCompletion([
    { scenes, promptItems: [prompt(1), prompt(2)] },
    { scenes: scenes.slice(0, 1), promptItems: [prompt(1)] },
  ]);
  assert.deepEqual(result, {
    totalScenes: 4,
    completedPrompts: 3,
    missingPrompts: 1,
    percent: 75,
    isComplete: false,
  });
});
