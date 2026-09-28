/* Delta Force Auto Redeem v3.1.3
 * Built 2026-09-28T01:30:09.921Z — local build, no remote source
 *
 * Verifies every redeem against the network response body, never the popup.
 * No telemetry, no remote code, no credential access. Runs only on
 * redeem.df.garena.sg pages you already opened and logged into.
 */
/* popup.js — reads the vault read-only and routes to the right surface. */
(function dfRedeemPopup() {
  'use strict';
  const root = window;
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

  const DF_REDEEM_SEED = {"version":2,"generated_at":"2026-09-25T15:15:00.000Z","note":"Seed data: 317 gift-code results from the 2026-09-25 live run, 16 user weapon presets, 4 community presets.","codes":[{"code":"DF1314754","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAMMO08","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFASCEND72","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFBrilliant165","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ANIMALCUPGUN","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ANIMALCUPTANK","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFANIMALCUP","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAIM666","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DF425BountyS2","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DF425SOL","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DF51login51login","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFADVN74","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFakaonikou","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAMMX96","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFanchor945","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAPEX835","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFARMX46","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFATLA73","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAWAKEN56","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAXIOM33","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFBAEXP67","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFbeacon030","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFBLKT42","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCARRAT52","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCatalyst87","kind":"giftcode","status":"invalid","source":"file+ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFceleste516","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCL503","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFclarity152","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFclover812","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCONCORD82","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCRAFT427","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFDragon504","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFDRAGONBOAT","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFELEVATE16","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFEMBARK63","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFEnergy428","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFessence982","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFeternity717","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFExcellent659","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFExceptional305","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFFantasy742","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFFILE274","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFFlash260","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFForever395","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGalaxy250","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGENESIS05","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGiveMeBrick425","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFGKTK34","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGOGOGO425","kind":"giftcode","status":"gift_bug","source":"file+ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFharbor738","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHeroic668","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHOLIDAY421","kind":"giftcode","status":"mine","source":"file","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHorizon503","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHORIZON91","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHUNTER666","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFINSIGHT48","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFISTARRY939","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFjubilee594","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFLuckylucky425","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFLUISHERE","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFLUVUU282","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFMagic057","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFmoment479","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFmomentum423","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFNinja874","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFoasis407","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOutstanding056","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFPACK293","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFPARAGON41","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFpromise643","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRainbow356","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFReliable732","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRemarkable103","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRESOLVE19","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRL1017","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRocket825","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFserene218","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSH428","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSIXMAJOR6","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFSIXVIP888","kind":"giftcode","status":"expired","source":"file+ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFsolace241","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSpark119","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFsymphony104","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFTRNG469","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFTURING09","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUltra220","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUZI777","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUZIRAT47","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFVANGUARD76","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFVICTORY11","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFvivid061","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFvoyage901","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFVS3S7FR4","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVS8T9SZ4","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSE4K7G1","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSH5N4C7","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSU2X6M8","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSW1C5D9","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFWEAPON91","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWEEK237","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWIN777","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFWITNESS77","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWizard309","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWPNX36","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCC0001","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCEIEI01","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCHAHA5","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCOPGIST88","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPNOW111","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPPL4Y3R5","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPTOBE03","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPWINEIEI","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCOPWOR1D","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS2ZK8VA","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS3FZ9LK","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS3Y8KLM","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS4XJ8PL","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS7K2M9Q","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS7Q2VXA","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS9R2HXC","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSB4N9RD","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSB6T3WZ","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSL5Q7MN","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSW4D1YP","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260403B21","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260403B33","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260403B81","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260404B47","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260404B57","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260404B63","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260405B36","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260405B58","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260405B69","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRIDEORDIE4078","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRIDEORDIE5215","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL1629","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL1983","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL2793","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL3145","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL4412","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL4791","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL5029","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL7183","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL7789","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL8019","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL9108","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTARMAMENT","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTGEARTICKET","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTINTERMEDIATE","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C32","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C41","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C54","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C68","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C85","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C90","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C28","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C43","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C61","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C77","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C86","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C95","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTSCARH","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTSUPPYPACK","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTWEAPON","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUT2025FINALS1549","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF1276","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF2509","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF4827","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF5732","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF5910","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF8051","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF9163","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTS26GR0103C35","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0103C49","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0103C81","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0703C34","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0703C96","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1203C46","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1203C72","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1203C83","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1303C39","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1303C65","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1303C98","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1403C24","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1403C52","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1403C87","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1503C33","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1503C74","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1503C91","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2702C44","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2702C57","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2702C92","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2802C23","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2802C66","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2802C78","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL1","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL3001C47","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL3101C38","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTS26QL3101C64","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL5","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL6","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTW260412S36","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTW260412S95","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTW260412S99","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ200838","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ200880","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ200889","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ210810","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ210833","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ210862","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ220811","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ220831","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ220857","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ230872","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ230879","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ230897","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"GARENADFCBT2503C3F4","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFCBT2503X9D1","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFCBT2503Z6T9","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFID2501L983","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFID2501R572","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFID2501V621","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFNY2501E034","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFNY2501H258","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"HEDELTAFORCE3630","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE4583","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE7563","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE8032","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE8781","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE9026","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT02","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT04","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT45","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT48","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT55","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT60","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT65","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT68","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT79","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT92","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S19","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S51","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S52","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S53","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S59","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S99","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S31","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S64","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S73","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S90","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S95","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S96","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S11","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S72","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S79","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S84","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S21","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S65","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S67","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S84","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ReturningWarrior1","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ReturningWarrior2","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ReturningWarrior3","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TRILLIONRAID1000","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TRILLIONRAID300","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TRILLIONRAID600","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienboba2719","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienboba6167","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienboba6228","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienmobile3325","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienmobile7095","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienmobile7362","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"10KSUBSYOUTUBEDFRTNK","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"A5Z1NDW8K3PJLU","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ACESIXMAJOR","kind":"giftcode","status":"expired","source":"file+ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"C7S2X9J5D4B1V3Q","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GADFZebra","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"LAISEGAME","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"MOBILE0123","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SIXMAJORMVP","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SOLDFWIN360","kind":"giftcode","status":"expired","source":"file+ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SOLPROMAJOR","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"Top1BXHVN","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TrickOrTreat","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"VIP666SOLDF","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"VIP777SIXDF","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"WELCOMETODF","kind":"giftcode","status":"mine","source":"file","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"85ewN4xYbJfncPKbADR","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"aCuQjtxY7vXGjxCTBnQU","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"Bd52XmxyYj2DFGCqnq4","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"f2X6e3xY3pJDCE5rT7P","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"fvzeLrxYajwVviFSTSZ","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"hjRtrKxYLmcTyYcEy64H","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"JGHMCmxYa6PLcFgvD9mg","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"L34m5GxYjnPkXzckgdEB","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"msz7hMxxYyGhip8ay7HpK","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"N4SQWgxYcHw7gUci3bJy","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"SsCkDfxY5AkdZqjJLkXq","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SVBesCxYcsAN6LCD47P","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"XufJgVxYrFCtM5heBT3B","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"yWHtfsxYGRPaZvAfLN82","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS7KZM90","kind":"giftcode","status":"invalid","source":"file:block2","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T10:05:00.000Z","attempt_count":1,"shareable":false,"tags":["da-kiem-tra","ocr-sai"],"notes":"Kiem tra 2026-09-25 tren cdkgarena.html: 400054 cho ca ma goc va 3-4 bien the OCR. Khong phai het han - ma khong ton tai."},{"code":"DFOSS260404857","kind":"giftcode","status":"invalid","source":"file:block2","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T10:05:00.000Z","attempt_count":1,"shareable":false,"tags":["da-kiem-tra","ocr-sai"],"notes":"Kiem tra 2026-09-25 tren cdkgarena.html: 400054 cho ca ma goc va 3-4 bien the OCR. Khong phai het han - ma khong ton tai."},{"code":"FVZELRXYAJVWVFSTS2","kind":"giftcode","status":"invalid","source":"file:block2","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T10:05:00.000Z","attempt_count":1,"shareable":false,"tags":["da-kiem-tra","ocr-sai"],"notes":"Kiem tra 2026-09-25 tren cdkgarena.html: 400054 cho ca ma goc va 3-4 bien the OCR. Khong phai het han - ma khong ton tai."}],"presets":[{"code":"6KFJKLO07BHIFPGO0COS7","weapon":"AUG Assault Rifle","mode":"Chiến Trường Toàn Diện","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KP9FT00823TFSU27R1IR","weapon":"K416 Assault Rifle","mode":"Warfare","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6L8UK300A8JTQS5OHR522","weapon":"Tay Đen","mode":"Chiến Dịch (Thoát Hiểm)","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KQOCNC0DGSQA4BKR9BOU","weapon":"M14 Marksman Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6K2DPRC0EFTIUBE9ION7O","weapon":"AS Val Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KRR21K07BHHUFGKQS7IG","weapon":"KC17 Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6K8O4000C4GUUFLHNO8FE","weapon":"MK4 Submachine Gun","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KOQD3G01D6SCK9GT7EFU","weapon":"MP5 Submachine Gun","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KNTJ9002BLOGMGFDMK4F","weapon":"MK47 Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KMNU780C122OV360GSH4","weapon":"M14 Marksman Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6JJ7O7807BHLT2L523U7J","weapon":"FS-12 Shotgun","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KL5IJ808VISLV9EEUC8U","weapon":"EasyB AS Val Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KMEQNG00T99PRENQV488","weapon":"AKM Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6K6LG9K09QC5OIM45IHPM","weapon":"M7 Battle Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KH5CPS02JENJFMEC6G27","weapon":"Súng Trường Xạ Thủ SVCH","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KHHFEC00T99PRENQV488","weapon":"CI-19 Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"5620492356433216746","weapon":"AKS-74 Assault Rifle","mode":"Havoc Warfare","author":"/u/YareYareDaze88","format":"numeric-19","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Dinh dang cu 2024; kha nang cao khong con nhap duoc"},{"code":"5620492390792957637","weapon":"AKS-74 Assault Rifle","mode":"Havoc Warfare","author":"/u/Upstairs-Pirate-9890","format":"numeric-19","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Dinh dang cu 2024; kha nang cao khong con nhap duoc"},{"code":"5620492382203032302","weapon":"Upstairs-Pirate-9890 AKS-74 Assault Rifle","mode":"Tactical Turmoil","author":"/u/Spezzare","format":"numeric-19","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Dinh dang cu 2024; kha nang cao khong con nhap duoc"},{"code":"5620492343548352708","weapon":"UZI Submachine Gun","mode":"Havoc Warfare","author":"/u/Sluiskampert","format":"numeric-19","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Dinh dang cu 2024; kha nang cao khong con nhap duoc"}],"updated_at":"2026-09-25T10:10:00.000Z","changelog":[{"version":2,"date":"2026-09-25","note":"3 ma chua thu (DFOS7KZM90, DFOSS260404857, FVZELRXYAJVWVFSTS2) da kiem tra that: 400054 ca ma goc va bien the OCR -> invalid."}]};

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  /* Buttons carry a <small> hint; writing textContent would delete it, so
   * transient feedback only replaces the first text node. */
  const setLabel = (btn, text) => {
    const first = btn.firstChild;
    if (first && first.nodeType === 3) first.nodeValue = text;
    else btn.insertBefore(document.createTextNode(text), btn.firstChild);
  };

  (async function main() {
    const v = new root.DFRedeemVault.Vault({ adapter: new root.DFRedeemVault.IndexedDBAdapter() });
    let gifts = [], presets = [], stats = { byStatus: {} };
    try {
      await v.init();
      await v.seedOnFirstRun(DF_REDEEM_SEED);
      const all = await v.all();
      presets = await v.presets();
      const presetCodes = new Set(presets.map((r) => r.code));
      gifts = all.filter((r) => !presetCodes.has(r.code));
      stats = await v.stats();
    } catch (e) {
      document.getElementById('foot').textContent = 'Không đọc được kho: ' + e.message;
    }
    const by = stats.byStatus || {};
    const share = gifts.filter((r) => r.status === 'success' || r.status === 'mine');
    const untried = gifts.filter((r) => r.status === 'untried');

    /* Plain-language tiles: a first-time user should learn what the numbers
     * mean without opening the full dashboard. "Chưa thử" alone read as
     * meaningless when it was 0, so each tile carries its own hint line. */
    document.getElementById('k').innerHTML =
      '<div class="kpi ok"><b>' + share.length + '</b><span>Mã tặng được</span>' +
        '<i>đã đổi xong, gửi cho bạn bè</i></div>' +
      '<div class="kpi warn"><b>' + untried.length + '</b><span>Mã chờ đổi</span>' +
        '<i>' + (untried.length ? 'bấm Chạy đổi để thử' : 'đã thử hết kho') + '</i></div>';
    document.getElementById('foot').textContent =
      'Kho: ' + gifts.length + ' mã quà · ' + presets.length + ' mã lắp súng';

    document.getElementById('open-app').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
    });
    document.getElementById('open-drawer').addEventListener('click', async () => {
      const btn = document.getElementById('open-drawer');
      try {
        const r = await chrome.runtime.sendMessage({ type: 'DF_REDEEM_OPEN_DRAWER' });
        if (r && r.ok) return window.close();
        setLabel(btn, (r && r.error) || 'Không mở được');
      } catch (e) { setLabel(btn, 'Không mở được'); }
      setTimeout(() => { setLabel(btn, 'Mở bảng trên tab này'); }, 2200);
    });
    document.getElementById('open-redeem').addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://redeem.df.garena.sg/vi/cdkgarena.html' });
    });
    document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
    document.getElementById('copy-share').addEventListener('click', async () => {
      const btn = document.getElementById('copy-share');
      try {
        await navigator.clipboard.writeText(share.map((r) => r.code).join('\n'));
        setLabel(btn, 'Đã copy ' + share.length + ' mã ✓');
      } catch (_) { setLabel(btn, 'Không copy được'); }
      setTimeout(() => { setLabel(btn, 'Copy danh sách chia sẻ'); }, 2000);
    });
  }());
}());
