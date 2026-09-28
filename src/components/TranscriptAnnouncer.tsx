// The one live region a conversation has. Visually hidden; it speaks when a
// reply finishes or an approval is waiting (see lib/transcript-announcer).
import { useEffect, useRef, useState } from "react";
import {
  announcerBaseline,
  nextAnnouncement,
  type AnnouncerMemory,
  type TranscriptSnapshot,
} from "@/lib/transcript-announcer";

export function TranscriptAnnouncer({ threadKey, snapshot }: { threadKey: string; snapshot: TranscriptSnapshot }) {
  const [said, setSaid] = useState({ text: "", count: 0 });
  const memory = useRef<{ key: string; memory: AnnouncerMemory } | null>(null);
  const { busy, reply, approval } = snapshot;
  const replyId = reply?.id;
  const replyName = reply?.name;
  const replyText = reply?.text;
  const approvalId = approval?.id;
  const approvalName = approval?.name;
  useEffect(() => {
    const current: TranscriptSnapshot = {
      busy,
      reply: replyId === undefined ? undefined : { id: replyId, name: replyName ?? "", text: replyText ?? "" },
      approval: approvalId === undefined ? undefined : { id: approvalId, name: approvalName ?? "" },
    };
    // A thread switch starts over: what is already on screen is not news.
    if (memory.current?.key !== threadKey) {
      memory.current = { key: threadKey, memory: announcerBaseline(current) };
      setSaid((previous) => previous.text ? { text: "", count: previous.count } : previous);
      return;
    }
    const next = nextAnnouncement(current, memory.current.memory);
    memory.current.memory = next.memory;
    if (next.text) setSaid((previous) => ({ text: next.text!, count: previous.count + 1 }));
  }, [threadKey, busy, replyId, replyName, replyText, approvalId, approvalName]);
  return (
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="transcript-announcer">
      {/* keyed so the same words twice in a row are still a change to announce */}
      {said.text && <span key={said.count}>{said.text}</span>}
    </p>
  );
}
