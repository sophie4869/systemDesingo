# Auth-backed Scores & Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users of `distributed_systems_prep_v2.html` sign in via the existing s0phi3 auth service, persist quiz progress to Neon Postgres, and see a shared leaderboard — without changing anonymous behavior.

**Architecture:** This repo becomes its own Vercel project at `systemdesign.sophiebi.com` (a `*.sophiebi.com` subdomain, so the s0phi3 SSO `authToken` cookie reaches it). Three serverless functions (`/api/score` GET+PUT, `/api/leaderboard` GET) verify that cookie locally with the shared `JWT_SECRET`, and read/write a single `scores` table in Neon. **All merge logic lives server-side** (merge-on-write); the client only PUTs its local state and adopts the canonical result. Secrets go through the `secret` (keyrotate) tool; nothing secret is committed.

**Tech Stack:** Node ESM serverless functions (`@vercel/node`), `@neondatabase/serverless`, `jsonwebtoken`, Node built-in test runner (`node:test`/`node:assert`). Client code is inline `<script>` added to the existing single-file HTML (no build step).

**Spec:** `docs/superpowers/specs/2026-06-24-auth-scores-leaderboard-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | ESM project, deps, `test` script |
| `vercel.json` | static HTML + node functions; `/` → v2 HTML |
| `scripts/extract-content-ids.mjs` | Parse the HTML, emit known lesson/boss/badge IDs |
| `api/_lib/content-ids.json` | Generated allow-lists used by validation (committed) |
| `api/_lib/auth.js` | `extractAuthToken(req)`, `verifyToken(token)` |
| `api/_lib/validate.js` | `validateState(raw)` → clean state or throws `HttpError` |
| `api/_lib/merge.js` | `mergeState(incoming, stored)`, `deriveColumns(state)` |
| `api/_lib/db.js` | Neon client, `ensureSchema()`, `getRow`, `upsertMerged`, `leaderboard`, `rankOf` |
| `api/_lib/http.js` | `HttpError`, `readJson(req)`, `send(res,...)` helpers |
| `api/score.js` | GET (my state+rank) / PUT (validate→merge→upsert) |
| `api/leaderboard.js` | GET top 100 + currentUser |
| `api/health.js` | trivial liveness (`{ok:true}`) for monitoring |
| `distributed_systems_prep_v2.html` | + inline auth/sync/leaderboard client block & UI |
| `test/*.test.mjs` | unit tests for auth/validate/merge; gated integration test for db |
| `.env` | local secrets (gitignored; populated via `secret pull`) |

`AUTH_BASE_URL` (`https://auth.sophiebi.com`) is public config, set as a Vercel
env / default constant — **not** a secret.

---

## Phase 0 — Scaffolding

### Task 0.1: package.json

**Files:** Create `package.json`

- [ ] **Step 1: Write the file**

```json
{
  "name": "systemdesign-prep",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/",
    "extract-ids": "node scripts/extract-content-ids.mjs",
    "build": "echo \"No build step required\""
  },
  "dependencies": {
    "@neondatabase/serverless": "^0.10.0",
    "jsonwebtoken": "^9.0.2"
  },
  "engines": { "node": ">=18.0.0" }
}
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: `node_modules/` created, lockfile written, no errors.

- [ ] **Step 3: Confirm `.env` is ignored**

Run: `grep -n '.env' .gitignore || echo 'MISSING'`
Expected: a line matching `.env` (the existing `.gitignore` already excludes `.env`; if `MISSING`, add `.env` and `node_modules/` to `.gitignore`).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: scaffold node project for scores/leaderboard API"
```

### Task 0.2: vercel.json

**Files:** Create `vercel.json`

- [ ] **Step 1: Write the file**

```json
{
  "version": 2,
  "builds": [
    { "src": "*.html", "use": "@vercel/static" },
    { "src": "api/*.js", "use": "@vercel/node" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/$1" },
    { "src": "/health", "dest": "/api/health.js" },
    { "src": "/", "dest": "/distributed_systems_prep_v2.html" }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add vercel.json
git commit -m "chore: add vercel config (static html + node api)"
```

---

## Phase 1 — Content ID allow-lists

The validator drops unknown IDs in `done`/`best`/`perfect`/`badges`, so it needs
the known sets. They live in the HTML (`UNITS`, `BADGES`). Extract them to JSON.

### Task 1.1: extract-content-ids script

**Files:** Create `scripts/extract-content-ids.mjs`, Create (generated) `api/_lib/content-ids.json`

- [ ] **Step 1: Inspect the content shapes**

Read in `distributed_systems_prep_v2.html`:
- The `const UNITS=[...]` array (starts ~line 428) — each unit has an `id`, and `lessons` each with an `id`; bosses are keyed `boss-<unitId>` (confirm against `S.done['boss-'+...]` and `startBoss` sites).
- The `BADGES` array (~line 5972) — each has an `id`.

Confirm: lesson `done` keys = lesson `id`; boss `done` keys = `'boss-'+unit.id` (grep `S.done[` and `boss-`).

- [ ] **Step 2: Write the extractor**

It must not execute the HTML; parse the relevant JS arrays. Because `UNITS`/`BADGES`
are large object literals, the robust approach is to slice the `<script>` text and
evaluate ONLY those array literals in a throwaway `vm` context with no globals.

```js
// scripts/extract-content-ids.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../distributed_systems_prep_v2.html', import.meta.url), 'utf8');

function sliceArray(decl) {
  // returns the source text of `const <decl>=[ ... ];` balancing brackets
  const start = html.indexOf(decl);
  if (start < 0) throw new Error('not found: ' + decl);
  const eq = html.indexOf('[', start);
  let depth = 0, i = eq;
  for (; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(eq, i);
}

function evalArray(src) {
  return vm.runInNewContext('(' + src + ')', Object.create(null), { timeout: 1000 });
}

const UNITS = evalArray(sliceArray('const UNITS='));
const BADGES = evalArray(sliceArray('const BADGES='));

const lessonIds = [];
const bossIds = [];
const unitIds = [];
for (const u of UNITS) {
  unitIds.push(u.id);
  bossIds.push('boss-' + u.id);
  for (const l of (u.lessons || [])) lessonIds.push(l.id);
}
const badgeIds = BADGES.map(b => b.id);

const out = {
  doneIds: [...new Set([...lessonIds, ...bossIds])].sort(),
  unitIds: [...new Set(unitIds)].sort(),
  badgeIds: [...new Set(badgeIds)].sort(),
  generatedFrom: 'distributed_systems_prep_v2.html'
};
writeFileSync(new URL('../api/_lib/content-ids.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`done=${out.doneIds.length} units=${out.unitIds.length} badges=${out.badgeIds.length}`);
```

> Note: `best`/`perfect` are keyed by the same lesson/boss run IDs as `done`
> (`finishRun(id, ...)` / `commitRun`), so they validate against `doneIds`.
> `speedUnits` validates against `unitIds`.

- [ ] **Step 3: Run it**

Run: `node scripts/extract-content-ids.mjs`
Expected: prints non-zero counts and writes `api/_lib/content-ids.json`.

- [ ] **Step 4: Sanity-check output**

Run: `node -e "const c=require('./api/_lib/content-ids.json');console.log(c.badgeIds.join(','))"`
Expected: the badge IDs incl. `allbosses, cap, first, flawless, lvl10, lvl5, raft, recall, repl, streak3`.

- [ ] **Step 5: Commit**

```bash
git add scripts/extract-content-ids.mjs api/_lib/content-ids.json
git commit -m "feat: extract known lesson/boss/badge ids for server validation"
```

---

## Phase 2 — Auth library (TDD)

### Task 2.1: token extraction + verification

**Files:** Create `api/_lib/auth.js`, Test `test/auth.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
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
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm test`
Expected: FAIL (module/exports not found).

- [ ] **Step 3: Implement**

```js
// api/_lib/auth.js
import jwt from 'jsonwebtoken';

const ISSUER = 'auth.sophiebi.com';

export function parseCookies(req) {
  const h = req.headers?.cookie;
  if (!h) return {};
  return Object.fromEntries(h.split(';').map(c => {
    const [k, ...v] = c.trim().split('=');
    return [k, decodeURIComponent(v.join('='))];
  }));
}

export function extractAuthToken(req) {
  const auth = req.headers?.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return parseCookies(req).authToken || null;
}

export function verifyToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  // userId is the canonical claim (s0phi3 signs userId+username; no `sub`).
  return jwt.verify(token, secret, { algorithms: ['HS256'], issuer: ISSUER });
}

// Resolve the request's user, or null if unauthenticated/invalid.
export function getUser(req) {
  const token = extractAuthToken(req);
  if (!token) return null;
  try {
    const d = verifyToken(token);
    const userId = d.userId || d.sub;
    if (!userId) return null;
    return { userId: String(userId), username: String(d.username || 'anon').slice(0, 32) };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `npm test`
Expected: all auth tests PASS.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/auth.js test/auth.test.mjs
git commit -m "feat: jwt verification + token extraction for s0phi3 cookie"
```

---

## Phase 3 — Validation library (TDD)

### Task 3.1: validateState

**Files:** Create `api/_lib/validate.js`, Create `api/_lib/http.js`, Test `test/validate.test.mjs`

Implements spec §"Validation & anti-cheat": 64 KB cap (`413`), key allow-list
(unknown dropped), numeric bounds, ID/signature/boolean/date/array buckets,
`lastDay` UTC-real-date + not-future, `mistakes` size/count bounds (no field-strip).

- [ ] **Step 1: Write `api/_lib/http.js`**

```js
// api/_lib/http.js
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body; // vercel pre-parsed
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (raw.length === 0) return {};
  if (raw.length > 64 * 1024) throw new HttpError(413, 'Payload too large');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}
```

- [ ] **Step 2: Write failing tests**

```js
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
```

- [ ] **Step 3: Run — verify fail**

Run: `npm test`
Expected: FAIL (validate module missing).

- [ ] **Step 4: Implement `api/_lib/validate.js`**

```js
// api/_lib/validate.js
import ids from './content-ids.json' with { type: 'json' };

const DONE_IDS = new Set(ids.doneIds);
const UNIT_IDS = new Set(ids.unitIds);
const BADGE_IDS = new Set(ids.badgeIds);

const XP_MAX = 1_000_000;
const MAP_MAX = 5000;
const MISTAKE_OBJ_MAX_BYTES = 4 * 1024;
const STREAK_MAX = 100_000;       // generous; real cap is days-since-launch
const RECALL_MAX = 1_000_000;

const intIn = (v, lo, hi) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const n = Math.trunc(v);
  return Math.max(lo, Math.min(hi, n));
};
const asBool = v => !!v;

export function isUtcDateNotFuture(s, now = new Date()) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  if (d.toISOString().slice(0, 10) !== s) return false; // rejects 2020-02-30
  const todayMs = Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  return d.getTime() <= todayMs + 86_400_000; // today + 1 day skew slack
}

function cleanIdMap(m, allow, valueFn) {
  const out = {};
  if (!m || typeof m !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(m)) {
    if (n++ > MAP_MAX) break;
    if (!allow.has(k)) continue;
    const val = valueFn(v);
    if (val !== undefined) out[k] = val;
  }
  return out;
}

function cleanSigMap(m, valueFn) {
  const out = {};
  if (!m || typeof m !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(m)) {
    if (n++ > MAP_MAX) break;
    const val = valueFn(v);
    if (val !== undefined) out[k] = val;
  }
  return out;
}

// overrides lets tests inject id sets; defaults come from content-ids.json
export function validateState(raw, overrides = {}) {
  const doneIds = overrides.doneIds || DONE_IDS;
  const unitIds = overrides.unitIds || UNIT_IDS;
  const badgeIds = overrides.badgeIds || BADGE_IDS;
  if (!raw || typeof raw !== 'object') return {};
  const out = {};

  const xp = intIn(raw.xp, 0, XP_MAX); if (xp !== undefined) out.xp = xp;
  const streak = intIn(raw.streak, 0, STREAK_MAX); if (streak !== undefined) out.streak = streak;
  const recall = intIn(raw.recallNailed, 0, RECALL_MAX); if (recall !== undefined) out.recallNailed = recall;

  out.done = cleanIdMap(raw.done, doneIds, v => v ? true : undefined);
  out.best = cleanIdMap(raw.best, doneIds, v => intIn(v, 0, 100));
  out.perfect = cleanIdMap(raw.perfect, doneIds, v => v ? true : undefined);
  out.badges = cleanIdMap(raw.badges, badgeIds, v => v ? true : undefined);

  out.answered = cleanSigMap(raw.answered, v => (typeof v === 'number' ? Math.trunc(v) : 1));
  out.picks = cleanSigMap(raw.picks, v => (typeof v === 'number' ? Math.trunc(v) : undefined));
  out.mistakes = cleanSigMap(raw.mistakes, v => {
    if (!v || typeof v !== 'object') return undefined;
    let s; try { s = JSON.stringify(v); } catch { return undefined; }
    if (s.length > MISTAKE_OBJ_MAX_BYTES) return undefined; // drop oversized, keep rest
    return v;
  });

  for (const k of ['unlockAll', 'flawless', 'answeredSeeded', 'speedPickerOpen', 'reviewSkipRecall']) {
    if (k in raw) out[k] = asBool(raw[k]);
  }

  if ('lastDay' in raw) {
    if (raw.lastDay === null) out.lastDay = null;
    else if (isUtcDateNotFuture(raw.lastDay)) out.lastDay = raw.lastDay;
    // else: dropped (coupled streak update is skipped — see merge)
  }
  if ('speedN' in raw) { const n = intIn(raw.speedN, 1, 1000); if (n !== undefined) out.speedN = n; }
  if ('speedUnits' in raw) {
    if (raw.speedUnits === null) out.speedUnits = null;
    else if (Array.isArray(raw.speedUnits)) out.speedUnits = raw.speedUnits.filter(u => unitIds.has(u));
    // else dropped
  }
  return out;
}
```

> JSON import attributes (`with { type: 'json' }`) require Node ≥ 18.20/20.10.
> If the runtime rejects it, fall back to
> `import { readFileSync } from 'node:fs'` + `JSON.parse`.

- [ ] **Step 5: Run — verify pass**

Run: `npm test`
Expected: all validate tests PASS.

- [ ] **Step 6: Commit**

```bash
git add api/_lib/validate.js api/_lib/http.js test/validate.test.mjs
git commit -m "feat: server-side state validation (bounds, allow-lists, lastDay)"
```

---

## Phase 4 — Merge library (TDD)

### Task 4.1: mergeState + deriveColumns

**Files:** Create `api/_lib/merge.js`, Test `test/merge.test.mjs`

Implements spec merge table + Server-side merge-on-write. `stored` may be null
(first write). Inputs are already validated states.

- [ ] **Step 1: Write failing tests**

```js
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
  assert.equal(out.streak, 5);          // keep stored pair
  assert.equal(out.lastDay, '2026-06-20');
});

test('mistakes is last-write-wins (replace, not union)', () => {
  const out = mergeState({ mistakes: { x: { t: 'mcq' } } }, { mistakes: { y: { t: 'sort' }, z: { t: 'mcq' } } });
  assert.deepEqual(out.mistakes, { x: { t: 'mcq' } });
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
```

- [ ] **Step 2: Run — verify fail**

Run: `npm test`
Expected: FAIL (merge module missing).

- [ ] **Step 3: Implement `api/_lib/merge.js`**

```js
// api/_lib/merge.js
const max = (a, b) => Math.max(a ?? 0, b ?? 0);
const unionTrue = (a = {}, b = {}) => { const o = { ...a }; for (const k of Object.keys(b)) if (b[k]) o[k] = true; return o; };
const perKeyMax = (a = {}, b = {}) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = Math.max(o[k] ?? 0, v ?? 0); return o; };
const perKeyOr = (a = {}, b = {}) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = !!(o[k] || v); return o; };
const unionKeep = (a = {}, b = {}) => ({ ...b, ...a }); // existing/server (a) wins on clash

// incoming = this write's validated state; stored = current row's state (or null)
export function mergeState(incoming, stored) {
  const s = stored || {};
  const i = incoming || {};
  const out = { ...s, ...i }; // start with incoming overriding (covers prefs LWW + bools)

  // monotonic numerics
  if ('xp' in i || 'xp' in s) out.xp = max(i.xp, s.xp);
  if ('recallNailed' in i || 'recallNailed' in s) out.recallNailed = max(i.recallNailed, s.recallNailed);

  // map unions / per-key
  out.done = unionTrue(s.done, i.done);
  out.badges = unionTrue(s.badges, i.badges);
  out.answered = unionKeep(s.answered, i.answered);
  out.picks = unionKeep(s.picks, i.picks);      // clash → server/stored kept
  out.best = perKeyMax(s.best, i.best);
  out.perfect = perKeyOr(s.perfect, i.perfect);

  // mistakes: last-write-wins (authoritative replace). If incoming omitted it, keep stored.
  out.mistakes = ('mistakes' in i) ? (i.mistakes || {}) : (s.mistakes || {});

  // bool ORs (monotonic flags)
  for (const k of ['unlockAll', 'flawless', 'answeredSeeded']) {
    if (k in i || k in s) out[k] = !!(i[k] || s[k]);
  }

  // streak + lastDay coupled: later lastDay wins; tie → larger streak.
  // If incoming has no valid lastDay (dropped by validation), keep stored pair.
  const iHas = typeof i.lastDay === 'string';
  const sHas = typeof s.lastDay === 'string';
  if (iHas && sHas) {
    if (i.lastDay > s.lastDay) { out.streak = i.streak ?? 0; out.lastDay = i.lastDay; }
    else if (i.lastDay < s.lastDay) { out.streak = s.streak ?? 0; out.lastDay = s.lastDay; }
    else { out.streak = max(i.streak, s.streak); out.lastDay = i.lastDay; }
  } else if (iHas) { out.streak = i.streak ?? 0; out.lastDay = i.lastDay; }
  else if (sHas) { out.streak = s.streak ?? 0; out.lastDay = s.lastDay; }

  return out;
}

export function deriveColumns(state) {
  const done = state.done || {};
  return {
    xp: Math.trunc(state.xp || 0),
    items_done: Object.values(done).filter(Boolean).length,
    streak: Math.trunc(state.streak || 0),
    last_day: typeof state.lastDay === 'string' ? state.lastDay : null
  };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `npm test`
Expected: all merge tests PASS.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/merge.js test/merge.test.mjs
git commit -m "feat: server-side merge-on-write + rank-column derivation"
```

---

## Phase 5 — DB library

### Task 5.1: schema + queries

**Files:** Create `api/_lib/db.js`, Test `test/db.test.mjs` (gated on `DATABASE_URL`)

- [ ] **Step 1: Implement `api/_lib/db.js`**

```js
// api/_lib/db.js
import { neon } from '@neondatabase/serverless';

let _sql;
export function sql() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}

export async function ensureSchema() {
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS scores (
    user_id    text PRIMARY KEY,
    username   text NOT NULL,
    xp         integer NOT NULL DEFAULT 0,
    items_done integer NOT NULL DEFAULT 0,
    streak     integer NOT NULL DEFAULT 0,
    last_day   date,
    state      jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
  await q`CREATE INDEX IF NOT EXISTS scores_rank_idx ON scores (xp DESC, items_done DESC)`;
}

export async function getRow(userId) {
  const rows = await sql()`SELECT * FROM scores WHERE user_id = ${userId}`;
  return rows[0] || null;
}

export async function upsertMerged(userId, username, mergedState, cols) {
  const q = sql();
  const rows = await q`
    INSERT INTO scores (user_id, username, xp, items_done, streak, last_day, state, updated_at)
    VALUES (${userId}, ${username}, ${cols.xp}, ${cols.items_done}, ${cols.streak}, ${cols.last_day}, ${JSON.stringify(mergedState)}::jsonb, now())
    ON CONFLICT (user_id) DO UPDATE SET
      username = EXCLUDED.username,
      xp = EXCLUDED.xp,
      items_done = EXCLUDED.items_done,
      streak = EXCLUDED.streak,
      last_day = EXCLUDED.last_day,
      state = EXCLUDED.state,
      updated_at = now()
    RETURNING *`;
  return rows[0];
}

// effective_streak: UTC-day based; lapsed (>1 day old) ranks as 0.
const EFF = `(CASE WHEN last_day >= (now() AT TIME ZONE 'UTC')::date - 1 THEN streak ELSE 0 END)`;

export async function leaderboard(limit = 100) {
  return sql()`
    WITH base AS (
      SELECT username, xp, items_done, updated_at, user_id,
             ${sql.unsafe ? sql.unsafe(EFF) : undefined} AS effective_streak
      FROM scores
    )` // see note below — neon http driver: inline EFF directly
    ;
}

export async function rankOf(userId) {
  // COUNT strictly ahead + 1, same ordering keys incl. effective_streak
  const rows = await sql()`
    WITH me AS (SELECT xp, items_done, ${effSql()} AS es, updated_at, user_id FROM scores WHERE user_id = ${userId})
    SELECT (SELECT count(*) FROM scores s, me
            WHERE (s.xp, s.items_done, ${effSqlAliased('s')}, s.updated_at, s.user_id)
                  > (me.xp, me.items_done, me.es, me.updated_at, me.user_id)
                  IS NOT TRUE) AS placeholder`;
  return rows;
}
```

> **Implementation note (resolve during coding):** the `@neondatabase/serverless`
> HTTP tag does not support `sql.unsafe`. Write the `effective_streak` CASE
> expression **inline** in each tagged-template query rather than interpolating a
> string. Concretely, replace Task 5.1's `leaderboard`/`rankOf` bodies with the
> two finalized queries below (Step 2). The skeleton above is intentionally
> rewritten there; do not ship the `sql.unsafe` placeholder.

- [ ] **Step 2: Replace leaderboard/rankOf with finalized queries**

```js
// Final leaderboard(): effective_streak inline, ROW_NUMBER for unique ranks.
export async function leaderboard(limit = 100) {
  return sql()`
    WITH base AS (
      SELECT username, xp, items_done, updated_at, user_id,
             (CASE WHEN last_day >= (now() AT TIME ZONE 'UTC')::date - 1
                   THEN streak ELSE 0 END) AS effective_streak
      FROM scores
    ), ranked AS (
      SELECT username, xp, items_done, effective_streak,
             ROW_NUMBER() OVER (
               ORDER BY xp DESC, items_done DESC, effective_streak DESC,
                        updated_at ASC, user_id ASC) AS rank
      FROM base
    )
    SELECT username, xp, items_done, effective_streak AS streak, rank
    FROM ranked ORDER BY rank LIMIT ${limit}`;
}

// Final rankOf(): strictly-ahead count + 1, matching ordering keys.
export async function rankOf(userId) {
  const rows = await sql()`
    WITH me AS (
      SELECT xp, items_done,
             (CASE WHEN last_day >= (now() AT TIME ZONE 'UTC')::date - 1
                   THEN streak ELSE 0 END) AS es,
             updated_at, user_id
      FROM scores WHERE user_id = ${userId}
    )
    SELECT 1 + count(*) AS rank
    FROM scores s, me
    WHERE (s.xp > me.xp)
       OR (s.xp = me.xp AND s.items_done > me.items_done)
       OR (s.xp = me.xp AND s.items_done = me.items_done
           AND (CASE WHEN s.last_day >= (now() AT TIME ZONE 'UTC')::date - 1
                     THEN s.streak ELSE 0 END) > me.es)
       OR (s.xp = me.xp AND s.items_done = me.items_done
           AND (CASE WHEN s.last_day >= (now() AT TIME ZONE 'UTC')::date - 1
                     THEN s.streak ELSE 0 END) = me.es AND s.updated_at < me.updated_at)
       OR (s.xp = me.xp AND s.items_done = me.items_done
           AND (CASE WHEN s.last_day >= (now() AT TIME ZONE 'UTC')::date - 1
                     THEN s.streak ELSE 0 END) = me.es AND s.updated_at = me.updated_at
           AND s.user_id < me.user_id)`;
  return rows[0]?.rank ?? null;
}
```

Then delete the broken skeleton `leaderboard`/`rankOf` from Step 1.

- [ ] **Step 3: Gated integration test**

```js
// test/db.test.mjs
import { test, before } from 'node:test';
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
```

- [ ] **Step 4: Run (skips without DB; runs once DATABASE_URL set)**

Run: `npm test`
Expected: db test SKIPPED locally (until Phase 8 provides `DATABASE_URL`), others PASS. After Phase 8, re-run with `.env` loaded: `node --env-file=.env --test test/` → db test PASS.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db.js test/db.test.mjs
git commit -m "feat: neon schema + upsert/leaderboard/rank queries"
```

---

## Phase 6 — API endpoints

### Task 6.1: /api/score (GET + PUT)

**Files:** Create `api/score.js`

- [ ] **Step 1: Implement**

```js
// api/score.js
import { getUser } from './_lib/auth.js';
import { readJson, send, HttpError } from './_lib/http.js';
import { validateState } from './_lib/validate.js';
import { mergeState, deriveColumns } from './_lib/merge.js';
import { ensureSchema, getRow, upsertMerged, rankOf } from './_lib/db.js';

export default async function handler(req, res) {
  const user = getUser(req);
  if (!user) return send(res, 401, { message: 'Not authenticated' });
  try {
    await ensureSchema();
    if (req.method === 'GET') {
      const row = await getRow(user.userId);
      if (!row) return send(res, 200, { state: null, rank: null });
      return send(res, 200, { state: row.state, rank: await rankOf(user.userId) });
    }
    if (req.method === 'PUT') {
      const body = await readJson(req);
      const clean = validateState(body && body.state ? body.state : body);
      const row = await getRow(user.userId);
      const merged = mergeState(clean, row ? row.state : null);
      const cols = deriveColumns(merged);
      const saved = await upsertMerged(user.userId, user.username, merged, cols);
      return send(res, 200, { state: saved.state, rank: await rankOf(user.userId) });
    }
    return send(res, 405, { message: 'Method not allowed' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { message: e.message });
    console.error('[score]', e);
    return send(res, 503, { message: 'Score service unavailable' });
  }
}
```

- [ ] **Step 2: Smoke-test the handler logic with a fake req/res**

Add `test/score.handler.test.mjs` that imports the handler and calls it with a
mock unauthenticated req → expects 401 (no DB needed):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/score.js';

test('GET /api/score unauthenticated → 401', async () => {
  let status, payload;
  const res = { setHeader() {}, end(b) { payload = b; }, set statusCode(s) { status = s; } };
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(status, 401);
  assert.match(payload, /authenticated/i);
});
```

- [ ] **Step 3: Run — verify pass**

Run: `npm test`
Expected: 401 test PASS (and no DB connection attempted for the unauth path).

- [ ] **Step 4: Commit**

```bash
git add api/score.js test/score.handler.test.mjs
git commit -m "feat: /api/score GET+PUT (validate, merge-on-write, rank)"
```

### Task 6.2: /api/leaderboard + /api/health

**Files:** Create `api/leaderboard.js`, Create `api/health.js`

- [ ] **Step 1: Implement leaderboard**

```js
// api/leaderboard.js
import { getUser } from './_lib/auth.js';
import { send } from './_lib/http.js';
import { ensureSchema, leaderboard, getRow, rankOf } from './_lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' });
  const user = getUser(req);
  if (!user) return send(res, 401, { message: 'Sign in to view the leaderboard' });
  try {
    await ensureSchema();
    const top = await leaderboard(100);
    const row = await getRow(user.userId);
    const currentUser = row
      ? { username: user.username, xp: row.xp, items_done: row.items_done, rank: await rankOf(user.userId) }
      : null;
    return send(res, 200, { top, currentUser });
  } catch (e) {
    console.error('[leaderboard]', e);
    return send(res, 503, { message: 'Leaderboard unavailable' });
  }
}
```

- [ ] **Step 2: Implement health**

```js
// api/health.js
export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}
```

- [ ] **Step 3: Commit**

```bash
git add api/leaderboard.js api/health.js
git commit -m "feat: /api/leaderboard (signed-in) + /api/health"
```

---

## Phase 7 — Client integration (in the HTML)

All additions are a single new inline `<script>` block appended before `</body>`,
plus one small UI mount point. **Anonymous behavior must not change** — every new
code path is guarded by "are we signed in?". Verify in-browser (preview tools)
since this isn't unit-testable.

### Task 7.1: Auth state + sign-in/out controls

**Files:** Modify `distributed_systems_prep_v2.html` (append script + header button)

- [ ] **Step 1: Add a constant + a header control mount**

Find the app header/nav (grep for the level/xp display in `renderHome`). Add a
small container the script fills, e.g. `<span id="authSlot"></span>` near the top
bar. Add `const AUTH_BASE='https://auth.sophiebi.com';` and
`const API_BASE='';  // same-origin` near the top of the new script.

- [ ] **Step 2: Add the auth/sync client block**

```html
<script>
(function(){
  const AUTH_BASE='https://auth.sophiebi.com';
  let signedIn=false, me=null, pushTimer=null;

  function esc(s){const d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML;}

  async function api(path, opts){
    return fetch(path, Object.assign({credentials:'include',headers:{'content-type':'application/json'}}, opts));
  }

  // PUT local S, adopt canonical merged state (covers seed-up AND pull-down).
  async function reconcile(){
    let r = await api('/api/score', {method:'PUT', body: JSON.stringify({state:S})});
    if(r.status===401){ if(await tryRefresh()){ r = await api('/api/score', {method:'PUT', body: JSON.stringify({state:S})}); } }
    if(r.status===401){ setSignedOut(); return; }
    if(!r.ok) return; // DB hiccup → keep local
    const data = await r.json();
    if(data.state){ S = Object.assign(S, data.state); save(); try{renderHome&&renderHome();}catch(e){} }
  }

  async function tryRefresh(){
    try{ const r=await fetch(AUTH_BASE+'/api/refresh-token',{method:'POST',credentials:'include'}); return r.ok; }catch(e){ return false; }
  }

  async function checkAuth(){
    const r = await api('/api/score', {method:'GET'});
    if(r.status===401){ setSignedOut(); return false; }
    signedIn=true; renderAuthSlot();
    await reconcile();
    loadLeaderboard();
    return true;
  }

  function setSignedOut(){ signedIn=false; me=null; renderAuthSlot(); renderLeaderboardSignedOut(); }

  function renderAuthSlot(){
    const el=document.getElementById('authSlot'); if(!el) return;
    if(signedIn){ el.innerHTML='<button id="signOutBtn" class="btn">Sign out</button>'; document.getElementById('signOutBtn').onclick=signOut; }
    else{ el.innerHTML='<button id="signInBtn" class="btn blue">Sign in</button>'; document.getElementById('signInBtn').onclick=signIn; }
  }

  function signIn(){ location.href = AUTH_BASE+'/index.html?redirect='+encodeURIComponent(location.href); }
  async function signOut(){ try{ await fetch(AUTH_BASE+'/api/logout',{method:'POST',credentials:'include'}); }catch(e){} setSignedOut(); }

  // Debounced push: called from the patched save().
  window.__pushScore = function(){
    if(!signedIn) return;
    clearTimeout(pushTimer);
    pushTimer=setTimeout(()=>{ api('/api/score',{method:'PUT',body:JSON.stringify({state:S})}).catch(()=>{}); }, 1500);
  };

  // ---- leaderboard UI ----
  function loadLeaderboard(){
    api('/api/leaderboard',{method:'GET'}).then(r=> r.ok? r.json(): null).then(renderLeaderboard).catch(()=>renderLeaderboardUnavailable());
  }
  function lbEl(){ return document.getElementById('lbPanel'); }
  function renderLeaderboardSignedOut(){ const el=lbEl(); if(el) el.innerHTML='<div class="lb-msg">Sign in to see the leaderboard.</div>'; }
  function renderLeaderboardUnavailable(){ const el=lbEl(); if(el) el.innerHTML='<div class="lb-msg">Leaderboard unavailable.</div>'; }
  function renderLeaderboard(data){
    const el=lbEl(); if(!el) return; if(!data){ renderLeaderboardUnavailable(); return; }
    const mine = data.currentUser;
    let h='<table class="lb"><thead><tr><th>#</th><th>Player</th><th>XP</th><th>Done</th><th>🔥</th></tr></thead><tbody>';
    for(const row of data.top){
      const isMe = mine && row.username===mine.username && row.rank===mine.rank;
      h+='<tr class="'+(isMe?'lb-me':'')+'"><td>'+row.rank+'</td><td>'+esc(row.username)+'</td><td>'+row.xp+'</td><td>'+row.items_done+'</td><td>'+row.streak+'</td></tr>';
    }
    h+='</tbody></table>';
    if(mine && !data.top.some(r=>r.rank===mine.rank)){ h+='<div class="lb-you">You — #'+mine.rank+' · '+mine.xp+' XP</div>'; }
    else if(!mine){ h+='<div class="lb-msg">Complete a quiz to join the board.</div>'; }
    el.innerHTML=h;
  }

  window.addEventListener('DOMContentLoaded', ()=>{ renderAuthSlot(); checkAuth(); });
})();
</script>
```

> **XSS:** every `username` is rendered via `esc()` (textContent-based), per spec
> Security. Do not interpolate `row.username` raw.

- [ ] **Step 3: Patch `save()` to push when signed in**

Modify `distributed_systems_prep_v2.html:404` `save()`:

```js
function save(){try{localStorage.setItem(SAVE_KEY,JSON.stringify(S));}catch(e){} try{window.__pushScore&&window.__pushScore();}catch(e){}}
```

- [ ] **Step 4: Add a leaderboard mount + minimal styles**

Add `<div id="lbPanel" class="lb-panel"></div>` in a sensible home-screen spot
(e.g. below the unit list in `renderHome`'s container, or a new collapsible
section). Add CSS for `.lb`, `.lb-me`, `.lb-msg`, `.lb-you` consistent with the
app's existing card styling.

- [ ] **Step 5: Verify in browser (preview tools)**

Use the preview workflow:
1. `preview_start` (serve the repo root statically, or `vercel dev` if available).
2. Anonymous load: `preview_console_logs` clean; quizzes still save to localStorage; auth slot shows "Sign in"; leaderboard panel shows "Sign in to see the leaderboard."
3. Confirm no network calls block rendering when signed out.

(Authenticated round-trip is verified end-to-end in Phase 9 against the deployed
subdomain, since the SSO cookie requires `*.sophiebi.com`.)

- [ ] **Step 6: Commit**

```bash
git add distributed_systems_prep_v2.html
git commit -m "feat: client auth/sync + leaderboard panel (anonymous unchanged)"
```

---

## Phase 8 — Secrets & infra (ops; uses the `secret` tool)

> Uses the managing-secrets workflow. **Never read `.env` raw**; use `secret`.

### Task 8.1: Create the Neon database

- [ ] **Step 1:** Create a Neon project/branch for this app (via the Neon MCP
  `create_project` or the Neon console). Capture the pooled connection string.
- [ ] **Step 2:** Verify connectivity locally once `DATABASE_URL` is set (Step 8.3).

### Task 8.2: Create/link the Vercel project

- [ ] **Step 1:** From the repo root, link a new Vercel project named
  `systemdesign-prep` (`vercel link` / dashboard). Record `projectId` + `orgId`.
- [ ] **Step 2:** Set `AUTH_BASE_URL=https://auth.sophiebi.com` as a (non-secret)
  Vercel env for production+preview.

### Task 8.3: Wire keyrotate

- [ ] **Step 1:** Create `~/.config/keyrotate/systemDesign.json` modeled on
  `french-quiz.json`, Vercel-only targets, with a `_jwt_secret_tombstone` note
  and a single `DATABASE_URL` secret (`strategy: manual`, `targets:["vercel","localEnv"]`).
  Fill `vercel.projectId/orgId` from Task 8.2.
- [ ] **Step 2:** Add this project to s0phi3's `JWT_SECRET.crossProjectPropagate`
  list in `~/.config/keyrotate/s0phi3.json` with `targets:["vercel","localEnv"]`.
- [ ] **Step 3:** Add `sd`/`systemdesign` alias to keyrotate `_aliases.json`.
- [ ] **Step 4:** Commit + push dotfiles (`~/Projects/dotfiles`).
- [ ] **Step 5:** Push the Neon URL: `secret set sd DATABASE_URL --value '<neon-url>'`.
- [ ] **Step 6:** Propagate the CURRENT `JWT_SECRET` to the new targets WITHOUT a
  fleet-wide rotation:
  `secret get s0 JWT_SECRET | (read -r V; secret set s0 JWT_SECRET --value "$V")`.
- [ ] **Step 7:** Populate local `.env`: `secret pull sd`. Confirm `.env` has
  `DATABASE_URL` and `JWT_SECRET` (do not print values).
- [ ] **Step 8:** Run the gated DB test: `node --env-file=.env --test test/`.
  Expected: db integration test PASS; schema auto-created.

---

## Phase 9 — Deploy & end-to-end verification

### Task 9.1: Deploy + domain

- [ ] **Step 1:** Deploy preview: `vercel` (or `vercel deploy`). Hit `/health` → `{ok:true}`.
- [ ] **Step 2:** Promote to production and attach `systemdesign.sophiebi.com`
  (Vercel domains + DNS). Confirm TLS.

### Task 9.2: Authenticated end-to-end (manual, on the live subdomain)

- [ ] **Step 1:** Visit `https://systemdesign.sophiebi.com` signed out → anonymous
  works, "Sign in" shows, leaderboard prompts sign-in.
- [ ] **Step 2:** Click Sign in → redirected to `auth.sophiebi.com`, log in, land
  back. Auth slot shows "Sign out".
- [ ] **Step 3:** Earn XP in a lesson → within ~2s a `PUT /api/score` fires
  (Network tab) → reload → progress persists from server (clear localStorage to
  prove server-sourced).
- [ ] **Step 4:** Leaderboard shows your row, escaped username, correct rank.
- [ ] **Step 5:** Lapsed-streak check: a user whose `last_day` is >1 day old ranks
  with streak 0 (verify via a seeded test row, then delete it).
- [ ] **Step 6:** Sign out → reverts to anonymous/local.

### Task 9.3: Wrap up

- [ ] **Step 1:** Run full unit suite green: `node --env-file=.env --test test/`.
- [ ] **Step 2:** Update `README.md` with the new architecture (auth client +
  scores API + leaderboard, deployed at `systemdesign.sophiebi.com`).
- [ ] **Step 3:** Final commit + push branch; open PR.

---

## Notes for the implementer

- **DRY merge:** merge logic exists ONLY in `api/_lib/merge.js`. The client never
  merges — it PUTs local `S` and adopts the returned canonical state. Do not add a
  parallel client merge.
- **Order of validation→merge:** always `validateState` the incoming payload
  BEFORE `mergeState`; a dropped `lastDay` is what makes the merge keep the stored
  streak pair.
- **Same-origin cookies:** the SSO cookie only reaches the API when served from
  `*.sophiebi.com`, so authenticated paths are verifiable only on the deployed
  subdomain (Phase 9), not on `localhost`.
- **No secrets in git:** `.env`, `content-ids.json` is fine to commit (public
  content), but `DATABASE_URL`/`JWT_SECRET` live only in keyrotate targets.
- **If `vercel dev` is available**, you can exercise the API locally with a
  hand-minted HS256 token (Authorization: Bearer) signed with the local
  `JWT_SECRET`, bypassing the cookie for non-browser testing.
