"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Minus, Plus, Split } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { LocationPicker, type PickedLocation } from "@/components/location-picker";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { ItemDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Take out of / add to a stock item, with the history of every change. */
export function StockPanel({ item, label, locked }: { item: ItemDetail; label: string; locked: boolean }) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("1");
  const [note, setNote] = useState("");
  const [showAll, setShowAll] = useState(false);
  const router = useRouter();
  const [splitting, setSplitting] = useState(false);
  const [splitAmount, setSplitAmount] = useState("");
  const [splitTo, setSplitTo] = useState<PickedLocation | null>(null);
  const history = useQuery({ queryKey: ["stock-log", item.id], queryFn: () => api.stockLog(item.id) });

  const change = useMutation({
    mutationFn: (delta: number) => api.stockChange(item.id, delta, note.trim()),
    onSuccess: (r, delta) => {
      toast.success(`${delta < 0 ? `Took out ${(-delta).toLocaleString()}` : `Added ${delta.toLocaleString()}`}: ${r.quantity.toLocaleString()} left`);
      setNote("");
      queryClient.invalidateQueries({ queryKey: ["item", item.id] });
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["stock-log", item.id] });
    },
    onError: (e) => toast.error(e.message),
  });

  const split = useMutation({
    mutationFn: () => api.splitStock(item.id, { quantity: Number(splitAmount), location_id: splitTo?.id ?? null }),
    onSuccess: (created) => {
      toast.success(`Moved ${Number(splitAmount).toLocaleString()} to ${splitTo?.full_name ?? "no location"} as ${created.inventory_code}`);
      setSplitting(false);
      setSplitAmount("");
      queryClient.invalidateQueries({ queryKey: ["item", item.id] });
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["stock-log", item.id] });
      router.push(`/items/${created.id}`);
    },
    onError: (e) => toast.error(e.message),
  });
  const splitN = Number(splitAmount);
  const splitValid = Number.isInteger(splitN) && splitN > 0 && splitN < item.quantity && splitTo !== null && splitTo.id !== item.location_id;

  const n = Number(amount);
  const valid = Number.isInteger(n) && n > 0;
  const out = item.quantity === 0;
  const low = !out && item.low_stock_level !== null && item.quantity <= item.low_stock_level;

  return (
    <section aria-label="Stock" className="rounded-xl border bg-card p-5 sm:p-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Stock</h2>
          <p className="text-sm text-muted-foreground">Take some out when you use them, add some when you get more.</p>
        </div>
        <div className="text-right">
          <div className={cn("text-3xl font-semibold tabular-nums", out && "text-destructive", low && "text-amber-800 dark:text-amber-300")}>
            {item.quantity.toLocaleString()}
          </div>
          <div className="text-xs text-muted-foreground">
            {label}
            {item.low_stock_level !== null && ` · warn at ${item.low_stock_level.toLocaleString()}`}
          </div>
        </div>
      </header>
      {(out || low) && (
        <p role="status" className={cn("mb-3 rounded-md px-3 py-2 text-sm", out ? "bg-red-500/10 text-red-800 dark:text-red-200" : "bg-amber-500/10 text-amber-900 dark:text-amber-200")}>
          {out ? "None left." : `Running low: ${item.quantity.toLocaleString()} left (warning at ${item.low_stock_level?.toLocaleString()}).`}
        </p>
      )}
      <form
        className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_auto_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !locked) change.mutate(-n);
        }}
      >
        <div className="grid gap-1">
          <label htmlFor="stock-amount" className="text-xs text-muted-foreground">
            How many
          </label>
          <Input id="stock-amount" type="number" min={1} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <label htmlFor="stock-note" className="text-xs text-muted-foreground">
            What for (optional)
          </label>
          <Input id="stock-note" maxLength={200} placeholder="e.g. amp build" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button type="submit" disabled={!valid || locked || change.isPending || n > item.quantity} title={n > item.quantity ? `Only ${item.quantity.toLocaleString()} left` : undefined}>
          {change.isPending && change.variables !== undefined && change.variables < 0 ? <Loader2 className="animate-spin" /> : <Minus />} Take out
        </Button>
        <Button type="button" variant="outline" disabled={!valid || locked || change.isPending} onClick={() => change.mutate(n)}>
          <Plus /> Add
        </Button>
      </form>
      {locked && <p className="mt-2 text-xs text-muted-foreground">You have unsaved changes on this page. Save or revert them first.</p>}

      {item.quantity > 1 && (
        <div className="mt-4">
          {!splitting ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setSplitting(true)}>
              <Split /> Some of these are somewhere else…
            </Button>
          ) : (
            <form
              aria-label="Move part of the stock"
              className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[7rem_minmax(0,1fr)_auto_auto] sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                if (splitValid && !locked) split.mutate();
              }}
            >
              <div className="grid gap-1">
                <label htmlFor="split-amount" className="text-xs text-muted-foreground">
                  How many
                </label>
                <Input id="split-amount" type="number" min={1} max={item.quantity - 1} inputMode="numeric" value={splitAmount} onChange={(e) => setSplitAmount(e.target.value)} />
              </div>
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">Move them to</span>
                <LocationPicker value={splitTo} onChange={setSplitTo} placeholder="Choose a location" />
              </div>
              <Button type="submit" disabled={!splitValid || locked || split.isPending}>
                {split.isPending ? <Loader2 className="animate-spin" /> : <Split />} Move
              </Button>
              <Button type="button" variant="ghost" onClick={() => setSplitting(false)}>
                Cancel
              </Button>
              <p className="text-xs text-muted-foreground sm:col-span-4">They become their own record with its own code, so each location shows its own count.</p>
            </form>
          )}
        </div>
      )}

      {history.data && history.data.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-1.5 text-sm font-medium">History</h3>
          <ul className="divide-y rounded-lg border text-sm" aria-label="Stock history">
            {history.data.slice(0, showAll ? undefined : 10).map((e) => (
              <li key={e.id} className="grid grid-cols-[5rem_minmax(0,1fr)_auto] items-baseline gap-3 px-3 py-1.5">
                <span className={cn("font-mono tabular-nums", e.change < 0 ? "text-red-700 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300")}>
                  {e.change > 0 ? "+" : ""}
                  {e.change.toLocaleString()}
                </span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {e.note ?? ""} <span className="text-xs">· {when(e.created_at)}</span>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">{e.quantity_after.toLocaleString()} left</span>
              </li>
            ))}
          </ul>
          {history.data.length > 10 && (
            <button type="button" className="mt-1.5 text-xs text-muted-foreground underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show the latest 10" : `Show all ${history.data.length}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
