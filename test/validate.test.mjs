// test/validate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateState, isUtcDateNotFuture } from '../api/_lib/validate.js';

test('drops unknown top-level keys', () => {
  const out = validateState({ xp: 5, evil: { a: 1 } });
  assert.equal(out.xp, 5);
  assert.equal('evil' in out, false);
});
test('coerces/bounds numeric xp', () => {
  assert.equal(validateState({ xp: -3 }).xp, 0);
  assert.equal(validateState({ xp: 1.9 }).xp, 1);
  assert.equal(validateState({ xp: 9e9 }).xp, 1_000_000);
  assert.equal('xp' in validateState({ xp: 'NaN' }), false);
});
test('done keeps only known ids', () => {
  const out = validateState({ done: { 'kv-1': true, 'totally-fake': true } }, { doneIds: new Set(['kv-1']) });
  assert.deepEqual(out.done, { 'kv-1': true });
});
test('best clamps 0..100 and known id', () => {
  const out = validateState({ best: { 'kv-1': 150, 'x': 50 } }, { doneIds: new Set(['kv-1']) });
  assert.deepEqual(out.best, { 'kv-1': 100 });
});
test('badges keep known ids boolean', () => {
  const out = validateState({ badges: { first: 1, fake: true } }, { badgeIds: new Set(['first']) });
  assert.deepEqual(out.badges, { first: true });
});
test('lastDay: rejects future and malformed, keeps valid', () => {
  assert.equal(isUtcDateNotFuture('2020-01-01'), true);
  assert.equal(isUtcDateNotFuture('2020-02-30'), false);
  assert.equal(isUtcDateNotFuture('not-a-date'), false);
  assert.equal(isUtcDateNotFuture('2999-01-01'), false);
  assert.equal('lastDay' in validateState({ lastDay: '2999-01-01' }), false);
});
test('mistakes: drops oversized entry, keeps small', () => {
  const big = { t: 'mcq', q: 'x'.repeat(5000) };
  const out = validateState({ mistakes: { a: { t: 'mcq', q: 'hi' }, b: big } });
  assert.equal('a' in out.mistakes, true);
  assert.equal('b' in out.mistakes, false);
});
test('speedUnits: null or known unit ids', () => {
  assert.equal(validateState({ speedUnits: null }).speedUnits, null);
  assert.deepEqual(validateState({ speedUnits: ['u1', 'bad'] }, { unitIds: new Set(['u1']) }).speedUnits, ['u1']);
  assert.equal('speedUnits' in validateState({ speedUnits: 'weird' }), false);
});
test('speedUnits: all-unknown ids drops field entirely', () => {
  const out = validateState({ speedUnits: ['bad'] }, { unitIds: new Set(['u1']) });
  assert.equal('speedUnits' in out, false);
});
test('speedUnits: explicit empty array is preserved', () => {
  const out = validateState({ speedUnits: [] });
  assert.deepEqual(out.speedUnits, []);
});
test('streak without lastDay: lastDay absent from output (merge keeps stored pair)', () => {
  const out = validateState({ streak: 5 });
  assert.equal('streak' in out, true);
  assert.equal('lastDay' in out, false);
});
test('map keys absent from input are not emitted', () => {
  const out = validateState({ xp: 5 });
  assert.equal('done' in out, false);
  assert.equal('best' in out, false);
  assert.equal('perfect' in out, false);
  assert.equal('badges' in out, false);
  assert.equal('answered' in out, false);
  assert.equal('picks' in out, false);
  assert.equal('mistakes' in out, false);
});
test('present-but-empty mistakes is preserved', () => {
  const out = validateState({ mistakes: {} });
  assert.equal('mistakes' in out, true);
  assert.deepEqual(out.mistakes, {});
});
test('present done map is still cleaned and returned', () => {
  const out = validateState({ done: { 'kv-1': true } }, { doneIds: new Set(['kv-1']) });
  assert.equal('done' in out, true);
  assert.deepEqual(out.done, { 'kv-1': true });
});
