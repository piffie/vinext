import { describe, it, expect } from "vite-plus/test";
import { getRootParam, runWithRootParamsScope } from "../packages/vinext/src/shims/root-params.js";
import {
  runWithRequestContext,
  createRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import { runWithNavigationContext } from "../packages/vinext/src/shims/navigation-state.js";
import {
  getNavigationContext,
  setNavigationContext,
} from "../packages/vinext/src/shims/navigation.js";

describe("next/root-params shim", () => {
  it("resolves to undefined when called outside of root params scope", async () => {
    const val = await getRootParam("lang");
    expect(val).toBeUndefined();
  });

  it("resolves to the correct param within runWithRootParamsScope", async () => {
    const result = await runWithRootParamsScope({ lang: "en", locale: "en-US" }, async () => {
      const langVal = await getRootParam("lang");
      const localeVal = await getRootParam("locale");
      const missingVal = await getRootParam("missing");
      return { langVal, localeVal, missingVal };
    });

    expect(result).toEqual({
      langVal: "en",
      localeVal: "en-US",
      missingVal: undefined,
    });
  });

  it("supports nested scopes overriding outer scopes", async () => {
    const result = await runWithRootParamsScope({ lang: "en" }, async () => {
      const outer = await getRootParam("lang");
      const inner = await runWithRootParamsScope({ lang: "es" }, async () => getRootParam("lang"));
      const outerAfter = await getRootParam("lang");
      return { outer, inner, outerAfter };
    });

    expect(result).toEqual({
      outer: "en",
      inner: "es",
      outerAfter: "en",
    });
  });

  it("integrates correctly with unified request context", async () => {
    const ctx = createRequestContext({ rootParams: { lang: "fr" } });
    const result = await runWithRequestContext(ctx, async () => {
      const langVal = await getRootParam("lang");

      // Nested overriding scope inside unified context
      const nestedVal = await runWithRootParamsScope({ lang: "de" }, async () =>
        getRootParam("lang"),
      );

      const langValAfter = await getRootParam("lang");

      return { langVal, nestedVal, langValAfter };
    });

    expect(result).toEqual({
      langVal: "fr",
      nestedVal: "de",
      langValAfter: "fr",
    });
  });

  it("proves sibling standalone state survives runWithRootParamsScope", async () => {
    await runWithNavigationContext(async () => {
      setNavigationContext({
        pathname: "/blog/en",
        searchParams: new URLSearchParams(),
        params: { lang: "en" },
      });

      await runWithRootParamsScope({ lang: "en" }, async () => {
        expect(getNavigationContext()?.pathname).toBe("/blog/en");
        await expect(getRootParam("lang")).resolves.toBe("en");
      });
    });
  });
});
