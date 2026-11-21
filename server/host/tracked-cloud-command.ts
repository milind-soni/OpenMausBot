import type { CoordinatorHost, HandoffView } from "../coordinator.ts";
import type { BackgroundCommand } from "../runtime/types.ts";

type Target = { owner: string; teamComputerId: string | undefined };
type Deps = {
  target(node: HandoffView): Target | undefined;
  findBox(owner: string): Promise<string | undefined>;
  held(owner: string): boolean;
  status(command: BackgroundCommand, signal: AbortSignal): Promise<string | undefined>;
};

export function trackedCloudCommandHost(deps: Deps): Required<Pick<CoordinatorHost, "backgroundStatus" | "validateBackground">> {
  const targetFor = (node: HandoffView, command: BackgroundCommand) => {
    const target = deps.target(node);
    return target && target.teamComputerId === command.teamComputerId ? target : undefined;
  };
  return {
    validateBackground: (node, command) => targetFor(node, command) ? undefined : "This task no longer has access to the command's cloud computer",
    async backgroundStatus(node, command, signal) {
      const target = targetFor(node, command);
      if (!target || deps.held(target.owner)) return;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      const box = await deps.findBox(target.owner);
      bounded.throwIfAborted();
      if (box !== command.boxId || targetFor(node, command)?.owner !== target.owner || deps.held(target.owner)) return;
      return deps.status(command, bounded);
    },
  };
}
