# v3.3.4 — HQ price references and single-line cost rows

Delta Force gift-code and Gunsmith-preset manager. Four delivery shapes from one core: a DevTools paste-in console script, a Tampermonkey userscript, an unpacked MV3 Chrome extension, and a headless build.

v3.3.4 adds read-only HQ price references to Gunsmith cards and keeps the Campaign cost row readable on the full page and redeem-page drawer. An HQ snapshot is visibly a reference, not a measured community cost: it never pre-fills the editor, saves as a cost, or overwrites a measured value.

## HQ price references

- Gunsmith cards with no measured Campaign cost now show the stored HQ figure as a dimmed `≈ <price>` value with a dashed **Giá HQ** badge.
- Tooltips include the capture date and explain that the HQ figure is reference-only.
- HQ prices are read through the worker and bridge, loaded on startup and after a late response, and kept separate from `costFor()` and shared cost records.
- A measured Campaign cost always wins; Warfare cards remain unchanged.

## Preset cost rows

- Cost, value, agreement badge and **Sửa** / **+ Thêm** now stay on one line at 1280px and other tablet/desktop widths, including the widest supported cost and status variants.
- Preset tracks use a 262px minimum where needed, with a one-column fallback for narrow pages. The shared drawer grid uses the same minimum and naturally collapses from two columns before rows wrap.
- Only the cost-row action uses tighter side padding; other buttons keep their existing hit targets.

## How it was verified

- `npm test`: 19 suites, 561 passed. New regression tests cover the full-page and drawer track minimums and the cost-action cascade.
- `npm run build`: v3.3.4 generated all committed delivery artifacts; 11 generated scripts parse successfully.
- `tools/verify-ui.js`: 19/19 live Chrome checks passed on app.html, popup and options.
- `tools/validate-data.js`: 314 codes, 21 presets, no account-specific data.
- `tools/audit-css.js`: the same five pre-existing unstyled utility classes as v3.3.3; no new finding from this release.
- Preset cost measurement in isolated Chrome at 1920, 1440, 1366, 1280, 1024, 768, 390 and 360px found no wrapped rows. Probes covered the 7-digit cap, every agreement badge, and 7-digit HQ values.
- Redeem-page drawer measurement at the same desktop/tablet/mobile widths found no wrapped rows after the shared-grid fix.
- Controlled mutation checks caught the old 230px/240px grid minima, the weaker button selector, and the 11px padding regression.

## Install

Unpacked extension: download `df-redeem-extension-v3.3.4.zip`, unzip it, then `chrome://extensions` → Developer mode → Load unpacked, and pick the unzipped folder (`manifest.json` is at the root). The extension ID is pinned by a `key` field in the manifest, so your vault survives replacing the folder. If you load the extension from a clone, `git pull` and press **Reload** on its card instead.

Userscript: install `df-redeem.user.js` in Tampermonkey. Console: paste `df-redeem.console.js` into DevTools on the redeem page.

Verify downloads against `SHA256SUMS.txt` (`sha256sum -c SHA256SUMS.txt`).

**Full changelog**: https://github.com/huuhungn/df-redeem/compare/v3.3.3...v3.3.4
