import { defineConfig, type Plugin } from "vite-plus";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Some upstream Next.js fixture files use CJS `require('./some.test')` to
 * re-run another test file with different env vars (e.g.
 * app-static-custom-handler.test.ts requires app-static.test.ts). In our
 * ESM-first Vitest setup this fails because Node.js's CJS require can't load
 * TypeScript files that use ESM `import` statements with Vite aliases.
 *
 * The fix: transform `require('./foo.test')` → `await import('./foo.test')`.
 * Vitest processes every .ts file through vite-node's async module evaluator,
 * so top-level `await` works. The dynamic `import()` goes through Vite's full
 * module resolution pipeline, which resolves aliases like `e2e-utils` and
 * applies TypeScript transforms correctly.
 */
const requireToImportPlugin: Plugin = {
  name: "vinext-test:cjs-require-to-esm-import",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes("/clone/")) return;
    if (!code.includes("require(")) return;
    return code.replace(
      /\brequire\((['"])(\.\/[^'"]+\.test)\1\)/g,
      (_match, _quote, specifier) => `await import('${specifier}')`,
    );
  },
};

export default defineConfig({
  plugins: [requireToImportPlugin],
  test: {
    reporters: process.env.CI ? ["default", "github-actions"] : ["default", "agent"],
    setupFiles: [join(import.meta.dirname, "./vitest-setup.ts")],
    env: { __VINEXT_DRAFT_SECRET: randomUUID() },

    alias: {
      "e2e-utils": join(import.meta.dirname, "./next-test-setup.js"),
      "next-test-utils": join(import.meta.dirname, "./next-test-utils.js"),
    },

    fileParallelism: false,
    testTimeout: 30_000,
    globals: true,
    dir: "clone",
  },
});
