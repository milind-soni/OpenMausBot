import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillsLibrarySkillWire } from "../../shared/wire";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, modal: vi.fn(), request: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useMemo: (compute: () => unknown) => compute(),
  useEffect: () => {},
}));
vi.mock("@/hooks/use-modal-dialog", () => ({ useModalDialog: fixture.modal }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { bots: [{ id: "bot", name: "Pepper" }], config: { features: { skillsLibrary: true } } } }) }));
vi.mock("./bot-settings/BotEditorContext", () => ({ useBotEditor: () => ({ request: fixture.request }) }));

import { SkillsSection } from "./SkillsSection";
import { SkillsSection as BotSkillsSection } from "./bot-settings/SkillsSection";
import type { Bot } from "@/state/store";

type Props = { children?: ReactNode; onClick?: () => void; disabled?: boolean; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
}
const skill = (name = "order-audit"): SkillsLibrarySkillWire => ({ name, description: "Audit orders", source: "local-import", enabled: false, tags: [], version: null, importedAt: "2026-10-02T00:00:00Z", warnings: [], assignedBots: [] });
const source = "---\nname: order-audit\ndescription: Audit orders\n---\n\nCheck every line item.";
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
function render(bot = false) {
  fixture.index = 0;
  return nodes(bot ? BotSkillsSection({ bot: { id: "bot" } as Bot }) : SkillsSection());
}
const named = (tree: ReactElement<Props>[], label: string) => tree.find((node) => node.props["aria-label"] === label)!;
const button = (tree: ReactElement<Props>[], text: string) => tree.find((node) => node.type === "button" && node.props.children === text)!;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

beforeEach(() => {
  fixture.values = [[skill()], false, "", "", null, null, "", "", false, "", "bot"];
  fixture.modal.mockClear();
  fixture.request.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => response(options?.method === "PATCH" ? {} : url.endsWith("order-audit") ? { text: source } : { skills: [skill()] })));
});

describe("Skills library review and assignment controls", () => {
  it("shows verified full source and requires explicit approval before enabling", async () => {
    named(render(), "Enable order-audit").props.onClick!();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/skills-library/order-audit");
    const viewer = render().find((node) => typeof node.type === "function" && node.type.name === "SkillSourceDialog")!;
    const dialog = nodes((viewer.type as (props: Props) => ReactNode)(viewer.props));
    expect(dialog.find((node) => node.type === "pre")!.props.children).toBe(source);
    expect(fixture.modal).toHaveBeenCalledOnce();
    expect(button(dialog, "Enable reviewed skill")).toBeDefined();
    button(dialog, "Enable reviewed skill").props.onClick!();
    await flush();
    expect(fetch).toHaveBeenCalledWith("/api/skills-library/order-audit", expect.objectContaining({ method: "PATCH", body: '{"enabled":true}' }));
  });

  it("does not approve missing or integrity-rejected source", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ error: "Skill integrity mismatch" }, false) as Response);
    named(render(), "Enable order-audit").props.onClick!();
    await flush();
    expect(fixture.values[5]).toBeNull();
    expect(fixture.values[2]).toBe("Skill integrity mismatch");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("blocks a simultaneous second assignment and reads current assignments before the next PUT", async () => {
    const rows = [skill("alpha"), skill("beta")];
    fixture.values[0] = rows;
    let unblock!: (value: Response) => void;
    const delayed = new Promise<Response>((resolve) => { unblock = resolve; });
    const writes: string[][] = [];
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      if (options?.method === "PUT") {
        const next = JSON.parse(options.body as string).skills as string[];
        writes.push(next);
        for (const row of rows) row.assignedBots = next.includes(row.name) ? [{ id: "bot", name: "Pepper" }] : [];
      }
      return response({ skills: rows }) as Response;
    }).mockImplementationOnce(() => delayed);
    const buttons = render().filter((node) => node.type === "button" && node.props.children === "Assign");
    buttons[0]!.props.onClick!();
    buttons[1]!.props.onClick!();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(render().filter((node) => node.props.children === "Assign").every((node) => node.props.disabled)).toBe(true);
    unblock(response({ skills: rows }) as Response);
    await flush();
    expect(writes).toEqual([["alpha"]]);
    render().filter((node) => node.type === "button" && node.props.children === "Assign")[1]!.props.onClick!();
    await flush();
    expect(writes).toEqual([["alpha"], ["alpha", "beta"]]);
  });

  it("requires the same source review before enabling a per-bot library skill", async () => {
    // Hook call order: useManagedSkills (shared with the Simple bot panel) owns
    // skills…reviewing (0-8) and the assignment guard ref (9); the section then
    // owns viewing, source, importing and importMessage (10-13).
    fixture.values = [[{ ...skill(), origin: "library" }], ["order-audit"], [], "", [], false, "", "", null, { current: false }, null, "", false, ""];
    fixture.request.mockImplementation(async (_url, options) => options?.method ? {} : { text: source });
    named(render(true), "Enable order-audit").props.onClick!();
    await flush();
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(fixture.request).toHaveBeenCalledWith("/api/skills-library/order-audit");
    // The review step is the shared SkillReviewDialog, given the fetched source.
    const review = render(true).find((node) => typeof node.type === "function" && node.type.name === "SkillReviewDialog")!;
    expect(review.props.text).toBe(source);
    (review.props.onEnable as () => void)();
    await flush();
    expect(fixture.request).toHaveBeenCalledWith("/api/skills-library/order-audit", expect.objectContaining({ method: "PATCH", body: '{"enabled":true}' }));
  });
});
