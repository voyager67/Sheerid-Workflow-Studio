import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('every dashboard DOM lookup maps to an element in the page', () => {
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
  const references = new Set([...app.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(match => match[1]));
  const missing = [...references].filter(id => !ids.has(id));
  assert.deepEqual(missing, []);
});

test('dashboard loads only local assets and contains no inline script or event handlers', () => {
  assert.match(html, /href=["']\/styles\.css["']/);
  assert.match(html, /src=["']\/app\.js["']/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\son(?:click|submit|change|load)=/i);
  assert.doesNotMatch(app, /https?:\/\//i);
});

test('dashboard exposes the verification, organization search, document and correction controls', () => {
  for (const id of [
    'create-form', 'organization-search-button', 'refresh-all',
    'detail-refresh', 'detail-stop', 'detail-clear',
    'resubmit-form', 'document-form', 'logout'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `Missing dashboard control: ${id}`);
  }
});


test('static dashboard examples are clearly fictional and do not contain a real organization ID', () => {
  assert.match(html, /alex\.morgan@example\.test/);
  assert.match(html, /"id": 0/);
  assert.match(html, /Example Technical Institute \(fictional demo\)/);
  assert.doesNotMatch(html, /"id": 4597/);
});
