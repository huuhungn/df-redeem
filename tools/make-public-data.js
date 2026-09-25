#!/usr/bin/env node
/* tools/make-public-data.js — derive the publishable vault from the local seed.
 *
 * The local seed carries fields that are useful on one machine but are noise (or
 * mild fingerprinting) once published: which file an OCR pass came from, local
 * timestamps down to the millisecond, free-text notes. The published files carry
 * only what another client needs in order to skip dead codes and offer presets.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/[\\/]tools$/, '');
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/seed.json'), 'utf8'));

/* Day precision is enough for "is this stale?" and leaks nothing about when a
 * particular person was at their desk. */
const day = (value) => {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

/* "mine" is a local-only verdict: it means *this* operator already redeemed the
 * code (Garena answers 400067 to the same account). For anyone else that code is
 * still perfectly usable, so it must publish as a working code — publishing it as
 * "mine" would make every other client skip a good code. */
const PUBLIC_STATUS = { mine: 'success' };

const codes = (seed.codes || [])
  .filter((row) => row && row.code && row.kind === 'giftcode')
  .map((row) => {
    const local = String(row.status || 'untried');
    const status = PUBLIC_STATUS[local] || local;
    return {
      code: String(row.code).trim().toUpperCase(),
      status,
      /* 400067 ("already redeemed by you") is per-account, so it must not travel
       * with the record either. A shared record only carries an error code when
       * that error is true for everyone. */
      err_code: local === 'mine' ? 0 : Number(row.err_code || 0),
      /* How many independent clients have reported this verdict. The local seed is
       * one observer, so everything it contributes starts at 1. */
      confirmations: 1,
      last_checked: day(row.last_tried || row.first_seen),
    };
  })
  .sort((a, b) => a.code.localeCompare(b.code));

const presets = (seed.presets || [])
  .filter((row) => row && row.code)
  .map((row) => ({
    code: String(row.code).trim(),
    weapon: String(row.weapon || '').trim(),
    mode: String(row.mode || '').trim(),
    /* Credit is kept when it points at a public handle; a bare "user" is the
     * local operator and becomes "bundled" so the file says nothing about them. */
    author: /^user$/i.test(String(row.author || '')) ? 'bundled' : String(row.author || '').trim(),
    verified: row.verified === true,
  }))
  .sort((a, b) => a.weapon.localeCompare(b.weapon) || a.code.localeCompare(b.code));

const stamp = new Date().toISOString();
const codesDoc = {
  version: 3,
  updated_at: stamp,
  note: 'Gift-code verdicts confirmed by extension clients. Automated: see .github/workflows/sync-codes.yml',
  counts: codes.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {}),
  codes,
};
const presetsDoc = {
  version: 3,
  updated_at: stamp,
  note: 'Gunsmith presets. Added only through the approved-preset issue form — never automatically.',
  presets,
};

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const write = (rel, doc) => {
  const file = path.join(ROOT, rel);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`  ${rel}  ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
};

console.log('public data written:');
write('data/codes.json', codesDoc);
write('data/presets.json', presetsDoc);
console.log(`  ${codes.length} codes, ${presets.length} presets`);
