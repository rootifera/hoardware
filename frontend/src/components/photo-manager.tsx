"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
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
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { PHOTO_ROLES, type ItemDetail, type Photo, type PhotoRole } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACCEPT = "image/jpeg,image/png,image/gif,image/webp";

export function PhotoManager({ item }: { item: ItemDetail }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState<Photo | null>(null);
  const [deleting, setDeleting] = useState<Photo | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["item", item.id] });
    queryClient.invalidateQueries({ queryKey: ["items"] });
  };

  const upload = useMutation({
    mutationFn: (files: File[]) => api.uploadPhotos(item.id, files),
    onSuccess: (photos) => {
      toast.success(`${photos.length} photo${photos.length === 1 ? "" : "s"} added`);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: (v: { id: number; role?: PhotoRole; caption?: string | null }) =>
      api.updatePhoto(item.id, v.id, { role: v.role, caption: v.caption }),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (photo: Photo) => api.deletePhoto(item.id, photo.id),
    onSuccess: () => {
      toast.success("Photo deleted");
      setDeleting(null);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  function pick(list: FileList | null) {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) upload.mutate(files);
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">Photos</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
        {item.photos.map((photo) => (
          <div key={photo.id} className="group space-y-1.5 rounded-lg border p-1.5">
            <button type="button" className="block w-full" onClick={() => setViewing(photo)} aria-label="View photo">
              {/* eslint-disable-next-line @next/next/no-img-element -- thumbnails are pre-sized by the backend */}
              <img src={photo.thumbnail_url} alt={photo.caption ?? `${photo.role} photo`} className="aspect-square w-full rounded-md bg-muted object-cover" />
            </button>
            <div className="flex items-center gap-1">
              <SimpleSelect
                size="sm"
                className="min-w-0 flex-1"
                aria-label="Photo role"
                value={photo.role}
                onChange={(role) => update.mutate({ id: photo.id, role: role as PhotoRole })}
                options={PHOTO_ROLES.map((r) => ({ value: r, label: r }))}
              />
              <Button variant="ghost" size="icon-sm" aria-label="Delete photo" onClick={() => setDeleting(photo)}>
                <Trash2 />
              </Button>
            </div>
            <Input
              className="h-7 text-xs"
              placeholder="Caption"
              defaultValue={photo.caption ?? ""}
              maxLength={1000}
              onBlur={(e) => {
                const caption = e.target.value.trim() || null;
                if (caption !== photo.caption) update.mutate({ id: photo.id, caption });
              }}
            />
          </div>
        ))}
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
            "flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-sm text-muted-foreground transition-colors hover:bg-muted/50",
            dragging && "border-primary bg-muted/50",
          )}
        >
          {upload.isPending ? <Loader2 className="size-6 animate-spin" /> : <ImagePlus className="size-6" />}
          {upload.isPending ? "Uploading…" : "Add photos"}
          <span className="text-xs">or drop files here</span>
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />

      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogTitle>{viewing?.caption || (viewing ? `${viewing.role} photo` : "Photo")}</DialogTitle>
          <DialogDescription className="sr-only">Full-size photo</DialogDescription>
          {viewing && (
            // eslint-disable-next-line @next/next/no-img-element -- full-size original from the backend
            <img src={viewing.url} alt={viewing.caption ?? ""} className="max-h-[75vh] w-full rounded-md object-contain" />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this photo?</AlertDialogTitle>
            <AlertDialogDescription>The image file is removed permanently.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && remove.mutate(deleting)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
