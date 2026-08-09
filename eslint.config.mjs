// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.next/**", "**/coverage/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "*.mjs",
            "scripts/*.mjs",
            "apps/*/*.mjs",
            "apps/*/scripts/*.mjs",
            "apps/*/playwright.config.ts",
            "packages/*/bin/*.mjs",
          ],
          // scripts/diagram.mjs + scripts/record-demo.mjs pushed the
          // default-project file count past the (arbitrary) default cap of
          // 8 — these are still plain scripts with type-checking disabled
          // below (files: ["**/*.mjs", "scripts/**"]), just more of them.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Boundary discipline (SPEC §11): no `as any` sneaking through.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      // Zero-dep core discipline is enforced by a dedicated rule below for the
      // core package: no imports of node builtins from core source.
    },
  },
  {
    files: ["packages/sluice/src/**/*.ts"],
    // The CLI (M9) is a Node-only entry point — SPEC §2's repo layout ships
    // it from THIS package ("core + MemoryStore + CLI") but it is never
    // imported by the browser bundle (apps/web only imports the package's
    // "." export), so the zero-node-builtins boundary below — which exists
    // specifically for Web Worker compatibility — does not apply to it.
    ignores: ["packages/sluice/src/**/*.test.ts", "packages/sluice/src/cli/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message:
                "SPEC §4 boundary: @jamessuuu/sluice core must not import node builtins (browser Web Worker compatibility + zero-dep guarantee). Inject capabilities via createSluice options. (Tests and src/cli/** are exempt; the build tsconfig enforces types:[] on shipped code.)",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/sluice-testkit/src/**/*.ts"],
    ignores: ["packages/sluice-testkit/src/chaos/**", "packages/sluice-testkit/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message:
                "SPEC §7 boundary: testkit primitives (FakeTransport/FaultPlan/VirtualClock/CrashController/scenarios) stay isomorphic-pure — the playground imports them in a Web Worker at M8. File I/O belongs in src/chaos/ (the CLI runner) only.",
            },
          ],
        },
      ],
    },
  },
  {
    // SHA-256 hot loop: typed-array indexing under noUncheckedIndexedAccess.
    // Bounds are structurally guaranteed (fixed-size Uint32Array, loop bounds);
    // per-access guards would be noise. The FIPS vectors + node:crypto
    // cross-check in sha256.test.ts are the real safety net.
    files: ["packages/sluice/src/sha256.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["**/*.mjs", "scripts/**"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        fetch: "readonly",
      },
    },
  }
);
