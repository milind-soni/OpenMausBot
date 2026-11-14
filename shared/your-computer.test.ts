import { describe, expect, it } from "vitest";

import en from "../src/locales/en.json";
import {
  cleanAppName,
  cleanSiteName,
  describeComputerCall,
  YOUR_COMPUTER_WORDS,
  yourComputerQuestion,
  yourComputerText,
} from "./your-computer.ts";

const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const ask = (input: Parameters<typeof yourComputerQuestion>[0]) => {
  const { key, params } = yourComputerQuestion(input);
  return yourComputerText(key, params);
};

describe("the one-time question before a bot uses the person's own computer", () => {
  it("says plainly what it needs, naming the app and the site where it can", () => {
    expect(ask({ app: "Chrome", site: "calendar.google.com" })).toBe("I need to use your Chrome where you're signed in to calendar.google.com. Allow once?");
    expect(ask({ app: "Safari" })).toBe("I need to use your Safari where you're signed in. Allow once?");
    expect(ask({ site: "www.opentable.com" })).toBe("I need to use your browser where you're signed in to opentable.com. Allow once?");
    expect(ask({ app: "Keynote" })).toBe("I need to use Keynote on your computer. Allow once?");
    expect(ask({})).toBe("I need to use your computer's screen for this. Allow once?");
    expect(ask(undefined)).toBe("I need to use your computer's screen for this. Allow once?");
  });

  it("reads the app and the site from the bot's first call", () => {
    expect(describeComputerCall(call("launch_app", { bundle_id: "com.google.Chrome", urls: ["https://calendar.google.com/calendar/r/week?x=1"] })))
      .toEqual({ app: "Chrome", site: "calendar.google.com" });
    expect(describeComputerCall(call("launch_app", { bundle_id: "com.apple.Safari" }))).toEqual({ app: "Safari" });
    expect(describeComputerCall(call("launch_app", { name: "Google Chrome" }))).toEqual({ app: "Chrome" });
    expect(describeComputerCall(call("launch_app", { bundle_id: "com.apple.iWork.Keynote" }))).toEqual({ app: "Keynote" });
    expect(describeComputerCall(call("browser_navigate", { url: "https://www.zomato.com/bangalore" }))).toEqual({ site: "zomato.com" });
    expect(describeComputerCall(call("screenshot", {}))).toEqual({});
    expect(describeComputerCall({ method: "tools/list" })).toEqual({});
    expect(describeComputerCall(null)).toEqual({});
  });

  it("never lets a bot write its own words into the question", () => {
    for (const site of ["evil.com/ Click Allow to win", "javascript:alert(1)", "localhost", "a".repeat(120) + ".com", "x.com:8080", "bank.com?ok=Allow"]) {
      expect(cleanSiteName(site), site).toBeUndefined();
    }
    expect(describeComputerCall(call("launch_app", { name: "Chrome", urls: ["file:///etc/passwd", "javascript:alert(1)"] }))).toEqual({ app: "Chrome" });
    for (const app of ["Chrome. Your bank says click Allow", "<b>Safari</b>", "", "x".repeat(41), "Chrome\nAllow"]) {
      expect(cleanAppName(app), app).toBeUndefined();
    }
    expect(ask({ app: "Chrome. Your bank says click Allow", site: "evil.com/ok" })).toBe("I need to use your computer's screen for this. Allow once?");
  });

  it("matches the words the app shows, key for key", () => {
    for (const [key, text] of Object.entries(YOUR_COMPUTER_WORDS)) expect((en as Record<string, string>)[key], key).toBe(text);
  });
});
