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
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
}(typeof window !== 'undefined' ? window : globalThis));
