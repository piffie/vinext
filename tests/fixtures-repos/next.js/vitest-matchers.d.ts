import "vitest";

declare module "vitest" {
  type Assertion<T = unknown> = {
    toEndWith(suffix: string): void;
    toStartWith(prefix: string): void;
    toInclude(substring: string): void;
    /**
     * Inline snapshot matcher for a Redbox that's popped up by default.
     * When a Redbox is hidden at first and requires manual display by clicking
     * the toast, use {@link toDisplayCollapsedRedbox} instead.
     *
     * Waits for the Next.js error overlay ("Redbox") to appear in the page,
     * reads its structured content (label, description, source, stack, etc.)
     * and compares it against an inline snapshot.
     *
     * @param inlineSnapshot - The expected snapshot string. Omit to
     *   auto-generate on first run.
     *
     * @example
     * await expect(browser).toDisplayRedbox(`
     *   {
     *     "code": "E394",
     *     "description": "...",
     *     "environmentLabel": null,
     *     "label": "Runtime Error",
     *     "source": "app/page.tsx (10:1) @ Foo\\n> 10 | ...",
     *     "stack": [
     *       "Foo app/page.tsx (10:1)",
     *     ],
     *   }
     * `)
     */
    toDisplayRedbox(inlineSnapshot?: string): Promise<void>;
    /**
     * Inline snapshot matcher for a Redbox that's collapsed by default.
     * When a Redbox is immediately displayed,
     * use {@link toDisplayRedbox} instead.
     *
     * Clicks the dev-tools / error toast to open the full Redbox dialog,
     * then reads its structured content and compares it against an inline
     * snapshot.
     *
     * @param inlineSnapshot - The expected snapshot string. Omit to
     *   auto-generate on first run.
     */
    toDisplayCollapsedRedbox(inlineSnapshot?: string): Promise<void>;
  };
}
