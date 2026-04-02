/**
 * Shared utilities for reading/writing vinext-server.json.
 *
 * Kept in a separate file so both build-time code (prerender.ts) and
 * runtime code (prod-server.ts) can import it without creating a circular
 * dependency.
 */

import path from "node:path";
import fs from "node:fs";

/**
 * Read the prerender secret from `vinext-server.json` in `serverDir`.
 *
 * Returns `undefined` if the file does not exist or cannot be parsed.
 * Callers that require a secret (i.e. the prerender phase itself) should
 * warn when this returns `undefined`.
 */
export function readPrerenderSecret(serverDir: string): string | undefined {
  const manifestPath = path.join(serverDir, "vinext-server.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return manifest.prerenderSecret as string | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the buildId from `vinext-server.json` in `serverDir`.
 *
 * Returns `undefined` if the file does not exist, cannot be parsed, or does
 * not contain a buildId field. The buildId is the same value that was baked
 * into the compiled RSC bundle via Vite's `define` plugin. It must be used
 * when writing the prerender manifest so that ISR cache keys set during
 * cache seeding match the keys the prod server looks up at request time.
 */
export function readBuildId(serverDir: string): string | undefined {
  const manifestPath = path.join(serverDir, "vinext-server.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return manifest.buildId as string | undefined;
  } catch {
    return undefined;
  }
}
