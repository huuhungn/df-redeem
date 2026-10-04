/* Exact user-submitted batch: preserve every code, weapon and build label. */
'use strict';
const assert = require('assert');
const batch = require('./fixtures/presets-20261004.json');
const seed = require('../src/data/seed.json');
const publicData = require('../data/presets.json');
const Schema = require('../src/core/schema.js');
const Weapons = require('../src/core/weapons.js');
const { Vault, MemoryAdapter } = require('../src/core/vault.js');
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (error) { failed++; console.log('not ok - ' + name + ': ' + error.message); }
}
(async () => {
  await test('submission contains 35 unique valid codes for 20 weapons', () => {
    assert.strictEqual(batch.length, 35);
    assert.strictEqual(new Set(batch.map((r) => r[2].toUpperCase())).size, 35);
    assert.strictEqual(new Set(batch.map((r) => r[0])).size, 20);
    for (const [weapon, , code] of batch) {
      assert.strictEqual(Schema.inferPresetFormat(code), 'base32-21');
      assert.notStrictEqual(Weapons.classifyPreset({ weapon }).cls, 'unknown');
    }
  });
  for (const [name, doc] of [['seed', seed], ['public data', publicData]]) {
    await test(name + ' includes every submitted mapping without invented verification or prices', () => {
      const rows = new Map(doc.presets.map((r) => [r.code.toUpperCase(), r]));
      assert.strictEqual(rows.size, doc.presets.length, 'no duplicate preset identities');
      assert(rows.size >= 56, '21 existing plus 35 new presets');
      for (const [weapon, label, code] of batch) {
        const row = rows.get(code.toUpperCase());
        assert(row, 'missing ' + code);
        assert.strictEqual(row.weapon, weapon, code);
        assert.strictEqual(row.label || '', label, code);
        assert.strictEqual(row.mode, 'Chiến Dịch (Thoát Hiểm)', code);
        assert.strictEqual(row.verified, false, code);
        assert.strictEqual(row.author, name === 'seed' ? 'user' : 'bundled', code);
        assert(!('cost' in row), 'no invented price for ' + code);
      }
      assert(!seed.codes.some((r) => batch.some((b) => b[2] === r.code)), 'not gift codes');
    });
  }
  await test('same-version preset additions preserve all local records and measured costs', async () => {
    const codes = new Set(batch.map((r) => r[2]));
    const oldSeed = { ...seed, presets: seed.presets.filter((p) => !codes.has(p.code)) };
    const oldSeedCodes = new Set(oldSeed.presets.map((p) => p.code));
    const adapter = new MemoryAdapter();
    const old = await new Vault({ adapter, seed: oldSeed }).init();
    await old.recordAttempt(seed.codes[0].code, { status: 'mine', err_code: 400069 }, 'local-run');
    await old.upsert({ ...seed.presets.find((r) => oldSeedCodes.has(r.code)), label: 'My build', cost: 123456, cost_state: 'unconfirmed' });
    await old.upsert({ code: batch[0][2], weapon: batch[0][0], label: 'My Eco', mode: 'Operations', cost: 234567 });
    const before = await old.all();
    const presetsBefore = await old.presets();
    const historyBefore = await old.history();
    const upgraded = new Vault({ adapter, seed });
    const result = await upgraded.seedOnFirstRun();
    assert.strictEqual(result.imported, 34, 'only the 34 missing batch codes are added');
    const after = await upgraded.all();
    for (const row of before) assert.deepStrictEqual(after.find((r) => r.key === row.key), row);
    for (const row of presetsBefore) assert.deepStrictEqual((await upgraded.presets()).find((r) => r.code === row.code), row);
    assert.deepStrictEqual(await upgraded.history(), historyBefore);
    assert.strictEqual((await upgraded.presets()).length, seed.presets.length);
    assert.strictEqual((await upgraded.seedOnFirstRun()).skipped, true, 'second run is idempotent');
    const csv = await upgraded.exportCSV();
    assert(csv.includes('Full-burst'), 'CSV retains labels');
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
