#!/usr/bin/env node
/* test/community.test.js — the client half of the community vault.
 *
 * Covers what must never happen as carefully as what must: an account-specific
 * verdict must not leave the machine, and a remote row must not overwrite a
 * first-hand local observation.
 */
'use strict';
const path = require('path');
const DFRedeemSync = require(path.join(__dirname, '..', 'src', 'core', 'sync.js'));

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
  if (condition) { passed += 1; console.log(`ok   ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

/* Minimal chrome.storage.local double. MV3 storage is promise-based, which is the
 * shape sync.js calls, so the double returns promises rather than taking callbacks. */
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
    _store: store,
  };
}

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

(async function main() {
  /* ---- fetchCommunity -------------------------------------------------- */
  {
    const calls = [];
    const service = DFRedeemSync.createSyncService({
      chromeApi: fakeChrome({ communityDataUrl: 'https://example.test/codes.json', communityPresetsUrl: 'https://example.test/presets.json' }),
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        if (url.includes('codes')) return jsonResponse({ codes: [{ code: 'AAA111BBB', status: 'success' }] });
        return jsonResponse({ presets: [{ code: '6KABCDEFGHIJ', weapon: 'AUG' }] });
      },
    });
    const result = await service.fetchCommunity();
    check('fetchCommunity reads both files', result.ok && result.codes.length === 1 && result.presets.length === 1, JSON.stringify(result));
    check('fetchCommunity sends no cookies', calls.every((c) => c.init && c.init.credentials === 'omit'), JSON.stringify(calls.map((c) => c.init)));
    check('fetchCommunity sends no Authorization header',
      calls.every((c) => !c.init || !c.init.headers || !Object.keys(c.init.headers).some((h) => /authorization/i.test(h))));
  }

  {
    const service = DFRedeemSync.createSyncService({
      chromeApi: fakeChrome({ communityEnabled: false }),
      fetchFn: async () => { throw new Error('must not be called'); },
    });
    const result = await service.fetchCommunity();
    check('a disabled community does not fetch', result.ok === false && result.skipped === 'disabled', JSON.stringify(result));
  }

  {
    const service = DFRedeemSync.createSyncService({
      chromeApi: fakeChrome({ communityDataUrl: 'https://example.test/codes.json' }),
      fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const result = await service.fetchCommunity();
    check('an unreachable vault reports an error instead of throwing', result.ok === false && /503/.test(result.error || ''), JSON.stringify(result));
  }

  {
    const service = DFRedeemSync.createSyncService({
      chromeApi: fakeChrome({ communityDataUrl: 'https://example.test/codes.json' }),
      fetchFn: async () => jsonResponse({ codes: 'not-an-array' }),
    });
    const result = await service.fetchCommunity();
    check('a malformed vault is rejected', result.ok === false && /mảng/.test(result.error || ''), JSON.stringify(result));
  }

  /* ---- reportOutcomes -------------------------------------------------- */
  {
    const requests = [];
    const service = DFRedeemSync.createSyncService({
      chromeApi: fakeChrome({ communityReportUrl: 'https://broker.test/submit' }),
      fetchFn: async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        const rows = JSON.parse(init.body).rows || [];
        return jsonResponse({ ok: true, accepted: rows.length, queued: rows.length, rejected: 0, needed: 2, results: [] });
      },
    });
    const result = await service.reportOutcomes([
      { code: 'good1code', status: 'success', err_code: 0 },
      { code: 'dead1code', status: 'expired', err_code: 400054 },
      { code: 'mine1code', status: 'mine', err_code: 400067 },
      { code: 'untried01', status: 'untried', err_code: 0 },
    ]);

    /* One request for the whole vault: row-by-row reporting burned the broker's
     * hourly quota and timed out the drawer's bridge before finishing. */
    check('the whole set goes in one request', requests.length === 1, 'requests: ' + requests.length);
    check('the batch endpoint is derived from the configured one',
      requests[0] && requests[0].url === 'https://broker.test/submit-batch', requests[0] && requests[0].url);

    const posted = (requests[0] && requests[0].body.rows) || [];
    check('reportOutcomes sends shareable verdicts', result.sent === 2, JSON.stringify(result));
    check('an account-specific verdict is never reported', !posted.some((p) => p.code === 'MINE1CODE'), JSON.stringify(posted));
    check('an untried code is never reported', !posted.some((p) => p.code === 'UNTRIED01'), JSON.stringify(posted));
    check('the per-account error code never leaves the machine', !posted.some((p) => p.err_code === 400067), JSON.stringify(posted));
    check('reports carry only code and err_code',
      posted.every((p) => Object.keys(p).sort().join(',') === 'code,err_code'), JSON.stringify(posted));
    check('reported codes are normalised to uppercase', posted.every((p) => p.code === p.code.toUpperCase()), JSON.stringify(posted));
    check('the batch body carries nothing but rows',
      Object.keys(requests[0].body).join(',') === 'rows', JSON.stringify(Object.keys(requests[0].body)));
  }

  {
    const service = DFRedeemSync.createSyncService({
      chromeApi: fakeChrome({ communityReportUrl: 'https://broker.test/submit', communityContribute: false }),
      fetchFn: async () => { throw new Error('must not be called'); },
    });
    const result = await service.reportOutcomes([{ code: 'good1code', status: 'success', err_code: 0 }]);
    check('opting out of contributing sends nothing', result.sent === 0 && result.skipped === 'disabled', JSON.stringify(result));
  }

  {
    const service = DFRedeemSync.createSyncService({
      chromeApi: fakeChrome({ communityReportUrl: '' }),
      fetchFn: async () => { throw new Error('must not be called'); },
    });
    const result = await service.reportOutcomes([{ code: 'good1code', status: 'success', err_code: 0 }]);
    check('no endpoint means no request', result.sent === 0 && result.skipped === 'no-endpoint', JSON.stringify(result));
  }

  {
    const service = DFRedeemSync.createSyncService({
      chromeApi: fakeChrome({ communityReportUrl: 'https://broker.test/submit' }),
      fetchFn: async () => { throw new Error('network down'); },
    });
    const result = await service.reportOutcomes([{ code: 'good1code', status: 'success', err_code: 0 }]);
    check('a broker outage does not throw', result.ok === false && result.failed === 1, JSON.stringify(result));
  }

  {
    /* A quota-exhausted broker answers 503 with a reason; showing only the status
     * code made an operational limit look like a broken vault. */
    const service = DFRedeemSync.createSyncService({
      chromeApi: fakeChrome({ communityReportUrl: 'https://broker.test/submit' }),
      fetchFn: async () => ({
        ok: false,
        status: 503,
        json: async () => ({
          ok: false,
          error: 'vault write quota for today is used up',
          resets_at: '2026-09-27T00:00:00.000Z',
        }),
      }),
    });
    const result = await service.reportOutcomes([{ code: 'good1code', status: 'success', err_code: 0 }]);
    check('a quota refusal explains itself instead of showing a bare status',
      /quota/i.test(result.error || '') && /503/.test(result.error || ''), JSON.stringify(result));
    check('a quota refusal is marked retriable',
      result.retriable === true, JSON.stringify(result));
  }

  {
    /* A non-JSON error body must not mask the status code. */
    const service = DFRedeemSync.createSyncService({
      chromeApi: fakeChrome({ communityReportUrl: 'https://broker.test/submit' }),
      fetchFn: async () => ({
        ok: false,
        status: 500,
        json: async () => { throw new Error('not json'); },
      }),
    });
    const result = await service.reportOutcomes([{ code: 'good1code', status: 'success', err_code: 0 }]);
    check('an unparseable error body still reports the status',
      result.error === 'HTTP 500' && result.retriable === false, JSON.stringify(result));
  }

  /* ---- mergeCommunityCodes -------------------------------------------- */
  {
    const service = DFRedeemSync.createSyncService({ chromeApi: fakeChrome(), fetchFn: async () => jsonResponse({}) });

    const local = [
      { code: 'LOCALSUCCESS', kind: 'giftcode', status: 'success', err_code: 0 },
      { code: 'LOCALUNTRIED', kind: 'giftcode', status: 'untried', err_code: 0 },
      { code: 'LOCALEXPIRED', kind: 'giftcode', status: 'expired', err_code: 400054 },
    ];
    const remote = [
      { code: 'LOCALSUCCESS', status: 'expired' },     // must NOT overwrite first-hand success
      { code: 'LOCALUNTRIED', status: 'exhausted' },   // may mark a never-tried code dead
      { code: 'LOCALEXPIRED', status: 'success' },     // must NOT resurrect a local dead verdict
      { code: 'BRANDNEWCODE', status: 'success' },     // new, usable here
      { code: 'BRANDNEWDEAD', status: 'invalid' },     // new, already dead
      { code: 'JUNKSTATUS01', status: 'mine' },        // unpublishable, must be ignored
    ];

    const merged = service.mergeCommunityCodes(local, remote);
    const find = (code) => merged.records.find((r) => r.code === code);

    check('a first-hand success is never overwritten', find('LOCALSUCCESS').status === 'success', JSON.stringify(find('LOCALSUCCESS')));
    check('a locally-untried code can be marked dead', find('LOCALUNTRIED').status === 'exhausted', JSON.stringify(find('LOCALUNTRIED')));
    check('a local dead verdict is not resurrected', find('LOCALEXPIRED').status === 'expired', JSON.stringify(find('LOCALEXPIRED')));
    check("someone else's success arrives as untried here", find('BRANDNEWCODE').status === 'untried', JSON.stringify(find('BRANDNEWCODE')));
    check('a new dead code arrives already dead', find('BRANDNEWDEAD').status === 'invalid', JSON.stringify(find('BRANDNEWDEAD')));
    check('an unpublishable remote status is ignored', !find('JUNKSTATUS01'), JSON.stringify(find('JUNKSTATUS01')));
    check('merge counts are reported', merged.added === 2 && merged.updated === 1, JSON.stringify({ added: merged.added, updated: merged.updated }));
    check('community rows are tagged', find('BRANDNEWCODE').tags.includes('community'));
    check('nothing is dropped', merged.records.length === 5, String(merged.records.length));

    /* Running the same merge twice must not double-add. */
    const again = service.mergeCommunityCodes(merged.records, remote);
    check('merging twice is idempotent', again.added === 0 && again.records.length === merged.records.length,
      JSON.stringify({ added: again.added, len: again.records.length }));
  }

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed === 0 ? 0 : 1);
}());
