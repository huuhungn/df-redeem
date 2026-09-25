/* probe-app2.js — is the full-page app actually rendering view content? */
'use strict';
const { attach } = require('./cdp');
const EXT = process.argv[2];

(async () => {
  const res = await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent('chrome-extension://' + EXT + '/app.html')}`, { method: 'PUT' });
  const tab = await res.json();
  const cx = await attach(tab.webSocketDebuggerUrl);
  await cx.send('Runtime.enable');
  await cx.navigate(`chrome-extension://${EXT}/app.html`);
  await new Promise((r) => setTimeout(r, 3000));

  for (const m of cx.events) {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.log('EXCEPTION:', (d.exception && d.exception.description || d.text).split('\n').slice(0, 4).join('\n'));
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      console.log('console.' + m.params.type + ':', m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
    }
  }

  console.log(await cx.evaluate(`JSON.stringify({
    navButtons: document.querySelectorAll('.side-nav button').length,
    activeView: (document.querySelector('.side-nav .on') || {}).dataset ? document.querySelector('.side-nav .on').dataset.view : null,
    pageViewChars: (document.getElementById('page-view') || {}).textContent ? document.getElementById('page-view').textContent.trim().length : -1,
    pageViewHtml: (document.getElementById('page-view') || {}).innerHTML ? document.getElementById('page-view').innerHTML.slice(0, 300) : '(missing)',
    title: (document.querySelector('.page-title') || {}).textContent,
    kpis: document.querySelectorAll('#page-view .kpi').length,
    hiddenDrawerPresent: !!document.querySelector('div[style*="display: none"]'),
  }, null, 2)`));
  cx.close();
  process.exit(0);
})().catch((e) => { console.error('probe error: ' + e.message); process.exit(3); });
