/* load-ext.js — install the unpacked extension through CDP.
 *
 * Chrome 137+ ignores the --load-extension command line switch, so the modern
 * path is the Extensions domain on the browser target, which needs the browser
 * to be started with --enable-unsafe-extension-debugging.
 *
 *   node tools/load-ext.js <absolute-extension-dir>
 */
'use strict';
const { attach } = require('./cdp');

const DIR = process.argv[2];
if (!DIR) { console.error('usage: node tools/load-ext.js <dir>'); process.exit(2); }

(async () => {
  const v = await (await fetch('http://127.0.0.1:9333/json/version')).json();
  const cx = await attach(v.webSocketDebuggerUrl);
  const r = await cx.send('Extensions.loadUnpacked', { path: DIR });
  console.log(JSON.stringify(r));
  cx.close();
  process.exit(0);
})().catch((e) => { console.error('load failed: ' + e.message); process.exit(1); });
