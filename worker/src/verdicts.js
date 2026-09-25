/* Mapping from Garena's numeric error code to the verdict we publish.
 *
 * These pairings mirror ERROR_CODES in src/core/garena.js, which was built from
 * live responses — do not "tidy" them from the names alone. In particular 400054
 * is INVALID and 400068 is EXPIRED, which is the opposite of what the numbers
 * suggest.
 *
 * A client never sends a verdict string, only the code Garena returned, so a
 * hostile client cannot claim "success" for a dead code. Unknown codes are
 * rejected rather than guessed: a wrong verdict poisons every other user's vault.
 *
 * Codes deliberately absent, because they describe the *caller*, not the code:
 *   400067 account_already — this account hit the group limit (per-account)
 *   400069 used            — this account already used it (per-account)
 *   400055 / 400056        — account or region mismatch
 *   400050 not_logged_in, 400001 temp, 10 / 401009 / 401010 rate limited
 * Those are accepted by /submit but never published; see PER_ACCOUNT below.
 */
export const VERDICT_BY_ERR = new Map([
  [0, 'success'],
  [400054, 'invalid'],
  [400068, 'expired'],
  /* Seen live: "The end time has passed" — the campaign ended, so this is true
   * for everyone, not just the reporting account. */
  [400070, 'expired'],
  [400073, 'gift_bug'],
]);

/* Accepted so an honest client is not treated as malformed, but dropped before
 * the queue: the verdict is true for that one account only. */
export const PER_ACCOUNT = new Set([400067, 400069, 400055, 400056, 400050]);

/* Transient: says nothing about the code. Also accepted and dropped. */
export const TRANSIENT = new Set([400001, 10, 401009, 401010]);
