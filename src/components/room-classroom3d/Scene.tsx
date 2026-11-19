import { useEffect, useMemo } from "react";
import { animated, useSpring } from "@react-spring/three";
import { RoundedBox } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import type { Texture } from "three";

import type { Bot, Group } from "@/state/store";

import { BotComponent, type BotProgress, type Position } from "./BotComponent";
import type { ClassroomColors } from "./colors";
import { LightSetup } from "./LightSetup";
import { createFloorPlankTexture, createWoodTexture } from "./textures";

export interface ClassroomLayout {
  columns: number;
  rows: number;
  positions: Map<string, Position>;
}

export function classroomLayout(members: Bot[]): ClassroomLayout {
  const columns = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(members.length))));
  const rows = Math.max(1, Math.ceil(members.length / columns));
  const xOffset = (columns - 1) * 1.45;
  return {
    columns,
    rows,
    positions: new Map(members.map((member, index) => [member.id, [
      (index % columns) * 2.9 - xOffset,
      0,
      Math.floor(index / columns) * 2.8 - 1.3,
    ] as Position])),
  };
}

export function isMemberActive(group: Group, member: Bot) {
  return member.id === group.busyBotId || member.busy || member.activity === "working";
}

export function roomCoordinator(group: Group, members: Bot[]) {
  const responderId = group.defaultResponder.kind === "member"
    ? group.defaultResponder.botId
    : group.defaultResponder.kind === "auto"
      ? group.defaultResponder.fallbackBotId
      : undefined;
  return members.find((member) => member.id === responderId)
    ?? members.find((member) => member.chiefOfStaff)
    ?? members[0];
}

const METAL_DARK = "#2c313a";
const WALL_COLOR = "#ebe6dc";
const BASEBOARD_COLOR = "#6f4f37";
const BLACKBOARD_SURFACE = "#1c3b2b";
const BLACKBOARD_FRAME = "#6b4428";
const WINDOW_FRAME = "#f3efe7";

function Desk({ active, woodTexture }: { active: boolean; woodTexture: Texture }) {
  const reducedMotion = typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const { chairOffsetZ } = useSpring({
    chairOffsetZ: active ? 0.36 : 0,
    immediate: reducedMotion,
    config: { mass: 0.95, tension: 165, friction: 19 },
  });

  return (
    <group>
      {/* Wooden Tabletop (top at y = 0.76, bottom at y = 0.71) */}
      <RoundedBox castShadow receiveShadow args={[1.95, 0.05, 0.92]} radius={0.015} smoothness={2} position={[0, 0.735, -0.25]}>
        <meshStandardMaterial map={woodTexture} roughness={0.55} metalness={0.04} />
      </RoundedBox>

      {/* Under-desk Metal Apron Frame */}
      <mesh castShadow receiveShadow position={[0, 0.69, -0.25]}>
        <boxGeometry args={[1.76, 0.04, 0.78]} />
        <meshStandardMaterial color={METAL_DARK} roughness={0.55} metalness={0.65} />
      </mesh>

      {/* Under-desk Storage Shelf (recessed toward front of desk for knee clearance) */}
      <mesh castShadow receiveShadow position={[0, 0.54, -0.46]}>
        <boxGeometry args={[1.68, 0.025, 0.40]} />
        <meshStandardMaterial color={METAL_DARK} roughness={0.6} metalness={0.55} />
      </mesh>

      {/* 4 Dark Matte Metal Desk Legs (y = 0.00 to 0.71) */}
      {[-0.86, 0.86].flatMap((x) => [-0.62, 0.12].map((z) => (
        <mesh castShadow receiveShadow key={`${x}:${z}`} position={[x, 0.355, z]}>
          <boxGeometry args={[0.055, 0.71, 0.055]} />
          <meshStandardMaterial color={METAL_DARK} roughness={0.5} metalness={0.7} />
        </mesh>
      )))}

      {/* Minimal Desk Prop: Closed Notebook & Pencil */}
      <group position={[-0.44, 0.76, -0.22]} rotation={[0, 0.14, 0]}>
        <RoundedBox castShadow receiveShadow args={[0.30, 0.024, 0.40]} radius={0.006} smoothness={2} position={[0, 0.012, 0]}>
          <meshStandardMaterial color="#34495e" roughness={0.75} metalness={0.05} />
        </RoundedBox>
        <mesh castShadow position={[0.20, 0.008, 0.02]} rotation={[Math.PI / 2, 0, 0.08]}>
          <cylinderGeometry args={[0.007, 0.007, 0.22, 8]} />
          <meshStandardMaterial color="#e0a938" roughness={0.5} metalness={0.1} />
        </mesh>
      </group>

      {/* Animated Chair (slides back when student stands) */}
      <animated.group position-z={chairOffsetZ}>
        {/* Wooden Seat (top at y = 0.45) */}
        <RoundedBox castShadow receiveShadow args={[0.54, 0.045, 0.48]} radius={0.015} smoothness={2} position={[0, 0.4275, 0.62]}>
          <meshStandardMaterial map={woodTexture} roughness={0.55} metalness={0.04} />
        </RoundedBox>

        {/* Wooden Backrest */}
        <RoundedBox castShadow receiveShadow args={[0.54, 0.38, 0.04]} radius={0.012} smoothness={2} position={[0, 0.73, 0.85]} rotation={[-0.08, 0, 0]}>
          <meshStandardMaterial map={woodTexture} roughness={0.55} metalness={0.04} />
        </RoundedBox>

        {/* Metal Backrest Uprights */}
        {[-0.20, 0.20].map((x) => (
          <mesh castShadow key={x} position={[x, 0.56, 0.84]} rotation={[-0.08, 0, 0]}>
            <boxGeometry args={[0.03, 0.32, 0.03]} />
            <meshStandardMaterial color={METAL_DARK} roughness={0.5} metalness={0.7} />
          </mesh>
        ))}

        {/* 4 Metal Chair Legs (y = 0.00 to 0.41) */}
        {[-0.22, 0.22].flatMap((x) => [0.42, 0.82].map((z) => (
          <mesh castShadow receiveShadow key={`${x}:${z}`} position={[x, 0.205, z]}>
            <boxGeometry args={[0.038, 0.41, 0.038]} />
            <meshStandardMaterial color={METAL_DARK} roughness={0.5} metalness={0.7} />
          </mesh>
        )))}
      </animated.group>
    </group>
  );
}

function Lectern({ woodTexture }: { woodTexture: Texture }) {
  return (
    <group position={[0, 0, 0.08]}>
      {/* Base Plinth (bottom at y = 0.00) */}
      <RoundedBox castShadow receiveShadow args={[1.56, 0.06, 0.78]} radius={0.015} smoothness={2} position={[0, 0.03, 0]}>
        <meshStandardMaterial map={woodTexture} color="#8f6845" roughness={0.58} metalness={0.04} />
      </RoundedBox>

      {/* Main Wooden Body */}
      <RoundedBox castShadow receiveShadow args={[1.36, 1.06, 0.62]} radius={0.02} smoothness={2} position={[0, 0.59, 0]}>
        <meshStandardMaterial map={woodTexture} color="#9e744e" roughness={0.55} metalness={0.04} />
      </RoundedBox>

      {/* Front Decorative Recessed Panel */}
      <mesh castShadow receiveShadow position={[0, 0.60, -0.315]}>
        <boxGeometry args={[0.96, 0.74, 0.02]} />
        <meshStandardMaterial map={woodTexture} color="#7c5738" roughness={0.62} metalness={0.04} />
      </mesh>

      {/* Angled Wooden Reading Top */}
      <RoundedBox castShadow receiveShadow args={[1.64, 0.06, 0.82]} radius={0.02} smoothness={2} position={[0, 1.15, -0.02]} rotation={[0.14, 0, 0]}>
        <meshStandardMaterial map={woodTexture} color="#a97d55" roughness={0.52} metalness={0.05} />
      </RoundedBox>
    </group>
  );
}

function RecessedWindowsWall({ width, depth, floorCenter }: { width: number; depth: number; floorCenter: number }) {
  const wallX = -width / 2;
  const windowZPositions = [-2.8, 0.6, 4.0];
  const winWidth = 2.1;
  const winBottom = 1.25;
  const winTop = 3.85;
  const winHeight = winTop - winBottom;
  const wallStartZ = floorCenter - depth / 2;
  const wallEndZ = floorCenter + depth / 2;

  // Build solid wall pillars between the windows
  const segments: Array<{ zStart: number; zEnd: number }> = [];
  let cursor = wallStartZ;
  for (const wz of windowZPositions) {
    const wStart = wz - winWidth / 2;
    const wEnd = wz + winWidth / 2;
    if (wStart > cursor) segments.push({ zStart: cursor, zEnd: wStart });
    cursor = wEnd;
  }
  if (wallEndZ > cursor) segments.push({ zStart: cursor, zEnd: wallEndZ });

  return (
    <group position={[wallX, 0, 0]}>
      {/* Lower Wall Below Windows */}
      <mesh receiveShadow position={[0, winBottom / 2, floorCenter]}>
        <boxGeometry args={[0.20, winBottom, depth]} />
        <meshStandardMaterial color={WALL_COLOR} roughness={0.85} metalness={0.02} />
      </mesh>

      {/* Upper Wall Header Above Windows */}
      <mesh receiveShadow position={[0, winTop + (5.5 - winTop) / 2, floorCenter]}>
        <boxGeometry args={[0.20, 5.5 - winTop, depth]} />
        <meshStandardMaterial color={WALL_COLOR} roughness={0.85} metalness={0.02} />
      </mesh>

      {/* Wall Pillars Between Windows */}
      {segments.map((seg, i) => {
        const len = seg.zEnd - seg.zStart;
        const midZ = (seg.zStart + seg.zEnd) / 2;
        return (
          <mesh receiveShadow key={i} position={[0, winBottom + winHeight / 2, midZ]}>
            <boxGeometry args={[0.20, winHeight, len]} />
            <meshStandardMaterial color={WALL_COLOR} roughness={0.85} metalness={0.02} />
          </mesh>
        );
      })}

      {/* Recessed Window Frames, Glass & Daylight Backdrop */}
      {windowZPositions.map((wz) => (
        <group key={wz} position={[0, winBottom + winHeight / 2, wz]}>
          {/* Window Sill */}
          <mesh castShadow receiveShadow position={[0.04, -winHeight / 2 + 0.03, 0]}>
            <boxGeometry args={[0.28, 0.06, winWidth + 0.14]} />
            <meshStandardMaterial color={WINDOW_FRAME} roughness={0.6} metalness={0.04} />
          </mesh>
          {/* Top & Side Frame Trim */}
          <mesh position={[0, winHeight / 2 - 0.03, 0]}>
            <boxGeometry args={[0.22, 0.06, winWidth]} />
            <meshStandardMaterial color={WINDOW_FRAME} roughness={0.6} metalness={0.04} />
          </mesh>
          {[-winWidth / 2 + 0.03, winWidth / 2 - 0.03].map((mz) => (
            <mesh key={mz} position={[0, 0, mz]}>
              <boxGeometry args={[0.22, winHeight, 0.06]} />
              <meshStandardMaterial color={WINDOW_FRAME} roughness={0.6} metalness={0.04} />
            </mesh>
          ))}
          {/* Center Mullions */}
          <mesh position={[0, 0, 0]}>
            <boxGeometry args={[0.05, winHeight - 0.1, 0.04]} />
            <meshStandardMaterial color={WINDOW_FRAME} roughness={0.6} metalness={0.04} />
          </mesh>
          <mesh position={[0, 0.15, 0]}>
            <boxGeometry args={[0.05, 0.04, winWidth - 0.1]} />
            <meshStandardMaterial color={WINDOW_FRAME} roughness={0.6} metalness={0.04} />
          </mesh>
          {/* Glass Pane */}
          <mesh position={[-0.02, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
            <planeGeometry args={[winWidth - 0.1, winHeight - 0.1]} />
            <meshPhysicalMaterial
              color="#d8eeff"
              transparent
              opacity={0.28}
              roughness={0.08}
              metalness={0.05}
              reflectivity={0.6}
            />
          </mesh>
          {/* Soft Exterior Sky Glow */}
          <mesh position={[-0.14, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
            <planeGeometry args={[winWidth + 0.2, winHeight + 0.2]} />
            <meshStandardMaterial color="#e8f3ff" emissive="#dceeff" emissiveIntensity={0.65} />
          </mesh>
        </group>
      ))}

      {/* Baseboard along Left Wall */}
      <mesh receiveShadow position={[0.11, 0.07, floorCenter]}>
        <boxGeometry args={[0.04, 0.14, depth]} />
        <meshStandardMaterial color={BASEBOARD_COLOR} roughness={0.65} metalness={0.04} />
      </mesh>
    </group>
  );
}

function ClassroomShell({ width, depth, floorTexture, woodTexture }: {
  width: number;
  depth: number;
  floorTexture: Texture;
  woodTexture: Texture;
}) {
  const floorCenter = (depth - 12) / 2;

  return (
    <group>
      {/* Wooden Plank Floor (top surface at y = 0.00) */}
      <mesh receiveShadow position={[0, -0.04, floorCenter]}>
        <boxGeometry args={[width, 0.08, depth]} />
        <meshStandardMaterial map={floorTexture} roughness={0.68} metalness={0.03} />
      </mesh>

      {/* Back Wall + Baseboard */}
      <mesh receiveShadow position={[0, 2.75, -6.1]}>
        <boxGeometry args={[width, 5.5, 0.22]} />
        <meshStandardMaterial color={WALL_COLOR} roughness={0.85} metalness={0.02} />
      </mesh>
      <mesh receiveShadow position={[0, 0.07, -5.97]}>
        <boxGeometry args={[width, 0.14, 0.04]} />
        <meshStandardMaterial color={BASEBOARD_COLOR} roughness={0.65} metalness={0.04} />
      </mesh>

      {/* Right Wall + Baseboard */}
      <mesh receiveShadow position={[width / 2, 2.75, floorCenter]}>
        <boxGeometry args={[0.20, 5.5, depth]} />
        <meshStandardMaterial color={WALL_COLOR} roughness={0.85} metalness={0.02} />
      </mesh>
      <mesh receiveShadow position={[width / 2 - 0.11, 0.07, floorCenter]}>
        <boxGeometry args={[0.04, 0.14, depth]} />
        <meshStandardMaterial color={BASEBOARD_COLOR} roughness={0.65} metalness={0.04} />
      </mesh>

      {/* Left Wall with Recessed Daylight Windows */}
      <RecessedWindowsWall width={width} depth={depth} floorCenter={floorCenter} />

      {/* Classic Classroom Blackboard (Completely Blank Surface) */}
      <group position={[0, 2.85, -5.94]}>
        {/* Wooden Frame */}
        <RoundedBox castShadow receiveShadow args={[9.6, 3.1, 0.10]} radius={0.02} smoothness={2} position={[0, 0, 0]}>
          <meshStandardMaterial map={woodTexture} color={BLACKBOARD_FRAME} roughness={0.58} metalness={0.05} />
        </RoundedBox>
        {/* Blank Matte Green Slate Surface */}
        <mesh receiveShadow position={[0, 0, 0.045]}>
          <boxGeometry args={[9.18, 2.68, 0.03]} />
          <meshStandardMaterial color={BLACKBOARD_SURFACE} roughness={0.92} metalness={0.02} />
        </mesh>
        {/* Chalk Tray at Bottom */}
        <mesh castShadow receiveShadow position={[0, -1.56, 0.11]}>
          <boxGeometry args={[9.6, 0.07, 0.20]} />
          <meshStandardMaterial map={woodTexture} color={BLACKBOARD_FRAME} roughness={0.58} metalness={0.05} />
        </mesh>
        {/* Tiny Chalk Sticks & Felt Eraser on Tray */}
        <mesh castShadow position={[-1.4, -1.505, 0.12]} rotation={[0, 0.15, Math.PI / 2]}>
          <cylinderGeometry args={[0.014, 0.014, 0.11, 8]} />
          <meshStandardMaterial color="#f5f5f0" roughness={0.9} />
        </mesh>
        <mesh castShadow position={[-1.15, -1.505, 0.14]} rotation={[0, -0.2, Math.PI / 2]}>
          <cylinderGeometry args={[0.014, 0.014, 0.09, 8]} />
          <meshStandardMaterial color="#f5e396" roughness={0.9} />
        </mesh>
        <mesh castShadow position={[1.3, -1.495, 0.12]}>
          <boxGeometry args={[0.22, 0.05, 0.09]} />
          <meshStandardMaterial color="#3b3d42" roughness={0.85} />
        </mesh>
      </group>

      {/* Suspended Rectangular LED Ceiling Light Fixtures */}
      {[-width * 0.24, width * 0.24].flatMap((x) => [-2.2, 2.4].map((z) => (
        <group key={`${x}:${z}`} position={[x, 5.18, z]}>
          {/* Aluminum Housing */}
          <mesh castShadow>
            <boxGeometry args={[2.5, 0.07, 0.58]} />
            <meshStandardMaterial color="#d8dde4" roughness={0.4} metalness={0.5} />
          </mesh>
          {/* Emissive LED Diffuser Panel */}
          <mesh position={[0, -0.038, 0]}>
            <boxGeometry args={[2.36, 0.01, 0.46]} />
            <meshStandardMaterial color="#ffffff" emissive="#f5f9ff" emissiveIntensity={0.85} />
          </mesh>
          {/* Suspension Rods */}
          {[-0.95, 0.95].map((rx) => (
            <mesh key={rx} position={[rx, 0.18, 0]}>
              <cylinderGeometry args={[0.012, 0.012, 0.32, 8]} />
              <meshStandardMaterial color={METAL_DARK} roughness={0.4} metalness={0.7} />
            </mesh>
          ))}
        </group>
      )))}
    </group>
  );
}

export function CommandCenterScene({ group, members, coordinator, subAgents, colors, layout, width, depth, progressByBot, onFocusAgentChat }: {
  group: Group;
  members: Bot[];
  coordinator?: Bot;
  subAgents: Bot[];
  colors: ClassroomColors;
  layout: ClassroomLayout;
  width: number;
  depth: number;
  progressByBot: Map<string, BotProgress | null>;
  onFocusAgentChat?: (agentId: string, messageId?: string) => void;
}) {
  const activeMember = members.find((member) => isMemberActive(group, member));
  const working = Boolean(group.working || activeMember);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    invalidate();
  }, [invalidate, group.id, coordinator?.id, subAgents, working]);

  const woodTexture = useMemo(() => createWoodTexture("#c79a6b", "#8f6239", 1, 1), []);
  const floorTexture = useMemo(() => createFloorPlankTexture(Math.max(3, Math.round(width / 3.5)), Math.max(3, Math.round(depth / 3.5))), [width, depth]);

  return (
    <>
      <LightSetup colors={colors} width={width} depth={depth} />
      <ClassroomShell
        width={width}
        depth={depth}
        floorTexture={floorTexture}
        woodTexture={woodTexture}
      />
      {coordinator && (
        <group key={`${group.id}:${coordinator.id}`} position={[0, 0, -4.18]} rotation={[0, Math.PI, 0]}>
          <Lectern woodTexture={woodTexture} />
          <BotComponent
            member={coordinator}
            position={[0, 0, 0]}
            active={isMemberActive(group, coordinator)}
            role="coordinator"
            colors={colors}
            progress={progressByBot.get(coordinator.id) ?? null}
            onFocusAgentChat={onFocusAgentChat}
          />
        </group>
      )}
      {subAgents.map((member) => {
        const position = layout.positions.get(member.id)!;
        const active = isMemberActive(group, member);
        return (
          <group key={member.id} position={position}>
            <Desk active={active} woodTexture={woodTexture} />
            <BotComponent
              member={member}
              position={[0, 0, 0]}
              active={active}
              role="subagent"
              colors={colors}
              progress={progressByBot.get(member.id) ?? null}
              onFocusAgentChat={onFocusAgentChat}
            />
          </group>
        );
      })}
      <EffectComposer multisampling={0} enableNormalPass={false}>
        <Bloom luminanceThreshold={1.1} luminanceSmoothing={0.25} intensity={working ? 0.35 : 0.15} mipmapBlur />
      </EffectComposer>
    </>
  );
}
