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
 * Existing findings are NOT treated as a release gate. Most of them live in
 * test doubles (deliberate non-null assertions on fixture data). Fixing them is
 * separate cleanup, tracked apart from this tooling, so that adding the linter
 * never rewrites hundreds of lines of otherwise-green tests.
 */
export default defineConfig(
  // `src/captcha-happy.ts` and `src/captcha-worker.ts` are kept byte-identical
  // to zcode-api (they carry upstream's `@ts-nocheck`). Linting them would
  // create diff noise against upstream and make the next sync harder, which
  // costs more than the findings are worth.
  globalIgnores(["src/captcha-happy.ts", "src/captcha-worker.ts"]),

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
      "@typescript-eslint/switch-exhaustiveness-check": "error",
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
    // Test doubles legitimately match async signatures without awaiting, and
    // pass bare method references into fakes.
    files: ["tests/**/*.ts", "live-zcode.ts", "solve-probe.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },

  {
    // This config file is outside tsconfig's program, so type-aware rules
    // have no type information for it.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
