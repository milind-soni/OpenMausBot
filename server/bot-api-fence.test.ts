import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BOT_API_PARTS, BOT_API_TOOLS, botApiRouteRefused } from "./bot-api-fence.ts";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (entry.isDirectory()) return entry.name === "testing" ? [] : sources(join(dir, entry.name));
  return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [join(dir, entry.name)] : [];
});

describe("what a Bot API turn may reach", () => {
  it("refuses every internal route in the source but the engine's hooks and its own long results", () => {
    const paths = new Set(sources(ROOT).flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\/api\/internal\/[a-z][a-z0-9/-]*[a-z0-9]/g)].map((match) => match[0])));
    expect(paths.size).toBeGreaterThan(40);
    for (const needed of ["/api/internal/threads", "/api/internal/session-search"]) expect(paths.has(needed), needed).toBe(true);
    const open = [...paths].filter((path) => ["GET", "POST", "PUT", "PATCH", "DELETE"].some((method) => !botApiRouteRefused(method, path))).sort();
    expect(open).toEqual(["/api/internal/hook", "/api/internal/tool-result"]);
  });

  it("takes the method as well as the path", () => {
    expect(botApiRouteRefused("POST", "/api/internal/hook")).toBe(false);
    expect(botApiRouteRefused("post", "/api/internal/hook")).toBe(false);
    expect(botApiRouteRefused("GET", "/api/internal/hook")).toBe(true);
    expect(botApiRouteRefused("DELETE", "/api/internal/tool-result")).toBe(true);
    expect(botApiRouteRefused("POST", "/api/internal/hook/x")).toBe(true);
    expect(botApiRouteRefused("POST", "/api/internal/threads")).toBe(true);
  });

  it("mounts only the engine's hooks and keeps only the bot's memory, where the message came from and how to read that", () => {
    expect([...BOT_API_TOOLS]).toEqual(["hooks"]);
    expect([...BOT_API_PARTS].sort()).toEqual(["coordination", "memory", "webhook"]);
  });
});
