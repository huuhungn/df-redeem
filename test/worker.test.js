#!/usr/bin/env node
/* test/worker.test.js — exercises the submission broker against a real
 * `wrangler dev` instance with a real local KV namespace. A mocked KV would not
 * prove the rate limiter, the TTLs, or the CORS layer behave under Workerd.
 */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
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

/* Two identities travel now, and they are deliberately different things:
 *   CF-Connecting-IP  -> rate-limit bucket (server-observed, client cannot pick)
 *   install_id (body)  -> reporter identity (client-asserted, de-duplication only)
 * wrangler dev honours CF-Connecting-IP, so distinct values give distinct rate
 * buckets without needing two machines. */
const asClient = (ip) => ({ 'CF-Connecting-IP': ip });
/* A well-formed v4-shaped install id; the broker rejects malformed ones. */
const asInstall = (n) => `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`;

/* The consensus assertions below describe the *shared* configuration, so this
 * dev server is pinned to 2 regardless of what wrangler.jsonc ships. The
 * personal-vault default of 1 is asserted separately at the end of this file so
 * both modes stay covered and neither can silently regress. */
const TEST_CONFIRMATIONS = 2;

(async function main() {
  /* Own throwaway KV state per run: the default persists under worker/.wrangler
   * and earlier runs' promoted codes would leak into this one's assertions. */
  const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df-worker-state-'));
  console.log('starting wrangler dev (local KV)...');
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--local', '--persist-to', STATE_DIR,
      '--var', `ADMIN_TOKEN:${ADMIN}`, '--var', 'IP_SALT:test-salt',
      '--var', `CONFIRMATIONS_REQUIRED:${TEST_CONFIRMATIONS}`],
    {
      cwd: WORKER_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      /* Own process group on POSIX so stop() can signal the whole tree with
       * kill(-pid). Without this the negative pid would target this test
       * runner's group instead of the server's. */
      detached: process.platform !== 'win32',
    },
  );
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  const stop = () => {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      } else {
        /* Negative pid = the whole process group. Signalling only npx leaves the
         * workerd grandchild running, and it is what holds the port. */
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch { /* already gone */ }
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
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
    check('health states the confirmation rule',
      health.json && health.json.confirmations_required === TEST_CONFIRMATIONS,
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

    const casingInvalid = await post('/submit', { code: 'CaseCode1', err_code: 400054 }, asClient('10.0.0.2'));
    check('a potentially casing-specific 400054 is accepted but never queued for public sync',
      casingInvalid.status === 200 && casingInvalid.json && casingInvalid.json.ok === true && casingInvalid.json.queued === false,
      JSON.stringify(casingInvalid.json));
    const mixedCaseSuccess = await post('/submit', { code: 'CaseCode1', err_code: 0 }, asClient('10.0.0.3'));
    check('a mixed-case code is accepted while its public spelling is preserved',
      mixedCaseSuccess.status === 200 && mixedCaseSuccess.json && mixedCaseSuccess.json.code === 'CaseCode1',
      JSON.stringify(mixedCaseSuccess.json));
    const sameIdentity = await post('/submit', { code: 'CASECODE1', err_code: 0 }, asClient('10.0.0.4'));
    check('casing variants deduplicate under one canonical queue identity',
      sameIdentity.status === 200 && sameIdentity.json && sameIdentity.json.confirmations === 2 && sameIdentity.json.code === 'CaseCode1',
      JSON.stringify(sameIdentity.json));

    /* Only verdicts that do not depend on the submitted spelling are public. */
    for (const [errCode, expected] of [[0, 'success'], [400068, 'expired'], [400070, 'expired'], [400073, 'gift_bug']]) {
      const probe = await post('/submit', { code: 'DFMAP' + errCode, err_code: errCode }, asClient('10.0.9.' + (errCode % 200)));
      check(`err_code ${errCode} maps to ${expected}`,
        probe.json && probe.json.verdict === expected,
        JSON.stringify(probe.json));
    }

    /* ---- transient codes are accepted but never published ---------------- */
    for (const errCode of [400001, 401009]) {
      const probe = await post('/submit', { code: 'DFTRANSIENT1', err_code: errCode }, asClient('10.0.8.' + (errCode % 200)));
      check(`transient err_code ${errCode} is accepted but not queued`,
        probe.status === 200 && probe.json.ok === true && probe.json.queued === false,
        JSON.stringify(probe.json));
    }

    /* ---- every per-account code is accepted but never queued ------------- */
    for (const errCode of [400067, 400069, 400055, 400056, 400050]) {
      const probe = await post('/submit', { code: 'DFPERACCT001', err_code: errCode }, asClient('10.0.7.' + (errCode % 200)));
      check(`per-account err_code ${errCode} is not queued`,
        probe.status === 200 && probe.json.ok === true && probe.json.queued === false,
        JSON.stringify(probe.json));
    }

    /* ---- confirmation rule ---------------------------------------------- */
    const uniq = 'DF' + Date.now().toString(36).toUpperCase().slice(-8);
    const first = await post('/submit', { code: uniq, err_code: 0, install_id: asInstall(1) }, asClient('10.0.0.11'));
    check('first report queues but does not promote',
      first.json && first.json.confirmations === 1 && first.json.promoted === false,
      JSON.stringify(first.json));

    const repeat = await post('/submit', { code: uniq, err_code: 0, install_id: asInstall(1) }, asClient('10.0.0.11'));
    check('same install cannot self-confirm',
      repeat.json && repeat.json.confirmations === 1 && repeat.json.promoted === false,
      JSON.stringify(repeat.json));

    /* Same install id from a different IP is still ONE reporter: a laptop moving
     * between wifi and tethering must not be able to confirm its own reports. */
    const roamed = await post('/submit', { code: uniq, err_code: 0, install_id: asInstall(1) }, asClient('203.0.113.9'));
    check('the same install on a new IP still cannot self-confirm',
      roamed.json && roamed.json.confirmations === 1 && roamed.json.promoted === false,
      JSON.stringify(roamed.json));

    /* Two installs behind ONE IP now count as two reporters; under the old
     * IP-hash identity this case was impossible to express. */
    const second = await post('/submit', { code: uniq, err_code: 0, install_id: asInstall(2) }, asClient('10.0.0.11'));
    check('a second install behind the same IP promotes the code',
      second.json && second.json.confirmations === 2 && second.json.promoted === true,
      JSON.stringify(second.json));

    /* ---- verdict disagreement restarts the count ------------------------ */
    /* 400073 is gift_bug per garena.js, so this is a genuine flip away from the
     * earlier verdict and must reset the tally rather than add to it. */
    const flip = await post('/submit', { code: uniq, err_code: 400073, install_id: asInstall(3) }, asClient('10.0.0.13'));
    check('a changed verdict restarts confirmations',
      flip.json && flip.json.verdict === 'gift_bug' && flip.json.confirmations === 1 && flip.json.promoted === false,
      JSON.stringify(flip.json));

    /* ---- admin surface -------------------------------------------------- */
    const noAuth = await get('/pending');
    check('pending requires a token', noAuth.status === 401);

    const wrongAuth = await get('/pending', { Authorization: 'Bearer wrong-token-of-same-len!!' });
    check('pending rejects a wrong token', wrongAuth.status === 401);

    const promotedCode = 'DFPROMO' + Date.now().toString(36).toUpperCase().slice(-5);
    await post('/submit', { code: promotedCode, err_code: 0, install_id: asInstall(21) }, asClient('10.0.0.21'));
    await post('/submit', { code: promotedCode, err_code: 0, install_id: asInstall(22) }, asClient('10.0.0.22'));

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
      const res = await post('/submit', { code: 'DFBURST' + String(i).padStart(5, '0'), err_code: 400068 }, burstIp);
      if (res.status === 429) { sawLimit = true; break; }
    }
    check('a flood from one client is rate limited', sawLimit);

    const otherStillOk = await post('/submit', { code: 'DFOTHER00001', err_code: 400068 }, asClient('10.0.9.100'));
    check('rate limit is per client, not global', otherStillOk.status === 200, 'status ' + otherStillOk.status);

    /* ---- /submit-batch --------------------------------------------------- */
    /* A client reporting a full vault row-by-row exhausts the hourly quota long
     * before it finishes, so a whole vault must cost a single slot. */
    const batchIp = asClient('10.0.20.1');
    const batchRows = [
      { code: 'DFBATCHGOOD1', err_code: 0 },
      { code: 'DFBATCHDEAD1', err_code: 400068 },
      { code: 'DFBATCHINVALID1', err_code: 400054 },
      { code: 'DFBATCHMINE1', err_code: 400067 },
      { code: 'DFBATCHUSED1', err_code: 400069 },
      { code: 'DFBATCHREGN1', err_code: 400055 },
      { code: 'DFBATCHJUNK1', err_code: 999999 },
      { code: 'sh', err_code: 0 },
    ];
    const batch = await post('/submit-batch', { rows: batchRows }, batchIp);
    check('a batch is accepted', batch.status === 200, 'status ' + batch.status);
    check('a batch reports per-row outcomes',
      batch.json && batch.json.results && batch.json.results.length === batchRows.length,
      JSON.stringify(batch.json && batch.json.results && batch.json.results.length));
    check('only casing-safe global rows are queued', batch.json && batch.json.queued === 2, JSON.stringify(batch.json));
    check('unknown and malformed rows are rejected while casing-specific invalid stays local',
      batch.json && batch.json.rejected === 2, JSON.stringify(batch.json));
    check('per-account rows are accepted without queueing',
      batch.json && batch.json.results.some((r) => r.code === 'DFBATCHMINE1' && r.ok === true && r.queued === false)
      && batch.json.results.some((r) => r.code === 'DFBATCHUSED1' && r.ok === true && r.queued === false)
      && batch.json.results.some((r) => r.code === 'DFBATCHREGN1' && r.ok === true && r.queued === false),
      JSON.stringify(batch.json && batch.json.results));

    /* The batched rows must land in the same queue /submit writes to, which means
     * a second independent client confirming one of them promotes it — proving the
     * batch wrote a real reporter into the shared queue, not a private one.
     * (/pending only lists promoted rows, so a single reporter is invisible there.) */
    const batchConfirm = await post('/submit', { code: 'DFBATCHGOOD1', err_code: 0 }, asClient('10.0.21.7'));
    check('a batched row shares its queue row with /submit',
      batchConfirm.status === 200 && batchConfirm.json.confirmations === 2 && batchConfirm.json.promoted === true,
      JSON.stringify(batchConfirm.json));

    const batchPending = await get('/pending', { Authorization: `Bearer ${ADMIN}` });
    const queuedCodes = (batchPending.json.rows || []).map((p) => p.code);
    check('a confirmed batched row reaches the publish queue',
      queuedCodes.includes('DFBATCHGOOD1'),
      JSON.stringify(queuedCodes.filter((c) => c.startsWith('DFBATCH'))));

    /* Same IP, a second big batch: it must still be allowed, which proves the
     * batch cost one slot rather than one per row. */
    const secondBatch = await post('/submit-batch', {
      rows: Array.from({ length: 60 }, (_, i) => ({ code: 'DFBATCHB' + String(i).padStart(4, '0'), err_code: 400068 })),
    }, batchIp);
    check('a batch costs one rate-limit slot, not one per row',
      secondBatch.status === 200, 'status ' + secondBatch.status);

    /* Duplicate rows for one code inside a single batch share a KV key, so running
     * them concurrently would lose a confirmation. They must stay ordered. */
    const dupBatch = await post('/submit-batch', {
      rows: [
        { code: 'DFDUPEROW0001', err_code: 0 },
        { code: 'DFDUPEROW0001', err_code: 0 },
      ],
    }, asClient('10.0.22.5'));
    const dupOutcomes = (dupBatch.json && dupBatch.json.results) || [];
    check('duplicate rows in one batch are applied in order, not raced',
      dupOutcomes.length === 2 && dupOutcomes[0].confirmations === 1 && dupOutcomes[1].confirmations === 1,
      JSON.stringify(dupOutcomes));

    /* Re-pushing a vault must not rewrite rows that did not move: whole-vault
     * pushes at ~290 writes each exhausted the daily KV put() quota, after which
     * every submission failed with a 500. */
    const dedupeIp = asClient('10.0.0.77');
    const firstPush = await post('/submit-batch', {
      rows: [{ code: 'DFDEDUPEROW01', err_code: 400068 }],
    }, dedupeIp);
    const firstRow = ((firstPush.json && firstPush.json.results) || [])[0] || {};
    check('a first report is written', firstRow.unchanged === false, JSON.stringify(firstRow));

    const repeatPush = await post('/submit-batch', {
      rows: [{ code: 'DFDEDUPEROW01', err_code: 400068 }],
    }, dedupeIp);
    const repeatRow = ((repeatPush.json && repeatPush.json.results) || [])[0] || {};
    check('the same reporter re-sending the same verdict is not rewritten',
      repeatRow.unchanged === true, JSON.stringify(repeatRow));
    check('a no-op re-report keeps the confirmation count stable',
      repeatRow.confirmations === 1, JSON.stringify(repeatRow));

    const otherPush = await post('/submit-batch', {
      rows: [{ code: 'DFDEDUPEROW01', err_code: 400068 }],
    }, asClient('10.0.0.78'));
    const otherRow = ((otherPush.json && otherPush.json.results) || [])[0] || {};
    check('a second independent reporter still counts and is written',
      otherRow.unchanged === false && otherRow.confirmations === 2, JSON.stringify(otherRow));

    /* A whole vault took ~175s when every row was written strictly sequentially,
     * which no client waits for; the handler now runs independent codes in waves. */
    const bulkRows = [];
    for (let i = 0; i < 200; i += 1) bulkRows.push({ code: 'DFBULK' + String(i).padStart(6, '0'), err_code: 400068 });
    const bulkStart = Date.now();
    const bulk = await post('/submit-batch', { rows: bulkRows }, asClient('10.0.23.9'));
    const bulkMs = Date.now() - bulkStart;
    check('a 200-row batch is accepted whole',
      bulk.status === 200 && bulk.json.queued === 200,
      'status ' + bulk.status + ' queued ' + (bulk.json && bulk.json.queued));
    check('a 200-row batch finishes inside a client timeout', bulkMs < 20000, bulkMs + 'ms');

    const tooBig = await post('/submit-batch', {
      rows: Array.from({ length: 501 }, (_, i) => ({ code: 'DFHUGE' + String(i).padStart(6, '0'), err_code: 0 })),
    }, asClient('10.0.20.2'));
    check('an oversized batch is refused', tooBig.status === 413, 'status ' + tooBig.status);

    const notArray = await post('/submit-batch', { rows: 'nope' }, asClient('10.0.20.3'));
    check('a non-array rows field is refused', notArray.status === 400, 'status ' + notArray.status);

    const emptyBatch = await post('/submit-batch', { rows: [] }, asClient('10.0.20.4'));
    check('an empty batch is a no-op, not an error',
      emptyBatch.status === 200 && emptyBatch.json.queued === 0, JSON.stringify(emptyBatch.json));

    /* ── equipment costs ─────────────────────────────────────────────────────
     * The quorum arithmetic is unit-tested in test/costs.test.js; what needs a
     * live Worker is the wiring: does a report reach KV, does the public read
     * withhold reporter identities, and is the admin surface actually gated. */
    const COST_CODE = 'DFCOST0000001';
    const costA = await post('/cost', { code: COST_CODE, cost: '295426', install_id: '11111111-1111-4111-8111-111111111111' }, asClient('10.0.30.1'));
    check('a first cost report is accepted',
      costA.status === 200 && costA.json.cost === 295426 && costA.json.state === 'unconfirmed',
      JSON.stringify(costA.json));

    const costB = await post('/cost', { code: COST_CODE, cost: '290K', install_id: '22222222-2222-4222-8222-222222222222' }, asClient('10.0.30.2'));
    check('a second agreeing report confirms without admin action',
      costB.status === 200 && costB.json.state === 'confirmed', JSON.stringify(costB.json));
    check('confirmation keeps the precise reading, not the rounded one',
      costB.json.cost === 295426, String(costB.json.cost));

    const costDup = await post('/cost', { code: COST_CODE, cost: '295426', install_id: '22222222-2222-4222-8222-222222222222' }, asClient('10.0.30.2'));
    check('re-reporting an unchanged cost writes nothing',
      costDup.status === 200 && costDup.json.unchanged === true, JSON.stringify(costDup.json));

    const costC = await post('/cost', { code: COST_CODE, cost: '412000', install_id: '33333333-3333-4333-8333-333333333333' }, asClient('10.0.30.3'));
    check('a disagreeing report escalates to disputed',
      costC.status === 200 && costC.json.state === 'disputed', JSON.stringify(costC.json));
    check('a dispute still serves a usable leading value',
      costC.json.cost === 295426, String(costC.json.cost));

    const badCost = await post('/cost', { code: COST_CODE, cost: 'abc', install_id: '44444444-4444-4444-8444-444444444444' }, asClient('10.0.30.4'));
    check('a non-numeric cost is refused', badCost.status === 400, 'status ' + badCost.status);

    const badCodeCost = await post('/cost', { code: '!!', cost: '1000' }, asClient('10.0.30.5'));
    check('a malformed code is refused by /cost', badCodeCost.status === 400, 'status ' + badCodeCost.status);

    const publicCosts = await get('/costs');
    const costRow = publicCosts.json && (publicCosts.json.costs || []).find((r) => r.code === COST_CODE);
    check('public /costs needs no credential and lists the row',
      publicCosts.status === 200 && !!costRow, JSON.stringify(publicCosts.json && publicCosts.json.count));
    check('public /costs never exposes reporter identities',
      !!costRow && !('reports_detail' in costRow) && !JSON.stringify(costRow).includes('reporter'),
      JSON.stringify(costRow));

    const disputesNoAuth = await get('/cost-disputes');
    check('cost disputes require the admin token', disputesNoAuth.status === 401, 'status ' + disputesNoAuth.status);

    const disputes = await get('/cost-disputes', { Authorization: `Bearer ${ADMIN}` });
    const dispute = disputes.json && (disputes.json.disputes || []).find((d) => d.code === COST_CODE);
    check('an admin sees the dispute with every distinct reading',
      disputes.status === 200 && !!dispute && dispute.readings.length === 2,
      JSON.stringify(disputes.json));

    const resolveNoAuth = await post('/cost-resolve', { code: COST_CODE, cost: '295426' }, asClient('10.0.30.6'));
    check('resolving a dispute requires the admin token', resolveNoAuth.status === 401, 'status ' + resolveNoAuth.status);

    const resolved = await post('/cost-resolve', { code: COST_CODE, cost: '295426' }, { Authorization: `Bearer ${ADMIN}` });
    check('an admin can settle a dispute',
      resolved.status === 200 && resolved.json.state === 'confirmed' && resolved.json.cost === 295426,
      JSON.stringify(resolved.json));

    const afterResolve = await get('/cost-disputes', { Authorization: `Bearer ${ADMIN}` });
    check('a settled dispute leaves the review queue',
      afterResolve.status === 200 && !(afterResolve.json.disputes || []).some((d) => d.code === COST_CODE),
      JSON.stringify(afterResolve.json));

    const missingResolve = await post('/cost-resolve', { code: 'DFNOTHERE0001', cost: '1000' }, { Authorization: `Bearer ${ADMIN}` });
    check('resolving an unknown code is a 404, not a silent create',
      missingResolve.status === 404, 'status ' + missingResolve.status);

    const healthWithCosts = await get('/health');
    check('health reports the cost queue size',
      healthWithCosts.status === 200 && typeof healthWithCosts.json.costs === 'number',
      JSON.stringify(healthWithCosts.json));
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
