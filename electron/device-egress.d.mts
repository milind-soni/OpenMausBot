import type { BlockList, Socket } from "node:net";
import type { networkInterfaces } from "node:os";

export type DeviceRefusal = "port" | "home-network" | "metadata" | "link-local" | "reserved";
export type DeviceOpened = { socket: Socket } | { refused: DeviceRefusal } | { failed: "unreachable" | "refused" | "timeout" };
export interface DeviceEgress { open(target: { host: string; port: number }): Promise<DeviceOpened> }
export declare const DEVICE_PORTS: readonly number[];
export declare function homeAddresses(interfaces: ReturnType<typeof networkInterfaces>, seenAs: string | null | undefined): BlockList;
export declare function deviceRefusal(port: number, addresses: readonly string[], lists?: { own?: BlockList; home?: BlockList }): DeviceRefusal | null;
export declare function createDeviceEgress(options?: {
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  connect?: (options: { host: string; port: number; autoSelectFamily: boolean; lookup: (...args: any[]) => void }) => Socket;
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  seenAs?: () => string | null;
  connectMs?: number;
}): DeviceEgress;
