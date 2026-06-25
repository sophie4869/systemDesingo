// test/http.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJson, HttpError } from '../api/_lib/http.js';

test('readJson: returns Vercel pre-parsed object under the cap', async () => {
  const body = { state: { xp: 1 } };
  const out = await readJson({ body });
  assert.deepEqual(out, body);
});

test('readJson: accepts a large (sub-cap) power-user state ~500KB', async () => {
  const body = { state: { blob: 'x'.repeat(500 * 1024) } };
  const out = await readJson({ body });
  assert.equal(out.state.blob.length, 500 * 1024);
});

test('readJson: rejects pre-parsed body over the 2MB cap with 413', async () => {
  const body = { blob: 'x'.repeat(2 * 1024 * 1024 + 1024) };
  await assert.rejects(
    () => readJson({ body }),
    (e) => e instanceof HttpError && e.status === 413
  );
});
