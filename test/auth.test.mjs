// test/auth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { extractAuthToken, verifyToken, getUser } from '../api/_lib/auth.js';

const SECRET = 'x'.repeat(64);
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

// ── getUser tests ──────────────────────────────────────────────────────────────

test('getUser: token with userId returns {userId, username}', () => {
  const req = { headers: { authorization: 'Bearer ' + sign({ userId: 'u1', username: 'Alice' }) } };
  const user = getUser(req);
  assert.equal(user.userId, 'u1');
  assert.equal(user.username, 'Alice');
});

test('getUser: token with sub but no userId falls back to sub', () => {
  // sign without userId; jwt library sets sub via the standard claim
  const token = jwt.sign({ sub: 'sub-user', username: 'Bob' }, SECRET, { algorithm: 'HS256', issuer: ISS, expiresIn: '15m' });
  const req = { headers: { authorization: 'Bearer ' + token } };
  const user = getUser(req);
  assert.equal(user.userId, 'sub-user');
  assert.equal(user.username, 'Bob');
});

test('getUser: token missing both userId and sub returns null', () => {
  const token = jwt.sign({ username: 'Nobody' }, SECRET, { algorithm: 'HS256', issuer: ISS, expiresIn: '15m' });
  const req = { headers: { authorization: 'Bearer ' + token } };
  assert.equal(getUser(req), null);
});

test('getUser: username longer than 32 chars is truncated to 32', () => {
  const longName = 'A'.repeat(50);
  const req = { headers: { authorization: 'Bearer ' + sign({ userId: 'u2', username: longName }) } };
  const user = getUser(req);
  assert.equal(user.username.length, 32);
  assert.equal(user.username, 'A'.repeat(32));
});

test('getUser: no token on request returns null', () => {
  assert.equal(getUser({ headers: {} }), null);
});

test('getUser: invalid token returns null and does not throw', () => {
  const req = { headers: { authorization: 'Bearer not.a.valid.token' } };
  assert.doesNotThrow(() => {
    const result = getUser(req);
    assert.equal(result, null);
  });
});

test('getUser: expired token returns null', () => {
  const req = { headers: { authorization: 'Bearer ' + sign({ userId: 'u3', username: 'Eve' }, { expiresIn: -10 }) } };
  assert.equal(getUser(req), null);
});

test('getUser: authToken cookie path resolves correctly', () => {
  const token = sign({ userId: 'u4', username: 'Cookie' });
  const req = { headers: { cookie: 'authToken=' + token } };
  const user = getUser(req);
  assert.equal(user.userId, 'u4');
  assert.equal(user.username, 'Cookie');
});
