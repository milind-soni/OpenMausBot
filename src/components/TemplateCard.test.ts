// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateCard, TemplateDetails } from "../../shared/share-card";
import type { Message } from "@/state/store";

const dispatch = vi.fn();
const api = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({ ok: true }));
const place: { state: { config?: { team?: { id: string; name: string }; profile?: { name?: string } } }; admin: boolean | null; own: boolean } = { state: {}, admin: null, own: true };
vi.mock("@/state/store", async () => {
  const { createContext } = await import("react");
  return { StoreContext: createContext(null), useStore: () => ({ state: place.state, dispatch }), api: (path: string, init?: RequestInit) => api(path, init) };
});
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => place.admin }));
vi.mock("@/state/store-select", () => ({ useStoreSelector: <T,>(select: (state: never) => T) => select(place.state as never) }));
vi.mock("@/lib/session", () => ({
  readSessionState: async () => ({ kind: "loopback" }),
  profileForSession: (profile: { name?: string } | undefined, session: unknown) => (session && place.own ? profile : undefined),
}));
const openExternalLink = vi.fn(async (_url: string) => {});
vi.mock("@/lib/app-links", () => ({ openExternalLink: (url: string) => openExternalLink(url) }));
const { TemplateChatCard, TemplateDetailsBody } = await import("./TemplateCard");

const draft: TemplateCard = {
  id: "tpl1", scope: "bot", name: "Quill", tagline: "Writes outreach that sounds like you.",
  avatars: [{ key: "quill", name: "Quill", color: "purple" }],
  counts: { bots: 1, skills: 3, routines: 2, apps: 1 }, redacted: 0, skipped: [], status: "draft",
};
const message = (card: TemplateCard): Message => ({ id: "m1", at: 1, role: "bot", kind: "text", text: "fallback", template: card });
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const shown = (card: TemplateCard) => text(renderToStaticMarkup(createElement(TemplateChatCard, { message: message(card), botId: "quill", threadId: "t1" })));

function render(card: TemplateCard) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(TemplateChatCard, { message: message(card), botId: "quill", threadId: "t1" })));
  return { container, unmount: () => { root.unmount(); container.remove(); } };
}
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);

afterEach(() => { vi.clearAllMocks(); delete (window as { ogb?: unknown }).ogb; place.state = {}; place.admin = null; place.own = true; document.body.innerHTML = ""; });

describe("a template's chat card", () => {
  it("shows a draft with its counts, Publish and Details, and says nothing private travels", () => {
    const words = shown(draft);
    expect(words).toContain("Quill");
    expect(words).toContain("Draft");
    expect(words).toContain("3 skills · 2 routines (paused) · 1 app");
    expect(words).toContain("Chats, memory and keys are never shared");
    expect(words).toContain("Publish");
    expect(words).toContain("Details");
    expect(words).not.toContain("Copy link");
  });

  it("counts the bots of a department and says how many items were redacted", () => {
    const words = shown({ ...draft, scope: "department", counts: { bots: 3, skills: 1, routines: 0, apps: 0 }, redacted: 2 });
    expect(words).toContain("3 bots · 1 skill");
    expect(words).not.toContain("routines");
    expect(words).toContain("2 items redacted");
  });

  it("shows Publishing… while it publishes, and Copy link and View on GitHub once published", () => {
    expect(shown({ ...draft, status: "publishing" })).toContain("Publishing…");
    const published = shown({ ...draft, status: "published", link: "https://github.com/milind-soni/openmausbot-teams/tree/abc/teams/quill" });
    expect(published).toContain("Published");
    expect(published).toContain("Copy link");
    expect(published).toContain("View on GitHub");
    expect(published).not.toContain(" Publish ");
  });

  it("shows a failed publish's sentence with Try again", () => {
    const words = shown({ ...draft, status: "failed", error: "Too many submissions today. Try again tomorrow." });
    expect(words).toContain("Couldn't publish");
    expect(words).toContain("Too many submissions today. Try again tomorrow.");
    expect(words).toContain("Try again");
  });

  it("offers Save folder… and Upload on GitHub instead of Publish when publishing can't happen here", () => {
    const signIn = shown({ ...draft, fallback: "sign_in" });
    expect(signIn).toContain("Save folder…");
    expect(signIn).toContain("Upload on GitHub");
    expect(signIn).toContain("Sign in to MausBot to publish");
    expect(signIn).not.toMatch(/\bPublish\b/);
    expect(shown({ ...draft, fallback: "unavailable" })).toContain("Publishing isn't available here");
  });

  it("shows a deleted template without buttons", () => {
    const words = shown({ ...draft, status: "gone" });
    expect(words).toContain("Deleted");
    expect(words).not.toContain("Publish");
    expect(words).not.toContain("Details");
  });

  it("publishes through the server and shows the card it answers", async () => {
    api.mockResolvedValueOnce({ ...draft, status: "published", link: "https://github.com/x/y/tree/abc/teams/quill", prUrl: "https://github.com/x/y/pull/7" });
    const { container, unmount } = render(draft);
    try {
      button(container, "Publish")!.click();
      await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/share/tpl1/publish", { method: "POST", body: JSON.stringify({ author: "" }) }));
      await vi.waitFor(() => expect(container.textContent).toContain("Copy link"));
      button(container, "View on GitHub")!.click();
      expect(openExternalLink).toHaveBeenCalledWith("https://github.com/x/y/tree/abc/teams/quill");
    } finally { unmount(); }
  });

  it("says what was taken out before publishing, in one line", () => {
    expect(shown({ ...draft, scrubbed: { paths: 3, emails: 1, phones: 0, names: 0 } })).toContain("We removed 3 local paths and 1 email before publishing");
    expect(shown({ ...draft, scrubbed: { paths: 1, emails: 0, phones: 2, names: 1 } })).toContain("We removed 1 local path, 2 phone numbers, and 1 mention of your name before publishing");
    expect(shown(draft)).not.toContain("We removed");
  });

  it("refuses to publish a template with a key in it, in one line", () => {
    const { container, unmount } = render({ ...draft, secret: true, status: "failed", error: "This template holds something that looks like a key or token." });
    try {
      expect(button(container, "Try again")!.disabled).toBe(true);
      expect(container.querySelector("[data-template-secret]")!.textContent).toBe("It holds a key or token, so it can't be published. Remove it from the bot, then update the template.");
      expect(container.textContent).not.toContain("This template holds something");
    } finally { unmount(); }
  });

  it("publishes under the name in Published by, which starts as the suggested one and can be changed or cleared", async () => {
    api.mockResolvedValue({ ...draft, status: "published", link: "https://github.com/x/y/tree/abc/teams/quill", publishedBy: "Sam Rivera" });
    const { container, unmount } = render({ ...draft, author: "Sam" });
    try {
      const field = container.querySelector<HTMLInputElement>("[data-template-author]")!;
      expect(field.value).toBe("Sam");
      expect(container.querySelector(`label[for="${field.id}"]`)!.textContent).toBe("Published by");
      expect(field.placeholder).toBe("Community");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      flushSync(() => { setter.call(field, " Sam Rivera "); field.dispatchEvent(new Event("input", { bubbles: true })); });
      button(container, "Publish")!.click();
      await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/share/tpl1/publish", { method: "POST", body: JSON.stringify({ author: "Sam Rivera" }) }));
      await vi.waitFor(() => expect(container.querySelector("[data-template-published-by]")?.textContent).toBe("Published by Sam Rivera"));
      expect(container.querySelector("[data-template-author]")).toBeNull();
    } finally { unmount(); }
  });

  it("starts Published by with the person's own profile name, never someone else's, and a cleared one stays cleared", async () => {
    place.state = { config: { profile: { name: "Sam Rivera" } } };
    const own = render(draft);
    try {
      await vi.waitFor(() => expect(own.container.querySelector<HTMLInputElement>("[data-template-author]")!.value).toBe("Sam Rivera"));
    } finally { own.unmount(); }
    place.own = false;
    const shared = render(draft);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shared.container.querySelector<HTMLInputElement>("[data-template-author]")!.value).toBe("");
    } finally { shared.unmount(); }
    place.own = true;
    const cleared = render({ ...draft, author: "" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(cleared.container.querySelector<HTMLInputElement>("[data-template-author]")!.value).toBe("");
    } finally { cleared.unmount(); }
  });

  it("names nobody on a published card credited to the community", () => {
    expect(shown({ ...draft, status: "published", link: "https://github.com/x/y/tree/a/teams/q", publishedBy: "Community" })).not.toContain("Published by");
    expect(shown({ ...draft, status: "published", link: "https://github.com/x/y/tree/a/teams/q", publishedBy: "MausBot user" })).not.toContain("Published by");
    expect(shown({ ...draft, publishedBy: "Sam" })).not.toContain("Published by Sam");
  });

  it("turns a refused publish into the failed state with the server's sentence", async () => {
    api.mockRejectedValueOnce(new Error("The community service is busy. Try again in a minute."));
    const { container, unmount } = render(draft);
    try {
      button(container, "Publish")!.click();
      await vi.waitFor(() => expect(container.textContent).toContain("The community service is busy. Try again in a minute."));
      expect(container.textContent).toContain("Couldn't publish");
    } finally { unmount(); }
  });

  it("saves the folder where the person picks on the desktop app", async () => {
    (window as { ogb?: unknown }).ogb = { pickFolder: async () => "/Users/sam/Desktop" };
    api.mockResolvedValueOnce({ path: "/Users/sam/Desktop/quill" });
    const { container, unmount } = render({ ...draft, fallback: "sign_in" });
    try {
      button(container, "Save folder…")!.click();
      await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/share/tpl1/save", { method: "POST", body: JSON.stringify({ path: "/Users/sam/Desktop" }) }));
      await vi.waitFor(() => expect(container.textContent).toContain("Saved to /Users/sam/Desktop/quill"));
    } finally { unmount(); }
  });
});

describe("a template's chat card on a Team Cloud", () => {
  const menuItems = async (container: HTMLElement) => {
    container.querySelector<HTMLElement>("[aria-label='More']")!.click();
    await vi.waitFor(() => expect(document.querySelectorAll("[role=menuitem]").length).toBeGreaterThan(0));
    return [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
  };

  it("offers Add to the team's templates and Your GitHub repo… to its owner or an admin", async () => {
    place.state = { config: { team: { id: "t1", name: "Acme" } } };
    place.admin = true;
    api.mockResolvedValueOnce({ template: { slug: "quill", name: "Quill", scope: "bot", tagline: "", addedAt: 1 }, replaced: false });
    const { container, unmount } = render(draft);
    try {
      const items = await menuItems(container);
      expect(items.map((item) => item.textContent?.trim())).toEqual(expect.arrayContaining(["Add to Acme's templates", "Your GitHub repo…"]));
      items.find((item) => item.textContent?.trim() === "Add to Acme's templates")!.click();
      await vi.waitFor(() => expect(container.textContent).toContain("Added to Acme's templates"));
      expect(api).toHaveBeenCalledWith("/api/share/tpl1/library", { method: "POST", body: "{}" });
    } finally { unmount(); }
  });

  it("leaves the team's templates and its repositories out for a member", async () => {
    place.state = { config: { team: { id: "t1", name: "Acme" } } };
    place.admin = false;
    const { container, unmount } = render(draft);
    try {
      const items = (await menuItems(container)).map((item) => item.textContent?.trim());
      expect(items).toContain("Delete");
      expect(items).not.toContain("Your GitHub repo…");
      expect(items).not.toContain("Add to Acme's templates");
    } finally { unmount(); }
  });
});

describe("a template's details", () => {
  const details: TemplateDetails = {
    scope: "department", name: "Sales desk", tagline: "Leads in, replies out.", summary: "A small sales team.",
    bots: [
      { key: "morgan", name: "Morgan", title: "Chief of Staff", color: "teal", skills: [], lead: true, instructions: "Keep the desk moving." },
      { key: "quill", name: "Quill", title: "Writer", color: "purple", skills: ["follow-up"] },
    ],
    skills: [{ name: "follow-up", description: "Write a follow-up." }],
    routines: [{ name: "Morning leads", bot: "Morgan", prompt: "Find five leads." }],
    apps: [{ label: "Gmail", reason: "Used by Quill" }],
    groupChats: [{ name: "Desk", members: ["Morgan", "Quill"] }],
    brief: "We sell to bakeries.",
  };

  it("lists the bots and one closed row per part, with nothing to tick", () => {
    const markup = renderToStaticMarkup(createElement(TemplateDetailsBody, { details }));
    const words = text(markup);
    for (const part of ["Morgan", "Quill", "Instructions", "Skills", "Routines (paused)", "Apps to connect", "Group chats", "Department brief"]) expect(words).toContain(part);
    expect(markup).not.toContain("type=\"checkbox\"");
    expect(markup).not.toContain("role=\"tab\"");
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(6);
  });

  it("shows a picture the folder carries, and the mascot for a bot without one", () => {
    const picture = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const markup = renderToStaticMarkup(createElement(TemplateDetailsBody, { details: { ...details, bots: [{ ...details.bots[0]!, picture }, details.bots[1]!] } }));
    expect(markup.match(/data-template-picture/g)).toHaveLength(1);
    expect(markup).toContain(`src="${picture}"`);
    expect(renderToStaticMarkup(createElement(TemplateDetailsBody, { details: { ...details, bots: [{ ...details.bots[0]!, picture: "https://example.com/x.png" }] } }))).not.toContain("example.com");
  });

  it("leaves out the rows a template has nothing for", () => {
    const words = text(renderToStaticMarkup(createElement(TemplateDetailsBody, { details: { ...details, skills: [], routines: [], apps: [], groupChats: [], brief: undefined } })));
    expect(words).not.toContain("Routines (paused)");
    expect(words).not.toContain("Apps to connect");
    expect(words).toContain("Routines arrive paused");
  });
});
