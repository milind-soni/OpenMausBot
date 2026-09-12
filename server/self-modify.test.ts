// Unit tests for the self-modify subsystem. Every disk-facing test runs in
// an isolated fixture: the vitest setup file has already redirected homedir()
// to a throwaway per-file home (so DATA_DIR and every self-modify dir land
// inside it), and `root` params point at a separate throwaway "project" with
// its own package.json — the real repo's sources are never touched.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JournalEntry } from "./self-modify.ts";

// The module derives its dirs from config.ts's DATA_DIR, which server/testing/setup.ts
// has already resolved to the throwaway per-file home (homedir() is redirected
// before any server module evaluates). Import the same value so test paths and
// module paths can never diverge.
const { DATA_DIR } = await import("./config.ts");

const {
  applyPending,
  applyProposal,
  activeProposalFor,
  discardPending,
  failStartupCheck,
  isProtectedPath,
  listJournal,
  listPending,
  markProposalForBoot,
  parseProposal,
  preflightCheck,
  protectedContentHit,
  readJournal,
  readProposal,
  reconcileAbandonedProposals,
  resolveProposalPath,
  revertProposal,
  settleProposal,
  validateProposal,
  verifyBootedProposal,
  writeJournal,
} = await import("./self-modify.ts");

let root: string;

// The module's self-modify directory (journal, backups, pending inbox, marker).
const MOD_DIR = join(DATA_DIR, "self-modify");

const PROPS_TS = `export const props = { tick: 1 };
`;
const VALID_EDIT = `export const props = { tick: 2 };\nexport function double(n: number): number { return n * 2; }\n`;
const BROKEN_EDIT = `export const props = { tick: 3\n`;

function proposalFor(overrides: Record<string, unknown> = {}, files?: unknown): string {
  return JSON.stringify({
    id: "t-prop",
    proposedBy: "unit-test",
    reason: "make tick better",
    files: files ?? [{ path: "server/props.ts", action: "edit", content: VALID_EDIT }],
    ...overrides,
  });
}

function seedRoot(): void {
  mkdirSync(join(root, "server"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.1" }, null, 2));
  writeFileSync(join(root, "server", "props.ts"), PROPS_TS);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omb-self-modify-root-"));
  seedRoot();
  // The journal and inbox live in a per-file data dir and would otherwise
  // leak state between tests (e.g. the one-applied-trial invariant).
  rmSync(MOD_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── paths & protection ──────────────────────────────────────────────────

describe("resolveProposalPath", () => {
  it("accepts a relative server path and returns its absolute form", () => {
    const out = resolveProposalPath("server/props.ts", root);
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect(out.path).toBe("server/props.ts");
      expect(out.absolute).toBe(join(root, "server", "props.ts"));
    }
  });

  it("refuses traversal, absolute paths, unknown roots, and package.json", () => {
    expect(resolveProposalPath("../outside.ts", root)).toHaveProperty("error");
    expect(resolveProposalPath("C:/Windows/x.ts", root)).toHaveProperty("error");
    expect(resolveProposalPath("electron/main.ts", root)).toHaveProperty("error");
    expect(resolveProposalPath("package.json", root)).toHaveProperty("error");
  });

  it("allows only source-file extensions", () => {
    expect(resolveProposalPath("server/notes.md", root)).toHaveProperty("error");
    expect(resolveProposalPath("server/style.css", root)).not.toHaveProperty("error");
  });
});

describe("isProtectedPath", () => {
  it("protects the machinery, exactly and by prefix", () => {
    expect(isProtectedPath("server/self-modify.ts")).toBe(true);
    expect(isProtectedPath("electron/self-modify-watchdog.mjs")).toBe(true);
    expect(isProtectedPath("server/self-modify/helper.ts")).toBe(true);
    expect(isProtectedPath(".github/workflows/ci.yml")).toBe(true);
  });

  it("leaves ordinary sources editable", () => {
    expect(isProtectedPath("server/props.ts")).toBe(false);
    expect(isProtectedPath("src/lib/ui.ts")).toBe(false);
  });
});

describe("protectedContentHit", () => {
  it("flags content that disarms the guards", () => {
    expect(protectedContentHit("process.env.OMB_SELF_MODIFY = '1'")).toMatch(/gate/);
    expect(protectedContentHit("import { revertProposal } from './self-modify.ts'")).toMatch(/machinery/);
    expect(protectedContentHit("spawn('electron/self-modify-watchdog.mjs')")).toMatch(/watchdog/);
  });

  it("passes ordinary code", () => {
    expect(protectedContentHit("export const props = { tick: 2 };")).toBeNull();
  });
});

// ── parsing & validation ────────────────────────────────────────────────

describe("parseProposal", () => {
  it("parses a well-formed proposal", () => {
    const out = parseProposal(proposalFor());
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect(out.id).toBe("t-prop");
      expect(out.files).toHaveLength(1);
      expect(out.files[0]?.content).toBe(VALID_EDIT);
    }
  });

  it("refuses malformed input", () => {
    expect(parseProposal("not json")).toHaveProperty("error");
    expect(parseProposal(JSON.stringify({ id: "bad id!", proposedBy: "x", reason: "y", files: [{ path: "server/a.ts", action: "edit", content: "z" }] }))).toHaveProperty("error");
    expect(parseProposal(JSON.stringify({ id: "ok-id", proposedBy: "x", reason: "y", files: [] }))).toHaveProperty("error");
    expect(parseProposal(JSON.stringify({ id: "ok-id", proposedBy: "x", reason: "y", files: [{ path: "server/a.ts", action: "edit" }] }))).toHaveProperty("error");
  });

  it("caps file and proposal sizes", () => {
    const big = "x".repeat(513 * 1024);
    expect(parseProposal(proposalFor({}, [{ path: "server/a.ts", action: "edit", content: big }]))).toHaveProperty("error");
  });
});

describe("validateProposal", () => {
  it("enforces create/edit/delete preconditions", () => {
    const parsed = parseProposal(proposalFor({}, [
      { path: "server/props.ts", action: "create", content: "x" },
      { path: "server/missing.ts", action: "edit", content: "x" },
      { path: "server/also-missing.ts", action: "delete" },
    ]));
    const errors = validateProposal(parsed as never, root);
    expect(errors.join(" ")).toContain("already exists");
    expect(errors.join(" ")).toContain("does not exist");
  });

  it("refuses protected paths and protected content", () => {
    const parsed = parseProposal(proposalFor({}, [
      { path: "server/self-modify.ts", action: "edit", content: "// tweaked" },
      { path: "server/props.ts", action: "edit", content: "const OMB_SELF_MODIFY = true;" },
    ]));
    const errors = validateProposal(parsed as never, root);
    expect(errors.some((e) => e.includes("protected path"))).toBe(true);
    expect(errors.some((e) => e.includes("refused content"))).toBe(true);
  });

  it("allows only dependency sections in packageJson", () => {
    const parsed = parseProposal(proposalFor({ packageJson: { dependencies: { leftpad: "1.0.0" }, scripts: { postinstall: "curl evil" } } }));
    const errors = validateProposal(parsed as never, root);
    expect(errors.join(" ")).toContain("packageJson.scripts");
  });
});

// ── journal ─────────────────────────────────────────────────────────────

describe("journal", () => {
  it("round-trips an entry and lists them", () => {
    const entry: JournalEntry = {
      proposal: { id: "j-1", proposedBy: "t", reason: "r", files: [{ path: "server/props.ts", action: "edit", content: VALID_EDIT }] },
      status: "applied",
      appliedAt: new Date().toISOString(),
      entries: [],
    };
    writeJournal(entry);
    expect(readJournal("j-1")?.status).toBe("applied");
    expect(readJournal("nope")).toBeNull();
    expect(listJournal().map((e) => e.proposal.id)).toContain("j-1");
  });

  it("skips a torn journal file instead of crashing", () => {
    const dir = join(MOD_DIR, "journal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "torn.json"), "{ truncated", "utf8");
    expect(() => listJournal()).not.toThrow();
  });
});

// ── preflight gate ──────────────────────────────────────────────────────

describe("preflightCheck", () => {
  it("passes a file that parses", () => {
    writeFileSync(join(root, "server", "props.ts"), VALID_EDIT, "utf8");
    const checks = preflightCheck({ id: "p", proposedBy: "t", reason: "r", files: [{ path: "server/props.ts", action: "edit", content: VALID_EDIT }] }, root);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.ok).toBe(true);
  });

  it("fails a file with a syntax error, with detail", () => {
    // The gate checks the file as it sits on disk (applyProposal writes
    // content before gating), so mirror that here.
    writeFileSync(join(root, "server", "props.ts"), BROKEN_EDIT, "utf8");
    const checks = preflightCheck({ id: "p", proposedBy: "t", reason: "r", files: [{ path: "server/props.ts", action: "edit", content: BROKEN_EDIT }] }, root);
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.detail).toBeTruthy();
  });
});

// ── apply / revert ──────────────────────────────────────────────────────

describe("applyProposal", () => {
  it("applies a valid server edit and snapshots the original bytes", () => {
    const raw = proposalFor({ id: "a-ok" });
    const out = applyProposal(raw, root);
    expect(out.ok).toBe(true);
    const backup = join(MOD_DIR, "journal", "a-ok.backup", "server__props.ts");
    expect(readFileSync(backup, "utf8")).toBe(PROPS_TS);
    expect(readFileSync(join(root, "server", "props.ts"), "utf8")).toBe(VALID_EDIT);
    expect(readJournal("a-ok")?.status).toBe("applied");
  });

  it("applies a src/ edit without a server preflight", () => {
    const raw = proposalFor({ id: "a-src" }, [{ path: "src/new.css", action: "create", content: "body { color: teal; }" }]);
    const out = applyProposal(raw, root);
    expect(out.ok).toBe(true);
    expect(existsSync(join(root, "src", "new.css"))).toBe(true);
  });

  it("reverts byte-exactly when the preflight gate fails", () => {
    const raw = proposalFor({ id: "a-bad" }, [{ path: "server/props.ts", action: "edit", content: BROKEN_EDIT }]);
    const out = applyProposal(raw, root);
    expect(out.ok).toBe(false);
    expect("error" in out && out.error).toContain("reverted");
    expect(readFileSync(join(root, "server", "props.ts"), "utf8")).toBe(PROPS_TS);
    expect(readJournal("a-bad")?.status).toBe("reverted");
  });

  it("refuses validation failures before touching the journal", () => {
    const raw = proposalFor({ id: "a-guard" }, [{ path: "server/self-modify.ts", action: "edit", content: "// no" }]);
    const out = applyProposal(raw, root);
    expect(out.ok).toBe(false);
    expect(readJournal("a-guard")).toBeNull();
    expect(readFileSync(join(root, "server", "props.ts"), "utf8")).toBe(PROPS_TS);
  });

  it("allows only one applied server-touching proposal at a time", () => {
    expect(applyProposal(proposalFor({ id: "one" }), root).ok).toBe(true);
    const second = applyProposal(proposalFor({ id: "two" }, [{ path: "server/props.ts", action: "edit", content: VALID_EDIT }]), root);
    expect(second.ok).toBe(false);
    expect("error" in second && second.error).toContain("awaiting its trial boot");
    // A src/-only edit does not compete with the open trial.
    expect(applyProposal(proposalFor({ id: "three" }, [{ path: "src/other.css", action: "create", content: "p{}" }]), root).ok).toBe(true);
  });

  it("restores on revertProposal, idempotently", () => {
    const raw = proposalFor({ id: "a-again" });
    const applied = applyProposal(raw, root);
    if (!applied.ok) throw new Error("setup failed");
    const reverted = revertProposal(applied.entry, "test", root);
    expect(reverted.status).toBe("reverted");
    expect(readFileSync(join(root, "server", "props.ts"), "utf8")).toBe(PROPS_TS);
    expect(revertProposal(applied.entry, "again", root).status).toBe("reverted");
  });
});

// ── pending inbox ───────────────────────────────────────────────────────

describe("pending inbox", () => {
  const pendingDir = join(MOD_DIR, "pending");

  function drop(name: string, raw: string): void {
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(join(pendingDir, name), raw, "utf8");
  }

  afterEach(() => {
    rmSync(pendingDir, { recursive: true, force: true });
  });

  it("lists pending files with validation notes", () => {
    drop("p-good.json", proposalFor({ id: "p-good" }));
    drop("p-bad.json", "not json");
    const listed = listPending();
    expect(listed.find((p) => p.file === "p-good.json")?.id).toBe("p-good");
    expect(listed.find((p) => p.file === "p-bad.json")?.invalid).toBeTruthy();
  });

  it("applyPending applies and consumes; gate failures are consumed too", () => {
    drop("p-apply.json", proposalFor({ id: "p-apply" }));
    const out = applyPending("p-apply", root);
    expect(out.ok).toBe(true);
    expect(out.consumed).toBe(true);
    expect(existsSync(join(pendingDir, "p-apply.json"))).toBe(false);

    // Settle the open trial so the next proposal reaches the gate instead
    // of the one-applied-proposal invariant.
    settleProposal("p-apply", "reverted", "test cleanup", root);
    drop("p-broke.json", proposalFor({ id: "p-broke" }, [{ path: "server/props.ts", action: "edit", content: BROKEN_EDIT }]));
    const broke = applyPending("p-broke", root);
    expect(broke.ok).toBe(false);
    expect(broke.consumed).toBe(true);
    expect(existsSync(join(pendingDir, "p-broke.json"))).toBe(false);
    expect(readFileSync(join(root, "server", "props.ts"), "utf8")).toBe(PROPS_TS);
  });

  it("keeps unknown ids unread and discardPending removes files", () => {
    expect(applyPending("ghost", root).consumed).toBe(false);
    drop("p-drop.json", proposalFor({ id: "p-drop" }));
    expect(readProposal("p-drop")?.file).toBe("p-drop.json");
    expect(discardPending("p-drop")).toBe(true);
    expect(discardPending("p-drop")).toBe(false);
  });
});

// ── trial-boot lifecycle ────────────────────────────────────────────────

describe("trial-boot lifecycle", () => {
  function freshEntry(id: string): JournalEntry {
    const backup = join(MOD_DIR, "journal", `${id}.backup`, "server__props.ts");
    mkdirSync(join(MOD_DIR, "journal", `${id}.backup`), { recursive: true });
    writeFileSync(backup, PROPS_TS, "utf8");
    return {
      proposal: { id, proposedBy: "t", reason: "r", files: [{ path: "server/props.ts", action: "edit", content: VALID_EDIT }] },
      status: "applied",
      appliedAt: new Date().toISOString(),
      entries: [{ path: "server/props.ts", backupPath: backup, deleted: false }],
    };
  }

  const markerPath = join(MOD_DIR, "boot-marker.json");

  afterEach(() => {
    rmSync(markerPath, { force: true });
  });

  it("mark → active; verify promotes and clears the marker", () => {
    writeJournal(freshEntry("boot-1"));
    expect(activeProposalFor()).toBeNull();

    markProposalForBoot(readJournal("boot-1")!);
    expect(activeProposalFor()?.proposal.id).toBe("boot-1");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { pid: number };
    expect(marker.pid).toBe(process.pid);

    const verified = verifyBootedProposal();
    expect(verified?.status).toBe("verified");
    expect(activeProposalFor()).toBeNull();
    expect(existsSync(markerPath)).toBe(false);
  });

  it("failStartupCheck restores the originals and clears the marker", () => {
    writeJournal(freshEntry("boot-2"));
    markProposalForBoot(readJournal("boot-2")!);
    const out = failStartupCheck("boot exploded", root);
    expect(out?.status).toBe("reverted");
    expect(readFileSync(join(root, "server", "props.ts"), "utf8")).toBe(PROPS_TS);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("reconcile reverts foreign-pid entries but not this boot's own", () => {
    writeJournal(freshEntry("boot-3"));
    markProposalForBoot(readJournal("boot-3")!);
    // A leftover entry from a dead run (no marker for THIS pid).
    const dead = freshEntry("boot-dead");
    dead.bootMarker = { pid: 999_999_999 };
    writeJournal(dead);
    const reverted = reconcileAbandonedProposals(root);
    expect(reverted).toContain("boot-dead");
    expect(reverted).not.toContain("boot-3");
    expect(readJournal("boot-3")?.status).toBe("applied");

    // And the foreign entry's file was restored.
    expect(readFileSync(join(root, "server", "props.ts"), "utf8")).toBe(PROPS_TS);
  });

  it("settleProposal verifies or reverts an applied entry by id", () => {
    writeJournal(freshEntry("boot-4"));
    expect(settleProposal("boot-4", "verified")?.status).toBe("verified");

    writeJournal(freshEntry("boot-5"));
    const reverted = settleProposal("boot-5", "reverted", "operator said so", root);
    expect(reverted?.status).toBe("reverted");
    expect(reverted?.revertReason).toBe("operator said so");
    expect(readFileSync(join(root, "server", "props.ts"), "utf8")).toBe(PROPS_TS);
  });
});
