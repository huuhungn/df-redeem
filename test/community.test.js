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
      { code: 'dead1code', status: 'invalid', err_code: 400054 },
      { code: 'mine1code', status: 'mine', err_code: 400067 },
      { code: 'used1code', status: 'mine', err_code: 400069 },
      { code: 'untried01', status: 'untried', err_code: 0 },
      { code: 'region1code', status: 'invalid', err_code: 400055 },
      { code: 'account1code', status: 'invalid', err_code: 400056 },
      { code: 'legacy1code', status: 'exhausted', err_code: 400069 },
      { code: 'unknown1code', status: 'invalid', err_code: 999999 },
    ]);

    /* One request for the whole vault: row-by-row reporting burned the broker's
     * hourly quota and timed out the drawer's bridge before finishing. */
    check('the whole set goes in one request', requests.length === 1, 'requests: ' + requests.length);
    check('the batch endpoint is derived from the configured one',
      requests[0] && requests[0].url === 'https://broker.test/submit-batch', requests[0] && requests[0].url);

    const posted = (requests[0] && requests[0].body.rows) || [];
    check('reportOutcomes sends shareable verdicts', result.sent === 2, JSON.stringify(result));
    check('an account-specific verdict is never reported', !posted.some((p) => p.code === 'MINE1CODE'), JSON.stringify(posted));
    check('a locally used code is never reported', !posted.some((p) => p.code === 'USED1CODE'), JSON.stringify(posted));
    check('an untried code is never reported', !posted.some((p) => p.code === 'UNTRIED01'), JSON.stringify(posted));
    check('the per-account error code never leaves the machine', !posted.some((p) => p.err_code === 400067), JSON.stringify(posted));
    check('a repeat-redemption 400069 never leaves the machine', !posted.some((p) => p.err_code === 400069), JSON.stringify(posted));
    check('account and region errors never leave the machine', !posted.some((p) => p.err_code === 400055 || p.err_code === 400056), JSON.stringify(posted));
    check('unknown or transient-looking local errors never leave the machine', !posted.some((p) => p.err_code === 999999), JSON.stringify(posted));
    check('reports carry only code and err_code',
      posted.every((p) => Object.keys(p).sort().join(',') === 'code,err_code'), JSON.stringify(posted));
    check('reported codes are normalised to uppercase', posted.every((p) => p.code === p.code.toUpperCase()), JSON.stringify(posted));
    /* The body gained install_id, so the old "rows only" assertion no longer
     * holds — but the privacy property it protected still must. Pin the exact
     * key set so a future field cannot slip in unnoticed, and assert the id is a
     * random v4 UUID rather than anything derived from the machine or the user. */
    check('the batch body carries only rows and a random install id',
      Object.keys(requests[0].body).sort().join(',') === 'install_id,rows',
      JSON.stringify(Object.keys(requests[0].body)));
    check('the install id is a random v4 UUID, not derived from the machine',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(String(requests[0].body.install_id)),
      String(requests[0].body.install_id));
  }

  {
    /* The install id must be stable across pushes, or every push would look like
     * a new reporter and a single machine could confirm its own codes. */
    const requests = [];
    const chromeApi = fakeChrome({ communityReportUrl: 'https://broker.test/submit' });
    const service = DFRedeemSync.createSyncService({
      chromeApi,
      fetchFn: async (url, init) => {
        requests.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, accepted: 1, results: [] }) };
      },
    });
    await service.reportOutcomes([{ code: 'good1code', status: 'success', err_code: 0 }]);
    await service.reportOutcomes([{ code: 'good2code', status: 'expired', err_code: 400068 }]);
    check('the install id is reused across pushes',
      requests.length === 2 && requests[0].install_id && requests[0].install_id === requests[1].install_id,
      JSON.stringify(requests.map((r) => r.install_id)));

    /* A second, independent install must not reuse the first one's id. */
    const other = DFRedeemSync.createSyncService({
      chromeApi: fakeChrome({ communityReportUrl: 'https://broker.test/submit' }),
      fetchFn: async (url, init) => {
        requests.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, accepted: 1, results: [] }) };
      },
    });
    await other.reportOutcomes([{ code: 'good3code', status: 'success', err_code: 0 }]);
    check('a separate install mints its own id',
      requests[2] && requests[2].install_id !== requests[0].install_id,
      JSON.stringify([requests[0].install_id, requests[2].install_id]));
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

  {
    const service = DFRedeemSync.createSyncService({ chromeApi: fakeChrome(), fetchFn: async () => jsonResponse({}) });
    const merged = service.mergeCommunityCodes(
      [{ code: 'DFVNHackclaw1', kind: 'giftcode', status: 'mine', err_code: 400067 }],
      [{ code: 'DFVNHACKCLAW1', status: 'success', err_code: 0 }],
    );
    check('community merge uses canonical identity without overwriting local original casing',
      merged.records.length === 1 && merged.records[0].code === 'DFVNHackclaw1' && merged.records[0].status === 'mine', JSON.stringify(merged));
  }

  {
    const service = DFRedeemSync.createSyncService({ chromeApi: fakeChrome(), fetchFn: async () => jsonResponse({}) });
    const merged = service.mergeCommunityCodes(
      [],
      [{ code: 'DFVNHackclaw1', status: 'success', err_code: 0 }],
    );
    check('community merge preserves mixed-case remote spelling for new code',
      merged.records.length === 1 && merged.records[0].code === 'DFVNHackclaw1' && merged.records[0].status === 'untried', JSON.stringify(merged));
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
      { code: 'LOCALUNTRIED', status: 'expired', err_code: 400068 },   // may mark a never-tried code dead
      { code: 'LOCALEXPIRED', status: 'success' },     // must NOT resurrect a local dead verdict
      { code: 'BRANDNEWCODE', status: 'success' },     // new, usable here
      { code: 'BRANDNEWDEAD', status: 'invalid' },     // new, already dead
      { code: 'JUNKSTATUS01', status: 'mine' },        // unpublishable, must be ignored
    ];

    const merged = service.mergeCommunityCodes(local, remote);
    const find = (code) => merged.records.find((r) => r.code === code);

    check('a first-hand success is never overwritten', find('LOCALSUCCESS').status === 'success', JSON.stringify(find('LOCALSUCCESS')));
    check('a locally-untried code can be marked dead', find('LOCALUNTRIED').status === 'expired', JSON.stringify(find('LOCALUNTRIED')));
    check('every added or remotely-updated row is surfaced for durable persistence',
      merged.changedRecords.length === 3 && merged.changedRecords.some((row) => row.code === 'LOCALUNTRIED'), JSON.stringify(merged.changedRecords));
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
