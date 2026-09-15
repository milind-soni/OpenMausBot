// SupaMaus captures as a recall source (Phase 1 part 2): read over its local
// REST history with the token on disk, filtered in-process, cached, bounded.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { supamausClient } from "./supamaus.ts";

const history = [
  { id: "A", createdAt: "2026-09-15T05:17:14Z", appName: "ChatGPT", windowTitle: "ChatGPT", droppedItemText: "Fix all the bugs in our linear dashboard before raising PRs." },
  { id: "B", createdAt: "2026-09-15T03:59:14Z", appName: "OpenMausBot", windowTitle: "Bot settings", spokenTranscript: "remember the deploy password hint is blue falcon" },
  { id: "C", createdAt: "2026-09-14T03:59:14Z", appName: "Safari", windowTitle: "Linear – bugs", browserURL: "https://linear.app/x" },
];

function stub(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const dirs: string[] = [];
const tokenFile = (token?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "omb-supamaus-"));
  dirs.push(dir);
  const path = join(dir, "server-token");
  if (token !== undefined) writeFileSync(path, token);
  return path;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("supamausClient", () => {
  it("is disabled without a token file and never calls out", async () => {
    const { fetchImpl, calls } = stub(() => new Response("[]"));
    const client = supamausClient({ tokenPath: tokenFile(), fetch: fetchImpl });
    expect(client.enabled()).toBe(false);
    expect(await client.search("deploy password")).toEqual([]);
    expect(await client.recent(3_600_000)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("sends the token, filters history by the query's terms, and ranks the richer match first", async () => {
    let auth = "";
    const { fetchImpl, calls } = stub((_url, init) => {
      auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      return new Response(JSON.stringify(history), { headers: { "content-type": "application/json" } });
    });
    const client = supamausClient({ tokenPath: tokenFile("tok-1"), fetch: fetchImpl, url: "http://127.0.0.1:19741" });
    expect(client.enabled()).toBe(true);
    const hits = await client.search("what were the linear dashboard bugs");
    expect(auth).toBe("Bearer tok-1");
    expect(calls[0]).toContain("/v1/history");
    expect(hits.map((h) => h.id)).toEqual(["A", "C"]);
    expect(hits[0]).toMatchObject({ app: "ChatGPT", title: "ChatGPT" });
    expect(hits[0]!.text).toContain("Fix all the bugs");
    expect(hits[0]!.at).toBe(Date.parse("2026-09-15T05:17:14Z"));
    expect(await client.search("deploy password")).toMatchObject([{ id: "B" }]);
    // short query words are not terms
    expect(await client.search("a of")).toEqual([]);
    // filler words are not terms, and one shared word out of a long question is not a match
    expect(await client.search("Reply in one short line, please, with the number only")).toEqual([]);
    expect(await client.search("Create a text file called notes.txt in the working folder with three lines and print it, then report its dashboard")).toEqual([]);
  });

  it("serves a second read from the cache and lists recent captures newest first", async () => {
    const { fetchImpl, calls } = stub(() => new Response(JSON.stringify(history)));
    const now = Date.parse("2026-09-15T06:00:00Z");
    const client = supamausClient({ tokenPath: tokenFile("t"), fetch: fetchImpl, now: () => now });
    const recent = await client.recent(60 * 60 * 1000);
    expect(recent.map((h) => h.id)).toEqual(["A"]);
    await client.search("linear");
    expect(calls).toHaveLength(1);
  });

  it("reads the cache synchronously and primes it in the background, so the turn path never waits", async () => {
    const { fetchImpl, calls } = stub(() => new Response(JSON.stringify(history)));
    const now = Date.parse("2026-09-15T06:00:00Z");
    const client = supamausClient({ tokenPath: tokenFile("t"), fetch: fetchImpl, now: () => now });
    // cold: nothing yet, one refresh started
    expect(client.searchNow("linear")).toEqual([]);
    client.prime();
    client.prime();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    expect(client.searchNow("linear").map((h) => h.id)).toEqual(["A", "C"]);
    expect(client.recentNow(60 * 60 * 1000).map((h) => h.id)).toEqual(["A"]);
    // warm: prime is a no-op until the cache ages
    client.prime();
    expect(calls).toHaveLength(1);
  });

  it("gives up quietly when the server is slow or answers garbage", async () => {
    const slow = stub(() => new Promise<Response>(() => {}));
    const client = supamausClient({ tokenPath: tokenFile("t"), fetch: slow.fetchImpl, timeoutMs: 50 });
    expect(await client.search("linear")).toEqual([]);
    const garbage = stub(() => new Response("not json"));
    expect(await supamausClient({ tokenPath: tokenFile("t"), fetch: garbage.fetchImpl }).search("linear")).toEqual([]);
    const unauthorized = stub(() => new Response("{}", { status: 401 }));
    expect(await supamausClient({ tokenPath: tokenFile("t"), fetch: unauthorized.fetchImpl }).recent(1000)).toEqual([]);
  });
});
