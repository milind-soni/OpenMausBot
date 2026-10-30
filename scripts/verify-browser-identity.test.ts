import { describe, expect, it } from "vitest";

import { expectedUserAgent } from "./testing/browser-identity-probe.ts";
import { completeHints, headerLanguages, openOwnPageAsBot, type BotCall } from "./verify-browser-identity.ts";

const MAC = {
  architecture: "arm", bitness: "64", brands: [{ brand: "Chromium", version: "153" }], formFactors: ["Desktop"],
  fullVersionList: [{ brand: "Chromium", version: "153.0.8010.47" }], mobile: false, model: "", platform: "macOS",
  platformVersion: "26.3.1", uaFullVersion: "153.0.8010.47", wow64: false,
};

describe("the identity checks", () => {
  it("want every high-entropy hint, where Chrome reports it", () => {
    expect(completeHints(MAC)).toBe(true);
    expect(completeHints({ ...MAC, platformVersion: "" })).toBe(false);
    expect(completeHints({ ...MAC, platform: "Linux", platformVersion: "" })).toBe(true);
    expect(completeHints({ ...MAC, architecture: "", fullVersionList: [] })).toBe(false);
    expect(completeHints(null)).toBe(false);
  });

  it("expect Chrome's reduced user agent for each desktop", () => {
    expect(expectedUserAgent("153", "darwin")).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36");
    expect(expectedUserAgent("155", "win32")).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36");
    expect(expectedUserAgent("155", "linux")).toBe("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36");
  });

  it("compare navigator.languages with the header's languages, without q-values", () => {
    expect(headerLanguages("en-US,en;q=0.9")).toBe("en-US,en");
    expect(headerLanguages("pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7")).toBe("pt-BR,pt,en-US,en");
    expect(headerLanguages(undefined)).toBe("");
  });
});

describe("opening the check's own page as the bot", () => {
  const url = "http://127.0.0.1:9/probe";
  const said = (text: string) => ({ isError: true, content: [{ type: "text", text }] });
  const engine = (...answers: unknown[]) => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const call: BotCall = async (name, args) => { calls.push({ name, args }); return answers.shift() ?? { content: [{ type: "text", text: "Opened." }] }; };
    return { call, calls };
  };

  it("opens it once more after Chrome cancels the first navigation, and says so", async () => {
    const { call, calls } = engine(said("Navigation failed: net::ERR_ABORTED"));
    const lines: string[] = [];
    expect(await openOwnPageAsBot(call, url, (line) => lines.push(line))).toBeNull();
    expect(calls).toEqual([{ name: "agent_browser_open", args: { url } }, { name: "agent_browser_open", args: { url } }]);
    expect(lines).toEqual([`the bot's browser: Chrome cancelled its first navigation (Navigation failed: net::ERR_ABORTED); opening ${url} once more`]);
  });

  it("opens it only once otherwise, and answers the bot's error when the second open fails too", async () => {
    const opened = engine();
    expect(await openOwnPageAsBot(opened.call, url, () => {})).toBeNull();
    expect(opened.calls).toHaveLength(1);
    const refused = engine(said("Navigation failed: net::ERR_CONNECTION_REFUSED"));
    expect(await openOwnPageAsBot(refused.call, url, () => {})).toBe("Navigation failed: net::ERR_CONNECTION_REFUSED");
    expect(refused.calls).toHaveLength(1);
    const twice = engine(said("Navigation failed: net::ERR_ABORTED"), said("Navigation failed: net::ERR_ABORTED"));
    expect(await openOwnPageAsBot(twice.call, url, () => {})).toBe("Navigation failed: net::ERR_ABORTED");
    expect(twice.calls).toHaveLength(2);
  });
});
