import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebServer, resolvePath } from "../scripts/serve-web.mjs";

let dir: string;
let base: string;
let server: ReturnType<typeof createWebServer>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentstudio-web-"));
  writeFileSync(join(dir, "index.html"), "<html>app</html>");
  mkdirSync(join(dir, "_expo"));
  writeFileSync(join(dir, "_expo", "a.js"), "console.log(1)");
  server = createWebServer(dir);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("serve-web", () => {
  it("serves files with a content type", async () => {
    const res = await fetch(`${base}/_expo/a.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });
  it("falls back to index.html for app routes", async () => {
    const res = await fetch(`${base}/inbox/some-room`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>app</html>");
  });
  it("404s for missing assets", async () => {
    expect((await fetch(`${base}/missing.png`)).status).toBe(404);
  });
  it("never leaves the root", () => {
    expect(resolvePath(dir, "/../../etc/passwd")).toBeNull();
    expect(resolvePath(dir, "/%2e%2e/secret")).toBeNull();
    expect(resolvePath(dir, "/ok.js")).toBe(join(dir, "ok.js"));
  });
});
