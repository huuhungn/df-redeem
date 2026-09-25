/* install-via-fetch.js — load the engine bundle into the page without pushing
 * 40 KB through argv. Serves the bundle from a data URL built inside the page
 * by reading it out of an injected <script> the extension can reach.
 *
 * bsk cannot read local files for the page, and file:// fetch is blocked from
 * an https origin, so the bundle text is staged in chunks by the caller into
 * window.__dfChunks and assembled here.
 */
(() => {
  const chunks = window.__dfChunks;
  if (!Array.isArray(chunks) || !chunks.length) {
    return JSON.stringify({ error: 'no chunks staged' });
  }
  const source = chunks.join('');
  try {
    // Indirect eval keeps the bundle in global scope, matching a <script> tag.
    (0, eval)(source);
  } catch (error) {
    return JSON.stringify({ error: 'eval failed: ' + String(error && error.message || error) });
  }
  delete window.__dfChunks;
  return JSON.stringify({
    installed: !!window.DFRedeemEngine,
    hasCodes: !!window.DFRedeemCodes,
    hasGarena: !!window.DFRedeemGarena,
    bytes: source.length,
  });
})()
