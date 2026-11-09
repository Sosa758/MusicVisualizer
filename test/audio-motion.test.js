import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioMotion } from '../public/audio.js';

const bands = (value) => Float32Array.from({ length: 31 }, () => value);

test('onset creates an immediate pulse, then decays in silence', () => {
  const motion = new AudioMotion();
  motion.sample(bands(0.01), 1 / 60);
  const hit = motion.sample(bands(0.85), 1 / 60);
  assert.ok(hit.pulse > 0.4, `pulse ${hit.pulse}`);
  const tail = motion.sample(null, 1 / 60);
  assert.ok(tail.pulse < hit.pulse);
  assert.equal(tail.spectrum, null);
});

test('steady loud music does not retrigger on every frame', () => {
  const motion = new AudioMotion();
  motion.sample(bands(0.8), 1 / 60);
  for (let i = 0; i < 20; i++) motion.sample(bands(0.8), 1 / 60);
  assert.ok(motion.pulse < 0.3, `pulse ${motion.pulse}`);
});

test('frequency groups react independently', () => {
  const motion = new AudioMotion();
  const high = new Float32Array(31);
  high.fill(0.9, 23);
  const frame = motion.sample(high, 1 / 60);
  assert.ok(frame.treble > frame.bass * 3);
  assert.ok(frame.energy > 0);
});
