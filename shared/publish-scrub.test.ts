import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { addScrubCounts, emptyScrubCounts, personalNames, scrubText, scrubTree, type ScrubCounts } from "./publish-scrub.ts";

interface Vector { name: string; input: string; names?: string[]; output: string; counts: ScrubCounts }
const VECTORS = JSON.parse(readFileSync(join(import.meta.dirname, "publish-scrub.vectors.json"), "utf8")) as Vector[];

describe("scrubText", () => {
  it.each(VECTORS.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    const names = vector.names ? personalNames(vector.names) : undefined;
    const once = scrubText(vector.input, names ? { names } : {});
    expect(once.text).toBe(vector.output);
    expect(once.counts).toEqual(vector.counts);
    const twice = scrubText(once.text, names ? { names } : {});
    expect(twice.text).toBe(once.text);
    expect(twice.counts).toEqual(emptyScrubCounts());
  });

  it("removes the shapes from the submissions that leaked", () => {
    const leaked = [
      "Work in /Users/arjunmehta/WorkSpace/clients/northwind before anything else.",
      "Write the report to /Users/arjunmehta/.openmausbot/workspaces/0b9c3a52-8d61-4f0e-a2b7-5c1e9d4f3a10/reports/q4.md",
      "Contact arjun.mehta@northwind-labs.com or +91 98765 43210.",
    ].join("\n");
    const { text, counts } = scrubText(leaked);
    expect(text).not.toMatch(/arjun|northwind-labs|98765/i);
    expect(text).toContain("~/WorkSpace/clients/northwind");
    expect(text).toContain("<workspace>/reports/q4.md");
    expect(counts).toEqual({ paths: 2, emails: 1, phones: 1, names: 0, secrets: 0 });
  });

  it("leaves a routine's timestamps and ids alone", () => {
    const routine = "schedule:\n  type: once\n  at: 1794748391525\nanchorAt: 1794748391525\nkey: routine-7c9e6679\nupdatedAt: 1764060000000";
    expect(scrubText(routine).text).toBe(routine);
  });

  it("is quick on long hostile text", () => {
    const hostile = ["+1 ".repeat(200_000), "/Users/".repeat(100_000), "a@".repeat(200_000), "/.openmausbot/x".repeat(50_000),
      "-----BEGIN PRIVATE KEY-----\n".repeat(20_000), "Bearer ".repeat(100_000), "C:\\Users\\A B C D ".repeat(50_000)];
    const started = performance.now();
    for (const text of hostile) scrubText(text, { names: ["Jane Doe"] });
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("personalNames", () => {
  it("keeps real names and drops common words, short words, addresses and the credit", () => {
    expect(personalNames(["root", "node", "omb", "bob", "jane.doe@acme.io", "  Jane   Doe ", "janedoe", "", undefined, null])).toEqual(["Jane Doe", "janedoe"]);
    expect(personalNames(["Jane Doe", "janedoe"], "jane doe")).toEqual(["janedoe"]);
    expect(personalNames(["Jane Doe", "Jane Doe", "JANE DOE"])).toHaveLength(1);
  });

  it("matches a name as a whole word, in any letter case, with accents", () => {
    const names = personalNames(["José Núñez"]);
    expect(scrubText("josé núñez wrote this; JoséNúñez did not", { names }).text).toBe("<name> wrote this; JoséNúñez did not");
  });

  it("never treats a name as a pattern", () => {
    const names = personalNames(["a.b.c (x)"]);
    expect(scrubText("a.b.c (x) and aXbXc (x)", { names }).text).toBe("<name> and aXbXc (x)");
  });
});

describe("scrubTree", () => {
  it("scrubs every string in a copy and adds up what it found", () => {
    const input = {
      name: "Scout",
      agents: [{ key: "scout", description: "Lives in /home/bob", appearance: { avatar: { data: "data:image/png;base64,/Users/bob+AIza" + "A".repeat(40) } } }],
      skills: { entries: [{ name: "x", instructions: "Mail bob@acme.io", files: [{ path: "run.sh", content: "cd /Users/bob" }] }] },
      setupMinutes: 5,
      tags: ["/Users/bob/x", "plain"],
    };
    const { value, counts } = scrubTree(input);
    expect(value.agents[0]!.description).toBe("Lives in ~");
    expect(value.agents[0]!.appearance.avatar.data).toBe(input.agents[0]!.appearance.avatar.data);
    expect(value.skills.entries[0]!.instructions).toBe("Mail <email>");
    expect(value.skills.entries[0]!.files[0]!.content).toBe("cd /Users/bob");
    expect(value.tags).toEqual(["~/x", "plain"]);
    expect(value.setupMinutes).toBe(5);
    expect(input.agents[0]!.description).toBe("Lives in /home/bob");
    expect(counts).toEqual({ paths: 2, emails: 1, phones: 0, names: 0, secrets: 0 });
  });

  it("adds counts field by field", () => {
    expect(addScrubCounts({ paths: 1, emails: 2, phones: 3, names: 4, secrets: 5 }, { paths: 1, emails: 1, phones: 1, names: 1, secrets: 1 }))
      .toEqual({ paths: 2, emails: 3, phones: 4, names: 5, secrets: 6 });
  });
});
