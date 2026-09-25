/* verify-ui.js — drive the loaded extension in real Chrome and check every view.
 *
 * Walks all six views on the full-page app, then the popup and options pages,
 * asserting the rendered DOM carries real data (KPIs, rows, preset cards, code
 * lists) with a clean console. Screenshots every view for the record.
 *
 *   node tools/verify-ui.js <extension-id> [outDir]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { attach } = require('./cdp');

const EXT_ID = process.argv[2];
const OUT = process.argv[3] || path.join(process.env.TMPDIR || '.', 'df-ui-shots');
if (!EXT_ID) { console.error('usage: node tools/verify-ui.js <extension-id> [outDir]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const VIEWS = ['dashboard', 'library', 'run', 'presets', 'share', 'history'];
const results = [];
const fail = (name, msg) => { results.push({ ok: false, name, msg }); console.log('FAIL ' + name + ' — ' + msg); };
const pass = (name, note) => { results.push({ ok: true, name }); console.log('ok   ' + name + (note ? ' — ' + note : '')); };

async function newTab(url) {
  const res = await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await res.json();
  await new Promise((r) => setTimeout(r, 400));
  return t;
}

async function shot(cx, name) {
  const r = await cx.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return path.basename(file);
}

/* Drain console errors and uncaught exceptions recorded since the last call.
 * A view that renders nodes but logs an exception is not a pass. */
function errorSink(cx) {
  cx.send('Runtime.enable');
  return function drain() {
    const out = [];
    for (const m of cx.events.splice(0)) {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        out.push((d.exception && d.exception.description || d.text || '').split('\n')[0]);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        out.push(m.params.args.map((a) => a.value || a.description || '').join(' ').split('\n')[0]);
      }
    }
    return out;
  };
}

(async () => {
  /* ── full-page app: every view, with data expectations per view ────────── */
  const appTab = await newTab(`chrome-extension://${EXT_ID}/app.html`);
  const app = await attach(appTab.webSocketDebuggerUrl);
  const appErrors = errorSink(app);
  await app.navigate(`chrome-extension://${EXT_ID}/app.html`);
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await app.evaluate('document.querySelectorAll(".side-nav button").length === 6 && (document.getElementById("page-view") || {}).textContent.trim().length > 40');
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) { fail('app.html mounts with 6 nav entries and content', 'never rendered within 15s'); }
  else pass('app.html mounts with 6 nav entries and content');

  for (const view of VIEWS) {
    appErrors();
    /* Click the real nav button — exercises the app's own routing, not an
     * internal call the user can't make. */
    const clicked = await app.evaluate(`(() => {
      const b = document.querySelector('.side-nav [data-view="${view}"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!clicked) { fail(`app view "${view}"`, 'no nav button'); continue; }
    await new Promise((r) => setTimeout(r, 700));

    const probe = await app.evaluate(`(() => {
      const host = document.getElementById('page-view');
      const txt = (host.textContent || '').trim();
      const ta = (sel) => { const el = host.querySelector(sel); return el && el.value ? el.value.split('\\n').filter(Boolean).length : 0; };
      return {
        active: (document.querySelector('.side-nav .on') || {}).dataset ? document.querySelector('.side-nav .on').dataset.view : null,
        title: (document.querySelector('.page-title') || {}).textContent || '',
        chars: txt.length,
        kpis: host.querySelectorAll('.kpi').length,
        rows: host.querySelectorAll('tbody tr').length,
        cards: host.querySelectorAll('.pcard').length,
        tline: host.querySelectorAll('ol.tline li').length,
        empty: host.querySelectorAll('.empty').length,
        buttons: host.querySelectorAll('button').length,
        shareGift: ta('.share-gift'),
        sharePreset: ta('.share-preset'),
        overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      };
    })()`);

    const errs = appErrors();
    const file = await shot(app, 'app-' + view);
    const name = `app view "${view}"`;

    if (probe.active !== view) { fail(name, 'nav shows ' + probe.active); continue; }
    if (errs.length) { fail(name, 'console: ' + errs.join(' | ')); continue; }
    if (probe.chars < 40) { fail(name, 'rendered only ' + probe.chars + ' chars'); continue; }
    if (probe.overflow) { fail(name, 'horizontal overflow at 1440px'); continue; }

    let detail = probe.chars + ' chars, ' + probe.buttons + ' controls';
    if (view === 'dashboard') {
      if (probe.kpis < 4) { fail(name, 'expected >=4 KPI tiles, got ' + probe.kpis); continue; }
      detail = probe.kpis + ' KPI tiles';
    }
    if (view === 'library') {
      if (probe.rows < 10) { fail(name, 'expected a populated table, got ' + probe.rows + ' rows'); continue; }
      detail = probe.rows + ' rows';
    }
    if (view === 'presets') {
      if (probe.cards !== 20) { fail(name, 'expected 20 preset cards, got ' + probe.cards); continue; }
      detail = probe.cards + ' preset cards';
    }
    if (view === 'share') {
      if (probe.shareGift < 150) { fail(name, 'share list holds ' + probe.shareGift + ' codes'); continue; }
      if (probe.sharePreset !== 20) { fail(name, 'preset list holds ' + probe.sharePreset + ' lines'); continue; }
      detail = probe.shareGift + ' shareable codes + ' + probe.sharePreset + ' presets';
    }
    if (view === 'history') {
      if (!probe.tline && !probe.empty) { fail(name, 'neither a timeline nor an empty state'); continue; }
      detail = probe.tline ? probe.tline + ' timeline entries' : 'empty state';
    }
    if (view === 'run') {
      if (probe.buttons < 2) { fail(name, 'run view has no controls'); continue; }
      detail = probe.buttons + ' run controls';
    }
    pass(name, detail + ' → ' + file);
  }

  /* ── contrast: no control may render with the browser's default chrome ───
   * An unstyled button on this dark theme comes out near-white with near-white
   * text — invisible, and easy to miss in a screenshot review. Chrome's default
   * button background is rgb(239,239,239)-ish, so flag anything that light. */
  const lum = (rgb) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
    return m ? (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) : null;
  };
  const palest = [];
  for (const view of VIEWS) {
    await app.evaluate(`document.querySelector('.side-nav [data-view="${view}"]').click()`);
    await new Promise((r) => setTimeout(r, 500));
    const found = await app.evaluate(`[...document.querySelectorAll('button, input[type=button], input[type=submit]')]
      .map((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, fg: cs.color, cls: el.className, txt: (el.textContent || '').trim().slice(0, 24) };
      })`);
    for (const el of found) {
      const bgL = lum(el.bg);
      const fgL = lum(el.fg);
      /* Pale background AND pale text = unreadable. A light button with dark
       * text (our .primary) is intentional and must not trip this. */
      if (bgL !== null && bgL > 200 && fgL !== null && fgL > 160) {
        palest.push(`${view}: "${el.txt}" [${el.cls}] bg ${el.bg} / fg ${el.fg}`);
      }
    }
  }
  if (palest.length) fail('every control has readable contrast', palest.slice(0, 5).join(' · '));
  else pass('every control has readable contrast', 'no unstyled/white-on-white buttons in 6 views');

  /* ── responsive: narrow viewport must not overflow ─────────────────────── */
  await app.evaluate('document.querySelector(\'.side-nav [data-view="library"]\').click()');
  await app.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 860, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 800));
  const narrow = await app.evaluate('({ x: document.documentElement.scrollWidth, w: window.innerWidth })');
  const nfile = await shot(app, 'app-narrow-library');
  if (narrow.x <= narrow.w + 2) pass('app avoids horizontal overflow at 430px', nfile);
  else fail('app avoids horizontal overflow at 430px', narrow.x + 'px content in a ' + narrow.w + 'px viewport');
  await app.send('Emulation.clearDeviceMetricsOverride');

  /* ── toolbar popup ─────────────────────────────────────────────────────── */
  const popTab = await newTab(`chrome-extension://${EXT_ID}/popup.html`);
  const pop = await attach(popTab.webSocketDebuggerUrl);
  const popErrors = errorSink(pop);
  await pop.navigate(`chrome-extension://${EXT_ID}/popup.html`);
  await pop.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 520, deviceScaleFactor: 2, mobile: false });
  for (let i = 0; i < 60; i++) {
    if (await pop.evaluate('document.querySelectorAll("#k .kpi").length > 0')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const popProbe = await pop.evaluate(`({
    kpis: document.querySelectorAll('#k .kpi').length,
    numbers: [...document.querySelectorAll('#k .kpi b')].map((b) => b.textContent),
    buttons: [...document.querySelectorAll('button')].map((b) => b.id).filter(Boolean),
    foot: (document.getElementById('foot') || {}).textContent || '',
  })`);
  const popErrs = popErrors();
  const pfile = await shot(pop, 'popup');
  const wanted = ['open-app', 'open-drawer', 'open-redeem', 'copy-share', 'open-options'];
  const missing = wanted.filter((id) => !popProbe.buttons.includes(id));
  if (popErrs.length) fail('popup renders with live numbers', 'console: ' + popErrs.join(' | '));
  else if (popProbe.kpis < 2) fail('popup renders with live numbers', 'only ' + popProbe.kpis + ' KPIs');
  else if (popProbe.numbers.every((n) => n === '0' || n === '—')) fail('popup renders with live numbers', 'all KPIs empty: ' + popProbe.numbers.join(','));
  else if (missing.length) fail('popup renders with live numbers', 'missing actions: ' + missing.join(','));
  else pass('popup renders with live numbers', popProbe.numbers.join('/') + ', ' + popProbe.buttons.length + ' actions → ' + pfile);

  /* ── options page ──────────────────────────────────────────────────────── */
  const optTab = await newTab(`chrome-extension://${EXT_ID}/options.html`);
  const opt = await attach(optTab.webSocketDebuggerUrl);
  const optErrors = errorSink(opt);
  await opt.navigate(`chrome-extension://${EXT_ID}/options.html`);
  await new Promise((r) => setTimeout(r, 1000));
  const optProbe = await opt.evaluate(`({
    controls: document.querySelectorAll('input,select,button').length,
    themed: getComputedStyle(document.body).getPropertyValue('--void').trim(),
    dfScoped: document.body.classList.contains('df'),
    bg: getComputedStyle(document.body).backgroundColor,
    chars: document.body.textContent.trim().length,
  })`);
  const optErrs = optErrors();
  const ofile = await shot(opt, 'options');
  if (optErrs.length) fail('options page renders cleanly', 'console: ' + optErrs.join(' | '));
  else if (optProbe.controls < 3) fail('options page renders cleanly', 'only ' + optProbe.controls + ' controls');
  else if (!optProbe.dfScoped || !optProbe.themed) fail('options page renders cleanly', 'theme.css tokens not applied (df=' + optProbe.dfScoped + ', --void="' + optProbe.themed + '")');
  else pass('options page renders cleanly', optProbe.controls + ' controls, themed ' + optProbe.themed + ' → ' + ofile);

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} UI checks passed`);
  console.log('screenshots: ' + OUT);
  app.close(); pop.close(); opt.close();
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('driver error: ' + e.message); process.exit(3); });
