#!/usr/bin/env node
/* test/variant-report.test.js — report the spelling that actually redeemed.
 *
 * When Garena rejects a queued code as non-existent, the engine probes OCR
 * variants and records the one that worked as `redeemedAs`; the vault keeps it
 * as `variant_used` on the row of the code that was queued. Community reporting
 * then has to publish the variant. Publishing the queued spelling instead is how
 * DFOSS260404857 — rejected by Garena, redeemed as DFOSS260404B57 — reached the
 * public list as a success: anyone who queued it from there got 400054.
 */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DFRedeemSync = require(path.join(ROOT, 'src', 'core', 'sync.js'));
const { Vault, MemoryAdapter } = require(path.join(ROOT, 'src', 'core', 'vault.js'));
const Garena = require(path.join(ROOT, 'src', 'core', 'garena.js'));

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
  if (condition) { passed += 1; console.log(`ok   ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

/* Same chrome.storage.local double as community.test.js: promise-based, which
 * is the shape sync.js calls. */
function fakeChrome(settings) {
  const store = { dfRedeemSettings: { ...DFRedeemSync.DEFAULT_SETTINGS, ...(settings || {}) } };
  return {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const [key, fallback] of Object.entries(keys)) out[key] = store[key] !== undefined ? store[key] : fallback;
          return out;
        },
        async set(value) { Object.assign(store, value); },
      },
    },
    runtime: {},
  };
}

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

function reporter() {
  const posted = [];
  const service = DFRedeemSync.createSyncService({
    chromeApi: fakeChrome({ communityReportUrl: 'https://broker.test/submit' }),
    fetchFn: async (url, init) => {
      const rows = JSON.parse(init.body).rows || [];
      posted.push(...rows);
      return jsonResponse({ ok: true, accepted: rows.length, queued: rows.length, rejected: 0, needed: 2, results: [] });
    },
  });
  return { service, posted };
}

(async () => {
  /* ---- engine result → vault → report, the way the panel wires it ------- */
  {
    const vault = new Vault({ adapter: new MemoryAdapter() });
    await vault.init();
    /* The shape RedeemRun emits after the queued spelling was rejected and the
     * OCR variant probe succeeded (src/core/engine.js, `result`). */
    const r = {
      position: 1,
      total: 1,
      code: 'DFOSS260404857',
      redeemedAs: 'DFOSS260404B57',
      status: 'SUCCESS',
      label: 'Thành công',
      detail: 'ok',
      errorCode: 0,
      variantsTried: [{ code: 'DFOSS260404B57', status: 'SUCCESS', detail: 'ok' }],
    };
    /* Verbatim from the panel's `result` handler (src/ui/panel.js). */
    const mapped = Garena.vaultStatus(r.status);
    await vault.recordAttempt(r.code, Object.assign({}, r, {
      status: mapped || undefined,
      result_msg: r.detail || r.label || '',
      err_code: r.errorCode,
    }), 'run-1');

    const stored = (await vault.all()).find((row) => row.code === 'DFOSS260404857');
    check('the vault records which spelling redeemed',
      stored && stored.status === 'success' && stored.variant_used === 'DFOSS260404B57', JSON.stringify(stored));

    const { service, posted } = reporter();
    const result = await service.reportOutcomes(await vault.all());
    check('a variant redemption is reported under the accepted spelling',
      posted.some((p) => p.code === 'DFOSS260404B57' && p.err_code === 0), JSON.stringify(posted));
    check('the rejected queued spelling is never reported as redeemable',
      !posted.some((p) => p.code.toUpperCase() === 'DFOSS260404857'), JSON.stringify(posted));
    check('one verdict leaves for one redemption', result.sent === 1 && posted.length === 1, JSON.stringify({ result, posted }));
    check('a variant report still carries only code and err_code',
      posted.every((p) => Object.keys(p).sort().join(',') === 'code,err_code'), JSON.stringify(posted));
  }

  /* ---- reportOutcomes on stored rows ----------------------------------- */
  {
    const { service, posted } = reporter();
    await service.reportOutcomes([
      /* The engine's own example: a variant that differs by one look-alike glyph. */
      { code: 'DFUItra220', variant_used: 'DFUltra220', status: 'success', err_code: 0 },
      /* A dead verdict found through a variant belongs to the variant too. */
      { code: 'Typo0Code9', variant_used: 'TypoOCode9', status: 'expired', err_code: 400068 },
      /* Without a variant the engine stores the queued code as redeemedAs. */
      { code: 'PlainCase1', variant_used: 'PlainCase1', status: 'success', err_code: 0 },
      { code: 'NoVariant1', status: 'success', err_code: 0 },
    ]);
    const codes = posted.map((p) => p.code);
    check('a look-alike variant is reported in its exact accepted spelling',
      codes.includes('DFUltra220') && !codes.includes('DFUItra220'), JSON.stringify(codes));
    check('a dead verdict found through a variant names the variant',
      posted.some((p) => p.code === 'TypoOCode9' && p.err_code === 400068) && !codes.includes('Typo0Code9'), JSON.stringify(posted));
    check('a row redeemed as itself reports its own spelling', codes.includes('PlainCase1'), JSON.stringify(codes));
    check('a row with no variant field reports its own spelling', codes.includes('NoVariant1'), JSON.stringify(codes));
  }

  {
    /* The vault can hold both the queued row (redeemed through the variant) and
     * a row for the variant itself, e.g. from the seed or a community pull. They
     * describe one redemption and must not be counted twice by the broker. */
    const { service, posted } = reporter();
    await service.reportOutcomes([
      { code: 'DFOSS260404857', variant_used: 'DFOSS260404B57', status: 'success', err_code: 0 },
      { code: 'DFOSS260404B57', status: 'success', err_code: 0 },
    ]);
    const hits = posted.filter((p) => p.code.toUpperCase() === 'DFOSS260404B57');
    check('the accepted spelling is reported once', hits.length === 1, JSON.stringify(posted));
    check('the queued misread does not ride along', !posted.some((p) => p.code.toUpperCase() === 'DFOSS260404857'), JSON.stringify(posted));
  }

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.log(`FAIL variant-report crashed — ${error && error.stack || error}`);
  console.log(`\n${passed} passed, ${failed + 1} failed, ${passed + failed + 1} total`);
  process.exit(1);
});
