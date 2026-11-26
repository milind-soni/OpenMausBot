import { AppOperationError } from "./errors.ts";

/** What an operation's ctx.connectors.call reaches: `declaration` is the app's own `connectors` from app.json. */
export interface ConnectorGate {
  call(declaration: Readonly<Record<string, readonly string[]>>, connector: string, tool: string, args: unknown): Promise<unknown>;
}

export const NO_CONNECTORS: ConnectorGate = {
  async call() {
    throw new AppOperationError("connectors_unavailable", "Connector tools are not available to app operations yet.");
  },
};
