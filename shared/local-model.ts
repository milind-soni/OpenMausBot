/** A model a server on this machine or network holds, as that server describes it: bytes on disk, parameter count
 * and quantization in its own words, and whether it can call tools or see images when it says. */
export interface LocalModelFacts {
  bytes?: number;
  parameters?: string;
  quantization?: string;
  tools?: boolean;
  vision?: boolean;
}

/** A model's thinking controls: `described` when its server listed them, not only that the model thinks. */
export interface LocalModelThinking {
  choices: string[];
  described: boolean;
}

export interface LocalModel extends LocalModelFacts {
  name: string;
  thinking?: LocalModelThinking;
}

/** `ready`: running with models. `no-models`: running, nothing pulled. `not-running`: nothing listens there.
 * `unreachable`: no answer in time, the host or network is unknown, or something else answers there. */
export type OllamaState = "ready" | "no-models" | "not-running" | "unreachable";

/** What looking for Ollama at one address found (GET /api/instances/ollama). */
export interface OllamaStatus {
  state: OllamaState;
  /** The server's own address, without /v1. */
  url: string;
  version?: string;
  models: LocalModel[];
  /** Why an `unreachable` server could not be used. */
  problem?: "timeout" | "network" | "not-ollama";
}

/** Why an Ollama cannot answer now, for the engine list to say in the reader's language. */
export type OllamaProblem = Pick<OllamaStatus, "state" | "url" | "problem">;
