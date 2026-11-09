"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { CORE_FIELDS, defaultShown, type CoreKey } from "@/lib/category-config";
import { CONDITIONS, TEST_STATUSES, type Category, type CategoryField, type CategorySettings } from "@/lib/types";

const COLUMN_FIELDS: { column: NonNullable<CategoryField["column"]>; name: string; hint: string }[] = [
  { column: "chipset_manufacturer", name: "Chipset maker", hint: "e.g. NVIDIA" },
  { column: "chipset", name: "Chipset", hint: "e.g. RIVA TNT2 Ultra" },
  { column: "revision", name: "Revision", hint: "board revision" },
];

/** Drop empty names and settings that just say "the default", so only real choices are stored. */
function tidy(settings: CategorySettings): CategorySettings {
  const core: CategorySettings["core"] = {};
  for (const [key, value] of Object.entries(settings.core)) {
    const label = value.label?.trim();
    const differs = value.show != null && value.show !== defaultShown(key as CoreKey);
    const entry = { ...(differs ? { show: value.show } : {}), ...(label ? { label } : {}) };
    if (Object.keys(entry).length) core[key] = entry;
  }
  const values: CategorySettings["values"] = {};
  for (const [kind, names] of Object.entries(settings.values)) {
    const kept = Object.fromEntries(Object.entries(names).filter(([, name]) => name.trim()).map(([stored, name]) => [stored, name.trim()]));
    if (Object.keys(kept).length) values[kind] = kept;
  }
  const hidden: NonNullable<CategorySettings["hidden"]> = {};
  for (const [kind, stored] of Object.entries(settings.hidden ?? {})) if (stored.length) hidden[kind] = stored;
  return { core, values, hidden };
}

/** Edit which fields items of one category are described with. */
export function CategoryFieldsDialog({ category, onClose }: { category: Category | null; onClose: () => void }) {
  return (
    <Dialog open={category !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        {category && <FieldsForm key={category.id} category={category} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function FieldsForm({ category, onClose }: { category: Category; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<CategoryField[]>(category.fields);
  const [settings, setSettings] = useState<CategorySettings>({
    core: category.settings?.core ?? {},
    values: category.settings?.values ?? {},
    hidden: category.settings?.hidden ?? {},
  });
  const [tab, setTab] = useState<"specs" | "details">("specs");

  const save = useMutation({
    mutationFn: () =>
      api.updateCategory(category.id, {
        fields: fields.filter((f) => f.name.trim()).map((f) => ({ ...f, name: f.name.trim() })),
        settings: tidy(settings),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast.success(`${category.name} fields saved`);
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const update = (index: number, patch: Partial<CategoryField>) => setFields(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  const move = (index: number, by: number) => {
    const next = [...fields];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    setFields(next);
  };
  const setCore = (key: CoreKey, patch: { show?: boolean; label?: string }) =>
    setSettings((cur) => {
      const merged = { ...(cur.core[key] ?? {}), ...patch };
      return { ...cur, core: { ...cur.core, [key]: merged } };
    });
  const setOffered = (kind: "condition" | "test_status", stored: string, offered: boolean) =>
    setSettings((cur) => {
      const hidden = new Set(cur.hidden?.[kind] ?? []);
      if (offered) hidden.delete(stored);
      else hidden.add(stored);
      return { ...cur, hidden: { ...(cur.hidden ?? {}), [kind]: [...hidden] } };
    });
  const setValueName = (kind: "condition" | "test_status", stored: string, name: string) =>
    setSettings((cur) => ({ ...cur, values: { ...cur.values, [kind]: { ...(cur.values[kind] ?? {}), [stored]: name } } }));
  const missingColumns = COLUMN_FIELDS.filter((c) => !fields.some((f) => f.column === c.column));

  return (
    <>
      <DialogHeader>
        <DialogTitle>{category.name} fields</DialogTitle>
        <DialogDescription>Choose what items in this category are described with, and which standard fields they show.</DialogDescription>
      </DialogHeader>

      <div role="tablist" aria-label="What to customise" className="flex gap-1 border-b">
        {(
          [
            ["specs", "Specifications"],
            ["details", "Standard details"],
          ] as const
        ).map(([id, text]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === id ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            onClick={() => setTab(id)}
          >
            {text}
          </button>
        ))}
      </div>

      {tab === "details" && (
        <div className="max-h-[55vh] overflow-y-auto pr-1">
          <p className="mb-3 text-sm text-muted-foreground">
            Every item has these standard fields. Hide the ones this category does not need and give the rest the names that fit. Hiding only removes a
            field from the forms and lists: anything already entered is kept.
          </p>
          <ul className="grid gap-3">
            {CORE_FIELDS.map((f) => {
              const setting = settings.core[f.key] ?? {};
              const shown = setting.show ?? defaultShown(f.key);
              const values = f.key === "condition" ? CONDITIONS : f.key === "test_status" ? TEST_STATUSES : null;
              return (
                <li key={f.key} className="rounded-lg border p-3">
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-3">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      aria-label={f.key === "stock" ? "Start new items as stock items" : `Show ${f.label}`}
                      checked={shown}
                      disabled={!f.hideable}
                      onChange={(e) => setCore(f.key, { show: e.target.checked })}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{f.label}</div>
                      <div className="text-xs text-muted-foreground">{f.help}</div>
                    </div>
                    {f.key !== "stock" ? (
                      <Input
                        aria-label={`Name for ${f.label}`}
                        placeholder={f.label}
                        maxLength={40}
                        disabled={!shown}
                        value={setting.label ?? ""}
                        onChange={(e) => setCore(f.key, { label: e.target.value })}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">Ticked by default in Quick add</span>
                    )}
                  </div>
                  {values && shown && (
                    <details className="mt-2 text-sm">
                      <summary className="cursor-pointer text-muted-foreground">Rename the values</summary>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Untick the values this category does not use. Give the others the names you want: the same slots, your words.
                      </p>
                      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                        {values.map((v) => (
                          <label key={v} className="grid grid-cols-[auto_6rem_minmax(0,1fr)] items-center gap-2 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              aria-label={`Offer ${v}`}
                              checked={!(settings.hidden?.[f.key as "condition" | "test_status"] ?? []).includes(v)}
                              onChange={(e) => setOffered(f.key as "condition" | "test_status", v, e.target.checked)}
                            />
                            {v}
                            <Input
                              aria-label={`Name for ${v}`}
                              placeholder={v}
                              maxLength={40}
                              className="h-8"
                              value={settings.values[f.key as "condition" | "test_status"]?.[v] ?? ""}
                              onChange={(e) => setValueName(f.key as "condition" | "test_status", v, e.target.value)}
                            />
                          </label>
                        ))}
                      </div>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {tab === "specs" && (
      <>
      <p className="text-sm text-muted-foreground">
        The fields items are described with, in the order they appear on the item page. Renaming a field does not rename values already saved on items.
      </p>
      <div className="max-h-[55vh] overflow-y-auto pr-1">
        {fields.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No fields yet. Items of this category only get the basic details.</p>}
        <ol className="grid gap-2">
          {fields.map((f, i) => (
            <li key={i} className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1.3fr)_auto] items-center gap-2">
              <span className="flex flex-col">
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${f.name || "field"} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp />
                </Button>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${f.name || "field"} down`} disabled={i === fields.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown />
                </Button>
              </span>
              <div className="grid gap-1">
                <Input aria-label="Field name" placeholder="Name, e.g. Socket" value={f.name} maxLength={60} onChange={(e) => update(i, { name: e.target.value })} />
                {f.column && <Badge variant="outline" className="w-fit text-xs">stored in the item&apos;s {f.column.replace("_", " ")} column</Badge>}
              </div>
              <Input aria-label="Example shown in the empty field" placeholder="Example, e.g. Socket 7" value={f.hint} maxLength={120} onChange={(e) => update(i, { hint: e.target.value })} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${f.name || "field"}`} onClick={() => setFields(fields.filter((_, idx) => idx !== i))}>
                <Trash2 />
              </Button>
              <details className="col-start-2 col-end-5 text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Predefined values{f.options.length ? ` (${f.options.length})` : ""}
                </summary>
                <Textarea
                  key={`${i}:${f.name}`}
                  aria-label={`Predefined values for ${f.name || "field"}`}
                  className="mt-1.5 font-mono text-xs"
                  rows={Math.min(8, Math.max(3, f.options.length + 1))}
                  placeholder={"One per line, e.g.\nSDRAM\nEDO"}
                  defaultValue={f.options.join("\n")}
                  onBlur={(e) => {
                    const seen = new Set<string>();
                    const options = e.target.value
                      .split("\n")
                      .map((o) => o.trim())
                      .filter((o) => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()));
                    update(i, { options });
                  }}
                />
                <p className="mt-1 text-xs text-muted-foreground">Offered as a list when filling the field in. Other values can always be typed.</p>
              </details>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setFields([...fields, { name: "", hint: "", column: null, options: [] }])}>
          <Plus /> Add field
        </Button>
        {missingColumns.map((c) => (
          <Button key={c.column} type="button" variant="ghost" size="sm" onClick={() => setFields([...fields, { name: c.name, hint: c.hint, column: c.column, options: [] }])}>
            <Plus /> {c.name}
          </Button>
        ))}
      </div>

      </>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="animate-spin" />} Save fields
        </Button>
      </DialogFooter>
    </>
  );
}
