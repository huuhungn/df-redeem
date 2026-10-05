# v3.3.8 — The full-page app shows sync status, and every surface keeps it current

Delta Force gift-code and Gunsmith-preset manager. Four delivery shapes from one core: a DevTools paste-in console script, a Tampermonkey userscript, an unpacked MV3 extension, and a hosted app page.

v3.3.8 finishes the sync work started in v3.3.7: the full-page app now shows the sync state next to its backup button, and both the app and the in-page drawer follow a backup started anywhere else.

## What was wrong

- **The app page had a backup button but no status.** app.html hides the drawer, so the drawer's sync chip was never visible there. Pressing ☁ gave no lasting sign of whether the backup worked.
- **The chip only followed backups started in the same panel.** A backup from the popup, Options, another tab, or a change to the sync settings left the chip stale until the panel was reopened.
- **A slow status read could overwrite a newer state.** Two overlapping refreshes painted in arrival order, so an older "Đã đồng bộ" could replace "Đang đồng bộ…".
- **Success was assumed.** Any reply without an explicit error toasted "Đã đồng bộ", even when the backup had not confirmed.
- **The app button clicked the hidden drawer button** instead of calling the panel action, so its feedback depended on hidden DOM.
- **The chip styles lived only in the drawer stylesheet,** and the app header stacked its actions in a column.

## What changed

- **Sync chip on the app page.** The page header shows Đã đồng bộ, Đang đồng bộ…, Lỗi đồng bộ, Chưa đồng bộ or Đã tắt đồng bộ beside the ☁ button, on one row with Tải lại.
- **Live updates from storage.** The extension page and the content-script bridge listen for changes to the sync status and sync settings, then ask the worker for the current public status. The bridge only posts an invalidation message to the page; settings values, which can hold credentials, never cross into the page world.
- **Newest state wins.** Each refresh carries a revision; a reply that arrives after a newer refresh is dropped.
- **Honest feedback.** The success toast appears only for a confirmed `ok` status. An unconfirmed reply shows a warning, and a thrown error marks the chip as an error.
- **One guarded action.** `panel.syncNow()` is public. The app button calls it directly, and the button is disabled while a backup runs or when personal sync is switched off.
- **Accessible status.** The chip is a polite live region, so screen readers announce state changes without interrupting.
- **Shared styles.** The chip and its states moved to the shared component stylesheet used by the drawer and the app page.

## Upgrading

- Reload the extension, then reload any open Delta Force tab and app page so they pick up the new build.
- Nothing is migrated. Gift-code verdicts, redeem history, labels, costs and sync settings are untouched.

## Verification

- `npm test`: 22 suites, 589 passed.
- New `test/sync-wiring.test.js` runs the generated app bootstrap and bridge relay: a storage change refreshes the chip, the app button calls `panel.syncNow()`, and the bridge posts no storage values. It also checks that the shared CSS styles every chip state and lays the page actions out as one row.
- Two consecutive builds produce byte-identical outputs.
