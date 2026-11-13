import { PAGE_SHARE_NOTICE } from "@/lib/previewSharing";
import { useEffect, useRef, useState } from "react";
import { Camera, RefreshCw, Send, X } from "lucide-react";
import { useStore } from "@/state/store";
import { useDialogFocus } from "@/lib/dialogFocus";

export interface SharePreviewTarget {
  kind: "bot" | "group";
  id: string;
  name: string;
}

export interface SharePreviewRequest {
  scope: "current" | "all";
  area: "visible" | "full";
  target: SharePreviewTarget;
  note: string;
}

export interface SharePreviewModalProps {
  open: boolean;
  linkOnly?: boolean;
  onClose: () => void;
  currentSizeLabel: string;
  currentDimensionsLabel: string;
  selectedSizesCount: number;
  defaultScope?: "current" | "all";
  onSubmit: (request: SharePreviewRequest) => Promise<void>;
  triggerRef?: React.RefObject<HTMLElement | null> | HTMLElement | null;
}

export function SharePreviewModal({
  open,
  linkOnly = false,
  onClose,
  currentSizeLabel,
  currentDimensionsLabel,
  selectedSizesCount,
  defaultScope = "current",
  onSubmit,
  triggerRef,
}: SharePreviewModalProps) {
  const { state } = useStore();
  const visibleBots = state.bots.filter((b) => !b.hidden);
  const visibleGroups = state.groups.filter((g) => !g.dm);

  const [scope, setScope] = useState<"current" | "all">(defaultScope);
  const [area, setArea] = useState<"visible" | "full">("visible");
  const [selectedTargetKey, setSelectedTargetKey] = useState<string>("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const formRef = useRef<HTMLFormElement | null>(null);
  const targetSelectRef = useRef<HTMLSelectElement | null>(null);

  // Focus entry, focus trap, Escape dismissal, and focus return on close
  useDialogFocus({
    open,
    containerRef: formRef,
    entryFocusRef: targetSelectRef,
    triggerRef,
    onClose,
  });

  useEffect(() => {
    if (!open) return;
    setScope(defaultScope);
    setError("");
    setSending(false);

    const activeGroup = visibleGroups.find((g) => g.id === state.selectedId);
    if (activeGroup) {
      setSelectedTargetKey(`group:${activeGroup.id}`);
      return;
    }
    const activeBot = visibleBots.find((b) => b.id === state.selectedId) ?? visibleBots[0];
    if (activeBot) {
      setSelectedTargetKey(`bot:${activeBot.id}`);
      return;
    }
    if (visibleGroups[0]) {
      setSelectedTargetKey(`group:${visibleGroups[0].id}`);
    }
  }, [defaultScope, open, state.selectedId, visibleBots.length, visibleGroups.length]);

  if (!open) return null;

  const resolveTarget = (): SharePreviewTarget | null => {
    const [kind, id] = selectedTargetKey.split(":");
    if (kind === "group") {
      const group = visibleGroups.find((g) => g.id === id);
      return group ? { kind: "group", id: group.id, name: group.name } : null;
    }
    const bot = visibleBots.find((b) => b.id === id);
    return bot ? { kind: "bot", id: bot.id, name: bot.name } : null;
  };

  const target = resolveTarget();

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target || sending) return;
    setSending(true);
    setError("");
    try {
      await onSubmit({
        scope,
        area,
        target,
        note: note.trim(),
      });
      setNote("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to capture and send preview.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-preview-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <form
        ref={formRef}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void handleSend(e)}
        className="w-full max-w-[440px] rounded-2xl border border-hairline bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Camera className="h-4 w-4" />
            </div>
            <h2 id="share-preview-title" className="text-[15px] font-semibold text-ink">
              Share preview to chat
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 pt-2">
          {linkOnly && (
            <p role="status" className="rounded-lg border border-hairline bg-inset p-3 text-[12px] text-ink-secondary">
              {PAGE_SHARE_NOTICE}
            </p>
          )}
          {/* What to capture */}
          {!linkOnly && (
            <fieldset>
              <legend className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">
                What to capture
              </legend>
              <div className="space-y-1.5">
                <label
                  className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-[12.5px] transition-colors ${
                    scope === "current"
                      ? "border-accent/50 bg-accent/10 text-ink"
                      : "border-hairline/60 bg-inset text-ink-secondary hover:border-hairline"
                  }`}
                >
                  <input
                    type="radio"
                    name="share-scope"
                    checked={scope === "current"}
                    onChange={() => setScope("current")}
                    className="accent-accent"
                  />
                  <span>
                    Current size (<span className="font-medium text-ink">{currentSizeLabel}</span> —{" "}
                    <span className="font-mono text-[11.5px]">{currentDimensionsLabel}</span>)
                  </span>
                </label>

                {selectedSizesCount > 1 && (
                  <label
                    className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-[12.5px] transition-colors ${
                      scope === "all"
                        ? "border-accent/50 bg-accent/10 text-ink"
                        : "border-hairline/60 bg-inset text-ink-secondary hover:border-hairline"
                    }`}
                  >
                    <input
                      type="radio"
                      name="share-scope"
                      checked={scope === "all"}
                      onChange={() => setScope("all")}
                      className="accent-accent"
                    />
                    <span>
                      All selected sizes (
                      <span className="font-medium text-ink">{selectedSizesCount} screenshots</span>)
                    </span>
                  </label>
                )}
              </div>
            </fieldset>
          )}

          {/* Capture area */}
          {!linkOnly && (
            <fieldset>
              <legend className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">
                Capture area
              </legend>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setArea("visible")}
                  className={`h-8 rounded-lg border text-[12px] font-medium transition-colors ${
                    area === "visible"
                      ? "border-accent/50 bg-accent/15 text-ink"
                      : "border-hairline/60 bg-inset text-ink-secondary hover:text-ink"
                  }`}
                >
                  Visible area
                </button>
                <button
                  type="button"
                  onClick={() => setArea("full")}
                  className={`h-8 rounded-lg border text-[12px] font-medium transition-colors ${
                    area === "full"
                      ? "border-accent/50 bg-accent/15 text-ink"
                      : "border-hairline/60 bg-inset text-ink-secondary hover:text-ink"
                  }`}
                >
                  Full page
                </button>
              </div>
            </fieldset>
          )}

          {/* Send to */}
          <div>
            <label
              htmlFor="share-preview-target"
              className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary"
            >
              Send to
            </label>
            <select
              ref={targetSelectRef}
              id="share-preview-target"
              value={selectedTargetKey}
              onChange={(e) => setSelectedTargetKey(e.target.value)}
              className="h-9 w-full rounded-xl border border-hairline/70 bg-inset px-3 text-[12.5px] text-ink focus:border-accent/60 focus:outline-none"
            >
              {visibleBots.length > 0 && (
                <optgroup label="Bots">
                  {visibleBots.map((bot) => (
                    <option key={bot.id} value={`bot:${bot.id}`}>
                      {bot.name} {bot.title ? `— ${bot.title}` : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              {visibleGroups.length > 0 && (
                <optgroup label="Rooms">
                  {visibleGroups.map((group) => (
                    <option key={group.id} value={`group:${group.id}`}>
                      #{group.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          {/* Optional note */}
          <div>
            <label
              htmlFor="share-preview-note"
              className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary"
            >
              Note (optional)
            </label>
            <textarea
              id="share-preview-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note for the bot or room (e.g., 'Check the header spacing on tablet')…"
              className="w-full resize-none rounded-xl border border-hairline/70 bg-inset p-2.5 text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-accent/60 focus:outline-none"
            />
          </div>

          {error && (
            <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-lg border border-hairline bg-raised px-3.5 text-[12px] font-medium text-ink transition-colors hover:bg-raised-hover"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!target || sending}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-4 text-[12px] font-medium text-white transition-colors hover:brightness-110 disabled:opacity-50"
          >
            {sending ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                Send to {target?.name ?? "chat"}
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
