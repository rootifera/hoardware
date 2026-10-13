"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, ExternalLink, Loader2, MoreHorizontal, Plus, Save, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { LocationPicker, type PickedLocation } from "@/components/location-picker";
import { FileManager } from "@/components/file-manager";
import { PhotoManager } from "@/components/photo-manager";
import { useQuickAdd } from "@/components/quick-add";
import { ReferencePanel } from "@/components/reference-panel";
import { SimpleSelect } from "@/components/simple-select";
import { ConditionBadge, ConfidenceBadge, TestStatusBadge } from "@/components/status";
import { TestHistory } from "@/components/test-history";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
  type CategoryField,
  type ItemDetail as Item,
  type ItemUpdate,
  type TestStatus,
} from "@/lib/types";

/** One of the item's own specs, in the order it is stored. */
interface SpecRow {
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
  order: string; // position inside the location; "" = none
  notes: string;
  acquired_on: string;
  verified_on: string;
  identification_confidence: Confidence;
  specs: SpecRow[];
}

// Where a spec came from is shown as a source line, not as an editable field.
const PROVENANCE_KEYS = new Set(["source", "source link"]);

const text = (v: string | null) => v ?? "";
const nullable = (v: string) => v.trim() || null;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
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
    order: item.order !== null ? String(item.order) : "",
    notes: text(item.notes),
    acquired_on: text(item.acquired_on),
    verified_on: text(item.verified_on),
    identification_confidence: item.identification_confidence,
    specs: Object.entries(item.attributes).map(([key, value]) => ({ key, value: asText(value) })),
  };
}

/** The specs as stored: text values, blanks dropped. */
function specsObject(rows: SpecRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) if (row.key.trim() && row.value.trim()) out[row.key.trim()] = row.value;
  return out;
}

function canonical(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== null && asText(v).trim() !== "")
    .map(([k, v]) => [k, asText(v)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
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
  const order = d.order.trim() === "" ? null : Number(d.order);
  if (order !== item.order) patch.order = order;
  if (nullable(d.notes) !== item.notes) patch.notes = nullable(d.notes);
  if ((d.acquired_on || null) !== item.acquired_on) patch.acquired_on = d.acquired_on || null;
  if ((d.verified_on || null) !== item.verified_on) patch.verified_on = d.verified_on || null;
  if (d.identification_confidence !== item.identification_confidence) patch.identification_confidence = d.identification_confidence;
  if (canonical(specsObject(d.specs)) !== canonical(item.attributes)) patch.attributes = specsObject(d.specs);
  return patch;
}

function Field({ label, htmlFor, hint, className, children }: { label: string; htmlFor?: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`grid content-start gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </Label>
      {children}
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A titled card. The page is a stack of these so each topic reads on its own. */
function Section({ title, description, action, children }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-5 sm:p-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
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
  const [focusedSpec, setFocusedSpec] = useState<string | null>(null);
  const { open: openQuickAdd } = useQuickAdd();

  // The fields this category is described with (a CPU: speed, bus, cache…).
  const category = (categories.data ?? []).find((c) => String(c.id) === draft.category_id);
  const profile: CategoryField[] = category?.fields ?? [];
  const profileNames = new Set(profile.filter((f) => !f.column).map((f) => f.name.toLowerCase()));

  // Values already used for the spec being edited, as suggestions.
  const suggestions = useQuery({
    queryKey: ["attribute-values", focusedSpec, draft.category_id],
    queryFn: () => api.attributeValues(focusedSpec!, Number(draft.category_id)),
    enabled: focusedSpec !== null,
    staleTime: 60_000,
  });
  // Spec names used elsewhere in this category, for the "other specs" names.
  const attributeKeys = useQuery({
    queryKey: ["attribute-keys", draft.category_id],
    queryFn: () => api.attributeKeys(Number(draft.category_id)),
    staleTime: 60_000,
  });
  // Suggestion for the position field: the next free spot in the chosen location.
  const nextFree = useQuery({
    queryKey: ["next-position", draft.location?.id],
    queryFn: () => api.nextPosition(draft.location!.id),
    enabled: draft.location !== null,
  });

  const patch = diff(item, draft);
  const dirty = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: () => api.updateItem(id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(["item", id], updated);
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["test-log", id] }); // a status change adds an entry
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

  // --- specs: profile fields read and write rows by name (case-insensitive) ----
  const specIndex = (name: string) => draft.specs.findIndex((r) => same(r.key, name));
  const specValue = (name: string) => draft.specs[specIndex(name)]?.value ?? "";
  const setSpec = (name: string, value: string) => {
    const i = specIndex(name);
    set("specs", i >= 0 ? draft.specs.map((r, idx) => (idx === i ? { ...r, value } : r)) : [...draft.specs, { key: name, value }]);
  };
  const extras = draft.specs
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !profileNames.has(row.key.trim().toLowerCase()) && !PROVENANCE_KEYS.has(row.key.trim().toLowerCase()));
  const sourceName = draft.specs.find((r) => same(r.key, "Source"))?.value;
  const sourceLink = draft.specs.find((r) => same(r.key, "Source link"))?.value;
  const columnValue = (c: NonNullable<CategoryField["column"]>) => draft[c];
  // Column-backed fields (chipset, revision) show when the category has them,
  // or when the item already has a value, so nothing is ever hidden.
  const extraColumns = (["chipset_manufacturer", "chipset", "revision"] as const).filter(
    (c) => !profile.some((f) => f.column === c) && columnValue(c).trim() !== "",
  );
  const columnLabels = { chipset_manufacturer: "Chipset maker", chipset: "Chipset", revision: "Revision" } as const;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Inventory
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <p className="text-sm text-muted-foreground">
              <span className="font-mono">{item.inventory_code}</span> · {item.category_name}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">{[item.manufacturer, item.model].filter(Boolean).join(" ")}</h1>
            {item.spec_line && <p className="text-base text-muted-foreground">{item.spec_line}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <TestStatusBadge status={item.test_status} />
              <ConditionBadge condition={item.condition} />
              <ConfidenceBadge confidence={item.identification_confidence} />
              <span className="pl-1 text-sm text-muted-foreground">
                {item.last_tested_on ? `Last tested ${item.last_tested_on}` : "No test logged yet"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {dirty && (
              <Button variant="ghost" disabled={save.isPending} onClick={() => setDraft(toDraft(item))}>
                <Undo2 /> Revert
              </Button>
            )}
            <Button disabled={!dirty || save.isPending || !draft.model.trim()} onClick={() => save.mutate()}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="More actions" />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() =>
                    openQuickAdd({
                      category: String(item.category_id),
                      model: item.model,
                      manufacturer: item.manufacturer ?? "",
                      partNumber: item.part_number ?? "",
                      location: item.location_id != null ? { id: item.location_id, full_name: item.location_path ?? "" } : undefined,
                    })
                  }
                >
                  <Copy /> Add another like this
                </DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onClick={() => setConfirmDelete(true)}>
                  <Trash2 /> Delete this item
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="grid min-w-0 content-start gap-6">
          <form
            className="grid gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty) save.mutate();
            }}
          >
            <Section title="Overview">
              <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                <Field label="Category" htmlFor="f-category">
                  <SimpleSelect
                    id="f-category"
                    className="w-full"
                    value={draft.category_id}
                    onChange={(v) => v && set("category_id", v)}
                    options={(categories.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
                  />
                </Field>
                <Field label="Manufacturer" htmlFor="f-manufacturer">
                  <Input id="f-manufacturer" value={draft.manufacturer} onChange={(e) => set("manufacturer", e.target.value)} />
                </Field>
                <Field label="Model / description" htmlFor="f-model" className="sm:col-span-2">
                  <Input id="f-model" value={draft.model} onChange={(e) => set("model", e.target.value)} />
                </Field>
                <Field label="Part number" htmlFor="f-pn">
                  <Input id="f-pn" placeholder="order / part number" value={draft.part_number} onChange={(e) => set("part_number", e.target.value)} />
                </Field>
                <Field label="How sure are you of the exact model?" htmlFor="f-conf">
                  <SimpleSelect
                    id="f-conf"
                    className="w-full"
                    value={draft.identification_confidence}
                    onChange={(v) => set("identification_confidence", v as Confidence)}
                    options={CONFIDENCES.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }))}
                  />
                </Field>
                <Field label="Notes" htmlFor="f-notes" className="sm:col-span-2">
                  <Textarea id="f-notes" rows={3} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
                </Field>
              </div>
            </Section>

            <Section
              title={`${category?.name ?? "Item"} specifications`}
              description={profile.length ? undefined : "No fields are set up for this category yet. Add them under Categories, or add specs below."}
            >
              {(profile.length > 0 || extraColumns.length > 0) && (
                <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
                  {profile.map((f) => {
                    const inputId = `spec-${f.name.replace(/\W+/g, "-").toLowerCase()}`;
                    return (
                      <Field key={f.name} label={f.name} htmlFor={inputId}>
                        {f.column ? (
                          <Input
                            id={inputId}
                            placeholder={f.hint}
                            value={columnValue(f.column)}
                            onChange={(e) => set(f.column!, e.target.value)}
                          />
                        ) : (
                          <Input
                            id={inputId}
                            placeholder={f.hint}
                            list="spec-value-suggestions"
                            value={specValue(f.name)}
                            onFocus={() => setFocusedSpec(f.name)}
                            onChange={(e) => setSpec(f.name, e.target.value)}
                          />
                        )}
                      </Field>
                    );
                  })}
                  {extraColumns.map((c) => (
                    <Field key={c} label={columnLabels[c]} htmlFor={`spec-col-${c}`}>
                      <Input id={`spec-col-${c}`} value={columnValue(c)} onChange={(e) => set(c, e.target.value)} />
                    </Field>
                  ))}
                </div>
              )}
              <datalist id="spec-value-suggestions">
                {(suggestions.data ?? []).map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>

              {extras.length > 0 && (
                <div className="mt-6 border-t pt-5">
                  <h3 className="mb-3 text-sm font-medium">Other specs</h3>
                  <div className="grid gap-2.5">
                    {extras.map(({ row, index }) => (
                      <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] gap-2">
                        <Input
                          aria-label="Spec name"
                          placeholder="Name"
                          list="attribute-key-suggestions"
                          value={row.key}
                          onChange={(e) => set("specs", draft.specs.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))}
                        />
                        <Input
                          aria-label="Spec value"
                          placeholder="Value"
                          value={row.value}
                          onChange={(e) => set("specs", draft.specs.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Remove spec"
                          onClick={() => set("specs", draft.specs.filter((_, i) => i !== index))}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <datalist id="attribute-key-suggestions">
                {(attributeKeys.data ?? [])
                  .filter((k) => !profileNames.has(k.toLowerCase()))
                  .map((k) => (
                    <option key={k} value={k} />
                  ))}
              </datalist>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <Button type="button" variant="outline" size="sm" onClick={() => set("specs", [...draft.specs, { key: "", value: "" }])}>
                  <Plus /> Add another spec
                </Button>
                {(sourceName || sourceLink) && (
                  <p className="text-sm text-muted-foreground">
                    Source: {sourceName ?? "dataset"}
                    {sourceLink && /^https?:\/\//.test(sourceLink) && (
                      <>
                        {" "}
                        <a className="inline-flex items-center gap-1 underline" href={sourceLink} target="_blank" rel="noopener noreferrer">
                          details <ExternalLink className="size-3" />
                        </a>
                      </>
                    )}
                  </p>
                )}
              </div>
            </Section>

            <Section title="Condition &amp; testing" description="Condition is how it looks. Test status is whether it works.">
              <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                <Field label="Physical condition" htmlFor="f-cond">
                  <SimpleSelect
                    id="f-cond"
                    className="w-full"
                    value={draft.condition}
                    onChange={(v) => set("condition", v as Condition)}
                    options={CONDITIONS.map((c) => ({ value: c, label: c }))}
                  />
                </Field>
                <Field label="Test status" htmlFor="f-test">
                  <SimpleSelect
                    id="f-test"
                    className="w-full"
                    value={draft.test_status}
                    onChange={(v) => set("test_status", v as TestStatus)}
                    options={TEST_STATUSES.map((s) => ({ value: s, label: s }))}
                  />
                </Field>
                <Field
                  label="Test notes"
                  htmlFor="f-tnotes"
                  className="sm:col-span-2"
                  hint="What was tested, or why testing is blocked. “Unknown” means it cannot be tested right now; “Untested” means not tried yet."
                >
                  <Textarea id="f-tnotes" rows={2} value={draft.test_notes} onChange={(e) => set("test_notes", e.target.value)} />
                </Field>
              </div>
            </Section>

            <Section title="Where it is">
              <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                <Field label="Location" htmlFor="f-loc">
                  <LocationPicker
                    id="f-loc"
                    value={draft.location}
                    // A position belongs to its location, so a different location starts without one.
                    onChange={(l) => setDraft({ ...draft, location: l, order: l?.id === draft.location?.id ? draft.order : "" })}
                  />
                </Field>
                <Field label="Position" htmlFor="f-order" hint={draft.location ? "The exact spot inside the location. Two items cannot share one." : undefined}>
                  <Input
                    id="f-order"
                    type="number"
                    min={0}
                    disabled={!draft.location}
                    placeholder={nextFree.data !== undefined ? `next free: ${nextFree.data}` : "none"}
                    value={draft.order}
                    onChange={(e) => set("order", e.target.value)}
                  />
                </Field>
                <Field label="Acquired on" htmlFor="f-acq">
                  <Input id="f-acq" type="date" value={draft.acquired_on} onChange={(e) => set("acquired_on", e.target.value)} />
                </Field>
                <Field label="Last verified" htmlFor="f-ver" hint="When you last saw it in place.">
                  <div className="flex gap-2">
                    <Input id="f-ver" type="date" value={draft.verified_on} onChange={(e) => set("verified_on", e.target.value)} />
                    <Button type="button" variant="outline" onClick={() => set("verified_on", new Date().toLocaleDateString("en-CA"))}>
                      Today
                    </Button>
                  </div>
                </Field>
              </div>
            </Section>
            <button type="submit" className="sr-only" tabIndex={-1}>
              Save
            </button>
          </form>

          <Section title="Downloads" description="Manuals, drivers, firmware, tools and anything else that goes with this item.">
            <FileManager item={item} />
          </Section>

          <TestHistory item={item} locked={dirty} />
          <ReferencePanel item={item} locked={dirty} />
        </div>

        <aside className="grid content-start gap-6 lg:sticky lg:top-20">
          <Section title="Photos">
            <PhotoManager item={item} />
          </Section>
          <p className="px-1 text-sm text-muted-foreground">
            Added {new Date(item.created_at).toLocaleString()}
            <br />
            Updated {new Date(item.updated_at).toLocaleString()}
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
