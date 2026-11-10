"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ItemPicker } from "@/components/item-picker";
import { SimpleSelect } from "@/components/simple-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { GONE_STATUSES, ITEM_STATUS_LABELS, SETTABLE_STATUSES, type ItemDetail, type ItemHistoryEntry, type ItemStatus, type ItemUpdate } from "@/lib/types";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const NOTE_HINTS: Partial<Record<ItemStatus, string>> = {
  lent: "Who has it?",
  sold: "Sold to / where? (optional)",
  scrapped: "Why? (optional)",
  wanted: "Where to find one? (optional)",
};

function describe(e: ItemHistoryEntry): string {
  if (e.kind === "location") return e.new ? `Moved ${e.old ? `from ${e.old} ` : ""}to ${e.new}` : `Taken out of ${e.old ?? "its location"}`;
  if (e.kind === "installed_in") return e.new ? `Installed in ${e.new}` : `Taken out of ${e.old}`;
  const name = (s: string | null) => (s && s in ITEM_STATUS_LABELS ? ITEM_STATUS_LABELS[s as ItemStatus] : (s ?? "?"));
  return `${name(e.old)} → ${name(e.new)}`;
}

/** Where the item is in its life (in the collection, in a build, lent, sold…), what is installed in it,
 *  and where it has been. Changes here are saved straight away. */
export function LifecyclePanel({ item, locked }: { item: ItemDetail; locked: boolean }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ItemStatus>(item.status);
  const [note, setNote] = useState(item.status_note ?? "");
  const [showAll, setShowAll] = useState(false);
  const history = useQuery({ queryKey: ["item-history", item.id], queryFn: () => api.itemHistory(item.id) });

  const save = useMutation({
    mutationFn: (patch: ItemUpdate) => api.updateItem(item.id, patch),
    onSuccess: (updated) => {
      setStatus(updated.status);
      setNote(updated.status_note ?? "");
      queryClient.invalidateQueries({ queryKey: ["item", item.id] });
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["item-history", item.id] });
      toast.success("Saved");
    },
    onError: (e) => toast.error(e.message),
  });

  const changed = status !== item.status || (note.trim() || null) !== item.status_note;
  const options = (item.status === "installed" ? (["installed", ...SETTABLE_STATUSES] as ItemStatus[]) : SETTABLE_STATUSES).map((s) => ({
    value: s,
    label: ITEM_STATUS_LABELS[s],
  }));

  return (
    <section aria-label="Where it is now" className="rounded-xl border bg-card p-5 sm:p-6">
      <header className="mb-4">
        <h2 className="text-base font-semibold tracking-tight">Where it is now</h2>
        <p className="text-sm text-muted-foreground">Nothing is deleted when an item leaves: it keeps its record and history.</p>
      </header>
      <div className="grid gap-3 sm:grid-cols-[13rem_minmax(0,1fr)_auto] sm:items-end">
        <div className="grid gap-1">
          <label htmlFor="life-status" className="text-xs text-muted-foreground">
            Status
          </label>
          <SimpleSelect id="life-status" aria-label="Status" value={status} onChange={(v) => setStatus(v as ItemStatus)} options={options} />
        </div>
        <div className="grid gap-1">
          <label htmlFor="life-note" className="text-xs text-muted-foreground">
            Note
          </label>
          <Input
            id="life-note"
            maxLength={300}
            placeholder={NOTE_HINTS[status] ?? "Optional"}
            disabled={status === "in_collection" || status === "installed"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <Button
          type="button"
          disabled={!changed || locked || save.isPending}
          onClick={() => save.mutate({ status, status_note: status === "in_collection" || status === "installed" ? null : note.trim() || null })}
        >
          Save status
        </Button>
      </div>
      {GONE_STATUSES.includes(status) && status !== item.status && item.location_id !== null && (
        <p className="mt-2 text-xs text-muted-foreground">Its location is cleared (the history keeps where it was).</p>
      )}
      {locked && <p className="mt-2 text-xs text-muted-foreground">You have unsaved changes on this page. Save or revert them first.</p>}

      <div className="mt-5 grid gap-1">
        <label htmlFor="life-installed" className="text-xs text-muted-foreground">
          Installed in (a PC, a case, another board…)
        </label>
        <ItemPicker
          id="life-installed"
          value={item.installed_in}
          placeholder="Not installed in anything"
          excludeId={item.id}
          onChange={(build) => !locked && save.mutate({ installed_in_id: build?.id ?? null })}
        />
      </div>

      {item.parts.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-1.5 text-sm font-medium">Installed in this ({item.parts.length})</h3>
          <ul className="divide-y rounded-lg border text-sm" aria-label="Parts installed">
            {item.parts.map((p) => (
              <li key={p.id} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                <Link href={`/items/${p.id}`} className="min-w-0 truncate underline-offset-2 hover:underline">
                  <span className="font-mono text-xs text-muted-foreground">{p.inventory_code}</span> {[p.manufacturer, p.model].filter(Boolean).join(" ")}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">{p.category_name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {history.data && history.data.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-1.5 text-sm font-medium">History</h3>
          <ul className="divide-y rounded-lg border text-sm" aria-label="Item history">
            {history.data.slice(0, showAll ? undefined : 8).map((e) => (
              <li key={e.id} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                <span className="min-w-0 truncate">{describe(e)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{when(e.created_at)}</span>
              </li>
            ))}
          </ul>
          {history.data.length > 8 && (
            <button type="button" className="mt-1.5 text-xs text-muted-foreground underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show the latest 8" : `Show all ${history.data.length}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
