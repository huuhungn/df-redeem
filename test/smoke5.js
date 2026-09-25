/* smoke5.js — live 5-code trial.
 * Starts the run asynchronously and parks state on window.__dfSmoke so the
 * caller can poll it; bsk evaluate must not be held open for minutes.
 */
(() => {
  if (window.__dfSmoke && window.__dfSmoke.state === 'running') {
    return JSON.stringify({ already: true, state: window.__dfSmoke.state });
  }
  const E = window.DFRedeemEngine;
  if (!E) return JSON.stringify({ error: 'engine not installed' });

  const codes = window.__dfSmokeCodes;
  if (!Array.isArray(codes) || !codes.length) return JSON.stringify({ error: 'no codes staged' });

  const run = new E.RedeemRun(codes.map((c) => ({ code: c })), {
    delayMs: 2500,          // conservative: 317 codes later must not trip the throttle
    timeoutMs: 6000,        // Garena is slow under load; 2s produced phantom NO_RESPONSE
    maxVariants: 3,
    variantsOnInvalid: true,
    journalKey: 'df-redeem-smoke5',
  });

  const box = {
    state: 'running',
    log: [],
    rows: [],
    progress: null,
    summary: null,
    startedAt: new Date().toISOString(),
  };
  window.__dfSmoke = box;

  run.on('log', (e) => box.log.push(`${new Date(e.time).toLocaleTimeString('vi-VN')} [${e.tone}] ${e.message}`));
  run.on('progress', (p) => { box.progress = p; });
  run.on('result', (r) => {
    box.rows.push({
      pos: r.position,
      code: r.code,
      redeemedAs: r.redeemedAs,
      status: r.status,
      label: r.label,
      errorCode: r.errorCode,
      trusted: r.trusted,
      variantUsed: r.variantUsed,
      variantsTried: (r.variantsTried || []).map((v) => `${v.code}=${v.status}`),
      detail: r.detail,
      pageText: (r.pageText || '').slice(0, 120),
    });
  });
  run.on('done', (s) => {
    box.state = 'done';
    box.summary = s;
    box.csv = run.toCSV();
    box.endedAt = new Date().toISOString();
  });

  box.runRef = run;
  run.run().catch((err) => {
    box.state = 'error';
    box.error = String(err && err.message || err);
  });

  return JSON.stringify({ started: true, count: codes.length, codes });
})()
