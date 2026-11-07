import type {
  BulkChanges,
  CategoryField,
  TestLogEntry,
  TestStatus,
  ImportOptions,
  ImportReport,
  BulkResult,
  BulkSelection,
  Category,
  PositionMode,
  ItemCreate,
  ItemDetail,
  ItemFilters,
  ItemSummary,
  ItemBatchResult,
  ItemUpdate,
  Location,
  LocationDetail,
  Page,
  Photo,
  PhotoRole,
  FileAttachment,
  FileKind,
  ReferenceCandidate,
  ReferenceDetail,
  ReferenceSourceStatus,
  ReferenceSummary,
} from "./types";

// Everything goes through the Next.js proxy; the backend is never contacted
// directly from the browser.
const BASE = "/api/v1";
export interface VersionRelease {
  app_name: string;
  version: string;
  build_name: string | null;
  build_time: number | null;
}
export interface VersionInfo extends VersionRelease {
  /** The newer release published in the git repository, if there is one. */
  update: VersionRelease | null;
  check: { enabled: boolean; checked_at: number | null; error: string | null };
}
export const UNAUTHORIZED_EVENT = "hoardware:unauthorized";

export interface AuthStatus {
  auth_required: boolean;
  authenticated: boolean;
  username: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function describe(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const field = Array.isArray(d?.loc) ? d.loc.filter((p: unknown) => p !== "body").join(".") : "";
        return field ? `${field}: ${d?.msg}` : String(d?.msg ?? d);
      })
      .join("; ");
  }
  return "Request failed";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new ApiError(0, "Cannot reach the server");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      message = describe((await response.json()).detail);
    } catch {
      /* non-JSON error body */
    }
    // The session ended (or login was switched on): let the app show the sign-in form.
    if (response.status === 401 && !path.startsWith("/auth/") && typeof window !== "undefined") {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** YYYY-MM-DD for the day `days` ago, in local time. */
export function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString("en-CA");
}

export function filterParams(f: ItemFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.category) p.set("category_id", f.category);
  if (f.manufacturer) p.set("manufacturer", f.manufacturer);
  if (f.condition) p.set("condition", f.condition);
  if (f.test) p.set("test_status", f.test);
  if (f.confidence) p.set("identification_confidence", f.confidence);
  if (f.verified === "never") p.set("never_verified", "true");
  else if (f.verified) p.set("verified_before", daysAgo(Number(f.verified)));
  if (f.unassigned) p.set("unassigned", "true");
  else if (f.location) {
    p.set("location_id", f.location);
    if (f.exact) p.set("include_descendants", "false");
  }
  return p;
}

export const api = {
  categories: () => request<Category[]>("/categories"),
  createCategory: (body: { name: string; sort_order?: number; fields?: CategoryField[] }) => request<Category>("/categories", json("POST", body)),
  updateCategory: (id: number, body: { name?: string; sort_order?: number; fields?: CategoryField[] }) =>
    request<Category>(`/categories/${id}`, json("PATCH", body)),
  deleteCategory: (id: number) => request<void>(`/categories/${id}`, { method: "DELETE" }),

  locations: (params: { parent_id?: number | null; q?: string; cursor?: string | null }) => {
    const p = new URLSearchParams();
    if (params.parent_id != null) p.set("parent_id", String(params.parent_id));
    if (params.q?.trim()) p.set("q", params.q.trim());
    if (params.cursor) p.set("cursor", params.cursor);
    return request<Page<Location>>(`/locations?${p}`);
  },
  location: (id: number) => request<LocationDetail>(`/locations/${id}`),
  createLocation: (body: { name: string; parent_id: number | null; notes?: string | null; type?: string | null }) =>
    request<LocationDetail>("/locations", json("POST", body)),
  updateLocation: (
    id: number,
    body: { name?: string; parent_id?: number | null; notes?: string | null; type?: string | null },
  ) => request<LocationDetail>(`/locations/${id}`, json("PATCH", body)),
  locationTypes: () => request<string[]>("/locations/types"),
  nextPosition: (locationId: number) => request<number>(`/locations/${locationId}/next-position`),
  deleteLocation: (id: number) => request<void>(`/locations/${id}`, { method: "DELETE" }),

  items: (filters: ItemFilters, cursor: string | null, limit = 50) => {
    const p = filterParams(filters);
    p.set("sort", filters.sort);
    if (filters.order) p.set("order", filters.order);
    p.set("limit", String(limit));
    if (cursor) p.set("cursor", cursor);
    return request<Page<ItemSummary>>(`/items?${p}`);
  },
  /** Per-test-status counts for the other filters (the test filter itself is ignored). */
  facets: (filters: ItemFilters) => request<Record<string, number>>(`/items/facets?${filterParams({ ...filters, test: "" })}`),
  itemCount: (filters: ItemFilters) => {
    const p = filterParams(filters);
    p.set("limit", "1");
    p.set("with_total", "true");
    return request<Page<ItemSummary>>(`/items?${p}`).then((page) => page.total ?? 0);
  },
  item: (id: number) => request<ItemDetail>(`/items/${id}`),
  createItemsBatch: (body: { item: ItemCreate; copies: number; order_start: number | null }) =>
    request<ItemBatchResult>("/items/batch", json("POST", body)),
  createItem: (body: ItemCreate) => request<ItemDetail>("/items", json("POST", body)),
  updateItem: (id: number, body: ItemUpdate) => request<ItemDetail>(`/items/${id}`, json("PATCH", body)),
  deleteItem: (id: number) => request<void>(`/items/${id}`, { method: "DELETE" }),
  attributeValues: (key: string, categoryId: number) =>
    request<string[]>(`/attribute-values?${new URLSearchParams({ key, category_id: String(categoryId) })}`),
  attributeKeys: (categoryId: number) => request<string[]>(`/attribute-keys?category_id=${categoryId}`),
  manufacturers: (q: string) => request<string[]>(`/manufacturers?${new URLSearchParams({ q, limit: "15" })}`),

  uploadPhotos: (itemId: number, files: File[], role: PhotoRole = "other") => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    form.append("role", role);
    return request<Photo[]>(`/items/${itemId}/photos`, { method: "POST", body: form });
  },
  updatePhoto: (itemId: number, photoId: number, body: { role?: PhotoRole; caption?: string | null; sort_order?: number }) =>
    request<Photo>(`/items/${itemId}/photos/${photoId}`, json("PATCH", body)),
  deletePhoto: (itemId: number, photoId: number) =>
    request<void>(`/items/${itemId}/photos/${photoId}`, { method: "DELETE" }),

  version: () => request<VersionInfo>("/version"),
  health: () =>
    request<{
      status: string;
      storage: { status: string; detail?: string };
      backups: { status: "off" | "ok" | "none" | "stale" | "failing"; last_backup_at?: string | null; age_hours?: number; error?: string };
    }>("/health"),
  authStatus: () => request<AuthStatus>("/auth/status"),
  login: (username: string, password: string) => request<AuthStatus>("/auth/login", json("POST", { username, password })),
  logout: () => request<void>("/auth/logout", { method: "POST" }),

  bulkDelete: (selection: BulkSelection, dryRun = false) =>
    request<{ matched: number; deleted: number; dry_run: boolean }>("/items/bulk-delete", json("POST", { selection, dry_run: dryRun })),
  /** The selected items as a CSV download. */
  exportSelected: async (selection: BulkSelection) => {
    const response = await fetch(`${BASE}/items/bulk-export`, json("POST", selection));
    if (!response.ok) throw new ApiError(response.status, `Export failed (${response.status})`);
    const blob = await response.blob();
    const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "hoardware-items.csv";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  uploadFiles: (itemId: number, files: File[], kind: FileKind = "other") => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    form.append("kind", kind);
    return request<FileAttachment[]>(`/items/${itemId}/files`, { method: "POST", body: form });
  },
  updateFile: (itemId: number, fileId: number, body: { kind?: FileKind; description?: string | null; filename?: string }) =>
    request<FileAttachment>(`/items/${itemId}/files/${fileId}`, json("PATCH", body)),
  deleteFile: (itemId: number, fileId: number) => request<void>(`/items/${itemId}/files/${fileId}`, { method: "DELETE" }),

  referenceSources: () => request<ReferenceSourceStatus[]>("/reference-sources"),
  referenceSuggestions: (q: string, kind?: string | null) =>
    request<ReferenceCandidate[]>(`/reference-suggestions?${new URLSearchParams({ q, limit: "6", ...(kind ? { kind } : {}) })}`),
  referenceSnapshot: (id: number) =>
    request<{ specs: Record<string, string>; columns: Record<string, string> }>(`/reference-models/${id}/snapshot`),
  referenceCandidates: (itemId: number) => request<ReferenceCandidate[]>(`/items/${itemId}/reference-candidates`),
  searchReference: (q: string, cursor?: string | null) => {
    const p = new URLSearchParams({ limit: "20" });
    if (q.trim()) p.set("q", q.trim());
    if (cursor) p.set("cursor", cursor);
    return request<Page<ReferenceSummary>>(`/reference-models?${p}`);
  },
  referenceModel: (id: number) => request<ReferenceDetail>(`/reference-models/${id}`),
  linkReference: (itemId: number, referenceId: number, confidence: "candidate" | "confirmed") =>
    request<ItemDetail>(`/items/${itemId}/reference-match`, json("POST", { reference_model_id: referenceId, confidence })),
  unlinkReference: (itemId: number) => request<ItemDetail>(`/items/${itemId}/reference-match`, { method: "DELETE" }),

  bulk: (selection: BulkSelection, changes: BulkChanges, opts: { positions?: PositionMode; dryRun?: boolean } = {}) =>
    request<BulkResult>(
      "/items/bulk",
      json("POST", { selection, changes, positions: opts.positions ?? "clear", dry_run: opts.dryRun ?? false }),
    ),

  importItems: (file: File, o: ImportOptions) => {
    const form = new FormData();
    form.append("file", file);
    const p = new URLSearchParams({
      commit: String(o.commit),
      skip_invalid: String(o.skipInvalid),
      create_categories: String(o.createCategories),
      create_locations: String(o.createLocations),
    });
    return request<ImportReport>(`/import/items.csv?${p}`, { method: "POST", body: form });
  },
  importTemplateUrl: `${BASE}/import/template.csv`,

  testLog: (itemId: number) => request<TestLogEntry[]>(`/items/${itemId}/test-log`),
  addTestLog: (itemId: number, body: { status: TestStatus; tested_on?: string | null; notes?: string | null }) =>
    request<TestLogEntry>(`/items/${itemId}/test-log`, json("POST", body)),
  deleteTestLog: (itemId: number, entryId: number) =>
    request<void>(`/items/${itemId}/test-log/${entryId}`, { method: "DELETE" }),

  exportUrl: (filters: ItemFilters) => `${BASE}/export/items.csv?${filterParams(filters)}`,
};
