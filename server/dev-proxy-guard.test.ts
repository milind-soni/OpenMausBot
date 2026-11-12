import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("dev:network API proxy", () => {
  it("forwards capability asset GETs but never opaque API reads or writes", async () => {
    const { default: config } = await vi.importActual<{ default: unknown }>("../vite.config.ts");
    const proxy = (config as any).server.proxy["/api"];
    const asset = `/api/preview/asset/${"a".repeat(64)}/project/style.css`;
    for (const [method, url, allowed] of [["GET", asset, true], ["POST", asset, false], ["GET", "/api/bots", false], ["GET", "/api/preview/file/project/style.css", false]]) {
      const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
      proxy.bypass({ method, url, headers: { host: "127.0.0.1:5199", origin: "null", "sec-fetch-site": "cross-site" } }, res);
      expect(res.end.mock.calls.length).toBe(allowed ? 0 : 1);
    }
  });

  it("permits the LAN page but blocks foreign origins before forwarding project writes", async () => {
    vi.stubEnv("VITE_HOST", "0.0.0.0");
    vi.resetModules();
    const { default: config } = await vi.importActual<{ default: unknown }>("../vite.config.ts");
    const proxy = (config as any).server.proxy["/api"];
    const routes = ["/api/projects/add-existing", "/api/projects/create", "/api/projects/clone"];

    const response = () => ({ statusCode: 200, setHeader: vi.fn(), end: vi.fn() });
    const sameOrigin = response();
    expect(proxy.bypass({ url: routes[0], headers: {
      host: "192.168.1.20:5199",
      origin: "http://192.168.1.20:5199",
      "sec-fetch-site": "same-origin",
    } }, sameOrigin)).toBeUndefined();
    expect(sameOrigin.end).not.toHaveBeenCalled();

    for (const route of routes) {
      for (const headers of [
        { host: "192.168.1.20:5199", origin: "https://evil.example" },
        { host: "192.168.1.20:5199", "sec-fetch-site": "cross-site" },
      ]) {
        const rejected = response();
        expect(proxy.bypass({ url: route, headers }, rejected)).toBe(route);
        expect(rejected.statusCode).toBe(403);
        expect(rejected.end).toHaveBeenCalledWith(expect.stringContaining("cross-origin request refused"));
      }
    }
  });
});
