#!/usr/bin/env node
/* test/costs.test.js — equipment-cost parsing and the agreement/approval rule.
 *
 * The rule under test (stated by the user): first report is trusted; a second
 * matching report confirms it without approval; a second differing report opens a
 * dispute that needs a human verdict. The parser matters as much as the quorum —
 * if "290K" and "290.000" parse to different integers, honest users manufacture
 * disputes out of nothing.
 */
'use strict';
const Costs = require('../src/core/costs.js');

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log(`ok   ${name}`); } else { failed += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const eq = (name, actual, expected) => check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

/* ── parsing: every shape a Vietnamese player will actually type ───────────── */
eq('plain integer', Costs.parseCost('295426').value, 295426);
eq('English thousands separator', Costs.parseCost('295,426').value, 295426);
eq('Vietnamese thousands separator', Costs.parseCost('295.426').value, 295426);
eq('space separator', Costs.parseCost('295 426').value, 295426);
eq('lowercase k suffix', Costs.parseCost('290k').value, 290000);
eq('uppercase K suffix', Costs.parseCost('290K').value, 290000);
eq('decimal with m suffix', Costs.parseCost('1.2m').value, 1200000);
eq('currency symbol stripped', Costs.parseCost('295.426₫').value, 295426);
eq('vnd suffix stripped', Costs.parseCost('295426 vnd').value, 295426);
eq('leading/trailing space', Costs.parseCost('  295426  ').value, 295426);

check('empty input rejected', !Costs.parseCost('').ok);
check('null rejected', !Costs.parseCost(null).ok);
check('letters rejected', !Costs.parseCost('abc').ok);
check('negative rejected', !Costs.parseCost('-500').ok);
check('below floor rejected', !Costs.parseCost('50').ok);
check('absurdly large rejected', !Costs.parseCost('99999999999').ok);
check('a pasted preset code is rejected, not parsed', !Costs.parseCost('6LCTUP00AHP1JR9CHG3OI').ok);

/* The caption said 290K, the screenshot said 295,426. Both must parse, and they
 * must be recognised as the same measurement so the user's own two numbers do
 * not open a dispute against each other. */
const capt = Costs.parseCost('290K').value;
const exact = Costs.parseCost('295426').value;
check('caption 290K and exact 295426 both parse', capt === 290000 && exact === 295426);
check('290K and 295426 count as agreement (within tolerance)', Costs.agrees(capt, exact),
  `${capt} vs ${exact} diff ${Math.abs(capt - exact) / exact}`);
check('295426 and 195426 are a real dispute', !Costs.agrees(295426, 195426));

/* ── formatting ────────────────────────────────────────────────────────────── */
eq('formats with dot separators', Costs.formatCost(295426), '295.426');
eq('formats a small number unchanged', Costs.formatCost(900), '900');
eq('formats a million', Costs.formatCost(1200000), '1.200.000');
eq('formats nothing as a dash', Costs.formatCost(0), '—');
eq('formats garbage as a dash', Costs.formatCost('x'), '—');

/* ── the agreement rule ────────────────────────────────────────────────────── */
const A = 'reporter-a';
const B = 'reporter-b';
const C = 'reporter-c';

const first = Costs.applyReport(null, { value: '295426', reporter: A, at: '2026-09-28T10:00:00Z' });
check('first report is accepted', first.ok);
eq('first report keeps the value', first.record.value, 295426);
eq('first report needs no approval', first.record.state, 'unconfirmed');
eq('first report is marked as such', first.outcome, 'first');

/* User's rule: "từ lần thứ 2 trở đi nếu số giống thì cũng cho là trùng, không
 * cần cung cấp bổ sung thêm để duyệt" */
const same = Costs.applyReport(first.record, { value: '295426', reporter: B, at: '2026-09-28T11:00:00Z' });
eq('second matching report confirms without approval', same.record.state, 'confirmed');
eq('confirmed record keeps the agreed value', same.record.value, 295426);
check('confirmed record is not disputed', same.record.state !== 'disputed');

/* A rounded second reading is still the same build, and must not overwrite the
 * precise number with its own rounding. */
const rounded = Costs.applyReport(first.record, { value: '290K', reporter: B, at: '2026-09-28T11:00:00Z' });
eq('a rounded second reading confirms rather than disputes', rounded.record.state, 'confirmed');
eq('a rounded reading does not overwrite the precise one', rounded.record.value, 295426);
/* ...and the reverse order must reach the same value, or the displayed cost would
 * depend on who happened to report first. */
const preciseSecond = Costs.applyReport(
  Costs.applyReport(null, { value: '290K', reporter: A, at: '2026-09-28T10:00:00Z' }).record,
  { value: '295426', reporter: B, at: '2026-09-28T11:00:00Z' },
);
eq('a precise later reading replaces a rounded earlier one', preciseSecond.record.value, 295426);
eq('precision upgrade still counts as confirmation', preciseSecond.record.state, 'confirmed');

/* "còn nếu khác thì qua bước phê duyệt" */
const differ = Costs.applyReport(first.record, { value: '412000', reporter: B, at: '2026-09-28T11:00:00Z' });
eq('a differing second report opens a dispute', differ.record.state, 'disputed');
check('dispute keeps both readings on file', differ.record.reports.length === 2);
eq('dispute still shows a usable value', differ.record.value, 295426);

/* One person cannot confirm their own number. */
const selfAgain = Costs.applyReport(first.record, { value: '295426', reporter: A, at: '2026-09-28T12:00:00Z' });
eq('re-sending an identical number writes nothing', selfAgain.changed, false);
eq('re-sending an identical number stays unconfirmed', selfAgain.record.state, 'unconfirmed');
/* A correction must be a *different* number: 300000 is within tolerance of
 * 295426 and correctly counts as unchanged, so use a clearly distinct value. */
const selfCorrect = Costs.applyReport(first.record, { value: '412000', reporter: A, at: '2026-09-28T12:00:00Z' });
eq('the same reporter correcting themselves does not self-confirm', selfCorrect.record.state, 'unconfirmed');
eq('a correction replaces rather than appends', selfCorrect.record.reports.length, 1);
eq('a correction takes the new value', selfCorrect.record.value, 412000);
const selfNudge = Costs.applyReport(first.record, { value: '300000', reporter: A, at: '2026-09-28T12:00:00Z' });
eq('a correction inside tolerance is treated as unchanged', selfNudge.changed, false);

/* Majority cluster wins a three-way split. */
let rec = Costs.applyReport(null, { value: '412000', reporter: A, at: '2026-09-28T10:00:00Z' }).record;
rec = Costs.applyReport(rec, { value: '295426', reporter: B, at: '2026-09-28T11:00:00Z' }).record;
const third = Costs.applyReport(rec, { value: '295000', reporter: C, at: '2026-09-28T12:00:00Z' });
/* The winning cluster is {295426, 295000}; within it the precise reading shows. */
eq('the larger agreeing cluster wins the displayed value', third.record.value, 295426);
eq('a contested record stays disputed even when one side leads', third.record.state, 'disputed');
check('all three readings stay on file for review', third.record.reports.length === 3);

/* ── dispute review ───────────────────────────────────────────────────────── */
const summary = Costs.disputeSummary(third.record);
eq('summary groups agreeing readings', summary.length, 2);
eq('summary ranks the majority cluster first', summary[0].count, 2);

const resolved = Costs.resolveDispute(third.record, '295426', 'admin');
eq('resolving a dispute confirms it', resolved.record.state, 'confirmed');
eq('resolving keeps the chosen value', resolved.record.value, 295426);
check('resolving drops the rejected readings', resolved.record.reports.every((r) => Costs.agrees(r.value, 295426)));
eq('resolving records who decided', resolved.record.resolved_by, 'admin');
check('resolving a bad value is refused', !Costs.resolveDispute(third.record, 'nonsense', 'admin').ok);

/* ── guards ───────────────────────────────────────────────────────────────── */
check('a report without a reporter is refused', !Costs.applyReport(null, { value: '295426' }).ok);
check('a report with a bad value is refused', !Costs.applyReport(null, { value: 'abc', reporter: A }).ok);
check('applyReport never mutates the input record', (() => {
  const base = Costs.applyReport(null, { value: '295426', reporter: A }).record;
  const snapshot = JSON.stringify(base);
  Costs.applyReport(base, { value: '412000', reporter: B });
  return JSON.stringify(base) === snapshot;
})());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
