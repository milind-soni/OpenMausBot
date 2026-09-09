import { describe, expect, it } from "vitest";

import {
  consequenceLine,
  executableFingerprint,
  proposalError,
  reviewedProposalSha256,
  type ToolProposalCardData,
} from "./tool-proposal";

const proposal = (patch: Partial<ToolProposalCardData> = {}): ToolProposalCardData => ({
  version: 1,
  capability: "calendar",
  kind: "mcp",
  label: "Fastmail Calendar MCP",
  summary: "Read and create events on a Fastmail calendar.",
  packageId: "@example/fastmail-calendar-mcp",
  packageVersion: "1.4.2",
  publisher: "example",
  homepage: "https://example.com/fastmail-mcp",
  command: "npx",
  args: ["-y", "@example/fastmail-calendar-mcp@1.4.2"],
  envNames: ["FASTMAIL_TOKEN"],
  sources: [{ url: "https://www.npmjs.com/package/@example/fastmail-calendar-mcp", note: "package page" }],
  ...patch,
});

describe("proposalError", () => {
  it("accepts a proposal a person could actually check", () => {
    expect(proposalError(proposal())).toBeNull();
  });

  it("refuses a version range — the approval was for what was on screen", () => {
    // "^1.4.2" can become a different program tomorrow, under the same click.
    for (const packageVersion of ["^1.4.2", "~1.4", "1.x", "latest", ""]) {
      expect(proposalError(proposal({ packageVersion }))).toMatch(/exact version/);
    }
  });

  it("refuses a proposal with nothing to check", () => {
    expect(proposalError(proposal({ sources: [] }))).toMatch(/source/);
    // "the model said so" is not a source anyone can open
    expect(proposalError(proposal({ sources: [{ url: "trust me" }] }))).toMatch(/https/);
    expect(proposalError(proposal({ sources: [{ url: "http://example.com" }] }))).toMatch(/https/);
  });

  it("refuses one that does not say what it is or what would run", () => {
    expect(proposalError(proposal({ label: "  " }))).toMatch(/name/);
    expect(proposalError(proposal({ packageId: "" }))).toMatch(/package/);
    expect(proposalError(proposal({ command: "" }))).toMatch(/command/);
  });
});

describe("executableFingerprint", () => {
  it("changes when what runs changes", () => {
    const base = executableFingerprint(proposal());
    expect(executableFingerprint(proposal({ command: "node" }))).not.toBe(base);
    expect(executableFingerprint(proposal({ args: ["-y", "@example/other@1.4.2"] }))).not.toBe(base);
    expect(executableFingerprint(proposal({ packageVersion: "1.4.3" }))).not.toBe(base);
    expect(executableFingerprint(proposal({ envNames: ["FASTMAIL_TOKEN", "AWS_SECRET_ACCESS_KEY"] }))).not.toBe(base);
  });

  it("does not change when only the words around it change", () => {
    // Rewording the pitch must not invalidate an approval; changing the
    // program must. These are the two halves of the same rule.
    const base = executableFingerprint(proposal());
    expect(executableFingerprint(proposal({ summary: "totally different pitch" }))).toBe(base);
    expect(executableFingerprint(proposal({ sources: [{ url: "https://example.com/else" }] }))).toBe(base);
    expect(executableFingerprint(proposal({ label: "Renamed" }))).toBe(base);
  });

  it("reads the same environment whatever order it was listed in", () => {
    expect(executableFingerprint(proposal({ envNames: ["B", "A"] })))
      .toBe(executableFingerprint(proposal({ envNames: ["A", "B"] })));
  });
});

describe("reviewedProposalSha256", () => {
  it("only echoes a real hash, so an old card stays decline-only", () => {
    expect(reviewedProposalSha256(proposal({ sha256: "a".repeat(64) }))).toBe("a".repeat(64));
    expect(reviewedProposalSha256(proposal({ sha256: undefined }))).toBeUndefined();
    expect(reviewedProposalSha256(proposal({ sha256: "nope" }))).toBeUndefined();
  });
});

describe("consequenceLine", () => {
  it("names what approving does, not what it is called", () => {
    // The consent has to be about code running, because that is what happens.
    const line = consequenceLine(proposal());
    expect(line).toContain("npx -y @example/fastmail-calendar-mcp@1.4.2");
    expect(line).toContain("on this computer");
    expect(consequenceLine(proposal({ kind: "cli" }))).toContain("on this computer");
  });
});

describe("a tool the bot generated", () => {
  const built = (patch: Partial<ToolProposalCardData> = {}): ToolProposalCardData => proposal({
    kind: "generated",
    label: "WeldLog CLI",
    packageId: "",
    packageVersion: "",
    publisher: undefined,
    builtFrom: "https://weldlog.example/docs/api",
    command: "/Users/x/.openmausbot/tools/weldlog-pp-mcp",
    args: [],
    sources: [],
    ...patch,
  });

  it("asks for the documentation it was built from instead of a package", () => {
    // There is no package and no publisher, and inventing either would be the
    // one dishonest field on a card built to be honest.
    expect(proposalError(built())).toBeNull();
    expect(proposalError(built({ builtFrom: undefined }))).toMatch(/built from/);
    expect(proposalError(built({ builtFrom: "http://weldlog.example" }))).toMatch(/built from/);
  });

  it("still needs a name and a command", () => {
    expect(proposalError(built({ label: "" }))).toMatch(/name/);
    expect(proposalError(built({ command: "" }))).toMatch(/command/);
  });

  it("says who wrote it, because that is the part that differs", () => {
    const line = consequenceLine(built());
    expect(line).toContain("on this computer");
    expect(line).toContain("generated this itself");
    expect(line).toContain("nobody else has reviewed it");
  });

  it("binds the approval to what it was built from", () => {
    expect(executableFingerprint(built({ builtFrom: "https://a.example/docs" })))
      .not.toBe(executableFingerprint(built({ builtFrom: "https://b.example/docs" })));
  });
});
