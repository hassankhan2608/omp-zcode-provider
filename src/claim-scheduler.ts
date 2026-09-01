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
  now?: () => number;
  /** Stable account ordering for tests; default keeps storage order. */
  compareAccounts?(a: SchedulerAccount, b: SchedulerAccount): number;
}

export type TickResult =
  | { action: "skipped_hold" }
  | { action: "stopped" }
  | { action: "idle" }
  | { action: "claimed"; planId: string; startsAt?: number; endsAt?: number }
  | { action: "failed"; outcome: Extract<ClaimOutcome, { ok: false }>; holdMs: number }
  | { action: "error"; message: string; holdMs: number };


export class ClaimScheduler {
  private stopped = false;
  private readonly holdUntil = new Map<string, number>();
  /** Accounts that hit login_required and must not be retried until /login. */
  private readonly stoppedAccounts = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly notify: (message: string) => void;

  constructor(private readonly deps: ClaimSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.notify = deps.notify ?? this.log;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  start(): void {
    if (this.stopped) return;
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Milliseconds until the next meaningful wake (earliest account hold end). */
  nextWakeInMs(): number {
    const nowMs = this.now();
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
   * One poll→claim cycle across all accounts. Exposed for tests; `start()`
   * drives it on a timer. Per-account failures never block siblings.
   */
  async tick(): Promise<TickResult> {
    if (this.stopped) return { action: "stopped" };
    const accounts = [...this.deps.listAccounts()].sort(this.deps.compareAccounts);

    let aggregate: TickResult | undefined;
    for (const account of accounts) {
      const result = await this.tickAccount(account);
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
    if (this.stopped) return { action: "stopped" };
    if (this.stoppedAccounts.has(account.accountId)) return { action: "stopped" };
    const nowMs = this.now();
    const holdUntil = this.holdUntil.get(account.accountId) ?? 0;
    if (nowMs < holdUntil) return { action: "skipped_hold" };

    const client = this.deps.createClient(account);
    let plans: ClaimablePlan[];
    try {
      plans = await client.getPreviews();
    } catch (error) {
      // 404 = campaign endpoint not deployed yet (expected pre-launch state);
      // poll at normal cadence instead of error backoff.
      if (error instanceof ClaimPreviewError && error.status === 404) {
        this.hold(account, this.deps.config.pollIntervalMs);
        return { action: "idle" };
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
      return { action: "claimed", planId: target.planId, startsAt: outcome.startsAt, endsAt: outcome.endsAt };
    }

    const holdMs = this.holdForFailure(outcome.failureKind, outcome.failureEndsAt, nowMs);
    this.hold(account, holdMs);
    const message = `ZCode claim: ${outcome.failureKind} (${outcome.code}) — ${outcome.message}; retry in ${Math.round(holdMs / 1000)}s`;
    this.log(message);
    if (outcome.failureKind === "login_required") {
      this.stoppedAccounts.add(account.accountId);
      this.notify(`ZCode claim stopped for ${account.email ?? account.accountId}: re-login required (/login zcode)`);
    }
    return { action: "failed", outcome, holdMs };
  }

  /** Resume an account stopped by login_required after a fresh /login. */
  resumeAccount(accountId: string): void {
    this.stoppedAccounts.delete(accountId);
    this.holdUntil.delete(accountId);
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

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.scheduleNext(this.nextWakeInMs()));
    }, delayMs);
    // Never keep OMP alive for the scheduler alone.
    this.timer.unref?.();
  }
}

/** Clear a login-required stop so a fresh /login resumes the account. */
export function resumeAccount(scheduler: ClaimScheduler, accountId: string): void {
  scheduler.resumeAccount(accountId);
}
