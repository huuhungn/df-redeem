'use strict';
const { attach } = require('./cdp');
const SH = "(() => { const h = document.getElementById('df-redeem-root') || [...document.querySelectorAll('*')].find((e) => e.shadowRoot && e.shadowRoot.querySelector('.drawer')); return h && h.shadowRoot; })()";
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.filter((x) => x.url.startsWith('file:')).pop();
  const c = await attach(t.webSocketDebuggerUrl);
  const r = await c.evaluate(`(() => {
    const sh = ${SH};
    if (!sh) return { err: 'no shadow' };
    const q = (s) => { const e = sh.querySelector(s); if (!e) return null; const cs = getComputedStyle(e); const b = e.getBoundingClientRect(); return { hidden: e.hidden, display: cs.display, opacity: cs.opacity, z: cs.zIndex, rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)], cls: e.className }; };
    return { vw: innerWidth, vh: innerHeight, palette: q('.palette-wrap'), drawer: q('.drawer'), shell: q('.shell'), view: q('.view-host'), host: (() => { const h = document.getElementById('df-redeem-root'); const cs = h && getComputedStyle(h); const b = h && h.getBoundingClientRect(); return h ? { z: cs.zIndex, rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] } : null; })() };
  })()`);
  console.log(JSON.stringify(r, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
