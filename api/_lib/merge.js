// api/_lib/merge.js

const max = (a, b) => Math.max(a ?? 0, b ?? 0);
const unionTrue = (a = {}, b = {}) => { const o = { ...a }; for (const k of Object.keys(b)) if (b[k]) o[k] = true; return o; };
const perKeyMax = (a = {}, b = {}) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = Math.max(o[k] ?? 0, v ?? 0); return o; };
const perKeyOr = (a = {}, b = {}) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = !!(o[k] || v); return o; };
// Stored (a) wins on key clash — incoming does not override history.
const unionKeep = (a = {}, b = {}) => ({ ...b, ...a });

// incoming = this write's validated state; stored = current row's state (or null)
export function mergeState(incoming, stored) {
  const s = stored || {};
  const i = incoming || {};
  const out = { ...s, ...i }; // start with incoming overriding (covers prefs LWW + bools)

  if ('xp' in i || 'xp' in s) out.xp = max(i.xp, s.xp);
  if ('recallNailed' in i || 'recallNailed' in s) out.recallNailed = max(i.recallNailed, s.recallNailed);

  out.done = unionTrue(s.done, i.done);
  out.badges = unionTrue(s.badges, i.badges);
  out.answered = unionKeep(s.answered, i.answered);
  out.picks = unionKeep(s.picks, i.picks);
  out.best = perKeyMax(s.best, i.best);
  out.perfect = perKeyOr(s.perfect, i.perfect);

  // mistakes: last-write-wins (replace, not union). Shallow-copy the container so
  // the result never aliases the incoming/stored payload (step-object values are
  // never mutated here, so a shallow copy is sufficient isolation).
  out.mistakes = ('mistakes' in i) ? { ...(i.mistakes || {}) } : { ...(s.mistakes || {}) };

  // All three are monotonic booleans (once true, never cleared). If any later
  // needs a different rule, pull it out of this loop.
  for (const k of ['unlockAll', 'flawless', 'answeredSeeded']) {
    if (k in i || k in s) out[k] = !!(i[k] || s[k]);
  }

  const iHas = typeof i.lastDay === 'string';
  const sHas = typeof s.lastDay === 'string';
  if (iHas && sHas) {
    if (i.lastDay > s.lastDay) { out.streak = i.streak ?? 0; out.lastDay = i.lastDay; }
    else if (i.lastDay < s.lastDay) { out.streak = s.streak ?? 0; out.lastDay = s.lastDay; }
    else { out.streak = max(i.streak, s.streak); out.lastDay = i.lastDay; }
  } else if (iHas) { out.streak = i.streak ?? 0; out.lastDay = i.lastDay; }
  else if (sHas) { out.streak = s.streak ?? 0; out.lastDay = s.lastDay; }
  // if neither has lastDay, streak from the spread above stands as-is

  return out;
}

export function deriveColumns(state) {
  const done = state.done || {};
  return {
    xp: Math.trunc(state.xp || 0),
    items_done: Object.values(done).filter(Boolean).length,
    streak: Math.trunc(state.streak || 0),
    last_day: typeof state.lastDay === 'string' ? state.lastDay : null,
  };
}
