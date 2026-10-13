"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Printer } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { EMPTY_FILTERS, type ItemSummary } from "@/lib/types";

const MAX_ITEMS = 5000;
const PAGE = 200;

async function loadAll(locationId: string, exact: boolean): Promise<{ items: ItemSummary[]; truncated: boolean }> {
  const filters = { ...EMPTY_FILTERS, location: locationId, exact, sort: "newest" as const };
  const items: ItemSummary[] = [];
  let cursor: string | null = null;
  do {
    const page = await api.items(filters, cursor, PAGE);
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor && items.length < MAX_ITEMS);
  return { items, truncated: cursor !== null };
}

function Sheet() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const exact = params.get("exact") === "1";
  const location = useQuery({ queryKey: ["location", Number(id)], queryFn: () => api.location(Number(id)), enabled: Boolean(id) });
  const contents = useQuery({ queryKey: ["print-items", id, exact], queryFn: () => loadAll(id, exact), enabled: Boolean(id) });

  if (!id) return <p className="p-6 text-sm">No location chosen.</p>;
  if (location.isError || contents.isError) return <p className="p-6 text-sm text-destructive">Could not load this location.</p>;
  if (!location.data || !contents.data) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;

  // Group by location, positions first (items without one last).
  const groups = new Map<string, ItemSummary[]>();
  for (const item of contents.data.items) {
    const key = item.location_path ?? "";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, list] of ordered) {
    list.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.model.localeCompare(b.model) || a.id - b.id);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6 print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button variant="ghost" size="sm" render={<Link href={`/locations?id=${id}`} />}>
          <ArrowLeft /> Back
        </Button>
        <Button onClick={() => window.print()}>
          <Printer /> Print
        </Button>
      </div>

      <header className="space-y-1 border-b pb-3">
        <h1 className="text-xl font-semibold">{location.data.full_name}</h1>
        <p className="text-sm text-muted-foreground">
          {contents.data.items.length.toLocaleString()} item{contents.data.items.length === 1 ? "" : "s"}
          {exact ? "" : " including sub-locations"} · printed {new Date().toLocaleDateString("en-CA")}
        </p>
        {contents.data.truncated && <p className="text-sm text-amber-700">Only the first {MAX_ITEMS.toLocaleString()} items are listed.</p>}
      </header>

      {ordered.length === 0 && <p className="text-sm text-muted-foreground">Nothing is stored here.</p>}
      {ordered.map(([path, list]) => (
        <section key={path} className="break-inside-avoid-page space-y-1">
          {(ordered.length > 1 || path !== location.data.full_name) && <h2 className="text-sm font-semibold">{path || "No location"}</h2>}
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="w-8 py-1" aria-label="Present"></th>
                <th className="w-12 py-1">Pos.</th>
                <th className="w-28 py-1">Code</th>
                <th className="py-1">Item</th>
                <th className="w-24 py-1">Test</th>
                <th className="w-24 py-1">Condition</th>
              </tr>
            </thead>
            <tbody>
              {list.map((item) => (
                <tr key={item.id} className="border-b border-border/60 break-inside-avoid">
                  <td className="py-1.5">
                    <span className="inline-block size-4 rounded-sm border border-foreground/60" aria-hidden />
                  </td>
                  <td className="py-1.5 font-mono">{item.order ?? ""}</td>
                  <td className="py-1.5 font-mono text-xs">{item.inventory_code}</td>
                  <td className="py-1.5">
                    {[item.manufacturer, item.model].filter(Boolean).join(" ")}
                    {item.part_number && <span className="text-xs text-muted-foreground"> · P/N {item.part_number}</span>}
                  </td>
                  <td className="py-1.5">{item.test_status}</td>
                  <td className="py-1.5">{item.condition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

export default function PrintPage() {
  return (
    <Suspense>
      <Sheet />
    </Suspense>
  );
}
