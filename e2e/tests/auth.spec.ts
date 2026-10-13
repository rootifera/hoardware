import { expect, test } from "@playwright/test";

// Only meaningful against a stack with login switched on (E2E_PASSWORD set); these tests start signed out.
test.skip(!process.env.E2E_PASSWORD, "login is not enabled on this stack");
test.use({ storageState: { cookies: [], origins: [] } });

test("signed out: the API refuses, the page asks for sign-in, wrong passwords are rejected", async ({ page, request }) => {
  expect((await request.get("/api/v1/categories")).status()).toBe(401);
  expect((await request.get("/api/v1/health")).status()).toBe(200);
  await page.goto("/items/1");
  await expect(page.getByLabel("Username")).toBeVisible();
  await page.getByLabel("Username").fill(process.env.E2E_USER ?? "admin");
  await page.getByLabel("Password").fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("Wrong username or password");
});

test("sign in, stay signed in across a reload, sign out", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Username").fill(process.env.E2E_USER ?? "admin");
  await page.getByLabel("Password").fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Username")).toBeVisible();
});
