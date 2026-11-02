import type { Socket } from "node:net";
export function openProxyTunnel(target: { hostname: string; port: string; address?: string; url?: string }, proxy: URL | null, timeout?: number): Promise<Socket>;
