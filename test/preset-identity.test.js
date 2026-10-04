/* Preset identity is canonical across imports, seed upgrades and old vaults. */
'use strict';
const assert = require('assert');
const { Vault, MemoryAdapter } = require('../src/core/vault');
const Schema = require('../src/core/schema');
const CODE = '6LFI0L80AHP1JR9CHG3OI';
const OTHER = '6LFHVRK0AHP1JR9CHG3OI';
const row = { kind: 'preset', code: CODE, weapon: 'MK4', mode: 'Operations', label: 'Nhạc',
  author: 'player', cost: 245000, cost_state: 'confirmed', verified: true, first_seen: '2026-01-01T00:00:00Z' };
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.log('not ok - ' + name + ': ' + e.stack); }
}
async function legacy(adapter) {
  const old = { ...row, code: CODE.toLowerCase(), label: 'My build' };
  await adapter.put('presets', old);
  await adapter.put('codes', { ...Schema.codeRecord(old), code: old.code, key: 'preset:' + old.code, notes: 'Keep my note' });
  await adapter.put('presets', { code: CODE, weapon: 'MK4', format: 'base32-21', first_seen: '2026-02-01T00:00:00Z' });
  await adapter.put('codes', Schema.codeRecord({ kind: 'preset', code: CODE, weapon: 'MK4' }));
  await adapter.put('codes', Schema.codeRecord({ code: 'DFMixedCase1', status: 'success' }));
  await adapter.put('meta', { key: 'seed_version', value: 3 });
}
(async () => {
  await test('preset spelling canonicalizes case, width and hidden whitespace without changing gifts', () => {
    assert.strictEqual(Schema.normalizeCode(' \u200b' + CODE.toLowerCase() + '\n', 'preset'), CODE);
    assert.strictEqual(Schema.normalizeCode('６ＬＦＩ０Ｌ８０ＡＨＰ１ＪＲ９ＣＨＧ３ＯＩ', 'preset'), CODE);
    assert.strictEqual(Schema.normalizeCode('DFMixedCase1', 'giftcode'), 'DFMixedCase1');
  });
  await test('duplicate preset imports report skipped and preserve existing metadata', async () => {
    const v = await new Vault({ adapter: new MemoryAdapter() }).init();
    await v.upsert(row);
    const before = await v.exportJSON();
    const beforeDoc = JSON.parse(before);
    const result = await v.importRecords([{ kind: 'preset', code: CODE.toLowerCase(), weapon: 'Different', label: 'replacement' }, row]);
    assert.strictEqual(result.imported, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 2);
    const afterDoc = JSON.parse(await v.exportJSON());
    assert.deepStrictEqual({ ...afterDoc, exported_at: '' }, { ...beforeDoc, exported_at: '' });
  });
  await test('sparse upsert preserves details while explicit editing remains possible', async () => {
    const v = await new Vault({ adapter: new MemoryAdapter() }).init();
    await v.upsert(row);
    await v.upsert({ kind: 'preset', code: CODE.toLowerCase() });
    assert.strictEqual((await v.presets())[0].cost, row.cost);
    assert.strictEqual((await v.presets())[0].label, row.label);
    await v.upsert({ kind: 'preset', code: CODE, label: 'Edited', cost: 0, verified: false });
    const saved = (await v.presets())[0];
    assert.strictEqual(saved.label, 'Edited');
    assert.strictEqual(saved.verified, false);
    assert(!('cost' in saved));
    assert.strictEqual(saved.first_seen, row.first_seen);
  });
  await test('CSV, JSON and paste share the duplicate guard but distinct builds survive', async () => {
    const v = await new Vault({ adapter: new MemoryAdapter() }).init();
    await v.importRecords([row, { ...row, code: OTHER }]);
    for (const action of [
      () => v.importPaste('MK4-Operations-' + CODE.toLowerCase()),
      () => v.importCSV('code,kind,weapon\n' + CODE.toLowerCase() + ',preset,MK4'),
      () => v.importJSON({ presets: [{ ...row, code: CODE.toLowerCase() }] }),
    ]) assert.strictEqual((await action()).skipped, 1);
    assert.strictEqual((await v.presets()).length, 2);
    const copy = await new Vault({ adapter: new MemoryAdapter() }).init();
    const result = await copy.importJSON(await v.exportJSON());
    assert.strictEqual(result.imported, 2, 'codes and details in a backup are one identity, not two imports');
    assert.strictEqual((await copy.presets()).find(p => p.code === CODE).cost, row.cost);
    assert.strictEqual((await copy.presets()).find(p => p.code === CODE).label, row.label);
  });
  await test('concurrent importers insert one identity and do not overwrite the winner', async () => {
    const adapter = new MemoryAdapter();
    const a = await new Vault({ adapter }).init();
    const b = await new Vault({ adapter }).init();
    const results = await Promise.all([a.importRecords([row]), b.importRecords([{ ...row, code: CODE.toLowerCase(), label: 'Second' }])]);
    assert.strictEqual(results.reduce((n, r) => n + r.imported, 0), 1);
    assert.strictEqual(results.reduce((n, r) => n + (r.skipped || 0), 0), 1);
    assert.strictEqual((await a.presets()).length, 1);
    assert.strictEqual((await a.presets())[0].label, row.label);
  });
  await test('startup repairs legacy variants before seed backfill with an exact backup', async () => {
    const adapter = new MemoryAdapter();
    await legacy(adapter);
    const oldCodes = await adapter.getAll('codes');
    const oldPresets = await adapter.getAll('presets');
    const gift = oldCodes.find(p => p.kind === 'giftcode');
    const v = await new Vault({ adapter, seed: { version: 3, presets: [row] } }).init();
    const saved = await v.presets();
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].code, CODE);
    assert.strictEqual(saved[0].label, 'My build');
    assert.strictEqual(saved[0].cost, row.cost);
    assert.strictEqual(saved[0].notes, 'Keep my note');
    assert.strictEqual(saved[0].first_seen, row.first_seen);
    assert.deepStrictEqual((await v.byKind('giftcode'))[0], gift);
    const backup = await adapter.get('meta', 'preset_identity_backup_v1');
    assert.deepStrictEqual(backup.presets, oldPresets);
    assert.deepStrictEqual(backup.codes, oldCodes.filter(p => p.kind === 'preset'));
    const snapshot = JSON.stringify(await adapter.getAll('meta'));
    await v.init();
    assert.strictEqual(JSON.stringify(await adapter.getAll('meta')), snapshot, 'repair must be idempotent');
    assert.strictEqual((await v.presets()).length, 1);
  });
  await test('repair recovers detail-only rows and archives conflicting labels and costs', async () => {
    const adapter = new MemoryAdapter();
    await adapter.put('presets', row);
    await adapter.put('presets', { ...row, code: CODE.toLowerCase(), label: 'Other label', cost: 123000 });
    const v = await new Vault({ adapter }).init();
    assert.strictEqual((await v.presets()).length, 1);
    assert.strictEqual((await v.presets())[0].cost, row.cost);
    const backup = await adapter.get('meta', 'preset_identity_backup_v1');
    assert(backup.presets.some(p => p.label === 'Other label' && p.cost === 123000));
  });
  await test('repair keeps one coherent redemption history instead of splicing variants', async () => {
    const adapter = new MemoryAdapter();
    const lower = CODE.toLowerCase();
    await adapter.put('codes', { ...Schema.codeRecord({ kind: 'preset', code: CODE }), status: 'untried', attempt_count: 0,
      last_tried: '', err_code: null, tags: ['seed'] });
    await adapter.put('codes', { ...Schema.codeRecord({ kind: 'preset', code: lower }), code: lower, key: 'preset:' + lower,
      status: 'success', attempt_count: 2, last_tried: '2026-03-01T00:00:00Z', err_code: 0, result_msg: 'ok', tags: ['mine'] });
    await adapter.put('presets', { code: CODE, weapon: 'MK4', format: 'base32-21', verified: false, first_seen: '2026-02-01T00:00:00Z' });
    await adapter.put('presets', { code: lower, weapon: 'MK4', format: 'base32-21', verified: true, cost: 99000, cost_state: 'confirmed', first_seen: '2026-01-01T00:00:00Z' });
    const v = await new Vault({ adapter }).init();
    const [saved] = await v.presets();
    assert.strictEqual((await v.presets()).length, 1);
    assert.deepStrictEqual(
      [saved.status, saved.attempt_count, saved.last_tried, saved.err_code, saved.result_msg],
      ['success', 2, '2026-03-01T00:00:00Z', 0, 'ok'], 'history must come whole from the row that has it');
    assert.deepStrictEqual([saved.cost, saved.cost_state, saved.verified], [99000, 'confirmed', true]);
    assert.deepStrictEqual(saved.tags.sort(), ['mine', 'seed']);
    assert.strictEqual(saved.first_seen, '2026-01-01T00:00:00Z');
    const backup = await adapter.get('meta', 'preset_identity_backup_v1');
    const status = backup.conflicts.find((c) => c.field === 'status');
    assert(status && status.values.some((x) => x.code === lower && x.value === 'success'), 'conflicts keep their source spelling');
  });
  await test('a variant written later by an old build is folded in and the archive only grows', async () => {
    const adapter = new MemoryAdapter();
    await legacy(adapter);
    const v = await new Vault({ adapter }).init();
    const first = await adapter.get('meta', 'preset_identity_backup_v1');
    const stale = { ...row, code: CODE.toLowerCase(), label: 'Old tab label', cost: 0 };
    delete stale.cost;
    await adapter.put('presets', stale);
    await adapter.put('codes', { ...Schema.codeRecord(stale), code: stale.code, key: 'preset:' + stale.code });
    await v.init();
    const saved = await v.presets();
    assert.strictEqual(saved.length, 1, 'the reopened vault must hold one identity');
    assert.strictEqual(saved[0].label, 'My build', 'the stale writer must not replace the repaired label');
    const second = await adapter.get('meta', 'preset_identity_backup_v1');
    for (const p of first.presets) assert(second.presets.some((q) => JSON.stringify(q) === JSON.stringify(p)), 'earlier archive kept');
    assert(second.presets.some((p) => p.label === 'Old tab label'));
    assert(Schema.DB_VERSION >= 6, 'the schema version must retire pre-identity builds that could still write variants');
  });
  await test('an import with one invalid row saves nothing', async () => {
    const v = await new Vault({ adapter: new MemoryAdapter() }).init();
    await assert.rejects(() => v.importCSV('code,kind,weapon\n' + CODE + ',preset,MK4\nBAD,preset,MK4'), /nothing was saved/);
    await assert.rejects(() => v.importJSON([{ code: 'DFOK1' }, { code: '' }]), /nothing was saved/);
    assert.strictEqual((await v.all()).length, 0);
  });
  await test('CSV and JSON backups keep cost and the repair archive', async () => {
    const adapter = new MemoryAdapter();
    await legacy(adapter);
    const v = await new Vault({ adapter }).init();
    const csvCopy = await new Vault({ adapter: new MemoryAdapter() }).init();
    await csvCopy.importCSV(await v.exportCSV());
    const priced = (await csvCopy.presets()).find((p) => p.code === CODE);
    assert.deepStrictEqual([priced.cost, priced.cost_state], [row.cost, row.cost_state]);
    const backup = JSON.parse(await v.exportJSON());
    assert(backup.preset_archive && backup.preset_archive.presets.some((p) => p.label === 'My build'));
    const jsonCopy = await new Vault({ adapter: new MemoryAdapter() }).init();
    await jsonCopy.importJSON(backup);
    const restored = await jsonCopy.adapter.get('meta', 'preset_identity_backup_v1');
    assert(restored && restored.presets.some((p) => p.label === 'My build'), 'restoring a backup keeps the archive');
  });
  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
