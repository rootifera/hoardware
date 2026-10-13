export const CONDITIONS = ["Unknown", "New / Sealed", "Excellent", "Good", "Fair", "Poor", "Damaged"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const TEST_STATUSES = ["Unknown", "Untested", "POST", "Full Test", "Dead"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const CONFIDENCES = ["unidentified", "candidate", "confirmed"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const PHOTO_ROLES = ["front", "back", "label", "chipset", "other"] as const;
export type PhotoRole = (typeof PHOTO_ROLES)[number];

export interface Category {
  id: number;
  name: string;
  sort_order: number;
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
  thumbnail_url: string | null;
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
  reference_model_id: number | null;
  reference: ReferenceDetail | null;
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
  notes?: string | null;
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
    | "notes"
    | "acquired_on"
    | "identification_confidence"
    | "attributes"
  >
>;

export const SORTS = ["newest", "name", "category", "location"] as const;
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
  sort: "newest",
  order: "",
};
