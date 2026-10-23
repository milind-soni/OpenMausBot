import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatTime, initialState, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));
// Advanced mode's rows: Simple mode keeps one conversation per bot, so its rows have no thread controls.
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
}));

import { ConfirmDialogCard } from "./ConfirmDialog";
import { BotDeleteMenuItem } from "./BotMenuDelete";
import { BotListItem, botConfirmCopy, botRowProps, currentArchivableBot } from "./Sidebar";
import { endCall } from "@/lib/call";
import { configureLiveMedia, resetLiveMedia, startLiveCall } from "@/lib/live-call-media";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "atlas",
  threadId: "thread-atlas",
  name: "Atlas",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
  ...overrides,
});

function renderRow(candidate: Bot, quiet = false, density: "comfortable" | "icons" = "comfortable") {
  return renderToStaticMarkup(createElement(BotListItem, botRowProps(initialState, vi.fn(), candidate, { density, quiet, query: "", onMenu: vi.fn() })));
}

afterEach(() => {
  resetLiveMedia();
  endCall();
  vi.unstubAllGlobals();
});

describe("BotListItem", () => {
  it("makes a bot waiting for you louder than a preview", () => {
    const opening = (markup: string, testId: string) => {
      const tag = markup.match(new RegExp(`<span[^>]*data-testid="${testId}"[^>]*>`))?.[0];
      expect(tag, testId).toBeTruthy();
      return tag ?? "";
    };
    const waiting = renderRow(bot({ activity: "waiting-on-you" }));
    const badge = opening(waiting, "waiting-dot");
    expect(badge).toContain('role="status"');
    expect(badge).toContain('aria-label="Waiting for you…"');
    expect(badge).toContain('title="Waiting for you…"');
    expect(badge).toContain("size-4");
    expect(badge).toContain("bg-warning");
    expect(badge).toContain("border-2");
    expect(badge).toContain("border-panel");
    expect(badge).not.toContain("size-2.5");
    expect(badge).not.toContain("size-3");
    expect(waiting).toContain('aria-hidden="true">!</span>');
    expect(waiting).toContain('class="flex min-w-0 items-center gap-1.5 truncate text-[13px] leading-[18px] font-semibold text-warning"');
    expect(waiting).toContain('class="truncate">Waiting for you…</span>');

    const icons = opening(renderRow(bot({ activity: "waiting-on-you" }), false, "icons"), "waiting-dot");
    expect(icons).toContain("size-5");
    expect(icons).toContain("bg-warning");
    expect(icons).not.toContain("size-4");
    expect(icons).not.toContain("size-2.5");

    const teammate = renderRow(bot({ waitingForTeammates: true }));
    const teammateDot = opening(teammate, "teammate-wait-dot");
    expect(teammateDot).toContain("size-2.5");
    expect(teammateDot).not.toContain("size-4");
    expect(teammate).toContain('class="truncate">Waiting on a teammate…</span>');
    expect(teammate).toContain("truncate text-[13px] leading-[18px] text-ink-secondary");
    expect(teammate).not.toContain("font-semibold text-warning");

    const working = renderRow(bot({ busy: true }));
    expect(opening(working, "working-dot")).toContain("size-2.5");
    expect(working).not.toContain("waiting-dot");
    expect(working).not.toContain("font-semibold text-warning");

    const preview = renderRow(bot({
      messages: [{ id: "b1", role: "bot", kind: "text", text: "Created notes.txt", at: 2 }] as Bot["messages"],
    }));
    expect(preview).toContain('class="truncate">Created notes.txt</span>');
    expect(preview).toContain("truncate text-[13px] leading-[18px] text-ink-secondary");
    expect(preview).not.toContain("text-warning");
    expect(preview).not.toContain("waiting-dot");
  });

  it("offers direct New thread and New folder icons and a keyboard-accessible bot menu", () => {
    const markup = renderRow(bot());
    expect(markup).toContain('aria-label="New thread"');
    expect(markup).toContain('aria-label="New folder under Atlas"');
    expect(markup).toContain('aria-label="Actions for Atlas"');
    expect(markup).toContain('aria-haspopup="menu"');
  });
  const twoThreads = (): Partial<Bot> => ({
    tasks: [{ threadId: "thread-atlas", title: "Current", createdAt: 2 }, { threadId: "thread-earlier", title: "Earlier", createdAt: 1 }],
  });

  it("shows the thread toggle only once there is a list to open", () => {
    expect(renderRow(bot())).not.toContain("Expand Atlas threads");
    expect(renderRow(bot())).not.toContain('data-sidebar-thread-row=');
    expect(renderRow(bot(twoThreads()))).toContain("Expand Atlas threads");
    expect(renderRow(bot({ projects: [{ id: "p1", name: "Research" }] }))).toContain("Expand Atlas threads");
  });

  it("keeps the native thread toggle beside, not inside, the selectable bot row", () => {
    const markup = renderRow(bot(twoThreads()));
    expect(markup).toContain('role="button" tabindex="0"');
    expect(markup).toContain('</div><button type="button" aria-label="Expand Atlas threads" aria-expanded="false"');
    const toggle = markup.match(/<button[^>]*aria-label="Expand Atlas threads"[^>]*>/)?.[0];
    expect(toggle).toContain("focus-visible:ring-1");
    expect(toggle).not.toContain("hover:bg-");
  });

  it("previews the last reply, not the digest receipt that follows it", () => {
    const markup = renderRow(bot({
      messages: [
        { id: "u1", role: "user", kind: "text", text: "make notes.txt", at: 1 },
        { id: "b1", role: "bot", kind: "text", text: "Created notes.txt with three lines.", at: 2 },
        { id: "d1", role: "bot", kind: "digest", text: "[digest] · tools: Write ×1", at: 3, digest: { turnId: "t1", tools: [{ name: "Write", count: 1 }], hookCoverage: "full" } },
      ] as Bot["messages"],
    }));
    expect(markup).toContain("Created notes.txt with three lines.");
    expect(markup).not.toContain("[digest]");
  });

  describe("the record of a live call that ended last", () => {
    const at = (minute: number) => new Date(2026, 9, 6, 10, minute).getTime();
    const record = {
      id: "r1", role: "bot", kind: "call", at: at(2), text: "Call with Atlas · 1:42",
      call: { callId: "c1", botId: "atlas", client: "ios", startedAt: at(0), endedAt: at(2), seconds: 102, endReason: "hung-up" },
    };
    const spoken = { id: "u1", role: "user", kind: "text", text: "what is the weather", at: at(0), via: "call", callId: "c1" };
    const draw = (candidate: Bot, { selected = false, query = "" } = {}) => renderToStaticMarkup(createElement(BotListItem, botRowProps(
      selected ? { ...initialState, activeView: "chat", selectedId: candidate.id } : initialState,
      vi.fn(), candidate, { density: "comfortable", quiet: false, query, onMenu: vi.fn() },
    )));

    it("previews the last reply, not the record that follows it", () => {
      const markup = draw(bot({
        messages: [spoken, { id: "b1", role: "bot", kind: "text", text: "Sunny in Pune.", at: at(1) }, record] as Bot["messages"],
      }));
      expect(markup).toContain("Sunny in Pune.");
      expect(markup).not.toContain("Call with Atlas");
    });

    it("previews a failed turn's row when the record follows it", () => {
      const markup = draw(bot({
        messages: [spoken, { id: "e1", role: "bot", kind: "activity", at: at(1), tool: { name: "error: This computer isn't a place on your OMB Cloud: its bots run in the cloud.", ok: false } }, record] as Bot["messages"],
      }));
      expect(markup).toContain("This computer isn&#x27;t a place on your OMB Cloud: its bots run in the cloud.");
      expect(markup).not.toContain("Call with Atlas");
    });

    it("times the open row by the last reply, not by the hang-up", () => {
      const markup = draw(bot({
        messages: [spoken, { id: "b1", role: "bot", kind: "text", text: "Sunny in Pune.", at: at(1) }, record] as Bot["messages"],
      }), { selected: true });
      expect(markup).toContain(formatTime(at(1)));
      expect(markup).not.toContain(formatTime(at(2)));
    });

    it("names the step the bot is on while it works, when the call ended under it", () => {
      const markup = draw(bot({
        busy: true,
        tasks: [{ threadId: "thread-atlas", title: "Current", createdAt: 2, busy: true, activity: "working" }, { threadId: "thread-earlier", title: "Earlier", createdAt: 1 }],
        messages: [
          { ...spoken, text: "run the tests" },
          { id: "a1", role: "bot", kind: "activity", at: at(1), requestMessageId: "u1", tool: { name: "Bash", spoken: "running the tests" } },
          record,
        ] as Bot["messages"],
      }), { query: "current" });
      expect(markup).toContain("Running the tests");
    });
  });

  it("previews a failed turn without its error marker", () => {
    const markup = renderRow(bot({
      messages: [
        { id: "u1", role: "user", kind: "text", text: "check the site", at: 1 },
        { id: "e1", role: "bot", kind: "activity", at: 2, tool: { name: "error: This computer isn't a place on your OMB Cloud: its bots run in the cloud.", ok: false } },
      ] as Bot["messages"],
    }));
    expect(markup).toContain("This computer isn&#x27;t a place on your OMB Cloud: its bots run in the cloud.");
    expect(markup).not.toContain("error:");
  });

  describe("an approval card that ends the chat", () => {
    const approval = (card: Partial<NonNullable<Bot["messages"][number]["card"]>>): Bot => bot({
      messages: [
        { id: "u1", role: "user", kind: "text", text: "list the files", at: 1 },
        {
          id: "c1", role: "bot", kind: "options", at: 2,
          card: { title: "Approval needed", subtitle: "ls -la", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", ...card },
        },
      ] as Bot["messages"],
    });

    it("keeps the request's title while it is still open", () => {
      expect(renderRow(approval({}))).toContain("Approval needed");
    });

    it("says Allowed once it was allowed", () => {
      const markup = renderRow(approval({ answered: "allow" }));
      expect(markup).toContain("Allowed");
      expect(markup).not.toContain("Approval needed");
    });

    it("says Denied once it was denied, or closed by Stop", () => {
      for (const answered of ["deny", "unavailable"]) {
        const markup = renderRow(approval({ answered, dismissed: answered === "unavailable" }));
        expect(markup).toContain("Denied");
        expect(markup).not.toContain("Approval needed");
      }
    });

    it("says Expired once nothing can answer it", () => {
      const markup = renderRow(approval({ expired: true, options: [] }));
      expect(markup).toContain("Expired");
      expect(markup).not.toContain("Approval needed");
    });
  });

  it("leaves the full Chief card as one selectable hit area", () => {
    const markup = renderRow(bot({ chiefOfStaff: true }));

    expect(markup).toContain('data-sidebar-bot-row="atlas"');
    expect(markup).not.toContain('aria-label="Archive Atlas"');
  });

  it("marks the Chief of Staff with one crown after the name, not a line of its own", () => {
    const markup = renderRow(bot({ chiefOfStaff: true, title: "Developer" }));
    expect(markup).toContain('data-testid="chief-crown"');
    expect(markup).toContain('aria-label="Chief of Staff"');
    expect(markup.indexOf('data-testid="chief-crown"')).toBeGreaterThan(markup.indexOf(">Atlas<"));
    expect(markup.indexOf('data-testid="bot-role"')).toBeGreaterThan(markup.indexOf('data-testid="chief-crown"'));
    expect(markup).not.toContain("Chief of Staff</span>");
    expect(markup).toContain('title="Atlas · Developer · Chief of Staff"');

    expect(renderRow(bot())).not.toContain("Chief of Staff");
  });

  it("keeps the title in an icons-only row's name and tooltip", () => {
    const icons = renderRow(bot({ chiefOfStaff: true, title: "  Developer " }), false, "icons");
    expect(icons).toContain('aria-label="Atlas · Developer · Chief of Staff"');
    expect(icons).toContain('title="Atlas · Developer"');
    const untitled = renderRow(bot(), false, "icons");
    expect(untitled).toContain('aria-label="Atlas"');
    expect(untitled).toContain('title="Atlas"');
  });

  const titleLine = /<div class="truncate text-\[11px\][^"]*">([^<]*)<\/div>/;
  const roleOf = (markup: string) => /<span data-testid="bot-role"[^>]*><span title="([^"]*)" class="([^"]*)"><span class="sr-only">, <\/span>([^<]*)<\/span>/.exec(markup);

  it("shows the bot's role beside its name as one muted, truncated line, read out after the name", () => {
    const markup = renderRow(bot({ title: "  Developer ", messages: [{ id: "b1", role: "bot", kind: "text", text: "All set.", at: 1 }] as Bot["messages"] }));
    const role = roleOf(markup);
    expect(role?.[1]).toBe("Developer");
    expect(role?.[3]).toBe("Developer");
    expect(role?.[2].split(" ")).toEqual(expect.arrayContaining(["truncate", "text-[13px]", "font-normal", "text-ink-secondary"]));
    expect(markup.indexOf('data-testid="bot-role"')).toBeGreaterThan(markup.indexOf(">Atlas<"));
    expect(markup.indexOf('data-testid="bot-role"')).toBeLessThan(markup.indexOf(">All set.<"));
    expect(titleLine.test(markup)).toBe(false);
    expect(markup).toContain('title="Atlas · Developer"');
    expect(markup).toContain('title="Double-click to rename"');
  });

  it("gives way to the name: the role takes only the room left and steps aside below a word's width", () => {
    const wrapper = /<span data-testid="bot-role" class="([^"]*)"/.exec(renderRow(bot({ title: "Developer" })))?.[1].split(" ");
    expect(wrapper).toEqual(expect.arrayContaining(["@container", "min-w-0", "grow"]));
    expect(roleOf(renderRow(bot({ title: "Developer" })))?.[2]).toContain("@max-[3rem]:sr-only");
  });

  it("draws no role for a bot without one", () => {
    for (const title of ["", "  "]) {
      const markup = renderRow(bot({ title }));
      expect(markup).not.toContain('data-testid="bot-role"');
      expect(markup).not.toContain('class="sr-only">, ');
    }
  });

  it("gives the Chief of Staff the same row as every other bot", () => {
    const portrait = (markup: string) => /width="(\d+)px" height="\d+px"/.exec(markup)?.[1];
    const rowClass = (markup: string) => /data-sidebar-bot-row="atlas" class="([^"]*)"/.exec(markup)?.[1];
    const chief = renderRow(bot({ chiefOfStaff: true, title: "Chief of staff" }));
    const plain = renderRow(bot({ title: "Developer" }));
    expect(portrait(chief)).toBe(portrait(plain));
    expect(rowClass(chief)).toBe(rowClass(plain));
  });

  it("reads the name at 15px semibold and the preview at 13px", () => {
    const markup = renderRow(bot({ messages: [{ id: "b1", role: "bot", kind: "text", text: "All set.", at: 1 }] as Bot["messages"] }));
    expect(markup).toMatch(/class="[^"]*text-\[15px\] font-semibold[^"]*"/);
    expect(markup).toMatch(/class="[^"]*truncate text-\[13px\][^"]*text-ink-secondary[^"]*"/);
  });

  it("previews the last reply as plain text, without its markdown", () => {
    const markup = renderRow(bot({
      messages: [{ id: "b1", role: "bot", kind: "text", text: "I read **[Prudctual/OpenMausBot](https://github.com/Prudctual/OpenMausBot)**. Run `pnpm install` first.", at: 1 }] as Bot["messages"],
    }));
    expect(markup).toContain(">I read Prudctual/OpenMausBot. Run pnpm install first.<");
    expect(markup).not.toContain("**");
    expect(markup).not.toContain("](https://");
  });

  it("shows typing dots instead of preview text while the bot works", () => {
    const markup = renderRow(bot({ busy: true }));

    expect(markup).toContain("animate-status-pulse");
    expect(markup).toContain('class="sr-only">Working…');
  });

  it("marks the avatar with a green presence dot only while the bot works", () => {
    expect(renderRow(bot({ busy: true }))).toContain('data-testid="working-dot"');
    expect(renderRow(bot())).not.toContain('data-testid="working-dot"');
    expect(renderRow(bot({ busy: true, activity: "waiting-on-you" }))).not.toContain('data-testid="working-dot"');
  });

  it("marks the bot this window is on a Live call with by a green phone badge", () => {
    expect(renderRow(bot())).not.toContain('data-testid="live-call-badge"');

    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
    void startLiveCall({ botId: "atlas", threadId: "thread-atlas" });

    const markup = renderRow(bot());
    expect(markup).toContain('data-testid="live-call-badge"');
    expect(markup).toContain('aria-label="On a Live call"');
    expect(markup.indexOf('data-testid="live-call-badge"')).toBeGreaterThan(markup.indexOf(">Atlas<"));
    expect(renderRow(bot({ id: "other" }))).not.toContain('data-testid="live-call-badge"');
    expect(renderRow(bot(), true)).toContain('data-testid="live-call-badge"');

    const icons = renderRow(bot(), false, "icons");
    expect(icons).toContain('data-testid="live-call-badge"');
    expect(icons).toContain('aria-label="Atlas · On a Live call"');
  });

  it("marks an idle bot waiting on a teammate with a quiet dot, never the work signals", () => {
    const markup = renderRow(bot({ waitingForTeammates: true, busy: false, activity: "idle" }));
    expect(markup).toContain('data-testid="teammate-wait-dot"');
    expect(markup).not.toContain('data-testid="working-dot"');
    expect(markup).not.toContain("animate-status-pulse");
    expect(markup).toContain("Waiting on a teammate…");
  });

  it("keeps real sibling work visible while another thread waits for a teammate", () => {
    const markup = renderRow(bot({ waitingForTeammates: true, busy: true, activity: "working" }));
    expect(markup).toContain('data-testid="working-dot"');
    expect(markup).not.toContain('data-testid="teammate-wait-dot"');
  });

  it("keeps Archive in the Actions menu and reveals quiet row controls on focus as well as hover", () => {
    const markup = renderRow(bot());
    expect(markup).not.toContain('aria-label="Archive Atlas"');
    expect(markup).toContain('aria-label="Actions for Atlas"');
    expect(markup).toContain("group-focus-within:opacity-100");
    expect(markup).toContain("group-hover:pointer-events-auto");
    expect(markup).not.toContain("pr-[92px]");
  });
});

describe("archive / delete confirmation", () => {
  it("rechecks the latest fleet after a confirmation was opened", () => {
    const snapshot = bot();
    const other = bot({ id: "other" });
    const renamed = bot({ name: "New name" });
    expect(currentArchivableBot([renamed, other], snapshot.id)).toBe(renamed);
    expect(currentArchivableBot([bot({ chiefOfStaff: true }), other], snapshot.id)).toBeUndefined();
    expect(currentArchivableBot([bot({ hidden: true }), other], snapshot.id)).toBeUndefined();
    expect(currentArchivableBot([snapshot], snapshot.id)).toBeUndefined();
    expect(currentArchivableBot([other, bot({ id: "third" })], snapshot.id)).toBeUndefined();
  });
  it("archive copy names the bot and says it can be restored", () => {
    const copy = botConfirmCopy("archive", "Juniper");

    expect(copy.title).toContain("Juniper");
    expect(copy.body).toMatch(/restore/i);
    expect(copy.tone).toBe("neutral");
  });

  it("delete copy names the bot and warns about its owned computer", () => {
    const copy = botConfirmCopy("delete", "Willow");

    expect(copy.title).toContain("Willow");
    expect(copy.body).toMatch(/permanently/i);
    expect(copy.body).toMatch(/any desktop it owns/i);
    expect(copy.body).toMatch(/files and browser sign-ins/i);
    expect(copy.body).toMatch(/shared department desktops stay/i);
    expect(copy.tone).toBe("danger");
  });

  it("renders as an alert dialog with Cancel and the action button", () => {
    const markup = renderToStaticMarkup(createElement(ConfirmDialogCard, {
      open: true,
      ...botConfirmCopy("delete", "Willow"),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("Delete Willow?");
    expect(markup).toContain(">Cancel</button>");
    expect(markup).toContain(">Delete</button>");
    expect(markup).toContain("bg-danger");
  });
});

describe("bot deletion feedback", () => {
  it("disables the destructive action while the bot and its computer are deleted", () => {
    const markup = renderToStaticMarkup(createElement(BotDeleteMenuItem, {
      deleting: true,
      onClick: vi.fn(),
    }));

    expect(markup).toContain("Deleting the bot and its desktop…");
    expect(markup).toContain('title="Deleting this bot and any desktop it owns"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
  });

  it("offers Delete again after the check settles", () => {
    const markup = renderToStaticMarkup(createElement(BotDeleteMenuItem, {
      deleting: false,
      onClick: vi.fn(),
    }));

    expect(markup).toContain(">Delete</button>");
    expect(markup).not.toContain('disabled=""');
  });

  describe("quiet rows", () => {
    const titleLine = /<div class="truncate text-\[11px\][^"]*">([^<]*)<\/div>/;

    it("reduces an idle bot to one line, its name and role: no title line, no Chief line, no preview", () => {
      const markup = renderRow(bot({
        title: "Developer",
        chiefOfStaff: true,
        messages: [{ id: "b1", role: "bot", kind: "text", text: "Created notes.txt with three lines.", at: 2 }] as Bot["messages"],
      }), true);
      expect(titleLine.test(markup)).toBe(false);
      expect(markup).not.toContain("Chief of Staff</span>");
      expect(markup).not.toContain("Created notes.txt with three lines.");
      expect(markup).toContain(">Atlas<");
      expect(markup).toContain('<span class="sr-only">, </span>Developer</span>');
      expect(markup).toContain('data-testid="chief-crown"');
      expect(markup).toContain('aria-label="Chief of Staff"');
    });

    it("keeps the status line while something is happening", () => {
      expect(renderRow(bot({ busy: true }), true)).toContain('class="sr-only">Working…');
      expect(renderRow(bot({ activity: "waiting-on-you" }), true)).toContain("Waiting for you…");
      expect(renderRow(bot({ waitingForTeammates: true, busy: false }), true)).toContain("Waiting on a teammate…");
    });

    it("keeps the unread dot in the name line when the preview line is gone", () => {
      const markup = renderRow(bot({ unread: true, messages: [{ id: "b1", role: "bot", kind: "text", text: "hello", at: 1 }] as Bot["messages"] }), true);
      expect(markup).toContain('aria-label="Unread threads"');
      expect(markup).not.toContain(">hello<");
    });

    it("puts the crown right after the name, inside the name line", () => {
      const markup = renderRow(bot({ chiefOfStaff: true }), true);
      expect(markup.indexOf('data-testid="chief-crown"')).toBeGreaterThan(markup.indexOf(">Atlas<"));
    });

    it("draws the same crown as a full row", () => {
      const quiet = renderRow(bot({ title: "Developer", chiefOfStaff: true }), true);
      const full = renderRow(bot({ title: "Developer", chiefOfStaff: true }));
      for (const markup of [quiet, full]) {
        expect(markup.match(/data-testid="chief-crown"/g)).toHaveLength(1);
        expect(markup).not.toContain("Chief of Staff</span>");
      }
    });
  });
});
