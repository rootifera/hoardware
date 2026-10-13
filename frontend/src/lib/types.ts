export const CONDITIONS = ["Unknown", "New / Sealed", "Excellent", "Good", "Fair", "Poor", "Damaged"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const TEST_STATUSES = ["Unknown", "Untested", "POST", "Full Test", "Dead"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const CONFIDENCES = ["unidentified", "candidate", "confirmed"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const PHOTO_ROLES = ["front", "back", "label", "chipset", "other"] as const;
export type PhotoRole = (typeof PHOTO_ROLES)[number];

export interface CategoryField {
  name: string;
  hint: string;
  /** Stored in this item column instead of the item's own specs. */
  column: "chipset_manufacturer" | "chipset" | "revision" | null;
}

export interface Category {
  id: number;
  name: string;
  sort_order: number;
  /** The fields items of this category are described with, in order. */
  fields: CategoryField[];
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
    | "notes"
    | "acquired_on"
    | "verified_on"
    | "identification_confidence"
    | "attributes"
  >
>;

export const SORTS = ["newest", "name", "category", "location", "position"] as const;
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

export interface TestLogEntry {
  id: number;
  tested_on: string;
  status: TestStatus;
  notes: string | null;
  created_at: string;
}
