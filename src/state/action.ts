// The Action union, extracted verbatim from the reducer: every dispatch
// the store can make, including the async-wrapper actions the reducer
// itself answers with an unchanged state.

import type { RuntimeEvent } from "../../shared/runtime-events";
import type { Routine, RoutineInput, RoutineRun } from "../../shared/routines";
import type { WebhookAttempt, WebhookIngressStatus, WebhookTrigger } from "../../shared/webhooks";
import type { BotRole } from "@/lib/bot-roles";
import type { BotUpdatePatch } from "./bot-patch-queue";
import type { OverlayKind } from "./overlays";
import type { AppState } from "./reducer";
import type { AppSettingsSection, Bot, BotAnnouncement, BotProject, BotSettingsSection, ConfigStatus, Group, InstanceInfo, Message, ModelSelection, ProjectUpdatePatch, TaskUpdatePatch } from "./model";

export type Action =
  | {
      type: "hydrate";
      bots: Bot[];
      groups: Group[];
      sections?: string[];
      computerControl: Record<string, { held: boolean; helpReason: string | null }>;
      botQueuedMessages?: AppState["pendingQueued"];
    }
  | { type: "botQueues"; queues: AppState["pendingQueued"] }
  | { type: "sections"; sections: string[] }
  | { type: "showRoutines"; section?: "schedule" | "logs"; view?: "calendar" | "list"; botId?: string; routineId?: string }
  | { type: "showTeamMap" }
  | { type: "showChat" }
  | { type: "routinesHydrated"; routines: Routine[]; runs: RoutineRun[] }
  | { type: "routinesLoadFailed" }
  | { type: "routinePatched"; routine: Routine }
  | { type: "routineDeleted"; routineId: string }
  | { type: "routineRunPatched"; run: RoutineRun }
  | { type: "webhooksHydrated"; webhooks: WebhookTrigger[]; attempts: WebhookAttempt[]; ingress: WebhookIngressStatus }
  | { type: "webhookPatched"; webhook: WebhookTrigger }
  | { type: "webhookAttempted"; attempt: WebhookAttempt }
  | { type: "webhookDeleted"; webhookId: string }
  | { type: "createRoutine"; input: RoutineInput }
  | { type: "updateRoutine"; routineId: string; patch: Partial<RoutineInput> }
  | { type: "deleteRoutine"; routineId: string }
  | { type: "runRoutine"; routineId: string; onStarted?: (run: RoutineRun) => void; onError?: (error: unknown) => void; onSettled?: () => void }
  | { type: "cancelRoutineRun"; runId: string }
  | { type: "markRoutineRunSeen"; runId: string }
  | { type: "groupPatched"; group: Partial<Group> & { id: string } }
  | { type: "groupDeleted"; groupId: string }
  | { type: "createGroup"; memberIds: string[]; name?: string; section?: string }
  | {
      type: "sendGroup";
      groupId: string;
      text: string;
      at: number;
      sendId?: string;
      replyToId?: string;
      threadId?: string;
      mode?: "chat" | "goal";
      onError?: () => void;
    }
  | {
      type: "patchGroup";
      groupId: string;
      patch: Partial<Pick<Group, "name" | "bulletin" | "memberIds" | "defaultResponder" | "pinnedMessageId" | "section" | "cwd">>;
    }
  | { type: "deleteGroup"; groupId: string }
  | { type: "newGroupTask"; groupId: string }
  | { type: "switchGroupTask"; groupId: string; threadId: string }
  | { type: "renameGroupTask"; groupId: string; threadId: string; title: string }
  | { type: "deleteGroupTask"; groupId: string; threadId: string }
  | { type: "interruptGroup"; groupId: string; threadId?: string; onError?: () => void }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "select"; id: string }
  | {
      type: "send";
      botId: string;
      text: string;
      at: number;
      sendId?: string;
      replyToId?: string;
      threadId?: string;
      onError?: () => void;
    }
  | { type: "pendingQueued"; threadId: string; queueId: string; text: string; reason?: "capacity" }
  | { type: "consumePendingQueued"; threadId: string; queueId: string }
  | { type: "cancelQueued"; botId: string; queueId: string; threadId?: string }
  | { type: "steerQueued"; botId: string; queueId: string; threadId?: string; onError?: () => void; onSettled?: () => void }
  | { type: "cancelGroupQueued"; groupId: string; threadId: string; queueId: string }
  | { type: "steerGroupQueued"; groupId: string; queueId: string; threadId?: string; onError?: () => void; onSettled?: () => void }
  | { type: "editMessage"; botId: string; messageId: string; text: string; threadId?: string }
  | { type: "switchBranch"; botId: string; messageId: string; threadId?: string }
  | { type: "threadActive"; threadId: string; activeLeafId: string }
  // `threadId` is the thread the card was shown in; `groupId` when the card
  // is in a room: the message lives on the room's list, and the answer goes
  // to the room's thread
  | { type: "answerCard"; botId: string; messageId: string; answer: string; threadId?: string; groupId?: string }
  | { type: "dismissCard"; botId: string; messageId: string; threadId?: string; groupId?: string }
  // permission cards answer by THREAD, so a request raised inside a room
  // can be answered the same way as one in a 1:1 chat
  | {
      type: "decideRequest";
      threadId: string;
      requestId: string;
      behavior: "allow" | "deny" | "answer";
      message?: string;
      /** Exact proposal hash displayed by a current learned-skill client. */
      reviewedSha256?: string;
      /** remember this exact grant (the server's allowKey) for the bot */
      alwaysAllow?: { botId: string; key: string };
      /** "Always allow this session": the provider keeps the allow */
      always?: boolean;
      /** Local UI recovery hook for voice flows. Never sent to the server. */
      onError?: (message: string) => void;
    }
  | { type: "newTask"; botId: string; projectId?: string }
  | { type: "switchTask"; botId: string; threadId: string }
  | { type: "taskSwitched"; bot: Bot }
  | { type: "renameTask"; botId: string; threadId: string; title: string }
  | { type: "deleteTask"; botId: string; threadId: string }
  | { type: "newBot"; role?: BotRole; onCreated?: () => void; onError?: (message: string) => void }
  | { type: "botCreationPending"; on: boolean }
  | { type: "updateTask"; botId: string; threadId: string; patch: TaskUpdatePatch }
  | { type: "createProject"; botId: string; name: string; emoji?: string | null; onCreated?: (project: BotProject) => void; onError?: (message: string) => void }
  | { type: "updateProject"; botId: string; projectId: string; patch: ProjectUpdatePatch; onSaved?: () => void; onError?: (message: string) => void }
  | { type: "deleteProject"; botId: string; projectId: string; onDeleted?: () => void; onError?: (message: string) => void }
  | { type: "reorderProjects"; botId: string; projectIds: string[]; onSaved?: () => void; onError?: (message: string) => void }
  | { type: "botAdded"; bot: Bot }
  | { type: "deleteBot"; botId: string }
  | { type: "botDeletionPending"; botId: string; on: boolean }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: BotAnnouncement }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "optimisticMessageRemoved"; threadId: string; sendId: string }
  | { type: "screenFrame"; botId: string; threadId?: string; png: string; mime: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "computerControl"; botId: string; held: boolean; helpReason: string | null }
  | { type: "modelVariantRuntime"; event: RuntimeEvent }
  | { type: "setModel"; botId: string; selection: ModelSelection; threadId?: string; updateBotDefault?: boolean; resetApprovalToAsk?: boolean }
  | { type: "interrupt"; botId: string; threadId?: string; onError?: () => void }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "notice"; notice: AppState["notice"] }
  | { type: "revealThread"; threadId: string }
  | { type: "openOverlay"; kind: "settings"; open?: boolean; section?: BotSettingsSection; botId?: string }
  | { type: "openOverlay"; kind: "appSettings"; open?: boolean; section?: AppSettingsSection }
  | { type: "openOverlay"; kind: "plugins"; open?: boolean; section?: "apps" | "mcp" }
  | { type: "openOverlay"; kind: Exclude<OverlayKind, "settings" | "appSettings" | "plugins">; open?: boolean }
  | { type: "closeOverlay"; kind: OverlayKind }
  | { type: "closeAllOverlays" }
  | { type: "focusMessage"; threadId: string; messageId: string }
  | { type: "focusMessageConsumed"; nonce: number }
  | {
      type: "updateBot";
      botId: string;
      patch: BotUpdatePatch;
    };

