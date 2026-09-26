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

/* Preserve a submitted code's spelling in public data. Identity/deduplication is
 * case-insensitive, but redeeming is not: Garena has accepted mixed-case codes
 * that its uppercase form rejects. */
const CODE_RE = /^[A-Za-z0-9]{6,32}$/;

/* Verdicts a client may report, mapped from Garena's own error numbers. A client
 * cannot invent a status string — it reports err_code and the Worker decides. */
import { VERDICT_BY_ERR, PER_ACCOUNT, TRANSIENT } from './verdicts.js';

/* Verdicts that may appear in the public file. Account-local `exhausted` is
 * deliberately not publishable: no current Garena error establishes it for all
 * accounts. Historical rows remain readable in the repository but are never
 * newly accepted or promoted by this Worker. */
const PUBLISHABLE = new Set(['success', 'expired', 'gift_bug']);

/* Public deployment fails safe: a malformed/missing variable still needs two
 * reporter IDs before promotion. A UUID is client asserted, so this reduces
 * accidental bad reports; it is not Sybil-resistant authentication. */
const DEFAULT_CONFIRMATIONS = 2;
function confirmationsRequired(env) {
  const configured = Number(env && env.CONFIRMATIONS_REQUIRED);
  return Number.isFinite(configured) && configured >= 2 ? configured : DEFAULT_CONFIRMATIONS;
}

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

/* Salted hash of the caller IP. Used ONLY to rate-limit — never to count
 * reporters. It is never stored alongside the code in the repo and cannot be
 * reversed to an address without the secret salt. */
async function rateLimitKey(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const salt = env.IP_SALT || 'df-redeem-unsalted';
  return sha256Short(`${salt}:${ip}`);
}

/* Identity of the *install* that reported a verdict.
 *
 * This used to be the IP hash, which conflated two different things: everyone
 * behind one router counted as a single reporter, so two genuine machines in the
 * same house could never confirm each other, while one machine on a changing
 * mobile IP could confirm itself repeatedly. The client now sends a random UUID
 * minted once per extension install and kept in local storage.
 *
 * This is self-asserted and trivially forgeable by design: it is a de-duplication
 * key, not an authentication token, and it must never be treated as proof of a
 * distinct person. Rate limiting stays on the IP hash, which a client cannot pick.
 * Unknown/malformed ids fall back to the IP hash so an old client still counts as
 * exactly one reporter rather than becoming anonymous. */
const INSTALL_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
async function reporterIdentity(request, env, claimedInstallId) {
  const claimed = String(claimedInstallId || '').trim();
  if (INSTALL_ID_RE.test(claimed)) {
    const salt = env.IP_SALT || 'df-redeem-unsalted';
    /* Hashed so the stored row never carries a raw client-chosen string, and
     * prefixed so an install id can never collide with a legacy IP-hash entry. */
    return `i${await sha256Short(`${salt}:install:${claimed.toLowerCase()}`)}`;
  }
  return `p${await rateLimitKey(request, env)}`;
}

async function sha256Short(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function rateLimited(env, limitKey) {
  const key = `rate:${limitKey}`;
  const current = Number((await env.VAULT.get(key)) || 0);
  if (current >= MAX_SUBMITS_PER_WINDOW) return true;
  await env.VAULT.put(key, String(current + 1), { expirationTtl: RATE_WINDOW_SECONDS });
  return false;
}

/* Classify and record one verdict. Shared by /submit and /submit-batch so both
 * paths cannot drift; rate limiting is the caller's job because a batch must
 * cost one slot, not one per row. */
async function recordVerdict(env, rawCode, rawErr, reporter) {
  const code = String(rawCode || '').trim();
  if (!CODE_RE.test(code)) return { ok: false, error: 'code must be 6-32 alphanumeric chars', status: 400 };
  const codeKey = code.toUpperCase();

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
  const key = `pending:${codeKey}`;
  const existing = JSON.parse((await env.VAULT.get(key)) || 'null');
  const isNew = !existing;
  const queue = existing || {
    code,
    verdict,
    reporters: [],
    first_seen: new Date().toISOString(),
  };

  /* A verdict flip (e.g. a code that worked yesterday is exhausted today) restarts
   * the count rather than mixing disagreeing reports into one total. */
  const flipped = !isNew && queue.verdict !== verdict;
  if (flipped) {
    queue.verdict = verdict;
    queue.reporters = [];
  }
  const isNewReporter = !queue.reporters.includes(reporter);
  if (isNewReporter) queue.reporters.push(reporter);

  const needed = confirmationsRequired(env);
  const confirmations = queue.reporters.length;
  const shouldPromote = confirmations >= needed;

  /* Re-reporting a verdict already on file changes nothing, and clients push their
   * whole vault every time. Writing anyway burned ~290 KV writes per push and hit
   * the daily put() quota after three pushes, which then failed every submission
   * with a 500. Only write when the row actually moved.
   *
   * `promoted !== shouldPromote` is part of "moved" on purpose: lowering the
   * confirmation threshold leaves already-queued rows at their old verdict and
   * reporter set, so without this they would stay unpromoted forever and the
   * threshold change would silently do nothing to the existing queue. */
  const changed = isNew
    || flipped
    || isNewReporter
    || !queue.updated_at
    || queue.promoted !== shouldPromote
    || queue.confirmations !== confirmations;

  if (changed) {
    queue.updated_at = new Date().toISOString();
    queue.confirmations = confirmations;
    queue.promoted = shouldPromote;
    await env.VAULT.put(key, JSON.stringify(queue), { expirationTtl: PENDING_TTL_SECONDS });
  }

  return {
    ok: true,
    queued: true,
    code: queue.code,
    verdict,
    confirmations: queue.confirmations,
    needed,
    promoted: queue.promoted,
    /* Lets a client tell "already on file" apart from "your report counted". */
    unchanged: !changed,
  };
}

async function handleSubmit(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, { status: 400 });
  }

  /* Two distinct identities: the IP hash gates the rate limit (a client cannot
   * choose it), the install id de-duplicates reporters (a client asserts it). */
  const limitKey = await rateLimitKey(request, env);
  if (await rateLimited(env, limitKey)) {
    return json({ ok: false, error: 'rate limited, try later' }, { status: 429 });
  }
  const reporter = await reporterIdentity(request, env, payload && payload.install_id);

  const result = await recordVerdict(env, payload && payload.code, payload && payload.err_code, reporter);
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

  const limitKey = await rateLimitKey(request, env);
  if (await rateLimited(env, limitKey)) {
    return json({ ok: false, error: 'rate limited, try later' }, { status: 429 });
  }
  const reporter = await reporterIdentity(request, env, payload && payload.install_id);

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
        results[index] = await recordVerdict(env, row && row.code, row && row.err_code, reporter);
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
    needed: confirmationsRequired(env),
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
  const required = confirmationsRequired(env);
  const listed = await env.VAULT.list({ prefix: 'pending:' });
  const rows = [];
  for (const entry of listed.keys) {
    const row = JSON.parse((await env.VAULT.get(entry.name)) || 'null');
    /* Judge against the *current* threshold instead of trusting the stored flag.
     *
     * `promoted` is only rewritten when a row is reported again, so rows queued
     * under a higher threshold keep `promoted:false` forever once reporting stops
     * — lowering the threshold silently published nothing, because the rows that
     * should have become eligible were never touched again. Re-deriving here needs
     * no KV writes, so it costs no quota and cannot strand a backlog. */
    /* Legacy queues may contain a formerly accepted `invalid` report. Do not
     * re-expose it: its casing may be wrong, and only the strict current set may
     * cross this public boundary. */
    const eligible = row
      && PUBLISHABLE.has(row.verdict)
      && Number(row.confirmations || 0) >= required;
    if (eligible) {
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
    const submitted = String(raw || '').trim();
    if (!CODE_RE.test(submitted)) continue;
    await env.VAULT.delete(`pending:${submitted.toUpperCase()}`);
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
    confirmations_required: confirmationsRequired(env),
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

      /* One exception: a KV daily-write-quota exhaustion is an operational state,
       * not a bug, and it is indistinguishable from a broken vault at the client.
       * It surfaced as a bare 500 and cost real debugging time, so name it and
       * answer 503 with Retry-After pointing at the UTC reset. */
      const message = String((error && error.message) || '');
      if (/limit exceeded for the day|KV (?:put|write).*limit/i.test(message)) {
        const now = new Date();
        const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
        const retryAfter = Math.max(1, Math.ceil((reset - now.getTime()) / 1000));
        response = json({
          ok: false,
          error: 'vault write quota for today is used up',
          retry_after_seconds: retryAfter,
          resets_at: new Date(reset).toISOString(),
        }, { status: 503 }, { 'Retry-After': String(retryAfter) });
      } else {
        response = json({ ok: false, error: 'internal error' }, { status: 500 });
      }
    }

    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  },
};
