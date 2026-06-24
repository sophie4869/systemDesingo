// test/score.handler.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/score.js';

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

test('GET /api/score unauthenticated → 401', async () => {
  const res = makeMockRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.status, 401);
  assert.match(res.payload, /authenticated/i);
});

test('PUT /api/score unauthenticated → 401', async () => {
  const res = makeMockRes();
  await handler({ method: 'PUT', headers: {} }, res);
  assert.equal(res.status, 401);
  assert.match(res.payload, /authenticated/i);
});

test('DELETE /api/score unauthenticated → 401 (auth check before method check)', async () => {
  // score.js checks auth first, then method — so unauthenticated returns 401 not 405
  const res = makeMockRes();
  await handler({ method: 'DELETE', headers: {} }, res);
  assert.equal(res.status, 401);
});
