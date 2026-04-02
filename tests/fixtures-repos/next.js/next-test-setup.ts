/**
 * nextTestSetup — vinext-backed shim for the Next.js `e2e-utils` API.
 *
 * Mirrors the interface used by tests in next.js/test/e2e/ so they can run
 * against a Vite + vinext dev server with minimal modification.
 *
 * Usage (in a ported Next.js test file):
 *
 *   import { nextTestSetup } from '../../next-test-setup.js'
 *
 *   describe('my feature', () => {
 *     const { next, isNextDev } = nextTestSetup({ files: __dirname })
 *
 *     it('renders', async () => {
 *       const html = await next.render('/')
 *       expect(html).toContain('hello')
 *     })
 *
 *     it('parses', async () => {
 *       const $ = await next.render$('/')
 *       expect($('h1').text()).toBe('Hello World')
 *     })
 *
 *     it('uses a browser', async () => {
 *       const browser = await next.browser('/')
 *       expect(await browser.elementByCss('h1').text()).toBe('Hello World')
 *       await browser.close()
 *     })
 *   })
 *
 * The `files` option must be `__dirname`. The directory that contains the test
 * file is also the Next.js app fixture — an app/ or pages/ directory lives
 * right alongside the test, exactly as the upstream Next.js test runner expects.
 *
 * ── next.* API ────────────────────────────────────────────────────────────────
 *
 *   next.url                       string             base URL, no trailing slash
 *   next.render(path, init?)       Promise<string>    full HTML text
 *   next.render$(path, init?)      Promise<CheerioAPI>  cheerio selector fn
 *   next.fetch(path, init?)        Promise<Response>  raw fetch
 *   next.browser(path, opts?)      Promise<BrowserInstance>
 *
 * ── cheerio $ ─────────────────────────────────────────────────────────────────
 *
 *   $('selector').text()           string             concatenated inner text
 *   $('selector').html()           string | null      inner HTML of first match
 *   $('selector').attr(name)       string | undefined attribute value
 *   $('selector').length           number             match count
 *   $.html()                       string             full document HTML
 *
 *   Full cheerio selector support — any CSS selector that cheerio understands
 *   works, including descendant selectors, pseudo-selectors, etc.
 *
 * ── BrowserInstance ───────────────────────────────────────────────────────────
 *
 *   browser.elementByCss(sel)              ElementProxy         (lazy, chainable)
 *   browser.elementById(id)                ElementProxy         (lazy, chainable)
 *   browser.elementsByCss(sel)             Promise<ElementProxy[]>
 *   browser.hasElementByCssSelector(sel)   Promise<boolean>
 *   browser.waitForElementByCss(sel, ms?)  Promise<ElementProxy>
 *   browser.waitForIdleNetwork(ms?)        Promise<void>
 *   browser.eval(expr)                     Promise<unknown>
 *   browser.url()                          Promise<string>
 *   browser.loadPage(url, opts?)           Promise<void>
 *   browser.back()                         Promise<void>
 *   browser.forward()                      Promise<void>
 *   browser.refresh()                      Promise<void>
 *   browser.close()                        Promise<void>
 *   browser.log()                          Promise<Array<{source:string;message:string}>>
 *   browser.deleteCookies()                Promise<void>
 *   browser.addCookie(cookie)              Promise<void>
 *   browser.on(event, handler)             void    (Playwright Page pass-through)
 *
 * ── ElementProxy ──────────────────────────────────────────────────────────────
 *
 *   element.text()                         Promise<string>
 *   element.html()                         Promise<string>
 *   element.attr(name)                     Promise<string | null>
 *   element.click()                        Promise<ElementProxy>   (chainable)
 *   element.type(text)                     Promise<ElementProxy>
 *   element.getValue()                     Promise<string>
 *   element.waitForElementByCss(sel, ms?)  Promise<ElementProxy>
 *
 * ── Server mode ───────────────────────────────────────────────────────────────
 *
 *   Controlled by the NEXT_TEST_MODE environment variable:
 *
 *     NEXT_TEST_MODE=dev     (default) — Vite dev server, HMR enabled
 *     NEXT_TEST_MODE=start   — production build + prod server (no HMR)
 *     NEXT_TEST_MODE=deploy  — not yet implemented (throws at startup)
 *
 * ── Flags ─────────────────────────────────────────────────────────────────────
 *
 *   isNextDev     true when NEXT_TEST_MODE=dev (or unset)
 *   isNextStart   true when NEXT_TEST_MODE=start
 *   isNextDeploy  true when NEXT_TEST_MODE=deploy
 *   isTurbopack   false
 *   skipped       false
 */

import { beforeAll, afterAll } from "vitest";
import { createServer, createBuilder, type ViteDevServer, transformWithOxc } from "vite";
import vinext from "vinext";
import type { AddressInfo } from "node:net";
import { Page } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

/** dev | start | deploy — controlled by NEXT_TEST_MODE env var */
export type NextTestMode = "dev" | "start" | "deploy";
export const nextTestMode: NextTestMode =
  (process.env.NEXT_TEST_MODE as NextTestMode | undefined) ?? "dev";

// ─── Lazy Playwright singleton ────────────────────────────────────────────────
//
// We launch one shared Chromium process per Vitest worker. Tests that only use
// next.render / next.fetch never touch Playwright at all.

type PWBrowser = import("playwright").Browser;
type PWPage = import("playwright").Page;

let _sharedBrowser: PWBrowser | null = null;

async function getSharedBrowser(): Promise<PWBrowser> {
  if (!_sharedBrowser) {
    const { chromium } = await import("playwright");
    _sharedBrowser = await chromium.launch({ headless: true });
  }
  return _sharedBrowser;
}

// ─── ElementHandle ────────────────────────────────────────────────────────────
//
// A thenable that is also directly an ElementProxy. This lets upstream Next.js
// tests chain off waitForElementByCss / click without awaiting each step:
//
//   browser.waitForElementByCss('#foo').click().waitForElementByCss('#bar').text()
//
// Each method that previously returned Promise<ElementProxy> now returns
// ElementHandle so the chain stays synchronously composable while still being
// awaitable for the terminal value.

export type ElementHandle = Promise<ElementProxy> & ElementProxy;

// ─── ElementProxy ─────────────────────────────────────────────────────────────
//
// Wraps a Playwright locator in the webdriver-style API used by Next.js tests.

export type ElementProxy = {
  text(): Promise<string>;
  html(): Promise<string>;
  attr(name: string): Promise<string | null>;
  click(): ElementHandle;
  type(text: string): ElementHandle;
  getValue(): Promise<string>;
  elementById(id: string): ElementHandle;
  waitForElementByCss(selector: string, timeoutMs?: number): ElementHandle;
};

// Wrap a Promise<ElementProxy> so it also exposes ElementProxy methods directly,
// enabling synchronous chaining without intermediate awaits.
function makeElementHandle(promise: Promise<ElementProxy>, page: PWPage): ElementHandle {
  // oxlint-disable-next-line typescript/no-explicit-any
  const handle = promise as any;
  handle.text = () => promise.then((p) => p.text());
  handle.html = () => promise.then((p) => p.html());
  handle.attr = (name: string) => promise.then((p) => p.attr(name));
  handle.click = () =>
    makeElementHandle(
      promise.then((p) => p.click().then(() => p)),
      page,
    );
  handle.type = (text: string) =>
    makeElementHandle(
      promise.then((p) => p.type(text).then(() => p)),
      page,
    );
  handle.getValue = () => promise.then((p) => p.getValue());
  handle.elementById = (id: string) =>
    makeElementHandle(
      promise.then(() => makeElementProxy(page, `#${id}`)),
      page,
    );
  handle.waitForElementByCss = (sel: string, timeoutMs?: number) =>
    makeElementHandle(
      promise.then(() =>
        page
          .waitForSelector(sel, { timeout: timeoutMs ?? 10_000 })
          .then(() => makeElementProxy(page, sel)),
      ),
      page,
    );
  return handle as ElementHandle;
}

function makeElementProxy(page: PWPage, selector: string): ElementProxy {
  const locator = page.locator(selector).first();

  const proxy: ElementProxy = {
    async text() {
      return locator.innerText();
    },
    async html() {
      return locator.innerHTML();
    },
    async attr(name: string) {
      return locator.getAttribute(name);
    },
    click() {
      return makeElementHandle(
        locator.click().then(() => proxy),
        page,
      );
    },
    type(text: string) {
      return makeElementHandle(
        locator.fill(text).then(() => proxy),
        page,
      );
    },
    async getValue() {
      return locator.inputValue();
    },
    elementById(id: string) {
      return makeElementHandle(Promise.resolve(makeElementProxy(page, `#${id}`)), page);
    },
    waitForElementByCss(sel: string, timeoutMs = 10_000) {
      return makeElementHandle(
        page.waitForSelector(sel, { timeout: timeoutMs }).then(() => makeElementProxy(page, sel)),
        page,
      );
    },
  };
  return proxy;
}

// ─── BrowserInstance ──────────────────────────────────────────────────────────

// A thenable that also exposes ElementProxy methods, returned by
// BrowserInstance.waitForElementByCss so chains like:
//   browser.waitForElementByCss('#foo').click().text()
// type-check without intermediate awaits.

// VoidHandle: returned by waitForIdleNetwork so tests can chain
// .waitForElementByCss off it.
export type VoidHandle = Promise<void> & {
  waitForElementByCss(selector: string, timeoutMs?: number): ElementHandle;
};

export type BrowserInstance = {
  /** Playwright Page — for direct access when needed. */
  readonly page: PWPage;

  elementByCss(selector: string): ElementProxy;
  elementById(id: string): ElementProxy;
  elementsByCss(selector: string): Promise<ElementProxy[]>;
  hasElementByCssSelector(selector: string): Promise<boolean>;
  waitForElementByCss(selector: string, timeoutMs?: number): ElementHandle;
  waitForIdleNetwork(timeoutMs?: number): VoidHandle;
  // oxlint-disable-next-line typescript/no-explicit-any
  eval(expression: string): Promise<any>;
  url(): Promise<string>;
  loadPage(url: string, opts?: { disableCache?: boolean }): Promise<void>;
  back(): VoidHandle;
  forward(): VoidHandle;
  refresh(): VoidHandle;
  close(): Promise<void>;
  log(): Promise<Array<{ source: string; message: string }>>;
  deleteCookies(): Promise<void>;
  addCookie(cookie: {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }): Promise<void>;
  // oxlint-disable-next-line typescript/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void;
};

function makeVoidHandle(p: Promise<void>, page: PWPage): VoidHandle {
  // oxlint-disable-next-line typescript/no-explicit-any
  const handle = p as any;
  handle.waitForElementByCss = (sel: string, ms?: number) =>
    makeElementHandle(
      p.then(() =>
        page
          .waitForSelector(sel, { timeout: ms ?? 10_000 })
          .then(() => makeElementProxy(page, sel)),
      ),
      page,
    );
  return handle as VoidHandle;
}

async function makeBrowserInstance(
  baseUrl: string,
  urlPath: string,
  opts?: BrowserNavigateOptions,
): Promise<BrowserInstance> {
  const browser = await getSharedBrowser();
  const context = await browser.newContext({
    baseURL: baseUrl,
    ...(opts?.locale ? { locale: opts.locale } : {}),
  });
  const page = await context.newPage();

  // Collect console log entries
  const logs: Array<{ source: string; message: string }> = [];
  page.on("console", (msg) => logs.push({ source: msg.type(), message: msg.text() }));

  // beforePageLoad hook — fires before navigation
  if (opts?.beforePageLoad) {
    await opts.beforePageLoad(page);
  }

  const fullUrl = urlPath.startsWith("http") ? urlPath : `${baseUrl}${urlPath}`;
  await page.goto(fullUrl, {
    waitUntil: "domcontentloaded",
    ...(opts?.disableCache ? {} : {}),
  });

  // Wait for React hydration to complete so that client-side event handlers
  // (onClick, etc.) are attached before tests start interacting with the page.
  // app-browser-entry.ts sets window.__VINEXT_HYDRATED_AT after hydration.
  await page
    .waitForFunction(() => typeof (window as any).__VINEXT_HYDRATED_AT === "number", {
      timeout: 15_000,
    })
    .catch(() => {
      // If not an RSC page (e.g. Pages Router or static), hydration marker
      // won't be set — fall through silently and let the test proceed.
    });

  const instance: BrowserInstance = {
    get page() {
      return page;
    },

    elementByCss(selector: string) {
      return makeElementProxy(page, selector);
    },

    elementById(id: string) {
      return makeElementProxy(page, `#${id}`);
    },

    async elementsByCss(selector: string) {
      const locators = await page.locator(selector).all();
      // We don't have a per-locator proxy — return a proxy per index
      return locators.map((_, i) => makeElementProxy(page, `${selector}:nth-match(${i + 1})`));
    },

    async hasElementByCssSelector(selector: string) {
      return (await page.locator(selector).count()) > 0;
    },

    waitForElementByCss(selector: string, timeoutMs = 10_000) {
      return makeElementHandle(
        page
          .waitForSelector(selector, { timeout: timeoutMs })
          .then(() => makeElementProxy(page, selector)),
        page,
      );
    },

    waitForIdleNetwork(timeoutMs = 10_000) {
      return makeVoidHandle(
        page.waitForLoadState("networkidle", { timeout: timeoutMs }).then(() => undefined as void),
        page,
      );
    },

    async eval(expression: string) {
      return page.evaluate(expression);
    },

    async url() {
      return page.url();
    },

    async loadPage(url: string, pageOpts?: { disableCache?: boolean }) {
      if (pageOpts?.disableCache) {
        await context.route("**/*", (route) => route.continue());
      }
      await page.goto(url.startsWith("http") ? url : `${baseUrl}${url}`, {
        waitUntil: "domcontentloaded",
      });
    },

    back() {
      return makeVoidHandle(
        page.goBack().then(() => undefined as void),
        page,
      );
    },

    forward() {
      return makeVoidHandle(
        page.goForward().then(() => undefined as void),
        page,
      );
    },

    refresh() {
      return makeVoidHandle(
        page.reload().then(() => undefined as void),
        page,
      );
    },

    async close() {
      await context.close();
    },

    async log() {
      return [...logs];
    },

    async deleteCookies() {
      await context.clearCookies();
    },

    async addCookie(cookie) {
      await context.addCookies([
        {
          ...cookie,
          domain: cookie.domain ?? new URL(baseUrl).hostname,
          path: cookie.path ?? "/",
        },
      ]);
    },

    on(event: string, handler: (...args: unknown[]) => void) {
      // oxlint-disable-next-line typescript/no-explicit-any
      (page as any).on(event, handler);
    },
  };

  return instance;
}

// ─── nextTestSetup ────────────────────────────────────────────────────────────

export type NextTestSetupOptions = {
  /**
   * The fixture directory — pass `__dirname`. This directory is both the test
   * file's location and the root of the Next.js app (contains app/ or pages/).
   */
  files: string;

  /**
   * Ignored. Exists only for API compatibility with the upstream Next.js
   * `nextTestSetup` — deployment tests are never run against vinext.
   */
  skipDeployment?: boolean;

  /**
   * Ignored. Exists for API compatibility. Dependency resolutions are
   * handled by pnpm at the workspace level.
   */
  resolutions?: Record<string, string>;

  /** Ignored — build commands are not used in the vinext dev-server context. */
  buildCommand?: string;

  /**
   * When true the server is NOT started immediately — the caller must call
   * `next.start()` manually before making requests.
   */
  skipStart?: boolean;

  skipBuild?: boolean;

  /** Ignored — package.json overrides are handled at the workspace level. */
  // oxlint-disable-next-line typescript/no-explicit-any
  packageJson?: Record<string, any>;

  /** Ignored — dependencies are managed by pnpm at the workspace level. */
  dependencies?: Record<string, string>;

  /** Ignored — env vars should be set in the process environment before running. */
  env?: Record<string, string>;
};

type BrowserNavigateOptions = {
  locale?: string;
  disableCache?: boolean;
  /**
   * Ignored — vinext always waits for domcontentloaded. Exists for API
   * compatibility with the upstream Next.js test suite.
   */
  waitHydration?: boolean;
  // oxlint-disable-next-line typescript/no-explicit-any
  beforePageLoad?: (page: Page) => void | Promise<void>;
};

export type NextInstance = {
  /** Base URL of the running dev server, e.g. "http://localhost:52341" */
  url: string;
  /**
   * Root directory used by the test to locate build artifacts.
   * In dev mode: the fixture directory (opts.files).
   * In start mode: the tmpDir where the production build was written.
   * Mirrors the upstream Next.js e2e `next.testDir` property.
   */
  testDir: string;
  fetch(urlPath: string, init?: RequestInit): Promise<Response>;
  render(urlPath: string, query?: Record<string, string> | RequestInit, init?: RequestInit): Promise<string>;
  render$(urlPath: string, query?: Record<string, string> | RequestInit, init?: RequestInit): Promise<CheerioStatic>;
  // oxlint-disable-next-line typescript/no-explicit-any
  browser(urlPath: string, opts?: BrowserNavigateOptions): Promise<BrowserInstance>;

  /** Read a file from the fixture directory. */
  readFile(filePath: string): Promise<string>;
  /** Read and parse a JSON file from the fixture directory. */
  // oxlint-disable-next-line typescript/no-explicit-any
  readJSON(filePath: string): Promise<any>;
  /** Overwrite a file in the fixture directory. Triggers HMR. */
  patchFile(filePath: string, content: string): Promise<void>;
  /** Delete a file from the fixture directory. Triggers HMR. */
  deleteFile(filePath: string): Promise<void>;
  /** Server CLI output so far. Stub — returns empty string. */
  cliOutput: string;
  /** Subscribe to server events (e.g. 'stderr'). Stub — no-op. */
  // oxlint-disable-next-line typescript/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void;
  /** Stop the dev server. */
  stop(): Promise<void>;
  /** Start the dev server (used with createNext({ skipStart: true })). */
  start(opts: { skipBuild?: boolean }): Promise<void>;
  /**
   * Tear down the dev server. Matches the upstream Next.js `next.destroy()`
   * API used by tests that call createNext() directly.
   */
  destroy(): Promise<void>;
  /** The build command string. Mutable for API compat. */
  buildCommand: string;
  /** Env vars passed to nextTestSetup. */
  env: Record<string, string>;
};

export type NextTestSetupResult = {
  next: NextInstance;
  /** True when running in dev mode (NEXT_TEST_MODE=dev or unset). */
  isNextDev: boolean;
  /** True when running in start (production) mode (NEXT_TEST_MODE=start). */
  isNextStart: boolean;
  /** True when running in deploy mode (NEXT_TEST_MODE=deploy). */
  isNextDeploy: boolean;
  /** Always false — vinext does not use Turbopack. */
  isTurbopack: false;
  /** Always false — vinext does not use Rspack. */
  isRspack: false;
  /**
   * Always false. Set to true in the upstream Next.js test suite when the
   * test is skipped due to deployment mode. vinext never skips on this basis.
   */
  skipped: false;
};

/**
 * Start a vinext (Vite + Next.js) dev server against the given fixture
 * directory and return a `next` object whose API matches the upstream
 * Next.js `nextTestSetup` helper.
 *
 * Call this at the top of a `describe` block. The server is started in
 * `beforeAll` and torn down in `afterAll`.
 */
export function nextTestSetup(opts: NextTestSetupOptions): NextTestSetupResult {
  let next!: NextInstance;

  // Production builds can take 2–3 min; give them extra headroom.
  const setupTimeout = nextTestMode === "start" ? 300_000 : 90_000;

  beforeAll(async () => {
    next = await createNext(opts);
  }, setupTimeout);

  afterAll(async () => {
    await next?.destroy();
  });

  // Return a proxy so that `next` resolves after beforeAll runs.
  const proxy = new Proxy({} as NextInstance, {
    get(_t, prop) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const val = (next as any)[prop];
      return typeof val === "function" ? val.bind(next) : val;
    },
    set(_t, prop, value) {
      // oxlint-disable-next-line typescript/no-explicit-any
      (next as any)[prop] = value;
      return true;
    },
  });

  return {
    next: proxy,
    isNextDev: nextTestMode === "dev",
    isNextStart: nextTestMode === "start",
    isNextDeploy: nextTestMode === "deploy",
    isTurbopack: false,
    isRspack: false,
    skipped: false,
  };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function buildViteConfig(
  files: string,
  onLog: (msg: string) => void,
): Parameters<typeof createServer>[0] {
  const customLogger = {
    info(msg: string) {
      onLog(msg);
      process.stdout.write(msg + "\n");
    },
    warn(msg: string) {
      onLog(msg);
      process.stderr.write(msg + "\n");
    },
    warnOnce(msg: string) {
      onLog(msg);
      process.stderr.write(msg + "\n");
    },
    error(msg: string) {
      onLog(msg);
      process.stderr.write(msg + "\n");
    },
    clearScreen() {},
    hasErrorLogged() {
      return false;
    },
    hasWarned: false,
  };
  return {
    root: files,
    configFile: false,
    customLogger,
    plugins: [
      // Next.js fixture files are plain .js but contain JSX. OXC derives
      // lang:"js" from the extension which disables JSX parsing. This
      // enforce:"pre" plugin intercepts .js files before vite:oxc and
      // transforms them with lang:"jsx" explicitly so JSX is handled.
      {
        name: "vinext-e2e:js-as-jsx",
        enforce: "pre" as const,
        async transform(code: string, id: string) {
          if (!id.endsWith(".js") || id.includes("node_modules")) return;
          // oxlint-disable-next-line typescript/no-explicit-any
          return transformWithOxc(code, id, { lang: "jsx" } as any);
        },
      },
      vinext({ appDir: files }),
    ],
    // Hold dep-optimisation until after the first crawl pass to avoid the
    // "outdated pre-bundle" 504 responses that occur in non-browser test
    // clients (which can't trigger the auto-reload that Vite expects).
    // Also tell rolldown's dep scanner to treat .js as JSX so it doesn't
    // choke on Next.js fixture files that use JSX in plain .js files.
    optimizeDeps: {
      holdUntilCrawlEnd: true,
      // oxlint-disable-next-line typescript/no-explicit-any
      rolldownOptions: { moduleTypes: { ".js": "jsx" } } as any,
    },
    server: { port: 0, cors: false },
    logLevel: "info",
  } as Parameters<typeof createServer>[0];
}

/**
 * Patch a fetch Response so its body supports Node.js EventEmitter-style
 * `.on('data', cb)` that some upstream Next.js tests use.
 *
 * The Web Streams API `ReadableStream` doesn't have `.on()`. We attach a
 * shim that, when `'data'` is subscribed, tees the body stream so that:
 *   1. The event listener fork drains asynchronously, firing 'data' callbacks.
 *   2. The other fork replaces res.body so `.text()` / `.json()` still work.
 */
function patchResponseBodyForNodeCompat(res: Response): Response {
  const body = res.body;
  if (!body) return res;
  // oxlint-disable-next-line typescript/no-explicit-any
  const b = body as any;
  if (typeof b.on === "function") return res; // already patched or native Node stream

  const listeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();

  // We lazily tee on the first 'data' subscription. Until then, body is untouched.
  let eventFork: ReadableStream<Uint8Array> | null = null;

  // Replace the Response body with a getter that returns the consumer fork once
  // the stream has been teed, so .text()/.json() read from the right half.
  // We need to swap the body on the Response object itself; since Response.body
  // is read-only we wrap in a new Response that delegates everything else.
  let consumerResponse = res;

  b.on = function (event: string, cb: (...args: unknown[]) => void) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event)!.push(cb);

    if (event === "data" && !b._draining) {
      b._draining = true;

      // Tee the original body: one fork for event callbacks, one for .text()/.json().
      const [eventStream, consumerStream] = body.tee();
      eventFork = eventStream;

      // Rebuild the consumer Response with the consumer half of the tee.
      // Copy status, statusText, and headers from the original.
      consumerResponse = new Response(consumerStream, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
      // Keep a reference so fetch() returns the patched version.
      (res as any)._consumerResponse = consumerResponse;

      // Start draining the event fork asynchronously.
      const reader = eventFork.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              for (const c of listeners.get("end") ?? []) c();
              break;
            }
            for (const c of listeners.get("data") ?? []) c(value);
          }
        } catch (err) {
          for (const c of listeners.get("error") ?? []) c(err);
        }
      })();
    }
    return b;
  };

  b.removeListener = function (event: string, cb: (...args: unknown[]) => void) {
    const cbs = listeners.get(event);
    if (cbs) {
      const idx = cbs.indexOf(cb);
      if (idx !== -1) cbs.splice(idx, 1);
    }
    return b;
  };

  // Return a proxy so that after tee, .text()/.json()/.body/.arrayBuffer() etc.
  // are forwarded to the consumer half, while .body itself returns the
  // original (event-listener-attached) stream object (for further .on() calls).
  return new Proxy(res, {
    get(target, prop) {
      // Always serve .body from the original response so .on() is available.
      if (prop === "body") return target.body;
      // For everything else that reads the body, use the consumer fork once teed.
      const src = (target as any)._consumerResponse ?? target;
      const val = (src as any)[prop];
      return typeof val === "function" ? val.bind(src) : val;
    },
  });
}

function makeNextInstance(
  opts: NextTestSetupOptions,
  doStart: () => Promise<void>,
  doStop: () => Promise<void>,
  getBaseUrl: () => string,
  getCliOutput?: () => string,
  testDir?: string,
): NextInstance {
  const next: NextInstance = {
    testDir: testDir ?? opts.files,

    get url() {
      return getBaseUrl();
    },

    get cliOutput() {
      return getCliOutput ? getCliOutput() : "";
    },
    set cliOutput(_val: string) {
      // ignore writes — cliOutput is read-only via getter
    },
    buildCommand: opts.buildCommand ?? "",
    env: opts.env ?? {},

    async readFile(filePath: string) {
      const abs = path.join(opts.files, filePath);
      try {
        return fs.readFileSync(abs, "utf-8");
      } catch {
        return "";
      }
    },
    // oxlint-disable-next-line typescript/no-explicit-any
    async readJSON(filePath: string): Promise<any> {
      const abs = path.join(opts.files, filePath);
      try {
        return JSON.parse(fs.readFileSync(abs, "utf-8"));
      } catch {
        return {};
      }
    },
    async patchFile(filePath: string, content: string) {
      const abs = path.join(opts.files, filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf-8");
      // Brief wait for Vite HMR to pick up the change
      await new Promise((r) => setTimeout(r, 200));
    },
    async deleteFile(filePath: string) {
      const abs = path.join(opts.files, filePath);
      try {
        fs.rmSync(abs);
      } catch {
        // ignore if already gone
      }
      // Brief wait for Vite HMR to pick up the change
      await new Promise((r) => setTimeout(r, 200));
    },
    on(_event: string, _handler: (...args: unknown[]) => void) {
      // stub — server event subscription not implemented
    },

    async start() {
      await doStart();
    },
    async stop() {
      await doStop();
    },
    async destroy() {
      await doStop();
    },

    fetch(urlPath: string, init?: RequestInit) {
      // Upstream Next.js tests occasionally omit the leading slash, e.g.
      //   next.fetch('isr-multiple/nested')
      // Normalise so we always produce a valid URL.
      const baseUrl = getBaseUrl();
      const normalised = urlPath.startsWith("http")
        ? urlPath
        : `${baseUrl}${urlPath.startsWith("/") ? urlPath : `/${urlPath}`}`;
      return fetch(normalised, init).then(patchResponseBodyForNodeCompat);
    },

    async render(urlPath: string, queryOrInit?: Record<string, string> | RequestInit, init?: RequestInit) {
      // Support both (path, init?) and (path, query, init?) signatures.
      let resolvedInit: RequestInit | undefined;
      if (init !== undefined) {
        // 3-arg form: (path, query, init) — query is currently ignored (no query support needed)
        resolvedInit = init;
      } else if (queryOrInit && ("headers" in queryOrInit || "method" in queryOrInit || "body" in queryOrInit || "signal" in queryOrInit || "redirect" in queryOrInit)) {
        // 2-arg form: (path, init) — second arg looks like RequestInit
        resolvedInit = queryOrInit as RequestInit;
      }
      // else: 2-arg form with query object — no init
      return (await next.fetch(urlPath, resolvedInit)).text();
    },

    async render$(urlPath: string, queryOrInit?: Record<string, string> | RequestInit, init?: RequestInit) {
      const html = await next.render(urlPath, queryOrInit, init);
      const { load } = await import("cheerio");
      return load(html);
    },

    async browser(urlPath: string, browserOpts?: BrowserNavigateOptions) {
      return makeBrowserInstance(getBaseUrl(), urlPath, browserOpts);
    },
  };
  return next;
}

/**
 * Create a vinext dev server and return a NextInstance directly (no
 * beforeAll/afterAll wiring). Matches the upstream Next.js `createNext` API:
 *
 *   let next: NextInstance
 *   beforeAll(async () => {
 *     next = await createNext({ files: __dirname, skipStart: true })
 *     await next.start()
 *   })
 *   afterAll(() => next.destroy())
 */
export async function createNext(opts: NextTestSetupOptions): Promise<NextInstance> {
  if (nextTestMode === "deploy") {
    throw new Error(
      "[vinext] NEXT_TEST_MODE=deploy is not yet implemented. " +
        "Set NEXT_TEST_MODE to 'dev' (default) or 'start'.",
    );
  }
  if (nextTestMode === "start") {
    return createNextStartServer(opts);
  }
  return createNextDevServer(opts);
}

async function createNextStartServer(opts: NextTestSetupOptions): Promise<NextInstance> {
  const os = await import("node:os");
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vinext-test-start-"));
  let _buildOutput = "";
  let _httpServer: import("node:http").Server | null = null;

  try {
    // Capture build output
    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);
    const capture = (...args: unknown[]) => {
      _buildOutput += args.map(String).join(" ") + "\n";
    };
    console.log = (...a) => {
      capture(...a);
      origLog(...a);
    };
    console.warn = (...a) => {
      capture(...a);
      origWarn(...a);
    };
    console.error = (...a) => {
      capture(...a);
      origError(...a);
    };

    // Symlink node_modules into tmpDir so the production server can resolve
    // externalized packages (react, react-dom, etc.) at runtime. Node.js ESM
    // walks parent directories, so placing the symlink in tmpDir (the ancestor
    // of server/ and server/ssr/) is sufficient.
    // The fixture dir itself may not have node_modules — walk up to find it.
    let nodeModulesSource: string | null = null;
    for (let dir = opts.files; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules");
      if (fs.existsSync(candidate)) {
        nodeModulesSource = candidate;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break; // reached root
    }
    if (nodeModulesSource) {
      await fs.promises.symlink(nodeModulesSource, path.join(tmpDir, "node_modules"));
    }

    // Build:
    //   rscOutDir / ssrOutDir / clientOutDir are all absolute → go into tmpDir subdirs
    const builder = await createBuilder({
      root: opts.files,
      configFile: false,
      plugins: [
        {
          name: "vinext-e2e:js-as-jsx",
          enforce: "pre" as const,
          async transform(code: string, id: string) {
            if (!id.endsWith(".js") || id.includes("node_modules")) return;
            // oxlint-disable-next-line typescript/no-explicit-any
            return transformWithOxc(code, id, { lang: "jsx" } as any);
          },
        },
        {
          // @vitejs/plugin-rsc hardcodes "index.js" in inter-env import paths.
          // Rolldown defaults to .mjs when the fixture has no package.json with
          // "type": "module". Force .js extension on rsc/ssr entry files so
          // the generated import("./ssr/index.js") resolves correctly at runtime.
          name: "vinext-e2e:force-js-entry-names",
          apply: "build" as const,
          enforce: "post" as const,
          config(config: Record<string, unknown>) {
            const envs = (config as Record<string, unknown>).environments as
              | Record<string, Record<string, unknown>>
              | undefined;
            if (!envs) return;
            const patch: Record<string, Record<string, unknown>> = {};
            for (const envName of ["rsc", "ssr"]) {
              if (!envs[envName]) continue;
              patch[envName] = {
                build: {
                  rolldownOptions: { output: { entryFileNames: "[name].js" } },
                },
              };
            }
            return { environments: patch };
          },
        },
        vinext({
          appDir: opts.files,
          rscOutDir: path.join(tmpDir, "server"),
          ssrOutDir: path.join(tmpDir, "server", "ssr"),
          clientOutDir: path.join(tmpDir, "client"),
        }),
      ],
      resolve: {
        dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
      },
      build: { outDir: tmpDir },
      logLevel: "warn",
    });
    await builder.buildApp();

    // Run prerender phase so ISR/force-static routes are seeded into the
    // memory cache at server startup (via seedMemoryCacheFromPrerender).
    // Output goes to tmpDir/server/prerendered-routes/ and the manifest to
    // tmpDir/server/vinext-prerender.json — exactly where the prod server
    // expects them.
    // Debug: show vinext-server.json contents to verify buildId is present
    const serverManifestPath = path.join(tmpDir, "server", "vinext-server.json");
    if (fs.existsSync(serverManifestPath)) {
      const serverManifest = JSON.parse(fs.readFileSync(serverManifestPath, "utf-8"));
      const { buildId } = serverManifest;
      origLog("[vinext-e2e] vinext-server.json:", JSON.stringify({ ...serverManifest, prerenderSecret: "<redacted>" }));
      // Check if the RSC bundle contains the buildId
      const rscBundlePath = path.join(tmpDir, "server", "index.js");
      if (fs.existsSync(rscBundlePath) && buildId) {
        const bundleHead = fs.readFileSync(rscBundlePath, "utf-8").slice(0, 50000);
        const hasBuildId = bundleHead.includes(buildId);
        origLog("[vinext-e2e] RSC bundle contains buildId:", hasBuildId, "(looked for:", buildId, ")");
      }
    } else {
      origWarn("[vinext-e2e] vinext-server.json NOT FOUND at", serverManifestPath);
    }

    // Install the external-API mock BEFORE the prerender phase so that both
    // prerender renders and test-time requests use mocked responses.
    // The prod server and prerender run in the same process, so the mock is
    // shared via globalThis[Symbol.for(...)].
    const _OVERRIDE_KEY = Symbol.for("vinext.fetchCache.override");
    const _rawFetch = ((globalThis as Record<PropertyKey, unknown>)[Symbol.for("vinext.fetchCache.originalFetch")] as typeof fetch | undefined) ?? fetch;
    (globalThis as Record<PropertyKey, unknown>)[_OVERRIDE_KEY] = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (
        url.startsWith("https://next-data-api-endpoint.vercel.app/api/random") &&
        !url.includes("status=")
      ) {
        const resp = new Response(Math.random().toString(), {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
        // Response.url is read-only; set it via defineProperty so tests that
        // read res.url (e.g. the /response-url route) get the correct value.
        Object.defineProperty(resp, "url", { get: () => url, configurable: true });
        return resp;
      }
      return _rawFetch(input as RequestInfo, init);
    };

    try {
      const { runPrerender } = await import(
        path.resolve(import.meta.dirname, "../../../packages/vinext/dist/build/run-prerender.js")
      );
      await runPrerender({
        root: opts.files,
        rscBundlePath: path.join(tmpDir, "server", "index.js"),
        outDir: path.join(tmpDir, "server", "prerendered-routes"),
        manifestDir: path.join(tmpDir, "server"),
      });
    } catch (prerenderErr) {
      // Prerender failures are non-fatal for test infrastructure — the prod
      // server will still start and serve dynamic responses.
      origWarn("[vinext-e2e] prerender phase failed (non-fatal):", prerenderErr);
    }

    // Create the .next/server/app symlink so tests that read build artifacts
    // via next.testDir + '.next/server/app' can find prerendered files.
    // vinext writes to tmpDir/server/prerendered-routes/; the symlink maps
    // the Next.js-standard path onto our actual output location.
    const dotNextServerApp = path.join(tmpDir, ".next", "server", "app");
    await fs.promises.mkdir(path.dirname(dotNextServerApp), { recursive: true });
    const prerenderRoutesDir = path.join(tmpDir, "server", "prerendered-routes");
    await fs.promises.mkdir(prerenderRoutesDir, { recursive: true });
    await fs.promises.symlink(prerenderRoutesDir, dotNextServerApp).catch(() => {
      // Ignore if symlink already exists
    });

    // Restore console (build phase is done)
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;

    // Start prod server
    const { startProdServer } = await import(
      path.resolve(import.meta.dirname, "../../../packages/vinext/dist/server/prod-server.js")
    );
    const { server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: tmpDir,
    });
    _httpServer = server;

    // Re-install console capture for server runtime logs so next.cliOutput
    // accumulates them (tests that check cliOutput rely on server-side output).
    console.log = (...a) => {
      _buildOutput += a.map(String).join(" ") + "\n";
      origLog(...a);
    };
    console.warn = (...a) => {
      _buildOutput += a.map(String).join(" ") + "\n";
      origWarn(...a);
    };
    console.error = (...a) => {
      _buildOutput += a.map(String).join(" ") + "\n";
      origError(...a);
    };

    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 3000;
    const baseUrl = `http://127.0.0.1:${port}`;

    async function doStop() {
      // Restore console before teardown
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("vinext.fetchCache.override")];
      await new Promise<void>((resolve) => _httpServer?.close(() => resolve()) ?? resolve());
      _httpServer = null;
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }

    const next = makeNextInstance(opts, async () => {}, doStop, () => baseUrl, () => _buildOutput, tmpDir);

    // Provide stub Next.js manifest files so isNextStart-gated beforeAll blocks
    // don't throw when reading files that only exist in a real `next build`.
    const origReadFile = next.readFile.bind(next);
    next.readFile = async (filePath: string) => {
      if (filePath === ".next/prerender-manifest.json") {
        return JSON.stringify({
          version: 4,
          routes: {},
          dynamicRoutes: {},
          notFoundRoutes: [],
          preview: { previewModeId: "", previewModeSigningKey: "", previewModeEncryptionKey: "" },
        });
      }
      return origReadFile(filePath);
    };

    return next;
  } catch (err) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function createNextDevServer(opts: NextTestSetupOptions): Promise<NextInstance> {
  let _server: ViteDevServer | null = null;
  let _baseUrl = "";
  let _cliOutput = "";

  const viteConfig = buildViteConfig(opts.files, (msg) => {
    _cliOutput += msg + "\n";
  });

  async function _doStart() {
    if (_server) return;
    _server = await createServer(viteConfig);

    // Capture console.warn / console.error from server-side module execution
    // into cliOutput so tests can assert on warning messages.
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);
    console.warn = (...args: unknown[]) => {
      const msg = args.map(String).join(" ");
      _cliOutput += msg + "\n";
      origWarn(...args);
    };
    console.error = (...args: unknown[]) => {
      const msg = args.map(String).join(" ");
      _cliOutput += msg + "\n";
      origError(...args);
    };
    const origLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      const msg = args.map(String).join(" ");
      _cliOutput += msg + "\n";
      origLog(...args);
    };

    await _server.listen();
    const addr = _server.httpServer?.address() as AddressInfo | null;
    _baseUrl = addr ? `http://localhost:${addr.port}` : "";
    // Some fixture pages construct self-referential fetch URLs using
    // process.env.PORT (e.g. force-cache/large-data). Set it to the actual
    // bound port so those pages can reach the local API routes.
    if (addr?.port) process.env.PORT = String(addr.port);
    // Warm up: trigger Vite's first-request compilation so individual tests
    // don't time out waiting for the initial RSC/SSR bundle to build.
    await fetch(_baseUrl + "/").catch(() => {});

    // Mock external API calls to eliminate network latency from tests.
    // The vinext server runs in the same process, so globalThis[Symbol.for(...)]
    // is shared between test code and the RSC environment.
    const _OVERRIDE_KEY = Symbol.for("vinext.fetchCache.override");
    const _rawFetch = ((globalThis as Record<PropertyKey, unknown>)[Symbol.for("vinext.fetchCache.originalFetch")] as typeof fetch | undefined) ?? fetch;
    (globalThis as Record<PropertyKey, unknown>)[_OVERRIDE_KEY] = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      // Mock api/random* calls — but NOT ?status=N variants (those test specific HTTP status codes).
      if (
        url.startsWith("https://next-data-api-endpoint.vercel.app/api/random") &&
        !url.includes("status=")
      ) {
        const resp = new Response(Math.random().toString(), {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
        Object.defineProperty(resp, "url", { get: () => url, configurable: true });
        return resp;
      }
      return _rawFetch(input as RequestInfo, init);
    };
  }

  async function _doStop() {
    delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("vinext.fetchCache.override")];
    delete process.env.PORT;
    await _server?.close();
    _server = null;
    _baseUrl = "";
  }

  const next = makeNextInstance(
    opts,
    _doStart,
    _doStop,
    () => _baseUrl,
    () => _cliOutput,
  );

  if (!opts.skipStart) {
    await _doStart();
  }

  return next;
}

export const isNextDev = nextTestMode === "dev";
export const isNextStart = nextTestMode === "start";
export const isNextDeploy = nextTestMode === "deploy";

// ─── Global flags ────────────────────────────────────────────────────────────
//
// Some ported Next.js tests check `(global as any).isNextDev` to gate
// production-only assertions. Set the global flags so those guards work.
(globalThis as Record<string, unknown>).isNextDev = isNextDev;
(globalThis as Record<string, unknown>).isNextStart = isNextStart;
(globalThis as Record<string, unknown>).isNextDeploy = isNextDeploy;
