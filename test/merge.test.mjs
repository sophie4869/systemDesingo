// test/merge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeState, deriveColumns } from '../api/_lib/merge.js';

test('monotonic fields take max / union', () => {
  const out = mergeState(
    { xp: 50, recallNailed: 1, done: { a: true }, best: { a: 80 }, badges: { first: true } },
    { xp: 30, recallNailed: 4, done: { b: true }, best: { a: 90 }, badges: {} }
  );
  assert.equal(out.xp, 50);
  assert.equal(out.recallNailed, 4);
  assert.deepEqual(out.done, { a: true, b: true });
  assert.deepEqual(out.best, { a: 90 });
  assert.deepEqual(out.badges, { first: true });
});

test('streak couples with lastDay (later day wins)', () => {
  const a = mergeState({ streak: 3, lastDay: '2026-06-20' }, { streak: 9, lastDay: '2026-06-10' });
  assert.equal(a.streak, 3); assert.equal(a.lastDay, '2026-06-20');
  const b = mergeState({ streak: 3, lastDay: '2026-06-10' }, { streak: 9, lastDay: '2026-06-20' });
  assert.equal(b.streak, 9); assert.equal(b.lastDay, '2026-06-20');
  const tie = mergeState({ streak: 3, lastDay: '2026-06-20' }, { streak: 9, lastDay: '2026-06-20' });
  assert.equal(tie.streak, 9);
});

test('streak update skipped when incoming lastDay missing (was dropped by validation)', () => {
  const out = mergeState({ streak: 99 }, { streak: 5, lastDay: '2026-06-20' });
  assert.equal(out.streak, 5);
  assert.equal(out.lastDay, '2026-06-20');
});

test('mistakes is last-write-wins (replace, not union)', () => {
  const out = mergeState({ mistakes: { x: { t: 'mcq' } } }, { mistakes: { y: { t: 'sort' }, z: { t: 'mcq' } } });
  assert.deepEqual(out.mistakes, { x: { t: 'mcq' } });
});

test('mistakes kept from stored when incoming omits it', () => {
  const out = mergeState({ xp: 1 }, { mistakes: { y: { t: 'sort' } } });
  assert.deepEqual(out.mistakes, { y: { t: 'sort' } });
});

test('prefs last-write-wins when present', () => {
  assert.equal(mergeState({ speedN: 25 }, { speedN: 15 }).speedN, 25);
  assert.equal(mergeState({}, { speedN: 15 }).speedN, 15);
});

test('stored null → incoming wins', () => {
  assert.deepEqual(mergeState({ xp: 7 }, null).xp, 7);
});

test('deriveColumns', () => {
  const c = deriveColumns({ xp: 42, streak: 6, lastDay: '2026-06-20', done: { a: true, b: true } });
  assert.deepEqual(c, { xp: 42, items_done: 2, streak: 6, last_day: '2026-06-20' });
});

// Extra: incoming omits done → stored done is preserved (absent-key keep-stored)
test('incoming omits done → stored done preserved', () => {
  const out = mergeState({ xp: 5 }, { done: { a: true, b: true } });
  assert.deepEqual(out.done, { a: true, b: true });
});

// Extra: mistakes empty-object replaces stored (LWW with explicit empty)
test('mistakes empty-object in incoming replaces stored entries', () => {
  const out = mergeState({ mistakes: {} }, { mistakes: { x: { t: 'mcq' } } });
  assert.deepEqual(out.mistakes, {});
});
