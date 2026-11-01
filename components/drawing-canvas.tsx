"use client";
import { errorText } from "@/lib/error-text";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { Excalidraw, CaptureUpdateAction, MainMenu, newElementWith, reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, BinaryFileData, BinaryFiles, AppState } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import "@excalidraw/excalidraw/index.css";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useWorkspace } from "./workspace-context";
import { ContentSkeleton } from "./content-skeleton";
import { useWorkspaceOnline } from "./workspace-connection";
import { UserAvatar, avatarTone, memberName } from "./user-avatar";
import { Dialog } from "./dialog";
import { Trash2 } from "lucide-react";

function imageBlob(file: BinaryFileData) {
  const separator = file.dataURL.indexOf(",");
  if (!file.dataURL.startsWith("data:") || separator < 0) throw new Error("Invalid drawing image");
  const payload = file.dataURL.slice(separator + 1);
  return new Blob(file.dataURL.slice(0, separator).endsWith(";base64")
    ? [Uint8Array.from(atob(payload), character => character.charCodeAt(0))]
    : [decodeURIComponent(payload)], { type: file.mimeType });
}

export default function DrawingCanvas({ sessionToken, user, canvasId, readOnly = false, name }: { sessionToken: string; user: { _id: string; name: string }; canvasId?: Id<"canvases">; readOnly?: boolean; name?: string }) {
  const workspace = useWorkspace();
  const online = useWorkspaceOnline();
  const args = { sessionToken, teamId: workspace._id, canvasId };
  const scene = useQuery(api.draw.scene, args);
  const presence = useQuery(api.draw.presence, args) as Doc<"drawingPresence">[] | undefined;
  const storedFiles = useQuery(api.draw.files, args) as { fileId: string; mimeType: string; url: string | null }[] | undefined;
  const update = useMutation(api.draw.updateElements);
  const setPresence = useMutation(api.draw.setPresence);
  const uploadUrl = useMutation(api.draw.uploadUrl);
  const saveFile = useMutation(api.draw.saveFile);
  const members = useQuery(api.workspaces.members, { sessionToken, teamId: workspace._id });
  const [canvas, setCanvas] = useState<ExcalidrawImperativeAPI | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [notice, setNotice] = useState("");
  const [unavailableFiles, setUnavailableFiles] = useState<string[]>([]);
  const [clock, setClock] = useState(Date.now());
  const [resetting, setResetting] = useState(false);
  const remote = useRef(false);
  const ready = useRef(false);
  const knownVersions = useRef(new Map<string, string>());
  const pending = useRef(new Map<string, OrderedExcalidrawElement>());
  const busy = useRef(false);
  const retryAt = useRef(0);
  const failures = useRef(0);
  const knownFiles = useRef(new Set<string>());
  const lastPointer = useRef(0);
  const currentPointer = useRef({ x: 0, y: 0, button: "up" as "up" | "down" });
  useEffect(() => {
    if (!canvas || !scene || !initialized) return;
    const incoming = restoreElements(scene.map(data => JSON.parse(data)), null);
    const current = canvas.getSceneElementsIncludingDeleted();
    const localElements = new Map(current.map(element => [element.id, element]));
    const updates = incoming.filter(element => {
      const local = localElements.get(element.id);
      const newer = !local || element.version > local.version || (element.version === local.version && element.versionNonce < local.versionNonce);
      if (newer || (local?.version === element.version && local.versionNonce === element.versionNonce)) knownVersions.current.set(element.id, `${element.version}:${element.versionNonce}`);
      return newer;
    });
    // Ignore our own echoes so async image insertion keeps its live element reference.
    if (updates.length) {
      const elements = reconcileElements(current, updates as RemoteExcalidrawElement[], canvas.getAppState());
      remote.current = true;
      canvas.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
      remote.current = false;
    }
    ready.current = true;
  }, [canvas, scene, initialized]);
  useEffect(() => {
    const flush = async () => {
      if (busy.current || !pending.current.size || !ready.current || Date.now() < retryAt.current) return;
      busy.current = true;
      const batch = [...pending.current.values()].slice(0, 100); batch.forEach(e => pending.current.delete(e.id));
      try { await update({ ...args, elements: batch.map(e => JSON.stringify(e)) }); failures.current = 0; setNotice(""); }
      catch (error) { batch.forEach(e => { if (!pending.current.has(e.id)) pending.current.set(e.id, e); }); retryAt.current = Date.now() + Math.min(30000, 1000 * 2 ** failures.current++); setNotice(errorText(error, "Could not save drawing")); }
      finally { busy.current = false; }
    };
    const timer = setInterval(flush, 200);
    const tick = setInterval(() => { setClock(Date.now()); void setPresence({ ...args, ...currentPointer.current }).catch(() => {}); }, 10000);
    void setPresence({ ...args, ...currentPointer.current }).catch(() => {});
    const protect = (event: BeforeUnloadEvent) => { if (pending.current.size || busy.current) event.preventDefault(); };
    window.addEventListener("beforeunload", protect);
    return () => {
      clearInterval(timer); clearInterval(tick); window.removeEventListener("beforeunload", protect);
      const remaining = [...pending.current.values()];
      for (let offset = 0; offset < remaining.length; offset += 100) void update({ ...args, elements: remaining.slice(offset, offset + 100).map(e => JSON.stringify(e)) }).catch(() => {});
      void setPresence({ ...args, ...currentPointer.current, leave: true }).catch(() => {});
    };
  }, [sessionToken, workspace._id, canvasId, update, setPresence]);
  // Who else has the canvas open (seen in the last 30 seconds), as workspace members so avatars match the rest of the app.
  const here = (online ? presence ?? [] : []).filter(member => member.userId !== user._id && member.updatedAt > clock - 30000)
    .map(member => ({ ...member, person: members?.find(item => item.userId === member.userId) ?? { name: member.name } }));
  const hereKey = here.map(member => `${member.userId}:${member.x}:${member.y}:${member.button}`).join("|");
  useEffect(() => {
    if (!canvas) return;
    const collaborators: AppState["collaborators"] = new Map();
    for (const member of here) {
      const tone = avatarTone(member.person);
      collaborators.set(String(member.userId) as Parameters<typeof collaborators.set>[0], { username: memberName(member.person),
        // (0, 0) is the placeholder sent before someone moves their pointer; show them without a cursor until then.
        pointer: member.x === 0 && member.y === 0 ? undefined : { x: member.x, y: member.y, tool: "pointer" }, button: member.button as "up" | "down", color: { background: tone, stroke: tone } });
    }
    canvas.updateScene({ collaborators });
    // `hereKey` captures every field of `here` the scene uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, hereKey, members]);
  // Help without Excalidraw's links (draw.css hides them): take them out of the tab order and focus the dialog itself,
  // which Excalidraw would otherwise try to do through the (hidden) second link, leaving Escape with nowhere to go.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const help = document.querySelector<HTMLElement>(".excalidraw-modal-container .HelpDialog");
      if (!help || help.dataset.originReady) return;
      help.dataset.originReady = "true";
      help.querySelectorAll<HTMLElement>(".HelpDialog__header a").forEach(link => link.setAttribute("tabindex", "-1"));
      const content = help.closest(".Modal")?.querySelector<HTMLElement>(".Modal__content");
      if (content && !content.contains(document.activeElement)) content.focus({ preventScroll: true });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!canvas || !storedFiles) return;
    for (const file of storedFiles) {
      if (!file.url || canvas.getFiles()[file.fileId]) continue;
      knownFiles.current.add(file.fileId);
      void fetch(file.url).then(r => { if (!r.ok) throw new Error("Image unavailable"); return r.blob(); }).then(blob => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = reject; reader.readAsDataURL(blob); })).then(dataURL => {
        canvas.addFiles([{ id: file.fileId, dataURL, mimeType: file.mimeType, created: Date.now() } as BinaryFileData]);
        setUnavailableFiles(current => current.filter(id => id !== file.fileId));
      }).catch(() => setUnavailableFiles(current => current.includes(file.fileId) ? current : [...current, file.fileId]));
    }
  }, [canvas, storedFiles]);
  const onChange = (elements: readonly OrderedExcalidrawElement[], _state: AppState, files: BinaryFiles) => {
    if (!ready.current && !_state.isLoading) { ready.current = true; setInitialized(true); return; }
    if (!ready.current || remote.current || readOnly || workspace.role === "viewer") return;
    for (const element of elements) {
      if (element.type === "image" && !element.fileId) continue;
      const version = `${element.version}:${element.versionNonce}`;
      if (knownVersions.current.get(element.id) !== version) { pending.current.set(element.id, element); knownVersions.current.set(element.id, version); }
    }
    for (const file of Object.values(files)) {
      if (knownFiles.current.has(file.id)) continue;
      knownFiles.current.add(file.id);
      void (async () => { try { const blob = imageBlob(file); const url = await uploadUrl(args); const response = await fetch(url, { method: "POST", headers: { "Content-Type": file.mimeType }, body: blob }); if (!response.ok) throw new Error("Image upload failed"); const { storageId } = await response.json() as { storageId: Id<"_storage"> }; await saveFile({ ...args, fileId: file.id, storageId, mimeType: file.mimeType }); } catch (error) { knownFiles.current.delete(file.id); setNotice(errorText(error, "Image upload failed")); } })();
    }
  };
  const canEdit = !readOnly && workspace.role !== "viewer";
  // Excalidraw's own "clear canvas": every element deleted (a new version each, so the deletion syncs to everyone).
  const resetCanvas = () => {
    if (!canvas) return;
    const elements = canvas.getSceneElementsIncludingDeleted().map(element => element.isDeleted ? element : newElementWith(element, { isDeleted: true }));
    canvas.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  };
  if (scene === undefined) return <ContentSkeleton kind="canvas" label="Loading drawing" />;
  const presenceAvatars = here.length ? <div className="draw-presence" aria-label={`Also here: ${here.map(member => memberName(member.person)).join(", ")}`}>
    {here.slice(0, 4).map(member => <span key={member.userId} title={memberName(member.person)}><UserAvatar user={member.person} size="small" /></span>)}
    {here.length > 4 && <span className="draw-presence-more">+{here.length - 4}</span>}
  </div> : null;
  // Ctrl/Cmd+Delete is Excalidraw's "clear canvas" shortcut, with its own confirm: ask in Origin's instead.
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!(event.ctrlKey || event.metaKey) || !["Delete", "Backspace"].includes(event.key) || target.closest("input, textarea, [contenteditable]")) return;
    event.preventDefault();
    event.stopPropagation();
    if (canEdit) setResetting(true);
  };
  return <div className="drawing-canvas" onKeyDownCapture={onKeyDownCapture}>
    {(notice || unavailableFiles.length > 0) && <div className="drawing-status error" role="alert">{notice || "A drawing image could not be loaded"}</div>}
    {/* Phones: Excalidraw's top row is the toolbar, so the avatars sit in the middle of its bottom bar. */}
    {presenceAvatars && <div className="draw-presence-floating">{presenceAvatars}</div>}
    <Excalidraw excalidrawAPI={setCanvas} name={name || `${workspace.name} - Draw`} theme="dark" isCollaborating viewModeEnabled={readOnly || workspace.role === "viewer"} validateEmbeddable={false}
      initialData={{ elements: scene.map(data => JSON.parse(data)), appState: { viewBackgroundColor: "#ffffff", currentItemStrokeColor: "#1e1e1e" }, scrollToContent: true }}
      onChange={onChange}
      onPointerUpdate={({ pointer, button }) => { currentPointer.current = { x: pointer.x, y: pointer.y, button }; if (Date.now() - lastPointer.current < 200) return; lastPointer.current = Date.now(); void setPresence({ ...args, ...currentPointer.current }).catch(() => {}); }}
      UIOptions={{ canvasActions: { loadScene: false, export: false, saveToActiveFile: false, clearCanvas: false, toggleTheme: false, changeViewBackgroundColor: false } }}
      renderTopRightUI={isMobile => isMobile ? null : presenceAvatars}>
      {/* Excalidraw's menu without its links and socials, and without Open (it would replace the canvas for everyone) or
          Save to file (nothing here opens one). Help keeps only the shortcuts and the library is hidden (draw.css). */}
      <MainMenu>
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        {canEdit && <>
          <MainMenu.Separator />
          <MainMenu.Item icon={<Trash2 size={16} strokeWidth={1.75} />} onSelect={() => setResetting(true)}>Reset the canvas</MainMenu.Item>
        </>}
      </MainMenu>
    </Excalidraw>
    {resetting && <Dialog title="Reset the canvas" className="confirm-dialog" onClose={() => setResetting(false)}>
      <div className="dialog-body">
        <p className="confirm-text">Clears the drawing for everyone.</p>
        <div className="dialog-actions">
          <button type="button" className="ghost-button compact" onClick={() => setResetting(false)}>Cancel</button>
          <button type="button" className="primary-button danger compact" autoFocus onClick={() => { setResetting(false); resetCanvas(); }}>Reset</button>
        </div>
      </div>
    </Dialog>}
  </div>;
}
