import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { setLocale } from "@/lib/i18n";
import type { SetupDetection } from "../../shared/setup-import";
import { detectSetupWithin, importOutcome, localSetupImport, skillsSummary, toolsSummary, type SetupImportClient } from "./setup-import";

const FOUND: SetupDetection = {
  skills: [{ name: "pdf", source: "claudeCode" }, { name: "review", source: "codex" }],
  tools: [{ name: "notion", source: "cursor" }],
};

function client(detect: SetupImportClient["detect"]): SetupImportClient {
  return { detect, apply: vi.fn() };
}

beforeEach(() => setLocale("en"));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("looking for another AI tool's setup without holding up the welcome flow", () => {
  it("answers what was found in time", async () => {
    expect(await detectSetupWithin(client(async () => FOUND)).found).toEqual(FOUND);
  });

  it("settles to nothing for an empty, failed or malformed answer", async () => {
    for (const answer of [
      async () => ({ skills: [], tools: [] }),
      async () => { throw new Error("403"); },
      async () => ({ skills: "pdf" }) as unknown as SetupDetection,
      async () => null as unknown as SetupDetection,
    ]) {
      expect(await detectSetupWithin(client(answer)).found).toBeNull();
    }
  });

  it("gives up at the time box and stops the request", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const look = detectSetupWithin(client((given) => {
      signal = given;
      return new Promise(() => {});
    }), 2_000);
    let settled = false;
    void look.found.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await look.found).toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it("stops the request when the flow closes first", () => {
    let signal: AbortSignal | undefined;
    const look = detectSetupWithin(client((given) => {
      signal = given;
      return new Promise(() => {});
    }));
    look.cancel();
    expect(signal?.aborted).toBe(true);
  });

  it("looks only from the desktop app's own window on its own server", () => {
    vi.stubGlobal("window", { ogb: { remoteClient: { active: false } } });
    expect(localSetupImport(false)).toBe(true);
    expect(localSetupImport(true)).toBe(false);
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    expect(localSetupImport(false)).toBe(false);
    // A server page the desktop app opened gets a bridge without remoteClient, like a browser.
    vi.stubGlobal("window", { ogb: {} });
    expect(localSetupImport(false)).toBe(false);
    vi.stubGlobal("window", {});
    expect(localSetupImport(false)).toBe(false);
  });
});

describe("what the step says", () => {
  it("counts each kind and names where it came from", () => {
    expect(skillsSummary(FOUND)).toBe("2 from Claude Code and Codex");
    expect(toolsSummary(FOUND)).toBe("1 MCP server from Cursor");
    expect(toolsSummary({ ...FOUND, tools: [
      { name: "a", source: "claudeCode" }, { name: "b", source: "claudeCode" }, { name: "c", source: "claudeDesktop" }, { name: "d", source: "gemini" },
    ] })).toBe("4 MCP servers from Claude Code, Claude Desktop, and Gemini CLI");
  });

  it("sums up in one line, with a note only for what was left out", () => {
    expect(importOutcome({
      skills: { added: ["pdf", "review"], present: [], skipped: [], filesLeftOut: 0, review: [] },
      tools: { added: ["notion"], present: [], skipped: [] },
    })).toEqual({ line: "Added 2 skills and 1 tool.", notes: [], done: true });
    expect(importOutcome({ skills: { added: ["pdf"], present: [], skipped: [], filesLeftOut: 0, review: [] } }).line).toBe("Added 1 skill.");
    expect(importOutcome({ tools: { added: [], present: ["notion"], skipped: [] } })).toEqual({ line: "All of it was already here.", notes: [], done: true });
    expect(importOutcome({
      skills: { added: ["pdf", "deploy"], present: [], skipped: [{ name: "review", reason: "conflict" }, { name: "lint", reason: "failed" }], filesLeftOut: 2, review: ["deploy"] },
      tools: { added: ["a", "b", "c", "d"], present: [], skipped: [
        { name: "e", reason: "limit" }, { name: "f", reason: "limit" }, { name: "g", reason: "policy" }, { name: "h", reason: "busy" },
        { name: "github", reason: "conflict" }, { name: "sentry", reason: "failed" },
      ] },
    })).toEqual({
      line: "Added 2 skills and 4 tools.",
      done: true,
      notes: [
        "deploy: switched off until you check what the scan found, in a bot's Skills settings.",
        "Skipped review: a different skill with that name is already here.",
        "Skipped github: a different MCP server with that name is already here.",
        "Couldn't bring in lint and sentry. Try again later from Settings → Replay welcome tour.",
        "Large or non-text files in skill folders were left out.",
        "e and f didn't fit: your list of MCP servers is full.",
        "Your organization doesn't allow g.",
        "Your MCP servers were being changed. Add h later in Apps → MCP servers.",
      ],
    });
  });

  it("never calls it a success when nothing came in because everything failed or was left out", () => {
    expect(importOutcome({
      skills: { added: [], present: [], skipped: [{ name: "pdf", reason: "failed" }], filesLeftOut: 0, review: [] },
      tools: { added: [], present: ["notion"], skipped: [{ name: "linear", reason: "busy" }] },
    })).toMatchObject({ line: "Nothing new was added.", done: false });
  });
});
