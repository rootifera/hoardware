"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Download, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LocationPicker } from "@/components/location-picker";
import { SimpleSelect } from "@/components/simple-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import { CONDITIONS, CONFIDENCES, EMPTY_FILTERS, TEST_STATUSES, type ItemFilters, type Sort } from "@/lib/types";

const SORT_LABELS: Record<Sort, string> = {
  newest: "Latest added",
  name: "Name",
  category: "Category",
  location: "Location",
};

/** A text field whose (debounced) value is pushed to the URL, while URL changes
 *  made elsewhere (e.g. "Clear") flow back into the field. */
function useUrlText(urlValue: string, commit: (value: string) => void) {
  const [text, setText] = useState(urlValue);
  const lastPushed = useRef(urlValue);
  const debounced = useDebouncedValue(text, 200);

  useEffect(() => {
    if (urlValue !== lastPushed.current) {
      lastPushed.current = urlValue;
      setText(urlValue);
    }
  }, [urlValue]);

  useEffect(() => {
    if (debounced !== lastPushed.current) {
      lastPushed.current = debounced;
      commit(debounced);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commit identity changes with every filter change
  }, [debounced]);

  return [text, setText] as const;
}

export function FilterBar({
  filters,
  setFilters,
  autoFocusSearch,
  showLocation = true,
}: {
  filters: ItemFilters;
  setFilters: (patch: Partial<ItemFilters>, opts?: { replace?: boolean }) => void;
  autoFocusSearch?: boolean;
  showLocation?: boolean;
}) {
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories, staleTime: 60_000 });
  const [q, setQ] = useUrlText(filters.q, (value) => setFilters({ q: value }, { replace: true }));
  const [manufacturer, setManufacturer] = useUrlText(filters.manufacturer, (value) =>
    setFilters({ manufacturer: value }, { replace: true }),
  );
  const suggestions = useQuery({
    queryKey: ["manufacturers", manufacturer],
    queryFn: () => api.manufacturers(manufacturer),
    staleTime: 60_000,
  });

  const locationQuery = useQuery({
    queryKey: ["location", Number(filters.location)],
    queryFn: () => api.location(Number(filters.location)),
    enabled: Boolean(filters.location) && !filters.unassigned,
  });
  const pickedLocation = locationQuery.data
    ? { id: locationQuery.data.id, full_name: locationQuery.data.full_name }
    : filters.location
      ? { id: Number(filters.location), full_name: "…" }
      : null;

  const dirty =
    filters.q || filters.category || filters.manufacturer || filters.condition || filters.test || filters.confidence ||
    filters.location || filters.unassigned;
  const descending = filters.order ? filters.order === "desc" : filters.sort === "newest";

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="search-input"
          type="search"
          autoFocus={autoFocusSearch}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search code, manufacturer, model, part number, chipset, notes…   ( / )"
          className="h-11 pr-9 pl-9 text-base"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button
            type="button"
            aria-label="Clear search"
            className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setQ("");
              document.getElementById("search-input")?.focus();
            }}
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SimpleSelect
          aria-label="Category"
          className="w-40"
          value={filters.category}
          onChange={(category) => setFilters({ category })}
          anyLabel="All categories"
          options={(categories.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
        />
        <SimpleSelect
          aria-label="Test status"
          className="w-40"
          value={filters.test}
          onChange={(test) => setFilters({ test })}
          anyLabel="Any test status"
          options={TEST_STATUSES.map((s) => ({ value: s, label: s }))}
        />
        <SimpleSelect
          aria-label="Condition"
          className="w-40"
          value={filters.condition}
          onChange={(condition) => setFilters({ condition })}
          anyLabel="Any condition"
          options={CONDITIONS.map((c) => ({ value: c, label: c }))}
        />
        <SimpleSelect
          aria-label="Identification"
          className="w-44"
          value={filters.confidence}
          onChange={(confidence) => setFilters({ confidence })}
          anyLabel="Any identification"
          options={CONFIDENCES.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }))}
        />
        <Input
          aria-label="Manufacturer"
          list="manufacturer-suggestions"
          placeholder="Manufacturer"
          className="w-40"
          value={manufacturer}
          onChange={(e) => setManufacturer(e.target.value)}
        />
        <datalist id="manufacturer-suggestions">
          {(suggestions.data ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {showLocation && (
          <>
            <LocationPicker
              className="w-72"
              placeholder="Any location"
              value={filters.unassigned ? null : pickedLocation}
              onChange={(l) => setFilters({ location: l ? String(l.id) : "", unassigned: false })}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={!filters.exact}
                disabled={!filters.location || filters.unassigned}
                onChange={(e) => setFilters({ exact: !e.target.checked })}
              />
              Include sub-locations
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={filters.unassigned}
                onChange={(e) => setFilters({ unassigned: e.target.checked, location: "" })}
              />
              Unassigned only
            </label>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <SimpleSelect
            aria-label="Sort by"
            className="w-36"
            value={filters.sort}
            onChange={(sort) => setFilters({ sort: sort as Sort, order: "" })}
            options={Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label={descending ? "Sorted descending" : "Sorted ascending"}
            onClick={() => setFilters({ order: descending ? "asc" : "desc" })}
          >
            {descending ? <ArrowDown /> : <ArrowUp />}
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setFilters({ ...EMPTY_FILTERS, sort: filters.sort, order: filters.order })}>
              Clear
            </Button>
          )}
          <Button variant="outline" render={<a href={api.exportUrl(filters)} download />}>
            <Download /> <span className="hidden sm:inline">CSV</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
