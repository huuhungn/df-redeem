/* Mapping from Garena's numeric error code to verdicts eligible for public sync.
 *
 * `400054` locally means INVALID, but is intentionally absent here: a
 * casing-sensitive code can reject an altered spelling while the original works.
 * A client never sends a verdict string, only the numeric result, so unknown or
 * account-specific responses are dropped instead of guessed. */
export const VERDICT_BY_ERR = new Map([
  [0, 'success'],
  /* 400054 is deliberately local-only: a casing-sensitive code can reject an
   * uppercase/otherwise altered spelling even though the original spelling works. */
  [400068, 'expired'],
  /* Seen live: "The end time has passed" — the campaign ended, so this is true
   * for everyone, not just the reporting account. */
  [400070, 'expired'],
  [400073, 'gift_bug'],
]);

/* Accepted but dropped before the queue. Per-account and casing-ambiguous
 * outcomes must remain local, never become a community verdict. */
export const PER_ACCOUNT = new Set([400054, 400067, 400069, 400055, 400056, 400050]);

/* Transient: says nothing about the code. Also accepted and dropped. */
export const TRANSIENT = new Set([400001, 10, 401009, 401010]);
