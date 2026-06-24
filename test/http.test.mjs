// test/http.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJson, HttpError } from '../api/_lib/http.js';

test('readJson: returns Vercel pre-parsed object under the cap', async () => {
  const body = { state: { xp: 1 } };
  const out = await readJson({ body });
  assert.deepEqual(out, body);
});

test('readJson: rejects Vercel pre-parsed object over 64KB with 413', async () => {
  const body = { blob: 'x'.repeat(70 * 1024) };
  await assert.rejects(
    () => readJson({ body }),
    (e) => e instanceof HttpError && e.status === 413
  );
});
