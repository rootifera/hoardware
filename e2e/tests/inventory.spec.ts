import { expect, test, type APIRequestContext } from "@playwright/test";

// These tests run against a live stack and create their own uniquely named
// items; everything they create is deleted again in afterAll.
const RUN = Date.now().toString(36);
const created: number[] = [];
let locationId: number | null = null;

async function cleanup(request: APIRequestContext) {
  for (const id of created) await request.delete(`/api/v1/items/${id}`);
  if (locationId) {
    const children = await (await request.get(`/api/v1/locations?parent_id=${locationId}`)).json();
    for (const c of children.items) await request.delete(`/api/v1/locations/${c.id}`);
    await request.delete(`/api/v1/locations/${locationId}`);
  }
}

test.afterAll(async ({ request }) => {
  await cleanup(request);
});

async function trackByModel(request: APIRequestContext, model: string) {
  const page = await (await request.get(`/api/v1/items?q=${encodeURIComponent(model)}`)).json();
  for (const item of page.items) created.push(item.id);
}

test("Quick Add with the keyboard, then find the part by search", async ({ page, request }) => {
  const model = `Unknown ISA VGA ${RUN}`;
  await page.goto("/");
  // Client-rendered content means React has hydrated and shortcuts are live.
  await expect(page.getByText(/^\d[\d,]* items?$|^No hardware yet$/)).toBeVisible();
  await page.keyboard.press("n");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Model / description").fill(model);
  await dialog.getByLabel("Model / description").press("Enter");

  // Saved, and the form stays open for the next part.
  await expect(page.getByText(/Added\s+HW-\d+/)).toBeVisible();
  await expect(dialog.getByLabel("Model / description")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await trackByModel(request, model);

  await page.keyboard.press("/");
  await page.locator("#search-input").fill(`isa vga ${RUN}`);
  const row = page.getByRole("link", { name: new RegExp(model) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Untested");
  await expect(page).toHaveURL(/q=isa/);
});

test("Unknown and Untested are separate filters; test notes persist", async ({ page, request }) => {
  const cats = await (await request.get("/api/v1/categories")).json();
  const cpu = cats.find((c: { name: string }) => c.name === "CPU").id;
  const make = async (model: string, body: object = {}) => {
    const r = await request.post("/api/v1/items", { data: { category_id: cpu, model, ...body } });
    const item = await r.json();
    created.push(item.id);
    return item;
  };
  const blocked = await make(`Pentium Pro ${RUN} blocked`, { test_status: "Unknown" });
  await make(`Pentium Pro ${RUN} fresh`);

  await page.goto(`/?q=${encodeURIComponent(`pentium pro ${RUN}`)}&test=Unknown`);
  await expect(page.getByRole("link", { name: /blocked/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /fresh/ })).toHaveCount(0);
  await page.goto(`/?q=${encodeURIComponent(`pentium pro ${RUN}`)}&test=Untested`);
  await expect(page.getByRole("link", { name: /fresh/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /blocked/ })).toHaveCount(0);

  await page.goto(`/items/${blocked.id}`);
  await page.getByLabel("Test notes").fill("Requires Socket 8 motherboard");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Test notes")).toHaveValue("Requires Socket 8 motherboard");
});

test("Nested locations show items from their descendants", async ({ page, request }) => {
  const root = await (await request.post("/api/v1/locations", { data: { name: `Shelf ${RUN}` } })).json();
  locationId = root.id;
  const box = await (await request.post("/api/v1/locations", { data: { name: "CPU Box 3", parent_id: root.id } })).json();
  const cats = await (await request.get("/api/v1/categories")).json();
  const item = await (
    await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `Boxed CPU ${RUN}`, location_id: box.id } })
  ).json();
  created.push(item.id);

  await page.goto(`/locations?id=${root.id}`);
  await expect(page.getByRole("heading", { name: `Shelf ${RUN}` })).toBeVisible();
  const row = page.getByRole("link", { name: new RegExp(`Boxed CPU ${RUN}`) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`Shelf ${RUN} > CPU Box 3`);

  await page.getByLabel("Include items in sub-locations").uncheck();
  await expect(page.getByRole("link", { name: new RegExp(`Boxed CPU ${RUN}`) })).toHaveCount(0);
});

test("Attach a photo to an item", async ({ page, request }) => {
  const cats = await (await request.get("/api/v1/categories")).json();
  const item = await (await request.post("/api/v1/items", { data: { category_id: cats[1].id, model: `Photo card ${RUN}` } })).json();
  created.push(item.id);
  // 1x1 PNG
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

  await page.goto(`/items/${item.id}`);
  await page.locator('input[type="file"]').setInputFiles({ name: "front.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("1 photo added")).toBeVisible();
  await expect(page.getByRole("img", { name: "other photo" })).toBeVisible();

  await page.goto("/?q=" + encodeURIComponent(`photo card ${RUN}`));
  await expect(page.locator('img[src*="/thumbnail"]')).toBeVisible();
});
