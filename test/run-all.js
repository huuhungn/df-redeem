#!/usr/bin/env node
/* test/run-all.js — run every *.test.js and report one summary line each.
 *
 * Each test file is a separate process on purpose: the worker and merge tests
 * boot a real `wrangler dev`, and one crashing suite must not take the rest down.
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let totalPassed = 0;
let totalFailed = 0;
const broken = [];

for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8', cwd: path.join(dir, '..') });
  const output = String(result.stdout || '') + String(result.stderr || '');
  const lines = output.trim().split('\n');
  /* Two summary formats exist in this repo: "N passed, M failed" and "N/M tests
   * passed". Accept both rather than rewriting working suites. */
  const summary = lines.filter((l) => /\d+ passed, \d+ failed/.test(l)).pop();
  const ratio = lines.filter((l) => /^\d+\/\d+ .*tests? passed/.test(l.trim())).pop();
  const match = summary && summary.match(/(\d+) passed, (\d+) failed/);
  const ratioMatch = ratio && ratio.trim().match(/^(\d+)\/(\d+)/);

  if (match) {
    const [, passed, failed] = match;
    totalPassed += Number(passed);
    totalFailed += Number(failed);
    const mark = Number(failed) === 0 && result.status === 0 ? 'ok  ' : 'FAIL';
    console.log(`${mark} ${file.padEnd(26)} ${passed} passed, ${failed} failed`);
    if (Number(failed) > 0) broken.push(file);
  } else if (ratioMatch) {
    const [, passed, total] = ratioMatch;
    const failed = Number(total) - Number(passed);
    totalPassed += Number(passed);
    totalFailed += failed;
    const mark = failed === 0 && result.status === 0 ? 'ok  ' : 'FAIL';
    console.log(`${mark} ${file.padEnd(26)} ${passed} passed, ${failed} failed`);
    if (failed > 0) broken.push(file);
  } else {
    console.log(`FAIL ${file.padEnd(26)} no summary (exit ${result.status})`);
    broken.push(file);
    totalFailed += 1;
    /* Show why, or a silent crash looks like a missing suite. */
    for (const line of output.trim().split('\n').slice(-6)) console.log(`       ${line}`);
  }
}

console.log(`\n${files.length} suites · ${totalPassed} passed, ${totalFailed} failed`);
if (broken.length) console.log(`broken: ${broken.join(', ')}`);
process.exit(totalFailed === 0 ? 0 : 1);
