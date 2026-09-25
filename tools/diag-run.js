/* diag-run.js — why does the run engine stall at "Chuẩn bị…"? */
'use strict';
const { attach, watchConsole } = require('./cdp');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SH = `(() => {
  const h = document.getElementById('df-redeem-root') ||
            [...document.querySelectorAll('*')].find((e) => e.shadowRoot && e.shadowRoot.querySelector('.drawer'));
  return h && h.shadowRoot;
})()`;

(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.find((x) => x.url.includes('cdkgarena'));
  const c = await attach(t.webSocketDebuggerUrl);
  const logs = await watchConsole(c);

  console.log('--- vault API surface ---');
  console.log(JSON.stringify(await c.evaluate(`Object.keys(window.DFRedeemVault || {})`)));
  console.log('vault row count:', JSON.stringify(await c.evaluate(`(async () => {
    const v = window.DFRedeemVault;
    for (const m of ['all', 'list', 'getAll', 'rows', 'load']) {
      if (typeof v[m] === 'function') { try { const r = await v[m](); return { method: m, n: Array.isArray(r) ? r.length : typeof r }; } catch (e) { return { method: m, err: e.message }; } }
    }
    return 'no reader found';
  })()`)));

  console.log('\n--- engine API surface ---');
  console.log(JSON.stringify(await c.evaluate(`Object.keys(window.DFRedeemEngine || {})`)));

  console.log('\n--- garena helper surface ---');
  console.log(JSON.stringify(await c.evaluate(`Object.keys(window.DFRedeemGarena || {})`)));

  console.log('\n--- does the page have a live session? ---');
  console.log(JSON.stringify(await c.evaluate(`(async () => {
    const g = window.DFRedeemGarena;
    const out = { cookies: document.cookie ? document.cookie.split(';').map((s) => s.trim().split('=')[0]) : [] };
    if (g && typeof g.session === 'function') { try { out.session = await g.session(); } catch (e) { out.sessionErr = e.message; } }
    if (g && typeof g.getSession === 'function') { try { out.session2 = await g.getSession(); } catch (e) { out.session2Err = e.message; } }
    return out;
  })()`), null, 1));

  console.log('\n--- start a run and watch progress tick by tick ---');
  await c.evaluate(`(() => { const sh = ${SH}; const b = sh.querySelector('.vtab[data-view="run"]'); if (b) b.click(); })()`);
  await wait(600);
  await c.evaluate(`(() => {
    const sh = ${SH};
    const q = sh.querySelector('.queue'); q.value = 'DFOS7KZM90'; q.dispatchEvent(new Event('input', { bubbles: true }));
    const b = sh.querySelector('[data-act="start"]'); if (b) b.click();
  })()`);
  for (let i = 0; i < 12; i++) {
    await wait(2000);
    const st = await c.evaluate(`(() => {
      const sh = ${SH}; const h = sh.querySelector('.view-host');
      return { prog: (sh.querySelector('.prog-txt') || {}).textContent,
               bar: (sh.querySelector('.prog-bar i') || {}).style && (sh.querySelector('.prog-bar i').style.width),
               lines: [...h.querySelectorAll('.runline')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim().slice(0, 70)),
               startDisabled: (sh.querySelector('[data-act="start"]') || {}).disabled };
    })()`);
    console.log(`t+${(i + 1) * 2}s`, JSON.stringify(st));
    if (st.startDisabled === false && i > 1) break;
  }

  console.log('\n--- console / errors captured ---');
  console.log(logs.length ? logs.slice(0, 12).join('\n') : '(none)');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(2); });
