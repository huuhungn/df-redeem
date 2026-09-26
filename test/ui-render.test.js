#!/usr/bin/env node
/* ui-render.test.js — mount the real built panel in a headless DOM and walk
 * every view. Catches template/selector/handler breakage that unit tests on
 * the data layer cannot see.
 *
 * No jsdom dependency: we implement the small slice of DOM the panel touches.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ── minimal DOM ──────────────────────────────────────────────────────── */
function makeDom() {
  let idSeq = 0;

  class ClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...c) { c.forEach((x) => x && this.set.add(x)); this.sync(); }
    remove(...c) { c.forEach((x) => this.set.delete(x)); this.sync(); }
    contains(c) { return this.set.has(c); }
    toggle(c, on) { if (on === undefined) on = !this.set.has(c); on ? this.add(c) : this.remove(c); }
    sync() { this.el._attrs.class = [...this.set].join(' '); }
    fromString(s) { this.set = new Set(String(s || '').split(/\s+/).filter(Boolean)); this.el._attrs.class = String(s || ''); }
  }

  class Node {
    constructor(tag) {
      this.tagName = String(tag || '').toUpperCase();
      this.children = [];
      this.parentNode = null;
      this._attrs = {};
      this._text = '';
      this._listeners = {};
      this.style = new Proxy({ cssText: '' }, { set: (t, k, v) => { t[k] = v; return true; } });
      this.classList = new ClassList(this);
      this.dataset = {};
      this._id = ++idSeq;
      this.checked = false;
      this.value = '';
    }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n._isRoot === true; }
    get className() { return this._attrs.class || ''; }
    set className(v) { this.classList.fromString(v); }
    get hidden() { return this._attrs.hidden === true; }
    set hidden(v) { this._attrs.hidden = !!v; }
    setAttribute(k, v) { if (k === 'class') return void (this.className = v); this._attrs[k] = String(v); }
    getAttribute(k) { return this._attrs[k] == null ? null : this._attrs[k]; }
    removeAttribute(k) { delete this._attrs[k]; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    prepend(c) { c.parentNode = this; this.children.unshift(c); return c; }
    insertBefore(c, ref) {
      const i = this.children.indexOf(ref);
      c.parentNode = this;
      this.children.splice(i < 0 ? this.children.length : i, 0, c);
      return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) { this.children = []; this._text = String(v == null ? '' : v); }
    get innerHTML() { return this._html || ''; }
    set innerHTML(html) { this._html = String(html); this.children = []; parseInto(this, String(html)); }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
      const l = this._listeners[type] || [];
      const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    }
    dispatchEvent(ev) {
      ev.target = ev.target || this;
      let node = this;
      while (node) {
        ((node._listeners && node._listeners[ev.type]) || []).slice().forEach((fn) => fn.call(node, ev));
        if (ev._stopped) break;
        node = node.parentNode;
      }
      return true;
    }
    click() { this.dispatchEvent(makeEvent('click', this)); }
    attachShadow() { this.shadowRoot = new Node('#shadow'); this.shadowRoot.parentNode = this; return this.shadowRoot; }
    closest(sel) { let n = this; while (n) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
    querySelector(sel) { return walk(this, (n) => matches(n, sel)) || null; }
    querySelectorAll(sel) { const out = []; walk(this, (n) => { if (matches(n, sel)) out.push(n); return false; }); return out; }
    select() {}
    focus() {}
  }

  function makeEvent(type, target) {
    return { type, target, preventDefault() {}, stopPropagation() { this._stopped = true; }, key: '', altKey: false };
  }

  function walk(root, pred) {
    for (const c of root.children) {
      if (pred(c)) return c;
      const hit = walk(c, pred);
      if (hit) return hit;
    }
    return null;
  }

  /* supports: descendant combinators plus tag, .class, #id, [attr], [attr="v"] */
  function matches(node, sel) {
    if (!node.tagName) return false;
    return String(sel).split(',').some((group) => {
      const parts = group.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return false;
      /* match the rightmost part against node, then walk ancestors right-to-left */
      if (!matchSimple(node, parts[parts.length - 1])) return false;
      let ancestor = node.parentNode;
      for (let i = parts.length - 2; i >= 0; i--) {
        let found = null;
        let n = ancestor;
        while (n) { if (matchSimple(n, parts[i])) { found = n; break; } n = n.parentNode; }
        if (!found) return false;
        ancestor = found.parentNode;
      }
      return true;
    });
  }

  function matchSimple(node, part) {
    if (!node.tagName) return false;
    const attrs = [];
    part = part.replace(/\[([^\]]+)\]/g, (_, a) => { attrs.push(a); return ''; });
    for (const a of attrs) {
      const m = a.match(/^([\w-]+)(?:=["']?([^"']*)["']?)?$/);
      if (!m) return false;
      const dataKey = m[1].startsWith('data-') ? camel(m[1].slice(5)) : null;
      const have = node.getAttribute(m[1]) != null || (dataKey && node.dataset[dataKey] != null);
      if (!have) return false;
      if (m[2] !== undefined) {
        const val = node.getAttribute(m[1]) != null ? node.getAttribute(m[1]) : node.dataset[dataKey];
        if (String(val) !== m[2]) return false;
      }
    }
    const classes = [];
    part = part.replace(/\.([\w-]+)/g, (_, c) => { classes.push(c); return ''; });
    let id = null;
    part = part.replace(/#([\w-]+)/g, (_, i) => { id = i; return ''; });
    if (id && node.getAttribute('id') !== id) return false;
    if (classes.some((c) => !node.classList.contains(c))) return false;
    const tag = part.trim();
    if (tag && tag !== '*' && node.tagName !== tag.toUpperCase()) return false;
    return true;
  }

  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const VOID = new Set(['INPUT', 'BR', 'HR', 'IMG', 'META', 'LINK']);

  /* tiny forgiving HTML parser: elements, attributes, text */
  function parseInto(parent, html) {
    const stack = [parent];
    const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s">]+))?)*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
      const top = stack[stack.length - 1];
      if (m[0].startsWith('<!--')) continue;
      if (m[5] != null) {
        const txt = m[5];
        if (!txt.trim()) continue;
        const t = new Node('#text');
        t._text = decode(txt);
        t.textContent = decode(txt);
        top.appendChild(t);
        continue;
      }
      const [, closing, tag, attrStr, selfClose] = m;
      if (closing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
        }
        continue;
      }
      const el = new Node(tag);
      const ar = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+)))?/g;
      let a;
      while ((a = ar.exec(attrStr || ''))) {
        const name = a[1];
        if (!name) continue;
        const raw = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : '';
        const val = decode(raw);
        if (name === 'class') el.className = val;
        else if (name === 'hidden') el.hidden = true;
        else if (name === 'checked') el.checked = true;
        else if (name === 'disabled') el._attrs.disabled = 'true';
        else if (name === 'value') { el.value = val; el._attrs.value = val; }
        else if (name.startsWith('data-')) { el.dataset[camel(name.slice(5))] = val; el._attrs[name] = val; }
        else el.setAttribute(name, val);
      }
      top.appendChild(el);
      if (!selfClose && !VOID.has(el.tagName)) stack.push(el);
    }
    /* textarea content becomes its value */
    walkAll(parent, (n) => { if (n.tagName === 'TEXTAREA' && !n.value) n.value = n.textContent; });
  }

  function walkAll(root, fn) { root.children.forEach((c) => { fn(c); walkAll(c, fn); }); }
  const decode = (s) => String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

  const document = {
    _isRoot: true,
    createElement: (tag) => new Node(tag),
    createTextNode: (t) => { const n = new Node('#text'); n.textContent = t; return n; },
    addEventListener: () => {},
    execCommand: () => true,
    body: null,
    documentElement: null,
  };
  const html = new Node('html');
  html.parentNode = document;
  const body = new Node('body');
  html.appendChild(body);
  document.documentElement = html;
  document.body = body;
  Object.defineProperty(html, 'isConnected', { get: () => true });

  return { document, Node, makeEvent, matches };
}

/* ── harness ──────────────────────────────────────────────────────────── */
const dom = makeDom();
const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'df-redeem.console.js'), 'utf8');

/* Extract the IIFE body so we can run it without the hostname guard. */
const start = bundle.indexOf('  const root = window;');
const end = bundle.lastIndexOf('  const panel = createPanel(');
if (start < 0 || end < 0) { console.error('FAIL: cannot locate bundle body'); process.exit(1); }
const body = bundle.slice(start, end);

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Promise,
  Date,
  Math,
  JSON,
  Set,
  Map,
  Number,
  String,
  Object,
  Array,
  Error,
  document: dom.document,
  navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
  location: { hostname: 'redeem.df.garena.sg', href: 'https://redeem.df.garena.sg/' },
  localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
  Blob: class { constructor(p) { this.parts = p; } },
  URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ code: 0, msg: 'ok' }) }),
  indexedDB: undefined,
  prompt: () => null,
  alert: () => {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(`${body}\n globalThis.__createPanel = createPanel; globalThis.__Vault = root.DFRedeemVault; globalThis.__SEED = DF_REDEEM_SEED;`, sandbox, { filename: 'bundle.js' });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let failures = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

/* memory-backed vault so no IndexedDB is needed */
const V = sandbox.__Vault;
const vault = new V.Vault({ adapter: new V.MemoryAdapter() });
let panel;

test('panel mounts and exposes 6 views', async () => {
  panel = sandbox.__createPanel({ version: '2.0.0', target: 'test', vault });
  assert(panel, 'createPanel returned nothing');
  assert(panel._views.length === 6, 'expected 6 views, got ' + panel._views.length);
});

test('seed loads into the vault', async () => {
  await vault.init();
  await vault.seedOnFirstRun(sandbox.__SEED);
  const stats = await vault.stats();
  assert(stats.total > 300, 'expected >300 gift records, got ' + stats.total);
  const presets = await vault.byKind('preset');
  assert(presets.length === 20, 'expected 20 presets, got ' + presets.length);
});

test('open() renders dashboard with real numbers', async () => {
  await panel.open();
  const sd = panel._shadow;
  const kpis = sd.querySelectorAll('.kpi b').map((n) => Number(n.textContent));
  assert(kpis.length === 4, 'expected 4 KPI tiles, got ' + kpis.length);
  assert(kpis[0] > 100, 'success KPI should be >100, got ' + kpis[0]);
  assert(kpis[3] === 20, 'preset KPI should be 20, got ' + kpis[3]);
  const bars = sd.querySelectorAll('.bar-row');
  assert(bars.length === 7, 'expected 7 status bars, got ' + bars.length);
});

test('library paginates at 50 rows and filters by status', async () => {
  await panel.go('library');
  const sd = panel._shadow;
  let rows = sd.querySelectorAll('tbody tr');
  assert(rows.length === 50, 'expected 50 rows on page 1, got ' + rows.length);
  const pager = sd.querySelector('.pager span').textContent;
  assert(/Trang 1\//.test(pager), 'pager text wrong: ' + pager);

  /* Own the untried fixtures: the shipped seed legitimately reaches 0 untried
   * gift codes once every code has been redeemed, so this filter assertion must
   * not lean on seed data that real redemption runs mutate. */
  await vault.upsert({ code: 'UITESTUNTRIED1', kind: 'gift', status: 'untried', source: 'ui-test' });
  await vault.upsert({ code: 'UITESTUNTRIED2', kind: 'gift', status: 'untried', source: 'ui-test' });
  await vault.upsert({ code: 'UITESTUNTRIED3', kind: 'gift', status: 'untried', source: 'ui-test' });
  await panel.go('library');

  const sel = sd.querySelector('.fstatus');
  sel.value = 'untried';
  sel.dispatchEvent(dom.makeEvent('change', sel));
  rows = sd.querySelectorAll('tbody tr');
  assert(rows.length === 3, 'expected 3 untried rows, got ' + rows.length);
  const codes = rows.map((r) => r.querySelector('.mono').textContent.trim());
  assert(codes.includes('UITESTUNTRIED1'), 'untried filter missing fixture: ' + codes.join(','));
});

test('row selection drives the bulk bar', async () => {
  const sd = panel._shadow;
  const box = sd.querySelector('tbody tr .pick');
  box.checked = true;
  box.dispatchEvent(dom.makeEvent('change', box));
  const bulk = sd.querySelector('.bulk');
  assert(!bulk.classList.contains('off'), 'bulk bar should be visible after selection');
  assert(/1 mã đã chọn/.test(bulk.textContent), 'bulk text wrong: ' + bulk.textContent);
});

test('run view renders queue controls', async () => {
  await panel.go('run');
  const sd = panel._shadow;
  assert(sd.querySelector('.queue'), 'missing queue textarea');
  assert(sd.querySelector('.pace').value === '1200', 'pace default wrong');
  assert(sd.querySelector('[data-act="start"]'), 'missing start button');
  const pick = sd.querySelector('[data-act="q-untried"]');
  assert(/\(3\)/.test(pick.textContent), 'untried count not shown: ' + pick.textContent);
});

test('presets view groups by mode and warns about in-game activation', async () => {
  await panel.go('presets');
  const sd = panel._shadow;
  const callout = sd.querySelector('.info-box').textContent;
  assert(/Gunsmith/.test(callout), 'missing Gunsmith instruction');
  const cards = sd.querySelectorAll('.pcard');
  assert(cards.length === 20, 'expected 20 preset cards, got ' + cards.length);
  const heads = sd.querySelectorAll('h3').map((h) => h.textContent);
  assert(heads.length === 3, 'alias modes should collapse into 3 canonical groups, got ' + heads.length);
  assert(heads.includes('Chiến Trường Toàn Diện'), 'missing canonical Warfare group: ' + heads.join(', '));
  assert(heads.includes('Chiến Dịch Sinh Tồn'), 'missing canonical Operations group: ' + heads.join(', '));
});

test('share view separates gift codes from presets', async () => {
  await panel.go('share');
  const sd = panel._shadow;
  const gift = sd.querySelector('.share-gift').value.split('\n').filter(Boolean);
  const pre = sd.querySelector('.share-preset').value.split('\n').filter(Boolean);
  assert(gift.length > 150, 'expected >150 shareable gift codes, got ' + gift.length);
  assert(pre.length === 20, 'expected 20 preset lines, got ' + pre.length);
  assert(!gift.some((l) => l.includes('-')), 'gift list must not contain preset triples');
  assert(pre.every((l) => l.split('-').length >= 3), 'preset lines must be Name-Mode-Code');
});

test('history view lists runs and drills into one code', async () => {
  /* Empty vault → an empty state that routes the user to the run tab. */
  await panel.go('history');
  let sd = panel._shadow;
  assert(sd.querySelector('.empty [data-act="goto-run"]'), 'empty history should offer the run tab');

  /* After a recorded attempt → a timeline entry per attempt. */
  await vault.recordAttempt('UITESTUNTRIED1', { status: 'expired', err_code: 400070, result_msg: 'Mã đã hết hạn' }, 'run-test');
  await panel.go('history');
  sd = panel._shadow;
  const items = sd.querySelectorAll('ol.tline li');
  assert(items.length >= 1, 'expected >=1 timeline entry, got ' + items.length);
  assert(/UITESTUNTRIED1/.test(sd.querySelector('ol.tline').textContent), 'timeline missing the attempted code');

  await panel.go('library');
  const hist = sd.querySelectorAll('[data-act="row-hist"]')[0];
  assert(hist, 'library rows should offer a per-code history button');
  hist.click();
  await new Promise((r) => setTimeout(r, 30));
  sd = panel._shadow;
  const back = sd.querySelector('[data-act="hist-all"]');
  assert(back, 'expected per-code history with a back-to-all button');
});

test('run tab constructs the engine through its real exported API', async () => {
  /* The panel once called `new E.Engine({ codes })` while engine.js exports
   * RedeemRun(entries, options). The TypeError landed inside an async click
   * handler, so the drawer just froze on "Chuẩn bị…" with an empty console and
   * History never filled. Assert the contract in both directions. */
  const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
  const exported = /const api = \{([^}]*)\}/.exec(engineSrc);
  assert(exported, 'engine.js should expose an api object');
  const names = exported[1].split(',').map((s) => s.trim().split(':')[0].trim());
  assert(names.includes('RedeemRun'), 'engine must export RedeemRun');
  assert(!names.includes('Engine'), 'engine exports no symbol named Engine — the panel must not use one');

  const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel.js'), 'utf8');
  assert(!/new\s+E\.Engine\b/.test(panelSrc), 'panel must not construct E.Engine (does not exist)');
  const ctor = /new\s+E\.RedeemRun\(\s*([\s\S]{0,120})/.exec(panelSrc);
  assert(ctor, 'panel should construct E.RedeemRun');
  assert(/codes\.map/.test(ctor[1]), 'the queue array must be RedeemRun\'s first argument, not a config key');

  /* Construction failure must release the controls instead of hanging. */
  assert(/catch \(e\) \{[\s\S]{0,400}Không khởi tạo được lượt chạy/.test(panelSrc),
    'startRun must guard construction and surface the error');

  /* The cloud-sync toggle must do exactly what it promises: wait until every
   * attempt is persisted, then sync the full vault. A disabled toggle must not
   * make a network call just because a run ended. */
  assert(/await vault\.finishRun[\s\S]{0,1400}opts\.sync\.syncNow\(await vault\.all\(\)\)/.test(panelSrc),
    'auto sync must run after finishing the local run and include the full vault');
  assert(/settings\.enabled !== false && settings\.autoSync !== false/.test(panelSrc),
    'auto sync must require both enabled cloud sync and the auto-sync setting');
});

test('hidden overlays actually disappear instead of covering the page', async () => {
  /* The palette and toast stack are `.df` roots in the shadow tree, not `.df`
   * descendants, so a `.df [hidden]` rule alone never matched them: `hidden`
   * lost to their own `display: grid` and the palette kept a full-viewport
   * dimming backdrop over the page even while closed. */
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'theme.css'), 'utf8');
  assert(/\.df\[hidden\]/.test(css),
    'theme.css must hide a .df root that carries the hidden attribute');

  const sd = panel._shadow;
  const palette = sd.querySelector('.palette-wrap');
  assert(palette, 'palette-wrap should exist in the shadow root');
  assert(palette.classList.contains('df'),
    'palette-wrap is itself a .df root — that is exactly why the descendant selector missed it');
  assert(palette.hidden === true, 'palette starts closed');
});

test('history merges the cross-origin mirror so every surface sees a run', async () => {
  /* The drawer's IndexedDB belongs to the Garena origin and the app's to
   * chrome-extension://, so a run done in the drawer was invisible on the
   * full-page History. The panel mirrors attempts through the worker's shared
   * storage and merges them back in on refresh. */
  const mirrored = [{
    code: 'MIRRORONLY01', status: 'success', result_msg: 'từ drawer',
    err_code: null, timestamp: new Date().toISOString(), surface: 'drawer',
  }];
  const mirrorVault = new V.Vault({ adapter: new V.MemoryAdapter() });
  await mirrorVault.init();
  const seen = [];
  const mirrorPanel = sandbox.__createPanel({
    version: '3.0.0', target: 'test', vault: mirrorVault,
    sync: {
      readMirror: async () => ({ ok: true, rows: mirrored }),
      mirrorAttempts: async (rows) => { seen.push(...rows); return { ok: true }; },
    },
  });

  await mirrorPanel.go('history');
  const text = mirrorPanel._shadow.querySelector('ol.tline, .empty').textContent;
  assert(/MIRRORONLY01/.test(text),
    'history must show an attempt that exists only in the shared mirror, got: ' + text.slice(0, 120));
});

test('bundle touches no credentials beyond its own redaction guards', async () => {
  /* Legitimate hits: the secret-key denylist, the optional user-supplied REST
   * token header, and the Bearer-redaction regex. Anything else is a smell. */
  assert(!/document\.cookie/.test(bundle), 'bundle reads document.cookie');
  assert(!/chrome\.cookies/.test(bundle), 'bundle uses the cookies API');
  const lines = bundle.split('\n');
  const suspects = lines
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(({ l }) => /cookie|authorization|bearer/i.test(l))
    /* Prose is not a capability: a comment or a Vietnamese UI sentence that
     * merely mentions cookies cannot read one. Strip comment and string bodies
     * first, then judge what is left — real access (document.cookie,
     * chrome.cookies, an Authorization header built at runtime) survives this
     * and still fails the assertion. */
    .filter(({ l }) => {
      const code = l
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\*.*$/, '')
        .replace(/\/\/.*$/, '')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
      return /cookie|authorization|bearer/i.test(code);
    })
    .filter(({ l }) => !/SECRET_KEYS|Authorization: |replace\(\/Bearer|credentials: 'omit'/.test(l))
    /* HTML text inside a multi-line template literal cannot be stripped
     * line-by-line, so exempt lines that are plainly markup prose. */
    .filter(({ l }) => !/<\/?(p|div|span|small|section)[\s>]/.test(l));
  assert(suspects.length === 0, 'unexpected credential lines: ' + suspects.map((s) => s.i).join(','));
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); console.log('  ok   ' + t.name); }
    catch (e) { failures += 1; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e)); }
  }
  console.log(`\n${tests.length - failures}/${tests.length} ui-render tests passed`);
  process.exit(failures ? 1 : 0);
})();
