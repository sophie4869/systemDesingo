// api/leaderboard.js
import { getUser } from './_lib/auth.js';
import { send } from './_lib/http.js';
import { leaderboard, getRow, rankOf } from './_lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { message: 'Method not allowed' });
  const user = getUser(req);
  if (!user) return send(res, 401, { message: 'Sign in to view the leaderboard' });
  try {
    // Run the three independent reads concurrently (one round-trip's latency
    // instead of three sequential ones). No ensureSchema on the read path —
    // the table already exists; only writes (api/score.js) bootstrap it.
    const [top, row, rank] = await Promise.all([
      leaderboard(100),
      getRow(user.userId),
      rankOf(user.userId),
    ]);
    const currentUser = row
      ? { username: user.username, xp: row.xp, items_done: row.items_done, rank }
      : null;
    return send(res, 200, { top, currentUser });
  } catch (e) {
    console.error('[leaderboard]', e);
    return send(res, 503, { message: 'Leaderboard unavailable' });
  }
}
