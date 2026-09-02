/**
 * Lazy captcha module loader, plus the one piece of captcha configuration that
 * is genuinely OMP-specific: pool sizing.
 *
 * ## Lazy import
 *
 * `captcha-happy.ts` pulls in happy-dom and builds a DOM to run Aliyun's
 * captcha front-end, which is expensive to import. zcode-api loads it lazily
 * from the one branch that needs it (`src/proxy/handler.ts` `loadCaptcha`);
 * this preserves that, so merely having the provider registered costs nothing
 * until a Start Plan request is actually made.
 *
 * ## Why we re-size the pool
 *
 * zcode-api's defaults (min 40, max 120, `solveConcurrency` 8) are sized for a
 * shared proxy serving many clients. Tokens are single-use with a ~95s TTL, so
 * a floor of 40 means the pool keeps minting ~40 tokens per TTL window whether
 * or not anyone uses them. In a proxy that is amortised across clients; in OMP
 * there is exactly one user issuing a few requests a minute, so it is pure
 * background CPU plus several live happy-dom windows per mint wave.
 *
 * We deliberately do NOT edit the vendored pool to change its constants - that
 * would show up as drift on every upstream sync (see `upstream-parity.ts`).
 * Upstream already exposes `configureCaptchaSolving()` for host-specific
 * sizing, so the adaptation lives here, at the OMP boundary, and upstream's own
 * `CAPTCHA_POOL_MIN` / `CAPTCHA_POOL_MAX` / `CAPTCHA_SOLVE_CONCURRENCY`
 * variables still win for anyone running a heavier workload.
 */

/** Pool sizing accepted by upstream's `configureCaptchaSolving`. */
export interface PoolSizing {
  poolSizeMin: number;
  poolSizeMax: number;
  solveConcurrency: number;
}

/** The subset of `captcha.ts` the request pipeline uses. */
export interface CaptchaModule {
  getCaptchaToken(appVersion: string): Promise<{ verifyParam: string; region: string }>;
  urgentCaptcha(): void;
  startCaptchaPool(appVersion: string): Promise<void>;
  shutdownCaptcha(): void;
  /** Present in current zcode-api; optional so an older copy still loads. */
  configureCaptchaSolving?(opts: PoolSizing): void;
}

/**
 * Warm floor of two tokens: one for the request in flight and one spare, so a
 * gateway `code:3007` challenge can retry with a fresh token immediately
 * instead of paying a cold solve. The ceiling of eight still absorbs a burst
 * (a multi-account claim pass mints one token per account).
 */
const OMP_POOL_MIN = 2;
const OMP_POOL_MAX = 8;
const OMP_SOLVE_CONCURRENCY = 2;

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function ompPoolSizing(env: Record<string, string | undefined>): PoolSizing {
  const max = positiveInt(env.CAPTCHA_POOL_MAX) ?? OMP_POOL_MAX;
  const min = Math.min(positiveInt(env.CAPTCHA_POOL_MIN) ?? OMP_POOL_MIN, max);
  return {
    poolSizeMin: min,
    poolSizeMax: max,
    solveConcurrency: positiveInt(env.CAPTCHA_SOLVE_CONCURRENCY) ?? OMP_SOLVE_CONCURRENCY,
  };
}

/** Cache keyed by importer so tests get their own instance. */
const loaded = new WeakMap<() => Promise<CaptchaModule>, Promise<CaptchaModule>>();

/**
 * Import (once per importer) and size the captcha module.
 *
 * Sizing is applied with the import rather than per request: `configure()`
 * resets the pool's scale-up state, so re-applying it on every request would
 * keep flattening the growth the pool just earned.
 */
export function loadCaptchaWith(
  importer: () => Promise<CaptchaModule>,
  env: Record<string, string | undefined>,
): Promise<CaptchaModule> {
  const existing = loaded.get(importer);
  if (existing) return existing;

  const pending = importer().then((module) => {
    module.configureCaptchaSolving?.(ompPoolSizing(env));
    return module;
  });
  loaded.set(importer, pending);
  return pending;
}

const importCaptcha = (): Promise<CaptchaModule> => import("./captcha.js");

/** Import (once) and return the captcha module. */
export function loadCaptcha(): Promise<CaptchaModule> {
  return loadCaptchaWith(importCaptcha, process.env);
}
