# omp-zcode-provider

Native OMP provider for the **ZCode Start Plan** (`zcode`). It speaks Anthropic
Messages directly to `https://zcode.z.ai/api/v1/zcode-plan/anthropic` through
OMP's own transport - there is no proxy, daemon, or second protocol
implementation in this extension.

```text
/login zcode          browser flow, installed-credential import, or paste
/model zcode/<model>  models discovered from the live ZCode catalog
/usage                per-account entitlements via OMP's usage provider
/claim                check every stored account and claim what is available
```

## Why the code is split the way it is

| Area | File | Note |
| --- | --- | --- |
| Provider registration, commands, session wiring | `src/extension.ts` | The only file that touches `ExtensionAPI`. Everything else is plain functions so it can be unit-tested without a session. |
| Request path | `src/request.ts` | Start Plan URL, auth/identity headers, captcha retry, incomplete-stream detection. |
| Identity | `src/identity-context.ts`, `src/account-state.ts` | Per-account device id, cookies, captcha health. Isolated per account so one account's state can never leak into another's. |
| Credentials / OAuth | `src/oauth.ts`, `src/credential.ts` | Uses OMP's native OAuth credential APIs. Never writes OMP's SQLite directly. |
| Models | `src/models.ts` | Live discovery with last-good-catalog fallback: an empty response never replaces a valid catalog. |
| Usage | `src/usage.ts` | OMP usage provider; keeps last-known values and marks them stale rather than reporting zero. |
| Claim (trial/weekend plans) | `src/claim.ts`, `src/claim-scheduler.ts`, `src/claim-summary.ts`, `src/claim-fireworks.ts` | Preview → captcha → claim, on a contained session timer, with a non-modal celebration. |
| Captcha sandbox | `src/captcha*.ts` | **Vendored from zcode-api** - see below. |

## Vendored captcha files: do not "improve" them

`src/captcha-happy.ts`, `src/captcha.ts`, `src/captcha-pool.ts`,
`src/captcha-token.ts`, `src/captcha-cpu-governor.ts`, `src/zcode_system.json`
and their four upstream test files (`tests/captcha-happy.test.ts`,
`tests/captcha-pool.test.ts`, `tests/captcha-token.test.ts`,
`tests/captcha-cpu-governor.test.ts`) are byte copies of
[`zcode-api`](https://github.com/TriDefender/zcode-api).

That code encodes knowledge that is expensive to rediscover: which browser
surfaces Alibaba's FeiLin SDK fingerprints, which globals happy-dom overwrites,
how timer identity must survive teardown, how long a late SDK callback may still
resolve `Text`/`document`. When any of it is wrong the only symptom is
`400 {"code":3007}` - there is no useful error. So the rule is:

- **Port upstream commits; do not re-derive them.**
- Local edits are allowed only at the OMP boundary, and each one must be
  registered in `VENDORED_FILES` in `upstream-parity.ts` with a reason.
- Inside those files, upstream's style wins over this repo's conventions
  (e.g. `catch (_) {}`), because a style-only difference costs a real diff on
  every future sync. They are excluded from ESLint for the same reason.
- **OMP-only tests go in an OMP-owned file.** `tests/captcha-pool-omp.test.ts`
  exists so the vendored suite stays thin: an OMP regression added inside the
  copy would need every one of its lines registered as an allowed divergence.

### Syncing a new upstream commit

```bash
bun run parity          # compare against the pinned revision
bun run parity --head   # compare against origin/master (is a port pending?)
```

`bun run parity` replaces the old "clone it, diff by hand, hope you spot it"
workflow. It reports, per file, lines we added that no rule explains and lines
upstream has that we are missing - the second half is what catches a *partial*
port. Line order and whitespace-only differences are ignored on purpose: they
cannot change behaviour, and a noisy check is a check people stop running.

Porting steps:

1. `git -C ~/repos/zcode-api fetch --all`, then `bun run parity --head` to see
   what moved.
2. Copy the upstream file(s) verbatim, re-apply the registered OMP-only lines.
3. Copy the upstream tests too, adapting only the import path.
4. Bump `PINNED_UPSTREAM_REF` in `upstream-parity.ts` in the same commit.
5. `bun test && bun run typecheck && bun run parity`, then
   `bun run ./solve-probe.ts` for a real cold/overlapping solve check.

Set `ZCODE_API_REPO` if your checkout is not at `~/repos/zcode-api`.

## Auto-claim, and why it stays quiet

Two guards exist because the naive version storms the ZCode gateway:

- **Root TUI only.** `session_start` starts the scheduler only when
  `ctx.mode === "tui"` and the session header has no `parentSession`. Every
  subagent/task/fork is a full OMP session, so without this a fan-out of ten
  workers previews every stored account ten times at once. `/claim` stays
  available in every mode as the explicit trigger.
- **Client-wide 429 pause.** Rate limiting is keyed to the caller, not the
  account, so a single 429 (from either the preview GET or the claim POST)
  pauses *all* accounts via `ClaimScheduler`'s `rateLimitedUntil`, honours
  `Retry-After` when present, and logs once per window. The bug it replaces
  logged one 429 line per account per tick indefinitely.

## Commands

```bash
bun test             # 383 tests, no network except the marked live checks
bun run typecheck    # tsc --noEmit
bun run parity       # vendored-file drift check
bun run lint         # typed ESLint; currently zero findings, keep it that way
bun run ./solve-probe.ts   # real captcha solves through the persistent worker
bun run ./rate-limit-probe.ts  # 429 pause behaviour + one live preview call
```

## Environment switches

| Variable | Effect |
| --- | --- |
| `ZCODE_CLAIM_AUTO=0` | Disable the automatic claim scheduler entirely. |
| `ZCODE_CLAIM_POLL_MS` | Claim poll cadence (default 300000). |
| `ZCODE_CLAIM_COOLDOWN_MS` | Backoff after a failed claim, and the fallback pause for a 429 with no `Retry-After` (default 600000). |
| `ZCODE_CLAIM_FIREWORKS=0` | Skip the celebration widget. |
| `CAPTCHA_POOL_MIN` / `CAPTCHA_POOL_MAX` / `CAPTCHA_SOLVE_CONCURRENCY` | Override the pool sizing chosen for single-user OMP. |
| `CAPTCHA_DEBUG=1` | Restore upstream's solver diagnostics inside the worker. |
