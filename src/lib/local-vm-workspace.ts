import { z } from "zod";
import type { JsonValue } from "../../shared/json";
import { t } from "./i18n";

export interface LocalVmWorkspaceBot {
  id: string;
  computer?: "cloud" | "vm" | "local" | "browser" | "off";
  hidden?: boolean;
}

export type LocalVmWorkspaceSlots = [string | null, string | null];

export interface LocalVmWorkspaceStatus {
  mode: "shared" | "per-bot" | "pool" | "unknown";
  maxInstances: number;
  container: "running" | "stopped" | "missing" | "unknown";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
}

export interface LocalVmWorkspaceControlSnapshot {
  held: boolean;
  helpReason: string | null;
  help?: import("../../shared/wire").ComputerHelpRef | null;
  owned?: boolean;
  acquired?: boolean;
  released?: boolean;
}

export interface LocalVmWorkspaceControlPort {
  take(botId: string): Promise<LocalVmWorkspaceControlSnapshot>;
  release(botId: string): Promise<LocalVmWorkspaceControlSnapshot>;
  setInteractive(contextId: string | null): Promise<boolean>;
}

export interface NativeViewRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface NativeViewOverlayCandidate {
  rect: NativeViewRect;
  explicit: boolean;
  visible: boolean;
  zIndex: number | null;
}

/** Native views paint above renderer content, so hide them only under a visible overlay. */
export function nativeViewOverlayIntersects(
  hostRects: readonly NativeViewRect[],
  candidates: readonly NativeViewOverlayCandidate[],
): boolean {
  const intersects = (left: NativeViewRect, right: NativeViewRect) =>
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top;
  return candidates.some(
    (candidate) =>
      candidate.visible &&
      candidate.rect.width > 0 &&
      candidate.rect.height > 0 &&
      (candidate.explicit || (candidate.zIndex !== null && candidate.zIndex >= 10)) &&
      hostRects.some((host) => intersects(candidate.rect, host)),
  );
}

export type LocalVmWorkspaceControlResult =
  | { status: "controlled"; botId: string; snapshot: LocalVmWorkspaceControlSnapshot }
  | { status: "held-elsewhere"; botId: string; snapshot: LocalVmWorkspaceControlSnapshot };

export async function switchLocalVmWorkspaceControl(
  port: LocalVmWorkspaceControlPort,
  currentBotId: string | null,
  nextBotId: string,
  nextContextId: string,
): Promise<LocalVmWorkspaceControlResult> {
  if (currentBotId && currentBotId !== nextBotId) {
    await port.setInteractive(null);
    await port.release(currentBotId);
  }

  // Atomic on the server: a read followed by a take cannot prove ownership.
  const taken = await port.take(nextBotId);
  if (!taken.held) throw new Error(t("vm.workspace.holdNotAcquired"));
  if (taken.owned !== true) {
    return { status: "held-elsewhere", botId: nextBotId, snapshot: taken };
  }
  try {
    await port.setInteractive(nextContextId);
  } catch (error) {
    // Fail-closed: the native manager removes a view it cannot demote.
    await port.setInteractive(null).catch(() => {});
    await port.release(nextBotId).catch(() => {});
    throw error;
  }
  return { status: "controlled", botId: nextBotId, snapshot: taken };
}

export async function releaseLocalVmWorkspaceControl(
  port: LocalVmWorkspaceControlPort,
  currentBotId: string | null,
) {
  if (!currentBotId) return null;
  await port.setInteractive(null).catch(() => {});
  return port.release(currentBotId);
}

export function eligibleLocalVmBotIds(bots: readonly LocalVmWorkspaceBot[]): string[] {
  return bots
    .filter((bot) => bot.computer === "vm" && bot.hidden !== true)
    .map((bot) => bot.id);
}

export function initialLocalVmWorkspaceSlots(
  bots: readonly LocalVmWorkspaceBot[],
  primaryBotId: string,
): LocalVmWorkspaceSlots {
  const eligible = eligibleLocalVmBotIds(bots);
  const primary = eligible.includes(primaryBotId) ? primaryBotId : (eligible[0] ?? null);
  return [primary, eligible.find((id) => id !== primary) ?? null];
}

export function selectLocalVmWorkspaceSlot(
  slots: LocalVmWorkspaceSlots,
  index: 0 | 1,
  botId: string | null,
): LocalVmWorkspaceSlots {
  const next: LocalVmWorkspaceSlots = [...slots];
  const otherIndex = index === 0 ? 1 : 0;
  if (botId && next[otherIndex] === botId) next[otherIndex] = next[index];
  next[index] = botId;
  return next;
}

export function reconcileLocalVmWorkspaceSlots(
  slots: LocalVmWorkspaceSlots,
  bots: readonly LocalVmWorkspaceBot[],
): LocalVmWorkspaceSlots {
  const eligible = eligibleLocalVmBotIds(bots);
  const available = new Set(eligible);
  const next: LocalVmWorkspaceSlots = [null, null];
  for (const index of [0, 1] as const) {
    const id = slots[index];
    if (id && available.delete(id)) next[index] = id;
  }
  for (const index of [0, 1] as const) {
    if (next[index]) continue;
    const replacement = [...available][0];
    if (!replacement) continue;
    next[index] = replacement;
    available.delete(replacement);
  }
  return next;
}

const localVmStatusPayloadSchema = z.object({
  mode: z.enum(["shared", "per-bot", "pool"]).optional(),
  max_instances: z.number().int().positive().optional(),
  container: z.enum(["running", "stopped", "missing"]).optional(),
  network: z.enum(["loopback", "unsafe", "unknown"]).optional(),
  security: z.enum(["hardened", "unsafe", "unknown"]).optional(),
  persistence: z.enum(["durable", "unsafe", "unknown"]).optional(),
  desktopReady: z.boolean().optional(),
  ready: z.boolean().optional(),
  viewer_url: z.string().min(1).optional(),
});

function parseLocalVmStatusPayload(raw: JsonValue) {
  const parsed = localVmStatusPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** UI-safe facts only: the response's secret-bearing viewer_url and diagnostics never reach React state. */
export function sanitizeLocalVmWorkspaceStatus(raw: JsonValue): LocalVmWorkspaceStatus {
  const value = parseLocalVmStatusPayload(raw);
  const mode = value?.mode ?? "unknown";
  const container = value?.container ?? "unknown";
  const network = value?.network ?? "unknown";
  const security = value?.security ?? "unknown";
  const persistence = value?.persistence ?? "unknown";
  const maxInstances = value?.max_instances ?? 0;
  const desktopReady = value?.desktopReady === true;
  const ready = Boolean(
    value?.ready === true &&
      container === "running" &&
      network === "loopback" &&
      security === "hardened" &&
      persistence === "durable" &&
      desktopReady,
  );
  return { mode, maxInstances, container, network, security, persistence, desktopReady, ready };
}

/** Only for the immediate main-process handoff: never in component state, logs, errors, analytics or state events. */
export function readyLocalVmViewerUrl(raw: JsonValue): string | null {
  const value = parseLocalVmStatusPayload(raw);
  if (!value || !sanitizeLocalVmWorkspaceStatus(raw).ready) return null;
  return value.viewer_url ?? null;
}
