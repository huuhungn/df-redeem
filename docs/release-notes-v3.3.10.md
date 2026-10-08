# v3.3.10 — A fresh install queues every redeemable code

Delta Force gift-code and Gunsmith-preset manager. Four delivery shapes from one core: a DevTools paste-in console script, a Tampermonkey userscript, an unpacked MV3 extension, and a hosted app page.

v3.3.10 fixes two problems: a new player started with an almost empty Mã chưa thử queue, and an OCR misread could be published to the community list as a success.

## What was wrong

- **A fresh install had almost nothing to try.** The bundled seed is a snapshot of the author's own vault. Its `success` and `mine` rows describe the author's account, so a new player imported them as already done, although every one of those codes still redeems on a new account.
- **The seed had fallen behind.** It lacked 30 codes the community has since confirmed, still listed 4 dead codes as successes, and stored `DFCatalyst87` in a spelling Garena rejects.
- **A misread could be published as a success.** When a queued code was rejected and an OCR variant redeemed, the community report carried the queued spelling, not the one Garena accepted. That is how `DFOSS260404857`, a misread of `DFOSS260404B57`, reached the public list.

## What changed

- **Seed v3: 334 codes, 237 redeemable.**
  - Adds 30 community-confirmed codes, each in the spelling Garena accepts.
  - Marks 4 dead codes from the 2026-10-06 fresh-account run: `DFUTS26QL3101C38` as `gift_bug` and 3 others as `expired`.
  - Renames `DFCatalyst87` to `DFCATALYST87`; the all-caps spelling redeems.
- **The author's verdicts no longer travel.** The seed's `success` and `mine` rows are imported as Chưa thử. Dead verdicts such as `expired` and `gift_bug` are true for every account and carry over unchanged.
- **Your own results are never overwritten.** When the seed version changes, a code you tried yourself keeps its status: either it has an attempt in this install's history, or its last attempt is newer than the seed's. A restored backup counts too. Codes you never tried take the seed's spelling, because Garena matches case-sensitively.
- **Community reports carry the accepted spelling.** When an OCR variant redeems, the report sends that variant. A queued row and the row for its variant count as one redemption, and only the most recent attempt is reported.

## Upgrading

- Reload the extension, then reload any open Delta Force tab and app page so they pick up the new build.
- The seed upgrade runs once, the first time the panel opens. Mã chưa thử then lists the redeemable codes you have not tried. Your existing results are kept.

## Verification

- `npm test`: 24 suites, 627 passed, 0 failed.
- 22 new tests:
  - `test/clean-install-queue.test.js` checks a fresh install against a frozen 237-code fixture, and checks that a v2 → v3 upgrade keeps player verdicts.
  - `test/variant-report.test.js` covers the reported spelling, deduplication, and newest-attempt selection.
- Two consecutive builds are byte-identical.
