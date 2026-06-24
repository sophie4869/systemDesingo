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

export async function rankOf(userId) {
  const rows = await sql()`
    WITH me AS (
      SELECT xp, items_done,
             (CASE WHEN last_day >= (now() AT TIME ZONE 'UTC')::date - 1
                   THEN streak ELSE 0 END) AS es,
             updated_at, user_id
      FROM scores WHERE user_id = ${userId}
    )
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM me) THEN NULL
                ELSE (
                  SELECT 1 + count(*)
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
                         AND s.user_id < me.user_id)
                )
           END AS rank`;
  return rows[0]?.rank ?? null;
}
