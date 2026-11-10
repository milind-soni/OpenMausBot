import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { ServerProfileBanner, serverProfileNotice } from "./ServerProfileBanner";

const config = (notice?: NonNullable<ConfigStatus["serverProfile"]>["notice"]): ConfigStatus =>
  ({ serverProfile: { profile: "hardened", boxed: !notice || notice.kind === "on", ...(notice ? { notice } : {}) } }) as ConfigStatus;

describe("server profile banner", () => {
  it("is silent unless the server sends a notice, which it sends to admins only", () => {
    expect(serverProfileNotice(null)).toBeNull();
    expect(serverProfileNotice(config())).toBeNull();
    expect(serverProfileNotice({} as ConfigStatus)).toBeNull();
    expect(renderToStaticMarkup(createElement(ServerProfileBanner, { config: config() }))).toBe("");
  });

  it("says once, in plain words, what changed when the profile came on", () => {
    const notice = serverProfileNotice(config({ kind: "on" }));
    expect(notice).toMatchObject({ tone: "info", dismissible: true });
    expect(notice!.text).toMatch(/^This server now runs its hardened profile\. Bots work in a sandbox/);
    expect(notice!.text).toMatch(/no longer act as its owner without signing in, apart from creating a pairing code/);
    const html = renderToStaticMarkup(createElement(ServerProfileBanner, { config: config({ kind: "on" }) }));
    expect(html).toContain('role="status"');
    expect(html).toContain("<button");
  });

  it("keeps saying a shared server's bots are not sandboxed, with the fix, and offers no way to wave it off", () => {
    const notice = serverProfileNotice(config({ kind: "unboxed", fault: "no-bwrap", shared: true, dismissible: false }));
    expect(notice).toEqual({
      tone: "danger", dismissible: false,
      text: "Bots on this server are not running in a sandbox: anyone who can chat with a bot can make it read the server's AI keys, saved logins and other people's chats, and change its settings, including who may sign in. Install bubblewrap on the server (on Debian or Ubuntu: sudo apt-get install -y bubblewrap) and start it again.",
    });
    expect(renderToStaticMarkup(createElement(ServerProfileBanner, { config: config({ kind: "unboxed", fault: "no-bwrap", shared: true, dismissible: false }) }))).not.toContain("<button");
  });

  it("tells a one-owner server once, and names each fault's own fix", () => {
    const text = (fault: "switched-off" | "not-linux" | "no-bwrap" | "userns-refused") =>
      serverProfileNotice(config({ kind: "unboxed", fault, shared: false, dismissible: true }))!;
    expect(text("userns-refused")).toMatchObject({ tone: "warning", dismissible: true });
    expect(text("userns-refused").text).toMatch(/a bot that follows a harmful web page could read the server's AI keys and change its settings\. .*"The hardened profile"/);
    expect(text("switched-off").text).toContain("Remove OMB_BOT_BOX=0");
    expect(text("not-linux").text).toContain("The sandbox needs Linux");
  });

  it("asks for a restart after a second person was added", () => {
    expect(serverProfileNotice(config({ kind: "restart" }))).toMatchObject({ tone: "warning", dismissible: false, text: expect.stringMatching(/^The people you added can sign in once this server has started again\./) });
  });
});
