import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import { requestFileUpload, UploadServiceOutdatedError } from "./composio-files.ts";

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
    await expect(requestFileUpload(withKey, request, service)).resolves.toMatchObject({ key: "k", url: "https://bucket.s3.us-east-1.amazonaws.com/k?X-Amz-Signature=1" });
    expect(calls[1]!.url).toBe("https://connect.example/v1/files/upload");
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe(`Bearer ${service.token}`);
  });

  it("accepts a presigned upload link on Composio's Cloudflare R2 storage", async () => {
    vi.stubEnv("OMB_COMPOSIO_API", undefined);
    const link = `https://temp.${"0123456789abcdef".repeat(2)}.r2.cloudflarestorage.com/517680/googledrive/report.pdf?X-Amz-Signature=1`;
    vi.stubGlobal("fetch", answering({ key: "projects/p/requests/googledrive/report.pdf", new_presigned_url: link }));
    await expect(requestFileUpload(withKey, request)).resolves.toEqual({ key: "projects/p/requests/googledrive/report.pdf", url: link });
    vi.stubGlobal("fetch", answering({ key: "k", url: link }));
    await expect(requestFileUpload(withKey, request, service)).resolves.toEqual({ key: "k", url: link });
  });

  it("refuses a link anywhere but Composio's storage over HTTPS", async () => {
    vi.stubEnv("OMB_COMPOSIO_API", undefined);
    const account = "0123456789abcdef".repeat(2);
    const r2 = `temp.${account}.r2.cloudflarestorage.com`;
    for (const link of [
      "https://attacker.example/put",
      "http://storage.composio.dev/put",
      "http://127.0.0.1:8787/put",
      "https://169.254.169.254/x",
      "https://storage.composio.dev.evil.example/x",
      `http://${r2}/put`,
      `https://user:pass@${r2}/put`,
      `https://${r2}:444/put`,
      `https://${r2}.attacker.example/x`,
      `https://r2.cloudflarestorage.com/put`,
    ]) {
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
  it("says the connected-apps service is out of date when it has no upload route", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "not found" }, { status: 404 }));
    const outdated = requestFileUpload(withKey, request, service);
    await expect(outdated).rejects.toBeInstanceOf(UploadServiceOutdatedError);
    await expect(outdated).rejects.toThrow("out of date");
  });

  it("keeps the answer's own error for other failures and for Composio's 404", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "googledrive is not connected" }, { status: 409 }));
    await expect(requestFileUpload(withKey, request, service)).rejects.toThrow("googledrive is not connected");
    vi.stubGlobal("fetch", async () => Response.json({ error: "not found" }, { status: 404 }));
    const fromComposio = requestFileUpload(withKey, request);
    await expect(fromComposio).rejects.toThrow("not found");
    await expect(fromComposio).rejects.not.toBeInstanceOf(UploadServiceOutdatedError);
  });
});
