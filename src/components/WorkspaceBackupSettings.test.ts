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
import { WorkspaceBackupRecovery, WorkspaceBackupRestartNotice, WorkspaceBackupSettings, WorkspaceBackupSummaryView } from "./WorkspaceBackupSettings";

type Node = ReactElement<{ children?: ReactNode; type?: string; disabled?: boolean; value?: string; onChange?: (event: unknown) => void; onSubmit?: (event: unknown) => void; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  // A row's description and message lines hold controls too (Learn more).
  const extra = node.props as { subtitle?: ReactNode; message?: ReactNode };
  return [node, ...Children.toArray(node.props.children).flatMap(nodes), ...Children.toArray(extra.subtitle).flatMap(nodes), ...Children.toArray(extra.message).flatMap(nodes)];
}
function render(recovery: boolean | "restart" | "cloud" = false) {
  fixture.index = 0; fixture.effects = [];
  let tree: ReactNode;
  function Capture() { tree = recovery === "restart" ? WorkspaceBackupRestartNotice() : recovery === "cloud" ? WorkspaceBackupRestartNotice({ serverRestarts: true }) : recovery ? WorkspaceBackupRecovery({ children: createElement("p", null, "Normal app") }) : WorkspaceBackupSettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const submit = (form: Node) => form.props.onSubmit!({ preventDefault: vi.fn() });
const change = (input: Node, value: string) => input.props.onChange!({ target: { value } });
const summary: WorkspaceBackupSummary = { format: "openmaus.workspace-backup", version: 1, id: "archive-id", createdAt: "2026-09-11T00:00:00Z", appVersion: "0.1.71", files: 9, directories: 3, bytes: 1234, bots: 2, groups: 1, threads: 4, messages: 8, warnings: ["Fixture warning"], exclusions: ["Saved account credentials and connections", "External CLI sign-ins"] };
let storage: Map<string, string>;
beforeEach(() => {
  fixture.values = []; fixture.index = 0; fixture.effects = []; fixture.api.mockReset();
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("window", { location: { reload: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());
async function ready() { fixture.api.mockResolvedValueOnce({ busy: false }); render(); fixture.effects[0](); await flush(); }
/** Each backup action is a row whose button opens its own small dialog. */
const open = (which: "export" | "import") => { render().nodes.find((node) => (node.props as Record<string, unknown>)[`data-backup-${which}`] === "")!.props.onClick!(); };
const formOf = (id: string) => render().nodes.find((node) => node.type === "form" && (node.props as { id?: string }).id === id)!;

describe("Settings full backups", () => {
  it("shows two rows, each opening a dialog with its file input or password fields, the details behind Learn more, and a validated summary with warnings", async () => {
    await ready();
    let html = render().html;
    expect(html).toContain("Password-protected. Saved logins are not included.");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="file"');
    render().nodes.find((node) => (node.type as { name?: string }).name === "LearnMore")!.props.onClick!();
    open("export"); open("import");
    html = render().html;
    expect(html).toContain('type="file" accept=".ombbackup"');
    expect(html.match(/type="password"/g)).toHaveLength(3);
    expect(html).toContain("the disks of remote desktops");
    expect(html).toContain("Saved account credentials and connections are not included");
    expect(html).toContain("existing credentials on the destination stay unchanged");
    expect(html).toContain("not automatically redacted");
    expect(html).not.toContain("Replace installation");
    const preview = renderToStaticMarkup(createElement(WorkspaceBackupSummaryView, { summary }));
    for (const text of ["Validated backup", "0.1.71", "Bots", "Threads", "Messages", "Fixture warning", "External CLI sign-ins"]) expect(preview).toContain(text);
  });

  it("exports encrypted state by POST and downloads without putting the password in a URL or storage", async () => {
    await ready();
    storage.set("omb-drafts", "private draft"); storage.set("auth-token", "not exported"); storage.set("omb-webhook-credentials", "not exported either");
    open("export");
    let view = render();
    const passwords = view.nodes.filter((node) => node.type === "input" && node.props.type === "password");
    change(passwords[0], "correct horse battery"); change(passwords[1], "correct horse battery");
    view = render();
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: () => link, body: { append: vi.fn() } });
    fixture.api.mockResolvedValueOnce({ id: "download-id", filename: "fixture.ombbackup" });
    const form = formOf("backup-export");
    submit(form); submit(form); await flush();
    expect(fixture.api).toHaveBeenCalledTimes(2); // one status, one export
    const [path, init] = fixture.api.mock.calls[1];
    expect(path).toBe("/api/workspace-backup/export");
    expect(JSON.parse(init.body)).toEqual({ password: "correct horse battery", clientState: { "omb-drafts": "private draft" } });
    expect(link.href).toBe("/api/workspace-backup/download/download-id");
    expect(link.click).toHaveBeenCalledOnce();
    expect([...storage.values()]).not.toContain("correct horse battery");
    expect(render().html).not.toContain('value="correct horse battery"');
    expect(render().html).not.toContain('id="backup-export"');
  });

  it("keeps the export dialog open with its reason when the export fails, so it can be tried again", async () => {
    await ready();
    open("export");
    const passwords = render().nodes.filter((node) => node.type === "input" && node.props.type === "password");
    change(passwords[0], "correct horse battery"); change(passwords[1], "correct horse battery");
    fixture.api.mockRejectedValueOnce(new Error("Disk full"));
    submit(formOf("backup-export")); await flush();
    const html = render().html;
    expect(html).toContain('id="backup-export"');
    expect(html).toMatch(/role="alert"[^>]*>Disk full</);
  });

  it("uploads a raw file, validates it, and requires exact REPLACE with the staged ID", async () => {
    await ready();
    const file = new File(["encrypted fixture"], "fixture.ombbackup");
    open("import");
    render().nodes.find((node) => node.props.type === "file")!.props.onChange!({ target: { files: [file] } });
    let view = render();
    change(view.nodes.filter((node) => node.props.type === "password")[0], "correct horse battery");
    fixture.api.mockResolvedValueOnce({ id: "upload-id" }).mockResolvedValueOnce({ id: "stage-id", summary });
    submit(formOf("backup-import")); await flush();
    expect(fixture.api.mock.calls[1]).toEqual(["/api/workspace-backup/upload", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file }]);
    expect(JSON.parse(fixture.api.mock.calls[2][1].body)).toEqual({ id: "upload-id", password: "correct horse battery" });
    view = render();
    const replace = () => render().nodes.find((node) => node.type === "button" && node.props.children === "Replace installation")!;
    expect(replace().props.disabled).toBe(true);
    const confirm = view.nodes.filter((node) => node.type === "input" && !node.props.type)[0];
    change(confirm, "replace"); expect(replace().props.disabled).toBe(true);
    change(confirm, "REPLACE"); expect(replace().props.disabled).toBe(false);
    fixture.api.mockResolvedValueOnce({ restartRequired: true, restoreId: "stage-id" });
    replace().props.onClick!(); await flush();
    expect(JSON.parse(fixture.api.mock.calls[3][1].body)).toEqual({ id: "stage-id", confirmation: "REPLACE" });
    expect(storage.get("omb-pending-workspace-restore")).toBe("stage-id");
    expect(render().html).toContain("Fully quit MausBot");
  });

  it("does not offer a replacement after failed password validation", async () => {
    await ready();
    open("import");
    render().nodes.find((node) => node.props.type === "file")!.props.onChange!({ target: { files: [new File(["archive"], "file.ombbackup")] } });
    change(render().nodes.filter((node) => node.props.type === "password")[0], "wrong password");
    fixture.api.mockResolvedValueOnce({ id: "upload" }).mockRejectedValueOnce(new Error("Wrong password"));
    submit(formOf("backup-import")); await flush();
    const html = render().html;
    expect(html).toContain('role="alert"'); expect(html).toContain("Wrong password"); expect(html).not.toContain("Replace installation");
  });

  it("reuploads the selected file if its upload or validated stage expires", async () => {
    await ready();
    const file = new File(["archive"], "file.ombbackup");
    open("import");
    render().nodes.find((node) => node.props.type === "file")!.props.onChange!({ target: { files: [file] } });
    const validate = async () => { change(render().nodes.filter((node) => node.props.type === "password")[0], "correct horse battery"); submit(formOf("backup-import")); await flush(); };
    const expired = Object.assign(new Error("Backup expired; upload again"), { status: 404 });
    fixture.api.mockResolvedValueOnce({ id: "upload-old" }).mockRejectedValueOnce(expired);
    await validate();
    fixture.api.mockResolvedValueOnce({ id: "upload-new" }).mockResolvedValueOnce({ id: "stage-old", summary });
    await validate();
    change(render().nodes.find((node) => node.type === "input" && !node.props.type)!, "REPLACE");
    fixture.api.mockRejectedValueOnce(expired);
    render().nodes.find((node) => node.type === "button" && node.props.children === "Replace installation")!.props.onClick!(); await flush();
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
    expect(render(true).html).toContain("Fully quit MausBot");
    expect(render(true).html).not.toContain("Continue without restoring drafts");
    expect(fixture.api).toHaveBeenCalledOnce(); expect(storage.get("omb-drafts")).toBe("old");
    fixture.values = [];
    fixture.api.mockResolvedValueOnce({ busy: false, lastRestoreId: "stage-id" }).mockResolvedValueOnce({ clientState: { "omb-drafts": "restored" } });
    render(true); fixture.effects[0](); await flush();
    expect(storage.get("omb-drafts")).toBe("restored"); expect(storage.get("auth-token")).toBe("keep");
    expect(storage.has("omb-pending-workspace-restore")).toBe(false); expect(window.location.reload).toHaveBeenCalledOnce();
  });

  it("on a server that restarts itself, waits instead of asking to quit, then carries on once the restore is installed", async () => {
    storage.set("omb-pending-workspace-restore", "stage-id");
    fixture.api.mockResolvedValueOnce({ busy: true, pendingRestore: true, restarts: true });
    render(true); fixture.effects[0](); await flush();
    expect(render(true).html).toContain("is restarting to finish it");
    expect(render(true).html).not.toContain("Fully quit");
    vi.useFakeTimers();
    try {
      fixture.values = [];
      const view = render("cloud");
      expect(view.html).toContain("is restarting to finish it");
      expect(view.nodes.some(node => node.type === "button")).toBe(false);
      const stop = fixture.effects[0]() as () => void;
      fixture.api.mockResolvedValueOnce({ busy: true, pendingRestore: true });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(window.location.reload).not.toHaveBeenCalled();
      fixture.api.mockResolvedValueOnce({});
      await vi.advanceTimersByTimeAsync(3_000);
      expect(window.location.reload).not.toHaveBeenCalled();
      fixture.api.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(window.location.reload).not.toHaveBeenCalled();
      fixture.api.mockResolvedValueOnce({ busy: false, pendingRestore: false, lastRestoreId: "stage-id" });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(window.location.reload).toHaveBeenCalledOnce();
      expect(fixture.api.mock.calls.filter(([path, init]) => path === "/api/workspace-backup/status" && init?.timeoutMs === 10_000)).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(window.location.reload).toHaveBeenCalledOnce();
      stop();
    } finally { vi.useRealTimers(); }
    expect(storage.get("omb-pending-workspace-restore")).toBe("stage-id");
  });

  it("on a server that restarts itself, says so when the restart takes much longer, and keeps waiting", async () => {
    storage.set("omb-pending-workspace-restore", "stage-id");
    vi.useFakeTimers();
    try {
      expect(render("cloud").html).not.toContain("longer than usual");
      const stop = fixture.effects[0]() as () => void;
      fixture.api.mockRejectedValue(new Error("Server unavailable"));
      await vi.advanceTimersByTimeAsync(180_000);
      expect(render("cloud").html).toContain("longer than usual");
      expect(window.location.reload).not.toHaveBeenCalled();
      stop();
    } finally { vi.useRealTimers(); }
    expect(storage.get("omb-pending-workspace-restore")).toBe("stage-id");
  });

  it("on a server that restarts itself, reloads to sign-in when the restored workspace does not know this browser", async () => {
    vi.useFakeTimers();
    try {
      render("cloud");
      const stop = fixture.effects[0]() as () => void;
      fixture.api.mockRejectedValueOnce(Object.assign(new Error("Sign in"), { status: 401 }));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(window.location.reload).toHaveBeenCalledOnce();
      stop();
    } finally { vi.useRealTimers(); }
  });

  it("offers a real desktop restart without clearing the restore marker or drafts, once only", async () => {
    const relaunch = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { ...window, ogb: { relaunch } });
    storage.set("omb-pending-workspace-restore", "stage-id"); storage.set("omb-drafts", "keep");
    fixture.api.mockResolvedValueOnce({ busy: true, pendingRestore: true });
    render(true); fixture.effects[0](); await flush();
    expect(render(true).html).toContain("Restart and restore");
    expect(render(true).html).not.toContain(">Retry<");
    fixture.values = [];
    const restart = render("restart").nodes.find(node => node.type === "button")!;
    restart.props.onClick!(); restart.props.onClick!(); await flush();
    expect(relaunch).toHaveBeenCalledOnce();
    expect(render("restart").nodes.find(node => node.type === "button")!.props.disabled).toBe(true);
    expect(storage.get("omb-pending-workspace-restore")).toBe("stage-id");
    expect(storage.get("omb-drafts")).toBe("keep");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it.each([false, new Error("Fixture restart unavailable")])("keeps recovery intact and offers a retry when native restart fails (%s)", async result => {
    const relaunch = result === false ? vi.fn().mockResolvedValue(false) : vi.fn().mockRejectedValue(result);
    vi.stubGlobal("window", { ...window, ogb: { relaunch } });
    storage.set("omb-pending-workspace-restore", "stage-id");
    render("restart").nodes.find(node => node.type === "button")!.props.onClick!(); await flush();
    const view = render("restart");
    expect(view.html).toContain("Could not restart MausBot");
    expect(view.nodes.find(node => node.type === "button")!.props.disabled).toBe(false);
    expect(storage.get("omb-pending-workspace-restore")).toBe("stage-id");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it.each([undefined, { relaunch: vi.fn(), remoteClient: { active: true } }])("never restarts the local app for a browser or remote workspace", bridge => {
    window.ogb = bridge as Window["ogb"];
    const view = render("restart");
    expect(view.html).toContain("restart the server process");
    expect(view.html).not.toContain("Restart and restore");
    expect(view.nodes.filter(node => node.type === "button")).toHaveLength(0);
  });

  it("retains the server-status retry for browser recovery", async () => {
    storage.set("omb-pending-workspace-restore", "stage-id");
    fixture.api.mockResolvedValueOnce({ busy: true, pendingRestore: true });
    render(true); fixture.effects[0](); await flush();
    expect(render(true).html).toContain(">Retry<");
    expect(render(true).html).not.toContain("Restart and restore");
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
    expect(view.html).toContain("Retry"); expect(view.html).toContain("This does not undo the installation restore.");
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
