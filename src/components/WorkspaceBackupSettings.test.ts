import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBackupSummary } from "../../shared/workspace-backup";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], api: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next; }];
  },
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ api: fixture.api }));
import { WorkspaceBackupRecovery, WorkspaceBackupSettings, WorkspaceBackupSummaryView } from "./WorkspaceBackupSettings";

type Node = ReactElement<{ children?: ReactNode; type?: string; disabled?: boolean; value?: string; onChange?: (event: unknown) => void; onSubmit?: (event: unknown) => void; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function render(recovery = false) {
  fixture.index = 0; fixture.effects = [];
  let tree: ReactNode;
  function Capture() { tree = recovery ? WorkspaceBackupRecovery({ children: createElement("p", null, "Normal app") }) : WorkspaceBackupSettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const submit = (form: Node) => form.props.onSubmit!({ preventDefault: vi.fn() });
const change = (input: Node, value: string) => input.props.onChange!({ target: { value } });
const summary: WorkspaceBackupSummary = { format: "openmaus.workspace-backup", version: 1, id: "archive-id", createdAt: "2026-09-11T00:00:00Z", appVersion: "0.1.71", files: 9, directories: 3, bytes: 1234, bots: 2, groups: 1, threads: 4, messages: 8, includesCredentials: true, warnings: ["Fixture warning"], exclusions: ["External CLI sign-ins"] };
let storage: Map<string, string>;
beforeEach(() => {
  fixture.values = []; fixture.index = 0; fixture.effects = []; fixture.api.mockReset();
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("window", { location: { reload: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());
async function ready() { fixture.api.mockResolvedValueOnce({ busy: false }); render(); fixture.effects[0](); await flush(); }

describe("Settings full backups", () => {
  it("shows a native file input, password fields and validated summary with warnings", () => {
    const html = render().html;
    expect(html).toContain('type="file" accept=".ombbackup"');
    expect(html.match(/type="password"/g)).toHaveLength(3);
    expect(html).toContain("remote VM disks");
    expect(html).not.toContain("Replace workspace");
    const preview = renderToStaticMarkup(createElement(WorkspaceBackupSummaryView, { summary }));
    for (const text of ["Validated backup", "0.1.71", "Bots", "Threads", "Messages", "Fixture warning", "External CLI sign-ins"]) expect(preview).toContain(text);
  });

  it("exports encrypted state by POST and downloads without putting the password in a URL or storage", async () => {
    await ready();
    storage.set("omb-drafts", "private draft"); storage.set("auth-token", "not exported");
    let view = render();
    const passwords = view.nodes.filter((node) => node.type === "input" && node.props.type === "password");
    change(passwords[0], "correct horse battery"); change(passwords[1], "correct horse battery");
    view = render();
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: () => link, body: { append: vi.fn() } });
    fixture.api.mockResolvedValueOnce({ id: "download-id", filename: "fixture.ombbackup" });
    const form = view.nodes.find((node) => node.type === "form")!;
    submit(form); submit(form); await flush();
    expect(fixture.api).toHaveBeenCalledTimes(2); // one status, one export
    const [path, init] = fixture.api.mock.calls[1];
    expect(path).toBe("/api/workspace-backup/export");
    expect(JSON.parse(init.body)).toEqual({ password: "correct horse battery", clientState: { "omb-drafts": "private draft" } });
    expect(link.href).toBe("/api/workspace-backup/download/download-id");
    expect(link.click).toHaveBeenCalledOnce();
    expect([...storage.values()]).not.toContain("correct horse battery");
    expect(render().html).not.toContain('value="correct horse battery"');
  });

  it("uploads a raw file, validates it, and requires exact REPLACE with the staged ID", async () => {
    await ready();
    const file = new File(["encrypted fixture"], "fixture.ombbackup");
    render().nodes.find((node) => node.props.type === "file")!.props.onChange!({ target: { files: [file] } });
    let view = render();
    change(view.nodes.filter((node) => node.props.type === "password")[2], "correct horse battery");
    fixture.api.mockResolvedValueOnce({ id: "upload-id" }).mockResolvedValueOnce({ id: "stage-id", summary });
    submit(render().nodes.filter((node) => node.type === "form")[1]); await flush();
    expect(fixture.api.mock.calls[1]).toEqual(["/api/workspace-backup/upload", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file }]);
    expect(JSON.parse(fixture.api.mock.calls[2][1].body)).toEqual({ id: "upload-id", password: "correct horse battery" });
    view = render();
    const replace = () => render().nodes.find((node) => node.type === "button" && node.props.children === "Replace workspace")!;
    expect(replace().props.disabled).toBe(true);
    const confirm = view.nodes.filter((node) => node.type === "input" && !node.props.type)[0];
    change(confirm, "replace"); expect(replace().props.disabled).toBe(true);
    change(confirm, "REPLACE"); expect(replace().props.disabled).toBe(false);
    fixture.api.mockResolvedValueOnce({ restartRequired: true, restoreId: "stage-id" });
    replace().props.onClick!(); await flush();
    expect(JSON.parse(fixture.api.mock.calls[3][1].body)).toEqual({ id: "stage-id", confirmation: "REPLACE" });
    expect(storage.get("omb-pending-workspace-restore")).toBe("stage-id");
    expect(render().html).toContain("Fully quit OpenMausBot");
  });

  it("does not offer a replacement after failed password validation", async () => {
    await ready();
    render().nodes.find((node) => node.props.type === "file")!.props.onChange!({ target: { files: [new File(["archive"], "file.ombbackup")] } });
    change(render().nodes.filter((node) => node.props.type === "password")[2], "wrong password");
    fixture.api.mockResolvedValueOnce({ id: "upload" }).mockRejectedValueOnce(new Error("Wrong password"));
    submit(render().nodes.filter((node) => node.type === "form")[1]); await flush();
    const html = render().html;
    expect(html).toContain('role="alert"'); expect(html).toContain("Wrong password"); expect(html).not.toContain("Replace workspace");
  });

  it("reuploads the selected file if its upload or validated stage expires", async () => {
    await ready();
    const file = new File(["archive"], "file.ombbackup");
    render().nodes.find((node) => node.props.type === "file")!.props.onChange!({ target: { files: [file] } });
    const validate = async () => { change(render().nodes.filter((node) => node.props.type === "password")[2], "correct horse battery"); submit(render().nodes.filter((node) => node.type === "form")[1]); await flush(); };
    const expired = Object.assign(new Error("Backup expired; upload again"), { status: 404 });
    fixture.api.mockResolvedValueOnce({ id: "upload-old" }).mockRejectedValueOnce(expired);
    await validate();
    fixture.api.mockResolvedValueOnce({ id: "upload-new" }).mockResolvedValueOnce({ id: "stage-old", summary });
    await validate();
    change(render().nodes.find((node) => node.type === "input" && !node.props.type)!, "REPLACE");
    fixture.api.mockRejectedValueOnce(expired);
    render().nodes.find((node) => node.type === "button" && node.props.children === "Replace workspace")!.props.onClick!(); await flush();
    expect(render().html).not.toContain("Validated backup");
    fixture.api.mockResolvedValueOnce({ id: "upload-final" }).mockResolvedValueOnce({ id: "stage-final", summary });
    await validate();
    expect(fixture.api.mock.calls.filter(([path]) => path.endsWith("/upload"))).toHaveLength(3);
    expect(render().html).toContain("Validated backup");
  });

  it("does not restore client state before restart, then replaces only the initiating browser's allowlist", async () => {
    storage.set("omb-pending-workspace-restore", "stage-id"); storage.set("omb-drafts", "old"); storage.set("auth-token", "keep");
    fixture.api.mockResolvedValueOnce({ busy: true, pendingRestore: true });
    expect(render(true).html).not.toContain("Continue without restoring drafts");
    fixture.effects[0](); await flush();
    expect(render(true).html).toContain("Fully quit OpenMausBot");
    expect(render(true).html).not.toContain("Continue without restoring drafts");
    expect(fixture.api).toHaveBeenCalledOnce(); expect(storage.get("omb-drafts")).toBe("old");
    fixture.values = [];
    fixture.api.mockResolvedValueOnce({ busy: false, lastRestoreId: "stage-id" }).mockResolvedValueOnce({ clientState: { "omb-drafts": "restored" } });
    render(true); fixture.effects[0](); await flush();
    expect(storage.get("omb-drafts")).toBe("restored"); expect(storage.get("auth-token")).toBe("keep");
    expect(storage.has("omb-pending-workspace-restore")).toBe(false); expect(window.location.reload).toHaveBeenCalledOnce();
  });

  it("never imports a different restore's browser state", async () => {
    storage.set("omb-pending-workspace-restore", "my-stage"); storage.set("omb-drafts", "keep");
    fixture.api.mockResolvedValueOnce({ busy: false, lastRestoreId: "another-stage" });
    render(true); fixture.effects[0](); await flush();
    expect(fixture.api).toHaveBeenCalledOnce();
    expect(render(true).html).toContain("Normal app");
    expect(storage.get("omb-drafts")).toBe("keep");
    expect(storage.has("omb-pending-workspace-restore")).toBe(false);
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("keeps the normal app gated and its old drafts intact on recovery failure", async () => {
    storage.set("omb-pending-workspace-restore", "stage-id"); storage.set("omb-drafts", "keep");
    fixture.api.mockResolvedValueOnce({ busy: false, lastRestoreId: "stage-id" }).mockRejectedValueOnce(new Error("Fixture unavailable"));
    render(true); fixture.effects[0](); await flush();
    const html = render(true).html;
    expect(html).toContain("Fixture unavailable"); expect(html).toContain("Retry"); expect(html).not.toContain("Normal app");
    expect(storage.get("omb-drafts")).toBe("keep"); expect(storage.get("omb-pending-workspace-restore")).toBe("stage-id");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it.each([401, 403])("explicitly returns to normal bootstrap after a %s without changing browser state", async (status) => {
    storage.set("omb-pending-workspace-restore", "stage-id");
    storage.set("omb-drafts", "keep drafts"); storage.set("omb-draft-attachments", "keep attachments");
    storage.set("omb-skin", "keep preferences"); storage.set("auth-token", "keep session");
    const before = new Map(storage);
    if (status === 403) fixture.api.mockResolvedValueOnce({ busy: false, lastRestoreId: "stage-id" });
    fixture.api.mockRejectedValueOnce(Object.assign(new Error("Sign-in required"), { status }));
    render(true); fixture.effects[0](); await flush();
    const view = render(true);
    expect(view.html).toContain("Retry"); expect(view.html).toContain("This does not undo the workspace restore.");
    expect(view.html).not.toContain("Normal app");
    expect(storage).toEqual(before); expect(window.location.reload).not.toHaveBeenCalled();
    view.nodes.find((node) => node.type === "button" && node.props.children === "Continue without restoring drafts")!.props.onClick!();
    before.delete("omb-pending-workspace-restore");
    expect(storage).toEqual(before);
    expect(window.location.reload).toHaveBeenCalledOnce();
    expect(render(true).html).not.toContain("Normal app"); // bootstrap, not a direct authentication bypass
    expect(fixture.api).toHaveBeenCalledTimes(status === 401 ? 1 : 2);
  });

  it("keeps recovery gated if its marker cannot be cleared", async () => {
    storage.set("omb-pending-workspace-restore", "stage-id"); storage.set("omb-drafts", "keep");
    fixture.api.mockRejectedValueOnce(new Error("Sign-in required"));
    render(true); fixture.effects[0](); await flush();
    vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    render(true).nodes.find((node) => node.type === "button" && node.props.children === "Continue without restoring drafts")!.props.onClick!();
    expect(render(true).html).toContain("Storage unavailable"); expect(render(true).html).not.toContain("Normal app");
    expect(storage.get("omb-drafts")).toBe("keep"); expect(storage.get("omb-pending-workspace-restore")).toBe("stage-id");
    expect(window.location.reload).not.toHaveBeenCalled();
  });
});
