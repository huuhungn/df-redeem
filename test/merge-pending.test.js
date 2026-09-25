#!/usr/bin/env node
/* test/merge-pending.test.js — end-to-end proof of the sync loop:
 * clients submit → Worker promotes → merge script folds rows into data/codes.json
 * → rows are acked so the next run is a no-op.
 *
 * Runs against a real `wrangler dev` and a real (temporary) copy of the data file.
 */
'use strict';
const { spawn, execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKER_DIR = path.join(ROOT, 'worker');
const CODES_FILE = path.join(ROOT, 'data', 'codes.json');
const BACKUP = CODES_FILE + '.testbak';
const PORT = 8898;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'merge-test-token-not-a-real-secret';

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
  if (condition) { passed += 1; console.log(`ok   ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const submit = (code, errCode, ip) =>
  fetch(BASE + '/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ code, err_code: errCode }),
  }).then((r) => r.json());

const runMerge = (extraArgs) =>
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'merge-pending.js'), ...(extraArgs || [])], {
    cwd: ROOT,
    env: { ...process.env, VAULT_URL: BASE, VAULT_ADMIN_TOKEN: ADMIN },
    encoding: 'utf8',
  });

const readDoc = () => JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));

async function waitForReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE + '/health')).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

(async function main() {
  fs.copyFileSync(CODES_FILE, BACKUP);
  const before = readDoc();

  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--local', '--var', `ADMIN_TOKEN:${ADMIN}`, '--var', 'IP_SALT:merge-salt'],
    { cwd: WORKER_DIR, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
  );
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  const stop = () => {
    try {
      if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch { /* gone */ }
  };
  const restore = () => {
    fs.copyFileSync(BACKUP, CODES_FILE);
    fs.unlinkSync(BACKUP);
  };

  if (!(await waitForReady(90000))) {
    console.log('FAIL wrangler dev never became ready');
    console.log(log.slice(-2000));
    stop(); restore();
    process.exit(1);
  }

  try {
    /* A brand-new code, confirmed by two clients, must reach the file. */
    const fresh = 'DFNEW' + Date.now().toString(36).toUpperCase().slice(-7);
    await submit(fresh, 0, '10.1.0.1');
    await submit(fresh, 0, '10.1.0.2');

    /* A single-client report must NOT reach the file. */
    const lonely = 'DFLONE' + Date.now().toString(36).toUpperCase().slice(-6);
    await submit(lonely, 0, '10.1.0.3');

    const dry = runMerge(['--dry-run']);
    check('dry run reports the new code', dry.includes(fresh), dry.trim().split('\n').slice(-3).join(' | '));
    check('dry run writes nothing', readDoc().codes.length === before.codes.length);

    const out = runMerge();
    check('merge reports a change', out.includes('CHANGED=true'), out.trim().split('\n').slice(-2).join(' | '));

    const afterDoc = readDoc();
    const added = afterDoc.codes.find((r) => r.code === fresh);
    check('the confirmed code is now in data/codes.json', !!added, fresh);
    check('the added code carries the community verdict', added && added.status === 'success' && added.confirmations >= 2,
      JSON.stringify(added));
    check('an under-confirmed code stays out', !afterDoc.codes.some((r) => r.code === lonely), lonely);
    check('counts were recomputed', afterDoc.counts && afterDoc.counts.success >= (before.counts.success || 0) + 1,
      JSON.stringify(afterDoc.counts));
    check('no existing code was dropped', afterDoc.codes.length === before.codes.length + 1,
      `${before.codes.length} → ${afterDoc.codes.length}`);

    /* Rows were acked, so a second run must be a clean no-op. */
    const second = runMerge();
    check('a second run is a no-op', second.includes('CHANGED=false'), second.trim().split('\n').slice(-2).join(' | '));

    /* A verdict change from enough clients updates an existing row. */
    const target = afterDoc.codes.find((r) => r.status === 'success' && r.code !== fresh);
    await submit(target.code, 400073, '10.2.0.1');
    await submit(target.code, 400073, '10.2.0.2');
    runMerge();
    const flipped = readDoc().codes.find((r) => r.code === target.code);
    check('a community-confirmed verdict change updates the row', flipped && flipped.status === 'gift_bug',
      JSON.stringify(flipped));

    /* An account-specific verdict must never appear in public data. */
    const personal = 'DFMINE' + Date.now().toString(36).toUpperCase().slice(-6);
    await submit(personal, 400067, '10.3.0.1');
    await submit(personal, 400067, '10.3.0.2');
    runMerge();
    const finalDoc = readDoc();
    check('an account-specific verdict never lands in public data',
      !finalDoc.codes.some((r) => r.code === personal), personal);
    check('public data never carries the per-account error code',
      !finalDoc.codes.some((r) => r.err_code === 400067));
  } catch (error) {
    failed += 1;
    console.log('FAIL harness threw — ' + (error && (error.stdout || error.message)));
  } finally {
    stop();
    restore();
    console.log('restored data/codes.json');
  }

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed === 0 ? 0 : 1);
}());
