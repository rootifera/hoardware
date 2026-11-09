"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, Loader2, Package, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import { CategoryFieldsDialog } from "@/components/category-fields-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { Category } from "@/lib/types";

function CategoryRow({ category, onDelete, onEditFields }: { category: Category; onDelete: () => void; onEditFields: () => void }) {
  const queryClient = useQueryClient();
  const rename = useMutation({
    mutationFn: (name: string) => api.updateCategory(category.id, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["items"] });
      toast.success("Category renamed");
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <li className="flex items-center gap-2 border-b py-2 last:border-0">
      <Input
        key={category.name}
        aria-label={`Name of ${category.name}`}
        defaultValue={category.name}
        maxLength={100}
        onBlur={(e) => {
          const name = e.target.value.trim();
          if (!name) e.target.value = category.name;
          else if (name !== category.name) rename.mutate(name);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <Button variant="outline" size="sm" className="shrink-0" onClick={onEditFields} aria-label={`Fields of ${category.name}`}>
        <ListChecks /> {category.fields.length} field{category.fields.length === 1 ? "" : "s"}
      </Button>
      <Button variant="ghost" size="icon" aria-label={`Delete ${category.name}`} onClick={onDelete}>
        <Trash2 />
      </Button>
    </li>
  );
}

/** Add the categories of a ready-made set (PC hardware, music gear, trading cards…) to the ones you have. */
function StarterSets({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const presets = useQuery({ queryKey: ["presets"], queryFn: api.presets, enabled: open, staleTime: 5 * 60_000 });
  const existing = useQuery({ queryKey: ["categories"], queryFn: api.categories, enabled: open });
  const have = new Set((existing.data ?? []).map((c) => c.name.toLowerCase()));
  const add = useMutation({
    mutationFn: (key: string) => api.applyPreset(key),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast.success(r.added.length ? `Added ${r.added.join(", ")}` : "Nothing to add: you already have all of these");
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a starter set</DialogTitle>
          <DialogDescription>
            Adds that set&apos;s categories, with their fields and predefined values, next to yours. Categories you already have are never changed.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2">
          {(presets.data ?? []).map((p) => {
            const missing = p.categories.filter((c) => !have.has(c.toLowerCase()));
            return (
              <li key={p.key} className="flex items-start gap-3 rounded-lg border p-3">
                <Package className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{p.name}</div>
                  <div className="text-sm text-muted-foreground">{p.description}</div>
                  {p.key !== "blank" && <div className="mt-1 text-xs text-muted-foreground">{p.categories.join(" · ")}</div>}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  aria-label={`Add ${p.name}`}
                  disabled={add.isPending || missing.length === 0}
                  onClick={() => add.mutate(p.key)}
                >
                  {add.isPending && add.variables === p.key ? <Loader2 className="animate-spin" /> : null}
                  {missing.length === 0 ? "Added" : "Add"}
                </Button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

export default function CategoriesPage() {
  const queryClient = useQueryClient();
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);
  const [starters, setStarters] = useState(false);

  const create = useMutation({
    mutationFn: () => api.createCategory({ name: name.trim(), sort_order: (categories.data?.length ?? 0) * 10 }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      setName("");
      toast.success("Category added");
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (c: Category) => api.deleteCategory(c.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast.success("Category deleted");
      setDeleting(null);
    },
    onError: (e) => {
      setDeleting(null);
      toast.error(e.message);
    },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Categories</h1>
        <p className="text-sm text-muted-foreground">
          Rename a category by editing it in place. “Fields” sets what items of that category are described with (a CPU: speed, bus, cache…). A category that still has items cannot be deleted.
        </p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Input placeholder="New category, e.g. Network Card" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          <Plus /> Add
        </Button>
      </form>
      <div>
        <Button variant="outline" size="sm" onClick={() => setStarters(true)}>
          <Package /> Add a starter set…
        </Button>
      </div>
      {categories.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : categories.isError ? (
        <p className="text-sm text-destructive">{categories.error.message}</p>
      ) : (
        <ul>
          {categories.data.map((c) => (
            <CategoryRow key={c.id} category={c} onDelete={() => setDeleting(c)} onEditFields={() => setEditing(c)} />
          ))}
        </ul>
      )}
      <CategoryFieldsDialog category={editing} onClose={() => setEditing(null)} />
      <StarterSets open={starters} onClose={() => setStarters(false)} />
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>This only works if no items use the category.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && remove.mutate(deleting)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
