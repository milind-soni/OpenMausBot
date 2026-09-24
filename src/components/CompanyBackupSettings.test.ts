import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDesktopBridge, ManagedDesktopState } from "../../electron/managed-desktop.mjs";
import type { WorkspaceBackupSummary } from "../../shared/workspace-backup";
import { setLocale } from "@/lib/i18n";
import { WORKSPACE_RESTORE_MARKER } from "@/lib/workspace-backup-client";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { CompanyBackupSettings, ConnectedCompanyBackupSettings, SavedCompanyBackupSchedule } from "./CompanyBackupSettings";

type BackupBridge = NonNullable<NonNullable<Window["ogb"]>["companyBackups"]>;
type Node = ReactElement<{
  children?: ReactNode; type?: string; disabled?: boolean; value?: string; role?: string;
  "aria-label"?: string; onChange?: (event: unknown) => void;
  onSubmit?: (event: unknown) => void; onClick?: () => void;
  onKeyDown?: (event: unknown) => void; onCancel?: (event: unknown) => void;
}>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function content(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(content).join("");
  return isValidElement(value) ? content((value as Node).props.children) : "";
}
function render(outer = false) {
  fixture.index = 0; fixture.effects = [];
  let tree: ReactNode;
  function Capture() {
    tree = outer ? CompanyBackupSettings() : ConnectedCompanyBackupSettings({ connection: connected, bridge });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree), tree: tree! };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const change = (input: Node, value: string) => input.props.onChange!({ target: { value } });
const submit = (form: Node) => form.props.onSubmit!({ preventDefault: vi.fn() });
const buttons = (label: string) => render().nodes.filter(node => node.type === "button" && content(node.props.children) === label);
const button = (label: string) => buttons(label)[0];
const passwords = () => render().nodes.filter(node => node.type === "input" && node.props.type === "password");
const form = () => render().nodes.find(node => node.type === "form")!;
const confirmation = () => render().nodes.find(node => node.type === "input" && (!node.props.type || node.props.type === "text"))!;
function effects() {
  const cleanups = [...fixture.effects].map(effect => effect());
  return () => { for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup(); };
}

const READY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const STAGE_ID = "33333333-3333-4333-8333-333333333333";
const PASSWORD = "fixture-only backup password";
const connected: ManagedDesktopState = {
  status: "connected", cloudBackups: true,
  organization: { id: "fixture-organization", name: "Fixture Company" },
  email: "employee@example.test", deviceId: "fixture-device", providers: [],
};
const readyEntry: CompanyBackupEntry = {
  passwordRequired: true,
  id: READY_ID, status: "ready", sizeBytes: 4096, sha256: "a".repeat(64), appVersion: "0.0.0-fixture",
  createdAt: Date.parse("2026-09-12T10:00:00Z"), completedAt: Date.parse("2026-09-12T10:01:00Z"),
};
const summary: WorkspaceBackupSummary = {
  format: "openmaus.workspace-backup", version: 1, id: READY_ID, createdAt: "2026-09-12T10:00:00Z",
  appVersion: "0.0.0-fixture", files: 9, directories: 3, bytes: 4096, bots: 2, groups: 1, threads: 4,
  messages: 8, warnings: ["Fixture archive warning"], exclusions: ["Saved account credentials and connections"],
};
let bridge: BackupBridge;
let organization: ManagedDesktopBridge;
let pushBackup: (state: CompanyBackupState) => void;
let pushOrganization: (state: ManagedDesktopState) => void;
let unsubscribeBackup = vi.fn<() => void>();
let unsubscribeOrganization = vi.fn<() => void>();
let storage: Map<string, string>;
beforeEach(() => {
  fixture.values = []; fixture.index = 0; fixture.effects = [];
  pushBackup = () => {}; pushOrganization = () => {};
  unsubscribeBackup = vi.fn<() => void>(); unsubscribeOrganization = vi.fn<() => void>();
  storage = new Map();
  bridge = {
    state: vi.fn().mockResolvedValue({ busy: false }),
    list: vi.fn().mockResolvedValue({ backups: [readyEntry], usedBytes: 4096, limits: { ownerQuotaBytes: 1024 ** 3, retainedSnapshots: 5 } }),
    create: vi.fn().mockResolvedValue(readyEntry),
    configureSchedule: vi.fn().mockResolvedValue({ busy: false, schedule: { enabled: false, status: "off" } }),
    prepareRestore: vi.fn().mockResolvedValue({ id: STAGE_ID, summary }),
    restore: vi.fn().mockResolvedValue({ restoreId: STAGE_ID }),
    delete: vi.fn().mockResolvedValue({ ok: true }), cancel: vi.fn().mockResolvedValue(undefined),
    onState: vi.fn(callback => { pushBackup = callback; return unsubscribeBackup; }),
  };
  organization = {
    state: vi.fn().mockResolvedValue(connected), begin: vi.fn(), cancelEnrollment: vi.fn(), refresh: vi.fn(), disconnect: vi.fn(),
    onState: vi.fn(callback => { pushOrganization = callback; return unsubscribeOrganization; }),
  };
  vi.stubGlobal("window", { ogb: { organization, companyBackups: bridge }, location: { reload: vi.fn() } });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    removeItem: vi.fn((key: string) => storage.delete(key)),
  });
  vi.stubGlobal("fetch", vi.fn());
  setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });
async function ready() { render(); const cleanup = effects(); await flush(); return cleanup; }
async function readyOuter(state: ManagedDesktopState = connected) {
  vi.mocked(organization.state).mockResolvedValueOnce(state);
  render(true); const cleanup = effects(); await flush(); return cleanup;
}
async function validateRestore() {
  button("Restore this backup").props.onClick!();
  change(passwords()[0], PASSWORD);
  submit(form()); await flush();
}

describe("optional Company cloud backup settings", () => {
  it.each(["browser", "remote", "missing organization", "missing backups"])("is absent on a %s surface without requesting cloud data", surface => {
    if (surface === "browser") vi.stubGlobal("window", {});
    if (surface === "remote") vi.stubGlobal("window", { ogb: { organization, companyBackups: bridge, remoteClient: { active: true } } });
    if (surface === "missing organization") vi.stubGlobal("window", { ogb: { companyBackups: bridge } });
    if (surface === "missing backups") vi.stubGlobal("window", { ogb: { organization } });
    expect(render(true).html).toBe(""); effects();
    if (surface !== "missing backups") expect(organization.state).not.toHaveBeenCalled();
    expect(bridge.state).not.toHaveBeenCalled(); expect(bridge.list).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: "signed-out" },
    { ...connected, status: "reauth-required" },
    { ...connected, status: "unavailable" },
    { ...connected, cloudBackups: false },
    { ...connected, cloudBackups: undefined },
    { ...connected, organization: undefined },
    { ...connected, organization: { id: "fixture-organization", name: "" } },
    { ...connected, email: undefined },
  ] as ManagedDesktopState[])("does not mount cloud controls for an ineligible company connection %#", async state => {
    await readyOuter(state);
    expect(render(true).html).toBe("");
    expect(bridge.state).not.toHaveBeenCalled(); expect(bridge.list).not.toHaveBeenCalled();
    expect(bridge.onState).not.toHaveBeenCalled();
  });

  it("keeps a paused daily schedule visible, with its off switch, while disconnected, without any cloud request", async () => {
    vi.mocked(organization.state).mockResolvedValue({ status: "signed-out" });
    vi.mocked(bridge.state).mockResolvedValue({ busy: false, schedule: { enabled: true, status: "paused" } });
    await readyOuter({ status: "signed-out" });
    render(true); effects(); await flush();
    const html = render(true).html;
    expect(html).toContain("Daily company backups are paused until this computer reconnects");
    expect(html).toContain("Waiting for the local workspace and company connection to be ready.");
    expect(bridge.list).not.toHaveBeenCalled();
    // The schedule row itself: render it directly to reach its switch.
    const saved = () => { fixture.index = 0; fixture.effects = []; const tree = SavedCompanyBackupSchedule({ bridge }); return nodes(tree); };
    fixture.values = [];
    saved(); effects(); await flush();
    const toggle = saved().find(node => node.props["aria-label"] === "Daily backups")!;
    toggle.props.onClick!(); await flush();
    expect(bridge.configureSchedule).toHaveBeenCalledExactlyOnceWith({ enabled: false });
    expect(saved()).toEqual([]);
  });

  it("waits for the eligible organization before loading backup state and scopes its child to that identity", async () => {
    let resolveConnection!: (state: ManagedDesktopState) => void;
    vi.mocked(organization.state).mockImplementation(() => new Promise(resolve => { resolveConnection = resolve; }));
    expect(render(true).html).toBe(""); effects();
    expect(bridge.state).not.toHaveBeenCalled(); expect(bridge.list).not.toHaveBeenCalled();
    resolveConnection(connected); await flush();
    const initial = render(true);
    expect(initial.html).toContain("Company cloud backups");
    const firstKey = isValidElement(initial.tree) ? initial.tree.key : null;
    pushOrganization({ ...connected, deviceId: "different-device" });
    const changed = render(true);
    expect(isValidElement(changed.tree) ? changed.tree.key : null).not.toBe(firstKey);
    pushOrganization({ status: "signed-out" });
    expect(render(true).html).toBe("");
  });

  it("ignores an old organization snapshot after a newer disconnected broadcast", async () => {
    let resolveConnection!: (state: ManagedDesktopState) => void;
    vi.mocked(organization.state).mockImplementation(() => new Promise(resolve => { resolveConnection = resolve; }));
    render(true); const cleanup = effects();
    pushOrganization({ status: "signed-out" });
    resolveConnection(connected); await flush();
    expect(render(true).html).toBe("");
    expect(bridge.list).not.toHaveBeenCalled();
    cleanup(); expect(unsubscribeOrganization).toHaveBeenCalledOnce();
  });

  it("shows company identity, ready backup metadata and quota without asking for a password or upload", async () => {
    await ready();
    const view = render();
    expect(view.html).toContain("Company cloud backups");
    expect(view.html).toContain("Fixture Company");
    expect(view.html).toContain("employee@example.test");
    expect(view.html).toContain("0.0.0-fixture");
    expect(passwords()).toHaveLength(0);
    expect(bridge.state).toHaveBeenCalledOnce(); expect(bridge.list).toHaveBeenCalledOnce();
    expect(bridge.create).not.toHaveBeenCalled(); expect(bridge.prepareRestore).not.toHaveBeenCalled();
    expect(bridge.restore).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    button("Refresh cloud backups").props.onClick!(); await flush();
    expect(bridge.list).toHaveBeenCalledTimes(2);
  });

  it("lists only completed snapshots and accounts for pending reservations separately", async () => {
    const pending = (["creating", "uploading", "completing", "cleanup"] as const).map((status, index) => ({
      ...readyEntry, id: `pending-fixture-${index}`, status, completedAt: undefined,
      createdAt: Date.parse("2028-01-01T00:00:00Z"), appVersion: "pending-version",
    }));
    vi.mocked(bridge.list).mockResolvedValueOnce({ backups: [readyEntry, ...pending], usedBytes: 1024 ** 3 / 2, limits: { ownerQuotaBytes: 1024 ** 3, retainedSnapshots: 5 } });
    await ready();
    const html = render().html;
    expect(html).toContain("512 MiB of 1 GiB used or reserved");
    expect(html).toContain("Up to 5 snapshots kept after a successful backup");
    expect(html).toContain("4 unfinished uploads or cleanups");
    expect(html).toContain(new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(readyEntry.completedAt!)));
    expect(html).toContain(READY_ID);
    expect(html).not.toContain("pending-fixture"); expect(html).not.toContain("pending-version");
    expect(html).not.toContain("2028");
    expect(buttons("Restore this backup")).toHaveLength(1);
    expect(buttons("Delete cloud backup")).toHaveLength(1);
  });

  it("does not present unfinished uploads as restorable backups", async () => {
    vi.mocked(bridge.list).mockResolvedValueOnce({ backups: [{ ...readyEntry, status: "uploading" }], usedBytes: 4096, limits: { ownerQuotaBytes: 1024 ** 3, retainedSnapshots: 5 } });
    await ready();
    expect(render().html).toContain("No completed cloud backups yet");
    expect(button("Restore this backup")).toBeUndefined();
    expect(button("Delete cloud backup")).toBeUndefined();
    expect(bridge.prepareRestore).not.toHaveBeenCalled();
  });

  it("shows restart instructions and no backup actions when a restore is already staged", async () => {
    vi.mocked(bridge.state).mockResolvedValueOnce({ busy: false, pendingRestore: true });
    await ready();
    expect(render().html).toContain("Fully quit OpenMausBot");
    for (const label of ["Back up this workspace", "Restore this backup", "Delete cloud backup", "Refresh cloud backups"]) {
      expect(button(label)).toBeUndefined();
    }
    expect(passwords()).toHaveLength(0);
    expect(bridge.create).not.toHaveBeenCalled(); expect(bridge.prepareRestore).not.toHaveBeenCalled();
    expect(bridge.restore).not.toHaveBeenCalled(); expect(bridge.delete).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps pending-restore authority when the cloud list fails (late state: %s)", async lateState => {
    let resolveState!: (state: CompanyBackupState) => void;
    if (lateState) vi.mocked(bridge.state).mockImplementationOnce(() => new Promise(resolve => { resolveState = resolve; }));
    else vi.mocked(bridge.state).mockResolvedValueOnce({ busy: false, pendingRestore: true });
    vi.mocked(bridge.list).mockRejectedValueOnce(new Error("Fixture cloud list unavailable"));
    await ready();
    if (lateState) {
      expect(render().html).toContain("Cloud backups could not be loaded");
      expect(render().html).not.toContain("Fully quit OpenMausBot");
      resolveState({ busy: false, pendingRestore: true }); await flush();
    }
    expect(render().html).toContain("Fully quit OpenMausBot");
    for (const label of ["Back up this workspace", "Restore this backup", "Delete cloud backup", "Refresh cloud backups"]) {
      expect(button(label)).toBeUndefined();
    }
    expect(bridge.create).not.toHaveBeenCalled(); expect(bridge.prepareRestore).not.toHaveBeenCalled();
    expect(bridge.restore).not.toHaveBeenCalled(); expect(bridge.delete).not.toHaveBeenCalled();
  });

  it("can retry after an initial state request fails without exposing internal errors", async () => {
    vi.mocked(bridge.state).mockRejectedValueOnce(new Error("Fixture private-path signed-token"));
    await ready();
    expect(button("Refresh cloud backups").props.disabled).toBe(false);
    expect(render().html).not.toContain("signed-token");
    button("Refresh cloud backups").props.onClick!(); await flush();
    expect(bridge.state).toHaveBeenCalledTimes(2);
    expect(button("Back up this workspace").props.disabled).toBe(false);
  });

  it("keeps the newer list when refresh responses finish out of order", async () => {
    await ready();
    const resolvers: Array<(value: Awaited<ReturnType<BackupBridge["list"]>>) => void> = [];
    vi.mocked(bridge.list).mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
    const refresh = button("Refresh cloud backups");
    refresh.props.onClick!(); refresh.props.onClick!();
    resolvers[1]({ backups: [{ ...readyEntry, id: OTHER_ID }], usedBytes: 4096, limits: { ownerQuotaBytes: 1024 ** 3, retainedSnapshots: 5 } });
    await flush();
    resolvers[0]({ backups: [readyEntry], usedBytes: 4096, limits: { ownerQuotaBytes: 1024 ** 3, retainedSnapshots: 5 } });
    await flush();
    expect(render().html).toContain(OTHER_ID); expect(render().html).not.toContain(READY_ID);
  });

  it("previews a managed backup without asking for or forwarding a password", async () => {
    vi.mocked(bridge.list).mockResolvedValueOnce({ backups: [{ ...readyEntry, passwordRequired: false }], usedBytes: 4096, limits: { ownerQuotaBytes: 1024 ** 3, retainedSnapshots: 7 } });
    await ready(); button("Restore this backup").props.onClick!();
    expect(passwords()).toHaveLength(0);
    expect(button("Validate backup").props.disabled).toBe(false);
    submit(form()); await flush();
    expect(bridge.prepareRestore).toHaveBeenCalledExactlyOnceWith({ id: READY_ID });
    expect(bridge.restore).not.toHaveBeenCalled();
  });

  it("rejects a short legacy password before calling the native preview", async () => {
    await ready(); button("Restore this backup").props.onClick!();
    change(passwords()[0], "short");
    expect(button("Validate backup").props.disabled).toBe(true);
    submit(form()); await flush();
    expect(bridge.prepareRestore).not.toHaveBeenCalled();
  });

  it("requires an explicit backup dialog without passwords, then exports only allowlisted local preferences", async () => {
    await ready();
    storage.set("omb-drafts", "private fixture draft"); storage.set("omb-skin", "fixture-theme");
    storage.set("auth-token", "fixture auth secret"); storage.set("omb-webhook-credentials", "fixture connection secret");
    button("Back up this workspace").props.onClick!();
    expect(bridge.create).not.toHaveBeenCalled(); expect(passwords()).toHaveLength(0);
    expect(render().nodes.some(node => node.type === "dialog")).toBe(true);
    expect(render().html).toContain("THIS current workspace");
    expect(render().html).toContain("personal conversations and files");
    expect(render().html).toContain("Saved account credentials and connections are not included");
    const submitButton = () => render().nodes.find(node => node.type === "button" && node.props.type === "submit")!;
    expect(submitButton().props.disabled).toBe(false);
    const createForm = form(); submit(createForm); submit(createForm); await flush();
    expect(bridge.create).toHaveBeenCalledExactlyOnceWith({ clientState: { "omb-drafts": "private fixture draft", "omb-skin": "fixture-theme" } });
    expect([...storage.values()]).not.toContain(PASSWORD);
    expect(render().html).not.toContain(PASSWORD);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears a cancelled backup dialog without retaining passwords or uploading", async () => {
    await ready(); button("Back up this workspace").props.onClick!();
    expect(passwords()).toHaveLength(0);
    button("Cancel").props.onClick!();
    expect(passwords()).toHaveLength(0); expect(bridge.create).not.toHaveBeenCalled();
    button("Back up this workspace").props.onClick!();
    expect(passwords()).toHaveLength(0);
    expect([...storage.values()]).not.toContain(PASSWORD);
  });

  const scheduleSwitch = () => render().nodes.find(node => node.props["aria-label"] === "Daily backups")!;
  const scheduleOff = { busy: false, schedule: { enabled: false, status: "off" as const } };
  it("keeps daily backups off without any automatic setting mutation or password request", async () => {
    vi.mocked(bridge.state).mockResolvedValueOnce(scheduleOff);
    await ready();
    expect(render().html).toContain('aria-checked="false"');
    expect(render().html).toContain("Off — no scheduled uploads");
    expect(bridge.configureSchedule).not.toHaveBeenCalled();
    expect(passwords()).toHaveLength(0);
    expect(bridge.create).not.toHaveBeenCalled();
  });

  it("requires explicit future-workspace consent without a password for daily backups", async () => {
    vi.mocked(bridge.state).mockResolvedValueOnce(scheduleOff);
    vi.mocked(bridge.configureSchedule!).mockResolvedValueOnce({ busy: false, schedule: { enabled: true, status: "waiting", nextBackupAt: Date.parse("2026-09-16T10:00:00Z") } });
    await ready(); scheduleSwitch().props.onClick!();
    expect(render().html).toContain("personal conversations and files");
    expect(render().html).toContain("starting in 24 hours");
    expect(render().html).toContain("does not create a separate Work workspace");
    expect(render().html).toContain("No backup password needed");
    expect(passwords()).toHaveLength(0);
    expect(button("Enable daily backups").props.disabled).toBe(true);
    submit(form()); await flush(); expect(bridge.configureSchedule).not.toHaveBeenCalled();
    const checkbox = render().nodes.find(node => node.type === "input" && node.props.type === "checkbox")!;
    checkbox.props.onChange!({ target: { checked: true } });
    const submitForm = form(); submit(submitForm); submit(submitForm); await flush();
    expect(bridge.configureSchedule).toHaveBeenCalledExactlyOnceWith({ enabled: true, confirmation: "BACK UP THIS WORKSPACE DAILY" });
    expect(render().html).toContain('aria-checked="true"');
    expect(render().html).toContain("Next attempt:");
    expect(render().html).not.toContain(PASSWORD);
    expect([...storage.values()]).not.toContain(PASSWORD);
    expect(bridge.create).not.toHaveBeenCalled();
  });

  it("lets the user turn off daily backups during a transfer without calling manual cancellation", async () => {
    vi.mocked(bridge.state).mockResolvedValueOnce({ busy: true, kind: "backup", schedule: { enabled: true, status: "running" } });
    await ready();
    expect(scheduleSwitch().props.disabled).toBe(false);
    scheduleSwitch().props.onClick!(); await flush();
    expect(bridge.configureSchedule).toHaveBeenCalledExactlyOnceWith({ enabled: false });
    expect(bridge.cancel).not.toHaveBeenCalled();
    expect(render().html).toContain('aria-checked="false"');
  });

  it("does not enable while a restore is pending and clears cancelled schedule passwords", async () => {
    vi.mocked(bridge.state).mockResolvedValueOnce(scheduleOff);
    await ready(); scheduleSwitch().props.onClick!();
    expect(passwords()).toHaveLength(0);
    button("Cancel").props.onClick!();
    scheduleSwitch().props.onClick!(); expect(passwords()).toHaveLength(0);
    button("Cancel").props.onClick!();
    pushBackup({ ...scheduleOff, pendingRestore: true });
    expect(scheduleSwitch().props.disabled).toBe(true);
    scheduleSwitch().props.onClick!(); expect(passwords()).toHaveLength(0);
    expect(bridge.configureSchedule).not.toHaveBeenCalled();
  });

  it("does not replace a newer disabled broadcast with a stale configure response", async () => {
    let resolve!: (state: CompanyBackupState) => void;
    vi.mocked(bridge.state).mockResolvedValueOnce({ busy: false, schedule: { enabled: true, status: "waiting" } });
    vi.mocked(bridge.configureSchedule!).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await ready(); scheduleSwitch().props.onClick!();
    pushBackup(scheduleOff);
    resolve({ busy: false, schedule: { enabled: true, status: "waiting" } }); await flush();
    expect(render().html).toContain('aria-checked="false"');
  });

  it("refreshes the archive list once when a scheduled backup completes in the background", async () => {
    await ready();
    vi.mocked(bridge.list).mockResolvedValueOnce({ backups: [{ ...readyEntry, id: OTHER_ID }], usedBytes: 4096, limits: { ownerQuotaBytes: 1024 ** 3, retainedSnapshots: 5 } });
    const completed: CompanyBackupState = { busy: false, schedule: { enabled: true, status: "waiting", lastBackupAt: Date.now() } };
    pushBackup(completed); await flush();
    expect(render().html).toContain(OTHER_ID);
    expect(bridge.list).toHaveBeenCalledTimes(2);
    pushBackup(completed); await flush();
    expect(bridge.list).toHaveBeenCalledTimes(2);
  });

  it("keeps native dialog keyboard events out of the parent Settings shortcut handler", async () => {
    await ready(); button("Back up this workspace").props.onClick!();
    const dialog = () => render().nodes.find(node => node.type === "dialog")!;
    for (const key of ["Escape", "Tab"]) {
      const stopPropagation = vi.fn();
      dialog().props.onKeyDown!({ key, stopPropagation });
      expect(stopPropagation).toHaveBeenCalledOnce();
    }
    const preventDefault = vi.fn();
    dialog().props.onCancel!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(dialog()).toBeUndefined();
    expect(bridge.create).not.toHaveBeenCalled();

    let finishCreate!: (entry: CompanyBackupEntry) => void;
    vi.mocked(bridge.create).mockImplementation(() => new Promise(resolve => { finishCreate = resolve; }));
    button("Back up this workspace").props.onClick!();
    expect(passwords()).toHaveLength(0); submit(form());
    dialog().props.onCancel!({ preventDefault });
    expect(dialog()).toBeDefined();
    expect(bridge.cancel).not.toHaveBeenCalled();
    finishCreate(readyEntry); await flush();
  });

  it("validates the selected backup before exact REPLACE and saves recovery identity before requesting replacement", async () => {
    await ready();
    expect(button("Replace workspace")).toBeUndefined();
    await validateRestore();
    expect(bridge.prepareRestore).toHaveBeenCalledExactlyOnceWith({ id: READY_ID, password: PASSWORD });
    expect(bridge.restore).not.toHaveBeenCalled();
    expect(render().html).toContain("Validated backup"); expect(render().html).toContain("Fixture archive warning");
    expect(render().html).not.toContain(PASSWORD);
    expect(button("Replace workspace").props.disabled).toBe(true);
    for (const value of ["replace", " REPLACE", "REPLACE "]) {
      change(confirmation(), value); expect(button("Replace workspace").props.disabled).toBe(true);
    }
    vi.mocked(bridge.restore).mockImplementation(async input => {
      expect(storage.get(WORKSPACE_RESTORE_MARKER)).toBe(STAGE_ID);
      expect(input).toEqual({ id: STAGE_ID, confirmation: "REPLACE" });
      return { restoreId: STAGE_ID };
    });
    change(confirmation(), "REPLACE");
    expect(button("Replace workspace").props.disabled).toBe(false);
    const replace = button("Replace workspace"); replace.props.onClick!(); replace.props.onClick!(); await flush();
    expect(bridge.restore).toHaveBeenCalledOnce();
    expect(storage.get(WORKSPACE_RESTORE_MARKER)).toBe(STAGE_ID);
    expect(render().html).toContain("Fully quit OpenMausBot");
    expect(window.location.reload).not.toHaveBeenCalled();
    expect([...storage.values()]).not.toContain(PASSWORD);
  });

  it("does not replace anything after password validation fails", async () => {
    await ready();
    vi.mocked(bridge.prepareRestore).mockRejectedValueOnce(new Error("Wrong password; fixture-private-path signed-token"));
    await validateRestore();
    expect(render().html).toContain('role="alert"');
    expect(render().html).not.toContain("Validated backup"); expect(button("Replace workspace")).toBeUndefined();
    expect(render().html).not.toContain("signed-token");
    expect(bridge.restore).not.toHaveBeenCalled(); expect(storage.has(WORKSPACE_RESTORE_MARKER)).toBe(false);
  });

  it("never starts replacement if its recovery marker cannot be persisted", async () => {
    await ready(); await validateRestore();
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error("Fixture storage is unavailable"); });
    change(confirmation(), "REPLACE"); button("Replace workspace").props.onClick!(); await flush();
    expect(bridge.restore).not.toHaveBeenCalled();
    expect(render().html).toContain('role="alert"');
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("preserves its recovery marker if the replacement response is lost", async () => {
    await ready(); await validateRestore();
    vi.mocked(bridge.restore).mockRejectedValueOnce(new Error("Fixture connection closed"));
    change(confirmation(), "REPLACE"); button("Replace workspace").props.onClick!(); await flush();
    expect(bridge.restore).toHaveBeenCalledOnce();
    expect(storage.get(WORKSPACE_RESTORE_MARKER)).toBe(STAGE_ID);
    expect(render().html).toContain("The replacement could not be confirmed");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("preserves a different pending recovery marker and refuses another replacement", async () => {
    await ready(); await validateRestore();
    storage.set(WORKSPACE_RESTORE_MARKER, OTHER_ID);
    change(confirmation(), "REPLACE"); button("Replace workspace").props.onClick!(); await flush();
    expect(storage.get(WORKSPACE_RESTORE_MARKER)).toBe(OTHER_ID);
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(bridge.restore).not.toHaveBeenCalled();
    expect(render().html).toContain("The replacement could not be confirmed");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("requires typed DELETE and sends only the selected cloud archive ID", async () => {
    vi.mocked(bridge.list).mockResolvedValue({ backups: [readyEntry, { ...readyEntry, id: OTHER_ID }], usedBytes: 8192, limits: { ownerQuotaBytes: 1024 ** 3, retainedSnapshots: 5 } });
    await ready();
    buttons("Delete cloud backup")[1].props.onClick!();
    expect(bridge.delete).not.toHaveBeenCalled(); expect(render().html).toContain("Type DELETE to confirm");
    const confirmDelete = () => render().nodes.filter(node => node.type === "button" && content(node.props.children) === "Delete cloud backup").at(-1)!;
    expect(confirmDelete().props.disabled).toBe(true);
    change(confirmation(), "delete"); expect(confirmDelete().props.disabled).toBe(true);
    change(confirmation(), "DELETE"); expect(confirmDelete().props.disabled).toBe(false);
    confirmDelete().props.onClick!(); await flush();
    expect(bridge.delete).toHaveBeenCalledExactlyOnceWith({ id: OTHER_ID, confirmation: "DELETE" });
    expect(bridge.restore).not.toHaveBeenCalled(); expect(bridge.create).not.toHaveBeenCalled();
  });

  it("offers explicit cancellation while a transfer is busy and disables conflicting mutations", async () => {
    await ready();
    pushBackup({ busy: true, kind: "backup", progress: { phase: "uploading", bytesTransferred: 1024, totalBytes: 4096 } });
    expect(button("Back up this workspace").props.disabled).toBe(true);
    expect(button("Restore this backup").props.disabled).toBe(true);
    expect(button("Delete cloud backup").props.disabled).toBe(true);
    button("Cancel transfer").props.onClick!(); await flush();
    expect(bridge.cancel).toHaveBeenCalledOnce();
    expect(bridge.create).not.toHaveBeenCalled(); expect(bridge.restore).not.toHaveBeenCalled();
  });

  it("keeps newer transfer progress when the initial state snapshot resolves late", async () => {
    let resolveState!: (value: CompanyBackupState) => void;
    vi.mocked(bridge.state).mockImplementation(() => new Promise(resolve => { resolveState = resolve; }));
    render(); effects();
    pushBackup({ busy: true, kind: "backup", progress: { phase: "uploading", bytesTransferred: 1024, totalBytes: 4096 } });
    resolveState({ busy: false }); await flush();
    expect(button("Back up this workspace").props.disabled).toBe(true);
    expect(button("Cancel transfer")).toBeDefined();
  });

  it("does not fetch another company's list after a creation result reaches an unmounted panel", async () => {
    const cleanup = await ready();
    let resolveCreate!: (value: CompanyBackupEntry) => void;
    vi.mocked(bridge.create).mockImplementation(() => new Promise(resolve => { resolveCreate = resolve; }));
    button("Back up this workspace").props.onClick!();
    expect(passwords()).toHaveLength(0); submit(form());
    cleanup(); resolveCreate(readyEntry); await flush();
    expect(bridge.list).toHaveBeenCalledOnce();
    expect(unsubscribeBackup).toHaveBeenCalledOnce();
  });

  it("unsubscribes and ignores late preview results after the identity-scoped panel closes", async () => {
    const cleanup = await ready();
    let resolvePreview!: (value: { id: string; summary: WorkspaceBackupSummary }) => void;
    vi.mocked(bridge.prepareRestore).mockImplementation(() => new Promise(resolve => { resolvePreview = resolve; }));
    button("Restore this backup").props.onClick!(); change(passwords()[0], PASSWORD); submit(form());
    cleanup();
    pushBackup({ busy: false, message: "stale fixture message" });
    resolvePreview({ id: STAGE_ID, summary }); await flush();
    expect(unsubscribeBackup).toHaveBeenCalledOnce();
    expect(render().html).not.toContain("Validated backup"); expect(render().html).not.toContain("stale fixture message");
    expect(bridge.restore).not.toHaveBeenCalled(); expect(storage.has(WORKSPACE_RESTORE_MARKER)).toBe(false);
  });
});
