import { describe, expect, it, vi } from "vitest";

import { EnvironmentDingTalkCredentialProvider, readDingTalkConfiguration } from "./config.ts";
import { safeErrorCode, stableIdentifierHash } from "./safe-log.ts";
import { FetchDingTalkSessionSender } from "./sender.ts";

describe("DingTalk transport security", () => {
  it("is disabled by default and fails closed when enabled without both credentials", () => {
    expect(readDingTalkConfiguration({})).toEqual({ enabled: false, configured: false, state: "disabled" });
    expect(readDingTalkConfiguration({ OMB_DINGTALK_ENABLED: "1", OMB_DINGTALK_CLIENT_ID: "client" })).toEqual({
      enabled: true,
      configured: false,
      state: "needs_configuration",
      missing: ["OMB_DINGTALK_CLIENT_SECRET"],
    });
  });

  it("returns credentials only from the provider and never from public configuration state", () => {
    const environment = {
      OMB_DINGTALK_ENABLED: "1",
      OMB_DINGTALK_CLIENT_ID: "client-id",
      OMB_DINGTALK_CLIENT_SECRET: "super-secret-value",
      OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID: "open-1",
    };
    expect(new EnvironmentDingTalkCredentialProvider(environment).load()).toEqual({
      clientId: "client-id",
      clientSecret: "super-secret-value",
    });
    const visible = JSON.stringify(readDingTalkConfiguration(environment));
    expect(visible).not.toContain("super-secret-value");
    expect(visible).not.toContain("client-id");
  });

  it("never turns arbitrary secret-shaped exceptions or action tokens into log fields", () => {
    expect(safeErrorCode(new Error("superSecretActionToken123456"))).toBe("dingtalk_transport_error");
    expect(stableIdentifierHash("opaque-action-token")).toMatch(/^[0-9a-f]{16}$/u);
    expect(stableIdentifierHash("opaque-action-token")).not.toContain("opaque-action-token");
  });

  it("rejects non-DingTalk and redirecting session webhooks", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    const sender = new FetchDingTalkSessionSender(fetcher);
    await expect(sender.send("https://attacker.invalid/steal", {})).rejects.toThrow("dingtalk_session_webhook_invalid");
    expect(fetcher).not.toHaveBeenCalled();
    await sender.send("https://oapi.dingtalk.com/robot/sendBySession?session=opaque", { text: "safe" });
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "oapi.dingtalk.com" }),
      expect.objectContaining({ redirect: "error" }),
    );
  });
});
