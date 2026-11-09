import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/visualizer.js', import.meta.url), 'utf8');
const velocity = source.split('const VELOCITY_SHADER =')[1].split('const RENDER_VERT =')[0];
const vertex = source.split('const RENDER_VERT =')[1].split('const RENDER_FRAG =')[0];

test('Prism has bounded audio height and a moving tapered veil', () => {
  assert.match(velocity, /prismHeight\s*=\s*clamp\(/);
  assert.match(velocity, /tipTaper/);
  assert.match(velocity, /uFlow/);
  assert.match(velocity, /uPulse/);
});

test('Prism respawns at its curtain baseline rather than below it', () => {
  const position = source.split('const POSITION_SHADER =')[1].split('const VELOCITY_SHADER =')[0];
  assert.match(position, /\(band - 15\.0\) \* 0\.335/);
  assert.match(position, /-1\.7 \+ hash1\(seed \* 57\.3\)/);
  assert.match(source, /pArr\[i4 \+ 1\] = -1\.7 \+/);
});

test('Prism frames its shorter columns to the right of the library overlay', () => {
  assert.match(source, /this\.settings\.uStyle < 0\.5 \? -2\.2 : 0/);
});

test('Prism decorrelates particle height and width within every band', () => {
  assert.match(velocity, /float stack = hash1\(seed \* 57\.3\)/);
  assert.match(velocity, /hash1\(seed \* 19\.1\)/);
  assert.match(velocity, /hash1\(seed \* 7\.7\)/);
});

test('Prism curtain is visible on full-size displays without washing out', () => {
  assert.match(vertex, /prismOpacity = 0\.14 \+ gated \* 0\.16/);
  assert.match(vertex, /hue \* \(0\.70 \+ gated \* 0\.35\)/);
});

test('Prism uses lower core opacity and a sparse accent population', () => {
  assert.match(vertex, /prismAccent/);
  assert.match(vertex, /prismOpacity/);
  assert.match(vertex, /uStyle < 0\.5/);
});
