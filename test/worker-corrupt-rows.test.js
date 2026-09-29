'use strict';
/* The worker's list endpoints parse every KV value they walk:
 *
 *     const row = JSON.parse((await env.VAULT.get(entry.name)) || 'null');
 *
 * An unparseable value throws inside the loop, the top-level handler turns that
 * into a generic 500, and a single bad key therefore hides EVERY cost from
 * EVERY user. KV can legitimately hold a truncated write or a hand-edited
 * value, so one poisoned row must degrade to "skip that row", never to "the
 * feature is down".
 *
 * test/worker.test.js drives the deployed worker over HTTP and so cannot plant
 * a corrupt value; these run the handlers directly against a fake KV. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'worker', 'src', 'index.js');
const source = fs.readFileSync(SRC, 'utf8');

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try { fn(); passed += 1; console.log('ok   ' + name); }
  catch (e) { failed += 1; console.log('FAIL ' + name + ' — ' + (e && e.message ? e.message : e)); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); passed += 1; console.log('ok   ' + name); }
  catch (e) { failed += 1; console.log('FAIL ' + name + ' — ' + (e && e.message ? e.message : e)); }
};

/* Load the module body without its `export default`, exposing the handlers.
 * The worker is an ES module that imports siblings; the VM sandbox has no
 * loader, so inline the imported constants the handlers actually read. */
function loadWorker() {
  const body = source
    .replace(/export default \{[\s\S]*$/, '')
    .replace(/^\s*import\s+[\s\S]*?from\s+'[^']+';\s*$/gm, '');
  const verdictsSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'src', 'verdicts.js'), 'utf8')
    .replace(/export\s+(const|function|let)/g, '$1');
  /* index.js also imports the shared Costs module; it is a UMD that assigns
   * globalThis.DFRedeemCosts rather than an ES export, so alias that to the
   * `Costs` binding the worker body expects. */
  const costsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'costs.js'), 'utf8')
    + '\nconst Costs = globalThis.DFRedeemCosts;\n';
  const sandbox = {
    console, JSON, Math, Date, Object, Array, String, Number, Boolean, Promise,
    Set, Map, RegExp, Error, isNaN, parseInt, parseFloat, encodeURIComponent,
    decodeURIComponent, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    Response, Request, Headers, URL, crypto, atob, btoa,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    verdictsSrc + '\n' + costsSrc + '\n' + body
    + '\n globalThis.__handleCosts = typeof handleCosts === "function" ? handleCosts : null;'
    + '\n globalThis.__handleCostDisputes = typeof handleCostDisputes === "function" ? handleCostDisputes : null;'
    + '\n globalThis.__handlePending = typeof handlePending === "function" ? handlePending : null;',
    sandbox,
    { filename: 'worker-index.js' },
  );
  return sandbox;
}

/* Minimal KV double: only what the list endpoints touch. */
function fakeKV(entries) {
  const store = new Map(Object.entries(entries));
  return {
    list: async ({ prefix = '', limit = 1000 } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name })),
    }),
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
  };
}

const GOOD = JSON.stringify({
  code: 'GOODCODE00000000001',
  value: 295426,
  state: 'confirmed',
  reports: [{ install_id: 'a' }, { install_id: 'b' }],
  updated_at: '2026-09-29T00:00:00.000Z',
});
const DISPUTED = JSON.stringify({
  code: 'DISPUTED000000000001', value: 1000, state: 'disputed', reports: [{ install_id: 'a', value: 1000 }], updated_at: '2026-09-29T00:00:00.000Z',
});

const sandbox = loadWorker();

check('worker exposes the cost list handlers for direct testing', () => {
  assert(typeof sandbox.__handleCosts === 'function', 'handleCosts not reachable');
});

(async () => {
  await checkAsync('GET /costs serves readable rows when a neighbour is corrupt', async () => {
    const env = { VAULT: fakeKV({
      'cost:GOODCODE00000000001': GOOD,
      'cost:CORRUPTROW000000001': '{not valid json',
    }) };
    const res = await sandbox.__handleCosts(env);
    assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
    const body = await res.json();
    assert.strictEqual(body.ok, true, 'body.ok was ' + body.ok);
    const codes = (body.costs || []).map((r) => r.code);
    assert(codes.includes('GOODCODE00000000001'),
      'the readable row vanished because of a corrupt neighbour: ' + JSON.stringify(codes));
  });

  await checkAsync('GET /costs skips the corrupt row rather than inventing one', async () => {
    const env = { VAULT: fakeKV({
      'cost:GOODCODE00000000001': GOOD,
      'cost:CORRUPTROW000000001': '{not valid json',
    }) };
    const body = await (await sandbox.__handleCosts(env)).json();
    assert.strictEqual(body.count, 1, 'expected exactly the one readable row, got ' + body.count);
    assert(!JSON.stringify(body).includes('CORRUPTROW'), 'a corrupt row leaked into the response');
  });

  await checkAsync('a corrupt row does not hide disputes from the admin view', async () => {
    if (typeof sandbox.__handleCostDisputes !== 'function') throw new Error('handleCostDisputes not reachable');
    const env = {
      ADMIN_TOKEN: 'tok',
      VAULT: fakeKV({
        'cost:DISPUTED000000000001': DISPUTED,
        'cost:CORRUPTROW000000001': 'truncated…',
      }),
    };
    const req = new Request('https://x/cost-disputes', { headers: { authorization: 'Bearer tok' } });
    const res = await sandbox.__handleCostDisputes(req, env);
    assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
    const body = await res.json();
    const codes = (body.disputes || body.rows || body.costs || []).map((r) => r.code);
    assert(codes.includes('DISPUTED000000000001'),
      'the disputed row was hidden by a corrupt neighbour: ' + JSON.stringify(codes));
  });

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed === 0 ? 0 : 1);
})();
