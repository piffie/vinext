import { Suspense } from "react";
import { FilterToggle } from "./FilterToggle";

async function ItemList({ filter }: { filter: string }) {
  // Artificial delay: long enough for Playwright to catch intermediate state.
  await new Promise((r) => setTimeout(r, 400));
  const items = filter
    ? [{ id: 1, text: `Filtered: ${filter}` }]
    : [
        { id: 1, text: "Item A" },
        { id: 2, text: "Item B" },
        { id: 3, text: "Item C" },
      ];
  return (
    <ul id="item-list">
      {items.map((i) => (
        <li key={i.id}>{i.text}</li>
      ))}
    </ul>
  );
}

export default async function SuspenseNavTestPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter = "" } = await searchParams;

  return (
    <div>
      {/* Heading is OUTSIDE the Suspense boundary.
          With flushSync, it updates before the list is ready — partial flash.
          With startTransition (NavigationRoot), it only updates once the list
          is also ready — both change together (issue #639). */}
      <h1 id="page-heading">{filter ? `Filtered: ${filter}` : "All Items"}</h1>
      <FilterToggle current={filter} />
      <Suspense fallback={<div id="list-loading">Loading items...</div>}>
        <ItemList filter={filter} />
      </Suspense>
    </div>
  );
}
