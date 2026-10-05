# v3.3.9 — A new backup destination starts clean, and network errors read in Vietnamese

Delta Force gift-code and Gunsmith-preset manager. Four delivery shapes from one core: a DevTools paste-in console script, a Tampermonkey userscript, an unpacked MV3 extension, and a hosted app page.

v3.3.9 fixes two problems with the personal backup status: a stale error that survived a change of destination, and network errors shown in the browser's English.

## What was wrong

- **The old error outlived the fix.** Saving a new backend, endpoint or token stored the settings but kept the previous status. The sync chip, the popup and Options kept showing the old destination's error until the next backup ran, so a working destination looked broken before it had been tried.
- **A late backup could repaint the old error.** A backup to the old destination that finished after the new one was saved wrote its result over the new destination's status.
- **Network failures were shown in English.** `fetch()` rejects with the browser's own wording, such as "Failed to fetch" in Chrome, "NetworkError when attempting to fetch resource." in Firefox and "Load failed" in Safari. That text reached the toast, the chip tooltip and the Options status as is.

## What changed

- **A new destination resets the status.** The worker's `setSettings` now goes through `saveSettings()`. When the backend changes, or the endpoint or token of a REST backend changes, the stored status is reset to Chưa sao lưu and every surface updates at once. Saving the same destination, for example only turning auto-sync on or off, keeps the current status. Editing the unused endpoint field while on Chrome Sync does not count as a move.
- **Results from the old destination are dropped.** A backup records the destination it started with and only writes its status if that is still the saved destination. The caller still receives its own result.
- **Clear feedback on save.** Options reports "Đã lưu nơi sao lưu mới, đã xoá trạng thái cũ. Bấm Kiểm tra kết nối để sao lưu thử." The reply carries only a `moved` flag; the token never leaves the worker.
- **One error translator.** `friendlyError()` in the sync core maps known transport failures to Vietnamese: network unreachable, timeout, a response that is not JSON, and an invalid server address. Messages that are already ours, such as `HTTP 503`, pass through unchanged. The worker, the sync status, community and cost requests, and the panel's own catch paths all use it, so the toast, the chip and Options show the same sentence.
- **Older stored errors are translated too.** `status()` translates an English error saved by an earlier version when it reads it.
- **No new network calls.** Saving settings never starts a backup on its own. Kiểm tra kết nối still saves pending edits first and then runs a test backup.

## Upgrading

- Reload the extension, then reload any open Delta Force tab and app page so they pick up the new build.
- Nothing to migrate. Settings, the backup and the local vault are unchanged.

## Verification

- `npm test`: 22 suites, 605 passed, 0 failed.
- The 16 new tests cover the destination reset, the late-result guard, the translation table and its use in the worker, the panel toast and chip, and Options. They fail against v3.3.8 and pass with this build.
- Two consecutive builds are byte-identical.
