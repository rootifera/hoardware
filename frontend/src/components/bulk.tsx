"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Loader2, MapPinned, NotebookPen, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LocationPicker, type PickedLocation } from "@/components/location-picker";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { api, daysAgo } from "@/lib/api";
import {
  CONDITIONS,
  TEST_STATUSES,
  type BulkChanges,
  type BulkFilter,
  type BulkSelection,
  type ItemFilters,
  type PositionMode,
} from "@/lib/types";

/** What the user has ticked: specific rows, or "everything matching the filter" minus exceptions. */
export type Selection = { mode: "ids"; ids: Set<number> } | { mode: "all"; excluded: Set<number> };
export const EMPTY_SELECTION: Selection = { mode: "ids", ids: new Set() };

export function toBulkFilter(f: ItemFilters): BulkFilter {
  return {
    q: f.q.trim() || null,
    category_id: f.category ? [Number(f.category)] : [],
    manufacturer: f.manufacturer || null,
    condition: f.condition ? [f.condition] : [],
    test_status: f.test ? [f.test] : [],
    identification_confidence: f.confidence ? [f.confidence] : [],
    location_id: f.unassigned || !f.location ? null : Number(f.location),
    include_descendants: !f.exact,
    unassigned: f.unassigned,
    never_verified: f.verified === "never",
    verified_before: f.verified && f.verified !== "never" ? daysAgo(Number(f.verified)) : null,
  };
}

export function toBulkSelection(sel: Selection, filters: ItemFilters): BulkSelection {
  return sel.mode === "ids" ? { ids: [...sel.ids] } : { filter: toBulkFilter(filters), exclude_ids: [...sel.excluded] };
}

const plural = (n: number) => `${n.toLocaleString()} item${n === 1 ? "" : "s"}`;

function useInvalidateAfterBulk() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ["items", "item", "location", "location-children", "next-position"]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

const POSITION_HELP: Record<PositionMode, { title: string; text: string }> = {
  clear: { title: "Clear positions", text: "Items arrive without a position. Set them afterwards." },
  append: {
    title: "Number on after the last one",
    text: "Continue after the highest position in the destination, keeping the items' relative order.",
  },
  keep: { title: "Keep their numbers", text: "Each item keeps its position. Refused if any would clash." },
};

/** Move the selected items to a location (or out of any location). Shows what
 *  will happen, including position clashes, before anything is changed. */
export function MoveDialog({
  open,
  onClose,
  selection,
  count,
  onDone,
  title = "Move items",
}: {
  open: boolean;
  onClose: () => void;
  selection: BulkSelection;
  count: number;
  onDone?: () => void;
  title?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{plural(count)} selected.</DialogDescription>
        </DialogHeader>
        {open && <MoveForm selection={selection} onClose={onClose} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

function MoveForm({ selection, onClose, onDone }: { selection: BulkSelection; onClose: () => void; onDone?: () => void }) {
  const invalidate = useInvalidateAfterBulk();
  const [target, setTarget] = useState<"location" | "none">("location");
  const [dest, setDest] = useState<PickedLocation | null>(null);
  const [mode, setMode] = useState<PositionMode>("clear");
  const ready = target === "none" || dest !== null;
  const changes: BulkChanges = { location_id: target === "none" ? null : (dest?.id ?? null) };

  const preview = useQuery({
    queryKey: ["bulk-preview", JSON.stringify(selection), target, dest?.id ?? null, mode],
    queryFn: () => api.bulk(selection, changes, { positions: mode, dryRun: true }),
    enabled: ready,
  });
  const move = useMutation({
    mutationFn: () => api.bulk(selection, changes, { positions: mode }),
    onSuccess: (r) => {
      invalidate();
      toast.success(`Moved ${plural(r.moved)}${r.matched > r.moved ? ` (${r.matched - r.moved} already there)` : ""}`);
      onDone?.();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const clash = mode === "keep" && (preview.data?.clashes ?? 0) > 0;
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="move-target" className="accent-primary" checked={target === "location"} onChange={() => setTarget("location")} />
          Move to a location
        </label>
        {target === "location" && <LocationPicker value={dest} onChange={setDest} placeholder="Choose the destination" />}
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="move-target" className="accent-primary" checked={target === "none"} onChange={() => setTarget("none")} />
          Take out of any location (unassigned)
        </label>
      </div>

      {target === "location" && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Positions</legend>
          {(Object.keys(POSITION_HELP) as PositionMode[]).map((m) => (
            <label key={m} className="flex items-start gap-2 text-sm">
              <input type="radio" name="move-mode" className="mt-0.5 accent-primary" checked={mode === m} onChange={() => setMode(m)} />
              <span>
                {POSITION_HELP[m].title}
                <span className="block text-xs text-muted-foreground">{POSITION_HELP[m].text}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <div className="min-h-5 text-sm" aria-live="polite">
        {!ready ? (
          <span className="text-muted-foreground">Choose a destination.</span>
        ) : preview.isPending ? (
          <span className="text-muted-foreground">Checking…</span>
        ) : preview.isError ? (
          <span className="text-destructive">{preview.error.message}</span>
        ) : clash ? (
          <span className="text-destructive">
            {preview.data.clashes} position{preview.data.clashes === 1 ? "" : "s"} would clash. Choose “Clear” or “Number on”.
          </span>
        ) : preview.data.moved === 0 ? (
          <span className="text-muted-foreground">Everything selected is already there.</span>
        ) : (
          <span>
            {plural(preview.data.moved)} will move
            {preview.data.matched > preview.data.moved ? `; ${preview.data.matched - preview.data.moved} already there` : ""}.
          </span>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!ready || clash || move.isPending || preview.data?.moved === 0} onClick={() => move.mutate()}>
          {move.isPending && <Loader2 className="animate-spin" />} Move
        </Button>
      </DialogFooter>
    </div>
  );
}

function NotesDialog({ open, onClose, onApply }: { open: boolean; onClose: () => void; onApply: (notes: string | null) => void }) {
  const [text, setText] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set test notes</DialogTitle>
          <DialogDescription>Replaces the test notes of every selected item, e.g. why testing is blocked.</DialogDescription>
        </DialogHeader>
        {open && (
          <Textarea autoFocus rows={3} placeholder="e.g. Requires Socket 8 motherboard" value={text} onChange={(e) => setText(e.target.value)} />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onApply(null)}>
            Clear notes
          </Button>
          <Button disabled={!text.trim()} onClick={() => onApply(text.trim())}>
            Set notes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CONFIRM_ABOVE = 25;

/** Floating bar shown while items are selected. */
export function BulkBar({
  count,
  selection,
  onClear,
}: {
  count: number;
  selection: BulkSelection;
  onClear: () => void;
}) {
  const invalidate = useInvalidateAfterBulk();
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories, staleTime: 60_000 });
  const [moving, setMoving] = useState(false);
  const [notes, setNotes] = useState(false);
  const [pending, setPending] = useState<{ label: string; changes: BulkChanges } | null>(null);

  const apply = useMutation({
    mutationFn: (changes: BulkChanges) => api.bulk(selection, changes),
    onSuccess: (r) => {
      invalidate();
      toast.success(`Updated ${plural(r.matched)}`);
      setPending(null);
      setNotes(false);
    },
    onError: (e) => {
      setPending(null);
      toast.error(e.message);
    },
  });
  // Large selections ask first; small ones just apply.
  const request = (label: string, changes: BulkChanges) => (count > CONFIRM_ABOVE ? setPending({ label, changes }) : apply.mutate(changes));

  return (
    <>
      <div
        role="region"
        aria-label="Bulk actions"
        className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-fit max-w-[calc(100vw-1rem)] flex-wrap items-center gap-2 rounded-xl border bg-popover px-3 py-2 shadow-lg"
      >
        <span className="px-1 text-sm font-medium">{plural(count)} selected</span>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={apply.isPending} />}>Test status</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Set test status</DropdownMenuLabel>
              {TEST_STATUSES.map((s) => (
                <DropdownMenuItem key={s} onClick={() => request(`test status “${s}”`, { test_status: s })}>
                  {s}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={apply.isPending} />}>Condition</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Set condition</DropdownMenuLabel>
              {CONDITIONS.map((c) => (
                <DropdownMenuItem key={c} onClick={() => request(`condition “${c}”`, { condition: c })}>
                  {c}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={apply.isPending} />}>Category</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Set category</DropdownMenuLabel>
              {(categories.data ?? []).map((c) => (
                <DropdownMenuItem key={c.id} onClick={() => request(`category “${c.name}”`, { category_id: c.id })}>
                  {c.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="outline"
          size="sm"
          disabled={apply.isPending}
          title="Record that these items were seen in place today"
          onClick={() => request("“verified today” (seen in place)", { verified: true })}
        >
          <CheckCheck /> Verified
        </Button>
        <Button variant="outline" size="sm" disabled={apply.isPending} onClick={() => setNotes(true)}>
          <NotebookPen /> Notes
        </Button>
        <Button variant="outline" size="sm" disabled={apply.isPending} onClick={() => setMoving(true)}>
          <MapPinned /> Move…
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear}>
          <X />
        </Button>
      </div>

      <MoveDialog open={moving} onClose={() => setMoving(false)} selection={selection} count={count} onDone={onClear} />
      <NotesDialog
        open={notes}
        onClose={() => setNotes(false)}
        onApply={(text) => request(text === null ? "clear the test notes" : "set the test notes", { test_notes: text })}
      />
      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply to {plural(count)}?</AlertDialogTitle>
            <AlertDialogDescription>This will set {pending?.label} on every selected item.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pending && apply.mutate(pending.changes)}>Apply</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
