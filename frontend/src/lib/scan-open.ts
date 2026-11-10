import { api } from "@/lib/api";

export type ScanResult =
  | { kind: "item"; href: string; message: string }
  | { kind: "location"; href: string; message: string }
  | { kind: "many"; href: string; message: string }
  | { kind: "none"; message: string };

const LOCATION_CODE = /^LOC-0*(\d{1,12})$/i;

/** What a scanned code means: a location label opens that location, an item code or original
 *  barcode opens the item (or lists several that share a barcode). */
export async function resolveScan(code: string): Promise<ScanResult> {
  const text = code.trim();
  const loc = LOCATION_CODE.exec(text);
  if (loc) {
    try {
      const location = await api.locationByCode(text);
      return { kind: "location", href: `/locations?id=${location.id}`, message: `Opened ${location.full_name}` };
    } catch {
      return { kind: "none", message: `No location has the code ${text.toUpperCase()}` };
    }
  }
  const found = await api.scanLookup(text);
  if (found.length === 1) return { kind: "item", href: `/items/${found[0].id}`, message: `Found ${found[0].inventory_code}` };
  if (found.length > 1) return { kind: "many", href: `/?q=${encodeURIComponent(text)}`, message: `${found.length} items have this barcode` };
  return { kind: "none", message: `No item has the code ${text.toUpperCase()}` };
}
