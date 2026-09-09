import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/state/store";
import { codexDeviceLink, deviceFlowUnavailable, DeviceSignInProgress, type DeviceSignInStatus } from "./CodexDeviceSignIn";

afterEach(() => vi.unstubAllGlobals());

const waiting: DeviceSignInStatus = {
  phase: "waiting",
  flowId: "fixture-flow",
  authorizationUrl: "https://auth.openai.com/codex/device",
  userCode: "ABCD-12345",
  expiresAt: "2030-01-01T12:00:00.000Z",
};
const render = (auth: DeviceSignInStatus) => renderToStaticMarkup(createElement(DeviceSignInProgress, { auth }));

describe("Codex device sign-in UI", () => {
  it("shows the one-time code and an explicit official link, not a terminal command", () => {
    const html = render(waiting);
    expect(html).toContain("ABCD-12345");
    expect(html).toContain('href="https://auth.openai.com/codex/device"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Copy sign-in code");
    expect(html).toContain("Waiting for you");
    expect(html).not.toContain("codex login");
  });

  it.each([
    "http://auth.openai.com/codex/device",
    "https://auth.openai.com.evil.test/codex/device",
    "https://evil.test/",
    "https://auth.openai.com@evil.test/codex/device",
    "https://user@auth.openai.com/codex/device",
    "https://auth.openai.com/codex/device?redirect=evil",
    "https://auth.openai.com/codex/device#token",
    "javascript:alert(1)",
  ])("does not expose an unexpected sign-in URL: %s", (url) => {
    expect(codexDeviceLink(url)).toBeNull();
    const html = render({ ...waiting, authorizationUrl: url });
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("href=");
    expect(html).not.toContain(waiting.userCode);
  });

  it("does not render an invalid code or expired challenge as actionable", () => {
    expect(render({ ...waiting, userCode: "this is not a device code" })).not.toContain("href=");
    const expired = render({ ...waiting, phase: "expired" });
    expect(expired).toContain("code expired");
    expect(expired).not.toContain(waiting.userCode);
    expect(expired).not.toContain("href=");
  });

  it.each(["succeeded", "cancelled", "failed"] as const)("renders the %s result without retaining the code", (phase) => {
    const html = render({ ...waiting, phase });
    expect(html).toContain('role="status"');
    expect(html).not.toContain(waiting.userCode);
    expect(html).not.toContain("href=");
  });

  it.each([401, 403, 404, 410])("stops an obsolete flow after HTTP %i instead of retrying forever", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "This flow no longer exists" }), { status })));
    const cause = await api("/fixture/auth/status").catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(ApiError);
    expect(cause.status).toBe(status);
    expect(deviceFlowUnavailable(cause)).toBe(true);
  });

  it("keeps transient network/provider failures retryable", () => {
    expect(deviceFlowUnavailable(new Error("Network interrupted"))).toBe(false);
    expect(deviceFlowUnavailable(new ApiError("Temporarily busy", 503))).toBe(false);
    expect(deviceFlowUnavailable(new ApiError("Rate limited", 429))).toBe(false);
  });
});
