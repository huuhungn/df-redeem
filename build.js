#!/usr/bin/env node
/* build.js — bundle the shared core into each delivery target.
 *
 * One core, four shapes:
 *   dist/df-redeem.console.js   paste into DevTools, zero install
 *   dist/df-redeem.user.js      Tampermonkey / Violentmonkey userscript
 *   extension/                  unpacked MV3 Chrome extension
 *   dist/df-redeem.headless.js  driven by Hermes over bsk evaluate
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const EXT = path.join(ROOT, 'extension');
const VERSION = '3.3.1';
/* The redeem form lives on cdkgarena.html. https://redeem.df.garena.sg/vi/ is a
 * DIFFERENT page (no code form), so never send the user there. */
const REDEEM_PATH = '/vi/cdkgarena.html';
const REDEEM_URL = `https://redeem.df.garena.sg${REDEEM_PATH}`;

/* Normalise to LF on read. Sources are checked out with core.autocrlf=true on
 * Windows, so CSS and JS arrive as CRLF and get embedded verbatim inside the
 * template literals below — the bundle then differs between a Windows and a
 * Linux checkout of the same commit. Now that build output is committed, that
 * showed up as a permanently dirty tree after cloning and rebuilding.
 * .gitattributes cannot fix this: it governs the files Git writes, not the
 * bytes this script splices into a string. */
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
/* Absolute paths of everything written, so the syntax gate at the end of this
 * build can re-parse each generated script. */
const WRITTEN_FILES = [];
const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  WRITTEN_FILES.push(file);
  return `${path.relative(ROOT, file)}  ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB`;
};
const warnRead = (file) => {
  if (!fs.existsSync(file)) {
    console.warn(`[build] warning: missing ${path.relative(ROOT, file)}; continuing`);
    return '';
  }
  return read(file);
};

/* Strip the node-only export tail so the same file works inline in a page. */
const inline = (name) => warnRead(path.join(SRC, 'core', name))
  .replace(/if \(typeof module !== 'undefined' && module\.exports\)[^\n]*\n/g, '')
  .replace(/if \(typeof module !== 'undefined' && module\.exports\) module\.exports = [^\n]*\n?/g, '')
  .replace(/const Codes = root\.DFRedeemCodes[^\n]*\n/, 'const Codes = root.DFRedeemCodes;\n')
  .replace(/const Garena = root\.DFRedeemGarena[^\n]*\n/, 'const Garena = root.DFRedeemGarena;\n');

const schema = inline('schema.js');
const vault = inline('vault.js');
const sync = inline('sync.js');
const codes = inline('codes.js');
const garena = inline('garena.js');
const engine = inline('engine.js');
const weapons = inline('weapons.js');
const costs = inline('costs.js');
/* HQ recommended codes: bundled into the worker (fetches the public files) and
 * the two HQ-page content scripts (read prices). Not part of CORE: the panel
 * receives HQ data through the worker, never by talking to HQ itself. */
const hq = inline('hq.js');
/* hq-capture.js runs in the HQ page's own JS world, so hq.js must not attach
 * DFRedeemHQ to that page's window. Bind its IIFE to a private object instead,
 * and fail the build if the attach line ever changes shape. */
const HQ_ATTACH = "}(typeof globalThis !== 'undefined' ? globalThis : this));";
if (hq.split(HQ_ATTACH).length !== 2) {
  console.error('BUILD FAILED — src/core/hq.js attach line changed; update HQ_ATTACH in build.js');
  process.exit(1);
}
const hqPrivate = hq.replace(HQ_ATTACH, '}(scope));');
const seed = JSON.stringify(JSON.parse(warnRead(path.join(SRC, 'data', 'seed.json')) || '{}'));
const uiDir = path.join(SRC, 'ui');
const uiFiles = fs.existsSync(uiDir)
  ? fs.readdirSync(uiDir).sort()
      /* dot-prefixed files are local backups of superseded versions */
      .filter((name) => !name.startsWith('.'))
      .map((name) => path.join(uiDir, name))
  : [];
/* theme.css is the design system shared by every surface; styles.css is the
 * drawer shell on top of it. Both are inlined so a shadow root and a real
 * document can be styled by the same source. */
const themeCss = warnRead(path.join(uiDir, 'theme.css'))
  + '\n' + warnRead(path.join(uiDir, 'components.css'));
const styles = warnRead(path.join(uiDir, 'styles.css'));
const panel = uiFiles.filter((file) => path.extname(file) !== '.css').map(warnRead).join('\n').replace(/__STYLES__/g, 'DF_REDEEM_STYLES');

/* Build output is committed, so the banner must not carry a wall-clock
 * timestamp: it would rewrite every bundle on every build and leave the tree
 * permanently dirty, which destroys `git status` as a signal that something
 * actually changed. SOURCE_DATE_EPOCH (the reproducible-builds convention)
 * overrides it when a release needs a fixed stamp. */
const BUILD_STAMP = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
  : `v${VERSION}`;

const BANNER = `/* Delta Force Auto Redeem v${VERSION}
 * Built ${BUILD_STAMP} — local build, no remote source
 *
 * Verifies every redeem against the network response body, never the popup.
 * No telemetry, no remote code, no credential access. Runs only on
 * redeem.df.garena.sg pages you already opened and logged into.
 */`;

const CORE = `${schema}\n${vault}\n${sync}\n${codes}\n${garena}\n${weapons}\n${costs}\n${engine}\nconst DF_REDEEM_SEED = ${seed};`;
/* The service worker needs only sync.js — it must not carry the DOM engine. */
const CORE_SYNC = sync;
const UI = `const DF_THEME_CSS = ${JSON.stringify(themeCss)};
const DF_PANEL_CSS = ${JSON.stringify(styles)};
const DF_REDEEM_STYLES = DF_THEME_CSS + DF_PANEL_CSS;\n${panel}`;

/* ── console target ───────────────────────────────────────────────────── */
/* Community access for the buildless targets.
 *
 * The extension routes these through the service worker because it holds the
 * host permissions. Console and userscript have no such worker, but both
 * endpoints send permissive CORS headers and neither needs credentials, so the
 * page can call them itself. Verified against the live Garena page: the site's
 * CSP governs what it loads, not what a script fetches with fetch().
 *
 * Only these two calls are exposed. Anything account-specific (push of local
 * records, settings) stays with the storage-backed targets. */
const DIRECT_SYNC = `  const sync = (() => {
    /* No chromeApi: without it the service cannot read stored settings, so pass
     * the defaults in explicitly on every call. */
    const svc = DFRedeemSync.createSyncService({ fetchFn: (...a) => fetch(...a) });
    const settings = DFRedeemSync.publicSettings();
    return {
      communityPull: () => svc.fetchCommunity(settings),
      communityPush: (rows) => svc.reportOutcomes(rows || [], settings),
    };
  })();
`;

const consoleBuild = `${BANNER}
(function dfRedeemConsole() {
  'use strict';
  if (!/redeem\\.df\\.garena\\.sg$/.test(location.hostname)) {
    console.error('[DF Redeem] Hãy mở ${REDEEM_URL} rồi dán lại script này.');
    return;
  }
  if (window.__dfRedeemPanel) { window.__dfRedeemPanel.open(); return; }
  const root = window;
${CORE}
${UI}
${DIRECT_SYNC}
  const panel = createPanel({ version: '${VERSION}', target: 'console', sync });
  window.__dfRedeemPanel = panel;
  panel.open();
  console.log('%c[DF Redeem v${VERSION}]%c bảng điều khiển đã mở. Dán danh sách code vào ô, bấm Bắt đầu.',
    'background:#10f79a;color:#03110d;font-weight:700;padding:2px 7px;border-radius:3px', '');
}());
`;

/* ── userscript target ────────────────────────────────────────────────── */
const userscript = `// ==UserScript==
// @name         Delta Force Auto Redeem (verified)
// @namespace    local.df-redeem
// @version      ${VERSION}
// @description  Đổi hàng loạt giftcode Delta Force, xác minh bằng phản hồi mạng thật, xuất CSV/JSON. Không gửi dữ liệu ra ngoài.
// @author       local
// @match        https://redeem.df.garena.sg/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @noframes
// ==/UserScript==
${BANNER}
(function dfRedeemUserscript() {
  'use strict';
  const root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (root.__dfRedeemPanel) { root.__dfRedeemPanel.open(); return; }
${CORE}
${UI}
  const store = {
    get(key, fallback) { try { return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback; } catch (_) { return fallback; } },
    set(key, value) { try { if (typeof GM_setValue === 'function') GM_setValue(key, value); } catch (_) {} },
    del(key) { try { if (typeof GM_deleteValue === 'function') GM_deleteValue(key); } catch (_) {} },
  };
${DIRECT_SYNC}
  const panel = createPanel({ version: '${VERSION}', target: 'userscript', store, sync });
  root.__dfRedeemPanel = panel;
  panel.mountLauncher();
}());
`;

/* ── extension content script ─────────────────────────────────────────── */
const contentScript = `${BANNER}
(function dfRedeemExtension() {
  'use strict';
  const root = window;
  if (root.__dfRedeemPanel) return;
${CORE}
${UI}
  const store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem('dfRedeem:' + key); return raw == null ? fallback : JSON.parse(raw); }
      catch (_) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem('dfRedeem:' + key, JSON.stringify(value)); } catch (_) {} },
    del(key) { try { localStorage.removeItem('dfRedeem:' + key); } catch (_) {} },
  };
  /* MAIN world has no chrome.* — talk to the worker through bridge.js. */
  const askBridge = (op, payload) => new Promise((resolve, reject) => {
    const id = 'df' + Math.random().toString(36).slice(2) + Date.now();
    /* A full-vault batch legitimately takes tens of seconds server-side, and a
     * premature timeout here made the drawer report failure while the upload was
     * still succeeding in the background. */
    const timer = setTimeout(() => { window.removeEventListener('message', onReply); reject(new Error('Bridge không trả lời.')); }, 60000);
    function onReply(event) {
      const msg = event.data;
      if (!msg || msg.channel !== 'df-redeem-sync-reply' || msg.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onReply);
      if (msg.ok) resolve(msg.reply); else reject(new Error(msg.error || 'Lỗi đồng bộ.'));
    }
    window.addEventListener('message', onReply);
    window.postMessage({ channel: 'df-redeem-sync', id, op, payload }, window.location.origin);
  });

  const sync = {
    status: () => askBridge('status'),
    getSettings: () => askBridge('getSettings'),
    setSettings: (payload) => askBridge('setSettings', payload),
    syncNow: (records) => askBridge('push', { records: (records || []).map((r) => ({ code: r.code, status: r.status, last_tried: r.last_tried })) }),
    /* The drawer's IndexedDB belongs to the Garena origin, so mirror finished
     * attempts into the worker's shared storage — that is the only way the
     * full-page app and the popup can show a run done here. */
    mirrorAttempts: (rows) => askBridge('mirrorAttempts', { rows }),
    readMirror: () => askBridge('readMirror'),
    communityPull: () => askBridge('communityPull'),
    communityPush: (rows) => askBridge('communityPush', { rows }),
    fetchCosts: () => askBridge('fetchCosts'),
    reportCost: (code, cost, mode) => askBridge('reportCost', { code, cost, mode }),
    getLocal: (key) => askBridge('getPanelState', { key }).then((r) => (r && r.ok ? r.value : null)),
    setLocal: (key, value) => askBridge('setPanelState', { key, value }),
    /* HQ's recommended codes, fetched by the worker (the files send no CORS
     * header). Prices come back separately and are display-only. */
    hqFetch: () => askBridge('hqFetch'),
  };

  const panel = createPanel({ version: '${VERSION}', target: 'extension', store, sync });
  root.__dfRedeemPanel = panel;
  panel.mountLauncher();
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data && event.data.channel === 'df-redeem-open') panel.open();
  });
}());
`;

/* ── headless target for Hermes / bsk evaluate ────────────────────────── */
const headless = `${BANNER}
/* Headless controller: no UI. Exposes window.__dfRedeem for a driver that
 * polls state between short evaluate calls. */
(function dfRedeemHeadless() {
  'use strict';
  const root = window;
  if (root.__dfRedeem && root.__dfRedeem.version === '${VERSION}') return 'already-installed';
${CORE}
  const state = {
    version: '${VERSION}',
    run: null,
    logs: [],
    results: [],
    progress: null,
    summary: null,
    finished: false,
    error: null,
  };
  state.start = function start(entries, options) {
    if (state.run && state.run.state === 'running') return 'already-running';
    state.logs = []; state.results = []; state.summary = null; state.finished = false; state.error = null;
    const run = new root.DFRedeemEngine.RedeemRun(entries, options || {});
    state.run = run;
    run.on('log', (entry) => { state.logs.push(entry); if (state.logs.length > 400) state.logs.shift(); });
    run.on('result', (result) => { state.results.push(result); });
    run.on('progress', (p) => { state.progress = p; });
    run.on('done', (summary) => { state.summary = summary; state.finished = true; });
    run.run().catch((error) => { state.error = String(error && error.stack || error); state.finished = true; });
    return 'started';
  };
  state.poll = function poll(fromIndex) {
    const from = Number(fromIndex) || 0;
    return {
      finished: state.finished,
      error: state.error,
      progress: state.progress,
      summary: state.run ? state.run.summary() : null,
      newResults: state.results.slice(from),
      totalResults: state.results.length,
      recentLogs: state.logs.slice(-6).map((l) => l.message),
    };
  };
  state.stop = function stop(reason) { if (state.run) state.run.stop(reason); return 'stopping'; };
  state.csv = function csv() { return state.run ? state.run.toCSV() : ''; };
  state.json = function json() { return state.run ? state.run.toJSON() : ''; };
  root.__dfRedeem = state;
  return 'installed';
}());
`;

const manifest = {
  manifest_version: 3,
  /* Pins the extension ID to ckapnhmehhpkodhknihmbphpfhhdmeca.
   *
   * Without this, Chrome derives the ID of an unpacked extension from the
   * absolute path of its directory. IndexedDB is keyed by the resulting
   * chrome-extension:// origin, so moving or renaming the checkout — or
   * cloning it to a second machine — produces a new ID and the vault appears
   * empty, with the old codes stranded under an origin nothing loads any more.
   *
   * This is the public half of an RSA keypair; it is not a secret and carries
   * no signing power on its own. The private half is only needed to publish a
   * CRX to the Web Store and is deliberately NOT in this repo. */
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6Fij9mAu9du6tiS0qsEHx5uM63dKmJGMMHyh9Ubh5j0YVPAF1icrm9kh6A/72ZK3d8ZPZgEf0WnU78yx32Xjudx6jydKIsxwVFxD/ov6tE3MpIoTCpzpBjhmUMipMUtDUZxU0zB4a9cZB6gXaxXnX+zLeOpLpsej1kvCzQpj/wKtlpXdoIo+FnS8kUoKcoRpCkHEub6dfggkXkX/9UA+fzEHEDWezdaKRCjgM95rVUWrfU6ZXeWKDg4LnWWE/vLXKVwJZE4+vCQr5Ktl/LEYFyFt0YxuSLTVwLoF4KjZqCfIxgz6fHJckqMwfUHi5luA+MBih9lCU6Nn7LL5rcHOkQIDAQAB',
  name: 'Delta Force Auto Redeem',
  /* Chrome truncates long names under the toolbar icon and on the extensions
   * page, so a short form is supplied rather than letting it cut mid-word. */
  short_name: 'DF Redeem',
  version: VERSION,
  /* Chrome shows this verbatim in the extensions list, which caps it around 132
   * characters; keep it inside that so it is never clipped mid-sentence. */
  description: 'Đổi hàng loạt giftcode Delta Force, xác minh bằng phản hồi mạng thật. Không gửi dữ liệu cá nhân ra ngoài.',
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  action: {
    default_title: 'Mở bảng đổi code Delta Force',
    default_popup: 'popup.html',
    /* Without an explicit action icon set Chrome rescales the 128 for the
     * toolbar, which blurs the mark; 16/32 are hand-tuned for that slot. */
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
    },
  },
  permissions: ['storage', 'scripting', 'activeTab', 'tabs'],
  /* The vault hosts are listed so the extension pages can read the published
   * code list and report verdicts. Kept as narrow literals rather than a wildcard
   * so a review of this manifest shows exactly where data can travel. */
  host_permissions: [
    'https://redeem.df.garena.sg/*',
    'https://raw.githubusercontent.com/huuhungn/df-redeem/*',
    'https://df-redeem-vault.huuhungn.workers.dev/*',
    /* HQ's public recommended-code files. They send no CORS header, so only
     * the worker can read them. Just this folder: the logged-in HQ API host
     * (sg-act.playerinfinite.com) is deliberately absent, because calling it
     * would need the player's HQ openid/token. */
    'https://www.playdeltaforce.com/gun-codes/*',
  ],
  /* Spelling out the default MV3 policy documents that nothing here needs eval
   * or remote script, and makes any future loosening an explicit, reviewable
   * change rather than a silent one. */
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
  background: { service_worker: 'background.js' },
  options_ui: { page: 'options.html', open_in_tab: true },
  /* MV3 service workers plus `world: 'MAIN'` content scripts require 111+; below
   * that the panel silently never mounts, so fail at install time instead. */
  minimum_chrome_version: '111',
  content_scripts: [{
    matches: ['https://redeem.df.garena.sg/*'],
    js: ['content.js'],
    run_at: 'document_idle',
    world: 'MAIN',
    all_frames: false,
  }, {
    /* The panel runs in MAIN so it can read the page's own fetch/XHR traffic,
     * but MAIN has no chrome.* APIs. This ISOLATED relay is the only bridge:
     * it forwards sync requests to the worker and nothing else. */
    matches: ['https://redeem.df.garena.sg/*'],
    js: ['bridge.js'],
    run_at: 'document_idle',
    world: 'ISOLATED',
    all_frames: false,
  }, {
    /* HQ build prices exist only in the logged-in API reply the HQ page itself
     * requests. This MAIN-world tap reads those replies (never the request,
     * which carries the session) and must be in place before the page's own
     * scripts fire, hence document_start. */
    matches: ['https://www.playdeltaforce.com/events/hq/*'],
    js: ['hq-capture.js'],
    run_at: 'document_start',
    world: 'MAIN',
    all_frames: false,
  }, {
    /* ISOLATED relay for the tap: re-checks the prices and hands them to the
     * worker. It can send one message type and nothing else. */
    matches: ['https://www.playdeltaforce.com/events/hq/*'],
    js: ['hq-bridge.js'],
    run_at: 'document_start',
    world: 'ISOLATED',
    all_frames: false,
  }],
  /* Keeps the panel's own assets out of reach of the page: only the redeem page
   * may load them, and only these files are exposed. */
  web_accessible_resources: [{
    resources: ['icons/icon128.png'],
    matches: ['https://redeem.df.garena.sg/*'],
  }],
};

const bridge = `/* bridge.js — ISOLATED-world relay between the MAIN-world panel and the
 * service worker. Only sync messages cross; no page data is volunteered. */
(function dfRedeemBridge() {
  'use strict';
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== 'df-redeem-sync' || !msg.id) return;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: msg.op, payload: msg.payload });
      window.postMessage({ channel: 'df-redeem-sync-reply', id: msg.id, ok: true, reply }, window.location.origin);
    } catch (error) {
      window.postMessage({ channel: 'df-redeem-sync-reply', id: msg.id, ok: false, error: String(error && error.message || error) }, window.location.origin);
    }
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'DF_REDEEM_OPEN') window.postMessage({ channel: 'df-redeem-open' }, window.location.origin);
  });
}());
`;

/* ── HQ page (playdeltaforce.com/events/hq/*) ──────────────────────────── */
/* String.raw keeps the regex escapes literal; nothing here may use a backtick. */
const hqCapture = String.raw`/* hq-capture.js — MAIN world on the Delta Force HQ page.
 * Reads build prices out of DfTools/ListGunCodeSchemes replies the page already
 * received. The request is never read, stored or forwarded: its query string
 * and body carry the player's HQ openid/token. Only { code, price } pairs that
 * pass hq.js's checks leave this script. */
(function tapHqPrices() {
  'use strict';
  const scope = {};
  ${hqPrivate}
  const HQ = scope.DFRedeemHQ;
  const ENDPOINT = /\/DfTools\/ListGunCodeSchemes(?:[?#]|$)/;
  const isSchemeList = (url) => {
    try { return ENDPOINT.test(String(url == null ? '' : url)); } catch (_) { return false; }
  };
  const forward = (body) => {
    const prices = HQ.sanitizePrices(body);
    const items = Object.keys(prices).map((code) => ({ code, price: prices[code] }));
    if (items.length) window.postMessage({ channel: 'df-redeem-hq-prices', items }, window.location.origin);
  };
  const forwardText = (text) => {
    let body;
    try { body = JSON.parse(text); } catch (_) { return; }
    forward(body);
  };

  /* Marked requests live in a WeakSet so nothing is written onto the page's
   * own XHR objects, and the URL is only tested, never kept. */
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR && typeof XHR.open === 'function' && typeof XHR.send === 'function') {
    const marked = new WeakSet();
    const open = XHR.open;
    const send = XHR.send;
    XHR.open = function (method, url) {
      if (isSchemeList(url)) marked.add(this); else marked.delete(this);
      return open.apply(this, arguments);
    };
    XHR.send = function () {
      if (marked.has(this)) {
        const xhr = this;
        xhr.addEventListener('loadend', () => {
          try {
            if (xhr.status !== 200) return;
            if (xhr.responseType === 'json') forward(xhr.response);
            else if (xhr.responseType === '' || xhr.responseType === 'text') forwardText(xhr.responseText);
          } catch (_) { /* never break the page over a price */ }
        }, { once: true });
      }
      return send.apply(this, arguments);
    };
  }

  const pageFetch = window.fetch;
  if (typeof pageFetch === 'function') {
    window.fetch = function (input) {
      const pending = pageFetch.apply(this, arguments);
      let hit = false;
      try { hit = isSchemeList(input && typeof input === 'object' && 'url' in input ? input.url : input); } catch (_) {}
      if (hit) {
        pending.then((res) => {
          if (res && res.ok && typeof res.clone === 'function') res.clone().text().then(forwardText, () => {});
        }, () => {});
      }
      return pending;
    };
  }
}());
`;

const hqBridge = `/* hq-bridge.js — ISOLATED-world relay on the HQ page. Takes the prices
 * hq-capture.js posted, re-checks them (the page shares that channel), and
 * sends them to the worker as the one message type it is allowed. */
(function dfRedeemHqBridge() {
  'use strict';
  ${hq}
  const HQ = globalThis.DFRedeemHQ;
  /* The page sees and can forge window messages. Prices are re-validated
   * here, and a page cannot flood the worker with them. */
  const MAX_MESSAGES = 50;
  let sent = 0;
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || msg.channel !== 'df-redeem-hq-prices' || !Array.isArray(msg.items)) return;
    if (sent >= MAX_MESSAGES) return;
    const prices = HQ.sanitizePrices(msg.items);
    const items = Object.keys(prices).map((code) => ({ code, price: prices[code] }));
    if (!items.length) return;
    sent += 1;
    try {
      const pending = chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'hqPrices', payload: { items } });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (_) { /* extension reloaded: the page keeps working */ }
  });
}());
`;

/* ── full-page app (chrome-extension://…/app.html) ────────────────────── */
/* A real tab: no host page to fight for space, so the same views get a wide
 * two-column layout. Runs in the extension origin, so it can read the vault
 * and export, but it cannot drive the Garena form — redeeming stays on the
 * redeem page where the network tap lives. */
const appHtml = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delta Force Auto Redeem</title>
<link rel="stylesheet" href="theme.css">
<link rel="stylesheet" href="app.css">
</head>
<body class="df page">
  <div class="page-shell">
    <aside class="side">
      <div class="side-brand">
        <div class="stencil">Delta Force</div>
        <h1>Auto Redeem</h1>
        <span class="ver">v${VERSION}</span>
      </div>
      <nav class="side-nav"></nav>
      <div class="side-ft">
        <button class="act tiny" id="open-redeem">Mở trang đổi code →</button>
        <button class="act tiny ghost" id="open-options">Cài đặt</button>
      </div>
    </aside>
    <main class="page-main">
      <header class="page-hd">
        <div>
          <h2 class="page-title">Tổng quan</h2>
          <p class="page-hint muted"></p>
        </div>
        <div class="page-acts">
          <button class="act ghost icon-only" id="p-refresh" title="Tải lại" aria-label="Tải lại">⟳</button>
        </div>
      </header>
      <div id="page-view"></div>
    </main>
  </div>
  <div class="toast-wrap" id="toasts"></div>
<script src="app.js"></script>
</body>
</html>
`;

/* app.css — page shell only; every view style comes from theme.css. */
const appCss = `/* app.css — full-page shell. theme.css supplies the design system. */
html, body { margin: 0; min-height: 100%; background: var(--void); }
.page { background: var(--void); }
.page-shell { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }

.side {
  display: flex; flex-direction: column; gap: 18px;
  padding: 20px 14px; border-right: 1px solid var(--line);
  background: linear-gradient(180deg, var(--panel), var(--bg));
  position: sticky; top: 0; height: 100vh;
}
.side-brand h1 { margin: 2px 0 0; font-size: 16px; letter-spacing: -.01em; }
.side-brand .ver { color: var(--ink-mute); font: 600 10px var(--mono); }
.side-nav { display: flex; flex-direction: column; gap: 2px; }
.side-nav button {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 11px; border: 0; border-radius: var(--r);
  background: transparent; color: var(--ink-dim);
  cursor: pointer; text-align: left; font: 600 12.5px var(--sans);
}
.side-nav button:hover { background: var(--raised); color: var(--ink); }
.side-nav button.on { background: var(--primary-glow); color: var(--primary); box-shadow: inset 2px 0 0 var(--primary); }
.side-nav .vi { width: 16px; font-size: 13px; text-align: center; }
.side-nav .badge {
  margin-left: auto; padding: 1px 6px; border-radius: 99px;
  background: var(--s-untried); color: #1a1205; font: 800 10px var(--mono);
}
.side-ft { margin-top: auto; display: grid; gap: 6px; }

.page-main { min-width: 0; padding: 0 0 40px; }
.page-hd {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
  padding: 22px 26px 16px; border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: 2;
  background: color-mix(in srgb, var(--void) 88%, transparent);
  backdrop-filter: blur(8px);
}
.page-title { margin: 0; font-size: 19px; letter-spacing: -.015em; }
.page-hint { margin: 2px 0 0; font-size: 11.5px; }

/* On a real page the views get room to breathe: two columns where it helps. */
#page-view .pad { max-width: 1180px; padding: 22px 26px; }
#page-view .kpis { grid-template-columns: repeat(4, 1fr); }
#page-view .kpi b { font-size: 30px; }
@media (min-width: 1180px) {
  #page-view .cols { display: grid; grid-template-columns: 1.15fr .85fr; gap: var(--gap); align-items: start; }
}
#page-view .pgrid { grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
@media (max-width: 880px) {
  .page-shell { grid-template-columns: 1fr; }
  .side { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; }
  .side-nav { flex-direction: row; flex-wrap: wrap; }
  .side-ft { margin: 0; grid-auto-flow: column; }
}
`;

const appJs = `${BANNER}
/* app.js — full-page surface. Reuses createPanel's view renderers by mounting
 * the drawer shell inside this page and borrowing its rendered markup, so the
 * two surfaces can never drift apart. */
(function dfRedeemApp() {
  'use strict';
  const root = window;
${CORE}
${UI}

  const VIEWS = ['dashboard', 'library', 'run', 'presets', 'share', 'history'];
  const LABELS = { dashboard: 'Tổng quan', library: 'Kho code', run: 'Chạy đổi', presets: 'Preset Gunsmith', share: 'Chia sẻ', history: 'Lịch sử' };
  const ICONS = { dashboard: '◈', library: '▤', run: '▶', presets: '⌖', share: '↗', history: '◷' };
  const HINTS = {
    dashboard: 'Tình trạng toàn bộ kho code',
    library: 'Tìm, lọc và xem lịch sử từng mã',
    run: 'Đổi hàng loạt — cần mở trên trang Garena',
    presets: 'Preset Gunsmith cho mọi chế độ chơi',
    share: 'Xuất danh sách cho người khác',
    history: 'Mọi lần thử đã ghi lại',
  };

  /* The page lives on chrome-extension://, so its IndexedDB is a different
   * origin's store than the drawer's. Pass the sync bridge so History can merge
   * the runs the drawer mirrored into shared storage. */
  const sync = {
    readMirror: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'readMirror' }),
    /* The sync chip reads this; without it the guard in panel.js hides the
     * chip, so the app looked permanently unsynced. */
    status: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'status' }),
    /* The app cannot drive the Garena form, but History here can still finish a
     * run mirrored from the drawer, and that path snapshots the personal vault.
     * Leaving these off made the panel skip personal sync with no message. */
    getSettings: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'getSettings' }),
    syncNow: (records) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'push', payload: { records: (records || []).map((r) => ({ code: r.code, status: r.status, last_tried: r.last_tried })) } }),
    mirrorAttempts: (rows) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'mirrorAttempts', payload: { rows } }),
    communityPull: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'communityPull' }),
    fetchCosts: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'fetchCosts' }),
    reportCost: (code, cost, mode) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'reportCost', payload: { code, cost, mode } }),
    getLocal: (key) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'getPanelState', payload: { key } }).then((r) => (r && r.ok ? r.value : null)),
    setLocal: (key, value) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'setPanelState', payload: { key, value } }),
    communityPush: (rows) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'communityPush', payload: { rows } }),
    hqFetch: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'hqFetch' }),
  };
  const panel = createPanel({
    version: '${VERSION}', target: 'page', surface: 'page', sync,
    /* The view below is a clone, refreshed right after each click. The HQ
     * review repaints seconds later when the fetch or the import finishes, so
     * the panel calls back and the visible clone is replaced then. */
    onRepaint: (name) => {
      const on = document.querySelector('.side-nav .on');
      if (on && on.dataset.view === name) recloneView();
    },
  });
  const host = document.getElementById('page-view');
  const nav = document.querySelector('.side-nav');

  function recloneView() {
    const rendered = panel._shadow.querySelector('.view-host .pad');
    if (!rendered) return;
    host.innerHTML = '';
    host.appendChild(rendered.cloneNode(true));
  }

  nav.innerHTML = VIEWS.map((v) =>
    '<button data-view="' + v + '"><span class="vi">' + ICONS[v] + '</span>' + LABELS[v] + '</button>').join('');

  /* The drawer renders into its own shadow root; move the rendered view node
   * into this page so both surfaces share one renderer. */
  async function show(name) {
    await panel.go(name);
    const rendered = panel._shadow.querySelector('.view-host .pad');
    host.innerHTML = '';
    if (rendered) host.appendChild(rendered.cloneNode(true));
    document.querySelector('.page-title').textContent = LABELS[name];
    document.querySelector('.page-hint').textContent = HINTS[name];
    Array.prototype.forEach.call(nav.children, (b) => b.classList.toggle('on', b.dataset.view === name));
    const untried = panel.getResults().filter((r) => r.status === 'untried').length;
    const runBtn = nav.querySelector('[data-view="run"]');
    const old = runBtn.querySelector('.badge');
    if (old) runBtn.removeChild(old);
    if (untried) {
      const s = document.createElement('span');
      s.className = 'badge'; s.textContent = String(untried);
      runBtn.appendChild(s);
    }
  }

  /* Clicks inside the cloned view are replayed onto the real (shadow) node so
   * every handler stays in one place. */
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'goto-run') return show('run');
    if (act === 'goto-share') return show('share');
    if (act === 'goto-history') return show('history');
    if (act === 'open-redeem') { window.open('https://redeem.df.garena.sg/vi/cdkgarena.html', '_blank'); return; }
    /* Most actions are unique. Filter chips are not: all carry data-act="pchip"
     * and differ by data-k. Preserve every identity field that affects dispatch;
     * otherwise the cloned page always replays a chip click onto the first
     * shadow button ("Tất cả"), so the visible filter never changes. */
    const twinSelector = '[data-act="' + act + '"]'
      + (btn.dataset.code ? '[data-code="' + btn.dataset.code + '"]' : '')
      + (btn.dataset.k ? '[data-k="' + btn.dataset.k + '"]' : '');
    const twin = panel._shadow.querySelector(twinSelector);
    if (twin) {
      twin.click();
      /* Re-cloning replaces the clicked button. Keep keyboard focus on its copy
       * when it survives the repaint, or Tab restarts from the top of the page. */
      const hadFocus = document.activeElement === btn;
      setTimeout(() => show(panel._views.find((v) => document.querySelector('.side-nav .on').dataset.view === v)).then(() => {
        const again = hadFocus && host.querySelector(twinSelector);
        if (again && !again.disabled) again.focus();
      }), 30);
    }
  });
  host.addEventListener('input', (e) => {
    const cls = e.target.className;
    const twin = panel._shadow.querySelector('.' + String(cls).split(' ')[0]);
    if (twin && 'value' in twin) {
      twin.value = e.target.value;
      twin.dispatchEvent(new Event('input', { bubbles: true }));
      const active = document.querySelector('.side-nav .on').dataset.view;
      setTimeout(() => {
        const rendered = panel._shadow.querySelector('.view-host .pad');
        if (!rendered) return;
        const sel = document.activeElement && document.activeElement.className;
        host.innerHTML = '';
        host.appendChild(rendered.cloneNode(true));
        if (sel) { const back = host.querySelector('.' + String(sel).split(' ')[0]); if (back && back.focus) { back.focus(); if (back.setSelectionRange && back.value) back.setSelectionRange(back.value.length, back.value.length); } }
      }, 20);
    }
  });
  host.addEventListener('change', (e) => {
    const cls = String(e.target.className).split(' ')[0];
    const twin = panel._shadow.querySelector('.' + cls);
    if (twin) {
      if ('checked' in twin) twin.checked = e.target.checked;
      if ('value' in twin) twin.value = e.target.value;
      twin.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => {
        const rendered = panel._shadow.querySelector('.view-host .pad');
        if (rendered) { host.innerHTML = ''; host.appendChild(rendered.cloneNode(true)); }
      }, 20);
    }
  });

  nav.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) show(b.dataset.view);
  });
  document.getElementById('p-refresh').addEventListener('click', () => show(document.querySelector('.side-nav .on').dataset.view));
  document.getElementById('open-redeem').addEventListener('click', () => window.open('https://redeem.df.garena.sg/vi/cdkgarena.html', '_blank'));
  document.getElementById('open-options').addEventListener('click', () => { if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage(); });

  /* mount the hidden drawer shell so its renderers have a document */
  document.documentElement.appendChild(panel._host);
  panel._host.style.display = 'none';
  panel.open().then(() => show('dashboard'));
}());
`;

/* ── settings surfaces: shared helpers ───────────────────────────────────── */
/* Short local time for status lines: HH:MM today, otherwise HH:MM dd/MM. The
 * popup badge and the options status line must agree on the format. */
const uiWhen = `  function when(ts) {
    const d = new Date(ts);
    if (!ts || Number.isNaN(d.getTime())) return '';
    const hm = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? hm
      : hm + ' ' + d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  }
`;

/* ── toolbar popup ────────────────────────────────────────────────────── */
/* A launcher, not a dashboard: two numbers, one primary action, a short menu
 * of secondary routes, and the backup state as a badge that links to its
 * settings. Anything richer opens the full page — a 320px popup is the wrong
 * place for a 300-row table. */
const popupHtml = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>Auto Redeem</title>
<link rel="stylesheet" href="theme.css">
<style>
  html, body { margin: 0; width: 320px; background: var(--void); }
  .pop { display: grid; gap: 12px; padding: 16px; }
  .pop-hd { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .mark {
    flex: none; width: 28px; height: 28px; display: grid; place-items: center;
    border: 1px solid var(--primary-dim); border-radius: var(--r);
    background: var(--primary-glow); color: var(--primary); font: 800 11px var(--mono);
  }
  .who { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .who h1 { margin: 0; font-size: var(--fs-title); font-weight: 700; white-space: nowrap; }
  .ver { color: var(--ink-mute); font: 600 var(--fs-label) var(--mono); }
  #backup { margin-left: auto; cursor: pointer; }
  #backup:hover { border-color: var(--primary-dim); }
  .pop .kpis { grid-template-columns: 1fr 1fr; gap: 8px; }
  .pop .kpi { padding: 10px 12px; border-radius: var(--r-lg); }
  .pop .kpi b { font-size: 24px; }
  .pop .kpi small { margin-top: 4px; line-height: 1.35; }
  .launch { width: 100%; font-size: var(--fs-body); }
  .menu {
    display: grid; overflow: hidden;
    border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--panel);
  }
  .mi {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px;
    min-height: 48px; padding: 8px 12px;
    border: 0; border-top: 1px solid var(--line-soft); background: transparent;
    text-align: left; cursor: pointer; transition: background .14s;
  }
  .mi:first-child { border-top: 0; }
  .mi::after { content: "›"; grid-column: 2; grid-row: 1 / span 2; align-self: center; color: var(--ink-mute); font-size: 16px; }
  .mi-t { grid-column: 1; grid-row: 1; color: var(--ink); font-size: var(--fs-body); font-weight: 600; line-height: 1.35; }
  .mi-c { grid-column: 1; grid-row: 2; color: var(--ink-mute); font-size: var(--fs-label); line-height: 1.4; }
  .mi:hover:not([disabled]) .mi-c { color: var(--ink-dim); }
  .mi:hover:not([disabled]) { background: var(--raised); }
  .mi:hover:not([disabled]) .mi-t { color: var(--primary); }
  .mi:focus-visible { outline-offset: -2px; }
  .mi[disabled] { cursor: not-allowed; }
  .mi[disabled] .mi-t, .mi[disabled]::after { color: var(--ink-mute); }
  .pop-ft {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding-top: 8px; border-top: 1px solid var(--line-soft);
    color: var(--ink-mute); font-size: var(--fs-label);
  }
  .pop-ft .act.ghost { margin-right: -11px; }
</style>
</head>
<body class="df">
  <main class="pop">
    <header class="pop-hd">
      <div class="mark" aria-hidden="true">DF</div>
      <div class="who"><h1>Auto Redeem</h1><span class="ver">v${VERSION}</span></div>
      <button class="sbadge" id="backup" type="button" data-state="off" title="Cài đặt sao lưu"><i aria-hidden="true"></i><span id="backup-text">Sao lưu tắt</span></button>
    </header>
    <section class="kpis" id="k" aria-label="Tóm tắt kho"></section>
    <button class="act primary lg launch" id="open-app" type="button">Mở bảng đầy đủ</button>
    <nav class="menu" aria-label="Thao tác nhanh">
      <button class="mi" id="open-drawer" type="button"><span class="mi-t">Mở bảng trên tab này</span><span class="mi-c">Gắn bảng vào trang đổi code Garena đang mở</span></button>
      <button class="mi" id="open-redeem" type="button"><span class="mi-t">Tới trang đổi code</span><span class="mi-c">Mở redeem.df.garena.sg để đăng nhập</span></button>
      <button class="mi" id="copy-share" type="button"><span class="mi-t">Sao chép mã tặng được</span><span class="mi-c">Mã đã đổi xong, gửi cho bạn bè</span></button>
    </nav>
    <footer class="pop-ft">
      <span id="foot" role="status"></span>
      <button class="act ghost tiny" id="open-options" type="button">Cài đặt</button>
    </footer>
  </main>
<script src="popup.js"></script>
</body>
</html>
`;

const popupJs = `${BANNER}
/* popup.js — reads the vault read-only and routes to the right surface. */
(function dfRedeemPopup() {
  'use strict';
  const root = window;
${schema}
${vault}
  const DF_REDEEM_SEED = ${seed};
  const STATUS_KEY = 'dfRedeemSyncStatus';
  const $ = (id) => document.getElementById(id);
  const ask = (op) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op });
${uiWhen}
  /* Menu rows carry a caption, so transient feedback swaps only the title and
   * then puts the original back. */
  function flashTitle(btn, text, ms) {
    const title = btn.querySelector('.mi-t');
    if (!title) return;
    if (!title.dataset.label) title.dataset.label = title.textContent;
    title.textContent = text;
    clearTimeout(btn.dfTimer);
    btn.dfTimer = setTimeout(() => { title.textContent = title.dataset.label; }, ms || 2200);
  }

  /* The badge mirrors the personal backup only; the community vault needs no
   * account and has nothing for the user to fix from here. */
  let backupOn = false;
  function paintBackup(status) {
    const badge = $('backup');
    const state = !backupOn ? 'off' : (status && status.state) || 'never-synced';
    const text = {
      off: 'Sao lưu tắt',
      ok: 'Đã sao lưu ' + when(status && status.lastSyncAt),
      syncing: 'Đang sao lưu…',
      error: 'Sao lưu lỗi',
      'never-synced': 'Chưa sao lưu',
    }[state] || state;
    badge.dataset.state = state;
    $('backup-text').textContent = text.trim();
    badge.title = state === 'error' && status && status.error ? status.error : 'Cài đặt sao lưu';
  }
  async function loadBackup() {
    try {
      const settings = await ask('getSettings');
      backupOn = Boolean(settings && settings.enabled);
      paintBackup(backupOn ? await ask('status') : null);
    } catch (_) {
      $('backup').hidden = true;
    }
  }

  (async function main() {
    loadBackup();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STATUS_KEY]) paintBackup(changes[STATUS_KEY].newValue);
    });

    const v = new root.DFRedeemVault.Vault({ adapter: new root.DFRedeemVault.IndexedDBAdapter() });
    let gifts = [], presets = [];
    try {
      await v.init();
      await v.seedOnFirstRun(DF_REDEEM_SEED);
      const all = await v.all();
      presets = await v.presets();
      const presetCodes = new Set(presets.map((r) => r.code));
      gifts = all.filter((r) => !presetCodes.has(r.code));
    } catch (e) {
      $('foot').textContent = 'Không đọc được kho: ' + e.message;
    }
    const share = gifts.filter((r) => r.status === 'success' || r.status === 'mine');
    const untried = gifts.filter((r) => r.status === 'untried');

    /* Plain-language tiles: a first-time user should learn what the numbers
     * mean without opening the full dashboard. "Chưa thử" alone read as
     * meaningless when it was 0, so each tile carries its own hint line. */
    $('k').innerHTML =
      '<div class="kpi ok"><b>' + share.length + '</b><span>Mã tặng được</span>' +
        '<small>đã đổi xong, gửi bạn bè</small></div>' +
      '<div class="kpi warn"><b>' + untried.length + '</b><span>Mã chờ đổi</span>' +
        '<small>' + (untried.length ? 'mở bảng để chạy đổi' : 'đã thử hết kho') + '</small></div>';
    if (!$('foot').textContent) {
      $('foot').textContent = 'Kho: ' + gifts.length + ' mã quà · ' + presets.length + ' mã lắp súng';
    }

    const copyBtn = $('copy-share');
    copyBtn.querySelector('.mi-t').textContent = share.length ? 'Sao chép ' + share.length + ' mã tặng được' : 'Sao chép mã tặng được';
    if (!share.length) {
      copyBtn.disabled = true;
      copyBtn.querySelector('.mi-c').textContent = 'Chưa có mã nào đổi xong';
    }

    $('open-app').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
    });
    $('open-drawer').addEventListener('click', async () => {
      const btn = $('open-drawer');
      try {
        const r = await chrome.runtime.sendMessage({ type: 'DF_REDEEM_OPEN_DRAWER' });
        if (r && r.ok) return window.close();
        flashTitle(btn, (r && r.error) || 'Không mở được');
      } catch (_) { flashTitle(btn, 'Không mở được'); }
    });
    $('open-redeem').addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://redeem.df.garena.sg/vi/cdkgarena.html' });
    });
    $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
    $('backup').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html#backup') });
    });
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(share.map((r) => r.code).join(String.fromCharCode(10)));
        flashTitle(copyBtn, 'Đã sao chép ' + share.length + ' mã ✓', 2000);
      } catch (_) { flashTitle(copyBtn, 'Không sao chép được', 2000); }
    });
  }());
}());
`;

/* ── options page ─────────────────────────────────────────────────────── */
/* Four sections in the order a user reasons about their data: what is shared
 * with everyone, what is backed up for me, what sits on this machine, and the
 * one destructive action — fenced off so it is never next to Save. */
const optionsHtml = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cài đặt — Delta Force Auto Redeem</title>
<link rel="stylesheet" href="theme.css">
<style>
  /* Tokens and primitives (.act, .switch, .sbadge, .input) come from
   * theme.css; layout only lives here. */
  body { margin: 0; background: var(--void); color: var(--ink); font: var(--fs-body)/1.6 var(--sans); }
  .shell { max-width: 1000px; margin: 0 auto; padding: 32px 24px 64px; }
  .top { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--line); }
  .mark {
    flex: none; width: 40px; height: 40px; display: grid; place-items: center;
    border: 1px solid var(--primary-dim); border-radius: var(--r);
    background: var(--primary-glow); color: var(--primary); font: 800 15px var(--mono);
  }
  .top h1 { margin: 0; font-size: var(--fs-headline); letter-spacing: -.01em; line-height: 1.25; }
  .top .sub { margin: 2px 0 0; color: var(--ink-mute); font-size: var(--fs-caption); }
  .top .act { margin-left: auto; text-decoration: none; }

  .layout { display: grid; grid-template-columns: 184px minmax(0, 1fr); gap: 32px; align-items: start; }
  .toc { position: sticky; top: 24px; display: grid; gap: 2px; }
  .toc a {
    display: block; padding: 8px 12px; border-left: 2px solid transparent; border-radius: 0 var(--r) var(--r) 0;
    color: var(--ink-dim); font-size: var(--fs-caption); font-weight: 600; text-decoration: none;
  }
  .toc a:hover { background: var(--panel); color: var(--ink); }
  .toc a[aria-current="true"] { border-left-color: var(--primary); background: var(--panel); color: var(--primary); }
  .toc a.is-danger { color: color-mix(in srgb, var(--danger) 70%, var(--ink-dim)); }
  .toc a.is-danger:hover, .toc a.is-danger[aria-current="true"] { border-left-color: var(--danger); color: var(--danger); }
  .content { display: grid; gap: 16px; min-width: 0; }

  .block {
    padding: 20px 24px; scroll-margin-top: 24px;
    border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--panel);
    box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
  }
  .block-hd { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
  .block-hd h2 { margin: 0; font-size: var(--fs-title); font-weight: 700; line-height: 1.35; }
  .lede { margin: 4px 0 0; color: var(--ink-mute); font-size: var(--fs-caption); line-height: 1.5; }
  .lede, .note, .points li span, .setrow .d, .opt small { text-wrap: pretty; }
  .block-hd .sbadge { flex: none; margin-left: auto; }

  .points { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .points li {
    display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 12px; padding: 10px 12px;
    border: 1px solid var(--line-soft); border-radius: var(--r); background: var(--sunken);
    color: var(--ink-dim); font-size: var(--fs-caption); line-height: 1.55;
  }
  .points li > b { color: var(--ink); font-size: var(--fs-caption); font-weight: 700; }
  .note { margin: 12px 0 0; color: var(--ink-mute); font-size: var(--fs-caption); line-height: 1.55; }
  .note b, .points li span b { color: var(--ink-dim); }

  .setrow { display: flex; align-items: center; gap: 16px; padding: 12px 0; border-top: 1px solid var(--line-soft); }
  label.setrow { cursor: pointer; }
  .setrow > .txt { flex: 1; min-width: 0; }
  .setrow .t { display: block; color: var(--ink); font-size: var(--fs-body); font-weight: 600; line-height: 1.4; }
  .setrow .d { display: block; margin-top: 2px; color: var(--ink-mute); font-size: var(--fs-caption); line-height: 1.5; }
  .block-hd + .setrow { border-top: 0; padding-top: 0; }

  .cfg { min-width: 0; margin: 0; padding: 0; border: 0; }
  .lbl { display: block; margin: 12px 0 8px; padding: 0; color: var(--ink-dim); font-size: var(--fs-caption); font-weight: 700; }
  .lbl em { color: var(--ink-mute); font-style: normal; font-weight: 500; }
  .choices { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .opt {
    display: flex; gap: 10px; padding: 12px; cursor: pointer;
    border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--sunken);
    transition: border-color .14s, background .14s;
  }
  .opt input { flex: none; margin: 4px 0 0; accent-color: var(--primary); }
  .opt b { display: block; font-size: var(--fs-body); }
  .opt small { display: block; margin-top: 2px; color: var(--ink-mute); font-size: var(--fs-caption); line-height: 1.45; }
  .opt:has(input:checked) { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 9%, var(--sunken)); box-shadow: inset 0 0 0 1px var(--primary-dim); }
  .opt:has(input:checked) b { color: var(--primary); }
  .opt:has(input:focus-visible) { outline: 2px solid var(--primary); outline-offset: 2px; }
  .rest { display: grid; gap: 12px; margin-top: 12px; }
  .field { display: grid; gap: 6px; }
  .field .lbl { margin: 0; }
  .block .input { min-height: 40px; padding: 9px 12px; font-family: var(--mono); }
  .hint { color: var(--ink-mute); font-size: var(--fs-label); line-height: 1.5; }
  .cfg .setrow { margin-top: 12px; }

  .meta {
    display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 12px; padding: 10px 12px;
    border-radius: var(--r); background: var(--sunken);
    color: var(--ink-mute); font: var(--fs-label)/1.5 var(--mono);
  }
  .meta:empty { display: none; }
  .meta .err { flex-basis: 100%; color: var(--danger); font-family: var(--sans); font-size: var(--fs-caption); }

  .block-ft { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line-soft); }
  .msg { margin-right: auto; font-size: var(--fs-caption); font-weight: 600; }
  .status { color: var(--ink-mute); }
  .status[data-tone="ok"] { color: var(--s-success); }
  .status[data-tone="err"] { color: var(--danger); }
  .status[data-tone="busy"] { color: var(--sky); }
  .dirty { color: var(--amber); }
  .status.note:empty { margin: 0; }
  .status:not(:empty) + .dirty { display: none; }

  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0; }
  .stats > div { padding: 12px; border: 1px solid var(--line-soft); border-radius: var(--r); background: var(--sunken); }
  .stats dt { color: var(--ink-mute); font-size: var(--fs-caption); font-weight: 600; }
  .stats dd { margin: 4px 0 0; color: var(--ink); font: 700 22px/1.1 var(--sans); font-variant-numeric: tabular-nums; }

  .block.danger { border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); }
  .block.danger h2 { color: var(--danger); }
  .block.danger .setrow { gap: 24px; padding: 0; border-top: 0; }
  .block.danger .act.danger { flex: none; border-color: var(--danger); background: transparent; color: var(--danger); font-weight: 700; }
  .block.danger .act.danger:hover:not([disabled]) { background: var(--danger); color: #1a0508; }

  @media (max-width: 860px) {
    .layout { grid-template-columns: minmax(0, 1fr); gap: 16px; }
    .toc { position: static; display: flex; flex-wrap: wrap; gap: 4px; }
    .toc a { border-left: 0; border-bottom: 2px solid transparent; border-radius: var(--r) var(--r) 0 0; }
    .toc a[aria-current="true"] { border-bottom-color: currentColor; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 560px) {
    .shell { padding: 20px 16px 48px; }
    .block { padding: 16px; }
    .choices { grid-template-columns: minmax(0, 1fr); }
    .points li { grid-template-columns: minmax(0, 1fr); gap: 2px; }
    .block.danger .setrow { flex-direction: column; align-items: stretch; }
  }
</style>
</head>
<body class="df">
 <div class="shell">
  <header class="top">
    <div class="mark" aria-hidden="true">DF</div>
    <div>
      <h1>Cài đặt</h1>
      <p class="sub">Delta Force Auto Redeem · v${VERSION}</p>
    </div>
    <a class="act lg" href="app.html" target="_blank" rel="noopener">Mở bảng đầy đủ</a>
  </header>

  <div class="layout">
   <nav class="toc" aria-label="Các mục cài đặt">
     <a href="#community" aria-current="true">Kho cộng đồng</a>
     <a href="#backup">Sao lưu cá nhân</a>
     <a href="#local">Kho trên máy này</a>
     <a href="#danger" class="is-danger">Vùng nguy hiểm</a>
   </nav>

   <main class="content">
    <section class="block" id="community" aria-labelledby="community-h">
      <header class="block-hd">
        <div>
          <h2 id="community-h">Kho cộng đồng</h2>
          <p class="lede">Tự động. Không cần đăng nhập Google hay cấu hình server, và không có gì để bật.</p>
        </div>
        <span class="sbadge" data-state="ok"><i aria-hidden="true"></i>Tự động</span>
      </header>
      <ul class="points">
        <li><b>Tải về</b><span>Mỗi lần mở extension, danh sách mã chung được tải về để bỏ qua mã đã chết.</span></li>
        <li><b>Gửi lên</b><span>Chỉ kết quả đúng với <b>mọi</b> account (mã sai, hết hạn, hết lượt) được gửi làm bằng chứng. Mã hết hạn hoặc lỗi quà cần hai lượt cài đặt độc lập xác nhận trước khi công bố.</span></li>
        <li><b>Ở lại máy</b><span>Đã dùng hoặc đã nhận, sai account hoặc khu vực, captcha và lỗi tạm thời không bao giờ rời máy này.</span></li>
      </ul>
      <p class="note">Một mã đổi thành công ở người khác vẫn là <b>chưa thử</b> với account của bạn.</p>
    </section>

    <section class="block" id="backup" aria-labelledby="backup-h">
      <header class="block-hd">
        <div>
          <h2 id="backup-h">Sao lưu cá nhân</h2>
          <p class="lede">Tuỳ chọn. Khớp kho riêng giữa các máy của bạn. Không chia sẻ gì cho kho cộng đồng.</p>
        </div>
        <span class="sbadge" id="sync-badge" data-state="off" role="status" aria-live="polite"><i aria-hidden="true"></i><span id="sync-state">Đang tắt</span></span>
      </header>
      <label class="setrow">
        <span class="txt">
          <span class="t">Bật sao lưu kho riêng</span>
          <span class="d">Khi tắt, lịch sử và trạng thái account chỉ nằm trên máy này.</span>
        </span>
        <span class="switch"><input type="checkbox" id="enabled"><span class="track" aria-hidden="true"></span></span>
      </label>
      <fieldset class="cfg" id="cfg" hidden>
        <legend class="lbl">Nơi sao lưu</legend>
        <div class="choices">
          <label class="opt"><input type="radio" name="backend" value="chrome-sync"><span><b>Chrome Sync</b><small>Theo tài khoản Chrome đang đăng nhập. Tối đa khoảng 100 KB.</small></span></label>
          <label class="opt"><input type="radio" name="backend" value="rest"><span><b>REST endpoint</b><small>Server riêng của bạn. Không giới hạn dung lượng.</small></span></label>
        </div>
        <div class="rest" id="rest-only" hidden>
          <label class="field"><span class="lbl">Endpoint</span>
            <input class="input" type="url" id="endpoint" placeholder="https://vi-du.com/api/vault" spellcheck="false" autocomplete="off">
          </label>
          <label class="field"><span class="lbl">Token <em>(tuỳ chọn)</em></span>
            <input class="input" type="password" id="token" spellcheck="false" autocomplete="off">
            <span class="hint">Gửi qua header Authorization. Mọi thông báo lỗi đều đã che token trước khi hiện ra.</span>
          </label>
        </div>
        <label class="setrow">
          <span class="txt">
            <span class="t">Tự sao lưu sau mỗi lượt đổi mã</span>
            <span class="d">Sao lưu lỗi không bao giờ làm mất dữ liệu trên máy.</span>
          </span>
          <span class="switch"><input type="checkbox" id="auto"><span class="track" aria-hidden="true"></span></span>
        </label>
      </fieldset>
      <div class="meta" id="sync-meta"></div>
      <footer class="block-ft">
        <span class="msg"><span class="status" id="status" role="status" aria-live="polite"></span><span class="dirty" id="dirty" hidden>● Có thay đổi chưa lưu</span></span>
        <button class="act lg" id="test" type="button" hidden>Kiểm tra kết nối</button>
        <button class="act primary lg" id="save" type="button">Lưu cài đặt</button>
      </footer>
    </section>

    <section class="block" id="local" aria-labelledby="local-h">
      <header class="block-hd">
        <div>
          <h2 id="local-h">Kho trên máy này</h2>
          <p class="lede">Nguồn dữ liệu chính, lưu trong trình duyệt và dùng được khi không có mạng.</p>
        </div>
      </header>
      <dl class="stats" aria-live="polite">
        <div><dt>Mã quà</dt><dd id="st-gift">—</dd></div>
        <div><dt>Mã lắp súng</dt><dd id="st-preset">—</dd></div>
        <div><dt>Chờ đổi</dt><dd id="st-untried">—</dd></div>
        <div><dt>Tặng được</dt><dd id="st-share">—</dd></div>
      </dl>
      <p class="note">File xuất chứa mã quà, mã lắp súng và trạng thái đổi trên máy này. Không chứa token hay cài đặt.</p>
      <footer class="block-ft">
        <span class="msg"><span class="status" id="status2" role="status" aria-live="polite"></span></span>
        <button class="act lg" id="export-csv" type="button">Xuất CSV</button>
        <button class="act lg" id="export" type="button">Xuất file sao lưu (.json)</button>
      </footer>
    </section>

    <section class="block danger" id="danger" aria-labelledby="danger-h">
      <header class="block-hd">
        <div>
          <h2 id="danger-h">Vùng nguy hiểm</h2>
          <p class="lede">Không hoàn tác được. Luôn có hộp thoại xác nhận trước khi xoá.</p>
        </div>
      </header>
      <div class="setrow">
        <span class="txt">
          <span class="t">Xoá bản sao lưu trên Chrome Sync</span>
          <span class="d">Xoá bản chép trong Chrome Sync và cài đặt sao lưu, kể cả token. Kho trên máy và kho cộng đồng giữ nguyên. Dữ liệu trên REST endpoint không bị xoá — hãy xoá ở server của bạn.</span>
        </span>
        <button class="act danger lg" id="wipe" type="button">Xoá bản sao lưu</button>
      </div>
      <p class="status note" id="status3" role="status" aria-live="polite"></p>
    </section>
   </main>
  </div>
 </div>

  <script src="options.js"></script>
</body>
</html>
`;

const optionsJs = `${BANNER}
/* options.js — personal backup settings, local vault export, danger zone.
 * Settings go through the service worker so the token never reaches this
 * page; the vault is read directly because it is this origin's IndexedDB. */
(function dfRedeemOptions() {
  'use strict';
  const root = window;
${schema}
${vault}
  const STATUS_KEY = 'dfRedeemSyncStatus';
  const $ = (id) => document.getElementById(id);
  const ask = (op, payload) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op, payload });
  const errText = (res) => (res && res.error) || 'không rõ';
${uiWhen}
  const timers = new Map();
  function flash(el, message, tone) {
    el.textContent = message;
    el.dataset.tone = tone || '';
    clearTimeout(timers.get(el));
    if (tone !== 'busy') {
      timers.set(el, setTimeout(() => { el.textContent = ''; el.dataset.tone = ''; }, 5000));
    }
  }

  /* ── personal backup form ── */
  let saved = null;
  let enabledSaved = false;

  function backendValue() {
    const picked = document.querySelector('input[name="backend"]:checked');
    return picked ? picked.value : 'chrome-sync';
  }
  function setBackend(value) {
    document.querySelectorAll('input[name="backend"]').forEach((radio) => { radio.checked = radio.value === value; });
  }
  function formState() {
    return {
      enabled: $('enabled').checked,
      backend: backendValue(),
      endpoint: $('endpoint').value.trim(),
      autoSync: $('auto').checked,
      token: $('token').value !== '',
    };
  }
  const isDirty = () => Boolean(saved) && JSON.stringify(formState()) !== JSON.stringify(saved);

  function syncUi() {
    $('cfg').hidden = !$('enabled').checked;
    $('rest-only').hidden = backendValue() !== 'rest';
    $('test').hidden = !$('enabled').checked;
    $('dirty').hidden = !isDirty();
  }

  function renderSyncStatus(status) {
    const state = !enabledSaved ? 'off' : (status && status.state) || 'never-synced';
    const labels = { off: 'Đang tắt', ok: 'Đã sao lưu', syncing: 'Đang sao lưu…', error: 'Sao lưu lỗi', 'never-synced': 'Chưa sao lưu' };
    $('sync-badge').dataset.state = state;
    $('sync-state').textContent = labels[state] || state;
    const meta = $('sync-meta');
    meta.textContent = '';
    if (state === 'off') return;
    const add = (text, cls) => {
      const span = document.createElement('span');
      span.textContent = text;
      if (cls) span.className = cls;
      meta.appendChild(span);
    };
    if (status && status.lastSyncAt) add('Lần cuối: ' + when(status.lastSyncAt));
    if (status && Number.isFinite(Number(status.recordCount)) && status.recordCount !== null) add(String(status.recordCount) + ' mã trong bản sao lưu');
    if (state === 'error' && status && status.error) add(status.error, 'err');
  }

  async function load() {
    const settings = (await ask('getSettings')) || {};
    $('enabled').checked = settings.enabled === true;
    setBackend(settings.backend || 'chrome-sync');
    $('endpoint').value = settings.endpoint || '';
    $('auto').checked = settings.autoSync === true;
    $('token').value = '';
    /* hasToken is a boolean flag; the token itself never leaves the worker. */
    $('token').placeholder = settings.hasToken ? 'Đã lưu token — nhập để thay' : 'Để trống nếu endpoint không cần xác thực';
    enabledSaved = settings.enabled === true;
    saved = formState();
    syncUi();
    renderSyncStatus(await ask('status'));
  }

  function validEndpoint(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch (_) { return false; }
  }

  async function save() {
    const form = formState();
    if (form.enabled && form.backend === 'rest' && !validEndpoint(form.endpoint)) {
      flash($('status'), 'Endpoint phải là địa chỉ http(s) đầy đủ.', 'err');
      $('endpoint').focus();
      return false;
    }
    const payload = { enabled: form.enabled, backend: form.backend, endpoint: form.endpoint, autoSync: form.autoSync };
    const token = $('token').value;
    if (token) payload.token = token;
    const res = await ask('setSettings', payload);
    $('token').value = '';
    if (!res || !res.ok) {
      flash($('status'), 'Không lưu được: ' + errText(res), 'err');
      return false;
    }
    flash($('status'), 'Đã lưu.', 'ok');
    await load();
    return true;
  }

  ['enabled', 'auto', 'endpoint', 'token'].forEach((id) => {
    $(id).addEventListener('input', syncUi);
    $(id).addEventListener('change', syncUi);
  });
  document.querySelectorAll('input[name="backend"]').forEach((radio) => radio.addEventListener('change', syncUi));

  $('save').addEventListener('click', async () => {
    $('save').disabled = true;
    try { await save(); } finally { $('save').disabled = false; }
  });

  /* The worker tests the STORED settings, so unsaved edits are saved first —
   * otherwise "test" would silently check the previous configuration. */
  $('test').addEventListener('click', async () => {
    const btn = $('test');
    btn.disabled = true;
    try {
      if (isDirty() && !(await save())) return;
      flash($('status'), 'Đang kiểm tra…', 'busy');
      const res = await ask('test');
      flash($('status'), res && res.ok ? 'Kết nối tốt, đã đồng bộ.' : 'Thất bại: ' + errText(res), res && res.ok ? 'ok' : 'err');
      renderSyncStatus(res && res.status ? res.status : { state: 'error', error: errText(res) });
    } finally {
      syncUi();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATUS_KEY]) renderSyncStatus(changes[STATUS_KEY].newValue);
  });
  window.addEventListener('beforeunload', (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  /* ── local vault ── */
  let vaultPromise = null;
  function openVault() {
    if (!vaultPromise) {
      const v = new root.DFRedeemVault.Vault({ adapter: new root.DFRedeemVault.IndexedDBAdapter() });
      vaultPromise = v.init().then(() => v);
      vaultPromise.catch(() => { vaultPromise = null; });
    }
    return vaultPromise;
  }

  async function loadStats() {
    try {
      const all = await (await openVault()).all();
      const gifts = all.filter((r) => r.kind !== 'preset');
      $('st-gift').textContent = gifts.length;
      $('st-preset').textContent = all.length - gifts.length;
      $('st-untried').textContent = gifts.filter((r) => r.status === 'untried').length;
      $('st-share').textContent = gifts.filter((r) => r.status === 'success' || r.status === 'mine').length;
    } catch (e) {
      flash($('status2'), 'Không đọc được kho: ' + (e && e.message || e), 'err');
    }
  }

  function download(text, name, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  /* Local calendar date: an evening export in UTC+7 must not be named after
   * the previous day. */
  const stamp = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };

  async function exportAs(btn, kind) {
    btn.disabled = true;
    try {
      const v = await openVault();
      const count = (await v.all()).length;
      if (kind === 'json') download(await v.exportJSON(), 'df-redeem-kho-' + stamp() + '.json', 'application/json');
      else download(await v.exportCSV(), 'df-redeem-kho-' + stamp() + '.csv', 'text/csv;charset=utf-8');
      flash($('status2'), 'Đã xuất ' + count + ' mã.', 'ok');
    } catch (e) {
      flash($('status2'), 'Không xuất được: ' + (e && e.message || e), 'err');
    } finally {
      btn.disabled = false;
    }
  }
  $('export').addEventListener('click', () => exportAs($('export'), 'json'));
  $('export-csv').addEventListener('click', () => exportAs($('export-csv'), 'csv'));

  /* ── danger zone ── */
  $('wipe').addEventListener('click', async () => {
    const lines = [
      'Xoá bản sao lưu trên Chrome Sync và cài đặt sao lưu (kể cả token)?',
      '',
      'Kho mã trên máy này KHÔNG bị xoá. Dữ liệu trên REST endpoint (nếu có) cũng không bị xoá.',
    ];
    if (!confirm(lines.join(String.fromCharCode(10)))) return;
    const res = await ask('wipe');
    flash($('status3'), res && res.ok ? 'Đã xoá bản sao lưu và cài đặt.' : 'Không xoá được: ' + errText(res), res && res.ok ? 'ok' : 'err');
    await load();
  });

  /* ── section nav: mark the section in view ──
   * The last section is short, so at the bottom of the page it never reaches
   * the reading line; the bottom of the page therefore always selects it. */
  const links = Array.from(document.querySelectorAll('.toc a'));
  const sections = Array.from(document.querySelectorAll('.block'));
  function spy() {
    const line = window.innerHeight * 0.3;
    const page = document.documentElement.scrollHeight;
    const atBottom = page > window.innerHeight + 2 && window.scrollY + window.innerHeight >= page - 2;
    let current = sections[0];
    sections.forEach((section) => { if (section.getBoundingClientRect().top <= line) current = section; });
    if (atBottom) current = sections[sections.length - 1];
    links.forEach((a) => a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + current.id)));
  }
  let spyFrame = 0;
  window.addEventListener('scroll', () => {
    if (!spyFrame) spyFrame = requestAnimationFrame(() => { spyFrame = 0; spy(); });
  }, { passive: true });
  window.addEventListener('hashchange', spy);
  window.addEventListener('resize', spy);
  spy();

  /* Sections change height once settings and stats arrive; re-mark then. */
  Promise.allSettled([load(), loadStats()]).then(spy);
}());
`;

const background = `/* background.js — toolbar action plus the sync broker.
 * The worker is the only place the sync token is read or used. */
${CORE_SYNC}
${hq}
const SETTINGS_KEY = DFRedeemSync.SETTINGS_KEY;
/* Shared across every surface, unlike the per-origin IndexedDB vaults. */
const HISTORY_KEY = 'df_redeem_history_mirror';
const HISTORY_CAP = 500;
/* Panel-owned scratch state the worker only stores and hands back. Keeping the
 * allowed keys explicit stops the bridge from becoming a general storage API
 * that any page script could write settings through. */
const PANEL_STATE_KEYS = { costsLocal: 'df_redeem_costs_local' };

/* ── HQ recommended codes ───────────────────────────────────────────────── */
/* Prices hq-capture.js read on the HQ page. Local only: they are shown next to
 * a build and never reach the community vault. */
const HQ_PRICES_KEY = 'df_redeem_hq_prices';
const HQ_FETCH_TIMEOUT_MS = 20000;
const HQ_PAGE_PREFIX = DFRedeemHQ.HQ_ORIGIN + '/events/hq/';

async function fetchHqSource(source) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), HQ_FETCH_TIMEOUT_MS) : null;
  try {
    /* credentials: 'omit' keeps the player's playdeltaforce.com session
     * cookies off the request; the files are public and need none. */
    const res = await fetch(source.url, {
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : 0));
    const groups = DFRedeemHQ.parseSchemeFile(await res.text(), source.varName);
    return DFRedeemHQ.normalizeSchemes(groups, source.mode);
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('quá thời gian chờ');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readHqPrices() {
  const got = await chrome.storage.local.get(HQ_PRICES_KEY);
  /* Re-validated on every read: storage outlives the code that wrote it. */
  return DFRedeemHQ.mergePrices(got[HQ_PRICES_KEY] || {}, {}, '');
}

async function hqFetch() {
  const settled = await Promise.all(DFRedeemHQ.SOURCES.map((source) => fetchHqSource(source).then(
    (items) => ({ source, items }),
    (error) => ({ source, error: String(error && error.message || error) }),
  )));
  const items = [];
  const seen = new Set();
  const failed = [];
  for (const result of settled) {
    if (result.error) { failed.push({ mode: result.source.mode, error: result.error }); continue; }
    for (const item of result.items) {
      if (seen.has(item.code)) continue;
      seen.add(item.code);
      items.push(item);
    }
  }
  if (!items.length) {
    const why = failed.map((f) => f.mode + ': ' + f.error).join('; ') || 'HQ không có mã nào';
    return { ok: false, error: 'Không tải được mã HQ — ' + why, items: [], prices: {}, failed };
  }
  const stored = await readHqPrices();
  const prices = {};
  for (const item of items) if (stored[item.code]) prices[item.code] = stored[item.code].price;
  return { ok: true, items, prices, failed };
}

/* Only hq-bridge.js on the HQ page may report prices. The redeem-page bridge
 * relays any op its page asks for, so the sender URL is what tells them apart. */
async function hqSavePrices(payload, sender) {
  const from = sender && typeof sender.url === 'string' ? sender.url : '';
  if (from.indexOf(HQ_PAGE_PREFIX) !== 0) return { ok: false, error: 'Nguồn giá HQ không hợp lệ.' };
  const fresh = DFRedeemHQ.sanitizePrices(payload && payload.items);
  const saved = Object.keys(fresh).length;
  if (!saved) return { ok: true, saved: 0 };
  const got = await chrome.storage.local.get(HQ_PRICES_KEY);
  await chrome.storage.local.set({
    [HQ_PRICES_KEY]: DFRedeemHQ.mergePrices(got[HQ_PRICES_KEY] || {}, fresh, new Date().toISOString()),
  });
  return { ok: true, saved };
}

function service() {
  return DFRedeemSync.createSyncService({ chromeApi: chrome, fetchFn: (...a) => fetch(...a) });
}

/* Map the options-page vocabulary onto sync.js's stored schema. */
function fromUi(patch, current) {
  const next = { ...current };
  if (patch.enabled !== undefined || patch.backend !== undefined) {
    const backend = patch.backend || (current.syncBackend === 'none' ? 'chrome-sync' : current.syncBackend);
    const enabled = patch.enabled === undefined ? current.syncBackend !== 'none' : patch.enabled;
    next.syncBackend = enabled ? backend : 'none';
  }
  if (patch.endpoint !== undefined) next.syncEndpoint = patch.endpoint;
  if (patch.token !== undefined) next.syncToken = patch.token;
  if (patch.autoSync !== undefined) next.autoSyncMinutes = patch.autoSync ? 15 : 0;
  return next;
}

function toUi(settings) {
  return {
    enabled: settings.syncBackend !== 'none',
    backend: settings.syncBackend === 'none' ? 'chrome-sync' : settings.syncBackend,
    endpoint: settings.syncEndpoint || '',
    autoSync: Number(settings.autoSyncMinutes || 0) > 0,
    hasToken: Boolean(settings.syncToken),
  };
}

async function handleSync(op, payload, sender) {
  /* HQ ops need neither sync settings nor the token, so they run before the
   * settings read. */
  if (op === 'hqFetch') return hqFetch();
  if (op === 'hqPrices') return hqSavePrices(payload, sender);
  const svc = service();
  const stored = await svc.getLocal({ [SETTINGS_KEY]: DFRedeemSync.DEFAULT_SETTINGS });
  const current = { ...DFRedeemSync.DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };

  if (op === 'getSettings') return toUi(current);
  if (op === 'setSettings') {
    await svc.setLocal({ [SETTINGS_KEY]: fromUi(payload || {}, current) });
    return { ok: true };
  }
  if (op === 'status') return svc.status();

  /* ── community vault ─────────────────────────────────────────────────────
   * Network access lives here rather than in the drawer: the service worker has
   * the host permissions, and the Garena page's CSP would block these fetches. */
  if (op === 'communityPull') {
    const result = await svc.fetchCommunity(current);
    if (!result.ok) return { ok: false, error: result.error || result.skipped || 'không tải được' };
    return { ok: true, codes: result.codes, presets: result.presets };
  }
  if (op === 'communityPush') {
    const rows = (payload && payload.rows) || [];
    const result = await svc.reportOutcomes(rows, current);
    return {
      ok: Boolean(result.ok),
      sent: Number(result.sent || 0),
      failed: Number(result.failed || 0),
      needed: Number(result.needed || 0),
      skipped: result.skipped || null,
      error: result.error || (result.failures && result.failures[0]) || null,
    };
  }
  /* Equipment costs ride the same channel and for the same reason live here:
   * the drawer's page CSP would block the fetch, the service worker's would not. */
  if (op === 'fetchCosts') {
    const result = await svc.fetchCosts(current);
    if (!result.ok) return { ok: false, error: result.error || result.skipped || 'không tải được', costs: {} };
    return { ok: true, costs: result.costs, count: Number(result.count || 0) };
  }
  if (op === 'reportCost') {
    const result = await svc.reportCost((payload && payload.code) || '', payload && payload.cost, payload && payload.mode, current);
    return {
      ok: Boolean(result.ok),
      cost: Number(result.cost || 0),
      state: result.state || null,
      reports: Number(result.reports || 0),
      unchanged: Boolean(result.unchanged),
      skipped: result.skipped || null,
      error: result.error || null,
    };
  }

  /* ── cross-origin history mirror ─────────────────────────────────────────
   * The drawer runs on the Garena origin and the app/popup on
   * chrome-extension://, and IndexedDB is per-origin: a run done in the drawer
   * was invisible to the full-page History. chrome.storage.local is shared by
   * every surface, so the panel mirrors each finished attempt here and the
   * other surfaces merge it in. Capped so the quota cannot be exhausted. */
  if (op === 'mirrorAttempts') {
    const rows = (payload && payload.rows) || [];
    if (!rows.length) return { ok: true, stored: 0 };
    const bag = await svc.getLocal({ [HISTORY_KEY]: [] });
    const seen = new Set();
    const merged = [];
    for (const r of [...rows, ...(bag[HISTORY_KEY] || [])]) {
      if (!r || !r.code) continue;
      const k = String(r.code).toUpperCase() + '|' + (r.timestamp || '');
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(r);
      if (merged.length >= HISTORY_CAP) break;
    }
    await svc.setLocal({ [HISTORY_KEY]: merged });
    return { ok: true, stored: merged.length };
  }
  if (op === 'readMirror') {
    const bag = await svc.getLocal({ [HISTORY_KEY]: [] });
    return { ok: true, rows: bag[HISTORY_KEY] || [] };
  }
  /* The panel keeps its own unsynced state (costs entered here but not yet
   * agreed by the vault) and cannot reach chrome.storage from the MAIN world,
   * so the worker stores it under a namespaced key on the panel's behalf. */
  if (op === 'getPanelState') {
    const key = PANEL_STATE_KEYS[(payload && payload.key) || ''];
    if (!key) return { ok: false, error: 'Khoá không hợp lệ.' };
    const bag = await svc.getLocal({ [key]: null });
    return { ok: true, value: bag[key] };
  }
  if (op === 'setPanelState') {
    const key = PANEL_STATE_KEYS[(payload && payload.key) || ''];
    if (!key) return { ok: false, error: 'Khoá không hợp lệ.' };
    await svc.setLocal({ [key]: (payload && payload.value) || null });
    return { ok: true };
  }
  if (op === 'push' || op === 'test') {
    if (current.syncBackend === 'none') return { ok: false, error: 'Đồng bộ đang tắt.' };
    const records = op === 'test' ? [] : ((payload && payload.records) || []);
    const status = await svc.syncNow(records);
    return { ok: status.state === 'ok', status, error: status.error || null };
  }
  if (op === 'export') {
    const bag = await chrome.storage.sync.get(null).catch(() => ({}));
    return { ok: true, data: bag };
  }
  if (op === 'wipe') {
    await chrome.storage.sync.clear().catch(() => {});
    await chrome.storage.local.remove(SETTINGS_KEY);
    return { ok: true };
  }
  return { ok: false, error: 'Lệnh không hợp lệ: ' + op };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== 'DF_REDEEM_SYNC') return false;
  handleSync(msg.op, msg.payload, sender)
    .then((result) => respond(result))
    .catch((error) => respond({ ok: false, error: String(error && error.message || error).replace(/Bearer\\s+[^\\s"']+/gi, 'Bearer [redacted]') }));
  return true; /* keep the channel open for the async reply */
});

/* With a popup attached to the toolbar icon, chrome.action.onClicked never
 * fires — the popup owns the click. Opening the in-page drawer therefore moves
 * here, triggered by the popup's "mở bảng trên tab này" button. */
async function openDrawerOnTab(tab) {
  if (!tab || !tab.id) return { ok: false, error: 'Không có tab.' };
  if (!/^https:\\/\\/redeem\\.df\\.garena\\.sg\\//.test(tab.url || '')) {
    await chrome.tabs.create({ url: '${REDEEM_URL}' });
    return { ok: true, opened: 'new-tab' };
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'DF_REDEEM_OPEN' });
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'], world: 'MAIN' });
    await chrome.tabs.sendMessage(tab.id, { type: 'DF_REDEEM_OPEN' });
  }
  return { ok: true, opened: 'drawer' };
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || msg.type !== 'DF_REDEEM_OPEN_DRAWER') return false;
  chrome.tabs.query({ active: true, currentWindow: true })
    .then((tabs) => openDrawerOnTab(tabs && tabs[0]))
    .then(respond)
    .catch((e) => respond({ ok: false, error: String(e && e.message || e) }));
  return true;
});
`;

const written = [
  write(path.join(DIST, 'df-redeem.console.js'), consoleBuild),
  write(path.join(DIST, 'df-redeem.user.js'), userscript),
  write(path.join(DIST, 'df-redeem.headless.js'), headless),
  write(path.join(EXT, 'content.js'), contentScript),
  write(path.join(EXT, 'background.js'), background),
  write(path.join(EXT, 'bridge.js'), bridge),
  write(path.join(EXT, 'hq-capture.js'), hqCapture),
  write(path.join(EXT, 'hq-bridge.js'), hqBridge),
  write(path.join(EXT, 'options.html'), optionsHtml),
  write(path.join(EXT, 'options.js'), optionsJs),
  write(path.join(EXT, 'theme.css'), themeCss),
  write(path.join(EXT, 'app.html'), appHtml),
  write(path.join(EXT, 'app.css'), appCss),
  write(path.join(EXT, 'app.js'), appJs),
  write(path.join(EXT, 'popup.html'), popupHtml),
  write(path.join(EXT, 'popup.js'), popupJs),
  write(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2)),
];

console.log(`df-redeem v${VERSION} built:`);
for (const line of written) console.log('  ' + line);

/* ── syntax gate ────────────────────────────────────────────────────────────
 * Every emitted script is a template string inside this file, so one missing
 * backslash silently ships a file that throws on load — the UI then renders as
 * a blank or half-dead page and only a browser console reveals why. Parse each
 * generated script here and fail the build instead. */
const { execFileSync } = require('child_process');
const scripts = WRITTEN_FILES.filter((f) => f.endsWith('.js'));
const broken = [];
for (const rel of scripts) {
  try {
    execFileSync(process.execPath, ['--check', rel], { stdio: 'pipe' });
  } catch (err) {
    const lines = String((err.stderr || '').toString()).split('\n');
    const detail = (lines.find((l) => /Error/.test(l)) || err.message).trim();
    broken.push(path.relative(ROOT, rel) + ' — ' + detail);
  }
}
if (broken.length) {
  console.error('\nBUILD FAILED — generated scripts do not parse:');
  for (const b of broken) console.error('  ' + b);
  process.exit(1);
}

/* ── icon gate ──────────────────────────────────────────────────────────────
 * Every size named in the manifest must exist on disk: Chrome refuses to load
 * an unpacked extension whose icon path is missing, and a stale icon set after
 * a rename is easy to miss because the build itself still succeeds. The set is
 * produced by tools/make-icons.py (geometric, so 16px stays pixel-exact). */
const iconSizes = new Set([
  ...Object.keys(manifest.icons),
  ...Object.keys((manifest.action && manifest.action.default_icon) || {}),
]);
const missingIcons = [];
for (const size of iconSizes) {
  const file = path.join(EXT, 'icons', `icon${size}.png`);
  if (!fs.existsSync(file)) missingIcons.push(path.relative(ROOT, file));
  else if (fs.statSync(file).size < 100) missingIcons.push(path.relative(ROOT, file) + ' (empty)');
}
if (missingIcons.length) {
  console.error('\nBUILD FAILED — manifest references missing icons:');
  for (const m of missingIcons) console.error('  ' + m);
  /* make-icons.py needs Pillow, and the first `python` on PATH often does not
   * have it (here it is a Hermes-bundled build). Printing a bare `python` sends
   * the reader into a ModuleNotFoundError, so name an interpreter that actually
   * imports PIL. Probe candidates rather than hardcoding one machine's path. */
  const candidates = process.platform === 'win32'
    ? ['python', 'py -3.12', 'py -3', 'python3']
    : ['python3', 'python'];
  let runner = null;
  for (const candidate of candidates) {
    const parts = candidate.split(' ');
    try {
      execFileSync(parts[0], [...parts.slice(1), '-c', 'import PIL'], { stdio: 'ignore' });
      runner = candidate;
      break;
    } catch { /* missing interpreter or missing Pillow — try the next */ }
  }
  if (runner) {
    console.error(`  run: ${runner} tools/make-icons.py extension/icons`);
  } else {
    console.error('  run: <python-with-Pillow> tools/make-icons.py extension/icons');
    console.error('  no interpreter on PATH could import PIL — pip install Pillow');
  }
  process.exit(1);
}
console.log(`syntax ok — ${scripts.length} generated scripts parse`);
