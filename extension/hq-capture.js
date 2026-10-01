/* hq-capture.js — MAIN world on the Delta Force HQ page.
 * Reads build prices out of DfTools/ListGunCodeSchemes replies the page already
 * received. The request is never read, stored or forwarded: its query string
 * and body carry the player's HQ openid/token. Only { code, price } pairs that
 * pass hq.js's checks leave this script. */
(function tapHqPrices() {
  'use strict';
  const scope = {};
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
  }(scope));

  const HQ = scope.DFRedeemHQ;
  const ENDPOINT = /\/DfTools\/ListGunCodeSchemes(?:[?#]|$)/;
  const isSchemeList = (url) => {
    try { return ENDPOINT.test(String(url == null ? '' : url)); } catch (_) { return false; }
  };
  const forward = (body) => {
    const prices = HQ.sanitizePrices(body);
    const items = Object.keys(prices).map((code) => ({ code, price: prices[code] }));
    if (items.length) window.postMessage({ channel: 'df-redeem-hq-prices', items }, window.location.origin);
  };
  const forwardText = (text) => {
    let body;
    try { body = JSON.parse(text); } catch (_) { return; }
    forward(body);
  };

  /* Marked requests live in a WeakSet so nothing is written onto the page's
   * own XHR objects, and the URL is only tested, never kept. */
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR && typeof XHR.open === 'function' && typeof XHR.send === 'function') {
    const marked = new WeakSet();
    const open = XHR.open;
    const send = XHR.send;
    XHR.open = function (method, url) {
      if (isSchemeList(url)) marked.add(this); else marked.delete(this);
      return open.apply(this, arguments);
    };
    XHR.send = function () {
      if (marked.has(this)) {
        const xhr = this;
        xhr.addEventListener('loadend', () => {
          try {
            if (xhr.status !== 200) return;
            if (xhr.responseType === 'json') forward(xhr.response);
            else if (xhr.responseType === '' || xhr.responseType === 'text') forwardText(xhr.responseText);
          } catch (_) { /* never break the page over a price */ }
        }, { once: true });
      }
      return send.apply(this, arguments);
    };
  }

  const pageFetch = window.fetch;
  if (typeof pageFetch === 'function') {
    window.fetch = function (input) {
      const pending = pageFetch.apply(this, arguments);
      let hit = false;
      try { hit = isSchemeList(input && typeof input === 'object' && 'url' in input ? input.url : input); } catch (_) {}
      if (hit) {
        pending.then((res) => {
          if (res && res.ok && typeof res.clone === 'function') res.clone().text().then(forwardText, () => {});
        }, () => {});
      }
      return pending;
    };
  }
}());
