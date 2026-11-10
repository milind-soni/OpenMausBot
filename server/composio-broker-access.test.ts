import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { brokerAccess, eraseManagedBrokerInstallation, setManagedBrokerAccess } from "./composio-broker-access.ts";

const access = { url: "https://broker.example", token: "a".repeat(64) };
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function broker(...answers: Response[]) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => answers.shift() ?? answer(500, {}));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => setManagedBrokerAccess(access));
afterEach(() => {
  vi.unstubAllGlobals();
  setManagedBrokerAccess(null);
});

describe("eraseManagedBrokerInstallation", () => {
  it("calls the erase route with the installation token, then forgets the token", async () => {
    const fetchMock = broker(answer(200, { erased: true, sharedUserKept: false }));
    const clearStored = vi.fn();
    await expect(eraseManagedBrokerInstallation(clearStored)).resolves.toEqual({ sharedUserKept: false });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://broker.example/v1/installation");
    expect(init).toMatchObject({ method: "DELETE", redirect: "error", headers: { authorization: `Bearer ${access.token}` } });
    expect(brokerAccess()).toBeNull();
    expect(clearStored).toHaveBeenCalledOnce();
  });

  it("calls again while the service says there is more, and reports connected apps kept for a shared user", async () => {
    const fetchMock = broker(answer(202, { erased: false, more: true }), answer(202, { erased: false, more: true }), answer(200, { erased: true, sharedUserKept: true }));
    await expect(eraseManagedBrokerInstallation()).resolves.toEqual({ sharedUserKept: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(brokerAccess()).toBeNull();
  });

  it("keeps the token when the service fails, so the call can be repeated", async () => {
    broker(answer(502, { error: "Composio could not delete the trigger (500)" }));
    const clearStored = vi.fn();
    await expect(eraseManagedBrokerInstallation(clearStored)).rejects.toThrow("Composio could not delete the trigger");
    expect(brokerAccess()).toEqual(access);
    expect(clearStored).not.toHaveBeenCalled();
  });

  it("treats a refused token as already erased: an earlier answer may have been lost", async () => {
    broker(answer(401, { error: "unauthorized" }));
    await expect(eraseManagedBrokerInstallation()).resolves.toEqual({ sharedUserKept: false });
    expect(brokerAccess()).toBeNull();
  });

  it("does nothing without a managed service", async () => {
    setManagedBrokerAccess(null);
    const fetchMock = broker();
    await expect(eraseManagedBrokerInstallation()).rejects.toThrow("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
