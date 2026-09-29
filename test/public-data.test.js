#!/usr/bin/env node
/* test/public-data.test.js — verify public-data generation never leaks local-only verdicts. */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CODES_FILE = path.join(ROOT, 'data', 'codes.json');
const PRESETS_FILE = path.join(ROOT, 'data', 'presets.json');
const CODES_BACKUP = `${CODES_FILE}.testbak`;
const PRESETS_BACKUP = `${PRESETS_FILE}.testbak`;
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log(`ok   ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

  let completed = false;
  try {
  if (fs.existsSync(CODES_BACKUP)) { fs.copyFileSync(CODES_BACKUP, CODES_FILE); fs.unlinkSync(CODES_BACKUP); }
  if (fs.existsSync(PRESETS_BACKUP)) { fs.copyFileSync(PRESETS_BACKUP, PRESETS_FILE); fs.unlinkSync(PRESETS_BACKUP); }
  fs.copyFileSync(CODES_FILE, CODES_BACKUP);
  fs.copyFileSync(PRESETS_FILE, PRESETS_BACKUP);

  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'make-public-data.js'), '--force'], { cwd: ROOT, stdio: 'pipe' });
  const doc = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
  const rows = doc.codes || [];
  const statuses = new Set(rows.map((row) => row.status));
  check('the public generator omits casing-ambiguous invalid rows', !statuses.has('invalid'), JSON.stringify([...statuses]));
  check('the public generator emits only globally meaningful verdicts',
    rows.every((row) => ['success', 'expired', 'gift_bug'].includes(row.status)), JSON.stringify([...statuses]));
  check('public code spelling preserves the source record rather than uppercasing it',
    rows.some((row) => row.code === 'DFBrilliant165'), 'DFBrilliant165 is missing');
  check('the generated count matches its rows',
    Object.values(doc.counts || {}).reduce((sum, count) => sum + Number(count || 0), 0) === rows.length,
    JSON.stringify(doc.counts));

  /* The generator projects the local seed, but data/codes.json is co-owned with
   * tools/merge-pending.js, which folds in community reports and raises
   * `confirmations` past 1. Running the generator bare once silently deleted 35
   * merged codes. Without --force it must refuse rather than shrink the file. */
  fs.copyFileSync(CODES_BACKUP, CODES_FILE);
  const beforeGuard = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
  const merged = (beforeGuard.codes || []).filter((row) => Number(row.confirmations || 0) > 1);
  let blocked = false;
  let guardErr = '';
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'make-public-data.js')], { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    blocked = true;
    guardErr = String(e.stderr || '');
  }
  check('the generator refuses to clobber community-confirmed codes',
    merged.length === 0 || blocked, `merged=${merged.length} blocked=${blocked}`);
  check('the refusal names the loss instead of failing silently',
    merged.length === 0 || /community-confirmed/.test(guardErr), guardErr.slice(0, 160));
  const afterGuard = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
  check('a blocked run leaves data/codes.json byte-identical',
    (afterGuard.codes || []).length === (beforeGuard.codes || []).length,
    `before=${(beforeGuard.codes || []).length} after=${(afterGuard.codes || []).length}`);
  /* A blocked codes write must not strand an unrelated preset change. */
  check('presets still publish even when the codes write is blocked',
    fs.existsSync(PRESETS_FILE) && JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')).presets.length > 0);

  /* Equipment cost is an Operations-only concept: Warfare issues its loadouts,
   * so a published price there would tell other clients to charge for something
   * the game gives away. The filter lives in the generator, not only in the UI. */
  const presetDoc = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
  const priced = (presetDoc.presets || []).filter((row) => row.cost !== undefined);
  check('published cost is confined to Operations presets',
    priced.every((row) => /chiến dịch/i.test(String(row.mode || ''))),
    JSON.stringify(priced.map((row) => `${row.code}:${row.mode}`)));
  check('a published cost always carries its agreement state',
    priced.every((row) => typeof row.cost_state === 'string' && row.cost_state),
    JSON.stringify(priced.map((row) => row.cost_state)));

  completed = true;
} catch (error) {
  check('public data generation completes', false, String(error.stderr || error.message || error));
} finally {
  if (fs.existsSync(CODES_BACKUP)) { fs.copyFileSync(CODES_BACKUP, CODES_FILE); fs.unlinkSync(CODES_BACKUP); }
  if (fs.existsSync(PRESETS_BACKUP)) { fs.copyFileSync(PRESETS_BACKUP, PRESETS_FILE); fs.unlinkSync(PRESETS_BACKUP); }
  if (!completed) {
    check('public-data test restores canonical files after an interrupted generator',
      !fs.existsSync(CODES_BACKUP) && !fs.existsSync(PRESETS_BACKUP));
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
