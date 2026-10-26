// What the ACP driver keeps for each thread: its session on an agent process (alone or shared with other threads'
// sessions) and the turn running in it.
import type { RequestOutcome, SendTurnInput } from "../../contracts.ts";
import type { spawnCli } from "../../procs.ts";
import type { AcpConfig } from "./core.ts";
import type { AcpHost, AcpLink } from "./host.ts";

export type AcpAskFinish = (
  behavior: string,
  source?: "user" | "timeout" | "system",
  message?: string,
  always?: boolean,
) => RequestOutcome;

export interface AcpTurn {
  turnId: string;
  turn: SendTurnInput;
  turnConfig: AcpConfig;
  controlsHost: boolean;
  state: {
    settled: boolean; promptSent: boolean; text: string; textMessageId: string | null; producedItem: boolean; startupActivity: boolean; stopped: boolean;
    usagePeak: number | null;
    usageLast: number | null;
    usageCompacted: boolean;
    /** Stop went unanswered: only the cancel timeout settles the turn, once its session is closed or its process gone. */
    cancelling: boolean;
  };
  acknowledge: () => void;
  asks: Map<string, AcpAskFinish>;
  /** Tool calls started and not yet finished: a tool such as `sleep` sends nothing while it runs. */
  runningTools: Set<string>;
  unkeyedToolIds: string[];
  endedToolIds: Set<string>;
  interruptTimer: ReturnType<typeof setTimeout> | null;
  stopQuietWatch: (() => void) | null;
  flushAssistantText: () => void;
  receiveModelVariants: (result: any) => void;
}

export interface AcpSession {
  child: ReturnType<typeof spawnCli>;
  host: AcpHost;
  acp: AcpLink;
  launch: { command: string; args?: string[] };
  env: Record<string, string | undefined>;
  cwd: string;
  contractKey: string;
  /** mcpServers the native session was built with. They ride session/new and session/load, not argv,
   *  and bearer tokens rotate every turn, so a change re-establishes the session on the same child. */
  sessionKey: string | null;
  sessionId: string | null;
  sessionConfigResult: any;
  initResult: any;
  authenticated: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  /** Set when a shared process's session closes through `session/close`: true once the agent confirms it. */
  closeConfirmed?: Promise<boolean>;
  dead: boolean;
  readonly stderr: string;
  current: AcpTurn | null;
  fallbackNotice?: string;
  launchModel?: string;
}
