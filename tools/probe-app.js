/* probe-app.js — dump what app.html actually produced: globals, DOM, errors. */
'use strict';
const { attach } = require('./cdp');
const EXT = process.argv[2];

(async () => {
  const res = await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent('chrome-extension://' + EXT + '/app.html')}`, { method: 'PUT' });
  const tab = await res.json();
  const cx = await attach(tab.webSocketDebuggerUrl);
  await cx.send('Runtime.enable');
  await cx.send('Log.enable');
  await cx.navigate(`chrome-extension://${EXT}/app.html`);
  await new Promise((r) => setTimeout(r, 2500));

  console.log('--- collected events ---');
  for (const m of cx.events) {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.log('EXCEPTION:', (d.exception && d.exception.description || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      console.log('console.' + m.params.type + ':', m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Log.entryAdded') console.log('log.' + m.params.entry.level + ':', m.params.entry.text);
  }

  console.log('--- page state ---');
  console.log(await cx.evaluate(`JSON.stringify({
    globals: Object.keys(window).filter((k) => /^DF_/.test(k)),
    bodyHtml: document.body.innerHTML.slice(0, 600),
    scripts: [...document.scripts].map((s) => s.src || '(inline ' + s.textContent.length + ')'),
  }, null, 2)`));
  cx.close();
  process.exit(0);
})().catch((e) => { console.error('probe error: ' + e.message); process.exit(3); });
