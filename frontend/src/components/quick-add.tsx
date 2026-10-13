"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { LocationPicker, type PickedLocation } from "@/components/location-picker";
import { OptionInput } from "@/components/option-input";
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
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import {
  CONDITIONS,
  EMPTY_FILTERS,
  TEST_STATUSES,
  type Condition,
  type ReferenceCandidate,
  type ReferenceSummary,
  type TestStatus,
} from "@/lib/types";

/** Optional starting values for the form (e.g. "add another like this"). */
export interface QuickAddPreset {
  location?: PickedLocation;
  category?: string;
  model?: string;
  manufacturer?: string;
  partNumber?: string;
  /** The item's own specs, by field name. */
  specs?: Record<string, string>;
  chipset?: string;
}

interface QuickAddContext {
  open: (preset?: QuickAddPreset) => void;
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

/** The kind of reference record that describes a category, if any. */
function refKindOf(categoryName: string): "cpu" | "gpu" | null {
  if (/cpu|processor/i.test(categoryName)) return "cpu";
  if (/gpu|vga|graphics|video/i.test(categoryName)) return "gpu";
  return null;
}

export function QuickAddProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [preset, setPreset] = useState<QuickAddPreset | undefined>();

  const open = useCallback((p?: QuickAddPreset) => {
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
  preset?: QuickAddPreset;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
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

function QuickAddForm({ preset, onClose }: { preset?: QuickAddPreset; onClose: () => void }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const modelRef = useRef<HTMLInputElement>(null);

  // Category and location are remembered between additions.
  const [remembered] = useState(readRemembered);
  const [category, setCategory] = useState(preset?.category ?? remembered.category ?? "");
  const [model, setModel] = useState(preset?.model ?? "");
  const [manufacturer, setManufacturer] = useState(preset?.manufacturer ?? "");
  const [partNumber, setPartNumber] = useState(preset?.partNumber ?? "");
  // The chip on a card or board (graphics, sound, motherboard): not the same thing as the card itself.
  const [chipset, setChipset] = useState(preset?.chipset ?? "");
  // The category's own fields (capacity, speed, interface…): by lower-cased field name, and
  // "col:<column>" for the fields kept in item columns (chipset maker, revision).
  const [specs, setSpecs] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(preset?.specs ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  );
  const [condition, setCondition] = useState<Condition>("Unknown");
  const [testStatus, setTestStatus] = useState<TestStatus>("Untested");
  const [location, setLocation] = useState<PickedLocation | null>(preset?.location ?? remembered.location ?? null);
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [copies, setCopies] = useState(1);
  const [position, setPosition] = useState("");
  // A reference model picked from the suggestions (CPU and graphics categories).
  const [match, setMatch] = useState<ReferenceSummary | null>(null);
  // The dropdown is closed (Esc, or focus left the field) for this typed text; typing again reopens it.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  // Suggestions are for what the user types, never for values that arrived pre-filled.
  const [typedByUser, setTypedByUser] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The lowest free position after the last one used in the chosen location.
  const nextFree = useQuery({
    queryKey: ["next-position", location?.id],
    queryFn: () => api.nextPosition(location!.id),
    enabled: location !== null,
    staleTime: 0,
  });

  // "You already have N of these": a quick guard against entering a part twice.
  const lookup = useDebouncedValue(`${manufacturer} ${model}`.trim(), 300);
  const existing = useQuery({
    queryKey: ["items", "count", "quick-add", lookup],
    queryFn: () => api.itemCount({ ...EMPTY_FILTERS, q: lookup }),
    enabled: model.trim().length >= 3,
  });

  // Suggestions from an imported reference dataset. In a CPU category anything
  // typed is looked up; elsewhere only something that looks like a chip code
  // (an S-Spec or ordering code) is, and only exact identifier matches count.
  // Nothing is ever filled in until the user picks a suggestion.
  const categoryOptions = (categories.data ?? []).map((c) => ({ value: String(c.id), label: c.name }));
  // Fall back to the first category when nothing (valid) is remembered: the id saved from an
  // earlier session may no longer exist. Everything below must use this one, not the raw state.
  const effectiveCategory = categoryOptions.some((o) => o.value === category) ? category : (categoryOptions[0]?.value ?? "");
  const categoryName = (categories.data ?? []).find((c) => String(c.id) === effectiveCategory)?.name ?? "";
  // Which kind of reference record describes this category (CPUs, graphics cards).
  const refKind = refKindOf(categoryName);
  const sources = useQuery({ queryKey: ["reference-sources"], queryFn: api.referenceSources, staleTime: 60_000 });
  const hasDataset = (sources.data ?? []).some((x) => x.models > 0);
  const categoryFields = (categories.data ?? []).find((c) => String(c.id) === effectiveCategory)?.fields ?? [];
  const hasChipsetField = categoryFields.some((f) => f.column === "chipset");
  // Everything else the category describes an item with; the chipset has its own field above.
  const specFields = categoryFields.filter((f) => f.column !== "chipset");
  const specKey = (f: { name: string; column: string | null }) => (f.column ? `col:${f.column}` : f.name.toLowerCase());
  // A graphics card is the board (maker + model, e.g. Diamond Viper V770 Ultra); the dataset
  // describes its chip (RIVA TNT2 Ultra), so the chip is looked up from its own field.
  const chipLookup = refKind === "gpu";
  const typed = useDebouncedValue(
    chipLookup ? chipset.trim() : partNumber.trim().length >= 3 ? partNumber.trim() : model.trim(),
    300,
  );
  const looksLikeCode = typed.length >= 4 && /\d/.test(typed) && !/\s{2,}/.test(typed);
  const wantsSuggestions = typedByUser && hasDataset && match === null && typed.length >= 3 && (refKind !== null || looksLikeCode);
  const suggestions = useQuery({
    queryKey: ["reference-suggestions", typed, refKind],
    queryFn: () => api.referenceSuggestions(typed, refKind),
    enabled: wantsSuggestions,
  });
  const offered = (suggestions.data ?? []).filter((c) => refKind !== null || c.match_type !== "text");
  const listOpen = wantsSuggestions && offered.length > 0 && closedFor !== typed;
  // The dropdown hangs under the field the text is coming from.
  const source: "part" | "model" | "chipset" = chipLookup ? "chipset" : partNumber.trim().length >= 3 ? "part" : "model";

  function pick(c: ReferenceCandidate) {
    const r = c.reference;
    setMatch(r);
    // Show what the match adds in the form itself, filling only what is still empty.
    void api
      .referenceSnapshot(r.id)
      .then((snap) =>
        setSpecs((cur) => {
          const next = { ...cur };
          for (const [name, value] of Object.entries(snap.specs)) if (!next[name.toLowerCase()]?.trim()) next[name.toLowerCase()] = value;
          for (const [column, value] of Object.entries(snap.columns)) if (column !== "chipset" && !next[`col:${column}`]?.trim()) next[`col:${column}`] = value;
          return next;
        }),
      )
      .catch(() => {});
    if (r.kind === "gpu") {
      // The card's own maker, model and part number stay as typed: only the chip is filled in.
      setChipset(r.display_name);
      return;
    }
    // A graphics record names the chip's vendor, which may not be who made the card:
    // it only fills an empty manufacturer. A CPU's maker is the record's.
    if (r.manufacturer && (r.kind === "cpu" || manufacturer.trim() === "")) setManufacturer(r.manufacturer);
    // The part number is the order code (or a graphics board number); the S-Spec is saved as its own spec.
    if (r.part_number && (r.kind === "cpu" || partNumber.trim() === "" || partNumber.trim() === typed)) setPartNumber(r.order_code ?? r.part_number);
    // Use the proper name unless the user wrote a real name of their own: an
    // empty model, or one that is just the code they typed, is replaced.
    const current = model.trim().toLowerCase();
    const onlyTheCode = current === "" || current === typed.toLowerCase() || (r.part_number ?? "").toLowerCase().includes(current);
    if (onlyTheCode) setModel(r.display_name);
    // A record belongs in its own category.
    if (refKindOf(categoryName) !== r.kind) {
      const own = (categories.data ?? []).find((c2) => refKindOf(c2.name) === r.kind);
      if (own) setCategory(String(own.id));
    }
  }


  async function save(mode: "close" | "edit" | "another") {
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
      // The category's fields: item columns for a few, the item's own specs for the rest.
      const attributes: Record<string, string> = {};
      const columns: Record<string, string> = {};
      for (const f of specFields) {
        const value = (specs[specKey(f)] ?? "").trim();
        if (!value) continue;
        if (f.column) columns[f.column] = value;
        else attributes[f.name] = value;
      }
      const fields = {
        ...columns,
        ...(Object.keys(attributes).length ? { attributes } : {}),
        category_id: Number(effectiveCategory),
        model: model.trim(),
        manufacturer: manufacturer.trim() || null,
        part_number: partNumber.trim() || null,
        ...(hasChipsetField && chipset.trim() ? { chipset: chipset.trim() } : {}),
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
      const matched = match ? { reference_model_id: match.id, identification_confidence: "confirmed" as const } : {};
      const batch =
        copies > 1
          ? await api.createItemsBatch({
              item: { ...fields, ...matched, location_id: location?.id ?? null },
              copies,
              order_start: start,
            })
          : null;
      const item = batch ? null : await api.createItem({ ...fields, ...matched, location_id: location?.id ?? null, order: start });
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
      if (mode === "another") {
        setModel("");
        setPartNumber("");
        setChipset("");
        setSpecs({});
        setNotes("");
        setFiles([]);
        setMatch(null);
        setTypedByUser(false);
        // Carry on from the next free spot.
        if (start !== null) setPosition(String(start + copies));
        setCopies(1);
        modelRef.current?.focus();
      } else {
        onClose();
        // Several copies have no single page to open.
        if (mode === "edit" && item) router.push(`/items/${item.id}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the item.");
    } finally {
      setSaving(false);
    }
  }

  const dropdown = listOpen && (
    <div
      role="group"
      aria-label="Suggestions"
      className="absolute top-full right-0 z-50 mt-1 w-[32rem] max-w-[calc(100vw-3rem)] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg"
    >
      <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">{refKind === "gpu" ? "Graphics chips. Pick one to fill in the chipset and its specs; your card's name stays as typed." : "From the reference database. Pick one to fill in the details."}</p>
      <div className="max-h-64 overflow-y-auto p-1">
        {offered.map((c) => (
          <button
            key={c.reference.id}
            type="button"
            className="grid w-full gap-0.5 rounded px-2 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            onClick={() => pick(c)}
          >
            <span className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium">
                {[c.reference.manufacturer, c.reference.display_name].filter(Boolean).join(" ")}
              </span>
              <span className="flex shrink-0 items-center gap-2 font-mono text-xs text-muted-foreground">
                {c.reference.kind === "gpu" ? c.reference.part_number : (c.reference.order_code ?? c.reference.part_number ?? c.reference.model)}
                {c.reference.s_spec && (
                  <span className="rounded bg-muted px-1.5 py-0.5 font-semibold text-foreground" title="S-Spec: the code printed on the chip">
                    {c.reference.s_spec}
                  </span>
                )}
              </span>
            </span>
            {c.reference.spec_line && <span className="truncate text-xs text-muted-foreground">{c.reference.spec_line}</span>}
          </button>
        ))}
      </div>
    </div>
  );
  // Esc closes just the dropdown; the arrow key moves from the field into it; leaving it closes it.
  const dropdownKeys = {
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!listOpen) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        setClosedFor(typed);
      } else if (e.key === "ArrowDown" && (e.target as HTMLElement).tagName === "INPUT") {
        e.preventDefault();
        e.currentTarget.querySelector<HTMLButtonElement>('[role="group"] button')?.focus();
      }
    },
    onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
      if (listOpen && !e.currentTarget.contains(e.relatedTarget as Node | null)) setClosedFor(typed);
    },
  };

  return (
    <form
      // minmax(0, 1fr): long content (e.g. the match bar) must wrap, not widen the dialog.
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save("close");
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[11rem_minmax(0,1fr)]">
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
        <div className="relative grid gap-1.5" {...dropdownKeys}>
          <Label htmlFor="qa-pn">Part number</Label>
          <Input
            id="qa-pn"
            autoComplete="off"
            value={partNumber}
            onChange={(e) => {
              setPartNumber(e.target.value);
              setTypedByUser(true);
            }}
          />
          {source === "part" && dropdown}
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
        <div className="relative grid gap-1.5" {...dropdownKeys}>
          <Label htmlFor="qa-model">Model / description</Label>
          <Input
            id="qa-model"
            ref={modelRef}
            autoFocus
            autoComplete="off"
            placeholder="e.g. Unknown ISA VGA card"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setTypedByUser(true);
            }}
          />
          {source === "model" && dropdown}
        </div>
      </div>
      {hasChipsetField && (
        <div className="relative grid gap-1.5" {...dropdownKeys}>
          <Label htmlFor="qa-chipset">Chipset</Label>
          <Input
            id="qa-chipset"
            autoComplete="off"
            placeholder={chipLookup ? "The chip on the card, e.g. TNT2 Ultra: pick it to fill in the chip's specs" : "e.g. Intel 440BX"}
            value={chipset}
            onChange={(e) => {
              setChipset(e.target.value);
              setTypedByUser(true);
              if (match) setMatch(null);
            }}
          />
          {source === "chipset" && dropdown}
        </div>
      )}
      {specFields.length > 0 && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{categoryName ? `${categoryName} specifications` : "Specifications"}</legend>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
            {specFields.map((f, i) => (
              <div key={`${effectiveCategory}:${f.name}`} className="grid gap-1">
                <Label htmlFor={`qa-spec-${i}`} className="text-xs text-muted-foreground">
                  {f.name}
                </Label>
                {f.options.length > 0 ? (
                  <OptionInput
                    id={`qa-spec-${i}`}
                    placeholder={f.hint}
                    options={f.options}
                    value={specs[specKey(f)] ?? ""}
                    onChange={(v) => setSpecs((cur) => ({ ...cur, [specKey(f)]: v }))}
                  />
                ) : (
                  <Input
                    id={`qa-spec-${i}`}
                    autoComplete="off"
                    className="h-8"
                    placeholder={f.hint}
                    value={specs[specKey(f)] ?? ""}
                    onChange={(e) => setSpecs((cur) => ({ ...cur, [specKey(f)]: e.target.value }))}
                  />
                )}
              </div>
            ))}
          </div>
        </fieldset>
      )}
      {/* One line of reserved height, so nothing here ever resizes the dialog. */}
      <div className="flex h-6 items-center gap-2 text-sm" aria-live="polite">
        {match ? (
          <>
            <span
              className="min-w-0 flex-1 truncate text-emerald-700 dark:text-emerald-300"
              title={`From the reference database: ${match.display_name} · ${match.spec_line}`}
            >
              ✓ Specs will be saved with the item{match.spec_line ? <span className="text-muted-foreground"> · {match.spec_line}</span> : null}
            </span>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Remove the match" onClick={() => setMatch(null)}>
              <X />
            </Button>
          </>
        ) : model.trim().length >= 3 && (existing.data ?? 0) > 0 ? (
          <span className="truncate text-xs text-muted-foreground">
            You already have {existing.data!.toLocaleString()} matching item{existing.data === 1 ? "" : "s"}.{" "}
            <Link className="underline" href={`/?q=${encodeURIComponent(lookup)}`} target="_blank">
              View
            </Link>
          </span>
        ) : null}
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
          <div className="flex h-5 items-center justify-between">
            <Label htmlFor="qa-position">Position</Label>
            {location && nextFree.data !== undefined && position === "" && (
              <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setPosition(String(nextFree.data))}>
                use {nextFree.data}
              </button>
            )}
          </div>
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
      <DialogFooter className="sticky bottom-0 z-10 bg-muted">
        <Button type="button" variant="outline" disabled={saving} onClick={() => void save("another")}>
          Save &amp; add another
        </Button>
        <Button type="button" variant="outline" disabled={saving} onClick={() => void save("edit")}>
          Save &amp; edit
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />} Save
        </Button>
      </DialogFooter>
    </form>
  );
}
