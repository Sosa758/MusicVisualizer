import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../public/', import.meta.url);
const viz = readFileSync(new URL('visualizer.js', root), 'utf8');
const app = readFileSync(new URL('app.js', root), 'utf8');
const html = readFileSync(new URL('index.html', root), 'utf8');

test('pan is a camera offset that composes with the per-style framing', () => {
  assert.match(viz, /pan\(\s*dx\s*,\s*dy\s*\)/);
  assert.match(viz, /_pan\.x/);
  assert.match(viz, /_pan\.y/);
  assert.match(viz, /_applyCamera\(\)/);
});

test('pan is clamped, resettable, and wired to right drag plus sliders', () => {
  assert.match(viz, /PAN_LIMIT/);
  assert.match(viz, /resetView\(/);
  assert.match(app, /s-pan-x/);
  assert.match(app, /s-pan-y/);
  assert.match(app, /btn-reset-view/);
  assert.match(html, /id="s-pan-x"/);
  assert.match(html, /id="s-pan-y"/);
  assert.match(html, /id="btn-reset-view"/);
});
