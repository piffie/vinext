import { defineConfig } from "vite-plus";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export default defineConfig({
  test: {
    reporters: process.env.CI ? ["default", "github-actions"] : ["default", "agent"],
    setupFiles: [join(import.meta.dirname, "./vitest-setup.ts")],
    env: { __VINEXT_DRAFT_SECRET: randomUUID() },

    alias: {
      "e2e-utils": join(import.meta.dirname, "./next-test-setup.js"),
      "next-test-utils": join(import.meta.dirname, "./next-test-utils.js"),
    },

    // Exclude fixture files that use CJS `require('./foo.test')` to re-run
    // another test file with different env vars. vite-node's require shim
    // falls back to Node.js CJS for the required file's transitive ESM
    // imports, which can't resolve Vite aliases (e.g. 'e2e-utils'). These
    // files are covered by the skip-manifest "*": ["*"] wildcard anyway —
    // excluding them produces the same outcome without the load-time crash.
    exclude: ["**/*-custom-handler.test.*", "**/node_modules/**"],

    fileParallelism: false,
    testTimeout: 30_000,
    globals: true,
    dir: "clone",
  },
});
