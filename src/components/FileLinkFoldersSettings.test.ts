import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, StoreContext, type AppState } from "@/state/store";
import { FileLinkFoldersSettings, saveExtraFileLinkRoots } from "./FileLinkFoldersSettings";
import { OutsideWorkspaceFile } from "./AttachmentPreview";

vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));

afterEach(() => vi.unstubAllGlobals());

function withStore(config: Partial<NonNullable<AppState["config"]>>, element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(
    createElement(StoreContext.Provider, {
      value: {
        state: { ...initialState, config: config as AppState["config"] },
        dispatch: vi.fn(),
        flushBotPatches: async () => null,
        refreshInstances: async () => {},
        refreshModels: async () => {},
      },
      children: element,
    }),
  );
}

describe("FileLinkFoldersSettings", () => {
  it("lists configured self-hosted folders and hides on Cloud homes", () => {
    const html = withStore(
      { fileLinks: { extraRoots: ["/home/me/team-docs"] } },
      createElement(FileLinkFoldersSettings),
    );
    expect(html).toContain("Linked file folders");
    expect(html).toContain("/home/me/team-docs");
    expect(withStore({ cloudHome: true }, createElement(FileLinkFoldersSettings))).toBe("");
  });

  it("serializes concurrent saves for the same dispatch and drops superseded responses", async () => {
    const dispatched: string[][] = [];
    const dispatch = vi.fn((action: { type: "configStatus"; config: { fileLinks?: { extraRoots: string[] } } }) => {
      dispatched.push(action.config.fileLinks?.extraRoots ?? []);
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => {
      calls.push(init?.body ?? "");
      if (calls.length === 1) await firstGate;
      const roots = JSON.parse(init?.body ?? "{}").fileLinks?.extraRoots ?? [];
      return new Response(JSON.stringify({ fileLinks: { extraRoots: roots } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const first = saveExtraFileLinkRoots(["/a"], [], dispatch as never);
    const second = saveExtraFileLinkRoots(["/a", "/b"], ["/a"], dispatch as never);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(2);
    expect(dispatched).toEqual([["/a", "/b"]]);
  });
});

describe("OutsideWorkspaceFile on self-hosted remote clients", () => {
  it("offers to allow the parent folder when the owner views a self-hosted remote path", () => {
    vi.stubGlobal("window", { ogb: { revealInFolder: vi.fn(), remoteClient: { active: true } } });
    const html = withStore(
      { fileLinks: { extraRoots: [] } },
      createElement(OutsideWorkspaceFile, { filePath: "/home/me/project/NOTES.md" }),
    );
    expect(html).toContain(">/home/me/project/NOTES.md</code>");
    expect(html).toContain("Allow files from /home/me/project");
  });

  it("omits the allow button on Cloud homes", () => {
    vi.stubGlobal("window", { ogb: { revealInFolder: vi.fn(), remoteClient: { active: true } } });
    const html = withStore(
      { cloudHome: true },
      createElement(OutsideWorkspaceFile, { filePath: "/home/me/project/NOTES.md" }),
    );
    expect(html).toContain(">/home/me/project/NOTES.md</code>");
    expect(html).not.toContain("Allow files from");
  });
});
