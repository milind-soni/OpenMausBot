export type TailscaleState = "ready" | "signed-out" | "not-running" | "needs-approval";
export interface TailscaleStatusJson {
  state: TailscaleState;
  name: string | null;
  addresses: string[];
  https: boolean;
}

export declare const bareAddress: (address: string | undefined | null) => string;
export declare function inTailscaleRange(address: string | undefined | null): boolean;
export declare function isTailnetName(host: string | undefined | null): boolean;
export declare const isTailnetHost: (host: string | undefined | null) => boolean;
export declare function tailnetInterfaceAddresses(interfaces: NodeJS.Dict<Array<{ address: string }>>): string[];
export declare const onTailnet: (interfaces: NodeJS.Dict<Array<{ address: string }>>) => boolean;
export declare function readTailscaleStatusJson(stdout: string): TailscaleStatusJson | null;
export declare function tailnetOrigin(name: string, port: number, https?: boolean): string;
export declare function tailnetHosts(input: { name: string | null; addresses?: string[]; port: number }): Set<string>;
