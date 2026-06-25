// test/leaderboard.handler.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import leaderboardHandler from '../api/leaderboard.js';
import healthHandler from '../api/health.js';

// Mock res helper — captures statusCode via setter, end captures body
function makeMockRes() {
  let status, payload;
  return {
    get status() { return status; },
    get payload() { return payload; },
    set statusCode(s) { status = s; },
    setHeader() {},
    end(b) { payload = b; },
  };
}

test('GET /api/leaderboard unauthenticated → 401 with sign-in message', async () => {
  const res = makeMockRes();
  await leaderboardHandler({ method: 'GET', headers: {} }, res);
  assert.equal(res.status, 401);
  assert.match(res.payload, /sign in/i);
});

test('POST /api/leaderboard unauthenticated → 405 (method check before auth)', async () => {
  // leaderboard.js checks method first, so non-GET returns 405 regardless of auth
  const res = makeMockRes();
  await leaderboardHandler({ method: 'POST', headers: {} }, res);
  assert.equal(res.status, 405);
  assert.match(res.payload, /method not allowed/i);
});

test('GET /api/health → 200 with {ok:true}', async () => {
  const res = makeMockRes();
  healthHandler({ method: 'GET', headers: {} }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.payload), { ok: true });
});
