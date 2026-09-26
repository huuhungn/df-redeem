#!/usr/bin/env node
/* test/public-vault.test.js — public two-reporter confirmation policy.
 *
 * worker.test.js already verifies the live consensus mechanics. This suite keeps
 * the former personal-threshold migration fixture under the public policy: old
 * queued rows remain unpromoted until a second installation confirms them. */
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
  /* Queued while strict and then never reported again — the real shape of a
   * backlog after the operator stops redeeming. Nothing will ever rewrite its
   * stored `promoted:false`, so it is the only row that proves /pending applies
   * the current threshold rather than trusting the flag. */
  const ABANDONED_WHILE_STRICT = 'DFABANDON0001';
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
      { code: QUEUED_WHILE_STRICT, err_code: 400068, install_id: asInstall(1) }, asClient('10.1.0.1'));
    check('a lone report stays unpromoted while two are required',
      queued.json && queued.json.confirmations === 1 && queued.json.promoted === false,
      JSON.stringify(queued.json));

    const abandoned = await post('/submit',
      { code: ABANDONED_WHILE_STRICT, err_code: 400068, install_id: asInstall(1) }, asClient('10.1.0.1'));
    check('the abandoned row is also queued unpromoted while strict',
      abandoned.json && abandoned.json.confirmations === 1 && abandoned.json.promoted === false,
      JSON.stringify(abandoned.json));

    const strictPending = await get('/pending', { Authorization: `Bearer ${ADMIN}` });
    check('the unpromoted row is not published while strict',
      Array.isArray(strictPending.json && strictPending.json.rows)
        && !strictPending.json.rows.some((r) => r.code === QUEUED_WHILE_STRICT),
      JSON.stringify(strictPending.json));

    server.stop();
    server = null;
    check('the port is released between phases', await waitForPortFree());

    /* ── phase 2: public threshold 2, same KV — no one-report promotion ─── */
    server = await startWorker(STATE_DIR, 2);

    const publicHealth = await get('/health');
    check('phase 2 health keeps the public threshold',
      publicHealth.json && publicHealth.json.confirmations_required === 2,
      JSON.stringify(publicHealth.json));

    const repeatFirst = await post('/submit',
      { code: QUEUED_WHILE_STRICT, err_code: 400068, install_id: asInstall(1) }, asClient('10.1.0.1'));
    check('a repeat from the same install cannot promote an old row',
      repeatFirst.json && repeatFirst.json.promoted === false && repeatFirst.json.confirmations === 1,
      JSON.stringify(repeatFirst.json));

    const confirmed = await post('/submit',
      { code: QUEUED_WHILE_STRICT, err_code: 400068, install_id: asInstall(2) }, asClient('10.1.0.2'));
    check('a second install promotes the queued row',
      confirmed.json && confirmed.json.promoted === true && confirmed.json.confirmations === 2,
      JSON.stringify(confirmed.json));

    const migratedPending = await get('/pending', { Authorization: `Bearer ${ADMIN}` });
    check('the migrated row now reaches the publish queue',
      Array.isArray(migratedPending.json && migratedPending.json.rows)
        && migratedPending.json.rows.some((r) => r.code === QUEUED_WHILE_STRICT),
      JSON.stringify(migratedPending.json));

    /* A fresh code also needs a distinct second reporter. */
    const solo = await post('/submit',
      { code: SOLO, err_code: 0, install_id: asInstall(2) }, asClient('10.1.0.2'));
    check('a single install cannot promote a new code',
      solo.json && solo.json.promoted === false && solo.json.confirmations === 1,
      JSON.stringify(solo.json));

    const resubmit = await post('/submit',
      { code: SOLO, err_code: 0, install_id: asInstall(2) }, asClient('10.1.0.2'));
    check('re-reporting from the same install does not add confirmation',
      resubmit.json && resubmit.json.unchanged === true && resubmit.json.promoted === false
      && resubmit.json.confirmations === 1,
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

    /* Batch and single-row paths share recordVerdict: batch also requires two. */
    const batch = await post('/submit-batch', {
      install_id: asInstall(3),
      rows: [{ code: 'DFBATCHSOLO01', err_code: 400070 }],
    }, asClient('10.1.0.5'));
    check('the batch path also needs a second install',
      batch.json && batch.json.results && batch.json.results[0]
        && batch.json.results[0].promoted === false && batch.json.results[0].confirmations === 1,
      JSON.stringify(batch.json));

    const contract = await get('/health');
    check('/health publishes the public threshold',
      contract.json && contract.json.confirmations_required === 2,
      JSON.stringify(contract.json));

    const offered = await get('/pending', { Authorization: `Bearer ${ADMIN}` });
    const offeredCodes = (offered.json && offered.json.rows || []).map((r) => r.code);
    check('only the two-reporter row is offered on /pending',
      offeredCodes.includes(QUEUED_WHILE_STRICT) && !offeredCodes.includes(SOLO)
      && !offeredCodes.includes('DFBATCHSOLO01') && !offeredCodes.includes(ABANDONED_WHILE_STRICT),
      JSON.stringify(offeredCodes));
    check('/pending only offers the current threshold or higher',
      (offered.json && offered.json.rows || []).every((r) => Number(r.confirmations) >= 2),
      JSON.stringify(offered.json && offered.json.rows));
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
