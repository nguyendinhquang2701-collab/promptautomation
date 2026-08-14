import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContextExtractionValidationError,
  normalizeContextExtraction,
} from '../services/contextExtraction';

const character = {
  name: 'The Roman leader',
  promptName: 'A Khan',
  originalName: 'Julius Caesar',
  isRealPerson: true,
  visualDescription: 'middle-aged man, short dark hair, sturdy build, white toga',
};

test('accepts the canonical extraction response', () => {
  const result = normalizeContextExtraction({ context: 'Ancient Rome at dawn.', characters: [character] });
  assert.equal(result.context, 'Ancient Rome at dawn.');
  assert.equal(result.characters[0].promptName, 'A Khan');
});

test('accepts globalContext only as a backwards-compatible alias', () => {
  const result = normalizeContextExtraction({ globalContext: 'Ancient Rome at dawn.', characters: [] });
  assert.equal(result.context, 'Ancient Rome at dawn.');
  assert.deepEqual(result.characters, []);
});

test('accepts known provider wrappers and common field aliases', () => {
  const result = normalizeContextExtraction({
    result: {
      global_context: 'Ancient Rome at dawn.',
      character_list: [{ prompt_name: 'The Roman leader', is_real_person: 'false' }],
    },
  });
  assert.equal(result.context, 'Ancient Rome at dawn.');
  assert.equal(result.characters[0].name, 'The Roman leader');
  assert.equal(result.characters[0].visualDescription, '');
});

test('rejects empty and malformed extraction responses', () => {
  for (const value of [{}, [], { context: '', characters: [] }, { context: 'Context', characters: {} }]) {
    assert.throws(() => normalizeContextExtraction(value), ContextExtractionValidationError);
  }
});

test('rejects character records without any usable name', () => {
  assert.throws(
    () => normalizeContextExtraction({ context: 'Context', characters: [{ visualDescription: 'Unknown person' }] }),
    ContextExtractionValidationError,
  );
});
