export const ITEM_STATUSES = ["in_collection", "installed", "lent", "sold", "scrapped", "wanted"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  in_collection: "In collection",
  installed: "Installed in a build",
  lent: "Lent out",
  sold: "Sold",
  scrapped: "Scrapped",
  wanted: "Wishlist",
};
/** What you can set on the item page. "Installed" comes from choosing a build. */
export const SETTABLE_STATUSES: ItemStatus[] = ["in_collection", "lent", "sold", "scrapped", "wanted"];
/** Sold, scrapped and wished-for items have no place on a shelf. */
export const GONE_STATUSES: ItemStatus[] = ["sold", "scrapped", "wanted"];

export interface ItemRef {
  id: number;
  inventory_code: string;
  manufacturer: string | null;
  model: string;
  category_name: string | null;
}

export interface ItemHistoryEntry {
  id: number;
  kind: "location" | "status" | "installed_in";
  old: string | null;
  new: string | null;
  created_at: string;
}

export const CONDITIONS = ["Unknown", "New / Sealed", "Excellent", "Good", "Fair", "Poor", "Damaged"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const TEST_STATUSES = ["Unknown", "Untested", "POST", "Full Test", "Dead"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const CONFIDENCES = ["unidentified", "candidate", "confirmed"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const PHOTO_ROLES = ["front", "back", "label", "chipset", "other"] as const;
export type PhotoRole = (typeof PHOTO_ROLES)[number];
export const PHOTO_ROLE_LABELS: Record<PhotoRole, string> = {
  front: "Front",
  back: "Back",
  label: "Label / sticker",
  chipset: "Chipset",
  other: "Other",
};

export const FILE_KINDS = ["manual", "driver", "firmware", "tool", "datasheet", "other"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_KIND_LABELS: Record<FileKind, string> = {
  manual: "Manual",
  driver: "Driver",
  firmware: "Firmware / BIOS",
  tool: "Tool",
  datasheet: "Datasheet",
  other: "Other",
};

export interface CategoryField {
  name: string;
  hint: string;
  /** Stored in this item column instead of the item's own specs. */
  column: "chipset_manufacturer" | "chipset" | "revision" | null;
  /** Predefined values offered for the field; any other value can still be typed. */
  options: string[];
}

export interface CoreFieldSetting {
  show?: boolean | null;
  label?: string | null;
}
/** Which standard fields a category shows and what it calls them and their values. */
export interface CategorySettings {
  core: Record<string, CoreFieldSetting>;
  values: Record<string, Record<string, string>>;
  /** Values this category does not offer, by field ("condition", "test_status"). */
  hidden?: Record<string, string[]>;
}

export interface Category {
  id: number;
  name: string;
  sort_order: number;
  /** The fields items of this category are described with, in order. */
  fields: CategoryField[];
  settings: CategorySettings;
}

export interface LocationRef {
  id: number;
  name: string;
}

export interface Location {
  id: number;
  name: string;
  parent_id: number | null;
  notes: string | null;
  /** Free-text label: shelf, box, drawer, … */
  type: string | null;
  full_name: string;
  has_children: boolean;
}

export interface LocationDetail extends Location {
  ancestors: LocationRef[];
}

export interface Photo {
  id: number;
  item_id: number;
  role: PhotoRole;
  caption: string | null;
  sort_order: number;
  content_type: string;
  size_bytes: number;
  created_at: string;
  url: string;
  thumbnail_url: string;
}

/** A downloadable file attached to an item. */
export interface FileAttachment {
  id: number;
  item_id: number;
  filename: string;
  kind: FileKind;
  description: string | null;
  content_type: string;
  size_bytes: number;
  created_at: string;
  url: string;
}

export interface ItemSummary {
  id: number;
  inventory_code: string;
  category_id: number;
  category_name: string;
  manufacturer: string | null;
  model: string;
  part_number: string | null;
  revision: string | null;
  chipset_manufacturer: string | null;
  chipset: string | null;
  condition: Condition;
  test_status: TestStatus;
  identification_confidence: Confidence;
  location_id: number | null;
  location_path: string | null;
  /** Exact position inside the location (unique per location). */
  order: number | null;
  /** Stock items are counted (take out / add); everything else is a single item. */
  is_stock: boolean;
  /** How many you have (only meaningful for stock items). */
  quantity: number;
  low_stock_level: number | null;
  /** The original barcode (from the packaging), if any. Labels and scans use it, else the item's own code. */
  barcode: string | null;
  status: ItemStatus;
  status_note: string | null;
  thumbnail_url: string | null;
  /** Key specs of the matched reference model, if any. */
  spec_line: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReferenceSource {
  key: string;
  name: string;
  url: string | null;
  licence: string | null;
  attribution: string | null;
}

export interface ReferenceSourceStatus extends ReferenceSource {
  models: number;
  source_version: string | null;
  last_import_at: string | null;
}

export interface ReferenceSummary {
  id: number;
  kind: string;
  manufacturer: string | null;
  family: string | null;
  model: string;
  part_number: string | null;
  revision: string | null;
  source_key: string;
  highlights: Record<string, unknown>;
  /** The part number as printed: the order code plus (Intel) the S-Spec, e.g. "BX80524R300128 SL32A". */
  /** Just the order code, e.g. "BX80524R300128". */
  order_code: string | null;
  /** The short code printed on the chip, e.g. "SL32A". */
  s_spec: string | null;
  /** A readable name, e.g. "Celeron 300MHz 128KiB L2". */
  display_name: string;
  /** Key specs on one line. */
  spec_line: string;
}

export interface ReferenceDetail extends ReferenceSummary {
  aliases: string[];
  specs: Record<string, unknown>;
  provenance: Record<string, unknown>;
  source: ReferenceSource;
  source_version: string;
  imported_at: string;
}

export type MatchType = "exact" | "token" | "text";

export interface ReferenceCandidate {
  reference: ReferenceSummary;
  match_type: MatchType;
  matched_on: string[];
  manufacturer_matches: boolean | null;
}

export interface ItemDetail extends ItemSummary {
  installed_in_id: number | null;
  installed_in: ItemRef | null;
  /** What is installed in this item (when it is a build). */
  parts: ItemRef[];
  price: number | null;
  source: string | null;
  test_notes: string | null;
  notes: string | null;
  acquired_on: string | null;
  verified_on: string | null;
  reference_model_id: number | null;
  reference: ReferenceDetail | null;
  /** Date of the newest test-history entry. */
  last_tested_on: string | null;
  attributes: Record<string, unknown>;
  photos: Photo[];
  files: FileAttachment[];
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  total: number | null;
}

export interface ItemCreate {
  category_id: number;
  model: string;
  manufacturer?: string | null;
  part_number?: string | null;
  condition?: Condition;
  test_status?: TestStatus;
  location_id?: number | null;
  order?: number | null;
  is_stock?: boolean;
  quantity?: number;
  barcode?: string | null;
  status?: ItemStatus;
  status_note?: string | null;
  installed_in_id?: number | null;
  price?: number | null;
  source?: string | null;
  notes?: string | null;
  /** Set when a reference suggestion was picked. */
  reference_model_id?: number | null;
  identification_confidence?: Confidence;
}

export type ItemUpdate = Partial<
  Pick<
    ItemDetail,
    | "category_id"
    | "model"
    | "manufacturer"
    | "part_number"
    | "revision"
    | "chipset_manufacturer"
    | "chipset"
    | "condition"
    | "test_status"
    | "test_notes"
    | "location_id"
    | "order"
    | "is_stock"
    | "quantity"
    | "low_stock_level"
    | "barcode"
    | "status"
    | "status_note"
    | "installed_in_id"
    | "price"
    | "source"
    | "notes"
    | "acquired_on"
    | "verified_on"
    | "identification_confidence"
    | "attributes"
  >
>;

export const SORTS = ["newest", "name", "category", "location", "position", "spec"] as const;
export type Sort = (typeof SORTS)[number];

export interface ItemFilters {
  q: string;
  category: string; // category id, "" = any
  manufacturer: string;
  condition: string;
  test: string;
  confidence: string;
  location: string; // location id, "" = any
  exact: boolean; // true = do not include descendant locations
  unassigned: boolean;
  /** One spec condition, e.g. Speed at least 200MHz. Numbers understand units. */
  specKey: string;
  specOp: "eq" | "min" | "max";
  specValue: string;
  /** "" = what you own, a status, or "all". */
  status: string;
  /** Stock items at or under their low-stock level. */
  lowStock: boolean;
  /** Stock-take: "" any, "never", or a number of days (not seen within that many). */
  verified: string;
  sort: Sort;
  order: "" | "asc" | "desc";
}

export const EMPTY_FILTERS: ItemFilters = {
  q: "",
  category: "",
  manufacturer: "",
  condition: "",
  test: "",
  confidence: "",
  location: "",
  exact: false,
  unassigned: false,
  specKey: "",
  specOp: "eq",
  specValue: "",
  status: "",
  lowStock: false,
  verified: "",
  sort: "newest",
  order: "",
};

export interface ItemBatchResult {
  created: { id: number; inventory_code: string; location_path: string | null; order: number | null }[];
}

export interface BulkFilter {
  q: string | null;
  category_id: number[];
  manufacturer: string | null;
  condition: string[];
  test_status: string[];
  identification_confidence: string[];
  location_id: number | null;
  include_descendants: boolean;
  unassigned: boolean;
  low_stock: boolean;
  status: string[];
  spec_key: string | null;
  spec_op: "eq" | "min" | "max";
  spec_value: string | null;
  never_verified: boolean;
  verified_before: string | null;
}

export interface BulkSelection {
  ids?: number[];
  filter?: BulkFilter;
  exclude_ids?: number[];
}

export interface BulkChanges {
  condition?: Condition;
  test_status?: TestStatus;
  test_notes?: string | null;
  category_id?: number;
  location_id?: number | null;
  /** true = seen in place today; false = clear. */
  verified?: boolean;
  status?: ItemStatus;
  status_note?: string | null;
  source?: string | null;
  price?: number | null;
  /** Spec values to set; null removes the spec. */
  attributes?: Record<string, string | number | null>;
}

export type PositionMode = "clear" | "keep" | "append";

export interface BulkResult {
  matched: number;
  moved: number;
  clashes: number;
  dry_run: boolean;
}

export interface ImportReport {
  committed: boolean;
  blocked: boolean;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  imported: number;
  errors: { line: number; message: string }[];
  errors_truncated: boolean;
  warnings: string[];
  new_categories: string[];
  new_locations: string[];
  preview: Record<string, string | number | null>[];
}

export interface ImportOptions {
  commit: boolean;
  skipInvalid: boolean;
  createCategories: boolean;
  createLocations: boolean;
}

export interface StockLogEntry {
  id: number;
  /** Negative = taken out, positive = added. */
  change: number;
  quantity_after: number;
  note: string | null;
  created_at: string;
}

export interface TestLogEntry {
  id: number;
  tested_on: string;
  status: TestStatus;
  notes: string | null;
  created_at: string;
}
