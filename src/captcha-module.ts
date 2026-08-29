/**
 * Lazy captcha module loader.
 *
 * `captcha-happy.ts` pulls in happy-dom and spins up a DOM to run Aliyun's
 * captcha front-end, which is expensive to import. zcode-api loads it lazily
 * from the one branch that needs it (`src/proxy/handler.ts` `loadCaptcha`);
 * this preserves that so merely having the provider registered costs nothing
 * until a Start Plan request is actually made.
 */

/** The subset of `captcha.ts` the request pipeline uses. */
export interface CaptchaModule {
  getCaptchaToken(appVersion: string): Promise<{ verifyParam: string; region: string }>;
  urgentCaptcha(): void;
  startCaptchaPool(appVersion: string): Promise<void>;
  shutdownCaptcha(): void;
}

let cached: Promise<CaptchaModule> | null = null;

/** Import (once) and return the captcha module. */
export function loadCaptcha(): Promise<CaptchaModule> {
  cached ??= import("./captcha.js");
  return cached;
}
