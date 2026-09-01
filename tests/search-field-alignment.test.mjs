import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('../ui-system.css', import.meta.url), 'utf8');

test('search icons have a dedicated lane and never overlap placeholder text', () => {
  assert.match(css, /\.search-wrapper \.form-control-search\s*\{[\s\S]*?padding:\s*8px 12px 8px 42px !important/);
  assert.match(css, /\.search-wrapper \.search-icon\s*\{[\s\S]*?top:\s*50% !important[\s\S]*?transform:\s*translateY\(-50%\) !important/);
});

test('cashbook search aligns Lucide SVG icons inside its input', () => {
  assert.match(css, /\.so-quy-search-wrapper > :is\(i, svg\)/);
  assert.match(css, /\.so-quy-search-input\s*\{[\s\S]*?padding:\s*0 12px 0 34px !important/);
});
