import { describe, expect, it } from "vitest";

import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";

describe("chiefOfStaffSystemPrompt roster caps", () => {
  it("clips oversized persona fields instead of interpolating them whole", () => {
    const prompt = chiefOfStaffSystemPrompt(
      "chief",
      [
        { id: "chief", name: "Atlas" },
        {
          id: "big",
          name: "N".repeat(500),
          title: "T".repeat(500),
          description: "D".repeat(10_000),
        },
      ],
      true,
    );
    // an imported 10KB description must not ride into the Chief's system
    // prompt — the roster line stays bounded
    const rosterLine = prompt.split("\n").find((line) => line.startsWith("- N"))!;
    expect(rosterLine.length).toBeLessThan(500);
    expect(rosterLine).toContain("…");
  });

  it("caps the roster length and says how many were left out", () => {
    const team = Array.from({ length: 60 }, (_, i) => ({ id: `bot${i}`, name: `Bot ${i}` }));
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Atlas" }, ...team], true);
    expect(prompt).toContain("Bot 39");
    expect(prompt).not.toContain("Bot 40 —");
    expect(prompt).toContain("…and 20 more");
  });
});

describe("chiefOfStaffSystemPrompt", () => {
  const bots = [
    { id: "chief", name: "Atlas", title: "Operations", section: "Work" },
    { id: "writer", name: "Quill", title: "Writer", description: "Drafts concise copy", section: "Work" },
    { id: "coder", name: "Patch", title: "Engineer", busy: true, section: "Work" },
    { id: "hidden", name: "Secret", hidden: true, section: "Work" },
    { id: "personal", name: "Scout", title: "Travel planner", section: "Personal" },
  ];

  it("describes visible teammates, roles, and availability", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true);

    expect(prompt).toContain("Chief of Staff for the Work section");
    expect(prompt).toContain("Quill — Writer: Drafts concise copy (available)");
    expect(prompt).toContain("Patch — Engineer (working right now)");
    expect(prompt).not.toContain("Secret");
    expect(prompt).not.toContain("Scout");
    expect(prompt).not.toContain("Atlas —");
    expect(prompt).toContain("use delegate_bot");
    expect(prompt).toContain("keeps you available to the user");
    expect(prompt).toContain("delivers the teammate's outcome back into this conversation automatically — success or failure");
    expect(prompt).toContain("Do not call wait_delegation");
    expect(prompt).toContain("Use ask_bot only for a brief consultation");
    expect(prompt).toContain("Never use ask_bot for an assigned task");
    expect(prompt).toContain("use create_bot");
  });

  it("does not promise delegation when the engine cannot mount agent tools", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, false);

    expect(prompt).toContain("cannot contact teammates");
    expect(prompt).not.toContain("delegate_bot");
  });

  it("includes trusted OpenMaus status only when the Chief caller supplies it", () => {
    const status = "TRUSTED OPENMAUSBOT STATUS\nfreshness=fresh; runtime_state=degraded";

    const chiefPrompt = chiefOfStaffSystemPrompt("chief", bots, true, status);
    const ordinaryPrompt = chiefOfStaffSystemPrompt("writer", bots, true);

    expect(chiefPrompt).toContain(status);
    expect(ordinaryPrompt).not.toContain("TRUSTED OPENMAUSBOT STATUS");
  });

  it("renders the Chief's prompt exactly as it did before ordinary bots got a roster", () => {
    // The Chief's wording is load-bearing — it is what makes create_bot and
    // section-wide staffing legible to the model — so extracting the shared
    // roster renderer must not have moved a single byte of it. This is the
    // pin: a golden prompt, not a set of contains().
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true, "TRUSTED OPENMAUSBOT STATUS\nfreshness=fresh");

    expect(prompt).toBe(
      [
        "You are the Chief of Staff for the Work section. You are the user's primary contact for this section's team of bots.",
        "Own the outcome: understand the request, decide what to handle yourself, coordinate the right specialists when useful, and return one concise consolidated answer.",
        "Do not delegate trivial work merely to appear busy. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
        "Use list_bots to confirm the live roster and IDs. When assigning work to a teammate, use delegate_bot: it returns immediately, keeps you available to the user, and delivers the teammate's outcome back into this conversation automatically — success or failure. When the result arrives you are woken with it: report it to the user and act. If the teammate fails or stalls, tell the user plainly and decide the next step yourself. After delegate_bot accepts the task, acknowledge the handoff and continue with any independent work or end your turn. Do not call wait_delegation or repeatedly poll check_delegation in the same turn. Use ask_bot only for a brief consultation whose answer you must have before writing your current response. Never use ask_bot for an assigned task, background work, or anything potentially long-running. When the user asks you to assemble a team, use create_bot for each genuinely useful specialist. Give each one a clear role and instructions, then use delegate_bot to assign its work. Do not create duplicate or unnecessary bots. Delegate with a clear, self-contained brief. Say that the task is assigned, not completed; only claim completion after the teammate's result has actually arrived. You may assign work to more than one teammate when the request genuinely benefits. Stay responsive while they work, then combine their returned results when the user asks for a synthesis.",
        "Current Work section team:",
        "- Quill — Writer: Drafts concise copy (available)",
        "- Patch — Engineer (working right now)",
        "TRUSTED OPENMAUSBOT STATUS",
        "freshness=fresh",
      ].join("\n"),
    );
  });

  it("narrows the Chief's own roster when the Chief carries an allow-list", () => {
    // The roster and the comms endpoints read the same rule, so a Chief is
    // never told about a teammate its own ask_bot would then be refused.
    const prompt = chiefOfStaffSystemPrompt(
      "chief",
      bots.map((bot) => (bot.id === "chief" ? { ...bot, peers: ["coder"] } : bot)),
      true,
    );

    expect(prompt).toContain("Patch — Engineer (working right now)");
    expect(prompt).not.toContain("Quill");
  });
});
