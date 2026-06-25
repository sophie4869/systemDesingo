// scripts/extract-content-ids.mjs
// Extracts known lesson/boss/badge IDs from distributed_systems_prep_v2.html
// for use as server-side allow-lists in the scores/leaderboard API.
//
// Deviation from skeleton: the skeleton used vm.runInNewContext to eval the
// extracted array literals. This is not viable here because:
//   1. UNITS contains `setup:function(root){...}` entries that reference DOM
//      globals (document, etc.) — they fail even in a sandboxed vm context.
//   2. BADGES contains arrow functions referencing `levelOf` and `UNITS`, which
//      are not available in a throwaway vm context.
//
// Both arrays DO have reliable `];` terminators at the top level (confirmed by
// inspection: only 4 such lines in the whole file, each closing a distinct
// const declaration). We therefore use line-based slicing to isolate each array
// and then extract IDs with targeted regex patterns rather than full eval:
//   - Unit IDs:   lines starting with `{` at indent 0, followed by `id:'...`
//   - Lesson IDs: lines starting with `{id:'...`,title:` at indent 2
//   - Badge IDs:  `{id:'...'` inside the BADGES block
//
// This approach is simple, deterministic, and immune to JS syntax inside
// the arrays (function bodies, arrow functions, template literals, etc.).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, '..', 'distributed_systems_prep_v2.html');
const outPath = path.join(__dirname, '..', 'api', '_lib', 'content-ids.json');

const html = readFileSync(htmlPath, 'utf8');
const lines = html.split('\n');

/**
 * Find the line index (0-based) where a top-level `];` closes the named const array.
 * Strategy: find the declaration line, then scan forward for the first line that is
 * exactly `];` (no leading whitespace). Top-level const array terminators in this
 * file have zero leading whitespace; nested `];` inside function bodies have
 * 4-6 spaces of indent, so an exact-string match reliably distinguishes them.
 */
function findArrayBounds(declPrefix) {
  const startIdx = lines.findIndex(l => l.trimStart().startsWith(declPrefix));
  if (startIdx < 0) throw new Error('Declaration not found: ' + declPrefix);
  let endIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i] === '];') { endIdx = i; break; }
  }
  if (endIdx < 0) throw new Error('Closing ]; not found after: ' + declPrefix);
  return { startIdx, endIdx };
}

// ── UNITS (lines 429-5846 in the source) ────────────────────────────────────
const unitsBounds = findArrayBounds('const UNITS=');
const unitsSrc = lines.slice(unitsBounds.startIdx, unitsBounds.endIdx + 1).join('\n');

// Unit IDs: objects at the top level of the array start with `{` on its own line
// (indent 0 or 1 space) followed immediately by `id:'xxx',title:` on the next
// line. The `^\{?\n? id:'` pattern captures them.
// Confirmed: 24 units matching this pattern.
const unitIds = [...unitsSrc.matchAll(/^\{[\s\n]*id:["']([^"']+)["'],title:/gm)]
  .filter(m => m[1]) // top-level matches have empty indent prefix
  .map(m => m[1]);

// Lesson IDs: `{id:'xxx',title:` indented inside `lessons:[...]`
// We distinguish lessons from units by requiring at least one leading space/tab.
// The outer `{id:'xxx',title:` with indent 0 are unit boundaries (already captured above).
// Tolerates any mix of spaces/tabs and both quote styles to be robust to formatting variance.
const lessonIds = [...unitsSrc.matchAll(/^[ \t]+\{id:["']([^"']+)["'],title:/gm)].map(m => m[1]);

if (unitIds.length === 0) throw new Error('No unit IDs found — check extraction regex');
if (lessonIds.length === 0) throw new Error('No lesson IDs found — check extraction regex');

// ── BADGES (lines 5972-5983 in the source) ───────────────────────────────────
const badgesBounds = findArrayBounds('const BADGES=');
const badgesSrc = lines.slice(badgesBounds.startIdx, badgesBounds.endIdx + 1).join('\n');

// Badge IDs: each badge object starts with `{id:'xxx',`
const badgeIds = [...badgesSrc.matchAll(/\{id:'([^']+)'/g)].map(m => m[1]);

if (badgeIds.length === 0) throw new Error('No badge IDs found — check extraction regex');

// ── Assemble boss IDs ────────────────────────────────────────────────────────
// Boss done-keys are 'boss-' + unit.id (confirmed by `S.done['boss-'+u.id]` sites)
const bossIds = unitIds.map(id => 'boss-' + id);

// ── Output ───────────────────────────────────────────────────────────────────
const out = {
  doneIds: [...new Set([...lessonIds, ...bossIds])].sort(),
  unitIds: [...new Set(unitIds)].sort(),
  badgeIds: [...new Set(badgeIds)].sort(),
  generatedFrom: 'distributed_systems_prep_v2.html'
};

writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`done=${out.doneIds.length} units=${out.unitIds.length} badges=${out.badgeIds.length}`);
