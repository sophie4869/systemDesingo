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
      // Accept both {state:{…}} (what the client sends) and a bare state object.
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
