import { describe, expect, it, vi } from "vitest";

const { syncCloudTimeZone } = await import("./CloudTimeZone");

function server(current: { timeZone?: string; adopts?: boolean }) {
  return vi.fn(async (_path: string, init?: RequestInit) => (init?.method === "PUT" ? { changed: true } : current)) as never as typeof import("@/state/store").api & ReturnType<typeof vi.fn>;
}

describe("the owner's device gives My Cloud its time zone", () => {
  it("sends this device's zone when the Cloud tells time in another", async () => {
    const request = server({ timeZone: "UTC", adopts: true });
    expect(await syncCloudTimeZone("Asia/Kolkata", request)).toBe(true);
    expect(request).toHaveBeenLastCalledWith("/api/time-zone", expect.objectContaining({ method: "PUT", body: JSON.stringify({ timeZone: "Asia/Kolkata" }) }));
  });

  it("sends nothing when the zones match, the server keeps its computer's own, or the device has none", async () => {
    for (const [current, zone] of [[{ timeZone: "Asia/Kolkata", adopts: true }, "Asia/Kolkata"], [{ timeZone: "UTC", adopts: false }, "Asia/Kolkata"], [{ timeZone: "UTC", adopts: true }, null]] as const) {
      const request = server(current);
      expect(await syncCloudTimeZone(zone, request)).toBe(false);
      expect(request.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
    }
  });
});
