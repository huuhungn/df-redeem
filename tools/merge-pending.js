#!/usr/bin/env node
/* tools/merge-pending.js — pull promoted rows from the Worker and fold them into
 * data/codes.json. Run by .github/workflows/sync-codes.yml; also runnable by hand.
 *
 * The repository is the source of truth. This script only ever:
 *   - adds codes the repo has never seen, or
 *   - updates a verdict when the Worker has at least as many confirmations.
 * It never deletes a code, so a broken run cannot wipe the vault.
 *
 * Env: VAULT_URL, VAULT_ADMIN_TOKEN. Pass --dry-run to print without writing.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/[\\/]tools$/, '');
const CODES_FILE = path.join(ROOT, 'data', 'codes.json');
const DRY = process.argv.includes('--dry-run');

const VAULT_URL = (process.env.VAULT_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.VAULT_ADMIN_TOKEN || '';

/* Same publishable set as the Worker. Duplicated deliberately: if the Worker is
 * ever compromised or misconfigured, the repo side still refuses to write an
 * account-specific verdict into public data. */
const PUBLISHABLE = new Set(['success', 'expired', 'invalid', 'gift_bug']);
const CODE_RE = /^[A-Z0-9]{6,32}$/;

/* Test probes submitted to the live Worker while verifying the pipeline. The
 * queue cannot distinguish them from real codes, so they are filtered here —
 * before anything is written — and acked like any other handled row so they do
 * not sit in the queue forever being re-offered.
 *
 * `DF` itself is deliberately not reserved: real Garena codes commonly begin
 * with it. The exact historic probes live in probe-tokens.js. New live probes
 * are prohibited; exercise the pipeline through local `wrangler dev` tests. */
const { PROBE_CODES } = require('./probe-tokens.js');
const isProbe = (code) => PROBE_CODES.includes(code);

/* /pending reports a verdict, not the Garena error number behind it, so the
 * err_code written into the published row has to be derived from the verdict.
 * It used to be hardcoded to 0 — the code for *success* — which stamped every
 * expired or invalid row with a success error number and contradicted its own
 * status field. Mirrors VERDICT_BY_ERR in worker/src/verdicts.js; 'exhausted'
 * has no current err_code (400069 is per-account and never published) so seed
 * rows carrying it keep whatever they already had. */
const ERR_BY_VERDICT = new Map([
  ['success', 0],
  ['invalid', 400054],
  ['expired', 400068],
  ['gift_bug', 400073],
]);
function errCodeFor(verdict, fallback) {
  return ERR_BY_VERDICT.has(verdict) ? ERR_BY_VERDICT.get(verdict) : (fallback != null ? fallback : 0);
}

function fail(message) {
  console.error('merge-pending: ' + message);
  process.exit(1);
}

async function main() {
  if (!VAULT_URL) fail('VAULT_URL is not set');
  if (!TOKEN) fail('VAULT_ADMIN_TOKEN is not set');

  const res = await fetch(`${VAULT_URL}/pending`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) fail(`GET /pending returned HTTP ${res.status}`);
  const payload = await res.json();
  const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
  console.log(`worker offers ${rows.length} promoted row(s)`);

  /* The minimum confirmation count was hardcoded to 2 here while the Worker read
   * its own threshold from the environment. Lowering the Worker's threshold then
   * did nothing: it promoted rows that this script silently rejected as
   * under-confirmed, and the queue never drained. Ask the Worker what it requires
   * so the two cannot disagree. /health is unauthenticated and cheap. */
  let required = 2;
  try {
    const health = await fetch(`${VAULT_URL}/health`);
    if (health.ok) {
      const body = await health.json();
      const reported = Number(body && body.confirmations_required);
      if (Number.isFinite(reported) && reported >= 1) required = reported;
      else console.log('warning: /health did not report confirmations_required; assuming 2');
    } else {
      console.log(`warning: /health returned HTTP ${health.status}; assuming 2 confirmations`);
    }
  } catch (error) {
    console.log(`warning: /health unreachable (${error && error.message}); assuming 2 confirmations`);
  }
  console.log(`confirmations required: ${required}`);

  const doc = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
  const codes = Array.isArray(doc.codes) ? doc.codes : [];
  const byCode = new Map(codes.map((row) => [row.code, row]));

  const added = [];
  const updated = [];
  const rejected = [];
  const probes = [];
  const acked = [];

  for (const row of rows) {
    const code = String(row && row.code || '').trim().toUpperCase();
    const verdict = String(row && row.verdict || '');
    const confirmations = Number(row && row.confirmations || 0);

    /* Probes are dropped *and* acked: rejecting without acking would leave them in
     * the queue to be re-offered on every run forever. They are not real codes, so
     * there is nothing to preserve. */
    if (isProbe(code)) {
      probes.push(code);
      acked.push(code);
      continue;
    }

    if (!CODE_RE.test(code) || !PUBLISHABLE.has(verdict) || confirmations < required) {
      rejected.push({ code, verdict, confirmations });
      continue;
    }

    const existing = byCode.get(code);
    if (!existing) {
      const fresh = {
        code,
        status: verdict,
        err_code: errCodeFor(verdict),
        confirmations,
        last_checked: String(row.updated_at || '').slice(0, 10) || null,
      };
      byCode.set(code, fresh);
      added.push(code);
      acked.push(code);
      continue;
    }

    /* Only overwrite when the community is at least as confident as the stored
     * row. This stops a two-client report from flipping a well-established
     * verdict, while still letting genuinely changed codes (expired, exhausted)
     * through once enough clients agree. */
    if (existing.status !== verdict && confirmations >= Number(existing.confirmations || 1)) {
      existing.status = verdict;
      existing.err_code = errCodeFor(verdict, existing.err_code);
      existing.confirmations = confirmations;
      existing.last_checked = String(row.updated_at || '').slice(0, 10) || existing.last_checked;
      updated.push(`${code}: → ${verdict}`);
      acked.push(code);
    } else {
      /* Nothing to change, but the Worker should stop offering it. */
      acked.push(code);
    }
  }

  const merged = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  doc.codes = merged;
  doc.counts = merged.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  console.log(`  added   ${added.length}${added.length ? ': ' + added.slice(0, 10).join(', ') : ''}`);
  console.log(`  updated ${updated.length}${updated.length ? ': ' + updated.slice(0, 10).join(', ') : ''}`);
  if (probes.length) console.log(`  dropped ${probes.length} test probe(s): ${probes.slice(0, 10).join(', ')}`);
  if (rejected.length) console.log(`  rejected ${rejected.length} (unpublishable or under-confirmed)`);

  if (!added.length && !updated.length) {
    console.log('nothing to commit');
    /* Still acknowledge, or the Worker keeps replaying rows the repo already has. */
    if (!DRY && acked.length) await ack(acked);
    console.log('CHANGED=false');
    return;
  }

  if (DRY) {
    console.log('dry run — no files written, nothing acked');
    console.log('CHANGED=true');
    return;
  }

  doc.updated_at = new Date().toISOString();
  fs.writeFileSync(CODES_FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`wrote ${path.relative(ROOT, CODES_FILE)} (${merged.length} codes)`);

  /* Ack only after the file is safely on disk: if the write throws, the rows stay
   * queued and the next run retries them. */
  await ack(acked);
  console.log('CHANGED=true');
}

async function ack(codes) {
  const res = await fetch(`${VAULT_URL}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ codes }),
  });
  if (!res.ok) {
    /* A failed ack is not fatal — the merge is idempotent, so the next run simply
     * sees the same rows and changes nothing. */
    console.log(`warning: ack returned HTTP ${res.status}; rows will be retried`);
    return;
  }
  const body = await res.json().catch(() => ({}));
  console.log(`acked ${body.removed != null ? body.removed : codes.length} row(s)`);
}

main().catch((error) => fail(error && error.stack || String(error)));
