// api/leaderboard.js
import { getUser } from './_lib/auth.js';
import { send } from './_lib/http.js';
import { leaderboard } from './_lib/db.js';

// In-memory cache of the shared top-100 (identical for every viewer, changes
// slowly). Warm function instances serve it with ZERO DB queries; it refreshes
// at most once per TTL. Auth is still enforced per-request (JWT verify, no DB).
// Per-user standing is derived client-side from this list (find self by
// username), so a normal request makes no per-user DB query at all.
let _topCache = null, _topAt = 0;
const TOP_TTL_MS = 30_000;

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' });
  const user = getUser(req);
  if (!user) return send(res, 401, { message: 'Sign in to view the leaderboard' });
  try {
    const now = Date.now();
    if (!_topCache || now - _topAt > TOP_TTL_MS) {
      _topCache = await leaderboard(100);
      _topAt = now;
    }
    return send(res, 200, { top: _topCache });
  } catch (e) {
    console.error('[leaderboard]', e);
    return send(res, 503, { message: 'Leaderboard unavailable' });
  }
}
