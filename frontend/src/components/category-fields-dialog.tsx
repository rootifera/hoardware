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
import type { Category, CategoryField } from "@/lib/types";

const COLUMN_FIELDS: { column: NonNullable<CategoryField["column"]>; name: string; hint: string }[] = [
  { column: "chipset_manufacturer", name: "Chipset maker", hint: "e.g. NVIDIA" },
  { column: "chipset", name: "Chipset", hint: "e.g. RIVA TNT2 Ultra" },
  { column: "revision", name: "Revision", hint: "board revision" },
];

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

  const save = useMutation({
    mutationFn: () => api.updateCategory(category.id, { fields: fields.filter((f) => f.name.trim()).map((f) => ({ ...f, name: f.name.trim() })) }),
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
  const missingColumns = COLUMN_FIELDS.filter((c) => !fields.some((f) => f.column === c.column));

  return (
    <>
      <DialogHeader>
        <DialogTitle>{category.name} fields</DialogTitle>
        <DialogDescription>
          What items in this category are described with, in the order they appear on the item page. Renaming a field does not rename values already
          saved on items.
        </DialogDescription>
      </DialogHeader>

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
