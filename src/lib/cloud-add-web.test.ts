import { afterEach, describe, expect, it, vi } from "vitest";

import { CLOUD_SOURCES } from "@/lib/cloud-plan";
import { cloudAccountBridge, cloudWebHop, openCloudOnWeb } from "./cloud-add-web";

const away = { cloudHome: false };

afterEach(() => { vi.unstubAllGlobals(); });

describe("Add a Cloud without the desktop's own sign-in", () => {
  it("opens the plan's checkout on the Cloud website, tagged with the button that asked", () => {
    expect(cloudWebHop({ source: "app_onboarding" }, away)).toEqual({ url: "https://cloud.openmausbot.com/pro/buy?src=app_onboarding", via: "web", plan: "pro" });
    expect(cloudWebHop({ source: "app_card" }, away).url).toBe("https://cloud.openmausbot.com/pro/buy?src=app_card");
    expect(cloudWebHop({ source: "app_whats_new_pro" }, away).url).toBe("https://cloud.openmausbot.com/pro/buy?src=app_whats_new_pro");
    expect(cloudWebHop({ source: "app_whats_new_team" }, away)).toEqual({ url: "https://cloud.openmausbot.com/pro/buy?plan=team&src=app_whats_new_team", via: "web", plan: "team" });
    for (const source of CLOUD_SOURCES) expect(new URL(cloudWebHop({ source }, away).url).searchParams.get("src"), source).toBe(source);
  });

  it("Sign in, and anything asked on a Cloud, opens the account's own page on the Cloud website instead of a second checkout", () => {
    expect(cloudWebHop({ source: "app_settings", signIn: true }, away)).toEqual({ url: "https://cloud.openmausbot.com/cloud?src=app_settings", via: "cloud_page" });
    expect(cloudWebHop({ source: "app_card" }, { cloudHome: true })).toEqual({ url: "https://cloud.openmausbot.com/cloud?src=app_card", via: "cloud_page" });
    expect(cloudWebHop({ source: "app_settings" }, { cloudHome: true, teamCloudPage: "https://omb-cloud-staging.fly.dev/cloud" }).url)
      .toBe("https://omb-cloud-staging.fly.dev/cloud?src=app_settings");
    expect(cloudWebHop({ source: "app_settings", signIn: true }, { cloudHome: false, teamCloudPage: "https://omb-cloud-staging.fly.dev/cloud" }).url)
      .toBe("https://cloud.openmausbot.com/cloud?src=app_settings");
  });

  it("opens a new tab in a browser, through main on a desktop", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    openCloudOnWeb({ source: "app_onboarding" }, away);
    expect(open).toHaveBeenCalledExactlyOnceWith("https://cloud.openmausbot.com/pro/buy?src=app_onboarding", "_blank", "noopener,noreferrer");
    const openExternal = vi.fn(async () => {});
    vi.stubGlobal("window", { open, ogb: { openExternal, remoteClient: { active: true } } });
    openCloudOnWeb({ source: "app_card" }, { cloudHome: true });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://cloud.openmausbot.com/cloud?src=app_card");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("only the desktop's own page has the sign-in Add a Cloud runs on", () => {
    const cloudAccount = { state: vi.fn() };
    vi.stubGlobal("window", {});
    expect(cloudAccountBridge()).toBeUndefined();
    vi.stubGlobal("window", { ogb: { cloudAccount, remoteClient: { active: true } } });
    expect(cloudAccountBridge()).toBeUndefined();
    vi.stubGlobal("window", { ogb: { cloudAccount, remoteClient: { active: false } } });
    expect(cloudAccountBridge()).toBe(cloudAccount);
  });
});
