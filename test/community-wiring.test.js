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

const returnsRecords = /return \{ records: \[\.\.\.byCode\.values\(\)\], added, updated \}/.test(syncSrc);
check('mergeCommunityCodes returns a records array', returnsRecords);

check('panel iterates merged.records, not merged.rows',
  /for \(const row of merged\.records\)/.test(panelSrc) && !/merged\.rows/.test(panelSrc),
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

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
