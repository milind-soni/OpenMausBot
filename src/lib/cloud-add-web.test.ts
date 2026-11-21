import { afterEach, describe, expect, it, vi } from "vitest";

import { CLOUD_SOURCES } from "@/lib/cloud-plan";
import { cloudAccountBridge, cloudWebHop, openCloudOnWeb } from "./cloud-add-web";

const away = { cloudHome: false };
afterEach(() => vi.unstubAllGlobals());

describe("Add a Cloud without the desktop's own sign-in", () => {
  it("never falls back to an upstream cloud or checkout", () => {
    for (const source of CLOUD_SOURCES) expect(cloudWebHop({ source }, away)).toBeNull();
    expect(cloudWebHop({ source: "app_settings", signIn: true }, away)).toBeNull();
    expect(cloudWebHop({ source: "app_card" }, { cloudHome: true })).toBeNull();
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    openCloudOnWeb({ source: "app_card" }, away);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the configured team's own cloud page", () => {
    const openExternal = vi.fn(async () => {});
    vi.stubGlobal("window", { ogb: { openExternal } });
    const place = { cloudHome: true, teamCloudPage: "https://cloud.example.test/cloud" };
    openCloudOnWeb({ source: "app_card" }, place);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://cloud.example.test/cloud?src=app_card");
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
