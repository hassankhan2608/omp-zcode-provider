/**
 * Captcha module boundary: lazy load plus OMP-scale pool sizing.
 *
 * zcode-api's pool defaults are sized for a shared proxy (min 40, max 120,
 * 95s single-use tokens). One interactive OMP user issues a few requests a
 * minute, so that floor mints dozens of tokens per TTL window that expire
 * unused - continuous solve CPU and several live happy-dom windows.
 *
 * The vendored files are left untouched; the sizing is applied through
 * `configureCaptchaSolving`, which is upstream's own seam for exactly this.
 */
import { describe, expect, it } from "bun:test";
import { loadCaptchaWith, ompPoolSizing, type CaptchaModule } from "../src/captcha-module.js";

describe("ompPoolSizing", () => {
  it("keeps a small warm floor instead of the proxy-scale default", () => {
    const sizing = ompPoolSizing({});
    expect(sizing.poolSizeMin).toBe(2);
    expect(sizing.poolSizeMax).toBe(8);
    expect(sizing.solveConcurrency).toBe(2);
  });

  it("keeps at least one spare token so a gateway challenge can retry instantly", () => {
    expect(ompPoolSizing({}).poolSizeMin).toBeGreaterThanOrEqual(2);
  });

  it("honours the upstream env overrides for heavier workloads", () => {
    const sizing = ompPoolSizing({
      CAPTCHA_POOL_MIN: "10",
      CAPTCHA_POOL_MAX: "30",
      CAPTCHA_SOLVE_CONCURRENCY: "6",
    });
    expect(sizing).toEqual({ poolSizeMin: 10, poolSizeMax: 30, solveConcurrency: 6 });
  });

  it("ignores unusable env values rather than sizing the pool to zero", () => {
    const sizing = ompPoolSizing({ CAPTCHA_POOL_MIN: "nonsense", CAPTCHA_POOL_MAX: "0" });
    expect(sizing.poolSizeMin).toBe(2);
    expect(sizing.poolSizeMax).toBe(8);
  });

  it("never lets the floor exceed the ceiling", () => {
    expect(ompPoolSizing({ CAPTCHA_POOL_MIN: "50", CAPTCHA_POOL_MAX: "4" })).toEqual({
      poolSizeMin: 4,
      poolSizeMax: 4,
      solveConcurrency: 2,
    });
  });
});

describe("loadCaptchaWith", () => {
  function fakeModule(): CaptchaModule & { configured: unknown[]; imports: number } {
    const module = {
      configured: [] as unknown[],
      imports: 0,
      getCaptchaToken: async () => ({ verifyParam: "p", region: "sgp" }),
      urgentCaptcha: () => {},
      startCaptchaPool: async () => {},
      shutdownCaptcha: () => {},
      configureCaptchaSolving: (opts: unknown) => {
        module.configured.push(opts);
      },
    };
    return module;
  }

  it("applies the OMP sizing once, on first load", async () => {
    const module = fakeModule();
    let imports = 0;
    const importer = async () => {
      imports += 1;
      return module;
    };

    const first = await loadCaptchaWith(importer, {});
    const second = await loadCaptchaWith(importer, {});

    expect(first).toBe(module);
    expect(second).toBe(module);
    // Import is cached per importer, and sizing is applied with it - repeated
    // configuration would reset the pool's scale-up state on every request.
    expect(imports).toBe(1);
    expect(module.configured).toEqual([{ poolSizeMin: 2, poolSizeMax: 8, solveConcurrency: 2 }]);
  });

  it("still returns the module when the vendored build predates the sizing seam", async () => {
    const withoutSeam: CaptchaModule = {
      getCaptchaToken: async () => ({ verifyParam: "p", region: "sgp" }),
      urgentCaptcha: () => {},
      startCaptchaPool: async () => {},
      shutdownCaptcha: () => {},
    };
    const loaded = await loadCaptchaWith(async () => withoutSeam, {});
    expect(loaded).toBe(withoutSeam);
  });
});
