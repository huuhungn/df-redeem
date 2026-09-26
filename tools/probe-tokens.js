'use strict';

/* Exact live-pipeline probes that predate the merge gate. Do NOT turn this into
 * a substring or prefix rule: gift codes are opaque server-issued strings, so a
 * match such as `SMOKE` could be a legitimate future code. Exact matching makes
 * the safety rule fail closed for known probes without ever discarding real data.
 *
 * New live probes are prohibited. Exercise the Worker through local `wrangler
 * dev` tests instead; if an emergency live probe is unavoidable, remove it from
 * KV immediately rather than adding a broad matching rule here. */
const PROBE_CODES = Object.freeze([
  'DFPIPEMUH9O9RQ',
  'DFQUOTACHK03',
]);

module.exports = { PROBE_CODES };
