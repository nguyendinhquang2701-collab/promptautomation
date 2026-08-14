import assert from 'node:assert/strict';
import test from 'node:test';

import { splitRawScriptIntoSegments } from '../state/scriptSegmentation';

test('splits a long script at a safe boundary without losing text', () => {
  const script = `${'A'.repeat(3600)}. ${'B'.repeat(3600)}.`;
  const segments = splitRawScriptIntoSegments(script, 4500, 3500);

  assert.equal(segments.length, 2);
  assert.equal(segments.join('').replace(/\s+/g, ''), script.replace(/\s+/g, ''));
  assert.ok(segments.every((segment) => segment.length > 0));
});

test('always makes progress when punctuation is at the start of a window', () => {
  const script = `. ${'x'.repeat(6000)}`;
  const segments = splitRawScriptIntoSegments(script, 4500, 3500);

  assert.equal(segments.length, 2);
  assert.equal(segments.join('').replace(/\s+/g, ''), script.replace(/\s+/g, ''));
  assert.ok(segments[0].length > 0);
});

test('supports scripts with no natural breakpoints', () => {
  const script = 'x'.repeat(9001);
  const segments = splitRawScriptIntoSegments(script, 4500, 3500);

  assert.deepEqual(segments.map((segment) => segment.length), [4500, 4500, 1]);
  assert.equal(segments.join(''), script);
});
