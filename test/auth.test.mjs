// test/auth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { extractAuthToken, verifyToken } from '../api/_lib/auth.js';

const SECRET = 'x'.repeat(40);
process.env.JWT_SECRET = SECRET;
const ISS = 'auth.sophiebi.com';
const sign = (p, o = {}) => jwt.sign(p, SECRET, { algorithm: 'HS256', issuer: ISS, expiresIn: '15m', ...o });

test('extractAuthToken: Authorization header wins', () => {
  const req = { headers: { authorization: 'Bearer abc', cookie: 'authToken=xyz' } };
  assert.equal(extractAuthToken(req), 'abc');
});
test('extractAuthToken: falls back to authToken cookie', () => {
  const req = { headers: { cookie: 'foo=1; authToken=xyz; bar=2' } };
  assert.equal(extractAuthToken(req), 'xyz');
});
test('extractAuthToken: null when absent', () => {
  assert.equal(extractAuthToken({ headers: {} }), null);
});
test('verifyToken: valid token returns decoded with userId+username', () => {
  const d = verifyToken(sign({ userId: 'u1', username: 'Alice' }));
  assert.equal(d.userId, 'u1');
  assert.equal(d.username, 'Alice');
});
test('verifyToken: wrong issuer rejected', () => {
  assert.throws(() => verifyToken(sign({ userId: 'u1' }, { issuer: 'evil' })));
});
test('verifyToken: expired rejected', () => {
  assert.throws(() => verifyToken(sign({ userId: 'u1' }, { expiresIn: -10 })));
});
test('verifyToken: wrong secret rejected', () => {
  assert.throws(() => verifyToken(jwt.sign({ userId: 'u1' }, 'other-secret-other-secret-other', { algorithm: 'HS256', issuer: ISS })));
});
