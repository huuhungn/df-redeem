/* worker/src/index.js — submission broker for the community code vault.
 *
 * Why this exists: the extension must never hold a GitHub token (extension source
 * is readable by every user, so a write-scoped token would leak immediately). The
 * token lives here as a Worker secret and never crosses the wire to a client.
 *
 * The Worker is a *queue*, not a database. The repository stays the source of
 * truth; KV only holds submissions waiting for enough confirmations. Wiping KV
 * loses nothing that matters.
 *
 * Endpoints
 *   GET  /health            liveness plus queue size
 *   POST /submit            report one redeem outcome     { code, err_code, msg }
 *   GET  /pending           promoted rows the Action commits (needs ADMIN_TOKEN)
 *   POST /ack               drop rows the Action committed (needs ADMIN_TOKEN)
 */

/* Garena gift codes are uppercase alphanumerics. Anything else is either a typo
 * or an injection attempt and is rejected before it can reach KV. */
const CODE_RE = /^[A-Z0-9]{6,32}$/;

/* Verdicts a client may report, mapped from Garena's own error numbers. A client
 * cannot invent a status string — it reports err_code and the Worker decides. */
import { VERDICT_BY_ERR, PER_ACCOUNT, TRANSIENT } from './verdicts.js';

/* Verdicts that may appear in the published file. 'exhausted' has no err_code
 * mapped to it any more (400073 is gift_bug, per garena.js) but rows carrying it
 * exist in the seed, so it stays readable — it simply cannot be newly submitted. */
const PUBLISHABLE = new Set(['success', 'expired', 'invalid', 'exhausted', 'gift_bug']);

/* A code is promoted once this many *independent* clients agree on a verdict.
 * One hostile client cannot inject anything; it can only report about itself. */
const CONFIRMATIONS_REQUIRED = 2;

const MAX_SUBMITS_PER_WINDOW = 120;
/* A full vault is a few hundred rows; anything beyond this is not a real client. */
const MAX_BATCH_ROWS = 500;
const RATE_WINDOW_SECONDS = 3600;
/* Queue rows expire so an abandoned code never lingers forever. */
const PENDING_TTL_SECONDS = 60 * 60 * 24 * 30;

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  /* Extension pages and the Garena redeem page are the only legitimate callers,
   * but an extension origin is a per-install UUID, so an allowlist is impossible.
   * Reads are public data and writes carry no credential and no cookie, so an
   * open CORS policy costs nothing here — there is no ambient authority to abuse.
   * Requests are still gated by format validation and per-IP rate limiting. */
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, init, extra) =>
  new Response(JSON.stringify(body), {
    status: (init && init.status) || 200,
    headers: { ...JSON_HEADERS, ...(extra || {}) },
  });

/* Salted hash of the caller IP. Used only to count independent reporters and to
 * rate-limit; it is never stored alongside the code in the repo and cannot be
 * reversed to an address without the secret salt. */
async function clientFingerprint(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const salt = env.IP_SALT || 'df-redeem-unsalted';
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function rateLimited(env, fingerprint) {
  const key = `rate:${fingerprint}`;
  const current = Number((await env.VAULT.get(key)) || 0);
  if (current >= MAX_SUBMITS_PER_WINDOW) return true;
  await env.VAULT.put(key, String(current + 1), { expirationTtl: RATE_WINDOW_SECONDS });
  return false;
}

/* Classify and record one verdict. Shared by /submit and /submit-batch so both
 * paths cannot drift; rate limiting is the caller's job because a batch must
 * cost one slot, not one per row. */
async function recordVerdict(env, rawCode, rawErr, fingerprint) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) return { ok: false, error: 'code must be 6-32 chars A-Z0-9', status: 400 };

  const errCode = Number(rawErr);
  /* Three outcomes, kept apart on purpose:
   *   publishable  → queued for confirmation
   *   per-account  → accepted, never queued (true for one account only)
   *   transient    → accepted, never queued (says nothing about the code)
   * Anything else is rejected rather than guessed. */
  const isPerAccount = PER_ACCOUNT.has(errCode);
  const isTransient = TRANSIENT.has(errCode);
  if (!VERDICT_BY_ERR.has(errCode) && !isPerAccount && !isTransient) {
    return { ok: false, error: `unknown err_code ${errCode}`, status: 400 };
  }

  if (isPerAccount) return { ok: true, code, queued: false, reason: 'verdict is account-specific' };
  if (isTransient) return { ok: true, code, queued: false, reason: 'verdict is transient' };

  const verdict = VERDICT_BY_ERR.get(errCode);
  const key = `pending:${code}`;
  const existing = JSON.parse((await env.VAULT.get(key)) || 'null') || {
    code,
    verdict,
    reporters: [],
    first_seen: new Date().toISOString(),
  };

  /* A verdict flip (e.g. a code that worked yesterday is exhausted today) restarts
   * the count rather than mixing disagreeing reports into one total. */
  if (existing.verdict !== verdict) {
    existing.verdict = verdict;
    existing.reporters = [];
  }
  if (!existing.reporters.includes(fingerprint)) existing.reporters.push(fingerprint);
  existing.updated_at = new Date().toISOString();
  existing.confirmations = existing.reporters.length;
  existing.promoted = existing.confirmations >= CONFIRMATIONS_REQUIRED;

  await env.VAULT.put(key, JSON.stringify(existing), { expirationTtl: PENDING_TTL_SECONDS });

  return {
    ok: true,
    queued: true,
    code,
    verdict,
    confirmations: existing.confirmations,
    needed: CONFIRMATIONS_REQUIRED,
    promoted: existing.promoted,
  };
}

async function handleSubmit(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, { status: 400 });
  }

  const fingerprint = await clientFingerprint(request, env);
  if (await rateLimited(env, fingerprint)) {
    return json({ ok: false, error: 'rate limited, try later' }, { status: 429 });
  }

  const result = await recordVerdict(env, payload && payload.code, payload && payload.err_code, fingerprint);
  if (!result.ok) {
    const { status, ...body } = result;
    return json(body, { status: status || 400 });
  }
  return json(result);
}

/* One request for a whole vault. A client reporting 200 codes over 200 requests
 * burns the hourly quota and cannot finish inside a message-port timeout, so the
 * batch costs a single rate-limit slot and answers with a per-row breakdown. */
async function handleSubmitBatch(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, { status: 400 });
  }

  const rows = (payload && payload.rows) || [];
  if (!Array.isArray(rows)) return json({ ok: false, error: 'rows must be an array' }, { status: 400 });
  if (!rows.length) return json({ ok: true, accepted: 0, queued: 0, rejected: 0, results: [] });
  if (rows.length > MAX_BATCH_ROWS) {
    return json({ ok: false, error: `at most ${MAX_BATCH_ROWS} rows per batch` }, { status: 413 });
  }

  const fingerprint = await clientFingerprint(request, env);
  if (await rateLimited(env, fingerprint)) {
    return json({ ok: false, error: 'rate limited, try later' }, { status: 429 });
  }

  /* Each row read-modify-writes its own KV key, so rows for *different* codes are
   * independent and can run concurrently; a full vault took ~175s strictly
   * sequential, which no client will wait for. Rows sharing a code must stay
   * ordered or they would overwrite each other's confirmation count, so group by
   * code first and run the groups in bounded-concurrency waves. */
  const groups = new Map();
  rows.forEach((row, index) => {
    const key = String((row && row.code) || '').trim().toUpperCase() || `__invalid__${index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, index });
  });

  const results = new Array(rows.length);
  const pending = [...groups.values()];
  const WAVE = 60;
  for (let i = 0; i < pending.length; i += WAVE) {
    await Promise.all(pending.slice(i, i + WAVE).map(async (group) => {
      for (const { row, index } of group) {
        results[index] = await recordVerdict(env, row && row.code, row && row.err_code, fingerprint);
      }
    }));
  }

  let queued = 0;
  let rejected = 0;
  for (const outcome of results) {
    if (!outcome.ok) rejected += 1;
    else if (outcome.queued) queued += 1;
  }

  return json({
    ok: true,
    accepted: rows.length - rejected,
    queued,
    rejected,
    needed: CONFIRMATIONS_REQUIRED,
    results,
  });
}

function adminOk(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  /* Constant-time-ish compare: bail on length first, then accumulate differences
   * so a wrong token does not leak its correct prefix through timing. */
  const expected = env.ADMIN_TOKEN || '';
  if (!expected || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function handlePending(request, env) {
  if (!adminOk(request, env)) return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const listed = await env.VAULT.list({ prefix: 'pending:' });
  const rows = [];
  for (const entry of listed.keys) {
    const row = JSON.parse((await env.VAULT.get(entry.name)) || 'null');
    if (row && row.promoted) {
      /* Reporter hashes stay inside the Worker — the repo gets a count, not a set
       * of per-client identifiers. */
      rows.push({
        code: row.code,
        verdict: row.verdict,
        confirmations: row.confirmations,
        first_seen: row.first_seen,
        updated_at: row.updated_at,
      });
    }
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));
  return json({ ok: true, count: rows.length, rows });
}

async function handleAck(request, env) {
  if (!adminOk(request, env)) return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, { status: 400 });
  }
  const codes = Array.isArray(payload && payload.codes) ? payload.codes : [];
  let removed = 0;
  for (const raw of codes) {
    const code = String(raw || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) continue;
    await env.VAULT.delete(`pending:${code}`);
    removed += 1;
  }
  return json({ ok: true, removed });
}

async function handleHealth(env) {
  const listed = await env.VAULT.list({ prefix: 'pending:', limit: 1000 });
  return json({
    ok: true,
    service: 'df-redeem-vault',
    pending: listed.keys.length,
    confirmations_required: CONFIRMATIONS_REQUIRED,
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    let response;
    try {
      if (url.pathname === '/health' && request.method === 'GET') response = await handleHealth(env);
      else if (url.pathname === '/submit' && request.method === 'POST') response = await handleSubmit(request, env);
      else if (url.pathname === '/submit-batch' && request.method === 'POST') response = await handleSubmitBatch(request, env);
      else if (url.pathname === '/pending' && request.method === 'GET') response = await handlePending(request, env);
      else if (url.pathname === '/ack' && request.method === 'POST') response = await handleAck(request, env);
      else response = json({ ok: false, error: 'not found' }, { status: 404 });
    } catch (error) {
      /* Never surface an internal message to a client: it can carry binding names
       * or secret-shaped strings. Log it and answer generically. */
      console.error('worker error', error && error.stack || error);
      response = json({ ok: false, error: 'internal error' }, { status: 500 });
    }

    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  },
};
