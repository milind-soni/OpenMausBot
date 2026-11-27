import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { antigravityAccount } from "./antigravity-account.ts";

let home: string;
let path: string;
const credentials = { client_id: "synthetic-client", client_secret: "synthetic-secret", refresh_token: "synthetic-refresh", token_uri: "https://untrusted.invalid/token" };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "omb-google-identity-"));
  path = join(home, "acp_token.json");
  await writeFile(path, JSON.stringify(credentials));
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

it("returns only Google's email, pins destinations, caches and coalesces lookups without changing credentials", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "synthetic-access" }))
    .mockResolvedValueOnce(Response.json({ email: "one@example.test", other: "private" }));
  vi.stubGlobal("fetch", fetcher);
  const results = await Promise.all([antigravityAccount(path), antigravityAccount(path)]);
  expect(results).toEqual([{ email: "one@example.test", method: "login" }, { email: "one@example.test", method: "login" }]);
  expect(await antigravityAccount(path)).toEqual(results[0]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
  expect(fetcher.mock.calls[0][1].redirect).toBe("error");
  expect(fetcher.mock.calls[0][1].body.get("refresh_token")).toBe("synthetic-refresh");
  expect(fetcher.mock.calls[1][0]).toBe("https://www.googleapis.com/oauth2/v3/userinfo");
  expect(fetcher.mock.calls[1][1].headers).toEqual({ Authorization: "Bearer synthetic-access" });
  expect(await readFile(path, "utf8")).toBe(JSON.stringify(credentials));
});

it("invalidates identity on account replacement, keeps profiles separate and clears missing tokens", async () => {
  const fetcher = vi.fn().mockImplementation(async (url: string) => Response.json(url.endsWith("/token")
    ? { access_token: "synthetic" } : { email: `account${fetcher.mock.calls.length}@example.test` }));
  vi.stubGlobal("fetch", fetcher);
  expect((await antigravityAccount(path))?.email).toBe("account2@example.test");
  await writeFile(path, JSON.stringify({ ...credentials, refresh_token: "another" }));
  expect((await antigravityAccount(path))?.email).toBe("account4@example.test");
  const other = join(home, "other.json");
  await writeFile(other, JSON.stringify(credentials));
  expect((await antigravityAccount(other))?.email).toBe("account6@example.test");
  await rm(path);
  expect(await antigravityAccount(path)).toBeUndefined();
});

it.each(["{}", "null", "broken", JSON.stringify({ ...credentials, refresh_token: 12 }), "x".repeat(1024 * 1024 + 1)])("ignores unavailable or malformed credentials without a network request (%#)", async (raw) => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await writeFile(path, raw);
  expect(await antigravityAccount(path)).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["offline", "denied", "bad-token", "bad-email"])("keeps lookup failure nonfatal and avoids repeated requests: %s", async (mode) => {
  const fetcher = vi.fn().mockImplementation(async (url: string) => {
    if (mode === "offline") throw new Error("synthetic secret must not leak");
    if (mode === "denied") return new Response("private response", { status: 401 });
    return Response.json(url.endsWith("/token") ? { access_token: mode === "bad-token" ? null : "synthetic" } : { email: "not an email" });
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await antigravityAccount(path)).toBeUndefined();
  const calls = fetcher.mock.calls.length;
  expect(await antigravityAccount(path)).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(calls);
});
