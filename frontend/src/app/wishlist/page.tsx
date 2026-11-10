"use client";

import { Plus, Search } from "lucide-react";
import { useState } from "react";
import { ItemList } from "@/components/item-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WishlistAddDialog } from "@/components/wishlist";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { EMPTY_FILTERS } from "@/lib/types";

export default function WishlistPage() {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const search = useDebouncedValue(q, 200);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Wishlist</h1>
          <p className="text-sm text-muted-foreground">Things you are looking for. Open one and press <strong>Got it</strong> when you have bought it: it moves into your inventory.</p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus /> Add to wishlist
        </Button>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Search the wishlist" type="search" className="pl-9" placeholder="Search the wishlist…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ItemList
        filters={{ ...EMPTY_FILTERS, status: "wanted", q: search }}
        onClear={() => setQ("")}
        empty={
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
            <p className="font-medium">Your wishlist is empty</p>
            <p className="text-sm text-muted-foreground">Add the things you are hunting for, with where to look.</p>
            <Button onClick={() => setAdding(true)}>Add the first one</Button>
          </div>
        }
      />
      <WishlistAddDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
