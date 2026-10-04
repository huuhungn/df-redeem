# v3.3.7 — Sync status that updates itself, and a manual backup button

Delta Force gift-code and Gunsmith-preset manager. Four delivery shapes from one core: a DevTools paste-in console script, a Tampermonkey userscript, an unpacked MV3 extension, and a hosted app page.

v3.3.7 fixes the sync chip staying stale after a backup, and adds a way to back the personal vault up without running a redeem queue.

## What was wrong

- The sync chip was painted once, when the panel opened. A backup that finished afterwards — the automatic one at the end of a redeem run, or one started from Options or the popup — left the chip showing the old state until the panel was opened again.
- The only personal backup happened automatically at the end of a run. Codes imported or edited outside a run, and a sync that had failed, could not be pushed until the next run.

## What changed

- **The chip follows the backup.** When the post-run backup finishes, the chip reads the status that backup returned instead of waiting for the next open. Other surfaces can push the same update through `panel.refreshSync()`.
- **Đồng bộ ngay.** A header button (and a command-palette entry) backs the whole vault up on demand, shows "Đang đồng bộ…" while it runs, then the result. A second click during a running backup is ignored, and the button says so when personal sync is switched off in Settings.
- **The full-page app gets the same button.** app.html hides the drawer, so its page header carries its own Đồng bộ ngay button and routes the click to the panel's action.

## Upgrading

- Reload the extension, then reload any open Delta Force tab so it picks up the new build.
- Nothing is migrated. Gift-code verdicts, redeem history, labels and costs are untouched.

## Verification

- `npm test`: 21 suites, 584 passed.
- New regression tests: the chip moves from "Chưa đồng bộ" to "Đã đồng bộ" the moment a run's backup finishes and follows a status reported by another surface; Đồng bộ ngay pushes every stored record exactly once, confirms in a toast, and refuses a second click while a backup is running; app.html ships the button and routes it to the panel action.
