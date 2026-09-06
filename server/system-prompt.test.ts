// The builder is the one place the system prompt is put together, for a
// real turn and for the "what the model sees" preview alike. It is pure:
// it orders the parts it is handed, drops the empty ones, inserts the soul
// block directly after the persona, and measures each section.
import { describe, expect, it } from "vitest";

import { soulSystemPrompt } from "./bot-folder.ts";
import {
  buildSystemPrompt,
  computerPrompt,
  mentionPrompt,
  COMPOSIO_PROMPT,
  CREDENTIAL_PROMPT,
  LEARN_PROMPT,
  PROFILE_PROMPT,
  ROUTINE_PROMPT,
  WEBHOOK_PROMPT,
} from "./system-prompt.ts";

describe("buildSystemPrompt", () => {
  it("is the persona alone when there is no soul and no parts", () => {
    const built = buildSystemPrompt("You are Kiwi.", "", []);
    expect(built.text).toBe("You are Kiwi.");
    expect(built.sections).toEqual([{ id: "persona", label: "Identity", text: "You are Kiwi.", bytes: 13 }]);
  });

  it("concatenates parts in order and drops empty ones, so an empty soul changes nothing", () => {
    const parts = [
      { id: "computer", label: "Computer", text: " You can act on the computer." },
      { id: "plan", label: "Surface", text: "" },
      { id: "memory", label: "Memory", text: " Your memory file is X." },
    ];
    const built = buildSystemPrompt("You are Kiwi.", "", parts);
    expect(built.text).toBe("You are Kiwi. You can act on the computer. Your memory file is X.");
    expect(built.sections.map((s) => s.id)).toEqual(["persona", "computer", "memory"]);
  });

  it("puts the soul block directly after the persona and measures it in bytes", () => {
    const built = buildSystemPrompt("You are Kiwi.", "Be brief. é", [
      { id: "memory", label: "Memory", text: " Your memory file is X." },
    ]);
    expect(built.sections.map((s) => s.id)).toEqual(["persona", "soul", "memory"]);
    const soul = built.sections[1]!;
    expect(soul.text).toBe(soulSystemPrompt("Be brief. é"));
    expect(soul.bytes).toBe(Buffer.byteLength(soul.text, "utf8"));
    expect(built.text).toBe("You are Kiwi." + soul.text + " Your memory file is X.");
  });
});

describe("computerPrompt", () => {
  it("is empty with no computer", () => {
    expect(computerPrompt(null)).toBe("");
  });

  it("names each computer and always ends with the protected-input guard", () => {
    const guard = " At a sign-in, password, MFA, CAPTCHA, or other protected-input step, stop and ask the user to complete it on the visible computer. Never type their password or ask them to paste a password or one-time code into chat.";
    expect(computerPrompt("vm-private")).toContain("your own isolated Cua sandbox");
    expect(computerPrompt("vm-shared")).toContain("a shared, isolated Cua sandbox");
    expect(computerPrompt("box")).toContain("your own cloud computer");
    expect(computerPrompt("vps")).toContain("self-hosted remote Linux computer");
    expect(computerPrompt("local")).toContain("act on the user's computer");
    for (const kind of ["vm-private", "vm-shared", "box", "vps", "local"] as const) {
      expect(computerPrompt(kind).endsWith(guard)).toBe(true);
      expect(computerPrompt(kind).startsWith(" ")).toBe(true);
    }
    // a box driven by the box agent gets no computer paragraph — the agent
    // already lives on the box — but the guard still applies
    expect(computerPrompt("box-agent")).toBe(guard);
  });
});

describe("shared sentences", () => {
  it("each begins with one space so they concatenate onto the persona line", () => {
    for (const sentence of [COMPOSIO_PROMPT, CREDENTIAL_PROMPT, ROUTINE_PROMPT, LEARN_PROMPT, WEBHOOK_PROMPT, PROFILE_PROMPT]) {
      expect(sentence.startsWith(" ")).toBe(true);
      expect(sentence.startsWith("  ")).toBe(false);
    }
  });

  it("mentionPrompt names every tagged bot with its id, and is empty for none", () => {
    expect(mentionPrompt([])).toBe("");
    expect(mentionPrompt([{ id: "a1", name: "Ana" }, { id: "b2", name: "Bo" }])).toBe(
      " The user tagged @Ana (bot_id a1) and @Bo (bot_id b2) in their message. If they assigned independent work, use delegate_bot and finish your turn without waiting; use ask_bot only if their short reply is required in this answer.",
    );
  });

  it("PROFILE_PROMPT names the tool and the confirmation rule", () => {
    expect(PROFILE_PROMPT).toContain("propose_profile");
    expect(PROFILE_PROMPT).toContain("nothing changes until the user confirms");
  });
});
