import { afterEach, describe, expect, it, vi } from "vitest";
import { requestMessageFile } from "./AttachmentPreview";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FilePreviewDialog file fetching", () => {
  const message = { threadId: "thread-abc", messageId: "msg-123" };
  const filePath = "/workspace/report.md";

  it("requests message file through the authenticated message endpoint", async () => {
    const fetcher = vi.fn(async () => new Response("# Title\n\nContent here", {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetcher);

    const signal = new AbortController().signal;
    const response = await requestMessageFile(filePath, message, signal);

    expect(fetcher).toHaveBeenCalledWith("/api/threads/thread-abc/messages/msg-123/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath }),
      signal,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# Title\n\nContent here");
  });

  it("handles authorization errors from the server", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized file" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);

    const signal = new AbortController().signal;
    await expect(requestMessageFile(filePath, message, signal)).rejects.toThrow("Unauthorized file");
  });
});
