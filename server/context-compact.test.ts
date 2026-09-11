import { describe, expect, it } from "vitest";

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  collectCompactSeedDirs,
  clipKeepingNext,
  compactedProviderUserTurns,
  compactSession,
  demotePadBlobsInVector,
  extractNextBlock,
  decideSettledPromptTokens,
  fillTokensFor,
  forwardNextFromLiveAsk,
  harvestAddresses,
  harvestWorkPointers,
  HANDOFF_AS_VECTOR_MIN_CHARS,
  DEFAULT_EXTRACTION_PROMPT,
  injectStateVector,
  isBulkPadText,
  mergeLiveUser,
  instructionSeedDirs,
  isBoilerplateMemory,
  looksLikeHandoff,
  mergeHarvestedAddresses,
  mergeWorkPointers,
  MID_TASK_CONTINUITY_SYSTEM,
  proseTurns,
  readGitWorkingTree,
  readWorkspaceSeed,
  generateSideText,
  resolveOutgoingTurn,
  sanitizeForwardOnlyVector,
  stubBulkPadText,
  stripSecretLines,
  summarizeViaLocalHost,
} from "./context-compact.ts";
import { decodeInjectId } from "./drivers/local-inject.ts";
import type { FacingTurn } from "./context-rebuild.ts";

const transcript: FacingTurn[] = [
  { role: "user", text: "Fix the login redirect at /auth/callback" },
  { role: "assistant", text: "I will inspect src/auth.ts" },
  { role: "assistant", text: "[tool Read → ok]" },
  { role: "user", text: "do not touch billing" },
];

describe("injectStateVector", () => {
  it("injects bare vector + live user text without restart/task-state framing", () => {
    const text = injectStateVector("Goal\nfix login\nNext action\nedit src/auth.ts", "what is left?");
    expect(text).toBe("Goal\nfix login\nNext action\nedit src/auth.ts\n\nwhat is left?");
    expect(text).toContain("Goal\nfix login");
    expect(text.endsWith("what is left?")).toBe(true);
    expect(text.toLowerCase()).not.toMatch(
      /current task state|task state|you are reading|instructions|restart|joining this conversation|rewound|session\/new|compacted/,
    );
  });

  it("DEFAULT_EXTRACTION_PROMPT prefers Open and bans soft-park", () => {
    expect(DEFAULT_EXTRACTION_PROMPT).toMatch(/\nOpen\n/);
    expect(DEFAULT_EXTRACTION_PROMPT).toMatch(/This turn/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).toMatch(/omit open entirely when nothing is open/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).toMatch(/never soft-park/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).toMatch(/provide a prompt/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).toMatch(/await user/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).toMatch(/wait for next/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).toMatch(/confirm last turn/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).toMatch(/omit empty sections/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).toMatch(/running notebook/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).toMatch(/prefer live task truth/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).toMatch(/do not invent the next patch or feature/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).not.toMatch(/dogfood|canary|canaries|fill #n|orbit/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).not.toMatch(/one-page recap/);
    expect(DEFAULT_EXTRACTION_PROMPT.toLowerCase()).toMatch(/hand off cleanly/);
  });
});

describe("sanitizeForwardOnlyVector", () => {
  it("replaces banned Open/Next soft-park with one forward line from the live ask", () => {
    const summary = [
      "Goal",
      "Keep chatting Fill #3 harness",
      "Constraints",
      "Fill #2 only; no patching",
      "Next action",
      "wait for next instruction",
    ].join("\n");
    const cleaned = sanitizeForwardOnlyVector(summary, "Reply with CANARY_OMB_TAIL_9C2E then stop.");
    expect(cleaned).not.toMatch(/Fill\s*#\d+/i);
    expect(cleaned).toContain("Goal");
    expect(cleaned).toContain("Keep chatting");
    expect(cleaned).toContain("Open");
    expect(cleaned.toLowerCase()).not.toMatch(/wait for next/);
    expect(cleaned).toContain(forwardNextFromLiveAsk("Reply with CANARY_OMB_TAIL_9C2E then stop."));
  });

  it("sanitizes soft-park Open (provide a prompt / await user)", () => {
    const summary = "Goal\nship\nOpen\nawait user / provide a prompt";
    const cleaned = sanitizeForwardOnlyVector(summary, "run the hist sheet checks");
    expect(cleaned).toContain("Open");
    expect(cleaned.toLowerCase()).not.toMatch(/await user|provide a prompt/);
    expect(cleaned).toContain(forwardNextFromLiveAsk("run the hist sheet checks"));
  });

  it("leaves a forward Next alone (legacy heading)", () => {
    const summary = "Goal\nship\nNext action\nedit src/auth.ts";
    expect(sanitizeForwardOnlyVector(summary, "keep going")).toContain("edit src/auth.ts");
    expect(sanitizeForwardOnlyVector(summary, "keep going")).toContain("Next action");
  });

  it("rewrites Open that soft-parks with await-the-next prompt", () => {
    const summary = [
      "Goal",
      "ORBIT sheet",
      "Open",
      "The essay task is finished. The successor should await the next specific essay prompt or instruction.",
    ].join("\n");
    const cleaned = sanitizeForwardOnlyVector(summary, "Write the Magna Carta / Galileo essay next.");
    expect(cleaned).toContain("Open");
    expect(cleaned.toLowerCase()).not.toMatch(/await the next/);
    expect(cleaned).toContain(forwardNextFromLiveAsk("Write the Magna Carta / Galileo essay next."));
  });

  it("leaves a forward Open alone", () => {
    const summary = "Goal\nship\nOpen\nedit src/auth.ts";
    expect(sanitizeForwardOnlyVector(summary, "keep going")).toContain("Open\nedit src/auth.ts");
  });

  it("compactsProviderUserTurns splits vector and live ask", () => {
    const split = compactedProviderUserTurns("Goal\nvault\nNext action\nask canary", "what is left?");
    expect(split).toEqual({ vector: "Goal\nvault\nNext action\nask canary", liveAsk: "what is left?" });
    expect(MID_TASK_CONTINUITY_SYSTEM.toLowerCase()).toMatch(/mid-task/);
    expect(MID_TASK_CONTINUITY_SYSTEM.toLowerCase()).not.toMatch(/compacted|restart/);
  });
});


describe("bulk pad demotion", () => {
  const pad = `Remember CANARY_PAD_9F1A at /tmp/omb-vault-pad. UNIQUE-GO4 ${"deadbeef".repeat(400)}`;

  it("detects UNIQUE hex pastes and stubs them while keeping canaries/paths", () => {
    expect(isBulkPadText(pad)).toBe(true);
    const stub = stubBulkPadText(pad);
    expect(stub.length).toBeLessThan(600);
    expect(stub).toContain("CANARY_PAD_9F1A");
    expect(stub).toContain("/tmp/omb-vault-pad");
    expect(stub).toContain("bulk paste omitted");
    expect(stub).not.toContain("deadbeef".repeat(20));
  });

  it("demotes pad lines out of Goal/Next in the vector", () => {
    const vector = [
      "Goal",
      pad,
      "",
      "Verified facts",
      pad,
      "",
      "Next action",
      "ask for the canary",
    ].join("\n");
    const cleaned = demotePadBlobsInVector(vector);
    expect(cleaned).toContain("Next action");
    expect(cleaned).toContain("ask for the canary");
    expect(cleaned).not.toContain("deadbeef".repeat(20));
    expect(cleaned.toLowerCase()).toMatch(/bulk paste omitted/);
  });

  it("clips giant live user text in injectStateVector", () => {
    const text = injectStateVector("Goal\nkeep chatting\nNext action\ncontinue", pad);
    expect(text).not.toMatch(/Current task state/i);
    expect(text.startsWith("Goal\nkeep chatting")).toBe(true);
    expect(text).toContain("CANARY_PAD_9F1A");
    expect(text.length).toBeLessThan(2_500);
    expect(text).not.toContain("deadbeef".repeat(20));
  });

  it("mergeLiveUser stubs pads instead of pasting hex into Live user", () => {
    const summary = "Goal\nship\n\nNext action\ncontinue";
    const merged = mergeLiveUser(summary, pad);
    expect(merged).toContain("Live user");
    expect(merged).toContain("CANARY_PAD_9F1A");
    expect(merged).not.toContain("deadbeef".repeat(20));
  });
});


describe("resolveOutgoingTurn", () => {
  it("drops the native cursor and puts vector+ask on the main text when compacted", () => {
    const out = resolveOutgoingTurn({
      compacted: true,
      summary: "Goal\nship it\nNext action\nopen src/auth.ts",
      userText: "continue",
      turnText: "[You are joining this conversation mid-thread…]\ncontinue",
      resumeCursor: "sess-fat",
      transcript,
    });
    expect(out.resumeCursor).toBeUndefined();
    expect(out.transcript).toEqual([]);
    expect(out.text).toContain("Goal\nship it");
    expect(out.text).toContain("continue");
    expect(out.text).not.toContain("joining this conversation");
  });

  it("passes a live session through untouched", () => {
    const out = resolveOutgoingTurn({
      compacted: false,
      summary: "",
      userText: "hi",
      turnText: "hi",
      resumeCursor: "sess-ok",
      transcript,
    });
    expect(out).toEqual({ text: "hi", resumeCursor: "sess-ok", transcript });
  });
});

describe("compactSession", () => {
  it("uses the injected summarizer and still injects the latest user text", async () => {
    const result = await compactSession({
      transcript,
      userText: "keep going",
      maxTokens: 512,
      summarize: async (prompt) => {
        expect(prompt).toContain("Verified facts");
        expect(prompt).toContain("/auth/callback");
        expect(prompt).toContain("do not touch billing");
        return "Goal\nfix login redirect\nVerified facts\n/auth/callback\nConstraints\ndo not touch billing\nNext action\nedit src/auth.ts";
      },
    });
    expect(result.summary).toContain("/auth/callback");
    expect(result.turnText).not.toMatch(/Current task state/i);
    expect(result.turnText.startsWith("Goal\nfix login redirect")).toBe(true);
    expect(result.turnText.endsWith("keep going")).toBe(true);
  });

  it("falls back to an extractive vector when no model is available", async () => {
    const result = await compactSession({
      transcript,
      userText: "keep going",
      maxTokens: 512,
    });
    expect(result.summary).toContain("Goal");
    expect(result.summary).toContain("Open");
    expect(result.summary).not.toMatch(/\(none\)/);
    expect(result.turnText).toContain("keep going");
    expect(result.summary.toLowerCase()).not.toMatch(/you restarted|joining this conversation/);
  });

  it("strips restart language from a sloppy summarizer", async () => {
    const result = await compactSession({
      transcript,
      userText: "go",
      maxTokens: 512,
      summarize: async () => "You restarted.\nGoal\nship it\nNext action\nedit the file",
    });
    expect(result.summary.toLowerCase()).not.toContain("you restarted");
    expect(result.summary).toContain("Goal");
  });
});

describe("decideSettledPromptTokens", () => {
  it("passes through a plausible report and clears the ignore flag", () => {
    expect(
      decideSettledPromptTokens({
        reported: 12_000.7,
        ceiling: 64_000,
        currentSpt: 8_000,
        inject: true,
      }),
    ).toEqual({
      lastReported: 12_000,
      nextSpt: 12_000,
      ignoreReportedPromptFill: false,
    });
  });

  it("treats inject reports >1.25x ceiling and above SPT as inflated", () => {
    expect(
      decideSettledPromptTokens({
        reported: 100_000,
        ceiling: 64_000,
        currentSpt: 1_200,
        inject: true,
      }),
    ).toEqual({
      lastReported: 100_000,
      nextSpt: null,
      ignoreReportedPromptFill: true,
    });
  });

  it("treats inject reports past ceiling while SPT is still low as inflated", () => {
    expect(
      decideSettledPromptTokens({
        reported: 70_000,
        ceiling: 64_000,
        currentSpt: 40_000, // < 0.8 * 64k
        inject: true,
      }),
    ).toEqual({
      lastReported: 70_000,
      nextSpt: null,
      ignoreReportedPromptFill: true,
    });
  });

  it("does not inflate when not inject, even if huge", () => {
    expect(
      decideSettledPromptTokens({
        reported: 200_000,
        ceiling: 64_000,
        currentSpt: 1_000,
        inject: false,
      }),
    ).toEqual({
      lastReported: 200_000,
      nextSpt: 200_000,
      ignoreReportedPromptFill: false,
    });
  });

  it("does not inflate without a finite current SPT", () => {
    expect(
      decideSettledPromptTokens({
        reported: 200_000,
        ceiling: 64_000,
        currentSpt: null,
        inject: true,
      }),
    ).toEqual({
      lastReported: 200_000,
      nextSpt: 200_000,
      ignoreReportedPromptFill: false,
    });
  });
});

describe("fillTokensFor", () => {
  it("adds this turn's paste on top of the last native-session prompt size", () => {
    expect(fillTokensFor({ sessionPromptTokens: 12_345, transcript, userText: "x" })).toBe(12_345 + 1);
    expect(fillTokensFor({ sessionPromptTokens: 12_345, transcript, userText: "abcd" })).toBe(12_345 + 1);
    expect(fillTokensFor({ transcript, userText: "abcd" })).toBeGreaterThan(0);
  });

  it("takes max(SPT, lastReported) when not ignoring reported fill", () => {
    expect(
      fillTokensFor({
        sessionPromptTokens: 1_000,
        lastReportedPromptTokens: 5_000,
        ignoreReportedPromptFill: false,
        transcript,
        userText: "x",
      }),
    ).toBe(5_000 + 1);
    expect(
      fillTokensFor({
        sessionPromptTokens: 9_000,
        lastReportedPromptTokens: 5_000,
        transcript,
        userText: "x",
      }),
    ).toBe(9_000 + 1);
  });

  it("ignores lastReported when ignoreReportedPromptFill is set", () => {
    expect(
      fillTokensFor({
        sessionPromptTokens: 1_200,
        lastReportedPromptTokens: 100_000,
        ignoreReportedPromptFill: true,
        transcript,
        userText: "x",
      }),
    ).toBe(1_200 + 1);
  });
});

describe("isBoilerplateMemory", () => {
  it("skips the house MEMORY template and keeps a real one-pager", () => {
    expect(
      isBoilerplateMemory(
        "# Memory\n\nDurable notes this bot keeps between tasks. The first 200 lines\nload at the start of every session — keep this file short and curated.\nLonger notes belong in memory/<topic>.md files, read on demand.\n",
      ),
    ).toBe(true);
    expect(
      isBoilerplateMemory(
        "# Memory\n\nDurable notes this bot keeps between tasks.\n\nGoal\nKeep chatting test\nNext action\nAsk for CANARY_OMB_TAIL_9C2E\n",
      ),
    ).toBe(false);
  });
});

describe("mergeLiveUser", () => {
  it("skips filler continue and quotes a specific live turn", () => {
    const summary = "Goal\nship\nNext action\nedit src/auth.ts";
    expect(mergeLiveUser(summary, "continue")).toBe(summary);
    const merged = mergeLiveUser(
      summary,
      "This is a Keep chatting live test. Canary CANARY_OMB_KEEP_CHATTING_7F3A vault=/tmp/omb-vault-7F3A",
    );
    expect(merged).toContain("CANARY_OMB_KEEP_CHATTING_7F3A");
    expect(merged).toContain("Next action\nedit src/auth.ts");
  });
});

describe("accurate compact vectors", () => {
  it("drops tool chips from prose and harvests hex addresses", () => {
    expect(proseTurns(transcript).map((t) => t.text)).toEqual([
      "Fix the login redirect at /auth/callback",
      "I will inspect src/auth.ts",
      "do not touch billing",
    ]);
    expect(harvestAddresses("trigger 0x100474798 and mirror 0x100989010 plus 0x100474798")).toEqual([
      "0x100474798",
      "0x100989010",
    ]);
  });

  it("fills empty Addresses from harvested VAs and strips license-key lines", () => {
    const merged = mergeHarvestedAddresses("Goal\nship\nAddresses\n(none quoted)", ["0x100474798"]);
    expect(merged).toContain("0x100474798");
    expect(merged).not.toContain("(none quoted)");
    expect(stripSecretLines('activationKey = "SECRET"\nkeep me')).toBe("keep me");
  });

  it("does not treat tool chips as verified facts in the extractive fallback", async () => {
    const result = await compactSession({
      transcript: [
        { role: "user", text: "Find the gate at 0x100474798. Never defaults write." },
        { role: "assistant", text: "[tool write → ok]" },
        { role: "assistant", text: "The notActivated trigger is 0x100474798." },
      ],
      userText: "continue",
      maxTokens: 512,
    });
    expect(result.summary).not.toContain("[tool");
    expect(result.summary).toContain("0x100474798");
    expect(result.summary).toMatch(/Addresses\n0x100474798/);
  });

  it("prefers workspace MEMORY.md / newest handoff over the transcript smear", async () => {
    const dir = join(tmpdir(), `omb-seed-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n- live trigger 0x100474798\n");
    writeFileSync(
      join(dir, "handoff_2026-09-05_async_consumers.md"),
      "## Next action\nEnumerate heap mirror readers.\nactivationKey = \"DO-NOT-LEAK\"\n",
    );
    const seed = readWorkspaceSeed(dir);
    expect(seed).toContain("0x100474798");
    expect(seed).toContain("heap mirror");
    expect(seed).not.toContain("DO-NOT-LEAK");

    const result = await compactSession({
      transcript: [
        { role: "user", text: "go" },
        { role: "assistant", text: "[tool auto-approved edit: Write foo → ok]" },
      ],
      userText: "continue",
      maxTokens: 512,
      workspaceDir: dir,
    });
    expect(result.summary).toContain("0x100474798");
    expect(result.summary).not.toContain("DO-NOT-LEAK");
    expect(result.summary).not.toContain("[tool");
  });

  it("uses a disk handoff as the vector instead of smearing the transcript", async () => {
    const seed = [
      "Goal",
      "strip license from the copy",
      "Verified facts",
      "notActivated trigger 0x100474798 writes 3 to [ctx+0x50]",
      "Addresses",
      "0x100474798",
      "0x100476668",
      "0x10012307c",
      "Landmines",
      "shared defaults wipe if the copy launches",
      "Constraints",
      "no patch yet",
      "Next action",
      "Enumerate heap mirror readers of [ctx+0x50]",
    ].join("\n");
    expect(looksLikeHandoff(seed)).toBe(true);
    const result = await compactSession({
      transcript: [
        { role: "assistant", text: "[tool write → ok]" },
        { role: "assistant", text: "thinking out loud about strings" },
      ],
      userText: "continue",
      maxTokens: 512,
      workspaceSeed: seed,
    });
    expect(result.summary).toContain("0x100474798");
    expect(result.summary).toContain("Enumerate heap mirror readers");
    expect(result.summary).not.toContain("[tool");
    expect(result.summary).not.toContain("thinking out loud");
  });

  it("keeps a specific live user turn even when the vector is a disk handoff", async () => {
    const seed = [
      "Goal",
      "strip license from the copy",
      "Verified facts",
      "notActivated trigger 0x100474798",
      "Next action",
      "Enumerate heap mirror readers",
    ].join("\n");
    const live =
      "This is a Keep chatting live test. Canary CANARY_OMB_KEEP_CHATTING_7F3A vault=/tmp/omb-vault-7F3A";
    const result = await compactSession({
      transcript: [{ role: "user", text: "Hey bro" }],
      userText: live,
      maxTokens: 512,
      workspaceSeed: seed,
    });
    expect(result.summary).toContain("CANARY_OMB_KEEP_CHATTING_7F3A");
    expect(result.summary).toContain("Enumerate heap mirror readers");
  });

  it("still feeds the workspace seed to an injected summarizer", async () => {
    const result = await compactSession({
      transcript,
      userText: "keep going",
      maxTokens: 512,
      workspaceSeed: "notActivated trigger 0x100474798. Do not launch the copy.",
      summarize: async (prompt) => {
        expect(prompt).toContain("Workspace seed");
        expect(prompt).toContain("0x100474798");
        expect(prompt).not.toContain("[tool Read → ok]");
        return "Goal\nconfirm surface\nVerified facts\ntrigger 0x100474798\nAddresses\n0x100474798\nNext action\nenumerate heap readers";
      },
    });
    expect(result.summary).toContain("0x100474798");
    expect(result.summary).toContain("enumerate heap readers");
  });
});

describe("universal compact seed", () => {
  it("treats Goal + Next action as a handoff without requiring hex VAs", () => {
    const coding = [
      "Goal",
      "Fix the login redirect at /auth/callback",
      "Verified facts",
      "src/auth.ts owns the callback",
      "Next action",
      "edit src/auth.ts",
    ].join("\n");
    expect(looksLikeHandoff(coding)).toBe(true);
    const withOpen = [
      "Goal",
      "Polish Keep chatting clarity schema for universal chat and coding",
      "Verified facts",
      "Open replaces Next action; omit when nothing is open",
      "Open",
      "dogfood ORBIT-HIST-7 on Long Run after package:mac",
    ].join("\n");
    expect(looksLikeHandoff(withOpen)).toBe(true);
    expect(looksLikeHandoff("# Memory\n- Goal: strip the copy\n- Next: keep going")).toBe(false);
  });

  it("collects private MEMORY and a project path from Instructions, not a bare mentioned folder", () => {
    const privateWs = join(tmpdir(), `omb-priv-${Date.now()}`);
    const project = join(tmpdir(), `omb-proj-${Date.now()}`);
    const empty = join(tmpdir(), `omb-empty-${Date.now()}`);
    mkdirSync(privateWs, { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(privateWs, "MEMORY.md"), "# Memory\n- keep the private notes\n");
    writeFileSync(
      join(project, "handoff_2026-09-05_login.md"),
      "Goal\nFix login\nNext action\nedit src/auth.ts\n",
    );

    const dirs = collectCompactSeedDirs({
      privateWorkspace: privateWs,
      taskCwd: privateWs,
      instructions: `We work in\n\n${project}\nAlso see ${empty} and /Applications`,
    });
    expect(dirs).toContain(resolve(privateWs));
    expect(dirs).toContain(resolve(project));
    expect(dirs).not.toContain(resolve(empty));
    expect(instructionSeedDirs(`nothing here and /Applications`)).toEqual([]);

    const seed = readWorkspaceSeed(dirs);
    expect(seed).toContain("keep the private notes");
    expect(seed).toContain("edit src/auth.ts");
  });

  it("uses a substantial disk handoff as the vector even without a Goal heading", async () => {
    const dir = join(tmpdir(), `omb-handoff-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const body = [
      "# Eng 10 handoff — async result consumers",
      "notActivated trigger 0x100474798 writes 3 to [ctx+0x50].",
      "Recommendation for Eng 11: neutralize 0x100474798, then enumerate heap readers.",
      "Constraints: static only. No patch. No defaults writes.",
      "x".repeat(HANDOFF_AS_VECTOR_MIN_CHARS),
    ].join("\n");
    writeFileSync(join(dir, "handoff_2026-09-05_async_consumers.md"), body);

    const result = await compactSession({
      transcript: [
        { role: "assistant", text: "[tool write → ok]" },
        { role: "assistant", text: "thinking out loud about strings" },
      ],
      userText: "continue",
      maxTokens: 512,
      workspaceDir: dir,
    });
    expect(result.summary).toContain("0x100474798");
    expect(result.summary).toContain("Recommendation for Eng 11");
    expect(result.summary).not.toContain("[tool");
    expect(result.summary).not.toContain("thinking out loud");
  });

  it("does not bake CleanShot-only constraints into a generic extractive vector", async () => {
    const result = await compactSession({
      transcript: [
        { role: "user", text: "Fix the login redirect at /auth/callback" },
        { role: "assistant", text: "I will inspect src/auth.ts" },
      ],
      userText: "keep going",
      maxTokens: 512,
    });
    expect(result.summary).not.toMatch(/argv-activate/i);
    expect(result.summary).not.toMatch(/no patch, no defaults write/i);
  });

  it("keeps the Next block when a disk handoff is over budget", () => {
    const handoff = [
      "# Eng 11 handoff",
      "padding ".repeat(400),
      "0x100474798 writes 3 to [ctx+0x50]",
      "**Next (Eng 12): apply ret at 0x100474798 on a COPY, re-sign, isolated first launch.**",
    ].join("\n");
    expect(extractNextBlock(handoff)).toContain("apply ret at 0x100474798");
    const clipped = clipKeepingNext(handoff, 256);
    expect(clipped.length).toBeLessThan(handoff.length);
    expect(clipped).toContain("apply ret at 0x100474798");
    expect(clipped).toContain("isolated first launch");
  });

  it("does not glue MEMORY-only dead addresses onto a disk handoff vector", async () => {
    const dir = join(tmpdir(), `omb-va-merge-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n- vestigial BSS 0x100a562c0 — DEAD, do not redo\n");
    writeFileSync(
      join(dir, "handoff_2026-09-05_eng11_surface.md"),
      [
        "# Eng 11 handoff — patch surface CONFIRMED",
        "notActivated trigger 0x100474798 writes 3 to [ctx+0x50].",
        "Constraints: static only. No patch.",
        "**Next (Eng 12): ret at 0x100474798 on a COPY.**",
        "y".repeat(HANDOFF_AS_VECTOR_MIN_CHARS),
      ].join("\n"),
    );
    const result = await compactSession({
      transcript: [{ role: "assistant", text: "[tool write → ok]" }],
      userText: "continue",
      maxTokens: 512,
      workspaceDir: dir,
    });
    expect(result.summary).toContain("0x100474798");
    expect(result.summary).toContain("ret at 0x100474798 on a COPY");
    expect(result.summary).not.toContain("0x100a562c0");
    expect(result.summary).not.toContain("[tool");
  });
});

describe("live work pointers", () => {
  it("harvests paths and failures from tool titles, not from chat URLs", () => {
    const pointers = harvestWorkPointers([
      { role: "user", text: "Fix the login redirect at /auth/callback" },
      { role: "assistant", text: "I will inspect src/auth.ts" },
      { role: "assistant", text: "[tool Read server/context-compact.ts → ok]" },
      { role: "assistant", text: "[tool pnpm exec vitest run server/context-compact.test.ts → failed]" },
    ]);
    expect(pointers.paths).toContain("server/context-compact.ts");
    expect(pointers.paths).toContain("server/context-compact.test.ts");
    expect(pointers.paths.join(" ")).not.toContain("/auth/callback");
    expect(pointers.lastFailed).toContain("pnpm exec vitest run server/context-compact.test.ts");
    expect(pointers.git).toBeNull();
  });

  it("treats an ok chip as Last error when assistant prose says the command failed", () => {
    const pointers = harvestWorkPointers([
      { role: "assistant", text: "[tool ls /tmp/omb-067-no-such-file → ok]" },
      {
        role: "assistant",
        text: "Which command failed: `ls /tmp/omb-067-no-such-file` — it fails with exit 1 and No such file.",
      },
    ]);
    expect(pointers.lastFailed).toContain("ls /tmp/omb-067-no-such-file");
  });

  it("prefers the failed command in prose over an earlier failed Read chip", () => {
    const pointers = harvestWorkPointers([
      { role: "assistant", text: "[tool read_file → failed]" },
      { role: "assistant", text: "[tool ls /tmp/omb-069-no-such-file → ok]" },
      {
        role: "assistant",
        text: "`ls /tmp/omb-069-no-such-file` failed as intended: No such file or directory (exit code 1).",
      },
    ]);
    expect(pointers.lastFailed).toContain("ls /tmp/omb-069-no-such-file");
    expect(pointers.lastFailed).not.toBe("read_file");
  });

  it("does not treat a nearby backtick symbol as Last error", () => {
    const pointers = harvestWorkPointers([
      { role: "assistant", text: '[tool ls /tmp/omb-070-no-such-file; echo "exit=$?" → ok]' },
      {
        role: "assistant",
        text:
          "It includes a `resolveOutgoingTurn` that, when compacted, replaces the outgoing turn. " +
          "3. `ls /tmp/omb-070-no-such-file` failed as expected: No such file or directory.",
      },
    ]);
    expect(pointers.lastFailed).toContain("ls /tmp/omb-070-no-such-file");
    expect(pointers.lastFailed).not.toContain("resolveOutgoingTurn");
  });

  it("does not walk git up into an ancestor repo", () => {
    const parent = join(tmpdir(), `omb-git-parent-${Date.now()}`);
    const child = join(parent, "bot-workspace");
    mkdirSync(child, { recursive: true });
    expect(spawnSync("git", ["init", "-b", "work", parent], { encoding: "utf8", timeout: 5_000 }).status).toBe(0);
    writeFileSync(join(parent, "outside.ts"), "x");
    expect(readGitWorkingTree(child)).toBeNull();
    expect(readGitWorkingTree(parent)?.dirty.some((p) => p.includes("outside.ts"))).toBe(true);
  });

  it("omits Working tree / Re-read / Last error on a canary-only transcript", async () => {
    const result = await compactSession({
      transcript: [
        { role: "user", text: "CANARY_OMB_TAIL_9C2E pad pad pad keep chatting" },
        { role: "assistant", text: "The canary is CANARY_OMB_TAIL_9C2E vault=/tmp/omb-vault-9C2E" },
      ],
      userText: "what was the canary?",
      maxTokens: 512,
      gitWorkingTree: null,
    });
    expect(result.summary).toContain("CANARY_OMB_TAIL_9C2E");
    expect(result.summary).not.toMatch(/^Working tree\b/m);
    expect(result.summary).not.toMatch(/^Re-read\b/m);
    expect(result.summary).not.toMatch(/^Last error\b/m);
    expect(result.summary).not.toContain("[tool");
  });

  it("harvests an early canary past giant UNIQUE pastes that exceed the clip window", async () => {
    const giant = "x".repeat(200_000);
    const result = await compactSession({
      transcript: [
        {
          role: "user",
          text: "Remember canary CANARY_AUTO_102K_A7F1 and vault /tmp/omb-vault-auto-102k",
        },
        {
          role: "assistant",
          text: "Stored. CANARY_AUTO_102K_A7F1 lives at /tmp/omb-vault-auto-102k",
        },
        { role: "user", text: giant },
        { role: "assistant", text: "paste 1 noted" },
        { role: "user", text: giant },
        { role: "assistant", text: "paste 2 noted" },
        { role: "user", text: giant },
        { role: "assistant", text: "UNIQUE-G received." },
      ],
      userText: "What was the canary and the vault path?",
      maxTokens: 512,
      workspaceSeed: "",
      gitWorkingTree: null,
    });
    expect(result.summary).toContain("CANARY_AUTO_102K_A7F1");
    expect(result.summary).toContain("/tmp/omb-vault-auto-102k");
    expect(result.summary).not.toMatch(/No task goal/i);
    // Must not collapse to only the newest short ack.
    expect(result.summary.trim() === "UNIQUE-G received.").toBe(false);
    expect(result.summary).not.toMatch(/^Goal\nUNIQUE-G received\.?$/m);
  });

  it("glues file paths, last failure, and dirty git onto a generic recap", async () => {
    const dir = join(tmpdir(), `omb-git-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "oops.ts"), "x");
    const init = spawnSync("git", ["init", "-b", "work", dir], { encoding: "utf8", timeout: 5_000 });
    expect(init.status).toBe(0);
    const result = await compactSession({
      transcript: [
        { role: "user", text: "fix the failing test" },
        { role: "assistant", text: "[tool Read server/context-compact.ts → ok]" },
        { role: "assistant", text: "[tool Edit server/context-compact.ts → ok]" },
        { role: "assistant", text: "[tool pnpm exec vitest run server/context-compact.test.ts → failed]" },
      ],
      userText: "fix the failing test",
      maxTokens: 512,
      workingCwd: dir,
      summarize: async () =>
        [
          "Goal",
          "ship it",
          "Verified facts",
          "none",
          "Addresses",
          "(none quoted)",
          "Landmines",
          "(none recorded)",
          "Constraints",
          "(none recorded)",
          "Next action",
          "add a new feature",
        ].join("\n"),
    });
    expect(result.summary).toContain("server/context-compact.ts");
    expect(result.summary).toContain("server/context-compact.test.ts");
    expect(result.summary).toContain("Last error");
    expect(result.summary).toContain("pnpm exec vitest run server/context-compact.test.ts");
    expect(result.summary).toContain("fix the failing test");
    expect(result.summary).toContain("Working tree");
    expect(result.summary).toContain("oops.ts");
    expect(result.summary).toContain("Re-read");
    expect(result.summary).toContain("Do not invent the next patch.");
    expect(result.summary).not.toContain("[tool");
    expect(result.summary).not.toContain("(none quoted)");
    const merged = mergeWorkPointers("Goal\nship\nAddresses\n(none quoted)\nNext action\ncontinue", {
      paths: ["src/auth.ts"],
      lastFailed: null,
      git: null,
    });
    expect(merged).toContain("src/auth.ts");
    expect(merged).not.toMatch(/^Working tree\b/m);
    expect(merged).not.toMatch(/^Last error\b/m);
  });
});

describe("micro notebook compact priority", () => {
  it("prefers notebook + last turn over MEMORY canaries in the summarizer prompt", async () => {
    let seen = "";
    const result = await compactSession({
      transcript: [
        { role: "user", text: "old chatter about something else" },
        { role: "assistant", text: "old reply" },
      ],
      userText: "Live: continue the store fix; canary LIVE_TURN_9A",
      lastAssistantText: "Patched store.ts. Next: run vitest.",
      maxTokens: 512,
      workspaceSeed:
        "Dogfood Long Run: canary CANARY_LONGRUN_D4C1, vault path /tmp/omb-vault-longrun.\nDo not redo.",
      microLedger: [
        "[2026-09-10T01:00:00.000Z] assistant notebook",
        "Goal",
        "Fix store wipe",
        "Verified facts",
        "Patched store.ts at 0xDeadBeef01",
        "Addresses",
        "server/store.ts",
        "Next action",
        "run vitest",
      ].join("\n"),
      summarize: async (prompt) => {
        seen = prompt;
        return [
          "Goal",
          "Fix store wipe",
          "Verified facts",
          "Patched store.ts at 0xDeadBeef01",
          "LIVE_TURN_9A",
          "Addresses",
          "server/store.ts",
          "Landmines",
          "(none)",
          "Constraints",
          "(none)",
          "Next action",
          "run vitest",
        ].join("\n");
      },
    });
    expect(seen).toContain("PRIMARY TRUTH");
    expect(seen).toMatch(/Fold the ENTIRE notebook stack/i);
    expect(seen).toContain("Fix store wipe");
    expect(seen).toContain("Last turn");
    expect(seen).toContain("LIVE_TURN_9A");
    expect(seen).toContain("Patched store.ts");
    expect(seen).toMatch(/do NOT copy old dogfood canaries/i);
    expect(seen.toLowerCase()).toMatch(/confirm last turn/);
    expect(seen.toLowerCase()).toMatch(/verify\/search for a previous chat turn/);
    expect(seen).not.toContain("Transcript (tool chips omitted)");
    expect(result.summary).toContain("0xDeadBeef01");
    expect(result.summary).toContain("LIVE_TURN_9A");
  });

  it("uses notebook as truth when LLM absent — skips inventing via extractiveFallback/MEMORY", async () => {
    const result = await compactSession({
      transcript: [{ role: "user", text: "keep going on store" }],
      userText: "keep going on store",
      maxTokens: 512,
      workspaceSeed: "Dogfood canary CANARY_LONGRUN_D4C1 must stay in MEMORY forever. Also 0xMEMORYONLY99.",
      microLedger: "Goal\nFix store\nVerified facts\nstore.ts patched\nAddresses\nserver/store.ts\nNext action\nrun tests",
    });
    expect(result.summary).toContain("store.ts");
    expect(result.summary).toContain("Fix store");
    expect(result.summary).not.toContain("CANARY_LONGRUN_D4C1");
    // mergeHarvestedAddresses must not invent MEMORY-only hex into Addresses
    expect(result.summary).not.toContain("0xMEMORYONLY99");
  });
});

describe("generateSideText", () => {
  it("prefers local inject (decodeInjectId) over generateText", async () => {
    const modelId = "unsloth::unsloth/gemma-4-26B-A4B-it-GGUF";
    expect(decodeInjectId(modelId)).toEqual({
      host: "unsloth",
      model: "unsloth/gemma-4-26B-A4B-it-GGUF",
    });

    let generateTextCalls = 0;
    let fetchUrl = "";
    let fetchBody: unknown;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchUrl = String(input);
      fetchBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Goal\nfrom inject\nNext action\ncontinue" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const text = await generateSideText({
      modelId,
      prompt: "extract notebook",
      maxTokens: 512,
      env: { UNSLOTH_STUDIO_AUTH_TOKEN: "test-token" },
      fetchImpl,
      generateText: async () => {
        generateTextCalls += 1;
        return "from generateText fallback";
      },
    });

    expect(text).toContain("from inject");
    expect(generateTextCalls).toBe(0);
    expect(fetchUrl).toContain("/chat/completions");
    expect(fetchBody).toMatchObject({
      model: "unsloth/gemma-4-26B-A4B-it-GGUF",
      messages: [{ role: "user", content: "extract notebook" }],
      enable_thinking: false,
      max_tokens: 512,
    });
  });

  it("falls back to generateText when modelId is not inject", async () => {
    const text = await generateSideText({
      modelId: "grok-4",
      prompt: "hi",
      generateText: async () => "side text from generateText",
      fetchImpl: (async () => {
        throw new Error("fetch should not run for non-inject ids");
      }) as typeof fetch,
    });
    expect(text).toBe("side text from generateText");
  });

  it("returns null when inject and generateText both fail", async () => {
    const text = await generateSideText({
      modelId: "unsloth::unsloth/gemma-4-26B-A4B-it-GGUF",
      prompt: "hi",
      env: { UNSLOTH_STUDIO_AUTH_TOKEN: "test-token" },
      fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
      generateText: async () => {
        throw new Error("xAI missing");
      },
    });
    expect(text).toBeNull();
  });

  it("summarizeViaLocalHost returns null for non-inject ids", async () => {
    await expect(
      summarizeViaLocalHost("grok-3-mini", "prompt", 256, {}, fetch),
    ).resolves.toBeNull();
  });

  it("summarizeViaLocalHost returns null when content empty even if reasoning_content filled", async () => {
    const modelId = "unsloth::unsloth/gemma-4-26B-A4B-it-GGUF";
    let fetchBody: unknown;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                reasoning_content: "I am thinking about the notebook…",
              },
              finish_reason: "length",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(
      summarizeViaLocalHost(
        modelId,
        "extract notebook",
        4096,
        { UNSLOTH_STUDIO_AUTH_TOKEN: "test-token" },
        fetchImpl,
      ),
    ).resolves.toBeNull();
    expect(fetchBody).toMatchObject({
      enable_thinking: false,
      max_tokens: 4096,
    });
  });

  it("summarizeViaLocalHost returns trimmed content when enable_thinking path yields prose", async () => {
    const modelId = "unsloth::unsloth/gemma-4-26B-A4B-it-GGUF";
    let fetchBody: unknown;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "  Goal\nship fix\nNext action\ncontinue  " } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(
      summarizeViaLocalHost(
        modelId,
        "extract notebook",
        4096,
        { UNSLOTH_STUDIO_AUTH_TOKEN: "test-token" },
        fetchImpl,
      ),
    ).resolves.toBe("Goal\nship fix\nNext action\ncontinue");
    expect(fetchBody).toMatchObject({ enable_thinking: false });
  });
});
