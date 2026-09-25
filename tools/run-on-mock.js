/* run-on-mock.js — exercise a full multi-code run against the offline mock.
 *
 * The content script is scoped to the real Garena host, so on the mock page we
 * inject the same built bundle by hand. Everything downstream — engine, vault,
 * panel, History — is the shipped code, so a green run here proves the run
 * pipeline end to end without touching Garena.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { attach, watchConsole } = require('./cdp');
const EXT = process.argv[2];
const MOCK = process.argv[3];
const CODES = (process.argv[4] || 'DFULTRA220,POC3105S96,DFEXPIRED01,DFGIFTERR01,DFNOSUCH99').split(',');
const SH = "(() => { const h = document.getElementById('df-redeem-root') || [...document.querySelectorAll('*')].find((e) => e.shadowRoot && e.shadowRoot.querySelector('.drawer')); return h && h.shadowRoot; })()";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const url = 'file:///' + MOCK.split('\\').join('/');
  const tab = await (await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const c = await attach(tab.webSocketDebuggerUrl);
  const { logs } = await watchConsole(c);
  await c.navigate(url);
  await wait(1500);

  /* Inject the shipped content bundle. */
  const src = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
  await c.send('Runtime.evaluate', { expression: src, returnByValue: false });
  await wait(3000);

  const mounted = await c.evaluate(`${SH} ? 'yes' : 'no'`);
  console.log('drawer mounted on mock:', mounted);
  /* Open the drawer via its launcher, then make sure no command palette is
   * left open on top of it — the palette dims the whole page and would hide
   * exactly the view we are here to inspect. */
  await c.evaluate(`(() => {
    const sh = ${SH};
    const d = sh.querySelector('.drawer'); if (d) { d.hidden = false; d.classList.add('open'); }
    /* Open through the launcher whenever the shell is closed. Unhiding the
     * inner .drawer is not enough: the .shell root carries the hidden attribute
     * and now genuinely collapses to display:none. */
    const shell = sh.querySelector('.shell');
    if (shell && shell.hidden) { const l = sh.querySelector('.launcher'); if (l) l.click(); }
    const p = sh.querySelector('.palette-wrap'); if (p) p.hidden = true;
  })()`);
  await wait(1500);

  await c.evaluate(`(() => { const sh = ${SH}; const b = sh.querySelector('.vtab[data-view="run"]'); if (b) b.click(); })()`);
  await wait(800);
  const started = await c.evaluate(`(() => {
    const sh = ${SH};
    const q = sh.querySelector('.queue');
    q.value = ${JSON.stringify(CODES.join('\n'))};
    q.dispatchEvent(new Event('input', { bubbles: true }));
    const p = sh.querySelector('.pace'); if (p) { p.value = '400'; p.dispatchEvent(new Event('input', { bubbles: true })); }
    const r = sh.querySelector('.retries'); if (r) { r.value = '1'; r.dispatchEvent(new Event('input', { bubbles: true })); }
    const b = sh.querySelector('[data-act="start"]'); if (!b || b.disabled) return false; b.click(); return true;
  })()`);
  console.log('run started:', started, '·', CODES.length, 'codes');

  let last = '';
  for (let i = 0; i < 80; i++) {
    await wait(1200);
    const st = await c.evaluate(`(() => { const sh = ${SH}; const b = sh.querySelector('[data-act="start"]'); const x = sh.querySelector('.prog-txt'); const t = sh.querySelector('.tally'); return { idle: !!(b && !b.disabled), txt: x ? x.textContent.trim() : '', tally: t ? [...t.children].map((x) => x.textContent.replace(/\s+/g, ' ').trim()).join(', ') : '' }; })()`);
    if (st.txt && st.txt !== last) { console.log('  ' + st.txt + (st.tally ? '   [' + st.tally + ']' : '')); last = st.txt; }
    if (st.idle && i > 2) break;
  }

  await c.evaluate(`(() => { const sh = ${SH}; const b = sh.querySelector('.vtab[data-view="history"]'); if (b) b.click(); })()`);
  await wait(1800);
  const hist = await c.evaluate(`(() => {
    const sh = ${SH}; const h = sh.querySelector('.view-host');
    return [...h.querySelectorAll('.tline li')].map((l) => {
      const code = (l.querySelector('code, .mono') || {}).textContent || '';
      const pill = (l.querySelector('.pill') || {}).textContent || '';
      return (code.trim() + ' → ' + pill.trim());
    });
  })()`);
  console.log('\nhistory (' + hist.length + ' entries):');
  hist.forEach((h) => console.log('  ' + h));

  const objBug = hist.filter((h) => /OBJECT/i.test(h));
  console.log('\n[object Object] rows: ' + objBug.length);

  await c.evaluate(`(() => { const sh = ${SH}; const p = sh.querySelector('.palette-wrap'); if (p) p.hidden = true; for (const s of ['#onetrust-consent-sdk','#onetrust-banner-sdk']) { const e = document.querySelector(s); if (e) e.style.display = 'none'; } })()`);
  await wait(500);
  const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
  const out = process.argv[5];
  if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'mock-history.png'), Buffer.from(data, 'base64')); console.log('→ mock-history.png'); }
  const errs = logs.filter((l) => /error|exception/i.test(l));
  if (errs.length) console.log('\nerrors:\n  ' + errs.slice(0, 5).join('\n  '));
  process.exit(objBug.length ? 1 : 0);
})().catch((e) => { console.error('driver error:', e.message); process.exit(2); });
