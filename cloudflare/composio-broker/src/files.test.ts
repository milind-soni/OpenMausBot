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

const drive = (status = "ACTIVE") => Response.json({ items: [{ id: "ca_drive", status, toolkit: { slug: "googledrive" } }] });
/** Composio as the broker sees it: the installation's accounts, then the upload link it hands out. */
const composio = (link: unknown, accounts = drive()) => async (input: string | URL | Request) =>
  (String(input).includes("/connected_accounts") ? accounts.clone() : Response.json(link));

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
    const answer = composio({ id: "f1", key: "proj/googledrive/report.pdf", new_presigned_url: "https://storage.composio.dev/put?sig=1", type: "new" });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return answer(input);
    });
    const response = await worker.fetch(post(upload), env() as never, ctx as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ key: "proj/googledrive/report.pdf", url: "https://storage.composio.dev/put?sig=1" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/connected_accounts?");
    expect(new URL(calls[0]!.url).searchParams.get("user_ids")).toBe("omb_user");
    expect(calls[1]!.url).toBe("https://backend.composio.dev/api/v3.1/files/upload/request");
    expect(new Headers(calls[1]!.init?.headers).get("x-api-key")).toBe("ak_test");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual(upload);
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

  it("passes Composio's refusal on and hands out only HTTPS links on Composio's storage", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) =>
      (String(input).includes("/connected_accounts") ? drive() : Response.json({ message: "Toolkit not found" }, { status: 404 })));
    const refused = await worker.fetch(post(upload), env() as never, ctx as never);
    expect(refused.status).toBe(502);
    await expect(refused.json()).resolves.toEqual({ error: "Toolkit not found" });
    const r2 = `temp.${"0123456789abcdef".repeat(2)}.r2.cloudflarestorage.com`;
    for (const link of [
      "http://storage.composio.dev/put",
      "https://169.254.169.254/latest",
      "https://attacker.example/put",
      "https://storage.composio.dev.attacker.example/put",
      `http://${r2}/put`,
      `https://user:pass@${r2}/put`,
      `https://${r2}:444/put`,
      `https://${r2}.attacker.example/put`,
    ]) {
      vi.stubGlobal("fetch", composio({ key: "k", new_presigned_url: link }));
      expect((await worker.fetch(post(upload), env() as never, ctx as never)).status, link).toBe(502);
    }
    vi.stubGlobal("fetch", composio({ key: "k", new_presigned_url: "https://composio-files.s3.us-east-1.amazonaws.com/k?X-Amz-Signature=1" }));
    expect((await worker.fetch(post(upload), env() as never, ctx as never)).status).toBe(200);
    const r2Link = `https://${r2}/k?X-Amz-Signature=1`;
    vi.stubGlobal("fetch", composio({ key: "k", new_presigned_url: r2Link }));
    const uploaded = await worker.fetch(post(upload), env() as never, ctx as never);
    expect(uploaded.status).toBe(200);
    await expect(uploaded.json()).resolves.toEqual({ key: "k", url: r2Link });
  });

  it("hands out no link for a toolkit the installation has no working connection to", async () => {
    for (const accounts of [Response.json({ items: [] }), drive("EXPIRED")]) {
      const calls: string[] = [];
      const answer = composio({ key: "k", new_presigned_url: "https://storage.composio.dev/put" }, accounts);
      vi.stubGlobal("fetch", async (input: string | URL | Request) => { calls.push(String(input)); return answer(input); });
      const response = await worker.fetch(post(upload), env() as never, ctx as never);
      expect(response.status).toBe(409);
      expect(calls.some((url) => url.includes("/files/upload/request"))).toBe(false);
    }
  });
});
