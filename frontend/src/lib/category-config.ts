import type { Category } from "@/lib/types";

/** The standard fields every item has, and what a category may do with them. */
export const CORE_FIELDS = [
  { key: "manufacturer", label: "Manufacturer", hideable: true, help: "Who made it" },
  { key: "model", label: "Model / description", hideable: false, help: "What it is. Every item needs one." },
  { key: "part_number", label: "Part number", hideable: true, help: "An order, catalogue or card number" },
  { key: "barcode", label: "Barcode", hideable: true, help: "The original barcode from the packaging. Labels and scans use it; without one they use the item's own code" },
  { key: "confidence", label: "How sure are you of the exact model?", hideable: true, help: "Only useful when you match items against a database" },
  { key: "condition", label: "Condition", hideable: true, help: "How it looks", values: true },
  { key: "test_status", label: "Test status", hideable: true, help: "Whether it works. Also hides the test notes and test history.", values: true },
  { key: "stock", label: "Track as stock", hideable: true, defaultShown: false, help: "New items in this category start as stock items: counted, with take out and add" },
  { key: "notes", label: "Notes", hideable: true, help: "Free text" },
  { key: "acquired_on", label: "Acquired on", hideable: true, help: "When you got it" },
  { key: "verified_on", label: "Last verified", hideable: true, help: "When you last saw it in place (stock-take)" },
] as const;

export type CoreKey = (typeof CORE_FIELDS)[number]["key"];

/** Is this standard field shown for the category? Everything is, unless hidden (stock: only when switched on). */
export function coreShown(category: Category | undefined | null, key: CoreKey): boolean {
  const set = category?.settings?.core?.[key]?.show;
  return set ?? defaultShown(key);
}

/** Whether a standard field is shown when the category says nothing: all but "track as stock" (a default) are. */
export function defaultShown(key: CoreKey): boolean {
  return key !== "stock";
}

/** What the category calls a standard field; `fallback` is the name used where nothing was set. */
export function coreLabel(category: Category | undefined | null, key: CoreKey, fallback: string): string {
  return category?.settings?.core?.[key]?.label || fallback;
}

/** A stored condition / test status under the name the category gives it. */
export function valueLabel(category: Category | undefined | null, kind: "condition" | "test_status", stored: string): string {
  return category?.settings?.values?.[kind]?.[stored] || stored;
}

/** The condition / test status values a category offers (without the ones it hides). A value an
 *  item already has is always kept, so editing never silently changes it. */
export function visibleValues<T extends string>(category: Category | undefined | null, kind: "condition" | "test_status", all: readonly T[], current?: string): T[] {
  const hidden = new Set(category?.settings?.hidden?.[kind] ?? []);
  return all.filter((v) => !hidden.has(v) || v === current);
}

/** The kind of reference database that describes a category, if there is one (CPUs, graphics cards). */
export function refKindOf(categoryName: string): "cpu" | "gpu" | null {
  if (/cpu|processor/i.test(categoryName)) return "cpu";
  if (/gpu|vga|graphics|video/i.test(categoryName)) return "gpu";
  return null;
}

/** Does any category show this field? Used to hide filters that would only confuse. */
export function anyShows(categories: Category[] | undefined, key: CoreKey): boolean {
  return !categories || categories.length === 0 || categories.some((c) => coreShown(c, key));
}
