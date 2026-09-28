/* Delta Force Auto Redeem v3.1.3
 * Built v3.1.3 — local build, no remote source
 *
 * Verifies every redeem against the network response body, never the popup.
 * No telemetry, no remote code, no credential access. Runs only on
 * redeem.df.garena.sg pages you already opened and logged into.
 */
(function dfRedeemConsole() {
  'use strict';
  if (!/redeem\.df\.garena\.sg$/.test(location.hostname)) {
    console.error('[DF Redeem] Hãy mở https://redeem.df.garena.sg/vi/cdkgarena.html rồi dán lại script này.');
    return;
  }
  if (window.__dfRedeemPanel) { window.__dfRedeemPanel.open(); return; }
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

    return { registerBackend, syncNow, status, getSettings, getLocal, setLocal, compactDelta, mergeDeltas, serializeExport, parseImport, publicSettings, fetchCommunity, reportOutcomes, mergeCommunityCodes, keys: { SETTINGS_KEY, RECORDS_KEY, STATUS_KEY, SYNC_DELTA_KEY, SYNC_MANIFEST_KEY, SYNC_CHUNK_PREFIX } };
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

const DF_REDEEM_SEED = {"version":2,"generated_at":"2026-09-25T15:15:00.000Z","note":"Seed data: 317 gift-code results from the 2026-09-25 live run, 16 user weapon presets, 4 community presets.","codes":[{"code":"DF1314754","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAMMO08","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFASCEND72","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFBrilliant165","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ANIMALCUPGUN","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ANIMALCUPTANK","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFANIMALCUP","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAIM666","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DF425BountyS2","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DF425SOL","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DF51login51login","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFADVN74","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFakaonikou","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAMMX96","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFanchor945","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAPEX835","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFARMX46","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFATLA73","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAWAKEN56","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAXIOM33","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFBAEXP67","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFbeacon030","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFBLKT42","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCARRAT52","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCatalyst87","kind":"giftcode","status":"invalid","source":"file+ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFceleste516","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCL503","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFclarity152","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFclover812","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCONCORD82","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCRAFT427","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFDragon504","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFDRAGONBOAT","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFELEVATE16","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFEMBARK63","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFEnergy428","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFessence982","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFeternity717","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFExcellent659","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFExceptional305","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFFantasy742","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFFILE274","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFFlash260","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFForever395","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGalaxy250","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGENESIS05","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGiveMeBrick425","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFGKTK34","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGOGOGO425","kind":"giftcode","status":"gift_bug","source":"file+ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFharbor738","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHeroic668","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHOLIDAY421","kind":"giftcode","status":"mine","source":"file","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHorizon503","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHORIZON91","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHUNTER666","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFINSIGHT48","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFISTARRY939","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFjubilee594","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFLuckylucky425","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFLUISHERE","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFLUVUU282","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFMagic057","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFmoment479","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFmomentum423","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFNinja874","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFoasis407","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOutstanding056","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFPACK293","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFPARAGON41","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFpromise643","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRainbow356","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFReliable732","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRemarkable103","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRESOLVE19","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRL1017","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRocket825","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFserene218","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSH428","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSIXMAJOR6","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFSIXVIP888","kind":"giftcode","status":"expired","source":"file+ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFsolace241","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSpark119","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFsymphony104","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFTRNG469","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFTURING09","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUltra220","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUZI777","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUZIRAT47","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFVANGUARD76","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFVICTORY11","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFvivid061","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFvoyage901","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFVS3S7FR4","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVS8T9SZ4","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSE4K7G1","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSH5N4C7","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSU2X6M8","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSW1C5D9","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFWEAPON91","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWEEK237","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWIN777","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFWITNESS77","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWizard309","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWPNX36","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCC0001","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCEIEI01","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCHAHA5","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCOPGIST88","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPNOW111","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPPL4Y3R5","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPTOBE03","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPWINEIEI","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCOPWOR1D","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS2ZK8VA","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS3FZ9LK","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS3Y8KLM","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS4XJ8PL","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS7K2M9Q","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS7Q2VXA","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS9R2HXC","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSB4N9RD","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSB6T3WZ","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSL5Q7MN","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSW4D1YP","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260403B21","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260403B33","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260403B81","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260404B47","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260404B57","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260404B63","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260405B36","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260405B58","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260405B69","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRIDEORDIE4078","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRIDEORDIE5215","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL1629","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL1983","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL2793","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL3145","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL4412","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL4791","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL5029","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL7183","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL7789","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL8019","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL9108","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTARMAMENT","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTGEARTICKET","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTINTERMEDIATE","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C32","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C41","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C54","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C68","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C85","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C90","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C28","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C43","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C61","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C77","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C86","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C95","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTSCARH","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTSUPPYPACK","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTWEAPON","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUT2025FINALS1549","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF1276","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF2509","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF4827","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF5732","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF5910","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF8051","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF9163","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTS26GR0103C35","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0103C49","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0103C81","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0703C34","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0703C96","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1203C46","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1203C72","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1203C83","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1303C39","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1303C65","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1303C98","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1403C24","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1403C52","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1403C87","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1503C33","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1503C74","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1503C91","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2702C44","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2702C57","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2702C92","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2802C23","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2802C66","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2802C78","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL1","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL3001C47","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL3101C38","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTS26QL3101C64","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL5","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL6","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTW260412S36","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTW260412S95","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTW260412S99","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ200838","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ200880","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ200889","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ210810","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ210833","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ210862","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ220811","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ220831","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ220857","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ230872","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ230879","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ230897","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"GARENADFCBT2503C3F4","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFCBT2503X9D1","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFCBT2503Z6T9","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFID2501L983","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFID2501R572","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFID2501V621","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFNY2501E034","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFNY2501H258","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"HEDELTAFORCE3630","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE4583","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE7563","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE8032","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE8781","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE9026","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT02","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT04","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT45","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT48","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT55","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT60","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT65","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT68","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT79","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT92","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S19","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S51","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S52","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S53","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S59","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S99","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S31","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S64","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S73","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S90","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S95","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S96","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S11","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S72","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S79","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S84","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S21","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S65","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S67","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S84","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ReturningWarrior1","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ReturningWarrior2","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ReturningWarrior3","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TRILLIONRAID1000","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TRILLIONRAID300","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TRILLIONRAID600","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienboba2719","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienboba6167","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienboba6228","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienmobile3325","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienmobile7095","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienmobile7362","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"10KSUBSYOUTUBEDFRTNK","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"A5Z1NDW8K3PJLU","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ACESIXMAJOR","kind":"giftcode","status":"expired","source":"file+ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"C7S2X9J5D4B1V3Q","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GADFZebra","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"LAISEGAME","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"MOBILE0123","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SIXMAJORMVP","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SOLDFWIN360","kind":"giftcode","status":"expired","source":"file+ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SOLPROMAJOR","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"Top1BXHVN","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TrickOrTreat","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"VIP666SOLDF","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"VIP777SIXDF","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"WELCOMETODF","kind":"giftcode","status":"mine","source":"file","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"85ewN4xYbJfncPKbADR","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"aCuQjtxY7vXGjxCTBnQU","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"Bd52XmxyYj2DFGCqnq4","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"f2X6e3xY3pJDCE5rT7P","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"fvzeLrxYajwVviFSTSZ","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"hjRtrKxYLmcTyYcEy64H","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"JGHMCmxYa6PLcFgvD9mg","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"L34m5GxYjnPkXzckgdEB","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"msz7hMxxYyGhip8ay7HpK","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"N4SQWgxYcHw7gUci3bJy","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"SsCkDfxY5AkdZqjJLkXq","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SVBesCxYcsAN6LCD47P","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"XufJgVxYrFCtM5heBT3B","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"yWHtfsxYGRPaZvAfLN82","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS7KZM90","kind":"giftcode","status":"invalid","source":"file:block2","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T10:05:00.000Z","attempt_count":1,"shareable":false,"tags":["da-kiem-tra","ocr-sai"],"notes":"Kiem tra 2026-09-25 tren cdkgarena.html: 400054 cho ca ma goc va 3-4 bien the OCR. Khong phai het han - ma khong ton tai."},{"code":"DFOSS260404857","kind":"giftcode","status":"invalid","source":"file:block2","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T10:05:00.000Z","attempt_count":1,"shareable":false,"tags":["da-kiem-tra","ocr-sai"],"notes":"Kiem tra 2026-09-25 tren cdkgarena.html: 400054 cho ca ma goc va 3-4 bien the OCR. Khong phai het han - ma khong ton tai."},{"code":"FVZELRXYAJVWVFSTS2","kind":"giftcode","status":"invalid","source":"file:block2","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T10:05:00.000Z","attempt_count":1,"shareable":false,"tags":["da-kiem-tra","ocr-sai"],"notes":"Kiem tra 2026-09-25 tren cdkgarena.html: 400054 cho ca ma goc va 3-4 bien the OCR. Khong phai het han - ma khong ton tai."}],"presets":[{"code":"6KFJKLO07BHIFPGO0COS7","weapon":"AUG Assault Rifle","mode":"Chiến Trường Toàn Diện","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KP9FT00823TFSU27R1IR","weapon":"K416 Assault Rifle","mode":"Warfare","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6L8UK300A8JTQS5OHR522","weapon":"Tay Đen","mode":"Chiến Dịch (Thoát Hiểm)","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KQOCNC0DGSQA4BKR9BOU","weapon":"M14 Marksman Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6K2DPRC0EFTIUBE9ION7O","weapon":"AS Val Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KRR21K07BHHUFGKQS7IG","weapon":"KC17 Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6K8O4000C4GUUFLHNO8FE","weapon":"MK4 Submachine Gun","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KOQD3G01D6SCK9GT7EFU","weapon":"MP5 Submachine Gun","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KNTJ9002BLOGMGFDMK4F","weapon":"MK47 Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KMNU780C122OV360GSH4","weapon":"M14 Marksman Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6JJ7O7807BHLT2L523U7J","weapon":"FS-12 Shotgun","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KL5IJ808VISLV9EEUC8U","weapon":"EasyB AS Val Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KMEQNG00T99PRENQV488","weapon":"AKM Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6K6LG9K09QC5OIM45IHPM","weapon":"M7 Battle Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KH5CPS02JENJFMEC6G27","weapon":"Súng Trường Xạ Thủ SVCH","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KHHFEC00T99PRENQV488","weapon":"CI-19 Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"5620492356433216746","weapon":"AKS-74 Assault Rifle","mode":"Havoc Warfare","author":"/u/YareYareDaze88","format":"numeric-19","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Dinh dang cu 2024; kha nang cao khong con nhap duoc"},{"code":"5620492390792957637","weapon":"AKS-74 Assault Rifle","mode":"Havoc Warfare","author":"/u/Upstairs-Pirate-9890","format":"numeric-19","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Dinh dang cu 2024; kha nang cao khong con nhap duoc"},{"code":"5620492382203032302","weapon":"Upstairs-Pirate-9890 AKS-74 Assault Rifle","mode":"Tactical Turmoil","author":"/u/Spezzare","format":"numeric-19","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Dinh dang cu 2024; kha nang cao khong con nhap duoc"},{"code":"5620492343548352708","weapon":"UZI Submachine Gun","mode":"Havoc Warfare","author":"/u/Sluiskampert","format":"numeric-19","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Dinh dang cu 2024; kha nang cao khong con nhap duoc"}],"updated_at":"2026-09-25T10:10:00.000Z","changelog":[{"version":2,"date":"2026-09-25","note":"3 ma chua thu (DFOS7KZM90, DFOSS260404857, FVZELRXYAJVWVFSTS2) da kiem tra that: 400054 ca ma goc va bien the OCR -> invalid."}]};
const DF_THEME_CSS = "/* theme.css — one design system for every surface: in-page drawer, full-page\r\n * app, toolbar popup, options. Loaded into a shadow root (drawer) or a real\r\n * document (page/popup/options), so everything is class-scoped, never :host-only.\r\n *\r\n * Direction: \"tactical ops console\". Hairline grids, corner ticks, stencil\r\n * labels, tabular numerals. Amber is reserved for genuine warnings so status\r\n * colour always means the same thing across all four surfaces.\r\n */\r\n\r\n.df {\r\n  /* ── surface ── */\r\n  --void: #05080a;\r\n  --bg: #080d10;\r\n  --panel: #0b1317;\r\n  --raised: #101b20;\r\n  --sunken: #04090b;\r\n  --line: #1c2c33;\r\n  --line-soft: #142127;\r\n\r\n  /* ── ink ── */\r\n  --ink: #e8f6f2;\r\n  /* Contrast measured on the live panel against --raised: the old dim/mute pair\r\n   * sat at ~4.9 and ~3.0. At the 10.5–11.5px used by hints, pills and table\r\n   * text that is legible only in theory, so both are lifted: dim clears 7:1\r\n   * (AAA at this size) and mute clears AA instead of failing it outright. */\r\n  --ink-dim: #b8ccc8;\r\n  --ink-mute: #8ba39e;\r\n\r\n  /* ── signal ── */\r\n  --primary: #2ee6c8;\r\n  --primary-dim: #14a693;\r\n  --primary-glow: rgba(46, 230, 200, .18);\r\n  --amber: #ffb340;\r\n  --danger: #ff5f6d;\r\n  --violet: #a98bfa;\r\n  --sky: #4fb8f5;\r\n\r\n  /* ── status (one source of truth) ── */\r\n  --s-success: #2ee6c8;\r\n  --s-mine: #4fb8f5;\r\n  /* Group cap is adjacent to `mine` (both are \"this account\", not \"dead code\")\r\n   * but must stay distinguishable at a glance, so it takes the violet-blue\r\n   * neighbour rather than a second shade of sky. */\r\n  --s-group_limit: #7aa2f7;\r\n  --s-untried: #ffb340;\r\n  /* Garena-side failure: deliberately grey-blue, never red — nothing is wrong\r\n   * with the code and the row must not read as a dead verdict. */\r\n  --s-sys_error: #8b9fb0;\r\n  --s-expired: #6b8480;\r\n  --s-exhausted: #c89b5a;\r\n  --s-gift_bug: #a98bfa;\r\n  --s-invalid: #ff5f6d;\r\n\r\n  --r: 3px;\r\n  --r-lg: 5px;\r\n  --gap: 14px;\r\n  --mono: ui-monospace, \"SF Mono\", \"Cascadia Mono\", Consolas, monospace;\r\n  --sans: \"Inter\", system-ui, -apple-system, \"Segoe UI\", sans-serif;\r\n\r\n  color: var(--ink);\r\n  font-family: var(--sans);\r\n  font-size: 13px;\r\n  line-height: 1.5;\r\n  -webkit-font-smoothing: antialiased;\r\n}\r\n\r\n.df *, .df *::before, .df *::after { box-sizing: border-box; }\r\n/* `hidden` must win over any component display rule. The descendant form alone\r\n * misses elements that are themselves the `.df` root — the command palette and\r\n * the toast stack sit directly in the shadow root, so `hidden` silently lost to\r\n * their own `display: grid` and the palette stayed over the whole page. */\r\n.df[hidden], .df [hidden] { display: none !important; }\r\n.df button, .df input, .df select, .df textarea { font: inherit; color: inherit; }\r\n.df :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }\r\n.df ::-webkit-scrollbar { width: 10px; height: 10px; }\r\n.df ::-webkit-scrollbar-track { background: var(--sunken); }\r\n.df ::-webkit-scrollbar-thumb { background: #1d2f35; border: 2px solid var(--sunken); border-radius: 6px; }\r\n.df ::-webkit-scrollbar-thumb:hover { background: #2a454d; }\r\n\r\n/* ── stencil label ─────────────────────────────────────────────────────── */\r\n.df .stencil {\r\n  margin: 0;\r\n  color: var(--ink-mute);\r\n  font-size: 9.5px;\r\n  font-weight: 700;\r\n  letter-spacing: .16em;\r\n  text-transform: uppercase;\r\n}\r\n\r\n/* ── corner-ticked slab: the signature shape ───────────────────────────── */\r\n.df .slab {\r\n  position: relative;\r\n  padding: 13px 14px;\r\n  border: 1px solid var(--line);\r\n  background:\r\n    linear-gradient(180deg, rgba(255,255,255,.022), transparent 70px),\r\n    var(--panel);\r\n}\r\n.df .slab::before,\r\n.df .slab::after {\r\n  content: \"\";\r\n  position: absolute;\r\n  width: 7px; height: 7px;\r\n  border-color: var(--primary);\r\n  opacity: .5;\r\n  pointer-events: none;\r\n}\r\n.df .slab::before { top: -1px; left: -1px; border-top: 1px solid; border-left: 1px solid; }\r\n.df .slab::after { bottom: -1px; right: -1px; border-bottom: 1px solid; border-right: 1px solid; }\r\n\r\n/* ── buttons ───────────────────────────────────────────────────────────── */\r\n.df .btn {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  gap: 7px;\r\n  padding: 0 13px;\r\n  height: 32px;\r\n  border: 1px solid var(--line);\r\n  border-radius: var(--r);\r\n  background: var(--raised);\r\n  color: var(--ink-dim);\r\n  cursor: pointer;\r\n  font-size: 12px;\r\n  font-weight: 600;\r\n  white-space: nowrap;\r\n  transition: border-color .12s, color .12s, background .12s;\r\n}\r\n.df .btn:hover { border-color: var(--primary-dim); color: var(--ink); background: #14232a; }\r\n.df .btn:active { transform: translateY(1px); }\r\n.df .btn[disabled] { opacity: .4; cursor: not-allowed; }\r\n.df .btn.primary {\r\n  border-color: transparent;\r\n  background: linear-gradient(180deg, var(--primary), var(--primary-dim));\r\n  color: #04120f;\r\n  font-weight: 700;\r\n}\r\n.df .btn.primary:hover { filter: brightness(1.1); background: linear-gradient(180deg, var(--primary), var(--primary-dim)); }\r\n.df .btn.danger { border-color: #4a2228; color: #ff9aa3; }\r\n.df .btn.danger:hover { border-color: var(--danger); color: var(--danger); background: #1d1013; }\r\n.df .btn.sm { height: 26px; padding: 0 9px; font-size: 11px; }\r\n.df .btn.icon { width: 32px; padding: 0; justify-content: center; font-size: 15px; }\r\n.df .btn.icon.sm { width: 26px; }\r\n.df .link {\r\n  border: 0; padding: 2px 4px; background: none;\r\n  color: var(--primary); cursor: pointer;\r\n  font-size: 11.5px; font-weight: 600;\r\n}\r\n.df .link:hover { text-decoration: underline; }\r\n\r\n/* ── inputs ────────────────────────────────────────────────────────────── */\r\n.df .input, .df select, .df textarea {\r\n  width: 100%;\r\n  padding: 7px 10px;\r\n  border: 1px solid var(--line);\r\n  border-radius: var(--r);\r\n  background: var(--sunken);\r\n  outline: 0;\r\n  font-size: 12.5px;\r\n}\r\n.df .input:focus, .df select:focus, .df textarea:focus {\r\n  border-color: var(--primary-dim);\r\n  box-shadow: 0 0 0 3px var(--primary-glow);\r\n}\r\n.df textarea { min-height: 120px; resize: vertical; font-family: var(--mono); font-size: 12px; line-height: 1.6; }\r\n.df select { cursor: pointer; }\r\n.df .field { display: grid; gap: 5px; }\r\n.df .field > .stencil { margin-bottom: 1px; }\r\n.df .search { position: relative; }\r\n.df .search .input { padding-left: 30px; }\r\n.df .search::before {\r\n  content: \"⌕\";\r\n  position: absolute; left: 10px; top: 50%;\r\n  transform: translateY(-50%);\r\n  color: var(--ink-mute); font-size: 15px;\r\n}\r\n\r\n/* ── KPI ───────────────────────────────────────────────────────────────── */\r\n.df .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 10px; }\r\n.df .kpi { position: relative; padding: 12px 13px; border: 1px solid var(--line); background: var(--panel); overflow: hidden; }\r\n.df .kpi::after {\r\n  content: \"\"; position: absolute; inset: 0 auto 0 0; width: 2px;\r\n  background: var(--accent, var(--primary));\r\n}\r\n.df .kpi b {\r\n  display: block;\r\n  color: var(--accent, var(--primary));\r\n  font-size: 27px; font-weight: 700; line-height: 1.05;\r\n  font-variant-numeric: tabular-nums;\r\n  letter-spacing: -.02em;\r\n}\r\n.df .kpi span { display: block; margin-top: 3px; color: var(--ink-mute); font-size: 10.5px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; }\r\n.df .kpi small { display: block; margin-top: 5px; color: var(--ink-mute); font-size: 10.5px; }\r\n.df .kpi.ok { --accent: var(--s-success); }\r\n.df .kpi.share { --accent: var(--sky); }\r\n.df .kpi.warn { --accent: var(--amber); }\r\n.df .kpi.preset { --accent: var(--violet); }\r\n\r\n/* ── distribution bars ─────────────────────────────────────────────────── */\r\n.df .bars { display: grid; gap: 7px; }\r\n.df .bar-row { display: grid; grid-template-columns: 96px 1fr 46px; align-items: center; gap: 10px; }\r\n.df .bl { color: var(--ink-dim); font-size: 11.5px; }\r\n.df .bt { height: 7px; border-radius: 2px; background: var(--sunken); overflow: hidden; }\r\n.df .fill { display: block; height: 100%; background: var(--primary); transition: width .45s cubic-bezier(.2,.8,.3,1); }\r\n.df .bn { color: var(--ink); font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }\r\n.df .fill.s-success { background: var(--s-success); }\r\n.df .fill.s-mine { background: var(--s-mine); }\r\n.df .fill.s-group_limit { background: var(--s-group_limit); }\r\n.df .fill.s-untried { background: var(--s-untried); }\r\n.df .fill.s-sys_error { background: var(--s-sys_error); }\r\n.df .fill.s-expired { background: var(--s-expired); }\r\n.df .fill.s-exhausted { background: var(--s-exhausted); }\r\n.df .fill.s-gift_bug { background: var(--s-gift_bug); }\r\n.df .fill.s-invalid { background: var(--s-invalid); }\r\n\r\n/* ── status pill ───────────────────────────────────────────────────────── */\r\n.df .pill {\r\n  display: inline-flex; align-items: center; gap: 5px;\r\n  padding: 2px 8px 2px 6px;\r\n  border: 1px solid color-mix(in srgb, var(--c, var(--ink-mute)) 40%, transparent);\r\n  border-radius: 10px;\r\n  background: color-mix(in srgb, var(--c, var(--ink-mute)) 12%, transparent);\r\n  color: var(--c, var(--ink-dim));\r\n  font-size: 10.5px; font-weight: 600; white-space: nowrap;\r\n}\r\n.df .pill::before { content: \"\"; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }\r\n.df .pill.p-success { --c: var(--s-success); }\r\n.df .pill.p-mine { --c: var(--s-mine); }\r\n.df .pill.p-group_limit { --c: var(--s-group_limit); }\r\n.df .pill.p-untried { --c: var(--s-untried); }\r\n.df .pill.p-sys_error { --c: var(--s-sys_error); }\r\n.df .pill.p-expired { --c: var(--s-expired); }\r\n.df .pill.p-exhausted { --c: var(--s-exhausted); }\r\n.df .pill.p-gift_bug { --c: var(--s-gift_bug); }\r\n.df .pill.p-invalid { --c: var(--s-invalid); }\r\n\r\n/* ── table ─────────────────────────────────────────────────────────────── */\r\n.df .grid { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; }\r\n.df .grid th {\r\n  position: sticky; top: 0; z-index: 2;\r\n  padding: 8px 10px;\r\n  border-bottom: 1px solid var(--line);\r\n  background: var(--bg);\r\n  color: var(--ink-mute);\r\n  font-size: 9.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;\r\n  text-align: left;\r\n  white-space: nowrap;\r\n}\r\n.df .grid td { padding: 7px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }\r\n.df .grid tbody tr:hover td { background: rgba(46,230,200,.045); }\r\n.df .grid tbody tr.sel td { background: rgba(79,184,245,.09); }\r\n.df .grid .num { font-variant-numeric: tabular-nums; text-align: right; }\r\n.df .grid .note { max-width: 260px; color: var(--ink-dim); font-size: 11.5px; }\r\n.df .grid .empty { padding: 34px 10px; color: var(--ink-mute); text-align: center; }\r\n.df .mono { font-family: var(--mono); font-size: 12px; letter-spacing: .02em; }\r\n.df .row-acts { text-align: right; white-space: nowrap; }\r\n.df .grid tbody tr .row-acts .link { opacity: 0; transition: opacity .12s; }\r\n.df .grid tbody tr:hover .row-acts .link, .df .grid tbody tr:focus-within .row-acts .link { opacity: 1; }\r\n.df .tablewrap { border: 1px solid var(--line); background: var(--panel); overflow: auto; }\r\n\r\n/* ── callout ───────────────────────────────────────────────────────────── */\r\n.df .callout {\r\n  display: flex; gap: 10px;\r\n  padding: 11px 13px;\r\n  border: 1px solid color-mix(in srgb, var(--c, var(--primary)) 30%, transparent);\r\n  border-left: 2px solid var(--c, var(--primary));\r\n  background: color-mix(in srgb, var(--c, var(--primary)) 7%, transparent);\r\n  color: var(--ink-dim);\r\n  font-size: 12px;\r\n}\r\n.df .callout b { color: var(--ink); }\r\n.df .callout.warn { --c: var(--amber); }\r\n.df .callout.preset { --c: var(--violet); }\r\n.df .callout.danger { --c: var(--danger); }\r\n.df .callout .ico { flex: none; color: var(--c, var(--primary)); font-size: 14px; line-height: 1.3; }\r\n\r\n/* ── misc ──────────────────────────────────────────────────────────────── */\r\n.df .muted { color: var(--ink-mute); font-size: 11.5px; }\r\n.df .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }\r\n.df .spacer { flex: 1 1 auto; }\r\n.df .sec { display: grid; gap: 10px; }\r\n.df h3.sec-h { margin: 0; color: var(--ink); font-size: 12.5px; font-weight: 700; letter-spacing: .02em; }\r\n.df h3.sec-h small { margin-left: 6px; color: var(--ink-mute); font-size: 11px; font-weight: 600; }\r\n.df .divider { height: 1px; background: var(--line-soft); }\r\n.df .chip {\r\n  display: inline-flex; align-items: center; gap: 5px;\r\n  padding: 3px 8px; border: 1px solid var(--line); border-radius: 10px;\r\n  background: var(--sunken);   /* explicit: a <button>.chip would otherwise keep\r\n                                * Chrome's pale default and vanish on dark UI */\r\n  color: var(--ink-dim); font-size: 10.5px; font-weight: 600;\r\n}\r\n/* Only the interactive chip gets the 32px floor: a plain .chip is a static\r\n * label (status legend, meta row) and forcing it taller just adds dead space. */\r\n.df button.chip { cursor: pointer; min-height: 32px; padding: 3px 11px; font-size: 11.5px; }\r\n.df button.chip:hover { border-color: var(--primary-dim); color: var(--ink); }\r\n.df .chip.on { border-color: var(--primary-dim); color: var(--primary); background: var(--primary-glow); }\r\n\r\n/* ── progress ──────────────────────────────────────────────────────────── */\r\n.df .prog { height: 5px; border-radius: 3px; background: var(--sunken); overflow: hidden; }\r\n.df .prog i { display: block; height: 100%; background: linear-gradient(90deg, var(--primary-dim), var(--primary)); transition: width .3s; }\r\n.df .live { display: grid; gap: 4px; max-height: 190px; padding: 10px; border: 1px solid var(--line); background: var(--sunken); overflow: auto; font-family: var(--mono); font-size: 11.5px; }\r\n.df .live div { color: var(--ink-dim); }\r\n.df .live div.ok { color: var(--s-success); }\r\n.df .live div.err { color: var(--danger); }\r\n.df .live div.warn { color: var(--amber); }\r\n\r\n/* ── toasts ────────────────────────────────────────────────────────────── */\r\n.df .toasts { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: grid; gap: 7px; justify-items: end; pointer-events: none; }\r\n.df .toast {\r\n  padding: 9px 13px;\r\n  border: 1px solid var(--line);\r\n  border-left: 2px solid var(--primary);\r\n  border-radius: var(--r);\r\n  background: var(--raised);\r\n  box-shadow: 0 10px 30px rgba(0,0,0,.55);\r\n  color: var(--ink);\r\n  font-size: 12px; font-weight: 500;\r\n  opacity: 0; transform: translateY(6px);\r\n  transition: opacity .2s, transform .2s;\r\n}\r\n.df .toast.in { opacity: 1; transform: none; }\r\n.df .toast.ok { border-left-color: var(--s-success); }\r\n.df .toast.err { border-left-color: var(--danger); }\r\n.df .toast.warn { border-left-color: var(--amber); }\r\n\r\n/* ── skeleton ──────────────────────────────────────────────────────────── */\r\n.df .skel { border-radius: var(--r); background: linear-gradient(90deg, #0e181c 25%, #16242a 50%, #0e181c 75%); background-size: 200% 100%; animation: df-shim 1.3s infinite; }\r\n@keyframes df-shim { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }\r\n\r\n@media (prefers-reduced-motion: reduce) {\r\n  .df *, .df *::before, .df *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }\r\n}\r\n\n/* components.css — the view layer of the design system.\r\n *\r\n * theme.css owns tokens and primitives; this file owns every class the view\r\n * renderers in panel.js actually emit. The two are concatenated at build time\r\n * into one theme.css, so a class defined here is available on all four\r\n * surfaces (drawer shadow root, full page, popup, options).\r\n *\r\n * Rule of thumb: if panel.js writes a class into markup, it gets a rule here.\r\n * A class with no rule silently renders with browser defaults, which on this\r\n * dark theme means an unreadable white-on-white control.\r\n */\r\n\r\n/* ── action buttons (the workhorse; .btn is the formal variant) ─────────── */\r\n.df .act {\r\n  display: inline-flex; align-items: center; justify-content: center; gap: 6px;\r\n  min-height: 30px; padding: 0 12px;\r\n  border: 1px solid var(--line); border-radius: var(--r);\r\n  background: var(--raised); color: var(--ink);\r\n  cursor: pointer; font: 600 11.5px var(--sans); letter-spacing: .01em;\r\n  transition: border-color .14s, background .14s, color .14s;\r\n  white-space: nowrap;\r\n}\r\n.df .act:hover:not([disabled]) { border-color: var(--primary-dim); background: #16252b; }\r\n.df .act:active:not([disabled]) { transform: translateY(1px); }\r\n.df .act[disabled] { opacity: .38; cursor: not-allowed; }\r\n.df .act.primary { border-color: var(--primary-dim); background: var(--primary); color: #04100e; }\r\n.df .act.primary:hover:not([disabled]) { background: #4af0d6; border-color: var(--primary); }\r\n.df .act.danger { border-color: #5c2530; color: var(--danger); }\r\n.df .act.danger:hover:not([disabled]) { background: #241216; border-color: var(--danger); }\r\n.df .act.ghost { border-color: transparent; background: transparent; color: var(--ink-dim); }\r\n.df .act.ghost:hover:not([disabled]) { border-color: var(--line); background: var(--raised); color: var(--ink); }\r\n.df .act.tiny { min-height: 32px; padding: 0 11px; font-size: 11.5px; }\r\n.df .btnrow { display: flex; flex-wrap: wrap; gap: 6px; }\r\n.df .page-acts { display: grid; gap: 6px; }\r\n\r\n/* ── cards ─────────────────────────────────────────────────────────────── */\r\n.df .card {\r\n  margin-bottom: var(--gap); padding: 13px 14px;\r\n  border: 1px solid var(--line-soft); border-radius: var(--r-lg);\r\n  background: var(--panel);\r\n}\r\n.df .card-hd {\r\n  display: flex; align-items: baseline; gap: 9px;\r\n  margin: -2px 0 11px; padding-bottom: 9px;\r\n  border-bottom: 1px solid var(--line-soft);\r\n}\r\n.df .card-hd h3 {\r\n  margin: 0; color: var(--ink);\r\n  font-size: 11px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase;\r\n}\r\n.df .card-hd > :last-child { margin-left: auto; }\r\n.df .card-hd .muted { font-size: 10.5px; }\r\n.df .two { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }\r\n.df .tight { margin: -4px 0 10px; font-size: 11px; }\r\n\r\n/* ── callouts: one shape, three intents ────────────────────────────────── */\r\n.df .cta, .df .info-box, .df .warn-box {\r\n  margin-bottom: var(--gap); padding: 11px 13px;\r\n  border: 1px solid var(--line); border-left-width: 3px; border-radius: var(--r);\r\n  background: var(--panel); font-size: 12px;\r\n}\r\n.df .cta {\r\n  display: flex; align-items: center; gap: 11px;\r\n  border-left-color: var(--primary);\r\n  background: linear-gradient(90deg, rgba(46,230,200,.07), transparent 60%);\r\n}\r\n.df .cta.done { border-left-color: var(--s-mine); background: linear-gradient(90deg, rgba(79,184,245,.07), transparent 60%); }\r\n.df .cta > div { flex: 1; }\r\n.df .cta .muted { display: block; margin-top: 2px; font-size: 11px; }\r\n.df .cta .act { flex: none; }\r\n.df .info-box { border-left-color: var(--sky); }\r\n.df .warn-box { border-left-color: var(--amber); }\r\n.df .info-box b, .df .warn-box b { display: block; margin-bottom: 3px; }\r\n.df .info-box p, .df .warn-box p { margin: 0 0 8px; color: var(--ink-dim); font-size: 11.5px; }\r\n.df .info-box p:last-child, .df .warn-box p:last-child { margin-bottom: 0; }\r\n\r\n/* ── activity feed ─────────────────────────────────────────────────────── */\r\n.df .feed { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; }\r\n.df .feed li {\r\n  display: flex; align-items: center; gap: 9px;\r\n  padding: 7px 2px; border-bottom: 1px solid var(--line-soft);\r\n}\r\n.df .feed li:last-child { border-bottom: 0; }\r\n.df .feed .mono { flex: 1; font-size: 11.5px; }\r\n.df .ago { color: var(--ink-mute); font: 500 10.5px var(--mono); white-space: nowrap; }\r\n\r\n/* ── empty states ──────────────────────────────────────────────────────── */\r\n.df .empty { padding: 26px 14px; color: var(--ink-mute); text-align: center; }\r\n.df .empty .ei { margin-bottom: 7px; color: var(--line); font-size: 26px; line-height: 1; }\r\n.df .empty p { margin: 0 0 10px; font-size: 12px; }\r\n.df .empty .act { margin: 0 3px; }\r\n\r\n/* ── tables ────────────────────────────────────────────────────────────── */\r\n.df .tbl-wrap {\r\n  margin-bottom: 11px; overflow-x: auto;\r\n  border: 1px solid var(--line-soft); border-radius: var(--r);\r\n}\r\n.df .tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }\r\n.df .tbl th {\r\n  position: sticky; top: 0; z-index: 1;\r\n  padding: 7px 9px; border-bottom: 1px solid var(--line);\r\n  background: var(--sunken); color: var(--ink-mute);\r\n  font: 800 9.5px var(--sans); letter-spacing: .09em; text-align: left; text-transform: uppercase;\r\n}\r\n.df .tbl td { padding: 6px 9px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }\r\n.df .tbl tr:last-child td { border-bottom: 0; }\r\n.df .tbl tbody tr:hover { background: #0e181d; }\r\n.df .tbl .cbx { width: 28px; text-align: center; }\r\n.df .tbl .rowacts { width: 1%; text-align: right; white-space: nowrap; }\r\n.df .tbl .rowacts .act { margin-left: 4px; }\r\n.df .pick, .df .pick-all { accent-color: var(--primary); cursor: pointer; }\r\n\r\n/* ── filters ───────────────────────────────────────────────────────────── */\r\n.df .fq, .df .fstatus, .df .fsort {\r\n  min-height: 30px; padding: 0 9px;\r\n  border: 1px solid var(--line); border-radius: var(--r);\r\n  background: var(--sunken); color: var(--ink); font-size: 11.5px;\r\n}\r\n.df .fq:focus, .df .fstatus:focus, .df .fsort:focus { border-color: var(--primary-dim); outline: 0; }\r\n.df .chiprow { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }\r\n\r\n/* ── run controls ──────────────────────────────────────────────────────── */\r\n.df .fld { display: grid; gap: 3px; }\r\n.df .fld > span {\r\n  color: var(--ink-mute);\r\n  font: 700 9.5px var(--sans); letter-spacing: .08em; text-transform: uppercase;\r\n}\r\n.df .fld input {\r\n  min-height: 29px; padding: 0 8px;\r\n  border: 1px solid var(--line); border-radius: var(--r);\r\n  background: var(--sunken); color: var(--ink); font: 600 12px var(--mono);\r\n}\r\n.df .fld input:focus { border-color: var(--primary-dim); outline: 0; }\r\n.df .runline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: var(--gap); }\r\n.df .runline .spacer { flex: 1; }\r\n.df .qcount { font: 600 10.5px var(--mono); }\r\n\r\n/* ── progress ──────────────────────────────────────────────────────────── */\r\n.df .prog-card {\r\n  margin-bottom: var(--gap); padding: 12px 13px;\r\n  border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--panel);\r\n}\r\n.df .prog { height: 5px; overflow: hidden; border-radius: 99px; background: var(--sunken); }\r\n.df .prog i {\r\n  display: block; width: 0; height: 100%;\r\n  background: linear-gradient(90deg, var(--primary-dim), var(--primary));\r\n  transition: width .3s ease-out;\r\n}\r\n.df .prog-txt { margin: 7px 0 0; font: 500 11px var(--mono); }\r\n.df .prog-eta { float: right; color: var(--ink-mute); font: 500 10.5px var(--mono); }\r\n.df .tally { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }\r\n.df .log {\r\n  max-height: 148px; margin: 9px 0 0; padding: 8px 9px; overflow: auto;\r\n  border: 1px solid var(--line-soft); border-radius: var(--r);\r\n  background: var(--sunken); color: var(--ink-dim);\r\n  font: 500 10.5px/1.55 var(--mono); white-space: pre-wrap; word-break: break-all;\r\n}\r\n\r\n/* ── preset cards ──────────────────────────────────────────────────────── */\r\n.df .pgrid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(178px, 1fr)); }\r\n.df .pcard {\r\n  display: grid; gap: 6px; padding: 9px 10px;\r\n  border: 1px solid var(--line-soft); border-radius: var(--r); background: var(--sunken);\r\n}\r\n.df .pcard:hover { border-color: var(--line); }\r\n.df .pc-hd { display: flex; align-items: center; gap: 7px; }\r\n.df .pc-hd b { flex: 1; font-size: 12px; }\r\n.df .pc-code {\r\n  display: block; padding: 5px 7px; user-select: all;\r\n  border: 1px dashed var(--line); border-radius: var(--r);\r\n  background: var(--void); font-size: 11.5px;\r\n}\r\n.df .pc-ft { display: flex; align-items: center; gap: 7px; }\r\n.df .pc-ft .muted { flex: 1; font-size: 10px; }\r\n.df .tag {\r\n  padding: 1px 6px; border: 1px solid var(--line); border-radius: 99px;\r\n  color: var(--ink-mute);\r\n  font: 700 9px var(--sans); letter-spacing: .06em; text-transform: uppercase;\r\n}\r\n\r\n/* ── share textareas ───────────────────────────────────────────────────── */\r\n.df .share-gift, .df .share-preset {\r\n  width: 100%; padding: 8px 9px; resize: vertical;\r\n  border: 1px solid var(--line); border-radius: var(--r);\r\n  background: var(--sunken); color: var(--ink-dim); font: 500 11px/1.6 var(--mono);\r\n}\r\n.df .share-gift:focus, .df .share-preset:focus { border-color: var(--primary-dim); outline: 0; }\r\n\r\n/* ── history timeline ──────────────────────────────────────────────────── */\r\n.df .tline { margin: 0; padding: 0; list-style: none; }\r\n.df .tline li { position: relative; display: flex; gap: 10px; padding-bottom: 13px; }\r\n.df .tline .pi { position: relative; flex: none; width: 9px; margin-top: 4px; }\r\n.df .tline .pi::before {\r\n  content: ''; position: absolute; left: 1px; top: 1px;\r\n  width: 7px; height: 7px; border-radius: 99px;\r\n  background: var(--line); box-shadow: 0 0 0 2px var(--bg);\r\n}\r\n.df .tline .pi::after {\r\n  content: ''; position: absolute; left: 4px; top: 10px; bottom: -13px;\r\n  width: 1px; background: var(--line-soft);\r\n}\r\n.df .tline li:last-child .pi::after { display: none; }\r\n.df .tline li.st-success .pi::before { background: var(--s-success); }\r\n.df .tline li.st-mine .pi::before { background: var(--s-mine); }\r\n.df .tline li.st-untried .pi::before { background: var(--s-untried); }\r\n.df .tline li.st-expired .pi::before { background: var(--s-expired); }\r\n.df .tline li.st-exhausted .pi::before { background: var(--s-exhausted); }\r\n.df .tline li.st-gift_bug .pi::before { background: var(--s-gift_bug); }\r\n.df .tline li.st-invalid .pi::before { background: var(--s-invalid); }\r\n.df .tl-body { flex: 1; min-width: 0; }\r\n.df .tl-top { display: flex; align-items: center; gap: 8px; }\r\n.df .tl-top .mono { font-size: 11.5px; }\r\n.df .tl-top .ago { margin-left: auto; }\r\n.df .tl-body .muted { display: block; margin-top: 2px; font-size: 10.5px; word-break: break-word; }\r\n\r\n/* ── command palette (Ctrl+K) ──────────────────────────────────────────── */\r\n.df.palette-wrap, .df .palette-wrap {\r\n  position: fixed; inset: 0; z-index: 2147483646;\r\n  display: grid; place-items: start center; padding-top: 12vh;\r\n  background: rgba(2, 6, 8, .62); backdrop-filter: blur(2px);\r\n}\r\n.df .palette {\r\n  width: min(520px, 92vw); overflow: hidden;\r\n  border: 1px solid var(--line); border-radius: var(--r-lg);\r\n  background: var(--panel); box-shadow: 0 24px 70px rgba(0, 0, 0, .66);\r\n}\r\n.df .pq {\r\n  width: 100%; padding: 13px 15px;\r\n  border: 0; border-bottom: 1px solid var(--line-soft);\r\n  background: transparent; color: var(--ink); font: 500 13.5px var(--sans);\r\n}\r\n.df .pq:focus { outline: 0; }\r\n.df .phits { max-height: 320px; overflow: auto; }\r\n.df .palette-btn {\r\n  display: flex; align-items: center; gap: 10px; width: 100%;\r\n  padding: 9px 15px; border: 0; background: transparent;\r\n  color: var(--ink); cursor: pointer; font: 500 12px var(--sans); text-align: left;\r\n}\r\n.df .palette-btn.on, .df .palette-btn:hover { background: #16242a; }\r\n.df .palette-btn .go { margin-left: auto; color: var(--ink-mute); font: 500 10px var(--mono); }\r\n.df .pnone { padding: 18px 15px; color: var(--ink-mute); font-size: 12px; text-align: center; }\r\n.df .pfoot {\r\n  display: flex; gap: 9px; padding: 8px 15px;\r\n  border-top: 1px solid var(--line-soft); background: var(--sunken);\r\n  color: var(--ink-mute); font-size: 10.5px;\r\n}\r\n.df .pfoot kbd, .df .kbd-hint kbd {\r\n  padding: 1px 5px; border: 1px solid var(--line); border-radius: 3px;\r\n  background: var(--raised); color: var(--ink-dim); font: 600 9.5px var(--mono);\r\n}\r\n.df .kbd-hint { color: var(--ink-mute); font-size: 10.5px; }\r\n\r\n/* ── toast host ────────────────────────────────────────────────────────── */\r\n.df.toast-wrap, .df .toast-wrap {\r\n  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;\r\n  display: grid; gap: 7px; pointer-events: none;\r\n}\r\n\r\n/* ── small shared pieces ───────────────────────────────────────────────── */\r\n.df .close {\r\n  display: inline-flex; align-items: center; justify-content: center;\r\n  width: 32px; height: 32px;\r\n  border: 1px solid transparent; border-radius: var(--r);\r\n  background: transparent; color: var(--ink-mute); cursor: pointer; font-size: 15px;\r\n}\r\n.df .close:hover { border-color: var(--line); background: var(--raised); color: var(--ink); }\r\n.df .dot { display: inline-block; width: 6px; height: 6px; border-radius: 99px; background: var(--primary); }\r\n\r\n/* ── narrow surfaces: two-up grids collapse before text shrinks ────────── */\r\n@media (max-width: 560px) {\r\n  .df .two { grid-template-columns: 1fr; }\r\n  .df .pgrid { grid-template-columns: 1fr; }\r\n}\r\n\r\n/* Square icon-only button. Used by page headers where a label would crowd. */\r\n.df .act.icon-only { width: 34px; padding: 0; font-size: 14px; }\r\n.df .act.tiny.icon-only { width: 32px; font-size: 13px; }\r\n\r\n/* ── .ico — square icon button, the drawer header and row-action workhorse ──\r\n * Defined here rather than next to .callout .ico (which is a decorative glyph,\r\n * not a control) so every <button class=\"ico\"> gets real chrome instead of\r\n * Chrome's pale default. */\r\n/* Comfortable hit target. 32px is the floor for every control in the drawer:\r\n * measured on the live panel, 174 controls sat below it and mis-taps on the\r\n * row actions were the most common complaint. */\r\n.df button.ico, .df .ico {\r\n  display: inline-flex; align-items: center; justify-content: center;\r\n  width: 32px; height: 32px; padding: 0;\r\n  border: 1px solid var(--line); border-radius: var(--r);\r\n  background: var(--raised); color: var(--ink-dim);\r\n  cursor: pointer; font-size: 14px; line-height: 1;\r\n  transition: border-color .14s, background .14s, color .14s;\r\n}\r\n.df button.ico:hover, .df .ico:hover { border-color: var(--primary-dim); background: #16252b; color: var(--ink); }\r\n.df button.ico:active { transform: translateY(1px); }\r\n.df .ico.tiny { width: 32px; height: 32px; font-size: 12px; }\r\n.df .ico.close:hover { border-color: var(--danger); color: var(--danger); }\r\n/* The decorative glyph inside a callout keeps its original treatment. */\r\n.df .callout .ico, .df .info-box .ico, .df .warn-box .ico {\r\n  width: auto; height: auto; border: 0; background: none; cursor: default;\r\n}\r\n";
const DF_PANEL_CSS = "/* styles.css — drawer shell for the in-page surface, layered on theme.css.\r\n *\r\n * v2 was a centred modal with a dimming backdrop: it covered the redeem form,\r\n * so the user had to close the tool every time they wanted to paste a code.\r\n * v3 is a right-hand DRAWER that docks beside the page, keeping the form\r\n * reachable while a run is going. Resizable, collapsible, remembers its width.\r\n */\r\n\r\n:host { all: initial; }\r\n\r\n.df.shell {\r\n  position: fixed;\r\n  inset: 0 0 0 auto;\r\n  z-index: 2147483646;\r\n  display: grid;\r\n  grid-template-columns: auto 1fr;\r\n  /* The single row MUST be height-constrained, not auto. Without this the\r\n   * drawer grows to its content height (2200px for a 50-row table) and the\r\n   * view-host never becomes a scroller, so rows and the pager fall off the\r\n   * bottom of the viewport with no way to reach them. */\r\n  grid-template-rows: minmax(0, 1fr);\r\n  width: var(--w, 520px);\r\n  max-width: 100vw;\r\n  height: 100vh;\r\n  pointer-events: none;\r\n}\r\n.df.shell > * { pointer-events: auto; }\r\n.df.shell[hidden] { display: none !important; }\r\n\r\n/* ── drag-to-resize handle ─────────────────────────────────────────────── */\r\n.df .grip {\r\n  width: 5px;\r\n  border: 0;\r\n  padding: 0;\r\n  background: var(--line-soft);\r\n  cursor: col-resize;\r\n  transition: background .12s;\r\n}\r\n.df .grip:hover, .df .grip.active { background: var(--primary-dim); }\r\n\r\n/* ── drawer body ───────────────────────────────────────────────────────── */\r\n.df .drawer {\r\n  display: grid;\r\n  grid-template-rows: auto auto minmax(0, 1fr) auto;\r\n  min-width: 0;\r\n  border-left: 1px solid var(--line);\r\n  background: var(--bg);\r\n  box-shadow: -18px 0 50px rgba(0,0,0,.5);\r\n  container-type: inline-size;\r\n}\r\n\r\n/* ── header ────────────────────────────────────────────────────────────── */\r\n.df .hd {\r\n  display: flex; align-items: center; gap: 10px;\r\n  padding: 11px 13px;\r\n  border-bottom: 1px solid var(--line);\r\n  background: linear-gradient(180deg, #0d1a1e, var(--panel));\r\n}\r\n.df .brand { display: grid; gap: 1px; min-width: 0; }\r\n.df .brand .stencil { color: var(--primary); }\r\n.df .brand h2 {\r\n  margin: 0;\r\n  font-size: 14.5px; font-weight: 700; letter-spacing: -.01em;\r\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\r\n}\r\n.df .brand h2 .ver { color: var(--ink-mute); font-size: 10.5px; font-weight: 600; }\r\n.df .hd-acts { display: flex; align-items: center; gap: 5px; margin-left: auto; }\r\n\r\n.df .sync-chip {\r\n  display: inline-flex; align-items: center; gap: 5px;\r\n  padding: 3px 8px; border: 1px solid var(--line); border-radius: 10px;\r\n  color: var(--ink-mute); font-size: 10px; font-weight: 600;\r\n  cursor: default; white-space: nowrap;\r\n}\r\n.df .sync-chip::before { content: \"\"; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }\r\n.df .sync-chip.st-ok { border-color: var(--primary-dim); color: var(--primary); }\r\n.df .sync-chip.st-error { border-color: #4a2228; color: var(--danger); }\r\n.df .sync-chip.st-syncing { border-color: #4a3a1e; color: var(--amber); }\r\n\r\n/* ── tabs: a fixed grid, never a ragged wrap ────────────────────────────\r\n * Flex-wrap left the 6th tab alone on its own row with a wide empty gap at\r\n * drawer width. A 3-column grid always balances 3+3, and two columns at very\r\n * narrow widths, so no tab is ever orphaned. */\r\n.df .views {\r\n  display: grid;\r\n  grid-template-columns: repeat(3, minmax(0, 1fr));\r\n  gap: 3px;\r\n  padding: 7px 9px;\r\n  border-bottom: 1px solid var(--line);\r\n  background: var(--panel);\r\n}\r\n@container (max-width: 330px) {\r\n  .df .views { grid-template-columns: repeat(2, minmax(0, 1fr)); }\r\n}\r\n/* Below 430px the labels are hidden and six icons share one row — see the\r\n * narrow-drawer block further down. */\r\n.df .vtab {\r\n  display: inline-flex; align-items: center; justify-content: center; gap: 6px;\r\n  min-width: 0;                    /* grid cell must be allowed to shrink */\r\n  min-height: 32px;                /* shared hit-target floor, see components.css */\r\n  padding: 6px 8px;\r\n  border: 1px solid transparent; border-radius: var(--r);\r\n  background: none;\r\n  color: var(--ink-mute);\r\n  cursor: pointer;\r\n  font-size: 12px; font-weight: 600;\r\n  transition: color .12s, background .12s, border-color .12s;\r\n}\r\n.df .vtab .vi { font-size: 13px; line-height: 1; opacity: .85; }\r\n.df .vtab:hover { color: var(--ink-dim); background: var(--raised); }\r\n.df .vtab.on {\r\n  border-color: color-mix(in srgb, var(--primary) 35%, transparent);\r\n  background: var(--primary-glow);\r\n  color: var(--primary);\r\n}\r\n.df .vtab .badge {\r\n  padding: 0 5px; border-radius: 8px;\r\n  background: var(--amber); color: #201400;\r\n  font-size: 10px; font-weight: 800;\r\n  font-variant-numeric: tabular-nums;\r\n}\r\n\r\n/* ── view host ─────────────────────────────────────────────────────────── */\r\n.df .view-host { padding: 13px; overflow: auto; }\r\n.df .pad { display: grid; gap: var(--gap); }\r\n\r\n/* ── footer ────────────────────────────────────────────────────────────── */\r\n.df .ft {\r\n  display: flex; align-items: center; gap: 10px;\r\n  padding: 8px 13px;\r\n  border-top: 1px solid var(--line);\r\n  background: var(--panel);\r\n  color: var(--ink-mute);\r\n  font-size: 10.5px;\r\n  font-variant-numeric: tabular-nums;\r\n}\r\n.df .ft .spacer { flex: 1; }\r\n\r\n/* ── launcher (collapsed state) ────────────────────────────────────────── */\r\n.df.launcher-wrap { position: fixed; right: 0; bottom: 96px; z-index: 2147483645; }\r\n.df .launcher {\r\n  display: flex; align-items: center; gap: 8px;\r\n  padding: 10px 13px 10px 11px;\r\n  border: 1px solid var(--primary-dim); border-right: 0;\r\n  border-radius: var(--r-lg) 0 0 var(--r-lg);\r\n  background: linear-gradient(180deg, #0f2027, var(--panel));\r\n  box-shadow: -8px 0 26px rgba(0,0,0,.5);\r\n  color: var(--primary);\r\n  cursor: pointer;\r\n  font-size: 11.5px; font-weight: 700; letter-spacing: .08em;\r\n  writing-mode: vertical-rl;\r\n  transition: padding-right .14s, color .14s;\r\n}\r\n.df .launcher:hover { padding-right: 17px; color: #7ff5e0; }\r\n.df .launcher .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); }\r\n\r\n/* ── run view ──────────────────────────────────────────────────────────── */\r\n.df .runbar { display: grid; gap: 9px; }\r\n.df .runstat { display: flex; flex-wrap: wrap; gap: 7px; }\r\n.df .queue { min-height: 104px; }\r\n.df .pacerow { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 9px; align-items: end; }\r\n.df .check { display: flex; align-items: center; gap: 7px; color: var(--ink-dim); font-size: 11.5px; cursor: pointer; }\r\n.df .check input { width: 14px; height: 14px; accent-color: var(--primary); cursor: pointer; }\r\n\r\n/* ── library ───────────────────────────────────────────────────────────── */\r\n.df .filters { display: grid; grid-template-columns: minmax(130px, 1fr) auto auto; gap: 7px; }\r\n.df .bulk {\r\n  display: flex; align-items: center; gap: 8px;\r\n  padding: 8px 11px;\r\n  border: 1px solid color-mix(in srgb, var(--sky) 32%, transparent);\r\n  border-radius: var(--r);\r\n  background: color-mix(in srgb, var(--sky) 9%, transparent);\r\n  font-size: 11.5px;\r\n}\r\n.df .bulk.off { display: none; }\r\n.df .bulk b { color: var(--sky); }\r\n.df .pager { display: flex; align-items: center; justify-content: center; gap: 9px; color: var(--ink-mute); font-size: 11.5px; }\r\n\r\n/* ── share ─────────────────────────────────────────────────────────────── */\r\n.df .sharebox { display: grid; gap: 8px; }\r\n\r\n/* ── narrow drawer: stack filters, hide tab text, shrink bar labels ────── */\r\n@container (max-width: 430px) {\r\n  .df .filters { grid-template-columns: 1fr; }\r\n  .df .bar-row { grid-template-columns: 78px 1fr 38px; }\r\n  .df .vtab .vl { display: none; }\r\n  .df .vtab { padding: 6px 9px; }\r\n  /* icons alone fit one clean row of six */\r\n  .df .views { grid-template-columns: repeat(6, minmax(0, 1fr)); }\r\n}\r\n";
const DF_REDEEM_STYLES = DF_THEME_CSS + DF_PANEL_CSS;
/* panel.js — the shared UI, v3.
 *
 * One view layer, four surfaces: an in-page drawer (shadow DOM, beside the
 * redeem form), a full-page app, a toolbar popup and the options page. The
 * surface only decides the shell; every view below is identical.
 *
 * Expects `root`, `DFRedeemCodes`, `DFRedeemGarena`, `DFRedeemEngine`,
 * `DFRedeemVault` and (optionally) `DF_REDEEM_SEED` in scope — the build step
 * inlines them above this file.
 *
 * Views: Dashboard | Library | Run | Presets | Share | History
 */

function createPanel(options) {
  const opts = options || {};
  const version = opts.version || '3.1.1';
  const surface = opts.surface || 'drawer'; // drawer | page | popup
  const store = opts.store || {
    get: (k, d) => { try { const v = localStorage.getItem('dfRedeem:' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set: (k, v) => { try { localStorage.setItem('dfRedeem:' + k, JSON.stringify(v)); } catch (_) {} },
    del: (k) => { try { localStorage.removeItem('dfRedeem:' + k); } catch (_) {} },
  };

  const E = root.DFRedeemEngine;
  const V = root.DFRedeemVault;
  const G = root.DFRedeemGarena;   /* verdict labels + verdict→vault status map */
  const S = root.DFRedeemSync;     /* community merge helper; absent in bare tests */

  /* 25, not 50: the drawer is ~515px wide and a 50-row page ran ~2000px tall,
   * which meant constant scrolling to reach the pager. Halving the page keeps a
   * page within a couple of screens at the default drawer height. */
  const PAGE_SIZE = 25;
  const VIEWS = ['dashboard', 'library', 'run', 'presets', 'share', 'history'];
  const VIEW_LABELS = {
    dashboard: 'Tổng quan', library: 'Kho code', run: 'Chạy đổi',
    presets: 'Preset Gunsmith', share: 'Chia sẻ', history: 'Lịch sử',
  };
  const VIEW_ICONS = {
    dashboard: '◈', library: '▤', run: '▶', presets: '⌖', share: '↗', history: '◷',
  };
  const VIEW_HINTS = {
    dashboard: 'Tình trạng toàn bộ kho code',
    library: 'Tìm, lọc, sửa trạng thái từng mã',
    run: 'Đổi hàng loạt trên trang Garena',
    presets: 'Preset Gunsmith cho mọi chế độ chơi',
    share: 'Xuất danh sách cho người khác',
    history: 'Mọi lần thử đã ghi lại',
  };
  const STATUS_LABELS = {
    untried: 'Chưa thử', success: 'Thành công', expired: 'Hết hạn',
    exhausted: 'Hết lượt', mine: 'Đã nhận', group_limit: 'Chạm giới hạn nhóm',
    sys_error: 'Garena lỗi', gift_bug: 'Lỗi quà',
    invalid: 'Không tồn tại',
  };
  const STATUS_ORDER = ['success', 'mine', 'group_limit', 'untried', 'sys_error', 'expired', 'exhausted', 'gift_bug', 'invalid'];
  const STATUS_HINT = {
    untried: 'Chưa gửi lên Garena lần nào.',
    success: 'Garena xác nhận đã nhận quà.',
    expired: 'Mã đã quá hạn sử dụng.',
    exhausted: 'Mã hết lượt đổi trên toàn hệ thống.',
    mine: 'Chính mã này đã được tài khoản của bạn đổi trước đó.',
    group_limit: 'Tài khoản bạn đã chạm giới hạn của nhóm quà này — mã vẫn còn tốt, người khác vẫn đổi được.',
    sys_error: 'Garena trả lỗi hệ thống, chưa kết luận được gì. Nên thử lại sau.',
    gift_bug: 'Garena nhận mã nhưng quà không vào — lỗi phía họ.',
    invalid: 'Garena trả về mã không tồn tại.',
  };
  const SHAREABLE = new Set(['success', 'expired', 'gift_bug']);

  /* vault may be injected (tests/mock) or built from the bundled class */
  const vault = opts.vault || (V ? new V.Vault({ adapter: new V.IndexedDBAdapter() }) : null);

  let activeRun = null;
  let view = store.get('view', 'dashboard');
  let libFilter = { status: 'all', q: '', sort: 'code' };
  let libPage = 0;
  let selection = new Set();
  let cache = { codes: [], presets: [], stats: null, history: [] };
  let historyCode = null;
  let paletteOpen = false;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtTime = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fmtAgo = (ts) => {
    if (!ts) return '';
    const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return 'vừa xong';
    if (s < 3600) return Math.round(s / 60) + ' phút trước';
    if (s < 86400) return Math.round(s / 3600) + ' giờ trước';
    return Math.round(s / 86400) + ' ngày trước';
  };
  const fmtDur = (ms) => {
    if (!ms) return '0s';
    const s = Math.round(ms / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'p' + String(s % 60).padStart(2, '0');
  };

  /* ── shell ─────────────────────────────────────────────────────────────── */
  const host = document.createElement('div');
  host.id = 'df-redeem-host';
  const shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  const sheet = document.createElement('style');
  sheet.textContent = (typeof DF_THEME_CSS === 'string' ? DF_THEME_CSS : '') +
    (typeof DF_PANEL_CSS === 'string' ? DF_PANEL_CSS : '');
  shadow.appendChild(sheet);

  const width0 = store.get('drawerWidth', 520);

  const shell = document.createElement('div');
  shell.className = 'df shell';
  shell.hidden = true;
  shell.style.cssText = '--w:' + width0 + 'px';
  shell.innerHTML = `
    <button class="grip" title="Kéo để đổi chiều rộng" aria-label="Đổi chiều rộng"></button>
    <div class="drawer" role="dialog" aria-label="Delta Force Auto Redeem">
      <header class="hd">
        <div class="brand">
          <div class="stencil">Delta Force</div>
          <h2>Auto Redeem <span class="ver">v${esc(version)}</span></h2>
        </div>
        <div class="hd-acts">
          <span class="sync-chip" hidden></span>
          <button class="ico palette-btn" data-act="palette" title="Lệnh nhanh (Ctrl+K)">⌘</button>
          <button class="ico" data-act="refresh" title="Tải lại dữ liệu">⟳</button>
          <button class="ico close" title="Thu gọn (Esc)">✕</button>
        </div>
      </header>
      <nav class="views" role="tablist">
        ${VIEWS.map((v) => `<button class="vtab" role="tab" data-view="${v}" title="${esc(VIEW_HINTS[v])}">
          <span class="vi">${VIEW_ICONS[v]}</span><span class="vl">${esc(VIEW_LABELS[v])}</span>
        </button>`).join('')}
      </nav>
      <main class="view-host"></main>
      <footer class="ft"></footer>
    </div>`;

  const launcher = document.createElement('div');
  launcher.className = 'df launcher-wrap';
  launcher.hidden = true;
  launcher.innerHTML = `<button class="launcher" title="Mở bảng đổi code (Alt+D)">
    <span class="dot"></span>AUTO REDEEM</button>`;

  const toasts = document.createElement('div');
  toasts.className = 'df toast-wrap';
  /* Toasts are the only feedback for a finished run, a copy, or a sync failure.
   * Without a live region a screen-reader user gets silence, so announce them
   * politely — 'assertive' would interrupt the run log mid-sentence. */
  toasts.setAttribute('role', 'status');
  toasts.setAttribute('aria-live', 'polite');

  const palette = document.createElement('div');
  palette.className = 'df palette-wrap';
  palette.hidden = true;
  palette.innerHTML = `<div class="palette">
      <input class="pq" placeholder="Gõ để tìm lệnh hoặc mã code…" aria-label="Lệnh nhanh">
      <div class="phits"></div>
      <div class="pfoot"><kbd>↑↓</kbd> chọn <kbd>Enter</kbd> chạy <kbd>Esc</kbd> đóng</div>
    </div>`;

  shadow.appendChild(shell);
  shadow.appendChild(launcher);
  shadow.appendChild(palette);
  shadow.appendChild(toasts);

  const $ = (sel) => shell.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(shell.querySelectorAll(sel));
  const viewHost = $('.view-host');
  const footer = $('.ft');

  function toast(msg, tone) {
    const t = document.createElement('div');
    t.className = 'toast' + (tone ? ' ' + tone : '');
    t.textContent = msg;
    toasts.appendChild(t);
    setTimeout(() => { try { toasts.removeChild(t); } catch (_) {} }, 4200);
  }

  /* ── data ──────────────────────────────────────────────────────────────── */
  /* Gift rows and preset rows share one store, told apart by `kind`. The seed
   * writes 'giftcode'; presets() joins in the weapon/mode half. */
  async function refresh() {
    if (!vault) return;
    const [all, presets, stats, hist] = await Promise.all([
      vault.all(), vault.presets(), vault.stats(), vault.history(),
    ]);
    const presetCodes = new Set(presets.map((r) => r.code));
    cache.codes = all.filter((r) => !presetCodes.has(r.code));
    cache.presets = presets;
    cache.stats = stats;
    cache.history = hist;

    /* IndexedDB is per-origin, so a run done in the Garena drawer is absent
     * from this store when we are the extension page (and vice versa). Merge
     * the shared mirror in, newest first, so History is complete on every
     * surface. De-duplicated on code+timestamp against the local rows. */
    if (opts.sync && opts.sync.readMirror) {
      try {
        const reply = await opts.sync.readMirror();
        const rows = (reply && reply.rows) || [];
        if (rows.length) {
          const seen = new Set(hist.map((r) => String(r.code).toUpperCase() + '|' + (r.timestamp || '')));
          const extra = rows.filter((r) => r && r.code
            && !seen.has(String(r.code).toUpperCase() + '|' + (r.timestamp || '')));
          cache.history = hist.concat(extra)
            .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
        }
      } catch (_) { /* the worker may be asleep; local history still renders */ }
    }
  }

  const shareableCodes = () => cache.codes.filter((r) => SHAREABLE.has(r.status));
  const untriedCodes = () => cache.codes.filter((r) => r.status === 'untried');

  /* The community contract has two one-way rules: remote dead-code verdicts may
   * mark a local untried code as dead, while this installation only publishes
   * verdicts that are true for every account. A local `mine` row is therefore
   * never sent and is never overwritten by someone else's public outcome. */
  async function syncCommunityVault(options) {
    const cfg = options || {};
    if (!vault || !opts.sync) return { pulled: null, pushed: null };
    let pulled = null;
    let pushed = null;
    if (cfg.pull !== false && opts.sync.communityPull && S && S.mergeCommunityCodes) {
      try {
        const reply = await opts.sync.communityPull();
        if (reply && reply.ok) {
          const merged = S.mergeCommunityCodes(await vault.all(), reply.codes || []);
          for (const row of merged.changedRecords || []) await vault.upsert(row);
          pulled = merged;
          await refresh();
        }
      } catch (_) { /* Offline community sync must never block redemption. */ }
    }
    if (cfg.push && opts.sync.communityPush) {
      try { pushed = await opts.sync.communityPush(await vault.all()); } catch (_) { /* keep local result */ }
    }
    return { pulled, pushed };
  }

  /* ── dashboard ─────────────────────────────────────────────────────────── */
  function renderDashboard() {
    const s = cache.stats || { total: 0, byStatus: {} };
    const by = s.byStatus || {};
    const total = cache.codes.length || 1;
    const share = shareableCodes().length;
    const untried = untriedCodes().length;

    const recent = cache.codes
      .filter((r) => r.last_attempt)
      .sort((a, b) => new Date(b.last_attempt) - new Date(a.last_attempt))
      .slice(0, 6);

    const bars = STATUS_ORDER.map((k) => {
      const n = by[k] || 0;
      const pct = Math.round((n / total) * 1000) / 10;
      return `<div class="bar-row" title="${esc(STATUS_HINT[k] || '')}">
        <span class="bl">${esc(STATUS_LABELS[k])}</span>
        <span class="bt"><i class="s-${k}" style="width:${pct}%"></i></span>
        <span class="bn">${n}</span>
      </div>`;
    }).join('');

    viewHost.innerHTML = `<div class="pad">
      <section class="kpis">
        <div class="kpi ok"><b>${by.success || 0}</b><span>Thành công</span></div>
        <div class="kpi share"><b>${share}</b><span>Chia sẻ được</span></div>
        <div class="kpi warn"><b>${untried}</b><span>Chưa thử</span></div>
        <div class="kpi preset"><b>${cache.presets.length}</b><span>Preset Gunsmith</span></div>
      </section>

      ${untried > 0
        ? `<div class="cta">
             <div><b>${untried} mã chưa thử.</b> Mở tab Chạy đổi để gửi lên Garena.</div>
             <button class="act primary" data-act="goto-run">Chạy ngay →</button>
           </div>`
        : `<div class="cta done">
             <div><b>Hết mã chưa thử.</b> Mọi gift code trong kho đã có kết quả từ Garena.</div>
             <button class="act" data-act="goto-share">Xuất danh sách →</button>
           </div>`}

      <section class="card">
        <div class="card-hd"><h3>Phân bố trạng thái</h3><span class="muted">${cache.codes.length} gift code</span></div>
        <div class="bars">${bars}</div>
      </section>

      <section class="card">
        <div class="card-hd"><h3>Hoạt động gần đây</h3>
          ${recent.length ? '<button class="act tiny" data-act="goto-history">Xem tất cả</button>' : ''}</div>
        ${recent.length ? `<ul class="feed">${recent.map((r) => `
          <li><span class="dot s-${r.status}"></span>
            <code class="mono">${esc(r.code)}</code>
            <span class="pill s-${r.status}">${esc(STATUS_LABELS[r.status] || r.status)}</span>
            <span class="muted ago">${esc(fmtAgo(r.last_attempt))}</span>
          </li>`).join('')}</ul>`
          : `<div class="empty"><div class="ei">◷</div>
               <p>Chưa có lần thử nào được ghi lại.</p>
               <span>Chạy một lượt ở tab Chạy đổi để lịch sử có dữ liệu.</span></div>`}
      </section>

      <section class="card">
        <div class="card-hd"><h3>Hai loại mã, hai cách dùng</h3></div>
        <div class="two">
          <div class="note">
            <b>Gift code</b>
            <p>Đổi trên web tại redeem.df.garena.sg. Tab <b>Chạy đổi</b> làm việc này.</p>
          </div>
          <div class="note">
            <b>Preset Gunsmith</b>
            <p>Dán trong game: Gunsmith → Loadout → nút kính lúp. Không đổi qua web được.</p>
          </div>
        </div>
      </section>
    </div>`;
  }

  /* ── library ───────────────────────────────────────────────────────────── */
  function filteredCodes() {
    const q = libFilter.q.trim().toUpperCase();
    let rows = cache.codes.filter((r) => {
      if (libFilter.status !== 'all' && r.status !== libFilter.status) return false;
      if (q && !String(r.code).toUpperCase().includes(q)) return false;
      return true;
    });
    const dir = libFilter.sort === 'recent' ? -1 : 1;
    rows.sort((a, b) => {
      if (libFilter.sort === 'recent') {
        return dir * (new Date(a.last_attempt || 0) - new Date(b.last_attempt || 0));
      }
      if (libFilter.sort === 'status') return String(a.status).localeCompare(String(b.status)) || String(a.code).localeCompare(String(b.code));
      return String(a.code).localeCompare(String(b.code));
    });
    return rows;
  }

  function renderLibrary() {
    const rows = filteredCodes();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (libPage >= pages) libPage = pages - 1;
    const page = rows.slice(libPage * PAGE_SIZE, (libPage + 1) * PAGE_SIZE);

    const chips = ['all'].concat(STATUS_ORDER).map((k) => {
      const n = k === 'all' ? cache.codes.length : ((cache.stats && cache.stats.byStatus && cache.stats.byStatus[k]) || 0);
      const on = libFilter.status === k ? ' on' : '';
      const label = k === 'all' ? 'Tất cả' : STATUS_LABELS[k];
      return `<button class="chip${on}" data-act="fchip" data-k="${k}">
        ${k !== 'all' ? `<i class="s-${k}"></i>` : ''}${esc(label)} <b>${n}</b></button>`;
    }).join('');

    viewHost.innerHTML = `<div class="pad">
      <div class="filters">
        <input class="fq" placeholder="Tìm mã…" value="${esc(libFilter.q)}" aria-label="Tìm mã">
        <select class="fstatus" aria-label="Lọc trạng thái">
          <option value="all">Mọi trạng thái</option>
          ${STATUS_ORDER.map((k) => `<option value="${k}"${libFilter.status === k ? ' selected' : ''}>${esc(STATUS_LABELS[k])}</option>`).join('')}
        </select>
        <select class="fsort" aria-label="Sắp xếp">
          <option value="code"${libFilter.sort === 'code' ? ' selected' : ''}>A→Z</option>
          <option value="recent"${libFilter.sort === 'recent' ? ' selected' : ''}>Mới thử</option>
          <option value="status"${libFilter.sort === 'status' ? ' selected' : ''}>Trạng thái</option>
        </select>
      </div>

      <div class="chiprow">${chips}</div>

      <div class="bulk ${selection.size ? '' : 'off'}">
        <b>${selection.size} mã đã chọn</b>
        <span class="spacer"></span>
        <button class="act tiny" data-act="bulk-copy">Copy</button>
        <button class="act tiny" data-act="bulk-queue">Đưa vào hàng chờ</button>
        <button class="act tiny ghost" data-act="bulk-clear">Bỏ chọn</button>
      </div>

      ${rows.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr>
          <th class="cbx"><input type="checkbox" class="pick-all" aria-label="Chọn cả trang"></th>
          <th>Mã</th><th>Trạng thái</th><th>Lần thử</th><th></th>
        </tr></thead>
        <tbody>${page.map((r) => `<tr data-code="${esc(r.code)}">
          <td class="cbx"><input type="checkbox" class="pick"${selection.has(r.code) ? ' checked' : ''} aria-label="Chọn ${esc(r.code)}"></td>
          <td><code class="mono">${esc(r.code)}</code></td>
          <td><span class="pill s-${r.status}">${esc(STATUS_LABELS[r.status] || r.status)}</span></td>
          <td class="num">${r.attempt_count || 0}<span class="muted sub">${esc(fmtTime(r.last_attempt))}</span></td>
          <td class="rowacts">
            <button class="ico tiny" data-act="row-copy" data-code="${esc(r.code)}" title="Copy mã">⧉</button>
            <button class="ico tiny" data-act="row-hist" data-code="${esc(r.code)}" title="Lịch sử mã này">◷</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>

      <div class="pager">
        <button class="act tiny" data-act="pg-prev"${libPage === 0 ? ' disabled' : ''}>← Trước</button>
        <span>Trang ${libPage + 1}/${pages} · ${rows.length} mã</span>
        <button class="act tiny" data-act="pg-next"${libPage >= pages - 1 ? ' disabled' : ''}>Sau →</button>
      </div>`
      : `<div class="empty"><div class="ei">▤</div>
           <p>Không có mã nào khớp.</p>
           <span>Đổi bộ lọc hoặc xoá từ khoá tìm kiếm.</span>
           <button class="act tiny" data-act="fclear">Xoá bộ lọc</button></div>`}
    </div>`;
  }

  /* ── run ───────────────────────────────────────────────────────────────── */
  function renderRun() {
    const untried = untriedCodes();
    const retryable = cache.codes.filter((r) => r.status === 'sys_error');
    const onRedeemPage = /redeem\.df\.garena\.sg$/.test(location.hostname || '');
    const queued = store.get('queue', '');

    viewHost.innerHTML = `<div class="pad">
      ${onRedeemPage ? '' : `<div class="warn-box">
        <b>Không ở trang đổi code.</b>
        <p>Tab này cần mở tại <code class="mono">redeem.df.garena.sg/vi/cdkgarena.html</code> và đã đăng nhập.</p>
        <button class="act tiny" data-act="open-redeem">Mở trang đổi code →</button>
      </div>`}

      <section class="card">
        <div class="card-hd"><h3>Hàng chờ</h3><span class="muted qcount">0 mã</span></div>
        <div class="runbar">
          <div class="runstat">
            <button class="act tiny" data-act="q-untried">Mã chưa thử (${untried.length})</button>
            ${retryable.length ? `<button class="act tiny" data-act="q-sys-error">Garena lỗi — thử lại (${retryable.length})</button>` : ''}
            <button class="act tiny" data-act="q-clear">Xoá hàng chờ</button>
          </div>
          <textarea class="queue" rows="7" placeholder="Mỗi dòng một mã. Dán từ bất kỳ đâu — ký tự lạ sẽ được lọc.">${esc(queued)}</textarea>
        </div>
      </section>

      <section class="card">
        <div class="card-hd"><h3>Nhịp gửi</h3><span class="muted">Chậm hơn = ít bị chặn hơn</span></div>
        <div class="pacerow">
          <label class="fld"><span>Giãn cách (ms)</span>
            <input class="pace" type="number" min="400" step="100" value="1200"></label>
          <label class="fld"><span>Thử lại tối đa</span>
            <input class="retries" type="number" min="0" max="5" value="2"></label>
          <label class="check"><input type="checkbox" class="variants" checked>
            <span>Dò biến thể OCR</span></label>
        </div>
      </section>

      <div class="runline">
        <button class="act primary go" data-act="start">Bắt đầu</button>
        <button class="act" data-act="pause" disabled>Tạm dừng</button>
        <button class="act danger" data-act="stop" disabled>Dừng</button>
      </div>

      <section class="card prog-card" hidden>
        <div class="card-hd"><h3>Đang chạy</h3><span class="muted prog-eta"></span></div>
        <div class="prog"><i></i></div>
        <div class="prog-txt muted">Chuẩn bị…</div>
        <div class="tally"></div>
        <pre class="log"></pre>
      </section>
    </div>`;
    updateQueueCount();
  }

  function updateQueueCount() {
    const q = $('.queue');
    const label = $('.qcount');
    if (!q || !label) return;
    const n = parseQueue(q.value).length;
    label.textContent = n + ' mã';
  }

  function parseQueue(text) {
    const C = root.DFRedeemCodes;
    if (C && C.parseCodes) return C.parseCodes(text).codes.map((row) => row.code);
    /* Keep the submitted spelling: some legacy Garena codes are case-sensitive.
     * Deduplication happens in the parser with an uppercase canonical key. */
    const seen = new Set();
    return String(text || '').split(/[^A-Za-z0-9]+/)
      .map((value) => value.trim())
      .filter((value) => value.length >= 6 && !seen.has(value.toUpperCase()) && (seen.add(value.toUpperCase()), true));
  }

  async function startRun() {
    if (activeRun) return toast('Đang có lượt chạy.', 'warn');
    const codes = parseQueue($('.queue') ? $('.queue').value : '');
    if (!codes.length) return toast('Hàng chờ trống.', 'warn');
    if (!E) return toast('Thiếu engine.', 'err');

    const pace = Number(($('.pace') && $('.pace').value) || 1200);
    const retries = Number(($('.retries') && $('.retries').value) || 2);
    const variants = !$('.variants') || $('.variants').checked;

    store.set('queue', codes.join('\n'));

    const card = $('.prog-card');
    const bar = $('.prog i');
    const txt = $('.prog-txt');
    const eta = $('.prog-eta');
    const tally = $('.tally');
    const logEl = $('.log');
    if (card) card.hidden = false;
    if (logEl) logEl.textContent = '';

    $('[data-act="start"]').disabled = true;
    $('[data-act="pause"]').disabled = false;
    $('[data-act="stop"]').disabled = false;

    const counts = {};
    const t0 = Date.now();
    /* engine.js exports RedeemRun, and its constructor takes the queue as its
     * own first argument — not a config object with a `codes` key. Getting
     * either half wrong throws inside this async handler, which leaves the UI
     * frozen on "Chuẩn bị…" with nothing in the console, so construction is
     * guarded and any failure is surfaced and the controls released. */
    let run;
    try {
      run = new E.RedeemRun(
        codes.map((c) => ({ code: c, source: 'panel' })),
        { delayMs: pace, maxRetries: retries, tryVariants: variants },
      );
    } catch (e) {
      toast('Không khởi tạo được lượt chạy: ' + e.message, 'err');
      if (txt) txt.textContent = 'Lỗi khởi tạo: ' + e.message;
      const s = $('[data-act="start"]'); if (s) s.disabled = false;
      const p = $('[data-act="pause"]'); if (p) p.disabled = true;
      const st = $('[data-act="stop"]'); if (st) st.disabled = true;
      return;
    }
    activeRun = run;

    /* Open a run row before the first attempt so every result carries a real
     * run_id and the History view can group attempts per run. Without this the
     * runs store stayed empty forever and each attempt logged run_id ''. */
    let runRow = null;
    if (vault && vault.createRun) {
      try {
        runRow = await vault.createRun({ total: codes.length, source: surface || 'panel' });
      } catch (_) { runRow = null; }
    }

    run.on('progress', (p) => {
      const pct = p.total ? Math.round((p.position / p.total) * 100) : 0;
      if (bar) bar.style.width = pct + '%';
      if (txt) txt.textContent = `${p.position}/${p.total} · ${p.code || ''} ${p.phase ? '· ' + p.phase : ''}`;
      if (eta && p.position > 1) {
        const per = (Date.now() - t0) / p.position;
        eta.textContent = 'còn ~' + fmtDur(per * (p.total - p.position));
      }
    });
    run.on('log', (l) => {
      if (!logEl) return;
      logEl.textContent = (l.message + '\n' + logEl.textContent).split('\n').slice(0, 80).join('\n');
    });
    run.on('result', async (r) => {
      counts[r.status] = (counts[r.status] || 0) + 1;
      if (tally) {
        tally.innerHTML = Object.keys(counts).map((k) =>
          `<span class="pill">${esc(k)} <b>${counts[k]}</b></span>`).join('');
      }
      if (vault && vault.recordAttempt) {
        /* recordAttempt(codeValue, result, runId): the code is its own first
         * argument. Passing the whole result object made the code field an
         * object, which History then rendered as "[OBJECTOBJECT]".
         *
         * The verdict must also be translated into a vault status, or the write
         * falls through to the stored value and every attempt reads "Chưa thử".
         * A null mapping (throttling, captcha, network) intentionally leaves the
         * status untouched while still logging the attempt. */
        const mapped = G && G.vaultStatus ? G.vaultStatus(r.status) : null;
        try {
          await vault.recordAttempt(r.code, Object.assign({}, r, {
            status: mapped || undefined,
            result_msg: r.detail || r.label || '',
            err_code: r.errorCode,
          }), (runRow && runRow.id) || run.id || '');
          /* Mirror into shared storage so the other surfaces see this run. */
          if (opts.sync && opts.sync.mirrorAttempts) {
            opts.sync.mirrorAttempts([{
              code: r.code,
              status: mapped || 'untried',
              result_msg: r.detail || r.label || '',
              err_code: r.errorCode || null,
              timestamp: new Date().toISOString(),
              surface: surface || 'panel',
            }]).catch(() => {});
          }
        } catch (_) {}
      }
    });

    try {
      await run.run();
      const s = run.summary();
      toast(`Xong ${s.processed}/${s.total} mã · ${s.success} thành công.`, s.success ? 'ok' : '');
    } catch (e) {
      toast('Lượt chạy lỗi: ' + e.message, 'err');
    } finally {
      activeRun = null;
      /* Close the run row so History shows a finished run with its tally
       * instead of one that looks stuck in "running" forever. */
      if (runRow && vault && vault.finishRun) {
        const s = (() => { try { return run.summary(); } catch (_) { return {}; } })();
        try {
          await vault.finishRun(runRow.id, {
            status: 'done',
            total: s.total || codes.length,
            processed: s.processed || 0,
            success: s.success || 0,
          });
        } catch (_) {}
      }
      /* Keep the credential-backed personal cloud sync opt-in separate from the
       * public, credential-free community vault. It snapshots only after every
       * attempt is stored. */
      if (opts.sync && opts.sync.syncNow && vault && vault.all) {
        try {
          const settings = opts.sync.getSettings ? await opts.sync.getSettings() : null;
          if (!settings || (settings.enabled !== false && settings.autoSync !== false)) {
            const reply = await opts.sync.syncNow(await vault.all());
            const syncStatus = reply && reply.status ? reply.status : reply;
            if (syncStatus && syncStatus.state === 'error') toast('Đồng bộ cá nhân lỗi: ' + (syncStatus.error || 'không rõ'), 'err');
          }
        } catch (error) {
          toast('Đồng bộ cá nhân lỗi: ' + (error && error.message || error), 'err');
        }
      }
      /* Public community synchronization is credential-free and deliberately
       * separate: only globally meaningful verdicts are reported. */
      if (opts.sync && vault && vault.all) {
        const community = await syncCommunityVault({ pull: true, push: true });
        if (community.pushed && !community.pushed.ok && !community.pushed.skipped) {
          toast('Đồng bộ cộng đồng lỗi: ' + (community.pushed.error || 'không rõ'), 'err');
        }
      }
      const start = $('[data-act="start"]');
      if (start) start.disabled = false;
      const p = $('[data-act="pause"]'); if (p) { p.disabled = true; p.textContent = 'Tạm dừng'; }
      const st = $('[data-act="stop"]'); if (st) st.disabled = true;
      await refresh();
    }
  }

  /* ── presets ───────────────────────────────────────────────────────────── */
  /* `mode` is community text collected in Vietnamese and English, so normalize
   * only proven aliases before grouping. Without this, one multiplayer mode is
   * shown as three separate sections and one Operations mode as two. Keep unknown
   * labels visible rather than guessing — they need a curator's decision. */
  const MODE_ALIASES = {
    'Havoc Warfare': 'Chiến Trường Toàn Diện',
    Warfare: 'Chiến Trường Toàn Diện',
    Operations: 'Chiến Dịch Sinh Tồn',
    'Chiến Dịch (Thoát Hiểm)': 'Chiến Dịch Sinh Tồn',
  };
  const canonicalMode = (mode) => MODE_ALIASES[String(mode || '').trim()] || String(mode || '').trim() || 'Khác';

  function renderPresets() {
    const list = cache.presets.slice();
    const modes = {};
    for (const p of list) {
      const m = canonicalMode(p.mode);
      (modes[m] = modes[m] || []).push(p);
    }
    const keys = Object.keys(modes).sort();

    viewHost.innerHTML = `<div class="pad">
      <div class="info-box">
        <b>Loại mã này nhập trong game, không đổi qua web.</b>
        <p>Gunsmith → Loadout → nút kính lúp → dán mã. Linh kiện chưa mở khoá sẽ không nạp được.</p>
      </div>

      ${list.length ? keys.map((m) => `<section class="card">
        <div class="card-hd"><h3>${esc(m)}</h3><span class="muted">${modes[m].length} mã</span></div>
        <div class="pgrid">${modes[m].map((p) => `<div class="pcard">
          <div class="pc-hd">
            <b>${esc(p.weapon || p.gun || '—')}</b>
            ${p.format ? `<span class="tag">${esc(p.format)}</span>` : ''}
          </div>
          <code class="mono pc-code">${esc(p.code)}</code>
          <div class="pc-ft">
            <span class="muted">${esc(p.source || '')}</span>
            <button class="act tiny" data-act="row-copy" data-code="${esc(p.code)}">Copy</button>
          </div>
        </div>`).join('')}</div>
      </section>`).join('')
      : `<div class="empty"><div class="ei">⌖</div><p>Chưa có code súng nào.</p></div>`}
    </div>`;
  }

  /* ── share ─────────────────────────────────────────────────────────────── */
  function renderShare() {
    const gifts = shareableCodes();
    const presets = cache.presets;
    /* How much of the local vault came from the shared list, so the card says
     * something before any button is pressed rather than sitting blank. */
    const fromCommunity = cache.codes.filter((c) => (c.tags || []).includes('community')).length;

    viewHost.innerHTML = `<div class="pad">
      <section class="card">
        <div class="card-hd"><h3>Kho cộng đồng</h3><span class="muted community-count">${fromCommunity} mã từ cộng đồng</span></div>
        <p class="muted tight">Tải danh sách mã mọi người đã kiểm chứng về máy, và gửi kết quả của bạn lên để người khác khỏi thử lại mã đã chết. Chỉ gửi mã và mã lỗi Garena trả về — không gửi tài khoản, cookie hay thời điểm.</p>
        <div class="btnrow">
          <button class="act primary" data-act="community-pull">Tải mã mới về</button>
          <button class="act" data-act="community-push">Gửi kết quả của tôi</button>
        </div>
        <p class="muted tight community-status"></p>
      </section>

      <section class="card">
        <div class="card-hd"><h3>Gift code chia sẻ được</h3><span class="muted">${gifts.length} mã</span></div>
        <p class="muted tight">Gồm mã Garena đã xác nhận thành công và mã tài khoản này đã nhận — người khác vẫn đổi được.</p>
        <div class="sharebox">
          <textarea class="share-gift" rows="7" readonly>${esc(gifts.map((r) => r.code).join('\n'))}</textarea>
          <div class="btnrow">
            <button class="act" data-act="share-copy-gift">Copy</button>
            <button class="act" data-act="share-txt-gift">Tải .txt</button>
            <button class="act" data-act="share-csv-gift">Tải .csv</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-hd"><h3>Preset Gunsmith</h3><span class="muted">${presets.length} mã</span></div>
        <p class="muted tight">Định dạng <code class="mono">Súng-Chế độ-Mã</code> để người nhận biết dán vào đâu.</p>
        <div class="sharebox">
          <textarea class="share-preset" rows="7" readonly>${esc(presets.map((r) => `${r.weapon || r.gun || '?'}-${r.mode || '?'}-${r.code}`).join('\n'))}</textarea>
          <div class="btnrow">
            <button class="act" data-act="share-copy-preset">Copy</button>
            <button class="act" data-act="share-txt-preset">Tải .txt</button>
            <button class="act" data-act="share-csv-preset">Tải .csv</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-hd"><h3>Gói đầy đủ</h3></div>
        <p class="muted tight">Một file Markdown gồm cả hai loại, kèm hướng dẫn dùng.</p>
        <button class="act primary" data-act="share-both">Tải .md đầy đủ</button>
      </section>
    </div>`;
  }

  /* ── history ───────────────────────────────────────────────────────────── */
  function renderHistory() {
    /* The results store is the only real record of attempts: one row per try,
     * newest first. Code rows carry the latest outcome, not the sequence. */
    const events = (cache.history || [])
      .filter((r) => !historyCode || String(r.code).toUpperCase() === String(historyCode).toUpperCase())
      .map((r) => ({
        code: r.code,
        status: r.status,
        at: r.timestamp,
        note: [r.result_msg, r.err_code ? '#' + r.err_code : '', r.variant_used].filter(Boolean).join(' · '),
      }))
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

    viewHost.innerHTML = `<div class="pad">
      ${historyCode ? `<div class="bulk">
        <b>Đang xem: <code class="mono">${esc(historyCode)}</code></b>
        <span class="spacer"></span>
        <button class="act tiny" data-act="hist-all">Xem tất cả</button>
      </div>` : ''}

      ${events.length ? `<ol class="tline">${events.slice(0, 200).map((e) => `<li>
        <span class="dot s-${e.status}"></span>
        <div class="tl-body">
          <div class="tl-top">
            <code class="mono">${esc(e.code)}</code>
            <span class="pill s-${e.status}">${esc(STATUS_LABELS[e.status] || e.status)}</span>
          </div>
          <div class="muted">${esc(fmtTime(e.at))} · ${esc(fmtAgo(e.at))}${e.note ? ' · ' + esc(e.note) : ''}</div>
        </div>
      </li>`).join('')}</ol>`
      : `<div class="empty"><div class="ei">◷</div>
           <p>Chưa có lần thử nào được ghi lại.</p>
           <span>Lịch sử chỉ ghi các lượt chạy từ tab Chạy đổi. Mã đổi tay trên trang Garena không vào đây.</span>
           <button class="act tiny primary" data-act="goto-run">Mở tab Chạy đổi</button></div>`}
    </div>`;
  }

  /* ── router ────────────────────────────────────────────────────────────── */
  const RENDER = {
    dashboard: renderDashboard, library: renderLibrary, run: renderRun,
    presets: renderPresets, share: renderShare, history: renderHistory,
  };

  async function go(name) {
    if (!VIEWS.includes(name)) name = 'dashboard';
    view = name;
    store.set('view', name);
    $$('.vtab').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
    await refresh();
    RENDER[name]();
    renderFooter();
    renderBadges();
  }

  function renderBadges() {
    const n = untriedCodes().length;
    $$('.vtab').forEach((b) => {
      const old = b.querySelector('.badge');
      if (old) b.removeChild(old);
      if (b.dataset.view === 'run' && n > 0) {
        const s = document.createElement('span');
        s.className = 'badge';
        s.textContent = String(n);
        b.appendChild(s);
      }
    });
  }

  function renderFooter() {
    const s = cache.stats || {};
    const sv = s.seedVersion != null ? s.seedVersion
      : (typeof DF_REDEEM_SEED !== 'undefined' && DF_REDEEM_SEED.version) || '?';
    footer.innerHTML = `<span>${cache.codes.length} gift · ${cache.presets.length} preset</span>
      <span class="spacer"></span>
      <span>seed v${esc(sv)}</span>
      <span class="kbd-hint"><kbd>Ctrl</kbd><kbd>K</kbd></span>`;
  }

  /* ── command palette ───────────────────────────────────────────────────── */
  function paletteItems() {
    const items = VIEWS.map((v) => ({
      label: VIEW_LABELS[v], hint: VIEW_HINTS[v], icon: VIEW_ICONS[v],
      run: () => { historyCode = null; go(v); },
    }));
    items.push(
      { label: 'Tải lại dữ liệu', hint: 'Đọc lại từ kho', icon: '⟳', run: () => go(view) },
      { label: 'Đưa mã chưa thử vào hàng chờ', hint: untriedCodes().length + ' mã', icon: '▶',
        run: async () => { await go('run'); const q = $('.queue'); if (q) { q.value = untriedCodes().map((r) => r.code).join('\n'); updateQueueCount(); } } },
      { label: 'Copy danh sách chia sẻ', hint: shareableCodes().length + ' mã', icon: '⧉',
        run: () => copy(shareableCodes().map((r) => r.code).join('\n'), 'danh sách chia sẻ') },
      { label: 'Thu gọn bảng', hint: 'Esc', icon: '✕', run: closePanel },
    );
    return items;
  }

  function openPalette() {
    paletteOpen = true;
    palette.hidden = false;
    const q = palette.querySelector('.pq');
    q.value = '';
    fillPalette('');
    if (q.focus) q.focus();
  }
  function closePalette() { paletteOpen = false; palette.hidden = true; }

  function fillPalette(q) {
    const needle = String(q || '').trim().toUpperCase();
    const box = palette.querySelector('.phits');
    let hits = paletteItems().filter((i) => !needle || (i.label + ' ' + i.hint).toUpperCase().includes(needle));

    /* a query that looks like a code jumps straight to that code's history */
    if (needle.length >= 4) {
      const match = cache.codes.concat(cache.presets)
        .filter((r) => String(r.code).toUpperCase().includes(needle)).slice(0, 5);
      hits = match.map((r) => ({
        label: r.code, hint: STATUS_LABELS[r.status] || r.status, icon: '◷',
        run: () => { historyCode = r.code; go('history'); },
      })).concat(hits);
    }

    const top = hits.slice(0, 8);
    box.innerHTML = top.map((h, i) => `<button class="phit${i === 0 ? ' on' : ''}" data-i="${i}">
      <span class="pi">${h.icon}</span><b>${esc(h.label)}</b><span class="muted">${esc(h.hint)}</span></button>`).join('')
      || '<div class="pnone muted">Không có lệnh nào khớp.</div>';
    palette._hits = top;
  }

  palette.addEventListener('input', (e) => { if (e.target.classList.contains('pq')) fillPalette(e.target.value); });
  palette.addEventListener('click', (e) => {
    const hit = e.target.closest ? e.target.closest('.phit') : null;
    if (hit && palette._hits) { closePalette(); palette._hits[Number(hit.dataset.i)].run(); return; }
    if (e.target === palette) closePalette();
  });
  palette.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return closePalette();
    const btns = Array.prototype.slice.call(palette.querySelectorAll('.phit'));
    const cur = btns.findIndex((b) => b.classList.contains('on'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (e.preventDefault) e.preventDefault();
      const next = (cur + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns.forEach((b, i) => b.classList.toggle('on', i === next));
    }
    if (e.key === 'Enter' && palette._hits && palette._hits[cur]) {
      if (e.preventDefault) e.preventDefault();
      closePalette(); palette._hits[cur].run();
    }
  });

  /* ── helpers ───────────────────────────────────────────────────────────── */
  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Đã copy ' + (what || '') + '.', 'ok');
    } catch (_) { toast('Không copy được — chọn và Ctrl+C thủ công.', 'warn'); }
  }

  function download(name, body, mime) {
    try {
      const blob = new Blob([body], { type: mime || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); try { document.body.removeChild(a); } catch (_) {} }, 0);
      toast('Đã tải ' + name, 'ok');
    } catch (e) { toast('Không tải được: ' + e.message, 'err'); }
  }

  const csvOf = (rows, cols) => '\ufeff' + [cols.join(',')]
    .concat(rows.map((r) => cols.map((c) => `"${String(r[c] == null ? '' : r[c]).replace(/"/g, '""')}"`).join(',')))
    .join('\r\n');

  /* ── events ────────────────────────────────────────────────────────────── */
  shell.addEventListener('input', (e) => {
    const t = e.target;
    if (t.classList.contains('fq')) { libFilter.q = t.value; libPage = 0; renderLibrary(); }
    if (t.classList.contains('queue')) { store.set('queue', t.value); updateQueueCount(); }
  });

  shell.addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('fstatus')) { libFilter.status = t.value; libPage = 0; renderLibrary(); }
    if (t.classList.contains('fsort')) { libFilter.sort = t.value; renderLibrary(); }
    if (t.classList.contains('pick')) {
      const tr = t.closest('tr');
      const code = tr && tr.dataset.code;
      if (code) { t.checked ? selection.add(code) : selection.delete(code); renderLibrary(); }
    }
    if (t.classList.contains('pick-all')) {
      const codes = $$('tbody tr').map((tr) => tr.dataset.code).filter(Boolean);
      codes.forEach((c) => (t.checked ? selection.add(c) : selection.delete(c)));
      renderLibrary();
    }
  });

  shell.addEventListener('click', async (e) => {
    const tab = e.target.closest ? e.target.closest('.vtab') : null;
    if (tab) { historyCode = null; return go(tab.dataset.view); }

    const btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'palette') return openPalette();
    if (act === 'refresh') { await go(view); return toast('Đã tải lại.', 'ok'); }
    if (act === 'goto-run') { historyCode = null; return go('run'); }
    if (act === 'goto-share') return go('share');
    if (act === 'goto-history') { historyCode = null; return go('history'); }
    if (act === 'hist-all') { historyCode = null; return go('history'); }
    if (act === 'open-redeem') { location.href = 'https://redeem.df.garena.sg/vi/cdkgarena.html'; return; }

    /* library */
    if (act === 'fchip') { libFilter.status = btn.dataset.k; libPage = 0; return renderLibrary(); }
    if (act === 'fclear') { libFilter = { status: 'all', q: '', sort: libFilter.sort }; libPage = 0; return renderLibrary(); }
    if (act === 'pg-prev') { libPage = Math.max(0, libPage - 1); return renderLibrary(); }
    if (act === 'pg-next') { libPage += 1; return renderLibrary(); }
    if (act === 'row-copy') return copy(btn.dataset.code, 'mã ' + btn.dataset.code);
    if (act === 'row-hist') { historyCode = btn.dataset.code; return go('history'); }
    if (act === 'bulk-clear') { selection.clear(); return renderLibrary(); }
    if (act === 'bulk-copy') return copy([...selection].join('\n'), selection.size + ' mã');
    if (act === 'bulk-queue') {
      const picked = [...selection];
      await go('run');
      const q = $('.queue');
      if (q) { q.value = picked.join('\n'); store.set('queue', q.value); updateQueueCount(); }
      return toast(picked.length + ' mã đã vào hàng chờ.', 'ok');
    }

    /* run */
    if (act === 'q-untried') {
      const q = $('.queue');
      if (q) { q.value = untriedCodes().map((r) => r.code).join('\n'); store.set('queue', q.value); updateQueueCount(); }
      return;
    }
    if (act === 'q-clear') { const q = $('.queue'); if (q) { q.value = ''; store.del('queue'); updateQueueCount(); } return; }
    /* Error 51 rows are the ones Garena never gave a verdict for, so they are
     * the only group worth re-sending wholesale. */
    if (act === 'q-sys-error') {
      const q = $('.queue');
      const rows = cache.codes.filter((r) => r.status === 'sys_error');
      if (q) { q.value = rows.map((r) => r.code).join('\n'); store.set('queue', q.value); updateQueueCount(); }
      return toast(rows.length + ' mã lỗi hệ thống đã vào hàng chờ.', 'ok');
    }
    if (act === 'start') return startRun();
    if (act === 'pause') {
      if (!activeRun) return;
      if (activeRun.paused) { activeRun.resume(); btn.textContent = 'Tạm dừng'; }
      else { activeRun.pause(); btn.textContent = 'Tiếp tục'; }
      return;
    }
    if (act === 'stop') { if (activeRun) { activeRun.stop('Người dùng dừng.'); toast('Đang dừng…', 'warn'); } return; }

    /* community vault */
    if (act === 'community-pull') {
      if (!opts.sync || !opts.sync.communityPull) return toast('Bản này không có kho cộng đồng.', 'warn');
      const note = $('.community-status');
      if (note) note.textContent = 'Đang tải…';
      try {
        const synced = await syncCommunityVault({ pull: true, push: false });
        const merged = synced.pulled;
        if (!merged) throw new Error('không tải được');
        go('share');
        const msg = `Thêm ${merged.added} mã mới, cập nhật ${merged.updated} mã.`;
        toast(msg, 'ok');
        const after = $('.community-status');
        if (after) after.textContent = msg;
      } catch (error) {
        const msg = 'Không tải được kho cộng đồng: ' + String(error && error.message || error);
        toast(msg, 'err');
        const after = $('.community-status');
        if (after) after.textContent = msg;
      }
      return;
    }
    if (act === 'community-push') {
      if (!opts.sync || !opts.sync.communityPush) return toast('Bản này không có kho cộng đồng.', 'warn');
      const note = $('.community-status');
      if (note) note.textContent = 'Đang gửi…';
      try {
        const reply = await opts.sync.communityPush(cache.codes);
        if (!reply || !reply.ok) throw new Error((reply && reply.error) || (reply && reply.skipped) || 'không gửi được');
        const needed = Math.max(1, Number(reply.needed || 2));
        const msg = reply.sent
          ? `Đã gửi ${reply.sent} kết quả. Mã mới cần ${needed} người dùng độc lập xác nhận mới vào kho chung.`
          : 'Không có kết quả dùng chung để gửi — dữ liệu account chỉ giữ trên máy này.';
        toast(msg, 'ok');
        const after = $('.community-status');
        if (after) after.textContent = msg;
      } catch (error) {
        const msg = 'Không gửi được: ' + String(error && error.message || error);
        toast(msg, 'err');
        const after = $('.community-status');
        if (after) after.textContent = msg;
      }
      return;
    }

    /* share */
    if (act === 'share-copy-gift') return copy($('.share-gift').value, 'danh sách gift code');
    if (act === 'share-copy-preset') return copy($('.share-preset').value, 'danh sách preset');
    if (act === 'share-txt-gift') return download('gift-codes-chia-se.txt', $('.share-gift').value);
    if (act === 'share-txt-preset') return download('code-sung-op.txt', $('.share-preset').value);
    if (act === 'share-csv-gift') {
      return download('gift-codes-chia-se.csv',
        csvOf(shareableCodes(), ['code', 'status', 'source', 'attempt_count', 'last_attempt']),
        'text/csv;charset=utf-8');
    }
    if (act === 'share-csv-preset') {
      return download('code-sung-op.csv',
        csvOf(cache.presets, ['code', 'weapon', 'mode', 'format', 'source']),
        'text/csv;charset=utf-8');
    }
    if (act === 'share-both') {
      const md = [
        '# Code Delta Force chia sẻ', '',
        '## Gift code — đổi tại redeem.df.garena.sg/vi/cdkgarena.html', '',
        '```', $('.share-gift').value, '```', '',
        '## Preset Gunsmith — nhập trong game', '',
        'Gunsmith → Loadout → nút kính lúp → dán mã. Linh kiện chưa mở khoá sẽ không nạp được.', '',
        '```', $('.share-preset').value, '```', '',
      ].join('\n');
      return download('df-code-chia-se.md', md, 'text/markdown;charset=utf-8');
    }
  });

  /* ── drawer resize ─────────────────────────────────────────────────────── */
  (function resizable() {
    const grip = $('.grip');
    if (!grip || !grip.addEventListener) return;
    let dragging = false;
    grip.addEventListener('mousedown', (e) => {
      dragging = true; grip.classList.add('active');
      if (e.preventDefault) e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const w = Math.min(Math.max(vw - e.clientX, 380), Math.min(920, vw));
      shell.style.cssText = '--w:' + Math.round(w) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; grip.classList.remove('active');
      const w = parseInt(String(shell.style.cssText).replace(/\D/g, ''), 10);
      if (w) store.set('drawerWidth', w);
    });
  }());

  /* ── shell behaviour ───────────────────────────────────────────────────── */
  function mountHost() { if (!host.isConnected) document.documentElement.appendChild(host); }

  async function open() {
    mountHost();
    shell.hidden = false;
    launcher.hidden = true;
    if (vault && !vault._ready) {
      try {
        if (vault.init) await vault.init();
        if (vault.seedOnFirstRun && typeof DF_REDEEM_SEED !== 'undefined') await vault.seedOnFirstRun(DF_REDEEM_SEED);
        vault._ready = true;
      } catch (e) { toast('Không mở được kho dữ liệu: ' + e.message, 'err'); }
    }
    await syncCommunityVault({ pull: true, push: false });
    await go(view);
  }
  function closePanel() { shell.hidden = true; launcher.hidden = false; }
  function mountLauncher() { mountHost(); launcher.hidden = false; }

  $('.close').addEventListener('click', closePanel);
  launcher.addEventListener('click', open);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      if (e.preventDefault) e.preventDefault();
      if (shell.hidden) open();
      return paletteOpen ? closePalette() : openPalette();
    }
    if (e.altKey && (e.key === 'd' || e.key === 'D')) {
      if (e.preventDefault) e.preventDefault();
      return shell.hidden ? open() : closePanel();
    }
    if (shell.hidden) return;
    if (e.key === 'Escape') return paletteOpen ? closePalette() : closePanel();
    if (e.altKey && /^[1-6]$/.test(e.key)) { historyCode = null; go(VIEWS[Number(e.key) - 1]); }
  });

  async function setSyncChip() {
    const chip = $('.sync-chip');
    if (!chip || !opts.sync || !opts.sync.status) { if (chip) chip.hidden = true; return; }
    try {
      const s = await opts.sync.status();
      const label = { ok: 'Đã đồng bộ', syncing: 'Đang đồng bộ…', error: 'Lỗi đồng bộ', 'never-synced': 'Chưa đồng bộ' }[s.state] || s.state;
      chip.hidden = false;
      chip.textContent = label;
      chip.className = 'sync-chip st-' + s.state;
    } catch (_) {}
  }
  setSyncChip();

  return {
    open, close: closePanel, mountLauncher, go, refresh,
    start: startRun,
    palette: openPalette,
    getStats: () => cache.stats,
    getResults: () => cache.codes.slice(),
    vault, surface,
    _host: host, _shadow: shadow, _views: VIEWS, _shell: shell,
  };
}

  const sync = (() => {
    /* No chromeApi: without it the service cannot read stored settings, so pass
     * the defaults in explicitly on every call. */
    const svc = DFRedeemSync.createSyncService({ fetchFn: (...a) => fetch(...a) });
    const settings = DFRedeemSync.publicSettings();
    return {
      communityPull: () => svc.fetchCommunity(settings),
      communityPush: (rows) => svc.reportOutcomes(rows || [], settings),
    };
  })();

  const panel = createPanel({ version: '3.1.3', target: 'console', sync });
  window.__dfRedeemPanel = panel;
  panel.open();
  console.log('%c[DF Redeem v3.1.3]%c bảng điều khiển đã mở. Dán danh sách code vào ô, bấm Bắt đầu.',
    'background:#10f79a;color:#03110d;font-weight:700;padding:2px 7px;border-radius:3px', '');
}());
