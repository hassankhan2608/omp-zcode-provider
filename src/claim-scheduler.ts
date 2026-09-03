/**
 * Auto-claim scheduler.
 *
 * Ported from zcode-api `src/claim/scheduler.ts` (v4.5.3), adapted for OMP's
 * multi-account storage: one state machine per stored ZCode account, rotated
 * in a stable order each tick.
 *
 * Upstream backoff semantics per failure kind (biz codes from the desktop
 * client), preserved exactly:
 *   - success / already_claimed → hold until the plan's `ends_at` (unix sec)
 *   - quota_exhausted           → hold until `failureEndsAt` (next window) else cooldown
 *   - ineligible / unavailable / not_found → cooldown
 *   - captcha / network / unknown          → cooldown (retry next window)
 *   - login_required                      → stop that account (needs re-login)
 *
 * Anti-ban posture matches the desktop client's `manualClaimPlan`: preview
 * polls are plain identity-headered GETs (no captcha), captcha tokens are
 * minted only when a claim is actually attempted, and holds/cooldowns prevent
 * hammering. `starts_at` / `ends_at` / `failureEndsAt` are unix SECONDS.
 */
import type { ClaimablePlan, ClaimOutcome } from "./claim.js";
import { ClaimPreviewError, selectClaimTarget } from "./claim.js";

/** One stored account the scheduler works on. */
export interface SchedulerAccount {
  jwt: string;
  accountId: string;
  email?: string;
}

interface ClaimGateway {
  getPreviews(): Promise<ClaimablePlan[]>;
  claim(planId: string, captcha: { verifyParam: string; region?: string }): Promise<ClaimOutcome>;
}

export interface ClaimSchedulerConfig {
  /** Claim this plan_id; empty = highest-priority preview. */
  planId?: string;
  pollIntervalMs: number;
  cooldownMs: number;
}

export interface ClaimSchedulerDeps {
  /** Stored accounts to rotate through. Read fresh on every tick. */
  listAccounts(): SchedulerAccount[];
  createClient(account: SchedulerAccount): ClaimGateway;
  getCaptcha(): Promise<{ verifyParam: string; region?: string }>;
  config: ClaimSchedulerConfig;
  log?: (message: string) => void;
  /** User-facing notification for consequential results (claims, stops). */
  notify?: (message: string) => void;
  /** Structured success hook for rich native UI; fires once per claimed plan. */
  onClaimed?: (account: SchedulerAccount, plan: ClaimablePlan, outcome: Extract<ClaimOutcome, { ok: true }>) => void;
  now?: () => number;
  /**
   * Stable account ordering for tests; default keeps storage order.
   *
   * `this: void` documents that it is a plain function - it is read off the
   * deps object before being handed to `Array#sort`.
   */
  compareAccounts?(this: void, a: SchedulerAccount, b: SchedulerAccount): number;
}

export type TickResult =
  | { action: "skipped_hold" }
  | { action: "stopped" }
  | { action: "idle" }
  | { action: "claimed"; planId: string; startsAt?: number; endsAt?: number }
  | { action: "failed"; outcome: Extract<ClaimOutcome, { ok: false }>; holdMs: number }
  | { action: "error"; message: string; holdMs: number }
  | { action: "rate_limited"; retryInMs: number };


export class ClaimScheduler {
  private readonly holdUntil = new Map<string, number>();
  /**
   * Accounts stopped by `login_required`, keyed by the JWT that was rejected.
   *
   * Upstream keeps such an account stopped until the operator re-authenticates.
   * Storing the rejected credential instead of a bare account id is what makes
   * that self-healing here: a fresh `/login zcode` rotates the JWT, and the
   * next tick sees a credential it never rejected.
   */
  private readonly stoppedCredentials = new Map<string, string>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly notify: (message: string) => void;
  /**
   * End of the current client-wide 429 pause (epoch ms; 0 = not limited).
   *
   * Rate limiting at ZCode is keyed to the caller, not the account, so this is
   * deliberately NOT part of `holdUntil`: one 429 must pause every stored
   * account at once. It also makes the pause logged once per window instead of
   * once per account per tick, which is how the original flood looked in the
   * session log.
   */
  private rateLimitedUntil = 0;

  constructor(private readonly deps: ClaimSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.notify = deps.notify ?? this.log;
  }

  /** Milliseconds until the next meaningful wake (earliest account hold end). */
  nextWakeInMs(): number {
    const nowMs = this.now();
    // A client-wide rate limit outranks any per-account hold: nothing may go
    // out before it lifts, so waking earlier only burns another 429.
    if (nowMs < this.rateLimitedUntil) return this.rateLimitedUntil - nowMs;
    const accounts = this.deps.listAccounts();
    if (accounts.length === 0) return this.deps.config.pollIntervalMs;
    let earliest = Number.POSITIVE_INFINITY;
    for (const account of accounts) {
      const hold = this.holdUntil.get(account.accountId) ?? 0;
      earliest = Math.min(earliest, hold);
    }
    const remaining = earliest - nowMs;
    return remaining > 0 ? remaining : this.deps.config.pollIntervalMs;
  }

  /**
   * One poll→claim cycle across all accounts.
   *
   * The session owns the cadence (`ctx.setInterval`), so this is the whole
   * public entry point. Per-account failures never block siblings.
   */
  async tick(): Promise<TickResult> {
    // Arrow keeps `this` with the deps object; the comparator stays optional,
    // so without one we fall through to Array#sort's default exactly as before.
    const compare = this.deps.compareAccounts;
    const accounts = [...this.deps.listAccounts()].sort(compare ? (a, b) => compare(a, b) : undefined);

    let aggregate: TickResult | undefined;
    for (const account of accounts) {
      const result = await this.tickAccount(account);
      // A 429 is a statement about this client, not this account. Continuing
      // the rotation would send N-1 more requests into a closed window, which
      // is exactly the storm the gateway is complaining about.
      if (result.action === "rate_limited") return result;
      if (!aggregate) {
        aggregate = result;
        continue;
      }
      // Aggregate priority: claimed > failed/error > skipped_hold > idle.
      const rank = (action: TickResult["action"]): number =>
        action === "claimed" ? 3 : action === "failed" || action === "error" ? 2 : action === "skipped_hold" ? 1 : 0;
      if (rank(result.action) > rank(aggregate.action)) aggregate = result;
    }
    return aggregate ?? { action: "idle" };
  }

  private async tickAccount(account: SchedulerAccount): Promise<TickResult> {
    // Stopped by login_required, and the same credential is still stored: a
    // retry would just fail again. A different JWT means the operator logged
    // in since, so the stop clears itself - the scheduler has no hook into
    // /login, and an explicit resume call nobody makes would strand it.
    if (this.stoppedCredentials.get(account.accountId) === account.jwt) return { action: "stopped" };
    if (this.stoppedCredentials.delete(account.accountId)) {
      // Same semantics as upstream's manual resume: a re-login clears the
      // login_required cooldown too, so the operator gets an attempt now
      // instead of waiting out a backoff that a new credential invalidated.
      this.holdUntil.delete(account.accountId);
    }
    const nowMs = this.now();
    const holdUntil = this.holdUntil.get(account.accountId) ?? 0;
    if (nowMs < holdUntil) return { action: "skipped_hold" };

    // Client-wide 429 window: no request may leave until it lifts, so this is
    // checked before the preview call rather than being folded into holdUntil.
    if (nowMs < this.rateLimitedUntil) return { action: "skipped_hold" };

    const client = this.deps.createClient(account);
    let plans: ClaimablePlan[];
    try {
      plans = await client.getPreviews();
    } catch (error) {
      if (error instanceof ClaimPreviewError) {
        // 404 = campaign endpoint not deployed yet (expected pre-launch state);
        // poll at normal cadence instead of error backoff.
        if (error.status === 404) {
          this.hold(account, this.deps.config.pollIntervalMs);
          return { action: "idle" };
        }
        if (error.status === 429) return this.tripRateLimit(error.retryAfterMs, error.message);
      }
      return this.errorBackoff(account, `preview failed: ${(error as Error).message}`);
    }
    if (plans.length === 0) {
      this.hold(account, this.deps.config.pollIntervalMs);
      return { action: "idle" };
    }

    const target = selectClaimTarget(plans, this.deps.config.planId);
    if (!target) {
      // Configured planId not in the current preview list — plain poll cadence.
      this.hold(account, this.deps.config.pollIntervalMs);
      return { action: "idle" };
    }

    let captcha: { verifyParam: string; region?: string };
    try {
      captcha = await this.deps.getCaptcha();
    } catch (error) {
      return this.errorBackoff(account, `captcha token failed: ${(error as Error).message}`);
    }

    let outcome: ClaimOutcome;
    try {
      outcome = await client.claim(target.planId, captcha);
    } catch (error) {
      return this.errorBackoff(account, `claim request failed: ${(error as Error).message}`);
    }

    if (outcome.ok) {
      const endsAtMs = outcome.endsAt !== undefined ? outcome.endsAt * 1000 : undefined;
      // Upstream holds until the ABSOLUTE ends_at, not now+ends_at.
      if (endsAtMs !== undefined) this.holdUntil.set(account.accountId, endsAtMs);
      else this.hold(account, this.deps.config.pollIntervalMs);
      const message = `ZCode claim: ${target.name} (${target.planId}) claimed for ${account.email ?? account.accountId}${
        outcome.startsAt !== undefined ? ` (activates ${new Date(outcome.startsAt * 1000).toISOString()})` : ""
      }`;
      this.log(message);
      this.notify(message);
      this.deps.onClaimed?.(account, target, outcome);
      return { action: "claimed", planId: target.planId, startsAt: outcome.startsAt, endsAt: outcome.endsAt };
    }

    if (outcome.failureKind === "http_error" && Number(outcome.code) === 429) {
      // Same limit, different endpoint: the claim POST can 429 even when the
      // preview GET went through, so both entry points share the gate.
      return this.tripRateLimit(outcome.retryAfterMs, outcome.message);
    }

    const holdMs = this.holdForFailure(outcome.failureKind, outcome.failureEndsAt, nowMs);
    this.hold(account, holdMs);
    const message = `ZCode claim: ${outcome.failureKind} (${outcome.code}) — ${outcome.message}; retry in ${Math.round(holdMs / 1000)}s`;
    this.log(message);
    if (outcome.failureKind === "login_required") {
      this.stoppedCredentials.set(account.accountId, account.jwt);
      this.notify(`ZCode claim stopped for ${account.email ?? account.accountId}: re-login required (/login zcode)`);
    }
    return { action: "failed", outcome, holdMs };
  }

  private hold(account: SchedulerAccount, ms: number): void {
    this.holdUntil.set(account.accountId, this.now() + ms);
  }


  private holdForFailure(
    kind: Extract<ClaimOutcome, { ok: false }>["failureKind"],
    failureEndsAtSec: number | undefined,
    nowMs: number,
  ): number {
    if ((kind === "already_claimed" || kind === "quota_exhausted") && Number.isFinite(failureEndsAtSec)) {
      const untilMs = (failureEndsAtSec as number) * 1000;
      if (untilMs > nowMs) return Math.min(untilMs - nowMs, 24 * 60 * 60 * 1000);
    }
    return this.deps.config.cooldownMs;
  }

  private errorBackoff(account: SchedulerAccount, message: string): TickResult {
    const holdMs = this.deps.config.cooldownMs;
    this.hold(account, holdMs);
    this.log(`claim: ${message}; retry in ${Math.round(holdMs / 1000)}s`);
    return { action: "error", message, holdMs };
  }

  /**
   * Enter (or extend) the client-wide 429 pause.
   *
   * `retryAfterMs` is honoured when the gateway sent `Retry-After`; the ZCode
   * gateway has been seen answering a bare 429, hence the cooldown fallback.
   * The log line fires only for the first 429 of a window - the flood this
   * fixes was the same message repeated per account, per tick, for hours.
   */
  private tripRateLimit(retryAfterMs: number | undefined, detail: string): TickResult {
    const nowMs = this.now();
    const pauseMs = retryAfterMs ?? this.deps.config.cooldownMs;
    const firstOfWindow = nowMs >= this.rateLimitedUntil;
    this.rateLimitedUntil = Math.max(this.rateLimitedUntil, nowMs + pauseMs);
    const retryInMs = this.rateLimitedUntil - nowMs;
    if (firstOfWindow) {
      this.log(`claim: rate limited (429) — ${detail}; pausing every account for ${Math.round(retryInMs / 1000)}s`);
    }
    return { action: "rate_limited", retryInMs };
  }
}

