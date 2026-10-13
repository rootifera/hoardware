"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, MapPin, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import type { Location } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface PickedLocation {
  id: number;
  full_name: string;
}

/** Searchable location selector. Searches the full path ("shelf 2 box 3");
 *  with an empty query it lists the top-level locations. */
export function LocationPicker({
  value,
  onChange,
  placeholder = "No location",
  className,
  excludeId,
  id,
}: {
  value: PickedLocation | null;
  onChange: (location: PickedLocation | null) => void;
  placeholder?: string;
  className?: string;
  /** Hide this location (used when choosing a new parent for it). */
  excludeId?: number;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 150);

  const results = useQuery({
    queryKey: ["location-picker", debounced],
    queryFn: () => api.locations({ q: debounced }),
    enabled: open,
  });

  // Moving a location into its own descendant is rejected by the server.
  const choices = (results.data?.items ?? []).filter((l: Location) => l.id !== excludeId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("flex items-center gap-1", className)}>
        <PopoverTrigger
          render={
            <Button id={id} type="button" variant="outline" className="min-w-0 flex-1 justify-between font-normal" />
          }
        >
          <span className={cn("flex min-w-0 items-center gap-1.5", !value && "text-muted-foreground")}>
            <MapPin className="size-3.5 shrink-0" />
            <span className="truncate">{value ? value.full_name : placeholder}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </PopoverTrigger>
        {value && (
          <Button type="button" variant="ghost" size="icon" aria-label="Clear location" onClick={() => onChange(null)}>
            <X />
          </Button>
        )}
      </div>
      <PopoverContent align="start" className="w-[min(28rem,90vw)] gap-2 p-2">
        <Input
          autoFocus
          placeholder="Search locations, e.g. shelf 2 box"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="max-h-64 overflow-y-auto">
          {results.isLoading && <p className="p-2 text-sm text-muted-foreground">Loading…</p>}
          {results.isError && <p className="p-2 text-sm text-destructive">Could not load locations.</p>}
          {results.data && choices.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">
              {debounced ? "No matching locations." : "No locations yet. Create some under Locations."}
            </p>
          )}
          {choices.map((l) => (
            <button
              key={l.id}
              type="button"
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              onClick={() => {
                onChange({ id: l.id, full_name: l.full_name });
                setOpen(false);
                setQuery("");
              }}
            >
              <span className="truncate">{l.full_name}</span>
            </button>
          ))}
          {!debounced && results.data?.next_cursor && (
            <p className="p-2 text-xs text-muted-foreground">Type to search the rest.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
