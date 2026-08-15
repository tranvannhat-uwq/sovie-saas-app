import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

test('customer list owns the scroll area and keeps every column heading sticky', () => {
  assert.match(html, /<div class="table-responsive customers-table-scroll">\s*<table class="table customers-table"/);
  assert.match(css, /\.customers-table-scroll\s*\{[\s\S]*?max-height:[^;]+;[\s\S]*?overflow:\s*auto;/);
  assert.match(css, /\.customers-table-scroll \.customers-table thead th\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0;[\s\S]*?z-index:\s*3;/);
});
