import { describe, expect, it, vi } from "vitest";
import { createDesktopIncludedPages } from "./included-pages.mjs";

const access = { url: "https://cloud.openmausbot.com/api/cloud/pages/token", token: `omb_pd_${"a".repeat(43)}` };
const signedIn = (deviceId = "device-1", plan = "free") =>
  ({ status: "connected", deviceId, entitlement: plan === "free" ? { plan: "free", status: "inactive", tier: null } : { plan: "pro", status: "active", tier: plan } });

function desktop(pagesAccess = vi.fn(async () => access)) {
  const posted = [];
  const server = { postMessage: (message) => posted.push(message) };
  const pages = createDesktopIncludedPages({ account: () => ({ pagesAccess }), server: () => server, log: () => {} });
  return { pages, posted, pagesAccess };
}

describe("published pages' access on the desktop", () => {
  it("hands a free sign-in's pages token to the server, as a paid one's", async () => {
    for (const plan of ["free", "pro"]) {
      const { pages, posted, pagesAccess } = desktop();
      await pages.onState(signedIn("device-1", plan));
      expect(pagesAccess, plan).toHaveBeenCalledTimes(1);
      expect(posted, plan).toEqual([{ type: "openmausbot:included-pages", access }]);
    }
  });

  it("asks once per sign-in, not when the plan changes or the state refreshes, and sends it again to a restarted server", async () => {
    const { pages, posted, pagesAccess } = desktop();
    await pages.onState(signedIn());
    await pages.onState(signedIn("device-1", "pro"));
    await pages.onState({ ...signedIn(), checking: true });
    expect(pagesAccess).toHaveBeenCalledTimes(1);
    pages.serverStarted();
    expect(posted).toEqual([{ type: "openmausbot:included-pages", access }, { type: "openmausbot:included-pages", access }]);
  });

  it("clears the server's token on sign-out or a sign-in to redo, and asks again for a new sign-in", async () => {
    for (const next of [{ status: "signed-out" }, { status: "reauth-required", message: "expired" }]) {
      const { pages, posted } = desktop();
      await pages.onState(signedIn());
      await pages.onState(next);
      expect(posted.at(-1), JSON.stringify(next)).toEqual({ type: "openmausbot:included-pages", access: null });
    }
    const { pages, pagesAccess } = desktop();
    await pages.onState(signedIn("device-1"));
    await pages.onState(signedIn("device-2"));
    expect(pagesAccess).toHaveBeenCalledTimes(2);
  });

  it("tells the server when the Admin has no pages for this sign-in yet, so a bot never asks a signed-in person to sign in", async () => {
    // Seen in the real app on Oct 22 against an Admin without pages: the bot was told "Publishing a page needs a MausBot
    // account. Sign in to MausBot in the app's Settings", while this computer was signed in.
    const { pages, posted } = desktop(vi.fn(async () => null));
    await pages.onState(signedIn());
    expect(posted).toEqual([{ type: "openmausbot:included-pages", access: null, offered: false }]);
  });
});
