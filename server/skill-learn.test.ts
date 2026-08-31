import { describe, expect, it } from "vitest";

import {
    LEARN_PROMPT_MARKER,
    LEARN_SOURCE_PREFIX,
    buildLearnPrompt,
    expandLearnTurnText,
    learnSource,
    parseLearnCommand,
} from "./skill-learn.ts";

describe("parseLearnCommand", () => {
    it("recognises /learn with and without a request", () => {
        expect(parseLearnCommand("/learn")).toEqual({ request: "" });
        expect(parseLearnCommand("  /LEARN how I just deployed staging  ")).toEqual({
            request: "how I just deployed staging",
        });
        expect(parseLearnCommand("/learn\nhttps://docs.example.com/api")).toEqual({
            request: "https://docs.example.com/api",
        });
    });

    it("ignores ordinary chat that only mentions the word", () => {
        expect(parseLearnCommand("please learn this workflow")).toBeNull();
        expect(parseLearnCommand("use /learn later")).toBeNull();
        expect(parseLearnCommand("")).toBeNull();
    });
});

describe("expandLearnTurnText", () => {
    it("leaves non-learn messages alone and expands /learn into the authoring prompt", () => {
        expect(expandLearnTurnText("fix the tests")).toBe("fix the tests");
        const expanded = expandLearnTurnText("/learn the REST client in ~/sdk");
        expect(expanded.startsWith(LEARN_PROMPT_MARKER)).toBe(true);
        expect(expanded).toContain("the REST client in ~/sdk");
        expect(expanded).toContain("skill_manage");
        expect(expanded).toContain("current version untouched");
        expect(expanded).toContain('source as the exact URL or folder');
        expect(expanded).toContain('action="update"');
        expect(expanded).toContain("explicitly asked to revise");
        expect(expanded).toContain("exact SKILL.md path listed for that skill");
    });

    it("treats a bare /learn as 'what we just did'", () => {
        const expanded = buildLearnPrompt("");
        expect(expanded).toContain("workflow we just went through");
        expect(learnSource("")).toBe(`${LEARN_SOURCE_PREFIX}conversation`);
    });
});
