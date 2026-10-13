"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LocationPicker, type PickedLocation } from "@/components/location-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { LocationDetail } from "@/lib/types";

export type LocationDialogState =
  | { mode: "create"; parent: PickedLocation | null }
  | { mode: "edit"; location: LocationDetail }
  | null;

function initialFields(state: NonNullable<LocationDialogState>) {
  if (state.mode === "create") return { name: "", notes: "", type: "", parent: state.parent };
  const { location } = state;
  return {
    name: location.name,
    notes: location.notes ?? "",
    type: location.type ?? "",
    // The parent is the last ancestor, so its path is the ancestors' names.
    parent:
      location.parent_id != null
        ? { id: location.parent_id, full_name: location.ancestors.map((a) => a.name).join(" > ") }
        : null,
  };
}

export function LocationDialog({
  state,
  onClose,
  onSaved,
}: {
  state: LocationDialogState;
  onClose: () => void;
  onSaved?: (location: LocationDetail) => void;
}) {
  const editing = state?.mode === "edit";
  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit location" : "New location"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Rename it, or change its parent to move it with everything inside."
              : "Create the location first, then locations inside it. An item's exact spot is its position inside a location."}
          </DialogDescription>
        </DialogHeader>
        {state && <LocationForm state={state} onClose={onClose} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}

function LocationForm({
  state,
  onClose,
  onSaved,
}: {
  state: NonNullable<LocationDialogState>;
  onClose: () => void;
  onSaved?: (location: LocationDetail) => void;
}) {
  const queryClient = useQueryClient();
  const initial = initialFields(state);
  const [name, setName] = useState(initial.name);
  const [type, setType] = useState(initial.type);
  const [notes, setNotes] = useState(initial.notes);
  const [parent, setParent] = useState<PickedLocation | null>(initial.parent);
  const editing = state.mode === "edit";
  const types = useQuery({ queryKey: ["location-types"], queryFn: api.locationTypes, staleTime: 30_000 });

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), parent_id: parent?.id ?? null, notes: notes.trim() || null, type: type.trim() || null };
      return state.mode === "create" ? api.createLocation(body) : api.updateLocation(state.location.id, body);
    },
    onSuccess: (location) => {
      for (const key of ["location-children", "location", "location-picker", "location-types", "items"]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      toast.success(state.mode === "create" ? "Location created" : "Location saved");
      onSaved?.(location);
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <div className="grid gap-1.5">
          <Label htmlFor="loc-name">Name</Label>
          <Input id="loc-name" autoFocus autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="loc-type">Type</Label>
          <Input
            id="loc-type"
            list="location-type-suggestions"
            autoComplete="off"
            placeholder="shelf, box…"
            maxLength={100}
            value={type}
            onChange={(e) => setType(e.target.value)}
          />
          <datalist id="location-type-suggestions">
            {(types.data ?? []).map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="loc-parent">Inside</Label>
        <LocationPicker
          id="loc-parent"
          placeholder="Top level"
          value={parent}
          onChange={setParent}
          excludeId={state.mode === "edit" ? state.location.id : undefined}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="loc-notes">Notes</Label>
        <Textarea id="loc-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />} {editing ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}
