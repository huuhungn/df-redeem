/* Guards against two bugs that shipped past the unit tests because both only
 * appeared once the built bundle ran in a real page.
 *
 * 1. panel.js consumed merge results as `.rows` while sync.js returns `.records`,
 *    so every community pull threw "merged.rows is not iterable". The unit tests
 *    passed because they called the merge helper directly and never went through
 *    the panel's handler.
 * 2. The console and userscript targets called createPanel without `sync`, so the
 *    community card rendered but both its buttons silently did nothing.
 *
 * These assert against the generated artifacts, which is where the mismatch lived.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log('ok   ' + name); }
  else { failed += 1; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

/* ── the merge contract panel.js relies on ──────────────────────────────── */
const syncSrc = read('src/core/sync.js');
const panelSrc = read('src/ui/panel.js');

const returnsRecords = /return \{ records: \[\.\.\.byCode\.values\(\)\], changedRecords, added, updated \}/.test(syncSrc);
check('mergeCommunityCodes returns records plus changed records for persistence', returnsRecords);

check('panel persists changed records without traversing the full merge result',
  /for \(const row of merged\.changedRecords \|\| \[\]\)/.test(panelSrc) && !/merged\.rows/.test(panelSrc),
  (panelSrc.match(/merged\.\w+/g) || []).join(','));

/* ── every target that shows the card must be able to use it ────────────── */
const CARD = 'Kho cộng đồng';
const targets = [
  ['dist/df-redeem.console.js', 'console'],
  ['dist/df-redeem.user.js', 'userscript'],
  ['extension/content.js', 'extension drawer'],
];

for (const [file, label] of targets) {
  let src;
  try { src = read(file); } catch (_) { check(`${label} bundle exists`, false, file + ' missing — run node build.js'); continue; }

  const showsCard = src.includes(CARD);
  /* The card is only meaningful with a sync object wired into createPanel. */
  const wiresSync = /createPanel\(\{[^}]*\bsync\b/.test(src);
  check(`${label} wires sync when it renders the community card`,
    !showsCard || wiresSync,
    JSON.stringify({ showsCard, wiresSync }));
}

/* The buildless targets have no service worker, so they must talk to the
 * endpoints directly rather than through a bridge that does not exist. */
for (const [file, label] of [['dist/df-redeem.console.js', 'console'], ['dist/df-redeem.user.js', 'userscript']]) {
  let src;
  try { src = read(file); } catch (_) { continue; }
  check(`${label} calls the sync service directly`,
    /DFRedeemSync\.createSyncService/.test(src) && !/askBridge\('communityPull'\)/.test(src),
    JSON.stringify({
      direct: /DFRedeemSync\.createSyncService/.test(src),
      bridged: /askBridge\('communityPull'\)/.test(src),
    }));
}

/* The extension keeps using the worker: it holds the host permissions. */
const bg = read('extension/background.js');
check('extension routes community calls through the service worker',
  /communityPull/.test(bg),
  'background.js must handle communityPull');

/* ── every Garena error code must be classified by the worker ───────────── */
/* 400070 ("The end time has passed") existed in neither table, so a live run
 * showed "Mã lỗi chưa biết" and the verdict was never publishable. Any code
 * garena.js knows about must land in exactly one worker bucket. */
const garenaSrc = read('src/core/garena.js');
const verdictSrc = read('worker/src/verdicts.js');

const knownCodes = [...garenaSrc.matchAll(/^\s{2}(\d{2,6}):\s*\{\s*status:/gm)].map((m) => Number(m[1]));
check('garena.js error table was parsed', knownCodes.length >= 12, 'found ' + knownCodes.length);

const bucket = (code) => {
  const inVerdict = new RegExp('\\[' + code + ',\\s*\'').test(verdictSrc);
  const perAccount = new RegExp('PER_ACCOUNT = new Set\\(\\[[^\\]]*\\b' + code + '\\b').test(verdictSrc);
  const transient = new RegExp('TRANSIENT = new Set\\(\\[[^\\]]*\\b' + code + '\\b').test(verdictSrc);
  return [inVerdict && 'publishable', perAccount && 'per-account', transient && 'transient'].filter(Boolean);
};

const unclassified = knownCodes.filter((c) => bucket(c).length === 0);
const doubleBooked = knownCodes.filter((c) => bucket(c).length > 1);

check('every garena.js error code is classified by the worker',
  unclassified.length === 0,
  'unclassified: ' + unclassified.join(','));
check('no error code sits in two worker buckets',
  doubleBooked.length === 0,
  'double-booked: ' + doubleBooked.join(','));

/* The code the live run actually returned, pinned by number. */
check('400070 is treated as expired',
  /\[400070, 'expired'\]/.test(verdictSrc) && /400070: \{ status: 'EXPIRED'/.test(garenaSrc));

/* ── every helper the panel calls must exist on the sync object it is given ──
 * The unit tests stub `sync` with exactly the methods the test needs, so a
 * panel call to a method no real target provides passes there and fails only
 * in the browser. Local costs shipped that way: panel.js persisted them via
 * opts.sync.setLocal, which neither the drawer nor the full-page app exposed,
 * so every unsent cost vanished on reload with no error anywhere. */
const panelSyncCalls = [...new Set(
  (panelSrc.match(/opts\.sync\.(\w+)/g) || []).map((m) => m.split('.').pop()),
)];
check('panel sync calls were found to check', panelSyncCalls.length >= 4, panelSyncCalls.join(','));

for (const [file, label] of [['extension/content.js', 'extension drawer'], ['extension/app.js', 'full-page app']]) {
  let src;
  try { src = read(file); } catch (_) { check(`${label} bundle exists`, false, file + ' missing — run node build.js'); continue; }
  /* Scope the search to the sync object literal itself. Searching the whole
   * bundle gives false passes: `status:` also appears in unrelated payloads
   * like `{ code: r.code, status: r.status }`, which hid the full-page app
   * shipping without sync.status — the sync chip there silently stayed blank. */
  const open = src.indexOf('const sync = {');
  check(`${label} declares a sync object literal`, open >= 0, 'no `const sync = {` in ' + file);
  if (open < 0) continue;
  let depth = 0; let end = -1;
  for (let i = src.indexOf('{', open); i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  check(`${label} sync literal is balanced`, end > open, 'could not find the closing brace');
  if (end <= open) continue;
  const syncBlock = src.slice(open, end + 1);
  /* Only TOP-LEVEL keys count. Nested payloads inside a method body also match
   * `name:` — `syncNow` maps records to `{ code: r.code, status: r.status }`,
   * which made a missing top-level `status` look present. Walk the literal and
   * collect keys at brace depth 1, outside strings. */
  const provided = new Set();
  let d = 0; let quote = '';
  for (let i = syncBlock.indexOf('{'); i < syncBlock.length; i += 1) {
    const ch = syncBlock[i];
    if (quote) { if (ch === quote && syncBlock[i - 1] !== '\\') quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') { d += 1; continue; }
    if (ch === '}' || ch === ')' || ch === ']') { d -= 1; if (d === 0) break; continue; }
    if (d === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(syncBlock.slice(i));
      if (m) { provided.add(m[1]); i += m[0].length - 1; }
    }
  }
  const missing = panelSyncCalls.filter((name) => !provided.has(name));
  check(`${label} provides every sync method the panel calls`,
    missing.length === 0,
    'missing: ' + missing.join(','));
}

/* Every awaited sync call in the panel must sit inside a try, because the two
 * transports fail differently: the app's chrome.runtime.sendMessage RESOLVES
 * with { ok: false }, while the drawer's askBridge REJECTS. Code that only
 * inspects reply.ok therefore handles the app and lets the drawer escape as an
 * unhandled rejection — no toast, no error, the user just sees nothing happen.
 * Guarding one shape without the other is exactly the silent-failure class this
 * file exists to catch. */
{
  const panelSrc = read('src/ui/panel.js');
  const panelLines = panelSrc.split('\n');
  const unprotected = [];
  for (let i = 0; i < panelLines.length; i += 1) {
    const line = panelLines[i];
    if (!/await\s+opts\.sync\.[a-zA-Z]+\(/.test(line)) continue;
    /* Same-line try{...}catch wraps the call outright. */
    if (/\btry\s*\{/.test(line)) continue;
    /* Otherwise scan the text before this call and count try/catch pairs at the
     * brace depth we are currently in: an unmatched `try {` means we are inside
     * one. Counting braces alone was too crude and flagged calls that sit in a
     * plainly visible try block. */
    const before = panelLines.slice(0, i).join('\n');
    const tries = (before.match(/\btry\s*\{/g) || []).length;
    const catches = (before.match(/\}\s*catch\b/g) || []).length;
    if (tries > catches) continue;
    unprotected.push((i + 1) + ': ' + line.trim().slice(0, 60));
  }
  check('every awaited panel sync call is inside a try',
    unprotected.length === 0,
    'a rejecting transport would escape at — ' + unprotected.join(' | '));
}

/* Storage the panel asks the worker to keep must round-trip through a handled
 * op, or the write silently returns "Lệnh không hợp lệ" and the state is lost. */
const bgSrc = read('extension/background.js');
for (const op of ['getPanelState', 'setPanelState']) {
  check(`background handles ${op}`,
    new RegExp("op === '" + op + "'").test(bgSrc),
    'no handler branch in background.js');
}

/* ── every bridge op the bundles send must have a handler ───────────────────
 * The `X && X.method` pattern above protects the *caller*; this protects the
 * other end of the same wire. An op with no branch falls through to the
 * "unknown op" reply, which the panel's guards swallow just as quietly — the
 * sync chip stayed blank in the full-page app for exactly that reason. */
for (const [file, label] of [['extension/content.js', 'extension drawer'], ['extension/app.js', 'full-page app']]) {
  let src;
  try { src = read(file); } catch (_) { continue; }
  /* Two call shapes ship today: the app sends `{ op: 'name' }` objects, the
   * drawer funnels through `askBridge('name')`. Collect both, or a bundle with
   * only one shape reports zero ops and the check quietly proves nothing. */
  const ops = [...new Set([
    ...[...src.matchAll(/op:\s*'([a-zA-Z][\w]*)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/askBridge\(\s*'([a-zA-Z][\w]*)'/g)].map((m) => m[1]),
  ])];
  check(`${label} sends at least one bridge op`, ops.length > 0, 'found none');
  const unhandled = ops.filter((op) => !new RegExp("op === '" + op + "'").test(bgSrc));
  check(`${label} only sends bridge ops background.js handles`,
    unhandled.length === 0,
    'unhandled: ' + unhandled.join(','));
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
