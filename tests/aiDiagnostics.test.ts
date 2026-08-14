import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeDiagnosticText, sanitizeResponsePreview } from '../services/aiDiagnostics';

test('diagnostic preview is bounded and preserves both response ends', () => {
  const raw = `start ${'x'.repeat(3_000)} end`;
  const preview = sanitizeResponsePreview(raw, 100);

  assert.ok(preview.length <= 120);
  assert.ok(preview.startsWith('start'));
  assert.ok(preview.endsWith('end'));
  assert.match(preview, /\[truncated\]/);
});

test('diagnostic preview normalizes whitespace without adding response content', () => {
  assert.equal(sanitizeResponsePreview(' a\n\n b\t c '), 'a b c');
});

test('diagnostics redact API-key-shaped secrets before they can be copied', () => {
  assert.equal(sanitizeDiagnosticText('Authorization: Bearer sk-or-v1-secretvalue'), 'Authorization: Bearer [REDACTED]');
});
