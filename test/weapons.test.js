/* Weapon resolution for Gunsmith preset grouping.
 *
 * The point of the catalogue is that submitted `weapon` strings are dirty, so
 * these tests are written against the exact dirt found in data/presets.json
 * plus the shapes that dirt generalises to. */
'use strict';

const { classifyPreset, resolveWeapon, WEAPONS, WEAPON_CLASSES, normWeapon } = require('../src/core/weapons.js');

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`not ok ${name}`);
    if (detail) console.log(`  ${detail}`);
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ── catalogue integrity ─────────────────────────────────────────────────── */

ok('catalogue is populated', WEAPONS.length >= 60, `only ${WEAPONS.length} weapons`);

const dupes = [];
const seen = new Set();
for (const w of WEAPONS) {
  const k = normWeapon(w.name);
  if (seen.has(k)) dupes.push(w.name);
  seen.add(k);
}
ok('no duplicate weapon names', dupes.length === 0, `duplicates: ${dupes.join(', ')}`);

const classIds = new Set(WEAPON_CLASSES.map((c) => c.id));
const orphans = WEAPONS.filter((w) => !classIds.has(w.cls)).map((w) => w.name);
ok('every weapon has a declared class', orphans.length === 0, `orphans: ${orphans.join(', ')}`);

/* Every class must carry a Vietnamese label: the panel groups by it, and an
 * empty one would render a headerless section. */
const unlabelled = WEAPON_CLASSES.filter((c) => !c.label || !c.label.trim()).map((c) => c.id);
ok('every class has a label', unlabelled.length === 0, `unlabelled: ${unlabelled.join(', ')}`);

/* ── exact matches ───────────────────────────────────────────────────────── */

eq('exact catalogue name resolves', resolveWeapon('AKM Assault Rifle').name, 'AKM Assault Rifle');
eq('bare model name resolves', resolveWeapon('AKM').name, 'AKM Assault Rifle');
eq('case is ignored', resolveWeapon('akm assault rifle').name, 'AKM Assault Rifle');
eq('punctuation is ignored', resolveWeapon('AKS74').name, 'AKS-74 Assault Rifle');
eq('alias resolves', resolveWeapon('Deagle').name, 'Desert Eagle');

/* ── the dirt actually present in data/presets.json ──────────────────────── */

/* A Reddit author's handle glued to the front of the gun name. Grouping on the
 * raw string put each of these in its own bucket. */
eq('author handle prefix is stripped',
  resolveWeapon('Upstairs-Pirate-9890 AKS-74 Assault Rifle').name, 'AKS-74 Assault Rifle');
eq('short handle prefix is stripped',
  resolveWeapon('EasyB AS Val Assault Rifle').name, 'AS Val Assault Rifle');

/* The VN client's Vietnamese name for a gun the wiki lists in English. */
eq('Vietnamese weapon name resolves', resolveWeapon('Súng Trường Xạ Thủ SVCH').name, 'SVCH Marksman Rifle');
eq('Vietnamese name without diacritics resolves',
  resolveWeapon('Sung Truong Xa Thu SVCH').name, 'SVCH Marksman Rifle');

/* Submitted as "MK47 Assault Rifle"; the catalogue class is Battle Rifle. The
 * canonical name must win so the preset lands in the right section. */
eq('misfiled class is corrected', classifyPreset({ weapon: 'MK47 Assault Rifle' }).weapon, 'MK47 Battle Rifle');
eq('misfiled class lands in the right section', classifyPreset({ weapon: 'MK47 Assault Rifle' }).cls, 'br');

/* ── unresolvable input ──────────────────────────────────────────────────── */

/* Tay Đen has been verified as the community label for a Thompson build. Keep
 * the alias to make older imported rows resolve, while preserving it in the
 * display label of the seed row so users can recognize their build. */
const tayDen = classifyPreset({ weapon: 'Tay Đen' });
eq('Tay Đen resolves to the Thompson class', tayDen.cls, 'smg');
eq('Tay Đen resolves to Thompson Submachine Gun', tayDen.weapon, 'Thompson Submachine Gun');
eq('Tay Đen keeps its submitted text as raw evidence', tayDen.raw, 'Tay Đen');
eq('Tay Đen has a canonical name', tayDen.canonical, 'Thompson Submachine Gun');

const blank = classifyPreset({ weapon: '' });
eq('empty weapon goes to the unknown bucket', blank.cls, 'unknown');
eq('empty weapon renders a dash', blank.weapon, '—');
ok('missing weapon field does not throw', classifyPreset({}).cls === 'unknown');
ok('null preset does not throw', classifyPreset(null).cls === 'unknown');

/* A string that merely contains a short substring of a weapon name must not
 * match: two letters of overlap is noise, not a weapon. */
ok('short noise does not match', resolveWeapon('xx') === null, `got ${JSON.stringify(resolveWeapon('xx'))}`);

/* ── raw is only surfaced when it adds information ───────────────────────── */

eq('clean input reports no raw override', classifyPreset({ weapon: 'AKM Assault Rifle' }).raw, '');
eq('dirty input reports the raw string',
  classifyPreset({ weapon: 'EasyB AS Val Assault Rifle' }).raw, 'EasyB AS Val Assault Rifle');

/* ── the live preset file must group sanely ──────────────────────────────── */

const live = require('../data/presets.json');
const buckets = new Map();
for (const p of live.presets) {
  const c = classifyPreset(p);
  buckets.set(c.clsLabel, (buckets.get(c.clsLabel) || 0) + 1);
}
/* Grouping on the raw string produced 18 buckets for 20 presets. The whole
 * point is that the resolved grouping is meaningfully coarser. */
ok('live presets collapse into few classes', buckets.size <= 8,
  `got ${buckets.size} buckets: ${[...buckets.keys()].join(', ')}`);

const unknownCount = [...live.presets].filter((p) => classifyPreset(p).cls === 'unknown').length;
ok('at most one live preset is unclassified', unknownCount <= 1, `${unknownCount} unclassified`);

/* The `gun` field is the older name for `weapon`; both must work since stored
 * vault rows may predate the rename. */
eq('legacy gun field is honoured', classifyPreset({ gun: 'MP5' }).weapon, 'MP5 Submachine Gun');

console.log(`${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
