// Named phase functions for the direct-turn engine (server/start-turn.ts).
// Each phase is a verbatim extraction of one region of the old startTurn
// body: it receives exactly the turn locals and dep handles it reads and
// returns exactly what the next phase consumes. The orchestrator in
// start-turn.ts owns the sequence; control flow that spans regions (the
// try/catch around dispatch, the final pre-dispatch gates) stays there.
//
// This module holds the local type aliases those phase modules share.
import type { ProviderInstance } from "../../contracts.ts";
import type { Store } from "../../store.ts";
import type { StartTurnDeps } from "../../start-turn.ts";

export type Deps = StartTurnDeps;
export type Task = NonNullable<ReturnType<Store["taskByThread"]>>;
export type SendTurnInput = Parameters<ProviderInstance["adapter"]["sendTurn"]>[0];
export type TurnIntegrations = NonNullable<SendTurnInput["integrations"]>;
export type CaptureFn = () => Promise<{ png: string; format: string }>;
export type ComputerKind = "box" | "vps" | "vm" | "local" | null;
