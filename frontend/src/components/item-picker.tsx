"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import { EMPTY_FILTERS, type ItemRef } from "@/lib/types";
import { cn } from "@/lib/utils";

const label = (i: { inventory_code: string; manufacturer: string | null; model: string }) =>
  `${i.inventory_code} ${[i.manufacturer, i.model].filter(Boolean).join(" ")}`;

/** Search the inventory and pick one item (for example the build a part is installed in). */
export function ItemPicker({
  value,
  onChange,
  placeholder = "Choose an item",
  excludeId,
  id,
  className,
}: {
  value: ItemRef | null;
  onChange: (item: ItemRef | null) => void;
  placeholder?: string;
  excludeId?: number;
  id?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 200);
  const results = useQuery({
    queryKey: ["item-picker", debounced],
    queryFn: () => api.items({ ...EMPTY_FILTERS, q: debounced, sort: "name" }, null, 20),
    enabled: open && debounced.trim().length > 0,
  });
  const choices = (results.data?.items ?? []).filter((i) => i.id !== excludeId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("flex items-center gap-1", className)}>
        <PopoverTrigger render={<Button id={id} type="button" variant="outline" className="min-w-0 flex-1 justify-between font-normal" />}>
          <span className={cn("truncate", !value && "text-muted-foreground")}>{value ? label(value) : placeholder}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </PopoverTrigger>
        {value && (
          <Button type="button" variant="ghost" size="icon" aria-label="Clear" onClick={() => onChange(null)}>
            <X />
          </Button>
        )}
      </div>
      <PopoverContent align="start" className="w-[min(28rem,90vw)] gap-2 p-2">
        <Input autoFocus placeholder="Search by name, code or part number" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="max-h-64 overflow-y-auto">
          {!debounced.trim() && <p className="p-2 text-sm text-muted-foreground">Type to search.</p>}
          {results.isError && <p className="p-2 text-sm text-destructive">Could not search.</p>}
          {results.data && choices.length === 0 && <p className="p-2 text-sm text-muted-foreground">Nothing matches.</p>}
          {choices.map((i) => (
            <button
              key={i.id}
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              onClick={() => {
                onChange({ id: i.id, inventory_code: i.inventory_code, manufacturer: i.manufacturer, model: i.model, category_name: i.category_name });
                setOpen(false);
                setQuery("");
              }}
            >
              <span className="truncate">{label(i)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{i.category_name}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
