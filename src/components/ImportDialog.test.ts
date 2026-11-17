// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateCard, TemplateDetails } from "../../shared/share-card";

const dispatch = vi.fn();
const api = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({}));
const place: { state: { config?: { team?: { id: string; name: string } } }; admin: boolean | null } = { state: {}, admin: null };
vi.mock("@/state/store", async () => {
  const { createContext } = await import("react");
  return { StoreContext: createContext(null), useStore: () => ({ state: place.state, dispatch }), api: (path: string, init?: RequestInit) => api(path, init) };
});
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => place.admin }));
const openLink = vi.fn(async (_url: string) => {});
vi.mock("@/lib/app-links", () => ({ openExternalLink: (url: string) => openLink(url) }));
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

afterEach(() => { vi.clearAllMocks(); delete (window as { ogb?: unknown }).ogb; document.body.innerHTML = ""; place.state = {}; place.admin = null; });
const onTeam = () => { place.state = { config: { team: { id: "t1", name: "Acme" } } }; place.admin = true; };

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

  it("lists the team's templates for its admins: name, kind, who added it; opens one and removes one", async () => {
    onTeam();
    const listed = [
      { slug: "quill", name: "Quill", scope: "bot", tagline: "Writes outreach.", addedBy: "Olive", addedAt: Date.now() - 2 * 3_600_000 },
      { slug: "sales-desk", name: "Sales desk", scope: "department", tagline: "", addedAt: Date.now() - 30_000 },
    ];
    api.mockImplementation(async (path: string) => path === "/api/share/library" ? { team: "Acme", templates: listed }
      : path.startsWith("/api/share/library/") ? { ok: true } : { details });
    const view = mount(createElement(ImportDialog, { onClose: vi.fn(), onAdded: vi.fn() }));
    try {
      await vi.waitFor(() => expect(document.body.textContent).toContain("From Acme's templates"));
      const row = document.querySelector("[data-team-template=quill]")!;
      expect(row.textContent).toContain("Quill");
      expect(row.textContent).toContain("Bot");
      expect(row.textContent).toContain("Added by Olive · 2 hr ago");
      expect(document.querySelector("[data-team-template=sales-desk]")!.textContent).toContain("Department");
      document.querySelector<HTMLButtonElement>("[aria-label='Remove Sales desk']")!.click();
      await vi.waitFor(() => expect(document.querySelector("[data-team-template=sales-desk]")).toBeNull());
      expect(api).toHaveBeenCalledWith("/api/share/library/sales-desk", { method: "DELETE" });
      (row.querySelector("button") as HTMLButtonElement).click();
      await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/share/import?preview=1", { method: "POST", body: JSON.stringify({ library: "quill" }) }));
      await vi.waitFor(() => expect(document.body.textContent).toContain("Apps to connect"));
    } finally { view.unmount(); }
  });

  it("shows no team list off a Team Cloud or to someone who isn't its owner or an admin", async () => {
    place.state = { config: { team: { id: "t1", name: "Acme" } } };
    place.admin = false;
    const view = mount(createElement(ImportDialog, { onClose: vi.fn(), onAdded: vi.fn() }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.querySelector("[data-team-templates]")).toBeNull();
      expect(api).not.toHaveBeenCalledWith("/api/share/library", undefined);
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

  it("adds it to the team's templates for an admin, and says when it replaced one", async () => {
    onTeam();
    let replaced = false;
    api.mockImplementation(async (path: string) => {
      if (path === "/api/share/export") return card;
      const answer = { template: { slug: "sales-desk", name: "Sales desk", scope: "department", tagline: "", addedAt: 1 }, replaced };
      replaced = true;
      return answer;
    });
    const view = mount(createElement(ShareDepartmentDialog, { department: "Sales desk", onClose: vi.fn() }));
    try {
      await vi.waitFor(() => expect(button("Add to Acme's templates")).toBeTruthy());
      button("Add to Acme's templates")!.click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Added to Acme's templates"));
      expect(api).toHaveBeenCalledWith("/api/share/tpl2/library", { method: "POST", body: "{}" });
      button("Add to Acme's templates")!.click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Replaced in Acme's templates. The previous one is kept."));
    } finally { view.unmount(); }
  });

  it("publishes to the person's own repository as a pull request, or says to connect GitHub in Apps first", async () => {
    let connected = false;
    api.mockImplementation(async (path: string) => path === "/api/share/export" ? card
      : path === "/api/share/github" ? (connected ? { connected: true } : { connected: false, reason: "not_connected", error: "Connect GitHub in Apps first." })
      : { kind: "pull_request", url: "https://github.com/acme/playbooks/pull/3", link: "https://github.com/acme/playbooks/tree/mausbot-sales-desk-abc123/sales-desk", branch: "mausbot-sales-desk-abc123" });
    const view = mount(createElement(ShareDepartmentDialog, { department: "Sales desk", onClose: vi.fn() }));
    try {
      await vi.waitFor(() => expect(button("Your GitHub repo…")).toBeTruthy());
      expect(button("Add to Acme's templates")).toBeUndefined();
      button("Your GitHub repo…")!.click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Connect GitHub in Apps first."));
      button("Open Apps")!.click();
      expect(dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: true });
      await vi.waitFor(() => expect(document.querySelector("[data-template-repo=tpl2]")).toBeNull());
      connected = true;
      button("Your GitHub repo…")!.click();
      await vi.waitFor(() => expect(document.querySelector("[data-template-repo] form")).toBeTruthy());
      const [repo, folder] = [...document.querySelectorAll<HTMLInputElement>("[data-template-repo] input:not([type=checkbox])")];
      typeInto(repo!, "acme/playbooks");
      typeInto(folder!, "templates");
      await vi.waitFor(() => expect(button("Open pull request")!.disabled).toBe(false));
      button("Open pull request")!.click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Pull request opened from the branch mausbot-sales-desk-abc123."));
      expect(api).toHaveBeenCalledWith("/api/share/tpl2/publish-repo", { method: "POST", body: JSON.stringify({ repo: "acme/playbooks", folder: "templates", direct: false }) });
      [...document.querySelectorAll("button")].find((each) => each.textContent?.includes("View pull request") && each.closest("footer"))!.click();
      expect(openLink).toHaveBeenCalledWith("https://github.com/acme/playbooks/pull/3");
    } finally { view.unmount(); }
  });

  it("shows the server's own sentence when GitHub is refused here, with no Open Apps", async () => {
    api.mockImplementation(async (path: string) => path === "/api/share/export" ? card
      : { connected: false, reason: "refused", error: "Acme's rules turn GitHub off." });
    const view = mount(createElement(ShareDepartmentDialog, { department: "Sales desk", onClose: vi.fn() }));
    try {
      await vi.waitFor(() => expect(button("Your GitHub repo…")).toBeTruthy());
      button("Your GitHub repo…")!.click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Acme's rules turn GitHub off."));
      expect(button("Open Apps")).toBeUndefined();
      expect(document.body.textContent).not.toContain("Connect GitHub in Apps first.");
    } finally { view.unmount(); }
  });

  it("offers no repository or team library to a team member", async () => {
    place.state = { config: { team: { id: "t1", name: "Acme" } } };
    place.admin = false;
    api.mockResolvedValue(card);
    const view = mount(createElement(ShareDepartmentDialog, { department: "Sales desk", onClose: vi.fn() }));
    try {
      await vi.waitFor(() => expect(button("Publish to community")).toBeTruthy());
      expect(button("Your GitHub repo…")).toBeUndefined();
      expect(button("Add to Acme's templates")).toBeUndefined();
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
