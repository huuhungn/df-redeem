#!/usr/bin/env node
/* test/worker.test.js — exercises the submission broker against a real
 * `wrangler dev` instance with a real local KV namespace. A mocked KV would not
 * prove the rate limiter, the TTLs, or the CORS layer behave under Workerd.
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');

const WORKER_DIR = path.join(__dirname, '..', 'worker');
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin-token-not-a-real-secret';

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

const post = async (pathname, body, headers) => {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
  return { status: res.status, json, headers: res.headers };
};

const get = async (pathname, headers) => {
  const res = await fetch(BASE + pathname, { headers: headers || {} });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json, headers: res.headers };
};

async function waitForReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/* Two different callers are needed to prove the confirmation rule. wrangler dev
 * honours CF-Connecting-IP from the request, so distinct values give distinct
 * fingerprints without needing two machines. */
const asClient = (ip) => ({ 'CF-Connecting-IP': ip });

(async function main() {
  console.log('starting wrangler dev (local KV)...');
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--local', '--var', `ADMIN_TOKEN:${ADMIN}`, '--var', 'IP_SALT:test-salt'],
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

  if (!(await waitForReady(90000))) {
    console.log('FAIL wrangler dev never became ready');
    console.log(log.slice(-2500));
    stop();
    process.exit(1);
  }

  try {
    const health = await get('/health');
    check('health reports the service', health.status === 200 && health.json && health.json.ok === true,
      JSON.stringify(health.json));
    check('health states the confirmation rule', health.json && health.json.confirmations_required === 2,
      JSON.stringify(health.json));

    /* ---- validation ------------------------------------------------------ */
    const badCode = await post('/submit', { code: 'nope!!', err_code: 0 });
    check('malformed code is rejected', badCode.status === 400, JSON.stringify(badCode.json));

    const badErr = await post('/submit', { code: 'DFTEST000001', err_code: 999999 });
    check('unknown err_code is rejected', badErr.status === 400, JSON.stringify(badErr.json));

    const notJson = await fetch(BASE + '/submit', { method: 'POST', body: 'raw text' });
    check('non-JSON body is rejected', notJson.status === 400, 'status ' + notJson.status);

    const missing = await get('/nope');
    check('unknown route is 404', missing.status === 404);

    /* ---- the account-specific verdict must never be queued --------------- */
    const perAccount = await post('/submit', { code: 'DFACCOUNT0001', err_code: 400067 }, asClient('10.0.0.1'));
    check('account-specific verdict is accepted but not queued',
      perAccount.status === 200 && perAccount.json.ok === true && perAccount.json.queued === false,
      JSON.stringify(perAccount.json));

    /* ---- confirmation rule ---------------------------------------------- */
    const uniq = 'DF' + Date.now().toString(36).toUpperCase().slice(-8);
    const first = await post('/submit', { code: uniq, err_code: 0 }, asClient('10.0.0.11'));
    check('first report queues but does not promote',
      first.json && first.json.confirmations === 1 && first.json.promoted === false,
      JSON.stringify(first.json));

    const repeat = await post('/submit', { code: uniq, err_code: 0 }, asClient('10.0.0.11'));
    check('same reporter cannot self-confirm',
      repeat.json && repeat.json.confirmations === 1 && repeat.json.promoted === false,
      JSON.stringify(repeat.json));

    const second = await post('/submit', { code: uniq, err_code: 0 }, asClient('10.0.0.12'));
    check('a second independent reporter promotes the code',
      second.json && second.json.confirmations === 2 && second.json.promoted === true,
      JSON.stringify(second.json));

    /* ---- verdict disagreement restarts the count ------------------------ */
    const flip = await post('/submit', { code: uniq, err_code: 400073 }, asClient('10.0.0.13'));
    check('a changed verdict restarts confirmations',
      flip.json && flip.json.verdict === 'exhausted' && flip.json.confirmations === 1 && flip.json.promoted === false,
      JSON.stringify(flip.json));

    /* ---- admin surface -------------------------------------------------- */
    const noAuth = await get('/pending');
    check('pending requires a token', noAuth.status === 401);

    const wrongAuth = await get('/pending', { Authorization: 'Bearer wrong-token-of-same-len!!' });
    check('pending rejects a wrong token', wrongAuth.status === 401);

    const promotedCode = 'DFPROMO' + Date.now().toString(36).toUpperCase().slice(-5);
    await post('/submit', { code: promotedCode, err_code: 0 }, asClient('10.0.0.21'));
    await post('/submit', { code: promotedCode, err_code: 0 }, asClient('10.0.0.22'));

    const pending = await get('/pending', { Authorization: `Bearer ${ADMIN}` });
    check('pending lists promoted rows', pending.status === 200 && Array.isArray(pending.json.rows) && pending.json.rows.some((r) => r.code === promotedCode),
      JSON.stringify(pending.json && pending.json.count));

    const leaked = JSON.stringify(pending.json || {});
    check('pending never leaks reporter fingerprints', !leaked.includes('reporters'), leaked.slice(0, 200));

    const unpromoted = pending.json.rows.filter((r) => r.confirmations < 2);
    check('pending only contains promoted rows', unpromoted.length === 0, JSON.stringify(unpromoted));

    const ack = await post('/ack', { codes: [promotedCode] }, { Authorization: `Bearer ${ADMIN}` });
    check('ack removes committed rows', ack.status === 200 && ack.json.removed === 1, JSON.stringify(ack.json));

    const afterAck = await get('/pending', { Authorization: `Bearer ${ADMIN}` });
    check('acked row is gone', !afterAck.json.rows.some((r) => r.code === promotedCode));

    const ackNoAuth = await post('/ack', { codes: ['DFTEST000001'] });
    check('ack requires a token', ackNoAuth.status === 401);

    /* ---- CORS ------------------------------------------------------------ */
    const preflight = await fetch(BASE + '/submit', {
      method: 'OPTIONS',
      headers: { Origin: 'chrome-extension://abcdef', 'Access-Control-Request-Method': 'POST' },
    });
    check('preflight is answered', preflight.status === 204 && !!preflight.headers.get('Access-Control-Allow-Origin'),
      'status ' + preflight.status);

    /* ---- rate limiting -------------------------------------------------- */
    const burstIp = asClient('10.0.9.99');
    let sawLimit = false;
    for (let i = 0; i < 130; i += 1) {
      const res = await post('/submit', { code: 'DFBURST' + String(i).padStart(5, '0'), err_code: 400054 }, burstIp);
      if (res.status === 429) { sawLimit = true; break; }
    }
    check('a flood from one client is rate limited', sawLimit);

    const otherStillOk = await post('/submit', { code: 'DFOTHER00001', err_code: 400054 }, asClient('10.0.9.100'));
    check('rate limit is per client, not global', otherStillOk.status === 200, 'status ' + otherStillOk.status);
  } catch (error) {
    failed += 1;
    console.log('FAIL harness threw — ' + (error && error.message));
    console.log(log.slice(-1500));
  } finally {
    stop();
  }

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed === 0 ? 0 : 1);
}());
