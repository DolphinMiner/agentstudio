import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_URL, buildCsp, isExternalUrlAllowed, normalizeServerUrl, resolveServerUrl } from "../src/shared/config";

describe("server URL", () => {
  it("normalises", () => {
    expect(normalizeServerUrl(" http://127.0.0.1:18090/ ")).toBe("http://127.0.0.1:18090");
    expect(normalizeServerUrl("https://agentstudio.example.com/base/")).toBe("https://agentstudio.example.com/base");
  });
  it("rejects bad URLs", () => {
    for (const bad of ["127.0.0.1:18090", "ftp://x", "http://u:p@x", "http://x/?a=1", "http://x/#f", ""]) {
      expect(() => normalizeServerUrl(bad)).toThrow();
    }
  });
  it("resolves env, then saved, then default", () => {
    expect(resolveServerUrl("http://a:1", "http://b:2")).toBe("http://a:1");
    expect(resolveServerUrl(undefined, "http://b:2/")).toBe("http://b:2");
    expect(resolveServerUrl("nonsense", undefined)).toBe(DEFAULT_SERVER_URL);
    expect(resolveServerUrl(undefined, undefined)).toBe(DEFAULT_SERVER_URL);
  });
});

describe("CSP", () => {
  it("limits connect-src to the server origin", () => {
    const csp = buildCsp("http://127.0.0.1:18090");
    expect(csp).toContain("connect-src http://127.0.0.1:18090 ws://127.0.0.1:18090;");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain("unsafe-eval");
  });
  it("uses wss for https and adds the dev server in dev", () => {
    expect(buildCsp("https://p.example.com")).toContain("connect-src https://p.example.com wss://p.example.com;");
    const dev = buildCsp("http://127.0.0.1:18090", "http://localhost:5173/");
    expect(dev).toContain("http://localhost:5173 ws://localhost:5173");
    expect(dev).toContain("script-src 'self' 'unsafe-inline'");
  });
});

it("only opens web and mail links externally", () => {
  expect(isExternalUrlAllowed("https://example.com")).toBe(true);
  expect(isExternalUrlAllowed("mailto:a@b.c")).toBe(true);
  expect(isExternalUrlAllowed("file:///etc/passwd")).toBe(false);
  expect(isExternalUrlAllowed("javascript:alert(1)")).toBe(false);
  expect(isExternalUrlAllowed("not a url")).toBe(false);
});
