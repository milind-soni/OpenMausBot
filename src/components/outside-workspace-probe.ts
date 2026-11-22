import { useEffect, useState } from "react";
import { REVEALABLE_PATH, revealBridge } from "@/lib/reveal-host-path";
import { requestMessageFile, type MessageAttachmentContext } from "./AttachmentPreview";

/** true when the route refuses a copy into this chat's folder; false when it would stream; null when the probe failed for another reason. */
export async function messageFileOutsideWorkspace(
  filePath: string,
  message: MessageAttachmentContext,
  signal: AbortSignal,
): Promise<boolean | null> {
  try {
    const response = await requestMessageFile(filePath, message, signal);
    await response.body?.cancel();
    return false;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "outside_workspace") return true;
    return null;
  }
}

export function useMessageFileOutsideWorkspace(filePath: string, message?: MessageAttachmentContext): boolean | null {
  const [outside, setOutside] = useState<boolean | null>(null);
  useEffect(() => {
    const reveal = revealBridge();
    if (!message || !reveal || !REVEALABLE_PATH.test(filePath)) {
      setOutside(null);
      return;
    }
    const controller = new AbortController();
    setOutside(null);
    void messageFileOutsideWorkspace(filePath, message, controller.signal).then((value) => {
      if (!controller.signal.aborted) setOutside(value === null ? false : value);
    });
    return () => controller.abort();
  }, [filePath, message?.messageId, message?.threadId]);
  return outside;
}
