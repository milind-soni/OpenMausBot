"use client";
import { errorText } from "@/lib/error-text";
import { useRef, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { Loader2, Paperclip } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { uploadLocalFile } from "@/lib/client-api";
import { validateAttachmentFiles } from "@/lib/dropped-content";
import { useWorkspace } from "./workspace-context";
import { useFileDrop } from "./use-file-drop";

/**
 * Drop zone for the whole issue: files dropped (or pasted) anywhere on it are attached to the issue; a dropped link
 * goes to `onLink`. The comment composer has its own drop zone for comment attachments.
 */
export function IssueFileUpload({ projectId, taskId, sessionToken, disabled, onLink, onError, className, children }: { projectId: Id<"projects">; taskId: Id<"tasks">; sessionToken: string; disabled: boolean; onLink: (url: string) => void; onError?: (message: string) => void; className?: string; children: ReactNode }) {
  const workspace = useWorkspace();
  const attach = useMutation(api.tasks.addAsset);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const report = (message: string) => { if (onError) onError(message); else setError(message); };
  const upload = async (files: File[]) => {
    if (disabled || inFlight.current || !files.length) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      validateAttachmentFiles(files);
      for (const file of files) {
        const saved = await uploadLocalFile(`/api/local-chat/files?teamId=${workspace._id}&projectId=${projectId}`, sessionToken, file);
        await attach({ projectId, taskId, sessionToken, name: saved.name, type: /^image\/(png|jpeg|gif|webp)$/.test(saved.contentType) ? "image" : "file", localFileId: saved.id, contentType: saved.contentType, size: saved.size });
      }
    } catch (error) { report(errorText(error, "Could not attach file")); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const drop = useFileDrop({ disabled: disabled || busy, onFiles: files => void upload(files), onLink });
  return <div className={`issue-file-drop ${drop.dragging ? "drop-active" : ""} ${className || ""}`} {...drop.handlers} onPaste={event => {
    const target = event.target as HTMLElement;
    if (target.closest(".issue-comment-composer")) return;
    if (event.clipboardData.files.length && !disabled && !busy) { event.preventDefault(); void upload(Array.from(event.clipboardData.files)); }
  }}>
    {children}
    {drop.dragging && <div className="issue-drop-overlay" aria-hidden="true"><Paperclip size={16} />Drop to attach</div>}
    {busy && <div className="issue-upload-status" role="status"><Loader2 className="spin" size={14} />Uploading</div>}
    {error && <p className="notice danger issue-upload-error" role="alert">{error}</p>}
  </div>;
}
