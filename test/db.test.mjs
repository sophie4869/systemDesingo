// test/db.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const URL = process.env.DATABASE_URL;
const maybe = URL ? test : test.skip;

maybe('upsert → leaderboard ordering', async () => {
  const { ensureSchema, upsertMerged, leaderboard, rankOf, sql } = await import('../api/_lib/db.js');
  await ensureSchema();
  await sql()`DELETE FROM scores WHERE user_id LIKE 'test:%'`;
  const today = new Date().toISOString().slice(0, 10);
  await upsertMerged('test:a', 'A', { xp: 100, done: { x: true }, streak: 3, lastDay: today }, { xp: 100, items_done: 1, streak: 3, last_day: today });
  await upsertMerged('test:b', 'B', { xp: 200 }, { xp: 200, items_done: 0, streak: 0, last_day: null });
  const board = await leaderboard(10);
  const top = board.filter(r => r.username === 'A' || r.username === 'B');
  assert.equal(top[0].username, 'B'); // higher xp first
  assert.equal(await rankOf('test:b') < await rankOf('test:a'), true);
  await sql()`DELETE FROM scores WHERE user_id LIKE 'test:%'`;
});
