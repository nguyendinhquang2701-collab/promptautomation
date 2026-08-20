import assert from 'node:assert/strict';
import test from 'node:test';

import { AIJsonParseError, parseAIJsonResponse, parseFastCompatibleAIJsonResponse, unwrapItemsEnvelope } from '../services/aiJson';

test('parses direct and fenced JSON responses', () => {
  assert.deepEqual(parseAIJsonResponse('{"context":"Rome"}'), { context: 'Rome' });
  assert.deepEqual(parseAIJsonResponse('```json\n{"context":"Rome"}\n```'), { context: 'Rome' });
});

test('extracts a balanced JSON object after a provider preamble', () => {
  assert.deepEqual(parseAIJsonResponse('Here is the result: {"context":"Rome"}'), { context: 'Rome' });
});

test('never converts truncated or empty output into an empty object', () => {
  assert.throws(() => parseAIJsonResponse('{"context":"Rome"'), AIJsonParseError);
  assert.throws(() => parseAIJsonResponse(''), AIJsonParseError);
});

test('Fast compatibility parser preserves complete items from a truncated array', () => {
  assert.deepEqual(
    parseFastCompatibleAIJsonResponse('[{"id":1},{"id":2'),
    [{ id: 1 }],
  );
  assert.throws(() => parseFastCompatibleAIJsonResponse('partial response'), AIJsonParseError);
  assert.throws(() => parseFastCompatibleAIJsonResponse(''), AIJsonParseError);
});

test('keeps the item list when the model honours the items envelope', () => {
  assert.deepEqual(unwrapItemsEnvelope([{ sceneId: 1 }]), { items: [{ sceneId: 1 }], source: 'array' });
  assert.deepEqual(unwrapItemsEnvelope({ items: [{ sceneId: 1 }] }), { items: [{ sceneId: 1 }], source: 'items' });
});

test('rebuilds the list from a bare item object instead of losing the reply', () => {
  const bare = { sceneId: 142, action: 'A doctor writes on a chart.', style: 'documentary realism' };
  assert.deepEqual(unwrapItemsEnvelope(bare), { items: [bare], source: 'single-object' });
  assert.deepEqual(unwrapItemsEnvelope({ items: bare }), { items: [bare], source: 'items' });
});

test('accepts a differently named wrapper key', () => {
  assert.deepEqual(unwrapItemsEnvelope({ data: [{ id: 7 }] }), { items: [{ id: 7 }], source: 'alias' });
  assert.deepEqual(unwrapItemsEnvelope({ scene_prompts: [{ id: 7 }] }), { items: [{ id: 7 }], source: 'alias' });
});

test('never invents an item list out of an unrelated object', () => {
  assert.equal(unwrapItemsEnvelope({ message: 'I cannot help with that' }), null);
  assert.equal(unwrapItemsEnvelope('plain text'), null);
  assert.equal(unwrapItemsEnvelope(null), null);
});

test('Fast compatibility parser reports readable Vietnamese failures', () => {
  assert.throws(() => parseFastCompatibleAIJsonResponse('  '), (error: unknown) => {
    assert.ok(error instanceof AIJsonParseError);
    assert.match(error.message, /AI không trả về nội dung/);
    return true;
  });
});
