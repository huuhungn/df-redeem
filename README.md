# df-redeem

A Chrome extension for redeeming Delta Force gift codes on the Garena portal,
with a community-maintained code vault.

The extension mounts a non-blocking drawer on the redemption page, keeps a local
vault of codes and their verdicts, and — optionally — shares what it learns with
everyone else so nobody wastes requests on codes that are already dead.

## What is in this repo

| Path | Purpose |
|---|---|
| `src/` | Extension sources: core logic (`core/`) and UI (`ui/`) |
| `build.js` | Compiles `src/` into a loadable unpacked extension |
| `data/codes.json` | The published community code vault |
| `data/presets.json` | Reviewed gunsmith presets |
| `worker/` | Cloudflare Worker that brokers community submissions |
| `tools/` | Build, validation, and verification scripts |
| `test/` | Test suites — `node test/run-all.js` runs everything |
| `docs/cloud-sync-design.md` | Why the sync layer is shaped the way it is |

## Build and install

```bash
node build.js                 # writes extension/
node test/run-all.js          # runs all tests
```

Then load `extension/` at `chrome://extensions` with Developer mode on.

## The community vault

Two data paths, deliberately different, because the trust model is different.

**Gift codes sync automatically.** A gift code is objectively alive or dead, and
the Garena API is the judge — so no human needs to approve anything. When your
When a user opens the extension it pulls the current public vault; after a
redeem run, it submits only code-wide outcomes. A scheduled GitHub Action folds a
row into `data/codes.json` once two separate per-install reporter IDs agree on a
verdict. Reporter IDs are client-generated, so this is a safety check against
accidental/isolated reports—not Sybil-resistant authentication. Every client
reads the published list and skips codes already known to be dead.

**Gunsmith presets need a human.** A preset is a subjective build that nobody
can verify automatically, so presets only enter `data/presets.json` through
[an issue](../../issues/new?template=preset-submission.yml) that a maintainer
labels `approved`.

### What leaves your machine

Only the code string and Garena's numeric error code, and only for verdicts that
are true for everyone. Specifically **not** sent:

- Codes you have not tried
- `400067` ("you already redeemed this") — that is about your account, not the code
- `400069` ("already used") — that is also account-specific in this client and is never published
- `400055` / `400056` (account or region mismatch) and transient/unknown errors
- Account identity, cookie, token, timestamp, or local redemption history

The Worker additionally receives a random per-install identifier used only to
count distinct reporters for the same outcome; it is not a game account identity.

Turn contributions off in the options page and the extension still reads the
shared vault; it just stops reporting. Turn the whole feature off and it never
contacts the network at all.

### Why the extension holds no GitHub token

An extension ships its source to every user, so any credential inside it is
public. A token that can write to this repo would be extracted and abused within
hours. The Worker holds the only write credential, accepts a narrowly-shaped
submission, and rate-limits per IP. How many independent installs must agree
before a verdict is published is a deployment choice — see
`CONFIRMATIONS_REQUIRED` below and `docs/cloud-sync-design.md`.

### Public community synchronization

The public release uses **two independent installations** before publishing a
shared verdict. When a user opens the extension it pulls the latest shared vault;
after each completed run it pulls first, then contributes only global outcomes.

- `0` success is shared as a code that is usable, but remains **untried** for
  every other account so each user may redeem it themselves.
- `400068` / `400070` expired, `400054` invalid, and `400073` gift errors are
  shared after the confirmation threshold so later users do not waste requests.
- `400067` and `400069` mean that **that specific account** already received or
  used the reward. They are stored locally as `mine`, never published, and never
  overwrite another user's local status.
- The broker receives only the code, Garena's numeric response, and a random
  per-install identifier for confirmation counting. It never receives an account
  identifier, session, cookie, token, timestamps, or local history.

The published list is committed by the scheduled GitHub workflow, so it becomes
available to every new extension install through the default public URL.

### Legacy confirmation policy

`data/codes.json` may contain older rows with `confirmations: 1` from the
pre-public personal-vault policy. They are retained as historical, curated data;
the public Worker never upgrades their count without independent evidence, and
new submissions require two reporter IDs. Do not interpret legacy count-one rows
as freshly two-party confirmed.

## Release downloads

Download the latest `df-redeem-extension-v*.zip` asset from the repository's
[Releases](../../releases). Extract it, open `chrome://extensions`, enable
**Developer mode**, choose **Load unpacked**, and select the extracted folder.
For updates, extract the new release over a separate folder and click **Reload**
on the existing extension card.


```bash
cd worker
wrangler kv namespace create VAULT        # put the id in wrangler.jsonc
wrangler secret put IP_SALT               # any long random string
wrangler secret put ADMIN_TOKEN           # used by the sync workflow
wrangler deploy
```

Then set these two **repository secrets** so
`.github/workflows/sync-codes.yml` can drain the queue:

| Secret | Value |
| --- | --- |
| `GH_VAULT_ENDPOINT` | the deployed Worker URL, no trailing slash |
| `GH_VAULT_ADMIN_TOKEN` | the same string given to `wrangler secret put ADMIN_TOKEN` |

Both must be *secrets*, not variables, and the names must match exactly — the
workflow skips with a notice when either is empty. (An earlier version gated on a
variable named `VAULT_URL`, which was never set, so every scheduled run reported
success while syncing nothing.)

### How many reporters a verdict needs

`worker/wrangler.jsonc` sets `CONFIRMATIONS_REQUIRED`, the number of distinct
installs that must report the same verdict before it is published:

- **`1`** suits a personal vault, where the operator's own install is the only
  reporter. A second one can never arrive, so any higher value queues every row
  forever.
- **`2`** is the public release default. Two different extension installs must
  observe the same globally meaningful result before it is published.
- **`3` or more** increases resistance to false reports, but delays shared updates
  and can leave rare codes pending indefinitely.

Changing it takes effect immediately for queued rows — eligibility is evaluated
when `/pending` is read, not frozen when the row was submitted.

## Licence

MIT.
