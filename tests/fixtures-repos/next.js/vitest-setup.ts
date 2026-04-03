/**
 * vitest-setup.ts — per-file setup that enforces skip-manifest.json.
 *
 * Vitest runs this file inside every test file's context (via `setupFiles`).
 * We read the manifest and wrap the injected globals (`it`, `test`) so that
 * any test whose name appears in the skip list for the current file is
 * silently converted to `it.skip` / `test.skip`.
 *
 * ── Manifest format (skip-manifest.json) ─────────────────────────────────────
 *
 * Paths are relative to the `clone/` directory. Both flat and nested forms
 * are supported and may be mixed freely.
 *
 *   Flat:
 *   {
 *     "app-dir/app/index.test.ts": ["exact test name"]
 *   }
 *
 *   Nested:
 *   {
 *     "app-dir": {
 *       "app": {
 *         "index.test.ts": ["exact test name"],
 *         "*": ["*"]
 *       },
 *       "*": ["*"]
 *     },
 *     "*": ["*"]
 *   }
 *
 * ── Wildcard key "*" ──────────────────────────────────────────────────────────
 *
 * A `"*"` key inside a node is a fallback: any path segment that doesn't
 * match an explicit sibling key falls through to it. This lets you say
 * "skip everything under this directory except the files I've listed".
 *
 *   { "app-dir": { "app": { "index.test.ts": [...], "*": ["*"] } } }
 *
 * means: for app-dir/app/index.test.ts use the explicit matchers; for every
 * other file under app-dir/app/ skip all tests.
 *
 * ── Matcher syntax ────────────────────────────────────────────────────────────
 *
 *   "exact test name"          — skip the test whose name matches exactly
 *   "$contains:some substring" — skip any test whose name contains the substring
 *   "*"                        — skip every test in the file
 */

import { it, test, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { join, relative, normalize } from "node:path";
import type { BrowserInstance } from "./next-test-setup.js";

// ─── toDisplayRedbox / toDisplayCollapsedRedbox ───────────────────────────────
//
// Ported from Next.js: test/lib/add-redbox-matchers.ts
// https://github.com/vercel/next.js/blob/canary/test/lib/add-redbox-matchers.ts
//
// These matchers interact with the Next.js error overlay ("Redbox") that the
// vinext dev server renders inside a <nextjs-portal> shadow host whenever a
// runtime error occurs.
//
// Usage:
//   await expect(browser).toDisplayRedbox(`
//     {
//       "description": "...",
//       ...
//     }
//   `)
//
// If no snapshot is supplied the matcher still waits for the redbox and prints
// what it found — useful when first writing a new test.
//
// The implementation scrapes the live DOM via Playwright `page.evaluate` so it
// works against the vinext dev server (which renders the same Next.js error
// overlay component as the upstream dev server).

// ── Selector constants (match what the Next.js overlay renders) ────────────────

const REDBOX_DIALOG_SELECTOR = "nextjs-portal [aria-labelledby='nextjs__container_errors_label']";

// ── DOM helpers ────────────────────────────────────────────────────────────────

/** Wait up to `timeoutMs` for the redbox to appear. Rejects with a descriptive
 *  message if it never shows up. */
async function waitForRedbox(browser: BrowserInstance, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await browser.page.evaluate((sel: string) => {
      // The overlay is rendered inside a closed shadow root on <nextjs-portal>.
      // We need to pierce it.
      const portals = document.querySelectorAll("nextjs-portal");
      for (const portal of portals) {
        const root = (portal as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
        if (root && root.querySelector(sel)) return true;
      }
      return false;
    }, REDBOX_DIALOG_SELECTOR);
    if (found) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `waitForRedbox: redbox did not appear within ${timeoutMs}ms.\n` +
      `Selector: ${REDBOX_DIALOG_SELECTOR}`,
  );
}

/** Click the error toast to open the redbox dialog when it is collapsed. */
async function openRedbox(browser: BrowserInstance, timeoutMs = 10_000): Promise<void> {
  // First, wait for the toast / dev-tools button to appear.
  const toastSelector = "nextjs-portal [data-nextjs-dev-tools-button]";
  const deadline = Date.now() + timeoutMs;
  let toastFound = false;
  while (Date.now() < deadline) {
    toastFound = await browser.page.evaluate((sel: string) => {
      const portals = document.querySelectorAll("nextjs-portal");
      for (const portal of portals) {
        const root = (portal as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
        if (root && root.querySelector(sel)) return true;
      }
      return false;
    }, toastSelector);
    if (toastFound) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!toastFound) {
    throw new Error(
      `openRedbox: toast/dev-tools button did not appear within ${timeoutMs}ms. ` +
        `Make sure an error occurred and the redbox is collapsed.`,
    );
  }
  // Click the toast to open the full redbox.
  await browser.page.evaluate((sel: string) => {
    const portals = document.querySelectorAll("nextjs-portal");
    for (const portal of portals) {
      const root = (portal as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
      const btn = root?.querySelector<HTMLElement>(sel);
      if (btn) {
        btn.click();
        return;
      }
    }
  }, toastSelector);
  // Wait for the full redbox dialog.
  await waitForRedbox(browser, timeoutMs);
}

type RedboxTextContent = string | null;

/** Read a text value from inside the shadow-root redbox dialog. */
async function readRedboxField(
  browser: BrowserInstance,
  fieldSelector: string,
): Promise<RedboxTextContent> {
  return browser.page.evaluate(
    ({ dialogSel, fieldSel }: { dialogSel: string; fieldSel: string }) => {
      const portals = document.querySelectorAll("nextjs-portal");
      for (const portal of portals) {
        const root = (portal as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
        const dialog = root?.querySelector(dialogSel);
        if (!dialog) continue;
        const el = dialog.querySelector(fieldSel);
        return el ? (el as HTMLElement).innerText.trim() : null;
      }
      return null;
    },
    { dialogSel: REDBOX_DIALOG_SELECTOR, fieldSel: fieldSelector },
  );
}

/** Read multiple text values from inside the shadow-root redbox dialog. */
async function readRedboxFieldAll(
  browser: BrowserInstance,
  fieldSelector: string,
): Promise<string[]> {
  return browser.page.evaluate(
    ({ dialogSel, fieldSel }: { dialogSel: string; fieldSel: string }) => {
      const portals = document.querySelectorAll("nextjs-portal");
      for (const portal of portals) {
        const root = (portal as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
        const dialog = root?.querySelector(dialogSel);
        if (!dialog) continue;
        const els = dialog.querySelectorAll(fieldSel);
        return Array.from(els).map((el) => (el as HTMLElement).innerText.trim());
      }
      return [];
    },
    { dialogSel: REDBOX_DIALOG_SELECTOR, fieldSel: fieldSelector },
  );
}

// ── Data extraction helpers (mirror next-test-utils getRedbox* functions) ──────

async function getRedboxLabel(browser: BrowserInstance): Promise<string | null> {
  return readRedboxField(browser, "[id^='nextjs__container_errors_label']");
}

async function getRedboxEnvironmentLabel(browser: BrowserInstance): Promise<string | null> {
  return readRedboxField(browser, "[data-nextjs-environment-label]");
}

async function getRedboxDescription(browser: BrowserInstance): Promise<string | null> {
  return readRedboxField(browser, "[id^='nextjs__container_errors_desc']");
}

async function getRedboxSource(browser: BrowserInstance): Promise<string | null> {
  return readRedboxField(browser, "[data-nextjs-codeframe]");
}

async function getRedboxErrorCode(browser: BrowserInstance): Promise<string | null> {
  return readRedboxField(browser, "[data-nextjs-error-code]");
}

async function getRedboxCallStack(browser: BrowserInstance): Promise<string[] | null> {
  const frames = await readRedboxFieldAll(
    browser,
    "[data-nextjs-call-stack-frame] [data-nextjs-frame-expanded='true']",
  );
  return frames.length > 0 ? frames : null;
}

// ── Snapshot builder ───────────────────────────────────────────────────────────

type RedboxSnapshot = {
  code?: string;
  description?: string;
  environmentLabel: string | null;
  label: string | null;
  source: string | null;
  stack: string[];
};

/**
 * Normalise the source frame the same way Next.js does: strip surrounding
 * context lines and keep only the header, the errored line (">"), and cursor.
 */
function focusSource(source: string | null): string | null {
  if (source === null) return null;
  let focused = "";
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line === "") continue;
    if (line.startsWith(">")) {
      focused += "\n" + line;
      if (i + 1 < lines.length) focused += "\n" + lines[i + 1];
      break;
    }
    const isCodeFrameLine = /^ {2}\s*\d+ \|/.test(line);
    if (!isCodeFrameLine) {
      focused += "\n" + line;
    }
  }
  return focused.trim() || null;
}

async function buildRedboxSnapshot(browser: BrowserInstance): Promise<RedboxSnapshot> {
  const [label, environmentLabel, description, rawSource, code, callStack] = await Promise.all([
    getRedboxLabel(browser),
    getRedboxEnvironmentLabel(browser),
    getRedboxDescription(browser),
    getRedboxSource(browser),
    getRedboxErrorCode(browser),
    getRedboxCallStack(browser),
  ]);

  const snapshot: RedboxSnapshot = {
    environmentLabel,
    label,
    description: description ?? undefined,
    source: focusSource(rawSource),
    stack: callStack ?? [],
  };

  if (code !== null) {
    snapshot.code = code;
  }

  return snapshot;
}

// ── Inline snapshot comparison (mirrors jest-snapshot toMatchInlineSnapshot) ───
//
// Vitest ships its own inline-snapshot engine. We can reach it via the
// `expect` API: `expect(actual).toMatchInlineSnapshot(snapshot?)`.
// However custom matchers can't call other matchers directly via `this`.
// Instead we delegate to the public `expect(actual).toMatchInlineSnapshot()`.

// ── Register matchers ─────────────────────────────────────────────────────────

expect.extend({
  async toDisplayRedbox(
    this: { isNot: boolean; promise: string },
    browser: BrowserInstance,
    expectedSnapshot?: string,
  ) {
    // Capture a sync stack for better error reporting.
    const syncError = new Error();

    let snapshot: unknown;
    try {
      await waitForRedbox(browser);
      snapshot = await buildRedboxSnapshot(browser);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Delegate to Vitest's own inline-snapshot matcher so the snapshot can
      // be auto-written on first run.
      try {
        if (expectedSnapshot === undefined) {
          expect(msg).toMatchInlineSnapshot();
        } else {
          expect(msg).toMatchInlineSnapshot(expectedSnapshot);
        }
      } catch (matchErr) {
        return {
          pass: false,
          message: () =>
            `${(matchErr as Error).message}\n\nOriginal error: ${(syncError as Error).stack}`,
        };
      }
      return { pass: false, message: () => msg };
    }

    try {
      if (expectedSnapshot === undefined) {
        expect(snapshot).toMatchInlineSnapshot();
      } else {
        expect(snapshot).toMatchInlineSnapshot(expectedSnapshot);
      }
    } catch (matchErr) {
      return {
        pass: false,
        message: () =>
          `${(matchErr as Error).message}\n\nSync callsite:\n${(syncError as Error).stack}`,
      };
    }

    return { pass: true, message: () => "expected no redbox to be displayed" };
  },

  async toDisplayCollapsedRedbox(
    this: { isNot: boolean; promise: string },
    browser: BrowserInstance,
    expectedSnapshot?: string,
  ) {
    const syncError = new Error();

    let snapshot: unknown;
    try {
      await openRedbox(browser);
      snapshot = await buildRedboxSnapshot(browser);
    } catch (err: unknown) {
      const msg = (err instanceof Error ? err.message : String(err)).replace(
        "waitForRedbox",
        "toDisplayRedbox",
      );
      try {
        if (expectedSnapshot === undefined) {
          expect(msg).toMatchInlineSnapshot();
        } else {
          expect(msg).toMatchInlineSnapshot(expectedSnapshot);
        }
      } catch (matchErr) {
        return {
          pass: false,
          message: () =>
            `${(matchErr as Error).message}\n\nOriginal error: ${(syncError as Error).stack}`,
        };
      }
      return { pass: false, message: () => msg };
    }

    try {
      if (expectedSnapshot === undefined) {
        expect(snapshot).toMatchInlineSnapshot();
      } else {
        expect(snapshot).toMatchInlineSnapshot(expectedSnapshot);
      }
    } catch (matchErr) {
      return {
        pass: false,
        message: () =>
          `${(matchErr as Error).message}\n\nSync callsite:\n${(syncError as Error).stack}`,
      };
    }

    return { pass: true, message: () => "expected no redbox to be displayed" };
  },
});

// ─── jest-extended compat matchers ────────────────────────────────────────────
//
// Some ported Next.js tests use jest-extended matchers that are not available in
// Vitest's built-in Chai assertions. We shim the subset actually used.

expect.extend({
  toInclude(received: string, expected: string) {
    const pass = typeof received === "string" && received.includes(expected);
    return {
      pass,
      message: () =>
        pass
          ? `expected string not to include "${expected}"`
          : `expected string to include "${expected}" but got "${received}"`,
    };
  },

  toIncludeAllMembers(received: unknown[], expected: unknown[]) {
    const pass =
      Array.isArray(received) &&
      Array.isArray(expected) &&
      expected.every((item) => received.includes(item));
    return {
      pass,
      message: () =>
        pass
          ? `expected array not to include all members ${JSON.stringify(expected)}`
          : `expected ${JSON.stringify(received)} to include all members ${JSON.stringify(expected)}`,
    };
  },
});

// ─── Types ────────────────────────────────────────────────────────────────────

type ManifestLeaf = string[];
type ManifestNode = { [key: string]: ManifestNode | ManifestLeaf };
type ManifestRoot = ManifestNode;

// ─── Load manifest ────────────────────────────────────────────────────────────

const manifest: ManifestRoot = JSON.parse(
  readFileSync(join(import.meta.dirname, "skip-manifest.json"), "utf-8"),
);

// ─── Runtime lookup with "*" fallback ────────────────────────────────────────
//
// Walk the manifest tree one path segment at a time. At each node:
//   1. Try the exact segment key first.
//   2. If not found, fall back to the "*" key if present.
//   3. If neither exists, there are no matchers for this path → return null.
//
// When we reach a leaf (string[]) we return it as the matcher set.
// A flat key like "app-dir/app/index.test.ts" is split on "/" and treated as
// multiple segments, so flat and nested forms both work.

function lookup(segments: string[]): Set<string> | null {
  // oxlint-disable-next-line typescript/no-explicit-any
  let node: any = manifest;

  for (const seg of segments) {
    if (Array.isArray(node)) {
      // We've hit a leaf before consuming all segments — no match.
      return null;
    }

    if (Object.prototype.hasOwnProperty.call(node, seg)) {
      node = node[seg];
    } else if (Object.prototype.hasOwnProperty.call(node, "*")) {
      const wildcard = node["*"];
      // If the wildcard is a leaf array, it applies to this entire subtree —
      // return it immediately without consuming the remaining segments.
      if (Array.isArray(wildcard)) return new Set(wildcard as string[]);
      node = wildcard;
    } else {
      return null;
    }
  }

  if (Array.isArray(node)) {
    return new Set(node as string[]);
  }

  // Landed on an intermediate node (directory), not a leaf — check for "*".
  // oxlint-disable-next-line typescript/no-explicit-any
  if (Object.prototype.hasOwnProperty.call(node, "*")) {
    const wildcard = (node as ManifestNode)["*"];
    if (Array.isArray(wildcard)) return new Set(wildcard as string[]);
  }

  return null;
}

// ─── Resolve skip set for the current test file ───────────────────────────────

// `expect.getState().testPath` is populated by Vitest before setupFiles run
// and refers to the test file being collected, not this setup file.
const relPath = normalize(
  relative(join(import.meta.dirname, "clone"), expect.getState().testPath ?? ""),
).replace(/\\/g, "/");

// Split on "/" to get individual segments for the tree walk.
const skipMatchers = lookup(relPath.split("/")) ?? new Set<string>();

// ─── Matcher logic ────────────────────────────────────────────────────────────

const _testMode = process.env.NEXT_TEST_MODE ?? "dev";

/** Test whether a single leaf matcher string matches a test name. */
function matchesMatcher(name: string, matcher: string): boolean {
  if (matcher === "*") return true;
  if (matcher.startsWith("$contains:")) return name.includes(matcher.slice("$contains:".length));
  return name === matcher;
}

function shouldSkip(name: string): boolean {
  for (const matcher of skipMatchers) {
    let effective = matcher;

    // Mode-gated prefixes: only apply when the current mode matches.
    if (matcher.startsWith("$mode_start:")) {
      if (_testMode !== "start") continue;
      effective = matcher.slice("$mode_start:".length);
    } else if (matcher.startsWith("$mode_dev:")) {
      if (_testMode !== "dev") continue;
      effective = matcher.slice("$mode_dev:".length);
    }

    if (matchesMatcher(name, effective)) return true;
  }
  return false;
}

/**
 * Expand an it.each template string for a given row object.
 * Vitest replaces `$key` with `'stringValue'` (single-quoted) or the raw
 * string representation for non-strings.
 */
function expandEachTemplate(template: string, row: unknown): string {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return template;
  return template.replace(/\$([\w.]+)/g, (match, key) => {
    const val = (row as Record<string, unknown>)[key];
    if (val === undefined) return match;
    if (typeof val === "string") return `'${val}'`;
    return String(val);
  });
}

// ─── Wrap it / test ───────────────────────────────────────────────────────────
//
// We use a Proxy rather than Object.assign so that every property access
// (including `it.each`, `it.skip`, `it.only`, etc.) is forwarded to the
// real runner with the correct `this`. Object.assign copies function
// references but loses the internal `this` binding that Vitest's `each`
// implementation relies on (`withContext`), causing a runtime crash.

function wrapRunner(runner: typeof it): typeof it {
  return new Proxy(runner, {
    apply(_target, _thisArg, args: unknown[]) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const [name, ...rest] = args as [string, ...any[]];
      if (shouldSkip(name)) return runner.skip(name, ...rest);
      return runner(name, ...rest);
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // `it.each(table)` returns a registrar function that is later called
      // with the generated test name. Wrap that registrar so the generated
      // names also pass through shouldSkip.
      if (prop === "each" && typeof value === "function") {
        // oxlint-disable-next-line typescript/no-explicit-any
        return (...tableArgs: any[]) => {
          // For per-row skip matching, we need the raw table of objects.
          const rawTable: unknown[] | null =
            Array.isArray(tableArgs[0]) && tableArgs.length === 1 ? tableArgs[0] : null;

          // oxlint-disable-next-line typescript/no-explicit-any
          const registrar = (value as any).call(target, ...tableArgs);
          if (typeof registrar !== "function") return registrar;
          // oxlint-disable-next-line typescript/no-explicit-any
          const wrapped = (name: string, fn: unknown, ...rest: any[]) => {
            if (shouldSkip(name)) return runner.skip(name, fn as any, ...rest);

            // For object-row tables, also check per-row expanded names so that
            // individual it.each variants can be skipped without skipping the
            // whole parameterised group.
            if (
              rawTable &&
              rawTable.length > 0 &&
              typeof rawTable[0] === "object" &&
              !Array.isArray(rawTable[0])
            ) {
              const keepRows: unknown[] = [];
              const skipRows: unknown[] = [];
              for (const row of rawTable) {
                if (shouldSkip(expandEachTemplate(name, row))) skipRows.push(row);
                else keepRows.push(row);
              }

              if (skipRows.length > 0 && keepRows.length === 0) {
                // All rows skipped — use the template-level skip.
                return runner.skip(name, fn as any, ...rest);
              }

              if (skipRows.length > 0) {
                // Some rows skipped — register each skipped row individually,
                // then run the remaining rows with a filtered table.
                for (const row of skipRows) {
                  runner.skip(expandEachTemplate(name, row), fn as any);
                }
                // oxlint-disable-next-line typescript/no-explicit-any
                const filteredRegistrar = (value as any).call(target, keepRows);
                if (typeof filteredRegistrar === "function") {
                  return filteredRegistrar(name, fn, ...rest);
                }
                return;
              }
            }

            return registrar(name, fn, ...rest);
          };
          // Preserve .skip/.only on the returned registrar as well.
          return Object.assign(wrapped, registrar);
        };
      }
      return value;
    },
  });
}

// Patch globalThis so upstream test files (which don't import these globals)
// pick up the wrapped versions.
(globalThis as Record<string, unknown>).it = wrapRunner(it);
(globalThis as Record<string, unknown>).test = wrapRunner(test);
