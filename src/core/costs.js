/* src/core/costs.js — equipment cost ("Chi phí trang bị") for Gunsmith presets.
 *
 * Why a module and not a field on the preset row: a cost is not a property of the
 * code, it is a *claim about* the code that several users measure independently.
 * Two players reading the same Gunsmith screen can report different numbers —
 * the build was changed, attachment prices were patched, or somebody mistyped a
 * digit. So a cost carries provenance and an agreement state, exactly like the
 * redeem verdicts in worker/src/index.js do.
 *
 * Agreement rule (the user's rule, implemented literally):
 *   1st report                 → trusted immediately, shown as "chưa đối chiếu"
 *   2nd report, same number    → confirmed, no approval needed (it is a duplicate)
 *   2nd report, different      → disputed, needs a human verdict before publishing
 *
 * "Same number" is not string equality: 290K, 290.000 and 295426 are all things a
 * player will type for the same build. Values are normalised to an integer before
 * comparison, and near-equal readings are treated as agreement (see TOLERANCE)
 * because the in-game number moves slightly with attachment price patches, and a
 * dispute should mean "someone is wrong", not "someone measured on Tuesday".
 */
(function attach(root) {
  'use strict';

  /* Gunsmith costs are whole currency units. The observed range in-game spans a
   * few thousand (a pistol with no attachments) to a few hundred thousand (a
   * fully kitted sniper). Anything outside this is a typo — a trailing zero, or
   * a pasted code fragment — and is rejected rather than stored and averaged. */
  const MIN_COST = 100;
  const MAX_COST = 9999999;

  /* Two readings within this fraction of each other are the same build priced at
   * different patch levels, not a disagreement. 2% of 295,426 is ~5,900, which
   * absorbs attachment repricing without absorbing a mistyped leading digit
   * (295,426 vs 195,426 differs by 34% and still disputes). */
  const TOLERANCE = 0.02;

  const STATES = {
    unconfirmed: { id: 'unconfirmed', label: 'Chưa đối chiếu', hint: 'Một người báo, chưa ai đối chiếu' },
    confirmed: { id: 'confirmed', label: 'Đã đối chiếu', hint: 'Nhiều người báo trùng số' },
    disputed: { id: 'disputed', label: 'Đang tranh chấp', hint: 'Số liệu khác nhau, chờ phê duyệt' },
  };

  /* Parse whatever a human typed into an integer cost.
   *
   * Accepts: 295426 · 295,426 · 295.426 · "295 426" · 290k · 290K · 1.2m
   * Rejects: empty, negative, non-numeric, out-of-range.
   *
   * Thousands separators are the hard part: Vietnamese locale writes 295.426
   * where English writes 295,426, so a dot is NOT reliably a decimal point. The
   * rule used here: a trailing group of exactly 3 digits after a separator is a
   * thousands group; a shorter trailing group is a decimal fraction (only
   * meaningful with a k/m suffix, where 1.2m is 1,200,000).
   */
  function parseCost(input) {
    if (input === null || input === undefined) return { ok: false, error: 'Chưa nhập chi phí' };
    let text = String(input).trim().toLowerCase();
    if (!text) return { ok: false, error: 'Chưa nhập chi phí' };

    /* Strip currency noise a player may paste along with the number. */
    text = text.replace(/[₫$]|vnd|đ\b/g, '').trim();

    const suffix = /([km])\s*$/.exec(text);
    const mult = suffix ? (suffix[1] === 'k' ? 1000 : 1000000) : 1;
    if (suffix) text = text.slice(0, suffix.index).trim();

    if (!/^[\d.,\s]+$/.test(text)) return { ok: false, error: 'Chi phí phải là số' };

    let normalised;
    if (mult > 1) {
      /* With a k/m suffix the separator is a decimal point: 1.2m → 1200000. */
      normalised = text.replace(/[,\s]/g, '').replace(/\.(?=\d{1,2}$)/, '.');
      const asFloat = Number(normalised.replace(/\.(?=.*\.)/g, ''));
      if (!Number.isFinite(asFloat)) return { ok: false, error: 'Chi phí phải là số' };
      normalised = String(Math.round(asFloat * mult));
    } else {
      /* No suffix: every separator is a thousands separator, so drop them all.
       * A bare "295.4" without a suffix is a typo, not 295.4 currency units. */
      normalised = text.replace(/[.,\s]/g, '');
    }

    if (!/^\d+$/.test(normalised)) return { ok: false, error: 'Chi phí phải là số' };
    const value = Number(normalised);
    if (!Number.isFinite(value)) return { ok: false, error: 'Chi phí phải là số' };
    if (value < MIN_COST) return { ok: false, error: `Chi phí quá nhỏ (tối thiểu ${MIN_COST})` };
    if (value > MAX_COST) return { ok: false, error: 'Chi phí quá lớn, kiểm tra lại số' };
    return { ok: true, value };
  }

  /** Render a cost for display with Vietnamese thousands separators. */
  function formatCost(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  /** True when two readings are close enough to count as the same measurement. */
  function agrees(a, b) {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x === y) return true;
    const span = Math.max(Math.abs(x), Math.abs(y));
    return span > 0 && Math.abs(x - y) / span <= TOLERANCE;
  }

  /* Fold one report into a cost record and return the new record.
   *
   * Pure: takes the existing record (or null) and returns a fresh object, so the
   * same function runs in the panel for an optimistic local update and in the
   * Worker for the authoritative one, and the two cannot drift.
   *
   * `reporter` de-duplicates: one person reporting twice is a correction of their
   * own number, not a second confirmation — otherwise a single user could
   * self-confirm any value and defeat the quorum entirely.
   */
  function applyReport(existing, report) {
    const parsed = parseCost(report && report.value);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const reporter = String((report && report.reporter) || '').trim();
    if (!reporter) return { ok: false, error: 'Thiếu danh tính người báo' };
    const at = (report && report.at) || new Date().toISOString();
    const value = parsed.value;

    if (!existing || !Array.isArray(existing.reports) || !existing.reports.length) {
      /* First report is trusted as-is — the user asked for exactly this: if the
       * first number looks right, nobody should have to edit it. */
      return {
        ok: true,
        record: {
          value,
          state: STATES.unconfirmed.id,
          reports: [{ value, reporter, at }],
          first_seen: at,
          updated_at: at,
        },
        changed: true,
        outcome: 'first',
      };
    }

    const reports = existing.reports.slice();
    const mineIndex = reports.findIndex((r) => r.reporter === reporter);
    const previouslyReported = mineIndex >= 0 ? reports[mineIndex] : null;

    /* Re-sending an identical number changes nothing. Worth returning early:
     * clients push their whole preset list, and writing unchanged rows is what
     * exhausted the KV put() quota for verdicts (see recordVerdict). */
    if (previouslyReported && agrees(previouslyReported.value, value)) {
      return { ok: true, record: existing, changed: false, outcome: 'unchanged' };
    }

    if (mineIndex >= 0) reports[mineIndex] = { value, reporter, at };
    else reports.push({ value, reporter, at });

    /* Group the distinct readings so the largest agreeing cluster wins. Using
     * clusters rather than a raw majority keeps 295,000 and 295,426 on the same
     * side instead of letting near-identical readings split the vote and hand a
     * win to a single outlier. */
    const clusters = [];
    for (const r of reports) {
      const hit = clusters.find((c) => agrees(c.value, r.value));
      if (hit) {
        hit.members.push(r);
        if (String(r.at) < String(hit.first_at)) hit.first_at = r.at;
      } else {
        clusters.push({ value: r.value, first_at: r.at, members: [r] });
      }
    }
    /* Within a cluster, show the most *precise* reading rather than the newest.
     * Players round when they retype ("290K" for 295,426), and a round number is
     * information lost, so a later rounded report must not overwrite an exact
     * one. Precision is judged by trailing zeros: fewer means more precise. */
    for (const c of clusters) {
      const precision = (v) => {
        const s = String(Math.round(v));
        const m = /0+$/.exec(s);
        return m ? m[0].length : 0;
      };
      c.value = c.members.slice().sort((a, b) => precision(a.value) - precision(b.value)
        || String(b.at).localeCompare(String(a.at)))[0].value;
    }
    /* Tie-break toward the *oldest* reading, not the newest. In a 1-vs-1 dispute
     * both clusters have one member, and letting the later report win would mean
     * any single user can flip the displayed cost of any preset just by reporting
     * after it — no quorum required. The incumbent value holds until either a
     * second person agrees with the challenger or a human resolves the dispute. */
    clusters.sort((a, b) => b.members.length - a.members.length
      || String(a.first_at).localeCompare(String(b.first_at)));

    const top = clusters[0];
    const contested = clusters.length > 1;
    const state = contested
      ? STATES.disputed.id
      : (top.members.length >= 2 ? STATES.confirmed.id : STATES.unconfirmed.id);

    return {
      ok: true,
      record: {
        /* A disputed record keeps showing the leading value rather than blanking:
         * a probably-right number with a visible dispute badge is more useful to a
         * player than no number at all. */
        value: top.value,
        state,
        reports,
        first_seen: existing.first_seen || at,
        updated_at: at,
      },
      changed: true,
      outcome: state,
    };
  }

  /** Resolve a human verdict on a dispute: keep `value`, drop the rest. */
  function resolveDispute(existing, value, resolver) {
    const parsed = parseCost(value);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const at = new Date().toISOString();
    const kept = (existing && Array.isArray(existing.reports) ? existing.reports : [])
      .filter((r) => agrees(r.value, parsed.value));
    return {
      ok: true,
      record: {
        value: parsed.value,
        state: STATES.confirmed.id,
        reports: kept.length ? kept : [{ value: parsed.value, reporter: String(resolver || 'admin'), at }],
        first_seen: (existing && existing.first_seen) || at,
        updated_at: at,
        resolved_by: String(resolver || 'admin'),
      },
      changed: true,
      outcome: 'resolved',
    };
  }

  /** Distinct readings on file, newest first — what a review UI must show. */
  function disputeSummary(record) {
    const reports = (record && Array.isArray(record.reports)) ? record.reports : [];
    const clusters = [];
    for (const r of reports) {
      const hit = clusters.find((c) => agrees(c.value, r.value));
      if (hit) hit.count += 1;
      else clusters.push({ value: r.value, count: 1, at: r.at });
    }
    return clusters.sort((a, b) => b.count - a.count || String(b.at).localeCompare(String(a.at)));
  }

  const api = {
    MIN_COST,
    MAX_COST,
    TOLERANCE,
    STATES,
    parseCost,
    formatCost,
    agrees,
    applyReport,
    resolveDispute,
    disputeSummary,
  };

  root.DFRedeemCosts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
