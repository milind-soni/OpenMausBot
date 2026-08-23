import { describe, expect, it, vi } from "vitest";

import {
  UnattendedWorkAdapter,
  UnattendedWorkAdapterError,
  unattendedWorkAdapterFromEnv,
  unattendedWorkRequestIdFromPath,
} from "./unattended-work-adapter.ts";

interface TestResponseBody {
  schema?: string;
  request?: { id: string };
  pass?: boolean;
  error?: string;
  live_accepted?: boolean;
}

const response = (body: TestResponseBody, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("UnattendedWorkAdapter", () => {
  it("is disabled by default and never calls the loopback service", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new UnattendedWorkAdapter({ fetchImpl });

    expect(await adapter.health()).toMatchObject({
      status: "disabled",
      adapter: {
        enabled: false,
        executor: "hermes",
        runs_repo_tools: false,
        uses_full_task_profile: false,
      },
    });
    await expect(adapter.submit({})).rejects.toMatchObject({ status: 403 });
    await expect(adapter.status("work-12345678")).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-loopback, credentialed, and implicit-port targets", () => {
    for (const baseUrl of [
      "https://127.0.0.1:8817",
      "http://localhost:8817",
      "http://127.0.0.1",
      "http://user:pass@127.0.0.1:8817",
      "http://192.0.2.10:8817",
    ]) {
      expect(() => new UnattendedWorkAdapter({ baseUrl })).toThrow(UnattendedWorkAdapterError);
    }
  });

  it("submits one forced openmausbot envelope to the fixed endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      schema: "aos.unattended-work-submit.v1",
      request: { id: "work-12345678" },
      pass: true,
      live_accepted: false,
    }));
    const adapter = new UnattendedWorkAdapter({ enabled: true, fetchImpl });

    await expect(adapter.submit({
      schema: "aos.work-request.v1",
      repository: "owner/repo",
      issue: 1,
      idempotency_key: "work:owner/repo:1",
      card: {},
    })).resolves.toMatchObject({ pass: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [target, init] = fetchImpl.mock.calls[0];
    expect(String(target)).toBe("http://127.0.0.1:8817/v1/work");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init?.body))).toMatchObject({ ingress: "openmausbot" });
  });

  it("rejects submit receipts unless the work plane proves dormant acceptance", async () => {
    for (const body of [{ pass: true }, { pass: true, live_accepted: true }]) {
      const adapter = new UnattendedWorkAdapter({
        enabled: true,
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(body)),
      });
      await expect(adapter.submit({ ingress: "openmausbot" })).rejects.toMatchObject({
        status: 502,
        message: "unattended-work returned a non-dormant receipt",
      });
    }
  });

  it("decodes one status path segment exactly once", async () => {
    expect(unattendedWorkRequestIdFromPath("/api/unattended-work/work%3A123")).toBe("work:123");
    expect(unattendedWorkRequestIdFromPath("/api/unattended-work/work%253A123")).toBeNull();
    expect(unattendedWorkRequestIdFromPath("/api/unattended-work/work%2F123")).toBeNull();
    expect(unattendedWorkRequestIdFromPath("/api/unattended-work/%E0%A4%A")).toBeNull();

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ pass: true }));
    const adapter = new UnattendedWorkAdapter({ enabled: true, fetchImpl });
    await adapter.status("work:123");
    expect(String(fetchImpl.mock.calls[0][0])).toBe("http://127.0.0.1:8817/v1/work/work%3A123");
  });

  it("rejects ingress confusion and invalid status identifiers locally", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new UnattendedWorkAdapter({ enabled: true, fetchImpl });

    await expect(adapter.submit(JSON.parse('{"ingress":"telegram"}'))).rejects.toMatchObject({ status: 400 });
    await expect(adapter.status("../secrets")).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses only an explicit opt-in environment value", () => {
    expect(unattendedWorkAdapterFromEnv({ OMB_UNATTENDED_WORK_ENABLED: "true" }).enabled).toBe(false);
    expect(unattendedWorkAdapterFromEnv({ OMB_UNATTENDED_WORK_ENABLED: "1" }).enabled).toBe(true);
  });

  it("bounds a loopback response before parsing it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("x".repeat(256 * 1024 + 1)),
    );
    const adapter = new UnattendedWorkAdapter({ enabled: true, fetchImpl });

    await expect(adapter.health()).rejects.toThrow("response is too large");
  });
});
