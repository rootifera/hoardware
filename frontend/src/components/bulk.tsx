"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Download, Loader2, MapPinned, NotebookPen, Printer, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
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
import { Input } from "@/components/ui/input";
import { SimpleSelect } from "@/components/simple-select";
import { Textarea } from "@/components/ui/textarea";
import { api, daysAgo } from "@/lib/api";
import {
  CONDITIONS,
  ITEM_STATUSES,
  ITEM_STATUS_LABELS,
  SETTABLE_STATUSES,
  TEST_STATUSES,
  type ItemStatus,
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
    low_stock: f.lowStock,
    spec_key: f.specKey || null,
    spec_op: f.specOp,
    spec_value: f.specKey && f.specValue.trim() ? f.specValue.trim() : null,
    status: f.status === "all" ? [...ITEM_STATUSES] : f.status ? [f.status] : [],
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

/** Set the status (lent, sold, wishlist…) of the selected items, with an optional note. */
function StatusDialog({ open, onClose, onApply }: { open: boolean; onClose: () => void; onApply: (status: ItemStatus, note: string | null) => void }) {
  const [status, setStatus] = useState<ItemStatus>("lent");
  const [note, setNote] = useState("");
  const noted = status !== "in_collection";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set status</DialogTitle>
          <DialogDescription>Sold, scrapped and wishlist items are taken off their shelf; the history remembers where they were.</DialogDescription>
        </DialogHeader>
        {open && (
          <div className="grid gap-3">
            <SimpleSelect
              aria-label="Status"
              value={status}
              onChange={(v) => setStatus(v as ItemStatus)}
              options={SETTABLE_STATUSES.map((s) => ({ value: s, label: ITEM_STATUS_LABELS[s] }))}
            />
            {noted && <Input aria-label="Note" maxLength={300} placeholder="Note, e.g. who has them (optional)" value={note} onChange={(e) => setNote(e.target.value)} />}
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => onApply(status, noted ? note.trim() || null : null)}>Set status</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Set (or remove) one spec on the selected items, e.g. Socket = Socket 7 on forty CPUs. */
function SpecDialog({ open, onClose, onApply }: { open: boolean; onClose: () => void; onApply: (key: string, value: string | null) => void }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set a spec</DialogTitle>
          <DialogDescription>Sets one specification (such as Socket or Capacity) on every selected item, replacing its old value.</DialogDescription>
        </DialogHeader>
        {open && (
          <div className="grid gap-3">
            <Input aria-label="Spec name" maxLength={100} placeholder="Spec name, e.g. Socket" value={key} onChange={(e) => setKey(e.target.value)} />
            <Input aria-label="Spec value" maxLength={300} placeholder="Value, e.g. Socket 7" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={!key.trim()} onClick={() => onApply(key.trim(), null)}>
            Remove this spec
          </Button>
          <Button disabled={!key.trim() || !value.trim()} onClick={() => onApply(key.trim(), value.trim())}>
            Set spec
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
  const [statusOpen, setStatusOpen] = useState(false);
  const [specOpen, setSpecOpen] = useState(false);
  const [pending, setPending] = useState<{ label: string; changes: BulkChanges } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  async function exportCsv() {
    setExporting(true);
    try {
      await api.exportSelected(selection);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const apply = useMutation({
    mutationFn: (changes: BulkChanges) => api.bulk(selection, changes),
    onSuccess: (r) => {
      invalidate();
      toast.success(`Updated ${plural(r.matched)}`);
      setPending(null);
      setNotes(false);
      setStatusOpen(false);
      setSpecOpen(false);
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
        // Sticks under the page header while the list scrolls, so it is always in sight.
        className="sticky top-16 z-30 mb-3 flex flex-wrap items-center gap-2 rounded-xl border bg-popover px-3 py-2 shadow-md"
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
        <Button variant="outline" size="sm" disabled={apply.isPending} onClick={() => setStatusOpen(true)}>
          Status…
        </Button>
        <Button variant="outline" size="sm" disabled={apply.isPending} onClick={() => setSpecOpen(true)}>
          <SlidersHorizontal /> Spec…
        </Button>
        <Button variant="outline" size="sm" disabled={apply.isPending} onClick={() => setMoving(true)}>
          <MapPinned /> Move…
        </Button>
        <Button variant="outline" size="sm" disabled={apply.isPending || exporting} title="Download the selected items as a CSV file" onClick={() => void exportCsv()}>
          {exporting ? <Loader2 className="animate-spin" /> : <Download />} Export
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={apply.isPending}
          title="Print barcode labels for the selected items"
          onClick={() => {
            sessionStorage.setItem("hoardware.labels", JSON.stringify(selection));
            router.push("/labels");
          }}
        >
          <Printer /> Labels
        </Button>
        <Button variant="outline" size="sm" className="text-destructive" disabled={apply.isPending} onClick={() => setDeleting(true)}>
          <Trash2 /> Delete…
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear}>
          <X />
        </Button>
      </div>

      <DeleteDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        selection={selection}
        count={count}
        onDone={() => {
          invalidate();
          onClear();
        }}
      />
      <MoveDialog open={moving} onClose={() => setMoving(false)} selection={selection} count={count} onDone={onClear} />
      <StatusDialog
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        onApply={(status, note) => request(`status “${ITEM_STATUS_LABELS[status]}”`, { status, status_note: note })}
      />
      <SpecDialog
        open={specOpen}
        onClose={() => setSpecOpen(false)}
        onApply={(key, value) => request(value === null ? `remove the spec “${key}”` : `spec “${key}” = “${value}”`, { attributes: { [key]: value } })}
      />
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

const TYPE_TO_CONFIRM_ABOVE = 25;

/** Delete the selected items for good. Larger deletions must be confirmed by typing "delete". */
function DeleteDialog({
  open,
  onClose,
  selection,
  count,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  selection: BulkSelection;
  count: number;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState("");
  const needsTyping = count > TYPE_TO_CONFIRM_ABOVE;
  const remove = useMutation({
    mutationFn: () => api.bulkDelete(selection),
    onSuccess: (r) => {
      toast.success(`Deleted ${plural(r.deleted)}`);
      setTyped("");
      onClose();
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setTyped("");
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {plural(count)}?</AlertDialogTitle>
          <AlertDialogDescription>
            The selected items are removed permanently, together with their photos, files and test history. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {needsTyping && (
          <label className="grid gap-1.5 text-sm">
            Type <b>delete</b> to confirm
            <input
              className="h-9 rounded-lg border border-input bg-transparent px-2.5 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </label>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending || (needsTyping && typed.trim().toLowerCase() !== "delete")}
            onClick={(e) => {
              e.preventDefault();
              remove.mutate();
            }}
          >
            {remove.isPending && <Loader2 className="animate-spin" />} Delete {plural(count)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
