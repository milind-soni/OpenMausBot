import { useEffect, useMemo, useRef } from "react";
import { animated, useSpring } from "@react-spring/three";
import { RoundedBox } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { Group, MeshStandardMaterial } from "three";

import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";

import type { ClassroomColors } from "./colors";
import { createNameBadgeTexture } from "./textures";

export type Position = [number, number, number];
export interface BotProgress { messageId: string; text: string }

const SKIN_TONE = "#f1c8a0";
const PANTS_COLOR = "#2f3846";
const SHOE_COLOR = "#1e222a";

function memberStatus(member: Bot, active: boolean) {
  if (member.activity === "waiting-on-you") return { label: t("room.classroom.waiting"), tone: "warning" as const };
  if (member.activity === "dead" || member.activity === "no-signal") return { label: t("room.classroom.offline"), tone: "danger" as const };
  if (active || member.busy || member.activity === "working") return { label: t("room.classroom.working"), tone: "success" as const };
  return { label: t("room.classroom.ready"), tone: "idle" as const };
}

function statusColor(tone: "success" | "warning" | "danger" | "idle", colors: ClassroomColors) {
  if (tone === "success") return colors.success;
  if (tone === "warning") return colors.warning;
  if (tone === "danger") return colors.danger;
  return colors.hairline;
}

export function BotComponent({ member, position, active, role, colors }: {
  member: Bot;
  position: Position;
  active: boolean;
  role: "coordinator" | "subagent";
  colors: ClassroomColors;
  progress?: BotProgress | null;
  onFocusAgentChat?: (agentId: string, messageId?: string) => void;
}) {
  const badgeMaterial = useRef<MeshStandardMaterial>(null);
  const headRef = useRef<Group>(null);
  const rightArmGestureRef = useRef<Group>(null);
  const leftArmGestureRef = useRef<Group>(null);
  const torsoRef = useRef<Group>(null);

  const status = memberStatus(member, active);
  const stateColor = statusColor(status.tone, colors);
  const invalidate = useThree((state) => state.invalidate);
  const showStatus = active || status.tone !== "idle";
  const badge = useMemo(
    () => createNameBadgeTexture({
      name: member.name,
      roleLabel: role === "coordinator" ? t("room.classroom.coordinator") : undefined,
      statusLabel: showStatus ? status.label : undefined,
      statusColor: stateColor,
      isCoordinator: role === "coordinator",
      active,
    }),
    [member.name, role, showStatus, status.label, stateColor, active],
  );

  useEffect(() => {
    invalidate();
    return () => {
      badge.texture.dispose();
    };
  }, [invalidate, badge, member.id, member.activity]);
  const botColor = getComputedStyle(document.documentElement).getPropertyValue(`--identity-${member.color}`).trim() || colors.accent;
  const reducedMotion = typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const isStanding = role === "coordinator" || active;

  const { hipY, posZ, hipRotX, kneeRotX, armBaseRotX } = useSpring({
    hipY: isStanding ? 0.70 : 0.55,
    posZ: role === "coordinator" ? 0.72 : active ? 0.48 : 0.62,
    hipRotX: isStanding ? 0 : 1.48,
    kneeRotX: isStanding ? 0 : -1.48,
    armBaseRotX: isStanding ? 0.08 : 0.74,
    immediate: reducedMotion,
    config: { mass: 0.95, tension: 165, friction: 19 },
  });

  useFrame(({ clock }) => {
    const tNow = clock.elapsedTime;
    if (badgeMaterial.current) {
      badgeMaterial.current.emissiveIntensity = active ? 1.8 + (Math.sin(tNow * 4.2) + 1) * 0.6 : 0.15;
    }

    if (reducedMotion) return;

    if (active) {
      if (rightArmGestureRef.current) {
        rightArmGestureRef.current.rotation.x = 0.62 + Math.sin(tNow * 3.6) * 0.18;
        rightArmGestureRef.current.rotation.z = -0.14 + Math.cos(tNow * 2.4) * 0.06;
      }
      if (leftArmGestureRef.current) {
        leftArmGestureRef.current.rotation.x = 0.12 + Math.sin(tNow * 2.2) * 0.06;
        leftArmGestureRef.current.rotation.z = 0.08;
      }
      if (headRef.current) {
        headRef.current.rotation.x = Math.sin(tNow * 2.5) * 0.06;
        headRef.current.rotation.y = Math.sin(tNow * 1.4) * 0.11;
      }
      if (torsoRef.current) {
        torsoRef.current.rotation.x = Math.sin(tNow * 2.1) * 0.025;
      }
    } else {
      if (rightArmGestureRef.current) {
        rightArmGestureRef.current.rotation.x = 0;
        rightArmGestureRef.current.rotation.z = -0.05;
      }
      if (leftArmGestureRef.current) {
        leftArmGestureRef.current.rotation.x = 0;
        leftArmGestureRef.current.rotation.z = 0.05;
      }
      if (headRef.current) {
        headRef.current.rotation.x = 0;
        headRef.current.rotation.y = 0;
      }
      if (torsoRef.current) {
        torsoRef.current.rotation.x = 0;
      }
    }
  });

  const ringZ = role === "coordinator" ? 0.72 : active ? 0.48 : 0.62;

  return (
    <group position={position}>
      <animated.group position-y={hipY} position-z={posZ}>
        {/* Torso + Head + Arms */}
        <group ref={torsoRef}>
          {/* Shirt / Jacket Torso */}
          <RoundedBox castShadow receiveShadow args={[0.48, 0.56, 0.24]} radius={0.03} smoothness={2} position={[0, 0.28, 0]}>
            <meshStandardMaterial color={botColor} roughness={0.62} metalness={0.06} />
          </RoundedBox>

          {/* Jacket Lapel / Collar Accent */}
          <mesh castShadow position={[0, 0.53, -0.01]}>
            <boxGeometry args={[0.24, 0.06, 0.25]} />
            <meshStandardMaterial color={SKIN_TONE} roughness={0.72} metalness={0.02} />
          </mesh>

          {/* Status Core Badge on Chest (front is -Z) */}
          <mesh position={[-0.12, 0.36, -0.125]}>
            <boxGeometry args={[0.09, 0.09, 0.02]} />
            <meshStandardMaterial
              ref={badgeMaterial}
              color={active ? colors.success : stateColor}
              emissive={active ? colors.success : stateColor}
              emissiveIntensity={active ? 1.8 : 0.15}
              roughness={0.3}
              toneMapped={false}
            />
          </mesh>

          {/* Head (pivoted at neck) */}
          <group ref={headRef} position={[0, 0.58, 0]}>
            <RoundedBox castShadow receiveShadow args={[0.38, 0.38, 0.38]} radius={0.08} smoothness={3} position={[0, 0.20, 0]}>
              <meshStandardMaterial color={SKIN_TONE} roughness={0.68} metalness={0.02} />
            </RoundedBox>
            {/* Hair / Cap Top */}
            <RoundedBox castShadow args={[0.40, 0.11, 0.40]} radius={0.04} smoothness={2} position={[0, 0.36, 0.01]}>
              <meshStandardMaterial color={botColor} roughness={0.58} metalness={0.08} />
            </RoundedBox>
            {/* Eyes (facing -Z) */}
            <mesh position={[-0.085, 0.21, -0.192]}>
              <boxGeometry args={[0.055, 0.065, 0.015]} />
              <meshBasicMaterial color="#181a1f" />
            </mesh>
            <mesh position={[0.085, 0.21, -0.192]}>
              <boxGeometry args={[0.055, 0.065, 0.015]} />
              <meshBasicMaterial color="#181a1f" />
            </mesh>
            {/* Subtle Smile */}
            <mesh position={[0, 0.11, -0.192]}>
              <boxGeometry args={[0.10, 0.022, 0.012]} />
              <meshBasicMaterial color="#3b2c25" />
            </mesh>
            {/* Status Pin on Top */}
            <mesh position={[0, 0.45, 0]}>
              <sphereGeometry args={[0.042, 12, 10]} />
              <meshBasicMaterial color={stateColor} toneMapped={false} />
            </mesh>
          </group>

          {/* Left Arm (pivoted at shoulder) */}
          <animated.group position={[-0.33, 0.50, 0]} rotation-x={armBaseRotX}>
            <group ref={leftArmGestureRef}>
              <RoundedBox castShadow receiveShadow args={[0.16, 0.38, 0.17]} radius={0.025} smoothness={2} position={[0, -0.16, 0]}>
                <meshStandardMaterial color={botColor} roughness={0.62} metalness={0.06} />
              </RoundedBox>
              <RoundedBox castShadow receiveShadow args={[0.15, 0.13, 0.16]} radius={0.025} smoothness={2} position={[0, -0.40, 0]}>
                <meshStandardMaterial color={SKIN_TONE} roughness={0.68} metalness={0.02} />
              </RoundedBox>
            </group>
          </animated.group>

          {/* Right Arm (pivoted at shoulder) */}
          <animated.group position={[0.33, 0.50, 0]} rotation-x={armBaseRotX}>
            <group ref={rightArmGestureRef}>
              <RoundedBox castShadow receiveShadow args={[0.16, 0.38, 0.17]} radius={0.025} smoothness={2} position={[0, -0.16, 0]}>
                <meshStandardMaterial color={botColor} roughness={0.62} metalness={0.06} />
              </RoundedBox>
              <RoundedBox castShadow receiveShadow args={[0.15, 0.13, 0.16]} radius={0.025} smoothness={2} position={[0, -0.40, 0]}>
                <meshStandardMaterial color={SKIN_TONE} roughness={0.68} metalness={0.02} />
              </RoundedBox>
            </group>
          </animated.group>
        </group>

        {/* Left Leg (hip pivot + knee pivot) */}
        <animated.group position={[-0.125, 0, 0]} rotation-x={hipRotX}>
          <RoundedBox castShadow receiveShadow args={[0.20, 0.36, 0.21]} radius={0.025} smoothness={2} position={[0, -0.17, 0]}>
            <meshStandardMaterial color={PANTS_COLOR} roughness={0.75} metalness={0.04} />
          </RoundedBox>
          <animated.group position={[0, -0.34, 0]} rotation-x={kneeRotX}>
            <RoundedBox castShadow receiveShadow args={[0.19, 0.28, 0.20]} radius={0.02} smoothness={2} position={[0, -0.13, 0]}>
              <meshStandardMaterial color={PANTS_COLOR} roughness={0.75} metalness={0.04} />
            </RoundedBox>
            <RoundedBox castShadow receiveShadow args={[0.20, 0.10, 0.25]} radius={0.02} smoothness={2} position={[0, -0.31, -0.02]}>
              <meshStandardMaterial color={SHOE_COLOR} roughness={0.65} metalness={0.1} />
            </RoundedBox>
          </animated.group>
        </animated.group>

        {/* Right Leg (hip pivot + knee pivot) */}
        <animated.group position={[0.125, 0, 0]} rotation-x={hipRotX}>
          <RoundedBox castShadow receiveShadow args={[0.20, 0.36, 0.21]} radius={0.025} smoothness={2} position={[0, -0.17, 0]}>
            <meshStandardMaterial color={PANTS_COLOR} roughness={0.75} metalness={0.04} />
          </RoundedBox>
          <animated.group position={[0, -0.34, 0]} rotation-x={kneeRotX}>
            <RoundedBox castShadow receiveShadow args={[0.19, 0.28, 0.20]} radius={0.02} smoothness={2} position={[0, -0.13, 0]}>
              <meshStandardMaterial color={PANTS_COLOR} roughness={0.75} metalness={0.04} />
            </RoundedBox>
            <RoundedBox castShadow receiveShadow args={[0.20, 0.10, 0.25]} radius={0.02} smoothness={2} position={[0, -0.31, -0.02]}>
              <meshStandardMaterial color={SHOE_COLOR} roughness={0.65} metalness={0.1} />
            </RoundedBox>
          </animated.group>
        </animated.group>

        {/* Overhead Name & Status Sprite (pure Three.js, non-interactive) */}
        <sprite
          position={[0, role === "coordinator" ? 1.56 : 1.42, 0]}
          scale={[0.82 * badge.aspect, 0.82, 1]}
          renderOrder={20}
        >
          <spriteMaterial map={badge.texture} transparent depthTest={false} depthWrite={false} toneMapped={false} />
        </sprite>

        {active && (
          <pointLight position={[0, 1.55, 0]} color={colors.success} intensity={1.8} distance={3.8} decay={2} />
        )}
      </animated.group>

      {active && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, ringZ]}>
          <ringGeometry args={[0.46, 0.58, 48]} />
          <meshBasicMaterial color={colors.success} transparent opacity={0.85} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}
