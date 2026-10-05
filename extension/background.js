/* background.js — toolbar action plus the sync broker.
 * The worker is the only place the sync token is read or used. */
/* sync.js — pluggable, credential-safe cloud synchronization. */
const DFRedeemSync = (function attachSync(root) {
  'use strict';
  const factory = function createSyncModule() {
  'use strict';

  const SETTINGS_KEY = 'dfRedeemSettings';
  const RECORDS_KEY = 'dfRedeemRecords';
  const STATUS_KEY = 'dfRedeemSyncStatus';
  /* chrome.storage.sync limits a single stored item to 8 KB. Keep a small
   * manifest plus shards rather than one ever-growing object: the full current
   * vault is ~22 KB, so the old single-key design failed long before its quoted
   * ~100 KB total allowance. */
  const SYNC_MANIFEST_KEY = 'dfRedeemSyncManifest';
  const SYNC_CHUNK_PREFIX = 'dfRedeemSyncChunk:';
  const SYNC_CHUNK_BYTES = 7000;
  const SYNC_DELTA_KEY = 'dfRedeemSyncDelta';
  /* Random per-install id so the broker can count independent reporters without
   * using the IP address (everyone behind one router looked like one reporter,
   * and one phone on a rotating mobile IP looked like many). Minted once and kept
   * in local storage, which survives browser restarts but not a reinstall. */
  const INSTALL_ID_KEY = 'dfRedeemInstallId';
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
    /* Opt-out is per-direction; see the comment above. */
    communityEnabled: true,
    communityDataUrl: 'https://raw.githubusercontent.com/huuhungn/df-redeem/main/data/codes.json',
    communityPresetsUrl: 'https://raw.githubusercontent.com/huuhungn/df-redeem/main/data/presets.json',
    communityReportUrl: 'https://df-redeem-vault.huuhungn.workers.dev/submit',
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
  function storageRemove(storage, keys) {
    return asPromise(() => storage.remove(keys));
  }

  function chunkDelta(delta) {
    const chunks = [];
    let current = {};
    for (const [code, row] of Object.entries(delta || {}).sort(([a], [b]) => a.localeCompare(b))) {
      const next = { ...current, [code]: row };
      if (Object.keys(current).length && JSON.stringify(next).length > SYNC_CHUNK_BYTES) {
        chunks.push(current);
        current = { [code]: row };
      } else current = next;
    }
    if (Object.keys(current).length) chunks.push(current);
    return chunks;
  }

  function newSyncGeneration() {
    /* Chunks are immutable once published. A unique generation prevents a reader
     * from combining chunk 0 of one device's write with chunk 1 of another's. */
    const random = typeof crypto !== 'undefined' && crypto.getRandomValues
      ? Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join('')
      : Math.random().toString(36).slice(2);
    return Date.now().toString(36) + '-' + random;
  }

  async function readChromeSyncDelta(sync) {
    /* Compatibility: a small vault written by an older extension has no
     * manifest. Read that one legacy key once, then the next successful write
     * promotes it to chunks. */
    const manifestReply = await storageGet(sync, { [SYNC_MANIFEST_KEY]: null, [SYNC_DELTA_KEY]: {} });
    const manifest = manifestReply && manifestReply[SYNC_MANIFEST_KEY];
    if (!manifest || !Array.isArray(manifest.keys)) return manifestReply && manifestReply[SYNC_DELTA_KEY] || {};
    const reply = await storageGet(sync, manifest.keys);
    const merged = {};
    for (const key of manifest.keys) {
      if (!Object.prototype.hasOwnProperty.call(reply || {}, key) || !reply[key] || typeof reply[key] !== 'object') {
        throw new Error('Bản sao Chrome Sync chưa hoàn chỉnh; hãy thử đồng bộ lại.');
      }
      Object.assign(merged, reply[key]);
    }
    return merged;
  }

  async function writeChromeSyncDelta(sync, delta) {
    const chunks = chunkDelta(delta);
    const oldReply = await storageGet(sync, { [SYNC_MANIFEST_KEY]: null });
    const oldManifest = oldReply && oldReply[SYNC_MANIFEST_KEY];
    const generation = newSyncGeneration();
    const keys = chunks.map((_, index) => SYNC_CHUNK_PREFIX + generation + ':' + index);
    const body = Object.fromEntries(chunks.map((chunk, index) => [keys[index], chunk]));
    /* Publish data before its pointer: readers see either the former complete
     * generation or this complete generation, never a mixture of both. */
    if (keys.length) await storageSet(sync, body);
    await storageSet(sync, { [SYNC_MANIFEST_KEY]: { version: 2, generation, keys, recordCount: Object.keys(delta || {}).length } });
    const obsolete = [...new Set([SYNC_DELTA_KEY, ...((oldManifest && oldManifest.keys) || [])])].filter((key) => !keys.includes(key));
    if (obsolete.length) await storageRemove(sync, obsolete);
  }

  /* crypto.randomUUID needs a secure context; the extension pages are one, but a
   * content script injected into an http page is not, so fall back rather than
   * throw and lose the report. */
  function mintInstallId(cryptoApi) {
    const api = cryptoApi || (typeof crypto !== 'undefined' ? crypto : null);
    if (api && typeof api.randomUUID === 'function') return api.randomUUID();
    if (api && typeof api.getRandomValues === 'function') {
      const bytes = api.getRandomValues(new Uint8Array(16));
      /* RFC 4122 version/variant bits, so the id matches the shape the broker
       * validates instead of being rejected as malformed. */
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return '';
  }

  function timestampOf(record) {
    const value = record && (record.timestamp ?? record.updatedAt ?? record.last_tried ?? record.time);
    const numeric = Number(value);
    const timestamp = Number.isFinite(numeric) ? numeric : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function canonicalCode(value) {
    return String(value == null ? '' : value).trim().toUpperCase();
  }

  function compactDelta(records) {
    const output = {};
    for (const input of Array.isArray(records) ? records : []) {
      const code = String(input && input.code || '').trim();
      const key = canonicalCode(code);
      if (!key) continue;
      const candidate = { code, status: String(input.status || 'UNKNOWN'), timestamp: timestampOf(input) };
      const previous = output[key];
      if (!previous || candidate.timestamp >= previous.timestamp) output[key] = candidate;
    }
    return output;
  }

  function mergeDeltas(local, remote) {
    const merged = {};
    for (const source of [local, remote]) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      for (const [key, value] of Object.entries(source)) {
        const code = String(value && value.code || key).trim();
        const canonical = canonicalCode(code);
        if (!canonical) continue;
        const candidate = { code, status: String(value.status || 'UNKNOWN'), timestamp: timestampOf(value) };
        const previous = merged[canonical];
        if (!previous || candidate.timestamp >= previous.timestamp) merged[canonical] = candidate;
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

  /* Where a backup goes. A status describes the destination that produced it,
   * so a change to any of these makes the stored status stale. Endpoint and
   * token only address a REST backend; the options form posts them for every
   * backend, and editing an unused field must not void a Chrome-sync status. */
  function destinationKey(settings) {
    const safe = safeSettings(settings);
    if (safe.syncBackend !== 'rest') return JSON.stringify([safe.syncBackend]);
    return JSON.stringify([safe.syncBackend, String(safe.syncEndpoint || '').trim(), safe.syncToken]);
  }

  /* fetch() rejects with the browser's own English wording — "Failed to fetch"
   * in Chrome, "NetworkError when attempting to fetch resource." in Firefox,
   * "Load failed" in Safari — and that string reached the toast, the sync chip
   * and the options page verbatim. Map the known transport failures to one
   * Vietnamese sentence; every other message is already ours and passes
   * through unchanged. */
  const NETWORK_ERROR_TEXT = [
    [/failed to fetch|networkerror when attempting to fetch|^(?:typeerror:\s*)?load failed$|network request failed|^(?:typeerror:\s*)?fetch failed$|net::err_|err_(?:name_not_resolved|connection_\w+|internet_disconnected|address_unreachable)/i,
      'Lỗi mạng: không kết nối được máy chủ (mất Internet, sai địa chỉ hoặc máy chủ chặn truy cập).'],
    [/^(?:aborterror|timeouterror)\b|user aborted|operation was aborted|signal is aborted|timed out/i,
      'Máy chủ không phản hồi kịp (quá thời gian chờ).'],
    [/unexpected token|is not valid json|unexpected end of json|json\.parse/i,
      'Máy chủ trả về dữ liệu không đọc được (không phải JSON).'],
    [/^(?:typeerror:\s*)?(?:invalid url|failed to construct 'url')/i,
      'Địa chỉ máy chủ không hợp lệ.'],
  ];
  function friendlyError(error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return NETWORK_ERROR_TEXT[1][1];
    const message = String(error && error.message || error || '');
    for (const [pattern, text] of NETWORK_ERROR_TEXT) if (pattern.test(message)) return text;
    return message;
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

  /* A verdict is only shareable when it is true for everyone. Account-scoped
   * statuses never leave the machine:
   *   - `mine`        — "this account already redeemed it": useless and mildly
   *                     identifying to others
   *   - `group_limit` — this account's reward-group cap; the code still works for
   *                     everybody else, so publishing it would kill a live code
   *   - `sys_error`   — Garena failed to answer; not a verdict at all
   */
  const SHAREABLE_STATUS = new Set(['success', 'expired', 'gift_bug']);
  /* Statuses are presentation/local state. The upstream Garena error code is the
   * privacy boundary: only these code-wide outcomes may leave an installation.
   * Account/region errors can be stored as `invalid` locally, but must never be
   * reported to the public broker. */
  /* A client only posts the globally meaningful Garena outcomes. The Worker has a
   * second allowlist, but filtering here prevents account/region status and legacy
   * local state from leaving the browser at all. */
  /* 400054 means the submitted spelling was rejected, but some Garena codes are
   * casing-sensitive. Until the protocol can prove the spelling is canonical, it
   * is local evidence only and may not poison the shared vault. */
  const SHAREABLE_OUTCOMES = new Map([
    [0, 'success'],
    [400068, 'expired'],
    [400070, 'expired'],
    [400073, 'gift_bug'],
  ]);

  /* Fold the community list into local records: it may only ever ADD codes the
   * user has never tried, or mark a locally-untried code as already dead. A
   * remote row must never overwrite a verdict this machine observed first-hand,
   * because the local observation is the stronger evidence. */
  function mergeCommunityCodes(localRecords, communityCodes) {
    const byCode = new Map();
    for (const row of Array.isArray(localRecords) ? localRecords : []) {
      const key = canonicalCode(row && row.code);
      if (!key) continue;
      const previous = byCode.get(key);
      if (!previous || timestampOf(row) >= timestampOf(previous)) byCode.set(key, { ...row });
    }
    let added = 0;
    let updated = 0;
    const changedRecords = [];

    for (const remote of Array.isArray(communityCodes) ? communityCodes : []) {
      const submittedCode = String(remote && remote.code || '').trim();
      const code = canonicalCode(submittedCode);
      if (!code) continue;
      const status = String(remote && remote.status || '');
      if (!SHAREABLE_STATUS.has(status)) continue;

      const local = byCode.get(code);
      if (!local) {
        const created = {
          code: submittedCode,
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
        };
        byCode.set(code, created);
        changedRecords.push(created);
        added += 1;
        continue;
      }

      if (String(local.status || '') === 'untried' && status !== 'success') {
        local.status = status;
        local.err_code = Number(remote.err_code || 0);
        local.source = local.source || 'community';
        changedRecords.push({ ...local });
        updated += 1;
      }
    }

    return { records: [...byCode.values()], changedRecords, added, updated };
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

    /* Read the install id, minting and persisting it on first use. Concurrent
     * callers can race here, but the loser just overwrites with an equally valid
     * id — at worst one push counts as a different install, which is harmless. */
    async function installId() {
      const stored = await getLocal({ [INSTALL_ID_KEY]: '' });
      const existing = String(stored && stored[INSTALL_ID_KEY] || '').trim();
      if (existing) return existing;
      const minted = mintInstallId(options && options.cryptoApi);
      if (minted) await setLocal({ [INSTALL_ID_KEY]: minted });
      return minted;
    }

    registerBackend('chrome-sync', {
      async pull() {
        if (!sync) throw new Error('chrome.storage.sync không khả dụng.');
        return readChromeSyncDelta(sync);
      },
      async push(_settings, delta) {
        if (!sync) throw new Error('chrome.storage.sync không khả dụng.');
        try {
          await writeChromeSyncDelta(sync, delta);
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
      const destination = destinationKey(settings);
      /* A backup to the old destination that finishes after the user saved a
       * new one must not paint its verdict over the new destination's status:
       * that is exactly how a stale "Failed to fetch" outlived the fix. */
      const settle = async (status) => {
        const now = await getLocal({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
        return destinationKey(now[SETTINGS_KEY]) === destination ? setStatus(status) : status;
      };
      await setStatus({ state: 'syncing', lastSyncAt: null, error: null });
      try {
        const localDelta = compactDelta(records);
        const remoteDelta = await backend.pull(settings);
        const merged = mergeDeltas(localDelta, remoteDelta);
        await backend.push(settings, merged);
        await setLocal({ [SYNC_DELTA_KEY]: merged, [RECORDS_KEY]: deltaToRecords(merged) });
        return settle({ state: 'ok', lastSyncAt: clock(), startedAt, error: null, recordCount: Object.keys(merged).length });
      } catch (error) {
        const message = friendlyError(error).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
        return settle({ state: 'error', lastSyncAt: null, error: message });
      }
    }

    /* Persist new settings. Moving the backup elsewhere — another backend,
     * endpoint or token, or switching it off and on — voids the stored status:
     * an error (or an "ok") describes the destination that produced it, and
     * leaving it up made the new destination look broken before it was even
     * tried. Only a boolean leaves here; the destination key holds the token. */
    async function saveSettings(next) {
      const raw = await getLocal({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
      const moved = destinationKey(raw[SETTINGS_KEY]) !== destinationKey(next);
      await setLocal({ [SETTINGS_KEY]: next });
      if (moved) await setStatus({ state: 'never-synced', lastSyncAt: null, error: null });
      return { moved };
    }

    async function status() {
      const raw = await getLocal({ [STATUS_KEY]: { state: 'never-synced', lastSyncAt: null, error: null } });
      const current = raw[STATUS_KEY];
      /* Statuses written before errors were translated still hold the
       * browser's English; translate them on the way out as well. */
      return current && current.error ? { ...current, error: friendlyError(current.error) } : current;
    }

    /* Return the public settings needed by UI surfaces without exposing tokens. */
    async function getSettings() {
      const raw = await getLocal({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
      const settings = safeSettings(raw[SETTINGS_KEY]);
      return {
        autoSync: Number(settings.autoSyncMinutes || 0) > 0,
        backend: settings.syncBackend === 'none' ? 'chrome-sync' : settings.syncBackend,
        enabled: settings.syncBackend !== 'none',
      };
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
        return { ok: false, error: friendlyError(error), codes: [], presets: [] };
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

      const shareable = (Array.isArray(records) ? records : []).filter((row) =>
        row && row.code && SHAREABLE_OUTCOMES.get(Number(row.err_code)) === String(row.status || ''),
      );
      if (!shareable.length) return { ok: true, sent: 0, skipped: 'nothing-shareable' };

      /* One request for the whole set. Reporting row-by-row exhausted the broker's
       * hourly quota and could not finish inside the drawer's bridge timeout, so a
       * full vault never got reported at all.
       *
       * The configured URL points at the single-row endpoint, so derive the batch
       * one. If it has been pointed somewhere unrecognised, fall back rather than
       * POST a batch body to an endpoint that expects one row. */
      const batchEndpoint = /\/submit$/.test(endpoint) ? endpoint.replace(/\/submit$/, '/submit-batch') : null;
      if (!batchEndpoint) {
        return { ok: false, sent: 0, failed: shareable.length, error: 'endpoint phải kết thúc bằng /submit' };
      }
      try {
        const response = await fetchFn(batchEndpoint, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          /* Only the code, the raw Garena error number and a random install id
           * travel. No timestamps, no account, no local notes — the broker derives
           * the verdict itself, and the id is random per install, not an identity. */
          body: JSON.stringify({
            install_id: await installId(),
            rows: shareable.map((row) => ({
              code: String(row.code).trim(),
              err_code: Number(row.err_code || 0),
            })),
          }),
        });
        if (!response || !response.ok) {
          /* The broker explains an exhausted daily write quota in the body; a bare
           * "HTTP 503" in the drawer looks like a broken vault and sends people
           * hunting for a bug that isn't there. Surface its reason instead. */
          let detail = '';
          try {
            const body = await response.json();
            if (body && body.error) detail = String(body.error);
            if (body && body.resets_at) {
              const at = new Date(body.resets_at);
              if (!Number.isNaN(at.getTime())) {
                detail += ` (thử lại sau ${at.getUTCHours().toString().padStart(2, '0')}:00 UTC)`;
              }
            }
          } catch { /* non-JSON body: fall back to the status code alone */ }
          const status = (response && response.status) || 0;
          return {
            ok: false,
            sent: 0,
            failed: shareable.length,
            error: detail ? `${detail} [HTTP ${status}]` : `HTTP ${status}`,
            retriable: status === 429 || status === 503,
          };
        }
        const doc = await response.json();
        const rejected = Number(doc.rejected || 0);
        return {
          ok: rejected === 0,
          sent: Number(doc.accepted || 0),
          queued: Number(doc.queued || 0),
          failed: rejected,
          needed: Number(doc.needed || 0),
          failures: (doc.results || []).filter((r) => r && r.ok === false).slice(0, 5)
            .map((r) => `${r.code || '?'}: ${r.error || 'rejected'}`),
        };
      } catch (error) {
        return { ok: false, sent: 0, failed: shareable.length, error: friendlyError(error) };
      }
    }

    /* ── equipment costs ──────────────────────────────────────────────────────
     * Costs ride the same credential-free community channel as verdicts, and
     * derive their endpoints from the configured /submit URL the same way
     * reportOutcomes derives /submit-batch. Keeping one configured URL means a
     * user cannot end up with verdicts pointing at one broker and costs at
     * another. */
    function costEndpoints(settings) {
      const endpoint = String((settings && settings.communityReportUrl) || '').trim();
      if (!endpoint) return null;
      if (!/\/submit$/.test(endpoint)) return null;
      const base = endpoint.replace(/\/submit$/, '');
      return { report: `${base}/cost`, list: `${base}/costs` };
    }

    /** Pull agreed community costs, keyed by code for O(1) lookup in the UI. */
    async function fetchCosts(override) {
      try {
        /* Same convention as fetchCommunity: callers without a chromeApi (the
         * console build, the service worker) pass settings in explicitly. */
        const settings = override || (await getSettings());
        if (settings && settings.communityEnabled === false) return { ok: false, skipped: 'disabled', costs: {} };
        const urls = costEndpoints(settings);
        if (!urls) return { ok: false, skipped: 'no-endpoint', costs: {} };
        if (!fetchFn) return { ok: false, error: 'Không có fetch', costs: {} };
        const response = await fetchFn(urls.list, { method: 'GET', headers: { accept: 'application/json' } });
        if (!response || !response.ok) return { ok: false, error: `HTTP ${(response && response.status) || 0}`, costs: {} };
        const doc = await response.json();
        const costs = {};
        for (const row of (doc && doc.costs) || []) {
          const code = String((row && row.code) || '').trim().toUpperCase();
          const value = Number(row && row.cost);
          if (!code || !Number.isFinite(value) || value <= 0) continue;
          costs[code] = { value, state: String(row.state || 'unconfirmed'), reports: Number(row.reports || 0) };
        }
        return { ok: true, costs, count: Object.keys(costs).length };
      } catch (error) {
        return { ok: false, error: friendlyError(error), costs: {} };
      }
    }

    /* Push one measured cost. Deliberately one-at-a-time rather than batched:
     * costs are typed by hand one card at a time, so a batch endpoint would add
     * a queue to flush and a partial-failure story for no real gain. */
    async function reportCost(code, cost, mode, override) {
    /* Backward-compatible call shape for direct integrations that used
     * reportCost(code, cost, settings) before mode was introduced. Such callers
     * cannot report a price now: mode is required at the Worker boundary. */
    if (mode && typeof mode === 'object' && override === undefined) {
      override = mode;
      mode = '';
    }
    try {
        const settings = override || (await getSettings());
        if (settings && settings.communityEnabled === false) return { ok: false, skipped: 'disabled' };
        const urls = costEndpoints(settings);
        if (!urls) return { ok: false, skipped: 'no-endpoint' };
        if (!fetchFn) return { ok: false, error: 'Không có fetch' };
        const response = await fetchFn(urls.report, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          /* Same minimal payload discipline as reportOutcomes: the code, the
           * number, the mode that makes this price meaningful, and a random
           * per-install id. No account or timestamp. */
          body: JSON.stringify({ install_id: await installId(), code: String(code).trim(), cost, mode: String(mode || '').trim() }),
        });
        let doc = null;
        try { doc = await response.json(); } catch { /* non-JSON error body */ }
        if (!response || !response.ok) {
          return {
            ok: false,
            error: (doc && doc.error) ? String(doc.error) : `HTTP ${(response && response.status) || 0}`,
            retriable: response && (response.status === 429 || response.status === 503),
          };
        }
        return {
          ok: true,
          cost: Number(doc && doc.cost) || 0,
          state: String((doc && doc.state) || 'unconfirmed'),
          reports: Number((doc && doc.reports) || 0),
          unchanged: !!(doc && doc.unchanged),
        };
      } catch (error) {
        return { ok: false, error: friendlyError(error) };
      }
    }

    return { registerBackend, syncNow, saveSettings, status, getSettings, getLocal, setLocal, compactDelta, mergeDeltas, serializeExport, parseImport, publicSettings, fetchCommunity, reportOutcomes, mergeCommunityCodes, fetchCosts, reportCost, keys: { SETTINGS_KEY, RECORDS_KEY, STATUS_KEY, SYNC_DELTA_KEY, SYNC_MANIFEST_KEY, SYNC_CHUNK_PREFIX } };
  }

  /* mergeCommunityCodes is pure, so expose it at module level too: UI surfaces
   * need it without constructing a storage-backed service. */
  return { SETTINGS_KEY, RECORDS_KEY, STATUS_KEY, SYNC_DELTA_KEY, SYNC_MANIFEST_KEY, SYNC_CHUNK_PREFIX, DEFAULT_SETTINGS, compactDelta, mergeDeltas, deltaToRecords, publicSettings, friendlyError, destinationKey, serializeExport, parseImport, createSyncService, mergeCommunityCodes };
  };

  const api = factory();
  root.DFRedeemSync = api;
    return api;
}(typeof window !== 'undefined' ? window : globalThis));

/* src/core/hq.js — recommended Gunsmith codes from the official HQ page.
 *
 * https://www.playdeltaforce.com/events/hq/vi/ ("Đề Xuất Chia Sẻ Mã") shows a
 * curated list of builds. Reconnaissance of the live page found two sources:
 *
 *   1. Static, public, unauthenticated files the page itself loads:
 *        gun-codes/op_sol_ga_vi.js  → window.gun_codes_op_sol_ga  (Operations)
 *        gun-codes/op_mp_ga_vi.js   → window.gun_codes_op_mp_ga   (Warfare)
 *      `_ga` is the Garena channel. Each is `var NAME = [ ...JSON... ];` with the
 *      full list — the logged-in API returned exactly these codes (10 + 5), so
 *      there is no second page to walk. The files send no CORS header, which is
 *      why the extension's service worker fetches them, not the page.
 *   2. The logged-in API (DfTools/ListGunCodeSchemes), which adds one thing the
 *      static files lack: `price`, the Operations build cost. Calling it needs
 *      the player's HQ openid/token. We never do; see tapHqPrices in build.js,
 *      which only reads responses the HQ page already received.
 *
 * The "Kích Nổ" (detonation) tab has no gun codes at all: the page skips its
 * gun-code sync for that tab, so there is nothing to import for it.
 *
 * Everything here is pure and DOM-free so the service worker, the panel and
 * the tests share one implementation. Files are PARSED as JSON, never
 * evaluated: they come from a third-party host and must not become code.
 */
(function attach(root) {
  'use strict';

  const HQ_PAGE_URL = 'https://www.playdeltaforce.com/events/hq/vi/';
  const HQ_ORIGIN = 'https://www.playdeltaforce.com';
  const OPERATIONS = 'Chiến Dịch Sinh Tồn';
  const WARFARE = 'Chiến Trường Toàn Diện';
  const SOURCES = Object.freeze([
    Object.freeze({ hqMode: 'sol', mode: OPERATIONS, varName: 'gun_codes_op_sol_ga', url: `${HQ_ORIGIN}/gun-codes/op_sol_ga_vi.js` }),
    Object.freeze({ hqMode: 'mp', mode: WARFARE, varName: 'gun_codes_op_mp_ga', url: `${HQ_ORIGIN}/gun-codes/op_mp_ga_vi.js` }),
  ]);
  const MODE_BY_HQ = Object.freeze({ sol: OPERATIONS, mp: WARFARE });
  /* Gunsmith share codes in this list are 21 upper-case base32 characters. */
  const CODE_RE = /^[A-Z0-9]{21}$/;
  /* A few times the size of the real files (~40 KB); anything larger is not
   * the file we expect and is refused before JSON.parse runs on it. */
  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_ITEMS = 500;
  /* Same bounds as costs.js parseCost, repeated so the service worker, which
   * does not load costs.js, applies them too. */
  const MIN_PRICE = 100;
  const MAX_PRICE = 9999999;

  const text = (value) => (value == null ? '' : String(value)).trim();

  /* `gun_code` is "<gun name>-<mode name>-<CODE>". Gun names contain hyphens
   * ("AR-57 Assault Rifle"), so split from the right: the code is whatever
   * follows the LAST hyphen. The API field is the bare code, which this also
   * accepts. */
  function extractCode(value) {
    const raw = text(value).replace(/\s+/g, '');
    const tail = raw.slice(raw.lastIndexOf('-') + 1).toUpperCase();
    return CODE_RE.test(tail) ? tail : '';
  }

  /* `var gun_codes_op_sol_ga = [...];` → the array. Refuses anything that is
   * not exactly one declaration of the expected name around a JSON array. */
  function parseSchemeFile(source, expectedVar) {
    const body = String(source == null ? '' : source);
    if (body.length > MAX_FILE_BYTES) throw new Error('Tệp HQ quá lớn');
    const head = /^\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*/.exec(body);
    if (!head) throw new Error('Tệp HQ không đúng định dạng');
    if (expectedVar && head[1] !== expectedVar) throw new Error(`Tệp HQ đổi tên biến: ${head[1]}`);
    const json = body.slice(head[0].length).replace(/;\s*$/, '');
    let data;
    try { data = JSON.parse(json); } catch (_) { throw new Error('Tệp HQ không phải JSON hợp lệ'); }
    if (!Array.isArray(data)) throw new Error('Tệp HQ không phải danh sách');
    return data;
  }

  /* Whitelist the fields the library shows. Author avatars, stats and the
   * Gunsmith config blob are dropped: the library stores codes, not HQ's UI. */
  function normalizeSchemes(groups, mode) {
    const out = [];
    const seen = new Set();
    for (const group of Array.isArray(groups) ? groups : []) {
      const weapon = text(group && group.gun_name);
      for (const scheme of (group && Array.isArray(group.schemes) ? group.schemes : [])) {
        const code = extractCode(scheme && scheme.gun_code);
        if (!code || seen.has(code) || out.length >= MAX_ITEMS) continue;
        seen.add(code);
        out.push({
          code,
          weapon,
          mode: text(mode),
          title: text(scheme.name).slice(0, 120),
          author: (Array.isArray(scheme.authors) ? scheme.authors : [])
            .map((a) => text(a && a.name)).filter(Boolean).join(', ').slice(0, 80),
          tags: (Array.isArray(scheme.tags) ? scheme.tags : [])
            .map((t) => text(t && t.name)).filter(Boolean).slice(0, 8),
          scheme_id: text(scheme.scheme_id),
        });
      }
    }
    return out;
  }

  /* Split HQ items into new and already-in-library. Matching is by code only
   * and case-insensitive, so a library row is never duplicated or overwritten
   * because HQ spelled a weapon differently. */
  function planImport(libraryPresets, items) {
    const have = new Set((Array.isArray(libraryPresets) ? libraryPresets : [])
      .map((row) => text(row && row.code).toUpperCase()).filter(Boolean));
    const fresh = [];
    const known = [];
    for (const item of Array.isArray(items) ? items : []) {
      (have.has(item.code) ? known : fresh).push(item);
    }
    return { fresh, known };
  }

  /* The vault row for an accepted item. Tagged `hq` so a user can find, and a
   * later version can remove, everything that came from this source. */
  function toPresetRow(item) {
    return {
      kind: 'preset',
      code: item.code,
      weapon: item.weapon,
      mode: item.mode,
      author: item.author,
      source: 'hq',
      notes: item.title,
      tags: ['hq'].concat(item.tags || []),
    };
  }

  function plausiblePrice(value) {
    const price = Number(value);
    return Number.isInteger(price) && price >= MIN_PRICE && price <= MAX_PRICE ? price : 0;
  }

  /* An API response body → { CODE: price }. The response is walked
   * structurally rather than by one fixed path: any object that carries both a
   * share code (`gun_code` or `code`) and a plausible `price` contributes. That
   * keeps working if HQ nests the list differently, and it never needs the
   * request, which is where the player's session lives. Warfare builds come
   * back with price -1 (no purchase cost) and fail the range check, as does
   * anything that is a parsing accident rather than a price. The body is
   * untrusted: it crossed from a third-party page through two message hops. */
  function sanitizePrices(body) {
    const out = {};
    let visited = 0;
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 6 || visited > 5000) return;
      visited += 1;
      if (Array.isArray(node)) { for (const child of node.slice(0, MAX_ITEMS)) walk(child, depth + 1); return; }
      const code = extractCode(node.gun_code) || extractCode(node.code);
      const price = plausiblePrice(node.price);
      if (code && price && Object.keys(out).length < MAX_ITEMS) out[code] = price;
      for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value, depth + 1);
    };
    walk(body, 0);
    return out;
  }

  /* Fold freshly seen prices into the stored map, newest wins, capped so a
   * long-lived install cannot grow it without bound. */
  function mergePrices(stored, fresh, now) {
    const at = text(now) || new Date().toISOString();
    const next = {};
    for (const [code, row] of Object.entries(stored || {})) {
      if (CODE_RE.test(code) && row && Number(row.price) > 0) next[code] = { price: Number(row.price), seen_at: text(row.seen_at) };
    }
    for (const [code, price] of Object.entries(fresh || {})) next[code] = { price, seen_at: at };
    const codes = Object.keys(next).sort((a, b) => String(next[b].seen_at).localeCompare(String(next[a].seen_at)));
    const capped = {};
    for (const code of codes.slice(0, MAX_ITEMS)) capped[code] = next[code];
    return capped;
  }

  const api = {
    HQ_PAGE_URL,
    HQ_ORIGIN,
    SOURCES,
    MODE_BY_HQ,
    CODE_RE,
    MIN_PRICE,
    MAX_PRICE,
    extractCode,
    parseSchemeFile,
    normalizeSchemes,
    planImport,
    toPresetRow,
    sanitizePrices,
    mergePrices,
  };
  root.DFRedeemHQ = api;
  }(typeof globalThis !== 'undefined' ? globalThis : this));

const SETTINGS_KEY = DFRedeemSync.SETTINGS_KEY;
/* Shared across every surface, unlike the per-origin IndexedDB vaults. */
const HISTORY_KEY = 'df_redeem_history_mirror';
const HISTORY_CAP = 500;
/* Panel-owned scratch state the worker only stores and hands back. Keeping the
 * allowed keys explicit stops the bridge from becoming a general storage API
 * that any page script could write settings through. */
const PANEL_STATE_KEYS = { costsLocal: 'df_redeem_costs_local' };

/* ── HQ recommended codes ───────────────────────────────────────────────── */
/* Prices hq-capture.js read on the HQ page. Local only: they are shown next to
 * a build and never reach the community vault. */
const HQ_PRICES_KEY = 'df_redeem_hq_prices';
const HQ_FETCH_TIMEOUT_MS = 20000;
const HQ_PAGE_PREFIX = DFRedeemHQ.HQ_ORIGIN + '/events/hq/';

async function fetchHqSource(source) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), HQ_FETCH_TIMEOUT_MS) : null;
  try {
    /* credentials: 'omit' keeps the player's playdeltaforce.com session
     * cookies off the request; the files are public and need none. */
    const res = await fetch(source.url, {
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : 0));
    const groups = DFRedeemHQ.parseSchemeFile(await res.text(), source.varName);
    return DFRedeemHQ.normalizeSchemes(groups, source.mode);
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('quá thời gian chờ');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readHqPrices() {
  const got = await chrome.storage.local.get(HQ_PRICES_KEY);
  /* Re-validated on every read: storage outlives the code that wrote it. */
  return DFRedeemHQ.mergePrices(got[HQ_PRICES_KEY] || {}, {}, '');
}

async function hqFetch() {
  const settled = await Promise.all(DFRedeemHQ.SOURCES.map((source) => fetchHqSource(source).then(
    (items) => ({ source, items }),
    (error) => ({ source, error: String(error && error.message || error) }),
  )));
  const items = [];
  const seen = new Set();
  const failed = [];
  for (const result of settled) {
    if (result.error) { failed.push({ mode: result.source.mode, error: result.error }); continue; }
    for (const item of result.items) {
      if (seen.has(item.code)) continue;
      seen.add(item.code);
      items.push(item);
    }
  }
  if (!items.length) {
    const why = failed.map((f) => f.mode + ': ' + f.error).join('; ') || 'HQ không có mã nào';
    return { ok: false, error: 'Không tải được mã HQ — ' + why, items: [], prices: {}, failed };
  }
  const stored = await readHqPrices();
  const prices = {};
  for (const item of items) if (stored[item.code]) prices[item.code] = stored[item.code].price;
  return { ok: true, items, prices, failed };
}

/* Only hq-bridge.js on the HQ page may report prices. The redeem-page bridge
 * relays any op its page asks for, so the sender URL is what tells them apart. */
async function hqSavePrices(payload, sender) {
  const from = sender && typeof sender.url === 'string' ? sender.url : '';
  if (from.indexOf(HQ_PAGE_PREFIX) !== 0) return { ok: false, error: 'Nguồn giá HQ không hợp lệ.' };
  const fresh = DFRedeemHQ.sanitizePrices(payload && payload.items);
  const saved = Object.keys(fresh).length;
  if (!saved) return { ok: true, saved: 0 };
  const got = await chrome.storage.local.get(HQ_PRICES_KEY);
  await chrome.storage.local.set({
    [HQ_PRICES_KEY]: DFRedeemHQ.mergePrices(got[HQ_PRICES_KEY] || {}, fresh, new Date().toISOString()),
  });
  return { ok: true, saved };
}

function service() {
  return DFRedeemSync.createSyncService({ chromeApi: chrome, fetchFn: (...a) => fetch(...a) });
}

/* Map the options-page vocabulary onto sync.js's stored schema. */
function fromUi(patch, current) {
  const next = { ...current };
  if (patch.enabled !== undefined || patch.backend !== undefined) {
    const backend = patch.backend || (current.syncBackend === 'none' ? 'chrome-sync' : current.syncBackend);
    const enabled = patch.enabled === undefined ? current.syncBackend !== 'none' : patch.enabled;
    next.syncBackend = enabled ? backend : 'none';
  }
  if (patch.endpoint !== undefined) next.syncEndpoint = patch.endpoint;
  if (patch.token !== undefined) next.syncToken = patch.token;
  if (patch.autoSync !== undefined) next.autoSyncMinutes = patch.autoSync ? 15 : 0;
  return next;
}

function toUi(settings) {
  return {
    enabled: settings.syncBackend !== 'none',
    backend: settings.syncBackend === 'none' ? 'chrome-sync' : settings.syncBackend,
    endpoint: settings.syncEndpoint || '',
    autoSync: Number(settings.autoSyncMinutes || 0) > 0,
    hasToken: Boolean(settings.syncToken),
  };
}

async function handleSync(op, payload, sender) {
  /* HQ ops need neither sync settings nor the token, so they run before the
   * settings read. */
  if (op === 'hqFetch') return hqFetch();
  if (op === 'hqPrices') return hqSavePrices(payload, sender);
  /* Read-only: the cards show the stored HQ price while a build has no
   * measured cost. Nothing here writes or reaches the network. */
  if (op === 'hqReadPrices') return { ok: true, prices: await readHqPrices() };
  const svc = service();
  const stored = await svc.getLocal({ [SETTINGS_KEY]: DFRedeemSync.DEFAULT_SETTINGS });
  const current = { ...DFRedeemSync.DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };

  if (op === 'getSettings') return toUi(current);
  if (op === 'setSettings') {
    /* saveSettings voids the stored status when the destination moves, so the
     * old destination's error stops showing on every surface the moment the
     * new one is saved. */
    const { moved } = await svc.saveSettings(fromUi(payload || {}, current));
    return { ok: true, moved };
  }
  if (op === 'status') return svc.status();

  /* ── community vault ─────────────────────────────────────────────────────
   * Network access lives here rather than in the drawer: the service worker has
   * the host permissions, and the Garena page's CSP would block these fetches. */
  if (op === 'communityPull') {
    const result = await svc.fetchCommunity(current);
    if (!result.ok) return { ok: false, error: result.error || result.skipped || 'không tải được' };
    return { ok: true, codes: result.codes, presets: result.presets };
  }
  if (op === 'communityPush') {
    const rows = (payload && payload.rows) || [];
    const result = await svc.reportOutcomes(rows, current);
    return {
      ok: Boolean(result.ok),
      sent: Number(result.sent || 0),
      failed: Number(result.failed || 0),
      needed: Number(result.needed || 0),
      skipped: result.skipped || null,
      error: result.error || (result.failures && result.failures[0]) || null,
    };
  }
  /* Equipment costs ride the same channel and for the same reason live here:
   * the drawer's page CSP would block the fetch, the service worker's would not. */
  if (op === 'fetchCosts') {
    const result = await svc.fetchCosts(current);
    if (!result.ok) return { ok: false, error: result.error || result.skipped || 'không tải được', costs: {} };
    return { ok: true, costs: result.costs, count: Number(result.count || 0) };
  }
  if (op === 'reportCost') {
    const result = await svc.reportCost((payload && payload.code) || '', payload && payload.cost, payload && payload.mode, current);
    return {
      ok: Boolean(result.ok),
      cost: Number(result.cost || 0),
      state: result.state || null,
      reports: Number(result.reports || 0),
      unchanged: Boolean(result.unchanged),
      skipped: result.skipped || null,
      error: result.error || null,
    };
  }

  /* ── cross-origin history mirror ─────────────────────────────────────────
   * The drawer runs on the Garena origin and the app/popup on
   * chrome-extension://, and IndexedDB is per-origin: a run done in the drawer
   * was invisible to the full-page History. chrome.storage.local is shared by
   * every surface, so the panel mirrors each finished attempt here and the
   * other surfaces merge it in. Capped so the quota cannot be exhausted. */
  if (op === 'mirrorAttempts') {
    const rows = (payload && payload.rows) || [];
    if (!rows.length) return { ok: true, stored: 0 };
    const bag = await svc.getLocal({ [HISTORY_KEY]: [] });
    const seen = new Set();
    const merged = [];
    for (const r of [...rows, ...(bag[HISTORY_KEY] || [])]) {
      if (!r || !r.code) continue;
      const k = String(r.code).toUpperCase() + '|' + (r.timestamp || '');
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(r);
      if (merged.length >= HISTORY_CAP) break;
    }
    await svc.setLocal({ [HISTORY_KEY]: merged });
    return { ok: true, stored: merged.length };
  }
  if (op === 'readMirror') {
    const bag = await svc.getLocal({ [HISTORY_KEY]: [] });
    return { ok: true, rows: bag[HISTORY_KEY] || [] };
  }
  /* The panel keeps its own unsynced state (costs entered here but not yet
   * agreed by the vault) and cannot reach chrome.storage from the MAIN world,
   * so the worker stores it under a namespaced key on the panel's behalf. */
  if (op === 'getPanelState') {
    const key = PANEL_STATE_KEYS[(payload && payload.key) || ''];
    if (!key) return { ok: false, error: 'Khoá không hợp lệ.' };
    const bag = await svc.getLocal({ [key]: null });
    return { ok: true, value: bag[key] };
  }
  if (op === 'setPanelState') {
    const key = PANEL_STATE_KEYS[(payload && payload.key) || ''];
    if (!key) return { ok: false, error: 'Khoá không hợp lệ.' };
    await svc.setLocal({ [key]: (payload && payload.value) || null });
    return { ok: true };
  }
  if (op === 'push' || op === 'test') {
    if (current.syncBackend === 'none') return { ok: false, error: 'Đồng bộ đang tắt.' };
    const records = op === 'test' ? [] : ((payload && payload.records) || []);
    const status = await svc.syncNow(records);
    return { ok: status.state === 'ok', status, error: status.error || null };
  }
  if (op === 'export') {
    const bag = await chrome.storage.sync.get(null).catch(() => ({}));
    return { ok: true, data: bag };
  }
  if (op === 'wipe') {
    await chrome.storage.sync.clear().catch(() => {});
    await chrome.storage.local.remove(SETTINGS_KEY);
    return { ok: true };
  }
  return { ok: false, error: 'Lệnh không hợp lệ: ' + op };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== 'DF_REDEEM_SYNC') return false;
  handleSync(msg.op, msg.payload, sender)
    .then((result) => respond(result))
    .catch((error) => respond({ ok: false, error: DFRedeemSync.friendlyError(error).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]') }));
  return true; /* keep the channel open for the async reply */
});

/* With a popup attached to the toolbar icon, chrome.action.onClicked never
 * fires — the popup owns the click. Opening the in-page drawer therefore moves
 * here, triggered by the popup's "mở bảng trên tab này" button. */
async function openDrawerOnTab(tab) {
  if (!tab || !tab.id) return { ok: false, error: 'Không có tab.' };
  if (!/^https:\/\/redeem\.df\.garena\.sg\//.test(tab.url || '')) {
    await chrome.tabs.create({ url: 'https://redeem.df.garena.sg/vi/cdkgarena.html' });
    return { ok: true, opened: 'new-tab' };
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'DF_REDEEM_OPEN' });
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'], world: 'MAIN' });
    await chrome.tabs.sendMessage(tab.id, { type: 'DF_REDEEM_OPEN' });
  }
  return { ok: true, opened: 'drawer' };
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || msg.type !== 'DF_REDEEM_OPEN_DRAWER') return false;
  chrome.tabs.query({ active: true, currentWindow: true })
    .then((tabs) => openDrawerOnTab(tabs && tabs[0]))
    .then(respond)
    .catch((e) => respond({ ok: false, error: String(e && e.message || e) }));
  return true;
});
