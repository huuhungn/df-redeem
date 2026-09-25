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
      await this.seedOnFirstRun();
      return this;
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
      const merged = Schema.codeRecord({ ...existing, ...raw, code: normalized.code, kind: 'giftcode' }, now);
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
      const timestamp = raw.timestamp || raw.at || this.clock();
      const status = STATUSES.includes(String(raw.status || '').toLowerCase()) ? String(raw.status).toLowerCase() : existing.status;
      const updated = Schema.codeRecord({
        ...existing,
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
if (typeof module !== 'undefined' && module.exports) module.exports = DFRedeemVault;
