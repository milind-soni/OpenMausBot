/** An exact command in one engine instance and working directory. */
export interface CommandAllowlistCandidate {
  command: string;
  cwd: string;
  providerInstanceId: string;
}

export interface CommandAllowlistRule extends CommandAllowlistCandidate {
  id: string;
}

export type CommandAllowRule = CommandAllowlistRule;

export interface CommandAllowlistResponse {
  rules: CommandAllowlistRule[];
  context: { providerInstanceId: string; cwd: string | null };
  supported: boolean;
}
