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
  let lastFocused = null;

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
    focus() { lastFocused = this; }
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

  return { document, Node, makeEvent, matches, focusState: () => lastFocused };
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
  location: { hostname: 'redeem.df.garena.sg', pathname: '/vi/cdkgarena.html', href: 'https://redeem.df.garena.sg/vi/cdkgarena.html' },
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

/* Derive the expected preset count from the seed the bundle actually shipped.
 * Hardcoding it meant every legitimately added preset broke five unrelated
 * assertions, which trains you to edit the number instead of reading the
 * failure — exactly the wrong reflex for a data-quality suite. */
const SEED_PRESET_ROWS = (sandbox.__SEED && sandbox.__SEED.presets) || [];
const SEED_PRESETS = SEED_PRESET_ROWS.length;

/* Poll for a condition the panel reaches asynchronously. */
async function until(fn, msg, ms = 1000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(msg);
    await new Promise((r) => setTimeout(r, 5));
  }
}
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
  assert(presets.length === SEED_PRESETS, `expected ${SEED_PRESETS} presets, got ` + presets.length);
});

test('open() renders dashboard with real numbers', async () => {
  await panel.open();
  const sd = panel._shadow;
  const kpis = sd.querySelectorAll('.kpi b').map((n) => Number(n.textContent));
  assert(kpis.length === 4, 'expected 4 KPI tiles, got ' + kpis.length);
  assert(kpis[0] > 100, 'success KPI should be >100, got ' + kpis[0]);
  assert(kpis[3] === SEED_PRESETS, `preset KPI should be ${SEED_PRESETS}, got ` + kpis[3]);
  const bars = sd.querySelectorAll('.bar-row');
  /* 9 = the 7 original statuses plus `group_limit` and `sys_error`, which were
   * split out of `mine`/`untried` so the panel can distinguish an account cap
   * and a Garena-side failure from a real verdict. */
  assert(bars.length === 9, 'expected 9 status bars, got ' + bars.length);
});

test('library paginates at 25 rows and filters by status', async () => {
  await panel.go('library');
  const sd = panel._shadow;
  let rows = sd.querySelectorAll('tbody tr');
  /* 25, halved from 50: a full page used to run ~2000px tall in a ~515px drawer,
   * so the pager sat far below the fold. */
  assert(rows.length === 25, 'expected 25 rows on page 1, got ' + rows.length);
  const pager = sd.querySelector('.pager span').textContent;
  assert(/Trang 1\//.test(pager), 'pager text wrong: ' + pager);

  /* Own the untried fixtures: the shipped seed legitimately reaches 0 untried
   * gift codes once every code has been redeemed, so this filter assertion must
   * not lean on seed data that real redemption runs mutate. */
  await vault.upsert({ code: 'UITESTUNTRIED1', kind: 'gift', status: 'untried', source: 'ui-test' });
  await vault.upsert({ code: 'UITESTUNTRIED2', kind: 'gift', status: 'untried', source: 'ui-test' });
  await vault.upsert({ code: 'UITESTUNTRIED3', kind: 'gift', status: 'untried', source: 'ui-test' });
  await panel.go('library');

  /* Status filtering is the chip row only. The old `.fstatus` select drove the
   * same libFilter.status as the chips, so the two controls could disagree on
   * screen while sharing one state; the select was removed rather than synced. */
  assert(!sd.querySelector('.fstatus'), 'redundant status select should be gone');
  const chip = sd.querySelectorAll('.chiprow .chip')
    .find((b) => b.dataset.k === 'untried');
  assert(chip, 'untried chip missing');
  chip.dispatchEvent(dom.makeEvent('click', chip));
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

test('presets view groups by weapon class and warns about in-game activation', async () => {
  await panel.go('presets');
  const sd = panel._shadow;
  const callout = sd.querySelector('.info-box').textContent;
  assert(/Gunsmith/.test(callout), 'missing Gunsmith instruction');
  const cards = sd.querySelectorAll('.pcard');
  assert(cards.length === SEED_PRESETS, `expected ${SEED_PRESETS} preset cards, got ` + cards.length);

  /* Grouping moved from mode to weapon class: mode gave 3 buckets that told you
   * nothing about what a preset fits, while the class answers the question the
   * user actually has ("which of my guns is this for?"). */
  const heads = sd.querySelectorAll('h3').map((h) => h.textContent);
  assert(heads.includes('Súng Trường Tấn Công'), 'missing assault rifle group: ' + heads.join(', '));
  assert(heads.includes('Súng Tiểu Liên'), 'missing SMG group: ' + heads.join(', '));
  /* Raw weapon strings produced 18 buckets for 20 presets; the resolved
   * grouping must be materially coarser or it is not a grouping. */
  assert(heads.length <= 8, 'weapon classes should stay coarse, got ' + heads.length);

  /* Assault rifles outnumber every other class in the shipped data, so the
   * in-game class order (assault rifle first) must lead the page. */
  assert(heads[0] === 'Súng Trường Tấn Công', 'class order should follow Gunsmith, got ' + heads[0]);

  /* Every card must still show a copyable code and its mode. */
  assert(sd.querySelectorAll('.pc-code').length === SEED_PRESETS, 'every preset needs a code element');
  assert(sd.querySelectorAll('.pc-mode').length === SEED_PRESETS, 'every preset needs a mode chip');
});

test('preset class chips filter the grid', async () => {
  await panel.go('presets');
  const sd = panel._shadow;
  const chips = sd.querySelectorAll('.chiprow .chip');
  assert(chips.length >= 3, 'expected per-class chips, got ' + chips.length);

  const smg = chips.find((c) => c.dataset.k === 'smg');
  assert(smg, 'missing SMG chip');
  /* The chip label carries its own count so you can see how many presets a
   * class holds before clicking into it. */
  const want = Number((smg.textContent.match(/(\d+)/) || [])[1]);
  smg.dispatchEvent(dom.makeEvent('click', smg));

  const heads = sd.querySelectorAll('h3').map((h) => h.textContent);
  assert(heads.length === 1 && heads[0] === 'Súng Tiểu Liên', 'chip should isolate one class: ' + heads.join(', '));
  assert(sd.querySelectorAll('.pcard').length === want,
    'chip count must match the filtered grid: said ' + want + ', rendered ' + sd.querySelectorAll('.pcard').length);

  /* Clearing restores the full grid rather than leaving a filtered view with no
   * visible reason for the missing rows. */
  const clear = sd.querySelector('[data-act="pclear"]');
  assert(clear, 'missing clear-filter button while filtered');
  clear.dispatchEvent(dom.makeEvent('click', clear));
  assert(sd.querySelectorAll('.pcard').length === SEED_PRESETS, 'clearing should restore all presets');
});

test('page-surface filter replay targets the clicked chip instead of the first chip', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'build.js'), 'utf8');
  assert(source.includes("+ (btn.dataset.k ? '[data-k=\"' + btn.dataset.k + '\"]' : '')"),
    'page clone must preserve data-k when replaying a filter click');
});

/* app.html replays every tick and keystroke from its cloned view onto the
 * drawer original. Pairing by class alone sent a tick on any Library row to
 * row 1 (every row checkbox is .pick), and blindly restoring the caret threw
 * InvalidStateError on checkbox and number inputs. Run the shipped pairing
 * helpers against a rendered Library page. */
test('page-surface control replay pairs a row checkbox with its own row', async () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'extension', 'app.js'), 'utf8');
  const grab = (name) => {
    const start = app.indexOf(name);
    assert(start >= 0, `app.js is missing ${name}`);
    let depth = 0;
    for (let i = app.indexOf('{', start); i < app.length; i++) {
      if (app[i] === '{') depth += 1;
      if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
    }
    throw new Error('unbalanced ' + name);
  };
  const helpers = new Function(`
    const firstClass = (el) => String((el && el.className) || '').trim().split(' ')[0];
    ${grab('function controlKey(el)')}
    ${grab('function findControl(root, key)')}
    return { controlKey, findControl };`)();

  await panel.go('library');
  const view = panel._shadow.querySelector('.view-host');
  const boxes = view.querySelectorAll('tbody tr .pick');
  assert(boxes.length >= 3, `need several Library rows, got ${boxes.length}`);
  const third = boxes[2];
  const key = helpers.controlKey(third);
  assert(key.cls === 'pick', `row checkbox key class is ${key.cls}`);
  assert(key.code === third.closest('[data-code]').dataset.code, `row checkbox key code is ${key.code}`);
  assert(helpers.findControl(view, key) === third, 'a row tick must land on the same row');

  /* Controls outside a row still resolve by class, and a class that is not a
   * plain identifier never reaches querySelector. */
  const search = view.querySelector('.fq');
  assert(search && helpers.findControl(view, helpers.controlKey(search)) === search, 'the search box must resolve to itself');
  assert(helpers.findControl(view, { cls: 'pick"]', code: null }) === null, 'a non-identifier class must not reach querySelector');

  assert(!/back\.setSelectionRange/.test(app), 'the old unguarded caret restore is back');
  assert(!/'checked' in twin/.test(app), 'change replay must not copy value onto a checkbox twin');
});

test('equipment cost renders with its agreement state and an edit affordance', async () => {
  await panel.go('presets');
  const sd = panel._shadow;

  /* Costs are only shown for Operations/Chiến Dịch builds. Warfare has a
   * deliberately non-editable explanation, preventing users from treating a
   * free loadout as a price and proving that a gun can still have many codes. */
  const rows = sd.querySelectorAll('.pc-cost');
  const priced = rows.filter((row) => !row.classList.contains('pc-cost-na'));
  const notApplicable = rows.filter((row) => row.classList.contains('pc-cost-na'));
  const operations = SEED_PRESET_ROWS.filter((preset) => /Chiến Dịch/i.test(preset.mode));
  assert(priced.length === operations.length, `only Operations presets may show editable cost: ${priced.length}`);
  assert(notApplicable.length === SEED_PRESETS - operations.length, `Warfare presets need a not-applicable cost row: ${notApplicable.length}`);
  assert(priced.every((row) => row.querySelector('[data-act="cost-edit"]')), 'every Operations row needs a cost editor');

  /* The seeded MK4 ships a measured cost, so it must render formatted rather
   * than as a raw integer or a placeholder. */
  const withCost = rows.find((r) => /295\.426/.test(r.textContent));
  assert(withCost, 'seeded MK4 cost should render with thousands separators');
  assert(/Chưa đối chiếu/.test(withCost.textContent),
    'an unconfirmed cost must say so instead of looking agreed: ' + withCost.textContent);

  /* A preset nobody has priced shows a dash and invites a contribution, rather
   * than showing 0 (which reads as "this build is free"). */
  const empty = rows.find((r) => /—/.test(r.textContent));
  assert(empty, 'presets without a cost should show a dash');
  assert(/\+ Thêm/.test(empty.textContent), 'an empty cost should invite a contribution');
});

test('cost editing validates input and never loses a measured number', async () => {
  await panel.go('presets');
  const sd = panel._shadow;

  const edit = sd.querySelectorAll('[data-act="cost-edit"]')[0];
  edit.dispatchEvent(dom.makeEvent('click', edit));
  const input = sd.querySelector('.pc-costedit .costin');
  assert(input, 'clicking edit should open an input');
  assert(sd.querySelectorAll('.pc-costedit').length === 1,
    'only one cost editor may be open at a time');

  /* Garbage is refused in place, with the typed text preserved so the user can
   * fix a typo instead of retyping the whole number. */
  input.value = 'abc';
  const save = sd.querySelector('[data-act="cost-save"]');
  save.dispatchEvent(dom.makeEvent('click', save));
  await new Promise((r) => setTimeout(r, 0));
  const err = sd.querySelector('.pc-costedit .bad');
  assert(err, 'a non-numeric cost should surface an inline error');
  assert(sd.querySelector('.pc-costedit .costin').value === 'abc',
    'the rejected text must survive so the user can correct it');

  /* Cancelling closes the editor without writing anything. */
  const cancel = sd.querySelector('[data-act="cost-cancel"]');
  cancel.dispatchEvent(dom.makeEvent('click', cancel));
  assert(!sd.querySelector('.pc-costedit'), 'cancel should close the editor');
});

test('preset search matches code, resolved name and submitted text', async () => {
  await panel.go('presets');
  const sd = panel._shadow;
  const q = sd.querySelector('.pq');
  assert(q, 'missing preset search box');

  const typeQuery = (value) => {
    const box = sd.querySelector('.pq');
    box.value = value;
    box.dispatchEvent(dom.makeEvent('input', box));
  };

  /* Searching a gun name must find it even though the shipped string for that
   * preset is the Vietnamese client name, not the catalogue name. */
  typeQuery('SVCH');
  assert(sd.querySelectorAll('.pcard').length === 1, 'SVCH search should match one preset');

  /* Searching a pasted code must find it regardless of class. */
  typeQuery('MP5');
  const found = sd.querySelectorAll('.pcard').length;
  assert(found >= 1, 'MP5 search should match at least one preset, got ' + found);

  typeQuery('ZZZNOTHINGZZZ');
  assert(sd.querySelectorAll('.pcard').length === 0, 'nonsense search should match nothing');
  assert(sd.querySelector('.empty'), 'empty search needs an empty state');
});

test('share view separates gift codes from presets', async () => {
  await panel.go('share');
  const sd = panel._shadow;
  const gift = sd.querySelector('.share-gift').value.split('\n').filter(Boolean);
  const pre = sd.querySelector('.share-preset').value.split('\n').filter(Boolean);
  assert(gift.length > 150, 'expected >150 shareable gift codes, got ' + gift.length);
  assert(pre.length === SEED_PRESETS, `expected ${SEED_PRESETS} preset lines, got ` + pre.length);
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
    'auto sync must require both enabled personal backup and the auto-backup setting');
  assert(/syncCommunityVault\(\{ pull: true, push: true \}\)/.test(panelSrc),
    'community synchronization must remain a separate credential-free flow');
  assert(/Đồng bộ cá nhân lỗi/.test(panelSrc) && /Đồng bộ cộng đồng lỗi/.test(panelSrc),
    'personal-backup and community-sync failures must be labeled separately');
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

test('the drawer shell constrains its row so the view host can scroll', () => {
  /* `.df.shell` is a fixed 100vh grid, but its single row defaulted to `auto`:
   * the drawer then sized to CONTENT (2200px for a 50-row library page), the
   * `.view-host` never overflowed, and rows plus the pager sat below the
   * viewport with no scrollbar anywhere — unreachable. The row must be
   * height-capped for the inner scroller to engage. */
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'styles.css'), 'utf8');
  const shell = css.match(/\.df\.shell\s*\{[^}]*\}/);
  assert(shell, 'styles.css must define .df.shell');
  assert(/grid-template-rows:\s*minmax\(\s*0\s*,\s*1fr\s*\)/.test(shell[0]),
    '.df.shell needs grid-template-rows: minmax(0, 1fr) or the drawer grows past the viewport');
  assert(/overflow:\s*auto/.test(css.match(/\.df \.view-host\s*\{[^}]*\}/)[0]),
    '.view-host must be the scroller');
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
  /* The mirror is merged in after History paints, so wait for it rather than
   * asserting on the first frame. */
  const text = await until(() => {
    const t = mirrorPanel._shadow.querySelector('ol.tline, .empty').textContent;
    return /MIRRORONLY01/.test(t) && t;
  }, 'history must show an attempt that exists only in the shared mirror');
  assert(text);
});

/* A bridge call the test controls: pending until release() or fail(). */
function deferredMirror(rows) {
  let release, fail;
  const calls = [];
  const readMirror = () => { const p = new Promise((res, rej) => { release = () => res({ ok: true, rows }); fail = rej; }); calls.push(p); return p; };
  return { readMirror, calls, release: () => release(), fail: (e) => fail(e) };
}

function mirrorRow(code) {
  return { code, status: 'success', result_msg: 'từ drawer', err_code: null, timestamp: new Date().toISOString(), surface: 'drawer' };
}

async function mirrorPanelWith(sync) {
  const v = new V.Vault({ adapter: new V.MemoryAdapter() });
  await v.init();
  return sandbox.__createPanel({ version: '3.0.0', target: 'test', vault: v, sync });
}

const within = (p, ms) => Promise.race([
  p.then(() => true),
  new Promise((res) => setTimeout(() => res(false), ms)),
]);

test('switching views never waits on the sync bridge', async () => {
  /* The drawer reaches the worker through askBridge, which waits up to 60s
   * for a service worker that may be asleep. Every tab switch awaited that
   * read, so all six views froze on a call only History uses. Navigation must
   * settle on the local vault alone. */
  const m = deferredMirror([mirrorRow('LATEMIRROR01')]);
  const p = await mirrorPanelWith({ readMirror: m.readMirror });
  for (const v of p._views) {
    assert(await within(p.go(v), 500), 'go(' + v + ') blocked on a bridge read that never answered');
    assert(p._shadow.querySelector('.view-host').children.length, v + ' did not paint while the bridge was silent');
  }
  m.release();
});

test('a late mirror reply fills History in without a second navigation', async () => {
  const m = deferredMirror([mirrorRow('LATEMIRROR02')]);
  const p = await mirrorPanelWith({ readMirror: m.readMirror });
  await p.go('history');
  const host = p._shadow.querySelector('.view-host');
  assert(!/LATEMIRROR02/.test(host.textContent), 'mirror row shown before the bridge answered');
  m.release();
  await until(() => /LATEMIRROR02/.test(host.textContent), 'History never picked up the late mirror reply');
});

test('a late mirror reply never paints over the view the user moved to', async () => {
  const m = deferredMirror([mirrorRow('LATEMIRROR03')]);
  const p = await mirrorPanelWith({ readMirror: m.readMirror });
  await p.go('history');
  await p.go('presets');
  m.release();
  await new Promise((r) => setTimeout(r, 20));
  const host = p._shadow.querySelector('.view-host');
  assert(!/LATEMIRROR03/.test(host.textContent) && !host.querySelector('ol.tline'),
    'History repainted over Preset after the user had left it');
  const tab = p._shadow.querySelector('.vtab[aria-selected="true"]');
  assert(tab && tab.dataset.view === 'presets', 'selected tab moved away from Preset');
});

test('merged mirror rows survive the next visit while the bridge is re-read', async () => {
  /* Refreshing local data must not drop the rows the last mirror read added:
   * History would flash the drawer's runs away on every visit until the
   * bridge answered again. */
  let n = 0;
  const later = deferredMirror([mirrorRow('KEEPMIRROR01')]);
  const p = await mirrorPanelWith({
    readMirror: () => (n++ === 0 ? Promise.resolve({ ok: true, rows: [mirrorRow('KEEPMIRROR01')] }) : later.readMirror()),
  });
  await p.go('history');
  const host = p._shadow.querySelector('.view-host');
  await until(() => /KEEPMIRROR01/.test(host.textContent), 'first mirror read never merged');
  await p.go('dashboard');
  await p.go('history');
  assert(/KEEPMIRROR01/.test(host.textContent), 'History dropped the mirrored run while waiting on the bridge');
  later.release();
});

test('History says so when the mirror cannot be read', async () => {
  /* The two transports fail differently: the drawer's askBridge rejects,
   * the app's chrome.runtime.sendMessage resolves {ok:false}. Both used to
   * vanish into a silent catch or read as zero rows, so a History missing
   * every drawer run looked complete. */
  for (const [label, readMirror] of [
    ['rejecting bridge', () => Promise.reject(new Error('Bridge không trả lời.'))],
    ['ok:false reply', () => Promise.resolve({ ok: false, error: 'worker down' })],
  ]) {
    const p = await mirrorPanelWith({ readMirror });
    await p.go('history');
    const host = p._shadow.querySelector('.view-host');
    await until(() => host.querySelector('[data-mirror="error"]'),
      label + ': History gave no sign that the shared mirror was unreadable');
  }
  const ok = await mirrorPanelWith({ readMirror: async () => ({ ok: true, rows: [] }) });
  await ok.go('history');
  await new Promise((r) => setTimeout(r, 20));
  assert(!ok._shadow.querySelector('[data-mirror="error"]'), 'an empty but healthy mirror was reported as an error');
});

test('an orphaned page asks for a page reload instead of offering a useless retry', async () => {
  /* Disabling, reloading or updating the extension leaves the page's content
   * scripts orphaned: every bridge call then fails with "Extension context
   * invalidated." until the page itself is reloaded. The banner used to offer
   * "Thử lại", which only repeated the failure (seen live on v3.2.2). */
  let calls = 0;
  const p = await mirrorPanelWith({
    readMirror: () => { calls++; return Promise.reject(new Error('Extension context invalidated.')); },
  });
  await p.go('history');
  const host = p._shadow.querySelector('.view-host');
  const gone = await until(() => host.querySelector('[data-mirror="gone"]'),
    'an invalidated extension context was reported as a retryable read error');
  assert(!host.querySelector('[data-mirror="error"]'), 'both banners shown at once');
  assert(!gone.querySelector('[data-act="refresh"]'), 'the orphaned banner still offers a retry that cannot work');
  assert(/Tải lại trang/.test(gone.textContent), 'the banner must tell the user to reload the page');
  assert(gone.className.split(/\s+/).includes('warn'), 'the banner must use the warning tone');

  /* The button reloads the page — and only that. */
  let reloads = 0;
  const hadReload = Object.prototype.hasOwnProperty.call(sandbox.location, 'reload');
  const prevReload = sandbox.location.reload;
  sandbox.location.reload = () => { reloads++; };
  try {
    const before = calls;
    gone.querySelector('[data-act="reload-page"]').click();
    await new Promise((r) => setTimeout(r, 10));
    assert(reloads === 1, 'Tải lại trang did not reload the page (reloads=' + reloads + ')');
    assert(calls === before, 'Tải lại trang re-read the bridge instead of reloading');
  } finally {
    if (hadReload) sandbox.location.reload = prevReload; else delete sandbox.location.reload;
  }
});

test('the reload prompt never throws away a run in progress', async () => {
  /* location.reload() kills a running queue mid-code and its unfinished codes
   * would look untried. The button must refuse while a run is active. */
  const p = await mirrorPanelWith({
    readMirror: () => Promise.reject(new Error('Extension context invalidated.')),
  });
  await p.go('run');
  const sd = p._shadow;
  sd.querySelector('.queue').value = 'RELOADGUARD01';
  sd.querySelector('[data-act="start"]').click();
  let reloads = 0;
  const hadReload = Object.prototype.hasOwnProperty.call(sandbox.location, 'reload');
  const prevReload = sandbox.location.reload;
  sandbox.location.reload = () => { reloads++; };
  try {
    /* Fire the action exactly as the banner button would, while the run is live. */
    const btn = sandbox.document.createElement('button');
    btn.setAttribute('data-act', 'reload-page');
    btn.dataset = { act: 'reload-page' };
    sd.querySelector('.view-host').appendChild(btn);
    btn.click();
    await new Promise((r) => setTimeout(r, 10));
    assert(reloads === 0, 'the page was reloaded with a run still in progress');
    assert(/Đang có lượt chạy/.test(sd.querySelector('.toast-wrap').textContent),
      'refusing to reload must say why');
  } finally {
    const stop = sd.querySelector('[data-act="stop"]');
    if (stop) stop.click();
    if (hadReload) sandbox.location.reload = prevReload; else delete sandbox.location.reload;
    await new Promise((r) => setTimeout(r, 400));
  }
});

test('a slow vault read cannot paint an old view over a newer one', async () => {
  /* go() awaits the vault before painting. Two quick switches resolved out of
   * order painted the first view last, with the second tab still selected. */
  const v = new V.Vault({ adapter: new V.MemoryAdapter() });
  await v.init();
  const realAll = v.all.bind(v);
  let gate = null;
  v.all = async () => { if (gate) await gate; return realAll(); };
  const p = sandbox.__createPanel({ version: '3.0.0', target: 'test', vault: v });
  await p.go('dashboard');
  let open;
  gate = new Promise((r) => { open = r; });
  const slow = p.go('history');
  gate = null;
  await p.go('presets');
  open();
  await slow;
  const host = p._shadow.querySelector('.view-host');
  const painted = host.innerHTML;
  await p.go('presets');
  assert(painted === host.innerHTML, 'a stale go(history) painted over Preset');
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

/* Redemption only works on the Garena page. The view warned about being on the
 * wrong page but left "Bắt đầu" enabled, so the warning read as advisory;
 * clicking it produced a wall of network failures that look like dead codes
 * rather than a wrong-page mistake. Render on a non-redeem host and assert the
 * control is actually gated. Uses a second sandbox because the shared one pins
 * hostname to the redeem page for every other test. */
/* ── view-switch hygiene ──────────────────────────────────────────────────
 * Every view paints into the same .view-host element. The three checks below
 * cover what that sharing breaks if nobody resets it, plus the keyboard
 * contract role="tablist" silently promises.
 */
test('switching view resets the shared scroll position', async () => {
  await panel.go('library');
  const host = panel._shadow.querySelector('.view-host');
  host.scrollTop = 1200;
  await panel.go('dashboard');
  assert(host.scrollTop === 0,
    'opening a view must start at its top, not mid-way through the view you left (got ' + host.scrollTop + ')');
});

test('scroll resets even while the vault read is still pending', async () => {
  /* go() awaits refresh() before it paints. A reset placed only after that
   * await leaves the outgoing view frozen at the old offset for as long as the
   * read takes — invisible in a test with an instant in-memory vault, plainly
   * visible on a cold IndexedDB. Hold the read open and assert mid-flight. */
  await panel.go('library');
  const host = panel._shadow.querySelector('.view-host');
  host.scrollTop = 1200;
  const realAll = vault.all.bind(vault);
  let release;
  const gate = new Promise((r) => { release = r; });
  Object.defineProperty(vault, 'all', { configurable: true, value: async (...a) => { await gate; return realAll(...a); } });
  const nav = panel.go('dashboard');
  await new Promise((r) => setTimeout(r, 5));
  const during = host.scrollTop;
  release();
  await nav;
  Object.defineProperty(vault, 'all', { configurable: true, value: realAll });
  assert(during === 0,
    'the view must not stay scrolled while its data loads (got ' + during + ')');
});

test('tabs expose selection and a roving tabindex', async () => {
  await panel.go('library');
  const tabs = panel._shadow.querySelectorAll('.vtab');
  const sel = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
  assert(sel.length === 1, 'exactly one tab must be aria-selected, got ' + sel.length);
  assert(sel[0].dataset.view === 'library', 'the selected tab must be the open view');
  const reachable = tabs.filter((t) => t.tabIndex === 0);
  assert(reachable.length === 1,
    'a tablist takes one Tab stop, not one per tab (got ' + reachable.length + ')');
});

test('arrow keys move between views', async () => {
  await panel.go('dashboard');
  const shadow = panel._shadow;
  const first = shadow.querySelector('.vtab');
  const ev = dom.makeEvent('keydown', first);
  ev.key = 'ArrowRight';
  first.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 10));
  const open = shadow.querySelectorAll('.vtab').find((t) => t.getAttribute('aria-selected') === 'true');
  assert(open && open.dataset.view === panel._views[1],
    'ArrowRight must open the next view, got ' + (open && open.dataset.view));
});

test('icon-only buttons carry a text name', async () => {
  const shadow = panel._shadow;
  const bare = shadow.querySelectorAll('button')
    .filter((b) => (b.textContent || '').trim().length <= 2)
    .filter((b) => !b.getAttribute('aria-label'))
    .map((b) => (b.textContent || '').trim() || '(empty)');
  assert(bare.length === 0,
    'a glyph is not a name to a screen reader; title= alone is not announced reliably: ' + bare.join(' '));
});

test('every text entry field carries a name that survives typing', async () => {
  /* A placeholder is not a label: it disappears on the first keystroke, so a
   * screen-reader user who tabs back into a half-filled field hears only
   * "edit text". A wrapping <label> counts; a sibling div does not. */
  const views = ['dashboard', 'library', 'run', 'presets', 'share', 'history'];
  const unnamed = [];
  for (const v of views) {
    await panel.go(v);
    panel._shadow.querySelectorAll('input,textarea,select')
      .filter((el) => (el.getAttribute('type') || '') !== 'hidden')
      .forEach((el) => {
        const wrapped = (function up(n) {
          return !n ? false : n.tagName === 'LABEL' ? true : up(n.parentNode);
        })(el.parentNode);
        if (!el.getAttribute('aria-label') && !wrapped) {
          unnamed.push(v + '/' + (el.tagName || '?') + ':' + (el.getAttribute('placeholder') || '(no placeholder)').slice(0, 24));
        }
      });
  }
  assert(unnamed.length === 0,
    'a placeholder vanishes as soon as the user types; these fields then have no name: ' + unnamed.join(' | '));
});

test('the run tab disables Bắt đầu when the tab is not on the redeem page', async () => {
  const offDom = makeDom();
  const offSandbox = { ...sandbox };
  offSandbox.document = offDom.document;
  offSandbox.location = { hostname: 'example.com', href: 'https://example.com/' };
  offSandbox.localStorage = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  })();
  offSandbox.window = offSandbox;
  offSandbox.self = offSandbox;
  offSandbox.globalThis = offSandbox;
  vm.createContext(offSandbox);
  vm.runInContext(`${body}\n globalThis.__createPanel = createPanel; globalThis.__Vault = root.DFRedeemVault;`, offSandbox, { filename: 'bundle-offpage.js' });

  /* Memory-backed vault: the off-page sandbox has no IndexedDB either. */
  const OV = offSandbox.__Vault;
  const offVault = new OV.Vault({ adapter: new OV.MemoryAdapter() });
  const panel = offSandbox.__createPanel({ version: 'test', target: 'test', vault: offVault });
  await panel.go('run');
  const shadow = panel._shadow;
  const start = shadow.querySelector('[data-act="start"]');
  assert(start, 'start button missing from the run view');
  /* The harness DOM records a parsed `disabled` attribute in _attrs rather than
   * reflecting it as a property, so check both shapes. */
  const isDisabled = start.disabled === true
    || (start._attrs && start._attrs.disabled != null)
    || (typeof start.getAttribute === 'function' && start.getAttribute('disabled') != null);
  assert(isDisabled, 'Bắt đầu must be disabled off the redeem page');
  const warn = shadow.querySelector('.warn-box');
  assert(warn, 'the wrong-page warning should still render alongside the disabled control');
});

/* The redeem host also serves landing and event pages with no redeem form.
 * Gating on hostname alone let Start run there, and every code in the queue
 * came back failed against a page that never had a form to submit to. */
test('the run tab disables Bắt đầu on the redeem host but off the redeem page', async () => {
  const offDom = makeDom();
  const offSandbox = { ...sandbox };
  offSandbox.document = offDom.document;
  offSandbox.location = { hostname: 'redeem.df.garena.sg', pathname: '/vi/', href: 'https://redeem.df.garena.sg/vi/' };
  offSandbox.localStorage = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  })();
  offSandbox.window = offSandbox;
  offSandbox.self = offSandbox;
  offSandbox.globalThis = offSandbox;
  vm.createContext(offSandbox);
  vm.runInContext(`${body}\n globalThis.__createPanel = createPanel; globalThis.__Vault = root.DFRedeemVault;`, offSandbox, { filename: 'bundle-landing.js' });


  const OV = offSandbox.__Vault;
  const offVault = new OV.Vault({ adapter: new OV.MemoryAdapter() });
  const panel = offSandbox.__createPanel({ version: 'test', target: 'test', vault: offVault });
  await panel.go('run');
  const shadow = panel._shadow;
  const start = shadow.querySelector('[data-act="start"]');
  assert(start, 'start button missing from the run view');
  const isDisabled = start.disabled === true
    || (start._attrs && start._attrs.disabled != null)
    || (typeof start.getAttribute === 'function' && start.getAttribute('disabled') != null);
  assert(isDisabled, 'Bắt đầu must be disabled on the redeem host when the path has no redeem form');
  assert(shadow.querySelector('.run-blocker'), 'the wrong-page warning should render on the landing page too');
});

test('every status the panel can emit has its own dot colour', () => {
  /* panel.js writes `<span class="dot s-${status}">` in the library rows and the
   * history timeline. Only `.fill.s-*` used to be styled, so all nine statuses
   * inherited --primary and the timeline's only per-row signal was one flat
   * teal. jsdom does not cascade shadow CSS, so assert on the stylesheet text. */
  const theme = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'theme.css'), 'utf8');
  const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel.js'), 'utf8');
  const emitted = new Set();
  for (const m of panelSrc.matchAll(/class="dot s-\$\{([^}]+)\}/g)) emitted.add(m[1]);
  assert(emitted.size > 0, 'expected panel.js to emit dot status classes');

  /* Drive this from schema.js, not from the palette: reading theme.css to check
   * theme.css only proves it is self-consistent. A status added to STATUSES
   * without a colour must fail here. */
  const schemaSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'schema.js'), 'utf8');
  const statuses = (schemaSrc.match(/const STATUSES = Object\.freeze\(\[([^\]]+)\]/) || [])[1]
    .split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
  assert(statuses.length >= 8, 'expected the status list from schema.js, saw ' + statuses.length);
  const noVar = statuses.filter((st) => !new RegExp('--s-' + st + ':').test(theme));
  assert(noVar.length === 0, 'these statuses have no colour variable at all: ' + noVar.join(', '));
  /* Having the variable is not enough — the dot rule has to consume it, which
   * is exactly the bug: the palette was complete, .dot.s-* simply never used
   * it and every dot inherited --primary. */
  /* Search only the base cascade: the forced-colors block also names every
   * status, so scanning the whole file lets a missing base rule hide behind the
   * high-contrast override. */
  const base = theme.split('@media (forced-colors: active)')[0];
  const unwired = statuses.filter((st) => !base.includes('.dot.s-' + st + ' {'));
  assert(unwired.length === 0,
    'these statuses fall back to the default teal because .dot.s-* is unstyled: ' + unwired.join(', '));
});

test('preset cards can shrink to their grid track', () => {
  /* .pgrid tracks are minmax(178px, 1fr), but a grid item and a flex item both
   * default to min-width:auto. A 19-digit code and a long mode name therefore
   * set a min-content wider than the track and 2 of 21 cards overflowed their
   * column. Every link in the chain needs min-width:0, so assert on all of it —
   * fixing only the leaf spans left the cards overflowing. */
  const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'components.css'), 'utf8');
  /* Strip comments first: these rules are commented with the very text being
   * asserted, so a search over the raw file passes even when the declaration
   * is deleted. */
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleOf = (sel) => {
    const i = css.indexOf(sel + ' {');
    assert(i !== -1, 'missing rule for ' + sel);
    return css.slice(i, css.indexOf('}', i));
  };
  for (const sel of ['.df .pcard', '.df .pc-meta', '.df .pc-mode', '.df .pc-by']) {
    assert(/min-width:\s*0/.test(ruleOf(sel)),
      sel + ' needs min-width:0 or the auto minimum propagates and the card overflows its track');
  }
  assert(/overflow-wrap:\s*anywhere/.test(ruleOf('.df .pc-code')),
    '.pc-code holds an unbreakable 19-digit id and must be allowed to wrap');
});

test('high contrast keeps the status dot visible', () => {
  /* forced-colors strips background-color outright, so a dot that is only a
   * coloured background becomes invisible and the row loses its signal. */
  const theme = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'theme.css'), 'utf8');
  const block = theme.match(/@media \(forced-colors: active\)\s*\{[\s\S]*?\n\}/);
  assert(block, 'theme.css needs a forced-colors block or high contrast erases every dot');
  assert(/\.dot\s*\{[^}]*border:/.test(block[0]),
    'the forced-colors dot must fall back to a border, which forced colours preserve');
});

test('no two buttons in a view share the same accessible name', async () => {
  /* Share renders Copy / Tải .txt / Tải .csv twice — once for gift codes, once
   * for presets — and every preset row repeats a bare "Copy". By name alone a
   * screen-reader user hears the same word several times with nothing to tell
   * the targets apart. Checked per view: the same label in two different views
   * is fine, because only one view is ever mounted. */
  const views = ['dashboard', 'library', 'run', 'presets', 'share', 'history'];
  const collisions = [];
  for (const v of views) {
    await panel.go(v);
    const seen = new Map();
    panel._shadow.querySelectorAll('button').forEach((b) => {
      if (b.offsetParent === null && b.hidden) return;
      const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
      if (!name) return;
      const act = b.getAttribute('data-act') || '';
      const code = b.getAttribute('data-code') || '';
      const target = act + '|' + code;
      if (seen.has(name) && seen.get(name) !== target) {
        collisions.push(v + ': "' + name + '" (' + seen.get(name) + ' vs ' + target + ')');
      } else seen.set(name, target);
    });
  }
  assert(collisions.length === 0,
    'two different actions answer to the same spoken name: ' + collisions.join(' | '));
});

/* ── HQ review ─────────────────────────────────────────────────────────── */
const HQ_NEW_A = 'HQNEWAAAAAAAAAAAAAAA1';
const HQ_NEW_B = 'HQNEWBBBBBBBBBBBBBBB2';
const HQ_HAVE = 'HQHAVECCCCCCCCCCCCCC3';

/* A panel whose hqFetch stays pending until the test releases it. */
async function hqPanel(reply, extra) {
  const v = new V.Vault({ adapter: new V.MemoryAdapter() });
  await v.init();
  await v.upsert({ kind: 'preset', code: HQ_HAVE.toLowerCase(), weapon: 'Bản của tôi', mode: 'Chiến Dịch Sinh Tồn', author: 'me' });
  let release;
  const calls = [];
  const repaints = [];
  const p = sandbox.__createPanel(Object.assign({
    version: '3.3.0', target: 'test', vault: v,
    sync: { hqFetch: () => { calls.push(1); return new Promise((res) => { release = () => res(reply); }); } },
    onRepaint: (name) => repaints.push(name),
  }, extra || {}));
  await p.go('presets');
  return { p, v, calls, repaints, release: () => release() };
}

const HQ_REPLY = {
  ok: true,
  items: [
    { code: HQ_NEW_A, weapon: 'M4A1', mode: 'Chiến Dịch Sinh Tồn', title: 'M4 leo rank', author: 'HQ', tags: ['meta'] },
    { code: HQ_NEW_B, weapon: 'AKM', mode: 'Chiến Trường Toàn Diện', title: 'AKM giữ điểm', author: 'HQ', tags: [] },
    { code: HQ_HAVE, weapon: 'Vector', mode: 'Chiến Dịch Sinh Tồn', title: 'Đè bản của tôi', author: 'HQ', tags: [] },
    { code: 'not-a-code', weapon: 'Rác', mode: 'x' },
  ],
  prices: { [HQ_NEW_A]: 412000, [HQ_HAVE]: 99000, 'NOTINREPLYXXXXXXXXXXX': 5 },
  failed: [],
};

test('HQ review: button opens a loading frame, then lists new and known codes', async () => {
  const h = await hqPanel(HQ_REPLY);
  const sd = h.p._shadow;
  const btn = sd.querySelector('[data-act="hq-import"]');
  assert(btn, 'Preset view must show the "Nhập từ HQ" button when the host can fetch HQ');
  assert(/Nhập từ HQ/.test(btn.textContent), 'button label must read "Nhập từ HQ"');
  btn.click();
  await until(() => sd.querySelector('.hq-review[aria-busy="true"]'), 'clicking must open a loading frame before the reply');
  assert(h.calls.length === 1, 'one click must fetch once');
  h.release();
  const frame = await until(() => sd.querySelector('.hq-row') && sd.querySelector('.hq-review'),
    'the review must list codes once HQ answers');
  assert(frame.getAttribute('aria-busy') == null, 'the ready frame must no longer be busy');
  const text = frame.textContent;
  assert(text.includes(HQ_NEW_A) && text.includes(HQ_NEW_B), 'both new codes must be listed');
  assert(!/not-a-code/i.test(text), 'a malformed code must never reach the review');
  assert(sd.querySelectorAll('.hq-row').length === 3, 'expected 3 valid rows, got ' + sd.querySelectorAll('.hq-row').length);
  assert(h.repaints.includes('presets'), 'the late repaint must tell the page host to re-clone the view');
});

test('HQ review: a code already in the library shows "đã có" and cannot be picked', async () => {
  const h = await hqPanel(HQ_REPLY);
  const sd = h.p._shadow;
  sd.querySelector('[data-act="hq-import"]').click();
  h.release();
  await until(() => sd.querySelector('.hq-row'), 'review must render');
  const known = sd.querySelectorAll('.hq-row').find((r) => r.textContent.includes(HQ_HAVE));
  assert(known, 'the known code must still be listed so the user sees HQ has it');
  assert(/đã có/.test(known.textContent), 'a code already saved (in any casing) must be marked "đã có"');
  assert(!known.querySelector('[data-act="hq-toggle"]'), 'a known code must have no pick button');
  const toggles = sd.querySelectorAll('[data-act="hq-toggle"]').map((b) => b.dataset.code);
  assert(toggles.length === 2 && toggles.includes(HQ_NEW_A) && toggles.includes(HQ_NEW_B), 'only new codes are pickable: ' + toggles.join(','));
});

test('HQ review: price is shown for reference only and never becomes a cost', async () => {
  const h = await hqPanel(HQ_REPLY);
  const sd = h.p._shadow;
  sd.querySelector('[data-act="hq-import"]').click();
  h.release();
  await until(() => sd.querySelector('.hq-row'), 'review must render');
  const rowA = sd.querySelectorAll('.hq-row').find((r) => r.textContent.includes(HQ_NEW_A));
  const price = rowA.querySelector('.hq-price');
  assert(price && /Giá HQ/.test(price.textContent), 'a priced code must show its HQ price');
  assert(/không dùng làm chi phí/.test(price.getAttribute('title') || ''), 'the price must say it is not used as equipment cost');
  assert(/Giá HQ chỉ để xem/.test(sd.querySelector('.hq-review').textContent), 'the frame must state the price is display-only');
  const rowB = sd.querySelectorAll('.hq-row').find((r) => r.textContent.includes(HQ_NEW_B));
  assert(!rowB.querySelector('.hq-price'), 'an unpriced code must not invent a price');

  sd.querySelector('[data-act="hq-commit"]').click();
  await until(() => !sd.querySelector('.hq-review'), 'import must close the review');
  const saved = (await h.v.presets()).find((r) => String(r.code).toUpperCase() === HQ_NEW_A);
  assert(saved, 'the picked code must be saved');
  const row = await h.v.adapter.get('presets', saved.code);
  for (const rec of [saved, row].filter(Boolean)) {
    assert(!('cost' in rec) && !('cost_state' in rec), 'an HQ import must never carry a cost: ' + JSON.stringify(rec));
  }
  const card = sd.querySelectorAll('.pcard').find((c) => c.textContent.includes(HQ_NEW_A));
  assert(card, 'the imported preset must show in the library grid');
  assert(!/412/.test(card.textContent), 'the preset card must not show the HQ price as its cost');
});

test('HQ review: missing Operations prices point to "Xem thêm" on HQ, and a reload keeps picks', async () => {
  const reply = JSON.parse(JSON.stringify(HQ_REPLY));
  reply.prices = {};
  const h = await hqPanel(reply);
  const sd = h.p._shadow;
  sd.querySelector('[data-act="hq-import"]').click();
  h.release();
  await until(() => sd.querySelector('.hq-row'), 'review must render');
  const hint = sd.querySelector('.hq-hint');
  assert(hint, 'unpriced Operations codes must show the HQ price hint');
  /* Two Operations codes (one new, one saved) lack a price; Warfare never has one. */
  assert(/2 mã Chiến Dịch Sinh Tồn chưa có giá HQ/.test(hint.textContent), 'hint must count unpriced Operations codes: ' + hint.textContent);
  assert(/Xem thêm/.test(hint.textContent), 'the hint must name the "Xem thêm" link on HQ');
  const link = hint.querySelector('a');
  assert(link && link.getAttribute('href') === 'https://www.playdeltaforce.com/events/hq/vi/', 'the hint must link the HQ page');
  assert(link.getAttribute('target') === '_blank' && /noopener/.test(link.getAttribute('rel') || ''), 'the HQ link must open a new tab without an opener');

  sd.querySelector(`[data-act="hq-toggle"][data-code="${HQ_NEW_A}"]`).click();
  reply.prices = { [HQ_NEW_A]: 412000, [HQ_HAVE]: 99000 };
  sd.querySelector('.hq-hint').querySelector('[data-act="hq-import"]').click();
  h.release();
  await until(() => sd.querySelector('.hq-price'), 'a reload must paint the prices HQ now has');
  assert(h.calls.length === 2, 'reload must fetch again, got ' + h.calls.length);
  assert(!sd.querySelector('.hq-hint'), 'once every Operations code is priced the hint must go');
  const pressed = (code) => sd.querySelector(`[data-act="hq-toggle"][data-code="${code}"]`).getAttribute('aria-pressed');
  assert(pressed(HQ_NEW_A) === 'false', 'a reload must keep a code the user unticked');
  assert(pressed(HQ_NEW_B) === 'true', 'a reload must keep a code the user left picked');
});

test('HQ review: toggles drive what is imported and never overwrite a saved code', async () => {
  const h = await hqPanel(HQ_REPLY);
  const sd = h.p._shadow;
  sd.querySelector('[data-act="hq-import"]').click();
  h.release();
  await until(() => sd.querySelector('.hq-row'), 'review must render');
  const commit = () => sd.querySelector('[data-act="hq-commit"]');
  assert(/Nhập 2 mã/.test(commit().textContent), 'every new code starts picked: ' + commit().textContent);

  sd.querySelector('[data-act="hq-pick-none"]').click();
  assert(commit().getAttribute('disabled') != null, 'with nothing picked, import must be disabled');
  sd.querySelector(`[data-act="hq-toggle"][data-code="${HQ_NEW_B}"]`).click();
  const on = sd.querySelector(`[data-act="hq-toggle"][data-code="${HQ_NEW_B}"]`);
  assert(on.getAttribute('aria-pressed') === 'true', 'a picked code must report aria-pressed=true');
  /* The repaint replaces the button; a keyboard user must stay on it. */
  assert(dom.focusState() === on, 'focus must return to the re-rendered toggle of the same code');
  assert(/Nhập 1 mã/.test(commit().textContent), 'picking one code must update the count');

  commit().click();
  await until(() => !sd.querySelector('.hq-review'), 'import must close the review');
  const codes = (await h.v.byKind('preset')).map((r) => String(r.code).toUpperCase());
  assert(codes.includes(HQ_NEW_B), 'the picked code must be imported');
  assert(!codes.includes(HQ_NEW_A), 'an unpicked code must not be imported');
  const mine = (await h.v.presets()).find((r) => String(r.code).toUpperCase() === HQ_HAVE);
  assert(mine && mine.weapon === 'Bản của tôi' && mine.author === 'me', 'the saved preset must keep its own fields: ' + JSON.stringify(mine));
  assert(String(mine.code) === HQ_HAVE.toLowerCase(), 'the saved preset must keep its original casing');
});

test('HQ review: a late reply after closing or leaving the tab is dropped', async () => {
  const h = await hqPanel(HQ_REPLY);
  const sd = h.p._shadow;
  sd.querySelector('[data-act="hq-import"]').click();
  await until(() => sd.querySelector('.hq-review'), 'loading frame must open');
  sd.querySelector('[data-act="hq-close"]').click();
  assert(!sd.querySelector('.hq-review'), 'closing must remove the frame at once');
  h.release();
  await new Promise((r) => setTimeout(r, 30));
  assert(!sd.querySelector('.hq-review'), 'a reply after close must not reopen the frame');

  sd.querySelector('[data-act="hq-import"]').click();
  await until(() => sd.querySelector('.hq-review'), 'second open must show the frame');
  await h.p.go('history');
  h.release();
  await new Promise((r) => setTimeout(r, 30));
  await h.p.go('presets');
  assert(!sd.querySelector('.hq-review'), 'a reply after leaving the tab must not paint the review');
});

test('HQ review: a failed fetch shows the reason and a retry, without writing', async () => {
  const h = await hqPanel({ ok: false, error: 'Không tải được mã HQ — Chiến Dịch Sinh Tồn: HTTP 503', items: [], prices: {}, failed: [] });
  const sd = h.p._shadow;
  const before = (await h.v.byKind('preset')).length;
  sd.querySelector('[data-act="hq-import"]').click();
  h.release();
  const err = await until(() => sd.querySelector('.hq-err'), 'a failed fetch must say why');
  assert(err.getAttribute('role') === 'alert' && /HTTP 503/.test(err.textContent), 'the error must be announced with its reason');
  assert(sd.querySelector('.hq-review [data-act="hq-import"]'), 'the error frame must offer a retry');
  assert((await h.v.byKind('preset')).length === before, 'a failed fetch must not write anything');
});

test('HQ review: hosts without hqFetch show no HQ button', async () => {
  const v = new V.Vault({ adapter: new V.MemoryAdapter() });
  await v.init();
  const p = sandbox.__createPanel({ version: '3.3.0', target: 'test', vault: v, sync: {} });
  await p.go('presets');
  assert(!p._shadow.querySelector('[data-act="hq-import"]'), 'a host that cannot fetch HQ must not offer the button');
});

(async () => {
  for (const t of tests) {
    /* A test awaiting a promise that never settles let Node drain its event
     * loop and exit 0 mid-suite with no summary, which reads as a pass when the
     * file is run on its own. Bound every test instead. */
    try {
      let timer;
      await Promise.race([
        t.fn(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out after 5s (a promise never settled)')), 5000); }),
      ]).finally(() => clearTimeout(timer));
      console.log('  ok   ' + t.name);
    }
    catch (e) { failures += 1; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e)); }
  }
  console.log(`\n${tests.length - failures}/${tests.length} ui-render tests passed`);
  process.exit(failures ? 1 : 0);
})();
