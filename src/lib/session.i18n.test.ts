import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "./i18n";
import { BROWSER_SIGN_IN_FAILED, defaultDeviceLabel, pairWithCode, reasonWorthShowing, SERVICE_TRUST_REASON, startEmailSignIn } from "./session";

afterEach(() => setLocale("en"));

describe("Chinese sign-in copy", () => {
  it.each(["zh", "zh-tw"])("localizes fixed network prefixes in %s while retaining diagnostics", async (code) => {
    setLocale(code);
    const failedFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("EHOSTUNREACH"));
    const paired = await pairWithCode({ code: "fixture", label: "Fixture" }, failedFetch);
    const emailed = await startEmailSignIn("fixture@example.invalid", failedFetch);
    for (const result of [paired, emailed]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(code === "zh" ? "无法连接到服务器" : "無法連線至伺服器");
        expect(result.error).toContain("EHOSTUNREACH");
      }
    }
    expect(reasonWorthShowing(SERVICE_TRUST_REASON)).not.toBe(SERVICE_TRUST_REASON);
    expect(reasonWorthShowing(BROWSER_SIGN_IN_FAILED)).not.toBe(BROWSER_SIGN_IN_FAILED);
    expect(defaultDeviceLabel("Mozilla Chrome/150 Mac OS X")).not.toContain(" on ");
    expect(reasonWorthShowing("vendor diagnostic E123")).toBe("vendor diagnostic E123");
  });
});
