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
extension redeems a code, it reports the code and Garena's numeric response to a
Cloudflare Worker. Once the configured number of independent installs agree on a
verdict, a scheduled GitHub Action folds the row into `data/codes.json`. This
repository ships that threshold as **one** for its personal vault; a shared or
public deployment can raise `CONFIRMATIONS_REQUIRED` (details below). Every
client reads that file and skips codes already known to be dead.

**Gunsmith presets need a human.** A preset is a subjective build that nobody
can verify automatically, so presets only enter `data/presets.json` through
[an issue](../../issues/new?template=preset-submission.yml) that a maintainer
labels `approved`.

### What leaves your machine

Only the code string and Garena's numeric error code, and only for verdicts that
are true for everyone. Specifically **not** sent:

- Codes you have not tried
- `400067` ("you already redeemed this") — that is about your account, not the code
- Any account identifier, cookie, token, or timestamp

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

## Self-hosting the broker

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

- **`1`** (the shipped default) suits a personal vault, where the operator's own
  install is the only reporter. A second one can never arrive, so any higher
  value queues every row forever.
- **`2` or more** suits a shared or public vault. Raise it there: one install can
  only vouch for what it actually redeemed, and a single hostile client should not
  be able to publish on its own.

Changing it takes effect immediately for queued rows — eligibility is evaluated
when `/pending` is read, not frozen when the row was submitted.

## Licence

MIT.
