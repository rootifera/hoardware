"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LocationPicker, type PickedLocation } from "@/components/location-picker";
import { SimpleSelect } from "@/components/simple-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { ItemDetail } from "@/lib/types";

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["items"] });
    queryClient.invalidateQueries({ queryKey: ["item"] });
    queryClient.invalidateQueries({ queryKey: ["item-history"] });
  };
}

/** Add something you are looking for. It is not owned yet, so it has no location. */
export function WishlistAddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const refresh = useRefresh();
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories, staleTime: 60_000 });
  const [category, setCategory] = useState("");
  const [model, setModel] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [source, setSource] = useState("");
  const [notes, setNotes] = useState("");
  const categoryId = category || String(categories.data?.[0]?.id ?? "");

  const add = useMutation({
    mutationFn: () =>
      api.createItem({
        category_id: Number(categoryId),
        model: model.trim(),
        manufacturer: manufacturer.trim() || null,
        source: source.trim() || null,
        notes: notes.trim() || null,
        status: "wanted",
      }),
    onSuccess: (item) => {
      toast.success(`Added ${item.model} to your wishlist`);
      refresh();
      setModel("");
      setManufacturer("");
      setSource("");
      setNotes("");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to wishlist</DialogTitle>
          <DialogDescription>Something you are looking for. When you get it, convert it into an inventory item.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (model.trim() && categoryId) add.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="wl-category">Category</Label>
            <SimpleSelect
              id="wl-category"
              className="w-full"
              value={categoryId}
              onChange={setCategory}
              options={(categories.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="wl-model">What are you looking for?</Label>
            <Input id="wl-model" autoFocus maxLength={300} placeholder="e.g. Voodoo 5 6000, Pentium III 1GHz" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="wl-maker">Manufacturer (optional)</Label>
            <Input id="wl-maker" maxLength={300} value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="wl-source">Where to look (optional)</Label>
            <Input id="wl-source" maxLength={300} placeholder="eBay, a forum, a swap meet…" value={source} onChange={(e) => setSource(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="wl-notes">Notes (optional)</Label>
            <Textarea id="wl-notes" rows={2} placeholder="Revision, the most you would pay…" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!model.trim() || !categoryId || add.isPending}>
              {add.isPending && <Loader2 className="animate-spin" />} Add to wishlist
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** You got it: turn the wishlist entry into a normal inventory item. */
export function GotItDialog({ item, open, onClose }: { item: ItemDetail; open: boolean; onClose: () => void }) {
  const refresh = useRefresh();
  const [price, setPrice] = useState(item.price !== null ? String(item.price) : "");
  const [source, setSource] = useState(item.source ?? "");
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [location, setLocation] = useState<PickedLocation | null>(null);
  const amount = price.trim() === "" ? null : Number(price);
  const validPrice = amount === null || (Number.isFinite(amount) && amount >= 0);

  const convert = useMutation({
    mutationFn: () =>
      api.updateItem(item.id, {
        status: "in_collection",
        status_note: null,
        price: amount,
        source: source.trim() || null,
        acquired_on: date || null,
        location_id: location?.id ?? null,
      }),
    onSuccess: () => {
      toast.success(`${item.inventory_code} is now in your inventory`);
      refresh();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Got it</DialogTitle>
          <DialogDescription>Moves this wishlist entry into your inventory. Fill in what you paid and where it goes; all of it is optional.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="got-price">Price paid</Label>
            <Input id="got-price" type="number" min={0} step="0.01" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="got-source">Bought from</Label>
            <Input id="got-source" maxLength={300} value={source} onChange={(e) => setSource(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="got-date">Acquired on</Label>
            <Input id="got-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="got-location">Where will it live?</Label>
            <LocationPicker id="got-location" value={location} onChange={setLocation} placeholder="No location yet" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!validPrice || convert.isPending} onClick={() => convert.mutate()}>
            {convert.isPending && <Loader2 className="animate-spin" />} Add to inventory
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
