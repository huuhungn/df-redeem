#!/usr/bin/env node
/* tools/validate-data.js — gate the published data files.
 *
 * This is the last check before a bot commit lands, so it fails loudly rather
 * than repairing anything: a malformed vault must never be pushed and then served
 * to every client.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/[\\/]tools$/, '');
const problems = [];
const CODE_RE = /^[A-Z0-9]{6,32}$/;
const PRESET_RE = /^[A-Z0-9]{10,40}$/i;
const VALID_STATUS = new Set(['success', 'expired', 'invalid', 'exhausted', 'gift_bug', 'untried']);
/* Verdicts that are true for one account only must never reach public data. */
const FORBIDDEN_STATUS = new Set(['mine', 'account_already']);
const FORBIDDEN_ERR = new Set([400067]);

function readJson(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    problems.push(`${rel} is missing`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    problems.push(`${rel} is not valid JSON: ${error.message}`);
    return null;
  }
}

const codesDoc = readJson('data/codes.json');
if (codesDoc) {
  const codes = Array.isArray(codesDoc.codes) ? codesDoc.codes : null;
  if (!codes) problems.push('data/codes.json: "codes" must be an array');
  else {
    /* An empty vault would silently make every client think nothing works; treat
     * it as corruption rather than a legitimate state. */
    if (codes.length === 0) problems.push('data/codes.json: vault is empty');

    const seen = new Set();
    for (const [index, row] of codes.entries()) {
      const where = `data/codes.json[${index}]`;
      const code = String(row && row.code || '');
      if (!CODE_RE.test(code)) problems.push(`${where}: bad code ${JSON.stringify(code)}`);
      if (seen.has(code)) problems.push(`${where}: duplicate code ${code}`);
      seen.add(code);

      const status = String(row && row.status || '');
      if (FORBIDDEN_STATUS.has(status)) problems.push(`${where}: ${code} carries account-specific status "${status}"`);
      else if (!VALID_STATUS.has(status)) problems.push(`${where}: ${code} has unknown status "${status}"`);

      if (FORBIDDEN_ERR.has(Number(row && row.err_code))) {
        problems.push(`${where}: ${code} carries per-account err_code ${row.err_code}`);
      }
      if (row && row.confirmations != null && !(Number(row.confirmations) >= 1)) {
        problems.push(`${where}: ${code} has invalid confirmations ${row.confirmations}`);
      }
      if (row && row.last_checked && !/^\d{4}-\d{2}-\d{2}$/.test(String(row.last_checked))) {
        problems.push(`${where}: ${code} last_checked must be YYYY-MM-DD, got ${row.last_checked}`);
      }
      /* Fields that would leak the contributing machine. */
      for (const leak of ['source', 'notes', 'reporters', 'ip', 'account']) {
        if (row && Object.prototype.hasOwnProperty.call(row, leak)) {
          problems.push(`${where}: ${code} must not publish field "${leak}"`);
        }
      }
    }

    /* counts must match the rows, or clients and humans read different numbers. */
    const actual = codes.reduce((acc, row) => {
      const key = String(row && row.status || '');
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const declared = codesDoc.counts || {};
    for (const key of new Set([...Object.keys(actual), ...Object.keys(declared)])) {
      if (Number(actual[key] || 0) !== Number(declared[key] || 0)) {
        problems.push(`data/codes.json: counts.${key} says ${declared[key] || 0} but ${actual[key] || 0} rows match`);
      }
    }
  }
}

const presetsDoc = readJson('data/presets.json');
if (presetsDoc) {
  const presets = Array.isArray(presetsDoc.presets) ? presetsDoc.presets : null;
  if (!presets) problems.push('data/presets.json: "presets" must be an array');
  else {
    const seen = new Set();
    for (const [index, row] of presets.entries()) {
      const where = `data/presets.json[${index}]`;
      const code = String(row && row.code || '');
      if (!PRESET_RE.test(code)) problems.push(`${where}: bad preset code ${JSON.stringify(code)}`);
      if (seen.has(code)) problems.push(`${where}: duplicate preset ${code}`);
      seen.add(code);
      if (!String(row && row.weapon || '').trim()) problems.push(`${where}: ${code} has no weapon`);
    }
  }
}

if (problems.length) {
  console.error(`validate-data: ${problems.length} problem(s)`);
  for (const line of problems.slice(0, 40)) console.error('  ' + line);
  if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
  process.exit(1);
}

const codeCount = codesDoc && codesDoc.codes ? codesDoc.codes.length : 0;
const presetCount = presetsDoc && presetsDoc.presets ? presetsDoc.presets.length : 0;
console.log(`validate-data: ok — ${codeCount} codes, ${presetCount} presets, no account-specific data`);
