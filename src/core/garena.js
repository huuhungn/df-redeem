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
  400067: { status: 'LIMIT_REACHED', label: 'Đã nhận nhóm này', detail: 'Tài khoản đã đạt giới hạn nhận của nhóm code này.' },
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
};

/** Statuses that mean "stop the whole run, a human must act". */
const FATAL = new Set(['NOT_LOGGED_IN', 'VERIFY', 'SCRIPT_ERROR']);
/** Statuses worth retrying the same code later. */
const RETRYABLE = new Set(['TEMP_ERROR', 'RATE_LIMITED', 'NO_RESPONSE', 'NETWORK']);
/** Statuses where trying an OCR variant makes sense. */
const VARIANT_WORTHY = new Set(['INVALID']);
/** Statuses that prove the code itself is real, even if we gained nothing. */
const CODE_IS_REAL = new Set(['SUCCESS', 'LIMIT_REACHED', 'EXPIRED', 'USED', 'PRESENT_ERROR', 'REGION']);

const STATUS_LABELS = {
  SUCCESS: 'Thành công',
  LIMIT_REACHED: 'Đã nhận nhóm này',
  EXPIRED: 'Hết hạn',
  USED: 'Đã dùng',
  PRESENT_ERROR: 'Lỗi quà',
  INVALID: 'Không hợp lệ',
  REGION: 'Sai khu vực',
  VERIFY: 'Cần xác minh (captcha)',
  NOT_LOGGED_IN: 'Chưa đăng nhập',
  RATE_LIMITED: 'Bị siết tốc độ',
  TEMP_ERROR: 'Lỗi tạm thời',
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
  LIMIT_REACHED: 'mine',      /* the account already holds this reward group */
  USED: 'mine',               /* 400069 is this account's prior redemption, not global exhaustion */
  EXPIRED: 'expired',
  PRESENT_ERROR: 'gift_bug',
  INVALID: 'invalid',
  REGION: 'invalid',          /* unusable for this account's server */
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
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
}(typeof window !== 'undefined' ? window : globalThis));
