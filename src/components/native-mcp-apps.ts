import type { ComponentType } from "react";

import { FAMULOR_MCP_URL, famulorServerName, isFamulorServer } from "@/lib/famulor-integration";
import { WHOP_MCP_URL, isWhopServer, whopServerName } from "@/lib/whop-integration";
import type { LocaleKey } from "@/locales";

import { FamulorIcon } from "./FamulorIcon";
import { WhopIcon } from "./WhopIcon";

export type NativeMcpAppId = "whop" | "famulor";

export interface NativeMcpCopy {
  description: LocaleKey;
  connect: LocaleKey;
  disconnect: LocaleKey;
  notice: LocaleKey;
  connected: LocaleKey;
  access: LocaleKey;
  accessHint: LocaleKey;
  botSettings: LocaleKey;
  setupFailed: LocaleKey;
  testFailed: LocaleKey;
  loadingTools: LocaleKey;
}

export interface NativeMcpApp {
  id: NativeMcpAppId;
  label: string;
  url: string;
  match: (server: { url?: string; type?: string }) => boolean;
  nameFor: (servers: Array<{ name: string }>) => string;
  Icon: ComponentType;
  text: NativeMcpCopy;
}

const NATIVE_MCP_APPS = {
  whop: {
    id: "whop",
    label: "Whop",
    url: WHOP_MCP_URL,
    match: isWhopServer,
    nameFor: whopServerName,
    Icon: WhopIcon,
    text: {
      description: "whop.description",
      connect: "whop.connect",
      disconnect: "whop.disconnect",
      notice: "whop.notice",
      connected: "whop.connected",
      access: "whop.access",
      accessHint: "whop.accessHint",
      botSettings: "whop.botSettings",
      setupFailed: "whop.setupFailed",
      testFailed: "whop.testFailed",
      loadingTools: "whop.loadingTools",
    },
  },
  famulor: {
    id: "famulor",
    label: "Famulor",
    url: FAMULOR_MCP_URL,
    match: isFamulorServer,
    nameFor: famulorServerName,
    Icon: FamulorIcon,
    text: {
      description: "famulor.description",
      connect: "famulor.connect",
      disconnect: "famulor.disconnect",
      notice: "famulor.notice",
      connected: "famulor.connected",
      access: "famulor.access",
      accessHint: "famulor.accessHint",
      botSettings: "famulor.botSettings",
      setupFailed: "famulor.setupFailed",
      testFailed: "famulor.testFailed",
      loadingTools: "famulor.loadingTools",
    },
  },
} as const satisfies Record<NativeMcpAppId, NativeMcpApp>;

export function nativeMcpApp(id: NativeMcpAppId): NativeMcpApp {
  switch (id) {
    case "whop":
    case "famulor":
      return NATIVE_MCP_APPS[id];
    default: {
      const unknown: never = id;
      return unknown;
    }
  }
}

export function nativeMcpAppFor(server: { url?: string; type?: string }): NativeMcpApp | undefined {
  return (Object.values(NATIVE_MCP_APPS) as NativeMcpApp[]).find((app) => app.match(server));
}
