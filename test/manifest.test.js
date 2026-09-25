#!/usr/bin/env node
/* test/manifest.test.js — guard the shipped MV3 manifest and icon set.
 *
 * build.js emits manifest.json from a JS object, so a typo there produces a
 * manifest Chrome silently refuses to load ("Could not load icon", "Invalid
 * value for 'minimum_chrome_version'") and the only symptom is that the drawer
 * never appears. These checks run against the built artefact, not the source
 * object, so they also catch a build step that forgets to write a file.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log('ok   ' + name); } else {
    failed += 1;
    console.log('FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
};

/* Build first so the test never passes against a stale artefact. */
try {
  execFileSync(process.execPath, [path.join(ROOT, 'build.js')], { cwd: ROOT, stdio: 'pipe' });
} catch (err) {
  console.log('FAIL build.js must succeed before manifest checks — '
    + String((err.stderr || err.message || '')).trim().split('\n').slice(-3).join(' | '));
  console.log('1 passed, 1 failed, 2 total');
  process.exit(1);
}

const manifestPath = path.join(EXT, 'manifest.json');
let m = null;
try {
  m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.log('FAIL manifest.json must be valid JSON — ' + err.message);
  console.log('0 passed, 1 failed, 1 total');
  process.exit(1);
}

check('manifest is MV3', m.manifest_version === 3, String(m.manifest_version));

/* build.js is the single source of the version; assert the emitted manifest
 * matches it so a hand-edited manifest cannot drift from the built bundles. */
const buildSrc = fs.readFileSync(path.join(ROOT, 'build.js'), 'utf8');
const buildVersion = (buildSrc.match(/^const VERSION = '([^']+)'/m) || [])[1];
check('version matches build.js VERSION',
  buildVersion && m.version === buildVersion, m.version + ' vs ' + buildVersion);
check('version is a valid Chrome version string',
  /^\d+(\.\d+){0,3}$/.test(m.version || ''), m.version);

/* Chrome clips the name in the toolbar tooltip and the extensions page. */
check('short_name is present and short enough',
  typeof m.short_name === 'string' && m.short_name.length > 0 && m.short_name.length <= 12,
  JSON.stringify(m.short_name));
check('description fits the extensions-page limit',
  typeof m.description === 'string' && m.description.length <= 132,
  'length ' + (m.description || '').length);

/* Every declared icon must exist: a missing path blocks the whole install. */
const declared = new Set([
  ...Object.values(m.icons || {}),
  ...Object.values((m.action && m.action.default_icon) || {}),
  ...((m.web_accessible_resources || []).flatMap((w) => w.resources || [])),
]);
const missing = [...declared].filter((rel) => !fs.existsSync(path.join(EXT, rel)));
check('every declared icon/resource file exists', missing.length === 0, missing.join(', '));

const tiny = [...declared].filter((rel) => {
  const f = path.join(EXT, rel);
  return fs.existsSync(f) && fs.statSync(f).size < 100;
});
check('no declared icon is a stub placeholder', tiny.length === 0, tiny.join(', '));

/* 16 and 32 are the toolbar slots; without them Chrome downscales the 128. */
check('toolbar icon sizes 16 and 32 are declared',
  m.icons && m.icons['16'] && m.icons['32'], JSON.stringify(Object.keys(m.icons || {})));

/* Icons must actually be square PNGs of the size they claim. A rename or a bad
 * export yields a 48px file at the 128 slot, which Chrome renders blurred. */
const pngSize = (file) => {
  const buf = fs.readFileSync(file);
  /* PNG IHDR: width at byte 16, height at 20, big-endian. */
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
};
const wrongSize = [];
for (const [size, rel] of Object.entries(m.icons || {})) {
  const dim = pngSize(path.join(EXT, rel));
  if (!dim || dim.w !== Number(size) || dim.h !== Number(size)) {
    wrongSize.push(`${rel} is ${dim ? dim.w + 'x' + dim.h : 'not a PNG'}, expected ${size}x${size}`);
  }
}
check('each icon PNG is square and matches its declared size',
  wrongSize.length === 0, wrongSize.join('; '));

/* The 16px mark is hand-plotted for symmetry; assert it really is mirrored so a
 * future edit to make-icons.py cannot quietly ship a lopsided toolbar icon. */
const icon16 = path.join(EXT, 'icons', 'icon16.png');
let symmetric = null;
try {
  const out = execFileSync('python', ['-c', `
import sys
from PIL import Image
im = Image.open(r'${icon16}').convert('RGBA')
w, h = im.size
px = im.load()
bad = 0
for y in range(h):
    for x in range(w // 2):
        if px[x, y] != px[w - 1 - x, y]:
            bad += 1
print(bad)
`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  symmetric = Number(String(out).trim());
} catch {
  symmetric = -1; /* Pillow unavailable: skip rather than fail the suite. */
}
if (symmetric >= 0) {
  check('the 16px icon is left-right symmetric', symmetric === 0, symmetric + ' mismatched pixels');
} else {
  console.log('skip the 16px symmetry check (Pillow not installed)');
}

/* Declaring the default policy documents that no remote script is needed. */
check('an explicit extension_pages CSP is declared',
  m.content_security_policy && typeof m.content_security_policy.extension_pages === 'string',
  JSON.stringify(m.content_security_policy));
check('the CSP allows no remote or eval script',
  /script-src 'self'/.test((m.content_security_policy || {}).extension_pages || '')
  && !/unsafe-eval|https?:/.test((m.content_security_policy || {}).extension_pages || ''),
  (m.content_security_policy || {}).extension_pages);

/* `world: 'MAIN'` content scripts need Chrome 111; below that the panel never
 * mounts and the failure looks like a broken extension. */
check('minimum_chrome_version covers world:MAIN support',
  Number(m.minimum_chrome_version) >= 111, String(m.minimum_chrome_version));
const mainWorld = (m.content_scripts || []).some((cs) => cs.world === 'MAIN');
check('the panel content script still runs in the MAIN world', mainWorld === true);

/* Host permissions are the extension's whole data-egress surface. */
const hosts = m.host_permissions || [];
check('host permissions stay narrow (no <all_urls> or bare wildcard)',
  hosts.length > 0 && !hosts.some((h) => /<all_urls>|^\*:\/\/\*\//.test(h)),
  JSON.stringify(hosts));
check('the redeem page and the vault hosts are permitted',
  hosts.some((h) => h.includes('redeem.df.garena.sg'))
  && hosts.some((h) => h.includes('workers.dev'))
  && hosts.some((h) => h.includes('raw.githubusercontent.com')),
  JSON.stringify(hosts));

/* Web-accessible resources must not be exposed to every site. */
for (const entry of m.web_accessible_resources || []) {
  check('web-accessible resources are restricted to the redeem page',
    (entry.matches || []).every((h) => h.includes('redeem.df.garena.sg')),
    JSON.stringify(entry.matches));
}

/* options_page is legacy; options_ui is the MV3 form and lets it open in a tab. */
check('options use the MV3 options_ui form',
  m.options_ui && m.options_ui.page === 'options.html' && m.options_page === undefined,
  JSON.stringify({ options_ui: m.options_ui, options_page: m.options_page }));

/* Everything the manifest points at must be in the built folder. */
const referenced = [
  m.background && m.background.service_worker,
  m.action && m.action.default_popup,
  m.options_ui && m.options_ui.page,
  ...(m.content_scripts || []).flatMap((cs) => cs.js || []),
].filter(Boolean);
const missingFiles = referenced.filter((rel) => !fs.existsSync(path.join(EXT, rel)));
check('every script/page named in the manifest was built',
  missingFiles.length === 0, missingFiles.join(', '));

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
