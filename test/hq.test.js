#!/usr/bin/env node
/* test/hq.test.js — the HQ recommended-code source (src/core/hq.js).
 *
 * The fixtures under test/fixtures/hq-*.js are the real files served at
 * playdeltaforce.com/gun-codes/, trimmed to a few schemes and with the bulky
 * Gunsmith config blob replaced. Everything else is byte-for-byte what HQ
 * publishes, so a format change upstream shows up here as a parse failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const HQ = require('../src/core/hq.js');

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log(`ok   ${name}`); } else { failed += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
const throws = (name, fn, pattern) => {
  try { fn(); check(name, false, 'did not throw'); } catch (e) { check(name, pattern.test(String(e.message)), String(e.message)); }
};
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

/* ── codes ─────────────────────────────────────────────────────────────── */
eq('code after the last hyphen', HQ.extractCode('AS Val Assault Rifle-Chiến Dịch Sinh Tồn-6K0BFI000PCLSC7KHDQMK'), '6K0BFI000PCLSC7KHDQMK');
eq('hyphenated gun name is not mistaken for the code', HQ.extractCode('AR-57 Assault Rifle-Chiến Dịch Sinh Tồn-6JVQNTS04Q5HR1E25MVF2'), '6JVQNTS04Q5HR1E25MVF2');
eq('bare API code accepted', HQ.extractCode('6JLGT7C02VAL71CR2QP7Q'), '6JLGT7C02VAL71CR2QP7Q');
eq('lower case normalised to upper', HQ.extractCode('x-6jlgt7c02val71cr2qp7q'), '6JLGT7C02VAL71CR2QP7Q');
eq('wrong length refused', HQ.extractCode('AKM-Chiến Dịch-6JLGT7C02VAL71CR2QP7'), '');
eq('punctuation refused', HQ.extractCode('AKM-6JLGT7C02VAL71CR2QP7!'), '');
eq('null refused', HQ.extractCode(null), '');

/* ── file parsing ──────────────────────────────────────────────────────── */
const [sol, mp] = HQ.SOURCES;
const solGroups = HQ.parseSchemeFile(fixture('hq-op_sol_ga_vi.js'), sol.varName);
const mpGroups = HQ.parseSchemeFile(fixture('hq-op_mp_ga_vi.js'), mp.varName);
eq('Operations file parses to gun groups', solGroups.length, 2);
eq('Warfare file parses to gun groups', mpGroups.length, 2);
eq('only the Garena-channel files are sources', HQ.SOURCES.map((s) => s.url.replace(/^.*\//, '')), ['op_sol_ga_vi.js', 'op_mp_ga_vi.js']);
eq('sources map to the library mode names', HQ.SOURCES.map((s) => s.mode), ['Chiến Dịch Sinh Tồn', 'Chiến Trường Toàn Diện']);
throws('a renamed variable is refused, not guessed', () => HQ.parseSchemeFile(fixture('hq-op_sol_ga_vi.js'), mp.varName), /đổi tên biến/);
throws('executable content is refused', () => HQ.parseSchemeFile('var gun_codes_op_sol_ga = (function(){ return []; }());', sol.varName), /JSON/);
throws('a non-array payload is refused', () => HQ.parseSchemeFile('var gun_codes_op_sol_ga = {"a":1};', sol.varName), /danh sách/);
throws('no declaration is refused', () => HQ.parseSchemeFile('alert(1)', sol.varName), /định dạng/);
throws('an oversized file is refused before parsing', () => HQ.parseSchemeFile('var gun_codes_op_sol_ga = [' + ' '.repeat(3 * 1024 * 1024) + '];', sol.varName), /quá lớn/);
eq('trailing semicolon and newline tolerated', HQ.parseSchemeFile('var gun_codes_op_mp_ga = [];\n', mp.varName), []);

/* ── normalisation ─────────────────────────────────────────────────────── */
const solItems = HQ.normalizeSchemes(solGroups, sol.mode);
const mpItems = HQ.normalizeSchemes(mpGroups, mp.mode);
eq('every Operations scheme yields one item', solItems.map((i) => i.code), ['6K0BFI000PCLSC7KHDQMK', '6JLGT7C02VAL71CR2QP7Q', '6JVQNTS04Q5HR1E25MVF2', '6JPQ82S03RBMNS7FRL5H4']);
eq('Warfare items carry the Warfare mode', mpItems.map((i) => i.mode), ['Chiến Trường Toàn Diện', 'Chiến Trường Toàn Diện']);
eq('weapon comes from the gun group', solItems[0].weapon, 'AS Val Assault Rifle');
check('title and author are kept', solItems.every((i) => typeof i.title === 'string' && typeof i.author === 'string'));
check('HQ tags are carried as names', solItems.some((i) => i.tags.length > 0) && solItems.every((i) => i.tags.every((t) => typeof t === 'string')));
check('config blob, avatars and stats are dropped', solItems.every((i) => !('config_data' in i) && !('image_url' in i) && !('final_range' in i) && !('authors' in i)));
const dup = [{ gun_name: 'AKM', schemes: [{ gun_code: 'AKM-x-6JLGT7C02VAL71CR2QP7Q' }, { gun_code: 'AKM-x-6jlgt7c02val71cr2qp7q' }, { gun_code: 'AKM-x-bad' }] }];
eq('duplicates and malformed codes are dropped', HQ.normalizeSchemes(dup, sol.mode).map((i) => i.code), ['6JLGT7C02VAL71CR2QP7Q']);
eq('garbage input yields nothing', HQ.normalizeSchemes({ not: 'a list' }, sol.mode), []);

/* ── import planning ───────────────────────────────────────────────────── */
const library = [{ code: '6k0bfi000pclsc7khdqmk', weapon: 'Tên khác do người dùng đặt' }];
const plan = HQ.planImport(library, solItems);
eq('a code already in the library is not re-imported, whatever its case', plan.known.map((i) => i.code), ['6K0BFI000PCLSC7KHDQMK']);
eq('new codes are offered', plan.fresh.length, 3);
const row = HQ.toPresetRow(solItems[1]);
eq('vault row is a preset tagged hq', [row.kind, row.source, row.tags[0]], ['preset', 'hq', 'hq']);
check('vault row never carries a cost', !('cost' in row) && !('price' in row) && !('hq_cost' in row));

/* ── prices from the logged-in API response ────────────────────────────── */
/* hq-api-capture.json holds every code, mode and price ListGunCodeSchemes
 * returned in the 2026-09-30 logged-in capture: 10 Operations schemes with a
 * real price, 5 Warfare schemes answering -1. Its codes are the same sets the
 * static op_sol_ga_vi / op_mp_ga_vi files served that day and still serve. */
const capture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hq-api-capture.json'), 'utf8'));
const [solReply, mpReply] = capture.responses;
const expectedSol = Object.fromEntries(solReply.data.items.map((i) => [i.gun_code, i.price]));
check('capture has 10 Operations and 5 Warfare schemes', solReply.data.items.length === 10 && mpReply.data.items.length === 5
  && solReply.data.items.every((i) => i.mode === 'sol') && mpReply.data.items.every((i) => i.mode === 'mp'));
check('every captured Operations price is inside the accepted range',
  Object.values(expectedSol).every((p) => p >= HQ.MIN_PRICE && p <= HQ.MAX_PRICE), JSON.stringify(expectedSol));
eq('Operations prices are read from the captured reply', HQ.sanitizePrices(solReply), expectedSol);
eq('captured prices: AS Val 588375 and 741408', [expectedSol['6JLGT7C02VAL71CR2QP7Q'], expectedSol['6K0BFI000PCLSC7KHDQMK']], [588375, 741408]);
eq('Warfare "-1" is not a price', HQ.sanitizePrices(mpReply), {});
/* The capture kept prices as numbers; it did not record whether the wire sent
 * a JSON number or a numeric string, so the same reply as strings must agree. */
const asStrings = JSON.parse(JSON.stringify(solReply, (k, v) => (k === 'price' ? String(v) : v)));
eq('the same reply with string prices reads identically', HQ.sanitizePrices(asStrings), expectedSol);
const fixtureCodes = ['hq-op_sol_ga_vi.js', 'hq-op_mp_ga_vi.js'].map((f) =>
  HQ.normalizeSchemes(HQ.parseSchemeFile(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8')), 'x').map((r) => r.code));
check('every static-file fixture code is one the API capture returned',
  fixtureCodes[0].every((c) => c in expectedSol) && fixtureCodes[1].every((c) => mpReply.data.items.some((i) => i.gun_code === c)));
check('no static-file Warfare code receives a price', fixtureCodes[1].every((c) => !(c in HQ.sanitizePrices(capture))));
eq('implausible prices are refused', HQ.sanitizePrices([{ code: '6JLGT7C02VAL71CR2QP7Q', price: 5 }, { code: '6K0BFI000PCLSC7KHDQMK', price: 1e12 }, { code: '6JVQNTS04Q5HR1E25MVF2', price: 1.5 }]), {});
eq('a counter-style reply nested one level deeper is still read', HQ.sanitizePrices({ code: 0, data: { detail: { gun_code: 'X-y-6JLGT7C02VAL71CR2QP7Q', price: 600000 } } }), { '6JLGT7C02VAL71CR2QP7Q': 600000 });
eq('hostile input does not throw', HQ.sanitizePrices('not json'), {});
const cyclic = { a: {} };
cyclic.a.b = cyclic;
eq('a cyclic object terminates', HQ.sanitizePrices(cyclic), {});

const merged = HQ.mergePrices(
  { '6JLGT7C02VAL71CR2QP7Q': { price: 500000, seen_at: '2026-01-01T00:00:00.000Z' }, bogus: { price: 1 } },
  { '6JLGT7C02VAL71CR2QP7Q': 588375 },
  '2026-09-30T00:00:00.000Z',
);
eq('newest price wins and malformed keys are dropped', merged, { '6JLGT7C02VAL71CR2QP7Q': { price: 588375, seen_at: '2026-09-30T00:00:00.000Z' } });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
