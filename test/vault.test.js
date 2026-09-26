/* Node-only tests for the persistent vault data layer. */
'use strict';

const assert = require('assert');
const {
  Vault,
  MemoryAdapter,
  parsePaste,
  parseCSV,
  parseJSON,
  splitConcatenatedLine,
  STATUSES,
} = require('../src/core/vault.js');
const Schema = require('../src/core/schema.js');

let passed = 0;
let failed = 0;
const TESTS = [];
function test(name, fn) { TESTS.push([name, fn]); }

test('block-aware paste parsing keeps preset blocks separate from gift blocks', () => {
    const text = [
      'AKS-74 Assault Rifle-Havoc Warfare-5620492356433216746',
      'UZI Submachine Gun-Havoc Warfare-5620492343548352708',
      '',
      'DFALPHA1',
      'DFBETA2',
    ].join('\n');
    const parsed = parsePaste(text);
    assert.strictEqual(parsed.presets.length, 2);
    assert.strictEqual(parsed.codes.length, 2);
    assert.strictEqual(parsed.presets[0].weapon, 'AKS-74 Assault Rifle');
    assert.strictEqual(parsed.presets[0].mode, 'Havoc Warfare');
    assert.strictEqual(parsed.codes[0].kind, 'giftcode');
  });

  test('concatenated lines split only against known vault codes', () => {
    const known = ['MOILOOT45', 'DFCRAFT427', 'DFSIXVIP888', 'ACESIXMAJOR'];
    assert.deepStrictEqual(
      splitConcatenatedLine('MOILOOT45DFCRAFT427DFSIXVIP888ACESIXMAJOR', known),
      known,
    );
    const emptyKnown = new Set();
    assert.deepStrictEqual(splitConcatenatedLine('LONGUNKNOWNVALUE1234', emptyKnown), ['LONGUNKNOWNVALUE1234']);
  });

  test('concatenated lines retain the first original casing for each split gift', () => {
    const known = ['DFVNHackclaw1', 'DFVNVyron2'];
    assert.deepStrictEqual(
      splitConcatenatedLine('DFVNHACKCLAW1DFVNVYRON2', known),
      ['DFVNHackclaw1', 'DFVNVyron2'],
    );
  });

  test('deduplicates gifts case-insensitively and presets exactly', async () => {
    const vault = new Vault({ adapter: new MemoryAdapter() });
    await vault.init();
    const result = await vault.importPaste([
      'DFAlpha1',
      'dfalpha1',
      '',
      'AK-Mode-5620492356433216746',
      'AK-Mode-5620492356433216746',
      'AK-Mode-5620492356433216747',
    ].join('\n'));
    assert.strictEqual(result.imported, 3);
    assert.strictEqual((await vault.byKind('giftcode')).length, 1);
    assert.strictEqual((await vault.byKind('preset')).length, 2);
  });

  test('gift-code vault preserves the first submitted casing while deduplicating case-insensitively', async () => {
  const vault = new Vault({ adapter: new MemoryAdapter() });
  await vault.init();
  const result = await vault.importPaste(['DFVNHackclaw1', 'DFVNHACKCLAW1'].join('\n'));
  assert.strictEqual(result.imported, 1);
  const rows = await vault.byKind('giftcode');
  assert.strictEqual(rows[0].code, 'DFVNHackclaw1');
  await vault.recordAttempt('DFVNHackclaw1', { status: 'success', err_code: 0 }, 'manual-run');
  assert.strictEqual((await vault.search('DFVNHACKCLAW1'))[0].status, 'success');
});

test('recordAttempt restores mixed-case spelling after legacy uppercase invalid result', async () => {
  const vault = new Vault({ adapter: new MemoryAdapter() });
  await vault.init();
  await vault.recordAttempt('DFVNHACKCLAW1', { status: 'invalid', err_code: 400054, msg: 'uppercase request' });
  await vault.recordAttempt('DFVNHackclaw1', { status: 'mine', err_code: 400067, msg: 'manual exact-case success' });
  const row = (await vault.all()).find((item) => item.code.toUpperCase() === 'DFVNHACKCLAW1');
  assert.strictEqual(row.code, 'DFVNHackclaw1');
  assert.strictEqual(row.status, 'mine');
});

test('status, kind, family, search and stats queries work', async () => {
    const vault = new Vault({ adapter: new MemoryAdapter() });
    await vault.init();
    await vault.importJSON([
      { code: 'DFSUCCESS1', status: 'success', family: 'DF-word', shareable: true },
      { code: 'DFEXPIRED1', status: 'expired', family: 'DF-word', shareable: false },
      { code: '6KPRESET0000000000001', kind: 'preset', weapon: 'AK', mode: 'Havoc', author: 'a' },
    ]);
    assert.strictEqual((await vault.byStatus('success')).length, 1);
    assert.strictEqual((await vault.byKind('preset')).length, 1);
    assert.strictEqual((await vault.byFamily('DF-word')).length, 2);
    assert.strictEqual((await vault.search('success1')).length, 1);
    const stats = await vault.stats();
    assert.strictEqual(stats.total, 3);
    assert.strictEqual(stats.byStatus.success, 1);
    assert.strictEqual(stats.byStatus.untried, 1);
  });

  test('CSV and JSON exports round-trip without secret fields', async () => {
    const vault = new Vault({ adapter: new MemoryAdapter() });
    await vault.init();
    await vault.importJSON([{ code: 'DFCSV1', status: 'success', notes: 'a, b', shareable: true }]);
    const csv = await vault.exportCSV();
    assert.ok(csv.includes('DFCSV1'));
    assert.ok(!csv.includes('cookie'));
    const json = await vault.exportJSON();
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.codes.length, 1);
    assert.ok(!JSON.stringify(parsed).match(/token|cookie|authorization|authHeaders/i));

    const roundTrip = new Vault({ adapter: new MemoryAdapter() });
    await roundTrip.init();
    await roundTrip.importCSV(csv);
    assert.strictEqual((await roundTrip.search('DFCSV1')).length, 1);
  });

  test('history appends every attempt and updates the code record', async () => {
    const vault = new Vault({ adapter: new MemoryAdapter(), clock: () => '2026-09-25T00:00:00.000Z' });
    await vault.init();
    await vault.importJSON([{ code: 'DFHISTORY1' }]);
    await vault.recordAttempt('DFHISTORY1', { status: 'expired', err_code: 400068, result_msg: 'expired' }, 'run-1');
    await vault.recordAttempt('DFHISTORY1', { status: 'success', result_msg: 'ok', variant_used: 'DFHISTORYI' }, 'run-2');
    const history = await vault.history('DFHISTORY1');
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].run_id, 'run-1');
    assert.strictEqual((await vault.search('DFHISTORY1'))[0].attempt_count, 2);
    assert.strictEqual((await vault.search('DFHISTORY1'))[0].status, 'success');
  });

  test('migration creates all required stores and indexes', () => {
    const created = [];
    const db = {
      objectStoreNames: { contains: (name) => created.includes(name) },
      createObjectStore(name, options) {
        created.push(name);
        return { createIndex() {} };
      },
    };
    Schema.upgradeDatabase(db, 0, Schema.DB_VERSION);
    assert.deepStrictEqual(created.sort(), ['codes', 'meta', 'presets', 'results', 'runs']);
  });

  /* a changed seed reaches existing installs by bumping its version */
  test('a changed seed reaches existing installs by bumping its version', async () => {
      /* seedOnFirstRun skips when the stored marker >= seed.version, so editing
       * seed.json WITHOUT bumping version silently strands every existing user
       * on stale data. This pins the two together. */
      const seed = require('../src/data/seed.json');
      const adapter = new MemoryAdapter();
      /* init() seeds on its own, so the version gate is observed through it. */
      const v1 = new Vault({ adapter, seed, seedVersion: seed.version });
      await v1.init();
      const before = await v1.stats();
      const marker = await adapter.get('meta', 'seed_version');
      assert(Number(marker.value) === seed.version, 'init must record the shipped seed version');

      /* Same version + changed content => skipped, the trap this test documents. */
      const edited = JSON.parse(JSON.stringify(seed));
      const victim = edited.codes[0];
      victim.status = victim.status === 'expired' ? 'gift_bug' : 'expired';
      const stale = new Vault({ adapter, seed: edited, seedVersion: edited.version });
      const staleResult = await stale.seedOnFirstRun();
      assert(staleResult.skipped === true, 'an unbumped seed must be skipped');
      const staleRec = await adapter.get('codes', `gift:${victim.code}`);
      assert(staleRec.status !== victim.status, 'the unbumped edit must NOT have landed');

      /* Bumped version => the same edit lands, without duplicating records. */
      edited.version = seed.version + 1;
      const fresh = new Vault({ adapter, seed: edited, seedVersion: edited.version });
      const applied = await fresh.seedOnFirstRun();
      assert(applied.skipped !== true, 'a bumped seed version must re-import');
      const after = await fresh.stats();
      assert(after.total === before.total, `a re-import must not duplicate records (${before.total} -> ${after.total})`);
      const freshRec = await adapter.get('codes', `gift:${victim.code}`);
      assert(freshRec.status === victim.status, 'the bumped edit must land');
    });

test('legacy casing-ambiguous invalid results become retryable locally', async () => {
    const adapter = new MemoryAdapter();
    await adapter.open();
    await adapter.put('codes', {
      key: 'gift:DFVNHACKCLAW1', code: 'DFVNHACKCLAW1', kind: 'giftcode',
      status: 'invalid', err_code: 400054, result_msg: 'The current cdk does not match', shareable: true,
    });
    const vault = new Vault({ adapter });
    const migrated = await vault.migrateCasingAmbiguousInvalids();
    assert.strictEqual(migrated.migrated, 1);
    const row = await adapter.get('codes', 'gift:DFVNHACKCLAW1');
    assert.strictEqual(row.status, 'untried');
    assert.strictEqual(row.err_code, 0);
    assert.strictEqual(row.result_msg, '');
    assert.strictEqual(row.shareable, false);
    assert.strictEqual((await vault.migrateCasingAmbiguousInvalids()).skipped, true);
  });

  test('the three field-sourced untried codes remain local-only after 400054', async () => {
      /* 400054 can result from a casing variant. These records remain useful local
       * history, but public data must not call them globally invalid. */
    const seed = require('../src/data/seed.json');
    const targets = ['DFOS7KZM90', 'DFOSS260404857', 'FVZELRXYAJVWVFSTS2'];
    for (const code of targets) {
      const rec = seed.codes.find((r) => r.code === code);
      assert(rec, `${code} must exist in the seed`);
      assert(rec.status === 'invalid', `${code} must be invalid, got ${rec.status}`);
      assert(rec.err_code === 400054, `${code} must carry err_code 400054, got ${rec.err_code}`);
      assert(rec.shareable === false, `${code} must not be shareable`);
      /* Canonical schema keys only — no ad-hoc last_code/last_msg fields. */
      assert(!('last_code' in rec), `${code} must not carry a non-canonical last_code key`);
    }
    const untried = seed.codes.filter((r) => r.status === 'untried');
    assert(untried.length === 0, `no code should remain untried, found ${untried.length}`);
  });

  test('a shipped seed bump upgrades an existing install without seedVersion', async () => {
    /* The real upgrade path: panel.js constructs the vault WITHOUT seedVersion,
     * so the gate must read seed.version. Previously it compared against the
     * constructor default of 1 and every existing install stayed on old data. */
    const adapter = new MemoryAdapter();
    const v1 = new Vault({ adapter, seed: { version: 1, codes: [{ code: 'DFTEST1', status: 'untried' }] } });
    await v1.init();
    const first = await adapter.get('codes', 'gift:DFTEST1');
    assert(first.status === 'untried', 'v1 seed must land');

    const v2 = new Vault({ adapter, seed: { version: 2, codes: [{ code: 'DFTEST1', status: 'invalid', err_code: 400054 }] } });
    const res = await v2.init().then(() => adapter.get('codes', 'gift:DFTEST1'));
    assert(res.status === 'invalid', `a v2 seed must upgrade the record, still ${res.status}`);
    assert(Number(res.err_code) === 400054, 'the upgraded record must carry the new err_code');
    const marker = await adapter.get('meta', 'seed_version');
    assert(Number(marker.value) === 2, `marker must advance to 2, got ${marker.value}`);
  });

  test('share list contains only shareable codes', async () => {
    const vault = new Vault({ adapter: new MemoryAdapter() });
    await vault.init();
    await vault.importJSON([
      { code: 'DFPUBLIC1', shareable: true },
      { code: 'DFPRIVATE1', shareable: false },
    ]);
    assert.deepStrictEqual((await vault.shareableList()).map((row) => row.code), ['DFPUBLIC1']);
    assert.strictEqual(await vault.exportShareList(), 'DFPUBLIC1');
  });

  test('migrates only the legacy 400069 exhausted pair to local mine', async () => {
    const adapter = new MemoryAdapter();
    await adapter.put(Schema.STORES.codes, Schema.codeRecord({ code: 'DFLEGACYUSED1', status: 'exhausted', err_code: 400069 }));
    await adapter.put(Schema.STORES.codes, Schema.codeRecord({ code: 'DFKEEPDEAD01', status: 'exhausted', err_code: 400073 }));
    const vault = new Vault({ adapter });
    await vault.init();
    const rows = await vault.all();
    assert.strictEqual(rows.find((row) => row.code === 'DFLEGACYUSED1').status, 'mine');
    assert.strictEqual(rows.find((row) => row.code === 'DFKEEPDEAD01').status, 'exhausted');
  });

  test('a completed run writes the verdict through to the stored status', async () => {
    /* The panel once passed the engine's result object straight into
     * recordAttempt(codeValue, result, runId), so the code became an object and
     * the UPPERCASE verdict never matched schema's lowercase STATUSES — every
     * attempt was persisted as "untried". Both halves are checked here. */
    const Garena = require('../src/core/garena.js');
    const vault = new Vault({ adapter: new MemoryAdapter() });
    await vault.init();
    await vault.importJSON([{ code: 'DFRUNTEST1' }]);

    /* SUCCESS proves this account received the reward. USED (400069) is equally
     * account-local: a repeat attempt must retain it as `mine`, never publish it
     * as a global exhausted code. */
    const verdict = { code: 'DFRUNTEST1', status: 'SUCCESS', label: 'Thành công', detail: 'Đổi code thành công.', errorCode: 0 };
    const mapped = Garena.vaultStatus(verdict.status);
    assert.strictEqual(mapped, 'success', 'SUCCESS must map onto the success status');
    await vault.recordAttempt(verdict.code, Object.assign({}, verdict, {
      status: mapped, result_msg: verdict.detail, err_code: verdict.errorCode,
    }), 'run-1');

    const row = (await vault.all()).find((r) => r.code === 'DFRUNTEST1');
    assert.strictEqual(row.status, 'success', 'the run verdict must reach the stored record');
    assert.strictEqual(typeof row.code, 'string', 'code must never be stored as an object');
    assert.strictEqual(row.attempt_count, 1);

    assert.strictEqual(Garena.vaultStatus('USED'), 'mine', '400069 must stay account-local as mine');
    await vault.recordAttempt('DFUSEDLOCAL1', {
      status: Garena.vaultStatus('USED'), err_code: 400069, result_msg: 'Code đã được sử dụng.',
    }, 'run-1');
    const used = (await vault.all()).find((r) => r.code === 'DFUSEDLOCAL1');
    assert.strictEqual(used.status, 'mine', 'a repeat redemption must not become globally exhausted');

    const history = await vault.history();
    assert.ok(history.length >= 1, 'the attempt must land in history');
    assert.strictEqual(typeof history[0].code, 'string', 'history code must be a string, not [object Object]');

    /* Every verdict the engine can emit either maps to a real status or is
     * deliberately inconclusive — never to a value the schema rejects. */
    for (const v of Object.keys(Garena.STATUS_LABELS)) {
      const m = Garena.vaultStatus(v);
      assert.ok(m === null || STATUSES.includes(m), `verdict ${v} mapped to invalid status ${m}`);
    }
    /* Throttling and captcha say nothing about the code itself. */
    for (const v of ['RATE_LIMITED', 'NETWORK', 'NO_RESPONSE', 'VERIFY', 'NOT_LOGGED_IN', 'TEMP_ERROR']) {
      assert.strictEqual(Garena.vaultStatus(v), null, `${v} must not overwrite a stored status`);
    }
  });

(async () => {
  for (const [name, fn] of TESTS) {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}: ${error.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${TESTS.length} total`);
  if (failed) process.exitCode = 1;
})();
