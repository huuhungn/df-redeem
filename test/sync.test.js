/* Node-only tests for the cloud sync layer. Run: node test/sync.test.js */
'use strict';

const assert = require('assert');
const Sync = require('../src/core/sync.js');

let passed = 0;
let failed = 0;
const TESTS = [];
function test(name, fn) { TESTS.push([name, fn]); }

/* --- mock chrome.storage ------------------------------------------------ */
function makeStorage(quotaBytes) {
  const data = {};
  return {
    data,
    get(keys) {
      const out = {};
      const wanted = Array.isArray(keys) ? Object.fromEntries(keys.map((key) => [key, undefined]))
        : typeof keys === 'string' ? { [keys]: undefined } : keys;
      for (const key of Object.keys(wanted || data)) {
        out[key] = key in data ? data[key] : wanted[key];
      }
      return Promise.resolve(out);
    },
    set(value) {
      if (quotaBytes) {
        const size = Buffer.byteLength(JSON.stringify({ ...data, ...value }));
        if (size > quotaBytes) {
          const err = new Error('QUOTA_BYTES quota exceeded');
          err.code = 'QUOTA_BYTES';
          return Promise.reject(err);
        }
      }
      Object.assign(data, value);
      return Promise.resolve();
    },
    remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete data[key];
      return Promise.resolve();
    },
    clear() {
      for (const key of Object.keys(data)) delete data[key];
      return Promise.resolve();
    },
  };
}

function makeChrome(opts = {}) {
  return { storage: { local: makeStorage(), sync: makeStorage(opts.syncQuota) } };
}

/* --- delta compaction --------------------------------------------------- */
test('compactDelta keeps only code/status/timestamp and drops everything else', () => {
  const svc = Sync.createSyncService({ chromeApi: makeChrome() });
  const delta = svc.compactDelta([
    { code: 'DFONE', status: 'success', timestamp: 100, result_msg: 'ok', notes: 'secret note', syncToken: 'leak' },
  ]);
  assert.deepStrictEqual(Object.keys(delta.DFONE).sort(), ['code', 'status', 'timestamp']);
  assert.strictEqual(delta.DFONE.status, 'success');
});

test('compactDelta keeps the newest entry when a code repeats', () => {
  const svc = Sync.createSyncService({ chromeApi: makeChrome() });
  const delta = svc.compactDelta([
    { code: 'DFDUP', status: 'untried', timestamp: 10 },
    { code: 'DFDUP', status: 'success', timestamp: 999 },
    { code: 'DFDUP', status: 'expired', timestamp: 50 },
  ]);
  assert.strictEqual(Object.keys(delta).length, 1);
  assert.strictEqual(delta.DFDUP.status, 'success');
});

test('compactDelta skips blank and missing codes', () => {
  const svc = Sync.createSyncService({ chromeApi: makeChrome() });
  const delta = svc.compactDelta([{ code: '  ' }, { status: 'success' }, null, { code: 'DFOK', status: 'success' }]);
  assert.deepStrictEqual(Object.keys(delta), ['DFOK']);
});

test('compactDelta accepts the vault last_tried ISO timestamp used by the extension bridge', () => {
  const svc = Sync.createSyncService({ chromeApi: makeChrome() });
  const delta = svc.compactDelta([{ code: 'DFISO', status: 'success', last_tried: '2026-09-26T15:20:00.000Z' }]);
  assert.strictEqual(delta.DFISO.timestamp, Date.parse('2026-09-26T15:20:00.000Z'));
});


test('mergeDeltas resolves conflicts by newest timestamp regardless of side', () => {
  const svc = Sync.createSyncService({ chromeApi: makeChrome() });
  const merged = svc.mergeDeltas(
    { DFA: { code: 'DFA', status: 'success', timestamp: 500 }, DFB: { code: 'DFB', status: 'untried', timestamp: 10 } },
    { DFA: { code: 'DFA', status: 'expired', timestamp: 100 }, DFB: { code: 'DFB', status: 'success', timestamp: 900 } },
  );
  assert.strictEqual(merged.DFA.status, 'success', 'local newer wins');
  assert.strictEqual(merged.DFB.status, 'success', 'remote newer wins');
});

test('mergeDeltas survives clock skew: a zero/absent timestamp never beats a real one', () => {
  const svc = Sync.createSyncService({ chromeApi: makeChrome() });
  const merged = svc.mergeDeltas(
    { DFC: { code: 'DFC', status: 'success', timestamp: 1000 } },
    { DFC: { code: 'DFC', status: 'invalid' } },
  );
  assert.strictEqual(merged.DFC.status, 'success');
});

test('mergeDeltas unions codes that exist on only one side', () => {
  const svc = Sync.createSyncService({ chromeApi: makeChrome() });
  const merged = svc.mergeDeltas(
    { ONLYLOCAL: { code: 'ONLYLOCAL', status: 'success', timestamp: 1 } },
    { ONLYREMOTE: { code: 'ONLYREMOTE', status: 'expired', timestamp: 2 } },
  );
  assert.deepStrictEqual(Object.keys(merged).sort(), ['ONLYLOCAL', 'ONLYREMOTE']);
});

/* --- credential safety -------------------------------------------------- */
test('serializeExport never emits the sync token', () => {
  const svc = Sync.createSyncService({ chromeApi: makeChrome() });
  const out = svc.serializeExport({
    settings: { syncBackend: 'rest', syncEndpoint: 'https://example.test/df', syncToken: 'SUPERSECRET123' },
    records: [{ code: 'DFONE', status: 'success', timestamp: 1 }],
  });
  assert.ok(!out.includes('SUPERSECRET123'), 'token must not appear in export');
  assert.ok(!/syncToken/.test(out), 'token field must be stripped entirely');
  assert.ok(out.includes('https://example.test/df'), 'non-secret settings still export');
});

test('publicSettings strips the token but keeps operational settings', () => {
  const svc = Sync.createSyncService({ chromeApi: makeChrome() });
  const pub = svc.publicSettings({ syncToken: 'NOPE', syncBackend: 'rest', autoSyncMinutes: 30 });
  assert.ok(!('syncToken' in pub));
  assert.strictEqual(pub.autoSyncMinutes, 30);
});

test('a failing REST call redacts the bearer token from the stored error', async () => {
  const chromeApi = makeChrome();
  const svc = Sync.createSyncService({
    chromeApi,
    fetchFn: async () => { throw new Error('connect failed with Authorization: Bearer SUPERSECRET123'); },
  });
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'rest', syncEndpoint: 'https://example.test/df', syncToken: 'SUPERSECRET123' } });
  const status = await svc.syncNow([{ code: 'DFONE', status: 'success', timestamp: 1 }]);
  assert.strictEqual(status.state, 'error');
  assert.ok(!status.error.includes('SUPERSECRET123'), `token leaked into status: ${status.error}`);
  assert.ok(/redacted/i.test(status.error), 'redaction marker expected');
});

/* --- chrome-sync backend ------------------------------------------------ */
test('chrome-sync backend happy path stores the merged delta and reports ok', async () => {
  const chromeApi = makeChrome();
  const svc = Sync.createSyncService({ chromeApi, now: () => 1750000000000 });
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'chrome-sync' } });
  const status = await svc.syncNow([
    { code: 'DFONE', status: 'success', timestamp: 10 },
    { code: 'DFTWO', status: 'expired', timestamp: 20 },
  ]);
  assert.strictEqual(status.state, 'ok');
  assert.strictEqual(status.recordCount, 2);
  assert.strictEqual(status.lastSyncAt, 1750000000000);
  const manifest = chromeApi.storage.sync.data[svc.keys.SYNC_MANIFEST_KEY];
  assert.strictEqual(manifest.version, 2);
  assert.strictEqual(manifest.keys.length, 1);
  assert.ok(manifest.keys[0].startsWith(svc.keys.SYNC_CHUNK_PREFIX));
  const stored = chromeApi.storage.sync.data[manifest.keys[0]];
  assert.deepStrictEqual(Object.keys(stored).sort(), ['DFONE', 'DFTWO']);
});

test('chrome-sync writes shards below the per-item limit and round-trips a large vault', async () => {
  const chromeApi = makeChrome();
  const svc = Sync.createSyncService({ chromeApi });
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'chrome-sync' } });
  const rows = Array.from({ length: 450 }, (_, i) => ({
    code: 'DF' + String(i).padStart(6, '0'), status: i % 2 ? 'success' : 'expired', timestamp: i + 1,
  }));
  const status = await svc.syncNow(rows);
  assert.strictEqual(status.state, 'ok');
  const manifest = chromeApi.storage.sync.data[svc.keys.SYNC_MANIFEST_KEY];
  assert.ok(manifest.keys.length > 1, 'large vault should be sharded');
  for (const key of manifest.keys) assert.ok(Buffer.byteLength(JSON.stringify(chromeApi.storage.sync.data[key])) <= 7000, key + ' exceeds the safe shard budget');
  const second = Sync.createSyncService({ chromeApi });
  await second.setLocal({ [second.keys.SETTINGS_KEY]: { syncBackend: 'chrome-sync' } });
  const roundTrip = await second.syncNow(rows);
  assert.strictEqual(roundTrip.state, 'ok');
  assert.strictEqual(roundTrip.recordCount, rows.length);
});

test('chrome-sync reports an incomplete manifest instead of silently treating it as an empty chunk', async () => {
  const chromeApi = makeChrome();
  const svc = Sync.createSyncService({ chromeApi });
  chromeApi.storage.sync.data[svc.keys.SYNC_MANIFEST_KEY] = { version: 2, keys: [svc.keys.SYNC_CHUNK_PREFIX + 'missing'], recordCount: 1 };
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'chrome-sync' } });
  const status = await svc.syncNow([{ code: 'DFLOCAL', status: 'success', timestamp: 1 }]);
  assert.strictEqual(status.state, 'error');
  assert.match(status.error, /chưa hoàn chỉnh/i);
});

test('chrome-sync reads a legacy single-key delta and migrates it on the next write', async () => {
  const chromeApi = makeChrome();
  const svc = Sync.createSyncService({ chromeApi });
  chromeApi.storage.sync.data[svc.keys.SYNC_DELTA_KEY] = { DFLEGACY: { code: 'DFLEGACY', status: 'success', timestamp: 8 } };
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'chrome-sync' } });
  const status = await svc.syncNow([]);
  assert.strictEqual(status.state, 'ok');
  assert.strictEqual(status.recordCount, 1);
  assert.ok(chromeApi.storage.sync.data[svc.keys.SYNC_MANIFEST_KEY]);
  assert.ok(!(svc.keys.SYNC_DELTA_KEY in chromeApi.storage.sync.data), 'legacy key should be removed after migration');
});

test('chrome-sync pulls remote state and merges it into local records', async () => {
  const chromeApi = makeChrome();
  const svc = Sync.createSyncService({ chromeApi, now: () => 2 });
  chromeApi.storage.sync.data[svc.keys.SYNC_DELTA_KEY] = { DFREMOTE: { code: 'DFREMOTE', status: 'success', timestamp: 500 } };
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'chrome-sync' } });
  await svc.syncNow([{ code: 'DFLOCAL', status: 'success', timestamp: 1 }]);
  const records = chromeApi.storage.local.data[svc.keys.RECORDS_KEY];
  assert.deepStrictEqual(records.map((r) => r.code).sort(), ['DFLOCAL', 'DFREMOTE']);
});

test('chrome-sync quota overflow surfaces a clear error and never silently drops data', async () => {
  const chromeApi = makeChrome({ syncQuota: 200 });
  const svc = Sync.createSyncService({ chromeApi });
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'chrome-sync' } });
  const many = Array.from({ length: 400 }, (_, i) => ({ code: `DFBULK${i}`, status: 'success', timestamp: i }));
  const status = await svc.syncNow(many);
  assert.strictEqual(status.state, 'error');
  assert.ok(/hạn mức|quota/i.test(status.error), `expected quota message, got: ${status.error}`);
  assert.ok(/REST/.test(status.error), 'error should suggest the REST fallback');
});

/* --- rest backend ------------------------------------------------------- */
test('rest backend GETs then POSTs the merged delta', async () => {
  const chromeApi = makeChrome();
  const calls = [];
  const svc = Sync.createSyncService({
    chromeApi,
    now: () => 7,
    fetchFn: async (url, init) => {
      calls.push({ url, method: init.method });
      if (init.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ delta: { DFREMOTE: { code: 'DFREMOTE', status: 'mine', timestamp: 900 } } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'rest', syncEndpoint: 'https://example.test/df', syncToken: 'T' } });
  const status = await svc.syncNow([{ code: 'DFLOCAL', status: 'success', timestamp: 5 }]);
  assert.strictEqual(status.state, 'ok');
  assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'POST']);
  assert.strictEqual(status.recordCount, 2);
});

test('rest backend reports HTTP failures as an error state', async () => {
  const chromeApi = makeChrome();
  const svc = Sync.createSyncService({
    chromeApi,
    fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'rest', syncEndpoint: 'https://example.test/df' } });
  const status = await svc.syncNow([{ code: 'DFONE', status: 'success', timestamp: 1 }]);
  assert.strictEqual(status.state, 'error');
  assert.ok(/503/.test(status.error), `expected status code in error, got: ${status.error}`);
});

test('rest backend refuses a missing endpoint instead of calling out', async () => {
  const chromeApi = makeChrome();
  let called = false;
  const svc = Sync.createSyncService({ chromeApi, fetchFn: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; } });
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'rest', syncEndpoint: '' } });
  const status = await svc.syncNow([{ code: 'DFONE', status: 'success', timestamp: 1 }]);
  assert.strictEqual(status.state, 'error');
  assert.strictEqual(called, false, 'must not fetch without an endpoint');
});

/* --- service behaviour -------------------------------------------------- */
test('backend "none" stays never-synced and performs no network call', async () => {
  const chromeApi = makeChrome();
  let called = false;
  const svc = Sync.createSyncService({ chromeApi, fetchFn: async () => { called = true; } });
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'none' } });
  const status = await svc.syncNow([{ code: 'DFONE', status: 'success', timestamp: 1 }]);
  assert.strictEqual(status.state, 'never-synced');
  assert.strictEqual(called, false);
});

test('an unknown backend name yields an error state, not a crash', async () => {
  const chromeApi = makeChrome();
  const svc = Sync.createSyncService({ chromeApi });
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'dropbox' } });
  const status = await svc.syncNow([]);
  assert.strictEqual(status.state, 'error');
  assert.ok(/dropbox/.test(status.error));
});

test('a third backend can be registered and used', async () => {
  const chromeApi = makeChrome();
  const svc = Sync.createSyncService({ chromeApi, now: () => 42 });
  let pushed = null;
  svc.registerBackend('memory-test', {
    async pull() { return { DFSEED: { code: 'DFSEED', status: 'success', timestamp: 1 } }; },
    async push(_settings, delta) { pushed = delta; },
  });
  await svc.setLocal({ [svc.keys.SETTINGS_KEY]: { syncBackend: 'memory-test' } });
  const status = await svc.syncNow([{ code: 'DFNEW', status: 'expired', timestamp: 2 }]);
  assert.strictEqual(status.state, 'ok');
  assert.deepStrictEqual(Object.keys(pushed).sort(), ['DFNEW', 'DFSEED']);
});

test('parseImport round-trips an export and normalizes records', () => {
  const svc = Sync.createSyncService({ chromeApi: makeChrome() });
  const serialized = svc.serializeExport({
    settings: { syncBackend: 'chrome-sync', syncToken: 'SECRET' },
    records: [{ code: 'DFB', status: 'success', timestamp: 2 }, { code: 'DFA', status: 'expired', timestamp: 1 }],
  });
  const back = svc.parseImport(serialized);
  assert.deepStrictEqual(back.records.map((r) => r.code), ['DFA', 'DFB'], 'records come back sorted');
  assert.strictEqual(back.settings.syncToken, '', 'imported token stays empty');
});

test('parseImport rejects malformed payloads', () => {
  const svc = Sync.createSyncService({ chromeApi: makeChrome() });
  assert.throws(() => svc.parseImport('null'), /không hợp lệ/);
});

/* --- runner ------------------------------------------------------------- */
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
