import { useEffect, useMemo, useState } from "react";
import type { BoardItem, BoardListResponse } from "../../../shared/board";
import { listenLiveFrames } from "@/lib/live-events";
import { workStatus, type WorkStatus } from "@/lib/room-work";
import { api } from "@/state/api";
import type { Bot } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";

interface RoomWork {
  groupId: string | null;
  byThread: ReadonlyMap<string, BoardItem>;
  you: string | null;
}

const NONE: RoomWork = { groupId: null, byThread: new Map(), you: null };

/** The work items of one room on a Team Cloud (GET /api/board?groupId=), kept current by `board.item` frames and read
 * again after missed ones. Anywhere else there are none, and nothing is asked. */
export function useRoomWork(groupId: string | null | undefined): RoomWork {
  const team = useStoreSelector((state) => Boolean(state.config?.team));
  const [work, setWork] = useState<RoomWork>(NONE);
  useEffect(() => {
    if (!team || !groupId) return;
    let alive = true;
    const load = () => void api<BoardListResponse>(`/api/board?groupId=${encodeURIComponent(groupId)}`)
      .then((answer) => { if (alive) setWork({ groupId, byThread: new Map(answer.items.map((item) => [item.threadId, item])), you: answer.you ?? null }); })
      .catch(() => {});
    load();
    const stop = listenLiveFrames({
      onFrame: (frame) => {
        if (frame.kind !== "board.item" || frame.groupId !== groupId) return;
        setWork((current) => {
          const byThread = new Map(current.groupId === groupId ? current.byThread : []);
          if (frame.item) byThread.set(frame.threadId, frame.item);
          else byThread.delete(frame.threadId);
          return { groupId, byThread, you: current.groupId === groupId ? current.you : null };
        });
      },
      onMissedFrames: load,
    });
    return () => { alive = false; stop(); };
  }, [team, groupId]);
  return team && work.groupId === groupId ? work : NONE;
}

/** Each work thread's status in this room, by thread. */
export function useRoomWorkStatuses(groupId: string | null | undefined, bots: readonly Pick<Bot, "id" | "name">[]): ReadonlyMap<string, WorkStatus> {
  const { byThread, you } = useRoomWork(groupId);
  return useMemo(() => {
    const name = (botId: string) => bots.find((bot) => bot.id === botId)?.name;
    const statuses = new Map<string, WorkStatus>();
    for (const [threadId, item] of byThread) {
      const status = workStatus(item, you, name);
      if (status) statuses.set(threadId, status);
    }
    return statuses;
  }, [byThread, you, bots]);
}
