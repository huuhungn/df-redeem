/* audit-css.js — find class names used in markup that no stylesheet defines.
 *
 * A class with no rule is an invisible bug: the element renders with browser
 * defaults, which on a dark theme usually means white-on-white. Cheaper to
 * catch here than by eyeballing screenshots.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const EXT = process.argv[2] || path.join(__dirname, '..', 'extension');

/* Classes defined by any stylesheet shipped in the build. */
const defined = new Set();
const harvest = (css) => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) defined.add(m[1]);
};
for (const f of ['theme.css', 'styles.css', 'app.css']) {
  const p = path.join(EXT, f);
  if (fs.existsSync(p)) harvest(fs.readFileSync(p, 'utf8'));
}
/* Inline <style> blocks in the HTML surfaces count too. */
for (const f of fs.readdirSync(EXT).filter((x) => x.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(EXT, f), 'utf8');
  for (const blk of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) harvest(blk[1]);
}
/* The drawer's stylesheet is inlined into the bundles as a JS template string
 * (DF_THEME_CSS / DF_PANEL_CSS), so parse those too or every drawer class
 * looks unstyled. */
for (const f of fs.readdirSync(EXT).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(EXT, f), 'utf8');
  /* Two embedding shapes are in use: a template literal and a JSON string
   * literal (build.js uses JSON.stringify for the bundles). Handle both. */
  for (const m of src.matchAll(/(?:DF_THEME_CSS|DF_PANEL_CSS)\s*=\s*`([\s\S]*?)`;/g)) harvest(m[1]);
  for (const m of src.matchAll(/(?:DF_THEME_CSS|DF_PANEL_CSS)\s*=\s*("(?:\\.|[^"\\])*");/g)) {
    try { harvest(JSON.parse(m[1])); } catch { /* not valid JSON: skip */ }
  }
}

/* Classes used anywhere in markup or in JS string templates. */
const used = new Map();
const note = (cls, file) => {
  if (!used.has(cls)) used.set(cls, new Set());
  used.get(cls).add(file);
};
for (const f of fs.readdirSync(EXT).filter((x) => /\.(html|js)$/.test(x))) {
  const src = fs.readFileSync(path.join(EXT, f), 'utf8');
  for (const m of src.matchAll(/class\s*=\s*["'`]([^"'`]{1,200})["'`]/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !c.includes('$') && !c.includes('{')) note(c, f);
  }
  for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*['"]([\w-]+)['"]/g)) note(m[1], f);
  for (const m of src.matchAll(/className\s*=\s*['"]([^'"]{1,120})['"]/g)) {
    for (const c of m[1].split(/\s+/)) if (c) note(c, f);
  }
}

/* Hooks that exist for JS lookup only, or class-name prefixes built at
 * runtime (`'st-' + status`). They inherit their styling from an ancestor rule,
 * so a missing rule of their own is not a bug. */
const JS_HOOKS = new Set(['pace', 'retries', 'variants', 'st-']);

const missing = [...used.keys()]
  .filter((c) => /^[a-z][\w-]*$/i.test(c))   /* real class names only */
  .filter((c) => !defined.has(c) && !JS_HOOKS.has(c))
  .sort();
if (!missing.length) { console.log(`ok — all ${used.size} markup classes have styles (${defined.size} defined)`); process.exit(0); }
console.log(`${missing.length} unstyled class(es) of ${used.size} used:\n`);
for (const c of missing) console.log('  .' + c.padEnd(22) + ' used in ' + [...used.get(c)].join(', '));
process.exit(1);
