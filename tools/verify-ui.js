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
/* The preset count follows the shipped seed, so adding a preset to the seed
 * does not turn this check red. */
const SEED_PRESETS = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'seed.json'), 'utf8')).presets || []).length;
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

  /* ── a tab picked while the page is still loading must stick ────────────
   * The page used to paint Tổng quan once startup finished, on top of
   * whatever the user had clicked in the meantime. Reload, click Preset the
   * moment the nav exists, and the page must still be on Preset afterwards. */
  {
    const name = 'app keeps a tab clicked during startup';
    /* Not app.navigate(): it waits for the load to complete, and by then the
     * startup this check is about may already be over. Click as soon as the
     * nav exists, as an impatient user does. */
    await app.send('Page.navigate', { url: `chrome-extension://${EXT_ID}/app.html` });
    let clicked = false;
    for (let i = 0; i < 400 && !clicked; i++) {
      clicked = await app.evaluate(`(() => { const b = document.querySelector('.side-nav [data-view="presets"]'); if (!b) return false; b.click(); return true; })()`).catch(() => false);
      if (!clicked) await new Promise((r) => setTimeout(r, 5));
    }
    let s = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      s = await app.evaluate(`({ on: (document.querySelector('.side-nav .on') || { dataset: {} }).dataset.view,
        cards: document.querySelectorAll('#page-view .pcard').length })`);
      if (s.cards) break;
    }
    /* Startup is still finishing; give a late repaint the chance to undo it. */
    await new Promise((r) => setTimeout(r, 1500));
    s = await app.evaluate(`({ on: (document.querySelector('.side-nav .on') || { dataset: {} }).dataset.view,
      title: document.querySelector('.page-title').textContent,
      cards: document.querySelectorAll('#page-view .pcard').length })`);
    if (!clicked) fail(name, 'nav never appeared');
    else if (s.on !== 'presets' || s.cards !== SEED_PRESETS) fail(name, `page ended on "${s.title}" with ${s.cards} cards`);
    else pass(name, s.cards + ' preset cards');
  }

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
      if (probe.cards !== SEED_PRESETS) { fail(name, 'expected ' + SEED_PRESETS + ' preset cards, got ' + probe.cards); continue; }
      detail = probe.cards + ' preset cards';
    }
    if (view === 'share') {
      if (probe.shareGift < 150) { fail(name, 'share list holds ' + probe.shareGift + ' codes'); continue; }
      if (probe.sharePreset !== SEED_PRESETS) { fail(name, 'preset list holds ' + probe.sharePreset + ' lines, seed has ' + SEED_PRESETS); continue; }
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

  /* ── form controls: the view on app.html is a clone of the drawer's render,
   * and every tick or keystroke is replayed onto the drawer original. Drive it
   * with trusted input, because the failures live in what Chrome does on its
   * own: a checkbox fires input and change, removing a focused dirty field fires
   * change, and setSelectionRange throws on checkbox and number inputs. ─── */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shadowJs = '[...document.documentElement.children].map((n) => n.shadowRoot).find(Boolean)';
  const openView = async (view, readyJs) => {
    await app.evaluate(`document.querySelector('.side-nav [data-view="${view}"]').click()`);
    for (let i = 0; i < 40 && !(await app.evaluate(readyJs)); i++) await sleep(250);
    await sleep(300);
  };
  const press = async (selector) => {
    const at = await app.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!at) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await app.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    }
    await sleep(350);
    return true;
  };
  /* One key at a time with a human gap: the focus loss only shows from the
   * second keystroke on, so pasting the whole string would hide it. */
  const typeKeys = async (text) => {
    for (const ch of text) {
      await app.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch });
      await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await sleep(120);
    }
    await sleep(300);
  };
  const key = async (name, code) => {
    await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
    await sleep(150);
  };
  const focusedClass = () => app.evaluate('(document.activeElement && document.activeElement.className) || ""');

  {
    const name = 'app ticks the Library row that was clicked';
    await openView('library', 'document.querySelectorAll("#page-view tbody tr").length > 3');
    appErrors();
    const codes = await app.evaluate('[...document.querySelectorAll("#page-view tbody tr")].map((tr) => tr.dataset.code)');
    await press('#page-view tbody tr:nth-child(3) .pick');
    const picked = await app.evaluate(`({
      page: [...document.querySelectorAll('#page-view tbody tr')].filter((tr) => tr.querySelector('.pick').checked).map((tr) => tr.dataset.code),
      drawer: [...${shadowJs}.querySelectorAll('.view-host tbody tr')].filter((tr) => tr.querySelector('.pick').checked).map((tr) => tr.dataset.code),
      focused: (document.activeElement && document.activeElement.className) || '',
    })`);
    const errs = appErrors();
    if (errs.length) fail(name, 'console: ' + errs.join(' | '));
    else if (picked.page.join() !== codes[2] || picked.drawer.join() !== codes[2]) {
      fail(name, `clicked ${codes[2]}, page ticked [${picked.page}], drawer ticked [${picked.drawer}]`);
    } else if (picked.focused !== 'pick') fail(name, 'focus left the checkbox for "' + picked.focused + '"');
    else pass(name, codes[2]);
    await press('#page-view tbody tr:nth-child(3) .pick');
  }

  {
    const name = 'app Library search keeps focus while typing';
    await press('#page-view .fq');
    appErrors();
    await typeKeys('85ew');
    const got = await app.evaluate(`({
      value: document.querySelector('#page-view .fq').value,
      rows: [...document.querySelectorAll('#page-view tbody tr')].map((tr) => tr.dataset.code),
    })`);
    const focused = await focusedClass();
    const errs = appErrors();
    if (errs.length) fail(name, 'console: ' + errs.join(' | '));
    else if (got.value !== '85ew' || focused !== 'fq') fail(name, `typed "85ew", field holds "${got.value}", focus on "${focused}"`);
    else if (!got.rows.length || got.rows.some((c) => !/85ew/i.test(c))) fail(name, 'filter shows ' + got.rows.join(', '));
    else pass(name, got.rows.length + ' matching row(s)');
    await app.evaluate('document.querySelector("#page-view .fq").select()');
    await key('Backspace', 8);
  }

  {
    const name = 'app Run fields take typing and toggles without errors';
    await openView('run', '!!document.querySelector("#page-view .pace")');
    appErrors();
    const queueBefore = await app.evaluate('document.querySelector("#page-view .queue").value');
    const problems = [];

    await press('#page-view .pace');
    await app.evaluate('document.querySelector("#page-view .pace").select()');
    await typeKeys('1500');
    const pace = await app.evaluate(`[document.querySelector('#page-view .pace').value, ${shadowJs}.querySelector('.view-host .pace').value]`);
    if (pace[0] !== '1500' || pace[1] !== '1500') problems.push(`pace page "${pace[0]}" drawer "${pace[1]}"`);
    if ((await focusedClass()) !== 'pace') problems.push('pace lost focus');

    const was = await app.evaluate(`${shadowJs}.querySelector('.view-host .variants').checked`);
    await press('#page-view .variants');
    const now = await app.evaluate(`[document.querySelector('#page-view .variants').checked, ${shadowJs}.querySelector('.view-host .variants').checked]`);
    if (now[0] === was || now[1] === was) problems.push('variants toggle did not reach the drawer');
    await press('#page-view .variants');

    /* The caret must come back where it was, not jump to the end: type, step
     * left, type again. Only on an empty queue, so a real one is never touched. */
    if (!queueBefore) {
      await press('#page-view .queue');
      await typeKeys('AB');
      await key('ArrowLeft', 37);
      await typeKeys('C');
      const queue = await app.evaluate('document.querySelector("#page-view .queue").value');
      if (queue !== 'ACB') problems.push(`queue caret: typed A,B,←,C and got "${queue}"`);
      await app.evaluate('document.querySelector("#page-view .queue").select()');
      await key('Backspace', 8);
    }

    const errs = appErrors();
    if (errs.length) problems.push('console: ' + errs.join(' | '));
    if (problems.length) fail(name, problems.join(' · '));
    else pass(name, queueBefore ? 'pace + variants (queue not empty, caret check skipped)' : 'pace + variants + queue caret');
    await press('#page-view .pace');
    await app.evaluate('document.querySelector("#page-view .pace").select()');
    await typeKeys('1200');
  }

  {
    const name = 'app Preset search keeps focus while typing';
    await openView('presets', '!!document.querySelector("#page-view .pq")');
    await press('#page-view .pq');
    appErrors();
    await typeKeys('mk4');
    const got = await app.evaluate('[document.querySelector("#page-view .pq").value, document.querySelectorAll("#page-view .pcard").length]');
    const focused = await focusedClass();
    const errs = appErrors();
    if (errs.length) fail(name, 'console: ' + errs.join(' | '));
    else if (got[0] !== 'mk4' || focused !== 'pq') fail(name, `typed "mk4", field holds "${got[0]}", focus on "${focused}"`);
    else if (!got[1] || got[1] >= SEED_PRESETS) fail(name, `filter left ${got[1]} of ${SEED_PRESETS} cards`);
    else pass(name, got[1] + ' card(s)');
    await app.evaluate('document.querySelector("#page-view .pq").select()');
    await key('Backspace', 8);
  }

  /* ── app.html follows navigation that starts inside a view ──────────────
   * The page shows a copy of the drawer's view and used to guess when it
   * changed: the History button on a Library row and Alt+1–6 painted the new
   * view in the hidden drawer only, and the page kept the old one on screen. */
  const pageState = () => app.evaluate(`({
    title: document.querySelector('.page-title').textContent,
    on: (document.querySelector('.side-nav .on') || { dataset: {} }).dataset.view,
    text: document.getElementById('page-view').textContent,
    scrollY: Math.round(window.scrollY),
  })`);
  {
    const name = 'app follows a Library row into its History';
    await openView('library', 'document.querySelectorAll("#page-view tbody tr").length > 3');
    appErrors();
    const code = await app.evaluate('document.querySelectorAll("#page-view tbody tr")[1].dataset.code');
    await press('#page-view tbody tr:nth-child(2) [data-act="row-hist"]');
    let s = await pageState();
    for (let i = 0; i < 20 && s.on !== 'history'; i++) { await sleep(150); s = await pageState(); }
    const errs = appErrors();
    if (errs.length) fail(name, 'console: ' + errs.join(' | '));
    else if (s.on !== 'history' || s.title !== 'Lịch sử') fail(name, `page stayed on "${s.title}" (${s.on})`);
    else if (!s.text.includes(code)) fail(name, 'History does not show the clicked code ' + code);
    else pass(name, code);
  }
  {
    const name = 'app follows Alt+1–6 and starts the new view at its top';
    await openView('library', 'document.querySelectorAll("#page-view tbody tr").length > 3');
    await app.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
    await sleep(200);
    await app.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
    for (const type of ['rawKeyDown', 'keyUp']) {
      await app.send('Input.dispatchKeyEvent', { type, key: '4', code: 'Digit4', modifiers: 1, windowsVirtualKeyCode: 52 });
    }
    let s = await pageState();
    for (let i = 0; i < 20 && s.on !== 'presets'; i++) { await sleep(150); s = await pageState(); }
    const cards = await app.evaluate('document.querySelectorAll("#page-view .pcard").length');
    if (s.on !== 'presets' || cards !== SEED_PRESETS) fail(name, `Alt+4 left the page on "${s.title}" with ${cards} cards`);
    else if (s.scrollY !== 0) fail(name, 'the new view opened scrolled to ' + s.scrollY + 'px');
    else pass(name, cards + ' preset cards');
  }
  {
    const name = 'app cost editor takes typing straight away';
    await openView('presets', 'document.querySelectorAll("#page-view .pcard").length > 0');
    appErrors();
    await press('#page-view [data-act="cost-edit"]');
    await sleep(300);
    const focused = await focusedClass();
    await typeKeys('29');
    const value = await app.evaluate('(document.querySelector("#page-view .pc-costedit .costin") || {}).value');
    const errs = appErrors();
    if (errs.length) fail(name, 'console: ' + errs.join(' | '));
    else if (!/costin/.test(focused) || value !== '29') fail(name, `focus on "${focused}", field holds "${value}"`);
    else pass(name, 'focus in the cost field');
    await press('#page-view [data-act="cost-cancel"]');
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
