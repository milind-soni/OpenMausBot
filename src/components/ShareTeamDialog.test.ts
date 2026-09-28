import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { saveShareFile, SHARE_VIEW_START, shareRefused, tickedSkills, type ShareResponse } from "@/lib/team-share";
import { teamImportPreview } from "@/lib/team-import";
import { ApiError } from "@/state/store";
import { ShareSkillChoices, ShareTeamContents } from "./ShareTeamDialog";
import { TeamMenuItems } from "./Sidebar";
import { shareableTeamList, TeamImportDetails } from "./TeamLibraryPanel";
import { packageSummary, parsePackageDocument } from "../../shared/package-format";

const fixture = () => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8"));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Share team", () => {
  it("is in every named team's menu", () => {
    const markup = renderToStaticMarkup(createElement(TeamMenuItems, { onAddBots: vi.fn(), onRename: vi.fn(), onShare: vi.fn(), onDelete: vi.fn() }));
    expect(text(markup)).toMatch(/Add bots .*Rename team .*Share team… .*Delete team/);
    expect(markup.match(/role="menuitem"/g)).toHaveLength(4);
  });

  it("lists shareable teams, named teams first and General last, never empty ones", () => {
    expect(shareableTeamList(["Sales desk", "Empty", "Support"], [
      { section: "Support" }, { section: " Sales desk " }, { section: "Sales desk" }, { section: "Sales desk", hidden: true }, {}, { section: "Unlisted" },
    ])).toEqual([
      { name: "Sales desk", bots: 2 }, { name: "Support", bots: 1 }, { name: "Unlisted", bots: 1 }, { name: "", bots: 1 },
    ]);
  });

  it("shows exactly what the file holds, what never travels, and what was removed or left out", () => {
    const document = parsePackageDocument(fixture());
    const preview: ShareResponse = {
      document, filename: "sales-desk-1.3.0.openmaus.json", summary: packageSummary(document), choices: { skills: [] },
      redacted: ["agents[scout].soul"],
      skipped: [{ part: "connections[local-tool]", reason: "stdio_server" }, { part: "routines[daily-digest].attachments", reason: "files_not_shared" }],
    };
    const words = text(renderToStaticMarkup(createElement(ShareTeamContents, { preview, includeMemory: true, localSkips: ["Quill · picture — picture is larger than 64 KB"] })));
    for (const line of [
      "Bots 3 · Morgan, Scout, Quill", "Skills · arrive switched off 3", "Playbooks 1", "Group chats 1", "Routines · arrive paused 2",
      "Shared instructions Included", "Chief of Staff Morgan", "Connections · addresses only 1", "Pictures 1", "Starter notes 2",
      "Never included: chat history, keys and passwords, model choices, computers, and who can see each bot.",
      "Removed what looked like a key or password from: Scout · standing instructions",
      "Quill · picture — picture is larger than 64 KB",
      "local-tool · connection — runs a command on this computer, so it is not shared",
      "Daily digest · attachments — attached files are not shared",
      "Connection addresses in the file CRM · https://mcp.example.com/crm",
    ]) expect(words).toContain(line);
    expect(text(renderToStaticMarkup(createElement(ShareTeamContents, { preview, includeMemory: false, localSkips: [] })))).toContain("Starter notes None");
  });

  it("keeps every skill box when a 31-skill bot's exact choice is refused", () => {
    // The refusal the server sends for a bot with 31 ticked skills: the
    // sentence, and the team's skill names so the boxes stay drawn.
    const names = Array.from({ length: 31 }, (_, index) => `step-${String(index + 1).padStart(2, "0")}`);
    const refusal = new ApiError("Morgan has more than 30 skills. Choose fewer skills and try again.", 400,
      { error: "Morgan has more than 30 skills. Choose fewer skills and try again.", choices: { skills: names } });
    // The dialog's state after that refusal, from the API client's real error.
    const view = shareRefused({ ...SHARE_VIEW_START, included: names.slice(0, 30) }, refusal);
    expect(view.preview).toBeNull();
    expect(view.error).toBe("Morgan has more than 30 skills. Choose fewer skills and try again.");
    const available = view.available!;
    const markup = renderToStaticMarkup(createElement(ShareSkillChoices, {
      available, ticked: tickedSkills(null, view.included, available), counted: true, onToggle: vi.fn(),
    }));
    expect(markup.match(/type="checkbox"/g)).toHaveLength(31);
    expect(markup.match(/checked=""/g)).toHaveLength(30);
    expect(markup).toMatch(/<input type="checkbox"[^>]*\/>step-31/);
    expect(markup).not.toMatch(/checked=""[^>]*\/>step-31/);
    expect(text(renderToStaticMarkup(createElement(ShareSkillChoices, { available: [], ticked: new Set<string>(), counted: true, onToggle: vi.fn() }))))
      .toContain("This team's bots have no skills.");
  });

  it("saves the document as the file other apps and Admin read", async () => {
    const clicks: Array<{ href: string; download: string }> = [];
    const link = { href: "", download: "", click() { clicks.push({ href: this.href, download: this.download }); }, remove: vi.fn() };
    let saved: Blob | undefined;
    vi.stubGlobal("window", { document: { createElement: () => link, body: { appendChild: vi.fn() } }, setTimeout: vi.fn() });
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => { saved = blob as Blob; return "blob:share"; });
    const document = parsePackageDocument(fixture());
    saveShareFile("sales-desk-1.3.0.openmaus.json", document);
    expect(clicks).toEqual([{ href: "blob:share", download: "sales-desk-1.3.0.openmaus.json" }]);
    expect(parsePackageDocument(JSON.parse(await saved!.text()))).toEqual(document);
  });
});

describe("importing a shared team", () => {
  it("previews every part before anything is added", () => {
    const pending = teamImportPreview(fixture());
    const words = text(renderToStaticMarkup(createElement(TeamImportDetails, { pending, importedNames: ["Morgan", "Scout", "Quill"] })));
    for (const line of [
      "Shared instructions", "49 per seat", "Morgan leads", "1 group chat", "1 playbooks", "Routines: 2 · paused",
      "Connections to finish: 1 · keys and passwords are never included", "CRM · https://mcp.example.com/crm",
      "Starter notes: 2", "Preset bots: 1 · appear in New bot",
      "Included skills — added switched off", "pricing-policy, research-brief", "Offered skills — not added to any bot", "objection-handling",
      "Skills arrive switched off and routines paused.",
    ]) expect(words).toContain(line);
    expect(renderToStaticMarkup(createElement(TeamImportDetails, { pending, importedNames: ["Morgan", "Scout", "Quill"] })))
      .toContain('src="data:image/png;base64,iVBOR');
  });
});
