import type { BlockList } from "node:net";
import type { networkInterfaces } from "node:os";

export type AddressClass = "public" | "loopback" | "this-machine" | "private" | "link-local" | "metadata" | "reserved";
export declare function ownAddresses(interfaces?: ReturnType<typeof networkInterfaces>): BlockList;
export declare function ownSubnets(interfaces?: ReturnType<typeof networkInterfaces>): BlockList;
export declare function addressClass(raw: string, own?: BlockList): AddressClass;
export declare function listed(list: BlockList, raw: string): boolean;
