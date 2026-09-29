/* Delta Force Auto Redeem v3.2.0
 * Built v3.2.0 — local build, no remote source
 *
 * Verifies every redeem against the network response body, never the popup.
 * No telemetry, no remote code, no credential access. Runs only on
 * redeem.df.garena.sg pages you already opened and logged into.
 */
/* Headless controller: no UI. Exposes window.__dfRedeem for a driver that
 * polls state between short evaluate calls. */
(function dfRedeemHeadless() {
  'use strict';
  const root = window;
  if (root.__dfRedeem && root.__dfRedeem.version === '3.2.0') return 'already-installed';
/* schema.js — IndexedDB schema, record normalization, and migrations. */
var DFRedeemSchema = (function dfRedeemSchemaModule(root) {
  'use strict';

  const DB_NAME = 'df-redeem-vault';
  const DB_VERSION = 5;
  const STORES = Object.freeze({
    codes: 'codes',
    runs: 'runs',
    results: 'results',
    presets: 'presets',
    meta: 'meta',
  });
  const KINDS = Object.freeze(['giftcode', 'preset']);
  /* `mine` was one bucket for two different facts, and the difference is the
   * whole answer to "why can my friend redeem this and I cannot?":
   *   - `mine`        — THIS code was already redeemed by this account (400069)
   *   - `group_limit` — this account hit the reward GROUP cap (400067); the code
   *                     itself is alive and another account can still use it
   * `sys_error` isolates Garena-side error 51 / transient failures so they stop
   * hiding inside `untried`: they are not a verdict, they are "ask again later".
   */
  const STATUSES = Object.freeze(['untried', 'success', 'expired', 'exhausted', 'mine', 'group_limit', 'sys_error', 'gift_bug', 'invalid']);
  const PRESET_FORMATS = Object.freeze(['base32-21', 'numeric-19']);
  const SECRET_KEYS = /^(?:access_?token|refresh_?token|session_?token|token|cookie|cookies|authorization|auth|auth_?headers?|headers)$/i;

  function text(value, fallback) {
    return value == null ? (fallback || '') : String(value);
  }

  function normalizeCode(value, kind) {
    const clean = text(value).normalize('NFKC')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/[\u00A0\s]+/g, '')
      .trim();
    return clean;
  }

  function normalizeTags(value) {
    const values = Array.isArray(value) ? value : text(value).split(/[|;,]/);
    const seen = new Set();
    return values.map((tag) => text(tag).trim()).filter((tag) => {
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function inferPresetFormat(code) {
    if (/^\d{19}$/.test(code)) return 'numeric-19';
    if (/^[A-Z0-9]{21}$/i.test(code)) return 'base32-21';
    return '';
  }

  function status(value) {
    const normalized = text(value, 'untried').toLowerCase();
    return STATUSES.includes(normalized) ? normalized : 'untried';
  }

  function codeRecord(input, now) {
    const row = input || {};
    const kind = row.kind === 'preset' ? 'preset' : 'giftcode';
    const code = normalizeCode(row.code, kind);
    if (!code) throw new TypeError('Code is required');
    const timestamp = text(row.first_seen || now || new Date().toISOString());
    return {
      key: kind === 'giftcode' ? `gift:${code.toUpperCase()}` : `preset:${code}`,
      code,
      kind,
      status: status(row.status),
      family: text(row.family || row.group),
      group: text(row.group || row.family),
      source: text(row.source),
      item_hint: text(row.item_hint || row.hint),
      first_seen: timestamp,
      last_tried: text(row.last_tried),
      attempt_count: Math.max(0, Number(row.attempt_count) || 0),
      result_msg: text(row.result_msg || row.msg),
      err_code: row.err_code == null ? (row.err == null ? null : row.err) : row.err_code,
      variant_used: text(row.variant_used),
      shareable: Boolean(row.shareable),
      notes: text(row.notes),
      tags: normalizeTags(row.tags),
    };
  }

  function presetRecord(input, now) {
    const row = input || {};
    const code = normalizeCode(row.code, 'preset');
    if (!code) throw new TypeError('Preset code is required');
    const format = PRESET_FORMATS.includes(row.format) ? row.format : inferPresetFormat(code);
    if (!format) throw new TypeError(`Unsupported preset code format: ${code}`);
    return {
      code,
      weapon: text(row.weapon || row.item_hint),
      mode: text(row.mode),
      author: text(row.author),
      format,
      verified: Boolean(row.verified),
      /* Equipment cost is optional and community-measured, so it is carried only
       * when present and always with its agreement state. Writing a 0 here would
       * make an unpriced build look free; omitting the key lets the UI say "no
       * one has measured this yet", which is the truth. */
      ...(Number(row.cost) > 0
        ? { cost: Number(row.cost), cost_state: text(row.cost_state) || 'unconfirmed' }
        : {}),
      first_seen: text(row.first_seen || now || new Date().toISOString()),
    };
  }

  function publicRecord(input) {
    const out = {};
    for (const [key, value] of Object.entries(input || {})) {
      if (!SECRET_KEYS.test(key)) out[key] = value;
    }
    return out;
  }

  function ensureIndex(store, name, keyPath, options) {
    if (!store.indexNames || !store.indexNames.contains || !store.indexNames.contains(name)) {
      store.createIndex(name, keyPath, options || {});
    }
  }

  function upgradeDatabase(db, oldVersion, newVersion, transaction) {
    function ensureStore(name, options) {
      if (db.objectStoreNames.contains(name)) return transaction && transaction.objectStore(name);
      return db.createObjectStore(name, options);
    }

    if (oldVersion < 1) {
      const codes = ensureStore(STORES.codes, { keyPath: 'key' });
      ensureIndex(codes, 'kind', 'kind');
      ensureIndex(codes, 'status', 'status');
      ensureIndex(codes, 'family', 'family');
      ensureIndex(codes, 'code', 'code');
      ensureStore(STORES.runs, { keyPath: 'id' });
      const results = ensureStore(STORES.results, { keyPath: 'id', autoIncrement: true });
      ensureIndex(results, 'run_id', 'run_id');
      ensureIndex(results, 'code_key', 'code_key');
      ensureIndex(results, 'timestamp', 'timestamp');
      ensureStore(STORES.presets, { keyPath: 'code' });
      ensureStore(STORES.meta, { keyPath: 'key' });
    }
    if (oldVersion >= 1 && oldVersion < 2) {
      const results = ensureStore(STORES.results, { keyPath: 'id', autoIncrement: true });
      ensureIndex(results, 'code_key', 'code_key');
      ensureIndex(results, 'run_id', 'run_id');
      ensureIndex(results, 'timestamp', 'timestamp');
    }
    /* v3 stores the same schema; it triggers Vault.init() to correct exactly the
     * legacy 400069 rows that older builds called `exhausted`.
     * v5 likewise only bumps the version so init() can split the overloaded
     * `mine` bucket into `mine` + `group_limit`. */
    return newVersion;
  }

  const api = {
    DB_NAME,
    DB_VERSION,
    STORES,
    KINDS,
    STATUSES,
    PRESET_FORMATS,
    normalizeCode,
    normalizeTags,
    inferPresetFormat,
    codeRecord,
    presetRecord,
    publicRecord,
    upgradeDatabase,
  };
  root.DFRedeemSchema = api;
  return api;
}(typeof window !== 'undefined' ? window : globalThis));

/* vault.js — persistent code library backed by IndexedDB. */
var DFRedeemVault = (function dfRedeemVaultModule(root) {
  'use strict';

  const Schema = root.DFRedeemSchema || (typeof require === 'function' ? require('./schema.js') : null);
  if (!Schema) throw new Error('DFRedeemSchema must be loaded before DFRedeemVault');
  const { DB_NAME, DB_VERSION, STORES, STATUSES } = Schema;

  function clone(value) {
    if (value == null) return value;
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function csvEscape(value) {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function parseCSVRows(input) {
    const text = String(input == null ? '' : input).replace(/^\ufeff/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
        else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === ',') { row.push(cell); cell = ''; }
      else if (char === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += char;
    }
    row.push(cell.replace(/\r$/, ''));
    if (row.some((value) => value !== '') || rows.length === 0) rows.push(row);
    return rows;
  }

  function parseCSV(input) {
    const rows = parseCSVRows(input);
    if (rows.length < 2) return [];
    const headers = rows[0].map((header) => header.trim());
    return rows.slice(1).filter((row) => row.some(Boolean)).map((row) => {
      const record = {};
      headers.forEach((header, index) => { record[header] = row[index] == null ? '' : row[index]; });
      if (typeof record.tags === 'string') record.tags = record.tags ? record.tags.split('|') : [];
      if (record.shareable !== undefined) record.shareable = /^(?:1|true|yes)$/i.test(record.shareable);
      if (record.verified !== undefined) record.verified = /^(?:1|true|yes)$/i.test(record.verified);
      if (record.attempt_count !== undefined) record.attempt_count = Number(record.attempt_count) || 0;
      if (record.err_code === '') record.err_code = null;
      return record;
    });
  }

  function parseJSON(input) {
    const data = typeof input === 'string' ? JSON.parse(input) : clone(input);
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') throw new TypeError('JSON import must be an array or object');
    return [...(Array.isArray(data.codes) ? data.codes : []), ...(Array.isArray(data.presets) ? data.presets : [])];
  }

  function parsePresetLine(line, defaults) {
    const match = String(line).trim().match(/^(.*)-(.*)-([A-Za-z0-9]{21}|\d{19})$/);
    if (!match) return null;
    const code = match[3];
    const format = Schema.inferPresetFormat(code);
    if (!format) return null;
    return Schema.presetRecord({
      code,
      weapon: match[1].trim(),
      mode: match[2].trim(),
      author: defaults && defaults.author,
      verified: defaults && defaults.verified,
      format,
      source: defaults && defaults.source,
    }, defaults && defaults.now);
  }

  function splitConcatenatedLine(value, knownCodes) {
    const original = Schema.normalizeCode(value, 'giftcode');
    const vocabulary = new Map();
    for (const known of knownCodes || []) {
      const normalized = Schema.normalizeCode(typeof known === 'string' ? known : known.code, 'giftcode');
      if (normalized) vocabulary.set(normalized.toUpperCase(), normalized);
    }
    const upper = original.toUpperCase();
    if (!upper || vocabulary.size === 0 || vocabulary.has(upper) || upper.length < 8) return [original];
    const memo = new Map();
    function walk(start) {
      if (start === upper.length) return [];
      if (memo.has(start)) return memo.get(start);
      const matches = [...vocabulary.keys()]
        .filter((candidate) => upper.startsWith(candidate, start))
        .sort((a, b) => b.length - a.length);
      for (const candidate of matches) {
        const rest = walk(start + candidate.length);
        if (rest) {
          const result = [vocabulary.get(candidate), ...rest];
          memo.set(start, result);
          return result;
        }
      }
      memo.set(start, null);
      return null;
    }
    const result = walk(0);
    return result && result.length > 1 ? result : [original];
  }

  function parsePaste(input, options) {
    const opts = options || {};
    const blocks = String(input == null ? '' : input).replace(/\r/g, '').trim().split(/\n\s*\n+/);
    const output = { codes: [], presets: [], invalid: [], blocks: [] };
    for (const blockText of blocks) {
      const lines = blockText.split('\n').map((line) => line.trim()).filter(Boolean);
      if (!lines.length) continue;
      const presetRows = lines.map((line) => parsePresetLine(line, opts));
      const isPresetBlock = presetRows.every(Boolean);
      output.blocks.push({ format: isPresetBlock ? 'preset' : 'giftcode', line_count: lines.length });
      if (isPresetBlock) {
        output.presets.push(...presetRows);
        continue;
      }
      for (const line of lines) {
        const cells = line.split(/[\t,;|\s]+/).filter(Boolean);
        for (const cell of cells) {
          const pieces = splitConcatenatedLine(cell, opts.knownCodes);
          for (const code of pieces) {
            if (/^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/.test(code)) {
              output.codes.push(Schema.codeRecord({ code, kind: 'giftcode', source: opts.source }, opts.now));
            } else output.invalid.push(cell);
          }
        }
      }
    }
    return output;
  }

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  function transactionPromise(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
  }

  class IndexedDBAdapter {
    constructor(options) {
      const opts = options || {};
      this.indexedDB = opts.indexedDB || root.indexedDB;
      this.name = opts.name || DB_NAME;
      this.version = opts.version || DB_VERSION;
      this.db = null;
    }

    async open() {
      if (this.db) return this;
      if (!this.indexedDB) throw new Error('IndexedDB is not available');
      const request = this.indexedDB.open(this.name, this.version);
      request.onupgradeneeded = (event) => Schema.upgradeDatabase(
        request.result,
        event.oldVersion,
        event.newVersion,
        request.transaction,
      );
      this.db = await requestPromise(request);
      this.db.onversionchange = () => { this.db.close(); this.db = null; };
      return this;
    }

    async get(store, key) {
      await this.open();
      return requestPromise(this.db.transaction(store, 'readonly').objectStore(store).get(key));
    }

    async getAll(store) {
      await this.open();
      return requestPromise(this.db.transaction(store, 'readonly').objectStore(store).getAll());
    }

    async put(store, value) {
      await this.open();
      const tx = this.db.transaction(store, 'readwrite');
      const result = await requestPromise(tx.objectStore(store).put(clone(value)));
      await transactionPromise(tx);
      return result;
    }

    async add(store, value) {
      await this.open();
      const tx = this.db.transaction(store, 'readwrite');
      const result = await requestPromise(tx.objectStore(store).add(clone(value)));
      await transactionPromise(tx);
      return result;
    }

    async delete(store, key) {
      await this.open();
      const tx = this.db.transaction(store, 'readwrite');
      await requestPromise(tx.objectStore(store).delete(key));
      await transactionPromise(tx);
    }
  }

  class MemoryAdapter {
    constructor(options) {
      this.version = options && options.version ? options.version : DB_VERSION;
      this.stores = new Map();
      this.counters = new Map();
      Object.values(STORES).forEach((name) => this.stores.set(name, new Map()));
    }
    async open() { return this; }
    key(store, value) {
      if (store === STORES.codes) return value.key;
      if (store === STORES.presets) return value.code;
      if (store === STORES.meta) return value.key;
      if (store === STORES.runs) return value.id;
      if (value.id != null) return value.id;
      const id = (this.counters.get(store) || 0) + 1;
      this.counters.set(store, id);
      return id;
    }
    async get(store, key) { return clone(this.stores.get(store).get(key)); }
    async getAll(store) { return [...this.stores.get(store).values()].map(clone); }
    async put(store, value) {
      const item = clone(value);
      const key = this.key(store, item);
      if (item.id == null && store === STORES.results) item.id = key;
      this.stores.get(store).set(key, item);
      return key;
    }
    async add(store, value) { return this.put(store, value); }
    async delete(store, key) { this.stores.get(store).delete(key); }
  }

  class Vault {
    constructor(options) {
      const opts = options || {};
      this.adapter = opts.adapter || new IndexedDBAdapter(opts);
      this.clock = opts.clock || (() => new Date().toISOString());
      this.seed = opts.seed;
      this.seedUrl = opts.seedUrl || null;
      this.seedVersion = opts.seedVersion || 1;
    }

    async init() {
      await this.adapter.open();
      await this.migrateLegacyUsedStatus();
      await this.migrateCasingAmbiguousInvalids();
      await this.migrateGroupLimitOutOfMine();
      await this.seedOnFirstRun();
      return this;
    }

    /* Older releases mistakenly persisted Garena 400069 (this account already
     * used the code) as global-looking `exhausted`. Correct only that exact
     * legacy pair; real exhausted outcomes, if any, are left untouched. */
    async migrateLegacyUsedStatus() {
      const marker = await this.adapter.get(STORES.meta, 'migrate_used_400069_v1');
      if (marker) return { migrated: 0, skipped: true };
      let migrated = 0;
      for (const row of await this.adapter.getAll(STORES.codes)) {
        if (row && row.status === 'exhausted' && Number(row.err_code) === 400069) {
          await this.adapter.put(STORES.codes, { ...row, status: 'mine' });
          migrated += 1;
        }
      }
      await this.adapter.put(STORES.meta, { key: 'migrate_used_400069_v1', migrated, migrated_at: this.clock() });
      return { migrated, skipped: false };
    }

    async migrateCasingAmbiguousInvalids() {
      const marker = await this.adapter.get(STORES.meta, 'migrate_invalid_400054_v1');
      if (marker) return { migrated: 0, skipped: true };
      let migrated = 0;
      for (const row of await this.adapter.getAll(STORES.codes)) {
        /* 400054 can be caused by a casing variant, so it is no longer a trusted
         * global outcome. Keep the submitted spelling/history, but make it
         * retryable locally rather than silently skipping a usable code. */
        if (row && row.status === 'invalid' && Number(row.err_code) === 400054) {
          await this.adapter.put(STORES.codes, {
            ...row,
            status: 'untried',
            err_code: 0,
            result_msg: '',
            shareable: false,
          });
          migrated += 1;
        }
      }
      await this.adapter.put(STORES.meta, { key: 'migrate_invalid_400054_v1', migrated, migrated_at: this.clock() });
      return { migrated, skipped: false };
    }

    /* `mine` used to absorb both 400069 (this account redeemed THIS code) and
     * 400067 (this account hit the reward GROUP cap). Only the first is a fact
     * about the code; the second leaves the code perfectly usable by someone
     * else, which is exactly the case a user hits when a friend redeems a code
     * they cannot. Split the 400067 rows out so the UI can tell the truth. */
    async migrateGroupLimitOutOfMine() {
      const marker = await this.adapter.get(STORES.meta, 'migrate_group_limit_400067_v1');
      if (marker) return { migrated: 0, skipped: true };
      let migrated = 0;
      for (const row of await this.adapter.getAll(STORES.codes)) {
        if (row && row.status === 'mine' && Number(row.err_code) === 400067) {
          await this.adapter.put(STORES.codes, { ...row, status: 'group_limit' });
          migrated += 1;
        }
      }
      await this.adapter.put(STORES.meta, { key: 'migrate_group_limit_400067_v1', migrated, migrated_at: this.clock() });
      return { migrated, skipped: false };
    }

    async seedOnFirstRun(seedOverride) {
      const marker = await this.adapter.get(STORES.meta, 'seed_version');
      let seed = seedOverride || this.seed;
      if (!seed && this.seedUrl && typeof fetch === 'function') {
        const response = await fetch(this.seedUrl);
        if (!response.ok) throw new Error(`Unable to load seed: HTTP ${response.status}`);
        seed = await response.json();
      }
      if (!seed) return { imported: 0, skipped: true };
      /* Compare against the SEED's own version, not the constructor default:
       * callers rarely pass seedVersion, so using it here meant a shipped seed
       * bump never reached an existing install. */
      const target = Number(seed.version || this.seedVersion);
      if (marker && Number(marker.value) >= target) return { imported: 0, skipped: true };
      const result = await this.importJSON(seed);
      await this.adapter.put(STORES.meta, { key: 'seed_version', value: target, imported_at: this.clock() });
      return result;
    }

    async upsert(raw) {
      const now = this.clock();
      const kind = raw.kind === 'preset' || raw.weapon || raw.mode || raw.format ? 'preset' : 'giftcode';
      if (kind === 'preset') {
        const preset = Schema.presetRecord({ ...raw, kind }, now);
        const key = `preset:${preset.code}`;
        const existing = await this.adapter.get(STORES.codes, key);
        const code = Schema.codeRecord({ ...existing, ...raw, code: preset.code, kind: 'preset', item_hint: raw.item_hint || preset.weapon }, now);
        code.first_seen = existing && existing.first_seen ? existing.first_seen : code.first_seen;
        await this.adapter.put(STORES.presets, preset);
        await this.adapter.put(STORES.codes, code);
        return { record: code, inserted: !existing };
      }
      const normalized = Schema.codeRecord({ ...raw, kind: 'giftcode' }, now);
      const existing = await this.adapter.get(STORES.codes, normalized.key);
      const submittedCode = normalized.code;
      const canRestoreOriginalCase = existing
        && existing.code === String(existing.code || '').toUpperCase()
        && submittedCode !== submittedCode.toUpperCase()
        && existing.status === 'invalid'
        && Number(existing.err_code) === 400054;
      /* The IndexedDB key is always uppercase, but the value is the exact text
       * sent to Garena. Legacy builds had already uppercased every value; when a
       * mixed-case source later supplies a spelling for a 400054 record, restore
       * it so the code can be retried rather than preserving the bad request. */
      const merged = Schema.codeRecord({
        ...existing,
        ...raw,
        code: canRestoreOriginalCase ? submittedCode : (existing && existing.code ? existing.code : submittedCode),
        kind: 'giftcode',
      }, now);
      merged.first_seen = existing && existing.first_seen ? existing.first_seen : normalized.first_seen;
      await this.adapter.put(STORES.codes, merged);
      return { record: merged, inserted: !existing };
    }

    async importRecords(records) {
      let imported = 0;
      let updated = 0;
      for (const record of records) {
        const result = await this.upsert(record);
        if (result.inserted) imported += 1;
        else updated += 1;
      }
      return { imported, updated, total: records.length };
    }

    async importPaste(text, options) {
      const existing = await this.adapter.getAll(STORES.codes);
      const parsed = parsePaste(text, { ...(options || {}), knownCodes: existing.filter((row) => row.kind === 'giftcode') });
      const result = await this.importRecords([...parsed.codes, ...parsed.presets.map((row) => ({ ...row, kind: 'preset' }))]);
      return { ...result, invalid: parsed.invalid, blocks: parsed.blocks };
    }
    async importCSV(text) { return this.importRecords(parseCSV(text)); }
    async importJSON(value) { return this.importRecords(parseJSON(value)); }

    async all() { return (await this.adapter.getAll(STORES.codes)).sort((a, b) => a.code.localeCompare(b.code)); }
    async byStatus(value) { return (await this.all()).filter((row) => row.status === value); }
    async byKind(value) { return (await this.all()).filter((row) => row.kind === value); }

    /* Preset rows live in two stores: the code row carries status/history, the
     * preset row carries weapon/mode/format. Callers that display presets want
     * both halves, so join them here rather than at every call site. */
    async presets() {
      const details = new Map((await this.adapter.getAll(STORES.presets)).map((row) => [row.code, row]));
      return (await this.byKind('preset')).map((row) => {
        const extra = details.get(row.code) || {};
        return {
          ...row,
          weapon: extra.weapon || row.item_hint || '',
          mode: extra.mode || '',
          author: extra.author || '',
          format: extra.format || '',
          verified: extra.verified === true,
          /* Equipment cost lives on the preset half of the join, so carry it
           * through explicitly — a spread of `row` alone would silently drop it
           * and the UI would show "—" for every seeded cost. */
          ...(Number(extra.cost) > 0
            ? { cost: Number(extra.cost), cost_state: extra.cost_state || 'unconfirmed' }
            : {}),
        };
      });
    }
    async byFamily(value) { return (await this.all()).filter((row) => row.family === value || row.group === value); }
    async search(substring) {
      const needle = String(substring == null ? '' : substring).toLocaleLowerCase();
      return (await this.all()).filter((row) => [row.code, row.family, row.group, row.source, row.item_hint, row.notes, ...(row.tags || [])]
        .some((value) => String(value || '').toLocaleLowerCase().includes(needle)));
    }
    async stats() {
      const rows = await this.all();
      const byStatus = Object.fromEntries(STATUSES.map((value) => [value, 0]));
      const byKind = { giftcode: 0, preset: 0 };
      rows.forEach((row) => { byStatus[row.status] += 1; byKind[row.kind] += 1; });
      return { total: rows.length, byStatus, byKind, shareable: rows.filter((row) => row.shareable).length };
    }
    async shareableList() { return (await this.all()).filter((row) => row.shareable); }

    async exportCSV() {
      const columns = ['code', 'kind', 'status', 'family', 'group', 'source', 'item_hint', 'first_seen', 'last_tried', 'attempt_count', 'result_msg', 'err_code', 'variant_used', 'shareable', 'notes', 'tags', 'weapon', 'mode', 'author', 'format', 'verified'];
      const presets = new Map((await this.adapter.getAll(STORES.presets)).map((row) => [row.code, row]));
      const lines = [columns.join(',')];
      for (const row of await this.all()) {
        const merged = Schema.publicRecord({ ...row, ...(row.kind === 'preset' ? presets.get(row.code) : {}) });
        lines.push(columns.map((column) => csvEscape(column === 'tags' ? (merged.tags || []).join('|') : merged[column])).join(','));
      }
      return `\ufeff${lines.join('\r\n')}`;
    }

    async exportJSON() {
      return JSON.stringify({
        version: 1,
        exported_at: this.clock(),
        codes: (await this.all()).map(Schema.publicRecord),
        presets: (await this.adapter.getAll(STORES.presets)).map(Schema.publicRecord),
      }, null, 2);
    }
    async exportShareList() { return (await this.shareableList()).map((row) => row.code).join('\n'); }

    async createRun(input) {
      const row = Schema.publicRecord(input || {});
      const id = row.id || `run-${this.clock()}-${Math.random().toString(36).slice(2, 10)}`;
      const run = { ...row, id, started_at: row.started_at || this.clock(), ended_at: row.ended_at || '', status: row.status || 'running' };
      await this.adapter.put(STORES.runs, run);
      return run;
    }

    async finishRun(id, patch) {
      const existing = await this.adapter.get(STORES.runs, id);
      if (!existing) throw new Error(`Unknown run: ${id}`);
      const run = { ...existing, ...Schema.publicRecord(patch || {}), id, ended_at: (patch && patch.ended_at) || this.clock() };
      await this.adapter.put(STORES.runs, run);
      return run;
    }

    async recordAttempt(codeValue, result, runId) {
      const raw = result || {};
      const kind = raw.kind === 'preset' ? 'preset' : 'giftcode';
      const code = Schema.normalizeCode(codeValue, kind);
      const key = kind === 'preset' ? `preset:${code}` : `gift:${code.toUpperCase()}`;
      const existing = await this.adapter.get(STORES.codes, key) || Schema.codeRecord({ code, kind }, this.clock());
      const submittedCode = code;
      const timestamp = raw.timestamp || raw.at || this.clock();
      const shouldRestoreOriginalCase = kind === 'giftcode'
        && submittedCode !== submittedCode.toUpperCase()
        && existing.status === 'invalid'
        && Number(existing.err_code) === 400054;
      const storedCode = shouldRestoreOriginalCase ? submittedCode : (existing.code || submittedCode);
      const status = STATUSES.includes(String(raw.status || '').toLowerCase()) ? String(raw.status).toLowerCase() : existing.status;
      const updated = Schema.codeRecord({
        ...existing,
        code: storedCode,
        status,
        last_tried: timestamp,
        attempt_count: existing.attempt_count + 1,
        result_msg: raw.result_msg || raw.msg || raw.detail || '',
        err_code: raw.err_code == null ? raw.errorCode : raw.err_code,
        variant_used: raw.variant_used || raw.redeemedAs || '',
      }, timestamp);
      await this.adapter.put(STORES.codes, updated);
      const historyRow = Schema.publicRecord({
        run_id: runId || raw.run_id || '',
        code_key: key,
        code: existing.code,
        kind,
        timestamp,
        status: updated.status,
        result_msg: updated.result_msg,
        err_code: updated.err_code,
        variant_used: updated.variant_used,
      });
      const id = await this.adapter.add(STORES.results, historyRow);
      return { ...historyRow, id };
    }

    async history(codeValue) {
      const needle = codeValue == null ? '' : Schema.normalizeCode(codeValue, 'giftcode').toUpperCase();
      return (await this.adapter.getAll(STORES.results))
        .filter((row) => !needle || String(row.code).toUpperCase() === needle)
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    }
  }

  const api = {
    Vault,
    IndexedDBAdapter,
    MemoryAdapter,
    parsePaste,
    parseCSV,
    parseJSON,
    parsePresetLine,
    splitConcatenatedLine,
    STATUSES,
    create: (options) => new Vault(options),
  };
  root.DFRedeemVault = api;
  return api;
}(typeof window !== 'undefined' ? window : globalThis));

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
        return { ok: false, sent: 0, failed: shareable.length, error: String(error && error.message || error) };
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
        return { ok: false, error: String((error && error.message) || error), costs: {} };
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
        return { ok: false, error: String((error && error.message) || error) };
      }
    }

    return { registerBackend, syncNow, status, getSettings, getLocal, setLocal, compactDelta, mergeDeltas, serializeExport, parseImport, publicSettings, fetchCommunity, reportOutcomes, mergeCommunityCodes, fetchCosts, reportCost, keys: { SETTINGS_KEY, RECORDS_KEY, STATUS_KEY, SYNC_DELTA_KEY, SYNC_MANIFEST_KEY, SYNC_CHUNK_PREFIX } };
  }

  /* mergeCommunityCodes is pure, so expose it at module level too: UI surfaces
   * need it without constructing a storage-backed service. */
  return { SETTINGS_KEY, RECORDS_KEY, STATUS_KEY, SYNC_DELTA_KEY, SYNC_MANIFEST_KEY, SYNC_CHUNK_PREFIX, DEFAULT_SETTINGS, compactDelta, mergeDeltas, deltaToRecords, publicSettings, serializeExport, parseImport, createSyncService, mergeCommunityCodes };
  };

  const api = factory();
  root.DFRedeemSync = api;
    return api;
}(typeof window !== 'undefined' ? window : globalThis));

/* codes.js — parse, normalize, dedup, and OCR-variant generation.
 * No DOM, no network. Pure functions so they are unit-testable in node. */

var DFRedeemCodes = (function dfRedeemCodesModule(root) {
  'use strict';

  const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;

/** Strip zero-width junk and NFKC-normalize, preserving case. */
function normalizeCode(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u00A0\s]+/g, '')
    .trim();
}

function isCode(value) {
  return CODE_RE.test(value);
}

/**
 * Detect a line that is several valid codes concatenated without a separator.
 * The web list had `MOILOOT45DFCRAFT427DFSIXVIP888ACESIXMAJOR`. If every piece of
 * a greedy longest-first split is a known candidate, the line is a joined run.
 * Returns an array of pieces, or null when the line is a single code.
 */
function splitJoinedRun(code, knownCodes) {
  if (!knownCodes || typeof knownCodes[Symbol.iterator] !== 'function') return null;
  const upper = code.toUpperCase();
  if (upper.length < 16) return null;
  if (/^6[A-Z0-9]{20}$/.test(upper)) return null;

  const sourceByUpper = new Map();
  const sourceValues = knownCodes instanceof Map
    ? knownCodes.values()
    : (knownCodes instanceof Set ? knownCodes.values() : knownCodes);
  for (const value of sourceValues) {
    const normalized = normalizeCode(value);
    if (isCode(normalized) && !sourceByUpper.has(normalized.toUpperCase())) sourceByUpper.set(normalized.toUpperCase(), normalized);
  }
  const vocabulary = sourceByUpper.size ? sourceByUpper : knownCodes;

  const memo = new Map();
  const walk = (start) => {
    if (start === upper.length) return [];
    if (memo.has(start)) return memo.get(start);
    let best = null;
    // Longest piece first so `MOILOOT45` wins over `MOILOOT4`.
    for (let end = Math.min(upper.length, start + 32); end > start + 3; end -= 1) {
      // The whole string is itself in the vocabulary (it was a valid-looking
      // line); using it as a piece would defeat the split.
      if (start === 0 && end === upper.length) continue;
      const piece = upper.slice(start, end);
      if (!vocabulary.has(piece)) continue;
      const rest = walk(end);
      if (rest === null) continue;
      best = [sourceByUpper.get(piece) || piece].concat(rest);
      break;
    }
    memo.set(start, best);
    return best;
  };

  const parts = walk(0);
  return parts && parts.length > 1 ? parts : null;
}

/**
 * Parse arbitrary user input into a clean queue.
 * Accepts newline / comma / semicolon / tab / space separated input, and the
 * `Item name-Series-CODE` shape used by the weapon-skin lists.
 */
function parseCodes(input, options) {
  const opts = options || {};
  const rawLines = String(input == null ? '' : input)
    .split(/[\r\n,;\t]+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates = [];
  const hints = new Map();

  for (const line of rawLines) {
    // `AUG Assault Rifle-Chiến Trường Toàn Diện-6KFJKLO07BHIFPGO0COS7`
    if (line.includes('-')) {
      const segments = line.split('-').map((s) => s.trim()).filter(Boolean);
      const tail = normalizeCode(segments[segments.length - 1]);
      const looksLikeHint = segments.length >= 2 && /[^A-Za-z0-9_-]/.test(line.slice(0, line.lastIndexOf('-')));
      if (looksLikeHint && isCode(tail)) {
        candidates.push(tail);
        hints.set(tail.toUpperCase(), segments.slice(0, -1).join(' - '));
        continue;
      }
    }
    for (const token of line.split(/\s+/)) {
      const code = normalizeCode(token);
      if (code) candidates.push(code);
    }
  }

  const knownCodes = new Map();
  for (const candidate of candidates.filter(isCode)) {
    const key = candidate.toUpperCase();
    if (!knownCodes.has(key)) knownCodes.set(key, candidate);
  }
  if (opts.vocabulary) {
    for (const extra of opts.vocabulary) {
      const normalized = normalizeCode(extra);
      if (isCode(normalized) && !knownCodes.has(normalized.toUpperCase())) knownCodes.set(normalized.toUpperCase(), normalized);
    }
  }

  const codes = [];
  const invalid = [];
  const seen = new Map();
  let duplicates = 0;
  let unjoined = 0;

  const push = (code, hint) => {
    const key = code.toUpperCase();
    if (seen.has(key)) {
      duplicates += 1;
      return;
    }
    seen.set(key, code);
    codes.push({ code, hint: hint || hints.get(key) || '' });
  };

  for (const candidate of candidates) {
    if (!isCode(candidate)) {
      invalid.push(candidate);
      continue;
    }
    const parts = splitJoinedRun(candidate, knownCodes);
    if (parts) {
      unjoined += 1;
      for (const part of parts) push(part);
      continue;
    }
    push(candidate);
  }

  return { codes, invalid, duplicates, unjoined, submitted: rawLines.length };
}

/* ── OCR variant generation ────────────────────────────────────────────────
 * Only used when Garena answers "this code does not exist" (400054) AND the
 * code came from OCR. Glyph pairs ranked by how often the two engines actually
 * disagreed on the 257-cell run: 0/O, 1/I/l, 5/S, 8/B, 2/Z, 6/G, Q/O, c/e, V/W.
 */
const CONFUSION = [
  ['0', 'O'], ['0', 'Q'], ['0', 'D'],
  ['1', 'I'], ['1', 'l'], ['I', 'l'],
  ['5', 'S'], ['8', 'B'], ['2', 'Z'], ['6', 'G'],
  ['9', 'g'], ['c', 'e'], ['V', 'W'], ['U', 'V'],
  ['M', 'N'], ['K', 'X'], ['7', 'T'], ['4', 'A'],
];

const CONFUSION_MAP = (() => {
  const map = new Map();
  for (const [a, b] of CONFUSION) {
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a).add(b);
    map.get(b).add(a);
  }
  return map;
})();

/** Split a code into its alphabetic prefix and trailing digit block, if any. */
function segment(code) {
  const match = /^([A-Za-z]*)(.*?)(\d*)$/.exec(code);
  return { head: match[1] || '', mid: match[2] || '', tail: match[3] || '' };
}

/**
 * Produce ranked alternative spellings for a code (lower score tried first).
 *
 * Ranking model, derived from where the two OCR engines actually disagreed:
 *  - The `DF`/`POC`/`PWC` brand prefix is effectively never misread (the engines
 *    had thousands of samples of it), so touching it is the LAST resort.
 *  - A digit sitting inside the alphabetic word part is the prime suspect:
 *    `DFUItra220` — the real defect found in this dataset.
 *  - The final character of a code is the second-most suspect: it is where a
 *    glyph sits next to whitespace with no neighbour to disambiguate it
 *    (`DFOS7K2M9Q` vs `...M90`, `DFCCHAHA5` vs `...HAHAS`).
 *  - Mixed-case anomalies inside a lowercase word rank high too.
 */
function ocrVariants(code, limit) {
  const max = typeof limit === 'number' ? limit : 8;
  const wordMatch = /^[A-Za-z]+/.exec(code);
  const wordEnd = wordMatch ? wordMatch[0].length : 0;
  const brandMatch = /^(DFUTWQ|DFUTS|DFUTW|DFOSS|DFOS|DFCC|DFSL|DFUT|POC|PWC|DF)/i.exec(code);
  const brandEnd = brandMatch ? brandMatch[0].length : 0;
  const lastIndex = code.length - 1;
  const scored = [];
  const seen = new Set([code]);

  const add = (variant, score) => {
    if (variant === code || seen.has(variant)) return;
    if (!isCode(variant)) return;
    seen.add(variant);
    scored.push({ variant, score });
  };

  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    const swaps = CONFUSION_MAP.get(ch);
    if (!swaps) continue;
    for (const swap of swaps) {
      const variant = code.slice(0, i) + swap + code.slice(i + 1);
      const insideWord = i < wordEnd;
      const inBrand = i < brandEnd;
      const isDigit = /\d/.test(ch);
      const swapIsLetter = /[A-Za-z]/.test(swap);
      // An uppercase glyph that should be lowercase is the classic OCR tell:
      // `DFUItra220` — the I sits at the head of a lowercase run, so the swap
      // that restores that run (l) is almost always the right reading. Looking
      // at BOTH neighbours catches it whether the run starts or continues here.
      const prev = code[i - 1] || '';
      const next = code[i + 1] || '';
      const caseAnomaly = /[A-Z]/.test(ch) && /[a-z]/.test(swap) &&
        (/[a-z]/.test(next) || /[a-z]/.test(prev));

      let score;
      if (insideWord && isDigit && swapIsLetter) score = 1;   // digit inside a word: DF0ASIS → DFOASIS
      else if (insideWord && caseAnomaly) score = 1;          // DFUItra220 → DFUltra220
      else if (i === lastIndex) score = 2;                    // trailing glyph, no right neighbour
      else if (insideWord && !isDigit) score = 5;             // letter inside the word
      else if (!insideWord) score = 6;                        // inside the numeric tail
      else score = 7;

      // The brand prefix is the most-trained token on the page: touch it last.
      if (inBrand) score += 20;

      add(variant, score);
    }
  }

  scored.sort((a, b) => (a.score - b.score) || (a.variant < b.variant ? -1 : 1));
  const out = scored.slice(0, max).map((s) => s.variant);

  // Whole-code case flips are cheap and catch pure-case OCR drift.
  if (out.length < max && code !== code.toUpperCase()) out.push(code.toUpperCase());
  return out.slice(0, max);
}

/** Family classification — used for grouping, reporting, and variant weighting. */
function classifyFamily(code) {
  const u = code.toUpperCase();
  if (/^6[A-Z0-9]{20}$/.test(u)) return 'weapon-longcode';
  if (/^DFUTS26/.test(u)) return 'DFUTS26-dated';
  if (/^DFUTWQ\d/.test(u)) return 'DFUTWQ-dated';
  if (/^DFUTW\d/.test(u)) return 'DFUTW-dated';
  if (/^DFUT\d{4}/.test(u)) return 'DFUT-item';
  if (/^POC\d{4}S\d+$/.test(u)) return 'POC-dated';
  if (/^PWC\d{6}S\d+$/.test(u)) return 'PWC-dated';
  if (/^DFOSS?\d/.test(u)) return 'DFOS-dated';
  if (/^DFOS[A-Z0-9]{6,}$/.test(u)) return 'DFOS-random';
  if (/^DFSL\d{4}$/.test(u)) return 'DFSL-series';
  if (/^DFCC/.test(u)) return 'DFCC-campaign';
  if (/^MOILOOT\d+$/.test(u)) return 'MOILOOT';
  if (/^HEDELTAFORCE\d+$/.test(u)) return 'HEDELTAFORCE';
  if (/^TRILLIONRAID\d+$/.test(u)) return 'TRILLIONRAID';
  if (/^DFRIDEORDIE\d+$/.test(u)) return 'DFRIDEORDIE';
  if (/^ANIMALCUP|^DFANIMALCUP/.test(u)) return 'ANIMALCUP';
  if (/^RETURNINGWARRIOR\d*$/.test(u)) return 'RETURNINGWARRIOR';
  if (/^DF[A-Z]+\d{2,4}$/.test(u)) return 'DF-word';
  if (/^[A-Z0-9]{14,21}$/.test(u) && /\d/.test(u) && /[A-Z]/.test(u)) return 'random-token';
  if (/^DF/.test(u)) return 'DF-other';
  return 'other';
}

  /** Pull every plausible code out of arbitrary text: .txt lists, CSV, pasted
   * pages. Keeps document order and drops duplicates. Used by the file picker. */
  function extractFromText(text) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text == null ? '' : text).split(/[\r\n]+/)) {
      const line = raw.trim();
      if (!line) continue;
      // CSV/TSV: prefer a cell that looks like a code over the whole row.
      const cells = line.split(/[\t,;|]/).map((c) => c.trim().replace(/^"|"$/g, ''));
      const fields = cells.length > 1 ? cells : line.split(/\s+/);
      for (const field of fields) {
        const code = normalizeCode(field);
        if (!isCode(code)) continue;
        if (/^(code|ma|ma_code|giftcode|no|stt|status)$/i.test(code)) continue;
        const key = code.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(code);
      }
    }
    return out;
  }

  const api = {
    CODE_RE,
    normalizeCode,
    isCode,
    parseCodes,
    splitJoinedRun,
    ocrVariants,
    classifyFamily,
    CONFUSION,
    extractFromText,
  };
  root.DFRedeemCodes = api;
    return api;
}(typeof window !== 'undefined' ? window : globalThis));

/* garena.js — Garena redeem response classification.
 *
 * Source of truth is the JSON body of the redeem XHR/fetch, never the popup.
 * A popup saying "success" without a network body is NOT a success; that
 * distinction is what stops a run from reporting phantom wins.
 */

var DFRedeemGarena = (function dfRedeemGarenaModule(root) {
  'use strict';

  /* Numeric error codes observed on redeem.df.garena.sg. */
  const ERROR_CODES = {
  0: { status: 'SUCCESS', label: 'Thành công', detail: 'Đổi code thành công.' },
  400054: { status: 'INVALID', label: 'Không hợp lệ', detail: 'Code không tồn tại hoặc sai ký tự.' },
  400067: { status: 'LIMIT_REACHED', label: 'Chạm giới hạn nhóm', detail: 'Tài khoản bạn đã đạt giới hạn nhận của nhóm quà này — mã vẫn còn tốt, người khác vẫn đổi được.' },
  400068: { status: 'EXPIRED', label: 'Hết hạn', detail: 'Code đã quá thời hạn sử dụng.' },
  /* Observed live on redeem.df.garena.sg: "The end time has passed". Distinct
   * code from 400068 but the same outcome — the campaign window closed. */
  400070: { status: 'EXPIRED', label: 'Hết hạn', detail: 'Đợt phát code đã kết thúc.' },
  400073: { status: 'PRESENT_ERROR', label: 'Lỗi quà', detail: 'Phần quà của code đang lỗi phía Garena.' },
  400069: { status: 'USED', label: 'Đã dùng', detail: 'Code đã được sử dụng.' },
  400055: { status: 'INVALID', label: 'Không hợp lệ', detail: 'Code không áp dụng cho tài khoản/khu vực này.' },
  400056: { status: 'REGION', label: 'Sai khu vực', detail: 'Code không dùng được cho server của tài khoản.' },
  400050: { status: 'NOT_LOGGED_IN', label: 'Chưa đăng nhập', detail: 'Phiên đăng nhập không hợp lệ.' },
  400001: { status: 'TEMP_ERROR', label: 'Lỗi tạm thời', detail: 'Garena trả lỗi tạm thời.' },
  10: { status: 'RATE_LIMITED', label: 'Bị siết tốc độ', detail: 'Gửi quá nhanh, Garena chặn tạm.' },
  401009: { status: 'RATE_LIMITED', label: 'Bị siết tốc độ', detail: 'Gửi quá nhiều yêu cầu, Garena chặn tạm.' },
  401010: { status: 'RATE_LIMITED', label: 'Bị siết tốc độ', detail: 'Gửi quá nhiều yêu cầu, Garena chặn tạm.' },
  /* Garena's generic server-side failure. Observed repeatedly on codes that are
   * neither dead nor redeemed: it says nothing about the code, only that their
   * backend refused to answer. Must never be recorded as a verdict. */
  51: { status: 'SYSTEM_ERROR', label: 'Garena lỗi hệ thống', detail: 'Garena trả lỗi hệ thống 51 — chưa kết luận được gì về mã này.' },
};

/** Statuses that mean "stop the whole run, a human must act". */
const FATAL = new Set(['NOT_LOGGED_IN', 'VERIFY', 'SCRIPT_ERROR']);
/** Statuses worth retrying the same code later. */
const RETRYABLE = new Set(['TEMP_ERROR', 'RATE_LIMITED', 'NO_RESPONSE', 'NETWORK', 'SYSTEM_ERROR']);
/** Statuses where trying an OCR variant makes sense. */
const VARIANT_WORTHY = new Set(['INVALID']);
/** Statuses that prove the code itself is real, even if we gained nothing. */
const CODE_IS_REAL = new Set(['SUCCESS', 'LIMIT_REACHED', 'EXPIRED', 'USED', 'PRESENT_ERROR', 'REGION']);

const STATUS_LABELS = {
  SUCCESS: 'Thành công',
  LIMIT_REACHED: 'Chạm giới hạn nhóm',
  EXPIRED: 'Hết hạn',
  USED: 'Đã dùng',
  PRESENT_ERROR: 'Lỗi quà',
  INVALID: 'Không hợp lệ',
  REGION: 'Sai khu vực',
  VERIFY: 'Cần xác minh (captcha)',
  NOT_LOGGED_IN: 'Chưa đăng nhập',
  RATE_LIMITED: 'Bị siết tốc độ',
  TEMP_ERROR: 'Lỗi tạm thời',
  SYSTEM_ERROR: 'Garena lỗi hệ thống',
  NETWORK: 'Lỗi mạng',
  NO_RESPONSE: 'Không thấy phản hồi',
  SKIPPED: 'Đã bỏ qua',
  STOPPED: 'Đã dừng',
  SCRIPT_ERROR: 'Lỗi script',
  OTHER: 'Khác',
};

/**
 * Classify a parsed JSON body from the redeem endpoint.
 * @param {object} body  e.g. { code: 400067, msg: '...', code_type: ... }
 * @returns {{status:string,label:string,detail:string,errorCode:number|null,trusted:boolean}}
 */
function classifyResponse(body, httpStatus) {
  const http = Number(httpStatus) || 0;
  // Transport-level throttling must win over whatever the body says: a 429 is
  // never a verdict about the code, only about our pacing.
  if (http === 429 || http === 503) {
    return { status: 'RATE_LIMITED', label: STATUS_LABELS.RATE_LIMITED, detail: `Garena chặn tạm (HTTP ${http}).`, errorCode: null, trusted: true };
  }
  if (!body || typeof body !== 'object') {
    if (http >= 500) {
      return { status: 'TEMP_ERROR', label: STATUS_LABELS.TEMP_ERROR, detail: `Lỗi máy chủ Garena (HTTP ${http}).`, errorCode: null, trusted: true };
    }
    return { status: 'NO_RESPONSE', label: STATUS_LABELS.NO_RESPONSE, detail: 'Không đọc được body phản hồi.', errorCode: null, trusted: false };
  }
  const raw = body.code != null ? body.code : body.error_code;
  const numeric = Number(raw);
  const known = Number.isFinite(numeric) ? ERROR_CODES[numeric] : null;
  const msg = String(body.msg || body.message || '').trim();

  if (known) {
    return {
      status: known.status,
      label: known.label,
      detail: msg ? `${known.detail} (Garena: ${msg})` : known.detail,
      errorCode: numeric,
      trusted: true,
    };
  }
  if (Number.isFinite(numeric) && numeric !== 0) {
    // Unknown members of the 401xxx family are throttle/session errors in
    // practice — treat them as retryable rather than a verdict on the code.
    if (numeric >= 401000 && numeric < 402000) {
      return {
        status: 'RATE_LIMITED', label: STATUS_LABELS.RATE_LIMITED,
        detail: `Garena chặn tạm (${numeric}${msg ? `: ${msg}` : ''}).`,
        errorCode: numeric, trusted: true,
      };
    }
    const fromText = classifyText(msg);
    return {
      status: fromText.status === 'OTHER' ? 'OTHER' : fromText.status,
      label: STATUS_LABELS[fromText.status === 'OTHER' ? 'OTHER' : fromText.status],
      detail: `Mã lỗi chưa biết ${numeric}${msg ? `: ${msg}` : ''}`,
      errorCode: numeric,
      trusted: true,
    };
  }
  return { status: 'OTHER', label: STATUS_LABELS.OTHER, detail: msg || 'Phản hồi không rõ.', errorCode: null, trusted: true };
}

/**
 * Fallback classifier for on-page text. Result is UNTRUSTED: used only to
 * describe what the user would have seen, never to declare a success.
 */
function classifyText(message) {
  const t = String(message || '').toLowerCase();
  if (!t) return { status: 'NO_RESPONSE', trusted: false };
  if (/error_hint_400067|400067|redemption limit|limit of cdkey group|đạt giới hạn/.test(t)) return { status: 'LIMIT_REACHED', trusted: false };
  if (/error_hint_400068|400068|hết hạn|expired/.test(t)) return { status: 'EXPIRED', trusted: false };
  if (/error_hint_400073|400073|present error/.test(t)) return { status: 'PRESENT_ERROR', trusted: false };
  if (/error_hint_400054|400054|không hợp lệ|invalid|does not match|không tồn tại/.test(t)) return { status: 'INVALID', trusted: false };
  if (/đã.*(nhận|sử dụng|đổi)|already|used/.test(t)) return { status: 'USED', trusted: false };
  if (/captcha|xác minh|verification|verify/.test(t)) return { status: 'VERIFY', trusted: false };
  if (/đăng nhập|login|log in|sign in|hết phiên|session/.test(t)) return { status: 'NOT_LOGGED_IN', trusted: false };
  if (/quá nhanh|too fast|rate|frequent|thử lại sau/.test(t)) return { status: 'RATE_LIMITED', trusted: false };
  /* Garena renders error 51 as a bare "system error" string. Matched after the
   * specific verdicts so a real error code always wins. */
  if (/error_hint_51\b|lỗi hệ thống|system error|hệ thống đang bận/.test(t)) return { status: 'SYSTEM_ERROR', trusted: false };
  if (/lỗi mạng|network|timeout|time out/.test(t)) return { status: 'NETWORK', trusted: false };
  if (/^ok$|thành công|success|congratulation/.test(t)) return { status: 'SUCCESS', trusted: false };
  return { status: 'OTHER', trusted: false };
}

/** True when a body looks like the redeem endpoint's answer, not some other XHR. */
function looksLikeRedeemBody(body) {
  return Boolean(
    body && typeof body === 'object' &&
    ('code' in body || 'error_code' in body) &&
    ('msg' in body || 'message' in body || 'code_type' in body || 'data' in body)
  );
}

/* ── verdict → vault status ────────────────────────────────────────────────
 * The engine speaks in verdicts (SUCCESS, LIMIT_REACHED, …); the vault stores
 * one of schema.js's seven states. Without this bridge every completed attempt
 * was written back as "untried", so a run left the library exactly as it found
 * it and History showed "Chưa thử" next to codes that had just been submitted.
 *
 * Only trustworthy, decided verdicts map. Transport noise (RATE_LIMITED,
 * NETWORK, …) and blockers (NOT_LOGGED_IN, VERIFY) return null, which means
 * "leave the stored status alone" — a throttled attempt is not evidence about
 * the code.
 */
const VAULT_STATUS = {
  SUCCESS: 'success',
  /* 400067 is a cap on THIS account's reward group, not a fact about the code:
   * another account can still redeem it. Kept separate from `mine` so the UI can
   * say so and the sharer never treats it as a dead code. */
  LIMIT_REACHED: 'group_limit',
  USED: 'mine',               /* 400069 is this account's prior redemption, not global exhaustion */
  EXPIRED: 'expired',
  PRESENT_ERROR: 'gift_bug',
  INVALID: 'invalid',
  REGION: 'invalid',          /* unusable for this account's server */
  /* Error 51 is Garena failing, not a verdict. Recording it keeps the code out
   * of `untried` (so a bulk run does not silently retry it forever) while
   * flagging it as "ask again later" rather than dead. */
  SYSTEM_ERROR: 'sys_error',
};

/**
 * Map an engine verdict onto a vault status.
 * @param {string} verdictStatus e.g. 'SUCCESS'
 * @returns {string|null} vault status, or null to keep the existing one
 */
function vaultStatus(verdictStatus) {
  return VAULT_STATUS[String(verdictStatus || '').toUpperCase()] || null;
}

  const api = {
    ERROR_CODES,
    STATUS_LABELS,
    VAULT_STATUS,
    vaultStatus,
    FATAL,
    RETRYABLE,
    VARIANT_WORTHY,
    CODE_IS_REAL,
    classifyResponse,
    classifyText,
    looksLikeRedeemBody,
    label: (status) => STATUS_LABELS[status] || status,
  };
  root.DFRedeemGarena = api;
    return api;
}(typeof window !== 'undefined' ? window : globalThis));

/* Weapon catalogue for grouping Gunsmith presets.
 *
 * Preset rows carry a free-text `weapon` string, typed by whoever submitted the
 * code. That string cannot be trusted to group by: the live data contains
 * "EasyB AS Val Assault Rifle" and "Upstairs-Pirate-9890 AKS-74 Assault Rifle"
 * (a Reddit author's handle glued onto the gun), "Súng Trường Xạ Thủ SVCH"
 * "Súng Trường Xạ Thủ SVCH" (Vietnamese for a gun the catalogue lists in
 * English), and a community shorthand "Tay Đen" (now resolved to Thompson
 * Submachine Gun). Grouping on the raw string produced 18 buckets for 20
 * presets, which is not a grouping.
 *
 * So we resolve the free text against this catalogue instead, and keep the
 * original string for display. Names and classes are from the Delta Force wiki
 * Firearms page (delta-force.fandom.com/wiki/Firearms, 67 entries, current for
 * Havoc Warfare). Vietnamese labels follow the in-game VN client where a term
 * exists; ones that ship untranslated in game keep the English name so a player
 * reading the panel sees what they will see in Gunsmith.
 */
(function (root) {
  'use strict';

/* Classes in the order the in-game Gunsmith lists them, so the panel's section
 * order matches the game rather than being alphabetical. */
const WEAPON_CLASSES = [
  { id: 'ar', label: 'Súng Trường Tấn Công', en: 'Assault Rifle' },
  { id: 'br', label: 'Súng Trường Chiến Đấu', en: 'Battle Rifle' },
  { id: 'smg', label: 'Súng Tiểu Liên', en: 'Submachine Gun' },
  { id: 'lmg', label: 'Súng Máy', en: 'Machine Gun' },
  { id: 'dmr', label: 'Súng Trường Xạ Thủ', en: 'Marksman Rifle' },
  { id: 'sr', label: 'Súng Bắn Tỉa', en: 'Sniper Rifle' },
  { id: 'sg', label: 'Súng Shotgun', en: 'Shotgun' },
  { id: 'pistol', label: 'Súng Ngắn', en: 'Pistol' },
  { id: 'special', label: 'Vũ Khí Đặc Biệt', en: 'Special' },
];

/* name = exactly as the wiki/game lists it; aliases = other spellings seen in
 * submitted data (Vietnamese names, common abbreviations). Matching is done on
 * a normalised form, so case and diacritics do not need repeating here. */
const WEAPONS = [
  /* Assault rifles */
  { name: 'AKS-74 Assault Rifle', cls: 'ar', aliases: ['AKS-74', 'AKS74'] },
  { name: 'CAR-15 Assault Rifle', cls: 'ar', aliases: ['CAR-15', 'CAR15'] },
  { name: 'QBZ95-1 Assault Rifle', cls: 'ar', aliases: ['QBZ95-1', 'QBZ95'] },
  { name: 'M4A1 Assault Rifle', cls: 'ar', aliases: ['M4A1', 'M4'] },
  { name: 'M16A4 Assault Rifle', cls: 'ar', aliases: ['M16A4', 'M16'] },
  { name: 'SG 552 Assault Rifle', cls: 'ar', aliases: ['SG552', 'SG 552'] },
  { name: 'AK-12 Assault Rifle', cls: 'ar', aliases: ['AK-12', 'AK12'] },
  { name: 'PTR-32 Assault Rifle', cls: 'ar', aliases: ['PTR-32', 'PTR32'] },
  { name: 'AKM Assault Rifle', cls: 'ar', aliases: ['AKM'] },
  { name: 'AS Val Assault Rifle', cls: 'ar', aliases: ['AS Val', 'ASVal', 'AS-Val'] },
  { name: 'CI-19 Assault Rifle', cls: 'ar', aliases: ['CI-19', 'CI19'] },
  { name: 'K416 Assault Rifle', cls: 'ar', aliases: ['K416'] },
  { name: 'AUG Assault Rifle', cls: 'ar', aliases: ['AUG'] },
  { name: 'K437 Assault Rifle', cls: 'ar', aliases: ['K437'] },
  { name: 'KC17 Assault Rifle', cls: 'ar', aliases: ['KC17'] },
  { name: 'MCX LT Assault Rifle', cls: 'ar', aliases: ['MCX LT', 'MCX'] },
  { name: 'AR-57 Assault Rifle', cls: 'ar', aliases: ['AR-57', 'AR57'] },
  { name: 'RM227 Assault Rifle', cls: 'ar', aliases: ['RM227'] },
  { name: 'MDR Assault Rifle', cls: 'ar', aliases: ['MDR'] },
  { name: 'SR-3M Compact Assault Rifle', cls: 'ar', aliases: ['SR-3M', 'SR3M'] },
  /* Battle rifles — a separate Gunsmith class in game, though the wiki lists
   * them under Rifle alongside assault rifles. */
  { name: 'G3 Battle Rifle', cls: 'br', aliases: ['G3'] },
  { name: 'SCAR-H Battle Rifle', cls: 'br', aliases: ['SCAR-H', 'SCAR', 'SCARH'] },
  { name: 'Ash-12 Battle Rifle', cls: 'br', aliases: ['Ash-12', 'Ash12'] },
  { name: 'M7 Battle Rifle', cls: 'br', aliases: ['M7'] },
  { name: 'MK47 Battle Rifle', cls: 'br', aliases: ['MK47', 'MK-47'] },
  /* SMGs */
  { name: 'UZI Submachine Gun', cls: 'smg', aliases: ['UZI'] },
  { name: 'Bizon Submachine Gun', cls: 'smg', aliases: ['Bizon', 'PP-19'] },
  { name: 'SMG-45 Submachine Gun', cls: 'smg', aliases: ['SMG-45', 'SMG45'] },
  { name: 'MP5 Submachine Gun', cls: 'smg', aliases: ['MP5'] },
  { name: 'Vector Submachine Gun', cls: 'smg', aliases: ['Vector'] },
  { name: 'MP7 Submachine Gun', cls: 'smg', aliases: ['MP7'] },
  { name: 'P90 Submachine Gun', cls: 'smg', aliases: ['P90'] },
  { name: 'Vityaz Submachine Gun', cls: 'smg', aliases: ['Vityaz'] },
  { name: 'QCQ171 Submachine Gun', cls: 'smg', aliases: ['QCQ171', 'QCQ-171'] },
  { name: 'MK4 Submachine Gun', cls: 'smg', aliases: ['MK4', 'MK-4'] },
  { name: 'Thompson Submachine Gun', cls: 'smg', aliases: ['Thompson', 'Tay Đen', 'Thompson Submachine Gun (Tay Đen)'] },
  /* Machine guns */
  { name: 'M249 Light Machine Gun', cls: 'lmg', aliases: ['M249'] },
  { name: 'QJB 201 Light Machine Gun', cls: 'lmg', aliases: ['QJB 201', 'QJB201'] },
  { name: 'PKM General Machine Gun', cls: 'lmg', aliases: ['PKM'] },
  { name: 'M250 General Machine Gun', cls: 'lmg', aliases: ['M250'] },
  /* Marksman rifles */
  { name: 'Mini-14 Marksman Rifle', cls: 'dmr', aliases: ['Mini-14', 'Mini14'] },
  { name: 'VSS Marksman Rifle', cls: 'dmr', aliases: ['VSS'] },
  { name: 'PSG-1 Marksman Rifle', cls: 'dmr', aliases: ['PSG-1', 'PSG1'] },
  { name: 'SR-25 Marksman Rifle', cls: 'dmr', aliases: ['SR-25', 'SR25'] },
  { name: 'SKS Marksman Rifle', cls: 'dmr', aliases: ['SKS'] },
  { name: 'M14 Marksman Rifle', cls: 'dmr', aliases: ['M14'] },
  { name: 'SR9 Marksman Rifle', cls: 'dmr', aliases: ['SR9'] },
  { name: 'Marlin Lever-action Rifle', cls: 'dmr', aliases: ['Marlin'] },
  /* SVD sits under Marksman Rifle on the wiki despite the "Sniper" in its
   * name; keep the wiki's class so the count matches the page. */
  { name: 'SVD Sniper Rifle', cls: 'dmr', aliases: ['SVD'] },
  /* The VN client ships a Vietnamese name for the SVCH; submitted data uses it,
   * so it must resolve rather than becoming its own bucket. */
  { name: 'SVCH Marksman Rifle', cls: 'dmr', aliases: ['SVCH', 'Súng Trường Xạ Thủ SVCH', 'Sung Truong Xa Thu SVCH'] },
  /* Sniper rifles */
  { name: 'SV-98 Sniper Rifle', cls: 'sr', aliases: ['SV-98', 'SV98'] },
  { name: 'R93 Sniper Rifle', cls: 'sr', aliases: ['R93'] },
  { name: 'M700 Sniper Rifle', cls: 'sr', aliases: ['M700'] },
  { name: 'AWM Sniper Rifle', cls: 'sr', aliases: ['AWM'] },
  { name: 'Barrett M82 Sniper Rifle', cls: 'sr', aliases: ['Barrett M82', 'Barrett', 'M82'] },
  /* Shotguns */
  { name: 'M1014 Shotgun', cls: 'sg', aliases: ['M1014'] },
  { name: 'S12K Shotgun', cls: 'sg', aliases: ['S12K', 'Saiga'] },
  { name: 'M870 Shotgun', cls: 'sg', aliases: ['M870'] },
  { name: '725 Double Barrel Shotgun', cls: 'sg', aliases: ['725'] },
  { name: 'FS-12 Shotgun', cls: 'sg', aliases: ['FS-12', 'FS12'] },
  /* Pistols */
  { name: 'G17', cls: 'pistol', aliases: ['Glock 17', 'Glock17'] },
  { name: 'G18', cls: 'pistol', aliases: ['Glock 18', 'Glock18'] },
  { name: 'QSZ-92G', cls: 'pistol', aliases: ['QSZ-92G', 'QSZ92G', 'QSZ-92'] },
  { name: '93R', cls: 'pistol', aliases: ['Beretta 93R'] },
  { name: 'Desert Eagle', cls: 'pistol', aliases: ['Deagle'] },
  { name: '.357 Revolver', cls: 'pistol', aliases: ['357 Revolver', 'Revolver'] },
  { name: 'M1911', cls: 'pistol', aliases: ['1911'] },
  /* Special */
  { name: 'Compound Bow', cls: 'special', aliases: ['Bow', 'Cung'] },
];

/* Diacritics stripped and punctuation dropped so "AS Val", "as-val" and
 * "ASVAL" all land on the same key, and so Vietnamese aliases match whether or
 * not the submitter typed the accents. */
function normWeapon(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

/* name -> canonical entry, including every alias. */
const WEAPON_INDEX = (() => {
  const ix = new Map();
  for (const w of WEAPONS) {
    ix.set(normWeapon(w.name), w);
    for (const a of w.aliases || []) ix.set(normWeapon(a), w);
    /* Bare model name, so "AKM Assault Rifle" also matches a submission that
     * said only "AKM" without listing it as an explicit alias. */
    const bare = w.name.replace(/\s+(Assault Rifle|Battle Rifle|Submachine Gun|Light Machine Gun|General Machine Gun|Marksman Rifle|Sniper Rifle|Shotgun|Compact Assault Rifle|Double Barrel Shotgun|Lever-action Rifle)$/i, '');
    if (bare !== w.name) ix.set(normWeapon(bare), w);
  }
  return ix;
})();

/* Longest-match-wins so an author handle glued to the front ("EasyB AS Val
 * Assault Rifle", "Upstairs-Pirate-9890 AKS-74 Assault Rifle") still resolves:
 * we look for any catalogue entry whose normalised name appears inside the
 * normalised input, preferring the longest so "AK-12" never wins over "AKM"
 * inside a longer string that contains both. */
function resolveWeapon(raw) {
  const n = normWeapon(raw);
  if (!n) return null;
  const exact = WEAPON_INDEX.get(n);
  if (exact) return exact;
  let best = null;
  let bestLen = 0;
  for (const [key, w] of WEAPON_INDEX) {
    if (key.length > bestLen && key.length >= 3 && n.includes(key)) {
      best = w;
      bestLen = key.length;
    }
  }
  return best;
}

const CLASS_BY_ID = new Map(WEAPON_CLASSES.map((c) => [c.id, c]));

/* What the panel renders for one preset: the resolved class (or the "unknown"
 * bucket), plus whether the submitted string differed from the catalogue name
 * so the UI can show the original without pretending it is canonical. */
function classifyPreset(preset) {
  const raw = String((preset && (preset.weapon || preset.gun)) || '').trim();
  const w = resolveWeapon(raw);
  if (!w) {
    return { cls: 'unknown', clsLabel: 'Chưa rõ loại súng', weapon: raw || '—', canonical: null, raw };
  }
  const c = CLASS_BY_ID.get(w.cls);
  return {
    cls: w.cls,
    clsLabel: (c && c.label) || w.cls,
    clsEn: (c && c.en) || '',
    weapon: w.name,
    canonical: w.name,
    /* Only surfaced when it adds information, i.e. the submitter typed
     * something other than the catalogue name. */
    raw: normWeapon(raw) === normWeapon(w.name) ? '' : raw,
  };
}

  const api = {
    WEAPON_CLASSES,
    WEAPONS,
    WEAPON_INDEX,
    normWeapon,
    resolveWeapon,
    classifyPreset,
  };
  root.DFRedeemWeapons = api;
    return api;
}(typeof window !== 'undefined' ? window : globalThis));

/* src/core/costs.js — equipment cost ("Chi phí trang bị") for Gunsmith presets.
 *
 * Why a module and not a field on the preset row: a cost is not a property of the
 * code, it is a *claim about* the code that several users measure independently.
 * Two players reading the same Gunsmith screen can report different numbers —
 * the build was changed, attachment prices were patched, or somebody mistyped a
 * digit. So a cost carries provenance and an agreement state, exactly like the
 * redeem verdicts in worker/src/index.js do.
 *
 * Agreement rule (the user's rule, implemented literally):
 *   1st report                 → trusted immediately, shown as "chưa đối chiếu"
 *   2nd report, same number    → confirmed, no approval needed (it is a duplicate)
 *   2nd report, different      → disputed, needs a human verdict before publishing
 *
 * "Same number" is not string equality: 290K, 290.000 and 295426 are all things a
 * player will type for the same build. Values are normalised to an integer before
 * comparison, and near-equal readings are treated as agreement (see TOLERANCE)
 * because the in-game number moves slightly with attachment price patches, and a
 * dispute should mean "someone is wrong", not "someone measured on Tuesday".
 */
(function attach(root) {
  'use strict';

  /* Gunsmith costs are whole currency units. The observed range in-game spans a
   * few thousand (a pistol with no attachments) to a few hundred thousand (a
   * fully kitted sniper). Anything outside this is a typo — a trailing zero, or
   * a pasted code fragment — and is rejected rather than stored and averaged. */
  const MIN_COST = 100;
  const MAX_COST = 9999999;

  /* Two readings within this fraction of each other are the same build priced at
   * different patch levels, not a disagreement. 2% of 295,426 is ~5,900, which
   * absorbs attachment repricing without absorbing a mistyped leading digit
   * (295,426 vs 195,426 differs by 34% and still disputes). */
  const TOLERANCE = 0.02;

  const STATES = {
    unconfirmed: { id: 'unconfirmed', label: 'Chưa đối chiếu', hint: 'Một người báo, chưa ai đối chiếu' },
    confirmed: { id: 'confirmed', label: 'Đã đối chiếu', hint: 'Nhiều người báo trùng số' },
    disputed: { id: 'disputed', label: 'Đang tranh chấp', hint: 'Số liệu khác nhau, chờ phê duyệt' },
  };

  /* Parse whatever a human typed into an integer cost.
   *
   * Accepts: 295426 · 295,426 · 295.426 · "295 426" · 290k · 290K · 1.2m
   * Rejects: empty, negative, non-numeric, out-of-range.
   *
   * Thousands separators are the hard part: Vietnamese locale writes 295.426
   * where English writes 295,426, so a dot is NOT reliably a decimal point. The
   * rule used here: a trailing group of exactly 3 digits after a separator is a
   * thousands group; a shorter trailing group is a decimal fraction (only
   * meaningful with a k/m suffix, where 1.2m is 1,200,000).
   */
  function parseCost(input) {
    if (input === null || input === undefined) return { ok: false, error: 'Chưa nhập chi phí' };
    let text = String(input).trim().toLowerCase();
    if (!text) return { ok: false, error: 'Chưa nhập chi phí' };

    /* Strip currency noise a player may paste along with the number. */
    text = text.replace(/[₫$]|vnd|đ\b/g, '').trim();

    const suffix = /([km])\s*$/.exec(text);
    const mult = suffix ? (suffix[1] === 'k' ? 1000 : 1000000) : 1;
    if (suffix) text = text.slice(0, suffix.index).trim();

    if (!/^[\d.,\s]+$/.test(text)) return { ok: false, error: 'Chi phí phải là số' };

    let normalised;
    if (mult > 1) {
      /* With a k/m suffix the separator is a decimal point: 1.2m → 1200000. */
      normalised = text.replace(/[,\s]/g, '').replace(/\.(?=\d{1,2}$)/, '.');
      const asFloat = Number(normalised.replace(/\.(?=.*\.)/g, ''));
      if (!Number.isFinite(asFloat)) return { ok: false, error: 'Chi phí phải là số' };
      normalised = String(Math.round(asFloat * mult));
    } else {
      /* No suffix: every separator is a thousands separator, so drop them all.
       * A bare "295.4" without a suffix is a typo, not 295.4 currency units. */
      normalised = text.replace(/[.,\s]/g, '');
    }

    if (!/^\d+$/.test(normalised)) return { ok: false, error: 'Chi phí phải là số' };
    const value = Number(normalised);
    if (!Number.isFinite(value)) return { ok: false, error: 'Chi phí phải là số' };
    if (value < MIN_COST) return { ok: false, error: `Chi phí quá nhỏ (tối thiểu ${MIN_COST})` };
    if (value > MAX_COST) return { ok: false, error: 'Chi phí quá lớn, kiểm tra lại số' };
    return { ok: true, value };
  }

  /** Render a cost for display with Vietnamese thousands separators. */
  function formatCost(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  /** True when two readings are close enough to count as the same measurement. */
  function agrees(a, b) {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x === y) return true;
    const span = Math.max(Math.abs(x), Math.abs(y));
    return span > 0 && Math.abs(x - y) / span <= TOLERANCE;
  }

  /* Fold one report into a cost record and return the new record.
   *
   * Pure: takes the existing record (or null) and returns a fresh object, so the
   * same function runs in the panel for an optimistic local update and in the
   * Worker for the authoritative one, and the two cannot drift.
   *
   * `reporter` de-duplicates: one person reporting twice is a correction of their
   * own number, not a second confirmation — otherwise a single user could
   * self-confirm any value and defeat the quorum entirely.
   */
  function applyReport(existing, report) {
    const parsed = parseCost(report && report.value);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const reporter = String((report && report.reporter) || '').trim();
    if (!reporter) return { ok: false, error: 'Thiếu danh tính người báo' };
    const at = (report && report.at) || new Date().toISOString();
    const value = parsed.value;

    if (!existing || !Array.isArray(existing.reports) || !existing.reports.length) {
      /* First report is trusted as-is — the user asked for exactly this: if the
       * first number looks right, nobody should have to edit it. */
      return {
        ok: true,
        record: {
          value,
          state: STATES.unconfirmed.id,
          reports: [{ value, reporter, at }],
          first_seen: at,
          updated_at: at,
        },
        changed: true,
        outcome: 'first',
      };
    }

    const reports = existing.reports.slice();
    const mineIndex = reports.findIndex((r) => r.reporter === reporter);
    const previouslyReported = mineIndex >= 0 ? reports[mineIndex] : null;

    /* Re-sending an identical number changes nothing. Worth returning early:
     * clients push their whole preset list, and writing unchanged rows is what
     * exhausted the KV put() quota for verdicts (see recordVerdict). */
    if (previouslyReported && agrees(previouslyReported.value, value)) {
      return { ok: true, record: existing, changed: false, outcome: 'unchanged' };
    }

    if (mineIndex >= 0) reports[mineIndex] = { value, reporter, at };
    else reports.push({ value, reporter, at });

    /* Group the distinct readings so the largest agreeing cluster wins. Using
     * clusters rather than a raw majority keeps 295,000 and 295,426 on the same
     * side instead of letting near-identical readings split the vote and hand a
     * win to a single outlier. */
    const clusters = [];
    for (const r of reports) {
      const hit = clusters.find((c) => agrees(c.value, r.value));
      if (hit) {
        hit.members.push(r);
        if (String(r.at) < String(hit.first_at)) hit.first_at = r.at;
      } else {
        clusters.push({ value: r.value, first_at: r.at, members: [r] });
      }
    }
    /* Within a cluster, show the most *precise* reading rather than the newest.
     * Players round when they retype ("290K" for 295,426), and a round number is
     * information lost, so a later rounded report must not overwrite an exact
     * one. Precision is judged by trailing zeros: fewer means more precise. */
    for (const c of clusters) {
      const precision = (v) => {
        const s = String(Math.round(v));
        const m = /0+$/.exec(s);
        return m ? m[0].length : 0;
      };
      c.value = c.members.slice().sort((a, b) => precision(a.value) - precision(b.value)
        || String(b.at).localeCompare(String(a.at)))[0].value;
    }
    /* Tie-break toward the *oldest* reading, not the newest. In a 1-vs-1 dispute
     * both clusters have one member, and letting the later report win would mean
     * any single user can flip the displayed cost of any preset just by reporting
     * after it — no quorum required. The incumbent value holds until either a
     * second person agrees with the challenger or a human resolves the dispute. */
    clusters.sort((a, b) => b.members.length - a.members.length
      || String(a.first_at).localeCompare(String(b.first_at)));

    const top = clusters[0];
    const contested = clusters.length > 1;
    const state = contested
      ? STATES.disputed.id
      : (top.members.length >= 2 ? STATES.confirmed.id : STATES.unconfirmed.id);

    return {
      ok: true,
      record: {
        /* A disputed record keeps showing the leading value rather than blanking:
         * a probably-right number with a visible dispute badge is more useful to a
         * player than no number at all. */
        value: top.value,
        state,
        reports,
        first_seen: existing.first_seen || at,
        updated_at: at,
      },
      changed: true,
      outcome: state,
    };
  }

  /** Resolve a human verdict on a dispute: keep `value`, drop the rest. */
  function resolveDispute(existing, value, resolver) {
    const parsed = parseCost(value);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const at = new Date().toISOString();
    const kept = (existing && Array.isArray(existing.reports) ? existing.reports : [])
      .filter((r) => agrees(r.value, parsed.value));
    return {
      ok: true,
      record: {
        value: parsed.value,
        state: STATES.confirmed.id,
        reports: kept.length ? kept : [{ value: parsed.value, reporter: String(resolver || 'admin'), at }],
        first_seen: (existing && existing.first_seen) || at,
        updated_at: at,
        resolved_by: String(resolver || 'admin'),
      },
      changed: true,
      outcome: 'resolved',
    };
  }

  /** Distinct readings on file, newest first — what a review UI must show. */
  function disputeSummary(record) {
    const reports = (record && Array.isArray(record.reports)) ? record.reports : [];
    const clusters = [];
    for (const r of reports) {
      const hit = clusters.find((c) => agrees(c.value, r.value));
      if (hit) hit.count += 1;
      else clusters.push({ value: r.value, count: 1, at: r.at });
    }
    return clusters.sort((a, b) => b.count - a.count || String(b.at).localeCompare(String(a.at)));
  }

  const api = {
    MIN_COST,
    MAX_COST,
    TOLERANCE,
    STATES,
    parseCost,
    formatCost,
    agrees,
    applyReport,
    resolveDispute,
    disputeSummary,
  };

  root.DFRedeemCosts = api;
  }(typeof globalThis !== 'undefined' ? globalThis : this));

/* engine.js — the redeem runner.
 *
 * Design rules baked in:
 *  1. A result is only SUCCESS when the network body says code===0. Popups lie.
 *  2. Every attempt is correlated to its own request by attempt id + code match,
 *     so a slow response from code N never gets credited to code N+1.
 *  3. Rate limiting is adaptive: consecutive clean answers speed the run up,
 *     any throttle signal slows it down and backs off exponentially.
 *  4. State is journaled after every code so a crashed/closed tab can resume.
 *  5. OCR variants are only tried when Garena says the code does not exist.
 */

(function attachEngine(root) {
  const Codes = root.DFRedeemCodes;
  const Garena = root.DFRedeemGarena;

  const DEFAULTS = {
    delayMs: 2500,             // pause between codes
    minDelayMs: 1200,
    maxDelayMs: 20000,
    responseTimeoutMs: 6000,   // how long to wait for the network body
    submitConfirmMs: 600,      // how long to confirm a click created a request
    submitClickRetries: 1,
    retryDelayMs: 5000,
    maxRetries: 1,             // retries for retryable statuses
    maxVariants: 3,            // OCR variants per failed code
    tryVariants: true,
    speedUpAfter: 8,           // clean answers before shaving the delay
    speedUpStepMs: 200,
    slowDownFactor: 2,
    stopOnFatal: true,
    jitterMs: 400,
  };

  const SELECTORS = {
    input: ['.exc-input', 'input[type="text"]:not([readonly])'],
    button: ['.btn-exchange'],
    dialog: ['[role="dialog"]', '.dialog', '.pop', '.popup', '.modal', '.exc-dialog'],
    tip: ['#superTips', '.super-tips'],
    close: ['.close', '.btn-close', "a[href='javascript:void(0);']", "a[href='javascript:void(0)']"],
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const now = () => Date.now();

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const style = root.getComputedStyle ? root.getComputedStyle(el) : null;
    const rect = el.getBoundingClientRect();
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    return rect.width > 0 && rect.height > 0;
  }

  function pick(selectors, predicate) {
    for (const selector of selectors) {
      const found = Array.prototype.slice.call(document.querySelectorAll(selector));
      const hit = found.find((el) => (predicate ? predicate(el) : visible(el)));
      if (hit) return hit;
    }
    return null;
  }

  function findInput() {
    return pick(SELECTORS.input, (el) => visible(el) && !el.disabled && !el.readOnly) ||
      Array.prototype.slice.call(document.querySelectorAll('input'))
        .find((el) => visible(el) && !el.disabled && !el.readOnly) || null;
  }

  function findButton() {
    const direct = pick(SELECTORS.button);
    if (direct) return direct;
    return Array.prototype.slice.call(document.querySelectorAll('a,button'))
      .find((el) => visible(el) && /^(đổi|exchange|redeem)$/i.test((el.textContent || '').trim())) || null;
  }

  /** Native setter so framework-bound inputs actually register the change. */
  function setValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  }

  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: root };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
    } catch (_) { /* PointerEvent may be unavailable */ }
    el.click();
  }

  function readPageMessage() {
    const dialog = pick(SELECTORS.dialog);
    if (dialog) {
      const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return { source: 'dialog', text };
    }
    const tip = pick(SELECTORS.tip, (el) => Boolean(el));
    if (tip) {
      const text = (tip.innerText || tip.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return { source: 'tip', text };
    }
    return { source: '', text: '' };
  }

  function closeDialog() {
    const dialog = pick(SELECTORS.dialog);
    if (!dialog) return;
    const closer = pick(SELECTORS.close, (el) => dialog.contains(el) && visible(el)) ||
      Array.prototype.slice.call(dialog.querySelectorAll('a,button')).find(visible);
    if (closer) realClick(closer);
  }

  async function clearMessages() {
    for (const selector of SELECTORS.tip) {
      const tip = document.querySelector(selector);
      if (tip) tip.textContent = '';
    }
    closeDialog();
    await sleep(120);
    closeDialog();
    for (const selector of SELECTORS.tip) {
      const tip = document.querySelector(selector);
      if (tip) tip.textContent = '';
    }
  }

  /* ── Network interception ─────────────────────────────────────────────── */

  function createNetworkTap(codeMatcher) {
    const bodies = [];
    const starts = [];
    let active = null;
    let restored = false;

    const originalFetch = root.fetch ? root.fetch.bind(root) : null;
    const originalOpen = root.XMLHttpRequest ? root.XMLHttpRequest.prototype.open : null;
    const originalSend = root.XMLHttpRequest ? root.XMLHttpRequest.prototype.send : null;

    const scan = (payload, depth, activeCode) => {
      if (payload == null || (depth || 0) > 3) return '';
      const match = (text) => codeMatcher(text, activeCode);
      if (typeof URLSearchParams !== 'undefined' && payload instanceof URLSearchParams) return match(payload.toString());
      if (typeof FormData !== 'undefined' && payload instanceof FormData) {
        return match(Array.from(payload.entries()).map(([k, v]) => `${k}=${v}`).join('&'));
      }
      if (typeof Request !== 'undefined' && payload instanceof Request) return match(payload.url);
      if (Array.isArray(payload)) {
        for (const item of payload) {
          const hit = scan(item, (depth || 0) + 1, activeCode);
          if (hit) return hit;
        }
        return '';
      }
      if (typeof payload === 'object') {
        try { return match(JSON.stringify(payload)); } catch (_) { return ''; }
      }
      return match(String(payload));
    };

    const recordStart = (attemptId, code, url) => {
      if (attemptId && code) starts.push({ time: now(), attemptId, code, url: url || '' });
    };
    const recordBody = (body, attemptId, code, httpStatus) => {
      if (!attemptId || !code) return;
      if (!Garena.looksLikeRedeemBody(body)) return;
      bodies.push({ time: now(), body, attemptId, code, httpStatus: httpStatus || 0 });
    };

    if (originalFetch) {
      root.fetch = async function tappedFetch(...args) {
        const attempt = active ? { id: active.id, code: active.code } : null;
        const code = scan(args, 0, attempt && attempt.code);
        recordStart(attempt && attempt.id, code, typeof args[0] === 'string' ? args[0] : '');
        let response;
        try {
          response = await originalFetch(...args);
        } catch (error) {
          if (attempt && code) bodies.push({ time: now(), body: null, attemptId: attempt.id, code, networkError: String(error && error.message || error) });
          throw error;
        }
        const httpStatus = response.status;
        response.clone().json()
          .then((body) => recordBody(body, attempt && attempt.id, code, httpStatus))
          .catch(() => {});
        return response;
      };
    }

    if (originalOpen && originalSend) {
      root.XMLHttpRequest.prototype.open = function tappedOpen(...args) {
        this.__dfRedeemUrl = args[1];
        return originalOpen.apply(this, args);
      };
      root.XMLHttpRequest.prototype.send = function tappedSend(...args) {
        const attempt = active ? { id: active.id, code: active.code } : null;
        const code = scan([this.__dfRedeemUrl, args[0]], 0, attempt && attempt.code);
        recordStart(attempt && attempt.id, code, this.__dfRedeemUrl);
        const xhr = this;
        this.addEventListener('loadend', () => {
          try {
            if (typeof xhr.responseText === 'string' && xhr.responseText.trim()) {
              recordBody(JSON.parse(xhr.responseText), attempt && attempt.id, code, xhr.status);
            }
          } catch (_) { /* not JSON */ }
        });
        return originalSend.apply(this, args);
      };
    }

    return {
      begin(attempt) { active = attempt; },
      end() { active = null; },
      reset() { bodies.length = 0; starts.length = 0; },
      started(attempt) { return starts.some((s) => s.attemptId === attempt.id && s.code === attempt.code); },
      bodyFor(attempt) {
        return bodies
          .filter((b) => b.attemptId === attempt.id && b.code === attempt.code)
          .sort((a, b) => a.time - b.time)[0] || null;
      },
      restore() {
        if (restored) return;
        if (originalFetch) root.fetch = originalFetch;
        if (originalOpen && originalSend) {
          root.XMLHttpRequest.prototype.open = originalOpen;
          root.XMLHttpRequest.prototype.send = originalSend;
        }
        restored = true;
      },
    };
  }

  /* ── Runner ───────────────────────────────────────────────────────────── */

  class RedeemRun {
    constructor(entries, options) {
      this.config = Object.assign({}, DEFAULTS, options || {});
      this.queue = entries.map((entry, index) => (typeof entry === 'string'
        ? { code: entry, hint: '', index }
        : { code: entry.code, hint: entry.hint || '', family: entry.family, source: entry.source, index }));
      this.results = [];
      this.byCode = new Map();
      this.startedAt = null;
      this.endedAt = null;
      this.stopRequested = false;
      this.stopReason = '';
      this.paused = false;
      this.attemptCounter = 0;
      this.cleanStreak = 0;
      this.currentDelay = this.config.delayMs;
      this.listeners = { progress: [], result: [], done: [], log: [] };
      this.state = 'idle';
      // The matcher must recognise every code the run may ever submit — the
      // queue codes AND any OCR variant generated later. Registering variants
      // lazily keeps a variant's response from being discarded as "unmatched",
      // which would silently throw away a correct reading.
      this.knownCodes = new Set(this.queue.map((q) => q.code));
      this.tap = createNetworkTap((text, activeCode) => {
        if (!text) return '';
        const upper = text.toUpperCase();
        // The code currently being submitted always wins. Without this, a
        // variant that differs from its parent only by case (DFUItra220 vs
        // DFUltra220) would be credited to the parent and its real verdict lost.
        if (activeCode && (text.indexOf(activeCode) !== -1 || upper.indexOf(activeCode.toUpperCase()) !== -1)) {
          return activeCode;
        }
        // Longest first so DFWIN360 never shadows DFWIN3601.
        const candidates = Array.from(this.knownCodes).sort((a, b) => b.length - a.length);
        // Exact matches across all candidates before any case-insensitive one.
        for (const code of candidates) {
          if (text.indexOf(code) !== -1) return code;
        }
        for (const code of candidates) {
          if (upper.indexOf(code.toUpperCase()) !== -1) return code;
        }
        return '';
      });
    }

    /** Register a code the tap must be able to attribute responses to. */
    trackCode(code) {
      if (code) this.knownCodes.add(code);
    }

    on(event, handler) {
      if (this.listeners[event]) this.listeners[event].push(handler);
      return this;
    }

    emit(event, payload) {
      for (const handler of this.listeners[event] || []) {
        try { handler(payload); } catch (_) { /* listener must not break the run */ }
      }
    }

    log(message, tone) {
      this.emit('log', { time: now(), message, tone: tone || 'info' });
    }

    stop(reason) {
      this.stopRequested = true;
      this.stopReason = reason || 'Đã dừng theo yêu cầu.';
    }

    pause() { this.paused = true; }
    resume() { this.paused = false; }

    summary() {
      const counts = {};
      for (const result of this.results) counts[result.status] = (counts[result.status] || 0) + 1;
      const success = this.results.filter((r) => r.status === 'SUCCESS');
      return {
        total: this.queue.length,
        processed: this.results.length,
        success: success.length,
        successCodes: success.map((r) => r.code),
        counts,
        elapsedMs: this.startedAt ? (this.endedAt || now()) - this.startedAt : 0,
        currentDelay: this.currentDelay,
      };
    }

    /** One submit + response read. Never decides SUCCESS from the DOM. */
    async attempt(code, position) {
      await clearMessages();
      const input = findInput();
      const button = findButton();
      if (!input || !button) {
        return { status: 'SCRIPT_ERROR', label: Garena.label('SCRIPT_ERROR'), detail: 'Không tìm thấy ô nhập hoặc nút Đổi trên trang.', trusted: false, errorCode: null, pageText: '' };
      }

      setValue(input, '');
      await sleep(40);
      setValue(input, code);
      await sleep(60);
      if (String(input.value).trim() !== code) {
        return { status: 'SCRIPT_ERROR', label: Garena.label('SCRIPT_ERROR'), detail: `Ô nhập không giữ đúng giá trị (đang là "${input.value}").`, trusted: false, errorCode: null, pageText: '' };
      }

      this.tap.reset();
      const attempt = { id: ++this.attemptCounter, code, startedAt: now() };
      this.tap.begin(attempt);

      let requestSent = false;
      for (let click = 0; click <= this.config.submitClickRetries; click += 1) {
        const target = click === 0 ? button : findButton();
        if (!target) break;
        realClick(target);
        const confirmStart = now();
        while (now() - confirmStart < this.config.submitConfirmMs) {
          await sleep(50);
          if (this.tap.started(attempt) || this.tap.bodyFor(attempt)) { requestSent = true; break; }
        }
        if (requestSent) break;
        if (click < this.config.submitClickRetries) this.log(`Click chưa tạo request, bấm lại: ${code}`, 'warn');
      }

      let record = null;
      const deadline = now() + this.config.responseTimeoutMs;
      while (now() < deadline) {
        await sleep(100);
        record = this.tap.bodyFor(attempt);
        if (record) break;
      }
      const pageMessage = readPageMessage();
      this.tap.end();
      closeDialog();

      if (record && record.body) {
        const verdict = Garena.classifyResponse(record.body, record.httpStatus);
        return Object.assign({}, verdict, { pageText: pageMessage.text, httpStatus: record.httpStatus, raw: record.body });
      }
      if (record && record.networkError) {
        return { status: 'NETWORK', label: Garena.label('NETWORK'), detail: `Lỗi mạng: ${record.networkError}`, trusted: false, errorCode: null, pageText: pageMessage.text };
      }

      // No network body. Describe what the page showed but never call it a win.
      const fallback = Garena.classifyText(pageMessage.text);
      if (fallback.status === 'SUCCESS' || fallback.status === 'OTHER' || fallback.status === 'NO_RESPONSE') {
        return {
          status: 'NO_RESPONSE',
          label: Garena.label('NO_RESPONSE'),
          detail: pageMessage.text
            ? `Không bắt được phản hồi mạng để xác nhận. Trang hiện: "${pageMessage.text}"`
            : (requestSent ? 'Đã gửi yêu cầu nhưng Garena không trả lời kịp.' : 'Click không tạo ra request nào.'),
          trusted: false, errorCode: null, pageText: pageMessage.text,
        };
      }
      // A clearly negative page message is informative enough to act on.
      return {
        status: fallback.status,
        label: Garena.label(fallback.status),
        detail: `Đọc từ thông báo trên trang (không có body mạng): "${pageMessage.text}"`,
        trusted: false, errorCode: null, pageText: pageMessage.text,
      };
    }

    /** Adapt pacing to how the server is behaving. */
    adjustPacing(status) {
      if (status === 'RATE_LIMITED' || status === 'NO_RESPONSE' || status === 'TEMP_ERROR' || status === 'NETWORK') {
        this.cleanStreak = 0;
        this.currentDelay = Math.min(this.config.maxDelayMs, Math.round(this.currentDelay * this.config.slowDownFactor));
        this.log(`Giãn nhịp lên ${this.currentDelay}ms do gặp ${Garena.label(status)}.`, 'warn');
        return;
      }
      this.cleanStreak += 1;
      if (this.cleanStreak >= this.config.speedUpAfter && this.currentDelay > this.config.minDelayMs) {
        this.currentDelay = Math.max(this.config.minDelayMs, this.currentDelay - this.config.speedUpStepMs);
        this.cleanStreak = 0;
      }
    }

    async run() {
      if (this.state === 'running') return this.summary();
      this.state = 'running';
      this.startedAt = now();
      this.log(`Bắt đầu ${this.queue.length} code. Nhịp ${this.currentDelay}ms, chờ phản hồi ${this.config.responseTimeoutMs}ms.`, 'info');

      try {
        for (let i = 0; i < this.queue.length; i += 1) {
          if (this.stopRequested) break;
          while (this.paused && !this.stopRequested) await sleep(300);
          if (this.stopRequested) break;

          const item = this.queue[i];
          const position = i + 1;
          const attemptsLog = [];
          let verdict = null;
          let usedCode = item.code;
          let variantsTried = [];

          this.emit('progress', { position, total: this.queue.length, code: item.code, phase: 'Đang gửi' });

          // main attempt, with retries for transient states
          for (let tryNo = 0; tryNo <= this.config.maxRetries; tryNo += 1) {
            verdict = await this.attempt(item.code, position);
            attemptsLog.push({ code: item.code, try: tryNo + 1, status: verdict.status, detail: verdict.detail });
            if (!Garena.RETRYABLE.has(verdict.status)) break;
            if (tryNo < this.config.maxRetries) {
              const wait = this.config.retryDelayMs * Math.pow(2, tryNo);
              this.emit('progress', { position, total: this.queue.length, code: item.code, phase: `Thử lại sau ${Math.round(wait / 1000)}s` });
              this.log(`${item.code}: ${Garena.label(verdict.status)} → thử lại sau ${wait}ms`, 'warn');
              await sleep(wait);
            }
          }

          // OCR variant probing, only when Garena says the code does not exist
          if (this.config.tryVariants && Garena.VARIANT_WORTHY.has(verdict.status) && item.source !== 'file') {
            const variants = Codes.ocrVariants(item.code, this.config.maxVariants);
            for (const variant of variants) {
              if (this.stopRequested) break;
              // The tap must know this code before the request goes out.
              this.trackCode(variant);
              this.emit('progress', { position, total: this.queue.length, code: variant, phase: 'Thử biến thể OCR' });
              await sleep(Math.round(this.currentDelay * 0.6));
              const probe = await this.attempt(variant, position);
              variantsTried.push({ code: variant, status: probe.status, detail: probe.detail });
              attemptsLog.push({ code: variant, try: 1, status: probe.status, detail: probe.detail, variant: true });
              if (Garena.CODE_IS_REAL.has(probe.status)) {
                this.log(`${item.code} sai OCR → ${variant} là mã thật (${Garena.label(probe.status)}).`, 'ok');
                verdict = probe;
                usedCode = variant;
                break;
              }
              if (Garena.FATAL.has(probe.status)) { verdict = probe; break; }
            }
          }

          const result = {
            position,
            total: this.queue.length,
            code: item.code,
            redeemedAs: usedCode,
            hint: item.hint || '',
            family: item.family || (Codes ? Codes.classifyFamily(item.code) : ''),
            source: item.source || '',
            status: verdict.status,
            label: verdict.label || Garena.label(verdict.status),
            detail: verdict.detail || '',
            errorCode: verdict.errorCode == null ? '' : verdict.errorCode,
            trusted: Boolean(verdict.trusted),
            pageText: verdict.pageText || '',
            variantsTried,
            attempts: attemptsLog,
            at: new Date().toISOString(),
          };
          this.results.push(result);
          this.byCode.set(item.code, result);
          this.emit('result', result);
          this.log(`[${position}/${this.queue.length}] ${result.label} — ${usedCode}${usedCode !== item.code ? ` (gốc ${item.code})` : ''}: ${result.detail}`,
            result.status === 'SUCCESS' ? 'ok' : (Garena.CODE_IS_REAL.has(result.status) ? 'info' : 'warn'));

          if (Garena.FATAL.has(result.status) && this.config.stopOnFatal) {
            this.stop(`Dừng vì ${result.label}: ${result.detail}`);
            break;
          }
          this.adjustPacing(result.status);
          if (i < this.queue.length - 1 && !this.stopRequested) {
            const jitter = Math.round(Math.random() * this.config.jitterMs);
            await sleep(this.currentDelay + jitter);
          }
        }
      } finally {
        this.endedAt = now();
        this.state = 'done';
        this.tap.restore();
      }

      const summary = this.summary();
      summary.stopped = this.stopRequested;
      summary.stopReason = this.stopReason;
      this.emit('done', summary);
      this.log(this.stopRequested ? this.stopReason : `Hoàn tất. Thành công ${summary.success}/${summary.total}.`,
        this.stopRequested ? 'warn' : 'ok');
      return summary;
    }

    /** Codes worth another pass in a later run. */
    retryable() {
      return this.results.filter((r) => Garena.RETRYABLE.has(r.status)).map((r) => r.code);
    }

    toCSV() {
      const columns = ['position', 'code', 'redeemedAs', 'status', 'label', 'errorCode', 'trusted', 'family', 'source', 'hint', 'detail', 'pageText', 'variantsTried', 'at'];
      const escape = (value) => {
        const text = value == null ? '' : String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const lines = [columns.join(',')];
      for (const r of this.results) {
        lines.push(columns.map((col) => escape(col === 'variantsTried'
          ? r.variantsTried.map((v) => `${v.code}=${v.status}`).join(' | ')
          : r[col])).join(','));
      }
      return '\ufeff' + lines.join('\r\n');
    }

    toJSON() {
      return JSON.stringify({
        tool: 'df-redeem',
        startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
        endedAt: this.endedAt ? new Date(this.endedAt).toISOString() : null,
        config: this.config,
        summary: this.summary(),
        results: this.results,
      }, null, 2);
    }
  }

  const api = { RedeemRun, DEFAULTS, SELECTORS, findInput, findButton, setValue, realClick, readPageMessage, createNetworkTap, sleep };
  root.DFRedeemEngine = api;
    return api;
}(typeof window !== 'undefined' ? window : globalThis));

const DF_REDEEM_SEED = {"version":2,"generated_at":"2026-09-25T15:15:00.000Z","note":"Seed data: 317 gift-code results from the 2026-09-25 live run, 16 user weapon presets, 4 legacy community presets.","codes":[{"code":"DF1314754","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAMMO08","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFASCEND72","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFBrilliant165","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ANIMALCUPGUN","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ANIMALCUPTANK","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFANIMALCUP","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAIM666","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DF425BountyS2","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DF425SOL","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DF51login51login","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFADVN74","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFakaonikou","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAMMX96","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFanchor945","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAPEX835","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFARMX46","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFATLA73","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAWAKEN56","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAXIOM33","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFBAEXP67","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFbeacon030","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFBLKT42","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCARRAT52","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCatalyst87","kind":"giftcode","status":"invalid","source":"file+ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFceleste516","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCL503","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFclarity152","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFclover812","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCONCORD82","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCRAFT427","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFDragon504","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFDRAGONBOAT","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFELEVATE16","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFEMBARK63","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFEnergy428","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFessence982","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFeternity717","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFExcellent659","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFExceptional305","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFFantasy742","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFFILE274","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFFlash260","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFForever395","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGalaxy250","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGENESIS05","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGiveMeBrick425","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFGKTK34","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGOGOGO425","kind":"giftcode","status":"gift_bug","source":"file+ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFharbor738","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHeroic668","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHOLIDAY421","kind":"giftcode","status":"mine","source":"file","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHorizon503","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHORIZON91","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHUNTER666","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFINSIGHT48","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFISTARRY939","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFjubilee594","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFLuckylucky425","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFLUISHERE","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFLUVUU282","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFMagic057","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFmoment479","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFmomentum423","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFNinja874","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFoasis407","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOutstanding056","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFPACK293","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFPARAGON41","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFpromise643","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRainbow356","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFReliable732","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRemarkable103","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRESOLVE19","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRL1017","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRocket825","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFserene218","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSH428","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSIXMAJOR6","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFSIXVIP888","kind":"giftcode","status":"expired","source":"file+ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFsolace241","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSpark119","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFsymphony104","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFTRNG469","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFTURING09","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUltra220","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUZI777","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUZIRAT47","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFVANGUARD76","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFVICTORY11","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFvivid061","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFvoyage901","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFVS3S7FR4","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVS8T9SZ4","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSE4K7G1","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSH5N4C7","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSU2X6M8","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSW1C5D9","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFWEAPON91","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWEEK237","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWIN777","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFWITNESS77","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWizard309","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWPNX36","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCC0001","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCEIEI01","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCHAHA5","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCOPGIST88","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPNOW111","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPPL4Y3R5","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPTOBE03","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPWINEIEI","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCOPWOR1D","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS2ZK8VA","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS3FZ9LK","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS3Y8KLM","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS4XJ8PL","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS7K2M9Q","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS7Q2VXA","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS9R2HXC","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSB4N9RD","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSB6T3WZ","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSL5Q7MN","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSW4D1YP","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260403B21","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260403B33","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260403B81","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260404B47","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260404B57","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260404B63","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260405B36","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260405B58","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260405B69","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRIDEORDIE4078","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRIDEORDIE5215","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL1629","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL1983","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL2793","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL3145","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL4412","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL4791","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL5029","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL7183","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL7789","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL8019","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL9108","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTARMAMENT","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTGEARTICKET","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTINTERMEDIATE","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C32","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C41","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C54","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C68","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C85","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C90","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C28","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C43","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C61","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C77","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C86","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C95","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTSCARH","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTSUPPYPACK","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTWEAPON","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUT2025FINALS1549","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF1276","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF2509","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF4827","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF5732","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF5910","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF8051","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF9163","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTS26GR0103C35","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0103C49","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0103C81","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0703C34","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0703C96","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1203C46","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1203C72","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1203C83","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1303C39","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1303C65","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1303C98","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1403C24","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1403C52","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1403C87","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1503C33","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1503C74","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1503C91","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2702C44","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2702C57","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2702C92","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2802C23","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2802C66","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2802C78","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL1","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL3001C47","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL3101C38","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTS26QL3101C64","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL5","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL6","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTW260412S36","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTW260412S95","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTW260412S99","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ200838","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ200880","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ200889","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ210810","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ210833","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ210862","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ220811","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ220831","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ220857","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ230872","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ230879","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ230897","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"GARENADFCBT2503C3F4","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFCBT2503X9D1","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFCBT2503Z6T9","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFID2501L983","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFID2501R572","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFID2501V621","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFNY2501E034","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFNY2501H258","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"HEDELTAFORCE3630","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE4583","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE7563","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE8032","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE8781","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE9026","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT02","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT04","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT45","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT48","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT55","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT60","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT65","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT68","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT79","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT92","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S19","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S51","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S52","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S53","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S59","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S99","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S31","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S64","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S73","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S90","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S95","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S96","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S11","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S72","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S79","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S84","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S21","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S65","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S67","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S84","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ReturningWarrior1","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ReturningWarrior2","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ReturningWarrior3","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TRILLIONRAID1000","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TRILLIONRAID300","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TRILLIONRAID600","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienboba2719","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienboba6167","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienboba6228","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienmobile3325","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienmobile7095","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienmobile7362","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"10KSUBSYOUTUBEDFRTNK","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"A5Z1NDW8K3PJLU","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ACESIXMAJOR","kind":"giftcode","status":"expired","source":"file+ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"C7S2X9J5D4B1V3Q","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GADFZebra","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"LAISEGAME","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"MOBILE0123","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SIXMAJORMVP","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SOLDFWIN360","kind":"giftcode","status":"expired","source":"file+ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SOLPROMAJOR","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"Top1BXHVN","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TrickOrTreat","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"VIP666SOLDF","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"VIP777SIXDF","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"WELCOMETODF","kind":"giftcode","status":"mine","source":"file","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"85ewN4xYbJfncPKbADR","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"aCuQjtxY7vXGjxCTBnQU","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"Bd52XmxyYj2DFGCqnq4","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"f2X6e3xY3pJDCE5rT7P","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"fvzeLrxYajwVviFSTSZ","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"hjRtrKxYLmcTyYcEy64H","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"JGHMCmxYa6PLcFgvD9mg","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"L34m5GxYjnPkXzckgdEB","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"msz7hMxxYyGhip8ay7HpK","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"N4SQWgxYcHw7gUci3bJy","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"SsCkDfxY5AkdZqjJLkXq","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SVBesCxYcsAN6LCD47P","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"XufJgVxYrFCtM5heBT3B","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"yWHtfsxYGRPaZvAfLN82","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS7KZM90","kind":"giftcode","status":"invalid","source":"file:block2","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T10:05:00.000Z","attempt_count":1,"shareable":false,"tags":["da-kiem-tra","ocr-sai"],"notes":"Kiem tra 2026-09-25 tren cdkgarena.html: 400054 cho ca ma goc va 3-4 bien the OCR. Khong phai het han - ma khong ton tai."},{"code":"DFOSS260404857","kind":"giftcode","status":"invalid","source":"file:block2","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T10:05:00.000Z","attempt_count":1,"shareable":false,"tags":["da-kiem-tra","ocr-sai"],"notes":"Kiem tra 2026-09-25 tren cdkgarena.html: 400054 cho ca ma goc va 3-4 bien the OCR. Khong phai het han - ma khong ton tai."},{"code":"FVZELRXYAJVWVFSTS2","kind":"giftcode","status":"invalid","source":"file:block2","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T10:05:00.000Z","attempt_count":1,"shareable":false,"tags":["da-kiem-tra","ocr-sai"],"notes":"Kiem tra 2026-09-25 tren cdkgarena.html: 400054 cho ca ma goc va 3-4 bien the OCR. Khong phai het han - ma khong ton tai."}],"presets":[{"code":"6KFJKLO07BHIFPGO0COS7","weapon":"AUG Assault Rifle","mode":"Chiến Trường Toàn Diện","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KP9FT00823TFSU27R1IR","weapon":"K416 Assault Rifle","mode":"Warfare","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6L8UK300A8JTQS5OHR522","weapon":"Thompson Submachine Gun (Tay Đen)","mode":"Chiến Dịch (Thoát Hiểm)","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt; source label confirmed by Vietnam community post indexed 2026-09-28","first_seen":"2026-09-25T15:15:00.000Z","notes":"Nhãn Tay Đen là build Thompson; mã chia sẻ base32-21 hiện hành."},{"code":"6LCTUP00AHP1JR9CHG3OI","weapon":"MK4 Submachine Gun","mode":"Chiến Dịch (Thoát Hiểm)","author":"NHẠC NGUYỄN","format":"base32-21","verified":true,"cost":295426,"cost_state":"unconfirmed","cost_as_of":"2026-09-21","source":"user-submitted screenshot 2026-09-28","first_seen":"2026-09-28T04:32:36.265Z"},{"code":"6KQOCNC0DGSQA4BKR9BOU","weapon":"M14 Marksman Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6K2DPRC0EFTIUBE9ION7O","weapon":"AS Val Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KRR21K07BHHUFGKQS7IG","weapon":"KC17 Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6K8O4000C4GUUFLHNO8FE","weapon":"MK4 Submachine Gun","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KOQD3G01D6SCK9GT7EFU","weapon":"MP5 Submachine Gun","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KNTJ9002BLOGMGFDMK4F","weapon":"MK47 Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KMNU780C122OV360GSH4","weapon":"M14 Marksman Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6JJ7O7807BHLT2L523U7J","weapon":"FS-12 Shotgun","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KL5IJ808VISLV9EEUC8U","weapon":"EasyB AS Val Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KMEQNG00T99PRENQV488","weapon":"AKM Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6K6LG9K09QC5OIM45IHPM","weapon":"M7 Battle Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KH5CPS02JENJFMEC6G27","weapon":"Súng Trường Xạ Thủ SVCH","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KHHFEC00T99PRENQV488","weapon":"CI-19 Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"5620492356433216746","weapon":"AKS-74 Assault Rifle","mode":"Havoc Warfare","author":"/u/YareYareDaze88","format":"numeric-19-legacy","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Preset Hop Chiến 2024 đã được Reddit lập chỉ mục đúng theo súng/chế độ; giữ để tra cứu, nhưng ứng dụng hiện tại có thể không còn nhận định dạng mã cũ này."},{"code":"5620492390792957637","weapon":"AKS-74 Assault Rifle","mode":"Havoc Warfare","author":"/u/Upstairs-Pirate-9890","format":"numeric-19-legacy","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Preset Hop Chiến 2024 đã được Reddit lập chỉ mục đúng theo súng/chế độ; giữ để tra cứu, nhưng ứng dụng hiện tại có thể không còn nhận định dạng mã cũ này."},{"code":"5620492382203032302","weapon":"Upstairs-Pirate-9890 AKS-74 Assault Rifle","mode":"Tactical Turmoil","author":"/u/Spezzare","format":"numeric-19-legacy","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Preset Hop Chiến 2024 đã được Reddit lập chỉ mục đúng theo súng/chế độ; giữ để tra cứu, nhưng ứng dụng hiện tại có thể không còn nhận định dạng mã cũ này."},{"code":"5620492343548352708","weapon":"UZI Submachine Gun","mode":"Havoc Warfare","author":"/u/Sluiskampert","format":"numeric-19-legacy","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Preset Hop Chiến 2024 đã được Reddit lập chỉ mục đúng theo súng/chế độ; giữ để tra cứu, nhưng ứng dụng hiện tại có thể không còn nhận định dạng mã cũ này."}],"updated_at":"2026-09-25T10:10:00.000Z","changelog":[{"version":2,"date":"2026-09-25","note":"3 ma chua thu (DFOS7KZM90, DFOSS260404857, FVZELRXYAJVWVFSTS2) da kiem tra that: 400054 ca ma goc va bien the OCR -> invalid."}]};
  const state = {
    version: '3.2.0',
    run: null,
    logs: [],
    results: [],
    progress: null,
    summary: null,
    finished: false,
    error: null,
  };
  state.start = function start(entries, options) {
    if (state.run && state.run.state === 'running') return 'already-running';
    state.logs = []; state.results = []; state.summary = null; state.finished = false; state.error = null;
    const run = new root.DFRedeemEngine.RedeemRun(entries, options || {});
    state.run = run;
    run.on('log', (entry) => { state.logs.push(entry); if (state.logs.length > 400) state.logs.shift(); });
    run.on('result', (result) => { state.results.push(result); });
    run.on('progress', (p) => { state.progress = p; });
    run.on('done', (summary) => { state.summary = summary; state.finished = true; });
    run.run().catch((error) => { state.error = String(error && error.stack || error); state.finished = true; });
    return 'started';
  };
  state.poll = function poll(fromIndex) {
    const from = Number(fromIndex) || 0;
    return {
      finished: state.finished,
      error: state.error,
      progress: state.progress,
      summary: state.run ? state.run.summary() : null,
      newResults: state.results.slice(from),
      totalResults: state.results.length,
      recentLogs: state.logs.slice(-6).map((l) => l.message),
    };
  };
  state.stop = function stop(reason) { if (state.run) state.run.stop(reason); return 'stopping'; };
  state.csv = function csv() { return state.run ? state.run.toCSV() : ''; };
  state.json = function json() { return state.run ? state.run.toJSON() : ''; };
  root.__dfRedeem = state;
  return 'installed';
}());
