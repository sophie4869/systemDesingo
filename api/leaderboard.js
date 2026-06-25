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
