'use strict';
const { attach } = require('./cdp');
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.find((x) => x.url.includes('cdkgarena'));
  const c = await attach(t.webSocketDebuggerUrl);
  const res = await c.evaluate(`(async () => {
    const db = await new Promise((ok, err) => { const r = indexedDB.open('df-redeem-vault'); r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error); });
    const get = (s) => new Promise((ok) => { const rq = db.transaction(s, 'readonly').objectStore(s).getAll(); rq.onsuccess = () => ok(rq.result || []); rq.onerror = () => ok([]); });
    const results = await get('results');
    return { n: results.length, rows: results.slice(-4).map((r) => ({ code: r.code, type: typeof r.code, status: r.status, code_key: r.code_key, keys: Object.keys(r) })) };
  })()`);
  console.log(JSON.stringify(res, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
