// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * Typed linting for the native ZCode provider.
 *
 * Scope on purpose: `tsc --noEmit` (bun run typecheck) already owns type
 * errors, and `bun test` owns behaviour. ESLint is here only for the classes
 * of bug neither can see - dropped promise rejections, `any` leaking out of
 * JSON boundaries, dead locals - plus the repo's import conventions.
 *
 * Why `.js` and not `.mjs`: the repo's .gitignore drops
 * `agent/extensions/**\/*.mjs` as build leftovers, so an `.mjs` config would be
 * untracked. `.ts` would drag in `jiti` for config loading; this file is ESM
 * already because package.json sets `"type": "module"`.
 *
 * `bun run lint` is clean and is expected to stay clean. Where a rule is turned
 * off below, the reason is recorded inline - either the pattern is correct for
 * this codebase (ANSI control chars, `!` on checked indices) or the rule is
 * wrong about this runtime (bun:test's `expect().rejects` typing).
 */
export default defineConfig(
  // Every file vendored from zcode-api. They are kept byte-identical to
  // upstream (and `captcha-happy.ts` carries upstream's `@ts-nocheck`), so
  // linting them would create diff noise against the next sync - which costs
  // far more than the findings are worth.
  //
  // `src/captcha-worker.ts` is deliberately NOT here: it is our own thin
  // wrapper, not a copy, so it gets the same scrutiny as the rest of src/.
  //
  // This list MUST match `VENDORED_FILES` in `upstream-parity.ts`; a test in
  // `tests/upstream-parity.test.ts` fails if the two ever drift.
  globalIgnores([
    "src/captcha-happy.ts",
    "src/captcha.ts",
    "src/captcha-pool.ts",
    "src/captcha-token.ts",
    "src/captcha-cpu-governor.ts",
    "tests/captcha-happy.test.ts",
    "tests/captcha-pool.test.ts",
    "tests/captcha-token.test.ts",
    "tests/captcha-cpu-governor.test.ts",
  ]),

  {
    files: ["**/*.ts", "**/*.js"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Project rule: dependencies belong in top-level `import type`.
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "separate-type-imports" }],
      // Async claim/captcha paths must never drop a rejection.
      "@typescript-eslint/no-floating-promises": "error",
      // A `default:` branch genuinely covers the rest (every remaining
      // NodeJS.Platform, an absent effort level), so listing 13 union members
      // would add noise rather than safety.
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      // Dead locals, params, imports, and caught errors are cleanup debt.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // `!` on checked array indices is idiomatic here and guarded by tsc.
      "@typescript-eslint/no-non-null-assertion": "off",
      // ANSI/SGR handling is core to the TUI widgets: control chars are the point.
      "no-control-regex": "off",
    },
  },

  {
    files: ["tests/**/*.ts", "live-zcode.ts", "solve-probe.ts"],
    rules: {
      // Test doubles legitimately match async signatures without awaiting, and
      // pass bare method references into fakes.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
      // `await expect(...).rejects.toThrow()` is the documented bun:test API,
      // but @types/bun declares those matchers as returning `void`, so the rule
      // reports every one of them. Awaiting is correct here; the types are not.
      "@typescript-eslint/await-thenable": "off",
    },
  },

  {
    // This config file is outside tsconfig's program, so type-aware rules
    // have no type information for it.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
