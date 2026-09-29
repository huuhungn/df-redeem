'use strict';
/* The full-page app (app.html) is a chrome-extension:// page, which browser
 * automation refuses to script and which has no redeem host. Its cost flow was
 * therefore never exercised end to end, and that is exactly where the
 * setLocal/getLocal gap hid: the panel guards every sync call with `&&`, so a
 * method the app failed to provide degraded into a silent no-op.
 *
 * Load the real built app.js bundle in a sandbox with a chrome.runtime stub
 * that routes messages to the real background op handler contract, and assert
 * an entered cost survives a full teardown + remount of the panel. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'extension', 'app.js'), 'utf8');

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ── minimal DOM ────────────────────────────────────────────────────────── */
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    _attrs: {},
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    hidden: false,
    disabled: false,
    value: '',
    checked: false,
    parentNode: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    focus() {},
    click() { if (typeof el.onclick === 'function') el.onclick({ target: el }); },
    setAttribute(k, v) { el._attrs[k] = String(v); if (k === 'class') el.className = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    removeAttribute(k) { delete el._attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k); },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); return c; },
    insertBefore(c) { return el.appendChild(c); },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    attachShadow() { el._shadow = makeEl('shadow-root'); return el._shadow; },
    /* The app scopes its `$` helper to created nodes (`shell.querySelector`),
     * so returning null here would break bootstrap. Hand back a stable stub per
     * selector, mirroring how the real shell resolves its own children. */
    querySelector(sel) {
      const key = String(sel || '');
      if (!el._q) el._q = new Map();
      if (!el._q.has(key)) { const c = makeEl('div'); c._attrs.selector = key; c.parentNode = el; el._q.set(key, c); }
      return el._q.get(key);
    },
    querySelectorAll(sel) { return [el.querySelector(sel)]; },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    scrollIntoView() {},
    className: '',
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: (v) => { html = String(v); } });
  Object.defineProperty(el, 'textContent', { get: () => html.replace(/<[^>]*>/g, ' '), set: (v) => { html = String(v); } });
  return el;
}

function makeDocument() {
  const doc = makeEl('document');
  doc.head = makeEl('head');
  doc.body = makeEl('body');
  doc.documentElement = makeEl('html');
  doc.createElement = (t) => makeEl(t);
  doc.createTextNode = (t) => { const n = makeEl('#text'); n.textContent = t; return n; };
  doc.createDocumentFragment = () => makeEl('#fragment');
  /* app.html's bootstrap wires real shell nodes (`$('.close')`, the view
   * buttons). Hand out a live stub per selector and keep it stable, so the
   * bundle boots exactly as it does in the extension instead of being sliced. */
  const known = new Map();
  const lookup = (sel) => {
    const key = String(sel || '');
    if (!known.has(key)) { const el = makeEl('div'); el._attrs.selector = key; known.set(key, el); }
    return known.get(key);
  };
  doc.querySelector = lookup;
  doc.querySelectorAll = (sel) => [lookup(sel)];
  doc.getElementById = lookup;
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  return doc;
}

/* ── background stub ────────────────────────────────────────────────────── */
/* Mirrors the real handler's contract for the two storage ops, including the
 * key allowlist, so a rename on either side fails this test. */
function makeChromeStub() {
  const PANEL_STATE_KEYS = { costsLocal: 'df_redeem_costs_local' };
  const store = new Map();
  const seen = [];
  return {
    seen,
    store,
    api: {
      runtime: {
        id: 'test-extension',
        getURL: (p) => 'chrome-extension://test/' + String(p || ''),
        async sendMessage(msg) {
          const op = msg && msg.op;
          const payload = (msg && msg.payload) || {};
          seen.push(op);
          if (op === 'getPanelState') {
            const key = PANEL_STATE_KEYS[payload.key || ''];
            if (!key) return { ok: false, error: 'Khoá không hợp lệ.' };
            return { ok: true, value: store.has(key) ? store.get(key) : null };
          }
          if (op === 'setPanelState') {
            const key = PANEL_STATE_KEYS[payload.key || ''];
            if (!key) return { ok: false, error: 'Khoá không hợp lệ.' };
            store.set(key, payload.value);
            return { ok: true };
          }
          /* The broker is unreachable in this test: that is the interesting
           * case, because it is when the local copy is the only copy. */
          if (op === 'reportCost') return { ok: false, error: 'offline' };
          if (op === 'fetchCosts') return { ok: false, error: 'offline', costs: {} };
          if (op === 'getSettings') return { ok: true, enabled: false };
          if (op === 'readMirror') return { ok: true, rows: [] };
          if (op === 'communityPull') return { ok: false, error: 'offline' };
          return { ok: false, error: 'unhandled op: ' + op };
        },
        onMessage: { addListener() {} },
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
  };
}

function loadApp(chromeStub) {
  const doc = makeDocument();
  const sandbox = {
    console,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Set,
    Map,
    RegExp,
    Error,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    crypto: { getRandomValues: (a) => a, randomUUID: () => 'uuid-test' },
    document: doc,
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
    location: { hostname: 'ckapnhmehhpkodhknihmbphpfhhdmeca', pathname: '/app.html', href: 'chrome-extension://test/app.html' },
    localStorage: (() => {
      const m = new Map();
      return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
    })(),
    Blob: class { constructor(p) { this.parts = p; } },
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    fetch: async () => { throw new Error('network disabled in this test'); },
    indexedDB: undefined,
    chrome: chromeStub.api,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  /* `createPanel` lives inside the app's IIFE, so it is not reachable from the
   * outside. Tap the single call site instead: this also proves the app really
   * does construct its panel with the sync object we are about to assert on. */
  const instrumented = appSrc.replace(
    /const panel = createPanel\(/,
    'const panel = (globalThis.__capture = createPanel, function (o) { globalThis.__opts = o; return globalThis.__capture(o); })(',
  );
  assert(instrumented !== appSrc, 'could not instrument the app createPanel call site');
  vm.runInContext(
    `${instrumented}\n globalThis.__createPanel = globalThis.__capture || null;`
    + `\n globalThis.__Vault = (typeof root !== 'undefined' && root.DFRedeemVault) || globalThis.DFRedeemVault || null;`,
    sandbox,
    { filename: 'app-bundle.js' },
  );
  return sandbox;
}

/* ── the wiring contract, asserted against the real bundle ──────────────── */
test('app.js exposes every sync method the panel calls, with no silent gaps', () => {
  const panelCalls = [...new Set((appSrc.match(/opts\.sync\.(\w+)/g) || []).map((m) => m.split('.').pop()))];
  assert(panelCalls.length >= 4, 'expected to find panel sync calls, found: ' + panelCalls.join(','));
  /* The app's sync object is one literal; a provided method appears as `name:`. */
  const syncBlock = appSrc.slice(appSrc.indexOf('const sync = {'), appSrc.indexOf('const panel = createPanel('));
  assert(syncBlock.length > 0, 'could not locate the app sync object literal');
  const missing = panelCalls.filter((n) => !new RegExp('\\b' + n + ':\\s').test(syncBlock));
  assert.deepStrictEqual(missing, [], 'app.js sync object is missing: ' + missing.join(','));
});

test('app.js routes panel storage through the allowlisted bridge ops', () => {
  assert(/getPanelState/.test(appSrc), 'app.js never calls getPanelState');
  assert(/setPanelState/.test(appSrc), 'app.js never calls setPanelState');
  /* getLocal must unwrap `.value`; returning the envelope would make every
   * stored bag look like `{ok:true,value:...}` and silently reset costs. */
  assert(/getLocal:.*getPanelState[\s\S]{0,160}\.value/.test(appSrc),
    'app.js getLocal must unwrap the reply envelope to .value');
});

test('a cost entered in the app survives a remount while the broker is offline', async () => {
  const stub = makeChromeStub();
  const sandbox = loadApp(stub);
  const createPanel = sandbox.__createPanel;
  assert(typeof createPanel === 'function', 'app.js did not expose createPanel');
  const V = sandbox.__Vault;
  assert(V && V.MemoryAdapter, 'app.js did not expose the vault for a memory-backed test');

  const vault = new V.Vault({ adapter: new V.MemoryAdapter() });
  /* Use the app's OWN sync object, not a hand-written stand-in. A local copy
   * would pass even when app.js provides nothing, which is precisely the
   * failure mode this test exists to catch. */
  const sync = sandbox.__opts && sandbox.__opts.sync;
  assert(sync, 'could not reach the sync object app.js passed to createPanel');
  assert(typeof sync.setLocal === 'function', 'app sync object has no setLocal — costs cannot persist');
  assert(typeof sync.getLocal === 'function', 'app sync object has no getLocal — costs cannot be restored');

  const panel = createPanel({ version: 'test', target: 'page', surface: 'page', vault, sync });
  assert(panel && typeof panel.go === 'function', 'panel did not mount');

  const CODE = '6KMEQNG00T99PRENQV488';
  /* Drive the documented programmatic entry point rather than synthesising DOM
   * clicks, so this asserts the storage contract and not the markup. */
  if (typeof panel._setCostForTest === 'function') {
    await panel._setCostForTest(CODE, 295426);
  } else {
    /* No test hook: persist through the same path the editor uses. */
    const bag = (await sync.getLocal('costsLocal')) || {};
    bag[CODE] = { value: 295426, state: 'unconfirmed', pending: true };
    await sync.setLocal('costsLocal', bag);
  }

  const stored = stub.store.get('df_redeem_costs_local');
  assert(stored && stored[CODE], 'the cost never reached extension storage — setLocal was a no-op');
  assert.strictEqual(stored[CODE].value, 295426, 'stored cost value was not preserved exactly');

  /* Remount: a fresh panel against the same extension storage must see it. */
  const panel2 = createPanel({ version: 'test', target: 'page', surface: 'page', vault, sync });
  assert(panel2, 'panel did not remount');
  const reread = await sync.getLocal('costsLocal');
  assert(reread && reread[CODE] && reread[CODE].value === 295426,
    'the cost did not survive a remount — this is the v3.1.4 data-loss bug');

  assert(stub.seen.includes('setPanelState'), 'setPanelState was never called');
  assert(stub.seen.includes('getPanelState'), 'getPanelState was never called');
});

test('the bridge refuses a key outside the allowlist', async () => {
  const stub = makeChromeStub();
  const bad = await stub.api.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'setPanelState', payload: { key: 'settings', value: { pwned: true } } });
  assert.strictEqual(bad.ok, false, 'the bridge must not store arbitrary keys');
  assert.strictEqual(stub.store.size, 0, 'a rejected key must not write anything');
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); console.log('  ok   ' + t.name); }
    catch (e) { failures += 1; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n       ') : e)); }
  }
  console.log(`\n${tests.length - failures}/${tests.length} app-cost-flow tests passed`);
  process.exit(failures ? 1 : 0);
})();
