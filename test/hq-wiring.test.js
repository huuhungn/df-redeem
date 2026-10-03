#!/usr/bin/env node
/* test/hq-wiring.test.js — the built HQ pieces: manifest scope, the worker's
 * file fetch and price store, and the two HQ-page content scripts.
 *
 * Runs against the files in extension/, so `node build.js` must have run. The
 * page scripts are executed in a vm with a fake window/XHR/fetch; the replies
 * fed to them come from test/fixtures/hq-api-capture.json, the real
 * ListGunCodeSchemes capture. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const read = (rel) => fs.readFileSync(path.join(EXT, rel), 'utf8');

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log(`ok   ${name}`); } else { failed += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

const capture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hq-api-capture.json'), 'utf8'));
const [solReply, mpReply] = capture.responses;
const solPrices = Object.fromEntries(solReply.data.items.map((i) => [i.gun_code, i.price]));
const staticFile = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const HQ_PAGE = 'https://www.playdeltaforce.com/events/hq/vi/';
const API_URL = 'https://sg-act.playerinfinite.com/api/proxy/logicial/DfTools/ListGunCodeSchemes?openid=OPENID-SECRET&token=TOKEN-SECRET&ts=1';

/* ── manifest ─────────────────────────────────────────────────────────────── */
const manifest = JSON.parse(read('manifest.json'));
const hosts = manifest.host_permissions || [];
check('the worker may fetch the public HQ code files', hosts.includes('https://www.playdeltaforce.com/gun-codes/*'), JSON.stringify(hosts));
check('no host permission reaches the logged-in HQ API or the whole HQ site',
  !hosts.some((h) => /playerinfinite|playdeltaforce\.com\/\*$|playdeltaforce\.com\/events/.test(h)), JSON.stringify(hosts));
const hqScripts = (manifest.content_scripts || []).filter((cs) => (cs.matches || []).some((m) => m.includes('playdeltaforce.com')));
const capture_cs = hqScripts.find((cs) => (cs.js || []).includes('hq-capture.js'));
const bridge_cs = hqScripts.find((cs) => (cs.js || []).includes('hq-bridge.js'));
check('the price tap runs in MAIN at document_start', capture_cs && capture_cs.world === 'MAIN' && capture_cs.run_at === 'document_start', JSON.stringify(capture_cs));
check('the price relay runs in ISOLATED at document_start', bridge_cs && bridge_cs.world === 'ISOLATED' && bridge_cs.run_at === 'document_start', JSON.stringify(bridge_cs));
check('both HQ scripts match only the HQ event page, top frame only',
  hqScripts.length === 2 && hqScripts.every((cs) => cs.matches.length === 1 && cs.matches[0] === 'https://www.playdeltaforce.com/events/hq/*' && cs.all_frames === false),
  JSON.stringify(hqScripts.map((cs) => cs.matches)));
check('HQ scripts are not exposed as web-accessible resources',
  !(manifest.web_accessible_resources || []).some((e) => (e.resources || []).some((r) => /hq-/.test(r))));

/* ── built sources: no session handling, no eval ──────────────────────────── */
for (const file of ['hq-capture.js', 'hq-bridge.js', 'background.js']) {
  const src = read(file);
  check(`${file} reads no cookies`, !/document\.cookie|chrome\.cookies/.test(src));
  check(`${file} never evaluates HQ files`, !/\beval\(|new Function\(|importScripts\(/.test(src));
}
check('nothing names the logged-in HQ API host', ['hq-capture.js', 'hq-bridge.js', 'background.js'].every((f) => !/playerinfinite/.test(read(f))));

/* ── worker ───────────────────────────────────────────────────────────────── */
function loadWorker(routes) {
  const local = {};
  const listeners = [];
  const fetchCalls = [];
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of [].concat(keys)) if (typeof k === 'string' && local[k] !== undefined) out[k] = JSON.parse(JSON.stringify(local[k]));
          return out;
        },
        async set(items) { Object.assign(local, JSON.parse(JSON.stringify(items))); },
        async remove(keys) { for (const k of [].concat(keys)) delete local[k]; },
      },
      sync: { async get() { return {}; }, async set() {}, async remove() {}, async clear() {} },
    },
    runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, lastError: null },
    action: { onClicked: { addListener() {} } },
    tabs: { create: async () => ({}), query: async () => [], sendMessage: async () => ({}) },
    scripting: { executeScript: async () => [] },
  };
  const sandbox = {
    chrome, console, setTimeout, clearTimeout, AbortController, Promise, Date, Math, JSON, Object, Array,
    String, Number, Error, Set, Map, WeakSet, URL, URLSearchParams, self: {},
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      const route = routes[url];
      if (!route) return { ok: false, status: 404, text: async () => '' };
      if (route instanceof Error) throw route;
      return { ok: true, status: 200, text: async () => route };
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('background.js'), sandbox, { filename: 'background.js' });
  const send = (op, payload, sender) => new Promise((resolve) => {
    const claimed = listeners.some((fn) => fn({ type: 'DF_REDEEM_SYNC', op, payload }, sender || {}, resolve) === true);
    if (!claimed) resolve({ unclaimed: true });
  });
  return { send, local, fetchCalls };
}

const SOL_URL = 'https://www.playdeltaforce.com/gun-codes/op_sol_ga_vi.js';
const MP_URL = 'https://www.playdeltaforce.com/gun-codes/op_mp_ga_vi.js';
const both = { [SOL_URL]: staticFile('hq-op_sol_ga_vi.js'), [MP_URL]: staticFile('hq-op_mp_ga_vi.js') };

async function workerTests() {
  {
    const w = loadWorker(both);
    const res = await w.send('hqFetch');
    check('hqFetch returns the codes of both public files', res.ok === true && res.items.length === 6 && res.failed.length === 0, JSON.stringify(res).slice(0, 300));
    check('hqFetch tags each code with its mode',
      res.items.filter((i) => i.mode === 'Chiến Dịch Sinh Tồn').length === 4 && res.items.filter((i) => i.mode === 'Chiến Trường Toàn Diện').length === 2);
    check('hqFetch requests exactly the two public files', w.fetchCalls.map((c) => c.url).sort().join() === [MP_URL, SOL_URL].join(), w.fetchCalls.map((c) => c.url).join());
    check('hqFetch sends no cookies and refuses redirects',
      w.fetchCalls.every((c) => c.init && c.init.credentials === 'omit' && c.init.redirect === 'error'), JSON.stringify(w.fetchCalls.map((c) => c.init)));
    check('no price is attached before the HQ page has been visited', JSON.stringify(res.prices) === '{}', JSON.stringify(res.prices));
  }
  {
    const w = loadWorker({ [SOL_URL]: staticFile('hq-op_sol_ga_vi.js') });
    const res = await w.send('hqFetch');
    check('one failed file still returns the other and says which failed',
      res.ok === true && res.items.length === 4 && res.failed.length === 1 && res.failed[0].mode === 'Chiến Trường Toàn Diện', JSON.stringify(res.failed));
  }
  {
    const w = loadWorker({ [SOL_URL]: 'alert(1)', [MP_URL]: new Error('offline') });
    const res = await w.send('hqFetch');
    check('a script instead of the data file is refused, not run', res.ok === false && /HQ/.test(res.error) && res.items.length === 0, JSON.stringify(res));
  }
  {
    const w = loadWorker(both);
    const items = solReply.data.items.map((i) => ({ code: i.gun_code, price: i.price }));
    const forged = await w.send('hqPrices', { items }, { url: 'https://redeem.df.garena.sg/vi/cdkgarena.html' });
    check('prices from any page but HQ are refused', forged.ok === false && !w.local.df_redeem_hq_prices, JSON.stringify(forged));
    const noSender = await w.send('hqPrices', { items }, {});
    check('prices with no sender URL are refused', noSender.ok === false);
    const lookalike = await w.send('hqPrices', { items }, { url: 'https://www.playdeltaforce.com.evil.test/events/hq/vi/' });
    check('a look-alike origin is refused', lookalike.ok === false);
    const saved = await w.send('hqPrices', { items: items.concat([{ code: '6K0M7VG08CJQ1634CQ2HM', price: -1 }]) }, { url: HQ_PAGE });
    check('the HQ page stores the 10 captured Operations prices', saved.ok === true && saved.saved === 10, JSON.stringify(saved));
    const stored = w.local.df_redeem_hq_prices || {};
    check('stored prices match the capture exactly',
      Object.keys(stored).length === 10 && Object.entries(solPrices).every(([c, p]) => stored[c] && stored[c].price === p), JSON.stringify(stored).slice(0, 200));
    check('a Warfare -1 is never stored', !('6K0M7VG08CJQ1634CQ2HM' in stored));
    const res = await w.send('hqFetch');
    const want = Object.fromEntries(res.items.filter((i) => i.code in solPrices).map((i) => [i.code, solPrices[i.code]]));
    check('hqFetch returns stored prices beside the codes, not inside them',
      JSON.stringify(res.prices) === JSON.stringify(want) && Object.keys(want).length === 4 && res.items.every((i) => !('price' in i)),
      JSON.stringify(res.prices));
    check('prices are keyed only by code; nothing else is stored', Object.keys(w.local).every((k) => k === 'df_redeem_hq_prices'), Object.keys(w.local).join());
    const before = JSON.stringify(w.local);
    const fetchesBefore = w.fetchCalls.length;
    const read = await w.send('hqReadPrices');
    check('hqReadPrices returns the stored prices with when HQ showed them',
      read.ok === true && Object.keys(read.prices).length === 10
        && Object.entries(solPrices).every(([c, p]) => read.prices[c] && read.prices[c].price === p && read.prices[c].seen_at),
      JSON.stringify(read).slice(0, 200));
    check('hqReadPrices writes nothing and fetches nothing', JSON.stringify(w.local) === before && w.fetchCalls.length === fetchesBefore);
  }
  {
    const w = loadWorker({});
    const read = await w.send('hqReadPrices');
    check('hqReadPrices answers an empty store with no prices', read.ok === true && JSON.stringify(read.prices) === '{}', JSON.stringify(read));
  }
}

/* ── page scripts ─────────────────────────────────────────────────────────── */
function makePage() {
  const posted = [];
  const handlers = [];
  const pageFetchCalls = [];
  const replies = {};
  class FakeXHR {
    constructor() { this.status = 0; this.responseType = ''; this.responseText = ''; this.response = null; this.ls = {}; }
    open(method, url) { this.url = url; }
    send(body) {
      this.sentBody = body;
      const r = replies[this.url] || replies[String(this.url).split('?')[0]];
      Promise.resolve().then(() => {
        this.status = r ? r.status : 404;
        const text = r ? r.text : '';
        if (this.responseType === 'json') { try { this.response = JSON.parse(text); } catch (_) { this.response = null; } } else { this.responseText = text; this.response = text; }
        for (const fn of this.ls.loadend || []) fn();
      });
    }
    addEventListener(type, fn) { (this.ls[type] = this.ls[type] || []).push(fn); }
  }
  const window = {
    location: { origin: 'https://www.playdeltaforce.com', href: HQ_PAGE },
    XMLHttpRequest: FakeXHR,
    fetch: async (input) => {
      pageFetchCalls.push(input);
      const url = typeof input === 'string' ? input : input.url;
      const r = replies[url] || replies[String(url).split('?')[0]];
      const text = r ? r.text : '';
      const res = { ok: Boolean(r && r.status === 200), status: r ? r.status : 404, text: async () => text, json: async () => JSON.parse(text) };
      res.clone = () => ({ ...res });
      return res;
    },
    postMessage: (data, origin) => { posted.push({ data, origin }); for (const h of handlers) h({ source: window, origin, data }); },
    addEventListener: (type, fn) => { if (type === 'message') handlers.push(fn); },
  };
  return { window, posted, handlers, replies, pageFetchCalls, FakeXHR };
}

function runInPage(page, file, extra) {
  const sandbox = { window: page.window, console, JSON, Object, Array, String, Number, Math, Date, Set, Map, WeakSet, Error, Promise, setTimeout, clearTimeout, ...(extra || {}) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(file), sandbox, { filename: file });
  return sandbox;
}

async function pageTests() {
  const page = makePage();
  const pageXhr = page.window.XMLHttpRequest.prototype;
  const origOpen = pageXhr.open;
  const runtimeCalls = [];
  const chromeStub = { runtime: { sendMessage: async (msg) => { runtimeCalls.push(msg); return { ok: true }; } } };
  const captureScope = runInPage(page, 'hq-capture.js');
  runInPage(page, 'hq-bridge.js', { chrome: chromeStub });

  check('the tap does not publish DFRedeemHQ to the HQ page', captureScope.DFRedeemHQ === undefined && page.window.DFRedeemHQ === undefined);
  check('the tap wraps the page XHR', pageXhr.open !== origOpen);

  page.replies[API_URL] = { status: 200, text: JSON.stringify(solReply) };
  const xhr = new page.window.XMLHttpRequest();
  xhr.open('POST', API_URL);
  xhr.send(JSON.stringify({ openid: 'OPENID-SECRET', token: 'TOKEN-SECRET', mode: 'sol' }));
  await tick(); await tick();
  const fromTap = page.posted.filter((p) => p.data && p.data.channel === 'df-redeem-hq-prices');
  check('an XHR reply posts the 10 Operations prices', fromTap.length === 1 && fromTap[0].data.items.length === 10, JSON.stringify(fromTap).slice(0, 200));
  check('posted prices equal the capture', fromTap.length === 1 && fromTap[0].data.items.every((i) => solPrices[i.code] === i.price));
  check('the tap posts only to the page origin', fromTap.every((p) => p.origin === 'https://www.playdeltaforce.com'));
  check('the relay forwards one hqPrices message', runtimeCalls.length === 1 && runtimeCalls[0].type === 'DF_REDEEM_SYNC' && runtimeCalls[0].op === 'hqPrices', JSON.stringify(runtimeCalls).slice(0, 200));
  const everything = JSON.stringify(page.posted) + JSON.stringify(runtimeCalls);
  check('no openid, token or request URL leaves the page', !/SECRET|openid|token|playerinfinite/i.test(everything), everything.slice(0, 200));
  check('the forwarded items are only code and price', runtimeCalls[0] && runtimeCalls[0].payload.items.every((i) => Object.keys(i).join() === 'code,price'));

  page.replies[API_URL] = { status: 200, text: JSON.stringify(mpReply) };
  const xhr2 = new page.window.XMLHttpRequest();
  xhr2.open('POST', API_URL);
  xhr2.send('{}');
  await tick(); await tick();
  check('a Warfare reply (all -1) sends nothing', runtimeCalls.length === 1, String(runtimeCalls.length));

  const jsonXhr = new page.window.XMLHttpRequest();
  jsonXhr.responseType = 'json';
  page.replies[API_URL] = { status: 200, text: JSON.stringify(solReply) };
  jsonXhr.open('POST', API_URL);
  jsonXhr.send('{}');
  await tick(); await tick();
  check('a responseType=json XHR is read too', runtimeCalls.length === 2);

  page.replies['https://www.playdeltaforce.com/other'] = { status: 200, text: JSON.stringify(solReply) };
  const other = new page.window.XMLHttpRequest();
  other.open('GET', 'https://www.playdeltaforce.com/other');
  other.send();
  await tick(); await tick();
  check('replies from other endpoints are ignored', runtimeCalls.length === 2);

  const res = await page.window.fetch(API_URL, { method: 'POST' });
  await tick(); await tick();
  check('a fetch reply is read and the page still gets its response', runtimeCalls.length === 3 && res.ok === true && typeof res.text === 'function');

  page.replies[API_URL] = { status: 200, text: '<html>not json' };
  const bad = new page.window.XMLHttpRequest();
  bad.open('POST', API_URL);
  let threw = false;
  try { bad.send('{}'); await tick(); await tick(); } catch (_) { threw = true; }
  check('a non-JSON reply neither throws nor sends', !threw && runtimeCalls.length === 3);

  /* A page script can post on the same channel; the relay must re-check it. */
  page.window.postMessage({ channel: 'df-redeem-hq-prices', items: [{ code: '6JLGT7C02VAL71CR2QP7Q', price: 5 }, { code: 'not-a-code', price: 500000 }] }, 'https://www.playdeltaforce.com');
  await tick();
  check('a forged message with junk prices is dropped by the relay', runtimeCalls.length === 3, String(runtimeCalls.length));
  for (const h of page.handlers) h({ source: {}, origin: 'https://www.playdeltaforce.com', data: { channel: 'df-redeem-hq-prices', items: [{ code: '6JLGT7C02VAL71CR2QP7Q', price: 600000 }] } });
  await tick();
  check('a message from another window is dropped', runtimeCalls.length === 3);
  for (let i = 0; i < 80; i += 1) page.window.postMessage({ channel: 'df-redeem-hq-prices', items: [{ code: '6JLGT7C02VAL71CR2QP7Q', price: 600000 + i }] }, 'https://www.playdeltaforce.com');
  await tick();
  check('the relay caps how often a page can message the worker', runtimeCalls.length === 50, String(runtimeCalls.length));
}

(async () => {
  await workerTests();
  await pageTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed — ' + (e && e.stack || e)); process.exit(1); });
