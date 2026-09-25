#!/usr/bin/env node
/* test/preset-path.test.js — the human-gated preset path, including hostile input.
 *
 * An issue body is written by anyone on the internet and then flows into
 * $GITHUB_OUTPUT and a shell command line, so these tests care as much about
 * injection as about happy-path parsing.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRESETS = path.join(ROOT, 'data', 'presets.json');
const BACKUP = PRESETS + '.testbak';

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
  if (condition) { passed += 1; console.log(`ok   ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const parse = (body) => {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'parse-preset-issue.js')], {
      env: { ...process.env, BODY: body },
      encoding: 'utf8',
    });
    const fields = {};
    for (const line of out.trim().split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return { ok: true, fields, raw: out };
  } catch (error) {
    return { ok: false, error: error.stderr || error.message };
  }
};

const addPreset = (args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(ROOT, 'tools', 'add-preset.js'), ...args], { cwd: ROOT, encoding: 'utf8' }) };
  } catch (error) {
    return { ok: false, out: String(error.stdout || '') + String(error.stderr || '') };
  }
};

const readPresets = () => JSON.parse(fs.readFileSync(PRESETS, 'utf8')).presets;

const goodBody = `### Preset code

6KTESTABC123XYZ0099

### Weapon

AUG Assault Rifle

### Game mode

Havoc Warfare

### Credit (optional)

@somehandle

### Before submitting

- [X] I tested this code in-game and it imported a working build.
`;

/* A previous run that was killed before its `finally` leaves both a stale backup
 * and a dirty data file. Backing the dirty file up again would bake the test rows
 * into the repo permanently, so recover from the stale backup first. */
if (fs.existsSync(BACKUP)) {
  fs.copyFileSync(BACKUP, PRESETS);
  fs.unlinkSync(BACKUP);
  console.log('recovered data/presets.json from a stale backup of an interrupted run');
}
fs.copyFileSync(PRESETS, BACKUP);
const before = readPresets().length;

try {
  /* ---- parsing --------------------------------------------------------- */
  const good = parse(goodBody);
  check('a well-formed issue parses', good.ok && good.fields.code === '6KTESTABC123XYZ0099', JSON.stringify(good.fields || good.error));
  check('weapon is captured', good.ok && good.fields.weapon === 'AUG Assault Rifle', good.ok && good.fields.weapon);
  check('mode is captured', good.ok && good.fields.mode === 'Havoc Warfare', good.ok && good.fields.mode);
  check('credit is captured', good.ok && good.fields.credit === '@somehandle', good.ok && good.fields.credit);

  const noCredit = parse(goodBody.replace('@somehandle', '_No response_'));
  check('a skipped optional field becomes empty', noCredit.ok && noCredit.fields.credit === '', JSON.stringify(noCredit.fields));

  const missing = parse('### Weapon\n\nAUG\n');
  check('an issue with no code fails', !missing.ok);

  /* ---- output injection ------------------------------------------------ */
  const injected = parse(goodBody.replace('AUG Assault Rifle', 'AUG\ncredit=@attacker\nmalicious=1'));
  check('a newline in a field cannot forge extra outputs',
    injected.ok && injected.fields.credit === '@somehandle' && injected.fields.malicious === undefined,
    JSON.stringify(injected.fields));
  check('parser output stays one line per field',
    injected.ok && injected.raw.trim().split('\n').length === 4, injected.ok && injected.raw);

  /* ---- add-preset validation ------------------------------------------- */
  const shortCode = addPreset(['--code', 'ABC', '--weapon', 'AUG']);
  check('a too-short code is rejected', !shortCode.ok, shortCode.out.trim().slice(0, 90));

  const noWeapon = addPreset(['--code', '6KVALIDCODE123456', '--weapon', '']);
  check('a missing weapon is rejected', !noWeapon.ok, noWeapon.out.trim().slice(0, 90));

  const emailCredit = addPreset(['--code', '6KEMAILTEST1234567', '--weapon', 'AUG', '--credit', 'someone@example.com']);
  check('an email in credit is refused', !emailCredit.ok, emailCredit.out.trim().slice(0, 120));

  const markupCredit = addPreset(['--code', '6KMARKUP12345678', '--weapon', 'M4A1', '--credit', '<img src=x onerror=alert(1)>']);
  check('markup in credit is not published', markupCredit.ok, markupCredit.out.trim().slice(0, 120));
  const markupRow = readPresets().find((r) => r.code === '6KMARKUP12345678');
  check('the markup credit became anonymous', markupRow && markupRow.author === 'anonymous', JSON.stringify(markupRow));

  /* ---- happy path ------------------------------------------------------ */
  const added = addPreset(['--code', '6KTESTABC123XYZ0099', '--weapon', 'AUG Assault Rifle', '--mode', 'Havoc Warfare', '--credit', '@somehandle']);
  check('a valid preset is added', added.ok && added.out.includes('CHANGED=true'), added.out.trim().slice(0, 120));
  const row = readPresets().find((r) => r.code === '6KTESTABC123XYZ0099');
  check('the added preset is marked verified', row && row.verified === true, JSON.stringify(row));
  check('the credit survived', row && row.author === '@somehandle', JSON.stringify(row));

  const again = addPreset(['--code', '6KTESTABC123XYZ0099', '--weapon', 'AUG Assault Rifle']);
  check('a duplicate approval is a clean no-op', again.ok && again.out.includes('CHANGED=false'), again.out.trim().slice(0, 120));

  check('no preset was lost', readPresets().length === before + 2, `${before} → ${readPresets().length}`);

  /* ---- the validator still accepts the result -------------------------- */
  let validatorOk = true;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'validate-data.js')], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    validatorOk = false;
  }
  check('data still validates after the additions', validatorOk);
} finally {
  fs.copyFileSync(BACKUP, PRESETS);
  fs.unlinkSync(BACKUP);
  console.log('restored data/presets.json');
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
