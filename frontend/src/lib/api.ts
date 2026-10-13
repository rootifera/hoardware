import type {
  Category,
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
  ReferenceCandidate,
  ReferenceDetail,
  ReferenceSourceStatus,
  ReferenceSummary,
} from "./types";

// Everything goes through the Next.js proxy; the backend is never contacted
// directly from the browser.
const BASE = "/api/v1";

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

export function filterParams(f: ItemFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.category) p.set("category_id", f.category);
  if (f.manufacturer) p.set("manufacturer", f.manufacturer);
  if (f.condition) p.set("condition", f.condition);
  if (f.test) p.set("test_status", f.test);
  if (f.confidence) p.set("identification_confidence", f.confidence);
  if (f.unassigned) p.set("unassigned", "true");
  else if (f.location) {
    p.set("location_id", f.location);
    if (f.exact) p.set("include_descendants", "false");
  }
  return p;
}

export const api = {
  categories: () => request<Category[]>("/categories"),
  createCategory: (body: { name: string; sort_order?: number }) => request<Category>("/categories", json("POST", body)),
  updateCategory: (id: number, body: { name?: string; sort_order?: number }) =>
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
  manufacturers: (q: string) => request<string[]>(`/manufacturers?${new URLSearchParams({ q, limit: "15" })}`),

  uploadPhotos: (itemId: number, files: File[], role: PhotoRole = "other") => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    form.append("role", role);
    return request<Photo[]>(`/items/${itemId}/photos`, { method: "POST", body: form });
  },
  updatePhoto: (itemId: number, photoId: number, body: { role?: PhotoRole; caption?: string | null }) =>
    request<Photo>(`/items/${itemId}/photos/${photoId}`, json("PATCH", body)),
  deletePhoto: (itemId: number, photoId: number) =>
    request<void>(`/items/${itemId}/photos/${photoId}`, { method: "DELETE" }),

  referenceSources: () => request<ReferenceSourceStatus[]>("/reference-sources"),
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

  exportUrl: (filters: ItemFilters) => `${BASE}/export/items.csv?${filterParams(filters)}`,
};
