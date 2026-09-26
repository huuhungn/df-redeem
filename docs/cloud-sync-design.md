# Cloud sync design — community code vault

## The problem with putting GitHub in the extension

The obvious design is: extension commits new codes straight to the repo with a
GitHub token, and an Action merges them. It cannot work. Anything shipped inside
an extension is readable by every user (`chrome-extension://…/background.js` is
plain text, and the `.crx` is a zip). A token with `contents:write` would be
extracted within hours and used to rewrite or wipe the repo. Storing it
"obfuscated" changes nothing.

So the token stays server-side, and the extension never holds a credential.

## Shape

```
                    read (anonymous, cached, free)
  ┌──────────────┐  ◀─────────────── jsDelivr CDN ◀── data/codes.json  (repo)
  │  extension   │                                    data/presets.json
  │  (any user)  │
  └──────┬───────┘  write (anonymous, rate-limited, no credential)
         │ POST /submit  { code, verdict, err_code, msg }
         ▼
  ┌──────────────────────────┐
  │ Cloudflare Worker + KV   │  holds the GitHub token as a secret
  │  • validates format      │  never returns it, never echoes it
  │  • rate-limits per IP    │
  │  • dedupes               │
  │  • needs N confirmations │
  └──────────┬───────────────┘
             │ every six hours, GitHub Action pulls the promoted queue
             ▼
  ┌──────────────────────────┐
  │ GitHub Action (scheduled)│ → commits to data/codes.json → CDN updates
  └──────────────────────────┘
```

Two write paths, matching how much trust each kind of data needs.

### Gift codes — automatic

A gift code is self-verifying: Garena's own JSON says whether it worked. A client reports `{code, err_code}` using the original spelling. The Worker
computes an uppercase internal identity key only for deduplication, then derives
the only allowed global verdicts from the error code. `400054` is intentionally
local-only: Garena can reject a casing variant even though the exact submitted
spelling works. The Worker accepts per-account/region outcomes only to return a
normal response, then drops them before the queue. Promotion requires **two
separate per-install reporter IDs** agreeing on the same verdict for the same
code. These IDs are client-generated and are not Sybil-resistant, so the rule
reduces accidental or isolated bad reports; it is not proof against a determined
malicious publisher.

Codes are public, low-value, and already meant to be shared, so no human gate.

### Gun presets (operations code súng) — owner approval

A preset is a long opaque number with no verifiable outcome — the extension
cannot tell a real AKS-74 build from garbage, and a bad one wastes the user's
in-game slot. So these go through a human:

- Extension opens a **prefilled GitHub issue** (issue form, no token needed —
  the user is just visiting a URL in their browser).
- Owner or any maintainer adds the `approved` label.
- An Action parses the form and commits it to `data/presets.json`.

A user without a GitHub account can still export their presets manually and send
the file — the manual export path already exists.

## Why not the alternatives

| Option | Why not |
|---|---|
| Token in extension | Leaks immediately; repo destroyed. Non-starter. |
| GitHub Discussions/Issues for gift codes too | Every successful redeem would open an issue — hundreds of them, unusable. |
| Extension writes via GitHub App device flow | Forces every user to authorize a GitHub account just to share a code. |
| Worker as the only store (no repo) | Loses the thing the user asked for: the vault versioned in git, auditable, forkable, diffable. |
| Firebase/Supabase | Another account, quota, and an owner who is not the user. Worker+KV is on the account already in use. |

## Guarantees

- **No credential anywhere in the extension.** The Worker's GitHub token lives in
  `wrangler secret`; the Action's token is the workflow's own `GITHUB_TOKEN`.
- **Repo stays the source of truth.** Worker/KV is a queue, not a database. Wipe
  KV and nothing is lost.
- **Offline-first.** Cloud sync is opt-in; the extension works fully offline and
  never blocks a redeem cycle on the network.
- **Minimal reporting metadata.** A submission carries the code, numeric outcome,
  a client-generated per-install reporter ID, and the Worker derives a salted IP
  hash for rate limiting. It carries no game account, cookie, token, timestamp,
  or local history; the reporter ID is not Sybil-resistant authentication.
- **Reversible.** Every automated change lands as a normal commit and can be
  reverted with `git revert`.

## Read path detail

`https://cdn.jsdelivr.net/gh/<owner>/df-redeem@main/data/codes.json`

jsDelivr is free, cached at the edge, allows cross-origin reads, and does not
rate-limit clients the way `raw.githubusercontent.com` does. The extension falls
back to `raw.githubusercontent.com` if jsDelivr is unreachable, then to the
bundled seed.

`data/codes.json` carries only what a client needs to skip dead codes:

```json
{
  "version": 3,
  "updated_at": "2026-09-25T00:00:00.000Z",
  "codes": [{ "code": "DF1314754", "status": "success", "err_code": 0, "confirmations": 2 }]
}
```

Historical curated rows can have `confirmations: 1` from the former personal
policy. They remain readable but are not evidence that the current public policy
has independently re-confirmed them; new Worker promotions require two IDs.
