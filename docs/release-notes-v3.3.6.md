# v3.3.6 — One copy of every Gunsmith preset

Delta Force gift-code and Gunsmith-preset manager. Four delivery shapes from one core: a DevTools paste-in console script, a Tampermonkey userscript, an unpacked MV3 Chrome extension, and a headless build.

v3.3.6 fixes duplicate Gunsmith presets and closes the paths that created them. A preset code is now one identity regardless of letter case, full-width characters or hidden whitespace, so `abcd…` and `ABCD…` can no longer sit side by side in the library. The bundled library is unchanged: 56 presets, 324 gift codes.

## What was wrong

- Preset codes were compared exactly as typed, so the same code saved once in upper case and once in lower case became two cards.
- A preset is stored in two halves (its redemption record and its build details). Some writes created one half without the other, so a code could show up as a half-empty duplicate.
- Imports from HQ, CSV, JSON and paste could overwrite a preset that had been saved a moment earlier in another tab.

## What changed

- **One identity per code.** Every preset write is case-insensitive and folds full-width characters and invisible spaces. Both halves of a preset and the "does it already exist?" check are written in a single database transaction, so two tabs importing the same code cannot both insert it.
- **Imports add, never overwrite.** HQ, CSV, JSON and paste imports skip a preset you already have and report it as skipped, so a build you saved keeps its label, cost and history.
- **Imports are all or nothing.** If one row of a CSV or backup is invalid, nothing is saved and the error names the bad rows.
- **Existing duplicates are repaired on startup.** Each set of variants is merged into one preset under the upper-case code:
  - The redemption history (status, attempts, last tried, result) is kept whole from the variant that was actually tried. It is never stitched together from different variants.
  - The build details keep the canonical spelling first; a price and its confirmation state stay together.
  - Every merged-away variant and every value that disagreed is kept in an archive, with the spelling it came from.
- **Old tabs are retired.** The database version moves to 6. A tab still running an older build is disconnected and cannot reopen the vault, so it cannot write a lower-case copy back. Reload such tabs after upgrading.
- **Backups keep everything.** CSV export now includes `cost` and `cost_state`. JSON export includes the repair archive, and restoring that backup on another machine keeps it.

## Maintainers

- The preset approval workflow passes parsed issue values to the add-preset step through environment variables instead of inlining them into the shell script.

## Upgrading

- Open the panel once after updating. The repair runs automatically and is safe to run again; a library without duplicates is left untouched.
- Reload any other open Delta Force tabs so they pick up the new build.
- Gift-code verdicts, redeem history, labels and costs you entered are preserved.

## Verification

- `npm test`: 21 suites, 581 passed.
- New regression tests cover coherent history repair, a variant written later by an old build, an append-only archive, all-or-nothing imports, CSV cost round trip, JSON archive round trip, and an HQ import racing a save from another tab. The HQ test fails when the insert-only guard is removed.
- `tools/validate-data.js`: 324 codes, 56 presets, 56 unique preset identities.
