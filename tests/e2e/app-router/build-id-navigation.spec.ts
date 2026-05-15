import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const VISITED_CACHE_MARKER = "__VINEXT_VISITED_CACHE_MARKER__";

async function pushAppRoute(page: Page, pathname: string): Promise<void> {
  await page.evaluate((target) => {
    const router = window.next?.router;
    if (!router) {
      throw new Error("window.next.router is not installed");
    }
    router.push(target);
  }, pathname);
}

test.describe("App Router RSC compatibility navigation", () => {
  test("replays same-build visited RSC payloads instead of refetching or reloading", async ({
    page,
  }) => {
    const aboutRscRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/about.rsc" && url.searchParams.has("_rsc")) {
        aboutRscRequests.push(request.url());
      }
    });

    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);

    await pushAppRoute(page, "/about");
    await expect(page.locator("h1")).toHaveText("About");
    expect(aboutRscRequests).toHaveLength(1);

    await page.evaluate((marker) => {
      Reflect.set(window, marker, true);
      const router = window.next?.router;
      if (!router) {
        throw new Error("window.next.router is not installed");
      }
      router.push("/");
    }, VISITED_CACHE_MARKER);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");

    await pushAppRoute(page, "/about");
    await expect(page.locator("h1")).toHaveText("About");

    await expect(
      page.evaluate((marker) => Reflect.get(window, marker), VISITED_CACHE_MARKER),
    ).resolves.toBe(true);
    expect(aboutRscRequests).toHaveLength(1);
  });
});
