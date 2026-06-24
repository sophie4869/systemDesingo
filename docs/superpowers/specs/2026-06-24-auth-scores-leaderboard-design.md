# Auth-backed scores & leaderboard — design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan

## Goal

Let users of the system-design prep app (`distributed_systems_prep_v2.html`)
sign in, persist their quiz progress in a database, and see a shared
leaderboard. Anonymous use must keep working exactly as it does today.

## Context

- The app today is a single static HTML file. All progress lives in
  `localStorage` under `dsq_v2_save` as the `S` object
  (`xp`, `done`, `badges`, `streak`, `best`, `mistakes`, `perfect`, …).
- Sophie already runs a production multi-client auth service, **s0phi3**
  (`auth.sophiebi.com`): MongoDB + HS256 JWT, HttpOnly SSO cookie scoped to
  `Domain=.sophiebi.com; SameSite=None; Secure`, with a documented
  "new web client" integration flow and seven existing downstream consumers.
- `JWT_SECRET` is **owned by s0phi3** and shared (HS256 symmetric) with every
  downstream client via the keyrotate `crossProjectPropagate` mechanism. Issuer
  is pinned to `auth.sophiebi.com`; access tokens are short-lived (15m) with a
  refresh token.

## Decisions (locked)

1. **Architecture A** — a new Neon Postgres backend lives in *this* repo;
   identity comes from the existing s0phi3 service. No changes to the auth repo.
2. **Rank metric** — order by `xp DESC, items_done DESC, streak DESC`.
3. Deploy at a `*.sophiebi.com` subdomain (`systemdesign.sophiebi.com`) so the
   browser sends the s0phi3 SSO cookie to this app's own `/api/*`.
4. Share `JWT_SECRET` with s0phi3 for **local** token verification (no network
   hop per request).
5. Store the full `S` blob server-side for cross-device progress sync.
6. All secrets go through the `secret` (keyrotate) tool; nothing committed to the
   repo.

## Data model (Neon Postgres)

One row per user in a `scores` table:

| column       | type        | purpose                                   |
|--------------|-------------|-------------------------------------------|
| `user_id`    | text PK     | from JWT (`sub`/`userId`)                 |
| `username`   | text        | display name from JWT, shown on board     |
| `xp`         | int         | rank key 1 (denormalized from `state`)    |
| `items_done` | int         | rank key 2 (count of completed items)     |
| `streak`     | int         | rank key 3                                |
| `state`      | jsonb       | the full `S` blob → cross-device sync      |
| `updated_at` | timestamptz | last write                                |

Index: `(xp DESC, items_done DESC, streak DESC, updated_at ASC, user_id ASC)`
for the board query. The three rank columns are recomputed server-side from
`state` on every write, so the board and saved progress never drift. `username`
is refreshed from the JWT on every `PUT` so the board reflects display-name
changes made in s0phi3, **truncated to 32 chars** on store (see Security).

**Deterministic ranking.** Ordering is fully deterministic via tie-breakers:
`xp DESC, items_done DESC, streak DESC, updated_at ASC, user_id ASC` (earlier
achiever, then stable id, win ties). Each user gets a **unique** rank via
`ROW_NUMBER()` over that ordering (not dense/shared rank) — so "your rank" is
always a single integer.

Leaderboard query (top 100):
```sql
SELECT username, xp, items_done, streak,
       ROW_NUMBER() OVER (ORDER BY xp DESC, items_done DESC, streak DESC,
                                   updated_at ASC, user_id ASC) AS rank
FROM scores
ORDER BY rank
LIMIT 100;
```
The caller's own rank (when outside the top 100) is computed as
`COUNT(*) of rows ordered strictly ahead of the caller + 1`, using the same
ordering keys, so it matches the `ROW_NUMBER` the caller would have.

## Identity verification (no auth-repo changes)

A small self-contained module (`api/_lib/auth.js`) reproduces s0phi3's token
handling — it does **not** import from the auth repo:

- `extractAuthToken(req)` — `Authorization: Bearer …` header first, else the
  `authToken` cookie (cookie arrives automatically because the app is on
  `*.sophiebi.com`).
- `verifyToken(token)` — `jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'],
  issuer: 'auth.sophiebi.com' })`. Returns the decoded user or throws.

**Canonical identity claim:** the `user_id` PK is taken from `decoded.userId`
(s0phi3 signs `userId: user._id` and `username: user.username` — `api/auth.js`
login/check-auth, `api/user.js` refresh). s0phi3 does **not** set a `sub` claim,
so `userId` is always the real source; a `decoded.sub` fallback may be kept
defensively but never fires today. The display `username` comes from
`decoded.username`.

Sign-in, sign-up, email verification, and password reset all stay on
`auth.sophiebi.com`. This app only *consumes* the token.

## API (Vercel serverless functions, `@vercel/node`)

- `GET /api/score` → the caller's saved `state` plus current rank.
  `401` if not signed in. **No implicit writes:** a user with no row yet gets
  `200 { state: null, rank: null }` (the row is created only by the first
  `PUT`). The client treats `state: null` as "no server progress" and keeps
  using its local `S`.
- `PUT /api/score` → **validate → merge-on-write → upsert**. Client sends its
  `S`. Server validates the payload (below), **merges it server-side with the
  stored row** (below), recomputes the three rank columns from the merged state,
  upserts, and returns the canonical merged state. `400` on invalid payload.
- `GET /api/leaderboard` → `{ top: [...100], currentUser: {...}|null }`.
  **Signed-in only.** A caller with no row yet gets `currentUser: null`; the
  client shows them as unranked ("complete a quiz to join the board") until their
  first `PUT` creates the row. No phantom zero-XP rows are written on read.

### Server-side merge-on-write (conflict model)

Writes are **last-write-wins for preferences, monotonic-merge for progress** —
the server applies the same per-key rules as the client merge (see Client
integration) to `incoming` vs `stored`, so a stale tab/device that `PUT`s an
older blob **cannot regress** monotonic progress (`xp`, `streak`, `done`,
`answered`, etc. only ever grow/union). This removes the need for ETags or
optimistic-concurrency preconditions. Device UI prefs (`speedN`, `speedUnits`,
`speedPickerOpen`, `reviewSkipRecall`) are genuinely last-write-wins and not
ranked, so a stale write to those is harmless. `updated_at` is set to the server
clock on every write.

### Validation & anti-cheat

XP is **repeatable** in this app (recall self-grades and run/flawless bonuses
re-fire on replay — `distributed_systems_prep_v2.html` ~lines 6789, 6882), so
there is **no meaningful "sum of all XP" ceiling**. We therefore validate
*shape and bounds*, not a global XP cap:

- **Payload size:** reject bodies over **64 KB** with `413 Payload Too Large`
  (this is the one exception to the `400` used for all other invalid payloads).
- **Top-level keys:** only keys in the known `S` inventory (below) are accepted;
  unknown keys are **dropped** (not stored).
- **Numeric fields** (`xp`, `streak`, `recallNailed`): non-negative integers; reject
  `NaN`/negative/non-integer. `xp` additionally clamped to a generous absolute
  sanity bound (e.g. `1_000_000`) purely to stop absurd values, not as a real cap.
- **Rank fields are clamped to content reality:** `items_done` (derived) and
  `streak` clamped to plausible maxima (`streak ≤` days-since-launch + slack;
  `items_done ≤` total lesson/boss count).
- **ID-keyed maps** (`done`, `best`, `perfect`, `badges`): keys must be **known
  IDs** (enumerated from the app content at build/runtime — lesson/`boss-…` IDs
  for `done`/`best`/`perfect`; the fixed `BADGES` list `first, cap, repl, raft,
  streak3, lvl5, recall, flawless, allbosses, lvl10` for `badges`); unknown IDs
  dropped. Values bounded: `best` 0–100; `perfect`/`badges` boolean.
- **Signature-keyed maps** (`answered`, `picks`, `mistakes`): keys are question
  signatures (`sigOf(step)`), not enumerable — validate by **shape + size only**
  (each map ≤ a generous cap, e.g. 5000 entries).
  - `answered` values are small ints; `picks` values are small ints.
  - `mistakes` values are **step objects** (a copy of the missed question). The
    review renderer (`renderReview`, ~line 6331) reads **different fields per
    `step.t`** — e.g. `mcq` needs `q,o,a,why`; `sort` needs `q,items,buckets`;
    `build` needs `q,options,correct,why`; `match` → `q,pairs`; `order` →
    `q,items`; `cloze` → `q,text`; `recall` → `q,model`. A naive field-strip
    would break review rendering, so **do not field-strip**. Instead bound by
    **size + count**: reject if any single mistake object serializes over **4 KB**
    or the map exceeds **5000 entries** (oversize → drop that entry, keep the
    rest). This bounds row size without losing render-critical fields.
  - **Blast radius note:** unlike `username` (cross-user, must be escaped),
    `mistakes` content is rendered **only to its own owner** in their review
    pool, so a tampered local value is self-scoped. The owner-only review UI
    still renders via `innerHTML`; this is unchanged from today's local-only
    behavior and out of scope to re-harden here.
- **Booleans** (`unlockAll`, `flawless`, `answeredSeeded`, `speedPickerOpen`,
  `reviewSkipRecall`): coerced to boolean.
- **Date strings** (`lastDay`): must match `YYYY-MM-DD` or be `null`; else dropped.
- **Array/enum-list fields** (`speedUnits`): must be `null` **or** an array of
  known unit IDs (unknown IDs dropped); any other shape → dropped. `speedN` is a
  small positive int within the app's allowed range.

`username` is **never** taken from the request body — it is read from the
verified JWT on every write (truncated to 32 chars). It is not part of the `S`
merge table; merging it from the client blob would reopen a spoofing/XSS vector.

Scores remain client-computed and thus inherently spoofable; the goal is to
block accidental corruption and obvious tampering (XSS-via-state, giant
payloads, impossible ranks), not to make cheating impossible. Documented as such.

## Client integration (in `distributed_systems_prep_v2.html`)

- **Anonymous path unchanged** — localStorage only, no behavior difference.
- Header gains a **Sign in** button → redirects to
  `https://auth.sophiebi.com/index.html?redirect=<current url>`, returns
  signed-in (SSO cookie present).
- **First sign-in merge** — merge local `S` with server `state` field-by-field
  so no local progress is lost, then `PUT`. **The same merge function runs on
  the server on every write** (see Server-side merge-on-write), so client and
  server use one shared rule table. Complete `S` inventory (verified against the
  `Object.assign` defaults at `distributed_systems_prep_v2.html:404`, the
  lazy-init at 405–409, and the first-assignment sites deep in the scoring/UI
  code for `flawless`/`speedN`/`speedUnits`/`speedPickerOpen`/`reviewSkipRecall`/
  `answeredSeeded`) and its merge rule:

  | key | type | merge rule |
  |---|---|---|
  | `xp` | int | `max` (monotonic) |
  | `streak` + `lastDay` | int + date str | **coupled, latest-day-wins** — NOT independent `max`, see note |
  | `recallNailed` | int | `max` |
  | `done` | map(id→bool) | union (logical OR per key) |
  | `badges` | map(id→bool) | union (derived — see note) |
  | `answered` | map(sig→…) | union (keep both sides' entries) |
  | `picks` | map(sig→int) | union (keep both; on key clash keep existing/server) |
  | `best` | map(id→0–100) | per-key `max` |
  | `perfect` | map(id→bool) | per-key OR |
  | `mistakes` | map(sig→step obj) | **last-write-wins (authoritative replace)** — NOT union, see note |
  | `unlockAll` | bool | OR |
  | `flawless` | bool | OR |
  | `answeredSeeded` | bool | OR |
  | `lastDay` | date str (`YYYY-MM-DD`) | latest — merged **as a pair with `streak`** |
  | `speedN` | int pref | **last-write-wins** (device UI pref, not ranked) |
  | `speedUnits` | array of unit IDs **or `null`** (null = all chapters) | last-write-wins |
  | `speedPickerOpen` | bool pref | last-write-wins |
  | `reviewSkipRecall` | bool pref | last-write-wins |

  Note: `username` is **not** in this table — it is a JWT-derived column set
  server-side on each write, never merged from the client payload.

  - **`badges` is derived, not authoritative.** `checkBadges()` recomputes it
    from `done`/`streak`/`xp`/`recallNailed`/`flawless` on every scoring event,
    so syncing it (union) is harmless but redundant — the client rebuilds badges
    locally regardless. We still store/merge it so the leaderboard/profile can
    show badges without recomputation, but it is never a source of truth.
  - **`streak` is NOT monotonic** and must be merged *coupled with* `lastDay`.
    The app resets `streak` to `1` on open when `lastDay` is not yesterday
    (`distributed_systems_prep_v2.html:416`), so a broken streak *decreases*.
    Merging `streak` by independent `max` would freeze a lapsed streak at its
    all-time peak. Rule: **take the `(streak, lastDay)` pair with the later
    `lastDay`**; if both sides share the same `lastDay`, take the larger
    `streak`. The current streak therefore always reflects the most recent day
    of activity, and the client's on-open recompute (which advances or resets it
    against today's date) stays correct after a sync.
  - **`mistakes` is NOT monotonic.** The app *deletes* a mistake once the user
    masters that question (`distributed_systems_prep_v2.html:6460`:
    `delete S.mistakes[sig]`), so union would resurrect cleared mistakes and they
    could never clear server-side. There are no tombstones in the app. We
    therefore treat the incoming `mistakes` map as **authoritative replace**
    (last-write-wins): the active device's current mistake bank wins.
    **Tradeoff (accepted):** a mistake recorded only on an idle other device can
    be lost on the next write from this device. This is low-stakes — `mistakes`
    is just the review-pool source (used at lines 6057, 6230) — and is preferred
    over cleared mistakes reappearing forever.
  - **`picks` clash rule** is shared by client and server: on a key collision
    keep the existing/server value, so both sides converge to the identical
    result regardless of write order.
  - **Adding a new `S` key is a coordinated change, not a runtime heuristic.**
    The shared inventory (this merge table **and** the validation allow-list) is
    the single authority. Unknown top-level keys are *dropped* at validation
    (they never reach the merge step). When `S` gains a key in the HTML, the same
    change updates both the validation allow-list and this merge table with an
    explicit rule. There is no implicit/heuristic merge for unlisted keys.
- After that, the existing `save()` also **debounce-pushes** (`PUT /api/score`)
  when signed in; localStorage stays as the offline cache and remains the source
  of truth when signed out.
- **Leaderboard panel** (new UI section) lists the top 100 with the user's row
  highlighted; fetched only when signed in. **When signed out**, the panel is
  still visible but shows a "Sign in to see the leaderboard" prompt (it is not
  hidden entirely) — distinct from the DB-failure "leaderboard unavailable"
  state below.
- **Sign out** → call s0phi3 `/api/logout` (credentials include), revert to
  anonymous/local.

## Error handling & edge cases

- **DB unavailable** → API returns `503`; client silently keeps using
  localStorage; the board shows "leaderboard unavailable".
- **Access token expired (15m)** → `PUT`/`GET` returns `401`; client attempts a
  silent refresh via s0phi3 `/api/refresh-token` (credentials include), retries
  once, else treats the user as signed out (local mode).
- **Payload validation** → concrete rules in API §"Validation & anti-cheat"
  (64 KB cap, key allow-list, numeric bounds, ID/shape checks); invalid → `400`.
- **CORS** — own `/api/*` is same-origin (no CORS needed). The cross-origin
  calls to `auth.sophiebi.com` (`logout`, `refresh-token`) are already allowed by
  s0phi3's wildcard `*.sophiebi.com` CORS policy.

## Security

- **Leaderboard rendering is XSS-safe.** `username` is attacker-influenced
  (chosen in s0phi3) and this app renders pervasively via `innerHTML`, so the
  leaderboard panel **must not** interpolate `username` into an HTML string.
  Render names via `textContent` (or a strict HTML-escape of `< > & " '`) and
  cap displayed length. The same applies to any other user-derived value shown.
- **Username is bounded** to 32 chars on store (DB write) *and* defensively
  re-truncated on render, so a long/crafted name can't bloat rows or the UI.
- **No secrets in client code.** The HTML only ever talks to same-origin
  `/api/*` and `auth.sophiebi.com`; `JWT_SECRET`/`DATABASE_URL` live only in
  serverless env, never shipped to the browser.

## Secrets (via keyrotate `secret` tool)

A new keyrotate config `~/.config/keyrotate/systemDesign.json` (alias `sd`),
modeled on `french-quiz.json`, Vercel-only targets:

- **`DATABASE_URL`** (Neon connection string) — `strategy: manual`,
  `targets: ["vercel", "localEnv"]`. Set with
  `secret set sd DATABASE_URL --value '…'` after the Neon DB is created.
- **`JWT_SECRET`** — **not** declared in this project's config. Instead add this
  project to s0phi3's `JWT_SECRET.crossProjectPropagate` list with
  `targets: ["vercel", "localEnv"]`, and include a `_jwt_secret_tombstone` note
  (mirroring french-quiz). Propagate the *current* value without a fleet-wide
  rotation:
  `secret get s0 JWT_SECRET | (read -r V; secret set s0 JWT_SECRET --value "$V")`.
- **`AUTH_BASE_URL`** (`https://auth.sophiebi.com`) — public config, **not** a
  secret. Set directly as a Vercel env / committed default, not via keyrotate.

`.env` stays in `.gitignore`. Add the `sd` alias to keyrotate `_aliases.json`;
commit + push the dotfiles repo.

## Repo structure (new files)

- `package.json` — ESM; deps `@neondatabase/serverless`, `jsonwebtoken`.
- `vercel.json` — `*.html` static + `api/*.js` node functions; `/` → v2 HTML.
- `api/score.js`, `api/leaderboard.js`
- `api/_lib/auth.js` (JWT verify + token extraction)
- `api/_lib/db.js` (Neon client + schema bootstrap/migration)
- `.gitignore` already excludes `.env`.

## Bootstrap order (for the plan)

1. Create/link the Vercel project (gives `projectId`/`orgId`).
2. Create the Neon project/branch; get the connection string.
3. Write `systemDesign.json` keyrotate config + s0phi3 propagation entry + alias;
   commit/push dotfiles.
4. `secret set sd DATABASE_URL …`; propagate `JWT_SECRET` (no-rotate command).
5. `secret pull sd` to populate local `.env`.
6. Implement DB layer, API, client integration; create the table.
7. Deploy; attach `systemdesign.sophiebi.com`.

## Testing

- **Unit** — JWT verify (valid / expired / wrong-issuer / no-issuer),
  field-by-field merge, payload validation + `xp` clamping.
- **Integration** — score upsert + leaderboard ordering against a Neon test
  branch.
- **Manual** — sign-in redirect round-trip, first-sign-in merge, sign-out,
  token-refresh-on-401.

## Out of scope (YAGNI)

- No passwords / OAuth in this repo — identity is delegated to s0phi3.
- No multiple leaderboards or seasons (single all-time board).
- No friends/social features.
- No server-authoritative scoring (XP stays client-computed, clamp-only).
