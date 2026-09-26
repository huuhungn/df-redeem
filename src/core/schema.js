/* schema.js — IndexedDB schema, record normalization, and migrations. */
var DFRedeemSchema = (function dfRedeemSchemaModule(root) {
  'use strict';

  const DB_NAME = 'df-redeem-vault';
  const DB_VERSION = 4;
  const STORES = Object.freeze({
    codes: 'codes',
    runs: 'runs',
    results: 'results',
    presets: 'presets',
    meta: 'meta',
  });
  const KINDS = Object.freeze(['giftcode', 'preset']);
  const STATUSES = Object.freeze(['untried', 'success', 'expired', 'exhausted', 'mine', 'gift_bug', 'invalid']);
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
     * legacy 400069 rows that older builds called `exhausted`. */
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
if (typeof module !== 'undefined' && module.exports) module.exports = DFRedeemSchema;
