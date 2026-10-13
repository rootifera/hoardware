"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileUp, Loader2, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { SimpleSelect } from "@/components/simple-select";
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
import { api } from "@/lib/api";
import { FILE_KINDS, FILE_KIND_LABELS, type FileAttachment, type FileKind, type ItemDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A sensible first guess from the file name; the kind can be changed afterwards. */
function guessKind(name: string): FileKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["pdf", "chm", "doc", "docx", "txt", "djvu"].includes(ext)) return "manual";
  if (["rom", "bin", "bio", "fd", "cap", "hex", "wph", "awd"].includes(ext)) return "firmware";
  return "other";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function FileManager({ item }: { item: ItemDetail }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<FileAttachment | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["item", item.id] });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      // One request per kind so each file starts with its own guessed kind.
      const groups = new Map<FileKind, File[]>();
      for (const f of files) groups.set(guessKind(f.name), [...(groups.get(guessKind(f.name)) ?? []), f]);
      let count = 0;
      for (const [kind, list] of groups) count += (await api.uploadFiles(item.id, list, kind)).length;
      return count;
    },
    onSuccess: (count) => {
      toast.success(`${count} file${count === 1 ? "" : "s"} added`);
      refresh();
    },
    onError: (e) => {
      toast.error(e.message);
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (v: { id: number; kind?: FileKind; description?: string | null }) =>
      api.updateFile(item.id, v.id, { kind: v.kind, description: v.description }),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (f: FileAttachment) => api.deleteFile(item.id, f.id),
    onSuccess: () => {
      toast.success("File deleted");
      setDeleting(null);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  function pick(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (files.length) upload.mutate(files);
  }

  return (
    <div className="space-y-3">
      {item.files.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {item.files.map((f) => (
            <li key={f.id} className="grid items-center gap-x-3 gap-y-2 p-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto]">
              <div className="min-w-0 space-y-1.5">
                <a
                  href={f.url}
                  download={f.filename}
                  className="flex min-w-0 items-center gap-2 font-medium hover:underline"
                  title={`Download ${f.filename}`}
                >
                  <Download className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{f.filename}</span>
                  <span className="shrink-0 text-xs font-normal text-muted-foreground">{formatBytes(f.size_bytes)}</span>
                </a>
                <Input
                  className="h-7 text-xs"
                  placeholder="Description (version, OS, what it is…)"
                  aria-label={`Description of ${f.filename}`}
                  defaultValue={f.description ?? ""}
                  maxLength={1000}
                  onBlur={(e) => {
                    const description = e.target.value.trim() || null;
                    if (description !== f.description) update.mutate({ id: f.id, description });
                  }}
                />
              </div>
              <SimpleSelect
                size="sm"
                className="w-full"
                aria-label={`Kind of ${f.filename}`}
                value={f.kind}
                onChange={(kind) => update.mutate({ id: f.id, kind: kind as FileKind })}
                options={FILE_KINDS.map((k) => ({ value: k, label: FILE_KIND_LABELS[k] }))}
              />
              <Button variant="ghost" size="icon-sm" aria-label={`Delete ${f.filename}`} onClick={() => setDeleting(f)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files);
        }}
        disabled={upload.isPending}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-5 text-sm text-muted-foreground transition-colors hover:bg-muted/50",
          dragging && "border-primary bg-muted/50",
        )}
      >
        {upload.isPending ? <Loader2 className="size-5 animate-spin" /> : <FileUp className="size-5" />}
        {upload.isPending ? "Uploading…" : "Add manuals, drivers, tools… (click or drop files here)"}
      </button>
      <input
        ref={inputRef}
        aria-label="Add files"
        type="file"
        multiple
        className="sr-only"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.filename}?</AlertDialogTitle>
            <AlertDialogDescription>The file is removed permanently.</AlertDialogDescription>
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
