import { expect, test, type APIRequestContext } from "@playwright/test";

// These tests run against a live stack and create their own uniquely named
// items; everything they create is deleted again in afterAll.
const RUN = Date.now().toString(36);
const created: number[] = [];
const locationIds: number[] = [];

async function cleanup(request: APIRequestContext) {
  for (const id of created) await request.delete(`/api/v1/items/${id}`);
  for (const id of locationIds) {
    const children = await (await request.get(`/api/v1/locations?parent_id=${id}`)).json();
    for (const c of children.items) await request.delete(`/api/v1/locations/${c.id}`);
    await request.delete(`/api/v1/locations/${id}`);
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
  locationIds.push(root.id);
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

test("Reference matching is optional and stays out of the way", async ({ page, request }) => {
  const sources = await (await request.get("/api/v1/reference-sources")).json();
  test.skip(!sources.some((s: { models: number }) => s.models > 0), "no reference dataset imported");

  const cats = await (await request.get("/api/v1/categories")).json();
  const cpu = cats.find((c: { name: string }) => c.name === "CPU").id;
  // Just a part number printed on the chip (a Pentium Pro S-Spec in CPU-DB).
  const item = await (await request.post("/api/v1/items", { data: { category_id: cpu, model: `Unknown CPU ${RUN}`, part_number: "SL23L" } })).json();
  created.push(item.id);

  await page.goto(`/items/${item.id}`);
  // Quiet by default: one line, no suggestions fetched or shown.
  await expect(page.getByText("Not matched to a reference model (optional).")).toBeVisible();
  await expect(page.getByText("Suggested matches")).toHaveCount(0);

  await page.getByRole("button", { name: "Find reference match" }).click();
  await expect(page.getByText("Shares a code: sl23l")).toBeVisible();
  await page.getByRole("button", { name: "Confirm match" }).first().click();
  await expect(page.getByText("Match confirmed").first()).toBeVisible();
  await expect(page.getByText("Imported specs from CPU-DB")).toBeVisible();
  // The item's own fields are untouched.
  await expect(page.getByLabel("Model / description")).toHaveValue(`Unknown CPU ${RUN}`);
  await page.screenshot({ path: "test-results/ref-linked.png", fullPage: true });

  // Unsaved edits lock the match buttons so a link can't wipe them.
  await page.getByLabel("Notes").first().fill("typing…");
  await expect(page.getByText("You have unsaved changes.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Unlink" })).toBeDisabled();
  await page.getByRole("button", { name: "Revert" }).click();

  await page.getByRole("button", { name: "Unlink" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Unlink" }).click();
  await expect(page.getByText("Not matched to a reference model (optional).")).toBeVisible();
  const after = await (await request.get(`/api/v1/items/${item.id}`)).json();
  expect(after.identification_confidence).toBe("unidentified");
});

test("Ten identical CPUs sit at ten exact positions in one location", async ({ page, request }) => {
  const tray = await (await request.post("/api/v1/locations", { data: { name: `CPU Tray ${RUN}`, type: "tray" } })).json();
  locationIds.push(tray.id);
  const model = `Identical CPU ${RUN}`;

  await page.goto("/");
  await expect(page.getByText(/^\d[\d,]* items?$|^No hardware yet$/)).toBeVisible();
  await page.keyboard.press("n");
  const qa = page.getByRole("dialog");
  await qa.getByLabel("Model / description").fill(model);
  await qa.getByLabel("Location").click();
  await page.getByPlaceholder(/Search locations/).fill(`cpu tray ${RUN}`);
  await page.getByRole("button", { name: new RegExp(`^CPU Tray ${RUN}`) }).click();
  // The empty tray offers position 1 as the next free spot.
  await expect(qa.getByLabel("Position")).toHaveAttribute("placeholder", "next: 1");
  await qa.getByLabel("Position").fill("1");
  await qa.getByLabel("Copies").fill("10");
  await expect(qa.getByText("10 separate items at positions 1–10.")).toBeVisible();
  await qa.getByRole("button", { name: "Save & close" }).click();
  await expect(page.getByText(/Added 10 items/)).toBeVisible();
  await trackByModel(request, model);

  // The location lists them in position order.
  await page.goto(`/locations?id=${tray.id}`);
  await expect(page.getByText("10 items", { exact: true })).toBeVisible();
  await expect(page.getByText(/^#\d+$/)).toHaveCount(10);
  expect(await page.getByText(/^#\d+$/).allTextContents()).toEqual(Array.from({ length: 10 }, (_, i) => `#${i + 1}`));

  // Each is its own item, and an exact spot cannot be shared.
  const items = (await (await request.get(`/api/v1/items?q=${encodeURIComponent(model)}&limit=50`)).json()).items;
  expect(new Set(items.map((i: { inventory_code: string }) => i.inventory_code)).size).toBe(10);
  const refused = await request.post("/api/v1/items", {
    data: { category_id: items[0].category_id, model: "interloper", location_id: tray.id, order: 3 },
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).detail).toContain("position 3 is already taken");

  // The item page shows and edits the position, and a taken one is refused.
  await page.goto(`/items/${items.find((i: { order: number }) => i.order === 2).id}`);
  await expect(page.getByLabel("Position")).toHaveValue("2");
  await page.getByLabel("Position").fill("3");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText(/position 3 is already taken/)).toBeVisible();
});
