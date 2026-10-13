"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Loader2, Star, Trash2 } from "lucide-react";
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
import { PHOTO_ROLES, PHOTO_ROLE_LABELS, type ItemDetail, type Photo, type PhotoRole } from "@/lib/types";
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
    mutationFn: (v: { id: number; role?: PhotoRole; caption?: string | null; sort_order?: number }) =>
      api.updatePhoto(item.id, v.id, { role: v.role, caption: v.caption, sort_order: v.sort_order }),
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
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2">
        {item.photos.map((photo, index) => (
          <div key={photo.id} className={cn("group space-y-1.5 rounded-lg border p-1.5", index === 0 && item.photos.length > 1 && "col-span-2")}>
            <div className="relative">
              <button type="button" className="block w-full" onClick={() => setViewing(photo)} aria-label="View photo">
                {/* eslint-disable-next-line @next/next/no-img-element -- thumbnails are pre-sized by the backend */}
                <img src={photo.thumbnail_url} alt={photo.caption ?? `${photo.role} photo`} className="aspect-square w-full rounded-md bg-muted object-cover" />
              </button>
              <div className="absolute top-1 right-1 flex gap-1">
                {index > 0 && (
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    aria-label="Make this the cover photo"
                    title="Make this the cover photo (shown in lists)"
                    onClick={() => update.mutate({ id: photo.id, sort_order: Math.min(...item.photos.map((p) => p.sort_order)) - 1 })}
                  >
                    <Star />
                  </Button>
                )}
                <Button variant="secondary" size="icon-sm" aria-label="Delete photo" onClick={() => setDeleting(photo)}>
                  <Trash2 />
                </Button>
              </div>
            </div>
            <SimpleSelect
              size="sm"
              className="w-full"
              aria-label="Photo role"
              value={photo.role}
              onChange={(role) => update.mutate({ id: photo.id, role: role as PhotoRole })}
              options={PHOTO_ROLES.map((r) => ({ value: r, label: PHOTO_ROLE_LABELS[r] }))}
            />
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
            // With no photos yet the drop area fills the card instead of being a small square.
            item.photos.length === 0 && "col-span-full aspect-[16/9]",
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
        aria-label="Add photos"
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
    </div>
  );
}
