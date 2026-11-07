export const MCP_JOBS_MOVED: string;
export function commandFingerprint(server: { command: string; args: string[]; env: Record<string, string> }): string;
export function ownEnvironmentIds(dataDirs: ReadonlyArray<string | null | undefined>): string[];
export function ownPorts(options?: { serverPorts?: number[]; dirs?: string[]; readFile?: (file: string, encoding: "utf8") => Promise<string> }): Promise<number[]>;
export function inheritedEnvironment(env?: NodeJS.ProcessEnv): Record<string, string>;
export function windowsLaunch(command: string, args: string[], env: Record<string, string | undefined>, exists?: (file: string) => boolean): { file: string; args: string[]; verbatim: boolean } | null;
export function killTree(child: { pid?: number; kill(signal?: NodeJS.Signals): unknown }, options?: { platform?: string; spawn?: (file: string, args: string[], options: object) => { on(event: "error", listener: () => void): unknown } }): void;
