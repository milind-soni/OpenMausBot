import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "./index";

const token = "b".repeat(64);
const upload = { toolkit_slug: "googledrive", tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", filename: "report.pdf", mimetype: "application/pdf", md5: "0".repeat(32) };

function env(limited = false) {
  return {
    COMPOSIO_API_BASE: "https://backend.composio.dev/api/v3.1",
    COMPOSIO_API_KEY: "ak_test",
    SESSION_LIMITER: { limit: async () => ({ success: !limited }) },
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              run: async () => ({ meta: { changes: 1 } }),
              first: async () => (sql.includes("FROM installations") ? { id: "install-1", composio_user_id: "omb_user", session_id: "trs_files", disabled_at: null } : null),
            };
          },
        };
      },
    },
  };
}

const ctx = { waitUntil(promise: Promise<unknown>) { void promise; } };
const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }) => new Request("https://broker.test/v1/files/upload", {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify(body),
});

afterEach(() => vi.unstubAllGlobals());

describe("file uploads for connected-app tools", () => {
  it("asks Composio for an upload link with the project key and hands back only the link and key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({ id: "f1", key: "proj/googledrive/report.pdf", new_presigned_url: "https://storage.composio.dev/put?sig=1", type: "new" });
    });
    const response = await worker.fetch(post(upload), env() as never, ctx as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ key: "proj/googledrive/report.pdf", url: "https://storage.composio.dev/put?sig=1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://backend.composio.dev/api/v3.1/files/upload/request");
    expect(new Headers(calls[0]!.init?.headers).get("x-api-key")).toBe("ak_test");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(upload);
  });

  it("refuses an unknown caller, a malformed request and a rate-limited installation before asking Composio", async () => {
    const fetchSpy = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchSpy);
    expect((await worker.fetch(post(upload, {}), env() as never, ctx as never)).status).toBe(401);
    for (const bad of [{ ...upload, md5: "nope" }, { ...upload, filename: "../x.pdf" }, { ...upload, tool_slug: "googledrive_upload" }, { ...upload, extra: 1 }]) {
      expect((await worker.fetch(post(bad), env() as never, ctx as never)).status).toBe(400);
    }
    expect((await worker.fetch(post(upload), env(true) as never, ctx as never)).status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes Composio's refusal on and never hands out a link that is not HTTPS", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ message: "Toolkit not found" }, { status: 404 }));
    const refused = await worker.fetch(post(upload), env() as never, ctx as never);
    expect(refused.status).toBe(502);
    await expect(refused.json()).resolves.toEqual({ error: "Toolkit not found" });
    vi.stubGlobal("fetch", async () => Response.json({ key: "k", new_presigned_url: "http://169.254.169.254/latest" }));
    expect((await worker.fetch(post(upload), env() as never, ctx as never)).status).toBe(502);
  });
});
