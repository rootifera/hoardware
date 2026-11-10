"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, ChevronDown, ChevronRight, FolderPlus, MapPin, Pencil, Plus, Printer, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { MoveDialog, toBulkFilter } from "@/components/bulk";
import { SimpleSelect } from "@/components/simple-select";
import { VERIFIED_OPTIONS } from "@/components/filter-bar";
import { ItemList } from "@/components/item-list";
import { LocationDialog, type LocationDialogState } from "@/components/location-dialog";
import { useQuickAdd } from "@/components/quick-add";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { EMPTY_FILTERS, type Location } from "@/lib/types";
import { cn } from "@/lib/utils";

function useChildren(parentId: number | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["location-children", parentId],
    queryFn: ({ pageParam }) => api.locations({ parent_id: parentId, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled,
  });
}

function Children({ parentId, depth, selectedId, openIds, onSelect }: { parentId: number | null; depth: number; selectedId: number | null; openIds: Set<number>; onSelect: (id: number) => void }) {
  const children = useChildren(parentId);
  if (children.isPending) return <Skeleton className="my-1 ml-4 h-6 w-40" />;
  if (children.isError) return <p className="px-2 py-1 text-sm text-destructive">{children.error.message}</p>;
  const locations = children.data.pages.flatMap((p) => p.items);
  return (
    <>
      {locations.map((l) => (
        <TreeNode key={l.id} location={l} depth={depth} selectedId={selectedId} openIds={openIds} onSelect={onSelect} />
      ))}
      {children.hasNextPage && (
        <Button variant="ghost" size="sm" style={{ marginLeft: depth * 16 + 8 }} onClick={() => children.fetchNextPage()} disabled={children.isFetchingNextPage}>
          Show more
        </Button>
      )}
    </>
  );
}

function TreeNode({ location, depth, selectedId, openIds, onSelect }: { location: Location; depth: number; selectedId: number | null; openIds: Set<number>; onSelect: (id: number) => void }) {
  // The path to the selected location opens by itself; a click on the arrow overrides that.
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? openIds.has(location.id);
  const setExpanded = (value: boolean) => setOverride(value);
  const selected = selectedId === location.id;
  return (
    <div>
      <div
        className={cn("flex items-center rounded-md pr-2 text-sm hover:bg-muted/60", selected && "bg-muted font-medium")}
        style={{ paddingLeft: depth * 16 }}
      >
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          aria-expanded={expanded}
          disabled={!location.has_children}
          onClick={() => setExpanded(!expanded)}
          className="flex size-7 shrink-0 items-center justify-center text-muted-foreground disabled:opacity-0"
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left" onClick={() => onSelect(location.id)}>
          <span className="truncate">{location.name}</span>
          {location.type && <span className="shrink-0 text-xs text-muted-foreground">{location.type}</span>}
        </button>
      </div>
      {expanded && location.has_children && (
        <Children parentId={location.id} depth={depth + 1} selectedId={selectedId} openIds={openIds} onSelect={onSelect} />
      )}
    </div>
  );
}

function LocationPanel({ id, onSelect, onEdit, onAddChild }: { id: number; onSelect: (id: number | null) => void; onEdit: (l: Parameters<typeof LocationDialog>[0]["state"]) => void; onAddChild: () => void }) {
  const queryClient = useQueryClient();
  const { open: openQuickAdd } = useQuickAdd();
  const [exact, setExact] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [moveAll, setMoveAll] = useState(false);
  const [verified, setVerified] = useState("");
  const contents = { ...EMPTY_FILTERS, location: String(id), exact, verified };
  const itemCount = useQuery({ queryKey: ["items", "count", contents], queryFn: () => api.itemCount(contents) });
  const location = useQuery({
    queryKey: ["location", id],
    queryFn: () => api.location(id),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteLocation(id),
    onSuccess: () => {
      for (const key of ["location-children", "location-picker"]) queryClient.invalidateQueries({ queryKey: [key] });
      toast.success("Location deleted");
      setConfirm(false);
      onSelect(location.data?.parent_id ?? null);
    },
    onError: (e) => {
      setConfirm(false);
      toast.error(e.message);
    },
  });

  if (location.isError) return <p className="text-sm text-muted-foreground">This location no longer exists.</p>;
  if (!location.data) return <Skeleton className="h-40 w-full" />;
  const l = location.data;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground" aria-label="Location path">
          <button className="hover:text-foreground" onClick={() => onSelect(null)}>
            All
          </button>
          {l.ancestors.map((a) => (
            <span key={a.id} className="flex items-center gap-1">
              <ChevronRight className="size-3" />
              <button className="hover:text-foreground" onClick={() => onSelect(a.id)}>
                {a.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            <MapPin className="size-5 text-muted-foreground" /> {l.name}
            {l.type && <Badge variant="secondary">{l.type}</Badge>}
          </h2>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openQuickAdd({ location: { id: l.id, full_name: l.full_name } })}>
              <Plus /> Add item here
            </Button>
            <Button
              variant="outline"
              size="sm"
              render={<Link href={`/locations/print?id=${id}${exact ? "&exact=1" : ""}`} target="_blank" />}
            >
              <Printer /> Print list
            </Button>
            <Button variant="outline" size="sm" render={<Link href={`/labels?locations=${id}`} />} title="A barcode label for this box or shelf: scanning it opens what is inside">
              <Printer /> Label
            </Button>
            <Button variant="outline" size="sm" disabled={!itemCount.data} onClick={() => setMoveAll(true)}>
              <ArrowRightLeft /> Move all items…
            </Button>
            <Button variant="outline" size="sm" onClick={onAddChild}>
              <FolderPlus /> Sub-location
            </Button>
            <Button variant="outline" size="sm" onClick={() => onEdit({ mode: "edit", location: l })}>
              <Pencil /> Edit / move
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirm(true)}>
              <Trash2 /> Delete
            </Button>
          </div>
        </div>
        {l.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{l.notes}</p>}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-primary" checked={!exact} onChange={(e) => setExact(!e.target.checked)} />
            Include items in sub-locations
          </label>
          <SimpleSelect
            aria-label="Stock-take"
            size="sm"
            className="w-52"
            value={verified}
            onChange={setVerified}
            anyLabel="All items (stock-take off)"
            options={VERIFIED_OPTIONS}
          />
        </div>
        <ItemList filters={{ ...contents, sort: "position" }} />
        <p className="text-xs text-muted-foreground">
          <Link className="underline" href={`/?location=${id}`}>
            Open in the full inventory view
          </Link>{" "}
          for more filters.
        </p>
      </div>

      <MoveDialog
        open={moveAll}
        onClose={() => setMoveAll(false)}
        title={`Move everything out of “${l.name}”`}
        selection={{ filter: toBulkFilter(contents) }}
        count={itemCount.data ?? 0}
      />

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{l.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Only empty locations can be deleted. If it still holds items or sub-locations you will be asked to move them first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function LocationsView() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("id") ? Number(params.get("id")) : null;
  const [dialog, setDialog] = useState<LocationDialogState>(null);
  const roots = useChildren(null);
  // Ancestors of the selected location (same query the detail panel uses, so one request).
  const selectedLocation = useQuery({
    queryKey: ["location", selected],
    queryFn: () => api.location(selected!),
    enabled: selected !== null,
    retry: false,
  });
  const openIds = new Set(selectedLocation.data?.ancestors.map((a) => a.id) ?? []);
  const select = (id: number | null) => router.push(id ? `/locations?id=${id}` : "/locations", { scroll: false });
  const empty = roots.data && roots.data.pages[0].items.length === 0;

  return (
    <div className="grid gap-8 lg:grid-cols-[18rem_1fr]">
      <aside className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight">Locations</h1>
          <Button size="sm" onClick={() => setDialog({ mode: "create", parent: null })}>
            <Plus /> New
          </Button>
        </div>
        {empty ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No locations yet. Create a room or shelf, then nest boxes inside it.
          </div>
        ) : (
          <nav aria-label="Location tree" className="max-h-[70vh] overflow-y-auto">
            <Children parentId={null} depth={0} selectedId={selected} openIds={openIds} onSelect={select} />
          </nav>
        )}
      </aside>
      <section className="min-w-0">
        {selected ? (
          <LocationPanel
            key={selected}
            id={selected}
            onSelect={select}
            onEdit={setDialog}
            onAddChild={() => api.location(selected).then((l) => setDialog({ mode: "create", parent: { id: l.id, full_name: l.full_name } }))}
          />
        ) : (
          <div className="flex h-64 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            Select a location to see what is inside it.
          </div>
        )}
      </section>
      <LocationDialog state={dialog} onClose={() => setDialog(null)} onSaved={(l) => l && select(l.id)} />
    </div>
  );
}
