import { request } from "@playwright/test";
import { mkdirSync } from "node:fs";

// When the stack under test has login switched on, sign in once and let every test reuse the session.
// Set E2E_USER (default "admin") and E2E_PASSWORD. Without a password nothing happens.
export default async function globalSetup() {
  const password = process.env.E2E_PASSWORD;
  if (!password) return;
  const baseURL = process.env.BASE_URL ?? "http://localhost:3100";
  const api = await request.newContext({ baseURL });
  const res = await api.post("/api/v1/auth/login", { data: { username: process.env.E2E_USER ?? "admin", password } });
  if (!res.ok()) throw new Error(`E2E sign-in failed: ${res.status()} ${await res.text()}`);
  mkdirSync(".auth", { recursive: true });
  await api.storageState({ path: ".auth/state.json" });
  await api.dispose();
}
