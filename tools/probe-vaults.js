/* probe-vaults.js — compare the vault each surface actually reads.
 * The drawer lives on the Garena origin, app/popup on chrome-extension://.
 * IndexedDB is per-origin, so this tells us whether a run in the drawer is
 * visible to the full-page app at all. */
'use strict';
const { attach } = require('./cdp');
const EXT = process.argv[2];
const COUNT = `(async () => {
  const db = await new Promise((ok, err) => { const r = indexedDB.open('df-redeem-vault'); r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error); });
  const get = (s) => new Promise((ok) => { try { const rq = db.transaction(s, 'readonly').objectStore(s).getAll(); rq.onsuccess = () => ok(rq.result || []); rq.onerror = () => ok([]); } catch (_) { ok([]); } });
  const stores = [...db.objectStoreNames];
  const codes = stores.includes('codes') ? await get('codes') : [];
  const results = stores.includes('results') ? await get('results') : [];
  const runs = stores.includes('runs') ? await get('runs') : [];
  return { origin: location.origin, codes: codes.length, results: results.length, runs: runs.length,
           lastResult: results.length ? { code: results[results.length - 1].code, status: results[results.length - 1].status } : null };
})()`;
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const garena = list.find((x) => x.url.includes('cdkgarena'));
  const out = [];
  if (garena) { const c = await attach(garena.webSocketDebuggerUrl); out.push(await c.evaluate(COUNT)); }
  const tab = await (await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent('chrome-extension://' + EXT + '/app.html')}`, { method: 'PUT' })).json();
  const c2 = await attach(tab.webSocketDebuggerUrl);
  await new Promise((r) => setTimeout(r, 3000));
  out.push(await c2.evaluate(COUNT));
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
