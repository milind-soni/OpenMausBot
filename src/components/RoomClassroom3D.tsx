import { useMemo } from "react";
import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot, Group, Message } from "@/state/store";

import type { BotProgress } from "./room-classroom3d/BotComponent";
import { useClassroomColors } from "./room-classroom3d/colors";
import { classroomLayout, CommandCenterScene, isMemberActive, roomCoordinator } from "./room-classroom3d/Scene";

function progressText(message: Message | undefined) {
  return (message?.text ?? message?.tool?.summary ?? message?.tool?.spoken)
    ?.replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_#>]/g, " ")
    .replaceAll("[", " ")
    .replaceAll("]", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function latestProgress(messages: Message[], botId: string): BotProgress | null {
  const message = messages.findLast((candidate) => (
    candidate.role === "bot"
    && candidate.from?.botId === botId
    && Boolean(progressText(candidate))
  ));
  const text = progressText(message);
  return text && message ? { messageId: message.id, text } : null;
}

export function RoomClassroom3D({ group, members, className, onFocusAgentChat }: {
  group: Group;
  members: Bot[];
  className?: string;
  onFocusAgentChat?: (agentId: string, messageId?: string) => void;
}) {
  const colors = useClassroomColors();
  const coordinator = useMemo(() => roomCoordinator(group, members), [group, members]);
  const subAgents = useMemo(
    () => members.filter((member) => member.id !== coordinator?.id),
    [coordinator?.id, members],
  );
  const layout = useMemo(() => classroomLayout(subAgents), [subAgents]);
  const width = Math.max(15, layout.columns * 3.25);
  const depth = Math.max(14, layout.rows * 2.95 + 7.8);
  const progressByBot = useMemo(
    () => new Map(members.map((member) => [member.id, latestProgress(group.messages, member.id)])),
    [group.messages, members],
  );
  const activeMember = members.find((member) => isMemberActive(group, member));
  const working = Boolean(group.working || activeMember);
  const ticker = activeMember
    ? t("room.classroom.tickerWorking", { name: activeMember.name, room: group.name })
    : t("room.classroom.tickerReady", { room: group.name, count: members.length });

  return (
    <section className={cn("relative min-h-0 overflow-hidden bg-app", className)} aria-label={t("room.classroom.region", { name: group.name })}>
      <div className="pointer-events-none absolute inset-x-4 top-3 z-20 overflow-hidden rounded-full border border-hairline/50 bg-panel/80 py-2 backdrop-blur-md">
        <div className={cn("flex min-w-max items-center gap-12 px-5 text-[11px] font-medium text-ink-secondary", working && "room-classroom-ticker")}>
          <span>{ticker}</span>
          {working && <span aria-hidden="true">{ticker}</span>}
        </div>
      </div>
      <Canvas
        shadows="soft"
        frameloop={working ? "always" : "demand"}
        dpr={[1, 1.45]}
        camera={{ position: [width * 0.66, Math.max(7.6, layout.rows * 1.35 + 5), depth * 0.62], fov: 39, near: 0.1, far: 150 }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
      >
        <color attach="background" args={["#dce4ec"]} />
        <fog attach="fog" args={["#dce4ec", 28, 64]} />
        <CommandCenterScene
          group={group}
          members={members}
          coordinator={coordinator}
          subAgents={subAgents}
          colors={colors}
          layout={layout}
          width={width}
          depth={depth}
          progressByBot={progressByBot}
          onFocusAgentChat={onFocusAgentChat}
        />
        <OrbitControls
          makeDefault
          target={[0, 1.35, Math.max(-0.5, (layout.rows - 1) * 0.75)]}
          enableDamping
          dampingFactor={0.08}
          minDistance={5.5}
          maxDistance={depth * 1.8}
          minPolarAngle={0.28}
          maxPolarAngle={Math.PI / 2.08}
        />
      </Canvas>
      <div className="pointer-events-none absolute bottom-3 start-3 rounded-lg border border-hairline/50 bg-panel/80 px-3 py-2 text-[11px] text-ink-secondary backdrop-blur-md">
        {t("room.classroom.hint")}
      </div>
    </section>
  );
}
