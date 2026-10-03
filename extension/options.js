/* Delta Force Auto Redeem v3.3.4
 * Built v3.3.4 — local build, no remote source
 *
 * Verifies every redeem against the network response body, never the popup.
 * No telemetry, no remote code, no credential access. Runs only on
 * redeem.df.garena.sg pages you already opened and logged into.
 */
/* options.js — personal backup settings, local vault export, danger zone.
 * Settings go through the service worker so the token never reaches this
 * page; the vault is read directly because it is this origin's IndexedDB. */
(function dfRedeemOptions() {
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

  const STATUS_KEY = 'dfRedeemSyncStatus';
  const $ = (id) => document.getElementById(id);
  const ask = (op, payload) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op, payload });
  const errText = (res) => (res && res.error) || 'không rõ';
  function when(ts) {
    const d = new Date(ts);
    if (!ts || Number.isNaN(d.getTime())) return '';
    const hm = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? hm
      : hm + ' ' + d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  }

  const timers = new Map();
  function flash(el, message, tone) {
    el.textContent = message;
    el.dataset.tone = tone || '';
    clearTimeout(timers.get(el));
    if (tone !== 'busy') {
      timers.set(el, setTimeout(() => { el.textContent = ''; el.dataset.tone = ''; }, 5000));
    }
  }

  /* ── personal backup form ── */
  let saved = null;
  let enabledSaved = false;

  function backendValue() {
    const picked = document.querySelector('input[name="backend"]:checked');
    return picked ? picked.value : 'chrome-sync';
  }
  function setBackend(value) {
    document.querySelectorAll('input[name="backend"]').forEach((radio) => { radio.checked = radio.value === value; });
  }
  function formState() {
    return {
      enabled: $('enabled').checked,
      backend: backendValue(),
      endpoint: $('endpoint').value.trim(),
      autoSync: $('auto').checked,
      token: $('token').value !== '',
    };
  }
  const isDirty = () => Boolean(saved) && JSON.stringify(formState()) !== JSON.stringify(saved);

  function syncUi() {
    $('cfg').hidden = !$('enabled').checked;
    $('rest-only').hidden = backendValue() !== 'rest';
    $('test').hidden = !$('enabled').checked;
    $('dirty').hidden = !isDirty();
  }

  function renderSyncStatus(status) {
    const state = !enabledSaved ? 'off' : (status && status.state) || 'never-synced';
    const labels = { off: 'Đang tắt', ok: 'Đã sao lưu', syncing: 'Đang sao lưu…', error: 'Sao lưu lỗi', 'never-synced': 'Chưa sao lưu' };
    $('sync-badge').dataset.state = state;
    $('sync-state').textContent = labels[state] || state;
    const meta = $('sync-meta');
    meta.textContent = '';
    if (state === 'off') return;
    const add = (text, cls) => {
      const span = document.createElement('span');
      span.textContent = text;
      if (cls) span.className = cls;
      meta.appendChild(span);
    };
    if (status && status.lastSyncAt) add('Lần cuối: ' + when(status.lastSyncAt));
    if (status && Number.isFinite(Number(status.recordCount)) && status.recordCount !== null) add(String(status.recordCount) + ' mã trong bản sao lưu');
    if (state === 'error' && status && status.error) add(status.error, 'err');
  }

  async function load() {
    const settings = (await ask('getSettings')) || {};
    $('enabled').checked = settings.enabled === true;
    setBackend(settings.backend || 'chrome-sync');
    $('endpoint').value = settings.endpoint || '';
    $('auto').checked = settings.autoSync === true;
    $('token').value = '';
    /* hasToken is a boolean flag; the token itself never leaves the worker. */
    $('token').placeholder = settings.hasToken ? 'Đã lưu token — nhập để thay' : 'Để trống nếu endpoint không cần xác thực';
    enabledSaved = settings.enabled === true;
    saved = formState();
    syncUi();
    renderSyncStatus(await ask('status'));
  }

  function validEndpoint(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch (_) { return false; }
  }

  async function save() {
    const form = formState();
    if (form.enabled && form.backend === 'rest' && !validEndpoint(form.endpoint)) {
      flash($('status'), 'Endpoint phải là địa chỉ http(s) đầy đủ.', 'err');
      $('endpoint').focus();
      return false;
    }
    const payload = { enabled: form.enabled, backend: form.backend, endpoint: form.endpoint, autoSync: form.autoSync };
    const token = $('token').value;
    if (token) payload.token = token;
    const res = await ask('setSettings', payload);
    $('token').value = '';
    if (!res || !res.ok) {
      flash($('status'), 'Không lưu được: ' + errText(res), 'err');
      return false;
    }
    flash($('status'), 'Đã lưu.', 'ok');
    await load();
    return true;
  }

  ['enabled', 'auto', 'endpoint', 'token'].forEach((id) => {
    $(id).addEventListener('input', syncUi);
    $(id).addEventListener('change', syncUi);
  });
  document.querySelectorAll('input[name="backend"]').forEach((radio) => radio.addEventListener('change', syncUi));

  $('save').addEventListener('click', async () => {
    $('save').disabled = true;
    try { await save(); } finally { $('save').disabled = false; }
  });

  /* The worker tests the STORED settings, so unsaved edits are saved first —
   * otherwise "test" would silently check the previous configuration. */
  $('test').addEventListener('click', async () => {
    const btn = $('test');
    btn.disabled = true;
    try {
      if (isDirty() && !(await save())) return;
      flash($('status'), 'Đang kiểm tra…', 'busy');
      const res = await ask('test');
      flash($('status'), res && res.ok ? 'Kết nối tốt, đã đồng bộ.' : 'Thất bại: ' + errText(res), res && res.ok ? 'ok' : 'err');
      renderSyncStatus(res && res.status ? res.status : { state: 'error', error: errText(res) });
    } finally {
      syncUi();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATUS_KEY]) renderSyncStatus(changes[STATUS_KEY].newValue);
  });
  window.addEventListener('beforeunload', (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  /* ── local vault ── */
  let vaultPromise = null;
  function openVault() {
    if (!vaultPromise) {
      const v = new root.DFRedeemVault.Vault({ adapter: new root.DFRedeemVault.IndexedDBAdapter() });
      vaultPromise = v.init().then(() => v);
      vaultPromise.catch(() => { vaultPromise = null; });
    }
    return vaultPromise;
  }

  async function loadStats() {
    try {
      const all = await (await openVault()).all();
      const gifts = all.filter((r) => r.kind !== 'preset');
      $('st-gift').textContent = gifts.length;
      $('st-preset').textContent = all.length - gifts.length;
      $('st-untried').textContent = gifts.filter((r) => r.status === 'untried').length;
      $('st-share').textContent = gifts.filter((r) => r.status === 'success' || r.status === 'mine').length;
    } catch (e) {
      flash($('status2'), 'Không đọc được kho: ' + (e && e.message || e), 'err');
    }
  }

  function download(text, name, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  /* Local calendar date: an evening export in UTC+7 must not be named after
   * the previous day. */
  const stamp = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };

  async function exportAs(btn, kind) {
    btn.disabled = true;
    try {
      const v = await openVault();
      const count = (await v.all()).length;
      if (kind === 'json') download(await v.exportJSON(), 'df-redeem-kho-' + stamp() + '.json', 'application/json');
      else download(await v.exportCSV(), 'df-redeem-kho-' + stamp() + '.csv', 'text/csv;charset=utf-8');
      flash($('status2'), 'Đã xuất ' + count + ' mã.', 'ok');
    } catch (e) {
      flash($('status2'), 'Không xuất được: ' + (e && e.message || e), 'err');
    } finally {
      btn.disabled = false;
    }
  }
  $('export').addEventListener('click', () => exportAs($('export'), 'json'));
  $('export-csv').addEventListener('click', () => exportAs($('export-csv'), 'csv'));

  /* ── danger zone ── */
  $('wipe').addEventListener('click', async () => {
    const lines = [
      'Xoá bản sao lưu trên Chrome Sync và cài đặt sao lưu (kể cả token)?',
      '',
      'Kho mã trên máy này KHÔNG bị xoá. Dữ liệu trên REST endpoint (nếu có) cũng không bị xoá.',
    ];
    if (!confirm(lines.join(String.fromCharCode(10)))) return;
    const res = await ask('wipe');
    flash($('status3'), res && res.ok ? 'Đã xoá bản sao lưu và cài đặt.' : 'Không xoá được: ' + errText(res), res && res.ok ? 'ok' : 'err');
    await load();
  });

  /* ── section nav: mark the section in view ──
   * The last section is short, so at the bottom of the page it never reaches
   * the reading line; the bottom of the page therefore always selects it. */
  const links = Array.from(document.querySelectorAll('.toc a'));
  const sections = Array.from(document.querySelectorAll('.block'));
  function spy() {
    const line = window.innerHeight * 0.3;
    const page = document.documentElement.scrollHeight;
    const atBottom = page > window.innerHeight + 2 && window.scrollY + window.innerHeight >= page - 2;
    let current = sections[0];
    sections.forEach((section) => { if (section.getBoundingClientRect().top <= line) current = section; });
    if (atBottom) current = sections[sections.length - 1];
    links.forEach((a) => a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + current.id)));
  }
  let spyFrame = 0;
  window.addEventListener('scroll', () => {
    if (!spyFrame) spyFrame = requestAnimationFrame(() => { spyFrame = 0; spy(); });
  }, { passive: true });
  window.addEventListener('hashchange', spy);
  window.addEventListener('resize', spy);
  spy();

  /* Sections change height once settings and stats arrive; re-mark then. */
  Promise.allSettled([load(), loadStats()]).then(spy);
}());
