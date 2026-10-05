/* bridge.js — ISOLATED-world relay between the MAIN-world panel and the
 * service worker. Only sync messages cross; no page data is volunteered. */
(function dfRedeemBridge() {
  'use strict';
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== 'df-redeem-sync' || !msg.id) return;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: msg.op, payload: msg.payload });
      window.postMessage({ channel: 'df-redeem-sync-reply', id: msg.id, ok: true, reply }, window.location.origin);
    } catch (error) {
      window.postMessage({ channel: 'df-redeem-sync-reply', id: msg.id, ok: false, error: String(error && error.message || error) }, window.location.origin);
    }
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'DF_REDEEM_OPEN') window.postMessage({ channel: 'df-redeem-open' }, window.location.origin);
  });
  /* Invalidate only: settings may contain credentials, so never forward storage
   * values into the page. The panel re-reads the worker's public status API. */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.dfRedeemSyncStatus || changes.dfRedeemSettings)) {
      window.postMessage({ channel: 'df-redeem-sync-changed' }, window.location.origin);
    }
  });
}());
