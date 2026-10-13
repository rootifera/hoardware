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
  await dialog.getByRole("button", { name: "Save & add another" }).click();

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

  // Opening a deep location expands the tree down to it.
  await page.goto(`/locations?id=${box.id}`);
  await expect(page.getByRole("heading", { name: "CPU Box 3" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Location tree" }).getByRole("button", { name: "CPU Box 3" })).toBeVisible();
});

test("Attach a photo to an item", async ({ page, request }) => {
  const cats = await (await request.get("/api/v1/categories")).json();
  const item = await (await request.post("/api/v1/items", { data: { category_id: cats[1].id, model: `Photo card ${RUN}` } })).json();
  created.push(item.id);
  // 1x1 PNG
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

  await page.goto(`/items/${item.id}`);
  await page.getByLabel("Add photos", { exact: true }).setInputFiles({ name: "front.png", mimeType: "image/png", buffer: png });
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
  // The match's specs are now the item's own: they sit in Specifications, editable.
  await expect(page.getByLabel("Speed", { exact: true })).toHaveValue("180MHz");
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
  await qa.getByRole("button", { name: "Save", exact: true }).click();
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

test("Bulk actions: range-select, set a status, then move with positions", async ({ page, request }) => {
  const a = await (await request.post("/api/v1/locations", { data: { name: `Bulk A ${RUN}` } })).json();
  const b = await (await request.post("/api/v1/locations", { data: { name: `Bulk B ${RUN}` } })).json();
  locationIds.push(a.id, b.id);
  const cats = await (await request.get("/api/v1/categories")).json();
  const model = `Bulk CPU ${RUN}`;
  await request.post("/api/v1/items/batch", {
    data: { item: { category_id: cats[0].id, model, location_id: a.id }, copies: 6, order_start: 1 },
  });
  await trackByModel(request, model);
  await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `${model} holder`, location_id: b.id, order: 1 } });
  await trackByModel(request, `${model} holder`);

  await page.goto(`/?q=${encodeURIComponent(model)}&location=${a.id}&sort=position`);
  const boxes = page.getByRole("checkbox", { name: /^Select HW-/ });
  await expect(boxes).toHaveCount(6);
  await boxes.nth(0).click();
  await boxes.nth(3).click({ modifiers: ["Shift"] });
  const bar = page.getByRole("region", { name: "Bulk actions" });
  await expect(bar.getByText("4 items selected")).toBeVisible();

  await bar.getByRole("button", { name: "Test status" }).click();
  await page.getByRole("menuitem", { name: "Dead" }).click();
  await expect(page.getByText("Updated 4 items")).toBeVisible();
  const items = (await (await request.get(`/api/v1/items?location_id=${a.id}&sort=position&limit=50`)).json()).items;
  expect(items.map((i: { test_status: string }) => i.test_status)).toEqual(["Dead", "Dead", "Dead", "Dead", "Untested", "Untested"]);

  // Move the selection to B, numbering on after the item already at position 1.
  await bar.getByRole("button", { name: "Move…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Choose the destination" }).click();
  await page.getByPlaceholder(/Search locations/).fill(`bulk b ${RUN}`);
  await page.getByRole("button", { name: new RegExp(`^Bulk B ${RUN}`) }).click();
  await dialog.getByLabel(/Number on after the last one/).check();
  await expect(dialog.getByText("4 items will move.")).toBeVisible();
  await dialog.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByText("Moved 4 items")).toBeVisible();

  const inB = (await (await request.get(`/api/v1/items?location_id=${b.id}&sort=position&limit=50`)).json()).items;
  expect(inB.map((i: { order: number }) => i.order)).toEqual([1, 2, 3, 4, 5]);
  const left = (await (await request.get(`/api/v1/items?location_id=${a.id}&limit=50`)).json()).items;
  expect(left).toHaveLength(2);
});

test("CSV import: check first, see the bad row, skip it, import the rest", async ({ page, request }) => {
  const model = `Imported CPU ${RUN}`;
  const csv = [
    "category,manufacturer,model,test_status,location,position",
    `CPU,Intel,${model} one,Full Test,Import Shelf ${RUN} > Tray,1`,
    `CPU,Intel,${model} two,POST,Import Shelf ${RUN} > Tray,2`,
    `NOPE,Intel,${model} bad,Untested,,`,
  ].join("\n");

  await page.goto("/import");
  await page.locator('input[type="file"]').setInputFiles({ name: "items.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  const result = page.getByRole("region", { name: "Check result" });
  await expect(result.getByText("3 rows")).toBeVisible();
  // Missing locations are errors until allowed (rows 1 and 2), plus the unknown category (row 3).
  await expect(result.getByText("3 with errors")).toBeVisible();
  await expect(result.getByText(/unknown category “NOPE”/)).toBeVisible();
  await expect(result.getByText(/unknown location/).first()).toBeVisible();
  await page.getByLabel("Create missing locations").check();
  await expect(result.getByText("Will create locations:")).toBeVisible();
  await expect(result.getByText("1 with errors")).toBeVisible();
  await expect(result.getByText("2 ready")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Import 2 item/ })).toBeDisabled();

  await page.getByLabel("Skip rows with errors").check();
  await page.getByRole("button", { name: "Import 2 items" }).click();
  await expect(page.getByText("Imported 2 items.")).toBeVisible();
  await trackByModel(request, model);

  const tops = (await (await request.get(`/api/v1/locations?q=${encodeURIComponent(`import shelf ${RUN}`)}`)).json()).items;
  for (const l of tops.filter((x: { parent_id: number | null }) => x.parent_id === null)) locationIds.push(l.id);
  const got = (await (await request.get(`/api/v1/items?q=${encodeURIComponent(model)}&sort=position&limit=20`)).json()).items;
  expect(got.map((i: { model: string; order: number }) => [i.model, i.order])).toEqual([[`${model} one`, 1], [`${model} two`, 2]]);
  expect(got[0].location_path).toBe(`Import Shelf ${RUN} > Tray`);
});

test("Test-status chips show counts and filter", async ({ page, request }) => {
  const cats = await (await request.get("/api/v1/categories")).json();
  const model = `Chip CPU ${RUN}`;
  for (const [suffix, status] of [["a", "Untested"], ["b", "Untested"], ["c", "Unknown"], ["d", "Dead"]]) {
    await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `${model} ${suffix}`, test_status: status } });
  }
  await trackByModel(request, model);

  await page.goto(`/?q=${encodeURIComponent(model)}`);
  const chips = page.getByRole("group", { name: "Test status" });
  await expect(chips.getByRole("button", { name: /^Untested 2$/ })).toBeVisible();
  await expect(chips.getByRole("button", { name: /^Unknown 1$/ })).toBeVisible();
  await expect(chips.getByRole("button", { name: /^Dead 1$/ })).toBeVisible();
  await expect(chips.getByRole("button", { name: /^POST 0$/ })).toBeVisible();

  await chips.getByRole("button", { name: /^Unknown/ }).click();
  await expect(page).toHaveURL(/test=Unknown/);
  await expect(page.getByText("1 item", { exact: true })).toBeVisible();
  await expect(chips.getByRole("button", { name: /^Untested 2$/ })).toBeVisible(); // other counts stay visible
  await chips.getByRole("button", { name: /^All/ }).click();
  await expect(page.getByText("4 items", { exact: true })).toBeVisible();
});

test("Test history: status changes are logged, tests can be logged by hand", async ({ page, request }) => {
  const cats = await (await request.get("/api/v1/categories")).json();
  const item = await (await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `History CPU ${RUN}` } })).json();
  created.push(item.id);

  await page.goto(`/items/${item.id}`);
  const history = page.getByRole("region", { name: "Test history" }).or(page.locator("section", { hasText: "Test history" }));
  await expect(page.getByText("No test logged yet")).toBeVisible();
  await expect(history.getByText(/Nothing logged yet/)).toBeVisible();

  // Changing the status on the form leaves a history entry.
  await page.getByLabel("Test status").click();
  await page.getByRole("option", { name: "POST", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(history.locator("li")).toHaveCount(1);
  await expect(page.getByText(/^Last tested \d{4}-\d{2}-\d{2}$/)).toBeVisible();

  // Log a test by hand, on an earlier date.
  await history.getByRole("button", { name: "Log a test" }).click();
  await page.getByLabel("Date").fill("2025-01-15");
  await page.getByLabel("What was tested").fill("3DMark99 on a P2-400");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByText("Test logged")).toBeVisible();
  await expect(history.locator("li")).toHaveCount(2);
  await expect(history.getByText("3DMark99 on a P2-400")).toBeVisible();
  await expect(history.getByText("2025-01-15")).toBeVisible();
  expect((await (await request.get(`/api/v1/items/${item.id}`)).json()).test_status).toBe("Full Test");

  // Remove the hand-made entry again: the item's status is untouched.
  await history.getByRole("button", { name: "Remove the 2025-01-15 entry" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(history.locator("li")).toHaveCount(1);
  expect((await (await request.get(`/api/v1/items/${item.id}`)).json()).test_status).toBe("Full Test");
});

test("A photo can be made the cover and becomes the list thumbnail", async ({ page, request }) => {
  const cats = await (await request.get("/api/v1/categories")).json();
  const item = await (await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `Cover card ${RUN}` } })).json();
  created.push(item.id);
  const png = (b64: string) => Buffer.from(b64, "base64");
  const red = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const files = [0, 1].map((n) => ({ name: `p${n}.png`, mimeType: "image/png", buffer: png(red) }));
  await page.goto(`/items/${item.id}`);
  await page.getByLabel("Add photos", { exact: true }).setInputFiles(files);
  await expect(page.getByText("2 photos added")).toBeVisible();
  const before = (await (await request.get(`/api/v1/items/${item.id}`)).json()).photos;

  await page.getByRole("button", { name: "Make this the cover photo" }).click();
  await expect(async () => {
    const after = (await (await request.get(`/api/v1/items/${item.id}`)).json()).photos;
    expect(after[0].id).toBe(before[1].id);
  }).toPass();
  const summary = (await (await request.get(`/api/v1/items?q=${encodeURIComponent(`Cover card ${RUN}`)}`)).json()).items[0];
  expect(summary.thumbnail_url).toContain(`/photos/${before[1].id}/`);
});

test("Stock-take: verify what is in the box, then see what is missing", async ({ page, request }) => {
  const box = await (await request.post("/api/v1/locations", { data: { name: `Stock Box ${RUN}` } })).json();
  locationIds.push(box.id);
  const cats = await (await request.get("/api/v1/categories")).json();
  const model = `Stock CPU ${RUN}`;
  await request.post("/api/v1/items/batch", { data: { item: { category_id: cats[0].id, model, location_id: box.id }, copies: 3, order_start: 1 } });
  await trackByModel(request, model);

  await page.goto(`/locations?id=${box.id}`);
  const boxes = page.getByRole("checkbox", { name: /^Select HW-/ });
  await expect(boxes).toHaveCount(3);
  await boxes.nth(0).click();
  await boxes.nth(1).click();
  await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: "Verified" }).click();
  await expect(page.getByText("Updated 2 items")).toBeVisible();

  // Only the item nobody ticked has not been seen.
  await page.getByLabel("Stock-take").click();
  await page.getByRole("option", { name: "Not seen in 30 days" }).click();
  await expect(page.getByText("1 item", { exact: true })).toBeVisible();
  await expect(page.getByText("#3", { exact: true })).toBeVisible();

  const items = (await (await request.get(`/api/v1/items?location_id=${box.id}&sort=position&limit=10`)).json()).items;
  const detail = await (await request.get(`/api/v1/items/${items[0].id}`)).json();
  expect(detail.verified_on).toBe(new Date().toLocaleDateString("en-CA"));
});

test("Quick Add warns when you already have matching items", async ({ page, request }) => {
  const cats = await (await request.get("/api/v1/categories")).json();
  const model = `Dupe Check ${RUN}`;
  for (let i = 0; i < 2; i++) await request.post("/api/v1/items", { data: { category_id: cats[0].id, model } });
  await trackByModel(request, model);
  await page.goto("/");
  await expect(page.getByText(/^\d[\d,]* items?$|^No hardware yet$/)).toBeVisible();
  await page.keyboard.press("n");
  const qa = page.getByRole("dialog");
  await qa.getByLabel("Model / description").fill(model);
  await expect(qa.getByText("You already have 2 matching items.")).toBeVisible();
  await qa.getByLabel("Model / description").fill(`${model} but different`);
  await expect(qa.getByText(/You already have/)).toHaveCount(0);
});

test("Print list: grouped by location, ordered by position, chrome hidden in print", async ({ page, request }) => {
  const shelf = await (await request.post("/api/v1/locations", { data: { name: `Print Shelf ${RUN}` } })).json();
  const box = await (await request.post("/api/v1/locations", { data: { name: "Box A", parent_id: shelf.id } })).json();
  locationIds.push(shelf.id);
  const cats = await (await request.get("/api/v1/categories")).json();
  const model = `Print CPU ${RUN}`;
  await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `${model} third`, location_id: box.id, order: 3 } });
  await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `${model} first`, location_id: box.id, order: 1 } });
  await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `${model} loose`, location_id: shelf.id } });
  await trackByModel(request, model);

  await page.goto(`/locations?id=${shelf.id}`);
  const popup = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Print list" }).click();
  const sheet = await popup;
  await expect(sheet.getByRole("heading", { name: `Print Shelf ${RUN}`, level: 1 })).toBeVisible();
  await expect(sheet.getByText("3 items including sub-locations")).toBeVisible();
  await expect(sheet.getByRole("heading", { name: `Print Shelf ${RUN} > Box A` })).toBeVisible();
  const rows = await sheet.locator("tbody tr").allTextContents();
  expect(rows.map((r) => r.match(/Print CPU \w+ (first|third|loose)/)?.[1])).toEqual(["loose", "first", "third"]);

  await sheet.emulateMedia({ media: "print" });
  await expect(sheet.getByRole("banner")).toBeHidden(); // the app header does not print
  await expect(sheet.getByRole("button", { name: "Print" })).toBeHidden();
  await sheet.screenshot({ path: "test-results/print-list.png", fullPage: true });
});

test("Spec names are suggested, and 'Add another like this' prefills Quick Add", async ({ page, request }) => {
  const cats = await (await request.get("/api/v1/categories")).json();
  const model = `Like This ${RUN}`;
  const first = await (
    await request.post("/api/v1/items", { data: { category_id: cats[0].id, model, manufacturer: "Acme", part_number: "AC-1", attributes: { [`Socket${RUN}`]: "7" } } })
  ).json();
  created.push(first.id);

  await page.goto(`/items/${first.id}`);
  await expect(page.locator(`#attribute-key-suggestions option[value="Socket${RUN}"]`)).toHaveCount(1);

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Add another like this" }).click();
  const qa = page.getByRole("dialog");
  await expect(qa.getByLabel("Model / description")).toHaveValue(model);
  await expect(qa.getByLabel("Manufacturer")).toHaveValue("Acme");
  await expect(qa.getByLabel("Part number")).toHaveValue("AC-1");
  await expect(qa.getByText("You already have 1 matching item.")).toBeVisible();
  await qa.getByLabel("Condition").click();
  await page.getByRole("option", { name: "Poor", exact: true }).click();
  await qa.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Added HW-\d+/)).toBeVisible();
  await trackByModel(request, model);
  const items = (await (await request.get(`/api/v1/items?q=${encodeURIComponent(model)}&limit=10`)).json()).items;
  expect(items.map((i: { condition: string }) => i.condition).sort()).toEqual(["Poor", "Unknown"]);
});

test("The ? key lists the keyboard shortcuts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/^\d[\d,]* items?$|^No hardware yet$/)).toBeVisible();
  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Quick add", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Typing an S-Spec lists the CPU; picking it fills the whole form", async ({ page, request }) => {
  const sources = await (await request.get("/api/v1/reference-sources")).json();
  test.skip(!sources.some((s: { models: number }) => s.models > 0), "no reference dataset imported");

  await page.goto("/");
  await expect(page.getByText(/^\d[\d,]* items?$|^No hardware yet$/)).toBeVisible();
  await page.keyboard.press("n");
  const qa = page.getByRole("dialog");

  // Start in the wrong category on purpose: the chip code still finds it.
  await qa.getByLabel("Category").click();
  await page.getByRole("option", { name: "RAM", exact: true }).click();
  await page.waitForTimeout(300);
  const before = await qa.boundingBox();
  await qa.getByLabel("Part number").fill("SL32A");

  // An exact code shows up as a suggestion, but NOTHING is filled until it is chosen.
  const suggestions = qa.getByRole("group", { name: "Suggestions" });
  await expect(suggestions.getByRole("button", { name: /BX80524R300128\s*SL32A/ })).toBeVisible();
  // It floats over the form: the dialog keeps exactly the same size and position.
  const during = await qa.boundingBox();
  expect(during).toEqual(before);
  const list = await suggestions.boundingBox();
  expect(list!.y).toBeGreaterThan(before!.y); // anchored inside the dialog, under the field
  await page.waitForTimeout(800);
  await expect(qa.getByText(/Specs will be saved with the item/)).toHaveCount(0);
  await expect(qa.getByLabel("Manufacturer")).toHaveValue("");
  await expect(qa.getByLabel("Part number")).toHaveValue("SL32A");
  await expect(qa.getByLabel("Category")).toContainText("RAM");

  await suggestions.getByRole("button", { name: /BX80524R300128\s*SL32A/ }).click();
  await expect(qa.getByText(/Specs will be saved with the item/)).toBeVisible();
  await expect(qa.getByLabel("Manufacturer")).toHaveValue("Intel");
  await expect(qa.getByLabel("Part number")).toHaveValue("BX80524R300128");
  await expect(qa.getByLabel("Model / description")).toHaveValue("Celeron 300MHz 128KiB L2");
  await expect(qa.getByLabel("Category")).toContainText("CPU");
  // Picking closes the dropdown, and the dialog still has the same size: the note sits in reserved space.
  await expect(suggestions).toHaveCount(0);
  expect(await qa.boundingBox()).toEqual(before);
  expect(await qa.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

  await qa.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Added HW-\d+/)).toBeVisible();

  // Only touch the item we just made: the newest one with that part number.
  const newest = (await (await request.get("/api/v1/items?q=sl32a&sort=newest&limit=1")).json()).items[0];
  created.push(newest.id);
  const detail = await (await request.get(`/api/v1/items/${newest.id}`)).json();
  expect(detail.category_name).toBe("CPU");
  expect(detail.identification_confidence).toBe("confirmed");
  expect(detail.reference?.family).toBe("Celeron");
  expect(detail.reference?.specs["L2 cache"]).toBe("128KiB");
  // ...and the specs live on the item itself, not only in the dataset.
  expect(detail.part_number).toBe("BX80524R300128"); // the order code alone...
  expect(detail.attributes).toMatchObject({ "S-Spec": "SL32A", Speed: "300MHz", "Bus speed": "66MHz", "L2 cache": "128KiB", Package: "SEPP Rev. 1", Family: "Celeron" }); // ...and the S-Spec as its own spec
  await page.goto(`/items/${newest.id}`);
  await expect(page.getByText("Match confirmed").first()).toBeVisible();
  await expect(page.getByLabel("Part number")).toHaveValue("BX80524R300128");
  await expect(page.getByLabel("S-Spec", { exact: true })).toHaveValue("SL32A");
  await expect(page.getByLabel("Speed", { exact: true })).toHaveValue("300MHz");
  await expect(page.getByLabel("Bus speed", { exact: true })).toHaveValue("66MHz");
  await expect(page.getByLabel("L2 cache", { exact: true })).toHaveValue("128KiB");
  await expect(page.getByLabel("Package", { exact: true })).toHaveValue("SEPP Rev. 1");
  // A CPU is set up as a CPU: no chipset fields.
  await expect(page.getByLabel("Chipset", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Chipset maker")).toHaveCount(0);
});

test("A pick can be undone, and ignoring the list changes nothing", async ({ page, request }) => {
  const sources = await (await request.get("/api/v1/reference-sources")).json();
  test.skip(!sources.some((s: { models: number }) => s.models > 0), "no reference dataset imported");

  await page.goto("/");
  await expect(page.getByText(/^\d[\d,]* items?$|^No hardware yet$/)).toBeVisible();
  await page.keyboard.press("n");
  const qa = page.getByRole("dialog");
  await qa.getByLabel("Category").click();
  await page.getByRole("option", { name: "CPU", exact: true }).click();

  await qa.getByLabel("Part number").fill("SL32A");
  const suggestions = qa.getByRole("group", { name: "Suggestions" });
  await suggestions.getByRole("button").first().click();
  await expect(qa.getByText(/Specs will be saved with the item/)).toBeVisible();
  await qa.getByRole("button", { name: "Remove the match" }).click();
  await expect(qa.getByText(/Specs will be saved with the item/)).toHaveCount(0);
  await expect(qa.getByLabel("Manufacturer")).toHaveValue("Intel"); // the filled-in values stay, now just plain text

  // A partial code lists several records; ignoring the list leaves the form as typed.
  await qa.getByLabel("Part number").fill("A80503");
  await expect(suggestions).toBeVisible();
  await qa.getByLabel("Model / description").fill("My own name");
  await expect(qa.getByText(/Specs will be saved with the item/)).toHaveCount(0);
  await expect(qa.getByLabel("Model / description")).toHaveValue("My own name");
});


test("The suggestion dropdown: arrow key, Esc closes only it, and the dialog never resizes", async ({ page, request }) => {
  const sources = await (await request.get("/api/v1/reference-sources")).json();
  test.skip(!sources.some((s: { models: number }) => s.models > 0), "no reference dataset imported");

  await page.goto("/");
  await expect(page.getByText(/^\d[\d,]* items?$|^No hardware yet$/)).toBeVisible();
  await page.keyboard.press("n");
  const qa = page.getByRole("dialog");
  await qa.getByLabel("Category").click();
  await page.getByRole("option", { name: "CPU", exact: true }).click();
  await page.waitForTimeout(300);
  const before = await qa.boundingBox();

  await qa.getByLabel("Part number").fill("A80503");
  const suggestions = qa.getByRole("group", { name: "Suggestions" });
  await expect(suggestions).toBeVisible();
  expect(await qa.boundingBox()).toEqual(before);

  // Esc closes the dropdown but not the dialog.
  await page.keyboard.press("Escape");
  await expect(suggestions).toHaveCount(0);
  await expect(qa).toBeVisible();
  // Typing more brings it back; the arrow key moves into the list and Enter-ing a row picks it.
  await qa.getByLabel("Part number").fill("A805031");
  await expect(suggestions).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(suggestions.getByRole("button").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(qa.getByText(/Specs will be saved with the item/)).toBeVisible();
  expect(await qa.boundingBox()).toEqual(before);

  // The duplicate hint and the position shortcut also leave the size alone.
  await qa.getByLabel("Model / description").fill("Pentium");
  await page.waitForTimeout(600);
  expect(await qa.boundingBox()).toEqual(before);
});


test("Typing the S-Spec into Model gets a proper name, full specs, and a useful inventory row", async ({ page, request }) => {
  const sources = await (await request.get("/api/v1/reference-sources")).json();
  test.skip(!sources.some((s: { models: number }) => s.models > 0), "no reference dataset imported");

  await page.goto("/");
  await expect(page.getByText(/^\d[\d,]* items?$|^No hardware yet$/)).toBeVisible();
  await page.keyboard.press("n");
  const qa = page.getByRole("dialog");
  await qa.getByLabel("Category").click();
  await page.getByRole("option", { name: "CPU", exact: true }).click();

  // The code typed into the Model field (not Part number).
  await qa.getByLabel("Model / description").fill("SL32A");
  const suggestions = qa.getByRole("group", { name: "Suggestions" });
  const row = suggestions.getByRole("button", { name: /Celeron 300MHz 128KiB L2/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("300MHz · 66MHz bus · 128KiB L2 · SEPP Rev. 1"); // the S-Spec table's bus speed too
  await expect(row).toContainText("BX80524R300128"); // the order code...
  await expect(row.getByTitle("S-Spec: the code printed on the chip")).toHaveText("SL32A"); // ...and the S-Spec as a separate chip
  await row.click();

  // The model is replaced by the proper name (it was only the code), and the status line says what was filled.
  await expect(qa.getByLabel("Model / description")).toHaveValue("Celeron 300MHz 128KiB L2");
  await expect(qa.getByLabel("Manufacturer")).toHaveValue("Intel");
  await expect(qa.getByLabel("Part number")).toHaveValue("BX80524R300128");
  await expect(qa.getByText(/300MHz · 66MHz bus · 128KiB L2/)).toBeVisible();
  await qa.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Added HW-\d+/)).toBeVisible();

  const newest = (await (await request.get("/api/v1/items?q=sl32a&sort=newest&limit=1")).json()).items[0];
  created.push(newest.id);
  // The inventory row now says what the chip is, not just "Intel SL32A".
  await page.goto("/?q=sl32a");
  const link = page.locator(`a[href="/items/${newest.id}"]`);
  await expect(link).toContainText("Intel Celeron 300MHz 128KiB L2");
  await expect(link).toContainText("SL32A · 300MHz · 66MHz bus · 128KiB L2 · SEPP Rev. 1");
});

test("An item added as just the code can take the proper name from its match", async ({ page, request }) => {
  const sources = await (await request.get("/api/v1/reference-sources")).json();
  test.skip(!sources.some((s: { models: number }) => s.models > 0), "no reference dataset imported");

  const cats = await (await request.get("/api/v1/categories")).json();
  const cpu = cats.find((c: { name: string }) => c.name === "CPU").id;
  const item = await (await request.post("/api/v1/items", { data: { category_id: cpu, model: `SL32A`, manufacturer: "Intel" } })).json();
  created.push(item.id);

  await page.goto(`/items/${item.id}`);
  await page.getByRole("button", { name: "Find reference match" }).click();
  await page.getByRole("button", { name: "Confirm match" }).first().click();
  await expect(page.getByText("Match confirmed").first()).toBeVisible();
  await page.getByRole("button", { name: "Use this name" }).click();
  await expect(page.getByText("Name updated")).toBeVisible();
  await expect(page.getByLabel("Model / description")).toHaveValue("Celeron 300MHz 128KiB L2");
  await expect(page.getByRole("button", { name: "Use this name" })).toHaveCount(0);
  // Linking copied the specs onto the item, so they are searchable and unlinking keeps them.
  const detail = await (await request.get(`/api/v1/items/${item.id}`)).json();
  expect(detail.attributes.Package).toBe("SEPP Rev. 1");
  await page.getByRole("button", { name: "Unlink" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Unlink" }).click();
  await expect(page.getByText("Not matched to a reference model (optional).")).toBeVisible();
  expect((await (await request.get(`/api/v1/items/${item.id}`)).json()).attributes["Bus speed"]).toBe("66MHz");
  const found = (await (await request.get(`/api/v1/items?q=${encodeURIComponent("sepp 66mhz")}&limit=50`)).json()).items;
  expect(found.map((i: { id: number }) => i.id)).toContain(item.id);
});


test("Each category has its own fields: a CPU is set up as a CPU, a graphics card as a graphics card", async ({ page, request }) => {
  const cats = await (await request.get("/api/v1/categories")).json();
  const id = (name: string) => cats.find((c: { name: string }) => c.name === name).id;
  const cpu = await (await request.post("/api/v1/items", { data: { category_id: id("CPU"), model: `Field CPU ${RUN}` } })).json();
  const gpu = await (await request.post("/api/v1/items", { data: { category_id: id("GPU/VGA"), model: `Field GPU ${RUN}` } })).json();
  created.push(cpu.id, gpu.id);

  await page.goto(`/items/${cpu.id}`);
  await expect(page.getByRole("heading", { name: "CPU specifications" })).toBeVisible();
  for (const label of ["Family", "Speed", "Bus speed", "L2 cache", "Socket", "Package", "Stepping"]) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("Chipset", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Memory size")).toHaveCount(0);

  // Fill a spec, save, and it is searchable and shown on the inventory row.
  await page.getByLabel("Speed", { exact: true }).fill("233MHz");
  await page.getByLabel("Socket", { exact: true }).fill("Socket 7");
  await page.keyboard.press("Escape"); // the list of predefined sockets closes; the typed value stays
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect((await (await request.get(`/api/v1/items/${cpu.id}`)).json()).attributes).toEqual({ Speed: "233MHz", Socket: "Socket 7" });
  const hits = (await (await request.get(`/api/v1/items?q=${encodeURIComponent("233mhz socket 7")}`)).json()).items;
  expect(hits.map((i: { id: number }) => i.id)).toContain(cpu.id);

  await page.goto(`/items/${gpu.id}`);
  await expect(page.getByRole("heading", { name: "GPU/VGA specifications" })).toBeVisible();
  await page.getByLabel("Chipset maker").fill("NVIDIA");
  await page.getByLabel("Chipset", { exact: true }).fill("RIVA TNT2 Ultra");
  await page.getByLabel("Memory size").fill("32MB");
  await page.keyboard.press("Escape"); // closes the list of predefined sizes
  await expect(page.getByLabel("Speed", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const saved = await (await request.get(`/api/v1/items/${gpu.id}`)).json();
  expect([saved.chipset_manufacturer, saved.chipset, saved.attributes["Memory size"]]).toEqual(["NVIDIA", "RIVA TNT2 Ultra", "32MB"]);
});

test("Category fields can be edited on the Categories page and change the item page", async ({ page, request }) => {
  const created_cat = await (await request.post("/api/v1/categories", { data: { name: `Field Test ${RUN}` } })).json();
  const item = await (await request.post("/api/v1/items", { data: { category_id: created_cat.id, model: `Custom ${RUN}` } })).json();
  created.push(item.id);
  try {
    await page.goto(`/items/${item.id}`);
    await expect(page.getByText(/No fields are set up for this category yet/)).toBeVisible();

    await page.goto("/categories");
    await page.getByRole("button", { name: `Fields of Field Test ${RUN}` }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Add field" }).click();
    await dialog.getByLabel("Field name").fill("Wattage");
    await dialog.getByLabel("Example shown in the empty field").fill("e.g. 300W");
    await dialog.getByRole("button", { name: "Chipset", exact: true }).click(); // a column-backed field
    await dialog.getByRole("button", { name: "Save fields" }).click();
    await expect(page.getByText(/fields saved/)).toBeVisible();

    await page.goto(`/items/${item.id}`);
    await expect(page.getByLabel("Wattage")).toHaveAttribute("placeholder", "e.g. 300W");
    await expect(page.getByLabel("Chipset", { exact: true })).toBeVisible();
  } finally {
    await request.delete(`/api/v1/items/${item.id}`);
    await request.delete(`/api/v1/categories/${created_cat.id}`);
  }
});

test("The photo role dropdown is wide enough to read", async ({ page, request }) => {
  const cats = await (await request.get("/api/v1/categories")).json();
  const item = await (await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `Role card ${RUN}` } })).json();
  created.push(item.id);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.goto(`/items/${item.id}`);
  await page.getByLabel("Add photos", { exact: true }).setInputFiles({ name: "a.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("1 photo added")).toBeVisible();
  const trigger = page.getByRole("combobox", { name: "Photo role" });
  const tile = await page.getByRole("img", { name: "other photo" }).boundingBox();
  const box = await trigger.boundingBox();
  expect(box!.width).toBeGreaterThan(tile!.width * 0.9);
  await trigger.click();
  await expect(page.getByRole("option", { name: "Label / sticker" })).toBeVisible();
  await page.getByRole("option", { name: "Chipset" }).click();
  await expect(trigger).toContainText("Chipset");
});

test("Manuals and drivers can be attached, downloaded and removed", async ({ page, request }) => {
  const cats = await (await request.get("/api/v1/categories")).json();
  const item = await (await request.post("/api/v1/items", { data: { category_id: cats[1].id, model: `Downloads card ${RUN}` } })).json();
  created.push(item.id);
  await page.goto(`/items/${item.id}`);
  await expect(page.getByRole("heading", { name: "Downloads", exact: true })).toBeVisible();

  await page.getByLabel("Add files", { exact: true }).setInputFiles([
    { name: "User manual.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 hello") },
    { name: "win98-driver.zip", mimeType: "application/zip", buffer: Buffer.from("PK-driver") },
  ]);
  await expect(page.getByText("2 files added")).toBeVisible();
  await expect(page.getByRole("link", { name: /User manual\.pdf/ })).toBeVisible();
  // The kind was guessed from the extension and can be changed.
  await expect(page.getByRole("combobox", { name: "Kind of User manual.pdf" })).toContainText("Manual");
  const kind = page.getByRole("combobox", { name: "Kind of win98-driver.zip" });
  await kind.click();
  await page.getByRole("option", { name: "Driver" }).click();
  await expect(kind).toContainText("Driver");
  await page.getByLabel("Description of win98-driver.zip").fill("Win98 SE, v4.1");
  await page.getByLabel("Description of win98-driver.zip").blur();
  await expect(async () => {
    const files = (await (await request.get(`/api/v1/items/${item.id}`)).json()).files;
    const f = files.find((x: { filename: string }) => x.filename === "win98-driver.zip");
    expect(f.kind).toBe("driver");
    expect(f.description).toBe("Win98 SE, v4.1");
  }).toPass();

  const link = page.getByRole("link", { name: /User manual\.pdf/ });
  const res = await request.get((await link.getAttribute("href"))!);
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe("%PDF-1.4 hello");
  expect(res.headers()["content-disposition"]).toContain("attachment");

  await page.getByRole("button", { name: "Delete User manual.pdf" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("File deleted")).toBeVisible();
  await expect(page.getByRole("link", { name: /User manual\.pdf/ })).toHaveCount(0);
});

test("A graphics card keeps its own name; the chipset is looked up separately", async ({ page, request }) => {
  const sources = await (await request.get("/api/v1/reference-sources")).json();
  test.skip(!sources.some((s: { key: string; models: number }) => s.key === "gpus-specs" && s.models > 0), "no graphics dataset imported");

  await page.goto("/");
  await expect(page.getByText(/^\d[\d,]* items?$|^No hardware yet$/)).toBeVisible();
  await page.keyboard.press("n");
  const qa = page.getByRole("dialog");
  await qa.getByLabel("Category").click();
  await page.getByRole("option", { name: "GPU/VGA", exact: true }).click();
  await qa.getByLabel("Model / description").fill("Viper V770 Ultra");
  await qa.getByLabel("Manufacturer").fill("Diamond");
  // The card's own name is never looked up.
  await page.waitForTimeout(700);
  await expect(qa.getByRole("group", { name: "Suggestions" })).toHaveCount(0);

  const before = await qa.boundingBox();
  await qa.getByLabel("Chipset", { exact: true }).fill("tnt2 ultra");
  const suggestions = qa.getByRole("group", { name: "Suggestions" });
  await expect(suggestions.getByRole("button", { name: /Riva TNT2 Ultra/ })).toContainText("NV5 · 32 MB SDR · AGP 4x");
  expect(await qa.boundingBox()).toEqual(before);
  await suggestions.getByRole("button", { name: /Riva TNT2 Ultra/ }).click();
  await expect(qa.getByLabel("Chipset", { exact: true })).toHaveValue("Riva TNT2 Ultra");
  await expect(qa.getByLabel("Model / description")).toHaveValue("Viper V770 Ultra");
  await expect(qa.getByLabel("Manufacturer")).toHaveValue("Diamond");
  await expect(qa.getByText(/Specs will be saved with the item/)).toBeVisible();
  await qa.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Added HW-\d+/)).toBeVisible();

  const newest = (await (await request.get("/api/v1/items?q=viper&sort=newest&limit=1")).json()).items[0];
  created.push(newest.id);
  expect(newest.model).toBe("Viper V770 Ultra");
  expect(newest.spec_line).toContain("Riva TNT2 Ultra · 32 MB SDR · AGP 4x");
  await page.goto(`/items/${newest.id}`);
  await expect(page.getByLabel("Model / description")).toHaveValue("Viper V770 Ultra");
  await expect(page.getByLabel("Manufacturer", { exact: true })).toHaveValue("Diamond");
  await expect(page.getByLabel("Chipset maker")).toHaveValue("NVIDIA");
  await expect(page.getByLabel("Chipset", { exact: true })).toHaveValue("Riva TNT2 Ultra");
  await expect(page.getByLabel("GPU chip", { exact: true })).toHaveValue("NV5");
  await expect(page.getByLabel("Memory size", { exact: true })).toHaveValue("32 MB");
  await expect(page.getByText("This describes the card")).toBeVisible();
});

test("Quick add: manufacturer and model sit side by side, and Save & edit opens the new item", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByText(/^\d[\d,]* items?$|^No hardware yet$/)).toBeVisible();
  await page.keyboard.press("n");
  const qa = page.getByRole("dialog");
  const maker = await qa.getByLabel("Manufacturer").boundingBox();
  const model = await qa.getByLabel("Model / description").boundingBox();
  expect(Math.abs(maker!.y - model!.y)).toBeLessThan(4);
  expect(maker!.x).toBeLessThan(model!.x);
  const part = await qa.getByLabel("Part number").boundingBox();
  expect(part!.y).toBeLessThan(maker!.y);

  await expect(qa.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await expect(qa.getByRole("button", { name: "Save & add another" })).toBeVisible();
  await qa.getByLabel("Model / description").fill(`Edit me ${RUN}`);
  await qa.getByRole("button", { name: "Save & edit" }).click();
  await expect(page).toHaveURL(/\/items\/\d+$/);
  await expect(page.getByLabel("Model / description")).toHaveValue(`Edit me ${RUN}`);
  created.push(Number(page.url().split("/").pop()));
});

test("Quick add takes a RAM or storage item's specifications in one go", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByText(/^\d[\d,]* items?$|^No hardware yet$/)).toBeVisible();
  await page.keyboard.press("n");
  const qa = page.getByRole("dialog");
  await qa.getByLabel("Category").click();
  await page.getByRole("option", { name: "RAM", exact: true }).click();
  await expect(qa.getByText("RAM specifications")).toBeVisible();
  await qa.getByLabel("Model / description").fill(`Kingston stick ${RUN}`);
  await qa.getByLabel("Type", { exact: true }).fill("SDRAM");
  await qa.getByLabel("Capacity", { exact: true }).fill("128MB");
  await qa.getByLabel("Speed", { exact: true }).fill("PC133");

  // Enter saves (and closes), like the Save button.
  await qa.getByLabel("Model / description").press("Enter");
  await expect(page.getByText(/Added HW-\d+/)).toBeVisible();
  await expect(qa).toHaveCount(0);

  const newest = (await (await request.get(`/api/v1/items?q=${encodeURIComponent(`Kingston stick ${RUN}`)}&limit=1`)).json()).items[0];
  created.push(newest.id);
  const detail = await (await request.get(`/api/v1/items/${newest.id}`)).json();
  expect(detail.attributes).toMatchObject({ Type: "SDRAM", Capacity: "128MB", Speed: "PC133" });

  // "Add another like this" carries the specs into the form.
  await page.goto(`/items/${newest.id}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Add another like this" }).click();
  await expect(page.getByRole("dialog").getByLabel("Capacity", { exact: true })).toHaveValue("128MB");
});

test("RAM and storage fields offer predefined values, and a custom value still works", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByText(/^\d[\d,]* items?$|^No hardware yet$/)).toBeVisible();
  await page.keyboard.press("n");
  const qa = page.getByRole("dialog");
  await qa.getByLabel("Category").click();
  await page.getByRole("option", { name: "RAM", exact: true }).click();
  await qa.getByLabel("Model / description").fill(`Option stick ${RUN}`);

  // Pick from the list...
  await qa.getByLabel("Type", { exact: true }).click();
  await expect(page.getByRole("option", { name: "EDO", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "EDO", exact: true }).click();
  await expect(qa.getByLabel("Type", { exact: true })).toHaveValue("EDO");
  // ...type to narrow it, then pick...
  await qa.getByLabel("Capacity", { exact: true }).fill("12");
  await expect(page.getByRole("option", { name: "128MB", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "4MB", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "128MB", exact: true }).click();
  await expect(qa.getByLabel("Capacity", { exact: true })).toHaveValue("128MB");
  // ...or ignore the list and use a value of your own.
  await qa.getByLabel("Speed", { exact: true }).fill("PC-weird 77");
  await qa.getByLabel("Pins", { exact: true }).click();
  await page.keyboard.press("Escape"); // closes the list only
  await expect(qa).toBeVisible();
  await qa.getByLabel("Model / description").click();
  await qa.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Added HW-\d+/)).toBeVisible();

  const newest = (await (await request.get(`/api/v1/items?q=${encodeURIComponent(`Option stick ${RUN}`)}&limit=1`)).json()).items[0];
  created.push(newest.id);
  const detail = await (await request.get(`/api/v1/items/${newest.id}`)).json();
  expect(detail.attributes).toMatchObject({ Type: "EDO", Capacity: "128MB", Speed: "PC-weird 77" });

  // The item page offers the same values, and the options are editable on the Categories page.
  await page.goto(`/items/${newest.id}`);
  await page.getByLabel("ECC", { exact: true }).click();
  await page.getByRole("option", { name: "Parity", exact: true }).click();
  await expect(page.getByLabel("ECC", { exact: true })).toHaveValue("Parity");
  await page.goto("/categories");
  await page.getByRole("button", { name: /Fields/ }).nth(4).click();
  await expect(page.getByRole("dialog").getByText(/Predefined values/).first()).toBeVisible();
});
