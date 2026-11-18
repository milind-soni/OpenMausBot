import { describe, expect, it } from "vitest";

import { createXRelayClient, TREG_X_ENDPOINTS } from "./x-research.ts";

const post = (id: string, extra: Record<string, unknown> = {}) => ({ id, text: `post ${id}`, authorUsername: "maus", ...extra });
const page = (ids: string[], nextCursor?: string) => ({ output: { data: { items: ids.map((id) => post(id)), nextCursor } } });

function fixture(responses: unknown[]) {
  const requests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ endpoint: new URL(String(input)).pathname.split("/").at(-1)!, body: JSON.parse(String(init?.body)) });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected extra billed request");
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  };
  return { client: createXRelayClient({ url: "https://relay.example.test/x", token: "fixture", fetcher }), requests };
}

describe("X research pagination", () => {
  it("counts unique posts toward the requested limit across overlapping pages", async () => {
    const { client, requests } = fixture([
      page(["9", "8"], "second"),
      page(["8", "7"], "third"),
      page(["7", "6"]),
    ]);
    const result = await client.search({ query: "maus", sort: "latest", limit: 4 });
    expect(result.posts.map((item) => item.id)).toEqual(["9", "8", "7", "6"]);
    expect(requests.map((request) => request.body.cursor)).toEqual([undefined, "second", "third"]);
    expect(result).toMatchObject({ newestId: "9", more: false });
  });

  it("keeps the first occurrence and does not report duplicate rows as truncated results", async () => {
    const { client, requests } = fixture([{ output: { data: { items: [post("5", { text: "first result" }), post("5", { text: "duplicate result" }), post("4")] } } }]);
    const result = await client.userPosts({ handle: "maus", includeReplies: true, limit: 2 });
    expect(result.posts.map((item) => item.id)).toEqual(["5", "4"]);
    expect(result.posts[0]!.text).toBe("first result");
    expect(result.more).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("stops before purchasing a repeated continuation page and leaves more true", async () => {
    const { client, requests } = fixture([
      page(["9", "8"], "stuck"),
      page(["8", "7"], "stuck"),
      page(["7", "6"], "stuck"),
    ]);
    const result = await client.search({ query: "maus", sort: "top", limit: 20 });
    expect(requests).toHaveLength(2);
    expect(result.posts.map((item) => item.id)).toEqual(["9", "8", "7"]);
    expect(result.more).toBe(true);
  });

  it("deduplicates reply rows through the shared list path", async () => {
    const { client, requests } = fixture([
      { output: { data: post("10") } },
      { output: { data: { replies: [post("12"), post("12"), post("11")] } } },
    ]);
    const result = await client.post({ id: "10", replies: true });
    expect(result.replies?.map((item) => item.id)).toEqual(["12", "11"]);
    expect(result.moreReplies).toBe(false);
    expect(requests.map((request) => request.endpoint)).toEqual([TREG_X_ENDPOINTS.post, TREG_X_ENDPOINTS.replies]);
  });

  it("continues after a duplicate-only page when its cursor advances", async () => {
    const { client, requests } = fixture([
      page(["9"], "second"),
      page(["9"], "third"),
      page(["8"]),
    ]);
    const result = await client.search({ query: "maus", sort: "latest", limit: 2 });
    expect(requests).toHaveLength(3);
    expect(result.posts.map((item) => item.id)).toEqual(["9", "8"]);
    expect(result.more).toBe(false);
  });
});
