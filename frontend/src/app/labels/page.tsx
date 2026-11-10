"use client";

import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Barcode } from "@/components/barcode";
import { canEncode } from "@/lib/code128";
import { SimpleSelect } from "@/components/simple-select";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { BulkSelection } from "@/lib/types";

export const LABELS_SELECTION_KEY = "hoardware.labels";

const LAYOUTS = {
  sheet: { name: "A4 sheet, 3 across (63.5 × 38.1 mm)", w: 63.5, h: 38.1, page: "A4", sheet: true },
  l62: { name: "Label printer 62 × 29 mm", w: 62, h: 29, page: "62mm 29mm", sheet: false },
  l50: { name: "Label printer 50 × 25 mm", w: 50, h: 25, page: "50mm 25mm", sheet: false },
  l89: { name: "Label printer 89 × 36 mm", w: 89, h: 36, page: "89mm 36mm", sheet: false },
} as const;
type LayoutKey = keyof typeof LAYOUTS;

function selectionFromUrl(params: URLSearchParams): BulkSelection | null {
  const ids = (params.get("ids") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) return { ids: ids.slice(0, 1000) };
  try {
    return JSON.parse(sessionStorage.getItem(LABELS_SELECTION_KEY) ?? "null");
  } catch {
    return null;
  }
}

function Labels() {
  const params = useSearchParams();
  // ?locations=1,2 prints labels for boxes and shelves instead of items: scanning one opens its contents.
  const locationIds = (params.get("locations") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  const [selection, setSelection] = useState<BulkSelection | null | undefined>(undefined);
  const [layout, setLayout] = useState<LayoutKey>("sheet");
  // The selection and the chosen label size live in the browser's storage, which the server render cannot read.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- browser-only storage */
    setSelection(selectionFromUrl(new URLSearchParams(params.toString())));
    const saved = localStorage.getItem("hoardware.labellayout") as LayoutKey | null;
    if (saved && saved in LAYOUTS) setLayout(saved);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [params]);

  const labels = useQuery({
    queryKey: ["labels", locationIds.length ? locationIds : JSON.stringify(selection)],
    queryFn: () => (locationIds.length ? api.locationLabels(locationIds) : api.labels(selection!)),
    enabled: locationIds.length > 0 || !!selection,
  });
  const l = LAYOUTS[layout];

  return (
    <div className="space-y-4">
      {/* The page size has to be set for the printer: one label per page, or an A4 sheet. */}
      <style>{`@media print { @page { size: ${l.page}; margin: ${l.sheet ? "0" : "0"}; } }`}</style>
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <div className="grid gap-1.5">
          <label htmlFor="label-layout" className="text-sm font-medium">
            Label size
          </label>
          <SimpleSelect
            id="label-layout"
            className="w-72"
            value={layout}
            onChange={(v) => {
              setLayout(v as LayoutKey);
              localStorage.setItem("hoardware.labellayout", v);
            }}
            options={Object.entries(LAYOUTS).map(([value, x]) => ({ value, label: x.name }))}
          />
        </div>
        <Button onClick={() => window.print()} disabled={!labels.data?.length}>
          <Printer /> Print {labels.data ? `${labels.data.length} label${labels.data.length === 1 ? "" : "s"}` : ""}
        </Button>
        <p className="text-sm text-muted-foreground">
          Choose &quot;Actual size&quot; (100%) in the print dialog and turn off headers and footers. Scanning a label opens the item (or, for a box or shelf label, what is inside it).
        </p>
      </div>

      {selection === null && locationIds.length === 0 && <p className="text-sm text-muted-foreground">Nothing to print. Select items in the inventory and choose Print labels.</p>}
      {labels.isError && <p className="text-sm text-destructive">{labels.error.message}</p>}
      {labels.data && (
        <div
          aria-label="Labels"
          className={l.sheet ? "mx-auto grid w-fit print:m-0 print:pt-[15.1mm] print:pl-[7.2mm]" : "flex flex-col items-center gap-3 print:gap-0"}
          style={l.sheet ? { gridTemplateColumns: `repeat(3, ${l.w}mm)`, columnGap: "2.5mm" } : undefined}
        >
          {labels.data.map((item) => (
            <div
              key={item.id}
              data-testid="label"
              className="flex flex-col justify-between overflow-hidden border border-dashed border-neutral-300 bg-white p-[2mm] text-black break-inside-avoid print:border-0 print:break-after-page"
              style={{ width: `${l.w}mm`, height: `${l.h}mm`, ...(l.sheet ? { pageBreakAfter: "auto" } : {}) }}
            >
              {/* The item's original barcode if it has one (and it can be drawn), otherwise its own code. */}
              <Barcode value={canEncode(item.barcode) ? item.barcode : item.inventory_code} className="w-full flex-1" />
              <div className="mt-[1mm] truncate text-center font-mono text-[11pt] leading-none font-bold tracking-wide">
                {canEncode(item.barcode) ? item.barcode : item.inventory_code}
              </div>
              {item.barcode !== item.inventory_code && <div className="text-center font-mono text-[6.5pt] leading-tight text-neutral-600">{item.inventory_code}</div>}
              <div className="mt-[1mm] line-clamp-2 text-center text-[8pt] leading-tight">{[item.manufacturer, item.model].filter(Boolean).join(" ")}</div>
              {item.location_path && <div className="truncate text-center text-[6.5pt] leading-tight text-neutral-600">{item.location_path}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LabelsPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-3 text-lg font-semibold tracking-tight print:hidden">Print labels</h1>
      <Suspense>
        <Labels />
      </Suspense>
    </div>
  );
}
