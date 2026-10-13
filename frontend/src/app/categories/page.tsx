"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { Category } from "@/lib/types";

function CategoryRow({ category, onDelete }: { category: Category; onDelete: () => void }) {
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
      <Button variant="ghost" size="icon" aria-label={`Delete ${category.name}`} onClick={onDelete}>
        <Trash2 />
      </Button>
    </li>
  );
}

export default function CategoriesPage() {
  const queryClient = useQueryClient();
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<Category | null>(null);

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
    <div className="mx-auto max-w-xl space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Categories</h1>
        <p className="text-sm text-muted-foreground">
          Rename a category by editing it in place. A category that still has items cannot be deleted.
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
      {categories.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : categories.isError ? (
        <p className="text-sm text-destructive">{categories.error.message}</p>
      ) : (
        <ul>
          {categories.data.map((c) => (
            <CategoryRow key={c.id} category={c} onDelete={() => setDeleting(c)} />
          ))}
        </ul>
      )}
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
