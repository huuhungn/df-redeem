'use strict';
/* Exercise generated bootstraps and the isolated relay, not regex-only wiring. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'extension', file), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function harness() {
  const events = {};
  const storageListeners = [];
  const posts = [];
  const elements = new Map();
  function el() {
    return { textContent: '', className: '', hidden: false, disabled: false, title: '', style: {}, dataset: {},
      classList: { toggle() {} }, attrs: {}, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      querySelector() { return null; }, querySelectorAll() { return []; },
      appendChild(child) { if (child && child.id) elements.set(child.id, child); }, cloneNode() { return el(); },
    };
  }
  let refreshes = 0;
  let backups = 0;
  let options;
  const panel = { _shadow: el(), _shell: el(), _host: el(),
    mountLauncher() {}, open: async () => {}, go: async () => {},
    refreshSync: async () => { refreshes++; }, syncNow: async () => { backups++; },
  };
  const box = {
    console, URL, Date, setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    location: { origin: 'https://redeem.df.garena.sg', href: 'https://redeem.df.garena.sg/vi/cdkgarena.html', hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { documentElement: { dataset: {}, appendChild() {} }, body: el(),
      addEventListener() {}, querySelector: () => el(), querySelectorAll: () => [],
      createElement: el, getElementById(id) { if (!elements.has(id)) elements.set(id, el()); return elements.get(id); },
    },
    MutationObserver: class { observe() {} },
    addEventListener(type, fn) { (events[type] ||= []).push(fn); },
    removeEventListener() {},
    postMessage(data, origin) { posts.push({ data, origin }); },
    createPanel(opts) { options = opts; return panel; },
    chrome: {
      runtime: { sendMessage: async () => ({}), onMessage: { addListener() {} } },
      storage: { onChanged: { addListener(fn) { storageListeners.push(fn); } } },
    },
  };
  box.window = box;
  vm.createContext(box);
  return { box, events, storageListeners, posts, elements, panel,
    get options() { return options; }, get refreshes() { return refreshes; }, get backups() { return backups; },
  };
}
function bootstrap(file, marker) {
  const source = read(file);
  const start = source.indexOf('  const root = window;') + '  const root = window;'.length;
  const end = source.lastIndexOf(marker);
  assert(start > 0 && end > start, 'known bundle boundary');
  return source.slice(0, start) + '\n' + source.slice(end);
}

test('isolated relay invalidates sync status without exposing stored values', () => {
  const h = harness();
  vm.runInContext(read('bridge.js'), h.box);
  assert.equal(h.storageListeners.length, 1, 'listen to worker storage updates');
  const notify = h.storageListeners[0];
  notify({ other: { newValue: 'ignore' } }, 'local');
  notify({ dfRedeemSyncStatus: { newValue: 'ignore' } }, 'sync');
  assert.equal(h.posts.length, 0);
  for (const key of ['dfRedeemSyncStatus', 'dfRedeemSettings']) {
    notify({ [key]: { oldValue: { secret: 'old' }, newValue: { secret: 'private' } } }, 'local');
  }
  assert.equal(h.posts.length, 2);
  for (const post of h.posts) {
    assert.deepEqual(JSON.parse(JSON.stringify(post.data)), { channel: 'df-redeem-sync-changed' });
    assert.equal(post.origin, h.box.location.origin);
  }
});

test('MAIN bootstrap refreshes on relay events and rejects other frames', async () => {
  const h = harness();
  vm.runInContext(bootstrap('content.js', '  const store = {'), h.box);
  const data = { channel: 'df-redeem-sync-changed' };
  for (const fn of h.events.message || []) fn({ source: {}, data });
  assert.equal(h.refreshes, 0);
  h.box.__event = data;
  /* Dispatch inside the context so source is exactly its own Window proxy. */
  h.box.__listeners = h.events.message;
  vm.runInContext('__listeners.forEach(fn => fn({ source: window, data: __event }))', h.box);
  assert.equal(h.refreshes, 1, 'refresh the existing panel without reopening it');
});

test('app surface shows the panel status and invokes its public backup action', async () => {
  const h = harness();
  vm.runInContext(bootstrap('app.js', '  const VIEWS ='), h.box);
  assert.equal(h.storageListeners.length, 1);
  h.storageListeners[0]({ unrelated: {} }, 'local');
  h.storageListeners[0]({ dfRedeemSyncStatus: {} }, 'sync');
  assert.equal(h.refreshes, 0);
  h.storageListeners[0]({ dfRedeemSyncStatus: {} }, 'local');
  h.storageListeners[0]({ dfRedeemSettings: {} }, 'local');
  assert.equal(h.refreshes, 2);
  assert.equal(typeof h.options.onSyncChange, 'function');
  h.options.onSyncChange({ state: 'syncing', label: 'Đang đồng bộ…', title: 'Đang sao lưu kho code.', disabled: true });
  const chip = h.elements.get('p-sync-status');
  const button = h.elements.get('p-sync');
  assert.equal(chip.textContent, 'Đang đồng bộ…');
  assert.equal(chip.hidden, false);
  assert.equal(button.disabled, true);
  assert.equal(button.attrs['aria-busy'], 'true');
  h.options.onSyncChange({ state: 'ok', label: 'Đã đồng bộ', title: 'Đã lưu.', disabled: false });
  assert.equal(button.disabled, false);
  await button.listeners.click();
  assert.equal(h.backups, 1);
  assert(/id="p-sync-status"[^>]*role="status"[^>]*aria-live="polite"/.test(read('app.html')));
  /* app.html loads theme.css + app.css only; a chip styled solely in the
   * drawer's styles.css would render as bare text on the page. */
  const pageCss = read('theme.css') + read('app.css');
  assert(/\.df \.sync-chip\s*\{/.test(pageCss), 'the page chip needs a shared rule');
  assert(/\.df \.sync-chip\.st-error/.test(pageCss), 'the page chip needs its error colour');
  /* The higher-specificity `.df .page-acts` wins the cascade, so it is the
   * rule that must lay the chip and both buttons out as one row. */
  assert(/\.df \.page-acts\s*\{[^}]*display:\s*flex/.test(pageCss), 'page actions align as one row');
  assert(!/\.page-acts\s*\{[^}]*display:\s*grid/.test(pageCss), 'no page-acts rule may stack the actions');
});

(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log('ok - ' + name); }
    catch (e) { failures++; console.error('not ok - ' + name + '\n  ' + e.stack); }
  }
  console.log(`${tests.length - failures}/${tests.length} sync-wiring tests passed`);
  process.exitCode = failures ? 1 : 0;
})();
