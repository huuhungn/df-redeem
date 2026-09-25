/* purge-bad-history.js — drop history rows whose code was stored as an object
 * by the pre-fix panel, so the timeline shows only trustworthy records. */
'use strict';
const { attach } = require('./cdp');
const SH = "(() => { const h = document.getElementById('df-redeem-root') || [...document.querySelectorAll('*')].find((e) => e.shadowRoot && e.shadowRoot.querySelector('.drawer')); return h && h.shadowRoot; })()";
(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const t = list.find((x) => x.url.includes('cdkgarena'));
  const c = await attach(t.webSocketDebuggerUrl);
  const res = await c.evaluate(`(async () => {
    const db = await new Promise((ok, err) => {
      const r = indexedDB.open('df-redeem-vault');
      r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error);
    });
    const stores = [...db.objectStoreNames];
    const out = { stores, removed: [] };
    for (const s of stores) {
      const rows = await new Promise((ok) => { const rq = db.transaction(s, 'readonly').objectStore(s).getAll(); rq.onsuccess = () => ok(rq.result || []); rq.onerror = () => ok([]); });
      const bad = rows.filter((r) => r && (typeof r.code === 'object' || String(r.code).toUpperCase() === '[OBJECTOBJECT]' || String(r.code) === '[object Object]' ||
                                          typeof r.code_key === 'object' || String(r.code_key).toUpperCase().includes('[OBJECT')));
      if (!bad.length) continue;
      const tx = db.transaction(s, 'readwrite');
      const os = tx.objectStore(s);
      for (const b of bad) {
        const key = os.keyPath && b[os.keyPath] !== undefined ? b[os.keyPath] : (b.id !== undefined ? b.id : null);
        if (key !== null && key !== undefined) os.delete(key);
      }
      await new Promise((ok) => { tx.oncomplete = ok; tx.onerror = ok; tx.onabort = ok; });
      out.removed.push({ store: s, n: bad.length });
    }
    return out;
  })()`);
  console.log(JSON.stringify(res, null, 1));
  /* Re-render so the view reflects the cleaned store. */
  await c.evaluate(`(() => { const p = window.__dfRedeemPanel; if (p && p.refresh) p.refresh(); })()`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
