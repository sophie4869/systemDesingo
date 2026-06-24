// api/_lib/validate.js
import ids from './content-ids.json' with { type: 'json' };

const DONE_IDS = new Set(ids.doneIds);
const UNIT_IDS = new Set(ids.unitIds);
const BADGE_IDS = new Set(ids.badgeIds);

const XP_MAX = 1_000_000;
const MAP_MAX = 5000;
const MISTAKE_OBJ_MAX_BYTES = 4 * 1024;
const STREAK_MAX = 100_000;
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
    if (s.length > MISTAKE_OBJ_MAX_BYTES) return undefined;
    return v;
  });

  for (const k of ['unlockAll', 'flawless', 'answeredSeeded', 'speedPickerOpen', 'reviewSkipRecall']) {
    if (k in raw) out[k] = asBool(raw[k]);
  }

  if ('lastDay' in raw) {
    if (raw.lastDay === null) out.lastDay = null;
    else if (isUtcDateNotFuture(raw.lastDay)) out.lastDay = raw.lastDay;
  }
  if ('speedN' in raw) { const n = intIn(raw.speedN, 1, 1000); if (n !== undefined) out.speedN = n; }
  if ('speedUnits' in raw) {
    if (raw.speedUnits === null) out.speedUnits = null;
    else if (Array.isArray(raw.speedUnits)) out.speedUnits = raw.speedUnits.filter(u => unitIds.has(u));
  }
  return out;
}
