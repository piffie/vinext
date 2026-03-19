import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("Document", () => {
  test("page includes theme attribute on the body", async ({ page }) => {
    await page.goto(`${BASE}/`);

    await expect(page.getAttribute("body", "data-theme-prop")).resolves.toBe("light");
  });
});
