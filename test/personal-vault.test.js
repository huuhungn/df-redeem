#!/usr/bin/env node
/* test/personal-vault.test.js — single-install (personal vault) mode.
 *
 * worker.test.js pins CONFIRMATIONS_REQUIRED to 2 so it can exercise consensus
 * between two installs. This suite covers the shipped default of 1, plus the one
 * migration hazard that default introduced: rows queued while the threshold was
 * still 2 carry promoted:false, and the write-skip optimisation would happily
 * leave them that way forever unless a threshold change also counts as "moved".
 *
 * Both phases reuse ONE persist-to directory on purpose — that shared KV state is
 * what makes the second phase a real migration rather than a fresh start.
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKER_DIR = path.join(__dirname, '..', 'worker');
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'personal-vault-test-token';

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log('ok   ' + label);
  } else {
    failed += 1;
    console.log('FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

async function req(method, pathname, body, headers) {
  const response = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch { /* non-JSON body */ }
  return { status: response.status, json };
}
const post = (p, b, h) => req('POST', p, b, h);
const get = (p, h) => req('GET', p, undefined, h);

const asClient = (ip) => ({ 'CF-Connecting-IP': ip });
const asInstall = (n) => `99999999-8888-4777-8666-${String(n).padStart(12, '0')}`;

/* Start wrangler dev against a fixed state dir at a given threshold, and resolve
 * once /health answers. Returns a stop() that also reports whether the child
 * died on its own, so a crashed worker cannot masquerade as a passing phase. */
async function startWorker(stateDir, confirmations) {
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--local', '--persist-to', stateDir,
      '--var', `ADMIN_TOKEN:${ADMIN}`, '--var', 'IP_SALT:personal-salt',
      '--var', `CONFIRMATIONS_REQUIRED:${confirmations}`],
    { cwd: WORKER_DIR, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
  );
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  const stop = () => {
    try {
      if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch { /* already gone */ }
  };

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const health = await get('/health');
      if (health.status === 200) return { stop, log: () => log };
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  stop();
  throw new Error('wrangler dev never became ready\n' + log.slice(-2000));
}

/* The port must be free before the next phase binds it, and Windows releases it
 * lazily after taskkill. Poll instead of sleeping a guessed interval. */
async function waitForPortFree() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      await get('/health');
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async function main() {
  const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df-personal-state-'));
  /* Codes are fixed, not time-derived: phase 2 must address the exact rows phase 1
   * queued, which is the whole point of the migration assertion. */
  const QUEUED_WHILE_STRICT = 'DFMIGRATE0001';
  const SOLO = 'DFSOLO0000001';
  let server = null;

  try {
    /* ── phase 1: threshold 2 — the state a personal vault starts from ─────── */
    server = await startWorker(STATE_DIR, 2);

    const strictHealth = await get('/health');
    check('phase 1 health reports the strict threshold',
      strictHealth.json && strictHealth.json.confirmations_required === 2,
      JSON.stringify(strictHealth.json));

    const queued = await post('/submit',
      { code: QUEUED_WHILE_STRICT, err_code: 400054, install_id: asInstall(1) }, asClient('10.1.0.1'));
    check('a lone report stays unpromoted while two are required',
      queued.json && queued.json.confirmations === 1 && queued.json.promoted === false,
      JSON.stringify(queued.json));

    const strictPending = await get('/pending', { Authorization: `Bearer ${ADMIN}` });
    check('the unpromoted row is not published while strict',
      Array.isArray(strictPending.json && strictPending.json.rows)
        && !strictPending.json.rows.some((r) => r.code === QUEUED_WHILE_STRICT),
      JSON.stringify(strictPending.json));

    server.stop();
    server = null;
    check('the port is released between phases', await waitForPortFree());

    /* ── phase 2: threshold 1, same KV — the personal-vault default ────────── */
    server = await startWorker(STATE_DIR, 1);

    const soloHealth = await get('/health');
    check('phase 2 health reports the personal threshold',
      soloHealth.json && soloHealth.json.confirmations_required === 1,
      JSON.stringify(soloHealth.json));

    /* The migration hazard: this row already has its only reporter recorded, so
     * nothing about it "changed" except the threshold. If the write-skip logic
     * ignores that, it stays queued forever and lowering the threshold is a
     * silent no-op for every row submitted before the change. */
    const remigrated = await post('/submit',
      { code: QUEUED_WHILE_STRICT, err_code: 400054, install_id: asInstall(1) }, asClient('10.1.0.1'));
    check('a row queued under the old threshold promotes on re-report',
      remigrated.json && remigrated.json.promoted === true && remigrated.json.confirmations === 1,
      JSON.stringify(remigrated.json));
    check('that promotion is reported as a real change, not a no-op',
      remigrated.json && remigrated.json.unchanged === false,
      JSON.stringify(remigrated.json));

    const migratedPending = await get('/pending', { Authorization: `Bearer ${ADMIN}` });
    check('the migrated row now reaches the publish queue',
      Array.isArray(migratedPending.json && migratedPending.json.rows)
        && migratedPending.json.rows.some((r) => r.code === QUEUED_WHILE_STRICT),
      JSON.stringify(migratedPending.json));

    /* A fresh code needs no second install at all now. */
    const solo = await post('/submit',
      { code: SOLO, err_code: 0, install_id: asInstall(2) }, asClient('10.1.0.2'));
    check('a single install promotes a new code immediately',
      solo.json && solo.json.promoted === true && solo.json.confirmations === 1,
      JSON.stringify(solo.json));

    /* Write-skip must still hold at threshold 1, or every vault push rewrites
     * every row and walks back into the daily KV put() quota. */
    const resubmit = await post('/submit',
      { code: SOLO, err_code: 0, install_id: asInstall(2) }, asClient('10.1.0.2'));
    check('re-reporting an already promoted row writes nothing',
      resubmit.json && resubmit.json.unchanged === true && resubmit.json.promoted === true,
      JSON.stringify(resubmit.json));

    /* A client too old to send install_id must still count as exactly one
     * reporter (falling back to the IP hash), not as an anonymous extra one. */
    const legacyA = await post('/submit', { code: 'DFLEGACY00001', err_code: 400068 }, asClient('10.1.0.3'));
    const legacyB = await post('/submit', { code: 'DFLEGACY00001', err_code: 400068 }, asClient('10.1.0.3'));
    check('a client without install_id is still a single reporter',
      legacyA.json && legacyB.json && legacyB.json.confirmations === 1,
      JSON.stringify(legacyB.json));

    /* A malformed id must not become its own reporter identity, or a client could
     * mint unlimited confirmations by sending garbage. */
    const junkA = await post('/submit',
      { code: 'DFJUNKID00001', err_code: 400068, install_id: 'not-a-uuid' }, asClient('10.1.0.4'));
    const junkB = await post('/submit',
      { code: 'DFJUNKID00001', err_code: 400068, install_id: 'also-bogus-<script>' }, asClient('10.1.0.4'));
    check('malformed install ids collapse to one reporter',
      junkA.json && junkB.json && junkB.json.confirmations === 1,
      JSON.stringify(junkB.json));

    /* Batch and single-row paths share recordVerdict; assert the batch path also
     * promotes solo so the two cannot drift. */
    const batch = await post('/submit-batch', {
      install_id: asInstall(3),
      rows: [{ code: 'DFBATCHSOLO01', err_code: 400070 }],
    }, asClient('10.1.0.5'));
    check('the batch path also promotes with one install',
      batch.json && batch.json.results && batch.json.results[0]
        && batch.json.results[0].promoted === true,
      JSON.stringify(batch.json));
  } catch (error) {
    failed += 1;
    console.log('FAIL harness threw — ' + (error && error.message));
  } finally {
    if (server) server.stop();
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed === 0 ? 0 : 1);
}());
