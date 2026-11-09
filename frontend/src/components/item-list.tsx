"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Cpu, ImageOff, MapPin, PackageOpen, SearchX } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BulkBar, EMPTY_SELECTION, toBulkSelection, type Selection } from "@/components/bulk";
import { ConditionBadge, ConfidenceBadge, TestStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuickAdd } from "@/components/quick-add";
import { api } from "@/lib/api";
import { coreLabel, coreShown, valueLabel } from "@/lib/category-config";
import { cn } from "@/lib/utils";
import { EMPTY_FILTERS, type Category, type ItemFilters, type ItemSummary } from "@/lib/types";

const ROW_HEIGHT = 76;
const PAGE_SIZE = 50;

export function hasActiveFilters(f: ItemFilters): boolean {
  return Boolean(
    f.q.trim() || f.category || f.manufacturer || f.condition || f.test || f.confidence || f.location || f.unassigned || f.verified,
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

/** The quantity of a stock item next to its name, with a warning when it is low or gone. */
function StockTag({ item }: { item: ItemSummary }) {
  const out = item.quantity === 0;
  const low = !out && item.low_stock_level !== null && item.quantity <= item.low_stock_level;
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="rounded bg-muted px-1.5 font-mono text-xs" title="In stock">
        ×{item.quantity.toLocaleString()}
      </span>
      {(out || low) && (
        <span className={cn("rounded px-1.5 text-xs font-medium", out ? "bg-red-500/15 text-red-800 dark:text-red-300" : "bg-amber-500/15 text-amber-900 dark:text-amber-300")}>
          {out ? "Out" : "Low"}
        </span>
      )}
    </span>
  );
}

function ItemRow({
  item,
  category,
  selected,
  onToggle,
}: {
  item: ItemSummary;
  category: Category | undefined;
  selected: boolean;
  onToggle: (shift: boolean) => void;
}) {
  const name = [item.manufacturer, item.model].filter(Boolean).join(" ");
  return (
    <div className={cn("flex h-full items-center rounded-lg transition-colors", selected ? "bg-primary/5" : "hover:bg-muted/60")}>
      <label className="flex h-full shrink-0 cursor-pointer items-center px-2.5">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          aria-label={`Select ${item.inventory_code}`}
          checked={selected}
          onChange={() => {}}
          onClick={(e) => onToggle(e.shiftKey)}
        />
      </label>
    <Link
      href={`/items/${item.id}`}
      className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-lg pr-2 focus-visible:bg-muted/60 focus-visible:outline-none"
    >
      <Thumb item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-muted-foreground">{item.inventory_code}</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">{item.category_name}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium">{name}</span>
          {item.is_stock && <StockTag item={item} />}
        </div>
        <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          {item.spec_line && <span className="truncate font-medium text-foreground/80">{item.spec_line}</span>}
          {item.part_number && coreShown(category, "part_number") && (
            <span className="truncate">
              {coreLabel(category, "part_number", "P/N")} {item.part_number}
            </span>
          )}
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
        {item.order !== null && <span className="shrink-0 rounded bg-muted px-1.5 font-mono text-xs text-foreground">#{item.order}</span>}
      </div>
      {/* Fixed width so the location column lines up from row to row. */}
      <div className="flex shrink-0 flex-col items-end gap-1 sm:w-40 sm:flex-row sm:items-center sm:justify-end lg:w-72">
        {coreShown(category, "confidence") && <ConfidenceBadge confidence={item.identification_confidence} />}
        {coreShown(category, "condition") && (
          <ConditionBadge condition={item.condition} label={valueLabel(category, "condition", item.condition)} className="hidden lg:inline-flex" />
        )}
        {coreShown(category, "test_status") && (
          <TestStatusBadge status={item.test_status} label={valueLabel(category, "test_status", item.test_status)} />
        )}
      </div>
    </Link>
    </div>
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
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories, staleTime: 60_000 });
  const categoryById = new Map((categories.data ?? []).map((c) => [c.id, c]));
  const count = useQuery({
    queryKey: ["items", "count", { ...filters, sort: "newest", order: "" }],
    queryFn: () => api.itemCount(filters),
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  // Selection belongs to the current filters; changing them starts afresh.
  const filterKey = JSON.stringify(filters);
  const [selState, setSelState] = useState<{ key: string; sel: Selection }>({ key: filterKey, sel: EMPTY_SELECTION });
  const sel = selState.key === filterKey ? selState.sel : EMPTY_SELECTION;
  const setSel = (next: Selection) => setSelState({ key: filterKey, sel: next });
  const lastClicked = useRef<number | null>(null);
  const total = count.data ?? 0;
  const isSelected = (id: number) => (sel.mode === "ids" ? sel.ids.has(id) : !sel.excluded.has(id));
  const selectedCount = sel.mode === "ids" ? sel.ids.size : Math.max(0, total - sel.excluded.size);

  function setMany(ids: number[], selected: boolean) {
    if (sel.mode === "ids") {
      const next = new Set(sel.ids);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      setSel({ mode: "ids", ids: next });
    } else {
      const next = new Set(sel.excluded);
      for (const id of ids) {
        if (selected) next.delete(id);
        else next.add(id);
      }
      setSel({ mode: "all", excluded: next });
    }
  }
  function toggle(index: number, shift: boolean) {
    const target = !isSelected(items[index].id);
    // Shift-click selects (or clears) the whole range since the last click.
    const from = shift && lastClicked.current !== null ? Math.min(lastClicked.current, index) : index;
    const to = shift && lastClicked.current !== null ? Math.max(lastClicked.current, index) : index;
    setMany(items.slice(from, to + 1).map((i) => i.id), target);
    lastClicked.current = index;
  }
  const allLoadedSelected = items.length > 0 && items.every((i) => isSelected(i.id));
  // Distance from the top of the page to the list, so the window virtualizer
  // knows where the rows start.
  const [scrollMargin, setScrollMargin] = useState(0);
  const listNode = useRef<HTMLDivElement | null>(null);
  const listRef = useCallback((node: HTMLDivElement | null) => {
    listNode.current = node;
    if (node) setScrollMargin(node.offsetTop);
  }, []);
  // The bulk bar appears above the list when rows are ticked, which moves the list down.
  const barShown = selectedCount > 0;
  useLayoutEffect(() => {
    if (listNode.current) setScrollMargin(listNode.current.offsetTop);
  }, [barShown]);

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
          <p className="font-medium">{filtered ? "Nothing matches these filters" : "No items yet"}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {filtered
              ? "Try a shorter search or clear a filter."
              : "Add your first item. Only a category and a description are required."}
          </p>
        </div>
        {filtered ? (
          onClear && (
            <Button variant="outline" onClick={onClear}>
              Clear filters
            </Button>
          )
        ) : (
          <Button onClick={() => openQuickAdd()}>Add the first item</Button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 text-sm text-muted-foreground">
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            aria-label="Select all loaded items"
            checked={allLoadedSelected}
            onChange={() => setMany(items.map((i) => i.id), !allLoadedSelected)}
          />
          <span aria-live="polite">{count.data != null ? `${count.data.toLocaleString()} item${count.data === 1 ? "" : "s"}` : " "}</span>
        </label>
        {sel.mode === "ids" && allLoadedSelected && total > items.length && (
          <span>
            {items.length} loaded items selected.{" "}
            <button type="button" className="font-medium text-foreground underline" onClick={() => setSel({ mode: "all", excluded: new Set() })}>
              Select all {total.toLocaleString()} matching
            </button>
          </span>
        )}
        {sel.mode === "all" && (
          <span>
            All {selectedCount.toLocaleString()} matching items selected.{" "}
            <button type="button" className="font-medium text-foreground underline" onClick={() => setSel(EMPTY_SELECTION)}>
              Clear selection
            </button>
          </span>
        )}
      </div>
      {selectedCount > 0 && (
        <BulkBar count={selectedCount} selection={toBulkSelection(sel, filters)} onClear={() => setSel(EMPTY_SELECTION)} />
      )}
      <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((row) => {
          const item = items[row.index];
          return (
            <div
              key={item.id}
              className="absolute inset-x-0 top-0 border-b border-border/60"
              style={{ height: row.size, transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
            >
              <ItemRow item={item} category={categoryById.get(item.category_id)} selected={isSelected(item.id)} onToggle={(shift) => toggle(row.index, shift)} />
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
