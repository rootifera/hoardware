"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, ImagePlus, Loader2, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { formatBytes, guessKind } from "@/components/file-manager";
import { coreLabel, coreShown, refKindOf, valueLabel, visibleValues, type CoreKey } from "@/lib/category-config";
import { ScanIntoField } from "@/components/camera-scanner";
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
import { afterQuietKey } from "@/lib/scan";
import { cn } from "@/lib/utils";
import {
  CONDITIONS,
  EMPTY_FILTERS,
  FILE_KINDS,
  FILE_KIND_LABELS,
  TEST_STATUSES,
  type Condition,
  type FileKind,
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
  /** "Add another like this" of a stock item starts as a stock item too. */
  isStock?: boolean;
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
      afterQuietKey(() => open());
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
  const lookupRef = useRef<HTMLInputElement>(null);

  // Category and location are remembered between additions.
  const [remembered] = useState(readRemembered);
  const [category, setCategory] = useState(preset?.category ?? remembered.category ?? "");
  const [model, setModel] = useState(preset?.model ?? "");
  const [manufacturer, setManufacturer] = useState(preset?.manufacturer ?? "");
  const [partNumber, setPartNumber] = useState(preset?.partNumber ?? "");
  // The category's own fields (capacity, speed, chipset…): by lower-cased field name, and
  // "col:<column>" for the fields kept in item columns (chipset maker, chipset, revision).
  const [specs, setSpecs] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(Object.entries(preset?.specs ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    ...(preset?.chipset ? { "col:chipset": preset.chipset } : {}),
  }));
  const [condition, setCondition] = useState<Condition>("Unknown");
  const [testStatus, setTestStatus] = useState<TestStatus>("Untested");
  const [location, setLocation] = useState<PickedLocation | null>(preset?.location ?? remembered.location ?? null);
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(false);
  // The original barcode from the packaging, if the item has one. Without it labels use the item's own code.
  const [barcode, setBarcode] = useState("");
  const [showBarcode, setShowBarcode] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  // Manuals, drivers, tools…: each keeps the kind guessed from its name until changed.
  const [attachments, setAttachments] = useState<{ file: File; kind: FileKind }[]>([]);
  const [copies, setCopies] = useState(1);
  // "Several separate items" is a rarely used shortcut: it stays folded away until asked for.
  const [several, setSeveral] = useState(false);
  // How many you have, for categories that keep a quantity instead of one record per piece.
  const [quantity, setQuantity] = useState("1");
  const [position, setPosition] = useState("");
  // A reference record picked from the database lookup (CPU and graphics categories).
  const [match, setMatch] = useState<ReferenceSummary | null>(null);
  const [lookupText, setLookupText] = useState("");
  // The result list is closed (Esc, or focus left the box) for this text; typing again reopens it.
  const [closedFor, setClosedFor] = useState<string | null>(null);
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

  const categoryOptions = (categories.data ?? []).map((c) => ({ value: String(c.id), label: c.name }));
  // Fall back to the first category when nothing (valid) is remembered: the id saved from an
  // earlier session may no longer exist. Everything below must use this one, not the raw state.
  const effectiveCategory = categoryOptions.some((o) => o.value === category) ? category : (categoryOptions[0]?.value ?? "");
  const currentCategory = (categories.data ?? []).find((c) => String(c.id) === effectiveCategory);
  const categoryName = currentCategory?.name ?? "";
  // The category decides which standard fields this form shows and what they are called.
  const shown = (k: CoreKey) => coreShown(currentCategory, k);
  // "Track as stock": counted items (take out / add). Starts as the category's default; ticking it overrides.
  const [stockOverride, setStockOverride] = useState<boolean | null>(preset?.isStock ? true : null);
  const isStock = stockOverride ?? coreShown(currentCategory, "stock");
  const label = (k: CoreKey, fallback: string) => coreLabel(currentCategory, k, fallback);
  const specFields = (categories.data ?? []).find((c) => String(c.id) === effectiveCategory)?.fields ?? [];
  const specKey = (f: { name: string; column: string | null }) => (f.column ? `col:${f.column}` : f.name.toLowerCase());

  // The one box that searches an imported reference database. It exists only for categories
  // that have one (CPUs, graphics cards) and only when a dataset has been imported.
  // Nothing in the form changes until a result is picked.
  const refKind = refKindOf(categoryName);
  const sources = useQuery({ queryKey: ["reference-sources"], queryFn: api.referenceSources, staleTime: 60_000 });
  const SOURCE_KIND: Record<string, string> = { "cpu-db": "cpu", "gpus-specs": "gpu", "pci-ids": "pci" };
  const hasDataset = (sources.data ?? []).some((x) => x.models > 0 && SOURCE_KIND[x.key] === refKind);
  const lookupAvailable = refKind !== null && hasDataset;
  const typed = useDebouncedValue(lookupText.trim(), 250);
  const wantsResults = lookupAvailable && match === null && typed.length >= 2 && lookupText.trim().length >= 2;
  const results = useQuery({
    queryKey: ["reference-suggestions", typed, refKind],
    queryFn: () => api.referenceSuggestions(typed, refKind),
    enabled: wantsResults,
  });
  const offered = results.data ?? [];
  const listOpen = wantsResults && offered.length > 0 && closedFor !== typed;
  const noResults = wantsResults && results.isSuccess && typed === lookupText.trim() && offered.length === 0;

  // Start in the lookup box when there is one. This must never take focus from a field the
  // person is already using: the box can appear a moment after the dialog opens (the datasets
  // are still loading), and pulling focus then would send half of what they type to the wrong place.
  const touched = useRef(false);
  useEffect(() => {
    if (!lookupAvailable || touched.current) return;
    const active = document.activeElement;
    const typingSomewhere = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    if (!typingSomewhere) lookupRef.current?.focus();
  }, [lookupAvailable]);

  function pick(c: ReferenceCandidate) {
    const r = c.reference;
    const was = lookupText.trim().toLowerCase();
    setMatch(r);
    setLookupText("");
    // Show what the match adds in the form itself, filling only what is still empty.
    void api
      .referenceSnapshot(r.id)
      .then((snap) =>
        setSpecs((cur) => {
          const next = { ...cur };
          for (const [name, value] of Object.entries(snap.specs)) if (!next[name.toLowerCase()]?.trim()) next[name.toLowerCase()] = value;
          for (const [column, value] of Object.entries(snap.columns)) if (!next[`col:${column}`]?.trim()) next[`col:${column}`] = value;
          return next;
        }),
      )
      .catch(() => {});
    // A graphics record names the chip's vendor, which may not be who made the card: it only
    // fills an empty manufacturer, and never the model (the card keeps its own name).
    // A CPU's maker is the record's.
    if (r.manufacturer && (r.kind === "cpu" || manufacturer.trim() === "")) setManufacturer(r.manufacturer);
    // The part number is the order code (or a graphics board number); the S-Spec is saved as its own spec.
    if (r.kind !== "pci" && r.part_number && (r.kind === "cpu" ? partNumber.trim() === "" || partNumber.trim().toLowerCase() === was : partNumber.trim() === "")) {
      setPartNumber(r.order_code ?? r.part_number);
    }
    if (r.kind === "cpu") {
      // Use the proper name unless the user wrote a real name of their own.
      const current = model.trim().toLowerCase();
      const onlyTheCode = current === "" || current === was || (r.part_number ?? "").toLowerCase().includes(current);
      if (onlyTheCode) setModel(r.display_name);
    }
  }

  async function save(mode: "close" | "edit" | "another") {
    if (saving) return;
    if (!effectiveCategory) return setError("Choose a category.");
    if (!model.trim()) {
      setError(`Fill in the ${label("model", "model / description").toLowerCase()}.`);
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
        condition,
        test_status: testStatus,
        notes: notes.trim() || null,
        ...(barcode.trim() ? { barcode: barcode.trim() } : {}),
        ...(isStock ? { is_stock: true, quantity: Number(quantity.trim() === "" ? "1" : quantity) } : {}),
      };
      if (isStock && (!Number.isInteger(fields.quantity) || (fields.quantity ?? 0) < 0)) {
        setSaving(false);
        return setError(`${label("stock", "Quantity")} must be a whole number, 0 or more.`);
      }
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
      // Several items are separate records (own code, condition, test status),
      // at consecutive positions when a start position is given.
      const matched = match ? { reference_model_id: match.id, identification_confidence: "candidate" as const } : {};
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
      // The item is saved either way. A failed upload must not go unnoticed, so it gets its own
      // lasting message saying what failed and why.
      const problems: string[] = [];
      const reason = (e: unknown) => (e instanceof Error ? e.message : "upload error");
      if (item && files.length) {
        try {
          await api.uploadPhotos(item.id, files);
        } catch (e) {
          problems.push(`the photo${files.length === 1 ? "" : "s"} could not be uploaded (${reason(e)})`);
        }
      }
      if (item && attachments.length) {
        try {
          // One request per kind, so every file keeps its own.
          for (const kind of FILE_KINDS) {
            const group = attachments.filter((a) => a.kind === kind).map((a) => a.file);
            if (group.length) await api.uploadFiles(item.id, group, kind);
          }
        } catch (e) {
          problems.push(`the file${attachments.length === 1 ? "" : "s"} could not be uploaded (${reason(e)})`);
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
          </span>
        ),
      );
      if (item && problems.length) {
        toast.error(
          <span>
            {item.inventory_code} was saved, but {problems.join(", and ")}. Add {problems.length > 1 ? "them" : "it"} from the item page.
          </span>,
          { duration: 30000 },
        );
      }
      if (mode === "another") {
        setModel("");
        setPartNumber("");
        setSpecs({});
        setNotes("");
        setShowNotes(false);
        setBarcode("");
        setShowBarcode(false);
        setFiles([]);
        setAttachments([]);
        setMatch(null);
        setLookupText("");
        // Carry on from the next free spot.
        if (start !== null) setPosition(String(start + copies));
        setCopies(1);
        setSeveral(false);
        setQuantity("1");
        setStockOverride(null);
        (lookupAvailable ? lookupRef : modelRef).current?.focus();
      } else {
        onClose();
        // Several items have no single page to open.
        if (mode === "edit" && item) router.push(`/items/${item.id}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the item.");
    } finally {
      setSaving(false);
    }
  }

  const sourceName = refKind === "gpu" ? "graphics chip database" : refKind === "pci" ? "PCI ID list" : "CPU database";
  const results_ = listOpen && (
    <div
      role="group"
      aria-label="Suggestions"
      className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg"
    >
      <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
        {refKind === "gpu"
          ? "Pick the chip: it fills in the chipset and its specs. Your card's own name stays as typed."
          : refKind === "pci"
            ? "Pick the chip: it adds its PCI ID. Your card's own name stays as typed."
            : "Pick one to fill in the maker, name and specs."}
      </p>
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
                {c.reference.kind === "gpu" || c.reference.kind === "pci" ? c.reference.part_number : (c.reference.order_code ?? c.reference.part_number ?? c.reference.model)}
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
  // Esc closes just the result list; the arrow key moves from the box into it; leaving it closes it.
  const listKeys = {
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
      onKeyDownCapture={() => {
        touched.current = true;
      }}
      onChangeCapture={() => {
        touched.current = true;
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void save("close");
      }}
    >
      <div className={cn("grid gap-4", shown("part_number") && "sm:grid-cols-[11rem_minmax(0,1fr)]")}>
        <div className="grid gap-1.5">
          <Label htmlFor="qa-category">Category</Label>
          <SimpleSelect
            id="qa-category"
            className="w-full"
            value={effectiveCategory}
            onChange={(v) => {
              setCategory(v);
              setMatch(null);
              setLookupText("");
            }}
            options={categoryOptions}
            placeholder="Category"
          />
        </div>
        {shown("part_number") && (
          <div className="grid gap-1.5">
            <Label htmlFor="qa-pn">{label("part_number", "Part number")}</Label>
            <Input id="qa-pn" autoComplete="off" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} />
          </div>
        )}
      </div>

      {lookupAvailable && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5 rounded-lg border bg-muted/40 p-3" {...listKeys}>
          <Label htmlFor="qa-lookup" className="gap-1.5">
            <Search className="size-3.5" /> Look up in the {sourceName}
          </Label>
          <div className="relative">
            {match ? (
              <div className="flex h-9 items-center gap-2 rounded-lg border border-emerald-600/40 bg-background px-2.5 text-sm" aria-live="polite">
                <span
                  className="min-w-0 flex-1 truncate"
                  title={`${[match.manufacturer, match.display_name].filter(Boolean).join(" ")} · ${match.spec_line}`}
                >
                  <span className="text-emerald-700 dark:text-emerald-300">✓ </span>
                  <span className="font-medium">{[match.manufacturer, match.display_name].filter(Boolean).join(" ")}</span>
                  {match.spec_line ? <span className="text-muted-foreground"> · {match.spec_line}</span> : null}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Remove the match"
                  onClick={() => {
                    setMatch(null);
                    setTimeout(() => lookupRef.current?.focus(), 0);
                  }}
                >
                  <X />
                </Button>
              </div>
            ) : (
              <Input
                id="qa-lookup"
                ref={lookupRef}
                className="h-9"
                autoComplete="off"
                placeholder={
                  refKind === "gpu" ? "Chip or card name, e.g. TNT2 Ultra, Voodoo3 3000, Rage Pro" : refKind === "pci" ? "PCI ID or chip name, e.g. 1102:0002, EMU10k1, RTL8139" : "S-Spec, part number or name, e.g. SL32A, Celeron 300A"
                }
                value={lookupText}
                onChange={(e) => setLookupText(e.target.value)}
              />
            )}
            {results_}
          </div>
          <p className="text-xs text-muted-foreground">
            {match
              ? "Its specs are filled in below and saved with the item. Everything stays editable."
              : noResults
                ? "Nothing found. You can fill the details in by hand."
                : refKind === "gpu" || refKind === "pci"
                  ? "Finds the chip on the card and fills its specs. Nothing changes until you pick a result."
                  : "Fills in the maker, name and specs. Nothing changes until you pick a result."}
          </p>
        </div>
      )}

      <div className={cn("grid gap-4", shown("manufacturer") && "sm:grid-cols-2")}>
        {shown("manufacturer") && (
          <div className="grid gap-1.5">
            <div className="flex h-[1.125rem] items-center">
              <Label htmlFor="qa-manufacturer">{label("manufacturer", "Manufacturer")}</Label>
            </div>
            <Input id="qa-manufacturer" autoComplete="off" value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
          </div>
        )}
        <div className="grid gap-1.5">
          <div className="flex h-[1.125rem] items-center justify-between gap-2">
            <Label htmlFor="qa-model">{label("model", "Model / description")}</Label>
            {model.trim().length >= 3 && (existing.data ?? 0) > 0 && (
              <span className="truncate text-xs text-muted-foreground">
                You already have {existing.data!.toLocaleString()} ·{" "}
                <Link className="underline" href={`/?q=${encodeURIComponent(lookup)}`} target="_blank">
                  view
                </Link>
              </span>
            )}
          </div>
          <Input
            id="qa-model"
            ref={modelRef}
            autoFocus={!lookupAvailable}
            autoComplete="off"
            placeholder={refKind ? "e.g. Unknown ISA VGA card" : "What is it?"}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
      </div>

      {specFields.length > 0 && (
        <fieldset className="grid gap-2 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{categoryName ? `${categoryName} specifications` : "Specifications"}</legend>
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

      {isStock && (
        <div className="grid gap-1.5 sm:w-40">
          <Label htmlFor="qa-quantity">{label("stock", "Quantity")}</Label>
          <Input id="qa-quantity" type="number" min={0} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
      )}
      {(shown("condition") || shown("test_status")) && (
        <div className={cn("grid gap-4", shown("condition") && shown("test_status") && "sm:grid-cols-2")}>
          {shown("condition") && (
            <div className="grid gap-1.5">
              <Label htmlFor="qa-condition">{label("condition", "Condition")}</Label>
              <SimpleSelect
                id="qa-condition"
                className="w-full"
                value={condition}
                onChange={(v) => setCondition(v as Condition)}
                options={visibleValues(currentCategory, "condition", CONDITIONS, condition).map((c) => ({ value: c, label: valueLabel(currentCategory, "condition", c) }))}
              />
            </div>
          )}
          {shown("test_status") && (
            <div className="grid gap-1.5">
              <Label htmlFor="qa-test">{label("test_status", "Test status")}</Label>
              <SimpleSelect
                id="qa-test"
                className="w-full"
                value={testStatus}
                onChange={(v) => setTestStatus(v as TestStatus)}
                options={visibleValues(currentCategory, "test_status", TEST_STATUSES, testStatus).map((s) => ({ value: s, label: valueLabel(currentCategory, "test_status", s) }))}
              />
            </div>
          )}
        </div>
      )}
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
          <div className="flex h-[1.125rem] items-center justify-between">
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

      {/* The rarely needed extras share one quiet row. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4">
        <label className="flex cursor-pointer items-center gap-2 text-sm" title="Count how many you have; take out and add later">
          <input type="checkbox" className="size-4 accent-primary" checked={isStock} onChange={(e) => {
              setStockOverride(e.target.checked);
              if (e.target.checked) {
                setSeveral(false);
                setCopies(1);
              }
            }}
          />
          Track as stock
        </label>
        {/* A stock item is one record that says "100 of them", so several separate items is not offered. */}
        {!isStock &&
          (several ? (
            <div className="flex items-center gap-2">
              <Label htmlFor="qa-copies">Number of items</Label>
              <Input
                id="qa-copies"
                type="number"
                min={1}
                max={200}
                className="w-16"
                value={copies}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(200, Number(e.target.value) || 1));
                  setCopies(n);
                  // Several items cannot share one photo or file upload: it is added to each afterwards.
                  if (n > 1) {
                    setFiles([]);
                    setAttachments([]);
                  }
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Add just one item"
                onClick={() => {
                  setSeveral(false);
                  setCopies(1);
                }}
              >
                <X />
              </Button>
            </div>
          ) : (
            <Button type="button" variant="ghost" size="sm" title="Create several identical items at once, each with its own code and position" onClick={() => setSeveral(true)}>
              <Plus /> Add several separate items…
            </Button>
          ))}
        <Button type="button" variant="ghost" size="sm" disabled={copies > 1} render={<label htmlFor="qa-photos" className="cursor-pointer" />}>
          <ImagePlus /> {files.length ? `${files.length} photo${files.length === 1 ? "" : "s"}` : "Add photos"}
        </Button>
        <input
          id="qa-photos"
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          className="sr-only"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <Button type="button" variant="ghost" size="sm" disabled={copies > 1} render={<label htmlFor="qa-files" className="cursor-pointer" />}>
          <FileUp /> Add files
        </Button>
        <input
          id="qa-files"
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []).map((file) => ({ file, kind: guessKind(file.name) }));
            setAttachments((cur) => [...cur, ...picked]);
            e.target.value = "";
          }}
        />
        {shown("barcode") && !showBarcode && !barcode && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowBarcode(true)} title="The original barcode from the packaging. Without one, labels use the item's own code">
            <Plus /> Add {label("barcode", "Barcode").toLowerCase()}
          </Button>
        )}
        {shown("notes") && !showNotes && !notes && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowNotes(true)}>
            <Plus /> Add {label("notes", "Notes").toLowerCase()}
          </Button>
        )}
        <span className="min-w-0 text-xs text-muted-foreground">
          {copies > 1
            ? position.trim() !== "" && Number.isInteger(Number(position))
              ? `${copies} separate items at positions ${position}–${Number(position) + copies - 1}. Add photos and files to each afterwards.`
              : `${copies} separate items, each with its own code. Add photos and files to each afterwards.`
            : ""}
        </span>
      </div>
      {attachments.length > 0 && (
        <ul className="grid gap-1.5" aria-label="Files to attach">
          {attachments.map((a, i) => (
            <li key={`${a.file.name}:${i}`} className="grid grid-cols-[minmax(0,1fr)_9.5rem_auto] items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-medium">{a.file.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(a.file.size)}</span>
              </span>
              <SimpleSelect
                size="sm"
                className="w-full"
                aria-label={`Kind of ${a.file.name}`}
                value={a.kind}
                onChange={(kind) => setAttachments((cur) => cur.map((x, idx) => (idx === i ? { ...x, kind: kind as FileKind } : x)))}
                options={FILE_KINDS.map((k) => ({ value: k, label: FILE_KIND_LABELS[k] }))}
              />
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${a.file.name}`} onClick={() => setAttachments((cur) => cur.filter((_, idx) => idx !== i))}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {shown("barcode") && (showBarcode || barcode) && (
        <div className="grid gap-1.5">
          <Label htmlFor="qa-barcode">{label("barcode", "Barcode")}</Label>
          <div className="flex gap-2">
            <Input
              id="qa-barcode"
              autoComplete="off"
              autoFocus={showBarcode && !barcode}
              placeholder="Scan or type the barcode from the packaging"
              maxLength={100}
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              // A scanner ends the code with Enter: that must not save the item.
              onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
            />
            <ScanIntoField onResult={(text) => setBarcode(text.slice(0, 100))} />
          </div>
          <p className="text-xs text-muted-foreground">Optional. Without one, labels and scans use the item&apos;s own code.</p>
        </div>
      )}
      {shown("notes") && (showNotes || notes) && (
        <div className="grid gap-1.5">
          <Label htmlFor="qa-notes">{label("notes", "Notes")}</Label>
          <Textarea id="qa-notes" rows={2} autoFocus={showNotes && !notes} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter className="sticky bottom-0 z-10 mt-5 bg-muted shadow-[0_-10px_12px_-10px_rgba(0,0,0,0.35)]">
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
