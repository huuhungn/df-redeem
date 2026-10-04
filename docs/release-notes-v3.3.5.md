# v3.3.5 — 35 Operations Gunsmith presets with build labels

Delta Force gift-code and Gunsmith-preset manager. Four delivery shapes from one core: a DevTools paste-in console script, a Tampermonkey userscript, an unpacked MV3 Chrome extension, and a headless build.

v3.3.5 ships 35 new Chiến Dịch (Thoát Hiểm) Gunsmith presets and adds build labels, so several presets for the same weapon are easy to tell apart. The bundled library grows from 21 to 56 presets. Gift codes are unchanged.

This is the first published release since v3.3.3, so it also includes the v3.3.4 changes: read-only HQ price references on Gunsmith cards and single-line Campaign cost rows. v3.3.4 is tagged but has no separate release; see [its notes](https://github.com/huuhungn/df-redeem/blob/v3.3.5/docs/release-notes-v3.3.4.md).

## New presets

- 35 user-submitted Operations presets across 20 weapons: MK4, AKM, AK-12, AR-57, AS Val, MK47, AUG, CI-19, K416, K437, KC17, M4A1, M7, QBZ95-1, QCQ171, M249, QJB201, SVD, M700 and Thompson.
- The new presets ship unverified with no cost. They were submitted rather than checked by the maintainer, and their in-game prices have not been measured yet.

## Build labels

- A preset can carry an optional build label, such as `Eco`, `Nhạc`, `Full-burst` or `Newbie 2`. It appears as a small chip beside the weapon name and does not change how the weapon is named or grouped.
- Preset search matches labels, so typing `Newbie 2` finds that M4A1 build.
- Preset search ignores case and Vietnamese accents, so `nhac` finds the `Nhạc` builds and `tay den` finds Tay Đen.
- Labels survive vault storage, CSV/JSON export and import, and the published `data/presets.json`.
- Short weapon names drop the catalogue class suffix, so `SVD Sniper Rifle`, grouped as a marksman rifle, now reads `SVD`.

## Upgrading

- Existing installs receive only presets they don't have yet, matched by code. Gift-code verdicts, redeem history, labels you edited and measured costs are never replayed or overwritten.

## How it was verified

- `npm test`: 20 suites, 569 passed. A new preset-batch suite pins every submitted code, weapon and label in the seed and published data, and covers the additive upgrade path.
- `npm run build`: v3.3.5 generated all committed delivery artifacts; 11 generated scripts parse successfully.
- `tools/verify-ui.js`: 19/19 live Chrome checks passed on app.html, popup and options, with 56 preset cards rendered.
- `tools/validate-data.js`: 324 codes, 56 presets, no account-specific data.
- `tools/make-public-data.js` regenerates `data/presets.json` with identical rows in the same order.
- `tools/audit-css.js`: the same five pre-existing unstyled utility classes as v3.3.4; this release adds no new finding.
- In the loaded extension, **Copy** on a new MK4 preset put exactly `6LFI0L80AHP1JR9CHG3OI` on the clipboard and showed the confirmation toast.
- An isolated layout check at 1440px, 1264px and 390px found no horizontal overflow. Search and weapon-class filtering returned the expected cards.

## Install

Unpacked extension: download `df-redeem-extension-v3.3.5.zip`, unzip it, then `chrome://extensions` → Developer mode → Load unpacked, and pick the unzipped folder (`manifest.json` is at the root). The extension ID is pinned by a `key` field in the manifest, so your vault survives replacing the folder. If you load the extension from a clone, `git pull` and press **Reload** on its card instead.

Userscript: install `df-redeem.user.js` in Tampermonkey. Console: paste `df-redeem.console.js` into DevTools on the redeem page.

Verify downloads against `SHA256SUMS.txt` (`sha256sum -c SHA256SUMS.txt`).

**Full changelog**: https://github.com/huuhungn/df-redeem/compare/v3.3.3...v3.3.5
