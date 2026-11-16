// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateCard, TemplateDetails } from "../../shared/share-card";

const dispatch = vi.fn();
const api = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({}));
vi.mock("@/state/store", async () => {
  const { createContext } = await import("react");
  return { StoreContext: createContext(null), useStore: () => ({ state: {}, dispatch }), api: (path: string, init?: RequestInit) => api(path, init) };
});
vi.mock("@/lib/app-links", () => ({ openExternalLink: async () => {} }));
const { ImportDialog } = await import("./ImportDialog");
const { ShareDepartmentDialog } = await import("./ShareDepartmentDialog");

const details: TemplateDetails = {
  scope: "bot", name: "Quill", tagline: "Writes outreach.", bots: [{ key: "quill", name: "Quill", color: "purple", skills: [] }],
  skills: [], routines: [], apps: [{ label: "Gmail" }], groupChats: [],
};
const LINK = "https://github.com/milind-soni/openmausbot-teams/tree/abc123/teams/quill";

function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(element));
  return { unmount: () => { root.unmount(); container.remove(); } };
}
const button = (label: string) => [...document.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
const typeInto = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

afterEach(() => { vi.clearAllMocks(); delete (window as { ogb?: unknown }).ogb; document.body.innerHTML = ""; });

describe("Import", () => {
  it("previews a pasted GitHub link, then adds it and says how many apps to connect", async () => {
    api.mockImplementation(async (path: string) => path.endsWith("?preview=1")
      ? { details }
      : { name: "Quill", section: "", bots: [{ id: "b1", name: "Quill" }], appsToConnect: 1 });
    const onAdded = vi.fn();
    const view = mount(createElement(ImportDialog, { onClose: vi.fn(), onAdded }));
    try {
      expect(document.body.textContent).toContain("Paste a GitHub link");
      expect(document.body.textContent).toContain("Choose folder…");
      typeInto(document.querySelector<HTMLInputElement>("[data-import-form] input:not([type=file])")!, LINK);
      await vi.waitFor(() => expect(button("Open")!.disabled).toBe(false));
      button("Open")!.click();
      await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/share/import?preview=1", { method: "POST", body: JSON.stringify({ url: LINK }) }));
      await vi.waitFor(() => expect(document.body.textContent).toContain("Apps to connect"));
      button("Add")!.click();
      await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/share/import", { method: "POST", body: JSON.stringify({ url: LINK }) }));
      await vi.waitFor(() => expect(onAdded).toHaveBeenCalledWith("Added · 1 app to connect"));
      expect(dispatch).toHaveBeenCalledWith({ type: "botAdded", bot: { id: "b1", name: "Quill" } });
      expect(dispatch).toHaveBeenCalledWith({ type: "select", id: "b1" });
    } finally { view.unmount(); }
  });

  it("opens the deep link's address at once and shows the server's sentence when it can't be read", async () => {
    api.mockRejectedValue(new Error("That GitHub folder has no bot.md or team.md."));
    const view = mount(createElement(ImportDialog, { initialUrl: LINK, onClose: vi.fn(), onAdded: vi.fn() }));
    try {
      await vi.waitFor(() => expect(document.body.textContent).toContain("That GitHub folder has no bot.md or team.md."));
      expect(api).toHaveBeenCalledWith("/api/share/import?preview=1", { method: "POST", body: JSON.stringify({ url: LINK }) });
    } finally { view.unmount(); }
  });

  it("reads a folder the desktop app picks by its path", async () => {
    (window as { ogb?: unknown }).ogb = { pickFolder: async () => "/Users/sam/quill" };
    api.mockResolvedValue({ details });
    const view = mount(createElement(ImportDialog, { onClose: vi.fn(), onAdded: vi.fn() }));
    try {
      button("Choose folder…")!.click();
      await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/share/import?preview=1", { method: "POST", body: JSON.stringify({ path: "/Users/sam/quill" }) }));
    } finally { view.unmount(); }
  });
});

describe("a department's Share", () => {
  const card: TemplateCard = {
    id: "tpl2", scope: "department", name: "Sales desk", tagline: "Leads in, replies out.",
    avatars: [{ key: "morgan", name: "Morgan", color: "teal" }, { key: "quill", name: "Quill", color: "purple" }],
    counts: { bots: 2, skills: 1, routines: 1, apps: 0 }, redacted: 0, skipped: [], status: "draft",
  };

  it("makes the template at once and publishes it to the community, then shows the link and the pull request", async () => {
    api.mockImplementation(async (path: string) => path === "/api/share/export" ? card
      : { ...card, status: "published", link: LINK, prUrl: "https://github.com/milind-soni/openmausbot-teams/pull/9" });
    const view = mount(createElement(ShareDepartmentDialog, { department: "Sales desk", onClose: vi.fn() }));
    try {
      await vi.waitFor(() => expect(document.body.textContent).toContain("2 bots · 1 skill · 1 routine (paused)"));
      expect(api).toHaveBeenCalledWith("/api/share/export", { method: "POST", body: JSON.stringify({ department: "Sales desk" }) });
      expect(document.body.textContent).toContain("Publishing makes it public on GitHub.");
      expect(document.querySelector("input[type=checkbox]")).toBeNull();
      button("Publish to community")!.click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("View pull request"));
      expect(document.body.textContent).toContain("Copy link");
    } finally { view.unmount(); }
  });

  it("says why it couldn't be made, with Try again", async () => {
    api.mockRejectedValueOnce(new Error("This department has no bots to share.")).mockResolvedValueOnce(card);
    const view = mount(createElement(ShareDepartmentDialog, { department: "Empty", onClose: vi.fn() }));
    try {
      await vi.waitFor(() => expect(document.body.textContent).toContain("This department has no bots to share."));
      button("Try again")!.click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Publish to community"));
    } finally { view.unmount(); }
  });
});
