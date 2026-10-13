"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Plus, Save, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { LocationPicker, type PickedLocation } from "@/components/location-picker";
import { PhotoManager } from "@/components/photo-manager";
import { ReferencePanel } from "@/components/reference-panel";
import { SimpleSelect } from "@/components/simple-select";
import { ConditionBadge, ConfidenceBadge, TestStatusBadge } from "@/components/status";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import {
  CONDITIONS,
  CONFIDENCES,
  TEST_STATUSES,
  type Condition,
  type Confidence,
  type ItemDetail as Item,
  type ItemUpdate,
  type TestStatus,
} from "@/lib/types";

interface AttrRow {
  key: string;
  value: string;
}

interface Draft {
  category_id: string;
  manufacturer: string;
  model: string;
  part_number: string;
  revision: string;
  chipset_manufacturer: string;
  chipset: string;
  condition: Condition;
  test_status: TestStatus;
  test_notes: string;
  location: PickedLocation | null;
  notes: string;
  acquired_on: string;
  identification_confidence: Confidence;
  attributes: AttrRow[];
}

const text = (v: string | null) => v ?? "";
const nullable = (v: string) => v.trim() || null;

function attrToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function attrFromText(raw: string): unknown {
  const v = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("{") || v.startsWith("[")) {
    try {
      return JSON.parse(v);
    } catch {
      /* keep as text */
    }
  }
  return raw;
}

function toDraft(item: Item): Draft {
  return {
    category_id: String(item.category_id),
    manufacturer: text(item.manufacturer),
    model: item.model,
    part_number: text(item.part_number),
    revision: text(item.revision),
    chipset_manufacturer: text(item.chipset_manufacturer),
    chipset: text(item.chipset),
    condition: item.condition,
    test_status: item.test_status,
    test_notes: text(item.test_notes),
    location: item.location_id != null ? { id: item.location_id, full_name: item.location_path ?? "" } : null,
    notes: text(item.notes),
    acquired_on: text(item.acquired_on),
    identification_confidence: item.identification_confidence,
    attributes: Object.entries(item.attributes).map(([key, value]) => ({ key, value: attrToText(value) })),
  };
}

function attributesOf(rows: AttrRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) if (row.key.trim()) out[row.key.trim()] = attrFromText(row.value);
  return out;
}

/** Only the fields that differ from the saved item, as a PATCH body. */
function diff(item: Item, d: Draft): ItemUpdate {
  const patch: ItemUpdate = {};
  if (Number(d.category_id) !== item.category_id) patch.category_id = Number(d.category_id);
  if (d.model.trim() !== item.model) patch.model = d.model.trim();
  if (nullable(d.manufacturer) !== item.manufacturer) patch.manufacturer = nullable(d.manufacturer);
  if (nullable(d.part_number) !== item.part_number) patch.part_number = nullable(d.part_number);
  if (nullable(d.revision) !== item.revision) patch.revision = nullable(d.revision);
  if (nullable(d.chipset_manufacturer) !== item.chipset_manufacturer) patch.chipset_manufacturer = nullable(d.chipset_manufacturer);
  if (nullable(d.chipset) !== item.chipset) patch.chipset = nullable(d.chipset);
  if (d.condition !== item.condition) patch.condition = d.condition;
  if (d.test_status !== item.test_status) patch.test_status = d.test_status;
  if (nullable(d.test_notes) !== item.test_notes) patch.test_notes = nullable(d.test_notes);
  if ((d.location?.id ?? null) !== item.location_id) patch.location_id = d.location?.id ?? null;
  if (nullable(d.notes) !== item.notes) patch.notes = nullable(d.notes);
  if ((d.acquired_on || null) !== item.acquired_on) patch.acquired_on = d.acquired_on || null;
  if (d.identification_confidence !== item.identification_confidence) patch.identification_confidence = d.identification_confidence;
  if (JSON.stringify(attributesOf(d.attributes)) !== JSON.stringify(item.attributes)) patch.attributes = attributesOf(d.attributes);
  return patch;
}

function Field({ label, htmlFor, hint, className, children }: { label: string; htmlFor?: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`grid content-start gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ItemDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);

  const query = useQuery({
    queryKey: ["item", id],
    queryFn: () => api.item(id),
    enabled: Number.isInteger(id),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
  });

  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="space-y-3 py-16 text-center">
        <p className="text-lg font-medium">{notFound ? "Item not found" : "Could not load this item"}</p>
        {!notFound && <p className="text-sm text-muted-foreground">{query.error.message}</p>}
        <Button variant="outline" render={<Link href="/" />}>
          Back to inventory
        </Button>
      </div>
    );
  }
  if (!query.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  // Keyed on the saved revision: the form restarts from the server state
  // whenever the item is first loaded or saved.
  return <ItemEditor key={`${query.data.id}:${query.data.updated_at}`} item={query.data} />;
}

function ItemEditor({ item }: { item: Item }) {
  const id = item.id;
  const router = useRouter();
  const queryClient = useQueryClient();
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories, staleTime: 60_000 });

  const [draft, setDraft] = useState<Draft>(() => toDraft(item));
  const [confirmDelete, setConfirmDelete] = useState(false);

  const patch = diff(item, draft);
  const dirty = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: () => api.updateItem(id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(["item", id], updated);
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["manufacturers"] });
      toast.success("Saved");
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteItem(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["item", id] });
      queryClient.invalidateQueries({ queryKey: ["items"] });
      toast.success(`${item.inventory_code} deleted`);
      router.push("/");
    },
    onError: (e) => toast.error(e.message),
  });

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (dirty && !save.isPending) save.mutate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });
  const setAttr = (i: number, row: Partial<AttrRow>) =>
    set("attributes", draft.attributes.map((r, idx) => (idx === i ? { ...r, ...row } : r)));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Inventory
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">{item.inventory_code}</span>
              <span className="text-sm text-muted-foreground">· {item.category_name}</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">{[item.manufacturer, item.model].filter(Boolean).join(" ")}</h1>
            <div className="flex flex-wrap gap-1.5">
              <TestStatusBadge status={item.test_status} />
              <ConditionBadge condition={item.condition} />
              <ConfidenceBadge confidence={item.identification_confidence} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" disabled={!dirty || save.isPending} onClick={() => setDraft(toDraft(item))}>
              <Undo2 /> Revert
            </Button>
            <Button disabled={!dirty || save.isPending || !draft.model.trim()} onClick={() => save.mutate()}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
            </Button>
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="grid min-w-0 content-start gap-8">
        <form
          className="grid gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) save.mutate();
          }}
        >
          <section className="grid gap-4 sm:grid-cols-2">
            <h2 className="text-sm font-medium text-muted-foreground sm:col-span-2">Identification</h2>
            <Field label="Category" htmlFor="f-category">
              <SimpleSelect
                id="f-category"
                className="w-full"
                value={draft.category_id}
                onChange={(v) => v && set("category_id", v)}
                options={(categories.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
              />
            </Field>
            <Field label="Model / description" htmlFor="f-model">
              <Input id="f-model" value={draft.model} onChange={(e) => set("model", e.target.value)} />
            </Field>
            <Field label="Manufacturer" htmlFor="f-manufacturer" hint="Board / card / part maker">
              <Input id="f-manufacturer" value={draft.manufacturer} onChange={(e) => set("manufacturer", e.target.value)} />
            </Field>
            <Field label="Part number" htmlFor="f-pn">
              <Input id="f-pn" value={draft.part_number} onChange={(e) => set("part_number", e.target.value)} />
            </Field>
            <Field label="Revision" htmlFor="f-rev">
              <Input id="f-rev" value={draft.revision} onChange={(e) => set("revision", e.target.value)} />
            </Field>
            <Field label="Identification" htmlFor="f-conf" hint="How sure are you about the exact model?">
              <SimpleSelect
                id="f-conf"
                className="w-full"
                value={draft.identification_confidence}
                onChange={(v) => set("identification_confidence", v as Confidence)}
                options={CONFIDENCES.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }))}
              />
            </Field>
            <Field label="Chipset maker" htmlFor="f-cm" hint="e.g. NVIDIA. The chip, not the board.">
              <Input id="f-cm" value={draft.chipset_manufacturer} onChange={(e) => set("chipset_manufacturer", e.target.value)} />
            </Field>
            <Field label="Chipset" htmlFor="f-chipset" hint="e.g. RIVA TNT2 Ultra">
              <Input id="f-chipset" value={draft.chipset} onChange={(e) => set("chipset", e.target.value)} />
            </Field>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <h2 className="text-sm font-medium text-muted-foreground sm:col-span-2">Condition &amp; testing</h2>
            <Field label="Physical condition" htmlFor="f-cond" hint="Appearance only, not whether it works.">
              <SimpleSelect
                id="f-cond"
                className="w-full"
                value={draft.condition}
                onChange={(v) => set("condition", v as Condition)}
                options={CONDITIONS.map((c) => ({ value: c, label: c }))}
              />
            </Field>
            <Field label="Test status" htmlFor="f-test" hint="Unknown = cannot be determined right now; Untested = not tried yet.">
              <SimpleSelect
                id="f-test"
                className="w-full"
                value={draft.test_status}
                onChange={(v) => set("test_status", v as TestStatus)}
                options={TEST_STATUSES.map((s) => ({ value: s, label: s }))}
              />
            </Field>
            <Field label="Test notes" htmlFor="f-tnotes" className="sm:col-span-2" hint="What was tested, or why testing is blocked (e.g. “Requires Socket 8 motherboard”).">
              <Textarea id="f-tnotes" rows={2} value={draft.test_notes} onChange={(e) => set("test_notes", e.target.value)} />
            </Field>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <h2 className="text-sm font-medium text-muted-foreground sm:col-span-2">Where &amp; when</h2>
            <Field label="Location" htmlFor="f-loc">
              <LocationPicker id="f-loc" value={draft.location} onChange={(l) => set("location", l)} />
            </Field>
            <Field label="Acquired on" htmlFor="f-acq">
              <Input id="f-acq" type="date" value={draft.acquired_on} onChange={(e) => set("acquired_on", e.target.value)} />
            </Field>
            <Field label="Notes" htmlFor="f-notes" className="sm:col-span-2">
              <Textarea id="f-notes" rows={4} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
            </Field>
          </section>

          <section className="grid gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">Specifications</h2>
              <Button type="button" variant="outline" size="sm" onClick={() => set("attributes", [...draft.attributes, { key: "", value: "" }])}>
                <Plus /> Add spec
              </Button>
            </div>
            {draft.attributes.length === 0 && (
              <p className="text-sm text-muted-foreground">Your own category-specific values, e.g. Socket, Clock speed, VRAM, Bus.</p>
            )}
            {draft.attributes.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_1.5fr_auto] gap-2">
                <Input aria-label="Spec name" placeholder="Name" value={row.key} onChange={(e) => setAttr(i, { key: e.target.value })} />
                <Input aria-label="Spec value" placeholder="Value" value={row.value} onChange={(e) => setAttr(i, { value: e.target.value })} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove spec"
                  onClick={() => set("attributes", draft.attributes.filter((_, idx) => idx !== i))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </section>
          <button type="submit" className="sr-only" tabIndex={-1}>
            Save
          </button>
        </form>
        <ReferencePanel item={item} locked={dirty} />
        </div>

        <aside>
          <PhotoManager item={item} />
          <p className="mt-6 text-xs text-muted-foreground">
            Added {new Date(item.created_at).toLocaleString()} · updated {new Date(item.updated_at).toLocaleString()}
          </p>
        </aside>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {item.inventory_code}?</AlertDialogTitle>
            <AlertDialogDescription>
              “{[item.manufacturer, item.model].filter(Boolean).join(" ")}” and its {item.photos.length} photo
              {item.photos.length === 1 ? "" : "s"} will be removed permanently. The inventory code is never reused.
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
