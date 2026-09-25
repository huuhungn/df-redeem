/* diag-drawer.js — one-off probe: why did run/export/focus fail on the page? */
'use strict';
const { attach } = require('./cdp');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SH = `(() => {
  const h = document.getElementById('df-redeem-root') ||
            [...document.querySelectorAll('*')].find((e) => e.shadowRoot && e.shadowRoot.querySelector('.drawer'));
  return h && h.shadowRoot;
})()`;

(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.find((x) => x.url.includes('cdkgarena'));
  if (!t) { console.log('no garena tab open'); process.exit(1); }
  const c = await attach(t.webSocketDebuggerUrl);

  console.log('--- run tab state ---');
  await c.evaluate(`(() => { const sh = ${SH}; const b = sh.querySelector('.vtab[data-view="run"]'); if (b) b.click(); })()`);
  await wait(800);
  console.log(JSON.stringify(await c.evaluate(`(() => {
    const sh = ${SH}; const h = sh.querySelector('.view-host');
    const start = sh.querySelector('[data-act="start"]');
    return {
      queueVal: (sh.querySelector('.queue') || {}).value,
      startText: start ? start.textContent.trim() : null,
      startDisabled: start ? start.disabled : null,
      progTxt: (sh.querySelector('.prog-txt') || {}).textContent,
      runlineCount: h.querySelectorAll('.runline').length,
      hostText: h.textContent.replace(/\\s+/g, ' ').trim().slice(0, 400)
    };
  })()`), null, 1));

  console.log('\n--- what globals does the page expose? ---');
  console.log(JSON.stringify(await c.evaluate(`Object.keys(window).filter((k) => /df|redeem|vault/i.test(k))`)));

  console.log('\n--- share tab: export controls available ---');
  await c.evaluate(`(() => { const sh = ${SH}; const b = sh.querySelector('.vtab[data-view="share"]'); if (b) b.click(); })()`);
  await wait(800);
  console.log(JSON.stringify(await c.evaluate(`(() => {
    const sh = ${SH}; const h = sh.querySelector('.view-host');
    return [...h.querySelectorAll('button')].map((b) => ({ act: b.dataset.act || null, txt: b.textContent.trim().slice(0, 30) }));
  })()`), null, 1));

  console.log('\n--- visible text inputs on the page ---');
  console.log(JSON.stringify(await c.evaluate(`[...document.querySelectorAll('input')].map((el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { type: el.type, id: el.id || null, w: Math.round(r.width), h: Math.round(r.height),
             vis: cs.visibility, disp: cs.display, disabled: el.disabled, ro: el.readOnly };
  })`), null, 1));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(2); });
