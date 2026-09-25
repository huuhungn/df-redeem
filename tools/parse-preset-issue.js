#!/usr/bin/env node
/* tools/parse-preset-issue.js — turn a GitHub issue-form body into safe outputs.
 *
 * Reads the body from $BODY (never from argv: an issue body is attacker-controlled
 * text and must not be interpolated into a shell command line). Prints
 * key=value lines for $GITHUB_OUTPUT.
 *
 * GitHub renders issue forms as markdown: a "### Label" heading followed by the
 * user's answer, with "_No response_" for a skipped optional field.
 */
'use strict';

const body = String(process.env.BODY || '');

/* GITHUB_OUTPUT is line-based, so any newline in a value would let a submitter
 * forge extra outputs. Every value is flattened and capped before printing. */
const flatten = (value, max) =>
  String(value || '')
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function field(heading) {
  /* Capture everything after the heading until the next heading or end. */
  const pattern = new RegExp(`###\\s*${heading}\\s*\\r?\\n+([\\s\\S]*?)(?=\\r?\\n###|$)`, 'i');
  const match = body.match(pattern);
  if (!match) return '';
  const value = match[1].trim();
  if (/^_no response_$/i.test(value)) return '';
  return value;
}

const code = flatten(field('Preset code'), 40).toUpperCase().replace(/[^A-Z0-9]/g, '');
const weapon = flatten(field('Weapon'), 60);
let mode = flatten(field('Game mode'), 40);
const credit = flatten(field('Credit \\(optional\\)') || field('Credit'), 40);

if (/^other/i.test(mode) || !mode) mode = 'Other';

if (!code || !weapon) {
  console.error('parse-preset-issue: the issue is missing a code or a weapon');
  process.exit(1);
}

/* Emit in $GITHUB_OUTPUT form. Values are already newline-free. */
process.stdout.write(`code=${code}\n`);
process.stdout.write(`weapon=${weapon}\n`);
process.stdout.write(`mode=${mode}\n`);
process.stdout.write(`credit=${credit}\n`);
