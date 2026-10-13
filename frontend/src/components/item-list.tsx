"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Cpu, ImageOff, MapPin, PackageOpen, SearchX } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ConditionBadge, ConfidenceBadge, TestStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuickAdd } from "@/components/quick-add";
import { api } from "@/lib/api";
import { EMPTY_FILTERS, type ItemFilters, type ItemSummary } from "@/lib/types";

const ROW_HEIGHT = 76;
const PAGE_SIZE = 50;

export function hasActiveFilters(f: ItemFilters): boolean {
  return Boolean(
    f.q.trim() || f.category || f.manufacturer || f.condition || f.test || f.confidence || f.location || f.unassigned,
  );
}

function Thumb({ item }: { item: ItemSummary }) {
  const [broken, setBroken] = useState(false);
  if (!item.thumbnail_url || broken) {
    return (
      <div className="flex size-14 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {item.thumbnail_url ? <ImageOff className="size-5" /> : <Cpu className="size-5 opacity-60" />}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- thumbnails are pre-sized by the backend
    <img
      src={item.thumbnail_url}
      alt=""
      loading="lazy"
      className="size-14 shrink-0 rounded-md bg-muted object-cover"
      onError={() => setBroken(true)}
    />
  );
}

function ItemRow({ item }: { item: ItemSummary }) {
  const name = [item.manufacturer, item.model].filter(Boolean).join(" ");
  return (
    <Link
      href={`/items/${item.id}`}
      className="flex h-full items-center gap-3 rounded-lg px-2 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
    >
      <Thumb item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-muted-foreground">{item.inventory_code}</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">{item.category_name}</span>
        </div>
        <div className="truncate font-medium">{name}</div>
        <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          {item.part_number && <span className="truncate">P/N {item.part_number}</span>}
          {item.chipset && <span className="truncate">{item.chipset}</span>}
          <span className="flex min-w-0 items-center gap-1 truncate sm:hidden">
            <MapPin className="size-3 shrink-0" />
            {item.location_path ?? "No location"}
            {item.order !== null && ` · #${item.order}`}
          </span>
        </div>
      </div>
      <div className="hidden w-72 min-w-0 shrink-0 items-center gap-1 text-sm text-muted-foreground md:flex">
        <MapPin className="size-3.5 shrink-0" />
        <span className="truncate" title={item.location_path ?? undefined}>
          {item.location_path ?? <span className="italic">No location</span>}
        </span>
        {item.order !== null && <span className="shrink-0 rounded bg-muted px-1.5 font-mono text-xs">#{item.order}</span>}
      </div>
      {/* Fixed width so the location column lines up from row to row. */}
      <div className="flex shrink-0 flex-col items-end gap-1 sm:w-40 sm:flex-row sm:items-center sm:justify-end lg:w-72">
        <ConfidenceBadge confidence={item.identification_confidence} />
        <ConditionBadge condition={item.condition} className="hidden lg:inline-flex" />
        <TestStatusBadge status={item.test_status} />
      </div>
    </Link>
  );
}

export function ItemList({ filters, onClear }: { filters: ItemFilters; onClear?: () => void }) {
  const { open: openQuickAdd } = useQuickAdd();
  const query = useInfiniteQuery({
    queryKey: ["items", filters],
    queryFn: ({ pageParam }) => api.items(filters, pageParam, PAGE_SIZE),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
  const count = useQuery({
    queryKey: ["items", "count", { ...filters, sort: "newest", order: "" }],
    queryFn: () => api.itemCount(filters),
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  // Distance from the top of the page to the list, so the window virtualizer
  // knows where the rows start.
  const [scrollMargin, setScrollMargin] = useState(0);
  const listRef = useCallback((node: HTMLDivElement | null) => {
    if (node) setScrollMargin(node.offsetTop);
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    scrollMargin,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.at(-1)?.index ?? -1;

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (lastIndex >= items.length - 15 && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [lastIndex, items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (query.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-[68px] w-full" />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
        <p className="font-medium text-destructive">Could not load items</p>
        <p className="mt-1 text-sm text-muted-foreground">{query.error.message}</p>
        <Button className="mt-4" variant="outline" onClick={() => query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    const filtered = hasActiveFilters(filters);
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
        {filtered ? <SearchX className="size-10 text-muted-foreground" /> : <PackageOpen className="size-10 text-muted-foreground" />}
        <div>
          <p className="font-medium">{filtered ? "Nothing matches these filters" : "No hardware yet"}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {filtered
              ? "Try a shorter search or clear a filter."
              : "Add your first part. Only a category and a description are required."}
          </p>
        </div>
        {filtered ? (
          onClear && (
            <Button variant="outline" onClick={onClear}>
              Clear filters
            </Button>
          )
        ) : (
          <Button onClick={() => openQuickAdd()}>Add the first part</Button>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="mb-2 text-sm text-muted-foreground" aria-live="polite">
        {count.data != null ? `${count.data.toLocaleString()} item${count.data === 1 ? "" : "s"}` : " "}
      </p>
      <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((row) => {
          const item = items[row.index];
          return (
            <div
              key={item.id}
              className="absolute inset-x-0 top-0 border-b border-border/60"
              style={{ height: row.size, transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
            >
              <ItemRow item={item} />
            </div>
          );
        })}
      </div>
      <p className="py-4 text-center text-sm text-muted-foreground">
        {isFetchingNextPage ? "Loading more…" : hasNextPage ? "" : `End of list`}
      </p>
    </div>
  );
}

export { EMPTY_FILTERS };
