import { request } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Before the tests run: sign in when the stack has login switched on (E2E_PASSWORD, and E2E_USER if it
// is not "admin"), and get past the first-run choice an empty install shows (standard PC hardware, which
// is what the tests expect). An install that was already set up answers 409: fine.
export default async function globalSetup() {
  const password = process.env.E2E_PASSWORD;
  const baseURL = process.env.BASE_URL ?? "http://localhost:3100";
  const api = await request.newContext({ baseURL });
  if (password) {
    const res = await api.post("/api/v1/auth/login", { data: { username: process.env.E2E_USER ?? "admin", password } });
    if (!res.ok()) throw new Error(`E2E sign-in failed: ${res.status()} ${await res.text()}`);
    mkdirSync(".auth", { recursive: true });
    await api.storageState({ path: ".auth/state.json" });
  }
  const setup = await api.post("/api/v1/setup", { data: { mode: "standard" } });
  if (!setup.ok() && setup.status() !== 409) throw new Error(`E2E first-run setup failed: ${setup.status()} ${await setup.text()}`);
  await api.dispose();
}
