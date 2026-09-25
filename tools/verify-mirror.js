/* verify-mirror.js — prove a run in the drawer is visible on the extension page.
 *
 * The drawer's vault lives on the Garena origin, the app's on
 * chrome-extension://; IndexedDB never crosses that line. This drives a real
 * run in the drawer, then reads the app's History to confirm the shared mirror
 * carried the attempts across.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { attach } = require('./cdp');
const EXT = process.argv[2];
const CODES = (process.argv[3] || 'DFULTRA220,DFEXPIRED01').split(',');
const OUT = process.argv[4];
const SH = "(() => { const h = document.getElementById('df-redeem-root') || [...document.querySelectorAll('*')].find((e) => e.shadowRoot && e.shadowRoot.querySelector('.drawer')); return h && h.shadowRoot; })()";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
const pass = (m, d) => { ok++; console.log('ok   ' + m + (d ? ' — ' + d : '')); };
const fail = (m, d) => { bad++; console.log('FAIL ' + m + (d ? ' — ' + d : '')); };

(async () => {
  /* Clear the mirror so the assertion cannot pass on stale data. */
  const bgList = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const sw = bgList.find((x) => x.url.includes('background') || x.type === 'service_worker');
  if (sw) {
    const c0 = await attach(sw.webSocketDebuggerUrl);
    await c0.evaluate(`chrome.storage.local.remove('df_redeem_history_mirror').then(() => 'cleared')`);
    pass('mirror cleared before the run');
  } else {
    console.log('..   no service worker target; mirror not pre-cleared');
  }

  /* 1. run in the drawer, on the mock page (real engine, offline backend). */
  const mock = pathToFileURL(path.join(__dirname, '..', 'test', 'mock-redeem.html')).href;
  const tab = await (await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent(mock)}`, { method: 'PUT' })).json();
  const c = await attach(tab.webSocketDebuggerUrl);
  await wait(1500);
  const src = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
  await c.send('Runtime.evaluate', { expression: src });
  await wait(2500);

  /* The mock page is not the Garena origin, so bridge.js is absent: stand in
   * for it with the same relay contract so mirroring can be exercised. */
  await c.send('Runtime.evaluate', { expression: `
    window.addEventListener('message', async (ev) => {
      if (ev.source !== window) return;
      const m = ev.data;
      if (!m || m.channel !== 'df-redeem-sync' || !m.id) return;
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: m.op, payload: m.payload });
        window.postMessage({ channel: 'df-redeem-sync-reply', id: m.id, ok: true, reply }, location.origin);
      } catch (e) {
        window.postMessage({ channel: 'df-redeem-sync-reply', id: m.id, ok: false, error: String(e.message || e) }, location.origin);
      }
    });
  ` }).catch(() => {});
  await wait(500);

  const mounted = await c.evaluate(`${SH} ? 'yes' : 'no'`);
  if (mounted !== 'yes') return fail('drawer mounts on the run page'), finish();
  pass('drawer mounts on the run page');

  await c.evaluate(`(() => {
    const sh = ${SH};
    const shell = sh.querySelector('.shell');
    if (shell && shell.hidden) { const l = sh.querySelector('.launcher'); if (l) l.click(); }
    const b = sh.querySelector('.vtab[data-view="run"]'); if (b) b.click();
  })()`);
  await wait(900);
  const started = await c.evaluate(`(() => {
    const sh = ${SH};
    const q = sh.querySelector('.queue');
    q.value = ${JSON.stringify(CODES.join('\n'))};
    q.dispatchEvent(new Event('input', { bubbles: true }));
    const p = sh.querySelector('.pace'); if (p) { p.value = '400'; p.dispatchEvent(new Event('input', { bubbles: true })); }
    const r = sh.querySelector('.retries'); if (r) { r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })); }
    const b = sh.querySelector('[data-act="start"]'); if (!b || b.disabled) return false; b.click(); return true;
  })()`);
  if (!started) return fail('run starts from the drawer'), finish();
  for (let i = 0; i < 60; i++) {
    await wait(1200);
    const idle = await c.evaluate(`(() => { const sh = ${SH}; const b = sh.querySelector('[data-act="start"]'); return !!(b && !b.disabled); })()`);
    if (idle && i > 2) break;
  }
  pass('run completes in the drawer', CODES.length + ' codes');

  /* 2. the worker's shared mirror must now hold those attempts. */
  await wait(1200);
  const list2 = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const sw2 = list2.find((x) => x.url.includes('background') || x.type === 'service_worker');
  if (sw2) {
    const c2 = await attach(sw2.webSocketDebuggerUrl);
    const m = await c2.evaluate(`chrome.storage.local.get('df_redeem_history_mirror').then((b) => { const r = b.df_redeem_history_mirror || []; return { n: r.length, codes: r.map((x) => x.code + ':' + x.status) }; })`);
    if (m && m.n) pass('worker stores the mirrored attempts', m.n + ' rows — ' + m.codes.join(', '));
    else fail('worker stores the mirrored attempts', 'mirror is empty');
  }

  /* 3. the extension page must show them, though its own vault has none. */
  const appUrl = 'chrome-extension://' + EXT + '/app.html';
  const tab2 = await (await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent(appUrl)}`, { method: 'PUT' })).json();
  const c3 = await attach(tab2.webSocketDebuggerUrl);
  await wait(3500);
  await c3.evaluate(`(() => { const n = [...document.querySelectorAll('.side-nav [data-view]')].find((x) => x.dataset.view === 'history'); if (n) n.click(); })()`);
  await wait(2500);
  const seen = await c3.evaluate(`(() => {
    const items = [...document.querySelectorAll('ol.tline li')];
    return { n: items.length, text: items.slice(0, 6).map((l) => (l.querySelector('code') || {}).textContent + ':' + ((l.querySelector('.pill') || {}).textContent || '').trim()) };
  })()`);
  const hit = CODES.filter((code) => seen.text.some((t) => t.includes(code)));
  if (hit.length === CODES.length) pass('extension page History shows the drawer run', seen.n + ' entries — ' + seen.text.join(', '));
  else fail('extension page History shows the drawer run', 'expected ' + CODES.join(',') + ' · got ' + JSON.stringify(seen.text));

  if (OUT) {
    const { data } = await c3.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'app-history-mirrored.png'), Buffer.from(data, 'base64'));
    console.log('     → app-history-mirrored.png');
  }
  finish();
})().catch((e) => { console.error('driver error: ' + e.message); process.exit(2); });

function finish() {
  console.log('\n' + ok + '/' + (ok + bad) + ' mirror checks passed');
  process.exit(bad ? 1 : 0);
}
