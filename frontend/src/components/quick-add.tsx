"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Loader2 } from "lucide-react";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { LocationPicker, type PickedLocation } from "@/components/location-picker";
import { SimpleSelect } from "@/components/simple-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { CONDITIONS, TEST_STATUSES, type Condition, type TestStatus } from "@/lib/types";

interface QuickAddContext {
  open: (preset?: { location?: PickedLocation }) => void;
}

const Ctx = createContext<QuickAddContext>({ open: () => {} });
export const useQuickAdd = () => useContext(Ctx);

const STORAGE_KEY = "hoardware.quickadd";

interface Remembered {
  category?: string;
  location?: PickedLocation | null;
}

function readRemembered(): Remembered {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function QuickAddProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [preset, setPreset] = useState<{ location?: PickedLocation } | undefined>();

  const open = useCallback((p?: { location?: PickedLocation }) => {
    setPreset(p);
    setOpen(true);
  }, []);

  // "n" opens Quick Add from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "n" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector("[role=dialog], [role=alertdialog]")) return;
      e.preventDefault();
      open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const value = useMemo(() => ({ open }), [open]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <QuickAddDialog open={isOpen} onOpenChange={setOpen} preset={preset} />
    </Ctx.Provider>
  );
}

function QuickAddDialog({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: { location?: PickedLocation };
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Quick add</DialogTitle>
          <DialogDescription>
            Only a category and a description are needed. Everything else can be filled in later.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every opening starts from a fresh form. */}
        {open && <QuickAddForm preset={preset} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function QuickAddForm({ preset, onClose }: { preset?: { location?: PickedLocation }; onClose: () => void }) {
  const queryClient = useQueryClient();
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const modelRef = useRef<HTMLInputElement>(null);

  // Category and location are remembered between additions.
  const [remembered] = useState(readRemembered);
  const [category, setCategory] = useState(remembered.category ?? "");
  const [model, setModel] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [condition, setCondition] = useState<Condition>("Unknown");
  const [testStatus, setTestStatus] = useState<TestStatus>("Untested");
  const [location, setLocation] = useState<PickedLocation | null>(preset?.location ?? remembered.location ?? null);
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [copies, setCopies] = useState(1);
  const [position, setPosition] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The lowest free position after the last one used in the chosen location.
  const nextFree = useQuery({
    queryKey: ["next-position", location?.id],
    queryFn: () => api.nextPosition(location!.id),
    enabled: location !== null,
    staleTime: 0,
  });

  const categoryOptions = (categories.data ?? []).map((c) => ({ value: String(c.id), label: c.name }));
  // Fall back to the first category when nothing (valid) is remembered.
  const effectiveCategory = categoryOptions.some((o) => o.value === category) ? category : (categoryOptions[0]?.value ?? "");

  async function save(addAnother: boolean) {
    if (saving) return;
    if (!effectiveCategory) return setError("Choose a category.");
    if (!model.trim()) {
      setError("Describe the part, e.g. “Unknown PCI video card”.");
      modelRef.current?.focus();
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const fields = {
        category_id: Number(effectiveCategory),
        model: model.trim(),
        manufacturer: manufacturer.trim() || null,
        part_number: partNumber.trim() || null,
        condition,
        test_status: testStatus,
        notes: notes.trim() || null,
      };
      // A position is the item's exact spot inside the location.
      const start = position.trim() === "" ? null : Number(position);
      if (start !== null && (!Number.isInteger(start) || start < 0)) {
        setSaving(false);
        return setError("Position must be a whole number, 0 or more.");
      }
      if (start !== null && !location) {
        setSaving(false);
        return setError("Choose a location to give the item a position.");
      }
      // Several copies are several separate items (own code, condition, test status),
      // at consecutive positions when a start position is given.
      const batch =
        copies > 1
          ? await api.createItemsBatch({
              item: { ...fields, location_id: location?.id ?? null },
              copies,
              order_start: start,
            })
          : null;
      const item = batch ? null : await api.createItem({ ...fields, location_id: location?.id ?? null, order: start });
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ category: effectiveCategory, location } satisfies Remembered));
      let photoNote = "";
      if (item && files.length) {
        try {
          await api.uploadPhotos(item.id, files);
        } catch (e) {
          photoNote = ` (photos failed: ${e instanceof Error ? e.message : "upload error"})`;
        }
      }
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["manufacturers"] });
      queryClient.invalidateQueries({ queryKey: ["next-position"] });
      toast.success(
        batch ? (
          <span>
            Added {batch.created.length} items: {batch.created[0].inventory_code} – {batch.created.at(-1)?.inventory_code}
          </span>
        ) : (
          <span>
            Added{" "}
            <Link className="font-medium underline" href={`/items/${item!.id}`}>
              {item!.inventory_code}
            </Link>
            {photoNote}
          </span>
        ),
      );
      if (addAnother) {
        setModel("");
        setPartNumber("");
        setNotes("");
        setFiles([]);
        // Carry on from the next free spot.
        if (start !== null) setPosition(String(start + copies));
        setCopies(1);
        modelRef.current?.focus();
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the item.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save(true);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[11rem_1fr]">
        <div className="grid gap-1.5">
          <Label htmlFor="qa-category">Category</Label>
          <SimpleSelect
            id="qa-category"
            className="w-full"
            value={effectiveCategory}
            onChange={setCategory}
            options={categoryOptions}
            placeholder="Category"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="qa-model">Model / description</Label>
          <Input
            id="qa-model"
            ref={modelRef}
            autoFocus
            autoComplete="off"
            placeholder="e.g. Unknown ISA VGA card"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="qa-manufacturer">Manufacturer</Label>
          <Input
            id="qa-manufacturer"
            autoComplete="off"
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="qa-pn">Part number</Label>
          <Input id="qa-pn" autoComplete="off" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="qa-condition">Condition</Label>
          <SimpleSelect
            id="qa-condition"
            className="w-full"
            value={condition}
            onChange={(v) => setCondition(v as Condition)}
            options={CONDITIONS.map((c) => ({ value: c, label: c }))}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="qa-test">Test status</Label>
          <SimpleSelect
            id="qa-test"
            className="w-full"
            value={testStatus}
            onChange={(v) => setTestStatus(v as TestStatus)}
            options={TEST_STATUSES.map((s) => ({ value: s, label: s }))}
          />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <div className="grid gap-1.5">
          <Label htmlFor="qa-location">Location</Label>
          <LocationPicker
            id="qa-location"
            value={location}
            onChange={(l) => {
              setLocation(l);
              setPosition("");
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="qa-position">Position</Label>
          <Input
            id="qa-position"
            type="number"
            min={0}
            disabled={!location}
            placeholder={nextFree.data !== undefined ? `next: ${nextFree.data}` : "exact spot"}
            value={position}
            onChange={(e) => setPosition(e.target.value)}
          />
        </div>
      </div>
      {location && nextFree.data !== undefined && position === "" && (
        <button
          type="button"
          className="-mt-2 justify-self-start text-xs text-muted-foreground underline"
          onClick={() => setPosition(String(nextFree.data))}
        >
          Use next free position ({nextFree.data})
        </button>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="qa-notes">Notes</Label>
        <Textarea id="qa-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="grid gap-2 rounded-lg border border-dashed p-3">
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="qa-copies">Copies</Label>
          <Input
            id="qa-copies"
            type="number"
            min={1}
            max={200}
            className="w-20"
            value={copies}
            onChange={(e) => setCopies(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
          />
          <span className="text-xs text-muted-foreground">
            {copies > 1
              ? position.trim() !== "" && Number.isInteger(Number(position))
                ? `${copies} separate items at positions ${position}–${Number(position) + copies - 1}.`
                : `${copies} separate items, each with its own code.`
              : "Identical parts are still separate items."}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" disabled={copies > 1} render={<label htmlFor="qa-photos" className="cursor-pointer" />}>
          <ImagePlus /> Add photos
        </Button>
        <input
          id="qa-photos"
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          className="sr-only"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <span className="text-sm text-muted-foreground">
          {copies > 1 ? "add photos to each item afterwards" : files.length ? `${files.length} photo${files.length === 1 ? "" : "s"} selected` : "optional"}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={() => void save(false)}>
          Save &amp; close
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />} Save &amp; add another
        </Button>
      </DialogFooter>
    </form>
  );
}
