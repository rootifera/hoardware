"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { EMPTY_FILTERS, SORTS, type ItemFilters, type Sort } from "@/lib/types";

/** Filters live in the URL so searches are shareable and survive reloads / back. */
export function useItemFilters() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const serialized = params.toString();

  const filters = useMemo<ItemFilters>(() => {
    const p = new URLSearchParams(serialized);
    const sort = p.get("sort") as Sort | null;
    const order = p.get("order");
    return {
      q: p.get("q") ?? "",
      category: p.get("category") ?? "",
      manufacturer: p.get("manufacturer") ?? "",
      condition: p.get("condition") ?? "",
      test: p.get("test") ?? "",
      confidence: p.get("confidence") ?? "",
      location: p.get("location") ?? "",
      exact: p.get("exact") === "1",
      unassigned: p.get("unassigned") === "1",
      lowStock: p.get("low_stock") === "1",
      verified: p.get("verified") ?? "",
      sort: sort && (SORTS as readonly string[]).includes(sort) ? sort : "newest",
      order: order === "asc" || order === "desc" ? order : "",
    };
  }, [serialized]);

  const setFilters = useCallback(
    (patch: Partial<ItemFilters>, opts?: { replace?: boolean }) => {
      const next = { ...filters, ...patch };
      const p = new URLSearchParams(new URLSearchParams(serialized));
      const set = (key: string, value: string) => (value ? p.set(key, value) : p.delete(key));
      set("q", next.q);
      set("category", next.category);
      set("manufacturer", next.manufacturer);
      set("condition", next.condition);
      set("test", next.test);
      set("confidence", next.confidence);
      set("location", next.location);
      set("exact", next.exact ? "1" : "");
      set("unassigned", next.unassigned ? "1" : "");
      set("low_stock", next.lowStock ? "1" : "");
      set("verified", next.verified);
      set("sort", next.sort === EMPTY_FILTERS.sort ? "" : next.sort);
      set("order", next.order);
      const qs = p.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (opts?.replace) router.replace(url, { scroll: false });
      else router.push(url, { scroll: false });
    },
    [filters, serialized, pathname, router],
  );

  return { filters, setFilters };
}
