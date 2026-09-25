/* run-cycle.js — drive one real run from the Run tab, then report History. */
'use strict';
const { attach } = require('./cdp');
const SH = "(() => { const h = document.getElementById('df-redeem-root') || [...document.querySelectorAll('*')].find((e) => e.shadowRoot && e.shadowRoot.querySelector('.drawer')); return h && h.shadowRoot; })()";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const codes = (process.argv[2] || '').split(',').filter(Boolean);
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.find((x) => x.url.includes('cdkgarena'));
  const c = await attach(t.webSocketDebuggerUrl);
  await c.evaluate(`(() => { const sh = ${SH}; const b = sh.querySelector('.vtab[data-view="run"]'); if (b) b.click(); })()`);
  await wait(800);
  const queued = await c.evaluate(`(() => {
    const sh = ${SH};
    const q = sh.querySelector('.queue');
    q.value = ${JSON.stringify(codes.join('\n'))};
    q.dispatchEvent(new Event('input', { bubbles: true }));
    const p = sh.querySelector('.pace'); if (p) { p.value = '900'; p.dispatchEvent(new Event('input', { bubbles: true })); }
    const r = sh.querySelector('.retries'); if (r) { r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })); }
    const b = sh.querySelector('[data-act="start"]'); if (!b || b.disabled) return false; b.click(); return true;
  })()`);
  console.log('started:', queued, '·', codes.length, 'codes');
  for (let i = 0; i < 60; i++) {
    await wait(1500);
    const st = await c.evaluate(`(() => { const sh = ${SH}; const b = sh.querySelector('[data-act="start"]'); const x = sh.querySelector('.prog-txt'); return { idle: !!(b && !b.disabled), txt: x ? x.textContent.trim() : '' }; })()`);
    if (st.txt) console.log('  ' + st.txt);
    if (st.idle && i > 1) break;
  }
  await c.evaluate(`(() => { const sh = ${SH}; const b = sh.querySelector('.vtab[data-view="history"]'); if (b) b.click(); })()`);
  await wait(1500);
  const hist = await c.evaluate(`(() => { const sh = ${SH}; const h = sh.querySelector('.view-host'); return [...h.querySelectorAll('.tline li')].map((l) => l.textContent.replace(/\s+/g, ' ').trim()); })()`);
  console.log('\nhistory (' + hist.length + '):');
  hist.slice(0, 8).forEach((h) => console.log('  ' + h));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
