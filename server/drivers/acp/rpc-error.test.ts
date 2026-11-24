import { describe, expect, it } from "vitest";
import { acpRpcError, retryTransient } from "./rpc-error.ts";

describe("retryTransient", () => {
  const ok = async <T>(value: T) => value;

  it("retries a transient transport blip once and succeeds", async () => {
    let calls = 0;
    const value = await retryTransient(async () => {
      calls++;
      if (calls === 1) throw acpRpcError({ code: -32603, message: "Internal error", data: { details: "HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max retries exceeded with url: /token (Caused by SSLError(SSLEOFError(8, '[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1082)')))" } }, "authenticate");
      return "done";
    }, "authenticate", {});
    expect(value).toBe("done");
    expect(calls).toBe(2);
  });

  it("rethrows when the retry fails too", async () => {
    let calls = 0;
    await expect(retryTransient(async () => {
      calls++;
      throw new Error("fetch failed");
    }, "authenticate", {})).rejects.toThrow("fetch failed");
    expect(calls).toBe(2);
  });

  it("never retries an auth refusal or an invalid request", async () => {
    for (const message of ["Authentication required (authenticate)", "Request failed (authenticate)", "authenticate timed out"]) {
      let calls = 0;
      await expect(retryTransient(async () => {
        calls++;
        throw new Error(message);
      }, "authenticate", {})).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  it("passes a clean result through untouched", async () => {
    expect(await retryTransient(() => ok({ id: 1 }), "authenticate", {})).toEqual({ id: 1 });
  });
});
