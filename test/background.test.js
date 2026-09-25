#!/usr/bin/env node
/* background.test.js — exercise the generated service worker's sync broker
 * against a fake chrome.* API. The worker is the only component allowed to
 * read the sync token, so these tests pin that boundary. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const worker = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/* Build a minimal chrome.* stand-in plus capture hooks. */
function makeChrome(options) {
  const opts = options || {};
  const localBag = {};
  const syncBag = {};
  const messageListeners = [];
  const actionListeners = [];
  const tabCalls = [];

  const area = (bag) => ({
    async get(keys) {
      if (keys == null) return { ...bag };
      if (typeof keys === 'string') return bag[keys] === undefined ? {} : { [keys]: bag[keys] };
      /* Chrome also accepts an object of key -> default value; sync.js uses
       * that form, so the fake has to honour it or every read looks empty. */
      if (!Array.isArray(keys) && typeof keys === 'object') {
        const out = {};
        for (const [k, fallback] of Object.entries(keys)) out[k] = bag[k] === undefined ? fallback : bag[k];
        return out;
      }
      const out = {};
      for (const k of [].concat(keys)) if (bag[k] !== undefined) out[k] = bag[k];
      return out;
    },
    async set(items) { Object.assign(bag, items); },
    async remove(keys) { for (const k of [].concat(keys)) delete bag[k]; },
    async clear() { for (const k of Object.keys(bag)) delete bag[k]; },
    QUOTA_BYTES: 102400,
  });

  return {
    chrome: {
      storage: { local: area(localBag), sync: area(syncBag) },
      runtime: { onMessage: { addListener: (fn) => messageListeners.push(fn) }, lastError: null },
      action: { onClicked: { addListener: (fn) => actionListeners.push(fn) } },
      tabs: {
        create: async (info) => { tabCalls.push(info); return { id: 99, ...info }; },
        sendMessage: async () => ({ ok: true }),
        /* The popup-driven open-drawer path asks for the active tab. Default to
         * a tab already on the redeem page; tests that need the other branch
         * override activeTab. */
        query: async () => [opts.activeTab || { id: 7, url: 'https://redeem.df.garena.sg/vi/cdkgarena.html' }],
      },
      scripting: { executeScript: async () => [] },
    },
    localBag,
    syncBag,
    messageListeners,
    tabCalls,
    fetchCalls: opts.fetchCalls || [],
  };
}

function loadWorker(env) {
  const sandbox = {
    chrome: env.chrome,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Error,
    Set,
    Map,
    fetch: async (url, init) => {
      env.fetchCalls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ version: 1, delta: {} }) };
    },
    self: {},
    URL,
    URLSearchParams,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = undefined;
  vm.createContext(sandbox);
  vm.runInContext(worker, sandbox, { filename: 'background.js' });
  return sandbox;
}

/* Send a message the way chrome.runtime.sendMessage would, and await respond(). */
function send(env, op, payload) {
  return new Promise((resolve, reject) => {
    const listener = env.messageListeners[0];
    if (!listener) { reject(new Error('worker registered no message listener')); return; }
    const kept = listener({ type: 'DF_REDEEM_SYNC', op, payload }, {}, resolve);
    if (kept !== true) reject(new Error('listener must return true to keep the channel open'));
  });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('worker registers separate listeners for sync and for opening the drawer', async () => {
  const env = makeChrome();
  loadWorker(env);
  /* v3 attaches a popup to the toolbar icon, so action.onClicked never fires;
   * the popup asks the worker to open the in-page drawer by message instead.
   * One listener per message type, each returning true for its own type only. */
  assert(env.messageListeners.length === 2, 'expected sync + open-drawer listeners, got ' + env.messageListeners.length);
  const sync = env.messageListeners.find((fn) => fn({ type: 'DF_REDEEM_SYNC', op: 'status' }, {}, () => {}) === true);
  const open = env.messageListeners.find((fn) => fn({ type: 'DF_REDEEM_OPEN_DRAWER' }, {}, () => {}) === true);
  assert(sync, 'no listener claims DF_REDEEM_SYNC');
  assert(open, 'no listener claims DF_REDEEM_OPEN_DRAWER');
  assert(sync !== open, 'one listener must not answer both message types');
  /* An unknown type must be declined by every listener, not swallowed. */
  assert(env.messageListeners.every((fn) => fn({ type: 'DF_SOMETHING_ELSE' }, {}, () => {}) === false),
    'a listener claimed an unrelated message type');
});

test('opening the drawer on a foreign tab opens the redeem page instead', async () => {
  const env = makeChrome({ activeTab: { id: 3, url: 'https://example.com/' } });
  loadWorker(env);
  const open = env.messageListeners.find((fn) => fn({ type: 'DF_REDEEM_OPEN_DRAWER' }, {}, () => {}) === true);
  const reply = await new Promise((resolve) => {
    open({ type: 'DF_REDEEM_OPEN_DRAWER' }, {}, resolve);
  });
  assert(reply.ok === true, 'expected a successful reply, got ' + JSON.stringify(reply));
  assert(reply.opened === 'new-tab', 'expected a new tab, got ' + reply.opened);
  const created = env.tabCalls.map((c) => c.url);
  assert(created.some((u) => /cdkgarena\.html$/.test(u)), 'must open the real form, got ' + created.join(','));
});

test('getSettings returns defaults and never leaks the token', async () => {
  const env = makeChrome();
  loadWorker(env);
  env.localBag.dfRedeemSettings = { syncBackend: 'rest', syncEndpoint: 'https://x.test/api', syncToken: 'super-secret-value' };
  const settings = await send(env, 'getSettings');
  assert(settings.enabled === true, 'enabled should round-trip');
  assert(settings.endpoint === 'https://x.test/api', 'endpoint should round-trip');
  assert(settings.hasToken === true, 'hasToken should be true when a token exists');
  const serialized = JSON.stringify(settings);
  assert(!serialized.includes('super-secret-value'), 'token leaked out of the worker: ' + serialized);
  assert(settings.token === undefined, 'token key must be absent');
});

test('setSettings preserves an existing token when none is supplied', async () => {
  const env = makeChrome();
  loadWorker(env);
  env.localBag.dfRedeemSettings = { syncBackend: 'rest', syncEndpoint: 'https://x.test/api', syncToken: 'keep-me' };
  const res = await send(env, 'setSettings', { enabled: true, backend: 'rest', endpoint: 'https://y.test/api' });
  assert(res.ok === true, 'setSettings should succeed');
  const stored = env.localBag.dfRedeemSettings;
  assert(stored.syncToken === 'keep-me', 'omitted token must be preserved, got ' + stored.syncToken);
  assert(stored.syncEndpoint === 'https://y.test/api', 'endpoint should update');
  assert(stored.syncBackend === 'rest', 'enabled should update');
});

test('setSettings overwrites the token when a new one is supplied', async () => {
  const env = makeChrome();
  loadWorker(env);
  env.localBag.dfRedeemSettings = { syncBackend: 'rest', syncEndpoint: 'https://x.test/api', syncToken: 'old' };
  await send(env, 'setSettings', { token: 'new-token' });
  assert(env.localBag.dfRedeemSettings.syncToken === 'new-token', 'token should update when provided');
});

test('push refuses to run while sync is disabled', async () => {
  const env = makeChrome();
  loadWorker(env);
  const res = await send(env, 'push', { records: [{ code: 'ABC', status: 'success' }] });
  assert(res.ok === false, 'push should fail when sync is off');
  assert(/tắt/i.test(res.error || ''), 'error should explain sync is off, got: ' + res.error);
  assert(env.fetchCalls.length === 0, 'disabled sync must not hit the network');
});

test('push through chrome-sync writes a compact delta', async () => {
  const env = makeChrome();
  loadWorker(env);
  env.localBag.dfRedeemSettings = { syncBackend: 'chrome-sync', syncEndpoint: '', syncToken: '', autoSyncMinutes: 15 };
  const res = await send(env, 'push', {
    records: [
      { code: 'DFONE', status: 'success', last_tried: '2026-09-25T10:00:00.000Z' },
      { code: 'DFTWO', status: 'expired', last_tried: '2026-09-25T10:01:00.000Z' },
    ],
  });
  assert(res.ok === true, 'push should succeed: ' + JSON.stringify(res));
  assert(env.fetchCalls.length === 0, 'chrome-sync backend must not use fetch');
  const stored = JSON.stringify(env.syncBag);
  assert(stored.includes('DFONE') && stored.includes('DFTWO'), 'delta should contain both codes: ' + stored);
});

test('push through the REST backend sends the token as a header, not a body field', async () => {
  const env = makeChrome();
  loadWorker(env);
  env.localBag.dfRedeemSettings = { syncBackend: 'rest', syncEndpoint: 'https://vault.test/api/vault', syncToken: 'tok-abc123', autoSyncMinutes: 15 };
  const res = await send(env, 'push', { records: [{ code: 'DFREST', status: 'success', last_tried: '2026-09-25T10:00:00.000Z' }] });
  assert(res.ok === true, 'REST push should succeed: ' + JSON.stringify(res));
  assert(env.fetchCalls.length >= 1, 'REST push should call fetch');
  for (const call of env.fetchCalls) {
    const body = call.init && call.init.body ? String(call.init.body) : '';
    assert(!body.includes('tok-abc123'), 'token must never appear in the request body');
  }
  const posted = env.fetchCalls.find((c) => c.init && c.init.method === 'POST');
  assert(posted, 'expected a POST to the endpoint');
  assert(/DFREST/.test(String(posted.init.body)), 'POST body should carry the delta');
});

test('wipe clears the cloud copy and the stored settings', async () => {
  const env = makeChrome();
  loadWorker(env);
  env.localBag.dfRedeemSettings = { syncBackend: 'chrome-sync', syncToken: 'gone-soon' };
  env.syncBag.dfRedeemSyncDelta = { DFONE: { s: 'success' } };
  const res = await send(env, 'wipe');
  assert(res.ok === true, 'wipe should succeed');
  assert(Object.keys(env.syncBag).length === 0, 'cloud copy should be empty');
  assert(env.localBag.dfRedeemSettings === undefined, 'settings (with token) should be removed');
});

test('an unknown op is rejected rather than silently ignored', async () => {
  const env = makeChrome();
  loadWorker(env);
  const res = await send(env, 'definitely-not-an-op');
  assert(res.ok === false, 'unknown op should fail');
  assert(/không hợp lệ/i.test(res.error || ''), 'error should name the bad op, got: ' + res.error);
});

test('worker source keeps no cookie access and redacts bearer tokens in errors', async () => {
  assert(!/document\.cookie|chrome\.cookies/.test(worker), 'worker must not touch cookies');
  assert(/Bearer \[redacted\]/.test(worker), 'worker should redact bearer tokens in error text');
});

test('worker opens the real redeem form, not the /vi/ landing page', async () => {
  /* redeem.df.garena.sg/vi/ has no code form at all — sending the user there
   * is a dead end, so the exact path is pinned here. */
  assert(/cdkgarena\.html/.test(worker), 'worker must open /vi/cdkgarena.html');
  assert(!/url: ['"]https:\/\/redeem\.df\.garena\.sg\/vi\/['"]/.test(worker), 'worker must not open the bare /vi/ landing page');
  assert(!/url: REDEEM_URL/.test(worker), 'REDEEM_URL must be interpolated at build time, not left as an identifier');
});

(async () => {
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('ok - ' + t.name); }
    catch (e) {
      failures += 1;
      console.log('FAIL - ' + t.name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e));
    }
  }
  console.log(`\n${tests.length - failures} passed, ${failures} failed, ${tests.length} total`);
  process.exit(failures ? 1 : 0);
})();
