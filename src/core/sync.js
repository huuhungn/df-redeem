/* sync.js — pluggable, credential-safe cloud synchronization. */
const DFRedeemSync = (function attachSync(root) {
  'use strict';
  const factory = function createSyncModule() {
  'use strict';

  const SETTINGS_KEY = 'dfRedeemSettings';
  const RECORDS_KEY = 'dfRedeemRecords';
  const STATUS_KEY = 'dfRedeemSyncStatus';
  const SYNC_DELTA_KEY = 'dfRedeemSyncDelta';
  const DEFAULT_SETTINGS = Object.freeze({
    syncBackend: 'none',
    syncEndpoint: '',
    syncToken: '',
    autoSyncMinutes: 0,
    redeemIntervalMs: 2500,
    redeemTimeoutMs: 6000,
    /* Community vault: read the shared code list from a public URL, and report
     * this client's own verdicts to the broker so other clients skip dead codes.
     * Both halves are opt-out independently — a user may consume the list without
     * contributing. No credential is involved in either direction. */
    communityEnabled: true,
    communityDataUrl: 'https://raw.githubusercontent.com/huuhungn/df-redeem/main/data/codes.json',
    communityPresetsUrl: 'https://raw.githubusercontent.com/huuhungn/df-redeem/main/data/presets.json',
    communityReportUrl: '',
    communityContribute: true,
  });

  /* Chrome storage is callback-based in MV2 and promise-based in MV3; normalize
   * both, and turn a synchronous throw into a rejection so every caller can
   * simply await. */
  function asPromise(thunk) {
    try {
      const result = thunk();
      if (result && typeof result.then === 'function') return result;
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function storageGet(storage, keys) {
    return asPromise(() => storage.get(keys));
  }
  function storageSet(storage, value) {
    return asPromise(() => storage.set(value));
  }

  function timestampOf(record) {
    const value = record && (record.timestamp ?? record.updatedAt ?? record.time);
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function compactDelta(records) {
    const output = {};
    for (const input of Array.isArray(records) ? records : []) {
      const code = String(input && input.code || '').trim();
      if (!code) continue;
      const candidate = { code, status: String(input.status || 'UNKNOWN'), timestamp: timestampOf(input) };
      const previous = output[code];
      if (!previous || candidate.timestamp >= previous.timestamp) output[code] = candidate;
    }
    return output;
  }

  function mergeDeltas(local, remote) {
    const merged = {};
    for (const source of [local, remote]) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      for (const [key, value] of Object.entries(source)) {
        const code = String(value && value.code || key).trim();
        if (!code) continue;
        const candidate = { code, status: String(value.status || 'UNKNOWN'), timestamp: timestampOf(value) };
        const previous = merged[code];
        if (!previous || candidate.timestamp >= previous.timestamp) merged[code] = candidate;
      }
    }
    return merged;
  }

  function deltaToRecords(delta) {
    return Object.values(delta || {}).sort((a, b) => a.code.localeCompare(b.code));
  }

  function safeSettings(settings) {
    const input = settings && typeof settings === 'object' ? settings : {};
    return { ...DEFAULT_SETTINGS, ...input, syncToken: String(input.syncToken || '') };
  }

  function publicSettings(settings) {
    const safe = safeSettings(settings);
    const { syncToken, ...withoutToken } = safe;
    return withoutToken;
  }

  function serializeExport(data) {
    const input = data && typeof data === 'object' ? data : {};
    return JSON.stringify({
      version: 1,
      exportedAt: Date.now(),
      settings: publicSettings(input.settings),
      records: Array.isArray(input.records) ? input.records.map((record) => ({
        code: String(record.code || ''),
        status: String(record.status || 'UNKNOWN'),
        timestamp: timestampOf(record),
      })).filter((record) => record.code) : [],
    }, null, 2);
  }

  function parseImport(serialized) {
    const parsed = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
    if (!parsed || typeof parsed !== 'object') throw new Error('Dữ liệu nhập không hợp lệ.');
    return {
      settings: safeSettings(parsed.settings),
      records: deltaToRecords(compactDelta(parsed.records)),
    };
  }

  function endpointOrigin(endpoint) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Endpoint phải dùng HTTP hoặc HTTPS.');
    return url.origin;
  }

  function createSyncService(options) {
    const chromeApi = options && options.chromeApi;
    const fetchFn = options && options.fetchFn || (typeof fetch === 'function' ? fetch : null);
    const clock = options && options.now || (() => Date.now());
    const local = chromeApi && chromeApi.storage && chromeApi.storage.local;
    const sync = chromeApi && chromeApi.storage && chromeApi.storage.sync;
    const backends = new Map();

    function registerBackend(name, backend) {
      if (!name || !backend || typeof backend.pull !== 'function' || typeof backend.push !== 'function') throw new Error('Backend không hợp lệ.');
      backends.set(name, backend);
    }

    async function getLocal(keys) {
      if (!local) return {};
      return storageGet(local, keys);
    }
    async function setLocal(value) {
      if (!local) return;
      return storageSet(local, value);
    }
    async function setStatus(status) {
      await setLocal({ [STATUS_KEY]: status });
      return status;
    }

    registerBackend('chrome-sync', {
      async pull() {
        if (!sync) throw new Error('chrome.storage.sync không khả dụng.');
        const value = await storageGet(sync, { [SYNC_DELTA_KEY]: {} });
        return value && value[SYNC_DELTA_KEY] || {};
      },
      async push(_settings, delta) {
        if (!sync) throw new Error('chrome.storage.sync không khả dụng.');
        try {
          await storageSet(sync, { [SYNC_DELTA_KEY]: delta });
        } catch (error) {
          const message = String(error && error.message || error);
          if (/quota|QUOTA|bytes/i.test(message) || error && error.code === 'QUOTA_BYTES') {
            throw new Error('Vượt hạn mức chrome.storage.sync (~100 KB). Hãy dùng REST hoặc giảm dữ liệu.');
          }
          throw error;
        }
      },
    });

    registerBackend('rest', {
      async pull(settings) {
        if (!fetchFn) throw new Error('Không có fetch để gọi REST endpoint.');
        const endpoint = String(settings.syncEndpoint || '').trim();
        const token = String(settings.syncToken || '');
        if (!endpoint) throw new Error('Chưa nhập REST endpoint.');
        endpointOrigin(endpoint);
        const response = await fetchFn(endpoint, {
          method: 'GET',
          headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        if (!response || !response.ok) throw new Error(`REST GET lỗi HTTP ${response && response.status || 0}.`);
        const payload = await response.json();
        return payload && payload.delta || payload || {};
      },
      async push(settings, delta) {
        if (!fetchFn) throw new Error('Không có fetch để gọi REST endpoint.');
        const endpoint = String(settings.syncEndpoint || '').trim();
        const token = String(settings.syncToken || '');
        if (!endpoint) throw new Error('Chưa nhập REST endpoint.');
        endpointOrigin(endpoint);
        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ version: 1, delta }),
        });
        if (!response || !response.ok) throw new Error(`REST POST lỗi HTTP ${response && response.status || 0}.`);
        return true;
      },
    });

    async function syncNow(records) {
      const raw = await getLocal({ [SETTINGS_KEY]: DEFAULT_SETTINGS, [STATUS_KEY]: { state: 'never-synced', lastSyncAt: null } });
      const settings = safeSettings(raw[SETTINGS_KEY]);
      const backendName = settings.syncBackend;
      if (!backendName || backendName === 'none') return setStatus({ state: 'never-synced', lastSyncAt: null, error: null });
      const backend = backends.get(backendName);
      if (!backend) return setStatus({ state: 'error', lastSyncAt: null, error: `Backend không tồn tại: ${backendName}` });
      const startedAt = clock();
      await setStatus({ state: 'syncing', lastSyncAt: null, error: null });
      try {
        const localDelta = compactDelta(records);
        const remoteDelta = await backend.pull(settings);
        const merged = mergeDeltas(localDelta, remoteDelta);
        await backend.push(settings, merged);
        await setLocal({ [SYNC_DELTA_KEY]: merged, [RECORDS_KEY]: deltaToRecords(merged) });
        return setStatus({ state: 'ok', lastSyncAt: clock(), startedAt, error: null, recordCount: Object.keys(merged).length });
      } catch (error) {
        const message = String(error && error.message || error).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
        return setStatus({ state: 'error', lastSyncAt: null, error: message });
      }
    }

    async function status() {
      const raw = await getLocal({ [STATUS_KEY]: { state: 'never-synced', lastSyncAt: null, error: null } });
      return raw[STATUS_KEY];
    }

    /* ── community vault ───────────────────────────────────────────────────
     * Two independent halves, both credential-free:
     *   fetchCommunity()  — read the published list (a plain GET of public JSON)
     *   reportOutcomes()  — tell the broker what this client observed
     * Neither can fail the redeem cycle: every error resolves to a report the
     * caller can show, never a throw that aborts a run.
     */

    /* A verdict is only shareable when it is true for everyone. 'mine' means
     * "this account already redeemed it", which is useless (and mildly
     * identifying) to other users, so it never leaves the machine. */
    const SHAREABLE_STATUS = new Set(['success', 'expired', 'invalid', 'exhausted', 'gift_bug']);

    async function fetchCommunity(settingsOverride) {
      const raw = await getLocal({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
      const settings = safeSettings(settingsOverride || raw[SETTINGS_KEY]);
      if (!settings.communityEnabled) return { ok: false, skipped: 'disabled', codes: [], presets: [] };
      if (!fetchFn) return { ok: false, error: 'fetch không khả dụng', codes: [], presets: [] };

      const load = async (url, key) => {
        if (!url) return [];
        /* A published vault is public data, so no credential is attached — and
         * `credentials: 'omit'` makes sure the browser does not volunteer cookies
         * to a third-party host either. */
        const response = await fetchFn(url, { credentials: 'omit', cache: 'no-cache' });
        if (!response || !response.ok) throw new Error(`HTTP ${response && response.status || 0} khi tải ${key}`);
        const doc = await response.json();
        const rows = doc && doc[key];
        if (!Array.isArray(rows)) throw new Error(`${key} không phải mảng`);
        return rows;
      };

      try {
        const [codes, presets] = await Promise.all([
          load(String(settings.communityDataUrl || '').trim(), 'codes'),
          load(String(settings.communityPresetsUrl || '').trim(), 'presets'),
        ]);
        return { ok: true, codes, presets, fetchedAt: clock() };
      } catch (error) {
        return { ok: false, error: String(error && error.message || error), codes: [], presets: [] };
      }
    }

    async function reportOutcomes(records, settingsOverride) {
      const raw = await getLocal({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
      const settings = safeSettings(settingsOverride || raw[SETTINGS_KEY]);
      const endpoint = String(settings.communityReportUrl || '').trim();
      if (!settings.communityEnabled || !settings.communityContribute) {
        return { ok: false, skipped: 'disabled', sent: 0 };
      }
      if (!endpoint) return { ok: false, skipped: 'no-endpoint', sent: 0 };
      if (!fetchFn) return { ok: false, error: 'fetch không khả dụng', sent: 0 };

      const shareable = (Array.isArray(records) ? records : []).filter(
        (row) => row && row.code && SHAREABLE_STATUS.has(String(row.status || '')),
      );
      if (!shareable.length) return { ok: true, sent: 0, skipped: 'nothing-shareable' };

      let sent = 0;
      const failures = [];
      for (const row of shareable) {
        try {
          /* Only the code and the raw Garena error number travel. No timestamps,
           * no account, no local notes — the broker derives the verdict itself. */
          const response = await fetchFn(endpoint, {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: String(row.code).trim().toUpperCase(), err_code: Number(row.err_code || 0) }),
          });
          if (response && response.ok) sent += 1;
          else failures.push(`${row.code}: HTTP ${response && response.status || 0}`);
        } catch (error) {
          failures.push(`${row.code}: ${String(error && error.message || error)}`);
        }
      }
      return { ok: failures.length === 0, sent, failed: failures.length, failures: failures.slice(0, 5) };
    }

    /* Fold the community list into local records: it may only ever ADD codes the
     * user has never tried, or mark a locally-untried code as already dead. A
     * remote row must never overwrite a verdict this machine observed first-hand,
     * because the local observation is the stronger evidence. */
    function mergeCommunityCodes(localRecords, communityCodes) {
      const byCode = new Map((Array.isArray(localRecords) ? localRecords : []).map((row) => [String(row.code).toUpperCase(), row]));
      let added = 0;
      let updated = 0;

      for (const remote of Array.isArray(communityCodes) ? communityCodes : []) {
        const code = String(remote && remote.code || '').trim().toUpperCase();
        if (!code) continue;
        const status = String(remote && remote.status || '');
        if (!SHAREABLE_STATUS.has(status)) continue;

        const local = byCode.get(code);
        if (!local) {
          byCode.set(code, {
            code,
            kind: 'giftcode',
            /* Someone else's success is still untried *here*, so the user can
             * redeem it themselves. Dead verdicts carry over as-is to save a
             * pointless request. */
            status: status === 'success' ? 'untried' : status,
            source: 'community',
            err_code: status === 'success' ? 0 : Number(remote.err_code || 0),
            attempt_count: 0,
            shareable: status === 'success',
            tags: ['community'],
            notes: '',
          });
          added += 1;
          continue;
        }

        if (String(local.status || '') === 'untried' && status !== 'success') {
          local.status = status;
          local.err_code = Number(remote.err_code || 0);
          local.source = local.source || 'community';
          updated += 1;
        }
      }

      return { records: [...byCode.values()], added, updated };
    }

    return { registerBackend, syncNow, status, getLocal, setLocal, compactDelta, mergeDeltas, serializeExport, parseImport, publicSettings, fetchCommunity, reportOutcomes, mergeCommunityCodes, keys: { SETTINGS_KEY, RECORDS_KEY, STATUS_KEY, SYNC_DELTA_KEY } };
  }

  return { SETTINGS_KEY, RECORDS_KEY, STATUS_KEY, SYNC_DELTA_KEY, DEFAULT_SETTINGS, compactDelta, mergeDeltas, deltaToRecords, publicSettings, serializeExport, parseImport, createSyncService };
  };

  const api = factory();
  root.DFRedeemSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
}(typeof window !== 'undefined' ? window : globalThis));
