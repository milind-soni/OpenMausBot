import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Box, ExternalLink, Loader2, Monitor, Plus, RefreshCw, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import type { TeamComputer } from "../../shared/team-computer";
import { ConfirmDialog } from "./ConfirmDialog";

const control = "rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40";
const field = "w-full rounded-lg border border-hairline/60 bg-inset px-3 py-2 text-[12px] text-ink outline-none focus:border-accent";
type Inventory = { computers: TeamComputer[]; configured: boolean; problem?: string };

/** This shelf is only an owner control. Its list is read-only; every paid
 * lifecycle action is a deliberate button press, never a render effect. */
export function CanvasComputers({ open, createRequest, drop, sections, onClose, onDropHandled, onChange }: {
  open: boolean;
  createRequest: number;
  drop: { id: string; section: string } | null;
  sections: Array<{ key: string; name: string }>;
  onClose: () => void;
  onDropHandled: () => void;
  onChange: (computers: TeamComputer[]) => void;
}) {
  const { dispatch } = useStore();
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const submittedName = useRef<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const read = useRef<AbortController | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [assignment, setAssignment] = useState<{ computer: TeamComputer; section: string | null } | null>(null);
  const [viewer, setViewer] = useState<{ id: string; url: string } | null>(null);
  const [heldHere, setHeldHere] = useState<string | null>(null);
  const controlLeaseId = useRef(crypto.randomUUID());
  const heldHereRef = useRef<string | null>(null);
  const shelf = useRef<HTMLElement>(null);
  const pointer = useRef<{ id: number; x: number; y: number; moved: boolean; computer: TeamComputer; handle: HTMLElement } | null>(null);
  const highlighted = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState<{ name: string; x: number; y: number; hint: string } | null>(null);
  const clearDrag = useCallback(() => {
    const active = pointer.current;
    pointer.current = null;
    highlighted.current?.removeAttribute("data-computer-dropping");
    highlighted.current = null;
    if (active?.handle.hasPointerCapture(active.id)) active.handle.releasePointerCapture(active.id);
    setDragging(null);
  }, []);
  useEffect(() => {
    if (!open) clearDrag();
    return () => { highlighted.current?.removeAttribute("data-computer-dropping"); };
  }, [open, clearDrag]);
  useEffect(() => { heldHereRef.current = heldHere; }, [heldHere]);
  // The shelf mounts conditionally; a control lease this client took must
  // not outlive it. Best-effort release, mirroring LocalVmWorkspace.
  useEffect(() => () => {
    const held = heldHereRef.current;
    if (!held) return;
    void fetch(`/api/team-computers/${encodeURIComponent(held)}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "release", controlLeaseId: controlLeaseId.current }),
      keepalive: true,
    }).catch(() => {});
  }, []);
  const requestAssignment = useCallback((computer: TeamComputer, section: string | null) => {
    if (pending.current || computer.section === section) return;
    if (computer.section !== null && section !== null) {
      setError(`Unassign ${computer.name} from ${computer.section || "General"} before moving it to another team. Its files and signed-in accounts stay on the computer.`);
      return;
    }
    setError("");
    setAssignment({ computer, section });
  }, []);
  const targetAt = (x: number, y: number) => {
    const canvas = shelf.current?.parentElement?.querySelector("[data-team-canvas]");
    const team = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-team-key]");
    return team && canvas?.contains(team) && sections.some((section) => section.key === team.dataset.teamKey) ? team : null;
  };
  const dragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = pointer.current;
    if (!active || event.pointerId !== active.id) return;
    if (event.buttons === 0) { clearDrag(); return; }
    if (!active.moved && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 5) return;
    active.moved = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const target = targetAt(event.clientX, event.clientY);
    if (highlighted.current !== target) {
      highlighted.current?.removeAttribute("data-computer-dropping");
      target?.setAttribute("data-computer-dropping", "true");
      highlighted.current = target;
    }
    const team = target ? sections.find((section) => section.key === target.dataset.teamKey) : null;
    setDragging({ name: active.computer.name, x: event.clientX, y: event.clientY,
      hint: team ? active.computer.section !== null && active.computer.section !== team.key
        ? "Unassign before moving to another team" : `Assign to ${team.name}` : "Drop onto a team" });
  };
  const dragEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = pointer.current;
    if (!active || active.id !== event.pointerId) return;
    const section = active.moved ? targetAt(event.clientX, event.clientY)?.dataset.teamKey : undefined;
    clearDrag();
    if (section !== undefined) requestAssignment(active.computer, section);
  };

  const refresh = useCallback(async () => {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    setLoading(true);
    try {
      const value: Inventory = await api("/api/team-computers", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      if (controller.signal.aborted || !mounted.current) return;
      setInventory(value);
      setReadError("");
      onChangeRef.current(value.computers);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) setReadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted && mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; read.current?.abort(); };
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = window.setInterval(() => { if (!pending.current && document.visibilityState === "visible") void refresh(); }, 20_000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);
  useEffect(() => { if (createRequest > 0) setCreating(true); }, [createRequest]);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [open]);
  useEffect(() => { if (open && creating) nameInput.current?.focus(); }, [open, creating]);
  useEffect(() => {
    if (!drop) return;
    const computer = inventory?.computers.find((item) => item.id === drop.id);
    if (computer) requestAssignment(computer, drop.section);
    onDropHandled();
  }, [drop, inventory, onDropHandled, requestAssignment]);

  const mutate = async (key: string, action: () => Promise<unknown>, success?: (value: any) => void, failure?: () => void) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(key);
    setError("");
    read.current?.abort();
    try {
      const value = await action();
      if (mounted.current) success?.(value);
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        failure?.();
      }
    } finally {
      pending.current = false;
      if (mounted.current) { setBusy(null); await refresh(); }
    }
  };
  const cancelAssignment = useCallback(() => setAssignment(null), []);
  const post = (id: string, action: string, body = {}) => api(`/api/team-computers/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify(body) });
  const settings = () => { onClose(); dispatch({ type: "toggleAppSettings", open: true, section: "computer" }); };

  return <>
    {open && <aside ref={shelf} aria-label="Team computers" onKeyDown={(event) => { if (event.key === "Escape" && !assignment) { event.stopPropagation(); if (pointer.current) clearDrag(); else onClose(); } }} className="flex w-[300px] max-w-[90vw] shrink-0 flex-col border-l border-hairline/50 bg-panel max-sm:absolute max-sm:inset-y-0 max-sm:right-0 max-sm:z-30 max-sm:shadow-xl">
      <header className="flex items-center gap-2 border-b border-hairline/40 px-4 py-3">
        <Monitor size={16} className="text-ink-secondary" /><h2 className="flex-1 text-[13px] font-semibold">Computers</h2>
        <button aria-label="Refresh computers" className={control} disabled={loading || busy !== null} onClick={() => { setError(""); void refresh(); }}><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></button>
        <button ref={closeButton} aria-label="Close computers" className={control} onClick={onClose}><X size={15} /></button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <p className="text-[12px] leading-relaxed text-ink-secondary">Drag a computer onto a team, or choose its team below. Bots on Auto will use it.</p>
        {(error || readError || inventory?.problem) && <p role="alert" className="rounded-lg bg-danger/10 p-3 text-[12px] text-danger">{error || readError || inventory?.problem}</p>}
        {inventory && !inventory.configured && <div className="rounded-xl border border-hairline/50 p-3 text-[12px]">
          <p className="text-ink-secondary">Connect your Box account before creating a cloud computer.</p>
          <button className={`${control} mt-2 border border-hairline/50`} onClick={settings}>Connect Box</button>
        </div>}
        {creating ? <form className="space-y-3 rounded-xl border border-hairline/60 bg-card p-3" onSubmit={(event) => {
          event.preventDefault();
          const value = submittedName.current ?? name.trim();
          if (!value || !inventory?.configured) return;
          submittedName.current = value;
          void mutate("create", () => api("/api/team-computers", { method: "POST", body: JSON.stringify({ name: value, requestId: requestId.current, acknowledgeCost: true }) }), () => {
            setName(""); setCreating(false); requestId.current = crypto.randomUUID(); submittedName.current = null;
          }, () => {
            submittedName.current = null;
          });
        }}>
          <label className="block text-[12px] font-medium" htmlFor="canvas-computer-name">New Box computer</label>
          <input ref={nameInput} id="canvas-computer-name" className={field} value={name} maxLength={60} placeholder="e.g. Engineering desktop" disabled={busy !== null || submittedName.current !== null} onChange={(event) => setName(event.target.value)} />
          <p className="text-[11px] leading-relaxed text-ink-secondary">Creates a cloud machine in your connected ascii.dev account. Your Box plan and usage charges apply. It stays unassigned until you choose a team.</p>
          <div className="flex justify-end gap-1">
            <button type="button" className={control} disabled={busy !== null} onClick={() => setCreating(false)}>Cancel</button>
            <button type="submit" className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-white disabled:opacity-40" disabled={!inventory?.configured || !name.trim() || busy !== null}>
              {busy === "create" && <Loader2 size={13} className="animate-spin" />}Create Box
            </button>
          </div>
        </form> : <button className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-hairline/60 px-3 py-3 text-[12px] text-ink-secondary hover:bg-control hover:text-ink" disabled={busy !== null} onClick={() => setCreating(true)}><Plus size={14} /> New Box computer</button>}
        {inventory?.computers.map((computer) => {
          const ready = ["idle", "ready", "running"].includes(computer.state);
          const starting = ["init", "provisioning", "provisioned", "cloning", "starting"].includes(computer.state);
          const heldHereNow = heldHere === computer.id;
          const held = computer.held || heldHereNow;
          return <article key={computer.id} data-computer-id={computer.id} className="rounded-xl border border-hairline/60 bg-card p-3">
          <div data-computer-drag-id={computer.id} role="group" tabIndex={-1} aria-label={`Drag ${computer.name} to a team`}
            onPointerDown={(event) => {
              if (pending.current || pointer.current || event.button !== 0 || !event.isPrimary) return;
              event.currentTarget.focus({ preventScroll: true });
              pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, computer, handle: event.currentTarget };
              // This handle has no click action. Capture immediately so the
              // first movement can leave the narrow shelf without losing it.
              event.currentTarget.setPointerCapture(event.pointerId);
            }} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={clearDrag}
            onLostPointerCapture={() => { if (pointer.current) clearDrag(); }}
            className="flex touch-none select-none cursor-grab items-center gap-2.5 rounded-lg py-1 outline-none active:cursor-grabbing">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-control text-ink-secondary"><Box size={18} /></span>
            <span className="min-w-0"><span className="block truncate text-[13px] font-medium">{computer.name}</span><span className="block text-[11px] text-ink-secondary">Box · {busy === computer.id ? "Updating…" : computer.state}</span></span>
          </div>
          {computer.problem && <p className="mt-2 text-[11px] text-danger">{computer.problem}</p>}
          <label className="sr-only" htmlFor={`computer-team-${computer.id}`}>Team for {computer.name}</label>
          <select id={`computer-team-${computer.id}`} className={`${field} mt-3`} disabled={busy !== null} value={computer.section === null ? "unassigned" : `team:${computer.section}`}
            onChange={(event) => requestAssignment(computer, event.target.value === "unassigned" ? null : event.target.value.slice(5))}>
            <option value="unassigned">Not assigned</option>
            {sections.filter((section) => computer.section === null || section.key === computer.section).map((section) => <option key={section.key} value={`team:${section.key}`}>{section.name}</option>)}
          </select>
          {computer.section !== null && <p className="mt-1.5 text-[10px] text-ink-secondary">Unassign to move to another team.</p>}
          <div className="mt-2 flex flex-wrap gap-1">
            {!ready && !starting && <button className={control} title="Starts this Box; your provider's usage charges apply" disabled={busy !== null || held} onClick={() => void mutate(computer.id, () => post(computer.id, "provision", { acknowledgeCost: true }))}>Start / retry</button>}
            {ready && !held && <button className={control} disabled={busy !== null} onClick={() => void mutate(computer.id, () => post(computer.id, "sleep"))}>Sleep</button>}
            {ready && <button className={`${control} flex items-center gap-1.5`} title="Pauses bot control while you use the desktop" disabled={busy !== null} onClick={() => void mutate(computer.id, async () => {
              await post(computer.id, "control", { action: "take", controlLeaseId: controlLeaseId.current });
              setHeldHere(computer.id);
              return post(computer.id, "join");
            }, (value) => {
              // Only expose a deliberate link. A blocked popup must not trigger
              // another lifecycle request, and provider URLs are never iframes.
              if (typeof value.joinUrl === "string" && value.joinUrl.startsWith("https://")) setViewer({ id: computer.id, url: value.joinUrl });
            })}>Open desktop <ExternalLink size={11} /></button>}
            {heldHereNow && <button className={`${control} text-accent`} disabled={busy !== null} onClick={() => void mutate(computer.id, () => post(computer.id, "control", { action: "release", controlLeaseId: controlLeaseId.current }), () => { setHeldHere(null); setViewer(null); })}>Return to bots</button>}
            {computer.held && !heldHereNow && <button className={control} disabled title="Another viewer has paused bot control on this desktop">In use</button>}
          </div>
          {viewer?.id === computer.id && <a href={viewer.url} target="_blank" rel="noopener noreferrer" className="mt-2 block rounded-lg px-3 py-2 text-[12px] text-accent hover:bg-control">Open secure desktop ↗</a>}
        </article>; })}
      </div>
      <footer className="border-t border-hairline/40 p-3"><button className={`${control} w-full text-left`} onClick={settings}>Local VM and other computers…</button></footer>
    </aside>}
    {dragging && createPortal(<div role="status" className="pointer-events-none fixed z-[70] rounded-xl border border-accent/40 bg-card px-4 py-3 text-[12px] text-ink shadow-xl" style={{ left: dragging.x + 14, top: dragging.y + 14 }}>
      <span className="flex items-center gap-2"><Box size={15} />{dragging.name}</span>
      <p className="mt-1 text-[10px] text-ink-secondary">{dragging.hint}</p>
    </div>, document.body)}
    <ConfirmDialog open={assignment !== null} tone="neutral" title={assignment?.section === null ? `Unassign ${assignment?.computer.name ?? "computer"}?` : `Assign ${assignment?.computer.name ?? "computer"} to ${assignment?.section || "General"}?`}
      body={assignment?.section === null
        ? "This removes the team default. It does not stop or delete the machine, its files, or its logins. Review the bots' Auto routing before their next task."
        : "Bots on Auto in this team will share this computer's files and signed-in accounts. Explicit bot computer settings stay unchanged. Only one bot can use the desktop at a time. This does not move the OMB server or enable 24/7 hosting."}
      confirmLabel={assignment?.section === null ? "Unassign computer" : "Assign computer"} onCancel={cancelAssignment} onConfirm={() => {
        const target = assignment;
        if (!target) return;
        setAssignment(null);
        setViewer(null);
        void mutate(target.computer.id, () => api(`/api/team-computers/${encodeURIComponent(target.computer.id)}`, { method: "PATCH", body: JSON.stringify({ section: target.section, acknowledgeSharedAccess: true }) }));
      }} />
  </>;
}
