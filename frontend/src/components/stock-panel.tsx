"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Minus, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
          <div className={cn("text-3xl font-semibold tabular-nums", out && "text-destructive", low && "text-amber-700 dark:text-amber-300")}>
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

      {history.data && history.data.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-1.5 text-sm font-medium">History</h3>
          <ul className="divide-y rounded-lg border text-sm" aria-label="Stock history">
            {history.data.slice(0, 10).map((e) => (
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
        </div>
      )}
    </section>
  );
}
