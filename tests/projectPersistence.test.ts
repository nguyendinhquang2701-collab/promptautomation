import assert from 'node:assert/strict';
import test from 'node:test';

import type { ScriptProject } from '../types';
import {
  createDefaultProject,
  hydrateProjects,
  hydrateProjectsWithReport,
  serializeProjects,
} from '../state/projectPersistence';

const project = (): ScriptProject => ({
  id: 'project-1',
  name: 'Phân đoạn 1',
  content: 'Nội dung vẫn phải được giữ lại.',
  scenes: [
    {
      id: 1,
      sourceText: 'Nguồn',
      visualDescription: 'Cảnh đã hoàn tất',
      characterDetails: '',
      settingTime: 'day',
      duration: '8s',
      isRepairing: true,
    },
  ],
  promptItems: [
    {
      sceneId: 1,
      sourceText: 'Nguồn',
      originalDescription: 'Cảnh đã hoàn tất',
      generatedPrompt: '{"action":"done"}',
    },
  ],
  sceneStatus: 'loading',
  promptStatus: 'loading',
  loadingMessage: 'Đang chạy',
});

test('interrupted loading state recovers without discarding completed work', () => {
  const [restored] = hydrateProjects(JSON.stringify([project()]));

  assert.equal(restored.sceneStatus, 'error');
  assert.equal(restored.promptStatus, 'error');
  assert.match(restored.sceneErrorMessage || '', /gián đoạn/i);
  assert.match(restored.promptErrorMessage || '', /gián đoạn/i);
  assert.equal(restored.loadingMessage, undefined);
  assert.equal(restored.scenes[0].isRepairing, false);
  assert.equal(restored.content, project().content);
  assert.equal(restored.promptItems[0].generatedPrompt, project().promptItems[0].generatedPrompt);
});

test('temporary loading flags are never persisted', () => {
  const [stored] = JSON.parse(serializeProjects([project()])) as ScriptProject[];
  assert.notEqual(stored.sceneStatus, 'loading');
  assert.notEqual(stored.promptStatus, 'loading');
  assert.equal(stored.loadingMessage, undefined);
  assert.equal(stored.scenes[0].isRepairing, false);
});

test('malformed or empty storage falls back to a valid blank project', () => {
  assert.deepEqual(hydrateProjects('{broken'), [createDefaultProject()]);
  assert.deepEqual(hydrateProjects('[]'), [createDefaultProject()]);
  assert.deepEqual(hydrateProjects(null), [createDefaultProject()]);
});

test('one corrupt entry never erases otherwise valid projects', () => {
  const valid = project();
  const report = hydrateProjectsWithReport(JSON.stringify([valid, { id: 'bad', content: 42 }]));
  assert.equal(report.hadCorruption, true);
  assert.equal(report.projects.length, 1);
  assert.equal(report.projects[0].content, valid.content);
});

test('legacy scenes with missing optional fields are recovered instead of dropping the draft', () => {
  const legacy = project() as unknown as Record<string, unknown>;
  legacy.scenes = [{ id: 7, sourceText: 'Cảnh cũ', visualDescription: 'Mô tả cũ' }];
  const [restored] = hydrateProjects(JSON.stringify([legacy]));
  assert.equal(restored.content, project().content);
  assert.equal(restored.scenes[0].id, 7);
  assert.equal(restored.scenes[0].duration, '8s');
});
