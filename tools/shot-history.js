/* shot-history.js — close any palette, land on History, capture it clean. */
'use strict';
const fs = require('fs');
const path = require('path');
const { attach } = require('./cdp');
const OUT = process.argv[2] || '.';
const SH = "(() => { const h = document.getElementById('df-redeem-root') || [...document.querySelectorAll('*')].find((e) => e.shadowRoot && e.shadowRoot.querySelector('.drawer')); return h && h.shadowRoot; })()";
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.find((x) => x.url.includes('cdkgarena'));
  const c = await attach(t.webSocketDebuggerUrl);
  /* Close the command palette and any cookie banner so neither covers the view. */
  const closed = await c.evaluate(`(() => {
    const sh = ${SH};
    const p = sh.querySelector('.palette, .palette-wrap, [class*=palette]');
    let hid = false;
    if (p) { p.hidden = true; p.classList.remove('open'); p.style.display = 'none'; hid = true; }
    const ov = sh.querySelector('.scrim, .backdrop, .overlay');
    if (ov) { ov.style.display = 'none'; hid = true; }
    /* Garena's own cookie bar sits over the page, not over us. */
    for (const s of ['#onetrust-consent-sdk', '.ot-sdk-row', '#onetrust-banner-sdk']) {
      const el = document.querySelector(s); if (el) el.style.display = 'none';
    }
    const b = sh.querySelector('.vtab[data-view="history"]'); if (b) b.click();
    return hid;
  })()`);
  await new Promise((r) => setTimeout(r, 1200));
  const txt = await c.evaluate(`(() => {
    const sh = ${SH}; const h = sh.querySelector('.view-host');
    return [...h.querySelectorAll('.tline li')].map((l) => l.textContent.replace(/\s+/g, ' ').trim()).slice(0, 6);
  })()`);
  console.log('palette closed:', closed);
  console.log('history entries:\n  ' + (txt.length ? txt.join('\n  ') : '(none)'));
  const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'drawer-history-clean.png'), Buffer.from(data, 'base64'));
  console.log('→ drawer-history-clean.png');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
