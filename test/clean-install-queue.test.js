#!/usr/bin/env node
/* test/clean-install-queue.test.js — what a fresh install can redeem.
 *
 * The seed is a snapshot of the author's own vault, so a code the author
 * already redeemed ships as `success`. A new player opens the panel, presses
 * "Mã chưa thử" and gets an empty queue, although every one of those codes is
 * still redeemable on their account. The seed also predates codes the community
 * has confirmed since, so even a corrected status would leave gaps.
 *
 * The contract is therefore the public evidence, frozen in a fixture so the
 * 6-hourly data sync cannot move it: every code confirmed redeemable, in the
 * exact spelling Garena accepted, minus DFOSS260404857 — an OCR misread of
 * DFOSS260404B57 that a single install reported under the wrong spelling.
 */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Vault, MemoryAdapter } = require(path.join(ROOT, 'src', 'core', 'vault.js'));
const seed = require(path.join(ROOT, 'src', 'data', 'seed.json'));
const target = require(path.join(__dirname, 'fixtures', 'clean-install-queue-20261007.json'));

const MISREAD = 'DFOSS260404857';
const ACCEPTED = 'DFOSS260404B57';

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
  if (condition) { passed += 1; console.log(`ok   ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sample = (list) => `${list.length}: ${list.slice(0, 12).join(' ')}${list.length > 12 ? ' …' : ''}`;

/* The same steps the panel takes on first open (vault.init, then
 * seedOnFirstRun with the bundled seed) and the same filter as its
 * "Mã chưa thử" button (untriedCodes: non-preset rows still `untried`). */
async function openFresh(seedDoc) {
  const vault = new Vault({ adapter: new MemoryAdapter() });
  await vault.init();
  await vault.seedOnFirstRun(seedDoc);
  const rows = (await vault.all()).filter((row) => row.kind === 'giftcode');
  const queue = rows.filter((row) => row.status === 'untried').map((row) => row.code);
  return { vault, rows, queue };
}

(async () => {
  /* ---- the fixture itself ---------------------------------------------- */
  {
    const keys = new Set(target.codes.map((code) => code.toUpperCase()));
    check('the target fixture holds 237 distinct codes',
      target.count === 237 && target.codes.length === 237 && keys.size === 237,
      JSON.stringify({ count: target.count, codes: target.codes.length, distinct: keys.size }));
    check('the target fixture leaves out the OCR misread', !keys.has(MISREAD), MISREAD);
    check('the target fixture keeps the accepted spelling', target.codes.includes(ACCEPTED), ACCEPTED);
  }

  /* ---- clean install ---------------------------------------------------- */
  {
    const { rows, queue } = await openFresh(seed);
    const queued = new Set(queue);
    const wanted = new Set(target.codes);
    const missing = target.codes.filter((code) => !queued.has(code));
    const extra = queue.filter((code) => !wanted.has(code));

    check('a clean install queues all 237 redeemable codes', queue.length === 237,
      `queued ${queue.length}; seed statuses ${JSON.stringify(rows.reduce((acc, row) => {
        acc[row.status] = (acc[row.status] || 0) + 1; return acc;
      }, {}))}`);
    check('no confirmed-redeemable code is missing from the queue', missing.length === 0, 'missing ' + sample(missing));
    check('the queue holds nothing outside the confirmed set', extra.length === 0, 'extra ' + sample(extra));

    /* Garena matches codes case-sensitively, so the queue must carry the exact
     * accepted text rather than whichever spelling the seed happened to hold. */
    const byKey = new Map(rows.map((row) => [row.code.toUpperCase(), row.code]));
    const respelled = target.codes
      .filter((code) => byKey.has(code.toUpperCase()) && byKey.get(code.toUpperCase()) !== code)
      .map((code) => `${byKey.get(code.toUpperCase())}→${code}`);
    check('queued codes keep the exact spelling Garena accepted', respelled.length === 0, 'respelled ' + sample(respelled));

    check(`the accepted spelling ${ACCEPTED} is queued`, queued.has(ACCEPTED),
      JSON.stringify(rows.find((row) => row.code.toUpperCase() === ACCEPTED) || null));
    check(`the OCR misread ${MISREAD} is never queued`,
      !queue.some((code) => code.toUpperCase() === MISREAD), sample(queue.filter((code) => code.toUpperCase() === MISREAD)));
  }

  /* ---- a seed bump on an existing install ------------------------------- */
  {
    /* Shipping the corrected seed to installs that already imported version 2
     * means bumping the version, and a re-import goes through upsert. That
     * must add what is new without rewriting a verdict the player observed
     * first-hand: resetting their own success to `untried` would queue a code
     * they already redeemed. */
    const vault = new Vault({ adapter: new MemoryAdapter() });
    await vault.init();
    await vault.seedOnFirstRun({ version: 2, codes: [{ code: 'OwnWin01', status: 'untried' }] });
    await vault.recordAttempt('OwnWin01', { status: 'success', err_code: 0 }, 'run-1');
    await vault.seedOnFirstRun({
      version: 3,
      codes: [{ code: 'OwnWin01', status: 'untried' }, { code: 'NewSeed01', status: 'untried' }],
    });
    const rows = await vault.all();
    const own = rows.find((row) => row.code === 'OwnWin01');
    const added = rows.find((row) => row.code === 'NewSeed01');
    check('a seed bump keeps a first-hand success', own && own.status === 'success', JSON.stringify(own));
    check('a seed bump still delivers new codes to an existing install', added && added.status === 'untried', JSON.stringify(added));
  }

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.log(`FAIL clean-install-queue crashed — ${error && error.stack || error}`);
  console.log(`\n${passed} passed, ${failed + 1} failed, ${passed + failed + 1} total`);
  process.exit(1);
});
