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
const VERSION = '3.0.0';
/* The redeem form lives on cdkgarena.html. https://redeem.df.garena.sg/vi/ is a
 * DIFFERENT page (no code form), so never send the user there. */
const REDEEM_PATH = '/vi/cdkgarena.html';
const REDEEM_URL = `https://redeem.df.garena.sg${REDEEM_PATH}`;

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
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

const BANNER = `/* Delta Force Auto Redeem v${VERSION}
 * Built ${new Date().toISOString()} — local build, no remote source
 *
 * Verifies every redeem against the network response body, never the popup.
 * No telemetry, no remote code, no credential access. Runs only on
 * redeem.df.garena.sg pages you already opened and logged into.
 */`;

const CORE = `${schema}\n${vault}\n${sync}\n${codes}\n${garena}\n${engine}\nconst DF_REDEEM_SEED = ${seed};`;
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
    syncNow: (records) => askBridge('push', { records: (records || []).map((r) => ({ code: r.code, status: r.status, last_tried: r.last_tried })) }),
    getSettings: () => askBridge('getSettings'),
    /* The drawer's IndexedDB belongs to the Garena origin, so mirror finished
     * attempts into the worker's shared storage — that is the only way the
     * full-page app and the popup can show a run done here. */
    mirrorAttempts: (rows) => askBridge('mirrorAttempts', { rows }),
    readMirror: () => askBridge('readMirror'),
    communityPull: () => askBridge('communityPull'),
    communityPush: (rows) => askBridge('communityPush', { rows }),
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
  name: 'Delta Force Auto Redeem',
  version: VERSION,
  description: 'Đổi hàng loạt giftcode Delta Force, xác minh bằng phản hồi mạng thật. Không gửi dữ liệu ra ngoài.',
  icons: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  action: { default_title: 'Mở bảng đổi code Delta Force', default_popup: 'popup.html' },
  permissions: ['storage', 'scripting', 'activeTab', 'tabs'],
  /* The vault hosts are listed so the extension pages can read the published
   * code list and report verdicts. Kept as narrow literals rather than a wildcard
   * so a review of this manifest shows exactly where data can travel. */
  host_permissions: [
    'https://redeem.df.garena.sg/*',
    'https://raw.githubusercontent.com/huuhungn/df-redeem/*',
    'https://df-redeem-vault.huuhungn.workers.dev/*',
  ],
  background: { service_worker: 'background.js' },
  options_page: 'options.html',
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
  const LABELS = { dashboard: 'Tổng quan', library: 'Kho code', run: 'Chạy đổi', presets: 'Code Súng OP', share: 'Chia sẻ', history: 'Lịch sử' };
  const ICONS = { dashboard: '◈', library: '▤', run: '▶', presets: '⌖', share: '↗', history: '◷' };
  const HINTS = {
    dashboard: 'Tình trạng toàn bộ kho code',
    library: 'Tìm, lọc và xem lịch sử từng mã',
    run: 'Đổi hàng loạt — cần mở trên trang Garena',
    presets: 'Mã lắp súng, nhập trong game',
    share: 'Xuất danh sách cho người khác',
    history: 'Mọi lần thử đã ghi lại',
  };

  /* The page lives on chrome-extension://, so its IndexedDB is a different
   * origin's store than the drawer's. Pass the sync bridge so History can merge
   * the runs the drawer mirrored into shared storage. */
  const sync = {
    readMirror: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'readMirror' }),
    mirrorAttempts: (rows) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'mirrorAttempts', payload: { rows } }),
    communityPull: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'communityPull' }),
    communityPush: (rows) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'communityPush', payload: { rows } }),
  };
  const panel = createPanel({ version: '${VERSION}', target: 'page', surface: 'page', sync });
  const host = document.getElementById('page-view');
  const nav = document.querySelector('.side-nav');

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
    const twin = panel._shadow.querySelector('[data-act="' + act + '"]' + (btn.dataset.code ? '[data-code="' + btn.dataset.code + '"]' : ''));
    if (twin) { twin.click(); setTimeout(() => show(panel._views.find((v) => document.querySelector('.side-nav .on').dataset.view === v)), 30); }
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

/* ── toolbar popup ────────────────────────────────────────────────────── */
/* Small, opinionated: the two numbers that matter, then one button per intent.
 * Anything richer opens the full page — a 360px popup is the wrong place for a
 * 300-row table. */
const popupHtml = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>Auto Redeem</title>
<link rel="stylesheet" href="theme.css">
<style>
  html, body { margin: 0; width: 320px; background: var(--void); }
  .pop { padding: 14px; }
  .pop-hd { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
  .pop-hd h1 { margin: 0; font-size: 14px; }
  .pop-hd .ver { color: var(--ink-mute); font: 600 10px var(--mono); }
  .pop .kpis { grid-template-columns: 1fr 1fr; margin-bottom: 12px; }
  .pop .kpi b { font-size: 22px; }
  .pop .kpi i {
    display: block; margin-top: 2px;
    color: var(--ink-mute); font-style: normal; font-size: 9.5px; line-height: 1.35;
  }
  .pop .btnrow { display: grid; gap: 6px; }
  .pop .act { justify-content: flex-start; }
  /* each action explains itself — the labels alone were ambiguous */
  .pop .act small {
    display: block; margin-top: 1px;
    color: var(--ink-mute); font-size: 9.5px; font-weight: 500; line-height: 1.3;
  }
  .pop .act.primary small { color: color-mix(in srgb, #04231f 72%, transparent); }
  .pop .act { display: block; text-align: left; padding: 8px 11px; }
  .pop .foot { margin-top: 11px; color: var(--ink-mute); font-size: 10.5px; }
</style>
</head>
<body class="df">
  <div class="pop">
    <div class="pop-hd"><h1>Auto Redeem</h1><span class="ver">v${VERSION}</span></div>
    <div class="kpis" id="k"></div>
    <div class="btnrow">
      <button class="act primary" id="open-app">Mở bảng đầy đủ<small>Xem kho, chạy đổi, lịch sử trong tab riêng</small></button>
      <button class="act" id="open-drawer">Mở bảng trên tab này<small>Chỉ dùng khi đang ở trang đổi code Garena</small></button>
      <button class="act" id="open-redeem">Tới trang đổi code<small>Mở redeem.df.garena.sg và đăng nhập</small></button>
      <button class="act" id="copy-share">Copy danh sách chia sẻ<small>Sao chép mã đã đổi xong để gửi bạn bè</small></button>
      <button class="act ghost" id="open-options">Cài đặt</button>
    </div>
    <div class="foot" id="foot"></div>
  </div>
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

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  /* Buttons carry a <small> hint; writing textContent would delete it, so
   * transient feedback only replaces the first text node. */
  const setLabel = (btn, text) => {
    const first = btn.firstChild;
    if (first && first.nodeType === 3) first.nodeValue = text;
    else btn.insertBefore(document.createTextNode(text), btn.firstChild);
  };

  (async function main() {
    const v = new root.DFRedeemVault.Vault({ adapter: new root.DFRedeemVault.IndexedDBAdapter() });
    let gifts = [], presets = [], stats = { byStatus: {} };
    try {
      await v.init();
      await v.seedOnFirstRun(DF_REDEEM_SEED);
      const all = await v.all();
      presets = await v.presets();
      const presetCodes = new Set(presets.map((r) => r.code));
      gifts = all.filter((r) => !presetCodes.has(r.code));
      stats = await v.stats();
    } catch (e) {
      document.getElementById('foot').textContent = 'Không đọc được kho: ' + e.message;
    }
    const by = stats.byStatus || {};
    const share = gifts.filter((r) => r.status === 'success' || r.status === 'mine');
    const untried = gifts.filter((r) => r.status === 'untried');

    /* Plain-language tiles: a first-time user should learn what the numbers
     * mean without opening the full dashboard. "Chưa thử" alone read as
     * meaningless when it was 0, so each tile carries its own hint line. */
    document.getElementById('k').innerHTML =
      '<div class="kpi ok"><b>' + share.length + '</b><span>Mã tặng được</span>' +
        '<i>đã đổi xong, gửi cho bạn bè</i></div>' +
      '<div class="kpi warn"><b>' + untried.length + '</b><span>Mã chờ đổi</span>' +
        '<i>' + (untried.length ? 'bấm Chạy đổi để thử' : 'đã thử hết kho') + '</i></div>';
    document.getElementById('foot').textContent =
      'Kho: ' + gifts.length + ' mã quà · ' + presets.length + ' mã lắp súng';

    document.getElementById('open-app').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
    });
    document.getElementById('open-drawer').addEventListener('click', async () => {
      const btn = document.getElementById('open-drawer');
      try {
        const r = await chrome.runtime.sendMessage({ type: 'DF_REDEEM_OPEN_DRAWER' });
        if (r && r.ok) return window.close();
        setLabel(btn, (r && r.error) || 'Không mở được');
      } catch (e) { setLabel(btn, 'Không mở được'); }
      setTimeout(() => { setLabel(btn, 'Mở bảng trên tab này'); }, 2200);
    });
    document.getElementById('open-redeem').addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://redeem.df.garena.sg/vi/cdkgarena.html' });
    });
    document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
    document.getElementById('copy-share').addEventListener('click', async () => {
      const btn = document.getElementById('copy-share');
      try {
        await navigator.clipboard.writeText(share.map((r) => r.code).join('\\n'));
        setLabel(btn, 'Đã copy ' + share.length + ' mã ✓');
      } catch (_) { setLabel(btn, 'Không copy được'); }
      setTimeout(() => { setLabel(btn, 'Copy danh sách chia sẻ'); }, 2000);
    });
  }());
}());
`;

const optionsHtml = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>Delta Force Auto Redeem — Cài đặt</title>
<link rel="stylesheet" href="theme.css">
<style>
  /* Options inherits every token from theme.css so it reads as one product
   * with the drawer, the popup and the full page. Layout only lives here. */
  body { margin: 0; padding: 0; background: var(--void); color: var(--ink); font: 13px/1.6 var(--sans); }
  .wrap { max-width: 720px; margin: 0 auto; padding: 30px 22px 48px; }
  .masthead { display: flex; align-items: flex-start; gap: 13px; padding-bottom: 16px; margin-bottom: 22px; border-bottom: 1px solid var(--line); }
  .mark { flex: none; width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid var(--primary-dim); border-radius: var(--r); background: var(--primary-glow); color: var(--primary); font: 800 15px var(--mono); }
  .masthead h1 { margin: 0 0 2px; font-size: 16px; letter-spacing: -.01em; }
  .masthead .sub { margin: 0; color: var(--ink-mute); font-size: 11px; }
  .masthead .ver { margin-left: auto; padding: 3px 7px; border: 1px solid var(--line); border-radius: var(--r); color: var(--ink-dim); font: 700 10px var(--mono); }

  fieldset { margin: 0 0 16px; padding: 15px 17px 17px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--panel); }
  legend { padding: 0 7px; color: var(--primary); font: 800 9.5px var(--sans); letter-spacing: .1em; text-transform: uppercase; }
  label { display: grid; gap: 5px; margin-bottom: 12px; color: var(--ink-dim); font-size: 10.5px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; }
  input[type=text], input[type=password], select { padding: 9px 11px; border: 1px solid var(--line); border-radius: var(--r); background: var(--sunken); color: var(--ink); font: 12.5px var(--mono); transition: border-color .15s, box-shadow .15s; }
  input:focus, select:focus { border-color: var(--primary); outline: 0; box-shadow: 0 0 0 3px var(--primary-glow); }
  .check { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; color: var(--ink); font-size: 12.5px; font-weight: 600; letter-spacing: 0; text-transform: none; }
  .check input { accent-color: var(--primary); width: 15px; height: 15px; }
  button { min-height: 34px; padding: 0 15px; border: 1px solid var(--line); border-radius: var(--r); background: var(--raised); color: var(--ink); cursor: pointer; font: 700 11.5px var(--sans); letter-spacing: .04em; transition: border-color .15s, background .15s, color .15s; }
  button:hover { border-color: var(--primary-dim); color: var(--primary); }
  button.primary { border-color: var(--primary-dim); background: var(--primary); color: var(--void); }
  button.primary:hover { background: var(--primary-dim); color: var(--void); }
  button.danger:hover { border-color: var(--danger); color: var(--danger); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
  .note { margin: 8px 0 0; color: var(--ink-mute); font-size: 10.5px; line-height: 1.55; }
  .status { margin-left: 4px; font: 700 11px var(--mono); }
  .ok { color: var(--primary); } .err { color: var(--danger); }
</style>
</head>
<body class="df">
 <div class="wrap">
  <header class="masthead">
    <div class="mark">DF</div>
    <div>
      <h1>Delta Force Auto Redeem</h1>
      <p class="sub">Kho code là danh sách mã quà và mã lắp súng extension lưu trong máy bạn. Đồng bộ giúp giữ nguyên trạng thái đã đổi khi bạn dùng Chrome trên máy khác. Không bật cũng dùng bình thường được.</p>
    </div>
    <span class="ver">v${VERSION}</span>
  </header>

  <fieldset>
    <legend>Đồng bộ</legend>
    <label class="check"><input type="checkbox" id="enabled"> Bật đồng bộ kho code</label>
    <p class="note">Tắt: mọi thứ chỉ nằm trên máy này. Bật: trạng thái đã đổi được sao lưu và khớp giữa các máy.</p>
    <label>Nơi lưu
      <select id="backend">
        <option value="chrome-sync">Chrome Sync (miễn phí, ~100 KB, theo tài khoản Google)</option>
        <option value="rest">REST endpoint (tự host, không giới hạn)</option>
      </select>
    </label>
    <div id="rest-only" hidden>
      <label>Endpoint
        <input type="text" id="endpoint" placeholder="https://vi-du.com/api/vault" spellcheck="false">
      </label>
      <label>Token (tuỳ chọn)
        <input type="password" id="token" placeholder="để trống nếu endpoint không cần xác thực" spellcheck="false">
      </label>
      <p class="note">Token gửi dưới dạng header Authorization. Mọi thông báo lỗi đều đã khử token trước khi hiện ra.</p>
    </div>
    <label class="check"><input type="checkbox" id="auto"> Tự đồng bộ sau mỗi lượt chạy</label>
    <p class="note">Nên bật — sau mỗi lượt đổi, kết quả được đẩy lên ngay, không cần bấm Lưu.</p>
    <div class="row">
      <button class="primary" id="save">Lưu</button>
      <button id="test">Kiểm tra kết nối</button>
      <span class="status" id="status"></span>
    </div>
  </fieldset>

  <fieldset>
    <legend>Kho cục bộ</legend>
    <div class="row">
      <button id="export">Xuất file sao lưu (.json)</button>
      <button class="danger" id="wipe">Xoá bản sao lưu trên cloud</button>
      <span class="status" id="status2"></span>
    </div>
    <p class="note"><b>Xuất file sao lưu</b> tải toàn bộ kho về máy để giữ lại hoặc chuyển sang máy khác.</p>
    <p class="note"><b>Xoá bản sao lưu trên cloud</b> chỉ dọn bản chép trên Chrome Sync hoặc endpoint của bạn cùng phần cài đặt ở trên. Kho mã trong máy KHÔNG bị xoá — bạn sẽ không mất mã nào, và sẽ có hộp thoại xác nhận trước khi xoá.</p>
  </fieldset>
 </div>

  <script src="options.js"></script>
</body>
</html>
`;

const optionsJs = `/* options.js — reads and writes sync settings through the service worker. */
(function dfRedeemOptions() {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ask = (op, payload) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op, payload });

  function flash(el, message, ok) {
    el.textContent = message;
    el.className = 'status ' + (ok ? 'ok' : 'err');
    setTimeout(() => { el.textContent = ''; }, 4000);
  }

  function toggleRest() { $('rest-only').hidden = $('backend').value !== 'rest'; }

  async function load() {
    const settings = (await ask('getSettings')) || {};
    $('enabled').checked = settings.enabled === true;
    $('backend').value = settings.backend || 'chrome-sync';
    $('endpoint').value = settings.endpoint || '';
    $('auto').checked = settings.autoSync !== false;
    /* hasToken is a boolean flag; the token itself never leaves the worker. */
    if (settings.hasToken) $('token').placeholder = '•••••• (đã lưu — để trống nếu không đổi)';
    toggleRest();
  }

  $('backend').addEventListener('change', toggleRest);

  $('save').addEventListener('click', async () => {
    const payload = {
      enabled: $('enabled').checked,
      backend: $('backend').value,
      endpoint: $('endpoint').value.trim(),
      autoSync: $('auto').checked,
    };
    const token = $('token').value;
    if (token) payload.token = token;
    const res = await ask('setSettings', payload);
    $('token').value = '';
    flash($('status'), res && res.ok ? 'Đã lưu.' : 'Lỗi: ' + ((res && res.error) || 'không rõ'), res && res.ok);
    if (res && res.ok) load();
  });

  $('test').addEventListener('click', async () => {
    flash($('status'), 'Đang kiểm tra…', true);
    const res = await ask('test');
    flash($('status'), res && res.ok ? 'Kết nối tốt.' : 'Thất bại: ' + ((res && res.error) || 'không rõ'), res && res.ok);
  });

  $('export').addEventListener('click', async () => {
    const res = await ask('export');
    if (!res || !res.ok) { flash($('status2'), 'Không xuất được.', false); return; }
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    await chrome.downloads?.download?.({ url, filename: 'df-redeem-vault.json' }).catch(() => {});
    const a = document.createElement('a');
    a.href = url; a.download = 'df-redeem-vault.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    flash($('status2'), 'Đã xuất.', true);
  });

  $('wipe').addEventListener('click', async () => {
    if (!confirm(['Xoá bản sao lưu trên cloud và cài đặt đồng bộ?', '', 'Kho mã trong máy này KHÔNG bị xoá — bạn không mất mã nào.'].join(String.fromCharCode(10)))) return;
    const res = await ask('wipe');
    flash($('status2'), res && res.ok ? 'Đã xoá.' : 'Lỗi.', res && res.ok);
    load();
  });

  load();
}());
`;

const background = `/* background.js — toolbar action plus the sync broker.
 * The worker is the only place the sync token is read or used. */
${CORE_SYNC}
const SETTINGS_KEY = DFRedeemSync.SETTINGS_KEY;
/* Shared across every surface, unlike the per-origin IndexedDB vaults. */
const HISTORY_KEY = 'df_redeem_history_mirror';
const HISTORY_CAP = 500;

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

async function handleSync(op, payload) {
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
      skipped: result.skipped || null,
      error: result.error || (result.failures && result.failures[0]) || null,
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

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || msg.type !== 'DF_REDEEM_SYNC') return false;
  handleSync(msg.op, msg.payload)
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
console.log(`syntax ok — ${scripts.length} generated scripts parse`);
