import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../public/', import.meta.url);
const viz = readFileSync(new URL('visualizer.js', root), 'utf8');
const app = readFileSync(new URL('app.js', root), 'utf8');
const html = readFileSync(new URL('index.html', root), 'utf8');

test('three particle formations share a style uniform in simulation and rendering', () => {
  assert.match(viz, /uniform float uStyle/g);
  assert.match(viz, /uStyle < 0\.5/);
  assert.match(viz, /uStyle < 1\.5/);
  assert.match(viz, /uStyle < 2\.5/);
});

test('onset and energy feed the shader and styles remain selectable', () => {
  assert.match(viz, /uPulse/);
  assert.match(viz, /uEnergy/);
  assert.match(app, /AudioMotion/);
  assert.match(app, /s-style/);
  assert.match(html, /id="s-style"/);
  for (const value of ['0', '1', '2']) assert.match(html, new RegExp(`<option value="${value}"`));
});
