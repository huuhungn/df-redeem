#!/usr/bin/env node
/* tools/add-preset.js — append one reviewed preset to data/presets.json.
 *
 * Called by .github/workflows/approve-preset.yml after a maintainer labels an
 * issue `approved`. Kept separate from merge-pending.js because presets are a
 * human-gated path: nothing here trusts the submitter's formatting.
 *
 * Usage: node tools/add-preset.js --code X --weapon Y --mode Z [--credit @who]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/[\\/]tools$/, '');
const FILE = path.join(ROOT, 'data', 'presets.json');

function arg(name) {
  const index = process.argv.indexOf('--' + name);
  return index === -1 ? '' : String(process.argv[index + 1] || '');
}

function fail(message) {
  console.error('add-preset: ' + message);
  process.exit(1);
}

/* Issue bodies arrive as free text, so every field is scrubbed: control chars and
 * newlines out, length capped, and the code reduced to the character class the
 * game actually uses. This is what stops a crafted issue title from injecting
 * markup or breaking the JSON for every client. */
const clean = (value, max) =>
  String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const code = clean(arg('code'), 40).toUpperCase().replace(/[^A-Z0-9]/g, '');
const weapon = clean(arg('weapon'), 60);
const mode = clean(arg('mode'), 40);
let credit = clean(arg('credit'), 40);

if (!/^[A-Z0-9]{10,40}$/.test(code)) fail(`code must be 10-40 chars A-Z0-9, got ${JSON.stringify(code)}`);
if (!weapon) fail('weapon is required');

/* Credit is published, so it must be a handle and never an address. */
if (/@[^\s]+\.[a-z]{2,}/i.test(credit)) fail('credit looks like an email address; refusing to publish it');
if (credit && !/^[@\w][\w.\-/]{0,38}$/.test(credit.replace(/^\/?u\//, '@'))) {
  console.log(`add-preset: credit ${JSON.stringify(credit)} is not a plain handle — publishing as anonymous`);
  credit = '';
}

const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const presets = Array.isArray(doc.presets) ? doc.presets : [];

if (presets.some((row) => String(row.code).toUpperCase() === code)) {
  /* Not an error: a duplicate approval should close cleanly, not fail the run. */
  console.log(`add-preset: ${code} already present, nothing to do`);
  console.log('CHANGED=false');
  process.exit(0);
}

presets.push({
  code,
  weapon,
  mode: mode || 'Other',
  author: credit || 'anonymous',
  /* "verified" means a maintainer approved it, which is exactly what this path is. */
  verified: true,
});
presets.sort((a, b) => String(a.weapon).localeCompare(String(b.weapon)) || String(a.code).localeCompare(String(b.code)));

doc.presets = presets;
doc.updated_at = new Date().toISOString();
fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');

console.log(`add-preset: added ${code} (${weapon}) — ${presets.length} presets total`);
console.log('CHANGED=true');
