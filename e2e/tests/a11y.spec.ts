import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Automated accessibility audit (axe-core, WCAG 2.0/2.1 A+AA) of every screen,
// including open dialogs and the bulk bar. Creates and removes its own data.
const RUN = Date.now().toString(36);
const itemIds: number[] = [];
const locationIds: number[] = [];

test.afterAll(async ({ request }) => {
  for (const id of itemIds) await request.delete(`/api/v1/items/${id}`);
  for (const id of locationIds.reverse()) {
    const kids = await (await request.get(`/api/v1/locations?parent_id=${id}`)).json();
    for (const k of kids.items) await request.delete(`/api/v1/locations/${k.id}`);
    await request.delete(`/api/v1/locations/${id}`);
  }
});

async function audit(page: Page, where: string, exclude: string[] = []) {
  // Let dialogs and menus finish fading in: axe would measure half-transparent text.
  await page.waitForTimeout(400);
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  for (const selector of exclude) builder = builder.exclude(selector);
  const { violations } = await builder.analyze();
  const summary = violations.map(
    (v) => `${v.id} [${v.impact}] x${v.nodes.length}: ${v.help} → ${v.nodes[0].target.join(" ")}\n      ${v.nodes.slice(0, 3).map((n) => n.html.slice(0, 110) + " " + (n.any[0]?.message ?? "").slice(0, 130)).join("\n      ")}`,
  );
  expect(summary, `accessibility problems on ${where}`).toEqual([]);
}

test.describe("accessibility", () => {
  let itemId = 0;
  let locationId = 0;
  let boxId = 0;

  test.beforeAll(async ({ request }) => {
    const shelf = await (await request.post("/api/v1/locations", { data: { name: `A11y Shelf ${RUN}`, type: "shelf" } })).json();
    const box = await (await request.post("/api/v1/locations", { data: { name: "Box", parent_id: shelf.id, type: "box" } })).json();
    locationIds.push(shelf.id);
    locationId = shelf.id;
    boxId = box.id;
    const cats = await (await request.get("/api/v1/categories")).json();
    const created = await (
      await request.post("/api/v1/items/batch", {
        data: { item: { category_id: cats[0].id, model: `A11y CPU ${RUN}`, manufacturer: "Acme", test_status: "POST", location_id: box.id }, copies: 3, order_start: 1 },
      })
    ).json();
    for (const c of created.created) itemIds.push(c.id);
    itemId = created.created[0].id;
  });

  test("stock items: the list tags and the stock panel, including Low and Out", async ({ page, request }) => {
    const cats = await (await request.get("/api/v1/categories")).json();
    const model = `A11y stock ${RUN}`;
    const low = await (await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `${model} low`, is_stock: true, quantity: 5, low_stock_level: 10, barcode: "5012345678900" } })).json();
    const out = await (await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `${model} out`, is_stock: true, quantity: 0 } })).json();
    itemIds.push(low.id, out.id);
    await page.goto(`/?q=${encodeURIComponent(model)}`);
    await expect(page.getByText("Low", { exact: true })).toBeVisible();
    await expect(page.getByText("Out", { exact: true })).toBeVisible();
    await audit(page, "inventory list with Low and Out tags");
    await page.goto(`/items/${low.id}`);
    await expect(page.getByRole("region", { name: "Stock" })).toContainText("Running low");
    await audit(page, "stock panel, running low");
    await page.goto(`/items/${out.id}`);
    await expect(page.getByRole("region", { name: "Stock" })).toContainText("None left");
    await audit(page, "stock panel, none left");
  });

  test("lifecycle: status tags, the Where it is now panel, a build with parts, and the bulk dialogs", async ({ page, request }) => {
    const cats = await (await request.get("/api/v1/categories")).json();
    const model = `A11y life ${RUN}`;
    const build = await (await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `${model} build` } })).json();
    const part = await (await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `${model} part`, installed_in_id: build.id } })).json();
    const lent = await (await request.post("/api/v1/items", { data: { category_id: cats[0].id, model: `${model} lent`, } })).json();
    await request.patch(`/api/v1/items/${lent.id}`, { data: { status: "lent", status_note: "Sam" } });
    itemIds.push(part.id, lent.id, build.id);
    await page.goto(`/?q=${encodeURIComponent(model)}`);
    await expect(page.getByText("Lent out: Sam")).toBeVisible();
    await expect(page.getByText("Installed in a build")).toBeVisible();
    await audit(page, "inventory list with status tags");
    await page.goto(`/items/${build.id}`);
    await expect(page.getByRole("list", { name: "Parts installed" })).toBeVisible();
    await audit(page, "a build with its parts");
    await page.goto(`/items/${lent.id}`);
    await expect(page.getByRole("list", { name: "Item history" })).toBeVisible();
    await audit(page, "an item with history");
    await page.goto(`/?q=${encodeURIComponent(model)}`);
    await page.getByRole("checkbox", { name: /^Select HW-/ }).first().click();
    const bar = page.getByRole("region", { name: "Bulk actions" });
    await bar.getByRole("button", { name: "Status…" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await audit(page, "the bulk status dialog");
    await page.keyboard.press("Escape");
    await bar.getByRole("button", { name: "Spec…" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await audit(page, "the bulk spec dialog");
  });

  test("location label page", async ({ page }) => {
    await page.goto(`/labels?locations=${boxId}`);
    await expect(page.getByTestId("label")).toHaveCount(1);
    await audit(page, "location label");
  });

  test("inventory list, with the bulk bar", async ({ page }) => {
    await page.goto(`/?q=${encodeURIComponent(`a11y cpu ${RUN}`)}`);
    await expect(page.getByRole("checkbox", { name: /^Select HW-/ })).toHaveCount(3);
    await audit(page, "inventory list");
    await page.getByRole("checkbox", { name: /^Select HW-/ }).first().click();
    await expect(page.getByRole("region", { name: "Bulk actions" })).toBeVisible();
    await audit(page, "inventory list with the bulk bar");
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: "Test status" }).click();
    await expect(page.getByRole("menuitem", { name: "Dead" })).toBeVisible();
    await page.waitForTimeout(300);
    await audit(page, "the open status menu");
  });

  test("quick add dialog", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/^\d[\d,]* items?$|^No items yet$/)).toBeVisible();
    await page.keyboard.press("n");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(400); // let the open animation finish
    await audit(page, "quick add");
  });

  test("item page", async ({ page }) => {
    await page.goto(`/items/${itemId}`);
    await expect(page.getByLabel("Model / description")).toBeVisible();
    await audit(page, "item page");
  });

  test("locations page and its dialogs", async ({ page }) => {
    await page.goto(`/locations?id=${boxId}`);
    await expect(page.getByRole("heading", { name: "Box" })).toBeVisible();
    await audit(page, "locations page");
    await page.getByRole("button", { name: "Move all items…" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(400);
    await audit(page, "move dialog");
  });

  test("categories, import and print pages", async ({ page }) => {
    await page.goto("/categories");
    await expect(page.getByRole("heading", { name: "Categories" })).toBeVisible();
    await audit(page, "categories");
    await page.goto("/import");
    await page.locator('input[type="file"]').setInputFiles({ name: "x.csv", mimeType: "text/csv", buffer: Buffer.from("category,model\nNOPE,x\nCPU,y\n") });
    await expect(page.getByText("2 rows")).toBeVisible();
    await audit(page, "import with a report");
    await page.goto(`/locations/print?id=${locationId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await audit(page, "print list");
    await page.goto(`/labels?ids=${itemId}`);
    await expect(page.getByTestId("label")).toHaveCount(1);
    await audit(page, "labels");
  });

  test("dark theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`/?q=${encodeURIComponent(`a11y cpu ${RUN}`)}`);
    await expect(page.getByRole("checkbox", { name: /^Select HW-/ })).toHaveCount(3);
    await audit(page, "inventory list (dark)");
  });
});
