"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FilterBar } from "@/components/filter-bar";
import { ItemList } from "@/components/item-list";
import { useItemFilters } from "@/hooks/use-item-filters";
import { EMPTY_FILTERS } from "@/lib/types";

function Inventory() {
  const { filters, setFilters } = useItemFilters();
  const focus = useSearchParams().get("focus") === "1";
  return (
    <div className="space-y-5">
      <FilterBar filters={filters} setFilters={setFilters} autoFocusSearch={focus} />
      <ItemList filters={filters} onClear={() => setFilters({ ...EMPTY_FILTERS, sort: filters.sort, order: filters.order })} />
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense>
      <Inventory />
    </Suspense>
  );
}
