import assert from 'node:assert/strict';
import test from 'node:test';

import { AIJsonParseError, parseAIJsonResponse, parseFastCompatibleAIJsonResponse } from '../services/aiJson';

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
  assert.deepEqual(parseFastCompatibleAIJsonResponse('partial response'), []);
});
