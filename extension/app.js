/* Delta Force Auto Redeem v3.3.7
 * Built v3.3.7 — local build, no remote source
 *
 * Verifies every redeem against the network response body, never the popup.
 * No telemetry, no remote code, no credential access. Runs only on
 * redeem.df.garena.sg pages you already opened and logged into.
 */
/* app.js — full-page surface. Reuses createPanel's view renderers by mounting
 * the drawer shell inside this page and borrowing its rendered markup, so the
 * two surfaces can never drift apart. */
(function dfRedeemApp() {
  'use strict';
  const root = window;
/* schema.js — IndexedDB schema, record normalization, and migrations. */
var DFRedeemSchema = (function dfRedeemSchemaModule(root) {
  'use strict';

  const DB_NAME = 'df-redeem-vault';
  const DB_VERSION = 6;
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
    /* Gunsmith codes have one case-insensitive identity (as HQ and costs do).
     * Gift spelling must remain untouched: Garena redemption is case-sensitive. */
    return kind === 'preset' ? clean.toUpperCase() : clean;
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
      ...(text(row.label).trim() ? { label: text(row.label).trim() } : {}),
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
     * `mine` bucket into `mine` + `group_limit`.
     * v6 retires every pre-identity build: opening at v6 closes their
     * connections and their next open fails, so an old tab can no longer
     * write a lowercase preset beside the canonical one. */
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
    /* Backups contain code and detail halves for the same preset. Join them
     * before duplicate checks; the code half must not suppress its details. */
    const details = new Map((Array.isArray(data.presets) ? data.presets : [])
      .map((row) => [Schema.normalizeCode(row.code, 'preset'), row]));
    const records = (Array.isArray(data.codes) ? data.codes : []).map((row) => {
      if (row.kind !== 'preset') return row;
      const identity = Schema.normalizeCode(row.code, 'preset');
      const extra = details.get(identity);
      details.delete(identity);
      return { ...row, ...extra, kind: 'preset' };
    });
    return [...records, ...[...details.values()].map((row) => ({ ...row, kind: 'preset' }))];
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

  /* Redemption history is one observation: status, timestamps, counters and the
   * Garena reply must come from the same row, never spliced across variants. */
  const HISTORY_FIELDS = ['status', 'last_tried', 'attempt_count', 'result_msg', 'err_code', 'variant_used', 'shareable'];
  const isEmpty = (value) => value == null || value === '' || (Array.isArray(value) && !value.length);
  const isPresetInput = (raw) => Boolean(raw && (raw.kind === 'preset' || raw.weapon || raw.mode || raw.format));
  const BACKUP_KEY = 'preset_identity_backup_v1';

  /* Repair only preset identities. Archive every original row before merging,
   * and list each conflicting value with its source spelling, so no user data
   * is silently discarded. The visible row stays coherent: history comes whole
   * from the variant with the most evidence, cost travels with its agreement
   * state, and only fields absent from the preferred row are filled in.
   * This runs on every open (not once behind a marker) so a row written by an
   * older build is folded back in on the next start. */
  function presetRepairPlan(codes, presets, meta, now) {
    const codeRows = codes.filter((row) => row.kind === 'preset');
    const groups = new Map();
    for (const [store, rows] of [[STORES.codes, codeRows], [STORES.presets, presets]]) {
      for (const row of rows) {
        const id = Schema.normalizeCode(row.code, 'preset');
        if (!Schema.inferPresetFormat(id)) continue;
        if (!groups.has(id)) groups.set(id, { codes: [], presets: [] });
        groups.get(id)[store].push(row);
      }
    }
    const affected = [...groups.entries()].filter(([id, g]) =>
      g.codes.length !== 1 || g.presets.length !== 1 ||
      g.codes.some((r) => r.code !== id || r.key !== `preset:${id}`) ||
      g.presets.some((r) => r.code !== id));
    if (!affected.length) return [];

    const canonicalFirst = (id) => (a, b) => Number(b.code === id) - Number(a.code === id);
    const filled = (row) => Object.values(row).filter((value) => !isEmpty(value)).length;
    /* Fill only fields the preferred row lacks. Cost and its agreement state are
     * one fact, so they are taken together from the first row that has a cost. */
    const fill = (ordered, skip) => {
      const out = {};
      for (const row of ordered) {
        for (const [key, value] of Object.entries(row)) {
          if (skip.includes(key)) continue;
          if (isEmpty(out[key])) out[key] = clone(value);
        }
      }
      return out;
    };
    const evidence = (row) => [
      Number(row.attempt_count) || 0,
      row.status && row.status !== 'untried' ? 1 : 0,
      String(row.last_tried || ''),
    ];
    const moreEvidence = (id) => (a, b) => {
      const x = evidence(a);
      const y = evidence(b);
      for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? 1 : -1;
      return canonicalFirst(id)(a, b);
    };
    const conflictsOf = (id, group) => {
      const out = [];
      const fields = new Set();
      for (const row of [...group.codes, ...group.presets]) Object.keys(row).forEach((key) => fields.add(key));
      for (const field of fields) {
        if (['key', 'code', 'first_seen', 'tags', 'format'].includes(field)) continue;
        const values = [];
        for (const [store, rows] of [[STORES.codes, group.codes], [STORES.presets, group.presets]]) {
          for (const row of rows) {
            if (!isEmpty(row[field])) values.push({ store, code: row.code, value: clone(row[field]) });
          }
        }
        if (new Set(values.map((v) => JSON.stringify(v.value))).size > 1) out.push({ id, field, values });
      }
      return out;
    };

    const changes = [];
    const conflicts = [];
    for (const [id, group] of affected) {
      for (const r of group.codes) changes.push({ store: STORES.codes, deleteKey: r.key });
      for (const r of group.presets) changes.push({ store: STORES.presets, deleteKey: r.code });
      conflicts.push(...conflictsOf(id, group));

      const detailRows = [...group.presets].sort((a, b) => canonicalFirst(id)(a, b) || filled(b) - filled(a));
      const details = fill(detailRows, ['cost', 'cost_state', 'verified']);
      const priced = detailRows.find((row) => Number(row.cost) > 0);
      if (priced) { details.cost = priced.cost; details.cost_state = priced.cost_state; }
      details.verified = detailRows.some((row) => row.verified === true);

      const historyRows = [...group.codes].sort(moreEvidence(id));
      const info = fill(historyRows, [...HISTORY_FIELDS, 'tags']);
      if (historyRows.length) for (const field of HISTORY_FIELDS) info[field] = clone(historyRows[0][field]);
      info.tags = Schema.normalizeTags([].concat(...group.codes.map((row) => row.tags || [])));

      const first = [...group.codes, ...group.presets].map((r) => r.first_seen).filter(Boolean).sort()[0];
      const preset = Schema.presetRecord({ ...info, ...details, code: id, first_seen: first }, now);
      const code = Schema.codeRecord({ ...info, code: id, kind: 'preset',
        item_hint: info.item_hint || preset.weapon, first_seen: first }, now);
      changes.push({ store: STORES.presets, value: preset }, { store: STORES.codes, value: code });
    }

    /* Append to the archive: a later repair (for a row written by an older
     * build) must never overwrite what an earlier repair preserved. */
    const ids = new Set(affected.map(([id]) => id));
    const prior = meta.find((row) => row.key === BACKUP_KEY) || {};
    const merge = (left, right) => {
      const known = new Set();
      return [...(left || []), ...right].filter((row) => {
        const key = JSON.stringify(row);
        if (known.has(key)) return false;
        known.add(key);
        return true;
      });
    };
    const archived = (rows) => rows.filter((row) => ids.has(Schema.normalizeCode(row.code, 'preset')));
    changes.unshift({ store: STORES.meta, value: {
      key: BACKUP_KEY,
      codes: merge(prior.codes, archived(codeRows)),
      presets: merge(prior.presets, archived(presets)),
      conflicts: merge(prior.conflicts, conflicts.map((c) => ({ ...c, saved_at: now }))),
      saved_at: prior.saved_at || now,
      updated_at: now,
    } });
    changes.push({ store: STORES.meta, value: { key: 'preset_identity_v1', repaired: affected.length, migrated_at: now } });
    return changes;
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

    /* Keep both preset halves and the existence check in one transaction:
     * two tabs importing the same code must not both claim a new insert. */
    async writePreset(code, update) {
      await this.open();
      const tx = this.db.transaction([STORES.codes, STORES.presets], 'readwrite');
      const done = transactionPromise(tx);
      let result;
      let failure;
      const a = tx.objectStore(STORES.codes).get(`preset:${code}`);
      const b = tx.objectStore(STORES.presets).get(code);
      let pending = 2;
      const ready = () => {
        if (--pending) return;
        try {
          const next = update(a.result, b.result);
          result = next.result;
          if (next.code) tx.objectStore(STORES.codes).put(clone(next.code));
          if (next.preset) tx.objectStore(STORES.presets).put(clone(next.preset));
        } catch (error) { failure = error; tx.abort(); }
      };
      a.onsuccess = ready;
      b.onsuccess = ready;
      await done.catch((error) => { throw failure || error; });
      return result;
    }

    async repairPresetIdentities(now) {
      await this.open();
      const tx = this.db.transaction([STORES.codes, STORES.presets, STORES.meta], 'readwrite');
      const done = transactionPromise(tx);
      const names = [STORES.codes, STORES.presets, STORES.meta];
      const requests = names.map((name) => tx.objectStore(name).getAll());
      let pending = requests.length;
      let failure;
      for (const request of requests) request.onsuccess = () => {
        if (--pending) return;
        try {
          const changes = presetRepairPlan(...requests.map((r) => r.result), now);
          for (const change of changes) {
            const store = tx.objectStore(change.store);
            if ('deleteKey' in change) store.delete(change.deleteKey);
            else store.put(clone(change.value));
          }
        } catch (error) { failure = error; tx.abort(); }
      };
      await done.catch((error) => { throw failure || error; });
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
    async writePreset(code, update) {
      // No await between read and write: mirror one IndexedDB transaction.
      const next = update(clone(this.stores.get(STORES.codes).get(`preset:${code}`)),
        clone(this.stores.get(STORES.presets).get(code)));
      if (next.code) this.stores.get(STORES.codes).set(next.code.key, clone(next.code));
      if (next.preset) this.stores.get(STORES.presets).set(next.preset.code, clone(next.preset));
      return next.result;
    }
    async repairPresetIdentities(now) {
      const rows = [STORES.codes, STORES.presets, STORES.meta]
        .map((name) => [...this.stores.get(name).values()].map(clone));
      const changes = presetRepairPlan(...rows, now);
      for (const change of changes) {
        const store = this.stores.get(change.store);
        if ('deleteKey' in change) store.delete(change.deleteKey);
        else store.set(this.key(change.store, change.value), clone(change.value));
      }
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
      await this.adapter.repairPresetIdentities(this.clock());
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
      if (marker && Number(marker.value) >= target) {
        /* A preset-only addition must not replay gift verdict migrations or
         * overwrite a player's build metadata and measured prices. Backfill
         * only identities absent from both stores; repeat opens are no-ops. */
        const known = new Set((await this.adapter.getAll(STORES.codes))
          .filter((row) => row.kind === 'preset').map((row) => row.code));
        for (const row of await this.adapter.getAll(STORES.presets)) known.add(row.code);
        const missing = [];
        for (const row of seed.presets || []) {
          const code = Schema.normalizeCode(row.code, 'preset');
          if (known.has(code)) continue;
          known.add(code);
          missing.push({ ...row, kind: 'preset' });
        }
        if (!missing.length) return { imported: 0, skipped: true };
        return this.importRecords(missing);
      }
      const result = await this.importJSON(seed);
      await this.adapter.put(STORES.meta, { key: 'seed_version', value: target, imported_at: this.clock() });
      return result;
    }

    async upsert(raw, options) {
      const now = this.clock();
      const kind = isPresetInput(raw) ? 'preset' : 'giftcode';
      if (kind === 'preset') {
        const identity = Schema.normalizeCode(raw.code, 'preset');
        return this.adapter.writePreset(identity, (existing, details) => {
          if (options && options.insertOnly && (existing || details)) {
            return { result: { record: existing || details, inserted: false, skipped: true } };
          }
          const first = (existing && existing.first_seen) || (details && details.first_seen) || raw.first_seen;
          const preset = Schema.presetRecord({ ...details, ...raw, kind, first_seen: first }, now);
          const code = Schema.codeRecord({ ...existing, ...raw, code: preset.code, kind: 'preset',
            item_hint: raw.item_hint || preset.weapon, first_seen: first }, now);
          return { code, preset, result: { record: code, inserted: !existing && !details } };
        });
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
      /* All or nothing: validate every row before the first write, so one bad
       * line in a CSV or backup cannot leave the earlier lines half-imported. */
      const rows = Array.isArray(records) ? records : [];
      const errors = [];
      rows.forEach((record, index) => {
        try {
          if (!record || typeof record !== 'object') throw new TypeError('Row is not an object');
          if (isPresetInput(record)) Schema.presetRecord({ ...record, kind: 'preset' }, this.clock());
          else Schema.codeRecord({ ...record, kind: 'giftcode' }, this.clock());
        } catch (error) {
          errors.push(`#${index + 1}: ${String((error && error.message) || error)}`);
        }
      });
      if (errors.length) {
        const error = new TypeError(`Import rejected, nothing was saved (${errors.length} invalid row(s)): ${errors.slice(0, 3).join('; ')}`);
        error.invalidRows = errors;
        throw error;
      }
      let imported = 0;
      let updated = 0;
      let skipped = 0;
      for (const record of rows) {
        // Imports add new presets; editing an existing build is explicit upsert.
        const result = await this.upsert(record, isPresetInput(record) ? { insertOnly: true } : undefined);
        if (result.skipped) skipped += 1;
        else if (result.inserted) imported += 1;
        else updated += 1;
      }
      return { imported, updated, skipped, total: rows.length };
    }

    async importPaste(text, options) {
      const existing = await this.adapter.getAll(STORES.codes);
      const parsed = parsePaste(text, { ...(options || {}), knownCodes: existing.filter((row) => row.kind === 'giftcode') });
      const result = await this.importRecords([...parsed.codes, ...parsed.presets.map((row) => ({ ...row, kind: 'preset' }))]);
      return { ...result, invalid: parsed.invalid, blocks: parsed.blocks };
    }
    async importCSV(text) { return this.importRecords(parseCSV(text)); }
    async importJSON(value) {
      const data = typeof value === 'string' ? JSON.parse(value) : value;
      const result = await this.importRecords(parseJSON(data));
      /* A backup carries the repair archive too; append it so restoring on a
       * new machine keeps every merged-away variant recoverable. */
      const archive = data && !Array.isArray(data) && data.preset_archive;
      if (archive && typeof archive === 'object') {
        const prior = (await this.adapter.get(STORES.meta, BACKUP_KEY)) || {};
        const merge = (left, right) => {
          const known = new Set();
          return [...(left || []), ...(Array.isArray(right) ? right : [])].filter((row) => {
            const key = JSON.stringify(row);
            if (known.has(key)) return false;
            known.add(key);
            return true;
          });
        };
        await this.adapter.put(STORES.meta, {
          key: BACKUP_KEY,
          codes: merge(prior.codes, archive.codes),
          presets: merge(prior.presets, archive.presets),
          conflicts: merge(prior.conflicts, archive.conflicts),
          saved_at: prior.saved_at || archive.saved_at || this.clock(),
          updated_at: this.clock(),
        });
      }
      return result;
    }

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
          ...(extra.label ? { label: extra.label } : {}),
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
      const columns = ['code', 'kind', 'status', 'family', 'group', 'source', 'item_hint', 'first_seen', 'last_tried', 'attempt_count', 'result_msg', 'err_code', 'variant_used', 'shareable', 'notes', 'tags', 'weapon', 'mode', 'label', 'author', 'format', 'verified', 'cost', 'cost_state'];
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
        ...(await this.presetArchive()),
      }, null, 2);
    }
    /* Rows merged away by the identity repair, kept so a backup can recover them. */
    async presetArchive() {
      const backup = await this.adapter.get(STORES.meta, BACKUP_KEY);
      if (!backup) return {};
      return { preset_archive: {
        codes: (backup.codes || []).map(Schema.publicRecord),
        presets: (backup.presets || []).map(Schema.publicRecord),
        conflicts: backup.conflicts || [],
        saved_at: backup.saved_at || '',
      } };
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

const DF_REDEEM_SEED = {"version":2,"generated_at":"2026-09-25T15:15:00.000Z","note":"Seed data: 304 gift-code results and 56 weapon presets; user-submitted presets remain unverified until reviewed.","codes":[{"code":"DF1314754","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAMMO08","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFASCEND72","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFBrilliant165","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ANIMALCUPGUN","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ANIMALCUPTANK","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFANIMALCUP","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAIM666","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DF425BountyS2","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DF425SOL","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DF51login51login","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFADVN74","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFakaonikou","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAMMX96","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFanchor945","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAPEX835","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFARMX46","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFATLA73","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAWAKEN56","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFAXIOM33","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFBAEXP67","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFbeacon030","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFBLKT42","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCARRAT52","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCatalyst87","kind":"giftcode","status":"invalid","source":"file+ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFceleste516","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCL503","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFclarity152","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFclover812","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCONCORD82","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCRAFT427","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFDragon504","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFDRAGONBOAT","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFELEVATE16","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFEMBARK63","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFEnergy428","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFessence982","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFeternity717","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFExcellent659","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFExceptional305","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFFantasy742","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFFILE274","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFFlash260","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFForever395","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGalaxy250","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGENESIS05","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGiveMeBrick425","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFGKTK34","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFGOGOGO425","kind":"giftcode","status":"gift_bug","source":"file+ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFharbor738","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHeroic668","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHOLIDAY421","kind":"giftcode","status":"mine","source":"file","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHorizon503","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHORIZON91","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFHUNTER666","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFINSIGHT48","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFISTARRY939","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFjubilee594","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFLuckylucky425","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFLUISHERE","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFLUVUU282","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFMagic057","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFmoment479","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFmomentum423","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFNinja874","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFoasis407","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOutstanding056","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFPACK293","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFPARAGON41","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFpromise643","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRainbow356","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFReliable732","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRemarkable103","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRESOLVE19","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRL1017","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRocket825","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFserene218","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSH428","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSIXMAJOR6","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFSIXVIP888","kind":"giftcode","status":"expired","source":"file+ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFsolace241","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSpark119","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFsymphony104","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFTRNG469","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFTURING09","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUltra220","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUZI777","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUZIRAT47","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFVANGUARD76","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFVICTORY11","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFvivid061","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFvoyage901","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFVS3S7FR4","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVS8T9SZ4","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSE4K7G1","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSH5N4C7","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSU2X6M8","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFVSW1C5D9","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFWEAPON91","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWEEK237","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWIN777","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFWITNESS77","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWizard309","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFWPNX36","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCC0001","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCEIEI01","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCHAHA5","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCOPGIST88","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPNOW111","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPPL4Y3R5","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPTOBE03","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFCCOPWINEIEI","kind":"giftcode","status":"gift_bug","source":"ocr","err_code":400073,"result_msg":"current cdkey present error","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFCCOPWOR1D","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS2ZK8VA","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS3FZ9LK","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS3Y8KLM","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS4XJ8PL","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS7K2M9Q","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS7Q2VXA","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS9R2HXC","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSB4N9RD","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSB6T3WZ","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSL5Q7MN","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSW4D1YP","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260403B21","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260403B33","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260403B81","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260404B47","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260404B57","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260404B63","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260405B36","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260405B58","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOSS260405B69","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRIDEORDIE4078","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFRIDEORDIE5215","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL1629","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL1983","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL2793","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL3145","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL4412","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL4791","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL5029","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL7183","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL7789","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL8019","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFSL9108","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTARMAMENT","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTGEARTICKET","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTINTERMEDIATE","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C32","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C41","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C54","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C68","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C85","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2103C90","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C28","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C43","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C61","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C77","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C86","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26PL2203C95","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTSCARH","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTSUPPYPACK","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTWEAPON","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUT2025FINALS1549","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF1276","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF2509","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF4827","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF5732","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF5910","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF8051","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUT2025PLAYOFF9163","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTS26GR0103C35","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0103C49","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0103C81","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0703C34","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR0703C96","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1203C46","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1203C72","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1203C83","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1303C39","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1303C65","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1303C98","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1403C24","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1403C52","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1403C87","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1503C33","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1503C74","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR1503C91","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2702C44","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2702C57","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2702C92","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2802C23","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2802C66","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26GR2802C78","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL1","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL3001C47","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL3101C38","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTS26QL3101C64","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL5","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTS26QL6","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"DFUTW260412S36","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTW260412S95","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTW260412S99","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ200838","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ200880","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ200889","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ210810","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ210833","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ210862","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ220811","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ220831","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ220857","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ230872","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ230879","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFUTWQ230897","kind":"giftcode","status":"success","source":"file","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"GARENADFCBT2503C3F4","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFCBT2503X9D1","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFCBT2503Z6T9","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFID2501L983","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFID2501R572","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFID2501V621","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFNY2501E034","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GARENADFNY2501H258","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"HEDELTAFORCE3630","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE4583","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE7563","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE8032","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE8781","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"HEDELTAFORCE9026","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT02","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT04","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT45","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT48","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT55","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT60","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT65","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT68","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT79","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"MOILOOT92","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S19","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S51","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S52","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S53","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S59","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3005S99","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S31","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S64","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S73","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S90","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S95","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"POC3105S96","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S11","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S72","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S79","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260418S84","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S21","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S65","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S67","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"PWC260419S84","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ReturningWarrior1","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ReturningWarrior2","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ReturningWarrior3","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TRILLIONRAID1000","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TRILLIONRAID300","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TRILLIONRAID600","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienboba2719","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienboba6167","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienboba6228","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienmobile3325","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienmobile7095","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"daichienmobile7362","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"10KSUBSYOUTUBEDFRTNK","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"A5Z1NDW8K3PJLU","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"ACESIXMAJOR","kind":"giftcode","status":"expired","source":"file+ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"C7S2X9J5D4B1V3Q","kind":"giftcode","status":"exhausted","source":"ocr","err_code":400068,"result_msg":"The current cdkey has reached the redemption limit","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"GADFZebra","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"LAISEGAME","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"MOBILE0123","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SIXMAJORMVP","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SOLDFWIN360","kind":"giftcode","status":"expired","source":"file+ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SOLPROMAJOR","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"Top1BXHVN","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"TrickOrTreat","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"VIP666SOLDF","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"VIP777SIXDF","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"WELCOMETODF","kind":"giftcode","status":"mine","source":"file","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"85ewN4xYbJfncPKbADR","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"aCuQjtxY7vXGjxCTBnQU","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"Bd52XmxyYj2DFGCqnq4","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"f2X6e3xY3pJDCE5rT7P","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"fvzeLrxYajwVviFSTSZ","kind":"giftcode","status":"mine","source":"file+ocr","err_code":400067,"result_msg":"The current user has reached the redemption limit of cdkey group","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"hjRtrKxYLmcTyYcEy64H","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"JGHMCmxYa6PLcFgvD9mg","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"L34m5GxYjnPkXzckgdEB","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"msz7hMxxYyGhip8ay7HpK","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"N4SQWgxYcHw7gUci3bJy","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"SsCkDfxY5AkdZqjJLkXq","kind":"giftcode","status":"invalid","source":"ocr","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"SVBesCxYcsAN6LCD47P","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"XufJgVxYrFCtM5heBT3B","kind":"giftcode","status":"expired","source":"ocr","err_code":400070,"result_msg":"Mã lỗi chưa biết 400070: The end time has passed","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":false,"tags":[],"notes":""},{"code":"yWHtfsxYGRPaZvAfLN82","kind":"giftcode","status":"success","source":"file+ocr","err_code":0,"result_msg":"ok","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T15:15:00.000Z","attempt_count":1,"shareable":true,"tags":[],"notes":""},{"code":"DFOS7KZM90","kind":"giftcode","status":"invalid","source":"file:block2","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T10:05:00.000Z","attempt_count":1,"shareable":false,"tags":["da-kiem-tra","ocr-sai"],"notes":"Kiem tra 2026-09-25 tren cdkgarena.html: 400054 cho ca ma goc va 3-4 bien the OCR. Khong phai het han - ma khong ton tai."},{"code":"DFOSS260404857","kind":"giftcode","status":"invalid","source":"file:block2","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T10:05:00.000Z","attempt_count":1,"shareable":false,"tags":["da-kiem-tra","ocr-sai"],"notes":"Kiem tra 2026-09-25 tren cdkgarena.html: 400054 cho ca ma goc va 3-4 bien the OCR. Khong phai het han - ma khong ton tai."},{"code":"FVZELRXYAJVWVFSTS2","kind":"giftcode","status":"invalid","source":"file:block2","err_code":400054,"result_msg":"The current cdk does not match","first_seen":"2026-09-25T15:15:00.000Z","last_tried":"2026-09-25T10:05:00.000Z","attempt_count":1,"shareable":false,"tags":["da-kiem-tra","ocr-sai"],"notes":"Kiem tra 2026-09-25 tren cdkgarena.html: 400054 cho ca ma goc va 3-4 bien the OCR. Khong phai het han - ma khong ton tai."}],"presets":[{"code":"6KFJKLO07BHIFPGO0COS7","weapon":"AUG Assault Rifle","mode":"Chiến Trường Toàn Diện","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KP9FT00823TFSU27R1IR","weapon":"K416 Assault Rifle","mode":"Warfare","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6L8UK300A8JTQS5OHR522","weapon":"Thompson Submachine Gun (Tay Đen)","mode":"Chiến Dịch (Thoát Hiểm)","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt; source label confirmed by Vietnam community post indexed 2026-09-28","first_seen":"2026-09-25T15:15:00.000Z","notes":"Nhãn Tay Đen là build Thompson; mã chia sẻ base32-21 hiện hành."},{"code":"6LCTUP00AHP1JR9CHG3OI","weapon":"MK4 Submachine Gun","mode":"Chiến Dịch (Thoát Hiểm)","author":"NHẠC NGUYỄN","format":"base32-21","verified":true,"cost":295426,"cost_state":"unconfirmed","cost_as_of":"2026-09-21","source":"user-submitted screenshot 2026-09-28","first_seen":"2026-09-28T04:32:36.265Z"},{"code":"6KQOCNC0DGSQA4BKR9BOU","weapon":"M14 Marksman Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6K2DPRC0EFTIUBE9ION7O","weapon":"AS Val Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KRR21K07BHHUFGKQS7IG","weapon":"KC17 Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6K8O4000C4GUUFLHNO8FE","weapon":"MK4 Submachine Gun","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KOQD3G01D6SCK9GT7EFU","weapon":"MP5 Submachine Gun","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KNTJ9002BLOGMGFDMK4F","weapon":"MK47 Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KMNU780C122OV360GSH4","weapon":"M14 Marksman Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6JJ7O7807BHLT2L523U7J","weapon":"FS-12 Shotgun","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KL5IJ808VISLV9EEUC8U","weapon":"EasyB AS Val Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KMEQNG00T99PRENQV488","weapon":"AKM Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6K6LG9K09QC5OIM45IHPM","weapon":"M7 Battle Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KH5CPS02JENJFMEC6G27","weapon":"Súng Trường Xạ Thủ SVCH","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"6KHHFEC00T99PRENQV488","weapon":"CI-19 Assault Rifle","mode":"Chiến Dịch Sinh Tồn","author":"user","format":"base32-21","verified":true,"source":"file:giftcode delta force chua loc trung.txt","first_seen":"2026-09-25T15:15:00.000Z"},{"code":"5620492356433216746","weapon":"AKS-74 Assault Rifle","mode":"Havoc Warfare","author":"/u/YareYareDaze88","format":"numeric-19-legacy","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Preset Hop Chiến 2024 đã được Reddit lập chỉ mục đúng theo súng/chế độ; giữ để tra cứu, nhưng ứng dụng hiện tại có thể không còn nhận định dạng mã cũ này."},{"code":"5620492390792957637","weapon":"AKS-74 Assault Rifle","mode":"Havoc Warfare","author":"/u/Upstairs-Pirate-9890","format":"numeric-19-legacy","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Preset Hop Chiến 2024 đã được Reddit lập chỉ mục đúng theo súng/chế độ; giữ để tra cứu, nhưng ứng dụng hiện tại có thể không còn nhận định dạng mã cũ này."},{"code":"5620492382203032302","weapon":"Upstairs-Pirate-9890 AKS-74 Assault Rifle","mode":"Tactical Turmoil","author":"/u/Spezzare","format":"numeric-19-legacy","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Preset Hop Chiến 2024 đã được Reddit lập chỉ mục đúng theo súng/chế độ; giữ để tra cứu, nhưng ứng dụng hiện tại có thể không còn nhận định dạng mã cũ này."},{"code":"5620492343548352708","weapon":"UZI Submachine Gun","mode":"Havoc Warfare","author":"/u/Sluiskampert","format":"numeric-19-legacy","verified":false,"source":"reddit:r/deltaforce/1enm9pp","first_seen":"2026-09-25T15:15:00.000Z","notes":"Preset Hop Chiến 2024 đã được Reddit lập chỉ mục đúng theo súng/chế độ; giữ để tra cứu, nhưng ứng dụng hiện tại có thể không còn nhận định dạng mã cũ này."},{"code":"6LFI0L80AHP1JR9CHG3OI","weapon":"MK4 Submachine Gun","mode":"Chiến Dịch (Thoát Hiểm)","label":"Eco-burst","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFI0PS0AHP1JR9CHG3OI","weapon":"MK4 Submachine Gun","mode":"Chiến Dịch (Thoát Hiểm)","label":"Full-burst","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFI1180AHP1JR9CHG3OI","weapon":"MK4 Submachine Gun","mode":"Chiến Dịch (Thoát Hiểm)","label":"Hipfire-burst","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHVBC0AHP1JR9CHG3OI","weapon":"AKM Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Hipfire","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHTS80AHP1JR9CHG3OI","weapon":"AK-12 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Eco","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHU5S0AHP1JR9CHG3OI","weapon":"AK-12 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Nhạc","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHPSC0AHP1JR9CHG3OI","weapon":"AR-57 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Eco","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHQ9C0AHP1JR9CHG3OI","weapon":"AR-57 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Full","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFI05K0AHP1JR9CHG3OI","weapon":"AS Val Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"NhạcX2","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFI09O0AHP1JR9CHG3OI","weapon":"AS Val Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Nhạcreddot","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHSB40AHP1JR9CHG3OI","weapon":"MK47 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Nhạc","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LETFTC0AHP1JR9CHG3OI","weapon":"AUG Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Eco","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHS2K0AHP1JR9CHG3OI","weapon":"AUG Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Nhạc","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHNH40AHP1JR9CHG3OI","weapon":"CI-19 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Normal","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHP280AHP1JR9CHG3OI","weapon":"CI-19 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Nhạc","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LETEL00AHP1JR9CHG3OI","weapon":"K416 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHT2C0AHP1JR9CHG3OI","weapon":"K437 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Full","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHTCS0AHP1JR9CHG3OI","weapon":"K437 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Eco","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHTHO0AHP1JR9CHG3OI","weapon":"K437 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Nhạc","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHR640AHP1JR9CHG3OI","weapon":"KC17 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Eco","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHRM80AHP1JR9CHG3OI","weapon":"KC17 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Nhạc","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHVM40AHP1JR9CHG3OI","weapon":"M4A1 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Newbie","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHVRK0AHP1JR9CHG3OI","weapon":"M4A1 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Newbie 2","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFHUTO0AHP1JR9CHG3OI","weapon":"M7 Battle Rifle","mode":"Chiến Dịch (Thoát Hiểm)","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFI34G0AHP1JR9CHG3OI","weapon":"QBZ95-1 Assault Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Rac'","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFI2V00AHP1JR9CHG3OI","weapon":"QCQ171 Submachine Gun","mode":"Chiến Dịch (Thoát Hiểm)","label":"Eco","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFI2KS0AHP1JR9CHG3OI","weapon":"M249 Light Machine Gun","mode":"Chiến Dịch (Thoát Hiểm)","label":"Eco","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFI2GK0AHP1JR9CHG3OI","weapon":"QJB201 Light Machine Gun","mode":"Chiến Dịch (Thoát Hiểm)","label":"Eco","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LEUT740AHP1JR9CHG3OI","weapon":"QJB201 Light Machine Gun","mode":"Chiến Dịch (Thoát Hiểm)","label":"Nhạc","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFI1OC0AHP1JR9CHG3OI","weapon":"SVD Sniper Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Eco","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFI21O0AHP1JR9CHG3OI","weapon":"SVD Sniper Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Half-eco","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LFI27O0AHP1JR9CHG3OI","weapon":"SVD Sniper Rifle","mode":"Chiến Dịch (Thoát Hiểm)","label":"Nhạc","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LEJRLG0AHP1JR9CHG3OI","weapon":"M700 Sniper Rifle","mode":"Chiến Dịch (Thoát Hiểm)","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LE92O00AHP1JR9CHG3OI","weapon":"Tay Đen","mode":"Chiến Dịch (Thoát Hiểm)","label":"Eco","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"},{"code":"6LE92MO0AHP1JR9CHG3OI","weapon":"Tay Đen","mode":"Chiến Dịch (Thoát Hiểm)","label":"Nhạc","author":"user","format":"base32-21","verified":false,"source":"user-submitted list 2026-10-04","first_seen":"2026-10-03T21:34:18.834Z"}],"updated_at":"2026-10-03T21:34:18.834Z","changelog":[{"version":2,"date":"2026-09-25","note":"3 ma chua thu (DFOS7KZM90, DFOSS260404857, FVZELRXYAJVWVFSTS2) da kiem tra that: 400054 ca ma goc va bien the OCR -> invalid."},{"version":2,"date":"2026-10-04","note":"Added 35 user-submitted Chiến Dịch (Thoát Hiểm) weapon presets; labels preserved and verification remains false."}]};
const DF_THEME_CSS = "/* theme.css — one design system for every surface: in-page drawer, full-page\n * app, toolbar popup, options. Loaded into a shadow root (drawer) or a real\n * document (page/popup/options), so everything is class-scoped, never :host-only.\n *\n * Direction: \"tactical ops console\". Hairline grids, corner ticks, stencil\n * labels, tabular numerals. Amber is reserved for genuine warnings so status\n * colour always means the same thing across all four surfaces.\n */\n\n.df {\n  /* ── surface ── */\n  --void: #05080a;\n  --bg: #080d10;\n  --panel: #0b1317;\n  --raised: #101b20;\n  --sunken: #04090b;\n  --line: #1c2c33;\n  --line-soft: #142127;\n\n  /* ── ink ── */\n  --ink: #e8f6f2;\n  /* Contrast measured on the live panel against --raised: the old dim/mute pair\n   * sat at ~4.9 and ~3.0. At the 10.5–11.5px used by hints, pills and table\n   * text that is legible only in theory, so both are lifted: dim clears 7:1\n   * (AAA at this size) and mute clears AA instead of failing it outright. */\n  --ink-dim: #b8ccc8;\n  --ink-mute: #8ba39e;\n\n  /* ── signal ── */\n  --primary: #2ee6c8;\n  --primary-dim: #14a693;\n  --primary-glow: rgba(46, 230, 200, .18);\n  --amber: #ffb340;\n  --danger: #ff5f6d;\n  --violet: #a98bfa;\n  --sky: #4fb8f5;\n\n  /* ── status (one source of truth) ── */\n  --s-success: #2ee6c8;\n  --s-mine: #4fb8f5;\n  /* Group cap is adjacent to `mine` (both are \"this account\", not \"dead code\")\n   * but must stay distinguishable at a glance, so it takes the violet-blue\n   * neighbour rather than a second shade of sky. */\n  --s-group_limit: #7aa2f7;\n  --s-untried: #ffb340;\n  /* Garena-side failure: deliberately grey-blue, never red — nothing is wrong\n   * with the code and the row must not read as a dead verdict. */\n  --s-sys_error: #8b9fb0;\n  --s-expired: #6b8480;\n  --s-exhausted: #c89b5a;\n  --s-gift_bug: #a98bfa;\n  --s-invalid: #ff5f6d;\n\n  --r: 3px;\n  --r-lg: 5px;\n  --gap: 14px;\n\n  /* ── type scale ──\n   * The settings surfaces (popup, options) read from these five steps only, so\n   * a heading never ends up one pixel off a body line. The panel keeps its own\n   * denser sizes; it predates the scale and is tuned for a 420px drawer. */\n  --fs-headline: 18px;\n  --fs-title: 14px;\n  --fs-body: 13px;\n  --fs-caption: 11.5px;\n  --fs-label: 10.5px;\n  --mono: ui-monospace, \"SF Mono\", \"Cascadia Mono\", Consolas, monospace;\n  --sans: \"Inter\", system-ui, -apple-system, \"Segoe UI\", sans-serif;\n\n  color: var(--ink);\n  font-family: var(--sans);\n  font-size: 13px;\n  line-height: 1.5;\n  -webkit-font-smoothing: antialiased;\n}\n\n.df *, .df *::before, .df *::after { box-sizing: border-box; }\n/* `hidden` must win over any component display rule. The descendant form alone\n * misses elements that are themselves the `.df` root — the command palette and\n * the toast stack sit directly in the shadow root, so `hidden` silently lost to\n * their own `display: grid` and the palette stayed over the whole page. */\n.df[hidden], .df [hidden] { display: none !important; }\n.df button, .df input, .df select, .df textarea { font: inherit; color: inherit; }\n.df :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }\n.df ::-webkit-scrollbar { width: 10px; height: 10px; }\n.df ::-webkit-scrollbar-track { background: var(--sunken); }\n.df ::-webkit-scrollbar-thumb { background: #1d2f35; border: 2px solid var(--sunken); border-radius: 6px; }\n.df ::-webkit-scrollbar-thumb:hover { background: #2a454d; }\n\n/* ── stencil label ─────────────────────────────────────────────────────── */\n.df .stencil {\n  margin: 0;\n  color: var(--ink-mute);\n  font-size: 9.5px;\n  font-weight: 700;\n  letter-spacing: .16em;\n  text-transform: uppercase;\n}\n\n/* ── corner-ticked slab: the signature shape ───────────────────────────── */\n.df .slab {\n  position: relative;\n  padding: 13px 14px;\n  border: 1px solid var(--line);\n  background:\n    linear-gradient(180deg, rgba(255,255,255,.022), transparent 70px),\n    var(--panel);\n}\n.df .slab::before,\n.df .slab::after {\n  content: \"\";\n  position: absolute;\n  width: 7px; height: 7px;\n  border-color: var(--primary);\n  opacity: .5;\n  pointer-events: none;\n}\n.df .slab::before { top: -1px; left: -1px; border-top: 1px solid; border-left: 1px solid; }\n.df .slab::after { bottom: -1px; right: -1px; border-bottom: 1px solid; border-right: 1px solid; }\n\n/* ── buttons ───────────────────────────────────────────────────────────── */\n.df .btn {\n  display: inline-flex;\n  align-items: center;\n  gap: 7px;\n  padding: 0 13px;\n  height: 32px;\n  border: 1px solid var(--line);\n  border-radius: var(--r);\n  background: var(--raised);\n  color: var(--ink-dim);\n  cursor: pointer;\n  font-size: 12px;\n  font-weight: 600;\n  white-space: nowrap;\n  transition: border-color .12s, color .12s, background .12s;\n}\n.df .btn:hover { border-color: var(--primary-dim); color: var(--ink); background: #14232a; }\n.df .btn:active { transform: translateY(1px); }\n.df .btn[disabled] { opacity: .4; cursor: not-allowed; }\n.df .btn.primary {\n  border-color: transparent;\n  background: linear-gradient(180deg, var(--primary), var(--primary-dim));\n  color: #04120f;\n  font-weight: 700;\n}\n.df .btn.primary:hover { filter: brightness(1.1); background: linear-gradient(180deg, var(--primary), var(--primary-dim)); }\n.df .btn.danger { border-color: #4a2228; color: #ff9aa3; }\n.df .btn.danger:hover { border-color: var(--danger); color: var(--danger); background: #1d1013; }\n.df .btn.sm { height: 26px; padding: 0 9px; font-size: 11px; }\n.df .btn.icon { width: 32px; padding: 0; justify-content: center; font-size: 15px; }\n.df .btn.icon.sm { width: 26px; }\n.df .link {\n  border: 0; padding: 2px 4px; background: none;\n  color: var(--primary); cursor: pointer;\n  font-size: 11.5px; font-weight: 600;\n}\n.df .link:hover { text-decoration: underline; }\n\n/* ── inputs ────────────────────────────────────────────────────────────── */\n.df .input, .df select, .df textarea {\n  width: 100%;\n  padding: 7px 10px;\n  border: 1px solid var(--line);\n  border-radius: var(--r);\n  background: var(--sunken);\n  outline: 0;\n  font-size: 12.5px;\n}\n.df .input:focus, .df select:focus, .df textarea:focus {\n  border-color: var(--primary-dim);\n  box-shadow: 0 0 0 3px var(--primary-glow);\n}\n.df textarea { min-height: 120px; resize: vertical; font-family: var(--mono); font-size: 12px; line-height: 1.6; }\n.df select { cursor: pointer; }\n.df .field { display: grid; gap: 5px; }\n.df .field > .stencil { margin-bottom: 1px; }\n.df .search { position: relative; }\n.df .search .input { padding-left: 30px; }\n.df .search::before {\n  content: \"⌕\";\n  position: absolute; left: 10px; top: 50%;\n  transform: translateY(-50%);\n  color: var(--ink-mute); font-size: 15px;\n}\n\n/* ── KPI ───────────────────────────────────────────────────────────────── */\n.df .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 10px; }\n.df .kpi { position: relative; padding: 12px 13px; border: 1px solid var(--line); background: var(--panel); overflow: hidden; }\n.df .kpi::after {\n  content: \"\"; position: absolute; inset: 0 auto 0 0; width: 2px;\n  background: var(--accent, var(--primary));\n}\n.df .kpi b {\n  display: block;\n  color: var(--accent, var(--primary));\n  font-size: 27px; font-weight: 700; line-height: 1.05;\n  font-variant-numeric: tabular-nums;\n  letter-spacing: -.02em;\n}\n.df .kpi span { display: block; margin-top: 3px; color: var(--ink-mute); font-size: 10.5px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; }\n.df .kpi small { display: block; margin-top: 5px; color: var(--ink-mute); font-size: 10.5px; }\n.df .kpi.ok { --accent: var(--s-success); }\n.df .kpi.share { --accent: var(--sky); }\n.df .kpi.warn { --accent: var(--amber); }\n.df .kpi.preset { --accent: var(--violet); }\n\n/* ── distribution bars ─────────────────────────────────────────────────── */\n.df .bars { display: grid; gap: 7px; }\n.df .bar-row { display: grid; grid-template-columns: 96px 1fr 46px; align-items: center; gap: 10px; }\n.df .bl { color: var(--ink-dim); font-size: 11.5px; }\n.df .bt { height: 7px; border-radius: 2px; background: var(--sunken); overflow: hidden; }\n.df .fill { display: block; height: 100%; background: var(--primary); transition: width .45s cubic-bezier(.2,.8,.3,1); }\n.df .bn { color: var(--ink); font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }\n.df .fill.s-success { background: var(--s-success); }\n.df .fill.s-mine { background: var(--s-mine); }\n.df .fill.s-group_limit { background: var(--s-group_limit); }\n.df .fill.s-untried { background: var(--s-untried); }\n.df .fill.s-sys_error { background: var(--s-sys_error); }\n.df .fill.s-expired { background: var(--s-expired); }\n.df .fill.s-exhausted { background: var(--s-exhausted); }\n.df .fill.s-gift_bug { background: var(--s-gift_bug); }\n.df .fill.s-invalid { background: var(--s-invalid); }\n\n/* The panel emits `<span class=\"dot s-${status}\">` in the library rows and the\n * history timeline, but only `.fill.s-*` was ever styled — so every dot fell\n * through to `--primary` and success, expired and invalid all rendered the same\n * teal. The dot is the only per-row status colour in the timeline, so the whole\n * column was decorative rather than informative. */\n.df .dot.s-success { background: var(--s-success); }\n.df .dot.s-mine { background: var(--s-mine); }\n.df .dot.s-group_limit { background: var(--s-group_limit); }\n.df .dot.s-untried { background: var(--s-untried); }\n.df .dot.s-sys_error { background: var(--s-sys_error); }\n.df .dot.s-expired { background: var(--s-expired); }\n.df .dot.s-exhausted { background: var(--s-exhausted); }\n.df .dot.s-gift_bug { background: var(--s-gift_bug); }\n.df .dot.s-invalid { background: var(--s-invalid); }\n\n/* ── status pill ───────────────────────────────────────────────────────── */\n.df .pill {\n  display: inline-flex; align-items: center; gap: 5px;\n  padding: 2px 8px 2px 6px;\n  border: 1px solid color-mix(in srgb, var(--c, var(--ink-mute)) 40%, transparent);\n  border-radius: 10px;\n  background: color-mix(in srgb, var(--c, var(--ink-mute)) 12%, transparent);\n  color: var(--c, var(--ink-dim));\n  font-size: 10.5px; font-weight: 600; white-space: nowrap;\n}\n.df .pill::before { content: \"\"; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }\n.df .pill.p-success { --c: var(--s-success); }\n.df .pill.p-mine { --c: var(--s-mine); }\n.df .pill.p-group_limit { --c: var(--s-group_limit); }\n.df .pill.p-untried { --c: var(--s-untried); }\n.df .pill.p-sys_error { --c: var(--s-sys_error); }\n.df .pill.p-expired { --c: var(--s-expired); }\n.df .pill.p-exhausted { --c: var(--s-exhausted); }\n.df .pill.p-gift_bug { --c: var(--s-gift_bug); }\n.df .pill.p-invalid { --c: var(--s-invalid); }\n\n/* ── table ─────────────────────────────────────────────────────────────── */\n.df .grid { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; }\n.df .grid th {\n  position: sticky; top: 0; z-index: 2;\n  padding: 8px 10px;\n  border-bottom: 1px solid var(--line);\n  background: var(--bg);\n  color: var(--ink-mute);\n  font-size: 9.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;\n  text-align: left;\n  white-space: nowrap;\n}\n.df .grid td { padding: 7px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }\n.df .grid tbody tr:hover td { background: rgba(46,230,200,.045); }\n.df .grid tbody tr.sel td { background: rgba(79,184,245,.09); }\n.df .grid .num { font-variant-numeric: tabular-nums; text-align: right; }\n.df .grid .note { max-width: 260px; color: var(--ink-dim); font-size: 11.5px; }\n.df .grid .empty { padding: 34px 10px; color: var(--ink-mute); text-align: center; }\n.df .mono { font-family: var(--mono); font-size: 12px; letter-spacing: .02em; }\n.df .row-acts { text-align: right; white-space: nowrap; }\n.df .grid tbody tr .row-acts .link { opacity: 0; transition: opacity .12s; }\n.df .grid tbody tr:hover .row-acts .link, .df .grid tbody tr:focus-within .row-acts .link { opacity: 1; }\n.df .tablewrap { border: 1px solid var(--line); background: var(--panel); overflow: auto; }\n\n/* ── callout ───────────────────────────────────────────────────────────── */\n.df .callout {\n  display: flex; gap: 10px;\n  padding: 11px 13px;\n  border: 1px solid color-mix(in srgb, var(--c, var(--primary)) 30%, transparent);\n  border-left: 2px solid var(--c, var(--primary));\n  background: color-mix(in srgb, var(--c, var(--primary)) 7%, transparent);\n  color: var(--ink-dim);\n  font-size: 12px;\n}\n.df .callout b { color: var(--ink); }\n.df .callout.warn { --c: var(--amber); }\n.df .callout.preset { --c: var(--violet); }\n.df .callout.danger { --c: var(--danger); }\n.df .callout .ico { flex: none; color: var(--c, var(--primary)); font-size: 14px; line-height: 1.3; }\n\n/* ── misc ──────────────────────────────────────────────────────────────── */\n.df .muted { color: var(--ink-mute); font-size: 11.5px; }\n.df .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }\n.df .spacer { flex: 1 1 auto; }\n.df .sec { display: grid; gap: 10px; }\n.df h3.sec-h { margin: 0; color: var(--ink); font-size: 12.5px; font-weight: 700; letter-spacing: .02em; }\n.df h3.sec-h small { margin-left: 6px; color: var(--ink-mute); font-size: 11px; font-weight: 600; }\n.df .divider { height: 1px; background: var(--line-soft); }\n.df .chip {\n  display: inline-flex; align-items: center; gap: 5px;\n  padding: 3px 8px; border: 1px solid var(--line); border-radius: 10px;\n  background: var(--sunken);   /* explicit: a <button>.chip would otherwise keep\n                                * Chrome's pale default and vanish on dark UI */\n  color: var(--ink-dim); font-size: 10.5px; font-weight: 600;\n}\n/* Only the interactive chip gets the 32px floor: a plain .chip is a static\n * label (status legend, meta row) and forcing it taller just adds dead space. */\n.df button.chip { cursor: pointer; min-height: 32px; padding: 3px 11px; font-size: 11.5px; }\n.df button.chip:hover { border-color: var(--primary-dim); color: var(--ink); }\n.df .chip.on { border-color: var(--primary-dim); color: var(--primary); background: var(--primary-glow); }\n\n/* ── progress ──────────────────────────────────────────────────────────── */\n.df .prog { height: 5px; border-radius: 3px; background: var(--sunken); overflow: hidden; }\n.df .prog i { display: block; height: 100%; background: linear-gradient(90deg, var(--primary-dim), var(--primary)); transition: width .3s; }\n.df .live { display: grid; gap: 4px; max-height: 190px; padding: 10px; border: 1px solid var(--line); background: var(--sunken); overflow: auto; font-family: var(--mono); font-size: 11.5px; }\n.df .live div { color: var(--ink-dim); }\n.df .live div.ok { color: var(--s-success); }\n.df .live div.err { color: var(--danger); }\n.df .live div.warn { color: var(--amber); }\n\n/* ── toasts ────────────────────────────────────────────────────────────── */\n.df .toasts { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: grid; gap: 7px; justify-items: end; pointer-events: none; }\n.df .toast {\n  padding: 9px 13px;\n  border: 1px solid var(--line);\n  border-left: 2px solid var(--primary);\n  border-radius: var(--r);\n  background: var(--raised);\n  box-shadow: 0 10px 30px rgba(0,0,0,.55);\n  color: var(--ink);\n  font-size: 12px; font-weight: 500;\n  opacity: 0; transform: translateY(6px);\n  transition: opacity .2s, transform .2s;\n}\n.df .toast.in { opacity: 1; transform: none; }\n.df .toast.ok { border-left-color: var(--s-success); }\n.df .toast.err { border-left-color: var(--danger); }\n.df .toast.warn { border-left-color: var(--amber); }\n\n/* ── skeleton ──────────────────────────────────────────────────────────── */\n.df .skel { border-radius: var(--r); background: linear-gradient(90deg, #0e181c 25%, #16242a 50%, #0e181c 75%); background-size: 200% 100%; animation: df-shim 1.3s infinite; }\n@keyframes df-shim { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }\n\n@media (prefers-reduced-motion: reduce) {\n  .df *, .df *::before, .df *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }\n}\n\n/* Windows high contrast throws away every background-color, so a status dot —\n * which is nothing but a 6px coloured background — disappears entirely, and the\n * row loses its only at-a-glance signal. Forced colours keep borders, so redraw\n * the dot as a ring and vary its shape by status rather than its hue. The pill\n * beside it still carries the words, so this is redundancy, not the only cue. */\n@media (forced-colors: active) {\n  .df .dot {\n    background: transparent !important;\n    border: 2px solid currentColor;\n    width: 9px; height: 9px;\n  }\n  .df .dot.s-success, .df .dot.s-mine { border-radius: 99px; }\n  .df .dot.s-expired, .df .dot.s-exhausted { border-radius: 0; }\n  .df .dot.s-invalid, .df .dot.s-sys_error, .df .dot.s-gift_bug {\n    border-radius: 0; transform: rotate(45deg);\n  }\n  /* A focus ring built from box-shadow also vanishes; force a real outline. */\n  .df :focus-visible { outline: 2px solid currentColor !important; outline-offset: 2px; }\n}\n\n\n/* components.css — the view layer of the design system.\n *\n * theme.css owns tokens and primitives; this file owns every class the view\n * renderers in panel.js actually emit. The two are concatenated at build time\n * into one theme.css, so a class defined here is available on all four\n * surfaces (drawer shadow root, full page, popup, options).\n *\n * Rule of thumb: if panel.js writes a class into markup, it gets a rule here.\n * A class with no rule silently renders with browser defaults, which on this\n * dark theme means an unreadable white-on-white control.\n */\n\n/* ── action buttons (the workhorse; .btn is the formal variant) ─────────── */\n.df .act {\n  display: inline-flex; align-items: center; justify-content: center; gap: 6px;\n  min-height: 30px; padding: 0 12px;\n  border: 1px solid var(--line); border-radius: var(--r);\n  background: var(--raised); color: var(--ink);\n  cursor: pointer; font: 600 11.5px var(--sans); letter-spacing: .01em;\n  transition: border-color .14s, background .14s, color .14s;\n  white-space: nowrap;\n}\n.df .act:hover:not([disabled]) { border-color: var(--primary-dim); background: #16252b; }\n.df .act:active:not([disabled]) { transform: translateY(1px); }\n.df .act[disabled] { opacity: .38; cursor: not-allowed; }\n.df .act.primary { border-color: var(--primary-dim); background: var(--primary); color: #04100e; }\n.df .act.primary:hover:not([disabled]) { background: #4af0d6; border-color: var(--primary); }\n.df .act.danger { border-color: #5c2530; color: var(--danger); }\n.df .act.danger:hover:not([disabled]) { background: #241216; border-color: var(--danger); }\n.df .act.ghost { border-color: transparent; background: transparent; color: var(--ink-dim); }\n.df .act.ghost:hover:not([disabled]) { border-color: var(--line); background: var(--raised); color: var(--ink); }\n.df .act.tiny { min-height: 32px; padding: 0 11px; font-size: 11.5px; }\n.df .btnrow { display: flex; flex-wrap: wrap; gap: 6px; }\n.df .page-acts { display: grid; gap: 6px; }\n\n/* ── cards ─────────────────────────────────────────────────────────────── */\n.df .card {\n  margin-bottom: var(--gap); padding: 13px 14px;\n  border: 1px solid var(--line-soft); border-radius: var(--r-lg);\n  background: var(--panel);\n}\n.df .card-hd {\n  display: flex; align-items: baseline; gap: 9px;\n  margin: -2px 0 11px; padding-bottom: 9px;\n  border-bottom: 1px solid var(--line-soft);\n}\n.df .card-hd h3 {\n  margin: 0; color: var(--ink);\n  font-size: 11px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase;\n}\n.df .card-hd > :last-child { margin-left: auto; }\n.df .card-hd .muted { font-size: 10.5px; }\n.df .two { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }\n.df .tight { margin: -4px 0 10px; font-size: 11px; }\n\n/* ── callouts: one shape, three intents ────────────────────────────────── */\n.df .cta, .df .info-box, .df .warn-box {\n  margin-bottom: var(--gap); padding: 11px 13px;\n  border: 1px solid var(--line); border-left-width: 3px; border-radius: var(--r);\n  background: var(--panel); font-size: 12px;\n}\n.df .cta {\n  display: flex; align-items: center; gap: 11px;\n  border-left-color: var(--primary);\n  background: linear-gradient(90deg, rgba(46,230,200,.07), transparent 60%);\n}\n.df .cta.done { border-left-color: var(--s-mine); background: linear-gradient(90deg, rgba(79,184,245,.07), transparent 60%); }\n.df .cta > div { flex: 1; }\n.df .cta .muted { display: block; margin-top: 2px; font-size: 11px; }\n.df .cta .act { flex: none; }\n.df .info-box { border-left-color: var(--sky); }\n/* Off-page redemption is a hard blocker, not an advisory. Give it a distinct\n * alert silhouette: a high-contrast amber rail, a clear symbol, and one obvious\n * recovery action. This is deliberately stronger than ordinary form warnings\n * because an attempted run otherwise produces false \"dead code\" failures. */\n.df .warn-box { border-left-color: var(--amber); }\n.df .warn-box.run-blocker {\n  display: flex; align-items: flex-start; gap: 11px;\n  padding: 14px 15px 14px 11px;\n  border-color: color-mix(in srgb, var(--amber) 56%, var(--line));\n  border-left: 5px solid var(--amber);\n  background: linear-gradient(100deg, rgba(244,184,65,.15), rgba(244,184,65,.045) 58%, var(--panel));\n  box-shadow: inset 0 1px 0 rgba(255,218,132,.13), 0 7px 24px rgba(0,0,0,.14);\n}\n.df .warn-mark {\n  display: grid; place-items: center; flex: 0 0 23px; height: 23px;\n  border: 1px solid var(--amber); border-radius: 50%; color: #170f02;\n  background: var(--amber); font: 900 15px/1 var(--mono);\n}\n.df .run-blocker > div { min-width: 0; }\n.df .run-blocker b { color: #ffe4a0; font-size: 13px; letter-spacing: .01em; }\n.df .run-blocker p { max-width: 780px; margin-bottom: 10px; color: var(--ink); font-size: 12px; line-height: 1.55; }\n.df .run-blocker .warn-cta { border-color: color-mix(in srgb, var(--amber) 65%, var(--line)); color: #ffe4a0; }\n.df .run-blocker .warn-cta:hover:not([disabled]) { background: rgba(244,184,65,.14); border-color: var(--amber); }\n.df .info-box b, .df .warn-box b { display: block; margin-bottom: 3px; }\n.df .info-box p, .df .warn-box p { margin: 0 0 8px; color: var(--ink-dim); font-size: 11.5px; }\n.df .info-box p:last-child, .df .warn-box p:last-child { margin-bottom: 0; }\n\n/* ── activity feed ─────────────────────────────────────────────────────── */\n.df .feed { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; }\n.df .feed li {\n  display: flex; align-items: center; gap: 9px;\n  padding: 7px 2px; border-bottom: 1px solid var(--line-soft);\n}\n.df .feed li:last-child { border-bottom: 0; }\n.df .feed .mono { flex: 1; font-size: 11.5px; }\n.df .ago { color: var(--ink-mute); font: 500 10.5px var(--mono); white-space: nowrap; }\n\n/* ── empty states ──────────────────────────────────────────────────────── */\n.df .empty { padding: 26px 14px; color: var(--ink-mute); text-align: center; }\n.df .empty .ei { margin-bottom: 7px; color: var(--line); font-size: 26px; line-height: 1; }\n.df .empty p { margin: 0 0 10px; font-size: 12px; }\n.df .empty .act { margin: 0 3px; }\n\n/* ── tables ────────────────────────────────────────────────────────────── */\n.df .tbl-wrap {\n  margin-bottom: 11px; overflow-x: auto;\n  border: 1px solid var(--line-soft); border-radius: var(--r);\n}\n.df .tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }\n.df .tbl th {\n  position: sticky; top: 0; z-index: 1;\n  padding: 7px 9px; border-bottom: 1px solid var(--line);\n  background: var(--sunken); color: var(--ink-mute);\n  font: 800 9.5px var(--sans); letter-spacing: .09em; text-align: left; text-transform: uppercase;\n}\n.df .tbl td { padding: 6px 9px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }\n.df .tbl tr:last-child td { border-bottom: 0; }\n.df .tbl tbody tr:hover { background: #0e181d; }\n.df .tbl .cbx { width: 28px; text-align: center; }\n.df .tbl .rowacts { width: 1%; text-align: right; white-space: nowrap; }\n.df .tbl .rowacts .act { margin-left: 4px; }\n.df .pick, .df .pick-all { accent-color: var(--primary); cursor: pointer; }\n\n/* ── filters ───────────────────────────────────────────────────────────── */\n.df .fq, .df .fstatus, .df .fsort {\n  min-height: 30px; padding: 0 9px;\n  border: 1px solid var(--line); border-radius: var(--r);\n  background: var(--sunken); color: var(--ink); font-size: 11.5px;\n}\n.df .fq:focus, .df .fstatus:focus, .df .fsort:focus { border-color: var(--primary-dim); outline: 0; }\n.df .chiprow { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }\n/* The preset search shares .pq with the command palette input (app.html pairs\n * clones by first class, so it cannot be renamed). Scope it back to the filter\n * look; unscoped it inherited the palette's borderless 44px field. */\n.df .pfilters .pq {\n  min-width: 0; min-height: 30px; padding: 0 9px;\n  border: 1px solid var(--line); border-radius: var(--r);\n  background: var(--sunken); color: var(--ink); font: 400 11.5px var(--sans);\n}\n.df .pfilters .pq:focus { border-color: var(--primary-dim); outline: 0; }\n/* app.html loads theme.css without the drawer's styles.css, so .filters had\n * no grid there and the full-width search pushed both buttons onto a second\n * line. Search and its two actions fit one row at every width we ship. */\n.df .filters.pfilters {\n  display: grid; grid-template-columns: minmax(0, 1fr) auto auto;\n  gap: 7px; align-items: center; margin-bottom: 10px;\n}\n\n/* ── run controls ──────────────────────────────────────────────────────── */\n/* A grid item defaults to min-width:auto, so these refuse to shrink below\n * their max-content width: at 360px the column is 140px wide but the uppercase\n * label measures 179px and spills out of a container that does not clip,\n * printing \"GIÃN CÁCH (MS)\" over its neighbour. min-width:0 lets it wrap. */\n.df .fld { display: grid; gap: 3px; min-width: 0; }\n.df .fld > * { min-width: 0; }\n.df .fld > span {\n  color: var(--ink-mute);\n  font: 700 9.5px var(--sans); letter-spacing: .08em; text-transform: uppercase;\n  overflow-wrap: break-word;\n}\n.df .fld input {\n  min-height: 29px; padding: 0 8px;\n  border: 1px solid var(--line); border-radius: var(--r);\n  background: var(--sunken); color: var(--ink); font: 600 12px var(--mono);\n}\n.df .fld input:focus { border-color: var(--primary-dim); outline: 0; }\n.df .runline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: var(--gap); }\n.df .runline .spacer { flex: 1; }\n.df .qcount { font: 600 10.5px var(--mono); }\n\n/* ── progress ──────────────────────────────────────────────────────────── */\n.df .prog-card {\n  margin-bottom: var(--gap); padding: 12px 13px;\n  border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--panel);\n}\n.df .prog { height: 5px; overflow: hidden; border-radius: 99px; background: var(--sunken); }\n.df .prog i {\n  display: block; width: 0; height: 100%;\n  background: linear-gradient(90deg, var(--primary-dim), var(--primary));\n  transition: width .3s ease-out;\n}\n.df .prog-txt { margin: 7px 0 0; font: 500 11px var(--mono); }\n.df .prog-eta { float: right; color: var(--ink-mute); font: 500 10.5px var(--mono); }\n.df .tally { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }\n.df .log {\n  max-height: 148px; margin: 9px 0 0; padding: 8px 9px; overflow: auto;\n  border: 1px solid var(--line-soft); border-radius: var(--r);\n  background: var(--sunken); color: var(--ink-dim);\n  font: 500 10.5px/1.55 var(--mono); white-space: pre-wrap; word-break: break-all;\n}\n\n/* ── preset cards ──────────────────────────────────────────────────────── */\n/* Keep each cost row together in the drawer too. The two column layout\n * naturally collapses when a 262px card no longer fits. */\n.df .pgrid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(min(262px, 100%), 1fr)); }\n.df .pcard {\n  min-width: 0;\n  display: grid; gap: 6px; padding: 9px 10px;\n  border: 1px solid var(--line-soft); border-radius: var(--r); background: var(--sunken);\n}\n.df .pcard:hover { border-color: var(--line); }\n.df .pc-hd { display: flex; align-items: center; gap: 7px; }\n.df .pc-hd b { flex: 1; font-size: 12px; }\n.df .pc-label {\n  flex: 0 1 auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\n  padding: 1px 5px; border: 1px solid var(--line-soft); border-radius: 4px;\n  color: var(--ink-dim); font-size: 10px; font-weight: 500;\n}\n\n/* Preset cards carry four lines of unequal importance: gun name, the raw string\n * the submitter typed (only when it differs), the code, and the mode. The code\n * is what gets copied, so it gets the strongest surface; the raw string is a\n * provenance footnote and must not compete with the resolved name. */\n.df .pc-raw { font-size: 10px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.df .pc-code {\n  display: block; margin: 0; padding: 5px 6px; font-size: 11px; letter-spacing: .3px;\n  background: var(--bg); border: 1px solid var(--line-soft); border-radius: 5px;\n  overflow-wrap: anywhere; user-select: all;\n}\n/* Mode and Copy share one row: Copy used to sit alone in a footer below the\n * cost, so every card spent a full line on one button and the action sat\n * furthest from the code it copies. */\n.df .pc-act { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.df .pc-act .pc-meta { flex: 1 1 auto; }\n.df .pc-act .pc-ft { flex: none; margin: 0; }\n.df .pc-meta {\n  display: flex; align-items: center; gap: 6px; font-size: 10px;\n  /* min-width:0 on the children was not enough: this row is itself a flex item\n   * and .pcard is a grid item, and both default to min-width:auto. The auto\n   * minimum propagates up the chain, so the card refused to shrink to its\n   * 178px track no matter how shrinkable the leaf spans were. */\n  min-width: 0;\n}\n.df .pc-mode {\n  padding: 1px 6px; border-radius: 99px; font-size: 10px;\n  background: var(--bg); border: 1px solid var(--line-soft); color: var(--ink-dim);\n  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;\n  /* max-width:100% resolves against the flex line, not the shrunken track, so\n   * a long mode name (\"Chiến Trường Toàn Diện\") still set the row's min-content.\n   * min-width:0 is what actually lets a nowrap flex item ellipsis. */\n  min-width: 0; flex: 0 1 auto;\n}\n/* Operations builds cost money; Warfare loadouts are issued free. Tint the\n * chip so the mode reads before its label does. */\n.df .pc-mode.m-ops {\n  color: var(--primary); border-color: color-mix(in srgb, var(--primary) 45%, transparent);\n  background: color-mix(in srgb, var(--primary) 10%, var(--bg));\n}\n.df .pc-mode.m-war {\n  color: var(--amber); border-color: color-mix(in srgb, var(--amber) 45%, transparent);\n  background: color-mix(in srgb, var(--amber) 10%, var(--bg));\n}\n.df .pc-by {\n  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\n  /* The ellipsis never fired: a flex item's min-width is auto, so this refuses\n   * to shrink below its nowrap text and pushes .pc-meta's min-content to 222px\n   * — wider than the 178px grid track, so every card in the row overflowed. */\n  min-width: 0; flex: 1 1 6em;\n  /* The mode chip keeps its full width; the author takes what is left. With\n   * basis auto both shrank in proportion, so once Copy joined this row the mode\n   * chip clipped to \"Chiến Trường Toà…\". Basis 0 fixed that but crushed the\n   * author to a bare \"/…\" on narrow cards; a 6em basis plus the wrapping row\n   * below moves the author under the chip instead, where it stays readable. */\n}\n.df .pc-act .pc-meta { flex-wrap: wrap; row-gap: 3px; }\n\n/* ── equipment cost ───────────────────────────────────────────────────────────\n * The cost is the second thing a player checks after the gun name (\"can I afford\n * this build?\"), so it gets its own row with a real numeric weight rather than\n * being buried in the meta line. The row always renders, even when empty, so the\n * \"+ Thêm\" affordance is discoverable instead of hidden behind a hover. */\n.df .pc-cost {\n  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;\n  padding-top: 6px; border-top: 1px dashed var(--line-soft);\n}\n.df .pc-cost-label { font-size: 10px; color: var(--ink-mute); }\n.df .pc-cost-val { font-size: 12.5px; font-variant-numeric: tabular-nums; }\n/* An absent cost must read as \"nobody has measured this yet\", not as zero. */\n.df .pc-cost.none .pc-cost-val { color: var(--ink-mute); }\n.df .pc-cost-edit { margin-left: auto; }\n/* Tighter side padding than .act.tiny: the row has to hold a value, a badge and\n * this button on one line, and the button's text is a single short word. The\n * .act in the selector is what lets it outrank .df .act.tiny. */\n.df .act.pc-cost-edit { padding: 0 8px; }\n/* Warfare issues its loadouts, so the row states that plainly instead of\n * showing an empty price the player might try to fill in. It is deliberately\n * quieter than a real cost: it is an explanation, not a measurement. */\n.df .pc-cost-na { border-top-style: dotted; opacity: .72; }\n.df .pc-cost-na-text { margin-left: auto; font-size: 10px; }\n\n/* Agreement state is the whole point of the contribution flow, so it is a\n * visible badge rather than a tooltip: a number nobody has cross-checked should\n * not look as trustworthy as one three people agree on. */\n.df .cost-state {\n  padding: 1px 6px; border-radius: 99px; font-size: 9.5px; white-space: nowrap;\n  border: 1px solid var(--line-soft); color: var(--ink-dim); background: var(--bg);\n}\n.df .cost-state.cs-confirmed { border-color: var(--primary-dim); color: var(--primary); }\n.df .cost-state.cs-disputed { border-color: var(--amber); color: var(--amber); }\n.df .cost-state.cs-unconfirmed { opacity: .85; }\n/* HQ's figure stands in only until someone measures the build, so it reads\n * as a reference: dimmed value, dashed badge, never the confirmed colour. */\n.df .pc-cost.hq .pc-cost-val { color: var(--ink-dim); }\n.df .cost-state.cs-hq { border-style: dashed; }\n/* A disputed card is flagged on its edge too — the badge alone is easy to miss\n * when scanning a grid of twenty cards. */\n.df .pcard.pc-disputed { border-left: 2px solid var(--amber); }\n\n.df .pc-costedit { display: grid; gap: 6px; padding-top: 6px; border-top: 1px dashed var(--line-soft); }\n.df .pc-costedit .costin { width: 100%; font-variant-numeric: tabular-nums; }\n.df .btnrow.tight { display: flex; gap: 6px; }\n.df .cost-hint { font-size: 9.5px; line-height: 1.35; }\n\n.df .pc-ft { margin-top: 7px; }\n/* Section header inside the preset list: the class name plus how many are in\n * it, so a collapsed-looking group is never ambiguous. */\n.df .card-hd { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }\n.df .card-hd h3 { margin: 0; font-size: 12px; letter-spacing: .2px; }\n.df .card-hd .muted { font-size: 10px; }\n/* Match count under the library chips: tells you the filter did something even\n * when the result is short enough to fit without scrolling. */\n.df .rescount { margin: -4px 0 8px; font-size: 10px; }\n.df .pc-code {\n  display: block; padding: 5px 7px; user-select: all;\n  border: 1px dashed var(--line); border-radius: var(--r);\n  background: var(--void); font-size: 11.5px;\n  /* A Gunsmith code is 19 unbroken digits with no break opportunity, so it sets\n   * the card's min-content width and every .pcard in the grid grows 13px past\n   * its track. Let the digits wrap; the box stays inside its column. */\n  overflow-wrap: anywhere;\n}\n.df .pc-ft { display: flex; align-items: center; gap: 7px; }\n.df .pc-ft .muted { flex: 1; font-size: 10px; }\n\n/* ── HQ review ─────────────────────────────────────────────────────────── */\n/* Sits inside the Preset view between the filters and the class chips. Rows\n * are a list, not a grid: each needs room for the gun, the title and a 21-char\n * code, and the pick button must stay in the same column to scan quickly. */\n.df .hq-review .hq-note { margin: 0 0 8px; font-size: 11px; line-height: 1.4; }\n.df .hq-review .hq-err { margin: 0 0 8px; color: var(--danger); font-size: 12px; }\n.df .hq-group + .hq-group { margin-top: 10px; }\n.df .hq-group-hd { margin-bottom: 6px; font-size: 11px; font-weight: 700; color: var(--ink-dim); }\n.df .hq-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }\n/* A fixed first column: the pick button reads \"Chọn\" or \"✓ Chọn\" and a saved\n * row shows a narrower \"đã có\" tag, so a content-sized column pushed every\n * row's text to a different x. */\n.df .hq-row {\n  min-width: 0;\n  display: grid; grid-template-columns: 78px minmax(0, 1fr); align-items: start; gap: 9px;\n  padding: 7px 9px;\n  border: 1px solid var(--line-soft); border-radius: var(--r); background: var(--sunken);\n}\n.df .hq-row.on { border-color: var(--primary-dim); }\n.df .hq-row.hq-known { opacity: .62; }\n.df .hq-row > .chip { width: 100%; justify-content: center; padding: 3px 6px; }\n/* Centre the tag on the 32px button line so the two row kinds also match\n * vertically. */\n.df .hq-row > .tag { justify-self: center; margin-top: 8px; }\n.df .hq-review .hq-hint {\n  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px;\n  margin: 0 0 10px; padding: 7px 9px;\n  border: 1px solid var(--line-soft); border-left: 2px solid var(--amber); border-radius: var(--r);\n  background: var(--sunken); color: var(--ink-dim); font-size: 11px; line-height: 1.45;\n}\n.df .hq-hint > span { flex: 1 1 220px; min-width: 0; }\n.df .hq-hint .link { padding: 0; font-size: 11px; }\n.df .hq-main { min-width: 0; flex: 1; display: grid; gap: 3px; font-size: 12px; }\n.df .hq-main .muted { font-size: 10.5px; }\n.df .hq-code { font-size: 11px; letter-spacing: .3px; overflow-wrap: anywhere; user-select: all; }\n.df .hq-price { color: var(--ink-dim); }\n.df .hq-actions { align-items: center; margin-top: 10px; }\n/* On the full-page app the filter row falls back to the generic two-column\n * .two grid (the drawer's .filters.two rule is not loaded there), which\n * stretched this button to half the page. Keep it at its own width. */\n.df .filters > .hq-open { justify-self: start; }\n.df .tag {\n  padding: 1px 6px; border: 1px solid var(--line); border-radius: 99px;\n  color: var(--ink-mute);\n  font: 700 9px var(--sans); letter-spacing: .06em; text-transform: uppercase;\n}\n\n/* ── share textareas ───────────────────────────────────────────────────── */\n.df .share-gift, .df .share-preset {\n  width: 100%; padding: 8px 9px; resize: vertical;\n  border: 1px solid var(--line); border-radius: var(--r);\n  background: var(--sunken); color: var(--ink-dim); font: 500 11px/1.6 var(--mono);\n}\n.df .share-gift:focus, .df .share-preset:focus { border-color: var(--primary-dim); outline: 0; }\n\n/* ── history timeline ──────────────────────────────────────────────────── */\n.df .tline { margin: 0; padding: 0; list-style: none; }\n.df .tline li { position: relative; display: flex; gap: 10px; padding-bottom: 13px; }\n.df .tline .pi { position: relative; flex: none; width: 9px; margin-top: 4px; }\n.df .tline .pi::before {\n  content: ''; position: absolute; left: 1px; top: 1px;\n  width: 7px; height: 7px; border-radius: 99px;\n  background: var(--line); box-shadow: 0 0 0 2px var(--bg);\n}\n.df .tline .pi::after {\n  content: ''; position: absolute; left: 4px; top: 10px; bottom: -13px;\n  width: 1px; background: var(--line-soft);\n}\n.df .tline li:last-child .pi::after { display: none; }\n.df .tline li.st-success .pi::before { background: var(--s-success); }\n.df .tline li.st-mine .pi::before { background: var(--s-mine); }\n.df .tline li.st-untried .pi::before { background: var(--s-untried); }\n.df .tline li.st-expired .pi::before { background: var(--s-expired); }\n.df .tline li.st-exhausted .pi::before { background: var(--s-exhausted); }\n.df .tline li.st-gift_bug .pi::before { background: var(--s-gift_bug); }\n.df .tline li.st-invalid .pi::before { background: var(--s-invalid); }\n.df .tl-body { flex: 1; min-width: 0; }\n.df .tl-top { display: flex; align-items: center; gap: 8px; }\n.df .tl-top .mono { font-size: 11.5px; }\n.df .tl-top .ago { margin-left: auto; }\n.df .tl-body .muted { display: block; margin-top: 2px; font-size: 10.5px; word-break: break-word; }\n\n/* ── command palette (Ctrl+K) ──────────────────────────────────────────── */\n.df.palette-wrap, .df .palette-wrap {\n  position: fixed; inset: 0; z-index: 2147483646;\n  display: grid; place-items: start center; padding-top: 12vh;\n  background: rgba(2, 6, 8, .62); backdrop-filter: blur(2px);\n}\n.df .palette {\n  width: min(520px, 92vw); overflow: hidden;\n  border: 1px solid var(--line); border-radius: var(--r-lg);\n  background: var(--panel); box-shadow: 0 24px 70px rgba(0, 0, 0, .66);\n}\n.df .pq {\n  width: 100%; padding: 13px 15px;\n  border: 0; border-bottom: 1px solid var(--line-soft);\n  background: transparent; color: var(--ink); font: 500 13.5px var(--sans);\n}\n.df .pq:focus { outline: 0; }\n.df .phits { max-height: 320px; overflow: auto; }\n.df .palette-btn {\n  display: flex; align-items: center; gap: 10px; width: 100%;\n  padding: 9px 15px; border: 0; background: transparent;\n  color: var(--ink); cursor: pointer; font: 500 12px var(--sans); text-align: left;\n}\n.df .palette-btn.on, .df .palette-btn:hover { background: #16242a; }\n.df .palette-btn .go { margin-left: auto; color: var(--ink-mute); font: 500 10px var(--mono); }\n.df .pnone { padding: 18px 15px; color: var(--ink-mute); font-size: 12px; text-align: center; }\n.df .pfoot {\n  display: flex; gap: 9px; padding: 8px 15px;\n  border-top: 1px solid var(--line-soft); background: var(--sunken);\n  color: var(--ink-mute); font-size: 10.5px;\n}\n.df .pfoot kbd, .df .kbd-hint kbd {\n  padding: 1px 5px; border: 1px solid var(--line); border-radius: 3px;\n  background: var(--raised); color: var(--ink-dim); font: 600 9.5px var(--mono);\n}\n.df .kbd-hint { color: var(--ink-mute); font-size: 10.5px; }\n\n/* ── toast host ────────────────────────────────────────────────────────── */\n.df.toast-wrap, .df .toast-wrap {\n  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;\n  display: grid; gap: 7px; pointer-events: none;\n}\n\n/* ── small shared pieces ───────────────────────────────────────────────── */\n.df .close {\n  display: inline-flex; align-items: center; justify-content: center;\n  width: 32px; height: 32px;\n  border: 1px solid transparent; border-radius: var(--r);\n  background: transparent; color: var(--ink-mute); cursor: pointer; font-size: 15px;\n}\n.df .close:hover { border-color: var(--line); background: var(--raised); color: var(--ink); }\n.df .dot { display: inline-block; width: 6px; height: 6px; border-radius: 99px; background: var(--primary); }\n\n/* ── narrow surfaces: two-up grids collapse before text shrinks ────────── */\n@media (max-width: 560px) {\n  .df .two { grid-template-columns: 1fr; }\n  .df .pgrid { grid-template-columns: 1fr; }\n  /* Six class chips wrapped onto three lines at 430px. One scrollable row\n   * keeps them all reachable without pushing the first card off screen. */\n  .df .chiprow.pchips {\n    flex-wrap: nowrap; overflow-x: auto; overscroll-behavior-x: contain;\n    margin-right: -2px; padding-bottom: 3px; scrollbar-width: thin;\n  }\n  .df .chiprow.pchips .chip { flex: none; }\n}\n\n/* Square icon-only button. Used by page headers where a label would crowd. */\n.df .act.icon-only { width: 34px; padding: 0; font-size: 14px; }\n.df .act.tiny.icon-only { width: 32px; font-size: 13px; }\n\n/* ── .ico — square icon button, the drawer header and row-action workhorse ──\n * Defined here rather than next to .callout .ico (which is a decorative glyph,\n * not a control) so every <button class=\"ico\"> gets real chrome instead of\n * Chrome's pale default. */\n/* Comfortable hit target. 32px is the floor for every control in the drawer:\n * measured on the live panel, 174 controls sat below it and mis-taps on the\n * row actions were the most common complaint. */\n.df button.ico, .df .ico {\n  display: inline-flex; align-items: center; justify-content: center;\n  width: 32px; height: 32px; padding: 0;\n  border: 1px solid var(--line); border-radius: var(--r);\n  background: var(--raised); color: var(--ink-dim);\n  cursor: pointer; font-size: 14px; line-height: 1;\n  transition: border-color .14s, background .14s, color .14s;\n}\n.df button.ico:hover, .df .ico:hover { border-color: var(--primary-dim); background: #16252b; color: var(--ink); }\n.df button.ico:active { transform: translateY(1px); }\n.df .ico.tiny { width: 32px; height: 32px; font-size: 12px; }\n.df .ico.close:hover { border-color: var(--danger); color: var(--danger); }\n/* The decorative glyph inside a callout keeps its original treatment. */\n.df .callout .ico, .df .info-box .ico, .df .warn-box .ico {\n  width: auto; height: auto; border: 0; background: none; cursor: default;\n}\n\n/* ── settings primitives (popup + options) ─────────────────────────────────\n * Shared by the two chrome-extension:// settings surfaces so a toggle or a\n * backup status looks the same wherever it appears. */\n/* 40px is the comfortable target for the one or two actions a section ends\n * with; .tiny stays the floor for dense rows. */\n.df .act.lg { min-height: 40px; padding: 0 16px; font-size: 12.5px; }\n\n/* Toggle switch: a real checkbox (keyboard, form state, :disabled) with the\n * track drawn next to it. The whole label is the hit area, never just the\n * 36px track. */\n.df .switch { position: relative; display: inline-flex; align-items: center; gap: 8px; min-height: 32px; cursor: pointer; flex: none; }\n.df .switch input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; }\n.df .switch .track {\n  position: relative; flex: none; width: 36px; height: 20px;\n  border: 1px solid var(--line); border-radius: 99px; background: var(--sunken);\n  transition: background .15s, border-color .15s;\n}\n.df .switch .track::after {\n  content: \"\"; position: absolute; top: 2px; left: 2px;\n  width: 14px; height: 14px; border-radius: 50%; background: var(--ink-mute);\n  transition: transform .15s, background .15s;\n}\n.df .switch input:checked + .track { border-color: var(--primary-dim); background: color-mix(in srgb, var(--primary) 28%, var(--sunken)); }\n.df .switch input:checked + .track::after { transform: translateX(16px); background: var(--primary); }\n.df .switch input:focus-visible + .track { outline: 2px solid var(--primary); outline-offset: 2px; }\n.df .switch input:disabled + .track { opacity: .45; }\n.df .switch input:disabled ~ * { cursor: not-allowed; }\n\n/* Backup status pill. data-state carries the sync service's own state names,\n * plus \"off\" when personal backup is disabled. */\n.df .sbadge {\n  display: inline-flex; align-items: center; gap: 6px;\n  padding: 3px 9px; border: 1px solid var(--line); border-radius: 99px;\n  background: var(--sunken); color: var(--ink-dim);\n  font: 600 10.5px/1.4 var(--sans); white-space: nowrap;\n}\n.df .sbadge > i { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--ink-mute); }\n.df .sbadge[data-state=\"ok\"] { border-color: color-mix(in srgb, var(--s-success) 40%, var(--line)); color: var(--s-success); }\n.df .sbadge[data-state=\"ok\"] > i { background: var(--s-success); }\n.df .sbadge[data-state=\"error\"] { border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); color: var(--danger); }\n.df .sbadge[data-state=\"error\"] > i { background: var(--danger); }\n.df .sbadge[data-state=\"syncing\"] { color: var(--sky); }\n.df .sbadge[data-state=\"syncing\"] > i {\n  width: 9px; height: 9px; border: 1.5px solid var(--sky); border-right-color: transparent;\n  background: none; animation: df-spin .8s linear infinite;\n}\n.df .sbadge[data-state=\"off\"], .df .sbadge[data-state=\"never-synced\"] { color: var(--ink-mute); }\n@keyframes df-spin { to { transform: rotate(360deg); } }\n";
const DF_PANEL_CSS = "/* styles.css — drawer shell for the in-page surface, layered on theme.css.\n *\n * v2 was a centred modal with a dimming backdrop: it covered the redeem form,\n * so the user had to close the tool every time they wanted to paste a code.\n * v3 is a right-hand DRAWER that docks beside the page, keeping the form\n * reachable while a run is going. Resizable, collapsible, remembers its width.\n */\n\n:host { all: initial; }\n\n.df.shell {\n  position: fixed;\n  inset: 0 0 0 auto;\n  z-index: 2147483646;\n  display: grid;\n  grid-template-columns: auto 1fr;\n  /* The single row MUST be height-constrained, not auto. Without this the\n   * drawer grows to its content height (2200px for a 50-row table) and the\n   * view-host never becomes a scroller, so rows and the pager fall off the\n   * bottom of the viewport with no way to reach them. */\n  grid-template-rows: minmax(0, 1fr);\n  width: var(--w, 520px);\n  max-width: 100vw;\n  height: 100vh;\n  pointer-events: none;\n}\n.df.shell > * { pointer-events: auto; }\n.df.shell[hidden] { display: none !important; }\n\n/* ── drag-to-resize handle ─────────────────────────────────────────────── */\n.df .grip {\n  width: 5px;\n  border: 0;\n  padding: 0;\n  background: var(--line-soft);\n  cursor: col-resize;\n  transition: background .12s;\n}\n.df .grip:hover, .df .grip.active { background: var(--primary-dim); }\n\n/* ── drawer body ───────────────────────────────────────────────────────── */\n.df .drawer {\n  display: grid;\n  grid-template-rows: auto auto minmax(0, 1fr) auto;\n  min-width: 0;\n  border-left: 1px solid var(--line);\n  background: var(--bg);\n  box-shadow: -18px 0 50px rgba(0,0,0,.5);\n  container-type: inline-size;\n}\n\n/* ── header ────────────────────────────────────────────────────────────── */\n.df .hd {\n  display: flex; align-items: center; gap: 10px;\n  padding: 11px 13px;\n  border-bottom: 1px solid var(--line);\n  background: linear-gradient(180deg, #0d1a1e, var(--panel));\n}\n.df .brand { display: grid; gap: 1px; min-width: 0; }\n.df .brand .stencil { color: var(--primary); }\n.df .brand h2 {\n  margin: 0;\n  font-size: 14.5px; font-weight: 700; letter-spacing: -.01em;\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n}\n.df .brand h2 .ver { color: var(--ink-mute); font-size: 10.5px; font-weight: 600; }\n.df .hd-acts { display: flex; align-items: center; gap: 5px; margin-left: auto; }\n\n.df .sync-chip {\n  display: inline-flex; align-items: center; gap: 5px;\n  padding: 3px 8px; border: 1px solid var(--line); border-radius: 10px;\n  color: var(--ink-mute); font-size: 10px; font-weight: 600;\n  cursor: default; white-space: nowrap;\n}\n.df .sync-chip::before { content: \"\"; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }\n.df .sync-chip.st-ok { border-color: var(--primary-dim); color: var(--primary); }\n.df .sync-chip.st-error { border-color: #4a2228; color: var(--danger); }\n.df .sync-chip.st-syncing { border-color: #4a3a1e; color: var(--amber); }\n\n/* ── tabs: a fixed grid, never a ragged wrap ────────────────────────────\n * Flex-wrap left the 6th tab alone on its own row with a wide empty gap at\n * drawer width. A 3-column grid always balances 3+3, and two columns at very\n * narrow widths, so no tab is ever orphaned. */\n.df .views {\n  display: grid;\n  grid-template-columns: repeat(3, minmax(0, 1fr));\n  gap: 3px;\n  padding: 7px 9px;\n  border-bottom: 1px solid var(--line);\n  background: var(--panel);\n}\n@container (max-width: 330px) {\n  .df .views { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n}\n/* Below 430px the labels are hidden and six icons share one row — see the\n * narrow-drawer block further down. */\n.df .vtab {\n  display: inline-flex; align-items: center; justify-content: center; gap: 6px;\n  min-width: 0;                    /* grid cell must be allowed to shrink */\n  min-height: 32px;                /* shared hit-target floor, see components.css */\n  padding: 6px 8px;\n  border: 1px solid transparent; border-radius: var(--r);\n  background: none;\n  color: var(--ink-mute);\n  cursor: pointer;\n  font-size: 12px; font-weight: 600;\n  transition: color .12s, background .12s, border-color .12s;\n}\n.df .vtab .vi { font-size: 13px; line-height: 1; opacity: .85; }\n.df .vtab:hover { color: var(--ink-dim); background: var(--raised); }\n.df .vtab.on {\n  border-color: color-mix(in srgb, var(--primary) 35%, transparent);\n  background: var(--primary-glow);\n  color: var(--primary);\n}\n.df .vtab .badge {\n  padding: 0 5px; border-radius: 8px;\n  background: var(--amber); color: #201400;\n  font-size: 10px; font-weight: 800;\n  font-variant-numeric: tabular-nums;\n}\n\n/* ── view host ─────────────────────────────────────────────────────────── */\n.df .view-host { padding: 13px; overflow: auto; }\n.df .pad { display: grid; gap: var(--gap); }\n\n/* ── footer ────────────────────────────────────────────────────────────── */\n.df .ft {\n  display: flex; align-items: center; gap: 10px;\n  padding: 8px 13px;\n  border-top: 1px solid var(--line);\n  background: var(--panel);\n  color: var(--ink-mute);\n  font-size: 10.5px;\n  font-variant-numeric: tabular-nums;\n}\n.df .ft .spacer { flex: 1; }\n\n/* ── launcher (collapsed state) ────────────────────────────────────────── */\n.df.launcher-wrap { position: fixed; right: 0; bottom: 96px; z-index: 2147483645; }\n.df .launcher {\n  display: flex; align-items: center; gap: 8px;\n  padding: 10px 13px 10px 11px;\n  border: 1px solid var(--primary-dim); border-right: 0;\n  border-radius: var(--r-lg) 0 0 var(--r-lg);\n  background: linear-gradient(180deg, #0f2027, var(--panel));\n  box-shadow: -8px 0 26px rgba(0,0,0,.5);\n  color: var(--primary);\n  cursor: pointer;\n  font-size: 11.5px; font-weight: 700; letter-spacing: .08em;\n  writing-mode: vertical-rl;\n  transition: padding-right .14s, color .14s;\n}\n.df .launcher:hover { padding-right: 17px; color: #7ff5e0; }\n.df .launcher .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); }\n\n/* ── run view ──────────────────────────────────────────────────────────── */\n.df .runbar { display: grid; gap: 9px; }\n.df .runstat { display: flex; flex-wrap: wrap; gap: 7px; }\n.df .queue { min-height: 104px; }\n.df .pacerow { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 9px; align-items: end; }\n.df .check { display: flex; align-items: center; gap: 7px; color: var(--ink-dim); font-size: 11.5px; cursor: pointer; }\n.df .check input { width: 14px; height: 14px; accent-color: var(--primary); cursor: pointer; }\n\n/* ── library ───────────────────────────────────────────────────────────── */\n.df .filters { display: grid; grid-template-columns: minmax(130px, 1fr) auto auto; gap: 7px; }\n/* .two drops the third column: status filtering moved entirely to the chip\n * row, so the search box gets the space the redundant select used to take. */\n.df .filters.two { grid-template-columns: minmax(130px, 1fr) auto auto; }\n.df .bulk {\n  display: flex; align-items: center; gap: 8px;\n  padding: 8px 11px;\n  border: 1px solid color-mix(in srgb, var(--sky) 32%, transparent);\n  border-radius: var(--r);\n  background: color-mix(in srgb, var(--sky) 9%, transparent);\n  font-size: 11.5px;\n}\n.df .bulk.off { display: none; }\n/* A failed read is a warning, not a filter notice: the sky tone made the\n * mirror banner look like the \"Đang xem\" chip and it was easy to skim past. */\n.df .bulk.warn {\n  border-color: color-mix(in srgb, var(--amber) 55%, transparent);\n  border-left: 3px solid var(--amber);\n  background: color-mix(in srgb, var(--amber) 11%, transparent);\n}\n.df .bulk.warn b { color: #ffe4a0; }\n.df .bulk b { color: var(--sky); }\n.df .pager { display: flex; align-items: center; justify-content: center; gap: 9px; color: var(--ink-mute); font-size: 11.5px; }\n\n/* ── share ─────────────────────────────────────────────────────────────── */\n.df .sharebox { display: grid; gap: 8px; }\n\n/* ── narrow drawer: stack filters, hide tab text, shrink bar labels ────── */\n@container (max-width: 430px) {\n  .df .filters { grid-template-columns: 1fr; }\n  .df .bar-row { grid-template-columns: 78px 1fr 38px; }\n  .df .vtab .vl { display: none; }\n  .df .vtab { padding: 6px 9px; }\n  /* icons alone fit one clean row of six */\n  .df .views { grid-template-columns: repeat(6, minmax(0, 1fr)); }\n}\n";
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
  /* A host can pin the first view. app.html always opens on Tổng quan, and it
   * used to force that with a second go() after open() resolved, which threw
   * away any tab the user had clicked while the vault was still loading. */
  let view = opts.initialView && VIEWS.includes(opts.initialView)
    ? opts.initialView
    : store.get('view', 'dashboard');
  let libFilter = { status: 'all', q: '', sort: 'code' };
  /* Preset view has its own filter state: grouping by weapon class only
   * helps if you can also narrow to one class and search within it. */
  let presetFilter = { cls: 'all', q: '' };
  let libPage = 0;
  let selection = new Set();
  let cache = { codes: [], presets: [], stats: null, history: [], costs: {} };
  /* Costs this user has entered. Kept separate from `cache.costs` (the pulled
   * community record) so an unsynced edit survives a refresh and is visibly
   * "chờ gửi" rather than being silently replaced by the cloud value. */
  let costLocal = {};
  /* Which card is in cost-edit mode, plus its in-flight text and last error.
   * Only one card edits at a time: a grid of open inputs is how you get a user
   * typing a number into the wrong preset. */
  let costEdit = { code: null, value: '', error: '' };
  /* The HQ review frame inside the Preset view; null while closed. Picks are
   * held here rather than in checkbox DOM state, because the full-page app
   * replays clicks onto this tree and a cloned checkbox cannot carry its own
   * checked state back. `seq` drops a fetch that lands after a close. */
  let hqReview = null;
  let hqSeq = 0;
  /* Prices hq-capture.js read on the HQ page, keyed by code: { price, seenAt }.
   * Shown on a card only while nobody has measured that build, under its own
   * "Giá HQ" badge. It is never a cost: see hqPriceFor. */
  let hqPriceBook = {};
  let hqPriceSeq = 0;
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
          <button class="ico" data-act="sync-now" aria-label="Đồng bộ ngay" title="Đồng bộ ngay">☁</button>
          <button class="ico palette-btn" data-act="palette" aria-label="Lệnh nhanh" title="Lệnh nhanh (Ctrl+K)">⌘</button>
          <button class="ico" data-act="refresh" aria-label="Tải lại dữ liệu" title="Tải lại dữ liệu">⟳</button>
          <button class="ico close" aria-label="Thu gọn bảng" title="Thu gọn (Esc)">✕</button>
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

  /* Save a hand-measured cost: validate locally, keep it optimistically, then
   * push. A failed push is not a lost number — it stays local and visibly
   * "chờ gửi", so the user's measurement work is never thrown away by a network
   * blip. */
  async function saveCost(code) {
    /* Cost reporting is only meaningful in Operations. Do not let a stale cloned
     * button, automation, or the programmatic panel API create a Warfare cost. */
    const preset = cache.presets.find((row) => String(row.code).toUpperCase() === String(code).toUpperCase());
    if (!preset || !costEligible(preset)) {
      return toast('Chi phí chỉ áp dụng cho preset Chiến Dịch (Thoát Hiểm).', 'warn');
    }
    const input = $('.pc-costedit .costin');
    const raw = input ? input.value : costEdit.value;
    const parsed = Costs.parseCost(raw);
    if (!parsed.ok) {
      costEdit = { code, value: String(raw || ''), error: parsed.error };
      renderPresets();
      /* The repaint dropped focus with the Lưu button; put the user back in the
       * field with the bad value selected, ready to be typed over. */
      return focusInView($('.pc-costedit .costin'), true);
    }

    const key = costKey(preset);
    costLocal[key] = { value: parsed.value, state: 'unconfirmed', pending: true };
    costEdit = { code: null, value: '', error: '' };
    renderPresets();
    const savedLocally = await persistLocalCosts();

    if (!(opts.sync && opts.sync.reportCost)) {
      /* Only promise what actually happened: without durable storage the value
       * lives in memory and is gone on reload, which is precisely what the old
       * unconditional "đã lưu" toast hid. */
      if (savedLocally) {
        toast(`Đã lưu chi phí ${Costs.formatCost(parsed.value)} (chỉ trên máy này).`, 'ok');
      } else {
        toast(`Đang hiển thị ${Costs.formatCost(parsed.value)} nhưng chưa lưu được — tải lại trang là mất.`, 'warn');
      }
      return undefined;
    }

    /* The two transports fail differently: the app's sendMessage resolves with
     * { ok: false }, the drawer's askBridge rejects. Reading reply.ok alone
     * handled the app and let the drawer escape as an unhandled rejection, so
     * a bridge timeout showed no toast at all and the cost sat in "chờ gửi"
     * with nothing said. Normalise a rejection into the same shape. */
    let reply;
    try {
      reply = await opts.sync.reportCost(String(code).toUpperCase(), parsed.value, COST_MODE);
    } catch (error) {
      reply = { ok: false, error: (error && error.message) || String(error) };
    }
    if (!reply || !reply.ok) {
      if (reply && reply.skipped) {
        toast(`Đã lưu ${Costs.formatCost(parsed.value)} trên máy này — chưa bật kho chung nên không gửi lên được.`, 'warn');
      } else {
        toast(`Đã lưu trên máy này, gửi lên kho chung lỗi: ${(reply && reply.error) || 'không rõ'}`, 'warn');
      }
      return renderPresets();
    }

    /* The broker is authoritative about the agreed value and state, so adopt its
     * answer rather than keeping our own optimistic guess. */
    costLocal[key] = { value: reply.cost || parsed.value, state: reply.state, pending: false };
    cache.costs[key] = { value: reply.cost || parsed.value, state: reply.state, reports: reply.reports };
    await persistLocalCosts();
    const label = (Costs.STATES[reply.state] && Costs.STATES[reply.state].label) || reply.state;
    if (reply.state === 'disputed') {
      toast(`Số của bạn khác số đang có — đã chuyển sang chờ phê duyệt. Đang hiển thị ${Costs.formatCost(reply.cost)}.`, 'warn');
    } else if (reply.unchanged) {
      toast(`Chi phí ${Costs.formatCost(reply.cost)} đã có sẵn, không cần gửi lại.`, 'ok');
    } else {
      toast(`Đã gửi ${Costs.formatCost(reply.cost)} lên kho chung · ${label}.`, 'ok');
    }
    return renderPresets();
  }

  /* Local costs live in the sync service's own key-value store when available so
   * they survive a reload; a panel without a sync service still works, it just
   * forgets on refresh rather than failing. */
  async function persistLocalCosts() {
    try {
      if (!(opts.sync && opts.sync.setLocal)) return false;
      /* The bridge REPORTS a rejected key as { ok: false } instead of throwing,
       * so catching only exceptions would let a storage failure pass as success
       * and lose the cost on reload — the same silent loss as the missing
       * setLocal. Treat a falsy ok as a failure the caller must surface. */
      const reply = await opts.sync.setLocal('costsLocal', costLocal);
      return !(reply && reply.ok === false);
    } catch (_) { /* storage full or unavailable: keep the in-memory copy */ }
    return false;
  }

  async function loadLocalCosts() {
    try {
      if (opts.sync && opts.sync.getLocal) {
        const stored = await opts.sync.getLocal('costsLocal');
        if (stored && typeof stored === 'object') costLocal = stored;
      }
    } catch (_) { /* unreadable store: start empty */ }
  }

  /* .toast starts at opacity 0 and only .in makes it visible, so a toast that
   * never gets .in is announced to screen readers but invisible on screen.
   * Adding it a frame after insertion lets the fade-in transition run. A host
   * page that hides this shadow root (app.html mounts it display:none) passes
   * its own light-DOM container as opts.toastHost. */
  const toastHost = opts.toastHost || toasts;
  const nextFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 16);
  function toast(msg, tone) {
    const t = document.createElement('div');
    t.className = 'toast' + (tone ? ' ' + tone : '');
    t.textContent = msg;
    toastHost.appendChild(t);
    nextFrame(() => t.classList.add('in'));
    setTimeout(() => t.classList.remove('in'), 3900);
    setTimeout(() => { try { toastHost.removeChild(t); } catch (_) {} }, 4200);
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
    localHistory = hist;
    /* Merge whatever the last mirror read returned, so a revisit keeps the
     * drawer's runs on screen while the bridge is asked again. */
    cache.history = mergeHistory(hist, mirror.rows);
    loadMirror();
    loadHqPrices();
  }

  /* IndexedDB is per-origin, so a run done in the Garena drawer is absent
   * from this store when we are the extension page (and vice versa). The
   * worker keeps a shared mirror, merged in newest first and de-duplicated on
   * code+timestamp against the local rows.
   *
   * It is read in the background and never awaited by navigation: the drawer
   * reaches the worker through askBridge, which waits up to 60s for a service
   * worker that may be asleep, and every tab switch used to hang on a read
   * only History needs. */
  let localHistory = [];
  const mirror = { rows: [], state: 'idle', error: '' };
  let mirrorSeq = 0;

  function mergeHistory(local, rows) {
    if (!rows.length) return local;
    const key = (r) => String(r.code).toUpperCase() + '|' + (r.timestamp || '');
    const seen = new Set(local.map(key));
    const extra = rows.filter((r) => r && r.code && !seen.has(key(r)));
    return local.concat(extra)
      .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  }

  /* Disabling, reloading or updating the extension orphans the content
   * scripts already on the page: every chrome.runtime call from bridge.js then
   * throws "Extension context invalidated." for the rest of the page's life.
   * Unlike a sleeping worker this never recovers, so "Thử lại" only repeated
   * the same failure — the one thing that helps is reloading the page. */
  const isContextGone = (message) => /extension context invalidated/i.test(String(message || ''));

  function loadMirror() {
    if (!opts.sync || !opts.sync.readMirror) return;
    const seq = ++mirrorSeq;
    mirror.state = 'loading';
    Promise.resolve()
      .then(() => opts.sync.readMirror())
      .then((reply) => {
        /* The two transports fail differently: askBridge rejects, while
         * chrome.runtime.sendMessage resolves {ok:false} — or nothing at all
         * when no listener answered. Neither is an empty mirror. */
        if (!reply || reply.ok === false) throw new Error((reply && reply.error) || 'Worker không trả lời.');
        return Array.isArray(reply.rows) ? reply.rows : [];
      })
      .then((rows) => { if (seq === mirrorSeq) { mirror.rows = rows; mirror.state = 'ok'; mirror.error = ''; } },
        (err) => {
          if (seq !== mirrorSeq) return;
          mirror.error = String((err && err.message) || err);
          mirror.state = isContextGone(mirror.error) ? 'gone' : 'error';
        })
      .then(() => {
        if (seq !== mirrorSeq) return;
        cache.history = mergeHistory(localHistory, mirror.rows);
        /* Repaint only the view that shows it; the user may have moved on. */
        if (view === 'history') {
          const top = viewHost.scrollTop;
          renderHistory();
          viewHost.scrollTop = top;
        }
      });
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
    /* Pull agreed costs alongside the codes. Failure is silent for the same
     * reason the code pull is: a broker that is down must not make the preset
     * list look broken, it just means costs show as "—" until it recovers. */
    if (cfg.pull !== false && opts.sync.fetchCosts) {
      try {
        const reply = await opts.sync.fetchCosts();
        if (reply && reply.ok) {
          cache.costs = reply.costs || {};
          /* A local pending value that the broker now agrees with is no longer
           * pending — drop it so the card stops showing "chờ gửi" forever. */
          for (const [code, remote] of Object.entries(cache.costs)) {
            const mine = costLocal[code];
            if (mine && Costs.agrees && Costs.agrees(mine.value, remote.value)) delete costLocal[code];
          }
          await persistLocalCosts();
        }
      } catch (_) { /* offline: keep whatever costs we already have */ }
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
      return `<button class="chip${on}" data-act="fchip" data-k="${k}" aria-pressed="${libFilter.status === k}">
        ${k !== 'all' ? `<i class="s-${k}"></i>` : ''}${esc(label)} <b>${n}</b></button>`;
    }).join('');

    viewHost.innerHTML = `<div class="pad">
      <div class="filters two">
        <input class="fq" placeholder="Tìm mã…" value="${esc(libFilter.q)}" aria-label="Tìm mã">
        <select class="fsort" aria-label="Sắp xếp">
          <option value="code"${libFilter.sort === 'code' ? ' selected' : ''}>A→Z</option>
          <option value="recent"${libFilter.sort === 'recent' ? ' selected' : ''}>Mới thử</option>
          <option value="status"${libFilter.sort === 'status' ? ' selected' : ''}>Trạng thái</option>
        </select>
        ${libFilter.q || libFilter.status !== 'all' ? '<button class="act tiny ghost" data-act="fclear">Xoá lọc</button>' : ''}
      </div>

      <div class="chiprow" role="group" aria-label="Lọc theo trạng thái">${chips}</div>

      <div class="rescount muted" aria-live="polite">
        ${rows.length === cache.codes.length
          ? `${cache.codes.length} mã`
          : `${rows.length} / ${cache.codes.length} mã khớp`}
      </div>

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
            <button class="ico tiny" data-act="row-copy" data-code="${esc(r.code)}" aria-label="Copy mã ${esc(r.code)}" title="Copy mã">⧉</button>
            <button class="ico tiny" data-act="row-hist" data-code="${esc(r.code)}" aria-label="Lịch sử mã ${esc(r.code)}" title="Lịch sử mã này">◷</button>
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
    const onPage = onRedeemPage();
    const queued = store.get('queue', '');

    viewHost.innerHTML = `<div class="pad">
      ${onPage ? '' : `<div class="warn-box run-blocker" role="alert">
        <span class="warn-mark" aria-hidden="true">!</span>
        <div><b>Chưa thể chạy đổi code ở tab này</b>
        <p>Mở <code class="mono">redeem.df.garena.sg/vi/cdkgarena.html</code>, đăng nhập Garena, rồi chạy lại tại đó. Nút Bắt đầu đã được khoá để tránh báo lỗi sai cho cả hàng chờ.</p>
        <button class="act tiny warn-cta" data-act="open-redeem">Mở trang đổi code →</button></div>
      </div>`}

      <section class="card">
        <div class="card-hd"><h3>Hàng chờ</h3><span class="muted qcount">0 mã</span></div>
        <div class="runbar">
          <div class="runstat">
            <button class="act tiny" data-act="q-untried">Mã chưa thử (${untried.length})</button>
            ${retryable.length ? `<button class="act tiny" data-act="q-sys-error">Garena lỗi — thử lại (${retryable.length})</button>` : ''}
            <button class="act tiny" data-act="q-clear">Xoá hàng chờ</button>
          </div>
          <textarea class="queue" rows="7" aria-label="Hàng chờ mã, mỗi dòng một mã" placeholder="Mỗi dòng một mã. Dán từ bất kỳ đâu — ký tự lạ sẽ được lọc.">${esc(queued)}</textarea>
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
        <button class="act primary go" data-act="start"${onPage ? '' : ' disabled title="Cần mở tại trang đổi code của Garena"'}>Bắt đầu</button>
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

  /* Redemption only works on the Garena page: every request from elsewhere
   * fails at the network layer. The view already warns about this, but the
   * Start button stayed enabled, so the warning read as advisory and clicking
   * Start produced a wall of failures that looked like dead codes rather than
   * a wrong-page mistake. Gate the control itself, and keep the guard in
   * startRun() too since the engine is also reachable via the programmatic
   * API at the bottom of this module. */
  /* The host alone is not enough: redeem.df.garena.sg also serves landing and
   * event pages that carry no redeem form. Letting Start run there marks the
   * whole queue failed against a page that was never going to accept a code,
   * so require the redeem document itself. */
  const onRedeemPage = () => /redeem\.df\.garena\.sg$/.test(location.hostname || '')
    && /cdkgarena/.test(location.pathname || '');

  async function startRun() {
    if (activeRun) return toast('Đang có lượt chạy.', 'warn');
    if (!onRedeemPage()) return toast('Cần mở tab này tại trang đổi code của Garena.', 'warn');
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
      const s = $('[data-act="start"]'); if (s) s.disabled = !onRedeemPage();
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
            setSyncChip(syncStatus);
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
      if (start) start.disabled = !onRedeemPage();
      const p = $('[data-act="pause"]'); if (p) { p.disabled = true; p.textContent = 'Tạm dừng'; }
      const st = $('[data-act="stop"]'); if (st) st.disabled = true;
      await refresh();
    }
  }

  /* A backup the user asks for, rather than the automatic one at the end of a
   * run. Without it, codes imported or edited outside a run sat unsaved until
   * the next run, and a failed sync could only be retried by running again.
   * One backup at a time: a second click while the first is still talking to
   * the bridge must not start a parallel push of the same vault. */
  let manualSyncing = false;
  async function syncNowManual() {
    if (manualSyncing) return;
    if (!opts.sync || !opts.sync.syncNow || !vault || !vault.all) {
      return toast('Bản này không có đồng bộ cá nhân.', 'warn');
    }
    manualSyncing = true;
    const btn = $('[data-act="sync-now"]');
    if (btn) btn.disabled = true;
    setSyncChip({ state: 'syncing' });
    try {
      const settings = opts.sync.getSettings ? await opts.sync.getSettings() : null;
      if (settings && settings.enabled === false) return toast('Đồng bộ cá nhân đang tắt trong Cài đặt.', 'warn');
      const reply = await opts.sync.syncNow(await vault.all());
      const syncStatus = reply && reply.status ? reply.status : reply;
      setSyncChip(syncStatus);
      if (syncStatus && syncStatus.state === 'error') {
        toast('Đồng bộ cá nhân lỗi: ' + (syncStatus.error || 'không rõ'), 'err');
      } else {
        const n = syncStatus && Number.isFinite(syncStatus.recordCount) ? ` ${syncStatus.recordCount} mã` : '';
        toast('Đã đồng bộ' + n + '.', 'ok');
      }
    } catch (error) {
      setSyncChip();
      toast('Đồng bộ cá nhân lỗi: ' + (error && error.message || error), 'err');
    } finally {
      manualSyncing = false;
      if (btn) btn.disabled = false;
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
    /* Event/rotating Warfare playlists: the preset applies to the same
     * Warfare loadout, so they must not fragment into their own group. */
    'Tactical Turmoil': 'Chiến Trường Toàn Diện',
  };
  const canonicalMode = (mode) => MODE_ALIASES[String(mode || '').trim()] || String(mode || '').trim() || 'Khác';

  /* Case- and accent-insensitive key for preset search. NFD splits most
   * Vietnamese marks off their base letter; Đ/đ has no decomposition, so it is
   * mapped by hand. Spaces and punctuation stay, so substring search still
   * respects word boundaries the user typed. */
  const foldSearch = (s) => String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[Đđ]/g, 'D')
    .toUpperCase();

  /* Weapon resolution lives in core so the catalogue is shared with the tests
   * and any other surface; fall back to a pass-through if the bundle predates
   * it, so an older cached core degrades to the previous behaviour rather than
   * throwing on render. */
  const Weapons = (typeof root !== 'undefined' && root.DFRedeemWeapons)
    || (typeof window !== 'undefined' && window.DFRedeemWeapons)
    || null;
  const classify = (p) => (Weapons
    ? Weapons.classifyPreset(p)
    : { cls: 'unknown', clsLabel: 'Chưa rõ loại súng', weapon: String((p && (p.weapon || p.gun)) || '—'), raw: '' });

  /* Catalogue names carry the class in English ("AKM Assault Rifle"), and every
   * card already sits under its class heading, so the suffix repeated the
   * heading on every card and pushed the code below the fold on narrow
   * screens. Show the model only; the full name stays in the tooltip and in
   * search (which matches meta.weapon, not this display string). */
  const shortWeapon = (meta) => {
    const name = String((meta && meta.weapon) || '');
    if (!meta || !meta.canonical) return name;
    /* SVD is grouped as a marksman rifle but its catalogue name ends in
     * Sniper Rifle. Strip a known suffix, not only the resolved class label. */
    const classes = Weapons ? Weapons.WEAPON_CLASSES : [];
    const suffix = classes.find((c) => name.endsWith(' ' + c.en));
    return suffix ? (name.slice(0, -(suffix.en.length + 1)) || name) : name;
  };

  /* Two modes, two very different meanings for the same code: Operations
   * builds cost money, Warfare loadouts are free. Colour the chip so the mode
   * reads at a glance instead of after reading two lines of Vietnamese. */
  const MODE_TONE = { 'Chiến Dịch Sinh Tồn': 'm-ops', 'Chiến Trường Toàn Diện': 'm-war' };
  const modeTone = (mode) => MODE_TONE[canonicalMode(mode)] || 'm-other';

  /* Same defensive lookup as Weapons: a missing costs module must degrade to
   * "no cost shown", never break the whole preset view. */
  const Costs = (typeof root !== 'undefined' && root.DFRedeemCosts)
    || (typeof window !== 'undefined' && window.DFRedeemCosts)
    || {
      formatCost: (v) => (v ? String(v) : '—'),
      parseCost: () => ({ ok: false, error: 'Không tải được module chi phí' }),
      STATES: {},
    };

  /* Cost belongs to one build in Hazard Operations (the Vietnamese client calls
   * it Chiến Dịch / Thoát Hiểm). The same gun can have many build codes, and
   * Warfare's free loadout has no meaningful purchase price. Key by the code,
   * not weapon name, then reject non-Operations reports at the Worker boundary
   * after the client sends the mode it displayed. */
  const COST_MODE = 'Chiến Dịch Sinh Tồn';
  const costEligible = (preset) => canonicalMode(preset && preset.mode) === COST_MODE;
  const costKey = (preset) => String((preset && preset.code) || '').toUpperCase();

  /* A preset's cost can come from three places, in order of authority:
   *   1. the community record pulled from the Worker (agreed by several users)
   *   2. the bundled data file (shipped with the build)
   *   3. a value this user typed but has not synced yet
   * The local unsynced value wins for display so editing feels immediate, with
   * its pending state visible rather than silently overwritten on next pull. */
  function costFor(preset) {
    const code = costKey(preset);
    const local = costLocal[code];
    const remote = (cache.costs && cache.costs[code]) || null;
    const bundled = preset && preset.cost
      ? { value: Number(preset.cost), state: String(preset.cost_state || 'unconfirmed') }
      : null;
    const pick = local || remote || bundled;
    if (!pick || !pick.value) return { value: 0, state: 'none', label: '', hint: '' };
    const meta = Costs.STATES && Costs.STATES[pick.state];
    return {
      value: Number(pick.value),
      state: pick.state,
      label: local && local.pending ? 'Chờ gửi' : (meta ? meta.label : ''),
      hint: local && local.pending ? 'Chưa gửi lên kho chung' : (meta ? meta.hint : ''),
    };
  }

  /* ── HQ recommended codes ─────────────────────────────────────────────── */
  /* The official HQ page curates builds per mode. The worker fetches its public
   * files and returns items already validated by core/hq.js; this view only
   * reviews and imports them. Nothing is written until the user picks codes and
   * confirms, and a code already in the library is shown as "đã có" and never
   * overwritten, so HQ can never replace a build someone saved or verified.
   *
   * HQ's price is display-only. It is a snapshot that moves with the market and
   * was measured by HQ, not by this community, so it never becomes preset.cost,
   * never feeds costFor() and is never reported to the shared cost record. A
   * card with no measured cost shows it instead of "—", labelled "Giá HQ". */
  const HQ_CODE_RE = /^[A-Z0-9]{21}$/;
  const HQ_PAGE_URL = 'https://www.playdeltaforce.com/events/hq/vi/';
  const hqText = (value, max) => String(value == null ? '' : value).trim().slice(0, max);

  /* Re-checked here even though the worker already validated: the reply crossed
   * a message hop, and the import writes into the vault. */
  function hqItems(reply) {
    const out = [];
    const seen = new Set();
    for (const raw of (reply && Array.isArray(reply.items) ? reply.items : [])) {
      const code = hqText(raw && raw.code, 64).toUpperCase();
      if (!HQ_CODE_RE.test(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        weapon: hqText(raw.weapon, 80),
        mode: hqText(raw.mode, 60),
        title: hqText(raw.title, 120),
        author: hqText(raw.author, 80),
        tags: (Array.isArray(raw.tags) ? raw.tags : []).map((t) => hqText(t, 40)).filter(Boolean).slice(0, 8),
      });
    }
    return out;
  }

  /* `{ CODE: price }` for display. Keys must be codes from this reply and
   * values plausible integers; anything else is dropped, not shown. */
  function hqPrices(reply, items) {
    const raw = reply && reply.prices && typeof reply.prices === 'object' ? reply.prices : {};
    const out = {};
    for (const item of items) {
      const price = Number(raw[item.code]);
      if (Number.isInteger(price) && price > 0) out[item.code] = price;
    }
    return out;
  }

  /* The worker's whole price store, re-checked like hqPrices because the reply
   * crossed a message hop. null means "no answer", so a failed read keeps the
   * prices already on screen instead of blanking them. */
  function hqPriceRows(reply) {
    if (!reply || reply.ok === false || !reply.prices || typeof reply.prices !== 'object') return null;
    const out = {};
    for (const [raw, row] of Object.entries(reply.prices)) {
      const code = String(raw).toUpperCase();
      const price = Number(row && typeof row === 'object' ? row.price : NaN);
      if (!HQ_CODE_RE.test(code) || !Number.isInteger(price) || price <= 0) continue;
      out[code] = { price, seenAt: hqText(row.seen_at, 40) };
    }
    return out;
  }

  /* HQ's reference price for a build, or null. Kept apart from costFor on
   * purpose: the cost editor, the save path and the community report all read
   * costFor, so this figure can never be submitted as a cost. Only the
   * Operations cost row calls it; Warfare cards have no cost row at all. */
  function hqPriceFor(preset) {
    return hqPriceBook[costKey(preset)] || null;
  }

  function hqPriceHint(hq) {
    const at = new Date(hq.seenAt);
    const day = hq.seenAt && !Number.isNaN(at.getTime()) ? ` ghi ngày ${at.toLocaleDateString('vi-VN')}` : '';
    return `Giá HQ${day}, chỉ để tham khảo: chưa phải chi phí đo trong game và không gửi lên kho chung.`;
  }

  /* Off the navigation path: in the drawer this read goes through askBridge,
   * which can wait on a sleeping worker, and no tab switch may hang on it. */
  function loadHqPrices() {
    if (!opts.sync || typeof opts.sync.hqReadPrices !== 'function') return;
    const seq = ++hqPriceSeq;
    Promise.resolve()
      .then(() => opts.sync.hqReadPrices())
      .then((reply) => {
        const book = hqPriceRows(reply);
        if (!book || seq !== hqPriceSeq) return;
        if (JSON.stringify(book) === JSON.stringify(hqPriceBook)) return;
        hqPriceBook = book;
        repaintHqPrices();
      })
      .catch(() => { /* a reference price must never break the view */ });
  }

  /* Prices can land after the grid painted. Skip the repaint while a cost
   * editor is open: it would reset the number being typed. The next render
   * after Lưu or Thôi picks the prices up. */
  function repaintHqPrices() {
    if (view !== 'presets' || costEdit.code) return;
    renderPresets();
    hqPainted();
  }

  /* Same row shape core/hq.js toPresetRow builds, kept local because hq.js is
   * not bundled into the panel. Deliberately carries no `cost`. */
  const hqPresetRow = (item) => ({
    kind: 'preset',
    code: item.code,
    weapon: item.weapon,
    mode: item.mode,
    author: item.author,
    source: 'hq',
    notes: item.title,
    tags: ['hq'].concat(item.tags || []),
  });

  /* The full-page app shows a clone of this view, refreshed only right after a
   * click. The HQ fetch answers seconds later, so tell the host when the
   * review repaints on its own. */
  function hqPainted() {
    if (typeof opts.onRepaint === 'function') {
      try { opts.onRepaint('presets'); } catch (_) { /* a host hook must not break the view */ }
    }
  }

  async function libraryPresetCodes() {
    let rows = cache.presets;
    if (vault) {
      try { rows = await vault.byKind('preset'); } catch (_) { /* fall back to what the view already shows */ }
    }
    return new Set((rows || []).map((p) => String((p && p.code) || '').toUpperCase()).filter(Boolean));
  }

  async function openHqReview() {
    if (!opts.sync || typeof opts.sync.hqFetch !== 'function') {
      return toast('Bản này không tải được mã HQ — dùng extension.', 'warn');
    }
    const seq = ++hqSeq;
    /* "Tải lại" after visiting HQ for prices re-runs this. Keep the user's
     * picks across that reload: un-ticking five codes and then losing it to a
     * price refresh would make them redo the review. */
    const prior = hqReview && hqReview.state === 'ready'
      ? { offered: new Set(hqReview.items.map((i) => i.code)), picked: new Set(hqReview.picked) }
      : null;
    hqReview = { state: 'loading', items: [], known: new Set(), prices: {}, picked: new Set(), failed: [], error: '', saving: false };
    renderPresets();
    let reply;
    try {
      reply = await opts.sync.hqFetch();
    } catch (error) {
      reply = { ok: false, error: String((error && error.message) || error) };
    }
    if (seq !== hqSeq || !hqReview) return;
    if (!reply || reply.ok === false) {
      const why = (reply && reply.error) || 'Worker không trả lời.';
      hqReview.state = 'error';
      hqReview.error = isContextGone(why)
        ? 'Extension vừa được tải lại hoặc cập nhật. Tải lại trang để kết nối lại.'
        : why;
    } else {
      const items = hqItems(reply);
      /* Match on the vault's own codes, case-insensitive, so a code saved in any
       * spelling counts as present and is never written a second time. */
      const have = await libraryPresetCodes();
      if (seq !== hqSeq || !hqReview) return;
      hqReview.state = 'ready';
      hqReview.items = items;
      hqReview.known = new Set(items.filter((i) => have.has(i.code)).map((i) => i.code));
      hqReview.prices = hqPrices(reply, items);
      /* Same store the cards read, so an imported code shows its HQ price
       * without waiting for the next full read. */
      for (const [code, price] of Object.entries(hqReview.prices)) {
        const had = hqPriceBook[code];
        hqPriceBook[code] = { price, seenAt: had && had.price === price ? had.seenAt : '' };
      }
      hqReview.failed = Array.isArray(reply.failed) ? reply.failed : [];
      /* Start with every new code picked: the list is short and curated, and
       * the user unticks what they do not want before anything is saved. On a
       * reload, a code offered last time keeps its previous pick state. */
      hqReview.picked = new Set(items
        .filter((i) => !hqReview.known.has(i.code))
        .filter((i) => !prior || !prior.offered.has(i.code) || prior.picked.has(i.code))
        .map((i) => i.code));
    }
    if (view === 'presets') { renderPresets(); hqPainted(); }
  }

  async function importHqPicked() {
    if (!hqReview || hqReview.state !== 'ready' || hqReview.saving) return;
    const rows = hqReview.items.filter((i) => hqReview.picked.has(i.code) && !hqReview.known.has(i.code));
    if (!rows.length) return toast('Chưa chọn mã mới nào.', 'warn');
    if (!vault) return toast('Không mở được kho trên trang này.', 'err');
    hqReview.saving = true;
    renderPresets();
    /* Re-read the library right before writing: another tab or a sync may have
     * saved one of these codes since the review opened. */
    const have = await libraryPresetCodes();
    let added = 0;
    let skipped = 0;
    const failed = [];
    for (const item of rows) {
      if (have.has(item.code)) { skipped += 1; continue; }
      try {
        /* Insert-only, checked inside the write transaction: a sync or another
         * tab that saved this code after `have` was read must not be overwritten. */
        const res = await vault.upsert(hqPresetRow(item), { insertOnly: true });
        if (res && res.skipped) skipped += 1;
        else if (res && res.inserted) added += 1;
      } catch (error) {
        failed.push(item.code + ': ' + String((error && error.message) || error));
      }
    }
    hqReview = null;
    hqSeq += 1;
    await refresh();
    if (view === 'presets') { renderPresets(); hqPainted(); }
    const tail = skipped ? `, bỏ qua ${skipped} mã vừa có trong kho` : '';
    if (failed.length) toast(`Đã nhập ${added} mã HQ${tail}, ${failed.length} mã lỗi — ${failed[0]}`, 'warn');
    else toast(`Đã nhập ${added} mã HQ vào kho preset${tail}.`, 'ok');
  }

  function renderHqReview() {
    if (!hqReview) return '';
    const r = hqReview;
    const head = (extra) => `<div class="card-hd"><h3>Mã đề xuất từ HQ</h3>${extra}
          <button class="act tiny ghost" data-act="hq-close" aria-label="Đóng khung duyệt mã HQ">Đóng</button></div>`;
    if (r.state === 'loading') {
      return `<section class="card hq-review" aria-busy="true">${head('')}
        <p class="muted" role="status">Đang tải danh sách mã từ trang HQ…</p>
      </section>`;
    }
    if (r.state === 'error') {
      return `<section class="card hq-review">${head('')}
        <p class="hq-err" role="alert">Không tải được mã HQ: ${esc(r.error)}</p>
        <div class="btnrow"><button class="act tiny" data-act="hq-import">Thử lại</button></div>
      </section>`;
    }
    const fresh = r.items.filter((i) => !r.known.has(i.code));
    const pickedCount = fresh.filter((i) => r.picked.has(i.code)).length;
    const groups = new Map();
    for (const item of r.items) {
      const mode = canonicalMode(item.mode);
      if (!groups.has(mode)) groups.set(mode, []);
      groups.get(mode).push(item);
    }
    const rowFor = (item) => {
      const known = r.known.has(item.code);
      const on = !known && r.picked.has(item.code);
      const price = r.prices[item.code];
      return `<li class="hq-row${known ? ' hq-known' : ''}${on ? ' on' : ''}">
          ${known
            ? '<span class="tag" title="Mã này đã có trong kho, sẽ không bị ghi đè">đã có</span>'
            : `<button class="chip hq-pick${on ? ' on' : ''}" data-act="hq-toggle" data-code="${esc(item.code)}"
                aria-pressed="${on ? 'true' : 'false'}" aria-label="${on ? 'Bỏ chọn' : 'Chọn'} mã HQ ${esc(item.code)}">${on ? '✓ Chọn' : 'Chọn'}</button>`}
          <div class="hq-main">
            <b>${esc(item.weapon || '—')}</b>${item.title ? ` <span class="muted">${esc(item.title)}</span>` : ''}
            <code class="mono hq-code">${esc(item.code)}</code>
            <span class="muted hq-sub">${item.author ? 'của ' + esc(item.author) : ''}${price
              ? `${item.author ? ' · ' : ''}<span class="hq-price" title="Giá HQ hiển thị để tham khảo, không dùng làm chi phí trang bị">Giá HQ ≈ ${esc(Costs.formatCost(price))}</span>`
              : ''}</span>
          </div>
        </li>`;
    };
    const partial = r.failed.length
      ? `<p class="muted hq-note" role="status">Thiếu nguồn: ${r.failed.map((f) => esc(canonicalMode(f && f.mode)) + ' (' + esc(f && f.error) + ')').join(', ')}.</p>`
      : '';
    /* Only Operations builds carry an HQ price, and the HQ page fetches them
     * only after the player opens "Xem thêm" under "Đề Xuất Chia Sẻ Mã" — its
     * first load asks for counts alone. Until then every price is missing, so
     * say where to click instead of leaving the user to guess. The anchor is a
     * plain link: it works the same in the drawer and in the cloned app view. */
    const unpriced = r.items.filter((i) => canonicalMode(i.mode) === COST_MODE && !r.prices[i.code]).length;
    const priceHint = unpriced
      ? `<p class="hq-hint" role="note"><span>${unpriced} mã ${esc(COST_MODE)} chưa có giá HQ. Mở trang HQ (đã đăng nhập), bấm <b>Xem thêm</b> ở mục Đề Xuất Chia Sẻ Mã để trang tải giá, rồi bấm Tải lại.</span>
          <a class="link" href="${HQ_PAGE_URL}" target="_blank" rel="noopener noreferrer">Mở trang HQ ↗</a>
          <button class="act tiny ghost" data-act="hq-import">Tải lại</button></p>`
      : '';
    return `<section class="card hq-review">${head(`<span class="muted">${fresh.length} mới · ${r.known.size} đã có</span>`)}
        <p class="muted hq-note">Tick mã muốn nhập rồi bấm Nhập. Mã đã có trong kho không bị ghi đè. Giá HQ chỉ để xem, không dùng làm chi phí trang bị.</p>
        ${priceHint}
        ${partial}
        ${r.items.length ? [...groups.entries()].map(([mode, items]) => `<div class="hq-group">
          <div class="hq-group-hd">${esc(mode)} <span class="muted">${items.length} mã</span></div>
          <ul class="hq-list">${items.map(rowFor).join('')}</ul>
        </div>`).join('') : '<p class="muted">HQ chưa có mã nào.</p>'}
        <div class="btnrow hq-actions">
          ${fresh.length ? `<button class="act tiny ghost" data-act="hq-pick-all">Chọn hết mã mới</button>
          <button class="act tiny ghost" data-act="hq-pick-none">Bỏ chọn hết</button>` : ''}
          <span class="spacer"></span>
          <button class="act tiny primary" data-act="hq-commit"${pickedCount && !r.saving ? '' : ' disabled'}>${r.saving ? 'Đang nhập…' : `Nhập ${pickedCount} mã đã chọn`}</button>
        </div>
      </section>`;
  }

  function renderPresets() {
    /* Resolve once, then filter: every row needs its class for both the chip
     * counts and the grouping, so classifying inside the loop would repeat the
     * catalogue scan for each. */
    const all = cache.presets.map((p) => ({ preset: p, meta: classify(p) }));

    const counts = new Map();
    for (const row of all) counts.set(row.meta.cls, (counts.get(row.meta.cls) || 0) + 1);

    const q = foldSearch(presetFilter.q.trim());
    const rows = all.filter(({ preset, meta }) => {
      if (presetFilter.cls !== 'all' && meta.cls !== presetFilter.cls) return false;
      if (!q) return true;
      /* Search covers the code, the resolved name and whatever the submitter
       * typed, so pasting a code from Discord finds it and so does typing the
       * Vietnamese gun name. Accents are folded on both sides, so "nhac" finds
       * the "Nhạc" builds and "tay den" finds Tay Đen. */
      return foldSearch(`${preset.code} ${meta.weapon} ${meta.raw} ${preset.label || ''} ${preset.mode || ''}`).includes(q);
    });

    /* Section order follows the in-game Gunsmith class order, not the
     * alphabet, with unknowns last so dirty data never leads the page. */
    const order = (Weapons ? Weapons.WEAPON_CLASSES.map((c) => c.id) : []).concat(['unknown']);
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.meta.cls)) groups.set(row.meta.cls, []);
      groups.get(row.meta.cls).push(row);
    }
    const sections = order.filter((id) => groups.has(id)).map((id) => ({
      id,
      label: groups.get(id)[0].meta.clsLabel,
      rows: groups.get(id).slice().sort((a, b) => String(a.meta.weapon).localeCompare(String(b.meta.weapon))),
    }));

    const chipFor = (id, label, n) => `<button class="chip${presetFilter.cls === id ? ' on' : ''}"
      data-act="pchip" data-k="${esc(id)}"${presetFilter.cls === id ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${esc(label)} <b>${n}</b></button>`;

    const chips = [chipFor('all', 'Tất cả', all.length)].concat(
      order.filter((id) => counts.get(id)).map((id) => {
        const cls = Weapons && Weapons.WEAPON_CLASSES.find((c) => c.id === id);
        return chipFor(id, cls ? cls.label : 'Chưa rõ loại súng', counts.get(id));
      }),
    ).join('');

    viewHost.innerHTML = `<div class="pad">
      <div class="info-box">
        <b>Loại mã này nhập trong game, không đổi qua web.</b>
        <p>Gunsmith → Loadout → nút kính lúp → dán mã. Linh kiện chưa mở khoá sẽ không nạp được.</p>
      </div>

      <div class="filters two pfilters">
        <input class="pq" placeholder="Tìm mã, tên súng, build, chế độ…" value="${esc(presetFilter.q)}" aria-label="Tìm preset">
        ${presetFilter.q || presetFilter.cls !== 'all' ? '<button class="act tiny ghost" data-act="pclear">Xoá lọc</button>' : ''}
        ${opts.sync && typeof opts.sync.hqFetch === 'function'
          ? `<button class="act tiny hq-open" data-act="hq-import" aria-expanded="${hqReview ? 'true' : 'false'}"
              title="Xem mã đề xuất trên trang HQ chính thức rồi chọn mã muốn nhập"${hqReview && hqReview.state === 'loading' ? ' disabled' : ''}>Nhập từ HQ</button>`
          : ''}
      </div>

      ${renderHqReview()}

      <div class="chiprow pchips" role="group" aria-label="Lọc theo loại súng">${chips}</div>

      ${sections.length ? sections.map((s) => `<section class="card">
        <div class="card-hd"><h3>${esc(s.label)}</h3><span class="muted">${s.rows.length} mã</span></div>
        <div class="pgrid">${s.rows.map(({ preset, meta }) => {
          const cost = costFor(preset);
          /* A measured cost always wins; HQ's figure only fills an empty row. */
          const hq = cost.value ? null : hqPriceFor(preset);
          const editing = costEdit.code === preset.code;
          return `<div class="pcard${cost.state === 'disputed' ? ' pc-disputed' : ''}">
          <div class="pc-hd">
            <b${shortWeapon(meta) !== meta.weapon ? ` title="${esc(meta.weapon)}"` : ''}>${esc(shortWeapon(meta))}</b>
            ${preset.label ? `<span class="pc-label" title="${esc(preset.label)}">${esc(preset.label)}</span>` : ''}
            ${preset.verified ? '<span class="tag ok" title="Đã kiểm tra">✓</span>' : ''}
          </div>
          ${meta.raw ? `<div class="pc-raw muted" title="Người gửi ghi: ${esc(meta.raw)}">ghi: ${esc(meta.raw)}</div>` : ''}
          <code class="mono pc-code">${esc(preset.code)}</code>
          <div class="pc-act">
            <div class="pc-meta">
              <span class="pc-mode ${modeTone(preset.mode)}">${esc(canonicalMode(preset.mode))}</span>
              ${preset.author && preset.author !== 'bundled' ? `<span class="muted pc-by" title="${esc(preset.author)}">${esc(preset.author)}</span>` : ''}
            </div>
            <div class="pc-ft">
              <button class="act tiny" data-act="row-copy" data-code="${esc(preset.code)}" aria-label="Copy preset ${esc(preset.code)}">Copy</button>
            </div>
          </div>

          ${editing ? `<div class="pc-costedit">
            <label class="fld"><span>Chi phí trang bị · Chiến Dịch</span>
              <input class="costin mono" inputmode="numeric" value="${esc(costEdit.value)}"
                placeholder="ví dụ 295426 hoặc 290K" aria-label="Chi phí trang bị"></label>
            <div class="btnrow tight">
              <button class="act tiny primary" data-act="cost-save" data-code="${esc(preset.code)}">Lưu</button>
              <button class="act tiny ghost" data-act="cost-cancel">Thôi</button>
            </div>
            <p class="muted tiny cost-hint">Chỉ áp cho build Chiến Dịch này. Số được đối chiếu theo mã build, không theo tên súng.</p>
            ${costEdit.error ? `<p class="bad tiny">${esc(costEdit.error)}</p>` : ''}
          </div>` : costEligible(preset) ? `<div class="pc-cost ${cost.value ? 'has' : hq ? 'hq' : 'none'}">
            <span class="pc-cost-label" title="Chi phí trang bị ở Chiến Dịch">Chi phí</span>
            <b class="pc-cost-val mono"${hq ? ` title="${esc(hqPriceHint(hq))}"` : ''}>${cost.value ? esc(Costs.formatCost(cost.value)) : hq ? `≈ ${esc(Costs.formatCost(hq.price))}` : '—'}</b>
            ${cost.value ? `<span class="cost-state cs-${esc(cost.state)}" title="${esc(cost.hint)}">${esc(cost.label)}</span>`
              : hq ? `<span class="cost-state cs-hq" title="${esc(hqPriceHint(hq))}">Giá HQ</span>` : ''}
            <button class="act tiny ghost pc-cost-edit" data-act="cost-edit" data-code="${esc(preset.code)}"
              aria-label="${cost.value ? 'Sửa' : 'Thêm'} chi phí trang bị cho preset ${esc(preset.code)}"
              title="${cost.value ? 'Sửa chi phí build Chiến Dịch này' : 'Áp preset trong game rồi nhập chi phí Chiến Dịch'}">${cost.value ? 'Sửa' : '+ Thêm'}</button>
          </div>` : `<div class="pc-cost pc-cost-na" title="Chiến Trường Toàn Diện phát sẵn trang bị, nên build này không có chi phí">
            <span class="pc-cost-label">Chi phí</span><span class="muted pc-cost-na-text">Miễn phí</span>
          </div>`}
        </div>`;
        }).join('')}</div>
      </section>`).join('')
      : `<div class="empty"><div class="ei">⌖</div><p>${all.length
        ? 'Không có preset nào khớp bộ lọc.'
        : 'Chưa có code súng nào.'}</p>${all.length
        ? '<button class="act tiny ghost" data-act="pclear">Xoá lọc</button>'
        : ''}</div>`}
    </div>`;

    const pq = viewHost.querySelector('.pq');
    if (pq) {
      pq.addEventListener('input', () => { presetFilter.q = pq.value; renderPresets(); });
      /* Re-focus after the re-render so typing is not interrupted. */
      if (presetFilter.q) {
        pq.focus();
        /* Guarded: setSelectionRange is absent on some input types and on
         * non-browser DOM stubs, and losing the caret must never break render. */
        if (typeof pq.setSelectionRange === 'function') {
          pq.setSelectionRange(pq.value.length, pq.value.length);
        }
      }
    }
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
          <textarea class="share-gift" rows="7" aria-label="Danh sách mã quà để chia sẻ" readonly>${esc(gifts.map((r) => r.code).join('\n'))}</textarea>
          <div class="btnrow">
            <button class="act" data-act="share-copy-gift" aria-label="Copy danh sách gift code">Copy</button>
            <button class="act" data-act="share-txt-gift" aria-label="Tải gift code dạng .txt">Tải .txt</button>
            <button class="act" data-act="share-csv-gift" aria-label="Tải gift code dạng .csv">Tải .csv</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-hd"><h3>Preset Gunsmith</h3><span class="muted">${presets.length} mã</span></div>
        <p class="muted tight">Định dạng <code class="mono">Súng-Chế độ-Mã</code> để người nhận biết dán vào đâu.</p>
        <div class="sharebox">
          <textarea class="share-preset" rows="7" aria-label="Danh sách preset Gunsmith để chia sẻ" readonly>${esc(presets.map((r) => `${r.weapon || r.gun || '?'}-${r.mode || '?'}-${r.code}`).join('\n'))}</textarea>
          <div class="btnrow">
            <button class="act" data-act="share-copy-preset" aria-label="Copy danh sách preset Gunsmith">Copy</button>
            <button class="act" data-act="share-txt-preset" aria-label="Tải preset Gunsmith dạng .txt">Tải .txt</button>
            <button class="act" data-act="share-csv-preset" aria-label="Tải preset Gunsmith dạng .csv">Tải .csv</button>
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
      ${mirror.state === 'gone' ? `<div class="bulk warn" data-mirror="gone" role="status">
        <span><b>Extension vừa được tải lại hoặc cập nhật.</b> Trang này đã mất kết nối với extension nên không đọc được lịch sử từ bề mặt kia. Tải lại trang để kết nối lại.</span>
        <span class="spacer"></span>
        <button class="act tiny" data-act="reload-page">Tải lại trang</button>
      </div>` : ''}
      ${mirror.state === 'error' ? `<div class="bulk warn" data-mirror="error" role="status">
        <span>Không đọc được lịch sử từ bề mặt kia (${esc(mirror.error)}). Các lượt chạy ở đó có thể đang thiếu.</span>
        <span class="spacer"></span>
        <button class="act tiny" data-act="refresh">Thử lại</button>
      </div>` : ''}
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

  let navSeq = 0;
  async function go(name) {
    if (!VIEWS.includes(name)) name = 'dashboard';
    view = name;
    store.set('view', name);
    $$('.vtab').forEach((b) => {
      const on = b.dataset.view === name;
      b.classList.toggle('on', on);
      /* role="tab" without aria-selected tells a screen reader there are six
       * tabs and none of them is current. Roving tabindex keeps Tab moving
       * past the strip in one press instead of six. */
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    /* Every view paints into this one element, so the offset of the view we
     * just left survives into the next: leaving Kho code halfway down opened
     * Tổng quan already scrolled past its KPIs. Reset before the await, not
     * after — refresh() reads the vault and a slow read would otherwise leave
     * the outgoing view sitting at the old offset until it resolves. */
    viewHost.scrollTop = 0;
    /* The HQ review belongs to the Preset view; leaving it drops the frame and
     * any fetch still in flight, so a late reply cannot paint over another tab. */
    if (name !== 'presets' && hqReview) { hqReview = null; hqSeq += 1; }
    const seq = ++navSeq;
    await refresh();
    /* Two quick switches can resolve out of order; only the latest may paint,
     * or the first view lands last under the second tab. */
    if (seq !== navSeq) return;
    RENDER[name]();
    viewHost.scrollTop = 0;
    renderFooter();
    renderBadges();
    /* app.html mirrors this view from outside the shadow root. Navigation
     * starts in many places (row history, bulk queue, Alt+1–6, the dashboard
     * shortcuts), so report the view that actually painted — a superseded
     * go() never reaches this line — instead of letting the host guess. */
    if (typeof opts.onView === 'function') {
      try { opts.onView(name); } catch (_) { /* a host hook must not break the view */ }
    }
  }

  /* Move focus to a control the panel just rendered. The page host cannot see
   * focus inside the hidden drawer, so it is told which control to focus on
   * its own copy of the view. */
  function focusInView(el, select) {
    if (!el) return undefined;
    if (el.focus) el.focus();
    if (select && el.select) el.select();
    if (typeof opts.onFocus === 'function') {
      try { opts.onFocus(el, !!select); } catch (_) { /* host hook */ }
    }
    return undefined;
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
      { label: 'Đồng bộ ngay', hint: 'Sao lưu kho lên đám mây', icon: '☁', run: () => syncNowManual() },
      { label: 'Tải lại dữ liệu', hint: 'Đọc lại từ kho', icon: '⟳', run: () => go(view) },
      { label: 'Đưa mã chưa thử vào hàng chờ', hint: untriedCodes().length + ' mã', icon: '▶',
        run: async () => { store.set('queue', untriedCodes().map((r) => r.code).join('\n')); await go('run'); } },
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

  shell.addEventListener('keydown', (e) => {
    /* A roving-tabindex tablist owes the user arrow keys: Tab now reaches the
     * strip once, so without this the other five views are keyboard-dead. */
    const tab = e.target.closest ? e.target.closest('.vtab') : null;
    if (!tab) return;
    const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
    const move = keys[e.key];
    if (move === undefined) return;
    e.preventDefault();
    const at = VIEWS.indexOf(tab.dataset.view);
    const to = move === 'first' ? 0
      : move === 'last' ? VIEWS.length - 1
        : (at + move + VIEWS.length) % VIEWS.length;
    historyCode = null;
    go(VIEWS[to]).then(() => {
      const next = $(`.vtab[data-view="${VIEWS[to]}"]`);
      if (next) next.focus();
    });
  });

  shell.addEventListener('click', async (e) => {
    const tab = e.target.closest ? e.target.closest('.vtab') : null;
    if (tab) { historyCode = null; return go(tab.dataset.view); }

    const btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'palette') return openPalette();
    if (act === 'sync-now') return syncNowManual();
    if (act === 'refresh') { await go(view); return toast('Đã tải lại.', 'ok'); }
    if (act === 'goto-run') { historyCode = null; return go('run'); }
    if (act === 'goto-share') return go('share');
    if (act === 'goto-history') { historyCode = null; return go('history'); }
    if (act === 'hist-all') { historyCode = null; return go('history'); }
    if (act === 'open-redeem') { location.href = 'https://redeem.df.garena.sg/vi/cdkgarena.html'; return; }
    /* Reloading kills a run in flight, and its unfinished codes would read as
     * never tried, so refuse until it ends instead of dropping it silently. */
    if (act === 'reload-page') {
      if (activeRun) return toast('Đang có lượt chạy — dừng hoặc chờ xong rồi hãy tải lại trang.', 'warn');
      location.reload();
      return;
    }

    /* library */
    if (act === 'fchip') { libFilter.status = btn.dataset.k; libPage = 0; return renderLibrary(); }
    if (act === 'fclear') { libFilter = { status: 'all', q: '', sort: libFilter.sort }; libPage = 0; return renderLibrary(); }
    /* presets */
    if (act === 'pchip') {
      /* The full-page app replays a click from a cloned card back into this
       * shadow tree. Multiple chips share data-act, so code-only matching always
       * selected the FIRST chip ("Tất cả") and made every filter look dead.
       * Match its class key too, then render the same state the user clicked. */
      presetFilter.cls = btn.dataset.k || 'all';
      return renderPresets();
    }
    if (act === 'pclear') { presetFilter = { cls: 'all', q: '' }; return renderPresets(); }
    /* HQ review — picks live in hqReview, never in checkbox DOM state */
    if (act === 'hq-import') return openHqReview();
    if (act === 'hq-close') { hqReview = null; hqSeq += 1; return renderPresets(); }
    if (act === 'hq-toggle') {
      const code = btn.dataset.code;
      if (!hqReview || hqReview.state !== 'ready' || hqReview.saving || !code || hqReview.known.has(code)) return undefined;
      if (hqReview.picked.has(code)) hqReview.picked.delete(code); else hqReview.picked.add(code);
      renderPresets();
      /* The repaint replaces the button; put focus back on its replacement so
       * a keyboard user can keep walking the list with Tab/Space. */
      focusInView($(`[data-act="hq-toggle"][data-code="${code}"]`));
      return undefined;
    }
    if (act === 'hq-pick-all' || act === 'hq-pick-none') {
      if (!hqReview || hqReview.state !== 'ready' || hqReview.saving) return undefined;
      hqReview.picked = act === 'hq-pick-all'
        ? new Set(hqReview.items.filter((i) => !hqReview.known.has(i.code)).map((i) => i.code))
        : new Set();
      renderPresets();
      focusInView($(`[data-act="${act}"]`));
      return undefined;
    }
    if (act === 'hq-commit') return importHqPicked();
    /* cost editing — one card at a time, see costEdit */
    if (act === 'cost-edit') {
      const code = btn.dataset.code;
      const current = costFor({ code, cost: 0 });
      costEdit = { code, value: current.value ? String(current.value) : '', error: '' };
      renderPresets();
      /* Focus after render so the user can type straight away; without this the
       * button keeps focus and the first keystroke goes nowhere. */
      focusInView($('.pc-costedit .costin'), true);
      return undefined;
    }
    if (act === 'cost-cancel') { costEdit = { code: null, value: '', error: '' }; return renderPresets(); }
    if (act === 'cost-save') return saveCost(btn.dataset.code);
    if (act === 'pg-prev') { libPage = Math.max(0, libPage - 1); return renderLibrary(); }
    if (act === 'pg-next') { libPage += 1; return renderLibrary(); }
    if (act === 'row-copy') return copy(btn.dataset.code, 'mã ' + btn.dataset.code);
    if (act === 'row-hist') { historyCode = btn.dataset.code; return go('history'); }
    if (act === 'bulk-clear') { selection.clear(); return renderLibrary(); }
    if (act === 'bulk-copy') return copy([...selection].join('\n'), selection.size + ' mã');
    if (act === 'bulk-queue') {
      const picked = [...selection];
      /* Store first: renderRun fills the queue from the store, so the Run view
       * paints with the picked codes already in it. Filling the field after
       * go() left any copy of the view taken at paint time empty. */
      store.set('queue', picked.join('\n'));
      await go('run');
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
        csvOf(cache.presets, ['code', 'weapon', 'mode', 'label', 'format', 'source']),
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
    /* Local costs before the first paint, so a pending value the user typed last
     * session is on screen immediately instead of appearing after the pull. */
    await loadLocalCosts();
    await syncCommunityVault({ pull: true, push: false });
    await go(view);
  }
  function closePanel() { shell.hidden = true; launcher.hidden = false; }
  function mountLauncher() { mountHost(); launcher.hidden = false; }

  $('.close').addEventListener('click', closePanel);
  launcher.addEventListener('click', open);
  /* app.html keeps this shell mounted inside a display:none host and shows a
   * copy of the view, so the palette and the open/close keys would act on a
   * shell nobody can see — and Ctrl+K would still eat the browser's own search
   * shortcut. There only the view keys (Alt+1–6) mean anything. */
  const embedded = surface === 'page';
  document.addEventListener('keydown', (e) => {
    if (!embedded && (e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      if (e.preventDefault) e.preventDefault();
      if (shell.hidden) open();
      return paletteOpen ? closePalette() : openPalette();
    }
    if (!embedded && e.altKey && (e.key === 'd' || e.key === 'D')) {
      if (e.preventDefault) e.preventDefault();
      return shell.hidden ? open() : closePanel();
    }
    if (shell.hidden) return;
    if (!embedded && e.key === 'Escape') return paletteOpen ? closePalette() : closePanel();
    if (e.altKey && /^[1-6]$/.test(e.key)) { historyCode = null; go(VIEWS[Number(e.key) - 1]); }
  });

  async function setSyncChip(known) {
    const chip = $('.sync-chip');
    if (!chip || !opts.sync || !opts.sync.status) { if (chip) chip.hidden = true; return; }
    try {
      const s = known && known.state ? known : await opts.sync.status();
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
    refreshSync: () => setSyncChip(),
    getStats: () => cache.stats,
    getResults: () => cache.codes.slice(),
    vault, surface,
    _host: host, _shadow: shadow, _views: VIEWS, _shell: shell,
  };
}


  const VIEWS = ['dashboard', 'library', 'run', 'presets', 'share', 'history'];
  const LABELS = { dashboard: 'Tổng quan', library: 'Kho code', run: 'Chạy đổi', presets: 'Preset Gunsmith', share: 'Chia sẻ', history: 'Lịch sử' };
  const ICONS = { dashboard: '◈', library: '▤', run: '▶', presets: '⌖', share: '↗', history: '◷' };
  const HINTS = {
    dashboard: 'Tình trạng toàn bộ kho code',
    library: 'Tìm, lọc và xem lịch sử từng mã',
    run: 'Đổi hàng loạt — cần mở trên trang Garena',
    presets: 'Preset Gunsmith cho mọi chế độ chơi',
    share: 'Xuất danh sách cho người khác',
    history: 'Mọi lần thử đã ghi lại',
  };

  /* The page lives on chrome-extension://, so its IndexedDB is a different
   * origin's store than the drawer's. Pass the sync bridge so History can merge
   * the runs the drawer mirrored into shared storage. */
  const sync = {
    readMirror: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'readMirror' }),
    /* The sync chip reads this; without it the guard in panel.js hides the
     * chip, so the app looked permanently unsynced. */
    status: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'status' }),
    /* The app cannot drive the Garena form, but History here can still finish a
     * run mirrored from the drawer, and that path snapshots the personal vault.
     * Leaving these off made the panel skip personal sync with no message. */
    getSettings: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'getSettings' }),
    syncNow: (records) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'push', payload: { records: (records || []).map((r) => ({ code: r.code, status: r.status, last_tried: r.last_tried })) } }),
    mirrorAttempts: (rows) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'mirrorAttempts', payload: { rows } }),
    communityPull: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'communityPull' }),
    fetchCosts: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'fetchCosts' }),
    reportCost: (code, cost, mode) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'reportCost', payload: { code, cost, mode } }),
    getLocal: (key) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'getPanelState', payload: { key } }).then((r) => (r && r.ok ? r.value : null)),
    setLocal: (key, value) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'setPanelState', payload: { key, value } }),
    communityPush: (rows) => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'communityPush', payload: { rows } }),
    hqFetch: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'hqFetch' }),
    hqReadPrices: () => chrome.runtime.sendMessage({ type: 'DF_REDEEM_SYNC', op: 'hqReadPrices' }),
  };
  const panel = createPanel({
    version: '3.3.7', target: 'page', surface: 'page', sync,
    /* The page always opens on Tổng quan. Passing it here, instead of calling
     * show('dashboard') once open() resolved, lets a tab the user clicked while
     * the vault was still loading win: that late call used to overwrite it. */
    initialView: 'dashboard',
    /* The drawer shell is mounted display:none below, which hides its shadow
     * toast stack too. Copy/save feedback must land in this page instead. */
    toastHost: document.getElementById('toasts'),
    /* The view below is a clone, refreshed right after each click. The HQ
     * review repaints seconds later when the fetch or the import finishes, so
     * the panel calls back and the visible clone is replaced then. */
    onRepaint: (name) => {
      const on = document.querySelector('.side-nav .on');
      if (on && on.dataset.view === name) recloneView();
    },
    /* Navigation starts in many places — a Library row's history button, bulk
     * queue, Alt+1–6, the dashboard shortcuts — and the panel names the view
     * that actually painted, so the page title and nav never have to guess. */
    onView: (name) => mirrorView(name),
    /* Focus the panel moves (into the cost field, back onto an HQ pick) lands
     * on this page's copy of the control after the next repaint. */
    onFocus: (el, select) => { pendingFocus = { id: identify(el), select }; },
  });
  const host = document.getElementById('page-view');
  const nav = document.querySelector('.side-nav');
  /* The view this page is showing, set only once it has painted, and a focus
   * request from the panel that waits for the next copy of the view. */
  let shownView = null;
  let pendingFocus = null;

  /* Every form control below is a clone; its drawer original is what the panel
   * reads. Pair them by first class plus the code of the row the control sits
   * in. Class alone is not an identity: every Library row checkbox is .pick, so
   * a class-only lookup replayed a tick on row 3 onto row 1 and the bulk
   * actions then queued a code the user never picked. */
  const firstClass = (el) => String((el && el.className) || '').trim().split(' ')[0];
  function controlKey(el) {
    const row = el.closest('[data-code]');
    return { cls: firstClass(el), code: row ? row.dataset.code : null };
  }
  function findControl(root, key) {
    if (!root || !key || !/^[a-z][a-z0-9-]*$/i.test(key.cls)) return null;
    const all = root.querySelectorAll('.' + key.cls);
    for (let i = 0; i < all.length; i++) {
      const row = all[i].closest('[data-code]');
      if ((row ? row.dataset.code : null) === key.code) return all[i];
    }
    return null;
  }
  const drawerView = () => panel._shadow.querySelector('.view-host');

  /* Fields that hold a caret. A checkbox or a select has none to lose. */
  const holdsCaret = (el) => el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/.test(el.type));

  /* What the user is on, in a form that survives a repaint. A button is named
   * by the fields that route its click — the first class of a button is just
   * "act", shared by every button in a card — and any other control by
   * controlKey. */
  const actionSelector = (btn) => '[data-act="' + btn.dataset.act + '"]'
    + (btn.dataset.code ? '[data-code="' + btn.dataset.code + '"]' : '')
    + (btn.dataset.k ? '[data-k="' + btn.dataset.k + '"]' : '');
  function identify(el) {
    if (!el) return null;
    return el.dataset && el.dataset.act ? { sel: actionSelector(el) } : controlKey(el);
  }
  function locate(root, id) {
    if (!root || !id) return null;
    return id.sel ? root.querySelector(id.sel) : findControl(root, id);
  }

  /* A repaint swaps the whole view for a fresh copy of the drawer's render. The
   * field under the user's caret is carried across as the same node instead of
   * a copy: Chrome keeps a text control's own caret, selection and IME state on
   * the element and restores them on focus(), which no copy can reproduce. A
   * script cannot even place the caret in a number input, where
   * setSelectionRange throws, so a fresh copy there typed every digit at the
   * front. Any other focused control gets focus on its copy, unless the panel
   * asked for focus somewhere else (the cost field it just opened). */
  function recloneView() {
    const rendered = panel._shadow.querySelector('.view-host .pad');
    if (!rendered) return;
    const fresh = rendered.cloneNode(true);
    const active = document.activeElement;
    const inView = active && active !== document.body && host.contains(active);
    const key = inView ? controlKey(active) : null;
    const was = inView ? identify(active) : null;
    if (key && holdsCaret(active)) {
      const spot = findControl(fresh, key);
      if (spot) spot.replaceWith(active);
    }
    host.innerHTML = '';
    host.appendChild(fresh);
    const want = pendingFocus || (was ? { id: was, select: false } : null);
    pendingFocus = null;
    const back = want && locate(host, want.id);
    if (back && typeof back.focus === 'function') {
      back.focus({ preventScroll: true });
      if (want.select && typeof back.select === 'function') back.select();
    }
  }
  /* Every drawer render is synchronous, so the copy can be taken in the same
   * turn, right after the handler that painted it. A timer was used before and
   * Chrome stretches timers in a background tab from 20ms to a second, which
   * left the page showing the old view for that long. Repaints requested in one
   * turn — a replayed keystroke and the mutations it caused — coalesce. */
  let repaintQueued = false;
  function scheduleReclone() {
    if (repaintQueued) return;
    repaintQueued = true;
    queueMicrotask(() => { repaintQueued = false; recloneView(); });
  }

  nav.innerHTML = VIEWS.map((v) =>
    '<button data-view="' + v + '"><span class="vi">' + ICONS[v] + '</span>' + LABELS[v] + '</button>').join('');

  /* The drawer renders into its own shadow root; this page shows a copy so
   * both surfaces share one renderer. The panel calls this (onView) each time
   * a view finishes painting, whoever started the navigation. */
  function mirrorView(name) {
    const changed = name !== shownView;
    shownView = name;
    if (changed) {
      /* A different view starts at its top, as it does in the drawer. Nothing
       * of the old view's focus or scroll offset belongs to the new one. */
      const rendered = panel._shadow.querySelector('.view-host .pad');
      host.innerHTML = '';
      if (rendered) host.appendChild(rendered.cloneNode(true));
      const want = pendingFocus;
      pendingFocus = null;
      const target = want && locate(host, want.id);
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
      if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
    } else {
      recloneView();
    }
    document.querySelector('.page-title').textContent = LABELS[name];
    document.querySelector('.page-hint').textContent = HINTS[name];
    Array.prototype.forEach.call(nav.children, (b) => b.classList.toggle('on', b.dataset.view === name));
    const untried = panel.getResults().filter((r) => r.status === 'untried').length;
    const runBtn = nav.querySelector('[data-view="run"]');
    const old = runBtn.querySelector('.badge');
    if (old) runBtn.removeChild(old);
    if (untried) {
      const s = document.createElement('span');
      s.className = 'badge'; s.textContent = String(untried);
      runBtn.appendChild(s);
    }
  }
  /* Navigate the way the drawer does — through its own tab — so the page gets
   * the same semantics, such as dropping a single-code History filter. */
  function show(name) {
    const tab = panel._shadow.querySelector('.vtab[data-view="' + name + '"]');
    if (tab) tab.click(); else panel.go(name);
  }

  /* Views also repaint on their own: a filter chip, the History rows that
   * arrive from the drawer's mirror after the first paint, a sync status line.
   * Copy every repaint of the drawer view instead of guessing when one is due;
   * the old fixed 30ms re-render raced async handlers and undid navigation. */
  const drawerHost = panel._shadow.querySelector('.view-host');
  if (typeof MutationObserver === 'function' && drawerHost) {
    new MutationObserver(() => {
      /* Mid-navigation the drawer's tab already names the next view while the
       * old one is still on screen; that view's own paint arrives via onView. */
      const tab = panel._shadow.querySelector('.vtab.on');
      if (!tab || tab.dataset.view === shownView) scheduleReclone();
    }).observe(drawerHost, { childList: true, subtree: true, characterData: true });
  }

  /* Clicks inside the cloned view are replayed onto the real (shadow) node so
   * every handler stays in one place. Whatever the handler paints next comes
   * back through the observer above, or through onView when it navigates. */
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'open-redeem') { window.open('https://redeem.df.garena.sg/vi/cdkgarena.html', '_blank'); return; }
    /* Most actions are unique. Filter chips are not: all carry data-act="pchip"
     * and differ by data-k. Preserve every identity field that affects dispatch;
     * otherwise the cloned page always replays a chip click onto the first
     * shadow button ("Tất cả"), so the visible filter never changes. */
    const twin = panel._shadow.querySelector(actionSelector(btn));
    if (twin) twin.click();
  });
  /* Typing is copied onto the drawer original, whose handlers re-render the
   * view, and the clone is refreshed from that render. Checkboxes and selects
   * fire input too, but they are replayed once, on change, below. A field in
   * the middle of an IME composition is left alone until the composition ends,
   * so a repaint cannot cut a syllable in half. */
  function replayInput(target) {
    if (!target || target.type === 'checkbox' || target.type === 'radio' || target.tagName === 'SELECT') return;
    const twin = findControl(drawerView(), controlKey(target));
    if (!twin || !('value' in twin)) return;
    twin.value = target.value;
    twin.dispatchEvent(new Event('input', { bubbles: true }));
    scheduleReclone();
  }
  host.addEventListener('input', (e) => { if (!e.isComposing) replayInput(e.target); });
  host.addEventListener('compositionend', (e) => replayInput(e.target));
  /* change is how a checkbox toggles and a select picks. Text fields fire it as
   * well, on blur, and a repaint that removes the focused field counts as a
   * blur. Their value already went across on input; replaying it again
   * repainted a second time without restoring focus, so typing stopped after
   * the first character. */
  host.addEventListener('change', (e) => {
    const t = e.target;
    const toggles = t.type === 'checkbox' || t.type === 'radio';
    if (!toggles && t.tagName !== 'SELECT') return;
    const twin = findControl(drawerView(), controlKey(t));
    if (!twin) return;
    if (toggles) twin.checked = t.checked;
    else twin.value = t.value;
    twin.dispatchEvent(new Event('change', { bubbles: true }));
    scheduleReclone();
  });

  nav.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) show(b.dataset.view);
  });
  /* The drawer's own refresh: re-reads the vault and says so in a toast. */
  document.getElementById('p-refresh').addEventListener('click', () => {
    const btn = panel._shadow.querySelector('.hd [data-act="refresh"]');
    if (btn) btn.click(); else show(shownView || 'dashboard');
  });
  /* The drawer is display:none on this page, so its own header button is not
   * reachable. Route the page button to the same action. */
  document.getElementById('p-sync').addEventListener('click', () => {
    const btn = panel._shadow.querySelector('.hd [data-act="sync-now"]');
    if (btn) btn.click();
  });
  document.getElementById('open-redeem').addEventListener('click', () => window.open('https://redeem.df.garena.sg/vi/cdkgarena.html', '_blank'));
  document.getElementById('open-options').addEventListener('click', () => { if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage(); });

  /* mount the hidden drawer shell so its renderers have a document. open()
   * paints initialView (Tổng quan) unless the user already picked a tab. */
  document.documentElement.appendChild(panel._host);
  panel._host.style.display = 'none';
  panel.open();
}());
