import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import { requestFileUpload } from "./composio-files.ts";

const request = { toolkit_slug: "googledrive", tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", filename: "report.pdf", mimetype: "application/pdf", md5: "0".repeat(32) };
const withKey = { composio: { apiKey: "ak_test" } } as unknown as AppConfig;
const service = { url: "https://connect.example", token: "d".repeat(64) };
const answering = (body: unknown, calls: Array<{ url: string; init?: RequestInit }> = []) => async (url: string, init?: RequestInit) => {
  calls.push({ url, init });
  return Response.json(body);
};

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("upload links for connected-app files", () => {
  it("asks Composio with the project key, and the service for a member's own installation", async () => {
    vi.stubEnv("OMB_COMPOSIO_API", undefined);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", answering({ key: "projects/p/requests/googledrive/report.pdf", new_presigned_url: "https://storage.composio.dev/p/report.pdf?X-Amz-Signature=1" }, calls));
    await expect(requestFileUpload(withKey, request)).resolves.toEqual({ key: "projects/p/requests/googledrive/report.pdf", url: "https://storage.composio.dev/p/report.pdf?X-Amz-Signature=1" });
    expect(calls[0]!.url).toBe("https://backend.composio.dev/api/v3.1/files/upload/request");
    expect(new Headers(calls[0]!.init?.headers).get("x-api-key")).toBe("ak_test");
    vi.stubGlobal("fetch", answering({ key: "k", url: "https://bucket.s3.us-east-1.amazonaws.com/k?X-Amz-Signature=1" }, calls));
    await expect(requestFileUpload(withKey, request, service)).resolves.toMatchObject({ key: "k" });
    expect(calls[1]!.url).toBe("https://connect.example/v1/files/upload");
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe(`Bearer ${service.token}`);
  });

  it("refuses a link anywhere but Composio's storage over HTTPS", async () => {
    vi.stubEnv("OMB_COMPOSIO_API", undefined);
    for (const link of ["https://attacker.example/put", "http://storage.composio.dev/put", "http://127.0.0.1:8787/put", "https://169.254.169.254/x", "https://storage.composio.dev.evil.example/x"]) {
      vi.stubGlobal("fetch", answering({ key: "k", new_presigned_url: link }));
      await expect(requestFileUpload(withKey, request), link).rejects.toThrow("not on its storage");
      vi.stubGlobal("fetch", answering({ key: "k", url: link }));
      await expect(requestFileUpload(withKey, request, service), link).rejects.toThrow("not on its storage");
    }
  });

  it("takes a link on this computer only from a service run on this computer", async () => {
    vi.stubGlobal("fetch", answering({ key: "k", url: "http://127.0.0.1:9000/upload/1" }));
    await expect(requestFileUpload(withKey, request, { url: "http://127.0.0.1:9000", token: service.token })).resolves.toMatchObject({ url: "http://127.0.0.1:9000/upload/1" });
  });
});
